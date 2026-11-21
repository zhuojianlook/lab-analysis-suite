/* FileBackendP1 over the Rust commands and events (contract §1.7). A thin
   mapping: arguments in, replies out, manifest text parsed / written with
   canonicalJson, rejections turned into typed errors. No logic of its own.

   `@tauri-apps/api` is imported dynamically (only by `tauriBackend()`), so the
   browser preview and the tests never load it; the mapping itself takes
   `invoke` / `listen` through `createTauriBackend` and is unit-tested with fakes. */

import type {
  DeviceIdentity, DisplacedEntry, DraftRecord, ExportMap, FileErrorCode, FileEvent, GraphSession, HeaderResult,
  JournalHead, ReadResult, RecentEntry, SaveRequest, SaveResult, ScanResult,
} from "./backend";
import {
  CMD, EVT, RUST_ERROR_KINDS,
  type AppInfo, type Commands, type DevicePatch, type FileBackendP1, type HeaderReply, type LocateProgress, type LocateReply,
  type LocateResult, type RawFile, type ReadReply, type RustError, type RustErrorKind, type SaveReply, type ScanReply,
} from "./contract";
import { canonicalJson, type GraphFileData, type Manifest } from "./format";

export type InvokeFn = <K extends keyof Commands>(cmd: K, args: Commands[K]["args"]) => Promise<Commands[K]["result"]>;
export type ListenFn = <T>(event: string, handler: (e: { payload: T }) => void) => Promise<() => void>;

const FILE_CODES: readonly FileErrorCode[] = [
  "NotFound", "PermissionDenied", "OfflineOrTimeout", "Incomplete", "Dataless", "TooNew", "IdentityMismatch", "Invalid", "Io",
];

/** A rejection → {kind, message}. Anything that is not a RustError object (a panic string) is "Io". */
export function rustError(e: unknown): { kind: RustErrorKind; message: string } {
  if (e && typeof e === "object" && typeof (e as RustError).kind === "string" && RUST_ERROR_KINDS.includes((e as RustError).kind)) {
    const r = e as RustError;
    return { kind: r.kind, message: typeof r.message === "string" ? r.message : String(r.kind) };
  }
  return { kind: "Io", message: e instanceof Error ? e.message : typeof e === "string" ? e : "Unexpected error." };
}

/** The kind as a FileErrorCode (Cancelled / NoStateDir have no file meaning: Io). */
const fileCode = (k: RustErrorKind): FileErrorCode => (FILE_CODES.includes(k as FileErrorCode) ? (k as FileErrorCode) : "Io");

function parseRaw(raw: RawFile): GraphFileData {
  return { manifest: JSON.parse(raw.manifestText) as Manifest, parts: { ...raw.parts } };
}

