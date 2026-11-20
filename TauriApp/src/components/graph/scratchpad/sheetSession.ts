/* One open Scratchpad sheet: an IronCalc model plus snapshot undo/redo, every
   edit the grid can make, clipboard and fill helpers, and conversion to/from
   the saved ScratchDoc. No React and no asset imports, so it runs in node
   tests (after initSync). The engine must be initialised before use. */

import { Model, type Area } from "@ironcalc/wasm";
import {
  DEFAULT_COL_WIDTH, SCRATCH_BYTES_LIMIT, SCRATCH_COLS, SCRATCH_INPUT_MAX, SCRATCH_ROWS, canonScratch, cellName, clampWidth,
  norm, parseScratch, toTsv, type CellRange, type ScratchCell,
} from "./scratchModel";
import {
  countOverArray, droppedTail, fillSeries, formatGeneral, formulaBody, isDateDifference, isDateFmt, plainNumberText,
  recogniseInput, shrinkRangesForDelete, tooComplex, type FillSrc,
} from "./excelText";

export type EditResult =
  | { ok: true; changed: boolean; truncated?: boolean; range?: CellRange; asText?: { count: number; first: string; why: string } }
  | { ok: false; reason: "full" | "bounds" | "error" | "invalid" | "fatal"; message: string };

/** Engine cell-type codes (getCellType). Empty cells report NUMBER: check `isEmpty` first. */
export const CELL_NUMBER = 1;
export const CELL_TEXT = 2;
export const CELL_BOOLEAN = 4;
export const CELL_ERROR = 16;

const UNDO_MAX = 100;
const UNDO_MAX_BYTES = 48 * 1024 * 1024;
/** Loops that touch every selected cell stop here (a whole-sheet selection is 1.5 M cells). */
const MAX_LOOP_CELLS = 250_000;
/** Recreate the model from its bytes now and then: drops the engine's own (unused) undo history. */
const RECYCLE_EVERY = 200;

/** Restyling more cells than this at once is limited to the cells in use (a whole-sheet format would take seconds). */
const MAX_STYLE_CELLS = 30_000;
/** Formulas in one external paste that are checked one by one (the rest only for size). */
const MAX_CHECKED_FORMULAS = 5_000;

const FULL_MSG = "The scratchpad is full — that change wasn't applied. Delete some cells to make room.";
const PROBLEM_MSG = "There's a problem with this formula. Check the brackets and that arguments are separated by commas.";
const COUNT_MSG = "COUNT can't count the values of an array or array expression here (the scratchpad's engine would wrongly give 0). "
  + "Count a cell range instead, e.g. =COUNT(A1:A10), or use COUNTIF / COUNTIFS.";
export const FATAL_MSG = "The scratchpad's formula engine stopped after an entry it couldn't handle. "
  + "Everything up to your last change is kept with this analysis.";
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A trap inside the WebAssembly engine: its memory can no longer be trusted. */
function isFatal(e: unknown): boolean {
  if (typeof WebAssembly !== "undefined" && e instanceof WebAssembly.RuntimeError) return true;
  return /memory access out of bounds|unreachable|null pointer passed to rust|recursive use of an object/i.test(errText(e));
}

const unitArea = (r: number, c: number): Area => ({ sheet: 0, row: r, column: c, width: 1, height: 1 });

const intersect = (a: CellRange, b: CellRange): CellRange | null => {
  const g = { r1: Math.max(a.r1, b.r1), c1: Math.max(a.c1, b.c1), r2: Math.min(a.r2, b.r2), c2: Math.min(a.c2, b.c2) };
  return g.r1 <= g.r2 && g.c1 <= g.c2 ? g : null;
};

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function timezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

function newModel(): Model {
  try { return new Model("Scratchpad", "en", timezone(), "en"); } catch { return new Model("Scratchpad", "en", "UTC", "en"); }
}

const area = (g: CellRange): Area => ({ sheet: 0, row: g.r1, column: g.c1, width: g.c2 - g.c1 + 1, height: g.r2 - g.r1 + 1 });
const cellsIn = (g: CellRange) => (g.r2 - g.r1 + 1) * (g.c2 - g.c1 + 1);

