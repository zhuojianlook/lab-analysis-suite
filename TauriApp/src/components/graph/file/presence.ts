/* Who is editing: the pure engine of phase 3 (phase3-contract.md §1, §2).

   A "note" is the small ".laguse" file a computer keeps beside an analysis while it has it open
   (the plan's "beacon"). This module reads and writes the note's text, makes its file name, decides
   which notes are about which document, and — from the notes and from what this computer has
   observed of them on ITS OWN clock — decides what a tab is: editable, read-only, waiting for a newer
   version, information only, both editing, or resuming after a sleep.

   No I/O, no clock, no randomness, no store access; synchronous. Every time is a number the caller
   passes (this computer's clock, ms). A note's `updated_at` (the other computer's clock) is read only
   for the first-sight rule and as the last tie-break between two copies of one device's note — lines
   that read it carry the marker "clock-ok" (checked by presence.test.ts). Nothing here compares the
   clocks of two machines. */

import {
  FEATURES_P3,
  LIMITS_P3,
  NOTE_FIRST_LINE,
  NOTE_FORMAT,
  NOTE_VERSION,
  type Freshness,
  type NoteJson,
  type NoteObs,
  type NoteRecord,
  type NoteTarget,
  type PeerView,
  type PresenceApi,
  type PresenceDecision,
  type PresenceInput,
  type PresenceObs,
  type RemoveNoteArgs,
  type ShareMode,
  type ShareWhy,
  type TabMode,
} from "./contract";
import { GRAPH_EXT, PRESENCE_EXT, type Manifest } from "./format";

// ── small helpers ────────────────────────────────────────────────────────────

/** Plain code-unit order (never locale order: the same answer on every computer). */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** UTF-8 length of a string (a lone surrogate counts 3, as TextEncoder writes U+FFFD for it). */
export function utf8Length(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
}

/** A record's own entry (never one inherited from Object.prototype: ids come from files). */
const own = <T>(rec: Readonly<Record<string, T>>, k: string): T | undefined =>
  Object.prototype.hasOwnProperty.call(rec, k) ? rec[k] : undefined;

/** Set a record's own entry (also for a key such as "__proto__"). */
const put = <T>(rec: Record<string, T>, k: string, v: T): void => {
  Object.defineProperty(rec, k, { value: v, enumerable: true, writable: true, configurable: true });
};

const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "";
const countable = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";

const sameTarget = (t: NoteTarget, deviceId: string, epoch: number): boolean => t.device_id === deviceId && t.epoch === epoch;
const names = (list: readonly NoteTarget[] | null | undefined, deviceId: string, epoch: number): boolean =>
  !!list && list.some((t) => sameTarget(t, deviceId, epoch));

/** ms from `since` to `now` on this computer's clock; a negative span (the clock went backwards and no
 *  sleep gap was noted) counts as "long ago", so a wrong clock can only end a wait or a read-only sooner. */
const elapsed = (now: number, since: number): number => (now < since ? Number.POSITIVE_INFINITY : now - since);

// ── 1.1 The note's text ──────────────────────────────────────────────────────

/** The note object with its keys in NoteJson order (unknown keys left out). */
function ordered(n: NoteJson): NoteJson {
  return {
    format: n.format,
    v: n.v,
    analysis_id: n.analysis_id,
    document_name: n.document_name,
    device_id: n.device_id,
    session_id: n.session_id,
    device_name: n.device_name,
    user_name: n.user_name,
    state: n.state,
    head: n.head,
    base_revision: n.base_revision,
    epoch: n.epoch,
    seq: n.seq,
    supersedes: n.supersedes === null ? null : n.supersedes.map((t) => ({ device_id: t.device_id, epoch: t.epoch })),
    updated_at: n.updated_at, // clock-ok: format (written as given)
    request_to: n.request_to,
    handover_to: n.handover_to,
    features: n.features,
  };
}

export function noteText(note: NoteJson): string {
  return `${NOTE_FIRST_LINE}\n${JSON.stringify(ordered(note), null, 1)}\n`;
}

