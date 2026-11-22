/* The Versions side panel (phase 2 contract §6.1–6.2): every version of the
   analysis, newest first, beside a git-style tree of lanes; chips; a legend of
   the computers; the "too old" footer line. Selecting a row opens the read-only
   preview over the workspace (VersionPreview). */

import { memo, useEffect, useMemo, useRef } from "react";
import { Box, Chip, CircularProgress, IconButton, Stack, Tooltip, Typography, alpha, useTheme } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import HistoryIcon from "@mui/icons-material/History";
import CallSplitIcon from "@mui/icons-material/CallSplit";
import { useFileSession } from "../file/session";
import { WORKING_ROW, type FileSettings, type LaneLayout, type VersionChip, type VersionRow, type VersionStub, type VersionsState } from "../file/contract";
import { LaneGraph, ROW_HEIGHT, deviceColor, graphWidth } from "./LaneGraph";
import { CHIP_TEXT, V, whenText } from "./text";

export const VERSIONS_PANEL_WIDTH = 380;

/** Time of each row for the "when" text. A version combined automatically has no author but its time is the
 *  later of its parents' times (contract §3.4.4), so it is worked out from the rows it joins. */
export function rowTimes(rows: readonly VersionRow[], layout: LaneLayout): Map<string, string> {
  const parents = new Map<string, string[]>();
  for (const e of layout.edges) parents.set(e.from, [...(parents.get(e.from) ?? []), e.to]);
  const own = new Map(rows.map((r) => [r.id, r.who?.time ?? ""] as const));
  const out = new Map<string, string>();
  // Rows are newest first, parents below: walk bottom-up so a parent is done before its child.
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    let t = own.get(r.id) ?? "";
    if (!t && r.id !== WORKING_ROW) {
      for (const p of parents.get(r.id) ?? []) { const pt = out.get(p) ?? ""; if (pt > t) t = pt; }
    }
    out.set(r.id, t);
  }
  return out;
}

/** "you · This Mac · 2 h ago" / "Alice · Office iMac · yesterday" / "Combined automatically · 2 h ago". */
export function rowMeta(r: VersionRow, when: string, settings: FileSettings | null): string {
  if (r.id === WORKING_ROW) return V.workingLine(settings?.deviceName ?? "");
  if (!r.who) return V.autoLine(when);
  const user = r.who.userName.trim();
  const me = r.who.mine || (!!user && !!settings && user === settings.userName.trim());
  const name = me ? "you" : user || "someone else";
  return V.rowLine(name, r.who.deviceName.trim(), when);
}

const CHIP_COLOR: Partial<Record<VersionChip, "primary" | "success" | "warning" | "default" | "info">> = {
  current: "primary", combined: "success", broughtBack: "info", unsaved: "warning",
};

function RowChips({ chips }: { chips: VersionChip[] }) {
  return (
    <>
      {chips.map((c) => (
        <Chip key={c} size="small" data-testid="version-chip" data-chip={c} label={CHIP_TEXT[c]}
          color={CHIP_COLOR[c] ?? "default"} variant={c === "current" || c === "unsaved" ? "filled" : "outlined"}
          sx={{ height: 17, fontSize: 10.5, flexShrink: 0, "& .MuiChip-label": { px: 0.6 }, ...(c === "tooOld" ? { color: "text.secondary" } : {}) }} />
      ))}
    </>
  );
}

