/* Fine-level combining of the data table (phase 4 contract §2.2). Rows and
   columns are matched by their hidden ids, cells by (row id, column id,
   replicate). A change made on one side is taken; the same change on both is
   taken once; different changes to one row are one choice for that row. A
   deletion wins unless the other side changed something inside the deleted
   row / column (then it is a choice). Rows both sides added in the same place
   are ordered by the sides' device ids, and flagged where the order means
   something. Blank rows at the end are padding, never insertions.

   Pure: no clock, no randomness, no store, no device-specific data apart from
   the SideKeys that both computers read from the same two versions. Every
   string comparison is plain `<` / `===`. The only async step is hashing the
   ids of blank rows the combine has to add (and of rows it splits), so two
   computers get the same bytes. The result is in the form the load pipeline
   gives (§2.2.6).

   Fixer (finding M1): a row that was blank in the common version and that both
   sides typed different things into is two added rows, not one row to choose:
   one side's values stay in it, the other side's go into a new row right after
   it (hashed id), and the pair is an order to check. Fixer (finding VUX-1):
   when a row's title or X value is to choose, the choice takes the whole row.

   Fixer round 2 (finding RV-1): a row that an earlier combine moved to its split
   id (above) while the other computer kept typing into it under the old id is
   matched by its new id, so those later values land in the row they belong to
   and are never mixed with the row that stayed. (finding RV-3) The row both
   typed into is listed as a row added by its keeper, not as changed cells.

   Fixer round 3 (RV2-1, RV2-2, RV2-4): a moved row both sides hold gets its
   common version in the base (so three computers' entries in one blank row are
   split, not mixed); a side that already has the other side's row R keeps it;
   and a safety net (entryInQuestion) makes any row that may hold two different
   people's entries one choice of the whole row instead of combining it place
   by place. Contract §2.2.2, "CHANGED BY fixer round 3". */

import {
  LIMITS_P4,
  type FineAdjustment, type FineAuto, type FineChoices, type FineConflict, type FineItem, type MergeTableApi,
  type OrderCheck, type SideKey, type SidePick, type TableMerge, type TableRowNotes,
} from "./contract";
import { sha256Hex } from "./format";
import type { FileTable } from "./idMap";
import { MAX_COLS, MAX_ROWS, MIN_ROWS, isBlank } from "../graphModel";

type From = SidePick | "same";

// ── small helpers ───────────────────────────────────────────────────────────

interface Side {
  t: FileTable;
  row: Map<string, number>;
  col: Map<string, number>;
  /** Index of the first row of the tail (rows without data at the end). */
  tail: number;
}

const indexMap = (ids: readonly string[]) => {
  const m = new Map<string, number>();
  ids.forEach((id, i) => { if (!m.has(id)) m.set(id, i); });
  return m;
};

function rowHasData(t: FileTable, i: number): boolean {
  if (!isBlank(t.row_titles[i]) || !isBlank(t.x[i])) return true;
  const row = t.cells[i];
  if (!row) return false;
  for (const reps of row) for (const v of reps ?? []) if (!isBlank(v)) return true;
  return false;
}

function sideOf(t: FileTable): Side {
  let tail = t.row_ids.length;
  while (tail > 0 && !rowHasData(t, tail - 1)) tail--;
  return { t, row: indexMap(t.row_ids), col: indexMap(t.col_ids), tail };
}

/** A cell's text on a side that has its row and column ("" for a replicate beyond its count). */
const cellAt = (s: Side, ri: number, ci: number, k: number): string =>
  k >= s.t.n_rep ? "" : (s.t.cells[ri]?.[ci]?.[k] ?? "");
const str = (v: string | undefined) => v ?? "";

/** The three-way rule (§2.1.2) as a code. */
const UNCH = 0, SAME = 1, MINE = 2, THEIRS = 3, CONF = 4;
type Code = 0 | 1 | 2 | 3 | 4;
function three(b: string, m: string, t: string): Code {
  if (m === t) return m === b ? UNCH : SAME;
  if (m === b) return THEIRS;
  if (t === b) return MINE;
  return CONF;
}
const fromOf = (c: Code): From => (c === SAME ? "same" : c === MINE ? "mine" : "theirs");
/** The value of a non-conflicting place. */
const valOf = (c: Code, m: string, t: string) => (c === THEIRS ? t : m);

/** Mine is the first side (§2.2): smaller device id; tie → smaller revision id; still tied → mine. */
function mineIsFirst(mk: SideKey, tk: SideKey): boolean {
  if (mk.deviceId !== tk.deviceId) return mk.deviceId < tk.deviceId;
  if (mk.revisionId !== tk.revisionId) return mk.revisionId < tk.revisionId;
  return true;
}

