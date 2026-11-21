/* The files session controller (contract §4): tabs, open / save / Save As /
   Duplicate / close, Recent, per-document drafts, session restore with cards,
   Find it…, poll events, the journal check, conflicts, the quit routine, the
   library export and settings. The UI imports `useFileSession` and nothing else.

   One document lives in memory (the graph store); every other tab is its
   session record plus, when it has unsaved changes, its draft on disk.

   Everything the controller needs from outside comes through SessionDeps, so the
   tests run two "computers" (two controllers, two graph stores, one simulated
   sync service) on a manual clock. */

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
  DeviceIdentity, DraftRecord, FileErrorCode, FileEvent, GraphSession, ReadResult, RecentEntry, SaveRequest, SaveResult, SessionTab,
} from "./backend";
import {
  BANNER_ORDER, CMD, EVT, LIMITS, MENU,
  type AppInfo, type BannerAction, type BannerKind, type ConflictChoice, type DialogAnswer, type DraftListItem, type ExportState,
  type FileBackendP1, type FileSessionState, type FileSettings, type FileTab, type MenuEvent, type MenuId, type MenuState,
  type OpenFilesEvent, type OpenOutcome, type PathPickerRequest, type QuitRequest, type QuitSource, type RecentItem,
  type RestoreCard, type SaveAsMode, type SaveOutcome, type SessionDialog, type SessionToast, type TabBanner, type TabStatus,
  type VersionInfo,
} from "./contract";
import {
  buildNewFile, completeParts, contentOfDraft, draftOf, makeRevision, mergeRevisionId, newAnalysisId, newDocKey,
  newRevisionId, openFile, partsNotIn, partsOf, pruneSnapshots, relationOf, revisionOf, roundTrip, sectionsOf, summaryOf,
  unionManifests, versionInfo, withAbsentSnapshotsDropped, withRevision, isStrictAncestor, type Author, type BuiltParts,
} from "./docCodec";
import { fileStem, isAncestorOrSelf, parentDir, type GraphFileData, type Manifest, type Revision } from "./format";
import { isExported, libraryStatus, rowContent, runExport, type LibraryApi } from "./libraryExport";
import { cloudServiceOf, folderLabel, graphPath, isConflictCopyName, isTempLocation, safeFileName, withGraphExt } from "./paths";

// ── dependencies ────────────────────────────────────────────────────────────

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SessionDeps {
  /** null: chosen in init() (Tauri → Rust commands, else the browser preview's simulated disk). */
  backend: FileBackendP1 | null;
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
  /** Preview backend factory (lazy, so the desktop build never makes the simulated world). */
  makePreviewBackend: (() => Promise<{ backend: FileBackendP1; persistNow(): void }>) | null;
  /** Is the Graphs tool on screen? The File menu's document commands only act when it is
   *  (otherwise they bring it forward first). */
  graphsVisible(): boolean;
}

/** The Graphs tool's region is shown (tools stay mounted, hidden, when another one is on screen). */
function domGraphsVisible(): boolean {
  if (typeof document === "undefined") return true;
  const el = document.querySelector<HTMLElement>('[role="region"][aria-label="Graphs"]');
  return !!el && !el.hidden && el.offsetParent !== null;
}

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
  /** Built from the store: its editSerial then (undefined: built from the tab's kept changes). */
  serial: number | undefined;
  /** Built from the kept changes: which write of them it was (Internal.draftSeq). */
  draftSeq: number;
}

interface ConflictCtx extends Working {
  theirs: GraphFileData;
  base: string | null;
}

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
}

const newInternal = (p: Partial<Internal> = {}): Internal => ({
  manifest: null, acceptedHead: null, knownCopies: [], copyAnswer: {}, settled: [], template: null, sample: false,
  conflict: null, retry: null, firstTry: 0, waitedCloud: false, hasDraft: false, bannerData: new Map(), seenCopies: [],
  draftSeq: 0, draftSerialAt: undefined, ...p,
});

const CARD_KINDS: readonly TabStatus[] = ["waiting", "downloading", "missing", "permission", "unreadable"];
const isCard = (s: TabStatus) => CARD_KINDS.includes(s);
const iso = (t: number) => new Date(t).toISOString();
const asTemplate = (t: unknown): Template | null => (t === "column" || t === "grouped" || t === "xy" ? t : null);

