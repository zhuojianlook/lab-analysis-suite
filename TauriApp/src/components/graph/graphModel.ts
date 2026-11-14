/* Pure data model of the Graphs tool: templates, defaults, sample data, cell
   parsing, paste handling, structural table edits and the rules for which
   statistical tests / post-hoc comparisons fit a table. No React, no I/O —
   everything here is unit-testable in node. */

import type {
  CenterId, CompareId, GraphAnalysis, GraphDoc, GraphFigure, GraphTable, GraphType, Num, PosthocId, Template, TestId,
} from "../../api/graph";

// ── limits ──────────────────────────────────────────────────────────────────

export const MAX_COLS = 26;
export const MAX_ROWS = 500;
export const MAX_REP = 10;
export const MIN_ROWS = 10;

export const PALETTES: Record<string, string[]> = {
  Default: ["#5a7fa8", "#63a66a", "#c1666b", "#d4a05a", "#8a6fae", "#4aa3a3", "#b07aa1", "#9c9c4a"],
  "Colour-blind": ["#0072B2", "#E69F00", "#009E73", "#CC79A7", "#56B4E9", "#D55E00", "#F0E442", "#000000"],
  Greyscale: ["#1f1f1f", "#5c5c5c", "#8f8f8f", "#c2c2c2", "#3d3d3d", "#737373", "#a8a8a8", "#e0e0e0"],
};

// ── templates ───────────────────────────────────────────────────────────────

export interface TemplateInfo {
  id: Template;
  label: string;
  blurb: string;
  graphs: { id: GraphType; label: string }[];
}

export const TEMPLATES: TemplateInfo[] = [
  {
    id: "column",
    label: "Column",
    blurb: "One column per group, one value per row. Compare groups with t tests, ANOVA or their non-parametric equivalents.",
    graphs: [
      { id: "dot", label: "Scatter dot" },
      { id: "bar", label: "Bar" },
      { id: "box", label: "Box" },
      { id: "violin", label: "Violin" },
    ],
  },
  {
    id: "grouped",
    label: "Grouped",
    blurb: "Two factors: rows (e.g. time point) × column groups (e.g. genotype), with replicate sub-columns. Two-way ANOVA.",
    graphs: [
      { id: "gbar", label: "Grouped bars" },
      { id: "gdot", label: "Grouped dots" },
    ],
  },
  {
    id: "xy",
    label: "XY",
    blurb: "An X column and one or more Y series, with optional replicates. Linear regression and correlation.",
    graphs: [
      { id: "xy_fit", label: "Points + fit" },
      { id: "xy_points", label: "Points" },
      { id: "xy_line", label: "Points + line" },
    ],
  },
];

export const templateInfo = (t: Template) => TEMPLATES.find((x) => x.id === t)!;
export const isTemplate = (t: unknown): t is Template => t === "column" || t === "grouped" || t === "xy";

export const CENTERS: { id: CenterId; label: string }[] = [
  { id: "mean_sd", label: "Mean ± SD" },
  { id: "mean_sem", label: "Mean ± SEM" },
  { id: "mean_ci", label: "Mean ± 95% CI" },
  { id: "median_iqr", label: "Median & IQR" },
];

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Default title of column `i` ("Group A", or "Series A" for XY data sets). */
export function defaultColTitle(t: Template, i: number): string {
  const letter = LETTERS[i % 26] + (i >= 26 ? String(Math.floor(i / 26) + 1) : "");
  return `${t === "xy" ? "Series" : "Group"} ${letter}`;
}

// ── cell parsing ────────────────────────────────────────────────────────────

const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** Parse one cell's raw text. Empty → missing (not invalid). A single decimal
 *  comma ("1,5") is read as a decimal point. Anything else that isn't a plain
 *  number is invalid: shown outlined in red and sent as missing. */
export function parseCell(raw: string | null | undefined): { value: number | null; invalid: boolean } {
  let s = (raw ?? "").trim();
  if (s === "") return { value: null, invalid: false };
  if (/^-?\d+,\d+$/.test(s)) s = s.replace(",", ".");
  if (!NUMERIC.test(s)) return { value: null, invalid: true };
  const n = Number(s);
  return Number.isFinite(n) ? { value: n, invalid: false } : { value: null, invalid: true };
}

export const isBlank = (s: string | null | undefined) => (s ?? "").trim() === "";

// ── documents ───────────────────────────────────────────────────────────────

