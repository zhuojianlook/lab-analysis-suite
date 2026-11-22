import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LIMITS_P2, SUMMARY, type RevisionP2 } from "./contract";
import type { FileSections4 } from "./docCodec";
import { changedSections, compareSections, displaySummary, sectionList, summaryText } from "./summaries";
import { clone, countingIds, sampleSections } from "./fixtures-p2/docs";
import { refs, rev } from "./fixtures-p2/kit";

let restoreIds: () => void;
beforeAll(() => { restoreIds = countingIds(); });
afterAll(() => restoreIds());

const P = refs("t0", "a0", "f0", "s0");

describe("M16 summaries", () => {
  it("sectionList", () => {
    expect(sectionList([])).toBe("");
    expect(sectionList(["figure"])).toBe("the graph");
    expect(sectionList(["figure", "table"])).toBe("the table and the graph");
    expect(sectionList(["figure", "analysis", "table"])).toBe("the table, the analysis settings and the graph");
    expect(sectionList(["scratchpad", "figure", "analysis", "table", "table"])).toBe("the table, the analysis settings, the graph and the scratchpad");
  });

  it("changedSections in section order", () => {
    expect(changedSections(P, refs("t1", "a0", "f1", "s0"))).toEqual(["table", "figure"]);
    expect(changedSections(P, P)).toEqual([]);
  });

  it("every row of the summaryText table", () => {
    const base = { root: false, prev: P, next: refs("t1") };
    expect(summaryText({ ...base, kind: "import" })).toBe("From the old library");
    expect(summaryText({ ...base, kind: "restore" })).toBe("Brought back an earlier version");
    expect(summaryText({ ...base, kind: "merge", auto: true })).toBe("Combined changes from two computers");
    expect(summaryText({ ...base, kind: "merge" })).toBe("Combined two versions");
    expect(summaryText({ ...base, kind: "save", root: true })).toBe("First version");
    expect(summaryText({ ...base, kind: "save", prev: null })).toBe("Saved");
    expect(summaryText({ ...base, kind: "save", prev: undefined })).toBe("Saved");
    expect(summaryText({ ...base, kind: "save", next: P })).toBe("No changes");
    expect(summaryText({ ...base, kind: "save" })).toBe("Changed the table");
    expect(summaryText({ ...base, kind: "save", next: refs("t1", "a0", "f1") })).toBe("Changed the table and the graph");
    expect(summaryText({ ...base, kind: "save", next: refs("t1", "a1", "f1") })).toBe("Changed the table, the analysis settings and the graph");
    // Import / restore / merge win over root.
    expect(summaryText({ ...base, kind: "import", root: true })).toBe(SUMMARY.imported);
  });

  it("displaySummary", () => {
    const parent = rev("r-p", [], { sections: P });
    // Worked out from the two versions when both have content (whatever is stored).
    expect(displaySummary(rev("r-c", ["r-p"], { sections: refs("t0", "a0", "f9"), summary: "Changed data." }), parent)).toBe("Changed the graph");
    expect(displaySummary(rev("r-c", ["r-p"], { sections: P, summary: "x" }), parent)).toBe("No changes");
    // A phase 1 summary is shown as stored, without the full stop, when it can't be worked out.
    expect(displaySummary(rev("r-c", ["r-p"], { summary: "Changed data, graph." }), { ...parent, sections: null })).toBe("Changed data, graph");
    expect(displaySummary(rev("r-c", ["r-p"], { summary: "Saved.", sections: null }), parent)).toBe("Saved");
    expect(displaySummary(rev("r-c", ["r-p"], { summary: "" }), null)).toBe(SUMMARY.saved);
    expect(displaySummary(rev("r-c", ["r-p"], { summary: "  " }), null)).toBe(SUMMARY.saved);
    // Root.
    expect(displaySummary(rev("r-p", [], { summary: "Saved." }), null)).toBe(SUMMARY.first);
    // Kinds.
    expect(displaySummary(rev("r-i", [], { kind: "import", summary: "Imported." }), null)).toBe(SUMMARY.imported);
    expect(displaySummary(rev("r-b", ["r-p"], { kind: "restore" }), parent)).toBe(SUMMARY.broughtBack);
    const auto = { ...rev("r-m-1", ["r-a", "r-b"]), auto: true } as RevisionP2;
    expect(displaySummary(auto, parent)).toBe(SUMMARY.combinedAuto);
    // A phase 1 "Keep mine" (kind merge, no auto) → chosen.
    expect(displaySummary(rev("r-m-2", ["r-a", "r-b"], { kind: "merge", summary: "Kept my version." }), parent)).toBe(SUMMARY.combinedChosen);
    // A separate analysis made from this one keeps saying so.
    expect(displaySummary(rev("r-s", ["r-p"], { sections: P, summary: SUMMARY.separated }), parent)).toBe(SUMMARY.separated);
  });
});

