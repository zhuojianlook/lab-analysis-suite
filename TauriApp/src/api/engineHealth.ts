/* ──────────────────────────────────────────────────────────
   Engine health: pure helpers (no imports, unit-tested).

   Inside the app the Rust command `engine_health` decides the state: it
   checks that the process answering on the engine's port is this launch's
   engine (per-launch token, see src-tauri/src/engine.rs). Another program
   answering there — e.g. another app's engine that also says
   {"status":"ok"} — is "foreign", never "ok".
   ────────────────────────────────────────────────────────── */

/** "checking": not asked yet. */
export type EngineState = "checking" | "starting" | "ok" | "restarting" | "foreign" | "down";

export interface EngineHealth {
  state: EngineState;
  /** Human-readable reason (never contains the launch token). */
  detail?: string;
  port?: number;
  /** Changes every time the app (re)starts the engine. */
  generation?: number;
}

/** Is `next` a fresh "ok" after `prev` — the engine came up, came back, or
 *  was restarted between two polls (new generation)? Anything a gate or the
 *  R probe learned from the previous engine run may be stale then. */
export function isFreshOk(prev: EngineHealth, next: EngineHealth): boolean {
  if (next.state !== "ok") return false;
  if (prev.state !== "ok") return true;
  return next.generation !== undefined && prev.generation !== undefined && next.generation !== prev.generation;
}

/** Did the app restart its engine since it was last seen ok? `lastOkGen`:
 *  the generation at the previous fresh "ok" (undefined before the first).
 *  A first start is not a restart; a browser preview has no generations. */
export function wasRestarted(lastOkGen: number | undefined, next: EngineHealth): boolean {
  return next.state === "ok" && lastOkGen !== undefined && next.generation !== undefined && next.generation !== lastOkGen;
}

/** `app` value this app's engine reports in GET /api/health. */
export const ENGINE_APP_ID = "lab-analysis-suite";

/** A starting engine that has not answered for this long is shown as down. */
export const START_GRACE_MS = 120_000;

/** Browser preview only (no Rust, no token): judge a raw /api/health body by
 *  its status and app name. */
export function judgeHealthBody(text: string): EngineHealth {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { state: "foreign", detail: "Another program is answering on the engine's port (its health answer is not JSON)." };
  }
  const d = (data ?? {}) as { status?: unknown; app?: unknown };
  if (d.status === "ok" && d.app === ENGINE_APP_ID) return { state: "ok" };
  return {
    state: "foreign",
    detail: "Another program is answering on the engine's port (it does not identify as Lab Analysis Suite's engine).",
  };
}

/** How long until the next health poll. Once the engine is up it is still
 *  watched (every 10 s) so the indicators turn red when it goes away. */
export function nextPollDelayMs(state: EngineState, notOkForMs: number): number {
  switch (state) {
    case "ok":
      return 10_000;
    case "checking":
    case "starting":
    case "restarting":
      return 1_000;
    default:
      return notOkForMs < START_GRACE_MS ? 2_000 : 5_000;
  }
}

export interface EngineStatusLine {
  label: string;
  tone: "ok" | "warn" | "error" | "pending";
  detail?: string;
}

/** The nav rail's engine indicator. `stderr`: the engine's captured startup
 *  output (shown when it is down). */
export function engineStatusLine(h: EngineHealth, notOkForMs: number, stderr: string): EngineStatusLine {
  switch (h.state) {
    case "ok":
      return { label: "Engine ready", tone: "ok" };
    case "checking":
    case "starting":
      if (notOkForMs < START_GRACE_MS) return { label: "Engine starting…", tone: "pending" };
      // Still starting (a first start can be slow); the app restarts it if it
      // hangs, and reports "down" if that does not help.
      return {
        label: "Engine slow to start",
        tone: "warn",
        detail: stderr || h.detail || "The analysis engine has not answered yet. It is restarted automatically if it hangs.",
      };
    case "restarting":
      return { label: "Engine restarting…", tone: "pending", detail: h.detail };
    case "foreign":
      return { label: "Engine port taken", tone: "error", detail: h.detail || "Another program is answering on the engine's port." };
    case "down":
    default:
      return { label: "Engine down", tone: "error", detail: [h.detail, stderr].filter(Boolean).join("\n") || "The analysis engine isn't answering." };
  }
}
