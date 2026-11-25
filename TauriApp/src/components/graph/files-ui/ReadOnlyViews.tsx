/* Read-only renderings of one version's content (phase 2 contract §6.1):
   the data table (with changed cells marked), the scratchpad sheet and the
   graph through the existing plot request. Used by the version preview, the
   comparison view and the combine dialog. Nothing here edits anything. */

import { useEffect, useState } from "react";
import { Box, CircularProgress, Stack, Tooltip, Typography, alpha, useTheme } from "@mui/material";
import { plotGraph } from "../../../api/graph";
import type { GraphDoc } from "../../../api/graph";
import type { DocContent } from "../../../store/graphStore";
import { defaultColTitle, effectiveAnalysis, effectiveFigure, hasNumbers, toNumericTable } from "../graphModel";
import { parseScratch } from "../scratchpad/scratchModel";
import { F, V } from "./text";

/** A changed cell: what the other side has there. */
export interface CellMark { other: string }
export const cellKey = (rowId: string, colId: string, rep: number) => `${rowId}|${colId}|${rep}`;

const rowIdOf = (doc: GraphDoc, r: number) => doc.row_ids?.[r] ?? `#${r}`;
const colIdOf = (doc: GraphDoc, c: number) => doc.col_ids?.[c] ?? `#${c}`;

function rowUsed(doc: GraphDoc, r: number): boolean {
  if ((doc.row_titles[r] ?? "").trim() || (doc.x?.[r] ?? "").trim()) return true;
  return (doc.cells[r] ?? []).some((reps) => reps.some((v) => (v ?? "").trim() !== ""));
}

/** The table of a version, read only. `marks` highlights changed cells (the tooltip names the other value);
 *  `onlyMarked` shows just the rows that hold a mark (with at most `maxRows` rows either way). */
