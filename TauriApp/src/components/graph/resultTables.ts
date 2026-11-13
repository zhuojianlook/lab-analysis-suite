/* Results tables of the Graphs tool, as plain records: what is shown on screen
   (formatted text) and what goes into each table's CSV export (raw numbers at
   full precision, exact P values, CI bounds in separate columns). Pure — no
   React — so it is unit-testable in node. */

import type { AnalyzeResult, Num, Template } from "../../api/graph";
import { formatExact, formatNum, formatP } from "./graphModel";

export type DisplayRow = Record<string, string>;
export type CsvRow = Record<string, string | number | boolean | null>;

export interface ResultTableData {
  id: "anova" | "comparisons" | "regression" | "correlation" | "descriptives" | "normality";
  title: string;
  rows: DisplayRow[];
  csv: CsvRow[];
}

const n = (v: Num | undefined) => formatNum(v);
const ci = (lo: Num, hi: Num) => (lo === null || hi === null ? "—" : `${formatNum(lo)} to ${formatNum(hi)}`);
const yesNo = (b: boolean | null) => (b === null ? "—" : b ? "Yes" : "No");
const stat = (name: string, v: Num) => (v === null ? "—" : `${name ? `${name} = ` : ""}${formatNum(v)}`);
const raw = (v: Num | undefined): number | null => (v === null || v === undefined || !Number.isFinite(v) ? null : v);

export interface ResultTitles {
  /** Real row titles of the analysed table (descriptives are per table row). */
  rowTitles: string[];
  /** Titles of the outer level of grouped comparisons: the row titles, or the
   *  column titles when comparing within each column. */
  withinTitles: string[];
}

/** All results tables for an analysis response, in display order. Optional
 *  columns are included for every row or none (columns come from row 0). */
