/* The cell references in a Scratchpad formula, with their positions in the text
   and one colour per distinct range (Excel's reference colours): used to colour
   the references in the editor and outline them on the grid. Tokens come from
   the engine's own lexer (getTokens), whose offsets are in code points; they are
   converted to UTF-16 offsets here. */

import { getTokens, type MarkedToken } from "@ironcalc/wasm";
import { SCRATCH_COLS, SCRATCH_ROWS, colName, norm, type CellRange } from "./scratchModel";

/** Blue, red, purple, green, pink, orange, teal (Excel's order). */
export const REF_COLORS = ["#6ea8ff", "#ff7b72", "#c39bff", "#5fd38a", "#ff8ad1", "#ffb057", "#4fd1d9"] as const;

export interface FormulaRef {
  /** UTF-16 offsets into the full text (leading whitespace trimmed off). */
  start: number;
  end: number;
  /** Normalised and clamped to 1..SCRATCH_ROWS / 1..SCRATCH_COLS. */
  range: CellRange;
  /** Index into REF_COLORS. */
  color: number;
}

const HI_SURROGATE = /[\uD800-\uDBFF]/;

/** A surrogate pair starts at i (a lone surrogate is one code point, as the engine counts it). */
function pairAt(text: string, i: number): boolean {
  const u = text.charCodeAt(i);
  if (u < 0xd800 || u > 0xdbff) return false;
  const v = text.charCodeAt(i + 1);
  return v >= 0xdc00 && v <= 0xdfff;
}

/** Code-point offset → UTF-16 offset. */
export function cpToUtf16(text: string, cp: number): number {
  if (!HI_SURROGATE.test(text)) return Math.min(cp, text.length);
  let i = 0;
  for (let n = 0; n < cp && i < text.length; n++) i += pairAt(text, i) ? 2 : 1;
  return i;
}

/** UTF-16 offset → code-point offset. */
export function utf16ToCp(text: string, i: number): number {
  if (!HI_SURROGATE.test(text)) return Math.min(i, text.length);
  let n = 0;
  for (let j = 0; j < i && j < text.length; n++) j += pairAt(text, j) ? 2 : 1;
  return n;
}

type RefTok = { sheet?: string | null; row: number; column: number };
type RangeTok = { sheet?: string | null; left: { row: number; column: number }; right: { row: number; column: number } };

const asRef = (t: MarkedToken): RefTok | null =>
  (typeof t.token === "object" && t.token && "Reference" in t.token ? (t.token as { Reference: RefTok }).Reference : null);
const asRange = (t: MarkedToken): RangeTok | null =>
  (typeof t.token === "object" && t.token && "Range" in t.token ? (t.token as unknown as { Range: RangeTok }).Range : null);
const isColon = (t: MarkedToken | undefined) => !!t && t.token === "Colon";
/** Only this sheet's references count (the Scratchpad has one sheet, "Sheet1"). */
const ownSheet = (s: string | null | undefined) => s == null || s.toLowerCase() === "sheet1";
const isSpace = (ch: string | undefined) => ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === " ";

/** The references in a formula ("=…"), in text order. [] for anything else or text the lexer can't read. */
export function formulaRefs(text: string): FormulaRef[] {
  if (!text.startsWith("=")) return [];
  let toks: MarkedToken[];
  try { toks = getTokens(text); } catch { return []; }
  const wide = HI_SURROGATE.test(text);
  const cps = wide ? Array.from(text) : null;
  const at = (cp: number) => (cps ? cps[cp] : text[cp]);
  const utf = (cp: number) => (wide ? cpToUtf16(text, cp) : cp);
  const out: FormulaRef[] = [];
  const colours = new Map<string, number>();
  const add = (startCp: number, endCp: number, sheet: string | null | undefined, g: CellRange) => {
    if (!ownSheet(sheet)) return;
    const q = norm(g);
    if (q.r1 < 1 || q.c1 < 1 || q.r1 > SCRATCH_ROWS || q.c1 > SCRATCH_COLS) return;
    const range = { r1: q.r1, c1: q.c1, r2: Math.min(q.r2, SCRATCH_ROWS), c2: Math.min(q.c2, SCRATCH_COLS) };
    let s = startCp;
    while (s < endCp && isSpace(at(s))) s++;
    const key = `${range.r1},${range.c1},${range.r2},${range.c2}`;
    let color = colours.get(key);
    if (color === undefined) { color = colours.size % REF_COLORS.length; colours.set(key, color); }
    out.push({ start: utf(s), end: utf(endCp), range, color });
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const rg = asRange(t);
    if (rg) {
      add(t.start, t.end, rg.sheet, { r1: rg.left.row, c1: rg.left.column, r2: rg.right.row, c2: rg.right.column });
      continue;
    }
    const a = asRef(t);
    if (!a) continue;
    const b = isColon(toks[i + 1]) && toks[i + 2] ? asRef(toks[i + 2]) : null;
    if (b && (b.sheet == null || (a.sheet ?? null) === b.sheet)) {
      add(t.start, toks[i + 2].end, a.sheet, { r1: a.row, c1: a.column, r2: b.row, c2: b.column });
      i += 2;
      continue;
    }
    add(t.start, t.end, a.sheet, { r1: a.row, c1: a.column, r2: a.row, c2: a.column });
  }
  return out;
}

/** The text cut into plain runs and reference runs (with their colour). Concatenated, it is `text` again. */
export function segments(text: string, refs: FormulaRef[]): { text: string; color?: number }[] {
  const out: { text: string; color?: number }[] = [];
  let i = 0;
  for (const r of refs) {
    if (r.start < i || r.end > text.length || r.end <= r.start) continue;
    if (r.start > i) out.push({ text: text.slice(i, r.start) });
    out.push({ text: text.slice(r.start, r.end), color: r.color });
    i = r.end;
  }
  if (i < text.length) out.push({ text: text.slice(i) });
  return out;
}

/** The reference whose text contains [start, end) (the pending, pointed-at span), if any. */
export function refContaining(refs: FormulaRef[], start: number, end: number): FormulaRef | undefined {
  return refs.find((r) => r.start <= start && end <= r.end);
}

/** One entry per distinct range; the first colour wins. */
export function uniqueRanges(refs: FormulaRef[]): { range: CellRange; color: number }[] {
  const seen = new Set<string>();
  const out: { range: CellRange; color: number }[] = [];
  for (const r of refs) {
    const g = r.range;
    const key = `${g.r1},${g.c1},${g.r2},${g.c2}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ range: g, color: r.color });
  }
  return out;
}

/** The text point mode inserts for a range (always relative): A1, A1:B5, A:C (whole columns), 3:5 (whole rows). */
export function pointRefName(g: CellRange): string {
  const q = norm(g);
  if (q.r1 === 1 && q.r2 === SCRATCH_ROWS) return `${colName(q.c1)}:${colName(q.c2)}`;
  if (q.c1 === 1 && q.c2 === SCRATCH_COLS) return `${q.r1}:${q.r2}`;
  const a = `${colName(q.c1)}${q.r1}`;
  return q.r1 === q.r2 && q.c1 === q.c2 ? a : `${a}:${colName(q.c2)}${q.r2}`;
}

/** "#6ea8ff" + alpha → "rgba(110,168,255,a)". */
export function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
