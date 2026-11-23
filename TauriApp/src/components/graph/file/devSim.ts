/* The browser preview's simulator ("the other computer", Finder, the sync
   service): DevSimApi of the contract (§4.14, contract.ts §5). Each method acts
   on the simulated disks; the app learns about it only through its normal
   events. Also on window.__lasSim for verifiers.

   Phase 3 (DevSimApiP3, phase3-contract.md §6.6): the other computers ("Office
   iMac" / Alice and "Lab MacBook" / Bob) keep notes beside the files they have
   open, by the same rules as the app (MemoryDevice.presenceSet, its heartbeat,
   presence.ts): open, start editing, save (the note goes back to idle 30 s
   later unless it keeps editing), stop, quit, crash, sleep / wake, "Edit here",
   a conflict copy of a note, an older app, a wrong clock. */

import type { DocContent } from "../../../store/graphStore";
import { LIMITS_P3, type DevSimApiP2, type DevSimApiP3, type NoteTarget, type SimFile, type SimNote, type SimWho } from "./contract";
import { isNoteFileName, liveNoteHeads, noteText } from "./presence";
import type { MemoryDevice } from "./memoryBackend";
import { buildNewFile, buildNextFile, fileAt, newAnalysisId, newDocKey, openFile, revisionOf } from "./docCodec";
import { GRAPH_EXT, fileStem, parentDir, type GraphFileData, type SectionName } from "./format";
import { applyRetention } from "./retention";
import { canonScratch, parseScratch } from "../scratchpad/scratchModel";
import { sampleDoc } from "../graphModel";
import { openContent } from "../../../store/graphStore";
import { PREVIEW_STORAGE_KEY, authorOf, freezePreviewPersist, previewBackend, type PreviewWorld } from "./previewBackend";

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

