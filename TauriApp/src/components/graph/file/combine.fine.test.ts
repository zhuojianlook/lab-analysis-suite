// Phase 4 controller (phase4-contract.md §5, checklist S1–S14): the combine procedure with the fine-level
// merge — automatic when nothing conflicts and nothing was adjusted, the mixed-version rule for combines
// nobody asked for, per-conflict choices in the dialog (nothing written until Apply), two-way whole choices,
// read-only tabs, combine_v on everything this build writes, and the older-app mode. MemoryDevices on the
// ManualClock.
import { describe, expect, it, vi } from "vitest";
import { isDirty, openContent, type DocContent } from "../../../store/graphStore";
import { ensureRows, insertRow, sampleDoc } from "../graphModel";
import { COMBINE_V, LIMITS_P3, SUMMARY, type CombineStateP4, type RevisionP4 } from "./contract";
import { buildNewFile, buildNextFile, fileAt, openFile, revisionOf, type Author } from "./docCodec";
import type { GraphFileData } from "./format";
import {
  DBX, PFILE as P, activeTab, authorFor, bannerOf, combineState, computer, contentAt, duplicateAutoCombines, duplicateCombines, editCell,
  editCellAt, editTitle, firstCell, flush, group, guardOf, headRev, insertRowAt, lostVersions, makeWorld, pair, pressBanner,
  scratchAt, seedFile, setScratchCells, shiftScratch, start, syncPair, tick, withAnswer, type Computer, type Pair, type TestDeps,
} from "./testkit";

vi.setConfig({ testTimeout: 60_000 });

const S = 1000;
const carl: Author = { user_name: "Carl", device_id: "d-c", device_name: "Lab PC", session_id: "s-c", app_version: "t", platform: "macos" };

/** Content in the stored form after an edit (rows padded as the editor keeps them). */
const stored = (c: DocContent): DocContent => openContent({ doc: ensureRows(c.doc), analysis: c.analysis, figure: c.figure, scratch: c.scratch });
const withCell = (r: number, col: number, v: string) => (c: DocContent): DocContent => {
  const cells = c.doc.cells.map((row) => row.map((reps) => [...reps]));
  cells[r][col][0] = v;
  return { ...c, doc: { ...c.doc, cells } };
};
const stamp = (f: GraphFileData, v: boolean): GraphFileData => (v
  ? { ...f, manifest: { ...f.manifest, revisions: f.manifest.revisions.map((r) => (r.id === f.manifest.head ? { ...r, combine_v: COMBINE_V } : r)) } }
  : f);

/** Another computer (Carl, d-c), working from the version BEFORE the file's head on `dev`, saves over it.
 *  `v`: made by a phase 4 app (with combine_v). */
async function saveOverFine(w: Pair["w"], dev: Computer["dev"], path: string, fn: (c: DocContent) => DocContent, v = true): Promise<string> {
  const f = dev.localFile(path)!;
  const parent = revisionOf(f.manifest, f.manifest.head)!.parents[0];
  const base = fileAt(f, parent)!;
  const next = stamp(await buildNextFile(base, stored(fn(openFile(base)!)), { time: w.clock.now(), author: carl }), v);
  w.forceReplace(path, next);
  return next.manifest.head;
}
/** Another computer saves a newer version on top of the file's head (synced in later). */
async function saveOnTop(w: Pair["w"], dev: Computer["dev"], path: string, fn: (c: DocContent) => DocContent, v = true): Promise<string> {
  const f = dev.localFile(path)!;
  const next = stamp(await buildNextFile(f, stored(fn(openFile(f)!)), { time: w.clock.now(), author: carl }), v);
  w.forceReplace(path, next);
  return next.manifest.head;
}

const cellOf = (c: Computer, r: number, col: number) => c.graph.getState().doc!.cells[r][col][0];
const st = (c: Computer): CombineStateP4 => {
  const s = combineState(c);
  if (!s) throw new Error(`no combine dialog (have ${c.ses.getState().dialog?.kind ?? "none"})`);
  return s;
};
const tableOf = (s: CombineStateP4) => s.sections.find((x) => x.key === "table")!;
const rowIds = (c: Computer) => c.graph.getState().doc!.row_ids;

/** Two computers, both clean on the seeded file; `a` saves a table edit; `b` reloads it. */
async function bothEditTable(s: Pair, bEdits: [number, number, string][], aEdits: [number, number, string][]) {
  for (const [r, col, v] of bEdits) await editCellAt(s.b, r, col, v);
  for (const [r, col, v] of aEdits) await editCellAt(s.a, r, col, v);
  await s.a.ses.getState().save();
  await syncPair(s);
  return s.a.dev.localHead(P)!;
}

