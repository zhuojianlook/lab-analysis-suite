/* Fixer round 3 (phase 4 contract §2.2.2, "CHANGED BY fixer round 3"). Each case here failed on the code before
   the fix: two people's entries were combined into one row without a question (RV2-1, RV2-4), or combining the
   result again with one side asked about a row or showed an entry twice (RV2-2). The safety net: a row that may
   hold two different entries is never combined place by place; ordinary edits of an existing entry still are. */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GraphDoc, Template } from "../../../api/graph";
import { deleteRow, ensureRows, insertCol } from "../graphModel";
import type { FineChoices, SideKey, TableMerge } from "./contract";
import { canonicalJson } from "./format";
import { combineFine, normaliseSections } from "./graphMerge";
import type { FileTable } from "./idMap";
import { mergeTable } from "./mergeTable";
import { clone, countingIds, sampleSections } from "./fixtures-p2/docs";

let restoreIds: () => void;
beforeAll(() => { restoreIds = countingIds(); });
afterAll(() => restoreIds());

const rid = (i: number) => `row-r${String(i).padStart(3, "0")}`;
const cid = (i: number) => `col-c${String(i).padStart(3, "0")}`;

/** Nine rows with data and the blank row the editor keeps at the end (ten rows), two columns. */
function nineDoc(template: Template): GraphDoc {
  return ensureRows({
    v: 1, template, col_titles: ["A", "B"], x_title: "X", n_rep: 1,
    row_titles: Array.from({ length: 10 }, (_, i) => (template === "grouped" && i < 9 ? `g${i}` : "")),
    x: Array.from({ length: 10 }, (_, i) => (template === "xy" && i < 9 ? String(i) : "")),
    cells: Array.from({ length: 10 }, (_, i) => (i < 9 ? [[String(i)], [String(-i)]] : [[""], [""]])),
    row_ids: Array.from({ length: 10 }, (_, i) => rid(i)),
    col_ids: [cid(0), cid(1)],
  });
}

async function ft(d: GraphDoc): Promise<FileTable> {
  const n = await normaliseSections({ ...sampleSections(d.template), table: { ...d, v: 2 }, scratchpad: null });
  if (!n) throw new Error("not a document");
  return clone(n.sections.table) as FileTable;
}
async function edit(t: FileTable, f: (d: GraphDoc) => GraphDoc | void): Promise<FileTable> {
  const d = clone({ ...t, v: 1 }) as unknown as GraphDoc;
  return ft(ensureRows(f(d) ?? d));
}
const at = (d: { row_ids: string[] }, id: string) => d.row_ids.indexOf(id);
const text = (t: FileTable | null) => (t ? canonicalJson(t) : "null");
const mt = (base: FileTable, mine: FileTable, theirs: FileTable, mineKey: SideKey, theirsKey: SideKey, choices?: FineChoices): Promise<TableMerge> =>
  mergeTable({ base, mine, theirs, mineKey, theirsKey }, choices);
const swap = (c: FineChoices): FineChoices => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v === "mine" ? "theirs" : "mine"]));

/** Row (title / x, column A, column B) of a table by id. */
const row = (t: FileTable, id: string) => {
  const i = at(t, id);
  return i < 0 ? null : [t.template === "xy" ? t.x[i] : t.row_titles[i], t.cells[i][0][0], t.cells[i][1][0]];
};
/** The rows with data, as [label, A, B]. */
const dataRows = (t: FileTable) => t.row_ids.map((id) => row(t, id)!).filter((r) => r.some((v) => v !== ""));

const KL: SideKey = { deviceId: "d-3333", revisionId: "r-L" };
const K1: SideKey = { deviceId: "d-1111", revisionId: "r-K1" };
const K2: SideKey = { deviceId: "d-2222", revisionId: "r-K2" };
const KA: SideKey = { deviceId: "d-1111", revisionId: "r-01JX" };
const KB: SideKey = { deviceId: "d-2222", revisionId: "r-01JY" };
const KR: SideKey = { deviceId: "", revisionId: "r-m-combined" };

