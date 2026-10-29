import { useEffect, useMemo, useRef, useState, type HTMLAttributes, type Key, type KeyboardEvent, type ReactNode } from "react";
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  LinearProgress,
  MenuItem,
  Slider,
  Stack,
  Switch,
  Tab,
  Tabs,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import GridOnIcon from "@mui/icons-material/GridOn";
import GridViewIcon from "@mui/icons-material/GridView";
import InsertChartOutlinedIcon from "@mui/icons-material/InsertChartOutlined";
import ScatterPlotIcon from "@mui/icons-material/ScatterPlot";
import TableChartIcon from "@mui/icons-material/TableChart";
import RefreshIcon from "@mui/icons-material/Refresh";
import {
  analyzeQpcr,
  deleteQpcrRun,
  getQpcrLibrary,
  importQpcrRuns,
  plotQpcr,
  plotQpcrCp,
  saveQpcrManualRun,
  type QpcrAnalyzeResult,
  type QpcrLibrary,
  type QpcrLibraryRun,
} from "../../api/client";
import type { RunRResponse } from "../../api/types";
import { useQpcrManualStore, type QpcrRecord } from "../../store/qpcrManualStore";
import { RecordTable } from "../shared/RecordTable";
import { PlotResult } from "../shared/PlotResult";
import { Workspace } from "../shared/Workspace";
import { RailHeading, RailSection } from "../shared/RailSection";
import { FileDropZone } from "../shared/FileDropZone";
import { NumberField } from "../shared/NumberField";
import { QpcrManualEntry } from "./QpcrManualEntry";
import { QpcrOverview } from "./QpcrOverview";
import { assignColors, buildDataset, notDetected, pick } from "./qpcrData";

const PALETTES: Record<string, string[]> = {
  Default: ["#5a7fa8", "#63a66a", "#c1666b", "#d4a05a", "#8a6fae", "#4aa3a3", "#b07aa1", "#9c9c4a"],
  "Colour-blind": ["#0072B2", "#E69F00", "#009E73", "#CC79A7", "#56B4E9", "#D55E00", "#F0E442", "#000000"],
  Greyscale: ["#1f1f1f", "#5c5c5c", "#8f8f8f", "#c2c2c2", "#3d3d3d", "#737373", "#a8a8a8", "#e0e0e0"],
};

/** Common qPCR reference genes — pre-selected as the reference when present. */
const HOUSEKEEPING = /^(GAPDH|ACTB|B2M|HPRT1?|RPLP0|TBP|PPIA|GUSB|YWHAZ|UBC|HMBS|SDHA|PGK1|RPL13A|18S|RN18S1?)$/i;

const MOD_KEY = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform) ? "⌘" : "Ctrl";

// Which library runs are ticked — remembered between launches (best-effort).
const PREF_INCLUDED = "las.qpcr.includedRuns";
const readIncluded = (): number[] | null => {
  try { const v = localStorage.getItem(PREF_INCLUDED); return v ? (JSON.parse(v) as number[]) : null; } catch { return null; }
};
const writeIncluded = (ids: Iterable<number>) => {
  try { localStorage.setItem(PREF_INCLUDED, JSON.stringify([...ids])); } catch { /* ignore */ }
};

type Step = "data" | "analysis" | "figure";
type StepError = { step: Step; msg: string } | null;
type Selection = { genes: string[]; refs: string[]; samples: string[]; key: string };
type CanvasTab = "overview" | "cp" | "figure" | "results";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function nowLabel() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Caption + slider with the current value shown on the right. */
function LabeledSlider({
  label, value, onChange, min, max, step, format,
}: {
  label: string; value: number; onChange: (v: number) => void;
  min: number; max: number; step: number; format?: (v: number) => string;
}) {
  return (
    <Box sx={{ px: 0.5, mt: 0.5 }}>
      <Stack direction="row" justifyContent="space-between">
        <Typography variant="caption" color="text.secondary">{label}</Typography>
        <Typography variant="caption">{format ? format(value) : value}</Typography>
      </Stack>
      <Slider value={value} min={min} max={max} step={step} onChange={(_, v) => onChange(v as number)} sx={{ py: 1 }} />
    </Box>
  );
}

const Grid2 = ({ children }: { children: ReactNode }) => (
  <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1 }}>{children}</Box>
);

/** Two quick-select links shown under a multi-select. */
function QuickPicks({ onAll, onClear, allLabel }: { onAll: () => void; onClear: () => void; allLabel: string }) {
  return (
    <Stack direction="row" spacing={0.5} sx={{ mt: 0.25 }}>
      <Button size="small" onClick={onAll} sx={{ minWidth: 0, px: 0.75 }}>{allLabel}</Button>
      <Button size="small" color="inherit" onClick={onClear} sx={{ minWidth: 0, px: 0.75, color: "text.secondary" }}>Clear</Button>
    </Stack>
  );
}

/** Autocomplete option with a right-aligned note (run coverage, Cp warning). */
function OptionRow({ props, label, note, warn }: {
  props: HTMLAttributes<HTMLLIElement> & { key?: Key }; label: string; note: string; warn?: string;
}) {
  const { key, ...rest } = props;
  return (
    <li key={key} {...rest}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, width: "100%" }}>
        <Box component="span" sx={{ flexGrow: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{label}</Box>
        {warn && <Typography variant="caption" color="warning.main" noWrap>{warn}</Typography>}
        <Typography variant="caption" color="text.secondary" noWrap>{note}</Typography>
      </Box>
    </li>
  );
}

/** Guidance shown on the canvas before there is anything to show. */
function CanvasEmpty({ active, action }: { active: number; action?: ReactNode }) {
  const steps = [
    "Add runs to the library — drop LightCycler *_qpcr.txt + *_platemap.txt pairs, or type Cp values on a plate. They stay in the library for next time.",
    "Tick the runs to analyse, choose reference and target genes, the control and the samples to compare, then run ΔΔCt.",
    "Style the figure on the left — it re-renders live — and export it as PNG or TIFF.",
  ];
  return (
    <Box sx={{ flexGrow: 1, display: "grid", placeItems: "center", py: 6 }}>
      <Box sx={{ maxWidth: 480 }}>
        <InsertChartOutlinedIcon sx={{ fontSize: 40, color: "text.disabled" }} />
        <Typography variant="h6" sx={{ mt: 1, mb: 1 }}>qPCR ΔΔCt analysis</Typography>
        {steps.map((t, i) => (
          <Stack key={t} direction="row" spacing={1.5} sx={{ mt: 1.5, opacity: i === active ? 1 : 0.5 }}>
            <Box
              sx={{
                width: 22, height: 22, flexShrink: 0, borderRadius: "50%", display: "grid", placeItems: "center",
                fontSize: 11, fontWeight: 700, border: "1.5px solid",
                borderColor: i === active ? "primary.main" : "divider",
                color: i === active ? "primary.main" : "text.secondary",
              }}
            >
              {i + 1}
            </Box>
            <Typography variant="body2">{t}</Typography>
          </Stack>
        ))}
        {action && <Box sx={{ mt: 3 }}>{action}</Box>}
      </Box>
    </Box>
  );
}

