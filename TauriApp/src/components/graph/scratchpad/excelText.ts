/* Engine-free Excel text helpers for the Scratchpad (lazy chunk): a small
   formula tokenizer and the checks/rewrites built on it, Excel's "General"
   number display, typed-input recognition the engine lacks (times, d-mmm
   dates, fractions, (5)), the clipboard number form, and fill-series rules.
   Pure functions, so they are unit-tested in node. */

// ── tokenizer ─────────────────────────────────────────────────────────────────

export type TokKind = "num" | "str" | "qname" | "id" | "err" | "op" | "(" | ")" | "{" | "}" | "," | ";" | ":" | "other";
export interface Tok { k: TokKind; t: string; p: number }

const NUM_RE = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const ID_RE = /[\p{L}_\\$][\p{L}\p{N}_.$!]*/uy;
const ERR_RE = /#(?:NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|GETTING_DATA|SPILL!|CALC!|CIRC!|ERROR!|N\/IMPL!)/iy;
const OPS2 = new Set(["<>", "<=", ">="]);
const OPS1 = new Set(["+", "-", "*", "/", "^", "&", "=", "<", ">", "%", "@", "#"]);

/** Tokens of a formula body (without the leading "="). Whitespace is skipped. */
export function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  const n = s.length;
  let i = 0;
  const sticky = (re: RegExp) => { re.lastIndex = i; const m = re.exec(s); return m ? m[0] : null; };
  while (i < n) {
    const ch = s[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === " ") { i++; continue; }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (s[j] === ch) { if (s[j + 1] === ch) { j += 2; continue; } j++; break; }
        j++;
      }
      out.push({ k: ch === '"' ? "str" : "qname", t: s.slice(i, j), p: i });
      i = j;
      continue;
    }
    if (ch === "#") {
      const e = sticky(ERR_RE);
      if (e) { out.push({ k: "err", t: e, p: i }); i += e.length; continue; }
    }
    if ((ch >= "0" && ch <= "9") || (ch === "." && s[i + 1] >= "0" && s[i + 1] <= "9")) {
      const m = sticky(NUM_RE)!;
      out.push({ k: "num", t: m, p: i });
      i += m.length;
      continue;
    }
    const id = sticky(ID_RE);
    if (id) { out.push({ k: "id", t: id, p: i }); i += id.length; continue; }
    const two = s.slice(i, i + 2);
    if (OPS2.has(two)) { out.push({ k: "op", t: two, p: i }); i += 2; continue; }
    if (OPS1.has(ch)) { out.push({ k: "op", t: ch, p: i }); i++; continue; }
    if ("(){},;:".includes(ch)) { out.push({ k: ch as TokKind, t: ch, p: i }); i++; continue; }
    out.push({ k: "other", t: ch, p: i });
    i++;
  }
  return out;
}

/** Text the engine would treat as a formula: "=…", or "+…" / "-…" that isn't a plain number. */
export function formulaBody(input: string): string | null {
  if (input.startsWith("=")) return input.slice(1);
  if ((input.startsWith("+") || input.startsWith("-")) && input.length > 1) return input;
  return null;
}

// ── complexity guard (the engine's parser/evaluator recurses; very deep formulas crash it) ──

export const MAX_FORMULA_OPS = 500;
export const MAX_FORMULA_NESTING = 64;

/** A message when a formula is too long or too deeply nested for the engine, else null. */
export function tooComplex(input: string): string | null {
  const body = formulaBody(input);
  if (body === null) return null;
  let ops = 0, depth = 0, max = 0;
  for (const t of tokenize(body)) {
    if (t.k === "op") ops++;
    else if (t.k === "(" || t.k === "{") { depth++; if (depth > max) max = depth; }
    else if (t.k === ")" || t.k === "}") depth = Math.max(0, depth - 1);
  }
  if (max > MAX_FORMULA_NESTING) {
    return `That formula has more than ${MAX_FORMULA_NESTING} levels of nesting (Excel's limit too). Split it across cells.`;
  }
  if (ops > MAX_FORMULA_OPS) {
    return `That formula is too long for the scratchpad (more than ${MAX_FORMULA_OPS} operators). Split it across cells, or use SUM over a range.`;
  }
  return null;
}

// ── truncated formulas (the engine keeps a valid prefix and silently drops the rest) ──

