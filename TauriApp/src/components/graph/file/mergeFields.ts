/* Phase 4: fine-level combining of the analysis and graph settings, and the
   automatic adjustments a put-together result goes through (phase 4 contract
   §2.3, §2.4, §2.6). The analysis is combined field by field, its comparisons
   ("pairs") as a set; the graph settings field by field, with three groups of
   fields that are only ever taken together (colours, size, Y range).

   Pure and synchronous: no I/O, no clock, no randomness, nothing that depends
   on the computer. Every loop runs over sorted keys or ids in list order and
   compares with plain `<`, so both computers of a pair get the same bytes
   whichever of them is "mine". */

import {
  FIGURE_GROUPS, LIMITS_P4,
  type FigureGroup, type FineAdjustment, type FineAuto, type FineChoice, type FineChoices, type FineConflict,
  type FineItem, type FineMerge, type MergeFieldsApi, type NormalisedSide, type SectionValues, type SidePick,
} from "./contract";
import { canonicalJson } from "./format";
import type { FileAnalysis, FileFigure } from "./idMap";
import { effectiveAnalysis, toNumericTable, TWO_GROUP_TESTS } from "../graphModel";

// ── shared helpers ───────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;

const hasOwn = (o: unknown, k: string): boolean =>
  !!o && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
const asObj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
/** canonicalJson that never throws (a value without a JSON form counts as "not there"). */
function canon(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  try { return canonicalJson(v); } catch { return undefined; }
}
/** A fresh copy (through canonical JSON), so the result shares nothing with the sides. */
const copy = <T>(v: T): T => (v === undefined ? v : (JSON.parse(canonicalJson(v)) as T));
/** The field's value on a side, "not there" = undefined. */
const field = (o: unknown, k: string): unknown => (hasOwn(o, k) ? (o as Obj)[k] : undefined);
const sortedKeys = (...os: unknown[]): string[] => {
  const s = new Set<string>();
  for (const o of os) for (const k of Object.keys(asObj(o))) s.add(k);
  return [...s].sort();
};

/** The short text of a setting's value (§2.1.5). */
export function shortText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = canon(v) ?? "";
  return s.length > 60 ? s.slice(0, 59) + "…" : s;
}
/** Display text of a value that may not be there. */
const disp = (v: unknown, present: boolean): string | null => (present ? shortText(v) : null);

/** Outcome of the three-way rule on one value (by its canonical text). */
type Three =
  | { kind: "unchanged" }                       // m = t = b
  | { kind: "taken"; from: SidePick | "same" }  // one side's change, or both changed it alike
  | { kind: "conflict" };

/** The three-way rule (§2.1.2). `undefined` = not there, a value of its own. */
function three(b: string | undefined, m: string | undefined, t: string | undefined): Three {
  if (m === t) return m === b ? { kind: "unchanged" } : { kind: "taken", from: "same" };
  if (m === b) return { kind: "taken", from: "theirs" };
  if (t === b) return { kind: "taken", from: "mine" };
  return { kind: "conflict" };
}

/** A choice that is among the conflict's options, else null ("no choice", §2.1.7). */
function validChoice(choices: FineChoices | undefined, id: string, options: readonly FineChoice[]): FineChoice | null {
  const c = choices && Object.prototype.hasOwnProperty.call(choices, id) ? choices[id] : undefined;
  return c !== undefined && options.includes(c) ? c : null;
}

const MINE_THEIRS: readonly FineChoice[] = ["mine", "theirs"];

/** Items capped for display (§2.1.6). */
function capItems(items: FineItem[]): { items: FineItem[]; more: number } {
  const n = LIMITS_P4.conflictItems;
  return items.length > n ? { items: items.slice(0, n), more: items.length - n } : { items, more: 0 };
}

/** Collects auto entries, counting all but listing the first LIMITS_P4.autoItems. */
class AutoList {
  readonly list: FineAuto[] = [];
  count = 0;
  add(a: FineAuto) {
    this.count++;
    if (this.list.length < LIMITS_P4.autoItems) this.list.push(a);
  }
}

// ── analysis settings (§2.3) ─────────────────────────────────────────────────

