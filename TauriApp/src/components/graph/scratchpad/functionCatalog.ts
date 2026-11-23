/* The functions the Scratchpad's formula engine evaluates, for the formula
   autocomplete list and the argument hint: parsed from functionCatalog.data.ts,
   ranked (common lab functions first), searched by prefix, alias and substring.
   Pure TypeScript, no engine. */

import { FUNCTION_ROWS } from "./functionCatalog.data";

export interface FnArg { name: string; optional: boolean }
export interface FnEntry {
  /** "AVERAGE" */
  name: string;
  /** Without the "...N" marker. */
  args: FnArg[];
  /** 0, or how many trailing args repeat (1 for SUM, 2 for SUMIFS). */
  repeat: number;
  desc: string;
  /** TRUE, FALSE: inserted without "(". */
  constant: boolean;
  /** Index in COMMON, or COMMON.length when not listed. */
  rank: number;
}

/** Ranked first, in this order (lab use first). */
const COMMON = [
  "AVERAGE", "SUM", "STDEV.S", "STDEV", "COUNT", "MEDIAN", "MIN", "MAX", "ROUND", "IF", "LOG", "LOG10", "LN", "EXP", "POWER",
  "SQRT", "ABS", "STDEV.P", "VAR.S", "COUNTA", "COUNTIF", "SUMIF", "AVERAGEIF", "T.TEST", "CORREL", "SLOPE", "INTERCEPT", "RSQ",
  "GEOMEAN", "ROUNDUP", "ROUNDDOWN", "INT", "MOD", "PRODUCT", "SUMPRODUCT", "IFERROR", "AND", "OR", "NOT", "PERCENTILE.INC",
  "QUARTILE.INC", "LARGE", "SMALL", "RANK.EQ", "TRIMMEAN", "CONFIDENCE.T", "LINEST", "TREND", "FORECAST.LINEAR", "VLOOKUP",
  "XLOOKUP", "INDEX", "MATCH", "CONCAT", "TEXT", "VALUE", "LEFT", "RIGHT", "MID", "LEN", "TRIM", "COUNTIFS", "SUMIFS",
  "AVERAGEIFS", "IFS", "TODAY", "NOW", "PI", "SEQUENCE", "TRANSPOSE", "UNIQUE", "SORT", "FILTER",
];

/** Query prefix → function-name prefix (other spreadsheet / stats names). Tried longest key first. */
const ALIASES: Record<string, string> = {
  AVG: "AVERAGE", MEAN: "AVERAGE", STDDEV: "STDEV", STD: "STDEV", SD: "STDEV", VARIANCE: "VAR",
  SEM: "STDEV", // no SEM function exists; this surfaces STDEV.S
  TTEST: "T.TEST", SQUARE: "SQRT",
};
const ALIAS_KEYS = Object.keys(ALIASES).sort((a, b) => b.length - a.length || (a < b ? -1 : 1));

const REPEAT_RE = /^\.\.\.(\d)$/;

function parseRow(row: string, rankOf: Map<string, number>): FnEntry {
  const [name, argText = "", desc = ""] = row.split("|");
  const items = argText ? argText.split(",").map((s) => s.trim()).filter(Boolean) : [];
  let repeat = 0;
  const m = items.length ? REPEAT_RE.exec(items[items.length - 1]) : null;
  if (m) { repeat = Number(m[1]); items.pop(); }
  const args = items.map((a) => (a.startsWith("[") && a.endsWith("]")
    ? { name: a.slice(1, -1), optional: true } : { name: a, optional: false }));
  return {
    name, args, repeat, desc, constant: name === "TRUE" || name === "FALSE", rank: rankOf.get(name) ?? COMMON.length,
  };
}

export const FUNCTIONS: readonly FnEntry[] = (() => {
  const rankOf = new Map(COMMON.map((n, i) => [n, i]));
  return FUNCTION_ROWS.map((r) => parseRow(r, rankOf)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
})();

const BY_NAME = new Map(FUNCTIONS.map((f) => [f.name, f]));

/** Case-insensitive lookup. */
export function findFunction(name: string): FnEntry | undefined {
  return BY_NAME.get(name.toUpperCase());
}

const byRank = (a: FnEntry, b: FnEntry) =>
  a.rank - b.rank || a.name.length - b.name.length || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** Functions for a typed partial name: prefix matches, then alias matches ("avg" → AVERAGE…), then (2+ letters)
 *  names containing the text. Inside each tier: common functions first, then shorter names, then A–Z. */
export function searchFunctions(query: string, limit = 50): FnEntry[] {
  const q = query.toUpperCase();
  if (!q) return [];
  const seen = new Set<string>();
  const t0: FnEntry[] = [], t1: FnEntry[] = [], t2: FnEntry[] = [];
  for (const f of FUNCTIONS) if (f.name.startsWith(q)) { t0.push(f); seen.add(f.name); }
  const key = ALIAS_KEYS.find((k) => q.startsWith(k));
  if (key) {
    const pre = ALIASES[key] + q.slice(key.length);
    for (const f of FUNCTIONS) if (!seen.has(f.name) && f.name.startsWith(pre)) { t1.push(f); seen.add(f.name); }
  }
  if (q.length >= 2) for (const f of FUNCTIONS) if (!seen.has(f.name) && f.name.includes(q)) t2.push(f);
  return [...t0.sort(byRank), ...t1.sort(byRank), ...t2.sort(byRank)].slice(0, limit);
}

const argText = (a: FnArg) => (a.optional ? `[${a.name}]` : a.name);

/** Which argument (index into fn.args) the 1-based argument number `i` is, or -1. */
export function argSlot(fn: FnEntry, i: number): number {
  const n = fn.args.length;
  if (i >= 1 && i <= n) return i - 1;
  if (i > n && fn.repeat > 0) return n - fn.repeat + ((i - n - 1) % fn.repeat);
  return -1;
}

/** "AVERAGE(number1, [number2], …)" split so the UI can bold one part (`argIndex` is 1-based). */
export function signatureParts(fn: FnEntry, argIndex?: number): { text: string; current: boolean }[] {
  if (fn.constant) return [{ text: fn.name, current: false }];
  const slot = argIndex === undefined ? -1 : argSlot(fn, argIndex);
  const out: { text: string; current: boolean }[] = [{ text: `${fn.name}(`, current: false }];
  fn.args.forEach((a, i) => {
    if (i > 0) out.push({ text: ", ", current: false });
    out.push({ text: argText(a), current: i === slot });
  });
  if (fn.repeat > 0) out.push({ text: ", …", current: false });
  out.push({ text: ")", current: false });
  return out;
}
