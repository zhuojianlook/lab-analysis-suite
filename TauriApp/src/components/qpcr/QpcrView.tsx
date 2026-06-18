import { useState } from "react";
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Divider,
  FormControlLabel,
  MenuItem,
  Paper,
  Radio,
  RadioGroup,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import UploadFileIcon from "@mui/icons-material/UploadFile";
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
import { QpcrManualEntry } from "./QpcrManualEntry";

const PALETTE = ["#5a7fa8", "#63a66a", "#c1666b", "#d4a05a", "#8a6fae", "#4aa3a3", "#b07aa1", "#9c9c4a"];

export function QpcrView() {
  const [files, setFiles] = useState<File[]>([]);
  const [dropHighCp, setDropHighCp] = useState(false);
  const [upload, setUpload] = useState<QpcrUploadResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [entryMode, setEntryMode] = useState<"files" | "manual">("files");

  const [useCommon, setUseCommon] = useState(true);
  const [refGenes, setRefGenes] = useState<string[]>([]);
  const [targetGenes, setTargetGenes] = useState<string[]>([]);
  const [control, setControl] = useState<string>("");
  const [experimental, setExperimental] = useState<string[]>([]);
  const [method, setMethod] = useState<"auto" | "ttest" | "anova">("auto");
  const [analysis, setAnalysis] = useState<QpcrAnalyzeResult | null>(null);

  const [errorType, setErrorType] = useState<"SD" | "SEM">("SD");
  const [layout, setLayout] = useState<"grouped" | "faceted">("grouped");
  const [title, setTitle] = useState("Fold change per gene");
  const [xlabel, setXlabel] = useState("Gene");
  const [ylabel, setYlabel] = useState("Fold change");
  const [fontSize, setFontSize] = useState(14);
  const [dpi, setDpi] = useState(150);
  const [plotWidth, setPlotWidth] = useState(1200);
  const [plotHeight, setPlotHeight] = useState(800);
  const [exportFormat, setExportFormat] = useState<"png" | "tiff">("png");
  const [transparent, setTransparent] = useState(false);
  const [plotType, setPlotType] = useState<"bar" | "violin" | "box" | "dot">("bar");
  const [showPoints, setShowPoints] = useState(false);
  const [pointSize, setPointSize] = useState(1.8);
  const [barWidth, setBarWidth] = useState(0.7);
  const [theme, setTheme] = useState<"prism" | "classic" | "minimal">("prism");
  const [sigLevel, setSigLevel] = useState(0.05);
  const [hideNs, setHideNs] = useState(true);
  const [colors, setColors] = useState<Record<string, string>>({});
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [plot, setPlot] = useState<RunRResponse | null>(null);

  const genesForSelection = upload ? (useCommon ? upload.genes_common : upload.genes_all) : [];
  const sampleOrder = control ? [control, ...experimental] : experimental;

  const doUpload = async () => {
    if (!files.length) return;
    setBusy("upload");
    setErr(null);
    try {
      const res = await uploadQpcr(files, dropHighCp);
      setUpload(res);
      setAnalysis(null);
      setPlot(null);
      const c: Record<string, string> = {};
      const l: Record<string, string> = {};
      res.samples.forEach((s, i) => {
        c[s] = PALETTE[i % PALETTE.length];
        l[s] = s;
      });
      setColors(c);
      setLabels(l);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const doAnalyze = async () => {
    if (!upload) return;
    setBusy("analyze");
    setErr(null);
    try {
      const res = await analyzeQpcr({
        pairs: upload.pairs,
        reference_genes: refGenes,
        target_genes: targetGenes,
        control,
        experimental,
        method,
      });
      if (res.error) setErr(res.error);
      setAnalysis(res);
      setPlot(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const doPlot = async () => {
    if (!analysis?.summary?.length) return;
    setBusy("plot");
    setErr(null);
    try {
      const res = await plotQpcr({
        summary: analysis.summary,
        points: (analysis.analysis_data ?? []).map((r) => ({ Gene: r.Gene, Sample: r.Sample, value: r.Fold_Change })),
        ttest_results: analysis.ttest_results,
        anova_tukey_results: analysis.anova_tukey_results,
        gene_order: targetGenes,
        sample_order: sampleOrder,
        colors,
        labels,
        error_type: errorType,
        layout,
        plot_type: plotType,
        show_points: showPoints,
        point_size: pointSize,
        bar_width: barWidth,
        theme,
        significance_level: sigLevel,
        hide_ns: hideNs,
        title,
        xlabel,
        ylabel,
        font_size: fontSize,
        width: plotWidth,
        height: plotHeight,
        dpi,
        export_format: exportFormat,
        transparent,
      });
      setPlot(res);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const onManualLoad = (records: { Sample: string; Gene: string; Cp: number }[]) => {
    setErr(null);
    if (!records.length) { setErr("No complete wells (each needs Gene + Sample + Cp)."); return; }
    const genes = Array.from(new Set(records.map((r) => r.Gene))).sort();
    const samples = Array.from(new Set(records.map((r) => r.Sample))).sort();
    setUpload({
      pairs: [{ name: "manual", records: records as unknown as Record<string, unknown>[], n_rows: records.length }],
      genes_common: genes, genes_all: genes, samples, errors: [],
    });
    setAnalysis(null);
    setPlot(null);
    const c: Record<string, string> = {};
    const l: Record<string, string> = {};
    samples.forEach((s, i) => { c[s] = PALETTE[i % PALETTE.length]; l[s] = s; });
    setColors(c);
    setLabels(l);
  };

  // Switch layout, swapping the x-axis label default (Gene ↔ Sample) only if
  // the user hasn't typed a custom one.
  const changeLayout = (v: "grouped" | "faceted") => {
    setLayout(v);
    setXlabel((cur) => (cur === "Gene" || cur === "Sample" || cur === "") ? (v === "grouped" ? "Gene" : "Sample") : cur);
  };

  const canAnalyze = upload && refGenes.length && targetGenes.length && control;

  return (
    <Box sx={{ p: 2, display: "flex", flexDirection: "column", gap: 2 }}>
      {err && <Alert severity="error" onClose={() => setErr(null)}>{err}</Alert>}

      {/* 1. Data input — upload files or enter manually */}
      <ToggleButtonGroup
        size="small"
        exclusive
        value={entryMode}
        onChange={(_, v) => { if (v) setEntryMode(v); }}
        sx={{ alignSelf: "flex-start" }}
      >
        <ToggleButton value="files" sx={{ textTransform: "none", px: 2 }}>Upload files</ToggleButton>
        <ToggleButton value="manual" sx={{ textTransform: "none", px: 2 }}>Manual entry</ToggleButton>
      </ToggleButtonGroup>

      {entryMode === "manual" && <QpcrManualEntry onLoad={onManualLoad} />}

      <Paper variant="outlined" sx={{ p: 2, display: entryMode === "files" ? "block" : "none" }}>
        <Typography variant="subtitle2" gutterBottom>1 · Upload qPCR + plate-map files</Typography>
        <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap">
          <Button component="label" variant="outlined" startIcon={<UploadFileIcon />}>
            Choose .txt files
            <input
              type="file"
              hidden
              multiple
              accept=".txt"
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            />
          </Button>
          <Typography variant="caption" color="text.secondary">
            {files.length ? `${files.length} file(s): ${files.map((f) => f.name).join(", ")}` : "expects *_qpcr.txt + *_platemap.txt"}
          </Typography>
          <FormControlLabel
            control={<Checkbox checked={dropHighCp} onChange={(e) => setDropHighCp(e.target.checked)} />}
            label="Drop Cp ≥ 35"
          />
          <Button variant="contained" disabled={!files.length || busy === "upload"} onClick={doUpload}>
            {busy === "upload" ? <CircularProgress size={18} /> : "Upload"}
          </Button>
        </Stack>
        {upload?.errors?.length ? (
          <Alert severity="warning" sx={{ mt: 1 }}>{upload.errors.join("; ")}</Alert>
        ) : null}
        {upload?.pairs?.length ? (
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: "block" }}>
            Loaded {upload.pairs.length} pair(s): {upload.pairs.map((p) => `${p.name} (${p.n_rows})`).join(", ")} ·{" "}
            {upload.samples.length} samples
          </Typography>
        ) : null}
      </Paper>

      {/* 2. Selection + analysis */}
      {upload?.pairs?.length ? (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle2" gutterBottom>2 · Select genes & samples</Typography>
          <FormControlLabel
            control={<Checkbox checked={useCommon} onChange={(e) => setUseCommon(e.target.checked)} />}
            label="Only genes common to all pairs"
          />
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Autocomplete
              multiple size="small" options={genesForSelection} value={refGenes}
              onChange={(_, v) => setRefGenes(v)}
              renderInput={(p) => <TextField {...p} label="Reference / housekeeping genes" />}
            />
            <Autocomplete
              multiple size="small" options={genesForSelection} value={targetGenes}
              onChange={(_, v) => setTargetGenes(v)}
              renderInput={(p) => <TextField {...p} label="Target genes" />}
            />
            <Stack direction="row" spacing={2}>
              <TextField
                select size="small" label="Control sample" value={control}
                onChange={(e) => setControl(e.target.value)} sx={{ minWidth: 200 }}
              >
                {upload.samples.map((s) => <MenuItem key={s} value={s}>{s}</MenuItem>)}
              </TextField>
              <Autocomplete
                multiple size="small" sx={{ flexGrow: 1 }}
                options={upload.samples.filter((s) => s !== control)} value={experimental}
                onChange={(_, v) => setExperimental(v)}
                renderInput={(p) => <TextField {...p} label="Experimental samples" />}
              />
            </Stack>
            <Box>
              <Typography variant="caption" color="text.secondary">Statistical test</Typography>
              <RadioGroup row value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
                <FormControlLabel value="auto" control={<Radio size="small" />} label="Automatic" />
                <FormControlLabel value="ttest" control={<Radio size="small" />} label="T-test" />
                <FormControlLabel value="anova" control={<Radio size="small" />} label="ANOVA + Tukey" />
              </RadioGroup>
            </Box>
            <Box>
              <Button variant="contained" disabled={!canAnalyze || busy === "analyze"} onClick={doAnalyze}>
                {busy === "analyze" ? <CircularProgress size={18} /> : "Run ΔΔCt analysis"}
              </Button>
            </Box>
          </Stack>
        </Paper>
      ) : null}

      {/* 3. Results */}
      {analysis && !analysis.error ? (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle2" gutterBottom>3 · Results</Typography>
          <Stack spacing={2}>
            <RecordTable rows={analysis.summary} title="Fold-change summary" downloadName="qpcr_summary.csv" />
            {analysis.ttest_results.length > 0 && (
              <RecordTable rows={analysis.ttest_results} title="T-test" downloadName="qpcr_ttest.csv" />
            )}
            {analysis.anova_tukey_results.length > 0 && (
              <RecordTable rows={analysis.anova_tukey_results} title="ANOVA + Tukey" downloadName="qpcr_anova_tukey.csv" />
            )}
          </Stack>
        </Paper>
      ) : null}

      {/* 4. Plot */}
      {analysis?.summary?.length ? (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle2" gutterBottom>4 · Figure</Typography>
          <Typography variant="caption" color="text.secondary">Display</Typography>
          <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap sx={{ mb: 1, mt: 0.5 }}>
            <TextField select size="small" label="Layout" value={layout}
              onChange={(e) => changeLayout(e.target.value as typeof layout)} sx={{ width: 160 }}>
              <MenuItem value="grouped">Single graph</MenuItem>
              <MenuItem value="faceted">One panel per gene</MenuItem>
            </TextField>
            <TextField select size="small" label="Plot type" value={plotType}
              onChange={(e) => setPlotType(e.target.value as typeof plotType)} sx={{ width: 130 }}>
              <MenuItem value="bar">Bar</MenuItem>
              <MenuItem value="violin">Violin</MenuItem>
              <MenuItem value="box">Box</MenuItem>
              <MenuItem value="dot">Dot (mean)</MenuItem>
            </TextField>
            <TextField select size="small" label="Theme" value={theme}
              onChange={(e) => setTheme(e.target.value as typeof theme)} sx={{ width: 120 }}>
              <MenuItem value="prism">Prism</MenuItem>
              <MenuItem value="classic">Classic</MenuItem>
              <MenuItem value="minimal">Minimal</MenuItem>
            </TextField>
            <TextField select size="small" label="Error bars" value={errorType}
              onChange={(e) => setErrorType(e.target.value as "SD" | "SEM")} sx={{ width: 100 }}>
              <MenuItem value="SD">SD</MenuItem>
              <MenuItem value="SEM">SEM</MenuItem>
            </TextField>
            <FormControlLabel control={<Checkbox checked={showPoints} onChange={(e) => setShowPoints(e.target.checked)} />} label="Show points" />
            {(showPoints || plotType === "dot") && (
              <TextField size="small" type="number" label="Point size" value={pointSize}
                onChange={(e) => setPointSize(Number(e.target.value) || 1.8)} inputProps={{ step: 0.2 }} sx={{ width: 100 }} />
            )}
            {plotType === "bar" && (
              <TextField size="small" type="number" label="Bar width" value={barWidth}
                onChange={(e) => setBarWidth(Number(e.target.value) || 0.7)} inputProps={{ step: 0.1 }} sx={{ width: 100 }} />
            )}
            <TextField size="small" label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
            <TextField size="small" label="X label" value={xlabel} onChange={(e) => setXlabel(e.target.value)} sx={{ width: 120 }} />
            <TextField size="small" label="Y label" value={ylabel} onChange={(e) => setYlabel(e.target.value)} sx={{ width: 140 }} />
            <TextField size="small" type="number" label="Font size" value={fontSize}
              onChange={(e) => setFontSize(Number(e.target.value) || 14)} sx={{ width: 100 }} />
          </Stack>

          <Divider sx={{ my: 1 }} />
          <Typography variant="caption" color="text.secondary">Export &amp; format</Typography>
          <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap sx={{ mb: 1, mt: 0.5 }}>
            <TextField size="small" type="number" label="Sig. level" value={sigLevel}
              onChange={(e) => setSigLevel(Number(e.target.value) || 0.05)} inputProps={{ step: 0.01 }} sx={{ width: 100 }} />
            <FormControlLabel control={<Checkbox checked={hideNs} onChange={(e) => setHideNs(e.target.checked)} />} label="Hide ns" />
            <TextField size="small" type="number" label="Width (px)" value={plotWidth}
              onChange={(e) => setPlotWidth(Number(e.target.value) || 1200)} inputProps={{ step: 100 }} sx={{ width: 110 }} />
            <TextField size="small" type="number" label="Height (px)" value={plotHeight}
              onChange={(e) => setPlotHeight(Number(e.target.value) || 800)} inputProps={{ step: 100 }} sx={{ width: 110 }} />
            <TextField select size="small" label="DPI" value={dpi} onChange={(e) => setDpi(Number(e.target.value))} sx={{ width: 100 }}>
              {[100, 150, 300, 600].map((d) => <MenuItem key={d} value={d}>{d}</MenuItem>)}
            </TextField>
            <TextField select size="small" label="Export format" value={exportFormat}
              onChange={(e) => setExportFormat(e.target.value as "png" | "tiff")} sx={{ width: 130 }}>
              <MenuItem value="png">PNG</MenuItem>
              <MenuItem value="tiff">TIFF</MenuItem>
            </TextField>
            <FormControlLabel control={<Checkbox checked={transparent} onChange={(e) => setTransparent(e.target.checked)} />} label="Transparent bg" />
          </Stack>

          <Divider sx={{ my: 1 }} />
          <Typography variant="caption" color="text.secondary">Per-sample colour & legend label</Typography>
          <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap sx={{ my: 1 }}>
            {sampleOrder.map((s) => (
              <Stack key={s} direction="row" spacing={1} alignItems="center">
                <input
                  type="color" value={colors[s] ?? "#888888"}
                  onChange={(e) => setColors({ ...colors, [s]: e.target.value })}
                  style={{ width: 28, height: 28, border: "none", background: "none" }}
                />
                <TextField size="small" value={labels[s] ?? s}
                  onChange={(e) => setLabels({ ...labels, [s]: e.target.value })} sx={{ width: 130 }} />
              </Stack>
            ))}
          </Stack>

          <Button variant="contained" disabled={busy === "plot"} onClick={doPlot}>
            {busy === "plot" ? <CircularProgress size={18} /> : "Generate figure"}
          </Button>
          <PlotResult result={plot} baseName="qpcr_plot" />
        </Paper>
      ) : null}
    </Box>
  );
}
