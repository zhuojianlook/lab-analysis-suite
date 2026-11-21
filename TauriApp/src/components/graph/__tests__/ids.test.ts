// Row / column ids follow their row or column through every structural edit.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GraphDoc, Template } from "../../../api/graph";
import * as M from "../graphModel";
import { useGraphStore } from "../../../store/graphStore";

let restore: ReturnType<typeof M.setIdSource> | null = null;
beforeEach(() => {
  let n = 0;
  restore = M.setIdSource((kind) => `${kind}-t${String(++n).padStart(6, "0")}`);
});
afterEach(() => { if (restore) M.setIdSource(restore); });

const TEMPLATES: Template[] = ["column", "grouped", "xy"];

/** A doc whose row titles / column titles are their own ids, so content and ids can be compared after an edit. */
function marked(t: Template, nCols = 4, nRows = 6): GraphDoc {
  let doc = M.emptyDoc(t);
  while (doc.col_titles.length < nCols) doc = M.insertCol(doc, doc.col_titles.length);
  doc = { ...doc, col_titles: [...doc.col_ids] };
  const cells = doc.cells.map((row, r) => row.map((reps, c) => reps.map((_, k) => (r < nRows ? `${r}.${c}${k}` : ""))));
  const row_titles = doc.row_titles.map((_, r) => (r < nRows ? doc.row_ids[r] : ""));
  const x = doc.x.map((_, r) => (t === "xy" && r < nRows ? String(r) : ""));
  return M.ensureRows({ ...doc, cells, row_titles, x });
}

/** Shape invariants: one unique, valid id per row / column. */
function expectShape(doc: GraphDoc) {
  expect(doc.row_ids).toHaveLength(doc.cells.length);
  expect(doc.row_titles).toHaveLength(doc.cells.length);
  expect(doc.x).toHaveLength(doc.cells.length);
  expect(doc.col_ids).toHaveLength(doc.col_titles.length);
  for (const row of doc.cells) expect(row).toHaveLength(doc.col_titles.length);
  expect(new Set(doc.row_ids).size).toBe(doc.row_ids.length);
  expect(new Set(doc.col_ids).size).toBe(doc.col_ids.length);
  for (const id of [...doc.row_ids, ...doc.col_ids]) expect(id).toMatch(M.ID_RE);
}

/** Every row whose title is a row id sits at that id; every column titled with a column id sits at that id. */
function expectContentAligned(doc: GraphDoc) {
  doc.row_titles.forEach((t, r) => { if (t.startsWith("row-")) expect(doc.row_ids[r]).toBe(t); });
  doc.col_titles.forEach((t, c) => { if (t.startsWith("col-")) expect(doc.col_ids[c]).toBe(t); });
}

/** `after` starts with exactly `expected`, followed only by ids that are new. */
function expectIds(after: string[], expected: string[], before: string[]) {
  expect(after.slice(0, expected.length)).toEqual(expected);
  const old = new Set(before);
  for (const id of after.slice(expected.length)) expect(old.has(id)).toBe(false);
}

const without = <T>(a: T[], i: number) => a.filter((_, j) => j !== i);
const insertAt = <T>(a: T[], i: number, v: T) => [...a.slice(0, i), v, ...a.slice(i)];