export function createTauriBackend(io: { invoke: InvokeFn; listen: ListenFn }): FileBackendP1 {
  const { invoke, listen } = io;
  /** Last head / id this backend saw at a path (sent with graphfile_track). */
  const known = new Map<string, { head: string | null; analysisId: string | null }>();
  const remember = (path: string, head: string | null, analysisId: string | null) => known.set(path, { head, analysisId });
  const listeners = new Set<(e: FileEvent) => void>();
  let listening = false;
  const locateListeners = new Map<string, (p: LocateProgress) => void>();
  let locateListening = false;
  let tokenSeq = 0;

  /** Writes of one record run one after another, in the order they were made (a draft write still
   *  running must not land after the delete that follows a save). Each draft call also carries a
   *  growing number, so Rust drops one that arrives late (a call that timed out here). */
  const chains = new Map<string, Promise<unknown>>();
  function inOrder<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = chains.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(() => undefined, () => undefined);
    chains.set(key, tail);
    void tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
    return run;
  }
  let draftSeqBase = Date.now() * 1000;
  const nextSeq = () => ++draftSeqBase;

  /** Commands whose failure has no typed result: log and go on (records are best-effort). */
  const quiet = async <K extends keyof Commands>(cmd: K, args: Commands[K]["args"]): Promise<Commands[K]["result"] | undefined> => {
    try { return await invoke(cmd, args); } catch (e) { console.warn(`[files] ${cmd} failed:`, rustError(e).message); return undefined; }
  };

  const backend: FileBackendP1 = {
    async device(): Promise<DeviceIdentity> {
      return invoke(CMD.device, {});
    },

    async read(path: string): Promise<ReadResult> {
      try {
        const r: ReadReply = await invoke(CMD.read, { path });
        const file = parseRaw(r);
        remember(path, file.manifest.head, file.manifest.analysis_id);
        return { ok: true, file, stat: r.stat, readOnly: r.readOnly };
      } catch (e) {
        const { kind, message } = rustError(e);
        return { ok: false, code: fileCode(kind), message };
      }
    },

    async header(path: string): Promise<HeaderResult> {
      try {
        const r: HeaderReply = await invoke(CMD.header, { path });
        // A hint only, but enough for graphfile_track of a tab that hasn't been read yet (contract §1.7).
        if (!known.has(path) || known.get(path)!.head === null) remember(path, r.header.head, r.header.analysis_id);
        return { ok: true, header: r.header, stat: r.stat };
      } catch (e) {
        const { kind, message } = rustError(e);
        return { ok: false, code: fileCode(kind), message };
      }
    },

    async save(req: SaveRequest): Promise<SaveResult> {
      try {
        const r: SaveReply = await invoke(CMD.save, {
          req: {
            path: req.path, expectedHead: req.expectedHead, analysisId: req.analysisId, docKey: req.docKey,
            manifestText: canonicalJson(req.manifest), newParts: req.newParts, replaceExisting: req.replaceExisting ?? false,
          },
        });
        switch (r.kind) {
          case "saved": case "savedAside": case "savedButDisplaced":
            if (r.kind !== "savedAside") {
              if (r.path !== req.path) known.delete(req.path);
              remember(r.path, r.head, req.analysisId);
            }
            return { ok: true, ...r };
          case "conflict": return { ok: false, kind: "conflict", head: r.head };
          case "missing": return { ok: false, kind: "missing" };
        }
        return { ok: false, kind: "error", code: "Io", message: "Unexpected reply." };
      } catch (e) {
        const { kind, message } = rustError(e);
        return { ok: false, kind: "error", code: fileCode(kind), message };
      }
    },

    async scanDir(dir: string): Promise<ScanResult> {
      try {
        const r: ScanReply = await invoke(CMD.scanDir, { dir });
        return { ok: true, entries: r.entries };
      } catch (e) {
        const { kind, message } = rustError(e);
        return { ok: false, code: fileCode(kind), message };
      }
    },

    readSession: (): Promise<GraphSession> => invoke(CMD.readSession, {}),
    writeSession: (session: GraphSession) => inOrder("session", async () => { await invoke(CMD.writeSession, { session }); }),
    readDraft: (docKey: string): Promise<DraftRecord | null> => invoke(CMD.readDraft, { docKey }),
    writeDraft: (draft: DraftRecord) => {
      const seq = nextSeq();
      return inOrder(`draft:${draft.doc_key}`, async () => {
        // `seq` is an extra argument the Rust command reads (contract.ts lists only `draft`).
        await invoke(CMD.writeDraft, { draft, seq } as Commands[typeof CMD.writeDraft]["args"]);
      });
    },
    deleteDraft: (docKey: string) => {
      const seq = nextSeq();
      return inOrder(`draft:${docKey}`, async () => {
        await invoke(CMD.deleteDraft, { docKey, seq } as Commands[typeof CMD.deleteDraft]["args"]);
      });
    },
    listDrafts: (): Promise<DraftRecord[]> => invoke(CMD.listDrafts, {}),

    journalHeads: (analysisId: string, path?: string): Promise<JournalHead[]> =>
      invoke(CMD.journalHeads, { analysisId, path: path ?? null }),
    async readJournal(analysisId: string, revisionId: string): Promise<GraphFileData | null> {
      const r = await invoke(CMD.readJournal, { analysisId, revisionId });
      return r ? parseRaw(r) : null;
    },
    async writeJournal(path: string, file: GraphFileData): Promise<void> {
      await invoke(CMD.writeJournal, { path, file: { manifestText: canonicalJson(file.manifest), parts: file.parts } });
    },
    listDisplaced: (): Promise<DisplacedEntry[]> => invoke(CMD.listDisplaced, {}),
    async readDisplaced(id: string): Promise<GraphFileData | null> {
      const r = await invoke(CMD.readDisplaced, { id });
      return r ? parseRaw(r) : null;
    },

    readRecent: (): Promise<RecentEntry[]> => invoke(CMD.readRecent, {}),
    writeRecent: async (entries: RecentEntry[]) => { await invoke(CMD.writeRecent, { entries }); },
    readExportMap: (): Promise<ExportMap> => invoke(CMD.readExportMap, {}),
    writeExportMap: async (map: ExportMap) => { await invoke(CMD.writeExportMap, { map }); },

    track(path: string, opts: { active?: boolean } = {}): void {
      const k = known.get(path);
      void quiet(CMD.track, { path, active: !!opts.active, head: k?.head ?? null, analysisId: k?.analysisId ?? null });
    },
    untrack(path: string): void {
      void quiet(CMD.untrack, { path });
    },
    subscribe(listener: (e: FileEvent) => void): () => void {
      listeners.add(listener);
      if (!listening) {
        listening = true;
        void listen<FileEvent>(EVT.file, (e) => {
          const ev = e.payload;
          if (ev && ev.type === "moved") {
            const k = known.get(ev.from);
            known.delete(ev.from);
            remember(ev.to, ev.head, k?.analysisId ?? null);
          } else if (ev && (ev.type === "changed" || ev.type === "back")) {
            const k = known.get(ev.path);
            remember(ev.path, ev.head, k?.analysisId ?? null);
          }
          for (const l of [...listeners]) l(ev);
        }).catch((err) => { listening = false; console.warn("[files] listen failed:", err); });
      }
      return () => { listeners.delete(listener); };
    },

    appInfo: (): Promise<AppInfo> => invoke(CMD.appInfo, {}),
    setDevice: (patch: DevicePatch): Promise<DeviceIdentity> => invoke(CMD.setDevice, { patch }),

    locate(dir: string, analysisId: string, onProgress?: (p: LocateProgress) => void): { token: string; result: Promise<LocateResult> } {
      const token = `loc-${Date.now().toString(36)}-${++tokenSeq}`;
      if (onProgress) {
        locateListeners.set(token, onProgress);
        if (!locateListening) {
          locateListening = true;
          void listen<LocateProgress>(EVT.locateProgress, (e) => locateListeners.get(e.payload?.token)?.(e.payload))
            .catch(() => { locateListening = false; });
        }
      }
      const result = (async (): Promise<LocateResult> => {
        try {
          const r: LocateReply = await invoke(CMD.locate, { dir, analysisId, token });
          return { ok: true, ...r };
        } catch (e) {
          const { kind, message } = rustError(e);
          return { ok: false, code: kind, message };
        } finally {
          locateListeners.delete(token);
        }
      })();
      return { token, result };
    },
    cancelLocate(token: string): void {
      void quiet(CMD.locateCancel, { token });
    },
    pollNow(): void {
      void quiet(CMD.pollNow, {});
    },
    async reveal(path: string): Promise<void> {
      await quiet(CMD.reveal, { path });
    },
  };
  return backend;
}

/** The desktop backend, loading @tauri-apps/api on first use. */
export function tauriBackend(): FileBackendP1 {
  const invoke: InvokeFn = async (cmd, args) => {
    const core = await import("@tauri-apps/api/core");
    return core.invoke(cmd, args as Record<string, unknown>) as Promise<never>;
  };
  const listen: ListenFn = async (event, handler) => {
    const ev = await import("@tauri-apps/api/event");
    return ev.listen(event, (e) => handler({ payload: e.payload as never }));
  };
  return createTauriBackend({ invoke, listen });
}

/** Untyped invoke / listen for the controller's own desktop calls (menu state, quit reply, pending opens). */
export async function tauriInvoke(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const core = await import("@tauri-apps/api/core");
  return core.invoke(cmd, args);
}

export async function tauriListen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  const ev = await import("@tauri-apps/api/event");
  return ev.listen<T>(event, (e) => handler(e.payload));
}
