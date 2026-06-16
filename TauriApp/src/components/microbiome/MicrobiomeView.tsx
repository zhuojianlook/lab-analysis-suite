import { useState } from "react";
import {
  Alert, Box, Button, Checkbox, CircularProgress, FormControlLabel,
  MenuItem, Paper, Stack, Tab, Tabs, TextField, Typography,
} from "@mui/material";
import { registerPath, runJob, pollRJob, type RJobStatus } from "../../api/client";
import { DataPathInput } from "../shared/DataPathInput";
import { JobProgress } from "../shared/JobProgress";
import { JobResults } from "../shared/JobResults";

export function MicrobiomeView() {
  const [mode, setMode] = useState<"table" | "fastq">("table");
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [token, setToken] = useState<string | null>(null);
  const [metaCols, setMetaCols] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [job, setJob] = useState<RJobStatus | null>(null);

  const [groupCol, setGroupCol] = useState("");
  const [rarefy, setRarefy] = useState(true);
  const [taxRank, setTaxRank] = useState("Genus");
  const [diffMethod, setDiffMethod] = useState("ancombc2");
  const [betaMetric, setBetaMetric] = useState("bray");
  const [truncF, setTruncF] = useState(0);
  const [truncR, setTruncR] = useState(0);
  const [trimLeft, setTrimLeft] = useState(0);

  const setPath = (k: string, v: string) => setPaths((s) => ({ ...s, [k]: v }));

  const doRegister = async () => {
    setBusy("register"); setErr(null);
    try {
      const res = await registerPath("microbiome", { mode, ...paths });
      if (res.error) { setErr(String(res.error)); setToken(null); return; }
      setToken(String(res.token));
      const cols = (res.metadata_columns as string[]) ?? [];
      setMetaCols(cols);
      setGroupCol(cols[0] ?? "");
      setJob(null);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  };

  const doRun = async () => {
    if (!token || !groupCol) return;
    setBusy("run"); setErr(null); setJob(null);
    try {
      const { job_id, error } = await runJob("microbiome", {
        token, group_column: groupCol, rarefy, tax_rank: taxRank, diff_method: diffMethod,
        beta_metric: betaMetric, build_tree: betaMetric !== "bray",
        trunc_len_f: truncF, trunc_len_r: truncR, trim_left: trimLeft,
      });
      if (!job_id) { setErr(error || "Could not start the run."); return; }
      const final = await pollRJob((id) => `/api/microbiome/status/${id}`, job_id, setJob);
      setJob(final);
      if (final.status === "error") setErr(final.error || "Pipeline failed.");
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  };

  const fileInput = (key: string, label: string) => (
    <Box sx={{ mb: 1 }}>
      <Typography variant="caption" color="text.secondary">{label}</Typography>
      <DataPathInput value={paths[key] ?? ""} onPick={(p) => setPath(key, p)} allowFolder={false} fileLabel={`Choose ${label}`} />
    </Box>
  );

  return (
    <Box sx={{ p: 2, display: "flex", flexDirection: "column", gap: 2 }}>
      {err && <Alert severity="error" onClose={() => setErr(null)}>{err}</Alert>}

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Tabs value={mode} onChange={(_, v) => { setMode(v); setToken(null); }} sx={{ mb: 1, minHeight: 36 }}>
          <Tab value="table" label="ASV / OTU table" sx={{ minHeight: 36, textTransform: "none" }} />
          <Tab value="fastq" label="Raw FASTQ (DADA2)" sx={{ minHeight: 36, textTransform: "none" }} />
        </Tabs>
        {mode === "table" ? (
          <>
            {fileInput("asv", "ASV/OTU table (CSV: taxa × samples)")}
            {fileInput("taxonomy", "Taxonomy table (CSV: taxa × ranks)")}
            {fileInput("metadata", "Sample metadata (CSV)")}
            {fileInput("tree", "Phylogenetic tree (optional, Newick)")}
          </>
        ) : (
          <>
            <Box sx={{ mb: 1 }}>
              <Typography variant="caption" color="text.secondary">Paired FASTQ folder (*_R1*/*_R2*)</Typography>
              <DataPathInput value={paths["fastq_dir"] ?? ""} onPick={(p) => setPath("fastq_dir", p)} allowFile={false} folderLabel="FASTQ folder" />
            </Box>
            {fileInput("metadata", "Sample metadata (CSV)")}
            {fileInput("silva", "SILVA reference (assignTaxonomy fasta.gz)")}
            <Stack direction="row" spacing={2} sx={{ mt: 1 }}>
              <TextField size="small" type="number" label="truncLen F" value={truncF} onChange={(e) => setTruncF(Number(e.target.value) || 0)} sx={{ width: 120 }} />
              <TextField size="small" type="number" label="truncLen R" value={truncR} onChange={(e) => setTruncR(Number(e.target.value) || 0)} sx={{ width: 120 }} />
              <TextField size="small" type="number" label="trimLeft" value={trimLeft} onChange={(e) => setTrimLeft(Number(e.target.value) || 0)} sx={{ width: 110 }} />
            </Stack>
          </>
        )}
        <Button variant="contained" sx={{ mt: 1 }} disabled={busy === "register"} onClick={doRegister}>
          {busy === "register" ? <CircularProgress size={18} /> : "Register inputs"}
        </Button>
      </Paper>

      {token ? (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle2" gutterBottom>Parameters</Typography>
          <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
            <TextField select size="small" label="Group column" value={groupCol} onChange={(e) => setGroupCol(e.target.value)} sx={{ minWidth: 160 }}>
              {metaCols.map((c) => <MenuItem key={c} value={c}>{c}</MenuItem>)}
            </TextField>
            <TextField select size="small" label="Taxonomic rank" value={taxRank} onChange={(e) => setTaxRank(e.target.value)} sx={{ width: 150 }}>
              {["Phylum", "Class", "Order", "Family", "Genus", "Species"].map((r) => <MenuItem key={r} value={r}>{r}</MenuItem>)}
            </TextField>
            <TextField select size="small" label="Diff. abundance" value={diffMethod} onChange={(e) => setDiffMethod(e.target.value)} sx={{ width: 160 }}>
              <MenuItem value="ancombc2">ANCOM-BC2</MenuItem><MenuItem value="none">None</MenuItem>
            </TextField>
            <FormControlLabel control={<Checkbox checked={rarefy} onChange={(e) => setRarefy(e.target.checked)} />} label="Rarefy (alpha/beta)" />
            <TextField select size="small" label="Beta-diversity distance" value={betaMetric}
              onChange={(e) => setBetaMetric(e.target.value)} sx={{ minWidth: 200 }}
              helperText={betaMetric !== "bray" ? "Requires a phylogenetic tree" : " "}>
              <MenuItem value="bray">Bray-Curtis</MenuItem>
              <MenuItem value="wunifrac">Weighted UniFrac</MenuItem>
              <MenuItem value="unifrac">Unweighted UniFrac</MenuItem>
            </TextField>
          </Stack>
          <Box sx={{ mt: 1.5 }}>
            <Button variant="contained" disabled={!groupCol || busy === "run"} onClick={doRun}>
              {busy === "run" ? <CircularProgress size={18} /> : "Run pipeline"}
            </Button>
          </Box>
          <JobProgress job={job} />
        </Paper>
      ) : null}

      {job?.status === "done" ? (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle2" gutterBottom>Results</Typography>
          <JobResults job={job} baseName="microbiome" />
        </Paper>
      ) : null}
    </Box>
  );
}