describe.each(TEMPLATES)("graphModel ids (%s)", (t) => {
  it("new, sample and migrated docs have aligned ids", () => {
    for (const d of [M.emptyDoc(t), M.sampleDoc(t), marked(t)]) { expectShape(d); expectContentAligned(d); }
    const legacy = M.migrateDoc({ v: 1, template: t, col_titles: ["a", "b"], cells: [[["1"], ["2"]]], n_rep: 1 })!;
    expectShape(legacy);
  });

  it("insertRow", () => {
    const d = marked(t);
    for (const at of [0, 3, d.cells.length]) {
      const n = M.insertRow(d, at);
      expectShape(n); expectContentAligned(n);
      const fresh = n.row_ids[at];
      expect(d.row_ids).not.toContain(fresh);
      expectIds(n.row_ids, insertAt(d.row_ids, at, fresh), d.row_ids);
      expect(n.col_ids).toEqual(d.col_ids);
    }
  });

  it("deleteRow (incl. the padding row that ensureRows adds back)", () => {
    const d = marked(t);
    for (const r of [0, 2, d.cells.length - 1]) {
      const n = M.deleteRow(d, r);
      expectShape(n); expectContentAligned(n);
      expectIds(n.row_ids, without(d.row_ids, r), d.row_ids);
      expect(n.cells.length).toBeGreaterThanOrEqual(M.MIN_ROWS);
    }
  });

  it("clearRow keeps the row's id", () => {
    const d = marked(t);
    const n = M.clearRow(d, 1);
    expectShape(n);
    expect(n.row_ids).toEqual(d.row_ids);
    expect(n.row_titles[1]).toBe("");
  });

  it("insertCol / deleteCol / clearCol", () => {
    const d = marked(t);
    for (const at of [0, 2, d.col_titles.length]) {
      const n = M.insertCol(d, at);
      expectShape(n); expectContentAligned(n);
      expect(n.col_ids).toEqual(insertAt(d.col_ids, at, n.col_ids[at]));
      expect(d.col_ids).not.toContain(n.col_ids[at]);
      expect(n.row_ids).toEqual(d.row_ids);
    }
    for (const c of [0, 1, d.col_titles.length - 1]) {
      const n = M.deleteCol(d, c);
      expectShape(n); expectContentAligned(n);
      expect(n.col_ids).toEqual(without(d.col_ids, c));
    }
    const cleared = M.clearCol(d, 2);
    expectShape(cleared);
    expect(cleared.col_ids).toEqual(d.col_ids);
    // The last column is cleared, not deleted: it keeps its id.
    let one = marked(t);
    while (one.col_titles.length > 1) one = M.deleteCol(one, 0);
    const lastId = one.col_ids[0];
    one = M.deleteCol(one, 0);
    expect(one.col_ids).toEqual([lastId]);
  });

  it("insertCol at the column limit changes nothing", () => {
    let d = marked(t);
    while (d.col_titles.length < M.MAX_COLS) d = M.insertCol(d, 0);
    expectShape(d);
    expect(M.insertCol(d, 0)).toBe(d);
  });

  it("setNRep keeps every id", () => {
    if (t === "column") return;
    const d = marked(t);
    for (const n of [1, 4, M.MAX_REP]) {
      const x = M.setNRep(d, n);
      expectShape(x); expectContentAligned(x);
      expect(x.row_ids).toEqual(d.row_ids);
      expect(x.col_ids).toEqual(d.col_ids);
    }
  });

  it("paste that grows rows and columns appends fresh ids", () => {
    const d = marked(t);
    const lead = M.leadCols(t).length;
    const width = (d.col_titles.length + 3) * d.n_rep;
    const lines = Array.from({ length: d.cells.length + 5 }, (_, i) => Array.from({ length: width }, (_, j) => String(i * 100 + j)).join("\t"));
    const res = M.applyPaste(d, { row: 3, fc: lead }, lines.join("\n"))!;
    const n = res.doc;
    expectShape(n); expectContentAligned(n);
    expectIds(n.row_ids, d.row_ids, d.row_ids);
    expectIds(n.col_ids, d.col_ids, d.col_ids);
    expect(n.col_titles.length).toBe(d.col_titles.length + 3);
    expect(n.cells.length).toBeGreaterThan(d.cells.length);
  });

  it("paste beyond the limits (truncated) keeps ids aligned", () => {
    const d = marked(t);
    const row = Array.from({ length: (M.MAX_COLS + 5) * d.n_rep }, (_, j) => String(j)).join("\t");
    const res = M.applyPaste(d, { row: M.MAX_ROWS - 2, fc: 0 }, `${row}\n${row}\n${row}\n${row}`)!;
    expect(res.truncated).toBe(true);
    expectShape(res.doc);
    expect(res.doc.cells).toHaveLength(M.MAX_ROWS);
    expect(res.doc.col_ids).toHaveLength(M.MAX_COLS);
    expectIds(res.doc.row_ids, d.row_ids, d.row_ids);
  });

  it("paste onto the title row and clearValues keep ids", () => {
    const d = marked(t);
    const res = M.applyPaste(d, { row: -1, fc: 0 }, "A\tB\n1\t2")!;
    expectShape(res.doc);
    expectIds(res.doc.col_ids, d.col_ids, d.col_ids);
    expectIds(res.doc.row_ids, d.row_ids, d.row_ids);
    const c = M.clearValues(d);
    expectShape(c);
    expect(c.row_ids).toEqual(d.row_ids);
    expect(c.col_ids).toEqual(d.col_ids);
  });

  it("typing into the last row adds a padding row with a fresh id", () => {
    const d = M.emptyDoc(t);
    const last = d.cells.length - 1;
    const cells = d.cells.map((row, r) => (r === last ? row.map((reps, c) => (c === 0 ? reps.map(() => "5") : reps)) : row));
    const n = M.ensureRows({ ...d, cells });
    expectShape(n);
    expect(n.cells.length).toBe(d.cells.length + 1);
    expectIds(n.row_ids, d.row_ids, d.row_ids);
  });

  it("toNumericTable never carries ids", () => {
    const d = M.sampleDoc(t);
    const table = M.toNumericTable(d);
    const text = JSON.stringify(table);
    for (const id of [...d.row_ids, ...d.col_ids]) expect(text).not.toContain(id);
    expect(Object.keys(table)).not.toContain("row_ids");
    expect(Object.keys(table)).not.toContain("col_ids");
  });
});

