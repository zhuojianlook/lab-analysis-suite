/* Graphs tool — types and client calls for the /api/graph/* sidecar routes.
   Failures come back as HTTP 200 `{ error, code }` envelopes (apiJson only
   throws on FastAPI `detail` envelopes / non-JSON bodies), so every caller
   checks `error` on the result. */

import { apiJson } from "./client";
import type { RunRResponse } from "./types";

export type Template = "column" | "grouped" | "xy";
export type Num = number | null;

/** Numeric table sent for analysis/plotting. values = [row][col][rep]; the
 *  column template always has one rep. Trailing empty rows are trimmed. */
export interface GraphTable {
  template: Template;
  col_titles: string[];
  row_titles: string[];
  x_title: string;
  x: Num[];
  values: Num[][][];
}

/** The editable document: raw cell text exactly as typed (saved verbatim). */
export interface GraphDoc {
  v: 1;
  template: Template;
  col_titles: string[];
  row_titles: string[];
  x_title: string;
  n_rep: number;
  x: string[];
  cells: string[][][];
}

export type TestId =
  | "none" | "unpaired_t" | "welch_t" | "paired_t" | "mann_whitney" | "wilcoxon"
  | "anova" | "welch_anova" | "kruskal" | "two_way" | "linreg";
export type PosthocId = "none" | "tukey" | "dunnett" | "sidak" | "bonferroni" | "dunn" | "games_howell";
export type CompareId = "all" | "control" | "selected";

export interface GraphAnalysis {
  test: TestId;
  posthoc: PosthocId;
  compare: CompareId;
  control: number | null;
  pairs: [number, number][];
  alpha: number;
  within: "rows" | "columns";
  family: "all" | "per_row";
  correlation: "none" | "pearson" | "spearman";
}

export type GraphType = "dot" | "bar" | "box" | "violin" | "gbar" | "gdot" | "xy_points" | "xy_line" | "xy_fit";
export type CenterId = "mean_sd" | "mean_sem" | "mean_ci" | "median_iqr";

export interface GraphFigure {
  graph_type: GraphType;
  center: CenterId;
  show_points: boolean;
  point_size: number;
  bar_width: number;
  show_band: boolean;
  show_equation: boolean;
  sig_show: "significant" | "all" | "none";
  sig_label: "stars" | "p";
  title: string;
  xlabel: string;
  ylabel: string;
  font_size: number;
  y_min: Num;
  y_max: Num;
  colors: string[];
  labels: string[];
  show_legend: boolean;
  theme: "prism" | "classic" | "minimal";
  width: number;
  height: number;
  dpi: number;
  export_format: "png" | "tiff";
  transparent: boolean;
  /** Legend text only, never sent to the plot: "Fig. 1", "Extended Data Fig. 2"; "" = no label. */
  fig_label?: string;
  /** Legend text only, never sent to the plot: what one plotted value is, singular
   *  ("independent cell culture", "mouse"); "" = not stated. */
  n_unit?: string;
}

export interface GraphSummary {
  id: number;
  name: string;
  template: Template;
  n_rows: number;
  n_cols: number;
  created_at: string | number;
  updated_at: string | number;
}

export interface GraphSaved extends GraphSummary {
  table: GraphDoc;
  analysis: GraphAnalysis;
  figure: GraphFigure;
  doc_version: number;
}

export interface GraphLibraryList {
  analyses: GraphSummary[];
  path: string;
}

/** Error envelope shared by every route. */
export interface GraphError {
  error: string;
  code?: string;
  conflict?: { id: number; name: string };
}