/** A combine seen from both computers (either one is mine): the same bytes and conflicts. */
async function both(base: FileTable, p: FileTable, pk: SideKey, q: FileTable, qk: SideKey, choices?: FineChoices) {
  const one = await mt(base, p, q, pk, qk, choices);
  const two = await mt(base, q, p, qk, pk, choices && swap(choices));
  expect(text(two.value)).toBe(text(one.value));
  expect(two.conflicts.map((c) => c.id).sort()).toEqual(one.conflicts.map((c) => c.id).sort());
  return one;
}

/** Re-combining a result with the given sides changes nothing, whichever computer is first (T7). */
async function stable(base: FileTable, sides: FileTable[], res: FileTable) {
  for (const s of sides) {
    for (const [x, y] of [[res, s], [s, res]] as const) {
      for (const [kx, ky] of [[KA, KB], [KB, KA]] as const) {
        const again = await mt(base, x, y, kx, ky);
        expect(again.conflicts).toEqual([]);
        expect(text(again.value)).toBe(text(res));
      }
    }
  }
}

describe("RV2-1 three computers type into the same last blank row", () => {
  for (const [template, titled] of [["grouped", false], ["grouped", true], ["column", false], ["xy", false]] as const) {
    it(`${template}${titled ? " with row titles" : ""}: three entries, three rows; never two in one`, async () => {
      const b = await ft(nineDoc(template));
      const R = b.row_ids[9];
      const label = (d: GraphDoc, v: string) => { if (template === "xy") d.x[9] = v; if (titled) d.row_titles[9] = "M" + v; };
      const lab = (v: string) => (template === "xy" ? v : titled ? "M" + v : "");
      // L (d-3333) saves first; K1 and K2 each combine with L's version before they see each other.
      const l = await edit(b, (d) => { label(d, "7"); d.cells[9][0][0] = "7"; });
      const k1 = await edit(b, (d) => { label(d, "5"); d.cells[9][0][0] = "5"; });
      const k2 = await edit(b, (d) => { label(d, "3"); d.cells[9][1][0] = "3"; });
      const c1 = (await both(b, k1, K1, l, KL)).value!, c2 = (await both(b, k2, K2, l, KL)).value!;
      expect(row(c1, R)).toEqual([lab("5"), "5", ""]);
      expect(row(c2, R)).toEqual([lab("3"), "", "3"]);
      // Both moved L's entry to the same row.
      expect(c1.row_ids[10]).toBe(c2.row_ids[10]);
      const X = c1.row_ids[10];
      // Then their versions are combined; the common version is L's.
      const KC1: SideKey = { deviceId: "d-1111", revisionId: "r-c1" }, KC2: SideKey = { deviceId: "d-2222", revisionId: "r-c2" };
      const res = await both(l, c1, KC1, c2, KC2);
      expect(res.conflicts).toEqual([]);
      const v = res.value!;
      expect(dataRows(v).slice(9)).toEqual([[lab("5"), "5", ""], [lab("3"), "", "3"], [lab("7"), "7", ""]]);
      expect(row(v, R)).toEqual([lab("5"), "5", ""]);
      expect(row(v, X)).toEqual([lab("7"), "7", ""]);
      expect(res.rowNotes?.split).toEqual([R]);
      // The two new rows are an order to check (where order means something).
      expect(res.orderChecks).toEqual([{ axis: "row", ids: [R, v.row_ids[10]], matters: template !== "column" }]);
      await stable(l, [c1, c2], v);
      // Through the whole combine (all sections) as well.
      const secs = async (t: FileTable) => clone((await normaliseSections({ ...sampleSections(template), table: t, scratchpad: null }))!.sections);
      const p = await combineFine({ base: await secs(l), baseKind: "lca", mine: await secs(c1), theirs: await secs(c2), mineKey: KC1, theirsKey: KC2 });
      if (!p.ok) throw new Error("combine failed");
      expect(p.sections.find((s) => s.key === "table")!.conflicts).toEqual([]);
      expect(text(p.result!.sections.table as FileTable)).toBe(text(v));
    });
  }

  it("the two later computers typed the same: one row for that entry, L's in its own", async () => {
    const b = await ft(nineDoc("grouped"));
    const R = b.row_ids[9];
    const l = await edit(b, (d) => { d.cells[9][0][0] = "7"; });
    const k = await edit(b, (d) => { d.cells[9][0][0] = "5"; });
    const c1 = (await both(b, k, K1, l, KL)).value!, c2 = (await both(b, k, K2, l, KL)).value!;
    const res = await both(l, c1, K1, c2, K2);
    expect(res.conflicts).toEqual([]);
    expect(dataRows(res.value!).slice(9)).toEqual([["", "5", ""], ["", "7", ""]]);
    expect(row(res.value!, R)).toEqual(["", "5", ""]);
  });

  it("only one of them changed its own row afterwards: the moved row keeps its own common version", async () => {
    // Both moved L's entry to X; neither then had anything else in R that differs: X is combined against L's row R.
    const b = await ft(nineDoc("grouped"));
    const l = await edit(b, (d) => { d.cells[9][0][0] = "7"; });
    const k = await edit(b, (d) => { d.cells[9][0][0] = "5"; });
    const c = (await both(b, k, K1, l, KL)).value!;
    const X = c.row_ids[10];
    const c1 = await edit(c, (d) => { d.cells[at(d, X)][1][0] = "77"; });
    const c2 = await edit(c, (d) => { d.cells[at(d, X)][0][0] = "7.5"; });
    const res = await both(l, c1, K1, c2, K2);
    expect(res.conflicts).toEqual([]);
    expect(row(res.value!, X)).toEqual(["", "7.5", "77"]);
    await stable(l, [c1, c2], res.value!);
  });
});

