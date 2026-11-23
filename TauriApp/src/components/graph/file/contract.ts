/* Phase 1 contract ("Graphs analyses saved as files"): the boundary between the
   Rust shell, the TypeScript file core and the files UI. Types and string /
   number constants only — no runtime logic. The prose contract
   (phase1-contract.md) explains every item; where the two differ, this file
   wins for TypeScript shapes.

   Naming rule on the wire: command ARGUMENT names and the envelope types
   defined here are camelCase. The stored records of phase 0 (Manifest,
   FileHeader, GraphSession, DraftRecord, JournalHead, DisplacedEntry,
   RecentEntry, ExportMap, DeviceIdentity) keep their snake_case field names and
   pass through Rust unchanged.

   Phase 2 ("Versions and combining", phase2-contract.md) is section 6 at the
   end, plus the members marked "Phase 2" in the unions and constants above.

   Phase 3 ("Check-out": read-only on the other computers while one is editing,
   phase3-contract.md) is section 7 at the end, plus the members marked
   "Phase 3" above. */

import type { Template } from "../../../api/graph";
import type {
  DeviceIdentity, DirEntry, DisplacedEntry, DraftRecord, ExportMap, FileBackend, FileErrorCode, FileStat, GraphSession,
  JournalHead, RecentEntry,
} from "./backend";
import type { FileHeader, GraphFileData, Manifest, PartRef, Revision, RevisionKind, SectionName } from "./format";
import type { DocContent } from "../../../store/graphStore";
import type { FileError } from "./backend";

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

  // Phase 2 (versions and combining; phase2-contract.md §4)
  peek: "graphfile_peek",
  removeCopy: "graphfile_remove_copy",
  readSeen: "appstate_read_seen",
  writeSeen: "appstate_write_seen",

  // Phase 3 (who is editing; phase3-contract.md §3)
  presenceSet: "presence_set",
  presenceClear: "presence_clear",
  presenceInput: "presence_input",
  presenceList: "presence_list",
  presenceRemoveForeign: "presence_remove_foreign",
  cloudInfo: "graphfile_cloud_info",
  newDeviceId: "appstate_new_device_id",
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
  /** Phase 2: open / close the Versions panel of the active tab. Enabled with MenuState.hasDoc. */
  versions: "file.versions",
  /** Phase 3: "Show Others When I'm Editing…" for the active tab. Enabled with MenuState.hasDoc. */
  sharing: "file.sharing",
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

  // Phase 2
  graphfile_peek: { args: { path: string }; result: PeekReply };
  graphfile_remove_copy: { args: { req: RemoveCopyArgs }; result: RemoveCopyReply };
  appstate_read_seen: { args: Record<string, never>; result: SeenMap };
  appstate_write_seen: { args: { seen: SeenMap }; result: null };

  // Phase 3
  presence_set: { args: { req: PresenceSetArgs }; result: PresenceSetReply };
  presence_clear: { args: { docPath: string }; result: null };
  presence_input: { args: { docPath: string }; result: null };
  presence_list: { args: { docPath: string; analysisId: string }; result: PresenceListReply };
  presence_remove_foreign: { args: { req: RemoveNoteArgs }; result: RemoveNoteReply };
  graphfile_cloud_info: { args: { path: string }; result: CloudInfo };
  appstate_new_device_id: { args: Record<string, never>; result: DeviceIdentity };
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
  // Phase 3 ("who is editing"): after the extra-copy group, before newer / older version.
  "resuming", "continuedElsewhere", "bothEditing", "waitingNewer", "editingElsewhere",
  // Phase 2: "combined" is a note with Undo; it ranks below every banner that asks for a choice.
  "rolledBack", "newerOnDisk", "newerCopy", "combined", "olderCopy", "recovered",
  // Phase 3: information only, below everything else.
  "editingInfo", "unconfirmed", "olderPeer",
] as const;
export type BannerKind = (typeof BANNER_ORDER)[number];

/** Buttons a banner can carry; the UI calls bannerAction(tabKey, banner.id, action). */
export type BannerAction =
  | "openPrivacy" | "retry" | "findIt" | "saveAs" | "choose" | "later" | "dismiss"
  | "openCopy" | "useEarlier" | "backToLatest" | "separate" | "same" | "notSame"
  | "updateMine" | "openThatOne" | "openAsNew" | "discardDraft" | "chooseLocation"
  /** Phase 2. combine: start combining (newerOnDisk, savedOver, extraCopy). remove / keep: an older extra copy.
   *  whatChanged / undo: on the "combined" banner. */
  | "combine" | "remove" | "keep" | "whatChanged" | "undo"
  /** Phase 3. editHere: edit on this computer now (my own other computer is editing, or a note that went quiet).
   *  editAnyway: the same over someone else's editing — asks first (dialog "editAnyway").
   *  keepEditing: close the "also being edited" / "continued elsewhere" banner, or end the after-sleep check now.
   *  saveCopy: "Save my changes as a separate copy…" (my version becomes a new analysis in a place I choose). */
  | "editHere" | "editAnyway" | "keepEditing" | "saveCopy";

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
  /** Phase 2, savedOver only. "combining": both versions are being combined automatically (no buttons).
   *  "choose": they could not be combined without a choice (button `combine`). Absent = the phase 1
   *  meaning (my version was saved as a copy: `name` / `path`). */
  state?: "combining" | "choose";
  /** Phase 2, combined only: the sections taken from the other version. */
  sections?: SectionName[];
  /** Phase 3: who the banner is about (kinds resuming, continuedElsewhere, bothEditing, waitingNewer,
   *  editingElsewhere, editingInfo, olderPeer), most relevant first. */
  peers?: PeerView[];
  /** Phase 3, editingElsewhere only: this computer is still checking the notes after waking up
   *  ("Checking who is editing…"; no buttons). */
  checking?: boolean;
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
  /** Phase 2: an automatic combine is waiting or being written for this tab. */
  combining?: boolean;
  /** Phase 2: newer content is waiting to be shown (held back while a cell is being typed in, a
   *  drag, a menu or an export is active). The UI veils the graph with "Updating…". */
  updating?: boolean;
  /** Phase 3: who is editing, and whether this tab is read-only because of it. Absent = "editable", nobody else. */
  presence?: TabPresence;
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
  | { kind: "oldLibrary" }
  /** Phase 2: the combine dialog. Nothing is written until applyCombine(). */
  | { kind: "combine"; state: CombineState }
  /** Phase 2: "Bring this version back" / "Undo" on a tab with unsaved changes. */
  | { kind: "bringBackDirty"; tabKey: string; title: string; version: VersionInfo }
  /** Phase 3: "Edit anyway…" over someone else's editing. */
  | { kind: "editAnyway"; tabKey: string; title: string; peers: PeerView[] }
  /** Phase 3: Save, or the first new edit, in the 45 s after this computer woke up while it was editing. */
  | { kind: "resumeConfirm"; tabKey: string; title: string; what: "save" | "edit" }
  /** Phase 3: "Show others when I'm editing this file". */
  | { kind: "sharing"; tabKey: string; title: string; sharing: SharingView };

export type DialogAnswer =
  | { kind: "saveAsKind"; choice: "new" | "same" | "cancel" }
  | { kind: "closeDirty"; choice: "save" | "discard" | "cancel" }
  | { kind: "quit"; choice: "saveAll" | "keep" | "cancel" }
  /** Phase 2. saveFirst: save my changes as a version, then bring the chosen version back. */
  | { kind: "bringBackDirty"; choice: "saveFirst" | "cancel" }
  /** Phase 3. */
  | { kind: "editAnyway"; choice: "edit" | "cancel" }
  /** go: save / keep editing now. wait: close the dialog, nothing happens (the check goes on). */
  | { kind: "resumeConfirm"; choice: "go" | "wait" };

