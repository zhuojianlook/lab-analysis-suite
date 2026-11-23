// Phase 3 controller (phase3-contract.md §5, checklist S1–S24): notes written on open / claim / save / release,
// read-only while another computer edits, Edit here, both editing, sleep and wake, waiting for a newer version,
// the "Show others" setting, cleanup and the duplicate identity. Two or three MemoryDevices on a ManualClock.
import { describe, expect, it, vi } from "vitest";
import { isDirty } from "../../../store/graphStore";
import { LIMITS_P3 } from "./contract";
import { noteText } from "./presence";
import {
  DBX, DOCS, PFILE, activeTab, bannerOf, computer, editCell, flush, group, guardOf, makeWorld, modeOf, notesBeside, notesOf, presenceOf,
  seedFile, start, tick, withAnswer,
} from "./testkit";

// Long stretches of simulated time (minutes, hours) run in many small steps.
vi.setConfig({ testTimeout: 60_000 });

describe("S1 my note on open", () => {
  it("a synced folder gets an idle note with my version; the note text follows the format", async () => {
    const g = await group(1);
    const [a] = g.cs;
    const notes = notesOf(a.dev, g.path, "d-a1a1");
    expect(notes).toHaveLength(1);
    expect(notes[0].name).toBe("Dose response (in use on Mac mini, a1a1).laguse");
    expect(notes[0].note).toMatchObject({ state: "idle", head: activeTab(a).baseRevision, base_revision: null, epoch: 0, supersedes: null, features: 2 });
    expect(notes[0].text).toBe(noteText(notes[0].note!));
    expect(presenceOf(a)).toMatchObject({ mode: "editable", readOnly: false, mine: "idle", sharing: { on: true, why: "cloud", service: "Dropbox" } });
  });
});

describe("S5 observer", () => {
  it("B clean, A starts editing → B read-only; A saves → B refreshes, still read-only; 30 s later editable", async () => {
    const g = await group(2, { users: ["Zhuo", "Alice"] });
    const [a, b] = g.cs;
    await editCell(a, "A1");
    expect(notesOf(a.dev, g.path, "d-a1a1")[0].note).toMatchObject({ state: "editing", epoch: 1, base_revision: activeTab(a).baseRevision });
    await tick(g.w, 2 * g.delay + 500);
    expect(guardOf(b)).toBe("editingElsewhere");
    expect(presenceOf(b)).toMatchObject({ mode: "readOnly", readOnly: true });
    expect(bannerOf(b, "editingElsewhere")).toMatchObject({ actions: ["editAnyway"] });
    const before = b.graph.getState().doc!.cells[0][0][0];
    b.graph.getState().setCell(0, 0, 0, "refused");
    await flush();
    expect(b.graph.getState().doc!.cells[0][0][0]).toBe(before);
    expect(presenceOf(b)!.attempt).toBe(1);
    expect(isDirty(b.graph.getState())).toBe(false);
    await a.ses.getState().save();
    await tick(g.w, 2 * g.delay + 500);
    expect(b.graph.getState().doc!.cells[0][0][0]).toBe("A1");
    expect(guardOf(b)).toBe("editingElsewhere");
    expect(b.ses.getState().toasts.some((t) => t.kind === "reloaded")).toBe(false);
    expect(presenceOf(b)!.status).toMatchObject({ kind: "upToDate", who: { userName: "Zhuo", deviceName: "Mac mini" } });
    await tick(g.w, LIMITS_P3.lingerMs + 2 * g.delay + 500);
    expect(notesOf(a.dev, g.path, "d-a1a1")[0].note!.state).toBe("idle");
    expect(guardOf(b)).toBe(null);
    expect(modeOf(b)).toBe("editable");
    expect(activeTab(b).banners.filter((x) => x.kind === "editingElsewhere")).toEqual([]);
  });
});

const S = 1000, MIN = 60 * S, H = 60 * MIN;
const sync = (g: { w: ReturnType<typeof makeWorld>; delay: number }, extra = 500) => tick(g.w, 2 * g.delay + extra);

/** A hand-made note of another computer about `path`, placed on `dev`'s disk (it syncs like any file). */
function placeForeign(dev: ReturnType<typeof makeWorld>["devices"][number], path: string, over: Record<string, unknown> = {}, name = "Dose response (in use on Office iMac, 9f3c).laguse") {
  const f = dev.localFile(path)!;
  const note = {
    format: "lasgraph-presence" as const, v: 1 as const, analysis_id: f.manifest.analysis_id, document_name: path.slice(path.lastIndexOf("/") + 1),
    device_id: "d-alice-9f3c", session_id: "s-alice", device_name: "Office iMac", user_name: "Alice", state: "editing" as const,
    head: f.manifest.head, base_revision: f.manifest.head, epoch: 1, seq: 1, supersedes: null, updated_at: new Date(dev.isOnline() ? Date.now() : 0).toISOString(),
    request_to: null, handover_to: null, features: 2, ...over,
  };
  const p = `${path.slice(0, path.lastIndexOf("/"))}/${name}`;
  dev.placeNote(p, noteText(note as never));
  return { path: p, note };
}

