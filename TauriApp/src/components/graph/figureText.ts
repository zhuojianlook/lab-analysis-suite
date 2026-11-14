/* Auto-generated figure legend and statistical-methods paragraph for the
   Graphs tool. Pure functions, no React, no I/O: the text is a deterministic
   function of the table, the analysis and figure settings that were sent, the
   AnalyzeResult the engine returned and the software versions it reported.

   Rules:
   - Never recompute a statistic: every test statistic, df and P comes from
     the AnalyzeResult. Only counts (n, pairs) and "what is drawn" predicates
     are derived here, and those mirror graph_plot.py exactly (effective graph
     type, which points / error bars / brackets / fit lines / bands exist).
   - Never claim a test that didn't produce a P value; never list a star
     symbol that isn't on the figure; never cite a software version the engine
     didn't report. */

import type {
  AnalyzeResult, CenterId, GraphAnalysis, GraphFigure, GraphTable, SoftwareVersions, Template,
} from "../../api/graph";

export interface FigureTextInput {
  /** toNumericTable(doc) */
  table: GraphTable;
  /** effectiveAnalysis(...): what was sent to the engine. */
  analysis: GraphAnalysis;
  /** effectiveFigure(...): what was sent to the engine. */
  figure: GraphFigure;
  /** null = not computed yet / stale / request failed. */
  result: AnalyzeResult | null;
  software?: Partial<SoftwareVersions> | null;
  options?: { normality?: boolean };
}

export interface FigureText {
  /** One paragraph of plain Unicode text. */
  legend: string;
  /** One paragraph of plain Unicode text. */
  methods: string;
  /** Caveats for the user (shown under the text, never copied). */
  notes: string[];
}

export interface DrawnBracket {
  label: string;
  star: string;
  p: number;
  a: number;
  b: number;
  row: number | null;
}

type Comparison = AnalyzeResult["comparisons"][number];
type PlotType = "dot" | "bar" | "box" | "violin" | "xy_points" | "xy_line" | "xy_fit";

const MINUS = "−";
const MAX_BRACKETS = 200;     // graph_plot.MAX_BRACKETS
const MAX_LISTED = 8;         // names enumerated in a list; more -> "N groups"
const MAX_NAMED_N = 6;        // unequal n spelled out per group up to this many groups
const MAX_PAIRS_LISTED = 6;
const MAX_FIT_STATS = 3;      // XY series whose regression / correlation numbers are written out
const REL_NOISE = 1e-12;      // graph_stats.REL_NOISE
const CENTERS: CenterId[] = ["mean_sd", "mean_sem", "mean_ci", "median_iqr"];
const TWO_GROUP = ["unpaired_t", "welch_t", "paired_t", "mann_whitney", "wilcoxon"];
const ONE_WAY = ["anova", "welch_anova", "kruskal"];

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const minus = (s: string) => (s.startsWith("-") ? MINUS + s.slice(1) : s);
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** User text (titles, labels) as one line without stray whitespace. */
const clean = (s: unknown): string => (typeof s === "string" ? s : s == null ? "" : String(s)).replace(/\s+/g, " ").trim();

