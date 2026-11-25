/* Fixer round 2, finding RV-1 (phase 4 contract §2.2.2, "CHANGED BY fixer round 2"): a row both computers typed
   into is split by the first combine (M1): one computer's entry stays in the row, the other's moves to a new row.
   When the computer whose entry moved keeps typing into what it still sees as its row before the combined version
   reaches it, the next combine must put those values into the moved row, not into the other computer's entry.
   Each case here failed on the code before the fix (the values were combined into the wrong row without a
   question, or a deleted row was asked about). RV-3: such a row is listed as a row added on each side. */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GraphDoc, Template } from "../../../api/graph";
import { deleteRow, ensureRows, insertRow } from "../graphModel";
import { LIMITS_P4, type FineChoices, type SideKey, type TableMerge } from "./contract";
import { canonicalJson } from "./format";
import { normaliseSections } from "./graphMerge";
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
  const nRep = template === "column" ? 1 : 1;
  return ensureRows({
    v: 1, template, col_titles: ["A", "B"], x_title: "X", n_rep: nRep,
    row_titles: Array.from({ length: 10 }, (_, i) => (template === "grouped" && i < 9 ? `g${i}` : "")),
    x: Array.from({ length: 10 }, (_, i) => (template === "xy" && i < 9 ? String(i) : "")),
    cells: Array.from({ length: 10 }, (_, i) => (i < 9 ? [[String(i)], [String(-i)]] : [[""], [""]])),
    row_ids: Array.from({ length: 10 }, (_, i) => rid(i)),
    col_ids: [cid(0), cid(1)],
  });
}

async function ft(d: GraphDoc): Promise<FileTable> {
  const s = sampleSections(d.template);
  const n = await normaliseSections({ ...s, table: { ...d, v: 2 }, scratchpad: null });
  if (!n) throw new Error("not a document");
  return clone(n.sections.table) as FileTable;
}
async function edit(t: FileTable, f: (d: GraphDoc) => GraphDoc | void): Promise<FileTable> {
  const d = clone({ ...t, v: 1 }) as unknown as GraphDoc;
  return ft(ensureRows(f(d) ?? d));
}
const at = (d: { row_ids: string[] }, id: string) => d.row_ids.indexOf(id);
const text = (t: FileTable | null) => (t ? canonicalJson(t) : "null");