describe("S1 different cells of one table: combined without asking", () => {
  it("Combine my changes with it: one two-parent version at once, both cells, banner with mixed, combine_v and auto", async () => {
    const s = await pair();
    const { a, b } = s;
    const theirs = await bothEditTable(s, [[0, 0, "mine"]], [[4, 1, "theirs"]]);
    expect(bannerOf(b, "newerOnDisk")).toMatchObject({ actions: ["combine", "later"], version: { head: theirs } });
    const saves = b.dev.saves.length;
    await pressBanner(b, "newerOnDisk", "combine");
    expect(b.ses.getState().dialog).toBeNull();
    expect(b.dev.saves.length).toBe(saves + 1);
    const m = headRev(b.dev, P)!;
    expect(m.parents).toHaveLength(2);
    expect(m.parents).toContain(theirs);
    expect(m).toMatchObject({ kind: "merge", auto: true, combine_v: COMBINE_V, summary: SUMMARY.combinedAuto, user_name: "" });
    expect(m.sections_from?.table).toBeUndefined();
    expect(cellOf(b, 0, 0)).toBe("mine");
    expect(cellOf(b, 4, 1)).toBe("theirs");
    expect(activeTab(b)).toMatchObject({ dirty: false, notSaved: false, baseRevision: m.id });
    expect(bannerOf(b, "combined")).toMatchObject({ sections: [], mixed: ["table"], actions: ["whatChanged", "undo"] });
    await syncPair(s);
    expect(a.dev.localHead(P)).toBe(m.id);
    expect(cellOf(a, 0, 0)).toBe("mine");
    expect(cellOf(a, 4, 1)).toBe("theirs");
    expect(isDirty(a.graph.getState())).toBe(false);
    expect(lostVersions(s.w)).toEqual([]);
    expect(duplicateCombines(s.w)).toEqual([]);
  });

  it("the same through Save; the working copy in the journal carries combine_v", async () => {
    const s = await pair();
    const { b } = s;
    await bothEditTable(s, [[0, 0, "mine"]], [[4, 1, "theirs"]]);
    expect(await b.ses.getState().save()).toEqual({ ok: true, path: P });
    expect(b.ses.getState().dialog).toBeNull();
    const c = contentAt(b.dev, P)!;
    expect(c.doc.cells[0][0][0]).toBe("mine");
    expect(c.doc.cells[4][1][0]).toBe("theirs");
    expect(headRev(b.dev, P)).toMatchObject({ auto: true, combine_v: 1 });
    expect(bannerOf(b, "combined")?.mixed).toEqual(["table"]);
    // My working version (the combine's other parent) is in the journal, with the rules' version.
    const m = headRev(b.dev, P)!;
    const mine = b.dev.journalCopies().filter((j) => m.parents.includes(j.manifest.head) && j.manifest.head !== s.a.dev.localHead(P));
    expect(mine.length).toBeGreaterThan(0);
    for (const j of mine) expect((revisionOf(j.manifest, j.manifest.head) as RevisionP4).combine_v).toBe(COMBINE_V);
  });
});

