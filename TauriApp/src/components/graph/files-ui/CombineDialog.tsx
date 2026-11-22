/* The combine dialog (phase 2 contract §6.4, plan §9.3): part by part, what
   each side changed, a choice where both changed the same part, a side-by-side
   view of the focused part. Nothing is written until Apply. */

import { useMemo, useState } from "react";
import {
  Alert, Box, Button, ButtonGroup, Chip, CircularProgress, Collapse, Dialog, DialogActions, DialogContent, DialogTitle,
  Stack, Typography, alpha, useTheme,
} from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import { useFileSession } from "../file/session";
import type { CombineSectionView, CombineState, CompareResult } from "../file/contract";
import type { SectionName } from "../file/format";
import type { DocContent } from "../../../store/graphStore";
import { cellMarks, fieldLabel, shortValue, tableChangeLines } from "./CompareView";
import { ScratchGrid, VersionGraph, VersionTable } from "./ReadOnlyViews";
import { C, SECTION_TITLE, sectionPhrases, theirsLabel, whenText, whoLine } from "./text";

function statusChip(sec: CombineSectionView) {
  if (sec.status === "same") return <Chip size="small" label={C.unchanged} variant="outlined" sx={{ height: 18, fontSize: 10.5 }} />;
  if (sec.status === "both") return <Chip size="small" label={C.chooseChip} color="warning" sx={{ height: 18, fontSize: 10.5 }} />;
  return <Chip size="small" label={C.combinedChip} color="success" variant="outlined" sx={{ height: 18, fontSize: 10.5 }} />;
}

function SectionRow({ sec, focused, onFocus, theirsName, whoTheirs, disabled, mineName = C.mineButton, fromMine = C.fromMine }: {
  sec: CombineSectionView; focused: boolean; onFocus: () => void; theirsName: string; whoTheirs: string; disabled: boolean;
  mineName?: string; fromMine?: string;
}) {
  const theme = useTheme();
  const pick = (c: "mine" | "theirs") => void useFileSession.getState().setSectionChoice(sec.key, c);
  const sub = sec.status === "mine" ? fromMine : sec.status === "theirs" ? C.fromTheirs(whoTheirs) : null;
  return (
    <Box data-testid="combine-section" data-key={sec.key} data-status={sec.status} data-choice={sec.choice ?? ""} onClick={onFocus}
      sx={{
        px: 1.25, py: 0.75, borderRadius: 1, cursor: "pointer", border: 1,
        borderColor: focused ? "primary.main" : "transparent",
        bgcolor: focused ? alpha(theme.palette.primary.main, 0.08) : sec.status === "both" && !sec.choice ? alpha(theme.palette.warning.main, 0.07) : "transparent",
        "&:hover": { bgcolor: focused ? alpha(theme.palette.primary.main, 0.1) : "action.hover" },
      }}>
      <Stack direction="row" spacing={1} alignItems="center">
        <Typography variant="body2" sx={{ fontWeight: 600, flexGrow: 1, minWidth: 0 }} noWrap>{SECTION_TITLE[sec.key]}</Typography>
        {statusChip(sec)}
      </Stack>
      {sub && <Typography variant="caption" color="text.secondary" component="div">{sub}</Typography>}
      {sec.status !== "same" && (
        <ButtonGroup size="small" sx={{ mt: 0.75 }} disabled={disabled} onClick={(e) => e.stopPropagation()}>
          <Button data-testid="combine-pick-mine" variant={sec.choice === "mine" ? "contained" : "outlined"} onClick={() => pick("mine")}
            aria-pressed={sec.choice === "mine"} sx={{ textTransform: "none", minWidth: 72 }}>
            {mineName}
          </Button>
          <Button data-testid="combine-pick-theirs" variant={sec.choice === "theirs" ? "contained" : "outlined"} onClick={() => pick("theirs")}
            aria-pressed={sec.choice === "theirs"} sx={{ textTransform: "none", minWidth: 72 }}>
            {theirsName}
          </Button>
        </ButtonGroup>
      )}
    </Box>
  );
}

function Group({ label, open, onToggle, testId, children }: { label: string; open: boolean; onToggle: () => void; testId: string; children: React.ReactNode }) {
  return (
    <Box data-testid={testId} data-open={open ? "true" : "false"}>
      <Button size="small" color="inherit" onClick={onToggle} startIcon={open ? <ExpandMoreIcon /> : <ChevronRightIcon />}
        sx={{ textTransform: "none", color: "text.secondary", px: 0.5, fontWeight: 500 }}>
        {label}
      </Button>
      <Collapse in={open} unmountOnExit><Stack spacing={0.5} sx={{ pl: 0.5 }}>{children}</Stack></Collapse>
    </Box>
  );
}