export type FileSessionStore = UseBoundStore<StoreApi<FileSessionState>> & {
  /** Test and simulator access to controller internals (not for the UI). */
  internal: {
    deps: SessionDeps;
    backend(): FileBackendP1 | null;
    manifestOf(key: string): Manifest | null;
    knownCopies(key: string): string[];
    acceptedHead(key: string): string | null;
    flushDraftNow(): Promise<void>;
  };
};

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
      return { backend: p.device, persistNow: p.persistNow };
    },
    graphsVisible: domGraphsVisible,
    ...partial,
  };
  const graph = deps.graph;
  let backend: FileBackendP1 = deps.backend as FileBackendP1;
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
  const set = (p: Partial<FileSessionState>) => store.setState(p);

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
  const addUnique = (list: string[], p: string) => (list.includes(p) ? list : [...list, p]);

  /** Every file read goes through here: older versions whose content isn't in the file are marked as not stored. */
  async function readFile(path: string): Promise<ReadResult> {
    const r = await backend.read(path);
    return r.ok ? { ...r, file: withAbsentSnapshotsDropped(r.file) } : r;
  }
  async function readJournalFile(analysisId: string, revisionId: string): Promise<GraphFileData | null> {
    const f = await backend.readJournal(analysisId, revisionId);
    return f ? withAbsentSnapshotsDropped(f) : null;
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
    tempLocation: ["chooseLocation"], rolledBack: ["useEarlier", "backToLatest"], newerOnDisk: ["choose", "later"],
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
      if (prev && (prev.kind === "saveAsKind" || prev.kind === "closeDirty" || prev.kind === "quit")) r({ kind: prev.kind, choice: "cancel" } as DialogAnswer);
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

  function buildSession(): GraphSession {
    const { tabs, activeKey } = get();
    return {
      v: 1,
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
      hasDoc, canSave: hasDoc && !t!.readOnly && !t!.saving,
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
    suppress++;
    let applied: "none" | "same" | "older" | "mismatch" = "none";
    try {
      graph.getState().loadFile({ file: { docKey: key, analysisId: m.analysis_id, baseRevision: head, path: t.path }, name: t.title, ...c, saved: true });
      patchTab(key, {
        status: "ready", analysisId: m.analysis_id, baseRevision: head, readOnly: r.readOnly, template: c.doc.template,
        folderLabel: labelOf(t.path), service: serviceOf(t.path),
      });
      if (draft) applied = await applyDraft(key, draft, m);
    } finally { suppress--; }
    i.hasDraft = applied === "same" || applied === "older";
    patchTab(key, { dirty: isDirty(graph.getState()) });
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

  /** The journal check (contract §4.8, plan §8). */
  async function invariantCheck(key: string, m: Manifest): Promise<"ok" | "rolledBack" | "savedOver"> {
    const t = tabOf(key);
    if (!t?.path) return "ok";
    const i = it(key);
    const heads = await backend.journalHeads(m.analysis_id, t.path);
    const settled = new Set(i.settled);
    const open = heads.filter((j) => !j.confirmed && j.revision_id !== m.head && !settled.has(j.revision_id))
      .sort((a, b) => a.first_seen - b.first_seen);
    const j = open[open.length - 1];
    if (!j) return "ok";
    if (isAncestorOrSelf(m, j.revision_id, m.head)) return "ok";
    const jf = await readJournalFile(m.analysis_id, j.revision_id);
    if (jf && isAncestorOrSelf(jf.manifest, m.head, j.revision_id)) {
      if (m.head === i.acceptedHead) return "ok";
      const b = addBanner(key, {
        id: "rolledBack", kind: "rolledBack", version: vi(m, m.head), when: revisionOf(m, m.head)?.time,
      });
      if (b) i.bannerData.set(b.id, j.revision_id);
      return "rolledBack";
    }
    // Another computer saved over my save: keep mine beside the file (unless a copy there already holds it,
    // e.g. the sync service's conflicted copy).
    if (jf) {
      const scan = await quietly(backend.scanDir(parentDir(t.path)), null);
      const existing = scan && scan.ok
        ? scan.entries.find((e) => e.path !== t.path && e.header?.analysis_id === m.analysis_id && e.header.head === j.revision_id)?.path ?? null
        : null;
      const jr = revisionOf(jf.manifest, j.revision_id);
      const label = !jr || jr.device_id === device?.device_id
        ? `(my version from ${device?.device_name || "this computer"})`
        : `(version from ${jr.device_name || "another computer"})`;
      const copy = existing ?? await writeCopyBeside(t.path, label, jf);
      if (copy) {
        i.knownCopies = [...i.knownCopies, copy];
        addBanner(key, { kind: "savedOver", name: fileStem(copy), path: copy });
      }
    }
    i.settled = [...i.settled, j.revision_id];
    await saveSession();
    return "savedOver";
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
    if (!t?.path || i.knownCopies.includes(sib)) return;
    if (!i.seenCopies.includes(sib)) {
      // A copy, remembered across restarts: never taken for this file renamed.
      i.seenCopies = [...i.seenCopies, sib].slice(-50);
      void saveSession();
    }
    const r = await readFile(sib);
    if (!r.ok) return;
    const mine = i.manifest ?? (t.analysisId && t.baseRevision ? (await readJournalFile(t.analysisId, t.baseRevision))?.manifest ?? null : null);
    if (!mine || !t.baseRevision || r.file.manifest.analysis_id !== t.analysisId) return;
    const relation = relationOf(mine, t.baseRevision, r.file.manifest, r.file.manifest.head);
    const conflictName = isConflictCopyName(sib, fileStem(t.path));
    if (!conflictName && !i.copyAnswer[sib]) {
      addBanner(key, { id: `copy:${sib}`, kind: "copyQuestion", name: t.title, path: sib, folderLabel: labelOf(sib) });
      return;
    }
    extraCopyBanner(key, sib, r.file, relation);
  }

  function extraCopyBanner(key: string, sib: string, f: GraphFileData, relation: "older" | "same" | "newer" | "diverged"): void {
    addBanner(key, {
      id: `copy:${sib}`, kind: "extraCopy", name: fileStem(sib), path: sib, folderLabel: labelOf(sib), relation,
      version: vi(f.manifest, f.manifest.head),
      // A strictly newer copy (a colleague's edited copy saved next to mine) can be taken into my file.
      actions: relation === "older" || relation === "same" ? ["dismiss"] : relation === "newer" ? ["updateMine", "notSame", "later"] : ["notSame", "later"],
    });
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
      ...makeRevision({
        id: newRevisionId(now()), parents: [m.head], kind: "save", time: now(), author: author(), summary: "Made a separate analysis.",
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

  async function onFileEvent(e: FileEvent): Promise<void> {
    if (e.type === "presence") return;
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
        return;
      case "back":
        removeKinds(key, ["missing", "downloading", "permission", "replaced"]);
        if (isCard(t.status)) { await retryTab(key, false); return; }
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
        return;
      case "sibling":
        await handleSibling(key, e.sibling);
        return;
    }
  }

  /** The file at a tab's path has head H (changed / back / moved). */
  async function onHead(key: string, _h: string): Promise<void> {
    const t = tabOf(key);
    if (!t?.path || t.saving || isCard(t.status) || t.status === "opening") return;
    const serial0 = graph.getState().editSerial;
    const base0 = t.baseRevision;
    const r = await readFile(t.path);
    if (!r.ok) return;
    const t1 = tabOf(key);
    if (!t1 || t1.saving || t1.path !== t.path) return;
    const m = r.file.manifest;
    const H = m.head;
    if (m.analysis_id !== t1.analysisId) return;
    if (H === t1.baseRevision) {
      it(key).manifest = m;
      removeKinds(key, ["newerOnDisk"]);
      return;
    }
    const inv = await invariantCheck(key, m);
    if (inv === "rolledBack") return;
    const i = it(key);
    const loaded = isLoaded(key);
    const dirty = tabDirty(key);
    if (!dirty) {
      if (loaded) {
        const s = graph.getState();
        if (s.editSerial !== serial0 || s.file?.baseRevision !== base0) {
          addBanner(key, { kind: "newerOnDisk", version: vi(m, H) });
          return;
        }
        const c = openFile(r.file);
        if (!c) return;
        suppress++;
        try {
          deps.flushScratch({ commitEdit: false });
          graph.getState().loadFile({
            file: { docKey: key, analysisId: m.analysis_id, baseRevision: H, path: t1.path }, name: t1.title, ...c, saved: true, inPlace: true,
          });
        } finally { suppress--; }
      }
      i.manifest = m;
      patchTab(key, { baseRevision: H, readOnly: r.readOnly, dirty: false });
      removeKinds(key, ["newerOnDisk", "rolledBack"]);
      if (loaded && inv !== "savedOver") toast({ tone: "info", kind: "reloaded", version: vi(m, H) });
      await saveSession();
      return;
    }
    addBanner(key, { kind: "newerOnDisk", version: vi(m, H) });
  }

  // ── save ──

  async function workingOf(key: string): Promise<Working | null> {
    const t = tabOf(key)!;
    const i = it(key);
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
    const rev = makeRevision({
      id: newRevisionId(now()), parents: t.baseRevision ? [t.baseRevision] : [], kind: "save", time: now(), author: author(),
      summary: summaryOf(baseRev?.sections, parts.refs), parts,
    });
    return { content: c, parts, rev, manifest: pruneSnapshots(withRevision(manifest, rev, author(), c.doc.template)), serial, draftSeq };
  }

  /** Parts a save sends: those the base revision doesn't reference. */
  function newPartsFor(w: Working, base: string | null): Record<string, string> {
    const baseRev = revisionOf(w.manifest, base);
    const have = new Set(baseRev?.sections ? Object.values(baseRev.sections).map((r) => r.part) : []);
    return Object.fromEntries(Object.entries(w.parts.texts).filter(([k]) => !have.has(k)));
  }

  /** One save per tab at a time: a second Save while one runs gets the running one's outcome
   *  (two saves on the same base would end in a conflict with myself). */
  const savesInFlight = new Map<string, Promise<SaveOutcome>>();
  function saveImpl(key: string): Promise<SaveOutcome> {
    const running = savesInFlight.get(key);
    if (running) return running;
    const run = saveOnce(key).finally(() => { if (savesInFlight.get(key) === run) savesInFlight.delete(key); });
    savesInFlight.set(key, run);
    return run;
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
    if (t.readOnly) { addBanner(key, { kind: "tooNew" }); return { ok: false, reason: "failed" }; }
    if (isCard(t.status) || t.status === "opening") return { ok: false, reason: "failed" };
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
        patchTab(key, { baseRevision: res.head, notSaved: false });
        removeKinds(key, ["saveFailed", "notSaved", "newerOnDisk", "missing", "savedAside", "replaced", "rolledBack", "recovered", "tookTheirs"]);
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
        await touchRecent(path, aid);
        await saveSession();
        toast({ tone: "success", kind: "saved", name: title });
        if (res.kind === "savedButDisplaced") {
          const j = await quietly(readJournalFile(aid, res.displacedHead), null);
          if (j) {
            const who = revisionOf(j.manifest, res.displacedHead)?.device_name || "another computer";
            const copy = await writeCopyBeside(path, `(version from ${who})`, j);
            if (copy) {
              i.knownCopies = [...i.knownCopies, copy];
              addBanner(key, { kind: "savedDisplaced", name: fileStem(copy), path: copy, version: vi(j.manifest, res.displacedHead) });
              await saveSession();
            }
          }
        }
        void origin;
        return { ok: true, path };
      }
      case "savedAside":
        i.knownCopies = addUnique(i.knownCopies, res.path);
        addBanner(key, { kind: "savedAside", name: fileStem(res.path), path: res.path });
        if (isLoaded(key)) await writeActiveDraft(false);
        await saveSession();
        return { ok: false, reason: "failed" };
      case "conflict":
        return enterConflict(key, w, "save");
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
        ...makeRevision({ id: kid, parents: [theirsHead, c.rev.id], kind: "merge", time: now(), author: author(), summary: "Kept this computer's version", parts: c.parts }),
      };
      const union = unionManifests(c.theirs.manifest, c.manifest);
      const m = pruneSnapshots(withRevision(union, k, author(), c.content.doc.template));
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
      await saveSession();
      return;
    }

    // separateCopy: mine as a new analysis in a place the person picks; this file is left as it is.
    const picked = await pickPath({ mode: "save", title: "Save my version as a separate copy", suggestedName: `${safeFileName(`${t.title} (my copy)`)}.lag`, startDir: parentDir(t.path!) });
    if (!picked) { notSavedBanner(); return; }
    const path = withGraphExt(picked);
    if (tabByPath(path) && tabByPath(path)!.key !== key) {
      addBanner(key, { kind: "saveFailed", message: "That file is open in another tab. Choose another name." });
      notSavedBanner();
      return;
    }
    c = (await refreshConflict(key, c)).c;
    const newAid = newAnalysisId();
    const file = await buildNewFile({ content: c.content, analysisId: newAid, forkedFrom: { analysis_id: aid, revision_id: c.base ?? theirsHead }, time: now(), author: author() });
    const res = await backend.save({ path, expectedHead: null, replaceExisting: true, analysisId: newAid, docKey: key, manifest: file.manifest, newParts: file.parts });
    if (!res.ok) {
      addBanner(key, { kind: "saveFailed", message: res.kind === "error" ? saveFailedMessage(res.code) : saveFailedMessage("Io") });
      notSavedBanner();
      return;
    }
    const i = it(key);
    if (!i.settled.includes(c.rev.id)) i.settled = [...i.settled, c.rev.id];
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
    toast({ tone: "success", kind: "saved", name: title });
  }

  async function saveAsImpl(mode: SaveAsMode = "ask"): Promise<SaveOutcome> {
    const key = get().activeKey;
    const t = tabOf(key);
    if (!key || !t || !isLoaded(key)) return { ok: false, reason: "nothing" };
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
    }
    const c = content();
    const serial = graph.getState().editSerial;
    let req: SaveRequest;
    if (kind === "new") {
      const aid = t.path === null ? t.analysisId ?? newAnalysisId() : newAnalysisId();
      const forked = t.path !== null && t.analysisId && t.baseRevision ? { analysis_id: t.analysisId, revision_id: t.baseRevision } : null;
      const file = await buildNewFile({ content: c, analysisId: aid, forkedFrom: forked, time: now(), author: author() });
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
    const file = await buildNewFile({ content: content(), analysisId: newAnalysisId(), forkedFrom: forked, time: now(), author: author() });
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
    if (r.ok) patchTab(key, { analysisId: r.file.manifest.analysis_id });
    return exclusive(async () => {
      if (!tabOf(key)) return { ok: false as const, reason: "cancelled" as const };
      const already = get().activeKey === key && isLoaded(key);    // clicked while it was read
      if (get().activeKey !== key) {
        await leaveActive();
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
      set({ activeKey: key });
      await loadInto(key);
      await saveSession();
    });
  }

  async function showStartImpl(): Promise<void> {
    await exclusive(async () => {
      await leaveActive();
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
      clearRetry(key);
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

  // ── banner actions ──

  async function bannerActionImpl(key: string, bannerId: string, action: BannerAction): Promise<void> {
    const t = tabOf(key);
    const b = t?.banners.find((x) => x.id === bannerId);
    if (!t || !b) return;
    const i = it(key);
    const drop = () => removeBanners(key, (x) => x.id === bannerId);
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
        const w = await workingOf(key);
        if (w) await enterConflict(key, w, "banner");
        return;
      }
      case "openCopy": case "openThatOne":
        if (b.path) await openImpl(b.path);
        return;
      case "useEarlier": {
        if (!t.path) return;
        const r = await readFile(t.path);
        if (!r.ok) return;
        const H = r.file.manifest.head;
        i.acceptedHead = H;
        // Everything newer that this device journaled stays in its journal; it is not asked about again.
        const heads = await backend.journalHeads(r.file.manifest.analysis_id, t.path);
        for (const j of heads) if (!j.confirmed && j.revision_id !== H && !i.settled.includes(j.revision_id)) i.settled = [...i.settled, j.revision_id];
        drop();
        if (!tabDirty(key)) {
          const c = openFile(r.file);
          if (isLoaded(key) && c) {
            suppress++;
            try {
              graph.getState().loadFile({ file: { docKey: key, analysisId: r.file.manifest.analysis_id, baseRevision: H, path: t.path }, name: t.title, ...c, saved: true, inPlace: true });
            } finally { suppress--; }
          }
          i.manifest = r.file.manifest;
          patchTab(key, { baseRevision: H, dirty: false });
        } else addBanner(key, { kind: "newerOnDisk", relation: "older", version: vi(r.file.manifest, H) });
        await saveSession();
        return;
      }
      case "backToLatest": {
        const j = i.bannerData.get(bannerId);
        if (!t.path || !t.analysisId || !j) return;
        const jf = await readJournalFile(t.analysisId, j);
        const h = await backend.header(t.path);
        if (!jf || !h.ok) { addBanner(key, { kind: "saveFailed", message: "Your latest version couldn't be put back yet. Try again in a moment." }); return; }
        const res = await backend.save({
          path: t.path, expectedHead: h.header.head, analysisId: t.analysisId, docKey: key, manifest: jf.manifest, newParts: jf.parts,
        });
        if (!res.ok) { addBanner(key, { kind: "saveFailed", message: res.kind === "error" ? saveFailedMessage(res.code) : "The file changed again. Try again in a moment." }); return; }
        drop();
        i.acceptedHead = null;
        if (!tabDirty(key)) {
          const c = openFile(jf);
          if (isLoaded(key) && c) {
            suppress++;
            try {
              graph.getState().loadFile({ file: { docKey: key, analysisId: t.analysisId, baseRevision: res.head, path: t.path }, name: t.title, ...c, saved: true, inPlace: true });
            } finally { suppress--; }
          }
          i.manifest = jf.manifest;
          patchTab(key, { baseRevision: res.head, dirty: false });
        }
        await saveSession();
        return;
      }
      case "separate": case "notSame":
        if (b.path) await makeSeparate(key, b.path);
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
      }));
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
    if (device) set({ settings: { userName: device.user_name, deviceName: device.device_name } });
    recentEntries = await quietly(backend.readRecent(), [] as RecentEntry[]);
    set({ recent: recentItems() });
    const restored = await restore();
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
      w.addEventListener("focus", () => backend.pollNow());
      w.addEventListener("blur", () => { void writeActiveDraft(false); });
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
      await writeActiveDraft(true);
      await saveSession();
      persistNow?.();
      if (source === "update") return true;
      const dirty = get().tabs.filter((t) => !isCard(t.status) && tabDirty(t.key));
      if (!dirty.length) return true;
      if (desktop && requestId !== undefined) await quietly(deps.invoke(CMD.quitReply, { requestId, stage: "flushed" }), undefined);
      const a = await ask({ kind: "quit", dirty: dirty.map((t) => ({ key: t.key, title: t.title })) });
      set({ dialog: null });
      if (a.kind !== "quit" || a.choice === "cancel") return false;
      if (a.choice === "keep") return true;
      for (const t of get().tabs.filter((x) => dirty.some((d) => d.key === x.key))) {
        const res = await saveImpl(t.key);
        if (!res.ok) {
          if (get().activeKey !== t.key && tabOf(t.key)) await switchTabImpl(t.key);
          return false;
        }
      }
      return true;
    })().finally(() => { quitPromise = null; });
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
      // These open a dialog whose actions open analyses: show Graphs behind it.
      case MENU.recover: focusGraphs(); await store.getState().openRecover(); return;
      case MENU.exportLibrary: focusGraphs(); await openExportImpl(); return;
      case MENU.oldLibrary: focusGraphs(); set({ dialog: { kind: "oldLibrary" } }); return;
      case MENU.settings: set({ dialog: { kind: "settings" } }); return;
      case MENU.about: set({ aboutSerial: get().aboutSerial + 1 }); return;
      case MENU.quit: if (!desktop) await quitRoutineImpl("menu"); return;
    }
  }

  // ── the store ──

  const base = create<FileSessionState>(() => ({
    ready: false, desktop: false, tabs: [], activeKey: null, cards: [], recent: [], dialog: null, pathPicker: null, toasts: [],
    settings: null, oldLibrary: null, focusSerial: 0, aboutSerial: 0, busy: false,

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
        suppress++;
        try {
          graph.getState().loadFile({ file: { docKey: k, analysisId: r.file.manifest.analysis_id, baseRevision: r.file.manifest.head, path: t.path }, name: t.title, ...c, saved: true, inPlace: true });
        } finally { suppress--; }
      }
      it(k).manifest = r.file.manifest;
      patchTab(k, { baseRevision: r.file.manifest.head, dirty: false, readOnly: r.readOnly });
      removeKinds(k, ["newerOnDisk"]);
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
    dismissBanner: (key, bannerId) => removeBanners(key, (b) => b.id === bannerId),
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
      const d = await backend.setDevice({
        ...(patch.userName !== undefined ? { userName: patch.userName } : {}),
        ...(patch.deviceName !== undefined ? { deviceName: patch.deviceName } : {}),
      });
      device = { ...d, session_id: device?.session_id ?? d.session_id };
      set({ settings: { userName: d.user_name, deviceName: d.device_name } });
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
  }));

  store = Object.assign(base, {
    internal: {
      deps,
      backend: () => backend ?? null,
      manifestOf: (key: string) => internal.get(key)?.manifest ?? null,
      knownCopies: (key: string) => [...(internal.get(key)?.knownCopies ?? [])],
      acceptedHead: (key: string) => internal.get(key)?.acceptedHead ?? null,
      flushDraftNow: () => writeActiveDraft(true),
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

  // Menu state follows the active tab, Recent and the old library.
  store.subscribe((s, prev) => {
    if (s.activeKey !== prev.activeKey || s.tabs !== prev.tabs || s.recent !== prev.recent || s.oldLibrary !== prev.oldLibrary || s.ready !== prev.ready) pushMenu();
  });

  return store;
}

/** The app's controller. */
export const useFileSession = createFileSession();
