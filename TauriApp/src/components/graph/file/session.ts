/* The files session controller (contract §4): tabs, open / save / Save As /
   Duplicate / close, Recent, per-document drafts, session restore with cards,
   Find it…, poll events, the journal check, conflicts, the quit routine, the
   library export and settings. The UI imports `useFileSession` and nothing else.

   One document lives in memory (the graph store); every other tab is its
   session record plus, when it has unsaved changes, its draft on disk.

   Everything the controller needs from outside comes through SessionDeps, so the
   tests run two "computers" (two controllers, two graph stores, one simulated
   sync service) on a manual clock.

   Phase 3 (phase3-contract.md §5): who is editing. Each tab keeps the notes
   beside its file (presence events), what this computer observed of them on its
   own clock, and the decision of presence.ts: editable, read-only (the graph
   store's guard), waiting for a newer version, information only, both editing or
   resuming after a sleep. This computer's own note says "editing" exactly while it
   holds the document (unsaved changes, the 30 s after a save, right after "Edit
   here"); it is written fire-and-forget, never awaited by a person's action. */

import { create, type StoreApi, type UseBoundStore } from "zustand";
import { getGraphAnalysis, getGraphLibrary, type Template } from "../../../api/graph";
import { isTauri } from "../../../api/client";
import {
  clearDraft as clearLegacyDraft, isDirty, openContent, readDraft as readLegacyDraft, useGraphStore,
  type DocContent, type GraphDraft, type GraphStoreApi,
} from "../../../store/graphStore";
import { flushScratch as realFlushScratch } from "../scratchpad/scratchBridge";
import { SCRATCH_LIMIT } from "../scratchpad/scratchModel";
import type {
  DeviceIdentity, DraftRecord, FileErrorCode, FileEvent, FileMemo, GraphSession, JournalHead, ReadResult, RecentEntry, SaveRequest, SaveResult,
  SessionTab,
} from "./backend";
import {
  BANNER_ORDER, CMD, COMBINE_V, EVT, LIMITS, LIMITS_P2, LIMITS_P3, MENU, SUMMARY, WORKING_ROW, emptySeenMap,
  type AppInfo, type BannerAction, type BannerKind, type BaseChoice, type CloudInfo, type CombineChoices, type CombinePlan, type CombinePlanP4,
  type CombineResult, type CombineResultP4, type CombineSectionViewP4, type CombineSource, type CompareResult,
  type CombineState, type CombineStateP4, type ConflictChoice, type FileSessionStateP4, type FineChoice, type DialogAnswer, type DraftListItem, type EditGuardReason, type EditPath, type ExportState,
  type FileBackendP3, type FileSettings, type FileTab, type LaneLayout, type LaneNode, type MenuEvent, type MenuId,
  type NoteJson, type NoteRecord, type NoteTarget, type PeerView, type PresenceDecision, type PresenceObs, type ShareMode, type SharingView,
  type StatusLine, type TabPresence,
  type MenuState, type OpenFilesEvent, type OpenOutcome, type PathPickerRequest, type QuitRequest, type QuitSource, type RecentItem,
  type RestoreCard, type RevisionP2, type SaveAsMode, type SaveOutcome, type SectionValues, type SeenMap, type SessionDialog,
  type SessionToast, type SidePick, type SnapshotPool, type TabBanner, type TabStatus, type VersionChip, type VersionInfo,
  type VersionRow, type VersionStub, type VersionsState,
} from "./contract";
import {
  buildNewFile, completeParts, contentOfDraft, contentOfSections, draftOf, makeRevision, mergeRevisionId, newAnalysisId, newDocKey,
  newRevisionId, openFile, partsNotIn, partsOf, relationOf, revisionOf, revisionSections, roundTrip, sectionsOf,
  unionManifests, versionInfo, withAbsentSnapshotsDropped, withRevision, isStrictAncestor, type Author, type BuiltParts, type FileSections4,
} from "./docCodec";
import { SECTION_NAMES, canonicalJson, fileStem, isAncestorOrSelf, parentDir, type GraphFileData, type Manifest, type Revision, type SectionName } from "./format";
import {
  applyChoices, applyFineChoices, combine, combineDelayMs as defaultCombineDelayMs, combineFine, combineRevision, peersCombineAlike,
} from "./graphMerge";
import { layoutLanes } from "./laneGraph";
import { applyRetention } from "./retention";
import {
  findBase, isAncestorOrSelf as isAncestorOrSelfIn, lowestCommonAncestors, relation, snapshotPool, survivorPath, unionRevisions,
} from "./revisions";
import { compareSections, displaySummary, summaryText } from "./summaries";
import { isExported, libraryStatus, rowContent, runExport, type LibraryApi } from "./libraryExport";
import { cloudServiceOf, folderLabel, graphPath, isConflictCopyName, isTempLocation, safeFileName, withGraphExt } from "./paths";
import {
  cleanupTargets, decide, duplicateIdentity, emptyObs, gapDetected, liveNoteHeads, markGap, multiDevice, observe, olderPeer, pickPerDevice,
  shareDecision,
} from "./presence";

// ── dependencies ────────────────────────────────────────────────────────────

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SessionDeps {
  /** null: chosen in init() (Tauri → Rust commands, else the browser preview's simulated disk). */
  backend: FileBackendP3 | null;
  /** null: detected in init(). */
  desktop: boolean | null;
  graph: GraphStoreApi;
  now(): number;
  timers: Timers;
  flushScratch(opts: { commitEdit?: boolean }): void;
  /** null: the native dialog (desktop) or the in-app picker (preview). */
  pickPath: ((req: PathPickerRequest) => Promise<string | null>) | null;
  /** Desktop-only app commands (menu state, quit reply, pending opens, open_url). */
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
  listen<T>(event: string, handler: (payload: T) => void): Promise<() => void>;
  library: LibraryApi;
  legacyDraft: { read(): GraphDraft | null; clear(): void };
  /** Browser window hooks (focus / blur / beforeunload); null in tests. */
  window: Pick<Window, "addEventListener"> | null;
  /** Preview backend factory (lazy, so the desktop build never makes the simulated world). Phase 3: the preview's
   *  simulated clock and timers (so "+5 min" and "This computer sleeps" reach the controller too). */
  makePreviewBackend: (() => Promise<{ backend: FileBackendP3; persistNow(): void; now?: () => number; timers?: Timers }>) | null;
  /** Is the Graphs tool on screen? The File menu's document commands only act when it is
   *  (otherwise they bring it forward first). */
  graphsVisible(): boolean;
  /** Phase 2 (§5.7): is something being edited that newer content must not interrupt (a cell editor,
   *  a mouse button held down, an open menu / list / popover / dialog)? Default: looked up in the page. */
  interactionBusy(): boolean;
  /** Phase 2: the device-ordered wait before an automatic combine is written (default graphMerge.combineDelayMs). */
  combineDelayMs(deviceId: string): Promise<number>;
  /** Phase 3: time (deps.now) of the last key or click in the window (default: watched in the window). */
  lastActivity(): number;
  /** Phase 3: sleep gaps come from the backend's `wake` event (true) or from the controller's own timer (false).
   *  null = desktop. */
  nativeWake: boolean | null;
  /** Phase 4 §5.7 (tests only): "section" plays an exp-0.2.25 computer: combines by whole sections
   *  (graphMerge.combine / applyChoices), writes no `combine_v`, the phase 2 rule for unprompted combines.
   *  Default "fine". Production code never sets it. */
  combineLevel?: "fine" | "section";
}

// Mouse button and typing state for domInteractionBusy (listeners added once, on first use).
let pointerDown = false;
let pointerHooked = false;
let lastTyping = Number.NEGATIVE_INFINITY;
let composing = false;
/** A focused field counts as "being edited" only this long after the last key or input in it. */
export const TYPING_QUIET_MS = 2000;
function hookPointer(): void {
  if (pointerHooked || typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  pointerHooked = true;
  window.addEventListener("pointerdown", (e) => { if ((e as PointerEvent).button === 0) pointerDown = true; }, true);
  for (const ev of ["pointerup", "pointercancel", "blur"]) window.addEventListener(ev, () => { pointerDown = false; }, true);
  for (const ev of ["keydown", "input", "paste", "cut"]) window.addEventListener(ev, () => { lastTyping = Date.now(); }, true);
  window.addEventListener("compositionstart", () => { composing = true; lastTyping = Date.now(); }, true);
  window.addEventListener("compositionend", () => { composing = false; lastTyping = Date.now(); }, true);
  window.addEventListener("blur", () => { composing = false; }, true);
}

/** Phase 2 §5.7: a primary mouse button down; an open menu, list box, popover or dialog; or a field inside
 *  the Graphs region (input / textarea / contenteditable) that is being typed in: focused, the window has
 *  the keyboard, and a key or input came within TYPING_QUIET_MS (or an input method is composing). A field
 *  that merely has the caret is not busy: the data grid keeps its cells focused after every committed value,
 *  and holding back newer versions for as long as the caret rests there would turn edits made one after the
 *  other on two computers into a choice. */
export function domInteractionBusy(): boolean {
  if (typeof document === "undefined") return false;
  hookPointer();
  if (pointerDown) return true;
  const region = document.querySelector('[role="region"][aria-label="Graphs"]');
  const a = document.activeElement as HTMLElement | null;
  if (a && region && region.contains(a) && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable)) {
    const focused = typeof document.hasFocus !== "function" || document.hasFocus();
    if (focused && (composing || Date.now() - lastTyping < TYPING_QUIET_MS)) return true;
  }
  return !!document.querySelector('[role="menu"], [role="listbox"], [role="dialog"], .MuiPopover-root');
}

/** The Graphs tool's region is shown (tools stay mounted, hidden, when another one is on screen). */
function domGraphsVisible(): boolean {
  if (typeof document === "undefined") return true;
  const el = document.querySelector<HTMLElement>('[role="region"][aria-label="Graphs"]');
  return !!el && !el.hidden && el.offsetParent !== null;
}

/** fixer VP-3: how long after a version arrived from a computer that is editing its note may still name the
 *  version before (the rewritten note is on its way) and is read as based on the new one. */
const LIMITS_HANDOVER_MS = 30_000;
/** fixer VS-4: opening a file waits at most this long for the cloud check and the notes beside it. */
const LIMITS_OPEN_NOTES_MS = 1_500;

/** Timers on real time. */
const realTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Timers on a manual clock (tests): `schedule` runs a task when the clock passes its time. */
export function clockTimers(clock: { schedule(ms: number, fn: () => void): void }): Timers {
  return {
    setTimeout: (fn, ms) => {
      const h = { cancelled: false };
      clock.schedule(ms, () => { if (!h.cancelled) fn(); });
      return h;
    },
    clearTimeout: (h) => { if (h && typeof h === "object") (h as { cancelled: boolean }).cancelled = true; },
  };
}

const defaultLibrary: LibraryApi = {
  async list() {
    const r = await getGraphLibrary();
    if (r.error) throw new Error(r.error);
    return r.analyses ?? [];
  },
  async get(id) {
    const r = await getGraphAnalysis(id);
    return r.analysis ?? null;
  },
};

// ── texts the controller builds (contract §4.9; everything else is the UI's) ──

export function saveFailedMessage(code: FileErrorCode): string {
  switch (code) {
    case "PermissionDenied": return "The file's folder can't be written to.";
    case "Io": return "The file couldn't be written. Check that the disk isn't full.";
    case "OfflineOrTimeout": return "The folder didn't answer in time.";
    case "IdentityMismatch": return "A different analysis is saved under this name.";
    case "TooNew": return "This file was made with a newer version of Lab Analysis Suite.";
    case "Invalid": return "The file couldn't be put together. Nothing was changed.";
    case "NotFound": return "The file's folder can't be found.";
    case "Dataless": case "Incomplete": return "The file isn't fully downloaded yet.";
  }
  return "The file couldn't be written.";
}

const openFailedMessage = (code: FileErrorCode, name: string) =>
  code === "NotFound" ? `'${name}' can't be found.`
    : code === "Invalid" ? `'${name}' isn't a Lab Analysis Suite analysis, or it is damaged.`
      : code === "PermissionDenied" ? "macOS hasn't allowed Lab Analysis Suite to read this folder."
        : `'${name}' can't be opened.`;

// ── internal per-tab state ──────────────────────────────────────────────────

interface Working {
  content: DocContent;
  parts: BuiltParts;
  /** My working copy as a real revision (parents: [base]). */
  rev: Revision;
  manifest: Manifest;
  /** Parts of versions taken in from this computer's saved copies (carry_heads), sent with the save. */
  extraParts?: Record<string, string>;
  /** Built from the store: its editSerial then (undefined: built from the tab's kept changes). */
  serial: number | undefined;
  /** Built from the kept changes: which write of them it was (Internal.draftSeq). */
  draftSeq: number;
}

interface ConflictCtx extends Working {
  theirs: GraphFileData;
  base: string | null;
}

/** Everything one combine needs (phase 2 contract §5.4), kept while its dialog is open. */
interface CombineCtx {
  key: string;
  source: CombineSource;
  origin: "save" | "banner" | "poll";
  /** My side: the tab's base R (clean) or my working copy W (unsaved changes). */
  mineRev: Revision;
  /** A file holding mineRev (its manifest and at least its parts). */
  mineFile: GraphFileData;
  /** R: the base of the tab when this was put together. */
  mineBase: string | null;
  working: Working | null;
  /** The store's editSerial / the kept-changes write it was built from (7.1). */
  serial: number | undefined;
  draftSeq: number;
  theirsFile: GraphFileData;
  theirsRev: Revision;
  /** Saved copies of this computer read while looking for the common version. */
  extra: GraphFileData[];
  base: BaseChoice;
  baseId: string | null;
  /** Phase 4: the fine plan (combineFine); with SessionDeps.combineLevel "section" the phase 2 plan in this form. */
  plan: CombinePlanP4;
  /** Phase 4 §5.1: whole-section choices and per-conflict choices. */
  choices: CombineChoices;
  /** Extra copies still to combine after this one ("Copy 2 of 3"). */
  queue: string[];
  index: number;
  total: number;
  /** The banner that led here (shown again on Cancel). */
  fromBanner: TabBanner | null;
}

type Prepared =
  | { kind: "plan"; ctx: CombineCtx }
  | { kind: "notDiverged"; relation: "same" | "older" | "newer"; theirs: GraphFileData }
  | { kind: "fallback"; theirs: GraphFileData; working: Working | null; mineFile: GraphFileData | null }
  | { kind: "unreadable" } | { kind: "tooNew" } | { kind: "failed" }
  /** The extra copy is no longer there (removed or combined on another computer). */
  | { kind: "gone" };

interface Held { attempt: () => Promise<void>; timer: unknown }

interface Internal {
  manifest: Manifest | null;
  acceptedHead: string | null;
  knownCopies: string[];
  copyAnswer: Record<string, "same">;
  settled: string[];
  template: Template | null;
  sample: boolean;
  conflict: ConflictCtx | null;
  retry: unknown;
  firstTry: number;
  waitedCloud: boolean;
  hasDraft: boolean;
  /** Banner id → a draft key (draftMismatch) or a journaled revision (rolledBack). */
  bannerData: Map<string, string>;
  /** Same-analysis files seen beside this one (copies; never a rename target, also after a restart). */
  seenCopies: string[];
  /** Bumped by every write of this tab's kept changes by the controller. */
  draftSeq: number;
  /** The store's editSerial when the kept changes were last written from the store (undefined: not from the store). */
  draftSerialAt: number | undefined;
  // ── phase 2 ──
  /** Files this computer saved beside the file because it could not be checked (session `asides`). */
  asides: string[];
  /** Heads dropped by "Use the earlier version" whose history the next save takes into the file. */
  carryHeads: string[];
  /** An automatic combine is waiting (session `combine_pending`). */
  combinePending: { theirs: string; source: "disk" | "journal" } | null;
  autoTimer: unknown;
  /** A combine of this tab is being prepared or written (poll events wait for it). */
  combining: number;
  /** The open combine dialog's context. */
  combine: CombineCtx | null;
  /** Fixer VUX-3: the context of a combine dialog that was cancelled with choices made (kept for the same pair). */
  cancelled: CombineCtx | null;
  /** What the last combine of this tab was with (notSaved → Choose… reopens it). */
  lastSource: CombineSource | null;
  /** Banner id → the combine source it stands for. */
  bannerSource: Map<string, CombineSource>;
  /** Content held back while something is being edited (§5.7). */
  held: Held | null;
  /** My head from before the last combine (Undo on the combined banner). */
  preCombineHead: string | null;
  /** A change of the file arrived while a combine was busy: looked at once it is done. */
  recheck: boolean;
  /** Times a combine with an extra copy went back to take in the tab's own file first (bounded). */
  catchUps: number;
  /** The last working copy built (reused while its content and base are the same). */
  lastWorking: Working | null;
  /** Older copies answered "Keep": the head each had then (asked again once it has changes of its own). */
  keptHeads: Record<string, string>;
  // ── phase 3 ──
  pr: PresenceTab;
}

/** What this computer's note on disk says (phase 3 §5.3); `off`: the backend wrote nothing (debug root, quitting). */
interface WrittenNote {
  path: string;
  analysisId: string;
  state: "idle" | "editing";
  head: string | null;
  base: string | null;
  epoch: number;
  supersedes: NoteTarget[];
  /** Device name, user name and id the note was written with. */
  names: string;
  off: boolean;
}

/** Per tab, phase 3 (§5.2 "Internal per tab"). */
interface PresenceTab {
  records: NoteRecord[];
  listed: boolean;
  obs: PresenceObs;
  decision: PresenceDecision | null;
  cloud: CloudInfo | null;
  share: ShareMode | null;
  holding: boolean;
  epoch: number;
  overrides: NoteTarget[];
  /** The claims my current claim overrides. */
  supersedes: NoteTarget[];
  lastInputAt: number;
  lastSaveAt: number;
  lastPingAt: number;
  lastActivitySeen: number;
  lingerTimer: unknown;
  resume: { since: number } | null;
  resumeTimer: unknown;
  written: WrittenNote | null;
  writeSeq: number;
  /** An own note from an earlier run was found (cleared when notes are off). */
  leftover: boolean;
  forceSync: boolean;
  /** Peer claims ("device\0epoch") whose banner was closed. */
  dismissed: Set<string>;
  unconfirmedClosed: string | null;
  olderPeerClosed: string | null;
  /** The guard wanted for this tab (the store's while it is loaded). */
  guard: EditGuardReason | null;
  guardRetry: unknown;
  checkTimer: unknown;
  checkAt: number | null;
  attempt: number;
  hadForeignNote: boolean;
  /** The newest head / manifest read from disk for the path. */
  diskHead: string | null;
  diskManifest: Manifest | null;
  /** The file is missing / replaced: no note until it is back. */
  gone: boolean;
  /** The path the cloud info and the listing are for (another path: looked up again). */
  listedPath: string | null;
  /** An automatic combine that waits while the tab is read-only. */
  autoWaiting: { ctx: CombineCtx; expected: string | null } | null;
  /** fixer VP-3: when this tab's version (decide's diskHead) last changed, and the seq of every foreign note then. */
  headSeen: { head: string | null; at: number; seqs: Record<string, number> };
  /** fixer VP-3: until when a note was read as based on my version because its writer just saved it (null: none). */
  handoverUntil: number | null;
  /** fixer round 2 (RV-4): the hold began with Edit here and has seen no edit and no save yet: the 30 s rule does
   *  not end it ("Edit here" means "I'm editing now"); blur, a tab switch, closing and a newer claim still do. */
  editHereHold: boolean;
  /** fixer round 2 (RV-4): the other computers' claims ("device\0epoch") known when my hold began. A clean
   *  holding tab yields to an editing claim on its version that is not among them (made after mine). */
  claimSeen: Set<string>;
}

const newPresenceTab = (): PresenceTab => ({
  records: [], listed: false, obs: emptyObs(), decision: null, cloud: null, share: null, holding: false, epoch: 0, overrides: [], supersedes: [],
  lastInputAt: Number.NEGATIVE_INFINITY, lastSaveAt: Number.NEGATIVE_INFINITY, lastPingAt: Number.NEGATIVE_INFINITY,
  lastActivitySeen: Number.NEGATIVE_INFINITY, lingerTimer: null, resume: null, resumeTimer: null, written: null, writeSeq: 0, leftover: false,
  forceSync: false, dismissed: new Set(), unconfirmedClosed: null, olderPeerClosed: null, guard: null, guardRetry: null, checkTimer: null, checkAt: null,
  attempt: 0, hadForeignNote: false, diskHead: null, diskManifest: null, gone: false, listedPath: null, autoWaiting: null,
  headSeen: { head: null, at: Number.NEGATIVE_INFINITY, seqs: {} }, handoverUntil: null, editHereHold: false, claimSeen: new Set(),
});

const newInternal = (p: Partial<Internal> = {}): Internal => ({
  manifest: null, acceptedHead: null, knownCopies: [], copyAnswer: {}, settled: [], template: null, sample: false,
  conflict: null, retry: null, firstTry: 0, waitedCloud: false, hasDraft: false, bannerData: new Map(), seenCopies: [],
  draftSeq: 0, draftSerialAt: undefined,
  asides: [], carryHeads: [], combinePending: null, autoTimer: null, combining: 0, combine: null, cancelled: null, lastSource: null,
  bannerSource: new Map(), held: null, preCombineHead: null, recheck: false, catchUps: 0, lastWorking: null, keptHeads: {}, pr: newPresenceTab(), ...p,
});

/** The Versions row of my last save while another computer's save has replaced it (not in the file yet). */
export const PENDING_SUMMARY = "Your last save — not in the file yet";
/** The same row when that version was saved by another computer (shown in this tab, gone from the file). */
export const PENDING_SUMMARY_OTHER = "Shown in this tab — not in the file now";
/** Fixer VUX-6: why the combine window came back after Apply instead of saving (nothing was written). */
export const LOOK_AGAIN_NEWER = "A newer version arrived. Nothing was saved yet — please check again.";
export const LOOK_AGAIN_EDITED = "Your document changed meanwhile. Nothing was saved yet — please check again.";
/** Fixer round 2 (RV-2): Apply while the tab is read-only (another computer is editing). */
export const APPLY_READ_ONLY = "Another computer is editing this file. Nothing was saved — try again in a moment.";

const CARD_KINDS: readonly TabStatus[] = ["waiting", "downloading", "missing", "permission", "unreadable"];
const isCard = (s: TabStatus) => CARD_KINDS.includes(s);
const iso = (t: number) => new Date(t).toISOString();
const asTemplate = (t: unknown): Template | null => (t === "column" || t === "grouped" || t === "xy" ? t : null);

export type FileSessionStore = UseBoundStore<StoreApi<FileSessionStateP4>> & {
  /** Test and simulator access to controller internals (not for the UI). */
  internal: {
    deps: SessionDeps;
    backend(): FileBackendP3 | null;
    manifestOf(key: string): Manifest | null;
    knownCopies(key: string): string[];
    acceptedHead(key: string): string | null;
    flushDraftNow(): Promise<void>;
    // phase 2
    carryHeads(key: string): string[];
    asides(key: string): string[];
    settled(key: string): string[];
    seen(): SeenMap;
    flushSeenNow(): Promise<void>;
    // phase 3
    presence(key: string): {
      records: NoteRecord[]; holding: boolean; epoch: number; overrides: NoteTarget[]; supersedes: NoteTarget[]; resume: { since: number } | null;
      written: { state: "idle" | "editing"; head: string | null; base: string | null; epoch: number; path: string; off: boolean } | null;
      decision: PresenceDecision | null; obs: PresenceObs; hadForeignNote: boolean;
    } | null;
    /** Run the presence timer's work now (tests). */
    presenceTick(): void;
  };
  /** Fixer VUX-4: dialog actions beyond the contract's FileSessionStateP4 (the UI may call these). */
  dialogExtras: {
    /** "Use mine / theirs for the rest": that side for every conflict of the section without a choice. Nothing is written. */
    setRestInSection(section: SectionName, side: SidePick): Promise<void>;
  };
};

/** Last key / click in the window, on the controller's clock (phase 3 deps.lastActivity default). */
const activity = { at: Number.NEGATIVE_INFINITY, now: () => Date.now(), hooked: false };

/** "Alice (Office iMac)", "you on Office iMac", "another computer" (the undo step's label, §6.3). */
function whoLabel(v: VersionInfo): string {
  const user = v.userName.trim();
  const dev = v.deviceName.trim();
  if (v.mine) return dev ? `you on ${dev}` : "you";
  if (user && dev) return `${user} (${dev})`;
  if (user) return user;
  if (dev) return `someone on ${dev}`;
  return "another computer";
}

// ═════════════════════════════════════════════════════════════════════════════