/** Append a full stop unless the text already ends a sentence. */
function end(s: string): string {
  const t = s.trim();
  if (!t) return "";
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

// ── number formatting (exported, unit-tested) ───────────────────────────────

/** "P = 0.016" | "P = 0.0004" | "P < 0.0001" | "P > 0.999". A value that
 *  would round onto a significance cut-off it isn't equal to gets more
 *  decimals, so the text never contradicts the stars (0.0496 -> 0.0496). */
export function fmtP(p: number, alpha = 0.05): string {
  if (!isNum(p)) return "P not available";
  if (p < 0.0001) return "P < 0.0001";
  let d = p < 0.001 ? 4 : 3;
  let s = p.toFixed(d);
  if (d === 3 && Number(s) >= 1) return "P > 0.999";
  const cuts = [0.05, 0.01, 0.001, 0.0001, alpha];
  while (d < 10 && cuts.some((c) => Number(s) === c && p !== c)) {
    d++;
    s = p.toFixed(d);
  }
  return `P = ${s}`;
}

const SUP: Record<string, string> = {
  "-": "⁻", "+": "", "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
  "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
};

function sci(x: number, digits: number): string {
  const [m, e] = x.toExponential(digits - 1).split("e");
  return `${minus(m)} × 10${e.split("").map((ch) => SUP[ch] ?? ch).join("")}`;
}

/** A test statistic: 1 decimal from 100 up, 2 decimals from 0.01 up, else 2
 *  significant figures (scientific notation when tiny or huge). */
export function fmtStat(x: number): string {
  if (!isNum(x)) return "—";
  if (x === 0) return "0";
  const a = Math.abs(x);
  if (a >= 1e6) return sci(x, 3);
  if (Math.abs(Number(x.toFixed(2))) >= 100) return minus(x.toFixed(1));
  if (a >= 0.01) return minus(x.toFixed(2));
  if (a < 1e-4) return sci(x, 2);
  return minus(x.toPrecision(2));
}

/** A rank statistic (U, W): exactly as returned (integer or one decimal). */
export function fmtRank(x: number): string {
  if (!isNum(x)) return "—";
  return minus(Number.isInteger(x) ? String(x) : x.toFixed(1));
}

/** Degrees of freedom: integers as integers, fractional (Welch) with 2 decimals. */
export function fmtDf(df: number): string {
  if (!isNum(df)) return "—";
  return Math.abs(df - Math.round(df)) < 1e-9 ? String(Math.round(df)) : df.toFixed(2);
}

/** "A", "A and B", "A, B and C". */
export function joinList(items: string[]): string {
  const xs = items.filter((s) => s !== "");
  if (xs.length <= 1) return xs[0] ?? "";
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

/** Names when there are few enough to list, else "N <noun>". */
function listOrCount(names: string[], noun: string): string {
  return names.length <= MAX_LISTED ? joinList(names) : `${names.length} ${noun}`;
}

const fmtThr = (x: number) => String(Number(x.toPrecision(6)));

/** A coefficient bounded by ±1 (r, R²) with 3 decimals; never rounds onto ±1. */
function fmtCoef(name: string, v: number): string {
  if (v === 1 || v === -1) return `${name} = ${minus(String(v))}`;
  const s = v.toFixed(3);
  if (Number(s) >= 1) return `${name} > 0.999`;
  if (Number(s) <= -1) return `${name} < ${MINUS}0.999`;
  return `${name} = ${minus(s)}`;
}

/** A coefficient with 4 significant figures, as Python's "{:.4g}" (the
 *  engine's equation label) but with Unicode minus / × 10ⁿ. */
export function fmtG4(v: number): string {
  if (!isNum(v)) return "—";
  if (v === 0) return "0";
  const r = Number(v.toPrecision(4));
  const [m, e] = r.toExponential(3).split("e");
  const exp = Number(e);
  if (exp < -4 || exp >= 4) {
    return `${minus(String(Number(m)))} × 10${String(exp).split("").map((ch) => SUP[ch] ?? ch).join("")}`;
  }
  return minus(String(r));
}

/** "Y = 1.963X + 0.1133", "Y = −X − 2.5", "Y = (1.2 × 10⁻⁵)X + 3" (same numbers
 *  as the equation the engine prints on the graph, publication typography). */
export function fmtEquation(slope: number, intercept: number): string {
  if (!isNum(slope) || !isNum(intercept)) return "";
  const b = fmtG4(slope);
  const bx = b === "1" ? "X" : b === `${MINUS}1` ? `${MINUS}X` : b.includes("×") ? `(${b})X` : `${b}X`;
  const a = fmtG4(Math.abs(intercept));
  return `Y = ${bx} ${intercept < 0 ? MINUS : "+"} ${a.includes("×") ? `(${a})` : a}`;
}

// ── normalised inputs (mirror graph_plot.normalize_figure) ─────────────────

interface Norm {
  template: Template;
  type: PlotType;
  center: CenterId;
  points: boolean;
  sigShow: "significant" | "all" | "none";
  sigLabel: "stars" | "p";
  showBand: boolean;
  showEquation: boolean;
  showLegend: boolean;
  theme: string;
  /** Display name per column / data set (legend label, else the column title). */
  labels: string[];
  rowTitles: string[];
  alpha: number;
  /** Significance cut-off as `_star` applies it: P ≤ min(alpha, 0.05). */
  thr: number;
}

function normalise(input: FigureTextInput): Norm {
  const { table: t, figure: f, analysis: a } = input;
  const template = t.template;
  const raw = String(f?.graph_type ?? "");
  let type: PlotType;
  if (template === "xy") {
    type = raw === "xy_points" || raw === "xy_line" || raw === "xy_fit" ? raw : "xy_points";
  } else {
    const m = raw === "gbar" ? "bar" : raw === "gdot" ? "dot" : raw;
    type = m === "dot" || m === "bar" || m === "box" || m === "violin" ? m : "bar";
  }
  const center = CENTERS.includes(f?.center) ? f.center : "mean_sd";
  const showPoints = typeof f?.show_points === "boolean" ? f.show_points : false;
  const labels = t.col_titles.map((title, i) => clean(f?.labels?.[i]) || clean(title));
  const alpha = isNum(a?.alpha) && a.alpha > 0 && a.alpha < 1 ? a.alpha : 0.05;
  return {
    template,
    type,
    center,
    points: template === "xy" ? showPoints : showPoints || type === "dot",
    sigShow: f?.sig_show === "all" || f?.sig_show === "none" ? f.sig_show : "significant",
    sigLabel: f?.sig_label === "p" ? "p" : "stars",
    showBand: typeof f?.show_band === "boolean" ? f.show_band : true,
    showEquation: typeof f?.show_equation === "boolean" ? f.show_equation : false,
    showLegend: typeof f?.show_legend === "boolean" ? f.show_legend : template !== "column",
    theme: f?.theme === "classic" || f?.theme === "minimal" ? f.theme : "prism",
    labels,
    rowTitles: t.row_titles.map(clean),
    alpha,
    thr: Math.min(alpha, 0.05),
  };
}

// ── table helpers ───────────────────────────────────────────────────────────

function cell(t: GraphTable, r: number, c: number): number[] {
  return (t.values[r]?.[c] ?? []).filter(isNum);
}

const nCols = (t: GraphTable) => t.col_titles.length;
const nRows = (t: GraphTable) => t.values.length;

interface Group { c: number; r: number | null; n: number }

/** Plotted groups (≥ 1 value) in drawing order: columns, or row × column cells. */
function plottedGroups(t: GraphTable): Group[] {
  const out: Group[] = [];
  if (t.template === "column") {
    for (let c = 0; c < nCols(t); c++) {
      let n = 0;
      for (let r = 0; r < nRows(t); r++) n += cell(t, r, c).length;
      if (n > 0) out.push({ c, r: null, n });
    }
  } else if (t.template === "grouped") {
    for (let r = 0; r < nRows(t); r++) {
      for (let c = 0; c < nCols(t); c++) {
        const n = cell(t, r, c).length;
        if (n > 0) out.push({ c, r, n });
      }
    }
  }
  return out;
}

const hasAnyValue = (t: GraphTable) => t.values.some((row) => row.some((reps) => (reps ?? []).some(isNum)));

const rangeText = (lo: number, hi: number) => (lo === hi ? String(lo) : `${lo}–${hi}`);

// ── XY series (mirrors graph_plot._xy_code + graph_stats.linreg) ───────────

interface Series {
  c: number;
  name: string;
  cells: number;
  minRep: number;
  maxRep: number;
  px: number[];
  py: number[];
}

function xySeries(t: GraphTable, N: Norm): Series[] {
  const out: Series[] = [];
  for (let c = 0; c < nCols(t); c++) {
    const s: Series = { c, name: N.labels[c], cells: 0, minRep: Infinity, maxRep: 0, px: [], py: [] };
    for (let r = 0; r < nRows(t); r++) {
      const x = t.x[r];
      const v = cell(t, r, c);
      if (!isNum(x) || !v.length) continue;
      s.cells++;
      s.minRep = Math.min(s.minRep, v.length);
      s.maxRep = Math.max(s.maxRep, v.length);
      for (const y of v) {
        s.px.push(x);
        s.py.push(y);
      }
    }
    if (s.cells > 0) out.push(s);
  }
  return out;
}

const sumsq = (xs: number[]) => xs.reduce((s, v) => s + v * v, 0);
const ptp = (xs: number[]) => (xs.length ? Math.max(...xs) - Math.min(...xs) : 0);

/** What graph_stats.linreg would return for these points: a line (slope),
 *  an R², and a band / P (the same condition produces both). Exported for
 *  the parity tests against the engine. */
export function linearFitInfo(px: number[], py: number[]): { line: boolean; r2: boolean; band: boolean } {
  const n = px.length;
  if (n < 2 || !(ptp(px) > 0)) return { line: false, r2: false, band: false };
  const xbar = px.reduce((s, v) => s + v, 0) / n;
  const ybar = py.reduce((s, v) => s + v, 0) / n;
  let sxx = 0, sxy = 0, sst = 0;
  for (let i = 0; i < n; i++) {
    sxx += (px[i] - xbar) ** 2;
    sxy += (px[i] - xbar) * (py[i] - ybar);
    sst += (py[i] - ybar) ** 2;
  }
  if (![xbar, ybar, sxx, sxy, sst].every(isNum) || !(sxx > 0)) return { line: false, r2: false, band: false };
  const slope = sxy / sxx;
  if (!isNum(slope) || !isNum(ybar - slope * xbar)) return { line: false, r2: false, band: false };
  if (n < 3) return { line: true, r2: false, band: false };
  if (sst <= 0) return { line: true, r2: false, band: false };
  let rss = 0;
  for (let i = 0; i < n; i++) {
    const e = (py[i] - ybar) - slope * (px[i] - xbar);
    rss += e * e;
  }
  const scale = sumsq(py) + slope * slope * sumsq(px);
  if (!isNum(rss) || !isNum(scale)) return { line: true, r2: false, band: false };
  if (rss <= REL_NOISE * REL_NOISE * Math.max(scale, 0) || rss <= 1e-300) return { line: true, r2: true, band: false };
  const seB = Math.sqrt(rss / (n - 2)) / Math.sqrt(sxx);
  return { line: true, r2: true, band: isNum(seB) && seB > 0 };
}

// ── result validity ─────────────────────────────────────────────────────────

interface Stats {
  /** A usable result for these settings (not null, not an error envelope). */
  ok: boolean;
  res: AnalyzeResult | null;
  test: NonNullable<AnalyzeResult["test"]> | null;
  /** The omnibus / two-group P exists. */
  testP: boolean;
  /** Comparisons with an (adjusted) P. */
  cmpP: Comparison[];
}

const arr = <T>(v: T[] | null | undefined): T[] => (Array.isArray(v) ? v : []);

function stats(input: FigureTextInput): Stats {
  const raw = input.result;
  const none: Stats = { ok: false, res: raw, test: null, testP: false, cmpP: [] };
  if (!raw || raw.code === "invalid" || raw.error) return none;
  // every list defaulted, so a partial / malformed result can't throw below
  const res: AnalyzeResult = {
    ...raw, warnings: arr(raw.warnings), descriptives: arr(raw.descriptives), normality: arr(raw.normality),
    anova_table: arr(raw.anova_table), comparisons: arr(raw.comparisons), regression: arr(raw.regression),
    correlation: arr(raw.correlation),
  };
  const want = input.analysis?.test;
  const test = res.test && res.test.id === want ? res.test : null;
  if (input.table.template !== "xy" && want !== "none" && !test) return none;   // stale / mismatched result
  return { ok: true, res, test, testP: !!test && isNum(test.p), cmpP: res.comparisons.filter((c) => isNum(c?.p_adj)) };
}

// ── brackets (mirror graph_plot._column_code) ──────────────────────────────

/** The significance brackets the figure draws, with their labels. */
export function drawnBrackets(input: FigureTextInput): DrawnBracket[] {
  return bracketInfo(input).drawn;
}

function pLabel(p: number): string {
  if (p < 0.0001) return "P<0.0001";
  return `P=${String(Number(p.toPrecision(3)))}`;
}

function bracketInfo(input: FigureTextInput): { drawn: DrawnBracket[]; droppedNs: number; tooMany: number } {
  const out = { drawn: [] as DrawnBracket[], droppedNs: 0, tooMany: 0 };
  const t = input.table;
  if (t.template === "xy" || !input.result) return out;
  const N = normalise(input);
  if (N.sigShow === "none") return out;
  const plotted = new Set(plottedGroups(t).map((g) => `${g.r ?? -1},${g.c}`));
  const within = input.analysis?.within === "columns" ? "columns" : "rows";
  for (const cmp of arr(input.result.comparisons)) {
    const p = cmp.p_adj;
    if (!isNum(p)) continue;
    const star = cmp.star || "ns";
    let ka: string, kb: string;
    if (t.template === "grouped") {
      const row = cmp.row ?? -1;
      if (within === "rows") {
        ka = `${row},${cmp.a}`;
        kb = `${row},${cmp.b}`;
      } else {
        ka = `${cmp.a},${row}`;
        kb = `${cmp.b},${row}`;
      }
    } else {
      ka = `-1,${cmp.a}`;
      kb = `-1,${cmp.b}`;
    }
    if (!plotted.has(ka) || !plotted.has(kb)) continue;
    if (N.sigShow === "significant" && star === "ns") {
      out.droppedNs++;
      continue;
    }
    out.drawn.push({ label: N.sigLabel === "stars" ? star : pLabel(p), star, p, a: cmp.a, b: cmp.b, row: cmp.row });
  }
  if (out.drawn.length > MAX_BRACKETS) {
    out.tooMany = out.drawn.length;
    out.drawn = [];
  }
  return out;
}

// ── n ───────────────────────────────────────────────────────────────────────

/** Rows with a value in both / only one of two columns (paired tests). */
function pairCounts(t: GraphTable, a: number, b: number): { pairs: number; dropped: number } {
  let pairs = 0, dropped = 0;
  for (let r = 0; r < nRows(t); r++) {
    const ha = cell(t, r, a).length > 0, hb = cell(t, r, b).length > 0;
    if (ha && hb) pairs++;
    else if (ha !== hb) dropped++;
  }
  return { pairs, dropped };
}

/** The pair a two-group test compared (as the engine reports it). */
function testedPair(input: FigureTextInput, S: Stats): [number, number] | null {
  const c0 = S.res?.comparisons?.[0];
  if (c0 && Number.isInteger(c0.a) && Number.isInteger(c0.b)) return [c0.a, c0.b];
  const p = input.analysis?.pairs?.[0];
  return p ? [p[0], p[1]] : null;
}

/** The "n = …" text of the legend, with the range of group sizes. */
export function describeN(input: FigureTextInput): { text: string; equal: boolean; min: number; max: number } {
  const t = input.table;
  const N = normalise(input);
  if (t.template === "xy") {
    const ss = xySeries(t, N);
    if (!ss.length) return { text: "", equal: true, min: 0, max: 0 };
    const maxRep = Math.max(...ss.map((s) => s.maxRep));
    if (maxRep <= 1) {
      const pts = ss.map((s) => s.px.length);
      const lo = Math.min(...pts), hi = Math.max(...pts);
      const per = ss.length > 1 ? " per data set" : "";
      return { text: `n = ${rangeText(lo, hi)} ${plural(hi, "point", "points")}${per}`, equal: lo === hi, min: lo, max: hi };
    }
    const rLo = Math.min(...ss.map((s) => s.minRep)), rHi = maxRep;
    const xLo = Math.min(...ss.map((s) => s.cells)), xHi = Math.max(...ss.map((s) => s.cells));
    return {
      text: xHi === 1 ? `n = ${rangeText(rLo, rHi)} replicates at a single X value`
        : `n = ${rangeText(rLo, rHi)} replicates at each of ${rangeText(xLo, xHi)} X values`,
      equal: rLo === rHi, min: rLo, max: rHi,
    };
  }
  const groups = plottedGroups(t);
  if (!groups.length) return { text: "", equal: true, min: 0, max: 0 };
  const ns = groups.map((g) => g.n);
  const lo = Math.min(...ns), hi = Math.max(...ns);
  const S = stats(input);
  if (t.template === "column" && (input.analysis.test === "paired_t" || input.analysis.test === "wilcoxon") && S.testP) {
    const pr = testedPair(input, S);
    if (pr) {
      const { pairs, dropped } = pairCounts(t, pr[0], pr[1]);
      if (!dropped && groups.length === 2) return { text: `n = ${pairs} pairs`, equal: true, min: pairs, max: pairs };
    }
  }
  if (lo === hi) {
    return { text: groups.length > 1 ? `n = ${lo} per group` : `n = ${lo}`, equal: true, min: lo, max: hi };
  }
  if (t.template === "column" && groups.length <= MAX_NAMED_N) {
    // "Control, n = 10; Treatment, n = 9": no nested parentheses inside the legend's "(…)"
    const parts = groups.map((g) => `${N.labels[g.c]}, n = ${g.n}`);
    return { text: parts.join("; "), equal: false, min: lo, max: hi };
  }
  return { text: `n = ${lo}–${hi} per group`, equal: false, min: lo, max: hi };
}

// ── shared phrases ──────────────────────────────────────────────────────────

const CENTER_TEXT: Record<CenterId, string> = {
  mean_sd: "mean ± SD",
  mean_sem: "mean ± SEM",
  mean_ci: "mean with 95% confidence interval",
  median_iqr: "median with interquartile range",
};

const isMeanCentre = (c: CenterId) => c !== "median_iqr";

function yName(N: Norm, f: GraphFigure, notes: string[]): string {
  const y = clean(f?.ylabel);
  if (!y || y === "Value" || y === "Y") {
    addNote(notes, "The Y axis title is generic; name the measured variable and its unit.");
    return N.template === "xy" ? "Y" : "Values";
  }
  return y;
}

const TWO_GROUP_LEGEND: Record<string, string> = {
  unpaired_t: "an unpaired two-tailed Student's t test",
  welch_t: "an unpaired two-tailed t test with Welch's correction",
  paired_t: "a paired two-tailed t test",
  mann_whitney: "a two-sided Mann–Whitney test",
  wilcoxon: "a two-sided Wilcoxon matched-pairs signed-rank test",
};

const ONE_WAY_LEGEND: Record<string, string> = {
  anova: "one-way ANOVA",
  welch_anova: "Welch's ANOVA",
  kruskal: "the Kruskal–Wallis test",
};

const POSTHOC_LEGEND: Record<string, string> = {
  tukey: "Tukey's multiple comparisons test",
  dunnett: "Dunnett's multiple comparisons test",
  sidak: "Šídák's multiple comparisons test",
  bonferroni: "Bonferroni's multiple comparisons test",
  dunn: "Dunn's multiple comparisons test with Bonferroni correction",
  games_howell: "the Games–Howell multiple comparisons test",
};

/** "t(18) = −1.19", "F(2, 27) = 4.85", "H(2) = 7.99", "U = 32.5", … */
function statText(test: NonNullable<AnalyzeResult["test"]>): string {
  const x = test.statistic;
  if (!isNum(x)) return "";
  switch (test.id) {
    case "unpaired_t": case "welch_t": case "paired_t":
      return isNum(test.df) ? `t(${fmtDf(test.df)}) = ${fmtStat(x)}` : `t = ${fmtStat(x)}`;
    case "mann_whitney": return `U = ${fmtRank(x)}`;
    case "wilcoxon": return `W = ${fmtRank(x)}`;
    case "anova": case "welch_anova": {
      const name = test.id === "welch_anova" ? "Welch's F" : "F";
      return isNum(test.df) && isNum(test.df2) ? `${name}(${fmtDf(test.df)}, ${fmtDf(test.df2)}) = ${fmtStat(x)}` : `${name} = ${fmtStat(x)}`;
    }
    case "kruskal": return isNum(test.df) ? `H(${fmtDf(test.df)}) = ${fmtStat(x)}` : `H = ${fmtStat(x)}`;
    default: return "";
  }
}

const statAndP = (test: NonNullable<AnalyzeResult["test"]>, alpha: number) =>
  [statText(test), isNum(test.p) ? fmtP(test.p, alpha) : ""].filter(Boolean).join(", ");

/** Names of the two sides of a comparison (labels as the reader sees them). */
function cmpNames(input: FigureTextInput, N: Norm, c: Comparison): [string, string] {
  const inner = input.table.template === "grouped" && input.analysis.within === "columns" ? N.rowTitles : N.labels;
  return [inner[c.a] ?? `Group ${c.a + 1}`, inner[c.b] ?? `Group ${c.b + 1}`];
}

/** Distinct compared pairs as "B vs. A" (grouped: across rows / columns). */
function pairList(input: FigureTextInput, N: Norm, cmps: Comparison[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of cmps) {
    const key = `${c.a},${c.b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const [a, b] = cmpNames(input, N, c);
    out.push(`${b} vs. ${a}`);
  }
  return out.length <= MAX_PAIRS_LISTED ? out.join("; ") : `${out.length} pairs`;
}

function controlName(input: FigureTextInput, N: Norm): string {
  const i = input.analysis.control ?? 0;
  const inner = input.table.template === "grouped" && input.analysis.within === "columns" ? N.rowTitles : N.labels;
  return inner[i] ?? `Group ${i + 1}`;
}

// ── legend ──────────────────────────────────────────────────────────────────

function shownColumn(input: FigureTextInput, N: Norm, nText: string, notes: string[]): string[] {
  const groups = plottedGroups(input.table);
  const C = CENTER_TEXT[N.center];
  const pts = N.points ? "; circles show individual values" : "";
  const withN = (s: string) => `${s}${nText ? ` (${nText})` : ""}.`;
  const out: string[] = [];
  switch (N.type) {
    case "bar":
      out.push(withN(`Bars show the ${C}${pts}`));
      break;
    case "dot":
      out.push(withN(`Each circle is one value; horizontal lines and error bars show the ${C}`));
      break;
    case "box":
      out.push(withN(`Boxes span the 25th to 75th percentiles with a line at the median; whiskers extend to the minimum and maximum values${pts}`));
      break;
    default: {
      const few = groups.filter((g) => g.n < 3).length;
      if (few === groups.length) {
        // graph_plot draws no violin at all (vok = 0 for every group): only points
        out.push(withN("Circles show individual values"));
        addNote(notes, "Violins need at least 3 values per group, so none is drawn; a dot plot shows the same values with the centre and error bars.");
      } else {
        out.push(withN(`Violins show the kernel density estimate of each distribution (trimmed to the range of the data, drawn at equal width) with a line at the median${pts}`));
        if (few) out.push("Groups with fewer than 3 values are shown as individual points.");
      }
    }
  }
  if ((N.type === "bar" || N.type === "dot") && isMeanCentre(N.center) && groups.some((g) => g.n === 1)) {
    out.push("No error bar is drawn for groups with a single value.");
  }
  if (input.table.template === "grouped") {
    const rowsUsed = [...new Set(groups.map((g) => g.r as number))].sort((a, b) => a - b);
    const colsUsed = [...new Set(groups.map((g) => g.c))].sort((a, b) => a - b);
    const clusters = listOrCount(rowsUsed.map((r) => N.rowTitles[r] ?? `Row ${r + 1}`), "groups");
    const series = listOrCount(colsUsed.map((c) => N.labels[c]), "data sets");
    const noun = { bar: "bars", dot: "points", box: "boxes", violin: "violins" }[N.type as "bar"] ?? "bars";
    out.push(N.showLegend
      ? `Clusters on the X axis are ${clusters}; colours indicate ${series}.`
      : `Clusters on the X axis are ${clusters}; within each cluster the ${noun} are, from left to right, ${series}.`);
  }
  return out;
}

function shownXY(input: FigureTextInput, N: Norm, ss: Series[], nText: string, notes: string[]): string[] {
  const C = CENTER_TEXT[N.center];
  const reps = ss.some((s) => s.maxRep > 1);
  let s = N.points || !reps ? "Circles show individual values"
    : `Circles and error bars show the ${C} of the replicates at each X value`;
  const lines = ss.length > 1;
  if (N.type === "xy_line") {
    s += reps
      ? `; ${lines ? "lines connect" : "the line connects"} the ${N.center === "median_iqr" ? "medians" : "means"} at each X value`
      : `; ${lines ? "lines connect" : "the line connects"} the points in order of X`;
  }
  const out: string[] = [];
  const fits = ss.map((x) => ({ s: x, ...linearFitInfo(x.px, x.py) }));
  if (N.type === "xy_fit") {
    const withLine = fits.filter((f) => f.line);
    for (const f of fits) if (!f.line) addNote(notes, `${f.s.name}: too few points (or a single X value) for a fitted line.`);
    if (withLine.length) {
      const one = withLine.length === 1;
      // Name the fitted data sets when only some of them have a line.
      const fitFor = withLine.length < ss.length ? ` for ${joinList(withLine.map((f) => f.s.name))}` : "";
      s += one ? `; the line shows the least-squares linear regression fit${fitFor}` : `; lines show the least-squares linear regression fits${fitFor}`;
      const banded = withLine.filter((f) => f.band);
      if (N.showBand && banded.length) {
        if (banded.length < withLine.length) {
          s += banded.length === 1
            ? `; the shaded band shows the 95% confidence band for ${banded[0].s.name}`
            : `; shaded bands show the 95% confidence bands for ${joinList(banded.map((f) => f.s.name))}`;
        } else {
          s += one ? " and the shaded band its 95% confidence band" : " and shaded bands their 95% confidence bands";
        }
        if (banded.length < withLine.length) {
          addNote(notes, `No confidence band could be drawn for ${joinList(withLine.filter((f) => !f.band).map((f) => f.s.name))} (fewer than 3 points or a perfect fit).`);
        }
      }
    }
  }
  out.push(`${s}${nText ? ` (${nText})` : ""}.`);
  if (!N.points && reps && isMeanCentre(N.center) && ss.some((x) => x.minRep === 1)) {
    out.push("No error bar is drawn where there is a single value.");
  }
  if (N.type === "xy_fit" && N.showEquation) {
    const withLine = fits.filter((f) => f.line);
    if (withLine.length) {
      // graph_plot appends ", R² = …" only where linreg returned an R²
      const r2 = withLine.some((f) => f.r2);
      const which = withLine.length === 1 ? "the fit" : "each fit";
      out.push(r2 ? `The equation and R² of ${which} are printed on the graph.` : `The equation of ${which} is printed on the graph.`);
    }
  }
  if (ss.length > 1 && N.showLegend) out.push(`Colours identify the data sets (${listOrCount(ss.map((x) => x.name), "data sets")}).`);
  return out;
}

function legendStatsColumn(input: FigureTextInput, N: Norm, S: Stats): string[] {
  const out: string[] = [];
  const a = input.analysis;
  const test = S.test;
  if (!test) return out;
  if (TWO_GROUP.includes(a.test)) {
    if (!S.testP) return out;
    const c0 = S.res!.comparisons[0];
    const [na, nb] = c0 ? cmpNames(input, N, c0) : ["the first group", "the second group"];
    out.push(`${nb} was compared with ${na} by ${TWO_GROUP_LEGEND[a.test]} (${statAndP(test, N.alpha)}).`);
    return out;
  }
  if (ONE_WAY.includes(a.test)) {
    const ph = S.cmpP.length && a.posthoc !== "none" ? posthocLegend(input, N) : "";
    if (S.testP) out.push(`Groups were compared by ${ONE_WAY_LEGEND[a.test]} (${statAndP(test, N.alpha)})${ph ? ` followed by ${ph}` : ""}.`);
    else if (ph) out.push(`Groups were compared with ${ph}.`);
  }
  return out;
}

function posthocLegend(input: FigureTextInput, N: Norm): string {
  const a = input.analysis;
  let s = POSTHOC_LEGEND[a.posthoc] ?? "";
  if (!s) return "";
  if (a.posthoc === "dunnett") s += ` against ${controlName(input, N)}`;
  else if (a.posthoc === "sidak" || a.posthoc === "bonferroni" || a.posthoc === "dunn") {
    if (a.compare === "control") s += ` (each group vs. ${controlName(input, N)})`;
    else if (a.compare === "selected") s += " (selected pairs)";
  }
  return s;
}

interface TwoWayInfo {
  interaction: boolean;
  outerFactor: string;
  innerFactor: string;
  outerLevels: number;
  innerNames: string[];
  innerCount: number;
}

function twoWayInfo(input: FigureTextInput, N: Norm, S: Stats): TwoWayInfo {
  const groups = plottedGroups(input.table);
  const rows = [...new Set(groups.map((g) => g.r as number))];
  const cols = [...new Set(groups.map((g) => g.c))].sort((x, y) => x - y);
  const withinRows = input.analysis.within !== "columns";
  const tab = S.res?.anova_table ?? [];
  const outer = new Set(S.cmpP.map((c) => c.row));
  const innerIdx = withinRows ? cols : rows.sort((x, y) => x - y);
  return {
    interaction: tab.some((r) => r.source === "Interaction"),
    outerFactor: withinRows ? "row factor" : "column factor",
    innerFactor: withinRows ? "column factor" : "row factor",
    outerLevels: outer.size,
    innerNames: innerIdx.map((i) => (withinRows ? N.labels[i] : N.rowTitles[i] ?? `Row ${i + 1}`)),
    innerCount: innerIdx.length,
  };
}

/** The compared set inside each level of the outer factor (two-way). */
function twoWayInnerSet(input: FigureTextInput, N: Norm, S: Stats, W: TwoWayInfo): { subject: string; verb: string } {
  const a = input.analysis;
  if (a.compare === "control") return { subject: `each level of the ${W.innerFactor} was compared with ${controlName(input, N)}`, verb: "was" };
  if (a.compare === "selected") return { subject: `selected pairs (${pairList(input, N, S.cmpP)}) were compared`, verb: "were" };
  const names = W.innerCount <= MAX_LISTED ? joinList(W.innerNames) : `the ${W.innerCount} levels of the ${W.innerFactor}`;
  return { subject: W.innerCount === 2 ? `${names} were compared` : `all pairs of ${names} were compared`, verb: "were" };
}

function legendStatsGrouped(input: FigureTextInput, N: Norm, S: Stats): string[] {
  const out: string[] = [];
  if (!S.test || input.analysis.test !== "two_way" || !S.testP) return out;
  const tab = S.res!.anova_table ?? [];
  const resid = tab.find((r) => r.source === "Residual");
  const terms = tab.filter((r) => r.source !== "Residual" && r.source !== "Total" && isNum(r.f) && isNum(r.p))
    .map((r) => {
      const df = isNum(r.df) && resid && isNum(resid.df) ? `(${fmtDf(r.df)}, ${fmtDf(resid.df)})` : "";
      return `${r.source.toLowerCase()}, F${df} = ${fmtStat(r.f as number)}, ${fmtP(r.p as number, N.alpha)}`;
    });
  if (!terms.length) return out;
  const W = twoWayInfo(input, N, S);
  out.push(`Two-way ANOVA${W.interaction ? "" : " without interaction (one value per group)"}: ${terms.join("; ")}.`);
  if (S.cmpP.length && input.analysis.posthoc !== "none") {
    const ph = POSTHOC_LEGEND[input.analysis.posthoc];
    const set = twoWayInnerSet(input, N, S, W).subject;
    out.push(end(`Within each level of the ${W.outerFactor}, ${set} by ${ph}`));
  }
  return out;
}

function legendStatsXY(input: FigureTextInput, N: Norm, S: Stats, ss: Series[], notes: string[]): string[] {
  const out: string[] = [];
  if (!S.ok) return out;
  const res = S.res!;
  const single = ss.length <= 1;
  if (input.analysis.test === "linreg") {
    // a row has an equation exactly when it has a slope and an intercept
    const rows = (res.regression ?? []).filter((r) => isNum(r.slope) && isNum(r.intercept));
    if (rows.length && rows.length <= MAX_FIT_STATS) {
      const parts = rows.map((r) => {
        const bits = [fmtEquation(r.slope as number, r.intercept as number)];
        if (isNum(r.r2)) bits.push(fmtCoef("R²", r.r2));
        if (isNum(r.p)) bits.push(`${fmtP(r.p, N.alpha)} (slope vs. zero)`);
        return `${single && rows.length === 1 ? "" : `${N.labels[r.col] ?? clean(r.label)}: `}${bits.join(", ")}`;
      });
      out.push(`Linear regression: ${parts.join("; ")}.`);
    } else if (rows.length) {
      out.push(`Straight lines were fitted to ${rows.length} data sets by linear regression.`);
      addNote(notes, `More than ${MAX_FIT_STATS} data sets: the regression statistics are not written out; see the Results tab.`);
    }
  }
  const corr = (res.correlation ?? []).filter((c) => isNum(c.r));
  if (input.analysis.correlation !== "none" && corr.length) {
    const name = input.analysis.correlation === "spearman" ? "Spearman r" : "Pearson r";
    const regN = new Map((res.regression ?? []).map((r) => [r.col, r.n]));
    if (corr.length <= MAX_FIT_STATS) {
      const parts = corr.map((c) => {
        const bits = [fmtCoef(name, c.r as number)];
        if (isNum(c.p)) bits.push(fmtP(c.p, N.alpha));
        const rn = regN.get(c.col);
        const nNote = (rn !== undefined && rn !== c.n) || (rn === undefined && ss.some((x) => x.maxRep > 1))
          ? ` (n = ${c.n} mean values)` : "";
        return `${single && corr.length === 1 ? "" : `${N.labels[c.col] ?? clean(c.label)}: `}${bits.join(", ")}${nNote}`;
      });
      out.push(`${parts.join("; ")}.`);
    } else {
      addNote(notes, `More than ${MAX_FIT_STATS} data sets: the correlation coefficients are not written out; see the Results tab.`);
    }
  }
  return out;
}

function bracketSentences(input: FigureTextInput, N: Norm, S: Stats, notes: string[]): string[] {
  const out: string[] = [];
  if (input.table.template === "xy" || N.sigShow === "none" || !S.ok || !S.cmpP.length) return out;
  const twoGroup = TWO_GROUP.includes(input.analysis.test);
  const P = twoGroup ? "P" : "adjusted P";
  const B = bracketInfo(input);
  if (B.tooMany) {
    addNote(notes, `More than ${MAX_BRACKETS} brackets (${B.tooMany}): none are drawn on the figure, so the legend gives no bracket key.`);
    return out;
  }
  // comparisons without a P are never drawn: don't let "all" / "no comparison" cover them
  const missing = twoGroup ? [] : S.res!.comparisons.filter((c) => !isNum(c?.p_adj));
  const missingText = !missing.length ? ""
    : input.table.template === "column"
      ? `Comparisons that could not be computed (${pairList(input, N, missing)}) are not shown.`
      : `${missing.length} ${plural(missing.length, "comparison", "comparisons")} could not be computed and ${plural(missing.length, "is", "are")} not shown.`;
  if (!B.drawn.length) {
    if (N.sigShow === "significant" && !twoGroup && B.droppedNs) {
      out.push(`No comparison${missing.length ? " that could be computed" : ""} was significant (${P} > ${fmtThr(N.thr)}).`);
      if (missingText) out.push(missingText);
    }
    return out;
  }
  if (N.sigShow === "significant" && B.droppedNs) out.push("Only significant comparisons are shown.");
  if (N.sigShow === "all" && !twoGroup) out.push(missing.length ? "All comparisons that could be computed are shown." : "All comparisons are shown.");
  if (missingText) out.push(missingText);
  if (N.sigLabel === "p") {
    out.push(twoGroup ? "The bracket shows the P value." : "Brackets show multiplicity-adjusted P values.");
    return out;
  }
  const present = new Set(B.drawn.map((b) => b.label));
  const key: string[] = [];
  // _star: "*" needs P ≤ min(α, 0.05); with an α below a star's own cut-off
  // (e.g. α = 0.005) that star only appears for P ≤ α.
  const cut: [string, number][] = [["*", 0.05], ["**", 0.01], ["***", 0.001], ["****", 0.0001]];
  for (const [sym, v] of cut) if (present.has(sym)) key.push(`${sym}${P} ≤ ${fmtThr(Math.min(v, N.thr))}`);
  if (present.has("ns")) key.push(`ns, not significant (${P} > ${fmtThr(N.thr)})`);
  if (key.length) out.push(`${key.join("; ")}.`);
  return out;
}

// ── methods ─────────────────────────────────────────────────────────────────

function presentation(input: FigureTextInput, N: Norm, ss: Series[]): string {
  const C = CENTER_TEXT[N.center];
  const pts = N.points ? " with individual values overlaid" : "";
  let s: string;
  let centreShown = false, quartiles = false;
  if (N.template === "xy") {
    const reps = ss.some((x) => x.maxRep > 1);
    if (!N.points && reps) {
      s = `Data are presented as ${C} of the replicates at each X value.`;
      centreShown = true;
      quartiles = N.center === "median_iqr";
    } else {
      s = "Individual values are plotted.";
    }
  } else if (N.type === "box") {
    s = `Data are shown as box plots (median, 25th–75th percentiles, whiskers at the minimum and maximum)${pts}.`;
    quartiles = true;
  } else if (N.type === "violin") {
    // mirror graph_plot: a group with fewer than 3 values has no violin, only its points
    const groups = plottedGroups(input.table);
    const few = groups.filter((g) => g.n < 3).length;
    if (few === groups.length) {
      s = "Individual values are plotted.";
    } else {
      s = `Data are shown as violin plots (kernel density, line at the median)${pts}${few ? "; groups with fewer than 3 values are shown as individual points" : ""}.`;
    }
  } else {
    s = `Data are presented as ${C}${N.type === "bar" ? pts : " with individual values shown"}.`;
    centreShown = true;
    quartiles = N.center === "median_iqr";
  }
  if (quartiles) s += " Quartiles were calculated with the (n + 1)p method (R quantile type 6).";
  if (centreShown && N.center === "mean_ci") s += " Confidence intervals of the mean are based on the t distribution.";
  return s;
}

const EXACT_CLAUSE: Record<string, string> = {
  "exact": "the P value is exact.",
  "exact (ties handled by midranks)": "the P value is exact, from the permutation distribution of the midranks (ties present).",
};

function methodsTestColumn(input: FigureTextInput, N: Norm, S: Stats): string[] {
  const out: string[] = [];
  const a = input.analysis;
  const test = S.test!;
  const t = input.table;
  if (TWO_GROUP.includes(a.test)) {
    if (!S.testP) return out;
    const pr = testedPair(input, S);
    const pc = pr ? pairCounts(t, pr[0], pr[1]) : { pairs: 0, dropped: 0 };
    const droppedRows = pc.dropped
      ? ` ${pc.dropped} ${plural(pc.dropped, "row", "rows")} with a value in only one group ${plural(pc.dropped, "was", "were")} excluded.`
      : "";
    const method = test.method ?? "";
    switch (a.test) {
      case "unpaired_t":
        out.push("The two groups were compared with an unpaired, two-tailed Student's t test (pooled variance).");
        break;
      case "welch_t":
        out.push("The two groups were compared with an unpaired, two-tailed t test with Welch's correction for unequal variances (Welch–Satterthwaite degrees of freedom).");
        break;
      case "paired_t":
        out.push(`The two groups were compared with a paired, two-tailed t test on the within-pair differences (n = ${pc.pairs} pairs).${droppedRows}`);
        break;
      case "mann_whitney": {
        const clause = EXACT_CLAUSE[method]
          ?? (method === "normal approximation"
            ? "the P value is from the normal approximation with tie and continuity corrections (a group had more than 50 values)."
            : "");
        out.push(`The two groups were compared with a two-sided Mann–Whitney U test${clause ? `; ${clause}` : "."}`);
        break;
      }
      case "wilcoxon": {
        const clause = EXACT_CLAUSE[method]
          ?? (method === "normal approximation"
            ? "the P value is from the normal approximation with tie and continuity corrections (more than 50 non-zero differences)."
            : "");
        let s = `The two groups were compared with a two-sided Wilcoxon matched-pairs signed-rank test (W = sum of signed ranks; n = ${pc.pairs} pairs)${clause ? `; ${clause}` : "."}${droppedRows}`;
        const used = test.n;
        if (isNum(used) && used < pc.pairs) {
          const z = pc.pairs - used;
          s += ` ${z} ${plural(z, "pair", "pairs")} with a zero difference ${plural(z, "was", "were")} excluded (Wilcoxon's method; n = ${used} pairs analysed).`;
        }
        out.push(s);
        break;
      }
    }
    return out;
  }
  if (!ONE_WAY.includes(a.test)) return out;
  if (S.testP) {
    out.push({
      anova: "Groups were compared by ordinary one-way ANOVA.",
      welch_anova: "Groups were compared by Welch's one-way ANOVA, which does not assume equal variances.",
      kruskal: "Groups were compared with the Kruskal–Wallis test (tie-corrected H, χ² approximation).",
    }[a.test as "anova"]);
  }
  const ph = methodsPosthocOneWay(input, N, S);
  if (ph) out.push(...ph);
  return out;
}

