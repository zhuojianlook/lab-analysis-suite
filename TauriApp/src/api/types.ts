/* Shared API types for the Lab Analysis Suite sidecar. */

export interface HealthResponse {
  status: string;
}

export interface VersionResponse {
  build: string;
}

export interface CheckRResponse {
  installed: boolean;
  version: string;
  path: string;
  /** True when the resolved Rscript is the app's bundled engine (not a host R). */
  bundled?: boolean;
}

/** Result shape of POST /api/analysis/run-r (the shared Python↔R bridge). */
export interface RunRResponse {
  success: boolean;
  stdout: string;
  stderr: string;
  /** base64-encoded PNG plots, in script order. */
  plots: string[];
  /** CSV tables written by the R script via mpfig_data(df, name). */
  tables: { name: string; csv: string }[];
  labels?: Record<string, string>;
  svg?: string | null;
}
