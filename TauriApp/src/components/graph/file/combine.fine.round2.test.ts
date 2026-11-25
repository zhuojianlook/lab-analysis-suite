// Phase 4, fixer round 2: the re-verify findings RV-1 (end to end), RV-2 and RV-3 on the session controller with
// two MemoryDevices on the ManualClock. Each case failed on the code before the fix.
import { describe, expect, it, vi } from "vitest";
import type { DocContent } from "../../../store/graphStore";
import { APPLY_READ_ONLY } from "./session";
import { PFILE as P, activeTab, combineState, computer, contentAt, editCellAt, makeWorld, seedFile, start, tick } from "./testkit";

vi.setConfig({ testTimeout: 60_000 });

/** "title: first value of column 1 | of column 2" for the first six rows. */
const rows = (c: DocContent | null) =>
  c!.doc.row_titles.map((t, i) => `${t}: ${c!.doc.cells[i].map((x) => x[0]).join(" | ")}`).slice(0, 6);
const EXPECTED = ["0 h: 1.02 | 0.98", "24 h: 1.85 | 1.21", "48 h: 3.12 | 1.52", "Mouse 7: 5 | ", "Mouse 9: 7 | 77", ":  | "];

/** A (Mac mini) and B (Alice's MacBook) both type a new entry into the blank row 4 of a grouped table; B saves
 *  first, A saves and gets the combine dialog (the two entries become two rows: B's moves to a new row). */
async function story() {
  const w = makeWorld("dropbox", undefined, { notes: false });
  const delay = 2000;
  const a = await start(await computer(w, { device_id: "d-a", device_name: "Mac mini", uploadDelayMs: delay, downloadDelayMs: delay }));
  const b = await start(await computer(w, { device_id: "d-b", device_name: "MacBook", user_name: "Alice", uploadDelayMs: delay, downloadDelayMs: delay }));
  await seedFile(w, a.dev, P, "grouped");
  await tick(w, 5000);
  expect((await a.ses.getState().open(P)).ok).toBe(true);
  expect((await b.ses.getState().open(P)).ok).toBe(true);
  const sync = () => tick(w, 2 * delay + 1000);
  b.graph.getState().setRowTitle(3, "Mouse 9"); await editCellAt(b, 3, 0, "7");
  a.graph.getState().setRowTitle(3, "Mouse 7"); await editCellAt(a, 3, 0, "5");
  expect((await b.ses.getState().save()).ok).toBe(true);
  await sync();
  expect(await a.ses.getState().save()).toEqual({ ok: false, reason: "conflict" });
  expect(a.ses.getState().dialog?.kind).toBe("combine");
  return { w, a, b, sync };
}

describe("RV-1 end to end: B keeps typing into its entry before the combined version reaches it", () => {
  for (const saveFirst of [false, true]) {
    it(`B's new value stays with B's entry on both computers (${saveFirst ? "B saves before" : "B saves after"} the combined version arrives)`, async () => {
      const { w, a, b, sync } = await story();
      expect((await a.ses.getState().applyCombine()).ok).toBe(true);
      expect(rows(contentAt(a.dev, P))).toEqual(["0 h: 1.02 | 0.98", "24 h: 1.85 | 1.21", "48 h: 3.12 | 1.52", "Mouse 7: 5 | ", "Mouse 9: 7 | ", ":  | "]);
      await editCellAt(b, 3, 1, "77");                    // B's row as B still sees it
      if (saveFirst) expect((await b.ses.getState().save()).ok).toBe(true);
      await sync(); await tick(w, 60_000);
      if (!saveFirst) expect((await b.ses.getState().save()).ok).toBe(true);
      await sync(); await tick(w, 300_000);
      expect(rows(contentAt(b.dev, P))).toEqual(EXPECTED);
      expect(rows(contentAt(a.dev, P))).toEqual(EXPECTED);
      expect(b.ses.getState().dialog).toBe(null);
      const doc = b.graph.getState().doc!;
      expect(doc.row_titles.slice(3, 5)).toEqual(["Mouse 7", "Mouse 9"]);
      expect(doc.cells[3].map((c) => c[0])).toEqual(["5", ""]);
      expect(doc.cells[4].map((c) => c[0])).toEqual(["7", "77"]);
    });
  }
});