function unequal(ns: number[]): boolean {
  return ns.length > 1 && Math.min(...ns) !== Math.max(...ns);
}

function methodsPosthocOneWay(input: FigureTextInput, N: Norm, S: Stats): string[] | null {
  const a = input.analysis;
  if (a.posthoc === "none" || !S.cmpP.length) return null;
  const cmps = S.res!.comparisons;
  const m = cmps.length;
  const ctrl = controlName(input, N);
  const subject = a.compare === "control" ? `Each group was compared with ${ctrl}`
    : a.compare === "selected" ? `Selected pairs of groups (${pairList(input, N, cmps)}) were compared`
      : "All pairs of groups were compared";
  const mText = `${m} ${plural(m, "comparison", "comparisons")}`;
  const ns = plottedGroups(input.table).map((g) => g.n);
  const missing = cmps.filter((c) => !isNum(c?.p_adj));
  const allPw = missing.length ? "Pairwise comparisons" : "All pairwise comparisons";
  let s: string;
  switch (a.posthoc) {
    case "tukey":
      s = `${allPw} used Tukey's test${unequal(ns) ? " (Tukey–Kramer for unequal group sizes)" : ""}`;
      break;
    case "dunnett":
      s = `Each group was compared with ${ctrl} using Dunnett's test`;
      break;
    case "sidak":
      s = `${subject} using t tests with the pooled ANOVA variance and Šídák's correction for ${mText}`;
      break;
    case "bonferroni":
      s = `${subject} using t tests with the pooled ANOVA variance and Bonferroni correction for ${mText}`;
      break;
    case "games_howell":
      s = `${allPw} used the Games–Howell test (no assumption of equal variances)`;
      break;
    case "dunn":
      s = `${subject} using Dunn's test on the mean ranks of the joint ranking (tie-corrected), with Bonferroni correction for ${mText}`;
      break;
    default:
      return null;
  }
  const out = [`${s}; multiplicity-adjusted P values are reported.`];
  if (["dunnett", "sidak", "bonferroni", "dunn"].includes(a.posthoc)) out.push("Pairwise comparisons were two-sided.");
  if (missing.length) {
    const why = clean(missing[0].note).replace(/[.]$/, "");
    out.push(`${missing.length} of ${m} comparisons (${pairList(input, N, missing)}) could not be computed${why ? ` (${why.charAt(0).toLowerCase()}${why.slice(1)})` : ""}.`);
  }
  return out;
}

