/* Phase 4: fine-level combining of the Scratchpad (phase 4 contract §2.5).
   Cells are combined by address (A1, B12, …), a cell's value being its input
   together with its number format; column widths by column number. Before
   that, a check looks whether one side rearranged the sheet (inserted rows or
   columns, moved a block): then combining by address would mix unrelated
   cells, so the whole Scratchpad becomes one choice — mine, theirs, or both
   side by side (theirs placed to the right of mine, its formulas moved with it).

   Fixer (finding M2): the check also sees a row inserted or deleted near the
   end of a block (fewer cells move), and content one side moved out of a place
   the other side changed or refers to.

   Pure and synchronous; no formula engine (references are moved by text), no
   I/O, nothing that depends on the computer. */

import {
  LIMITS_P4,
  type FineAuto, type FineChoice, type FineChoices, type FineConflict, type FineItem, type MergeScratchApi,
  type ScratchMerge, type SidePick,
} from "./contract";
import {
  canonScratch, cellName, colName, colNumber, sanitizeScratch,
  DEFAULT_COL_WIDTH, SCRATCH_COLS, SCRATCH_INPUT_MAX, SCRATCH_ROWS, type ScratchCell,
} from "../scratchpad/scratchModel";

// ── a side as maps ───────────────────────────────────────────────────────────

interface Sheet {
  /** key = row * KEY + col → [input, numFmt or ""] */
  cells: Map<number, [string, string]>;
  /** column number → width (only widths that differ from the default) */
  cols: Map<number, number>;
  /** canonical text ("" = empty) */
  text: string;
}

const KEY = 1000;   // > SCRATCH_COLS
const rowOf = (k: number) => Math.floor(k / KEY);
const colOf = (k: number) => k % KEY;

/** A side (object, text or null) in canonical form, as maps. Anything that isn't a scratchpad counts as empty. */
function sheetOf(raw: unknown): Sheet {
  const text = sanitizeScratch(raw ?? "");
  const cells = new Map<number, [string, string]>();
  const cols = new Map<number, number>();
  if (text) {
    const doc = JSON.parse(text) as { cells: ScratchCell[]; cols?: Record<string, number> };
    for (const c of doc.cells) cells.set(c[0] * KEY + c[1], [c[2], c.length === 4 ? c[3] : ""]);
    for (const [k, w] of Object.entries(doc.cols ?? {})) cols.set(Number(k), w);
  }
  return { cells, cols, text };
}

/** Maps → the section in file form: exactly what sanitizeScratch gives back (null = empty). */
function valueOf(cells: Map<number, [string, string]>, cols: Map<number, number>): unknown | null {
  const list: ScratchCell[] = [];
  for (const k of [...cells.keys()].sort((a, b) => a - b)) {
    const [input, fmt] = cells.get(k)!;
    list.push(fmt ? [rowOf(k), colOf(k), input, fmt] : [rowOf(k), colOf(k), input]);
  }
  let c: Record<string, number> | undefined;
  for (const n of [...cols.keys()].sort((a, b) => a - b)) (c ??= {})[String(n)] = cols.get(n)!;
  const text = canonScratch({ cells: list, cols: c });
  return text ? (JSON.parse(text) as unknown) : null;
}

const fresh = (s: Sheet): unknown | null => (s.text ? (JSON.parse(s.text) as unknown) : null);

const pairText = (v: [string, string] | undefined) => (v ? JSON.stringify(v) : undefined);

// ── moving formulas ──────────────────────────────────────────────────────────

const BEFORE_STOP = /[A-Za-z0-9_.]/;
const AFTER_STOP = /[A-Za-z0-9_(]/;
/** A whole-column reference ("A:C", "$B:$B") or a cell reference ("A1", "$B$2"), at the current position. */
const COL_RANGE = /(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})/y;
const CELL_REF = /(\$?)([A-Za-z]{1,3})(\$?)(\d{1,5})/y;