function parseSupersedes(v: unknown): NoteTarget[] | null {
  const list = Array.isArray(v) ? v : isObj(v) ? [v] : [];
  const out: NoteTarget[] = [];
  for (const t of list) {
    if (isObj(t) && typeof t.device_id === "string" && typeof t.epoch === "number" && Number.isFinite(t.epoch)) {
      out.push({ device_id: t.device_id, epoch: t.epoch });
    }
  }
  return out.length ? out : null;
}

export function parseNote(text: string): NoteJson | null {
  if (typeof text !== "string" || utf8Length(text) > LIMITS_P3.noteMaxBytes) return null;
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const a = body.indexOf("{");
  const b = body.lastIndexOf("}");
  if (a < 0 || b < a) return null;
  let o: unknown;
  try {
    o = JSON.parse(body.slice(a, b + 1));
  } catch {
    return null;
  }
  if (!isObj(o)) return null;
  if (o.format !== NOTE_FORMAT || o.v !== NOTE_VERSION) return null;
  if (!nonEmpty(o.analysis_id) || !nonEmpty(o.document_name) || !nonEmpty(o.device_id) || !nonEmpty(o.session_id)) return null;
  if (typeof o.device_name !== "string" || typeof o.user_name !== "string" || typeof o.updated_at !== "string") return null; // clock-ok: format
  if (!countable(o.epoch) || !countable(o.seq)) return null;
  // head / base_revision: a string or null; missing counts as null (as the Rust reader does).
  const head = o.head === undefined ? null : o.head;
  const baseRevision = o.base_revision === undefined ? null : o.base_revision;
  if (!strOrNull(head) || !strOrNull(baseRevision)) return null;
  return {
    format: NOTE_FORMAT,
    v: NOTE_VERSION,
    analysis_id: o.analysis_id,
    document_name: o.document_name,
    device_id: o.device_id,
    session_id: o.session_id,
    device_name: o.device_name,
    user_name: o.user_name,
    state: o.state === "editing" ? "editing" : "idle",
    head,
    base_revision: baseRevision,
    epoch: o.epoch,
    seq: o.seq,
    supersedes: parseSupersedes(o.supersedes),
    updated_at: o.updated_at, // clock-ok: format
    request_to: null,
    handover_to: null,
    features: typeof o.features === "number" && Number.isFinite(o.features) ? o.features : FEATURES_P3,
  };
}

// ── 1.2 The file name ────────────────────────────────────────────────────────

const ASCII_KEEP = /[A-Za-z0-9 \-(),]/;

/** What one scalar value becomes: itself, " " or "" (removed). */
function mapChar(ch: string): string {
  const cp = ch.codePointAt(0)!;
  if (cp < 0x80) return ASCII_KEEP.test(ch) ? ch : " ";
  if (cp <= 0x9f) return " ";
  if (cp === 0xa0 || cp === 0x1680 || (cp >= 0x2000 && cp <= 0x200a) || cp === 0x2028 || cp === 0x2029 ||
      cp === 0x202f || cp === 0x205f || cp === 0x3000) return " ";
  if (cp === 0xad || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2060 && cp <= 0x2069) ||
      cp === 0xfeff) return "";
  // A lone surrogate cannot be in a file name (nor in a Rust string): removed.
  if (cp >= 0xd800 && cp <= 0xdfff) return "";
  return ch;
}

const squeeze = (s: string): string => s.replace(/ +/g, " ").replace(/^ | $/g, "");

export function sanitizeNamePart(text: string, maxChars: number, maxBytes: number, fallback: string): string {
  let s = "";
  for (const ch of String(text ?? "")) s += mapChar(ch);
  s = squeeze(s);
  let chars = Array.from(s).slice(0, Math.max(0, maxChars));
  let bytes = utf8Length(chars.join(""));
  while (chars.length && bytes > maxBytes) bytes -= utf8Length(chars.pop()!);
  s = squeeze(chars.join(""));
  return s === "" ? fallback : s;
}

export function deviceTag(deviceId: string, attempt: 0 | 1 | 2): string {
  const hex = asciiLower(String(deviceId ?? "")).replace(/[^0-9a-f]/g, "");
  const p = hex.padStart(8, "0");
  return attempt === 0 ? p.slice(-4) : attempt === 1 ? p.slice(-8, -4) : p.slice(-8);
}