describe("S2 the same cell: one row to choose, nothing written until Apply", () => {
  it("toChoose 1, table:row:<id>, canApply false; theirs → their value and my other edit; Apply writes once (author me, no auto)", async () => {
    const s = await pair();
    const { b } = s;
    const theirs = await bothEditTable(s, [[0, 0, "B!"], [3, 2, "other"]], [[0, 0, "A!"]]);
    const saves = b.dev.saves.length;
    expect(await b.ses.getState().save()).toEqual({ ok: false, reason: "conflict" });
    const d = st(b);
    expect(d.toChoose).toBe(1);
    expect(d.canApply).toBe(false);
    expect(d.resultContent).toBeNull();
    const t = tableOf(d);
    expect(t).toMatchObject({ status: "both", level: "fine", left: 1, choice: null });
    expect(t.conflicts.map((c) => c.id)).toEqual([`table:row:${rowIds(b)[0]}`]);
    expect(t.conflicts[0].items).toEqual([expect.objectContaining({ what: "cell", mine: "B!", theirs: "A!", rep: 0 })]);
    const writes = b.dev.saves.length;
    expect(b.dev.localHead(P)).toBe(theirs);
    await b.ses.getState().setConflictChoice(t.conflicts[0].id, "theirs");
    const d2 = st(b);
    expect(d2).toMatchObject({ toChoose: 0, canApply: true });
    expect(tableOf(d2).choices).toEqual({ [t.conflicts[0].id]: "theirs" });
    expect(d2.resultContent!.doc.cells[0][0][0]).toBe("A!");
    expect(d2.resultContent!.doc.cells[3][2][0]).toBe("other");
    expect(b.dev.saves.length).toBe(writes);
    expect(b.dev.localHead(P)).toBe(theirs);
    // An option the conflict doesn't have is ignored.
    await b.ses.getState().setConflictChoice(t.conflicts[0].id, "both");
    expect(tableOf(st(b)).choices).toEqual({ [t.conflicts[0].id]: "theirs" });
    expect((await b.ses.getState().applyCombine()).ok).toBe(true);
    expect(b.dev.saves.length).toBe(saves + 2);       // the refused save, then the combine
    expect(b.ses.getState().dialog).toBeNull();
    const m = headRev(b.dev, P)!;
    expect(m).toMatchObject({ kind: "merge", user_name: "Alice", summary: SUMMARY.combinedChosen, combine_v: 1 });
    expect(m.auto).toBeUndefined();
    expect(cellOf(b, 0, 0)).toBe("A!");
    expect(cellOf(b, 3, 2)).toBe("other");
    expect(bannerOf(b, "combined")?.mixed).toEqual(["table"]);
    expect(lostVersions(s.w)).toEqual([]);
  });

  it("Cancel writes nothing and leaves 'Not saved'; Choose… reopens it with the choice kept (fixer VUX-3)", async () => {
    const s = await pair();
    const { b } = s;
    const theirs = await bothEditTable(s, [[0, 0, "B!"]], [[0, 0, "A!"]]);
    await b.ses.getState().save();
    await b.ses.getState().setConflictChoice(tableOf(st(b)).conflicts[0].id, "mine");
    const writes = b.dev.saves.length;
    b.ses.getState().cancelCombine();
    expect(b.ses.getState().dialog).toBeNull();
    expect(b.dev.saves.length).toBe(writes);
    expect(b.dev.localHead(P)).toBe(theirs);
    expect(activeTab(b)).toMatchObject({ notSaved: true, dirty: true });
    await pressBanner(b, "notSaved", "choose");
    expect(st(b).toChoose).toBe(0);
    expect(tableOf(st(b)).choices).toEqual({ [tableOf(st(b)).conflicts[0].id]: "mine" });
    expect(st(b).canApply).toBe(true);
    expect(b.dev.saves.length).toBe(writes);
  });
});

describe("S3 use mine / theirs for all, whole-section choice", () => {
  it("setAllInSection sets every conflict; setSectionChoice takes theirs' whole table; a conflict choice removes it again", async () => {
    const s = await pair();
    const { b } = s;
    await bothEditTable(s, [[0, 0, "b0"], [1, 1, "b1"], [2, 2, "b2"], [6, 0, "only mine"]], [[0, 0, "a0"], [1, 1, "a1"], [2, 2, "a2"], [7, 1, "only theirs"]]);
    await b.ses.getState().save();
    const t = tableOf(st(b));
    expect(t.conflicts).toHaveLength(3);
    expect(st(b).toChoose).toBe(3);
    await b.ses.getState().setAllInSection("table", "mine");
    expect(st(b).toChoose).toBe(0);
    const r = st(b).resultContent!.doc.cells;
    expect([r[0][0][0], r[1][1][0], r[2][2][0], r[6][0][0], r[7][1][0]]).toEqual(["b0", "b1", "b2", "only mine", "only theirs"]);
    expect(st(b).combinedCount).toBeGreaterThanOrEqual(2);
    await b.ses.getState().setSectionChoice("table", "theirs");
    const w = st(b);
    expect(tableOf(w)).toMatchObject({ choice: "theirs", left: 0 });
    expect(w.resultContent!.doc.cells[6][0][0]).toBe(st(b).theirsContent.doc.cells[6][0][0]);
    expect(w.resultContent!.doc.cells[0][0][0]).toBe("a0");
    await b.ses.getState().setConflictChoice(t.conflicts[1].id, "theirs");
    const x = st(b);
    expect(tableOf(x).choice).toBeNull();
    expect(x.toChoose).toBe(0);
    const c = x.resultContent!.doc.cells;
    expect([c[0][0][0], c[1][1][0], c[2][2][0], c[6][0][0], c[7][1][0]]).toEqual(["b0", "a1", "b2", "only mine", "only theirs"]);
    expect((await b.ses.getState().applyCombine()).ok).toBe(true);
    expect([cellOf(b, 0, 0), cellOf(b, 1, 1), cellOf(b, 2, 2)]).toEqual(["b0", "a1", "b2"]);
  });
});