const blankRow = (nCols: number, nRep: number): string[][] =>
  Array.from({ length: nCols }, () => Array.from({ length: nRep }, () => ""));

export function rowHasData(doc: GraphDoc, r: number): boolean {
  const row = doc.cells[r];
  if (!row) return false;
  if (!isBlank(doc.row_titles[r]) || !isBlank(doc.x[r])) return true;
  return row.some((reps) => reps.some((v) => !isBlank(v)));
}

export function colHasData(doc: GraphDoc, c: number): boolean {
  return doc.cells.some((row) => (row[c] ?? []).some((v) => !isBlank(v)));
}

/** Pad to MIN_ROWS and keep exactly one blank row available after the last
 *  filled one (so typing in the last row always has somewhere to go next). */
export function ensureRows(doc: GraphDoc): GraphDoc {
  const nCols = doc.col_titles.length;
  let cells = doc.cells, row_titles = doc.row_titles, x = doc.x;
  const grow = () => {
    if (cells === doc.cells) { cells = [...cells]; row_titles = [...row_titles]; x = [...x]; }
    cells.push(blankRow(nCols, doc.n_rep));
    row_titles.push("");
    x.push("");
  };
  while (cells.length < MIN_ROWS) grow();
  if (cells.length < MAX_ROWS && rowHasData({ ...doc, cells, row_titles, x }, cells.length - 1)) grow();
  return cells === doc.cells ? doc : { ...doc, cells, row_titles, x };
}

export function emptyDoc(t: Template): GraphDoc {
  const nCols = t === "column" ? 3 : 2;
  const nRep = t === "grouped" ? 3 : 1;
  return ensureRows({
    v: 1,
    template: t,
    col_titles: Array.from({ length: nCols }, (_, i) => defaultColTitle(t, i)),
    row_titles: [],
    x_title: "X",
    n_rep: nRep,
    x: [],
    cells: [],
  });
}

/** Column-major sample values → a doc. */
function fromValues(base: Omit<GraphDoc, "cells" | "row_titles" | "x">, rows: number, get: (r: number, c: number, k: number) => number | null,
  rowTitles: string[] = [], x: (number | null)[] = []): GraphDoc {
  const cells = Array.from({ length: rows }, (_, r) =>
    base.col_titles.map((_, c) => Array.from({ length: base.n_rep }, (_, k) => {
      const v = get(r, c, k);
      return v == null ? "" : String(v);
    })));
  return ensureRows({
    ...base,
    cells,
    row_titles: Array.from({ length: rows }, (_, r) => rowTitles[r] ?? ""),
    x: Array.from({ length: rows }, (_, r) => (x[r] == null ? "" : String(x[r]))),
  });
}

/** Example data per template (PlantGrowth for Column). */
export function sampleDoc(t: Template): GraphDoc {
  if (t === "column") {
    const cols = [
      [4.17, 5.58, 5.18, 6.11, 4.5, 4.61, 5.17, 4.53, 5.33, 5.14],
      [4.81, 4.17, 4.41, 3.59, 5.87, 3.83, 6.03, 4.89, 4.32, 4.69],
      [6.31, 5.12, 5.54, 5.5, 5.37, 5.29, 4.92, 6.15, 5.8, 5.26],
    ];
    return fromValues({ v: 1, template: t, col_titles: ["Control", "Treatment 1", "Treatment 2"], x_title: "X", n_rep: 1 },
      10, (r, c) => cols[c][r]);
  }
  if (t === "grouped") {
    // [row][col][rep]: 0 h / 24 h / 48 h × WT / KO, triplicates.
    const v = [
      [[1.02, 0.95, 1.08], [0.98, 1.05, 0.93]],
      [[1.85, 2.04, 1.71], [1.21, 1.33, 1.12]],
      [[3.12, 2.88, 3.35], [1.52, 1.66, 1.41]],
    ];
    return fromValues({ v: 1, template: t, col_titles: ["WT", "KO"], x_title: "X", n_rep: 3 },
      3, (r, c, k) => v[r][c][k], ["0 h", "24 h", "48 h"]);
  }
  const y = [2.1, 3.9, 6.2, 7.8, 10.1, 11.8];
  return fromValues({ v: 1, template: t, col_titles: ["Response"], x_title: "Dose", n_rep: 1 },
    6, (r) => y[r], [], [1, 2, 3, 4, 5, 6]);
}

const str = (v: unknown): string =>
  typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "";

