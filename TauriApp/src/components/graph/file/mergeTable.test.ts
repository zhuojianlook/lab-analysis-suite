/* Phase 4 contract §2.2 — the data table combined by row / column id and cell.
   Hand-made cases (T8–T13 and every rule of §2.2); the generated-document
   properties (T1–T7, T12) are in mergeTable.props.test.ts. */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GraphDoc, Template } from "../../../api/graph";
import { MAX_COLS, MAX_ROWS, deleteCol, deleteRow, ensureRows, insertCol, insertRow, setNRep } from "../graphModel";
import { LIMITS_P4, type FineChoices, type SideKey, type TableMerge } from "./contract";
import { canonicalJson } from "./format";
import { normaliseSections } from "./graphMerge";
import type { FileTable } from "./idMap";
import { mergeOrder, mergeTable } from "./mergeTable";
import { clone, countingIds, sampleSections } from "./fixtures-p2/docs";

let restoreIds: () => void;
beforeAll(() => { restoreIds = countingIds(); });
afterAll(() => restoreIds());

// ── building tables ─────────────────────────────────────────────────────────

type Cell = string | string[];
interface RowSpec { id?: string; title?: string; x?: string; v: Cell[] }
interface Spec { template?: Template; cols: string[]; colIds?: string[]; rows: RowSpec[]; nRep?: number; xTitle?: string }

const rid = (i: number) => `row-r${String(i).padStart(3, "0")}`;
const cid = (i: number) => `col-c${String(i).padStart(3, "0")}`;

function docOf(spec: Spec): GraphDoc {
  const template = spec.template ?? "grouped";
  const nRep = template === "column" ? 1 : spec.nRep ?? 1;
  const nC = spec.cols.length;
  const rep = (c: Cell | undefined) => {
    const a = Array.isArray(c) ? c : [c ?? ""];
    return Array.from({ length: nRep }, (_, k) => a[k] ?? "");
  };
  return ensureRows({
    v: 1, template, col_titles: [...spec.cols], x_title: spec.xTitle ?? "X", n_rep: nRep,
    row_titles: spec.rows.map((r) => r.title ?? ""),
    x: spec.rows.map((r) => (template === "xy" ? r.x ?? "" : "")),
    cells: spec.rows.map((r) => Array.from({ length: nC }, (_, c) => rep(r.v[c]))),
    row_ids: spec.rows.map((r, i) => r.id ?? rid(i)),
    col_ids: spec.colIds ?? spec.cols.map((_, i) => cid(i)),
  });
}

/** The table after the load pipeline (what the module is given). */
async function ft(d: GraphDoc): Promise<FileTable> {
  const s = sampleSections(d.template);
  const n = await normaliseSections({ ...s, table: { ...d, v: 2 }, scratchpad: null });
  if (!n) throw new Error("not a document");
  return clone(n.sections.table) as FileTable;
}
const table = (spec: Spec) => ft(docOf(spec));

/** A changed copy (open form, then the pipeline). */
async function edit(t: FileTable, f: (d: GraphDoc) => GraphDoc | void): Promise<FileTable> {
  const d = clone({ ...t, v: 1 }) as unknown as GraphDoc;
  return ft(ensureRows(f(d) ?? d));
}
const rowIx = (d: { row_ids: string[] }, id: string) => d.row_ids.indexOf(id);
const colIx = (d: { col_ids: string[] }, id: string) => d.col_ids.indexOf(id);
/** Set a cell by ids. */
const setCell = (r: string, c: string, v: string, k = 0) => (d: GraphDoc) => { d.cells[rowIx(d, r)][colIx(d, c)][k] = v; };

/** SHA-256 hex straight from WebCrypto (not through format.ts). */
async function sha(s: string): Promise<string> {
  const buf = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const KA: SideKey = { deviceId: "d-alice", revisionId: "r-0001" };
const KB: SideKey = { deviceId: "d-bob", revisionId: "r-0002" };

function mt(base: FileTable, mine: FileTable, theirs: FileTable, choices?: FineChoices, mineKey = KA, theirsKey = KB): Promise<TableMerge> {
  return mergeTable({ base, mine, theirs, mineKey, theirsKey }, choices);
}
/** The same pair seen from the other computer. */
const mirror = (base: FileTable, mine: FileTable, theirs: FileTable, choices?: FineChoices) => mt(base, theirs, mine, choices, KB, KA);
const swapChoices = (c: FineChoices): FineChoices =>
  Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v === "mine" ? "theirs" : v === "theirs" ? "mine" : v]));
const text = (t: FileTable | null) => (t ? canonicalJson(t) : "null");
const cellOf = (t: FileTable, r: string, c: string, k = 0) => t.cells[rowIx(t, r)]?.[colIx(t, c)]?.[k];

/** The result's table text after the load pipeline (T12). */
async function pipelineText(t: FileTable): Promise<string> {
  return canonicalJson(await ft(clone({ ...t, v: 1 }) as unknown as GraphDoc));
}

/** A grouped table: 4 rows of data, 3 columns, 2 replicates. */
const g4 = () => table({
  template: "grouped", cols: ["A", "B", "C"], nRep: 2,
  rows: [
    { title: "0 h", v: [["1", "2"], ["3", "4"], ["5", "6"]] },
    { title: "1 h", v: [["7", "8"], ["9", "10"], ["11", "12"]] },
    { title: "2 h", v: [["13", "14"], ["15", "16"], ["17", "18"]] },
    { title: "3 h", v: [["19", "20"], ["21", "22"], ["23", "24"]] },
  ],
});

