/* DEBUG BUILDS ONLY: the desktop self-test for analysis files.

   Loaded by FilesHost only when `import.meta.env.DEV` (a production build
   drops the import and this file entirely). It does nothing unless the Rust
   debug command `dev_e2e_script` (registered only under cfg(debug_assertions))
   returns a script, i.e. the debug app was started with LAS_E2E_SCRIPT. It then
   drives the real controller (useFileSession) against the real Rust commands,
   plays Finder / another computer through `dev_e2e_fs`, writes
   LAS_STATE_DIR/e2e-result.json and quits through the real quit handshake.

   Script: { phase: "first" | "restore" | "missing" | "renamed" | "opens", roots: string[], dir, otherDir, movedDir?, opens?: string[],
             quit: "menu" | "window" | "terminate" }
   "opens" (double-click test of a bundled debug app): the files in `opens` arrive from Finder — the first
   before the page listens (pending buffer), the rest while it runs (live event, sent by the runner after
   the result says stage "cold").
   "renamed" (after "missing"): the runner renamed movedDir/E2E C.lag to "E2E C renamed.lag" while the app was
   closed; the tab must be on the new name at once (no waiting card, also in a cloud folder). */

import { useGraphStore } from "../../../store/graphStore";
import { useFileSession } from "./session";
import { tauriInvoke } from "./tauriBackend";
import { buildNextFile, newDocKey, openFile } from "./docCodec";
import { editContent } from "./devSim";
import type { FileTab, PathPickerRequest } from "./contract";

interface Script {
  phase: "first" | "restore" | "missing" | "renamed" | "opens";
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
  const externalEdit = async (path: string, stage: string): Promise<{ head: string; value: string }> => {
    const r = await backend().read(path);
    if (!r.ok) throw new Error(`read ${path}: ${r.code}`);
    const c = openFile(r.file);
    if (!c) throw new Error("can't open the file's content");
    const next = editContent(c, "table");
    const author = { user_name: "Other Person", device_id: "d-e2e-other", device_name: "Other Mac", session_id: "s-e2e-other", app_version: "e2e", platform: "macos" };
    const f = await buildNextFile(r.file, next, { time: Date.now(), author });
    const res = await backend().save({ path: stage, expectedHead: null, analysisId: f.manifest.analysis_id, docKey: newDocKey(), manifest: f.manifest, newParts: f.parts, replaceExisting: true });
    if (!res.ok) throw new Error(`stage save: ${JSON.stringify(res)}`);
    await fs("copyOver", stage, path);
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
      await step("another computer saves (unsaved changes here) → banner, Save → conflict sheet → Keep mine", async () => {
        G().setCell(0, 0, 0, "100");
        await until("dirty", () => activeTab()?.dirty);
        const t0 = Date.now();
        const ext2 = await externalEdit(B, lag(script!.otherDir, "stage2"));
        await until("newer-version banner", () => activeTab()?.banners.some((b) => b.kind === "newerOnDisk"), 20000);
        const bannerAfter = Date.now() - t0;
        check(cell() === "100", "my unsaved edit kept");
        const s = await S().save();
        check(!s.ok && s.reason === "conflict" && S().dialog?.kind === "conflict", `save ${JSON.stringify(s)} dialog ${S().dialog?.kind}`);
        await S().resolveConflict("keepMine");
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