/** Validate and normalise a stored document (library record or local draft).
 *  Returns null when it isn't a recognisable v1 Graphs document. */
export function migrateDoc(raw: unknown): GraphDoc | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  if (d.v !== undefined && d.v !== 1) return null;
  if (!isTemplate(d.template)) return null;
  const t = d.template;
  const nRep = t === "column" ? 1 : Math.min(MAX_REP, Math.max(1, Math.round(Number(d.n_rep)) || 1));
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  let colTitles = arr(d.col_titles).slice(0, MAX_COLS).map(str);
  const cellsRaw = arr(d.cells);
  // A doc with cells but fewer titles still keeps its data columns.
  const widest = cellsRaw.reduce<number>((m, row) => Math.max(m, arr(row).length), 0);
  const nCols = Math.min(MAX_COLS, Math.max(1, colTitles.length, widest));
  colTitles = Array.from({ length: nCols }, (_, c) => colTitles[c] ?? defaultColTitle(t, c));
  const rowTitles = arr(d.row_titles), xs = arr(d.x);
  const nRows = Math.min(MAX_ROWS, Math.max(cellsRaw.length, rowTitles.length, t === "xy" ? xs.length : 0));
  const cells = Array.from({ length: nRows }, (_, r) => {
    const row = arr(cellsRaw[r]);
    return Array.from({ length: nCols }, (_, c) => {
      const cell = row[c];
      const reps = Array.isArray(cell) ? cell : [cell]; // tolerate a bare value per cell
      return Array.from({ length: nRep }, (_, k) => str(reps[k]));
    });
  });
  return ensureRows({
    v: 1,
    template: t,
    col_titles: colTitles,
    row_titles: Array.from({ length: nRows }, (_, r) => str(rowTitles[r])),
    // A deliberately cleared title stays blank; only a missing one gets the default.
    x_title: typeof d.x_title === "string" ? d.x_title : "X",
    n_rep: nRep,
    x: Array.from({ length: nRows }, (_, r) => (t === "xy" ? str(xs[r]) : "")),
    cells,
  });
}

/** Cells (and X values) holding text that isn't a number. */
export function countInvalid(doc: GraphDoc): number {
  let n = 0;
  for (let r = 0; r < doc.cells.length; r++) {
    if (doc.template === "xy" && parseCell(doc.x[r]).invalid) n++;
    for (const reps of doc.cells[r]) for (const v of reps) if (v && parseCell(v).invalid) n++;
  }
  return n;
}

/** The numeric table for analysis: trailing rows/columns without any value
 *  are dropped, blank titles get defaults, non-numbers become null. */
export function toNumericTable(doc: GraphDoc): GraphTable {
  let lastRow = doc.cells.length - 1;
  while (lastRow >= 0 && !rowHasData(doc, lastRow)) lastRow--;
  let lastCol = doc.col_titles.length - 1;
  while (lastCol > 0 && !colHasData(doc, lastCol)) lastCol--;
  const nRows = lastRow + 1, nCols = lastCol + 1;
  const nRep = doc.template === "column" ? 1 : doc.n_rep;
  const values: Num[][][] = [];
  for (let r = 0; r < nRows; r++) {
    const row: Num[][] = [];
    for (let c = 0; c < nCols; c++) {
      const reps: Num[] = [];
      for (let k = 0; k < nRep; k++) reps.push(parseCell(doc.cells[r][c]?.[k]).value);
      row.push(reps);
    }
    values.push(row);
  }
  return {
    template: doc.template,
    col_titles: doc.col_titles.slice(0, nCols).map((s, c) => s.trim() || defaultColTitle(doc.template, c)),
    row_titles: Array.from({ length: nRows }, (_, r) => (doc.row_titles[r] ?? "").trim() || `Row ${r + 1}`),
    x_title: doc.x_title.trim() || "X",
    x: Array.from({ length: nRows }, (_, r) => (doc.template === "xy" ? parseCell(doc.x[r]).value : null)),
    values,
  };
}

/** True when the table holds at least one number. */
export const hasNumbers = (t: GraphTable) => t.values.some((row) => row.some((reps) => reps.some((v) => v !== null)));

/** Columns (data sets) holding at least one number. */
export const usedCols = (t: GraphTable) =>
  t.col_titles.filter((_, c) => t.values.some((row) => (row[c] ?? []).some((v) => v !== null))).length;

/** Rows holding at least one number. */
export const usedRows = (t: GraphTable) => t.values.filter((row) => row.some((reps) => reps.some((v) => v !== null))).length;

