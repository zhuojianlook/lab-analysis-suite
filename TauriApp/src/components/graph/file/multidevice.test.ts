// The same file open on two computers (plan §13, contract §4.15): reload when
// clean, the newer-version banner when not, the lossless conflict choices, the
// journal check (rollback, a save replaced by another computer), copies, and
// the multi-device scenarios. Assertions throughout: no saved version is ever
// lost; opening never makes a tab dirty; an edit made between read and apply
// is not lost; undo after a reload doesn't undo the other computer's changes.
import { describe, expect, it } from "vitest";
import { isDirty } from "../../../store/graphStore";
import { buildNextFile, fileAt, openFile, revisionOf } from "./docCodec";
import { isAncestorOrSelf } from "./format";
import type { ConflictMode } from "./memoryBackend";
import {
  DBX, DOWNLOADS, authorFor, computer, contentAt, firstCell, flush, keptRevisions, makeWorld, seedFile, start, tick, writtenHeads,
  type Computer,
} from "./testkit";

const last = <T>(a: readonly T[]): T | undefined => a[a.length - 1];

const P = `${DBX}/Dose response.lag`;

interface Setup { w: ReturnType<typeof makeWorld>; a: Computer; b: Computer; delay: number }

async function twoComputers(delay = 2000, mode: ConflictMode = "dropbox", extra: { skewB?: number; sameId?: boolean; partialB?: number } = {}): Promise<Setup> {
  const w = makeWorld(mode);
  const a = await start(await computer(w, { device_id: "d-a", device_name: "Mac mini", uploadDelayMs: delay, downloadDelayMs: delay }));
  const b = await start(await computer(w, {
    device_id: extra.sameId ? "d-a" : "d-b", device_name: "MacBook", uploadDelayMs: delay, downloadDelayMs: delay, partialDeliveryMs: extra.partialB,
  }, { skewMs: extra.skewB }));
  await seedFile(w, a.dev, P);
  await tick(w, 2 * delay + (extra.partialB ?? 0) + 500);
  expect((await a.ses.getState().open(P)).ok).toBe(true);
  expect((await b.ses.getState().open(P)).ok).toBe(true);
  return { w, a, b, delay };
}

const sync = (s: Setup) => tick(s.w, 2 * s.delay + 1000);

async function edit(c: Computer, value: string) {
  c.graph.getState().setCell(0, 0, 0, value);
  await flush();
}

/** Every version any computer wrote is still in a file on some disk or in a journal. */
function expectNothingLost(w: Setup["w"]) {
  const { onDisk, journaled } = keptRevisions(w);
  for (const h of writtenHeads(w)) expect(onDisk.has(h) || journaled.has(h), `version ${h} lost`).toBe(true);
}

/** Every version any computer wrote is in a file on some disk (not only a journal). */
function expectAllOnDisk(w: Setup["w"], heads: string[]) {
  const { onDisk } = keptRevisions(w);
  for (const h of heads) expect(onDisk.has(h), `version ${h} not in any file`).toBe(true);
}

