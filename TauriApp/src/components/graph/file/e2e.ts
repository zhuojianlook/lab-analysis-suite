/* DEBUG BUILDS ONLY: the desktop self-test for analysis files.

   Loaded by FilesHost only when `import.meta.env.DEV` (a production build
   drops the import and this file entirely). It does nothing unless the Rust
   debug command `dev_e2e_script` (registered only under cfg(debug_assertions))
   returns a script, i.e. the debug app was started with LAS_E2E_SCRIPT. It then
   drives the real controller (useFileSession) against the real Rust commands,
   plays Finder / another computer through `dev_e2e_fs`, writes
   LAS_STATE_DIR/e2e-result.json and quits through the real quit handshake.

   Script: { phase: "first" | "restore" | "missing" | "renamed" | "opens" | "combine" | "combineRestore", roots: string[], dir, otherDir,
             movedDir?, opens?: string[], quit: "menu" | "window" | "terminate" }
   "combine" (phase 2, checklist E1–E4): another computer's graph save meets an unsaved table edit → Save
   combines; a diverged sync-conflict copy is combined into the shorter-named file and then removed (moved
   into LAS_STATE_DIR/displaced/), a second diverged copy is refused; Bring back; File → Versions toggles the
   panel. Then two computers on a second file "E2E P2b" (the other one played through dev_e2e_fs copyOver):
   E6 another computer's save replaced my last save on a clean tab → banner "combining", nothing written
   before this computer's delay, then one automatic combine; E7 an older copy → Remove it (moved into
   displaced/); E8 the file put back to an earlier version → rollback banner, nothing automatic, "Use the
   earlier version" + Save keeps the dropped versions; E9 both changed the table → "choose" banner, nothing
   written, Choose… → theirs → Apply; E10 its Versions list (lanes, chips, computers); E11 a phase 1 file
   (the runner places "E2E golden p1.lag", written by the phase 1 Rust) opens, combines and saves with its
   old versions unchanged. "combineRestore" (after "combine"): the same Versions list after a restart
   (graph-seen.json is checked by the runner).
   "opens" (double-click test of a bundled debug app): the files in `opens` arrive from Finder — the first
   before the page listens (pending buffer), the rest while it runs (live event, sent by the runner after
   the result says stage "cold").
   "renamed" (after "missing"): the runner renamed movedDir/E2E C.lag to "E2E C renamed.lag" while the app was
   closed; the tab must be on the new name at once (no waiting card, also in a cloud folder). */

import { useGraphStore } from "../../../store/graphStore";
import { useFileSession } from "./session";
import { tauriInvoke } from "./tauriBackend";
import { buildNextFile, fileAt, newDocKey, openFile } from "./docCodec";
import { editContent } from "./devSim";
import { MENU, type FileTab, type PathPickerRequest, type RevisionP2 } from "./contract";
import { canonicalJson, type GraphFileData, type SectionName } from "./format";
import { combineDelayMs } from "./graphMerge";

interface Script {
  phase: "first" | "restore" | "missing" | "renamed" | "opens" | "combine" | "combineRestore";
  roots: string[];
  dir: string;
  otherDir: string;
  movedDir?: string;
  opens?: string[];
  quit: "menu" | "window" | "terminate";
}

interface Step { name: string; ok: boolean; ms: number; detail?: unknown; error?: string }

let started = false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const S = () => useFileSession.getState();
const G = () => useGraphStore.getState();
const inv = <T = unknown>(cmd: string, args: Record<string, unknown> = {}) => tauriInvoke(cmd, args) as Promise<T>;
const log = (line: string) => { void inv("dev_e2e_log", { line }).catch(() => undefined); };
const fs = <T = unknown>(op: string, path: string, to?: string) => inv<T>("dev_e2e_fs", { op, path, to: to ?? null });