// ── structural edits (all return a new doc) ─────────────────────────────────

export function uniqueColTitle(doc: GraphDoc): string {
  const taken = new Set(doc.col_titles.map((s) => s.trim()));
  for (let i = 0; i < MAX_COLS * 2; i++) {
    const t = defaultColTitle(doc.template, i);
    if (!taken.has(t)) return t;
  }
  return defaultColTitle(doc.template, doc.col_titles.length);
}

export function insertCol(doc: GraphDoc, at: number): GraphDoc {
  if (doc.col_titles.length >= MAX_COLS) return doc;
  const i = Math.max(0, Math.min(at, doc.col_titles.length));
  const col_titles = [...doc.col_titles];
  col_titles.splice(i, 0, uniqueColTitle(doc));
  const cells = doc.cells.map((row) => {
    const next = [...row];
    next.splice(i, 0, Array.from({ length: doc.n_rep }, () => ""));
    return next;
  });
  return { ...doc, col_titles, cells };
}

export function clearCol(doc: GraphDoc, c: number): GraphDoc {
  return { ...doc, cells: doc.cells.map((row) => row.map((reps, j) => (j === c ? reps.map(() => "") : reps))) };
}

/** Delete a column; the last remaining column is cleared instead. */
export function deleteCol(doc: GraphDoc, c: number): GraphDoc {
  if (doc.col_titles.length <= 1) return clearCol(doc, c);
  return {
    ...doc,
    col_titles: doc.col_titles.filter((_, j) => j !== c),
    cells: doc.cells.map((row) => row.filter((_, j) => j !== c)),
  };
}

export function insertRow(doc: GraphDoc, at: number): GraphDoc {
  if (doc.cells.length >= MAX_ROWS) return doc;
  const i = Math.max(0, Math.min(at, doc.cells.length));
  const cells = [...doc.cells], row_titles = [...doc.row_titles], x = [...doc.x];
  cells.splice(i, 0, blankRow(doc.col_titles.length, doc.n_rep));
  row_titles.splice(i, 0, "");
  x.splice(i, 0, "");
  return ensureRows({ ...doc, cells, row_titles, x });
}

export function clearRow(doc: GraphDoc, r: number): GraphDoc {
  const cells = [...doc.cells], row_titles = [...doc.row_titles], x = [...doc.x];
  cells[r] = blankRow(doc.col_titles.length, doc.n_rep);
  row_titles[r] = "";
  x[r] = "";
  return { ...doc, cells, row_titles, x };
}

export function deleteRow(doc: GraphDoc, r: number): GraphDoc {
  return ensureRows({
    ...doc,
    cells: doc.cells.filter((_, i) => i !== r),
    row_titles: doc.row_titles.filter((_, i) => i !== r),
    x: doc.x.filter((_, i) => i !== r),
  });
}

/** Number of non-blank values that a replicate count of `n` would drop. */
export function valuesBeyondRep(doc: GraphDoc, n: number): number {
  let count = 0;
  for (const row of doc.cells) for (const reps of row) for (let k = n; k < reps.length; k++) if (!isBlank(reps[k])) count++;
  return count;
}

export function setNRep(doc: GraphDoc, n: number): GraphDoc {
  if (doc.template === "column") return doc;
  const nRep = Math.max(1, Math.min(MAX_REP, Math.round(n)));
  if (nRep === doc.n_rep) return doc;
  return {
    ...doc,
    n_rep: nRep,
    cells: doc.cells.map((row) => row.map((reps) => Array.from({ length: nRep }, (_, k) => reps[k] ?? ""))),
  };
}

// ── flat grid columns + paste ───────────────────────────────────────────────

/** The grid's editable columns, left to right. */
export type FlatCol = { kind: "rowtitle" } | { kind: "x" } | { kind: "data"; col: number; rep: number };

export function leadCols(t: Template): FlatCol[] {
  return t === "grouped" ? [{ kind: "rowtitle" }] : t === "xy" ? [{ kind: "x" }] : [];
}

export function flatCols(doc: GraphDoc): FlatCol[] {
  const out = leadCols(doc.template);
  for (let c = 0; c < doc.col_titles.length; c++) for (let k = 0; k < doc.n_rep; k++) out.push({ kind: "data", col: c, rep: k });
  return out;
}

/** Flat column index → its kind, also for indices past the current width
 *  (those become new data columns when a paste grows the table). */