const VersionRowView = memo(function VersionRowView({ row, meta, selected, stubs, onSelect, left }: {
  row: VersionRow; meta: string; selected: boolean; stubs: VersionStub[]; onSelect: (id: string) => void; left: number;
}) {
  const theme = useTheme();
  const tooOld = row.chips.includes("tooOld");
  const extra = [
    ...(row.copyName ? [V.copyLabel(row.copyName)] : []),
    ...stubs.map((s) => V.stubLabel(s.name)),
  ];
  const fullTitle = [row.summary, meta, ...extra].join("\n");
  return (
    <Box data-testid="version-row" data-id={row.id} role="listitem" aria-selected={selected} tabIndex={-1}
      onClick={() => onSelect(row.id)} title={fullTitle}
      sx={{
        height: ROW_HEIGHT, pl: `${left}px`, pr: 1.25, display: "flex", flexDirection: "column", justifyContent: "center", cursor: "pointer",
        bgcolor: selected ? alpha(theme.palette.primary.main, 0.16) : "transparent", borderRadius: 1,
        "&:hover": { bgcolor: selected ? alpha(theme.palette.primary.main, 0.2) : "action.hover" },
      }}>
      <Stack direction="row" spacing={0.5} alignItems="center" sx={{ minWidth: 0 }}>
        <Typography variant="body2" noWrap sx={{
          fontSize: 12.5, fontWeight: row.chips.includes("current") ? 600 : 500, minWidth: 0, flexShrink: 1,
          color: tooOld ? "text.secondary" : "text.primary", fontStyle: row.foreign ? "italic" : "normal",
        }}>
          {row.summary}
        </Typography>
        <Box sx={{ flexGrow: 1 }} />
        <RowChips chips={row.chips} />
      </Stack>
      <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
        <Typography variant="caption" color="text.secondary" noWrap sx={{ fontSize: 11, minWidth: 0, flexShrink: 1 }}>{meta}</Typography>
        {extra.length > 0 && <Box sx={{ flexGrow: 1 }} />}
        {row.copyName && (
          <Typography variant="caption" noWrap data-testid="version-copy-label" sx={{ fontSize: 10.5, color: "text.secondary", border: 1, borderStyle: "dashed", borderColor: "divider", borderRadius: 0.75, px: 0.5, maxWidth: 150, flexShrink: 0 }}>
            {V.copyLabel(row.copyName)}
          </Typography>
        )}
        {stubs.map((s) => (
          <Stack key={s.path} direction="row" spacing={0.25} alignItems="center" data-testid="lane-stub-label" sx={{ maxWidth: 170, flexShrink: 0, color: "text.secondary" }}>
            <CallSplitIcon sx={{ fontSize: 12 }} />
            <Typography variant="caption" noWrap sx={{ fontSize: 10.5 }} title={s.path}>{V.stubLabel(s.name)}</Typography>
          </Stack>
        ))}
      </Stack>
    </Box>
  );
});

function Legend({ v }: { v: VersionsState }) {
  const hasAuto = v.layout.rows.some((r) => r.colorIndex < 0);
  if (!v.devices.length && !hasAuto) return null;
  return (
    <Box sx={{ px: 1.5, py: 0.75, borderTop: 1, borderColor: "divider" }} data-testid="versions-legend">
      <Typography variant="overline" color="text.secondary" sx={{ lineHeight: 1.6, fontSize: 10 }}>{V.legend}</Typography>
      <Stack direction="row" useFlexGap flexWrap="wrap" columnGap={1.5} rowGap={0.25}>
        {v.devices.map((d, i) => (
          <Stack key={d.deviceId} direction="row" spacing={0.5} alignItems="center" data-testid="legend-device" data-color={i}>
            <Box sx={{ width: 9, height: 9, borderRadius: "50%", bgcolor: deviceColor(i), flexShrink: 0 }} />
            <Typography variant="caption" noWrap sx={{ fontSize: 11.5 }}>
              {d.deviceName || "Another computer"}{d.mine ? ` (${V.thisComputer})` : ""}
            </Typography>
          </Stack>
        ))}
        {hasAuto && (
          <Stack direction="row" spacing={0.5} alignItems="center" data-testid="legend-device" data-color={-1}>
            <Box sx={{ width: 9, height: 9, borderRadius: "50%", bgcolor: deviceColor(-1), flexShrink: 0 }} />
            <Typography variant="caption" noWrap sx={{ fontSize: 11.5, color: "text.secondary" }}>{V.autoDevice}</Typography>
          </Stack>
        )}
      </Stack>
    </Box>
  );
}