export function noteFileName(docFileName: string, deviceName: string, deviceId: string, attempt: 0 | 1 | 2 = 0): string {
  const stem = String(docFileName ?? "").replace(new RegExp(`\\.${GRAPH_EXT}$`, "i"), "");
  const doc = sanitizeNamePart(stem, LIMITS_P3.nameStemChars, LIMITS_P3.nameStemBytes, "Analysis");
  const dev = sanitizeNamePart(deviceName, LIMITS_P3.nameDeviceChars, LIMITS_P3.nameDeviceBytes, "computer");
  return `${doc} (in use on ${dev}, ${deviceTag(deviceId, attempt)}).${PRESENCE_EXT}`;
}

export function isNoteFileName(name: string): boolean {
  return typeof name === "string" && !name.startsWith(".") && asciiLower(name).endsWith(`.${PRESENCE_EXT}`);
}

// ── 1.4 / 1.5 Which notes count ──────────────────────────────────────────────

const nameKey = (s: string): string => s.normalize("NFC").toLowerCase();

export function noteApplies(
  note: Pick<NoteJson, "analysis_id" | "document_name">,
  doc: { analysisId: string; fileName: string; sameIdFiles: number },
): boolean {
  if (note.analysis_id !== doc.analysisId) return false;
  return nameKey(note.document_name) === nameKey(doc.fileName) || doc.sameIdFiles === 1;
}

/** a beats b: higher seq, then the later updated_at (plain string order). */
function beatsByNote(a: NoteJson, b: NoteJson): number {
  if (a.seq !== b.seq) return a.seq > b.seq ? 1 : -1;
  return cmp(a.updated_at, b.updated_at); // clock-ok: tie-break (same device, same seq)
}

export function pickPerDevice(records: readonly NoteRecord[]): NoteRecord[] {
  const best = new Map<string, NoteRecord>();
  for (const r of records) {
    const cur = best.get(r.note.device_id);
    if (!cur) { best.set(r.note.device_id, r); continue; }
    const c = beatsByNote(r.note, cur.note);
    if (c > 0 || (c === 0 && cmp(r.file, cur.file) < 0)) best.set(r.note.device_id, r);
  }
  return [...best.values()].sort((a, b) => cmp(a.note.device_id, b.note.device_id));
}

/** One note per device for inputs that were not (or not fully) reduced by pickPerDevice: the same rule, then
 *  the note's own text as the last tie-break, so the answer never depends on the order of `notes`. */
function onePerDevice(notes: readonly NoteJson[], excludeDevice?: string): NoteJson[] {
  const best = new Map<string, NoteJson>();
  for (const n of notes) {
    if (excludeDevice !== undefined && n.device_id === excludeDevice) continue;
    const cur = best.get(n.device_id);
    if (!cur) { best.set(n.device_id, n); continue; }
    const c = beatsByNote(n, cur);
    if (c > 0 || (c === 0 && cmp(noteText(n), noteText(cur)) < 0)) best.set(n.device_id, n);
  }
  return [...best.values()].sort((a, b) => cmp(a.device_id, b.device_id));
}

// ── 2.2 Observations ─────────────────────────────────────────────────────────

export const emptyObs = (): PresenceObs => ({ notes: {}, unknownSince: {}, checkingSince: null });

/** The first-sight rule: from when on (my clock) a note first seen then counts as old — its own time plus
 *  firstSightOldMs; an unreadable time counts as old at once (-Infinity). */
function oldFrom(n: NoteJson): number {
  const t = Date.parse(n.updated_at); // clock-ok: first sight (and a change that arrives late, fixer VP-4)
  return Number.isFinite(t) ? t + LIMITS_P3.firstSightOldMs : Number.NEGATIVE_INFINITY;
}

const oldAtFirstSight = (n: NoteJson, now: number): boolean => now > oldFrom(n);

const sameIdentity = (o: NoteObs, n: NoteJson): boolean =>
  o.sessionId === n.session_id && o.epoch === n.epoch && o.seq === n.seq;

function firstSight(n: NoteJson, now: number): NoteObs {
  return {
    deviceId: n.device_id,
    sessionId: n.session_id,
    epoch: n.epoch,
    seq: n.seq,
    state: n.state,
    firstSeenAt: now,
    changedAt: now,
    changes: 0,
    editingSince: n.state === "editing" ? now : null,
    oldAtFirstSight: oldAtFirstSight(n, now),
    checking: false,
  };
}

