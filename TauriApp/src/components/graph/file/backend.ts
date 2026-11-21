/* FileBackend: everything the Graphs tool needs from disk and from the app's own
   records (plan §10). Two implementations: Tauri (Rust commands + events, phase 1)
   and the in-memory one (memoryBackend.ts) used by the browser preview and by
   tests, including simulated other computers. Not wired to the UI yet. */

import type { FileHeader, GraphFileData, Manifest } from "./format";
import type { FileEventP1, FileBackendP1 } from "./contract";

export type { FileBackendP1 };

/** Typed errors (plan §4.1). */
export type FileErrorCode =
  | "NotFound"          // no file at the path
  | "PermissionDenied"  // the OS hasn't allowed access to the folder
  | "OfflineOrTimeout"  // the read didn't finish in time
  | "Incomplete"        // the file is still arriving (fails validation) — never a new version
  | "Dataless"          // online-only placeholder, not downloaded to this computer
  | "TooNew"            // save only: the file at the path was made by a newer app and would lose data
  | "IdentityMismatch"  // save only: the analysis id / document key doesn't match the path's record (§7 step 2)
  | "Invalid"           // not an analysis file, or a save whose parts are missing
  | "Io";               // any other disk error (disk full, read-only volume, name too long…)

export interface FileError {
  ok: false;
  code: FileErrorCode;
  message: string;
}

export interface FileStat {
  path: string;
  size: number;
  /** Milliseconds since the epoch, as this computer sees it. */
  mtime: number;
  /** Online-only placeholder (no content on this computer). */
  dataless: boolean;
}

/** Why a file that read fine must open read-only (plan §1.5). */
export type ReadOnlyReason = "tooNew";

export type ReadResult =
  | { ok: true; file: GraphFileData; stat: FileStat; readOnly: ReadOnlyReason | null }
  | FileError;
export type HeaderResult = { ok: true; header: FileHeader; stat: FileStat } | FileError;

export interface SaveRequest {
  path: string;
  /** Head the save is based on; null = a new file (refused if one exists). */
  expectedHead: string | null;
  /** Identity assertion (plan §7 step 2): must equal manifest.analysis_id and
   *  the analysis id of the file at the path; the session's record of the path
   *  (if any) must belong to this document. Otherwise IdentityMismatch. */
  analysisId: string;
  docKey: string;
  /** The new manifest (head = the new revision, history unioned). */
  manifest: Manifest;
  /** Only parts that are neither in the file at the path nor in the journal
   *  copy of expectedHead ("parts/<sha>.json" → canonical text). Every other
   *  part the manifest references is copied byte for byte by the backend; a
   *  part found nowhere fails the save with Invalid. Parts no revision
   *  references any more are dropped. */
  newParts: Record<string, string>;
  /** expectedHead null only. true (the person confirmed "Replace"): whatever is
   *  at the path is moved aside (displaced/) first. Default false. */
  replaceExisting?: boolean;
}

/** Outcome of a save (plan §7). */
export type SaveResult =
  | { ok: true; kind: "saved"; path: string; head: string; stat: FileStat }
  /** The head on disk couldn't be established (offline placeholder, still
   *  arriving): written beside it as "<name> (unsynced from <device>).lag". */
  | { ok: true; kind: "savedAside"; path: string; head: string; stat: FileStat }
  /** Saved, but the file replaced had another head than expected (a remote
   *  save landed in the gap); that head was journaled and needs combining. */
  | { ok: true; kind: "savedButDisplaced"; path: string; head: string; stat: FileStat; displacedHead: string }
  /** The file on disk has another head: nothing was written. */
  | { ok: false; kind: "conflict"; head: string }
  /** The file is gone from the path and the safe follow rule found no single
   *  successor: nothing was written. (When it finds one the save goes there
   *  and `path` in the result says where.) */
  | { ok: false; kind: "missing" }
  | (FileError & { kind: "error" });

export interface DirEntry {
  name: string;
  path: string;
  size: number;
  mtime: number;
  kind: "graph" | "presence" | "other";
  dataless: boolean;
  /** For local, complete analysis files; null otherwise. */
  header: FileHeader | null;
}

export type ScanResult = { ok: true; entries: DirEntry[] } | FileError;

export interface DeviceIdentity {
  device_id: string;
  device_name: string;
  user_name: string;
  /** Random per app launch. */
  session_id: string;
}

