import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  Alert,
  Autocomplete,
  Box,
  Button,
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
import GridOnIcon from "@mui/icons-material/GridOn";
import InsertChartOutlinedIcon from "@mui/icons-material/InsertChartOutlined";
import TableChartIcon from "@mui/icons-material/TableChart";
import RefreshIcon from "@mui/icons-material/Refresh";
import {
  analyzeQpcr,
  plotQpcr,
  uploadQpcr,
  type QpcrAnalyzeResult,
  type QpcrUploadResult,
} from "../../api/client";
import type { RunRResponse } from "../../api/types";
import { RecordTable } from "../shared/RecordTable";
import { PlotResult } from "../shared/PlotResult";
import { Workspace } from "../shared/Workspace";
import { RailHeading, RailSection } from "../shared/RailSection";
import { FileDropZone } from "../shared/FileDropZone";
import { NumberField } from "../shared/NumberField";
import { QpcrManualEntry } from "./QpcrManualEntry";

const PALETTES: Record<string, string[]> = {
  Default: ["#5a7fa8", "#63a66a", "#c1666b", "#d4a05a", "#8a6fae", "#4aa3a3", "#b07aa1", "#9c9c4a"],
  "Colour-blind": ["#0072B2", "#E69F00", "#009E73", "#CC79A7", "#56B4E9", "#D55E00", "#F0E442", "#000000"],
  Greyscale: ["#1f1f1f", "#5c5c5c", "#8f8f8f", "#c2c2c2", "#3d3d3d", "#737373", "#a8a8a8", "#e0e0e0"],
};

/** Common qPCR reference genes — pre-selected as the reference when present. */
const HOUSEKEEPING = /^(GAPDH|ACTB|B2M|HPRT1?|RPLP0|TBP|PPIA|GUSB|YWHAZ|UBC|HMBS|SDHA|PGK1|RPL13A|18S|RN18S1?)$/i;

const MOD_KEY = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform) ? "⌘" : "Ctrl";