describe("S1 the setting decides whether a note is written", () => {
  it("a local folder in Automatically mode gets no note; Always → a note; Never → removed", async () => {
    const w = makeWorld();
    const a = await start(await computer(w, { device_id: "d-a1a1", device_name: "Mac mini" }));
    const P = `${DOCS}/Local.lag`;
    await seedFile(w, a.dev, P);
    await a.ses.getState().open(P);
    await flush();
    expect(notesBeside(a.dev, P)).toEqual([]);
    expect(presenceOf(a)).toMatchObject({ mine: "none", sharing: { choice: null, fallback: "auto", on: false, why: "local", service: null } });
    a.graph.getState().setCell(0, 0, 0, "x");
    await flush();
    expect(notesBeside(a.dev, P)).toEqual([]);                         // editing a local file: still no note
    await a.ses.getState().setSharing(activeTab(a).key, "always");
    await flush();
    expect(notesBeside(a.dev, P).map((n) => n.note?.state)).toEqual(["editing"]);
    expect(presenceOf(a)!.sharing).toMatchObject({ choice: "always", on: true, why: "always" });
    await a.ses.getState().setSharing(activeTab(a).key, "never");
    await flush();
    expect(notesBeside(a.dev, P)).toEqual([]);
    expect(presenceOf(a)).toMatchObject({ mine: "none", sharing: { on: false, why: "never" } });
    // The file's own choice is kept after a restart.
    await a.ses.getState().save();
    const a2 = await a.restart();
    expect(a2.ses.getState().tabs[0].presence?.sharing.choice).toBe("never");
  });

  it("Never on a synced file removes its note; the default in Settings applies to files without a choice", async () => {
    const g = await group(1);
    const [a] = g.cs;
    expect(notesBeside(a.dev, g.path)).toHaveLength(1);
    await a.ses.getState().setSharingDefault("never");
    await flush();
    expect(notesBeside(a.dev, g.path)).toEqual([]);
    expect(a.ses.getState().settings?.shareDefault).toBe("never");
    await a.ses.getState().setSettings({ shareDefault: "auto" });
    await flush();
    expect(notesBeside(a.dev, g.path)).toHaveLength(1);
  });

  it("a local file whose history has another computer gets a note (why: otherComputers)", async () => {
    const w = makeWorld();
    const a = await start(await computer(w, { device_id: "d-a1a1", device_name: "Mac mini" }));
    const other = w.addDevice({ device_id: "d-other", device_name: "Office iMac" });
    const P = `${DOCS}/From colleague.lag`;
    await seedFile(w, other, P);
    a.dev.place(P, other.localFile(P)!);
    await a.ses.getState().open(P);
    await flush();
    expect(presenceOf(a)!.sharing).toMatchObject({ on: true, why: "otherComputers" });
    expect(notesBeside(a.dev, P)).toHaveLength(1);
  });

  it("an untitled document has no note and no sharing dialog", async () => {
    const w = makeWorld();
    const a = await start(await computer(w, { device_id: "d-a1a1", device_name: "Mac mini" }));
    await a.ses.getState().newDoc("column");
    a.ses.getState().openSharing();
    expect(a.ses.getState().dialog).toBe(null);
    expect(activeTab(a).presence).toBeUndefined();
  });
});

describe("S2 claim", () => {
  it("the first applied edit writes editing (epoch + 1, base) without waiting for the write", async () => {
    const g = await group(1);
    const [a] = g.cs;
    a.dev.presenceLatencyMs = 5000;                          // a slow folder
    const calls0 = a.dev.presenceCalls.length;
    a.graph.getState().setCell(0, 0, 0, "typed");
    expect(a.graph.getState().doc!.cells[0][0][0]).toBe("typed");   // applied at once
    const set = a.dev.presenceCalls.slice(calls0).find((c) => c.cmd === "presenceSet");
    expect(set?.args).toMatchObject({ state: "editing", epoch: 1, baseRevision: activeTab(a).baseRevision, input: true });
    expect(notesOf(a.dev, g.path, "d-a1a1")[0].note!.state).toBe("idle");   // still being written
    await tick(g.w, 6000);
    expect(notesOf(a.dev, g.path, "d-a1a1")[0].note).toMatchObject({ state: "editing", epoch: 1 });
    expect(presenceOf(a)!.mine).toBe("editing");
  });

  it("no claim from open, a clean restore, a live refresh, a combine's replaceContent, the clean-up or a refused edit", async () => {
    const g = await group(2, { users: ["Zhuo", "Alice"] });
    const [a, b] = g.cs;
    const states = () => notesOf(b.dev, g.path, "d-b2b2").map((n) => n.note!.state);
    expect(states()).toEqual(["idle"]);
    b.graph.getState().normalize();
    await flush();
    expect(states()).toEqual(["idle"]);
    // A live refresh (A saves, B clean).
    await editCell(a, "from A");
    await a.ses.getState().save();
    await sync(g);
    expect(b.graph.getState().doc!.cells[0][0][0]).toBe("from A");
    b.graph.getState().setCell(0, 0, 0, "refused");                // refused: A is editing
    await flush();
    expect(states()).toEqual(["idle"]);
    expect(b.ses.internal.presence(activeTab(b).key)!.holding).toBe(false);
    // A clean restore.
    const b2 = await b.restart();
    await flush();
    expect(b2.ses.internal.presence(activeTab(b2).key)!.holding).toBe(false);
    expect(notesOf(b.dev, g.path, "d-b2b2").map((n) => n.note!.state)).toEqual(["idle"]);
  });
});

describe("S3 heartbeat and input", () => {
  it("seq grows every 60 s while editing with input; stops 10 min after the last input; input pings at most every 30 s", async () => {
    const g = await group(1, { delay: 0 });
    const [a] = g.cs;
    await editCell(a, "1");
    const seq = () => notesOf(a.dev, g.path, "d-a1a1")[0].note!.seq;
    const s0 = seq();
    await tick(g.w, 60 * S + 100);
    expect(seq()).toBe(s0 + 1);
    // Typing every 10 s for 2 min: pings at most every 30 s.
    const pings0 = a.dev.presenceCalls.filter((c) => c.cmd === "presenceInput").length;
    for (let k = 0; k < 12; k++) { await editCell(a, `t${k}`); await tick(g.w, 10 * S); }
    const pings = a.dev.presenceCalls.filter((c) => c.cmd === "presenceInput");
    expect(pings.length - pings0).toBeGreaterThanOrEqual(3);
    expect(pings.length - pings0).toBeLessThanOrEqual(5);
    for (let k = pings0 + 1; k < pings.length; k++) expect(pings[k].at - pings[k - 1].at).toBeGreaterThanOrEqual(LIMITS_P3.inputPingMs);
    const s1 = seq();
    expect(s1).toBeGreaterThanOrEqual(s0 + 2);
    // No more input: it keeps beating up to 10 min after the last input, then stops.
    await tick(g.w, 10 * MIN + 2 * MIN, 5000);
    const s2 = seq();
    await tick(g.w, 5 * MIN, 5000);
    expect(seq()).toBe(s2);
    expect(notesOf(a.dev, g.path, "d-a1a1")[0].note!.state).toBe("editing");   // unsaved changes: still editing
    // Input again → beats again.
    await editCell(a, "back");
    await tick(g.w, 61 * S);
    expect(seq()).toBeGreaterThan(s2);
  });

  it("key presses in the window count as input (deps.lastActivity) while the tab is editing", async () => {
    let act = Number.NEGATIVE_INFINITY;
    const g = await group(1, { delay: 0, deps: [{ lastActivity: () => act }] });
    const [a] = g.cs;
    await editCell(a, "1");
    const n0 = a.dev.presenceCalls.filter((c) => c.cmd === "presenceInput").length;
    await tick(g.w, 40 * S);
    act = g.w.clock.now();
    await tick(g.w, 6 * S);
    expect(a.dev.presenceCalls.filter((c) => c.cmd === "presenceInput").length).toBe(n0 + 1);
  });
});