/** Column letters moved `d` columns to the right, in the same letter case; null past the sheet. */
function moveLetters(letters: string, d: number): string | null {
  const n = colNumber(letters) + d;
  if (n < 1 || n > SCRATCH_COLS) return null;
  const name = colName(n);
  return letters === letters.toLowerCase() ? name.toLowerCase() : name;
}

/** A cell input with every column reference moved `dCols` to the right (§2.5.4). Text that is not a
 *  formula comes back as it is; inside a formula, text in double quotes and sheet names in single quotes
 *  are left alone. null when a reference would leave the sheet. */
export function shiftFormula(input: string, dCols: number): string | null {
  if (!input.startsWith("=") || dCols === 0) return input;
  let out = "=";
  let i = 1;
  const n = input.length;
  while (i < n) {
    const ch = input[i];
    if (ch === '"' || ch === "'") {
      // A quoted string ("…", "" = a quote inside) or a quoted sheet name ('…', '' likewise): copied as it is.
      let j = i + 1;
      while (j < n) {
        if (input[j] === ch) {
          if (input[j + 1] === ch) { j += 2; continue; }
          break;
        }
        j++;
      }
      out += input.slice(i, Math.min(j + 1, n));
      i = j + 1;
      continue;
    }
    const prev = i > 0 ? input[i - 1] : "";
    if ((ch === "$" || /[A-Za-z]/.test(ch)) && !BEFORE_STOP.test(prev)) {
      COL_RANGE.lastIndex = i;
      let m = COL_RANGE.exec(input);
      if (m && !AFTER_STOP.test(input[i + m[0].length] ?? "")) {
        const a = moveLetters(m[2], dCols), b = moveLetters(m[4], dCols);
        if (a === null || b === null) return null;
        out += `${m[1]}${a}:${m[3]}${b}`;
        i += m[0].length;
        continue;
      }
      CELL_REF.lastIndex = i;
      m = CELL_REF.exec(input);
      if (m && !AFTER_STOP.test(input[i + m[0].length] ?? "") && Number(m[4]) >= 1 && Number(m[4]) <= SCRATCH_ROWS) {
        const a = moveLetters(m[2], dCols);
        if (a === null) return null;
        out += `${m[1]}${a}${m[3]}${m[4]}`;
        i += m[0].length;
        continue;
      }
      if (m) {   // looks like a reference but isn't one (a name, a function, a row past the sheet): as typed
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

// ── both side by side ────────────────────────────────────────────────────────

function sideBySideSheets(m: Sheet, t: Sheet): unknown | null {
  let maxCol = 0;
  for (const k of m.cells.keys()) maxCol = Math.max(maxCol, colOf(k));
  const d = maxCol === 0 ? 0 : maxCol + LIMITS_P4.bothGapCols;
  const cells = new Map(m.cells);
  for (const [k, [input, fmt]] of t.cells) {
    const c = colOf(k) + d;
    if (c > SCRATCH_COLS) return null;
    const moved = shiftFormula(input, d);
    if (moved === null || moved.length > SCRATCH_INPUT_MAX) return null;
    cells.set(rowOf(k) * KEY + c, [moved, fmt]);
  }
  const cols = new Map(m.cols);
  for (const [c, w] of t.cols) {
    const to = c + d;
    // A width is not a value: one that would land past the sheet is left out; mine's widths stay.
    if (to <= SCRATCH_COLS && !cols.has(to)) cols.set(to, w);
  }
  return valueOf(cells, cols);
}

/** Mine with theirs placed to its right, one blank column between (§2.5.4); null when it does not fit. */
export function sideBySide(mine: unknown | null, theirs: unknown | null): unknown | null {
  return sideBySideSheets(sheetOf(mine), sheetOf(theirs));
}

// ── the shift check ──────────────────────────────────────────────────────────

/** Fixer (finding M2): moved content needs only this many cells at one offset (LIMITS_P4.shiftOffsetMinCells
 *  was 5, which missed a row inserted or deleted near the end of a block: only the cells below it move). */
const SHIFT_MOVED_MIN = 2;

const isFormula = (input: string) => input.startsWith("=");

/** The base addresses whose input on `s` is different or gone. */
function changedOf(b: Sheet, s: Sheet): number[] {
  const changed: number[] = [];
  for (const [k, [input]] of b.cells) {
    const now = s.cells.get(k);
    if (!now || now[0] !== input) changed.push(k);
  }
  return changed.sort((x, y) => x - y);
}

/** Per offset "dr,dc": the changed base cells whose input stands on `s` at that offset where the base had
 *  something else (content that moved), at most LIMITS_P4.shiftSameInputCap places looked at per cell. */
function movedByOffset(b: Sheet, s: Sheet, changed: readonly number[]): Map<string, number[]> {
  const byInput = new Map<string, number[]>();
  for (const k of [...s.cells.keys()].sort((a, c) => a - c)) {
    const input = s.cells.get(k)![0];
    const list = byInput.get(input);
    if (!list) byInput.set(input, [k]);
    else if (list.length < LIMITS_P4.shiftSameInputCap) list.push(k);
  }
  const out = new Map<string, number[]>();
  for (const a of changed) {
    const input = b.cells.get(a)![0];
    for (const k of byInput.get(input) ?? []) {
      const dr = rowOf(k) - rowOf(a), dc = colOf(k) - colOf(a);
      if (dr === 0 && dc === 0) continue;
      if (b.cells.get(k)?.[0] === input) continue;   // it was there already: not moved content
      const key = `${dr},${dc}`;
      const l = out.get(key);
      if (l) l.push(a); else out.set(key, [a]);
    }
  }
  return out;
}

function shifted(b: Sheet, s: Sheet): boolean {
  const nB = b.cells.size;
  const changed = changedOf(b, s);
  // Rule A: much of the common version changed.
  if (nB >= LIMITS_P4.shiftMinBaseCells && changed.length > LIMITS_P4.shiftChangedShare * nB) return true;
  // Rule B: content reappears at one offset. A formula that is simply gone is not counted in the share: when
  // rows or columns are inserted or deleted, formulas that moved read the same at their new place (their
  // references moved with them), and only the ones at the edge disappear.
  if (changed.length < SHIFT_MOVED_MIN) return false;
  const counted = changed.filter((k) => !(isFormula(b.cells.get(k)![0]) && !s.cells.has(k))).length;
  const need = Math.max(SHIFT_MOVED_MIN, Math.ceil(LIMITS_P4.shiftOffsetShare * counted));
  for (const list of movedByOffset(b, s, changed).values()) if (list.length >= need) return true;
  return false;
}

/** Was `side` rearranged against `base` (either rule of §2.5.2)? Inputs only; formats are ignored. */
export function shiftCheck(base: unknown | null, side: unknown | null): boolean {
  return shifted(sheetOf(base), sheetOf(side));
}

/** The rectangles (row1, col1, row2, col2) a formula refers to: cells, ranges and whole columns (whole rows and
 *  names are left out). Text in quotes is skipped. */
function refRects(input: string): [number, number, number, number][] {
  if (!isFormula(input)) return [];
  const out: [number, number, number, number][] = [];
  const RANGE = /(\$?)([A-Za-z]{1,3})(\$?)(\d{1,5})(?::(\$?)([A-Za-z]{1,3})(\$?)(\d{1,5}))?/y;
  let i = 1;
  const n = input.length;
  while (i < n) {
    const ch = input[i];
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n && !(input[j] === ch && input[j + 1] !== ch)) j += input[j] === ch ? 2 : 1;
      i = j + 1;
      continue;
    }
    if ((ch === "$" || /[A-Za-z]/.test(ch)) && !BEFORE_STOP.test(input[i - 1] ?? "")) {
      COL_RANGE.lastIndex = i;
      const cr = COL_RANGE.exec(input);
      if (cr && !AFTER_STOP.test(input[i + cr[0].length] ?? "")) {
        const a = colNumber(cr[2]), c = colNumber(cr[4]);
        out.push([1, Math.min(a, c), SCRATCH_ROWS, Math.max(a, c)]);
        i += cr[0].length;
        continue;
      }
      RANGE.lastIndex = i;
      const m = RANGE.exec(input);
      if (m && !AFTER_STOP.test(input[i + m[0].length] ?? "")) {
        const r1 = Number(m[4]), c1 = colNumber(m[2]);
        const r2 = m[8] ? Number(m[8]) : r1, c2 = m[6] ? colNumber(m[6]) : c1;
        out.push([Math.min(r1, r2), Math.min(c1, c2), Math.max(r1, r2), Math.max(c1, c2)]);
        i += m[0].length;
        continue;
      }
      while (i < n && /[A-Za-z0-9_.$]/.test(input[i])) i++;
      continue;
    }
    i++;
  }
  return out;
}

/** Fixer (finding M2), rule C: `s` moved content out of a place it emptied (a row or column inserted or
 *  deleted, a block cut and pasted) — even fewer cells than rule B needs — and the other side `o` changed one
 *  of the places `s` changed or filled that way, or wrote a formula that refers to one of them. Combining by
 *  address would then put `o`'s value or reference next to different data. */
function movedUnderOther(b: Sheet, s: Sheet, o: Sheet): boolean {
  const changed = changedOf(b, s);
  if (!changed.length) return false;
  const touched = new Set<number>(changed);
  let moved = false;
  for (const [key, list] of movedByOffset(b, s, changed)) {
    const [dr, dc] = key.split(",").map(Number);
    for (const a of list) {
      if (s.cells.has(a)) continue;                  // the place it came from still holds something: an edit
      moved = true;
      touched.add((rowOf(a) + dr) * KEY + colOf(a) + dc);
    }
  }
  if (!moved) return false;
  for (const k of new Set([...b.cells.keys(), ...o.cells.keys()])) {
    const bo = pairText(b.cells.get(k)), oo = pairText(o.cells.get(k));
    if (bo === oo) continue;
    if (touched.has(k)) return true;
    const input = o.cells.get(k)?.[0];
    if (input === undefined) continue;
    for (const [r1, c1, r2, c2] of refRects(input)) {
      for (const t of touched) {
        const r = rowOf(t), c = colOf(t);
        if (r >= r1 && r <= r2 && c >= c1 && c <= c2) return true;
      }
    }
  }
  return false;
}

// ── combining ────────────────────────────────────────────────────────────────

const MINE_THEIRS: readonly FineChoice[] = ["mine", "theirs"];

function validChoice(choices: FineChoices | undefined, id: string, options: readonly FineChoice[]): FineChoice | null {
  const c = choices && Object.prototype.hasOwnProperty.call(choices, id) ? choices[id] : undefined;
  return c !== undefined && options.includes(c) ? c : null;
}

export function mergeScratch(
  input: { base: unknown | null; mine: unknown | null; theirs: unknown | null },
  choices?: FineChoices,
): ScratchMerge {
  const B = sheetOf(input.base), M = sheetOf(input.mine), T = sheetOf(input.theirs);

  // The shift check only matters when both sides changed the sheet, differently.
  if (M.text !== B.text && T.text !== B.text && M.text !== T.text
    && (shifted(B, M) || shifted(B, T) || movedUnderOther(B, M, T) || movedUnderOther(B, T, M))) {
    const both = sideBySideSheets(M, T);
    const options: FineChoice[] = both === null ? ["mine", "theirs"] : ["mine", "theirs", "both"];
    const id = "scratchpad:section";
    const conflict: FineConflict = { id, section: "scratchpad", kind: "section", reason: "shift", options, items: [], more: 0 };
    const ch = validChoice(choices, id, options);
    const value = ch === "mine" ? fresh(M) : ch === "theirs" ? fresh(T) : ch === "both" ? both : null;
    return { value, conflicts: [conflict], combined: 0, auto: [], orderChecks: [], adjustments: [], shift: true };
  }

  const conflicts: FineConflict[] = [];
  const auto: FineAuto[] = [];
  let combined = 0;
  let missing = false;
  const addAuto = (a: FineAuto) => { combined++; if (auto.length < LIMITS_P4.autoItems) auto.push(a); };
  const cells = new Map<number, [string, string]>();

  const keys = new Set<number>([...B.cells.keys(), ...M.cells.keys(), ...T.cells.keys()]);
  for (const k of [...keys].sort((a, b) => a - b)) {
    const b = B.cells.get(k), m = M.cells.get(k), t = T.cells.get(k);
    const bc = pairText(b), mc = pairText(m), tc = pairText(t);
    const addr = cellName(rowOf(k), colOf(k));
    const put = (v: [string, string] | undefined) => { if (v) cells.set(k, [v[0], v[1]]); };
    if (mc === tc) {
      put(m);
      if (mc !== bc) addAuto({ what: "scratch", addr, from: "same", before: b ? b[0] : null, after: m ? m[0] : null });
      continue;
    }
    if (mc === bc || tc === bc) {
      const from: SidePick = mc === bc ? "theirs" : "mine";
      const v = from === "theirs" ? t : m;
      put(v);
      addAuto({ what: "scratch", addr, from, before: b ? b[0] : null, after: v ? v[0] : null });
      continue;
    }
    const id = `scratchpad:cell:${addr}`;
    const items: FineItem[] = [{ what: "scratch", addr, base: b ? b[0] : null, mine: m ? m[0] : null, theirs: t ? t[0] : null }];
    if ((m ? m[1] : "") !== (t ? t[1] : "")) {
      items.push({ what: "scratchFormat", addr, base: b ? b[1] : null, mine: m ? m[1] : null, theirs: t ? t[1] : null });
    }
    conflicts.push({ id, section: "scratchpad", kind: "cell", addr, row: rowOf(k), col: colOf(k), options: MINE_THEIRS, items, more: 0 });
    const ch = validChoice(choices, id, MINE_THEIRS);
    if (ch === "mine") put(m);
    else if (ch === "theirs") put(t);
    else missing = true;
  }

  // Column widths: never a question; both changed one differently → the larger.
  const cols = new Map<number, number>();
  const colKeys = new Set<number>([...B.cols.keys(), ...M.cols.keys(), ...T.cols.keys()]);
  for (const c of [...colKeys].sort((a, b) => a - b)) {
    const b = B.cols.get(c), m = M.cols.get(c), t = T.cols.get(c);
    let v: number | undefined;
    let from: SidePick | "same" | null = null;
    if (m === t) { v = m; if (m !== b) from = "same"; }
    else if (m === b) { v = t; from = "theirs"; }
    else if (t === b) { v = m; from = "mine"; }
    else {
      const wm = m ?? DEFAULT_COL_WIDTH, wt = t ?? DEFAULT_COL_WIDTH;
      // Different widths, so one is larger (a missing width is the default one).
      if (wm > wt) { v = m; from = "mine"; } else { v = t; from = "theirs"; }
    }
    if (v !== undefined) cols.set(c, v);
    if (from) addAuto({ what: "colWidth", field: colName(c), from, before: b === undefined ? null : String(b), after: v === undefined ? null : String(v) });
  }

  return {
    value: missing ? null : valueOf(cells, cols),
    conflicts, combined, auto, orderChecks: [], adjustments: [], shift: false,
  };
}

({ mergeScratch, shiftCheck, shiftFormula, sideBySide }) satisfies MergeScratchApi;