describe("the other computer saved", () => {
  it("a clean tab reloads in place, says who saved, and undo can't undo their change", async () => {
    const s = await twoComputers();
    const { a, b } = s;
    await edit(b, "b-before");
    await b.ses.getState().save();                 // b has undo history now
    await sync(s);
    expect(a.graph.getState().doc!.cells[0][0][0]).toBe("b-before");
    await edit(a, "from A");
    await a.ses.getState().save();
    await sync(s);
    expect(b.graph.getState().doc!.cells[0][0][0]).toBe("from A");
    expect(isDirty(b.graph.getState())).toBe(false);
    expect(b.ses.getState().tabs[0]).toMatchObject({ dirty: false, baseRevision: a.dev.localHead(P) });
    expect(last(b.ses.getState().toasts)).toMatchObject({ kind: "reloaded", version: { userName: "Zhuo", deviceName: "Mac mini", mine: false } });
    expect(b.graph.getState().undo()).toBe(false);
    expect(b.graph.getState().doc!.cells[0][0][0]).toBe("from A");
    expectNothingLost(s.w);
  });

  it("a tab with unsaved changes keeps them and shows 'saved a newer version'", async () => {
    const s = await twoComputers();
    const { a, b } = s;
    await edit(b, "mine");
    await edit(a, "theirs");
    await a.ses.getState().save();
    await sync(s);
    expect(b.graph.getState().doc!.cells[0][0][0]).toBe("mine");
    const banner = b.ses.getState().tabs[0].banner!;
    expect(banner).toMatchObject({ kind: "newerOnDisk", actions: ["choose", "later"], version: { deviceName: "Mac mini" } });
    // "Choose…" opens the sheet without saving.
    await b.ses.getState().bannerAction(b.ses.getState().tabs[0].key, banner.id, "choose");
    const d = b.ses.getState().dialog;
    expect(d?.kind === "conflict" && d.info.origin).toBe("banner");
  });

  it("an edit made while the new version is being read is not lost", async () => {
    const s = await twoComputers();
    const { a, b } = s;
    const orig = b.dev.read.bind(b.dev);
    let hook: (() => void) | null = null;
    b.dev.read = async (p: string) => { const r = await orig(p); if (hook) { const h = hook; hook = null; h(); } return r; };
    hook = () => b.graph.getState().setCell(1, 0, 0, "typed during read");
    await edit(a, "theirs");
    await a.ses.getState().save();
    await sync(s);
    expect(b.graph.getState().doc!.cells[1][0][0]).toBe("typed during read");
    expect(b.graph.getState().doc!.cells[0][0][0]).not.toBe("theirs");
    expect(b.ses.getState().tabs[0].banner?.kind).toBe("newerOnDisk");
  });
});

