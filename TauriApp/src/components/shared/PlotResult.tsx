import { Alert, Box, Button, Stack } from "@mui/material";
import DownloadIcon from "@mui/icons-material/Download";
import CollectionsIcon from "@mui/icons-material/Collections";
import { saveDownload } from "../../api/client";
import { useFiguresStore } from "../../store/figuresStore";
import type { RunRResponse } from "../../api/types";

/** Render the plots (base64 PNG) returned by the R bridge, with per-plot
 *  download and an error panel when the R run failed. */
export function PlotResult({ result, baseName = "plot" }: { result: RunRResponse | null; baseName?: string }) {
  if (!result) return null;
  if (!result.success) {
    return (
      <Alert severity="error" sx={{ mt: 1, whiteSpace: "pre-wrap", fontFamily: "monospace", fontSize: 12 }}>
        {result.stderr || "R run failed."}
      </Alert>
    );
  }
  if (!result.plots || result.plots.length === 0) {
    return <Alert severity="info" sx={{ mt: 1 }}>R ran successfully but produced no plot.</Alert>;
  }
  const exports = result.exports ?? [];
  return (
    <Stack spacing={2} sx={{ mt: 1 }}>
      {result.plots.map((b64, i) => {
        const exp = exports[i];
        return (
          <Box key={i}>
            <Box
              component="img"
              src={`data:image/png;base64,${b64}`}
              alt={`${baseName} ${i + 1}`}
              sx={{ maxWidth: "100%", border: "1px solid", borderColor: "divider", borderRadius: 1, background: "#fff" }}
            />
            <Box sx={{ mt: 0.5, display: "flex", gap: 1, flexWrap: "wrap" }}>
              <Button
                size="small"
                startIcon={<DownloadIcon />}
                onClick={() => saveDownload(`${baseName}_${i + 1}.png`, b64, "image/png")}
              >
                Download PNG
              </Button>
              <Button
                size="small"
                startIcon={<CollectionsIcon />}
                onClick={() => useFiguresStore.getState().add(b64, `${baseName}_${i + 1}`, baseName)}
              >
                Send to Figures
              </Button>
              {exp && (
                <Button
                  size="small"
                  startIcon={<DownloadIcon />}
                  onClick={() =>
                    saveDownload(
                      `${baseName}_${i + 1}.${exp.format === "tiff" ? "tiff" : "png"}`,
                      exp.b64,
                      exp.format === "tiff" ? "image/tiff" : "image/png",
                    )
                  }
                >
                  Download {exp.format === "tiff" ? "TIFF" : "PNG"} (export)
                </Button>
              )}
            </Box>
          </Box>
        );
      })}
    </Stack>
  );
}
