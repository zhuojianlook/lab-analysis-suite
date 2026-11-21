/* Phase 1 contract ("Graphs analyses saved as files"): the boundary between the
   Rust shell, the TypeScript file core and the files UI. Types and string /
   number constants only — no runtime logic. The prose contract
   (phase1-contract.md) explains every item; where the two differ, this file
   wins for TypeScript shapes.

   Naming rule on the wire: command ARGUMENT names and the envelope types
   defined here are camelCase. The stored records of phase 0 (Manifest,
   FileHeader, GraphSession, DraftRecord, JournalHead, DisplacedEntry,
   RecentEntry, ExportMap, DeviceIdentity) keep their snake_case field names and
   pass through Rust unchanged. */

import type { Template } from "../../../api/graph";
import type {
  DeviceIdentity, DirEntry, DisplacedEntry, DraftRecord, ExportMap, FileBackend, FileErrorCode, FileStat, GraphSession,
  JournalHead, RecentEntry,
} from "./backend";
import type { FileHeader } from "./format";

// ═════════════════════════════════════════════════════════════════════════════
// 1. Constants
// ═════════════════════════════════════════════════════════════════════════════

/** Tauri command names (Rust `#[tauri::command]` function names). */
export const CMD = {
  appInfo: "app_info",
  takePendingOpens: "take_pending_opens",
  setMenuState: "app_set_menu_state",
  quitReply: "app_quit_reply",
  reveal: "graphfile_reveal",

  read: "graphfile_read",
  header: "graphfile_header",
  save: "graphfile_save",
  scanDir: "graphfile_scan_dir",
  locate: "graphfile_locate",
  locateCancel: "graphfile_locate_cancel",
  track: "graphfile_track",
  untrack: "graphfile_untrack",
  pollNow: "graphfile_poll_now",
  journalHeads: "graphfile_journal_heads",
  readJournal: "graphfile_read_journal",
  writeJournal: "graphfile_write_journal",
  listDisplaced: "graphfile_list_displaced",
  readDisplaced: "graphfile_read_displaced",

  device: "appstate_device",
  setDevice: "appstate_set_device",
  readSession: "appstate_read_session",
  writeSession: "appstate_write_session",
  readDraft: "appstate_read_draft",
  writeDraft: "appstate_write_draft",
  deleteDraft: "appstate_delete_draft",
  listDrafts: "appstate_list_drafts",
  readRecent: "appstate_read_recent",
  writeRecent: "appstate_write_recent",
  readExportMap: "appstate_read_export_map",
  writeExportMap: "appstate_write_export_map",
} as const;
export type CommandName = (typeof CMD)[keyof typeof CMD];

/** Tauri event names (Rust → frontend, `app.emit`). */
export const EVT = {
  /** Payload: RustFileEvent. */
  file: "graphfile://event",
  /** Payload: LocateProgress. */
  locateProgress: "graphfile://locate-progress",
  /** Payload: MenuEvent. */
  menu: "app://menu",
  /** Payload: OpenFilesEvent. Only after take_pending_opens was called once. */
  openFiles: "app://open-files",
  /** Payload: QuitRequest. */
  quitRequested: "app://quit-requested",
} as const;
export type EventName = (typeof EVT)[keyof typeof EVT];

/** Menu item ids (Rust menu ids and MenuEvent.id). Recent files are
 *  "file.open_recent.<index>" in Rust; the event carries id "file.open_recent"
 *  plus the path. */
export const MENU = {
  about: "app.about",
  settings: "app.settings",
  quit: "app.quit",
  new: "file.new",
  open: "file.open",
  openRecent: "file.open_recent",
  clearRecent: "file.clear_recent",
  save: "file.save",
  saveAs: "file.save_as",
  duplicate: "file.duplicate",
  closeTab: "file.close_tab",
  recover: "file.recover",
  exportLibrary: "file.export_library",
  oldLibrary: "file.old_library",
} as const;
export type MenuId = (typeof MENU)[keyof typeof MENU];