describe("T8 cells and titles", () => {
  it("different cells of one row → combined, no conflict, from both sides alike", async () => {
    const b = await g4();
    const m = await edit(b, setCell(rid(1), cid(0), "70"));
    const t = await edit(b, setCell(rid(1), cid(2), "110", 1));
    const r = await mt(b, m, t);
    expect(r.conflicts).toEqual([]);
    expect(r.whole).toBeNull();
    expect(cellOf(r.value!, rid(1), cid(0))).toBe("70");
    expect(cellOf(r.value!, rid(1), cid(2), 1)).toBe("110");
    expect(r.combined).toBe(2);
    expect(r.auto).toEqual([
      { what: "cell", from: "mine", rowId: rid(1), colId: cid(0), rep: 0, before: "7", after: "70" },
      { what: "cell", from: "theirs", rowId: rid(1), colId: cid(2), rep: 1, before: "12", after: "110" },
    ]);
    expect(r.orderChecks).toEqual([]);
    expect(r.adjustments).toEqual([]);
    const s = await mirror(b, m, t);
    expect(text(s.value)).toBe(text(r.value));
    expect(s.auto.map((a) => a.from)).toEqual(["theirs", "mine"]);
    expect(await pipelineText(r.value!)).toBe(text(r.value));
  });

  it("the same change on both → taken once, from 'same'", async () => {
    const b = await g4();
    const m = await edit(b, setCell(rid(0), cid(0), "9"));
    const r = await mt(b, m, m);
    expect(r.conflicts).toEqual([]);
    expect(r.auto).toEqual([{ what: "cell", from: "same", rowId: rid(0), colId: cid(0), rep: 0, before: "1", after: "9" }]);
    expect(text(r.value)).toBe(text(m));
  });

  it("the same cell → one row conflict listing that cell; choices take that side", async () => {
    const b = await g4();
    const m = await edit(b, (d) => { setCell(rid(2), cid(1), "150")(d); setCell(rid(0), cid(0), "mine-elsewhere")(d); });
    const t = await edit(b, (d) => { setCell(rid(2), cid(1), "151")(d); setCell(rid(3), cid(2), "their-elsewhere", 1)(d); });
    const r = await mt(b, m, t);
    expect(r.value).toBeNull();
    expect(r.orderChecks).toEqual([]);
    expect(r.conflicts).toEqual([{
      id: `table:row:${rid(2)}`, section: "table", kind: "row", rowId: rid(2), options: ["mine", "theirs"], more: 0,
      items: [{ what: "cell", rowId: rid(2), colId: cid(1), rep: 0, base: "15", mine: "150", theirs: "151" }],
    }]);
    expect(r.combined).toBe(2);   // the two other edits
    const rm = await mt(b, m, t, { [`table:row:${rid(2)}`]: "mine" });
    const rt = await mt(b, m, t, { [`table:row:${rid(2)}`]: "theirs" });
    expect(cellOf(rm.value!, rid(2), cid(1))).toBe("150");
    expect(cellOf(rt.value!, rid(2), cid(1))).toBe("151");
    for (const x of [rm, rt]) {
      expect(cellOf(x.value!, rid(0), cid(0))).toBe("mine-elsewhere");
      expect(cellOf(x.value!, rid(3), cid(2), 1)).toBe("their-elsewhere");
      expect(x.conflicts.map((c) => c.id)).toEqual([`table:row:${rid(2)}`]);   // conflicts are always all of them
    }
    // From the other computer, with the choice swapped: the same bytes.
    const sm = await mirror(b, m, t, { [`table:row:${rid(2)}`]: "theirs" });
    expect(text(sm.value)).toBe(text(rm.value));
    expect(sm.conflicts[0].items[0]).toEqual({ what: "cell", rowId: rid(2), colId: cid(1), rep: 0, base: "15", mine: "151", theirs: "150" });
  });

  it("two cells of one row → one conflict with two items; the rest of the row stays combined", async () => {
    const b = await g4();
    const m = await edit(b, (d) => { setCell(rid(1), cid(0), "a")(d); setCell(rid(1), cid(2), "c", 1)(d); setCell(rid(1), cid(1), "only-mine")(d); });
    const t = await edit(b, (d) => { setCell(rid(1), cid(0), "A")(d); setCell(rid(1), cid(2), "C", 1)(d); });
    const r = await mt(b, m, t);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0].items).toEqual([
      { what: "cell", rowId: rid(1), colId: cid(0), rep: 0, base: "7", mine: "a", theirs: "A" },
      { what: "cell", rowId: rid(1), colId: cid(2), rep: 1, base: "12", mine: "c", theirs: "C" },
    ]);
    const rt = await mt(b, m, t, { [`table:row:${rid(1)}`]: "theirs" });
    expect(cellOf(rt.value!, rid(1), cid(0))).toBe("A");
    expect(cellOf(rt.value!, rid(1), cid(1))).toBe("only-mine");   // a non-conflicting change of the row stays
  });

  it("fixer VUX-1: when the row title is to choose, the choice takes the whole row (every value that differs)", async () => {
    const b = await g4();
    const m = await edit(b, (d) => { d.row_titles[1] = "one hour"; setCell(rid(1), cid(0), "a")(d); setCell(rid(1), cid(2), "c", 1)(d); setCell(rid(1), cid(1), "only-mine")(d); });
    const t = await edit(b, (d) => { d.row_titles[1] = "60 min"; setCell(rid(1), cid(0), "A")(d); setCell(rid(1), cid(2), "C", 1)(d); setCell(rid(1), cid(1), "only-theirs", 1)(d); });
    const r = await mt(b, m, t);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0].items).toEqual([
      { what: "rowTitle", rowId: rid(1), base: "1 h", mine: "one hour", theirs: "60 min" },
      { what: "cell", rowId: rid(1), colId: cid(0), rep: 0, base: "7", mine: "a", theirs: "A" },
      { what: "cell", rowId: rid(1), colId: cid(1), rep: 0, base: "9", mine: "only-mine", theirs: "9" },
      { what: "cell", rowId: rid(1), colId: cid(1), rep: 1, base: "10", mine: "10", theirs: "only-theirs" },
      { what: "cell", rowId: rid(1), colId: cid(2), rep: 1, base: "12", mine: "c", theirs: "C" },
    ]);
    const rt = (await mt(b, m, t, { [`table:row:${rid(1)}`]: "theirs" })).value!;
    expect([rt.row_titles[1], ...rt.cells[1].flat()]).toEqual(["60 min", "A", "8", "9", "only-theirs", "11", "C"]);
    const rm = (await mt(b, m, t, { [`table:row:${rid(1)}`]: "mine" })).value!;
    expect([rm.row_titles[1], ...rm.cells[1].flat()]).toEqual(["one hour", "a", "8", "only-mine", "10", "11", "c"]);
    expect(text((await mirror(b, m, t, { [`table:row:${rid(1)}`]: "mine" })).value)).toBe(text(rt));
  });

  it("fixer VUX-1: an XY row whose X is to choose is taken whole (no Y of one dose stored at the other dose)", async () => {
    const b = await table({ template: "xy", cols: ["Response", "Series A"], rows: [{ x: "1", v: ["2", "3"] }, { x: "2", v: ["4", "5"] }] });
    const m = await edit(b, (d) => { d.x[1] = "10"; d.cells[1][0][0] = "5"; });
    const t = await edit(b, (d) => { d.x[1] = "20"; d.cells[1][1][0] = "7"; });
    const r = await mt(b, m, t);
    expect(r.conflicts.map((c) => c.items.map((i) => i.what))).toEqual([["x", "cell", "cell"]]);
    const v = (await mt(b, m, t, { [`table:row:${rid(1)}`]: "mine" })).value!;
    expect([v.x[1], ...v.cells[1].flat()]).toEqual(["10", "5", "5"]);
    const w = (await mt(b, m, t, { [`table:row:${rid(1)}`]: "theirs" })).value!;
    expect([w.x[1], ...w.cells[1].flat()]).toEqual(["20", "4", "7"]);
  });

  it("a column title on both → colTitle; x_title on both → tableField; each its own choice", async () => {
    const b = await g4();
    const m = await edit(b, (d) => { d.col_titles[1] = "WT"; d.x_title = "Time"; d.col_titles[2] = "same"; });
    const t = await edit(b, (d) => { d.col_titles[1] = "KO"; d.x_title = "Hours"; d.col_titles[2] = "same"; d.col_titles[0] = "theirs-A"; });
    const r = await mt(b, m, t);
    expect(r.conflicts.map((c) => [c.id, c.kind])).toEqual([
      [`table:coltitle:${cid(1)}`, "colTitle"],
      ["table:field:x_title", "tableField"],
    ]);
    expect(r.conflicts[0].items).toEqual([{ what: "colTitle", colId: cid(1), base: "B", mine: "WT", theirs: "KO" }]);
    expect(r.conflicts[1]).toMatchObject({ field: "x_title", items: [{ what: "xTitle", field: "x_title", base: "X", mine: "Time", theirs: "Hours" }] });
    const v = (await mt(b, m, t, { [`table:coltitle:${cid(1)}`]: "theirs", "table:field:x_title": "mine" })).value!;
    expect(v.col_titles).toEqual(["theirs-A", "KO", "same"]);
    expect(v.x_title).toBe("Time");
    expect(r.auto.map((a) => [a.what, a.from])).toEqual([["colTitle", "theirs"], ["colTitle", "same"]]);
    // Without a choice for one of them: no result.
    expect((await mt(b, m, t, { [`table:coltitle:${cid(1)}`]: "theirs" })).value).toBeNull();
  });

  it("x values of an XY table are combined by row; a non-XY table keeps x blank", async () => {
    const b = await table({ template: "xy", cols: ["Y"], rows: [{ x: "1", v: ["2"] }, { x: "2", v: ["4"] }, { x: "3", v: ["6"] }] });
    const m = await edit(b, (d) => { d.x[0] = "1.5"; });
    const t = await edit(b, (d) => { d.x[2] = "3.5"; d.x[1] = "2.5"; });
    const r = await mt(b, m, t);
    expect(r.value!.x.slice(0, 3)).toEqual(["1.5", "2.5", "3.5"]);
    const t2 = await edit(b, (d) => { d.x[0] = "9"; });
    const c = await mt(b, m, t2);
    expect(c.conflicts[0].items).toEqual([{ what: "x", rowId: rid(0), base: "1", mine: "1.5", theirs: "9" }]);
    const g = await g4();
    const gr = await mt(g, await edit(g, setCell(rid(0), cid(0), "q")), g);
    expect(gr.value!.x.every((v) => v === "")).toBe(true);
  });
});