function methodsTwoWay(input: FigureTextInput, N: Norm, S: Stats, notes: string[]): string[] {
  const out: string[] = [];
  if (!S.testP) return out;
  const W = twoWayInfo(input, N, S);
  const groups = plottedGroups(input.table);
  const rows = [...new Set(groups.map((g) => g.r as number))].sort((x, y) => x - y);
  const cols = [...new Set(groups.map((g) => g.c))].sort((x, y) => x - y);
  const rowNames = listOrCount(rows.map((r) => N.rowTitles[r] ?? `Row ${r + 1}`), "levels");
  const colNames = listOrCount(cols.map((c) => N.labels[c]), "levels");
  out.push(W.interaction
    ? `Data were analysed by two-way ANOVA with Type III sums of squares, with the row factor (${rowNames}), the column factor (${colNames}) and their interaction.`
    : `Data were analysed by two-way ANOVA with Type III sums of squares, with the row factor (${rowNames}) and the column factor (${colNames}), fitted without an interaction term because there is one value per group.`);
  addNote(notes, "Replace 'row factor' / 'column factor' with the names of your factors.");
  if (unequal(groups.map((g) => g.n))) addNote(notes, "Unequal group sizes: Type III sums of squares were used.");
  const a = input.analysis;
  if (a.posthoc === "none" || !S.cmpP.length) return out;
  const cmps = S.res!.comparisons;
  const set = twoWayInnerSet(input, N, S, W).subject;
  const lead = `Within each level of the ${W.outerFactor}, ${set}`;
  if (a.posthoc === "tukey") {
    const kramer = unequal(groups.map((g) => g.n)) ? " (Tukey–Kramer for unequal group sizes)" : "";
    let s = `${lead} using Tukey's test with the pooled residual variance of the ANOVA${kramer}`;
    if (a.family === "all" && W.outerLevels > 1) {
      s += `; P values were additionally Šídák-corrected across the ${W.outerLevels} levels of the ${W.outerFactor} (one family)`;
    } else if (W.outerLevels > 1) {
      s += `; each level of the ${W.outerFactor} was treated as a separate family`;
    }
    out.push(`${s}; multiplicity-adjusted P values are reported.`);
  } else if (a.posthoc === "sidak" || a.posthoc === "bonferroni") {
    const m = a.family === "all" ? cmps.length : Math.round(cmps.length / Math.max(1, W.outerLevels));
    const how = a.posthoc === "sidak" ? "Šídák's" : "Bonferroni";
    const fam = a.family === "all" ? " (all comparisons as one family)" : ` (each level of the ${W.outerFactor} as a separate family)`;
    out.push(`${lead} using t tests with the pooled residual variance and ${how} correction for ${m} ${plural(m, "comparison", "comparisons")}${fam}; multiplicity-adjusted P values are reported.`);
    out.push("Pairwise comparisons were two-sided.");
  }
  return out;
}