/** Numbers both sides must agree on. Times in ms. */
export const LIMITS = {
  /** Most open tabs. */
  tabCap: 12,
  pollActiveMs: 3000,
  pollBackgroundMs: 10000,
  /** Two looks this far apart with the same size and mtime before a changed file is read. */
  stableMs: 300,
  /** A tracked path must be absent this long (and on two looks) before "missing" / rename follow. */
  missingConfirmMs: 5000,
  /** Startup: silent retries for a missing path under a cloud folder before the card offers anything else. */
  waitCloudMs: 60000,
  /** Opening: how long an incomplete file is retried before the "can't be read yet" card. */
  incompleteRetryMs: 10000,
  /** Every Rust file command except save and locate. */
  commandTimeoutMs: 15000,
  saveTimeoutMs: 30000,
  /** Largest .lag file read. */
  readLimitBytes: 64 * 1024 * 1024,
  /** Find it… bounds. */
  locateDepth: 8,
  locateEntries: 50000,
  locateMs: 20000,
  /** Tail of a file read to find the ZIP comment. */
  headerTailBytes: 64 * 1024,
  /** Draft is written this long after the last change. */
  draftDebounceMs: 1000,
  /** Quit: the frontend must send stage "flushed" within this time. */
  quitFlushMs: 5000,
  /** Quit asked by the system (Dock, logout): time for the person to answer the dialog before the app quits keeping drafts. */
  quitSystemAnswerMs: 60000,
  /** Recent files kept / shown in the menu. */
  recentMenu: 10,
  /** Recent paths checked against the journal at startup. */
  recentStartupCheck: 20,
} as const;

/** Exit code of the updater's restart; the quit routine is never started for it. */
export const RESTART_EXIT_CODE = 2147483647;

// ═════════════════════════════════════════════════════════════════════════════
// 2. Rust commands: errors, arguments, results
// ═════════════════════════════════════════════════════════════════════════════

/** `kind` of a rejected command. The first eight are FileErrorCode (backend.ts). */
export type RustErrorKind =
  | FileErrorCode
  /** Unexpected disk error (disk full, read-only volume, name too long…). */
  | "Io"
  /** graphfile_locate only: stopped by graphfile_locate_cancel. */
  | "Cancelled"
  /** The app has no folder for its own records (release build could not resolve it). */
  | "NoStateDir";

export const RUST_ERROR_KINDS: readonly RustErrorKind[] = [
  "NotFound", "PermissionDenied", "OfflineOrTimeout", "Incomplete", "Dataless", "TooNew", "IdentityMismatch", "Invalid",
  "Io", "Cancelled", "NoStateDir",
];

/** What `invoke` rejects with for every command in CMD. `message` is plain
 *  English for a log line, not UI text; the UI words errors from `kind`. */
export interface RustError {
  kind: RustErrorKind;
  message: string;
  /** Kind-specific extra, else null. Incomplete: { reason: string }. IdentityMismatch: { found: string | null }
   *  (analysis id at the path). TooNew: { min_reader_version: number }. */
  data: Record<string, unknown> | null;
}

/** A whole file as Rust hands it over: JSON texts exactly as stored. Rust never
 *  parses a part and never re-serialises the manifest. */
export interface RawFile {
  /** manifest.json, byte for byte (UTF-8). */
  manifestText: string;
  /** Every "parts/<sha256>.json" entry in the file → its text. */
  parts: Record<string, string>;
}

/** graphfile_read → */
export interface ReadReply extends RawFile {
  stat: FileStat;
  readOnly: "tooNew" | null;
}

/** graphfile_header → */
export interface HeaderReply {
  header: FileHeader;
  stat: FileStat;
}

/** graphfile_save { req } */
export interface SaveArgs {
  path: string;
  /** Head the save is based on; null = a new file. */
  expectedHead: string | null;
  analysisId: string;
  docKey: string;
  /** canonicalJson(manifest), written as manifest.json byte for byte. */
  manifestText: string;
  /** "parts/<sha256>.json" → canonical text; only parts not already in the file
   *  at the path nor in the journal copy of expectedHead (sending more is allowed). */
  newParts: Record<string, string>;
  /** expectedHead null only. false: a file at the path → outcome "conflict"
   *  (or IdentityMismatch / Invalid). true (the person confirmed "Replace" in
   *  the save dialog): whatever is at the path is moved to displaced/ first. */
  replaceExisting: boolean;
}

/** graphfile_save → (resolved value; errors reject with RustError). */
export type SaveReply =
  | { kind: "saved"; path: string; head: string; stat: FileStat }
  | { kind: "savedAside"; path: string; head: string; stat: FileStat }
  | { kind: "savedButDisplaced"; path: string; head: string; stat: FileStat; displacedHead: string }
  | { kind: "conflict"; head: string }
  | { kind: "missing" };

