/* Formula-editing helpers for the Scratchpad editor (pure; the engine's
   completion call is injected): what may go at the caret (a reference? a
   function name being typed? which argument of which function?), inserting a
   pointed-at reference, and accepting an autocomplete entry. Offsets are UTF-16
   (the textarea's), converted to the engine's code points where needed. */

import { tokenize } from "./excelText";
import { findFunction, type FnEntry } from "./functionCatalog";
import { cpToUtf16, formulaRefs, utf16ToCp } from "./formulaRefs";

export interface Pos { r: number; c: number }
/** Which parts of a reference carry a `$` (F4): column, row. */
export interface Dollars { c: boolean; r: boolean }
/** The reference just pointed at: [start, end) in the editor text, the cells it spans, and the `$` form F4 gave
 *  it (re-applied when the next arrow / click replaces it, as Excel does). */
export interface Pending { start: number; end: number; anchor: Pos; focus: Pos; abs?: Dollars }

/** The `$` form of a reference's text ("$A$1", "A$1:B$2", "$A:$C", "$3:$5"); undefined when it has none. */
export function dollarsOf(ref: string): Dollars | undefined {
  const m = /^(\$?)[A-Za-z]+(\$?)\d+/.exec(ref) ?? null;
  let d: Dollars;
  if (m) d = { c: m[1] === "$", r: m[2] === "$" };
  else if (/^\$?[A-Za-z]+(:|$)/.test(ref)) d = { c: ref.startsWith("$"), r: false };
  else if (/^\$?\d+(:|$)/.test(ref)) d = { c: false, r: ref.startsWith("$") };
  else return undefined;
  return d.c || d.r ? d : undefined;
}

/** A relative reference ("A1", "A1:B5", "A:C", "3:5", as point mode writes it) in the given `$` form. */
export function withDollars(ref: string, d: Dollars | undefined): string {
  if (!d) return ref;
  const c = d.c ? "$" : "", r = d.r ? "$" : "";
  return ref.split(":").map((part) => {
    const m = /^([A-Za-z]+)(\d+)$/.exec(part);
    if (m) return `${c}${m[1]}${r}${m[2]}`;
    return /^\d+$/.test(part) ? `${r}${part}` : `${c}${part}`;
  }).join(":");
}

/** How a click / header click in point mode uses the reference, or null when it commits the edit instead.
 *  Shift extends the pending reference from its anchor; Cmd (Ctrl) adds ",ref" after a reference. */
export function pointHow(
  pt: { atPending: boolean; afterRef: boolean; unionOnly: boolean }, hasPending: boolean, shift: boolean, mod: boolean,
): { how: "insert" | "replace" | "union"; extend: boolean } | null {
  if (shift && pt.atPending && hasPending) return { how: "replace", extend: true };
  if (mod && (pt.atPending || pt.afterRef)) return { how: "union", extend: false };
  if (pt.unionOnly) return null;
  return { how: pt.atPending ? "replace" : "insert", extend: false };
}

/** The second press of a double-click that picked from the function list (the list closes on the first press,
 *  so the second would land on the cell under it). */
export const PICK_ECHO_MS = 500;
export const isPickEcho = (detail: number, now: number, pickedAt: number) => detail >= 2 && now - pickedAt < PICK_ECHO_MS;

/** The formula with its missing closing brackets added at the end, as Excel does on Enter (the engine itself
 *  closes only one). Unchanged when nothing is missing, when there are too many ")" or a string is unclosed. */
export function closeBrackets(text: string): string {
  if (!text.startsWith("=")) return text;
  let depth = 0;
  for (const t of tokenize(text.slice(1))) {
    if (t.k === "(") depth++;
    else if (t.k === ")") { if (depth === 0) return text; depth--; }
    else if ((t.k === "str" || t.k === "qname") && t.t.slice(1).split(t.t[0]).length % 2 !== 0) return text;   // unclosed
  }
  return depth > 0 ? text + ")".repeat(depth) : text;
}

/** The engine's F4 (cycleReference: offsets in code points) on UTF-16 offsets. Throws when not on a reference. */
export function cycleReferenceUtf16(
  text: string, selStart: number, selEnd: number, cycle: (t: string, s: number, e: number) => [string, number, number],
): { text: string; start: number; end: number } {
  const [t, a, b] = cycle(text, utf16ToCp(text, selStart), utf16ToCp(text, selEnd));
  return { text: t, start: cpToUtf16(t, a), end: cpToUtf16(t, b) };
}

/** The scrollLeft that shows x (px from the editor's left edge, padding included) with `pad` px to spare. */
export function scrollToShow(x: number, scrollLeft: number, clientWidth: number, maxScroll: number, pad = 8): number {
  let s = scrollLeft;
  if (x - pad < s) s = x - pad;
  else if (x + pad > s + clientWidth) s = x + pad - clientWidth;
  return Math.max(0, Math.min(maxScroll, Math.round(s)));
}