describe("S4–S7 combines nobody asked for (clean tab)", () => {
  async function replaced(fn: (c: DocContent) => DocContent, v: boolean, deps: TestDeps = {}) {
    const s = await pair(2000, "lww", { depsA: deps });
    await editCell(s.a, "my save");
    await s.a.ses.getState().save();
    const mine = s.a.dev.localHead(P)!;
    await syncPair(s);
    const t0 = s.w.clock.now();
    const theirs = await saveOverFine(s.w, s.a.dev, P, fn, v);
    return { s, mine, theirs, t0, writes: s.a.dev.written.length };
  }

  it("S4 both phase 4: 'combining', nothing before the delay, then one automatic combine with both cells", async () => {
    const { s, mine, theirs, t0, writes } = await replaced(withCell(4, 1, "theirs"), true);
    const { a } = s;
    await tick(s.w, 2100);
    expect(bannerOf(a, "savedOver")).toMatchObject({ state: "combining", actions: [] });
    await tick(s.w, t0 + 2000 + 5400 - s.w.clock.now());
    expect(a.dev.written.length).toBe(writes);
    await tick(s.w, 1000);
    const m = headRev(a.dev, P)!;
    expect(m.parents.sort()).toEqual([mine, theirs].sort());
    expect(m).toMatchObject({ auto: true, combine_v: 1, summary: SUMMARY.combinedAuto });
    expect(cellOf(a, 0, 0)).toBe("my save");
    expect(cellOf(a, 4, 1)).toBe("theirs");
    expect(bannerOf(a, "savedOver")).toBeNull();
    expect(bannerOf(a, "combined")).toMatchObject({ mixed: ["table"], sections: [] });
    await syncPair(s);
    await syncPair(s);
    expect(s.b.dev.localHead(P)).toBe(m.id);
    expect(duplicateCombines(s.w)).toEqual([]);
    expect(lostVersions(s.w)).toEqual([]);
  });

  it("S5 the other version has no combine_v: 'review', no write however long; Combine writes it at once without a dialog", async () => {
    const { s, mine, theirs, writes } = await replaced(withCell(4, 1, "theirs"), false);
    const { a } = s;
    await tick(s.w, 120 * S);
    // Fixer VUX-9: the review banner cannot be closed (the file does not hold my save until it is combined).
    expect(bannerOf(a, "savedOver")).toMatchObject({ state: "review", actions: ["combine"], dismissible: false });
    expect(activeTab(a).combining).toBeFalsy();
    expect(a.dev.written.length).toBe(writes);
    await pressBanner(a, "savedOver", "combine");
    expect(a.ses.getState().dialog).toBeNull();
    expect(a.dev.written.length).toBe(writes + 1);
    const m = headRev(a.dev, P)!;
    expect(m.parents.sort()).toEqual([mine, theirs].sort());
    expect(m.combine_v).toBe(1);
    expect(cellOf(a, 0, 0)).toBe("my save");
    expect(cellOf(a, 4, 1)).toBe("theirs");
    expect(bannerOf(a, "savedOver")).toBeNull();
  });

  it("S5 different sections against an older app's version: combined by itself (the result is the older rules')", async () => {
    const { s, mine, theirs } = await replaced((c) => ({ ...c, figure: { ...c.figure, title: "theirs" } }), false);
    await tick(s.w, 15 * S);
    const m = headRev(s.a.dev, P)!;
    expect(m.parents.sort()).toEqual([mine, theirs].sort());
    expect(m.auto).toBe(true);
  });

  it("S6 something adjusted: 'review', nothing written; Combine opens the dialog with it listed and Apply enabled", async () => {
    const s = await pair(2000, "lww");
    const { a } = s;
    const ids = a.graph.getState().doc!.col_ids;
    a.graph.getState().deleteCol(2);
    await flush();
    await a.ses.getState().save();
    await syncPair(s);
    const theirs = await saveOverFine(s.w, a.dev, P, (c) => ({ ...c, analysis: { ...c.analysis, pairs: [[0, 2]] } }));
    const writes = a.dev.written.length;
    await tick(s.w, 60 * S);
    const f = s.w.devices[0].localFile(P)!;
    const tr = revisionOf(f.manifest, theirs)!;
    expect((JSON.parse(f.parts[tr.sections!.analysis.part]) as { pairs: string[][] }).pairs).toEqual([[ids[0], ids[2]]]);
    expect(bannerOf(a, "savedOver")).toMatchObject({ state: "review" });
    expect(a.dev.written.length).toBe(writes);
    await pressBanner(a, "savedOver", "combine");
    const d = st(a);
    expect(d.toChoose).toBe(0);
    expect(d.canApply).toBe(true);
    expect(d.adjustments.some((x) => x.section === "analysis" && x.field === "pairs")).toBe(true);
    expect(a.dev.written.length).toBe(writes);
    expect((await a.ses.getState().applyCombine()).ok).toBe(true);
    expect(a.dev.written.length).toBe(writes + 1);
  });

  it("S6 an order to check (XY, rows inserted at the top on both): 'review'; the dialog shows the order check", async () => {
    const w = makeWorld("lww");
    const a = await start(await computer(w, { device_id: "d-a", device_name: "Mac mini", uploadDelayMs: 500, downloadDelayMs: 500 }));
    await seedFile(w, a.dev, P, "xy");
    await tick(w, 1500);
    expect((await a.ses.getState().open(P)).ok).toBe(true);
    await insertRowAt(a, 0);
    a.graph.getState().setX(0, "0.5");
    a.graph.getState().setCell(0, 0, 0, "3");
    await flush();
    await a.ses.getState().save();
    await tick(w, 1500);
    await saveOverFine(w, a.dev, P, (c) => {
      const doc = insertRow(c.doc, 0);
      return { ...c, doc: { ...doc, x: doc.x.map((v, i) => (i === 0 ? "0.7" : v)), cells: doc.cells.map((row, i) => (i === 0 ? row.map(() => ["4"]) : row)) } };
    });
    const writes = a.dev.written.length;
    await tick(w, 60 * S);
    expect(bannerOf(a, "savedOver")).toMatchObject({ state: "review" });
    expect(a.dev.written.length).toBe(writes);
    await pressBanner(a, "savedOver", "combine");
    const d = st(a);
    expect(d).toMatchObject({ toChoose: 0, canApply: true });
    expect(tableOf(d).orderChecks).toEqual([expect.objectContaining({ axis: "row", matters: true })]);
    expect(tableOf(d).orderChecks[0].ids).toHaveLength(2);
    expect(a.dev.written.length).toBe(writes);
  });

  it("S7 a conflict: 'choose', nothing written", async () => {
    const { s, writes } = await replaced(withCell(0, 0, "theirs"), true);
    await tick(s.w, 60 * S);
    expect(bannerOf(s.a, "savedOver")).toMatchObject({ state: "choose", actions: ["combine"] });
    expect(s.a.dev.written.length).toBe(writes);
    await pressBanner(s.a, "savedOver", "combine");
    expect(st(s.a).toChoose).toBe(1);
    expect(s.a.dev.written.length).toBe(writes);
  });
});