/** graphfile_scan_dir → */
export interface ScanReply {
  entries: DirEntry[];
}

/** graphfile_locate { dir, analysisId, token } */
export interface LocateArgs {
  dir: string;
  analysisId: string;
  /** Chosen by the caller; names this run in progress events and for cancel. */
  token: string;
}

export interface LocateMatch {
  path: string;
  head: string;
  stat: FileStat;
  /** From the head revision of the validated file. */
  userName: string;
  deviceName: string;
  /** The head revision's `time` (ISO); display only. */
  time: string;
}

/** graphfile_locate → */
export interface LocateReply {
  /** Fully validated files with the analysis id, newest mtime first. */
  matches: LocateMatch[];
  /** Analysis files that are online-only (not read). At most 50 paths; the count is exact. */
  onlineOnly: string[];
  onlineOnlyCount: number;
  /** Folders that could not be read (permission). At most 20. */
  skippedFolders: string[];
  /** Which bound stopped the search early, if any. */
  truncated: "depth" | "entries" | "time" | null;
  /** Directory entries looked at. */
  scanned: number;
}

/** EVT.locateProgress, about every 250 ms while a search runs. */
export interface LocateProgress {
  token: string;
  scanned: number;
  matches: number;
}

/** graphfile_track { path, active, head, analysisId } */
export interface TrackArgs {
  path: string;
  /** true = the visible tab (checked every pollActiveMs), false = pollBackgroundMs. */
  active: boolean;
  /** What the tab has loaded; a different valid head on disk is reported as "changed". null = unknown. */
  head: string | null;
  analysisId: string | null;
}

/** graphfile_write_journal { path, file } */
export interface WriteJournalArgs {
  /** The path the working copy belongs to (journal index key). */
  path: string;
  /** Must contain every part the head revision references. */
  file: RawFile;
}

/** appstate_set_device { patch } → DeviceIdentity */
export interface DevicePatch {
  /** Trimmed; empty = back to the default (computer name / OS user). Max 60 characters. */
  deviceName?: string;
  userName?: string;
}

/** app_info → */
export interface AppInfo {
  /** tauri.conf.json version, e.g. "0.2.1". */
  appVersion: string;
  /** "macos" | "windows" | "linux". */
  platform: string;
  /** Absolute, no trailing slash. */
  homeDir: string;
  /** Folders whose files should be moved before editing (system temp, Mail downloads, Downloads). Absolute, no trailing slash. */
  tempDirs: string[];
  /** Folder of the app's own records, or null when it could not be resolved (every appstate_* command then rejects NoStateDir). */
  stateDir: string | null;
  /** true in debug builds. */
  debug: boolean;
}

/** app_set_menu_state { state } */
export interface MenuState {
  /** A tab is active: Save As, Duplicate, Close Tab enabled. */
  hasDoc: boolean;
  /** Save enabled. */
  canSave: boolean;
  /** Open Recent submenu, newest first, at most LIMITS.recentMenu. `label` is the menu text. */
  recent: { path: string; label: string }[];
  /** Export library to files… enabled (the old library has analyses). */
  canExportLibrary: boolean;
  /** Old library… enabled. */
  hasOldLibrary: boolean;
}

export type QuitSource = "menu" | "window" | "system" | "exit";

/** EVT.quitRequested */
export interface QuitRequest {
  /** Echoed in app_quit_reply. */
  requestId: number;
  /** menu = Quit item / Cmd+Q; window = close button / Alt+F4; system = Dock Quit, logout, shutdown, AppleScript; exit = any other exit request. */
  source: QuitSource;
}

/** app_quit_reply { requestId, stage } — see the quit handshake in the contract.
 *  flushed: drafts and session are on disk, a dialog is now open (sent at most once, before proceed / cancel).
 *  proceed: quit now. cancel: stay open. */
export type QuitStage = "flushed" | "proceed" | "cancel";
export interface QuitReplyArgs {
  requestId: number;
  stage: QuitStage;
}

/** EVT.menu */
export interface MenuEvent {
  id: MenuId;
  /** file.open_recent only. */
  path: string | null;
}

