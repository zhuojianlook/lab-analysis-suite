import { Component, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import {
  Alert, Box, Button, Chip, CircularProgress, FormControlLabel, Stack, Switch, Tab, Tabs, Tooltip, Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import RemoveIcon from "@mui/icons-material/Remove";
import InsertChartOutlinedIcon from "@mui/icons-material/InsertChartOutlined";
import RefreshIcon from "@mui/icons-material/Refresh";
import TableChartIcon from "@mui/icons-material/TableChart";
import GridOnIcon from "@mui/icons-material/GridOn";
import CalculateOutlinedIcon from "@mui/icons-material/CalculateOutlined";
import UndoIcon from "@mui/icons-material/Undo";
import { analyzeGraph, plotGraph, type AnalyzeResult, type GraphPlotResult } from "../../api/graph";
import { useGraphStore } from "../../store/graphStore";
import { PlotResult } from "../shared/PlotResult";
import { Workspace } from "../shared/Workspace";
import { RailHeading, RailSection } from "../shared/RailSection";
import { NumberField } from "../shared/NumberField";
import { DataGrid } from "./DataGrid";
import { MOD_KEY, StartScreen } from "./GraphLibrary";
import { useFileSession } from "./file/session";
import { FILE_TABS_HEIGHT, FileTabs } from "./files-ui/FileTabs";
import { DOC_BAR_HEIGHT, DocBar } from "./files-ui/DocBar";
import { RestoreCardView } from "./files-ui/RestoreCardView";
import { VERSIONS_PANEL_WIDTH, VersionsPanel } from "./files-ui/VersionsPanel";
import { VersionPreview } from "./files-ui/VersionPreview";
import { V, undoTooltip } from "./files-ui/text";
import { GraphAnalysisControls } from "./GraphAnalysisControls";
import { GraphFigureControls, TitleFields } from "./GraphFigureControls";
import { FigureTextPanel, readTextPanelOpen, writeTextPanelOpen } from "./FigureTextPanel";
import { GraphResults } from "./GraphResults";
import { flushScratch, scratchController, useScratchUi } from "./scratchpad/scratchBridge";
import {
  MAX_COLS, MAX_REP, MAX_ROWS, POSTHOC_LABELS, TEST_LABELS, colHasData, countInvalid, defaultColTitle,
  effectiveAnalysis, effectiveFigure, formatP, hasNumbers, hasPosthoc, templateInfo, toNumericTable, usedCols,
  usedRows, valuesBeyondRep, type PasteResult,
} from "./graphModel";

type Step = "table" | "analysis" | "graph";
type CanvasTab = "scratch" | "data" | "graph" | "results";

/** The Scratchpad (spreadsheet + formula engine) is its own chunk, loaded the first time the tab opens. */
const ScratchpadTab = lazy(() => import("./scratchpad/ScratchpadTab"));

/** Keeps a failed Scratchpad load from taking the Graphs tool down; its saved text stays in the store. */
class ScratchBoundary extends Component<{ children: ReactNode }, { error: string | null; attempt: number }> {
  state = { error: null as string | null, attempt: 0 };
  static getDerivedStateFromError(e: unknown) { return { error: e instanceof Error ? e.message : String(e) }; }
  componentDidCatch(_e: unknown, _info: ErrorInfo) { /* shown in the fallback */ }
  render() {
    if (this.state.error !== null) {
      return (
        <Box sx={{ flexGrow: 1, display: "grid", placeItems: "center" }}>
          <Alert severity="error" action={
            <Button color="inherit" size="small" onClick={() => this.setState((s) => ({ error: null, attempt: s.attempt + 1 }))}>Retry</Button>
          }>
            The scratchpad couldn't be loaded ({this.state.error}). Its saved contents are kept.
          </Alert>
        </Box>
      );
    }
    return <Box key={this.state.attempt} sx={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0 }}>{this.props.children}</Box>;
  }
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Exports hold back newer content of the file until they finish (phase 2 contract §5.7). */
const holdForExport = () => useFileSession.getState().holdReplace("export");

/** A rendered figure that stays visible (dimmed) while a newer one renders. */
function FigureView({ result, busy, baseName, fitHeight }: {
  result: GraphPlotResult; busy: boolean; baseName: string; fitHeight: string;
}) {
  return (
    <Box sx={{ position: "relative", alignSelf: "flex-start", maxWidth: "100%" }}>
      <PlotResult result={result} baseName={baseName} fitHeight={fitHeight} hold={holdForExport} />
      {busy && (
        <Box sx={{ position: "absolute", inset: 0, bgcolor: "rgba(28,28,30,0.35)", display: "grid", placeItems: "center", borderRadius: 1 }}>
          <CircularProgress size={28} />
        </Box>
      )}
    </Box>
  );
}

const Rendering = ({ what }: { what: string }) => (
  <Box sx={{ flexGrow: 1, display: "grid", placeItems: "center" }}>
    <Stack alignItems="center" spacing={1.5}>
      <CircularProgress size={28} />
      <Typography variant="body2" color="text.secondary">Rendering the {what} in R…</Typography>
    </Stack>
  </Box>
);

const CanvasNote = ({ children, action }: { children: ReactNode; action?: ReactNode }) => (
  <Box sx={{ flexGrow: 1, display: "grid", placeItems: "center", py: 6 }}>
    <Stack alignItems="center" spacing={1.5} sx={{ maxWidth: 440, textAlign: "center" }}>
      <InsertChartOutlinedIcon sx={{ fontSize: 40, color: "text.disabled" }} />
      <Typography variant="body2" color="text.secondary">{children}</Typography>
      {action}
    </Stack>
  </Box>
);

/** Width of an element, tracked with a ResizeObserver (callback ref, so it
 *  follows an element that mounts / unmounts conditionally). */
function useElementWidth(): [(el: HTMLElement | null) => void, number] {
  const [width, setWidth] = useState(0);
  const ro = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    ro.current?.disconnect();
    ro.current = null;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const obs = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w !== undefined) setWidth(w);
    });
    obs.observe(el);
    ro.current = obs;
  }, []);
  return [ref, width];
}