describe("RV2-2 the computer whose entry moved deletes it", () => {
  /** Both typed into the blank row 10: A (d-1111) "Mouse 7 / 5", B "Mouse 9 / 7"; B's entry moves. */
  async function story() {
    const b = await ft(nineDoc("grouped"));
    const R = b.row_ids[9];
    const x = await edit(b, (d) => { d.row_titles[9] = "Mouse 7"; d.cells[9][0][0] = "5"; });
    const y = await edit(b, (d) => { d.row_titles[9] = "Mouse 9"; d.cells[9][0][0] = "7"; });
    const r = (await mt(b, x, y, KA, KB)).value!;
    return { b, x, y, r, R, X: r.row_ids[10] };
  }

  it("combining the result again with the combined version changes nothing (the entry was not shown twice)", async () => {
    const { y, r, R, X } = await story();
    const y4 = await edit(y, (d) => deleteRow(d, 9));
    const res = await both(y, y4, KB, r, KR);
    expect(res.conflicts).toEqual([]);
    expect(row(res.value!, R)).toEqual(["Mouse 7", "5", ""]);
    expect(row(res.value!, X)).toBe(null);
    await stable(y, [r], res.value!);
    // The keeper went on as well (from the combined version): still one row for its entry, whichever version is
    // taken as the common one.
    const r2 = await edit(r, (d) => { d.cells[at(d, R)][1][0] = "55"; });
    for (const base of [r, y]) {
      const again = await both(base, res.value!, KB, r2, KA);
      expect(again.conflicts).toEqual([]);
      expect(dataRows(again.value!).slice(9)).toEqual([["Mouse 7", "5", "55"]]);
    }
  });

  it("the moved row changed on the other computer after B deleted it: one question about that row", async () => {
    const { y, r, X } = await story();
    const y4 = await edit(y, (d) => deleteRow(d, 9));
    const res = (await both(y, y4, KB, r, KR)).value!;
    const r2 = await edit(r, (d) => { d.cells[at(d, X)][1][0] = "99"; });
    const again = await both(y, res, KB, r2, KA);
    expect(again.conflicts.map((c) => [c.id, c.kind])).toEqual([[`table:row:${X}`, "rowDeleted"]]);
  });
});