describe("id repair", () => {
  it("keeps valid unique ids in place and mints the rest", () => {
    expect(M.repairIdList(["row-aaaa", "row-aaaa", 5, "bad id!", "row-bbbb"], 6, "row"))
      .toEqual(["row-aaaa", "row-t000001", "row-t000002", "row-t000003", "row-bbbb", "row-t000004"]);
    expect(M.repairIdList(["col-xxxx", "col-yyyy", "col-zzzz"], 2, "col")).toEqual(["col-xxxx", "col-yyyy"]);
    expect(M.repairIdList(undefined, 2, "col")).toEqual(["col-t000005", "col-t000006"]);
    // Only "<kind>-" plus lowercase letters / digits is kept (never "__proto__", all digits or the other kind).
    expect(M.repairIdList(["__proto__", "12", "row-aaaa", "col-AAAA", "col-ok12"], 5, "col"))
      .toEqual(["col-t000007", "col-t000008", "col-t000009", "col-t000010", "col-ok12"]);
  });

  it("withIds returns the same doc when the ids are fine, repairs a doc whose ids don't line up", () => {
    const d = M.emptyDoc("column");
    expect(M.withIds(d)).toBe(d);
    const broken = { ...d, cells: [...d.cells, d.cells[0]], row_titles: [...d.row_titles, ""], x: [...d.x, ""] };
    const fixed = M.withIds(broken);
    expectShape(fixed);
    expect(fixed.row_ids.slice(0, d.row_ids.length)).toEqual(d.row_ids);
  });

  it("migrateDoc keeps stored ids and mints ids for old documents", () => {
    const d = M.sampleDoc("grouped");
    const again = M.migrateDoc(JSON.parse(JSON.stringify(d)))!;
    expect(again.row_ids).toEqual(d.row_ids);
    expect(again.col_ids).toEqual(d.col_ids);
    const { row_ids: _r, col_ids: _c, ...old } = d;
    const minted = M.migrateDoc(old)!;
    expectShape(minted);
    expect(minted.row_ids.some((id) => d.row_ids.includes(id))).toBe(false);
  });

  it("real ids are random, unique and well-formed", () => {
    if (restore) { M.setIdSource(restore); restore = null; }
    const d = M.applyPaste(M.emptyDoc("column"), { row: 0, fc: 0 },
      Array.from({ length: 499 }, () => Array.from({ length: 26 }, () => "1").join("\t")).join("\n"))!.doc;
    expectShape(d);
    expect(d.row_ids[0]).toMatch(/^row-[0-9a-hjkmnp-tv-z]{10}$/);
    expect(d.col_ids[0]).toMatch(/^col-[0-9a-hjkmnp-tv-z]{10}$/);
  });
});