function methodsXY(input: FigureTextInput, N: Norm, S: Stats, ss: Series[]): string[] {
  const out: string[] = [];
  const reps = ss.some((x) => x.maxRep > 1);
  const fits = ss.map((x) => linearFitInfo(x.px, x.py));
  const banded = N.type === "xy_fit" && N.showBand ? fits.filter((f) => f.line && f.band).length : 0;
  const bandClause = !banded ? ""
    : banded === 1 ? " The 95% confidence band of the fitted line is shown." : " The 95% confidence bands of the fitted lines are shown.";
  const regs = S.ok ? S.res!.regression ?? [] : [];
  const linreg = input.analysis.test === "linreg" && regs.some((r) => isNum(r.p));
  const name = (r: AnalyzeResult["regression"][number]) => N.labels[r.col] ?? clean(r.label);
  if (linreg) {
    const fitted = regs.filter((r) => isNum(r.slope));
    const tested = regs.filter((r) => isNum(r.p));
    const subject = ss.length <= 1 ? "the data"
      : fitted.length === ss.length ? "each data set"
        : listOrCount(fitted.map(name), "data sets");
    const which = tested.length === fitted.length || ss.length <= 1 ? "" : ` for ${listOrCount(tested.map(name), "data sets")}`;
    out.push(`A straight line was fitted to ${subject} by ordinary least squares${reps ? ", treating every replicate as an individual point" : ""}; the slope was tested against zero${which} (F test, equivalent to a two-sided t test).${bandClause}`);
  } else if (N.type === "xy_fit" && fits.some((f) => f.line)) {
    const lines = fits.filter((f) => f.line).length;
    out.push(`${lines === 1 ? "The line shown is an ordinary least-squares linear fit" : "The lines shown are ordinary least-squares linear fits"}${reps ? " to every replicate" : ""}.${bandClause}`);
  }
  const corr = S.ok ? (S.res!.correlation ?? []).filter((c) => isNum(c.p)) : [];
  if (input.analysis.correlation !== "none" && corr.length) {
    let s = input.analysis.correlation === "spearman"
      ? "Spearman's rank correlation coefficient was calculated" : "Pearson's correlation coefficient was calculated";
    if (reps) s += " from the mean Y at each X value";
    if (input.analysis.correlation === "spearman") {
      const exact = corr.filter((c) => c.note === "Exact permutation P").length;
      s += exact === corr.length ? " (two-sided P, exact permutation test)."
        : exact ? " (two-sided P; exact permutation test for n ≤ 9, t approximation otherwise)."
          : " (two-sided P, t approximation).";
    } else {
      s += " (two-sided P).";
    }
    out.push(s);
  }
  return out;
}