/** A display list capped at LIMITS_P4.conflictItems, with the true count. */
class Items {
  list: FineItem[] = [];
  n = 0;
  push(it: FineItem) { if (this.list.length < LIMITS_P4.conflictItems) this.list.push(it); this.n++; }
  get more() { return this.n - this.list.length; }
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// ── both sides typed into the same blank row (fixer, finding M1) ───────────

/** A side's row as comparable text: title, X and the non-empty cells by column id and replicate. */
function rowKey(t: FileTable, i: number, xy: boolean): string {
  const cells: [string, number, string][] = [];
  t.col_ids.forEach((cid, j) => {
    for (let k = 0; k < t.n_rep; k++) { const v = t.cells[i]?.[j]?.[k] ?? ""; if (v !== "") cells.push([cid, k, v]); }
  });
  cells.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
  return JSON.stringify([str(t.row_titles[i]), xy ? str(t.x[i]) : "", cells]);
}

const splitIdOf = async (rowId: string, key: string, n: number) =>
  "row-" + (await sha256Hex(`las-split\n${rowId}\n${key}${n ? `\n${n}` : ""}`)).slice(0, LIMITS_P4.fillIdHex);

/**
 * A row without data in the base that both sides typed different things into: one side (the KEEPER) keeps it;
 * the other (the LEAVER) is changed so that this row reads as in the base and its own values sit in a new row
 * directly after it, with the id "row-" + sha256("las-split\n" + row id + "\n" + rowKey of the leaver's row)
 * (".. + \n1", "\n2", … if that id is taken for something else). The keeper is the side whose split row the
 * other already holds (a combined version combined again), else the first side. Returns the changed sides and,
 * per split row, its keeper.
 */
async function splitTypedBlankRows(base: FileTable, mine: FileTable, theirs: FileTable, mineFirst: boolean, xy: boolean):
  Promise<{ mine: FileTable; theirs: FileTable; keeper: Map<string, SidePick> }> {
  const keeper = new Map<string, SidePick>();
  const B = indexMap(base.row_ids);
  const bCol = indexMap(base.col_ids);
  let M = indexMap(mine.row_ids), T = indexMap(theirs.row_ids);
  const used = new Set([...base.row_ids, ...mine.row_ids, ...theirs.row_ids]);
  let mOut: FileTable | null = null, tOut: FileTable | null = null;
  for (const R of base.row_ids) {
    const b = B.get(R)!;
    const mt0 = mOut ?? mine, tt0 = tOut ?? theirs;
    const m = M.get(R), t = T.get(R);
    if (m === undefined || t === undefined || rowHasData(base, b) || !rowHasData(mt0, m) || !rowHasData(tt0, t)) continue;
    const km = rowKey(mt0, m, xy), kt = rowKey(tt0, t, xy);
    if (km === kt) continue;
    const idM = await splitIdOf(R, km, 0), idT = await splitIdOf(R, kt, 0);
    const holds = (s: FileTable, ix: Map<string, number>, id: string, key: string) => { const i = ix.get(id); return i !== undefined && rowKey(s, i, xy) === key; };
    const mineHoldsTheirs = holds(mt0, M, idT, kt), theirsHoldsMine = holds(tt0, T, idM, km);
    const leaver: SidePick = mineHoldsTheirs && !theirsHoldsMine ? "theirs" : theirsHoldsMine && !mineHoldsTheirs ? "mine" : mineFirst ? "theirs" : "mine";
    const L = leaver === "mine" ? (mOut ??= clone(mine)) : (tOut ??= clone(theirs));
    const li = leaver === "mine" ? m : t;
    const lKey = leaver === "mine" ? km : kt;
    const held = leaver === "mine" ? theirsHoldsMine : mineHoldsTheirs;
    let id = leaver === "mine" ? idM : idT;
    if (!held) for (let n = 1; used.has(id); n++) id = await splitIdOf(R, lKey, n);
    used.add(id);
    // The leaver's values go into the new row; the row itself reads as in the base.
    L.row_ids.splice(li + 1, 0, id);
    L.row_titles.splice(li + 1, 0, str(L.row_titles[li]));
    L.x.splice(li + 1, 0, str(L.x[li]));
    L.cells.splice(li + 1, 0, L.cells[li].map((reps) => [...reps]));
    L.row_titles[li] = str(base.row_titles[b]);
    L.x[li] = xy ? str(base.x[b]) : "";
    L.cells[li] = L.col_ids.map((cid) => {
      const bc = bCol.get(cid);
      return Array.from({ length: L.n_rep }, (_, k) => (bc === undefined || k >= base.n_rep ? "" : base.cells[b]?.[bc]?.[k] ?? ""));
    });
    if (leaver === "mine") M = indexMap(L.row_ids); else T = indexMap(L.row_ids);
    keeper.set(R, leaver === "mine" ? "theirs" : "mine");
  }
  return { mine: mOut ?? mine, theirs: tOut ?? theirs, keeper };
}

// ── a row an earlier combine moved (fixer round 2, finding RV-1) ───────────

/** Places (title, X, cells by column id and replicate) where two rows have the same text that is not "". */
function samePlaces(a: FileTable, i: number, s: FileTable, j: number, xy: boolean): number {
  let n = 0;
  if (str(a.row_titles[i]) !== "" && str(a.row_titles[i]) === str(s.row_titles[j])) n++;
  if (xy && str(a.x[i]) !== "" && str(a.x[i]) === str(s.x[j])) n++;
  const sc = indexMap(s.col_ids);
  a.col_ids.forEach((cid, c) => {
    const d = sc.get(cid);
    if (d === undefined) return;
    for (let k = 0; k < Math.min(a.n_rep, s.n_rep); k++) {
      const v = a.cells[i]?.[c]?.[k] ?? "";
      if (v !== "" && v === (s.cells[j]?.[d]?.[k] ?? "")) n++;
    }
  });
  return n;
}

/** Split ids looked at per row: the plain one and the "\n1" … variants (§2.2.2, M1). */
const SPLIT_VARIANTS = 4;
/** The form of an id the combine makes (split rows, blank rows it adds); the editor's own ids are shorter. */
const MADE_ID = new RegExp(`^row-[0-9a-f]{${LIMITS_P4.fillIdHex}}$`);

/**
 * An earlier combine that split a row R (above) moved one computer's values out of R into the row
 * X = splitIdOf(R, rowKey of those values, n). The version that computer saved before it saw that combine (the
 * base here) still has those values in R. When a side S holds X (and the base does not) while the side without it
 * changed (or deleted) its row R, then S has the base's row R under the id X: R is renamed X in the base and in
 * the side that does not have X, so that side's later changes of R are changes of X, and S's own row R is a row
 * S added. Without this, those new values were combined into the row that stayed in R (another computer's entry)
 * without a question.
 *
 * X is found (1) by the hash (the base's row R is the content that was moved: the first combine after the move);
 * else, among the rows the combine made (with data) that a side added right after its row R, (2) one that reads
 * exactly as the base's row R or as the other side's row R (a chain of combines: the moved content was changed
 * once more under R and combined into X); else, both having changed R, (3) the one most like the base's row R
 * and the other side's row R, when it is more like them than the side's own row R. When both sides have X (fixer
 * round 3, RV2-1), the base gets X, with its row R's content, right after R; R itself is left as a row without
 * data in the base when both changed it (each side's own row R is then a new entry, split if they differ). A side
 * without X whose row R reads as the row R of the side with X (or is more like it than like the base's) keeps its
 * R (RV2-2; see below).
 *
 * When (3) can't tell (a tie with a row one side has: the other computer also changed the moved row, in a
 * chain), R is returned in `unsure`: the caller makes it one choice of the whole row, so two entries are never
 * mixed and nothing is combined by itself.
 *
 * Looks at the sides only (no mine / theirs order), so both computers do the same. Returns the changed tables,
 * the rows renamed on a side and the unsure rows (phase 4 contract §2.2.2, "CHANGED BY fixer round 2").
 */
async function rekeyMovedRows(base: FileTable, mine: FileTable, theirs: FileTable, xy: boolean):
  Promise<{ base: FileTable; mine: FileTable; theirs: FileTable; moved: TableRowNotes["moved"]; unsure: Set<string> }> {
  const moved: TableRowNotes["moved"] = [];
  const unsure = new Set<string>();
  const B = indexMap(base.row_ids), M = indexMap(mine.row_ids), T = indexMap(theirs.row_ids);
  // Only an id that a side has and the base lacks can be such an X.
  if (!mine.row_ids.some((id) => !B.has(id)) && !theirs.row_ids.some((id) => !B.has(id))) return { base, mine, theirs, moved, unsure };
  const claimed = new Set<string>();
  const free = (id: string) => !B.has(id) && !claimed.has(id) && (M.has(id) || T.has(id));
  let bOut: FileTable | null = null, mOut: FileTable | null = null, tOut: FileTable | null = null;
  const inserts: { b: number; X: string; blank: boolean }[] = [];
  // A split row both sides hold (it has the form of an id the combine makes) can be found for an unchanged row R.
  const bothNew = mine.row_ids.some((id) => !B.has(id) && T.has(id) && MADE_ID.test(id));
  for (const R of base.row_ids) {
    const b = B.get(R)!;
    if (!rowHasData(base, b)) continue;
    const kb = rowKey(base, b, xy);
    const m = M.get(R), t = T.get(R);
    const mChanged = m === undefined || rowKey(mine, m, xy) !== kb, tChanged = t === undefined || rowKey(theirs, t, xy) !== kb;
    if (!mChanged && !tChanged && !bothNew) continue;
    let X: string | null = null;
    // (1) The side without X must have changed (or deleted) its row R. Fixer round 3: when both have X, it is
    // taken whatever they did to R (X then gets the base's row R as its common version, below).
    for (let n = 0; n < SPLIT_VARIANTS && X === null; n++) {
      const id = await splitIdOf(R, kb, n);
      if (!free(id)) continue;
      const inM = M.has(id), inT = T.has(id);
      if (inM && inT ? true : inM ? tChanged : mChanged) X = id;
    }
    const byHash = X !== null;
    if (X === null && !mChanged && !tChanged) continue;
    // (2), (3): the rows the side holding X added right after its row R; the other side must have changed R (for
    // (2) with the other side's row and for (3) both must have).
    if (X === null) {
      // Rows the combine made (with data) among those a side added right after its row R.
      const run = (s: FileTable, i: number | undefined) => {
        const out: number[] = [];
        if (i === undefined) return out;
        for (let j = i + 1; j < s.row_ids.length && !B.has(s.row_ids[j]); j++) {
          const id = s.row_ids[j];
          if (free(id) && MADE_ID.test(id) && rowHasData(s, j)) out.push(j);
        }
        return out;
      };
      const runM = run(mine, m), runT = run(theirs, t);
      // A row that still holds exactly what an earlier combine moved there (its id is the hash of R and of that
      // content) is another entry, kept apart already: it is only taken when it reads as the base's row R.
      const intactOf = async (s: FileTable, js: number[]) => {
        const out = new Set<number>();
        for (const j of js) {
          const k = rowKey(s, j, xy);
          for (let n = 0; n < SPLIT_VARIANTS; n++) if ((await splitIdOf(R, k, n)) === s.row_ids[j]) { out.add(j); break; }
        }
        return out;
      };
      const intactM = await intactOf(mine, runM), intactT = await intactOf(theirs, runT);
      // (2) One that reads exactly as the base's row R or as the other side's row R, which that side does not
      // have and changed; or that both have, reading as the base's row R, both having changed R.
      const exact = (s: FileTable, js: number[], intact: Set<number>, sChanged: boolean, o: FileTable, oIx: Map<string, number>, oi: number | undefined, oChanged: boolean) => {
        for (const j of js) {
          const id = s.row_ids[j], k = rowKey(s, j, xy);
          if (oIx.has(id) ? k === kb && sChanged && oChanged
            : oChanged && (k === kb || (!intact.has(j) && oi !== undefined && k === rowKey(o, oi, xy)))) return id;
        }
        return null;
      };
      const xm = exact(mine, runM, intactM, mChanged, theirs, T, t, tChanged), xt = exact(theirs, runT, intactT, tChanged, mine, M, m, mChanged);
      X = xm !== null && xt !== null && xm !== xt ? null : xm ?? xt;
      const late = X === null && mChanged && tChanged;
      if (late && m !== undefined && t !== undefined) {
        // (3) The other computer also changed the moved row: the row most like the base's row R (and like the
        // other side's row R, for a row one side has), when it is more like it than the side's own row R is (a
        // side that only edited its own row keeps it). A row one side has that is just as like it can't be told
        // apart: the row R is then one choice as a whole (never two entries mixed, never combined by itself).
        const sim = (a: FileTable, i: number, s2: FileTable, j: number) => samePlaces(a, i, s2, j, xy);
        const ownM = sim(base, b, mine, m), ownT = sim(base, b, theirs, t);
        const best = (ids: string[]) => {
          let top = -Infinity, topIds: string[] = [], topOne = false;
          for (const id of [...new Set(ids)].sort()) {
            const mj = M.get(id), tj = T.get(id);
            const gain = mj !== undefined && tj !== undefined
              ? sim(base, b, mine, mj) + sim(base, b, theirs, tj) - ownM - ownT
              : mj !== undefined
                ? sim(base, b, mine, mj) + sim(theirs, t, mine, mj) - ownM - sim(theirs, t, mine, m)
                : sim(base, b, theirs, tj!) + sim(mine, m, theirs, tj!) - ownT - sim(mine, m, theirs, t);
            const one = mj === undefined || tj === undefined;
            if (gain > top) { top = gain; topIds = [id]; topOne = one; } else if (gain === top) { topIds.push(id); topOne ||= one; }
          }
          return { X: top > 0 && topIds.length === 1 ? topIds[0] : null, unsure: ids.length > 0 && !(top > 0 && topIds.length === 1) && top >= 0 && topOne };
        };
        const first = best([...runM.filter((j) => !intactM.has(j)).map((j) => mine.row_ids[j]), ...runT.filter((j) => !intactT.has(j)).map((j) => theirs.row_ids[j])]);
        X = first.X;
        if (first.unsure) unsure.add(R);
        else if (X === null) {
          // Fixer round 3: a side whose own row R kept nothing of the base's row R has another entry there, so a
          // row only it has that still holds what was moved may be the base's entry after all (changed before the
          // move). Taken only when it is clearly the most like it; never a reason to ask.
          const other = (s: FileTable, i: number) => rowHasData(s, i) && samePlaces(base, b, s, i, xy) === 0;
          const extra = [
            ...(other(mine, m) ? runM.filter((j) => intactM.has(j) && !T.has(mine.row_ids[j])).map((j) => mine.row_ids[j]) : []),
            ...(other(theirs, t) ? runT.filter((j) => intactT.has(j) && !M.has(theirs.row_ids[j])).map((j) => theirs.row_ids[j]) : []),
          ];
          if (extra.length) X = best(extra).X;
        }
      }
    }
    if (X === null) continue;
    // Fixer round 3 (RV2-2): the side without X already has, in R, the row the side holding X has there (exactly,
    // or more like it than like the base's row R): it is a version that came from that combine and then lost X.
    // Its R stays R, so X is a row it deleted. That is when X was found by the hash or reads exactly as the base's
    // row R; found by likeness only ((2) by the other side's row, (3)), X is no moved row at all then (the side
    // holding it has that entry in R as well) and nothing is renamed.
    const one = !(M.has(X) && T.has(X));
    const hs = M.has(X) ? mine : theirs, hi = M.has(X) ? m : t;
    const os = M.has(X) ? theirs : mine, oi = M.has(X) ? t : m;
    const keepsR = one && oi !== undefined && hi !== undefined && rowHasData(os, oi) &&
      (rowKey(os, oi, xy) === rowKey(hs, hi, xy) || samePlaces(os, oi, hs, hi, xy) > samePlaces(os, oi, base, b, xy));
    const xi = (M.has(X) ? M : T).get(X)!;
    if (keepsR && !byHash && rowKey(hs, xi, xy) !== kb) continue;
    claimed.add(X);
    bOut ??= clone(base);
    // Fixer round 3 (RV2-1): when both sides hold X, both moved the base's row R to X and each has its own new
    // entry in R (three computers typed into one blank row). The base keeps R as a row without data and gets X,
    // with R's old content, right after it: the two entries in R are then two things typed into a blank row and
    // are split (M1), never combined into one row.
    if (M.has(X) && T.has(X)) { inserts.push({ b, X, blank: mChanged && tChanged }); continue; }
    bOut.row_ids[b] = X;
    for (const side of ["mine", "theirs"] as const) {
      const ix = side === "mine" ? M : T, i = side === "mine" ? m : t;
      if (ix.has(X) || keepsR) continue;
      if (i !== undefined) {
        const O = side === "mine" ? (mOut ??= clone(mine)) : (tOut ??= clone(theirs));
        O.row_ids[i] = X;
      }
      moved.push({ id: X, was: R, side });
    }
  }
  if (inserts.length) {
    const out = bOut!;
    for (const { b, X, blank } of [...inserts].sort((p, q) => q.b - p.b)) {
      out.row_ids.splice(b + 1, 0, X);
      out.row_titles.splice(b + 1, 0, str(out.row_titles[b]));
      out.x.splice(b + 1, 0, str(out.x[b]));
      out.cells.splice(b + 1, 0, out.cells[b].map((reps) => [...reps]));
      if (!blank) continue;
      out.row_titles[b] = "";
      out.x[b] = "";
      out.cells[b] = out.cells[b].map((reps) => reps.map(() => ""));
    }
  }
  return { base: bOut ?? base, mine: mOut ?? mine, theirs: tOut ?? theirs, moved, unsure };
}

// ── the safety net (fixer round 3) ─────────────────────────────────────────

/** A row's places with text: title, X and the cells (by column id and replicate) of the columns in `cols`. */
function placesOf(t: FileTable, i: number, xy: boolean, cols: ReadonlySet<string>): Map<string, string> {
  const out = new Map<string, string>();
  if (str(t.row_titles[i]) !== "") out.set("t", str(t.row_titles[i]));
  if (xy && str(t.x[i]) !== "") out.set("x", str(t.x[i]));
  t.col_ids.forEach((cid, j) => {
    if (!cols.has(cid)) return;
    for (let k = 0; k < t.n_rep; k++) { const v = t.cells[i]?.[j]?.[k] ?? ""; if (v !== "") out.set(`c\n${cid}\n${k}`, v); }
  });
  return out;
}
const sameMap = (a: Map<string, string>, b: Map<string, string>) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

/**
 * A row both sides have that may hold two different people's entries, so it must not be combined place by place
 * (fixer round 3, the safety net). Only the columns both sides have count (a column one side deleted is its own
 * question). Both have data there and it differs, and either
 * - the base has no data in it and it was not split, or
 * - the base has no such row and it is an id the combine makes (two combines made it), or the two rows have no
 *   value in common (a row both typed into after it went from the base, e.g. a blank row deleted there), or
 * - the base has two or more values there, one of them the row's label (a grouped row's title, an XY row's X),
 *   and one side (P) kept none of them (the label and every value of the base's row are gone or changed: it may
 *   be another entry under the same id), while the other side (Q) changed a place that P left as in the base, or
 *   changed a place P changed too, to something else. Combining place by place would then
 *   put Q's values into P's row (or, choosing Q at the place asked, P's values into Q's row).
 * Two people fixing different values of an existing entry keep values in common with the base, and a side whose
 * changes the other side already has (a combined version combined again) changes nothing: neither is caught.
 */
function entryInQuestion(id: string, base: FileTable, b: number, mine: FileTable, m: number, theirs: FileTable, t: number, xy: boolean): boolean {
  if (m < 0 || t < 0) return false;
  const tc = new Set(theirs.col_ids);
  const both = new Set(mine.col_ids.filter((c) => tc.has(c)));
  const pm = placesOf(mine, m, xy, both), pt = placesOf(theirs, t, xy, both);
  if (pm.size === 0 || pt.size === 0 || sameMap(pm, pt)) return false;
  // Not in the base: an id the combine makes (two combines made it), or two rows with no value in common.
  if (b < 0) return MADE_ID.test(id) || ![...pm].some(([k, v]) => pt.get(k) === v);
  if (!rowHasData(base, b)) return true;
  const bc = new Set(base.col_ids);
  const pb = placesOf(base, b, xy, new Set([...both].filter((c) => bc.has(c))));
  if (pb.size === 0) return true;
  // What names an entry is its label (a grouped row's title, an XY row's X). A row of the base without one, or with
  // only one value, is left to the plain rules: changing all its values is most likely fixing them (it can't be
  // told from another entry there).
  if (!pb.has(xy ? "x" : "t") || pb.size < 2 || sameMap(pm, pb) || sameMap(pt, pb)) return false;
  const keys = new Set([...pb.keys(), ...pm.keys(), ...pt.keys()]);
  const rewrote = (p: Map<string, string>) => { for (const [k, v] of pb) if (p.get(k) === v) return false; return true; };
  const mixes = (p: Map<string, string>, q: Map<string, string>) => {
    for (const k of keys) {
      const bv = pb.get(k) ?? "", pv = p.get(k) ?? "", qv = q.get(k) ?? "";
      if (qv !== bv && (pv === bv || pv !== qv)) return true;
    }
    return false;
  };
  return (rewrote(pm) && mixes(pm, pt)) || (rewrote(pt) && mixes(pt, pm));
}

// ── the order rule (§2.2.4) ─────────────────────────────────────────────────

export function mergeOrder(base: readonly string[], first: readonly string[], second: readonly string[], kept: ReadonlySet<string>): string[] {
  const inBase = new Set(base), inFirst = new Set(first), inSecond = new Set(second);
  const firstOnlyNew = (id: string) => inFirst.has(id) && !inSecond.has(id) && !inBase.has(id);
  const R = first.filter((id) => kept.has(id));
  const inR = new Set(R);
  let anchor: string | null = null;
  let anchorPos = -1;        // R.indexOf(anchor), valid while `anchorFresh`
  let anchorFresh = true;
  for (const y of second) {
    if (!kept.has(y)) continue;
    if (inR.has(y)) { anchor = y; anchorFresh = false; continue; }
    if (!anchorFresh) { anchorPos = R.indexOf(anchor!); anchorFresh = true; }
    let p = anchor === null ? 0 : anchorPos + 1;
    while (p < R.length && firstOnlyNew(R[p])) p++;
    R.splice(p, 0, y);
    inR.add(y);
    anchor = y;
    anchorPos = p;
  }
  return R;
}

// ── the table as one whole choice (§2.2.9) ──────────────────────────────────

function wholeTable(input: { mine: FileTable; theirs: FileTable }, choices: FineChoices): TableMerge {
  const id = "table:section";
  const c = choices[id];
  const value = c === "mine" ? clone(input.mine) : c === "theirs" ? clone(input.theirs) : null;
  return {
    whole: "table",
    value,
    conflicts: [{ id, section: "table", kind: "section", reason: "table", options: ["mine", "theirs"], items: [], more: 0 }],
    combined: 0,
    auto: [],
    orderChecks: [],
    adjustments: [],
  };
}

// ── the combine ─────────────────────────────────────────────────────────────

interface ColEnt {
  id: string;
  b: number; m: number; t: number;
  /** kept: in the result whatever the choices; removed: never; conflict: colDeleted. */
  fate: "kept" | "removed" | "conflict";
  /** kept and not in the base: who added it. removed: who deleted it. */
  from: From;
  del?: SidePick;
  items?: Items;
}

/** One conflicting place of a row: pos -1 = row title, -2 = X, else the index into RowEnt.vals. */
interface Place { pos: number; m: string; t: string }

interface RowEnt {
  id: string;
  b: number; m: number; t: number;
  fate: "kept" | "removed" | "conflict";
  from: From;
  /** Counted as a row added by that side (not in the base, or the blank-row case). */
  added: From | null;
  del?: SidePick;
  items?: Items;
  padding: boolean;
  title: string;
  x: string;
  /** [candidate column position * K + replicate]: the value without a choice (mine's at a conflicting place). */
  vals: string[];
  places: Place[];
  placeItems: Items | null;
  autos: FineAuto[];
  /** It would have data whichever side is chosen where they differ (for §2.2.9). */
  dataEither: boolean;
}

export async function mergeTable(
  input: { base: FileTable; mine: FileTable; theirs: FileTable; mineKey: SideKey; theirsKey: SideKey },
  choices: FineChoices = {},
): Promise<TableMerge> {
  if (input.base.template !== input.mine.template || input.mine.template !== input.theirs.template) return wholeTable(input, choices);
  const template = input.mine.template;
  const xy = template === "xy";
  const mineFirst = mineIsFirst(input.mineKey, input.theirsKey);
  // Fixer round 2 (RV-1): rows an earlier combine moved are matched by their new id first.
  const rekeyed = await rekeyMovedRows(input.base, input.mine, input.theirs, xy);
  const { base } = rekeyed;
  const split = await splitTypedBlankRows(base, rekeyed.mine, rekeyed.theirs, mineFirst, xy);
  const { mine, theirs } = split;
  const B = sideOf(base), M = sideOf(mine), T = sideOf(theirs);
  const F = mineFirst ? M : T, S = mineFirst ? T : M;
  const K = Math.max(1, mine.n_rep, theirs.n_rep);
  const sideBy = (p: SidePick) => (p === "mine" ? M : T);

  // ── columns: which are in the result (§2.2.2) ──
  const colIds = [...new Set([...base.col_ids, ...mine.col_ids, ...theirs.col_ids])];
  const cols = new Map<string, ColEnt>();
  for (const id of colIds) {
    const b = B.col.get(id) ?? -1, m = M.col.get(id) ?? -1, t = T.col.get(id) ?? -1;
    const e: ColEnt = { id, b, m, t, fate: "kept", from: "same" };
    if (b < 0) e.from = m >= 0 && t >= 0 ? "same" : m >= 0 ? "mine" : "theirs";
    else if (m < 0 && t < 0) { e.fate = "removed"; e.from = "same"; }
    else if (m < 0 || t < 0) {
      const O: SidePick = m >= 0 ? "mine" : "theirs", D: SidePick = O === "mine" ? "theirs" : "mine";
      const os = sideBy(O), oc = O === "mine" ? m : t;
      const items = new Items();
      const ot = os.t.col_titles[oc] ?? "", bt = base.col_titles[b] ?? "";
      if (ot !== bt) items.push({ what: "colTitle", colId: id, base: bt, mine: O === "mine" ? ot : null, theirs: O === "theirs" ? ot : null });
      os.t.row_ids.forEach((rid, oi) => {
        const bi = B.row.get(rid) ?? -1;
        for (let k = 0; k < K; k++) {
          const ov = cellAt(os, oi, oc, k), bv = bi < 0 ? "" : cellAt(B, bi, b, k);
          if (ov !== bv) items.push({
            what: "cell", rowId: rid, colId: id, rep: k, base: bi < 0 ? null : bv,
            mine: O === "mine" ? ov : null, theirs: O === "theirs" ? ov : null,
          });
        }
      });
      if (items.n === 0) { e.fate = "removed"; e.from = D; }
      else { e.fate = "conflict"; e.del = D; e.items = items; }
    }
    cols.set(id, e);
  }
  const keptColCount = [...cols.values()].filter((e) => e.fate === "kept").length;
  const colConflictCount = [...cols.values()].filter((e) => e.fate === "conflict").length;
  if (keptColCount === 0 || keptColCount + colConflictCount > MAX_COLS) return wholeTable(input, choices);

  // Candidate columns (in the result for some choice): mine's order, then theirs' others.
  const candCols: ColEnt[] = [];
  for (const id of [...mine.col_ids, ...theirs.col_ids]) {
    const e = cols.get(id)!;
    if (e.fate !== "removed" && !candCols.includes(e)) candCols.push(e);
  }
  const candPos = new Map(candCols.map((e, p) => [e.id, p]));
  const nC = candCols.length;

  // ── rows: which are in the result, and their values (§2.2.2, §2.2.3) ──
  const rowIds = [...new Set([...base.row_ids, ...mine.row_ids, ...theirs.row_ids])];
  const rows = new Map<string, RowEnt>();
  const inTail = (s: Side, i: number) => i < 0 || i >= s.tail;
  for (const id of rowIds) {
    const b = B.row.get(id) ?? -1, m = M.row.get(id) ?? -1, t = T.row.get(id) ?? -1;
    const e: RowEnt = {
      id, b, m, t, fate: "kept", from: "same", added: null, padding: false, title: "", x: "",
      vals: [], places: [], placeItems: null, autos: [], dataEither: false,
    };
    rows.set(id, e);
    // Fixer round 2 (RV-3): a row both typed into that was split is a row added by its keeper (the other's entry
    // is the split row, added by the other), not changed cells.
    const splitBy = split.keeper.get(id);
    if (splitBy) { e.added = splitBy; e.from = splitBy; }
    if (b < 0) { e.added = m >= 0 && t >= 0 ? "same" : m >= 0 ? "mine" : "theirs"; e.from = e.added; }
    else if (m < 0 && t < 0) { e.fate = "removed"; e.from = "same"; continue; }
    else if (m < 0 || t < 0) {
      const O: SidePick = m >= 0 ? "mine" : "theirs", D: SidePick = O === "mine" ? "theirs" : "mine";
      const os = sideBy(O), oi = O === "mine" ? m : t;
      const items = new Items();
      const side = (v: string) => (O === "mine" ? { mine: v, theirs: null } : { mine: null, theirs: v });
      const ot = str(os.t.row_titles[oi]), bt = str(base.row_titles[b]);
      if (ot !== bt) items.push({ what: "rowTitle", rowId: id, base: bt, ...side(ot) });
      const ox = xy ? str(os.t.x[oi]) : "", bx = xy ? str(base.x[b]) : "";
      if (ox !== bx) items.push({ what: "x", rowId: id, base: bx, ...side(ox) });
      os.t.col_ids.forEach((cid, oc) => {
        const bc = B.col.get(cid) ?? -1;
        for (let k = 0; k < K; k++) {
          const ov = cellAt(os, oi, oc, k), bv = bc < 0 ? "" : cellAt(B, b, bc, k);
          if (ov !== bv) items.push({ what: "cell", rowId: id, colId: cid, rep: k, base: bc < 0 ? null : bv, ...side(ov) });
        }
      });
      if (items.n === 0) { e.fate = "removed"; e.from = D; continue; }
      if (!rowHasData(base, b)) { e.added = O; e.from = O; }          // the blank-row case: kept, no question
      else { e.fate = "conflict"; e.del = D; e.items = items; }
    }

    // Padding (§2.2.5): never data on any side that has it, and not a row of the base above its tail.
    e.padding = inTail(B, b) && inTail(M, m) && inTail(T, t);
    const firstVal = (mv: string, tv: string) => (mineFirst ? mv : tv);

    const vals = new Array<string>(nC * K);
    const placeItems = new Items();
    const counted = b >= 0 && m >= 0 && t >= 0 && !e.padding && !splitBy;     // changes inside a row of the base
    if (m >= 0 && t >= 0) {
      const bt = b >= 0 ? str(base.row_titles[b]) : null, mt = str(mine.row_titles[m]), tt = str(theirs.row_titles[t]);
      const bx = xy ? (b >= 0 ? str(base.x[b]) : null) : null, mx = xy ? str(mine.x[m]) : "", tx = xy ? str(theirs.x[t]) : "";
      // Fixer (finding VUX-1): when the row's title or X value is to choose, the row itself is in question, so
      // the choice takes the whole row: every value the two sides have differently is part of that choice.
      // Fixer round 2 (RV-1): also a row that may be the other computer's entry under this computer's old id.
      // Fixer round 3 (safety net): never two people's new entries in one row. A row both sides put different data
      // into that was blank (or not there) in the base and was not split, or a row of the base that one side
      // rewrote completely (no value left in common with the base) while the other changed it too, is one choice
      // of the whole row; then choosing a side takes all of that side's row.
      const entry = !e.padding && !splitBy && entryInQuestion(id, base, b, mine, m, theirs, t, xy);
      const whole = !e.padding && (three(bt ?? "", mt, tt) === CONF || (xy && three(bx ?? "", mx, tx) === CONF) || rekeyed.unsure.has(id) || entry);
      const entryWhole = entry || rekeyed.unsure.has(id);
      const three1 = (what: "rowTitle" | "x", bv: string | null, mv: string, tv: string, pos: number): string => {
        const c = three(bv ?? "", mv, tv);
        if (c === CONF || (whole && mv !== tv)) {
          if (e.padding) return firstVal(mv, tv);
          e.places.push({ pos, m: mv, t: tv });
          placeItems.push({ what, rowId: id, base: bv, mine: mv, theirs: tv });
          return mv;
        }
        const v = valOf(c, mv, tv);
        if (c !== UNCH && counted) e.autos.push({ what, from: fromOf(c), rowId: id, before: bv ?? "", after: v });
        return v;
      };
      e.title = three1("rowTitle", bt, mt, tt, -1);
      e.x = xy ? three1("x", bx, mx, tx, -2) : "";
      for (let p = 0; p < nC; p++) {
        const ce = candCols[p];
        for (let k = 0; k < K; k++) {
          const pos = p * K + k;
          if (ce.m >= 0 && ce.t >= 0) {
            const inBase = b >= 0 && ce.b >= 0;
            const bv = inBase ? cellAt(B, b, ce.b, k) : "";
            const mv = cellAt(M, m, ce.m, k), tv = cellAt(T, t, ce.t, k);
            const c = three(bv, mv, tv);
            if (c === CONF || (whole && mv !== tv)) {
              if (e.padding) { vals[pos] = firstVal(mv, tv); continue; }
              e.places.push({ pos, m: mv, t: tv });
              placeItems.push({ what: "cell", rowId: id, colId: ce.id, rep: k, base: inBase ? bv : null, mine: mv, theirs: tv });
              vals[pos] = mv;
            } else {
              const v = valOf(c, mv, tv);
              vals[pos] = v;
              if (c !== UNCH && counted && inBase) e.autos.push({ what: "cell", from: fromOf(c), rowId: id, colId: ce.id, rep: k, before: bv, after: v });
            }
          } else if (ce.m >= 0 || ce.t >= 0) {
            // A column only one side has: its value, unless the row is one choice as a whole entry (then it is
            // that side's, and blank when the other side is chosen).
            const mv = ce.m >= 0 ? cellAt(M, m, ce.m, k) : "", tv = ce.t >= 0 ? cellAt(T, t, ce.t, k) : "";
            vals[pos] = ce.m >= 0 ? mv : tv;
            if (entryWhole && mv !== tv) {
              e.places.push({ pos, m: mv, t: tv });
              const inBase = b >= 0 && ce.b >= 0;
              placeItems.push({ what: "cell", rowId: id, colId: ce.id, rep: k, base: inBase ? cellAt(B, b, ce.b, k) : null, mine: ce.m >= 0 ? mv : null, theirs: ce.t >= 0 ? tv : null });
            }
          } else vals[pos] = "";
        }
      }
    } else {
      // One side has the row: its values (cells in columns it lacks are blank).
      const os = m >= 0 ? M : T, oi = m >= 0 ? m : t;
      e.title = str(os.t.row_titles[oi]);
      e.x = xy ? str(os.t.x[oi]) : "";
      for (let p = 0; p < nC; p++) {
        const oc = os === M ? candCols[p].m : candCols[p].t;
        for (let k = 0; k < K; k++) vals[p * K + k] = oc >= 0 ? cellAt(os, oi, oc, k) : "";
      }
    }
    e.vals = vals;
    e.placeItems = e.places.length ? placeItems : null;
    e.dataEither = !isBlank(e.title) || !isBlank(e.x) || vals.some((v) => !isBlank(v)) ||
      e.places.some((pl) => !isBlank(pl.m) || !isBlank(pl.t));
  }
  {
    let withData = 0;
    for (const e of rows.values()) if (e.fate !== "removed" && e.dataEither) withData++;
    if (withData > MAX_ROWS) return wholeTable(input, choices);
  }

  // ── conflicts, in display order (§2.2.8) ──
  const conflicts: FineConflict[] = [];
  const pickOf = (id: string): SidePick | null => { const c = choices[id]; return c === "mine" || c === "theirs" ? c : null; };
  const opts = (): FineConflict["options"] => ["mine", "theirs"];
  for (const owner of [M, T]) {
    for (const id of owner.t.col_ids) {
      const e = cols.get(id)!;
      if (e.fate !== "conflict" || sideBy(e.del!) === owner) continue;
      conflicts.push({ id: `table:col:${id}`, section: "table", kind: "colDeleted", colId: id, deletedBy: e.del, options: opts(), items: e.items!.list, more: e.items!.more });
    }
  }
  // Column titles.
  const colTitle = new Map<string, string>();        // without a choice for a conflicting title: mine's
  const colTitlePlaces = new Map<string, { m: string; t: string }>();
  const colTitleAutos = new Map<string, FineAuto>();
  for (const e of candCols) {
    if (e.m >= 0 && e.t >= 0) {
      const bv = e.b >= 0 ? str(base.col_titles[e.b]) : "";
      const mv = str(mine.col_titles[e.m]), tv = str(theirs.col_titles[e.t]);
      const c = three(bv, mv, tv);
      if (c === CONF) {
        colTitle.set(e.id, mv);
        colTitlePlaces.set(e.id, { m: mv, t: tv });
        conflicts.push({
          id: `table:coltitle:${e.id}`, section: "table", kind: "colTitle", colId: e.id, options: opts(),
          items: [{ what: "colTitle", colId: e.id, base: e.b >= 0 ? bv : null, mine: mv, theirs: tv }], more: 0,
        });
      } else {
        colTitle.set(e.id, valOf(c, mv, tv));
        if (c !== UNCH && e.b >= 0) colTitleAutos.set(e.id, { what: "colTitle", from: fromOf(c), colId: e.id, before: bv, after: valOf(c, mv, tv) });
      }
    } else colTitle.set(e.id, e.m >= 0 ? str(mine.col_titles[e.m]) : str(theirs.col_titles[e.t]));
  }
  // The X title.
  const xtCode = three(base.x_title, mine.x_title, theirs.x_title);
  if (xtCode === CONF) {
    conflicts.push({
      id: "table:field:x_title", section: "table", kind: "tableField", field: "x_title", options: opts(),
      items: [{ what: "xTitle", field: "x_title", base: base.x_title, mine: mine.x_title, theirs: theirs.x_title }], more: 0,
    });
  }
  // Rows: mine's order, then the rows mine lacks in theirs' order.
  for (const owner of [M, T]) {
    for (const id of owner.t.row_ids) {
      const e = rows.get(id)!;
      if (owner === T && e.m >= 0) continue;
      if (e.fate === "conflict") {
        conflicts.push({ id: `table:row:${id}`, section: "table", kind: "rowDeleted", rowId: id, deletedBy: e.del, options: opts(), items: e.items!.list, more: e.items!.more });
      } else if (e.fate === "kept" && e.placeItems) {
        conflicts.push({ id: `table:row:${id}`, section: "table", kind: "row", rowId: id, options: opts(), items: e.placeItems.list, more: e.placeItems.more });
      }
    }
  }
  const unresolved = conflicts.some((c) => pickOf(c.id) === null);

  // ── which rows / columns are in the result with these choices (unresolved: counted as kept) ──
  const keptHere = (e: ColEnt | RowEnt, cid: string) => {
    if (e.fate === "kept") return true;
    if (e.fate === "removed") return false;
    return pickOf(cid) !== e.del;
  };
  const keptCols = new Set(candCols.filter((e) => keptHere(e, `table:col:${e.id}`)).map((e) => e.id));
  const keptRows = new Set<string>();
  for (const e of rows.values()) if (keptHere(e, `table:row:${e.id}`)) keptRows.add(e.id);
  const colOrder = mergeOrder(base.col_ids, F.t.col_ids, S.t.col_ids, keptCols);
  const rowOrder = mergeOrder(base.row_ids, F.t.row_ids, S.t.row_ids, keptRows);

  // ── n_rep (§2.2.6 step 1): the three-way rule, the larger when both changed it ──
  let nRepRule: number;
  let nRepFrom: From;
  {
    const b = base.n_rep, m = mine.n_rep, t = theirs.n_rep;
    if (m === t) { nRepRule = m; nRepFrom = "same"; }
    else if (m === b) { nRepRule = t; nRepFrom = "theirs"; }
    else if (t === b) { nRepRule = m; nRepFrom = "mine"; }
    else { nRepRule = Math.max(m, t); nRepFrom = m > t ? "mine" : "theirs"; }
    if (template === "column") nRepRule = 1;
  }

  // ── the result ──
  let value: FileTable | null = null;
  let orderChecks: OrderCheck[] = [];
  const adjustments: FineAdjustment[] = [];
  let nRepFinal = nRepRule;
  if (!unresolved) {
    const colP = colOrder.map((id) => candPos.get(id)!);
    interface Out { id: string; title: string; x: string; cells: string[][]; data: boolean; padding: boolean }
    let out: Out[] = rowOrder.map((id) => {
      const e = rows.get(id)!;
      let title = e.title, x = e.x, vals = e.vals;
      if (e.places.length) {
        const side = pickOf(`table:row:${id}`)!;
        vals = vals.slice();
        for (const pl of e.places) {
          const v = side === "mine" ? pl.m : pl.t;
          if (pl.pos === -1) title = v; else if (pl.pos === -2) x = v; else vals[pl.pos] = v;
        }
      }
      const cells = colP.map((p) => vals.slice(p * K, p * K + K));
      const data = !isBlank(title) || !isBlank(x) || cells.some((reps) => reps.some((v) => !isBlank(v)));
      return { id, title, x, cells, data, padding: e.padding };
    });

    // Padding that ended up above the last row with data goes right after that row, keeping the
    // padding rows' relative order (§2.2.5 as changed by mergeTable: "after the last row with data",
    // not "the very end", so that combining the result again with either side gives it back, T7).
    let lastData = -1;
    out.forEach((r, i) => { if (r.data) lastData = i; });
    if (out.some((r, i) => r.padding && i < lastData)) {
      const moved = out.filter((r, i) => r.padding && i < lastData);
      const rest = out.filter((r, i) => !(r.padding && i < lastData));
      const at = rest.indexOf(out[lastData]) + 1;
      out = [...rest.slice(0, at), ...moved, ...rest.slice(at)];
    }

    // Replicates: never drop a value.
    let high = -1;
    for (const r of out) for (const reps of r.cells) for (let k = reps.length - 1; k > high; k--) if (!isBlank(reps[k])) { high = k; break; }
    nRepFinal = template === "column" ? 1 : Math.max(nRepRule, high + 1);
    if (nRepFinal > nRepRule) adjustments.push({ section: "table", kind: "replicates", from: String(nRepRule), to: String(nRepFinal) });
    for (const r of out) r.cells = r.cells.map((reps) => reps.slice(0, nRepFinal));

    // Too many rows: drop rows without data from the end.
    for (let i = out.length - 1; out.length > MAX_ROWS && i >= 0; i--) if (!out[i].data) out.splice(i, 1);

    // Blank rows the combine adds (ids hashed from the rows so far, never random).
    const taken = new Set(out.map((r) => r.id));
    const ids = out.map((r) => r.id);
    const addBlank = async () => {
      const seed = "las-fill\n" + ids.join("\n");
      let id = "";
      for (let n = 0; ; n++) {
        id = "row-" + (await sha256Hex(n === 0 ? seed : `${seed}\n${n}`)).slice(0, LIMITS_P4.fillIdHex);
        if (!taken.has(id)) break;
      }
      taken.add(id);
      ids.push(id);
      out.push({ id, title: "", x: "", cells: colP.map(() => Array.from({ length: nRepFinal }, () => "")), data: false, padding: false });
    };
    if (out.length > 0 && out.length < MAX_ROWS && out[out.length - 1].data) await addBlank();
    while (out.length < MIN_ROWS) await addBlank();

    const colTitles = colOrder.map((id) => {
      const pl = colTitlePlaces.get(id);
      if (pl) return pickOf(`table:coltitle:${id}`) === "mine" ? pl.m : pl.t;
      return colTitle.get(id)!;
    });
    const xTitle = xtCode === CONF
      ? (pickOf("table:field:x_title") === "mine" ? mine.x_title : theirs.x_title)
      : valOf(xtCode, mine.x_title, theirs.x_title);
    value = {
      v: 2,
      template,
      col_titles: colTitles,
      row_titles: out.map((r) => r.title),
      x_title: xTitle,
      n_rep: nRepFinal,
      x: out.map((r) => (xy ? r.x : "")),
      cells: out.map((r) => r.cells),
      row_ids: out.map((r) => r.id),
      col_ids: colOrder,
    };

    // ── order checks (§2.2.4), on the final lists ──
    const checks = (axis: "row" | "col", list: readonly string[], fIds: readonly string[], sIds: readonly string[], bIds: readonly string[],
      data: (id: string) => boolean, skip: (id: string) => boolean, matters: boolean): OrderCheck[] => {
      const inF = new Set(fIds), inS = new Set(sIds), inB = new Set(bIds);
      const res: OrderCheck[] = [];
      let run: string[] = [];
      const flush = () => {
        if (run.length) {
          const fromF = run.some((id) => inF.has(id) && data(id)), fromS = run.some((id) => inS.has(id) && data(id));
          if (fromF && fromS) res.push({ axis, ids: run, matters });
        }
        run = [];
      };
      for (const id of list) {
        if (!skip(id) && !inB.has(id) && inF.has(id) !== inS.has(id)) run.push(id);
        else flush();
      }
      flush();
      const sharedF = fIds.filter((id) => inS.has(id) && !skip(id)), sharedS = sIds.filter((id) => inF.has(id) && !skip(id));
      if (sharedF.some((id, i) => id !== sharedS[i])) res.push({ axis, ids: [], matters: true });
      return res;
    };
    const outById = new Map(out.map((r) => [r.id, r]));
    const padding = (id: string) => rows.get(id)?.padding ?? false;
    // A row both sides typed into that was split (finding M1) counts as added by its keeper: the two rows are an
    // insertion in the same place by both.
    const firstKeeps: SidePick = mineFirst ? "mine" : "theirs";
    const notFor = (ids: readonly string[], drop: (id: string) => boolean) => (split.keeper.size ? ids.filter((id) => !drop(id)) : ids);
    const fRows = notFor(F.t.row_ids, (id) => split.keeper.has(id) && split.keeper.get(id) !== firstKeeps);
    const sRows = notFor(S.t.row_ids, (id) => split.keeper.get(id) === firstKeeps);
    const bRows = notFor(base.row_ids, (id) => split.keeper.has(id));
    orderChecks = [
      ...checks("col", colOrder, F.t.col_ids, S.t.col_ids, base.col_ids, () => true, () => false, true),
      ...checks("row", value.row_ids, fRows, sRows, bRows, (id) => outById.get(id)?.data ?? false, padding, template !== "column"),
    ];
  }

  // ── what was combined without a choice (§2.2.7): columns, titles, replicates, then rows ──
  const autos: FineAuto[] = [];
  for (const id of colOrder) {
    const e = cols.get(id)!;
    if (e.fate === "kept" && e.b < 0) autos.push({ what: "colAdded", from: e.from, colId: id, before: null, after: colTitle.get(id) ?? "" });
  }
  for (const id of base.col_ids) {
    const e = cols.get(id)!;
    if (e.fate === "removed") autos.push({ what: "colRemoved", from: e.from, colId: id, before: str(base.col_titles[e.b]), after: null });
  }
  for (const id of colOrder) { const a = colTitleAutos.get(id); if (a) autos.push(a); }
  if (xtCode !== CONF && xtCode !== UNCH) {
    autos.push({ what: "xTitle", from: fromOf(xtCode), field: "x_title", before: base.x_title, after: valOf(xtCode, mine.x_title, theirs.x_title) });
  }
  if (template !== "column" && nRepFinal !== base.n_rep) {
    const from: From = mine.n_rep === nRepFinal && theirs.n_rep === nRepFinal ? "same"
      : mine.n_rep === nRepFinal ? "mine" : theirs.n_rep === nRepFinal ? "theirs" : nRepFrom;
    autos.push({ what: "replicates", from, before: String(base.n_rep), after: String(nRepFinal) });
  }
  for (const id of rowOrder) {
    const e = rows.get(id)!;
    if (e.fate !== "kept" || e.padding) continue;
    if (e.added) autos.push({ what: "rowAdded", from: e.added, rowId: id, before: null, after: e.title });
    for (const a of e.autos) autos.push(a);
  }
  for (const id of base.row_ids) {
    const e = rows.get(id)!;
    if (e.fate === "removed") autos.push({ what: "rowRemoved", from: e.from, rowId: id, before: str(base.row_titles[e.b]), after: null });
  }

  const rowNotes: TableRowNotes | null = split.keeper.size || rekeyed.moved.length
    ? { split: base.row_ids.filter((id) => split.keeper.has(id)), moved: rekeyed.moved }
    : null;
  return {
    whole: null,
    value,
    conflicts,
    combined: autos.length,
    auto: autos.slice(0, LIMITS_P4.autoItems),
    orderChecks,
    adjustments,
    ...(rowNotes ? { rowNotes } : {}),
  };
}

({ mergeTable, mergeOrder }) satisfies MergeTableApi;