/** Tab-separated clipboard text → rows of cells, honouring Excel's quoting
 *  ("a<TAB>b" in quotes, "" for a quote). One trailing newline is dropped. */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let i = 0;
  const n = text.length;
  let field = "";
  let atStart = true;
  while (i < n) {
    const ch = text[i];
    if (atStart && ch === '"') {
      // quoted field: up to the closing quote that is followed by a delimiter / end
      let j = i + 1;
      let val = "";
      let closed = false;
      while (j < n) {
        if (text[j] === '"') {
          if (text[j + 1] === '"') { val += '"'; j += 2; continue; }
          const nx = text[j + 1];
          if (nx === undefined || nx === "\t" || nx === "\n" || nx === "\r") { closed = true; j++; break; }
          break;   // a quote in the middle: not a quoted field after all
        }
        val += text[j++];
      }
      if (closed) { field = val; i = j; atStart = false; continue; }
    }
    if (ch === "\t") { row.push(field); field = ""; atStart = true; i++; continue; }
    if (ch === "\r" || ch === "\n") {
      row.push(field); rows.push(row); row = []; field = ""; atStart = true;
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += ch;
    atStart = false;
    i++;
  }
  if (!atStart || field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

interface InternalClip {
  data: ReturnType<Model["copyToClipboard"]>["data"];
  range: [number, number, number, number];
  tsv: string;
  cut: boolean;
}

export class SheetSession {
  model: Model;
  /** Bumped by every change (edit, undo, redo); the grid re-renders on it. */
  version = 0;
  private undo: Uint8Array[] = [];
  private redo: Uint8Array[] = [];
  private undoBytes = 0;
  private sinceRecycle = 0;
  clip: InternalClip | null = null;
  /** The engine trapped (see isFatal): nothing may touch it again; the sheet is read-only until the window reloads. */
  broken = false;
  /** An empty model where typed formulas are tried out before they reach the sheet. */
  private probe: Model | null = null;
  /** Shown text per cell for the current version (the grid asks for it on every render). */
  private shown = new Map<number, string>();
  private shownVersion = -1;
  /** A copy of the model, made on demand per version, for reading exact values of small numbers. */
  private valueClone: { v: number; m: Model } | null = null;

  constructor(text: string) {
    this.model = SheetSession.build(text);
  }

  /** Build a model from saved scratchpad text (bad entries are stored as text, never thrown). */
  static build(text: string): Model {
    const doc = parseScratch(text);
    let m = newModel();
    m.pauseEvaluation();
    for (const [r, c, input] of doc.cells) {
      // A formula too deep for the engine (it would crash it) is kept as text.
      if (tooComplex(input)) { try { m.setUserInput(0, r, c, `'${input}`); } catch { /* skip */ } continue; }
      try { m.setUserInput(0, r, c, input); } catch {
        try { m.setUserInput(0, r, c, `'${input}`); } catch { /* skip */ }
      }
    }
    m.resumeEvaluation();
    m.evaluate();
    for (const cell of doc.cells) {
      const [r, c] = cell;
      const fmt = cell.length === 4 ? cell[3] : "general";
      try {
        if (m.getCellStyle(0, r, c).style.num_fmt !== fmt) {
          m.updateRangeStyle({ sheet: 0, row: r, column: c, width: 1, height: 1 }, "num_fmt", fmt);
        }
      } catch { /* keep general */ }
    }
    for (const [k, w] of Object.entries(doc.cols ?? {})) {
      const col = Number(k);
      try { m.setColumnsWidth(0, col, col, clampWidth(w)); } catch { /* ignore */ }
    }
    // A clean model without the engine's own (unused) undo history.
    const fresh = Model.fromBytes(m.toBytes(), "en");
    m.free();
    m = fresh;
    m.flushSendQueue();
    return m;
  }

  dispose(): void {
    if (!this.broken) {
      try { this.model.free(); } catch { /* already freed */ }
      try { this.probe?.free(); } catch { /* ignore */ }
      try { this.valueClone?.m.free(); } catch { /* ignore */ }
    }
    this.probe = null;
    this.valueClone = null;
    this.undo = [];
    this.redo = [];
  }

  // ── reading ───────────────────────────────────────────────────────────────

  /** The cell as shown: the engine's formatted value, except that numbers in
   *  General format follow Excel's General rule (formatGeneral, 11 characters). */
  display(r: number, c: number): string {
    if (this.broken) return "";
    if (this.shownVersion !== this.version || this.shown.size > 50_000) { this.shown.clear(); this.shownVersion = this.version; }
    const key = r * 512 + c;
    const hit = this.shown.get(key);
    if (hit !== undefined) return hit;
    let s: string;
    try { s = this.model.getFormattedCellValue(0, r, c); } catch { return ""; }
    if (s !== "" && this.isGeneralNumber(r, c)) {
      const v = this.numberValue(r, c, s);
      if (v !== null) s = formatGeneral(v, 11) ?? s;
    } else if (s === "#VALUE!" && this.dateNumberOutOfRange(r, c)) {
      // A number the date format can't show (negative, or below 1): Excel shows
      // ##### for a negative date, and the plain number is more useful otherwise.
      const v = this.rawNumber(r, c);
      s = v === null ? s : v < 0 ? "#####" : formatGeneral(v, 11) ?? String(v);
    }
    this.shown.set(key, s);
    return s;
  }

  /** A number cell with a date format whose value the engine's date formatter rejects. */
  private dateNumberOutOfRange(r: number, c: number): boolean {
    if (this.cellType(r, c) !== CELL_NUMBER || !isDateFmt(this.numFmt(r, c))) return false;
    try { return this.model.getFormattedCellValue(0, r, c) === "#VALUE!"; } catch { return false; }
  }

  /** The cell's numeric value at full precision, or null. */
  private rawNumber(r: number, c: number): number | null {
    return this.exactValue(r, c);
  }

  /** A number cell in General format. */
  private isGeneralNumber(r: number, c: number): boolean {
    if (this.cellType(r, c) !== CELL_NUMBER || this.isEmptyShown(r, c)) return false;
    const f = this.numFmt(r, c);
    return !f || f.toLowerCase() === "general";
  }

  private isEmptyShown(r: number, c: number): boolean {
    try { return this.model.getFormattedCellValue(0, r, c) === ""; } catch { return true; }
  }

  /** General numbers narrowed to fit a column (Excel drops decimals, then goes
   *  scientific, before showing ####). Null when the cell isn't a General number or nothing fits. */
  fitGeneral(r: number, c: number, fits: (text: string) => boolean): string | null {
    if (this.broken || !this.isGeneralNumber(r, c)) return null;
    let raw: string;
    try { raw = this.model.getFormattedCellValue(0, r, c); } catch { return null; }
    const v = this.numberValue(r, c, raw);
    if (v === null) return null;
    for (let n = 10; n >= 1; n--) {
      const t = formatGeneral(v, n);
      if (t !== null && fits(t)) return t;
    }
    return null;
  }

  /** The value of a number cell. The engine's General text keeps 9 decimals, so
   *  values below 1E-03 are read exactly from a copy of the model in scientific format. */
  private numberValue(r: number, c: number, engineText: string): number | null {
    const n = Number(engineText);
    if (Number.isFinite(n) && (Math.abs(n) >= 1e-3 || engineText === "0")) return n;
    return this.exactValue(r, c);
  }

  /** Full-precision value of a number cell (null when it can't be read). */
  exactValue(r: number, c: number): number | null {
    if (this.broken) return null;
    try {
      if (!this.valueClone || this.valueClone.v !== this.version) {
        try { this.valueClone?.m.free(); } catch { /* ignore */ }
        this.valueClone = null;
        this.valueClone = { v: this.version, m: Model.fromBytes(this.model.toBytes(), "en") };
      }
      const m = this.valueClone.m;
      m.updateRangeStyle(unitArea(r, c), "num_fmt", "0.00000000000000E+00");
      const n = Number(m.getFormattedCellValue(0, r, c));
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }

  /** What the user typed ("" for an empty cell or a cell filled by a spilling formula). */
  input(r: number, c: number): string {
    if (this.broken || this.spillAnchor(r, c)) return "";
    try { return this.model.getCellContent(0, r, c); } catch { return ""; }
  }

  /** The anchor of the dynamic array this cell is part of (not the anchor itself), or null. */
  spillAnchor(r: number, c: number): { r: number; c: number } | null {
    if (this.broken) return null;
    try {
      const s = this.model.getCellArrayStructure(0, r, c);
      if (typeof s === "object" && s && "DynamicChild" in s) return { r: s.DynamicChild[0], c: s.DynamicChild[1] };
      if (typeof s === "object" && s && "ArrayChild" in s) return { r: s.ArrayChild[0], c: s.ArrayChild[1] };
    } catch { /* ignore */ }
    return null;
  }

  /** Formula-bar text: the input, or the spilling formula for a cell it fills. */
  barText(r: number, c: number): string {
    const a = this.spillAnchor(r, c);
    if (a) {
      try { return this.model.getCellContent(0, a.r, a.c); } catch { return ""; }
    }
    return this.input(r, c);
  }

  /** No input and no spilled value. */
  isEmpty(r: number, c: number): boolean {
    if (this.broken) return true;
    try { return this.model.getCellContent(0, r, c) === ""; } catch { return true; }
  }

  cellType(r: number, c: number): number {
    if (this.broken) return CELL_TEXT;
    try { return this.model.getCellType(0, r, c); } catch { return CELL_TEXT; }
  }

  numFmt(r: number, c: number): string {
    if (this.broken) return "general";
    try { return this.model.getCellStyle(0, r, c).style.num_fmt; } catch { return "general"; }
  }

  colWidth(c: number): number {
    if (this.broken) return DEFAULT_COL_WIDTH;
    try { return this.model.getColumnWidth(0, c); } catch { return DEFAULT_COL_WIDTH; }
  }

  canUndo(): boolean { return !this.broken && this.undo.length > 0; }
  canRedo(): boolean { return !this.broken && this.redo.length > 0; }

  /** Rows (≤ grid) with any content in column c, ascending. */
  rowsWithData(c: number): number[] {
    if (this.broken) return [];
    try { return Array.from(this.model.getRowsWithData(0, c)).filter((r) => r <= SCRATCH_ROWS); } catch { return []; }
  }

  /** Bounding box of every non-empty cell, or null. */
  usedRange(): CellRange | null {
    let g: CellRange | null = null;
    for (let c = 1; c <= SCRATCH_COLS; c++) {
      const rows = this.rowsWithData(c).filter((r) => !this.isEmpty(r, c));
      if (!rows.length) continue;
      const r1 = rows[0], r2 = rows[rows.length - 1];
      g = g ? { r1: Math.min(g.r1, r1), c1: g.c1, r2: Math.max(g.r2, r2), c2: c } : { r1, c1: c, r2, c2: c };
    }
    return g;
  }

  /** Saved cells (inputs + number formats) and column widths, canonical text. */
  serialize(): string {
    if (this.broken) throw new Error(FATAL_MSG);
    const cells: ScratchCell[] = [];
    const cols: Record<string, number> = {};
    const m = this.model;
    for (let c = 1; c <= SCRATCH_COLS; c++) {
      const w = this.colWidth(c);
      if (w !== DEFAULT_COL_WIDTH) cols[String(c)] = clampWidth(w);
      for (const r of this.rowsWithData(c)) {
        const v = m.getCellContent(0, r, c);
        if (v === "" || this.spillAnchor(r, c)) continue;
        const f = this.numFmt(r, c);
        cells.push(f && f.toLowerCase() !== "general" ? [r, c, v, f] : [r, c, v]);
      }
    }
    return canonScratch({ cells, cols });
  }

  // ── snapshot undo ─────────────────────────────────────────────────────────

  private restore(bytes: Uint8Array): void {
    try { this.model.free(); } catch { /* ignore */ }
    this.model = Model.fromBytes(bytes, "en");
  }

  private push(stack: Uint8Array[], bytes: Uint8Array): void {
    stack.push(bytes);
    if (stack === this.undo) {
      this.undoBytes += bytes.length;
      while (this.undo.length > UNDO_MAX || (this.undoBytes > UNDO_MAX_BYTES && this.undo.length > 1)) {
        this.undoBytes -= this.undo.shift()!.length;
      }
    }
  }

  /** Apply `fn` as one undoable step; rolled back when it throws or makes the sheet too big. */
  private fatal(): EditResult {
    this.broken = true;
    this.clip = null;
    return { ok: false, reason: "fatal", message: FATAL_MSG };
  }

  private mutate(fn: () => { truncated?: boolean; range?: CellRange; asText?: { count: number; first: string; why: string } } | void): EditResult {
    if (this.broken) return { ok: false, reason: "fatal", message: FATAL_MSG };
    let before: Uint8Array;
    try { before = this.model.toBytes(); } catch (e) { return isFatal(e) ? this.fatal() : { ok: false, reason: "error", message: errText(e) }; }
    let extra: { truncated?: boolean; range?: CellRange; asText?: { count: number; first: string; why: string } } | void;
    try {
      extra = fn();
      this.model.flushSendQueue();
    } catch (e) {
      if (isFatal(e)) return this.fatal();
      try { this.restore(before); } catch { return this.fatal(); }
      return { ok: false, reason: "error", message: errText(e) };
    }
    let after: Uint8Array;
    try { after = this.model.toBytes(); } catch (e) { return isFatal(e) ? this.fatal() : { ok: false, reason: "error", message: errText(e) }; }
    if (sameBytes(before, after)) return { ok: true, changed: false, ...(extra ?? {}) };
    if (after.length > SCRATCH_BYTES_LIMIT && after.length > before.length) {
      this.restore(before);
      return { ok: false, reason: "full", message: FULL_MSG };
    }
    this.push(this.undo, before);
    this.redo = [];
    this.version++;
    if (++this.sinceRecycle >= RECYCLE_EVERY) { this.sinceRecycle = 0; this.restore(after); }
    return { ok: true, changed: true, ...(extra ?? {}) };
  }

  undoStep(): boolean {
    if (this.broken) return false;
    const prev = this.undo.pop();
    if (!prev) return false;
    this.undoBytes -= prev.length;
    try {
      this.redo.push(this.model.toBytes());
      this.restore(prev);
    } catch {
      this.fatal();
      return false;
    }
    this.clip = null;
    this.version++;
    return true;
  }

  redoStep(): boolean {
    if (this.broken) return false;
    const next = this.redo.pop();
    if (!next) return false;
    try {
      this.push(this.undo, this.model.toBytes());
      this.restore(next);
    } catch {
      this.fatal();
      return false;
    }
    this.clip = null;
    this.version++;
    return true;
  }

  // ── checking typed input ────────────────────────────────────────────────────

  private probeModel(): Model {
    if (!this.probe) this.probe = newModel();
    return this.probe;
  }

  /** Why `input` can't be entered in (r, c), as Excel would refuse it; null when it can.
   *  Formulas are tried in an empty model first: one the engine can't parse shows
   *  #ERROR!, and one it silently shortened ("=A2*1,5" → "=A2*1") is caught by
   *  comparing tokens. Formulas too deep for the engine never reach it. */
  checkInput(r: number, c: number, input: string): string | null {
    if (formulaBody(input) === null) return null;
    const deep = tooComplex(input);
    if (deep) return deep;
    if (countOverArray(input)) return COUNT_MSG;
    const m = this.probeModel();
    try {
      m.setUserInput(0, r, c, input);
      const stored = m.getCellContent(0, r, c);
      if (!stored.startsWith("=")) return null;                 // a number such as "-5"
      if (m.getFormattedCellValue(0, r, c) === "#ERROR!") return PROBLEM_MSG;
      const tail = droppedTail(input, stored);
      if (tail !== null) {
        return tail ? `There's a problem with this formula near “${tail.length > 40 ? `${tail.slice(0, 40)}…` : tail}”.` : PROBLEM_MSG;
      }
      return null;
    } catch (e) {
      if (isFatal(e)) { this.fatal(); return FATAL_MSG; }
      return null;
    } finally {
      try { if (!this.broken) m.rangeClearAll(0, r, c, r, c); } catch { /* ignore */ }
    }
  }

  /** Write one typed entry (inside mutate): Excel input forms the engine lacks are
   *  converted first, and a date-minus-date formula is shown as a number of days. */
  private write(r: number, c: number, text: string): void {
    const m = this.model;
    if (text === "") { m.rangeClearContents(0, r, c, r, c); return; }
    const fmtBefore = this.numFmt(r, c);
    m.setUserInput(0, r, c, text);
    if (formulaBody(text) !== null) {
      const stored = m.getCellContent(0, r, c);
      if (stored.startsWith("=")) {
        const fmtAfter = this.numFmt(r, c);
        if (fmtBefore.toLowerCase() === "general" && fmtAfter !== fmtBefore && isDateFmt(fmtAfter)
          && isDateDifference(stored, (rr, cc) => this.cellType(rr, cc) === CELL_NUMBER && isDateFmt(this.numFmt(rr, cc)))) {
          m.updateRangeStyle(unitArea(r, c), "num_fmt", "general");
        }
        return;
      }
    }
    if (text.startsWith("'") || this.cellType(r, c) !== CELL_TEXT) return;
    const rec = recogniseInput(text);
    if (!rec) return;
    m.setUserInput(0, r, c, rec.input);
    if (this.cellType(r, c) !== CELL_NUMBER) { m.setUserInput(0, r, c, text); return; }
    if (rec.fmt && fmtBefore.toLowerCase() === "general") m.updateRangeStyle(unitArea(r, c), "num_fmt", rec.fmt);
  }

  // ── edits ─────────────────────────────────────────────────────────────────

  private static inGrid(r: number, c: number) {
    return r >= 1 && r <= SCRATCH_ROWS && c >= 1 && c <= SCRATCH_COLS;
  }

  private bounds(): EditResult {
    return { ok: false, reason: "bounds", message: "That is outside the scratchpad." };
  }

  /** Type into one cell ("" clears it). Refused (as Excel refuses it) when the formula is malformed. */
  setInput(r: number, c: number, text: string): EditResult {
    if (!SheetSession.inGrid(r, c)) return this.bounds();
    const t = text.length > SCRATCH_INPUT_MAX ? text.slice(0, SCRATCH_INPUT_MAX) : text;
    if (t === "" && this.isEmpty(r, c)) return { ok: true, changed: false };
    const why = this.checkInput(r, c, t);
    if (why) return { ok: false, reason: this.broken ? "fatal" : "invalid", message: why };
    return this.mutate(() => this.write(r, c, t));
  }

  /** Enter `text` in the active cell and the same entry (references adjusted) in every other selected cell (⌘/Ctrl+Enter). */
  enterInRange(g: CellRange, r: number, c: number, text: string): EditResult {
    if (cellsIn(g) <= 1) return this.setInput(r, c, text);
    if (cellsIn(g) > MAX_LOOP_CELLS) return { ok: false, reason: "bounds", message: "Select fewer cells to fill at once." };
    const t = text.slice(0, SCRATCH_INPUT_MAX);
    const why = this.checkInput(r, c, t);
    if (why) return { ok: false, reason: this.broken ? "fatal" : "invalid", message: why };
    if (t === "") return this.clear(g);
    return this.mutate(() => {
      const m = this.model;
      this.write(r, c, t);
      m.setSelectedCell(r, c);
      m.setSelectedRange(r, c, r, c);
      const cb = m.copyToClipboard();
      for (let rr = g.r1; rr <= g.r2; rr++) {
        for (let cc = g.c1; cc <= g.c2; cc++) {
          if (rr === r && cc === c) continue;
          m.setSelectedCell(rr, cc);
          m.setSelectedRange(rr, cc, rr, cc);
          m.pasteFromClipboard(0, cb.range, cb.data, false);
        }
      }
    });
  }

  /** Delete / Backspace: clear contents (number formats stay, as in Excel). Only
   *  the part of the selection that holds anything is touched (a whole sheet is 1.5 M cells). */
  clear(g: CellRange): EditResult {
    const used = this.usedRange();
    const h = used ? intersect(norm(g), used) : null;
    if (!h) return { ok: true, changed: false };
    return this.mutate(() => this.model.rangeClearContents(0, h.r1, h.c1, h.r2, h.c2));
  }

  clearAll(): EditResult {
    return this.mutate(() => this.model.rangeClearAll(0, 1, 1, SCRATCH_ROWS, SCRATCH_COLS));
  }

  /** Number format for the selection. A selection of more than MAX_STYLE_CELLS
   *  cells is formatted only where cells are filled (formats of empty cells
   *  aren't saved anyway, and a whole-sheet format would take many seconds). */
  setNumFmt(g0: CellRange, fmt: string): EditResult {
    let g: CellRange | null = norm(g0);
    if (cellsIn(g) > MAX_STYLE_CELLS) {
      const used = this.usedRange();
      g = used ? intersect(g, used) : null;
      if (!g) return { ok: true, changed: false };
      if (cellsIn(g) > MAX_STYLE_CELLS * 10) {
        return { ok: false, reason: "bounds", message: "Select fewer cells to format at once." };
      }
    }
    const a = area(g);
    return this.mutate(() => this.model.updateRangeStyle(a, "num_fmt", fmt));
  }

  setColWidth(c1: number, c2: number, px: number): EditResult {
    return this.mutate(() => this.model.setColumnsWidth(0, c1, c2, clampWidth(px)));
  }

  /** Is any cell in rows (or columns) [from, SCRATCH_*] filled? Values spilled by a formula don't count. */
  private dataFrom(axis: "row" | "col", from: number): boolean {
    if (axis === "row") {
      for (let c = 1; c <= SCRATCH_COLS; c++) {
        for (const r of this.rowsWithData(c)) if (r >= from && !this.isEmpty(r, c) && !this.spillAnchor(r, c)) return true;
      }
      return false;
    }
    for (let c = from; c <= SCRATCH_COLS; c++) {
      for (const r of this.rowsWithData(c)) if (!this.isEmpty(r, c) && !this.spillAnchor(r, c)) return true;
    }
    return false;
  }

  /** Rewrite every formula (outside `skip`) with `fn` (inside mutate), keeping each cell's number format. */
  private rewriteFormulas(fn: (formula: string) => string | null, skip: (r: number, c: number) => boolean): void {
    const m = this.model;
    // Collect first, then write with evaluation paused: one recalculation for the
    // whole rewrite instead of one per formula (which grew quadratically).
    const edits: Array<[number, number, string, string]> = [];
    for (let c = 1; c <= SCRATCH_COLS; c++) {
      for (const r of this.rowsWithData(c)) {
        if (skip(r, c) || this.spillAnchor(r, c)) continue;
        const f = m.getCellContent(0, r, c);
        if (!f.startsWith("=")) continue;
        const next = fn(f);
        if (next === null || next === f) continue;
        edits.push([r, c, next, this.numFmt(r, c)]);
      }
    }
    if (!edits.length) return;
    m.pauseEvaluation();
    try {
      for (const [r, c, next] of edits) m.setUserInput(0, r, c, next);
    } finally {
      m.resumeEvaluation();
    }
    m.evaluate();
    for (const [r, c, , fmt] of edits) {
      if (this.numFmt(r, c) !== fmt) m.updateRangeStyle(unitArea(r, c), "num_fmt", fmt);
    }
  }

  insertRows(at: number, n: number): EditResult {
    if (at < 1 || at > SCRATCH_ROWS || n < 1) return this.bounds();
    if (this.dataFrom("row", SCRATCH_ROWS - n + 1)) {
      return { ok: false, reason: "bounds", message: `Rows can't be inserted: that would push cells past row ${SCRATCH_ROWS}, the end of the scratchpad.` };
    }
    return this.mutate(() => this.model.insertRows(0, at, n));
  }

  /** Delete rows; a range that loses its first or last rows shrinks (=SUM(A1:A5)
   *  with row 5 deleted becomes =SUM(A1:A4)), as in Excel. */
  deleteRows(at: number, n: number): EditResult {
    if (at < 1 || at > SCRATCH_ROWS || n < 1) return this.bounds();
    const d1 = at, d2 = at + n - 1;
    return this.mutate(() => {
      this.rewriteFormulas((f) => shrinkRangesForDelete(f, "row", d1, d2), (r) => r >= d1 && r <= d2);
      this.model.deleteRows(0, at, n);
    });
  }

  insertCols(at: number, n: number): EditResult {
    if (at < 1 || at > SCRATCH_COLS || n < 1) return this.bounds();
    if (this.dataFrom("col", SCRATCH_COLS - n + 1)) {
      return { ok: false, reason: "bounds", message: "Columns can't be inserted: that would push cells past the last column of the scratchpad." };
    }
    return this.mutate(() => this.model.insertColumns(0, at, n));
  }

  deleteCols(at: number, n: number): EditResult {
    if (at < 1 || at > SCRATCH_COLS || n < 1) return this.bounds();
    const d1 = at, d2 = at + n - 1;
    return this.mutate(() => {
      this.rewriteFormulas((f) => shrinkRangesForDelete(f, "col", d1, d2), (_r, c) => c >= d1 && c <= d2);
      this.model.deleteColumns(0, at, n);
    });
  }

  // ── clipboard ─────────────────────────────────────────────────────────────

  /** One cell as clipboard text: what is shown, except that formatted numbers
   *  are written plainly ("12,500" → 12500, "12.50%" → 0.125, "$7.50" → 7.5) so
   *  they paste into the Data table — and any app — as the same number. Dates,
   *  times and text are copied as shown. */
  clipText(r: number, c: number): string {
    const shown = this.display(r, c);
    if (shown === "" || this.cellType(r, c) !== CELL_NUMBER) return shown;
    if (this.dateNumberOutOfRange(r, c)) { const v = this.rawNumber(r, c); if (v !== null) return String(v); }
    if (this.isGeneralNumber(r, c)) return shown;
    return plainNumberText(shown) ?? shown;
  }

  /** The selection as clipboard TSV (what ⌘/Ctrl+C puts on the clipboard). */
  tsvDisplayed(g: CellRange): string {
    const rows: string[][] = [];
    for (let r = g.r1; r <= g.r2; r++) {
      const row: string[] = [];
      for (let c = g.c1; c <= g.c2; c++) row.push(this.clipText(r, c));
      rows.push(row);
    }
    return toTsv(rows);
  }

  /** Copy (or cut) a range: returns the TSV for the system clipboard and keeps
   *  the engine's copy so pasting it back inside the sheet adjusts references. */
  copy(g: CellRange, cut = false): string {
    if (this.broken) return "";
    const tsv = this.tsvDisplayed(g);
    try {
      this.model.setSelectedCell(g.r1, g.c1);
      this.model.setSelectedRange(g.r1, g.c1, g.r2, g.c2);
      const cb = this.model.copyToClipboard();
      this.clip = { data: cb.data, range: cb.range, tsv, cut };
    } catch {
      this.clip = null;
    }
    return tsv;
  }

  /** Paste clipboard `text` into the selection `target`. Text that is this
   *  sheet's own last copy is pasted from the engine's copy (formulas with
   *  adjusted references, cut moves cells); anything else is typed in as TSV. */
  paste(target: CellRange, text: string): EditResult {
    if (this.broken) return { ok: false, reason: "fatal", message: FATAL_MSG };
    const g = norm(target);
    const clip = this.clip;
    if (clip && text.replace(/\r?\n$/, "") === clip.tsv.replace(/\r?\n$/, "")) return this.pasteInternal(g, clip);
    const rows = parseTsv(text);
    if (!rows.length) return { ok: true, changed: false };
    if (rows.length === 1 && rows[0].length === 1) {
      // One value: into every selected cell, as Excel does.
      if (cellsIn(g) > MAX_LOOP_CELLS) return { ok: false, reason: "bounds", message: "Select fewer cells to paste into at once." };
      const v = rows[0][0].slice(0, SCRATCH_INPUT_MAX);
      if (v === "") return this.clear(g);
      const why = this.checkInput(g.r1, g.c1, v);
      if (why) return { ok: false, reason: this.broken ? "fatal" : "invalid", message: why };
      return this.mutate(() => {
        for (let r = g.r1; r <= g.r2; r++) {
          for (let c = g.c1; c <= g.c2; c++) this.write(r, c, v);
        }
        return { range: g };
      });
    }
    const width = Math.max(...rows.map((r) => r.length));
    const maxRows = SCRATCH_ROWS - g.r1 + 1, maxCols = SCRATCH_COLS - g.c1 + 1;
    const truncated = rows.length > maxRows || width > maxCols;
    const clipped = rows.slice(0, maxRows).map((r) => r.slice(0, maxCols).map((v) => v.slice(0, SCRATCH_INPUT_MAX)));
    const w = Math.min(width, maxCols);
    // Pad short lines so every cell of the block is written (blank cells clear, as in Excel).
    for (const r of clipped) while (r.length < w) r.push("");
    // Formulas are checked as if typed (the first MAX_CHECKED_FORMULAS fully, the
    // rest for size). One that can't be read is pasted as text, never shortened.
    let checked = 0;
    let asText: { count: number; first: string; why: string } | undefined;
    const recognise: [number, number, string][] = [];
    for (let i = 0; i < clipped.length; i++) {
      for (let j = 0; j < w; j++) {
        const v = clipped[i][j];
        if (!v) continue;
        const r = g.r1 + i, c = g.c1 + j;
        if (formulaBody(v) !== null) {
          const why = checked++ < MAX_CHECKED_FORMULAS ? this.checkInput(r, c, v) : tooComplex(v);
          if (this.broken) return { ok: false, reason: "fatal", message: FATAL_MSG };
          if (why) {
            clipped[i][j] = `'${v}`;
            if (asText) asText.count++; else asText = { count: 1, first: cellName(r, c), why };
          }
        } else if (/^\(|\d:\d|\d\/\d|[A-Za-z]{3}/.test(v)) {
          recognise.push([r, c, v]);
        }
      }
    }
    const range: CellRange = { r1: g.r1, c1: g.c1, r2: g.r1 + clipped.length - 1, c2: g.c1 + w - 1 };
    return this.mutate(() => {
      this.model.setSelectedCell(g.r1, g.c1);
      this.model.setSelectedRange(g.r1, g.c1, g.r1, g.c1);
      this.model.pasteCsvText({ sheet: 0, row: g.r1, column: g.c1, width: 1, height: 1 }, toTsv(clipped));
      // Excel input forms the engine keeps as text: times, d-mmm dates, (5) …
      for (const [r, c, v] of recognise) {
        if (this.cellType(r, c) === CELL_TEXT && recogniseInput(v)) this.write(r, c, v);
      }
      return { truncated, range, asText };
    });
  }

  private pasteInternal(g: CellRange, clip: InternalClip): EditResult {
    const [sr1, sc1, sr2, sc2] = clip.range;
    const h = sr2 - sr1 + 1, w = sc2 - sc1 + 1;
    const th = g.r2 - g.r1 + 1, tw = g.c2 - g.c1 + 1;
    // Tile when the selection is a whole multiple of the copied block (not for a cut).
    const tile = !clip.cut && th % h === 0 && tw % w === 0 && (th > h || tw > w);
    const ny = tile ? th / h : 1, nx = tile ? tw / w : 1;
    if (ny * nx > MAX_LOOP_CELLS) return { ok: false, reason: "bounds", message: "Select fewer cells to paste into at once." };
    const range: CellRange = { r1: g.r1, c1: g.c1, r2: Math.min(SCRATCH_ROWS, g.r1 + ny * h - 1), c2: Math.min(SCRATCH_COLS, g.c1 + nx * w - 1) };
    const truncated = g.r1 + ny * h - 1 > SCRATCH_ROWS || g.c1 + nx * w - 1 > SCRATCH_COLS;
    const res = this.mutate(() => {
      const m = this.model;
      for (let iy = 0; iy < ny; iy++) {
        for (let ix = 0; ix < nx; ix++) {
          const r = g.r1 + iy * h, c = g.c1 + ix * w;
          if (r > SCRATCH_ROWS || c > SCRATCH_COLS) continue;
          m.setSelectedCell(r, c);
          m.setSelectedRange(r, c, Math.min(r + h - 1, SCRATCH_ROWS), Math.min(c + w - 1, SCRATCH_COLS));
          m.pasteFromClipboard(0, clip.range, clip.data, clip.cut);
        }
      }
      // Anything that landed past the grid edge is removed (it couldn't be seen or saved).
      if (g.r1 + h - 1 > SCRATCH_ROWS) m.rangeClearAll(0, SCRATCH_ROWS + 1, g.c1, g.r1 + ny * h - 1, g.c1 + nx * w - 1);
      if (g.c1 + w - 1 > SCRATCH_COLS) m.rangeClearAll(0, g.r1, SCRATCH_COLS + 1, g.r1 + ny * h - 1, g.c1 + nx * w - 1);
      return { truncated, range };
    });
    if (res.ok && clip.cut) this.clip = null;   // a cut pastes once
    return res;
  }

  // ── fill ──────────────────────────────────────────────────────────────────

  /** ⌘/Ctrl+D: copy the top row of the selection down through it (a one-row
   *  selection copies the row above). ⌘/Ctrl+R: the same to the right. */
  fill(g: CellRange, dir: "down" | "right"): EditResult {
    const down = dir === "down";
    let src: CellRange, dst: CellRange;
    if (down) {
      if (g.r1 === g.r2) { if (g.r1 === 1) return { ok: true, changed: false }; src = { ...g, r1: g.r1 - 1, r2: g.r1 - 1 }; dst = g; }
      else { src = { ...g, r2: g.r1 }; dst = { ...g, r1: g.r1 + 1 }; }
    } else if (g.c1 === g.c2) { if (g.c1 === 1) return { ok: true, changed: false }; src = { ...g, c1: g.c1 - 1, c2: g.c1 - 1 }; dst = g; }
    else { src = { ...g, c2: g.c1 }; dst = { ...g, c1: g.c1 + 1 }; }
    const n = down ? dst.r2 - dst.r1 + 1 : dst.c2 - dst.c1 + 1;
    if (n > MAX_LOOP_CELLS) return { ok: false, reason: "bounds", message: "Select fewer cells to fill at once." };
    return this.mutate(() => {
      const m = this.model;
      m.setSelectedCell(src.r1, src.c1);
      m.setSelectedRange(src.r1, src.c1, src.r2, src.c2);
      const cb = m.copyToClipboard();
      for (let i = 0; i < n; i++) {
        const r = down ? dst.r1 + i : dst.r1, c = down ? dst.c1 : dst.c1 + i;
        m.setSelectedCell(r, c);
        m.setSelectedRange(r, c, down ? r : dst.r2, down ? dst.c2 : c);
        m.pasteFromClipboard(0, cb.range, cb.data, false);
      }
      return { range: g };
    });
  }

  /** A source cell of the fill handle, for fillSeries (null: formula, blank, boolean, error). */
  private fillSrc(r: number, c: number): FillSrc | null {
    const input = this.input(r, c);
    if (input === "" || input.startsWith("=")) return null;
    const t = this.cellType(r, c);
    if (t === CELL_TEXT) return { kind: "text", t: input.startsWith("'") ? input.slice(1) : input };
    if (t !== CELL_NUMBER) return null;
    const v = this.exactValue(r, c);
    return v === null ? null : { kind: "num", v, date: isDateFmt(this.numFmt(r, c)) };
  }

  /** Fill handle: extend `src` to `to` (same columns, or same rows) with Excel's
   *  auto-fill: relative references adjusted, number series (a linear trend for
   *  uneven steps), dates counting up by day, "Item 1" → "Item 2", Mon → Tue, Jan → Feb. */
  autoFill(src: CellRange, to: CellRange): EditResult {
    const s = norm(src), t = norm(to);
    const a = area(s);
    const vertical = t.c1 === s.c1 && t.c2 === s.c2 && (t.r1 !== s.r1 || t.r2 !== s.r2);
    const horizontal = t.r1 === s.r1 && t.r2 === s.r2 && (t.c1 !== s.c1 || t.c2 !== s.c2);
    if (!vertical && !horizontal) return { ok: true, changed: false };
    const toEdge = vertical ? (t.r2 > s.r2 ? t.r2 : t.r1) : (t.c2 > s.c2 ? t.c2 : t.c1);
    if (toEdge < 1 || toEdge > (vertical ? SCRATCH_ROWS : SCRATCH_COLS)) return this.bounds();
    // Series the engine doesn't make, worked out per line before anything changes.
    const extending = vertical ? t.r1 < s.r1 || t.r2 > s.r2 : t.c1 < s.c1 || t.c2 > s.c2;
    const series: { line: number; pos: number[]; out: string[] }[] = [];
    if (extending) {
      const lines = vertical ? [s.c1, s.c2] : [s.r1, s.r2];
      const first = vertical ? s.r1 : s.c1, last = vertical ? s.r2 : s.c2;
      const lo = vertical ? t.r1 : t.c1, hi = vertical ? t.r2 : t.c2;
      const pos: number[] = [];
      for (let p = lo; p <= hi; p++) if (p < first || p > last) pos.push(p);
      if (pos.length && (last - first + 1) * (lines[1] - lines[0] + 1) <= 10_000 && pos.length * (lines[1] - lines[0] + 1) <= MAX_LOOP_CELLS) {
        for (let line = lines[0]; line <= lines[1]; line++) {
          const srcs: FillSrc[] = [];
          let ok = true;
          for (let p = first; p <= last && ok; p++) {
            const f = vertical ? this.fillSrc(p, line) : this.fillSrc(line, p);
            if (f) srcs.push(f); else ok = false;
          }
          if (!ok) continue;
          const out = fillSeries(srcs, pos.map((p) => p - first));
          if (out) series.push({ line, pos, out });
        }
      }
    }
    return this.mutate(() => {
      if (vertical) this.model.autoFillRows(a, toEdge); else this.model.autoFillColumns(a, toEdge);
      for (const { line, pos, out } of series) {
        pos.forEach((p, i) => {
          const r = vertical ? p : line, c = vertical ? line : p;
          this.model.setUserInput(0, r, c, out[i]);
        });
      }
      return { range: t };
    });
  }

  // ── Send to Data ──────────────────────────────────────────────────────────

  /** Values for the Data table, at full precision: numbers as plain decimal text
   *  (15 significant digits, dates as serial numbers), text as shown (tabs and
   *  newlines as spaces), booleans TRUE/FALSE, errors and blanks as "". */
  valuesForData(g: CellRange): { tsv: string; rows: number; cols: number; errors: number; dates: number } {
    const clone = Model.fromBytes(this.model.toBytes(), "en");
    let errors = 0, dates = 0;
    const out: string[][] = [];
    try {
      clone.updateRangeStyle(area(g), "num_fmt", "0.00000000000000E+00");
      for (let r = g.r1; r <= g.r2; r++) {
        const row: string[] = [];
        for (let c = g.c1; c <= g.c2; c++) {
          const shown = this.display(r, c);
          if (shown === "" && this.isEmpty(r, c)) { row.push(""); continue; }
          const t = this.cellType(r, c);
          if (t === CELL_ERROR) { errors++; row.push(""); continue; }
          if (t === CELL_BOOLEAN) { row.push(shown.toUpperCase()); continue; }
          if (t === CELL_NUMBER) {
            const n = Number(clone.getFormattedCellValue(0, r, c));
            if (isDateFmt(this.numFmt(r, c))) dates++;
            row.push(Number.isFinite(n) ? String(n) : shown);
            continue;
          }
          row.push(shown.replace(/[\t\r\n]+/g, " "));
        }
        out.push(row);
      }
    } finally {
      clone.free();
    }
    return { tsv: out.map((r) => r.join("\t")).join("\n"), rows: g.r2 - g.r1 + 1, cols: g.c2 - g.c1 + 1, errors, dates };
  }
}
