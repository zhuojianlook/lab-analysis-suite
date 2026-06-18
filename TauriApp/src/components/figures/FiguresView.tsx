import { Alert, Box, Button, IconButton, Paper, Stack, Tooltip, Typography } from "@mui/material";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import DownloadIcon from "@mui/icons-material/Download";
import { useFiguresStore } from "../../store/figuresStore";
import { saveDownload } from "../../api/client";

/** Collected figures sent from the analysis tabs. A staging area for the
 *  planned Multi-Panel Figure Builder export. */
export function FiguresView() {
  const figures = useFiguresStore((s) => s.figures);
  const remove = useFiguresStore((s) => s.remove);
  const clear = useFiguresStore((s) => s.clear);

  return (
    <Box sx={{ p: 2, display: "flex", flexDirection: "column", gap: 2 }}>
      <Stack direction="row" alignItems="center" spacing={2}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          Figures ({figures.length})
        </Typography>
        <Box sx={{ flexGrow: 1 }} />
        <Button size="small" onClick={clear} disabled={figures.length === 0}>
          Clear all
        </Button>
      </Stack>

      <Alert severity="info" variant="outlined">
        Use “Send to Figures” under any generated plot to collect it here. Figures are kept for this
        session — a future release will export them directly into the Multi-Panel Figure Builder.
      </Alert>

      {figures.length === 0 ? (
        <Typography variant="body2" color="text.secondary">No figures collected yet.</Typography>
      ) : (
        <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 2 }}>
          {figures.map((f) => (
            <Paper key={f.id} variant="outlined" sx={{ p: 1 }}>
              <Box
                component="img"
                src={`data:image/png;base64,${f.png}`}
                alt={f.title}
                sx={{ width: "100%", borderRadius: 1, background: "#fff", border: "1px solid", borderColor: "divider" }}
              />
              <Stack direction="row" alignItems="center" spacing={0.5} sx={{ mt: 0.5 }}>
                <Typography variant="caption" sx={{ flexGrow: 1 }} noWrap title={`${f.title} · ${f.source}`}>
                  {f.title}
                </Typography>
                <Tooltip title="Download PNG">
                  <IconButton size="small" onClick={() => saveDownload(`${f.title}.png`, f.png, "image/png")}>
                    <DownloadIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
                <Tooltip title="Remove">
                  <IconButton size="small" color="error" onClick={() => remove(f.id)}>
                    <DeleteOutlineIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Stack>
            </Paper>
          ))}
        </Box>
      )}
    </Box>
  );
}