const OPENERS = new Set<TokKind>(["(", "{", ",", ";", "op"]);

/** Tokens that must survive the engine's rewrite: unary "+" is dropped ("=+1+2" →
 *  "=1+2") and redundant parentheses are removed ("=(A1-B1)" → "=A1-B1"), so
 *  neither is counted. */
function significant(tokens: Tok[]): Tok[] {
  return tokens.filter((t, i) => t.k !== "(" && t.k !== ")"
    && !(t.k === "op" && t.t === "+" && (i === 0 || OPENERS.has(tokens[i - 1].k))));
}

/** When the engine stored fewer tokens than were typed, the dropped tail of the
 *  typed text ("" if it can't be pinned down); null when nothing was dropped. */
export function droppedTail(typed: string, stored: string): string | null {
  const tb = formulaBody(typed);
  const sb = stored.startsWith("=") ? stored.slice(1) : null;
  if (tb === null || sb === null) return null;
  const tt = significant(tokenize(tb));
  const st = significant(tokenize(sb));
  if (st.length >= tt.length) return null;
  const at = tt[st.length];
  return at ? tb.slice(at.p).trim() : "";
}

// ── COUNT over arrays (IronCalc 0.9.1 returns 0) ─────────────────────────────

const ARRAY_FNS = new Set(["SEQUENCE", "FILTER", "SORT", "SORTBY", "UNIQUE", "TRANSPOSE", "RANDARRAY", "TEXTSPLIT", "IF", "IFS", "CHOOSE", "INDEX", "OFFSET", "INDIRECT", "VSTACK", "HSTACK", "TOCOL", "TOROW", "TAKE", "DROP"]);

/** True when a COUNT(…) argument is an array constant or an array expression
 *  (anything but a plain reference / range / scalar), which the engine counts as 0. */