/** A rendered figure that stays visible (dimmed) while a newer one renders. */
function FigureView({ result, busy, baseName, fitHeight }: {
  result: RunRResponse; busy: boolean; baseName: string; fitHeight: string;
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

export function QpcrView() {
  // ── run library ───────────────────────────────────────────────────────────
  const [library, setLibrary] = useState<QpcrLibraryRun[] | null>(null);
  const [libraryPath, setLibraryPath] = useState("");
  const [includedIds, setIncludedIds] = useState<ReadonlySet<number>>(() => new Set());
  const [importing, setImporting] = useState(false);
  const [importNote, setImportNote] = useState<{ tone: "success" | "warning"; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [runFilter, setRunFilter] = useState("");
  const [cpLimit, setCpLimit] = useState(35);
  const [excludeHigh, setExcludeHigh] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualName, setManualName] = useState("");
  const [manualErr, setManualErr] = useState<string | null>(null);
  const [savingManual, setSavingManual] = useState(false);

  // ── analysis ──────────────────────────────────────────────────────────────
  const [useCommon, setUseCommon] = useState(true);
  const [refGenes, setRefGenes] = useState<string[]>([]);
  const [targetGenes, setTargetGenes] = useState<string[]>([]);
  const [control, setControl] = useState<string>("");
  const [experimental, setExperimental] = useState<string[]>([]);
  const [method, setMethod] = useState<"auto" | "ttest" | "anova">("auto");
  const [analysis, setAnalysis] = useState<QpcrAnalyzeResult | null>(null);
  const [analyzedSel, setAnalyzedSel] = useState<Selection | null>(null);
  const [analysisWarnings, setAnalysisWarnings] = useState<string[]>([]);

  // ── figure ────────────────────────────────────────────────────────────────
  const [layout, setLayout] = useState<"grouped" | "faceted">("grouped");
  const [plotType, setPlotType] = useState<"bar" | "violin" | "box" | "dot">("bar");
  const [showRefs, setShowRefs] = useState(false);
  const [theme, setTheme] = useState<"prism" | "classic" | "minimal">("prism");
  const [errorType, setErrorType] = useState<"SD" | "SEM">("SD");
  const [showPoints, setShowPoints] = useState(false);
  const [pointSize, setPointSize] = useState(1.8);
  const [barWidth, setBarWidth] = useState(0.7);
  const [sigLevel, setSigLevel] = useState(0.05);
  const [hideNs, setHideNs] = useState(true);
  const [title, setTitle] = useState("Fold change per gene");
  const [xlabel, setXlabel] = useState("Gene");
  const [ylabel, setYlabel] = useState("Fold change");
  const [fontSize, setFontSize] = useState(14);
  const [colors, setColors] = useState<Record<string, string>>({});
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [plotWidth, setPlotWidth] = useState(1200);
  const [plotHeight, setPlotHeight] = useState(800);
  const [dpi, setDpi] = useState(150);
  const [exportFormat, setExportFormat] = useState<"png" | "tiff">("png");
  const [transparent, setTransparent] = useState(false);
  const [plot, setPlot] = useState<RunRResponse | null>(null);
  const [liveUpdate, setLiveUpdate] = useState(true);
  const [cpPlot, setCpPlot] = useState<RunRResponse | null>(null);

  // ── ui ────────────────────────────────────────────────────────────────────
  const [open, setOpen] = useState<Record<Step, boolean>>({ data: true, analysis: false, figure: false });
  const [canvasTab, setCanvasTab] = useState<CanvasTab>("overview");
  const [analyzing, setAnalyzing] = useState(false);
  const [plotting, setPlotting] = useState(false);
  const [cpPlotting, setCpPlotting] = useState(false);
  const [err, setErr] = useState<StepError>(null);

  const plotSeq = useRef(0);
  const cpSeq = useRef(0);
  /** Params key of the last requested fold-change render; null until the first one. */
  const figKey = useRef<string | null>(null);
  /** Params key of the last requested Cp render. */
  const cpKeyRendered = useRef<string | null>(null);

  // ── derived data ──────────────────────────────────────────────────────────
  const runs = library ?? [];
  const includedKey = [...includedIds].sort((a, b) => a - b).join(",");
  const ds = useMemo(
    () => buildDataset(runs.filter((r) => includedIds.has(r.id))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [library, includedKey],
  );
  const genes = useCommon ? ds.genesCommon : ds.genesAll;
  const samples = ds.samples;
  const sampleOrder = control ? [control, ...experimental] : experimental;
  const cpGenes = targetGenes.length ? [...refGenes, ...targetGenes.filter((g) => !refGenes.includes(g))] : ds.genesAll;
  const cpSamples = experimental.length ? sampleOrder : samples;
  const lowCp = useMemo(
    () => notDetected(ds.runs, ds.genesAll, cpSamples, cpLimit),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ds, cpSamples.join("\u0000"), cpLimit],
  );
  // Everything that changes the analysis input (not view-only switches).
  const selKey = JSON.stringify([refGenes, targetGenes, sampleOrder, method, ds.runIds, excludeHigh ? cpLimit : null]);
  const stale = !!analysis && analyzedSel?.key !== selKey;
  const canAnalyze = ds.runs.length > 0 && refGenes.length > 0 && targetGenes.length > 0 && !!control && experimental.length > 0;
  const toggle = (s: Step) => (o: boolean) => setOpen((p) => ({ ...p, [s]: o }));

  const buildParams = (sel: Selection) => ({
    gene_order: showRefs ? [...sel.refs.filter((r) => !sel.genes.includes(r)), ...sel.genes] : sel.genes,
    sample_order: sel.samples, colors: pick(colors, sel.samples), labels: pick(labels, sel.samples),
    error_type: errorType, layout, plot_type: plotType, show_points: showPoints,
    point_size: pointSize, bar_width: barWidth, theme, significance_level: sigLevel,
    hide_ns: hideNs, title, xlabel, ylabel, font_size: fontSize,
    width: plotWidth, height: plotHeight, dpi, export_format: exportFormat, transparent,
  });
  const paramsKey = analyzedSel ? JSON.stringify(buildParams(analyzedSel)) : "";

  const cpParams = {
    run_ids: ds.runIds, gene_order: cpGenes, sample_order: cpSamples, reference_genes: refGenes, cp_limit: cpLimit,
    colors: pick(colors, cpSamples), labels: pick(labels, cpSamples), theme, point_size: pointSize,
    font_size: fontSize, width: plotWidth, height: plotHeight, dpi, export_format: exportFormat, transparent,
  };
  const cpKey = JSON.stringify(cpParams);

  // ── library actions ───────────────────────────────────────────────────────

  /** Adopt a library listing; optionally tick the runs named in `include`. */
  const adoptLibrary = (lib: QpcrLibrary, include: string[] = []) => {
    setLibrary(lib.runs);
    setLibraryPath(lib.path);
    setIncludedIds((prev) => {
      const ids = new Set(lib.runs.map((r) => r.id));
      const next = new Set([...prev].filter((id) => ids.has(id)));
      lib.runs.forEach((r) => { if (include.includes(r.name)) next.add(r.id); });
      writeIncluded(next);
      return next;
    });
  };

  const loadLibrary = async () => {
    setErr(null);
    try {
      const lib = await getQpcrLibrary();
      const saved = readIncluded();
      const ids = new Set(lib.runs.map((r) => r.id));
      setLibrary(lib.runs);
      setLibraryPath(lib.path);
      setIncludedIds(new Set(saved === null ? ids : saved.filter((id) => ids.has(id))));
    } catch (e) {
      setErr({ step: "data", msg: `Couldn't open the run library: ${errMsg(e)}` });
    }
  };
  useEffect(() => { void loadLibrary(); }, []);

  const importFiles = async (fs: File[]) => {
    setImporting(true);
    setErr(null);
    setImportNote(null);
    try {
      const res = await importQpcrRuns(fs);
      adoptLibrary(res, [...res.added, ...res.replaced]);
      const done = [res.added.length && `Added ${res.added.join(", ")}`, res.replaced.length && `Updated ${res.replaced.join(", ")}`]
        .filter(Boolean) as string[];
      const problems = [
        ...res.unpaired.map((n) => `${n} has no matching ${n.endsWith("_qpcr.txt") ? "plate map" : "qPCR file"}`),
        ...res.errors,
      ];
      if (!done.length && !problems.length) problems.push("No LightCycler pairs found — names must end in _qpcr.txt and _platemap.txt");
      if (res.replaced.length) problems.push("A run with the same name was already in the library; its wells were replaced");
      setImportNote({ tone: problems.length ? "warning" : "success", text: [...done, ...problems].join(". ") + "." });
      if (done.length) setOpen((p) => ({ ...p, analysis: true }));
    } catch (e) {
      setErr({ step: "data", msg: errMsg(e) });
    } finally {
      setImporting(false);
    }
  };

  const removeRun = async (id: number) => {
    setConfirmDelete(null);
    try {
      adoptLibrary(await deleteQpcrRun(id));
    } catch (e) {
      setErr({ step: "data", msg: errMsg(e) });
    }
  };

  const toggleRun = (id: number) =>
    setIncludedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      writeIncluded(next);
      return next;
    });

  const setAllRuns = (on: boolean) => {
    const next = new Set(on ? runs.map((r) => r.id) : []);
    writeIncluded(next);
    setIncludedIds(next);
  };

  const openManual = () => {
    // Re-opening a plate that was saved keeps its name, so saving an edit
    // replaces that run instead of adding a duplicate next to it.
    const { savedAs, values } = useQpcrManualStore.getState();
    const hasWells = Object.values(values.Cp).some((v) => v.trim() !== "");
    const savedRun = savedAs ? runs.find((r) => r.name === savedAs && r.source === "manual") : undefined;
    let name = `Manual ${nowLabel()}`;
    for (let n = 2; runs.some((r) => r.name === name); n++) name = `Manual ${nowLabel()} (${n})`;
    setManualName(hasWells && savedRun ? savedRun.name : name);
    setManualErr(null);
    setManualOpen(true);
  };

  const saveManual = async (records: QpcrRecord[]) => {
    const name = manualName.trim();
    if (!name) { setManualErr("Give the plate a name."); return; }
    setSavingManual(true);
    setManualErr(null);
    try {
      const res = await saveQpcrManualRun(name, records);
      if (res.error) { setManualErr(res.error); return; }
      useQpcrManualStore.getState().setSavedAs(name);
      adoptLibrary(res, [name]);
      setManualOpen(false);
      setImportNote({ tone: "success", text: `${res.replaced ? "Updated" : "Added"} ${name}.` });
      setOpen((p) => ({ ...p, analysis: true }));
    } catch (e) {
      setManualErr(errMsg(e));
    } finally {
      setSavingManual(false);
    }
  };

  // When the included runs (or the gene scope) change: keep still-valid choices
  // and colours and default the reference gene. (A changed run set also marks a
  // finished analysis as stale via selKey.) A default reference must be in
  // EVERY ticked run — normalising runs to different references biases the
  // fold change — so it comes from genesCommon whatever the scope switch says.
  const datasetKey = JSON.stringify([ds.genesAll, ds.genesCommon, ds.samples, useCommon]);
  useEffect(() => {
    const geneSet = new Set(useCommon ? ds.genesCommon : ds.genesAll);
    const sampleSet = new Set(ds.samples);
    setRefGenes((prev) => {
      const kept = prev.filter((g) => geneSet.has(g));
      return kept.length ? kept : ds.genesCommon.filter((g) => HOUSEKEEPING.test(g));
    });
    setTargetGenes((prev) => prev.filter((g) => geneSet.has(g)));
    setControl((prev) => (sampleSet.has(prev) ? prev : ""));
    setExperimental((prev) => prev.filter((s) => sampleSet.has(s)));
    // Colours/labels are only ever added, so an existing figure keeps its look.
    setColors((prev) => assignColors(prev, ds.samples, PALETTES.Default));
    setLabels((prev) => ({ ...Object.fromEntries(ds.samples.map((s) => [s, s])), ...prev }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetKey]);

  // ── analysis + figures ────────────────────────────────────────────────────

  const runPlot = async (a: QpcrAnalyzeResult, sel: Selection) => {
    if (!a.summary?.length) return;
    const params = buildParams(sel);
    const seq = ++plotSeq.current;
    figKey.current = JSON.stringify(params);
    setPlotting(true);
    setErr((e) => (e?.step === "figure" ? null : e));
    try {
      const res = await plotQpcr({
        summary: a.summary,
        points: (a.analysis_data ?? []).map((r) => ({ Gene: r.Gene, Sample: r.Sample, value: r.Fold_Change })),
        ttest_results: a.ttest_results,
        anova_tukey_results: a.anova_tukey_results,
        ...params,
      });
      if (seq === plotSeq.current) setPlot(res);
    } catch (e) {
      if (seq === plotSeq.current) setErr({ step: "figure", msg: errMsg(e) });
    } finally {
      if (seq === plotSeq.current) setPlotting(false);
    }
  };

  const runAnalysis = async () => {
    if (!canAnalyze || analyzing) return;
    setAnalyzing(true);
    setErr(null);
    try {
      const res = await analyzeQpcr({
        run_ids: ds.runIds, cp_max: excludeHigh ? cpLimit : null,
        reference_genes: refGenes, target_genes: targetGenes, control, experimental, method,
      });
      setAnalysisWarnings(res.warnings ?? []);
      if (res.error) { setErr({ step: "analysis", msg: res.error }); return; }
      const sel: Selection = { genes: targetGenes, refs: refGenes, samples: sampleOrder, key: selKey };
      setAnalysis(res);
      setAnalyzedSel(sel);
      setPlot(null);
      setOpen({ data: false, analysis: false, figure: true });
      setCanvasTab("figure");
      void runPlot(res, sel); // render straight away
    } catch (e) {
      setErr({ step: "analysis", msg: errMsg(e) });
    } finally {
      setAnalyzing(false);
    }
  };

  // Live preview: once a figure exists, re-render (debounced) whenever a
  // figure setting changes. Stale responses are dropped by plotSeq.
  useEffect(() => {
    if (!liveUpdate || !analysis || !analyzedSel || figKey.current === null || paramsKey === figKey.current) return;
    const t = setTimeout(() => { void runPlot(analysis, analyzedSel); }, 650);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramsKey, liveUpdate, analysis, analyzedSel]);

  const renderCp = async (params: typeof cpParams, key: string) => {
    const seq = ++cpSeq.current;
    cpKeyRendered.current = key;
    setCpPlotting(true);
    try {
      const res = await plotQpcrCp(params);
      if (seq !== cpSeq.current) return;
      setCpPlot(res);
      if (!res.success) cpKeyRendered.current = null; // let the next change (or Re-render) retry
    } catch (e) {
      if (seq !== cpSeq.current) return;
      setCpPlot({ success: false, stdout: "", stderr: errMsg(e), plots: [], tables: [] });
      cpKeyRendered.current = null;
    } finally {
      if (seq === cpSeq.current) setCpPlotting(false);
    }
  };

  // The Cp graph renders while its tab is open and follows the selection,
  // the Cp limit and the shared style settings.
  useEffect(() => {
    if (canvasTab !== "cp" || !ds.runIds.length || cpKey === cpKeyRendered.current) return;
    const params = cpParams;
    const t = setTimeout(() => { void renderCp(params, cpKey); }, cpPlot ? 500 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cpKey, canvasTab]);

  // Swap the x-axis label default (Gene ↔ Sample) unless the user typed one.
  const changeLayout = (v: "grouped" | "faceted") => {
    setLayout(v);
    setXlabel((cur) => (cur === "Gene" || cur === "Sample" || cur === "") ? (v === "grouped" ? "Gene" : "Sample") : cur);
  };

  const applyPalette = (name: string) => {
    const pal = PALETTES[name];
    const order = analyzedSel?.samples ?? cpSamples;
    setColors((prev) => ({ ...prev, ...Object.fromEntries(order.map((s, i) => [s, pal[i % pal.length]])) }));
  };

  const render = () => { if (analysis && analyzedSel && !stale) void runPlot(analysis, analyzedSel); };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    if (analysis && !stale) render();
    else if (canAnalyze && !analyzing) void runAnalysis();
  };

  // ── rail sections ─────────────────────────────────────────────────────────

  const stepError = (s: Step) =>
    err?.step === s ? <Alert severity="error" onClose={() => setErr(null)} sx={{ mt: 1.5 }}>{err.msg}</Alert> : null;

  const dataSummary = !library ? "Opening the run library…"
    : !runs.length ? "Library is empty — add runs"
      : `${ds.runs.length} of ${runs.length} run${runs.length > 1 ? "s" : ""} · ${ds.wells} wells · ${samples.length} samples`;

  const testName = analysis?.anova_tukey_results.length ? "ANOVA + Tukey"
    : analysis?.ttest_results.length ? "t-test" : "no test";
  const analysisSummary = analysis && analyzedSel
    ? `${analyzedSel.genes.length} gene${analyzedSel.genes.length > 1 ? "s" : ""} × ${analyzedSel.samples.length} samples · ${testName}${stale ? " · changed" : ""}`
    : ds.runs.length ? "Pick genes and samples" : "Tick at least one run";

  // The filter box only exists above 6 runs; ignore a leftover filter below that.
  const filter = runs.length > 6 ? runFilter.trim().toLowerCase() : "";
  const shownRuns = filter ? runs.filter((r) => r.name.toLowerCase().includes(filter)) : runs;

  const dataSection = (
    <RailSection step={1} title="Data" summary={dataSummary} done={ds.runs.length > 0}
      expanded={open.data} onToggle={toggle("data")}>
      <FileDropZone accept=".txt" onFiles={importFiles} title="Add runs to the library"
        hint="Drop *_qpcr.txt + *_platemap.txt pairs — or click to browse" />
      <Button fullWidth size="small" startIcon={<GridOnIcon />} onClick={openManual} sx={{ mt: 0.75 }}>
        Enter a plate manually
      </Button>
      {importing && <LinearProgress sx={{ mt: 1 }} />}
      {importNote && (
        <Alert severity={importNote.tone} onClose={() => setImportNote(null)} sx={{ mt: 1 }}>{importNote.text}</Alert>
      )}

      <Stack direction="row" alignItems="center" sx={{ mt: 2, mb: 0.5 }}>
        <Typography variant="overline" color="text.secondary" sx={{ fontSize: 10.5, letterSpacing: 0.8, lineHeight: 1.6, flexGrow: 1 }}>
          Library{runs.length ? ` · ${runs.length} run${runs.length > 1 ? "s" : ""}` : ""}
        </Typography>
        {runs.length > 1 && (
          <>
            <Button size="small" onClick={() => setAllRuns(true)} sx={{ minWidth: 0, px: 0.75 }}>All</Button>
            <Button size="small" color="inherit" onClick={() => setAllRuns(false)} sx={{ minWidth: 0, px: 0.75, color: "text.secondary" }}>None</Button>
          </>
        )}
      </Stack>
      {runs.length > 6 && (
        <TextField size="small" fullWidth placeholder="Filter runs" value={runFilter}
          onChange={(e) => setRunFilter(e.target.value)} sx={{ mb: 0.75 }} />
      )}
      {library && !runs.length && (
        <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>
          No runs yet. Runs you add are saved here and stay available next time.
        </Typography>
      )}
      {filter && !shownRuns.length && (
        <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>No runs match “{runFilter.trim()}”.</Typography>
      )}
      <Stack spacing={0.25}>
        {shownRuns.map((r) => (
          <Box key={r.id} sx={{ display: "flex", alignItems: "center", gap: 0.5, borderRadius: 1, pr: 0.5, "&:hover": { bgcolor: "action.hover" } }}>
            <Checkbox size="small" checked={includedIds.has(r.id)} onChange={() => toggleRun(r.id)}
              slotProps={{ input: { "aria-label": `Include ${r.name}` } }} sx={{ p: 0.75 }} />
            <Box sx={{ minWidth: 0, flexGrow: 1, cursor: "pointer", py: 0.25 }} onClick={() => toggleRun(r.id)}>
              <Stack direction="row" spacing={0.75} alignItems="center">
                <Typography variant="body2" noWrap>{r.name}</Typography>
                {r.source === "manual" && <Chip size="small" variant="outlined" label="manual" sx={{ height: 17, fontSize: 10 }} />}
              </Stack>
              <Typography variant="caption" color="text.secondary" noWrap component="div">
                {r.n_wells} wells · {r.genes.length} genes · {r.samples.length} samples
              </Typography>
            </Box>
            {confirmDelete === r.id ? (
              <>
                <Button size="small" color="error" onClick={() => removeRun(r.id)} sx={{ minWidth: 0, px: 0.75 }}>Remove</Button>
                <Button size="small" color="inherit" onClick={() => setConfirmDelete(null)} sx={{ minWidth: 0, px: 0.75 }}>Keep</Button>
              </>
            ) : (
              <Tooltip title="Remove from library">
                <IconButton size="small" aria-label={`Remove ${r.name} from the library`} onClick={() => setConfirmDelete(r.id)}>
                  <DeleteOutlineIcon sx={{ fontSize: 17 }} />
                </IconButton>
              </Tooltip>
            )}
          </Box>
        ))}
      </Stack>

      <RailHeading>Cp limit</RailHeading>
      <Stack direction="row" spacing={1} alignItems="center">
        <NumberField size="small" label="Cp limit" value={cpLimit} onCommit={setCpLimit} min={10} max={45} step={0.5} sx={{ width: 96 }} />
        <FormControlLabel sx={{ mr: 0 }}
          control={<Switch size="small" checked={excludeHigh} onChange={(e) => setExcludeHigh(e.target.checked)} />}
          label={<Typography variant="body2">Exclude wells at or above it</Typography>} />
      </Stack>
      <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5 }}>
        Wells at or above the limit (and undetermined wells) count as not detected. The Cp values graph marks it with a dotted line.
      </Typography>
      {libraryPath && (
        <Typography variant="caption" color="text.disabled" component="div" sx={{ mt: 1, wordBreak: "break-all" }}>
          Library file: {libraryPath}
        </Typography>
      )}
      {stepError("data")}
      {!library && err?.step === "data" && (
        <Button size="small" startIcon={<RefreshIcon />} onClick={() => void loadLibrary()} sx={{ mt: 1 }}>Retry</Button>
      )}
    </RailSection>
  );

  const runsOf = (n: number | undefined) => `${n ?? 0}/${ds.runs.length} runs`;
  const geneOption = (props: HTMLAttributes<HTMLLIElement> & { key?: Key }, g: string) => {
    const low = lowCp.get(g);
    return <OptionRow props={props} label={g} note={runsOf(ds.geneRuns.get(g))}
      warn={low ? `≥ Cp ${cpLimit} in ${low.length}` : undefined} />;
  };
  const sampleOption = (props: HTMLAttributes<HTMLLIElement> & { key?: Key }, s: string) =>
    <OptionRow props={props} label={s} note={runsOf(ds.sampleRuns.get(s))} />;
  const lowTargets = targetGenes.filter((g) => lowCp.has(g));
  const refsMissing = refGenes.filter((g) => (ds.geneRuns.get(g) ?? 0) < ds.runs.length);

  const analysisSection = (
    <RailSection step={2} title="Analysis" summary={analysisSummary} done={!!analysis && !stale}
      disabled={!ds.runs.length} expanded={open.analysis} onToggle={toggle("analysis")}>
      {ds.runs.length > 1 && (
        <FormControlLabel sx={{ ml: -0.5, mb: 0.5 }}
          control={<Switch size="small" checked={useCommon} onChange={(e) => setUseCommon(e.target.checked)} />}
          label={<Typography variant="body2">Only genes in every run ({ds.genesCommon.length} of {ds.genesAll.length})</Typography>} />
      )}
      <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 1.25 }}>
        The lists show how many of the {ds.runs.length} ticked runs contain each gene or sample — the Overview tab maps them in full.
      </Typography>
      <Stack spacing={1.5}>
        <Box>
          <Autocomplete multiple size="small" limitTags={4} options={genes} value={refGenes} renderOption={geneOption}
            onChange={(_, v) => { setRefGenes(v); setTargetGenes((t) => t.filter((g) => !v.includes(g))); }}
            renderInput={(p) => <TextField {...p} label="Reference (housekeeping) genes" />} />
          {refsMissing.length > 0 && (
            <Typography variant="caption" color="warning.main" component="div" sx={{ mt: 0.25 }}>
              {refsMissing.join(", ")} {refsMissing.length > 1 ? "aren't" : "isn't"} in every ticked run — samples in runs
              without {refsMissing.length > 1 ? "them" : "it"} are left out, so every run is normalised the same way.
            </Typography>
          )}
        </Box>
        <Box>
          <Autocomplete multiple size="small" limitTags={6} options={genes.filter((g) => !refGenes.includes(g))}
            value={targetGenes} onChange={(_, v) => setTargetGenes(v)} renderOption={geneOption}
            renderInput={(p) => <TextField {...p} label="Target genes" />} />
          <QuickPicks allLabel="All non-reference" onClear={() => setTargetGenes([])}
            onAll={() => setTargetGenes(genes.filter((g) => !refGenes.includes(g)))} />
          {lowTargets.length > 0 && (
            <Typography variant="caption" color="warning.main" component="div">
              {lowTargets.join(", ")} {lowTargets.length > 1 ? "are" : "is"} at or above Cp {cpLimit} in some samples — see Cp values.
            </Typography>
          )}
        </Box>
        <TextField select size="small" label="Control (calibrator) sample" value={control}
          onChange={(e) => { setControl(e.target.value); setExperimental((x) => x.filter((s) => s !== e.target.value)); }}>
          {samples.map((s) => (
            <MenuItem key={s} value={s}>
              <Box sx={{ display: "flex", width: "100%", gap: 1 }}>
                <Box component="span" sx={{ flexGrow: 1 }}>{s}</Box>
                <Typography variant="caption" color="text.secondary">{runsOf(ds.sampleRuns.get(s))}</Typography>
              </Box>
            </MenuItem>
          ))}
        </TextField>
        <Box>
          <Autocomplete multiple size="small" limitTags={6} options={samples.filter((s) => s !== control)}
            value={experimental} onChange={(_, v) => setExperimental(v)} renderOption={sampleOption}
            renderInput={(p) => <TextField {...p} label="Compare against control" helperText="Plotted in this order, after the control" />} />
          <QuickPicks allLabel="All others" onClear={() => setExperimental([])}
            onAll={() => setExperimental(samples.filter((s) => s !== control))} />
        </Box>
      </Stack>

      <RailHeading>Statistics</RailHeading>
      <ToggleButtonGroup fullWidth exclusive size="small" value={method}
        onChange={(_, v) => { if (v) setMethod(v); }}>
        <ToggleButton value="auto">Auto</ToggleButton>
        <ToggleButton value="ttest">t-test</ToggleButton>
        <ToggleButton value="anova">ANOVA</ToggleButton>
      </ToggleButtonGroup>
      <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5 }}>
        {method === "auto" ? "Welch t-test for two groups, ANOVA + Tukey HSD for three or more."
          : method === "ttest" ? "Welch t-test of each sample against the control."
          : "One-way ANOVA with Tukey HSD post-hoc comparisons."}
        {excludeHigh ? ` Wells at or above Cp ${cpLimit} are excluded.` : ""}
      </Typography>

      <Button fullWidth variant="contained" sx={{ mt: 2 }} disabled={!canAnalyze || analyzing} onClick={runAnalysis}
        startIcon={analyzing ? <CircularProgress size={14} color="inherit" /> : undefined}>
        {analysis && !stale ? "Re-run analysis" : "Run ΔΔCt analysis"}
      </Button>
      {!canAnalyze && ds.runs.length > 0 && (
        <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.75 }}>
          Needs {[!refGenes.length && "a reference gene", !targetGenes.length && "a target gene",
            !control && "a control sample", !experimental.length && "a sample to compare"]
            .filter(Boolean).join(", ")}.
        </Typography>
      )}
      {stale && (
        <Typography variant="caption" color="warning.main" component="div" sx={{ mt: 0.75 }}>
          Runs or selections changed since the last run — re-run to update the figure.
        </Typography>
      )}
      {analysisWarnings.length > 0 && (
        <Alert severity="warning" onClose={() => setAnalysisWarnings([])} sx={{ mt: 1.5 }}>
          {analysisWarnings.map((w) => <div key={w}>{w}</div>)}
        </Alert>
      )}
      {stepError("analysis")}
    </RailSection>
  );

  const plotSamples = analyzedSel?.samples ?? cpSamples;
  const figureSection = (
    <RailSection step={3} title="Figure" done={!!plot?.success} disabled={!analysis}
      summary={analysis ? `${layout === "grouped" ? "Single graph" : "Panel per gene"} · ${plotType} · ${theme}` : "Run the analysis first"}
      expanded={open.figure} onToggle={toggle("figure")}>
      <RailHeading first>Layout</RailHeading>
      <ToggleButtonGroup fullWidth exclusive size="small" value={layout}
        onChange={(_, v) => { if (v) changeLayout(v); }}>
        <ToggleButton value="grouped">Single graph</ToggleButton>
        <ToggleButton value="faceted">Panel per gene</ToggleButton>
      </ToggleButtonGroup>
      <ToggleButtonGroup fullWidth exclusive size="small" value={plotType} sx={{ mt: 1 }}
        onChange={(_, v) => { if (v) setPlotType(v); }}>
        <ToggleButton value="bar">Bar</ToggleButton>
        <ToggleButton value="violin">Violin</ToggleButton>
        <ToggleButton value="box">Box</ToggleButton>
        <ToggleButton value="dot">Dot</ToggleButton>
      </ToggleButtonGroup>
      <Tooltip placement="right" title="ΔΔCt normalises each sample to the reference, so a single reference gene sits at ≈ 1 everywhere. Its raw Cp (stability across samples) is on the Cp values tab.">
        <FormControlLabel sx={{ ml: -0.5, mt: 0.5 }}
          control={<Switch size="small" checked={showRefs} onChange={(e) => setShowRefs(e.target.checked)} />}
          label={<Typography variant="body2">Show reference genes</Typography>} />
      </Tooltip>
      <Box sx={{ mt: 1 }}>
        <Grid2>
          <TextField select size="small" label="Theme" value={theme} onChange={(e) => setTheme(e.target.value as typeof theme)}>
            <MenuItem value="prism">Prism</MenuItem>
            <MenuItem value="classic">Classic</MenuItem>
            <MenuItem value="minimal">Minimal</MenuItem>
          </TextField>
          <TextField select size="small" label="Error bars" value={errorType} onChange={(e) => setErrorType(e.target.value as "SD" | "SEM")}>
            <MenuItem value="SD">SD</MenuItem>
            <MenuItem value="SEM">SEM</MenuItem>
          </TextField>
        </Grid2>
      </Box>

      <RailHeading>Data points</RailHeading>
      <FormControlLabel sx={{ ml: -0.5 }}
        control={<Switch size="small" checked={showPoints || plotType === "dot"} disabled={plotType === "dot"}
          onChange={(e) => setShowPoints(e.target.checked)} />}
        label={<Typography variant="body2">Show individual replicates</Typography>} />
      {(showPoints || plotType === "dot") && (
        <LabeledSlider label="Point size" value={pointSize} onChange={setPointSize} min={0.5} max={5} step={0.1} />
      )}
      {(plotType === "bar" || layout === "grouped") && (
        <LabeledSlider label={plotType === "bar" ? "Bar width" : "Group width"} value={barWidth}
          onChange={setBarWidth} min={0.2} max={1} step={0.05} format={(v) => v.toFixed(2)} />
      )}

      <RailHeading>Significance</RailHeading>
      <Grid2>
        <TextField select size="small" label="Threshold (α)" value={sigLevel} onChange={(e) => setSigLevel(Number(e.target.value))}>
          {/* Stars use fixed Prism cut-offs, so α only hides weaker results; above 0.05 it would change nothing. */}
          {[0.05, 0.01, 0.001].map((v) => <MenuItem key={v} value={v}>{v}</MenuItem>)}
        </TextField>
        <FormControlLabel sx={{ ml: 0 }}
          control={<Switch size="small" checked={hideNs} onChange={(e) => setHideNs(e.target.checked)} />}
          label={<Typography variant="body2">Hide ns</Typography>} />
      </Grid2>

      <RailHeading>Text</RailHeading>
      <Stack spacing={1}>
        <TextField size="small" label="Title" value={title} onChange={(e) => setTitle(e.target.value)} fullWidth />
        <Grid2>
          <TextField size="small" label="X axis" value={xlabel} onChange={(e) => setXlabel(e.target.value)} />
          <TextField size="small" label="Y axis" value={ylabel} onChange={(e) => setYlabel(e.target.value)} />
        </Grid2>
      </Stack>
      <LabeledSlider label="Font size" value={fontSize} onChange={setFontSize} min={8} max={28} step={1} format={(v) => `${v} pt`} />

      <RailHeading>Colours &amp; legend</RailHeading>
      <Stack direction="row" spacing={0.75} sx={{ mb: 1 }}>
        {Object.keys(PALETTES).map((name) => (
          <Chip key={name} size="small" variant="outlined" label={name} onClick={() => applyPalette(name)} />
        ))}
      </Stack>
      <Stack spacing={0.75}>
        {plotSamples.map((s) => (
          <Stack key={s} direction="row" spacing={1} alignItems="center">
            <input type="color" value={colors[s] ?? "#888888"} aria-label={`Colour for ${s}`}
              onChange={(e) => setColors((c) => ({ ...c, [s]: e.target.value }))}
              style={{ width: 30, height: 30, padding: 0, border: "1px solid #48484a", borderRadius: 4, background: "none", cursor: "pointer", flexShrink: 0 }} />
            <TextField size="small" fullWidth value={labels[s] ?? s} placeholder={s}
              onChange={(e) => setLabels((l) => ({ ...l, [s]: e.target.value }))}
              slotProps={{ htmlInput: { "aria-label": `Legend label for ${s}` } }} />
          </Stack>
        ))}
      </Stack>

      <RailHeading>Export</RailHeading>
      <Stack spacing={1}>
        <Grid2>
          <NumberField size="small" label="Width (px)" value={plotWidth} onCommit={setPlotWidth} min={300} max={8000} step={100} />
          <NumberField size="small" label="Height (px)" value={plotHeight} onCommit={setPlotHeight} min={300} max={8000} step={100} />
        </Grid2>
        <Grid2>
          <TextField select size="small" label="DPI" value={dpi} onChange={(e) => setDpi(Number(e.target.value))}>
            {[100, 150, 300, 600].map((d) => <MenuItem key={d} value={d}>{d}</MenuItem>)}
          </TextField>
          <ToggleButtonGroup fullWidth exclusive size="small" value={exportFormat}
            onChange={(_, v) => { if (v) setExportFormat(v); }}>
            <ToggleButton value="png">PNG</ToggleButton>
            <ToggleButton value="tiff">TIFF</ToggleButton>
          </ToggleButtonGroup>
        </Grid2>
        <FormControlLabel sx={{ ml: -0.5 }}
          control={<Switch size="small" checked={transparent} onChange={(e) => setTransparent(e.target.checked)} />}
          label={<Typography variant="body2">Transparent background</Typography>} />
      </Stack>
    </RailSection>
  );

  const railFooter = analysis ? (
    <Stack spacing={1}>
      {stepError("figure")}
      <Stack direction="row" alignItems="center" spacing={1}>
        <Tooltip title="Re-render automatically when a figure setting changes">
          <FormControlLabel sx={{ ml: -0.5, mr: 0 }}
            control={<Switch size="small" checked={liveUpdate} onChange={(e) => setLiveUpdate(e.target.checked)} />}
            label={<Typography variant="body2">Live</Typography>} />
        </Tooltip>
        <Box sx={{ flexGrow: 1 }} />
        <Tooltip title={`${MOD_KEY} + Enter`}>
          <span>
            <Button variant="contained" onClick={render} disabled={plotting || stale}
              startIcon={plotting ? <CircularProgress size={14} color="inherit" /> : <RefreshIcon />}>
              {plot ? "Re-render" : "Render figure"}
            </Button>
          </span>
        </Tooltip>
      </Stack>
    </Stack>
  ) : undefined;

  // ── canvas ────────────────────────────────────────────────────────────────

  const noData = !ds.runs.length;
  const lowShown = cpGenes.filter((g) => lowCp.has(g));

  const figureBody = !analysis ? (
    <CanvasEmpty active={noData ? 0 : 1} />
  ) : !plot ? (
    plotting ? <Rendering what="figure" /> : (
      <CanvasEmpty active={2} action={
        <Button variant="contained" onClick={render} disabled={stale} startIcon={<RefreshIcon />}>Render figure</Button>
      } />
    )
  ) : (
    <FigureView result={plot} busy={plotting} baseName="qpcr_plot" fitHeight="calc(100vh - 140px)" />
  );

  const cpBody = (
    <Stack spacing={1.5} sx={{ flexGrow: 1, minHeight: 0 }}>
      <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
        <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1, minWidth: 260 }}>
          {targetGenes.length ? "Reference and target genes" : "All genes"}, {experimental.length ? "selected samples" : "all samples"},{" "}
          {ds.runs.length} run{ds.runs.length > 1 ? "s" : ""}. Each dot is a well and each bar the mean; the dotted line is the Cp limit ({cpLimit}).
        </Typography>
        <FormControlLabel sx={{ mr: 0 }}
          control={<Switch size="small" checked={excludeHigh} onChange={(e) => setExcludeHigh(e.target.checked)} />}
          label={<Typography variant="body2">Exclude wells ≥ Cp {cpLimit} from the analysis</Typography>} />
        <Button size="small" startIcon={<RefreshIcon />} disabled={cpPlotting} onClick={() => void renderCp(cpParams, cpKey)}>
          Re-render
        </Button>
      </Stack>
      {lowShown.length > 0 && (
        <Alert severity="warning" sx={{ alignItems: "center" }}>
          <Typography variant="body2" sx={{ mb: 0.75 }}>
            Not detected (at or above Cp {cpLimit} in half or more of the wells) — remove a target with its ×:
          </Typography>
          <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap">
            {lowShown.map((g) => (
              <Chip key={g} size="small" variant="outlined" color="warning"
                label={`${g} · ${lowCp.get(g)!.join(", ")}`}
                onDelete={targetGenes.includes(g) ? () => setTargetGenes((t) => t.filter((x) => x !== g)) : undefined} />
            ))}
          </Stack>
        </Alert>
      )}
      {cpPlot ? <FigureView result={cpPlot} busy={cpPlotting} baseName="qpcr_cp" fitHeight="calc(100vh - 230px)" />
        : <Rendering what="Cp graph" />}
    </Stack>
  );

  const resultsBody = analysis ? (
    <Stack spacing={3}>
      <RecordTable rows={analysis.summary} title="Fold change (mean per gene × sample)" downloadName="qpcr_summary.csv" />
      {analysis.ttest_results.length > 0 && (
        <RecordTable rows={analysis.ttest_results} title="Welch t-test vs control" downloadName="qpcr_ttest.csv" />
      )}
      {analysis.anova_tukey_results.length > 0 && (
        <RecordTable rows={analysis.anova_tukey_results} title="ANOVA + Tukey HSD" downloadName="qpcr_anova_tukey.csv" />
      )}
      <RecordTable rows={analysis.analysis_data} title="Per-replicate ΔΔCt" downloadName="qpcr_replicates.csv" />
    </Stack>
  ) : null;

  const body = canvasTab === "figure" ? figureBody
    : noData ? <CanvasEmpty active={0} />
      : canvasTab === "overview" ? <QpcrOverview ds={ds} refGenes={refGenes} targetGenes={targetGenes} cpLimit={cpLimit} />
        : canvasTab === "cp" ? cpBody : resultsBody;

  const tabSx = { minHeight: 44 };
  return (
    <>
      <Workspace rail={<>{dataSection}{analysisSection}{figureSection}</>} railFooter={railFooter} onKeyDown={onKeyDown}>
        <Box sx={{ display: "flex", alignItems: "center", px: 2, borderBottom: 1, borderColor: "divider", flexShrink: 0, minHeight: 44 }}>
          <Tabs value={canvasTab} onChange={(_, v) => setCanvasTab(v)} variant="scrollable" scrollButtons={false} sx={tabSx}>
            <Tab value="overview" label="Overview" disabled={noData} icon={<GridViewIcon sx={{ fontSize: 18 }} />} iconPosition="start" sx={tabSx} />
            <Tab value="cp" label="Cp values" disabled={noData} icon={<ScatterPlotIcon sx={{ fontSize: 18 }} />} iconPosition="start" sx={tabSx} />
            <Tab value="figure" label="Fold change" icon={<InsertChartOutlinedIcon sx={{ fontSize: 18 }} />} iconPosition="start" sx={tabSx} />
            <Tab value="results" label="Results" disabled={!analysis} icon={<TableChartIcon sx={{ fontSize: 18 }} />} iconPosition="start" sx={tabSx} />
          </Tabs>
          <Box sx={{ flexGrow: 1 }} />
          {(canvasTab === "figure" ? plotting : canvasTab === "cp" && cpPlotting) ? (
            <Stack direction="row" spacing={1} alignItems="center">
              <CircularProgress size={12} />
              <Typography variant="caption" color="text.secondary">Rendering…</Typography>
            </Stack>
          ) : (canvasTab === "figure" ? plot?.success : canvasTab === "cp" && cpPlot?.success) ? (
            <Typography variant="caption" color="text.secondary" noWrap>
              {plotWidth} × {plotHeight} px · {dpi} dpi · {exportFormat.toUpperCase()}
            </Typography>
          ) : null}
        </Box>
        <Box sx={{ p: 2, flexGrow: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>{body}</Box>
      </Workspace>

      <Dialog open={manualOpen} onClose={() => setManualOpen(false)} fullWidth maxWidth="xl">
        <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 2, pr: 1 }}>
          Plate editor
          <TextField size="small" label="Run name" value={manualName} onChange={(e) => setManualName(e.target.value)}
            sx={{ width: 280 }} helperText={runs.some((r) => r.name === manualName.trim()) ? "Saving will replace the run with this name" : " "} />
          <Box sx={{ flexGrow: 1 }} />
          <IconButton aria-label="Close" onClick={() => setManualOpen(false)}><CloseIcon /></IconButton>
        </DialogTitle>
        <DialogContent dividers>
          {manualErr && <Alert severity="error" sx={{ mb: 1.5 }} onClose={() => setManualErr(null)}>{manualErr}</Alert>}
          <QpcrManualEntry onLoad={saveManual} busy={savingManual} />
        </DialogContent>
      </Dialog>
    </>
  );
}