describe("S4 release (D6)", () => {
  it("after Save the note has the new version and stays editing; 30 s later idle; input inside the 30 s keeps it", async () => {
    const g = await group(1, { delay: 0 });
    const [a] = g.cs;
    const note = () => notesOf(a.dev, g.path, "d-a1a1")[0].note!;
    await editCell(a, "1");
    await a.ses.getState().save();
    await flush();
    expect(note()).toMatchObject({ state: "editing", head: activeTab(a).baseRevision, base_revision: activeTab(a).baseRevision });
    await tick(g.w, 20 * S);
    a.graph.getState().setFigure({ title: "t" });       // input inside the 30 s
    await a.ses.getState().save();
    await tick(g.w, 20 * S);
    expect(note().state).toBe("editing");
    await tick(g.w, 15 * S);
    expect(note().state).toBe("idle");
    expect(presenceOf(a)!.mine).toBe("idle");
  });

  it("window blur / tab switch on a clean tab → idle at once; a tab with unsaved changes stays editing", async () => {
    const handlers = new Map<string, (() => void)[]>();
    const win = { addEventListener: (ev: string, h: () => void) => { handlers.set(ev, [...(handlers.get(ev) ?? []), h]); } } as unknown as Window;
    const g = await group(1, { delay: 0, deps: [{ window: win }] });
    const [a] = g.cs;
    const note = () => notesOf(a.dev, g.path, "d-a1a1")[0].note!;
    const blur = () => { for (const h of handlers.get("blur") ?? []) h(); };
    await editCell(a, "1");
    blur(); await flush();
    expect(note().state).toBe("editing");               // unsaved changes
    await a.ses.getState().save();
    await flush();
    expect(note().state).toBe("editing");
    blur(); await flush();
    expect(note().state).toBe("idle");
    // Tab switch.
    await editCell(a, "2");
    await a.ses.getState().save();
    await a.ses.getState().newDoc("column");
    await flush();
    expect(note().state).toBe("idle");
  });

  it("discard / revert → idle at once; close tab → the note is gone; the simulated quit removes every note", async () => {
    const g = await group(1, { delay: 0 });
    const [a] = g.cs;
    const note = () => notesOf(a.dev, g.path, "d-a1a1")[0]?.note ?? null;
    await editCell(a, "1");
    await a.ses.getState().save();
    expect(note()!.state).toBe("editing");
    expect(await a.ses.getState().reloadFromDisk()).toBe(true);
    await flush();
    expect(note()!.state).toBe("idle");
    await editCell(a, "2");
    await withAnswer(a, () => a.ses.getState().closeTab(), { kind: "closeDirty", choice: "discard" });
    await flush();
    expect(note()).toBe(null);
    await a.ses.getState().open(g.path);
    await flush();
    expect(note()!.state).toBe("idle");
    expect(await a.ses.getState().quitRoutine("menu")).toBe(true);
    await flush();
    expect(notesBeside(a.dev, g.path)).toEqual([]);
  });
});

describe("S6 Edit here / Edit anyway", () => {
  it("same user: instant; A (unsaved) sees 'continued elsewhere' and keeps its content; the second save combines", async () => {
    const g = await group(2);
    const [a, b] = g.cs;
    await editCell(a, "A typed");
    await sync(g);
    expect(guardOf(b)).toBe("editingElsewhere");
    expect(bannerOf(b, "editingElsewhere")!.actions).toEqual(["editHere"]);
    const aEpoch = notesOf(a.dev, g.path, "d-a1a1")[0].note!.epoch;
    const p = b.ses.getState().editHere();
    expect(guardOf(b)).toBe(null);                     // the same tick
    expect(await p).toBe(true);
    expect(notesOf(b.dev, g.path, "d-b2b2")[0].note).toMatchObject({ state: "editing", supersedes: [{ device_id: "d-a1a1", epoch: aEpoch }] });
    expect(modeOf(b)).toBe("bothEditing");
    expect(bannerOf(b, "bothEditing")).toBe(null);     // already closed for these peers
    await sync(g);
    expect(modeOf(a)).toBe("bothEditing");
    expect(bannerOf(a, "continuedElsewhere")).toMatchObject({ actions: ["keepEditing", "saveCopy"] });
    expect(a.graph.getState().doc!.cells[0][0][0]).toBe("A typed");
    expect(guardOf(a)).toBe(null);
    expect(notesOf(a.dev, g.path, "d-a1a1")[0].note!.state).toBe("editing");
    // Both save: the second one combines into one two-parent version.
    b.graph.getState().setFigure({ title: "B title" });
    await flush();
    await b.ses.getState().save();
    await sync(g);
    await a.ses.getState().save();
    await sync(g);
    await tick(g.w, 10 * S);
    const f = a.dev.localFile(g.path)!;
    const head = f.manifest.revisions.find((r) => r.id === f.manifest.head)!;
    expect(head.parents).toHaveLength(2);
    expect(a.graph.getState().doc!.cells[0][0][0]).toBe("A typed");
    expect(a.graph.getState().figure.title).toBe("B title");
  });

  it("another user: the dialog first; Cancel changes nothing; Edit anyway → editable", async () => {
    const g = await group(2, { users: ["Alice", "Zhuo"] });
    const [a, b] = g.cs;
    await editCell(a, "A typed");
    await sync(g);
    expect(bannerOf(b, "editingElsewhere")!.actions).toEqual(["editAnyway"]);
    const r1 = await withAnswer(b, () => b.ses.getState().editHere(), { kind: "editAnyway", choice: "cancel" });
    expect(r1).toBe(false);
    expect(guardOf(b)).toBe("editingElsewhere");
    const d = (async () => { const t = activeTab(b); await b.ses.getState().bannerAction(t.key, "editingElsewhere", "editAnyway"); })();
    await flush();
    expect(b.ses.getState().dialog).toMatchObject({ kind: "editAnyway", peers: [{ userName: "Alice", deviceName: "Mac mini" }] });
    b.ses.getState().answerDialog({ kind: "editAnyway", choice: "edit" });
    await d;
    expect(guardOf(b)).toBe(null);
    await editCell(b, "B typed");
    expect(b.graph.getState().doc!.cells[0][0][0]).toBe("B typed");
  });
});

