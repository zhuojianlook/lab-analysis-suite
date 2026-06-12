import { Box, LinearProgress, Typography } from "@mui/material";
import type { RJobStatus } from "../../api/client";

/** Inline progress for a running async R job (stage + bar + log tail). */
export function JobProgress({ job }: { job: RJobStatus | null }) {
  if (!job || (job.status !== "running" && job.status !== "queued")) return null;
  return (
    <Box sx={{ my: 2 }}>
      <Typography variant="caption" color="text.secondary">
        {job.stage || "running…"}
      </Typography>
      <LinearProgress
        variant={job.progress > 0 ? "determinate" : "indeterminate"}
        value={job.progress * 100}
        sx={{ mt: 0.5 }}
      />
      {job.tail && (
        <Box
          component="pre"
          sx={{ mt: 1, p: 1, maxHeight: 120, overflow: "auto", bgcolor: "#1c1c1e", borderRadius: 1, fontSize: 11, color: "text.secondary" }}
        >
          {job.tail.split("\n").slice(-8).join("\n")}
        </Box>
      )}
    </Box>
  );
}
