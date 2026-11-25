/* "Compare with current" (phase 2 contract §6.1): which parts differ, the
   changed cells of the table, changed settings as "field: a → b", the
   scratchpad's changed cell count and the two graphs side by side.
   Phase 4 (contract §6.6): the mini-table of one row on two sides, used by the
   combine dialog's blocks, so the dialog and this view draw a row the same way. */

import { Fragment, useMemo } from "react";
import { Box, Chip, Stack, Typography, alpha, useTheme } from "@mui/material";
import type { CompareResult, FineItem } from "../file/contract";
import type { GraphDoc } from "../../../api/graph";
import { defaultColTitle } from "../graphModel";
import type { SectionName } from "../file/format";
import type { DocContent } from "../../../store/graphStore";
import { VersionGraph, VersionTable, cellKey, type CellMark } from "./ReadOnlyViews";
import { F, SECTION_TITLE, V, fieldLabel, shortValue } from "./text";

// The settings' plain names live in text.ts (phase 4: the combine dialog's texts use them too).
export { fieldLabel, shortValue };

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

// ── phase 4: one row on two sides (the combine dialog's mini-table, §6.2) ──

export interface MiniSide {
  side: "mine" | "theirs";
  label: string;
  doc: GraphDoc;
}

const NEIGHBOURS = 6;

/** Which columns to show: every column with a differing value, plus neighbours around them (nearest first) —
 *  up to NEIGHBOURS, and fewer when the row is wide (fixer VUX-5: about a dozen values in all, so the values to
 *  choose are not off to the side). */
export function miniColumns(all: readonly string[], diff: ReadonlySet<string>, nRep = 1): string[] {
  const idx = all.map((id, i) => (diff.has(id) ? i : -1)).filter((i) => i >= 0);
  const budget = Math.min(NEIGHBOURS, Math.max(0, Math.floor(12 / Math.max(1, nRep)) - idx.length));
  if (idx.length === 0) return all.slice(0, Math.max(1, budget));
  const keep = new Set(idx);
  let added = 0;
  for (let d = 1; added < budget && d < all.length; d++) {
    for (const i of idx) {
      for (const j of [i - d, i + d]) {
        if (added >= budget) break;
        if (j >= 0 && j < all.length && !keep.has(j)) { keep.add(j); added++; }
      }
    }
  }
  return all.filter((_, i) => keep.has(i));
}

const sideKey = (it: FineItem, side: "mine" | "theirs") => (side === "mine" ? it.mine : it.theirs);

