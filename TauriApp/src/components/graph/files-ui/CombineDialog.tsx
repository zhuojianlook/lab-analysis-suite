/* The combine dialog (phase 2 contract §6.4, phase 4 contract §6.1, plan §9.3):
   part by part, what was combined and what is left to choose — per row of the
   table, per setting, per scratchpad cell, or one whole choice — with a
   side-by-side view of the focused part. Nothing is written until Apply. */

import { useMemo, useState, type KeyboardEvent } from "react";
import {
  Alert, Box, Button, ButtonGroup, Chip, CircularProgress, Collapse, Dialog, DialogActions, DialogContent, DialogTitle,
  Stack, Typography, alpha, useTheme,
} from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import { useFileSession } from "../file/session";
import type { CombineSectionViewP4, CombineState, CombineStateP4, FileSettings } from "../file/contract";
import type { SectionName } from "../file/format";
import { SectionPane, makeTextCtx, type DialogNames, type PaneCtx } from "./CombineFine";
import { C, F, SECTION_TITLE, adjustmentLine, sectionPhrases, theirsLabel, whenText, whoLine } from "./text";

/** The phase 2 fields a phase 4 dialog state always has; a plain CombineState is read as one with nothing to choose inside. */
export function asP4(s: CombineState): CombineStateP4 {
  const p = s as Partial<CombineStateP4> & CombineState;
  return {
    ...p,
    sections: s.sections.map((x) => {
      const y = x as Partial<CombineSectionViewP4> & typeof x;
      return {
        ...y, level: y.level ?? "whole", conflicts: y.conflicts ?? [], choices: y.choices ?? {},
        left: y.left ?? (x.status === "both" && !x.choice ? 1 : 0), combined: y.combined ?? 0, auto: y.auto ?? [], orderChecks: y.orderChecks ?? [],
      };
    }),
    adjustments: p.adjustments ?? [],
    toChoose: p.toChoose ?? s.sections.filter((x) => x.status === "both" && !x.choice).length,
    combinedCount: p.combinedCount ?? s.sections.filter((x) => x.status === "mine" || x.status === "theirs").length,
    resultContent: p.resultContent ?? null,
  };
}

/** The short name of the other side in brackets ("(Alice)"): the person, else the computer, else "theirs". */
function theirsShortOf(s: CombineStateP4, settings: FileSettings | null): string {
  const u = s.theirs.userName.trim();
  if (u && !(settings && u === settings.userName.trim())) return u;
  return s.theirs.deviceName.trim() || F.theirsWord;
}

function statusChip(sec: CombineSectionViewP4) {
  const sx = { height: 18, fontSize: 10.5 };
  if (sec.left > 0) return <Chip key="left" size="small" label={C.toChoose(sec.left)} color="warning" sx={sx} data-testid="combine-section-chip" />;
  if (sec.status === "same") return <Chip key="same" size="small" label={C.unchanged} variant="outlined" sx={sx} data-testid="combine-section-chip" />;
  return <Chip key="done" size="small" label={C.combinedChip} color="success" variant="outlined" sx={sx} data-testid="combine-section-chip" />;
}

/** The sub-line of a part: where it comes from as a whole, or how many changes were combined inside it. */
function subLine(sec: CombineSectionViewP4, n: DialogNames): string | null {
  if (sec.status === "same") return null;
  const from = (c: string | null | undefined) =>
    c === "mine" ? n.fromMine : c === "theirs" ? C.fromTheirs(n.whoTheirs) : c === "both" ? F.sideBySideChosen : null;
  const whole = sec.conflicts.find((c) => c.kind === "section");
  if (whole) return from(sec.choices[whole.id]);
  if (sec.level === "fine") return sec.choice ? from(sec.choice) : sec.combined > 0 ? F.changesCombined(sec.combined) : null;
  return from(sec.choice ?? (sec.status === "mine" || sec.status === "theirs" ? sec.status : null));
}