describe("the conflict sheet: every choice keeps every version", () => {
  async function conflict(): Promise<Setup & { theirs: string }> {
    const s = await twoComputers();
    await edit(s.b, "B!");
    await edit(s.a, "A!");
    await s.a.ses.getState().save();
    await sync(s);
    const theirs = s.a.dev.localHead(P)!;
    expect(await s.b.ses.getState().save()).toEqual({ ok: false, reason: "conflict" });
    const d = s.b.ses.getState().dialog;
    expect(d?.kind === "conflict" && d.info).toMatchObject({ name: "Dose response", theirs: { head: theirs, deviceName: "Mac mini" }, origin: "save" });
    expect(s.b.ses.getState().tabs[0].notSaved).toBe(true);
    return { ...s, theirs };
  }

  it("keep mine: my version on top, theirs in the history; the other computer just reloads", async () => {
    const s = await conflict();
    const { a, b, theirs } = s;
    await b.ses.getState().resolveConflict("keepMine");
    const f = b.dev.localFile(P)!;
    const head = revisionOf(f.manifest, f.manifest.head)!;
    expect(head.kind).toBe("merge");
    expect(head.parents[0]).toBe(theirs);
    expect(head.id).toMatch(/^r-m-[0-9a-f]{26}$/);
    expect(revisionOf(f.manifest, theirs)?.sections).not.toBeNull();
    expect(firstCell(openFile(f))).toBe("B!");
    expect(b.ses.getState().tabs[0]).toMatchObject({ dirty: false, notSaved: false, baseRevision: f.manifest.head });
    await sync(s);
    expect(a.graph.getState().doc!.cells[0][0][0]).toBe("B!");
    expect(isDirty(a.graph.getState())).toBe(false);
    expect(a.dev.localHead(P)).toBe(f.manifest.head);
    expectAllOnDisk(s.w, [theirs, head.parents[1], head.id]);
    expectNothingLost(s.w);
  });

  it("use theirs: mine is saved beside the file; the tab shows theirs", async () => {
    const s = await conflict();
    const { a, b, theirs } = s;
    await b.ses.getState().resolveConflict("takeTheirs");
    const copy = `${DBX}/Dose response (my version from MacBook).lag`;
    expect(firstCell(contentAt(b.dev, copy))).toBe("B!");
    expect(b.dev.localFile(copy)!.manifest.analysis_id).toBe(b.dev.localFile(P)!.manifest.analysis_id);
    expect(b.graph.getState().doc!.cells[0][0][0]).toBe("A!");
    expect(b.ses.getState().tabs[0]).toMatchObject({ dirty: false, notSaved: false, baseRevision: theirs });
    expect(b.ses.getState().tabs[0].banner).toMatchObject({ kind: "tookTheirs", name: "Dose response (my version from MacBook)", path: copy });
    expect(await b.dev.readDraft(b.ses.getState().activeKey!)).toBeNull();
    await sync(s);
    // The other computer sees an extra copy (a known copy name): a warning, no question.
    const ab = a.ses.getState().tabs[0].banners.find((x) => x.path === copy);
    expect(ab?.kind).toBe("extraCopy");
    expectAllOnDisk(s.w, [theirs, b.dev.localHead(copy)!]);
    expectNothingLost(s.w);
    // No second copy on the next change.
    await edit(a, "A2");
    await a.ses.getState().save();
    await sync(s);
    expect(b.dev.localPaths().filter((p) => p.includes("my version"))).toHaveLength(1);
    expect(b.graph.getState().doc!.cells[0][0][0]).toBe("A2");
  });

  it("save mine as a separate copy: a new analysis elsewhere; the file is left as they saved it", async () => {
    const s = await conflict();
    const { b, theirs } = s;
    b.picks.push(`${DBX}/Mine`);
    await b.ses.getState().resolveConflict("separateCopy");
    const mine = `${DBX}/Mine.lag`;
    expect(b.ses.getState().tabs[0]).toMatchObject({ path: mine, dirty: false, notSaved: false, title: "Mine" });
    expect(b.dev.localFile(mine)!.manifest.analysis_id).not.toBe(b.dev.localFile(P)!.manifest.analysis_id);
    expect(firstCell(contentAt(b.dev, mine))).toBe("B!");
    expect(b.dev.localHead(P)).toBe(theirs);
    expect(b.ses.getState().recent.map((r) => r.path)).toEqual([mine, P]);
    expectNothingLost(s.w);
  });

  it("decide later: nothing written, 'Not saved' stays with Choose…", async () => {
    const s = await conflict();
    const { b, theirs } = s;
    const saves = b.dev.saves.length;
    await b.ses.getState().resolveConflict("cancel");
    expect(b.dev.saves.length).toBe(saves);
    expect(b.dev.localHead(P)).toBe(theirs);
    const t = b.ses.getState().tabs[0];
    expect(t).toMatchObject({ notSaved: true, dirty: true });
    expect(t.banner).toMatchObject({ kind: "notSaved", actions: ["choose"] });
    await b.ses.getState().bannerAction(t.key, t.banner!.id, "choose");
    expect(b.ses.getState().dialog?.kind).toBe("conflict");
    // A restart keeps the work and asks nothing new about it.
    await b.ses.getState().resolveConflict("cancel");
    await tick(s.w, 1500);
    const b2 = await b.restart();
    expect(b2.graph.getState().doc!.cells[0][0][0]).toBe("B!");
    expect(b2.dev.localPaths().filter((p) => p.includes("my version"))).toHaveLength(0);
  });

  it("keep mine when theirs changes again meanwhile: the sheet comes back with the newer version", async () => {
    const s = await conflict();
    const { a, b } = s;
    await edit(a, "A2!");
    await a.ses.getState().save();
    await sync(s);
    await b.ses.getState().resolveConflict("keepMine");
    // b's merge was based on A! → the save met A2! → the sheet again.
    const d = b.ses.getState().dialog;
    expect(d?.kind === "conflict" && d.info.theirs.head).toBe(a.dev.localHead(P));
    await b.ses.getState().resolveConflict("keepMine");
    expect(firstCell(contentAt(b.dev, P))).toBe("B!");
    expectNothingLost(s.w);
  });
});