describe("store edits keep ids aligned, undo brings the old ids back", () => {
  const st = useGraphStore;
  const ops: [string, (s: ReturnType<typeof st.getState>) => unknown][] = [
    ["setCell", (s) => s.setCell(9, 1, 0, "4")],
    ["setX", (s) => s.setX(9, "2")],
    ["setRowTitle", (s) => s.setRowTitle(9, "last")],
    ["setColTitle", (s) => s.setColTitle(0, "renamed")],
    ["setNRep", (s) => s.setNRep(3)],
    ["insertCol", (s) => s.insertCol(1)],
    ["deleteCol", (s) => s.deleteCol(1)],
    ["clearCol", (s) => s.clearCol(0)],
    ["insertRow", (s) => s.insertRow(2)],
    ["deleteRow", (s) => s.deleteRow(0)],
    ["clearRow", (s) => s.clearRow(1)],
    ["paste", (s) => s.paste({ row: 8, fc: 0 }, Array.from({ length: 6 }, () => "1\t2\t3\t4\t5\t6\t7\t8\t9\t10\t11\t12").join("\n"))],
    ["sendBlock", (s) => s.sendBlock({ row: 0, fc: 0 }, "a\tb\tc\td\te\n1\t2\t3\t4\t5", true)],
    ["sendBlock (no clear)", (s) => s.sendBlock({ row: 20, fc: 1 }, "1\n2\n3", false)],
  ];
  for (const t of TEMPLATES) {
    for (const [name, op] of ops) {
      it(`${t}: ${name}`, () => {
        st.getState().load({ doc: marked(t), name: "x", id: 1, saved: true });
        const before = st.getState().doc!;
        expectShape(before);
        op(st.getState());
        const after = st.getState().doc!;
        expectShape(after);
        expectContentAligned(after);
        // Rows / columns that survive keep their id; new ones have new ids.
        const keptRows = after.row_ids.filter((id) => before.row_ids.includes(id));
        expect(keptRows).toEqual(before.row_ids.filter((id) => after.row_ids.includes(id)));
        const keptCols = after.col_ids.filter((id) => before.col_ids.includes(id));
        expect(keptCols).toEqual(before.col_ids.filter((id) => after.col_ids.includes(id)));
        if (after !== before) {
          st.getState().undo();
          expect(st.getState().doc).toEqual(before);
        }
      });
    }
  }

  it("newDoc for each template has ids", () => {
    for (const t of TEMPLATES) for (const sample of [false, true]) {
      st.getState().newDoc(t, sample);
      expectShape(st.getState().doc!);
    }
  });

  it("load repairs a doc changed behind the model's back", () => {
    const d = M.emptyDoc("column");
    d.col_titles = Array.from({ length: 26 }, (_, i) => `G${i}`);
    d.cells = Array.from({ length: 40 }, () => Array.from({ length: 26 }, () => ["1"]));
    d.row_titles = Array(40).fill(""); d.x = Array(40).fill("");
    st.getState().load({ doc: d, name: "big", id: null, saved: false });
    expectShape(st.getState().doc!);
  });
});
