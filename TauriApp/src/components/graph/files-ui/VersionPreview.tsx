/* The read-only preview of a selected version (phase 2 contract §6.1). It
   covers the workspace (which stays mounted underneath), not the document bar
   and not the Versions panel. */

import { useEffect, useRef, useState } from "react";
import { useGraphStore } from "../../../store/graphStore";
import { Box, Button, Chip, CircularProgress, Stack, Tab, Tabs, Tooltip, Typography } from "@mui/material";
import CompareArrowsIcon from "@mui/icons-material/CompareArrows";
import RestoreIcon from "@mui/icons-material/Restore";
import SaveAsOutlinedIcon from "@mui/icons-material/SaveAsOutlined";
import CloseIcon from "@mui/icons-material/Close";
import InsertChartOutlinedIcon from "@mui/icons-material/InsertChartOutlined";
import GridOnIcon from "@mui/icons-material/GridOn";
import CalculateOutlinedIcon from "@mui/icons-material/CalculateOutlined";
import { useFileSession } from "../file/session";
import { WORKING_ROW, type VersionsState } from "../file/contract";
import { CompareView } from "./CompareView";
import { ScratchGrid, VersionGraph, VersionTable } from "./ReadOnlyViews";
import { rowTimes } from "./VersionsPanel";
import { STATUS, V, whenText, whoText } from "./text";

type PreviewTab = "graph" | "table" | "scratch";