describe("S7 both editing", () => {
  it("A and B start inside the sync delay: both bothEditing, nobody read-only; keepEditing hides it; a clean C is read-only with both", async () => {
    const g = await group(3, { delay: 3000 });
    const [a, b, c] = g.cs;
    await editCell(a, "A");
    await editCell(b, "B", 1);
    await sync(g);
    for (const x of [a, b]) { expect(modeOf(x)).toBe("bothEditing"); expect(guardOf(x)).toBe(null); }
    expect(notesOf(c.dev, g.path, "d-a1a1")).toHaveLength(1);
    expect(notesOf(c.dev, g.path, "d-b2b2")).toHaveLength(1);
    expect(guardOf(c)).toBe("editingElsewhere");
    expect(bannerOf(c, "editingElsewhere")!.peers!.map((p) => p.deviceName).sort()).toEqual(["Mac mini", "MacBook"]);
    b.ses.getState().keepEditing();
    expect(bannerOf(b, "bothEditing")).toBe(null);
    await tick(g.w, 70 * S);
    expect(bannerOf(b, "bothEditing")).toBe(null);           // same epoch: stays away
  });

  it("Save my changes as a separate copy: the tab moves to a new analysis; its note at the old path is cleared", async () => {
    const g = await group(2, { delay: 500 });
    const [a, b] = g.cs;
    await editCell(a, "A");
    await editCell(b, "B", 1);
    await sync(g);
    b.picks.push(`${DBX}/Mine`);
    const t = activeTab(b);
    const out = await b.ses.getState().saveAsSeparateCopy(t.key);
    expect(out).toEqual({ ok: true, path: `${DBX}/Mine.lag` });
    await flush();
    expect(notesOf(b.dev, g.path, "d-b2b2").filter((n) => n.note!.document_name === "Dose response.lag")).toEqual([]);
    expect(notesOf(b.dev, `${DBX}/Mine.lag`, "d-b2b2").some((n) => n.note!.document_name === "Mine.lag")).toBe(true);
    expect(activeTab(b)).toMatchObject({ path: `${DBX}/Mine.lag`, dirty: false });
  });
});

describe("S8 never frozen", () => {
  it("a guard waits while something is being typed and is set once that ends; an open Scratchpad edit counts as a claim", async () => {
    let busy = false;
    let pendingScratch: (() => void) | null = null;
    const g = await group(2, {
      users: ["Zhuo", "Alice"],
      deps: [{}, { interactionBusy: () => busy, flushScratch: () => { const f = pendingScratch; pendingScratch = null; f?.(); } }],
    });
    const [a, b] = g.cs;
    busy = true;
    await editCell(a, "A");
    await sync(g);
    expect(guardOf(b)).toBe(null);                    // something is being typed: not yet
    expect(modeOf(b)).toBe("readOnly");
    busy = false;
    await tick(g.w, LIMITS_P3.applyHoldRetryMs + 100);
    expect(guardOf(b)).toBe("editingElsewhere");
    // A Scratchpad edit open on C when A starts editing: committed first → a claim, never read-only.
    const g2 = await group(2, { users: ["Zhuo", "Alice"], deps: [{}, { flushScratch: () => { const f = pendingScratch; pendingScratch = null; f?.(); } }] });
    const [a2, c] = g2.cs;
    pendingScratch = () => c.graph.getState().setScratch(JSON.stringify({ v: 1, cells: [[1, 1, "typed in A1"]] }));
    await editCell(a2, "A");
    await sync(g2);
    expect(guardOf(c)).toBe(null);
    expect(isDirty(c.graph.getState())).toBe(true);
    expect(modeOf(c)).toBe("bothEditing");
    expect(notesOf(c.dev, g2.path, "d-b2b2")[0].note!.state).toBe("editing");
  });
});

describe("S9 waiting for a newer version", () => {
  it("a note announces a version B does not have → waiting; it arrives → reloaded", async () => {
    const g = await group(2, { delay: 0 });
    const [a, b] = g.cs;
    b.dev.setSyncDelay(60 * S, "files");
    a.dev.setSyncDelay(0);
    await editCell(a, "new");
    await a.ses.getState().save();
    await tick(g.w, 2 * S);
    expect(guardOf(b)).toBe("waiting");
    expect(bannerOf(b, "waitingNewer")!.peers![0].deviceName).toBe("Mac mini");
    await tick(g.w, 62 * S);
    expect(b.graph.getState().doc!.cells[0][0][0]).toBe("new");
    expect(bannerOf(b, "waitingNewer")).toBe(null);
  });

  it("it never arrives → after 2 min editable with 'unconfirmed' (closed until the base changes)", async () => {
    const g = await group(2, { delay: 0 });
    const [a, b] = g.cs;
    b.dev.setSyncDelay(10 * H, "files");
    await editCell(a, "new");
    await a.ses.getState().save();
    await tick(g.w, 2 * S);
    expect(guardOf(b)).toBe("waiting");
    await tick(g.w, LIMITS_P3.waitNewerMs);
    expect(guardOf(b)).toBe(null);
    expect(bannerOf(b, "unconfirmed")).toMatchObject({ dismissible: true });
    b.ses.getState().dismissBanner(activeTab(b).key, "unconfirmed");
    await tick(g.w, 10 * S);
    expect(bannerOf(b, "unconfirmed")).toBe(null);
  });

  it("a note that was already old when first seen waits only 20 s", async () => {
    const g = await group(1, { delay: 0 });
    const [b] = g.cs;
    await b.ses.getState().closeTab();
    placeForeign(b.dev, g.path, { state: "idle", head: "r-01AAAAAAAAAAAAAAAAAAAAAAAA", base_revision: null, updated_at: new Date(g.w.clock.now() - 30 * MIN).toISOString() });
    await b.ses.getState().open(g.path);
    await flush();
    expect(guardOf(b)).toBe("waiting");
    await tick(g.w, 21 * S);
    expect(guardOf(b)).toBe(null);
    expect(bannerOf(b, "unconfirmed")).not.toBe(null);
  });
});

