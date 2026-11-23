// Phase 2 controller (phase2-contract.md §5, checklist S1–S18): combining with
// another computer's version, the combine dialog, automatic combines after the
// device-ordered delay, extra copies, rollbacks, reload in place, bring back,
// retention and the first-seen record. Two or three MemoryDevices on one
// ManualClock; nothing written that the contract does not allow.
import { describe, expect, it } from "vitest";
import { createGraphStore, isDirty, openContent } from "../../../store/graphStore";
import { FIXTURES } from "../__tests__/fixtures";
import { migrateDoc, sampleDoc } from "../graphModel";
import { SUMMARY, type RevisionP2 } from "./contract";
import { buildNewFile, buildNextFile, fileAt, openFile, revisionOf } from "./docCodec";
import {
  DBX, PFILE as P, activeTab, authorFor, bannerOf, computer, contentAt, duplicateCombines, editCell, editTitle, firstCell, flush,
  lostVersions, makeWorld, pair, pressBanner, start, syncPair, tick, type Pair,
} from "./testkit";

const head = (s: Pair, who: "a" | "b" = "a", path = P) => s[who].dev.localFile(path)!.manifest;
const headRev = (s: Pair, who: "a" | "b" = "a", path = P) => { const m = head(s, who, path); return revisionOf(m, m.head)! as RevisionP2; };
const title = (s: Pair, who: "a" | "b") => s[who].graph.getState().figure.title;
const cell = (s: Pair, who: "a" | "b") => s[who].graph.getState().doc!.cells[0][0][0];

describe("S1/S2: unsaved table edit here, the other computer saved a graph edit", () => {
  it("S1: newer-version banner with Combine; pressing it writes one two-parent version at once", async () => {
    const s = await pair();
    const { a, b } = s;
    await editCell(b, "mine");
    await editTitle(a, "Theirs");
    await a.ses.getState().save();
    await syncPair(s);
    const theirs = s.a.dev.localHead(P)!;
    expect(bannerOf(b, "newerOnDisk")).toMatchObject({ actions: ["combine", "later"], version: { head: theirs, deviceName: "Mac mini" } });
    expect(cell(s, "b")).toBe("mine");
    const savesBefore = b.dev.saves.length;
    await pressBanner(b, "newerOnDisk", "combine");
    expect(b.dev.saves.length).toBe(savesBefore + 1);
    const m = headRev(s, "b");
    expect(m.parents).toHaveLength(2);
    expect(m.kind).toBe("merge");
    expect(m.parents).toContain(theirs);
    expect(cell(s, "b")).toBe("mine");
    expect(title(s, "b")).toBe("Theirs");
    expect(activeTab(b)).toMatchObject({ dirty: false, notSaved: false, baseRevision: m.id });
    expect(bannerOf(b, "combined")).toMatchObject({ sections: ["figure"], actions: ["whatChanged", "undo"], dismissible: true });
    expect(bannerOf(b, "newerOnDisk")).toBeNull();
    expect(b.ses.getState().toasts.some((t) => t.kind === "combined")).toBe(true);
    expect(b.graph.getState().undoLabel()).toBe("Undo: combine with Zhuo (Mac mini)'s changes");
    await syncPair(s);
    // The other computer just reloads.
    expect(a.dev.localHead(P)).toBe(m.id);
    expect(cell(s, "a")).toBe("mine");
    expect(title(s, "a")).toBe("Theirs");
    expect(isDirty(a.graph.getState())).toBe(false);
    expect(lostVersions(s.w)).toEqual([]);
    expect(duplicateCombines(s.w)).toEqual([]);
  });

  it("S2: the same through Save: combined in one step, outcome ok", async () => {
    const s = await pair();
    const { a, b } = s;
    await editCell(b, "mine");
    await editTitle(a, "Theirs");
    await a.ses.getState().save();
    await syncPair(s);
    const out = await b.ses.getState().save();
    expect(out).toEqual({ ok: true, path: P });
    const m = headRev(s, "b");
    expect(m.parents).toHaveLength(2);
    expect(firstCell(contentAt(b.dev, P))).toBe("mine");
    expect(contentAt(b.dev, P)!.figure.title).toBe("Theirs");
    expect(b.ses.getState().dialog).toBeNull();
    expect(bannerOf(b, "combined")?.sections).toEqual(["figure"]);
    // My working version is in the file's history too.
    const w = m.parents.find((p) => p !== a.dev.localHead(P) && p !== m.id)!;
    expect(revisionOf(head(s, "b"), w)?.sections).not.toBeNull();
  });
});