export interface SessionToast {
  id: number;
  tone: "info" | "success" | "warning" | "error";
  /** Which fixed text to show (see the wording table). */
  kind: "renamed" | "saved" | "reloaded" | "tabLimit" | "alreadyOpen" | "restoredDrafts" | "error"
    /** Phase 2. combined: `version` = the other side. broughtBack: `version` = the version brought back.
     *  copyRemoved: `name` = the copy's file name without extension. savedAsNew: `name` = the new file. */
    | "combined" | "broughtBack" | "copyRemoved" | "savedAsNew"
    /** Phase 3. deviceIdChanged: this computer shared its identity with another one and got a new one. */
    | "deviceIdChanged";
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
  /** Phase 3: "Show others when I'm editing" for files without a choice of their own. Absent = "auto". */
  shareDefault?: ShareMode;
}

export type OpenOutcome =
  | { ok: true; key: string }
  /** cancelled: the picker was closed. limit: tabCap reached. failed: a card or toast says why. */
  | { ok: false; reason: "cancelled" | "limit" | "failed" };

export type SaveOutcome =
  | { ok: true; path: string }
  /** cancelled: a picker or question was closed. conflict: the conflict sheet is open.
   *  nothing: no document / nothing to do. failed: a banner says why.
   *  Phase 3 — readOnly: the tab is read-only (another computer is editing, or a newer version is loading);
   *  nothing was written and the banner's button was pulsed. */
  | { ok: false; reason: "cancelled" | "conflict" | "nothing" | "failed" | "readOnly" };

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

// ═════════════════════════════════════════════════════════════════════════════
// 6. Phase 2 — versions and combining (docs/design/analysis-files-phase2-contract.md)
//
// Additive. Phase 1 names keep their meaning; the unions above gained members
// that are marked "Phase 2". The controller's store becomes FileSessionStateP2
// (a pure extension of FileSessionState), the backend FileBackendP2, the
// simulator DevSimApiP2.
// ═════════════════════════════════════════════════════════════════════════════

/** Numbers of phase 2. Times in ms. */
export const LIMITS_P2 = {
  /** The newest versions that keep their full content in the file (decision D4). */
  snapshotsKept: 20,
  /** A version where work passed to another computer keeps its content this long after this computer first saw it. */
  handoverKeepMs: 180 * 24 * 3600 * 1000,
  /** An automatic combine nobody asked for waits between these two, by device id, before it is written. */
  combineDelayMinMs: 2000,
  combineDelayMaxMs: 10000,
  /** Removed extra copies are kept this long in the app's own folder. */
  removedKeepMs: 30 * 24 * 3600 * 1000,
  /** Newest saved copies of this computer that are read when looking for a common version. */
  baseScanCopies: 10,
  /** Files of the folder looked at for separated analyses when the Versions panel opens. */
  branchScanFiles: 50,
  /** The first-seen record is written this long after the last change. */
  seenDebounceMs: 2000,
  /** Version ids remembered per analysis in the first-seen record (oldest dropped first). */
  seenPerAnalysis: 5000,
  /** CompareResult: most changed cells / settings listed. */
  compareCells: 200,
  compareSettings: 50,
  /** A held-back replaceContent is retried this often. */
  replaceRetryMs: 500,
} as const;

/** Text stored in Revision.summary by phase 2 (display only, English, no full stop). */
export const SUMMARY = {
  first: "First version",
  saved: "Saved",
  noChanges: "No changes",
  /** "Changed " + sectionList(changed sections). */
  changedPrefix: "Changed ",
  combinedAuto: "Combined changes from two computers",
  combinedChosen: "Combined two versions",
  broughtBack: "Brought back an earlier version",
  imported: "From the old library",
  separated: "Made a separate analysis",
} as const;

/** How a section is called inside a sentence ("Changed the table and the graph"). Fixed order: SECTION_NAMES. */
export const SECTION_PHRASE: Record<SectionName, string> = {
  table: "the table",
  analysis: "the analysis settings",
  figure: "the graph",
  scratchpad: "the scratchpad",
};

// ── 6.1 What phase 2 adds to a stored version ───────────────────────────────

/** A revision as phase 2 writes it. Every added field is optional, so phase 1
 *  files and phase 1 apps are unaffected (phase 1 carries unknown fields of a
 *  revision along unchanged). `kind`: "save" = saved; "merge" = combined (two
 *  parents); "restore" = brought back; "import" = from the old library. */
export interface RevisionP2 extends Revision {
  /** kind "restore": the version whose content this one has again. */
  restored_from?: string;
  /** kind "merge": combined without anyone choosing. Such a revision carries no
   *  device-specific content: user_name, device_id, device_name, session_id and
   *  app_version are "", `time` is the later of its two parents' `time` strings,
   *  `parents` are sorted, `summary` is SUMMARY.combinedAuto. */
  auto?: true;
  /** kind "merge": for every section that differed between the two parents, the
   *  parent revision id whose section the result has. */
  sections_from?: Partial<Record<SectionName, string>>;
}

/** graph-seen.json in the app's own folder: when THIS computer first saw each
 *  version (its own clock, ms). Retention uses it; a version's own `time` is
 *  never used. Stored by Rust as it is given. */
export interface SeenMap {
  v: 1;
  /** analysis id → revision id → first seen. */
  analyses: Record<string, Record<string, number>>;
}
export const emptySeenMap = (): SeenMap => ({ v: 1, analyses: {} });

// ── 6.2 Rust commands added in phase 2 ──────────────────────────────────────

/** graphfile_peek { path } → a file's manifest after the full validation of a
 *  read, without its parts, without journaling and without touching any track. */
export interface PeekReply {
  manifestText: string;
  stat: FileStat;
  readOnly: "tooNew" | null;
}

/** graphfile_remove_copy { req } */
export interface RemoveCopyArgs {
  /** The extra copy to move into the app's own folder. */
  path: string;
  /** Another file of the same analysis that stays. */
  keeper: string;
  analysisId: string;
}

/** Why a copy was not removed. notOlder: its newest version is not in the keeper's
 *  history (it has changes of its own). otherAnalysis: one of the two is not this
 *  analysis. sameFile: both paths are one file. open: the copy is a tracked (open) file. */
export type RemoveRefusal = "notOlder" | "otherAnalysis" | "sameFile" | "open";

/** graphfile_remove_copy → (unreadable / missing files reject with RustError). */
export type RemoveCopyReply =
  | { kind: "removed"; displacedId: string; head: string }
  | { kind: "refused"; reason: RemoveRefusal; head: string | null; keeperHead: string | null };

// ── 6.3 FileBackend, phase 2 additions ──────────────────────────────────────

export type PeekResult =
  | { ok: true; manifest: Manifest; stat: FileStat; readOnly: "tooNew" | null }
  | FileError;

export type RemoveCopyResult =
  | { ok: true; kind: "removed"; displacedId: string; head: string }
  | { ok: false; kind: "refused"; reason: RemoveRefusal; head: string | null; keeperHead: string | null }
  | (FileError & { kind: "error" });

export interface FileBackendP2 extends FileBackendP1 {
  /** A file's manifest, validated, without its parts. Never journals. */
  peek(path: string): Promise<PeekResult>;
  /** Move an extra copy into the app's own folder (kept LIMITS_P2.removedKeepMs). The backend re-reads
   *  both files immediately before and refuses unless the copy's newest version is the keeper's newest
   *  version or one of its ancestors. */
  removeCopy(req: RemoveCopyArgs): Promise<RemoveCopyResult>;
  readSeen(): Promise<SeenMap>;
  writeSeen(seen: SeenMap): Promise<void>;
}