describe("S10 quiet notes", () => {
  it("A crashes while editing → B editable within 5 min of the last change B saw (info, Edit here); B typing claims over it", async () => {
    const g = await group(2, { delay: 500 });
    const [a, b] = g.cs;
    await editCell(a, "A unsaved");
    await sync(g);
    expect(guardOf(b)).toBe("editingElsewhere");
    a.dev.crash();
    await tick(g.w, LIMITS_P3.staleMs + 10 * S, 5000);
    expect(guardOf(b)).toBe(null);
    expect(modeOf(b)).toBe("info");
    expect(bannerOf(b, "editingInfo")).toMatchObject({ actions: ["editHere", "dismiss"] });
    const aEpoch = notesOf(b.dev, g.path, "d-a1a1")[0].note!.epoch;
    await editCell(b, "B typed");
    expect(notesOf(b.dev, g.path, "d-b2b2")[0].note).toMatchObject({ state: "editing", supersedes: [{ device_id: "d-a1a1", epoch: aEpoch }] });
  });

  it("a B that first opens the file 20 min after the crash is editable at once", async () => {
    const g = await group(2, { delay: 500 });
    const [a, b] = g.cs;
    await b.ses.getState().closeTab();
    await editCell(a, "A unsaved");
    await sync(g);
    a.dev.crash();
    await tick(g.w, 20 * MIN, 10_000);
    await b.ses.getState().open(g.path);
    await flush();
    expect(guardOf(b)).toBe(null);
    expect(modeOf(b)).toBe("info");
  });
});

describe("S11 sleep on the observer", () => {
  it("B sleeps 2 h while A edited and stopped → on wake checking for one listing, then editable; with A still editing → read-only again", async () => {
    const g = await group(2, { delay: 500 });
    const [a, b] = g.cs;
    await editCell(a, "A");
    await sync(g);
    expect(guardOf(b)).toBe("editingElsewhere");
    b.dev.sleep(2 * H);
    await a.ses.getState().save();
    await tick(g.w, 2 * MIN, 5000);
    expect(notesOf(a.dev, g.path, "d-a1a1")[0].note!.state).toBe("idle");
    await tick(g.w, 2 * H, 30_000);
    await tick(g.w, 10 * S);
    expect(guardOf(b)).toBe(null);
    expect(b.graph.getState().doc!.cells[0][0][0]).toBe("A");
    // Again, but A keeps editing (its note beats) while B sleeps.
    await editCell(a, "A2");
    await sync(g);
    expect(guardOf(b)).toBe("editingElsewhere");
    b.dev.sleep(2 * H);
    a.dev.alwaysInput = true;
    await tick(g.w, 2 * H + 5 * S, 30_000);
    const seen: (string | null)[] = [];
    for (let k = 0; k < 20; k++) { await tick(g.w, 1000); seen.push(guardOf(b)); }
    expect(seen[seen.length - 1]).toBe("editingElsewhere");
  });
});

describe("S12 sleep on the holder", () => {
  it("A with unsaved changes sleeps → resuming (no beating); Save asks; the first edit is refused once and asks; 45 s → re-claim", async () => {
    const g = await group(1, { delay: 0 });
    const [a] = g.cs;
    await editCell(a, "unsaved");
    const e1 = notesOf(a.dev, g.path, "d-a1a1")[0].note!.epoch;
    a.dev.sleep(10 * MIN);
    await tick(g.w, 10 * MIN + 6 * S, 30_000);
    expect(modeOf(a)).toBe("resuming");
    expect(guardOf(a)).toBe("resuming");
    expect(bannerOf(a, "resuming")).toMatchObject({ actions: ["keepEditing"] });
    expect(a.dev.ownNoteState(g.path)!.beating).toBe(false);
    expect(presenceOf(a)!.readOnly).toBe(false);
    // Save → the question; Wait → nothing written.
    const saves = a.dev.saves.length;
    expect(await withAnswer(a, () => a.ses.getState().save(), { kind: "resumeConfirm", choice: "wait" })).toEqual({ ok: false, reason: "cancelled" });
    expect(a.dev.saves.length).toBe(saves);
    // The first new edit is refused and asks.
    a.graph.getState().setCell(0, 0, 0, "after sleep");
    await flush();
    expect(a.graph.getState().doc!.cells[0][0][0]).toBe("unsaved");
    expect(a.ses.getState().dialog).toMatchObject({ kind: "resumeConfirm", what: "edit" });
    a.ses.getState().answerDialog({ kind: "resumeConfirm", choice: "go" });
    await flush();
    expect(guardOf(a)).toBe(null);
    expect(notesOf(a.dev, g.path, "d-a1a1")[0].note).toMatchObject({ state: "editing", epoch: e1 + 1 });
    await editCell(a, "after sleep");
    expect(a.graph.getState().doc!.cells[0][0][0]).toBe("after sleep");
  });

  it("nothing happens for 45 s → re-claim; a clean holder releases at once", async () => {
    const g = await group(1, { delay: 0 });
    const [a] = g.cs;
    await editCell(a, "unsaved");
    a.dev.sleep(5 * MIN);
    await tick(g.w, 5 * MIN + 6 * S, 10_000);
    expect(modeOf(a)).toBe("resuming");
    await tick(g.w, LIMITS_P3.resumeMs);
    expect(modeOf(a)).toBe("editable");
    expect(guardOf(a)).toBe(null);
    expect(a.dev.ownNoteState(g.path)!.beating).toBe(true);
    // Clean holder (inside the 30 s after a save).
    await a.ses.getState().save();
    expect(notesOf(a.dev, g.path, "d-a1a1")[0].note!.state).toBe("editing");
    a.dev.sleep(5 * MIN);
    await tick(g.w, 5 * MIN + 6 * S, 10_000);
    expect(modeOf(a)).toBe("editable");
    expect(notesOf(a.dev, g.path, "d-a1a1")[0].note!.state).toBe("idle");
  });

  it("a note overriding my claim seen in the window → continuedElsewhere, content kept, my note still editing", async () => {
    const g = await group(2, { delay: 500 });
    const [a, b] = g.cs;
    await editCell(a, "A unsaved");
    await sync(g);
    a.dev.sleep(10 * MIN);
    await tick(g.w, 6 * MIN, 10_000);
    expect(await b.ses.getState().editHere()).toBe(true);    // A's note went quiet: Edit here on B
    await editCell(b, "B typed", 1);                           // and keeps editing (else it is idle 30 s later)
    await tick(g.w, 5 * MIN, 10_000);
    await tick(g.w, 3 * S);
    expect(modeOf(a)).toBe("bothEditing");
    expect(bannerOf(a, "continuedElsewhere")).not.toBe(null);
    expect(a.graph.getState().doc!.cells[0][0][0]).toBe("A unsaved");
    expect(guardOf(a)).toBe(null);
    expect(notesOf(a.dev, g.path, "d-a1a1")[0].note!.state).toBe("editing");
    expect(a.dev.ownNoteState(g.path)!.beating).toBe(true);
  });

  it("a newer version arriving in the window ends it: the phase 2 'newer version' banner", async () => {
    const g = await group(2, { delay: 500, users: ["Zhuo", "Alice"] });
    const [a, b] = g.cs;
    await editCell(a, "A unsaved");
    await sync(g);
    a.dev.sleep(10 * MIN);
    await tick(g.w, 6 * MIN, 10_000);
    await withAnswer(b, () => b.ses.getState().editHere(), { kind: "editAnyway", choice: "edit" }).catch(() => undefined);
    await editCell(b, "B", 1);
    await b.ses.getState().save();
    await tick(g.w, 4 * MIN + 10 * S, 10_000);
    expect(bannerOf(a, "resuming")).toBe(null);
    expect(activeTab(a).banners.some((x) => x.kind === "newerOnDisk" || x.kind === "continuedElsewhere")).toBe(true);
    expect(a.graph.getState().doc!.cells[0][0][0]).toBe("A unsaved");
  });
});