/** Canvas width from which the legend & methods panel sits beside the figure
 *  (a 1280 px window with the app sidebar and rail open leaves about 670 px). */
const SIDE_PANEL_MIN_WIDTH = 640;
/** Below this canvas width the side panel is narrower, to leave the figure room. */
const SIDE_PANEL_WIDE_FROM = 900;

/** Selection / size caption on the tab strip while the Scratchpad is shown. */
function ScratchCaption() {
  const ui = useScratchUi();
  if (!ui.ready) return null;
  const sel = ui.selRows * ui.selCols > 1 ? `${ui.sel} · ${ui.selRows} × ${ui.selCols}` : ui.sel;
  return (
    <Typography variant="caption" color="text.secondary" noWrap>
      {sel} · {ui.cells} cell{ui.cells === 1 ? "" : "s"} filled
    </Typography>
  );
}

/** Rail section shown above the steps while the Scratchpad tab is open. */
function ScratchRail() {
  const ready = useScratchUi((s) => s.ready);
  const cells = useScratchUi((s) => s.cells);
  const [confirmClear, setConfirmClear] = useState(false);
  const run = (fn: (c: NonNullable<ReturnType<typeof scratchController>>) => void) => { const c = scratchController(); if (c) fn(c); };
  return (
    <RailSection step={0} icon={<CalculateOutlinedIcon sx={{ fontSize: 20 }} />} title="Scratchpad"
      summary={ready ? `${cells} cell${cells === 1 ? "" : "s"} filled · saved with this analysis` : "Loading…"}
      expanded onToggle={() => undefined}>
      <Typography variant="body2" color="text.secondary">
        A spreadsheet for working out values before they go into the Data table. Formulas work as in Excel
        (=SUM(A1:A5), $A$1, IF, VLOOKUP, T.TEST …). It is saved with this analysis and never affects the statistics or the graph.
      </Typography>
      <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ mt: 1.5 }}>
        <Button size="small" variant="contained" disabled={!ready} onClick={() => run((c) => c.openSend())}>Send selection to Data…</Button>
        <Button size="small" variant="outlined" disabled={!ready} onClick={() => run((c) => c.copy())}>Copy values</Button>
        <Button size="small" color="error" disabled={!ready || cells === 0} onClick={() => setConfirmClear(true)}>Clear scratchpad…</Button>
      </Stack>
      {confirmClear && (
        <Alert severity="warning" sx={{ mt: 1 }}
          action={
            <Stack direction="row" spacing={0.5}>
              <Button color="inherit" size="small" onClick={() => { run((c) => c.clearAll()); setConfirmClear(false); }}>Clear</Button>
              <Button color="inherit" size="small" onClick={() => setConfirmClear(false)}>Cancel</Button>
            </Stack>
          }>
          Clear every cell of the scratchpad? ({MOD_KEY} + Z in the sheet undoes it.)
        </Alert>
      )}
      <RailHeading>Keys</RailHeading>
      <Typography variant="caption" color="text.secondary" component="div">
        Enter / Tab move · F2 edit · F4 cycles $ · {MOD_KEY} + C / X / V · {MOD_KEY} + D / R fill down / right ·
        {" "}{MOD_KEY} + Z / Shift + {MOD_KEY} + Z undo / redo · {MOD_KEY} + Enter fills the selection · drag the corner square to fill ·
        right-click for insert / delete. Copied cells paste as their displayed values.
      </Typography>
      <RailHeading>Differences from Excel</RailHeading>
      <Typography variant="caption" color="text.secondary" component="div">
        One sheet; US number and date formats (1,234.5 and m/d/yyyy). Fractions typed as 1 1/2 are shown as 1.5, and =TIME()
        results as a decimal unless a time format is chosen. The intersection ( ) and union ((A1:A2,B1:B2)) operators, @,
        AGGREGATE and GROWTH aren't available; a formula Excel would refuse (or shows as #ERROR!) is refused. COUNT and
        ISNUMBER don't look inside array expressions, so COUNT over one is refused. Circular references show #CIRC!.
        Formulas over 500 operators or 64 levels deep are refused. Cutting a cell onto one that a formula refers to keeps
        that formula (Excel turns it into #REF!). Formula results that change by themselves (TODAY, RAND) are recalculated
        when the analysis is opened. Copied numbers are written plainly (12,500 → 12500, 50% → 0.5) so they paste as numbers.
      </Typography>
    </RailSection>
  );
}

