/* Test helpers for the phase 3 engine (presence.ts): notes, records, inputs. Tests only. */
import { type NoteJson, type NoteRecord, type PresenceInput, type PresenceObs } from "../contract";
import { emptyObs, observe } from "../presence";

export const T0 = Date.UTC(2026, 10, 22, 10, 0, 0);
export const S = 1000;
export const MIN = 60 * S;
export const H = 60 * MIN;
export const iso = (ms: number): string => new Date(ms).toISOString();

export const ME = { deviceId: "d-me-0000", userName: "Zhuo", sessionId: "s-me" };

/** Another computer's note (idle, on r-1, written at T0 by a right clock). */
export function note(over: Partial<NoteJson> = {}): NoteJson {
  return {
    format: "lasgraph-presence", v: 1, analysis_id: "a-1", document_name: "Dose response.lag",
    device_id: "d-alice-9f3c", session_id: "s-alice", device_name: "Office iMac", user_name: "Alice",
    state: "idle", head: "r-1", base_revision: null, epoch: 0, seq: 1, supersedes: null,
    updated_at: iso(T0), request_to: null, handover_to: null, features: 2, ...over,
  };
}

/** The same computer, editing version `base` (default r-1) in epoch 1. */
export const editing = (over: Partial<NoteJson> = {}): NoteJson =>
  note({ state: "editing", base_revision: over.base_revision ?? over.head ?? "r-1", epoch: 1, ...over });

export const bob = (over: Partial<NoteJson> = {}): NoteJson =>
  note({ device_id: "d-bob-1a2b", session_id: "s-bob", device_name: "Lab MacBook", user_name: "Bob", ...over });

export function record(n: NoteJson, over: Partial<NoteRecord> = {}): NoteRecord {
  return {
    file: `/data/Dose response (in use on ${n.device_name}, x).laguse`, size: 600, mtime: T0, sha: `sha-${n.device_id}-${n.seq}`,
    unchangedSince: T0, note: n, applies: true, orphan: false, own: false, ...over,
  };
}

export const KNOWN = new Set(["r-0", "r-1"]);

export function input(notes: readonly NoteJson[], obs: PresenceObs, over: Partial<PresenceInput> = {}): PresenceInput {
  return {
    me: { deviceId: ME.deviceId, userName: ME.userName }, now: T0, diskHead: "r-1", knows: (id) => KNOWN.has(id),
    dirty: false, holding: false, myEpoch: 0, resuming: false, overrides: [], notes, obs, ...over,
  };
}

/** What this computer has observed after one listing of `notes` at `at` (first sight of each). */
export const look = (notes: readonly NoteJson[], at = T0, knows: (id: string) => boolean = (id) => KNOWN.has(id)): PresenceObs =>
  observe(emptyObs(), notes, at, knows);