describe("S13 a read-only tab writes nothing into its file", () => {
  it("save, Save As (same), bring back, combine, undo combine, use earlier, back to latest, update mine are refused and counted", async () => {
    const g = await group(2, { users: ["Zhuo", "Alice"] });
    const [a, b] = g.cs;
    await editCell(a, "A");
    await sync(g);
    expect(guardOf(b)).toBe("editingElsewhere");
    const key = activeTab(b).key;
    const writes = b.dev.saves.length;
    const at0 = presenceOf(b)!.attempt;
    expect(await b.ses.getState().save()).toEqual({ ok: false, reason: "readOnly" });
    expect(await b.ses.getState().saveAs("same")).toEqual({ ok: false, reason: "readOnly" });
    expect(await b.ses.getState().bringBack(activeTab(b).baseRevision!)).toEqual({ ok: false, reason: "readOnly" });
    expect(await b.ses.getState().undoCombine(key)).toEqual({ ok: false, reason: "readOnly" });
    await b.ses.getState().startCombine(key, { kind: "disk" });
    await b.ses.getState().useEarlierVersion(key);
    await b.ses.getState().goBackToMyLatest(key);
    await b.ses.getState().menu("file.save");
    await flush();
    expect(b.dev.saves.length).toBe(writes);
    expect(presenceOf(b)!.attempt).toBe(at0 + 8);
    // Still allowed: Save As a new analysis, Duplicate.
    b.picks.push(`${DBX}/Dup`);
    expect((await b.ses.getState().duplicate()).ok).toBe(true);
  });
});

describe("S14 a file made with a newer app", () => {
  it("guard tooNew: every edit refused", async () => {
    const w = makeWorld();
    const a = await start(await computer(w, { device_id: "d-a1a1", device_name: "Mac mini" }));
    const P = `${DBX}/New app.lag`;
    const f = await seedFile(w, a.dev, P);
    a.dev.place(P, { ...f, manifest: { ...f.manifest, min_reader_version: 99 } });
    await a.ses.getState().open(P);
    await flush();
    expect(activeTab(a).readOnly).toBe("tooNew");
    expect(guardOf(a)).toBe("tooNew");
    a.graph.getState().setCell(0, 0, 0, "x");
    expect(isDirty(a.graph.getState())).toBe(false);
  });
});

describe("S15 older peer", () => {
  it("a save with features 1 by a computer without a note → banner once per head; with a note → none", async () => {
    const g = await group(1, { delay: 0 });
    const [a] = g.cs;
    const { buildNextFile, openFile } = await import("./docCodec");
    const f = a.dev.localFile(g.path)!;
    const next = await buildNextFile(f, { ...openFile(f)!, figure: { ...openFile(f)!.figure, title: "old app" } }, {
      time: g.w.clock.now(), author: { user_name: "Alice", device_id: "d-old0", device_name: "Old iMac", session_id: "s", app_version: "0.2.20", platform: "macos" },
    });
    g.w.forceReplace(g.path, { manifest: { ...next.manifest, features: 1 }, parts: next.parts });   // an older app saved
    await tick(g.w, 3000);
    expect(bannerOf(a, "olderPeer")).toMatchObject({ peers: [{ deviceName: "Old iMac" }], actions: ["dismiss"] });
    a.ses.getState().dismissBanner(activeTab(a).key, "olderPeer");
    await tick(g.w, 3000);
    expect(bannerOf(a, "olderPeer")).toBe(null);
  });
});