describe("S8 edits while the dialog is open", () => {
  it("typing in another cell keeps the choices and is written with the combine", async () => {
    const s = await pair();
    const { b } = s;
    await bothEditTable(s, [[0, 0, "B!"]], [[0, 0, "A!"]]);
    await b.ses.getState().save();
    await b.ses.getState().setConflictChoice(tableOf(st(b)).conflicts[0].id, "theirs");
    await editCellAt(b, 7, 1, "typed");
    expect((await b.ses.getState().applyCombine()).ok).toBe(true);
    expect(b.ses.getState().dialog).toBeNull();
    const c = contentAt(b.dev, P)!;
    expect(c.doc.cells[0][0][0]).toBe("A!");
    expect(c.doc.cells[7][1][0]).toBe("typed");
  });

  it("typing in the cell I chose for: the dialog stays with the new state, nothing is written", async () => {
    const s = await pair();
    const { b } = s;
    const theirs = await bothEditTable(s, [[0, 0, "B!"]], [[0, 0, "A!"]]);
    await b.ses.getState().save();
    const id = tableOf(st(b)).conflicts[0].id;
    await b.ses.getState().setConflictChoice(id, "theirs");
    await editCellAt(b, 0, 0, "B2");
    const writes = b.dev.saves.length;
    const out = await b.ses.getState().applyCombine();
    expect(out.ok).toBe(false);
    expect(b.dev.saves.length).toBe(writes);
    expect(b.dev.localHead(P)).toBe(theirs);
    const d = st(b);
    expect(d.applying).toBe(false);
    expect(tableOf(d).conflicts[0].items[0]).toMatchObject({ mine: "B2", theirs: "A!" });
    expect(d.toChoose).toBe(1);
    await b.ses.getState().setConflictChoice(id, "mine");
    expect((await b.ses.getState().applyCombine()).ok).toBe(true);
    expect(firstCell(contentAt(b.dev, P))).toBe("B2");
  });
});