describe("S3: both changed the table", () => {
  async function both(): Promise<Pair & { theirs: string }> {
    const s = await pair();
    await editCell(s.b, "B!");
    await editCell(s.a, "A!");
    await s.a.ses.getState().save();
    await syncPair(s);
    return { ...s, theirs: s.a.dev.localHead(P)! };
  }

  it("Save opens the dialog; nothing is written until Apply; Theirs gives their table", async () => {
    const s = await both();
    const { b, theirs } = s;
    const saves = b.dev.saves.length + 1;     // the save that met their version (refused, nothing written)
    expect(await b.ses.getState().save()).toEqual({ ok: false, reason: "conflict" });
    const d = b.ses.getState().dialog;
    expect(d?.kind).toBe("combine");
    if (d?.kind !== "combine") return;
    expect(d.state.sections.find((x) => x.key === "table")).toMatchObject({ status: "both", choice: null });
    expect(d.state).toMatchObject({ canApply: false, twoWay: false, origin: "save", mineUnsaved: true, index: 1, total: 1 });
    expect(d.state.since).not.toBeNull();
    expect(activeTab(b).notSaved).toBe(true);
    expect(b.dev.saves.length).toBe(saves);
    expect(b.dev.localHead(P)).toBe(theirs);
    await b.ses.getState().setSectionChoice("table", "theirs");
    const d2 = b.ses.getState().dialog;
    expect(d2?.kind === "combine" && d2.state.canApply).toBe(true);
    expect(b.dev.saves.length).toBe(saves);
    expect((await b.ses.getState().applyCombine()).ok).toBe(true);
    expect(b.ses.getState().dialog).toBeNull();
    expect(cell(s, "b")).toBe("A!");
    const m = headRev(s, "b");
    expect(m.parents).toHaveLength(2);
    expect(m.auto).toBeUndefined();
    expect(m.summary).toBe(SUMMARY.combinedChosen);
    expect(m.user_name).toBe("Alice");
    expect(activeTab(b)).toMatchObject({ dirty: false, notSaved: false });
    expect(lostVersions(s.w)).toEqual([]);
  });

  it("Mine keeps my table", async () => {
    const s = await both();
    await s.b.ses.getState().save();
    await s.b.ses.getState().setSectionChoice("table", "mine");
    expect((await s.b.ses.getState().applyCombine()).ok).toBe(true);
    expect(firstCell(contentAt(s.b.dev, P))).toBe("B!");
    await syncPair(s);
    expect(cell(s, "a")).toBe("B!");
  });

  it("Cancel leaves 'Not saved' and the file untouched; Choose… reopens the same combine", async () => {
    const s = await both();
    const { b, theirs } = s;
    await b.ses.getState().save();
    const saves = b.dev.saves.length;
    b.ses.getState().cancelCombine();
    expect(b.ses.getState().dialog).toBeNull();
    expect(activeTab(b)).toMatchObject({ notSaved: true, dirty: true });
    expect(bannerOf(b, "notSaved")).toMatchObject({ actions: ["choose"] });
    expect(b.dev.saves.length).toBe(saves);
    expect(b.dev.localHead(P)).toBe(theirs);
    await pressBanner(b, "notSaved", "choose");
    expect(b.ses.getState().dialog?.kind).toBe("combine");
  });
});

/** Another computer saves silently over `on`'s last save (iCloud-style), from the version before it. */
async function saveOver(s: Pair, on: "a" | "b", change: "table" | "figure", value = "theirs", deviceId = "d-c") {
  const dev = s[on].dev;
  const f = dev.localFile(P)!;
  const parent = revisionOf(f.manifest, f.manifest.head)!.parents[0];
  const base = fileAt(f, parent)!;
  const c = openFile(base)!;
  const next = change === "figure"
    ? { ...c, figure: { ...c.figure, title: value } }
    : { ...c, doc: { ...c.doc, cells: c.doc.cells.map((row, r) => row.map((reps, k) => (r === 0 && k === 0 ? [value, ...reps.slice(1)] : reps))) } };
  const theirs = await buildNextFile(base, next, { time: s.w.clock.now(), author: { ...authorFor(dev, "Carol"), device_id: deviceId, device_name: "Lab PC" } });
  s.w.forceReplace(P, theirs);
  return theirs.manifest.head;
}

