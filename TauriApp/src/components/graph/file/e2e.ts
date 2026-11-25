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
   closed; the tab must be on the new name at once (no waiting card, also in a cloud folder).
   "presence" (phase 3, checklist E1–E9): `dir` is in LAS_NOTE_ROOTS and LAS_CLOUD_ROOTS, `otherDir` only in
   LAS_NOTE_ROOTS (a local folder); LAS_NOTE_HEARTBEAT_MS is short. E1 my note on open (and none for a local file),
   E2 editing / heartbeat / Save / 30 s later idle, E3 another computer's note makes the tab read-only (written by
   the runner's writeText), E4 its save refreshes the read-only tab, E5 Edit here, E6 wake while holding with
   unsaved changes → resuming, a note naming my claim → continued elsewhere, E8 File → Show Others… and Never,
   E7 close tab → note gone; then a second file whose note is left as after a crash; quit as the script says
   (the runner checks the folder after exit). "presenceRestart" (after quit "terminate"): the tab's note is
   replaced (new session, seq continued); the other file's leftover is removed by the 20 s sweep.
   "combineFine" (phase 4, checklist E1–E3): fine-level combining against files "another computer" wrote with
   this build's code (so with combine_v) and, for E3b, without it (an older app). E1 an unsaved edit of one
   cell here + their save of another cell → Save → one two-parent head with both cells, auto, combine_v 1, my
   working version in the journal; E2 both changed the same cell → Save → the dialog with one row to choose,
   nothing on disk changes, theirs + Apply → their value and my other edit; E3 my save replaced on a clean tab
   by a version with combine_v (another cell) → "combining", nothing written before this computer's delay, one
   automatic combine; E3b the same with a version without combine_v → "review", nothing written for 15 s, the
   banner's Combine writes it at once. E2c (integrator) they deleted the last column while I changed a value in
   it → Save → "Column … deleted by …" to choose, nothing on disk changes, Keep + Apply → the column with my value.
   E6a / E6b (integrator, when the runner gives `older`): a file written by the released exp-0.2.25 code (a
   phase 3 file; a file whose head is a phase 2 section-level combine), placed as JSON and saved by this app,
   opens, combines cell by cell on Save and saves; every older version stays byte for byte, the new ones carry
   combine_v, the format fields are unchanged. Quits as the script says. */

import { isDirty, useGraphStore, type DocContent } from "../../../store/graphStore";
import { useFileSession } from "./session";
import { tauriInvoke } from "./tauriBackend";
import { buildNextFile, fileAt, newDocKey, openFile } from "./docCodec";
import { editContent, fineEditContent } from "./devSim";
import { COMBINE_V, MENU, type CombineStateP4, type FileTab, type PathPickerRequest, type RevisionP2, type RevisionP4 } from "./contract";
import { canonicalJson, FEATURES, type GraphFileData, type SectionName } from "./format";
import { combineDelayMs } from "./graphMerge";

interface Script {
  phase: "first" | "restore" | "missing" | "renamed" | "opens" | "combine" | "combineRestore" | "presence" | "presenceRestart" | "combineFine";
  roots: string[];
  dir: string;
  otherDir: string;
  movedDir?: string;
  opens?: string[];
  quit: "menu" | "window" | "terminate";
  /** presenceRestart: what the killed run's note said (seq, session), copied by the runner. */
  leftover?: { seq: number; session: string };
  /** presence: the sync service `dir` must be detected as (the real folder rules, not LAS_CLOUD_ROOTS), e.g. "Dropbox". */
  expectService?: string;
  /** combineFine: GraphFileData JSON files written by the released exp-0.2.25 code (integrator E6a / E6b). */
  older?: { p3?: string; p2comb?: string };
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


  // ── phase 3 ──
  const N = lag(script.dir, "E2E N"), N2 = lag(script.dir, "E2E N2"), L = lag(script.otherDir, "E2E L");
  const OTHER_ID = "d-e2e-other-4f2a";
  interface NoteLike { device_id: string; session_id: string; state: string; head: string | null; base_revision: string | null; epoch: number; seq: number; supersedes: { device_id: string; epoch: number }[] | null; analysis_id: string; document_name: string }
  const parse = (text: string | null): NoteLike | null => {
    if (!text) return null;
    try { return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as NoteLike; } catch { return null; }
  };
  const notesIn = async (dir: string) => (await fs<string[]>("list", dir)).filter((n) => n.toLowerCase().endsWith(".laguse") && !n.startsWith("."));
  const myNote = async (doc: string): Promise<{ name: string; note: NoteLike } | null> => {
    const d = await backend().device();
    const dir = doc.slice(0, doc.lastIndexOf("/"));
    for (const n of await notesIn(dir)) {
      const note = parse(await fs<string | null>("readText", `${dir}/${n}`));
      if (note && note.device_id === d.device_id && note.document_name === doc.slice(dir.length + 1)) return { name: n, note };
    }
    return null;
  };
  const foreignText = (doc: string, over: Partial<NoteLike> & { updated_at?: string }) => {
    const t = activeTab()!;
    const note = {
      format: "lasgraph-presence", v: 1, analysis_id: t.analysisId, document_name: doc.slice(doc.lastIndexOf("/") + 1), device_id: OTHER_ID,
      session_id: "s-e2e-other", device_name: "Other Mac", user_name: "Other Person", state: "editing", head: t.baseRevision,
      base_revision: t.baseRevision, epoch: 1, seq: 1, supersedes: null, updated_at: new Date().toISOString(), request_to: null, handover_to: null,
      features: 2, ...over,
    };
    return `Lab Analysis Suite note: shows who has this analysis open. Safe to delete.\n${JSON.stringify(note, null, 1)}\n`;
  };
  const foreignPath = (doc: string) => `${doc.slice(0, doc.lastIndexOf("/"))}/E2E N (in use on Other Mac, 4f2a).laguse`;
  const guard = () => G().guard?.reason ?? null;