/** An observation with the late-arrival mark (fixer VP-4). Not part of the contract's NoteObs; an extra key
 *  that only observeOne reads. "one": the last change looked old by my clock and was not counted as a sign of
 *  life; "skewed": two such changes in a row were seen (the note moves, its writer's clock is off), so old-looking
 *  changes count again until a change with a recent time is seen. */
type NoteObsX = NoteObs & { late?: "one" | "skewed" };

/** `o` without the late-arrival mark. */
function plain(o: NoteObsX): NoteObs {
  if (o.late === undefined) return o;
  const { late: _late, ...rest } = o;
  return rest;
}

/** editingSince for a note `n` that follows observation `o` of the same device (display: "continued at …"). */
function editingSinceAfter(o: NoteObs, n: NoteJson, now: number): number | null {
  if (n.state !== "editing") return null;
  const newPeriod = o.state !== "editing" || o.epoch !== n.epoch || o.sessionId !== n.session_id;
  return newPeriod || o.editingSince === null ? now : o.editingSince;
}

/** One note taken in against what was observed of its device before. */
function observeOne(o0: NoteObs | undefined, n: NoteJson, now: number): NoteObs {
  if (!o0) return firstSight(n, now);
  const o = o0 as NoteObsX;
  if (o.checking) {
    // The re-look after a gap is a first sight again; the same editing period keeps its start (fixer F6).
    const fresh: NoteObs = { ...firstSight(n, now), editingSince: editingSinceAfter(o, n, now) };
    if (sameIdentity(o, n)) return fresh;
    // A note that moved meanwhile is alive — unless its own time is old by my clock: then it arrived late (I was
    // asleep or offline) and says nothing about now (fixer VP-4, the first-sight rule); its next change counts even
    // when it looks old too (a wrong clock costs at most one rewrite of delay).
    return fresh.oldAtFirstSight ? ({ ...fresh, late: "one" } as NoteObsX) : { ...fresh, changes: 1, oldAtFirstSight: false };
  }
  if (sameIdentity(o, n)) return o.state === n.state ? o : { ...o, state: n.state };
  const moved = { sessionId: n.session_id, epoch: n.epoch, seq: n.seq, state: n.state, editingSince: editingSinceAfter(o, n, now) };
  // fixer VP-4: a change whose own time is old by my clock arrived late (I was offline, asleep or just started):
  // the first such change is taken in without counting as a sign of life. A second one in a row does count (the
  // note keeps moving; its writer's clock is wrong) — so a wrong clock costs at most one rewrite of delay.
  if (oldAtFirstSight(n, now) && o.late !== "skewed") {
    if (o.late !== "one") return { ...o, ...moved, late: "one" } as NoteObsX;
    return { ...plain(o), ...moved, changedAt: now, changes: o.changes + 1, oldAtFirstSight: false, late: "skewed" } as NoteObsX;
  }
  const next: NoteObsX = { ...o, ...moved, changedAt: now, changes: o.changes + 1, oldAtFirstSight: false };
  return oldAtFirstSight(n, now) ? next : plain(next);
}

/** Version ids a note declares: its head, and its base while editing. */
function declared(n: NoteJson): string[] {
  const out: string[] = [];
  if (n.head !== null) out.push(n.head);
  if (n.state === "editing" && n.base_revision !== null) out.push(n.base_revision);
  return out;
}

export function observe(prev: PresenceObs, notes: readonly NoteJson[], now: number, knows: (revisionId: string) => boolean): PresenceObs {
  const list = onePerDevice(notes);
  const obsNotes: Record<string, NoteObs> = {};
  const unknownSince: Record<string, number> = {};
  for (const n of list) {
    put(obsNotes, n.device_id, observeOne(own(prev.notes, n.device_id), n, now));
    for (const h of declared(n)) {
      if (own(unknownSince, h) !== undefined || knows(h)) continue;
      put(unknownSince, h, own(prev.unknownSince, h) ?? now);
    }
  }
  return { notes: obsNotes, unknownSince, checkingSince: null };
}

