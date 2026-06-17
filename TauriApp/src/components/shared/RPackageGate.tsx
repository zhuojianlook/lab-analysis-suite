import { useEffect, useState } from "react";
import { Alert, Box, Button, LinearProgress, Stack, Typography } from "@mui/material";
import {
  checkPackages,
  installPackages,
  installStatus,
  type PackageStatus,
} from "../../api/client";
import { useRStore } from "../../store/rStore";

/** Per-tab package-check cache (session-lived). The check runs an Rscript, so
 *  re-running it on every tab switch is slow; once a tab is known good we cache
 *  it and switching back is instant. Keyed by tab + the active Rscript path. */
type GateState = { rAvailable: boolean; packages: PackageStatus[]; allOk: boolean };
const pkgCache = new Map<string, GateState>();

/** Wrap an R-backed tab's content. Renders the tab only when R is present and
 *  all its packages are installed; otherwise shows an "install required
 *  packages" gate with a binary (pak/P3M) install + progress. */
export function RPackageGate({ tab, children }: { tab: string; children: React.ReactNode }) {
  const rState = useRStore((s) => s.state);
  const cacheKey = `${tab}|${rState?.path ?? ""}`;
  const [pkgs, setPkgs] = useState<PackageStatus[] | null>(null);
  const [allOk, setAllOk] = useState(false);
  const [rAvailable, setRAvailable] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const refresh = async () => {
    setErr(null);
    try {
      const res = await checkPackages(tab);
      const st: GateState = {
        rAvailable: res.r_available,
        packages: res.packages,
        allOk: res.r_available && res.all_installed,
      };
      pkgCache.set(cacheKey, st);
      setRAvailable(st.rAvailable);
      setPkgs(st.packages);
      setAllOk(st.allOk);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    const cached = pkgCache.get(cacheKey);
    if (cached) {
      setRAvailable(cached.rAvailable);
      setPkgs(cached.packages);
      setAllOk(cached.allOk);
      if (cached.allOk) return; // trust a known-good tab → instant, no R call
    }
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey]);

  const doInstall = async () => {
    setInstalling(true);
    setErr(null);
    setProgress(0);
    setStage("starting");
    try {
      const { job_id, error } = await installPackages(tab);
      if (!job_id) {
        setErr(error || "Could not start the install.");
        return;
      }
      for (;;) {
        const s = await installStatus(job_id);
        setProgress(s.progress);
        setStage(s.stage);
        if (s.status === "done") break;
        if (s.status === "error") {
          setErr(s.error || "Install failed.");
          return;
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setInstalling(false);
    }
  };

  if (!rAvailable) {
    return (
      <Box sx={{ p: 4, textAlign: "center", color: "text.secondary" }}>
        <Typography>R is required for this tab. Install R (see the banner above), then re-open it.</Typography>
      </Box>
    );
  }
  if (allOk) return <>{children}</>;
  if (pkgs == null) {
    return (
      <Box sx={{ p: 4 }}>
        <LinearProgress />
      </Box>
    );
  }

  const missing = pkgs.filter((p) => !p.installed).map((p) => p.name);
  return (
    <Box sx={{ p: 4, maxWidth: 660, mx: "auto" }}>
      <Typography variant="h6" gutterBottom>
        R packages required
      </Typography>
      <Typography variant="body2" color="text.secondary">
        This tab needs {missing.length} R package{missing.length === 1 ? "" : "s"} that aren't installed yet:
      </Typography>
      <Typography variant="body2" sx={{ fontFamily: "monospace", my: 1, wordBreak: "break-word" }}>
        {missing.join(", ")}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        These install as prebuilt binaries (no compiler needed on Windows/macOS) via pak + Posit P3M. The first
        install can take a few minutes.
      </Typography>
      {err && (
        <Alert severity="error" sx={{ my: 2 }}>
          {err}
        </Alert>
      )}
      {installing ? (
        <Box sx={{ my: 2 }}>
          <Typography variant="caption" color="text.secondary">
            {stage || "installing…"}
          </Typography>
          <LinearProgress
            variant={progress > 0 ? "determinate" : "indeterminate"}
            value={progress * 100}
            sx={{ mt: 0.5 }}
          />
        </Box>
      ) : (
        <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
          <Button variant="contained" onClick={doInstall}>
            Install required packages
          </Button>
          <Button onClick={refresh}>Re-check</Button>
        </Stack>
      )}
    </Box>
  );
}
