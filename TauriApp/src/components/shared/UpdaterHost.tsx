import { useEffect } from "react";
import { Alert, Box, Button, LinearProgress, Snackbar, Typography } from "@mui/material";
import { useUpdaterStore } from "../../store/updaterStore";

/** Mounted once at the app root. Runs a silent update check on startup and
 *  renders the update-available / downloading / ready / up-to-date prompts.
 *  Manual checks are triggered from the toolbar (updaterStore.check(true)). */
export function UpdaterHost() {
  const { status, version, progress, error, lastManual, check, install, restart, dismiss } = useUpdaterStore();

  // One silent check shortly after startup (let the sidecar/UI settle first).
  useEffect(() => {
    const t = setTimeout(() => check(false), 4000);
    return () => clearTimeout(t);
  }, [check]);

  // Update available → offer install.
  if (status === "available") {
    return (
      <Snackbar open anchorOrigin={{ vertical: "bottom", horizontal: "right" }}>
        <Alert
          severity="info"
          variant="filled"
          action={
            <>
              <Button color="inherit" size="small" onClick={install}>Install</Button>
              <Button color="inherit" size="small" onClick={dismiss}>Later</Button>
            </>
          }
        >
          Update {version} is available.
        </Alert>
      </Snackbar>
    );
  }

  if (status === "downloading") {
    return (
      <Snackbar open anchorOrigin={{ vertical: "bottom", horizontal: "right" }}>
        <Alert severity="info" variant="filled" sx={{ minWidth: 280 }}>
          <Typography variant="body2">Downloading update {version}…</Typography>
          <Box sx={{ mt: 0.5 }}>
            <LinearProgress variant={progress > 0 ? "determinate" : "indeterminate"} value={progress * 100} />
          </Box>
        </Alert>
      </Snackbar>
    );
  }

  if (status === "ready") {
    return (
      <Snackbar open anchorOrigin={{ vertical: "bottom", horizontal: "right" }}>
        <Alert
          severity="success"
          variant="filled"
          action={<Button color="inherit" size="small" onClick={restart}>Restart now</Button>}
        >
          Update {version} installed.
        </Alert>
      </Snackbar>
    );
  }

  // Manual-check feedback only (don't nag on the silent startup check).
  if (status === "none" && lastManual) {
    return (
      <Snackbar open autoHideDuration={3000} onClose={dismiss} anchorOrigin={{ vertical: "bottom", horizontal: "right" }}>
        <Alert severity="success" variant="filled" onClose={dismiss}>You're up to date.</Alert>
      </Snackbar>
    );
  }
  if (status === "error" && lastManual) {
    return (
      <Snackbar open autoHideDuration={6000} onClose={dismiss} anchorOrigin={{ vertical: "bottom", horizontal: "right" }}>
        <Alert severity="error" variant="filled" onClose={dismiss}>Update check failed: {error}</Alert>
      </Snackbar>
    );
  }
  return null;
}