export function VersionPreview({ v }: { v: VersionsState }) {
  const settings = useFileSession((s) => s.settings);
  // Phase 3: while the analysis is read-only, nothing is written into it (viewing and comparing stay).
  const tabReadOnly = useFileSession((s) => { const t = s.tabs.find((x) => x.key === v.tabKey); return !!t && (!!t.readOnly || !!t.presence?.readOnly); });
  const [tab, setTab] = useState<PreviewTab>("graph");
  // "Compare with current" follows the current content (edits, a version brought back, a combine).
  const doc = useGraphStore((st) => st.doc);
  const analysis = useGraphStore((st) => st.analysis);
  const figure = useGraphStore((st) => st.figure);
  const scratch = useGraphStore((st) => st.scratch);
  const seen = useRef<unknown[]>([doc, analysis, figure, scratch]);
  useEffect(() => {
    const now = [doc, analysis, figure, scratch];
    if (now.every((x, i) => x === seen.current[i])) return;
    seen.current = now;
    if (!v.comparing) return;
    const h = setTimeout(() => {
      const s = useFileSession.getState();
      if (s.versions?.comparing && s.versions.preview && !s.versions.preview.loading) void s.compareWithCurrent(true);
    }, 400);
    return () => clearTimeout(h);
  }, [doc, analysis, figure, scratch, v.comparing]);
  const row = v.rows.find((r) => r.id === v.selectedId) ?? null;
  const p = v.preview;
  if (!row) return null;
  const when = whenText(rowTimes(v.rows, v.layout).get(row.id) ?? "");
  const who = row.id === WORKING_ROW ? "you" : row.who ? whoText(row.who, settings) : V.autoDevice.toLowerCase();
  const loading = !p || p.id !== row.id || p.loading;
  const content = !loading ? p!.content : null;
  const openable = row.openable && (loading || !!content);
  const isCurrent = row.chips.includes("current");
  const isWorking = row.id === WORKING_ROW;
  const busy = v.busy;
  const s = () => useFileSession.getState();
  const tabSx = { minHeight: 38, py: 0.5 };

  return (
    <Box data-testid="version-preview" data-id={row.id}
      sx={{ position: "absolute", inset: 0, zIndex: 3, bgcolor: "background.default", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ px: 2, pt: 1.25, pb: 0.75, minWidth: 0 }}>
        <Typography variant="subtitle1" noWrap sx={{ fontWeight: 600, minWidth: 0 }} data-testid="version-preview-title"
          title={V.previewTitle(row.summary, who, when)}>
          {V.previewTitle(row.summary, who, when)}
        </Typography>
        <Chip size="small" variant="outlined" label={V.readOnly} sx={{ height: 20, fontSize: 11, flexShrink: 0 }} />
        <Box sx={{ flexGrow: 1 }} />
        <Button size="small" color="inherit" startIcon={<CloseIcon />} data-testid="version-preview-close"
          onClick={() => void s().selectVersion(null)} sx={{ flexShrink: 0 }}>
          {V.closePreview}
        </Button>
      </Stack>
      <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" alignItems="center" sx={{ px: 2, pb: 1, borderBottom: 1, borderColor: "divider" }}>
        <Button size="small" variant={v.comparing ? "contained" : "outlined"} startIcon={<CompareArrowsIcon />} data-testid="version-compare"
          aria-pressed={v.comparing} disabled={!openable || loading}
          onClick={() => void s().compareWithCurrent()}>
          {V.compare}
        </Button>
        <Tooltip title={tabReadOnly ? STATUS.readOnlySave : ""}>
          <span onClick={() => { if (tabReadOnly) s().reportEditAttempt("command", "bringBack", v.tabKey); }}>
            <Button size="small" variant="outlined" startIcon={busy === "bringBack" ? <CircularProgress size={14} color="inherit" /> : <RestoreIcon />}
              data-testid="version-bring-back" disabled={!openable || loading || !!busy || isCurrent || isWorking || tabReadOnly}
              onClick={() => {
                // Once it is back, the workspace shows it: the read-only preview closes.
                void s().bringBack(row.id).then((out) => { if (out.ok && s().versions?.selectedId === row.id) void s().selectVersion(null); });
              }}>
              {V.bringBack}
            </Button>
          </span>
        </Tooltip>
        <Button size="small" variant="outlined" startIcon={busy === "saveAsNew" ? <CircularProgress size={14} color="inherit" /> : <SaveAsOutlinedIcon />}
          data-testid="version-save-as-new" disabled={!openable || loading || !!busy || isWorking}
          onClick={() => void s().saveVersionAsNew(row.id)}>
          {V.saveAsNew}
        </Button>
      </Stack>

      {!openable ? (
        <Box sx={{ flexGrow: 1, display: "grid", placeItems: "center", p: 3 }}>
          <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 420, textAlign: "center" }} data-testid="version-too-old">
            {V.tooOldBody}
          </Typography>
        </Box>
      ) : loading || !content ? (
        <Stack alignItems="center" justifyContent="center" spacing={1.5} sx={{ flexGrow: 1 }}>
          <CircularProgress size={24} />
          <Typography variant="body2" color="text.secondary">{V.loadingVersion}</Typography>
        </Stack>
      ) : v.comparing && p?.compare && p.current ? (
        <Box sx={{ flexGrow: 1, minHeight: 0, overflow: "auto", px: 2, pt: 1.5 }}>
          <CompareView compare={p.compare} content={content} current={p.current} />
        </Box>
      ) : v.comparing ? (
        <Stack alignItems="center" justifyContent="center" sx={{ flexGrow: 1 }}><CircularProgress size={24} /></Stack>
      ) : (
        <>
          <Box sx={{ px: 2, borderBottom: 1, borderColor: "divider" }}>
            <Tabs value={tab} onChange={(_, t) => setTab(t)} sx={tabSx}>
              <Tab value="graph" label={V.tabGraph} icon={<InsertChartOutlinedIcon sx={{ fontSize: 17 }} />} iconPosition="start" sx={tabSx} data-testid="version-tab-graph" />
              <Tab value="table" label={V.tabTable} icon={<GridOnIcon sx={{ fontSize: 17 }} />} iconPosition="start" sx={tabSx} data-testid="version-tab-table" />
              <Tab value="scratch" label={V.tabScratch} icon={<CalculateOutlinedIcon sx={{ fontSize: 17 }} />} iconPosition="start" sx={tabSx} data-testid="version-tab-scratch" />
            </Tabs>
          </Box>
          <Box sx={{ flexGrow: 1, minHeight: 0, overflow: "auto", p: 2 }}>
            {tab === "graph" && <VersionGraph content={content} maxHeight="calc(100vh - 300px)" testId="version-graph" />}
            {tab === "table" && <VersionTable doc={content.doc} testId="version-table" maxRows={500} />}
            {tab === "scratch" && <ScratchGrid scratch={content.scratch} />}
          </Box>
        </>
      )}
    </Box>
  );
}