export function flatColAt(doc: GraphDoc, fc: number): FlatCol {
  const lead = leadCols(doc.template);
  if (fc < lead.length) return lead[fc];
  const d = fc - lead.length;
  return { kind: "data", col: Math.floor(d / doc.n_rep), rep: d % doc.n_rep };
}

/** Clipboard text → rows of cells (tab-separated, one trailing newline dropped). */
export function parsePaste(text: string): string[][] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((l) => l.split("\t"));
}

/** Multi-cell paste? (single values are left to the input's own paste). */
export const isMultiPaste = (text: string) => /[\t\n]/.test(text);

/** Paste anchor: a data row (row ≥ 0) or the title row (row = -1). */
export interface PasteAnchor { row: number; fc: number }

export interface PasteResult {
  doc: GraphDoc;
  /** Part of the paste fell outside the 26-group / 500-row limits. */
  truncated: boolean;
  /** The first pasted line was taken as column titles. */
  titles: boolean;
  rows: number;
  cols: number;
}

/** Fill the table from a block of clipboard text starting at `anchor`, growing
 *  rows and groups as needed (up to the limits). Pasting onto the title row
 *  fills titles from the first line; pasting into the first data row treats a
 *  first line without numbers as titles when later lines have numbers. */
export function applyPaste(doc: GraphDoc, anchor: PasteAnchor, text: string): PasteResult | null {
  let lines = parsePaste(text);
  if (!lines.length || (lines.length === 1 && lines[0].length === 1 && lines[0][0] === "")) return null;

  const numericLine = (line: string[]) =>
    line.some((v, j) => flatColAt(doc, anchor.fc + j).kind !== "rowtitle" && parseCell(v).value !== null);

  let titleLine: string[] | null = null;
  let row0 = anchor.row;
  if (anchor.row < 0) {
    titleLine = lines[0];
    lines = lines.slice(1);
    row0 = 0;
  } else if (anchor.row === 0 && lines.length > 1 && !numericLine(lines[0])
    && lines[0].some((v) => !isBlank(v)) && lines.slice(1).some(numericLine)) {
    titleLine = lines[0];
    lines = lines.slice(1);
  }

  const width = Math.max(titleLine?.length ?? 0, ...lines.map((l) => l.length));
  const lead = leadCols(doc.template).length;
  const lastFc = anchor.fc + width - 1;
  const groupsNeeded = lastFc < lead ? 0 : Math.floor((lastFc - lead) / doc.n_rep) + 1;
  const rowsNeeded = row0 + lines.length;
  let truncated = groupsNeeded > MAX_COLS || rowsNeeded > MAX_ROWS;

  let next: GraphDoc = {
    ...doc,
    col_titles: [...doc.col_titles],
    row_titles: [...doc.row_titles],
    x: [...doc.x],
    cells: doc.cells.map((row) => row.map((reps) => [...reps])),
  };
  const nGroups = Math.min(MAX_COLS, Math.max(next.col_titles.length, groupsNeeded));
  while (next.col_titles.length < nGroups) {
    next.col_titles.push(uniqueColTitle(next));
    next.cells.forEach((row) => row.push(Array.from({ length: next.n_rep }, () => "")));
  }
  const nRows = Math.min(MAX_ROWS, Math.max(next.cells.length, rowsNeeded));
  while (next.cells.length < nRows) {
    next.cells.push(blankRow(next.col_titles.length, next.n_rep));
    next.row_titles.push("");
    next.x.push("");
  }

  const put = (r: number, j: number, raw: string) => {
    const f = flatColAt(next, anchor.fc + j);
    const v = raw.trim();
    if (r < 0) {
      if (f.kind === "x") next.x_title = v;
      else if (f.kind === "data" && f.rep === 0 && f.col < next.col_titles.length) next.col_titles[f.col] = v;
      return;
    }
    if (r >= next.cells.length) return;
    if (f.kind === "rowtitle") next.row_titles[r] = v;
    else if (f.kind === "x") next.x[r] = v;
    else if (f.col < next.col_titles.length) next.cells[r][f.col][f.rep] = v;
  };

  if (titleLine) titleLine.forEach((v, j) => put(-1, j, v));
  lines.forEach((line, i) => line.forEach((v, j) => put(row0 + i, j, v)));
  next = ensureRows(next);
  if (!truncated && groupsNeeded > next.col_titles.length) truncated = true;
  return { doc: next, truncated, titles: !!titleLine, rows: lines.length, cols: width };
}