/** EVT.openFiles: absolute paths (never file:// URLs). take_pending_opens returns the same kind of paths as a plain string[]. */
export interface OpenFilesEvent {
  paths: string[];
}

/** EVT.file — what the poll thread reports for tracked files. `path` is always
 *  the tracked path the event belongs to. */
export type RustFileEvent =
  /** A stable, fully valid file with the tracked analysis id and another head than the track's. */
  | { type: "changed"; path: string; head: string }
  /** Renamed in its folder and followed (safe follow rule). The track is now keyed by `to`. */
  | { type: "moved"; from: string; to: string; head: string }
  /** Absent on two looks ≥ missingConfirmMs apart, no single safe successor. Sent once per disappearance. */
  | { type: "missing"; path: string; candidates: string[] }
  /** After "missing", "unreadable" or "replaced": a valid file with the tracked id is at the path again. */
  | { type: "back"; path: string; head: string }
  /** Another file with the same analysis id appeared (or changed head) in the folder. */
  | { type: "sibling"; path: string; sibling: string; header: FileHeader }
  /** The path exists but cannot be used now. Sent when the reason starts or changes. */
  | { type: "unreadable"; path: string; reason: "Incomplete" | "Dataless" | "PermissionDenied" | "OfflineOrTimeout" }
  /** A valid file with ANOTHER analysis id is at the path. Never adopted. */
  | { type: "replaced"; path: string; analysisId: string };

/** The typed map of every command: argument object as passed to `invoke`, and the resolved value. */
export interface Commands {
  app_info: { args: Record<string, never>; result: AppInfo };
  take_pending_opens: { args: Record<string, never>; result: string[] };
  app_set_menu_state: { args: { state: MenuState }; result: null };
  app_quit_reply: { args: QuitReplyArgs; result: null };
  graphfile_reveal: { args: { path: string }; result: null };

  graphfile_read: { args: { path: string }; result: ReadReply };
  graphfile_header: { args: { path: string }; result: HeaderReply };
  graphfile_save: { args: { req: SaveArgs }; result: SaveReply };
  graphfile_scan_dir: { args: { dir: string }; result: ScanReply };
  graphfile_locate: { args: LocateArgs; result: LocateReply };
  graphfile_locate_cancel: { args: { token: string }; result: null };
  graphfile_track: { args: TrackArgs; result: null };
  graphfile_untrack: { args: { path: string }; result: null };
  graphfile_poll_now: { args: Record<string, never>; result: null };
  graphfile_journal_heads: { args: { analysisId: string; path: string | null }; result: JournalHead[] };
  graphfile_read_journal: { args: { analysisId: string; revisionId: string }; result: RawFile | null };
  graphfile_write_journal: { args: WriteJournalArgs; result: null };
  graphfile_list_displaced: { args: Record<string, never>; result: DisplacedEntry[] };
  graphfile_read_displaced: { args: { id: string }; result: RawFile | null };

