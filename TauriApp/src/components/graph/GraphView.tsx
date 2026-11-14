import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Alert, Box, Button, Chip, CircularProgress, FormControlLabel, Stack, Switch, Tab, Tabs, Tooltip, Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import RemoveIcon from "@mui/icons-material/Remove";
import InsertChartOutlinedIcon from "@mui/icons-material/InsertChartOutlined";
import RefreshIcon from "@mui/icons-material/Refresh";
import TableChartIcon from "@mui/icons-material/TableChart";
import GridOnIcon from "@mui/icons-material/GridOn";
import { analyzeGraph, plotGraph, type AnalyzeResult, type GraphPlotResult } from "../../api/graph";
import { clearDraft, isDirty, readDraft, useGraphStore, writeDraft, type DraftStatus } from "../../store/graphStore";
import { PlotResult } from "../shared/PlotResult";
import { Workspace } from "../shared/Workspace";
import { RailHeading, RailSection } from "../shared/RailSection";
import { NumberField } from "../shared/NumberField";
import { DataGrid } from "./DataGrid";
import { FileBar, MOD_KEY, StartScreen, useGraphLibrary } from "./GraphLibrary";
import { GraphAnalysisControls } from "./GraphAnalysisControls";
import { GraphFigureControls, TitleFields } from "./GraphFigureControls";
import { FigureTextPanel, readTextPanelOpen, writeTextPanelOpen } from "./FigureTextPanel";
import { GraphResults } from "./GraphResults";
import {
  GRAPH_DEFAULT, MAX_COLS, MAX_REP, MAX_ROWS, POSTHOC_LABELS, TEST_LABELS, colHasData, countInvalid, defaultColTitle,
  effectiveAnalysis, effectiveFigure, formatP, hasNumbers, hasPosthoc, normalizeAnalysis, templateInfo, toNumericTable, usedCols,
  usedRows, valuesBeyondRep, type PasteResult,
} from "./graphModel";