// ── statistics options ──────────────────────────────────────────────────────

export const TEST_LABELS: Record<TestId, string> = {
  none: "No test (descriptive statistics only)",
  unpaired_t: "Unpaired t test",
  welch_t: "Welch's t test (unequal variances)",
  paired_t: "Paired t test",
  mann_whitney: "Mann-Whitney test",
  wilcoxon: "Wilcoxon matched-pairs signed rank test",
  anova: "One-way ANOVA",
  welch_anova: "Welch's ANOVA (unequal variances)",
  kruskal: "Kruskal-Wallis test",
  two_way: "Two-way ANOVA",
  linreg: "Linear regression",
};

export const POSTHOC_LABELS: Record<PosthocId, string> = {
  none: "None",
  tukey: "Tukey",
  dunnett: "Dunnett",
  sidak: "Šídák",
  bonferroni: "Bonferroni",
  dunn: "Dunn",
  games_howell: "Games-Howell",
};

/** Tests that fit a table with `nGroups` data sets holding numbers (and
 *  `nRows` used rows for the grouped template). First = the default. */
export function testsFor(t: Template, nGroups: number, nRows: number): TestId[] {
  if (t === "column") {
    if (nGroups === 2) return ["welch_t", "unpaired_t", "paired_t", "mann_whitney", "wilcoxon", "none"];
    if (nGroups >= 3) return ["anova", "welch_anova", "kruskal", "none"];
    return ["none"];
  }
  if (t === "grouped") return nGroups >= 2 && nRows >= 2 ? ["two_way", "none"] : ["none"];
  return nGroups >= 1 ? ["linreg", "none"] : ["none"];
}

export const defaultTest = (t: Template, nGroups: number, nRows: number): TestId => testsFor(t, nGroups, nRows)[0];

export function posthocsFor(test: TestId): PosthocId[] {
  switch (test) {
    case "anova": return ["tukey", "dunnett", "sidak", "bonferroni", "none"];
    case "welch_anova": return ["games_howell", "none"];
    case "kruskal": return ["dunn", "none"];
    case "two_way": return ["tukey", "sidak", "bonferroni", "none"];
    default: return ["none"];
  }
}

/** Default post-hoc test; `nEntities` = groups being compared with each other. */
export function defaultPosthoc(test: TestId, nEntities: number): PosthocId {
  if (test === "two_way") return nEntities >= 3 ? "tukey" : "sidak";
  return posthocsFor(test)[0];
}

/** Which comparison sets a post-hoc test supports. First = the default. */
export function comparesFor(p: PosthocId): CompareId[] {
  switch (p) {
    case "tukey": case "games_howell": return ["all"];
    case "dunnett": return ["control"];
    case "dunn": return ["all", "control"];
    case "sidak": case "bonferroni": return ["all", "control", "selected"];
    default: return ["all"];
  }
}

/** Is this a test with a multiple-comparisons step? */
export const hasPosthoc = (test: TestId) => posthocsFor(test).length > 1;

export interface AnalysisContext {
  template: Template;
  /** Data sets (columns) holding numbers. */
  nGroups: number;
  /** Rows holding numbers (grouped template). */
  nRows: number;
  /** How many things a control / pair index can point at (all columns, or all rows when comparing within columns). */
  nEntities: number;
}

/** Make the analysis settings consistent with the table: an unavailable test
 *  falls back to the default (only once the table has enough data to offer a
 *  real choice, so a half-typed table doesn't erase the user's pick), then the
 *  post-hoc test, comparison set, control and pairs are fixed up. */