export function VersionTable({ doc, marks, otherLabel, onlyMarked = false, maxRows = 120, dense = false, testId, markRows, markCols, markTitle, nearMarked = false }: {
  doc: GraphDoc; marks?: Map<string, CellMark>; otherLabel?: string; onlyMarked?: boolean; maxRows?: number; dense?: boolean; testId?: string;
  /** Phase 4: rows / columns (by id) that get a small marker (an order to check). `markTitle` is its tooltip. */
  markRows?: ReadonlySet<string>; markCols?: ReadonlySet<string>; markTitle?: string;
  /** Fixer VUX-2: when a marked row lies beyond the first `maxRows`, show the marked rows with a few rows around them instead. */
  nearMarked?: boolean;
}) {
  const theme = useTheme();
  const nRep = Math.max(1, doc.n_rep || 1);
  const isXY = doc.template === "xy";
  const hasRowTitles = doc.template === "grouped";
  let last = -1;
  for (let r = 0; r < doc.cells.length; r++) if (rowUsed(doc, r)) last = r;
  let rows = Array.from({ length: last + 1 }, (_, r) => r);
  if (onlyMarked && marks) {
    const marked = new Set<string>();
    for (const k of marks.keys()) marked.add(k.split("|")[0]);
    rows = rows.filter((r) => marked.has(rowIdOf(doc, r)));
  }
  let near = false;
  if (nearMarked && markRows?.size && rows.length > maxRows) {
    const at = rows.filter((r) => markRows.has(rowIdOf(doc, r)));
    if (at.some((r) => rows.indexOf(r) >= maxRows)) {
      const keep = new Set<number>();
      for (const r of at) for (let d = -3; d <= 3; d++) keep.add(r + d);
      rows = rows.filter((r) => keep.has(r));
      near = true;
    }
  }
  const hidden = Math.max(0, rows.length - maxRows);
  rows = rows.slice(0, maxRows);
  const hl = alpha(theme.palette.warning.main, 0.28);
  const cellSx = {
    border: 1, borderColor: "divider", px: dense ? 0.5 : 0.75, py: dense ? 0.1 : 0.25, fontSize: dense ? 11.5 : 12.5,
    whiteSpace: "nowrap" as const, textAlign: "right" as const, fontVariantNumeric: "tabular-nums", minWidth: dense ? 36 : 48,
  };
  const headSx = { ...cellSx, textAlign: "center" as const, fontWeight: 600, bgcolor: "action.hover", color: "text.secondary" };
  const markColor = theme.palette.info.main;
  const rowMarkSx = { boxShadow: `inset 3px 0 0 ${markColor}`, color: "info.main", fontWeight: 600 };
  const colMarkSx = { boxShadow: `inset 0 -3px 0 ${markColor}`, color: "info.main" };
  if (last < 0) {
    return <Typography variant="body2" color="text.secondary" sx={{ py: 2 }} data-testid={testId}>{V.noData}</Typography>;
  }
  return (
    <Box sx={{ overflow: "auto", maxWidth: "100%" }} data-testid={testId}>
      <Box component="table" sx={{ borderCollapse: "collapse", bgcolor: "background.paper" }}>
        <thead>
          <tr>
            <Box component="th" sx={headSx}>{isXY ? (doc.x_title.trim() || "X") : hasRowTitles ? "" : "#"}</Box>
            {doc.col_titles.map((t, c) => {
              const marked = markCols?.has(colIdOf(doc, c)) ?? false;
              return (
                <Box component="th" key={colIdOf(doc, c)} colSpan={nRep} sx={{ ...headSx, ...(marked ? colMarkSx : {}) }}
                  data-testid={marked ? "order-mark" : undefined} data-axis={marked ? "col" : undefined} title={marked ? markTitle : undefined}>
                  {t.trim() || defaultColTitle(doc.template, c)}
                </Box>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const rid = rowIdOf(doc, r);
            const rowMarked = markRows?.has(rid) ?? false;
            return (
              <tr key={rid}>
                <Box component="td" sx={{ ...cellSx, textAlign: isXY ? "right" : "left", color: "text.secondary", bgcolor: "action.hover", ...(rowMarked ? rowMarkSx : {}) }}
                  data-testid={rowMarked ? "order-mark" : undefined} data-axis={rowMarked ? "row" : undefined} data-row={r + 1}
                  title={rowMarked ? markTitle : near ? `Row ${r + 1}` : undefined}>
                  {isXY ? doc.x?.[r] ?? "" : hasRowTitles ? doc.row_titles[r] ?? "" : r + 1}
                </Box>
                {doc.col_titles.map((_, c) => Array.from({ length: nRep }, (_, k) => {
                  const v = doc.cells[r]?.[c]?.[k] ?? "";
                  const m = marks?.get(cellKey(rid, colIdOf(doc, c), k));
                  const td = (
                    <Box component="td" key={`${c}:${k}`} data-testid={m ? "changed-cell" : undefined}
                      sx={{ ...cellSx, ...(m ? { bgcolor: hl, fontWeight: 600 } : {}) }}>
                      {v}
                      {m && (
                        <Box component="span" sx={{ ml: 0.5, fontWeight: 400, color: "text.secondary", fontSize: "0.9em" }}>
                          → {m.other === "" ? "(empty)" : m.other}
                        </Box>
                      )}
                    </Box>
                  );
                  return m ? (
                    <Tooltip key={`${c}:${k}`} title={`${otherLabel ?? V.current}: ${m.other === "" ? "(empty)" : m.other}`}>{td}</Tooltip>
                  ) : td;
                }))}
              </tr>
            );
          })}
        </tbody>
      </Box>
      {near && <Typography variant="caption" color="text.secondary" component="div" data-testid="table-near-marked">{F.nearMarked}</Typography>}
      {hidden > 0 && <Typography variant="caption" color="text.secondary">{V.andMore(hidden)}</Typography>}
    </Box>
  );
}

const colLetters = (n: number) => {
  let s = "";
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
};

/** The scratchpad sheet of a version, read only (what was typed, formulas as text). */
export function ScratchGrid({ scratch, maxRows = 60, maxCols = 20 }: { scratch: string; maxRows?: number; maxCols?: number }) {
  let cells: [number, number, string][] = [];
  try { cells = parseScratch(scratch).cells as [number, number, string][]; } catch { cells = []; }
  if (!cells.length) return <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>{V.scratchEmpty}</Typography>;
  const nRows = Math.min(maxRows, Math.max(...cells.map((c) => c[0])));
  const nCols = Math.min(maxCols, Math.max(...cells.map((c) => c[1])));
  const at = new Map(cells.map((c) => [`${c[0]}:${c[1]}`, c[2]] as const));
  const cellSx = { border: 1, borderColor: "divider", px: 0.75, py: 0.25, fontSize: 12, whiteSpace: "nowrap" as const, minWidth: 56, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis" };
  const headSx = { ...cellSx, minWidth: 28, textAlign: "center" as const, color: "text.secondary", bgcolor: "action.hover", fontWeight: 600 };
  return (
    <Box sx={{ overflow: "auto", maxWidth: "100%" }} data-testid="readonly-scratch">
      <Box component="table" sx={{ borderCollapse: "collapse", bgcolor: "background.paper" }}>
        <thead>
          <tr>
            <Box component="th" sx={headSx} />
            {Array.from({ length: nCols }, (_, c) => <Box component="th" key={c} sx={headSx}>{colLetters(c + 1)}</Box>)}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: nRows }, (_, r) => (
            <tr key={r}>
              <Box component="th" sx={headSx}>{r + 1}</Box>
              {Array.from({ length: nCols }, (_, c) => <Box component="td" key={c} sx={cellSx}>{at.get(`${r + 1}:${c + 1}`) ?? ""}</Box>)}
            </tr>
          ))}
        </tbody>
      </Box>
    </Box>
  );
}

