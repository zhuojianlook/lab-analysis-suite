/* The right-hand pane of the combine dialog from phase 4 on (phase 4 contract
   §6.2–6.4): for the focused part, one block per thing to choose (a row of the
   table, a setting, a group of graph settings, a scratchpad cell), or one whole
   choice; the order notes; the side-by-side view; and what was combined
   automatically. Nothing here writes anything: every button only records a
   choice in the dialog state. */

import { useId, useMemo, useState } from "react";
import { Alert, Box, Button, Collapse, Stack, Typography, alpha, useTheme, type Theme } from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import { useFileSession } from "../file/session";
import {
  LIMITS_P4, type CombineSectionViewP4, type CombineStateP4, type CompareResult, type FineChoice, type FineConflict, type FineItem,
} from "../file/contract";
import type { SectionName } from "../file/format";
import type { DocContent } from "../../../store/graphStore";
import type { GraphDoc } from "../../../api/graph";
import { defaultColTitle } from "../graphModel";
import { MiniRowTable, cellMarks, rowOthersDiffer, tableChangeLines, type MiniSide } from "./CompareView";
import { ScratchGrid, VersionGraph, VersionTable } from "./ReadOnlyViews";
import {
  C, F, SECTION_TITLE, V, autoLine, conflictHeading, fieldLabel, orderCheckText, settingValue, shortValue, type FineTextCtx,
} from "./text";

/** How the two sides are named in this dialog. */
export interface DialogNames {
  /** Button labels: "Mine" / "Alice's" ("Theirs"); for my own replaced save "In the file now" / "Your save". */
  mineName: string;
  theirsName: string;
  /** Inside sentences: "mine" / "Alice's" ("theirs"). */
  mineWord: string;
  theirsWord: string;
  /** "Alice (Office iMac)". */
  whoTheirs: string;
  /** Column headings of the side-by-side view: "Mine: This Mac" / "Theirs: Alice (Office iMac)". */
  mineLabel: string;
  theirsLabel: string;
  /** Sub-lines of the part list: "from mine". */
  fromMine: string;
}

export interface PaneCtx {
  s: CombineStateP4;
  names: DialogNames;
  text: FineTextCtx;
  disabled: boolean;
}

const idx = (ids: readonly string[] | undefined, id: string) => (ids ?? []).indexOf(id);

/** The text context of the dialog: row numbers and column titles read from the two tables by id. */
export function makeTextCtx(s: CombineStateP4, n: { mineShort: string; theirsShort: string; minePhrase: string; theirsPhrase: string }): FineTextCtx {
  const docs: GraphDoc[] = [s.mineContent.doc, s.theirsContent.doc, ...(s.resultContent ? [s.resultContent.doc] : [])];
  return {
    rowNo(id) {
      for (const d of docs) { const i = idx(d.row_ids, id); if (i >= 0) return i + 1; }
      return null;
    },
    rowTitle(id) {
      for (const d of docs) { const i = idx(d.row_ids, id); if (i >= 0) return d.row_titles[i] ?? ""; }
      return "";
    },
    colTitle(id) {
      for (const d of docs) {
        const i = idx(d.col_ids, id);
        if (i >= 0) return d.col_titles[i]?.trim() || defaultColTitle(d.template, i);
      }
      return "";
    },
    nRep: Math.max(1, ...docs.map((d) => (d.template === "column" ? 1 : d.n_rep || 1))),
    ...n,
  };
}

const st = () => useFileSession.getState();

// ── buttons ────────────────────────────────────────────────────────────────

function ChoiceButton({ side, chosen, label, onPick, disabled }: {
  side: FineChoice; chosen: boolean; label: string; onPick: () => void; disabled: boolean;
}) {
  return (
    <Button size="small" data-testid={`combine-conflict-${side}`} variant={chosen ? "contained" : "outlined"} aria-pressed={chosen}
      disabled={disabled} onClick={onPick} sx={{ textTransform: "none", minWidth: 72, whiteSpace: "nowrap" }}>
      {label}
    </Button>
  );
}