describe("§2.2.2 which rows and columns the result has", () => {
  it("rows added by one side, by the other, and by both (the same id)", async () => {
    const b = await g4();
    const m = await edit(b, (d) => { const e = insertRow(d, 1); e.cells[1][0][0] = "m-new"; return e; });
    const t = await edit(b, (d) => { const e = insertRow(d, 3); e.cells[3][1][0] = "t-new"; return e; });
    const r = await mt(b, m, t);
    expect(r.conflicts).toEqual([]);
    const mNew = m.row_ids[1], tNew = t.row_ids[3];
    expect(r.value!.row_ids.slice(0, 6)).toEqual([rid(0), mNew, rid(1), rid(2), tNew, rid(3)]);
    expect(r.auto.filter((a) => a.what === "rowAdded")).toEqual([
      { what: "rowAdded", from: "mine", rowId: mNew, before: null, after: "" },
      { what: "rowAdded", from: "theirs", rowId: tNew, before: null, after: "" },
    ]);
    // Both have a row the base lacks (the same id): one row, its cells combined against a blank base.
    const z = m;
    const zm = await edit(z, setCell(mNew, cid(2), "zm"));
    const zt = await edit(z, setCell(mNew, cid(0), "zt"));
    const rz = await mt(b, zm, zt);
    expect(rz.conflicts.map((c) => c.id)).toEqual([`table:row:${mNew}`]);   // "m-new" vs "zt" against ""
    // CHANGED BY fixer round 3 (safety net): the two rows have no value in common, so they may be two entries:
    // the choice takes the whole row (with "zm"), never "zt" next to "zm" by itself.
    expect(rz.conflicts[0].items).toEqual([
      { what: "cell", rowId: mNew, colId: cid(0), rep: 0, base: null, mine: "m-new", theirs: "zt" },
      { what: "cell", rowId: mNew, colId: cid(2), rep: 0, base: null, mine: "zm", theirs: "" },
    ]);
    // With a value in common (the same row went on on both sides), only the place both changed is asked.
    const zt2 = await edit(z, (d) => { const i = rowIx(d, mNew); d.cells[i][0][0] = "zt"; d.cells[i][1][0] = "both"; return d; });
    const zm2 = await edit(z, (d) => { const i = rowIx(d, mNew); d.cells[i][2][0] = "zm"; d.cells[i][1][0] = "both"; return d; });
    const rz3 = await mt(b, zm2, zt2);
    expect(rz3.conflicts[0].items).toEqual([{ what: "cell", rowId: mNew, colId: cid(0), rep: 0, base: null, mine: "m-new", theirs: "zt" }]);
    const rz2 = await mt(b, zm, z);
    expect(rz2.conflicts).toEqual([]);
    expect(cellOf(rz2.value!, mNew, cid(2))).toBe("zm");
    expect(rz2.auto.filter((a) => a.rowId === mNew)).toEqual([{ what: "rowAdded", from: "same", rowId: mNew, before: null, after: "" }]);
  });

  it("a deletion wins when the other side changed nothing in the row / column", async () => {
    const b = await g4();
    const m = await edit(b, (d) => deleteRow(deleteCol(d, 1), 2));
    const t = await edit(b, setCell(rid(0), cid(0), "t"));
    const r = await mt(b, m, t);
    expect(r.conflicts).toEqual([]);
    expect(r.value!.col_ids).toEqual([cid(0), cid(2)]);
    expect(r.value!.row_ids.slice(0, 3)).toEqual([rid(0), rid(1), rid(3)]);
    expect(cellOf(r.value!, rid(0), cid(0))).toBe("t");
    expect(r.auto.filter((a) => a.what === "colRemoved" || a.what === "rowRemoved")).toEqual([
      { what: "colRemoved", from: "mine", colId: cid(1), before: "B", after: null },
      { what: "rowRemoved", from: "mine", rowId: rid(2), before: "2 h", after: null },
    ]);
    // Both deleted the same: removed, from "same".
    const both = await mt(b, m, m);
    expect(both.auto.filter((a) => a.what === "colRemoved")[0].from).toBe("same");
  });

  it("deleted row vs a change inside it → rowDeleted; the deleting side removes it, the other keeps all its values", async () => {
    const b = await g4();
    const m = await edit(b, (d) => deleteRow(d, 1));
    const t = await edit(b, (d) => { setCell(rid(1), cid(1), "changed", 1)(d); d.row_titles[1] = "renamed"; });
    const r = await mt(b, m, t);
    expect(r.value).toBeNull();
    expect(r.conflicts).toEqual([{
      id: `table:row:${rid(1)}`, section: "table", kind: "rowDeleted", rowId: rid(1), deletedBy: "mine", options: ["mine", "theirs"], more: 0,
      items: [
        { what: "rowTitle", rowId: rid(1), base: "1 h", mine: null, theirs: "renamed" },
        { what: "cell", rowId: rid(1), colId: cid(1), rep: 1, base: "10", mine: null, theirs: "changed" },
      ],
    }]);
    const del = await mt(b, m, t, { [`table:row:${rid(1)}`]: "mine" });
    expect(del.value!.row_ids).not.toContain(rid(1));
    const keep = await mt(b, m, t, { [`table:row:${rid(1)}`]: "theirs" });
    expect(keep.value!.row_ids.slice(0, 4)).toEqual([rid(0), rid(1), rid(2), rid(3)]);
    expect(keep.value!.cells[1]).toEqual(t.cells[1]);
    expect(keep.value!.row_titles[1]).toBe("renamed");
    // The other computer sees deletedBy "theirs" and, with the choice swapped, the same bytes.
    const s = await mirror(b, m, t, { [`table:row:${rid(1)}`]: "mine" });
    expect(s.conflicts[0].deletedBy).toBe("theirs");
    expect(s.conflicts[0].items[0]).toEqual({ what: "rowTitle", rowId: rid(1), base: "1 h", mine: "renamed", theirs: null });
    expect(text(s.value)).toBe(text(keep.value));
  });

  it("deleted column vs a change inside it (also in a row the other side added) → colDeleted", async () => {
    const b = await g4();
    const m = await edit(b, (d) => { const e = insertRow(d, 4); e.cells[4][2][0] = "typed"; e.col_titles[0] = "A2"; return e; });
    const t = await edit(b, (d) => deleteCol(d, 2));
    const newRow = m.row_ids[4];
    const r = await mt(b, m, t);
    expect(r.conflicts.map((c) => [c.id, c.kind, c.deletedBy])).toEqual([[`table:col:${cid(2)}`, "colDeleted", "theirs"]]);
    expect(r.conflicts[0].items).toEqual([{ what: "cell", rowId: newRow, colId: cid(2), rep: 0, base: null, mine: "typed", theirs: null }]);
    const keep = (await mt(b, m, t, { [`table:col:${cid(2)}`]: "mine" })).value!;
    expect(keep.col_ids).toEqual([cid(0), cid(1), cid(2)]);
    expect(keep.col_titles).toEqual(["A2", "B", "C"]);
    expect(cellOf(keep, newRow, cid(2))).toBe("typed");
    expect(cellOf(keep, rid(3), cid(2), 1)).toBe("24");
    const del = (await mt(b, m, t, { [`table:col:${cid(2)}`]: "theirs" })).value!;
    expect(del.col_ids).toEqual([cid(0), cid(1)]);
    expect(del.row_ids).toContain(newRow);     // the row itself stays (its other cells are blank)
  });

  it("a column title changed on the side that kept the column counts as a change", async () => {
    const b = await g4();
    const m = await edit(b, (d) => { d.col_titles[0] = "renamed"; });
    const t = await edit(b, (d) => deleteCol(d, 0));
    const r = await mt(b, m, t);
    expect(r.conflicts[0]).toMatchObject({ kind: "colDeleted", items: [{ what: "colTitle", colId: cid(0), base: "A", mine: "renamed", theirs: null }] });
  });

  it("the blank-row case: a row without data in the base, deleted on one side and typed into on the other → kept, no question", async () => {
    const b = await table({ template: "grouped", cols: ["A", "B"], nRep: 1, rows: [{ v: ["1", "2"] }, { v: ["", ""] }, { v: ["5", "6"] }] });
    const m = await edit(b, (d) => deleteRow(d, 1));
    const t = await edit(b, setCell(rid(1), cid(1), "typed"));
    const r = await mt(b, m, t);
    expect(r.conflicts).toEqual([]);
    expect(r.value!.row_ids.slice(0, 3)).toEqual([rid(0), rid(1), rid(2)]);
    expect(cellOf(r.value!, rid(1), cid(1))).toBe("typed");
    expect(r.auto.filter((a) => a.rowId === rid(1))).toEqual([{ what: "rowAdded", from: "theirs", rowId: rid(1), before: null, after: "" }]);
    // Deleted and not typed into: removed.
    const r2 = await mt(b, m, b);
    expect(r2.value!.row_ids).not.toContain(rid(1));
  });

  it("choices that are not among the options are no choice", async () => {
    const b = await g4();
    const m = await edit(b, setCell(rid(0), cid(0), "m"));
    const t = await edit(b, setCell(rid(0), cid(0), "t"));
    for (const c of ["both", "nonsense", undefined]) {
      const r = await mt(b, m, t, { [`table:row:${rid(0)}`]: c as never });
      expect(r.value).toBeNull();
    }
    // A choice for an id that is not a conflict changes nothing.
    const plain = await mt(b, m, b);
    const extra = await mt(b, m, b, { [`table:row:${rid(0)}`]: "theirs", "table:section": "theirs" });
    expect(text(extra.value)).toBe(text(plain.value));
  });

  it("keeps no state between calls (the same input twice gives the same output)", async () => {
    const b = await g4();
    const m = await edit(b, (d) => deleteRow(d, 1));
    const t = await edit(b, setCell(rid(1), cid(1), "x"));
    const a1 = await mt(b, m, t), a2 = await mt(b, m, t, { [`table:row:${rid(1)}`]: "theirs" }), a3 = await mt(b, m, t);
    expect(canonicalJson(a3)).toBe(canonicalJson(a1));
    expect(a2.value).not.toBeNull();
    // Inputs are not changed.
    const before = canonicalJson([b, m, t]);
    await mt(b, m, t, { [`table:row:${rid(1)}`]: "mine" });
    expect(canonicalJson([b, m, t])).toBe(before);
  });
});