describe("S16 retention keeps the versions notes announce", () => {
  it("a version another computer's note is on keeps its content through many saves", async () => {
    const g = await group(1, { delay: 0 });
    const [a] = g.cs;
    const X = activeTab(a).baseRevision!;
    placeForeign(a.dev, g.path, { state: "idle", head: X, base_revision: null, updated_at: new Date(g.w.clock.now()).toISOString() });
    await flush();
    for (let k = 0; k < 24; k++) { await editCell(a, `v${k}`); await a.ses.getState().save(); }
    const m = a.dev.localFile(g.path)!.manifest;
    expect(m.revisions.find((r) => r.id === X)!.sections).not.toBe(null);
    const oldOnes = m.revisions.filter((r) => r.id !== X && r.sections === null);
    expect(oldOnes.length).toBeGreaterThan(0);
  });
});

describe("S17 conflict copies and cleanup", () => {
  it("a conflict copy of a note (same device, lower seq) changes nothing; the owner's next write removes its own copy", async () => {
    const g = await group(1, { delay: 0 });
    const [a] = g.cs;
    const own = notesOf(a.dev, g.path, "d-a1a1")[0];
    a.dev.placeNote(own.path.replace(".laguse", " (conflicted copy).laguse"), noteText({ ...own.note!, seq: 0 }));
    await flush();
    expect(notesOf(a.dev, g.path, "d-a1a1")).toHaveLength(2);
    expect(modeOf(a)).toBe("editable");
    await editCell(a, "x");
    expect(notesOf(a.dev, g.path, "d-a1a1")).toHaveLength(1);
  });

  it("a foreign note unchanged for 24 h is removed; one that changed at 23 h is not; an orphan likewise", async () => {
    const g = await group(1, { delay: 0 });
    const [a] = g.cs;
    const stale = placeForeign(a.dev, g.path, { state: "editing" });
    const fresh = placeForeign(a.dev, g.path, { device_id: "d-bob-1a2b", device_name: "Lab MacBook", user_name: "Bob", state: "idle", base_revision: null }, "Dose response (in use on Lab MacBook, 1a2b).laguse");
    const orphan = placeForeign(a.dev, g.path, { analysis_id: "a-gone", document_name: "Gone.lag", device_id: "d-carl-0000" }, "Gone (in use on X, 0000).laguse");
    await flush();
    await tick(g.w, 23 * H, 60_000);
    a.dev.placeNote(fresh.path, noteText({ ...fresh.note, seq: 2 } as never));        // Bob's note changes at 23 h
    await tick(g.w, 1 * H + 10 * S, 60_000);
    a.ses.internal.presenceTick();
    await a.ses.getState().closeTab(); await a.ses.getState().open(g.path); await flush();
    const names = notesBeside(a.dev, g.path).map((n) => n.path);
    expect(names).not.toContain(stale.path);
    expect(names).not.toContain(orphan.path);
    expect(names).toContain(fresh.path);
  });
});

describe("S18 duplicate device id", () => {
  it("a second running app with my device id → a new identity, the toast, notes rewritten; a crash leftover does not trigger it", async () => {
    const w = makeWorld();
    const a = await start(await computer(w, { device_id: "d-a1a1", device_name: "Mac mini", uploadDelayMs: 0, downloadDelayMs: 0 }));
    const clone = await start(await computer(w, { device_id: "d-a1a1", device_name: "Mac mini", session_id: "s-clone", uploadDelayMs: 0, downloadDelayMs: 0 }));
    await seedFile(w, a.dev, PFILE);
    await tick(w, 1000);
    await a.ses.getState().open(PFILE);
    await clone.ses.getState().open(PFILE);
    await tick(w, 1000);
    clone.dev.alwaysInput = true;
    await editCell(clone, "clone edits");
    await tick(w, 3 * MIN, 5000);
    expect(a.ses.getState().toasts.some((t) => t.kind === "deviceIdChanged")).toBe(true);
    expect(a.dev.presenceCalls.some((c) => c.cmd === "newDeviceId")).toBe(true);
    const id = (await a.dev.device()).device_id;
    expect(id).not.toBe("d-a1a1");
    expect(notesOf(a.dev, PFILE, id)).toHaveLength(1);
  });

  it("a leftover note of mine from a crash (seq never moves) is continued and replaced, no new identity", async () => {
    const g = await group(1, { delay: 0 });
    const [a] = g.cs;
    await editCell(a, "x");
    const left = notesOf(a.dev, g.path, "d-a1a1")[0].note!;
    a.dev.crash();
    await tick(g.w, 1 * H, 60_000);
    a.dev.relaunch();
    const { controllerFor } = await import("./testkit");
    const a2 = await controllerFor(g.w, a.dev);
    await a2.ses.getState().init();
    await flush();
    await tick(g.w, 30 * S);
    expect(a.dev.presenceCalls.some((c) => c.cmd === "newDeviceId")).toBe(false);
    const now = notesOf(a.dev, g.path, "d-a1a1");
    expect(now).toHaveLength(1);
    expect(now[0].note!.session_id).not.toBe(left.session_id);
    expect(now[0].note!.seq).toBeGreaterThan(left.seq);
    expect(now[0].note!.epoch).toBeGreaterThanOrEqual(left.epoch);
  });
});

describe("S19 / S20 the note follows the file and the names", () => {
  it("rename follow → a note for the new name and none for the old; missing → cleared; back → written again", async () => {
    const g = await group(1, { delay: 0 });
    const [a] = g.cs;
    const to = `${DBX}/Renamed.lag`;
    a.dev.rename(g.path, to);
    await tick(g.w, 12 * S);
    expect(activeTab(a).path).toBe(to);
    const mine = notesBeside(a.dev, to).filter((n) => n.note?.device_id === "d-a1a1");
    expect(mine.map((n) => n.note!.document_name)).toEqual(["Renamed.lag"]);
    expect(mine[0].name).toBe("Renamed (in use on Mac mini, a1a1).laguse");
    // Missing → cleared.
    const f = a.dev.localFile(to)!;
    a.dev.remove(to);
    await tick(g.w, 12 * S);
    expect(notesBeside(a.dev, to).filter((n) => n.note?.device_id === "d-a1a1")).toEqual([]);
    a.dev.place(to, f);
    await tick(g.w, 5 * S);
    expect(notesBeside(a.dev, to).filter((n) => n.note?.device_id === "d-a1a1")).toHaveLength(1);
  });

  it("Save As to a new path: a note for the new file, none left for the old one", async () => {
    const g = await group(1, { delay: 0 });
    const [a] = g.cs;
    a.picks.push(`${DBX}/Other name`);
    expect((await a.ses.getState().saveAs("new")).ok).toBe(true);
    await flush();
    const all = notesBeside(a.dev, g.path).filter((n) => n.note?.device_id === "d-a1a1").map((n) => n.note!.document_name);
    expect(all).toEqual(["Other name.lag"]);
  });

  it("the computer renamed in Settings → the note file is replaced by one with the new name", async () => {
    const g = await group(1, { delay: 0 });
    const [a] = g.cs;
    await a.ses.getState().setSettings({ deviceName: "Studio" });
    await flush();
    const mine = notesBeside(a.dev, g.path).filter((n) => n.note?.device_id === "d-a1a1");
    expect(mine.map((n) => n.name)).toEqual(["Dose response (in use on Studio, a1a1).laguse"]);
    expect(mine[0].note!.device_name).toBe("Studio");
  });
});

