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
  options?: {
    normality?: boolean;
    /** Figure label ("Fig. 1", "Extended Data Fig. 2"); undefined / "" = no label. */
    figLabel?: string;
    /** What one plotted value is, singular ("independent cell culture", "mouse"); "" = not stated. */
    unit?: string;
  };
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
const MAX_P_LISTED = 10;      // comparisons whose P values are listed one by one in the legend
const MAX_MISSING_LISTED = 6; // uncomputed comparisons named one by one
/** Nature: fewer than 250 words (initial submission), fewer than 300 (formatting guide). */
export const LEGEND_WORDS_SOFT = 250;
export const LEGEND_WORDS_HARD = 300;
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

/** A bare P value: "0.023" | "0.42" | "0.0031" | "<0.0001" | ">0.99".
 *  2 significant figures, at least 2 decimals. A value that would round onto
 *  a significance cut-off it isn't equal to gets more decimals, so the text
 *  never contradicts the stars (0.0496 -> "0.0496", not "0.050"). */
export function fmtPValue(p: number, alpha = 0.05): string {
  if (!isNum(p)) return "";
  if (p < 0.0001) return "<0.0001";
  const e = Math.floor(Math.log10(p));
  let d = Math.max(2, 1 - e);
  let s = p.toFixed(d);
  if (Number(s) >= 1) return ">0.99";
  // rounding up into the next decade: 0.0996 -> "0.10", not "0.100"
  if (d > 2 && Number(s) >= Math.pow(10, e + 1)) {
    d--;
    s = p.toFixed(d);
  }
  const cuts = [0.05, 0.01, 0.001, 0.0001, alpha];
  while (d < 10 && cuts.some((c) => Number(s) === c && p !== c)) {
    d++;
    s = p.toFixed(d);
  }
  return s;
}

/** "P = 0.016" | "P < 0.0001" | "P > 0.99" | "P not available". */
export function fmtP(p: number, alpha = 0.05): string {
  if (!isNum(p)) return "P not available";
  const s = fmtPValue(p, alpha);
  return s[0] === "<" || s[0] === ">" ? `P ${s[0]} ${s.slice(1)}` : `P = ${s}`;
}

/** Words as a journal counts them: whitespace-separated tokens holding a
 *  letter or a digit (the "|" after the figure label is not a word). */