describe("the journal check", () => {
  async function threeSaves() {
    const s = await twoComputers();
    const { a } = s;
    await edit(a, "r2");
    await a.ses.getState().save();
    const r2 = a.dev.localHead(P)!;
    await edit(a, "r3");
    await a.ses.getState().save();
    const r3 = a.dev.localHead(P)!;
    await sync(s);
    // The cloud service's version history puts the file back to r2.
    s.w.forceReplace(P, fileAt(a.dev.localFile(P)!, r2)!);
    await sync(s);
    return { ...s, r2, r3 };
  }

  it("a rollback is shown, never undone automatically; 'Use the earlier version' sticks", async () => {
    const s = await threeSaves();
    const { a, r2 } = s;
    const t = a.ses.getState().tabs[0];
    expect(t.banner).toMatchObject({ kind: "rolledBack", actions: ["useEarlier", "backToLatest"], version: { head: r2 } });
    expect(a.graph.getState().doc!.cells[0][0][0]).toBe("r3");   // the tab keeps its content
    expect(a.dev.localHead(P)).toBe(r2);
    await a.ses.getState().bannerAction(t.key, t.banner!.id, "useEarlier");
    expect(a.graph.getState().doc!.cells[0][0][0]).toBe("r2");
    expect(a.ses.getState().tabs[0]).toMatchObject({ baseRevision: r2, dirty: false, banners: [] });
    const a2 = await a.restart();
    expect(a2.ses.getState().tabs[0].banners).toEqual([]);
    // The other computer had loaded r3 too: it is told as well, and takes the earlier version.
    const bt = s.b.ses.getState().tabs[0];
    expect(bt.banner?.kind).toBe("rolledBack");
    await s.b.ses.getState().bannerAction(bt.key, bt.banner!.id, "useEarlier");
    // Then saves on top of it: a normal newer version for the first computer.
    await edit(s.b, "after rollback");
    await s.b.ses.getState().save();
    await sync(s);
    expect(a2.ses.getState().tabs[0].banners).toEqual([]);
    expect(a2.graph.getState().doc!.cells[0][0][0]).toBe("after rollback");
    expectNothingLost(s.w);
  });

  it("'Go back to my latest' puts my last version back on disk", async () => {
    const s = await threeSaves();
    const { a, r3 } = s;
    const t = a.ses.getState().tabs[0];
    await a.ses.getState().bannerAction(t.key, t.banner!.id, "backToLatest");
    expect(a.dev.localHead(P)).toBe(r3);
    expect(a.ses.getState().tabs[0]).toMatchObject({ banners: [], baseRevision: r3, dirty: false });
    await sync(s);
    expect(s.b.dev.localHead(P)).toBe(r3);
  });

  it("another computer's save replaced mine (last writer wins): mine is saved as a copy, nothing is lost", async () => {
    const s = await twoComputers(2000, "lww");
    const { a, w } = s;
    await edit(a, "my save");
    await a.ses.getState().save();
    const mine = a.dev.localHead(P)!;
    await sync(s);
    // Another computer, working from the version before my save, saves silently over it.
    const f = a.dev.localFile(P)!;
    const parent = revisionOf(f.manifest, mine)!.parents[0];
    const base = fileAt(f, parent)!;
    const c = openFile(base)!;
    const theirs = await buildNextFile(base, { ...c, figure: { ...c.figure, title: "theirs" } }, { time: w.clock.now(), author: authorFor(s.b.dev, "Alice") });
    w.forceReplace(P, theirs);
    await sync(s);
    const t = a.ses.getState().tabs[0];
    const copy = `${DBX}/Dose response (my version from Mac mini).lag`;
    expect(t.banners.find((b) => b.kind === "savedOver")).toMatchObject({ name: "Dose response (my version from Mac mini)", path: copy });
    expect(a.dev.localHead(copy)).toBe(mine);
    expect(firstCell(contentAt(a.dev, copy))).toBe("my save");
    expect(a.graph.getState().figure.title).toBe("theirs");          // clean tab: shows the file
    expect(isDirty(a.graph.getState())).toBe(false);
    expectAllOnDisk(w, [mine, theirs.manifest.head]);
    // Not copied again on the next look. (The other computer, which had loaded my save, keeps
    // its own copy of it too: a lost save is protected by every computer that saw it.)
    await tick(w, 10_000);
    expect(a.dev.localPaths().filter((p) => p.includes("my version"))).toEqual([copy]);
    expect(a.dev.localPaths().filter((p) => p.includes("version from")).length).toBeLessThanOrEqual(2);
    expect(s.b.dev.localPaths().some((p) => p.includes("(my version from MacBook)"))).toBe(false);
  });
});