function blockSx(theme: Theme, chosen: boolean) {
  return {
    border: 1, borderRadius: 1, px: 1.5, py: 1.1,
    borderColor: chosen ? "divider" : alpha(theme.palette.warning.main, 0.55),
    bgcolor: chosen ? "transparent" : alpha(theme.palette.warning.main, 0.07),
  };
}

// ── one block to choose (§6.2) ─────────────────────────────────────────────

function itemsOf(c: FineConflict, what: FineItem["what"]) { return c.items.filter((i) => i.what === what); }

function Swatch({ color }: { color: string | null }) {
  const ok = !!color && /^#[0-9a-f]{3,8}$/i.test(color);
  return (
    <Box component="span" aria-hidden sx={{
      display: "inline-block", width: 12, height: 12, borderRadius: 0.5, border: 1, borderColor: "divider", verticalAlign: "-2px", mr: 0.5,
      bgcolor: ok ? color! : "transparent",
    }} />
  );
}

function ConflictBody({ c, choice, ctx }: { c: FineConflict; choice: FineChoice | null; ctx: PaneCtx }) {
  const { s, names, text } = ctx;
  const mono = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12.5 };
  const line = (t: string, key?: string | number, sx: object = {}) => (
    <Typography key={key} variant="body2" component="div" sx={{ fontSize: 12.5, ...sx }}>{t}</Typography>
  );
  const sides = (only?: "mine" | "theirs"): MiniSide[] => ([
    { side: "mine", label: names.mineName, doc: s.mineContent.doc },
    { side: "theirs", label: names.theirsName, doc: s.theirsContent.doc },
  ] as MiniSide[]).filter((x) => !only || x.side === only);
  switch (c.kind) {
    case "row": {
      if (!c.rowId) return null;
      // Fixer VUX-1: once everything is chosen, a third line shows the row as it will be saved; before that, a
      // note says how many other values of the row are kept from the side that changed them.
      const others = rowOthersDiffer(c.rowId, sides(), c.items);
      const result = choice && choice !== "both" ? s.resultContent?.doc ?? null : null;
      return (
        <Stack spacing={0.5}>
          <MiniRowTable rowId={c.rowId} sides={sides()} items={c.items} chosen={choice === "both" ? null : choice}
            result={result} resultLabel={F.resultLine} />
          {others > 0 && !result && line(F.othersKept(others), "others", { color: "text.secondary" })}
        </Stack>
      );
    }
    case "rowDeleted": {
      const keeper = c.deletedBy === "mine" ? "theirs" : "mine";
      return c.rowId ? <MiniRowTable rowId={c.rowId} sides={sides(keeper)} items={c.items} /> : null;
    }
    case "colDeleted": {
      const keeper = c.deletedBy === "mine" ? "theirs" : "mine";
      const shown = c.items.slice(0, 4);
      return (
        <Stack spacing={0.25}>
          {line(F.valuesChanged(c.items.length + c.more))}
          {shown.map((it, i) => {
            const after = keeper === "mine" ? it.mine : it.theirs;
            if (it.what === "colTitle") return line(F.change(F.colTitle, `'${it.base ?? ""}'`, `'${after ?? ""}'`), i, { color: "text.secondary" });
            const where = it.rowId ? F.rowN(text.rowNo(it.rowId) ?? "") : F.aRow;
            return line(F.change(where, shortValue(it.base), shortValue(after)), i, { color: "text.secondary" });
          })}
        </Stack>
      );
    }
    case "colTitle": case "tableField": case "seriesLabel": {
      const it = c.items[0];
      return it ? line(F.quoted(names.mineName, it.mine ?? "", names.theirsName, it.theirs ?? "")) : null;
    }
    case "field": {
      const it = c.items[0];
      const f = it?.field ?? c.field ?? "";
      return it ? line(F.values(names.mineName, settingValue(f, it.mine, text), names.theirsName, settingValue(f, it.theirs, text))) : null;
    }
    case "group":
      return (
        <Stack spacing={0.25}>
          {c.items.map((it, i) => it.what === "seriesColor" ? (
            <Typography key={i} variant="body2" component="div" sx={{ fontSize: 12.5 }} data-testid="combine-conflict-swatch">
              {text.colTitle(it.colId ?? "")}: {names.mineWord} <Swatch color={it.mine} />{shortValue(it.mine)} · {names.theirsWord} <Swatch color={it.theirs} />{shortValue(it.theirs)}
            </Typography>
          ) : line(F.groupLine(fieldLabel(it.field ?? ""), names.mineWord, settingValue(it.field ?? "", it.mine, text), names.theirsWord, settingValue(it.field ?? "", it.theirs, text)), i))}
          {c.more > 0 && line(V.andMore(c.more), "more", { color: "text.secondary" })}
        </Stack>
      );
    case "cell": {
      const inp = itemsOf(c, "scratch")[0];
      const fmt = itemsOf(c, "scratchFormat")[0];
      return (
        <Stack spacing={0.25}>
          {inp && line(F.values(names.mineName, shortValue(inp.mine), names.theirsName, shortValue(inp.theirs)), "in", mono)}
          {fmt && line(F.groupLine(F.numberFormat, names.mineWord, shortValue(fmt.mine), names.theirsWord, shortValue(fmt.theirs)), "fmt", { color: "text.secondary" })}
        </Stack>
      );
    }
    default:
      return null;
  }
}