function SectionRow({ sec, focused, onFocus, names, disabled }: {
  sec: CombineSectionViewP4; focused: boolean; onFocus: () => void; names: DialogNames; disabled: boolean;
}) {
  const theme = useTheme();
  const pick = (c: "mine" | "theirs") => void useFileSession.getState().setSectionChoice(sec.key, c);
  const sub = subLine(sec, names);
  // Whole-part buttons only for a part without anything to choose inside: taken from one side (to turn round an
  // automatic pick), or — next to an app that combines whole parts only — a part both changed.
  const buttons = sec.conflicts.length === 0 && (sec.status === "mine" || sec.status === "theirs" || (sec.status === "both" && sec.level === "whole"));
  const key = (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onFocus(); } };
  return (
    <Box data-testid="combine-section" data-key={sec.key} data-status={sec.status} data-choice={sec.choice ?? ""}
      data-level={sec.level} data-left={sec.left}
      role="button" tabIndex={0} aria-current={focused ? "true" : undefined} onClick={onFocus} onKeyDown={key}
      sx={{
        px: 1.25, py: 0.75, borderRadius: 1, cursor: "pointer", border: 1, outline: "none",
        borderColor: focused ? "primary.main" : "transparent",
        bgcolor: focused ? alpha(theme.palette.primary.main, 0.08) : sec.left > 0 ? alpha(theme.palette.warning.main, 0.07) : "transparent",
        "&:hover": { bgcolor: focused ? alpha(theme.palette.primary.main, 0.1) : "action.hover" },
        "&:focus-visible": { boxShadow: `0 0 0 2px ${theme.palette.primary.main}` },
      }}>
      <Stack direction="row" spacing={1} alignItems="center">
        <Typography variant="body2" sx={{ fontWeight: 600, flexGrow: 1, minWidth: 0 }} noWrap>{SECTION_TITLE[sec.key]}</Typography>
        {statusChip(sec)}
      </Stack>
      {sub && <Typography variant="caption" color="text.secondary" component="div" data-testid="combine-section-sub">{sub}</Typography>}
      {buttons && (
        <ButtonGroup size="small" sx={{ mt: 0.75 }} disabled={disabled} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <Button data-testid="combine-pick-mine" variant={sec.choice === "mine" ? "contained" : "outlined"} onClick={() => pick("mine")}
            aria-pressed={sec.choice === "mine"} sx={{ textTransform: "none", minWidth: 72 }}>
            {names.mineName}
          </Button>
          <Button data-testid="combine-pick-theirs" variant={sec.choice === "theirs" ? "contained" : "outlined"} onClick={() => pick("theirs")}
            aria-pressed={sec.choice === "theirs"} sx={{ textTransform: "none", minWidth: 72 }}>
            {names.theirsName}
          </Button>
        </ButtonGroup>
      )}
    </Box>
  );
}

function Group({ label, open, onToggle, testId, children }: { label: string; open: boolean; onToggle: () => void; testId: string; children: React.ReactNode }) {
  return (
    <Box data-testid={testId} data-open={open ? "true" : "false"}>
      <Button size="small" color="inherit" onClick={onToggle} aria-expanded={open} startIcon={open ? <ExpandMoreIcon /> : <ChevronRightIcon />}
        sx={{ textTransform: "none", color: "text.secondary", px: 0.5, fontWeight: 500 }}>
        {label}
      </Button>
      <Collapse in={open} unmountOnExit><Stack spacing={0.5} sx={{ pl: 0.5 }}>{children}</Stack></Collapse>
    </Box>
  );
}

function initialFocus(s: CombineStateP4): SectionName {
  return (s.sections.find((x) => x.conflicts.length > 0 || (x.status === "both" && x.level === "whole"))
    ?? s.sections.find((x) => x.orderChecks.some((o) => o.matters))
    ?? s.sections.find((x) => x.status === "both")
    ?? s.sections.find((x) => x.status !== "same")
    ?? s.sections[0])?.key ?? "table";
}

