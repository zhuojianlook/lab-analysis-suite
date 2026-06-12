import { useState } from "react";
import {
  Alert, Box, Button, Checkbox, CircularProgress, FormControlLabel,
  MenuItem, Paper, Stack, TextField, Typography,
} from "@mui/material";
import { registerPath, runJob, jobStatus, pollRJob, type RJobStatus } from "../../api/client";
import { DataPathInput } from "../shared/DataPathInput";
import { JobProgress } from "../shared/JobProgress";
import { JobResults } from "../shared/JobResults";

export function ScrnaView() {
  const [path, setPath] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [inputType, setInputType] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [job, setJob] = useState<RJobStatus | null>(null);

  const [species, setSpecies] = useState("human");
  const [normalization, setNormalization] = useState("LogNormalize");
  const [minFeatures, setMinFeatures] = useState(200);
  const [maxFeatures, setMaxFeatures] = useState(6000);
  const [maxMito, setMaxMito] = useState(15);
  const [resolution, setResolution] = useState(0.8);
  const [dims, setDims] = useState(30);
  const [integration, setIntegration] = useState("none");
  const [annotation, setAnnotation] = useState("none");
  const [useBpcells, setUseBpcells] = useState(false);

  const doRegister = async (p: string) => {
    setPath(p); setErr(null); setBusy("register");
    try {
      const res = await registerPath("scrna", { path: p });
      if (res.error) { setErr(String(res.error)); setToken(null); return; }
      setToken(String(res.token)); setInputType(String(res.input_type)); setJob(null);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  };

  const doRun = async () => {
    if (!token) return;
    setBusy("run"); setErr(null); setJob(null);
    try {
      const { job_id, error } = await runJob("scrna", {
        token, species, normalization, min_features: minFeatures, max_features: maxFeatures,
        max_mito: maxMito, resolution, dims, integration, annotation, use_bpcells: useBpcells,
      });
      if (!job_id) { setErr(error || "Could not start the run."); return; }
      const final = await pollRJob((id) => `/api/scrna/status/${id}`, job_id, setJob);
      void jobStatus; // keep import used
      setJob(final);
      if (final.status === "error") setErr(final.error || "Pipeline failed.");
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  };

  return (
    <Box sx={{ p: 2, display: "flex", flexDirection: "column", gap: 2 }}>
      {err && <Alert severity="error" onClose={() => setErr(null)}>{err}</Alert>}

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="subtitle2" gutterBottom>1 · Data</Typography>
        <DataPathInput value={path} onPick={doRegister}
          folderLabel="10x folder" fileLabel="Counts / .h5 / .h5ad / .rds" />
        {busy === "register" && <CircularProgress size={16} sx={{ ml: 1 }} />}
        {token && <Typography variant="caption" color="success.main" sx={{ display: "block", mt: 1 }}>Detected input: {inputType}</Typography>}
      </Paper>

      {token ? (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle2" gutterBottom>2 · Parameters</Typography>
          <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
            <TextField select size="small" label="Species" value={species} onChange={(e) => setSpecies(e.target.value)} sx={{ width: 120 }}>
              <MenuItem value="human">Human</MenuItem><MenuItem value="mouse">Mouse</MenuItem>
            </TextField>
            <TextField select size="small" label="Normalization" value={normalization} onChange={(e) => setNormalization(e.target.value)} sx={{ width: 160 }}>
              <MenuItem value="LogNormalize">LogNormalize</MenuItem><MenuItem value="SCT">SCTransform</MenuItem>
            </TextField>
            <TextField size="small" type="number" label="min features" value={minFeatures} onChange={(e) => setMinFeatures(Number(e.target.value) || 200)} sx={{ width: 110 }} />
            <TextField size="small" type="number" label="max features" value={maxFeatures} onChange={(e) => setMaxFeatures(Number(e.target.value) || 6000)} sx={{ width: 110 }} />
            <TextField size="small" type="number" label="max %mito" value={maxMito} onChange={(e) => setMaxMito(Number(e.target.value) || 15)} sx={{ width: 100 }} />
            <TextField size="small" type="number" label="PCA dims" value={dims} onChange={(e) => setDims(Number(e.target.value) || 30)} sx={{ width: 100 }} />
            <TextField size="small" type="number" label="resolution" value={resolution} onChange={(e) => setResolution(Number(e.target.value) || 0.8)} inputProps={{ step: 0.1 }} sx={{ width: 110 }} />
            <TextField select size="small" label="Integration" value={integration} onChange={(e) => setIntegration(e.target.value)} sx={{ width: 140 }}>
              <MenuItem value="none">None</MenuItem><MenuItem value="harmony">Harmony</MenuItem>
            </TextField>
            <TextField select size="small" label="Annotation" value={annotation} onChange={(e) => setAnnotation(e.target.value)} sx={{ width: 160 }}>
              <MenuItem value="none">Manual markers</MenuItem><MenuItem value="singler">SingleR</MenuItem>
            </TextField>
            <FormControlLabel control={<Checkbox checked={useBpcells} onChange={(e) => setUseBpcells(e.target.checked)} />} label="BPCells (big data)" />
          </Stack>
          <Box sx={{ mt: 1.5 }}>
            <Button variant="contained" disabled={busy === "run"} onClick={doRun}>
              {busy === "run" ? <CircularProgress size={18} /> : "Run pipeline"}
            </Button>
          </Box>
          <JobProgress job={job} />
        </Paper>
      ) : null}

      {job?.status === "done" ? (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle2" gutterBottom>3 · Results</Typography>
          <JobResults job={job} baseName="scrna" />
        </Paper>
      ) : null}
    </Box>
  );
}