describe("§2.2.8 conflict order", () => {
  it("colDeleted, colTitle, tableField, then rows in mine's order and rows mine lacks in theirs' order", async () => {
    const b = await table({ template: "grouped", cols: ["A", "B", "C", "D"], rows: [0, 1, 2, 3, 4].map((i) => ({ title: `r${i}`, v: [`${i}a`, `${i}b`, `${i}c`, `${i}d`] })) });
    const m = await edit(b, (d) => {
      d.cells[4][0][0] = "m4"; d.cells[0][0][0] = "m0";            // rows 4 and 0 conflict
      d.col_titles[1] = "mB"; d.x_title = "mX";
      d.cells[2][3][0] = "m2d";                                     // theirs deletes column D
      return deleteRow(deleteCol(d, 2), 3);                           // mine deletes column C and row 3
    });
    const t = await edit(b, (d) => {
      d.cells[4][0][0] = "t4"; d.cells[0][0][0] = "t0";
      d.col_titles[1] = "tB"; d.x_title = "tX";
      d.cells[1][2][0] = "t1c";                                     // inside mine's deleted column C
      d.cells[3][1][0] = "t3b";                                     // inside mine's deleted row 3
      return deleteCol(d, 3);
    });
    const r = await mt(b, m, t);
    expect(r.conflicts.map((c) => c.id)).toEqual([
      `table:col:${cid(3)}`,          // mine still has D
      `table:col:${cid(2)}`,          // theirs still has C
      `table:coltitle:${cid(1)}`,
      "table:field:x_title",
      `table:row:${rid(0)}`,
      `table:row:${rid(4)}`,
      `table:row:${rid(3)}`,          // mine lacks it: after, in theirs' order
    ]);
    expect(r.conflicts.map((c) => c.kind)).toEqual(["colDeleted", "colDeleted", "colTitle", "tableField", "row", "row", "rowDeleted"]);
    // Row 1's cell in column C is theirs' change inside a column mine deleted: no row conflict for it.
    expect(r.conflicts.some((c) => c.id === `table:row:${rid(1)}`)).toBe(false);
    // All mine / all theirs give results, and swapping the computers gives the same bytes.
    const all = (side: "mine" | "theirs") => Object.fromEntries(r.conflicts.map((c) => [c.id, side])) as FineChoices;
    const am = await mt(b, m, t, all("mine"));
    const at = await mt(b, m, t, all("theirs"));
    expect(am.value!.col_ids).toEqual([cid(0), cid(1), cid(3)]);
    expect(at.value!.col_ids).toEqual([cid(0), cid(1), cid(2)]);
    expect(am.value!.row_ids).not.toContain(rid(3));
    expect(at.value!.row_ids).toContain(rid(3));
    expect(text((await mirror(b, m, t, all("theirs"))).value)).toBe(text(am.value));
    expect(text((await mirror(b, m, t, all("mine"))).value)).toBe(text(at.value));
  });

  it("caps items at LIMITS_P4.conflictItems with `more`, and auto at autoItems with the true `combined`", async () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ v: [String(i), String(i + 100)] }));
    const b = await table({ template: "grouped", cols: ["A", "B"], rows });
    const m = await edit(b, (d) => deleteCol(d, 1));
    const t = await edit(b, (d) => { for (let i = 0; i < 40; i++) d.cells[i][1][0] = `t${i}`; for (let i = 0; i < 40; i++) d.cells[i][0][0] = `a${i}`; });
    const r = await mt(b, m, t);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0].items).toHaveLength(LIMITS_P4.conflictItems);
    expect(r.conflicts[0].more).toBe(40 - LIMITS_P4.conflictItems);
    expect(r.combined).toBe(40);
    expect(r.auto).toHaveLength(LIMITS_P4.autoItems > 40 ? 40 : LIMITS_P4.autoItems);
    const t2 = await edit(b, (d) => { for (let i = 0; i < 40; i++) { d.cells[i][0][0] = `a${i}`; d.row_titles[i] = `r${i}`; } });
    const r2 = await mt(b, b, t2);
    expect(r2.combined).toBe(80);
    expect(r2.auto).toHaveLength(LIMITS_P4.autoItems);
  });
});

