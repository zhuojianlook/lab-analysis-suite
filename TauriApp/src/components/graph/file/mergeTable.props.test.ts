/* Phase 4 contract §8 T1–T7, T12 — properties of the table combine over
   generated documents (all three templates and the fixtures), with random
   edits on two sides from a common version: cells, row titles, X, column
   titles, the X title, add / insert / delete row, add / delete column, the
   replicate count, typing into the trailing blank row. Seeded (mulberry32,
   no fast-check in this project); every run is the same. The expected result
   is worked out here independently, place by place, from the sides. */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GraphDoc, Template } from "../../../api/graph";
import {
  ID_RE, MAX_COLS, MIN_ROWS, deleteCol, deleteRow, ensureRows, insertCol, insertRow, isBlank, repairIdList, setNRep,
} from "../graphModel";
import type { FineChoices, SideKey, TableMerge } from "./contract";
import { canonicalJson } from "./format";
import { normaliseSections } from "./graphMerge";
import type { FileTable } from "./idMap";
import { mergeTable } from "./mergeTable";
import { allBases, clone, countingIds, sampleSections } from "./fixtures-p2/docs";
import { rng, type Rng } from "./fixtures-p2/kit";

let restoreIds: () => void;
beforeAll(() => { restoreIds = countingIds(); });
afterAll(() => restoreIds());

// ── documents ───────────────────────────────────────────────────────────────

async function ft(d: GraphDoc): Promise<FileTable> {
  const n = await normaliseSections({ ...sampleSections(d.template), table: { ...d, v: 2 }, scratchpad: null });
  if (!n) throw new Error("not a document");
  return clone(n.sections.table) as FileTable;
}
const open = (t: FileTable): GraphDoc => clone({ ...t, v: 1 }) as unknown as GraphDoc;
const text = (t: FileTable | null) => (t ? canonicalJson(t) : "null");

function randomBase(r: Rng): GraphDoc {
  const template = r.pick(["column", "grouped", "xy"] as const);
  const nCols = 1 + r.int(4), nRep = template === "column" ? 1 : 1 + r.int(3), nRows = 2 + r.int(10);
  const val = () => (r.chance(0.85) ? String(r.int(1000) / 10) : "");
  return ensureRows({
    v: 1, template, n_rep: nRep, x_title: r.chance(0.5) ? "X" : "Dose",
    col_titles: Array.from({ length: nCols }, (_, c) => `C${c}`),
    row_titles: Array.from({ length: nRows }, (_, i) => (template === "grouped" && r.chance(0.7) ? `${i} h` : "")),
    x: Array.from({ length: nRows }, () => (template === "xy" ? val() : "")),
    // Now and then a blank row in the middle.
    cells: Array.from({ length: nRows }, () => { const blank = r.chance(0.1); return Array.from({ length: nCols }, () => Array.from({ length: nRep }, () => (blank ? "" : val()))); }),
    row_ids: repairIdList([], nRows, "row"),
    col_ids: repairIdList([], nCols, "col"),
  });
}

let token = 0;
const fresh = (tag: string) => `${tag}${(token++).toString(36)}`;

type Op = "cell" | "clear" | "rowTitle" | "x" | "colTitle" | "xTitle" | "insertRow" | "addRow" | "deleteRow" | "insertCol" | "deleteCol" | "nRep" | "typeTail" | "move";
const OPS: Op[] = ["cell", "cell", "cell", "clear", "rowTitle", "x", "colTitle", "xTitle", "insertRow", "addRow", "deleteRow", "insertCol", "deleteCol", "nRep", "typeTail", "typeTail"];

/** One random edit, as the editor makes it (open form, ensureRows after). */
function applyOp(r: Rng, d: GraphDoc, op: Op, tag: string): GraphDoc {
  const nR = d.cells.length, nC = d.col_titles.length;
  switch (op) {
    case "cell": case "clear": {
      d.cells[r.int(nR)][r.int(nC)][r.int(d.n_rep)] = op === "clear" ? "" : fresh(tag);
      return d;
    }
    case "rowTitle": d.row_titles[r.int(nR)] = fresh(tag); return d;
    case "x": if (d.template === "xy") d.x[r.int(nR)] = fresh(tag); return d;
    case "colTitle": d.col_titles[r.int(nC)] = fresh(tag); return d;
    case "xTitle": d.x_title = fresh(tag); return d;
    case "insertRow": case "addRow": {
      const at = op === "addRow" ? nR : r.int(nR + 1);
      const e = insertRow(d, at);
      if (r.chance(0.8)) e.cells[Math.min(at, e.cells.length - 1)][r.int(nC)][r.int(e.n_rep)] = fresh(tag);
      return e;
    }
    case "deleteRow": return nR > 1 ? deleteRow(d, r.int(nR)) : d;
    case "insertCol": {
      if (nC >= 6) return d;
      const at = r.int(nC + 1);
      const e = insertCol(d, at);
      if (r.chance(0.7)) e.cells[r.int(e.cells.length)][at][0] = fresh(tag);
      return e;
    }
    case "deleteCol": return deleteCol(d, r.int(nC));
    case "nRep": return d.template === "column" ? d : setNRep(d, 1 + r.int(4));
    case "typeTail": {
      // Type into the first row without data at the end (the shared blank row).
      let i = d.cells.length;
      while (i > 0 && !d.cells[i - 1].some((reps) => reps.some((v) => !isBlank(v))) && isBlank(d.row_titles[i - 1]) && isBlank(d.x[i - 1])) i--;
      if (i >= d.cells.length) return d;
      d.cells[i][r.int(nC)][r.int(d.n_rep)] = fresh(tag);
      return ensureRows(d);
    }
    case "move": {
      // Not something the editor can do (there is no "move row"): swap two neighbouring rows.
      if (nR < 2) return d;
      const i = r.int(nR - 1);
      for (const k of ["cells", "row_titles", "x", "row_ids"] as const) {
        const a = d[k] as unknown[];
        [a[i], a[i + 1]] = [a[i + 1], a[i]];
      }
      return d;
    }
  }
}