/** A pair's key: its two ids in plain string order joined with "|" ([a, b] and [b, a] are one pair). */
function pairKey(p: unknown): string {
  if (Array.isArray(p) && p.length === 2 && typeof p[0] === "string" && typeof p[1] === "string") {
    return p[0] < p[1] ? `${p[0]}|${p[1]}` : `${p[1]}|${p[0]}`;
  }
  return "?" + (canon(p) ?? "");     // not a pair of ids (never after the pipeline): its own key
}

/** The pairs of a side as key → first entry with that key, in list order. */
function pairMap(v: unknown): Map<string, unknown> {
  const m = new Map<string, unknown>();
  for (const p of Array.isArray(v) ? v : []) {
    const k = pairKey(p);
    if (!m.has(k)) m.set(k, p);
  }
  return m;
}

/** `pairs` as a set when all three lists differ: what either side removed is gone, what either added is there.
 *  Kept pairs in the base's order (turned round as a side turned them), then the added ones sorted by key. */
function pairsAsSet(b: unknown, m: unknown, t: unknown): unknown[] {
  const B = pairMap(b), M = pairMap(m), T = pairMap(t);
  const keep = (k: string) => (M.has(k) && T.has(k)) || (M.has(k) && !B.has(k)) || (T.has(k) && !B.has(k));
  const out: unknown[] = [];
  for (const [k, pb] of B) {
    if (!keep(k)) continue;
    // In the base's order; turned round when a side turned it round (both did → the same way, as there are two).
    const cb = canon(pb), pm = M.get(k), pt = T.get(k);
    const cm = M.has(k) ? canon(pm) : cb, ct = T.has(k) ? canon(pt) : cb;
    const p = cm !== cb && ct !== cb ? ((cm ?? "") <= (ct ?? "") ? pm : pt) : cm !== cb ? pm : ct !== cb ? pt : pb;
    out.push(copy(p));
  }
  const added = new Set<string>();
  for (const k of M.keys()) if (!B.has(k)) added.add(k);
  for (const k of T.keys()) if (!B.has(k)) added.add(k);
  for (const k of [...added].sort()) {
    const pm = M.get(k), pt = T.get(k);
    let p: unknown;
    if (M.has(k) && T.has(k)) {
      const cm = canon(pm) ?? "", ct = canon(pt) ?? "";
      p = cm <= ct ? pm : pt;
    } else p = M.has(k) ? pm : pt;
    out.push(copy(p));
  }
  return out;
}

export function mergeAnalysis(
  input: { base: FileAnalysis; mine: FileAnalysis; theirs: FileAnalysis },
  choices?: FineChoices,
): FineMerge<FileAnalysis> {
  const { base, mine, theirs } = input;
  const conflicts: FineConflict[] = [];
  const auto = new AutoList();
  const out: Obj = {};
  let missing = false;

  for (const k of sortedKeys(base, mine, theirs)) {
    const bv = field(base, k), mv = field(mine, k), tv = field(theirs, k);
    const bc = canon(bv), mc = canon(mv), tc = canon(tv);
    const put = (v: unknown, c: string | undefined) => { if (c !== undefined) out[k] = copy(v); };

    if (k === "pairs" && bc !== mc && bc !== tc && mc !== tc) {
      // All three lists differ: combine them as sets. Never a conflict.
      const v = pairsAsSet(bv, mv, tv);
      const vc = canon(v);
      out[k] = v;
      if (vc !== bc) {
        const from: SidePick | "same" = vc === mc ? "mine" : vc === tc ? "theirs" : "same";
        auto.add({ what: "field", field: k, from, before: disp(bv, bc !== undefined), after: shortText(v) });
      }
      continue;
    }

    const r = three(bc, mc, tc);
    if (r.kind === "unchanged") { put(mv, mc); continue; }
    if (r.kind === "taken") {
      const [v, c] = r.from === "theirs" ? [tv, tc] : [mv, mc];
      put(v, c);
      auto.add({ what: "field", field: k, from: r.from, before: disp(bv, bc !== undefined), after: disp(v, c !== undefined) });
      continue;
    }
    const id = `analysis:field:${k}`;
    conflicts.push({
      id, section: "analysis", kind: "field", field: k, options: MINE_THEIRS,
      items: [{ what: "field", field: k, base: disp(bv, bc !== undefined), mine: disp(mv, mc !== undefined), theirs: disp(tv, tc !== undefined) }],
      more: 0,
    });
    const ch = validChoice(choices, id, MINE_THEIRS);
    if (ch === "mine") put(mv, mc);
    else if (ch === "theirs") put(tv, tc);
    else missing = true;
  }

  return {
    value: missing ? null : (out as unknown as FileAnalysis),
    conflicts, combined: auto.count, auto: auto.list, orderChecks: [], adjustments: [],
  };
}

