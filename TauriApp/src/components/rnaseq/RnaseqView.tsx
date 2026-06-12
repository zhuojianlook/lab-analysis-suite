import { useMemo, useState } from "react";
import {
  Alert, Box, Button, Checkbox, CircularProgress, FormControlLabel,
  MenuItem, Paper, Stack, TextField, Typography,
} from "@mui/material";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import { DataGrid, type GridColDef } from "@mui/x-data-grid";
import {
  uploadRnaseq, runRnaseq, rnaseqStatus, pollRJob, parseCsv,
  type RnaseqUploadResult, type RJobStatus,
} from "../../api/client";
import { JobProgress } from "../shared/JobProgress";
import { PlotResult } from "../shared/PlotResult";

const PLOT_NAMES = ["Volcano", "MA plot", "PCA", "Sample distances", "Top variable genes"];

export function RnaseqView() {
  const [countsFile, setCountsFile] = useState<File | null>(null);
  const [coldataFile, setColdataFile] = useState<File | null>(null);
  const [upload, setUpload] = useState<RnaseqUploadResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [design, setDesign] = useState("");
  const [factor, setFactor] = useState("");
  const [num, setNum] = useState("");
  const [den, setDen] = useState("");
  const [minCount, setMinCount] = useState(10);
  const [lfcShrink, setLfcShrink] = useState(true);

  const [job, setJob] = useState<RJobStatus | null>(null);
  const [padjMax, setPadjMax] = useState(0.05);
  const [lfcMin, setLfcMin] = useState(1);

  const factorLevels = upload?.factors?.[factor] ?? [];

  const doUpload = async () => {
    if (!countsFile || !coldataFile) return;
    setBusy("upload"); setErr(null);
    try {
      const res = await uploadRnaseq(await countsFile.text(), await coldataFile.text());
      if (res.error) { setErr(res.error); return; }
      setUpload(res);
      const facs = Object.keys(res.factors ?? {});
      const f = facs[0] ?? "";
      setFactor(f); setDesign(f);
      const lv = res.factors?.[f] ?? [];
      setDen(lv[0] ?? ""); setNum(lv[1] ?? "");
      setJob(null);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  };

  const doRun = async () => {
    if (!upload?.token || !factor || !num || !den) return;
    setBusy("run"); setErr(null); setJob(null);
    try {
      const { job_id, error } = await runRnaseq({
        token: upload.token, design: design || factor,
        contrast_factor: factor, contrast_numerator: num, contrast_denominator: den,
        min_count: minCount, lfc_shrink: lfcShrink,
      });
      if (!job_id) { setErr(error || "Could not start the run."); return; }
      const final = await pollRJob(rnaseqStatus as never, job_id, setJob);
      setJob(final);
      if (final.status === "error") setErr(final.error || "DESeq2 run failed.");
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  };

  // results table
  const resultsCsv = job?.tables?.find((t) => t.name === "deseq2_results")?.csv;
  const allRows = useMemo(() => (resultsCsv ? parseCsv(resultsCsv) : []), [resultsCsv]);
  const filtered = useMemo(
    () => allRows.filter((r) => {
      const padj = r["padj"] as number;
      const lfc = r["log2FoldChange"] as number;
      const padjOk = isNaN(padj) ? false : padj <= padjMax;
      const lfcOk = isNaN(lfc) ? false : Math.abs(lfc) >= lfcMin;
      return padjOk && lfcOk;
    }),
    [allRows, padjMax, lfcMin],
  );
  const columns: GridColDef[] = useMemo(() => {
    if (!allRows.length) return [];
    return Object.keys(allRows[0]).map((k) => ({
      field: k, headerName: k, flex: k === "gene" ? 1 : 0.8, minWidth: k === "gene" ? 120 : 100,
      type: typeof allRows[0][k] === "number" ? "number" : "string",
      valueFormatter: (v: unknown) =>
        typeof v === "number" ? (isNaN(v) ? "" : Math.abs(v) < 1e-3 && v !== 0 ? v.toExponential(2) : v.toFixed(3)) : v,
    }));
  }, [allRows]);

  const jobPlots = job?.status === "done" ? { success: true, stdout: "", stderr: "", plots: job.plots, tables: [] } : null;

  return (
    <Box sx={{ p: 2, display: "flex", flexDirection: "column", gap: 2 }}>
      {err && <Alert severity="error" onClose={() => setErr(null)}>{err}</Alert>}

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="subtitle2" gutterBottom>1 · Upload counts matrix + sample metadata (CSV)</Typography>
        <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
          <Button component="label" variant="outlined" startIcon={<UploadFileIcon />}>
            {countsFile ? countsFile.name : "Counts matrix"}
            <input type="file" hidden accept=".csv,.tsv,.txt" onChange={(e) => setCountsFile(e.target.files?.[0] ?? null)} />
          </Button>
          <Button component="label" variant="outlined" startIcon={<UploadFileIcon />}>
            {coldataFile ? coldataFile.name : "Sample metadata"}
            <input type="file" hidden accept=".csv,.tsv,.txt" onChange={(e) => setColdataFile(e.target.files?.[0] ?? null)} />
          </Button>
          <Button variant="contained" disabled={!countsFile || !coldataFile || busy === "upload"} onClick={doUpload}>
            {busy === "upload" ? <CircularProgress size={18} /> : "Upload"}
          </Button>
        </Stack>
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1 }}>
          Counts: genes in rows (first column = gene id), samples in columns. Metadata: first column = sample id matching the counts columns.
        </Typography>
        {upload?.token && (
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>
            {upload.n_genes} genes · {upload.n_samples_matched} matched samples · factors: {Object.keys(upload.factors ?? {}).join(", ") || "none detected"}
          </Typography>
        )}
      </Paper>

      {upload?.token ? (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle2" gutterBottom>2 · Design & contrast</Typography>
          <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
            <TextField select size="small" label="Contrast factor" value={factor} sx={{ minWidth: 160 }}
              onChange={(e) => { const f = e.target.value; setFactor(f); setDesign(f); const lv = upload.factors?.[f] ?? []; setDen(lv[0] ?? ""); setNum(lv[1] ?? ""); }}>
              {Object.keys(upload.factors ?? {}).map((f) => <MenuItem key={f} value={f}>{f}</MenuItem>)}
            </TextField>
            <TextField select size="small" label="Numerator (test)" value={num} sx={{ minWidth: 140 }} onChange={(e) => setNum(e.target.value)}>
              {factorLevels.map((l) => <MenuItem key={l} value={l}>{l}</MenuItem>)}
            </TextField>
            <TextField select size="small" label="Denominator (ref)" value={den} sx={{ minWidth: 140 }} onChange={(e) => setDen(e.target.value)}>
              {factorLevels.map((l) => <MenuItem key={l} value={l}>{l}</MenuItem>)}
            </TextField>
            <TextField size="small" label="Design (~)" value={design} onChange={(e) => setDesign(e.target.value)} sx={{ minWidth: 180 }}
              helperText="e.g. condition or batch + condition" />
            <TextField size="small" type="number" label="Min count" value={minCount} onChange={(e) => setMinCount(Number(e.target.value) || 10)} sx={{ width: 110 }} />
            <FormControlLabel control={<Checkbox checked={lfcShrink} onChange={(e) => setLfcShrink(e.target.checked)} />} label="lfcShrink (apeglm)" />
          </Stack>
          <Box sx={{ mt: 1.5 }}>
            <Button variant="contained" disabled={!factor || !num || !den || num === den || busy === "run"} onClick={doRun}>
              {busy === "run" ? <CircularProgress size={18} /> : "Run DESeq2"}
            </Button>
          </Box>
          <JobProgress job={job} />
        </Paper>
      ) : null}

      {job?.status === "done" ? (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle2" gutterBottom>3 · Results</Typography>
          <Stack direction="row" spacing={2} sx={{ mb: 1 }} alignItems="center">
            <TextField size="small" type="number" label="padj ≤" value={padjMax} onChange={(e) => setPadjMax(Number(e.target.value) || 1)} inputProps={{ step: 0.01 }} sx={{ width: 110 }} />
            <TextField size="small" type="number" label="|log2FC| ≥" value={lfcMin} onChange={(e) => setLfcMin(Number(e.target.value) || 0)} inputProps={{ step: 0.5 }} sx={{ width: 120 }} />
            <Typography variant="caption" color="text.secondary">{filtered.length} of {allRows.length} genes pass</Typography>
          </Stack>
          {allRows.length > 0 && (
            <Box sx={{ height: 360, width: "100%" }}>
              <DataGrid
                rows={filtered.map((r, i) => ({ id: i, ...r }))}
                columns={columns}
                density="compact"
                disableRowSelectionOnClick
                pageSizeOptions={[25, 50, 100]}
                initialState={{ pagination: { paginationModel: { pageSize: 25 } } }}
              />
            </Box>
          )}
          <Typography variant="subtitle2" sx={{ mt: 2 }} gutterBottom>Figures</Typography>
          <Typography variant="caption" color="text.secondary">{PLOT_NAMES.join(" · ")}</Typography>
          <PlotResult result={jobPlots} baseName="deseq2" />
        </Paper>
      ) : null}
    </Box>
  );
}
