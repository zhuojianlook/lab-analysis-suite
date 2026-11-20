/* Graphs → Scratchpad: the saved shape of the Excel-like scratch sheet, plus
   small pure helpers (A1 references, TSV). Engine-free and React-free so it
   lives in the main bundle and runs in node tests; the formula engine itself
   is loaded lazily with the Scratchpad tab. */

export const SCRATCH_VERSION = 1;
/** Grid extent: rows 1..SCRATCH_ROWS, columns 1..SCRATCH_COLS (A..KN). */
export const SCRATCH_ROWS = 5000;
export const SCRATCH_COLS = 300;
/** Max characters of canonical JSON that may be saved (the sidecar's own cap is 2 MB). */
export const SCRATCH_LIMIT = 1_500_000;
/** Max size of the engine's binary model; edits that would grow it beyond this are refused. */
export const SCRATCH_BYTES_LIMIT = 600_000;
/** Max characters of one cell's input. */
export const SCRATCH_INPUT_MAX = 8192;
/** Column width in px (the engine's default for a fresh sheet). */
export const DEFAULT_COL_WIDTH = 90;
export const MIN_COL_WIDTH = 30;
export const MAX_COL_WIDTH = 600;

/** [row, col, input] or [row, col, input, numFmt]; row/col are 1-based. `input`
 *  is what the user typed ("=SUM(A1:A5)", "0.5", "abc", "'007"); numFmt is the
 *  Excel number-format code, present only when it is not "general". */
export type ScratchCell = [number, number, string] | [number, number, string, string];