export function markGap(prev: PresenceObs, now: number): PresenceObs {
  const notes: Record<string, NoteObs> = {};
  for (const [k, o] of Object.entries(prev.notes)) put(notes, k, { ...o, checking: true });
  return { notes, unknownSince: {}, checkingSince: prev.checkingSince ?? now };
}

// ── 2.3 Freshness ────────────────────────────────────────────────────────────

/** Freshness, and the next moment (my clock) at which it flips without new input (null = never). */
function freshnessAt(o: NoteObs, now: number, checkingSince: number | null): { f: Freshness; flip: number | null } {
  const future = (t: number): number | null => (t > now ? t : null);
  if (o.checking && checkingSince !== null) {
    const e = elapsed(now, checkingSince);
    if (e < LIMITS_P3.recheckMaxMs) return { f: "checking", flip: future(checkingSince + LIMITS_P3.recheckMaxMs) };
    // The folder could not be listed after waking: as if first seen at checkingSince.
    if (o.oldAtFirstSight) return { f: "quiet", flip: null };
    return e < LIMITS_P3.freshFirstMs
      ? { f: "active", flip: future(checkingSince + LIMITS_P3.freshFirstMs) }
      : { f: "quiet", flip: null };
  }
  if (o.changes === 0) {
    if (o.oldAtFirstSight) return { f: "quiet", flip: null };
    return elapsed(now, o.firstSeenAt) < LIMITS_P3.freshFirstMs
      ? { f: "active", flip: future(o.firstSeenAt + LIMITS_P3.freshFirstMs) }
      : { f: "quiet", flip: null };
  }
  return elapsed(now, o.changedAt) < LIMITS_P3.staleMs
    ? { f: "active", flip: future(o.changedAt + LIMITS_P3.staleMs) }
    : { f: "quiet", flip: null };
}

export function freshness(o: NoteObs, now: number, checkingSince: number | null): Freshness {
  return freshnessAt(o, now, checkingSince).f;
}

// ── 2.4 The tab's mode ───────────────────────────────────────────────────────

interface Peer {
  n: NoteJson;
  o: NoteObs;
  view: PeerView;
  editing: boolean;
  fresh: Freshness;
  flip: number | null;
  basedOn: PeerView["basedOn"];
  overridden: boolean;
}

/** The observation decide() uses for a note: the recorded one; a first sight now when there is none; the
 *  note taken in now when the record is behind it (a "checking" record stays as it is until a listing). */
function obsFor(obs: PresenceObs, n: NoteJson, now: number): NoteObs {
  const o = own(obs.notes, n.device_id);
  if (!o) return firstSight(n, now);
  if (o.checking || sameIdentity(o, n)) return o.state === n.state ? o : { ...o, state: n.state };
  return observeOne(o, n, now);
}