/** One row of the table as each side has it, read by row and column id. The values listed in `items` are highlighted. */
export function MiniRowTable({ rowId, sides, items, chosen = null, testId = "combine-conflict-table", result = null, resultLabel = "" }: {
  rowId: string; sides: MiniSide[]; items: readonly FineItem[];
  /** The side chosen so far: the other line is shown faded. */
  chosen?: "mine" | "theirs" | null; testId?: string;
  /** Fixer VUX-1: the combined table (when every choice is made): a third line shows the row as it will be saved;
   *  a value there that is not the chosen side's is marked. */
  result?: GraphDoc | null; resultLabel?: string;
}) {
  const theme = useTheme();
  const docs = sides.map((s) => s.doc);
  const template = docs[0]?.template ?? "column";
  // Columns: the first side's order, then the others' columns it lacks, in their order.
  const all: string[] = [];
  for (const d of docs) for (const id of d.col_ids ?? []) if (!all.includes(id)) all.push(id);
  const diffCells = new Set(items.filter((i) => i.what === "cell" && i.colId).map((i) => `${i.colId}|${i.rep ?? 0}`));
  const diffCols = new Set(items.filter((i) => i.what === "cell" && i.colId).map((i) => i.colId!));
  const nRep = Math.max(1, ...docs.map((d) => (d.template === "column" ? 1 : d.n_rep || 1)));
  const cols = miniColumns(all, diffCols, nRep);
  const titleDiff = items.some((i) => i.what === "rowTitle");
  const xDiff = items.some((i) => i.what === "x");
  // The row title only when it is to choose or differs (the heading names it when it is the same; fixer VUX-5).
  const titles = new Set(docs.map((d) => { const r = (d.row_ids ?? []).indexOf(rowId); return r < 0 ? null : d.row_titles[r] ?? ""; }).filter((t) => t !== null));
  const showTitle = titleDiff || (template === "grouped" && titles.size > 1);
  const showX = template === "xy" || xDiff;
  const titleOf = (id: string) => {
    for (const d of docs) {
      const c = (d.col_ids ?? []).indexOf(id);
      if (c >= 0) return d.col_titles[c]?.trim() || defaultColTitle(d.template, c);
    }
    return "";
  };
  const hl = alpha(theme.palette.warning.main, 0.3);
  const cellSx = {
    border: 1, borderColor: "divider", px: 0.6, py: 0.15, fontSize: 12, whiteSpace: "nowrap" as const,
    textAlign: "right" as const, fontVariantNumeric: "tabular-nums", minWidth: 40, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis",
  };
  const headSx = { ...cellSx, textAlign: "center" as const, fontWeight: 600, bgcolor: "action.hover", color: "text.secondary", fontSize: 11.5 };
  const sideSx = { ...headSx, textAlign: "left" as const, fontWeight: 600, color: "text.primary" };
  const dash = <Box component="span" sx={{ color: "text.disabled" }}>{F.notThere}</Box>;
  const resultRow = result ? (result.row_ids ?? []).indexOf(rowId) : -1;
  const chosenDoc = chosen ? sides.find((x) => x.side === chosen)?.doc ?? null : null;
  const valueIn = (d: GraphDoc | null, col: string | "x" | "title", k = 0): string | undefined => {
    if (!d) return undefined;
    const r = (d.row_ids ?? []).indexOf(rowId);
    if (r < 0) return undefined;
    if (col === "x") return d.x?.[r] ?? "";
    if (col === "title") return d.row_titles[r] ?? "";
    const c = (d.col_ids ?? []).indexOf(col);
    return c < 0 ? undefined : d.cells[r]?.[c]?.[k] ?? "";
  };
  const otherSx = { boxShadow: `inset 0 -2px 0 ${theme.palette.info.main}` };
  return (
    <Box sx={{ overflowX: "auto", maxWidth: "100%" }} data-testid={testId}>
      <Box component="table" sx={{ borderCollapse: "collapse", bgcolor: "background.paper" }}>
        <thead>
          <tr>
            <Box component="th" sx={headSx} />
            {showX && <Box component="th" sx={headSx}>{docs[0]?.x_title.trim() || "X"}</Box>}
            {showTitle && <Box component="th" sx={headSx}>{F.rowTitleHead}</Box>}
            {cols.map((id) => <Box component="th" key={id} colSpan={nRep} sx={headSx} title={titleOf(id)}>{titleOf(id)}</Box>)}
          </tr>
        </thead>
        <tbody>
          {sides.map((s) => {
            const d = s.doc;
            const r = (d.row_ids ?? []).indexOf(rowId);
            const text = (v: string | undefined, diff: boolean, attrs: Record<string, string>) => (
              <Box component="td" sx={{ ...cellSx, ...(diff ? { bgcolor: hl, fontWeight: 600 } : {}) }}
                data-testid="combine-conflict-cell" data-side={s.side} data-diff={diff ? "true" : undefined} {...attrs}>
                {r < 0 || v === undefined ? dash : v}
              </Box>
            );
            return (
              <Box component="tr" key={s.side} data-side={s.side} data-chosen={chosen === s.side ? "true" : undefined}
                sx={{ opacity: chosen && chosen !== s.side && sides.length > 1 ? 0.45 : 1, transition: "opacity 120ms" }}>
                <Box component="th" scope="row" sx={sideSx}>{s.label}</Box>
                {showX && text(r >= 0 ? d.x?.[r] ?? "" : undefined, xDiff, { "data-col": "x" })}
                {showTitle && text(r >= 0 ? d.row_titles[r] ?? "" : undefined, titleDiff, { "data-col": "title" })}
                {cols.map((id) => {
                  const c = (d.col_ids ?? []).indexOf(id);
                  return Array.from({ length: nRep }, (_, k) => {
                    const has = r >= 0 && c >= 0;
                    const v = has ? d.cells[r]?.[c]?.[k] ?? "" : undefined;
                    const diff = diffCells.has(`${id}|${k}`) && items.some((i) => i.what === "cell" && i.colId === id && (i.rep ?? 0) === k && sideKey(i, s.side) !== null);
                    return <Fragment key={`${id}:${k}`}>{text(v, diff, { "data-col": id, "data-rep": String(k) })}</Fragment>;
                  });
                })}
              </Box>
            );
          })}
          {result && resultRow >= 0 && (
            <Box component="tr" data-side="result" data-testid="combine-conflict-result">
              <Box component="th" scope="row" sx={{ ...sideSx, fontStyle: "italic" }}>{resultLabel}</Box>
              {(() => {
                const cell = (col: string, k: number, key: string) => {
                  const v = valueIn(result, col, k) ?? "";
                  const ch = valueIn(chosenDoc, col, k);
                  const fromOther = chosenDoc !== null && ch !== undefined && v !== ch;
                  return (
                    <Box component="td" key={key} sx={{ ...cellSx, ...(fromOther ? otherSx : {}) }} data-testid="combine-conflict-cell" data-side="result"
                      data-col={col} data-rep={col === "x" || col === "title" ? undefined : String(k)} data-other={fromOther ? "true" : undefined}
                      title={fromOther ? F.fromOtherSide : undefined}>
                      {v}
                    </Box>
                  );
                };
                return [
                  ...(showX ? [cell("x", 0, "x")] : []),
                  ...(showTitle ? [cell("title", 0, "title")] : []),
                  ...cols.flatMap((id) => Array.from({ length: nRep }, (_, k) => cell(id, k, `${id}:${k}`))),
                ];
              })()}
            </Box>
          )}
        </tbody>
      </Box>
    </Box>
  );
}