/** The opt-in Shapiro–Wilk sentence applies to this test. The engine tests
 *  each column's raw values; a paired test assumes normal within-pair
 *  differences, which are not tested, so the sentence would mislead there. */
export function normalityApplies(template: Template, test: string): boolean {
  return template === "column" && test !== "none" && test !== "paired_t" && test !== "wilcoxon";
}

function normalitySentence(input: FigureTextInput, N: Norm, S: Stats): string {
  if (!input.options?.normality || !normalityApplies(input.table.template, input.analysis?.test) || !S.ok) return "";
  const rows = S.res!.normality ?? [];
  if (!rows.length) return "";
  const name = (c: number) => N.labels[c] ?? `Group ${c + 1}`;
  const failed = rows.filter((r) => r.passed === false).map((r) => name(r.col));
  const untested = rows.filter((r) => r.passed === null);
  const tested = rows.length - untested.length;
  let s = "Normality was assessed with the Shapiro–Wilk test (α = 0.05): ";
  if (!tested) return "";
  if (failed.length) s += `${listOrCount(failed, "groups")} departed from normality`;
  else s += untested.length ? "all testable groups were consistent with a normal distribution" : "all groups were consistent with a normal distribution";
  if (untested.length) {
    const why = [...new Set(untested.map((r) => clean(r.note)).filter(Boolean))].map((x) => x.charAt(0).toLowerCase() + x.slice(1));
    s += `; ${listOrCount(untested.map((r) => name(r.col)), "groups")} could not be tested${why.length ? ` (${why.join("; ")})` : ""}`;
  }
  return `${s}.`;
}

