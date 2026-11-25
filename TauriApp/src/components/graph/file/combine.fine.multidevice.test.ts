// Phase 4 multi-device scenarios (phase4-contract.md §8 D1–D7): two or three computers edit INSIDE one
// section (different cells; different rows added; a column deleted on one and cells elsewhere on the
// others; a graph title and a Y range; different scratchpad cells), save, and the world settles (Combine
// pressed where a banner offers it, one choice where the same place was changed). Also: forced double
// writes, a computer still on the older app (section-level rules, no combine_v), three phase 4 computers.
import { describe, expect, it } from "vitest";
import { openContent, type DocContent } from "../../../store/graphStore";
import { ensureRows } from "../graphModel";
import { COMBINE_V, type RevisionP4 } from "./contract";
import { buildNextFile, fileAt, openFile, partsOf, revisionOf, sectionsOf, type Author } from "./docCodec";
import type { ConflictMode, MemoryWorld } from "./memoryBackend";
import {
  DBX, PFILE as P, activeTab, combineState, computer, duplicateAutoCombines, duplicateCombines, flush, headRev, lostVersions, makeWorld,
  scratchAt, seedFile, start, tick, type Computer, type TestDeps,
} from "./testkit";
import { parseScratch } from "../scratchpad/scratchModel";

type Kind = "cells" | "rows" | "colCell" | "titleY" | "scratch";

interface Scenario {
  name: string;
  mode?: ConflictMode;
  delay?: number;
  three?: boolean;
  sameId?: boolean;
  skewB?: number;
  offline?: boolean;
  notes?: boolean;
}

const MATRIX: Scenario[] = [
  ...(["dropbox", "onedrive", "lww"] as const).flatMap((mode) => [0, 5000, 60_000].map((delay) => ({ name: `${mode}, sync delay ${delay / 1000} s`, mode, delay }))),
  { name: "one computer offline, then back", offline: true, delay: 1000 },
  { name: "duplicate device id", sameId: true, delay: 1000 },
  { name: "clock skew +2 h", skewB: 2 * 3600_000, delay: 1000 },
  { name: "clock skew −2 h", skewB: -2 * 3600_000, delay: 1000 },
  { name: "three computers", three: true, delay: 2000 },
  { name: "three computers, last writer wins", three: true, mode: "lww", delay: 2000 },
];
/** Every kind runs on a smaller set; "cells" on the whole matrix. */
const SHORT: Scenario[] = [
  { name: "dropbox, 5 s", mode: "dropbox", delay: 5000 },
  { name: "lww, 5 s", mode: "lww", delay: 5000 },
  { name: "onedrive, 0 s", mode: "onedrive", delay: 0 },
  { name: "one computer offline, then back", offline: true, delay: 1000 },
  { name: "three computers", three: true, delay: 2000 },
];

async function world(sc: Scenario, deps: TestDeps[] = []) {
  const w = makeWorld(sc.mode ?? "dropbox", undefined, { notes: sc.notes });
  const d = sc.delay ?? 1000;
  const a = await start(await computer(w, { device_id: "d-a", device_name: "Mac mini", uploadDelayMs: d, downloadDelayMs: d }, deps[0] ?? {}));
  const b = await start(await computer(w, {
    device_id: sc.sameId ? "d-a" : "d-b", device_name: "MacBook", user_name: "Alice", uploadDelayMs: d, downloadDelayMs: d,
  }, { skewMs: sc.skewB, ...(deps[1] ?? {}) }));
  const cs = [a, b];
  if (sc.three) cs.push(await start(await computer(w, { device_id: "d-c", device_name: "Lab PC", user_name: "Carol", uploadDelayMs: d, downloadDelayMs: d }, deps[2] ?? {})));
  await seedFile(w, a.dev, P);
  await tick(w, 2 * d + 1000);
  for (const c of cs) expect((await c.ses.getState().open(P)).ok).toBe(true);
  return { w, cs, d };
}

const label = (c: Computer) => `${c.dev.name} edit`;

