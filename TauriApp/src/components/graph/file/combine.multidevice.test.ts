// Plan §13 scenarios with phase 2 combining (phase2-contract.md checklist S19):
// two or three computers edit, save and the world settles — automatic combines
// after the device-ordered delay, a click on Combine… where the service made a
// copy, one person's choice where both changed the same section. Asserted for
// every scenario: no version is ever lost; every computer ends on the same
// version with the same content; at most one combined version per pair of
// versions; no file is removed unless everything in it is in a surviving file.
import { describe, expect, it } from "vitest";
import { partsOf, sectionsOf } from "./docCodec";
import { isAncestorOrSelf } from "./format";
import type { ConflictMode, MemoryWorld } from "./memoryBackend";
import {
  DBX, PFILE as P, activeTab, computer, duplicateCombines, flush, lostVersions, makeWorld, seedFile, start, tick, type Computer,
} from "./testkit";

type Edit = "table" | "figure" | "analysis";

interface Scenario {
  name: string;
  mode?: ConflictMode;
  delay?: number;
  three?: boolean;
  partialB?: number;
  sameId?: boolean;
  skewB?: number;
  /** What happens between the edits and the saves. */
  script?: "offline" | "deleteCreate" | "wake" | "rename";
}

const SCENARIOS: Scenario[] = [
  ...(["dropbox", "onedrive", "lww"] as const).flatMap((mode) => [0, 5000, 60_000].map((delay) => ({ name: `${mode}, sync delay ${delay / 1000} s`, mode, delay }))),
  { name: "one computer offline, then back", script: "offline", delay: 1000 },
  { name: "partial delivery (incomplete file first)", partialB: 4000, delay: 1000 },
  { name: "delete-then-create delivery", script: "deleteCreate", delay: 1000 },
  { name: "wake before sync (old base after a long clock jump)", script: "wake", delay: 1000 },
  { name: "rename on one computer while the other edits", script: "rename", delay: 1000 },
  { name: "duplicate device id", sameId: true, delay: 1000 },
  { name: "clock skew +2 h", skewB: 2 * 3600_000, delay: 1000 },
  { name: "clock skew −2 h", skewB: -2 * 3600_000, delay: 1000 },
  { name: "three computers", three: true, delay: 2000 },
  { name: "three computers, last writer wins", three: true, mode: "lww", delay: 2000 },
];

async function world(sc: Scenario) {
  const w = makeWorld(sc.mode ?? "dropbox");
  const d = sc.delay ?? 1000;
  const a = await start(await computer(w, { device_id: "d-a", device_name: "Mac mini", uploadDelayMs: d, downloadDelayMs: d }));
  const b = await start(await computer(w, {
    device_id: sc.sameId ? "d-a" : "d-b", device_name: "MacBook", user_name: "Alice", uploadDelayMs: d, downloadDelayMs: d, partialDeliveryMs: sc.partialB,
  }, { skewMs: sc.skewB }));
  const cs = [a, b];
  if (sc.three) cs.push(await start(await computer(w, { device_id: "d-c", device_name: "Lab PC", user_name: "Carol", uploadDelayMs: d, downloadDelayMs: d })));
  await seedFile(w, a.dev, P);
  await tick(w, 2 * d + (sc.partialB ?? 0) + 1000);
  for (const c of cs) expect((await c.ses.getState().open(P)).ok).toBe(true);
  return { w, cs, d };
}

function edit(c: Computer, e: Edit, value: string) {
  const g = c.graph.getState();
  if (e === "table") g.setCell(0, 0, 0, value);
  else if (e === "figure") g.setFigure({ title: value });
  else g.setAnalysis({ alpha: value.length % 2 ? 0.01 : 0.1 });
}

/** One person's turn: the first computer with something to do does it. `pick`: the choice in a dialog. */
async function oneTurn(cs: Computer[], pick: "mine" | "theirs"): Promise<boolean> {
  for (const c of cs) {
    const s = c.ses.getState();
    const d = s.dialog;
    if (d?.kind === "combine") {
      for (const sec of d.state.sections) if (sec.choice === null) await s.setSectionChoice(sec.key, pick);
      await s.applyCombine();
      await flush();
      return true;
    }
    const t = activeTab(c);
    if (!t || t.combining) continue;
    // "Is this the same analysis?" — yes (a rename that met an edit made two files of one analysis).
    const q = t.banners.find((x) => x.kind === "copyQuestion");
    if (q) { await s.bannerAction(t.key, q.id, "same"); await flush(); return true; }
    // The file this tab was on was removed on another computer as an older copy: Find it… in the folder.
    const miss = t.banners.find((x) => x.kind === "missing");
    if (miss) { c.picks.push(DBX); await s.bannerAction(t.key, miss.id, "findIt"); await flush(); return true; }
    const b = t.banners.find((x) => x.actions.includes("combine") && (x.kind !== "extraCopy" || x.relation === "diverged"));
    if (b) { await s.bannerAction(t.key, b.id, "combine"); await flush(); return true; }
  }
  return false;
}

/** Let the world settle: sync, waiting combines, one person's click at a time. */
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