// ── 6.4 Pure modules (file/revisions.ts, retention.ts, graphMerge.ts, summaries.ts, laneGraph.ts) ──
// Each module exports functions with exactly these names and types (checked in the
// module with `satisfies`). No I/O, no clock, no randomness; async only for hashing.

export type HeadRelation = "same" | "older" | "newer" | "diverged";

/** Which common version a combine compares against.
 *  lca: the one lowest common ancestor, and its content is available.
 *  ambiguous: there are several lowest common ancestors (both sides combined before, differently); `id` = the smallest id among those with content.
 *  nearest: the lowest common ancestor's content is gone; `id` = the lowest common ancestor that still has content.
 *  none: no common version with content → two-way.
 *  notDiverged: one head is the other or its ancestor; there is nothing to combine. */
export type BaseChoice =
  | { kind: "lca" | "ambiguous" | "nearest"; id: string }
  | { kind: "none" }
  | { kind: "notDiverged"; relation: "same" | "older" | "newer" };
export type BaseKind = "lca" | "ambiguous" | "nearest" | "none";

/** The four sections of one version, parsed, in file form. */
export type SectionValues = Record<SectionName, unknown>;

/** Every stored version content of some files, by revision id. */
export interface SnapshotPool {
  has(revisionId: string): boolean;
  get(revisionId: string): SectionValues | null;
}

export interface RevisionsApi {
  /** All revisions of the manifests by id. A revision with stored content wins over the same one without; order = first appearance. */
  unionRevisions(...manifests: readonly Pick<Manifest, "revisions">[]): Revision[];
  /** Strict: `ancestor` !== `rev` and reachable from `rev` through parents. Unknown ids → false. */
  isAncestor(revs: readonly Revision[], ancestor: string, rev: string): boolean;
  isAncestorOrSelf(revs: readonly Revision[], ancestor: string, rev: string): boolean;
  /** How `other` relates to `mine`: "newer" = `mine` is a strict ancestor of `other`. */
  relation(revs: readonly Revision[], mine: string, other: string): HeadRelation;
  /** The lowest common ancestors of two revisions (common ancestors-or-self that are no ancestor of another one), sorted by id. */
  lowestCommonAncestors(revs: readonly Revision[], a: string, b: string): string[];
  /** The contract's base rule (§3.2). `stored(id)` says whether that version's content can be had. */
  findBase(revs: readonly Revision[], mine: string, theirs: string, stored: (revisionId: string) => boolean): BaseChoice;
  /** Revisions nobody names as a parent, sorted by id. */
  tips(revs: readonly Revision[]): string[];
  /** Every revision before its parents; among those that may come next, the larger `key` first, then the larger id. */
  newestFirst(revs: readonly Revision[], key: (r: Revision) => number): Revision[];
  /** Stored contents of the files (a revision counts when `sections` is set and all four parts are in that file and parse). */
  snapshotPool(files: readonly GraphFileData[]): SnapshotPool;
  /** Which of several files of one analysis stays: the shortest file name, ties by plain string order; the same on every computer. */
  survivorPath(paths: readonly string[]): string;
}

export interface RetentionCtx {
  /** This computer's clock. */
  now: number;
  /** SeenMap.analyses[analysis id] (a missing id counts as seen now). */
  firstSeen: Readonly<Record<string, number>>;
  /** Heads this computer's saved copies hold that no later version on disk confirmed yet. */
  unconfirmedHeads: readonly string[];
  /** Heads other computers say they have open. Always [] in phase 2. */
  beaconHeads: readonly string[];
  /** More versions to keep (the versions being combined, a version being brought back). */
  pinned?: readonly string[];
}

export interface RetentionApi {
  /** Ids of the versions whose content stays (§3.3). */
  keptSnapshots(m: Manifest, ctx: RetentionCtx): Set<string>;
  /** `m` with `sections: null` on every other version. Entries are never removed; a version without content never gets it back. Returns `m` itself when nothing changes. */
  applyRetention(m: Manifest, ctx: RetentionCtx): Manifest;
}

/** One side of a combine after the load pipeline. */
export interface NormalisedSide {
  content: DocContent;
  sections: import("./docCodec").FileSections4;
  parts: import("./docCodec").BuiltParts;
}

/** same: both sides have the same section. mine / theirs: only that side changed it since the common version.
 *  both: both changed it, differently (two-way: it differs). */
export type SectionStatus = "same" | "mine" | "theirs" | "both";
export type SidePick = "mine" | "theirs";

export interface CombineSection {
  key: SectionName;
  status: SectionStatus;
  /** What the result takes without a choice: "mine" for same / mine, "theirs" for theirs, null for both. */
  pick: SidePick | null;
  /** status !== "both". */
  autoResolvable: boolean;
}

export interface CombineResult {
  /** The combined document after the load pipeline. */
  content: DocContent;
  sections: import("./docCodec").FileSections4;
  parts: import("./docCodec").BuiltParts;
  /** Where each section came from. */
  from: Record<SectionName, SidePick | "same">;
  /** Sections the load pipeline changed after they were put together ("adjusted automatically"). */
  repairs: SectionName[];
}

export interface CombinePlan {
  ok: true;
  /** No common version: every differing section is "both". */
  twoWay: boolean;
  baseKind: BaseKind;
  /** In SECTION_NAMES order. */
  sections: CombineSection[];
  /** A section is "both". */
  needsChoice: boolean;
  /** May be applied without showing anything: baseKind "lca", no "both", no repairs. */
  autoApplicable: boolean;
  /** Set when needsChoice is false. */
  result: CombineResult | null;
  mine: NormalisedSide;
  theirs: NormalisedSide;
  base: NormalisedSide | null;
}

export type CombineOutcome = CombinePlan | { ok: false; reason: "unreadable"; side: "mine" | "theirs" };

export interface GraphMergeApi {
  /** migrate → defaults → normalise → id map, then back to file form and hashed. null: not a Graphs document. */
  normaliseSections(raw: SectionValues): Promise<NormalisedSide | null>;
  /** §3.4. A base that does not normalise counts as no base (two-way). */
  combine(input: { base: SectionValues | null; baseKind: BaseKind; mine: SectionValues; theirs: SectionValues }): Promise<CombineOutcome>;
  /** The result for these choices ("both" sections need one; choices for other sections override the pick). null: a choice is missing or the result is not a Graphs document. */
  applyChoices(plan: CombinePlan, choices: Partial<Record<SectionName, SidePick>>): Promise<CombineResult | null>;
  /** The two-parent revision of a combine. Its id is mergeRevisionId(parents, content hash) (docCodec.ts) either way.
   *  auto: the deterministic form of RevisionP2.auto (author / time ignored). Else author and time as given, summary SUMMARY.combinedChosen. */
  combineRevision(p: {
    mine: Revision; theirs: Revision; result: CombineResult; auto: boolean;
    author?: import("./docCodec").Author; time?: number;
  }): Promise<RevisionP2>;
  /** LIMITS_P2.combineDelayMinMs + (first 8 hex digits of sha256(device id) as a number) mod (max − min + 1). */
  combineDelayMs(deviceId: string): Promise<number>;
}