/** Right-hand panel beside the workspace while the Versions button is pressed (not modal). */
export function VersionsPanel({ v }: { v: VersionsState }) {
  const settings = useFileSession((s) => s.settings);
  const currentId = useFileSession((s) => s.tabs.find((t) => t.key === v.tabKey)?.baseRevision ?? null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // The list follows the tab: unsaved changes appear / go, newer versions arrive, banners change.
  const tabSig = useFileSession((s) => {
    const t = s.tabs.find((x) => x.key === v.tabKey);
    return t ? `${t.dirty}|${t.baseRevision}|${t.path}|${t.banners.map((b) => `${b.id}:${b.kind}`).join(",")}` : "";
  });
  const firstSig = useRef(tabSig);
  useEffect(() => {
    if (tabSig === firstSig.current) return;
    firstSig.current = tabSig;
    const h = setTimeout(() => {
      const s = useFileSession.getState();
      if (s.versions?.tabKey === v.tabKey && s.activeKey === v.tabKey) void s.openVersions(v.tabKey);
    }, 250);
    return () => clearTimeout(h);
  }, [tabSig, v.tabKey]);
  const times = useMemo(() => rowTimes(v.rows, v.layout), [v.rows, v.layout]);
  const faded = useMemo(() => new Set(v.rows.filter((r) => r.chips.includes("tooOld")).map((r) => r.id)), [v.rows]);
  const stubsByRow = useMemo(() => {
    const m = new Map<string, VersionStub[]>();
    for (const s of v.stubs) m.set(s.from, [...(m.get(s.from) ?? []), s]);
    return m;
  }, [v.stubs]);
  const left = graphWidth(v.layout, v.stubs) + 4;
  const select = (id: string) => {
    const s = useFileSession.getState();
    void s.selectVersion(s.versions?.selectedId === id ? null : id);
  };

  // Keep the selected row in view (e.g. after "What changed").
  useEffect(() => {
    if (!v.selectedId || !listRef.current) return;
    const i = v.rows.findIndex((r) => r.id === v.selectedId);
    if (i < 0) return;
    const el = listRef.current;
    const top = i * ROW_HEIGHT;
    if (top < el.scrollTop || top + ROW_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTop = Math.max(0, top - el.clientHeight / 3);
  }, [v.selectedId, v.rows]);

  // Up / Down move the selection while the list has focus.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const i = v.rows.findIndex((r) => r.id === v.selectedId);
    const next = v.rows[Math.max(0, Math.min(v.rows.length - 1, i < 0 ? 0 : i + (e.key === "ArrowDown" ? 1 : -1)))];
    if (next && next.id !== v.selectedId) void useFileSession.getState().selectVersion(next.id);
  };

  return (
    <Box data-testid="versions-panel" role="complementary" aria-label={V.title}
      sx={{ width: VERSIONS_PANEL_WIDTH, flexShrink: 0, display: "flex", flexDirection: "column", minHeight: 0, borderLeft: 1, borderColor: "divider", bgcolor: "background.default" }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ px: 1.5, height: 40, flexShrink: 0, borderBottom: 1, borderColor: "divider" }}>
        <HistoryIcon sx={{ fontSize: 18, color: "text.secondary" }} />
        <Typography variant="subtitle2" sx={{ fontWeight: 600, flexGrow: 1 }} noWrap>
          {V.title}
          <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>{v.rows.length || ""}</Typography>
        </Typography>
        {v.loading && v.rows.length > 0 && <CircularProgress size={12} />}
        <Tooltip title={V.close}>
          <IconButton size="small" aria-label={V.close} data-testid="versions-close" onClick={() => useFileSession.getState().closeVersions()}>
            <CloseIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Tooltip>
      </Stack>
      {v.rows.length === 0 ? (
        <Stack alignItems="center" justifyContent="center" spacing={1} sx={{ flexGrow: 1 }} data-testid="versions-loading">
          {v.loading && <CircularProgress size={20} />}
          <Typography variant="body2" color="text.secondary">{V.loading}</Typography>
        </Stack>
      ) : (
        <Box ref={listRef} role="list" aria-label={V.title} tabIndex={0} onKeyDown={onKeyDown} data-testid="versions-list"
          sx={{ flexGrow: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", outline: "none", py: 0.5 }}>
          <Box sx={{ position: "relative", minHeight: v.rows.length * ROW_HEIGHT }}>
            <LaneGraph layout={v.layout} stubs={v.stubs} selectedId={v.selectedId} faded={faded} currentId={currentId} />
            {v.rows.map((r) => (
              <VersionRowView key={r.id} row={r} meta={rowMeta(r, whenText(times.get(r.id) ?? ""), settings)} selected={r.id === v.selectedId}
                stubs={stubsByRow.get(r.id) ?? []} onSelect={select} left={left} />
            ))}
          </Box>
        </Box>
      )}
      <Legend v={v} />
      {v.tooOld > 0 && (
        <Typography variant="caption" color="text.secondary" component="div" data-testid="versions-too-old"
          sx={{ px: 1.5, py: 0.75, borderTop: 1, borderColor: "divider", flexShrink: 0 }}>
          {V.tooOldFooter}
        </Typography>
      )}
    </Box>
  );
}