export function decide(input: PresenceInput): PresenceDecision {
  const { me, now, diskHead, knows, dirty, holding, myEpoch, resuming, overrides, obs } = input;
  const notes = onePerDevice(input.notes, me.deviceId);
  const myUser = me.userName.trim();

  const supersededSet = new Set<string>();
  for (const q of notes) {
    if (q.state !== "editing") continue;
    for (const p of notes) if (p.device_id !== q.device_id && names(q.supersedes, p.device_id, p.epoch)) supersededSet.add(p.device_id);
  }

  const peers: Peer[] = notes.map((n) => {
    const o = obsFor(obs, n, now);
    const editing = n.state === "editing";
    const at = freshnessAt(o, now, obs.checkingSince);
    let flip = at.flip;
    const f = at.f;
    // A note with no record counts as first seen now: it turns old (quiet) once its own time is firstSightOldMs back.
    // The same for a record that is behind the note (taken in now as a change): from that moment on the change
    // would count as a late arrival (fixer VP-4).
    const rec = own(obs.notes, n.device_id) as NoteObsX | undefined;
    const behind = !!rec && !rec.checking && !sameIdentity(rec, n) && rec.late !== "skewed" && !oldAtFirstSight(n, now);
    if ((!rec && !o.oldAtFirstSight) || behind) {
      const t = Math.floor(oldFrom(n)) + 1;
      if (t > now && (flip === null || t < flip)) flip = t;
    }
    let basedOn: PeerView["basedOn"] = null;
    if (editing) {
      basedOn = n.base_revision !== null && n.base_revision === diskHead ? "myVersion"
        : n.base_revision !== null && knows(n.base_revision) ? "older" : "unknown";
    }
    const user = n.user_name.trim();
    const view: PeerView = {
      deviceId: n.device_id,
      deviceName: n.device_name,
      userName: n.user_name,
      sameUser: user !== "" && user === myUser,
      state: n.state,
      freshness: f,
      basedOn,
      updatedAt: n.updated_at, // clock-ok: display only
      editingSince: o.editingSince,
      changedAt: o.changedAt,
      superseded: editing && supersededSet.has(n.device_id),
      supersedesMe: holding && editing && names(n.supersedes, me.deviceId, myEpoch),
    };
    return { n, o, view, editing, fresh: f, flip, basedOn, overridden: overrides.some((t) => sameTarget(t, n.device_id, n.epoch)) };
  });
  peers.sort((a, b) =>
    (a.editing === b.editing ? 0 : a.editing ? -1 : 1) || cmp(a.view.deviceName, b.view.deviceName) || cmp(a.view.deviceId, b.view.deviceId));

  const editingPeers = peers.filter((p) => p.editing);
  const flips: number[] = [];
  for (const p of editingPeers) if (p.flip !== null) flips.push(p.flip);

  const result = (mode: TabMode, about: Peer[], more: Partial<PresenceDecision> = {}): PresenceDecision => ({
    mode,
    checking: false,
    peers: peers.map((p) => p.view),
    about: about.map((p) => p.view.deviceId),
    blockers: [],
    yieldedTo: null,
    waiting: null,
    unconfirmed: false,
    nextCheckAt: flips.length ? Math.min(...flips) : null,
    ...more,
  });

  // A. Unsaved changes here, or my note says "editing": never read-only, never waiting.
  if (dirty || holding) {
    const overMe = peers.filter((p) => p.view.supersedesMe).sort((a, b) => cmp(a.view.deviceId, b.view.deviceId));
    if (overMe.length) return result("bothEditing", [overMe[0]], { yieldedTo: overMe[0].view.deviceId });
    if (resuming) return result("resuming", editingPeers);
    const live = editingPeers.filter((p) => p.fresh !== "quiet");
    if (live.length) return result("bothEditing", live);
    if (editingPeers.length) return result("info", editingPeers);
    return result("editable", []);
  }

  // B. A clean tab.
  // B1. Waiting for a version a note announces and this computer does not have.
  let unconfirmed = false;
  const waits: { p: Peer; head: string; since: number; until: number }[] = [];
  const candidate = (p: Peer, h: string): void => {
    const since = own(obs.unknownSince, h) ?? now;
    const limit = p.o.oldAtFirstSight && p.o.changes === 0 ? LIMITS_P3.waitOldNoteMs : LIMITS_P3.waitNewerMs;
    if (elapsed(now, since) < limit) waits.push({ p, head: h, since, until: since + limit });
    else unconfirmed = true;
  };
  for (const p of peers) {
    if (p.n.head !== null && !knows(p.n.head)) candidate(p, p.n.head);
    // (A base equal to the head is already a candidate above.)
    if (p.editing && p.basedOn === "unknown" && p.n.base_revision !== null && p.n.base_revision !== p.n.head && p.fresh !== "quiet") {
      candidate(p, p.n.base_revision);
    }
  }
  if (waits.length) {
    // The one that lasts longest; ties by device id, then version id.
    waits.sort((a, b) => b.until - a.until || cmp(a.p.view.deviceId, b.p.view.deviceId) || cmp(a.head, b.head));
    for (const w of waits) flips.push(w.until);
    const w = waits[0];
    return result("waiting", [w.p], { waiting: { head: w.head, deviceId: w.p.view.deviceId, since: w.since, until: w.until }, unconfirmed });
  }

  // B2. Read-only: someone is editing this very version, and nobody overrode that.
  const blockSet = editingPeers.filter((p) => p.basedOn === "myVersion" && p.fresh !== "quiet" && !p.overridden);
  const standing = blockSet.filter((p) => !p.view.superseded);
  if (standing.length) {
    return result("readOnly", blockSet, {
      blockers: blockSet.map((p) => ({ device_id: p.n.device_id, epoch: p.n.epoch })),
      checking: standing.every((p) => p.fresh === "checking"),
      unconfirmed,
    });
  }

  // B3. Information only.
  const inBlock = new Set(blockSet.map((p) => p.view.deviceId));
  const info = editingPeers.filter((p) => p.fresh === "quiet" || p.basedOn === "older" || p.overridden || inBlock.has(p.view.deviceId));
  if (info.length) return result("info", info, { unconfirmed });

  return result("editable", [], { unconfirmed });
}