describe("S9 the scratchpad", () => {
  // No notes: edits on both computers at nearly the same time (with notes the second one is read-only).
  it("different cells → combined on Save; the same cell → a cell to choose", async () => {
    const s = await pair(2000, "dropbox", { notes: false });
    const { a, b } = s;
    await setScratchCells(b, [[2, 2, "mine"]]);
    await setScratchCells(a, [[3, 3, "theirs"]]);
    await a.ses.getState().save();
    await syncPair(s);
    expect((await b.ses.getState().save()).ok).toBe(true);
    const c = contentAt(b.dev, P)!;
    expect([scratchAt(c, 2, 2), scratchAt(c, 3, 3)]).toEqual(["mine", "theirs"]);
    expect(bannerOf(b, "combined")?.mixed).toEqual(["scratchpad"]);
    await syncPair(s);
    await setScratchCells(b, [[2, 2, "b again"]]);
    await setScratchCells(a, [[2, 2, "a again"]]);
    await a.ses.getState().save();
    await syncPair(s);
    expect(await b.ses.getState().save()).toEqual({ ok: false, reason: "conflict" });
    const d = st(b);
    const sp = d.sections.find((x) => x.key === "scratchpad")!;
    expect(sp.conflicts.map((x) => x.id)).toEqual(["scratchpad:cell:B2"]);
    expect(d.toChoose).toBe(1);
  });

  it("a rearranged sheet on the other side: the whole choice with 'both'; Both writes mine in place and theirs to the right", async () => {
    const s = await pair(2000, "dropbox", { notes: false });
    const { a, b } = s;
    const fill: [number, number, string][] = [];
    for (let r = 1; r <= 6; r++) for (let col = 1; col <= 2; col++) fill.push([r, col, String(r * 10 + col)]);
    await setScratchCells(a, fill);
    await a.ses.getState().save();
    await syncPair(s);
    await setScratchCells(b, [[1, 1, "mine A1"]]);
    await shiftScratch(a, 1, [[1, 1, "Inserted"]]);
    await a.ses.getState().save();
    await syncPair(s);
    expect(await b.ses.getState().save()).toEqual({ ok: false, reason: "conflict" });
    const sp = st(b).sections.find((x) => x.key === "scratchpad")!;
    expect(sp.level).toBe("whole");
    expect(sp.conflicts).toEqual([expect.objectContaining({ id: "scratchpad:section", kind: "section", reason: "shift", options: ["mine", "theirs", "both"] })]);
    await b.ses.getState().setConflictChoice("scratchpad:section", "both");
    expect(st(b).canApply).toBe(true);
    expect((await b.ses.getState().applyCombine()).ok).toBe(true);
    const c = contentAt(b.dev, P)!;
    expect(scratchAt(c, 1, 1)).toBe("mine A1");
    expect(scratchAt(c, 6, 2)).toBe("62");
    // Theirs starts at column D (mine ends at B, one blank column between).
    expect(scratchAt(c, 1, 4)).toBe("Inserted");
    expect(scratchAt(c, 2, 4)).toBe("11");
    expect(scratchAt(c, 7, 5)).toBe("62");
    expect(bannerOf(b, "combined")?.mixed).toEqual(["scratchpad"]);
  });
});