async function sha(s: string): Promise<string> {
  const buf = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
/** The id of the split row (§2.2.2, M1), computed by hand. */
const splitId = async (rowId: string, title: string, x: string, cells: [string, number, string][], n = 0) =>
  "row-" + (await sha(`las-split\n${rowId}\n${JSON.stringify([title, x, cells])}${n ? `\n${n}` : ""}`)).slice(0, LIMITS_P4.fillIdHex);

const KA: SideKey = { deviceId: "d-1111", revisionId: "r-01JX" };
const KB: SideKey = { deviceId: "d-2222", revisionId: "r-01JY" };
const KR: SideKey = { deviceId: "", revisionId: "r-m-combined" };
const mt = (base: FileTable, mine: FileTable, theirs: FileTable, mineKey: SideKey, theirsKey: SideKey, choices?: FineChoices): Promise<TableMerge> =>
  mergeTable({ base, mine, theirs, mineKey, theirsKey }, choices);

/** Row (title / x, column A, column B) of a table by id. */
const row = (t: FileTable, id: string) => {
  const i = at(t, id);
  return i < 0 ? null : [t.template === "xy" ? t.x[i] : t.row_titles[i], t.cells[i][0][0], t.cells[i][1][0]];
};

/** The label each computer types into the row: grouped a title, XY an X value, column none. */
const labelOf = (template: Template, who: "a" | "b") =>
  template === "grouped" ? (who === "a" ? "Mouse 7" : "Mouse 9") : template === "xy" ? (who === "a" ? "7" : "9") : "";

/** Both computers typed into the blank row 10: A (d-1111, the first side) "Mouse 7 / 5", B "Mouse 9 / 7" (in
 *  column A). Returns the base, both sides, the combined version and the moved row's id. */
async function splitStory(template: Template) {
  const b = await ft(nineDoc(template));
  const R = b.row_ids[9];
  const label = (v: string) => (d: GraphDoc) => { if (template === "xy") d.x[9] = v; else if (template === "grouped") d.row_titles[9] = v; };
  const x = await edit(b, (d) => { label(labelOf(template, "a"))(d); d.cells[9][0][0] = "5"; });
  const y = await edit(b, (d) => { label(labelOf(template, "b"))(d); d.cells[9][0][0] = "7"; });
  const r = await mt(b, x, y, KA, KB);
  expect(r.conflicts).toEqual([]);
  const X = await splitId(R, template === "grouped" ? labelOf(template, "b") : "", template === "xy" ? labelOf(template, "b") : "", [[cid(0), 0, "7"]]);
  expect(r.value!.row_ids[10]).toBe(X);
  return { b, x, y, r: r.value!, R, X };
}

/** A combine seen from both computers (either one is mine): the same bytes, conflicts and row notes. */
async function both(base: FileTable, p: FileTable, pk: SideKey, q: FileTable, qk: SideKey, choices?: FineChoices) {
  const one = await mt(base, p, q, pk, qk, choices);
  const swapped = choices && Object.fromEntries(Object.entries(choices).map(([k, v]) => [k, v === "mine" ? "theirs" : v === "theirs" ? "mine" : v]));
  const two = await mt(base, q, p, qk, pk, swapped as FineChoices | undefined);
  expect(text(two.value)).toBe(text(one.value));
  expect(two.conflicts.map((c) => c.id).sort()).toEqual(one.conflicts.map((c) => c.id).sort());
  expect(two.rowNotes?.split ?? []).toEqual(one.rowNotes?.split ?? []);
  expect((two.rowNotes?.moved ?? []).map((m) => [m.id, m.was])).toEqual((one.rowNotes?.moved ?? []).map((m) => [m.id, m.was]));
  return one;
}

/** Re-combining a result with either side changes nothing (T7). */
async function stable(base: FileTable, p: FileTable, q: FileTable, res: FileTable) {
  for (const [x, y] of [[res, p], [res, q], [p, res], [q, res]] as const) {
    for (const [kx, ky] of [[KA, KB], [KB, KA]] as const) {
      const again = await mt(base, x, y, kx, ky);
      expect(again.conflicts).toEqual([]);
      expect(text(again.value)).toBe(text(res));
    }
  }
}

describe("RV-1 the computer whose entry moved keeps typing into its row", () => {
  for (const template of ["grouped", "xy", "column"] as const) {
    it(`${template}: its new value lands in its own (moved) row, not in the other computer's entry; no question`, async () => {
      const { y, r, R, X } = await splitStory(template);
      const y2 = await edit(y, (d) => { d.cells[9][1][0] = "77"; });
      const res = await both(y, y2, KB, r, KR);
      expect(res.conflicts).toEqual([]);
      const v = res.value!;
      expect(row(v, R)).toEqual([labelOf(template, "a"), "5", ""]);
      expect(row(v, X)).toEqual([labelOf(template, "b"), "7", "77"]);
      expect(at(v, X)).toBe(at(v, R) + 1);
      expect(res.rowNotes?.moved).toEqual([{ id: X, was: R, side: "mine" }]);
      expect(res.orderChecks).toEqual([]);
      await stable(y, y2, r, v);
    });
  }

  it("the same cell typed again: the new value replaces its own entry's, not the other computer's", async () => {
    const { y, r, R, X } = await splitStory("grouped");
    const y3 = await edit(y, (d) => { d.cells[9][0][0] = "8"; });
    const res = await both(y, y3, KB, r, KR);
    expect(res.conflicts).toEqual([]);
    expect(row(res.value!, R)).toEqual(["Mouse 7", "5", ""]);
    expect(row(res.value!, X)).toEqual(["Mouse 9", "8", ""]);
  });

  it("its row title changed: it stays with its own values", async () => {
    const { y, r, R, X } = await splitStory("grouped");
    const y3 = await edit(y, (d) => { d.row_titles[9] = "Mouse 9b"; });
    const res = await both(y, y3, KB, r, KR);
    expect(res.conflicts).toEqual([]);
    expect(row(res.value!, R)).toEqual(["Mouse 7", "5", ""]);
    expect(row(res.value!, X)).toEqual(["Mouse 9b", "7", ""]);
  });

  it("it deletes its row: its entry is gone, the other computer's stays; nothing to ask", async () => {
    const { y, r, R, X } = await splitStory("grouped");
    const y4 = await edit(y, (d) => deleteRow(d, 9));
    const res = await both(y, y4, KB, r, KR);
    expect(res.conflicts).toEqual([]);
    expect(row(res.value!, R)).toEqual(["Mouse 7", "5", ""]);
    expect(row(res.value!, X)).toBe(null);
  });

  it("both go on: the other computer (having the combined version) edits its row, this one edits its own", async () => {
    const { y, r, R, X } = await splitStory("grouped");
    const a2 = await edit(r, (d) => { d.cells[at(d, R)][1][0] = "55"; });
    const y2 = await edit(y, (d) => { d.cells[9][1][0] = "77"; });
    const res = await both(y, y2, KB, a2, KA);
    expect(res.conflicts).toEqual([]);
    expect(row(res.value!, R)).toEqual(["Mouse 7", "5", "55"]);
    expect(row(res.value!, X)).toEqual(["Mouse 9", "7", "77"]);
    await stable(y, y2, a2, res.value!);
  });

  it("both change the same value of the moved row: one choice about that row, its title stays", async () => {
    const { y, r, R, X } = await splitStory("grouped");
    const a2 = await edit(r, (d) => { d.cells[at(d, X)][1][0] = "AA"; });
    const y2 = await edit(y, (d) => { d.cells[9][1][0] = "77"; });
    const res = await both(y, y2, KB, a2, KA);
    expect(res.conflicts.map((c) => [c.id, c.kind])).toEqual([[`table:row:${X}`, "row"]]);
    for (const side of ["mine", "theirs"] as const) {
      const done = await mt(y, y2, a2, KB, KA, { [`table:row:${X}`]: side });
      expect(row(done.value!, R)).toEqual(["Mouse 7", "5", ""]);
      expect(row(done.value!, X)).toEqual(["Mouse 9", "7", side === "mine" ? "77" : "AA"]);
    }
  });

  it("the keeper going on is unchanged: its values stay in the row it kept", async () => {
    const { x, r, R, X } = await splitStory("grouped");
    const x2 = await edit(x, (d) => { d.cells[9][1][0] = "55"; });
    const res = await both(x, x2, KA, r, KR);
    expect(res.conflicts).toEqual([]);
    expect(res.rowNotes).toBeUndefined();
    expect(row(res.value!, R)).toEqual(["Mouse 7", "5", "55"]);
    expect(row(res.value!, X)).toEqual(["Mouse 9", "7", ""]);
  });

  it("a chain: it types again before either combined version reaches it", async () => {
    const { y, r, R, X } = await splitStory("grouped");
    const y2 = await edit(y, (d) => { d.cells[9][1][0] = "77"; });
    const r2 = (await both(y, y2, KB, r, KR)).value!;
    // y3 follows y2 (it still has not seen r or r2); r2's parents are r and y2, so the base is y2.
    const y3 = await edit(y2, (d) => { d.row_titles[9] = "Mouse 9 (left)"; d.cells[9][0][0] = "7.5"; });
    const res = await both(y2, y3, KB, r2, KR);
    expect(res.conflicts).toEqual([]);
    expect(row(res.value!, R)).toEqual(["Mouse 7", "5", ""]);
    expect(row(res.value!, X)).toEqual(["Mouse 9 (left)", "7.5", "77"]);
    expect(res.rowNotes?.moved).toEqual([{ id: X, was: R, side: "mine" }]);
    await stable(y2, y3, r2, res.value!);
    // …and once more.
    const y4 = await edit(y3, (d) => { d.cells[9][1][0] = "78"; });
    const r3 = res.value!;
    const res2 = await both(y3, y4, KB, r3, KR);
    expect(res2.conflicts).toEqual([]);
    expect(row(res2.value!, R)).toEqual(["Mouse 7", "5", ""]);
    expect(row(res2.value!, X)).toEqual(["Mouse 9 (left)", "7.5", "78"]);
  });

  it("a chain where the other computer also changed the moved row: still found (it is the row most like this one's)", async () => {
    const { y, r, R, X } = await splitStory("grouped");
    const y2 = await edit(y, (d) => { d.cells[9][1][0] = "77"; });
    const r2 = (await both(y, y2, KB, r, KR)).value!;
    const a3 = await edit(r2, (d) => { d.cells[at(d, X)][0][0] = "7.1"; });      // A corrects B's first value
    const y3 = await edit(y2, (d) => { d.cells[9][1][0] = "78"; });              // B corrects its second one
    const res = await both(y2, y3, KB, a3, KA);
    expect(res.conflicts).toEqual([]);
    expect(row(res.value!, R)).toEqual(["Mouse 7", "5", ""]);
    expect(row(res.value!, X)).toEqual(["Mouse 9", "7.1", "78"]);
    await stable(y2, y3, a3, res.value!);
  });

  it("a chain where the moved row was changed beyond telling: the row is one choice as a whole, never mixed", async () => {
    const { y, r, R, X } = await splitStory("grouped");
    const y2 = await edit(y, (d) => { d.cells[9][1][0] = "77"; });
    const r2 = (await both(y, y2, KB, r, KR)).value!;
    // A rewrites B's row completely; B goes on typing into what it sees as its row.
    const a3 = await edit(r2, (d) => { const i = at(d, X); d.row_titles[i] = "Mouse 10"; d.cells[i][0][0] = "1"; d.cells[i][1][0] = "2"; });
    const y3 = await edit(y2, (d) => { d.cells[9][1][0] = "78"; });
    const res = await both(y2, y3, KB, a3, KA);
    expect(res.conflicts.map((c) => c.id)).toEqual([`table:row:${R}`]);
    expect(res.conflicts[0].items.map((i) => i.what)).toEqual(["rowTitle", "cell", "cell"]);
    for (const side of ["mine", "theirs"] as const) {
      const done = await mt(y2, y3, a3, KB, KA, { [`table:row:${R}`]: side });
      expect(row(done.value!, R)).toEqual(side === "mine" ? ["Mouse 9", "7", "78"] : ["Mouse 7", "5", ""]);
      expect(row(done.value!, X)).toEqual(["Mouse 10", "1", "2"]);
    }
  });

  it("the moved row got the \"\\n1\" id (the plain one was taken): found all the same", async () => {
    // The base already has a row with the id the split would take, so the split row gets the "\n1" id.
    const plain = await splitId(rid(9), "Mouse 9", "", [[cid(0), 0, "7"]]);
    const d0 = nineDoc("grouped");
    d0.row_ids[0] = plain;
    const b = await ft(d0);
    const R = b.row_ids[9];
    const x = await edit(b, (d) => { d.row_titles[9] = "Mouse 7"; d.cells[9][0][0] = "5"; });
    const y = await edit(b, (d) => { d.row_titles[9] = "Mouse 9"; d.cells[9][0][0] = "7"; });
    const r = (await mt(b, x, y, KA, KB)).value!;
    const X1 = await splitId(R, "Mouse 9", "", [[cid(0), 0, "7"]], 1);
    expect(r.row_ids[10]).toBe(X1);
    // The plain id is somebody else's row: deleting it on the other side changes nothing about the move.
    const y2 = await edit(y, (d) => { d.cells[9][1][0] = "77"; });
    const res = await both(y, y2, KB, r, KR);
    expect(res.conflicts).toEqual([]);
    expect(row(res.value!, R)).toEqual(["Mouse 7", "5", ""]);
    expect(row(res.value!, X1)).toEqual(["Mouse 9", "7", "77"]);
    expect(row(res.value!, plain)).toEqual(["g0", "0", "0"]);
  });

  it("the computer whose entry moved is the first side (other device ids): the same", async () => {
    // B (d-0000) is now the first side, so its entry stays and A's moves; A keeps typing.
    const KF: SideKey = { deviceId: "d-0000", revisionId: "r-01JY" };
    const b = await ft(nineDoc("grouped"));
    const R = b.row_ids[9];
    const x = await edit(b, (d) => { d.row_titles[9] = "Mouse 7"; d.cells[9][0][0] = "5"; });
    const y = await edit(b, (d) => { d.row_titles[9] = "Mouse 9"; d.cells[9][0][0] = "7"; });
    const r = (await mt(b, x, y, KA, KF)).value!;
    const X = await splitId(R, "Mouse 7", "", [[cid(0), 0, "5"]]);
    expect(row(r, R)).toEqual(["Mouse 9", "7", ""]);
    expect(row(r, X)).toEqual(["Mouse 7", "5", ""]);
    const x2 = await edit(x, (d) => { d.cells[9][1][0] = "55"; });
    const res = await both(x, x2, KA, r, KR);
    expect(res.conflicts).toEqual([]);
    expect(row(res.value!, R)).toEqual(["Mouse 9", "7", ""]);
    expect(row(res.value!, X)).toEqual(["Mouse 7", "5", "55"]);
    expect(res.rowNotes?.moved).toEqual([{ id: X, was: R, side: "mine" }]);
  });

  it("nothing changes when nobody moved a row: a copied row with an editor id is an ordinary added row", async () => {
    const b = await ft(nineDoc("grouped"));
    const R = b.row_ids[3];
    // Mine inserts a copy of row 4 below it and changes row 4; theirs changes row 4 as well.
    const m = await edit(b, (d) => {
      const e = insertRow(d, 4);
      e.row_titles[4] = e.row_titles[3]; e.cells[4] = e.cells[3].map((reps) => [...reps]);
      e.cells[3][0][0] = "m";
      return e;
    });
    const t = await edit(b, (d) => { d.cells[3][1][0] = "t"; });
    const res = await mt(b, m, t, KA, KB);
    expect(res.rowNotes).toBeUndefined();
    expect(row(res.value!, R)).toEqual(["g3", "m", "t"]);
  });
});