  async function presencePhase(phase: "presence" | "presenceRestart"): Promise<void> {
    if (phase === "presenceRestart") {
      await step("E7b: after a kill, the reopened tab's note is replaced (new session, seq continued)", async () => {
        const before = script!.leftover;
        await until("tab restored", () => activeTab()?.path === N && !!G().doc, 20000);
        const mine = await until("my note", async () => { const m = await myNote(N); return m && m.note.session_id !== before?.session ? m : null; }, 15000);
        check(!before || mine!.note.seq > before.seq, `seq ${mine!.note.seq} after ${before?.seq}`);
        return { note: mine!.note, before };
      });
      await step("E7c: the leftover note of a file that was not reopened goes after the 20 s sweep", async () => {
        await until("N2's note removed", async () => !(await notesIn(script!.dir)).some((n) => n.startsWith("E2E N2 ")), 40000);
        return { notes: await notesIn(script!.dir) };
      });
      await quitAndKeep();
      return;
    }
    await step("settings: names", async () => { await S().setSettings({ userName: "E2E Person", deviceName: "E2E Mac" }); return S().settings; });
    await step("E1: open in a cloud folder → my idle note (§1.1 / §1.2); a local folder → no note", async () => {
      await S().newDoc("column", true);
      nextPath = N;
      const s = await S().save();
      check(s.ok, `save ${JSON.stringify(s)}`);
      const m = await until("my note", () => myNote(N), 15000);
      const text = await fs<string>("readText", `${script!.dir}/${m!.name}`);
      check(/^E2E N \(in use on E2E Mac, [0-9a-f]{4}\)\.laguse$/.test(m!.name), `name ${m!.name}`);
      check(text.startsWith("Lab Analysis Suite note: shows who has this analysis open. Safe to delete.\n{\n \"format\": \"lasgraph-presence\""), "layout");
      check(m!.note.state === "idle" && m!.note.head === activeTab()!.baseRevision, JSON.stringify(m!.note));
      check(activeTab()!.presence?.sharing.why === "cloud", JSON.stringify(activeTab()!.presence?.sharing));
      check(!script!.expectService || activeTab()!.presence?.sharing.service === script!.expectService, `service ${JSON.stringify(activeTab()!.presence?.sharing)}`);
      check(activeTab()!.presence?.mine === "idle", `mine ${activeTab()!.presence?.mine}`);
      await S().newDoc("column", true);
      nextPath = L;
      check((await S().save()).ok, "save L");
      G().setCell(0, 0, 0, "local edit");
      await sleep(1500);
      check((await S().save()).ok, "save L again");
      check((await notesIn(script!.otherDir)).length === 0, `notes in a local folder: ${await notesIn(script!.otherDir)}`);
      await S().closeTab();
      if (activeTab()?.path !== N) await S().switchTab(S().tabs.find((t) => t.path === N)!.key);
      return { name: m!.name, note: m!.note, localNotes: await notesIn(script!.otherDir) };
    });
    await step("E2: an edit → editing (epoch + 1); heartbeat → seq grows; Save → the new head at once; 30 s later idle", async () => {
      const e0 = (await myNote(N))!.note.epoch;
      G().setCell(0, 0, 0, "1.5");
      const ed = await until("editing", async () => { const m = await myNote(N); return m?.note.state === "editing" ? m : null; }, 10000);
      check(ed!.note.epoch === e0 + 1 && ed!.note.base_revision === activeTab()!.baseRevision, JSON.stringify(ed!.note));
      const s0 = ed!.note.seq;
      await until("heartbeat", async () => ((await myNote(N))?.note.seq ?? 0) > s0, 20000);
      check((await S().save()).ok, "save");
      const head = activeTab()!.baseRevision;
      const after = await until("new head", async () => { const m = await myNote(N); return m?.note.head === head ? m : null; }, 5000);
      check(after!.note.state === "editing", "still editing after save");
      const t0 = Date.now();
      await until("idle 30 s later", async () => (await myNote(N))?.note.state === "idle", 45000);
      const idleAfterMs = Date.now() - t0;
      check(idleAfterMs > 20000, `idle only ${idleAfterMs} ms after the save (the 30 s linger)`);
      return { idleAfterMs };
    });
    await step("E3: another computer's editing note on my version → read-only; a higher seq keeps it; deleted → editable", async () => {
      await fs("writeText", foreignPath(N), foreignText(N, {}));
      await until("read-only", () => guard() === "editingElsewhere", 15000);
      const before = cell();
      G().setCell(0, 0, 0, "refused");
      check(cell() === before && !activeTab()!.dirty, "edit applied while read-only");
      await fs("writeText", foreignPath(N), foreignText(N, { seq: 2 }));
      await sleep(4000);
      check(guard() === "editingElsewhere", `guard ${guard()}`);
      await fs("remove", foreignPath(N));
      await until("editable", () => guard() === null, 15000);
      return { banner: activeTab()!.banner?.kind };
    });
    // ── integrator: the other computer's whole life cycle, played through note files only ──
    const peerOf = () => activeTab()?.presence?.peers.find((p) => p.deviceId === OTHER_ID) ?? null;
    const mode = () => activeTab()?.presence?.mode ?? null;
    const gone = async () => { await fs("remove", foreignPath(N)).catch(() => undefined); await until("the note is forgotten", () => !peerOf(), 15000); };
    await step("I1: another computer opens the file (idle note) → listed, still editable, no banner", async () => {
      await fs("writeText", foreignPath(N), foreignText(N, { state: "idle", base_revision: null, epoch: 0, seq: 1 }));
      const p = await until("the idle note is seen", () => peerOf(), 15000);
      check(p!.state === "idle" && guard() === null && mode() === "editable" && !activeTab()!.presence!.readOnly, `${guard()} ${mode()}`);
      check(!activeTab()!.banners.some((b) => ["editingElsewhere", "editingInfo", "waitingNewer"].includes(b.kind)), JSON.stringify(activeTab()!.banners.map((b) => b.kind)));
      return { peer: p, mine: activeTab()!.presence!.mine };
    });
    await step("I2: it starts editing and its note beats (seq 2, 3, 4) → read-only all along; every edit path refused and counted", async () => {
      await fs("writeText", foreignPath(N), foreignText(N, { epoch: 5, seq: 2 }));
      await until("read-only", () => guard() === "editingElsewhere", 15000);
      const pr = activeTab()!.presence!;
      check(pr.mode === "readOnly" && pr.readOnly && pr.guard === "editingElsewhere", JSON.stringify({ mode: pr.mode, ro: pr.readOnly, g: pr.guard }));
      const b = activeTab()!.banners.find((x) => x.kind === "editingElsewhere");
      check(b && b.peers?.some((p) => p.deviceId === OTHER_ID) && b.actions.includes("editAnyway"), `banner ${JSON.stringify(b)}`);
      const a0 = pr.attempt, bs0 = G().blocked?.serial ?? 0, before = cell();
      G().setCell(0, 0, 0, "refused 1");
      G().setAnalysis({});
      G().insertRow(0);
      const saved = await S().save();
      check(cell() === before && !activeTab()!.dirty && !isDirty(G()), "an edit was applied while read-only");
      check(!saved.ok && (saved as { reason?: string }).reason === "readOnly", `save while read-only: ${JSON.stringify(saved)}`);
      check((G().blocked?.serial ?? 0) > bs0 && activeTab()!.presence!.attempt > a0, `attempts not counted: ${G().blocked?.serial} ${activeTab()!.presence!.attempt}`);
      for (const seq of [3, 4]) {
        await sleep(2000);
        await fs("writeText", foreignPath(N), foreignText(N, { epoch: 5, seq }));
      }
      await until("seq 4 seen", () => (peerOf()?.changedAt ?? 0) > 0 && guard() === "editingElsewhere" && activeTab()!.presence!.peers[0]?.freshness === "active", 10000);
      await sleep(3500);
      check(guard() === "editingElsewhere" && mode() === "readOnly", `guard ${guard()} mode ${mode()}`);
      return { attempts: activeTab()!.presence!.attempt, blocked: G().blocked };
    });
    await step("I3: it saves (new version, its note keeps editing on it) → my tab refreshes and stays read-only; then its note says idle → editable", async () => {
      const ext = await externalEdit(N, lag(script!.otherDir, "stageI"));
      await fs("writeText", foreignPath(N), foreignText(N, { epoch: 5, seq: 5, head: ext.head, base_revision: ext.head }));
      await until("refreshed", () => activeTab()?.baseRevision === ext.head && cell() === ext.value, 20000);
      await sleep(3500);
      check(guard() === "editingElsewhere" && !activeTab()!.dirty, `guard ${guard()}`);
      const status = activeTab()!.presence!.status;
      check(status?.kind === "upToDate", `status ${JSON.stringify(status)}`);
      check(!(result.toasts as string[]).some((t) => t.startsWith("reloaded")), `a reloaded toast: ${JSON.stringify(result.toasts)}`);
      await fs("writeText", foreignPath(N), foreignText(N, { state: "idle", epoch: 5, seq: 6, head: ext.head, base_revision: null }));
      await until("editable", () => guard() === null, 15000);
      check(mode() === "editable" && !activeTab()!.presence!.readOnly, `mode ${mode()}`);
      return { head: ext.head, status };
    });
    await step("I4: a note already 20 min old when first seen (a crash leftover) → editable at once, information only, [Edit here] offered", async () => {
      await gone();
      const old = new Date(Date.now() - 20 * 60_000).toISOString();
      await fs("writeText", foreignPath(N), foreignText(N, { epoch: 6, seq: 1, updated_at: old, user_name: "E2E Person" } as Partial<NoteLike>));
      const p = await until("the old note is seen", () => peerOf(), 15000);
      await sleep(3500);
      check(guard() === null && mode() === "info" && p!.freshness === "quiet", `guard ${guard()} mode ${mode()} ${p!.freshness}`);
      const b = activeTab()!.banners.find((x) => x.kind === "editingInfo");
      check(b && b.actions.includes("editHere"), `banner ${JSON.stringify(b)}`);
      return { peer: peerOf(), banner: b };
    });
    await step("I5: a fresh editing note that never changes → read-only, then editable ~90 s after it was first seen (this computer's clock)", async () => {
      await gone();
      await fs("writeText", foreignPath(N), foreignText(N, { epoch: 7, seq: 1 }));
      await until("read-only", () => guard() === "editingElsewhere", 15000);
      const t0 = Date.now();
      await until("quiet → editable", () => guard() === null, 120000);
      const ms = Date.now() - t0;
      check(ms > 75_000 && ms < 105_000, `editable after ${ms} ms`);
      check(mode() === "info", `mode ${mode()}`);
      return { editableAfterMs: ms };
    });
    await step("I6: its note deleted → forgotten at once, editable, no presence banner", async () => {
      await gone();
      check(guard() === null && mode() === "editable", `guard ${guard()} mode ${mode()}`);
      check(!activeTab()!.banners.some((b) => ["editingElsewhere", "editingInfo", "waitingNewer", "bothEditing"].includes(b.kind)), JSON.stringify(activeTab()!.banners.map((b) => b.kind)));
      return { banners: activeTab()!.banners.map((b) => b.kind) };
    });
    await step("E4: while read-only, the other computer's save (and its note on the new version) refreshes the tab", async () => {
      await fs("writeText", foreignPath(N), foreignText(N, { seq: 3, epoch: 2 }));
      await until("read-only", () => guard() === "editingElsewhere", 15000);
      const ext = await externalEdit(N, lag(script!.otherDir, "stageP"));
      await fs("writeText", foreignPath(N), foreignText(N, { seq: 4, epoch: 2, head: ext.head, base_revision: ext.head }));
      await until("refreshed", () => activeTab()?.baseRevision === ext.head && cell() === ext.value, 20000);
      await sleep(3000);
      check(guard() === "editingElsewhere", `guard ${guard()}`);
      return { ...ext, status: activeTab()!.presence?.status };
    });
    await step("E5: Edit here → my note overrides that claim; editable", async () => {
      check(await S().editHere(undefined, true), "editHere");
      check(guard() === null, `guard ${guard()}`);
      check(activeTab()!.presence?.mode === "bothEditing" && !activeTab()!.presence?.readOnly, `mode ${activeTab()!.presence?.mode}`);
      const m = await until("my note overrides", async () => { const x = await myNote(N); return x?.note.supersedes?.some((t) => t.device_id === OTHER_ID && t.epoch === 2) ? x : null; }, 10000);
      check(m!.note.state === "editing" && m!.note.base_revision === activeTab()!.baseRevision, JSON.stringify(m!.note));
      return m!.note;
    });
    await step("E5b (fixer round 2, RV-4): 35 s after Edit here without typing → still editable, my note still editing", async () => {
      await sleep(35000);
      check(guard() === null && !activeTab()!.presence?.readOnly, `guard ${guard()} mode ${mode()}`);
      const m = (await myNote(N))!;
      check(m.note.state === "editing", `my note ${JSON.stringify(m.note)}`);
      return { mode: mode(), note: m.note };
    });
    await step("E5c (fixer round 2, RV-4): the other computer presses Edit here back → read-only at once, my note idle; its note gone → editable", async () => {
      const mine = (await myNote(N))!.note;
      const t0 = Date.now();
      await fs("writeText", foreignPath(N), foreignText(N, { seq: 5, epoch: 3, supersedes: [{ device_id: mine.device_id, epoch: mine.epoch }] }));
      await until("read-only", () => guard() === "editingElsewhere", 15000);
      const ms = Date.now() - t0;
      await until("my note idle", async () => (await myNote(N))?.note.state === "idle", 10000);
      await fs("remove", foreignPath(N));
      await until("editable", () => guard() === null, 15000);
      // Editing again (a new claim), so the next step starts from a holding tab as before.
      const t1 = Date.now();
      G().setCell(0, 0, 0, "after Edit here back");
      const again = await until("my note editing again", async () => { const x = await myNote(N); return x?.note.state === "editing" && x.note.epoch > mine.epoch ? x : null; }, 10000);
      return { readOnlyAfterMs: ms, editingAgainAfterMs: Date.now() - t1, epoch: again!.note.epoch };
    });
    await step("E6: wake while holding with unsaved changes → resuming; a note naming my claim → continued elsewhere, content intact", async () => {
      G().setCell(0, 0, 0, "unsaved before sleep");
      await until("dirty", () => activeTab()?.dirty);
      await fs("wake", "120000");
      await until("resuming", () => guard() === "resuming", 10000);
      const mine = (await myNote(N))!.note;
      await fs("writeText", foreignPath(N), foreignText(N, { seq: 9, epoch: 3, supersedes: [{ device_id: mine.device_id, epoch: mine.epoch }] }));
      await until("continued elsewhere", () => activeTab()?.banners.some((b) => b.kind === "continuedElsewhere"), 15000);
      check(guard() === null && cell() === "unsaved before sleep", `guard ${guard()} cell ${cell()}`);
      await fs("remove", foreignPath(N));
      check((await S().save()).ok, "save");
      return { banners: activeTab()!.banners.map((b) => b.kind) };
    });
    await step("E8: File → Show Others When I'm Editing… → the dialog; Never removes my note", async () => {
      await fs("menu", "file.sharing");
      await until("sharing dialog", () => S().dialog?.kind === "sharing", 10000);
      await S().setSharing(activeTab()!.key, "never");
      await until("note removed", async () => !(await myNote(N)), 10000);
      S().closeDialog();
      await S().setSharing(activeTab()!.key, null);
      await until("note back", () => myNote(N), 10000);
      return { ok: true };
    });
    await step("E7: close the tab → the note is gone; reopen", async () => {
      await sleep(31000);
      await S().closeTab();
      await until("note gone", async () => !(await myNote(N)), 10000);
      check((await S().open(N)).ok, "reopen");
      await until("note back", () => myNote(N), 10000);
      return { notes: await notesIn(script!.dir) };
    });
    await step("E10 (fixer round 2, RV-2): the open file moved to another folder → Find it… → my note beside it there, none left at the old place; and back", async () => {
      const sub = `${script!.dir}/Moved`;
      const moved = lag(sub, "E2E N");
      await fs("mkdir", sub);
      const relocate = async (from: string, to: string, dir: string) => {
        const key = activeTab()!.key;
        await fs("rename", from, to);
        const how = await until("missing or followed", () => activeTab()?.path === to ? "followed"
          : activeTab()?.banners.some((b) => b.kind === "missing") ? "missing" : null, 30000);
        if (how === "missing") {
          await S().findIt(key, dir);
          await until("tab re-pointed", () => activeTab()?.path === to, 30000);
        }
        const m = await until("my note at the new place", () => myNote(to), 15000);
        check(m!.note.document_name === "E2E N.lag", JSON.stringify(m!.note));
        await until("no note of mine left at the old place", async () => !(await myNote(from)), 15000);
        G().setCell(0, 0, 0, `typed after ${how}`);
        const ed = await until("editing at the new place", async () => { const x = await myNote(to); return x?.note.state === "editing" ? x : null; }, 10000);
        check((await S().save()).ok, "save");
        return { how, note: m!.name, editing: ed!.note.epoch };
      };
      const there = await relocate(N, moved, sub);
      const back = await relocate(moved, N, script!.dir);
      return { there, back, notes: await notesIn(script!.dir), sub: await notesIn(sub) };
    });
    await step("E9: the note's name passes the name rules", async () => {
      const names = await notesIn(script!.dir);
      for (const n of names) check(!n.startsWith(".") && !n.startsWith("~") && !/[\\/:*?"<>|]/.test(n) && n.length < 220 && n.endsWith(").laguse"), n);
      return names;
    });
    if (script!.quit === "terminate") {
      await step("a second file whose note is left as after a crash", async () => {
        check((await S().open(N2)).ok || (await (async () => { await S().newDoc("column"); nextPath = N2; return (await S().save()).ok; })()), "N2");
        await until("N2 note", () => myNote(N2), 10000);
        const be = backend();
        const clear = be.presenceClear;
        be.presenceClear = async () => undefined;          // as if the app died before removing it
        try { await S().closeTab(); } finally { be.presenceClear = clear; }
        await S().switchTab(S().tabs.find((t) => t.path === N)!.key);
        G().setCell(0, 0, 0, "editing when killed");
        const m = await until("editing", async () => { const x = await myNote(N); return x?.note.state === "editing" ? x : null; }, 10000);
        result.leftover = { seq: m!.note.seq, session: m!.note.session_id };
        return { notes: await notesIn(script!.dir) };
      });
      // E7: the runner kills the app now (SIGKILL: no quit routine), as a crash would.
      result.readyToKill = true;
      await write();
      return;
    }
    await quitAndKeep();
  }

  // ── phase 4 ──
  async function combineFinePhase(): Promise<void> {
    const dir = script!.dir;
    const F = lag(dir, "E2E P4");
    const stage = (n: string) => lag(script!.otherDir, `stage-p4-${n}`);
    const read = async (p: string) => { const r = await backend().read(p); if (!r.ok) throw new Error(`read ${p}: ${r.code}`); return r.file; };
    const headRevOf = (f: GraphFileData) => f.manifest.revisions.find((r) => r.id === f.manifest.head) as RevisionP4;
    const cellAt = (r: number, c: number) => G().doc?.cells?.[r]?.[c]?.[0] ?? null;
    /** Another computer's save of `path` with exactly the cells given, built with this build's code
     *  (combine_v unless `old`), staged and copied over the file the way a sync client delivers it. */
    const otherSaves = async (path: string, n: string, cells: [number, number, string][], o: { fromParent?: boolean; old?: boolean; edit?: (c: DocContent) => DocContent } = {}) => {
      let src = await read(path);
      if (o.fromParent) {
        const parent = headRevOf(src).parents[0];
        src = (parent && fileAt(src, parent)) || src;
      }
      const c0 = openFile(src)!;
      const c = o.edit ? o.edit(c0) : c0;
      const rows = c.doc.cells.map((row) => row.map((reps) => [...reps]));
      for (const [r, col, v] of cells) rows[r][col][0] = v;
      const author = { user_name: "Other Person", device_id: "d-e2e-other", device_name: "Other Mac", session_id: "s-e2e-other", app_version: "e2e", platform: "macos" };
      const built = await buildNextFile(src, { ...c, doc: { ...c.doc, cells: rows } }, { time: Date.now(), author });
      const f: GraphFileData = o.old ? built : {
        ...built, manifest: { ...built.manifest, revisions: built.manifest.revisions.map((r) => (r.id === built.manifest.head ? { ...r, combine_v: COMBINE_V } : r)) },
      };
      const res = await backend().save({ path: stage(n), expectedHead: null, analysisId: f.manifest.analysis_id, docKey: newDocKey(), manifest: f.manifest, newParts: f.parts, replaceExisting: true });
      if (!res.ok) throw new Error(`stage save: ${JSON.stringify(res)}`);
      await fs("copyOver", stage(n), path);
      return f.manifest.head;
    };
    const tabAt = (p: string) => S().tabs.find((t) => t.path === p) ?? null;
    const tabF = () => tabAt(F);
    const myDevice = (await backend().device()).device_id;
    const delay = await combineDelayMs(myDevice);
    result.combineDelayMs = delay;

    await step("E1: an unsaved edit of one cell + their save of another cell (with combine_v) → Save → one combined version, both cells, auto, combine_v 1", async () => {
      check((await S().newDoc("column", true)).ok, "newDoc");
      nextPath = F;
      check((await S().save()).ok, "first save");
      const first = headRevOf(await read(F));
      check(first.combine_v === COMBINE_V, `first save combine_v ${first.combine_v}`);
      G().setCell(0, 0, 0, "E1 mine");
      await until("dirty", () => tabF()?.dirty);
      const theirs = await otherSaves(F, "e1", [[4, 1, "E1 theirs"]]);
      await until("newer-version banner", () => tabF()?.banners.some((b) => b.kind === "newerOnDisk"), 20000);
      const s = await S().save();
      check(s.ok && S().dialog === null, `save ${JSON.stringify(s)} dialog ${S().dialog?.kind}`);
      const f = await read(F);
      const h = headRevOf(f);
      check(h.kind === "merge" && h.parents.length === 2 && h.parents.includes(theirs), `head ${JSON.stringify(h.parents)}`);
      check(h.auto === true && h.combine_v === COMBINE_V, `auto ${h.auto} combine_v ${h.combine_v}`);
      const c = openFile(f)!;
      check(c.doc.cells[0][0][0] === "E1 mine" && c.doc.cells[4][1][0] === "E1 theirs", `cells ${c.doc.cells[0][0][0]} / ${c.doc.cells[4][1][0]}`);
      const w = h.parents.find((p) => p !== theirs)!;
      const j = await backend().readJournal(f.manifest.analysis_id, w);
      check(!!j && j.manifest.head === w, "my working version is in this computer's saved copies");
      check((j!.manifest.revisions.find((r) => r.id === w) as RevisionP4).combine_v === COMBINE_V, "working version has combine_v");
      const banner = tabF()!.banners.find((b) => b.kind === "combined");
      check(!!banner && JSON.stringify(banner.mixed) === JSON.stringify(["table"]), `combined banner ${JSON.stringify(banner)}`);
      await until("tab shows both cells", () => cellAt(0, 0) === "E1 mine" && cellAt(4, 1) === "E1 theirs" && !tabF()?.dirty, 15000);
      return { head: h.id, parents: h.parents, mixed: banner!.mixed };
    });

    await step("E2: both changed the same cell → Save → one row to choose, nothing on disk changes; theirs + Apply → their value and my other edit", async () => {
      G().setCell(0, 0, 0, "E2 mine");
      G().setCell(3, 2, 0, "E2 other");
      await until("dirty", () => tabF()?.dirty);
      const theirs = await otherSaves(F, "e2", [[0, 0, "E2 theirs"]]);
      await until("newer-version banner", () => tabF()?.banners.some((b) => b.kind === "newerOnDisk"), 20000);
      const s = await S().save();
      check(!s.ok && s.reason === "conflict" && S().dialog?.kind === "combine", `save ${JSON.stringify(s)} dialog ${S().dialog?.kind}`);
      const st = () => (S().dialog as unknown as { state: CombineStateP4 }).state;
      const table = st().sections.find((x) => x.key === "table")!;
      check(st().toChoose === 1 && !st().canApply && table.conflicts.length === 1 && table.conflicts[0].id.startsWith("table:row:"), `state ${JSON.stringify({ toChoose: st().toChoose, ids: table.conflicts.map((c) => c.id) })}`);
      const onDisk = (await read(F)).manifest.head;
      check(onDisk === theirs, `written before Apply: ${onDisk}`);
      await S().setConflictChoice(table.conflicts[0].id, "theirs");
      check(st().canApply && st().toChoose === 0, "Apply not enabled after the choice");
      check((await read(F)).manifest.head === theirs, "written by the choice");
      const ap = await S().applyCombine();
      check(ap.ok, `apply ${JSON.stringify(ap)}`);
      const f = await read(F);
      const h = headRevOf(f);
      check(h.kind === "merge" && !h.auto && h.device_id === myDevice && h.combine_v === COMBINE_V, `head ${JSON.stringify({ auto: h.auto, dev: h.device_id, v: h.combine_v })}`);
      const c = openFile(f)!;
      check(c.doc.cells[0][0][0] === "E2 theirs" && c.doc.cells[3][2][0] === "E2 other", `cells ${c.doc.cells[0][0][0]} / ${c.doc.cells[3][2][0]}`);
      return { head: h.id, conflict: table.conflicts[0].id };
    });

    await step("E2c: they deleted the last column, I changed a value in it → Save → 'Column … deleted' to choose, nothing on disk changes; Keep + Apply → the column with my value and my other edit", async () => {
      const d0 = G().doc!;
      const last = d0.col_titles.length - 1;
      const lastId = d0.col_ids[last];
      check(last >= 1, `columns ${d0.col_titles.length}`);
      G().setCell(1, last, 0, "E2c mine");
      G().setCell(2, 0, 0, "E2c other");
      await until("dirty", () => tabF()?.dirty);
      const theirs = await otherSaves(F, "e2c", [], { edit: (c) => fineEditContent(c, "deleteCol") });
      check(!openFile(await read(F))!.doc.col_ids.includes(lastId), "their version still has the column");
      await until("newer-version banner", () => tabF()?.banners.some((b) => b.kind === "newerOnDisk"), 20000);
      const s = await S().save();
      check(!s.ok && s.reason === "conflict" && S().dialog?.kind === "combine", `save ${JSON.stringify(s)} dialog ${S().dialog?.kind}`);
      const st = () => (S().dialog as unknown as { state: CombineStateP4 }).state;
      const table = st().sections.find((x) => x.key === "table")!;
      const cd = table.conflicts.find((c) => c.kind === "colDeleted");
      check(!!cd && cd.id === `table:col:${lastId}` && cd.deletedBy === "theirs", `conflicts ${JSON.stringify(table.conflicts.map((c) => [c.id, c.kind, c.deletedBy]))}`);
      check(st().toChoose === 1 && !st().canApply, `toChoose ${st().toChoose} canApply ${st().canApply}`);
      check(cd!.items.some((it) => it.mine === "E2c mine" && it.theirs === null), `items ${JSON.stringify(cd!.items)}`);
      check((await read(F)).manifest.head === theirs, "written before Apply");
      await S().setConflictChoice(cd!.id, "mine");                  // the side that did not delete it: keep the column
      check(st().canApply && st().toChoose === 0, "Apply not enabled after the choice");
      const adjustments = st().adjustments.map((a) => `${a.section}:${a.kind}:${a.field ?? ""}`);
      await sleep(1500);
      check((await read(F)).manifest.head === theirs, "written by the choice");
      const ap = await S().applyCombine();
      check(ap.ok, `apply ${JSON.stringify(ap)}`);
      const f = await read(F);
      const h = headRevOf(f);
      check(h.kind === "merge" && h.parents.includes(theirs) && !h.auto && h.combine_v === COMBINE_V, `head ${JSON.stringify({ p: h.parents, auto: h.auto, v: h.combine_v })}`);
      const c = openFile(f)!;
      const at = c.doc.col_ids.indexOf(lastId);
      check(at === last && c.doc.col_titles.length === d0.col_titles.length, `column at ${at}, ${c.doc.col_titles.length} columns`);
      check(c.doc.cells[1][at][0] === "E2c mine" && c.doc.cells[2][0][0] === "E2c other", `cells ${c.doc.cells[1][at][0]} / ${c.doc.cells[2][0][0]}`);
      await until("tab clean on it", () => tabF()?.baseRevision === h.id && !tabF()?.dirty && cellAt(1, last) === "E2c mine", 15000);
      return { head: h.id, conflict: cd!.id, adjustments };
    });

    await step("E3: my save replaced on a clean tab by a version with combine_v (another cell) → 'combining', nothing before the delay, one automatic combine", async () => {
      G().setCell(6, 0, 0, "E3 mine");
      await until("dirty", () => tabF()?.dirty);
      check((await S().save()).ok, "my save");
      const mine = (await read(F)).manifest.head;
      await until("clean", () => !tabF()?.dirty && tabF()?.baseRevision === mine);
      const t0 = Date.now();
      const theirs = await otherSaves(F, "e3", [[7, 1, "E3 theirs"]], { fromParent: true });
      await until("'combining' banner", () => tabF()?.banners.some((b) => b.kind === "savedOver" && b.state === "combining"), 20000);
      check((await read(F)).manifest.head === theirs, "written before the delay");
      await until("one automatic combine", async () => (await read(F)).manifest.revisions.some((r) => r.parents.length === 2 && r.parents.includes(theirs) && r.parents.includes(mine)), 30000);
      const wroteAfter = Date.now() - t0;
      const f = await read(F);
      const h = headRevOf(f);
      check(h.auto === true && h.combine_v === COMBINE_V && h.user_name === "", `head ${JSON.stringify({ auto: h.auto, v: h.combine_v, user: h.user_name })}`);
      const c = openFile(f)!;
      check(c.doc.cells[6][0][0] === "E3 mine" && c.doc.cells[7][1][0] === "E3 theirs", "both cells");
      check(wroteAfter >= delay - 500, `combined after ${wroteAfter} ms, the delay is ${delay} ms`);
      await until("tab clean on it", () => tabF()?.baseRevision === h.id && !tabF()?.combining && cellAt(7, 1) === "E3 theirs", 15000);
      return { delay, wroteAfterMs: wroteAfter, head: h.id };
    });

    await step("E3b: the same with a version WITHOUT combine_v → 'review', nothing written for 15 s; Combine writes it at once", async () => {
      G().setCell(8, 0, 0, "E3b mine");
      await until("dirty", () => tabF()?.dirty);
      check((await S().save()).ok, "my save");
      const mine = (await read(F)).manifest.head;
      await until("clean", () => !tabF()?.dirty && tabF()?.baseRevision === mine);
      const theirs = await otherSaves(F, "e3b", [[9, 1, "E3b theirs"]], { fromParent: true, old: true });
      const b = (await until("'review' banner", () => tabF()?.banners.find((x) => x.kind === "savedOver" && x.state === "review"), 20000))!;
      check(b.actions.join() === "combine", `actions ${b.actions}`);
      await sleep(15000);
      check((await read(F)).manifest.head === theirs, "written without a click");
      check(tabF()?.banners.some((x) => x.kind === "savedOver" && x.state === "review"), "banner went");
      await S().bannerAction(tabF()!.key, b.id, "combine");
      await until("combined", async () => headRevOf(await read(F)).parents.length === 2, 15000);
      check(S().dialog === null, `dialog ${S().dialog?.kind}`);
      const f = await read(F);
      const h = headRevOf(f);
      check(h.parents.includes(mine) && h.parents.includes(theirs) && h.combine_v === COMBINE_V, `head ${JSON.stringify(h.parents)}`);
      const c = openFile(f)!;
      check(c.doc.cells[8][0][0] === "E3b mine" && c.doc.cells[9][1][0] === "E3b theirs", "both cells");
      return { head: h.id };
    });

    const olderFile = async (tag: string, what: string, json: string | undefined, name: string) => {
      if (!json) return;
      await step(`E6${tag}: ${what} (written by the released exp-0.2.25 code) opens, combines cell by cell on Save and saves; its versions stay byte for byte`, async () => {
        const text = await fs<string | null>("readText", json);
        check(!!text, `the runner did not place ${json}`);
        const data = JSON.parse(text!) as GraphFileData;
        check(!data.manifest.revisions.some((r) => "combine_v" in r), "the older file already has combine_v");
        const P = lag(dir, name);
        const placed = await backend().save({ path: P, expectedHead: null, analysisId: data.manifest.analysis_id, docKey: newDocKey(), manifest: data.manifest, newParts: data.parts, replaceExisting: true });
        check(placed.ok, `place ${JSON.stringify(placed)}`);
        const before = await read(P);
        check(before.manifest.head === data.manifest.head, "placed head");
        const o = await S().open(P);
        check(o.ok, `open ${JSON.stringify(o)}`);
        await until("loaded", () => activeTab()?.path === P && !!G().doc && !activeTab()?.dirty, 15000);
        G().setCell(4, 0, 0, `E6${tag} mine`);
        await until("dirty", () => tabAt(P)?.dirty);
        const theirs = await otherSaves(P, `e6${tag}`, [[5, 1, `E6${tag} theirs`]]);
        await until("newer-version banner", () => tabAt(P)?.banners.some((b) => b.kind === "newerOnDisk"), 20000);
        const s = await S().save();
        check(s.ok && S().dialog === null, `save ${JSON.stringify(s)} dialog ${S().dialog?.kind}`);
        const f = await read(P);
        const h = headRevOf(f);
        check(h.kind === "merge" && h.parents.length === 2 && h.parents.includes(theirs) && h.auto === true && h.combine_v === COMBINE_V, `head ${JSON.stringify({ p: h.parents, auto: h.auto, v: h.combine_v })}`);
        const c = openFile(f)!;
        check(c.doc.cells[4][0][0] === `E6${tag} mine` && c.doc.cells[5][1][0] === `E6${tag} theirs`, "both cells");
        for (const r of data.manifest.revisions) {
          const now = f.manifest.revisions.find((x) => x.id === r.id);
          check(!!now && canonicalJson(now) === canonicalJson(r), `older version ${r.id} changed`);
        }
        const added = f.manifest.revisions.filter((x) => !data.manifest.revisions.some((r) => r.id === x.id)) as RevisionP4[];
        check(added.length === 3 && added.every((x) => x.combine_v === COMBINE_V), `added ${JSON.stringify(added.map((x) => [x.kind, x.combine_v]))}`);
        const fm = (m: GraphFileData["manifest"]) => [m.format_version, m.min_reader_version, m.features].join("/");
        check(fm(f.manifest) === fm(data.manifest), `format ${fm(f.manifest)} was ${fm(data.manifest)}`);
        const banner = tabAt(P)!.banners.find((b) => b.kind === "combined");
        check(!!banner && JSON.stringify(banner.mixed) === JSON.stringify(["table"]), `combined banner ${JSON.stringify(banner)}`);
        return { head: h.id, olderVersions: data.manifest.revisions.length, olderHeadParents: revisionOfData(data).parents.length, format: fm(f.manifest) };
      });
    };
    const revisionOfData = (d: GraphFileData) => d.manifest.revisions.find((r) => r.id === d.manifest.head)!;
    await olderFile("a", "a phase 3 file", script!.older?.p3, "E2E older p3");
    await olderFile("b", "a file whose head is a phase 2 combine", script!.older?.p2comb, "E2E older p2comb");
    await quitAndKeep();
  }

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
        check(h.kind === "merge" && h.parents.includes(ext.head) && after.manifest.format_version === 1 && after.manifest.min_reader_version === 1 && after.manifest.features === FEATURES, `head ${JSON.stringify(h.parents)} format ${after.manifest.format_version}/${after.manifest.min_reader_version}/${after.manifest.features}`);
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

    if (script.phase === "presence" || script.phase === "presenceRestart") {
      await presencePhase(script.phase);
      return;
    }

    if (script.phase === "combineFine") {
      await combineFinePhase();
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