// ── graph settings (§2.4) ────────────────────────────────────────────────────

const GROUP_ORDER: readonly FigureGroup[] = ["colours", "size", "yRange"];
const GROUPED_FIELDS = new Set<string>(GROUP_ORDER.flatMap((g) => FIGURE_GROUPS[g]));

type SeriesEntry = { color?: unknown; label?: unknown };
const seriesOf = (f: unknown): Obj => asObj(field(f, "series"));
const entryOf = (f: unknown, id: string): SeriesEntry | undefined => {
  const s = seriesOf(f);
  return hasOwn(s, id) && s[id] && typeof s[id] === "object" ? (s[id] as SeriesEntry) : undefined;
};
/** A column's colour on a side, undefined when the side has no entry (or no colour) for it. */
const colourOf = (f: unknown, id: string): unknown => { const e = entryOf(f, id); return e && hasOwn(e, "color") ? e.color : undefined; };
const labelText = (f: unknown, id: string): string => { const l = entryOf(f, id)?.label; return typeof l === "string" ? l : ""; };

export function mergeFigure(
  input: { base: FileFigure; mine: FileFigure; theirs: FileFigure; colIds: readonly string[] | null },
  choices?: FineChoices,
): FineMerge<FileFigure> {
  const { base, mine, theirs, colIds } = input;
  const conflicts: FineConflict[] = [];
  const auto = new AutoList();
  const out: Obj = {};
  let missing = false;

  // C: the columns both sides have (only these take part in the colours group and the labels). A column
  // the base lacks that both sides give the same colour is left out of the group (nothing to decide; it
  // would otherwise count as changed on both sides, e.g. when a combined version is combined again).
  const mineSeries = seriesOf(mine), theirsSeries = seriesOf(theirs);
  const C = Object.keys(mineSeries).filter((id) => hasOwn(theirsSeries, id)).sort();
  const baseSeries = seriesOf(base);
  const CG = C.filter((id) => hasOwn(baseSeries, id) || canon(colourOf(mine, id)) !== canon(colourOf(theirs, id)));
  /** Colour decided for each column of C. */
  const colour = new Map<string, unknown>();
  const label = new Map<string, string>();

  // Groups.
  for (const g of GROUP_ORDER) {
    const members = FIGURE_GROUPS[g];
    const valueOf = (f: unknown): string => {
      const parts: unknown[] = members.map((k) => { const v = field(f, k); return v === undefined ? null : v; });
      if (g === "colours") for (const id of CG) { const c = colourOf(f, id); parts.push(c === undefined ? null : c); }
      return canon(parts) ?? "";
    };
    const shown = (f: unknown): string => shortText(JSON.parse(valueOf(f)));
    const bc = valueOf(base), mc = valueOf(mine), tc = valueOf(theirs);
    /** Takes the group from one side, or (side null: both alike) per member the value either side has. */
    const take = (side: SidePick | null) => {
      for (const k of members) {
        const src = side === "theirs" ? theirs : side === "mine" ? mine : hasOwn(mine, k) ? mine : theirs;
        if (hasOwn(src, k)) out[k] = copy(field(src, k));
      }
      if (g === "colours") {
        for (const id of C) {
          const src = side === "theirs" ? theirs : side === "mine" ? mine : colourOf(mine, id) !== undefined ? mine : theirs;
          colour.set(id, colourOf(src, id));
        }
      }
    };
    const r = three(bc, mc, tc);
    if (r.kind === "unchanged") { take(null); continue; }
    if (r.kind === "taken") {
      take(r.from === "same" ? null : r.from);
      auto.add({ what: "group", group: g, from: r.from, before: shown(base), after: shown(r.from === "theirs" ? theirs : mine) });
      continue;
    }
    const items: FineItem[] = [];
    for (const k of members) {
      const mv = field(mine, k), tv = field(theirs, k);
      if (canon(mv) === canon(tv)) continue;
      const bv = field(base, k);
      items.push({ what: "field", field: k, base: disp(bv, bv !== undefined), mine: disp(mv, mv !== undefined), theirs: disp(tv, tv !== undefined) });
    }
    if (g === "colours") {
      for (const id of CG) {
        const mv = colourOf(mine, id), tv = colourOf(theirs, id);
        if (canon(mv) === canon(tv)) continue;
        const bv = colourOf(base, id);
        items.push({ what: "seriesColor", colId: id, base: disp(bv, bv !== undefined), mine: disp(mv, mv !== undefined), theirs: disp(tv, tv !== undefined) });
      }
    }
    const id = `figure:group:${g}`;
    conflicts.push({ id, section: "figure", kind: "group", group: g, options: MINE_THEIRS, ...capItems(items) });
    const ch = validChoice(choices, id, MINE_THEIRS);
    if (ch === "mine" || ch === "theirs") take(ch);
    else missing = true;
  }

  // Every other top-level field (fields this app does not know included).
  for (const k of sortedKeys(base, mine, theirs)) {
    if (k === "series" || GROUPED_FIELDS.has(k)) continue;
    const bv = field(base, k), mv = field(mine, k), tv = field(theirs, k);
    const bc = canon(bv), mc = canon(mv), tc = canon(tv);
    const put = (v: unknown, c: string | undefined) => { if (c !== undefined) out[k] = copy(v); };
    const r = three(bc, mc, tc);
    if (r.kind === "unchanged") { put(mv, mc); continue; }
    if (r.kind === "taken") {
      const [v, c] = r.from === "theirs" ? [tv, tc] : [mv, mc];
      put(v, c);
      auto.add({ what: "field", field: k, from: r.from, before: disp(bv, bc !== undefined), after: disp(v, c !== undefined) });
      continue;
    }
    const id = `figure:field:${k}`;
    conflicts.push({
      id, section: "figure", kind: "field", field: k, options: MINE_THEIRS,
      items: [{ what: "field", field: k, base: disp(bv, bc !== undefined), mine: disp(mv, mc !== undefined), theirs: disp(tv, tc !== undefined) }],
      more: 0,
    });
    const ch = validChoice(choices, id, MINE_THEIRS);
    if (ch === "mine") put(mv, mc);
    else if (ch === "theirs") put(tv, tc);
    else missing = true;
  }

  // Legend labels of the columns both sides have.
  for (const id of C) {
    const b = labelText(base, id), m = labelText(mine, id), t = labelText(theirs, id);
    const r = three(b, m, t);
    if (r.kind === "unchanged") { label.set(id, m); continue; }
    if (r.kind === "taken") {
      const v = r.from === "theirs" ? t : m;
      label.set(id, v);
      auto.add({ what: "seriesLabel", colId: id, from: r.from, before: b, after: v });
      continue;
    }
    const cid = `figure:label:${id}`;
    conflicts.push({
      id: cid, section: "figure", kind: "seriesLabel", colId: id, options: MINE_THEIRS,
      items: [{ what: "seriesLabel", colId: id, base: entryOf(base, id) ? b : null, mine: m, theirs: t }],
      more: 0,
    });
    const ch = validChoice(choices, cid, MINE_THEIRS);
    if (ch === "mine") label.set(id, m);
    else if (ch === "theirs") label.set(id, t);
    else missing = true;
  }

  if (missing || colIds === null) {
    return { value: null, conflicts, combined: auto.count, auto: auto.list, orderChecks: [], adjustments: [] };
  }

  // The result's series: one entry per column of the combined table, in its order.
  const series: Record<string, { color: string; label: string }> = {};
  for (const id of colIds) {
    if (Object.prototype.hasOwnProperty.call(series, id)) continue;
    let e: unknown;
    if (C.includes(id)) {
      const c = colour.get(id);
      e = { color: c === undefined ? "" : c, label: label.get(id) ?? "" };
    } else if (hasOwn(mineSeries, id)) e = copy(mineSeries[id]);
    else if (hasOwn(theirsSeries, id)) e = copy(theirsSeries[id]);
    else e = { color: "", label: "" };
    Object.defineProperty(series, id, { value: e, enumerable: true, writable: true, configurable: true });
  }
  out.series = series;

  return { value: out as unknown as FileFigure, conflicts, combined: auto.count, auto: auto.list, orderChecks: [], adjustments: [] };
}