describe("S10 two-way", () => {
  it("no stored common version: every differing part one whole choice; Keep both as separate files", async () => {
    const s = await pair();
    const { a, b } = s;
    await editCellAt(b, 0, 0, "mine");
    await editTitle(b, "My title");
    // A file of the same analysis with an unrelated history (no common version anywhere).
    const aid = a.dev.localFile(P)!.manifest.analysis_id;
    const c0 = openContent({ doc: sampleDoc("column") });
    const other = await buildNewFile({ content: stored({ ...withCell(0, 0, "other")(c0), figure: { ...c0.figure, title: "Their title" } }), analysisId: aid, forkedFrom: null, time: s.w.clock.now(), author: carl });
    s.w.forceReplace(P, stamp(other, true));
    await syncPair(s);
    expect(await b.ses.getState().save()).toEqual({ ok: false, reason: "conflict" });
    const d = st(b);
    expect(d.twoWay).toBe(true);
    for (const x of d.sections) {
      if (x.status === "same") continue;
      expect(x.level).toBe("whole");
      expect(x.conflicts.map((k) => [k.id, k.reason])).toEqual([[`${x.key}:section`, "twoWay"]]);
    }
    expect(d.toChoose).toBe(d.sections.filter((x) => x.status !== "same").length);
    b.picks.push(`${DBX}/Mine`);
    await b.ses.getState().keepBothAsSeparate();
    const mine = `${DBX}/Mine.lag`;
    expect(activeTab(b)).toMatchObject({ path: mine, dirty: false, notSaved: false });
    expect(firstCell(contentAt(b.dev, mine))).toBe("mine");
    expect(headRev(b.dev, mine)!.combine_v).toBe(COMBINE_V);
    expect(b.dev.localHead(P)).toBe(other.manifest.head);
    expect(lostVersions(s.w)).toEqual([]);
  });
});

describe("S11 read-only tabs", () => {
  it("a read-only tab refuses to combine; its unprompted fine combine waits until the guard clears", async () => {
    const g = await group(2, { delay: 500, users: ["Alice", "Zhuo"] });
    const [a, b] = g.cs;
    await editCell(b, "B1");
    await b.ses.getState().save();
    await tick(g.w, LIMITS_P3.lingerMs + 5 * S);
    a.graph.getState().setFigure({ title: "A editing" });
    await flush();
    await tick(g.w, 3 * S);
    expect(guardOf(b)).toBe("editingElsewhere");
    const key = activeTab(b).key;
    const at0 = activeTab(b).presence!.attempt;
    await b.ses.getState().startCombine(key, { kind: "disk" });
    expect(activeTab(b).presence!.attempt).toBe(at0 + 1);
    // Carl (a phase 4 app) saves over B's last save from the version before it: another cell of the table.
    await saveOverFine(g.w, b.dev, g.path, withCell(5, 1, "carl"));
    const written = b.dev.written.length;
    await tick(g.w, 60 * S);
    expect(guardOf(b)).toBe("editingElsewhere");
    expect(b.dev.written.length).toBe(written);
    expect(bannerOf(b, "savedOver")).toMatchObject({ state: "combining" });
    await withAnswer(a, () => a.ses.getState().closeTab(), { kind: "closeDirty", choice: "discard" });
    await tick(g.w, 20 * S);
    expect(guardOf(b)).toBe(null);
    expect(b.dev.written.length).toBe(written + 1);
    const m = headRev(b.dev, g.path)!;
    expect(m.parents).toHaveLength(2);
    expect(m.combine_v).toBe(1);
    const c = contentAt(b.dev, g.path)!;
    expect(c.doc.cells[0][0][0]).toBe("B1");
    expect(c.doc.cells[5][1][0]).toBe("carl");
  });
});

describe("S12 combine_v on everything this build writes", () => {
  it("save, bring back, Save As new, combine; a version already in the file is untouched; an unknown field survives", async () => {
    const s = await pair(500);
    const { a, b } = s;
    const f = a.dev.localFile(P)!;
    const root = f.manifest.revisions[0];
    expect((root as RevisionP4).combine_v).toBeUndefined();
    s.w.forceReplace(P, { ...f, manifest: { ...f.manifest, revisions: [{ ...root, zz: 1 } as typeof root] } });
    await syncPair(s);
    for (const c of [a, b]) { await c.ses.getState().closeTab(); await c.ses.getState().open(P); await flush(); }
    await editCellAt(a, 0, 0, "A");
    await a.ses.getState().save();
    expect(headRev(a.dev, P)!.combine_v).toBe(1);
    await editCellAt(b, 4, 1, "B");
    await syncPair(s);
    expect((await b.ses.getState().save()).ok).toBe(true);
    const m = headRev(b.dev, P)!;
    expect(m.parents).toHaveLength(2);
    expect(m.combine_v).toBe(1);
    for (const r of b.dev.localFile(P)!.manifest.revisions) if (r.id !== root.id) expect((r as RevisionP4).combine_v).toBe(1);
    expect((await b.ses.getState().bringBack(root.id)).ok).toBe(true);
    const mm = b.dev.localFile(P)!.manifest;
    expect(revisionOf(mm, mm.head)).toMatchObject({ kind: "restore", combine_v: 1 });
    expect(mm.revisions.find((r) => r.id === root.id)).toEqual({ ...root, zz: 1 });
    b.picks.push(`${DBX}/Elsewhere`);
    expect((await b.ses.getState().saveAs("new")).ok).toBe(true);
    expect(headRev(b.dev, `${DBX}/Elsewhere.lag`)!.combine_v).toBe(1);
  });
});