describe("T9 order of rows and columns both sides added", () => {
  async function bothInsertAfterRow1(template: Template) {
    const b = await table({ template, cols: ["A", "B"], rows: [0, 1, 2].map((i) => ({ x: String(i), v: [String(i), String(i * 2)] })) });
    const ins = (val: string) => (d: GraphDoc) => { const e = insertRow(d, 2); e.cells[2][0][0] = val; if (template === "xy") e.x[2] = "1.5"; return e; };
    const m = await edit(b, ins("from-alice"));
    const t = await edit(b, ins("from-bob"));
    return { b, m, t, mNew: m.row_ids[2], tNew: t.row_ids[2] };
  }

  it("the first side's rows first (smaller device id), with an order check; the same from both computers", async () => {
    for (const template of ["column", "grouped", "xy"] as const) {
      const { b, m, t, mNew, tNew } = await bothInsertAfterRow1(template);
      const r = await mt(b, m, t);
      expect(r.conflicts).toEqual([]);
      expect(r.value!.row_ids.slice(0, 5)).toEqual([rid(0), rid(1), mNew, tNew, rid(2)]);
      expect(r.orderChecks).toEqual([{ axis: "row", ids: [mNew, tNew], matters: template !== "column" }]);
      const s = await mirror(b, m, t);
      expect(text(s.value)).toBe(text(r.value));
      expect(s.orderChecks).toEqual(r.orderChecks);
      // Bob's device id is now the smaller one: his row comes first.
      const z = await mt(b, m, t, undefined, { deviceId: "d-zed", revisionId: "r-1" }, KB);
      expect(z.value!.row_ids.slice(2, 4)).toEqual([tNew, mNew]);
    }
  });

  it("equal device ids → the smaller revision id first; everything equal → mine", async () => {
    const { b, m, t, mNew, tNew } = await bothInsertAfterRow1("grouped");
    const d = "d-same";
    const r1 = await mt(b, m, t, undefined, { deviceId: d, revisionId: "r-9" }, { deviceId: d, revisionId: "r-1" });
    expect(r1.value!.row_ids.slice(2, 4)).toEqual([tNew, mNew]);
    const r2 = await mt(b, m, t, undefined, { deviceId: d, revisionId: "r-1" }, { deviceId: d, revisionId: "r-9" });
    expect(r2.value!.row_ids.slice(2, 4)).toEqual([mNew, tNew]);
    const r3 = await mt(b, m, t, undefined, { deviceId: d, revisionId: "r-1" }, { deviceId: d, revisionId: "r-1" });
    expect(r3.value!.row_ids.slice(2, 4)).toEqual([mNew, tNew]);
    // Plain string compare, not locale: "Z" < "a".
    const r4 = await mt(b, m, t, undefined, { deviceId: "a", revisionId: "" }, { deviceId: "Z", revisionId: "" });
    expect(r4.value!.row_ids.slice(2, 4)).toEqual([tNew, mNew]);
  });

  it("rows inserted at different places → no order check; a run with data from one side only → no check", async () => {
    const b = await table({ template: "xy", cols: ["Y"], rows: [0, 1, 2, 3].map((i) => ({ x: String(i), v: [String(i)] })) });
    const m = await edit(b, (d) => { const e = insertRow(d, 1); e.x[1] = "0.5"; return e; });
    const t = await edit(b, (d) => { const e = insertRow(d, 3); e.x[3] = "2.5"; return e; });
    expect((await mt(b, m, t)).orderChecks).toEqual([]);
    const t2 = await edit(b, (d) => insertRow(d, 1));     // a blank row in the same place: no data from theirs
    const r2 = await mt(b, m, t2);
    expect(r2.value!.row_ids.slice(0, 3)).toEqual([rid(0), m.row_ids[1], t2.row_ids[1]]);
    expect(r2.orderChecks).toEqual([]);
  });

  it("columns both added in the same place → a check that always matters", async () => {
    const b = await table({ template: "column", cols: ["A", "B"], rows: [{ v: ["1", "2"] }] });
    const m = await edit(b, (d) => insertCol(d, 1));
    const t = await edit(b, (d) => insertCol(d, 1));
    const r = await mt(b, m, t);
    expect(r.value!.col_ids).toEqual([cid(0), m.col_ids[1], t.col_ids[1], cid(1)]);
    expect(r.orderChecks).toEqual([{ axis: "col", ids: [m.col_ids[1], t.col_ids[1]], matters: true }]);
    expect(r.auto.filter((a) => a.what === "colAdded").map((a) => a.from)).toEqual(["mine", "theirs"]);
  });

  it("shared rows in different orders on the two sides → the first side's order and one check with no ids", async () => {
    const b = await g4();
    const m = await edit(b, (d) => { [d.cells[0], d.cells[1]] = [d.cells[1], d.cells[0]]; [d.row_ids[0], d.row_ids[1]] = [d.row_ids[1], d.row_ids[0]]; [d.row_titles[0], d.row_titles[1]] = [d.row_titles[1], d.row_titles[0]]; });
    const r = await mt(b, m, b);
    expect(r.value!.row_ids.slice(0, 2)).toEqual([rid(1), rid(0)]);          // mine is first
    expect(r.orderChecks).toEqual([{ axis: "row", ids: [], matters: true }]);
    const s = await mirror(b, m, b);
    expect(text(s.value)).toBe(text(r.value));
  });
});