async function edited(r: Rng, t: FileTable, tag: string, ops: Op[] = OPS, n = 1 + r.int(5)): Promise<FileTable> {
  let d = open(t);
  for (let i = 0; i < n; i++) d = ensureRows(applyOp(r, d, r.pick(ops), tag));
  return ft(d);
}

const DEVICES = ["d-a", "d-b", "d-B", "d-a"];
const randomKey = (r: Rng): SideKey => ({ deviceId: r.pick(DEVICES), revisionId: `r-${r.int(5)}` });
/** Two keys of two different versions (equal device ids happen; equal version ids do not). */
function twoKeys(r: Rng): [SideKey, SideKey] {
  const a = randomKey(r);
  let b = randomKey(r);
  while (b.revisionId === a.revisionId) b = randomKey(r);
  return [a, b];
}

/** One case: base, two sides (sometimes through a shared intermediate version, so both have the same new rows). */
async function randomCase(r: Rng, bases: FileTable[], ops: Op[] = OPS) {
  const b = bases.length && r.chance(0.3) ? r.pick(bases) : await ft(randomBase(r));
  const from = r.chance(0.2) ? await edited(r, b, "z", ops) : b;
  let x = r.chance(0.08) ? from : await edited(r, from, "m", ops);
  let y = r.chance(0.08) ? from : r.chance(0.08) ? x : await edited(r, from, "t", ops);
  // Now and then the two sides meet on purpose: one deletes a row / column of the common version
  // that the other changes, or both change the same cell.
  const shared = (k: "row_ids" | "col_ids") => from[k].filter((id) => x[k].includes(id) && y[k].includes(id));
  const what = r.int(6);
  if (what <= 2 && x !== y) {
    const rows = shared("row_ids"), cols = shared("col_ids");
    if (rows.length && cols.length) {
      const rid = r.pick(rows), cid = r.pick(cols);
      const set = (t: FileTable, v: string) => { const d = open(t); d.cells[d.row_ids.indexOf(rid)][d.col_ids.indexOf(cid)][0] = v; return ft(ensureRows(d)); };
      const del = (t: FileTable) => { const d = open(t); return ft(what === 0 ? deleteRow(d, d.row_ids.indexOf(rid)) : deleteCol(d, d.col_ids.indexOf(cid))); };
      const flip = r.chance(0.5);
      if (what === 2) { x = await set(x, fresh("m")); y = await set(y, fresh("t")); }
      else if (flip) { x = await del(x); y = await set(y, fresh("t")); }
      else { y = await del(y); x = await set(x, fresh("m")); }
    }
  } else if (what === 3 && x !== y) {
    // Both insert a row with data after the same row (the place both sides still have).
    const rows = shared("row_ids");
    if (rows.length) {
      const after = r.pick(rows);
      const ins = (t: FileTable, tag: string) => {
        const d = open(t);
        const at = d.row_ids.indexOf(after) + 1;
        const e = insertRow(d, at);
        e.cells[at][0][0] = fresh(tag);
        return ft(ensureRows(e));
      };
      x = await ins(x, "m"); y = await ins(y, "t");
    }
  } else if (what === 4 && x !== y) {
    const cols = shared("col_ids");
    if (cols.length && x.col_ids.length < 6 && y.col_ids.length < 6) {
      const after = r.pick(cols);
      const ins = (t: FileTable) => { const d = open(t); return ft(ensureRows(insertCol(d, d.col_ids.indexOf(after) + 1))); };
      x = await ins(x); y = await ins(y);
    }
  }
  const [kx, ky] = twoKeys(r);
  return { b, x, y, kx, ky };
}

const merge = (b: FileTable, m: FileTable, t: FileTable, mk: SideKey, tk: SideKey, c?: FineChoices) =>
  mergeTable({ base: b, mine: m, theirs: t, mineKey: mk, theirsKey: tk }, c);
const allOf = (res: TableMerge, side: "mine" | "theirs"): FineChoices => Object.fromEntries(res.conflicts.map((c) => [c.id, side]));
const randomChoices = (r: Rng, res: TableMerge): FineChoices => Object.fromEntries(res.conflicts.map((c) => [c.id, r.pick(["mine", "theirs"] as const)]));
const swap = (c: FineChoices): FineChoices => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v === "mine" ? "theirs" : "mine"]));