type Step = "table" | "analysis" | "graph";
type CanvasTab = "data" | "graph" | "results";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A rendered figure that stays visible (dimmed) while a newer one renders. */
function FigureView({ result, busy, baseName, fitHeight }: {
  result: GraphPlotResult; busy: boolean; baseName: string; fitHeight: string;
}) {
  return (
    <Box sx={{ position: "relative", alignSelf: "flex-start", maxWidth: "100%" }}>
      <PlotResult result={result} baseName={baseName} fitHeight={fitHeight} />
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

// Restore an unsaved document left over from the last session (once per app run).
let draftChecked = false;

export function GraphView() {
  const lib = useGraphLibrary();
  const doc = useGraphStore((s) => s.doc);
  const analysis = useGraphStore((s) => s.analysis);
  const figure = useGraphStore((s) => s.figure);
  const docSerial = useGraphStore((s) => s.docSerial);
  const openedAs = useGraphStore((s) => s.openedAs);
  const setAnalysis = useGraphStore((s) => s.setAnalysis);
  const setFigure = useGraphStore((s) => s.setFigure);
  const store = useGraphStore;

  const name = useGraphStore((s) => s.name);
  const [restored, setRestored] = useState(false);
  /** Why unsaved changes aren't being kept as a local draft (null = they are, or nothing to keep). */
  const [draftProblem, setDraftProblem] = useState<Exclude<DraftStatus, "saved"> | null>(null);
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

  // ── restore a draft on first mount ────────────────────────────────────────
  useEffect(() => {
    if (draftChecked) return;
    draftChecked = true;
    if (store.getState().doc) return;
    const d = readDraft();
    if (!d) return;
    // openedAs "draft" makes the per-document effect show the "restored" notice.
    store.getState().load({ doc: d.doc, analysis: d.analysis, figure: d.figure, name: d.name, id: d.currentId, saved: false });
  }, [store]);

  // ── autosave unsaved changes as a local draft (debounced) ─────────────────
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const unsub = store.subscribe((s, prev) => {
      if (s.doc === prev.doc && s.analysis === prev.analysis && s.figure === prev.figure && s.name === prev.name
        && s.savedSnapshot === prev.savedSnapshot) return;
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        const cur = store.getState();
        if (isDirty(cur)) {
          const st = writeDraft(cur);
          setDraftProblem(st === "saved" ? null : st);
        } else {
          clearDraft();
          setDraftProblem(null);
        }
      }, 1000);
    });
    return () => { unsub(); if (t) clearTimeout(t); };
  }, [store]);

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
    setRestored(openedAs === "draft");
  }, [docSerial, openedAs]);

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

  // Keep the test / post-hoc / indices valid for the data as it changes.
  useEffect(() => {
    if (!doc || !hasData) return;
    setAnalysis((a) => normalizeAnalysis(a, { template: doc.template, nGroups, nRows, nEntities: nEntitiesAll }));
    if (!templateInfo(doc.template).graphs.some((g) => g.id === figure.graph_type)) setFigure({ graph_type: GRAPH_DEFAULT[doc.template] });
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
  if (!doc || !table) return <StartScreen lib={lib} />;

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
      <GraphFigureControls template={template} figure={figure} setFigure={setFigure} seriesTitles={colNames}
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
      {restored && (
        <Alert severity="info" onClose={() => setRestored(false)}>
          Unsaved changes restored from your last session.
        </Alert>
      )}
      {pasteNote && <Alert severity={pasteNote.tone} onClose={() => setPasteNote(null)}>{pasteNote.text}</Alert>}
      {draftProblem && (
        <Alert severity="warning">
          {draftProblem === "too_large"
            ? "This table is too large to keep unsaved changes automatically. Save it to keep your changes."
            : "Unsaved changes couldn't be kept as a local backup. Save to keep your changes."}
        </Alert>
      )}
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
      <DataGrid onPasted={onPasted} maxHeight="calc(100vh - 230px)" />
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
        onToggle={(o) => { setTextOpen(o); writeTextPanelOpen(o); }} />
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
              const full = alerts ? "calc(100vh - 306px)" : "calc(100vh - 246px)";
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

  const body = canvasTab === "data" ? dataBody : canvasTab === "graph" ? graphBody : resultsBody;
  const tabSx = { minHeight: 44 };

  return (
    <Workspace rail={<>{tableSection}{analysisSection}{graphSection}</>} railFooter={railFooter} onKeyDown={onKeyDown}>
      <FileBar lib={lib} />
      <Box sx={{ display: "flex", alignItems: "center", px: 2, borderBottom: 1, borderColor: "divider", flexShrink: 0, minHeight: 44 }}>
        <Tabs value={canvasTab} onChange={(_, v) => setCanvasTab(v)} variant="scrollable" scrollButtons={false} sx={tabSx}>
          <Tab value="data" label="Data" icon={<GridOnIcon sx={{ fontSize: 18 }} />} iconPosition="start" sx={tabSx} />
          <Tab value="graph" label="Graph" icon={<InsertChartOutlinedIcon sx={{ fontSize: 18 }} />} iconPosition="start" sx={tabSx} />
          <Tab value="results" label="Results" icon={<TableChartIcon sx={{ fontSize: 18 }} />} iconPosition="start" sx={tabSx} />
        </Tabs>
        <Box sx={{ flexGrow: 1 }} />
        {canvasTab === "graph" && plotting ? (
          <Stack direction="row" spacing={1} alignItems="center">
            <CircularProgress size={12} />
            <Typography variant="caption" color="text.secondary">Rendering…</Typography>
          </Stack>
        ) : canvasTab === "graph" && plot?.success ? (
          <Typography variant="caption" color="text.secondary" noWrap>
            {figure.width} × {figure.height} px · {figure.dpi} dpi · {figure.export_format.toUpperCase()}
          </Typography>
        ) : canvasTab === "results" && result?.test ? (
          <Chip size="small" variant="outlined" label={`${result.test.label}: P ${formatP(result.test.p)} ${result.test.star || "ns"}`} />
        ) : null}
      </Box>
      <Box sx={{ p: 2, flexGrow: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>{body}</Box>
    </Workspace>
  );
}