/** What differs between two versions, for "Compare with current" and the combine dialog. */
export interface CompareResult {
  /** In SECTION_NAMES order. */
  sections: { key: SectionName; same: boolean }[];
  table: {
    /** Cells (row id, column id, replicate) present in both whose text differs. */
    changedCells: number;
    addedRows: number; removedRows: number; addedCols: number; removedCols: number;
    /** Row / column titles and X values that differ. */
    changedTitles: number;
    /** The first LIMITS_P2.compareCells changed cells, in table order of `b`. `a` / `b` = the cell text. */
    cells: { rowId: string; colId: string; rep: number; a: string; b: string }[];
  };
  /** Analysis and graph settings that differ (top-level fields; values as short text), at most LIMITS_P2.compareSettings. */
  settings: { section: "analysis" | "figure"; field: string; a: string; b: string }[];
  /** Scratchpad cells that differ (0 when the scratchpad is the same). */
  scratchpadCells: number;
}

export interface SummariesApi {
  /** Sections whose stored hash differs, in SECTION_NAMES order. */
  changedSections(prev: Record<SectionName, PartRef>, next: Record<SectionName, PartRef>): SectionName[];
  /** "the table" · "the table and the graph" · "the table, the analysis settings and the graph". */
  sectionList(keys: readonly SectionName[]): string;
  /** The text to store in Revision.summary (§3.5). `prev` = the first parent's sections when known. */
  summaryText(p: {
    kind: RevisionKind; root: boolean; auto?: boolean;
    prev: Record<SectionName, PartRef> | null | undefined; next: Record<SectionName, PartRef>;
  }): string;
  /** The text a Versions row shows: worked out from the two versions when both have content, else the stored summary without a trailing full stop, else SUMMARY.saved. */
  displaySummary(rev: Revision, firstParent: Revision | null): string;
  /** `a` = the older / other version, `b` = the current one. */
  compareSections(a: import("./docCodec").FileSections4, b: import("./docCodec").FileSections4): CompareResult;
}

export interface LaneNode {
  id: string;
  parents: string[];
  /** Revision.time (ISO); ordering of rows only. */
  time: string;
  /** "" for a version combined automatically. */
  deviceId: string;
  /** Only in an extra copy, not in this file's history: drawn dashed. */
  foreign?: boolean;
}

export interface LaneRow {
  id: string;
  /** 0 = top (newest). */
  row: number;
  /** 0 = the line of the file's current version. */
  lane: number;
  /** Index into LaneLayout.devices, -1 for deviceId "". */
  colorIndex: number;
}

/** A line from a version (`from`, the child, higher up) to one of its parents (`to`).
 *  Same lane: straight. Different lanes: vertical in lane max(fromLane, toLane), with a bend at the end that is in the other lane. */
export interface LaneEdge {
  from: string;
  to: string;
  fromRow: number;
  toRow: number;
  fromLane: number;
  toLane: number;
  /** `from` is foreign. */
  dashed: boolean;
  /** The colour of `from`'s lane end: colorIndex of the row that is NOT in lane 0 when the lanes differ, else `from`'s. */
  colorIndex: number;
}

export interface LaneLayout {
  /** In row order. */
  rows: LaneRow[];
  edges: LaneEdge[];
  laneCount: number;
  /** Device ids in the order they first appear, oldest version first ("" left out). */
  devices: string[];
}

export interface LaneGraphApi {
  /** §3.6. `head` = the file's current version (its first-parent line is lane 0); null: the newest row's line. */
  layoutLanes(nodes: readonly LaneNode[], head: string | null): LaneLayout;
}

// ── 6.5 The Versions panel (state the controller hands the UI) ──────────────

export type VersionChip = "current" | "combined" | "broughtBack" | "fromOldLibrary" | "tooOld" | "unsaved";

/** Id of the row for the tab's unsaved changes (shown only when there are any). */
export const WORKING_ROW = "working";

export interface VersionRow {
  /** Revision id, or WORKING_ROW. */
  id: string;
  kind: RevisionKind | "working";
  /** Ready to show ("Changed the table"; "Unsaved changes" for the working row). */
  summary: string;
  /** Who saved it; null for the working row and for a version combined automatically. */
  who: VersionInfo | null;
  /** In display order. */
  chips: VersionChip[];
  /** Its content can be shown, brought back and saved as a new analysis. */
  openable: boolean;
  /** Only in an extra copy of this analysis (not in this file's history). */
  foreign: boolean;
  /** Set on the newest version of an extra copy: that copy's file name without extension, and its path. */
  copyName: string | null;
  copyPath: string | null;
  /** kind "restore": the id of the version it brought back (null when unknown). */
  restoredFrom: string | null;
}

/** A separated analysis (its own file, made from this one): a dashed stub at the version it started from. */
export interface VersionStub {
  /** Row id it leaves from. */
  from: string;
  /** File name without extension. */
  name: string;
  path: string;
}

export interface VersionPreview {
  id: string;
  loading: boolean;
  /** The version's document; null while loading or when it can't be opened. */
  content: DocContent | null;
  /** What differs from the tab's current content (set while "Compare with current" is on). */
  compare: CompareResult | null;
  /** The tab's current content, for the side-by-side view (set together with `compare`). */
  current: DocContent | null;
}

export interface VersionsState {
  tabKey: string;
  /** File name without extension. */
  name: string;
  /** The list is being put together (rows may be empty). */
  loading: boolean;
  /** Newest first; rows[i] belongs to layout.rows[i]. */
  rows: VersionRow[];
  layout: LaneLayout;
  /** layout.devices with names, for the legend. `mine`: this computer. */
  devices: { deviceId: string; deviceName: string; mine: boolean }[];
  stubs: VersionStub[];
  /** Rows that can no longer be opened (> 0 → the footer line is shown). */
  tooOld: number;
  selectedId: string | null;
  preview: VersionPreview | null;
  /** "Compare with current" is on. */
  comparing: boolean;
  /** An action of the panel is running. */
  busy: "bringBack" | "saveAsNew" | null;
}

// ── 6.6 Combining (state of the dialog) ─────────────────────────────────────

/** What the tab's content is combined with. disk: the version now in the file.
 *  copy: an extra copy in the folder. journal: a version this computer saved (or loaded) that another computer's save replaced. */
export type CombineSource =
  | { kind: "disk" }
  | { kind: "copy"; path: string }
  | { kind: "journal"; revisionId: string };

export interface CombineSectionView {
  key: SectionName;
  status: SectionStatus;
  /** What will be kept. Preset for same / mine / theirs; null for "both" until the person chooses. */
  choice: SidePick | null;
}

export interface CombineState {
  tabKey: string;
  /** This file's name without extension. */
  name: string;
  /** How the dialog was reached. */
  origin: "save" | "banner" | "poll";
  source: CombineSource;
  /** source "copy": the copy's file name without extension. */
  copyName: string | null;
  /** "Copy 2 of 3": 1-based position and total when several copies are combined one after another (total 1 otherwise). */
  index: number;
  total: number;
  /** My side. `mineUnsaved`: it includes unsaved changes. */
  mine: VersionInfo;
  mineUnsaved: boolean;
  theirs: VersionInfo;
  /** The version both started from; null = none can be compared (two-way wording). */
  since: VersionInfo | null;
  twoWay: boolean;
  /** In SECTION_NAMES order. */
  sections: CombineSectionView[];
  /** Sections that will be adjusted automatically with the current choices. */
  adjusted: SectionName[];
  /** Every "both" section has a choice. */
  canApply: boolean;
  applying: boolean;
  /** Both documents, for the side-by-side pane. */
  mineContent: DocContent;
  theirsContent: DocContent;
  /** theirs (a) against mine (b). */
  compare: CompareResult;
  /** A plain sentence when Apply failed (nothing was written), else null. */
  error: string | null;
}