describe("mergeOrder (§2.2.4) on its own", () => {
  const all = (...xs: string[][]) => new Set(xs.flat());
  it("keeps the first side's order and puts the second's insertions after its anchor, after the first's own insertions there", () => {
    expect(mergeOrder(["a", "b", "c"], ["a", "x1", "x2", "b", "c"], ["a", "y1", "b", "c", "y2"], all(["a", "b", "c", "x1", "x2", "y1", "y2"])))
      .toEqual(["a", "x1", "x2", "y1", "b", "c", "y2"]);
    expect(mergeOrder(["a"], ["f", "a"], ["s", "a"], all(["a", "f", "s"]))).toEqual(["f", "s", "a"]);
  });
  it("with one side = base, the other side's order", () => {
    const x = ["n1", "a", "c", "n2", "n3"];
    expect(mergeOrder(["a", "b", "c"], x, ["a", "b", "c"], new Set(x))).toEqual(x);
    expect(mergeOrder(["a", "b", "c"], ["a", "b", "c"], x, new Set(x))).toEqual(x);
  });
  it("leaves out what is not kept; a base id the first side kept is not passed over", () => {
    expect(mergeOrder(["a", "b"], ["a", "b"], ["a", "c"], all(["a", "b", "c"]))).toEqual(["a", "c", "b"]);
    expect(mergeOrder(["a", "b"], ["a", "b", "z"], ["a", "b"], all(["a", "z"]))).toEqual(["a", "z"]);
  });
});

