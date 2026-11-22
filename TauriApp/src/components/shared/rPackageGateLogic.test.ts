import { describe, expect, it } from "vitest";
import { gateRPath, gateView, shouldAutoCheck, type GateResult, type GateSnapshot } from "./rPackageGateLogic";

const ok: GateResult = { rAvailable: true, allOk: true, packages: [{ name: "ggplot2", installed: true, version: "3" }] };
const missing: GateResult = {
  rAvailable: true,
  allOk: false,
  packages: [
    { name: "ggplot2", installed: true, version: "3" },
    { name: "DESeq2", installed: false, version: "" },
  ],
};
const noR: GateResult = { rAvailable: false, allOk: false, packages: [] };

const snap = (over: Partial<GateSnapshot>): GateSnapshot => ({
  engineState: "ok",
  rKnown: true,
  result: null,
  checking: false,
  slow: false,
  error: null,
  ...over,
});

describe("gateView", () => {
  it("shows the tab once everything is installed, whatever the engine does", () => {
    expect(gateView(snap({ result: ok }))).toEqual({ kind: "ready" });
    expect(gateView(snap({ result: ok, engineState: "down" }))).toEqual({ kind: "ready" });
  });

  it("the reported bug: a failed check (404 from another app's engine) is an error, not an endless bar", () => {
    const v = gateView(snap({ error: "API error: Not Found" }));
    expect(v).toEqual({ kind: "error", message: "API error: Not Found" });
  });

  it("another program on the engine's port, or the engine down, is an error, not a wait", () => {
    expect(gateView(snap({ engineState: "foreign", rKnown: true }))).toEqual({ kind: "engine-problem" });
    expect(gateView(snap({ engineState: "down", rKnown: false }))).toEqual({ kind: "engine-problem" });
  });

  it("waits truthfully while the engine starts or restarts, then for R", () => {
    expect(gateView(snap({ engineState: "checking", rKnown: false }))).toEqual({ kind: "waiting-engine", restarting: false });
    expect(gateView(snap({ engineState: "starting", rKnown: false }))).toEqual({ kind: "waiting-engine", restarting: false });
    expect(gateView(snap({ engineState: "restarting" }))).toEqual({ kind: "waiting-engine", restarting: true });
    expect(gateView(snap({ rKnown: false }))).toEqual({ kind: "waiting-r" });
  });

  it("reports a slow check", () => {
    expect(gateView(snap({ checking: true }))).toEqual({ kind: "checking" });
    expect(gateView(snap({ checking: true, slow: true }))).toEqual({ kind: "slow" });
  });

  it("keeps a known result visible during and after a re-check", () => {
    const want = { kind: "missing", missing: ["DESeq2"] };
    expect(gateView(snap({ result: missing }))).toEqual(want);
    expect(gateView(snap({ result: missing, checking: true }))).toEqual(want);
    expect(gateView(snap({ result: missing, error: "boom" }))).toEqual(want);
    expect(gateView(snap({ result: noR }))).toEqual({ kind: "no-r" });
  });
});

describe("shouldAutoCheck", () => {
  const base = { engineOk: true, rKnown: true, checking: false, result: null, error: null, okSerial: 1, triedAtSerial: null };

  it("never runs the first check before the engine is healthy and R is known", () => {
    expect(shouldAutoCheck({ ...base, engineOk: false })).toBe(false);
    expect(shouldAutoCheck({ ...base, rKnown: false })).toBe(false);
    expect(shouldAutoCheck(base)).toBe(true);
  });

  it("checks once per key, not while a check runs, not when known good", () => {
    expect(shouldAutoCheck({ ...base, checking: true })).toBe(false);
    expect(shouldAutoCheck({ ...base, triedAtSerial: 1 })).toBe(false);
    expect(shouldAutoCheck({ ...base, triedAtSerial: 1, result: missing })).toBe(false);
    expect(shouldAutoCheck({ ...base, result: ok })).toBe(false);
  });

  it("retries a failed check when the engine comes back, and only then", () => {
    const failed = { ...base, error: "The analysis engine isn't answering.", triedAtSerial: 1 };
    expect(shouldAutoCheck(failed)).toBe(false); // same engine run: wait for Try again
    expect(shouldAutoCheck({ ...failed, engineOk: false, okSerial: 1 })).toBe(false); // still down
    expect(shouldAutoCheck({ ...failed, okSerial: 2 })).toBe(true); // back up
  });
});

describe("gateView: an engine that is slow to start", () => {
  it("says so (with Try again) instead of an endless wait", () => {
    expect(gateView(snap({ engineState: "starting" }))).toEqual({ kind: "waiting-engine", restarting: false });
    expect(gateView(snap({ engineState: "starting", engineSlowStart: true }))).toEqual({ kind: "engine-slow" });
    expect(gateView(snap({ engineState: "checking", engineSlowStart: true }))).toEqual({ kind: "engine-slow" });
    // Restarting is bounded by the app's backoff; it stays a truthful wait.
    expect(gateView(snap({ engineState: "restarting", engineSlowStart: true }))).toEqual({
      kind: "waiting-engine",
      restarting: true,
    });
    // A tool that was open stays open.
    expect(gateView(snap({ engineState: "starting", engineSlowStart: true, result: ok }))).toEqual({ kind: "ready" });
  });
});

describe("gateRPath", () => {
  it("keeps the last known Rscript path when a probe reports none", () => {
    expect(gateRPath("", undefined)).toBe("");
    expect(gateRPath("", "/usr/local/bin/Rscript")).toBe("/usr/local/bin/Rscript");
    // A failed probe after an engine restart reports "": keep the key (and the open tool).
    expect(gateRPath("/usr/local/bin/Rscript", "")).toBe("/usr/local/bin/Rscript");
    expect(gateRPath("/usr/local/bin/Rscript", null)).toBe("/usr/local/bin/Rscript");
    // Another R picked: a new key, so the packages are checked again.
    expect(gateRPath("/usr/local/bin/Rscript", "/opt/R/bin/Rscript")).toBe("/opt/R/bin/Rscript");
  });
});
