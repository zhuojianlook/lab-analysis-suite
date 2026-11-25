/* The browser preview's simulator ("the other computer", Finder, the sync
   service): DevSimApi of the contract (§4.14, contract.ts §5). Each method acts
   on the simulated disks; the app learns about it only through its normal
   events. Also on window.__lasSim for verifiers.

   Phase 3 (DevSimApiP3, phase3-contract.md §6.6): the other computers ("Office
   iMac" / Alice and "Lab MacBook" / Bob) keep notes beside the files they have
   open, by the same rules as the app (MemoryDevice.presenceSet, its heartbeat,
   presence.ts): open, start editing, save (the note goes back to idle 30 s
   later unless it keeps editing), stop, quit, crash, sleep / wake, "Edit here",
   a conflict copy of a note, an older app, a wrong clock.

   Phase 4 (DevSimApiP4, phase4-contract.md §6.7): small, exact changes the other
   computer makes ("fine" edits: one value, a row, a column, the Y range,
   scratchpad cells, a rearranged scratchpad), so every fine-level combine case
   can be produced. Its saves carry `combine_v` unless it plays an older app. */

import type { DocContent } from "../../../store/graphStore";
import {
  COMBINE_V, LIMITS_P3, type DevSimApiP2, type DevSimApiP3, type DevSimApiP4, type NoteTarget, type SimFile, type SimFineEdit, type SimNote,
  type SimWho,
} from "./contract";
import { isNoteFileName, liveNoteHeads, noteText } from "./presence";
import type { MemoryDevice } from "./memoryBackend";
import { buildNewFile, buildNextFile, fileAt, newAnalysisId, newDocKey, openFile, revisionOf, type Author } from "./docCodec";
import { GRAPH_EXT, fileStem, parentDir, type GraphFileData, type SectionName } from "./format";
import { applyRetention } from "./retention";
import { canonScratch, parseScratch } from "../scratchpad/scratchModel";
import { deleteCol, deleteRow, ensureRows, insertRow, remapAnalysis, remapFigure, rowHasData, sampleDoc } from "../graphModel";
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

/** Phase 4 §6.7: exactly one small change, as the editor would make it. The result is in the stored form
 *  (rows padded with one blank row at the end), so it reads back the same on every computer. */