describe("T10 trailing blank rows", () => {
  /** 9 rows with data, then the one blank row the editor keeps (ten rows). */
  const nine = () => table({ template: "grouped", cols: ["A", "B"], rows: Array.from({ length: 9 }, (_, i) => ({ v: [String(i), String(-i)] })) });

  /** The id the combine gives the second row of a split blank row (fixer, finding M1). */
  const splitId = async (rowId: string, title: string, x: string, cells: [string, number, string][]) =>
    "row-" + (await sha(`las-split\n${rowId}\n${JSON.stringify([title, x, cells])}`)).slice(0, LIMITS_P4.fillIdHex);

  it("fixer M1: both typed into the shared blank last row (different columns) → two rows, the first side's in it, an order check", async () => {
    const b = await nine();
    expect(b.row_ids).toHaveLength(10);
    const last = b.row_ids[9];
    const m = await edit(b, setCell(last, cid(0), "m"));
    const t = await edit(b, setCell(last, cid(1), "t"));
    expect(m.row_ids).toHaveLength(11);         // each got its own new blank row
    const r = await mt(b, m, t);                 // mine is the first side (d-alice)
    expect(r.conflicts).toEqual([]);
    const second = await splitId(last, "", "", [[cid(1), 0, "t"]]);
    expect(r.value!.row_ids.slice(9)).toEqual([last, second, m.row_ids[10], t.row_ids[10]]);   // padding kept at the end
    expect(r.value!.cells[9]).toEqual([["m"], [""]]);
    expect(r.value!.cells[10]).toEqual([[""], ["t"]]);
    expect(r.orderChecks).toEqual([{ axis: "row", ids: [last, second], matters: true }]);
    // Fixer round 2 (RV-3): a row added on each side, not a changed cell.
    expect(r.auto.map((a) => [a.what, a.from, a.rowId])).toEqual([["rowAdded", "mine", last], ["rowAdded", "theirs", second]]);
    expect(r.rowNotes).toEqual({ split: [last], moved: [] });
    expect(await pipelineText(r.value!)).toBe(text(r.value));
    const mir = await mirror(b, m, t);
    expect(text(mir.value)).toBe(text(r.value));
    expect(mir.orderChecks).toEqual(r.orderChecks);
    // The other computer is the first side: its values stay in the row, mine move to the new one.
    const r2 = await mt(b, m, t, {}, KB, KA);
    const second2 = await splitId(last, "", "", [[cid(0), 0, "m"]]);
    expect(r2.value!.row_ids.slice(9, 11)).toEqual([last, second2]);
    expect(r2.value!.cells[9]).toEqual([[""], ["t"]]);
    expect(r2.value!.cells[10]).toEqual([["m"], [""]]);
    // T7: combining the result again with either side changes nothing.
    for (const [base, x, y] of [[b, r.value!, m], [b, r.value!, t], [b, m, r.value!], [b, t, r.value!], [m, r.value!, m], [t, r.value!, t]] as const) {
      const again = await mt(base, x, y);
      expect(again.conflicts).toEqual([]);
      expect(text(again.value)).toBe(text(r.value));
    }
  });

  it("fixer M1: the same cell of the shared blank row → two rows, nothing to choose; a column table without a paired test needs no check", async () => {
    const b = await nine();
    const last = b.row_ids[9];
    const r = await mt(b, await edit(b, setCell(last, cid(0), "m")), await edit(b, setCell(last, cid(0), "t")));
    expect(r.conflicts).toEqual([]);
    expect(r.value!.cells.slice(9, 11)).toEqual([[["m"], [""]], [["t"], [""]]]);
    expect(r.orderChecks.map((o) => o.matters)).toEqual([true]);
    // Column table, both append values at the end: every value is kept, in two runs.
    const c = await table({ template: "column", cols: ["A"], rows: Array.from({ length: 10 }, (_, i) => ({ v: [String(i)] })) });
    const at = (t0: FileTable, vals: string[]) => edit(t0, (d) => {
      let e = d;
      vals.forEach((v, j) => { e = ensureRows(e); e.cells[10 + j][0][0] = v; });
      return e;
    });
    const cm = await at(c, ["m1", "m2", "m3"]), ct = await at(c, ["t1", "t2"]);
    const rc = await mt(c, cm, ct);
    expect(rc.conflicts).toEqual([]);
    expect(rc.value!.cells.map((row) => row[0][0]).slice(10).filter((v) => v)).toEqual(["m1", "m2", "m3", "t1", "t2"]);
    expect(rc.orderChecks.every((o) => o.matters === false)).toBe(true);
    expect(text((await mirror(c, cm, ct)).value)).toBe(text(rc.value));
  });

  it("fixer M1: grouped, two different row titles typed into the same blank row → two rows, each with its own values", async () => {
    const b = await nine();
    const last = b.row_ids[9];
    const m = await edit(b, (d) => { d.row_titles[9] = "Mouse 7"; d.cells[9][0][0] = "5"; });
    const t = await edit(b, (d) => { d.row_titles[9] = "Mouse 9"; d.cells[9][1][0] = "7"; });
    const r = await mt(b, m, t);
    expect(r.conflicts).toEqual([]);
    const v = r.value!;
    expect([v.row_titles[9], v.cells[9]]).toEqual(["Mouse 7", [["5"], [""]]]);
    expect([v.row_titles[10], v.cells[10]]).toEqual(["Mouse 9", [[""], ["7"]]]);
    expect(r.orderChecks).toEqual([{ axis: "row", ids: [last, v.row_ids[10]], matters: true }]);
  });

  it("a side's blank padding never lands between rows with data: it moves to just after the last row with data", async () => {
    const b = await nine();
    const last = b.row_ids[9];
    const m = await edit(b, setCell(last, cid(0), "m"));                     // mine: + padding row P
    const t = await edit(b, (d) => {                                         // theirs types further down
      d.cells[9][1][0] = "t9";
      const e = ensureRows(d);
      e.cells[10][0][0] = "t10";
      return ensureRows(e);
    });
    const P = m.row_ids[10];
    const r = await mt(b, m, t);
    expect(r.conflicts).toEqual([]);
    const ids = r.value!.row_ids;
    // Both typed into the blank row (fixer M1): theirs' t9 goes into a new row after it. Order rule: last, P
    // (first side's), t9's row, t10, t11; P has no data and sits above t10 → right after t10.
    const second = await splitId(last, "", "", [[cid(1), 0, "t9"]]);
    expect(ids.slice(9)).toEqual([last, second, t.row_ids[10], P, t.row_ids[11]]);
    expect(r.orderChecks).toEqual([{ axis: "row", ids: [last, second, t.row_ids[10]], matters: true }]);
    expect(r.auto.filter((a) => a.what === "rowAdded")).toEqual([
      { what: "rowAdded", from: "mine", rowId: last, before: null, after: "" },        // fixer round 2 (RV-3)
      { what: "rowAdded", from: "theirs", rowId: second, before: null, after: "" },
      { what: "rowAdded", from: "theirs", rowId: t.row_ids[10], before: null, after: "" },
    ]);
    expect(text((await mirror(b, m, t)).value)).toBe(text(r.value));
    expect(await pipelineText(r.value!)).toBe(text(r.value));
  });

  it("the result has at least 10 rows and ends with a blank row; added rows get the hashed id (hand-computed vectors)", async () => {
    // Two rows with data, both deleted the rest: the combine has to add eight blank rows.
    const b = await table({ template: "grouped", cols: ["A"], rows: [{ v: ["1"] }, { v: ["2"] }, { v: ["3"] }] });
    const cut = (d: GraphDoc): GraphDoc => ({ ...d, cells: d.cells.slice(0, 2), row_titles: d.row_titles.slice(0, 2), x: d.x.slice(0, 2), row_ids: d.row_ids.slice(0, 2) });
    const m = clone(b), t = clone(b);
    // Sides that are not in pipeline form are not expected; the module must still give pipeline form.
    const mm = { ...cut({ ...m, v: 1 } as unknown as GraphDoc), v: 2 } as unknown as FileTable;
    const tt = { ...cut({ ...t, v: 1 } as unknown as GraphDoc), v: 2 } as unknown as FileTable;
    mm.cells[0][0][0] = "1m";
    const r = await mt(b, mm, tt);
    const ids = r.value!.row_ids;
    expect(ids).toHaveLength(10);
    expect(ids.slice(0, 2)).toEqual([rid(0), rid(1)]);
    expect(ids[2]).toBe("row-df2d2025a263");
    expect(ids[3]).toBe("row-d8ac6a423790");
    for (let i = 2; i < 10; i++) {
      const want = "row-" + (await sha("las-fill\n" + ids.slice(0, i).join("\n"))).slice(0, LIMITS_P4.fillIdHex);
      expect(ids[i]).toBe(want);
    }
    expect(text((await mirror(b, mm, tt)).value)).toBe(text(r.value));
    expect(await pipelineText(r.value!)).toBe(text(r.value));
    expect(r.auto.filter((a) => a.what === "rowAdded")).toEqual([]);
  });

  it("a last row with data gets one blank row after it", async () => {
    const b = await table({ template: "column", cols: ["A"], rows: Array.from({ length: 12 }, (_, i) => ({ v: [String(i)] })) });
    expect(b.row_ids).toHaveLength(13);
    // Mine deleted the trailing blank row (by hand): the result still ends with a blank one.
    const m = { ...b, row_ids: b.row_ids.slice(0, 12), row_titles: b.row_titles.slice(0, 12), x: b.x.slice(0, 12), cells: b.cells.slice(0, 12) };
    const t = await edit(b, (d) => { d.cells[11][0][0] = "11t"; });
    const r = await mt(b, m, t);
    const v = r.value!;
    expect(v.row_ids).toHaveLength(13);
    expect(v.cells[12][0][0]).toBe("");
    expect(v.row_ids[12]).toBe("row-" + (await sha("las-fill\n" + v.row_ids.slice(0, 12).join("\n"))).slice(0, 12));
    expect(await pipelineText(v)).toBe(text(v));
  });
});