describe("S5–S7: automatic combines (clean tab, device-ordered delay)", () => {
  it("S5: my save replaced (different sections): 'combining', nothing written before the delay, then one combined version", async () => {
    const s = await pair(2000, "lww");
    const { a } = s;
    await editCell(a, "my save");
    await a.ses.getState().save();
    const mine = a.dev.localHead(P)!;
    await syncPair(s);
    const t0 = s.w.clock.now();
    const theirs = await saveOver(s, "a", "figure");
    const writesA = a.dev.written.length;
    await tick(s.w, 2100);
    expect(bannerOf(a, "savedOver")).toMatchObject({ state: "combining", actions: [] });
    expect(activeTab(a).combining).toBe(true);
    expect(a.dev.written.length).toBe(writesA);
    // d-a's delay is 5530 ms after the version arrived (t0 + 2000).
    await tick(s.w, t0 + 2000 + 5400 - s.w.clock.now());
    expect(a.dev.written.length).toBe(writesA);
    await tick(s.w, 1000);
    const m = headRev(s, "a");
    expect(m.parents.sort()).toEqual([mine, theirs].sort());
    expect(m).toMatchObject({ auto: true, user_name: "", device_id: "", summary: SUMMARY.combinedAuto });
    expect(cell(s, "a")).toBe("my save");
    expect(title(s, "a")).toBe("theirs");
    expect(activeTab(a)).toMatchObject({ combining: false, dirty: false, baseRevision: m.id });
    expect(bannerOf(a, "savedOver")).toBeNull();
    expect(bannerOf(a, "combined")?.sections).toEqual(["figure"]);
    await syncPair(s);
    await syncPair(s);
    expect(s.b.dev.localHead(P)).toBe(m.id);
    expect(duplicateCombines(s.w)).toEqual([]);
    expect(lostVersions(s.w)).toEqual([]);
    expect(a.dev.localPaths()).toEqual([P]);       // no copy beside the file any more
  });

  it("S5: the same section: 'Choose what to keep', nothing written", async () => {
    const s = await pair(2000, "lww");
    const { a } = s;
    await editCell(a, "my save");
    await a.ses.getState().save();
    await syncPair(s);
    await saveOver(s, "a", "table", "theirs");
    const writesA = a.dev.written.length;
    await tick(s.w, 20_000);
    expect(bannerOf(a, "savedOver")).toMatchObject({ state: "choose", actions: ["combine"] });
    expect(a.dev.written.length).toBe(writesA);
    await pressBanner(a, "savedOver", "combine");
    const d = a.ses.getState().dialog;
    expect(d?.kind === "combine" && d.state.source).toEqual({ kind: "disk" });
    expect(d?.kind === "combine" && d.state.sections[0].status).toBe("both");
    expect(a.dev.written.length).toBe(writesA);
  });

  it("S6: two clean computers, same pair: the shorter delay writes, the other finds it and writes nothing", async () => {
    // Phase 3: no notes — with them the computer that just saved holds the file and the other one is read-only.
    const s = await pair(500, "lww", { notes: false });
    const { a, b } = s;
    await editCell(a, "X");
    await a.ses.getState().save();
    await syncPair(s);
    expect(cell(s, "b")).toBe("X");
    await saveOver(s, "a", "figure", "Y");
    const wa = a.dev.written.length, wb = b.dev.written.length;
    await tick(s.w, 30_000);
    // d-b waits 2422 ms, d-a 5530 ms.
    expect(b.dev.written.length).toBe(wb + 1);
    expect(a.dev.written.length).toBe(wa);
    expect(a.dev.localHead(P)).toBe(b.dev.localHead(P));
    expect(cell(s, "a")).toBe("X");
    expect(title(s, "a")).toBe("Y");
    expect(activeTab(a)).toMatchObject({ combining: false, dirty: false, baseRevision: a.dev.localHead(P) });
    expect(duplicateCombines(s.w)).toEqual([]);
  });

  it("S6: forced to write at the same moment, both produce the same version id: one combine", async () => {
    const same = { combineDelayMs: async () => 3000 };
    const s = await pair(500, "lww", { depsA: same, depsB: same, notes: false });
    const { a, b } = s;
    await editCell(a, "X");
    await a.ses.getState().save();
    await syncPair(s);
    await saveOver(s, "a", "figure", "Y");
    const wa = a.dev.written.length, wb = b.dev.written.length;
    await tick(s.w, 30_000);
    expect(a.dev.written.length).toBe(wa + 1);
    expect(b.dev.written.length).toBe(wb + 1);
    expect(a.dev.written[wa]).toBe(b.dev.written[wb]);
    expect(a.dev.localHead(P)).toBe(b.dev.localHead(P));
    expect(duplicateCombines(s.w)).toEqual([]);
    expect(lostVersions(s.w)).toEqual([]);
  });

  it("S7: a save that replaced another computer's save in the gap is combined with it (no copy beside the file)", async () => {
    const s = await pair();
    const { a, w } = s;
    const f = a.dev.localFile(P)!;
    const c = openFile(f)!;
    const theirs = await buildNextFile(f, { ...c, figure: { ...c.figure, title: "race" } }, { time: w.clock.now(), author: authorFor(s.b.dev, "Alice") });
    a.dev.armDisplace(P, theirs);
    await editCell(a, "mine");
    expect((await a.ses.getState().save()).ok).toBe(true);
    const saved = a.dev.localHead(P)!;
    expect(bannerOf(a, "savedOver")).toMatchObject({ state: "combining" });
    await tick(s.w, 11_000);
    const m = headRev(s, "a");
    expect(m.parents.sort()).toEqual([saved, theirs.manifest.head].sort());
    expect(cell(s, "a")).toBe("mine");
    expect(title(s, "a")).toBe("race");
    expect(a.dev.localPaths()).toEqual([P]);
    expect(bannerOf(a, "savedDisplaced")).toBeNull();
    expect(lostVersions(s.w)).toEqual([]);
  });
});