  appstate_device: { args: Record<string, never>; result: DeviceIdentity };
  appstate_set_device: { args: { patch: DevicePatch }; result: DeviceIdentity };
  appstate_read_session: { args: Record<string, never>; result: GraphSession };
  appstate_write_session: { args: { session: GraphSession }; result: null };
  appstate_read_draft: { args: { docKey: string }; result: DraftRecord | null };
  appstate_write_draft: { args: { draft: DraftRecord }; result: null };
  appstate_delete_draft: { args: { docKey: string }; result: null };
  appstate_list_drafts: { args: Record<string, never>; result: DraftRecord[] };
  appstate_read_recent: { args: Record<string, never>; result: RecentEntry[] };
  appstate_write_recent: { args: { entries: RecentEntry[] }; result: null };
  appstate_read_export_map: { args: Record<string, never>; result: ExportMap };
  appstate_write_export_map: { args: { map: ExportMap }; result: null };
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. FileBackend, phase 1 additions (implemented by tauriBackend.ts and MemoryDevice)
// ═════════════════════════════════════════════════════════════════════════════

/** FileEvent of backend.ts plus the phase 1 kinds. TS core widens
 *  backend.ts `FileEvent` to exactly this union. */
export type FileEventP1 = RustFileEvent | { type: "presence"; path: string };

export type LocateResult =
  | ({ ok: true } & LocateReply)
  | { ok: false; code: RustErrorKind; message: string };

export interface FileBackendP1 extends FileBackend {
  appInfo(): Promise<AppInfo>;
  setDevice(patch: DevicePatch): Promise<DeviceIdentity>;
  /** Find it…: bounded search of a folder for files with this analysis id. */
  locate(dir: string, analysisId: string, onProgress?: (p: LocateProgress) => void): { token: string; result: Promise<LocateResult> };
  cancelLocate(token: string): void;
  /** Check every tracked file now (window focus). */
  pollNow(): void;
  /** Show the file in Finder / Explorer. No-op in the preview. */
  reveal(path: string): Promise<void>;
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. The session controller (src/components/graph/file/session.ts → useFileSession)
// ═════════════════════════════════════════════════════════════════════════════

/** What the canvas shows for a tab.
 *  ready: the document is (or can be) loaded. opening: being read.
 *  waiting: missing under a cloud folder, retried silently (≤ waitCloudMs).
 *  downloading: online-only or still arriving. missing: not found — the card.
 *  permission: the OS blocks the folder. unreadable: not an analysis file / damaged. */
export type TabStatus = "ready" | "opening" | "waiting" | "downloading" | "missing" | "permission" | "unreadable";

/** Banner kinds, in display priority (first = most important; the UI shows
 *  `banners[0]`). Each kind's text and buttons are in the contract, §5. */
export const BANNER_ORDER = [
  "permission", "downloading", "missing", "replaced", "tooNew",
  "saveFailed", "notSaved", "savedAside", "savedOver", "savedDisplaced", "tookTheirs", "draftMismatch",
  "copyQuestion", "extraCopy", "tempLocation",
  "rolledBack", "newerOnDisk", "newerCopy", "olderCopy", "recovered",
] as const;
export type BannerKind = (typeof BANNER_ORDER)[number];

/** Buttons a banner can carry; the UI calls bannerAction(tabKey, banner.id, action). */
export type BannerAction =
  | "openPrivacy" | "retry" | "findIt" | "saveAs" | "choose" | "later" | "dismiss"
  | "openCopy" | "useEarlier" | "backToLatest" | "separate" | "same" | "notSame"
  | "updateMine" | "openThatOne" | "openAsNew" | "discardDraft" | "chooseLocation";

/** Who saved a version and when (from a revision). Times are shown as this
 *  computer sees them ("2 h ago", a date when older than a day). */
export interface VersionInfo {
  head: string;
  userName: string;
  deviceName: string;
  /** ISO time from the revision; display only. */
  time: string;
  /** Saved on this computer. */
  mine: boolean;
}

export interface TabBanner {
  /** Unique within the tab; stable while the condition lasts. */
  id: string;
  kind: BannerKind;
  /** Buttons, in display order. The first is the primary one. */
  actions: BannerAction[];
  /** Whether a close (×) button is shown; × calls dismissBanner. */
  dismissible: boolean;
  /** Kind-specific values for the text (see the wording table). All optional. */
  name?: string;            // a file name without extension (this file, or the copy the banner is about)
  path?: string;            // the other file the banner is about
  folderLabel?: string;     // "Dropbox › Lab"
  service?: string | null;  // "Dropbox", "OneDrive", "iCloud Drive", "Google Drive" or null
  version?: VersionInfo;    // the version on disk / in the other file
  relation?: "older" | "same" | "newer" | "diverged";
  candidates?: { path: string; name: string }[];
  when?: string;            // ISO time (drafts)
  message?: string;         // saveFailed: a plain sentence
}

export interface FileTab {
  /** doc_key. */
  key: string;
  /** File name without extension; "Untitled", "Untitled 2", … for unsaved documents. */
  title: string;
  path: string | null;
  /** "Dropbox › Lab"; "" for an untitled document. */
  folderLabel: string;
  analysisId: string | null;
  /** Head the tab's content is based on; null = never saved. */
  baseRevision: string | null;
  template: Template | null;
  /** Unsaved changes (for a background tab: a draft with changes exists). */
  dirty: boolean;
  status: TabStatus;
  /** Cloud service of the folder, for texts ("Waiting for Dropbox…"). */
  service: string | null;
  readOnly: "tooNew" | null;
  /** A save of this tab is running. */
  saving: boolean;
  /** A conflict is waiting for a choice (tab shows "Not saved"). */
  notSaved: boolean;
  /** Sorted by BANNER_ORDER. */
  banners: TabBanner[];
  /** banners[0] ?? null. */
  banner: TabBanner | null;
}

/** A session entry that could not be opened (startup or later). Shown in the
 *  canvas when its tab is active; the tab stays in the strip. */
export interface RestoreCard {
  /** Tab key. */
  key: string;
  kind: "waiting" | "downloading" | "missing" | "permission" | "unreadable";
  /** File name without extension. */
  name: string;
  path: string;
  folderLabel: string;
  service: string | null;
  /** The tab has a draft with unsaved changes (kept whatever is chosen). */
  hasDraft: boolean;
}

export type ConflictChoice =
  /** Save my version on top of theirs as the newest version; theirs stays in the history. */
  | "keepMine"
  /** Load their version; mine is saved beside the file as "<name> (my version from <computer>).lag". */
  | "takeTheirs"
  /** Save mine to a place I choose as a separate analysis; this file is left as it is on disk. */
  | "separateCopy"
  /** Close the sheet; nothing is written; the tab stays "Not saved". */
  | "cancel";

export interface ConflictInfo {
  tabKey: string;
  /** This file's name without extension. */
  name: string;
  /** The version found on disk. */
  theirs: VersionInfo;
  /** The head my changes are based on. */
  base: string | null;
  /** How the conflict was met. */
  origin: "save" | "banner";
}

export type SaveAsMode =
  /** Ask "new analysis or same analysis in a new place" after the place is picked. */
  | "ask"
  | "new"
  | "same";

export interface PathPickerRequest {
  mode: "open" | "save" | "folder";
  title: string;
  /** save: suggested file name with extension. */
  suggestedName: string | null;
  /** Folder to start in, or null. */
  startDir: string | null;
}

export interface FindState {
  tabKey: string;
  /** File name without extension. */
  name: string;
  phase: "scanning" | "results";
  dir: string;
  folderLabel: string;
  scanned: number;
  /** phase "results": */
  result: LocateResult | null;
}

export interface ExportState {
  phase: "confirm" | "running" | "done";
  /** Analyses in the old library. */
  total: number;
  /** Already exported earlier (skipped). */
  already: number;
  done: number;
  failed: { id: number; name: string; reason: string }[];
  dir: string | null;
  folderLabel: string;
}

/** A draft that no open tab owns (Recover unsaved work…). */
export interface DraftListItem {
  docKey: string;
  /** File name without extension, or "Untitled". */
  name: string;
  path: string | null;
  folderLabel: string;
  /** ISO. */
  savedAt: string;
}

/** The one modal the controller wants on screen (null = none). The path picker
 *  (preview only) is separate because it can sit on top of another dialog. */
export type SessionDialog =
  | { kind: "saveAsKind"; path: string; name: string; folderLabel: string; preselect: "new" | "same" }
  | { kind: "conflict"; info: ConflictInfo }
  | { kind: "closeDirty"; tabKey: string; title: string }
  | { kind: "quit"; dirty: { key: string; title: string }[] }
  | { kind: "settings" }
  | { kind: "find"; find: FindState }
  | { kind: "export"; state: ExportState }
  | { kind: "recover"; drafts: DraftListItem[] }
  | { kind: "oldLibrary" };

export type DialogAnswer =
  | { kind: "saveAsKind"; choice: "new" | "same" | "cancel" }
  | { kind: "closeDirty"; choice: "save" | "discard" | "cancel" }
  | { kind: "quit"; choice: "saveAll" | "keep" | "cancel" };

export interface SessionToast {
  id: number;
  tone: "info" | "success" | "warning" | "error";
  /** Which fixed text to show (see the wording table). */
  kind: "renamed" | "saved" | "reloaded" | "tabLimit" | "alreadyOpen" | "restoredDrafts" | "error";
  name?: string;
  version?: VersionInfo;
  count?: number;
  message?: string;
}

export interface RecentItem {
  path: string;
  /** File name without extension. */
  name: string;
  folderLabel: string;
  analysisId: string | null;
  /** ISO. */
  openedAt: string;
  /** Last check did not find the file. */
  missing: boolean;
  /** Already open in a tab. */
  open: boolean;
}

export interface FileSettings {
  userName: string;
  deviceName: string;
}

export type OpenOutcome =
  | { ok: true; key: string }
  /** cancelled: the picker was closed. limit: tabCap reached. failed: a card or toast says why. */
  | { ok: false; reason: "cancelled" | "limit" | "failed" };

export type SaveOutcome =
  | { ok: true; path: string }
  /** cancelled: a picker or question was closed. conflict: the conflict sheet is open.
   *  nothing: no document / nothing to do. failed: a banner says why. */
  | { ok: false; reason: "cancelled" | "conflict" | "nothing" | "failed" };

export interface FileSessionState {
  /** init() has finished restoring the last session. */
  ready: boolean;
  /** Running inside the desktop app (false = browser preview with the simulator). */
  desktop: boolean;
  tabs: FileTab[];
  /** null = the start screen is shown (tabs may still be open in the strip). */
  activeKey: string | null;
  /** Session entries that could not be opened, by tab key. */
  cards: RestoreCard[];
  recent: RecentItem[];
  dialog: SessionDialog | null;
  /** Browser preview only: the in-app path picker to show (null in the desktop app). */
  pathPicker: PathPickerRequest | null;
  toasts: SessionToast[];
  settings: FileSettings | null;
  /** Analyses in the old in-app library, and how many are not yet exported (null = not known yet). */
  oldLibrary: { total: number; unexported: number } | null;
  /** Bumped whenever the Graphs tool should come to the front (file opened from Finder, File menu). */
  focusSerial: number;
  /** Bumped when the About window should open (menu item "About Lab Analysis Suite"). */
  aboutSerial: number;
  /** A tab switch / open is running; the UI shows the canvas as busy and ignores tab clicks. */
  busy: boolean;