// ── fixer (finding M1): a blank base row both sides typed different things into is two rows ──

/** The SHA-256 hex of a text, straight from WebCrypto (not through the module). */
async function shaHex(s: string): Promise<string> {
  const buf = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((v) => v.toString(16).padStart(2, "0")).join("");
}
const hasData = (t: FileTable, i: number) =>
  !isBlank(t.row_titles[i]) || !isBlank(t.x[i]) || t.cells[i].some((reps) => reps.some((v) => !isBlank(v)));
function contentKey(t: FileTable, i: number): string {
  const cells: [string, number, string][] = [];
  t.col_ids.forEach((c, j) => t.cells[i][j].forEach((v, k) => { if (v !== "") cells.push([c, k, v]); }));
  cells.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
  return JSON.stringify([t.row_titles[i] ?? "", t.template === "xy" ? t.x[i] ?? "" : "", cells]);
}
const firstIsX = (kx: SideKey, ky: SideKey) => (kx.deviceId !== ky.deviceId ? kx.deviceId < ky.deviceId : kx.revisionId !== ky.revisionId ? kx.revisionId < ky.revisionId : true);

/** The sides as the rule of the fixer's contract note sees them: the leaver's row reads as in the base and its
 *  values sit in a new row right after it. */
async function splitAsSpec(b: FileTable, x0: FileTable, y0: FileTable, kx: SideKey, ky: SideKey): Promise<[FileTable, FileTable, Map<string, "mine" | "theirs">]> {
  const x = clone(x0), y = clone(y0);
  const keeper = new Map<string, "mine" | "theirs">();
  const used = new Set([...b.row_ids, ...x.row_ids, ...y.row_ids]);
  for (const R of b.row_ids) {
    const bi = b.row_ids.indexOf(R), xi = x.row_ids.indexOf(R), yi = y.row_ids.indexOf(R);
    if (xi < 0 || yi < 0 || hasData(b, bi) || !hasData(x, xi) || !hasData(y, yi)) continue;
    const kX = contentKey(x, xi), kY = contentKey(y, yi);
    if (kX === kY) continue;
    const id = async (k: string, n = 0) => "row-" + (await shaHex(`las-split\n${R}\n${k}${n ? `\n${n}` : ""}`)).slice(0, 12);
    const iX = await id(kX), iY = await id(kY);
    const xHoldsY = x.row_ids.includes(iY) && contentKey(x, x.row_ids.indexOf(iY)) === kY;
    const yHoldsX = y.row_ids.includes(iX) && contentKey(y, y.row_ids.indexOf(iX)) === kX;
    const leaveX = yHoldsX && !xHoldsY ? true : xHoldsY && !yHoldsX ? false : !firstIsX(kx, ky);
    const L = leaveX ? x : y, li = leaveX ? xi : yi;
    let nid = leaveX ? iX : iY;
    if (!(leaveX ? yHoldsX : xHoldsY)) for (let n = 1; used.has(nid); n++) nid = await id(leaveX ? kX : kY, n);
    used.add(nid);
    L.row_ids.splice(li + 1, 0, nid);
    L.row_titles.splice(li + 1, 0, L.row_titles[li]);
    L.x.splice(li + 1, 0, L.x[li]);
    L.cells.splice(li + 1, 0, L.cells[li].map((r) => [...r]));
    L.row_titles[li] = b.row_titles[bi];
    L.x[li] = b.x[bi];
    L.cells[li] = L.col_ids.map((c) => Array.from({ length: L.n_rep }, (_, k) => (b.col_ids.includes(c) && k < b.n_rep ? b.cells[bi][b.col_ids.indexOf(c)][k] : "")));
    keeper.set(R, leaveX ? "theirs" : "mine");
  }
  return [x, y, keeper];
}

// ── the oracle: places of a side ────────────────────────────────────────────

/** Every place of a table: "t|row", "x|row", "h|col" (column title), "c|row|col|k" for k < K. */
function places(t: FileTable, K: number): Map<string, string> {
  const m = new Map<string, string>();
  t.row_ids.forEach((rid, i) => {
    m.set(`t|${rid}`, t.row_titles[i] ?? "");
    if (t.template === "xy") m.set(`x|${rid}`, t.x[i] ?? "");
    t.col_ids.forEach((cid, j) => { for (let k = 0; k < K; k++) m.set(`c|${rid}|${cid}|${k}`, k < t.n_rep ? t.cells[i][j][k] ?? "" : ""); });
  });
  t.col_ids.forEach((cid, j) => m.set(`h|${cid}`, t.col_titles[j] ?? ""));
  return m;
}
const rowOfPlace = (p: string) => (p[0] === "h" ? null : p.split("|")[1]);
const colOfPlace = (p: string) => (p[0] === "h" ? p.split("|")[1] : p[0] === "c" ? p.split("|")[2] : null);

