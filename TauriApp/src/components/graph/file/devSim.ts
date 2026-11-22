/* The browser preview's simulator ("the other computer", Finder, the sync
   service): DevSimApi of the contract (§4.14, contract.ts §5). Each method acts
   on the simulated disks; the app learns about it only through its normal
   events. Also on window.__lasSim for verifiers. */

import type { DocContent } from "../../../store/graphStore";
import type { DevSimApiP2, SimFile } from "./contract";
import { buildNewFile, buildNextFile, fileAt, newAnalysisId, newDocKey, openFile, revisionOf } from "./docCodec";
import { GRAPH_EXT, fileStem, parentDir, type GraphFileData, type SectionName } from "./format";
import { applyRetention } from "./retention";
import { canonScratch, parseScratch } from "../scratchpad/scratchModel";
import { sampleDoc } from "../graphModel";
import { openContent } from "../../../store/graphStore";
import { PREVIEW_STORAGE_KEY, authorOf, previewBackend, type PreviewWorld } from "./previewBackend";

/** One visible change: the first table value goes up by one, the graph title changes, the significance
 *  level switches (analysis settings) or Scratchpad cell A1 gets a new value. */
export function editContent(c: DocContent, section: SectionName = "table"): DocContent {
  if (section === "figure") {
    const title = c.figure.title ? `${c.figure.title} (edited)` : "Edited";
    return { ...c, figure: { ...c.figure, title } };
  }
  if (section === "analysis") {
    return { ...c, analysis: { ...c.analysis, alpha: c.analysis.alpha === 0.05 ? 0.01 : 0.05 } };
  }
  if (section === "scratchpad") {
    const doc = parseScratch(c.scratch);
    const a1 = doc.cells.find((x) => x[0] === 1 && x[1] === 1);
    const n = Number(a1?.[2] ?? "");
    const value = a1 && Number.isFinite(n) && a1[2].trim() !== "" ? String(n + 1) : "1";
    const cells = [...doc.cells.filter((x) => !(x[0] === 1 && x[1] === 1)), [1, 1, value] as [number, number, string]];
    return { ...c, scratch: canonScratch({ ...doc, cells }) };
  }
  const cells = c.doc.cells.map((row) => row.map((reps) => [...reps]));
  if (!cells.length) return c;
  const old = cells[0][0][0] ?? "";
  const n = Number(old);
  cells[0][0][0] = old.trim() !== "" && Number.isFinite(n) ? String(Math.round((n + 1) * 1000) / 1000) : "1";
  return { ...c, doc: { ...c.doc, cells } };
}

const withExt = (name: string) => (name.toLowerCase().endsWith(`.${GRAPH_EXT}`) ? name : `${name}.${GRAPH_EXT}`);