  // ── lifecycle ──
  /** Idempotent. Creates the backend, reads device / recent / session, restores tabs, takes pending opens, subscribes to events. */
  init(): Promise<void>;
  /** Flush scratchpad, drafts and session; with unsaved work and an interactive source, ask. Resolves true = quit may go on.
   *  "update" (before the updater's relaunch): flush only, never asks, resolves true. */
  quitRoutine(source: QuitSource | "update"): Promise<boolean>;

  // ── documents ──
  newDoc(template: Template, sample?: boolean): Promise<OpenOutcome>;
  /** No path: ask with the open dialog. Opening a path that is already open switches to its tab. */
  open(path?: string): Promise<OpenOutcome>;
  openRecent(path: string): Promise<OpenOutcome>;
  removeRecent(path: string): Promise<void>;
  /** The active tab unless a key is given. An untitled document goes to saveAs("new"). */
  save(key?: string): Promise<SaveOutcome>;
  /** Active tab. Default "ask". */
  saveAs(mode?: SaveAsMode): Promise<SaveOutcome>;
  /** Duplicate as a new analysis…: asks for a place, writes a new analysis there and opens it in a new tab. */
  duplicate(): Promise<SaveOutcome>;
  /** Active tab unless a key is given. Resolves false when the person cancelled. */
  closeTab(key?: string): Promise<boolean>;
  /** Flushes the active tab's draft, then loads the other. No-op when it is already active. */
  switchTab(key: string): Promise<void>;
  /** Show the start screen (tabs stay open). */
  showStart(): Promise<void>;
  /** Clean tab only: load the version on disk. Resolves false when the tab has unsaved changes or the file can't be read. */
  reloadFromDisk(key?: string): Promise<boolean>;
  reveal(key?: string): Promise<void>;

