/* In-memory FileBackend with simulated computers and a simulated sync service
   (plan §10, §13). Each MemoryDevice is one computer: its own folder contents,
   app records (session, drafts, journal) and sync delays. MemoryWorld is the
   cloud service between them, with the conflict behaviour of a real service
   ("dropbox": the later upload becomes a "conflicted copy" beside the file;
   "onedrive": the same with OneDrive's naming; "lww": the later upload silently
   replaces the earlier one). Time is a ManualClock, so scenarios are exact:
   nothing moves until the test advances the clock.

   Rename tracking follows plan §5.2: a tracked path that disappears is
   "missing" only after MISSING_CONFIRM_MS (two polls); it is followed to a
   same-id file in the same folder only when that is the single candidate, was
   never seen beside the tracked file (the copy table) and its head equals or
   descends from the tracked head.

   Events follow the phase 1 contract (§2.1): changed / moved / missing / back /
   sibling / unreadable / replaced. They are sent when the simulated disk
   changes (the Rust poll finds the same changes a little later).

   Used by the browser preview (previewBackend.ts) and by the tests. Part hashes
   are not recomputed here (test files may use readable stand-ins); the Rust
   backend verifies them.

   Phase 3 (phase3-contract.md §3, §5.1): the world also knows NOTE FILES — the
   small ".laguse" text files a computer keeps beside an analysis while it has it
   open. They sync between devices like files (own delays, the same offline queue,
   a conflict copy when two uploads of one name meet) and are written, listed,
   kept beating and deleted the way the Rust shell does it (presence.rs), through
   the pure rules of presence.ts. A device can sleep (its timers and its sync stop,
   then a "wake" event), crash (its notes stay, nothing of it runs any more) and
   quit (its notes are deleted). The note's `sha` is a short hash of its text here
   (the controller only hands it back). */

import type {
  DeviceIdentity, DirEntry, DisplacedEntry, DraftRecord, ExportMap, FileError, FileErrorCode, FileEvent,
  FileStat, GraphSession, HeaderResult, JournalHead, ReadResult, RecentEntry, SaveRequest, SaveResult, ScanResult,
} from "./backend";
import { RECENT_MAX, emptyExportMap, emptySession } from "./backend";
import {
  LIMITS_P2, LIMITS_P3, emptySeenMap,
  type AppInfo, type CloudInfo, type DevicePatch, type FileBackendP3, type LocateMatch, type LocateProgress, type LocateResult,
  type NoteJson, type NoteRecord, type PeekResult, type PresenceListResult, type PresenceSetArgs, type PresenceSetResult,
  type RemoveCopyArgs, type RemoveCopyResult, type RemoveNoteArgs, type SeenMap,
} from "./contract";
import { isNoteFileName, noteApplies, noteFileName, noteText, parseNote, utf8Length } from "./presence";
import {
  GRAPH_EXT, PRESENCE_EXT, READER_VERSION, SECTION_NAMES, fileProblem, fileStem, headerOf, isAncestorOrSelf, parentDir,
  type GraphFileData,
} from "./format";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// ── clock ────────────────────────────────────────────────────────────────────

/** Simulated time: scheduled tasks run, in time order, only inside advance(). */
export class ManualClock {
  private t: number;
  private seq = 0;
  private queue: { at: number; seq: number; fn: () => void }[] = [];

  constructor(start = Date.UTC(2026, 0, 1)) { this.t = start; }

  now(): number { return this.t; }

  schedule(delayMs: number, fn: () => void): void {
    // Kept in (time, order) order: inserted at its place (binary search), so advance() never sorts.
    const task = { at: this.t + Math.max(0, delayMs), seq: this.seq++, fn };
    const q = this.queue;
    let lo = 0, hi = q.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (q[mid].at <= task.at) lo = mid + 1; else hi = mid;
    }
    q.splice(lo, 0, task);
  }

  /** Move time forward by `ms`, running every task that falls due on the way. */
  advance(ms: number): void {
    const end = this.t + Math.max(0, ms);
    for (;;) {
      const next = this.queue[0];
      if (!next || next.at > end) break;
      this.queue.shift();
      this.t = Math.max(this.t, next.at);
      next.fn();
    }
    this.t = end;
  }

  /** Run until nothing is scheduled (bounded, in case tasks keep rescheduling). */
  settle(maxMs = 24 * 3600_000): void {
    const stop = this.t + maxMs;
    while (this.queue.length && this.t < stop) {
      this.advance(Math.max(0, this.queue[0].at - this.t));
    }
  }

  get pending(): number { return this.queue.length; }
}

// ── the sync service ─────────────────────────────────────────────────────────

export type ConflictMode = "dropbox" | "onedrive" | "lww";

interface CloudEntry {
  /** null = deleted. */
  data: GraphFileData | null;
  rev: number;
  mtime: number;
}

export interface DeviceOptions {
  device_id: string;
  device_name: string;
  user_name?: string;
  session_id?: string;
  /** Time from a local change until the service has it. */
  uploadDelayMs?: number;
  /** Time from the service having a change until this computer has it. */
  downloadDelayMs?: number;
  online?: boolean;
  /** Remote updates first arrive incomplete (failing validation) for this long. */
  partialDeliveryMs?: number;
  /** What appInfo() answers (defaults: macOS, home /Users/me, no temporary folders). */
  appInfo?: Partial<AppInfo>;
  /** Folders that exist (besides the folders of files). With `strictFolders`, saving into or
   *  searching another folder fails with NotFound, as on a real disk. */
  folders?: string[];
  strictFolders?: boolean;
  /** Phase 3: note files sync with their own delays (default: the file delays). */
  noteUploadDelayMs?: number;
  noteDownloadDelayMs?: number;
}

export interface MemoryWorldState {
  v: 1;
  mode: ConflictMode;
  serverRev: number;
  cloud: [string, CloudEntry][];
  devices: MemoryDeviceState[];
  /** Phase 3: the service's note files. */
  noteCloud?: [string, NoteCloudEntry][];
}

/** Phase 3: a note file as the service holds it (null text = deleted). */
interface NoteCloudEntry {
  text: string | null;
  rev: number;
  mtime: number;
}

export class MemoryWorld {
  readonly clock: ManualClock;
  readonly mode: ConflictMode;
  readonly devices: MemoryDevice[] = [];
  /** Only paths under these folders are synced (none given = everything). */
  readonly syncFolders: string[] | null;
  private readonly cloud = new Map<string, CloudEntry>();
  private serverRev = 0;
  private readonly changeListeners = new Set<() => void>();

  /** Phase 3: folders where devices may write notes (null = everywhere). Outside them presenceSet answers
   *  off / debugRoot, as a debug build outside LAS_NOTE_ROOTS does. */
  noteRoots: string[] | null;
  private readonly noteCloud = new Map<string, NoteCloudEntry>();

  constructor(opts: { mode?: ConflictMode; clock?: ManualClock; syncFolders?: string[]; noteRoots?: string[] | null } = {}) {
    this.clock = opts.clock ?? new ManualClock();
    this.mode = opts.mode ?? "dropbox";
    this.syncFolders = opts.syncFolders ?? null;
    this.noteRoots = opts.noteRoots === undefined ? null : opts.noteRoots;
  }

  /** Phase 3: the sync service's folder holding `path` (null = not synced). */
  syncRoot(path: string): string | null {
    if (!this.syncFolders) return "/";
    return this.syncFolders.find((f) => path.startsWith(f.endsWith("/") ? f : f + "/")) ?? null;
  }

  /** Phase 3: the service's name, as cloudInfo reports it. */
  get serviceName(): string { return this.mode === "onedrive" ? "OneDrive" : this.mode === "lww" ? "iCloud Drive" : "Dropbox"; }

  /** @internal A device's pending change of note file `path` reaches the service. */
  pushNote(dev: MemoryDevice, path: string): void {
    if (!this.synced(path)) return;
    const change = dev.pendingNoteChange(path);
    if (!change) return;
    const now = this.clock.now();
    const c = this.noteCloud.get(path);
    const cloudRev = c?.rev ?? 0;
    if (cloudRev === change.base || (c && c.text === null) || this.mode === "lww") {
      const rev = ++this.serverRev;
      this.noteCloud.set(path, { text: change.text, rev, mtime: now });
      dev.noteUploaded(path, rev);
      for (const d of this.devices) if (d !== dev) this.deliverNote(d, path);
      this.touch();
      return;
    }
    if (change.text === null) { dev.noteUploaded(path, -1); this.deliverNote(dev, path); return; }
    // Two uploads of one name met: the service keeps the later one as a conflict copy.
    const copy = this.noteConflictName(path, dev.name, now);
    const rev = ++this.serverRev;
    this.noteCloud.set(copy, { text: change.text, rev, mtime: now });
    dev.noteUploaded(path, -1);
    dev.adoptNoteCopy(copy, change.text, rev);
    for (const d of this.devices) if (d !== dev) this.deliverNote(d, copy);
    this.deliverNote(dev, path);
    this.touch();
  }

  /** The name the service gives a conflicting upload of note file `path`. */
  noteConflictName(path: string, deviceName: string, now = this.clock.now()): string {
    const dir = parentDir(path);
    const name = path.slice(dir.length + 1);
    const stem = name.replace(/\.laguse$/i, "");
    const date = new Date(now).toISOString().slice(0, 10);
    const base = this.mode === "onedrive" ? `${stem}-${deviceName}` : `${stem} (${deviceName}'s conflicted copy ${date})`;
    let p = `${dir}/${base}.laguse`;
    for (let i = 1; this.noteCloud.get(p)?.text; i++) p = `${dir}/${base} (${i}).laguse`;
    return p;
  }

  /** @internal Send the service's current version of note file `path` to a device. */
  deliverNote(dev: MemoryDevice, path: string): void {
    const e = this.noteCloud.get(path);
    if (!e) return;
    const snap: NoteCloudEntry = { ...e };
    this.clock.schedule(dev.noteDownloadDelayMs, () => dev.receiveNote(path, snap));
  }

  addDevice(opts: DeviceOptions): MemoryDevice {
    const d = new MemoryDevice(this, opts);
    this.devices.push(d);
    return d;
  }

  /** Is this path in a synced folder? */
  synced(path: string): boolean {
    return !this.syncFolders || this.syncFolders.some((f) => path.startsWith(f.endsWith("/") ? f : f + "/"));
  }

  /** The head the service holds for a path (null = none / deleted). */
  cloudHead(path: string): string | null {
    return this.cloud.get(path)?.data?.manifest.head ?? null;
  }

  cloudPaths(): string[] {
    return [...this.cloud.entries()].filter(([, e]) => e.data).map(([p]) => p).sort();
  }