// ── 6.7 The session controller, phase 2 ─────────────────────────────────────

export interface FileSessionStateP2 extends FileSessionState {
  /** The Versions panel of the active tab; null = closed. Closed by a tab switch. */
  versions: VersionsState | null;

  // ── versions ──
  /** Opens the panel for the active tab (or `key`, switching to it). No-op for an untitled document. */
  openVersions(key?: string): Promise<void>;
  closeVersions(): void;
  /** Select a row (null = none): loads its read-only preview. */
  selectVersion(id: string | null): Promise<void>;
  /** Turn "Compare with current" on / off for the selected row (default: toggle). */
  compareWithCurrent(on?: boolean): Promise<void>;
  /** A new version with that version's content on top of the current one (history is never rewritten). */
  bringBack(id: string): Promise<SaveOutcome>;
  /** Asks for a place, writes that version as a new analysis there and opens it in a new tab. */
  saveVersionAsNew(id: string): Promise<OpenOutcome>;

  // ── combining ──
  /** Combine the tab's content with `source`. Applies at once when nothing needs a choice, else opens the dialog. */
  startCombine(key: string, source: CombineSource): Promise<void>;
  /** In the dialog. */
  setSectionChoice(section: SectionName, choice: SidePick): Promise<void>;
  /** Writes the combined version; closes the dialog on success (then the next copy, if several). */
  applyCombine(): Promise<SaveOutcome>;
  /** Closes the dialog; nothing is written. */
  cancelCombine(): void;
  /** Leaves the other version where it is and saves mine as a separate analysis (a place is asked for when mine has no file of its own). */
  keepBothAsSeparate(): Promise<void>;
  /** "Undo" on the combined banner: bring my version from before the combine back. */
  undoCombine(key: string): Promise<SaveOutcome>;
  /** "What changed" on the combined banner: opens Versions with the combined version selected and compare on. */
  showWhatChanged(key: string): Promise<void>;

  // ── extra copies ──
  /** "Remove it": moves an older copy into the app's own folder. false: it was not removed (a toast says why). */
  removeExtraCopy(key: string, path: string): Promise<boolean>;
  /** "This is a different analysis": the copy gets its own identity. */
  markDifferentAnalysis(key: string, path: string): Promise<void>;

  // ── a file put back to an earlier version ──
  useEarlierVersion(key: string): Promise<void>;
  goBackToMyLatest(key: string): Promise<void>;

  // ── reload in place ──
  /** The UI calls this while something must not be interrupted by newer content arriving (an export). Returns the release function. */
  holdReplace(reason: string): () => void;
}

// ── 6.8 Browser preview: simulator additions ────────────────────────────────

/** A removed extra copy, as the simulator lists them. */
export interface SimRemoved {
  id: string;
  /** Where it was. */
  original: string;
  /** ms, simulated clock. */
  at: number;
}

export interface DevSimApiP2 extends DevSimApi {
  /** As phase 1, for any section: table = first value + 1; figure = graph title; analysis = the
   *  centre / error-bar setting switches; scratchpad = cell A1 gets a new value. */
  remoteEdit(path: string, opts?: { userName?: string; section?: SectionName }): Promise<string>;
  /** The other computer works from the version BEFORE this computer's last save and changes `section`.
   *  how "copy": the service keeps this computer's file and adds a conflicted copy → resolves with the copy's path.
   *  how "saveOver": its save silently replaces this computer's last save → resolves with the file's path. */
  remoteDiverge(path: string, opts: { section: SectionName; how: "copy" | "saveOver"; userName?: string }): Promise<string>;
  /** An extra copy holding the file's PREVIOUS version appears beside it ("<name> (old copy).lag"). Resolves with its path. */
  olderCopy(path: string): Promise<string>;
  /** The other computer saves `count` more versions, alternating table and graph edits. Resolves with the last head. */
  remoteEditMany(path: string, count: number): Promise<string>;
  /** Extra copies removed on this computer (newest first). */
  removed(): SimRemoved[];
}

// ═════════════════════════════════════════════════════════════════════════════
// 7. Phase 3 — check-out: read-only on the other computers while one is editing
//    (docs/design/analysis-files-phase3-contract.md)
//
// Additive. Phase 1 / 2 names keep their meaning; the unions above gained members
// that are marked "Phase 3". The controller's store becomes FileSessionStateP3,
// the backend FileBackendP3, the simulator DevSimApiP3, the graph store gains
// StoreGuardApi. Code words: note = the small ".laguse" file a computer keeps
// beside an analysis while it has it open ("beacon" in the plan).
// ═════════════════════════════════════════════════════════════════════════════

/** Numbers of phase 3. Times in ms. */
export const LIMITS_P3 = {
  /** A note file larger than this is not a note (never read further). */
  noteMaxBytes: 8192,
  /** Most ".laguse" files looked at in one folder (by name order). */
  notesPerFolder: 200,
  /** While editing with recent input, the note is rewritten this often (seq + 1). */
  heartbeatMs: 60_000,
  /** "Recent input": the last edit / key / click in the tab is at most this old. */
  inputWindowMs: 600_000,
  /** The frontend tells Rust about input at most this often per file. */
  inputPingMs: 30_000,
  /** An idle note is rewritten this often while the app runs, so it never looks abandoned. */
  idleKeepAliveMs: 6 * 3600_000,
  /** First sight of a note: quiet at once when its `updated_at` is older than this by my clock. */
  firstSightOldMs: 600_000,
  /** First sight otherwise: counts as active this long while waiting for its first seq change. */
  freshFirstMs: 90_000,
  /** After a seq change was seen: quiet when no further change came for this long. */
  staleMs: 300_000,
  /** After my wake-up: observations are "checking" until the next listing, at most this long. */
  recheckMaxMs: 15_000,
  /** After Save, my note stays "editing" this long without further input (decision D6). */
  lingerMs: 30_000,
  /** A clean tab waits this long (my own time) for a version a note announces. */
  waitNewerMs: 120_000,
  /** The same when the announcing note was already old at first sight. */
  waitOldNoteMs: 20_000,
  /** A timer this late (by this computer's clock) means the computer slept. */
  sleepGapMs: 90_000,
  /** After a sleep while editing: the "checking for changes" window. */
  resumeMs: 45_000,
  /** The controller's presence timer (also the sleep detector in the preview and tests). */
  tickMs: 5000,
  /** Another computer's note that has not changed for this long is removed. */
  cleanupMs: 24 * 3600_000,
  /** Quit: time allowed for deleting this computer's notes. */
  quitDeleteMs: 1500,
  /** Note file name: longest document part / computer part (characters, then UTF-8 bytes). */
  nameStemChars: 60,
  nameStemBytes: 120,
  nameDeviceChars: 30,
  nameDeviceBytes: 60,
  /** Becoming read-only is put off this long at a time while something is being typed. */
  applyHoldRetryMs: 500,
  /** How long the banner's button is highlighted after a refused edit. */
  attemptPulseMs: 4000,
} as const;

/** manifest.features written by phase 3 (format.ts FEATURES becomes this). */
export const FEATURES_P3 = 2;

// ── 7.1 The note file ───────────────────────────────────────────────────────

/** First line of every note file (then "\n", then the JSON object). */
export const NOTE_FIRST_LINE = "Lab Analysis Suite note: shows who has this analysis open. Safe to delete.";
export const NOTE_FORMAT = "lasgraph-presence";
export const NOTE_VERSION = 1;

/** A claim another note overrides ("Edit here" / "Edit anyway"). */
export interface NoteTarget {
  device_id: string;
  epoch: number;
}