// ── automatic adjustments (§2.6) ─────────────────────────────────────────────

/** What the plot request quietly changes for one document. */
function plotChanges(content: NormalisedSide["content"]): { testNotRun: boolean; control: boolean; pairs: boolean } {
  const a = content.analysis;
  let eff;
  try { eff = effectiveAnalysis(a, toNumericTable(content.doc)); } catch { return { testNotRun: false, control: false, pairs: false }; }
  const twoGroupColumn = content.doc.template === "column" && TWO_GROUP_TESTS.includes(eff.test);
  return {
    testNotRun: a.test !== "none" && eff.test === "none",
    control: a.control !== null && a.control !== undefined && eff.control === null,
    pairs: !twoGroupColumn && Array.isArray(a.pairs) && eff.pairs.length < a.pairs.length,
  };
}

export function detectAdjustments(p: {
  assembled: SectionValues; result: NormalisedSide; mine: NormalisedSide; theirs: NormalisedSide;
}): FineAdjustment[] {
  const out: FineAdjustment[] = [];
  const add = (a: FineAdjustment) => { if (out.length < LIMITS_P4.adjustments) out.push(a); };
  const assembled = asObj(p.assembled);
  const result = p.result.sections as unknown as Obj;

  // 1. The stored form: what the load pipeline changed in the put-together sections.
  const table = asObj(result.table);
  const resultCols = Array.isArray(table.col_ids) ? (table.col_ids as unknown[]).filter((c): c is string => typeof c === "string") : [];
  for (const k of ["table", "analysis", "figure", "scratchpad"] as const) {
    const before = assembled[k], after = result[k];
    if (k === "table" || k === "scratchpad") {
      const norm = (v: unknown) => canon(v === undefined ? null : v);
      if (norm(before) !== norm(after)) add({ section: k, kind: k, from: null, to: null });
      continue;
    }
    for (const f of sortedKeys(before, after)) {
      if (k === "figure" && f === "series") {
        const sb = asObj(field(before, f)), sa = asObj(field(after, f));
        const ids = [...resultCols.filter((id) => hasOwn(sa, id) || hasOwn(sb, id))];
        const seen = new Set(ids);
        for (const id of sortedKeys(sb, sa)) if (!seen.has(id)) ids.push(id);
        for (const id of ids) {
          const vb = field(sb, id), va = field(sa, id);
          if (canon(vb) !== canon(va)) {
            add({ section: k, kind: "setting", field: `series.${id}`, from: disp(vb, vb !== undefined), to: disp(va, va !== undefined) });
          }
        }
        continue;
      }
      const vb = field(before, f), va = field(after, f);
      if (canon(vb) !== canon(va)) add({ section: k, kind: "setting", field: f, from: disp(vb, vb !== undefined), to: disp(va, va !== undefined) });
    }
  }

  // 2. The plot request: reported only when it is new (not already so on both sides).
  const r = plotChanges(p.result.content), m = plotChanges(p.mine.content), t = plotChanges(p.theirs.content);
  const fileA = asObj(result.analysis);
  if (r.testNotRun && !(m.testNotRun && t.testNotRun)) {
    add({ section: "analysis", kind: "testNotRun", field: "test", from: shortText(p.result.content.analysis.test), to: "none" });
  }
  if (r.control && !(m.control && t.control)) {
    add({ section: "analysis", kind: "comparisons", field: "control", from: shortText(field(fileA, "control")), to: "" });
  }
  if (r.pairs && !(m.pairs && t.pairs)) {
    const c = p.result.content;
    const eff = effectiveAnalysis(c.analysis, toNumericTable(c.doc));
    const ids = c.doc.template === "grouped" && c.analysis.within === "columns" ? c.doc.row_ids : c.doc.col_ids;
    const kept = eff.pairs.map(([i, j]) => [ids[i] ?? String(i), ids[j] ?? String(j)]);
    add({ section: "analysis", kind: "comparisons", field: "pairs", from: shortText(field(fileA, "pairs")), to: shortText(kept) });
  }
  return out;
}

({ mergeAnalysis, mergeFigure, detectAdjustments, shortText }) satisfies MergeFieldsApi;