export function makeDevSim(pw: PreviewWorld, opts: { reload?: () => void } = {}): DevSimApiP3 {
  const { world, clock, device, other, third } = pw;
  const settle = () => clock.advance(0);
  const synced = (path: string) => world.synced(path);
  const otherAuthor = (userName?: string) => authorOf(other, userName ?? "Alice");
  const defaultUser = (d: MemoryDevice) => (d === third ? "Bob" : "Alice");

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
  async function nextVersion(f: GraphFileData, section: SectionName, userName?: string, path?: string, dev: MemoryDevice = other): Promise<GraphFileData> {
    const next = await buildNextFile(f, edited(f, section), { time: clock.now(), author: { ...authorOf(dev, userName ?? defaultUser(dev)) } });
    if (dev.writesNoNotes) next.manifest = { ...next.manifest, features: 1 };      // an older app
    // Phase 3: the versions the notes it can see are on keep their content (as the app's retention does).
    const beaconHeads = path ? liveNoteHeads(dev.noteFiles(parentDir(path)).map((n) => n.note).filter((n): n is NonNullable<typeof n> => !!n && n.analysis_id === f.manifest.analysis_id)) : [];
    const m = applyRetention(next.manifest, { now: clock.now(), firstSeen: {}, unconfirmedHeads: [], beaconHeads });
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

  const api0: DevSimApiP2 = {
    thisDevice: device.name,
    otherDevice: other.name,
    folders: () => device.folderList(),
    files: (): SimFile[] => device.localEntries().filter((e) => !isNoteFileName(e.path.slice(e.path.lastIndexOf("/") + 1))).map((e) => ({
      path: e.path, name: e.path.slice(e.path.lastIndexOf("/") + 1), folder: parentDir(e.path), analysisId: e.analysisId, head: e.head,
      dataless: e.dataless, incomplete: e.incomplete,
    })),
    subscribe: (listener) => world.onChange(listener),

    async remoteEdit(path, o = {}) {
      settle();
      const f = (synced(path) ? other.localFile(path) : null) ?? fileHere(path);
      const next = await nextVersion(f, o.section ?? "table", o.userName, path);
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
      freezePreviewPersist();
      try { localStorage.removeItem(PREVIEW_STORAGE_KEY); } catch { /* ignore */ }
      (opts.reload ?? (() => { if (typeof location !== "undefined") location.reload(); }))();
    },
  };
  // ── phase 3: the other computers' notes (§6.6) ──

  interface PeerDoc { epoch: number; editing: boolean; base: string | null; idle: { cancelled: boolean } | null }
  const peerDocs = new Map<MemoryDevice, Map<string, PeerDoc>>();
  const peerOf = (w?: SimWho): MemoryDevice => (w === "third" ? third : other);
  const docsOf = (d: MemoryDevice) => { let m = peerDocs.get(d); if (!m) peerDocs.set(d, (m = new Map())); return m; };
  const userOf = new Map<MemoryDevice, string>();

  /** The computer runs (after a crash it starts again; asleep it wakes) and uses my user name or its own. */
  async function ready(d: MemoryDevice, sameUser?: boolean): Promise<void> {
    if (d.isCrashed()) d.relaunch(0);
    if (d.isAsleep()) d.wake();
    if (sameUser !== undefined) {
      const want = sameUser ? (await device.device()).user_name : defaultUser(d);
      if ((await d.device()).user_name !== want) await d.setDevice({ userName: want });
      userOf.set(d, want);
    }
    settle();
  }

  function peerFile(d: MemoryDevice, path: string): GraphFileData {
    const f = d.localFile(path);
    if (!f) throw new Error(`${d.name} doesn't have this file (only files in Dropbox reach it).`);
    return f;
  }

  async function writeNote(d: MemoryDevice, path: string, doc: PeerDoc, supersedes: NoteTarget[] = []): Promise<void> {
    const f = peerFile(d, path);
    const head = f.manifest.head;
    await d.presenceSet({
      docPath: path, analysisId: f.manifest.analysis_id, state: doc.editing ? "editing" : "idle", head,
      baseRevision: doc.editing ? doc.base ?? head : null, epoch: doc.epoch, supersedes: doc.editing ? supersedes : [], input: doc.editing,
    });
    settle();
  }

  function docFor(d: MemoryDevice, path: string): PeerDoc {
    const m = docsOf(d);
    let doc = m.get(path);
    if (!doc) {
      const own = d.ownNoteState(path);
      m.set(path, (doc = { epoch: own?.note.epoch ?? 0, editing: false, base: null, idle: null }));
    }
    return doc;
  }

  async function startEditing(d: MemoryDevice, path: string, supersedes: NoteTarget[] = []): Promise<PeerDoc> {
    const doc = docFor(d, path);
    if (doc.idle) { doc.idle.cancelled = true; doc.idle = null; }
    doc.epoch++;
    doc.editing = true;
    doc.base = peerFile(d, path).manifest.head;
    d.alwaysInput = true;                    // a person typing there: the note keeps beating every 60 s
    await writeNote(d, path, doc, supersedes);
    return doc;
  }

  const p3 = {
    thirdDevice: third.name,

    notes(path: string): SimNote[] {
      const dir = parentDir(path);
      return device.noteFiles(dir).filter((n) => isNoteFileName(n.name)).map((n): SimNote => {
        const note = n.note;
        let beating = false;
        if (note) for (const d of world.devices) {
          const st = d.ownNoteState(`${dir}/${note.document_name}`);
          if (st && st.file === n.path) beating = st.beating;
        }
        return {
          file: n.path, name: n.name, deviceName: note?.device_name ?? "", userName: note?.user_name ?? "", state: note?.state ?? "idle",
          epoch: note?.epoch ?? 0, seq: note?.seq ?? 0, head: note?.head ?? null, baseRevision: note?.base_revision ?? null, beating,
        };
      });
    },

    async peerOpens(path: string, o: { who?: SimWho; sameUser?: boolean } = {}) {
      const d = peerOf(o.who);
      await ready(d, !!o.sameUser);
      await writeNote(d, path, docFor(d, path));
    },

    async peerStartsEditing(path: string, o: { who?: SimWho; sameUser?: boolean } = {}) {
      const d = peerOf(o.who);
      await ready(d, !!o.sameUser);
      await startEditing(d, path);
    },

    async peerSaves(path: string, o: { who?: SimWho; section?: SectionName; keepEditing?: boolean } = {}) {
      const d = peerOf(o.who);
      await ready(d);
      let doc = docFor(d, path);
      if (!doc.editing) doc = await startEditing(d, path);
      const f = peerFile(d, path);
      const next = await nextVersion(f, o.section ?? "table", userOf.get(d) ?? defaultUser(d), path, d);
      const res = await d.save({ path, expectedHead: f.manifest.head, analysisId: f.manifest.analysis_id, docKey: newDocKey(), manifest: next.manifest, newParts: next.parts });
      if (!res.ok) throw new Error(`${d.name} couldn't save: ${res.kind === "error" ? res.message : res.kind}`);
      settle();
      doc.base = res.head;
      await writeNote(d, path, doc);
      if (!o.keepEditing) {
        // D6: the note goes back to idle 30 s after the save (no more typing there).
        const h = { cancelled: false };
        doc.idle = h;
        const base = doc.base;
        clock.schedule(LIMITS_P3.lingerMs, () => {
          if (h.cancelled || !doc.editing || doc.base !== base || d.isCrashed() || d.isAsleep()) return;
          doc.idle = null;
          doc.editing = false;
          void writeNote(d, path, doc);
        });
      }
      return res.head;
    },

    async peerStops(path: string, o: { who?: SimWho } = {}) {
      const d = peerOf(o.who);
      await ready(d);
      const doc = docFor(d, path);
      if (doc.idle) { doc.idle.cancelled = true; doc.idle = null; }
      doc.editing = false;
      await writeNote(d, path, doc);
    },

    async peerQuits(path: string, o: { who?: SimWho } = {}) {
      const d = peerOf(o.who);
      await ready(d);
      const doc = docsOf(d).get(path);
      if (doc?.idle) doc.idle.cancelled = true;
      docsOf(d).delete(path);
      await d.presenceClear(path);
      settle();
    },

    async peerCrashes(_path: string, o: { who?: SimWho } = {}) {
      const d = peerOf(o.who);
      for (const doc of docsOf(d).values()) if (doc.idle) doc.idle.cancelled = true;
      d.crash();
      settle();
    },

    async peerSleeps(_path: string, o: { who?: SimWho } = {}) {
      const d = peerOf(o.who);
      if (d.isCrashed()) return;
      d.sleep(365 * 24 * 3600_000);
      settle();
    },

    async peerWakes(path: string, o: { who?: SimWho } = {}) {
      const d = peerOf(o.who);
      if (d.isCrashed() || !d.isAsleep()) return;
      d.wake();
      settle();
      // Its note beats again (and stays "editing" while it has unsaved changes, also when someone took over).
      const doc = docsOf(d).get(path);
      if (doc) await writeNote(d, path, doc);
    },

    async peerEditsHere(path: string, o: { who?: SimWho; sameUser?: boolean } = {}) {
      const d = peerOf(o.who);
      await ready(d, !!o.sameUser);
      const mine = device.ownNoteState(path);
      const sup = mine && mine.note.state === "editing" ? [{ device_id: mine.note.device_id, epoch: mine.note.epoch }] : [];
      await startEditing(d, path, sup);
    },

    async noteConflictCopy(path: string, o: { who?: SimWho } = {}) {
      const d = peerOf(o.who);
      const id = (await d.device()).device_id;
      const dir = parentDir(path);
      const n = device.noteFiles(dir).find((x) => x.note?.device_id === id && x.note.document_name === path.slice(dir.length + 1))
        ?? d.noteFiles(dir).find((x) => x.note?.device_id === id);
      if (!n?.note) throw new Error(`${d.name} has no note beside this file.`);
      const copy = n.path.replace(/\.laguse$/i, " (conflicted copy).laguse");
      device.placeNote(copy, noteText({ ...n.note, seq: Math.max(0, n.note.seq - 1) }));
      settle();
      return copy;
    },

    setOldApp(on: boolean, w?: SimWho) {
      const d = peerOf(w);
      d.writesNoNotes = on;
      if (on) for (const p of docsOf(d).keys()) void d.presenceClear(p);
      docsOf(d).clear();
      settle();
    },

    setClockSkew(ms: number, w?: SimWho) { peerOf(w).setClockSkew(ms); },

    setSyncDelay(ms: number) {
      device.downloadDelayMs = ms;
      device.noteDownloadDelayMs = ms;
    },

    setOffline(on: boolean) { device.setOnline(!on); settle(); },

    sleep(ms: number) {
      device.sleep(ms);
      clock.advance(ms);
    },
  };
  const api: DevSimApiP3 = Object.assign(api0, p3);
  return api;
}

let api: DevSimApiP3 | null = null;

const inTauri = () => typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

/** The simulator in the browser preview (dev builds only), else null. */
export function devSim(): DevSimApiP3 | null {
  if (!import.meta.env.DEV || inTauri()) return null;
  if (!api) {
    api = makeDevSim(previewBackend());
    if (typeof window !== "undefined") (window as unknown as { __lasSim?: DevSimApiP3 }).__lasSim = api;
  }
  return api;
}