// ── 2.1 Sleep gaps ───────────────────────────────────────────────────────────

export function gapDetected(prevAt: number, now: number, intervalMs: number): boolean {
  return now < prevAt || now - prevAt - intervalMs > LIMITS_P3.sleepGapMs;
}

// ── 2.5 The small helpers ────────────────────────────────────────────────────

export function olderPeer(
  m: Pick<Manifest, "features" | "head" | "revisions">,
  myDeviceId: string,
  notes: readonly NoteJson[],
): { deviceId: string; deviceName: string; userName: string } | null {
  const features = typeof m.features === "number" && Number.isFinite(m.features) ? m.features : 1;
  if (features >= FEATURES_P3) return null;
  const byId = new Map(m.revisions.map((r) => [r.id, r] as const));
  const seen = new Set<string>();
  let r = byId.get(m.head);
  while (r && r.device_id === "" && !seen.has(r.id)) {
    seen.add(r.id);
    r = r.parents.length ? byId.get(r.parents[0]) : undefined;
  }
  if (!r || r.device_id === "" || r.device_id === myDeviceId) return null;
  const dev = r.device_id;
  if (notes.some((n) => n.device_id === dev)) return null;
  return { deviceId: r.device_id, deviceName: r.device_name, userName: r.user_name };
}

export function multiDevice(m: Pick<Manifest, "revisions"> | null, myDeviceId: string, notes: readonly NoteJson[]): boolean {
  if (notes.length > 0) return true;
  return !!m && m.revisions.some((r) => r.device_id !== "" && r.device_id !== myDeviceId);
}

export function shareDecision(p: { choice: ShareMode | null; fallback: ShareMode; untitled: boolean; cloud: boolean; multiDevice: boolean }): { on: boolean; why: ShareWhy } {
  if (p.untitled) return { on: false, why: "untitled" };
  const mode = p.choice ?? p.fallback;
  if (mode === "never") return { on: false, why: "never" };
  if (mode === "always") return { on: true, why: "always" };
  if (p.cloud) return { on: true, why: "cloud" };
  if (p.multiDevice) return { on: true, why: "otherComputers" };
  return { on: false, why: "local" };
}

export function liveNoteHeads(notes: readonly NoteJson[]): string[] {
  const s = new Set<string>();
  for (const n of notes) {
    if (n.head !== null) s.add(n.head);
    if (n.base_revision !== null) s.add(n.base_revision);
  }
  return [...s].sort(cmp);
}

export function cleanupTargets(records: readonly NoteRecord[], now: number): RemoveNoteArgs[] {
  return records
    .filter((r) => !r.own && (r.applies || r.orphan) && r.unchangedSince > 0 && now - r.unchangedSince >= LIMITS_P3.cleanupMs)
    .map((r) => ({ file: r.file, sha: r.sha }))
    .sort((a, b) => cmp(a.file, b.file));
}

export function duplicateIdentity(before: readonly NoteRecord[], after: readonly NoteRecord[], me: { deviceId: string; sessionId: string }): boolean {
  return after.some((a) =>
    a.note.device_id === me.deviceId && a.note.session_id !== me.sessionId &&
    before.some((b) => b.note.device_id === me.deviceId && b.note.session_id === a.note.session_id && b.note.seq < a.note.seq));
}

/** The whole engine as one object (checked against the contract at compile time). */
export const presenceApi = {
  noteText, parseNote, sanitizeNamePart, deviceTag, noteFileName, isNoteFileName, noteApplies, pickPerDevice, emptyObs, observe,
  markGap, freshness, decide, gapDetected, olderPeer, multiDevice, shareDecision, liveNoteHeads, cleanupTargets,
  duplicateIdentity,
} satisfies PresenceApi;