const VERSION_OK = /^[0-9][0-9A-Za-z.\-]*$/;

/** `what`: "tests" (a test produced a P), "fit" / "fits" (only descriptive
 *  statistics and drawn least-squares lines) or "descriptive". */
function softwareSentence(sw: Partial<SoftwareVersions> | null | undefined, theme: string, what: "tests" | "fit" | "fits" | "descriptive"): string {
  const v = (k: keyof SoftwareVersions): string => {
    const s = clean(sw?.[k] ?? "");
    return s && VERSION_OK.test(s) ? s : "";
  };
  const lead = what === "tests" ? "Statistical analysis was performed with"
    : what === "fit" ? "Descriptive statistics and the linear fit were calculated with"
      : what === "fits" ? "Descriptive statistics and the linear fits were calculated with"
      : "Descriptive statistics were calculated with";
  let s = `${lead} Lab Analysis Suite${v("app") ? ` ${v("app")}` : ""}`;
  const py = [v("python") && `Python ${v("python")}`, v("scipy") && `SciPy ${v("scipy")}`, v("numpy") && `NumPy ${v("numpy")}`]
    .filter(Boolean);
  if (py.length) s += ` (${py.join(", ")})`;
  s += `; graphs were drawn in R${v("r") ? ` ${v("r")}` : ""} with ggplot2${v("ggplot2") ? ` ${v("ggplot2")}` : ""}`;
  if (theme === "prism" && v("ggprism")) s += ` and ggprism ${v("ggprism")}`;
  return `${s}.`;
}