/** Fixer VUX-1: values of one row that differ between the two sides but are not to choose (one side changed
 *  them): they are kept from that side whichever is chosen. */
export function rowOthersDiffer(rowId: string, sides: MiniSide[], items: readonly FineItem[]): number {
  const [a, b] = sides.map((x) => x.doc);
  if (!a || !b) return 0;
  const ra = (a.row_ids ?? []).indexOf(rowId), rb = (b.row_ids ?? []).indexOf(rowId);
  if (ra < 0 || rb < 0) return 0;
  const listed = new Set(items.map((i) => `${i.what}|${i.colId ?? ""}|${i.rep ?? 0}`));
  let n = 0;
  if ((a.row_titles[ra] ?? "") !== (b.row_titles[rb] ?? "") && !listed.has("rowTitle||0")) n++;
  if (a.template === "xy" && (a.x?.[ra] ?? "") !== (b.x?.[rb] ?? "") && !listed.has("x||0")) n++;
  (a.col_ids ?? []).forEach((cid, ca) => {
    const cb = (b.col_ids ?? []).indexOf(cid);
    if (cb < 0) return;
    const reps = Math.max(a.cells[ra]?.[ca]?.length ?? 0, b.cells[rb]?.[cb]?.length ?? 0);
    for (let k = 0; k < reps; k++) {
      if ((a.cells[ra]?.[ca]?.[k] ?? "") !== (b.cells[rb]?.[cb]?.[k] ?? "") && !listed.has(`cell|${cid}|${k}`)) n++;
    }
  });
  return n;
}