// ── the graph of a version (the existing plot request, cached by content) ──

type PlotState = { kind: "loading" } | { kind: "ok"; b64: string } | { kind: "none" } | { kind: "error" };
const plotCache = new Map<string, Promise<PlotState>>();

function plotOf(c: DocContent): { key: string; run: () => Promise<PlotState> } {
  const table = toNumericTable(c.doc);
  if (!hasNumbers(table)) return { key: "none", run: async () => ({ kind: "none" }) };
  const a = effectiveAnalysis(c.analysis, table);
  const f = effectiveFigure(c.figure, table);
  const key = JSON.stringify([table, a, f]);
  return {
    key,
    run: async () => {
      try {
        const res = await plotGraph(table, a, f);
        const b64 = res.success ? res.plots?.[0] : undefined;
        return b64 ? { kind: "ok", b64 } : { kind: "error" };
      } catch {
        return { kind: "error" };
      }
    },
  };
}

/** A version's graph, rendered by the engine (read only). */
export function VersionGraph({ content, maxHeight = "60vh", testId }: { content: DocContent; maxHeight?: string; testId?: string }) {
  const [state, setState] = useState<PlotState>({ kind: "loading" });
  const { key, run } = plotOf(content);
  useEffect(() => {
    let alive = true;
    setState({ kind: "loading" });
    let p = plotCache.get(key);
    if (!p) {
      p = run();
      plotCache.set(key, p);
      if (plotCache.size > 24) plotCache.delete(plotCache.keys().next().value as string);
      // A failed render is tried again next time.
      void p.then((s) => { if (s.kind === "error") plotCache.delete(key); });
    }
    void p.then((s) => { if (alive) setState(s); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (state.kind === "loading") {
    return (
      <Stack direction="row" spacing={1} alignItems="center" sx={{ py: 3 }} data-testid={testId} data-state="loading">
        <CircularProgress size={16} />
        <Typography variant="body2" color="text.secondary">{V.graphRendering}</Typography>
      </Stack>
    );
  }
  if (state.kind !== "ok") {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ py: 3 }} data-testid={testId} data-state={state.kind}>
        {state.kind === "none" ? V.noData : V.graphUnavailable}
      </Typography>
    );
  }
  return (
    <Box component="img" src={`data:image/png;base64,${state.b64}`} alt="" data-testid={testId} data-state="ok"
      sx={{ display: "block", maxWidth: "100%", maxHeight, width: "auto", objectFit: "contain", border: 1, borderColor: "divider", borderRadius: 1, bgcolor: "#fff" }} />
  );
}