// ── entry ───────────────────────────────────────────────────────────────────

function addNote(notes: string[], s: string) {
  const t = s.trim();
  if (t && !notes.includes(t)) notes.push(t);
}

function build(input: FigureTextInput): FigureText {
  const notes: string[] = [];
  const t = input.table;
  if (!t || !hasAnyValue(t)) return { legend: "", methods: "", notes: ["Enter data to generate the text."] };
  const N = normalise(input);
  const S = stats(input);
  const f = input.figure;
  const a = input.analysis;
  const ss = t.template === "xy" ? xySeries(t, N) : [];
  if (t.template === "xy" && !ss.length) {
    return { legend: "", methods: "", notes: ["Enter X values with Y values to generate the text."] };
  }

  // notes about the result itself
  if (!input.result) addNote(notes, "Statistics are not available yet.");
  else if (input.result.error) addNote(notes, `The selected test could not be run: ${clean(input.result.error)}`);
  else if (!S.ok) addNote(notes, "Statistics are not available yet.");
  const why = (note: string | null | undefined) => {
    const x = clean(note).replace(/[.]$/, "");
    return x ? ` (${x.charAt(0).toLowerCase()}${x.slice(1)})` : "";
  };
  if (S.ok && S.test && !S.testP) addNote(notes, `${clean(S.test.label)} could not be computed${why(S.test.note)}.`);
  if (S.ok && S.res!.comparisons.length) {
    const bad = S.res!.comparisons.filter((c) => !isNum(c.p_adj));
    if (bad.length && (S.testP || S.cmpP.length)) {
      const m = S.res!.comparisons.length;
      addNote(notes, `${bad.length} of ${m} ${plural(m, "comparison", "comparisons")} could not be computed${why(bad[0].note)}; they are not drawn.`);
    }
  }
  if (S.ok && t.template === "xy") {
    for (const r of S.res!.regression ?? []) {
      if (!isNum(r.p) && r.note) addNote(notes, `${N.labels[r.col] ?? clean(r.label)}: no regression P${why(r.note)}.`);
    }
    if (a.correlation !== "none") {
      for (const c of S.res!.correlation ?? []) {
        if (!isNum(c.p) && c.note) addNote(notes, `${N.labels[c.col] ?? clean(c.label)}: no correlation${why(c.note)}.`);
      }
    }
  }

  // ── legend
  const legend: string[] = [];
  const Y = yName(N, f, notes);
  // A graph title leads the legend; the descriptive sentence still follows so
  // the legend always names the measured variable and the groups.
  const title = clean(f?.title);
  if (title) legend.push(end(title));
  if (t.template === "xy") {
    const X = clean(f?.xlabel) || clean(t.x_title) || "X";
    legend.push(end(`${Y} as a function of ${X}${ss.length > 1 ? ` for ${listOrCount(ss.map((s) => s.name), "data sets")}` : ""}`));
  } else {
    const groups = plottedGroups(t);
    if (t.template === "column") {
      legend.push(end(`${Y} for ${listOrCount(groups.map((g) => N.labels[g.c]), "groups")}`));
    } else {
      const cols = [...new Set(groups.map((g) => g.c))].sort((x, y) => x - y);
      const rows = [...new Set(groups.map((g) => g.r as number))].sort((x, y) => x - y);
      legend.push(end(`${Y} for ${listOrCount(cols.map((c) => N.labels[c]), "data sets")} across ${listOrCount(rows.map((r) => N.rowTitles[r] ?? `Row ${r + 1}`), "groups")}`));
    }
  }
  const nText = describeN(input).text;
  if (t.template === "xy") legend.push(...shownXY(input, N, ss, nText, notes));
  else legend.push(...shownColumn(input, N, nText, notes));
  if (S.ok) {
    if (t.template === "column") legend.push(...legendStatsColumn(input, N, S));
    else if (t.template === "grouped") legend.push(...legendStatsGrouped(input, N, S));
    else legend.push(...legendStatsXY(input, N, S, ss, notes));
    legend.push(...bracketSentences(input, N, S, notes));
  }

  // ── methods
  const methods: string[] = [presentation(input, N, ss)];
  let tested = false, adjusted = false;
  if (t.template === "xy") {
    // the plot fits its own line whatever the result, so this runs without one too
    methods.push(...methodsXY(input, N, S, ss));
    if (S.ok) {
      tested = (a.test === "linreg" && (S.res!.regression ?? []).some((r) => isNum(r.p)))
        || (a.correlation !== "none" && (S.res!.correlation ?? []).some((c) => isNum(c.p)));
      if (a.test === "none" && a.correlation === "none") methods.push("No statistical test was performed.");
    }
  } else if (S.ok) {
    if (a.test === "none") {
      methods.push("No statistical test was performed.");
    } else if (t.template === "column") {
      methods.push(...methodsTestColumn(input, N, S));
      tested = S.testP || S.cmpP.length > 0;
      adjusted = !TWO_GROUP.includes(a.test) && a.posthoc !== "none" && S.cmpP.length > 0;
      // the normality sentence accompanies a computed test only
      const norm = tested ? normalitySentence(input, N, S) : "";
      if (norm) methods.push(norm);
      else if (input.options?.normality && normalityApplies(t.template, a.test) && !tested) {
        addNote(notes, "The normality test is mentioned only alongside a computed test.");
      }
    } else {
      methods.push(...methodsTwoWay(input, N, S, notes));
      tested = S.testP;
      adjusted = a.posthoc !== "none" && S.cmpP.length > 0;
    }
  }
  if (tested) methods.push(`${adjusted ? "Adjusted P" : "P"} ≤ ${fmtThr(N.thr)} was considered statistically significant.`);
  const linesDrawn = t.template === "xy" && N.type === "xy_fit" ? ss.filter((s) => linearFitInfo(s.px, s.py).line).length : 0;
  methods.push(softwareSentence(input.software, N.theme, tested ? "tests" : linesDrawn > 1 ? "fits" : linesDrawn ? "fit" : "descriptive"));

  // ── notes (the engine's warnings explain e.g. why a post-hoc test has no rows)
  for (const w of arr(input.result?.warnings)) addNote(notes, clean(w));
  addNote(notes, "State what n represents (e.g. animals, independent experiments, technical replicates).");
  if (!input.software) addNote(notes, "Software versions are not available yet.");
  addNote(notes, "Cite R and ggplot2 as your journal requires.");

  return {
    legend: legend.filter(Boolean).join(" ").replace(/\s+/g, " ").trim(),
    methods: methods.filter(Boolean).join(" ").replace(/\s+/g, " ").trim(),
    notes,
  };
}

/** Figure legend + statistical methods for the current graph. Never throws. */
export function buildFigureText(input: FigureTextInput): FigureText {
  try {
    return build(input);
  } catch (e) {
    return { legend: "", methods: "", notes: [`The text could not be generated (${e instanceof Error ? e.message : String(e)}).`] };
  }
}
