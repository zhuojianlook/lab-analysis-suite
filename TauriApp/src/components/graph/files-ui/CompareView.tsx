/* "Compare with current" (phase 2 contract §6.1): which parts differ, the
   changed cells of the table, changed settings as "field: a → b", the
   scratchpad's changed cell count and the two graphs side by side. */

import { useMemo } from "react";
import { Box, Chip, Stack, Typography } from "@mui/material";
import type { CompareResult } from "../file/contract";
import type { SectionName } from "../file/format";
import type { DocContent } from "../../../store/graphStore";
import { VersionGraph, VersionTable, cellKey, type CellMark } from "./ReadOnlyViews";
import { SECTION_TITLE, V } from "./text";

const FIELD: Record<string, string> = {
  test: "Test", posthoc: "Follow-up test", compare: "Comparisons", control: "Control group", pairs: "Chosen pairs",
  alpha: "Significance level", within: "Compare within", family: "Correction applied", correlation: "Correlation",
  graph_type: "Graph type", center: "Centre and error bars", show_points: "Show points", point_size: "Point size",
  bar_width: "Bar width", show_band: "Confidence band", show_equation: "Show equation", sig_show: "Significance marks",
  sig_label: "Significance label", title: "Graph title", xlabel: "X axis title", ylabel: "Y axis title",
  font_size: "Font size", y_min: "Y axis from", y_max: "Y axis to", colors: "Colours", labels: "Series labels",
  show_legend: "Legend", theme: "Theme", width: "Width", height: "Height", dpi: "Resolution", export_format: "Export format",
  transparent: "Transparent background", fig_label: "Figure label", n_unit: "What n counts", palette: "Palette",
  palette_colors: "Palette colours", palette_reverse: "Palette reversed", palette_edited: "Colours edited", axis_scheme: "Axis colours",
  series: "Series",
};

/** A settings field in plain words. */
export function fieldLabel(field: string): string {
  if (FIELD[field]) return FIELD[field];
  const t = field.replace(/_/g, " ").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : field;
}

export const shortValue = (s: string) => (s === "" ? "(empty)" : s);

/** Changed cells of `cmp` as marks on the `a` side (the other value is `b`), or the `b` side. */
export function cellMarks(cmp: CompareResult, side: "a" | "b"): Map<string, CellMark> {
  const m = new Map<string, CellMark>();
  for (const c of cmp.table.cells) m.set(cellKey(c.rowId, c.colId, c.rep), { other: side === "a" ? c.b : c.a });
  return m;
}

/** Counts of the table's changes as short phrases. */
export function tableChangeLines(t: CompareResult["table"]): string[] {
  const out: string[] = [];
  if (t.changedCells) out.push(V.cellsDiffer(t.changedCells));
  if (t.addedRows) out.push(V.rowsAdded(t.addedRows));
  if (t.removedRows) out.push(V.rowsRemoved(t.removedRows));
  if (t.addedCols) out.push(V.colsAdded(t.addedCols));
  if (t.removedCols) out.push(V.colsRemoved(t.removedCols));
  if (t.changedTitles) out.push(V.titlesChanged(t.changedTitles));
  return out;
}

export function SameChip({ same }: { same: boolean }) {
  return (
    <Chip size="small" label={same ? V.same : V.different} color={same ? "default" : "warning"} variant={same ? "outlined" : "filled"}
      sx={{ height: 18, fontSize: 10.5, "& .MuiChip-label": { px: 0.75 } }} />
  );
}

function SectionHead({ k, same }: { k: SectionName; same: boolean }) {
  return (
    <Stack direction="row" spacing={1} alignItems="center" data-testid="compare-section" data-key={k} data-same={same ? "true" : "false"}>
      <Typography variant="subtitle2" sx={{ fontWeight: 600, minWidth: 130 }}>{SECTION_TITLE[k]}</Typography>
      <SameChip same={same} />
    </Stack>
  );
}

/** Inside the version preview while "Compare with current" is on. `content` = the selected version, `current` = the tab now. */
export function CompareView({ compare, content, current }: { compare: CompareResult; content: DocContent; current: DocContent }) {
  const same = useMemo(() => new Map(compare.sections.map((s) => [s.key, s.same] as const)), [compare]);
  const marks = useMemo(() => cellMarks(compare, "a"), [compare]);
  const t = compare.table;
  const tableLines = tableChangeLines(t);
  const more = Math.max(0, t.changedCells - t.cells.length);
  const settingsOf = (sec: "analysis" | "figure") => compare.settings.filter((x) => x.section === sec);
  return (
    <Stack spacing={2.25} data-testid="version-compare-view" sx={{ pb: 2 }}>
      <Stack spacing={0.75}>
        {compare.sections.map((s) => (
          <Stack key={s.key} direction="row" spacing={1.5} alignItems="center">
            <SectionHead k={s.key} same={s.same} />
            <Typography variant="caption" color="text.secondary" noWrap>
              {s.same ? "" : s.key === "table" ? tableLines.join(" · ")
                : s.key === "scratchpad" ? V.cellsDiffer(compare.scratchpadCells)
                  : (() => { const n = settingsOf(s.key as "analysis" | "figure").length; return n ? `${n} setting${n === 1 ? "" : "s"} differ${n === 1 ? "s" : ""}` : ""; })()}
            </Typography>
          </Stack>
        ))}
      </Stack>

      {!same.get("table") && (
        <Box>
          <Typography variant="overline" color="text.secondary">{SECTION_TITLE.table} — {V.thisVersion}</Typography>
          {t.cells.length > 0 ? (
            <>
              <VersionTable doc={content.doc} marks={marks} otherLabel={V.current} testId="compare-table" />
              {more > 0 && <Typography variant="caption" color="text.secondary">{V.andMore(more)}</Typography>}
            </>
          ) : (
            <Typography variant="body2" color="text.secondary">{tableLines.join(" · ")}</Typography>
          )}
        </Box>
      )}

      {(["analysis", "figure"] as const).filter((k) => !same.get(k)).map((k) => (
        <Box key={k} data-testid="compare-settings" data-key={k}>
          <Typography variant="overline" color="text.secondary">{SECTION_TITLE[k]}</Typography>
          <Stack spacing={0.25}>
            {settingsOf(k).map((x) => (
              <Typography key={x.field} variant="body2" sx={{ fontSize: 12.5 }}>
                {V.settingLine(fieldLabel(x.field), shortValue(x.a), shortValue(x.b))}
              </Typography>
            ))}
          </Stack>
        </Box>
      ))}

      <Box>
        <Typography variant="overline" color="text.secondary">{V.graphsSideBySide}</Typography>
        <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 2, alignItems: "start" }}>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 0.5, fontWeight: 600 }}>{V.thisVersion}</Typography>
            <VersionGraph content={content} maxHeight="44vh" testId="compare-graph-a" />
          </Box>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 0.5, fontWeight: 600 }}>{V.current}</Typography>
            <VersionGraph content={current} maxHeight="44vh" testId="compare-graph-b" />
          </Box>
        </Box>
      </Box>
    </Stack>
  );
}