/** The JSON object of a note file, in this key order. snake_case: it is a file format. */
export interface NoteJson {
  format: typeof NOTE_FORMAT;
  v: 1;
  analysis_id: string;
  /** File name of the document with extension ("Dose response.lag"). */
  document_name: string;
  device_id: string;
  session_id: string;
  device_name: string;
  user_name: string;
  /** Reserved, never written in phase 3: "requesting". A reader treats any other value as "idle". */
  state: "idle" | "editing";
  /** Newest version this computer wrote or checked; null = none yet. */
  head: string | null;
  /** state "editing": the version the unsaved changes are based on; else null. */
  base_revision: string | null;
  /** + 1 each time this computer starts editing. */
  epoch: number;
  /** + 1 on every rewrite of the note. */
  seq: number;
  /** state "editing" after "Edit here": the claims this one overrides; else null. (A reader also accepts one object.) */
  supersedes: NoteTarget[] | null;
  /** ISO time of the writer's clock. Display, and the first-sight rule only. */
  updated_at: string;
  /** Reserved for the later hand-over feature; always null in phase 3. */
  request_to: null;
  handover_to: null;
  features: number;
}

/** A note as a folder listing gives it. */
export interface NoteRecord {
  /** Absolute path of the note file. */
  file: string;
  size: number;
  /** ms, this computer's file system. */
  mtime: number;
  /** SHA-256 (hex) of the file's bytes. */
  sha: string;
  /** This computer's clock (ms) when it first recorded the file with exactly these bytes (kept across restarts). */
  unchangedSince: number;
  note: NoteJson;
  /** It is about the document asked for (§1.4 of the contract). */
  applies: boolean;
  /** No analysis file in the folder has its analysis id. */
  orphan: boolean;
  /** Written by this computer (its device id or an earlier one of it). */
  own: boolean;
}

// ── 7.2 Rust commands added in phase 3 ──────────────────────────────────────

/** presence_set { req }: create or replace this computer's note for a document. */
export interface PresenceSetArgs {
  /** Absolute path of the analysis file. The note is written in its folder, nowhere else. */
  docPath: string;
  analysisId: string;
  state: "idle" | "editing";
  head: string | null;
  baseRevision: string | null;
  epoch: number;
  /** [] = none. */
  supersedes: NoteTarget[];
  /** true: there was input just now (also counts as presence_input). */
  input: boolean;
}

/** presence_set → off: nothing was written. debugRoot: a debug build outside its allowed test folders.
 *  closing: the app is quitting. */
export type PresenceSetReply =
  | { kind: "written"; file: string; note: NoteJson }
  | { kind: "off"; reason: "debugRoot" | "closing" };

/** presence_list → the notes in the document's folder that are about it, plus orphans. */
export interface PresenceListReply {
  notes: NoteRecord[];
  /** More than LIMITS_P3.notesPerFolder note files: the rest was not looked at. */
  truncated: boolean;
}

/** presence_remove_foreign { req }: delete another computer's abandoned note. */
export interface RemoveNoteArgs {
  file: string;
  /** NoteRecord.sha the decision was made on. */
  sha: string;
}

/** kept — changed: the bytes are different now. gone: no such file. own: it is this computer's.
 *  notANote: not a ".laguse" note. */
export type RemoveNoteReply =
  | { kind: "removed" }
  | { kind: "kept"; reason: "changed" | "gone" | "own" | "notANote" };

/** graphfile_cloud_info { path } */
export interface CloudInfo {
  /** The path is inside a folder a sync service keeps on several computers. */
  cloud: boolean;
  /** "Dropbox", "OneDrive", "Google Drive", "iCloud Drive", "Box", another name, or null. */
  service: string | null;
  /** The service's folder (absolute, no trailing slash), or null. */
  root: string | null;
}

/** EVT.file in phase 3: RustFileEvent plus
 *  presence — the notes about a tracked file changed (the full current list, as presence_list gives it);
 *  wake — the computer slept: a timer of the poll thread fired more than LIMITS_P3.sleepGapMs late. */
export type RustFileEventP3 =
  | RustFileEvent
  | { type: "presence"; path: string; notes: NoteRecord[] }
  | { type: "wake"; gapMs: number };

// ── 7.3 FileBackend, phase 3 additions ──────────────────────────────────────

/** What a phase 3 backend hands its subscribers. (The phase 1 member { type: "presence"; path } without
 *  `notes` stays in the union for compatibility; no backend sends it.) */
export type FileEventP3 = FileEventP1 | RustFileEventP3;

export type PresenceSetResult =
  | { ok: true; kind: "written"; file: string; note: NoteJson }
  | { ok: true; kind: "off"; reason: "debugRoot" | "closing" }
  | FileError;

export type PresenceListResult = ({ ok: true } & PresenceListReply) | FileError;

/** FileBackendP2 with a wider `subscribe` (its listener also gets the phase 3 events), plus the note commands. */
export interface FileBackendP3 extends Omit<FileBackendP2, "subscribe"> {
  /** Create or replace this computer's note for a document; the backend keeps beating it while `state` is "editing". */
  presenceSet(req: PresenceSetArgs): Promise<PresenceSetResult>;
  /** Delete this computer's note(s) for a document and stop beating. Missing is fine. */
  presenceClear(docPath: string): Promise<void>;
  /** "There was input now" for a document being edited. Never touches the disk on the caller's side. */
  presenceInput(docPath: string): void;
  presenceList(docPath: string, analysisId: string): Promise<PresenceListResult>;
  /** Delete another computer's note after re-reading it unchanged. Resolves true when it was removed. */
  presenceRemoveForeign(req: RemoveNoteArgs): Promise<boolean>;
  cloudInfo(path: string): Promise<CloudInfo>;
  /** This computer gets a new identity (its identity was found on another computer too). */
  newDeviceId(): Promise<DeviceIdentity>;
  subscribe(listener: (e: FileEventP3) => void): () => void;
}

// ── 7.4 Pure module file/presence.ts (PresenceApi) ──────────────────────────
// No I/O, no clock, no randomness, no store access. Every time is passed in.

/** active: counts as being edited right now. quiet: no sign of life (crash, sleep, long pause).
 *  checking: this computer just woke up and has not looked again yet. */
export type Freshness = "active" | "quiet" | "checking";

/** What this computer has observed of one other computer's note (times: this computer's clock). */
export interface NoteObs {
  deviceId: string;
  sessionId: string;
  epoch: number;
  seq: number;
  state: "idle" | "editing";
  /** When this computer first saw a note of that device (again: after its own wake-up). */
  firstSeenAt: number;
  /** When (session, epoch, seq) last changed in front of this computer (= firstSeenAt before any change). */
  changedAt: number;
  /** Changes seen since firstSeenAt. */
  changes: number;
  /** When it was first seen in state "editing" with this epoch (for "at 19:40"). */
  editingSince: number | null;
  /** First sight: `updated_at` was more than firstSightOldMs old (or unreadable). */
  oldAtFirstSight: boolean;
  /** Set by a sleep gap; cleared by the next observe(). */
  checking: boolean;
}

export interface PresenceObs {
  /** By device id. */
  notes: Record<string, NoteObs>;
  /** Version id a note announced that this computer does not have → when that was first seen. */
  unknownSince: Record<string, number>;
  /** When the last sleep gap was noted and not yet looked at again; null otherwise. */
  checkingSince: number | null;
}

export type TabMode =
  /** Nothing in the way. */
  | "editable"
  /** Clean tab; another computer is editing this very version. */
  | "readOnly"
  /** Clean tab; a note announces a version that has not arrived here yet. */
  | "waiting"
  /** Editable; someone has unsaved changes on an older version, or a note went quiet. */
  | "info"
  /** I have unsaved changes (or just took over) and so does another computer. */
  | "bothEditing"
  /** I was editing, the computer slept: checking what happened meanwhile. */
  | "resuming";

