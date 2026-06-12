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

const PALETTE = ["#5a7fa8", "#63a66a", "#c1666b", "#d4a05a", "#8a6fae", "#4aa3a3", "#b07aa1", "#9c9c4a"];

export function QpcrView() {
  const [files, setFiles] = useState<File[]>([]);
  const [dropHighCp, setDropHighCp] = useState(false);
  const [upload, setUpload] = useState<QpcrUploadResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [useCommon, setUseCommon] = useState(true);
  const [refGenes, setRefGenes] = useState<string[]>([]);
  const [targetGenes, setTargetGenes] = useState<string[]>([]);
  const [control, setControl] = useState<string>("");
  const [experimental, setExperimental] = useState<string[]>([]);
  const [method, setMethod] = useState<"auto" | "ttest" | "anova">("auto");
  const [analysis, setAnalysis] = useState<QpcrAnalyzeResult | null>(null);

  const [errorType, setErrorType] = useState<"SD" | "SEM">("SD");
  const [title, setTitle] = useState("Fold change per gene");
  const [xlabel, setXlabel] = useState("Sample");
  const [ylabel, setYlabel] = useState("Fold change");
  const [fontSize, setFontSize] = useState(14);
  const [dpi, setDpi] = useState(150);
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
        ttest_results: analysis.ttest_results,
        anova_tukey_results: analysis.anova_tukey_results,
        gene_order: targetGenes,
        sample_order: sampleOrder,
        colors,
        labels,
        error_type: errorType,
        significance_level: sigLevel,
        hide_ns: hideNs,
        title,
        xlabel,
        ylabel,
        font_size: fontSize,
        width: 1200,
        height: 800,
        dpi,
      });
      setPlot(res);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const canAnalyze = upload && refGenes.length && targetGenes.length && control;

  return (
    <Box sx={{ p: 2, display: "flex", flexDirection: "column", gap: 2 }}>
      {err && <Alert severity="error" onClose={() => setErr(null)}>{err}</Alert>}

      {/* 1. Upload */}
      <Paper variant="outlined" sx={{ p: 2 }}>
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
          <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
            <TextField select size="small" label="Error bars" value={errorType}
              onChange={(e) => setErrorType(e.target.value as "SD" | "SEM")} sx={{ width: 110 }}>
              <MenuItem value="SD">SD</MenuItem>
              <MenuItem value="SEM">SEM</MenuItem>
            </TextField>
            <TextField size="small" label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
            <TextField size="small" label="X label" value={xlabel} onChange={(e) => setXlabel(e.target.value)} sx={{ width: 130 }} />
            <TextField size="small" label="Y label" value={ylabel} onChange={(e) => setYlabel(e.target.value)} sx={{ width: 150 }} />
            <TextField size="small" type="number" label="Font size" value={fontSize}
              onChange={(e) => setFontSize(Number(e.target.value) || 14)} sx={{ width: 100 }} />
            <TextField select size="small" label="DPI" value={dpi} onChange={(e) => setDpi(Number(e.target.value))} sx={{ width: 100 }}>
              {[100, 150, 300, 600].map((d) => <MenuItem key={d} value={d}>{d}</MenuItem>)}
            </TextField>
            <TextField size="small" type="number" label="Sig. level" value={sigLevel}
              onChange={(e) => setSigLevel(Number(e.target.value) || 0.05)} inputProps={{ step: 0.01 }} sx={{ width: 100 }} />
            <FormControlLabel control={<Checkbox checked={hideNs} onChange={(e) => setHideNs(e.target.checked)} />} label="Hide ns" />
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