/** One open tab (plan §3, graph-session.json). */
export interface SessionTab {
  doc_key: string;
  analysis_id: string | null;
  path: string | null;
  base_revision: string | null;
  accepted_head: string | null;
  active: boolean;
  /** Untitled documents: their title ("Untitled 2"). */
  title?: string;
  /** Template of the document (untitled documents without a draft). */
  template?: string;
  /** Paths of copies this session made or the person answered about (never a rename target, no copy question). */
  known_copies?: string[];
  /** Copies the person called "the same analysis". */
  copy_answer?: Record<string, "same">;
  /** Heads this device journaled for the path whose content is kept elsewhere (a copy file, another
   *  analysis) or was set aside on purpose: the journal check ignores them. */
  settled_heads?: string[];
  /** Same-analysis files seen beside this one (copies): never taken for this file renamed, also after a restart. */
  seen_copies?: string[];
}

export interface GraphSession {
  v: 1;
  tabs: SessionTab[];
}

/** Unsaved work of one document (drafts/<doc_key>.json). */
export interface DraftRecord {
  doc_key: string;
  analysis_id: string | null;
  path: string | null;
  base_revision: string | null;
  /** Section name → section JSON (file form). */
  sections: Record<string, unknown>;
  /** ISO time. */
  saved_at: string;
  /** Tab title when it was written ("Untitled 2"; the file name otherwise). */
  title?: string;
  template?: string;
}

/** A head this device has journaled for an analysis at a path (plan §3 journal/index.json, §8). */
export interface JournalHead {
  analysis_id: string;
  path: string;
  revision_id: string;
  /** A strict descendant of this head has been seen on disk at this path. */
  confirmed: boolean;
  /** When this device first journaled it (this computer's clock, ms). */
  first_seen: number;
}

/** A file moved aside (plan §3 displaced/): the target a save replaced, or an extra copy removed. */
export interface DisplacedEntry {
  id: string;
  /** Where it was. */
  original: string;
  analysis_id: string;
  head: string;
  reason: "replaced" | "removedCopy";
  /** This computer's clock, ms. Kept 30 days. */
  at: number;
}

/** graph-recent.json: keyed by path (analysis_id is an attribute), newest first, max 50. */
export interface RecentEntry {
  path: string;
  analysis_id: string | null;
  /** ISO time. */
  opened_at: string;
  /** The last check didn't find the file ("Remove from this list" or the startup check). */
  missing?: boolean;
}
export const RECENT_MAX = 50;

/** export-map.json (plan §12): library migration progress per library row. */
export interface ExportRow {
  /** saved time of the library row when exported (a newer one is exported again). */
  saved_at: string;
  analysis_id: string;
  path: string | null;
  status: "done" | "failed";
  error?: string;
  /** Row / column ids minted for this library row, once: a re-export reuses them. */
  row_ids?: string[];
  col_ids?: string[];
}
export interface ExportMap {
  v: 1;
  /** Key: library row id. */
  rows: Record<string, ExportRow>;
}
export const emptyExportMap = (): ExportMap => ({ v: 1, rows: {} });

/** Change notifications for tracked files (plan §5.1; phase 1: contract §2.1). */
export type FileEvent = FileEventP1;

export interface FileBackend {
  device(): Promise<DeviceIdentity>;
  /** Full read + validation; journals the head (plan §3). */
  read(path: string): Promise<ReadResult>;
  /** Cheap read of the identity / head hint. */
  header(path: string): Promise<HeaderResult>;
  save(req: SaveRequest): Promise<SaveResult>;
  scanDir(dir: string): Promise<ScanResult>;
  readSession(): Promise<GraphSession>;
  writeSession(s: GraphSession): Promise<void>;
  readDraft(docKey: string): Promise<DraftRecord | null>;
  writeDraft(d: DraftRecord): Promise<void>;
  deleteDraft(docKey: string): Promise<void>;
  listDrafts(): Promise<DraftRecord[]>;
  /** Every head this device has journaled for an analysis (optionally at one path), oldest first. */
  journalHeads(analysisId: string, path?: string): Promise<JournalHead[]>;
  /** A journaled copy ("Go back to my latest", combining with a lost save). */
  readJournal(analysisId: string, revisionId: string): Promise<GraphFileData | null>;
  /** Journal a file that isn't on disk: the working copy, as a real revision,
   *  before a conflict is resolved (plan §7). */
  writeJournal(path: string, file: GraphFileData): Promise<void>;
  listDisplaced(): Promise<DisplacedEntry[]>;
  readDisplaced(id: string): Promise<GraphFileData | null>;
  readRecent(): Promise<RecentEntry[]>;
  /** Stored deduplicated by path (first wins) and cut to RECENT_MAX. */
  writeRecent(entries: RecentEntry[]): Promise<void>;
  readExportMap(): Promise<ExportMap>;
  writeExportMap(m: ExportMap): Promise<void>;
  /** Start / stop watching an open file (the active tab is checked more often). */
  track(path: string, opts?: { active?: boolean }): void;
  untrack(path: string): void;
  subscribe(listener: (e: FileEvent) => void): () => void;
}

export const emptySession = (): GraphSession => ({ v: 1, tabs: [] });