describe("RV-2 Apply while the tab became read-only says why in the dialog", () => {
  it("another computer started editing while the dialog was open: nothing is written, a plain line in the dialog", async () => {
    const { a } = await story();
    const writes = a.dev.saves.length;
    a.graph.getState().setGuard({ reason: "editingElsewhere" });
    expect(await a.ses.getState().applyCombine()).toEqual({ ok: false, reason: "readOnly" });
    const d = a.ses.getState().dialog;
    expect(d?.kind).toBe("combine");
    expect(combineState(a)!.error).toBe(APPLY_READ_ONLY);
    expect(combineState(a)!.applying).toBe(false);
    expect(a.dev.saves.length).toBe(writes);
    // Once editing is possible again, Apply works and the line goes.
    a.graph.getState().setGuard(null);
    expect((await a.ses.getState().applyCombine()).ok).toBe(true);
    expect(a.ses.getState().dialog).toBe(null);
  });
});

describe("RV-3 both typed into the same blank row: shown as a row added on each side", () => {
  it("the side-by-side tables mark no changed cell in that row; the automatic list says 'Row added' for each", async () => {
    const { a } = await story();
    const s = combineState(a)!;
    const tab = activeTab(a);
    expect(tab).toBeTruthy();
    const R = s.mineContent.doc.row_ids![3];
    expect(s.theirsContent.doc.row_ids![3]).toBe(R);
    const table = s.sections.find((x) => x.key === "table")!;
    expect(table.rowNotes?.split).toEqual([R]);
    expect(s.compare.table.cells.filter((c) => c.rowId === R)).toEqual([]);
    expect(s.compare.table.changedCells).toBe(0);
    const added = table.auto.filter((x) => x.what === "rowAdded").map((x) => x.from);
    expect(added).toEqual(["mine", "theirs"]);
    expect(table.auto.filter((x) => x.rowId === R && x.what !== "rowAdded")).toEqual([]);
  });
});

describe("RV-1 / RV-3 in the dialog: both changed the same value of the moved row", () => {
  it("the question is about that row (with its own title on both sides), and the two tables line it up", async () => {
    const { w, a, b, sync } = await story();
    expect((await a.ses.getState().applyCombine()).ok).toBe(true);
    await editCellAt(b, 3, 1, "77");                       // B: its row as B still sees it (row 4)
    await editCellAt(a, 4, 1, "AA");                       // A: B's row in the combined version (row 5)
    expect((await a.ses.getState().save()).ok).toBe(true);
    await sync(); await tick(w, 10_000);
    const o = await b.ses.getState().save();
    expect(o).toEqual({ ok: false, reason: "conflict" });
    const s = combineState(b)!;
    const table = s.sections.find((x) => x.key === "table")!;
    const X = s.theirsContent.doc.row_ids![4];
    expect(table.conflicts.map((c) => c.id)).toEqual([`table:row:${X}`]);
    expect(table.rowNotes?.moved).toEqual([{ id: X, was: s.theirsContent.doc.row_ids![3], side: "mine" }]);
    // Shown under its new id on B's side too, so both tables have the row, and only the value to choose differs.
    expect(s.mineContent.doc.row_ids![3]).toBe(X);
    expect(s.compare.table.cells.map((c) => [c.rowId, c.a, c.b])).toEqual([[X, "AA", "77"]]);
    await b.ses.getState().setConflictChoice(`table:row:${X}`, "mine");
    expect((await b.ses.getState().applyCombine()).ok).toBe(true);
    expect(rows(contentAt(b.dev, P))).toEqual(EXPECTED);
  });
});