/** Computer k's edit inside one section. */
function edit(c: Computer, kind: Kind, k: number) {
  const g = c.graph.getState();
  switch (kind) {
    case "cells": g.setCell(k * 2, 0, 0, label(c)); return;
    case "rows": g.insertRow(k * 3 + 1); g.setCell(k * 3 + 1, 0, 0, label(c)); return;
    case "colCell":
      if (k === 0) g.deleteCol(g.doc!.col_titles.length - 1);
      else g.setCell(4 + k, k - 1, 0, label(c));
      return;
    case "titleY":
      if (k === 0) g.setFigure({ title: label(c) });
      else if (k === 1) g.setFigure({ y_min: 0, y_max: 77 } as never);
      else g.setFigure({ x_label: label(c) } as never);
      return;
    case "scratch": {
      const doc = parseScratch(g.scratch ?? "");
      g.setScratch(JSON.stringify({ v: 1, cells: [...doc.cells, [k + 1, k + 1, label(c)]] }));
      return;
    }
  }
}

/** D1: every computer's edit is in the final content. */
function expectAllEdits(content: DocContent, cs: Computer[], kind: Kind) {
  const all = content.doc.cells.flatMap((row) => row.flatMap((reps) => reps));
  cs.forEach((c, k) => {
    switch (kind) {
      case "cells": expect(content.doc.cells[k * 2][0][0]).toBe(label(c)); return;
      case "rows": expect(all).toContain(label(c)); return;
      case "colCell":
        if (k === 0) expect(content.doc.col_titles).toHaveLength(2);
        else expect(all).toContain(label(c));
        return;
      case "titleY":
        if (k === 0) expect(content.figure.title).toBe(label(c));
        else if (k === 1) expect([content.figure.y_min, content.figure.y_max]).toEqual([0, 77]);
        else expect((content.figure as unknown as { x_label: string }).x_label).toBe(label(c));
        return;
      case "scratch": expect(scratchAt(content, k + 1, k + 1)).toBe(label(c)); return;
    }
  });
}

/** One person's turn: the first computer with something to do does it. */
async function oneTurn(cs: Computer[], pick: "mine" | "theirs"): Promise<boolean> {
  for (const c of cs) {
    const s = c.ses.getState();
    const d = combineState(c);
    if (d) {
      for (const sec of d.sections) {
        if (sec.left > 0) {
          if (sec.conflicts.length) await s.setAllInSection(sec.key, pick);
          else await s.setSectionChoice(sec.key, pick);
        }
      }
      await s.applyCombine();
      await flush();
      return true;
    }
    const t = activeTab(c);
    if (!t || t.combining) continue;
    const b = t.banners.find((x) => x.actions.includes("combine") && (x.kind !== "extraCopy" || x.relation === "diverged"));
    if (b) { await s.bannerAction(t.key, b.id, "combine"); await flush(); return true; }
  }
  return false;
}

async function settle(w: MemoryWorld, cs: Computer[], d: number, pick: "mine" | "theirs" = "mine") {
  for (let round = 0; round < 40; round++) {
    await tick(w, Math.max(12_000, 2 * d + 11_000));
    const acted = await oneTurn(cs, pick);
    if (!acted && cs.every((c) => !activeTab(c)?.combining && c.ses.getState().dialog === null)) {
      const heads = new Set(cs.map((c) => c.dev.localHead(activeTab(c).path!)));
      if (heads.size === 1 && cs.every((c) => !c.ses.getState().tabs.some((t) => t.saving))) {
        await tick(w, 2 * d + 2000);
        if (new Set(cs.map((c) => c.dev.localHead(activeTab(c).path!))).size === 1) return;
      }
    }
  }
}

async function contentHashOf(c: Computer): Promise<string> {
  const g = c.graph.getState();
  return (await partsOf(sectionsOf({ doc: g.doc!, analysis: g.analysis, figure: g.figure, scratch: g.scratch }))).contentHash;
}

/** D2 one head and one content; D3 at most one combined version per pair. */
async function expectConverged(w: MemoryWorld, cs: Computer[]) {
  const heads = cs.map((c) => c.dev.localHead(activeTab(c).path!));
  expect(new Set(heads).size).toBe(1);
  for (const c of cs) expect(activeTab(c)).toMatchObject({ dirty: false, notSaved: false, baseRevision: heads[0] });
  expect(new Set(await Promise.all(cs.map(contentHashOf))).size).toBe(1);
  expect(duplicateAutoCombines(w)).toEqual([]);
  expect(lostVersions(w)).toEqual([]);
}