export function ConflictBlock({ c, choice, ctx }: { c: FineConflict; choice: FineChoice | null; ctx: PaneCtx }) {
  const theme = useTheme();
  const hid = useId();
  const { names } = ctx;
  const pick = (side: FineChoice) => void st().setConflictChoice(c.id, side);
  const del = c.kind === "rowDeleted" || c.kind === "colDeleted";
  const label = (side: "mine" | "theirs") => {
    if (!del) return side === "mine" ? names.mineName : names.theirsName;
    const deleting = side === c.deletedBy;
    if (c.kind === "rowDeleted") return deleting ? F.deleteRow : F.keepRow;
    return deleting ? F.deleteCol : F.keepCol;
  };
  // Deleting first, then keeping (§6.2); otherwise mine, then theirs.
  const order: ("mine" | "theirs")[] = del && c.deletedBy === "theirs" ? ["theirs", "mine"] : ["mine", "theirs"];
  return (
    <Box data-testid="combine-conflict" data-id={c.id} data-kind={c.kind} data-choice={choice ?? ""} role="group" aria-labelledby={hid}
      sx={blockSx(theme, !!choice)}>
      <Typography id={hid} variant="body2" sx={{ fontWeight: 600, mb: 0.75 }} data-testid="combine-conflict-heading">
        {conflictHeading(c, ctx.text)}
        {c.kind === "row" && c.items.length + c.more > 1 && (
          <Box component="span" sx={{ fontWeight: 400, color: "text.secondary", ml: 1 }} data-testid="combine-conflict-count">
            {F.valuesToChoose(c.items.length + c.more)}
          </Box>
        )}
      </Typography>
      <ConflictBody c={c} choice={choice} ctx={ctx} />
      <Stack direction="row" spacing={0.75} sx={{ mt: 1 }} flexWrap="wrap" useFlexGap>
        {order.filter((x) => c.options.includes(x)).map((side) => (
          <ChoiceButton key={side} side={side} chosen={choice === side} label={label(side)} onPick={() => pick(side)} disabled={ctx.disabled} />
        ))}
      </Stack>
    </Box>
  );
}

// ── a part that is one whole choice (§6.3) ─────────────────────────────────

