/* Test helpers for the session controller (imported by *.test.ts only): a
   simulated computer = a MemoryDevice + its own graph store + a controller on
   the shared manual clock. */

import type { GraphSaved, GraphSummary } from "../../../api/graph";
import { createGraphStore, type GraphStoreApi } from "../../../store/graphStore";
import { sampleDoc } from "../graphModel";
import type { CombineStateP4, DialogAnswer, PathPickerRequest, RevisionP4 } from "./contract";
import { canonScratch, parseScratch } from "../scratchpad/scratchModel";
import { buildNewFile, newAnalysisId, newDocKey, openFile, type Author } from "./docCodec";
import type { GraphFileData } from "./format";
import { ManualClock, MemoryWorld, type ConflictMode, type DeviceOptions, type MemoryDevice } from "./memoryBackend";
import { openContent, type DocContent } from "../../../store/graphStore";
import { createFileSession, type FileSessionStore, type SessionDeps } from "./session";

export const HOME = "/Users/me";
export const DBX = `${HOME}/Dropbox/Lab`;
export const DOCS = `${HOME}/Documents`;
export const DOWNLOADS = `${HOME}/Downloads`;

/** Let every pending promise chain run (the memory backend answers at once). */
export async function flush(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

export interface Computer {
  dev: MemoryDevice;
  graph: GraphStoreApi;
  ses: FileSessionStore;
  /** Answers for the path picker, in order (null = cancel). */
  picks: (string | null)[];
  /** Requests the picker got. */
  pickRequests: PathPickerRequest[];
  /** Desktop commands invoked. */
  invoked: { cmd: string; args: unknown }[];
  /** Desktop events the controller listens to: emit one. */
  emit(event: string, payload: unknown): void;
  /** Start a new controller on the same computer (an app restart). */
  restart(extra?: TestDeps): Promise<Computer>;
}

export type TestDeps = Omit<Partial<SessionDeps>, "library"> & { library?: FakeLibrary; skewMs?: number };

export interface FakeLibrary {
  rows: GraphSummary[];
  saved: Map<number, GraphSaved>;
  fail: boolean;
}

export function fakeLibrary(n = 0): FakeLibrary {
  const lib: FakeLibrary = { rows: [], saved: new Map(), fail: false };
  for (let i = 1; i <= n; i++) addLibraryRow(lib, i, `Experiment ${i}`);
  return lib;
}

export function addLibraryRow(lib: FakeLibrary, id: number, name: string, updated = `2026-01-0${(id % 9) + 1} 10:00:00`): void {
  const doc = sampleDoc(id % 3 === 0 ? "grouped" : "column");
  const { row_ids: _r, col_ids: _c, ...noIds } = doc;
  const summary: GraphSummary = { id, name, template: doc.template, n_rows: doc.cells.length, n_cols: doc.col_titles.length, created_at: updated, updated_at: updated };
  lib.rows = [...lib.rows.filter((r) => r.id !== id), summary];
  lib.saved.set(id, {
    ...summary, table: noIds as never, analysis: {} as never, figure: {} as never, doc_version: 1,
    scratchpad: id === 1 ? { v: 1, cells: [[1, 1, "5"]] } : null,
  });
}

/** A simulated world. Phase 3: `notes: false` makes every app write no note (as phase 1 / 2 apps, or a debug build
 *  outside LAS_NOTE_ROOTS): the phase 1 / 2 tests of edits made on two computers at nearly the same time use it,
 *  because with notes the second computer is read-only while the first one edits (phase3-contract.md §5.10). */
export function makeWorld(mode: ConflictMode = "dropbox", syncFolders: string[] | undefined = [`${HOME}/Dropbox`], opts: { notes?: boolean } = {}) {
  return new MemoryWorld({ mode, clock: new ManualClock(Date.UTC(2026, 10, 20, 9, 0, 0)), syncFolders, noteRoots: opts.notes === false ? [] : null });
}

export async function computer(world: MemoryWorld, opts: Partial<DeviceOptions> & { device_id: string; device_name: string }, extra: TestDeps = {}): Promise<Computer> {
  const dev = world.addDevice({
    user_name: "Zhuo", appInfo: { homeDir: HOME, tempDirs: [DOWNLOADS, "/private/tmp"], appVersion: "0.2.1-test" },
    ...opts,
  });
  return controllerFor(world, dev, extra);
}

export async function controllerFor(world: MemoryWorld, dev: MemoryDevice, extra: TestDeps = {}): Promise<Computer> {
  const graph = createGraphStore();
  const picks: (string | null)[] = [];
  const pickRequests: PathPickerRequest[] = [];
  const invoked: { cmd: string; args: unknown }[] = [];
  const handlers = new Map<string, ((p: unknown) => void)[]>();
  const lib = extra.library ?? fakeLibrary(0);
  const { library: _l, skewMs, ...rest } = extra;
  const ses = createFileSession({
    backend: dev, desktop: false, graph,
    now: () => world.clock.now() + (skewMs ?? 0),
    // Phase 3: the device's timers (late while it sleeps, gone after a crash or quit; the world clock otherwise).
    timers: dev.timers(),
    flushScratch: () => undefined,
    pickPath: async (req) => { pickRequests.push(req); return picks.length ? picks.shift()! : null; },
    invoke: async (cmd, args) => { invoked.push({ cmd, args }); return cmd === "take_pending_opens" ? [] : null; },
    listen: async (event, h) => {
      handlers.set(event, [...(handlers.get(event) ?? []), h as (p: unknown) => void]);
      return () => undefined;
    },
    library: {
      list: async () => { if (lib.fail) throw new Error("engine not running"); return lib.rows; },
      get: async (id) => lib.saved.get(id) ?? null,
    },
    legacyDraft: { read: () => null, clear: () => undefined },
    window: null,
    makePreviewBackend: null,
    ...rest,
  });
  const c: Computer = {
    dev, graph, ses, picks, pickRequests, invoked,
    emit: (event, payload) => { for (const h of handlers.get(event) ?? []) h(payload); },
    restart: async (more = {}) => {
      const next = await controllerFor(world, dev, { ...extra, ...more });
      await next.ses.getState().init();
      await flush();
      return next;
    },
  };
  return c;
}

/** Start a computer's controller. */
export async function start(c: Computer): Promise<Computer> {
  await c.ses.getState().init();
  await flush();
  return c;
}

/** Run an action that opens a dialog of `kind`, answer it, return the action's result. */
export async function withAnswer<T>(c: Computer, action: () => Promise<T>, answer: DialogAnswer): Promise<T> {
  const p = action();
  for (let i = 0; i < 50 && c.ses.getState().dialog?.kind !== answer.kind; i++) await new Promise((r) => setTimeout(r, 0));
  if (c.ses.getState().dialog?.kind !== answer.kind) throw new Error(`no ${answer.kind} dialog (got ${c.ses.getState().dialog?.kind ?? "none"})`);
  c.ses.getState().answerDialog(answer);
  return p;
}

/** Advance simulated time and let the controllers react. */
export async function tick(world: MemoryWorld, ms: number, stepMs?: number): Promise<void> {
  // In steps, so async reactions run between timer callbacks.
  const step = stepMs ?? (ms > 20_000 ? 1000 : 250);
  for (let t = 0; t < ms; t += step) {
    world.clock.advance(Math.min(step, ms - t));
    await flush(5);
  }
  await flush();
}

export const authorFor = (dev: MemoryDevice, user = "Alice"): Author => ({
  user_name: user, device_id: dev.deviceId, device_name: dev.name, session_id: `s-${dev.deviceId}`, app_version: "test", platform: "macos",
});

/** A new analysis file with sample data, saved on `dev` at `path`. */
export async function seedFile(world: MemoryWorld, dev: MemoryDevice, path: string, template: "column" | "grouped" | "xy" = "column"): Promise<GraphFileData> {
  const content = openContent({ doc: sampleDoc(template) });
  const file = await buildNewFile({ content, analysisId: newAnalysisId(), forkedFrom: null, time: world.clock.now(), author: authorFor(dev, "Seed") });
  const res = await dev.save({ path, expectedHead: null, analysisId: file.manifest.analysis_id, docKey: newDocKey(), manifest: file.manifest, newParts: file.parts });
  if (!res.ok) throw new Error(`seed failed: ${JSON.stringify(res)}`);
  world.clock.advance(0);
  return file;
}

/** The content of the file at `path` on `dev`. */
export function contentAt(dev: MemoryDevice, path: string): DocContent | null {
  const f = dev.localFile(path);
  return f ? openFile(f) : null;
}

export const firstCell = (c: DocContent | null) => c?.doc.cells[0]?.[0]?.[0] ?? null;

/** Every revision whose snapshot is kept somewhere: in a file on any computer's disk, or in a journal. */
export function keptRevisions(world: MemoryWorld): { onDisk: Set<string>; journaled: Set<string> } {
  const onDisk = new Set<string>();
  const journaled = new Set<string>();
  for (const d of world.devices) {
    for (const p of d.localPaths()) {
      const f = d.localFile(p);
      for (const r of f?.manifest.revisions ?? []) if (r.sections) onDisk.add(r.id);
    }
    for (const j of d.journalCopies()) journaled.add(j.manifest.head);
  }
  return { onDisk, journaled };
}

/** Every head any computer wrote (saved files, copies, aside files). */
export function writtenHeads(world: MemoryWorld): Set<string> {
  const out = new Set<string>();
  for (const d of world.devices) for (const h of d.written) out.add(h);
  return out;
}

// ── phase 2 helpers ─────────────────────────────────────────────────────────

export const PFILE = `${DBX}/Dose response.lag`;

export interface Pair { w: MemoryWorld; a: Computer; b: Computer; delay: number }

/** Two computers with the same file open (seeded on `a`, synced to `b`). */
export async function pair(delay = 2000, mode: ConflictMode = "dropbox", extra: {
  skewB?: number; sameId?: boolean; partialB?: number; depsA?: TestDeps; depsB?: TestDeps; path?: string; notes?: boolean;
} = {}): Promise<Pair> {
  const w = makeWorld(mode, undefined, { notes: extra.notes });
  const path = extra.path ?? PFILE;
  const a = await start(await computer(w, { device_id: "d-a", device_name: "Mac mini", uploadDelayMs: delay, downloadDelayMs: delay }, extra.depsA ?? {}));
  const b = await start(await computer(w, {
    device_id: extra.sameId ? "d-a" : "d-b", device_name: "MacBook", user_name: "Alice", uploadDelayMs: delay, downloadDelayMs: delay, partialDeliveryMs: extra.partialB,
  }, { skewMs: extra.skewB, ...(extra.depsB ?? {}) }));
  await seedFile(w, a.dev, path);
  await tick(w, 2 * delay + (extra.partialB ?? 0) + 500);
  const oa = await a.ses.getState().open(path);
  const ob = await b.ses.getState().open(path);
  if (!oa.ok || !ob.ok) throw new Error("pair: open failed");
  return { w, a, b, delay };
}

export const syncPair = (s: Pair, extraMs = 1000) => tick(s.w, 2 * s.delay + extraMs);

export async function editCell(c: Computer, value: string, r = 0, col = 0) {
  c.graph.getState().setCell(r, col, 0, value);
  await flush();
}

export async function editTitle(c: Computer, title: string) {
  c.graph.getState().setFigure({ title });
  await flush();
}

/** Every version any computer wrote is still in a file on some disk or in a journal. */
export function lostVersions(w: MemoryWorld): string[] {
  const { onDisk, journaled } = keptRevisions(w);
  return [...writtenHeads(w)].filter((h) => !onDisk.has(h) && !journaled.has(h));
}

/** Every revision id in any file on any disk (content or not). */
export function knownIds(w: MemoryWorld): Set<string> {
  const out = new Set<string>();
  for (const d of w.devices) for (const p of d.localPaths()) for (const r of d.localFile(p)?.manifest.revisions ?? []) out.add(r.id);
  return out;
}

/** Two-parent versions with the same (sorted) parents but different ids, over every file of every disk. */
export function duplicateCombines(w: MemoryWorld): string[] {
  const byParents = new Map<string, Set<string>>();
  for (const d of w.devices) for (const p of d.localPaths()) for (const r of d.localFile(p)?.manifest.revisions ?? []) {
    if (r.parents.length < 2) continue;
    const k = [...r.parents].sort().join("+");
    if (!byParents.has(k)) byParents.set(k, new Set());
    byParents.get(k)!.add(r.id);
  }
  return [...byParents.entries()].filter(([, ids]) => ids.size > 1).map(([k, ids]) => `${k}: ${[...ids].join(",")}`);
}

export const activeTab = (c: Computer) => c.ses.getState().tabs.find((t) => t.key === c.ses.getState().activeKey)!;
export const bannerOf = (c: Computer, kind: string) => activeTab(c).banners.find((b) => b.kind === kind) ?? null;
export async function pressBanner(c: Computer, kind: string, action: string) {
  const t = activeTab(c);
  const b = t.banners.find((x) => x.kind === kind);
  if (!b) throw new Error(`no ${kind} banner (have ${t.banners.map((x) => x.kind).join(", ")})`);
  await c.ses.getState().bannerAction(t.key, b.id, action as never);
  await flush();
}

// ── phase 3 helpers ─────────────────────────────────────────────────────────

/** The note files beside `path` on a computer's disk (parsed). */
export const notesBeside = (dev: MemoryDevice, path: string) => dev.noteFiles(path.slice(0, path.lastIndexOf("/")));
/** The parsed notes of one device beside `path` on `dev`'s disk. */
export const notesOf = (dev: MemoryDevice, path: string, deviceId: string) =>
  notesBeside(dev, path).filter((n) => n.note?.device_id === deviceId);
export const guardOf = (c: Computer) => c.graph.getState().guard?.reason ?? null;
export const presenceOf = (c: Computer) => activeTab(c).presence;
export const modeOf = (c: Computer) => activeTab(c).presence?.mode ?? "editable";

export interface Group { w: MemoryWorld; cs: Computer[]; delay: number; path: string }

/** Up to three computers ("Mac mini" A, "MacBook" B, "Lab iMac" C) with the same synced file open and clean.
 *  `users`: user name per computer (default: all "Zhuo" — my own computers). */
export async function group(n = 2, opts: {
  delay?: number; noteDelay?: number; users?: string[]; path?: string; mode?: ConflictMode; deps?: TestDeps[]; ids?: string[];
  syncFolders?: string[];
} = {}): Promise<Group> {
  const delay = opts.delay ?? 1000;
  const w = makeWorld(opts.mode ?? "dropbox", opts.syncFolders);
  const path = opts.path ?? PFILE;
  const names = ["Mac mini", "MacBook", "Lab iMac"];
  const ids = opts.ids ?? ["d-a1a1", "d-b2b2", "d-c3c3"];
  const cs: Computer[] = [];
  for (let k = 0; k < n; k++) {
    cs.push(await start(await computer(w, {
      device_id: ids[k], device_name: names[k], user_name: opts.users?.[k] ?? "Zhuo", session_id: `s-${ids[k]}-${k}`, uploadDelayMs: delay, downloadDelayMs: delay,
      noteUploadDelayMs: opts.noteDelay ?? delay, noteDownloadDelayMs: opts.noteDelay ?? delay,
    }, opts.deps?.[k] ?? {})));
  }
  await seedFile(w, cs[0].dev, path);
  await tick(w, 2 * delay + 500);
  for (const c of cs) {
    const o = await c.ses.getState().open(path);
    if (!o.ok) throw new Error("group: open failed");
  }
  await tick(w, 2 * Math.max(delay, opts.noteDelay ?? 0) + 500);
  return { w, cs, delay, path };
}

// ── phase 4 helpers (fine-level combining) ──────────────────────────────────

/** Type `value` into replicate `rep` of row `r`, column `col`. */
export async function editCellAt(c: Computer, r: number, col: number, value: string, rep = 0) {
  c.graph.getState().setCell(r, col, rep, value);
  await flush();
}
export async function insertRowAt(c: Computer, at: number) { c.graph.getState().insertRow(at); await flush(); }
export async function deleteRowAt(c: Computer, r: number) { c.graph.getState().deleteRow(r); await flush(); }
export async function deleteColAt(c: Computer, col: number) { c.graph.getState().deleteCol(col); await flush(); }
export async function setYRange(c: Computer, yMin: number | null, yMax: number | null) {
  c.graph.getState().setFigure({ y_min: yMin, y_max: yMax } as never);
  await flush();
}
/** Scratchpad cells set to these inputs ("" clears one); the other cells stay. */
export async function setScratchCells(c: Computer, cells: [row: number, col: number, input: string][]) {
  const doc = parseScratch(c.graph.getState().scratch ?? "");
  const keyOf = (r: number, k: number) => `${r}:${k}`;
  const by = new Map(doc.cells.map((x) => [keyOf(x[0], x[1]), x] as const));
  for (const [r, k, v] of cells) { if (v === "") by.delete(keyOf(r, k)); else by.set(keyOf(r, k), [r, k, v]); }
  c.graph.getState().setScratch(canonScratch({ ...doc, cells: [...by.values()] }));
  await flush();
}
/** Every scratchpad cell moved `dRows` rows down (a row inserted at the top), plus `extra` cells. */
export async function shiftScratch(c: Computer, dRows: number, extra: [number, number, string][] = []) {
  const doc = parseScratch(c.graph.getState().scratch ?? "");
  const cells = [...doc.cells.map((x) => { const y = [...x] as typeof x; y[0] = x[0] + dRows; return y; }), ...extra];
  c.graph.getState().setScratch(canonScratch({ ...doc, cells }));
  await flush();
}
/** The scratchpad input at (row, col) of a content, or null. */
export const scratchAt = (content: DocContent | null, r: number, k: number): string | null =>
  parseScratch(content?.scratch ?? "").cells.find((x) => x[0] === r && x[1] === k)?.[2] ?? null;
/** The dialog state of a combine (phase 4 form), or null. */
export function combineState(c: Computer): CombineStateP4 | null {
  const d = c.ses.getState().dialog;
  return d?.kind === "combine" ? (d.state as CombineStateP4) : null;
}
/** The head revision of the file at `path` on `dev` (as stored). */
export function headRev(dev: MemoryDevice, path: string): RevisionP4 | null {
  const f = dev.localFile(path);
  return (f?.manifest.revisions.find((r) => r.id === f.manifest.head) as RevisionP4 | undefined) ?? null;
}
/** Revisions with `auto: true` that share sorted parents (D3), over every file of every disk. */
export function duplicateAutoCombines(w: MemoryWorld): string[] {
  const by = new Map<string, Set<string>>();
  for (const d of w.devices) for (const p of d.localPaths()) for (const r of (d.localFile(p)?.manifest.revisions ?? []) as RevisionP4[]) {
    if (!(r as { auto?: boolean }).auto) continue;
    const k = [...r.parents].sort().join("+");
    if (!by.has(k)) by.set(k, new Set());
    by.get(k)!.add(r.id);
  }
  return [...by.entries()].filter(([, ids]) => ids.size > 1).map(([k, ids]) => `${k}: ${[...ids].join(",")}`);
}