interface Oracle {
  K: number;
  P: { b: Map<string, string>; x: Map<string, string>; y: Map<string, string> };
  /** Rows / columns of the base that one side deleted while the other changed something in them. */
  delConflictRows: Map<string, "mine" | "theirs">;
  delConflictCols: Map<string, "mine" | "theirs">;
  /** Rows kept by the blank-row case. */
  blankKept: Set<string>;
  /** Rows / columns removed without a question. */
  removedRows: Set<string>;
  removedCols: Set<string>;
  /** Places both sides have and changed differently. */
  conflictPlaces: Set<string>;
  /** Fixer (finding VUX-1): rows whose title or X is to choose — the choice takes every value of the row that differs. */
  wholeRows: Set<string>;
  /** Fixer round 3 (safety net): rows that may be two different entries — one whole choice, including the cells of
   *  columns only one side has (blank when the other side is chosen). */
  entryRows: Set<string>;
}

/** Fixer round 3, the safety net, as the contract note states it (worked out here on its own). */
function entryRowsOf(b: FileTable, x: FileTable, y: FileTable, skip: (rid: string) => boolean): Set<string> {
  const out = new Set<string>();
  const common = x.col_ids.filter((c) => y.col_ids.includes(c));
  const vals = (t: FileTable, rid: string, cols: string[]) => {
    const i = t.row_ids.indexOf(rid), m = new Map<string, string>();
    if (!isBlank(t.row_titles[i])) m.set("t", t.row_titles[i]);
    if (t.template === "xy" && !isBlank(t.x[i])) m.set("x", t.x[i]);
    for (const c of cols) { const j = t.col_ids.indexOf(c); for (let k = 0; k < t.n_rep; k++) if (!isBlank(t.cells[i][j][k] ?? "")) m.set(`${c}|${k}`, t.cells[i][j][k]); }
    return m;
  };
  const same = (a: Map<string, string>, c: Map<string, string>) => a.size === c.size && [...a].every(([k, v]) => c.get(k) === v);
  for (const rid of x.row_ids) {
    if (!y.row_ids.includes(rid) || skip(rid)) continue;
    const px = vals(x, rid, common), py = vals(y, rid, common);
    if (!px.size || !py.size || same(px, py)) continue;
    if (!b.row_ids.includes(rid)) { if (/^row-[0-9a-f]{12}$/.test(rid) || ![...px].some(([k, v]) => py.get(k) === v)) out.add(rid); continue; }
    if (!hasData(b, b.row_ids.indexOf(rid))) { out.add(rid); continue; }
    const pb = vals(b, rid, common.filter((c) => b.col_ids.includes(c)));
    if (!pb.size) { out.add(rid); continue; }
    if (!pb.has(x.template === "xy" ? "x" : "t") || pb.size < 2 || same(px, pb) || same(py, pb)) continue;
    const keys = new Set([...pb.keys(), ...px.keys(), ...py.keys()]);
    const rewrote = (p: Map<string, string>) => [...pb].every(([k, v]) => p.get(k) !== v);
    const mixes = (p: Map<string, string>, q: Map<string, string>) => [...keys].some((k) => {
      const bv = pb.get(k) ?? "", pv = p.get(k) ?? "", qv = q.get(k) ?? "";
      return qv !== bv && (pv === bv || pv !== qv);
    });
    if ((rewrote(px) && mixes(px, py)) || (rewrote(py) && mixes(py, px))) out.add(rid);
  }
  return out;
}

function oracle(b: FileTable, x: FileTable, y: FileTable, split?: ReadonlyMap<string, unknown>): Oracle {
  const K = Math.max(x.n_rep, y.n_rep);
  const P = { b: places(b, K), x: places(x, K), y: places(y, K) };
  const changedIn = (side: Map<string, string>, isIn: (p: string) => boolean) => {
    for (const [p, v] of side) if (isIn(p) && v !== (P.b.get(p) ?? "")) return true;
    return false;
  };
  const baseRowHasData = (rid: string) => { for (const [p, v] of P.b) if (p[0] !== "h" && rowOfPlace(p) === rid && !isBlank(v)) return true; return false; };
  const o: Oracle = { K, P, delConflictRows: new Map(), delConflictCols: new Map(), blankKept: new Set(), removedRows: new Set(), removedCols: new Set(), conflictPlaces: new Set(), wholeRows: new Set(), entryRows: new Set() };
  for (const rid of b.row_ids) {
    const inX = x.row_ids.includes(rid), inY = y.row_ids.includes(rid);
    if (!inX && !inY) { o.removedRows.add(rid); continue; }
    if (inX && inY) continue;
    const O = inX ? P.x : P.y;
    if (!changedIn(O, (p) => p[0] !== "h" && rowOfPlace(p) === rid)) o.removedRows.add(rid);
    else if (!baseRowHasData(rid)) o.blankKept.add(rid);
    else o.delConflictRows.set(rid, inX ? "theirs" : "mine");
  }
  for (const cid of b.col_ids) {
    const inX = x.col_ids.includes(cid), inY = y.col_ids.includes(cid);
    if (!inX && !inY) { o.removedCols.add(cid); continue; }
    if (inX && inY) continue;
    const O = inX ? P.x : P.y;
    if (!changedIn(O, (p) => colOfPlace(p) === cid)) o.removedCols.add(cid);
    else o.delConflictCols.set(cid, inX ? "theirs" : "mine");
  }
  for (const [p, xv] of P.x) {
    const yv = P.y.get(p);
    if (yv === undefined) continue;
    const bv = P.b.get(p) ?? "";
    if (xv !== yv && xv !== bv && yv !== bv) o.conflictPlaces.add(p);
  }
  for (const p of o.conflictPlaces) if ((p[0] === "t" || p[0] === "x") && !isPadRow(b, x, y, rowOfPlace(p)!)) o.wholeRows.add(rowOfPlace(p)!);
  for (const rid of entryRowsOf(b, x, y, (rid) => isPadRow(b, x, y, rid) || (split?.has(rid) ?? false))) { o.entryRows.add(rid); o.wholeRows.add(rid); }
  return o;
}