async function run(sc: Scenario, kind: Kind) {
  const { w, cs, d } = await world(sc);
  const [a, b] = cs;
  if (sc.offline) b.dev.setOnline(false);
  cs.forEach((c, k) => edit(c, kind, k));
  await flush();
  await a.ses.getState().save();
  for (const c of cs.slice(1)) await c.ses.getState().save();
  if (sc.offline) { await tick(w, 2 * d + 1000); b.dev.setOnline(true); }
  await settle(w, cs, d);
  await expectConverged(w, cs);
  expect(duplicateCombines(w)).toEqual([]);
  // D1
  const g = a.graph.getState();
  expectAllEdits({ doc: g.doc!, analysis: g.analysis, figure: g.figure, scratch: g.scratch }, cs, kind);
  // Nothing is left to press anywhere.
  for (const c of cs) expect(activeTab(c).banners.filter((x) => x.kind === "savedOver" && x.state)).toEqual([]);
}

describe("D1–D3 different cells of one table, the whole matrix", () => {
  it.each(MATRIX)("$name", { timeout: 180_000 }, async (sc) => { await run(sc, "cells"); });
});

for (const kind of ["rows", "colCell", "titleY", "scratch"] as const) {
  describe(`D1–D3 inside one section: ${kind}`, () => {
    it.each(SHORT)("$name", { timeout: 180_000 }, async (sc) => { await run(sc, kind); });
  });
}

// ── helpers for the hand-made multi-device cases ─────────────────────────────

const carl: Author = { user_name: "Carl", device_id: "d-carl", device_name: "Lab PC", session_id: "s-carl", app_version: "t", platform: "macos" };
const stored = (c: DocContent): DocContent => openContent({ doc: ensureRows(c.doc), analysis: c.analysis, figure: c.figure, scratch: c.scratch });
const withCell = (r: number, col: number, v: string) => (c: DocContent): DocContent => {
  const cells = c.doc.cells.map((row) => row.map((reps) => [...reps]));
  cells[r][col][0] = v;
  return { ...c, doc: { ...c.doc, cells } };
};
/** Carl, working from the version before the head, saves over it (combine_v when `v`). */
async function carlSavesOver(w: MemoryWorld, c: Computer, fn: (x: DocContent) => DocContent, v = true): Promise<string> {
  const f = c.dev.localFile(P)!;
  const base = fileAt(f, revisionOf(f.manifest, f.manifest.head)!.parents[0])!;
  const next = await buildNextFile(base, stored(fn(openFile(base)!)), { time: w.clock.now(), author: carl });
  const m = v ? { ...next.manifest, revisions: next.manifest.revisions.map((r) => (r.id === next.manifest.head ? { ...r, combine_v: COMBINE_V } : r)) } : next.manifest;
  w.forceReplace(P, { ...next, manifest: m });
  return next.manifest.head;
}
const twoParentWrites = (c: Computer, from: number) =>
  c.dev.saves.slice(from).filter((x) => x.manifest.revisions.find((r) => r.id === x.manifest.head)!.parents.length === 2);

describe("D4 forced double write", () => {
  it("two phase 4 computers with equal delays both write the fine combine: the same id, deep-equal revisions, one combine", async () => {
    const same = { combineDelayMs: async () => 3000 };
    const { w, cs } = await world({ name: "", mode: "lww", delay: 500, notes: false }, [same, same]);
    const [a, b] = cs;
    a.graph.getState().setCell(0, 0, 0, "X");
    await flush();
    await a.ses.getState().save();
    await tick(w, 2000);
    expect(b.graph.getState().doc!.cells[0][0][0]).toBe("X");
    await carlSavesOver(w, a, withCell(5, 1, "carl"));
    const wa = a.dev.saves.length, wb = b.dev.saves.length;
    await tick(w, 30_000);
    const xa = twoParentWrites(a, wa), xb = twoParentWrites(b, wb);
    expect(xa).toHaveLength(1);
    expect(xb).toHaveLength(1);
    expect(xa[0].manifest.head).toBe(xb[0].manifest.head);
    const ra = xa[0].manifest.revisions.find((r) => r.id === xa[0].manifest.head);
    const rb = xb[0].manifest.revisions.find((r) => r.id === xb[0].manifest.head);
    expect(ra).toEqual(rb);
    expect(ra).toMatchObject({ auto: true, combine_v: 1 });
    await tick(w, 10_000);
    await expectConverged(w, cs);
    expect(duplicateCombines(w)).toEqual([]);
    const g = a.graph.getState();
    expect([g.doc!.cells[0][0][0], g.doc!.cells[5][1][0]]).toEqual(["X", "carl"]);
  });
});