export function normalizeAnalysis(a: GraphAnalysis, ctx: AnalysisContext): GraphAnalysis {
  const tests = testsFor(ctx.template, ctx.nGroups, ctx.nRows);
  const test = tests.length > 1 && !tests.includes(a.test) ? tests[0] : a.test;
  // A test switched here gets its default post-hoc (not a leftover "none").
  const posthoc = test === a.test && posthocsFor(test).includes(a.posthoc) ? a.posthoc : defaultPosthoc(test, ctx.nEntities);
  const compares = comparesFor(posthoc);
  const compare = compares.includes(a.compare) ? a.compare : compares[0];
  const inRange = (i: number) => Number.isInteger(i) && i >= 0 && i < ctx.nEntities;
  let control = a.control !== null && inRange(a.control) ? a.control : null;
  if (compare === "control" && control === null && ctx.nEntities > 0) control = 0;
  const seen = new Set<string>();
  const pairs = a.pairs.filter(([i, j]) => {
    const key = i < j ? `${i},${j}` : `${j},${i}`;
    if (!inRange(i) || !inRange(j) || i === j || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const correlation = ctx.template === "xy" ? a.correlation : "none";
  const next: GraphAnalysis = { ...a, test, posthoc, compare, control, pairs, correlation };
  return JSON.stringify(next) === JSON.stringify(a) ? a : next;
}

export function defaultAnalysis(t: Template, nGroups: number, nRows: number): GraphAnalysis {
  const test = defaultTest(t, nGroups, nRows);
  const posthoc = defaultPosthoc(test, nGroups);
  return {
    test, posthoc, compare: comparesFor(posthoc)[0], control: null, pairs: [], alpha: 0.05,
    within: "rows", family: "all", correlation: "none",
  };
}

/** Tests that compare exactly two groups (one pair of columns). */
export const TWO_GROUP_TESTS: readonly TestId[] = ["unpaired_t", "welch_t", "paired_t", "mann_whitney", "wilcoxon"];

/** Indices of the columns (data sets) holding at least one number. */
export const filledCols = (t: GraphTable): number[] =>
  t.col_titles.map((_, c) => c).filter((c) => t.values.some((row) => (row[c] ?? []).some((v) => v !== null)));

/** The analysis actually sent for a table: a test the current data can't
 *  support is sent as "none" (the stored choice is kept for when it can),
 *  and indices beyond the trimmed table are dropped. A two-group test on a
 *  Column table is sent the pair of the two columns that hold numbers (an
 *  empty column may sit before or between them), never stored pairs. */
export function effectiveAnalysis(a: GraphAnalysis, table: GraphTable): GraphAnalysis {
  const nG = usedCols(table), nR = usedRows(table);
  const ok = testsFor(table.template, nG, nR).includes(a.test);
  const nEntities = table.template === "grouped" && a.within === "columns" ? table.values.length : table.col_titles.length;
  const inRange = (i: number) => i >= 0 && i < nEntities;
  const base = ok ? a : { ...a, test: "none" as TestId, posthoc: "none" as PosthocId, compare: "all" as CompareId };
  let pairs = base.pairs.filter(([i, j]) => inRange(i) && inRange(j));
  if (table.template === "column" && TWO_GROUP_TESTS.includes(base.test)) {
    const filled = filledCols(table);
    pairs = filled.length === 2 ? [[filled[0], filled[1]]] : [];
  }
  return {
    ...base,
    control: base.control !== null && inRange(base.control) ? base.control : null,
    pairs,
  };
}

// ── figure ──────────────────────────────────────────────────────────────────

export const GRAPH_DEFAULT: Record<Template, GraphType> = { column: "dot", grouped: "gbar", xy: "xy_fit" };

/** A colour for a new data set: the first palette colour not already used. */
export function nextColor(used: string[], palette = PALETTES.Default): string {
  const taken = new Set(used.map((c) => c.toLowerCase()));
  return palette.find((c) => !taken.has(c.toLowerCase())) ?? palette[used.length % palette.length];
}

/** Grow/shrink the per-data-set colours and legend labels to `n`. */
export function resizeSeries(f: GraphFigure, n: number): GraphFigure {
  if (f.colors.length === n && f.labels.length === n) return f;
  const colors = f.colors.slice(0, n);
  while (colors.length < n) colors.push(nextColor(colors));
  const labels = f.labels.slice(0, n);
  while (labels.length < n) labels.push("");
  return { ...f, colors, labels };
}

export function defaultFigure(t: Template, nSeries: number, xTitle = "X"): GraphFigure {
  return resizeSeries({
    graph_type: GRAPH_DEFAULT[t],
    center: "mean_sd",
    show_points: true,
    point_size: 2.5,
    bar_width: 0.6,
    show_band: true,
    show_equation: false,
    sig_show: "significant",
    sig_label: "stars",
    title: "",
    xlabel: t === "xy" ? xTitle : "",
    ylabel: t === "xy" ? "Y" : "Value",
    font_size: 14,
    y_min: null,
    y_max: null,
    colors: [],
    labels: [],
    show_legend: t !== "column",
    theme: "prism",
    width: t === "column" ? 900 : 1100,
    height: 800,
    dpi: 150,
    export_format: "png",
    transparent: false,
    fig_label: "Fig. 1",
    n_unit: "",
  }, nSeries);
}

/** Figure fields that only feed the generated legend text: saved with the
 *  document, but never part of the plot request (or the plot key). */
export const LEGEND_ONLY_KEYS = ["fig_label", "n_unit"] as const;

const HEX = /^#[0-9a-fA-F]{6}$/;

/** The figure sent for a table: one colour/label per remaining data set;
 *  a blank legend label falls back to the column title. */
export function effectiveFigure(f: GraphFigure, table: GraphTable): GraphFigure {
  const n = table.col_titles.length;
  const sized = resizeSeries(f, Math.max(n, f.colors.length));
  // legend-only fields: never part of the plot request / plotKey (typing them must not re-render)
  const { fig_label: _fl, n_unit: _nu, ...plot } = f;
  return {
    ...plot,
    colors: sized.colors.slice(0, n).map((c, i) => (HEX.test(c) ? c : PALETTES.Default[i % PALETTES.Default.length])),
    labels: sized.labels.slice(0, n).map((l, i) => l.trim() || table.col_titles[i]),
  };
}

// ── index remapping after structural edits ──────────────────────────────────

export type IndexOp = { type: "insert"; at: number } | { type: "delete"; at: number };

export function remapIndex(i: number, op: IndexOp): number | null {
  if (op.type === "insert") return i >= op.at ? i + 1 : i;
  return i === op.at ? null : i > op.at ? i - 1 : i;
}

/** Keep control / pair indices pointing at the same column (or row, when a
 *  grouped table compares within columns) after a column/row insert/delete. */
export function remapAnalysis(a: GraphAnalysis, t: Template, axis: "col" | "row", op: IndexOp): GraphAnalysis {
  const entityAxis = t === "grouped" && a.within === "columns" ? "row" : "col";
  if (axis !== entityAxis) return a;
  const control = a.control === null ? null : remapIndex(a.control, op);
  const pairs: [number, number][] = [];
  for (const [i, j] of a.pairs) {
    const a2 = remapIndex(i, op), b2 = remapIndex(j, op);
    if (a2 !== null && b2 !== null) pairs.push([a2, b2]);
  }
  return { ...a, control, pairs };
}

export function remapFigure(f: GraphFigure, op: IndexOp): GraphFigure {
  const colors = [...f.colors], labels = [...f.labels];
  if (op.type === "insert") {
    colors.splice(op.at, 0, nextColor(colors));
    labels.splice(op.at, 0, "");
  } else {
    colors.splice(op.at, 1);
    labels.splice(op.at, 1);
  }
  return { ...f, colors, labels };
}

// ── formatting ──────────────────────────────────────────────────────────────

/** Prism-style P value text. */
export function formatP(p: Num | undefined): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return "—";
  if (p < 0.0001) return "< 0.0001";
  if (p > 0.9999) return "> 0.9999";
  return p.toFixed(4);
}

/** A number for on-screen tables (display only — CSV exports carry the raw
 *  value). Integers are shown exactly; other values keep every digit before
 *  the decimal point with 2 decimals from 1000 up, `digits` significant
 *  digits below that, and scientific notation only when tiny or huge. */
export function formatNum(v: Num | undefined, digits = 4): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v);
  const a = Math.abs(v);
  if (a < 1e-4 || a >= 1e9) return v.toExponential(digits - 1);
  return a >= 1000 ? String(Number(v.toFixed(2))) : String(Number(v.toPrecision(digits)));
}

/** A raw data value (Min / Max) shown exactly as entered, never rounded. */
export function formatExact(v: Num | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return String(v);
}

/** CSV text from flat records (columns from the first record). Numbers are
 *  written at full precision, null/undefined as empty cells. */
export function toCsv(rows: Record<string, string | number | boolean | null | undefined>[]): string {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const cell = (v: string | number | boolean | null | undefined) => {
    const s = v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v)) ? ""
      : typeof v === "boolean" ? (v ? "Yes" : "No") : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.map(cell).join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
}

/** The X axis label follows the X column title while the two match: when the
 *  title changes from `oldTitle` to `newTitle`, a label still equal to the old
 *  title moves with it; a label edited separately is kept. */
export function followXLabel(f: GraphFigure, oldTitle: string, newTitle: string): GraphFigure {
  return oldTitle !== newTitle && f.xlabel === oldTitle ? { ...f, xlabel: newTitle } : f;
}