/** A row that is padding: not in the base or in its tail, and in the tail of every side that has it. */
function isPadRow(b: FileTable, x: FileTable, y: FileTable, rid: string): boolean {
  return (!b.row_ids.includes(rid) || tailOf(b).has(rid)) && (!x.row_ids.includes(rid) || tailOf(x).has(rid)) && (!y.row_ids.includes(rid) || tailOf(y).has(rid));
}

/** Rows in every side's tail (and not above the base's tail): they hold nothing, wherever they go. */
function tailOf(t: FileTable): Set<string> {
  const s = new Set<string>();
  for (let i = t.row_ids.length - 1; i >= 0; i--) {
    const data = !isBlank(t.row_titles[i]) || !isBlank(t.x[i]) || t.cells[i].some((reps) => reps.some((v) => !isBlank(v)));
    if (data) break;
    s.add(t.row_ids[i]);
  }
  return s;
}

/**
 * Checks a result against the oracle for given choices (`side` decides every conflict when the choices are all one side;
 * with mixed choices pass `choiceOf`).
 */
function checkResult(o: Oracle, b: FileTable, x: FileTable, y: FileTable, res: TableMerge, v: FileTable, choiceOf: (id: string) => "mine" | "theirs") {
  // Shape: pipeline form.
  expect(v.v).toBe(2);
  expect(Object.keys(v).sort()).toEqual(["cells", "col_ids", "col_titles", "n_rep", "row_ids", "row_titles", "template", "v", "x", "x_title"]);
  expect(v.row_ids.length).toBeGreaterThanOrEqual(MIN_ROWS);
  expect(new Set(v.row_ids).size).toBe(v.row_ids.length);
  expect(new Set(v.col_ids).size).toBe(v.col_ids.length);
  expect(v.row_ids.every((id) => ID_RE.test(id) && id.startsWith("row-"))).toBe(true);
  expect(v.col_ids.length).toBeGreaterThan(0);
  expect(v.col_ids.length).toBeLessThanOrEqual(MAX_COLS);
  for (const row of v.cells) { expect(row).toHaveLength(v.col_ids.length); for (const reps of row) expect(reps).toHaveLength(v.n_rep); }
  if (v.template === "column") expect(v.n_rep).toBe(1);
  if (v.template !== "xy") expect(v.x.every((s) => s === "")).toBe(true);
  const last = v.row_ids.length - 1;
  expect(isBlank(v.row_titles[last]) && isBlank(v.x[last]) && v.cells[last].every((reps) => reps.every(isBlank))).toBe(true);

  // Rows and columns: present exactly as the rules say.
  const inRes = new Set(v.row_ids), colsRes = new Set(v.col_ids);
  for (const rid of new Set([...b.row_ids, ...x.row_ids, ...y.row_ids])) {
    const del = o.delConflictRows.get(rid);
    const want = o.removedRows.has(rid) ? false : del ? choiceOf(`table:row:${rid}`) !== del : true;
    expect(inRes.has(rid)).toBe(want);
  }
  for (const cid of new Set([...b.col_ids, ...x.col_ids, ...y.col_ids])) {
    const del = o.delConflictCols.get(cid);
    const want = o.removedCols.has(cid) ? false : del ? choiceOf(`table:col:${cid}`) !== del : true;
    expect(colsRes.has(cid)).toBe(want);
  }

  // Every place of the result: the three-way rule, the chosen side where they differ; nothing beyond n_rep is lost.
  const R = places(v, o.K);
  const conflictOf = (p: string) => (p[0] === "h" ? `table:coltitle:${colOfPlace(p)}` : `table:row:${rowOfPlace(p)}`);
  for (const [p, got] of R) {
    const rid = rowOfPlace(p), cid = colOfPlace(p);
    if (rid !== null && !b.row_ids.includes(rid) && !x.row_ids.includes(rid) && !y.row_ids.includes(rid)) { expect(got).toBe(""); continue; }  // added blank row
    const xv = o.P.x.get(p), yv = o.P.y.get(p);
    let want: string;
    if (xv !== undefined && yv !== undefined) {
      const bv = o.P.b.get(p) ?? "";
      if (xv === yv) want = xv;
      else if (p[0] !== "h" && o.wholeRows.has(rid!)) want = choiceOf(conflictOf(p)) === "mine" ? xv : yv;
      else if (xv === bv) want = yv;
      else if (yv === bv) want = xv;
      else want = choiceOf(conflictOf(p)) === "mine" ? xv : yv;
    } else if (p[0] === "c" && o.entryRows.has(rid!) && (xv ?? yv ?? "") !== "" && x.row_ids.includes(rid!) && y.row_ids.includes(rid!)) {
      want = choiceOf(conflictOf(p)) === (xv !== undefined ? "mine" : "theirs") ? (xv ?? yv)! : "";
    } else want = xv ?? yv ?? "";
    const k = p[0] === "c" ? Number(p.split("|")[3]) : 0;
    if (p[0] === "c" && k >= v.n_rep) { expect(want, `value at ${p} beyond the replicate count`).toBe(""); continue; }
    expect(got, `${p} (row ${rid} col ${cid})`).toBe(want);
  }
  // The X title.
  const xt = x.x_title === y.x_title ? x.x_title : x.x_title === b.x_title ? y.x_title : y.x_title === b.x_title ? x.x_title
    : choiceOf("table:field:x_title") === "mine" ? x.x_title : y.x_title;
  expect(v.x_title).toBe(xt);

  // Order: each side's own rows (other than blank padding) keep their order; columns too.
  const pad = new Set([...tailOf(x), ...tailOf(y)].filter((id) => (!x.row_ids.includes(id) || tailOf(x).has(id)) && (!y.row_ids.includes(id) || tailOf(y).has(id)) && (!b.row_ids.includes(id) || tailOf(b).has(id))));
  for (const s of [x, y]) {
    const mine = s.row_ids.filter((id) => inRes.has(id) && !pad.has(id));
    expect(v.row_ids.filter((id) => mine.includes(id))).toEqual(mine);
    const mc = s.col_ids.filter((id) => colsRes.has(id));
    expect(v.col_ids.filter((id) => mc.includes(id))).toEqual(mc);
  }
  // Padding never sits above a row with data.
  let lastData = -1;
  v.row_ids.forEach((_, i) => { if (!isBlank(v.row_titles[i]) || !isBlank(v.x[i]) || v.cells[i].some((reps) => reps.some((s) => !isBlank(s)))) lastData = i; });
  v.row_ids.forEach((id, i) => { if (pad.has(id)) expect(i, `padding ${id} above row ${lastData}`).toBeGreaterThan(lastData); });
  expect(res.adjustments.every((a) => a.kind === "replicates" && Number(a.to) === v.n_rep)).toBe(true);
}