async function until<T>(what: string, fn: () => T | Promise<T>, ms = 15000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out after ${ms} ms waiting for: ${what}`);
    await sleep(100);
  }
}

const activeTab = (): FileTab | null => S().tabs.find((t) => t.key === S().activeKey) ?? null;
const cell = () => G().doc?.cells?.[0]?.[0]?.[0] ?? null;
const lag = (dir: string, name: string) => `${dir}/${name}.lag`;

export async function runE2EIfAsked(): Promise<void> {
  if (!import.meta.env.DEV || started) return;
  started = true;
  let script: Script | null = null;
  try { script = await inv<Script | null>("dev_e2e_script"); } catch { return; }   // release / not Tauri: nothing
  if (!script) return;
  const steps: Step[] = [];
  const result: Record<string, unknown> = { phase: script.phase, startedAt: new Date().toISOString(), steps, toasts: [] as string[], warnings: [] as string[] };
  const toasts = result.toasts as string[];
  const warnings = result.warnings as string[];
  const origWarn = console.warn.bind(console);
  const origErr = console.error.bind(console);
  console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(" ").slice(0, 300)); origWarn(...a); };
  console.error = (...a: unknown[]) => { warnings.push(`error: ${a.map(String).join(" ").slice(0, 300)}`); origErr(...a); };
  let seenToast = 0;
  const noteToasts = (s: ReturnType<typeof S>) => {
    for (const t of s.toasts) if (t.id > seenToast) { seenToast = t.id; toasts.push(`${t.kind}${t.name ? `:${t.name}` : ""}${t.message ? `:${t.message}` : ""}`); }
  };
  noteToasts(S());          // toasts shown during init (restore) are already there
  useFileSession.subscribe(noteToasts);
  // The OS save / open / folder dialogs can't be clicked here: answer them from the script.
  let nextPath: string | null = null;
  useFileSession.internal.deps.pickPath = async (req: PathPickerRequest) => {
    const p = nextPath;
    nextPath = null;
    log(`picker ${req.mode} "${req.title}" → ${p}`);
    return p;
  };
  const step = async (name: string, fn: () => Promise<unknown>) => {
    const t0 = Date.now();
    log(`step ${name}…`);
    try {
      const detail = await fn();
      steps.push({ name, ok: true, ms: Date.now() - t0, detail });
      log(`step ${name}: ok`);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      steps.push({ name, ok: false, ms: Date.now() - t0, error });
      log(`step ${name}: FAILED ${error}`);
    }
  };
  const check = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };
  const write = async () => {
    result.passed = steps.filter((s) => s.ok).length;
    result.failed = steps.filter((s) => !s.ok).map((s) => s.name);
    result.finishedAt = new Date().toISOString();
    await inv("dev_e2e_result", { result });
  };
  const backend = () => useFileSession.internal.backend()!;

  /** Another computer saves a new version of `path` (content edited at the first cell): built with
   *  the app's own code, saved to a staging folder, then copied over `path` the way a sync client does. */
  const externalEdit = async (path: string, stage: string, section: SectionName = "table", opts: { to?: string; fromParent?: boolean } = {}): Promise<{ head: string; value: string }> => {
    const r = await backend().read(path);
    if (!r.ok) throw new Error(`read ${path}: ${r.code}`);
    let src = r.file;
    if (opts.fromParent) {
      const parent = src.manifest.revisions.find((x) => x.id === src.manifest.head)?.parents[0];
      src = (parent && fileAt(src, parent)) || src;
    }
    const c = openFile(src);
    if (!c) throw new Error("can't open the file's content");
    const next = editContent(c, section);
    const author = { user_name: "Other Person", device_id: "d-e2e-other", device_name: "Other Mac", session_id: "s-e2e-other", app_version: "e2e", platform: "macos" };
    const f = await buildNextFile(src, next, { time: Date.now(), author });
    const res = await backend().save({ path: stage, expectedHead: null, analysisId: f.manifest.analysis_id, docKey: newDocKey(), manifest: f.manifest, newParts: f.parts, replaceExisting: true });
    if (!res.ok) throw new Error(`stage save: ${JSON.stringify(res)}`);
    await fs("copyOver", stage, opts.to ?? path);
    return { head: f.manifest.head, value: next.doc.cells[0][0][0] };
  };
  const tempFiles = async (dir: string) => (await fs<string[]>("list", dir)).filter((n) => n.startsWith(".~"));

  /** Answer the quit dialog with "keep", after recording what it listed. */
  const quitAndKeep = async () => {
    const unsub = useFileSession.subscribe((s) => {
      if (s.dialog?.kind === "quit") {
        unsub();
        result.quitDialog = s.dialog.dirty.map((d) => d.title);
        steps.push({ name: `quit (${script!.quit}) asked about unsaved work`, ok: true, ms: 0, detail: result.quitDialog });
        void write().then(() => S().answerDialog({ kind: "quit", choice: "keep" }));
      }
    });
    result.quitRequestedAt = new Date().toISOString();
    await write();
    log(`quitting via ${script!.quit}`);
    await inv("dev_e2e_quit", { how: script!.quit });
  };

  try {
    await until("controller ready", () => S().ready, 30000);
    result.appInfo = await backend().appInfo();
    const dir = script.dir;
    const A = lag(dir, "E2E A"), B = lag(dir, "E2E B"), Cp = lag(dir, "E2E C");

    if (script.phase === "first") {
      await step("settings: both names", async () => {
        await S().setSettings({ userName: "E2E Person", deviceName: "E2E Mac" });
        const d = await backend().device();
        check(d.user_name === "E2E Person" && d.device_name === "E2E Mac", `device ${JSON.stringify(d)}`);
        return S().settings;
      });
      await step("new + edit + save untitled → E2E A.lag", async () => {
        const o = await S().newDoc("column", true);
        check(o.ok, `newDoc ${JSON.stringify(o)}`);
        G().setCell(0, 0, 0, "42.5");
        await until("dirty", () => activeTab()?.dirty);
        nextPath = A;
        const s = await S().save();
        check(s.ok && s.path === A, `save ${JSON.stringify(s)}`);
        const t = activeTab()!;
        check(t.title === "E2E A" && !t.dirty && t.path === A, `tab ${JSON.stringify({ title: t.title, dirty: t.dirty, path: t.path })}`);
        const r = await backend().read(A);
        check(r.ok, "read back");
        if (!r.ok) return;
        const head = r.file.manifest.revisions.find((x) => x.id === r.file.manifest.head)!;
        check(head.user_name === "E2E Person" && head.device_name === "E2E Mac", `head author ${head.user_name}/${head.device_name}`);
        check((await tempFiles(dir)).length === 0, "temp file left");
        return { head: r.file.manifest.head, files: await fs("list", dir) };
      });
      await step("edit + Save → new version; Save with no change writes nothing", async () => {
        G().setCell(0, 0, 0, "43.5");
        await until("dirty", () => activeTab()?.dirty);
        const s = await S().save();
        check(s.ok, `save ${JSON.stringify(s)}`);
        const r1 = await backend().read(A);
        check(r1.ok && r1.file.manifest.revisions.length === 2, "two versions");
        const s2 = await S().save();
        const r2 = await backend().read(A);
        check(r1.ok && r2.ok && r2.file.manifest.head === r1.file.manifest.head && r2.stat.mtime === r1.stat.mtime, "unchanged save wrote");
        return { second: s2, head: r1.ok ? r1.file.manifest.head : null };
      });
      await step("close tab, reopen from disk", async () => {
        const closed = await S().closeTab();
        check(closed && S().tabs.length === 0, "close");
        const o = await S().open(A);
        check(o.ok, `open ${JSON.stringify(o)}`);
        await until("loaded", () => cell() === "43.5" && !activeTab()?.dirty);
        return { cell: cell() };
      });
      await step("rename in Finder → tab follows (poll)", async () => {
        const t0 = Date.now();
        await fs("rename", A, B);
        await until("tab follows the rename", () => activeTab()?.path === B && activeTab()?.title === "E2E B", 20000);
        return { followedAfterMs: Date.now() - t0, recent0: S().recent[0]?.path };
      });
      await step("rename by case only in Finder → tab follows, no copy question", async () => {
        const lower = lag(dir, "e2e b");
        const t0 = Date.now();
        await fs("rename", B, lower);
        await until("tab follows the new spelling", () => activeTab()?.path === lower, 20000);
        const after = Date.now() - t0;
        await sleep(3500);
        check(!activeTab()?.banners.some((b) => b.kind === "copyQuestion" || b.kind === "extraCopy"), `banners ${activeTab()?.banners.map((b) => b.kind)}`);
        await fs("rename", lower, B);
        await until("tab follows back", () => activeTab()?.path === B, 20000);
        return { followedAfterMs: after, banners: activeTab()?.banners.map((b) => b.kind), files: await fs("list", dir) };
      });
      let ext1 = { head: "", value: "" };
      await step("another computer saves (clean tab) → reloads in place", async () => {
        const t0 = Date.now();
        ext1 = await externalEdit(B, lag(script!.otherDir, "stage1"));
        await until("reloaded", () => cell() === ext1.value && activeTab()?.baseRevision === ext1.head && !activeTab()?.dirty, 20000);
        return { ...ext1, afterMs: Date.now() - t0, banners: activeTab()?.banners.map((b) => b.kind) };
      });
      await step("another computer saves (unsaved changes here) → banner, Save → combine dialog → Mine → Apply", async () => {
        G().setCell(0, 0, 0, "100");
        await until("dirty", () => activeTab()?.dirty);
        const t0 = Date.now();
        const ext2 = await externalEdit(B, lag(script!.otherDir, "stage2"));
        await until("newer-version banner", () => activeTab()?.banners.some((b) => b.kind === "newerOnDisk"), 20000);
        const bannerAfter = Date.now() - t0;
        check(cell() === "100", "my unsaved edit kept");
        // Phase 2: both changed the table → the combine dialog (the conflict sheet is only the fallback).
        const s = await S().save();
        check(!s.ok && s.reason === "conflict" && S().dialog?.kind === "combine", `save ${JSON.stringify(s)} dialog ${S().dialog?.kind}`);
        await S().setSectionChoice("table", "mine");
        const ap = await S().applyCombine();
        check(ap.ok, `apply ${JSON.stringify(ap)}`);
        await until("saved", () => !activeTab()?.dirty && !activeTab()?.notSaved, 15000);
        const r = await backend().read(B);
        check(r.ok, "read");
        if (!r.ok) return;
        const m = r.file.manifest;
        const head = m.revisions.find((x) => x.id === m.head)!;
        check(head.kind === "merge" && head.parents.includes(ext2.head), `head ${JSON.stringify(head.parents)} ${head.kind}`);
        check(m.revisions.some((x) => x.id === ext1.head) && m.revisions.some((x) => x.id === ext2.head), "their versions in history");
        check(openFile(r.file)?.doc.cells[0][0][0] === "100", "my value on top");
        return { bannerAfterMs: bannerAfter, head: m.head, parents: head.parents, revisions: m.revisions.length };
      });
      await step("Finder duplicate beside the file → the copy question; 'separate' gives it a new id", async () => {
        const copy = lag(dir, "E2E B copy");
        await fs("copyOver", B, copy);
        const b = (await until("copy question", () => activeTab()?.banners.find((x) => x.kind === "copyQuestion"), 20000))!;
        await S().bannerAction(activeTab()!.key, b.id, "separate");
        const h1 = await backend().header(B), h2 = await backend().header(copy);
        check(h1.ok && h2.ok && h1.header.analysis_id !== h2.header.analysis_id, "copy kept the same id");
        await sleep(4000);
        return { banners: activeTab()?.banners.map((x) => x.kind), copyId: h2.ok ? h2.header.analysis_id : null };
      });
      await step("second file E2E C (xy) with unsaved changes + an edited untitled tab", async () => {
        check((await S().newDoc("xy", true)).ok, "newDoc xy");
        G().setCell(0, 0, 0, "7");
        nextPath = Cp;
        const s = await S().save();
        check(s.ok, `save C ${JSON.stringify(s)}`);
        G().setCell(0, 0, 0, "8");                         // left unsaved
        await until("dirty C", () => activeTab()?.dirty);
        check((await S().newDoc("grouped", true)).ok, "newDoc grouped");
        G().setCell(0, 0, 0, "5");                         // untitled, left unsaved
        await until("dirty untitled", () => activeTab()?.dirty);
        const bKey = S().tabs.find((t) => t.path === B)!.key;
        await S().switchTab(bKey);
        await until("B active", () => activeTab()?.path === B && cell() === "100");
        return S().tabs.map((t) => ({ title: t.title, dirty: t.dirty, path: t.path }));
      });
      await step("no temporary files left in the folder", async () => {
        const left = await tempFiles(dir);
        check(left.length === 0, `left: ${left.join(", ")}`);
        return await fs("list", dir);
      });
      await quitAndKeep();
      return;
    }

    if (script.phase === "restore") {
      await step("tabs restored after relaunch", async () => {
        await until("3 tabs", () => S().tabs.length === 3, 20000);
        const tabs = S().tabs.map((t) => ({ title: t.title, dirty: t.dirty, path: t.path, status: t.status, banners: t.banners.map((b) => b.kind) }));
        check(activeTab()?.path === B, `active ${activeTab()?.path}`);
        await until("B loaded", () => cell() === "100" && !activeTab()?.dirty, 15000);
        const c = S().tabs.find((t) => t.path === Cp);
        const u = S().tabs.find((t) => t.path === null);
        check(c?.dirty, "C keeps its unsaved changes");
        check(u && /\(recovered\)/.test(u.title), `untitled title ${u?.title}`);
        check(toasts.some((t) => t.startsWith("restoredDrafts")), `toasts ${toasts.join(", ")}`);
        return tabs;
      });
      await step("switch to C: the unsaved value is back", async () => {
        const c = S().tabs.find((t) => t.path === Cp)!;
        await S().switchTab(c.key);
        await until("C value 8", () => cell() === "8" && activeTab()?.dirty, 15000);
        return { cell: cell(), banners: activeTab()?.banners.map((b) => b.kind) };
      });
      await step("settings survived the restart", async () => {
        check(S().settings?.userName === "E2E Person" && S().settings?.deviceName === "E2E Mac", JSON.stringify(S().settings));
        return S().settings;
      });
      await step("Recent lists both files", async () => {
        const paths = S().recent.map((r) => r.path);
        check(paths.includes(B) && paths.includes(Cp), paths.join(", "));
        return paths;
      });
      await quitAndKeep();
      return;
    }

    if (script.phase === "opens") {
      const [first, second] = script.opens ?? [];
      await step("file opened from Finder while the app was not running", async () => {
        await until("tab for the first file", () => S().tabs.some((t) => t.path === first), 20000);
        await until("loaded", () => activeTab()?.path === first && !!G().doc, 15000);
        return S().tabs.map((t) => t.path);
      });
      result.stage = "cold";
      await write();
      await step("file opened from Finder while the app runs", async () => {
        await until("tab for the second file", () => activeTab()?.path === second, 30000);
        return S().tabs.map((t) => t.path);
      });
      result.stage = "warm";
      await write();
      await step("opening an open file again switches to its tab", async () => {
        await until("first file active again, 'already open' said", () => activeTab()?.path === first && toasts.some((t) => t.startsWith("alreadyOpen")), 30000);
        check(S().tabs.length === 2, `tabs ${S().tabs.length}`);
        return S().tabs.map((t) => t.path);
      });
      result.stage = "done";
      await write();
      await inv("dev_e2e_quit", { how: script.quit });
      return;
    }

    if (script.phase === "combine") {
      const F = lag(dir, "E2E P2");
      const stage = (n: string) => lag(script!.otherDir, `stage-p2-${n}`);
      const headOf = async (p: string) => { const r = await backend().read(p); if (!r.ok) throw new Error(`read ${p}: ${r.code}`); return r.file; };
      await step("E1: another computer's graph save meets an unsaved table edit → Save combines both", async () => {
        check((await S().newDoc("column", true)).ok, "newDoc");
        G().setCell(0, 0, 0, "11");
        nextPath = F;
        check((await S().save()).ok, "first save");
        G().setCell(0, 0, 0, "12");
        await until("dirty", () => activeTab()?.dirty);
        const ext = await externalEdit(F, stage("e1"), "figure");
        await until("newer-version banner with Combine", () => activeTab()?.banners.find((b) => b.kind === "newerOnDisk")?.actions.includes("combine"), 20000);
        const s = await S().save();
        check(s.ok, `save ${JSON.stringify(s)}`);
        const f = await headOf(F);
        const h = f.manifest.revisions.find((r) => r.id === f.manifest.head)! as RevisionP2;
        check(h.kind === "merge" && h.parents.length === 2 && h.parents.includes(ext.head), `head ${JSON.stringify(h.parents)}`);
        const c = openFile(f)!;
        check(c.doc.cells[0][0][0] === "12" && c.figure.title === G().figure.title && !!c.figure.title, `content ${c.doc.cells[0][0][0]} / ${c.figure.title}`);
        const w = h.parents.find((p) => p !== ext.head)!;
        const j = await backend().readJournal(f.manifest.analysis_id, w);
        check(!!j && j.manifest.head === w, "my working version is in this computer's saved copies");
        check(activeTab()?.banners.some((b) => b.kind === "combined"), `banners ${activeTab()?.banners.map((b) => b.kind)}`);
        return { head: h.id, parents: h.parents, auto: h.auto ?? false };
      });
      const copy1 = lag(dir, "E2E P2 (Other Mac's conflicted copy 2026-11-22)");
      const copy2 = lag(dir, "E2E P2 (Other Mac's conflicted copy 2026-11-22) (1)");
      await step("E2: a diverged copy beside it → combined into the shorter-named file; removed; a second diverged copy is refused", async () => {
        G().setCell(1, 0, 0, "21");
        check((await S().save()).ok, "save");
        const theirs = await externalEdit(F, stage("e2"), "figure", { to: copy1, fromParent: true });
        await until("diverged copy banner", () => activeTab()?.banners.find((b) => b.path === copy1 && b.kind === "extraCopy" && b.relation === "diverged"), 20000);
        await S().startCombine(activeTab()!.key, { kind: "copy", path: copy1 });
        await until("combined", () => activeTab()?.banners.some((b) => b.kind === "combined" && b.version?.head === theirs.head), 20000);
        check(activeTab()?.path === F, `tab ${activeTab()?.path}`);
        const f = await headOf(F);
        const h = f.manifest.revisions.find((r) => r.id === f.manifest.head)!;
        check(h.parents.includes(theirs.head), "the copy's version is a parent");
        await until("older copy banner", () => activeTab()?.banners.find((b) => b.path === copy1 && b.relation === "older"), 20000);
        const removed = await S().removeExtraCopy(activeTab()!.key, copy1);
        check(removed, "removed");
        const names = await fs<string[]>("list", dir);
        check(!names.includes("E2E P2 (Other Mac's conflicted copy 2026-11-22).lag"), `still there: ${names.join(", ")}`);
        const disp = await backend().listDisplaced();
        const entry = disp.find((d) => d.original === copy1 && d.reason === "removedCopy");
        check(!!entry, `displaced ${JSON.stringify(disp)}`);
        await externalEdit(F, stage("e2b"), "analysis", { to: copy2, fromParent: true });
        await until("second copy seen", () => activeTab()?.banners.find((b) => b.path === copy2), 20000);
        const refused = await S().removeExtraCopy(activeTab()!.key, copy2);
        check(!refused, "a diverged copy was removed");
        check((await fs<string[]>("list", dir)).includes("E2E P2 (Other Mac's conflicted copy 2026-11-22) (1).lag"), "second copy gone");
        return { displaced: entry, toasts: toasts.slice(-3) };
      });
      await step("E3: Bring back → a restore version with restored_from", async () => {
        const f0 = await headOf(F);
        const first = f0.manifest.revisions[0].id;
        const out = await S().bringBack(first);
        check(out.ok, `bringBack ${JSON.stringify(out)}`);
        const f = await headOf(F);
        const h = f.manifest.revisions.find((r) => r.id === f.manifest.head)! as RevisionP2;
        check(h.kind === "restore" && h.restored_from === first && h.parents[0] === f0.manifest.head, `head ${JSON.stringify(h)}`);
        await S().openVersions();
        await until("versions listed", () => S().versions && !S().versions!.loading && S().versions!.rows.length > 0, 15000);
        result.versionRows = S().versions!.rows.map((r) => ({ id: r.id, chips: r.chips, summary: r.summary }));
        return result.versionRows;
      });
      await step("E4: File → Versions toggles the panel", async () => {
        check(!!S().versions, "panel open before");
        await fs("menu", MENU.versions);
        await until("panel closed", () => S().versions === null, 10000);
        await fs("menu", MENU.versions);
        await until("panel open", () => S().versions !== null, 10000);
        return { open: !!S().versions };
      });

      // ── Two computers on a second file (integrator, phase 2): the other computer is played through
      //    dev_e2e_fs copyOver (staged with the app's own code), the way a sync client delivers files. ──
      const G2 = lag(dir, "E2E P2b");
      const tabG = () => S().tabs.find((t) => t.path === G2) ?? null;
      const bannersG = () => tabG()?.banners ?? [];
      const revOf = (f: { manifest: { revisions: RevisionP2[] } }, id: string) => f.manifest.revisions.find((r) => r.id === id) as RevisionP2 | undefined;
      /** Stage `file` (as another computer's app would have written it) and deliver it to `to`. */
      const deliver = async (file: GraphFileData, n: string, to: string) => {
        const res = await backend().save({ path: stage(n), expectedHead: null, analysisId: file.manifest.analysis_id, docKey: newDocKey(), manifest: file.manifest, newParts: file.parts, replaceExisting: true });
        if (!res.ok) throw new Error(`stage save: ${JSON.stringify(res)}`);
        await fs("copyOver", stage(n), to);
      };
      const myDevice = (await backend().device()).device_id;
      let e6 = { mine: "", theirs: "" };
      const delay = await combineDelayMs(myDevice);
      result.combineDelayMs = delay;
      await step("E6: two computers — another computer's save replaced my last save (clean tab, other part) → combined by itself after this computer's delay", async () => {
        check((await S().newDoc("column", true)).ok, "newDoc");
        G().setCell(0, 0, 0, "50");
        nextPath = G2;
        check((await S().save()).ok, "first save");
        G().setCell(0, 0, 0, "51");
        await until("dirty", () => tabG()?.dirty);
        check((await S().save()).ok, "my second save");
        const mine = (await headOf(G2)).manifest.head;
        await until("clean", () => !tabG()?.dirty && tabG()?.baseRevision === mine);
        const t0 = Date.now();
        const theirs = await externalEdit(G2, stage("e6"), "figure", { fromParent: true });     // built on my first save: replaces my second one
        await until("'combining both now' banner", () => bannersG().some((b) => b.kind === "savedOver" && b.state === "combining"), 20000);
        const bannerAfter = Date.now() - t0;
        check(tabG()?.combining === true, "tab.combining");
        const onDiskWhileWaiting = (await headOf(G2)).manifest.head;
        check(onDiskWhileWaiting === theirs.head, `written before the delay: ${onDiskWhileWaiting}`);
        await until("one combined version on disk", async () => (await headOf(G2)).manifest.revisions.some((r) => r.parents.length === 2 && r.parents.includes(theirs.head) && r.parents.includes(mine)), 30000);
        const wroteAfter = Date.now() - t0;
        const f = await headOf(G2);
        const h = revOf(f, f.manifest.head)!;
        check(h.kind === "merge" && h.auto === true && h.user_name === "" && h.device_id === "" && [...h.parents].sort().join() === [mine, theirs.head].sort().join(), `head ${JSON.stringify({ kind: h.kind, auto: h.auto, user: h.user_name, parents: h.parents })}`);
        check(f.manifest.revisions.filter((r) => r.parents.length === 2).length === 1, "exactly one combined version");
        const c = openFile(f)!;
        check(c.doc.cells[0][0][0] === "51" && /edited\)?$/i.test(c.figure.title ?? ""), `both changes: ${c.doc.cells[0][0][0]} / ${c.figure.title}`);
        check(h.sections_from?.figure === theirs.head && h.sections_from?.table === mine, `sections_from ${JSON.stringify(h.sections_from)}`);
        await until("tab shows the combined version, clean", () => tabG()?.baseRevision === h.id && !tabG()?.dirty && !tabG()?.combining && cell() === "51" && G().figure.title === c.figure.title, 15000);
        e6 = { mine, theirs: theirs.head };
        check(wroteAfter >= delay - 500, `combined after ${wroteAfter} ms, the delay is ${delay} ms`);
        return { delay, bannerAfterMs: bannerAfter, wroteAfterMs: wroteAfter, head: h.id, parents: h.parents, banners: bannersG().map((b) => `${b.kind}${b.state ? `:${b.state}` : ""}`) };
      });
      const oldCopy = lag(dir, "E2E P2b (old copy)");
      await step("E7: an older copy beside the file → [Remove it] [Keep]; Remove it moves it into the app's own folder", async () => {
        const f = await headOf(G2);
        const first = f.manifest.revisions[0].id;
        const older = fileAt(f, first);
        check(!!older, "first version stored");
        await deliver(older!, "e7", oldCopy);
        const b = (await until("older-copy banner", () => bannersG().find((x) => x.kind === "extraCopy" && x.path === oldCopy && x.relation === "older"), 20000))!;
        check(b.actions.includes("remove") && b.actions.includes("keep"), `actions ${b.actions}`);
        await S().bannerAction(tabG()!.key, b.id, "remove");
        await until("copy gone from the folder", async () => !(await fs<string[]>("list", dir)).includes("E2E P2b (old copy).lag"), 15000);
        const disp = (await backend().listDisplaced()).find((d) => d.original === oldCopy && d.reason === "removedCopy");
        check(!!disp && disp.head === first, `displaced ${JSON.stringify(disp)}`);
        check(!!(await backend().readDisplaced(disp!.id)), "the removed copy can still be read from the app's own folder");
        check(toasts.some((t) => t.startsWith("copyRemoved")), `toasts ${toasts.slice(-3)}`);
        check(!bannersG().some((x) => x.path === oldCopy), "banner gone");
        return { displaced: disp };
      });
      await step("E8: rollback — the file is put back to an earlier version → banner, nothing automatic; 'Use the earlier version' then Save keeps the dropped versions in the history", async () => {
        const f = await headOf(G2);
        const dropped = f.manifest.head;
        check(revOf(f, dropped)?.parents.includes(e6.mine), "head is the combine of E6");
        const earlierId = e6.mine;                         // my own save from before the combine
        const earlier = fileAt(f, earlierId)!;
        await deliver(earlier, "e8", G2);
        const b = (await until("rollback banner", () => bannersG().find((x) => x.kind === "rolledBack"), 20000))!;
        check(b.actions.join() === "useEarlier,backToLatest", `actions ${b.actions}`);
        await sleep(4000);
        check((await headOf(G2)).manifest.head === earlierId, "the file was changed by itself");
        check(tabG()?.baseRevision === dropped, "the tab moved by itself");
        await S().bannerAction(tabG()!.key, b.id, "useEarlier");
        await until("tab on the earlier version", () => tabG()?.baseRevision === earlierId && !tabG()?.dirty, 15000);
        G().setCell(1, 0, 0, "88");
        await until("dirty", () => tabG()?.dirty);
        check((await S().save()).ok, "save");
        const g = await headOf(G2);
        check(g.manifest.revisions.some((r) => r.id === dropped), `the dropped version ${dropped} is in the history again`);
        check(revOf(g, g.manifest.head)!.parents[0] === earlierId, "new version on the earlier one");
        return { earlier: earlierId, dropped, head: g.manifest.head, revisions: g.manifest.revisions.length };
      });
      await step("E9: two computers changed the same part → 'Choose what to keep', nothing written; Choose… → theirs → Apply", async () => {
        G().setCell(0, 0, 0, "60");
        await until("dirty", () => tabG()?.dirty);
        check((await S().save()).ok, "my save");
        const mine = (await headOf(G2)).manifest.head;
        const theirs = await externalEdit(G2, stage("e9"), "table", { fromParent: true });
        const b = (await until("'choose' banner", () => bannersG().find((x) => x.kind === "savedOver" && x.state === "choose"), 20000))!;
        check(b.actions.includes("combine"), `actions ${b.actions}`);
        await sleep(Math.max(delay, 2000) + 1500);
        check((await headOf(G2)).manifest.head === theirs.head, "written without a choice");
        await S().bannerAction(tabG()!.key, b.id, "combine");
        await until("combine dialog", () => S().dialog?.kind === "combine", 15000);
        const st = (S().dialog as { state: { canApply: boolean } }).state;
        check(!st.canApply, "Apply enabled before a choice");
        await S().setSectionChoice("table", "theirs");
        const ap = await S().applyCombine();
        check(ap.ok, `apply ${JSON.stringify(ap)}`);
        const g = await headOf(G2);
        const h = revOf(g, g.manifest.head)!;
        check(h.kind === "merge" && !h.auto && h.parents.includes(mine) && h.parents.includes(theirs.head) && h.device_id === myDevice, `head ${JSON.stringify({ kind: h.kind, auto: h.auto, parents: h.parents, user: h.user_name })}`);
        await until("their value shown", () => cell() === theirs.value && !tabG()?.dirty, 15000);
        return { head: h.id, value: theirs.value };
      });
      await step("E10: Versions list of the two-computer file: lanes join at the combines; chips", async () => {
        await S().openVersions(tabG()!.key);
        await until("versions listed", () => S().versions?.tabKey === tabG()!.key && !S().versions!.loading && S().versions!.rows.length > 0, 15000);
        const v = S().versions!;
        const rows = v.rows.map((r) => ({ id: r.id, chips: r.chips, summary: r.summary, who: r.who ? `${r.who.userName}/${r.who.deviceName}` : null }));
        const g = await headOf(G2);
        check(v.rows.length === g.manifest.revisions.length, `${v.rows.length} rows for ${g.manifest.revisions.length} versions`);
        check(v.rows[0].chips.includes("current") && v.rows[0].chips.includes("combined"), `top row ${JSON.stringify(rows[0])}`);
        const auto = v.rows.find((r) => r.summary === "Combined changes from two computers");
        check(!!auto && auto.who === null && auto.chips.includes("combined"), `automatic combine row ${JSON.stringify(auto)}`);
        check(v.layout.laneCount >= 2, `lanes ${v.layout.laneCount}`);
        check(v.devices.some((d) => d.mine) && v.devices.some((d) => d.deviceName === "Other Mac"), `devices ${JSON.stringify(v.devices)}`);
        check(v.tooOld === 0, `tooOld ${v.tooOld}`);
        result.versionRowsB = rows;
        return { laneCount: v.layout.laneCount, devices: v.devices, rows };
      });
      await step("E11: a phase 1 file (golden written by the released Rust) opens, combines and saves; its old versions are unchanged", async () => {
        const P1 = lag(dir, "E2E golden p1");
        check(await fs<boolean>("exists", P1), "the runner did not place the phase 1 golden");
        const before = await headOf(P1);
        const o = await S().open(P1);
        check(o.ok, `open ${JSON.stringify(o)}`);
        await until("loaded", () => activeTab()?.path === P1 && !!G().doc && !activeTab()?.dirty, 15000);
        G().setCell(0, 0, 0, "321");
        await until("dirty", () => activeTab()?.dirty);
        const ext = await externalEdit(P1, stage("e11"), "figure");
        await until("newer-version banner", () => activeTab()?.banners.some((b) => b.kind === "newerOnDisk"), 20000);
        const s = await S().save();
        check(s.ok, `save ${JSON.stringify(s)}`);
        const after = await headOf(P1);
        for (const r of before.manifest.revisions) {
          const a = after.manifest.revisions.find((x) => x.id === r.id);
          check(!!a && canonicalJson({ ...a, sections: null }) === canonicalJson({ ...r, sections: null }), `old version ${r.id} unchanged`);
        }
        const h = revOf(after, after.manifest.head)!;
        check(h.kind === "merge" && h.parents.includes(ext.head) && after.manifest.format_version === 1 && after.manifest.min_reader_version === 1 && after.manifest.features === 1, `head ${JSON.stringify(h.parents)} format ${after.manifest.format_version}/${after.manifest.min_reader_version}/${after.manifest.features}`);
        check(openFile(after)!.doc.cells[0][0][0] === "321", "my value");
        await S().openVersions();
        await until("versions listed", () => !!S().versions && !S().versions!.loading && S().versions!.rows.length === after.manifest.revisions.length, 15000);
        const rows = S().versions!.rows.map((r) => ({ summary: r.summary, chips: r.chips }));
        check(rows.some((r) => r.summary === "First version") && rows.some((r) => r.summary === "Changed the table"), JSON.stringify(rows));
        return { revisions: after.manifest.revisions.length, rows };
      });
      await step("back on E2E P2: its Versions list (compared after the restart)", async () => {
        const fk = S().tabs.find((t) => t.path === F)!.key;
        await S().switchTab(fk);
        await until("F active", () => activeTab()?.path === F && !!G().doc);
        await S().openVersions(fk);
        await until("versions listed", () => S().versions?.tabKey === fk && !S().versions!.loading && S().versions!.rows.length > 0, 15000);
        result.versionRows = S().versions!.rows.map((r) => ({ id: r.id, chips: r.chips, summary: r.summary }));
        return { rows: (result.versionRows as unknown[]).length };
      });
      await quitAndKeep();
      return;
    }

    if (script.phase === "combineRestore") {
      const F = lag(dir, "E2E P2");
      await step("E3: after a restart the Versions list is the same", async () => {
        await until("tab restored", () => activeTab()?.path === F, 20000);
        await until("loaded", () => !!G().doc && !activeTab()?.dirty, 15000);
        await S().openVersions();
        await until("versions listed", () => S().versions && !S().versions!.loading && S().versions!.rows.length > 0, 15000);
        const rows = S().versions!.rows.map((r) => ({ id: r.id, chips: r.chips, summary: r.summary }));
        result.versionRows = rows;
        check(rows.some((r) => r.chips.includes("broughtBack")) && rows.some((r) => r.chips.includes("combined")), JSON.stringify(rows));
        return rows;
      });
      await quitAndKeep();
      return;
    }

    if (script.phase === "renamed") {
      const renamed = lag(script.movedDir!, "E2E C renamed");
      await step("file renamed while the app was closed → followed at once (no waiting card)", async () => {
        const t0 = Date.now();
        await until("tab on the new name", () => S().tabs.some((t) => t.path === renamed), 15000);
        const c = S().tabs.find((t) => t.path === renamed)!;
        check(!S().cards.some((k) => k.key === c.key), `card ${S().cards.find((k) => k.key === c.key)?.kind}`);
        check(toasts.some((t) => t.startsWith("renamed:E2E C renamed")), `toasts ${toasts.join(", ")}`);
        if (S().activeKey !== c.key) await S().switchTab(c.key);
        await until("C loaded with the unsaved value", () => cell() === "8" && activeTab()?.dirty, 15000);
        return { afterReadyMs: Date.now() - t0, toasts: [...toasts], path: activeTab()?.path };
      });
      await quitAndKeep();
      return;
    }

    if (script.phase === "missing") {
      const moved = lag(script.movedDir!, "E2E C");
      await step("file moved while the app was closed → card, Find it… reopens it with its unsaved changes", async () => {
        await until("3 tabs", () => S().tabs.length === 3, 20000);
        const c = S().tabs.find((t) => t.path === Cp)!;
        // Restore leaves C active (it was active at quit), so its card shows.
        const card = (await until("card for C", () => S().cards.find((k) => k.key === c.key), 20000))!;
        const firstKind = card.kind;
        const t0 = Date.now();
        await until("card 'missing'", () => S().cards.find((k) => k.key === c.key)?.kind === "missing", 75000);
        const waitedMs = Date.now() - t0;
        await S().findIt(c.key, script!.movedDir!);
        await until("tab re-pointed", () => S().tabs.find((t) => t.key === c.key)?.path === moved, 30000);
        if (S().activeKey !== c.key) await S().switchTab(c.key);
        await until("C loaded with the unsaved value", () => cell() === "8" && activeTab()?.dirty, 15000);
        return { firstCard: firstKind, waitedForMissingMs: waitedMs, path: activeTab()?.path };
      });
      await quitAndKeep();
      return;
    }
  } catch (e) {
    steps.push({ name: "runner", ok: false, ms: 0, error: e instanceof Error ? e.message : String(e) });
    await write().catch(() => undefined);
    await inv("dev_e2e_quit", { how: "menu" }).catch(() => undefined);
  }
}