/** Older copies are removed through the controller (the backend re-checks the ancestor rule). */
async function removeOlderCopies(cs: Computer[], removedAt: { head: string; keeperHead: string; keeper: string }[]) {
  for (const c of cs) {
    const t = activeTab(c);
    for (const b of t.banners.filter((x) => x.kind === "extraCopy" && (x.relation === "older" || x.relation === "same") && x.path)) {
      const before = c.dev.localFile(b.path!);
      const keeper = c.dev.localFile(t.path!);
      if (await c.ses.getState().removeExtraCopy(t.key, b.path!)) removedAt.push({ head: before!.manifest.head, keeperHead: keeper!.manifest.head, keeper: t.path! });
    }
  }
}

async function run(sc: Scenario, sameSection: boolean) {
  const { w, cs, d } = await world(sc);
  const [a, b] = cs;
  const edits: Edit[] = sameSection ? ["table", "table", "table"] : ["table", "figure", "analysis"];
  const writesBefore = cs.map((c) => c.dev.written.length);
  if (sc.script === "offline" || sc.script === "wake") b.dev.setOnline(false);
  cs.forEach((c, k) => edit(c, edits[k], `${c.dev.name} edit`));
  await flush();
  if (sc.script === "rename") a.dev.rename(P, `${DBX}/Renamed.lag`);
  if (sc.script === "deleteCreate") {
    const f = a.dev.localFile(P)!;
    a.dev.remove(P);
    await tick(w, 2500);
    a.dev.place(P, f);
  }
  await a.ses.getState().save();
  if (sc.script === "wake") { w.clock.advance(3600_000); await flush(); }
  for (const c of cs.slice(1)) await c.ses.getState().save();
  if (sc.script === "offline" || sc.script === "wake") { await tick(w, 2 * d + 1000); b.dev.setOnline(true); }
  await settle(w, cs, d, "mine");
  const removed: { head: string; keeperHead: string; keeper: string }[] = [];
  await removeOlderCopies(cs, removed);
  await settle(w, cs, d, "mine");

  if ((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.S19_DEBUG) for (const c of cs) {
    const t = activeTab(c);
    const dd = c.ses.getState().dialog;
    if (dd?.kind === "combine") console.log("DIALOG", c.dev.name, JSON.stringify({ src: dd.state.source, err: dd.state.error, applying: dd.state.applying, can: dd.state.canApply, secs: dd.state.sections, theirs: dd.state.theirs.head, mine: dd.state.mine.head }));
    console.log("SAVES", c.dev.name, c.dev.saves.slice(-6).map((x) => `${x.expectedHead}->${x.manifest.head}`).join(" | "));
    console.log(c.dev.name, t.path, t.baseRevision, c.dev.localHead(t.path!), JSON.stringify(t.banners.map((x) => [x.kind, x.state, x.relation, x.path, x.actions])), t.dirty, t.notSaved, c.ses.getState().dialog?.kind, c.dev.localPaths());
  }
  // 1. No version is ever lost.
  expect(lostVersions(w)).toEqual([]);
  // 2. Every computer ends on the same version of the file, with the same content.
  const heads = cs.map((c) => c.dev.localHead(activeTab(c).path!));
  expect(new Set(heads).size).toBe(1);
  for (const c of cs) expect(activeTab(c)).toMatchObject({ dirty: false, notSaved: false, baseRevision: heads[0] });
  expect(new Set(await Promise.all(cs.map(contentHashOf))).size).toBe(1);
  // Everybody's edit is in it (one choice where they collided).
  if (!sameSection) {
    const g = a.graph.getState();
    expect(g.doc!.cells[0][0][0]).toBe("Mac mini edit");
    expect(g.figure.title).toBe("MacBook edit");
  }
  // 3. At most one combined version per pair of versions.
  expect(duplicateCombines(w)).toEqual([]);
  // 4. Nothing was removed unless its newest version is in a surviving file.
  for (const r of removed) {
    const keeper = cs[0].dev.localFile(r.keeper) ?? cs[0].dev.localFile(activeTab(cs[0]).path!);
    expect(isAncestorOrSelf(keeper!.manifest, r.head, keeper!.manifest.head)).toBe(true);
  }
  for (const c of cs) {
    for (const x of (await c.dev.listDisplaced()).filter((e) => e.reason === "removedCopy")) {
      const keeper = c.dev.localFile(activeTab(c).path!)!;
      expect(isAncestorOrSelf(keeper.manifest, x.head, keeper.manifest.head)).toBe(true);
    }
  }
  // Something happened on every computer (each saved its edit).
  cs.forEach((c, k) => expect(c.dev.written.length).toBeGreaterThan(writesBefore[k]));
}

describe("S19: different sections edited — everything combines", () => {
  it.each(SCENARIOS)("$name", { timeout: 120_000 }, async (sc) => { await run(sc, false); });
});

describe("S19: the same section edited — one choice, then everything converges", () => {
  it.each(SCENARIOS)("$name", { timeout: 120_000 }, async (sc) => { await run(sc, true); });
});
