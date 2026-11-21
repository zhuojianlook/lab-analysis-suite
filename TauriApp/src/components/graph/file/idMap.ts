/* The id map: converts between the index-based document the app works with (in
   memory and towards the engine) and the id-based form stored in analysis files,
   where everything that points at a row or a column names it by its id:

   - table:    the GraphDoc with its row_ids / col_ids (format 2 = v1 + ids)
   - analysis: control and pairs as ids of the compared entities (columns, or
               rows when a grouped table compares within columns)
   - figure:   one {color, label} per column, keyed by column id

   Pure functions, no I/O. Input is expected in the normalised open form (after
   migrate → defaults → clean-up, see graphStore.load); toFileSections drops what
   points nowhere (an index past the table, extra colours), so the file form of
   a document is the same however often it is opened and saved. Its stored
   text is canonicalJson (format.ts), so key order never depends on the edit
   history. */

import type { GraphAnalysis, GraphDoc, GraphFigure } from "../../../api/graph";
import { migrateDoc, resizeSeries, withIds } from "../graphModel";

/** Table section: a GraphDoc whose ids are always present. */
export interface FileTable extends Omit<GraphDoc, "v"> {
  v: 2;
}

/** Analysis section: control / pairs name entities by id. */
export interface FileAnalysis extends Omit<GraphAnalysis, "control" | "pairs"> {
  control: string | null;
  pairs: [string, string][];
}

/** Figure section: per-column colour and legend label keyed by column id (in column order). */
export interface FileFigure extends Omit<GraphFigure, "colors" | "labels" | "prism_palette"> {
  series: Record<string, { color: string; label: string }>;
}

export interface FileSections {
  table: FileTable;
  analysis: FileAnalysis;
  figure: FileFigure;
}

export interface OpenSections {
  doc: GraphDoc;
  analysis: GraphAnalysis;
  figure: GraphFigure;
}

/** Ids of what `control` / `pairs` index: rows when a grouped table compares
 *  within columns, else columns (the same rule as remapAnalysis). */
export function entityIds(doc: GraphDoc, a: Pick<GraphAnalysis, "within">): string[] {
  return doc.template === "grouped" && a.within === "columns" ? doc.row_ids : doc.col_ids;
}

export function toFileSections(s: OpenSections): FileSections {
  // The table in the form opening gives it (migrateDoc: e.g. no X values on a
  // non-XY table), so a file never differs from itself after a reopen.
  const doc = migrateDoc({ ...withIds(s.doc), v: 1 }) ?? withIds(s.doc);
  const ids = entityIds(doc, s.analysis);
  const idAt = (i: unknown) => (typeof i === "number" && Number.isInteger(i) && i >= 0 && i < ids.length ? ids[i] : null);
  const pairs: [string, string][] = [];
  for (const p of Array.isArray(s.analysis.pairs) ? s.analysis.pairs : []) {
    const a = idAt(p?.[0]), b = idAt(p?.[1]);
    if (a !== null && b !== null) pairs.push([a, b]);
  }
  const { v: _v, ...tableRest } = doc;
  const fig = resizeSeries(s.figure, doc.col_titles.length);
  const { colors, labels, prism_palette: _pp, ...figRest } = fig;
  // Object.fromEntries defines own properties, so no id can reach the prototype.
  const series: FileFigure["series"] = Object.fromEntries(doc.col_ids.map((id, i) => [id, { color: colors[i], label: labels[i] }]));
  return {
    table: { v: 2, ...tableRest },
    analysis: { ...s.analysis, control: idAt(s.analysis.control), pairs },
    figure: { ...figRest, series },
  };
}

/** File sections → the index-based open form. The table goes through migrateDoc
 *  (null when it isn't a Graphs table); references to unknown ids are dropped. */
export function fromFileSections(f: { table: unknown; analysis: unknown; figure: unknown }): OpenSections | null {
  const t = f.table && typeof f.table === "object" ? (f.table as Record<string, unknown>) : null;
  if (!t || (t.v !== 2 && t.v !== 1 && t.v !== undefined)) return null;
  const doc = migrateDoc({ ...t, v: 1 });
  if (!doc) return null;
  const a = (f.analysis && typeof f.analysis === "object" ? f.analysis : {}) as Partial<FileAnalysis>;
  const ids = entityIds(doc, { within: a.within === "columns" ? "columns" : "rows" });
  const pos = new Map(ids.map((id, i) => [id, i]));
  const at = (id: unknown) => (typeof id === "string" && pos.has(id) ? pos.get(id)! : null);
  const pairs: [number, number][] = [];
  for (const p of Array.isArray(a.pairs) ? a.pairs : []) {
    const i = at(p?.[0]), j = at(p?.[1]);
    if (i !== null && j !== null) pairs.push([i, j]);
  }
  const fig = (f.figure && typeof f.figure === "object" ? f.figure : {}) as Partial<FileFigure>;
  const { series: rawSeries, ...figRest } = fig;
  const series = rawSeries && typeof rawSeries === "object" ? rawSeries : {};
  const entry = (id: string) => {
    const e = Object.prototype.hasOwnProperty.call(series, id) ? (series as Record<string, unknown>)[id] : null;
    return e && typeof e === "object" ? (e as { color?: unknown; label?: unknown }) : null;
  };
  // A column without a stored entry gets "" (drawn with the default palette
  // colour by effectiveFigure); toFileSections always writes one per column.
  const colors = doc.col_ids.map((id) => { const c = entry(id)?.color; return typeof c === "string" ? c : ""; });
  const labels = doc.col_ids.map((id) => { const l = entry(id)?.label; return typeof l === "string" ? l : ""; });
  return {
    doc,
    analysis: { ...(a as object), control: at(a.control), pairs } as GraphAnalysis,
    figure: { ...(figRest as object), colors, labels } as GraphFigure,
  };
}