describe("RV2-4 the safety net: never two entries in one row", () => {
  it("one side put another entry into a row (no value of the base's left) while the other added to it: one whole-row choice", async () => {
    // Seed 16709181: the base's row holds entry 5; one side has entry 4 there, the other added a value to entry 5.
    const b = await ft(nineDoc("grouped"));
    const R = b.row_ids[3];
    const m = await edit(b, (d) => { d.row_titles[3] = "entry 4"; d.cells[3][0][0] = "4.1"; d.cells[3][1][0] = "4.2"; });
    const t = await edit(b, (d) => { d.cells[3][1][0] = "-3.5"; d.row_titles[3] = "g3"; });
    const t2 = await edit(b, (d) => { d.cells[3][1][0] = ""; });      // clears a value instead
    for (const [theirs, want] of [[t, ["g3", "3", "-3.5"]], [t2, ["g3", "3", ""]]] as const) {
      const res = await both(b, m, KA, theirs, KB);
      expect(res.conflicts.map((c) => c.id)).toEqual([`table:row:${R}`]);
      for (const side of ["mine", "theirs"] as const) {
        const done = await both(b, m, KA, theirs, KB, { [`table:row:${R}`]: side });
        expect(row(done.value!, R)).toEqual(side === "mine" ? ["entry 4", "4.1", "4.2"] : want);
      }
    }
  });

  it("a column only one side has is part of that whole-row choice", async () => {
    const b = await ft(nineDoc("grouped"));
    const R = b.row_ids[3];
    const m = await edit(b, (d) => { const e = insertCol(d, 2); e.row_titles[3] = "entry 4"; e.cells[3][0][0] = "4.1"; e.cells[3][1][0] = "4.2"; e.cells[3][2][0] = "4.3"; return e; });
    const t = await edit(b, (d) => { d.cells[3][1][0] = "-3.5"; });
    const res = await both(b, m, KA, t, KB);
    expect(res.conflicts.map((c) => c.id)).toEqual([`table:row:${R}`]);
    const theirs = await both(b, m, KA, t, KB, { [`table:row:${R}`]: "theirs" });
    const v = theirs.value!;
    expect(v.cells[at(v, R)].map((reps) => reps[0])).toEqual(["3", "-3.5", ""]);
    expect(v.row_titles[at(v, R)]).toBe("g3");
    // Other rows keep the new column's values.
    expect(v.col_ids).toHaveLength(3);
  });

  it("a moved row that still holds what was moved is found when the other row R has another entry (seed 16622007)", async () => {
    // L's entry (4.1 / 4.2) was typed into blank row R, changed to 4.1 / 4.4, then moved by a combine (K's entry
    // stays in R). Another computer, from the version with 4.1 / 4.2, changes the entry's A to 4.5.
    const b0 = await ft(nineDoc("xy"));
    const R = b0.row_ids[9];
    const lEntry = await edit(b0, (d) => { d.x[9] = "4.1"; d.cells[9][0][0] = "4.2"; d.cells[9][1][0] = "4.3"; });
    const l2 = await edit(lEntry, (d) => { d.cells[9][1][0] = "4.4"; });
    const k = await edit(b0, (d) => { d.x[9] = "5.1"; d.cells[9][0][0] = "5.3"; d.cells[9][1][0] = "5.2"; });
    const r = (await mt(b0, k, l2, KA, KB)).value!;      // K is the first side: its entry stays in R
    expect(row(r, R)).toEqual(["5.1", "5.3", "5.2"]);
    const X = r.row_ids[10];
    const o = await edit(lEntry, (d) => { d.cells[9][0][0] = "4.5"; });
    const res = await both(lEntry, o, KB, r, KR);
    expect(res.conflicts).toEqual([]);
    expect(row(res.value!, R)).toEqual(["5.1", "5.3", "5.2"]);
    expect(row(res.value!, X)).toEqual(["4.1", "4.5", "4.4"]);
  });

  it("a row the base lacks that both have with no value in common: one whole-row choice", async () => {
    // A blank row was deleted on the way to the base, and both sides typed a different entry into it.
    const b0 = await ft(nineDoc("column"));
    const R = b0.row_ids[9];
    const base = await edit(b0, (d) => deleteRow(d, 9));
    const m = await edit(b0, (d) => { d.cells[9][0][0] = "8.1"; });
    const t = await edit(b0, (d) => { d.cells[9][1][0] = "9.1"; });
    const res = await both(base, m, KA, t, KB);
    expect(res.conflicts.map((c) => c.id)).toEqual([`table:row:${R}`]);
    for (const side of ["mine", "theirs"] as const) {
      const done = await both(base, m, KA, t, KB, { [`table:row:${R}`]: side });
      expect(row(done.value!, R)).toEqual(side === "mine" ? ["", "8.1", ""] : ["", "", "9.1"]);
    }
  });

  it("ordinary edits still combine by themselves", async () => {
    const b = await ft(nineDoc("grouped"));
    const R = b.row_ids[3];
    // Two people fixing different values of an existing entry.
    const m = await edit(b, (d) => { d.cells[3][0][0] = "3.1"; });
    const t = await edit(b, (d) => { d.cells[3][1][0] = "-3.1"; });
    const r1 = await both(b, m, KA, t, KB);
    expect(r1.conflicts).toEqual([]);
    expect(row(r1.value!, R)).toEqual(["g3", "3.1", "-3.1"]);
    // One fixes every value (the title too), the other made the same fix to one of them.
    const m2 = await edit(b, (d) => { d.row_titles[3] = "G3"; d.cells[3][0][0] = "3.1"; d.cells[3][1][0] = "-3.1"; });
    const t2 = await edit(b, (d) => { d.cells[3][0][0] = "3.1"; });
    const r2 = await both(b, m2, KA, t2, KB);
    expect(r2.conflicts).toEqual([]);
    expect(row(r2.value!, R)).toEqual(["G3", "3.1", "-3.1"]);
    // A row with one value: fixing it while the other adds a value is not taken for another entry.
    const one = await edit(b, (d) => { d.row_titles[3] = ""; d.cells[3][1][0] = ""; });
    const m3 = await edit(one, (d) => { d.cells[3][0][0] = "33"; });
    const t3 = await edit(one, (d) => { d.cells[3][1][0] = "-33"; });
    const r3 = await both(one, m3, KA, t3, KB);
    expect(r3.conflicts).toEqual([]);
    expect(row(r3.value!, R)).toEqual(["", "33", "-33"]);
    // A row without a label (a column table): one fixes both its values, the other adds one: combined by itself.
    const c0 = await ft(insertCol(nineDoc("column"), 2));
    const C = c0.row_ids[3];
    const m5 = await edit(c0, (d) => { d.cells[3][0][0] = "3.5"; d.cells[3][1][0] = "-3.5"; });
    const t5 = await edit(c0, (d) => { d.cells[3][2][0] = "new"; });
    const r5 = await both(c0, m5, KA, t5, KB);
    expect(r5.conflicts).toEqual([]);
    expect(r5.value!.cells[at(r5.value!, C)].map((reps) => reps[0])).toEqual(["3.5", "-3.5", "new"]);
    // Combining a combined version with one side again: still nothing to ask.
    const res = await both(b, m, KA, t, KB);
    await stable(b, [m, t], res.value!);
  });
});
