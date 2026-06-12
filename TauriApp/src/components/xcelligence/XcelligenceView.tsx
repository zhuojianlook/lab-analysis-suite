import { useState } from "react";
import {
  Alert, Autocomplete, Box, Button, Checkbox, CircularProgress, Divider,
  FormControlLabel, MenuItem, Paper, Stack, TextField, Typography,
} from "@mui/material";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import {
  uploadXcelligence, processXcelligence, barStatsXcelligence,
  plotLineXcelligence, plotBarXcelligence,
  type XcellUploadResult, type XcellProcessResult, type XcellBarStats,
} from "../../api/client";
import type { RunRResponse } from "../../api/types";
import { RecordTable } from "../shared/RecordTable";
import { PlotResult } from "../shared/PlotResult";

const PALETTE = ["#5a7fa8", "#63a66a", "#c1666b", "#d4a05a", "#8a6fae", "#4aa3a3", "#b07aa1", "#9c9c4a"];

interface FileParam { normalize_sample: string; base_time_h: number; drop_wells: string[] }

export function XcelligenceView() {
  const [files, setFiles] = useState<File[]>([]);
  const [upload, setUpload] = useState<XcellUploadResult | null>(null);
  const [params, setParams] = useState<Record<string, FileParam>>({});
  const [proc, setProc] = useState<XcellProcessResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // line
  const [lineSamples, setLineSamples] = useState<string[]>([]);
  const [colors, setColors] = useState<Record<string, string>>({});
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [showSd, setShowSd] = useState(true);
  const [lineTitle, setLineTitle] = useState("Normalized Cell Index vs Time");
  const [linePlot, setLinePlot] = useState<RunRResponse | null>(null);

  // bar
  const [barTime, setBarTime] = useState<number | "">("");
  const [barStats, setBarStats] = useState<XcellBarStats | null>(null);
  const [barTitle, setBarTitle] = useState("Endpoint comparison");
  const [barPlot, setBarPlot] = useState<RunRResponse | null>(null);

  const setP = (name: string, patch: Partial<FileParam>) =>
    setParams((s) => ({ ...s, [name]: { ...s[name], ...patch } }));

  const doUpload = async () => {
    if (!files.length) return;
    setBusy("upload"); setErr(null);
    try {
      const res = await uploadXcelligence(files);
      setUpload(res);
      const p: Record<string, FileParam> = {};
      res.files.forEach((f) => { p[f.name] = { normalize_sample: f.samples[0] ?? "", base_time_h: 0, drop_wells: [] }; });
      setParams(p);
      setProc(null); setLinePlot(null); setBarPlot(null);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  };

  const doProcess = async () => {
    if (!upload?.token) return;
    setBusy("process"); setErr(null);
    try {
      const res = await processXcelligence({
        token: upload.token,
        params: upload.files.map((f) => ({ name: f.name, ...params[f.name] })),
      });
      if (res.error) { setErr(res.error); return; }
      setProc(res);
      const c: Record<string, string> = {}; const l: Record<string, string> = {};
      res.samples.forEach((s, i) => { c[s] = PALETTE[i % PALETTE.length]; l[s] = s; });
      setColors(c); setLabels(l);
      setLineSamples(res.samples);
      setBarTime(res.times_h[res.times_h.length - 1] ?? "");
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  };

  const doLine = async () => {
    if (!upload?.token) return;
    setBusy("line"); setErr(null);
    try {
      setLinePlot(await plotLineXcelligence({
        token: upload.token, samples: lineSamples, colors, labels, show_sd: showSd, title: lineTitle,
      }));
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  };

  const doBar = async () => {
    if (!upload?.token || barTime === "") return;
    setBusy("bar"); setErr(null);
    try {
      const stats = await barStatsXcelligence({ token: upload.token, time_h: barTime, samples: lineSamples });
      if (stats.error) { setErr(stats.error); return; }
      setBarStats(stats);
      setBarPlot(await plotBarXcelligence({
        summary: stats.summary, replicates: stats.replicates, comparisons: stats.comparisons,
        sample_order: lineSamples, colors, labels, title: barTitle,
      }));
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  };

  return (
    <Box sx={{ p: 2, display: "flex", flexDirection: "column", gap: 2 }}>
      {err && <Alert severity="error" onClose={() => setErr(null)}>{err}</Alert>}

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="subtitle2" gutterBottom>1 · Upload E-Plate .xlsx files (Layout + Cell Index sheets)</Typography>
        <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap">
          <Button component="label" variant="outlined" startIcon={<UploadFileIcon />}>
            Choose .xlsx
            <input type="file" hidden multiple accept=".xlsx" onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
          </Button>
          <Typography variant="caption" color="text.secondary">
            {files.length ? `${files.length} file(s)` : "one or more xCELLigence exports"}
          </Typography>
          <Button variant="contained" disabled={!files.length || busy === "upload"} onClick={doUpload}>
            {busy === "upload" ? <CircularProgress size={18} /> : "Upload"}
          </Button>
        </Stack>
        {upload?.errors?.length ? <Alert severity="warning" sx={{ mt: 1 }}>{upload.errors.join("; ")}</Alert> : null}
      </Paper>

      {upload?.files?.length ? (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle2" gutterBottom>2 · Per-file normalization & baseline</Typography>
          <Stack spacing={2}>
            {upload.files.map((f) => (
              <Box key={f.name} sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1, p: 1.5 }}>
                <Typography variant="body2" sx={{ fontWeight: 600, mb: 1 }}>{f.name} · {f.n_timepoints} timepoints</Typography>
                <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
                  <TextField select size="small" label="Normalize to" sx={{ minWidth: 160 }}
                    value={params[f.name]?.normalize_sample ?? ""}
                    onChange={(e) => setP(f.name, { normalize_sample: e.target.value })}>
                    {f.samples.map((s) => <MenuItem key={s} value={s}>{s}</MenuItem>)}
                  </TextField>
                  <TextField size="small" type="number" label="Base time (h)" sx={{ width: 130 }}
                    value={params[f.name]?.base_time_h ?? 0}
                    onChange={(e) => setP(f.name, { base_time_h: Number(e.target.value) || 0 })} inputProps={{ step: 0.25 }} />
                  <Autocomplete multiple size="small" sx={{ flexGrow: 1, minWidth: 240 }}
                    options={f.wells} value={params[f.name]?.drop_wells ?? []}
                    onChange={(_, v) => setP(f.name, { drop_wells: v })}
                    renderInput={(p) => <TextField {...p} label="Drop wells" />} />
                </Stack>
              </Box>
            ))}
            <Box>
              <Button variant="contained" disabled={busy === "process"} onClick={doProcess}>
                {busy === "process" ? <CircularProgress size={18} /> : "Process"}
              </Button>
            </Box>
          </Stack>
        </Paper>
      ) : null}

      {proc ? (
        <>
          <Paper variant="outlined" sx={{ p: 2 }}>
            <Typography variant="subtitle2" gutterBottom>3 · Time-course line graph</Typography>
            <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
              <Autocomplete multiple size="small" sx={{ minWidth: 280, flexGrow: 1 }}
                options={proc.samples} value={lineSamples} onChange={(_, v) => setLineSamples(v)}
                renderInput={(p) => <TextField {...p} label="Samples" />} />
              <TextField size="small" label="Title" value={lineTitle} onChange={(e) => setLineTitle(e.target.value)} />
              <FormControlLabel control={<Checkbox checked={showSd} onChange={(e) => setShowSd(e.target.checked)} />} label="±SD band" />
            </Stack>
            <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
              {lineSamples.map((s) => (
                <Stack key={s} direction="row" spacing={1} alignItems="center">
                  <input type="color" value={colors[s] ?? "#5a7fa8"} onChange={(e) => setColors({ ...colors, [s]: e.target.value })}
                    style={{ width: 28, height: 28, border: "none", background: "none" }} />
                  <TextField size="small" value={labels[s] ?? s} onChange={(e) => setLabels({ ...labels, [s]: e.target.value })} sx={{ width: 120 }} />
                </Stack>
              ))}
            </Stack>
            <Button variant="contained" disabled={!lineSamples.length || busy === "line"} onClick={doLine}>
              {busy === "line" ? <CircularProgress size={18} /> : "Generate line graph"}
            </Button>
            <PlotResult result={linePlot} baseName="xcelligence_line" />
          </Paper>

          <Paper variant="outlined" sx={{ p: 2 }}>
            <Typography variant="subtitle2" gutterBottom>4 · Endpoint bar chart (ANOVA + Tukey)</Typography>
            <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
              <TextField select size="small" label="Timepoint (h)" sx={{ width: 150 }}
                value={barTime} onChange={(e) => setBarTime(Number(e.target.value))}>
                {proc.times_h.map((t) => <MenuItem key={t} value={t}>{t} h</MenuItem>)}
              </TextField>
              <TextField size="small" label="Title" value={barTitle} onChange={(e) => setBarTitle(e.target.value)} />
              <Button variant="contained" disabled={barTime === "" || !lineSamples.length || busy === "bar"} onClick={doBar}>
                {busy === "bar" ? <CircularProgress size={18} /> : "Compute + plot"}
              </Button>
            </Stack>
            {barStats && (
              <Stack spacing={1} sx={{ my: 1 }}>
                <RecordTable rows={barStats.summary} title="Per-sample summary" downloadName="xcelligence_endpoint.csv" />
                {barStats.comparisons.length > 0 && (
                  <RecordTable rows={barStats.comparisons} title="Tukey comparisons" downloadName="xcelligence_tukey.csv" />
                )}
              </Stack>
            )}
            <PlotResult result={barPlot} baseName="xcelligence_bar" />
          </Paper>
          <Divider />
        </>
      ) : null}
    </Box>
  );
}