/** Insert `ref` into the text: over the pending reference ("replace"), as ",ref" after the selection ("union"),
 *  or over the selection ("insert"). [start, end) is the new reference; the caret goes to `end`. */
export function insertReference(
  text: string, selStart: number, selEnd: number, pending: Pending | null, ref: string,
  how: "insert" | "replace" | "union",
): { text: string; start: number; end: number } {
  if (how === "replace" && pending) {
    return { text: text.slice(0, pending.start) + ref + text.slice(pending.end), start: pending.start, end: pending.start + ref.length };
  }
  if (how === "union") {
    const start = selEnd + 1;
    return { text: `${text.slice(0, selEnd)},${ref}${text.slice(selEnd)}`, start, end: start + ref.length };
  }
  return { text: text.slice(0, selStart) + ref + text.slice(selEnd), start: selStart, end: selStart + ref.length };
}

/** Replace the typed partial name [start, caret) with the function: "NAME(" (caret inside), "NAME()" for
 *  zero-argument functions, "NAME" for TRUE/FALSE or when a "(" already follows. No closing ")" is added
 *  (the engine closes it on commit, as Excel does). */
export function applyCompletion(text: string, start: number, caret: number, fn: FnEntry): { text: string; caret: number } {
  const before = text.slice(0, start), after = text.slice(caret);
  if (fn.constant) return { text: before + fn.name + after, caret: start + fn.name.length };
  if (after.startsWith("(")) return { text: before + fn.name + after, caret: start + fn.name.length + 1 };
  if (fn.args.length === 0 && fn.repeat === 0) return { text: `${before}${fn.name}()${after}`, caret: start + fn.name.length + 2 };
  return { text: `${before}${fn.name}(${after}`, caret: start + fn.name.length + 1 };
}

/** The engine's completion call: getFormulaCompletion(sheet, row, col, formula, cursor in code points). */
export type Complete = (formula: string, cursorCp: number) => { expecting: unknown[]; replace_from: number };

export interface Assist {
  /** A reference may go at the caret. */
  canPoint: boolean;
  /** Function name being typed; start = UTF-16 offset of its first letter. */
  fn: { partial: string; start: number } | null;
  /** Innermost enclosing (known) function call and the 1-based argument the caret is in. */
  arg: { name: string; index: number } | null;
  /** The caret is directly after a reference (a modifier-click may add ",ref"). */
  afterRef: boolean;
}
export const NO_ASSIST: Assist = Object.freeze({ canPoint: false, fn: null, arg: null, afterRef: false }) as Assist;

const NAME_CH = /[A-Za-z0-9_.]/;

/** The enclosing function call at the end of `body` (formula text without "=", up to the caret). */
export function enclosingCall(body: string): { name: string; index: number } | null {
  const toks = tokenize(body);
  const stack: { name: string | null; index: number; brace: number }[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const top = stack[stack.length - 1];
    switch (t.k) {
      case "(": {
        const prev = toks[i - 1];
        const name = prev && prev.k === "id" && prev.p + prev.t.length === t.p ? prev.t.toUpperCase() : null;
        stack.push({ name, index: 1, brace: 0 });
        break;
      }
      case ",": if (top && top.brace === 0) top.index++; break;
      case "{": if (top) top.brace++; break;
      case "}": if (top && top.brace > 0) top.brace--; break;
      case ")": stack.pop(); break;
      default: break;
    }
  }
  for (let i = stack.length - 1; i >= 0; i--) {
    const f = stack[i];
    if (f.name && findFunction(f.name)) return { name: findFunction(f.name)!.name, index: f.index };
  }
  return null;
}

/** What the editor can offer at the caret (selection [selStart, selEnd), UTF-16). */
export function assist(text: string, selStart: number, selEnd: number, complete: Complete): Assist {
  if (!text.startsWith("=")) return NO_ASSIST;
  let ctx: { expecting: unknown[]; replace_from: number };
  try { ctx = complete(text, utf16ToCp(text, selStart)); } catch { return NO_ASSIST; }
  const expecting = Array.isArray(ctx?.expecting) ? ctx.expecting : [];
  const canPoint = expecting.includes("Range");

  let fn: Assist["fn"] = null;
  if (selStart === selEnd) {
    const e = expecting.find((x): x is { FunctionName: string } =>
      !!x && typeof x === "object" && typeof (x as { FunctionName?: unknown }).FunctionName === "string");
    const p = e?.FunctionName ?? "";
    if (p.length >= 1) {
      const start = cpToUtf16(text, ctx.replace_from + 1);
      const ok = text.slice(start, selStart).toUpperCase() === p.toUpperCase()
        && !NAME_CH.test(text[selStart] ?? "")
        && !/:\s*$/.test(text.slice(0, start));
      if (ok) fn = { partial: p, start };
    }
  }

  const arg = enclosingCall(text.slice(1, selStart));
  const afterRef = selStart === selEnd && formulaRefs(text).some((r) => r.end === selStart);
  return { canPoint, fn, arg, afterRef };
}