/** One other computer, for texts. */
export interface PeerView {
  deviceId: string;
  deviceName: string;
  userName: string;
  /** Its user name equals mine (both non-empty after trim). */
  sameUser: boolean;
  state: "idle" | "editing";
  freshness: Freshness;
  /** state "editing": what its unsaved changes are based on, seen from my file. myVersion: the version my
   *  file has. older: an earlier version of my file. unknown: a version I don't have. Else null. */
  basedOn: "myVersion" | "older" | "unknown" | null;
  /** Its note's `updated_at` (its clock; display only: "from Fri 18:02"). */
  updatedAt: string;
  /** NoteObs.editingSince / changedAt (my clock, ms): "at 19:40", "note updated 2 min ago". */
  editingSince: number | null;
  changedAt: number;
  /** Another note overrides this claim. */
  superseded: boolean;
  /** This note overrides my claim. */
  supersedesMe: boolean;
}

export interface PresenceInput {
  me: { deviceId: string; userName: string };
  /** This computer's clock, ms. */
  now: number;
  /** Newest version of the file on this computer's disk; null = unknown / untitled. */
  diskHead: string | null;
  /** Is this version id in my file's history (the tab's manifest and the file on disk)? */
  knows(revisionId: string): boolean;
  /** The tab has unsaved changes. */
  dirty: boolean;
  /** My note says "editing" (unsaved changes, the 30 s after a save, or right after "Edit here"). */
  holding: boolean;
  /** My note's epoch (0 = never claimed). */
  myEpoch: number;
  /** The after-sleep window is open. */
  resuming: boolean;
  /** Claims the person chose to override in this tab ("Edit here" / "Edit anyway"). */
  overrides: readonly NoteTarget[];
  /** Other computers' notes about this document, one per device (pickPerDevice). */
  notes: readonly NoteJson[];
  obs: PresenceObs;
}

export interface PresenceDecision {
  mode: TabMode;
  /** mode "readOnly" only because of notes this computer has not re-checked since it woke up. */
  checking: boolean;
  /** Every other computer with a note, editing first, then by device name / id. */
  peers: PeerView[];
  /** Device ids (of `peers`) the mode is about, most relevant first. */
  about: string[];
  /** mode "readOnly": the claims "Edit here" must override. */
  blockers: NoteTarget[];
  /** mode "bothEditing": the device whose note overrides my claim, if any. */
  yieldedTo: string | null;
  /** mode "waiting". `until`: when the tab stops waiting (my clock). */
  waiting: { head: string; deviceId: string; since: number; until: number } | null;
  /** A wait ran out: "Couldn't confirm the newest version yet." */
  unconfirmed: boolean;
  /** The earliest time (my clock) at which the answer can change without any new input; null = never. */
  nextCheckAt: number | null;
}

export type ShareMode = "auto" | "always" | "never";

/** Why notes are / are not written for a file. */
export type ShareWhy = "always" | "cloud" | "otherComputers" | "never" | "local" | "untitled";

export interface PresenceApi {
  /** The text of a note file: NOTE_FIRST_LINE + "\n" + JSON.stringify(note, null, 1) + "\n", keys in NoteJson order. */
  noteText(note: NoteJson): string;
  /** null: not a note (too long, no JSON object, wrong format / v, a missing or mistyped field). Unknown keys are ignored;
   *  `supersedes` given as one object becomes a one-element list; an unknown `state` becomes "idle". */
  parseNote(text: string): NoteJson | null;
  /** One part of a note file name, made safe (§1.2). `fallback` when nothing is left. */
  sanitizeNamePart(text: string, maxChars: number, maxBytes: number, fallback: string): string;
  /** The 4-character tag of a device in note names. attempt 0: the last 4 hex digits of the id; 1: the 4 before
   *  them; 2: the last 8. Missing digits are filled with "0" on the left. */
  deviceTag(deviceId: string, attempt: 0 | 1 | 2): string;
  /** "<stem> (in use on <device>, <tag>).laguse". `docFileName` with or without ".lag". */
  noteFileName(docFileName: string, deviceName: string, deviceId: string, attempt?: 0 | 1 | 2): string;
  /** A file name that is a note or a sync service's copy of one (ends in ".laguse", any case). */
  isNoteFileName(name: string): boolean;
  /** §1.4: same analysis id, and the note names this file (NFC, case-insensitive) or this is the only file with that id in the folder. */
  noteApplies(note: Pick<NoteJson, "analysis_id" | "document_name">, doc: { analysisId: string; fileName: string; sameIdFiles: number }): boolean;
  /** One note per device id: the highest seq; ties → the later `updated_at` string, then the smaller file path. */
  pickPerDevice(records: readonly NoteRecord[]): NoteRecord[];
  emptyObs(): PresenceObs;
  /** Take a new listing in (foreign notes, one per device). Devices without a note are forgotten. */
  observe(prev: PresenceObs, notes: readonly NoteJson[], now: number, knows: (revisionId: string) => boolean): PresenceObs;
  /** A sleep gap was detected: every observation is "checking" until the next observe(). */
  markGap(prev: PresenceObs, now: number): PresenceObs;
  freshness(o: NoteObs, now: number, checkingSince: number | null): Freshness;
  /** §2.4. */
  decide(input: PresenceInput): PresenceDecision;
  /** A timer that should have fired `intervalMs` after `prevAt` fired at `now`: did the computer sleep
   *  (now − prevAt − intervalMs > sleepGapMs) or did the clock go backwards (now < prevAt)? */
  gapDetected(prevAt: number, now: number, intervalMs: number): boolean;
  /** The file was last saved by an app that shows no notes: manifest.features < FEATURES_P3, the newest version
   *  was not saved by this computer, and that computer has no note here. → its names, else null. */
  olderPeer(m: Pick<Manifest, "features" | "head" | "revisions">, myDeviceId: string, notes: readonly NoteJson[]): { deviceId: string; deviceName: string; userName: string } | null;
  /** More than one computer is involved: a version saved by another device id, or a foreign note. */
  multiDevice(m: Pick<Manifest, "revisions"> | null, myDeviceId: string, notes: readonly NoteJson[]): boolean;
  /** Should this computer write notes for the file, and why. */
  shareDecision(p: { choice: ShareMode | null; fallback: ShareMode; untitled: boolean; cloud: boolean; multiDevice: boolean }): { on: boolean; why: ShareWhy };
  /** Version ids notes declare (head and base_revision), for RetentionCtx.beaconHeads. Sorted, unique. */
  liveNoteHeads(notes: readonly NoteJson[]): string[];
  /** Foreign notes (applying or orphan) whose bytes this computer has seen unchanged for cleanupMs. */
  cleanupTargets(records: readonly NoteRecord[], now: number): RemoveNoteArgs[];
  /** Another running app uses my device id: a note with my device id, another session id, whose seq grew between two listings
   *  taken after this session wrote its own note. */
  duplicateIdentity(before: readonly NoteRecord[], after: readonly NoteRecord[], me: { deviceId: string; sessionId: string }): boolean;
}

// ── 7.5 The graph store: read-only guard and the claim hook (store/graphStore.ts) ──

export type EditGuardReason =
  /** Made with a newer app (phase 1 `readOnly: "tooNew"`). */
  | "tooNew"
  /** Another computer is editing this version. */
  | "editingElsewhere"
  /** A newer version is on its way. */
  | "waiting"
  /** Just woke up: not known yet who is editing. */
  | "checking"
  /** Just woke up while editing: the first new edit asks first. */
  | "resuming";