export function fineEditContent(c: DocContent, fine: SimFineEdit): DocContent {
  const bump = (v: string | undefined) => {
    const s = v ?? "";
    const n = Number(s);
    return s.trim() !== "" && Number.isFinite(n) ? String(Math.round((n + 1) * 1000) / 1000) : "1";
  };
  const setCell0 = (doc: DocContent["doc"], r: number, col: number): DocContent["doc"] => {
    if (!doc.cells[r]?.[col]) return doc;
    const cells = doc.cells.map((row) => row.map((reps) => [...reps]));
    cells[r][col][0] = bump(cells[r][col][0]);
    return { ...doc, cells };
  };
  /** "v" in replicate 1 of every column of row r (and X on XY tables). */
  const fillRow = (doc: DocContent["doc"], r: number, v: string): DocContent["doc"] => {
    const cells = doc.cells.map((row, i) => (i === r ? row.map((reps) => reps.map((x, k) => (k === 0 ? v : x))) : row.map((reps) => [...reps])));
    const x = doc.template === "xy" ? doc.x.map((xv, i) => (i === r ? v : xv)) : [...doc.x];
    return { ...doc, cells, x };
  };
  const done = (next: DocContent): DocContent =>
    openContent({ doc: ensureRows(next.doc), analysis: next.analysis, figure: next.figure, scratch: next.scratch });
  const scratchCells = (): [number, number, string, ...string[]][] => parseScratch(c.scratch).cells.map((x) => [...x] as [number, number, string, ...string[]]);
  switch (fine) {
    case "cell": return done({ ...c, doc: setCell0(c.doc, 0, 0) });
    case "cellOther": return done({ ...c, doc: setCell0(c.doc, 2, 0) });
    case "addRow": {
      let r = c.doc.cells.findIndex((_, i) => !rowHasData(c.doc, i));
      if (r < 0) { const d = ensureRows(c.doc); r = d.cells.length - 1; return done({ ...c, doc: fillRow(d, r, "7") }); }
      return done({ ...c, doc: fillRow(c.doc, r, "7") });
    }
    case "insertRow": {
      const doc = insertRow(c.doc, 0);
      return done({ ...c, doc: fillRow(doc, 0, "3"), analysis: remapAnalysis(c.analysis, doc.template, "row", { type: "insert", at: 0 }) });
    }
    case "deleteRow":
      return done({ ...c, doc: deleteRow(c.doc, 0), analysis: remapAnalysis(c.analysis, c.doc.template, "row", { type: "delete", at: 0 }) });
    case "deleteCol": {
      const last = c.doc.col_titles.length - 1;
      if (last < 1) return done(c);
      const op = { type: "delete" as const, at: last };
      return done({ ...c, doc: deleteCol(c.doc, last), analysis: remapAnalysis(c.analysis, c.doc.template, "col", op), figure: remapFigure(c.figure, op) });
    }
    case "renameCol": {
      const col_titles = [...c.doc.col_titles];
      if (col_titles.length) col_titles[0] = `${col_titles[0]} *`;
      return done({ ...c, doc: { ...c.doc, col_titles } });
    }
    case "yRange": return done({ ...c, figure: { ...c.figure, y_min: 0, y_max: c.figure.y_max === 100 ? 50 : 100 } });
    case "graphTitle": return done(editContent(c, "figure"));
    case "alpha": return done(editContent(c, "analysis"));
    case "scratchCells": {
      const doc = parseScratch(c.scratch);
      const b2 = doc.cells.find((x) => x[0] === 2 && x[1] === 2);
      const keep = doc.cells.filter((x) => !(x[1] === 2 && (x[0] === 2 || x[0] === 3)));
      const cells = [...keep, [2, 2, bump(b2?.[2])] as [number, number, string], [3, 2, "=B2*2"] as [number, number, string]];
      return done({ ...c, scratch: canonScratch({ ...doc, cells }) });
    }
    case "scratchShift": {
      const doc = parseScratch(c.scratch);
      const moved = scratchCells().map((x) => { const y = [...x] as typeof x; y[0] = x[0] + 1; return y; });
      const cells = [[1, 1, "Inserted"] as [number, number, string], ...moved];
      return done({ ...c, scratch: canonScratch({ ...doc, cells: cells as typeof doc.cells }) });
    }
  }
}

/** A scratchpad with A1:B6 filled with numbers (what scratchShift needs to move). */
function filledScratch(c: DocContent): DocContent {
  const doc = parseScratch(c.scratch);
  const cells: [number, number, string][] = [];
  for (let r = 1; r <= 6; r++) for (let col = 1; col <= 2; col++) cells.push([r, col, String(r * 10 + col)]);
  const others = doc.cells.filter((x) => !(x[0] <= 6 && x[1] <= 2));
  return openContent({ doc: c.doc, analysis: c.analysis, figure: c.figure, scratch: canonScratch({ ...doc, cells: [...others, ...cells] as typeof doc.cells }) });
}

const withExt = (name: string) => (name.toLowerCase().endsWith(`.${GRAPH_EXT}`) ? name : `${name}.${GRAPH_EXT}`);