  // ── restore cards / find ──
  retry(key: string): Promise<void>;
  /** No dir: ask for a folder first. Opens the find dialog and searches. */
  findIt(key: string, dir?: string): Promise<void>;
  /** In the find dialog: use this match for the tab. */
  chooseFound(path: string): Promise<void>;
  cancelFind(): void;
  /** "Remove from this list (the file was deleted)": closes the tab, keeps its draft and its Recent entry (marked missing). */
  forget(key: string): Promise<void>;

  // ── banners / conflict ──
  bannerAction(key: string, bannerId: string, action: BannerAction): Promise<void>;
  dismissBanner(key: string, bannerId: string): void;
  resolveConflict(choice: ConflictChoice): Promise<void>;

  // ── dialogs ──
  answerDialog(answer: DialogAnswer): void;
  /** Close a dialog that has no question (settings, recover, oldLibrary, export when not running, find). */
  closeDialog(): void;
  /** Preview path picker: the chosen absolute path, or null = cancelled. */
  answerPathPicker(path: string | null): void;
  dismissToast(id: number): void;
  openSettings(): void;
  setSettings(patch: Partial<FileSettings>): Promise<void>;
  openPrivacySettings(): Promise<void>;

  // ── drafts ──
  openRecover(): Promise<void>;
  /** Open a listed draft in a tab (as unsaved changes on its file, or as an untitled document). */
  recoverDraft(docKey: string): Promise<OpenOutcome>;
  deleteDraft(docKey: string): Promise<void>;