/** The two sides of one part. `cmp` = theirs (a) against mine (b). */
function SidePane({ k, cmp, mine, theirs, mineLabel, theirsLabelText }: {
  k: SectionName; cmp: CompareResult; mine: DocContent; theirs: DocContent; mineLabel: string; theirsLabelText: string;
}) {
  const same = cmp.sections.find((x) => x.key === k)?.same ?? false;
  const marksMine = useMemo(() => cellMarks(cmp, "b"), [cmp]);
  const marksTheirs = useMemo(() => cellMarks(cmp, "a"), [cmp]);
  const settings = k === "analysis" || k === "figure" ? cmp.settings.filter((x) => x.section === k) : [];
  const col = (label: string, body: React.ReactNode) => (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary" component="div" noWrap title={label} sx={{ mb: 0.5, fontWeight: 600 }}>{label}</Typography>
      {body}
    </Box>
  );
  let summary: string | null = null;
  if (same) summary = C.sectionSame;
  else if (k === "table") summary = tableChangeLines(cmp.table).join(" · ") || C.noTableChange;
  else if (k === "scratchpad") summary = C.scratchCells(cmp.scratchpadCells);
  const sides: [string, "b" | "a", DocContent][] = [[mineLabel, "b", mine], [theirsLabelText, "a", theirs]];
  return (
    <Stack spacing={1.25} data-testid="combine-compare" data-key={k}>
      <Stack direction="row" spacing={1} alignItems="baseline">
        <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>{SECTION_TITLE[k]}</Typography>
        {summary && <Typography variant="caption" color="text.secondary">{summary}</Typography>}
      </Stack>
      <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1.5, alignItems: "start" }}>
        {sides.map(([label, side, c]) => (
          <Box key={side} sx={{ minWidth: 0 }}>
            {col(label, (
              k === "table" ? (
                <VersionTable doc={c.doc} marks={side === "b" ? marksMine : marksTheirs} otherLabel={side === "b" ? theirsLabelText : mineLabel}
                  dense maxRows={60} onlyMarked={cmp.table.cells.length > 0 && c.doc.cells.length > 60} testId={`combine-table-${side === "b" ? "mine" : "theirs"}`} />
              ) : k === "figure" ? (
                <Stack spacing={0.75}>
                  <VersionGraph content={c} maxHeight="34vh" testId={`combine-graph-${side === "b" ? "mine" : "theirs"}`} />
                  {settings.map((x) => (
                    <Typography key={x.field} variant="caption" component="div">{fieldLabel(x.field)}: {shortValue(side === "b" ? x.b : x.a)}</Typography>
                  ))}
                </Stack>
              ) : k === "analysis" ? (
                <Stack spacing={0.25}>
                  {settings.length === 0 && <Typography variant="caption" color="text.secondary">{C.noSettingsChange}</Typography>}
                  {settings.map((x) => (
                    <Typography key={x.field} variant="body2" sx={{ fontSize: 12.5 }}>{fieldLabel(x.field)}: {shortValue(side === "b" ? x.b : x.a)}</Typography>
                  ))}
                </Stack>
              ) : (
                <ScratchGrid scratch={c.scratch} maxRows={30} maxCols={8} />
              )
            ))}
          </Box>
        ))}
      </Box>
    </Stack>
  );
}

function initialFocus(s: CombineState): SectionName {
  return (s.sections.find((x) => x.status === "both") ?? s.sections.find((x) => x.status !== "same") ?? s.sections[0])?.key ?? "table";
}