export interface AnalyzeResult {
  error?: string;
  /** "invalid" = malformed request / unsupported combination; "data" = the data can't support the test. */
  code?: "invalid" | "data";
  warnings: string[];
  descriptives: {
    row: number | null; col: number; label: string; n: number;
    mean: Num; sd: Num; sem: Num; ci_lo: Num; ci_hi: Num;
    median: Num; q1: Num; q3: Num; min: Num; max: Num;
  }[];
  normality: { col: number; label: string; n: number; w: Num; p: Num; passed: boolean | null; note: string }[];
  test: null | {
    id: string; label: string; method: string | null; statistic_name: string | null;
    statistic: Num; df: Num; df2: Num; p: Num; star: string; note: string | null;
    /** One-way ANOVA: SS(between) / SS(total). */
    r2?: Num;
    /** Wilcoxon: pairs used (non-zero differences) and the rank sums. */
    n?: number; sum_pos_ranks?: Num; sum_neg_ranks?: Num;
    /** Two-way ANOVA: the anova_table term the headline F / P belong to. */
    term?: string;
  };
  anova_table: { source: string; ss: Num; df: Num; ms: Num; f: Num; p: Num }[];
  comparisons: {
    row: number | null; a: number; b: number; label: string; diff: Num; se: Num;
    statistic_name: string | null; statistic: Num; df: Num; p_raw: Num; p_adj: Num;
    ci_lo: Num; ci_hi: Num; star: string; significant: boolean; note: string | null;
  }[];
  regression: {
    col: number; label: string; n: number; slope: Num; slope_se: Num; slope_lo: Num; slope_hi: Num;
    intercept: Num; intercept_se: Num; intercept_lo: Num; intercept_hi: Num; r2: Num; sy_x: Num;
    f: Num; df_num: Num; df_den: Num; p: Num; star: string; x_intercept: Num; equation: string | null; note: string | null;
  }[];
  correlation: {
    col: number; label: string; method: string | null; n: number; r: Num; p: Num;
    ci_lo: Num; ci_hi: Num; star: string; note: string | null;
  }[];
}

/** Versions of the software that computed / drew a graph, read from the
 *  running engine (GET /api/graph/software). null = unknown: leave it out of
 *  any citation rather than guessing. */
export interface SoftwareVersions {
  /** Lab Analysis Suite (the engine's config.APP_VERSION). */
  app: string | null;
  python: string | null;
  numpy: string | null;
  scipy: string | null;
  r: string | null;
  ggplot2: string | null;
  ggprism: string | null;
}

export type GraphPlotResult = RunRResponse & { warnings?: string[]; error?: string };

export interface SaveRequest {
  id: number | null;
  name: string;
  template: Template;
  table: GraphDoc;
  analysis: GraphAnalysis;
  figure: GraphFigure;
  doc_version: 1;
  overwrite: boolean;
}

export type SaveResponse =
  | ({ analysis: GraphSummary; replaced: boolean } & GraphLibraryList & { error?: undefined })
  | GraphError;

export type RenameResponse = ({ analysis: GraphSummary } & GraphLibraryList & { error?: undefined }) | GraphError;

const post = <T>(path: string, body: unknown) => apiJson<T>(path, "POST", JSON.stringify(body));

export const getGraphLibrary = () => apiJson<GraphLibraryList & Partial<GraphError>>("/api/graph/library");

export const getGraphAnalysis = (id: number) =>
  apiJson<{ analysis?: GraphSaved } & Partial<GraphError>>(`/api/graph/library/get?id=${encodeURIComponent(String(id))}`);

export const saveGraphAnalysis = (body: SaveRequest) => post<SaveResponse>("/api/graph/library/save", body);

export const renameGraphAnalysis = (id: number, name: string) =>
  post<RenameResponse>("/api/graph/library/rename", { id, name });

export const duplicateGraphAnalysis = (id: number, name?: string) =>
  post<RenameResponse>("/api/graph/library/duplicate", name ? { id, name } : { id });

export const deleteGraphAnalysis = (id: number) =>
  post<GraphLibraryList & Partial<GraphError>>("/api/graph/library/delete", { id });

export const analyzeGraph = (table: GraphTable, analysis: GraphAnalysis) =>
  post<AnalyzeResult>("/api/graph/analyze", { table, analysis });

export const plotGraph = (table: GraphTable, analysis: GraphAnalysis, figure: GraphFigure) =>
  post<GraphPlotResult>("/api/graph/plot", { table, analysis, figure });

export const getGraphSoftware = () => apiJson<SoftwareVersions>("/api/graph/software");

/** True when a route answered with an error envelope. */
export const isGraphError = (r: unknown): r is GraphError =>
  !!r && typeof r === "object" && typeof (r as { error?: unknown }).error === "string" && !!(r as { error: string }).error;