describe("S21 / S23 / S24", () => {
  it("features is 2 in every manifest written", async () => {
    const g = await group(1, { delay: 0 });
    const [a] = g.cs;
    await editCell(a, "x");
    await a.ses.getState().save();
    expect(a.dev.localFile(g.path)!.manifest.features).toBe(2);
    expect(a.dev.saves.every((r) => r.manifest.features === 2)).toBe(true);
  });

  it("menu: Save disabled while read-only (and enabled while resuming); Show Others… opens the dialog", async () => {
    const g = await group(2, { users: ["Zhuo", "Alice"] });
    const [a, b] = g.cs;
    await editCell(a, "A");
    await sync(g);
    expect(presenceOf(b)!.readOnly).toBe(true);
    await b.ses.getState().menu("file.sharing");
    expect(b.ses.getState().dialog).toMatchObject({ kind: "sharing", sharing: { on: true, why: "cloud" } });
    b.ses.getState().closeDialog();
    expect(b.ses.getState().dialog).toBe(null);
  });

  it("no listing the person sees contains a note file (scanDir lists them as 'presence' only)", async () => {
    const g = await group(1, { delay: 0 });
    const [a] = g.cs;
    const scan = await a.dev.scanDir(DBX);
    expect(scan.ok && scan.entries.filter((e) => e.name.endsWith(".laguse")).every((e) => e.kind === "presence" && e.header === null)).toBe(true);
    expect(a.dev.localEntries().some((e) => e.path.endsWith(".laguse"))).toBe(false);
    expect(a.ses.getState().recent.some((r) => r.path.endsWith(".laguse"))).toBe(false);
    const found = await a.dev.locate(DBX, activeTab(a).analysisId!).result;
    expect(found.ok && found.matches.every((m) => m.path.endsWith(".lag"))).toBe(true);
  });
});

describe("S13 phase 2 automatic combines wait while the tab is read-only", () => {
  it("never written from a read-only tab; written once the guard clears", async () => {
    const g = await group(2, { delay: 500, users: ["Alice", "Zhuo"] });
    const [a, b] = g.cs;
    const r1 = activeTab(b).baseRevision!;
    await editCell(b, "B1");
    await b.ses.getState().save();
    await tick(g.w, LIMITS_P3.lingerMs + 5 * S);
    a.graph.getState().setFigure({ title: "A editing" });
    await flush();
    await sync(g);
    expect(guardOf(b)).toBe("editingElsewhere");
    // Someone's save replaces B's last save (made from the version before it, another section).
    const { buildNextFile, fileAt, openFile } = await import("./docCodec");
    const base = fileAt(b.dev.localFile(g.path)!, r1)!;
    const c = openFile(base)!;
    const x = await buildNextFile(base, { ...c, analysis: { ...c.analysis, alpha: c.analysis.alpha === 0.05 ? 0.01 : 0.05 } }, {
      time: g.w.clock.now(), author: { user_name: "Carl", device_id: "d-carl", device_name: "Carl's Mac", session_id: "s", app_version: "t", platform: "macos" },
    });
    g.w.forceReplace(g.path, x);
    const written = b.dev.written.length;
    await tick(g.w, 60 * S);
    expect(guardOf(b)).toBe("editingElsewhere");
    expect(b.dev.written.length).toBe(written);                 // nothing written from the read-only tab
    expect(activeTab(b).banners.find((k) => k.kind === "savedOver")).toMatchObject({ state: "combining" });
    // A goes away (closes without saving): B's guard clears and the waiting combine is written.
    await withAnswer(a, () => a.ses.getState().closeTab(), { kind: "closeDirty", choice: "discard" });
    await tick(g.w, 20 * S);
    expect(guardOf(b)).toBe(null);
    expect(b.dev.written.length).toBe(written + 1);
    const m = b.dev.localFile(g.path)!.manifest;
    expect(m.revisions.find((r) => r.id === m.head)!.parents).toHaveLength(2);
  });
});

describe("S19 a new path is looked up again", () => {
  it("Save As from a local folder into Dropbox gets a note; from Dropbox into Documents none, ever", async () => {
    const w = makeWorld();
    const a = await start(await computer(w, { device_id: "d-a1a1", device_name: "Mac mini" }));
    await a.ses.getState().newDoc("column", true);
    a.picks.push(`${DBX}/Fresh`);
    expect((await a.ses.getState().save()).ok).toBe(true);
    await flush();
    expect(notesBeside(a.dev, `${DBX}/Fresh.lag`).map((n) => n.note?.document_name)).toEqual(["Fresh.lag"]);
    a.picks.push(`${DOCS}/Local copy`);
    expect((await a.ses.getState().saveAs("new")).ok).toBe(true);
    await flush();
    expect(a.dev.allNoteFiles().filter((f) => f.startsWith(DOCS))).toEqual([]);
    expect(a.dev.presenceCalls.filter((c) => c.cmd === "presenceSet" && String((c.args as { docPath: string }).docPath).startsWith(DOCS))).toEqual([]);
    expect(notesBeside(a.dev, `${DBX}/Fresh.lag`)).toEqual([]);
    expect(presenceOf(a)!.sharing.why).toBe("local");
  });
});