export function WholeBlock({ c, choice, ctx }: { c: FineConflict; choice: FineChoice | null; ctx: PaneCtx }) {
  const theme = useTheme();
  const hid = useId();
  const { names } = ctx;
  const pick = (side: FineChoice) => void st().setConflictChoice(c.id, side);
  const textOf = c.reason === "shift" ? F.wholeShift : c.reason === "table" ? F.wholeTable : F.wholeTwoWay;
  const both = c.reason === "shift" && c.options.includes("both");
  return (
    <Box data-testid="combine-whole" data-id={c.id} data-reason={c.reason ?? ""} data-choice={choice ?? ""} role="group" aria-labelledby={hid}
      sx={blockSx(theme, !!choice)}>
      <Typography id={hid} variant="body2" sx={{ fontSize: 13 }}>{textOf}</Typography>
      <Stack direction="row" spacing={0.75} sx={{ mt: 1 }} flexWrap="wrap" useFlexGap alignItems="center">
        <ChoiceButton side="mine" chosen={choice === "mine"} label={names.mineName} onPick={() => pick("mine")} disabled={ctx.disabled} />
        <ChoiceButton side="theirs" chosen={choice === "theirs"} label={names.theirsName} onPick={() => pick("theirs")} disabled={ctx.disabled} />
        {both && <ChoiceButton side="both" chosen={choice === "both"} label={F.bothSideBySide} onPick={() => pick("both")} disabled={ctx.disabled} />}
        {c.reason === "twoWay" && (
          <Button size="small" variant="outlined" color="inherit" data-testid="combine-keep-separate" disabled={ctx.disabled}
            onClick={() => void st().keepBothAsSeparate()} sx={{ textTransform: "none", whiteSpace: "nowrap" }}>
            {F.bothSeparate}
          </Button>
        )}
      </Stack>
      {both && <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5 }}>{F.bothCaption}</Typography>}
    </Box>
  );
}

// ── the two sides of one part (phase 2), with the order markers of phase 4 ──

export function SideBySide({ k, cmp, mine, theirs, mineLabel, theirsLabelText, markRows, markCols }: {
  k: SectionName; cmp: CompareResult; mine: DocContent; theirs: DocContent; mineLabel: string; theirsLabelText: string;
  markRows?: ReadonlySet<string>; markCols?: ReadonlySet<string>;
}) {
  const marksMine = useMemo(() => cellMarks(cmp, "b"), [cmp]);
  const marksTheirs = useMemo(() => cellMarks(cmp, "a"), [cmp]);
  const settings = k === "analysis" || k === "figure" ? cmp.settings.filter((x) => x.section === k) : [];
  const sides: [string, "b" | "a", DocContent][] = [[mineLabel, "b", mine], [theirsLabelText, "a", theirs]];
  return (
    <Box sx={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 1.5, alignItems: "start" }} data-testid="combine-side-by-side">
      {sides.map(([label, side, c]) => (
        <Box key={side} sx={{ minWidth: 0 }}>
          <Typography variant="caption" color="text.secondary" component="div" noWrap title={label} sx={{ mb: 0.5, fontWeight: 600 }}>{label}</Typography>
          {k === "table" ? (
            <VersionTable doc={c.doc} marks={side === "b" ? marksMine : marksTheirs} otherLabel={side === "b" ? theirsLabelText : mineLabel}
              dense maxRows={60} onlyMarked={cmp.table.cells.length > 0 && c.doc.cells.length > 60 && !markRows?.size} nearMarked
              testId={`combine-table-${side === "b" ? "mine" : "theirs"}`} markRows={markRows} markCols={markCols} markTitle={F.orderMark} />
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
          )}
        </Box>
      ))}
    </Box>
  );
}

// ── "Combined automatically (n)" of one part ───────────────────────────────