export function makeDevSim(pw: PreviewWorld, opts: { reload?: () => void } = {}): DevSimApiP4 {
  const { world, clock, device, other, third } = pw;
  /** Phase 4: the next version made by a simulated computer, with `combine_v` unless it plays an older app. */
  async function nextOn(dev: MemoryDevice, base: GraphFileData, content: DocContent, author: Author): Promise<GraphFileData> {
    const next = await buildNextFile(base, content, { time: clock.now(), author });
    if (dev.writesNoNotes) return next;
    const head = next.manifest.head;
    return { ...next, manifest: { ...next.manifest, revisions: next.manifest.revisions.map((r) => (r.id === head ? { ...r, combine_v: COMBINE_V } : r)) } };
  }
  /** The content a simulated computer saves: the phase 2 section edit, or exactly the fine edit. */
  const changed = (f: GraphFileData, o: { section?: SectionName; fine?: SimFineEdit }, rev?: string): DocContent => {
    if (!o.fine) return edited(f, o.section ?? "table", rev);
    const c = openFile(f, rev);
    if (!c) throw new Error("The file can't be read");
    return fineEditContent(c, o.fine);
  };
  const scratchCount = (f: GraphFileData) => parseScratch(openFile(f)?.scratch ?? "").cells.length;
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
  async function nextVersion(
    f: GraphFileData, section: SectionName | { section?: SectionName; fine?: SimFineEdit }, userName?: string, path?: string, dev: MemoryDevice = other,
  ): Promise<GraphFileData> {
    const o = typeof section === "string" ? { section } : section;
    const next = await nextOn(dev, f, changed(f, o), { ...authorOf(dev, userName ?? defaultUser(dev)) });
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

  /** scratchShift needs content to move: a scratchpad with fewer than 12 cells is filled first (one version). */
  const needsFill = (f: GraphFileData, fine?: SimFineEdit) => fine === "scratchShift" && scratchCount(f) < 12;

  const api0: Omit<DevSimApiP2, "remoteEdit" | "remoteDiverge"> & Pick<DevSimApiP4, "remoteEdit" | "remoteDiverge"> = {
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
      if (needsFill(f, o.fine)) {
        const filled = await nextOn(other, f, filledScratch(openFile(f)!), { ...authorOf(other, o.userName ?? "Alice") });
        await otherWrites(path, filled, f.manifest.head);
        return filled.manifest.head;
      }
      const next = await nextVersion(f, { section: o.section, fine: o.fine }, o.userName, path);
      await otherWrites(path, next, f.manifest.head);
      return next.manifest.head;
    },

    async remoteDiverge(path, o) {
      if (needsFill(fileHere(path), o.fine)) {
        // Content to move first: one version of its own; the next press rearranges it.
        await api.remoteEdit(path, { fine: o.fine, userName: o.userName });
        return path;
      }
      const f = await withPrevious(path);
      const parent = revisionOf(f.manifest, f.manifest.head)!.parents[0];
      const base = fileAt(f, parent) ?? f;
      const next = await nextOn(other, base, changed(base, { section: o.section, fine: o.fine }), otherAuthor(o.userName));
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
      const next = await nextOn(other, base, edited(base), otherAuthor());
      const copy = world.conflictName(path, other.name);
      await otherWrites(copy, next, null);
      return copy;
    },

    async remoteReplace(path) {
      const f = fileHere(path);
      const parent = revisionOf(f.manifest, f.manifest.head)?.parents[0];
      const base = (parent && fileAt(f, parent)) || f;
      const next = await nextOn(other, base, edited(base, "figure"), otherAuthor());
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
      const next = await nextOn(other, f, edited(f), { ...authorOf(other, who), device_id: "d-preview-colleague", device_name: `${who}'s MacBook` });
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
      void nextOn(other, f, edited(f, "figure"), otherAuthor()).then((next) => device.armDisplace(path, next));
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

    async peerSaves(path: string, o: { who?: SimWho; section?: SectionName; fine?: SimFineEdit; keepEditing?: boolean } = {}) {
      const d = peerOf(o.who);
      await ready(d);
      let doc = docFor(d, path);
      if (!doc.editing) doc = await startEditing(d, path);
      const f = peerFile(d, path);
      const next = needsFill(f, o.fine)
        ? await nextOn(d, f, filledScratch(openFile(f)!), { ...authorOf(d, userOf.get(d) ?? defaultUser(d)) })
        : await nextVersion(f, { section: o.section, fine: o.fine }, userOf.get(d) ?? defaultUser(d), path, d);
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

    /** Phase 4: an older app also writes no `combine_v` (nextOn reads the same flag). */
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
  const api: DevSimApiP4 = Object.assign(api0, p3);
  return api;
}

let api: DevSimApiP4 | null = null;

const inTauri = () => typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

/** The simulator in the browser preview (dev builds only), else null. */
export function devSim(): DevSimApiP4 | null {
  if (!import.meta.env.DEV || inTauri()) return null;
  if (!api) {
    api = makeDevSim(previewBackend());
    if (typeof window !== "undefined") (window as unknown as { __lasSim?: DevSimApiP4 }).__lasSim = api;
  }
  return api;
}