  // ── old library ──
  openOldLibrary(): void;
  /** Open an analysis of the old library as a new untitled document (the library is not changed). */
  importLibraryRow(id: number): Promise<OpenOutcome>;
  /** Opens the export dialog (phase "confirm"). */
  openExport(): Promise<void>;
  /** Runs the export into `dir` (no dir: ask for a folder). Re-running exports only what is missing or failed. */
  exportLibrary(dir?: string): Promise<void>;

  // ── menu ──
  /** What EVT.menu does; also used by the in-window File menu button. */
  menu(id: MenuId, path?: string | null): Promise<void>;
}

// ═════════════════════════════════════════════════════════════════════════════
// 5. Browser preview: the simulator ("the other computer")
// ═════════════════════════════════════════════════════════════════════════════

export interface SimFile {
  path: string;
  name: string;
  folder: string;
  analysisId: string | null;
  head: string | null;
  /** Online-only placeholder. */
  dataless: boolean;
  incomplete: boolean;
}

/** file/devSim.ts → `devSim()` returns this in the preview (import.meta.env.DEV
 *  and not Tauri), else null. Also on `window.__lasSim`. Every method acts as
 *  the other computer / Finder / the sync service would; the app only learns
 *  about it through its normal poll. Methods resolve once the change has
 *  reached this computer's simulated disk. */
export interface DevSimApi {
  /** Names of the two simulated computers. */
  thisDevice: string;
  otherDevice: string;
  /** Folders that exist on this computer (for the path picker), sorted. */
  folders(): string[];
  /** Every file on this computer, sorted by path. */
  files(): SimFile[];
  /** Subscribe to any change of the simulated disk. */
  subscribe(listener: () => void): () => void;

  /** The other computer opens the file, changes one value and saves. Resolves with the new head. */
  remoteEdit(path: string, opts?: { userName?: string; section?: "table" | "figure" }): Promise<string>;
  /** The other computer saves from the version BEFORE this computer's last save: the service
   *  keeps this computer's file and adds "<name> (<other>'s conflicted copy <date>).lag". Resolves with the copy's path. */
  remoteConflictCopy(path: string): Promise<string>;
  /** The other computer's save silently replaces this computer's last save (iCloud-style). Resolves with the new head. */
  remoteReplace(path: string): Promise<string>;
  /** The file is put back to its previous version (cloud version history). Resolves with that head, null when there is none. */
  rollback(path: string): Promise<string | null>;
  /** Rename in the same folder (sync style: delete, then create). */
  rename(path: string, newName: string): Promise<string>;
  /** Move to another folder. */
  move(path: string, toFolder: string): Promise<string>;
  remove(path: string): Promise<void>;
  /** Finder duplicate: same analysis id, new name, same folder. */
  duplicateInFinder(path: string, newName: string): Promise<string>;
  /** "Sent to a colleague, edited, sent back": a copy with one more version appears in `toFolder`. Resolves with its path. */
  sendBack(path: string, toFolder: string, userName?: string): Promise<string>;
  /** A different analysis is written at this path. */
  replaceWithOther(path: string): Promise<void>;
  setOnlineOnly(path: string, on: boolean): void;
  /** The file reads as still arriving for `ms`. */
  setIncomplete(path: string, ms: number): void;
  /** The OS blocks this folder: reads, listings and writes fail with PermissionDenied. */
  setPermissionDenied(folder: string, on: boolean): void;
  /** The next save of this path finds another computer's save landed in the gap (savedButDisplaced). */
  armSaveRace(path: string): void;
  /** The next save of this path cannot establish the head on disk (savedAside). */
  armOffline(path: string): void;
  /** Jump simulated time forward (polls and confirm timers run). */
  advance(ms: number): void;
  /** Forget every simulated file and record, then reload the page. */
  reset(): void;
}