export function AutoList({ sec, ctx, initiallyOpen }: { sec: CombineSectionViewP4; ctx: PaneCtx; initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  if (sec.combined === 0 && sec.auto.length === 0) return null;
  const more = Math.max(0, sec.combined - sec.auto.length);
  return (
    <Box data-testid="combine-auto-list" data-open={open ? "true" : "false"}>
      <Button size="small" color="inherit" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        startIcon={open ? <ExpandMoreIcon /> : <ChevronRightIcon />}
        sx={{ textTransform: "none", color: "text.secondary", px: 0.5, fontWeight: 500 }}>
        {F.autoList(sec.combined)}
      </Button>
      <Collapse in={open} unmountOnExit>
        <Stack spacing={0.25} sx={{ pl: 3.5 }} component="ul" style={{ margin: 0, paddingInlineStart: 28 }}>
          {sec.auto.map((a, i) => (
            <Typography key={i} component="li" variant="body2" data-testid="combine-auto-item" data-what={a.what} sx={{ fontSize: 12.5 }}>
              {autoLine(a, ctx.text)}
            </Typography>
          ))}
          {more > 0 && <Typography component="li" variant="body2" color="text.secondary" sx={{ fontSize: 12.5, listStyle: "none" }}>{V.andMore(more)}</Typography>}
        </Stack>
      </Collapse>
    </Box>
  );
}

// ── the pane of the focused part ───────────────────────────────────────────

/** Rows with data that only one of two tables has (blank rows at the end are left out: each computer keeps its
 *  own, fixer VUX-7). */
function rowsOnlyIn(a: GraphDoc, b: GraphDoc): number {
  const other = new Set(b.row_ids ?? []);
  let n = 0;
  (a.row_ids ?? []).forEach((id, r) => {
    if (other.has(id)) return;
    const data = (a.row_titles[r] ?? "").trim() || (a.x?.[r] ?? "").trim() || (a.cells[r] ?? []).some((reps) => reps.some((v) => (v ?? "").trim() !== ""));
    if (data) n++;
  });
  return n;
}

function summaryOf(k: SectionName, cmp: CompareResult, s: CombineStateP4): string | null {
  if (cmp.sections.find((x) => x.key === k)?.same) return C.sectionSame;
  if (k === "table") {
    // Fixer round 2 (RV-3): a row both typed into that is kept as two rows counts as a row added on each side.
    const split = s.sections.find((x) => x.key === "table")?.rowNotes?.split.length ?? 0;
    const t = {
      ...cmp.table,
      addedRows: rowsOnlyIn(s.mineContent.doc, s.theirsContent.doc) + split,
      removedRows: rowsOnlyIn(s.theirsContent.doc, s.mineContent.doc) + split,
    };
    return tableChangeLines(t).join(" · ") || C.noTableChange;
  }
  if (k === "scratchpad") return C.scratchCells(cmp.scratchpadCells);
  return null;
}

/** Fixer VUX-2: the order note names the rows (by their place in the combined table). */
function orderNote(o: { axis: "row" | "col"; ids: readonly string[] }, doc: GraphDoc | null): string {
  if (o.axis !== "row" || !doc || !o.ids.length) return orderCheckText(o);
  const at = o.ids.map((id) => (doc.row_ids ?? []).indexOf(id)).filter((i) => i >= 0).map((i) => i + 1);
  if (!at.length) return orderCheckText(o);
  return F.orderRowsAt(F.rowsAt(Math.min(...at), Math.max(...at)));
}

export function SectionPane({ sec, ctx }: { sec: CombineSectionViewP4; ctx: PaneCtx }) {
  const { s, names } = ctx;
  const k = sec.key;
  const whole = sec.conflicts.find((c) => c.kind === "section") ?? null;
  const fine = sec.conflicts.filter((c) => c.kind !== "section");
  const drawn = fine.slice(0, LIMITS_P4.dialogConflicts);
  const notDrawn = fine.length - drawn.length;
  const checks = sec.orderChecks.filter((o) => o.matters);
  const markRows = new Set(checks.filter((o) => o.axis === "row").flatMap((o) => o.ids));
  const markCols = new Set(checks.filter((o) => o.axis === "col").flatMap((o) => o.ids));
  const showAll = fine.length >= 2 && sec.level === "fine";
  const allSide = (side: "mine" | "theirs") => fine.length > 0 && fine.every((c) => sec.choices[c.id] === side);
  // Fixer VUX-4: with some chosen and some not, "for the rest" fills only the ones without a choice.
  const chosenN = fine.filter((c) => sec.choices[c.id] !== undefined).length;
  const showRest = showAll && chosenN > 0 && chosenN < fine.length;
  const rest = (side: "mine" | "theirs") => void useFileSession.dialogExtras.setRestInSection(k, side);
  const summary = summaryOf(k, s.compare, s);
  const side = (
    <SideBySide k={k} cmp={s.compare} mine={s.mineContent} theirs={s.theirsContent} mineLabel={names.mineLabel} theirsLabelText={names.theirsLabel}
      markRows={markRows} markCols={markCols} />
  );
  return (
    <Stack spacing={1.25} data-testid="combine-compare" data-key={k} data-level={sec.level}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <Typography variant="subtitle2" component="h3" sx={{ fontWeight: 600, m: 0 }}>{SECTION_TITLE[k]}</Typography>
        {summary && <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1, minWidth: 0 }} noWrap title={summary}>{summary}</Typography>}
        {!summary && <Box sx={{ flexGrow: 1 }} />}
        {showAll && (
          <Stack direction="row" spacing={0.75}>
            <Button size="small" variant={allSide("mine") ? "contained" : "outlined"} color="inherit" data-testid="combine-all-mine" aria-pressed={allSide("mine")}
              disabled={ctx.disabled} onClick={() => void st().setAllInSection(k, "mine")} sx={{ textTransform: "none", whiteSpace: "nowrap", py: 0.2 }}>
              {F.useAll(names.mineWord)}
            </Button>
            <Button size="small" variant={allSide("theirs") ? "contained" : "outlined"} color="inherit" data-testid="combine-all-theirs" aria-pressed={allSide("theirs")}
              disabled={ctx.disabled} onClick={() => void st().setAllInSection(k, "theirs")} sx={{ textTransform: "none", whiteSpace: "nowrap", py: 0.2 }}>
              {F.useAll(names.theirsWord)}
            </Button>
            {showRest && (["mine", "theirs"] as const).map((side) => (
              <Button key={side} size="small" variant="text" color="inherit" data-testid={`combine-rest-${side}`}
                disabled={ctx.disabled} onClick={() => rest(side)} sx={{ textTransform: "none", whiteSpace: "nowrap", py: 0.2 }}>
                {F.useRest(side === "mine" ? names.mineWord : names.theirsWord)}
              </Button>
            ))}
          </Stack>
        )}
      </Stack>

      {checks.map((o, i) => (
        <Alert key={`${o.axis}:${i}`} severity="info" data-testid="combine-order-check" data-axis={o.axis} sx={{ py: 0.25, fontSize: 12.5 }}>
          {orderNote(o, s.resultContent?.doc ?? null)}
        </Alert>
      ))}
      {checks.length > 0 && k === "table" && s.resultContent && (
        <Box data-testid="combine-order-result">
          <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 0.5, fontWeight: 600 }}>{F.combinedOrder}</Typography>
          <VersionTable doc={s.resultContent.doc} dense maxRows={60} markRows={markRows} markCols={markCols} markTitle={F.orderMark} testId="combine-table-result" nearMarked />
        </Box>
      )}

      {whole && <WholeBlock c={whole} choice={sec.choices[whole.id] ?? null} ctx={ctx} />}

      {drawn.length > 0 && (
        <Stack spacing={1} data-testid="combine-conflicts">
          {drawn.map((c) => <ConflictBlock key={c.id} c={c} choice={sec.choices[c.id] ?? null} ctx={ctx} />)}
          {notDrawn > 0 && (
            <Typography variant="body2" color="text.secondary" data-testid="combine-more" sx={{ fontSize: 12.5 }}>{F.more(notDrawn)}</Typography>
          )}
        </Stack>
      )}

      {/* The two graphs help choosing a graph setting; a whole choice and a part without anything to choose show both sides. */}
      {(whole || fine.length === 0 || k === "figure") && side}

      <AutoList key={`${k}:${sec.conflicts.length > 0}`} sec={sec} ctx={ctx} initiallyOpen={sec.conflicts.length === 0} />
    </Stack>
  );
}
