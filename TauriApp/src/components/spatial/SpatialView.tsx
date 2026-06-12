import { useState } from "react";
import {
  Alert, Box, Button, CircularProgress, MenuItem, Paper, Stack, TextField, Typography,
} from "@mui/material";
import { registerPath, runJob, pollRJob, type RJobStatus } from "../../api/client";
import { DataPathInput } from "../shared/DataPathInput";
import { JobProgress } from "../shared/JobProgress";
import { JobResults } from "../shared/JobResults";

export function SpatialView() {
  const [path, setPath] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [inputType, setInputType] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [job, setJob] = useState<RJobStatus | null>(null);

  const [species, setSpecies] = useState("human");
  const [normalization, setNormalization] = useState("SCT");
  const [dims, setDims] = useState(30);
  const [resolution, setResolution] = useState(0.8);

  const doRegister = async (p: string) => {
    setPath(p); setErr(null); setBusy("register");
    try {
      const res = await registerPath("spatial", { path: p });
      if (res.error) { setErr(String(res.error)); setToken(null); return; }
      setToken(String(res.token)); setInputType(String(res.input_type)); setJob(null);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  };

  const doRun = async () => {
    if (!token) return;
    setBusy("run"); setErr(null); setJob(null);
    try {
      const { job_id, error } = await runJob("spatial", { token, species, normalization, dims, resolution });
      if (!job_id) { setErr(error || "Could not start the run."); return; }
      const final = await pollRJob((id) => `/api/spatial/status/${id}`, job_id, setJob);
      setJob(final);
      if (final.status === "error") setErr(final.error || "Pipeline failed.");
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  };

  return (
    <Box sx={{ p: 2, display: "flex", flexDirection: "column", gap: 2 }}>
      {err && <Alert severity="error" onClose={() => setErr(null)}>{err}</Alert>}

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="subtitle2" gutterBottom>1 · Visium data (Space Ranger output folder)</Typography>
        <DataPathInput value={path} onPick={doRegister} folderLabel="Space Ranger folder" fileLabel=".rds object" />
        {busy === "register" && <CircularProgress size={16} sx={{ ml: 1 }} />}
        {token && <Typography variant="caption" color="success.main" sx={{ display: "block", mt: 1 }}>Detected: {inputType}</Typography>}
      </Paper>

      {token ? (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle2" gutterBottom>2 · Parameters</Typography>
          <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
            <TextField select size="small" label="Species" value={species} onChange={(e) => setSpecies(e.target.value)} sx={{ width: 120 }}>
              <MenuItem value="human">Human</MenuItem><MenuItem value="mouse">Mouse</MenuItem>
            </TextField>
            <TextField select size="small" label="Normalization" value={normalization} onChange={(e) => setNormalization(e.target.value)} sx={{ width: 160 }}>
              <MenuItem value="SCT">SCTransform</MenuItem><MenuItem value="LogNormalize">LogNormalize</MenuItem>
            </TextField>
            <TextField size="small" type="number" label="PCA dims" value={dims} onChange={(e) => setDims(Number(e.target.value) || 30)} sx={{ width: 110 }} />
            <TextField size="small" type="number" label="resolution" value={resolution} onChange={(e) => setResolution(Number(e.target.value) || 0.8)} inputProps={{ step: 0.1 }} sx={{ width: 110 }} />
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
          <JobResults job={job} baseName="spatial" />
        </Paper>
      ) : null}
    </Box>
  );
}
