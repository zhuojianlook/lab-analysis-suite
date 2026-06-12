import { Stack, Typography } from "@mui/material";
import type { RJobStatus } from "../../api/client";
import { parseCsv } from "../../api/client";
import { PlotResult } from "./PlotResult";
import { RecordTable } from "./RecordTable";

/** Render a finished async R-job: its tables (CSV) + plots (base64 PNG). */
export function JobResults({ job, baseName }: { job: RJobStatus | null; baseName: string }) {
  if (!job || job.status !== "done") return null;
  return (
    <Stack spacing={2} sx={{ mt: 1 }}>
      {job.tables.map((t) => (
        <RecordTable key={t.name} rows={parseCsv(t.csv)} title={t.name} downloadName={`${t.name}.csv`} />
      ))}
      <Typography variant="subtitle2">Figures</Typography>
      <PlotResult result={{ success: true, stdout: "", stderr: "", plots: job.plots, tables: [] }} baseName={baseName} />
    </Stack>
  );
}