export function makeDevSim(pw: PreviewWorld, opts: { reload?: () => void } = {}): DevSimApiP2 {
  const { world, clock, device, other } = pw;
  const settle = () => clock.advance(0);
  const synced = (path: string) => world.synced(path);
  const otherAuthor = (userName?: string) => authorOf(other, userName ?? "Alice");

  /** The current file at `path` as this computer has it. */
  const fileHere = (path: string): GraphFileData => {
    const f = device.localFile(path);
    if (!f) throw new Error(`No file at ${path}`);
    return f;
  };

  /** Edited content of a file's head (or of the given revision). */
  const edited = (f: GraphFileData, section: SectionName = "table", rev?: string): DocContent => {
    const c = openFile(f, rev);
    if (!c) throw new Error("The file can't be read");
    return editContent(c, section);
  };

  /** The other computer writes `data` at `path` (synced folders) or it lands on this disk directly. */
  async function otherWrites(path: string, data: GraphFileData, expectedHead: string | null, replaceExisting = false): Promise<void> {
    if (synced(path)) {
      settle();
      const res = await other.save({
        path, expectedHead, analysisId: data.manifest.analysis_id, docKey: newDocKey(), manifest: data.manifest, newParts: data.parts, replaceExisting,
      });
      if (!res.ok) throw new Error(`The other computer couldn't save: ${res.kind === "error" ? res.message : res.kind}`);
    } else {
      device.place(path, data);
    }
    settle();
  }

  const freePath = (dir: string, stem: string) => {
    const taken = new Set(device.localPaths());
    let p = `${dir}/${stem}.${GRAPH_EXT}`;
    for (let i = 2; taken.has(p); i++) p = `${dir}/${stem} ${i}.${GRAPH_EXT}`;
    return p;
  };

  /** The other computer's next version of `f`, kept to the newest versions as its app would (retention). */
  async function nextVersion(f: GraphFileData, section: SectionName, userName?: string): Promise<GraphFileData> {
    const next = await buildNextFile(f, edited(f, section), { time: clock.now(), author: otherAuthor(userName) });
    const m = applyRetention(next.manifest, { now: clock.now(), firstSeen: {}, unconfirmedHeads: [], beaconHeads: [] });
    if (m === next.manifest) return next;
    const used = new Set<string>();
    for (const r of m.revisions) if (r.sections) for (const ref of Object.values(r.sections)) used.add(ref.part);
    return { manifest: m, parts: Object.fromEntries(Object.entries(next.parts).filter(([k]) => used.has(k))) };
  }

  /** Make sure the file has a previous version (the other computer saves one first). */
  async function withPrevious(path: string): Promise<GraphFileData> {
    const f = fileHere(path);
    if (revisionOf(f.manifest, f.manifest.head)?.parents.length) return f;
    await api.remoteEdit(path, { section: "table" });
    return fileHere(path);
  }

  const api: DevSimApiP2 = {
    thisDevice: device.name,
    otherDevice: other.name,
    folders: () => device.folderList(),
    files: (): SimFile[] => device.localEntries().map((e) => ({
      path: e.path, name: e.path.slice(e.path.lastIndexOf("/") + 1), folder: parentDir(e.path), analysisId: e.analysisId, head: e.head,
      dataless: e.dataless, incomplete: e.incomplete,
    })),
    subscribe: (listener) => world.onChange(listener),

    async remoteEdit(path, o = {}) {
      settle();
      const f = (synced(path) ? other.localFile(path) : null) ?? fileHere(path);
      const next = await nextVersion(f, o.section ?? "table", o.userName);
      await otherWrites(path, next, f.manifest.head);
      return next.manifest.head;
    },

    async remoteDiverge(path, o) {
      const f = await withPrevious(path);
      const parent = revisionOf(f.manifest, f.manifest.head)!.parents[0];
      const base = fileAt(f, parent) ?? f;
      const next = await buildNextFile(base, edited(base, o.section), { time: clock.now(), author: otherAuthor(o.userName) });
      if (o.how === "copy") {
        const copy = world.conflictName(path, other.name);
        if (synced(path)) world.forceReplace(copy, next); else device.place(copy, next);
        settle();
        return copy;
      }
      if (synced(path)) world.forceReplace(path, next); else device.place(path, next);
      settle();
      return path;
    },

    async olderCopy(path) {
      const f = await withPrevious(path);
      const parent = revisionOf(f.manifest, f.manifest.head)!.parents[0];
      const prev = fileAt(f, parent) ?? f;
      const to = freePath(parentDir(path), `${fileStem(path)} (old copy)`);
      if (synced(to)) world.forceReplace(to, prev); else device.place(to, prev);
      settle();
      return to;
    },

    async remoteEditMany(path, count) {
      let last = "";
      for (let k = 0; k < count; k++) {
        last = await api.remoteEdit(path, { section: k % 2 === 0 ? "table" : "figure" });
        clock.advance(10);
      }
      return last;
    },

    removed: () => device.removedCopies(),

    async remoteConflictCopy(path) {
      const f = fileHere(path);
      const parent = revisionOf(f.manifest, f.manifest.head)?.parents[0];
      const base = (parent && fileAt(f, parent)) || f;
      const next = await buildNextFile(base, edited(base), { time: clock.now(), author: otherAuthor() });
      const copy = world.conflictName(path, other.name);
      await otherWrites(copy, next, null);
      return copy;
    },

    async remoteReplace(path) {
      const f = fileHere(path);
      const parent = revisionOf(f.manifest, f.manifest.head)?.parents[0];
      const base = (parent && fileAt(f, parent)) || f;
      const next = await buildNextFile(base, edited(base, "figure"), { time: clock.now(), author: otherAuthor() });
      if (synced(path)) world.forceReplace(path, next); else device.place(path, next);
      settle();
      return next.manifest.head;
    },

    async rollback(path) {
      const f = fileHere(path);
      const parent = revisionOf(f.manifest, f.manifest.head)?.parents[0];
      const prev = parent ? fileAt(f, parent) : null;
      if (!prev) return null;
      if (synced(path)) world.forceReplace(path, prev); else device.place(path, prev);
      settle();
      return prev.manifest.head;
    },

    async rename(path, newName) {
      const to = `${parentDir(path)}/${withExt(newName)}`;
      if (!device.rename(path, to)) throw new Error("Can't rename");
      settle();
      return to;
    },

    async move(path, toFolder) {
      device.addFolder(toFolder);
      const to = freePath(toFolder, fileStem(path));
      if (!device.rename(path, to)) throw new Error("Can't move");
      settle();
      return to;
    },

    async remove(path) {
      device.remove(path);
      settle();
    },

    async duplicateInFinder(path, newName) {
      const to = `${parentDir(path)}/${withExt(newName)}`;
      if (!device.duplicate(path, to)) throw new Error("Can't duplicate");
      settle();
      return to;
    },

    async sendBack(path, toFolder, userName) {
      const f = fileHere(path);
      const who = userName ?? "Bob";
      const next = await buildNextFile(f, edited(f), {
        time: clock.now(), author: { ...authorOf(other, who), device_id: "d-preview-colleague", device_name: `${who}'s MacBook` },
      });
      device.addFolder(toFolder);
      const to = freePath(toFolder, fileStem(path));
      device.place(to, next);
      settle();
      return to;
    },

    async replaceWithOther(path) {
      const content = openContent({ doc: sampleDoc("grouped") });
      const file = await buildNewFile({ content, analysisId: newAnalysisId(), forkedFrom: null, time: clock.now(), author: otherAuthor() });
      await otherWrites(path, file, null, true);
    },

    setOnlineOnly(path, on) {
      if (on) device.makeDataless(path); else device.hydrate(path);
      settle();
    },
    setIncomplete(path, ms) { device.setIncomplete(path, ms); },
    setPermissionDenied(folder, on) { device.setPermissionDenied(folder, on); },

    armSaveRace(path) {
      const f = fileHere(path);
      void buildNextFile(f, edited(f, "figure"), { time: clock.now(), author: otherAuthor() }).then((next) => device.armDisplace(path, next));
    },
    armOffline(path) { device.armOffline(path); },

    advance(ms) { clock.advance(ms); },
    reset() {
      try { localStorage.removeItem(PREVIEW_STORAGE_KEY); } catch { /* ignore */ }
      (opts.reload ?? (() => { if (typeof location !== "undefined") location.reload(); }))();
    },
  };
  return api;
}

let api: DevSimApiP2 | null = null;

const inTauri = () => typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

/** The simulator in the browser preview (dev builds only), else null. */
export function devSim(): DevSimApiP2 | null {
  if (!import.meta.env.DEV || inTauri()) return null;
  if (!api) {
    api = makeDevSim(previewBackend());
    if (typeof window !== "undefined") (window as unknown as { __lasSim?: DevSimApiP2 }).__lasSim = api;
  }
  return api;
}