export function countOverArray(input: string): boolean {
  const body = formulaBody(input);
  if (body === null || !/COUNT\s*\(/i.test(body)) return false;
  const t = tokenize(body);
  for (let i = 0; i + 1 < t.length; i++) {
    if (t[i].k !== "id" || t[i].t.toUpperCase() !== "COUNT" || t[i + 1].k !== "(") continue;
    let depth = 0;
    let arg: Tok[] = [];
    const args: Tok[][] = [];
    for (let j = i + 2; j < t.length; j++) {
      const k = t[j].k;
      if (depth === 0 && (k === ")" || k === ",")) { args.push(arg); arg = []; if (k === ")") break; continue; }
      if (k === "(" || k === "{") depth++;
      if (k === ")" || k === "}") depth--;
      arg.push(t[j]);
    }
    if (arg.length) args.push(arg);
    for (const a of args) {
      if (a.some((x) => x.k === "{" || (x.k === "op" && x.t === "#"))) return true;
      const hasRange = a.some((x) => x.k === ":");
      const plainRange = a.length === 3 && a[1].k === ":";
      if (hasRange && !plainRange) return true;
      if (a.some((x, j) => x.k === "id" && a[j + 1]?.k === "(" && ARRAY_FNS.has(x.t.toUpperCase().replace(/^_XLFN\./, "")))) return true;
    }
  }
  return false;
}

// ── references ────────────────────────────────────────────────────────────────

const REF_RE = /^(.*!)?(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/;
const COL_RE = /^(.*!)?(\$?)([A-Za-z]{1,3})$/;
const ROW_RE = /^(\$?)(\d+)$/;

export function colNum(name: string): number {
  let n = 0;
  for (const ch of name.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function colLetters(c: number): string {
  let s = "";
  let n = c;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/** "B3" / "$B$3" → {r, c}; null for anything else. */
export function parseRef(t: string): { r: number; c: number } | null {
  const m = REF_RE.exec(t);
  if (!m || m[1]) return null;
  return { r: Number(m[5]), c: colNum(m[3]) };
}

/** Before deleting rows (or columns) d1..d2: move range endpoints that fall in
 *  the deleted band to the nearest surviving row/column, as Excel does
 *  (=SUM(A1:A5) with row 5 deleted becomes =SUM(A1:A4), not =SUM(A1:#REF!)).
 *  Returns the rewritten formula, or null when nothing changes. Ranges that lie
 *  wholly inside the band are left alone (they become #REF!, as in Excel). */
export function shrinkRangesForDelete(formula: string, axis: "row" | "col", d1: number, d2: number): string | null {
  if (!formula.startsWith("=") || !formula.includes(":")) return null;
  const body = formula.slice(1);
  const t = tokenize(body);
  const edits: { p: number; len: number; text: string }[] = [];
  const inBand = (v: number) => v >= d1 && v <= d2;
  for (let i = 1; i + 1 < t.length; i++) {
    if (t[i].k !== ":") continue;
    const a = t[i - 1], b = t[i + 1];
    // endpoint parsers per axis: [value, rebuild(newValue)]
    type End = { v: number; make: (v: number) => string } | null;
    const end = (tok: Tok): End => {
      if (axis === "row") {
        if (tok.k === "id") {
          const m = REF_RE.exec(tok.t);
          if (m) return { v: Number(m[5]), make: (v) => `${m[1] ?? ""}${m[2]}${m[3]}${m[4]}${v}` };
        } else if (tok.k === "num") {
          const m = ROW_RE.exec(tok.t);
          if (m) return { v: Number(m[2]), make: (v) => `${m[1]}${v}` };
        }
        return null;
      }
      if (tok.k !== "id") return null;
      const m = REF_RE.exec(tok.t);
      if (m) return { v: colNum(m[3]), make: (v) => `${m[1] ?? ""}${m[2]}${colLetters(v)}${m[4]}${m[5]}` };
      const c = COL_RE.exec(tok.t);
      if (c) return { v: colNum(c[3]), make: (v) => `${c[1] ?? ""}${c[2]}${colLetters(v)}` };
      return null;
    };
    // "$1:$3": "$" starts an identifier, so absolute row numbers arrive as ids.
    const ea = end(a.k === "id" && ROW_RE.test(a.t) && axis === "row" ? { ...a, k: "num" } : a);
    const eb = end(b.k === "id" && ROW_RE.test(b.t) && axis === "row" ? { ...b, k: "num" } : b);
    if (!ea || !eb) continue;
    const lo = Math.min(ea.v, eb.v), hi = Math.max(ea.v, eb.v);
    if (lo >= d1 && hi <= d2) continue;            // wholly deleted → #REF!, as in Excel
    const loTok = ea.v <= eb.v ? a : b, hiTok = ea.v <= eb.v ? b : a;
    const loEnd = ea.v <= eb.v ? ea : eb, hiEnd = ea.v <= eb.v ? eb : ea;
    if (inBand(lo)) edits.push({ p: loTok.p, len: loTok.t.length, text: loEnd.make(d2 + 1) });
    if (inBand(hi)) edits.push({ p: hiTok.p, len: hiTok.t.length, text: hiEnd.make(d1 - 1) });
  }
  if (!edits.length) return null;
  let out = body;
  for (const e of edits.sort((x, y) => y.p - x.p)) out = out.slice(0, e.p) + e.text + out.slice(e.p + e.len);
  return `=${out}`;
}

// ── dates ─────────────────────────────────────────────────────────────────────

/** A number format that shows a date (has day or year parts). Times alone don't count. */
export function isDateFmt(fmt: string): boolean {
  if (!fmt || fmt.toLowerCase() === "general") return false;
  const bare = fmt.replace(/"[^"]*"/g, "").replace(/\\./g, "").replace(/\[[^\]]*\]/g, "");
  return /[dy]/i.test(bare);
}

const DATE_FNS = new Set(["DATE", "TODAY", "NOW", "DATEVALUE", "EDATE", "EOMONTH", "WORKDAY", "WORKDAY.INTL"]);

/** "=X-Y[-Z…]" where every operand is a date (a date-formatted cell or a date
 *  function): Excel shows the difference as a plain number of days. */
export function isDateDifference(formula: string, isDateCell: (r: number, c: number) => boolean): boolean {
  if (!formula.startsWith("=")) return false;
  const t = tokenize(formula.slice(1));
  // Find every date operand (a date-formatted cell, or a DATE/TODAY/… call) as a token span.
  const spans: Array<[number, number]> = [];
  for (let i = 0; i < t.length; i++) {
    const x = t[i];
    if (x.k !== "id") continue;
    if (t[i + 1]?.k === "(") {
      if (!DATE_FNS.has(x.t.toUpperCase())) continue;
      let d = 0, j = i + 1;
      for (; j < t.length; j++) {
        if (t[j].k === "(") d++;
        else if (t[j].k === ")" && --d === 0) break;
      }
      if (j >= t.length) return false;
      spans.push([i, j]);
      i = j;
      continue;
    }
    if (t[i + 1]?.k === ":" || t[i - 1]?.k === ":") continue;      // part of a range
    const ref = parseRef(x.t.replace(/\$/g, ""));
    if (ref && isDateCell(ref.r, ref.c)) spans.push([i, i]);
  }
  if (spans.length < 2 || spans.length % 2) return false;
  // Every date operand must sit in a "date - date" pair whose result is only
  // combined with plain numbers: the pair is not bound tighter by * / ^ on its
  // left (e.g. 2*B2-B1) and the right date is not followed by * / ^ / %.
  const tight = (tok: Tok | undefined) => !!tok && tok.k === "op" && ["*", "/", "^"].includes(tok.t);
  for (let k = 0; k < spans.length; k += 2) {
    const [a0, a1] = spans[k];
    const [b0, b1] = spans[k + 1];
    if (b0 !== a1 + 2 || t[a1 + 1].k !== "op" || t[a1 + 1].t !== "-") return false;
    const before = t[a0 - 1];
    if (before && before.k === "op" && before.t !== "+" && before.t !== "-") return false;
    if (before && before.k === "op" && before.t === "-" && (a0 - 1 === 0 || ["op", "(", ","].includes(t[a0 - 2].k))) return false; // unary minus
    const after = t[b1 + 1];
    if (tight(after) || (after && after.k === "op" && after.t === "%")) return false;
    if (tight(before)) return false;
  }
  return true;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function monthIndex(name: string): number {
  const n = name.toLowerCase().replace(/\.$/, "");
  if (n.length < 3) return -1;
  const i = MONTHS.findIndex((m) => m === n || m.slice(0, 3) === n || (n === "sept" && m === "september"));
  return i;
}

/** Excel serial number of a calendar date (1900 date system, dates from 1-Mar-1900). */
export function dateSerial(y: number, m: number, d: number): number | null {
  if (m < 1 || m > 12 || d < 1) return null;
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  const serial = Math.round((t - Date.UTC(1899, 11, 30)) / 86_400_000);
  return serial >= 61 ? serial : null;
}

const year2 = (y: string) => (y.length <= 2 ? (Number(y) < 30 ? 2000 + Number(y) : 1900 + Number(y)) : Number(y));

/** Typed text Excel turns into a number but the engine keeps as text:
 *  "(5)" → -5, "12:30" / "3:30 PM" / "1:30:15" → times, "1 1/2" → 1.5,
 *  "1/31" → 31-Jan this year, "31-Jan-2024" / "1-Jan" / "Jan 2024" / "March 5, 2024" → dates.
 *  `input` is what to hand the engine instead, with an optional number format. */
export function recogniseInput(text: string, thisYear = new Date().getFullYear()): { input: string; fmt?: string } | null {
  const s = text.trim();
  if (!s || s.length > 40) return null;
  let m: RegExpExecArray | null;
  // (5), (1,234.50), ($5) → negative
  if ((m = /^\(\s*([$€£]?\s?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?)\s*\)$/.exec(s))) return { input: `-${m[1].replace(/\s/g, "")}` };
  // times
  if ((m = /^(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?\s*([AaPp][Mm]?)?$/.exec(s))) {
    let h = Number(m[1]);
    const min = Number(m[2]), sec = m[3] ? Number(m[3]) : 0;
    const ap = m[4]?.[0]?.toUpperCase();
    if (min > 59 || sec >= 60) return null;
    if (ap) { if (h < 1 || h > 12) return null; if (ap === "P" && h < 12) h += 12; if (ap === "A" && h === 12) h = 0; }
    else if (h > 23) return null;
    const v = (h * 3600 + min * 60 + sec) / 86400;
    const fmt = `h:mm${m[3] ? ":ss" : ""}${ap ? " AM/PM" : ""}`;
    return { input: String(v), fmt };
  }
  // mixed fractions "1 1/2", "0 1/2" (the engine can't display fraction formats: shown as a decimal)
  if ((m = /^(-?)(\d+) (\d+)\/(\d+)$/.exec(s))) {
    const num = Number(m[3]), den = Number(m[4]);
    if (den === 0 || num >= den) return null;
    const v = Number(m[2]) + num / den;
    return { input: String(m[1] ? -v : v) };
  }
  // m/d (this year)
  if ((m = /^(\d{1,2})\/(\d{1,2})$/.exec(s))) {
    const v = dateSerial(thisYear, Number(m[1]), Number(m[2]));
    return v === null ? null : { input: String(v), fmt: "d-mmm" };
  }
  // d-mmm[-yy[yy]], d mmm [yyyy]
  if ((m = /^(\d{1,2})[- ]([A-Za-z]{3,9}\.?)(?:[- ](\d{2}|\d{4}))?$/.exec(s))) {
    const mi = monthIndex(m[2]);
    if (mi < 0) return null;
    const v = dateSerial(m[3] ? year2(m[3]) : thisYear, mi + 1, Number(m[1]));
    return v === null ? null : { input: String(v), fmt: m[3] ? "d-mmm-yy" : "d-mmm" };
  }
  // mmm d[, yyyy]
  if ((m = /^([A-Za-z]{3,9}\.?) (\d{1,2})(?:,? (\d{4}))?$/.exec(s))) {
    const mi = monthIndex(m[1]);
    if (mi < 0) return null;
    const v = dateSerial(m[3] ? Number(m[3]) : thisYear, mi + 1, Number(m[2]));
    return v === null ? null : { input: String(v), fmt: m[3] ? "d-mmm-yy" : "d-mmm" };
  }
  // mmm-yy, mmm yyyy
  if ((m = /^([A-Za-z]{3,9}\.?)[- ](\d{2}|\d{4})$/.exec(s))) {
    const mi = monthIndex(m[1]);
    if (mi < 0) return null;
    const v = dateSerial(year2(m[2]), mi + 1, 1);
    return v === null ? null : { input: String(v), fmt: "mmm-yy" };
  }
  return null;
}

// ── Excel "General" number display ───────────────────────────────────────────

function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

function sciText(abs: number, maxLen: number): string | null {
  for (let d = 5; d >= 0; d--) {
    const [mant, exp] = abs.toExponential(d).split("e");
    const e = Number(exp);
    const t = `${trimZeros(mant)}E${e < 0 ? "-" : "+"}${String(Math.abs(e)).padStart(2, "0")}`;
    if (t.length <= maxLen) return t;
  }
  return null;
}

/** Excel's General format in a cell `maxLen` characters wide (11 ≈ a default
 *  column): up to ~10 significant digits, scientific (≤ 6 digits) at 1E+11 and
 *  above or below 1E-04, or when the decimal form doesn't fit. Null if nothing fits. */
export function formatGeneral(x: number, maxLen = 11): string | null {
  if (!Number.isFinite(x)) return null;
  if (x === 0) return "0";
  const sign = x < 0 ? "-" : "";
  const abs = Math.abs(x);
  if (abs >= 1e-4 && abs < 1e11) {
    const intLen = abs < 1 ? 1 : Math.floor(Math.log10(abs)) + 1;
    if (intLen <= maxLen) {
      for (let dec = Math.max(0, maxLen - intLen - 1); dec >= 0; dec--) {
        const t = trimZeros(abs.toFixed(Math.min(dec, 20)));
        if (t.length <= maxLen) {
          if (Number(t) === 0) break;          // rounds to 0: scientific shows it better
          return sign + t;
        }
      }
    }
  }
  const t = sciText(abs, maxLen);
  return t === null ? null : sign + t;
}

/** Numbers as plain text for the clipboard: "12,500" → "12500", "12.50%" → "0.125",
 *  "($7.50)" → "-7.5", "1.00E+03" → "1.00E+03". Null when the shown text isn't a
 *  plain number (dates, times, text). */
export function plainNumberText(shown: string): string | null {
  let s = shown.trim();
  if (!s) return null;
  let neg = false;
  const paren = /^\((.*)\)$/.exec(s);
  if (paren) { neg = true; s = paren[1].trim(); }
  if (s.startsWith("-")) { neg = !neg; s = s.slice(1).trim(); }
  s = s.replace(/^[$€£¥]\s?/, "").replace(/\s?[$€£¥]$/, "");
  if (s.startsWith("-")) { neg = !neg; s = s.slice(1).trim(); }
  let pct = false;
  if (s.endsWith("%")) { pct = true; s = s.slice(0, -1).trim(); }
  if (/^\d{1,3}(,\d{3})+(\.\d*)?$/.test(s)) s = s.replace(/,/g, "");
  if (!/^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null;
  if (pct) {
    const n = Number(s) / 100;
    s = String(Number(n.toPrecision(15)));
  }
  if (Number(s) === 0) return "0";
  return (neg ? "-" : "") + s;
}

// ── fill series ───────────────────────────────────────────────────────────────

const DAY_LISTS = [
  ["sun", "mon", "tue", "wed", "thu", "fri", "sat"],
  ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"],
  ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"],
  MONTHS,
];

function caseLike(sample: string, word: string): string {
  if (sample === sample.toUpperCase()) return word.toUpperCase();
  if (sample === sample.toLowerCase()) return word.toLowerCase();
  return word[0].toUpperCase() + word.slice(1);
}

/** One source cell of a fill: a typed number (`date` when date-formatted), or typed text. */
export type FillSrc = { kind: "num"; v: number; date: boolean } | { kind: "text"; t: string };

const round15 = (v: number) => Number(v.toPrecision(15));

/** Excel's fill-handle series for one row/column of typed values, at positions
 *  `at` (0 = the first source cell; negative = before it, when filling up/left).
 *  Returns the inputs to write, or null when the engine's own fill is right
 *  (formulas, mixed cells, plain copies, arithmetic number series). */
export function fillSeries(src: FillSrc[], at: number[]): string[] | null {
  const k = src.length;
  if (!k || !at.length) return null;
  if (src.every((s) => s.kind === "num")) {
    const ys = src.map((s) => (s as { v: number }).v);
    const dates = src.every((s) => (s as { date: boolean }).date);
    if (k === 1 && !dates) return null;                       // a single number copies (Excel)
    if (k === 1) return at.map((i) => String(ys[0] + i));     // a single date counts up by days
    const step = ys[1] - ys[0];
    const arithmetic = ys.every((y, i) => Math.abs(y - (ys[0] + i * step)) <= 1e-9 * Math.max(1, Math.abs(y)));
    if (arithmetic && !dates) return null;                    // the engine already does this exactly
    if (arithmetic) return at.map((i) => String(round15(ys[0] + i * step)));
    // least-squares linear trend, as Excel's fill handle does for numbers
    const mx = (k - 1) / 2;
    const my = ys.reduce((a, b) => a + b, 0) / k;
    let sxy = 0, sxx = 0;
    ys.forEach((y, i) => { sxy += (i - mx) * (y - my); sxx += (i - mx) ** 2; });
    const slope = sxy / sxx;
    return at.map((i) => String(round15(my + slope * (i - mx))));
  }
  if (!src.every((s) => s.kind === "text")) return null;
  const ts = src.map((s) => (s as { t: string }).t);
  // weekday / month names
  for (const list of DAY_LISTS) {
    const idx = ts.map((t) => list.indexOf(t.toLowerCase()));
    if (idx.some((i) => i < 0)) continue;
    const n = list.length;
    const step = k === 1 ? 1 : (((idx[1] - idx[0]) % n) + n) % n || n;
    return at.map((i) => caseLike(ts[0], list[(((idx[0] + i * step) % n) + n) % n]));
  }
  // text ending in a number: "Item 1" → "Item 2", "S01" → "S02"
  const parts = ts.map((t) => /^(.*?)(\d+)(\D*)$/.exec(t));
  if (parts.some((p) => !p || !/\S/.test(p[1] + p[3]) || /^[\d\s.,+-]*$/.test(p[1] + p[3]))) return null;
  const pre = parts[0]![1], post = parts[0]![3];
  if (parts.some((p) => p![1] !== pre || p![3] !== post)) return null;
  const ns = parts.map((p) => Number(p![2]));
  const width = parts[0]![2].length;
  let step = 1;
  if (k > 1) {
    const d = (ns[k - 1] - ns[0]) / (k - 1);
    step = Number.isInteger(d) ? d : 1;
  }
  return at.map((i) => {
    const v = Math.abs(ns[0] + i * step);
    const digits = String(v);
    return `${pre}${parts[0]![2].startsWith("0") ? digits.padStart(width, "0") : digits}${post}`;
  });
}