export function resultTables(result: AnalyzeResult, template: Template, titles: ResultTitles): ResultTableData[] {
  const grouped = template === "grouped";
  const rowName = (r: number | null) => (r === null ? "" : titles.rowTitles[r] ?? `Row ${r + 1}`);
  const withinName = (r: number | null) => (r === null ? "" : titles.withinTitles[r] ?? `${r + 1}`);
  const out: ResultTableData[] = [];

  const anova = result.anova_table ?? [];
  if (anova.length) {
    out.push({
      id: "anova", title: "ANOVA table",
      rows: anova.map((r) => ({
        Source: r.source, SS: n(r.ss), DF: n(r.df), MS: n(r.ms), F: n(r.f), P: r.p === null ? "" : formatP(r.p),
      })),
      csv: anova.map((r) => ({ Source: r.source, SS: raw(r.ss), DF: raw(r.df), MS: raw(r.ms), F: raw(r.f), P: raw(r.p) })),
    });
  }

  const cmp = result.comparisons ?? [];
  if (cmp.length) {
    const cmpSe = cmp.some((c) => c.se !== null), cmpDf = cmp.some((c) => c.df !== null), cmpNote = cmp.some((c) => c.note);
    out.push({
      id: "comparisons", title: "Multiple comparisons",
      rows: cmp.map((c) => ({
        ...(grouped ? { Within: withinName(c.row) } : {}),
        Comparison: c.label,
        "Mean diff.": n(c.diff),
        "95% CI of diff.": ci(c.ci_lo, c.ci_hi),
        ...(cmpSe ? { SE: n(c.se) } : {}),
        Statistic: stat(c.statistic_name ?? "", c.statistic),
        ...(cmpDf ? { DF: n(c.df) } : {}),
        "P (unadjusted)": formatP(c.p_raw),
        "Adjusted P": formatP(c.p_adj),
        Summary: c.star || "ns",
        Significant: c.significant ? "Yes" : "No",
        ...(cmpNote ? { Note: c.note || "" } : {}),
      })),
      csv: cmp.map((c) => ({
        ...(grouped ? { Within: withinName(c.row) } : {}),
        Comparison: c.label,
        "Mean diff.": raw(c.diff),
        "95% CI of diff. (lower)": raw(c.ci_lo),
        "95% CI of diff. (upper)": raw(c.ci_hi),
        ...(cmpSe ? { SE: raw(c.se) } : {}),
        Statistic: c.statistic_name || "",
        "Statistic value": raw(c.statistic),
        ...(cmpDf ? { DF: raw(c.df) } : {}),
        "P (unadjusted)": raw(c.p_raw),
        "Adjusted P": raw(c.p_adj),
        Summary: c.star || "ns",
        Significant: !!c.significant,
        ...(cmpNote ? { Note: c.note || "" } : {}),
      })),
    });
  }

  const reg = result.regression ?? [];
  if (reg.length) {
    const regNote = reg.some((r) => r.note);
    out.push({
      id: "regression", title: "Linear regression",
      rows: reg.map((r) => ({
        "Data set": r.label, N: String(r.n),
        Slope: `${n(r.slope)} ± ${n(r.slope_se)}`, "95% CI slope": ci(r.slope_lo, r.slope_hi),
        "Y intercept": `${n(r.intercept)} ± ${n(r.intercept_se)}`, "95% CI intercept": ci(r.intercept_lo, r.intercept_hi),
        "X intercept": n(r.x_intercept), "R²": n(r.r2), "Sy.x": n(r.sy_x),
        F: r.f === null ? "—" : `F(${n(r.df_num)}, ${n(r.df_den)}) = ${n(r.f)}`,
        "P (slope ≠ 0)": formatP(r.p), Summary: r.star || "ns", Equation: r.equation ?? "",
        ...(regNote ? { Note: r.note || "" } : {}),
      })),
      csv: reg.map((r) => ({
        "Data set": r.label, N: r.n,
        Slope: raw(r.slope), "Slope SE": raw(r.slope_se), "Slope 95% CI (lower)": raw(r.slope_lo), "Slope 95% CI (upper)": raw(r.slope_hi),
        "Y intercept": raw(r.intercept), "Y intercept SE": raw(r.intercept_se),
        "Y intercept 95% CI (lower)": raw(r.intercept_lo), "Y intercept 95% CI (upper)": raw(r.intercept_hi),
        "X intercept": raw(r.x_intercept), "R²": raw(r.r2), "Sy.x": raw(r.sy_x),
        F: raw(r.f), "DFn": raw(r.df_num), "DFd": raw(r.df_den),
        "P (slope ≠ 0)": raw(r.p), Summary: r.star || "ns", Equation: r.equation,
        ...(regNote ? { Note: r.note || "" } : {}),
      })),
    });
  }

  const cor = result.correlation ?? [];
  if (cor.length) {
    const corNote = cor.some((c) => c.note);
    out.push({
      id: "correlation", title: "Correlation",
      rows: cor.map((c) => ({
        "Data set": c.label, Method: c.method ?? "", N: String(c.n), r: n(c.r), "95% CI of r": ci(c.ci_lo, c.ci_hi),
        P: formatP(c.p), Summary: c.star || "ns", ...(corNote ? { Note: c.note || "" } : {}),
      })),
      csv: cor.map((c) => ({
        "Data set": c.label, Method: c.method, N: c.n, r: raw(c.r),
        "95% CI of r (lower)": raw(c.ci_lo), "95% CI of r (upper)": raw(c.ci_hi),
        P: raw(c.p), Summary: c.star || "ns", ...(corNote ? { Note: c.note || "" } : {}),
      })),
    });
  }

  const desc = result.descriptives ?? [];
  if (desc.length) {
    const groupKey = template === "xy" ? "Data set" : "Group";
    out.push({
      id: "descriptives", title: "Descriptive statistics",
      rows: desc.map((d) => ({
        ...(grouped ? { Row: rowName(d.row) } : {}),
        [groupKey]: d.label,
        N: String(d.n),
        Mean: n(d.mean), SD: n(d.sd), SEM: n(d.sem), "95% CI of mean": ci(d.ci_lo, d.ci_hi),
        Median: n(d.median), Q1: n(d.q1), Q3: n(d.q3), Min: formatExact(d.min), Max: formatExact(d.max),
      })),
      csv: desc.map((d) => ({
        ...(grouped ? { Row: rowName(d.row) } : {}),
        [groupKey]: d.label,
        N: d.n,
        Mean: raw(d.mean), SD: raw(d.sd), SEM: raw(d.sem),
        "95% CI of mean (lower)": raw(d.ci_lo), "95% CI of mean (upper)": raw(d.ci_hi),
        Median: raw(d.median), Q1: raw(d.q1), Q3: raw(d.q3), Min: raw(d.min), Max: raw(d.max),
      })),
    });
  }

  const norm = result.normality ?? [];
  if (norm.length) {
    const normNote = norm.some((x) => x.note);
    out.push({
      id: "normality", title: "Normality (Shapiro-Wilk)",
      rows: norm.map((x) => ({
        Group: x.label, N: String(x.n), W: n(x.w), P: formatP(x.p), "Passed (α = 0.05)": yesNo(x.passed),
        ...(normNote ? { Note: x.note || "" } : {}),
      })),
      csv: norm.map((x) => ({
        Group: x.label, N: x.n, W: raw(x.w), P: raw(x.p), "Passed (α = 0.05)": x.passed === null ? null : x.passed,
        ...(normNote ? { Note: x.note || "" } : {}),
      })),
    });
  }
  return out;
}