describe("D5 next to an older app (section-level rules, no combine_v)", () => {
  const old: TestDeps = { combineLevel: "section" };

  it("different sections: both compute the same id; the entries are equal up to combine_v", async () => {
    const same = { combineDelayMs: async () => 3000 };
    const { w, cs } = await world({ name: "", mode: "lww", delay: 500, notes: false }, [same, { ...same, ...old }]);
    const [a, b] = cs;
    a.graph.getState().setCell(0, 0, 0, "X");
    await flush();
    await a.ses.getState().save();
    await tick(w, 2000);
    await carlSavesOver(w, a, (c) => ({ ...c, figure: { ...c.figure, title: "carl" } }));
    const wa = a.dev.saves.length, wb = b.dev.saves.length;
    await tick(w, 30_000);
    const xa = twoParentWrites(a, wa), xb = twoParentWrites(b, wb);
    expect(xa).toHaveLength(1);
    expect(xb).toHaveLength(1);
    expect(xa[0].manifest.head).toBe(xb[0].manifest.head);
    const ra = xa[0].manifest.revisions.find((r) => r.id === xa[0].manifest.head) as RevisionP4;
    const rb = xb[0].manifest.revisions.find((r) => r.id === xb[0].manifest.head) as RevisionP4;
    expect(ra.combine_v).toBe(1);
    expect("combine_v" in rb).toBe(false);
    expect({ ...rb, combine_v: 1 }).toEqual(ra);
    await tick(w, 10_000);
    await expectConverged(w, cs);
  });

  async function racing(firstSaver: "p4" | "p3") {
    // a = phase 4, b = the older app. Both edit different cells of the table at the same time and save;
    // with last-writer-wins the later save silently replaces the earlier one.
    const { w, cs, d } = await world({ name: "", mode: "lww", delay: 2000, notes: false }, [{}, old]);
    const [a, b] = cs;
    a.graph.getState().setCell(0, 0, 0, "P4 edit");
    b.graph.getState().setCell(4, 1, 0, "P3 edit");
    await flush();
    const [first, second] = firstSaver === "p4" ? [a, b] : [b, a];
    await first.ses.getState().save();
    await tick(w, 300);
    await second.ses.getState().save();
    await tick(w, 30_000);
    return { w, cs, d, a, b };
  }

  it("same section, different cells, the P4 save replaced: P4 shows 'review' and never writes by itself; one click and all converge", async () => {
    const { w, cs, d, a, b } = await racing("p4");
    const ws = a.dev.saves.length;
    await tick(w, 60_000);
    expect(activeTab(a).banners.find((x) => x.kind === "savedOver")).toMatchObject({ state: "review" });
    expect(twoParentWrites(a, 0)).toHaveLength(0);
    expect(a.dev.saves.length).toBe(ws);
    expect(twoParentWrites(b, 0)).toHaveLength(0);
    const t = activeTab(a);
    await a.ses.getState().bannerAction(t.key, t.banners.find((x) => x.kind === "savedOver")!.id, "combine");
    await flush();
    expect(a.ses.getState().dialog).toBeNull();
    await settle(w, cs, d);
    await expectConverged(w, cs);
    expect(duplicateCombines(w)).toEqual([]);
    const g = b.graph.getState();
    expect([g.doc!.cells[0][0][0], g.doc!.cells[4][1][0]]).toEqual(["P4 edit", "P3 edit"]);
  });

  it("same section, different cells, the P3 save replaced: P3 asks to choose (whole table); after one choice all converge, the other side stays in the history", async () => {
    const { w, cs, d, a, b } = await racing("p3");
    expect(activeTab(b).banners.find((x) => x.kind === "savedOver")).toMatchObject({ state: "choose" });
    expect(activeTab(a).banners.filter((x) => x.kind === "savedOver" && x.state)).toEqual([]);
    const aHead = a.dev.localHead(P)!;
    const t = activeTab(b);
    await b.ses.getState().bannerAction(t.key, t.banners.find((x) => x.kind === "savedOver")!.id, "combine");
    await flush();
    const st = combineState(b)!;
    expect(st.sections.find((x) => x.key === "table")).toMatchObject({ status: "both", choice: null, conflicts: [] });
    await b.ses.getState().setSectionChoice("table", "mine");
    expect((await b.ses.getState().applyCombine()).ok).toBe(true);
    await settle(w, cs, d);
    await expectConverged(w, cs);
    expect(duplicateCombines(w)).toEqual([]);
    const m = headRev(a.dev, P)!;
    expect(m.parents).toContain(aHead);
    expect("combine_v" in m).toBe(false);
    expect(revisionOf(a.dev.localFile(P)!.manifest, aHead)?.sections).not.toBeNull();
    expect(a.graph.getState().doc!.cells[4][1][0]).toBe("P3 edit");
  });
});