export function CombineDialog({ s: raw }: { s: CombineState }) {
  const s = useMemo(() => asP4(raw), [raw]);
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
  const computer = s.mine.deviceName || settings?.deviceName || "";
  const names: DialogNames = {
    mineName, theirsName,
    mineWord: ownReplaced ? F.inTheFileNow : F.mineWord,
    theirsWord: ownReplaced ? F.yourSave : theirsName === "Theirs" ? F.theirsWord : theirsName,
    whoTheirs,
    mineLabel: ownReplaced ? C.sideNowInFile : C.sideLabel(C.sideMine, computer || "this computer"),
    theirsLabel: ownReplaced ? C.sideReplaced : C.sideLabel(C.sideTheirs, s.source.kind === "copy" && s.copyName ? `'${s.copyName}'` : whoTheirs),
    fromMine: ownReplaced ? `from ${C.nowInFileButton.toLowerCase()}` : C.fromMine,
  };
  const text = useMemo(() => makeTextCtx(s, {
    mineShort: ownReplaced ? F.inTheFileNow : F.mineWord,
    theirsShort: ownReplaced ? F.yourSave : theirsShortOf(s, settings),
    minePhrase: ownReplaced ? F.by(whoLine(s.mine, settings)) : F.onThisComputer,
    theirsPhrase: ownReplaced ? F.inYourSave : F.by(whoTheirs),
  }), [s, ownReplaced, settings, whoTheirs]);
  const ctx: PaneCtx = { s, names, text, disabled: s.applying };
  const twoWay = s.twoWay || !s.since;
  const title = twoWay ? C.titleTwoWay(s.name) : C.title(s.name, whenText(s.since?.time) || "earlier");
  // Parts with something to choose first (they stay there while choices are made); the rest that changed, then the unchanged ones.
  const choose = s.sections.filter((x) => x.conflicts.length > 0 || (x.status === "both" && x.level === "whole"));
  const auto = s.sections.filter((x) => x.status !== "same" && !choose.includes(x));
  const same = s.sections.filter((x) => x.status === "same");
  const anyToChoose = choose.length > 0;
  const st = () => useFileSession.getState();
  const cancel = () => { if (!s.applying) st().cancelCombine(); };
  const focusedSec = s.sections.find((x) => x.key === focus) ?? s.sections[0];
  const row = (sec: CombineSectionViewP4) => (
    <SectionRow key={sec.key} sec={sec} focused={focus === sec.key} onFocus={() => setFocus(sec.key)} names={names} disabled={s.applying} />
  );
  const adjustments = s.adjustments;

  return (
    // Fixer VUX-3: a click beside the window does not close it (it would drop the choices made); Esc and Cancel do.
    <Dialog open onClose={(_e, reason) => { if (reason !== "backdropClick") cancel(); }} maxWidth={false} fullWidth aria-labelledby="combine-title"
      slotProps={{ paper: { "data-testid": "combine-dialog", sx: { width: "min(1240px, calc(100vw - 48px))", height: "min(860px, calc(100vh - 48px))" } } as object }}>
      <DialogTitle sx={{ pb: 0.5 }}>
        <Stack direction="row" spacing={1.5} alignItems="center">
          <Typography id="combine-title" variant="h6" component="span" sx={{ fontSize: 17, fontWeight: 600, flexGrow: 1, minWidth: 0 }} noWrap title={title} data-testid="combine-title">
            {title}
          </Typography>
          {s.total > 1 && <Chip size="small" label={C.queue(s.index, s.total)} data-testid="combine-queue" sx={{ flexShrink: 0 }} />}
          {anyToChoose && (
            <Chip size="small" color={s.toChoose > 0 ? "warning" : "success"} variant="outlined" label={C.toChoose(s.toChoose)}
              data-testid="combine-to-choose" data-count={s.toChoose} sx={{ flexShrink: 0 }} />
          )}
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
      <DialogContent dividers sx={{ display: "flex", gap: 0, p: 0, minHeight: 0 }}>
        <Box component="nav" aria-label="Parts" sx={{ width: 280, flexShrink: 0, borderRight: 1, borderColor: "divider", overflowY: "auto", p: 1.5 }}>
          <Stack spacing={1}>
            {twoWay && <Alert severity="info" data-testid="combine-twoway" sx={{ py: 0, fontSize: 12.5 }}>{C.twoWay}</Alert>}
            {choose.map(row)}
            {auto.length > 0 && (
              <Group label={F.combinedParts(auto.length)} open={autoOpen || (auto.some((x) => x.key === focus) && choose.length === 0)}
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
        <Box sx={{ flexGrow: 1, minWidth: 0, overflowY: "auto", p: 2 }} data-testid="combine-pane">
          {focusedSec && <SectionPane key={focusedSec.key} sec={focusedSec} ctx={ctx} />}
        </Box>
      </DialogContent>
      {(adjustments.length > 0 || s.adjusted.length > 0 || s.error) && (
        <Box sx={{ px: 3, pt: 1.25 }}>
          <Stack spacing={1}>
            {adjustments.length > 0 ? (
              <Alert severity="warning" data-testid="combine-adjusted" data-count={adjustments.length} sx={{ py: 0.25, "& .MuiAlert-message": { width: "100%" } }}>
                <Typography variant="body2" sx={{ fontWeight: 600, fontSize: 13 }}>{F.adjustedTitle(adjustments.length)}</Typography>
                <Box component="ul" sx={{ m: 0, pl: 2.5, maxHeight: "16vh", overflowY: "auto" }}>
                  {adjustments.map((a, i) => (
                    <Typography key={i} component="li" variant="body2" data-testid="combine-adjusted-item" data-kind={a.kind} sx={{ fontSize: 12.5 }}>
                      {adjustmentLine(a, text)}
                    </Typography>
                  ))}
                </Box>
                <Typography variant="body2" sx={{ fontSize: 12.5, mt: 0.25 }}>{F.adjustedFoot}</Typography>
              </Alert>
            ) : s.adjusted.length > 0 ? (
              <Alert severity="warning" data-testid="combine-adjusted" sx={{ py: 0 }}>{C.adjusted(sectionPhrases(s.adjusted))}</Alert>
            ) : null}
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