type Step = "data" | "analysis" | "figure";
type StepError = { step: Step; msg: string } | null;
type Selection = { genes: string[]; samples: string[]; key: string };
interface FilePair { stem: string; qpcr?: File; platemap?: File }

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Group files into LightCycler pairs by stem (mirrors the sidecar's _stem). */
function pairFiles(files: File[]): { pairs: FilePair[]; ignored: File[] } {
  const byStem = new Map<string, FilePair>();
  const ignored: File[] = [];
  for (const f of files) {
    const kind = f.name.endsWith("_qpcr.txt") ? "qpcr" : f.name.endsWith("_platemap.txt") ? "platemap" : null;
    if (!kind) { ignored.push(f); continue; }
    const stem = f.name.slice(0, f.name.length - (kind === "qpcr" ? 9 : 13));
    const p = byStem.get(stem) ?? { stem };
    p[kind] = f;
    byStem.set(stem, p);
  }
  return { pairs: [...byStem.values()].sort((a, b) => a.stem.localeCompare(b.stem)), ignored };
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

/** Guidance shown on the canvas before there is a figure. */
function CanvasEmpty({ active, action }: { active: number; action?: ReactNode }) {
  const steps = [
    "Load data — drop LightCycler *_qpcr.txt + *_platemap.txt pairs, or type Cp values on a plate.",
    "Choose reference and target genes, the control and the samples to compare, then run ΔΔCt.",
    "Style the figure on the left — it re-renders live — and export it as PNG or TIFF.",
  ];
  return (
    <Box sx={{ flexGrow: 1, display: "grid", placeItems: "center", py: 6 }}>
      <Box sx={{ maxWidth: 460 }}>
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

export function QpcrView() {
  // ── data ──────────────────────────────────────────────────────────────────
  const [entryMode, setEntryMode] = useState<"files" | "manual">("files");
  const [files, setFiles] = useState<File[]>([]);
  const [dropHighCp, setDropHighCp] = useState(false);
  const [upload, setUpload] = useState<QpcrUploadResult | null>(null);
  const [manualOpen, setManualOpen] = useState(false);

  // ── analysis ──────────────────────────────────────────────────────────────
  const [useCommon, setUseCommon] = useState(true);
  const [refGenes, setRefGenes] = useState<string[]>([]);
  const [targetGenes, setTargetGenes] = useState<string[]>([]);
  const [control, setControl] = useState<string>("");
  const [experimental, setExperimental] = useState<string[]>([]);
  const [method, setMethod] = useState<"auto" | "ttest" | "anova">("auto");
  const [analysis, setAnalysis] = useState<QpcrAnalyzeResult | null>(null);
  const [analyzedSel, setAnalyzedSel] = useState<Selection | null>(null);

  // ── figure ────────────────────────────────────────────────────────────────
  const [layout, setLayout] = useState<"grouped" | "faceted">("grouped");
  const [plotType, setPlotType] = useState<"bar" | "violin" | "box" | "dot">("bar");
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

  // ── ui ────────────────────────────────────────────────────────────────────
  const [open, setOpen] = useState<Record<Step, boolean>>({ data: true, analysis: false, figure: false });
  const [canvasTab, setCanvasTab] = useState<"figure" | "results">("figure");
  const [uploading, setUploading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [plotting, setPlotting] = useState(false);
  const [err, setErr] = useState<StepError>(null);

  const uploadSeq = useRef(0);
  const plotSeq = useRef(0);
  /** Params key of the last requested render; null until the first one. */
  const figKey = useRef<string | null>(null);

  const genes = upload ? (useCommon ? upload.genes_common : upload.genes_all) : [];
  const samples = upload?.samples ?? [];
  const sampleOrder = control ? [control, ...experimental] : experimental;
  const selKey = JSON.stringify([refGenes, targetGenes, sampleOrder, method, useCommon]);
  const stale = !!analysis && analyzedSel?.key !== selKey;
  const canAnalyze = !!upload && refGenes.length > 0 && targetGenes.length > 0 && !!control && experimental.length > 0;
  const isManual = upload?.pairs.length === 1 && upload.pairs[0].name === "manual";
  const toggle = (s: Step) => (o: boolean) => setOpen((p) => ({ ...p, [s]: o }));

  const buildParams = (sel: Selection) => ({
    gene_order: sel.genes, sample_order: sel.samples, colors, labels,
    error_type: errorType, layout, plot_type: plotType, show_points: showPoints,
    point_size: pointSize, bar_width: barWidth, theme, significance_level: sigLevel,
    hide_ns: hideNs, title, xlabel, ylabel, font_size: fontSize,
    width: plotWidth, height: plotHeight, dpi, export_format: exportFormat, transparent,
  });
  const paramsKey = analyzedSel ? JSON.stringify(buildParams(analyzedSel)) : "";

  // ── actions ───────────────────────────────────────────────────────────────

  /** Adopt a freshly loaded dataset: keep still-valid choices and colours,
   *  default the reference gene, and move the user on to the analysis step. */
  const applyLoaded = (res: QpcrUploadResult) => {
    setUpload(res);
    setAnalysis(null);
    setAnalyzedSel(null);
    setPlot(null);
    figKey.current = null;
    const geneSet = new Set(res.genes_all);
    const sampleSet = new Set(res.samples);
    setRefGenes((prev) => {
      const kept = prev.filter((g) => geneSet.has(g));
      return kept.length ? kept : res.genes_all.filter((g) => HOUSEKEEPING.test(g));
    });
    setTargetGenes((prev) => prev.filter((g) => geneSet.has(g)));
    setControl((prev) => (sampleSet.has(prev) ? prev : ""));
    setExperimental((prev) => prev.filter((s) => sampleSet.has(s)));
    setColors((prev) => Object.fromEntries(res.samples.map((s, i) => [s, prev[s] ?? PALETTES.Default[i % 8]])));
    setLabels((prev) => Object.fromEntries(res.samples.map((s) => [s, prev[s] ?? s])));
    // Open the next step but leave Data open, so further runs can still be dropped.
    if (res.pairs.length) setOpen((p) => ({ ...p, analysis: true, figure: false }));
  };

  const doUpload = async (fs: File[], drop: boolean) => {
    const { pairs } = pairFiles(fs);
    if (!pairs.some((p) => p.qpcr && p.platemap)) return;
    const send = pairs.flatMap((p) => [p.qpcr, p.platemap]).filter((f): f is File => !!f);
    const seq = ++uploadSeq.current;
    setUploading(true);
    setErr(null);
    try {
      const res = await uploadQpcr(send, drop);
      if (seq === uploadSeq.current) applyLoaded(res);
    } catch (e) {
      if (seq === uploadSeq.current) setErr({ step: "data", msg: errMsg(e) });
    } finally {
      if (seq === uploadSeq.current) setUploading(false);
    }
  };

  /** Add dropped/picked files to the set (same name replaces) and re-upload. */
  const addFiles = (incoming: File[]) => {
    const byName = new Map(files.map((f) => [f.name, f]));
    incoming.forEach((f) => byName.set(f.name, f));
    const next = [...byName.values()];
    setFiles(next);
    void doUpload(next, dropHighCp);
  };

  const removePair = (stem: string) => {
    const next = files.filter((f) => f.name !== `${stem}_qpcr.txt` && f.name !== `${stem}_platemap.txt`);
    setFiles(next);
    if (pairFiles(next).pairs.some((p) => p.qpcr && p.platemap)) void doUpload(next, dropHighCp);
    else { setUpload(null); setAnalysis(null); setAnalyzedSel(null); setPlot(null); figKey.current = null; }
  };

  const onManualLoad = (records: { Sample: string; Gene: string; Cp: number }[]) => {
    if (!records.length) return;
    const g = Array.from(new Set(records.map((r) => r.Gene))).sort();
    const s = Array.from(new Set(records.map((r) => r.Sample))).sort();
    applyLoaded({
      pairs: [{ name: "manual", records: records as unknown as Record<string, unknown>[], n_rows: records.length }],
      genes_common: g, genes_all: g, samples: s, errors: [],
    });
    setManualOpen(false);
  };

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
    if (!upload || !canAnalyze) return;
    setAnalyzing(true);
    setErr(null);
    try {
      const res = await analyzeQpcr({
        pairs: upload.pairs, reference_genes: refGenes, target_genes: targetGenes,
        control, experimental, method,
      });
      if (res.error) { setErr({ step: "analysis", msg: res.error }); return; }
      const sel: Selection = { genes: targetGenes, samples: sampleOrder, key: selKey };
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

  // Swap the x-axis label default (Gene ↔ Sample) unless the user typed one.
  const changeLayout = (v: "grouped" | "faceted") => {
    setLayout(v);
    setXlabel((cur) => (cur === "Gene" || cur === "Sample" || cur === "") ? (v === "grouped" ? "Gene" : "Sample") : cur);
  };

  const applyPalette = (name: string) => {
    const pal = PALETTES[name];
    const order = analyzedSel?.samples ?? samples;
    setColors((prev) => ({ ...prev, ...Object.fromEntries(order.map((s, i) => [s, pal[i % pal.length]])) }));
  };

  const render = () => { if (analysis && analyzedSel && !stale) void runPlot(analysis, analyzedSel); };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    if (analysis && !stale) render();
    else if (canAnalyze) void runAnalysis();
  };

  // ── rail sections ─────────────────────────────────────────────────────────

  const { pairs: filePairs, ignored } = pairFiles(files);
  const loadedRows = new Map((upload?.pairs ?? []).map((p) => [p.name, p.n_rows]));
  const totalWells = (upload?.pairs ?? []).reduce((n, p) => n + p.n_rows, 0);
  const stepError = (s: Step) =>
    err?.step === s ? <Alert severity="error" onClose={() => setErr(null)} sx={{ mt: 1.5 }}>{err.msg}</Alert> : null;

  const dataSummary = upload?.pairs.length
    ? isManual
      ? `Manual plate · ${totalWells} wells · ${samples.length} samples`
      : `${upload.pairs.length} run${upload.pairs.length > 1 ? "s" : ""} · ${totalWells} wells · ${samples.length} samples`
    : "Drop LightCycler exports or enter Cp values";

  const testName = analysis?.anova_tukey_results.length ? "ANOVA + Tukey"
    : analysis?.ttest_results.length ? "t-test" : "no test";
  const analysisSummary = analysis && analyzedSel
    ? `${analyzedSel.genes.length} gene${analyzedSel.genes.length > 1 ? "s" : ""} × ${analyzedSel.samples.length} samples · ${testName}${stale ? " · changed" : ""}`
    : upload ? "Pick genes and samples" : "Load data first";

  const dataSection = (
    <RailSection step={1} title="Data" summary={dataSummary} done={!!upload?.pairs.length}
      expanded={open.data} onToggle={toggle("data")}>
      <ToggleButtonGroup fullWidth exclusive size="small" value={entryMode}
        onChange={(_, v) => { if (v) setEntryMode(v); }} sx={{ mb: 1.5 }}>
        <ToggleButton value="files">Files</ToggleButton>
        <ToggleButton value="manual">Manual entry</ToggleButton>
      </ToggleButtonGroup>

      {entryMode === "files" ? (
        <>
          <FileDropZone accept=".txt" onFiles={addFiles} title="Drop qPCR + plate-map files"
            hint="*_qpcr.txt with its *_platemap.txt — or click to browse" />
          {filePairs.length > 0 && (
            <Stack spacing={0.5} sx={{ mt: 1.5 }}>
              {filePairs.map((p) => {
                const rows = loadedRows.get(p.stem);
                return (
                  <Stack key={p.stem} direction="row" spacing={0.75} alignItems="center">
                    <Tooltip title={p.stem}>
                      <Typography variant="body2" noWrap sx={{ flexGrow: 1, minWidth: 0 }}>{p.stem}</Typography>
                    </Tooltip>
                    {p.qpcr && p.platemap ? (
                      <Chip size="small" color="success" variant="outlined"
                        label={rows !== undefined ? `${rows} wells` : "paired"} />
                    ) : (
                      <Chip size="small" color="warning" variant="outlined"
                        label={p.qpcr ? "needs plate map" : "needs qPCR file"} />
                    )}
                    <IconButton size="small" aria-label={`Remove ${p.stem}`} onClick={() => removePair(p.stem)}>
                      <CloseIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                  </Stack>
                );
              })}
              {ignored.length > 0 && (
                <Typography variant="caption" color="text.secondary">
                  Ignored {ignored.map((f) => f.name).join(", ")} — names must end in _qpcr.txt or _platemap.txt.
                </Typography>
              )}
            </Stack>
          )}
          <FormControlLabel sx={{ mt: 1, ml: -0.5 }}
            control={<Switch size="small" checked={dropHighCp} onChange={(e) => {
              setDropHighCp(e.target.checked);
              void doUpload(files, e.target.checked);
            }} />}
            label={<Typography variant="body2">Exclude wells with Cp ≥ 35</Typography>} />
          {uploading && <LinearProgress sx={{ mt: 1 }} />}
        </>
      ) : (
        <>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            Type the gene, sample and Cp for each well on a plate grid.
          </Typography>
          <Button fullWidth variant="outlined" startIcon={<GridOnIcon />} onClick={() => setManualOpen(true)}>
            {isManual ? "Edit plate" : "Open plate editor"}
          </Button>
        </>
      )}
      {upload?.errors?.length ? <Alert severity="warning" sx={{ mt: 1.5 }}>{upload.errors.join("; ")}</Alert> : null}
      {stepError("data")}
    </RailSection>
  );

  const analysisSection = (
    <RailSection step={2} title="Analysis" summary={analysisSummary} done={!!analysis && !stale}
      disabled={!upload?.pairs.length} expanded={open.analysis} onToggle={toggle("analysis")}>
      {upload && upload.pairs.length > 1 && (
        <FormControlLabel sx={{ ml: -0.5, mb: 1 }}
          control={<Switch size="small" checked={useCommon} onChange={(e) => setUseCommon(e.target.checked)} />}
          label={<Typography variant="body2">Only genes in every run ({upload.genes_common.length} of {upload.genes_all.length})</Typography>} />
      )}
      <Stack spacing={1.5}>
        <Autocomplete multiple size="small" limitTags={4} options={genes} value={refGenes}
          onChange={(_, v) => { setRefGenes(v); setTargetGenes((t) => t.filter((g) => !v.includes(g))); }}
          renderInput={(p) => <TextField {...p} label="Reference (housekeeping) genes" />} />
        <Box>
          <Autocomplete multiple size="small" limitTags={6} options={genes.filter((g) => !refGenes.includes(g))}
            value={targetGenes} onChange={(_, v) => setTargetGenes(v)}
            renderInput={(p) => <TextField {...p} label="Target genes" />} />
          <QuickPicks allLabel="All non-reference" onClear={() => setTargetGenes([])}
            onAll={() => setTargetGenes(genes.filter((g) => !refGenes.includes(g)))} />
        </Box>
        <TextField select size="small" label="Control (calibrator) sample" value={control}
          onChange={(e) => { setControl(e.target.value); setExperimental((x) => x.filter((s) => s !== e.target.value)); }}>
          {samples.map((s) => <MenuItem key={s} value={s}>{s}</MenuItem>)}
        </TextField>
        <Box>
          <Autocomplete multiple size="small" limitTags={6} options={samples.filter((s) => s !== control)}
            value={experimental} onChange={(_, v) => setExperimental(v)}
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
      </Typography>

      <Button fullWidth variant="contained" sx={{ mt: 2 }} disabled={!canAnalyze || analyzing} onClick={runAnalysis}
        startIcon={analyzing ? <CircularProgress size={14} color="inherit" /> : undefined}>
        {analysis && !stale ? "Re-run analysis" : "Run ΔΔCt analysis"}
      </Button>
      {!canAnalyze && (
        <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.75 }}>
          Needs {[!refGenes.length && "a reference gene", !targetGenes.length && "a target gene",
            !control && "a control sample", !experimental.length && "a sample to compare"]
            .filter(Boolean).join(", ")}.
        </Typography>
      )}
      {stale && (
        <Typography variant="caption" color="warning.main" component="div" sx={{ mt: 0.75 }}>
          Selections changed since the last run — re-run to update the figure.
        </Typography>
      )}
      {stepError("analysis")}
    </RailSection>
  );

  const plotSamples = analyzedSel?.samples ?? [];
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
      <Box sx={{ mt: 1.5 }}>
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
          {[0.1, 0.05, 0.01, 0.001].map((v) => <MenuItem key={v} value={v}>{v}</MenuItem>)}
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

  const figureBody = !analysis ? (
    <CanvasEmpty active={upload?.pairs.length ? 1 : 0} />
  ) : !plot ? (
    plotting ? (
      <Box sx={{ flexGrow: 1, display: "grid", placeItems: "center" }}>
        <Stack alignItems="center" spacing={1.5}>
          <CircularProgress size={28} />
          <Typography variant="body2" color="text.secondary">Rendering the figure in R…</Typography>
        </Stack>
      </Box>
    ) : (
      <CanvasEmpty active={2} action={
        <Button variant="contained" onClick={render} disabled={stale} startIcon={<RefreshIcon />}>Render figure</Button>
      } />
    )
  ) : (
    <Box sx={{ position: "relative", alignSelf: "flex-start", maxWidth: "100%" }}>
      <PlotResult result={plot} baseName="qpcr_plot" fitHeight="calc(100vh - 250px)" />
      {plotting && (
        <Box sx={{ position: "absolute", inset: 0, bgcolor: "rgba(28,28,30,0.35)", display: "grid", placeItems: "center", borderRadius: 1 }}>
          <CircularProgress size={28} />
        </Box>
      )}
    </Box>
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

  return (
    <>
      <Workspace rail={<>{dataSection}{analysisSection}{figureSection}</>} railFooter={railFooter} onKeyDown={onKeyDown}>
        <Box sx={{ display: "flex", alignItems: "center", px: 2, borderBottom: 1, borderColor: "divider", flexShrink: 0, minHeight: 44 }}>
          <Tabs value={canvasTab} onChange={(_, v) => setCanvasTab(v)} sx={{ minHeight: 44 }}>
            <Tab value="figure" label="Figure" icon={<InsertChartOutlinedIcon sx={{ fontSize: 18 }} />} iconPosition="start" sx={{ minHeight: 44 }} />
            <Tab value="results" label="Results" disabled={!analysis} icon={<TableChartIcon sx={{ fontSize: 18 }} />} iconPosition="start" sx={{ minHeight: 44 }} />
          </Tabs>
          <Box sx={{ flexGrow: 1 }} />
          {plotting ? (
            <Stack direction="row" spacing={1} alignItems="center">
              <CircularProgress size={12} />
              <Typography variant="caption" color="text.secondary">Rendering…</Typography>
            </Stack>
          ) : plot?.success ? (
            <Typography variant="caption" color="text.secondary">
              {plotWidth} × {plotHeight} px · {dpi} dpi · {exportFormat.toUpperCase()}
            </Typography>
          ) : null}
        </Box>
        <Box sx={{ p: 2, flexGrow: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
          {canvasTab === "figure" ? figureBody : resultsBody}
        </Box>
      </Workspace>

      <Dialog open={manualOpen} onClose={() => setManualOpen(false)} fullWidth maxWidth="xl">
        <DialogTitle sx={{ display: "flex", alignItems: "center", pr: 1 }}>
          Plate editor
          <Box sx={{ flexGrow: 1 }} />
          <IconButton aria-label="Close" onClick={() => setManualOpen(false)}><CloseIcon /></IconButton>
        </DialogTitle>
        <DialogContent dividers>
          <QpcrManualEntry onLoad={onManualLoad} />
        </DialogContent>
      </Dialog>
    </>
  );
}