export interface ScratchDoc {
  v: 1;
  /** Sorted row-major; no duplicates; no empty inputs. */
  cells: ScratchCell[];
  /** Column number → width in px (only widths that differ from the default). */
  cols?: Record<string, number>;
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/** Canonical JSON text for a scratchpad ("" = empty). Equal content ⇒ equal text. */
export function canonScratch(doc: { cells: ScratchCell[]; cols?: Record<string, number> } | null | undefined): string {
  if (!doc) return "";
  const byKey = new Map<number, ScratchCell>();
  for (const c of doc.cells) byKey.set(c[0] * 1000 + c[1], c);
  const cells = [...byKey.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .map((c) => (c.length === 4 && c[3] && c[3].toLowerCase() !== "general" ? [c[0], c[1], c[2], c[3]] : [c[0], c[1], c[2]]) as ScratchCell);
  const colKeys = doc.cols ? Object.keys(doc.cols).map(Number).filter((k) => doc.cols![String(k)] !== DEFAULT_COL_WIDTH).sort((a, b) => a - b) : [];
  if (!cells.length && !colKeys.length) return "";
  let cols: Record<string, number> | undefined;
  if (colKeys.length) {
    cols = {};
    for (const k of colKeys) cols[String(k)] = doc.cols![String(k)];
  }
  return JSON.stringify(cols ? { v: SCRATCH_VERSION, cells, cols } : { v: SCRATCH_VERSION, cells });
}

/** Anything (object, JSON text, null) → canonical scratchpad text. Never throws;
 *  "" for anything that isn't a version-1 scratchpad. Malformed entries are
 *  dropped; text over SCRATCH_LIMIT is returned anyway (never silently lose data). */
export function sanitizeScratch(raw: unknown): string {
  let v: unknown = raw;
  if (typeof v === "string") {
    if (!v) return "";
    try { v = JSON.parse(v); } catch { return ""; }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return "";
  const o = v as Record<string, unknown>;
  if (o.v !== SCRATCH_VERSION || !Array.isArray(o.cells)) return "";
  const cells: ScratchCell[] = [];
  for (const t of o.cells) {
    if (!Array.isArray(t) || t.length < 3 || t.length > 4) continue;
    const [r, c, input, fmt] = t as unknown[];
    if (!isInt(r) || !isInt(c) || r < 1 || r > SCRATCH_ROWS || c < 1 || c > SCRATCH_COLS) continue;
    if (typeof input !== "string" || input === "") continue;
    const text = input.length > SCRATCH_INPUT_MAX ? input.slice(0, SCRATCH_INPUT_MAX) : input;
    const okFmt = typeof fmt === "string" && fmt.length >= 1 && fmt.length <= 255 && fmt.toLowerCase() !== "general";
    cells.push(okFmt ? [r, c, text, fmt as string] : [r, c, text]);
  }
  let cols: Record<string, number> | undefined;
  if (o.cols && typeof o.cols === "object" && !Array.isArray(o.cols)) {
    for (const [k, w] of Object.entries(o.cols as Record<string, unknown>)) {
      const n = Number(k);
      if (!/^\d+$/.test(k) || n < 1 || n > SCRATCH_COLS || typeof w !== "number" || !Number.isFinite(w)) continue;
      const px = clampWidth(w);
      if (px === DEFAULT_COL_WIDTH) continue;
      (cols ??= {})[String(n)] = px;
    }
  }
  return canonScratch({ cells, cols });
}

export const clampWidth = (w: number) => Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, Math.round(w)));

/** Parsed canonical text (sanitized first). */
export function parseScratch(text: string): ScratchDoc {
  const t = sanitizeScratch(text);
  return t ? (JSON.parse(t) as ScratchDoc) : { v: 1, cells: [] };
}

/** Number of non-empty cells in canonical text (cheap enough for a caption). */
export function scratchCellCount(text: string): number {
  if (!text) return 0;
  try { return (JSON.parse(text) as ScratchDoc).cells.length; } catch { return 0; }
}

// ── A1 helpers ──────────────────────────────────────────────────────────────

/** 1 → "A", 27 → "AA". */
export function colName(c: number): string {
  let s = "";
  let n = c;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** "AA" → 27 (case-insensitive); 0 when not letters. */
export function colNumber(name: string): number {
  if (!/^[A-Za-z]{1,3}$/.test(name)) return 0;
  let n = 0;
  for (const ch of name.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

export interface CellRange { r1: number; c1: number; r2: number; c2: number }

export const cellName = (r: number, c: number) => `${colName(c)}${r}`;

export function rangeName(g: CellRange): string {
  const a = cellName(g.r1, g.c1);
  return g.r1 === g.r2 && g.c1 === g.c2 ? a : `${a}:${cellName(g.r2, g.c2)}`;
}

/** "B2", "$B$2", "b2:d9", "C:C", "3:5" → a range inside the grid, or null. */
export function parseRangeName(text: string): CellRange | null {
  const t = text.trim().replace(/\$/g, "").toUpperCase();
  let m = /^([A-Z]{1,3})(\d{1,5})(?::([A-Z]{1,3})(\d{1,5}))?$/.exec(t);
  if (m) {
    const c1 = colNumber(m[1]), r1 = Number(m[2]);
    const c2 = m[3] ? colNumber(m[3]) : c1, r2 = m[4] ? Number(m[4]) : r1;
    return inGrid(norm({ r1, c1, r2, c2 }));
  }
  m = /^([A-Z]{1,3}):([A-Z]{1,3})$/.exec(t);
  if (m) return inGrid(norm({ r1: 1, c1: colNumber(m[1]), r2: SCRATCH_ROWS, c2: colNumber(m[2]) }));
  m = /^(\d{1,5}):(\d{1,5})$/.exec(t);
  if (m) return inGrid(norm({ r1: Number(m[1]), c1: 1, r2: Number(m[2]), c2: SCRATCH_COLS }));
  return null;
}

export const norm = (g: CellRange): CellRange => ({
  r1: Math.min(g.r1, g.r2), c1: Math.min(g.c1, g.c2), r2: Math.max(g.r1, g.r2), c2: Math.max(g.c1, g.c2),
});

function inGrid(g: CellRange): CellRange | null {
  return g.r1 >= 1 && g.c1 >= 1 && g.r2 <= SCRATCH_ROWS && g.c2 <= SCRATCH_COLS ? g : null;
}

// ── TSV ─────────────────────────────────────────────────────────────────────

/** One cell for TSV output: quoted (with "" doubling) when it holds a tab, newline or quote, as Excel does. */
export function tsvCell(s: string): string {
  return /[\t\n\r"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows of cells → TSV (no trailing newline). */
export function toTsv(rows: string[][]): string {
  return rows.map((r) => r.map(tsvCell).join("\t")).join("\n");
}

/** Clipboard text is a single value (no tab / newline apart from one trailing newline)? */
export function isSingleValue(text: string): boolean {
  const t = text.replace(/\r?\n$/, "");
  return !/[\t\n\r]/.test(t);
}