describe("S13 playing an older app (combineLevel 'section')", () => {
  const old: TestDeps = { combineLevel: "section" };

  it("different cells of one table still need a whole-table choice; nothing it writes has combine_v", async () => {
    const s = await pair(2000, "dropbox", { depsA: old, depsB: old });
    const { b } = s;
    await bothEditTable(s, [[0, 0, "mine"]], [[4, 1, "theirs"]]);
    expect(headRev(s.a.dev, P)!.combine_v).toBeUndefined();
    expect(await b.ses.getState().save()).toEqual({ ok: false, reason: "conflict" });
    const d = st(b);
    expect(tableOf(d)).toMatchObject({ status: "both", choice: null, conflicts: [] });
    expect(d.canApply).toBe(false);
    await b.ses.getState().setSectionChoice("table", "theirs");
    expect(st(b).canApply).toBe(true);
    expect((await b.ses.getState().applyCombine()).ok).toBe(true);
    const m = headRev(b.dev, P)!;
    expect(m.parents).toHaveLength(2);
    expect("combine_v" in m).toBe(false);
    expect(cellOf(b, 4, 1)).toBe("theirs");
    for (const r of b.dev.localFile(P)!.manifest.revisions) expect((r as RevisionP4).combine_v).toBeUndefined();
    for (const j of b.dev.journalCopies()) for (const r of j.manifest.revisions) expect((r as RevisionP4).combine_v).toBeUndefined();
  });

  it("phase 2 S5: different sections combine by themselves after the delay; the same section → 'choose' (not 'review')", async () => {
    const s = await pair(2000, "lww", { depsA: old });
    const { a } = s;
    await editCell(a, "my save");
    await a.ses.getState().save();
    await syncPair(s);
    await saveOverFine(s.w, a.dev, P, (c) => ({ ...c, figure: { ...c.figure, title: "theirs" } }), false);
    await tick(s.w, 15 * S);
    const m = headRev(a.dev, P)!;
    expect(m).toMatchObject({ auto: true });
    expect("combine_v" in m).toBe(false);
    await syncPair(s);
    await editCellAt(a, 4, 1, "again");
    await a.ses.getState().save();
    await syncPair(s);
    await saveOverFine(s.w, a.dev, P, withCell(6, 2, "other cell"), false);
    const writes = a.dev.written.length;
    await tick(s.w, 30 * S);
    expect(bannerOf(a, "savedOver")).toMatchObject({ state: "choose" });
    expect(a.dev.written.length).toBe(writes);
  });

  it("phase 2 S6: two clean computers, the shorter delay writes, the other writes nothing", async () => {
    const s = await pair(500, "lww", { notes: false, depsA: old, depsB: old });
    const { a, b } = s;
    await editCell(a, "X");
    await a.ses.getState().save();
    await syncPair(s);
    await saveOverFine(s.w, a.dev, P, (c) => ({ ...c, figure: { ...c.figure, title: "Y" } }), false);
    const wa = a.dev.written.length, wb = b.dev.written.length;
    await tick(s.w, 30 * S);
    expect(b.dev.written.length).toBe(wb + 1);
    expect(a.dev.written.length).toBe(wa);
    expect(a.dev.localHead(P)).toBe(b.dev.localHead(P));
    expect(duplicateCombines(s.w)).toEqual([]);
    expect(duplicateAutoCombines(s.w)).toEqual([]);
  });
});

describe("S1 undo after a fine combine", () => {
  it("Undo brings my version from before the combine back", async () => {
    const s = await pair();
    const { b } = s;
    await bothEditTable(s, [[0, 0, "mine"]], [[4, 1, "theirs"]]);
    await pressBanner(b, "newerOnDisk", "combine");
    expect(b.graph.getState().undoLabel()).toMatch(/^Undo: combine with /);
    await pressBanner(b, "combined", "undo");
    expect(firstCell(contentAt(b.dev, P))).toBe("mine");
    expect(contentAt(b.dev, P)!.doc.cells[4][1][0]).not.toBe("theirs");
    expect(headRev(b.dev, P)).toMatchObject({ kind: "restore", combine_v: 1 });
  });
});