  /** Called on any change of any device's disk or records (persistence, the simulator panel). */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => { this.changeListeners.delete(listener); };
  }

  /** @internal */
  touch(): void {
    for (const l of [...this.changeListeners]) l();
  }

  /** The service's version of `path` is replaced outright, as by a "restore an
   *  earlier version" in the service's web history or by a silent last-writer-wins
   *  upload (iCloud): every computer gets it as a normal download. */
  forceReplace(path: string, data: GraphFileData): void {
    const rev = ++this.serverRev;
    this.cloud.set(path, { data: clone(data), rev, mtime: this.clock.now() });
    for (const d of this.devices) this.deliver(d, path);
    this.touch();
  }

  /** @internal A device's pending change of `path` reaches the service. */
  push(dev: MemoryDevice, path: string): void {
    if (!this.synced(path)) return;
    const change = dev.pendingChange(path);
    if (!change) return;
    const now = this.clock.now();
    const c = this.cloud.get(path);
    const cloudRev = c?.rev ?? 0;
    // Accepted when based on the service's current version, when the path was
    // deleted there (re-creating a deleted file is no conflict), or always (lww).
    if (cloudRev === change.base || (c && !c.data) || this.mode === "lww") {
      const rev = ++this.serverRev;
      this.cloud.set(path, { data: change.data ? clone(change.data) : null, rev, mtime: now });
      dev.uploaded(path, rev);
      this.broadcast(path, dev);
      this.touch();
      return;
    }
    // The service changed since this computer's copy: the service's version stays.
    if (!change.data) {          // a deletion loses against a newer version
      dev.uploaded(path, -1);
      this.deliver(dev, path);
      return;
    }
    const copy = this.conflictName(path, dev.name, now);
    const rev = ++this.serverRev;
    this.cloud.set(copy, { data: clone(change.data), rev, mtime: now });
    dev.uploaded(path, -1);
    dev.adoptConflictCopy(copy, change.data, rev);
    this.broadcast(copy, dev);
    this.deliver(dev, path);
    this.touch();
  }

  /** The name the service gives a conflicting upload of `path` from `deviceName`. */
  conflictName(path: string, deviceName: string, now = this.clock.now()): string {
    const dir = parentDir(path);
    const stem = fileStem(path);
    const date = new Date(now).toISOString().slice(0, 10);
    const base = this.mode === "onedrive" ? `${stem}-${deviceName}` : `${stem} (${deviceName}'s conflicted copy ${date})`;
    let name = `${dir}/${base}.${GRAPH_EXT}`;
    for (let i = 1; this.cloud.get(name)?.data; i++) name = `${dir}/${base} (${i}).${GRAPH_EXT}`;
    return name;
  }

  private broadcast(path: string, except: MemoryDevice): void {
    for (const d of this.devices) if (d !== except) this.deliver(d, path);
  }

  /** @internal Send the service's current version of `path` to a device. */
  deliver(dev: MemoryDevice, path: string): void {
    const e = this.cloud.get(path);
    if (!e) return;
    const snap: CloudEntry = { data: e.data ? clone(e.data) : null, rev: e.rev, mtime: e.mtime };
    this.clock.schedule(dev.downloadDelayMs, () => dev.receive(path, snap));
  }

  /** @internal Current service copy of a path (for hydrating a placeholder). */
  cloudData(path: string): GraphFileData | null {
    const d = this.cloud.get(path)?.data;
    return d ? clone(d) : null;
  }

  /** Everything (service and every device's disk and records) as plain JSON. */
  exportState(): MemoryWorldState {
    return {
      v: 1, mode: this.mode, serverRev: this.serverRev, cloud: clone([...this.cloud.entries()]),
      devices: this.devices.map((d) => d.exportState()),
      noteCloud: clone([...this.noteCloud.entries()]),
    };
  }

  /** Restore exportState() (devices matched by device id; pending sync work is not kept). */
  importState(s: MemoryWorldState): void {
    if (!s || s.v !== 1) return;
    this.serverRev = s.serverRev;
    this.cloud.clear();
    for (const [p, e] of s.cloud) this.cloud.set(p, clone(e));
    this.noteCloud.clear();
    for (const [p, e] of s.noteCloud ?? []) this.noteCloud.set(p, clone(e));
    for (const ds of s.devices) this.devices.find((d) => d.deviceId === ds.identity.device_id)?.importState(ds);
    this.touch();
  }
}

// ── one computer ─────────────────────────────────────────────────────────────

interface LocalFile {
  data: GraphFileData;
  /** Service revision this copy was last in step with (0 = never synced, -1 = must take the next delivery). */
  cloudRev: number;
  /** Changed here and not yet uploaded. */
  dirty: boolean;
  mtime: number;
  incomplete: boolean;
  dataless: boolean;
}

type TrackState = "ok" | "missing" | "unreadable" | "replaced";
type UnreadableReason = "Incomplete" | "Dataless" | "PermissionDenied" | "OfflineOrTimeout";

interface Tracked {
  active: boolean;
  /** Last head seen at the path (the base for the follow rule). */
  head: string | null;
  analysisId: string | null;
  /** A "gone?" re-check is scheduled. */
  checking: boolean;
  state: TrackState;
  reason: UnreadableReason | null;
  /** Same-id files beside it → the head last announced (sibling events only when new or changed). */
  siblingHeads: Map<string, string>;
}

export interface MemoryDeviceState {
  identity: DeviceIdentity;
  files: [string, LocalFile][];
  session: GraphSession;
  drafts: DraftRecord[];
  journal: [string, [string, GraphFileData][]][];
  journalIdx: JournalHead[];
  displaced: { entry: DisplacedEntry; data: GraphFileData }[];
  displacedSeq: number;
  recent: RecentEntry[];
  exportMap: ExportMap;
  folders: string[];
  denied: string[];
  /** Phase 2: the first-seen record (graph-seen.json). */
  seen?: SeenMap;
  /** Phase 3: note files on this disk, the "seen unchanged since" record, the note files this app wrote and
   *  the device ids this computer had before. */
  notes?: [string, LocalNote][];
  noteSeen?: [string, { sha: string; since: number }][];
  noteWritten?: string[];
  aliases?: string[];
}

/** Phase 3: a note file on a device's disk. */
interface LocalNote {
  text: string;
  cloudRev: number;
  dirty: boolean;
  mtime: number;
  /** Online-only (fixer round 2, RV-1): listed, but its text is known here only once a read downloaded it. */
  dataless?: boolean;
}

/** Phase 3: this computer's own note for one document (presence.rs OwnNote). */
interface OwnNote {
  file: string;
  note: NoteJson;
  lastWrite: number;
  lastInput: number | null;
  beating: boolean;
  /** The heartbeat / keep-alive timer is set. */
  timer: { cancelled: boolean } | null;
}