export function countWords(s: string): number {
  return (s ?? "").split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
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

// ── the unit of n ("Each value is one…") ────────────────────────────────────

const INVARIANT = new Set(["fish", "sheep", "deer", "species", "series", "offspring", "progeny", "cattle"]);
const IRREGULAR: Record<string, string> = {
  mouse: "mice", louse: "lice", child: "children", person: "people", man: "men", woman: "women", human: "humans",
  leaf: "leaves", half: "halves", calf: "calves", wolf: "wolves", life: "lives", knife: "knives", tooth: "teeth",
  foot: "feet", goose: "geese", ox: "oxen", bacterium: "bacteria", mitochondrion: "mitochondria", nucleus: "nuclei",
  locus: "loci", focus: "foci", fungus: "fungi", embryo: "embryos", larva: "larvae", pupa: "pupae", alga: "algae",
  ovum: "ova", medium: "media", analysis: "analyses", biopsy: "biopsies", matrix: "matrices", index: "indices",
  axis: "axes", hypothesis: "hypotheses", synapse: "synapses", virus: "viruses", lens: "lenses",
  // Latin / Greek forms used for biological units
  glomerulus: "glomeruli", stimulus: "stimuli", villus: "villi", bronchus: "bronchi", alveolus: "alveoli",
  nucleolus: "nucleoli", bacillus: "bacilli", hippocampus: "hippocampi", thalamus: "thalami", radius: "radii",
  uterus: "uteri", ganglion: "ganglia", criterion: "criteria", phenomenon: "phenomena", spectrum: "spectra",
  stratum: "strata", datum: "data", vertebra: "vertebrae", fibula: "fibulae", trachea: "tracheae",
  // singular nouns ending in -s / -is / -o / -z with irregular -es plurals
  pancreas: "pancreases", gas: "gases", atlas: "atlases", canvas: "canvases", bias: "biases", iris: "irises",
  potato: "potatoes", tomato: "tomatoes", quiz: "quizzes",
};
const IRREGULAR_PLURALS = new Set(Object.values(IRREGULAR).filter((v) => !v.endsWith("s")));

const isAcronym = (w: string) => /^[A-Z0-9]{2,}$/.test(w) && /[A-Z]/.test(w);

/** The plural of one English noun: mouse -> mice, culture -> cultures,
 *  biopsy -> biopsies, batch -> batches, fish -> fish, PDX -> PDXs,
 *  co-culture -> co-cultures. The stem's capitalisation is kept. */
export function pluraliseWord(w: string): string {
  if (!w) return w;
  const dash = w.lastIndexOf("-");
  if (dash > 0 && dash < w.length - 1) return w.slice(0, dash + 1) + pluraliseWord(w.slice(dash + 1));
  if (isAcronym(w)) return `${w}s`;
  const l = w.toLowerCase();
  if (INVARIANT.has(l) || l.endsWith("fish")) return w;
  const irr = IRREGULAR[l];
  if (irr) {
    if (w === w.toUpperCase() && /[A-Z]/.test(w)) return irr.toUpperCase();
    return w[0] !== l[0] ? irr[0].toUpperCase() + irr.slice(1) : irr;
  }
  if (/is$/.test(l)) return `${w.slice(0, -2)}es`;
  if (/(s|x|z|ch|sh)$/.test(l)) return `${w}es`;
  if (/[^aeiou]y$/.test(l)) return `${w.slice(0, -1)}ies`;
  return `${w}s`;
}

export interface UnitInfo {
  /** "an independent cell culture" */
  phrase: string;
  /** Head noun, singular / plural: "culture" / "cultures". */
  one: string;
  many: string;
  /** The user typed a plural ("mice"): the text is still generated, with a note. */
  pluralInput: boolean;
}

// ", " (not a bare comma) so a thousands separator ("1,800-cell cluster") isn't a cut
const HEAD_CUT = [" of ", " from ", " in ", " per ", " with ", " at ", " on ", " for ", " derived ", " taken ", " isolated ", " obtained ", "(", ", "];

/** "an" (not "a") before this phrase, by its sound: an RNA sample, an X-ray
 *  image, a UV-treated culture, an 8-week-old mouse, an 18-month-old mouse,
 *  a unique donor, an uninfected mouse, a urine sample, an hour, a ewe. */
function needsAn(u: string): boolean {
  const num = /^(\d[\d,]*)/.exec(u);
  if (num) {
    // spoken "eight…", "eleven…", "eighteen…" (8, 80–89, 800…, 11, 18, 11 000, 18 000)
    const d = num[1].replace(/,/g, "");
    if (d[0] === "8") return true;
    const lead = d.slice(0, d.length % 3 || 3);
    return lead === "11" || lead === "18";
  }
  // a letter-by-letter acronym, also before a hyphen ("LC-MS run", "X-ray image")
  const first = u.split(/[\s\-/]/)[0];
  if (isAcronym(first) || /^[A-Z]$/.test(first)) return /^[AEFHILMNORSX]/.test(first);
  if (/^(hour|honest|honou?r|heir)/i.test(u)) return true;
  // "you"-sounding u / eu / ew and "w"-sounding one: a unit, a ewe, a one-day-old pup;
  // the negating un- keeps "an" (an uninfected / unimmunised / unirradiated / unidentified mouse)
  if (/^un(in(?!uc)|im[mp]|irr|iden)/i.test(u)) return true;
  if (/^(uni|use|usa|usu|ut(?!t)|ur[aeiou]|ubi|eu|ew|one(?![a-z])|once)/i.test(u)) return false;
  return /^[aeiou]/i.test(u);
}

/** Parse "Each value is one…" (singular noun phrase) for the legend. */
export function unitInfo(raw: unknown): UnitInfo | null {
  // a saved document can hold anything: only text is a unit
  let u = (typeof raw === "string" ? clean(raw) : "").slice(0, 80);
  u = u.replace(/^(a|an|one|each|the|per)\s+/i, "").replace(/[.;,:\s]+$/, "").trim();
  if (!u || !/[\p{L}\p{N}]/u.test(u)) return null;
  const low = u.toLowerCase();
  let cut = u.length;
  for (const c of HEAD_CUT) {
    const i = low.indexOf(c);
    if (i > 0 && i < cut) cut = i;
  }
  const headPhrase = u.slice(0, cut).trim() || u;
  const head = (headPhrase.split(" ").pop() ?? headPhrase).replace(/[^\p{L}\p{N}-]+$/u, "") || headPhrase;
  const hl = head.toLowerCase();
  const pluralInput = IRREGULAR_PLURALS.has(hl) || (/s$/.test(hl) && !/(ss|us|is)$/.test(hl) && !isAcronym(head)
    && !INVARIANT.has(hl) && !IRREGULAR[hl]);
  const an = needsAn(u);
  return {
    phrase: `${an ? "an" : "a"} ${u}`,
    one: head,
    many: pluralInput ? head : pluraliseWord(head),
    pluralInput,
  };
}

/** The figure label as typed ("Fig. 1"), tidied; "" = none. */
function figLabel(raw: unknown): string {
  return (typeof raw === "string" ? clean(raw) : "").replace(/[\s|:]+$/, "").slice(0, 60).trim();
}

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

/** The "n = …" text of the legend, with the range of group sizes. With a
 *  unit (unitInfo) every count carries its noun: "n = 6 cultures per group". */
export function describeN(input: FigureTextInput, U?: UnitInfo | null): {
  text: string; equal: boolean; min: number; max: number; paired?: boolean;
} {
  const t = input.table;
  const N = normalise(input);
  const noun = (count: number) => (U ? ` ${count === 1 ? U.one : U.many}` : "");
  if (t.template === "xy") {
    const ss = xySeries(t, N);
    if (!ss.length) return { text: "", equal: true, min: 0, max: 0 };
    const maxRep = Math.max(...ss.map((s) => s.maxRep));
    if (maxRep <= 1) {
      const pts = ss.map((s) => s.px.length);
      const lo = Math.min(...pts), hi = Math.max(...pts);
      const per = ss.length > 1 ? " per data set" : "";
      const what = U ? noun(hi) : ` ${plural(hi, "point", "points")}`;
      return { text: `n = ${rangeText(lo, hi)}${what}${per}`, equal: lo === hi, min: lo, max: hi };
    }
    const rLo = Math.min(...ss.map((s) => s.minRep)), rHi = maxRep;
    const xLo = Math.min(...ss.map((s) => s.cells)), xHi = Math.max(...ss.map((s) => s.cells));
    const reps = U ? noun(rHi) : " replicates";
    return {
      text: xHi === 1 ? `n = ${rangeText(rLo, rHi)}${reps} at a single X value`
        : `n = ${rangeText(rLo, rHi)}${reps} at each of ${rangeText(xLo, xHi)} X values`,
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
      // the unit of n is the pair, whatever one value is
      if (!dropped && groups.length === 2) return { text: `n = ${pairs} pairs`, equal: true, min: pairs, max: pairs, paired: true };
    }
  }
  if (lo === hi) {
    return { text: groups.length > 1 ? `n = ${lo}${noun(lo)} per group` : `n = ${lo}${noun(lo)}`, equal: true, min: lo, max: hi };
  }
  if (t.template === "column" && groups.length <= MAX_NAMED_N) {
    // "Control, n = 10; Treatment, n = 9": no nested parentheses inside the legend's "(…)"
    const parts = groups.map((g) => `${N.labels[g.c]}, n = ${g.n}${noun(g.n)}`);
    return { text: parts.join("; "), equal: false, min: lo, max: hi };
  }
  return { text: `n = ${lo}–${hi}${noun(hi)} per group`, equal: false, min: lo, max: hi };
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

/** Two-group tests, named for the legend (every one is two-sided). */
const TWO_GROUP_LEGEND: Record<string, string> = {
  unpaired_t: "a two-sided unpaired Student's t test",
  welch_t: "a two-sided unpaired Welch's t test",
  paired_t: "a two-sided paired t test",
  mann_whitney: "a two-sided Mann–Whitney U test",
  wilcoxon: "a two-sided Wilcoxon matched-pairs signed-rank test",
};

const ONE_WAY_LEGEND: Record<string, string> = {
  anova: "one-way ANOVA",
  welch_anova: "Welch's ANOVA",
  kruskal: "the Kruskal–Wallis test",
};

/** Post-hoc tests, named for the legend. All are two-sided: Tukey / Games–
 *  Howell use |difference|, the others 2·sf(|t|) or the two-sided Dunnett distribution. */
const POSTHOC_LEGEND: Record<string, string> = {
  tukey: "a two-sided Tukey's multiple-comparisons test",
  dunnett: "a two-sided Dunnett's multiple-comparisons test",
  sidak: "a two-sided Šídák's multiple-comparisons test",
  bonferroni: "a two-sided Bonferroni multiple-comparisons test",
  dunn: "a two-sided Dunn's multiple-comparisons test with Bonferroni correction",
  games_howell: "a two-sided Games–Howell multiple-comparisons test",
};

/** One-way post-hoc with a single, unadjusted comparison: name the test that
 *  was actually performed (matches the methods text), not a "multiple-comparisons test". */
const POSTHOC_SINGLE_LEGEND: Record<string, string> = {
  tukey: "a two-sided Tukey's test",
  dunnett: "a two-sided Dunnett's test",
  sidak: "a two-sided t test with the pooled ANOVA variance",
  bonferroni: "a two-sided t test with the pooled ANOVA variance",
  dunn: "a two-sided Dunn's test",
  games_howell: "a two-sided Games–Howell test",
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

/** Two-way ANOVA terms: "interaction, F(2, 12) = 47.14, P < 0.0001; row factor, …". */
function twoWayTerms(S: Stats, alpha: number): string[] {
  const tab = S.res?.anova_table ?? [];
  const resid = tab.find((r) => r.source === "Residual");
  return tab.filter((r) => r.source !== "Residual" && r.source !== "Total" && isNum(r.f) && isNum(r.p))
    .map((r) => {
      const df = isNum(r.df) && resid && isNum(resid.df) ? `(${fmtDf(r.df)}, ${fmtDf(resid.df)})` : "";
      return `${r.source.toLowerCase()}, F${df} = ${fmtStat(r.f as number)}, ${fmtP(r.p as number, alpha)}`;
    });
}

/** Names of the two sides of a comparison (labels as the reader sees them). */
function cmpNames(input: FigureTextInput, N: Norm, c: Comparison): [string, string] {
  const inner = input.table.template === "grouped" && input.analysis.within === "columns" ? N.rowTitles : N.labels;
  return [inner[c.a] ?? `Group ${c.a + 1}`, inner[c.b] ?? `Group ${c.b + 1}`];
}

/** "A versus B" (legend): the control / lower index first, as the user's example. */
function versus(input: FigureTextInput, N: Norm, c: Comparison): string {
  const [a, b] = cmpNames(input, N, c);
  return `${a} versus ${b}`;
}

/** The level of the outer factor a two-way comparison belongs to. */
function outerName(input: FigureTextInput, N: Norm, c: Comparison): string {
  const r = c.row ?? -1;
  if (input.analysis.within === "columns") return N.labels[r] ?? `Column ${r + 1}`;
  return N.rowTitles[r] ?? `Row ${r + 1}`;
}

/** Distinct compared pairs: methods "B vs. A; …" (grouped: across rows /
 *  columns), legend "A versus B, C versus D and …". */
function pairList(input: FigureTextInput, N: Norm, cmps: Comparison[], style: "methods" | "legend" = "methods"): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of cmps) {
    const key = `${c.a},${c.b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const [a, b] = cmpNames(input, N, c);
    out.push(style === "legend" ? `${a} versus ${b}` : `${b} vs. ${a}`);
  }
  if (out.length > MAX_PAIRS_LISTED) return `${out.length} pairs`;
  return style === "legend" ? joinList(out) : out.join("; ");
}

function controlName(input: FigureTextInput, N: Norm): string {
  const i = input.analysis.control ?? 0;
  const inner = input.table.template === "grouped" && input.analysis.within === "columns" ? N.rowTitles : N.labels;
  return inner[i] ?? `Group ${i + 1}`;
}

// ── legend ──────────────────────────────────────────────────────────────────

/** Plural words for the centre and the error bars ("means", "standard deviations"). */
const CENTRE_PLURAL: Record<CenterId, [string, string]> = {
  mean_sd: ["means", "standard deviations"],
  mean_sem: ["means", "standard errors of the mean"],
  mean_ci: ["means", "95% confidence intervals"],
  median_iqr: ["medians", "interquartile ranges"],
};

const BOX_TEXT = "Boxes span the 25th to 75th percentiles with a line at the median; whiskers extend to the minimum and maximum values";
const VIOLIN_TEXT = "Violins show the kernel density estimate of each distribution (trimmed to the range of the data, drawn at equal width) with a line at the median";

/** "Each dot represents an independent cell culture" / "… one value". */
const symbolText = (U: UnitInfo | null) => `Each dot represents ${U ? U.phrase : "one value"}`;

/** A sentence with its n clause: "… (n = 6 per group)." A sentence that
 *  already ends in a parenthesis (unit "technical replicate (well)") takes it
 *  after a semicolon instead, never ") (": "…(well); n = 10 replicates per group." */
function withNClause(s: string, nText: string): string {
  if (!nText) return `${s}.`;
  if (!/\)$/.test(s)) return `${s} (${nText}).`;
  // per-group lists already hold semicolons ("A, n = 8; B, n = 6")
  return nText.includes(";") ? `${s}. Group sizes: ${nText}.` : `${s}; ${nText}.`;
}

function shownColumn(input: FigureTextInput, N: Norm, nText: string, U: UnitInfo | null, notes: string[]): string[] {
  const groups = plottedGroups(input.table);
  const [centres, errors] = CENTRE_PLURAL[N.center];
  const withN = (s: string) => withNClause(s, nText);
  const SYM = symbolText(U);
  const out: string[] = [];
  // the n clause goes with the dots when they are drawn, else with the summary symbols
  const summary = (s: string) => {
    if (N.points) out.push(withN(SYM), `${s}.`);
    else out.push(withN(s));
  };
  switch (N.type) {
    case "bar":
      summary(`Bar heights indicate ${centres}; error bars indicate ${errors}`);
      break;
    case "dot":
      out.push(withN(SYM), `Horizontal lines indicate ${centres}; error bars indicate ${errors}.`);
      break;
    case "box":
      summary(BOX_TEXT);
      break;
    default: {
      const few = groups.filter((g) => g.n < 3).length;
      if (few === groups.length) {
        // graph_plot draws no violin at all (vok = 0 for every group): only points
        out.push(withN(SYM));
        addNote(notes, "Violins need at least 3 values per group, so none is drawn; a dot plot shows the same values with the centre and error bars.");
      } else {
        summary(VIOLIN_TEXT);
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
    const noun = { bar: "bars", dot: "dots", box: "boxes", violin: "violins" }[N.type as "bar"] ?? "bars";
    out.push(N.showLegend
      ? `Clusters on the X axis are ${clusters}; colours indicate ${series}.`
      : `Clusters on the X axis are ${clusters}; within each cluster the ${noun} are, from left to right, ${series}.`);
  }
  return out;
}

function shownXY(input: FigureTextInput, N: Norm, ss: Series[], nText: string, U: UnitInfo | null, notes: string[]): string[] {
  const [centres, errors] = CENTRE_PLURAL[N.center];
  const reps = ss.some((s) => s.maxRep > 1);
  const first = N.points || !reps ? symbolText(U)
    : `Dots indicate ${centres} of the replicates at each X value; error bars indicate ${errors}`;
  const lines = ss.length > 1;
  // what the lines / bands are: one sentence after the symbols
  let rest = "";
  if (N.type === "xy_line") {
    rest += reps
      ? `; ${lines ? "lines connect" : "the line connects"} the ${centres} at each X value`
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
      rest += one ? `; the line shows the least-squares linear regression fit${fitFor}` : `; lines show the least-squares linear regression fits${fitFor}`;
      const banded = withLine.filter((f) => f.band);
      if (N.showBand && banded.length) {
        if (banded.length < withLine.length) {
          rest += banded.length === 1
            ? `; the shaded band shows the 95% confidence band for ${banded[0].s.name}`
            : `; shaded bands show the 95% confidence bands for ${joinList(banded.map((f) => f.s.name))}`;
        } else {
          rest += one ? " and the shaded band its 95% confidence band" : " and shaded bands their 95% confidence bands";
        }
        if (banded.length < withLine.length) {
          addNote(notes, `No confidence band could be drawn for ${joinList(withLine.filter((f) => !f.band).map((f) => f.s.name))} (fewer than 3 points or a perfect fit).`);
        }
      }
    }
  }
  out.push(withNClause(first, nText));
  rest = rest.replace(/^; /, "");
  if (rest) out.push(`${rest.charAt(0).toUpperCase()}${rest.slice(1)}.`);
  if (!N.points && reps && ss.some((x) => x.minRep === 1)) {
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

/** A post-hoc test produced at least one P and so replaces the omnibus test in the legend. */
const posthocRan = (input: FigureTextInput, S: Stats) =>
  input.analysis.posthoc !== "none" && !!POSTHOC_LEGEND[input.analysis.posthoc] && S.cmpP.length > 0;

/** The post-hoc P values are really adjusted for multiplicity (mirrors
 *  graph_stats). A family of one comparison leaves P unchanged: Šídák /
 *  Bonferroni / Dunn / Dunnett with one comparison, Tukey / Games–Howell with
 *  two groups (the studentized range for k = 2 is the t test), and two-way
 *  per-row (per-column) families holding one pair. */
function pAdjusted(input: FigureTextInput, S: Stats): boolean {
  const a = input.analysis;
  if (!S.res || TWO_GROUP.includes(a.test) || a.posthoc === "none") return false;
  const cmps = S.res.comparisons;
  const groups = plottedGroups(input.table);
  if (input.table.template === "grouped") {
    const withinRows = a.within !== "columns";
    const outer = new Set(groups.map((g) => (withinRows ? g.r : g.c))).size;
    const inner = new Set(groups.map((g) => (withinRows ? g.c : g.r))).size;
    const nFam = a.family === "per_row" ? 1 : outer;
    if (a.posthoc === "tukey") return inner > 2 || nFam > 1;
    const pairs = new Set(cmps.map((c) => `${c.a},${c.b}`)).size;
    return pairs * nFam > 1;
  }
  if (a.posthoc === "tukey" || a.posthoc === "games_howell") return groups.length > 2;
  return cmps.length > 1;
}

/** "multiplicity-adjusted P" or plain "P" (a family of one comparison). */
const adjP = (adj: boolean) => (adj ? "multiplicity-adjusted P" : "P");
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function legendStatsColumn(input: FigureTextInput, N: Norm, S: Stats, notes: string[]): string[] {
  const out: string[] = [];
  const a = input.analysis;
  const test = S.test;
  if (!test) return out;
  if (TWO_GROUP.includes(a.test)) {
    if (!S.testP) return out;
    const c0 = S.res!.comparisons[0];
    const who = c0 ? (([x, y]) => `${x} and ${y}`)(cmpNames(input, N, c0)) : "The two groups";
    let pairsText = "";
    if (a.test === "paired_t" || a.test === "wilcoxon") {
      // the legend's n counts plotted values unless every plotted value is in a pair:
      // say how many pairs the P comes from
      const pr = testedPair(input, S);
      const pc = pr ? pairCounts(input.table, pr[0], pr[1]) : null;
      if (pc && !describeN(input).paired) {
        pairsText = `; n = ${pc.pairs} ${plural(pc.pairs, "pair", "pairs")}`;
        if (pc.dropped) pairsText += `, ${pc.dropped} unpaired ${plural(pc.dropped, "value", "values")} not analysed`;
      }
    }
    out.push(`${who} were compared using ${TWO_GROUP_LEGEND[a.test]} (${statAndP(test, N.alpha)}${pairsText}).`);
    return out;
  }
  if (!ONE_WAY.includes(a.test)) return out;
  if (posthocRan(input, S)) {
    const PH = POSTHOC_LEGEND[a.posthoc];
    const cmps = S.res!.comparisons;
    if (cmps.length === 1) {
      const [x, y] = cmpNames(input, N, cmps[0]);
      const P = fmtP(cmps[0].p_adj as number, N.alpha);
      out.push(pAdjusted(input, S)
        ? `${x} and ${y} were compared using ${PH} (multiplicity-adjusted ${P}).`
        : `${x} and ${y} were compared using ${POSTHOC_SINGLE_LEGEND[a.posthoc] ?? PH} (${P}; a single comparison, so not adjusted for multiplicity).`);
    } else {
      const scheme = a.compare === "control" || a.posthoc === "dunnett" ? `Comparisons with group ${controlName(input, N)}`
        : a.compare === "selected" ? "Selected pairwise comparisons" : "All pairwise comparisons";
      out.push(`${scheme} were performed using ${PH}.`);
      out.push(...pValueSentences(input, N, S, notes));
    }
    if (S.testP) addNote(notes, "The omnibus test result is in the methods text, not the legend; quote it in your Results as your journal requires.");
    return out;
  }
  if (S.testP) out.push(`Groups were compared using ${ONE_WAY_LEGEND[a.test]} (${statAndP(test, N.alpha)}).`);
  return out;
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
function twoWayInnerSet(input: FigureTextInput, N: Norm, S: Stats, W: TwoWayInfo, style: "methods" | "legend" = "methods"): string {
  const a = input.analysis;
  if (a.compare === "control") return `each level of the ${W.innerFactor} was compared with ${controlName(input, N)}`;
  if (a.compare === "selected") return `selected pairs (${pairList(input, N, S.cmpP, style)}) were compared`;
  const names = W.innerCount <= MAX_LISTED ? joinList(W.innerNames) : `the ${W.innerCount} levels of the ${W.innerFactor}`;
  return W.innerCount === 2 ? `${names} were compared` : `all pairs of ${names} were compared`;
}

function legendStatsGrouped(input: FigureTextInput, N: Norm, S: Stats, notes: string[]): string[] {
  const out: string[] = [];
  const a = input.analysis;
  if (!S.test || a.test !== "two_way" || !S.testP) return out;
  const W = twoWayInfo(input, N, S);
  if (posthocRan(input, S)) {
    let family = "";
    if (W.outerLevels > 1) {
      const m = S.res!.comparisons.length;
      if (a.family === "per_row") family = `, treating each level of the ${W.outerFactor} as a separate family`;
      else if (a.posthoc === "tukey") family = `, with Šídák correction across the ${W.outerLevels} levels of the ${W.outerFactor}`;
      else if (a.posthoc === "sidak" || a.posthoc === "bonferroni") family = m === 2 ? ", with both comparisons as one family" : `, with all ${m} comparisons as one family`;
    }
    if (!pAdjusted(input, S)) {
      // e.g. two columns, each row its own family: the P values are those of single t tests
      family += family ? "; with one comparison per family, P values are not adjusted for multiplicity"
        : "; with a single comparison per level, P values are not adjusted for multiplicity";
      const lvl = a.within === "columns" ? "column" : "row";
      addNote(notes, `Each ${lvl} is its own family with a single comparison, so its P value is not corrected for multiplicity. To correct across ${lvl}s, set “Correct for multiple comparisons across” to “All comparisons (one family)”.`);
    }
    // unadjusted (one comparison per family): these are t tests on the pooled residual variance, as the methods say
    const how = pAdjusted(input, S) ? POSTHOC_LEGEND[a.posthoc] : "two-sided t tests with the pooled residual variance of the ANOVA";
    out.push(`Within each level of the ${W.outerFactor}, ${twoWayInnerSet(input, N, S, W, "legend")} using ${how}${family}.`);
    out.push(...pValueSentences(input, N, S, notes));
    addNote(notes, "Replace 'row factor' / 'column factor' with the names of your factors.");
    if (twoWayTerms(S, N.alpha).length) {
      addNote(notes, "The omnibus test result is in the methods text, not the legend; quote it in your Results as your journal requires.");
    }
    return out;
  }
  const terms = twoWayTerms(S, N.alpha);
  if (!terms.length) return out;
  out.push(`Two-way ANOVA${W.interaction ? "" : " without interaction (one value per group)"}: ${terms.join("; ")}.`);
  return out;
}

/** The P value of every computed comparison (multi-comparison post-hoc
 *  tests), in result order; above MAX_P_LISTED a truthful, numerically
 *  checked summary instead. Comparisons without a P are named. */
function pValueSentences(input: FigureTextInput, N: Norm, S: Stats, notes: string[]): string[] {
  const out: string[] = [];
  const cmps = S.res!.comparisons;
  const grouped = input.table.template === "grouped";
  if (!grouped && cmps.length <= 1) return out;   // a single comparison carries its P in the test sentence
  const thr = N.thr;
  const cmpP = S.cmpP;
  const M = cmpP.length;
  const AP = adjP(pAdjusted(input, S));
  const pv = (c: Comparison) => fmtPValue(c.p_adj as number, N.alpha);
  const item = (c: Comparison) => `${pv(c)} for ${versus(input, N, c)}`;
  const listSentence = (L: Comparison[]): string => {
    const one = L.length === 1;
    if (!grouped) {
      return one ? `The ${AP} value is ${item(L[0])}.` : `${cap(AP)} values are ${joinList(L.map(item))}.`;
    }
    const pairs = [...new Set(L.map((c) => versus(input, N, c)))];
    if (pairs.length === 1) {
      const vals = joinList(L.map((c) => `${pv(c)} (${outerName(input, N, c)})`));
      return one ? `The ${AP} value for ${pairs[0]} is ${vals}.` : `${cap(AP)} values for ${pairs[0]} are ${vals}.`;
    }
    const levels: (number | null)[] = [];
    for (const c of L) if (!levels.includes(c.row)) levels.push(c.row);
    const parts = levels.map((r) => {
      const inLevel = L.filter((c) => c.row === r);
      return `within ${outerName(input, N, inLevel[0])}, ${joinList(inLevel.map(item))}`;
    });
    return `${cap(AP)} values are as follows: ${parts.join("; ")}.`;
  };
  if (M > 0 && M <= MAX_P_LISTED) {
    out.push(listSentence(cmpP));
  } else if (M > MAX_P_LISTED) {
    const B = bracketInfo(input);
    const key = (c: { a: number; b: number; row: number | null }) => `${c.a},${c.b},${c.row ?? -1}`;
    const drawnKeys = new Set(B.drawn.map(key));
    const drawnC = cmpP.filter((c) => drawnKeys.has(key(c)));
    const sig = cmpP.filter((c) => (c.p_adj as number) <= thr);
    const L = drawnC.length >= 1 && drawnC.length <= MAX_P_LISTED ? drawnC
      : sig.length >= 1 && sig.length <= MAX_P_LISTED ? sig : null;
    const rest = L ? cmpP.filter((c) => !L.includes(c)) : [];
    const T = fmtThr(thr);
    if (L && rest.length && rest.every((c) => (c.p_adj as number) > thr)) {
      out.push(listSentence(L));
      out.push(rest.length === 1
        ? `The other comparison had a ${AP} > ${T}.`
        : `The other ${rest.length} comparisons had ${AP} > ${T}.`);
    } else if (cmpP.every((c) => (c.p_adj as number) < 0.0001)) {
      out.push(`${cap(AP)} values were <0.0001 for all ${M} comparisons.`);
    } else if (sig.length === M) {
      out.push(`${cap(AP)} values were ≤ ${T} for all ${M} comparisons.`);
    } else if (!sig.length) {
      out.push(`${cap(AP)} values were > ${T} for all ${M} comparisons.`);
    } else {
      const sigBound = sig.every((c) => (c.p_adj as number) < 0.0001) ? "<0.0001" : `≤ ${T}`;
      out.push(`${cap(AP)} values were ${sigBound} for ${sig.length} of the ${M} comparisons and > ${T} for the other ${M - sig.length === 1 ? "one" : M - sig.length}.`);
    }
    addNote(notes, `${M} comparisons: the legend lists at most ${MAX_P_LISTED}. Every ${AP === "P" ? "" : "adjusted "}P value is in the Results tab (export it as a supplementary table).`);
  }
  const missing = cmps.filter((c) => !isNum(c?.p_adj));
  if (missing.length) {
    const name = (c: Comparison) => (grouped ? `${versus(input, N, c)} within ${outerName(input, N, c)}` : versus(input, N, c));
    if (missing.length > MAX_MISSING_LISTED) out.push(`P values could not be computed for ${missing.length} comparisons.`);
    else if (missing.length === 1) out.push(`A P value could not be computed for ${name(missing[0])}.`);
    else out.push(`P values could not be computed for ${joinList(missing.map(name))}.`);
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
        if (isNum(r.p)) bits.push(`${fmtP(r.p, N.alpha)} (slope versus zero)`);
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

/** What the brackets on the figure are and what their labels mean; nothing
 *  when no bracket is drawn. Mirrors graph_plot via bracketInfo. */
function bracketSentences(input: FigureTextInput, N: Norm, S: Stats, notes: string[]): string[] {
  const out: string[] = [];
  if (input.table.template === "xy" || N.sigShow === "none" || !S.ok || !S.cmpP.length) return out;
  const twoGroup = TWO_GROUP.includes(input.analysis.test);
  const B = bracketInfo(input);
  if (B.tooMany) {
    addNote(notes, `More than ${MAX_BRACKETS} brackets (${B.tooMany}): none are drawn on the figure, so the legend gives no bracket key.`);
    return out;
  }
  if (!B.drawn.length) return out;
  const adj = !twoGroup && pAdjusted(input, S);
  const P = adjP(adj);
  const one = B.drawn.length === 1;
  const T = fmtThr(N.thr);
  if (B.drawn.length === S.cmpP.length) {
    out.push(one ? "The bracket indicates the groups compared." : "Brackets indicate the groups compared.");
  } else if (N.sigShow === "significant" && B.droppedNs > 0) {
    out.push(one ? `The bracket marks the comparison with ${P} ≤ ${T}.` : `Brackets mark comparisons with ${P} ≤ ${T}.`);
  } else {
    out.push("Brackets indicate comparisons between the groups they span.");
  }
  if (N.sigLabel === "p") {
    out.push(one ? `The bracket label gives the ${P} value.` : `Bracket labels give the ${P} values.`);
    return out;
  }
  const PS = adj ? "adjusted P" : "P";
  const present = new Set(B.drawn.map((b) => b.label));
  const key: string[] = [];
  // _star: "*" needs P ≤ min(α, 0.05); with an α below a star's own cut-off
  // (e.g. α = 0.005) that star only appears for P ≤ α.
  const cut: [string, number][] = [["*", 0.05], ["**", 0.01], ["***", 0.001], ["****", 0.0001]];
  for (const [sym, v] of cut) if (present.has(sym)) key.push(`${sym}${PS} ≤ ${fmtThr(Math.min(v, N.thr))}`);
  if (present.has("ns")) key.push(`ns, not significant (${PS} > ${T})`);
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
        out.push("The two groups were compared with an unpaired, two-sided Student's t test (pooled variance).");
        break;
      case "welch_t":
        out.push("The two groups were compared with an unpaired, two-sided t test with Welch's correction for unequal variances (Welch–Satterthwaite degrees of freedom).");
        break;
      case "paired_t":
        out.push(`The two groups were compared with a paired, two-sided t test on the within-pair differences (n = ${pc.pairs} pairs).${droppedRows}`);
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
    // the omnibus result always lives here (the legend drops it when post-hoc P values are listed)
    const st = statAndP(test, N.alpha);
    out.push({
      anova: `Groups were compared by ordinary one-way ANOVA (${st}).`,
      welch_anova: `Groups were compared by Welch's one-way ANOVA, which does not assume equal variances (${st}).`,
      kruskal: `Groups were compared with the Kruskal–Wallis test (tie-corrected H, χ² approximation; ${st}).`,
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
      // Games–Howell runs on any comparison set (all / control / selected pairs)
      s = a.compare === "all" ? `${allPw} used the Games–Howell test (no assumption of equal variances)`
        : `${subject} using the Games–Howell test (no assumption of equal variances)`;
      break;
    case "dunn":
      s = `${subject} using Dunn's test on the mean ranks of the joint ranking (tie-corrected), with Bonferroni correction for ${mText}`;
      break;
    default:
      return null;
  }
  if (!pAdjusted(input, S)) {
    // one comparison (or two groups): every correction leaves P unchanged
    const ph = a.posthoc === "dunn" ? `${subject} using Dunn's test on the mean ranks of the joint ranking (tie-corrected)`
      : a.posthoc === "sidak" || a.posthoc === "bonferroni" ? `${subject} using a t test with the pooled ANOVA variance`
        : s;
    s = `${ph}; with a single comparison, the P value is not adjusted for multiplicity`;
  } else {
    s += "; multiplicity-adjusted P values are reported";
  }
  const out = [`${s}.`];
  out.push(cmps.length > 1 ? "Pairwise comparisons were two-sided." : "The comparison was two-sided.");
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
  const terms = twoWayTerms(S, N.alpha);
  if (terms.length) out.push(`ANOVA results: ${terms.join("; ")}.`);
  addNote(notes, "Replace 'row factor' / 'column factor' with the names of your factors.");
  if (unequal(groups.map((g) => g.n))) addNote(notes, "Unequal group sizes: Type III sums of squares were used.");
  const a = input.analysis;
  if (a.posthoc === "none" || !S.cmpP.length) return out;
  const cmps = S.res!.comparisons;
  const set = twoWayInnerSet(input, N, S, W);
  const lead = `Within each level of the ${W.outerFactor}, ${set}`;
  const adj = pAdjusted(input, S);
  const unadj = W.outerLevels > 1 ? `each level of the ${W.outerFactor} was treated as a separate family of one comparison, so P values are not adjusted for multiplicity`
    : "with a single comparison per level, P values are not adjusted for multiplicity";
  if (a.posthoc === "tukey") {
    const kramer = unequal(groups.map((g) => g.n)) ? " (Tukey–Kramer for unequal group sizes)" : "";
    let s = `${lead} using Tukey's test with the pooled residual variance of the ANOVA${kramer}`;
    if (!adj) {
      s = `${lead} using t tests with the pooled residual variance of the ANOVA (Tukey's test for two groups); ${unadj}`;
    } else if (a.family === "all" && W.outerLevels > 1) {
      s += `; P values were additionally Šídák-corrected across the ${W.outerLevels} levels of the ${W.outerFactor} (one family)`;
    } else if (W.outerLevels > 1) {
      s += `; each level of the ${W.outerFactor} was treated as a separate family`;
    }
    out.push(adj ? `${s}; multiplicity-adjusted P values are reported.` : `${s}.`);
  } else if (a.posthoc === "sidak" || a.posthoc === "bonferroni") {
    const m = a.family === "all" ? cmps.length : Math.round(cmps.length / Math.max(1, W.outerLevels));
    const how = a.posthoc === "sidak" ? "Šídák's" : "Bonferroni";
    const fam = a.family === "all" ? " (all comparisons as one family)" : ` (each level of the ${W.outerFactor} as a separate family)`;
    out.push(adj
      ? `${lead} using t tests with the pooled residual variance and ${how} correction for ${m} ${plural(m, "comparison", "comparisons")}${fam}; multiplicity-adjusted P values are reported.`
      : `${lead} using t tests with the pooled residual variance of the ANOVA; ${unadj}.`);
  }
  out.push("Pairwise comparisons were two-sided.");
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

  // ── legend: [label | ] title. symbols (n). error bars. layout. test. P values. brackets. key.
  const legend: string[] = [];
  const Y = yName(N, f, notes);
  const label = figLabel(input.options?.figLabel);
  const prefix = label ? `${label} | ` : "";
  let built: string;
  if (t.template === "xy") {
    const X = clean(f?.xlabel) || clean(t.x_title) || "X";
    built = `${Y} as a function of ${X}${ss.length > 1 ? ` for ${listOrCount(ss.map((s) => s.name), "data sets")}` : ""}`;
  } else {
    const groups = plottedGroups(t);
    if (t.template === "column") {
      const names = groups.map((g) => N.labels[g.c]);
      const G = names.length === 1 ? names[0] : names.length <= MAX_LISTED ? `groups ${joinList(names)}` : `${names.length} groups`;
      built = `${Y} in ${G}`;
    } else {
      const cols = [...new Set(groups.map((g) => g.c))].sort((x, y) => x - y);
      const rows = [...new Set(groups.map((g) => g.r as number))].sort((x, y) => x - y);
      built = `${Y} for ${listOrCount(cols.map((c) => N.labels[c]), "data sets")} across ${listOrCount(rows.map((r) => N.rowTitles[r] ?? `Row ${r + 1}`), "groups")}`;
    }
  }
  // A graph title leads the legend; the descriptive sentence still follows so
  // the legend always names the measured variable and the groups.
  const title = clean(f?.title);
  if (title) legend.push(prefix + end(title), end(built));
  else legend.push(prefix + end(built));
  const U = unitInfo(input.options?.unit);
  const nInfo = describeN(input, U);
  const nText = nInfo.text;
  if (t.template === "xy") legend.push(...shownXY(input, N, ss, nText, U, notes));
  else legend.push(...shownColumn(input, N, nText, U, notes));
  if (S.ok) {
    if (t.template === "column") legend.push(...legendStatsColumn(input, N, S, notes));
    else if (t.template === "grouped") legend.push(...legendStatsGrouped(input, N, S, notes));
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
      adjusted = !TWO_GROUP.includes(a.test) && a.posthoc !== "none" && S.cmpP.length > 0 && pAdjusted(input, S);
      // the normality sentence accompanies a computed test only
      const norm = tested ? normalitySentence(input, N, S) : "";
      if (norm) methods.push(norm);
      else if (input.options?.normality && normalityApplies(t.template, a.test) && !tested) {
        addNote(notes, "The normality test is mentioned only alongside a computed test.");
      }
    } else {
      methods.push(...methodsTwoWay(input, N, S, notes));
      tested = S.testP;
      adjusted = a.posthoc !== "none" && S.cmpP.length > 0 && pAdjusted(input, S);
    }
  }
  if (tested) methods.push(`${adjusted ? "Adjusted P" : "P"} ≤ ${fmtThr(N.thr)} was considered statistically significant.`);
  const linesDrawn = t.template === "xy" && N.type === "xy_fit" ? ss.filter((s) => linearFitInfo(s.px, s.py).line).length : 0;
  methods.push(softwareSentence(input.software, N.theme, tested ? "tests" : linesDrawn > 1 ? "fits" : linesDrawn ? "fit" : "descriptive"));

  // ── notes (the engine's warnings explain e.g. why a post-hoc test has no rows)
  for (const w of arr(input.result?.warnings)) addNote(notes, clean(w));
  if (!U) {
    addNote(notes, "State what n represents: fill in “Each value is one…” above (e.g. mouse, independent experiment, technical replicate).");
  } else {
    if (U.pluralInput) addNote(notes, "“Each value is one…” should be singular (e.g. “mouse”, not “mice”).");
    if (nInfo.paired) addNote(notes, "Paired test: n counts pairs (rows). If both values of a pair come from the same subject, say so in the legend.");
  }
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