describe("T11 replicates", () => {
  const g3 = () => table({ template: "grouped", cols: ["A", "B"], nRep: 3, rows: [0, 1, 2].map((i) => ({ v: [[`${i}a1`, `${i}a2`, `${i}a3`], [`${i}b1`, `${i}b2`, `${i}b3`]] })) });

  it("one side raises 3 → 4 and fills → 4", async () => {
    const b = await g3();
    const m = await edit(b, (d) => { const e = setNRep(d, 4); e.cells[0][0][3] = "new4"; return e; });
    const r = await mt(b, m, b);
    expect(r.value!.n_rep).toBe(4);
    expect(cellOf(r.value!, rid(0), cid(0), 3)).toBe("new4");
    expect(r.adjustments).toEqual([]);
    expect(r.auto).toEqual([
      { what: "replicates", from: "mine", before: "3", after: "4" },
      { what: "cell", from: "mine", rowId: rid(0), colId: cid(0), rep: 3, before: "", after: "new4" },
    ]);
    // The other side edits elsewhere meanwhile: both kept.
    const t = await edit(b, setCell(rid(2), cid(1), "t", 2));
    const r2 = await mt(b, m, t);
    expect(r2.value!.n_rep).toBe(4);
    expect(cellOf(r2.value!, rid(2), cid(1), 2)).toBe("t");
    expect(cellOf(r2.value!, rid(2), cid(1), 3)).toBe("");
  });

  it("one side lowers 3 → 2, the other unchanged → 2", async () => {
    const b = await g3();
    const m = await edit(b, (d) => setNRep(d, 2));
    const r = await mt(b, m, b);
    expect(r.value!.n_rep).toBe(2);
    expect(text(r.value)).toBe(text(m));
    expect(r.adjustments).toEqual([]);
  });

  it("one lowers, the other edits a third replicate → row conflict; the editing side gives 3 with an adjustment", async () => {
    const b = await g3();
    const m = await edit(b, (d) => setNRep(d, 2));
    const t = await edit(b, setCell(rid(1), cid(0), "edited", 2));
    const r = await mt(b, m, t);
    expect(r.conflicts.map((c) => c.id)).toEqual([`table:row:${rid(1)}`]);
    expect(r.conflicts[0].items).toEqual([{ what: "cell", rowId: rid(1), colId: cid(0), rep: 2, base: "1a3", mine: "", theirs: "edited" }]);
    const rt = await mt(b, m, t, { [`table:row:${rid(1)}`]: "theirs" });
    expect(rt.value!.n_rep).toBe(3);
    expect(cellOf(rt.value!, rid(1), cid(0), 2)).toBe("edited");
    expect(cellOf(rt.value!, rid(0), cid(0), 2)).toBe("");     // mine's clearing of the other rows stays
    expect(rt.adjustments).toEqual([{ section: "table", kind: "replicates", from: "2", to: "3" }]);
    const rm = await mt(b, m, t, { [`table:row:${rid(1)}`]: "mine" });
    expect(rm.value!.n_rep).toBe(2);
    expect(rm.adjustments).toEqual([]);
    expect(await pipelineText(rt.value!)).toBe(text(rt.value));
  });

  it("both change it differently → the larger, never a conflict", async () => {
    const b = await g3();
    const m = await edit(b, (d) => setNRep(d, 2));
    const t = await edit(b, (d) => setNRep(d, 5));
    const r = await mt(b, m, t);
    expect(r.conflicts).toEqual([]);
    expect(r.value!.n_rep).toBe(5);
    expect(r.auto[0]).toEqual({ what: "replicates", from: "theirs", before: "3", after: "5" });
    expect(text((await mirror(b, m, t)).value)).toBe(text(r.value));
  });

  it("a row the other side added with values in a replicate one side removed raises it again", async () => {
    const b = await g3();
    const m = await edit(b, (d) => setNRep(d, 1));
    const t = await edit(b, (d) => { const e = insertRow(d, 3); e.cells[3][1][2] = "third"; return e; });
    const r = await mt(b, m, t);
    expect(r.conflicts).toEqual([]);
    expect(r.value!.n_rep).toBe(3);
    expect(r.adjustments).toEqual([{ section: "table", kind: "replicates", from: "1", to: "3" }]);
  });
});

describe("T12 whole-table choices (§2.2.9)", () => {
  const expectWhole = async (b: FileTable, m: FileTable, t: FileTable) => {
    const r = await mt(b, m, t);
    expect(r.whole).toBe("table");
    expect(r.value).toBeNull();
    expect(r.conflicts).toEqual([{ id: "table:section", section: "table", kind: "section", reason: "table", options: ["mine", "theirs"], items: [], more: 0 }]);
    expect(r.combined).toBe(0);
    expect(text((await mt(b, m, t, { "table:section": "mine" })).value)).toBe(text(m));
    expect(text((await mt(b, m, t, { "table:section": "theirs" })).value)).toBe(text(t));
    expect((await mt(b, m, t, { "table:section": "both" })).value).toBeNull();
  };

  it("templates differ", async () => {
    const b = await g4();
    const t = await table({ template: "xy", cols: ["Y"], rows: [{ x: "1", v: ["1"] }] });
    await expectWhole(b, await edit(b, setCell(rid(0), cid(0), "m")), t);
  });

  it("no column left", async () => {
    const b = await table({ template: "column", cols: ["A", "B"], rows: [{ v: ["1", "2"] }] });
    await expectWhole(b, await edit(b, (d) => deleteCol(d, 0)), await edit(b, (d) => deleteCol(d, 1)));
  });

  it("27 columns", async () => {
    const b = await table({ template: "column", cols: Array.from({ length: 20 }, (_, i) => `c${i}`), rows: [{ v: [] }] });
    const add = (n: number) => (d: GraphDoc) => { let e = d; for (let i = 0; i < n; i++) e = insertCol(e, e.col_titles.length); return e; };
    const m = await edit(b, add(4)), t = await edit(b, add(3));
    await expectWhole(b, m, t);
    // 26 is fine.
    const r = await mt(b, m, await edit(b, add(2)));
    expect(r.whole).toBeNull();
    expect(r.value!.col_ids).toHaveLength(MAX_COLS);
  });

  it("501 rows with data (counting rows kept by a deletion choice)", async () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({ v: [String(i)] }));
    const b = await table({ template: "column", cols: ["A"], rows });
    const addRows = (n: number, tag: string) => (d: GraphDoc) => {
      let e = d;
      for (let i = 0; i < n; i++) { e = insertRow(e, 0); e.cells[0][0][0] = `${tag}${i}`; }
      return e;
    };
    const m = await edit(b, addRows(150, "m"));
    const t = await edit(b, addRows(51, "t"));
    await expectWhole(b, m, t);
    const ok = await mt(b, m, await edit(b, addRows(50, "t")));
    expect(ok.whole).toBeNull();
    expect(ok.value!.row_ids).toHaveLength(MAX_ROWS);            // exactly 500 with data: no blank row added
    expect(await pipelineText(ok.value!)).toBe(text(ok.value));
  });

  it("more than 500 rows only because of blank rows → trimmed, not a whole choice", async () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({ v: [i < 200 ? String(i) : ""] }));
    const b = await table({ template: "column", cols: ["A"], rows });
    const m = await edit(b, (d) => { let e = d; for (let i = 0; i < 150; i++) e = insertRow(e, 250); return e; });
    const t = await edit(b, (d) => { let e = d; for (let i = 0; i < 150; i++) e = insertRow(e, 260); return e; });
    const r = await mt(b, m, t);
    expect(r.whole).toBeNull();
    expect(r.value!.row_ids.length).toBeLessThanOrEqual(MAX_ROWS);
    expect(await pipelineText(r.value!)).toBe(text(r.value));
  });
});

describe("T13 speed", () => {
  it("500 × 26 × 3 with 200 scattered changes per side: under 50 ms per call after warm-up", async () => {
    const cols = Array.from({ length: 26 }, (_, i) => `c${i}`);
    const rows = Array.from({ length: 499 }, (_, r) => ({ v: cols.map((_, c) => [`${r}.${c}`, `${r}.${c}b`, `${r}.${c}c`]) }));
    const b = await table({ template: "grouped", cols, nRep: 3, rows });
    expect(b.row_ids).toHaveLength(500);
    let seed = 7;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const scatter = (tag: string) => (d: GraphDoc) => { for (let i = 0; i < 200; i++) d.cells[rnd(499)][rnd(26)][rnd(3)] = `${tag}${i}`; };
    const m = await edit(b, scatter("m")), t = await edit(b, scatter("t"));
    const first = await mt(b, m, t);
    const choices = Object.fromEntries(first.conflicts.map((c) => [c.id, "theirs"])) as FineChoices;
    for (let i = 0; i < 3; i++) await mt(b, m, t, choices);
    const n = 10;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) await mt(b, m, t, choices);
    const per = (performance.now() - t0) / n;
    expect(first.combined).toBeGreaterThan(300);
    expect(per).toBeLessThan(50);
  });
});
