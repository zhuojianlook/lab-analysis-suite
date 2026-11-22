import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Box, Button, LinearProgress, Stack, Typography } from "@mui/material";
import { checkPackages, installPackages, installStatus, restartEngine } from "../../api/client";
import { START_GRACE_MS } from "../../api/engineHealth";
import { useRStore } from "../../store/rStore";
import { useEngineStore } from "../../store/engineStore";
import { CHECK_SLOW_MS, gateRPath, gateView, shouldAutoCheck, type GateResult } from "./rPackageGateLogic";

/** Per-tab package-check cache (session-lived). The check runs an Rscript, so
 *  re-running it on every tab switch is slow; once a tab is known good we cache
 *  it and switching back is instant. Keyed by tab + the active Rscript path. */
const pkgCache = new Map<string, GateResult>();

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Wrap an R-backed tab's content. Renders the tab only when R is present and
 *  all its packages are installed; otherwise shows an "install required
 *  packages" gate with a binary (pak/P3M) install + progress. Never an endless
 *  loading bar: check errors are shown with Try again, slow checks are
 *  reported, and the first check waits for a healthy engine (rStore's R probe
 *  runs once the engine is up) and re-runs when the engine comes back. */
export function RPackageGate({ tab, children }: { tab: string; children: React.ReactNode }) {
  const rState = useRStore((s) => s.state);
  // Keyed on the last known Rscript path: a probe that reports none (failed,
  // or R gone) must not drop a ready result and remount the open tool.
  const rPath = useRStore((s) => gateRPath(s.lastPath, s.state?.path));
  const engine = useEngineStore((s) => s.health);
  const okSerial = useEngineStore((s) => s.okSerial);
  const notOkSince = useEngineStore((s) => s.notOkSince);
  const pollEngineNow = useEngineStore((s) => s.pollNow);
  const cacheKey = `${tab}|${rPath}`;

  const [result, setResult] = useState<GateResult | null>(() => pkgCache.get(cacheKey) ?? null);
  const [checking, setChecking] = useState(false);
  const [slow, setSlow] = useState(false);
  const [checkErr, setCheckErr] = useState<string | null>(null);
  const [triedAt, setTriedAt] = useState<number | null>(null);
  const seq = useRef(0);
  const keyRef = useRef(cacheKey);

  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState("");
  const [installErr, setInstallErr] = useState<string | null>(null);

  // A new tab + Rscript path: start from the cache (or nothing) and forget
  // any check still running for the old key.
  useEffect(() => {
    if (keyRef.current === cacheKey) return;
    keyRef.current = cacheKey;
    seq.current += 1;
    setResult(pkgCache.get(cacheKey) ?? null);
    setChecking(false);
    setSlow(false);
    setCheckErr(null);
    setTriedAt(null);
  }, [cacheKey]);

  const refresh = useCallback(async () => {
    const my = ++seq.current;
    const key = cacheKey;
    setChecking(true);
    setSlow(false);
    setCheckErr(null);
    setTriedAt(useEngineStore.getState().okSerial);
    const slowTimer = setTimeout(() => {
      if (seq.current === my) setSlow(true);
    }, CHECK_SLOW_MS);
    try {
      const res = await checkPackages(tab);
      // A good answer for this key is used even if a newer check (Try again
      // after "taking unusually long") is still running; that one is dropped.
      if (keyRef.current !== key) return;
      const st: GateResult = {
        rAvailable: res.r_available,
        packages: res.packages,
        allOk: res.r_available && res.all_installed,
      };
      pkgCache.set(key, st);
      seq.current += 1;
      setResult(st);
      setChecking(false);
      setSlow(false);
    } catch (e) {
      if (seq.current !== my) return;
      setCheckErr(errText(e));
      setChecking(false);
      setSlow(false);
    } finally {
      clearTimeout(slowTimer);
    }
  }, [tab, cacheKey]);

  const engineOk = engine.state === "ok";
  const rKnown = rState != null;
  useEffect(() => {
    if (shouldAutoCheck({ engineOk, rKnown, checking, result, error: checkErr, okSerial, triedAtSerial: triedAt })) {
      void refresh();
    }
  }, [engineOk, rKnown, checking, result, checkErr, okSerial, triedAt, refresh]);

  const doInstall = async () => {
    setInstalling(true);
    setInstallErr(null);
    setProgress(0);
    setStage("starting");
    try {
      const { job_id, error } = await installPackages(tab);
      if (!job_id) {
        setInstallErr(error || "Could not start the install.");
        return;
      }
      for (;;) {
        const s = await installStatus(job_id);
        setProgress(s.progress);
        setStage(s.stage);
        if (s.status === "done") break;
        if (s.status === "error") {
          setInstallErr(s.error || "Install failed.");
          return;
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
      await refresh();
    } catch (e) {
      setInstallErr(errText(e));
    } finally {
      setInstalling(false);
    }
  };

  // "Starting" for longer than usual: re-rendered by the engine poll (every
  // 1 s while starting), so this flips without a timer of its own.
  const engineSlowStart = notOkSince != null && Date.now() - notOkSince >= START_GRACE_MS;
  const view = gateView({ engineState: engine.state, engineSlowStart, rKnown, result, checking, slow, error: checkErr });

  // Engine problem: if the app gave up restarting it, start it again; then
  // look at its health now (that also re-runs this gate's check when it is up).
  const retryEngine = async () => {
    if (engine.state === "down") await restartEngine();
    pollEngineNow();
  };

  const tryAgain = (
    // With the engine not up, a package check cannot work: get the engine
    // going (the check then re-runs by itself once it is up).
    <Button variant="outlined" size="small" onClick={() => void (engineOk ? refresh() : retryEngine())} disabled={checking}>
      Try again
    </Button>
  );
  const waitBox = (text: string) => (
    <Box sx={{ p: 4, maxWidth: 660, mx: "auto" }}>
      <Typography variant="body2" color="text.secondary" gutterBottom>
        {text}
      </Typography>
      <LinearProgress />
    </Box>
  );

  switch (view.kind) {
    case "ready":
      return <>{children}</>;
    case "waiting-engine":
      return waitBox(view.restarting ? "The analysis engine stopped; restarting it…" : "Waiting for the analysis engine to start…");
    case "engine-slow":
      return (
        <Box sx={{ p: 4, maxWidth: 660, mx: "auto" }}>
          <Alert severity="warning" sx={{ mb: 2, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            The analysis engine is taking unusually long to start. It is restarted automatically if it hangs; this
            tab opens by itself when it is ready.
          </Alert>
          <Button variant="outlined" size="small" onClick={() => void retryEngine()}>
            Try again
          </Button>
        </Box>
      );
    case "waiting-r":
      return waitBox("Looking for R…");
    case "checking":
      return waitBox("Checking this tab's R packages…");
    case "slow":
      return (
        <Box sx={{ p: 4, maxWidth: 660, mx: "auto" }}>
          <Alert severity="warning" action={<Button color="inherit" size="small" onClick={() => void refresh()}>Try again</Button>}>
            Checking R packages is taking unusually long. It is still running; you can wait or try again.
          </Alert>
          <LinearProgress sx={{ mt: 2 }} />
        </Box>
      );
    case "error":
      return (
        <Box sx={{ p: 4, maxWidth: 660, mx: "auto" }}>
          <Alert severity="error" sx={{ mb: 2, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            Couldn't check this tab's R packages: {view.message}
            {!engineOk && "\nThe analysis engine is not ready; this is retried automatically when it is back."}
          </Alert>
          {tryAgain}
        </Box>
      );
    case "engine-problem":
      return (
        <Box sx={{ p: 4, maxWidth: 660, mx: "auto" }}>
          <Alert severity="error" sx={{ mb: 2, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {engine.state === "foreign" ? "The analysis engine can't be reached: " : "The analysis engine is down. "}
            {engine.detail ?? ""}
            {"\nThis tab opens by itself when the engine is back."}
          </Alert>
          <Button variant="outlined" size="small" onClick={() => void retryEngine()}>
            Try again
          </Button>
        </Box>
      );
    case "no-r":
      return (
        <Box sx={{ p: 4, textAlign: "center", color: "text.secondary" }}>
          <Typography gutterBottom>R is required for this tab. Install R (see the banner above), then re-open it.</Typography>
          <Button size="small" onClick={() => void refresh()} disabled={checking && !slow}>
            {checking && !slow ? "Checking…" : "Re-check"}
          </Button>
        </Box>
      );
    case "missing": {
      const missing = view.missing;
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
          {(installErr || checkErr) && (
            <Alert severity="error" sx={{ my: 2 }}>
              {installErr || `Re-check failed: ${checkErr}`}
            </Alert>
          )}
          {slow && (
            <Alert severity="warning" sx={{ my: 2 }}>
              Checking R packages is taking unusually long.
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
              <Button variant="contained" onClick={doInstall} disabled={checking}>
                Install required packages
              </Button>
              <Button onClick={() => void refresh()} disabled={checking && !slow}>
                {checking && !slow ? "Checking…" : "Re-check"}
              </Button>
            </Stack>
          )}
        </Box>
      );
    }
  }
}