/** The conflicts the oracle expects (ids). */
function expectedConflictIds(o: Oracle, b: FileTable, x: FileTable, y: FileTable): Set<string> {
  const ids = new Set<string>();
  for (const rid of o.delConflictRows.keys()) ids.add(`table:row:${rid}`);
  for (const cid of o.delConflictCols.keys()) ids.add(`table:col:${cid}`);
  const pad = new Set([...tailOf(x), ...tailOf(y)]);
  for (const p of o.conflictPlaces) {
    if (p[0] === "h") { ids.add(`table:coltitle:${colOfPlace(p)}`); continue; }
    const rid = rowOfPlace(p)!;
    const isPad = (!b.row_ids.includes(rid) || tailOf(b).has(rid)) && (!x.row_ids.includes(rid) || pad.has(rid)) && (!y.row_ids.includes(rid) || pad.has(rid));
    if (!isPad) ids.add(`table:row:${rid}`);
  }
  if (x.x_title !== y.x_title && x.x_title !== b.x_title && y.x_title !== b.x_title) ids.add("table:field:x_title");
  for (const rid of o.entryRows) ids.add(`table:row:${rid}`);
  return ids;
}

const isWhole = (res: TableMerge) => res.whole !== null;

// ── the properties ──────────────────────────────────────────────────────────