/** Phase 3: a short hash of a note's text (the Rust shell uses SHA-256; here only identity matters). */
export function noteSha(text: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

/** The controller's timers on a device (phase 3): they do not run while it sleeps (they run late, at its
 *  wake-up) and never again after it crashed or quit. */
export interface DeviceTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Absent on two polls this far apart before a path counts as missing (plan §5.2). */
export const MISSING_CONFIRM_MS = 5000;

const err = (code: FileErrorCode, message: string): FileError => ({ ok: false, code, message });
const saveErr = (code: FileErrorCode, message: string): SaveResult => ({ ...err(code, message), kind: "error" });
const own = (o: Record<string, string>, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const under = (path: string, dir: string) => path === dir || path.startsWith(dir.endsWith("/") ? dir : dir + "/");
const BUNDLE_RE = /\.(app|bundle|framework|plugin|kext|pkg|photoslibrary|musiclibrary|xcodeproj|lproj)$/i;

export class MemoryDevice implements FileBackendP3 {
  readonly name: string;
  readonly deviceId: string;
  uploadDelayMs: number;
  downloadDelayMs: number;
  partialDeliveryMs: number;
  private online: boolean;
  private identity: DeviceIdentity;
  private readonly defaults: { device_name: string; user_name: string };
  private readonly info: AppInfo;
  private readonly strictFolders: boolean;
  private readonly folderSet = new Set<string>();
  private readonly denied = new Set<string>();
  private readonly offlineNext = new Set<string>();
  /** Aside copies this device wrote → the head it wrote (reused by the next save aside while unchanged). */
  private readonly asides = new Map<string, string>();
  private readonly files = new Map<string, LocalFile>();
  /** Local deletions not yet uploaded: path → service revision they were based on. */
  private readonly deletes = new Map<string, number>();
  private readonly waitingUpload = new Set<string>();
  private readonly waitingDownload = new Set<string>();
  private readonly tracked = new Map<string, Tracked>();
  /** Per tracked path: same-id files ever seen beside it (never a rename target, §5.2). */
  private readonly copyTable = new Map<string, Set<string>>();
  private readonly listeners = new Set<(e: FileEvent) => void>();
  private readonly displaceNext = new Map<string, GraphFileData>();
  private session: GraphSession = emptySession();
  private readonly drafts = new Map<string, DraftRecord>();
  private readonly journalData = new Map<string, Map<string, GraphFileData>>();
  private readonly journalIdx: JournalHead[] = [];
  private readonly displaced = new Map<string, { entry: DisplacedEntry; data: GraphFileData }>();
  private displacedSeq = 0;
  private recent: RecentEntry[] = [];
  private exportMap: ExportMap = emptyExportMap();
  private seen: SeenMap = emptySeenMap();
  private locateSeq = 0;
  private readonly cancelled = new Set<string>();
  /** Every event emitted, for assertions. */
  readonly events: FileEvent[] = [];
  /** Every save request, for assertions. */
  readonly saves: SaveRequest[] = [];
  /** Head of every file written to this computer's disk by a save (not by sync), for assertions. */
  readonly written: string[] = [];

  // ── phase 3 ──
  noteUploadDelayMs: number;
  noteDownloadDelayMs: number;
  /** Shifts only the `updated_at` this device writes into its notes (its clock is wrong). */
  clockSkewMs = 0;
  /** Heartbeat interval (LIMITS_P3.heartbeatMs; the self-test shortens it). */
  heartbeatMs: number = LIMITS_P3.heartbeatMs;
  /** The simulator's peers: the note keeps beating without input (a person typing all the time). */
  alwaysInput = false;
  /** An app without notes (phase 1 / 2) runs here: presenceSet writes nothing (off). */
  writesNoNotes = false;
  /** presenceSet / presenceClear answer this much later (a slow folder). */
  presenceLatencyMs = 0;
  /** fixer round 2 (RV-1): note files from other computers arrive online-only (Dropbox / OneDrive / Google Drive
   *  keeping the folder online-only); the first read asks for the download, which takes `noteHydrateMs` while
   *  online and does not happen while offline (presence.rs `read_notes`). */
  notesOnlineOnly = false;
  noteHydrateMs = 1000;
  /** The last text read per note file (presence.rs NoteCache): what an online-only note still on its way counts as. */
  private readonly noteLastRead = new Map<string, string>();
  private readonly noteHydrating = new Set<string>();
  private readonly noteFilesMap = new Map<string, LocalNote>();
  private readonly noteDeletes = new Map<string, number>();
  private readonly waitingNoteUp = new Set<string>();
  private readonly waitingNoteDown = new Set<string>();
  private readonly ownNotes = new Map<string, OwnNote>();
  private readonly noteSeenMap = new Map<string, { sha: string; since: number }>();
  private readonly noteWritten = new Set<string>();
  private aliases: string[] = [];
  /** The highest seq written per document path in this launch (fixer F9: never lower after a clear). */
  private readonly seqFloor = new Map<string, number>();
  private closing = false;
  private asleep = false;
  private sleptAt = 0;
  private crashed = false;
  /** Bumped by crash / quit: timers and listeners of the app that ran before stop for good. */
  private generation = 0;
  private deferred: (() => void)[] = [];
  private sessionSeq = 1;
  private idSeq = 0;
  /** Last `presence` signature sent per tracked path (§3.6). */
  private readonly notesSig = new Map<string, string>();
  /** Every presence command, for assertions. */
  readonly presenceCalls: { cmd: string; args: unknown; at: number }[] = [];

  constructor(private readonly world: MemoryWorld, opts: DeviceOptions) {
    this.name = opts.device_name;
    this.deviceId = opts.device_id;
    this.defaults = { device_name: opts.device_name, user_name: opts.user_name ?? "User" };
    this.identity = {
      device_id: opts.device_id, device_name: opts.device_name, user_name: opts.user_name ?? "User",
      session_id: opts.session_id ?? `s-${opts.device_id}-1`,
    };
    this.uploadDelayMs = opts.uploadDelayMs ?? 0;
    this.downloadDelayMs = opts.downloadDelayMs ?? 0;
    this.partialDeliveryMs = opts.partialDeliveryMs ?? 0;
    this.online = opts.online ?? true;
    this.info = {
      appVersion: "test", platform: "macos", homeDir: "/Users/me", tempDirs: [], stateDir: "(memory)", debug: true,
      ...(opts.appInfo ?? {}),
    };
    this.strictFolders = !!opts.strictFolders;
    for (const f of opts.folders ?? []) this.folderSet.add(f);
    this.noteUploadDelayMs = opts.noteUploadDelayMs ?? this.uploadDelayMs;
    this.noteDownloadDelayMs = opts.noteDownloadDelayMs ?? this.downloadDelayMs;
  }

  // ── FileBackend ──

  async device(): Promise<DeviceIdentity> { return { ...this.identity }; }

  /** Sync runs: online, awake and running. */
  private syncing(): boolean { return this.online && !this.asleep && !this.crashed; }

  async read(path: string): Promise<ReadResult> {
    const f = this.check(path);
    if ("code" in f) return f;
    this.journalAdd(path, f.data);
    const tooNew = (f.data.manifest.min_reader_version ?? 1) > READER_VERSION;
    return { ok: true, file: clone(f.data), stat: this.statOf(path, f), readOnly: tooNew ? "tooNew" : null };
  }

  async header(path: string): Promise<HeaderResult> {
    const f = this.check(path);
    if ("code" in f) return f;
    return { ok: true, header: headerOf(f.data), stat: this.statOf(path, f) };
  }

  async save(req: SaveRequest): Promise<SaveResult> {
    this.saves.push(clone(req));
    if (this.isDenied(parentDir(req.path))) return saveErr("PermissionDenied", "The folder can't be written to.");
    if (!req.path.toLowerCase().endsWith(`.${GRAPH_EXT}`)) return saveErr("Invalid", "Not an analysis file name.");
    if (this.strictFolders && !this.folderExists(parentDir(req.path))) return saveErr("NotFound", "The folder doesn't exist.");
    // Identity assertion (§7 step 2).
    if (req.manifest.analysis_id !== req.analysisId) return saveErr("IdentityMismatch", "The file's analysis id isn't this document's.");
    const owner = this.session.tabs.find((t) => t.path === req.path);
    if (owner && owner.doc_key !== req.docKey) return saveErr("IdentityMismatch", "Another open document is saved at this path.");

    let path = req.path;
    let local = this.files.get(path);
    if (!local && req.expectedHead !== null) {
      // Gone: the safe follow rule, inside the save (§7 step 3.1).
      const to = this.followCandidates(path, req.analysisId, req.expectedHead).follow;
      if (!to) return { ok: false, kind: "missing" };
      path = to;
      local = this.files.get(to)!;
      const moved = this.retrack(req.path, to);
      if (moved) this.emit({ type: "moved", from: req.path, to, head: moved.head ?? "" });
    }
    const offline = this.offlineNext.delete(path);
    const readable = local && !offline && !local.dataless && !local.incomplete && fileProblem(local.data) === null ? local : null;
    if (readable && readable.data.manifest.analysis_id !== req.analysisId && !req.replaceExisting) {
      return saveErr("IdentityMismatch", "A different analysis is saved at this path.");
    }
    const file = this.assemble(req, readable);
    if (typeof file === "string") return saveErr("Invalid", file);

    if (req.expectedHead === null) {
      if (local && !req.replaceExisting) {
        if (!readable) return saveErr("Invalid", "A file that is not an analysis is in the way.");
        return { ok: false, kind: "conflict", head: local.data.manifest.head };
      }
      if (local) this.addDisplaced(path, local.data, "replaced");
      return { ok: true, kind: "saved", path, head: file.manifest.head, stat: this.write(path, file, local?.cloudRev ?? 0) };
    }
    if (readable && (readable.data.manifest.min_reader_version ?? 1) > READER_VERSION) {
      return saveErr("TooNew", "Made with a newer version of Lab Analysis Suite; saving would lose its changes.");
    }
    if (!readable) {
      // The head on disk can't be established: never overwrite (§7 step 3.2).
      // A repeated save replaces the aside copy this device wrote earlier, while nobody changed it (as Rust does).
      const stem = `${fileStem(path)} (unsynced from ${this.identity.device_name})`;
      let aside = `${parentDir(path)}/${stem}.${GRAPH_EXT}`;
      for (let i = 2; this.files.has(aside) && this.asides.get(aside) !== this.files.get(aside)!.data.manifest.head; i++) {
        aside = `${parentDir(path)}/${stem} ${i}.${GRAPH_EXT}`;
      }
      this.asides.set(aside, file.manifest.head);
      return { ok: true, kind: "savedAside", path: aside, head: file.manifest.head, stat: this.write(aside, file, 0) };
    }
    if (readable.data.manifest.head !== req.expectedHead) return { ok: false, kind: "conflict", head: readable.data.manifest.head };
    // What is actually replaced (normally the file checked; armDisplace scripts a remote save landing in the gap).
    const replaced = this.displaceNext.get(path) ?? readable.data;
    this.displaceNext.delete(path);
    const stat = this.write(path, file, readable.cloudRev);
    if (replaced.manifest.head === req.expectedHead) return { ok: true, kind: "saved", path, head: file.manifest.head, stat };
    this.addDisplaced(path, replaced, "replaced");
    this.journalAdd(path, replaced);
    return { ok: true, kind: "savedButDisplaced", path, head: file.manifest.head, stat, displacedHead: replaced.manifest.head };
  }

  async scanDir(dir: string): Promise<ScanResult> {
    if (this.isDenied(dir)) return err("PermissionDenied", "The folder can't be read.");
    if (this.strictFolders && !this.folderExists(dir)) return err("NotFound", "No such folder.");
    const entries: DirEntry[] = [];
    for (const [path, f] of this.files) {
      if (parentDir(path) !== dir) continue;
      const name = path.slice(path.lastIndexOf("/") + 1);
      if (name.startsWith(".")) continue;
      const ext = name.slice(name.lastIndexOf(".") + 1);
      const kind = ext === GRAPH_EXT ? "graph" : ext === PRESENCE_EXT ? "presence" : "other";
      if (kind === "other") continue;
      const valid = !f.dataless && !f.incomplete && fileProblem(f.data) === null;
      entries.push({
        name, path, size: JSON.stringify(f.data).length, mtime: f.mtime, kind,
        dataless: f.dataless, header: valid ? headerOf(f.data) : null,
      });
    }
    // Phase 3: note files are listed as "presence" (never analyses).
    for (const [path, n] of this.noteFilesMap) {
      if (parentDir(path) !== dir) continue;
      const name = path.slice(path.lastIndexOf("/") + 1);
      if (!isNoteFileName(name)) continue;
      entries.push({ name, path, size: utf8Length(n.text), mtime: n.mtime, kind: "presence", dataless: false, header: null });
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { ok: true, entries };
  }

  async readSession(): Promise<GraphSession> { return clone(this.session); }
  async writeSession(s: GraphSession): Promise<void> { this.session = clone(s); this.world.touch(); }
  async readDraft(docKey: string): Promise<DraftRecord | null> { const d = this.drafts.get(docKey); return d ? clone(d) : null; }
  async writeDraft(d: DraftRecord): Promise<void> { this.drafts.set(d.doc_key, clone(d)); this.world.touch(); }
  async deleteDraft(docKey: string): Promise<void> { this.drafts.delete(docKey); this.world.touch(); }
  async listDrafts(): Promise<DraftRecord[]> { return [...this.drafts.values()].map(clone); }

  async journalHeads(analysisId: string, path?: string): Promise<JournalHead[]> {
    return this.journalIdx.filter((j) => j.analysis_id === analysisId && (path === undefined || j.path === path)).map((j) => ({ ...j }));
  }

  async readJournal(analysisId: string, revisionId: string): Promise<GraphFileData | null> {
    const d = this.journalData.get(analysisId)?.get(revisionId);
    return d ? clone(d) : null;
  }

  async writeJournal(path: string, file: GraphFileData): Promise<void> {
    const problem = fileProblem(file);
    if (problem) throw new Error(`writeJournal: ${problem}`);
    this.journalAdd(path, file, false);     // not seen on disk: confirms nothing
  }

  async listDisplaced(): Promise<DisplacedEntry[]> { return [...this.displaced.values()].map((d) => ({ ...d.entry })); }
  async readDisplaced(id: string): Promise<GraphFileData | null> { const d = this.displaced.get(id); return d ? clone(d.data) : null; }

  async readRecent(): Promise<RecentEntry[]> { return clone(this.recent); }
  async writeRecent(entries: RecentEntry[]): Promise<void> {
    const seen = new Set<string>();
    this.recent = clone(entries.filter((e) => !seen.has(e.path) && (seen.add(e.path), true)).slice(0, RECENT_MAX));
    this.world.touch();
  }

  async readExportMap(): Promise<ExportMap> { return clone(this.exportMap); }
  async writeExportMap(m: ExportMap): Promise<void> { this.exportMap = clone(m); this.world.touch(); }

  track(path: string, opts: { active?: boolean } = {}): void {
    const f = this.files.get(path);
    const prev = this.tracked.get(path);
    const data = f && !f.dataless ? f.data : null;
    const t: Tracked = prev ?? {
      active: false, head: null, analysisId: null, checking: false, state: "ok", reason: null, siblingHeads: new Map(),
    };
    t.active = !!opts.active;
    if (!prev) {
      t.head = data?.manifest.head ?? null;
      t.analysisId = data?.manifest.analysis_id ?? null;
    }
    this.tracked.set(path, t);
    // Same-id files already beside it are copies, never rename targets; remembered with their head.
    if (t.analysisId) for (const p of this.sameIdBeside(path, t.analysisId)) {
      this.copiesOf(path).add(p);
      if (!t.siblingHeads.has(p)) t.siblingHeads.set(p, this.files.get(p)!.data.manifest.head);
    }
    // The poll's first look at the notes beside it (an event when there are any; §3.6).
    if (!prev) void Promise.resolve().then(() => this.notePollPath(path));
  }

  untrack(path: string): void { this.tracked.delete(path); this.copyTable.delete(path); this.notesSig.delete(path); }

  subscribe(listener: (e: FileEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  // ── FileBackendP1 ──

  async appInfo(): Promise<AppInfo> { return { ...this.info, tempDirs: [...this.info.tempDirs] }; }

  async setDevice(patch: DevicePatch): Promise<DeviceIdentity> {
    const fix = (v: string | undefined, def: string, cur: string) => {
      if (v === undefined) return cur;
      const t = v.trim().slice(0, 60);
      return t || def;
    };
    this.identity = {
      ...this.identity,
      device_name: fix(patch.deviceName, this.defaults.device_name, this.identity.device_name),
      user_name: fix(patch.userName, this.defaults.user_name, this.identity.user_name),
    };
    this.world.touch();
    return { ...this.identity };
  }

  locate(dir: string, analysisId: string, onProgress?: (p: LocateProgress) => void): { token: string; result: Promise<LocateResult> } {
    const token = `loc-${this.deviceId}-${++this.locateSeq}`;
    const result = (async (): Promise<LocateResult> => {
      await Promise.resolve();
      if (this.cancelled.delete(token)) return { ok: false, code: "Cancelled", message: "The search was stopped." };
      if (this.isDenied(dir)) return { ok: false, code: "PermissionDenied", message: "The folder can't be read." };
      if (!this.folderExists(dir)) return { ok: false, code: "NotFound", message: "No such folder." };
      const base = dir.endsWith("/") ? dir.slice(0, -1) : dir;
      const matches: LocateMatch[] = [];
      const onlineOnly: string[] = [];
      let onlineOnlyCount = 0;
      const skipped = new Set<string>();
      let truncated: "depth" | null = null;
      let scanned = 0;
      for (const path of [...this.files.keys()].sort()) {
        if (!path.startsWith(base + "/")) continue;
        const segs = path.slice(base.length + 1).split("/");
        const folders = segs.slice(0, -1);
        const name = segs[segs.length - 1];
        if (folders.some((s) => s.startsWith(".") || s === "node_modules" || BUNDLE_RE.test(s))) continue;
        if (folders.length > 8) { truncated = "depth"; continue; }
        const folder = parentDir(path);
        if (this.isDenied(folder)) {
          const top = [...this.denied].find((d) => under(folder, d)) ?? folder;
          if (skipped.size < 20) skipped.add(top);
          continue;
        }
        scanned++;
        if (name.startsWith(".") || !name.toLowerCase().endsWith(`.${GRAPH_EXT}`)) continue;
        const f = this.files.get(path)!;
        if (f.dataless) { onlineOnlyCount++; if (onlineOnly.length < 50) onlineOnly.push(path); continue; }
        if (f.incomplete || fileProblem(f.data) !== null || f.data.manifest.analysis_id !== analysisId) continue;
        const head = f.data.manifest.revisions.find((r) => r.id === f.data.manifest.head)!;
        matches.push({
          path, head: head.id, stat: this.statOf(path, f), userName: head.user_name, deviceName: head.device_name, time: head.time,
        });
      }
      onProgress?.({ token, scanned, matches: matches.length });
      matches.sort((a, b) => b.stat.mtime - a.stat.mtime || (a.path < b.path ? -1 : 1));
      return { ok: true, matches, onlineOnly, onlineOnlyCount, skippedFolders: [...skipped].sort(), truncated, scanned };
    })();
    return { token, result };
  }

  cancelLocate(token: string): void { this.cancelled.add(token); }

  /** Events are sent as the simulated disk changes, so there is nothing to look at now. */
  pollNow(): void { /* no-op */ }

  async reveal(_path: string): Promise<void> { /* no-op in the preview */ }

  // ── FileBackendP2 ──

  async peek(path: string): Promise<PeekResult> {
    const f = this.check(path);
    if ("code" in f) return f;
    const tooNew = (f.data.manifest.min_reader_version ?? 1) > READER_VERSION;
    return { ok: true, manifest: clone(f.data.manifest), stat: this.statOf(path, f), readOnly: tooNew ? "tooNew" : null };
  }

  /** Phase 2 contract §4.2 steps 2–8 on the simulated disk: the copy is moved into displaced/ only when its
   *  newest version is the keeper's newest version or one of its ancestors, both re-read now. */
  async removeCopy(req: RemoveCopyArgs): Promise<RemoveCopyResult> {
    this.pruneDisplaced();
    const fail = (code: FileErrorCode, message: string): RemoveCopyResult => ({ ...err(code, message), kind: "error" });
    const refuse = (reason: "notOlder" | "otherAnalysis" | "sameFile" | "open", head: string | null, keeperHead: string | null): RemoveCopyResult =>
      ({ ok: false, kind: "refused", reason, head, keeperHead });
    if (!req.path.toLowerCase().endsWith(`.${GRAPH_EXT}`) || !req.keeper.toLowerCase().endsWith(`.${GRAPH_EXT}`)) return fail("Invalid", "Not an analysis file name.");
    if (this.tracked.has(req.path)) return refuse("open", null, null);
    const copy = this.check(req.path);
    if ("code" in copy) return fail(copy.code, copy.message);
    const keeper = this.check(req.keeper);
    if ("code" in keeper) return fail(keeper.code, keeper.message);
    const ch = copy.data.manifest.head;
    const kh = keeper.data.manifest.head;
    if (req.path.toLowerCase() === req.keeper.toLowerCase() || copy === keeper) return refuse("sameFile", ch, kh);
    if (copy.data.manifest.analysis_id !== req.analysisId || keeper.data.manifest.analysis_id !== req.analysisId) return refuse("otherAnalysis", ch, kh);
    if (!isAncestorOrSelf(keeper.data.manifest, ch, kh)) return refuse("notOlder", ch, kh);
    const id = this.addDisplaced(req.path, copy.data, "removedCopy");
    this.files.delete(req.path);
    this.deletes.set(req.path, copy.cloudRev);
    this.queueUpload(req.path);
    for (const [tp, t] of this.tracked) { t.siblingHeads.delete(req.path); this.copyTable.get(tp)?.delete(req.path); }
    this.emitFor(req.path);
    this.world.touch();
    return { ok: true, kind: "removed", displacedId: id, head: ch };
  }

  async readSeen(): Promise<SeenMap> { return clone(this.seen); }
  async writeSeen(seen: SeenMap): Promise<void> {
    if (!seen || typeof seen.analyses !== "object" || seen.analyses === null) throw new Error("writeSeen: Invalid");
    this.seen = clone(seen);
    this.world.touch();
  }

  /** Extra copies removed on this computer (newest first), for the simulator. */
  removedCopies(): { id: string; original: string; at: number }[] {
    this.pruneDisplaced();
    return [...this.displaced.values()].filter((d) => d.entry.reason === "removedCopy")
      .map((d) => ({ id: d.entry.id, original: d.entry.original, at: d.entry.at }))
      .sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));
  }

  /** Displaced entries older than LIMITS_P2.removedKeepMs go (as the app does at startup). */
  private pruneDisplaced(): void {
    const now = this.world.clock.now();
    for (const [id, d] of [...this.displaced]) if (now - d.entry.at > LIMITS_P2.removedKeepMs) this.displaced.delete(id);
  }

  // ── FileBackendP3: notes (phase3-contract.md §3.2–§3.9) ──

  private noteNow(): number { return this.world.clock.now(); }

  /** Own = this computer's current device id only. An earlier id (`aliases`) may be another running
   *  computer's (a migrated / cloned Mac): its notes are foreign (fixer VP-1; presence.rs `identity`). */
  private isOwnId(id: string): boolean { return id === this.identity.device_id; }

  /** After `presenceLatencyMs` (0: at once, before the first await of the caller). */
  private later<T>(fn: () => T): Promise<T> {
    if (this.presenceLatencyMs <= 0) {
      try { return Promise.resolve(fn()); } catch (e) { return Promise.reject(e); }
    }
    return new Promise((resolve, reject) => {
      this.world.clock.schedule(this.presenceLatencyMs, () => { try { resolve(fn()); } catch (e) { reject(e); } });
    });
  }

  async presenceSet(req: PresenceSetArgs): Promise<PresenceSetResult> {
    this.presenceCalls.push({ cmd: "presenceSet", args: clone(req), at: this.noteNow() });
    return this.later(() => this.presenceSetNow(req));
  }

  private presenceSetNow(req: PresenceSetArgs): PresenceSetResult {
    const fail = (code: FileErrorCode, message: string): PresenceSetResult => ({ ok: false, code, message });
    if (!req || typeof req.docPath !== "string" || !req.docPath.startsWith("/") || !req.docPath.toLowerCase().endsWith(`.${GRAPH_EXT}`)) {
      return fail("Invalid", "Not an analysis file path.");
    }
    if (typeof req.analysisId !== "string" || !req.analysisId || !(req.epoch >= 0) || (req.state !== "idle" && req.state !== "editing")) {
      return fail("Invalid", "Bad note request.");
    }
    if (this.closing || this.crashed) return { ok: true, kind: "off", reason: "closing" };
    const roots = this.world.noteRoots;
    if (this.writesNoNotes || (roots && !roots.some((r) => under(req.docPath, r)))) return { ok: true, kind: "off", reason: "debugRoot" };
    const dir = parentDir(req.docPath);
    if (this.isDenied(dir)) return fail("PermissionDenied", "The folder can't be written to.");
    if (!this.folderExists(dir)) return fail("NotFound", "The folder doesn't exist.");
    const docName = req.docPath.slice(dir.length + 1);
    const doc = { analysisId: req.analysisId, fileName: docName, sameIdFiles: this.sameIdCount(dir, req.analysisId) };
    const reg = this.ownNotes.get(req.docPath);
    const mine = this.ownNotesIn(dir).filter((x) => noteApplies(x.note, doc));
    const seq = 1 + Math.max(reg?.note.seq ?? 0, this.seqFloor.get(req.docPath) ?? 0, ...mine.map((x) => x.note.seq), 0);
    const editing = req.state === "editing";
    const note: NoteJson = {
      format: "lasgraph-presence", v: 1, analysis_id: req.analysisId, document_name: docName,
      device_id: this.identity.device_id, session_id: this.identity.session_id, device_name: this.identity.device_name,
      user_name: this.identity.user_name, state: req.state, head: req.head ?? null, base_revision: editing ? req.baseRevision ?? null : null,
      epoch: req.epoch, seq, supersedes: editing && req.supersedes?.length ? req.supersedes.map((t) => ({ device_id: t.device_id, epoch: t.epoch })) : null,
      updated_at: new Date(this.noteNow() + this.clockSkewMs).toISOString(), request_to: null, handover_to: null, features: 2,
    };
    // The file name (§1.2): attempt 0 → 1 → 2 while another device's note (or anything that is not my note
    // about this document) has that name.
    let file: string | null = null;
    for (const attempt of [0, 1, 2] as const) {
      const p = `${dir}/${noteFileName(docName, this.identity.device_name, this.identity.device_id, attempt)}`;
      const there = this.noteFilesMap.get(p);
      if (!there) { file = p; break; }
      const n = parseNote(there.text);
      if (n && this.isOwnId(n.device_id) && noteApplies(n, doc)) { file = p; break; }
      if (attempt === 2) {
        if (n && !this.isOwnId(n.device_id)) file = p;            // matching is by content: written anyway
        else return fail("Io", "A file that is not this computer's note has that name.");
      }
    }
    const target = file!;
    this.writeNoteFile(target, noteText(note));
    // Every other own note about this document goes (an old name, a conflict copy of mine); a registration of
    // another document path whose note that was (a rename in the same folder) goes with it (fixer VS-2).
    for (const x of mine) {
      if (x.file === target) continue;
      this.deleteNoteFile(x.file);
      for (const [k, o] of [...this.ownNotes]) {
        if (k !== req.docPath && o.file === x.file) { if (o.timer) o.timer.cancelled = true; this.ownNotes.delete(k); }
      }
    }
    if (reg?.timer) reg.timer.cancelled = true;
    const own: OwnNote = {
      file: target, note, lastWrite: this.noteNow(), lastInput: req.input ? this.noteNow() : reg?.lastInput ?? null, beating: true, timer: null,
    };
    if (reg && reg.file !== target && !mine.some((x) => x.file === reg.file)) this.deleteOwnIfMine(reg.file);
    this.ownNotes.set(req.docPath, own);
    this.seqFloor.set(req.docPath, seq);
    this.noteWritten.add(target);
    this.noteSeenMap.set(target, { sha: noteSha(noteText(note)), since: this.noteNow() });
    this.scheduleBeat(req.docPath, own);
    this.notePoll(dir);
    this.world.touch();
    return { ok: true, kind: "written", file: target, note: clone(note) };
  }

  async presenceClear(docPath: string): Promise<void> {
    this.presenceCalls.push({ cmd: "presenceClear", args: docPath, at: this.noteNow() });
    return this.later(() => this.presenceClearNow(docPath));
  }

  private presenceClearNow(docPath: string): void {
    const reg = this.ownNotes.get(docPath);
    if (reg?.timer) reg.timer.cancelled = true;
    this.ownNotes.delete(docPath);
    if (this.crashed) return;
    const dir = parentDir(docPath);
    if (reg) this.deleteOwnIfMine(reg.file);
    const aid = reg?.note.analysis_id;
    const docName = docPath.slice(dir.length + 1);
    const otherDocs = new Set([...this.ownNotes.values()].map((o) => o.file));
    for (const x of this.ownNotesIn(dir)) {
      if (otherDocs.has(x.file)) continue;                       // registered for another document path
      const applies = aid ? noteApplies(x.note, { analysisId: aid, fileName: docName, sameIdFiles: this.sameIdCount(dir, aid) })
        : x.note.document_name.normalize("NFC").toLowerCase() === docName.normalize("NFC").toLowerCase();
      if (applies) this.deleteNoteFile(x.file);
    }
    this.notePoll(dir);
    this.world.touch();
  }

  presenceInput(docPath: string): void {
    this.presenceCalls.push({ cmd: "presenceInput", args: docPath, at: this.noteNow() });
    const reg = this.ownNotes.get(docPath);
    if (!reg || this.crashed) return;
    reg.lastInput = this.noteNow();
    if (reg.note.state === "editing" && reg.beating && !reg.timer) this.scheduleBeat(docPath, reg);
  }

  async presenceList(docPath: string, analysisId: string): Promise<PresenceListResult> {
    this.presenceCalls.push({ cmd: "presenceList", args: { docPath, analysisId }, at: this.noteNow() });
    if (!docPath.toLowerCase().endsWith(`.${GRAPH_EXT}`)) return { ok: false, code: "Invalid", message: "Not an analysis file path." };
    const dir = parentDir(docPath);
    if (this.isDenied(dir)) return { ok: false, code: "PermissionDenied", message: "The folder can't be read." };
    const r = this.scanNotes(docPath, analysisId);
    return { ok: true, notes: r.notes, truncated: r.truncated };
  }

  async presenceRemoveForeign(req: RemoveNoteArgs): Promise<boolean> {
    this.presenceCalls.push({ cmd: "presenceRemoveForeign", args: clone(req), at: this.noteNow() });
    const name = req.file.slice(req.file.lastIndexOf("/") + 1);
    if (!req.file.startsWith("/") || !isNoteFileName(name)) return false;
    const there = this.noteFilesMap.get(req.file);
    if (!there) return false;                                    // gone
    const n = utf8Length(there.text) <= LIMITS_P3.noteMaxBytes ? parseNote(there.text) : null;
    if (!n) return false;                                        // notANote
    if (noteSha(there.text) !== req.sha) return false;           // changed
    if (this.isOwnId(n.device_id)) return false;                 // own
    this.deleteNoteFile(req.file);
    this.noteSeenMap.delete(req.file);
    this.notePoll(parentDir(req.file));
    this.world.touch();
    return true;
  }

  async cloudInfo(path: string): Promise<CloudInfo> {
    const root = this.world.syncRoot(path);
    return root ? { cloud: true, service: this.world.serviceName, root: root.length > 1 && root.endsWith("/") ? root.slice(0, -1) : root } : { cloud: false, service: null, root: null };
  }

  async newDeviceId(): Promise<DeviceIdentity> {
    this.presenceCalls.push({ cmd: "newDeviceId", args: null, at: this.noteNow() });
    const old = { device_id: this.identity.device_id, session_id: this.identity.session_id };
    this.aliases = [...this.aliases, old.device_id].slice(-16);
    const n = ++this.idSeq;
    this.identity = {
      ...this.identity, device_id: `d-${this.deviceId.replace(/^d-/, "")}-new${n}`, session_id: `s-${this.deviceId}-${++this.sessionSeq}`,
    };
    const files = new Set<string>([...[...this.ownNotes.values()].map((o) => o.file), ...this.noteWritten]);
    for (const o of this.ownNotes.values()) if (o.timer) o.timer.cancelled = true;
    this.ownNotes.clear();
    // My notes under the old identity (this launch's session) go now; the other computer that keeps the old id
    // writes its notes with another session id, and those are never touched (presence.rs forget_own).
    for (const f of files) {
      const t = this.noteFilesMap.get(f);
      const note = t ? parseNote(t.text) : null;
      if (note && note.device_id === old.device_id && note.session_id === old.session_id) {
        this.deleteNoteFile(f); this.noteWritten.delete(f); this.noteSeenMap.delete(f); this.notePoll(parentDir(f));
      }
    }
    this.world.touch();
    return { ...this.identity };
  }

  // ── phase 3: what the person / the OS does to this computer ──

  /** The controller's timers on this computer (see DeviceTimers). */
  timers(): DeviceTimers {
    return {
      setTimeout: (fn, ms) => {
        const h = { cancelled: false };
        this.devSchedule(ms, () => { if (!h.cancelled) fn(); });
        return h;
      },
      clearTimeout: (h) => { if (h && typeof h === "object") (h as { cancelled: boolean }).cancelled = true; },
    };
  }

  /** A timer of this computer: late while it sleeps, gone after a crash or quit. */
  private devSchedule(ms: number, fn: () => void): void {
    const gen = this.generation;
    this.world.clock.schedule(ms, () => {
      if (gen !== this.generation || this.crashed) return;
      if (this.asleep) { this.deferred.push(() => { if (gen === this.generation && !this.crashed) fn(); }); return; }
      fn();
    });
  }

  isAsleep(): boolean { return this.asleep; }
  isCrashed(): boolean { return this.crashed; }

  /** The computer sleeps for `ms` (nothing of it runs, nothing syncs), then wakes up. */
  sleep(ms: number): void {
    if (this.asleep || this.crashed) return;
    this.asleep = true;
    this.sleptAt = this.noteNow();
    this.world.clock.schedule(ms, () => this.wake());
  }

  /** Wake up now: the poll notices the gap (beating stops until the next presenceSet), timers that were due run,
   *  and sync catches up. */
  wake(): void {
    if (!this.asleep) return;
    this.asleep = false;
    const gapMs = this.noteNow() - this.sleptAt;
    // Beating stops until the next presenceSet, and input from before the sleep no longer counts (fixer VP-5).
    for (const o of this.ownNotes.values()) { o.beating = false; o.lastInput = null; if (o.timer && o.note.state === "editing") { o.timer.cancelled = true; o.timer = null; } }
    this.emit({ type: "wake", gapMs });
    const run = this.deferred;
    this.deferred = [];
    for (const fn of run) this.world.clock.schedule(0, fn);
    this.flushWaiting();
  }

  /** Crash / power loss: its notes stay as they are; nothing of this app runs any more (no timers, events or sync). */
  crash(): void {
    this.crashed = true;
    this.asleep = false;
    this.deferred = [];
    this.generation++;
    for (const o of this.ownNotes.values()) if (o.timer) o.timer.cancelled = true;
    this.ownNotes.clear();
    this.listeners.clear();
    this.tracked.clear();
    this.notesSig.clear();
  }

  /** The app quits: every own note is deleted (presence::delete_all_own); the sync client keeps running. */
  quit(): void {
    this.closing = true;
    // Only this launch's notes (fixer VS-5); leftovers of earlier launches go with the next start's sweep.
    for (const [, o] of this.ownNotes) { if (o.timer) o.timer.cancelled = true; this.deleteOwnIfMine(o.file, this.identity.session_id); }
    for (const f of [...this.noteWritten]) this.deleteOwnIfMine(f, this.identity.session_id);
    this.ownNotes.clear();
    this.generation++;
    this.deferred = [];
    this.listeners.clear();
    this.tracked.clear();
    this.notesSig.clear();
    this.world.touch();
  }

  /** The app starts again (after a crash or a quit): a new session id; sync catches up. The startup sweep
   *  (§3.8) runs `sweepMs` later. */
  relaunch(sweepMs = 20_000): void {
    this.crashed = false;
    this.closing = false;
    this.asleep = false;
    this.seqFloor.clear();
    this.identity = { ...this.identity, session_id: `s-${this.deviceId}-${++this.sessionSeq}` };
    this.flushWaiting();
    this.devSchedule(sweepMs, () => this.startupSweep());
  }

  /** §3.8: own notes of another session that nothing registered are deleted; entries of gone files dropped. */
  startupSweep(): void {
    const registered = new Set([...this.ownNotes.values()].map((o) => o.file));
    for (const f of [...this.noteWritten]) {
      const n = this.noteFilesMap.get(f);
      if (!n) { this.noteWritten.delete(f); continue; }
      const note = parseNote(n.text);
      if (registered.has(f) || !note || !this.isOwnId(note.device_id) || note.session_id === this.identity.session_id) continue;
      this.deleteNoteFile(f);
      this.noteWritten.delete(f);
      this.notePoll(parentDir(f));
    }
    this.world.touch();
  }

  /** Notes and analysis files reach the service / this computer `ms` later (what: notes only, files only, or both). */
  setSyncDelay(ms: number, what: "all" | "notes" | "files" = "all"): void {
    if (what !== "files") { this.noteUploadDelayMs = ms; this.noteDownloadDelayMs = ms; }
    if (what !== "notes") { this.uploadDelayMs = ms; this.downloadDelayMs = ms; }
  }

  /** This computer's clock is wrong by `ms`: only the `updated_at` it writes moves. */
  setClockSkew(ms: number): void { this.clockSkewMs = ms; }

  /** Put a note file on this disk as if it had arrived (another computer's note, a hand-made file); it syncs. */
  placeNote(path: string, text: string): void {
    this.writeNoteFile(path, text);
    this.notePoll(parentDir(path));
    this.world.touch();
  }

  /** Delete a note file on this disk (Finder); it syncs. */
  removeNote(path: string): boolean {
    if (!this.noteFilesMap.has(path)) return false;
    this.deleteNoteFile(path);
    this.notePoll(parentDir(path));
    this.world.touch();
    return true;
  }

  /** Note files in `dir` on this disk, sorted by name. */
  noteFiles(dir: string): { path: string; name: string; text: string; note: NoteJson | null }[] {
    return [...this.noteFilesMap.entries()].filter(([p]) => parentDir(p) === dir).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([p, n]) => ({ path: p, name: p.slice(dir.length + 1), text: n.text, note: parseNote(n.text) }));
  }

  /** Every note file on this disk (all folders), sorted by path. */
  allNoteFiles(): string[] { return [...this.noteFilesMap.keys()].sort(); }

  /** This computer's registered notes: document path → note, and whether it is kept beating. */
  ownNoteState(docPath: string): { file: string; note: NoteJson; beating: boolean } | null {
    const o = this.ownNotes.get(docPath);
    return o ? { file: o.file, note: clone(o.note), beating: o.beating && !this.crashed } : null;
  }

  /** The note text at `path` on this disk (null = none). */
  noteTextAt(path: string): string | null { return this.noteFilesMap.get(path)?.text ?? null; }

  // ── phase 3 internals ──

  private ownNotesIn(dir: string): { file: string; note: NoteJson }[] {
    const out: { file: string; note: NoteJson }[] = [];
    for (const [p, n] of this.noteFilesMap) {
      if (parentDir(p) !== dir) continue;
      const note = parseNote(n.dataless ? this.noteLastRead.get(p) ?? "" : n.text);
      if (note && this.isOwnId(note.device_id)) out.push({ file: p, note });
    }
    return out;
  }

  /** Complete local analysis files of `dir` with this analysis id. */
  private sameIdCount(dir: string, aid: string): number {
    let k = 0;
    for (const [p, f] of this.files) {
      if (parentDir(p) === dir && p.toLowerCase().endsWith(`.${GRAPH_EXT}`) && !f.dataless && !f.incomplete && fileProblem(f.data) === null && f.data.manifest.analysis_id === aid) k++;
    }
    return k;
  }

  private writeNoteFile(path: string, text: string): void {
    const prev = this.noteFilesMap.get(path);
    this.noteFilesMap.set(path, { text, cloudRev: prev?.cloudRev ?? 0, dirty: true, mtime: this.noteNow() });
    this.noteDeletes.delete(path);
    this.queueNoteUpload(path);
  }

  private deleteNoteFile(path: string): void {
    const prev = this.noteFilesMap.get(path);
    if (!prev) return;
    this.noteFilesMap.delete(path);
    this.noteDeletes.set(path, prev.cloudRev);
    this.queueNoteUpload(path);
  }

  /** Delete a note file only when it still reads as this computer's note (of `session`, when given). */
  private deleteOwnIfMine(path: string, session?: string): void {
    const n = this.noteFilesMap.get(path);
    const note = n ? parseNote(n.text) : null;
    if (note && this.isOwnId(note.device_id) && (session === undefined || note.session_id === session)) {
      this.deleteNoteFile(path);
      this.noteWritten.delete(path);
      this.noteSeenMap.delete(path);
    } else if (!n) this.noteWritten.delete(path);
  }

  private queueNoteUpload(path: string): void {
    this.world.clock.schedule(this.noteUploadDelayMs, () => {
      if (!this.syncing()) { this.waitingNoteUp.add(path); return; }
      this.world.pushNote(this, path);
    });
  }

  /** The heartbeat (§3.5) for one note: editing + beating + input within 10 min → rewritten every heartbeatMs;
   *  idle → rewritten every 6 h. */
  private scheduleBeat(docPath: string, o: OwnNote): void {
    if (o.timer) { o.timer.cancelled = true; o.timer = null; }
    const editing = o.note.state === "editing";
    if (editing && !o.beating) return;
    const interval = editing ? this.heartbeatMs : LIMITS_P3.idleKeepAliveMs;
    const h = { cancelled: false };
    o.timer = h;
    const due = Math.max(0, o.lastWrite + interval - this.noteNow());
    this.devSchedule(due, () => {
      if (h.cancelled || this.ownNotes.get(docPath) !== o) return;
      o.timer = null;
      if (editing) {
        if (!o.beating) return;
        const recent = this.alwaysInput || (o.lastInput !== null && this.noteNow() - o.lastInput <= LIMITS_P3.inputWindowMs);
        if (!recent) return;                                     // no input for 10 min: quiet; presenceInput restarts it
      }
      if (this.closing || this.crashed) return;
      const note: NoteJson = { ...o.note, seq: o.note.seq + 1, updated_at: new Date(this.noteNow() + this.clockSkewMs).toISOString() };
      o.note = note;
      o.lastWrite = this.noteNow();
      this.seqFloor.set(docPath, Math.max(this.seqFloor.get(docPath) ?? 0, note.seq));
      this.writeNoteFile(o.file, noteText(note));
      this.noteWritten.add(o.file);
      this.noteSeenMap.set(o.file, { sha: noteSha(noteText(note)), since: this.noteNow() });
      this.notePoll(parentDir(o.file));
      this.world.touch();
      this.scheduleBeat(docPath, o);
    });
  }

  /** §3.6 scan_notes. */
  private scanNotes(docPath: string, analysisId: string): { notes: NoteRecord[]; truncated: boolean } {
    const dir = parentDir(docPath);
    const names = [...this.noteFilesMap.keys()].filter((p) => parentDir(p) === dir && isNoteFileName(p.slice(dir.length + 1))).sort();
    const truncated = names.length > LIMITS_P3.notesPerFolder;
    const lagIds = new Set<string>();
    let dataless = false;
    for (const [p, f] of this.files) {
      if (parentDir(p) !== dir || !p.toLowerCase().endsWith(`.${GRAPH_EXT}`)) continue;
      if (f.dataless) { dataless = true; continue; }
      if (!f.incomplete && fileProblem(f.data) === null) lagIds.add(f.data.manifest.analysis_id);
    }
    const docName = docPath.slice(dir.length + 1);
    const sameIdFiles = this.sameIdCount(dir, analysisId);
    const now = this.noteNow();
    const out: NoteRecord[] = [];
    for (const p of names.slice(0, LIMITS_P3.notesPerFolder)) {
      const n = this.noteFilesMap.get(p)!;
      const text = this.readNoteText(p, n);
      if (text === null || utf8Length(text) > LIMITS_P3.noteMaxBytes) continue;
      const note = parseNote(text);
      if (!note) continue;
      const applies = noteApplies(note, { analysisId, fileName: docName, sameIdFiles });
      const orphan = !dataless && !lagIds.has(note.analysis_id);
      if (!applies && !orphan) continue;
      const sha = noteSha(text);
      const rec = this.noteSeenMap.get(p);
      let since = rec && rec.sha === sha ? rec.since : now;
      if (!rec || rec.sha !== sha) this.noteSeenMap.set(p, { sha, since });
      if (!Number.isFinite(since)) since = now;
      out.push({
        file: p, size: utf8Length(text), mtime: n.mtime, sha, unchangedSince: since, note, applies, orphan, own: this.isOwnId(note.device_id),
      });
    }
    for (const p of [...this.noteSeenMap.keys()]) if (parentDir(p) === dir && !this.noteFilesMap.has(p)) this.noteSeenMap.delete(p);
    return { notes: out, truncated };
  }

  /** The poll's look at the notes of every tracked file in `dir` (§3.6 signature rule). */
  private notePoll(dir: string): void {
    for (const p of [...this.tracked.keys()]) if (parentDir(p) === dir) this.notePollPath(p);
  }

  private notePollPath(path: string): void {
    const t = this.tracked.get(path);
    if (!t || this.crashed || this.asleep) return;
    const aid = t.analysisId;
    if (!aid || this.isDenied(parentDir(path))) return;
    const { notes } = this.scanNotes(path, aid);
    const sig = notes.filter((r) => !(r.own && r.note.session_id === this.identity.session_id)).map((r) => `${r.file}\u0000${r.sha}`).sort().join("\u0001");
    const prev = this.notesSig.get(path);
    if (prev === undefined ? notes.length === 0 : prev === sig) { if (prev === undefined) this.notesSig.set(path, sig); return; }
    this.notesSig.set(path, sig);
    this.emit({ type: "presence", path, notes: clone(notes) });
  }

  // ── phase 3: service side (called by MemoryWorld) ──

  /** @internal */
  pendingNoteChange(path: string): { text: string | null; base: number } | null {
    if (this.noteDeletes.has(path)) return { text: null, base: this.noteDeletes.get(path)! };
    const n = this.noteFilesMap.get(path);
    return n?.dirty ? { text: n.text, base: n.cloudRev } : null;
  }

  /** @internal */
  noteUploaded(path: string, rev: number): void {
    this.noteDeletes.delete(path);
    const n = this.noteFilesMap.get(path);
    if (n) { n.dirty = false; n.cloudRev = rev; }
  }

  /** @internal This computer's own upload of a note became a conflict copy. */
  adoptNoteCopy(path: string, text: string, rev: number): void {
    this.noteFilesMap.set(path, { text, cloudRev: rev, dirty: false, mtime: this.noteNow() });
    this.notePoll(parentDir(path));
  }

  /** @internal A service version of note file `path` arrives. */
  receiveNote(path: string, e: NoteCloudEntry): void {
    if (!this.syncing()) { this.waitingNoteDown.add(path); return; }
    const local = this.noteFilesMap.get(path);
    if (local?.dirty || this.noteDeletes.has(path)) return;
    if (local && local.cloudRev >= e.rev) return;
    if (e.text === null) {
      if (local) { this.noteFilesMap.delete(path); this.notePoll(parentDir(path)); this.world.touch(); }
      return;
    }
    this.noteFilesMap.set(path, { text: e.text, cloudRev: e.rev, dirty: false, mtime: this.noteNow(), dataless: this.notesOnlineOnly });
    this.notePoll(parentDir(path));
    this.world.touch();
  }

  /** fixer round 2 (RV-1): the text of a note file as a read gets it now: an online-only file has the last text
   *  read (or none yet) and its download is asked for — it arrives `noteHydrateMs` later while online, and a poll
   *  of the folder follows; nothing waits for it. */
  private readNoteText(path: string, n: LocalNote): string | null {
    if (!n.dataless) { this.noteLastRead.set(path, n.text); return n.text; }
    if (!this.noteHydrating.has(path)) {
      this.noteHydrating.add(path);
      // The cloud client does the download (it keeps going when the app quits or crashes).
      const go = () => {
        if (!this.online) { this.world.clock.schedule(1000, go); return; } // the cloud client keeps trying
        this.noteHydrating.delete(path);
        const cur = this.noteFilesMap.get(path);
        if (cur !== n || !cur.dataless) return;
        cur.dataless = false;
        this.notePoll(parentDir(path));
        this.world.touch();
      };
      this.world.clock.schedule(this.noteHydrateMs, go);
    }
    return this.noteLastRead.get(path) ?? null;
  }

  // ── scripting (what the person or the OS does on this computer) ──

  isOnline(): boolean { return this.online; }

  setOnline(on: boolean): void {
    this.online = on;
    if (!on) return;
    this.flushWaiting();
  }

  private flushWaiting(): void {
    if (!this.syncing()) return;
    for (const p of [...this.waitingUpload]) { this.waitingUpload.delete(p); this.world.push(this, p); }
    for (const p of [...this.waitingDownload]) { this.waitingDownload.delete(p); this.world.deliver(this, p); }
    for (const p of [...this.waitingNoteUp]) { this.waitingNoteUp.delete(p); this.world.pushNote(this, p); }
    for (const p of [...this.waitingNoteDown]) { this.waitingNoteDown.delete(p); this.world.deliverNote(this, p); }
  }

  /** Make a folder exist (for the path picker and strictFolders). */
  addFolder(dir: string): void { this.folderSet.add(dir); this.world.touch(); }

  /** Folders on this computer: the ones made with addFolder and every folder holding a file (with their parents). */
  folderList(): string[] {
    const out = new Set<string>();
    const addWithParents = (d: string) => {
      for (let p = d; p && p !== "/"; p = parentDir(p)) out.add(p);
    };
    for (const d of this.folderSet) addWithParents(d);
    for (const p of this.files.keys()) addWithParents(parentDir(p));
    return [...out].sort();
  }

  /** Delete a file (Finder / Explorer). */
  remove(path: string): boolean {
    const f = this.files.get(path);
    if (!f) return false;
    this.files.delete(path);
    this.deletes.set(path, f.cloudRev);
    this.queueUpload(path);
    this.emitFor(path);
    this.world.touch();
    return true;
  }

  /** Rename a file. The service sees a deletion and, `gapMs` later, a new file. */
  rename(from: string, to: string, gapMs = 0): boolean {
    const f = this.files.get(from);
    if (!f || this.files.has(to)) return false;
    this.remove(from);
    this.files.set(to, { ...f, cloudRev: 0, dirty: true, mtime: this.world.clock.now() });
    this.emitFor(to);
    this.world.clock.schedule(gapMs, () => this.queueUpload(to));
    this.world.touch();
    return true;
  }

  /** Copy a file (Finder duplicate): same analysis id, new path. */
  duplicate(from: string, to: string): boolean {
    const f = this.files.get(from);
    if (!f || this.files.has(to)) return false;
    this.write(to, f.data, 0);
    this.emitFor(to);
    return true;
  }

  /** Put a file on this computer's disk as someone would (a download, a copy from a USB stick): journals nothing. */
  place(path: string, data: GraphFileData): void {
    const prev = this.files.get(path);
    this.files.set(path, { data: clone(data), cloudRev: prev?.cloudRev ?? 0, dirty: true, mtime: this.world.clock.now(), incomplete: false, dataless: false });
    this.deletes.delete(path);
    this.queueUpload(path);
    this.emitFor(path);
    this.world.touch();
  }

  /** Turn a local file into an online-only placeholder. */
  makeDataless(path: string): void {
    const f = this.files.get(path);
    if (!f) return;
    f.dataless = true;
    this.emitFor(path);
    this.world.touch();
  }

  /** Download a placeholder's content (the service's current version). */
  hydrate(path: string): void {
    const f = this.files.get(path);
    if (!f) return;
    const d = this.world.cloudData(path);
    if (d) f.data = d;
    f.dataless = false;
    this.emitFor(path);
    this.world.touch();
  }

  /** The file reads as still arriving for `ms`. */
  setIncomplete(path: string, ms: number): void {
    const f = this.files.get(path);
    if (!f) return;
    f.incomplete = true;
    this.emitFor(path);
    this.world.clock.schedule(ms, () => {
      if (this.files.get(path) !== f || !f.incomplete) return;
      f.incomplete = false;
      this.emitFor(path);
      this.world.touch();
    });
    this.world.touch();
  }

  /** The OS blocks this folder (and what is inside it): reads, listings and writes fail with PermissionDenied. */
  setPermissionDenied(folder: string, on: boolean): void {
    if (on) this.denied.add(folder); else this.denied.delete(folder);
    for (const p of [...this.tracked.keys()]) if (under(parentDir(p), folder) && this.files.has(p)) this.emitFor(p);
    this.world.touch();
  }

  /** The next save of `path` finds `data` in place of the file it checked (a
   *  remote save landing between the check and the replace, plan §7 step 6). */
  armDisplace(path: string, data: GraphFileData): void { this.displaceNext.set(path, clone(data)); }

  /** The next save of `path` cannot establish the head on disk (saved aside). */
  armOffline(path: string): void { this.offlineNext.add(path); }

  /** Head of the local copy (null = no file / placeholder). */
  localHead(path: string): string | null {
    const f = this.files.get(path);
    return f && !f.dataless ? f.data.manifest.head : null;
  }

  /** The local copy's content (null = none / placeholder). */
  localFile(path: string): GraphFileData | null {
    const f = this.files.get(path);
    return f && !f.dataless ? clone(f.data) : null;
  }

  /** Simulator listing: every local file with its state. */
  localEntries(): { path: string; analysisId: string | null; head: string | null; dataless: boolean; incomplete: boolean }[] {
    return [...this.files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, f]) => ({
      path, analysisId: f.data?.manifest?.analysis_id ?? null, head: f.data?.manifest?.head ?? null, dataless: f.dataless, incomplete: f.incomplete,
    }));
  }

  localPaths(): string[] { return [...this.files.keys()].sort(); }

  /** Paths currently tracked (after rename follows). */
  trackedPaths(): string[] { return [...this.tracked.keys()].sort(); }

  /** Every journaled copy (all analyses), for "no saved version is lost" checks. */
  journalCopies(): GraphFileData[] {
    return [...this.journalData.values()].flatMap((m) => [...m.values()]).map(clone);
  }

  // ── persistence ──

  exportState(): MemoryDeviceState {
    return clone({
      identity: this.identity,
      files: [...this.files.entries()],
      session: this.session,
      drafts: [...this.drafts.values()],
      journal: [...this.journalData.entries()].map(([aid, m]) => [aid, [...m.entries()]] as [string, [string, GraphFileData][]]),
      journalIdx: this.journalIdx,
      displaced: [...this.displaced.values()],
      displacedSeq: this.displacedSeq,
      recent: this.recent,
      exportMap: this.exportMap,
      folders: [...this.folderSet],
      denied: [...this.denied],
      seen: this.seen,
      notes: [...this.noteFilesMap.entries()],
      noteSeen: [...this.noteSeenMap.entries()],
      noteWritten: [...this.noteWritten],
      aliases: [...this.aliases],
    });
  }

  importState(s: MemoryDeviceState): void {
    const c = clone(s);
    this.identity = { ...c.identity };
    this.files.clear();
    for (const [p, f] of c.files) this.files.set(p, { ...f, dirty: false });
    this.session = c.session ?? emptySession();
    this.drafts.clear();
    for (const d of c.drafts ?? []) this.drafts.set(d.doc_key, d);
    this.journalData.clear();
    for (const [aid, entries] of c.journal ?? []) this.journalData.set(aid, new Map(entries));
    this.journalIdx.splice(0, this.journalIdx.length, ...(c.journalIdx ?? []));
    this.displaced.clear();
    for (const d of c.displaced ?? []) this.displaced.set(d.entry.id, d);
    this.displacedSeq = c.displacedSeq ?? 0;
    this.recent = c.recent ?? [];
    this.exportMap = c.exportMap ?? emptyExportMap();
    this.folderSet.clear();
    for (const f of c.folders ?? []) this.folderSet.add(f);
    this.denied.clear();
    for (const d of c.denied ?? []) this.denied.add(d);
    this.seen = c.seen && typeof c.seen.analyses === "object" ? c.seen : emptySeenMap();
    this.tracked.clear();
    this.copyTable.clear();
    this.noteFilesMap.clear();
    for (const [p, n] of c.notes ?? []) this.noteFilesMap.set(p, { ...n, dirty: false });
    this.noteSeenMap.clear();
    for (const [p, v] of c.noteSeen ?? []) this.noteSeenMap.set(p, v);
    this.noteWritten.clear();
    for (const p of c.noteWritten ?? []) this.noteWritten.add(p);
    this.aliases = [...(c.aliases ?? [])];
    this.ownNotes.clear();
    this.notesSig.clear();
  }

  // ── service side (called by MemoryWorld) ──

  /** @internal */
  pendingChange(path: string): { data: GraphFileData | null; base: number } | null {
    if (this.deletes.has(path)) return { data: null, base: this.deletes.get(path)! };
    const f = this.files.get(path);
    return f?.dirty ? { data: f.data, base: f.cloudRev } : null;
  }

  /** @internal The pending change of `path` was taken (rev = new service revision, -1 = lost to a newer one). */
  uploaded(path: string, rev: number): void {
    this.deletes.delete(path);
    const f = this.files.get(path);
    if (f) { f.dirty = false; f.cloudRev = rev; }
  }

  /** @internal This computer's own upload became a conflict copy. */
  adoptConflictCopy(path: string, data: GraphFileData, rev: number): void {
    this.files.set(path, { data: clone(data), cloudRev: rev, dirty: false, mtime: this.world.clock.now(), incomplete: false, dataless: false });
    this.emitFor(path);
  }

  /** @internal A service version of `path` arrives. */
  receive(path: string, e: CloudEntry): void {
    if (!this.syncing()) { this.waitingDownload.add(path); return; }
    const local = this.files.get(path);
    if (local?.dirty || this.deletes.has(path)) return;   // own pending change: its upload decides
    if (local && local.cloudRev >= e.rev) return;
    if (!e.data) {
      if (local) { this.files.delete(path); this.emitFor(path); this.world.touch(); }
      return;
    }
    const partial = this.partialDeliveryMs > 0;
    this.files.set(path, {
      data: clone(e.data), cloudRev: e.rev, dirty: false, mtime: this.world.clock.now(), incomplete: partial, dataless: !!local?.dataless,
    });
    this.emitFor(path);
    this.world.touch();
    if (!partial) return;
    this.world.clock.schedule(this.partialDeliveryMs, () => {
      const f = this.files.get(path);
      if (f && f.cloudRev === e.rev && f.incomplete) { f.incomplete = false; this.emitFor(path); this.world.touch(); }
    });
  }

  // ── internals ──

  private isDenied(path: string): boolean {
    for (const d of this.denied) if (under(path, d)) return true;
    return false;
  }

  private folderExists(dir: string): boolean {
    const d = dir.length > 1 && dir.endsWith("/") ? dir.slice(0, -1) : dir;
    if (this.folderSet.has(d)) return true;
    for (const f of this.folderSet) if (f.startsWith(d + "/")) return true;
    for (const p of this.files.keys()) if (p.startsWith(d + "/")) return true;
    return !this.strictFolders;
  }

  private check(path: string): LocalFile | FileError {
    if (this.isDenied(parentDir(path))) return err("PermissionDenied", "The folder can't be read.");
    const f = this.files.get(path);
    if (!f) return err("NotFound", "No file at this path.");
    if (f.dataless) return err("Dataless", "The file hasn't been downloaded to this computer.");
    if (f.incomplete) return err("Incomplete", "The file is still arriving.");
    const problem = fileProblem(f.data);
    return problem ? err("Invalid", problem) : f;
  }

  /** The file a save writes: its manifest plus every part a stored snapshot
   *  references, from newParts, else the file being replaced, else the journal
   *  copy of the base (byte for byte). An error text when a part is nowhere. */
  private assemble(req: SaveRequest, replaced: LocalFile | null): GraphFileData | string {
    const base = req.expectedHead ? this.journalData.get(req.analysisId)?.get(req.expectedHead) : undefined;
    const sources = [req.newParts, replaced?.data.parts ?? {}, base?.parts ?? {}];
    const parts: Record<string, string> = {};
    for (const r of req.manifest.revisions ?? []) {
      if (!r?.sections) continue;
      for (const name of SECTION_NAMES) {
        const ref = r.sections[name];
        if (!ref || own(parts, ref.part)) continue;
        const src = sources.find((s) => own(s, ref.part));
        if (!src) return `part missing: ${ref.part}`;
        parts[ref.part] = src[ref.part];
      }
    }
    const file: GraphFileData = { manifest: clone(req.manifest), parts };
    return fileProblem(file) ?? file;
  }

  private statOf(path: string, f: LocalFile): FileStat {
    return { path, size: JSON.stringify(f.data).length, mtime: f.mtime, dataless: f.dataless };
  }

  private write(path: string, data: GraphFileData, cloudRev: number): FileStat {
    this.written.push(data.manifest.head);
    const f: LocalFile = { data: clone(data), cloudRev, dirty: true, mtime: this.world.clock.now(), incomplete: false, dataless: false };
    this.files.set(path, f);
    this.deletes.delete(path);
    this.journalAdd(path, data);
    const t = this.tracked.get(path);
    if (t) { t.head = data.manifest.head; t.analysisId = data.manifest.analysis_id; t.state = "ok"; t.reason = null; }
    this.queueUpload(path);
    this.world.touch();
    return this.statOf(path, f);
  }

  private queueUpload(path: string): void {
    this.world.clock.schedule(this.uploadDelayMs, () => {
      if (!this.syncing()) { this.waitingUpload.add(path); return; }
      this.world.push(this, path);
    });
  }

  /** Journal a head at a path; when it was seen on disk there (`onDisk`),
   *  confirm the journaled heads it descends from. */
  private journalAdd(path: string, data: GraphFileData, onDisk = true): void {
    const { analysis_id: aid, head } = data.manifest;
    let m = this.journalData.get(aid);
    if (!m) this.journalData.set(aid, (m = new Map()));
    if (!m.has(head)) m.set(head, clone(data));
    if (!this.journalIdx.some((j) => j.analysis_id === aid && j.path === path && j.revision_id === head)) {
      this.journalIdx.push({ analysis_id: aid, path, revision_id: head, confirmed: false, first_seen: this.world.clock.now() });
    }
    if (onDisk) for (const j of this.journalIdx) {
      if (j.analysis_id === aid && j.path === path && !j.confirmed && j.revision_id !== head && isAncestorOrSelf(data.manifest, j.revision_id, head)) {
        j.confirmed = true;
      }
    }
  }

  private addDisplaced(original: string, data: GraphFileData, reason: DisplacedEntry["reason"]): string {
    const id = `x-${this.deviceId}-${++this.displacedSeq}`;
    this.displaced.set(id, {
      entry: { id, original, analysis_id: data.manifest?.analysis_id ?? "", head: data.manifest?.head ?? "", reason, at: this.world.clock.now() },
      data: clone(data),
    });
    return id;
  }

  private freeName(dir: string, stem: string): string {
    let p = `${dir}/${stem}.${GRAPH_EXT}`;
    for (let i = 2; this.files.has(p); i++) p = `${dir}/${stem} ${i}.${GRAPH_EXT}`;
    return p;
  }

  private copiesOf(path: string): Set<string> {
    let s = this.copyTable.get(path);
    if (!s) this.copyTable.set(path, (s = new Set()));
    return s;
  }

  /** Complete analysis files with this id in the folder of `path` (not `path` itself). */
  private sameIdBeside(path: string, analysisId: string): string[] {
    const dir = parentDir(path);
    return [...this.files.entries()]
      .filter(([p, f]) => p !== path && parentDir(p) === dir && p.endsWith(`.${GRAPH_EXT}`) && !f.dataless && !f.incomplete
        && fileProblem(f.data) === null && f.data.manifest.analysis_id === analysisId)
      .map(([p]) => p)
      .sort();
  }

  /** The safe follow rule (§5.2): the one file `path` was renamed to, or null;
   *  `others` = the same-id files the rule won't follow (for the chooser). */
  private followCandidates(path: string, analysisId: string, baseHead: string | null): { follow: string | null; others: string[] } {
    const same = this.sameIdBeside(path, analysisId);
    const copies = this.copyTable.get(path) ?? new Set<string>();
    const cands = same.filter((p) => !copies.has(p));
    const only = cands.length === 1 ? cands[0] : null;
    const head = only ? this.files.get(only)!.data.manifest : null;
    const follow = only && head && (baseHead === null || isAncestorOrSelf(head, baseHead, head.head)) ? only : null;
    return { follow, others: same.filter((p) => p !== follow) };
  }

  private emit(e: FileEvent): void {
    if (this.crashed) return;
    this.events.push(e);
    for (const l of [...this.listeners]) l(e);
  }

  /** Move a track (and its copy table) to the file it was followed to. */
  private retrack(from: string, to: string): Tracked | null {
    const t = this.tracked.get(from);
    if (!t) return null;
    this.tracked.delete(from);
    const copies = this.copyTable.get(from);
    this.copyTable.delete(from);
    const f = this.files.get(to);
    const moved: Tracked = { ...t, head: f?.data.manifest.head ?? t.head, checking: false, state: "ok", reason: null };
    moved.siblingHeads.delete(to);
    this.tracked.set(to, moved);
    this.notesSig.delete(from);
    this.notesSig.delete(to);
    void Promise.resolve().then(() => this.notePollPath(to));
    if (copies) { copies.delete(to); this.copyTable.set(to, copies); }
    return moved;
  }

  /** A tracked path disappeared: look again after MISSING_CONFIRM_MS. */
  private goneCheck(path: string): void {
    const t = this.tracked.get(path);
    if (!t || t.checking || t.state === "missing") return;
    t.checking = true;
    this.world.clock.schedule(MISSING_CONFIRM_MS, () => {
      const now = this.tracked.get(path);
      if (now !== t) return;               // untracked or followed meanwhile
      t.checking = false;
      if (this.files.has(path)) return;    // back again (a sync client's delete-then-create)
      this.tryFollow(path, t, true);
    });
  }

  private tryFollow(path: string, t: Tracked, reportMissing: boolean): void {
    if (!t.analysisId) {
      if (reportMissing && t.state !== "missing") { t.state = "missing"; this.emit({ type: "missing", path, candidates: [] }); }
      return;
    }
    const { follow, others } = this.followCandidates(path, t.analysisId, t.head);
    if (follow) {
      const moved = this.retrack(path, follow)!;
      this.emit({ type: "moved", from: path, to: follow, head: moved.head ?? "" });
      return;
    }
    if (reportMissing && t.state !== "missing") { t.state = "missing"; this.emit({ type: "missing", path, candidates: others }); }
  }

  private setUnreadable(path: string, t: Tracked, reason: UnreadableReason): void {
    if (t.state === "unreadable" && t.reason === reason) return;
    t.state = "unreadable";
    t.reason = reason;
    this.emit({ type: "unreadable", path, reason });
  }

  /** Events for tracked files after `path` changed (or disappeared). */
  private emitFor(path: string): void {
    this.emitForFile(path);
    this.notePoll(parentDir(path));
  }

  private emitForFile(path: string): void {
    const f = this.files.get(path);
    const t = this.tracked.get(path);
    if (t) {
      if (!f) this.goneCheck(path);
      else if (this.isDenied(parentDir(path))) this.setUnreadable(path, t, "PermissionDenied");
      else if (f.dataless) this.setUnreadable(path, t, "Dataless");
      else if (f.incomplete || fileProblem(f.data) !== null) this.setUnreadable(path, t, "Incomplete");
      else if (t.analysisId && f.data.manifest.analysis_id !== t.analysisId) {
        if (t.state !== "replaced") { t.state = "replaced"; t.reason = null; this.emit({ type: "replaced", path, analysisId: f.data.manifest.analysis_id }); }
      } else {
        const head = f.data.manifest.head;
        const wasOk = t.state === "ok";
        t.analysisId = f.data.manifest.analysis_id;
        t.state = "ok";
        t.reason = null;
        if (!wasOk) { t.head = head; this.emit({ type: "back", path, head }); }
        else if (head !== t.head) { t.head = head; this.emit({ type: "changed", path, head }); }
      }
    }
    if (!f || f.dataless || f.incomplete || fileProblem(f.data) !== null || this.isDenied(parentDir(path))) return;
    const data = f.data;
    for (const [tp, tt] of [...this.tracked.entries()]) {
      if (tp === path || parentDir(tp) !== parentDir(path) || tt.analysisId !== data.manifest.analysis_id) continue;
      const tf = this.files.get(tp);
      if (tf && !tf.dataless) {
        // Seen beside the tracked file: a copy, never a rename target.
        this.copiesOf(tp).add(path);
        if (tt.siblingHeads.get(path) === data.manifest.head) continue;
        tt.siblingHeads.set(path, data.manifest.head);
        this.emit({ type: "sibling", path: tp, sibling: path, header: headerOf(data) });
      } else if (!tf && tt.state === "missing") {
        this.tryFollow(tp, tt, false);     // reported missing: a successor may still arrive
      }
    }
  }
}