const CONFLICT = (who: string) => `${DBX}/Dose response (${who}'s conflicted copy 2026-11-20).lag`;

/** A copy beside P on `a`'s disk: P's head with one more change (from `fromParent`: the version before P's head). */
async function placeCopy(s: Pair, path: string, change: "table" | "figure", value: string, opts: { fromParent?: boolean } = {}) {
  const f = s.a.dev.localFile(P)!;
  const base = opts.fromParent ? fileAt(f, revisionOf(f.manifest, f.manifest.head)!.parents[0])! : f;
  const c = openFile(base)!;
  const next = change === "figure"
    ? { ...c, figure: { ...c.figure, title: value } }
    : { ...c, doc: { ...c.doc, cells: c.doc.cells.map((row, r) => row.map((reps, k) => (r === 0 && k === 0 ? [value, ...reps.slice(1)] : reps))) } };
  const file = await buildNextFile(base, next, { time: s.w.clock.now(), author: { ...authorFor(s.b.dev, "Bob"), device_id: `d-${value}`, device_name: `${value}'s Mac` } });
  s.a.dev.place(path, file);
  await tick(s.w, 300);
  return file.manifest.head;
}

describe("S8: extra copies", () => {
  it("older copy: Remove it moves it into the app's folder; Keep is remembered", async () => {
    const s = await pair(500);
    const { a } = s;
    const old = a.dev.localFile(P)!;
    await editCell(a, "newer");
    await a.ses.getState().save();
    const copy = `${DBX}/Dose response (old copy).lag`;
    a.dev.place(copy, old);
    await tick(s.w, 300);
    const b0 = activeTab(a).banners.find((x) => x.path === copy);
    expect(b0).toMatchObject({ kind: "extraCopy", relation: "older", actions: ["remove", "keep"] });
    expect(await a.ses.getState().removeExtraCopy(activeTab(a).key, copy)).toBe(true);
    expect(a.dev.localPaths()).toEqual([P]);
    expect(a.dev.removedCopies().map((x) => x.original)).toEqual([copy]);
    expect((await a.dev.listDisplaced()).find((x) => x.original === copy)).toMatchObject({ reason: "removedCopy", head: old.manifest.head });
    expect(a.ses.getState().toasts.some((t) => t.kind === "copyRemoved" && t.name === "Dose response (old copy)")).toBe(true);
    expect(activeTab(a).banners.some((x) => x.path === copy)).toBe(false);
    // Keep: remembered.
    const copy2 = `${DBX}/Dose response (old copy 2).lag`;
    a.dev.place(copy2, old);
    await tick(s.w, 300);
    await pressBanner(a, "extraCopy", "keep");
    expect(a.ses.internal.knownCopies(activeTab(a).key)).toContain(copy2);
    expect(a.dev.localPaths()).toContain(copy2);
    const a2 = await a.restart();
    expect(a2.ses.getState().tabs[0].banners.some((x) => x.path === copy2)).toBe(false);
  });

  it("a copy that gained changes since the banner is not removed (notOlder)", async () => {
    const s = await pair(500);
    const { a } = s;
    const old = a.dev.localFile(P)!;
    await editCell(a, "newer");
    await a.ses.getState().save();
    const copy = `${DBX}/Dose response (old copy).lag`;
    a.dev.place(copy, old);
    await tick(s.w, 300);
    // Someone edits the copy (from the old version) before the click arrives.
    const c = openFile(old)!;
    const changed = await buildNextFile(old, { ...c, figure: { ...c.figure, title: "edited copy" } }, { time: s.w.clock.now(), author: authorFor(s.b.dev, "Bob") });
    a.dev.place(copy, changed);
    expect(await a.ses.getState().removeExtraCopy(activeTab(a).key, copy)).toBe(false);
    expect(a.dev.localPaths()).toContain(copy);
    expect(a.dev.removedCopies()).toEqual([]);
    expect(a.ses.getState().toasts.some((t) => t.kind === "error" && /has changes that aren't in this file/.test(t.message ?? ""))).toBe(true);
    await tick(s.w, 300);
    expect(activeTab(a).banners.find((x) => x.path === copy)).toMatchObject({ relation: "diverged", actions: ["combine", "notSame", "later"] });
  });

  it("diverged copy: Combine… writes into the file with the shorter name; the copy is then an older copy", async () => {
    const s = await pair(500);
    const { a } = s;
    await editCell(a, "mine");
    await a.ses.getState().save();
    const mine = a.dev.localHead(P)!;
    const copy = CONFLICT("Bob");
    const theirs = await placeCopy(s, copy, "figure", "Bob", { fromParent: true });
    expect(activeTab(a).banners.find((x) => x.path === copy)).toMatchObject({ kind: "extraCopy", relation: "diverged", actions: ["combine", "notSame", "later"] });
    const writes = a.dev.written.length;
    await pressBanner(a, "extraCopy", "combine");
    expect(a.dev.written.length).toBe(writes + 1);
    const m = headRev(s, "a");
    expect(m.parents.sort()).toEqual([mine, theirs].sort());
    expect(activeTab(a).path).toBe(P);
    expect(cell(s, "a")).toBe("mine");
    expect(title(s, "a")).toBe("Bob");
    expect(a.dev.localHead(copy)).toBe(theirs);           // the copy itself is not touched
    expect(activeTab(a).banners.find((x) => x.path === copy)).toMatchObject({ relation: "older", actions: ["remove", "keep"] });
    expect(lostVersions(s.w)).toEqual([]);
  });

  it("diverged copy with the shorter name: the tab re-points to it", async () => {
    const s = await pair(500);
    const { a } = s;
    const long = CONFLICT("Mac mini");
    // This computer's tab is on the longer-named file; P (shorter) diverged.
    const t0 = activeTab(a).key;
    await a.ses.getState().closeTab(t0);
    const orig = a.dev.localFile(P)!;
    a.dev.place(long, orig);
    await tick(s.w, 300);
    await a.ses.getState().open(long);
    await flush();
    await editCell(a, "mine");
    await a.ses.getState().save();
    const theirs = await (async () => {
      const c = openFile(orig)!;
      const f = await buildNextFile(orig, { ...c, figure: { ...c.figure, title: "P edit" } }, { time: s.w.clock.now(), author: authorFor(s.b.dev, "Bob") });
      a.dev.place(P, f);
      await tick(s.w, 300);
      return f.manifest.head;
    })();
    let b = activeTab(a).banners.find((x) => x.path === P)!;
    if (b.kind === "copyQuestion") { await a.ses.getState().bannerAction(activeTab(a).key, b.id, "same"); b = activeTab(a).banners.find((x) => x.path === P)!; }
    expect(b).toMatchObject({ kind: "extraCopy", relation: "diverged" });
    await a.ses.getState().bannerAction(activeTab(a).key, b.id, "combine");
    await flush();
    expect(activeTab(a).path).toBe(P);
    const m = headRev(s, "a");
    expect(m.parents).toContain(theirs);
    expect(cell(s, "a")).toBe("mine");
    expect(title(s, "a")).toBe("P edit");
    expect(activeTab(a).banners.find((x) => x.path === long)).toMatchObject({ kind: "extraCopy", relation: "older" });
  });

  it("three diverged copies: Copy 1 of 3 … 3 of 3", async () => {
    const s = await pair(500);
    const { a } = s;
    await editCell(a, "mine");
    await a.ses.getState().save();
    for (const who of ["Bob", "Cat", "Dan"]) await placeCopy(s, CONFLICT(who), "table", who, { fromParent: true });
    expect(activeTab(a).banners.filter((x) => x.kind === "extraCopy" && x.relation === "diverged")).toHaveLength(3);
    await pressBanner(a, "extraCopy", "combine");
    for (let n = 1; n <= 3; n++) {
      const d = a.ses.getState().dialog;
      expect(d?.kind === "combine" && { index: d.state.index, total: d.state.total, copy: d.state.copyName }).toEqual({ index: n, total: 3, copy: expect.stringContaining("conflicted copy") });
      await a.ses.getState().setSectionChoice("table", "mine");
      expect((await a.ses.getState().applyCombine()).ok).toBe(true);
      await flush();
    }
    expect(a.ses.getState().dialog).toBeNull();
    const merges = head(s).revisions.filter((r) => r.parents.length === 2);
    expect(merges).toHaveLength(3);
    expect(cell(s, "a")).toBe("mine");
    expect(lostVersions(s.w)).toEqual([]);
  });
});

describe("S4: Keep both as separate files", () => {
  it("disk: mine becomes a new analysis elsewhere; the file stays as they saved it", async () => {
    const s = await pair();
    const { a, b } = s;
    await editCell(b, "B!");
    await editCell(a, "A!");
    await a.ses.getState().save();
    await syncPair(s);
    const theirs = a.dev.localHead(P)!;
    await b.ses.getState().save();
    b.picks.push(`${DBX}/Mine`);
    await b.ses.getState().keepBothAsSeparate();
    const mine = `${DBX}/Mine.lag`;
    expect(activeTab(b)).toMatchObject({ path: mine, dirty: false, notSaved: false });
    expect(b.dev.localFile(mine)!.manifest.analysis_id).not.toBe(b.dev.localFile(P)!.manifest.analysis_id);
    expect(firstCell(contentAt(b.dev, mine))).toBe("B!");
    expect(b.dev.localHead(P)).toBe(theirs);
    expect(lostVersions(s.w)).toEqual([]);
  });

  it("copy: the copy gets its own analysis id", async () => {
    const s = await pair(500);
    const { a } = s;
    await editCell(a, "mine");
    await a.ses.getState().save();
    const copy = CONFLICT("Bob");
    await placeCopy(s, copy, "table", "Bob", { fromParent: true });
    await pressBanner(a, "extraCopy", "combine");
    expect(a.ses.getState().dialog?.kind).toBe("combine");
    await a.ses.getState().keepBothAsSeparate();
    expect(a.ses.getState().dialog).toBeNull();
    const cf = a.dev.localFile(copy)!;
    expect(cf.manifest.analysis_id).not.toBe(a.dev.localFile(P)!.manifest.analysis_id);
    expect(cf.manifest.forked_from?.analysis_id).toBe(a.dev.localFile(P)!.manifest.analysis_id);
    expect(revisionOf(cf.manifest, cf.manifest.head)!.summary).toBe(SUMMARY.separated);
    expect(firstCell(contentAt(a.dev, P))).toBe("mine");
  });

  it("journal source: a clean tab already on their version, my replaced save offered", async () => {
    const s = await pair(2000, "lww");
    const { a } = s;
    await editCell(a, "my save");
    await a.ses.getState().save();
    const mine = a.dev.localHead(P)!;
    await syncPair(s);
    await saveOver(s, "a", "table", "theirs");
    // Closed and opened again: the tab is on their version; my save is only in this computer's saved copies.
    await a.ses.getState().closeTab();
    await tick(s.w, 3000);
    await a.ses.getState().open(P);
    await flush();
    const b = bannerOf(a, "savedOver");
    expect(b).toMatchObject({ state: "choose", actions: ["combine"], version: { head: mine } });
    await pressBanner(a, "savedOver", "combine");
    const d = a.ses.getState().dialog;
    expect(d?.kind === "combine" && d.state.source).toEqual({ kind: "journal", revisionId: mine });
    await a.ses.getState().keepBothAsSeparate();
    const beside = `${DBX}/Dose response (version from Mac mini).lag`;
    expect(firstCell(contentAt(a.dev, beside))).toBe("my save");
    expect(a.dev.localFile(beside)!.manifest.forked_from).toEqual({ analysis_id: a.dev.localFile(P)!.manifest.analysis_id, revision_id: mine });
    expect(a.ses.internal.settled(activeTab(a).key)).toContain(mine);
    expect(a.ses.internal.knownCopies(activeTab(a).key)).toContain(beside);
  });
});

describe("S9: a file put back to an earlier version", () => {
  it("banner, nothing automatic; 'Use the earlier version' then Save carries the dropped versions into the file", async () => {
    const s = await pair(500);
    const { a } = s;
    await editCell(a, "r2");
    await a.ses.getState().save();
    const r2 = a.dev.localHead(P)!;
    await editCell(a, "r3");
    await a.ses.getState().save();
    const r3 = a.dev.localHead(P)!;
    await syncPair(s);
    s.w.forceReplace(P, fileAt(a.dev.localFile(P)!, r2)!);
    const writes = a.dev.written.length;
    await tick(s.w, 30_000);
    expect(bannerOf(a, "rolledBack")).toMatchObject({ actions: ["useEarlier", "backToLatest"], version: { head: r2 } });
    expect(a.dev.written.length).toBe(writes);
    expect(cell(s, "a")).toBe("r3");
    await pressBanner(a, "rolledBack", "useEarlier");
    expect(cell(s, "a")).toBe("r2");
    expect(a.ses.internal.carryHeads(activeTab(a).key)).toContain(r3);
    expect(revisionOf(a.dev.localFile(P)!.manifest, r3)).toBeNull();
    await editCell(a, "after");
    await a.ses.getState().save();
    const m = a.dev.localFile(P)!.manifest;
    expect(revisionOf(m, r3)).not.toBeNull();
    expect(revisionOf(m, m.head)!.parents).toEqual([r2]);
    expect(a.ses.internal.carryHeads(activeTab(a).key)).toEqual([]);
    expect(bannerOf(a, "rolledBack")).toBeNull();
    expect(lostVersions(s.w)).toEqual([]);
  });
});

describe("S10/S11: reload in place (graphStore.replaceContent)", () => {
  const file = { docKey: "k1", analysisId: "a1", baseRevision: "r1", path: "/x.lag" };
  function loaded() {
    const g = createGraphStore();
    const c = openContent({ doc: sampleDoc("column") });
    g.getState().loadFile({ file, name: "x", ...c, scratch: '{"v":1,"cells":[[0,0,"5"]]}', saved: true });
    return g;
  }

  it("refuses when the base or the edit serial moved, changes nothing", () => {
    const g = loaded();
    const s0 = g.getState();
    const other = openContent({ doc: { ...sampleDoc("column"), x_title: "new" } });
    const args = { docKey: "k1", expectedBase: "r1", expectedEditSerial: s0.editSerial, file: { ...file, baseRevision: "r2" }, name: "x", ...other };
    expect(g.getState().replaceContent({ ...args, expectedBase: "r0" })).toBe(false);
    expect(g.getState().replaceContent({ ...args, expectedEditSerial: s0.editSerial - 1 })).toBe(false);
    expect(g.getState().replaceContent({ ...args, docKey: "k2" })).toBe(false);
    expect(g.getState().doc).toBe(s0.doc);
    expect(g.getState().replaceContent(args)).toBe(true);
    expect(g.getState().doc!.x_title).toBe("new");
    expect(g.getState().file?.baseRevision).toBe("r2");
    expect(isDirty(g.getState())).toBe(false);
    expect(g.getState().docSerial).toBe(s0.docSerial);
    expect(g.getState().undoStack).toEqual([]);
    expect(g.getState().undoLabel()).toBeNull();
  });

  it("one labelled undo step that brings the whole previous content back as unsaved changes; the scratchpad text is kept", () => {
    const g = loaded();
    g.getState().setCell(0, 0, 0, "mine");
    const before = g.getState();
    const scratch = before.scratch;
    const other = openContent({ doc: before.doc!, figure: { ...before.figure, title: "theirs" } });
    expect(g.getState().replaceContent({
      docKey: "k1", expectedBase: "r1", expectedEditSerial: before.editSerial, file: { ...file, baseRevision: "rm" }, name: "x",
      ...other, scratch, undo: { label: "Undo: combine with Alice's changes" },
    })).toBe(true);
    const after = g.getState();
    expect(after.scratch).toBe(scratch);
    expect(after.figure.title).toBe("theirs");
    expect(after.undoStack).toHaveLength(1);
    expect(after.undoLabel()).toBe("Undo: combine with Alice's changes");
    expect(isDirty(after)).toBe(false);
    expect(g.getState().undo()).toBe(true);
    expect(g.getState().figure.title).toBe(before.figure.title);
    expect(g.getState().doc!.cells[0][0][0]).toBe("mine");
    expect(g.getState().file?.baseRevision).toBe("rm");
    expect(isDirty(g.getState())).toBe(true);
  });

  it("held back while something is being edited or an export holds it; applied after", async () => {
    let busy = false;
    const s = await pair(500, "dropbox", { depsB: { interactionBusy: () => busy } });
    const { a, b } = s;
    busy = true;
    await editTitle(a, "Newer");
    await a.ses.getState().save();
    await syncPair(s);
    expect(activeTab(b).updating).toBe(true);
    expect(title(s, "b")).not.toBe("Newer");
    busy = false;
    await tick(s.w, 600);
    expect(activeTab(b).updating).toBe(false);
    expect(title(s, "b")).toBe("Newer");
    expect(isDirty(b.graph.getState())).toBe(false);
    // An export hold.
    const release = b.ses.getState().holdReplace("export");
    await editTitle(a, "Newer 2");
    await a.ses.getState().save();
    await syncPair(s);
    expect(activeTab(b).updating).toBe(true);
    expect(title(s, "b")).toBe("Newer");
    release();
    await tick(s.w, 600);
    expect(title(s, "b")).toBe("Newer 2");
  });

  it("an edit committed while the newer version was held keeps the edit and offers the newer version", async () => {
    let busy = false;
    const s = await pair(500, "dropbox", { depsB: { interactionBusy: () => busy } });
    const { a, b } = s;
    busy = true;
    await editTitle(a, "Newer");
    await a.ses.getState().save();
    await syncPair(s);
    expect(activeTab(b).updating).toBe(true);
    await editCell(b, "typed");
    busy = false;
    await tick(s.w, 600);
    expect(cell(s, "b")).toBe("typed");
    expect(activeTab(b)).toMatchObject({ dirty: true, updating: false });
    expect(bannerOf(b, "newerOnDisk")).toMatchObject({ actions: ["combine", "later"] });
  });

  it("S11: a newer version of every fixture shown in place leaves the tab clean", async () => {
    const w = makeWorld();
    const a = await start(await computer(w, { device_id: "d-a", device_name: "Mac" }));
    for (let n = 0; n < FIXTURES.length; n++) {
      const f = FIXTURES[n], g = FIXTURES[(n + 1) % FIXTURES.length];
      const c1 = openContent({ doc: migrateDoc(f.table)!, analysis: f.analysis as never, figure: f.figure as never, scratch: f.scratchpad });
      const c2 = openContent({ doc: migrateDoc(g.table)!, analysis: g.analysis as never, figure: g.figure as never, scratch: g.scratchpad });
      const path = `${DBX}/fx ${n}.lag`;
      const file = await buildNewFile({ content: c1, analysisId: `a-fx-${n}`, forkedFrom: null, time: w.clock.now(), author: authorFor(a.dev) });
      a.dev.place(path, file);
      await a.ses.getState().open(path);
      await flush();
      expect(isDirty(a.graph.getState())).toBe(false);
      const next = await buildNextFile(file, { ...c2, doc: { ...c2.doc, template: c2.doc.template } }, { time: w.clock.now(), author: authorFor(a.dev, "Bob") });
      a.dev.place(path, next);
      await tick(w, 300);
      expect(activeTab(a).baseRevision).toBe(next.manifest.head);
      expect(isDirty(a.graph.getState())).toBe(false);
      expect(activeTab(a).dirty).toBe(false);
      await a.ses.getState().closeTab();
    }
  });
});

describe("S15/S17/S18", () => {
  it("S15: a revision with an unknown field survives open → edit → save → combine → bring back", async () => {
    const s = await pair(500);
    const { a, b } = s;
    const f = a.dev.localFile(P)!;
    const root = f.manifest.revisions[0];
    const withZz = { ...f, manifest: { ...f.manifest, revisions: [{ ...root, zz: 1 } as typeof root] } };
    s.w.forceReplace(P, withZz);
    await syncPair(s);
    // Opened as a file that has it (an unknown field written by a newer app).
    for (const c of [a, b]) { await c.ses.getState().closeTab(); await c.ses.getState().open(P); await flush(); }
    await editCell(a, "A");
    await a.ses.getState().save();
    await editTitle(b, "B");
    await syncPair(s);
    expect((await b.ses.getState().save()).ok).toBe(true);
    expect(headRev(s, "b").parents).toHaveLength(2);
    expect((await b.ses.getState().bringBack(root.id)).ok).toBe(true);
    const m = b.dev.localFile(P)!.manifest;
    expect(m.revisions.find((r) => r.id === root.id)).toEqual({ ...root, zz: 1 });
    expect(revisionOf(m, m.head)).toMatchObject({ kind: "restore", restored_from: root.id, summary: SUMMARY.broughtBack });
  });

  it("S17: written manifests keep both combine parents and at most the allowed contents; first-seen times are recorded", async () => {
    const s = await pair(500);
    const { a, b } = s;
    await editCell(b, "mine");
    await editTitle(a, "Theirs");
    await a.ses.getState().save();
    await syncPair(s);
    await b.ses.getState().save();
    const m0 = headRev(s, "b");
    for (let n = 0; n < 25; n++) { await editCell(b, `v${n}`, 1); await b.ses.getState().save(); s.w.clock.advance(1000); }
    const m = b.dev.localFile(P)!.manifest;
    for (const p of m0.parents) expect(revisionOf(m, p)?.sections).not.toBeNull();
    const stored = m.revisions.filter((r) => r.sections).length;
    expect(m.revisions.length).toBeGreaterThan(25);
    expect(stored).toBeLessThanOrEqual(20 + 4);
    await tick(s.w, 3000);
    const seen = await b.dev.readSeen();
    const rec = seen.analyses[m.analysis_id];
    for (const r of m.revisions) expect(typeof rec[r.id]).toBe("number");
  });

  it("S18: a second Save during a combine gets the same outcome; an edit typed while it is written stays, unsaved", async () => {
    const s = await pair(500);
    const { a, b } = s;
    await editCell(b, "mine");
    await editTitle(a, "Theirs");
    await a.ses.getState().save();
    await syncPair(s);
    const orig = b.dev.save.bind(b.dev);
    let typed = false;
    b.dev.save = async (req) => {
      const res = await orig(req);
      if (!typed && req.manifest.revisions.find((r) => r.id === req.manifest.head)!.parents.length === 2) {
        typed = true;
        b.graph.getState().setCell(1, 0, 0, "typed while writing");
      }
      return res;
    };
    const [o1, o2] = await Promise.all([b.ses.getState().save(), b.ses.getState().save()]);
    expect(o1).toEqual(o2);
    expect(o1.ok).toBe(true);
    expect(typed).toBe(true);
    const merges = b.dev.saves.filter((x) => x.manifest.revisions.find((r) => r.id === x.manifest.head)!.parents.length === 2);
    expect(merges).toHaveLength(1);
    const m = headRev(s, "b");
    expect(activeTab(b)).toMatchObject({ baseRevision: m.id, dirty: true });
    expect(b.graph.getState().doc!.cells[1][0][0]).toBe("typed while writing");
    expect(cell(s, "b")).toBe("mine");
    expect(title(s, "b")).toBe("Theirs");
  });
});