export function createFileSession(partial: Partial<SessionDeps> = {}): FileSessionStore {
  const deps: SessionDeps = {
    backend: null, desktop: null, graph: useGraphStore, now: () => Date.now(), timers: realTimers,
    flushScratch: realFlushScratch, pickPath: null,
    invoke: async (cmd, args) => (await import("./tauriBackend")).tauriInvoke(cmd, args ?? {}),
    listen: async (event, handler) => (await import("./tauriBackend")).tauriListen(event, handler),
    library: defaultLibrary,
    legacyDraft: { read: readLegacyDraft, clear: clearLegacyDraft },
    window: typeof window !== "undefined" ? window : null,
    makePreviewBackend: async () => {
      const m = await import("./previewBackend");
      const p = m.previewBackend();
      await p.ready;
      (await import("./devSim")).devSim();     // window.__lasSim (dev builds)
      // Phase 3: the controller runs on the simulated clock, with this computer's timers (they stop while it sleeps).
      return { backend: p.device, persistNow: p.persistNow, now: () => p.clock.now(), timers: p.device.timers() };
    },
    graphsVisible: domGraphsVisible,
    interactionBusy: domInteractionBusy,
    combineDelayMs: defaultCombineDelayMs,
    lastActivity: () => activity.at,
    nativeWake: null,
    ...partial,
  };
  const graph = deps.graph;
  let backend: FileBackendP3 = deps.backend as FileBackendP3;
  let desktop = !!deps.desktop;
  let info: AppInfo = { appVersion: "", platform: "macos", homeDir: "", tempDirs: [], stateDir: null, debug: false };
  let device: DeviceIdentity | null = null;
  let recentEntries: RecentEntry[] = [];
  const internal = new Map<string, Internal>();
  let initPromise: Promise<void> | null = null;
  let suppress = 0;
  let draftTimer: unknown = null;
  let toastSeq = 0;
  let pickerResolve: ((p: string | null) => void) | null = null;
  let dialogResolve: ((a: DialogAnswer) => void) | null = null;
  let quitPromise: Promise<boolean> | null = null;
  let findToken: string | null = null;
  let persistNow: (() => void) | null = null;
  let lastMenu = "";
  let menuTimer: unknown = null;
  let lock: Promise<void> = Promise.resolve();

  const it = (key: string): Internal => {
    let i = internal.get(key);
    if (!i) internal.set(key, (i = newInternal()));
    return i;
  };

  // eslint-disable-next-line prefer-const
  let store: FileSessionStore;
  const get = () => store.getState();
  const set = (p: Partial<FileSessionStateP4>) => store.setState(p);

  // ── phase 4: the rules' version on everything this build writes (§5.6) ──
  /** Playing an exp-0.2.25 computer (tests only, §5.7). */
  const legacy = deps.combineLevel === "section";
  /** A new revision object with `combine_v` (its id and content_hash do not depend on it). */
  function stampRev<T extends Revision>(r: T): T {
    return legacy ? r : ({ ...r, combine_v: COMBINE_V } as T);
  }
  const makeRev = (p: Parameters<typeof makeRevision>[0]): Revision => stampRev(makeRevision(p));
  /** buildNewFile with its one (root) revision stamped. */
  async function newFile(p: Parameters<typeof buildNewFile>[0]): Promise<GraphFileData> {
    const f = await buildNewFile(p);
    if (legacy) return f;
    const head = f.manifest.head;
    return { ...f, manifest: { ...f.manifest, revisions: f.manifest.revisions.map((r) => (r.id === head ? stampRev(r) : r)) } };
  }

  // ── small helpers ──

  const now = () => deps.now();
  const tabOf = (key: string | null | undefined) => (key ? get().tabs.find((t) => t.key === key) ?? null : null);
  const tabByPath = (path: string) => get().tabs.find((t) => t.path === path) ?? null;
  const labelOf = (path: string) => folderLabel(path, info.homeDir);
  const serviceOf = (path: string | null) => (path ? cloudServiceOf(path, info.homeDir) : null);
  const vi = (m: Manifest, id: string): VersionInfo => versionInfo(m, id, device?.device_id ?? null);
  const isLoaded = (key: string | null) => {
    const s = graph.getState();
    return !!key && !!s.doc && s.file?.docKey === key;
  };
  const author = (): Author => ({
    user_name: device?.user_name ?? "", device_id: device?.device_id ?? "", device_name: device?.device_name ?? "",
    session_id: device?.session_id ?? "", app_version: info.appVersion, platform: info.platform,
  });
  const content = (): DocContent => {
    const s = graph.getState();
    return { doc: s.doc!, analysis: s.analysis, figure: s.figure, scratch: s.scratch };
  };
  const tabDirty = (key: string) => (isLoaded(key) ? isDirty(graph.getState()) : !!tabOf(key)?.dirty);
  /** Phase 3 fix (typed-edit claim): the loaded tab has an open editor with typed text not in the content yet
   *  (graphStore `typing`). Not unsaved changes (Save, Close, drafts and combining go by tabDirty), but for the
   *  presence rules it counts as editing in progress: decide() sees it as dirty (never read-only, never waiting),
   *  the hold is never released while it lasts, and content arriving on its own waits (busyNow). */
  const typingIn = (key: string) => isLoaded(key) && graph.getState().typing.length > 0;
  /** Unsaved changes or typing in progress: what keeps a tab editing (presence only). */
  const editingNow = (key: string) => tabDirty(key) || typingIn(key);
  const addUnique = (list: string[], p: string) => (list.includes(p) ? list : [...list, p]);

  /** Every file read goes through here: older versions whose content isn't in the file are marked as not stored. */
  async function readFile(path: string): Promise<ReadResult> {
    const r = await backend.read(path);
    if (r.ok) noteSeen(r.file.manifest);
    if (r.ok) {
      // Phase 3: the newest head read from disk for a tab's path (decide()'s diskHead for a tab with unsaved changes).
      const t = tabByPath(path);
      if (t && (!t.analysisId || t.analysisId === r.file.manifest.analysis_id)) {
        const pr = it(t.key).pr;
        pr.diskHead = r.file.manifest.head;
        pr.diskManifest = r.file.manifest;
      }
    }
    return r.ok ? { ...r, file: withAbsentSnapshotsDropped(r.file) } : r;
  }
  async function readJournalFile(analysisId: string, revisionId: string): Promise<GraphFileData | null> {
    const f = await quietly(backend.readJournal(analysisId, revisionId), null);
    if (f) noteSeen(f.manifest);
    return f ? withAbsentSnapshotsDropped(f) : null;
  }

  // ── phase 2: the first-seen record and retention (§3.3, §5.2) ──

  let seen: SeenMap = emptySeenMap();
  let seenTimer: unknown = null;
  let seenDirty = false;

  /** Every version id of `m` this computer has not seen before is seen now. */
  function noteSeen(m: Manifest | null | undefined): void {
    if (!m || typeof m.analysis_id !== "string" || !m.analysis_id || !Array.isArray(m.revisions)) return;
    const aid = m.analysis_id;
    let rec = seen.analyses[aid];
    const t = now();
    let added = false;
    for (const r of m.revisions) {
      if (!r || typeof r.id !== "string") continue;
      if (!rec) { rec = {}; seen.analyses[aid] = rec; }
      if (!Object.prototype.hasOwnProperty.call(rec, r.id)) { rec[r.id] = t; added = true; }
    }
    if (!added || !rec) return;
    const ids = Object.keys(rec);
    if (ids.length > LIMITS_P2.seenPerAnalysis) {
      ids.sort((a, b) => rec![a] - rec![b] || (a < b ? -1 : 1));
      for (const id of ids.slice(0, ids.length - LIMITS_P2.seenPerAnalysis)) delete rec[id];
    }
    seenDirty = true;
    if (seenTimer) deps.timers.clearTimeout(seenTimer);
    seenTimer = deps.timers.setTimeout(() => { seenTimer = null; void flushSeen(); }, LIMITS_P2.seenDebounceMs);
  }

  async function flushSeen(): Promise<void> {
    if (seenTimer) { deps.timers.clearTimeout(seenTimer); seenTimer = null; }
    if (!seenDirty || !backend) return;
    seenDirty = false;
    await quietly(backend.writeSeen(JSON.parse(JSON.stringify(seen)) as SeenMap), undefined);
  }

  /** A manifest about to be written, through the retention rules (with this computer's first-seen times,
   *  its unconfirmed saved copies and the versions being worked with). */
  async function retain(m: Manifest, pinned: (string | null | undefined)[] = []): Promise<Manifest> {
    noteSeen(m);
    const heads = await quietly(backend.journalHeads(m.analysis_id), [] as JournalHead[]);
    return applyRetention(m, {
      now: now(), firstSeen: seen.analyses[m.analysis_id] ?? {}, beaconHeads: noteHeadsFor(m.analysis_id),
      unconfirmedHeads: heads.filter((j) => !j.confirmed).map((j) => j.revision_id),
      pinned: pinned.filter((x): x is string => typeof x === "string" && !!x),
    });
  }

  /** Write a tab's kept changes (and remember which write it was). */
  function putDraft(key: string, d: DraftRecord, serialAt: number | undefined): Promise<void> {
    const i = it(key);
    i.draftSeq++;
    i.draftSerialAt = serialAt;
    return quietly(backend.writeDraft(d), undefined);
  }

  /** Exclusive section for everything that changes which document is loaded. */
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = lock.then(async () => {
      set({ busy: true });
      try { return await fn(); } finally { set({ busy: false }); }
    });
    lock = run.then(() => undefined, () => undefined);
    return run;
  }

  function normTab(t: FileTab): FileTab {
    const banners = [...t.banners].sort((a, b) => BANNER_ORDER.indexOf(a.kind) - BANNER_ORDER.indexOf(b.kind));
    return { ...t, banners, banner: banners[0] ?? null };
  }

  function patchTab(key: string, patch: Partial<FileTab>): void {
    const tabs = get().tabs;
    if (!tabs.some((t) => t.key === key)) return;
    set({ tabs: tabs.map((t) => (t.key === key ? normTab({ ...t, ...patch }) : t)) });
  }

  type BannerInput = Omit<TabBanner, "id" | "dismissible" | "actions"> & { id?: string; dismissible?: boolean; actions?: BannerAction[] };
  const DEFAULT_ACTIONS: Partial<Record<BannerKind, BannerAction[]>> = {
    permission: ["openPrivacy", "retry"], missing: ["findIt", "saveAs"], replaced: ["saveAs"], saveFailed: ["retry", "dismiss"],
    notSaved: ["choose"], savedAside: ["dismiss"], savedOver: ["openCopy", "dismiss"], savedDisplaced: ["openCopy", "dismiss"],
    tookTheirs: ["openCopy", "dismiss"], draftMismatch: ["openAsNew", "discardDraft"], copyQuestion: ["separate", "same"],
    tempLocation: ["chooseLocation"], rolledBack: ["useEarlier", "backToLatest"], newerOnDisk: ["combine", "later"],
    combined: ["whatChanged", "undo"],
    newerCopy: ["updateMine", "later"], olderCopy: ["openThatOne", "later"], recovered: ["dismiss"],
  };

  function addBanner(key: string, b: BannerInput): TabBanner | null {
    const t = tabOf(key);
    if (!t) return null;
    const banner: TabBanner = {
      ...b, id: b.id ?? b.kind, actions: b.actions ?? DEFAULT_ACTIONS[b.kind] ?? [],
      dismissible: b.dismissible ?? !["permission", "downloading", "missing", "replaced", "tooNew", "notSaved", "copyQuestion"].includes(b.kind),
    };
    patchTab(key, { banners: [...t.banners.filter((x) => x.id !== banner.id), banner] });
    return banner;
  }

  function removeBanners(key: string, pred: (b: TabBanner) => boolean): void {
    const t = tabOf(key);
    if (!t || !t.banners.some(pred)) return;
    patchTab(key, { banners: t.banners.filter((b) => !pred(b)) });
  }
  const removeKinds = (key: string, kinds: BannerKind[]) => removeBanners(key, (b) => kinds.includes(b.kind));

  function toast(t: Omit<SessionToast, "id">): void {
    set({ toasts: [...get().toasts.slice(-4), { ...t, id: ++toastSeq }] });
  }

  async function quietly<T>(p: Promise<T> | T, fallback: T): Promise<T> {
    try { return await p; } catch (e) { console.warn("[files]", e); return fallback; }
  }

  // ── dialogs and pickers ──

  function ask(d: SessionDialog): Promise<DialogAnswer> {
    if (dialogResolve) {
      const prev = get().dialog;
      const r = dialogResolve;
      dialogResolve = null;
      if (prev && (prev.kind === "saveAsKind" || prev.kind === "closeDirty" || prev.kind === "quit" || prev.kind === "bringBackDirty" || prev.kind === "editAnyway")) r({ kind: prev.kind, choice: "cancel" } as DialogAnswer);
      else if (prev?.kind === "resumeConfirm") r({ kind: "resumeConfirm", choice: "wait" });
    }
    set({ dialog: d });
    return new Promise((resolve) => { dialogResolve = resolve; });
  }

  async function pickPath(req: PathPickerRequest): Promise<string | null> {
    if (deps.pickPath) return deps.pickPath(req);
    if (desktop) {
      const dlg = await import("@tauri-apps/plugin-dialog");
      const filters = [{ name: "Lab Analysis Suite analysis", extensions: ["lag"] }];
      if (req.mode === "save") {
        const defaultPath = req.startDir ? `${req.startDir}/${req.suggestedName ?? ""}` : req.suggestedName ?? undefined;
        return (await dlg.save({ title: req.title, filters, defaultPath })) ?? null;
      }
      const r = await dlg.open({
        title: req.title, multiple: false, directory: req.mode === "folder",
        ...(req.mode === "open" ? { filters } : {}), defaultPath: req.startDir ?? undefined,
      });
      return typeof r === "string" ? r : null;
    }
    if (pickerResolve) pickerResolve(null);
    set({ pathPicker: req });
    return new Promise((resolve) => { pickerResolve = resolve; });
  }

  // ── session, recent, menu ──

  // ── what this computer decided about a file, kept after its tab is closed (phase 2) ──

  const MEMO_FILES = 100;
  const MEMO_HEADS = 200;
  const fileMemo = new Map<string, FileMemo>();
  const capHeads = (l: string[]) => l.slice(-MEMO_HEADS);

  /** A tab's decisions into the per-file record. */
  function rememberTab(key: string): void {
    const t = tabOf(key);
    const i = internal.get(key);
    if (!t?.path || !t.analysisId || !i) return;
    // The tab started from the file's record (seedFromMemo), so its own list is the whole of it now.
    const settled = capHeads([...new Set(i.settled)]);
    const epoch = Math.max(i.pr.epoch, epochByPath.get(t.path) ?? 0, fileMemo.get(t.path)?.note_epoch ?? 0);
    const rec: FileMemo = {
      analysis_id: t.analysisId,
      ...(settled.length ? { settled_heads: settled } : {}),
      ...(i.acceptedHead ? { accepted_head: i.acceptedHead } : {}),
      ...(i.carryHeads.length ? { carry_heads: [...i.carryHeads] } : {}),
      ...(i.pr.share ? { share: i.pr.share } : {}),
      ...(epoch > 0 ? { note_epoch: epoch } : {}),
    };
    fileMemo.delete(t.path);
    if (rec.settled_heads || rec.accepted_head || rec.carry_heads || rec.share || rec.note_epoch) fileMemo.set(t.path, rec);
    while (fileMemo.size > MEMO_FILES) fileMemo.delete(fileMemo.keys().next().value as string);
  }

  /** A tab opened on a file starts from what was decided about it before. */
  function seedFromMemo(key: string, path: string, aid: string | null): void {
    const m = fileMemo.get(path);
    if (!m || !aid || m.analysis_id !== aid) return;
    const i = it(key);
    i.settled = capHeads([...new Set([...(m.settled_heads ?? []), ...i.settled])]);
    if (!i.acceptedHead && m.accepted_head) i.acceptedHead = m.accepted_head;
    for (const h of m.carry_heads ?? []) if (!i.carryHeads.includes(h)) i.carryHeads = [...i.carryHeads, h];
    if (m.share && i.pr.share === null) i.pr.share = m.share;
    if (typeof m.note_epoch === "number" && m.note_epoch > i.pr.epoch) epochByPath.set(path, Math.max(epochByPath.get(path) ?? 0, m.note_epoch));
  }

  function buildSession(): GraphSession {
    const { tabs, activeKey } = get();
    for (const t of tabs) rememberTab(t.key);
    return {
      v: 1,
      ...(fileMemo.size ? { files: Object.fromEntries(fileMemo) } : {}),
      ...(shareDefault !== "auto" ? { share_default: shareDefault } : {}),
      tabs: tabs.map((t): SessionTab => {
        const i = it(t.key);
        return {
          doc_key: t.key, analysis_id: t.analysisId, path: t.path, base_revision: t.baseRevision, accepted_head: i.acceptedHead,
          active: t.key === activeKey,
          ...(t.path === null ? { title: t.title } : {}),
          ...(t.template ? { template: t.template } : {}),
          ...(i.knownCopies.length ? { known_copies: [...i.knownCopies] } : {}),
          ...(Object.keys(i.copyAnswer).length ? { copy_answer: { ...i.copyAnswer } } : {}),
          ...(i.settled.length ? { settled_heads: [...i.settled] } : {}),
          ...(i.seenCopies.length ? { seen_copies: [...i.seenCopies] } : {}),
          ...(i.asides.length ? { asides: [...i.asides] } : {}),
          ...(i.carryHeads.length ? { carry_heads: [...i.carryHeads] } : {}),
          ...(i.combinePending ? { combine_pending: { ...i.combinePending } } : {}),
          ...(Object.keys(i.keptHeads).length ? { kept_heads: { ...i.keptHeads } } : {}),
        };
      }),
    };
  }

  let sessionQueued = false;
  let sessionChain: Promise<void> = Promise.resolve();
  function saveSession(): Promise<void> {
    if (sessionQueued) return sessionChain;
    sessionQueued = true;
    sessionChain = sessionChain.then(async () => {
      sessionQueued = false;
      await quietly(backend.writeSession(buildSession()), undefined);
    });
    return sessionChain;
  }

  function recentItems(): RecentItem[] {
    const open = new Set(get().tabs.map((t) => t.path));
    return recentEntries.map((e) => ({
      path: e.path, name: fileStem(e.path), folderLabel: labelOf(e.path), analysisId: e.analysis_id, openedAt: e.opened_at,
      missing: !!e.missing, open: open.has(e.path),
    }));
  }

  async function writeRecent(entries: RecentEntry[]): Promise<void> {
    const seen = new Set<string>();
    recentEntries = entries.filter((e) => !seen.has(e.path) && (seen.add(e.path), true)).slice(0, 50);
    set({ recent: recentItems() });
    await quietly(backend.writeRecent(recentEntries), undefined);
  }

  const touchRecent = (path: string, aid: string | null) =>
    writeRecent([{ path, analysis_id: aid, opened_at: iso(now()) }, ...recentEntries.filter((e) => e.path !== path)]);

  function replaceRecent(oldPath: string | null, path: string, aid: string | null): Promise<void> {
    const i = oldPath ? recentEntries.findIndex((e) => e.path === oldPath) : -1;
    if (i < 0) return touchRecent(path, aid);
    const next = recentEntries.filter((e) => e.path !== path);
    const j = next.findIndex((e) => e.path === oldPath);
    next[j] = { path, analysis_id: aid, opened_at: iso(now()) };
    return writeRecent(next);
  }

  const markRecentMissing = (path: string, missing: boolean) => {
    if (!recentEntries.some((e) => e.path === path && !!e.missing !== missing)) return Promise.resolve();
    return writeRecent(recentEntries.map((e) => (e.path === path ? { ...e, missing: missing || undefined } : e)));
  };

  function menuState(): MenuState {
    const s = get();
    const t = tabOf(s.activeKey);
    const hasDoc = !!t && !isCard(t.status);
    return {
      hasDoc, canSave: hasDoc && !t!.readOnly && !t!.saving && !t!.presence?.readOnly,
      recent: s.recent.slice(0, LIMITS.recentMenu).map((r) => ({ path: r.path, label: `${r.name} — ${r.folderLabel}` })),
      canExportLibrary: !!s.oldLibrary && s.oldLibrary.total > 0, hasOldLibrary: !!s.oldLibrary && s.oldLibrary.total > 0,
    };
  }

  function pushMenu(): void {
    if (!desktop || !get().ready) return;
    const state = menuState();
    const text = JSON.stringify(state);
    if (text === lastMenu) return;
    if (menuTimer) deps.timers.clearTimeout(menuTimer);
    menuTimer = deps.timers.setTimeout(() => {
      menuTimer = null;
      const st = menuState();
      lastMenu = JSON.stringify(st);
      void quietly(deps.invoke(CMD.setMenuState, { state: st }), undefined);
    }, 100);
  }

  // ── drafts ──

  /** Write or delete the active tab's draft now (the backend call starts synchronously). */
  function writeActiveDraft(commitEdit: boolean): Promise<void> {
    if (draftTimer) { deps.timers.clearTimeout(draftTimer); draftTimer = null; }
    const key = get().activeKey;
    if (!key || !isLoaded(key)) return Promise.resolve();
    deps.flushScratch({ commitEdit });
    const s = graph.getState();
    const t = tabOf(key)!;
    const dirty = isDirty(s);
    if (t.dirty !== dirty) patchTab(key, { dirty });
    it(key).hasDraft = dirty;
    if (dirty) {
      const d = draftOf({
        docKey: key, analysisId: s.file?.analysisId ?? t.analysisId, path: t.path, baseRevision: s.file?.baseRevision ?? t.baseRevision,
        content: content(), savedAt: now(), title: t.title, template: s.doc!.template,
      });
      return putDraft(key, d, s.editSerial);
    }
    return quietly(backend.deleteDraft(key), undefined);
  }

  function scheduleDraft(): void {
    if (draftTimer) deps.timers.clearTimeout(draftTimer);
    draftTimer = deps.timers.setTimeout(() => { draftTimer = null; void writeActiveDraft(false); }, LIMITS.draftDebounceMs);
  }

  // ── cards ──

  async function setCard(key: string, kind: RestoreCard["kind"]): Promise<void> {
    const t = tabOf(key);
    if (!t || !t.path) return;
    const i = it(key);
    const card: RestoreCard = {
      key, kind, name: t.title, path: t.path, folderLabel: labelOf(t.path), service: serviceOf(t.path), hasDraft: i.hasDraft,
    };
    patchTab(key, { status: kind });
    set({ cards: [...get().cards.filter((c) => c.key !== key), card] });
    if (get().activeKey === key && isLoaded(key)) { suppress++; graph.getState().close(); suppress--; }
    const d = await quietly(backend.readDraft(key), null);
    i.hasDraft = !!d;
    if (get().cards.some((c) => c.key === key && c.hasDraft !== !!d)) {
      set({ cards: get().cards.map((c) => (c.key === key ? { ...c, hasDraft: !!d } : c)) });
    }
  }

  function clearCard(key: string): void {
    if (get().cards.some((c) => c.key === key)) set({ cards: get().cards.filter((c) => c.key !== key) });
  }

  function clearRetry(key: string): void {
    const i = internal.get(key);
    if (i?.retry) { deps.timers.clearTimeout(i.retry); i.retry = null; }
  }

  function scheduleRetry(key: string, ms: number): void {
    const i = it(key);
    clearRetry(key);
    i.retry = deps.timers.setTimeout(() => { i.retry = null; void retryTab(key, true); }, ms);
  }

  /** A read error while opening a tab → its card (and the retry schedule). */
  async function readErrorCard(key: string, code: FileErrorCode, mode: "restore" | "load"): Promise<void> {
    const i = it(key);
    if (!i.firstTry) i.firstTry = now();
    switch (code) {
      case "Dataless": await setCard(key, "downloading"); scheduleRetry(key, 3000); return;
      case "OfflineOrTimeout": await setCard(key, "downloading"); scheduleRetry(key, 5000); return;
      case "Incomplete":
        if (now() - i.firstTry < LIMITS.incompleteRetryMs) { await setCard(key, "downloading"); scheduleRetry(key, 1000); }
        else await setCard(key, "unreadable");
        return;
      case "PermissionDenied": await setCard(key, "permission"); return;
      case "NotFound": await missingFlow(key, mode === "restore"); return;
      default: await setCard(key, "unreadable");
    }
  }

  /** A path that isn't there: the same-folder follow (a file renamed while this computer was off is
   *  followed at once), else wait for the cloud service (startup), then the card. */
  async function missingFlow(key: string, restore: boolean): Promise<void> {
    const t = tabOf(key);
    if (!t?.path) return;
    const i = it(key);
    const waiting = restore && !!serviceOf(t.path) && !i.waitedCloud;
    // While the cloud service may still be catching up, a sync-conflict copy is never followed:
    // the original may simply not have arrived yet.
    if (await followSearch(key, { conflictCopies: !waiting })) return;
    if (waiting) {
      if (!i.firstTry) i.firstTry = now();
      if (now() - i.firstTry < LIMITS.waitCloudMs) {
        await setCard(key, "waiting");
        scheduleRetry(key, 3000);
        return;
      }
      i.waitedCloud = true;
      if (await followSearch(key, { conflictCopies: true })) return;
    }
    await setCard(key, "missing");
  }

  /** Same-folder search with the safe follow rule (contract §4.5 step 3). True when re-pointed. Copies
   *  this tab knows about (made, answered about, or seen beside it) are never followed. */
  async function followSearch(key: string, opts: { conflictCopies: boolean } = { conflictCopies: true }): Promise<boolean> {
    const t = tabOf(key);
    if (!t?.path || !t.analysisId) return false;
    const scan = await backend.scanDir(parentDir(t.path));
    if (!scan.ok) return false;
    const known = new Set([...it(key).knownCopies, ...it(key).seenCopies]);
    const stem = fileStem(t.path);
    const cands = scan.entries.filter((e) => e.kind === "graph" && e.path !== t.path && !known.has(e.path) && e.header?.analysis_id === t.analysisId
      && (opts.conflictCopies || !isConflictCopyName(e.path, stem)));
    if (cands.length !== 1) return false;
    const r = await readFile(cands[0].path);
    if (!r.ok || r.file.manifest.analysis_id !== t.analysisId) return false;
    if (t.baseRevision && !isAncestorOrSelf(r.file.manifest, t.baseRevision, r.file.manifest.head)) return false;
    await repoint(key, cands[0].path, { recent: "replace" });
    toast({ tone: "info", kind: "renamed", name: fileStem(cands[0].path) });
    clearCard(key);
    patchTab(key, { status: "ready" });
    if (get().activeKey === key) await loadInto(key, r);
    return true;
  }

  /** A card's retry (timer or button). */
  async function retryTab(key: string, auto: boolean): Promise<void> {
    const t = tabOf(key);
    if (!t?.path) return;
    if (get().activeKey === key) {
      await exclusive(async () => {
        if (get().activeKey === key && tabOf(key)) await loadInto(key, null, auto ? "restore" : "load");
      });
      return;
    }
    const h = await backend.header(t.path);
    if (h.ok && (!t.analysisId || h.header.analysis_id === t.analysisId)) {
      clearCard(key);
      patchTab(key, { status: "ready" });
      return;
    }
    await readErrorCard(key, h.ok ? "NotFound" : h.code, auto ? "restore" : "load");
  }

  // ── loading a tab into the store ──

  /** Point a tab at another path (rename follow, Find it…, Save As, a save that followed). */
  async function repoint(key: string, path: string, opts: { recent: "replace" | "add" | "none"; analysisId?: string | null }): Promise<void> {
    const t = tabOf(key);
    if (!t) return;
    const old = t.path;
    const aid = opts.analysisId !== undefined ? opts.analysisId : t.analysisId;
    if (old && old !== path) backend.untrack(old);
    const title = fileStem(path);
    patchTab(key, { path, title, folderLabel: labelOf(path), service: serviceOf(path), analysisId: aid });
    if (isLoaded(key)) graph.getState().setFileRef({ path, analysisId: aid }, title);
    if (opts.recent === "replace") await replaceRecent(old, path, aid);
    else if (opts.recent === "add") await touchRecent(path, aid);
    else set({ recent: recentItems() });
    await saveSession();
    if (isLoaded(key) || get().activeKey === key) backend.track(path, { active: get().activeKey === key });
    else backend.track(path, { active: false });
    presenceRepath(key, old, path);
  }

  /** Load a tab's document into the store (the lock is held). `pre`: a read already done. */
  async function loadInto(key: string, pre: ReadResult | null = null, mode: "restore" | "load" | "user" = "load"): Promise<"ok" | "card"> {
    const t = tabOf(key);
    if (!t) return "card";
    const i = it(key);
    clearRetry(key);
    if (t.path === null) {
      const d = await quietly(backend.readDraft(key), null);
      const c = d ? contentOfDraft(d) : null;
      suppress++;
      try {
        if (c) {
          graph.getState().loadFile({ file: { docKey: key, analysisId: t.analysisId, baseRevision: null, path: null }, name: t.title, ...c, saved: false });
        } else {
          graph.getState().newDoc(t.template ?? i.template ?? "column", i.sample);
          graph.getState().setFileRef({ docKey: key, analysisId: t.analysisId, baseRevision: null, path: null }, t.title);
        }
      } finally { suppress--; }
      patchTab(key, { status: "ready", dirty: isDirty(graph.getState()) });
      return "ok";
    }
    if (!isCard(t.status)) patchTab(key, { status: "opening" });
    const r = pre ?? await readFile(t.path);
    if (get().activeKey !== key) return "card";
    if (!r.ok) {
      await readErrorCard(key, r.code, mode === "user" ? "load" : mode);
      return "card";
    }
    const m = r.file.manifest;
    if (t.analysisId && m.analysis_id !== t.analysisId) {
      // Another analysis is at the path now: never adopted.
      await missingFlow(key, mode === "restore");
      return "card";
    }
    const c = openFile(r.file);
    if (!c) { await setCard(key, "unreadable"); return "card"; }
    clearCard(key);
    i.firstTry = 0;
    i.manifest = m;
    const head = m.head;
    const draft = await quietly(backend.readDraft(key), null);
    // Phase 3: who else has it open, before the editor shows it (so a read-only tab never flashes editable).
    i.pr.gone = false;
    await presenceOpen(key, t.path, m.analysis_id);
    if (get().activeKey !== key || !tabOf(key)) return "card";
    suppress++;
    let applied: "none" | "same" | "older" | "mismatch" = "none";
    try {
      graph.getState().loadFile({ file: { docKey: key, analysisId: m.analysis_id, baseRevision: head, path: t.path }, name: t.title, ...c, saved: true });
      patchTab(key, {
        status: "ready", analysisId: m.analysis_id, baseRevision: head, readOnly: r.readOnly, template: c.doc.template,
        folderLabel: labelOf(t.path), service: serviceOf(t.path),
      });
      // A "saved a newer version" note for the version just loaded is answered (the draft check below adds
      // one again when kept changes sit on an older version).
      removeBanners(key, (b) => b.kind === "newerOnDisk" && (!b.version?.head || b.version.head === head || isAncestorOrSelf(m, b.version.head, head)));
      if (draft) applied = await applyDraft(key, draft, m);
    } finally { suppress--; }
    i.hasDraft = applied === "same" || applied === "older";
    patchTab(key, { dirty: isDirty(graph.getState()) });
    // Phase 3: a tab that opens with unsaved changes holds the document; the guard is set before the editor paints.
    if (isDirty(graph.getState()) && !i.pr.holding) claim(key, { input: false }); else evaluate(key);
    backend.track(t.path, { active: true });
    if (r.readOnly) addBanner(key, { kind: "tooNew" });
    else removeKinds(key, ["tooNew"]);
    void afterOpen(key, r.file);
    return "ok";
  }

  /** Unsaved changes on top of a file just loaded (contract §4.6). */
  async function applyDraft(key: string, d: DraftRecord, m: Manifest): Promise<"same" | "older" | "mismatch" | "none"> {
    const c = contentOfDraft(d);
    if (!c) return "none";
    const head = m.head;
    const base = d.base_revision;
    if (base === head) {
      graph.getState().replaceWorking(c);
      return "same";
    }
    if (base && isStrictAncestor(m, base, head)) {
      graph.getState().replaceWorking(c);
      graph.getState().setFileRef({ baseRevision: base });
      patchTab(key, { baseRevision: base });
      addBanner(key, { kind: "newerOnDisk", version: vi(m, head) });
      return "older";
    }
    // Not in this file's history: kept under its own key (Recover unsaved work…) and offered.
    const newKey = newDocKey();
    await quietly(backend.writeDraft({ ...d, doc_key: newKey }), undefined);
    await quietly(backend.deleteDraft(key), undefined);
    const b = addBanner(key, { id: `draftMismatch:${newKey}`, kind: "draftMismatch", when: d.saved_at });
    if (b) it(key).bannerData.set(b.id, newKey);
    return "mismatch";
  }

  /** Leave the active tab: its draft is written (or deleted) and it is polled as a background tab. */
  async function leaveActive(): Promise<void> {
    const key = get().activeKey;
    if (!key) return;
    const t = tabOf(key);
    if (isLoaded(key)) await writeActiveDraft(true);
    if (t?.path && !isCard(t.status)) backend.track(t.path, { active: false });
    // Phase 3 (D6): switching away from a clean tab ends its hold at once.
    if (tabOf(key)) releaseIfClean(key);
  }

  // ── checks after opening ──

  async function afterOpen(key: string, file: GraphFileData): Promise<void> {
    const t = tabOf(key);
    if (!t?.path) return;
    const path = t.path;
    if (isTempLocation(path, info.tempDirs)) addBanner(key, { kind: "tempLocation" });
    await quietly(invariantCheck(key, file.manifest), undefined);
    // The same analysis at another path that Recent knows (sent to a colleague and back). In the same
    // folder too, for a newer copy saved next to my file ("This is a newer version of '…'").
    const i = it(key);
    const sameFolder = parentDir(path);
    const others = recentEntries.filter((e) => e.analysis_id === file.manifest.analysis_id && e.path !== path
      && !i.knownCopies.includes(e.path) && !i.copyAnswer[e.path]).slice(0, 5);
    const handled = new Set<string>();
    for (const e of others) {
      const found = await quietly(otherPlaceCheck(key, e.path, file, parentDir(e.path) === sameFolder), null);
      if (found) handled.add(e.path);
    }
    // Copies in the same folder.
    const scan = await quietly(backend.scanDir(sameFolder), null);
    if (scan && scan.ok) {
      for (const e of scan.entries) {
        if (e.kind !== "graph" || e.path === path || handled.has(e.path) || e.header?.analysis_id !== file.manifest.analysis_id) continue;
        await quietly(handleSibling(key, e.path), undefined);
      }
    }
  }

  /** `q` holds the same analysis as the open file `p`. A banner when one is strictly newer; true when one was shown.
   *  `newerOnly`: only the "this is a newer version of your file" case (copies in the same folder get the copy checks). */
  async function otherPlaceCheck(key: string, q: string, p: GraphFileData, newerOnly = false): Promise<boolean> {
    const h = await backend.header(q);
    if (!h.ok || h.header.analysis_id !== p.manifest.analysis_id) return false;
    const pm = p.manifest;
    const qh = h.header.head;
    if (qh === pm.head) return false;
    if (isStrictAncestor(pm, qh, pm.head)) {
      addBanner(key, { id: `newerCopy:${q}`, kind: "newerCopy", path: q, name: fileStem(q), folderLabel: labelOf(q), version: vi(pm, pm.head) });
      return true;
    }
    if (newerOnly) return false;
    const r = await readFile(q);
    if (!r.ok) return false;
    if (isStrictAncestor(r.file.manifest, pm.head, qh)) {
      addBanner(key, { id: `olderCopy:${q}`, kind: "olderCopy", path: q, name: fileStem(q), folderLabel: labelOf(q), version: vi(r.file.manifest, qh) });
      return true;
    }
    if (!isConflictCopyName(q)) addBanner(key, { id: `copy:${q}`, kind: "copyQuestion", name: tabOf(key)?.title, path: q, folderLabel: labelOf(q) });
    return true;
  }

  /** The journal check (plan §8; phase 2 contract §5.5 table B). "diverged": another computer's save
   *  replaced the version this tab is based on (table A decides); "journal": a combine with my replaced
   *  save was started or offered. */
  async function invariantCheck(key: string, m: Manifest): Promise<"ok" | "rolledBack" | "diverged" | "journal"> {
    const t = tabOf(key);
    if (!t?.path) return "ok";
    const i = it(key);
    const heads = await backend.journalHeads(m.analysis_id, t.path);
    const settled = new Set(i.settled);
    const open = heads.filter((j) => !j.confirmed && j.revision_id !== m.head && !settled.has(j.revision_id))
      .sort((a, b) => a.first_seen - b.first_seen);
    // A head already in the file's history (taken in by "Use the earlier version" then Save, or kept as a side
    // branch) is in the file: nothing is lost and nothing to ask.
    const open2 = open.filter((x) => !revisionOf(m, x.revision_id));
    const j = open2[open2.length - 1];
    if (!j) return "ok";
    if (isAncestorOrSelf(m, j.revision_id, m.head)) return "ok";
    const jf = await readJournalFile(m.analysis_id, j.revision_id);
    if (!jf) {
      // Its content is gone from this computer too: nothing to combine.
      i.settled = [...i.settled, j.revision_id];
      await saveSession();
      return "ok";
    }
    if (isAncestorOrSelf(jf.manifest, m.head, j.revision_id)) {
      if (m.head === i.acceptedHead) return "ok";
      const b = addBanner(key, {
        id: "rolledBack", kind: "rolledBack", version: vi(m, m.head), when: revisionOf(m, m.head)?.time,
      });
      if (b) i.bannerData.set(b.id, j.revision_id);
      return "rolledBack";
    }
    // Another computer's save replaced mine. When the tab is not on the version on disk (or a newer one),
    // table A combines the tab's version with it first; my replaced save comes after that.
    if (j.revision_id === t.baseRevision) return "diverged";
    const R = t.baseRevision;
    const known = unionRevisions(m, ...(i.manifest ? [i.manifest] : []));
    if (!R || !isAncestorOrSelfIn(known, m.head, R)) return "diverged";
    const source: CombineSource = { kind: "journal", revisionId: j.revision_id };
    if (!tabDirty(key)) await autoCombine(key, source);
    else chooseBanner(key, source, vi(jf.manifest, j.revision_id));
    return "journal";
  }

  /** A free "<stem> <suffix>.lag" beside `path`. */
  async function freeBeside(path: string, label: string): Promise<string> {
    const dir = parentDir(path);
    const stem = `${fileStem(path)} ${label}`;
    const scan = await backend.scanDir(dir);
    const names = new Set(scan.ok ? scan.entries.map((e) => e.name.toLowerCase()) : []);
    for (let n = 1; ; n++) {
      const p = graphPath(dir, n === 1 ? stem : `${stem} ${n}`);
      if (!names.has(p.slice(dir.length + 1).toLowerCase())) return p;
    }
  }

  /** Write a whole file (same analysis) beside `path` as a copy; its path, or null. */
  async function writeCopyBeside(path: string, label: string, file: GraphFileData): Promise<string | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const target = await freeBeside(path, label);
      const res = await backend.save({
        path: target, expectedHead: null, analysisId: file.manifest.analysis_id, docKey: newDocKey(), manifest: file.manifest, newParts: file.parts,
      });
      if (res.ok) return res.path;
      if (res.kind !== "conflict") return null;
    }
    return null;
  }

  /** Another file with the same analysis id beside an open file (contract §4.7 "Copies"). */
  async function handleSibling(key: string, sib: string): Promise<void> {
    const t = tabOf(key);
    const i = it(key);
    if (!t?.path) return;
    if (i.knownCopies.includes(sib)) {
      // A copy kept as it was: quiet while it still has nothing this file lacks.
      const kept = i.keptHeads[sib];
      if (!kept) return;
      const h = await quietly(backend.header(sib), null);
      if (!h || !h.ok) return;
      const head = h.header.head;
      const known = i.manifest ? unionRevisions(i.manifest) : [];
      if (head === kept || (t.baseRevision && isAncestorOrSelfIn(known, head, t.baseRevision))) return;
      i.knownCopies = i.knownCopies.filter((p) => p !== sib);
      const { [sib]: _k, ...rest } = i.keptHeads;
      i.keptHeads = rest;
      void saveSession();
    }
    if (!i.seenCopies.includes(sib)) {
      // A copy, remembered across restarts: never taken for this file renamed.
      i.seenCopies = [...i.seenCopies, sib].slice(-50);
      void saveSession();
    }
    const r = await readFile(sib);
    if (!r.ok) { if (r.code === "NotFound") forgetCopy(key, sib); return; }
    const mine = i.manifest ?? (t.analysisId && t.baseRevision ? (await readJournalFile(t.analysisId, t.baseRevision))?.manifest ?? null : null);
    if (!mine || !t.baseRevision || r.file.manifest.analysis_id !== t.analysisId) return;
    const relation = relationOf(mine, t.baseRevision, r.file.manifest, r.file.manifest.head);
    // Files this computer saved beside it (could not be checked) count as sync-conflict copies (§5.5 C).
    const conflictName = isConflictCopyName(sib, fileStem(t.path)) || i.asides.includes(sib);
    // An older copy needs no question: everything in it is in this file (plan §9.4 "older copy → Remove it / Keep").
    if (!conflictName && !i.copyAnswer[sib] && relation !== "older") {
      addBanner(key, { id: `copy:${sib}`, kind: "copyQuestion", name: t.title, path: sib, folderLabel: labelOf(sib) });
      return;
    }
    extraCopyBanner(key, sib, r.file, relation);
  }

  function extraCopyBanner(key: string, sib: string, f: GraphFileData, relation: "older" | "same" | "newer" | "diverged"): void {
    addBanner(key, {
      id: `copy:${sib}`, kind: "extraCopy", name: fileStem(sib), path: sib, folderLabel: labelOf(sib), relation,
      version: vi(f.manifest, f.manifest.head),
      // Older / same: it can be removed (moved into the app's folder) or kept. A strictly newer copy (a
      // colleague's edited copy saved next to mine) can be taken into my file; a diverged one combined.
      actions: relation === "older" || relation === "same" ? ["remove", "keep"] : relation === "newer" ? ["updateMine", "notSame", "later"] : ["combine", "notSame", "later"],
      dismissible: true,
    });
    if (relation === "diverged") it(key).bannerSource.set(`copy:${sib}`, { kind: "copy", path: sib });
    touchVersions(key);
  }

  /** "Update my file with it" on a newer copy beside the open file: its versions are saved over my file
   *  (my file's versions are all in its history, so nothing is lost), then the tab follows. */
  async function takeNewerCopy(key: string, bannerId: string, copyPath: string): Promise<void> {
    const t = tabOf(key);
    if (!t?.path || !t.analysisId) return;
    const q = await readFile(copyPath);
    const h = await backend.header(t.path);
    if (!q.ok || !h.ok || q.file.manifest.analysis_id !== t.analysisId || h.header.analysis_id !== t.analysisId) {
      toast({ tone: "error", kind: "error", message: `'${fileStem(t.path)}' can't be updated right now.` });
      return;
    }
    if (!isStrictAncestor(q.file.manifest, h.header.head, q.file.manifest.head)) {
      toast({ tone: "error", kind: "error", message: `'${fileStem(copyPath)}' isn't newer than this file any more. Nothing was replaced.` });
      removeBanners(key, (x) => x.id === bannerId);
      return;
    }
    patchTab(key, { saving: true });
    let res: SaveResult;
    try {
      res = await backend.save({
        path: t.path, expectedHead: h.header.head, analysisId: t.analysisId, docKey: key, manifest: q.file.manifest, newParts: q.file.parts,
      });
    } finally { patchTab(key, { saving: false }); }
    if (!res.ok) {
      toast({ tone: "error", kind: "error", message: res.kind === "conflict" ? `'${fileStem(t.path)}' was changed meanwhile. Nothing was replaced.` : `'${fileStem(t.path)}' couldn't be updated.` });
      return;
    }
    removeBanners(key, (x) => x.id === bannerId);
    const i = it(key);
    i.copyAnswer = { ...i.copyAnswer, [copyPath]: "same" };
    await saveSession();
    // Clean tab: shows the new version at once; unsaved changes stay, with the newer-version banner.
    await onHead(key, res.head);
  }

  /** "A separate analysis": the copy gets its own analysis id (forked_from this one). */
  async function makeSeparate(key: string, sib: string): Promise<boolean> {
    const r = await readFile(sib);
    if (!r.ok) { toast({ tone: "error", kind: "error", message: openFailedMessage(r.code, fileStem(sib)) }); return false; }
    const m = r.file.manifest;
    const head = revisionOf(m, m.head)!;
    const aid = newAnalysisId();
    const rev: Revision = {
      ...makeRev({
        id: newRevisionId(now()), parents: [m.head], kind: "save", time: now(), author: author(), summary: SUMMARY.separated,
        parts: { refs: head.sections!, texts: {}, contentHash: head.content_hash },
      }),
    };
    const manifest: Manifest = { ...withRevision(m, rev, author()), analysis_id: aid, forked_from: { analysis_id: m.analysis_id, revision_id: m.head } };
    const owner = tabByPath(sib);
    const res = await backend.save({
      path: sib, expectedHead: null, replaceExisting: true, analysisId: aid, docKey: owner?.key ?? newDocKey(), manifest, newParts: r.file.parts,
    });
    if (!res.ok) {
      addBanner(key, { kind: "saveFailed", message: res.kind === "error" ? saveFailedMessage(res.code) : saveFailedMessage("Io") });
      return false;
    }
    if (owner) {
      it(owner.key).manifest = manifest;
      patchTab(owner.key, { analysisId: aid, baseRevision: res.head });
      if (isLoaded(owner.key)) graph.getState().setFileRef({ analysisId: aid, baseRevision: res.head });
      backend.track(sib, { active: get().activeKey === owner.key });
    }
    const i = it(key);
    i.knownCopies = [...i.knownCopies, sib];
    removeBanners(key, (b) => b.id === `copy:${sib}`);
    if (recentEntries.some((e) => e.path === sib)) await writeRecent(recentEntries.map((e) => (e.path === sib ? { ...e, analysis_id: aid } : e)));
    await saveSession();
    return true;
  }

  // ── poll events (contract §4.7) ──

  /** Banners about extra copies that are no longer there (removed or combined on another computer) go quietly. */
  async function dropGoneCopies(key: string): Promise<void> {
    const t = tabOf(key);
    if (!t) return;
    for (const b of t.banners) {
      if ((b.kind !== "extraCopy" && b.kind !== "copyQuestion") || !b.path) continue;
      const h = await quietly(backend.header(b.path), null);
      if (h && !h.ok && h.code === "NotFound") forgetCopy(key, b.path);
    }
  }

  async function onFileEvent(e: FileEvent): Promise<void> {
    if (e.type === "presence") { if ("notes" in e && Array.isArray(e.notes)) onPresenceEvent(e.path, e.notes); return; }
    if (e.type === "wake") { onWakeEvent(); return; }
    if (e.type !== "moved") { const t0 = tabByPath(e.path); if (t0) await dropGoneCopies(t0.key); }
    if (e.type === "moved") {
      const t = tabByPath(e.from);
      if (!t) {
        if (recentEntries.some((r) => r.path === e.from)) await replaceRecent(e.from, e.to, recentEntries.find((r) => r.path === e.from)!.analysis_id);
        return;
      }
      if (t.saving) return;
      await repoint(t.key, e.to, { recent: "replace" });
      const i = it(t.key);
      i.seenCopies = i.seenCopies.filter((p) => p !== e.to);
      // Phase 3: the note follows the file (repoint → presenceRepath, fixer round 2 RV-2).
      // Only the way the name is stored changed (Unicode form): nothing to tell.
      if (e.from.normalize("NFC") !== e.to.normalize("NFC")) toast({ tone: "info", kind: "renamed", name: fileStem(e.to) });
      if (e.head && e.head !== tabOf(t.key)?.baseRevision) await onHead(t.key, e.head);
      return;
    }
    const t = tabByPath(e.path);
    if (!t || t.saving) return;
    const key = t.key;
    switch (e.type) {
      case "missing":
        addBanner(key, {
          kind: "missing", name: t.title, folderLabel: t.folderLabel, candidates: e.candidates.map((p) => ({ path: p, name: fileStem(p) })),
        });
        presenceGone(key);
        return;
      case "back":
        removeKinds(key, ["missing", "downloading", "permission", "replaced"]);
        it(key).pr.gone = false;
        if (isCard(t.status)) { await retryTab(key, false); return; }
        if (t.analysisId) { await presenceOpen(key, e.path, t.analysisId); evaluate(key); }
        await onHead(key, e.head);
        return;
      case "changed":
        removeKinds(key, ["downloading"]);
        await onHead(key, e.head);
        return;
      case "unreadable":
        if (e.reason === "PermissionDenied") addBanner(key, { kind: "permission" });
        else addBanner(key, { kind: "downloading", service: t.service });
        return;
      case "replaced":
        addBanner(key, { kind: "replaced", name: t.title });
        presenceGone(key);
        return;
      case "sibling":
        await handleSibling(key, e.sibling);
        return;
    }
  }

  /** The file at a tab's path has head H (changed / back / moved): phase 2 contract §5.5 table A. */
  async function onHead(key: string, _h: string): Promise<void> {
    const t = tabOf(key);
    if (!t?.path || t.saving || isCard(t.status) || t.status === "opening") return;
    const i = it(key);
    // A combine of this tab is waiting, running or open: the file is looked at again once it is done.
    if (i.autoTimer || i.combining > 0 || i.combine || savesInFlight.has(key)) { i.recheck = true; return; }
    const serial0 = graph.getState().editSerial;
    const base0 = t.baseRevision;
    const r = await readFile(t.path);
    if (!r.ok) return;
    const t1 = tabOf(key);
    if (!t1 || t1.saving || t1.path !== t.path) return;
    if (i.autoTimer || i.combining > 0 || i.combine) { i.recheck = true; return; }
    const m = r.file.manifest;
    const H = m.head;
    if (m.analysis_id !== t1.analysisId) return;
    // A "put back to an earlier version" note no longer fits once the file moved on from that earlier version
    // (another computer saved on top of it): the routing below decides again.
    const rb = t1.banners.find((b) => b.kind === "rolledBack");
    const rbHead = rb ? i.bannerData.get(rb.id) : undefined;
    if (rb && rbHead && H !== rb.version?.head) {
      const jm = await readJournalFile(m.analysis_id, rbHead);
      if (!jm || !isAncestorOrSelfIn(unionRevisions(m, jm.manifest), H, rbHead)) removeBanners(key, (b) => b.id === rb.id);
    }
    if (H === t1.baseRevision) {
      i.manifest = m;
      cancelHeld(key);
      removeKinds(key, ["newerOnDisk"]);
      return;
    }
    // Phase 3 §5.6: a newer version arriving in the after-sleep window ends it (then the usual routing).
    if (i.pr.resume) endResume(key, "newer");
    const inv = await invariantCheck(key, m);
    if (inv === "rolledBack" || inv === "journal") return;
    const R = tabOf(key)?.baseRevision ?? null;
    if (!R) return;
    const mineM = i.manifest ?? (t1.analysisId ? (await readJournalFile(t1.analysisId, R))?.manifest ?? null : null);
    const revs = unionRevisions(m, ...(mineM ? [mineM] : []));
    const rel = relation(revs, R, H);
    if (rel === "same" || rel === "older") return;      // older: the journal check above shows a rollback
    const dirty = tabDirty(key);
    if (rel === "newer") {
      if (!dirty) { await showNewer(key, r, serial0, base0); return; }
      addBanner(key, { kind: "newerOnDisk", version: vi(m, H), actions: ["combine", "later"] });
      i.bannerSource.set("newerOnDisk", { kind: "disk" });
      return;
    }
    // Diverged: another computer's save replaced the version this tab is based on.
    if (!dirty) { await autoCombine(key, { kind: "disk" }); return; }
    chooseBanner(key, { kind: "disk" }, vi(m, H));
  }

  /** Table A "newer" on a clean tab: the version on disk is shown in place (held back while something is
   *  being edited); a background tab's base just moves. */
  async function showNewer(key: string, r: Extract<ReadResult, { ok: true }>, serial0: number, base0: string | null): Promise<void> {
    const t = tabOf(key)!;
    const m = r.file.manifest;
    const H = m.head;
    const i = it(key);
    if (!isLoaded(key)) {
      i.manifest = m;
      patchTab(key, { baseRevision: H, readOnly: r.readOnly, dirty: false });
      removeKinds(key, ["newerOnDisk", "rolledBack"]);
      await saveSession();
      return;
    }
    const c = openFile(r.file);
    if (!c) return;
    const path = t.path!;
    await applyWhenFree(key, async () => {
      if (!isLoaded(key)) {
        // The tab was left while this waited: a background tab without kept changes just moves on.
        const tb = tabOf(key);
        if (!tb) return;
        if (!tb.dirty && !it(key).hasDraft && tb.baseRevision === base0) {
          it(key).manifest = m;
          patchTab(key, { baseRevision: H, readOnly: r.readOnly, dirty: false });
          removeKinds(key, ["newerOnDisk", "rolledBack"]);
          await saveSession();
        } else if (tb.baseRevision !== H) {
          addBanner(key, { kind: "newerOnDisk", version: vi(m, H), actions: ["combine", "later"] });
          it(key).bannerSource.set("newerOnDisk", { kind: "disk" });
        }
        return;
      }
      const ok = replaceInPlace(key, { content: c, head: H, manifest: m, path, expectedBase: base0, expectedSerial: serial0, readOnly: r.readOnly });
      if (!ok) {
        // Something was typed meanwhile: it stays; the newer version is offered.
        if (tabOf(key)?.baseRevision !== H) {
          addBanner(key, { kind: "newerOnDisk", version: vi(m, H), actions: ["combine", "later"] });
          it(key).bannerSource.set("newerOnDisk", { kind: "disk" });
        }
        return;
      }
      removeKinds(key, ["newerOnDisk", "rolledBack", "combined"]);
      // A "Choose…" / "combining" note whose other version is in this one now is answered.
      removeBanners(key, (b) => b.kind === "savedOver" && !!b.state && !!b.version?.head && isAncestorOrSelf(m, b.version.head, H));
      // Phase 3 §5.7: where another computer's note is (or was) seen, the status line says it instead of a toast.
      if (!it(key).pr.hadForeignNote) toast({ tone: "info", kind: "reloaded", version: vi(m, H) });
      releaseIfClean(key);
      await quietly(backend.deleteDraft(key), undefined);
      it(key).hasDraft = false;
      await saveSession();
    });
  }

  // ── save ──

  async function workingOf(key: string): Promise<Working | null> {
    const t = tabOf(key)!;
    const i = it(key);
    const reuse = i.lastWorking;
    let c: DocContent | null;
    let serial: number | undefined;
    const draftSeq = i.draftSeq;
    if (isLoaded(key)) {
      c = content();
      serial = graph.getState().editSerial;
    } else {
      const d = await backend.readDraft(key);
      c = d ? contentOfDraft(d) : null;
    }
    if (!c) return null;
    let manifest = i.manifest;
    if ((!manifest || !revisionOf(manifest, t.baseRevision)) && t.analysisId && t.baseRevision) {
      manifest = (await readJournalFile(t.analysisId, t.baseRevision))?.manifest ?? manifest;
    }
    if (!manifest) return null;
    const parts = await partsOf(sectionsOf(c));
    const baseRev = revisionOf(manifest, t.baseRevision);
    // The same content on the same base as the working copy built last time (a Save or combine tried again):
    // the same version, so this computer's saved copies don't fill up with copies nobody can tell apart.
    const same = !!reuse && reuse.parts.contentHash === parts.contentHash
      && (reuse.rev.parents[0] ?? null) === (t.baseRevision ?? null) && reuse.rev.parents.length === (t.baseRevision ? 1 : 0);
    const rev = same ? reuse!.rev : makeRev({
      id: newRevisionId(now()), parents: t.baseRevision ? [t.baseRevision] : [], kind: "save", time: now(), author: author(),
      summary: summaryText({ kind: "save", root: !t.baseRevision, prev: baseRev?.sections, next: parts.refs }), parts,
    });
    // Versions dropped by "Use the earlier version" come back into the file's history (§5.5 B).
    let extraParts: Record<string, string> | undefined;
    if (i.carryHeads.length && t.analysisId) {
      for (const h of i.carryHeads) {
        const jf = await readJournalFile(t.analysisId, h);
        if (!jf || jf.manifest.analysis_id !== manifest.analysis_id) continue;
        manifest = unionManifests(manifest, jf.manifest);
        extraParts = { ...(extraParts ?? {}), ...jf.parts };
      }
    }
    const m = await retain(withRevision(manifest, rev, author(), c.doc.template), [t.baseRevision]);
    const w: Working = { content: c, parts, rev, manifest: m, serial, draftSeq, ...(extraParts ? { extraParts } : {}) };
    i.lastWorking = w;
    return w;
  }

  /** Parts a save sends: those the base revision doesn't reference (plus versions taken in from saved copies). */
  function newPartsFor(w: Working, base: string | null): Record<string, string> {
    const baseRev = revisionOf(w.manifest, base);
    const have = new Set(baseRev?.sections ? Object.values(baseRev.sections).map((r) => r.part) : []);
    const out = Object.fromEntries(Object.entries(w.parts.texts).filter(([k]) => !have.has(k)));
    if (w.extraParts) {
      const used = new Set<string>();
      for (const r of w.manifest.revisions) if (r.sections) for (const n of SECTION_NAMES) used.add(r.sections[n].part);
      for (const [k, v] of Object.entries(w.extraParts)) if (used.has(k) && !have.has(k) && !(k in out)) out[k] = v;
    }
    return out;
  }

  /** One save per tab at a time: a second Save while one runs gets the running one's outcome
   *  (two saves on the same base would end in a conflict with myself). */
  const savesInFlight = new Map<string, Promise<SaveOutcome>>();
  function saveImpl(key: string): Promise<SaveOutcome> {
    const running = savesInFlight.get(key);
    if (running) return running;
    // Phase 3 §5.6: Save in the after-sleep window asks first.
    if (tabOf(key) && it(key).pr.resume) {
      return (async (): Promise<SaveOutcome> => {
        if (!(await resumeAsk(key, "save"))) return { ok: false, reason: "cancelled" };
        return saveImpl(key);
      })();
    }
    const run = saveOnce(key).finally(() => { if (savesInFlight.get(key) === run) savesInFlight.delete(key); });
    savesInFlight.set(key, run);
    return run;
  }

  /** Save once more inside the running save (after the tab's base was moved); never loops. */
  let againDepth = 0;
  async function saveOnceAgain(key: string): Promise<SaveOutcome> {
    if (againDepth > 0) return { ok: false, reason: "conflict" };
    againDepth++;
    try { return await saveOnce(key); } finally { againDepth--; }
  }

  async function saveOnce(key: string): Promise<SaveOutcome> {
    const t = tabOf(key);
    if (!t) return { ok: false, reason: "nothing" };
    if (t.saving) return { ok: false, reason: "nothing" };
    const loaded = isLoaded(key);
    if (loaded) deps.flushScratch({ commitEdit: true });
    if (t.path === null) {
      if (get().activeKey !== key) await switchTabImpl(key);
      return saveAsImpl("new");
    }
    // Phase 3 §5.5: a read-only tab writes nothing into its file.
    if (presenceBlocks(key, "save")) return { ok: false, reason: "readOnly" };
    if (t.readOnly) { addBanner(key, { kind: "tooNew" }); return { ok: false, reason: "failed" }; }
    if (isCard(t.status) || t.status === "opening") return { ok: false, reason: "failed" };
    // A combine nobody asked for is waiting: Save does it now (§5.4.1).
    const i0 = it(key);
    if (i0.autoTimer || (i0.combinePending && !tabDirty(key))) {
      const src: CombineSource = i0.combinePending?.source === "journal" ? { kind: "journal", revisionId: i0.combinePending.theirs } : { kind: "disk" };
      cancelAuto(key);
      if (!tabDirty(key)) return startCombineCore(key, src, "save", {});
    }
    if (!loaded && !t.dirty) return { ok: false, reason: "nothing" };
    if (loaded && graph.getState().scratch.length > SCRATCH_LIMIT) {
      addBanner(key, { kind: "saveFailed", message: "The Scratchpad is too large to save. Clear some cells, then try again." });
      return { ok: false, reason: "failed" };
    }
    const w = await workingOf(key);
    if (!w) return loaded ? (addBanner(key, { kind: "saveFailed", message: saveFailedMessage("Invalid") }), { ok: false, reason: "failed" }) : { ok: false, reason: "nothing" };
    const base = t.baseRevision;
    const baseRev = revisionOf(w.manifest, base);
    if (baseRev && baseRev.content_hash === w.parts.contentHash) {
      // Nothing to write: the content is the base version.
      if (loaded) graph.getState().markFileSaved({ docKey: key, analysisId: t.analysisId, baseRevision: base, path: t.path }, t.title, roundTrip(w.content), w.serial);
      await quietly(backend.deleteDraft(key), undefined);
      it(key).hasDraft = false;
      patchTab(key, { dirty: loaded ? isDirty(graph.getState()) : false });
      removeKinds(key, ["saveFailed"]);
      return { ok: true, path: t.path };
    }
    patchTab(key, { saving: true });
    let res: SaveResult;
    try {
      res = await backend.save({ path: t.path, expectedHead: base, analysisId: t.analysisId!, docKey: key, manifest: w.manifest, newParts: newPartsFor(w, base) });
    } finally { patchTab(key, { saving: false }); }
    return afterSave(key, res, w, "save");
  }

  async function afterSave(key: string, res: SaveResult, w: Working, origin: "save" | "keepMine"): Promise<SaveOutcome> {
    const t = tabOf(key)!;
    const i = it(key);
    const aid = w.manifest.analysis_id;
    switch (res.kind) {
      case "saved": case "savedButDisplaced": {
        i.manifest = w.manifest;
        i.conflict = null;
        if (res.path !== t.path) {
          await repoint(key, res.path, { recent: "replace" });
          toast({ tone: "info", kind: "renamed", name: fileStem(res.path) });
        }
        const path = res.path;
        const title = fileStem(path);
        if (w.extraParts) i.carryHeads = [];
        patchTab(key, { baseRevision: res.head, notSaved: false });
        // The note about an earlier combine goes with the next save (its Undo would no longer mean that combine).
        removeKinds(key, ["saveFailed", "notSaved", "newerOnDisk", "missing", "savedAside", "replaced", "rolledBack", "recovered", "tookTheirs", "combined"]);
        i.lastWorking = null;
        // A working copy set aside for a dialog earlier and now really saved is a save of mine like any other:
        // if another computer's save replaces it later, it must be offered again.
        if (i.settled.includes(w.rev.id)) i.settled = i.settled.filter((x) => x !== w.rev.id);
        if (isLoaded(key)) {
          graph.getState().markFileSaved({ docKey: key, analysisId: aid, baseRevision: res.head, path }, title, roundTrip(w.content), w.serial);
          const dirty = isDirty(graph.getState());
          patchTab(key, { dirty });
          if (dirty) await writeActiveDraft(false); else { await quietly(backend.deleteDraft(key), undefined); i.hasDraft = false; }
        } else {
          // The tab was left while the save ran. Its kept changes were written when it was left: they
          // may hold edits made during the save, which must stay (now on top of the saved version).
          const same = w.serial !== undefined ? i.draftSerialAt === w.serial : i.draftSeq === w.draftSeq;
          const d = same ? null : await quietly(backend.readDraft(key), null);
          if (d) {
            await putDraft(key, { ...d, base_revision: res.head, path, analysis_id: aid }, i.draftSerialAt);
            i.hasDraft = true;
            patchTab(key, { dirty: true });
          } else {
            await quietly(backend.deleteDraft(key), undefined);
            i.hasDraft = false;
            patchTab(key, { dirty: false });
          }
        }
        // Phase 3 (D6): the note gets the new version at once and stays "editing"; the 30 s start again.
        i.pr.lastSaveAt = now();
        i.pr.editHereHold = false;
        if (i.pr.holding) restartLinger(key);
        evaluate(key);
        await touchRecent(path, aid);
        await saveSession();
        toast({ tone: "success", kind: "saved", name: title });
        touchVersions(key);
        if (res.kind === "savedButDisplaced") {
          // Another computer's save landed in the gap: combined with it (§5.5 C).
          const D = res.displacedHead;
          const j = await quietly(readJournalFile(aid, D), null);
          if (j) {
            if (!tabDirty(key)) await autoCombine(key, { kind: "journal", revisionId: D });
            else chooseBanner(key, { kind: "journal", revisionId: D }, vi(j.manifest, D));
          }
        }
        // Files saved beside it earlier (could not be checked): extra copies now (§5.5 C, D). Copies seen before
        // (answered "Later", or not answered) are looked at again after every save (§5.5 D).
        for (const a of [...new Set([...i.asides, ...i.seenCopies])]) if (a !== path) await quietly(handleSibling(key, a), undefined);
        void origin;
        return { ok: true, path };
      }
      case "savedAside":
        i.asides = addUnique(i.asides, res.path);
        addBanner(key, { kind: "savedAside", name: fileStem(res.path), path: res.path });
        if (isLoaded(key)) await writeActiveDraft(false);
        await saveSession();
        return { ok: false, reason: "failed" };
      case "conflict":
        return origin === "keepMine" ? enterConflict(key, w, "save") : combineOnSave(key, w, againDepth === 0);
      case "missing":
        addBanner(key, { kind: "missing", name: t.title, folderLabel: t.folderLabel, candidates: [] });
        toast({ tone: "error", kind: "error", message: "Not saved — the file can't be found. Use Find it… or save a new copy." });
        return { ok: false, reason: "failed" };
      case "error":
        addBanner(key, { kind: "saveFailed", message: saveFailedMessage(res.code) });
        return { ok: false, reason: "failed" };
    }
  }

  /** Read theirs, journal my working copy as a real revision, open the conflict sheet. */
  async function enterConflict(key: string, w: Working, origin: "save" | "banner"): Promise<SaveOutcome> {
    const t = tabOf(key)!;
    const r = await readFile(t.path!);
    if (!r.ok) {
      addBanner(key, { kind: "saveFailed", message: "The file was changed on another computer and can't be read yet. Try again in a moment." });
      return { ok: false, reason: "failed" };
    }
    const fileW: GraphFileData = { manifest: w.manifest, parts: { ...w.parts.texts } };
    await quietly(backend.writeJournal(t.path!, fileW), undefined);
    const i = it(key);
    i.conflict = { ...w, theirs: r.file, base: t.baseRevision };
    if (!i.settled.includes(w.rev.id)) i.settled = [...i.settled, w.rev.id];
    patchTab(key, { notSaved: true });
    removeKinds(key, ["newerOnDisk", "notSaved"]);
    await saveSession();
    set({ dialog: { kind: "conflict", info: { tabKey: key, name: t.title, theirs: vi(r.file.manifest, r.file.manifest.head), base: t.baseRevision, origin } } });
    return { ok: false, reason: "conflict" };
  }

  /** "Mine" in a conflict is what the tab holds now: edits made after the working copy was built
   *  (typed while the save ran, or kept changes written since) are taken in, and journaled. */
  async function refreshConflict(key: string, c: ConflictCtx): Promise<{ c: ConflictCtx; changed: boolean }> {
    const i = it(key);
    const stale = isLoaded(key)
      ? c.serial === undefined || graph.getState().editSerial !== c.serial
      : c.serial !== undefined || i.draftSeq !== c.draftSeq;
    if (!stale) return { c, changed: false };
    if (isLoaded(key)) deps.flushScratch({ commitEdit: true });
    const w = await workingOf(key);
    if (!w) return { c, changed: false };
    if (w.parts.contentHash === c.parts.contentHash) {
      const same = { ...c, serial: w.serial, draftSeq: w.draftSeq };
      i.conflict = same;
      return { c: same, changed: false };
    }
    const t = tabOf(key);
    if (t?.path) await quietly(backend.writeJournal(t.path, { manifest: w.manifest, parts: { ...w.parts.texts } }), undefined);
    if (!i.settled.includes(w.rev.id)) i.settled = [...i.settled, w.rev.id];
    const next: ConflictCtx = { ...w, theirs: c.theirs, base: c.base };
    i.conflict = next;
    return { c: next, changed: true };
  }

  async function resolveConflictImpl(choice: ConflictChoice): Promise<void> {
    const d = get().dialog;
    if (!d || d.kind !== "conflict") return;
    const key = d.info.tabKey;
    const t = tabOf(key);
    const c0 = it(key).conflict;
    set({ dialog: null });
    if (!t || !c0) return;
    const theirsHead = c0.theirs.manifest.head;
    const notSavedBanner = () => addBanner(key, { kind: "notSaved", version: vi(c0.theirs.manifest, theirsHead) });
    if (choice === "cancel") { notSavedBanner(); return; }
    let c = (await refreshConflict(key, c0)).c;
    const aid = c.manifest.analysis_id;
    const fetch = (rid: string) => readJournalFile(aid, rid);

    if (choice === "keepMine") {
      const kid = await mergeRevisionId([theirsHead, c.rev.id], c.parts.contentHash);
      const k: Revision = {
        ...makeRev({
          id: kid, parents: [theirsHead, c.rev.id], kind: "merge", time: now(), author: author(),
          summary: summaryText({ kind: "merge", root: false, auto: false, prev: null, next: c.parts.refs }), parts: c.parts,
        }),
      };
      const union = unionManifests(c.theirs.manifest, c.manifest);
      const m = await retain(withRevision(union, k, author(), c.content.doc.template), [theirsHead, c.rev.id]);
      const done = await completeParts(m, { ...c.theirs.parts, ...c.parts.texts }, fetch);
      if (!done) { addBanner(key, { kind: "saveFailed", message: saveFailedMessage("Invalid") }); notSavedBanner(); return; }
      patchTab(key, { saving: true });
      let res: SaveResult;
      try {
        res = await backend.save({ path: t.path!, expectedHead: theirsHead, analysisId: aid, docKey: key, manifest: done.manifest, newParts: partsNotIn(done.parts, c.theirs) });
      } finally { patchTab(key, { saving: false }); }
      if (res.kind === "conflict") { await enterConflict(key, c, "save"); return; }
      const out = await afterSave(key, res, { ...c, manifest: done.manifest }, "keepMine");
      if (!out.ok && res.kind !== "savedAside") notSavedBanner();
      return;
    }

    if (choice === "takeTheirs") {
      // My version goes into a copy first. Anything typed while that copy is written goes into a
      // newer copy (nothing typed is ever dropped by loading theirs).
      let copy: string | null = null;
      let pending = true;
      const i = it(key);
      for (let attempt = 0; attempt < 5 && pending; attempt++) {
        const mine = await completeParts(c.manifest, { ...c.parts.texts, ...c.theirs.parts }, fetch);
        const written = mine ? await writeCopyBeside(t.path!, `(my version from ${device?.device_name || "this computer"})`, { manifest: mine.manifest, parts: mine.parts }) : null;
        if (!written) break;
        copy = written;
        i.knownCopies = addUnique(i.knownCopies, written);
        const again = await refreshConflict(key, c);
        c = again.c;
        pending = again.changed;
      }
      if (!copy || pending) { addBanner(key, { kind: "saveFailed", message: "Your version couldn't be saved as a copy, so nothing was changed." }); notSavedBanner(); return; }
      if (!i.settled.includes(c.rev.id)) i.settled = [...i.settled, c.rev.id];
      const theirs = openFile(c.theirs);
      if (isLoaded(key) && theirs) {
        suppress++;
        try {
          graph.getState().loadFile({ file: { docKey: key, analysisId: aid, baseRevision: theirsHead, path: t.path }, name: t.title, ...theirs, saved: true, inPlace: true });
        } finally { suppress--; }
      }
      i.manifest = c.theirs.manifest;
      i.conflict = null;
      i.hasDraft = false;
      await quietly(backend.deleteDraft(key), undefined);
      patchTab(key, { baseRevision: theirsHead, notSaved: false, dirty: isLoaded(key) ? isDirty(graph.getState()) : false });
      removeKinds(key, ["notSaved", "newerOnDisk"]);
      addBanner(key, { kind: "tookTheirs", name: fileStem(copy), path: copy, version: vi(c.theirs.manifest, theirsHead) });
      releaseIfClean(key);
      await saveSession();
      return;
    }

    // separateCopy: mine as a new analysis in a place the person picks; this file is left as it is.
    await separateCopyImpl(key, c);
  }

  /** "Save mine as a separate copy" / "Keep both as separate files" (source disk). */
  async function separateCopyImpl(key: string, c0: ConflictCtx): Promise<void> {
    let c = c0;
    const t = tabOf(key);
    if (!t?.path) return;
    const aid = c.manifest.analysis_id;
    const theirsHead = c.theirs.manifest.head;
    const notSavedBanner = () => addBanner(key, { kind: "notSaved", version: vi(c.theirs.manifest, theirsHead) });
    it(key).conflict = c;
    const picked = await pickPath({ mode: "save", title: "Save my version as a separate copy", suggestedName: `${safeFileName(`${t.title} (my copy)`)}.lag`, startDir: parentDir(t.path!) });
    if (!picked) { notSavedBanner(); patchTab(key, { notSaved: true }); return; }
    const path = withGraphExt(picked);
    if (tabByPath(path) && tabByPath(path)!.key !== key) {
      addBanner(key, { kind: "saveFailed", message: "That file is open in another tab. Choose another name." });
      notSavedBanner();
      return;
    }
    c = (await refreshConflict(key, c)).c;
    const newAid = newAnalysisId();
    const file = await newFile({ content: c.content, analysisId: newAid, forkedFrom: { analysis_id: aid, revision_id: c.base ?? theirsHead }, time: now(), author: author(), summary: SUMMARY.first });
    const res = await backend.save({ path, expectedHead: null, replaceExisting: true, analysisId: newAid, docKey: key, manifest: file.manifest, newParts: file.parts });
    if (!res.ok) {
      addBanner(key, { kind: "saveFailed", message: res.kind === "error" ? saveFailedMessage(res.code) : saveFailedMessage("Io") });
      notSavedBanner();
      return;
    }
    const i = it(key);
    if (!i.settled.includes(c.rev.id)) i.settled = [...i.settled, c.rev.id];
    // My version (and the version it was made on) lives on in the new file: the old file doesn't ask about it again.
    if (c.base && !i.settled.includes(c.base)) i.settled = [...i.settled, c.base];
    rememberTab(key);
    i.lastSource = null;
    await moveTabToNewFile(key, res.path, res.head, file.manifest, c.content, c.serial, true);
  }

  /** After Save As / separate copy: the tab is the new file now (the old path stays in Recent). */
  async function moveTabToNewFile(key: string, path: string, head: string, manifest: Manifest, c: DocContent, serial: number | undefined, newAnalysis: boolean): Promise<void> {
    const t = tabOf(key)!;
    const i = it(key);
    const old = t.path;
    if (old && old !== path) backend.untrack(old);
    i.manifest = manifest;
    i.conflict = null;
    i.acceptedHead = null;
    if (newAnalysis) { i.knownCopies = []; i.copyAnswer = {}; i.settled = []; i.seenCopies = []; }
    else if (old && old !== path && !i.knownCopies.includes(old)) i.knownCopies = [...i.knownCopies, old];
    const title = fileStem(path);
    patchTab(key, {
      path, title, folderLabel: labelOf(path), service: serviceOf(path), analysisId: manifest.analysis_id, baseRevision: head,
      readOnly: null, notSaved: false, banners: [], status: "ready",
    });
    if (isLoaded(key)) {
      graph.getState().markFileSaved({ docKey: key, analysisId: manifest.analysis_id, baseRevision: head, path }, title, roundTrip(c), serial);
      patchTab(key, { dirty: isDirty(graph.getState()) });
    }
    if (tabDirty(key)) await writeActiveDraft(false); else { await quietly(backend.deleteDraft(key), undefined); i.hasDraft = false; }
    await touchRecent(path, manifest.analysis_id);
    await saveSession();
    backend.track(path, { active: get().activeKey === key });
    presenceRepath(key, old, path);
    toast({ tone: "success", kind: "saved", name: title });
  }

  async function saveAsImpl(mode: SaveAsMode = "ask"): Promise<SaveOutcome> {
    const key = get().activeKey;
    const t = tabOf(key);
    if (!key || !t || !isLoaded(key)) return { ok: false, reason: "nothing" };
    if (mode === "same" && t.path && presenceBlocks(key, "saveAs")) return { ok: false, reason: "readOnly" };
    deps.flushScratch({ commitEdit: true });
    const picked = await pickPath({
      mode: "save", title: "Save As", suggestedName: `${safeFileName(t.title)}.lag`, startDir: t.path ? parentDir(t.path) : null,
    });
    if (!picked) return { ok: false, reason: "cancelled" };
    const path = withGraphExt(picked);
    const other = tabByPath(path);
    if (other && other.key !== key) {
      addBanner(key, { kind: "saveFailed", message: "That file is open in another tab. Close it first or choose another name." });
      return { ok: false, reason: "failed" };
    }
    let kind: "new" | "same" = mode === "same" ? "same" : "new";
    if (t.path === null) kind = "new";
    else if (mode === "ask") {
      const a = await ask({
        kind: "saveAsKind", path, name: fileStem(path), folderLabel: labelOf(path),
        preselect: isTempLocation(t.path, info.tempDirs) ? "same" : "new",
      });
      set({ dialog: null });
      if (a.kind !== "saveAsKind" || a.choice === "cancel") return { ok: false, reason: "cancelled" };
      kind = a.choice;
      if (kind === "same" && presenceBlocks(key, "saveAs")) return { ok: false, reason: "readOnly" };
    }
    const c = content();
    const serial = graph.getState().editSerial;
    let req: SaveRequest;
    if (kind === "new") {
      const aid = t.path === null ? t.analysisId ?? newAnalysisId() : newAnalysisId();
      const forked = t.path !== null && t.analysisId && t.baseRevision ? { analysis_id: t.analysisId, revision_id: t.baseRevision } : null;
      const file = await newFile({ content: c, analysisId: aid, forkedFrom: forked, time: now(), author: author(), summary: SUMMARY.first });
      req = { path, expectedHead: null, replaceExisting: true, analysisId: aid, docKey: key, manifest: file.manifest, newParts: file.parts };
    } else {
      const w = await workingOf(key);
      if (!w) { addBanner(key, { kind: "saveFailed", message: saveFailedMessage("Invalid") }); return { ok: false, reason: "failed" }; }
      const baseRev = revisionOf(w.manifest, t.baseRevision);
      const unchanged = !!baseRev && baseRev.content_hash === w.parts.contentHash && it(key).manifest?.head === t.baseRevision;
      const m = unchanged ? { ...it(key).manifest! } : w.manifest;
      const aid = m.analysis_id;
      // Every stored version comes along: from the file itself (it has versions this computer
      // never saw as the newest), else from the full copy of the base version this computer keeps.
      const src = t.path ? await readFile(t.path) : null;
      let have: Record<string, string> = src?.ok && src.file.manifest.analysis_id === aid ? { ...src.file.parts } : {};
      if (!src?.ok && t.baseRevision) have = { ...((await readJournalFile(aid, t.baseRevision))?.parts ?? {}) };
      const done = await completeParts(m, { ...have, ...w.parts.texts }, (rid) => readJournalFile(aid, rid));
      if (!done) { addBanner(key, { kind: "saveFailed", message: saveFailedMessage("Invalid") }); return { ok: false, reason: "failed" }; }
      req = { path, expectedHead: null, replaceExisting: true, analysisId: aid, docKey: key, manifest: done.manifest, newParts: done.parts };
    }
    patchTab(key, { saving: true });
    let res: SaveResult;
    try { res = await backend.save(req); } finally { patchTab(key, { saving: false }); }
    if (!res.ok) {
      addBanner(key, { kind: "saveFailed", message: res.kind === "error" ? saveFailedMessage(res.code) : saveFailedMessage("Io") });
      return { ok: false, reason: "failed" };
    }
    await moveTabToNewFile(key, res.path, res.head, req.manifest, c, serial, kind === "new");
    return { ok: true, path: res.path };
  }

  async function duplicateImpl(): Promise<SaveOutcome> {
    const key = get().activeKey;
    const t = tabOf(key);
    if (!key || !t || !isLoaded(key)) return { ok: false, reason: "nothing" };
    if (get().tabs.length >= LIMITS.tabCap) { toast({ tone: "warning", kind: "tabLimit" }); return { ok: false, reason: "failed" }; }
    deps.flushScratch({ commitEdit: true });
    const picked = await pickPath({
      mode: "save", title: "Duplicate as a new analysis", suggestedName: `${safeFileName(`${t.title} copy`)}.lag`, startDir: t.path ? parentDir(t.path) : null,
    });
    if (!picked) return { ok: false, reason: "cancelled" };
    const path = withGraphExt(picked);
    if (tabByPath(path)) {
      addBanner(key, { kind: "saveFailed", message: "That file is open in another tab. Close it first or choose another name." });
      return { ok: false, reason: "failed" };
    }
    const forked = t.path !== null && t.analysisId && t.baseRevision ? { analysis_id: t.analysisId, revision_id: t.baseRevision } : null;
    const file = await newFile({ content: content(), analysisId: newAnalysisId(), forkedFrom: forked, time: now(), author: author(), summary: SUMMARY.first });
    const res = await backend.save({
      path, expectedHead: null, replaceExisting: true, analysisId: file.manifest.analysis_id, docKey: newDocKey(), manifest: file.manifest, newParts: file.parts,
    });
    if (!res.ok) {
      addBanner(key, { kind: "saveFailed", message: res.kind === "error" ? saveFailedMessage(res.code) : saveFailedMessage("Io") });
      return { ok: false, reason: "failed" };
    }
    const o = await openImpl(res.path);
    return o.ok ? { ok: true, path: res.path } : { ok: false, reason: "failed" };
  }

  // ── tabs: open / new / switch / close ──

  function nextUntitled(): string {
    const used = new Set(get().tabs.filter((t) => t.path === null).map((t) => t.title));
    if (!used.has("Untitled")) return "Untitled";
    for (let n = 2; ; n++) if (!used.has(`Untitled ${n}`)) return `Untitled ${n}`;
  }

  function newTab(p: Partial<FileTab> & { key: string; title: string }): FileTab {
    return normTab({
      path: null, folderLabel: p.path ? labelOf(p.path) : "", analysisId: null, baseRevision: null, template: null, dirty: false,
      status: "opening", service: serviceOf(p.path ?? null), readOnly: null, saving: false, notSaved: false, banners: [], banner: null, ...p,
    });
  }

  function insertTab(tab: FileTab): void {
    const tabs = [...get().tabs];
    const at = tabs.findIndex((t) => t.key === get().activeKey);
    tabs.splice(at < 0 ? tabs.length : at + 1, 0, tab);
    set({ tabs });
  }

  async function openImpl(path?: string, opts: { key?: string } = {}): Promise<OpenOutcome> {
    if (!path) {
      const t = tabOf(get().activeKey);
      const p = await pickPath({ mode: "open", title: "Open", suggestedName: null, startDir: t?.path ? parentDir(t.path) : null });
      if (!p) return { ok: false, reason: "cancelled" };
      path = p;
    }
    const existing = tabByPath(path);
    if (existing) {
      await switchTabImpl(existing.key);
      toast({ tone: "info", kind: "alreadyOpen", name: existing.title });
      return { ok: true, key: existing.key };
    }
    // The same file asked for again while it is being opened (a double click, Recent clicked twice): one tab.
    const inflight = opening.get(path);
    if (inflight) return inflight;
    const run = openPathImpl(path, opts);
    opening.set(path, run);
    try { return await run; } finally { if (opening.get(path) === run) opening.delete(path); }
  }

  const opening = new Map<string, Promise<OpenOutcome>>();

  /** Open a file that has no tab yet (contract §4.5): the tab appears at once ("opening") while it is read. */
  async function openPathImpl(p: string, opts: { key?: string }): Promise<OpenOutcome> {
    if (get().tabs.length >= LIMITS.tabCap) { toast({ tone: "warning", kind: "tabLimit" }); return { ok: false, reason: "limit" }; }
    const key = opts.key ?? newDocKey();
    insertTab(newTab({ key, title: fileStem(p), path: p, status: "opening" }));
    const r = await readFile(p);
    if (!r.ok && (r.code === "NotFound" || r.code === "Invalid")) {
      toast({ tone: "error", kind: "error", message: openFailedMessage(r.code, fileStem(p)) });
      if (r.code === "NotFound") await markRecentMissing(p, true);
      if (tabOf(key)) {
        if (get().activeKey === key) await dropTab(key);
        else { set({ tabs: get().tabs.filter((t) => t.key !== key), cards: get().cards.filter((c) => c.key !== key) }); internal.delete(key); }
      }
      return { ok: false, reason: "failed" };
    }
    if (!tabOf(key)) return { ok: false, reason: "cancelled" };     // closed while it was read
    if (r.ok) { patchTab(key, { analysisId: r.file.manifest.analysis_id }); seedFromMemo(key, p, r.file.manifest.analysis_id); }
    return exclusive(async () => {
      if (!tabOf(key)) return { ok: false as const, reason: "cancelled" as const };
      const already = get().activeKey === key && isLoaded(key);    // clicked while it was read
      if (get().activeKey !== key) {
        await leaveActive();
        closeVersionsImpl();
        set({ activeKey: key });
      }
      if (r.ok) await markRecentMissing(p, false);
      await touchRecent(p, r.ok ? r.file.manifest.analysis_id : null);
      if (!already) await loadInto(key, r, "user");
      await saveSession();
      return { ok: true as const, key };
    });
  }

  async function newDocImpl(template: Template, sample = false): Promise<OpenOutcome> {
    if (get().tabs.length >= LIMITS.tabCap) { toast({ tone: "warning", kind: "tabLimit" }); return { ok: false, reason: "limit" }; }
    const key = newDocKey();
    const title = nextUntitled();
    const aid = newAnalysisId();
    return exclusive(async () => {
      await leaveActive();
      it(key).template = template;
      it(key).sample = sample;
      insertTab(newTab({ key, title, analysisId: aid, template, status: "ready" }));
      set({ activeKey: key });
      suppress++;
      try {
        graph.getState().newDoc(template, sample);
        graph.getState().setFileRef({ docKey: key, analysisId: aid, baseRevision: null, path: null }, title);
      } finally { suppress--; }
      await saveSession();
      return { ok: true as const, key };
    });
  }

  /** Open content as a new untitled document with unsaved changes (recovered work, the old library). */
  async function openUntitled(title: string, c: DocContent, opts: { key?: string; analysisId?: string } = {}): Promise<OpenOutcome> {
    if (get().tabs.length >= LIMITS.tabCap) { toast({ tone: "warning", kind: "tabLimit" }); return { ok: false, reason: "limit" }; }
    const key = opts.key ?? newDocKey();
    const aid = opts.analysisId ?? newAnalysisId();
    return exclusive(async () => {
      await leaveActive();
      insertTab(newTab({ key, title, analysisId: aid, template: c.doc.template, status: "ready" }));
      set({ activeKey: key });
      suppress++;
      try {
        graph.getState().loadFile({ file: { docKey: key, analysisId: aid, baseRevision: null, path: null }, name: title, ...c, saved: false });
      } finally { suppress--; }
      patchTab(key, { dirty: isDirty(graph.getState()) });
      await writeActiveDraft(false);
      await saveSession();
      return { ok: true as const, key };
    });
  }

  async function switchTabImpl(key: string): Promise<void> {
    if (!tabOf(key)) return;
    await exclusive(async () => {
      if (get().activeKey === key && (isLoaded(key) || isCard(tabOf(key)!.status))) return;
      await leaveActive();
      closeVersionsImpl();
      set({ activeKey: key });
      await loadInto(key);
      await saveSession();
    });
  }

  async function showStartImpl(): Promise<void> {
    await exclusive(async () => {
      await leaveActive();
      closeVersionsImpl();
      set({ activeKey: null });
      suppress++;
      try { graph.getState().close(); } finally { suppress--; }
      await saveSession();
    });
  }

  /** Remove a tab (no questions; its draft stays unless deleted before). */
  async function dropTab(key: string): Promise<void> {
    await exclusive(async () => {
      const tabs = get().tabs;
      const idx = tabs.findIndex((t) => t.key === key);
      if (idx < 0) return;
      const t = tabs[idx];
      rememberTab(key);
      clearRetry(key);
      cancelAuto(key);
      cancelHeld(key);
      disposePresence(key, t.path);
      if (get().versions?.tabKey === key) closeVersionsImpl();
      const dlg = get().dialog;
      if (dlg?.kind === "combine" && dlg.state.tabKey === key) set({ dialog: null });
      if (t.path) backend.untrack(t.path);
      const wasActive = get().activeKey === key;
      if (wasActive && draftTimer) { deps.timers.clearTimeout(draftTimer); draftTimer = null; }
      const rest = tabs.filter((x) => x.key !== key);
      set({ tabs: rest, cards: get().cards.filter((c) => c.key !== key) });
      internal.delete(key);
      if (wasActive) {
        const next = rest[idx] ?? rest[idx - 1] ?? null;
        set({ activeKey: next?.key ?? null });
        suppress++;
        try { if (isLoaded(key)) graph.getState().close(); } finally { suppress--; }
        if (next) await loadInto(next.key);
      }
      set({ recent: recentItems() });
      await saveSession();
    });
  }

  async function closeTabImpl(key?: string): Promise<boolean> {
    const k = key ?? get().activeKey;
    const t = tabOf(k);
    if (!k || !t) return true;
    if (isCard(t.status) || t.status === "opening") { await dropTab(k); return true; }
    if (isLoaded(k)) deps.flushScratch({ commitEdit: true });
    if (tabDirty(k)) {
      const a = await ask({ kind: "closeDirty", tabKey: k, title: t.title });
      set({ dialog: null });
      if (a.kind !== "closeDirty" || a.choice === "cancel") return false;
      if (a.choice === "save") {
        const res = await saveImpl(k);
        if (!res.ok) return false;
        const after = tabOf(k);
        if (after && tabDirty(after.key)) {
          // Edited while saving: write those edits and keep the tab.
          return false;
        }
        await dropTab(after?.key ?? k);
        return true;
      }
      // discard
      if (draftTimer && get().activeKey === k) { deps.timers.clearTimeout(draftTimer); draftTimer = null; }
      await quietly(backend.deleteDraft(k), undefined);
    }
    await dropTab(k);
    return true;
  }

  // ── Find it… ──

  async function findItImpl(key: string, dir?: string): Promise<void> {
    const t = tabOf(key);
    if (!t?.path || !t.analysisId) return;
    if (!dir) {
      const d = await pickPath({ mode: "folder", title: "Choose a folder to search", suggestedName: null, startDir: parentDir(parentDir(t.path)) });
      if (!d) return;
      dir = d;
    }
    const folder = dir;
    const fl = folderLabel(graphPath(folder, "x"), info.homeDir);
    const base = { tabKey: key, name: t.title, dir: folder, folderLabel: fl, scanned: 0, result: null };
    set({ dialog: { kind: "find", find: { ...base, phase: "scanning" } } });
    const run = backend.locate(folder, t.analysisId, (p) => {
      const d = get().dialog;
      if (d?.kind === "find" && d.find.tabKey === key && d.find.phase === "scanning") set({ dialog: { kind: "find", find: { ...d.find, scanned: p.scanned } } });
    });
    findToken = run.token;
    const result = await run.result;
    if (findToken !== run.token) return;
    findToken = null;
    const d = get().dialog;
    if (!d || d.kind !== "find" || d.find.tabKey !== key) return;
    if (result.ok && result.matches.length === 1) {
      await chooseFoundImpl(result.matches[0].path);
      return;
    }
    set({ dialog: { kind: "find", find: { ...base, phase: "results", scanned: result.ok ? result.scanned : d.find.scanned, result } } });
  }

  /** "Found in Dropbox › Lab" for a file found in another folder; "Renamed to …" when only its name changed. */
  function foundToast(before: string | null, path: string): Omit<SessionToast, "id"> {
    if (before && parentDir(before) === parentDir(path)) return { tone: "info", kind: "renamed", name: fileStem(path) };
    const moved = !!before && fileStem(before) !== fileStem(path);
    return {
      tone: "info", kind: "renamed", name: fileStem(path),
      message: moved ? `Found as '${fileStem(path)}' in ${labelOf(path)}` : `Found in ${labelOf(path)}`,
    };
  }

  async function chooseFoundImpl(path: string): Promise<void> {
    const d = get().dialog;
    const key = d?.kind === "find" ? d.find.tabKey : null;
    set({ dialog: null });
    if (!key || !tabOf(key)) return;
    const other = tabByPath(path);
    if (other && other.key !== key) { await switchTabImpl(other.key); return; }
    clearRetry(key);
    clearCard(key);
    removeKinds(key, ["missing"]);
    const before = tabOf(key)?.path ?? null;
    await repoint(key, path, { recent: "replace" });
    await markRecentMissing(path, false);
    toast(foundToast(before, path));
    patchTab(key, { status: "ready" });
    if (get().activeKey === key) {
      await exclusive(async () => {
        if (isLoaded(key)) {
          // The document is open (a live "missing" banner): keep the work, follow the file.
          const r = await readFile(path);
          if (r.ok) {
            it(key).manifest = r.file.manifest;
            const head = r.file.manifest.head;
            const t = tabOf(key)!;
            if (t.baseRevision !== head) await onHead(key, head);
            backend.track(path, { active: true });
          }
        } else await loadInto(key);
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 2: reload in place, combining, extra copies, versions (phase2-contract.md §5)
  // ═══════════════════════════════════════════════════════════════════════════

  // ── reload in place (§5.7) ──

  let holds = 0;
  // Phase 3 fix: an open editor with typed text is being edited however long ago its last key came.
  const busyNow = () => holds > 0 || graph.getState().typing.length > 0 || quietBool(() => deps.interactionBusy());
  function quietBool(f: () => boolean): boolean { try { return !!f(); } catch { return false; } }

  /** Put a version's content into the loaded tab (graphStore.replaceContent): only while the tab is still
   *  on `expectedBase` with `expectedSerial`; false (nothing changed) otherwise. */
  function replaceInPlace(key: string, p: {
    content: DocContent; head: string; manifest: Manifest; path: string; expectedBase: string | null; expectedSerial: number;
    readOnly?: "tooNew" | null; undo?: string; working?: DocContent;
  }): boolean {
    const t = tabOf(key);
    if (!t || !isLoaded(key)) return false;
    let ok = false;
    suppress++;
    try {
      deps.flushScratch({ commitEdit: false });
      ok = graph.getState().replaceContent({
        docKey: key, expectedBase: p.expectedBase, expectedEditSerial: p.expectedSerial,
        file: { docKey: key, analysisId: p.manifest.analysis_id, baseRevision: p.head, path: p.path }, name: t.title,
        doc: p.content.doc, analysis: p.content.analysis, figure: p.content.figure, scratch: p.content.scratch,
        ...(p.undo ? { undo: { label: p.undo } } : {}),
        ...(p.working ? { working: p.working } : {}),
      });
    } finally { suppress--; }
    const dirty = isDirty(graph.getState());
    if (!ok) {
      if (dirty !== t.dirty) patchTab(key, { dirty });
      if (dirty) scheduleDraft();
      return false;
    }
    const i = it(key);
    i.manifest = p.manifest;
    patchTab(key, {
      baseRevision: p.head, dirty, template: p.content.doc.template,
      ...(p.readOnly !== undefined ? { readOnly: p.readOnly } : {}),
    });
    touchVersions(key);
    return true;
  }

  /** Content arriving on its own is applied when nothing is being edited (§5.7 "Held back"): at once when
   *  free, else `tab.updating` and a retry every LIMITS_P2.replaceRetryMs. A newer arrival replaces a held one. */
  async function applyWhenFree(key: string, run: () => Promise<void>): Promise<void> {
    const i = it(key);
    cancelHeld(key);
    const h: Held = {
      timer: null,
      attempt: async () => {
        const cur = internal.get(key);
        if (!cur || cur.held !== h) return;
        if (isLoaded(key) && busyNow()) {
          h.timer = deps.timers.setTimeout(() => { h.timer = null; void h.attempt(); }, LIMITS_P2.replaceRetryMs);
          return;
        }
        cur.held = null;
        if (tabOf(key)?.updating) patchTab(key, { updating: false });
        await run();
      },
    };
    i.held = h;
    if (isLoaded(key) && busyNow()) patchTab(key, { updating: true });
    await h.attempt();
  }

  /** The window came back: content held back is tried at once (before anything can be typed). */
  function retryHeldNow(): void {
    for (const i of internal.values()) {
      const h = i.held;
      if (!h || !h.timer) continue;
      deps.timers.clearTimeout(h.timer);
      h.timer = null;
      void h.attempt();
    }
  }

  function cancelHeld(key: string): void {
    const i = internal.get(key);
    if (!i?.held) return;
    if (i.held.timer) deps.timers.clearTimeout(i.held.timer);
    i.held = null;
    if (tabOf(key)?.updating) patchTab(key, { updating: false });
  }

  function holdReplaceImpl(_reason: string): () => void {
    holds++;
    let released = false;
    return () => { if (!released) { released = true; holds = Math.max(0, holds - 1); } };
  }

  // ── combining (§5.4) ──

  /** A file holding the tab's base version R (this computer's saved copy, else the file if it still has it). */
  async function baseFileOf(aid: string, R: string, path: string | null): Promise<GraphFileData | null> {
    const j = await readJournalFile(aid, R);
    if (j && revisionSections(j, R)) return j;
    if (path) {
      const r = await readFile(path);
      if (r.ok && r.file.manifest.analysis_id === aid && revisionSections(r.file, R)) return r.file;
    }
    return null;
  }

  /** §5.4 steps 2–4: both sides, the common version, the plan. Nothing is written except my working copy
   *  into this computer's own journal. */
  async function prepareCombine(key: string, source: CombineSource, origin: CombineCtx["origin"], opts: {
    working?: Working | null; queue?: string[]; index?: number; total?: number; fromBanner?: TabBanner | null;
  } = {}): Promise<Prepared> {
    const t = tabOf(key);
    if (!t?.path || !t.analysisId) return { kind: "failed" };
    const aid = t.analysisId;
    const i = it(key);
    i.combining++;
    try {
      // fixer V-3: a combine nobody asked for ("poll") leaves a typed editor alone (it holds the replace back,
      // busyNow); the person's own combine (a Save, the banner) commits an entry that can be committed.
      if (isLoaded(key)) deps.flushScratch({ commitEdit: origin !== "poll" });
      const R = t.baseRevision;
      const dirty = tabDirty(key);
      // The markers of my side: those of the working copy handed in (a Save built it before its first attempt;
      // anything typed since is newer than it and must make the context stale), else the tab's now.
      const serial = opts.working ? opts.working.serial : isLoaded(key) ? graph.getState().editSerial : undefined;
      const draftSeq = opts.working ? opts.working.draftSeq : i.draftSeq;
      // Theirs, read fresh.
      let theirsFile: GraphFileData | null;
      let theirsHead: string;
      if (source.kind === "journal") {
        theirsFile = await readJournalFile(aid, source.revisionId);
        theirsHead = source.revisionId;
        if (!theirsFile || !revisionSections(theirsFile, theirsHead)) return { kind: "unreadable" };
      } else {
        const path = source.kind === "disk" ? t.path : source.path;
        const r = await readFile(path);
        if (!r.ok) return source.kind === "copy" && r.code === "NotFound" ? { kind: "gone" } : { kind: "unreadable" };
        if (r.readOnly) return { kind: "tooNew" };
        if (r.file.manifest.analysis_id !== aid) return { kind: "failed" };
        theirsFile = r.file;
        theirsHead = r.file.manifest.head;
      }
      const theirsRev = revisionOf(theirsFile.manifest, theirsHead);
      if (!theirsRev) return { kind: "unreadable" };
      // Mine: R, or my working copy W (journaled first, as before the conflict sheet).
      let baseFile = R ? await baseFileOf(aid, R, source.kind === "disk" ? null : t.path) : null;
      if (!baseFile && R && !dirty && isLoaded(key) && i.manifest && revisionOf(i.manifest, R)) {
        // No saved copy of R here: a clean tab's content is R's content.
        const parts = await partsOf(sectionsOf(content()));
        if (parts.contentHash === revisionOf(i.manifest, R)!.content_hash) {
          const m = i.manifest;
          baseFile = { manifest: { ...m, head: R }, parts: parts.texts };
        }
      }
      let working: Working | null = null;
      let mineFile: GraphFileData;
      let mineRev: Revision;
      if (dirty || !baseFile || !R) {
        working = opts.working ?? await workingOf(key);
        if (!working) return { kind: "failed" };
        mineFile = { manifest: working.manifest, parts: { ...(baseFile?.parts ?? {}), ...(working.extraParts ?? {}), ...working.parts.texts } };
        mineRev = working.rev;
        await quietly(backend.writeJournal(t.path, { manifest: working.manifest, parts: { ...working.parts.texts } }), undefined);
        if (!i.settled.includes(working.rev.id)) i.settled = [...i.settled, working.rev.id];
      } else {
        mineFile = baseFile;
        mineRev = revisionOf(baseFile.manifest, R)!;
      }
      const revs = unionRevisions(mineFile.manifest, theirsFile.manifest);
      const rel = relation(revs, mineRev.id, theirsHead);
      if (rel !== "diverged") return { kind: "notDiverged", relation: rel, theirs: theirsFile };
      // The common version: looked for in both files, then in this computer's saved copies (§3.2).
      const files: GraphFileData[] = [mineFile, theirsFile];
      let pool = snapshotPool(files);
      const extra: GraphFileData[] = [];
      for (const id of lowestCommonAncestors(revs, mineRev.id, theirsHead)) {
        if (pool.has(id)) continue;
        const j = await readJournalFile(aid, id);
        if (j) extra.push(j);
      }
      pool = snapshotPool([...files, ...extra]);
      let base = findBase(revs, mineRev.id, theirsHead, pool.has);
      if (base.kind !== "lca" && base.kind !== "notDiverged") {
        const heads = await quietly(backend.journalHeads(aid), [] as JournalHead[]);
        const ids = [...heads].sort((a, b) => b.first_seen - a.first_seen).map((h) => h.revision_id)
          .filter((id, k, all) => all.indexOf(id) === k).slice(0, LIMITS_P2.baseScanCopies);
        for (const id of ids) {
          if (extra.some((f) => f.manifest.head === id)) continue;
          const j = await readJournalFile(aid, id);
          if (j) extra.push(j);
        }
        pool = snapshotPool([...files, ...extra]);
        base = findBase(revs, mineRev.id, theirsHead, pool.has);
      }
      if (base.kind === "notDiverged") return { kind: "notDiverged", relation: base.relation, theirs: theirsFile };
      const baseId = base.kind === "none" ? null : base.id;
      const mineSections: SectionValues | null = working
        ? (sectionsOf(working.content) as unknown as SectionValues)
        : (pool.get(mineRev.id) ?? (revisionSections(mineFile, mineRev.id) as SectionValues | null));
      const theirsSections = revisionSections(theirsFile, theirsHead) as SectionValues | null;
      if (!mineSections || !theirsSections) return { kind: "fallback", theirs: theirsFile, working, mineFile };
      const plan = await planOf({
        base: baseId ? pool.get(baseId) : null, baseKind: base.kind === "none" ? "none" : base.kind, mine: mineSections, theirs: theirsSections,
      }, mineRev, theirsRev);
      if (!plan.ok) return { kind: "fallback", theirs: theirsFile, working, mineFile };
      return {
        kind: "plan",
        ctx: {
          key, source, origin, mineRev, mineFile, mineBase: R, working, serial, draftSeq, theirsFile, theirsRev, extra, base, baseId, plan,
          choices: {}, queue: opts.queue ?? [], index: opts.index ?? 1, total: opts.total ?? 1, fromBanner: opts.fromBanner ?? null,
        },
      };
    } finally { i.combining--; }
  }

  // ── phase 4: the plan, its result, the choices (§5.1–5.3) ──

  /** Step 4: the fine plan (phase 4), or the phase 2 plan in its form when playing an older app. */
  async function planOf(
    input: { base: SectionValues | null; baseKind: CombinePlan["baseKind"]; mine: SectionValues; theirs: SectionValues },
    mineRev: Revision, theirsRev: Revision,
  ): Promise<CombinePlanP4 | { ok: false }> {
    const mineKey = { deviceId: String(mineRev.device_id ?? ""), revisionId: String(mineRev.id ?? "") };
    const theirsKey = { deviceId: String(theirsRev.device_id ?? ""), revisionId: String(theirsRev.id ?? "") };
    if (!legacy) {
      const p = await combineFine({ ...input, mineKey, theirsKey });
      return p.ok ? p : { ok: false };
    }
    const p = await combine(input);
    if (!p.ok) return { ok: false };
    return {
      ...p, level: "section", mineKey, theirsKey, result: p.result ? asP4Result(p.result) : null,
      sections: p.sections.map((s) => ({ ...s, level: "whole" as const, conflicts: [], combined: 0, auto: [], orderChecks: [] })),
    };
  }

  const asP4Result = (r: CombineResult): CombineResultP4 => ({ ...r, adjustments: [], orderChecks: [], mixed: [] });

  /** Step 7.2: the result for the context's choices (null: a choice is missing). */
  async function resultOf(ctx: CombineCtx): Promise<CombineResultP4 | null> {
    if (!legacy) return applyFineChoices(ctx.plan, ctx.choices);
    const r = await applyChoices(ctx.plan, ctx.choices.sections ?? {});
    return r ? asP4Result(r) : null;
  }

  /** No choice of any kind was made (an automatic combine stays automatic, §4.1). */
  const noChoices = (c: CombineChoices) => !Object.keys(c.sections ?? {}).length && !Object.keys(c.fine ?? {}).length;
  /** Only choices that equal what would be taken anyway (the phase 2 "preset only" rule). */
  const presetOnly = (ctx: CombineCtx) => !Object.keys(ctx.choices.fine ?? {}).length
    && Object.entries(ctx.choices.sections ?? {}).every(([k, v]) => ctx.plan.sections.find((s) => s.key === k)?.pick === v);

  /** Conflicts of a section still without a valid choice. */
  function leftOf(ctx: CombineCtx, k: SectionName): number {
    const s = ctx.plan.sections.find((x) => x.key === k)!;
    if (ctx.choices.sections?.[k]) return 0;
    if (legacy) return s.status === "both" ? 1 : 0;
    const fine = ctx.choices.fine ?? {};
    return s.conflicts.filter((c) => { const v = fine[c.id]; return v === undefined || !c.options.includes(v); }).length;
  }

  /** Fixer round 2 (RV-1, RV-3): the two sides as the dialog shows and compares them. A row an earlier combine
   *  moved is shown under its new id on the side that still has the old one (so the two are compared and the
   *  values to choose are found); a row both typed into that was split is compared as a row added on each side,
   *  not as changed cells. Display only: what is combined and written comes from the plan. */
  function shownSides(plan: CombinePlanP4): { mineContent: DocContent; theirsContent: DocContent; compare: CompareResult } {
    const notes = plan.sections.find((x) => x.key === "table")?.rowNotes;
    const plain = { mineContent: plan.mine.content, theirsContent: plan.theirs.content, compare: compareSections(plan.theirs.sections, plan.mine.sections) };
    if (!notes) return plain;
    const rename = (ids: readonly string[] | undefined, side: SidePick, forCompare: boolean): string[] | undefined => {
      if (!ids) return ids;
      const out = [...ids];
      for (const mv of notes.moved) {
        if (mv.side !== side || out.includes(mv.id)) continue;
        const i = out.indexOf(mv.was);
        if (i >= 0) out[i] = mv.id;
      }
      if (forCompare) for (const r of notes.split) { const i = out.indexOf(r); if (i >= 0) out[i] = `${r}\n${side}`; }
      return out;
    };
    const content = (c: DocContent, side: SidePick): DocContent =>
      notes.moved.some((m) => m.side === side) ? { ...c, doc: { ...c.doc, row_ids: rename(c.doc.row_ids, side, false) ?? c.doc.row_ids } } : c;
    const sections = (x: FileSections4, side: SidePick): FileSections4 => {
      const t = x.table as unknown as { row_ids?: string[] } | undefined;
      return t ? ({ ...x, table: { ...t, row_ids: rename(t.row_ids, side, true) } } as unknown as FileSections4) : x;
    };
    const cmp = compareSections(sections(plan.theirs.sections, "theirs"), sections(plan.mine.sections, "mine"));
    return {
      mineContent: content(plan.mine.content, "mine"), theirsContent: content(plan.theirs.content, "theirs"),
      compare: { ...plain.compare, table: cmp.table },
    };
  }

  /** The dialog's state for a context (§6.4; phase 4 §5.2). */
  async function combineStateOf(ctx: CombineCtx, extra: Partial<CombineStateP4> = {}): Promise<CombineStateP4> {
    const t = tabOf(ctx.key);
    const fine = ctx.choices.fine ?? {};
    const lefts = ctx.plan.sections.map((s) => leftOf(ctx, s.key));
    const toChoose = lefts.reduce((a, b) => a + b, 0);
    const result = toChoose === 0 ? await resultOf(ctx) : null;
    const sections: CombineSectionViewP4[] = ctx.plan.sections.map((s, n) => ({
      key: s.key, status: s.status, choice: ctx.choices.sections?.[s.key] ?? s.pick,
      level: s.level, conflicts: s.conflicts,
      choices: Object.fromEntries(s.conflicts.filter((c) => fine[c.id] !== undefined).map((c) => [c.id, fine[c.id]])),
      left: lefts[n], combined: s.combined, auto: s.auto,
      orderChecks: result && s.key === "table" ? result.orderChecks : [],
      ...(s.key === "table" && s.rowNotes ? { rowNotes: s.rowNotes } : {}),
    }));
    const shown = shownSides(ctx.plan);
    const combinedCount = ctx.plan.sections.reduce((a, s) => a + (s.level === "fine" ? s.combined : s.status === "mine" || s.status === "theirs" ? 1 : 0), 0);
    const union = unionManifests(ctx.mineFile.manifest, ctx.theirsFile.manifest);
    return {
      tabKey: ctx.key, name: t?.title ?? "", origin: ctx.origin, source: ctx.source,
      copyName: ctx.source.kind === "copy" ? fileStem(ctx.source.path) : null,
      index: ctx.index, total: ctx.total,
      mine: vi(ctx.mineFile.manifest, ctx.mineRev.id), mineUnsaved: !!ctx.working,
      theirs: vi(ctx.theirsFile.manifest, ctx.theirsRev.id),
      since: ctx.baseId ? vi(union, ctx.baseId) : null,
      twoWay: ctx.plan.twoWay, sections, adjusted: result?.repairs ?? [], canApply: !!result, applying: false,
      mineContent: shown.mineContent, theirsContent: shown.theirsContent,
      compare: shown.compare, error: null,
      adjustments: result?.adjustments ?? [], toChoose, combinedCount, resultContent: result?.content ?? null,
      ...extra,
    };
  }

  /** The other side changed while a dialog was open or a write was prepared: same statuses? */
  const sameStatuses = (a: CombinePlan, b: CombinePlan) => a.sections.every((s, k) => s.status === b.sections[k]?.status);
  const conflictIds = (p: CombinePlanP4) => p.sections.flatMap((s) => s.conflicts.map((c) => c.id)).sort().join("\n");
  const conflictText = (p: CombinePlanP4, id: string): string | null => {
    for (const s of p.sections) for (const c of s.conflicts) if (c.id === id) return canonicalJson(c);
    return null;
  };

  /** The tab's content moved on since the context was built (§5.4 step 7.1). */
  function staleCtx(ctx: CombineCtx): boolean {
    const i = it(ctx.key);
    if (isLoaded(ctx.key)) return ctx.serial === undefined || graph.getState().editSerial !== ctx.serial;
    return ctx.serial !== undefined || i.draftSeq !== ctx.draftSeq;
  }

  /** Choices carried into a context put together again (§5.1 step 7.1): whole-section choices for sections that
   *  still differ, per-conflict choices for conflicts that are still the same. */
  function carryChoices(a: CombineCtx, b: CombineCtx): CombineChoices {
    const sections = Object.fromEntries(Object.entries(a.choices.sections ?? {})
      .filter(([k]) => b.plan.sections.find((s) => s.key === k)?.status !== "same"));
    const fine = Object.fromEntries(Object.entries(a.choices.fine ?? {}).filter(([id]) => {
      const x = conflictText(a.plan, id);
      return x !== null && x === conflictText(b.plan, id);
    }));
    return {
      ...(Object.keys(sections).length ? { sections } : {}),
      ...(Object.keys(fine).length ? { fine } : {}),
    };
  }

  /** A context put together again (edits typed meanwhile, or the other side moved on): must the person look
   *  again before anything is written? When a section's status changed; when the set of conflicts changed;
   *  when it was going to be written without anyone looking and now can't be (a repair, an adjustment, an
   *  order to check, or no true common version any more); when a conflict somebody chose for is no longer
   *  the same; or when a section somebody chose as a whole changed on either side since they chose. */
  async function lookAgain(a: CombineCtx, b: CombineCtx, auto: boolean): Promise<boolean> {
    if (!sameStatuses(a.plan, b.plan)) return true;
    if (conflictIds(a.plan) !== conflictIds(b.plan)) return true;
    if (auto && !b.plan.autoApplicable) return true;
    for (const id of Object.keys(a.choices.fine ?? {})) if (conflictText(a.plan, id) !== conflictText(b.plan, id)) return true;
    for (const k of Object.keys(a.choices.sections ?? {}) as SectionName[]) {
      if (a.plan.theirs.parts.refs[k]?.sha256 !== b.plan.theirs.parts.refs[k]?.sha256) return true;
      if (a.plan.mine.parts.refs[k]?.sha256 !== b.plan.mine.parts.refs[k]?.sha256) return true;
    }
    // Fixer VS-2: the person looked at what was adjusted automatically and at the orders to check; anything
    // of that which is new or different since is shown before it is written (phase 4: an adjustment always
    // forces a review).
    if (!auto && !legacy) {
      const [ra, rb] = await Promise.all([resultOf(a), resultOf(b)]);
      if (!rb || reviewText(ra) !== reviewText(rb)) return true;
    }
    return false;
  }

  /** What a person reviews in a result besides the choices: the adjustments, the repairs and the orders to check. */
  const reviewText = (r: CombineResultP4 | null): string => (r
    ? canonicalJson({ adjustments: r.adjustments, repairs: r.repairs, orders: r.orderChecks.filter((o) => o.matters) })
    : "");

  type WriteResult =
    /** `used`: the context the write was made from (7.1 may have put it together again). */
    | { kind: "saved"; path: string; used: CombineCtx }
    | { kind: "changed"; ctx: CombineCtx }
    | { kind: "conflict" }
    /** Combining with an extra copy, but the tab's own file has a version the tab doesn't have yet. */
    | { kind: "diskAhead"; used: CombineCtx }
    | { kind: "failed"; outcome: SaveOutcome };

  /** §5.4 step 7: write the combined version once. */
  async function writeCombine(ctx0: CombineCtx, auto0: boolean, opts: { hold: boolean }): Promise<WriteResult> {
    let ctx = ctx0;
    let auto = auto0;
    const key = ctx.key;
    const i = it(key);
    // 7.1 Edits since my side was put together: put it together again; any status change → the person looks again.
    if (staleCtx(ctx)) {
      const again = await prepareCombine(key, ctx.source, ctx.origin, { queue: ctx.queue, index: ctx.index, total: ctx.total, fromBanner: ctx.fromBanner });
      if (again.kind !== "plan") return { kind: "failed", outcome: { ok: false, reason: "failed" } };
      again.ctx.choices = carryChoices(ctx, again.ctx);
      if (await lookAgain(ctx, again.ctx, auto)) return { kind: "changed", ctx: again.ctx };
      // Written without anyone looking only while the new plan still allows it.
      auto = auto && again.ctx.plan.autoApplicable;
      ctx = again.ctx;
      if (i.combine === ctx0) i.combine = ctx;
    }
    const t = tabOf(key);
    if (!t?.path || !t.analysisId) return { kind: "failed", outcome: { ok: false, reason: "nothing" } };
    const aid = t.analysisId;
    // 7.2
    const result = !noChoices(ctx.choices) || !ctx.plan.result ? await resultOf(ctx) : ctx.plan.result;
    if (!result) return { kind: "failed", outcome: { ok: false, reason: "failed" } };
    // 7.3 The file it goes into, as it is now.
    const targetPath = ctx.source.kind === "copy" ? survivorPath([t.path, ctx.source.path]) : t.path;
    const tr = await readFile(targetPath);
    if (!tr.ok || tr.file.manifest.analysis_id !== aid) {
      addBanner(key, { kind: "saveFailed", message: "The other version can't be read yet. Try again in a moment." });
      return { kind: "failed", outcome: { ok: false, reason: "failed" } };
    }
    const expected = tr.file.manifest.head;
    const allowed = targetPath === t.path
      ? (ctx.source.kind === "disk" ? [ctx.theirsRev.id] : [ctx.mineBase, ctx.mineRev.id])
      : [ctx.theirsRev.id];
    if (!allowed.includes(expected)) return ctx.source.kind === "copy" && targetPath === t.path ? { kind: "diskAhead", used: ctx } : { kind: "conflict" };
    // 7.4
    const M = await combineRevision({ mine: ctx.mineRev, theirs: ctx.theirsRev, result, auto, author: author(), time: now(), legacy });
    // 7.5
    const union = unionManifests(tr.file.manifest, unionManifests(ctx.mineFile.manifest, ctx.theirsFile.manifest));
    const manifest0 = await retain(withRevision(union, M, author(), result.content.doc.template), [ctx.mineRev.id, ctx.theirsRev.id, ctx.baseId]);
    const have: Record<string, string> = {};
    for (const f of [...ctx.extra].reverse()) Object.assign(have, f.parts);
    Object.assign(have, ctx.theirsFile.parts, ctx.mineFile.parts, tr.file.parts, result.parts.texts);
    const done = await completeParts(manifest0, have, (rid) => readJournalFile(aid, rid));
    if (!done) {
      addBanner(key, { kind: "saveFailed", message: saveFailedMessage("Invalid") });
      return { kind: "failed", outcome: { ok: false, reason: "failed" } };
    }
    // 7.6
    const owner = tabByPath(targetPath);
    patchTab(key, { saving: true });
    let res: SaveResult;
    try {
      res = await backend.save({
        path: targetPath, expectedHead: expected, analysisId: aid, docKey: owner?.key ?? newDocKey(), manifest: done.manifest,
        newParts: partsNotIn(done.parts, tr.file),
      });
    } finally { patchTab(key, { saving: false }); }
    switch (res.kind) {
      case "saved": case "savedButDisplaced":
        await afterCombineSaved(ctx, res.path, done.manifest, result, M, opts);
        if (res.kind === "savedButDisplaced") {
          const D = res.displacedHead;
          if (!tabDirty(key)) void autoCombine(key, { kind: "journal", revisionId: D });
          else { const j = await readJournalFile(aid, D); if (j) chooseBanner(key, { kind: "journal", revisionId: D }, vi(j.manifest, D)); }
        }
        return { kind: "saved", path: res.path, used: ctx };
      case "conflict": return { kind: "conflict" };
      case "savedAside":
        i.asides = addUnique(i.asides, res.path);
        addBanner(key, { kind: "savedAside", name: fileStem(res.path), path: res.path });
        await saveSession();
        return { kind: "failed", outcome: { ok: false, reason: "failed" } };
      case "missing":
        addBanner(key, { kind: "missing", name: t.title, folderLabel: t.folderLabel, candidates: [] });
        return { kind: "failed", outcome: { ok: false, reason: "failed" } };
      case "error":
        addBanner(key, { kind: "saveFailed", message: saveFailedMessage(res.code) });
        return { kind: "failed", outcome: { ok: false, reason: "failed" } };
    }
  }

  /** Unsaved changes made while a combine was written, on top of its result (three-way with the side the
   *  combine used as mine). null when they touch a section the result took from the other side. */
  async function rebaseOnto(mineUsed: DocContent, current: DocContent, result: CombineResult): Promise<DocContent | null> {
    const p = await combine({
      base: sectionsOf(mineUsed) as unknown as SectionValues, baseKind: "lca",
      mine: sectionsOf(current) as unknown as SectionValues, theirs: result.sections as unknown as SectionValues,
    });
    // A result that had to be adjusted (typing removed a column the combined settings use) is not taken
    // silently: the tab keeps what it has and the combined version is offered as newer.
    return p.ok && p.result && !p.needsChoice && p.result.repairs.length === 0 ? p.result.content : null;
  }

  /** §5.4.2 */
  async function afterCombineSaved(ctx: CombineCtx, path: string, manifest: Manifest, result: CombineResultP4, M: RevisionP2, opts: { hold: boolean }): Promise<void> {
    const key = ctx.key;
    const i = it(key);
    const t = tabOf(key)!;
    const aid = manifest.analysis_id;
    const theirsInfo = vi(ctx.theirsFile.manifest, ctx.theirsRev.id);
    i.preCombineHead = ctx.mineRev.id;
    i.conflict = null;
    i.lastSource = null;
    if (ctx.source.kind === "journal" && !i.settled.includes(ctx.source.revisionId)) i.settled = [...i.settled, ctx.source.revisionId];
    const oldPath = t.path!;
    if (path !== oldPath) {
      // Combined into the extra copy with the shorter name: the tab is that file now; mine is an older copy.
      i.knownCopies = i.knownCopies.filter((p) => p !== path);
      i.seenCopies = addUnique(i.seenCopies.filter((p) => p !== path), oldPath);
      i.asides = i.asides.filter((p) => p !== path);
      i.copyAnswer = { ...i.copyAnswer, [oldPath]: "same" };
      await repoint(key, path, { recent: "replace" });
      toast({ tone: "info", kind: "renamed", name: fileStem(path) });
    }
    patchTab(key, { notSaved: false });
    removeKinds(key, ["newerOnDisk", "notSaved", "savedOver", "saveFailed"]);
    if (ctx.source.kind === "copy") { const cp = ctx.source.path; removeBanners(key, (b) => b.id === `copy:${cp}`); }
    const mineUsed = ctx.working?.content ?? (contentOfSections(ctx.plan.mine.sections as unknown as Record<string, unknown>) ?? ctx.plan.mine.content);
    if (isLoaded(key)) {
      // My own save that was replaced is not "someone's changes".
      const label = theirsInfo.mine ? "Undo: combine with your earlier save" : `Undo: combine with ${whoLabel(theirsInfo)}'s changes`;
      const expectedBase = ctx.mineBase;
      const apply = async () => {
        let ok = false;
        for (let round = 0; round < 3 && !ok; round++) {
          if (!isLoaded(key) || graph.getState().file?.baseRevision !== expectedBase) break;
          const serialNow = graph.getState().editSerial;
          const stale = ctx.serial === undefined || serialNow !== ctx.serial;
          if (!stale) {
            ok = replaceInPlace(key, { content: result.content, head: M.id, manifest, path, expectedBase, expectedSerial: serialNow, undo: label });
            continue;
          }
          // Typed while the combine was written: kept, on top of the combined version.
          deps.flushScratch({ commitEdit: true });
          const cur = content();
          const s0 = graph.getState().editSerial;
          const rebased = await rebaseOnto(mineUsed, cur, result);
          if (!rebased) break;
          ok = replaceInPlace(key, { content: result.content, head: M.id, manifest, path, expectedBase, expectedSerial: s0, undo: label, working: rebased });
        }
        if (!ok) {
          // The tab keeps what it has (on its old base); the combined version is offered as newer.
          if (tabOf(key)?.baseRevision !== M.id) {
            addBanner(key, { kind: "newerOnDisk", version: vi(manifest, M.id), actions: ["combine", "later"] });
            i.bannerSource.set("newerOnDisk", { kind: "disk" });
          }
          return;
        }
        if (isDirty(graph.getState())) await writeActiveDraft(false);
        else { await quietly(backend.deleteDraft(key), undefined); i.hasDraft = false; }
        await saveSession();
      };
      if (opts.hold) await applyWhenFree(key, apply); else await apply();
    } else {
      i.manifest = manifest;
      const same = ctx.working ? (ctx.serial !== undefined ? i.draftSerialAt === ctx.serial : i.draftSeq === ctx.draftSeq) : !i.hasDraft;
      const d = same ? null : await quietly(backend.readDraft(key), null);
      const dc = d ? contentOfDraft(d) : null;
      const rebased = dc ? await rebaseOnto(mineUsed, dc, result) : null;
      if (rebased) {
        await putDraft(key, draftOf({ docKey: key, analysisId: aid, path, baseRevision: M.id, content: rebased, savedAt: now(), title: fileStem(path), template: rebased.doc.template }), undefined);
        i.hasDraft = true;
        patchTab(key, { baseRevision: M.id, dirty: true });
      } else if (dc) {
        addBanner(key, { kind: "newerOnDisk", version: vi(manifest, M.id), actions: ["combine", "later"] });
        i.bannerSource.set("newerOnDisk", { kind: "disk" });
      } else {
        await quietly(backend.deleteDraft(key), undefined);
        i.hasDraft = false;
        patchTab(key, { baseRevision: M.id, dirty: false });
      }
    }
    const taken = SECTION_NAMES.filter((k) => result.from[k] === "theirs");
    addBanner(key, { kind: "combined", version: theirsInfo, sections: taken, mixed: [...result.mixed], actions: ["whatChanged", "undo"], dismissible: true });
    toast({ tone: "success", kind: "combined", version: theirsInfo });
    await touchRecent(path, aid);
    await saveSession();
    touchVersions(key);
    if (path !== oldPath && tabOf(key)) await quietly(handleSibling(key, oldPath), undefined);
    if (ctx.source.kind === "copy" && tabOf(key)) {
      const cp = ctx.source.path;
      if (cp !== path) await quietly(handleSibling(key, cp), undefined);
    }
  }

  /** "Another computer saved over your last save. … Choose what to keep." [Choose…]. Phase 4 `review`: nothing
   *  to choose, but it is not combined without a click (§4.2) — "… both sets of changes can be combined." [Combine] */
  function chooseBanner(key: string, source: CombineSource, version: VersionInfo, state: "choose" | "review" = "choose"): void {
    // Fixer VUX-9: `review` cannot be closed — with it gone the tab read "All changes saved" while the file held
    // the other computer's version and mine was not in it.
    const b = addBanner(key, { id: "savedOver", kind: "savedOver", state, version, actions: ["combine"], dismissible: state !== "review" });
    if (b) it(key).bannerSource.set(b.id, source);
  }

  /** Phase 4 §3.3: may a combine nobody asked for be written? (Playing an older app: the phase 2 rule.) */
  const mayAutoWrite = (ctx: CombineCtx) =>
    ctx.plan.autoApplicable && (legacy || ctx.plan.level === "section" || peersCombineAlike(ctx.mineRev, ctx.theirsRev));
  /** The banner of a combine that is not written by itself: `choose` when something needs a choice, else `review`. */
  const holdState = (ctx: CombineCtx): "choose" | "review" => (legacy || ctx.plan.needsChoice ? "choose" : "review");

  function clearCombining(key: string): void {
    const i = internal.get(key);
    if (!i) return;
    if (i.autoTimer) { deps.timers.clearTimeout(i.autoTimer); i.autoTimer = null; }
    const had = !!i.combinePending;
    i.combinePending = null;
    if (tabOf(key)?.combining) patchTab(key, { combining: false });
    removeBanners(key, (b) => b.kind === "savedOver" && b.state === "combining");
    if (had) void saveSession();
    recheckLater(key);
  }

  /** A waiting automatic combine is called off (closing the tab, Save, a manual combine, quitting). */
  function cancelAuto(key: string): void { clearCombining(key); }

  /** After combine work: a change of the file that arrived meanwhile is looked at now. */
  function recheckLater(key: string): void {
    const i = internal.get(key);
    if (!i?.recheck) return;
    void Promise.resolve().then(() => {
      const j = internal.get(key);
      if (!j || !j.recheck || j.autoTimer || j.combining > 0 || j.combine || savesInFlight.has(key)) return;
      j.recheck = false;
      void onHead(key, "");
    });
  }

  /** §5.4.1: a combine nobody asked for (clean tab, sources disk / journal), written after the device-ordered
   *  delay when the plan needs no choice; otherwise the "Choose…" banner. */
  async function autoCombine(key: string, source: CombineSource): Promise<void> {
    const i = it(key);
    if (i.autoTimer || i.combine) return;
    const prep = await prepareCombine(key, source, "poll");
    const t = tabOf(key);
    if (!t?.path) return;
    switch (prep.kind) {
      case "unreadable": case "gone": return;
      case "tooNew": addBanner(key, { kind: "tooNew" }); return;
      case "failed": return;
      case "notDiverged":
        if (source.kind === "journal" && !i.settled.includes(source.revisionId)) { i.settled = [...i.settled, source.revisionId]; await saveSession(); }
        if (prep.relation === "newer" && source.kind === "disk") await onHead(key, prep.theirs.manifest.head);
        return;
      case "fallback": await fallbackCopy(key, source, prep); return;
      case "plan": break;
    }
    const ctx = prep.ctx;
    const theirsInfo = vi(ctx.theirsFile.manifest, ctx.theirsRev.id);
    if (tabDirty(key) || ctx.working) { chooseBanner(key, source, theirsInfo); return; }
    if (!mayAutoWrite(ctx)) {
      removeBanners(key, (b) => b.kind === "savedOver" && b.state !== undefined);
      chooseBanner(key, source, theirsInfo, holdState(ctx));
      return;
    }
    removeBanners(key, (b) => b.kind === "savedOver");
    addBanner(key, { id: "savedOver", kind: "savedOver", state: "combining", version: theirsInfo, actions: [], dismissible: false });
    patchTab(key, { combining: true });
    i.combinePending = { theirs: ctx.theirsRev.id, source: source.kind === "journal" ? "journal" : "disk" };
    await saveSession();
    const delay = await deps.combineDelayMs(device?.device_id ?? "");
    if (!i.combinePending || i.autoTimer) return;
    const expected = source.kind === "disk" ? ctx.theirsRev.id : ctx.mineBase;
    i.autoTimer = deps.timers.setTimeout(() => { i.autoTimer = null; void autoRecheck(key, ctx, expected); }, delay);
  }

  /** §5.4.1 step 3: look at the file again before writing. */
  async function autoRecheck(key: string, ctx: CombineCtx, expected: string | null): Promise<void> {
    const t = tabOf(key);
    if (!t?.path || internal.get(key) === undefined) return;
    // Phase 3 §5.5: while the tab is read-only the combine stays pending ("combining" note kept), looked at again
    // when the guard clears.
    if (readOnlyNow(key)) {
      // Fixer VS-3: the file may already hold the combined version (or have moved on) — then there is nothing
      // to wait for: the tab is brought up to date instead of parking with a stale view.
      const r0 = await readFile(t.path);
      if (internal.get(key) === undefined) return;
      if (r0.ok) {
        const m0 = r0.file.manifest;
        const done = isAncestorOrSelf(m0, ctx.mineRev.id, m0.head) && isAncestorOrSelf(m0, ctx.theirsRev.id, m0.head);
        if (done || m0.head !== expected) {
          clearCombining(key);
          const i0 = it(key);
          if (done && ctx.source.kind === "journal" && !i0.settled.includes(ctx.source.revisionId)) i0.settled = [...i0.settled, ctx.source.revisionId];
          await onHead(key, m0.head);
          return;
        }
      }
      if (readOnlyNow(key)) { it(key).pr.autoWaiting = { ctx, expected }; return; }
    }
    const theirsInfo = vi(ctx.theirsFile.manifest, ctx.theirsRev.id);
    if (tabDirty(key)) { clearCombining(key); chooseBanner(key, ctx.source, theirsInfo); return; }
    const r = await readFile(t.path);
    if (!r.ok) { clearCombining(key); chooseBanner(key, ctx.source, theirsInfo); return; }
    const m = r.file.manifest;
    if (isAncestorOrSelf(m, ctx.mineRev.id, m.head) && isAncestorOrSelf(m, ctx.theirsRev.id, m.head)) {
      // The result (or more) already arrived from the other computer: nothing to write.
      clearCombining(key);
      const i = it(key);
      if (ctx.source.kind === "journal" && !i.settled.includes(ctx.source.revisionId)) i.settled = [...i.settled, ctx.source.revisionId];
      await onHead(key, m.head);
      return;
    }
    if (m.head === expected && !tabDirty(key)) {
      it(key).combining++;
      let w: WriteResult;
      try { w = await inSaveSlot(key, async () => { const x = await writeCombine(ctx, true, { hold: true }); return x; }); }
      finally { it(key).combining--; }
      clearCombining(key);
      if (w.kind === "changed" || w.kind === "conflict") await onHead(key, m.head);
      else if (w.kind === "failed") chooseBanner(key, ctx.source, theirsInfo);
      return;
    }
    clearCombining(key);
    await onHead(key, m.head);
  }

  /** Combining is not possible (a side is not a readable document): phase 1 behaviour (§5.4 step 4). */
  async function fallbackCopy(key: string, source: CombineSource, prep: Extract<Prepared, { kind: "fallback" }>): Promise<void> {
    const t = tabOf(key);
    if (!t?.path) return;
    const i = it(key);
    if (source.kind === "copy") return;     // the copy's banner stays (notSame / later)
    // My version (or the version this computer saved) is written beside the file as a copy.
    const mine = source.kind === "journal" ? prep.theirs : prep.mineFile;
    if (!mine) return;
    const head = mine.manifest.head;
    const scan = await quietly(backend.scanDir(parentDir(t.path)), null);
    const existing = scan && scan.ok
      ? scan.entries.find((e) => e.path !== t.path && e.header?.analysis_id === mine.manifest.analysis_id && e.header.head === head)?.path ?? null
      : null;
    const jr = revisionOf(mine.manifest, head);
    const label = !jr || jr.device_id === device?.device_id
      ? `(my version from ${device?.device_name || "this computer"})`
      : `(version from ${jr.device_name || "another computer"})`;
    const copy = existing ?? await writeCopyBeside(t.path, label, mine);
    if (copy) {
      i.knownCopies = addUnique(i.knownCopies, copy);
      addBanner(key, { id: "savedOver", kind: "savedOver", name: fileStem(copy), path: copy, actions: ["openCopy", "dismiss"] });
    }
    if (!i.settled.includes(head)) i.settled = [...i.settled, head];
    await saveSession();
    // A clean tab then shows the version on disk (phase 1).
    if (source.kind === "disk" && !tabDirty(key)) {
      const r = await readFile(t.path);
      const c = r.ok ? openFile(r.file) : null;
      if (r.ok && c && r.file.manifest.analysis_id === t.analysisId) {
        if (isLoaded(key)) {
          const s = graph.getState();
          replaceInPlace(key, { content: c, head: r.file.manifest.head, manifest: r.file.manifest, path: t.path, expectedBase: s.file?.baseRevision ?? null, expectedSerial: s.editSerial, readOnly: r.readOnly });
        } else {
          i.manifest = r.file.manifest;
          patchTab(key, { baseRevision: r.file.manifest.head, dirty: false });
        }
        await saveSession();
      }
    }
  }

  /** One combine (or save) per tab at a time: a Save pressed meanwhile gets the same outcome (§5.4 step 1). */
  function inSaveSlot<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const running = savesInFlight.get(key);
    let release!: (o: SaveOutcome) => void;
    const slot = new Promise<SaveOutcome>((r) => { release = r; });
    const run = (running ? running.then(() => undefined, () => undefined) : Promise.resolve()).then(fn);
    const mine = slot.finally(() => { if (savesInFlight.get(key) === mine) savesInFlight.delete(key); });
    savesInFlight.set(key, mine);
    void run.then((v) => release(outcomeOf(v)), () => release({ ok: false, reason: "failed" }));
    return run;
  }
  function outcomeOf(v: unknown): SaveOutcome {
    if (v && typeof v === "object" && "ok" in (v as object)) return v as SaveOutcome;
    const w = v as WriteResult | undefined;
    if (w?.kind === "saved") return { ok: true, path: w.path };
    if (w?.kind === "failed") return w.outcome;
    return { ok: false, reason: "conflict" };
  }

  /** startCombine (public): in the tab's save slot. */
  async function startCombineImpl(key: string, source: CombineSource, origin: CombineCtx["origin"] = "banner", opts: {
    queue?: string[]; index?: number; total?: number;
  } = {}): Promise<SaveOutcome> {
    const t = tabOf(key);
    if (!t?.path || t.saving || isCard(t.status)) return { ok: false, reason: "nothing" };
    if (presenceBlocks(key, "combine")) return { ok: false, reason: "readOnly" };
    if (savesInFlight.has(key)) return savesInFlight.get(key)!;
    cancelAuto(key);
    if (get().activeKey !== key) await switchTabImpl(key);
    it(key).catchUps = 0;
    const out = await inSaveSlot(key, () => startCombineCore(key, source, origin, opts));
    await Promise.resolve();
    recheckLater(key);
    return out;
  }

  /** Before combining with an extra copy (or a saved copy of this computer): the tab first takes in what its
   *  own file has that the tab doesn't (a newer version is shown, a diverged one combined; the person may be
   *  asked). "ok": the tab is on its file's newest version now (or the file can't be looked at, as before). */
  async function catchUpWithDisk(key: string, depth: number): Promise<"ok" | "stopped"> {
    const t = tabOf(key);
    if (!t?.path || !t.analysisId || !t.baseRevision) return "ok";
    const i = it(key);
    const r = await readFile(t.path);
    if (!r.ok || r.file.manifest.analysis_id !== t.analysisId) return "ok";
    const m = r.file.manifest;
    const H = m.head;
    const R = t.baseRevision;
    if (H === R) return "ok";
    if (depth > 1) return "stopped";
    const revs = unionRevisions(m, ...(i.manifest ? [i.manifest] : []));
    const rel = relation(revs, R, H);
    if (rel === "same") return "ok";
    if (rel === "older") {
      // Put back to an earlier version: the rollback note decides first.
      await quietly(invariantCheck(key, m), "ok" as const);
      return "stopped";
    }
    if (rel === "newer" && !tabDirty(key)) {
      // A click led here: the newer version is shown at once.
      const c = openFile(r.file);
      if (!c) return "stopped";
      if (isLoaded(key)) {
        const s0 = graph.getState();
        if (!replaceInPlace(key, { content: c, head: H, manifest: m, path: t.path, expectedBase: R, expectedSerial: s0.editSerial, readOnly: r.readOnly })) return "stopped";
      } else {
        i.manifest = m;
        patchTab(key, { baseRevision: H, readOnly: r.readOnly, dirty: false });
      }
      removeKinds(key, ["newerOnDisk", "rolledBack"]);
      await saveSession();
      return "ok";
    }
    // Unsaved changes on an older version, or another computer's save replaced mine: combined first.
    const out = await startCombineCore(key, { kind: "disk" }, "banner", {}, depth + 1);
    if (!out.ok || get().dialog?.kind === "combine") return "stopped";
    const h = await backend.header(t.path);
    return h.ok && h.header.head === tabOf(key)?.baseRevision ? "ok" : "stopped";
  }

  /** §5.4 procedure for one source: applied at once when nothing needs a choice, else the dialog. */
  async function startCombineCore(key: string, source: CombineSource, origin: CombineCtx["origin"], opts: {
    working?: Working | null; queue?: string[]; index?: number; total?: number;
  }, depth = 0): Promise<SaveOutcome> {
    const t = tabOf(key);
    if (!t?.path) return { ok: false, reason: "nothing" };
    const i = it(key);
    cancelAuto(key);
    if (source.kind === "copy" && !opts.working && (await catchUpWithDisk(key, depth)) === "stopped") {
      // The copy's banner stays; it can be combined once the tab is on its file's newest version.
      return { ok: false, reason: "conflict" };
    }
    const t1 = tabOf(key);
    if (!t1?.path) return { ok: false, reason: "nothing" };
    const fromBanner = t1.banners.find((b) => (source.kind === "copy" ? b.id === `copy:${source.path}` : b.kind === "newerOnDisk" || b.kind === "savedOver")) ?? null;
    const prep = await prepareCombine(key, source, origin, { ...opts, fromBanner });
    switch (prep.kind) {
      case "gone":
        // Removed or combined on another computer meanwhile: nothing to do.
        if (source.kind === "copy") forgetCopy(key, source.path);
        await nextInQueue(key, opts.queue ?? [], opts.index ?? 1, opts.total ?? 1);
        return { ok: true, path: tabOf(key)?.path ?? t.path };
      case "unreadable":
        addBanner(key, { kind: "saveFailed", message: "The other version can't be read yet. Try again in a moment." });
        return { ok: false, reason: "failed" };
      case "tooNew": addBanner(key, { kind: "tooNew" }); return { ok: false, reason: "failed" };
      case "failed": return { ok: false, reason: "failed" };
      case "notDiverged":
        if (source.kind === "journal" && !i.settled.includes(source.revisionId)) { i.settled = [...i.settled, source.revisionId]; await saveSession(); }
        if (source.kind === "copy") { removeBanners(key, (b) => b.id === `copy:${source.path}`); await handleSibling(key, source.path); }
        else if (prep.relation === "newer") { removeKinds(key, ["savedOver"]); await onHead(key, prep.theirs.manifest.head); }
        else removeBanners(key, (b) => b.kind === "newerOnDisk" || (b.kind === "savedOver" && !!b.state));
        await nextInQueue(key, opts.queue ?? [], (opts.index ?? 1) + 1, opts.total ?? 1);
        return { ok: true, path: tabOf(key)?.path ?? t.path };
      case "fallback": {
        if (source.kind === "disk") {
          const w = prep.working ?? await workingOf(key);
          if (!w) return { ok: false, reason: "failed" };
          return enterConflict(key, w, origin === "save" ? "save" : "banner");
        }
        await fallbackCopy(key, source, prep);
        return { ok: false, reason: "failed" };
      }
      case "plan": break;
    }
    const ctx = prep.ctx;
    i.lastSource = source;
    if (ctx.plan.autoApplicable) return applyNow(ctx);
    // Fixer VUX-3: choices made before the dialog was cancelled, for conflicts that are still the same.
    const was = i.cancelled;
    if (was && was.theirsRev.id === ctx.theirsRev.id && noChoices(ctx.choices)) ctx.choices = carryChoices(was, ctx);
    return openCombineDialog(ctx);
  }

  async function openCombineDialog(ctx: CombineCtx, extra: Partial<CombineStateP4> = {}): Promise<SaveOutcome> {
    const key = ctx.key;
    const i = it(key);
    i.combine = ctx;
    if (ctx.origin === "save") patchTab(key, { notSaved: true });
    if (ctx.fromBanner) removeBanners(key, (b) => b.id === ctx.fromBanner!.id);
    removeKinds(key, ["notSaved"]);
    await saveSession();
    set({ dialog: { kind: "combine", state: await combineStateOf(ctx, extra) } });
    return { ok: false, reason: "conflict" };
  }

  /** Write a plan that needs no choice now (a click or Save led here), up to 3 rounds when the file moves on. */
  async function applyNow(ctx0: CombineCtx): Promise<SaveOutcome> {
    let ctx = ctx0;
    for (let round = 0; round < 3; round++) {
      const w = await writeCombine(ctx, ctx.plan.autoApplicable && noChoices(ctx.choices), { hold: false });
      if (w.kind === "saved") { await nextInQueue(ctx.key, ctx.queue, ctx.index + 1, ctx.total); return { ok: true, path: w.path }; }
      if (w.kind === "failed") return w.outcome;
      if (w.kind === "changed") return openCombineDialog(w.ctx);
      if (w.kind === "diskAhead") {
        // The tab's own file moved on: that first, then this copy again.
        const i = it(ctx.key);
        if (round > 0 || i.catchUps > 1) break;
        i.catchUps++;
        return startCombineCore(ctx.key, ctx.source, ctx.origin, { queue: ctx.queue, index: ctx.index, total: ctx.total }, 1);
      }
      const again = await prepareCombine(ctx.key, ctx.source, ctx.origin, { queue: ctx.queue, index: ctx.index, total: ctx.total, fromBanner: ctx.fromBanner });
      if (again.kind !== "plan") return startCombineCore(ctx.key, ctx.source, ctx.origin, { queue: ctx.queue, index: ctx.index, total: ctx.total });
      if (!again.ctx.plan.autoApplicable) return openCombineDialog(again.ctx);
      ctx = again.ctx;
    }
    if (ctx.source.kind === "copy") {
      // An extra copy's own banner is the way back (never "saved over your last save").
      await quietly(handleSibling(ctx.key, ctx.source.path), undefined);
      return { ok: false, reason: "failed" };
    }
    chooseBanner(ctx.key, ctx.source, vi(ctx.theirsFile.manifest, ctx.theirsRev.id));
    return { ok: false, reason: "failed" };
  }

  async function nextInQueue(key: string, queue: string[], index: number, total: number): Promise<void> {
    if (!queue.length || !tabOf(key)) return;
    const [next, ...rest] = queue;
    await startCombineCore(key, { kind: "copy", path: next }, "banner", { queue: rest, index, total });
  }

  /** Save met another version on disk (§5.5 C). */
  async function combineOnSave(key: string, w: Working, again = true): Promise<SaveOutcome> {
    const t = tabOf(key)!;
    const r = await readFile(t.path!);
    if (!r.ok) {
      addBanner(key, { kind: "saveFailed", message: "The file was changed on another computer and can't be read yet. Try again in a moment." });
      return { ok: false, reason: "failed" };
    }
    const T = r.file.manifest.head;
    const R = t.baseRevision;
    const revs = unionRevisions(w.manifest, r.file.manifest);
    if (R && T !== R && isAncestorOrSelf(w.manifest, T, R) && T === it(key).acceptedHead && again) {
      // The person already chose "Use the earlier version": the changes are saved on top of it.
      await moveBaseTo(key, r.file);
      return saveOnceAgain(key);
    }
    if (R && T !== R && isAncestorOrSelf(w.manifest, T, R)) {
      // The file was put back to an earlier version: shown, never undone automatically.
      await quietly(backend.writeJournal(t.path!, { manifest: w.manifest, parts: { ...w.parts.texts } }), undefined);
      const b = addBanner(key, { id: "rolledBack", kind: "rolledBack", version: vi(r.file.manifest, T), when: revisionOf(r.file.manifest, T)?.time });
      if (b) it(key).bannerData.set(b.id, R);
      patchTab(key, { notSaved: true });
      return { ok: false, reason: "conflict" };
    }
    void revs;
    return startCombineCore(key, { kind: "disk" }, "save", { working: w });
  }

  async function applyCombineImpl(): Promise<SaveOutcome> {
    const d = get().dialog;
    if (!d || d.kind !== "combine") return { ok: false, reason: "nothing" };
    const key = d.state.tabKey;
    const i = it(key);
    const ctx = i.combine;
    if (!ctx || d.state.applying) return { ok: false, reason: "nothing" };
    if (presenceBlocks(key, "applyCombine")) {
      // Fixer round 2 (RV-2): the tab became read-only while the dialog was open; the notice is behind the dialog.
      set({ dialog: { kind: "combine", state: { ...d.state, error: APPLY_READ_ONLY } } });
      return { ok: false, reason: "readOnly" };
    }
    set({ dialog: { kind: "combine", state: { ...d.state, applying: true, error: null } } });
    const out = await inSaveSlot(key, async () => {
      let cur = ctx;
      for (let round = 0; round < 3; round++) {
        const w = await writeCombine(cur, cur.plan.autoApplicable && presetOnly(cur), { hold: false });
        if (w.kind === "diskAhead") {
          // Combining with an extra copy while the tab's own file has a newer version: that is taken in
          // first (combined, or the person is asked), then this copy is offered again.
          // Fixer VS-1: also the context 7.1 put together again (typing while the dialog was open) — left set, it
          // kept the tab from ever showing a later version.
          if (i.combine === ctx || i.combine === cur || i.combine === w.used) i.combine = null;
          const dd = get().dialog;
          if (dd?.kind === "combine" && dd.state.tabKey === key) set({ dialog: null });
          i.catchUps = 0;
          return startCombineCore(key, cur.source, cur.origin, { queue: cur.queue, index: cur.index, total: cur.total });
        }
        if (w.kind === "saved") {
          if (i.combine === ctx || i.combine === cur || i.combine === w.used) i.combine = null;
          i.cancelled = null;
          const dd = get().dialog;
          if (dd?.kind === "combine" && dd.state.tabKey === key) set({ dialog: null });
          await nextInQueue(key, cur.queue, cur.index + 1, cur.total);
          return { ok: true, path: w.path } as SaveOutcome;
        }
        if (w.kind === "failed") {
          const dd = get().dialog;
          if (dd?.kind === "combine" && dd.state.tabKey === key) {
            set({ dialog: { kind: "combine", state: { ...dd.state, applying: false, error: "The combined version couldn't be saved. Nothing was changed." } } });
          }
          return w.outcome;
        }
        const next = w.kind === "changed" ? w.ctx : await (async () => {
          const again = await prepareCombine(key, cur.source, cur.origin, { queue: cur.queue, index: cur.index, total: cur.total, fromBanner: cur.fromBanner });
          return again.kind === "plan" ? again.ctx : null;
        })();
        if (!next) {
          const dd = get().dialog;
          if (dd?.kind === "combine") set({ dialog: { kind: "combine", state: { ...dd.state, applying: false, error: "The other version can't be read yet. Try again in a moment." } } });
          return { ok: false, reason: "failed" } as SaveOutcome;
        }
        if (w.kind !== "changed") next.choices = carryChoices(cur, next);
        i.combine = next;
        if (w.kind === "changed" || await lookAgain(cur, next, false)) {
          // Something changed underneath (a status, or a part somebody chose for): the person looks again;
          // nothing was written. Fixer VUX-6: the dialog says why it came back.
          const newer = next.theirsRev.id !== cur.theirsRev.id || next.theirsFile.manifest.head !== cur.theirsFile.manifest.head;
          await openCombineDialog(next, { error: newer ? LOOK_AGAIN_NEWER : LOOK_AGAIN_EDITED });
          return { ok: false, reason: "conflict" } as SaveOutcome;
        }
        cur = next;
      }
      const dd = get().dialog;
      if (dd?.kind === "combine") set({ dialog: { kind: "combine", state: { ...dd.state, applying: false, error: "The file keeps changing on another computer. Try again in a moment." } } });
      return { ok: false, reason: "failed" } as SaveOutcome;
    });
    await Promise.resolve();
    recheckLater(key);
    return out;
  }

  async function setSectionChoiceImpl(section: SectionName, choice: SidePick): Promise<void> {
    const d = get().dialog;
    if (!d || d.kind !== "combine") return;
    const ctx = it(d.state.tabKey).combine;
    if (!ctx) return;
    ctx.choices = { ...ctx.choices, sections: { ...(ctx.choices.sections ?? {}), [section]: choice } };
    await refreshCombineDialog(d.state.tabKey, ctx, d.state);
  }

  async function refreshCombineDialog(key: string, ctx: CombineCtx, was: CombineState): Promise<void> {
    const st = await combineStateOf(ctx, { index: was.index, total: was.total });
    const now2 = get().dialog;
    if (now2?.kind === "combine" && now2.state.tabKey === key && it(key).combine === ctx) {
      set({ dialog: { kind: "combine", state: { ...st, applying: now2.state.applying, error: now2.state.error } } });
    }
  }

  /** A whole-section choice of `section` goes (a per-conflict choice was made there). */
  function dropSectionChoice(c: CombineChoices, section: SectionName): CombineChoices["sections"] {
    const { [section]: _gone, ...rest } = c.sections ?? {};
    return Object.keys(rest).length ? rest : undefined;
  }

  /** §5.3 setConflictChoice: nothing is written. */
  async function setConflictChoiceImpl(conflictId: string, choice: FineChoice): Promise<void> {
    const d = get().dialog;
    if (!d || d.kind !== "combine") return;
    const ctx = it(d.state.tabKey).combine;
    if (!ctx) return;
    const s = ctx.plan.sections.find((x) => x.conflicts.some((c) => c.id === conflictId));
    const c = s?.conflicts.find((x) => x.id === conflictId);
    if (!s || !c || !c.options.includes(choice)) return;
    const sections = dropSectionChoice(ctx.choices, s.key);
    ctx.choices = { ...(sections ? { sections } : {}), fine: { ...(ctx.choices.fine ?? {}), [conflictId]: choice } };
    await refreshCombineDialog(d.state.tabKey, ctx, d.state);
  }

  /** §5.3 setAllInSection ("Use mine / theirs for all"): every conflict of the section, also those not drawn. */
  async function setAllInSectionImpl(section: SectionName, side: SidePick): Promise<void> {
    const d = get().dialog;
    if (!d || d.kind !== "combine") return;
    const ctx = it(d.state.tabKey).combine;
    if (!ctx) return;
    const s = ctx.plan.sections.find((x) => x.key === section);
    if (!s) return;
    const fine = { ...(ctx.choices.fine ?? {}) };
    for (const c of s.conflicts) if (c.options.includes(side)) fine[c.id] = side;
    const sections = dropSectionChoice(ctx.choices, section);
    ctx.choices = { ...(sections ? { sections } : {}), fine };
    await refreshCombineDialog(d.state.tabKey, ctx, d.state);
  }

  /** Fixer VUX-4: "Use mine / theirs for the rest": that side for every conflict of the section that has no
   *  choice yet (also those not drawn); the choices already made stay. */
  async function setRestInSectionImpl(section: SectionName, side: SidePick): Promise<void> {
    const d = get().dialog;
    if (!d || d.kind !== "combine") return;
    const ctx = it(d.state.tabKey).combine;
    if (!ctx) return;
    const s = ctx.plan.sections.find((x) => x.key === section);
    if (!s) return;
    const fine = { ...(ctx.choices.fine ?? {}) };
    for (const c of s.conflicts) {
      const v = fine[c.id];
      if ((v === undefined || !c.options.includes(v)) && c.options.includes(side)) fine[c.id] = side;
    }
    const sections = dropSectionChoice(ctx.choices, section);
    ctx.choices = { ...(sections ? { sections } : {}), fine };
    await refreshCombineDialog(d.state.tabKey, ctx, d.state);
  }

  function cancelCombineImpl(): void {
    const d = get().dialog;
    if (!d || d.kind !== "combine") return;
    const key = d.state.tabKey;
    const i = it(key);
    const ctx = i.combine;
    i.combine = null;
    set({ dialog: null });
    if (!ctx || !tabOf(key)) return;
    // Fixer VUX-3: the choices made are kept for the same pair of versions (Esc or Cancel by mistake).
    i.cancelled = noChoices(ctx.choices) ? null : ctx;
    if (ctx.origin === "save") {
      patchTab(key, { notSaved: true });
      i.lastSource = ctx.source;
      addBanner(key, { kind: "notSaved", version: vi(ctx.theirsFile.manifest, ctx.theirsRev.id) });
    } else if (ctx.fromBanner) {
      const { id: _id, ...rest } = ctx.fromBanner;
      const b = addBanner(key, { ...rest, id: ctx.fromBanner.id });
      if (b) i.bannerSource.set(b.id, ctx.source);
    }
    void saveSession();
    recheckLater(key);
  }

  async function keepBothAsSeparateImpl(): Promise<void> {
    const d = get().dialog;
    if (!d || d.kind !== "combine") return;
    const key = d.state.tabKey;
    const i = it(key);
    const ctx = i.combine;
    i.combine = null;
    set({ dialog: null });
    const t = tabOf(key);
    if (!ctx || !t?.path || !t.analysisId) return;
    const aid = t.analysisId;
    if (ctx.source.kind === "copy") { await markDifferentAnalysisImpl(key, ctx.source.path); return; }
    if (ctx.source.kind === "journal") {
      // That version is written beside the file as a new analysis.
      const c = openFile(ctx.theirsFile, ctx.theirsRev.id);
      if (!c) return;
      const who = ctx.theirsRev.device_name || "another computer";
      const target = await freeBeside(t.path, `(version from ${who})`);
      const file = await newFile({
        content: c, analysisId: newAnalysisId(), forkedFrom: { analysis_id: aid, revision_id: ctx.theirsRev.id }, time: now(), author: author(),
        summary: SUMMARY.first,
      });
      const res = await backend.save({ path: target, expectedHead: null, analysisId: file.manifest.analysis_id, docKey: newDocKey(), manifest: file.manifest, newParts: file.parts });
      if (!res.ok) { addBanner(key, { kind: "saveFailed", message: res.kind === "error" ? saveFailedMessage(res.code) : saveFailedMessage("Io") }); return; }
      i.knownCopies = addUnique(i.knownCopies, res.path);
      if (!i.settled.includes(ctx.theirsRev.id)) i.settled = [...i.settled, ctx.theirsRev.id];
      removeKinds(key, ["savedOver"]);
      toast({ tone: "success", kind: "savedAsNew", name: fileStem(res.path) });
      await saveSession();
      return;
    }
    // disk: mine as a new analysis in a place the person picks; this file is left as they saved it.
    const w = ctx.working ?? await workingOf(key);
    if (!w) return;
    await separateCopyImpl(key, { ...w, theirs: ctx.theirsFile, base: t.baseRevision });
  }

  async function undoCombineImpl(key: string): Promise<SaveOutcome> {
    if (presenceBlocks(key, "undoCombine")) return { ok: false, reason: "readOnly" };
    const i = it(key);
    const prev = i.preCombineHead;
    if (!prev) return { ok: false, reason: "nothing" };
    const out = await bringBackImpl(prev, key);
    if (out.ok) removeKinds(key, ["combined"]);
    return out;
  }

  async function showWhatChangedImpl(key: string): Promise<void> {
    await openVersionsImpl(key);
    const v = get().versions;
    if (!v || v.tabKey !== key) return;
    // My version from before the combine against the combined one shows what came in.
    const prev = it(key).preCombineHead;
    const id = prev && v.rows.some((r) => r.id === prev) ? prev : tabOf(key)?.baseRevision ?? null;
    if (!id) return;
    await selectVersionImpl(id);
    await compareWithCurrentImpl(true);
  }

  // ── a file put back to an earlier version ──

  async function useEarlierImpl(key: string): Promise<void> {
    const t = tabOf(key);
    if (!t?.path) return;
    if (presenceBlocks(key, "useEarlierVersion")) return;
    const i = it(key);
    const r = await readFile(t.path);
    if (!r.ok) return;
    const H = r.file.manifest.head;
    i.acceptedHead = H;
    // Everything newer that this device saved is not asked about again; its history goes into the next save.
    const heads = await backend.journalHeads(r.file.manifest.analysis_id, t.path);
    for (const j of heads) {
      if (j.confirmed || j.revision_id === H || isAncestorOrSelf(r.file.manifest, j.revision_id, H)) continue;
      if (!i.settled.includes(j.revision_id)) i.settled = [...i.settled, j.revision_id];
      if (!i.carryHeads.includes(j.revision_id)) i.carryHeads = [...i.carryHeads, j.revision_id];
    }
    removeKinds(key, ["rolledBack"]);
    if (!tabDirty(key)) {
      const c = openFile(r.file);
      if (isLoaded(key) && c) {
        replaceInPlace(key, { content: c, head: H, manifest: r.file.manifest, path: t.path, expectedBase: graph.getState().file?.baseRevision ?? null, expectedSerial: graph.getState().editSerial });
      } else {
        i.manifest = r.file.manifest;
        patchTab(key, { baseRevision: H, dirty: false });
      }
    } else await moveBaseTo(key, r.file);
    patchTab(key, { notSaved: false });
    await saveSession();
  }

  /** "Use the earlier version" with unsaved changes: they stay, now on top of the version in the file, so the
   *  next save is an ordinary one; the version they were made on is taken into the file's history with it. */
  async function moveBaseTo(key: string, file: GraphFileData): Promise<void> {
    const t = tabOf(key);
    if (!t) return;
    const i = it(key);
    const H = file.manifest.head;
    const R = t.baseRevision;
    if (R && R !== H && !i.carryHeads.includes(R)) i.carryHeads = [...i.carryHeads, R];
    if (R && !i.settled.includes(R)) i.settled = [...i.settled, R];
    i.manifest = file.manifest;
    i.lastWorking = null;
    patchTab(key, { baseRevision: H });
    removeKinds(key, ["newerOnDisk"]);
    if (isLoaded(key)) {
      suppress++;
      try { graph.getState().setFileRef({ baseRevision: H }); } finally { suppress--; }
      await writeActiveDraft(false);
    } else {
      const d = await quietly(backend.readDraft(key), null);
      if (d) await putDraft(key, { ...d, base_revision: H }, undefined);
    }
  }

  async function goBackToMyLatestImpl(key: string): Promise<void> {
    const t = tabOf(key);
    if (t && presenceBlocks(key, "goBackToMyLatest")) return;
    const i = it(key);
    const b = t?.banners.find((x) => x.kind === "rolledBack");
    const j = b ? i.bannerData.get(b.id) : undefined;
    if (!t?.path || !t.analysisId || !j || !b) return;
    const jf = await readJournalFile(t.analysisId, j);
    const cur = await readFile(t.path);
    if (!jf || !cur.ok || cur.file.manifest.analysis_id !== t.analysisId) { addBanner(key, { kind: "saveFailed", message: "Your latest version couldn't be put back yet. Try again in a moment." }); return; }
    const dm = cur.file.manifest;
    if (!isAncestorOrSelfIn(unionRevisions(jf.manifest, dm), dm.head, j)) {
      // The file moved on since it was put back (another computer saved on top): never overwritten. My latest
      // version is combined with what is in the file instead.
      removeBanners(key, (x) => x.id === b.id);
      i.acceptedHead = null;
      await saveSession();
      await startCombineImpl(key, t.baseRevision === j ? { kind: "disk" } : { kind: "journal", revisionId: j }, "banner");
      return;
    }
    // Everything the file has stays in its history (nothing is rewritten).
    const manifest = await retain(unionManifests(jf.manifest, dm), [j, dm.head]);
    const res = await backend.save({
      path: t.path, expectedHead: dm.head, analysisId: t.analysisId, docKey: key, manifest, newParts: partsNotIn(jf.parts, cur.file),
    });
    if (!res.ok) { addBanner(key, { kind: "saveFailed", message: res.kind === "error" ? saveFailedMessage(res.code) : "The file changed again. Try again in a moment." }); return; }
    removeBanners(key, (x) => x.id === b.id);
    i.acceptedHead = null;
    if (!tabDirty(key)) {
      const c = openFile(jf);
      if (isLoaded(key) && c) {
        replaceInPlace(key, { content: c, head: res.head, manifest, path: t.path, expectedBase: graph.getState().file?.baseRevision ?? null, expectedSerial: graph.getState().editSerial });
      } else {
        i.manifest = manifest;
        patchTab(key, { baseRevision: res.head, dirty: false });
      }
    }
    patchTab(key, { notSaved: false });
    await saveSession();
  }

  // ── extra copies (§5.6) ──

  /** An extra copy that is no longer there (removed or combined on another computer): its banner goes,
   *  quietly, and it is not looked at again. */
  function forgetCopy(key: string, path: string): void {
    const i = internal.get(key);
    removeBanners(key, (b) => b.id === `copy:${path}`);
    if (!i) return;
    i.bannerSource.delete(`copy:${path}`);
    i.seenCopies = i.seenCopies.filter((p) => p !== path);
    i.asides = i.asides.filter((p) => p !== path);
    const { [path]: _k, ...kept } = i.keptHeads;
    i.keptHeads = kept;
    void saveSession();
    touchVersions(key);
  }

  async function removeExtraCopyImpl(key: string, path: string): Promise<boolean> {
    const t = tabOf(key);
    const name = fileStem(path);
    if (!t?.path || !t.analysisId) return false;
    if (tabByPath(path)) { toast({ tone: "error", kind: "error", message: `'${name}' is open in a tab. Close it first.` }); return false; }
    const res = await backend.removeCopy({ path, keeper: t.path, analysisId: t.analysisId });
    const i = it(key);
    if (res.ok) {
      removeBanners(key, (b) => b.id === `copy:${path}`);
      i.knownCopies = i.knownCopies.filter((p) => p !== path);
      i.seenCopies = i.seenCopies.filter((p) => p !== path);
      i.asides = i.asides.filter((p) => p !== path);
      const { [path]: _gone, ...answers } = i.copyAnswer;
      i.copyAnswer = answers;
      if (recentEntries.some((e) => e.path === path)) await writeRecent(recentEntries.filter((e) => e.path !== path));
      await saveSession();
      toast({ tone: "success", kind: "copyRemoved", name });
      touchVersions(key);
      return true;
    }
    if (res.kind === "refused") {
      if (res.reason === "open") toast({ tone: "error", kind: "error", message: `'${name}' is open in a tab. Close it first.` });
      else if (res.reason === "notOlder") {
        toast({ tone: "error", kind: "error", message: `'${name}' has changes that aren't in this file, so it wasn't removed.` });
        removeBanners(key, (b) => b.id === `copy:${path}`);
        // It was treated as a copy of this analysis (Remove it): the diverged / newer banner, no question.
        i.copyAnswer = { ...i.copyAnswer, [path]: "same" };
        await saveSession();
        await quietly(handleSibling(key, path), undefined);
      } else toast({ tone: "error", kind: "error", message: `'${name}' couldn't be removed.` });
      return false;
    }
    if (res.code === "NotFound") {
      // Already gone (removed or combined on another computer): nothing to remove.
      forgetCopy(key, path);
      return false;
    }
    toast({ tone: "error", kind: "error", message: `'${name}' couldn't be removed.` });
    return false;
  }

  async function markDifferentAnalysisImpl(key: string, path: string): Promise<void> {
    await makeSeparate(key, path);
    touchVersions(key);
  }

  // ── the Versions panel (§5.8) ──

  interface VersionsCtx {
    key: string;
    aid: string;
    file: GraphFileData;
    copies: { path: string; file: GraphFileData }[];
    revs: Revision[];
    pool: SnapshotPool;
  }
  let vctx: VersionsCtx | null = null;
  let versionsSeq = 0;
  let versionsQueued = false;

  const emptyLayout = (): LaneLayout => ({ rows: [], edges: [], laneCount: 0, devices: [] });

  /** Rebuild the open panel after a save, reload, combine or copy event of its tab. */
  function touchVersions(key: string): void {
    if (get().versions?.tabKey !== key || versionsQueued) return;
    versionsQueued = true;
    void Promise.resolve().then(async () => {
      versionsQueued = false;
      if (get().versions?.tabKey === key) await quietly(buildVersions(key), undefined);
    });
  }

  async function buildVersions(key: string): Promise<void> {
    const t = tabOf(key);
    if (!t?.path || !t.analysisId) return;
    const seq = ++versionsSeq;
    const cur = get().versions;
    if (!cur || cur.tabKey !== key) {
      set({
        versions: {
          tabKey: key, name: t.title, loading: true, rows: [], layout: emptyLayout(), devices: [], stubs: [], tooOld: 0,
          selectedId: null, preview: null, comparing: false, busy: null,
        },
      });
    } else set({ versions: { ...cur, loading: true, name: t.title } });
    const i = it(key);
    const r = await readFile(t.path);
    const file: GraphFileData | null = r.ok && r.file.manifest.analysis_id === t.analysisId ? r.file
      : i.manifest ? { manifest: i.manifest, parts: {} } : null;
    if (seq !== versionsSeq || get().versions?.tabKey !== key) return;
    if (!file) { const v = get().versions; if (v) set({ versions: { ...v, loading: false } }); return; }
    const aid = file.manifest.analysis_id;
    const myId = device?.device_id ?? "";
    // Extra copies of this analysis in the folder.
    const scan = await quietly(backend.scanDir(parentDir(t.path)), null);
    const entries = scan && scan.ok ? scan.entries : [];
    const copies: { path: string; file: GraphFileData }[] = [];
    for (const e of entries) {
      if (e.kind !== "graph" || e.path === t.path || e.header?.analysis_id !== aid) continue;
      const cr = await readFile(e.path);
      if (cr.ok && cr.file.manifest.analysis_id === aid) copies.push({ path: e.path, file: cr.file });
    }
    // My last save that another computer's save replaced is not in the file yet: shown on its own line (from the
    // tab's own history, or this computer's saved copy), so the list doesn't look as if it vanished.
    const pendingMine: Manifest[] = [];
    if (t.baseRevision && !revisionOf(file.manifest, t.baseRevision) && i.manifest && revisionOf(i.manifest, t.baseRevision)) pendingMine.push(i.manifest);
    for (const b of t.banners) {
      const src = b.kind === "savedOver" && b.state ? i.bannerSource.get(b.id) : undefined;
      if (src?.kind !== "journal" || revisionOf(file.manifest, src.revisionId)) continue;
      const jf = await readJournalFile(aid, src.revisionId);
      if (jf) pendingMine.push(jf.manifest);
    }
    const revs = unionRevisions(file.manifest, ...copies.map((c) => c.file.manifest), ...pendingMine);
    const pendingIds = new Set(pendingMine.map((pm) => (pm === i.manifest ? t.baseRevision! : pm.head)));
    const own = new Set(file.manifest.revisions.map((x) => x.id));
    const ids = new Set(revs.map((x) => x.id));
    // Separated analyses (their own files, made from one of these versions).
    const stubs: VersionStub[] = [];
    const others = entries.filter((e) => e.kind === "graph" && e.path !== t.path && e.header && e.header.analysis_id !== aid)
      .slice(0, LIMITS_P2.branchScanFiles).map((e) => e.path);
    for (const p of [...new Set([...i.knownCopies, ...others])]) {
      if (p === t.path || copies.some((c) => c.path === p)) continue;
      const pk = await quietly(backend.peek(p), null);
      if (!pk || !pk.ok) continue;
      const ff = pk.manifest.forked_from;
      if (ff && ff.analysis_id === aid && ids.has(ff.revision_id)) stubs.push({ from: ff.revision_id, name: fileStem(p), path: p });
    }
    // The tab's unsaved changes as a first row.
    const dirty = tabDirty(key);
    const devOf = new Map(revs.map((x) => [x.id, x.device_id ?? ""] as const));
    const nodes: LaneNode[] = revs.map((x) => {
      let parents = Array.isArray(x.parents) ? x.parents : [];
      // At a combine, the line of this computer continues straight down (lane 0 follows the first parent).
      if (parents.length === 2 && myId && devOf.get(parents[1]) === myId && devOf.get(parents[0]) !== myId) parents = [parents[1], parents[0]];
      return { id: x.id, parents, time: x.time, deviceId: x.device_id ?? "", ...(own.has(x.id) ? {} : { foreign: true }) };
    });
    if (dirty && t.baseRevision) nodes.push({ id: WORKING_ROW, parents: [t.baseRevision], time: iso(now()), deviceId: myId });
    const layout = layoutLanes(nodes, t.baseRevision);
    const pool = snapshotPool([file, ...copies.map((c) => c.file)]);
    const jheads = new Set((await quietly(backend.journalHeads(aid), [] as JournalHead[])).map((j) => j.revision_id));
    if (seq !== versionsSeq || get().versions?.tabKey !== key) return;
    const byId = new Map(revs.map((x) => [x.id, x] as const));
    const copyHead = new Map<string, string>();
    for (const c of [...copies].sort((a, b) => (a.path < b.path ? 1 : -1))) copyHead.set(c.file.manifest.head, c.path);
    const rows: VersionRow[] = layout.rows.map((lr) => {
      if (lr.id === WORKING_ROW) {
        return {
          id: WORKING_ROW, kind: "working", summary: "Unsaved changes", who: null, chips: ["unsaved"], openable: true, foreign: false,
          copyName: null, copyPath: null, restoredFrom: null,
        };
      }
      const rev = byId.get(lr.id)! as RevisionP2;
      const first = rev.parents?.[0] ? byId.get(rev.parents[0]) ?? null : null;
      const openable = !!rev.sections && (pool.has(rev.id) || jheads.has(rev.id)) || (!rev.sections && jheads.has(rev.id));
      const chips: VersionChip[] = [];
      if (rev.id === t.baseRevision) chips.push("current");
      if ((rev.parents?.length ?? 0) >= 2) chips.push("combined");
      if (rev.kind === "restore") chips.push("broughtBack");
      if (rev.kind === "import") chips.push("fromOldLibrary");
      if (!openable) chips.push("tooOld");
      const cp = copyHead.get(rev.id) ?? null;
      return {
        id: rev.id, kind: rev.kind, summary: pendingIds.has(rev.id) ? (myId && rev.device_id === myId ? PENDING_SUMMARY : PENDING_SUMMARY_OTHER) : displaySummary(rev, first), openable, chips,
        who: rev.auto ? null : { head: rev.id, userName: rev.user_name ?? "", deviceName: rev.device_name ?? "", time: rev.time ?? "", mine: !!myId && rev.device_id === myId },
        foreign: !own.has(rev.id), copyName: cp ? fileStem(cp) : null, copyPath: cp, restoredFrom: rev.kind === "restore" ? rev.restored_from ?? null : null,
      };
    });
    // Newest name seen for each computer.
    const names = new Map<string, string>();
    for (const lr of layout.rows) {
      const rev = byId.get(lr.id);
      if (rev && rev.device_id && rev.device_name && !names.has(rev.device_id)) names.set(rev.device_id, rev.device_name);
    }
    if (myId && device?.device_name) names.set(myId, device.device_name);
    const devices = layout.devices.map((d) => ({ deviceId: d, deviceName: names.get(d) ?? "", mine: d === myId }));
    vctx = { key, aid, file, copies, revs, pool };
    const prev = get().versions;
    if (!prev || prev.tabKey !== key) return;
    const keep = prev.selectedId && rows.some((x) => x.id === prev.selectedId) ? prev.selectedId : null;
    set({
      versions: {
        ...prev, name: t.title, loading: false, rows, layout, devices, stubs, tooOld: rows.filter((x) => x.chips.includes("tooOld")).length,
        selectedId: keep, preview: keep ? prev.preview : null, comparing: keep ? prev.comparing : false,
      },
    });
  }

  async function openVersionsImpl(key?: string): Promise<void> {
    const k = key ?? get().activeKey;
    const t = tabOf(k);
    if (!k || !t || !t.path) return;
    if (get().activeKey !== k) await switchTabImpl(k);
    if (get().activeKey !== k) return;
    await buildVersions(k);
  }

  function closeVersionsImpl(): void {
    if (get().versions) set({ versions: null });
    vctx = null;
  }

  /** A version's content: from this file, an extra copy that has it, or this computer's saved copy. */
  async function versionData(id: string): Promise<{ content: DocContent; rev: Revision; parts: Record<string, string>; manifest: Manifest } | null> {
    const v = get().versions;
    const key = v?.tabKey ?? get().activeKey;
    const t = tabOf(key);
    if (!t?.analysisId) return null;
    const files: GraphFileData[] = vctx && vctx.key === key ? [vctx.file, ...vctx.copies.map((c) => c.file)] : [];
    if (!files.length && t.path) { const r = await readFile(t.path); if (r.ok) files.push(r.file); }
    for (const f of files) {
      const rev = revisionOf(f.manifest, id);
      const sec = rev?.sections ? revisionSections(f, id) : null;
      const c = sec ? contentOfSections(sec) : null;
      if (rev && c) return { content: c, rev, parts: f.parts, manifest: f.manifest };
    }
    const j = await readJournalFile(t.analysisId, id);
    const rev = j ? revisionOf(j.manifest, id) : null;
    const c = j ? openFile(j, id) : null;
    return j && rev && c ? { content: c, rev, parts: j.parts, manifest: j.manifest } : null;
  }

  /** The tab's content now (unsaved changes included; the scratchpad flushed first). */
  async function currentContent(key: string): Promise<DocContent | null> {
    if (isLoaded(key)) { deps.flushScratch({ commitEdit: false }); return content(); }
    const d = await quietly(backend.readDraft(key), null);
    if (d) return contentOfDraft(d);
    const t = tabOf(key);
    if (!t?.analysisId || !t.baseRevision) return null;
    const j = await readJournalFile(t.analysisId, t.baseRevision);
    return j ? openFile(j, t.baseRevision) : null;
  }

  async function selectVersionImpl(id: string | null): Promise<void> {
    const v = get().versions;
    if (!v) return;
    if (id === null) { set({ versions: { ...v, selectedId: null, preview: null } }); return; }
    set({ versions: { ...v, selectedId: id, preview: { id, loading: true, content: null, compare: null, current: null } } });
    let c: DocContent | null;
    if (id === WORKING_ROW) c = await currentContent(v.tabKey);
    else {
      const row = v.rows.find((x) => x.id === id);
      c = row && !row.openable ? null : (await versionData(id))?.content ?? null;
    }
    const v2 = get().versions;
    if (!v2 || v2.selectedId !== id) return;
    let compare = null, current = null;
    if (v2.comparing && c) {
      current = await currentContent(v2.tabKey);
      compare = current ? compareSections(sectionsOf(c), sectionsOf(current)) : null;
    }
    const v3 = get().versions;
    if (!v3 || v3.selectedId !== id) return;
    set({ versions: { ...v3, preview: { id, loading: false, content: c, compare, current } } });
  }

  async function compareWithCurrentImpl(on?: boolean): Promise<void> {
    const v = get().versions;
    if (!v) return;
    const next = on ?? !v.comparing;
    if (!next) { set({ versions: { ...v, comparing: false, preview: v.preview ? { ...v.preview, compare: null, current: null } : null } }); return; }
    set({ versions: { ...v, comparing: true } });
    const p = v.preview;
    if (!p?.content) return;
    const current = await currentContent(v.tabKey);
    const v2 = get().versions;
    if (!v2 || v2.selectedId !== p.id || !v2.preview) return;
    set({ versions: { ...v2, preview: { ...v2.preview, compare: current ? compareSections(sectionsOf(p.content), sectionsOf(current)) : null, current } } });
  }

  // ── Bring back (§5.10) ──

  async function bringBackImpl(id: string, keyArg?: string): Promise<SaveOutcome> {
    const key = keyArg ?? get().versions?.tabKey ?? get().activeKey;
    const t = tabOf(key);
    if (!key || !t?.path || !t.analysisId) return { ok: false, reason: "nothing" };
    if (presenceBlocks(key, "bringBack")) return { ok: false, reason: "readOnly" };
    if (isLoaded(key)) deps.flushScratch({ commitEdit: true });
    if (tabDirty(key)) {
      const data0 = await versionData(id);
      const a = await ask({
        kind: "bringBackDirty", tabKey: key, title: t.title,
        version: data0 ? vi(data0.manifest, id) : { head: id, userName: "", deviceName: "", time: "", mine: false },
      });
      if (get().dialog?.kind === "bringBackDirty") set({ dialog: null });
      if (a.kind !== "bringBackDirty" || a.choice === "cancel") return { ok: false, reason: "cancelled" };
      const saved = await saveImpl(key);
      if (!saved.ok) return { ok: false, reason: "failed" };
    }
    const setBusy = (b: VersionsState["busy"]) => { const v = get().versions; if (v && v.tabKey === key) set({ versions: { ...v, busy: b } }); };
    setBusy("bringBack");
    try {
      const t1 = tabOf(key)!;
      const data = await versionData(id);
      if (!data || !data.rev.sections) {
        toast({ tone: "error", kind: "error", message: "This version can no longer be opened." });
        return { ok: false, reason: "failed" };
      }
      const R = t1.baseRevision;
      const r = await readFile(t1.path!);
      const baseM = r.ok && r.file.manifest.head === R ? r.file.manifest : it(key).manifest;
      const headRev = baseM ? revisionOf(baseM, R) : null;
      if (!baseM || !R) return { ok: false, reason: "failed" };
      if (headRev && headRev.content_hash === data.rev.content_hash) {
        toast({ tone: "info", kind: "error", message: "That version is the same as the current one." });
        return { ok: false, reason: "nothing" };
      }
      const refs = data.rev.sections;
      const rev: RevisionP2 = {
        ...makeRev({
          id: newRevisionId(now()), parents: [R], kind: "restore", time: now(), author: author(), summary: SUMMARY.broughtBack,
          parts: { refs, texts: {}, contentHash: data.rev.content_hash },
        }),
        restored_from: id,
      };
      const manifest = await retain(withRevision(baseM, rev, author(), data.content.doc.template), [id, R]);
      const need: Record<string, string> = {};
      for (const n of SECTION_NAMES) { const k = refs[n].part; if (typeof data.parts[k] === "string") need[k] = data.parts[k]; }
      const newParts = partsNotIn(need, r.ok ? r.file : null);
      const serial = isLoaded(key) ? graph.getState().editSerial : 0;
      patchTab(key, { saving: true });
      let res: SaveResult;
      try {
        res = await backend.save({ path: t1.path!, expectedHead: R, analysisId: t1.analysisId!, docKey: key, manifest, newParts });
      } finally { patchTab(key, { saving: false }); }
      if (res.kind === "conflict") {
        toast({ tone: "error", kind: "error", message: "The file was changed on another computer. Try again." });
        void onHead(key, res.head);
        return { ok: false, reason: "failed" };
      }
      if (!res.ok) {
        if (res.kind === "error") addBanner(key, { kind: "saveFailed", message: saveFailedMessage(res.code) });
        else if (res.kind === "missing") addBanner(key, { kind: "missing", name: t1.title, folderLabel: t1.folderLabel, candidates: [] });
        return { ok: false, reason: "failed" };
      }
      if (res.kind === "savedAside") {
        it(key).asides = addUnique(it(key).asides, res.path);
        addBanner(key, { kind: "savedAside", name: fileStem(res.path), path: res.path });
        await saveSession();
        return { ok: false, reason: "failed" };
      }
      const c = roundTrip(data.content);
      if (isLoaded(key)) {
        const ok = replaceInPlace(key, { content: c, head: res.head, manifest, path: res.path, expectedBase: R, expectedSerial: serial });
        if (!ok) {
          // Typed meanwhile: kept as unsaved changes; the brought-back version is the newer one.
          addBanner(key, { kind: "newerOnDisk", version: vi(manifest, res.head), actions: ["combine", "later"] });
          it(key).bannerSource.set("newerOnDisk", { kind: "disk" });
        } else { await quietly(backend.deleteDraft(key), undefined); it(key).hasDraft = false; }
      } else {
        it(key).manifest = manifest;
        patchTab(key, { baseRevision: res.head, dirty: false });
        await quietly(backend.deleteDraft(key), undefined);
      }
      removeKinds(key, ["newerOnDisk", "saveFailed"]);
      releaseIfClean(key);
      toast({ tone: "success", kind: "broughtBack", version: vi(data.manifest, id) });
      await touchRecent(res.path, t1.analysisId);
      await saveSession();
      touchVersions(key);
      if (res.kind === "savedButDisplaced") {
        const D = res.displacedHead;
        if (!tabDirty(key)) void autoCombine(key, { kind: "journal", revisionId: D });
      }
      return { ok: true, path: res.path };
    } finally { setBusy(null); }
  }

  async function saveVersionAsNewImpl(id: string): Promise<OpenOutcome> {
    const key = get().versions?.tabKey ?? get().activeKey;
    const t = tabOf(key);
    if (!key || !t?.path || !t.analysisId) return { ok: false, reason: "failed" };
    const data = await versionData(id);
    if (!data) { toast({ tone: "error", kind: "error", message: "This version can no longer be opened." }); return { ok: false, reason: "failed" }; }
    const picked = await pickPath({
      mode: "save", title: "Save this version as a new analysis", suggestedName: `${safeFileName(`${t.title} (earlier version)`)}.lag`, startDir: parentDir(t.path),
    });
    if (!picked) return { ok: false, reason: "cancelled" };
    const path = withGraphExt(picked);
    if (tabByPath(path)) {
      toast({ tone: "error", kind: "error", message: "That file is open in another tab. Close it first or choose another name." });
      return { ok: false, reason: "failed" };
    }
    if (get().tabs.length >= LIMITS.tabCap) { toast({ tone: "warning", kind: "tabLimit" }); return { ok: false, reason: "limit" }; }
    const v = get().versions;
    if (v && v.tabKey === key) set({ versions: { ...v, busy: "saveAsNew" } });
    try {
      const file = await newFile({
        content: data.content, analysisId: newAnalysisId(), forkedFrom: { analysis_id: t.analysisId, revision_id: id }, time: now(), author: author(),
        summary: SUMMARY.first,
      });
      const res = await backend.save({
        path, expectedHead: null, replaceExisting: true, analysisId: file.manifest.analysis_id, docKey: newDocKey(), manifest: file.manifest, newParts: file.parts,
      });
      if (!res.ok) {
        toast({ tone: "error", kind: "error", message: res.kind === "error" ? saveFailedMessage(res.code) : saveFailedMessage("Io") });
        return { ok: false, reason: "failed" };
      }
      const i = it(key);
      i.knownCopies = addUnique(i.knownCopies, res.path);
      await saveSession();
      const out = await openImpl(res.path);
      if (out.ok) toast({ tone: "success", kind: "savedAsNew", name: fileStem(res.path) });
      return out;
    } finally {
      const v2 = get().versions;
      if (v2 && v2.tabKey === key) set({ versions: { ...v2, busy: null } });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 3: who is editing — notes, read-only, edit here (phase3-contract.md §5)
  // ═══════════════════════════════════════════════════════════════════════════

  let shareDefault: ShareMode = "auto";
  let presenceTimer: unknown = null;
  let lastTickAt = 0;
  /** The app is quitting (the preview's simulated quit): no note is written any more. */
  let closingNotes = false;
  /** Highest epoch used per path in this run (a reopened file never repeats an epoch). */
  const epochByPath = new Map<string, number>();
  /** Foreign notes a removal was asked for (one request per file and bytes). */
  const removing = new Set<string>();
  let renewing = false;
  let renewedOnce = false;
  /** evaluate() depth: a nested evaluation (a claim fired while setting a guard) makes the outer one stop. */
  let evalSeq = 0;

  const PRESENCE_KINDS: readonly BannerKind[] = [
    "resuming", "continuedElsewhere", "bothEditing", "waitingNewer", "editingElsewhere", "editingInfo", "unconfirmed", "olderPeer",
  ];
  const isPresenceKind = (k: BannerKind) => PRESENCE_KINDS.includes(k);
  const READ_ONLY_GUARDS: readonly EditGuardReason[] = ["editingElsewhere", "checking", "waiting"];
  const nativeWake = () => (deps.nativeWake === null ? desktop : deps.nativeWake);
  const pkey = (t: NoteTarget) => `${t.device_id}\u0000${t.epoch}`;
  const me = () => ({ deviceId: device?.device_id ?? "", userName: device?.user_name ?? "" });

  /** The notes of the last listing that are about this tab's document, from other computers, one per device. */
  function foreignRecords(key: string): NoteRecord[] {
    return pickPerDevice(it(key).pr.records.filter((r) => r.applies && !r.own));
  }
  const foreignNotes = (key: string): NoteJson[] => foreignRecords(key).map((r) => r.note);

  function knowsFn(key: string): (id: string) => boolean {
    const i = it(key);
    const ids = new Set<string>();
    for (const m of [i.manifest, i.pr.diskManifest]) for (const r of m?.revisions ?? []) ids.add(r.id);
    const base = tabOf(key)?.baseRevision;
    if (base) ids.add(base);
    // A version this computer has already seen (in this file or a copy, e.g. before the file was put back to an
    // earlier version) is not one "on its way": nothing to wait for.
    const aid = tabOf(key)?.analysisId;
    const seenIds = aid ? seen.analyses[aid] : undefined;
    return (id) => ids.has(id) || (!!seenIds && Object.prototype.hasOwnProperty.call(seenIds, id));
  }

  /** decide()'s diskHead: the tab's base when it is clean, else the newest head read from disk for the path. */
  function diskHeadOf(key: string): string | null {
    const t = tabOf(key);
    if (!t) return null;
    if (!tabDirty(key)) return t.baseRevision;
    return it(key).pr.diskHead ?? t.baseRevision;
  }

  function sharingOf(key: string): SharingView {
    const t = tabOf(key);
    const pr = it(key).pr;
    const d = shareDecision({
      choice: pr.share, fallback: shareDefault, untitled: !t?.path, cloud: !!pr.cloud?.cloud,
      multiDevice: multiDevice(it(key).manifest, device?.device_id ?? "", foreignNotes(key)),
    });
    return { choice: pr.share, fallback: shareDefault, on: d.on, why: d.why, service: pr.cloud?.service ?? serviceOf(t?.path ?? null) };
  }

  function decideFor(key: string): PresenceDecision {
    const pr = it(key).pr;
    const diskHead = diskHeadOf(key);
    return decide({
      me: me(), now: now(), diskHead, knows: knowsFn(key), dirty: editingNow(key), holding: pr.holding,
      myEpoch: pr.epoch, resuming: !!pr.resume, overrides: pr.overrides, notes: handoverView(key, diskHead), obs: pr.obs,
    });
  }

  /** fixer VP-3: the foreign notes as decide() sees them. Right after this tab took in a version saved by a
   *  computer that is editing, that computer's note still names the version before it (its rewritten note is on
   *  its way: the two files sync separately). For LIMITS_HANDOVER_MS after the version arrived, and only while
   *  that note has not changed since, it is read as based on the new version — so a clean observer stays
   *  read-only across the editor's save instead of turning editable for the seconds in between. */
  function handoverView(key: string, diskHead: string | null): NoteJson[] {
    const notes = foreignNotes(key);
    const pr = it(key).pr;
    const t0 = now();
    if (pr.headSeen.head !== diskHead) {
      const seqs: Record<string, number> = {};
      for (const n of notes) seqs[n.device_id] = n.seq;
      pr.headSeen = { head: diskHead, at: t0, seqs };
    }
    pr.handoverUntil = null;
    const m = it(key).manifest;
    const until = pr.headSeen.at + LIMITS_HANDOVER_MS;
    if (!diskHead || !m || editingNow(key) || pr.holding || t0 >= until) return notes;
    const r = revisionOf(m, diskHead);
    if (!r || !r.device_id) return notes;
    let used = false;
    const out = notes.map((n) => {
      if (n.state !== "editing" || n.base_revision === null || n.base_revision === diskHead || n.device_id !== r.device_id) return n;
      if (!Object.prototype.hasOwnProperty.call(pr.headSeen.seqs, n.device_id) || pr.headSeen.seqs[n.device_id] !== n.seq) return n;
      if (!isStrictAncestor(m, n.base_revision, diskHead)) return n;
      used = true;
      return { ...n, base_revision: diskHead };
    });
    if (used) pr.handoverUntil = until;
    return out;
  }

  /** The next epoch for a claim on this tab's file (never one used before for it on this computer). */
  function nextEpoch(key: string): number {
    const t = tabOf(key);
    const pr = it(key).pr;
    const memo = t?.path ? fileMemo.get(t.path)?.note_epoch ?? 0 : 0;
    const e = Math.max(pr.epoch, t?.path ? epochByPath.get(t.path) ?? 0 : 0, memo) + 1;
    pr.epoch = e;
    if (t?.path) epochByPath.set(t.path, e);
    return e;
  }

  /** A new listing of the notes beside the tab's file (open, an event, after a wake-up). */
  function takeRecords(key: string, records: NoteRecord[]): void {
    const t = tabOf(key);
    if (!t) return;
    const pr = it(key).pr;
    const before = pr.records;
    pr.records = records;
    pr.listed = true;
    const foreign = foreignNotes(key);
    if (foreign.length) pr.hadForeignNote = true;
    pr.obs = observe(pr.obs, foreign, now(), knowsFn(key));
    // A note of mine left from a crash: its epoch is continued, never repeated.
    const leftovers = records.filter((r) => r.own && r.applies);
    for (const r of leftovers) {
      if (r.note.epoch > pr.epoch && !pr.holding) pr.epoch = r.note.epoch;
      if (t.path) epochByPath.set(t.path, Math.max(epochByPath.get(t.path) ?? 0, r.note.epoch));
    }
    if (leftovers.length) pr.leftover = true;
    // Another computer's note unchanged for 24 h (or about a document that is gone) is removed (§3.7).
    let n = 0;
    for (const target of cleanupTargets(records, now())) {
      const k = `${target.file}\u0000${target.sha}`;
      if (removing.has(k) || n >= 5) continue;
      removing.add(k);
      n++;
      void quietly(backend.presenceRemoveForeign(target), false);
    }
    // A second running app with my identity (§5.4, S18).
    if (device && duplicateIdentity(before, records, { deviceId: device.device_id, sessionId: device.session_id })) void renewIdentity();
  }

  async function renewIdentity(): Promise<void> {
    // At most once per launch (fixer VS-5): two copies of the app on one state folder would otherwise hand the
    // identity back and forth.
    if (renewing || renewedOnce) return;
    renewing = true;
    renewedOnce = true;
    try {
      const d = await quietly(backend.newDeviceId(), null);
      if (!d) return;
      device = { ...d };
      toast({ tone: "info", kind: "deviceIdChanged" });
      for (const t of get().tabs) { const pr = it(t.key).pr; pr.written = null; evaluate(t.key); }
    } finally { renewing = false; }
  }

  /** Open / back / wake: where the file is (cloud), the notes beside it, my epoch. Opening waits for this at most
   *  LIMITS_OPEN_NOTES_MS (a stalled or offline folder never holds the document back, fixer VS-4); a later
   *  answer is taken in and the tab evaluated then. */
  async function presenceOpen(key: string, path: string, analysisId: string): Promise<void> {
    const pr = it(key).pr;
    pr.listedPath = path;
    let late = false;
    const work = (async () => {
      const cloud = await quietly(backend.cloudInfo(path), { cloud: false, service: null, root: null } as CloudInfo);
      if (tabOf(key)?.path !== path) return;
      pr.cloud = cloud;
      const r = await quietly(backend.presenceList(path, analysisId), null);
      if (tabOf(key)?.path !== path) return;
      if (r && r.ok) takeRecords(key, r.notes);
      if (late) evaluate(key);
    })();
    let timer: unknown = null;
    const cap = new Promise<void>((resolve) => { timer = deps.timers.setTimeout(() => { late = true; resolve(); }, LIMITS_OPEN_NOTES_MS); });
    await Promise.race([work, cap]);
    if (!late && timer) deps.timers.clearTimeout(timer);
  }

  // ── my note (§5.3) ──

  function noteWanted(key: string): WrittenNote | null {
    const t = tabOf(key);
    if (!t?.path || !t.analysisId || closingNotes || isCard(t.status) || t.status === "opening" || it(key).pr.gone) return null;
    if (!sharingOf(key).on) return null;
    const pr = it(key).pr;
    const editing = pr.holding;
    const live = new Set(foreignNotes(key).map((n) => pkey({ device_id: n.device_id, epoch: n.epoch })));
    const sup = editing ? pr.supersedes.filter((x) => live.has(pkey(x))).slice(0, 32) : [];
    return {
      path: t.path, analysisId: t.analysisId, state: editing ? "editing" : "idle", head: t.baseRevision, base: editing ? t.baseRevision : null,
      epoch: pr.epoch, supersedes: sup, names: `${device?.device_name ?? ""}\u0000${device?.user_name ?? ""}\u0000${device?.device_id ?? ""}`, off: false,
    };
  }

  const sameNote = (a: WrittenNote, b: WrittenNote) =>
    a.path === b.path && a.analysisId === b.analysisId && a.state === b.state && a.head === b.head && a.base === b.base && a.epoch === b.epoch
    && a.names === b.names && JSON.stringify(a.supersedes) === JSON.stringify(b.supersedes);

  /** Bring my note in line with the facts: written only when something differs (never on a timer; the
   *  backend keeps it beating). Fire and forget: no person's action waits for it. */
  function sync(key: string, opts: { input?: boolean; force?: boolean } = {}): void {
    const t = tabOf(key);
    if (!t) return;
    const pr = it(key).pr;
    const want = noteWanted(key);
    if (!want) {
      const old = pr.written?.path ?? (pr.leftover ? t.path : null);
      pr.written = null;
      pr.leftover = false;
      if (old && !closingNotes) void quietly(backend.presenceClear(old), undefined);
      return;
    }
    if (!opts.force && pr.written && sameNote(want, pr.written)) return;
    const old = pr.written;
    pr.written = want;
    pr.leftover = false;
    const seq = ++pr.writeSeq;
    if (opts.input) pr.lastPingAt = now();
    void backend.presenceSet({
      docPath: want.path, analysisId: want.analysisId, state: want.state, head: want.head, baseRevision: want.base, epoch: want.epoch,
      supersedes: want.supersedes, input: !!opts.input,
    }).then((r) => {
      // The note at the old path goes, always (fixer VS-2): after Save As "the same analysis" under a new name both
      // files exist and nothing else removes it. presence_clear never takes a note registered for another
      // document path, so the new note (which may apply to the old path by the sole-id rule) stays.
      if (old && old.path !== want.path) void quietly(backend.presenceClear(old.path), undefined);
      if (pr.writeSeq !== seq) return;
      if (!r.ok) { pr.written = null; return; }           // tried again at the next sync, never shown
      if (r.kind === "off") pr.written = { ...want, off: true };
      if (tabOf(key)) refreshPresence(key);
    }, () => { if (pr.writeSeq === seq) pr.written = null; });
    if (t.path) rememberEpoch(t.path, want.epoch);
  }

  function rememberEpoch(path: string, epoch: number): void {
    epochByPath.set(path, Math.max(epochByPath.get(path) ?? 0, epoch));
  }

  /** "There was input": the linger restarts; Rust hears about it at most every inputPingMs. */
  function noteInput(key: string): void {
    const t = tabOf(key);
    const pr = it(key).pr;
    pr.lastInputAt = now();
    pr.editHereHold = false;
    if (pr.holding) restartLinger(key);
    if (t?.path && pr.holding && pr.written && !pr.written.off && now() - pr.lastPingAt >= LIMITS_P3.inputPingMs) {
      pr.lastPingAt = now();
      backend.presenceInput(t.path);
    }
  }

  /** The person changed something on a tab that was not editing: this computer starts editing (§5.3 Claim). */
  function claim(key: string, opts: { input: boolean; supersedes?: NoteTarget[]; editHere?: boolean }): void {
    const pr = it(key).pr;
    const d = pr.decision ?? decideFor(key);
    const notes = foreignNotes(key);
    pr.editHereHold = !!opts.editHere;
    pr.claimSeen = new Set([...notes.filter((n) => n.state === "editing").map(pkey), ...pr.overrides.map(pkey), ...(opts.supersedes ?? []).map(pkey)]);
    const quietMine = d.peers.filter((p) => p.state === "editing" && p.freshness === "quiet" && p.basedOn === "myVersion")
      .map((p) => notes.find((n) => n.device_id === p.deviceId))
      .filter((n): n is NoteJson => !!n).map((n) => ({ device_id: n.device_id, epoch: n.epoch }));
    const sup = new Map<string, NoteTarget>();
    for (const x of [...pr.overrides, ...(opts.supersedes ?? []), ...quietMine]) sup.set(pkey(x), x);
    pr.holding = true;
    pr.resume = null;
    clearResumeTimer(key);
    nextEpoch(key);
    pr.supersedes = [...sup.values()];
    pr.lastInputAt = now();
    restartLinger(key);
    evaluate(key, { input: opts.input });
  }

  /** The note returns to idle (D6), or the hold simply ends. */
  function release(key: string): void {
    const pr = it(key).pr;
    if (!pr.holding) return;
    pr.holding = false;
    pr.supersedes = [];
    // fixer VP-2: "Edit here" lasts as long as this computer is editing. Once it stops, the other computer's
    // ongoing claim makes this clean tab read-only again (until that computer saves and stops).
    pr.overrides = [];
    pr.editHereHold = false;
    pr.claimSeen = new Set();
    pr.resume = null;
    clearResumeTimer(key);
    clearLinger(key);
    evaluate(key);
  }

  /** Release at once (D6 b, c) when the tab is clean. */
  function releaseIfClean(key: string): void {
    if (tabOf(key) && it(key).pr.holding && !editingNow(key)) release(key);
  }

  function clearLinger(key: string): void {
    const pr = it(key).pr;
    if (pr.lingerTimer) { deps.timers.clearTimeout(pr.lingerTimer); pr.lingerTimer = null; }
  }

  function restartLinger(key: string): void {
    const pr = it(key).pr;
    if (!pr.holding) { clearLinger(key); return; }
    // fixer round 2 (RV-4): an Edit here hold without an edit or a save is not ended by the 30 s rule.
    if (pr.editHereHold) { clearLinger(key); return; }
    // A running timer that fires no later than the new end is kept: lingerCheck looks again at the real end.
    if (pr.lingerTimer) return;
    const since = Math.max(pr.lastSaveAt, pr.lastInputAt);
    const left = Math.max(0, since + LIMITS_P3.lingerMs - now());
    pr.lingerTimer = deps.timers.setTimeout(() => { pr.lingerTimer = null; lingerCheck(key); }, left);
  }

  function lingerCheck(key: string): void {
    if (!tabOf(key)) return;
    const pr = it(key).pr;
    // Unsaved changes (or typing in progress) never release: the note goes quiet by itself.
    if (!pr.holding || editingNow(key) || pr.editHereHold) return;
    const since = Math.max(pr.lastSaveAt, pr.lastInputAt);
    if (now() - since < LIMITS_P3.lingerMs) { restartLinger(key); return; }
    release(key);
  }

  // ── the guard (§5.4 step 3) ──

  /** Bring the store's guard in line. false: a claim happened meanwhile (the tab was re-evaluated). */
  function applyGuard(key: string, wanted: EditGuardReason | null, mySeq: number): boolean {
    const pr = it(key).pr;
    if (pr.guardRetry) { deps.timers.clearTimeout(pr.guardRetry); pr.guardRetry = null; }
    if (!isLoaded(key)) { pr.guard = wanted; return true; }
    const s = graph.getState();
    const cur = s.guard?.reason ?? null;
    if (cur === wanted) { pr.guard = wanted; return true; }
    if (wanted === null) {
      graph.getState().setGuard(null);
      pr.guard = null;
      onGuardCleared(key);
      return true;
    }
    if (wanted === "tooNew" || wanted === "resuming" || (cur !== null && READ_ONLY_GUARDS.includes(cur))) {
      // Pending Scratchpad changes are written first (fixer VS-6). An open cell entry is no longer committed
      // (fixer V-2): a typed editor stays open and editable under the guard (Enter commits it once the guard is
      // gone), and leaving the Scratchpad tab parks it rather than lose it; a pristine one holds nothing.
      if (wanted === "resuming" && cur === null) {
        deps.flushScratch({ commitEdit: false });
        if (mySeq !== evalSeq) return false;
      }
      graph.getState().setGuard({ reason: wanted });
      pr.guard = wanted;
      return true;
    }
    // Becoming read-only: never in the middle of a typed value, never with unsaved changes.
    // Phase 3 fix: typing still in an editor counts like unsaved changes (it claimed at its first keystroke), so
    // the open entry is left alone (fixer V-3: never committed, or closed, by a check nobody asked for); pending
    // Scratchpad changes are written.
    const serial0 = s.userEditSerial;
    deps.flushScratch({ commitEdit: false });
    if (mySeq !== evalSeq) return false;
    const s1 = graph.getState();
    if (s1.userEditSerial !== serial0 || isDirty(s1) || s1.typing.length > 0) { if (mySeq === evalSeq) evaluate(key); return false; }
    if (quietBool(() => deps.interactionBusy())) {
      pr.guardRetry = deps.timers.setTimeout(() => { pr.guardRetry = null; if (tabOf(key)) evaluate(key); }, LIMITS_P3.applyHoldRetryMs);
      return true;
    }
    graph.getState().setGuard({ reason: wanted });
    pr.guard = wanted;
    return true;
  }

  /** The guard went: an automatic combine that waited is looked at again. */
  function onGuardCleared(key: string): void {
    const i = it(key);
    const w = i.pr.autoWaiting;
    if (!w) return;
    i.pr.autoWaiting = null;
    void Promise.resolve().then(() => { if (tabOf(key)) void autoRecheck(key, w.ctx, w.expected); });
  }

  /** The guard of a tab (the store's for the loaded tab, the wanted one for a background tab). */
  const guardOf = (key: string): EditGuardReason | null => (isLoaded(key) ? graph.getState().guard?.reason ?? null : it(key).pr.guard);
  const readOnlyNow = (key: string) => { const g = guardOf(key); return !!g && READ_ONLY_GUARDS.includes(g); };

  /** A writer refused while the tab is read-only (§5.5): the attempt is counted. */
  function presenceBlocks(key: string, action: string): boolean {
    if (!tabOf(key) || !readOnlyNow(key)) return false;
    reportAttempt(key, "command", action);
    return true;
  }

  function reportAttempt(key: string, path: EditPath, action: string): void {
    if (isLoaded(key)) { graph.getState().noteBlockedEdit(path, action); return; }
    const pr = it(key).pr;
    pr.attempt++;
    refreshPresence(key);
  }

  // ── evaluating a tab (§5.4) ──

  function peerTarget(key: string, deviceId: string): NoteTarget | null {
    const n = foreignNotes(key).find((x) => x.device_id === deviceId);
    return n ? { device_id: n.device_id, epoch: n.epoch } : null;
  }

  function evaluate(key: string, opts: { input?: boolean } = {}): void {
    const t = tabOf(key);
    if (!t) return;
    const mySeq = ++evalSeq;
    const i = it(key);
    const pr = i.pr;
    if (!t.path || !t.analysisId || isCard(t.status) || t.status === "opening") {
      if (t.path === null && t.presence) patchTab(key, { presence: undefined });
      if (isCard(t.status)) sync(key);
      return;
    }
    if (pr.listedPath !== t.path) {
      // A new path (Save As, a separate copy, Find it…): where it is and the notes beside it, then again.
      const path = t.path, aid = t.analysisId;
      if (pr.listedPath !== null && parentDir(pr.listedPath) !== parentDir(path)) { pr.cloud = null; pr.records = []; pr.obs = emptyObs(); }
      void presenceOpen(key, path, aid).then(() => { if (tabOf(key)?.path === path) evaluate(key); });
    }
    let d = decideFor(key);
    if (d.yieldedTo) {
      // Another computer took over my claim ("Edit here" there).
      if (pr.resume) { pr.resume = null; clearResumeTimer(key); pr.forceSync = true; d = decideFor(key); }
      if (d.yieldedTo && !editingNow(key) && pr.holding) {
        pr.holding = false;
        pr.supersedes = [];
        pr.overrides = [];
        pr.editHereHold = false;
        pr.claimSeen = new Set();
        clearLinger(key);
        d = decideFor(key);
      }
    }
    if (pr.holding && !pr.resume && !editingNow(key) && newerClaim(key, d)) {
      // fixer round 2 (RV-4): another computer started editing this version after my claim (it did not see my note
      // yet, or it claimed again): a clean tab's hold ends, as when that computer presses Edit here.
      pr.holding = false;
      pr.supersedes = [];
      pr.overrides = [];
      pr.editHereHold = false;
      pr.claimSeen = new Set();
      clearLinger(key);
      d = decideFor(key);
    }
    pr.decision = d;
    const wanted: EditGuardReason | null = t.readOnly === "tooNew" ? "tooNew"
      : d.mode === "readOnly" ? (d.checking ? "checking" : "editingElsewhere")
        : d.mode === "waiting" ? "waiting" : d.mode === "resuming" ? "resuming" : null;
    if (!applyGuard(key, wanted, mySeq)) return;
    if (mySeq !== evalSeq) return;
    syncBanners(key, d);
    const force = pr.forceSync;
    pr.forceSync = false;
    sync(key, { input: opts.input, force });
    refreshPresence(key);
    if (d.mode === "waiting") backend.pollNow();
    // The next moment the answer can change by itself (one timer, moved only when that moment moves).
    const nextAt = pr.handoverUntil !== null && (d.nextCheckAt === null || pr.handoverUntil < d.nextCheckAt) ? pr.handoverUntil : d.nextCheckAt;
    if (nextAt !== pr.checkAt || !pr.checkTimer) {
      if (pr.checkTimer) { deps.timers.clearTimeout(pr.checkTimer); pr.checkTimer = null; }
      pr.checkAt = nextAt;
      if (nextAt !== null) {
        const ms = Math.max(0, nextAt - now()) + 1;
        pr.checkTimer = deps.timers.setTimeout(() => { pr.checkTimer = null; pr.checkAt = null; if (tabOf(key)) evaluate(key); }, ms);
      }
    }
    if (pr.holding && !editingNow(key) && !pr.lingerTimer) restartLinger(key);
  }

  /** fixer round 2 (RV-4): a live editing claim on this tab's version that was not known when my hold began. */
  function newerClaim(key: string, d: PresenceDecision): boolean {
    const pr = it(key).pr;
    const notes = foreignNotes(key);
    return d.peers.some((p) => {
      if (p.state !== "editing" || p.freshness === "quiet" || p.freshness === "checking" || p.basedOn !== "myVersion") return false;
      const n = notes.find((x) => x.device_id === p.deviceId);
      return !!n && !pr.claimSeen.has(pkey(n));
    });
  }

  /** fixer round 2 (RV-2): the tab's file is at another path now — Find it…, a rename followed (same-folder search or
   *  the poll's move by identity), a save that followed the file, Save As (the same or a new analysis), a combine
   *  into the other copy. The one place the note follows the file: the "gone" mark of the old path no longer
   *  applies, unsaved changes hold the document as on Open (§5.3), and evaluate lists the notes beside the new
   *  path, writes my note there and removes the one at the old path (sync). */
  function presenceRepath(key: string, from: string | null, to: string): void {
    if (from === to || !tabOf(key)) return;
    const pr = it(key).pr;
    pr.gone = false;
    if (tabOf(key)?.analysisId && tabDirty(key) && !pr.holding) claim(key, { input: false });
    else evaluate(key);
  }

  /** Who the status line names for version `id`: its author when that is another computer; for an automatic
   *  combine (it has no author) the newest person's version it combined — none when one of those is mine (my save
   *  combined it: "All changes saved"). null: nothing to say (fixer F2). */
  function statusWho(m: Manifest, id: string): VersionInfo | null {
    const visited = new Set<string>();
    const stack = [id];
    let best: VersionInfo | null = null;
    while (stack.length && visited.size < 64) {
      const x = stack.pop()!;
      if (visited.has(x)) continue;
      visited.add(x);
      const r = revisionOf(m, x);
      if (!r) continue;
      if (r.device_id) {
        const v = vi(m, x);
        if (v.mine) return null;
        if (!best || v.time > best.time) best = v;
        continue;
      }
      stack.push(...r.parents);
    }
    return best;
  }

  /** tab.presence from the last decision (left as it is when nothing changed). */
  function refreshPresence(key: string): void {
    const t = tabOf(key);
    if (!t?.path) return;
    const i = it(key);
    const pr = i.pr;
    const d = pr.decision;
    const guard = guardOf(key);
    let status: StatusLine | null = null;
    if (!tabDirty(key) && i.manifest && t.baseRevision && revisionOf(i.manifest, t.baseRevision)) {
      const who = statusWho(i.manifest, t.baseRevision);
      if (who) status = { kind: "upToDate", who, seenAt: seen.analyses[i.manifest.analysis_id]?.[t.baseRevision] ?? null };
    }
    const presence: TabPresence = {
      mode: d?.mode ?? "editable", readOnly: !!guard && READ_ONLY_GUARDS.includes(guard), guard,
      peers: d?.peers ?? [], mine: pr.written && !pr.written.off ? pr.written.state : "none", sharing: sharingOf(key), status, attempt: pr.attempt,
    };
    if (JSON.stringify(presence) === JSON.stringify(t.presence ?? null)) return;
    patchTab(key, { presence });
    const dlg = get().dialog;
    if (dlg?.kind === "sharing" && dlg.tabKey === key && JSON.stringify(dlg.sharing) !== JSON.stringify(presence.sharing)) {
      set({ dialog: { ...dlg, sharing: presence.sharing } });
    }
  }

  function syncBanners(key: string, d: PresenceDecision): void {
    const t = tabOf(key)!;
    const i = it(key);
    const pr = i.pr;
    const byId = new Map(d.peers.map((p) => [p.deviceId, p] as const));
    const about = d.about.map((id) => byId.get(id)).filter((p): p is PeerView => !!p);
    const closed = (peers: PeerView[]) => peers.length > 0 && peers.every((p) => { const x = peerTarget(key, p.deviceId); return !!x && pr.dismissed.has(pkey(x)); });
    const out: TabBanner[] = [];
    const mk = (kind: BannerKind, actions: BannerAction[], dismissible: boolean, more: Partial<TabBanner> = {}): TabBanner =>
      ({ id: kind, kind, actions, dismissible, ...more });
    switch (d.mode) {
      case "readOnly":
        if (d.checking) out.push(mk("editingElsewhere", [], false, { peers: about, checking: true }));
        else out.push(mk("editingElsewhere", [about.every((p) => p.sameUser) ? "editHere" : "editAnyway"], false, { peers: about }));
        break;
      case "waiting": {
        const p = d.waiting ? byId.get(d.waiting.deviceId) : undefined;
        out.push(mk("waitingNewer", [], false, { peers: p ? [p] : about }));
        break;
      }
      case "info": {
        if (closed(about)) break;
        const quietMine = about.some((p) => p.state === "editing" && p.freshness === "quiet" && p.basedOn === "myVersion");
        out.push(mk("editingInfo", quietMine ? ["editHere", "dismiss"] : ["dismiss"], true, { peers: about }));
        break;
      }
      case "bothEditing":
        if (d.yieldedTo) {
          const p = byId.get(d.yieldedTo);
          if (!closed(p ? [p] : [])) out.push(mk("continuedElsewhere", ["keepEditing", "saveCopy"], false, { peers: p ? [p] : [] }));
        } else if (!closed(about)) out.push(mk("bothEditing", ["keepEditing", "saveCopy"], false, { peers: about }));
        break;
      case "resuming":
        out.push(mk("resuming", ["keepEditing"], false, { peers: about }));
        break;
      case "editable":
        break;
    }
    if (d.unconfirmed && d.mode !== "waiting" && pr.unconfirmedClosed !== (t.baseRevision ?? "")) out.push(mk("unconfirmed", [], true));
    const m = i.manifest;
    const op = m ? olderPeer(m, device?.device_id ?? "", foreignNotes(key)) : null;
    if (op && m && pr.olderPeerClosed !== m.head) {
      const user = op.userName.trim();
      out.push(mk("olderPeer", ["dismiss"], true, {
        peers: [{
          deviceId: op.deviceId, deviceName: op.deviceName, userName: op.userName, sameUser: user !== "" && user === me().userName.trim(),
          state: "idle", freshness: "quiet", basedOn: null, updatedAt: "", editingSince: null, changedAt: 0, superseded: false, supersedesMe: false,
        }],
      }));
    }
    const cur = t.banners.filter((b) => isPresenceKind(b.kind));
    const same = cur.length === out.length && out.every((b) => JSON.stringify(cur.find((c) => c.id === b.id) ?? null) === JSON.stringify(b));
    if (same) return;
    patchTab(key, { banners: [...t.banners.filter((b) => !isPresenceKind(b.kind)), ...out] });
  }

  /** × or OK on a presence banner: it stays away (until another peer / epoch, the base or the head changes). */
  function dismissPresence(key: string, b: TabBanner): void {
    const t = tabOf(key);
    if (!t) return;
    const pr = it(key).pr;
    if (b.kind === "unconfirmed") pr.unconfirmedClosed = t.baseRevision ?? "";
    else if (b.kind === "olderPeer") pr.olderPeerClosed = it(key).manifest?.head ?? null;
    else for (const p of b.peers ?? []) { const x = peerTarget(key, p.deviceId); if (x) pr.dismissed.add(pkey(x)); }
    removeBanners(key, (x) => x.id === b.id);
    evaluate(key);
  }

  // ── Edit here, both editing (§5.5) ──

  async function editHereImpl(key: string, confirmed?: boolean): Promise<boolean> {
    const t = tabOf(key);
    if (!t?.path) return false;
    const pr = it(key).pr;
    let d = decideFor(key);
    if (d.mode === "readOnly" && !d.checking) {
      const byId = new Map(d.peers.map((p) => [p.deviceId, p] as const));
      const about = d.about.map((id) => byId.get(id)).filter((p): p is PeerView => !!p);
      if (about.some((p) => !p.sameUser) && confirmed !== true) {
        const a = await ask({ kind: "editAnyway", tabKey: key, title: t.title, peers: about });
        if (get().dialog?.kind === "editAnyway") set({ dialog: null });
        if (a.kind !== "editAnyway" || a.choice !== "edit") return false;
        if (!tabOf(key)) return false;
        const d2 = decideFor(key);
        if (d2.mode !== "readOnly") return d2.mode !== "waiting";
        d = d2;
      }
      // One synchronous step: nothing waits for the other computer or the disk (D10).
      for (const b of d.blockers) { if (!pr.overrides.some((x) => pkey(x) === pkey(b))) pr.overrides = [...pr.overrides, b]; pr.dismissed.add(pkey(b)); }
      if (isLoaded(key)) graph.getState().setGuard(null);
      pr.guard = null;
      claim(key, { input: true, supersedes: d.blockers, editHere: true });
      return true;
    }
    if (d.mode === "info") {
      const notes = foreignNotes(key);
      const quiet = d.peers.filter((p) => p.state === "editing" && p.freshness === "quiet" && p.basedOn === "myVersion")
        .map((p) => notes.find((n) => n.device_id === p.deviceId)).filter((n): n is NoteJson => !!n)
        .map((n) => ({ device_id: n.device_id, epoch: n.epoch }));
      if (!quiet.length) return false;
      for (const b of quiet) { if (!pr.overrides.some((x) => pkey(x) === pkey(b))) pr.overrides = [...pr.overrides, b]; pr.dismissed.add(pkey(b)); }
      claim(key, { input: true, supersedes: quiet, editHere: true });
      return true;
    }
    return false;
  }

  function keepEditingImpl(key: string): void {
    const t = tabOf(key);
    if (!t) return;
    const pr = it(key).pr;
    if (pr.resume) { endResume(key, "go"); return; }
    for (const b of t.banners) {
      if (b.kind !== "bothEditing" && b.kind !== "continuedElsewhere") continue;
      for (const p of b.peers ?? []) { const x = peerTarget(key, p.deviceId); if (x) pr.dismissed.add(pkey(x)); }
    }
    removeBanners(key, (b) => b.kind === "bothEditing" || b.kind === "continuedElsewhere");
    evaluate(key);
  }

  /** "Save my changes as a separate copy…" (the phase 1 separate-copy path): this file is left as it is. */
  async function saveAsSeparateCopyImpl(key: string): Promise<SaveOutcome> {
    const t = tabOf(key);
    if (!t?.path || !t.analysisId) return { ok: false, reason: "nothing" };
    if (get().activeKey !== key) await switchTabImpl(key);
    if (!isLoaded(key)) return { ok: false, reason: "nothing" };
    deps.flushScratch({ commitEdit: true });
    const picked = await pickPath({ mode: "save", title: "Save my changes as a separate copy", suggestedName: `${safeFileName(`${t.title} (my copy)`)}.lag`, startDir: parentDir(t.path) });
    if (!picked) return { ok: false, reason: "cancelled" };
    const path = withGraphExt(picked);
    const other = tabByPath(path);
    if (path === t.path || (other && other.key !== key)) {
      addBanner(key, { kind: "saveFailed", message: "That file is open in another tab. Choose another name." });
      return { ok: false, reason: "failed" };
    }
    const c = content();
    const serial = graph.getState().editSerial;
    const aid = newAnalysisId();
    const forked = t.baseRevision ? { analysis_id: t.analysisId, revision_id: t.baseRevision } : null;
    const file = await newFile({ content: c, analysisId: aid, forkedFrom: forked, time: now(), author: author(), summary: SUMMARY.first });
    const res = await backend.save({ path, expectedHead: null, replaceExisting: true, analysisId: aid, docKey: key, manifest: file.manifest, newParts: file.parts });
    if (!res.ok) {
      addBanner(key, { kind: "saveFailed", message: res.kind === "error" ? saveFailedMessage(res.code) : saveFailedMessage("Io") });
      return { ok: false, reason: "failed" };
    }
    const i = it(key);
    if (t.baseRevision && !i.settled.includes(t.baseRevision)) i.settled = [...i.settled, t.baseRevision];
    rememberTab(key);
    i.lastSource = null;
    await moveTabToNewFile(key, res.path, res.head, file.manifest, c, serial, true);
    return { ok: true, path: res.path };
  }

  // ── sleep and wake (§5.6) ──

  function clearResumeTimer(key: string): void {
    const pr = it(key).pr;
    if (pr.resumeTimer) { deps.timers.clearTimeout(pr.resumeTimer); pr.resumeTimer = null; }
  }

  /** The after-sleep window ends: "yield" (another computer took over: my note stays as it is and beats again),
   *  else a re-claim with a new epoch. */
  function endResume(key: string, why: "yield" | "go" | "newer" | "timeout"): void {
    const pr = it(key).pr;
    if (!pr.resume) return;
    pr.resume = null;
    clearResumeTimer(key);
    if (why === "yield") { pr.forceSync = true; evaluate(key); return; }
    pr.holding = true;
    pr.editHereHold = false;
    pr.claimSeen = new Set([...foreignNotes(key).filter((n) => n.state === "editing").map(pkey), ...pr.overrides.map(pkey)]);
    nextEpoch(key);
    pr.supersedes = [];
    pr.forceSync = true;
    evaluate(key);
  }

  function onGap(): void {
    const t0 = now();
    for (const t of get().tabs) {
      if (!t.path || !t.analysisId) continue;
      const pr = it(t.key).pr;
      pr.obs = markGap(pr.obs, t0);
      if (pr.holding) {
        if (!editingNow(t.key)) { pr.holding = false; pr.supersedes = []; pr.overrides = []; clearLinger(t.key); }
        else {
          pr.resume = { since: t0 };
          clearResumeTimer(t.key);
          const key = t.key;
          pr.resumeTimer = deps.timers.setTimeout(() => { pr.resumeTimer = null; if (tabOf(key)) endResume(key, "timeout"); }, LIMITS_P3.resumeMs);
        }
      }
      evaluate(t.key);
    }
    backend.pollNow();
    for (const t of get().tabs) {
      if (!t.path || !t.analysisId || isCard(t.status)) continue;
      const key = t.key;
      const path = t.path;
      void quietly(backend.presenceList(path, t.analysisId), null).then((r) => {
        if (!r || !r.ok || tabOf(key)?.path !== path) return;
        takeRecords(key, r.notes);
        evaluate(key);
      });
    }
  }

  async function resumeAsk(key: string, what: "save" | "edit"): Promise<boolean> {
    const t = tabOf(key);
    if (!t || !it(key).pr.resume) return true;
    if (get().dialog?.kind === "resumeConfirm") return false;
    const a = await ask({ kind: "resumeConfirm", tabKey: key, title: t.title, what });
    if (get().dialog?.kind === "resumeConfirm") set({ dialog: null });
    if (a.kind !== "resumeConfirm" || a.choice !== "go") return false;
    endResume(key, "go");
    return true;
  }

  // ── the presence timer ──

  function presenceTick(): void {
    presenceTimer = deps.timers.setTimeout(presenceTick, LIMITS_P3.tickMs);
    const t = now();
    const prev = lastTickAt;
    lastTickAt = t;
    if (!nativeWake() && prev && gapDetected(prev, t, LIMITS_P3.tickMs)) { onGap(); return; }
    // Input in the window (keys, clicks) while the active tab is editing WITH unsaved changes and the graphs are
    // shown: it keeps the note up to date. A clean tab's 30 s after Save are counted from real edits only, so
    // clicks elsewhere (results, exports, another tool) never keep other computers read-only (fixer VS-1, D6).
    const key = get().activeKey;
    if (key && tabOf(key)) {
      const pr = it(key).pr;
      const act = quietNum(() => deps.lastActivity());
      if (act > pr.lastActivitySeen) {
        pr.lastActivitySeen = act;
        if (pr.holding && editingNow(key) && quietBool(() => deps.graphsVisible())) noteInput(key);
      }
    }
    for (const tab of get().tabs) {
      const pr = internal.get(tab.key)?.pr;
      if (pr?.decision?.mode === "waiting") { backend.pollNow(); break; }
    }
  }
  function quietNum(f: () => number): number { try { const v = f(); return Number.isFinite(v) ? v : Number.NEGATIVE_INFINITY; } catch { return Number.NEGATIVE_INFINITY; } }

  function startPresence(): void {
    if (presenceTimer) return;
    lastTickAt = now();
    presenceTimer = deps.timers.setTimeout(presenceTick, LIMITS_P3.tickMs);
  }

  // ── events ──

  function onPresenceEvent(path: string, notes: NoteRecord[]): void {
    const t = tabByPath(path);
    if (!t) return;
    takeRecords(t.key, notes);
    evaluate(t.key);
  }

  function onWakeEvent(): void {
    if (!nativeWake()) return;
    onGap();
  }

  // ── "Show others when I'm editing" (§5.9) ──

  function openSharingImpl(key?: string): void {
    const k = key ?? get().activeKey;
    const t = tabOf(k);
    if (!k || !t?.path) return;
    set({ dialog: { kind: "sharing", tabKey: k, title: t.title, sharing: sharingOf(k) } });
  }

  async function setSharingImpl(key: string, choice: ShareMode | null): Promise<void> {
    const t = tabOf(key);
    if (!t?.path) return;
    it(key).pr.share = choice;
    evaluate(key);
    await saveSession();
  }

  async function setSharingDefaultImpl(mode: ShareMode): Promise<void> {
    shareDefault = mode;
    const s = get().settings;
    if (s) set({ settings: { ...s, shareDefault: mode } });
    for (const t of get().tabs) evaluate(t.key);
    await saveSession();
  }

  /** The notes this computer knows of for an analysis (own and foreign), for retention (§5.8). */
  function noteHeadsFor(analysisId: string): string[] {
    const notes: NoteJson[] = [];
    for (const t of get().tabs) {
      if (t.analysisId !== analysisId) continue;
      for (const r of it(t.key).pr.records) if (r.applies) notes.push(r.note);
    }
    return liveNoteHeads(notes);
  }

  /** The file is missing or another analysis is at the path: my note goes (written again when it is back). */
  function presenceGone(key: string): void {
    const pr = it(key).pr;
    pr.gone = true;
    pr.holding = false;
    pr.supersedes = [];
    pr.overrides = [];
    clearLinger(key);
    sync(key);
    evaluate(key);
  }

  /** A tab is closed for good: its timers stop and its note is removed. */
  function disposePresence(key: string, path: string | null): void {
    const pr = internal.get(key)?.pr;
    if (!pr) return;
    for (const h of [pr.lingerTimer, pr.resumeTimer, pr.guardRetry, pr.checkTimer]) if (h) deps.timers.clearTimeout(h);
    pr.lingerTimer = pr.resumeTimer = pr.guardRetry = pr.checkTimer = null;
    pr.holding = false;
    pr.writeSeq++;
    const old = pr.written?.path ?? path;
    pr.written = null;
    if (old) rememberEpoch(old, pr.epoch);
    if (old && !closingNotes) void quietly(backend.presenceClear(old), undefined);
  }

  /** The preview's simulated quit: every note of this computer goes; none is written any more. */
  function clearAllNotes(): void {
    for (const t of get().tabs) {
      const pr = internal.get(t.key)?.pr;
      const p = pr?.written?.path ?? t.path;
      if (pr) { pr.written = null; pr.writeSeq++; }
      if (p) void quietly(backend.presenceClear(p), undefined);
    }
    closingNotes = true;
  }

  /** A change was refused on the loaded tab (§5.5): the banner's button pulses; after a sleep it asks. */
  function onBlocked(key: string): void {
    const pr = it(key).pr;
    pr.attempt++;
    refreshPresence(key);
    if (graph.getState().guard?.reason === "resuming") void resumeAsk(key, "edit");
  }

  async function presenceBannerAction(key: string, b: TabBanner, action: BannerAction): Promise<void> {
    switch (action) {
      case "editHere": {
        const allSame = (b.peers ?? []).every((p) => p.sameUser);
        await editHereImpl(key, allSame ? true : undefined);
        return;
      }
      case "editAnyway": await editHereImpl(key, false); return;
      case "keepEditing": keepEditingImpl(key); return;
      case "saveCopy": await saveAsSeparateCopyImpl(key); return;
      case "dismiss": case "later": dismissPresence(key, b); return;
      default: return;
    }
  }

  // ── banner actions ──

  async function bannerActionImpl(key: string, bannerId: string, action: BannerAction): Promise<void> {
    const t = tabOf(key);
    const b = t?.banners.find((x) => x.id === bannerId);
    if (!t || !b) return;
    const i = it(key);
    const drop = () => removeBanners(key, (x) => x.id === bannerId);
    if (isPresenceKind(b.kind) || action === "editHere" || action === "editAnyway" || action === "keepEditing" || action === "saveCopy") {
      await presenceBannerAction(key, b, action);
      return;
    }
    if ((b.kind === "extraCopy" || b.kind === "copyQuestion") && b.path && action !== "dismiss" && action !== "later") {
      // The copy may have been removed or combined on another computer since the banner appeared.
      const h = await quietly(backend.header(b.path), null);
      if (h && !h.ok && h.code === "NotFound") { forgetCopy(key, b.path); return; }
    }
    switch (action) {
      case "dismiss": case "later": drop(); return;
      case "openPrivacy": await openPrivacySettingsImpl(); return;
      case "retry":
        drop();
        if (b.kind === "saveFailed") { await saveImpl(key); return; }
        if (t.path) {
          const r = await readFile(t.path);
          if (r.ok) { removeKinds(key, ["permission", "downloading"]); await onHead(key, r.file.manifest.head); }
          else if (r.code === "PermissionDenied") addBanner(key, { kind: "permission" });
        }
        return;
      case "findIt": await findItImpl(key); return;
      case "saveAs": await saveAsImpl("ask"); return;
      case "chooseLocation": await saveAsImpl("ask"); return;
      case "choose": {
        if (!t.path) return;
        if (get().activeKey !== key) await switchTabImpl(key);
        // "Not saved" → Choose…: the combine that was left open comes back (the conflict sheet when combining isn't possible).
        if (i.lastSource && !i.conflict) { await startCombineImpl(key, i.lastSource, "save"); return; }
        const w = await workingOf(key);
        if (w) await enterConflict(key, w, "banner");
        return;
      }
      case "openCopy": case "openThatOne":
        if (b.path) await openImpl(b.path);
        return;
      case "useEarlier": await useEarlierImpl(key); return;
      case "backToLatest": await goBackToMyLatestImpl(key); return;
      case "combine": {
        const src = i.bannerSource.get(bannerId)
          ?? (b.kind === "extraCopy" && b.path ? { kind: "copy" as const, path: b.path } : { kind: "disk" as const });
        if (src.kind === "copy") {
          // Every diverged extra copy of this tab, one after another ("Copy 2 of 3").
          const copies = t.banners.filter((x) => x.kind === "extraCopy" && x.relation === "diverged" && x.path).map((x) => x.path!)
            .sort((p, q) => (fileStem(p) < fileStem(q) ? -1 : fileStem(p) > fileStem(q) ? 1 : p < q ? -1 : 1));
          const queue = copies.includes(src.path) ? copies : [src.path, ...copies];
          await startCombineImpl(key, { kind: "copy", path: queue[0] }, "banner", { queue: queue.slice(1), index: 1, total: queue.length });
          return;
        }
        await startCombineImpl(key, src, "banner");
        return;
      }
      case "remove":
        if (b.path) await removeExtraCopyImpl(key, b.path);
        return;
      case "keep":
        if (b.path) {
          i.knownCopies = addUnique(i.knownCopies, b.path);
          // Remembered with the version it had: asked again once it has versions of its own.
          if (b.version?.head) i.keptHeads = { ...i.keptHeads, [b.path]: b.version.head };
          drop();
          await saveSession();
        }
        return;
      case "whatChanged": await showWhatChangedImpl(key); return;
      case "undo": await undoCombineImpl(key); return;
      case "separate":
        if (b.path) await makeSeparate(key, b.path);
        return;
      case "notSame":
        if (b.path) await markDifferentAnalysisImpl(key, b.path);
        return;
      case "same": {
        if (!b.path) return;
        i.copyAnswer = { ...i.copyAnswer, [b.path]: "same" };
        await saveSession();
        const r = await readFile(b.path);
        const mine = i.manifest;
        if (r.ok && mine && t.baseRevision) extraCopyBanner(key, b.path, r.file, relationOf(mine, t.baseRevision, r.file.manifest, r.file.manifest.head));
        else drop();
        return;
      }
      case "updateMine": {
        if (presenceBlocks(key, "updateMine")) return;
        if (b.kind === "extraCopy") { if (b.path) await takeNewerCopy(key, bannerId, b.path); return; }
        const q = b.path;
        if (!q || !t.path || !t.analysisId) return;
        const p = await readFile(t.path);
        const h = await backend.header(q);
        if (!p.ok || !h.ok) { toast({ tone: "error", kind: "error", message: `'${fileStem(q)}' can't be updated right now.` }); return; }
        const owner = tabByPath(q);
        const res = await backend.save({
          path: q, expectedHead: h.header.head, analysisId: t.analysisId, docKey: owner?.key ?? newDocKey(), manifest: p.file.manifest, newParts: p.file.parts,
        });
        if (!res.ok) {
          toast({ tone: "error", kind: "error", message: res.kind === "conflict" ? `'${fileStem(q)}' was changed meanwhile. Nothing was replaced.` : `'${fileStem(q)}' couldn't be updated.` });
          return;
        }
        drop();
        if (!tabDirty(key)) await dropTab(key);
        if (owner) await switchTabImpl(owner.key); else await openImpl(res.path);
        return;
      }
      case "openAsNew": {
        const dk = i.bannerData.get(bannerId);
        drop();
        if (dk) await recoverDraftImpl(dk, { untitled: true });
        return;
      }
      case "discardDraft": {
        const dk = i.bannerData.get(bannerId);
        drop();
        if (dk) await quietly(backend.deleteDraft(dk), undefined);
        releaseIfClean(key);
        return;
      }
    }
  }

  async function openPrivacySettingsImpl(): Promise<void> {
    if (!desktop) return;
    await quietly(deps.invoke("open_url", { url: "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders" }), undefined);
  }

  // ── drafts: recover ──

  async function recoverList(): Promise<DraftListItem[]> {
    const drafts = await quietly(backend.listDrafts(), [] as DraftRecord[]);
    const open = new Set(get().tabs.map((t) => t.key));
    return drafts.filter((d) => !open.has(d.doc_key))
      .sort((a, b) => (a.saved_at < b.saved_at ? 1 : -1))
      .map((d) => ({
        docKey: d.doc_key, name: d.path ? fileStem(d.path) : d.title || "Untitled", path: d.path,
        folderLabel: d.path ? labelOf(d.path) : "", savedAt: d.saved_at,
      }));
  }

  async function recoverDraftImpl(docKey: string, opts: { untitled?: boolean } = {}): Promise<OpenOutcome> {
    const d = await quietly(backend.readDraft(docKey), null);
    const c = d ? contentOfDraft(d) : null;
    if (!d || !c) return { ok: false, reason: "failed" };
    if (get().dialog?.kind === "recover") set({ dialog: null });
    if (!opts.untitled && d.path && !tabByPath(d.path)) {
      const h = await backend.header(d.path);
      if (h.ok && (!d.analysis_id || h.header.analysis_id === d.analysis_id)) return openImpl(d.path, { key: docKey });
    }
    const title = `${d.path ? fileStem(d.path) : d.title || "Untitled"} (recovered)`;
    const out = await openUntitled(title, c);
    if (out.ok) await quietly(backend.deleteDraft(docKey), undefined);
    return out;
  }

  // ── restore ──

  async function restore(): Promise<number> {
    const session = await quietly(backend.readSession(), { v: 1, tabs: [] } as GraphSession);
    fileMemo.clear();
    const sd = session.share_default;
    shareDefault = sd === "always" || sd === "never" || sd === "auto" ? sd : "auto";
    if (session.files && typeof session.files === "object") {
      for (const [p, m] of Object.entries(session.files)) {
        if (!m || typeof m !== "object" || typeof m.analysis_id !== "string") continue;
        const strs = (l: unknown) => (Array.isArray(l) ? l.filter((x): x is string => typeof x === "string") : []);
        fileMemo.set(p, {
          analysis_id: m.analysis_id, settled_heads: strs(m.settled_heads), carry_heads: strs(m.carry_heads),
          accepted_head: typeof m.accepted_head === "string" ? m.accepted_head : null,
          ...(m.share === "auto" || m.share === "always" || m.share === "never" ? { share: m.share } : {}),
          ...(typeof m.note_epoch === "number" && Number.isFinite(m.note_epoch) && m.note_epoch > 0 ? { note_epoch: Math.floor(m.note_epoch) } : {}),
        });
      }
    }
    const tabs: FileTab[] = [];
    let activeKey: string | null = null;
    const drafts = new Map<string, DraftRecord>();
    for (const st of session.tabs ?? []) {
      if (!st || typeof st.doc_key !== "string" || tabs.some((t) => t.key === st.doc_key)) continue;
      if (tabs.length >= LIMITS.tabCap) break;
      const d = await quietly(backend.readDraft(st.doc_key), null);
      if (d) drafts.set(st.doc_key, d);
      if (st.path === null && !d) continue;            // an untitled tab that was never edited
      const template = asTemplate(st.template) ?? asTemplate(d?.template);
      internal.set(st.doc_key, newInternal({
        acceptedHead: st.accepted_head ?? null, knownCopies: [...(st.known_copies ?? [])], copyAnswer: { ...(st.copy_answer ?? {}) },
        settled: [...(st.settled_heads ?? [])], template, hasDraft: !!d, seenCopies: [...(st.seen_copies ?? [])],
        asides: Array.isArray(st.asides) ? st.asides.filter((p) => typeof p === "string") : [],
        carryHeads: Array.isArray(st.carry_heads) ? st.carry_heads.filter((p) => typeof p === "string") : [],
        // combine_pending: looked at again by the journal check when the tab is opened (nothing to keep).
        combinePending: null,
        keptHeads: st.kept_heads && typeof st.kept_heads === "object" ? Object.fromEntries(Object.entries(st.kept_heads).filter(([, v]) => typeof v === "string")) : {},
      }));
      if (st.path) seedFromMemo(st.doc_key, st.path, st.analysis_id);
      const plain = st.title || d?.title || "Untitled";
      const title = st.path ? fileStem(st.path) : plain.endsWith(" (recovered)") ? plain : `${plain} (recovered)`;
      tabs.push(newTab({
        key: st.doc_key, title, path: st.path, analysisId: st.analysis_id, baseRevision: st.base_revision, template,
        dirty: !!d, status: st.path ? "opening" : "ready",
      }));
      if (st.active) activeKey = st.doc_key;
    }
    if (!activeKey && tabs.length) activeKey = tabs[tabs.length - 1].key;
    set({ tabs, activeKey: null });
    // Background tabs: a cheap check now, loaded when switched to.
    for (const t of tabs) {
      if (t.key === activeKey || !t.path) continue;
      const h = await backend.header(t.path);
      if (h.ok && (!t.analysisId || h.header.analysis_id === t.analysisId)) {
        patchTab(t.key, { status: "ready" });
        // Watched from now on (10 s looks), so a rename or a change is noticed before the tab is visited.
        backend.track(t.path, { active: false });
        // Phase 3: who has it open; a background tab with unsaved changes holds it (its note says "editing").
        const aid = t.analysisId ?? h.header.analysis_id;
        if (!t.analysisId) patchTab(t.key, { analysisId: aid });
        await presenceOpen(t.key, t.path, aid);
        if (tabOf(t.key)?.dirty && !it(t.key).pr.holding) claim(t.key, { input: false }); else evaluate(t.key);
      } else await readErrorCard(t.key, h.ok ? "NotFound" : h.code, "restore");
    }
    let restored = 0;
    for (const t of tabs) {
      const d = drafts.get(t.key);
      if (!d) continue;
      if (t.key !== activeKey) { addBanner(t.key, { kind: "recovered", when: d.saved_at }); restored++; }
    }
    if (activeKey) {
      const key = activeKey;
      await exclusive(async () => {
        set({ activeKey: key });
        const res = await loadInto(key, null, "restore");
        const d = drafts.get(key);
        const mismatch = tabOf(key)?.banners.some((b) => b.kind === "draftMismatch");
        if (d && res === "ok" && !mismatch) { addBanner(key, { kind: "recovered", when: d.saved_at }); restored++; }
        else if (d && res === "card") restored++;
      });
    }
    return restored;
  }

  async function startupRecentCheck(): Promise<void> {
    const open = new Set(get().tabs.map((t) => t.path));
    for (const e of recentEntries.slice(0, LIMITS.recentStartupCheck)) {
      if (open.has(e.path)) continue;
      const h = await quietly(backend.header(e.path), null);
      if (!h) continue;
      if (!h.ok && h.code === "NotFound") await markRecentMissing(e.path, true);
      else if (h.ok && e.missing) await markRecentMissing(e.path, false);
    }
  }

  async function refreshOldLibrary(attempt = 0): Promise<void> {
    try {
      const st = await libraryStatus({ backend, library: deps.library });
      set({ oldLibrary: { total: st.total, unexported: st.unexported } });
    } catch {
      if (attempt < 20) deps.timers.setTimeout(() => { void refreshOldLibrary(attempt + 1); }, 3000);
    }
  }

  async function legacyDraftImport(hadTabs: boolean): Promise<void> {
    let d: GraphDraft | null = null;
    try { d = deps.legacyDraft.read(); } catch { d = null; }
    if (!d) return;
    if (hadTabs) {
      // Open tabs were restored with their own kept changes; an old browser-storage backup is stale.
      try { deps.legacyDraft.clear(); } catch { /* ignore */ }
      return;
    }
    const c = openFileContentFromLegacy(d);
    const out = await openUntitled(`${d.name || "Untitled"} (recovered)`, c);
    if (out.ok) {
      addBanner(out.key, { kind: "recovered", when: d.at ? iso(d.at) : undefined });
      try { deps.legacyDraft.clear(); } catch { /* ignore */ }
    }
  }

  /** The old draft's content through the normal load pipeline and the file form. */
  function openFileContentFromLegacy(d: GraphDraft): DocContent {
    return roundTrip(openContent({ doc: d.doc, analysis: d.analysis, figure: d.figure, scratch: d.scratchpad ?? null }));
  }

  // ── init ──

  async function initImpl(): Promise<void> {
    if (deps.desktop === null) desktop = await isTauri(); else desktop = deps.desktop;
    if (!backend) {
      if (desktop) backend = (await import("./tauriBackend")).tauriBackend();
      else {
        const p = await deps.makePreviewBackend!();
        backend = p.backend;
        persistNow = p.persistNow;
        // Phase 3: the preview's controller runs on the simulated clock (the simulator's "+5 min" and sleeps).
        if (p.now) deps.now = p.now;
        if (p.timers) deps.timers = p.timers;
      }
    }
    set({ desktop });
    backend.subscribe((e) => { void onFileEvent(e).catch((err) => console.warn("[files] event", err)); });
    if (desktop) {
      await quietly(deps.listen<MenuEvent>(EVT.menu, (m) => { if (m.id !== MENU.quit) void store.getState().menu(m.id, m.path); }), () => undefined);
      await quietly(deps.listen<OpenFilesEvent>(EVT.openFiles, (e) => { void openPaths(e.paths); }), () => undefined);
      await quietly(deps.listen<QuitRequest>(EVT.quitRequested, (q) => { void onQuitRequested(q); }), () => undefined);
    }
    info = await quietly(backend.appInfo(), info);
    device = await quietly(backend.device(), null);
    const s0 = await quietly(backend.readSeen(), emptySeenMap());
    seen = s0 && typeof s0 === "object" && s0.analyses && typeof s0.analyses === "object" ? s0 : emptySeenMap();
    domInteractionBusy();     // starts watching the mouse button (no-op outside a page)
    if (device) set({ settings: { userName: device.user_name, deviceName: device.device_name } });
    recentEntries = await quietly(backend.readRecent(), [] as RecentEntry[]);
    set({ recent: recentItems() });
    const restored = await restore();
    { const st = get().settings; if (st) set({ settings: { ...st, shareDefault } }); }
    const hadTabs = get().tabs.length > 0;
    if (restored > 0) toast({ tone: "success", kind: "restoredDrafts", count: restored });
    if (desktop) {
      const pending = await quietly(deps.invoke(CMD.takePendingOpens, {}) as Promise<string[]>, [] as string[]);
      if (Array.isArray(pending) && pending.length) await openPaths(pending);
    }
    await legacyDraftImport(hadTabs);
    void startupRecentCheck();
    void refreshOldLibrary();
    const w = deps.window;
    if (w) {
      w.addEventListener("focus", () => { backend.pollNow(); retryHeldNow(); });
      if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
        document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") retryHeldNow(); });
      }
      w.addEventListener("blur", () => {
        void writeActiveDraft(false);
        // Phase 3 (D6): leaving the window ends the hold of a clean tab at once.
        for (const t of get().tabs) releaseIfClean(t.key);
      });
      w.addEventListener("focus", () => { for (const t of get().tabs) evaluate(t.key); });
      for (const ev of ["keydown", "pointerdown"]) w.addEventListener(ev, () => { activity.at = now(); }, true);
      if (!desktop) {
        w.addEventListener("beforeunload", () => {
          // Synchronous: the memory backend's calls complete before their first await.
          void writeActiveDraft(true);
          void backend.writeSession(buildSession());
          persistNow?.();
        });
      }
    }
    set({ ready: true, recent: recentItems() });
    pushMenu();
    startPresence();
  }

  async function openPaths(paths: string[]): Promise<void> {
    for (const p of paths) await openImpl(p);
    set({ focusSerial: get().focusSerial + 1 });
  }

  async function onQuitRequested(q: QuitRequest): Promise<void> {
    const ok = await quitRoutineImpl(q.source, q.requestId);
    await quietly(deps.invoke(CMD.quitReply, { requestId: q.requestId, stage: ok ? "proceed" : "cancel" }), undefined);
  }

  function quitRoutineImpl(source: QuitSource | "update", requestId?: number): Promise<boolean> {
    if (quitPromise) return quitPromise;
    quitPromise = (async () => {
      // Waiting automatic combines stop; they are looked at again at the next start (combine_pending).
      const waiting = get().tabs.filter((t) => internal.get(t.key)?.autoTimer).map((t) => t.key);
      for (const k of waiting) { const i = it(k); if (i.autoTimer) { deps.timers.clearTimeout(i.autoTimer); i.autoTimer = null; } }
      const resume = () => { for (const k of waiting) if (tabOf(k)) { clearCombining(k); void onHead(k, ""); } };
      await writeActiveDraft(true);
      await saveSession();
      await flushSeen();
      persistNow?.();
      if (source === "update") return true;
      const dirty = get().tabs.filter((t) => !isCard(t.status) && tabDirty(t.key));
      if (!dirty.length) return true;
      if (desktop && requestId !== undefined) await quietly(deps.invoke(CMD.quitReply, { requestId, stage: "flushed" }), undefined);
      const a = await ask({ kind: "quit", dirty: dirty.map((t) => ({ key: t.key, title: t.title })) });
      set({ dialog: null });
      if (a.kind !== "quit" || a.choice === "cancel") { resume(); return false; }
      if (a.choice === "keep") return true;
      for (const t of get().tabs.filter((x) => dirty.some((d) => d.key === x.key))) {
        const res = await saveImpl(t.key);
        if (!res.ok) {
          if (get().activeKey !== t.key && tabOf(t.key)) await switchTabImpl(t.key);
          resume();
          return false;
        }
      }
      return true;
    })().then((ok) => {
      // Phase 3: the preview's (and the tests') simulated quit removes this computer's notes; on the desktop Rust does.
      if (ok && !desktop && source !== "update") clearAllNotes();
      return ok;
    }).finally(() => { quitPromise = null; });
    return quitPromise;
  }

  // ── export / old library ──

  async function openExportImpl(): Promise<void> {
    try {
      const st = await libraryStatus({ backend, library: deps.library });
      set({ oldLibrary: { total: st.total, unexported: st.unexported } });
      const already = st.rows.filter((r) => isExported(st.map, r)).length;
      set({ dialog: { kind: "export", state: { phase: "confirm", total: st.total, already, done: 0, failed: [], dir: null, folderLabel: "" } } });
    } catch {
      toast({ tone: "error", kind: "error", message: "The old library can't be read right now. Try again in a moment." });
    }
  }

  async function exportLibraryImpl(dir?: string): Promise<void> {
    if (!dir) {
      const d = await pickPath({ mode: "folder", title: "Choose a folder for your analyses", suggestedName: null, startDir: null });
      if (!d) return;
      dir = d;
    }
    const onProgress = (s: ExportState) => set({ dialog: { kind: "export", state: s } });
    try {
      const run = await runExport({ backend, library: deps.library, now, author, homeDir: info.homeDir }, dir, onProgress);
      for (const e of [...run.exported].reverse()) {
        recentEntries = [{ path: e.path, analysis_id: e.analysisId, opened_at: iso(now()) }, ...recentEntries.filter((x) => x.path !== e.path)];
      }
      await writeRecent(recentEntries);
      await refreshOldLibrary(99);
    } catch {
      toast({ tone: "error", kind: "error", message: "The old library can't be read right now. Try again in a moment." });
      const d = get().dialog;
      if (d?.kind === "export") set({ dialog: { kind: "export", state: { ...d.state, phase: "done" } } });
    }
  }

  async function importLibraryRowImpl(id: number): Promise<OpenOutcome> {
    let saved = null;
    try { saved = await deps.library.get(id); } catch { saved = null; }
    if (!saved) { toast({ tone: "error", kind: "error", message: "This analysis can't be read from the old library." }); return { ok: false, reason: "failed" }; }
    const map = await quietly(backend.readExportMap(), { v: 1, rows: {} });
    const rc = rowContent(saved, map.rows[String(id)]);
    if (!rc) { toast({ tone: "error", kind: "error", message: "This analysis was made by a newer version." }); return { ok: false, reason: "failed" }; }
    if (get().dialog?.kind === "oldLibrary") set({ dialog: null });
    return openUntitled(saved.name || "Untitled", rc.content);
  }

  // ── menu ──

  const focusGraphs = () => set({ focusSerial: get().focusSerial + 1 });

  async function menuImpl(id: MenuId, path?: string | null): Promise<void> {
    // Save, Save As, Duplicate and Close Tab act on the Graphs tab on screen. From another tool
    // they only bring Graphs forward (so Cmd+W in qPCR never closes an analysis you can't see).
    const docCommand = id === MENU.save || id === MENU.saveAs || id === MENU.duplicate || id === MENU.closeTab;
    if (docCommand && !deps.graphsVisible()) { focusGraphs(); return; }
    switch (id) {
      case MENU.new: await showStartImpl(); focusGraphs(); return;
      case MENU.open: focusGraphs(); await openImpl(); return;
      case MENU.openRecent: if (path) { focusGraphs(); await openImpl(path); } return;
      case MENU.clearRecent: await writeRecent([]); return;
      case MENU.save: await saveImpl(get().activeKey ?? ""); return;
      case MENU.saveAs: await saveAsImpl("ask"); return;
      case MENU.duplicate: await duplicateImpl(); return;
      case MENU.closeTab: await closeTabImpl(); return;
      case MENU.versions: {
        if (!deps.graphsVisible()) focusGraphs();
        const v = get().versions;
        if (v && v.tabKey === get().activeKey) closeVersionsImpl(); else await openVersionsImpl();
        return;
      }
      // These open a dialog whose actions open analyses: show Graphs behind it.
      case MENU.recover: focusGraphs(); await store.getState().openRecover(); return;
      case MENU.exportLibrary: focusGraphs(); await openExportImpl(); return;
      case MENU.oldLibrary: focusGraphs(); set({ dialog: { kind: "oldLibrary" } }); return;
      case MENU.settings: set({ dialog: { kind: "settings" } }); return;
      case MENU.sharing: if (!deps.graphsVisible()) focusGraphs(); openSharingImpl(); return;
      case MENU.about: set({ aboutSerial: get().aboutSerial + 1 }); return;
      case MENU.quit: if (!desktop) await quitRoutineImpl("menu"); return;
    }
  }

  // ── the store ──

  const base = create<FileSessionStateP4>(() => ({
    ready: false, desktop: false, tabs: [], activeKey: null, cards: [], recent: [], dialog: null, pathPicker: null, toasts: [],
    settings: null, oldLibrary: null, focusSerial: 0, aboutSerial: 0, busy: false, versions: null,

    init: () => (initPromise ??= initImpl().catch((e) => { console.error("[files] init failed", e); set({ ready: true }); })),
    quitRoutine: (source) => quitRoutineImpl(source),

    newDoc: (template, sample) => newDocImpl(template, sample),
    open: (path) => openImpl(path),
    openRecent: (path) => openImpl(path),
    removeRecent: async (path) => { await writeRecent(recentEntries.filter((e) => e.path !== path)); },
    save: (key) => saveImpl(key ?? get().activeKey ?? ""),
    saveAs: (mode) => saveAsImpl(mode ?? "ask"),
    duplicate: () => duplicateImpl(),
    closeTab: (key) => closeTabImpl(key),
    switchTab: (key) => switchTabImpl(key),
    showStart: () => showStartImpl(),
    reloadFromDisk: async (key) => {
      const k = key ?? get().activeKey;
      const t = tabOf(k);
      if (!k || !t?.path || tabDirty(k)) return false;
      const r = await readFile(t.path);
      if (!r.ok) return false;
      const c = openFile(r.file);
      if (!c) return false;
      if (isLoaded(k)) {
        const s = graph.getState();
        if (!replaceInPlace(k, { content: c, head: r.file.manifest.head, manifest: r.file.manifest, path: t.path, expectedBase: s.file?.baseRevision ?? null, expectedSerial: s.editSerial, readOnly: r.readOnly })) return false;
      }
      it(k).manifest = r.file.manifest;
      patchTab(k, { baseRevision: r.file.manifest.head, dirty: false, readOnly: r.readOnly });
      removeKinds(k, ["newerOnDisk"]);
      releaseIfClean(k);          // phase 3 (D6): revert ends the hold at once
      await saveSession();
      return true;
    },
    reveal: async (key) => {
      const t = tabOf(key ?? get().activeKey);
      if (t?.path) await quietly(backend.reveal(t.path), undefined);
    },

    retry: async (key) => { it(key).firstTry = 0; await retryTab(key, false); },
    findIt: (key, dir) => findItImpl(key, dir),
    chooseFound: (path) => chooseFoundImpl(path),
    cancelFind: () => {
      if (findToken) backend.cancelLocate(findToken);
      findToken = null;
      if (get().dialog?.kind === "find") set({ dialog: null });
    },
    forget: async (key) => {
      const t = tabOf(key);
      if (!t) return;
      if (t.path) await markRecentMissing(t.path, true);
      await dropTab(key);
    },

    bannerAction: (key, bannerId, action) => bannerActionImpl(key, bannerId, action),
    dismissBanner: (key, bannerId) => {
      const b = tabOf(key)?.banners.find((x) => x.id === bannerId);
      if (b && isPresenceKind(b.kind)) { dismissPresence(key, b); return; }
      removeBanners(key, (x) => x.id === bannerId);
    },
    resolveConflict: (choice) => resolveConflictImpl(choice),

    answerDialog: (answer) => {
      const r = dialogResolve;
      const d = get().dialog;
      if (!r || !d || d.kind !== answer.kind) return;
      dialogResolve = null;
      set({ dialog: null });
      r(answer);
    },
    closeDialog: () => {
      const d = get().dialog;
      if (!d) return;
      if (d.kind === "conflict") { void resolveConflictImpl("cancel"); return; }
      if (d.kind === "saveAsKind" || d.kind === "closeDirty" || d.kind === "quit") {
        get().answerDialog({ kind: d.kind, choice: "cancel" } as DialogAnswer);
        return;
      }
      if (d.kind === "find") { get().cancelFind(); return; }
      if (d.kind === "combine") { cancelCombineImpl(); return; }
      if (d.kind === "editAnyway") { get().answerDialog({ kind: "editAnyway", choice: "cancel" }); if (get().dialog?.kind === "editAnyway") set({ dialog: null }); return; }
      if (d.kind === "resumeConfirm") { get().answerDialog({ kind: "resumeConfirm", choice: "wait" }); if (get().dialog?.kind === "resumeConfirm") set({ dialog: null }); return; }
      if (d.kind === "bringBackDirty") { get().answerDialog({ kind: "bringBackDirty", choice: "cancel" }); return; }
      if (d.kind === "export" && d.state.phase === "running") return;
      set({ dialog: null });
    },
    answerPathPicker: (path) => {
      const r = pickerResolve;
      pickerResolve = null;
      set({ pathPicker: null });
      r?.(path);
    },
    dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
    openSettings: () => set({ dialog: { kind: "settings" } }),
    setSettings: async (patch: Partial<FileSettings>) => {
      if (patch.shareDefault && patch.shareDefault !== shareDefault) await setSharingDefaultImpl(patch.shareDefault);
      if (patch.userName !== undefined || patch.deviceName !== undefined) {
        const d = await backend.setDevice({
          ...(patch.userName !== undefined ? { userName: patch.userName } : {}),
          ...(patch.deviceName !== undefined ? { deviceName: patch.deviceName } : {}),
        });
        device = { ...d, session_id: device?.session_id ?? d.session_id };
        set({ settings: { userName: d.user_name, deviceName: d.device_name, shareDefault } });
        // Phase 3: the notes are written again with the new names.
        for (const t of get().tabs) evaluate(t.key);
      }
      if (get().dialog?.kind === "settings") set({ dialog: null });
    },
    openPrivacySettings: () => openPrivacySettingsImpl(),

    openRecover: async () => { set({ dialog: { kind: "recover", drafts: await recoverList() } }); },
    recoverDraft: (docKey) => recoverDraftImpl(docKey),
    deleteDraft: async (docKey) => {
      await quietly(backend.deleteDraft(docKey), undefined);
      if (get().dialog?.kind === "recover") set({ dialog: { kind: "recover", drafts: await recoverList() } });
    },

    openOldLibrary: () => set({ dialog: { kind: "oldLibrary" } }),
    importLibraryRow: (id) => importLibraryRowImpl(id),
    openExport: () => openExportImpl(),
    exportLibrary: (dir) => exportLibraryImpl(dir),

    menu: (id, path) => menuImpl(id, path),

    // ── phase 2 ──
    openVersions: (key) => openVersionsImpl(key),
    closeVersions: () => closeVersionsImpl(),
    selectVersion: (id) => selectVersionImpl(id),
    compareWithCurrent: (on) => compareWithCurrentImpl(on),
    bringBack: (id) => bringBackImpl(id),
    saveVersionAsNew: (id) => saveVersionAsNewImpl(id),
    startCombine: async (key, source) => { await startCombineImpl(key, source, "banner"); },
    setSectionChoice: (section, choice) => setSectionChoiceImpl(section, choice),
    setConflictChoice: (id, choice) => setConflictChoiceImpl(id, choice),
    setAllInSection: (section, side) => setAllInSectionImpl(section, side),
    applyCombine: () => applyCombineImpl(),
    cancelCombine: () => cancelCombineImpl(),
    keepBothAsSeparate: () => keepBothAsSeparateImpl(),
    undoCombine: (key) => undoCombineImpl(key),
    showWhatChanged: (key) => showWhatChangedImpl(key),
    removeExtraCopy: (key, path) => removeExtraCopyImpl(key, path),
    markDifferentAnalysis: (key, path) => markDifferentAnalysisImpl(key, path),
    useEarlierVersion: (key) => useEarlierImpl(key),
    goBackToMyLatest: (key) => goBackToMyLatestImpl(key),
    holdReplace: (reason) => holdReplaceImpl(reason),

    // ── phase 3 ──
    editHere: (key, confirmed) => editHereImpl(key ?? get().activeKey ?? "", confirmed),
    keepEditing: (key) => keepEditingImpl(key ?? get().activeKey ?? ""),
    saveAsSeparateCopy: (key) => saveAsSeparateCopyImpl(key ?? get().activeKey ?? ""),
    reportEditAttempt: (path, action, key) => { const k = key ?? get().activeKey; if (k && tabOf(k)) reportAttempt(k, path, action); },
    openSharing: (key) => openSharingImpl(key),
    setSharing: (key, choice) => setSharingImpl(key, choice),
    setSharingDefault: (mode) => setSharingDefaultImpl(mode),
  }));

  store = Object.assign(base, {
    internal: {
      deps,
      backend: () => backend ?? null,
      manifestOf: (key: string) => internal.get(key)?.manifest ?? null,
      knownCopies: (key: string) => [...(internal.get(key)?.knownCopies ?? [])],
      acceptedHead: (key: string) => internal.get(key)?.acceptedHead ?? null,
      flushDraftNow: () => writeActiveDraft(true),
      carryHeads: (key: string) => [...(internal.get(key)?.carryHeads ?? [])],
      asides: (key: string) => [...(internal.get(key)?.asides ?? [])],
      settled: (key: string) => [...(internal.get(key)?.settled ?? [])],
      seen: () => JSON.parse(JSON.stringify(seen)) as SeenMap,
      flushSeenNow: () => { seenDirty = true; return flushSeen(); },
      presence: (key: string) => {
        const pr = internal.get(key)?.pr;
        if (!pr) return null;
        return {
          records: pr.records, holding: pr.holding, epoch: pr.epoch, overrides: [...pr.overrides], supersedes: [...pr.supersedes], resume: pr.resume,
          written: pr.written ? { state: pr.written.state, head: pr.written.head, base: pr.written.base, epoch: pr.written.epoch, path: pr.written.path, off: pr.written.off } : null,
          decision: pr.decision, obs: pr.obs, hadForeignNote: pr.hadForeignNote,
        };
      },
      presenceTick: () => presenceTick(),
    },
    dialogExtras: {
      setRestInSection: (section: SectionName, side: SidePick) => setRestInSectionImpl(section, side),
    },
  });

  // Mirror the active document's unsaved state into its tab; drafts 1 s after the last change.
  graph.subscribe((s, prev) => {
    if (suppress) return;
    const key = get().activeKey;
    if (!key || s.file?.docKey !== key || !s.doc) return;
    const t = tabOf(key);
    if (!t) return;
    const dirty = isDirty(s);
    if (t.dirty !== dirty) patchTab(key, { dirty });
    if (s.editSerial !== prev.editSerial) scheduleDraft();
  });

  // Phase 3: the claim hook (§4.1) and refused edits (§5.5), on the loaded tab.
  graph.subscribe((s, prev) => {
    const key = s.file?.docKey;
    if (!key || !tabOf(key) || !s.doc) return;
    if (s.userEditSerial !== prev.userEditSerial) {
      if (it(key).pr.holding) noteInput(key);
      else if (tabOf(key)?.path) claim(key, { input: true });
    }
    // Phase 3 fix: the last typed editor closed (Escape, or its text is the content's again) without a change: a
    // clean tab's hold ends 30 s after the last input again (lingerCheck left it alone while the typing lasted).
    if (s.typing.length === 0 && prev.typing.length > 0 && prev.file?.docKey === key && it(key).pr.holding) restartLinger(key);
    if (s.blocked && s.blocked !== prev.blocked && prev.file?.docKey === key) onBlocked(key);
  });

  // Phase 3: a tab whose base, unsaved state, status or path changed is evaluated again (in a moment).
  const evalQueue = new Set<string>();
  store.subscribe((s, prev) => {
    if (s.tabs === prev.tabs) return;
    const before = new Map(prev.tabs.map((t) => [t.key, t] as const));
    for (const t of s.tabs) {
      const p = before.get(t.key);
      if (!p || p.baseRevision !== t.baseRevision || p.dirty !== t.dirty || p.readOnly !== t.readOnly || p.status !== t.status || p.path !== t.path || p.analysisId !== t.analysisId) {
        if (evalQueue.has(t.key)) continue;
        evalQueue.add(t.key);
        void Promise.resolve().then(() => { evalQueue.delete(t.key); if (tabOf(t.key)) evaluate(t.key); });
      }
    }
  });

  // Menu state follows the active tab, Recent and the old library.
  store.subscribe((s, prev) => {
    if (s.activeKey !== prev.activeKey || s.tabs !== prev.tabs || s.recent !== prev.recent || s.oldLibrary !== prev.oldLibrary || s.ready !== prev.ready) pushMenu();
  });

  return store;
}

/** The app's controller. */
export const useFileSession = createFileSession();