describe("D6 the same place on both", () => {
  it.each([
    { name: "dropbox 1 s", mode: "dropbox" as const, delay: 1000 },
    { name: "lww 5 s", mode: "lww" as const, delay: 5000 },
    { name: "onedrive 0 s", mode: "onedrive" as const, delay: 0 },
  ])("$name: a dialog or 'choose', nothing written without Apply, one choice and all converge", { timeout: 120_000 }, async (sc) => {
    const { w, cs, d } = await world(sc);
    const [a, b] = cs;
    a.graph.getState().setCell(0, 0, 0, "A here");
    b.graph.getState().setCell(0, 0, 0, "B here");
    await flush();
    await a.ses.getState().save();
    await b.ses.getState().save();
    await tick(w, 2 * d + 20_000);
    const asking = cs.filter((c) => c.ses.getState().dialog?.kind === "combine"
      || activeTab(c).banners.some((x) => (x.kind === "savedOver" && x.state === "choose") || x.kind === "notSaved" || (x.kind === "extraCopy" && x.relation === "diverged")));
    expect(asking.length).toBeGreaterThan(0);
    // No combined version was written by itself.
    for (const c of cs) expect(twoParentWrites(c, 0)).toHaveLength(0);
    await settle(w, cs, d, "theirs");
    await expectConverged(w, cs);
    expect(duplicateCombines(w)).toEqual([]);
  });
});

describe("D7 three phase 4 computers, one replaced save", () => {
  it("exactly one writes the combine (the shortest delay); the others reload; no banner is left", async () => {
    const { w, cs } = await world({ name: "", mode: "lww", delay: 500, three: true, notes: false });
    const [a] = cs;
    a.graph.getState().setCell(0, 0, 0, "X");
    await flush();
    await a.ses.getState().save();
    await tick(w, 3000);
    for (const c of cs) expect(c.graph.getState().doc!.cells[0][0][0]).toBe("X");
    const before = cs.map((c) => c.dev.saves.length);
    await carlSavesOver(w, a, withCell(6, 2, "carl"));
    await tick(w, 40_000);
    const writers = cs.filter((c, k) => twoParentWrites(c, before[k]).length > 0);
    expect(writers).toHaveLength(1);
    expect(twoParentWrites(writers[0], 0)).toHaveLength(1);
    await expectConverged(w, cs);
    for (const c of cs) {
      expect(activeTab(c).banners.filter((x) => x.kind === "savedOver" && (x.state === "review" || x.state === "choose"))).toEqual([]);
      expect(c.graph.getState().doc!.cells[6][2][0]).toBe("carl");
      expect(c.graph.getState().doc!.cells[0][0][0]).toBe("X");
    }
    expect(headRev(a.dev, P)).toMatchObject({ auto: true, combine_v: 1 });
  });
});

void DBX;