const N = 400;
/** Added to every seed (TABLE_SEED=… for a longer search; 0 in CI). */
const SEED = Number((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.TABLE_SEED ?? 0);

describe("generated tables (seeded)", () => {
  it("T1 merge(b, x, b) = x and merge(b, b, x) = x; T2 merge(b, x, x) = x", async () => {
    const r = rng(20261125 + SEED);
    const bases = await Promise.all(allBases().map(async (s) => clone(s.table) as FileTable).map(async (t) => ft(open(await t))));
    for (let i = 0; i < N; i++) {
      const { b, x, kx, ky } = await randomCase(r, bases);
      for (const [m, t] of [[x, b], [b, x], [x, x]] as const) {
        const res = await merge(b, m, t, kx, ky);
        expect(res.conflicts).toEqual([]);
        expect(res.orderChecks).toEqual([]);
        expect(res.adjustments).toEqual([]);
        expect(text(res.value), `case ${i}`).toBe(text(x));
      }
    }
  });

  it("T3 symmetry, T4 no edit lost, T5 deletions never lose an edit silently, T6 all mine / all theirs, T12 pipeline form", async () => {
    const r = rng(77001 + SEED);
    const bases = await Promise.all(allBases().map((s) => ft(open(clone(s.table) as FileTable))));
    let free = 0, withConflicts = 0, delRow = 0, delCol = 0, blank = 0, checks = 0, splits = 0;
    for (let i = 0; i < N; i++) {
      const { b, x, y, kx, ky } = await randomCase(r, bases);
      const res = await merge(b, x, y, kx, ky);
      const mir = await merge(b, y, x, ky, kx);
      // T3: the same conflict ids (in a set), deletedBy swapped, the same order checks.
      expect(new Set(mir.conflicts.map((c) => c.id))).toEqual(new Set(res.conflicts.map((c) => c.id)));
      for (const c of res.conflicts) {
        const d = mir.conflicts.find((e) => e.id === c.id)!;
        expect(d.kind).toBe(c.kind);
        expect(d.deletedBy).toBe(c.deletedBy === "mine" ? "theirs" : c.deletedBy === "theirs" ? "mine" : undefined);
        expect(d.items.map((it) => [it.what, it.rowId, it.colId, it.rep, it.base, it.theirs, it.mine]))
          .toEqual(expect.arrayContaining(c.items.map((it) => [it.what, it.rowId, it.colId, it.rep, it.base, it.mine, it.theirs])));
      }
      expect(mir.combined).toBe(res.combined);
      if (isWhole(res)) {
        expect(isWhole(mir)).toBe(true);
        continue;
      }
      const [sx, sy, kept] = await splitAsSpec(b, x, y, kx, ky);
      splits += kept.size;
      const o = oracle(b, sx, sy, kept);
      // T5: exactly the expected conflicts (deletion vs edit, places changed differently).
      expect(new Set(res.conflicts.map((c) => c.id)), `case ${i}`).toEqual(expectedConflictIds(o, b, sx, sy));
      for (const [rid, by] of o.delConflictRows) expect(res.conflicts.find((c) => c.id === `table:row:${rid}`)).toMatchObject({ kind: "rowDeleted", deletedBy: by });
      for (const [cid, by] of o.delConflictCols) expect(res.conflicts.find((c) => c.id === `table:col:${cid}`)).toMatchObject({ kind: "colDeleted", deletedBy: by });
      delRow += o.delConflictRows.size; delCol += o.delConflictCols.size; blank += o.blankKept.size;
      // Items show the right texts.
      for (const c of res.conflicts) for (const it of c.items) {
        if (it.what === "cell") {
          const p = `c|${it.rowId}|${it.colId}|${it.rep}`;
          expect([it.mine, it.theirs]).toEqual([o.P.x.get(p) ?? null, o.P.y.get(p) ?? null]);
          expect(it.base).toBe(o.P.b.get(p) ?? (b.row_ids.includes(it.rowId!) && b.col_ids.includes(it.colId!) ? "" : null));
        }
      }
      if (res.conflicts.length === 0) {
        free++;
        expect(res.value).not.toBeNull();
        expect(text(mir.value), `case ${i}`).toBe(text(res.value));
        expect(mir.orderChecks).toEqual(res.orderChecks);
        checkResult(o, b, sx, sy, res, res.value!, () => { throw new Error("no conflict expected"); });
        expect(canonicalJson(await ft(open(res.value!)))).toBe(text(res.value));
        checks += res.orderChecks.length;
        continue;
      }
      withConflicts++;
      expect(res.value).toBeNull();
      expect(res.orderChecks).toEqual([]);
      // T6: all mine / all theirs; T3: swapped choices give the same bytes from the other computer.
      for (const side of ["mine", "theirs"] as const) {
        const c = allOf(res, side);
        const got = await merge(b, x, y, kx, ky, c);
        expect(got.value).not.toBeNull();
        expect(got.conflicts.map((e) => e.id)).toEqual(res.conflicts.map((e) => e.id));
        checkResult(o, b, sx, sy, got, got.value!, () => side);
        expect(text((await merge(b, y, x, ky, kx, swap(c))).value)).toBe(text(got.value));
        expect(canonicalJson(await ft(open(got.value!)))).toBe(text(got.value));
      }
      // Mixed choices.
      const c = randomChoices(r, res);
      const got = await merge(b, x, y, kx, ky, c);
      checkResult(o, b, sx, sy, got, got.value!, (id) => (c[id] as "mine" | "theirs"));
      const mirGot = await merge(b, y, x, ky, kx, swap(c));
      expect(text(mirGot.value)).toBe(text(got.value));
      expect(mirGot.orderChecks).toEqual(got.orderChecks);
      expect(canonicalJson(await ft(open(got.value!)))).toBe(text(got.value));
      // One choice missing → no result.
      const partial = { ...c };
      delete partial[res.conflicts[r.int(res.conflicts.length)].id];
      expect((await merge(b, x, y, kx, ky, partial)).value).toBeNull();
    }
    // The generator reaches the interesting cases.
    expect(free).toBeGreaterThan(60);
    expect(withConflicts).toBeGreaterThan(60);
    expect(delRow).toBeGreaterThan(10);
    expect(delCol).toBeGreaterThan(10);
    expect(blank).toBeGreaterThan(3);
    expect(checks).toBeGreaterThan(20);
    expect(splits).toBeGreaterThan(3);
  }, 60_000);

  it("T7 re-combining a conflict-free result changes nothing", async () => {
    const r = rng(424242 + SEED);
    const bases = await Promise.all(allBases().map((s) => ft(open(clone(s.table) as FileTable))));
    let done = 0;
    const want = 300;
    for (let i = 0; done < want && i < want * 10; i++) {
      const { b, x, y, kx, ky } = await randomCase(r, bases);
      const res = await merge(b, x, y, kx, ky);
      if (res.value === null || res.conflicts.length) continue;
      done++;
      const rv = res.value;
      const [k3, k4] = twoKeys(r);
      for (const [base, m, t] of [[x, rv, x], [y, rv, y], [b, rv, x], [b, rv, y], [x, x, rv], [b, y, rv]] as const) {
        const again = await merge(base, m, t, k3, k4);
        expect(again.conflicts, `case ${i}`).toEqual([]);
        expect(text(again.value), `case ${i}`).toBe(text(rv));
      }
    }
    expect(done).toBe(want);
  });

  it("with rows moved (not an editor action): still deterministic, symmetric and nothing lost; a moved shared row gives the order check", async () => {
    const r = rng(9090 + SEED);
    const ops: Op[] = [...OPS, "move", "move", "move"];
    let flagged = 0;
    for (let i = 0; i < 300; i++) {
      const { b, x, y, kx, ky } = await randomCase(r, [], ops);
      const res = await merge(b, x, y, kx, ky);
      if (isWhole(res)) continue;
      const c = allOf(res, "theirs");
      const a = await merge(b, x, y, kx, ky, c);
      const a2 = await merge(b, x, y, kx, ky, c);
      expect(canonicalJson(a2)).toBe(canonicalJson(a));
      expect(text((await merge(b, y, x, ky, kx, swap(c))).value)).toBe(text(a.value));
      // Every value of the result still follows the three-way rule (order aside).
      const [sx, sy, kept] = await splitAsSpec(b, x, y, kx, ky);
      const o = oracle(b, sx, sy, kept);
      const R = places(a.value!, o.K);
      for (const [p, got] of R) {
        const xv = o.P.x.get(p), yv = o.P.y.get(p);
        if (xv === undefined && yv === undefined) continue;
        const bv = o.P.b.get(p) ?? "";
        const k = p[0] === "c" ? Number(p.split("|")[3]) : 0;
        const whole = p[0] !== "h" && o.wholeRows.has(rowOfPlace(p)!);
        const rid = rowOfPlace(p);
        const oneSided = p[0] === "c" && rid !== null && o.entryRows.has(rid) && (xv === undefined) !== (yv === undefined);
        const want = xv !== undefined && yv !== undefined ? (xv === yv ? xv : whole ? yv : xv === bv ? yv : yv === bv ? xv : yv) : oneSided ? yv ?? "" : xv ?? yv ?? "";
        if (p[0] === "c" && k >= a.value!.n_rep) expect(want).toBe("");
        else expect(got).toBe(want);
      }
      // Shared rows in a different relative order on the two sides → one check with no ids (padding aside).
      // (A split row counts as the keeper's only.)
      const pad = new Set([...tailOf(sx), ...tailOf(sy)]);
      const ids = (s: FileTable, me: "mine" | "theirs") => s.row_ids.filter((id) => !kept.has(id) || kept.get(id) === me);
      const shared = (s: string[], o2: string[]) => s.filter((id) => o2.includes(id) && !(pad.has(id) && (!b.row_ids.includes(id) || tailOf(b).has(id)) && (!sx.row_ids.includes(id) || tailOf(sx).has(id)) && (!sy.row_ids.includes(id) || tailOf(sy).has(id))));
      const xs = ids(sx, "mine"), ys = ids(sy, "theirs");
      const differ = canonicalJson(shared(xs, ys)) !== canonicalJson(shared(ys, xs));
      expect(a.orderChecks.some((oc) => oc.axis === "row" && oc.ids.length === 0 && oc.matters)).toBe(differ);
      if (differ) flagged++;
    }
    expect(flagged).toBeGreaterThan(20);
  });

  it("the trailing blank row typed into on both sides, across templates: never a padding question, always pipeline form", async () => {
    const r = rng(31337 + SEED);
    for (let i = 0; i < 300; i++) {
      const b = await ft(randomBase(r));
      const ops: Op[] = ["typeTail", "typeTail", "addRow", "cell", "nRep"];
      const x = await edited(r, b, "m", ops), y = await edited(r, b, "t", ops);
      const [kx, ky] = twoKeys(r);
      const res = await merge(b, x, y, kx, ky);
      const c = allOf(res, r.chance(0.5) ? "mine" : "theirs");
      const got = await merge(b, x, y, kx, ky, c);
      expect(got.value).not.toBeNull();
      const v = got.value!;
      expect(canonicalJson(await ft(open(v)))).toBe(text(v));
      // Rows nobody typed into never count as added.
      const tx = tailOf(x), ty = tailOf(y);
      for (const a of res.auto) if (a.what === "rowAdded") expect(tx.has(a.rowId!) && ty.has(a.rowId!) ? "padding" : "ok").toBe("ok");
      for (const oc of got.orderChecks) for (const id of oc.ids) expect(!(tx.has(id) || ty.has(id)) || !b.row_ids.includes(id)).toBe(true);
      expect(text((await merge(b, y, x, ky, kx, swap(c))).value)).toBe(text(v));
    }
  });
});

describe("generated: templates covered", () => {
  it("the generator makes all three templates", () => {
    const r = rng(1 + SEED);
    const seen = new Set<Template>();
    for (let i = 0; i < 50; i++) seen.add(randomBase(r).template);
    expect([...seen].sort()).toEqual(["column", "grouped", "xy"]);
  });
});
