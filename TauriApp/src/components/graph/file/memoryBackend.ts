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
   backend verifies them. */

import type {
  DeviceIdentity, DirEntry, DisplacedEntry, DraftRecord, ExportMap, FileError, FileErrorCode, FileEvent,
  FileStat, GraphSession, HeaderResult, JournalHead, ReadResult, RecentEntry, SaveRequest, SaveResult, ScanResult,
} from "./backend";
import { RECENT_MAX, emptyExportMap, emptySession } from "./backend";
import type { AppInfo, DevicePatch, FileBackendP1, LocateMatch, LocateProgress, LocateResult } from "./contract";
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
    this.queue.push({ at: this.t + Math.max(0, delayMs), seq: this.seq++, fn });
  }

  /** Move time forward by `ms`, running every task that falls due on the way. */
  advance(ms: number): void {
    const end = this.t + Math.max(0, ms);
    for (;;) {
      this.queue.sort((a, b) => a.at - b.at || a.seq - b.seq);
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
      this.queue.sort((a, b) => a.at - b.at || a.seq - b.seq);
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
}

export interface MemoryWorldState {
  v: 1;
  mode: ConflictMode;
  serverRev: number;
  cloud: [string, CloudEntry][];
  devices: MemoryDeviceState[];
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

  constructor(opts: { mode?: ConflictMode; clock?: ManualClock; syncFolders?: string[] } = {}) {
    this.clock = opts.clock ?? new ManualClock();
    this.mode = opts.mode ?? "dropbox";
    this.syncFolders = opts.syncFolders ?? null;
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
    };
  }

  /** Restore exportState() (devices matched by device id; pending sync work is not kept). */
  importState(s: MemoryWorldState): void {
    if (!s || s.v !== 1) return;
    this.serverRev = s.serverRev;
    this.cloud.clear();
    for (const [p, e] of s.cloud) this.cloud.set(p, clone(e));
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
}

/** Absent on two polls this far apart before a path counts as missing (plan §5.2). */
export const MISSING_CONFIRM_MS = 5000;

const err = (code: FileErrorCode, message: string): FileError => ({ ok: false, code, message });
const saveErr = (code: FileErrorCode, message: string): SaveResult => ({ ...err(code, message), kind: "error" });
const own = (o: Record<string, string>, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const under = (path: string, dir: string) => path === dir || path.startsWith(dir.endsWith("/") ? dir : dir + "/");
const BUNDLE_RE = /\.(app|bundle|framework|plugin|kext|pkg|photoslibrary|musiclibrary|xcodeproj|lproj)$/i;

export class MemoryDevice implements FileBackendP1 {
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
  private locateSeq = 0;
  private readonly cancelled = new Set<string>();
  /** Every event emitted, for assertions. */
  readonly events: FileEvent[] = [];
  /** Every save request, for assertions. */
  readonly saves: SaveRequest[] = [];
  /** Head of every file written to this computer's disk by a save (not by sync), for assertions. */
  readonly written: string[] = [];

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
  }

  // ── FileBackend ──

  async device(): Promise<DeviceIdentity> { return { ...this.identity }; }

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
  }

  untrack(path: string): void { this.tracked.delete(path); this.copyTable.delete(path); }

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

  // ── scripting (what the person or the OS does on this computer) ──

  isOnline(): boolean { return this.online; }

  setOnline(on: boolean): void {
    this.online = on;
    if (!on) return;
    for (const p of [...this.waitingUpload]) { this.waitingUpload.delete(p); this.world.push(this, p); }
    for (const p of [...this.waitingDownload]) { this.waitingDownload.delete(p); this.world.deliver(this, p); }
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
    this.tracked.clear();
    this.copyTable.clear();
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
    if (!this.online) { this.waitingDownload.add(path); return; }
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
      if (!this.online) { this.waitingUpload.add(path); return; }
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

  private addDisplaced(original: string, data: GraphFileData, reason: DisplacedEntry["reason"]): void {
    const id = `x-${this.deviceId}-${++this.displacedSeq}`;
    this.displaced.set(id, {
      entry: { id, original, analysis_id: data.manifest?.analysis_id ?? "", head: data.manifest?.head ?? "", reason, at: this.world.clock.now() },
      data: clone(data),
    });
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