export function CombineDialog({ s }: { s: CombineState }) {
  const settings = useFileSession((st) => st.settings);
  const [focus, setFocus] = useState<SectionName>(() => initialFocus(s));
  const [autoOpen, setAutoOpen] = useState(false);
  const [sameOpen, setSameOpen] = useState(false);
  // Combining with my own save that another computer's save replaced: "mine" (the tab) holds the other
  // computer's version, so the sides are named by what they are, never "Mine" / "Theirs".
  const ownReplaced = s.source.kind === "journal" && s.theirs.mine;
  const whoTheirs = ownReplaced ? "your save" : whoLine(s.theirs, settings);
  const theirsName = ownReplaced ? C.replacedSaveButton : theirsLabel(s.theirs, settings);
  const mineName = ownReplaced ? C.nowInFileButton : C.mineButton;
  const fromMine = ownReplaced ? `from ${C.nowInFileButton.toLowerCase()}` : C.fromMine;
  const computer = s.mine.deviceName || settings?.deviceName || "";
  const twoWay = s.twoWay || !s.since;
  const title = twoWay ? C.titleTwoWay(s.name) : C.title(s.name, whenText(s.since?.time) || "earlier");
  const choose = s.sections.filter((x) => x.status === "both");
  const auto = s.sections.filter((x) => x.status === "mine" || x.status === "theirs");
  const same = s.sections.filter((x) => x.status === "same");
  const left = choose.filter((x) => !x.choice).length;
  const st = () => useFileSession.getState();
  const cancel = () => { if (!s.applying) st().cancelCombine(); };
  const focusedSec = s.sections.find((x) => x.key === focus) ?? s.sections[0];
  const mineLabel = ownReplaced ? C.sideNowInFile : C.sideLabel(C.sideMine, computer || "this computer");
  const theirsSide = ownReplaced ? C.sideReplaced : C.sideLabel(C.sideTheirs, s.source.kind === "copy" && s.copyName ? `'${s.copyName}'` : whoTheirs);
  const row = (sec: CombineSectionView) => (
    <SectionRow key={sec.key} sec={sec} focused={focus === sec.key} onFocus={() => setFocus(sec.key)}
      theirsName={theirsName} whoTheirs={whoTheirs} disabled={s.applying} mineName={mineName} fromMine={fromMine} />
  );

  return (
    <Dialog open onClose={cancel} maxWidth={false} fullWidth
      slotProps={{ paper: { "data-testid": "combine-dialog", sx: { width: "min(1080px, calc(100vw - 48px))", height: "min(760px, calc(100vh - 48px))" } } as object }}>
      <DialogTitle sx={{ pb: 0.5 }}>
        <Stack direction="row" spacing={1.5} alignItems="center">
          <Typography variant="h6" component="span" sx={{ fontSize: 17, fontWeight: 600, flexGrow: 1, minWidth: 0 }} noWrap title={title} data-testid="combine-title">
            {title}
          </Typography>
          {s.total > 1 && <Chip size="small" label={C.queue(s.index, s.total)} data-testid="combine-queue" sx={{ flexShrink: 0 }} />}
          {left > 0 && <Chip size="small" color="warning" variant="outlined" label={C.toChoose(left)} data-testid="combine-to-choose" sx={{ flexShrink: 0 }} />}
        </Stack>
        <Stack direction="row" spacing={2} sx={{ mt: 0.5 }}>
          <Typography variant="caption" color="text.secondary" data-testid="combine-mine">
            {ownReplaced ? C.nowInFile(whoLine(s.mine, settings), s.mineUnsaved) : C.mine(computer, s.mineUnsaved)}
          </Typography>
          <Typography variant="caption" color="text.secondary" data-testid="combine-theirs">
            {ownReplaced ? C.replacedSave(whenText(s.theirs.time)) : s.source.kind === "copy" && s.copyName ? C.theirsCopy(s.copyName, whoTheirs) : C.theirs(whoTheirs)}
          </Typography>
        </Stack>
      </DialogTitle>
      <DialogContent dividers sx={{ display: "flex", gap: 2, p: 0, minHeight: 0 }}>
        <Box sx={{ width: 300, flexShrink: 0, borderRight: 1, borderColor: "divider", overflowY: "auto", p: 1.5 }}>
          <Stack spacing={1}>
            {twoWay && <Alert severity="info" data-testid="combine-twoway" sx={{ py: 0, fontSize: 12.5 }}>{C.twoWay}</Alert>}
            {choose.map(row)}
            {auto.length > 0 && (
              <Group label={C.combinedAuto(auto.length)} open={autoOpen || auto.some((x) => x.key === focus && choose.length === 0)}
                onToggle={() => setAutoOpen((o) => !o)} testId="combine-auto-group">
                {auto.map(row)}
              </Group>
            )}
            {same.length > 0 && (
              <Group label={C.notChanged(same.length)} open={sameOpen} onToggle={() => setSameOpen((o) => !o)} testId="combine-same-group">
                {same.map(row)}
              </Group>
            )}
          </Stack>
        </Box>
        <Box sx={{ flexGrow: 1, minWidth: 0, overflowY: "auto", p: 2 }}>
          {focusedSec && (
            <SidePane k={focusedSec.key} cmp={s.compare} mine={s.mineContent} theirs={s.theirsContent} mineLabel={mineLabel} theirsLabelText={theirsSide} />
          )}
        </Box>
      </DialogContent>
      {(s.adjusted.length > 0 || s.error) && (
        <Box sx={{ px: 3, pt: 1.25 }}>
          <Stack spacing={1}>
            {s.adjusted.length > 0 && <Alert severity="warning" data-testid="combine-adjusted" sx={{ py: 0 }}>{C.adjusted(sectionPhrases(s.adjusted))}</Alert>}
            {s.error && <Alert severity="error" data-testid="combine-error" sx={{ py: 0 }}>{s.error}</Alert>}
          </Stack>
        </Box>
      )}
      <DialogActions sx={{ px: 3, py: 1.5 }}>
        <Typography variant="caption" color="text.secondary" sx={{ mr: "auto", maxWidth: 420 }}>{C.footnote}</Typography>
        <Button color="inherit" data-testid="combine-cancel" disabled={s.applying} onClick={cancel}>{C.cancel}</Button>
        <Button color="inherit" variant="outlined" data-testid="combine-keep-both" disabled={s.applying}
          onClick={() => void st().keepBothAsSeparate()}>
          {C.keepBoth}
        </Button>
        <Button variant="contained" data-testid="combine-apply" disabled={!s.canApply || s.applying}
          startIcon={s.applying ? <CircularProgress size={14} color="inherit" /> : undefined}
          onClick={() => void st().applyCombine()}>
          {C.apply}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