export interface EditGuard {
  reason: EditGuardReason;
}

/** Which way a refused change came in. */
export type EditPath = "table" | "analysis" | "figure" | "scratchpad" | "name" | "undo" | "command";

export interface BlockedEdit {
  /** Grows by one with every refused change of this store. */
  serial: number;
  path: EditPath;
  /** The store action or UI command ("setCell", "paste", "sendToData", "save", …). */
  action: string;
}

/** Members GraphState gains in phase 3. */
export interface StoreGuardApi {
  /** Set: every change by the person is refused (a no-op that is reported in `blocked`). Loads, reloads in place,
   *  markFileSaved and setFileRef are never refused. Reset to null by newDoc / load / loadFile / close. */
  guard: EditGuard | null;
  /** Bumped by every change the person made that was applied (never by a load, a reload, the automatic clean-up,
   *  replaceWorking, replaceContent, markFileSaved or setFileRef). */
  userEditSerial: number;
  /** The last refused change; null = none since the document was opened. */
  blocked: BlockedEdit | null;
  setGuard(guard: EditGuard | null): void;
  /** For edit paths outside the store's own actions (the Scratchpad sheet, the Save button, a menu command). */
  noteBlockedEdit(path: EditPath, action: string): void;
}

// ── 7.6 The session controller, phase 3 ─────────────────────────────────────

export interface SharingView {
  /** This file's own choice; null = it follows the default. */
  choice: ShareMode | null;
  /** The default (Settings). */
  fallback: ShareMode;
  /** Notes are being written for this file now. */
  on: boolean;
  why: ShareWhy;
  /** The sync service of the folder, when it is in one. */
  service: string | null;
}

/** "Up to date · Alice saved 2 min ago": the newest version was saved on another computer. */
export interface StatusLine {
  kind: "upToDate";
  who: VersionInfo;
  /** When this computer first saw that version (its own clock, ms); null = unknown (use who.time). */
  seenAt: number | null;
}

export interface TabPresence {
  mode: TabMode;
  /** The tab is read-only because of another computer: `guard` is "editingElsewhere", "checking" or "waiting".
   *  (Not for "resuming", which only asks before the first new edit, and not for "tooNew": that is FileTab.readOnly.) */
  readOnly: boolean;
  /** The graph store's guard for this tab (set on the store while the tab is the loaded one). */
  guard: EditGuardReason | null;
  /** Every other computer that has a note for this file, editing first. */
  peers: PeerView[];
  /** What this computer's own note says; "none" = no note is written. */
  mine: "none" | "idle" | "editing";
  sharing: SharingView;
  status: StatusLine | null;
  /** Bumped each time a change was refused; the UI highlights the banner's button for attemptPulseMs. */
  attempt: number;
}

export interface FileSessionStateP3 extends FileSessionStateP2 {
  // ── who is editing ──
  /** "Edit here": edit on this computer now, over the notes that make the tab read-only. Instant.
   *  When someone ELSE is editing and `confirmed` is not true, the dialog "editAnyway" is asked first.
   *  Resolves true when the tab is editable afterwards. */
  editHere(key?: string, confirmed?: boolean): Promise<boolean>;
  /** [Keep editing]: closes the "also being edited" / "continued elsewhere" banner (it returns when another
   *  computer starts editing again), or ends the after-sleep check now. */
  keepEditing(key?: string): void;
  /** "Save my changes as a separate copy…": asks for a place; my version becomes a new analysis there and
   *  the tab moves to it; this file is left as it is on disk. */
  saveAsSeparateCopy(key?: string): Promise<SaveOutcome>;
  /** The UI reports a refused change that did not go through the graph store (Save button, a disabled control). */
  reportEditAttempt(path: EditPath, action: string, key?: string): void;

  // ── "Show others when I'm editing" ──
  /** Opens the dialog "sharing" for the tab. No-op for an untitled document. */
  openSharing(key?: string): void;
  /** This file's own choice (null = follow the default). Notes are written or removed at once. */
  setSharing(key: string, choice: ShareMode | null): Promise<void>;
  /** The default for files without a choice of their own (Settings). */
  setSharingDefault(mode: ShareMode): Promise<void>;
}

// ── 7.7 Browser preview: simulator additions ────────────────────────────────

/** Which simulated computer acts. other: "Office iMac" (Alice). third: "Lab MacBook" (Bob). */
export type SimWho = "other" | "third";

export interface SimNote {
  file: string;
  /** Name of the note file. */
  name: string;
  deviceName: string;
  userName: string;
  state: "idle" | "editing";
  epoch: number;
  seq: number;
  head: string | null;
  baseRevision: string | null;
  /** The simulated owner keeps rewriting it every 60 s. */
  beating: boolean;
}

export interface DevSimApiP3 extends DevSimApiP2 {
  /** Name of the third simulated computer. */
  thirdDevice: string;
  /** The note files beside `path` as this computer's disk has them, sorted by name. */
  notes(path: string): SimNote[];
  /** The computer opens the file: an idle note appears. `sameUser`: it uses MY user name (my own other computer). */
  peerOpens(path: string, opts?: { who?: SimWho; sameUser?: boolean }): Promise<void>;
  /** It starts editing the version it has (note "editing", epoch + 1) and keeps the note beating every 60 s. */
  peerStartsEditing(path: string, opts?: { who?: SimWho; sameUser?: boolean }): Promise<void>;
  /** It saves while editing (one more version; the note gets the new version at once). keepEditing false (default):
   *  the note goes back to idle 30 s later; true: it keeps editing on the new version. */
  peerSaves(path: string, opts?: { who?: SimWho; section?: SectionName; keepEditing?: boolean }): Promise<string>;
  /** It stops editing without saving (discard): the note goes back to idle. */
  peerStops(path: string, opts?: { who?: SimWho }): Promise<void>;
  /** It closes the file / quits: its note is deleted. */
  peerQuits(path: string, opts?: { who?: SimWho }): Promise<void>;
  /** It crashes or loses power: its note stays as it is and is never rewritten. */
  peerCrashes(path: string, opts?: { who?: SimWho }): Promise<void>;
  /** It goes to sleep (the note stops beating) / wakes up (it beats again; when a note overrides its claim it
   *  keeps its unsaved changes and its note stays "editing"). */
  peerSleeps(path: string, opts?: { who?: SimWho }): Promise<void>;
  peerWakes(path: string, opts?: { who?: SimWho }): Promise<void>;
  /** It presses "Edit here" on the file this computer is editing: its note overrides this computer's claim. */
  peerEditsHere(path: string, opts?: { who?: SimWho; sameUser?: boolean }): Promise<void>;
  /** A sync service's conflict copy of that computer's note appears beside it (older seq, "… (conflicted copy).laguse"). */
  noteConflictCopy(path: string, opts?: { who?: SimWho }): Promise<string>;
  /** The computer runs an older app: it writes no notes and its saves carry features 1. */
  setOldApp(on: boolean, who?: SimWho): void;
  /** Its clock is wrong by `ms` (its `updated_at` values shift; nothing else may change). */
  setClockSkew(ms: number, who?: SimWho): void;
  /** Notes and files from other computers reach this computer `ms` later (0 = at once). */
  setSyncDelay(ms: number): void;
  /** This computer is offline: nothing arrives or leaves until it is back. */
  setOffline(on: boolean): void;
  /** This computer sleeps for `ms` and wakes up: simulated time jumps, no timer runs in between. */
  sleep(ms: number): void;
}
