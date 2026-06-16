import { useEffect, useState } from "react";
import {
  Box, Button, CircularProgress, Dialog, DialogActions, DialogContent,
  DialogTitle, Divider, LinearProgress, Link, Stack, Typography,
} from "@mui/material";
import SystemUpdateAltIcon from "@mui/icons-material/SystemUpdateAlt";
import { useUpdaterStore } from "../../store/updaterStore";
import { openExternal } from "../../api/client";

const REPO_URL = "https://github.com/zhuojianlook/lab-analysis-suite";

/** About dialog — app identity, the "Created by Zhuojian Look" credit, and the
 *  in-app updater (check / download / restart) all live here, mirroring the
 *  Multi-Panel Figure Builder. Bound to the shared updaterStore so the toolbar
 *  startup snackbars stay in sync. */
export function AboutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { status, version: updVersion, progress, error, check, install, restart } = useUpdaterStore();
  const [appVersion, setAppVersion] = useState("…");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    import("@tauri-apps/api/app")
      .then((m) => m.getVersion())
      .then((v) => { if (!cancelled) setAppVersion(v); })
      .catch(() => { if (!cancelled) setAppVersion("unknown"); });
    return () => { cancelled = true; };
  }, [open]);

  const close = () => { onClose(); useUpdaterStore.getState().dismiss(); };

  return (
    <Dialog open={open} onClose={close} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ pb: 1 }}>About</DialogTitle>
      <DialogContent>
        <Box sx={{ textAlign: "center", py: 2 }}>
          <Typography variant="h5" gutterBottom sx={{ fontWeight: 600 }}>
            Lab Analysis Suite
          </Typography>
          <Typography variant="body2" color="text.secondary" gutterBottom>
            Version {appVersion}
          </Typography>
          <Typography variant="body2" sx={{ mt: 1 }}>
            Created by <strong>Zhuojian Look</strong>
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: "block" }}>
            qPCR · xCELLigence · Bulk RNA-seq (DESeq2) · scRNA-seq · Spatial · 16S rRNA · Plate Mapper.
            Analysis in Python, every figure rendered in R / ggplot2. For the benefit of scientists.
          </Typography>
          <Link
            component="button"
            variant="caption"
            sx={{ mt: 1 }}
            onClick={() => openExternal(REPO_URL)}
          >
            {REPO_URL.replace("https://", "")}
          </Link>
        </Box>

        <Divider sx={{ my: 2 }} />

        <Box sx={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1 }}>
          <Button
            variant="outlined"
            size="small"
            startIcon={status === "checking" ? <CircularProgress size={14} /> : <SystemUpdateAltIcon />}
            disabled={status === "checking" || status === "downloading"}
            onClick={() => check(true)}
          >
            Check for updates
          </Button>

          {status === "none" && (
            <Typography variant="caption" color="text.secondary">You're up to date.</Typography>
          )}
          {status === "available" && (
            <Stack spacing={1} alignItems="center">
              <Typography variant="caption">Update {updVersion} is available.</Typography>
              <Button variant="contained" size="small" onClick={install}>Download &amp; install</Button>
            </Stack>
          )}
          {status === "downloading" && (
            <Box sx={{ width: 240 }}>
              <Typography variant="caption" color="text.secondary">Downloading {updVersion}…</Typography>
              <LinearProgress
                variant={progress > 0 ? "determinate" : "indeterminate"}
                value={progress * 100}
                sx={{ mt: 0.5 }}
              />
            </Box>
          )}
          {status === "ready" && (
            <Stack spacing={1} alignItems="center">
              <Typography variant="caption" color="success.main">Update {updVersion} installed.</Typography>
              <Button variant="contained" size="small" color="success" onClick={restart}>Restart now</Button>
            </Stack>
          )}
          {status === "error" && (
            <Typography variant="caption" color="error.main" sx={{ textAlign: "center", whiteSpace: "pre-wrap" }}>
              Update check failed: {error}
            </Typography>
          )}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={close}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