describe("save outcomes", () => {
  it("a save that replaced another computer's save in the gap: saved, theirs kept as a copy", async () => {
    const s = await twoComputers();
    const { a, w } = s;
    const f = a.dev.localFile(P)!;
    const c = openFile(f)!;
    const theirs = await buildNextFile(f, { ...c, figure: { ...c.figure, title: "race" } }, { time: w.clock.now(), author: authorFor(s.b.dev, "Alice") });
    a.dev.armDisplace(P, theirs);
    await edit(a, "mine");
    expect((await a.ses.getState().save()).ok).toBe(true);
    const copy = `${DBX}/Dose response (version from MacBook).lag`;
    expect(a.ses.getState().tabs[0].banner).toMatchObject({ kind: "savedDisplaced", name: "Dose response (version from MacBook)", path: copy });
    expect(a.dev.localHead(copy)).toBe(theirs.manifest.head);
    expect(a.ses.getState().tabs[0].dirty).toBe(false);
  });

  it("when the file on disk can't be checked, the save goes beside it and the tab stays unsaved", async () => {
    const s = await twoComputers();
    const { a } = s;
    a.dev.armOffline(P);
    await edit(a, "aside");
    expect(await a.ses.getState().save()).toEqual({ ok: false, reason: "failed" });
    const aside = `${DBX}/Dose response (unsynced from Mac mini).lag`;
    expect(a.ses.getState().tabs[0].banner).toMatchObject({ kind: "savedAside", name: "Dose response (unsynced from Mac mini)", path: aside });
    expect(firstCell(contentAt(a.dev, aside))).toBe("aside");
    expect(a.ses.getState().tabs[0].dirty).toBe(true);
    await flush();
    expect(await a.dev.readDraft(a.ses.getState().activeKey!)).not.toBeNull();
    // The next save goes to the file itself.
    expect((await a.ses.getState().save()).ok).toBe(true);
    expect(firstCell(contentAt(a.dev, P))).toBe("aside");
    expect(a.ses.getState().tabs[0].banners.some((b) => b.kind === "savedAside")).toBe(false);
  });

  it("a file that is online-only shows 'Downloading…'; when back, a changed version loads", async () => {
    const s = await twoComputers();
    const { a, b } = s;
    b.dev.makeDataless(P);
    await flush();
    expect(b.ses.getState().tabs[0].banner).toMatchObject({ kind: "downloading", service: "Dropbox" });
    await edit(a, "while away");
    await a.ses.getState().save();
    await sync(s);
    b.dev.hydrate(P);
    await flush();
    expect(b.ses.getState().tabs[0].banners).toEqual([]);
    expect(b.graph.getState().doc!.cells[0][0][0]).toBe("while away");
  });

  it("a different analysis saved under the name: banner, never adopted", async () => {
    const s = await twoComputers();
    const { a, b, w } = s;
    const other = await seedFile(w, b.dev, `${DBX}/tmp.lag`, "grouped");
    w.forceReplace(P, other);
    await sync(s);
    expect(a.ses.getState().tabs[0].banner).toMatchObject({ kind: "replaced", actions: ["saveAs"] });
    expect(a.graph.getState().doc!.template).toBe("column");
  });
});