describe("M17 compareSections", () => {
  const base = () => clone(sampleSections("grouped")) as unknown as FileSections4;
  type Tbl = { cells: string[][][]; row_ids: string[]; col_ids: string[]; row_titles: string[]; col_titles: string[]; x: string[]; n_rep: number };

  it("identical → everything same, nothing counted", () => {
    const a = base();
    const c = compareSections(a, clone(a));
    expect(c.sections.map((s) => s.same)).toEqual([true, true, true, true]);
    expect(c.table).toEqual({ changedCells: 0, addedRows: 0, removedRows: 0, addedCols: 0, removedCols: 0, changedTitles: 0, cells: [] });
    expect(c.settings).toEqual([]);
    expect(c.scratchpadCells).toBe(0);
  });

  it("changed cells by id, in the table order of b; titles; added / removed rows and columns", () => {
    const a = base();
    const b = clone(a);
    const tb = b.table as unknown as Tbl, ta = a.table as unknown as Tbl;
    tb.cells[2][1][0] = "99";
    tb.cells[0][0][2] = "7";
    tb.row_titles[1] = "12 h";
    tb.col_titles[0] = "Wild type";
    // Reorder b's rows 0 and 2: matched by id, so no extra changes.
    for (const k of ["cells", "row_ids", "row_titles", "x"] as const) {
      const arr = tb[k] as unknown[];
      [arr[0], arr[2]] = [arr[2], arr[0]];
    }
    // b adds a row, removes the last row; adds a column.
    tb.cells.push([["1", "", ""], ["", "", ""]]);
    tb.row_ids.push("row-new00001");
    tb.row_titles.push("");
    tb.x.push("");
    const removedRow = tb.row_ids.length - 2;
    for (const k of ["cells", "row_ids", "row_titles", "x"] as const) (tb[k] as unknown[]).splice(removedRow, 1);
    tb.col_ids.push("col-new00001");
    tb.col_titles.push("Het");
    for (const row of tb.cells) row.push(["", "", ""]);
    const c = compareSections(a, b);
    expect(c.sections.find((s) => s.key === "table")!.same).toBe(false);
    expect(c.sections.filter((s) => s.key !== "table").every((s) => s.same)).toBe(true);
    expect(c.table.changedCells).toBe(2);
    // b's order: its row 0 is a's row 2.
    expect(c.table.cells).toEqual([
      { rowId: ta.row_ids[2], colId: ta.col_ids[1], rep: 0, a: ta.cells[2][1][0], b: "99" },
      { rowId: ta.row_ids[0], colId: ta.col_ids[0], rep: 2, a: ta.cells[0][0][2], b: "7" },
    ]);
    expect(c.table.addedRows).toBe(1);
    expect(c.table.removedRows).toBe(1);
    expect(c.table.addedCols).toBe(1);
    expect(c.table.removedCols).toBe(0);
    expect(c.table.changedTitles).toBe(2);
  });

  it("lists at most LIMITS_P2.compareCells cells but counts them all", () => {
    const a = clone(sampleSections("column")) as unknown as FileSections4;
    const b = clone(a);
    const tb = b.table as unknown as Tbl;
    while (tb.cells.length < 120) {
      tb.cells.push([[""], [""], [""]]);
      tb.row_ids.push(`row-x${String(tb.cells.length).padStart(6, "0")}`);
      tb.row_titles.push("");
      tb.x.push("");
    }
    const a2 = clone(b);
    for (const row of tb.cells) for (const cell of row) cell[0] = "1";
    const c = compareSections(a2, b);
    expect(c.table.changedCells).toBe(360 - (a2.table as unknown as Tbl).cells.flat().filter((x) => x[0] === "1").length);
    expect(c.table.cells.length).toBe(LIMITS_P2.compareCells);
  });

  it("a changed setting as short text; scratchpad cells", () => {
    const a = base();
    const b = clone(a);
    (b.analysis as unknown as { alpha: number }).alpha = 0.01;
    (b.figure as unknown as { title: string; show_points: boolean }).title = "New title";
    (b.figure as unknown as { show_points: boolean }).show_points = !(a.figure as unknown as { show_points: boolean }).show_points;
    const ids = Object.keys((b.figure as unknown as { series: object }).series);
    (b.figure as unknown as { series: Record<string, { color: string }> }).series[ids[0]].color = "#000000";
    b.scratchpad = { v: 1, cells: [[1, 1, "5"], [2, 2, "=A1"]] };
    const c = compareSections(a, b);
    expect(c.settings.map((s) => `${s.section}.${s.field}`)).toEqual(["analysis.alpha", "figure.series", "figure.show_points", "figure.title"]);
    expect(c.settings[0]).toEqual({ section: "analysis", field: "alpha", a: "0.05", b: "0.01" });
    expect(c.settings[3]).toEqual({ section: "figure", field: "title", a: "", b: "New title" });
    expect(c.settings[1].a.length).toBeLessThanOrEqual(60);
    expect(c.scratchpadCells).toBe(2);
    const d = compareSections(b, { ...b, scratchpad: { v: 1, cells: [[1, 1, "6"], [2, 2, "=A1"]] } });
    expect(d.scratchpadCells).toBe(1);
    expect(compareSections(b, { ...b, scratchpad: { v: 1, cells: [[1, 1, "5"], [2, 2, "=A1"]], cols: { "1": 120 } } }).scratchpadCells).toBe(1);
    expect(compareSections(b, clone(b)).scratchpadCells).toBe(0);
  });
});
