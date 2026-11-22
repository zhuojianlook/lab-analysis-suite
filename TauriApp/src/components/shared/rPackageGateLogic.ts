/* ──────────────────────────────────────────────────────────
   What the R package gate shows and when it checks (pure, unit-tested).

   The gate must never show an endless loading bar: a failed check shows its
   error with Try again, a check that takes unusually long says so, and the
   first check waits until the engine is healthy (and retries by itself when
   the engine comes back after an error).
   ────────────────────────────────────────────────────────── */

import type { EngineState } from "../../api/engineHealth";

export interface GatePackage {
  name: string;
  installed: boolean;
  version: string;
}

/** The result of one package check for a tab. */
export interface GateResult {
  rAvailable: boolean;
  packages: GatePackage[];
  allOk: boolean;
}

/** A check slower than this is reported (it keeps running). */
export const CHECK_SLOW_MS = 90_000;

export interface GateSnapshot {
  engineState: EngineState;
  /** The engine has been starting for longer than usual (START_GRACE_MS). */
  engineSlowStart?: boolean;
  /** The R probe (rStore) has answered since the engine came up. */
  rKnown: boolean;
  /** Last good check for this tab + Rscript path (or the session cache). */
  result: GateResult | null;
  checking: boolean;
  /** The running check has passed CHECK_SLOW_MS. */
  slow: boolean;
  /** Why the last check failed (cleared when a new one starts). */
  error: string | null;
}

export type GateView =
  | { kind: "ready" }
  | { kind: "no-r" }
  | { kind: "missing"; missing: string[] }
  | { kind: "checking" }
  | { kind: "slow" }
  | { kind: "error"; message: string }
  /** Engine starting / restarting: a truthful wait. */
  | { kind: "waiting-engine"; restarting: boolean }
  /** Engine down or another program on its port: an error, not a wait. */
  | { kind: "engine-problem" }
  /** Starting for unusually long: said so, with Try again (the app restarts
   *  an engine that hangs while starting, engine.rs `Liveness`). */
  | { kind: "engine-slow" }
  | { kind: "waiting-r" };

export function gateView(s: GateSnapshot): GateView {
  if (s.result?.allOk) return { kind: "ready" };
  // A known result stays visible (with its Install / Re-check buttons) while
  // a re-check runs or after one failed.
  if (s.result && !s.result.rAvailable) return { kind: "no-r" };
  if (s.result) return { kind: "missing", missing: s.result.packages.filter((p) => !p.installed).map((p) => p.name) };
  if (s.checking) return { kind: s.slow ? "slow" : "checking" };
  if (s.error) return { kind: "error", message: s.error };
  if (s.engineState === "down" || s.engineState === "foreign") return { kind: "engine-problem" };
  if ((s.engineState === "starting" || s.engineState === "checking") && s.engineSlowStart) return { kind: "engine-slow" };
  if (s.engineState !== "ok") return { kind: "waiting-engine", restarting: s.engineState === "restarting" };
  if (!s.rKnown) return { kind: "waiting-r" };
  return { kind: "checking" }; // about to start (shouldAutoCheck is true)
}

/** The Rscript path the gate keys its result on. A probe that reports no
 *  path (R not found, or a failed probe right after an engine restart) keeps
 *  the last known one, so tools that were open stay open; only a different,
 *  non-empty path (the user picked another R) starts a new check. */
export function gateRPath(lastKnown: string, reported: string | null | undefined): string {
  return reported ? reported : lastKnown;
}

export interface AutoCheckInput {
  engineOk: boolean;
  rKnown: boolean;
  checking: boolean;
  result: GateResult | null;
  error: string | null;
  /** useEngineStore okSerial now. */
  okSerial: number;
  /** okSerial when the last check for this key started; null = never. */
  triedAtSerial: number | null;
}

/** Start a check without the user asking? Only with a healthy engine and a
 *  known R; once per tab + Rscript path; and again after a failed check once
 *  the engine has come back (okSerial moved on). */
export function shouldAutoCheck(s: AutoCheckInput): boolean {
  if (!s.engineOk || !s.rKnown || s.checking) return false;
  if (s.result?.allOk) return false;
  if (s.triedAtSerial === null) return true;
  if (s.error !== null && s.triedAtSerial !== s.okSerial) return true;
  return false;
}