describe("the same analysis in another place", () => {
  it("a newer copy sent back by a colleague: 'Update my file with it'", async () => {
    const s = await twoComputers();
    const { a, w } = s;
    const f = a.dev.localFile(P)!;
    const c = openFile(f)!;
    const back = await buildNextFile(f, { ...c, figure: { ...c.figure, title: "Bob's edit" } }, { time: w.clock.now(), author: authorFor(s.b.dev, "Bob") });
    const dl = `${DOWNLOADS}/Dose response.lag`;
    a.dev.place(dl, back);
    await a.ses.getState().open(dl);
    await flush();
    const t = a.ses.getState().tabs.find((x) => x.path === dl)!;
    expect(t.banners.map((b) => b.kind)).toEqual(expect.arrayContaining(["tempLocation", "newerCopy"]));
    const nb = t.banners.find((b) => b.kind === "newerCopy")!;
    expect(nb).toMatchObject({ path: P, folderLabel: "Dropbox › Lab", version: { userName: "Bob" } });
    await a.ses.getState().bannerAction(t.key, nb.id, "updateMine");
    expect(a.dev.localHead(P)).toBe(back.manifest.head);
    const s2 = a.ses.getState();
    expect(s2.tabs.map((x) => x.path)).toEqual([P]);
    expect(s2.activeKey).toBe(s2.tabs[0].key);
    expect(a.graph.getState().figure.title).toBe("Bob's edit");
  });

  it("an older copy points at the newer one", async () => {
    const s = await twoComputers();
    const { a } = s;
    const old = a.dev.localFile(P)!;
    await edit(a, "newer");
    await a.ses.getState().save();
    const dl = `${DOWNLOADS}/Dose response.lag`;
    a.dev.place(dl, old);
    await a.ses.getState().open(dl);
    await flush();
    const t = a.ses.getState().tabs.find((x) => x.path === dl)!;
    expect(t.banners.find((b) => b.kind === "olderCopy")).toMatchObject({ path: P, version: { head: a.dev.localHead(P) } });
  });
});