/** Height the tab strip and the document bar add above the workspace, compared
 *  with the single file bar the canvas heights below were tuned for. */
const CHROME = FILE_TABS_HEIGHT + DOC_BAR_HEIGHT - 42;

/** The open document: rail, canvas tabs and live analysis / figure. */
function GraphEditor() {
  const doc = useGraphStore((s) => s.doc);
  const analysis = useGraphStore((s) => s.analysis);
  const figure = useGraphStore((s) => s.figure);
  const docSerial = useGraphStore((s) => s.docSerial);
  const openedAs = useGraphStore((s) => s.openedAs);
  const setAnalysis = useGraphStore((s) => s.setAnalysis);
  const setFigure = useGraphStore((s) => s.setFigure);
  const store = useGraphStore;

  const name = useGraphStore((s) => s.name);
  /** Newer content of the file waits until the cell editor / drag / menu / export is done (phase 2 §5.7). */
  const updating = useFileSession((s) => !!s.tabs.find((t) => t.key === s.activeKey)?.updating);
  /** Label of the top undo step when it is the one a combine left ("Undo: combine with Alice's changes"). */
  const undoLabel = useGraphStore((s) => (s.undoStack.length ? s.undoStack[s.undoStack.length - 1].label ?? null : null));
  const [open, setOpen] = useState<Record<Step, boolean>>({ table: true, analysis: true, graph: false });
  const [canvasTab, setCanvasTab] = useState<CanvasTab>("data");
  const [graphSeen, setGraphSeen] = useState(false);
  const [pasteNote, setPasteNote] = useState<{ tone: "success" | "warning"; text: string } | null>(null);
  const [repConfirm, setRepConfirm] = useState<{ n: number; lost: number } | null>(null);
  const [colConfirm, setColConfirm] = useState(false);

  const [result, setResult] = useState<AnalyzeResult | null>(null);
  /** The analysis key (table + settings) that `result` / `anError` belong to. */
  const [resultKey, setResultKey] = useState<string | null>(null);
  const [textOpen, setTextOpen] = useState(readTextPanelOpen);
  const [canvasRef, canvasWidth] = useElementWidth();
  const [anError, setAnError] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [plot, setPlot] = useState<GraphPlotResult | null>(null);
  const [plotting, setPlotting] = useState(false);
  const [plotError, setPlotError] = useState<string | null>(null);
  const [liveUpdate, setLiveUpdate] = useState(true);
  const anSeq = useRef(0);
  const plotSeq = useRef(0);
  const plotKeyRendered = useRef<string | null>(null);

  // ── per-document view state ───────────────────────────────────────────────
  useEffect(() => {
    anSeq.current++;
    plotSeq.current++;
    plotKeyRendered.current = null;
    setResult(null);
    setResultKey(null);
    setAnError(null);
    setPlot(null);
    setPlotError(null);
    setAnalyzing(false);
    setPlotting(false);
    setPasteNote(null);
    setRepConfirm(null);
    setColConfirm(false);
    const showGraph = openedAs === "saved" || openedAs === "sample";
    setCanvasTab(showGraph ? "graph" : "data");
    setGraphSeen(showGraph);
    setOpen({ table: !showGraph, analysis: true, graph: showGraph });
    // Only a new document resets the view: a combine or a newer version put into this tab changes
    // openedAs (draft → saved) but keeps docSerial, and must leave the person on the tab they were using.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docSerial]);

  // ── derived data ──────────────────────────────────────────────────────────
  const table = useMemo(() => (doc ? toNumericTable(doc) : null), [doc]);
  const tableKey = useMemo(() => JSON.stringify(table), [table]);
  const invalid = useMemo(() => (doc ? countInvalid(doc) : 0), [doc]);
  const hasData = !!table && hasNumbers(table);
  const nGroups = table ? usedCols(table) : 0;
  const nRows = table ? usedRows(table) : 0;
  const template = doc?.template ?? "column";
  const withinCols = template === "grouped" && analysis.within === "columns";
  const nEntitiesAll = doc ? (withinCols ? doc.cells.length : doc.col_titles.length) : 0;
  const colNames = useMemo(
    () => (doc ? doc.col_titles.map((t, i) => t.trim() || defaultColTitle(doc.template, i)) : []),
    [doc?.col_titles, doc?.template], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const entities = withinCols ? table?.row_titles ?? [] : colNames;

  // Keep the test / post-hoc / indices valid for the data as it changes. The
  // store's load already did this for a newly opened document (before taking
  // its saved baseline), so this changes nothing on open — only after edits.
  useEffect(() => {
    if (!doc || !hasData) return;
    store.getState().normalize();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docSerial, hasData, nGroups, nRows, nEntitiesAll, analysis.within]);

  const effAnalysis = useMemo(() => (table ? effectiveAnalysis(analysis, table) : analysis), [analysis, tableKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const effFigure = useMemo(() => (table ? effectiveFigure(figure, table) : figure), [figure, tableKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const anKey = `${tableKey}|${JSON.stringify(effAnalysis)}`;
  const plotKey = `${anKey}|${JSON.stringify(effFigure)}`;
  const baseName = (name.trim() || "graph").replace(/[^\w.-]+/g, "_").slice(0, 60) || "graph";

  // ── live analysis ─────────────────────────────────────────────────────────
  useEffect(() => {
    const seq = ++anSeq.current;
    if (!table || !hasData) { setResult(null); setResultKey(null); setAnError(null); setAnalyzing(false); return; }
    const t0 = table, a0 = effAnalysis, k0 = anKey;
    setAnalyzing(true);
    const t = setTimeout(async () => {
      try {
        const res = await analyzeGraph(t0, a0);
        if (seq !== anSeq.current) return;
        if (res.error && !res.descriptives) { setAnError(res.error); setResult(null); }
        else { setResult(res); setAnError(res.error ?? null); }
        setResultKey(k0);
      } catch (e) {
        // Drop the previous data's statistics so they aren't shown as current.
        if (seq === anSeq.current) { setAnError(errMsg(e)); setResult(null); setResultKey(k0); }
      } finally {
        if (seq === anSeq.current) setAnalyzing(false);
      }
    }, 400);
    return () => clearTimeout(t);
    // docSerial: a newly opened document is always analysed, even when its
    // table and settings match the previous one (the per-document effect above
    // has just cleared the result).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anKey, docSerial]);

  // ── live figure ───────────────────────────────────────────────────────────
  const renderPlot = async () => {
    if (!table || !hasData) return;
    const seq = ++plotSeq.current;
    plotKeyRendered.current = plotKey;
    setPlotting(true);
    setPlotError(null);
    try {
      const res = await plotGraph(table, effAnalysis, effFigure);
      if (seq !== plotSeq.current) return;
      if (res.error && !res.plots) { setPlotError(res.error); plotKeyRendered.current = null; return; }
      setPlot(res);
      if (!res.success) plotKeyRendered.current = null; // let the next change (or Re-render) retry
    } catch (e) {
      if (seq !== plotSeq.current) return;
      setPlotError(errMsg(e));
      plotKeyRendered.current = null;
    } finally {
      if (seq === plotSeq.current) setPlotting(false);
    }
  };

  // The first time the Graph tab is shown for a document, open rail step 3 so
  // the axis titles and graph settings are in view (only on that transition,
  // so a user who collapses it again isn't fought).
  useEffect(() => {
    if (canvasTab === "graph" && !graphSeen) {
      setGraphSeen(true);
      setOpen((p) => ({ ...p, graph: true }));
    }
  }, [canvasTab, graphSeen]);

  // Once the graph has been looked at, re-render (debounced) on any change to
  // the data, the analysis or the figure settings. Stale responses are dropped.
  useEffect(() => {
    if (!graphSeen || !liveUpdate || !hasData || plotKey === plotKeyRendered.current) return;
    const t = setTimeout(() => { if (plotKeyRendered.current !== plotKey) void renderPlot(); }, plot || plotting ? 650 : 0);
    return () => clearTimeout(t);
    // docSerial: re-render for a newly opened document even when its plotKey
    // matches the previous one (the per-document effect has cleared the figure).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plotKey, graphSeen, liveUpdate, hasData, docSerial]);

  const plotStale = !!plot && plotKey !== plotKeyRendered.current && !plotting;

  // ── start screen ──────────────────────────────────────────────────────────
  if (!doc || !table) return <CanvasSpinner />;

  // ── rail ──────────────────────────────────────────────────────────────────
  const st = store.getState();
  const toggle = (s: Step) => (o: boolean) => setOpen((p) => ({ ...p, [s]: o }));
  const info = templateInfo(template);
  const seriesWord = template === "xy" ? "data set" : "group";
  const nValues = table.values.reduce((n, row) => n + row.reduce((m, reps) => m + reps.filter((v) => v !== null).length, 0), 0);
  const tableSummary = `${info.label} · ${doc.col_titles.length} ${seriesWord}${doc.col_titles.length === 1 ? "" : "s"} · ${nValues} value${nValues === 1 ? "" : "s"}`;

  const changeReps = (n: number) => {
    const lost = valuesBeyondRep(doc, n);
    if (n < doc.n_rep && lost > 0) setRepConfirm({ n, lost });
    else { setRepConfirm(null); st.setNRep(n); }
  };
  const lastCol = doc.col_titles.length - 1;
  const removeLastCol = () => {
    if (colHasData(doc, lastCol)) setColConfirm(true);
    else st.deleteCol(lastCol);
  };

  const tableSection = (
    <RailSection step={1} title="Table" summary={tableSummary} done={hasData} expanded={open.table} onToggle={toggle("table")}>
      <Typography variant="body2" color="text.secondary">{info.blurb}</Typography>

      {template !== "column" && (
        <>
          <RailHeading>Replicates</RailHeading>
          <Stack direction="row" spacing={1} alignItems="center">
            <NumberField size="small" label="Sub-columns per group" value={doc.n_rep} onCommit={changeReps} min={1} max={MAX_REP} step={1} sx={{ width: 170 }} />
            <Typography variant="caption" color="text.secondary">
              {template === "grouped" ? "Replicate values per row and group." : "Replicate Y values per X."}
            </Typography>
          </Stack>
          {repConfirm && (
            <Alert severity="warning" sx={{ mt: 1 }}
              action={
                <Stack direction="row" spacing={0.5}>
                  <Button color="inherit" size="small" onClick={() => { st.setNRep(repConfirm.n); setRepConfirm(null); }}>Remove</Button>
                  <Button color="inherit" size="small" onClick={() => setRepConfirm(null)}>Cancel</Button>
                </Stack>
              }>
              Going down to {repConfirm.n} removes {repConfirm.lost} value{repConfirm.lost === 1 ? "" : "s"}.
            </Alert>
          )}
        </>
      )}

      <RailHeading>Size</RailHeading>
      <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
        <Button size="small" variant="outlined" startIcon={<AddIcon />} disabled={doc.col_titles.length >= MAX_COLS}
          onClick={() => st.insertCol(doc.col_titles.length)}>
          {template === "xy" ? "Data set" : "Column"}
        </Button>
        <Button size="small" variant="outlined" startIcon={<RemoveIcon />} disabled={doc.col_titles.length <= 1} onClick={removeLastCol}>
          Last {template === "xy" ? "data set" : "column"}
        </Button>
        <Button size="small" variant="outlined" startIcon={<AddIcon />} disabled={doc.cells.length >= MAX_ROWS}
          onClick={() => st.insertRow(doc.cells.length)}>
          Row
        </Button>
      </Stack>
      {colConfirm && (
        <Alert severity="warning" sx={{ mt: 1 }}
          action={
            <Stack direction="row" spacing={0.5}>
              <Button color="inherit" size="small" onClick={() => { st.deleteCol(lastCol); setColConfirm(false); }}>Delete</Button>
              <Button color="inherit" size="small" onClick={() => setColConfirm(false)}>Cancel</Button>
            </Stack>
          }>
          “{colNames[lastCol]}” has values. Delete it?
        </Alert>
      )}
      <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 1 }}>
        {table.values.length} row{table.values.length === 1 ? "" : "s"} with data · {nGroups} of {doc.col_titles.length} {seriesWord}s with values.
        Use a column's ▾ or a row number for insert / delete. Up to {MAX_COLS} {seriesWord}s, {MAX_ROWS} rows, {MAX_REP} replicates.
      </Typography>
      {invalid > 0 && (
        <Typography variant="caption" color="warning.main" component="div" sx={{ mt: 0.5 }}>
          {invalid} cell{invalid === 1 ? " is" : "s are"} not {invalid === 1 ? "a number" : "numbers"} and {invalid === 1 ? "was" : "were"} ignored.
        </Typography>
      )}
    </RailSection>
  );

  const pText = (p: number | null) => { const f = formatP(p); return /^[<>]/.test(f) ? f : `= ${f}`; };
  const resultSummary = !hasData ? "Enter data first"
    : result?.test ? `${result.test.label} · P ${pText(result.test.p)}`
      : result?.regression?.length ? (result.regression.length === 1 && result.regression[0].p !== null
        ? `Linear regression · slope P ${pText(result.regression[0].p)}`
        : `Linear regression · ${result.regression.length} data set${result.regression.length === 1 ? "" : "s"}`)
      : `${TEST_LABELS[effAnalysis.test].split(" (")[0]}${effAnalysis.posthoc !== "none" ? ` + ${POSTHOC_LABELS[effAnalysis.posthoc]}` : ""}`;

  const analysisSection = (
    <RailSection step={2} title="Analysis" summary={resultSummary} done={!!result?.test || !!result?.regression?.length} expanded={open.analysis} onToggle={toggle("analysis")}>
      <GraphAnalysisControls template={template} analysis={analysis} setAnalysis={setAnalysis}
        entities={entities} nGroups={nGroups} nRows={nRows} result={result} />
      {analyzing && <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 1 }}>Updating statistics…</Typography>}
      {anError && <Alert severity="error" sx={{ mt: 1.5 }}>{anError}</Alert>}
    </RailSection>
  );

  // A saved record / draft may carry a non-string title (hand-edited, older build).
  const ylabelText = typeof figure.ylabel === "string" ? figure.ylabel.trim() : "";
  const graphSection = (
    <RailSection step={3} title="Graph" done={!!plot?.success}
      summary={`${info.graphs.find((g) => g.id === figure.graph_type)?.label ?? figure.graph_type} · ${figure.theme}${ylabelText ? ` · Y: “${ylabelText}”` : ""}`}
      expanded={open.graph} onToggle={toggle("graph")}>
      <GraphFigureControls template={template} figure={figure} setFigure={setFigure} seriesTitles={colNames} nRep={doc.n_rep}
        hasComparisons={result ? (result.comparisons?.length ?? 0) > 0
          : effAnalysis.test !== "none" && (hasPosthoc(effAnalysis.test) ? effAnalysis.posthoc !== "none" : template === "column")} />
    </RailSection>
  );

  const railFooter = (
    <Stack spacing={1}>
      {plotError && <Alert severity="error" onClose={() => setPlotError(null)}>{plotError}</Alert>}
      <Stack direction="row" alignItems="center" spacing={1}>
        <Tooltip title="Re-render automatically when the data or a setting changes">
          <FormControlLabel sx={{ ml: -0.5, mr: 0 }}
            control={<Switch size="small" checked={liveUpdate} onChange={(e) => setLiveUpdate(e.target.checked)} />}
            label={<Typography variant="body2">Live update</Typography>} />
        </Tooltip>
        <Box sx={{ flexGrow: 1 }} />
        <Tooltip title={`${MOD_KEY} + Enter`}>
          <span>
            <Button variant="contained" disabled={!hasData || plotting}
              onClick={() => { setCanvasTab("graph"); void renderPlot(); }}
              startIcon={plotting ? <CircularProgress size={14} color="inherit" /> : <RefreshIcon />}>
              {plot ? "Re-render" : "Render graph"}
            </Button>
          </span>
        </Tooltip>
      </Stack>
    </Stack>
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey) || !hasData) return;
    // ⌘/Ctrl+Enter inside the Scratchpad commits a cell (Excel), it doesn't render the graph.
    if ((e.target as HTMLElement | null)?.closest?.("[data-scratchpad]")) return;
    e.preventDefault();
    setCanvasTab("graph");
    void renderPlot();
  };

  // ── canvas ────────────────────────────────────────────────────────────────
  const onPasted = (r: PasteResult) => {
    const parts = [`Pasted ${r.rows} row${r.rows === 1 ? "" : "s"} × ${r.cols} column${r.cols === 1 ? "" : "s"}`];
    if (r.titles) parts.push("the first line was used as column titles");
    if (r.truncated) parts.push(`values beyond ${MAX_COLS} ${seriesWord}s or ${MAX_ROWS} rows were left out`);
    setPasteNote({ tone: r.truncated ? "warning" : "success", text: `${parts.join("; ")}. ${MOD_KEY} + Z undoes it.` });
  };

  const dataBody = (
    <Stack spacing={1.25} sx={{ minHeight: 0, flexGrow: 1 }}>
      {pasteNote && <Alert severity={pasteNote.tone} onClose={() => setPasteNote(null)}>{pasteNote.text}</Alert>}
      {invalid > 0 && (
        <Alert severity="warning">
          {invalid} cell{invalid === 1 ? " is" : "s are"} not {invalid === 1 ? "a number" : "numbers"} and {invalid === 1 ? "was" : "were"} ignored (outlined in red).
        </Alert>
      )}
      <Typography variant="caption" color="text.secondary">
        Type values or paste a block from Excel ({MOD_KEY} + V). Enter / Tab / arrows move between cells; {MOD_KEY} + Z undoes a paste or edit.
        {template === "column" ? " Each column is a group, each row one value." : template === "grouped"
          ? " Each row is a level of the row factor; each group has one sub-column per replicate." : " Each row is one X value with its Y values."}
      </Typography>
      <DataGrid onPasted={onPasted} maxHeight={`calc(100vh - ${230 + CHROME}px)`} />
    </Stack>
  );

  const plotWarnings = plot?.warnings ?? [];
  const graphBody = !hasData ? (
    <CanvasNote action={<Button variant="outlined" size="small" startIcon={<GridOnIcon />} onClick={() => setCanvasTab("data")}>Go to the data</Button>}>
      Enter some values on the Data tab — the graph appears here and updates as you type.
    </CanvasNote>
  ) : !plot ? (
    plotting ? <Rendering what="graph" /> : (
      <CanvasNote action={<Button variant="contained" startIcon={<RefreshIcon />} onClick={() => void renderPlot()}>Render graph</Button>}>
        {plotError ?? "The graph hasn't been rendered yet."}
      </CanvasNote>
    )
  ) : (() => {
    const side = canvasWidth >= SIDE_PANEL_MIN_WIDTH;
    const panelWidth = canvasWidth >= SIDE_PANEL_WIDE_FROM ? 340 : 300;
    const alerts = plotWarnings.length > 0 || (plotStale && !liveUpdate);
    const resultFresh = resultKey === anKey;
    const panel = (
      <FigureTextPanel table={table} analysis={effAnalysis} figure={effFigure}
        result={resultFresh ? result : null} busy={analyzing || !resultFresh} stale={plotStale && !liveUpdate}
        error={resultFresh ? anError : null} renderFailed={!plot.success} side={side} panelWidth={panelWidth} open={textOpen}
        onToggle={(o) => { setTextOpen(o); writeTextPanelOpen(o); }}
        figLabel={typeof figure.fig_label === "string" ? figure.fig_label : "Fig. 1"}
        unit={typeof figure.n_unit === "string" ? figure.n_unit : ""} onLegendFields={(patch) => setFigure(patch)} />
    );
    return (
      <Box ref={canvasRef} sx={{ display: "flex", flexDirection: side ? "row" : "column", gap: 2, alignItems: side ? "flex-start" : "stretch", minHeight: 0 }}>
        <Stack spacing={1.5} sx={{ minHeight: 0, minWidth: 0, flex: side ? "1 1 0" : "0 0 auto" }}>
          <TitleFields dense figure={figure} setFigure={setFigure} template={template} />
          {plotWarnings.length > 0 && <Alert severity="warning">{plotWarnings.map((w) => <div key={w}>{w}</div>)}</Alert>}
          {plotStale && !liveUpdate && (
            <Alert severity="info" action={<Button color="inherit" size="small" onClick={() => void renderPlot()}>Re-render</Button>}>
              The data or settings changed since this graph was rendered.
            </Alert>
          )}
          {/* stacked: cap the figure so the open legend panel starts above the fold */}
          <FigureView result={plot} busy={plotting} baseName={baseName}
            fitHeight={(() => {
              const full = alerts ? `calc(100vh - ${306 + CHROME}px)` : `calc(100vh - ${246 + CHROME}px)`;
              return side || !textOpen ? full : `min(${full}, 42vh)`;
            })()} />
        </Stack>
        {panel}
      </Box>
    );
  })();

  const resultsBody = (
    <GraphResults result={result} error={anError} busy={analyzing} template={template}
      rowTitles={table.row_titles} withinTitles={withinCols ? colNames : table.row_titles} baseName={baseName} />
  );

  const scratchBody = (
    <Stack spacing={1.25} sx={{ minHeight: 0, flexGrow: 1 }}>
      <ScratchBoundary>
        <Suspense fallback={
          <Box sx={{ flexGrow: 1, display: "grid", placeItems: "center" }}>
            <Stack alignItems="center" spacing={1.5}>
              <CircularProgress size={28} />
              <Typography variant="body2" color="text.secondary">Loading the scratchpad…</Typography>
            </Stack>
          </Box>
        }>
          <ScratchpadTab onSent={(r) => { onPasted(r); setCanvasTab("data"); }} />
        </Suspense>
      </ScratchBoundary>
    </Stack>
  );

  const body = canvasTab === "scratch" ? scratchBody : canvasTab === "data" ? dataBody : canvasTab === "graph" ? graphBody : resultsBody;
  const tabSx = { minHeight: 44 };

  return (
    <Workspace rail={<>{canvasTab === "scratch" && <ScratchRail />}{tableSection}{analysisSection}{graphSection}</>} railFooter={railFooter} onKeyDown={onKeyDown}>
      <Box sx={{ display: "flex", alignItems: "center", px: 2, borderBottom: 1, borderColor: "divider", flexShrink: 0, minHeight: 44 }}>
        <Tabs value={canvasTab} onChange={(_, v) => setCanvasTab(v)} variant="scrollable" scrollButtons={false} sx={{ ...tabSx, flexShrink: 0 }}>
          <Tab value="scratch" label="Scratchpad" icon={<CalculateOutlinedIcon sx={{ fontSize: 18 }} />} iconPosition="start" sx={tabSx} />
          <Tab value="data" label="Data" icon={<GridOnIcon sx={{ fontSize: 18 }} />} iconPosition="start" sx={tabSx} />
          <Tab value="graph" label="Graph" icon={<InsertChartOutlinedIcon sx={{ fontSize: 18 }} />} iconPosition="start" sx={tabSx} />
          <Tab value="results" label="Results" icon={<TableChartIcon sx={{ fontSize: 18 }} />} iconPosition="start" sx={tabSx} />
        </Tabs>
        <Box sx={{ flexGrow: 1, minWidth: 8 }} />
        {undoLabel && (
          // The canvas tabs keep their width; this button gives way (down to its icon) when there is no room.
          <Tooltip title={`${undoTooltip(undoLabel)} (${MOD_KEY} + Z)`}>
            <Button size="small" color="inherit" startIcon={<UndoIcon sx={{ fontSize: 16 }} />} data-testid="graph-undo-combine"
              aria-label={undoLabel}
              onClick={() => { store.getState().undo(); }}
              sx={{ mr: 1.5, flexShrink: 1, minWidth: 32, maxWidth: 340, overflow: "hidden", color: "text.secondary", "& .MuiButton-startIcon": { mr: 0.5, ml: 0 } }}>
              <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{undoLabel}</Box>
            </Button>
          </Tooltip>
        )}
        {updating ? (
          <Stack direction="row" spacing={1} alignItems="center" data-testid="canvas-updating" sx={{ flexShrink: 0 }}>
            <CircularProgress size={12} />
            <Typography variant="caption" color="text.secondary">{V.updating}</Typography>
          </Stack>
        ) : canvasTab === "graph" && plotting ? (
          <Stack direction="row" spacing={1} alignItems="center">
            <CircularProgress size={12} />
            <Typography variant="caption" color="text.secondary">Rendering…</Typography>
          </Stack>
        ) : canvasTab === "graph" && plot?.success ? (
          <Typography variant="caption" color="text.secondary" noWrap sx={{ minWidth: 0 }}>
            {figure.width} × {figure.height} px · {figure.dpi} dpi · {figure.export_format.toUpperCase()}
          </Typography>
        ) : canvasTab === "scratch" ? (
          <ScratchCaption />
        ) : canvasTab === "results" && result?.test ? (
          <Chip size="small" variant="outlined" label={`${result.test.label}: P ${formatP(result.test.p)} ${result.test.star || "ns"}`} />
        ) : null}
      </Box>
      <Box sx={{ p: 2, flexGrow: 1, display: "flex", flexDirection: "column", minHeight: 0, position: "relative" }}>
        {body}
        {updating && canvasTab === "graph" && (
          <Box data-testid="graph-updating" sx={{
            position: "absolute", inset: 0, zIndex: 1, pointerEvents: "none", bgcolor: "rgba(28,28,30,0.35)",
            display: "flex", alignItems: "flex-start", justifyContent: "center", pt: 6,
          }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ bgcolor: "background.paper", px: 1.5, py: 0.75, borderRadius: 1, boxShadow: 3 }}>
              <CircularProgress size={14} />
              <Typography variant="body2">{V.updating}</Typography>
            </Stack>
          </Box>
        )}
      </Box>
    </Workspace>
  );
}

function CanvasSpinner({ overlay }: { overlay?: boolean }) {
  return (
    <Box data-testid="canvas-busy" sx={{
      position: "absolute", inset: 0, display: "grid", placeItems: "center", zIndex: 2,
      bgcolor: overlay ? "rgba(28,28,30,0.55)" : "background.default",
    }}>
      <CircularProgress size={28} />
    </Box>
  );
}

/** The Graphs tool: open analyses as tabs; the active one's document bar and
 *  workspace, its restore card, or the start screen (contract §5.2). */
export function GraphView() {
  const ready = useFileSession((s) => s.ready);
  const hasTabs = useFileSession((s) => s.tabs.length > 0);
  const activeKey = useFileSession((s) => s.activeKey);
  const tab = useFileSession((s) => s.tabs.find((t) => t.key === s.activeKey) ?? null);
  const card = useFileSession((s) => s.cards.find((c) => c.key === s.activeKey) ?? null);
  const busy = useFileSession((s) => s.busy);
  const loadedKey = useGraphStore((s) => (s.doc ? s.file?.docKey ?? null : null));
  const loaded = !!activeKey && loadedKey === activeKey;
  const versions = useFileSession((s) => (s.versions && s.versions.tabKey === s.activeKey ? s.versions : null));
  // Narrow windows: the Versions panel lies over the workspace instead of squeezing it.
  const [areaRef, areaWidth] = useElementWidth();
  const overlay = areaWidth > 0 && areaWidth < VERSIONS_PANEL_WIDTH + 840;

  let main: ReactNode;
  if (!ready && !hasTabs) main = <CanvasSpinner />;
  else if (activeKey === null || !tab) main = <StartScreen />;
  else if (card) main = <RestoreCardView card={card} />;
  else {
    main = (
      <>
        <DocBar tab={tab} />
        <Box ref={areaRef} sx={{ position: "relative", flexGrow: 1, minHeight: 0, display: "flex" }}>
          <Box sx={{ position: "relative", flexGrow: 1, minHeight: 0, minWidth: 0 }}>
            {loaded && <Box sx={{ position: "absolute", inset: 0 }}><GraphEditor /></Box>}
            {(!loaded || busy || tab.status === "opening") && <CanvasSpinner overlay={loaded} />}
            {versions?.selectedId && (
              <Box sx={{ position: "absolute", top: 0, bottom: 0, left: 0, right: overlay ? `${VERSIONS_PANEL_WIDTH}px` : 0, zIndex: 3 }}>
                <VersionPreview v={versions} />
              </Box>
            )}
          </Box>
          {versions && (
            <Box sx={overlay
              ? { position: "absolute", top: 0, right: 0, bottom: 0, zIndex: 4, display: "flex", boxShadow: 8 }
              : { display: "flex", minHeight: 0 }}>
              <VersionsPanel v={versions} />
            </Box>
          )}
        </Box>
      </>
    );
  }

  return (
    <Box sx={{ height: "100%", minHeight: 0, display: "flex", flexDirection: "column" }}>
      {hasTabs && <FileTabs />}
      <Box sx={{ flexGrow: 1, minHeight: 0, display: "flex", flexDirection: "column", position: "relative" }}>{main}</Box>
    </Box>
  );
}