describe("multi-device scenarios (plan §13)", () => {
  it.each([0, 5000, 60000])("both computers save the same version (sync delay %i ms): nothing lost, both end on the same file", { timeout: 60_000 }, async (delay) => {
    const s = await twoComputers(delay);
    const { a, b } = s;
    await edit(a, "A!");
    await edit(b, "B!");
    await a.ses.getState().save();
    await b.ses.getState().save();
    await sync(s);
    await sync(s);
    expect(a.dev.localHead(P)).toBe(b.dev.localHead(P));
    const copies = a.dev.localPaths().filter((p) => p !== P);
    expect(copies).toHaveLength(1);                        // the service's conflicted copy
    expect(b.dev.localPaths()).toEqual(a.dev.localPaths());
    expectAllOnDisk(s.w, [...writtenHeads(s.w)]);
    // The computer whose save became the copy is told; nobody has unsaved changes.
    for (const c of [a, b]) expect(isDirty(c.graph.getState())).toBe(false);
    const loser = a.dev.localHead(P) === a.ses.getState().tabs[0].baseRevision && a.ses.getState().tabs[0].banners.some((x) => x.kind === "savedOver") ? a : b;
    expect(loser.ses.getState().tabs[0].banners.some((x) => x.kind === "savedOver" || x.kind === "extraCopy")).toBe(true);
    expect(loser.dev.localPaths().filter((p) => p.includes("my version"))).toHaveLength(0);   // the service's copy is reused
  });

  it("offline: saves made offline survive the reconnect", async () => {
    const s = await twoComputers(1000);
    const { a, b } = s;
    b.dev.setOnline(false);
    await edit(a, "online");
    await a.ses.getState().save();
    await edit(b, "offline");
    await b.ses.getState().save();
    await sync(s);
    b.dev.setOnline(true);
    await sync(s);
    await sync(s);
    expectAllOnDisk(s.w, [...writtenHeads(s.w)]);
    expect(a.dev.localHead(P)).toBe(b.dev.localHead(P));
  });

  it("partial delivery: an incomplete file is never a new version; the tab updates once it is whole", async () => {
    const s = await twoComputers(1000, "dropbox", { partialB: 4000 });
    const { a, b } = s;
    await edit(a, "big");
    await a.ses.getState().save();
    await tick(s.w, 2500);
    expect(b.ses.getState().tabs[0].banner?.kind).toBe("downloading");
    expect(b.graph.getState().doc!.cells[0][0][0]).not.toBe("big");
    await tick(s.w, 5000);
    expect(b.ses.getState().tabs[0].banners).toEqual([]);
    expect(b.graph.getState().doc!.cells[0][0][0]).toBe("big");
    expect(isDirty(b.graph.getState())).toBe(false);
  });

  it("delete-then-create by a sync client is not 'missing'", async () => {
    const s = await twoComputers(1000);
    const { a, b } = s;
    const f = a.dev.localFile(P)!;
    a.dev.remove(P);
    await tick(s.w, 2500);
    a.dev.place(P, f);
    await sync(s);
    await tick(s.w, 10_000);
    for (const c of [a, b]) expect(c.ses.getState().tabs[0].banners.some((x) => x.kind === "missing")).toBe(false);
  });

  it("rename on one computer while the other edits and saves: both versions survive", async () => {
    const s = await twoComputers(1000);
    const { a, b } = s;
    a.dev.rename(P, `${DBX}/Renamed.lag`);
    await edit(b, "edited");
    await b.ses.getState().save();
    await sync(s);
    await tick(s.w, 10_000);
    expectAllOnDisk(s.w, [...writtenHeads(s.w)]);
    // The edit re-created the old name (a deletion never wins over a newer version), so the
    // first computer stays on it with the edited content; the renamed file is an older copy.
    expect(a.ses.getState().tabs[0].path).toBe(P);
    expect(a.graph.getState().doc!.cells[0][0][0]).toBe("edited");
    expect(a.dev.localPaths()).toEqual([P, `${DBX}/Renamed.lag`]);
    for (const c of [a, b]) expect(isDirty(c.graph.getState())).toBe(false);
  });

  it("two computers with the same device id: still nothing lost", async () => {
    const s = await twoComputers(1000, "dropbox", { sameId: true });
    const { a, b } = s;
    await edit(a, "A!");
    await edit(b, "B!");
    await a.ses.getState().save();
    await sync(s);
    expect(await b.ses.getState().save()).toEqual({ ok: false, reason: "conflict" });
    await b.ses.getState().resolveConflict("keepMine");
    await sync(s);
    expect(a.dev.localHead(P)).toBe(b.dev.localHead(P));
    expectNothingLost(s.w);
  });

  it("clock skew of two hours decides nothing: the combined version id is the same from either side", async () => {
    const s = await twoComputers(1000, "dropbox", { skewB: 2 * 3600_000 });
    const { a, b } = s;
    await edit(a, "A!");
    await edit(b, "B!");
    await a.ses.getState().save();
    await sync(s);
    await b.ses.getState().save();
    await b.ses.getState().resolveConflict("keepMine");
    const f = b.dev.localFile(P)!;
    const k = revisionOf(f.manifest, f.manifest.head)!;
    const { mergeRevisionId } = await import("./docCodec");
    expect(k.id).toBe(await mergeRevisionId([...k.parents].reverse(), k.content_hash));
    // b's revisions carry b's clock; ordering never used it.
    const w = revisionOf(f.manifest, k.parents[1])!;
    expect(Date.parse(w.time) - s.w.clock.now()).toBeGreaterThan(3600_000);
    await sync(s);
    expect(a.graph.getState().doc!.cells[0][0][0]).toBe("B!");
    expect(isAncestorOrSelf(f.manifest, k.parents[0], f.manifest.head)).toBe(true);
    expectNothingLost(s.w);
  });
});
