// Regression tests for the defects found in the phase 1 review (each test names its finding).
// Two simulated computers on the memory backend and the manual clock (testkit).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SaveRequest, SaveResult } from "./backend";
import { buildNextFile, openFile, pruneSnapshots, withAbsentSnapshotsDropped } from "./docCodec";
import type { GraphFileData, Manifest, Revision } from "./format";
import { createTauriBackend, type InvokeFn, type ListenFn } from "./tauriBackend";
import {
  DBX, DOCS, authorFor, computer, contentAt, firstCell, flush, makeWorld, seedFile, start, tick, withAnswer, type Computer,
} from "./testkit";
import type { MemoryDevice, MemoryWorld } from "./memoryBackend";


// Phase 2: a save conflict combines; the phase 1 conflict sheet is reached only when combining is not
// possible (a side that is not a readable document). These tests force that fallback.
const flags = vi.hoisted(() => ({ fallback: false }));
vi.mock("./graphMerge", async (importOriginal) => {
  const m = await importOriginal<typeof import("./graphMerge")>();
  return { ...m, combine: async (input: Parameters<typeof m.combine>[0]) => (flags.fallback ? { ok: false as const, reason: "unreadable" as const, side: "theirs" as const } : m.combine(input)) };
});
afterEach(() => { flags.fallback = false; });

const A = `${DOCS}/A.lag`;
const B = `${DOCS}/B.lag`;
const P = `${DBX}/Dose.lag`;

/** Hold a computer's saves until released (a save in flight, e.g. a slow cloud folder). */
function gateSaves(dev: { save(req: SaveRequest): Promise<SaveResult> }) {
  const orig = dev.save.bind(dev);
  let release: (() => void) | null = null;
  let gate: Promise<void> | null = null;
  dev.save = async (req) => { if (gate) await gate; return orig(req); };
  return {
    hold() { gate = new Promise<void>((r) => { release = r; }); },
    release() { const r = release; gate = null; release = null; r?.(); },
  };
}

/** Another computer's save of `path` with the first table cell set to `val`. */
async function remoteSave(w: MemoryWorld, dev: MemoryDevice, path: string, val: string): Promise<GraphFileData> {
  const f = dev.localFile(path)!;
  const c = openFile(f)!;
  const cells = c.doc.cells.map((r) => r.map((x) => [...x]));
  cells[0][0][0] = val;
  const next = await buildNextFile(f, { ...c, doc: { ...c.doc, cells } }, { time: w.clock.now(), author: authorFor(dev) });
  const res = await dev.save({ path, expectedHead: f.manifest.head, analysisId: f.manifest.analysis_id, docKey: "k-remote", manifest: next.manifest, newParts: next.parts });
  if (!res.ok) throw new Error(`remote save failed ${JSON.stringify(res)}`);
  return next;
}

const cellOf = (c: Computer, row: number) => c.graph.getState().doc!.cells[row][0][0];
const tabByKey = (c: Computer, key: string) => c.ses.getState().tabs.find((t) => t.key === key)!;
const two = async () => {
  const w = makeWorld();
  const a = await start(await computer(w, { device_id: "d-a", device_name: "Mac mini" }));
  const b = await start(await computer(w, { device_id: "d-b", device_name: "Office iMac" }));
  return { w, a, b };
};

describe("edits made while a save is in flight (review V1/V2, TS)", () => {
  it("V1: typed during the save, then the tab is left: the edit stays as unsaved changes", async () => {
    const w = makeWorld();
    const a = await start(await computer(w, { device_id: "d-a", device_name: "Mac mini" }));
    await seedFile(w, a.dev, A); await seedFile(w, a.dev, B);
    const kb = (await a.ses.getState().open(B) as { key: string }).key;
    const ka = (await a.ses.getState().open(A) as { key: string }).key;
    a.graph.getState().setCell(0, 0, 0, "E1");
    await flush();
    const g = gateSaves(a.dev);
    g.hold();
    const saving = a.ses.getState().save();
    await flush();
    a.graph.getState().setCell(1, 0, 0, "E2");
    await flush();
    await a.ses.getState().switchTab(kb);
    g.release();
    expect((await saving).ok).toBe(true);
    await flush();
    expect(tabByKey(a, ka).dirty).toBe(true);
    const d = await a.dev.readDraft(ka);
    expect(d?.base_revision).toBe(a.dev.localHead(A));     // on top of the version just saved
    await a.ses.getState().switchTab(ka);
    await flush();
    expect(contentAt(a.dev, A)!.doc.cells[0][0][0]).toBe("E1");
    expect(cellOf(a, 1)).toBe("E2");
    expect(tabByKey(a, ka).dirty).toBe(true);
    expect(tabByKey(a, ka).banners.some((x) => x.kind === "newerOnDisk")).toBe(false);
    // and it saves normally afterwards
    expect((await a.ses.getState().save()).ok).toBe(true);
    expect(contentAt(a.dev, A)!.doc.cells[1][0][0]).toBe("E2");
  });

  it("V1: no edit during the save, tab left: nothing stays behind", async () => {
    const w = makeWorld();
    const a = await start(await computer(w, { device_id: "d-a", device_name: "Mac mini" }));
    await seedFile(w, a.dev, A); await seedFile(w, a.dev, B);
    const kb = (await a.ses.getState().open(B) as { key: string }).key;
    const ka = (await a.ses.getState().open(A) as { key: string }).key;
    a.graph.getState().setCell(0, 0, 0, "E1");
    await flush();
    const g = gateSaves(a.dev);
    g.hold();
    const saving = a.ses.getState().save();
    await flush();
    await a.ses.getState().switchTab(kb);
    g.release();
    expect((await saving).ok).toBe(true);
    await flush();
    expect(tabByKey(a, ka).dirty).toBe(false);
    expect(await a.dev.readDraft(ka)).toBeNull();
  });

  it("V2: typed during a save that meets a conflict, then 'Use theirs': the typing is in my copy", async () => {
    flags.fallback = true;
    const { w, a, b } = await two();
    await seedFile(w, a.dev, P);
    await tick(w, 2000);
    await a.ses.getState().open(P);
    a.graph.getState().setCell(0, 0, 0, "MINE1");
    await flush();
    await remoteSave(w, b.dev, P, "THEIRS");
    await tick(w, 4000);
    const g = gateSaves(a.dev);
    g.hold();
    const saving = a.ses.getState().save();
    await flush();
    a.graph.getState().setCell(1, 0, 0, "MINE2");
    await flush();
    g.release();
    await saving;
    await flush();
    expect(a.ses.getState().dialog?.kind).toBe("conflict");
    await a.ses.getState().resolveConflict("takeTheirs");
    await flush();
    const copies = a.dev.localPaths().filter((p) => p !== P);
    const copy = copies.find((p) => contentAt(a.dev, p)?.doc.cells[1][0][0] === "MINE2");
    expect(copy).toBeTruthy();
    expect(firstCell(contentAt(a.dev, copy!))).toBe("MINE1");
    expect(cellOf(a, 0)).toBe("THEIRS");
  });

  it("V2: the tab was left during the save; 'Use theirs' keeps what was typed (copy), 'Keep mine' saves it", async () => {
    for (const choice of ["takeTheirs", "keepMine"] as const) {
      flags.fallback = true;
      const { w, a, b } = await two();
      await seedFile(w, a.dev, P); await seedFile(w, a.dev, B);
      await tick(w, 2000);
      const kb = (await a.ses.getState().open(B) as { key: string }).key;
      await a.ses.getState().open(P);
      a.graph.getState().setCell(0, 0, 0, "MINE1");
      await flush();
      await remoteSave(w, b.dev, P, "THEIRS");
      await tick(w, 4000);
      const g = gateSaves(a.dev);
      g.hold();
      const saving = a.ses.getState().save();
      await flush();
      a.graph.getState().setCell(1, 0, 0, "MINE2");
      await flush();
      await a.ses.getState().switchTab(kb);
      g.release();
      await saving;
      await flush();
      expect(a.ses.getState().dialog?.kind).toBe("conflict");
      await a.ses.getState().resolveConflict(choice);
      await flush();
      if (choice === "takeTheirs") {
        expect(a.dev.localPaths().some((p) => p !== P && p !== B && contentAt(a.dev, p)?.doc.cells[1][0][0] === "MINE2")).toBe(true);
      } else {
        expect(contentAt(a.dev, P)!.doc.cells[1][0][0]).toBe("MINE2");
        expect(firstCell(contentAt(a.dev, P))).toBe("MINE1");
      }
    }
  });

  it("V5 (TS): two Save commands at once: one save, no conflict with myself", async () => {
    const w = makeWorld();
    const a = await start(await computer(w, { device_id: "d-a", device_name: "Mac mini" }));
    await seedFile(w, a.dev, A);
    await a.ses.getState().open(A);
    a.graph.getState().setCell(0, 0, 0, "E1");
    await flush();
    const before = a.dev.saves.length;
    const r = await Promise.all([a.ses.getState().save(), a.ses.getState().save()]);
    await flush();
    expect(r.every((x) => x.ok)).toBe(true);
    expect(a.dev.saves.length - before).toBe(1);
    expect(a.ses.getState().dialog).toBeNull();
    expect(a.ses.getState().tabs[0].notSaved).toBe(false);
  });
});

describe("opening (review V3, TS)", () => {
  it("the same file opened twice at once gives one tab, and the tab shows while the file is read", async () => {
    const w = makeWorld();
    const a = await start(await computer(w, { device_id: "d-a", device_name: "Mac mini" }));
    await seedFile(w, a.dev, A);
    const origRead = a.dev.read.bind(a.dev);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    a.dev.read = async (p) => { await gate; return origRead(p); };
    const both = Promise.all([a.ses.getState().open(A), a.ses.getState().open(A)]);
    await flush();
    expect(a.ses.getState().tabs.map((t) => [t.path, t.status])).toEqual([[A, "opening"]]);
    release();
    const [r1, r2] = await both;
    await flush();
    expect(a.ses.getState().tabs.filter((t) => t.path === A)).toHaveLength(1);
    expect(r1).toEqual(r2);
    expect(a.ses.getState().tabs[0].status).toBe("ready");
  });

  it("a file that can't be found leaves no tab behind", async () => {
    const w = makeWorld();
    const a = await start(await computer(w, { device_id: "d-a", device_name: "Mac mini" }));
    const r = await a.ses.getState().open(`${DOCS}/nothing.lag`);
    expect(r.ok).toBe(false);
    expect(a.ses.getState().tabs).toHaveLength(0);
  });
});

describe("history kept in files (review V4, V5 (Rust), V6)", () => {
  it("V4: Save As 'the same analysis in a new place' keeps every stored version, also ones this computer never had as newest", async () => {
    const { w, a, b } = await two();
    await seedFile(w, b.dev, P);
    await remoteSave(w, b.dev, P, "v2");
    await remoteSave(w, b.dev, P, "v3");
    await tick(w, 3000);
    await a.ses.getState().open(P);
    await flush();
    const before = a.dev.localFile(P)!.manifest.revisions.filter((r) => r.sections).length;
    expect(before).toBe(3);
    a.picks.push(`${DOCS}/Kept`);
    const r = await withAnswer(a, () => a.ses.getState().saveAs("ask"), { kind: "saveAsKind", choice: "same" });
    expect(r.ok).toBe(true);
    const f = a.dev.localFile(`${DOCS}/Kept.lag`)!;
    expect(f.manifest.analysis_id).toBe(a.dev.localFile(P)!.manifest.analysis_id);
    expect(f.manifest.revisions.filter((x) => x.sections).length).toBe(before);
  });

  it("V5: a file missing the content of an older version opens and saves (that version is marked as not stored)", async () => {
    const w = makeWorld();
    const a = await start(await computer(w, { device_id: "d-a", device_name: "Mac mini" }));
    const f1 = await seedFile(w, a.dev, A);
    const c = openFile(f1)!;
    const cells = c.doc.cells.map((r) => r.map((x) => [...x]));
    cells[0][0][0] = "v2";
    const f2 = await buildNextFile(f1, { ...c, doc: { ...c.doc, cells } }, { time: w.clock.now(), author: authorFor(a.dev) });
    const oldTable = f1.manifest.revisions[0].sections!.table.part;
    expect(f2.manifest.revisions[1].sections!.table.part).not.toBe(oldTable);
    const damaged: GraphFileData = { manifest: f2.manifest, parts: Object.fromEntries(Object.entries(f2.parts).filter(([k]) => k !== oldTable)) };
    a.dev.place(B, damaged);
    expect(withAbsentSnapshotsDropped(damaged).manifest.revisions[0].sections).toBeNull();
    expect(withAbsentSnapshotsDropped(damaged).manifest.revisions[1].sections).not.toBeNull();
    await a.ses.getState().open(B);
    a.graph.getState().setCell(0, 0, 0, "v3");
    await flush();
    const r = await a.ses.getState().save();
    expect(r.ok).toBe(true);
    const saved = a.dev.localFile(B)!;
    expect(saved.manifest.revisions).toHaveLength(3);
    expect(saved.manifest.revisions[0].sections).toBeNull();
    expect(firstCell(contentAt(a.dev, B))).toBe("v3");
  });

  it("V6: a file keeps the content of the newest 20 versions; every version keeps its entry", async () => {
    const w = makeWorld();
    const a = await start(await computer(w, { device_id: "d-a", device_name: "Mac mini" }));
    await seedFile(w, a.dev, A);
    await a.ses.getState().open(A);
    for (let n = 1; n <= 26; n++) {
      a.graph.getState().setCell(0, 0, 0, `v${n}`);
      await flush();
      expect((await a.ses.getState().save()).ok).toBe(true);
    }
    const m = a.dev.localFile(A)!.manifest;
    expect(m.revisions).toHaveLength(27);
    const stored = m.revisions.filter((r) => r.sections);
    // the newest 20, plus the seed version (its next version was saved on another device id)
    expect(stored.length).toBeLessThanOrEqual(21);
    expect(stored.length).toBeGreaterThanOrEqual(20);
    expect(m.revisions.slice(-20).every((r) => r.sections)).toBe(true);
    expect(firstCell(contentAt(a.dev, A))).toBe("v26");
  });

  it("V6: pruning keeps both parents of a combined version and the points where work passed between computers", () => {
    const rev = (id: string, parents: string[], device: string): Revision => ({
      id, parents, time: "2026-11-20T10:00:00Z", user_name: "u", device_id: device, device_name: device, session_id: "s",
      app_version: "t", kind: parents.length > 1 ? "merge" : "save", summary: "",
      sections: { table: { part: `parts/${id}t.json`, sha256: "", bytes: 1 }, analysis: { part: `parts/${id}a.json`, sha256: "", bytes: 1 },
        figure: { part: `parts/${id}f.json`, sha256: "", bytes: 1 }, scratchpad: { part: `parts/${id}s.json`, sha256: "", bytes: 1 } },
      content_hash: id,
    });
    const revs: Revision[] = [rev("r-0", [], "d-a"), rev("r-x", ["r-0"], "d-a"), rev("r-1", ["r-x"], "d-b")];
    for (let n = 2; n < 30; n++) revs.push(rev(`r-${n}`, [`r-${n - 1}`], "d-b"));
    revs.push(rev("r-m", ["r-29", "r-0"], "d-b"));
    const m = { head: "r-m", revisions: revs } as unknown as Manifest;
    const p = pruneSnapshots(m, 5);
    const kept = new Set(p.revisions.filter((r) => r.sections).map((r) => r.id));
    expect(p.revisions).toHaveLength(revs.length);
    for (const id of ["r-m", "r-29", "r-26", "r-0", "r-x"]) expect(kept.has(id)).toBe(true);   // head, newest, merge parents, hand-over point
    expect(kept.has("r-10")).toBe(false);
    const small = { head: "r-x", revisions: revs.slice(0, 2) } as unknown as Manifest;
    expect(pruneSnapshots(small, 5)).toBe(small);     // under the limit: unchanged
  });
});

describe("startup and copies (review F2, F5, F6)", () => {
  it("F2: a file renamed in a cloud folder while the app was closed is followed at once (no wait)", async () => {
    const w = makeWorld();
    const a = await start(await computer(w, { device_id: "d-a", device_name: "Mac mini" }));
    await seedFile(w, a.dev, P);
    await a.ses.getState().open(P);
    a.dev.rename(P, `${DBX}/Dose v2.lag`);
    const a2 = await a.restart();
    const t = a2.ses.getState().tabs[0];
    expect(t.path).toBe(`${DBX}/Dose v2.lag`);
    expect(t.status).toBe("ready");
    expect(a2.ses.getState().cards).toHaveLength(0);
  });

  it("F2: while waiting for the cloud service, a sync-conflict copy is not taken for the file", async () => {
    const w = makeWorld();
    const a = await start(await computer(w, { device_id: "d-a", device_name: "Mac mini" }));
    const f = await seedFile(w, a.dev, P);
    await a.ses.getState().open(P);
    a.dev.remove(P);
    a.dev.place(`${DBX}/Dose (Office iMac's conflicted copy 2026-11-20).lag`, f);
    const a2 = await a.restart();
    expect(a2.ses.getState().tabs[0].path).toBe(P);
    expect(a2.ses.getState().cards[0]?.kind).toBe("waiting");
  });

  it("F6: a Finder duplicate seen beside the file is not taken for it after a restart", async () => {
    const w = makeWorld();
    const a = await start(await computer(w, { device_id: "d-a", device_name: "Mac mini" }));
    await seedFile(w, a.dev, B);
    await a.ses.getState().open(B);
    a.dev.duplicate(B, `${DOCS}/B copy.lag`);
    await tick(w, 3000);
    expect(a.ses.getState().tabs[0].banners.some((x) => x.kind === "copyQuestion")).toBe(true);
    a.dev.remove(B);
    const a2 = await a.restart();
    expect(a2.ses.getState().tabs[0].path).toBe(B);
    expect(a2.ses.getState().cards[0]?.kind).toBe("missing");
  });

  it("F5: background tabs restored at startup are watched before they are visited", async () => {
    const w = makeWorld();
    const a = await start(await computer(w, { device_id: "d-a", device_name: "Mac mini" }));
    await seedFile(w, a.dev, A); await seedFile(w, a.dev, B);
    await a.ses.getState().open(A);
    await a.ses.getState().open(B);
    const a2 = await a.restart();
    expect(a2.dev.trackedPaths()).toEqual([A, B]);
  });

  it("F5: the desktop backend sends the head and id from a header read with graphfile_track", async () => {
    const calls: { cmd: string; args: Record<string, unknown> }[] = [];
    const invoke = (async (cmd: string, args: Record<string, unknown>) => {
      calls.push({ cmd, args });
      if (cmd === "graphfile_header") return { header: { analysis_id: "a-1", head: "r-9" }, stat: { path: "/d/a.lag", size: 1, mtime: 1, dataless: false } };
      return null;
    }) as unknown as InvokeFn;
    const be = createTauriBackend({ invoke, listen: (async () => () => undefined) as unknown as ListenFn });
    await be.header("/d/a.lag");
    be.track("/d/a.lag", { active: false });
    await Promise.resolve();
    expect(calls.find((c) => c.cmd === "graphfile_track")?.args).toEqual({ path: "/d/a.lag", active: false, head: "r-9", analysisId: "a-1" });
  });
});

describe("menu, copies, messages (review F3, F4, F7, F8, V2 Rust)", () => {
  it("F3: File-menu document commands from another tool only bring Graphs forward", async () => {
    const w = makeWorld();
    let visible = false;
    const a = await start(await computer(w, { device_id: "d-a", device_name: "Mac mini" }, { graphsVisible: () => visible }));
    await seedFile(w, a.dev, A);
    await a.ses.getState().open(A);
    const f0 = a.ses.getState().focusSerial;
    await a.ses.getState().menu("file.close_tab");
    await a.ses.getState().menu("file.save_as");
    expect(a.ses.getState().tabs).toHaveLength(1);
    expect(a.pickRequests).toHaveLength(0);
    expect(a.ses.getState().focusSerial).toBe(f0 + 2);
    visible = true;
    await a.ses.getState().menu("file.close_tab");
    expect(a.ses.getState().tabs).toHaveLength(0);
  });

  it("F4: a newer copy saved next to my file can update my file", async () => {
    const { w, a, b } = await two();
    const f = await seedFile(w, a.dev, P);
    await tick(w, 2000);
    await a.ses.getState().open(P);
    const key = a.ses.getState().activeKey!;
    // A colleague's edited copy, saved beside the original.
    const c = openFile(f)!;
    const cells = c.doc.cells.map((r) => r.map((x) => [...x]));
    cells[0][0][0] = "FROM BOB";
    const next = await buildNextFile(f, { ...c, doc: { ...c.doc, cells } }, { time: w.clock.now(), author: authorFor(b.dev, "Bob") });
    const copy = `${DBX}/Dose 2.lag`;
    a.dev.place(copy, next);
    await tick(w, 3500);
    expect(tabByKey(a, key).banners.some((x) => x.kind === "copyQuestion" && x.path === copy)).toBe(true);
    await a.ses.getState().bannerAction(key, `copy:${copy}`, "same");
    const extra = tabByKey(a, key).banners.find((x) => x.id === `copy:${copy}`)!;
    expect(extra).toMatchObject({ kind: "extraCopy", relation: "newer", actions: ["updateMine", "notSame", "later"] });
    await a.ses.getState().bannerAction(key, extra.id, "updateMine");
    await flush();
    expect(a.dev.localHead(P)).toBe(next.manifest.head);
    expect(cellOf(a, 0)).toBe("FROM BOB");
    expect(tabByKey(a, key).dirty).toBe(false);
    expect(tabByKey(a, key).baseRevision).toBe(next.manifest.head);
  });

  it("F4: opening the newer copy beside my file offers to update my file", async () => {
    const { w, a, b } = await two();
    const f = await seedFile(w, a.dev, P);
    await a.ses.getState().open(P);
    await a.ses.getState().closeTab();
    const c = openFile(f)!;
    const next = await buildNextFile(f, { ...c, figure: { ...c.figure, title: "Bob's" } }, { time: w.clock.now(), author: authorFor(b.dev, "Bob") });
    const copy = `${DBX}/Dose 2.lag`;
    a.dev.place(copy, next);
    await a.ses.getState().open(copy);
    await flush();
    const t = a.ses.getState().tabs[0];
    expect(t.banners.find((x) => x.kind === "newerCopy")).toMatchObject({ path: P });
    expect(t.banners.some((x) => x.kind === "copyQuestion")).toBe(false);
  });

  it("F7: after a save, 'restored' and 'now showing theirs' notes go; a save that finds no file says so", async () => {
    const w = makeWorld();
    const a = await start(await computer(w, { device_id: "d-a", device_name: "Mac mini" }));
    await seedFile(w, a.dev, A);
    await a.ses.getState().open(A);
    a.graph.getState().setCell(0, 0, 0, "x");
    await tick(w, 1500);
    const a2 = await a.restart();
    expect(a2.ses.getState().tabs[0].banners.some((x) => x.kind === "recovered")).toBe(true);
    expect((await a2.ses.getState().save()).ok).toBe(true);
    expect(a2.ses.getState().tabs[0].banners.some((x) => x.kind === "recovered")).toBe(false);
    a2.dev.remove(A);
    await tick(w, 12000);
    a2.graph.getState().setCell(0, 0, 0, "y");
    await flush();
    const r = await a2.ses.getState().save();
    expect(r.ok).toBe(false);
    expect(a2.ses.getState().toasts.some((t) => t.kind === "error" && /can't be found/.test(t.message ?? ""))).toBe(true);
  });

  it("F7: Find it… in another folder says where the file was found", async () => {
    const w = makeWorld();
    const a = await start(await computer(w, { device_id: "d-a", device_name: "Mac mini" }));
    await seedFile(w, a.dev, A);
    await a.ses.getState().open(A);
    a.dev.addFolder(`${DOCS}/Moved`);
    a.dev.rename(A, `${DOCS}/Moved/A.lag`);
    const a2 = await a.restart();
    const key = a2.ses.getState().tabs[0].key;
    expect(a2.ses.getState().cards[0]?.kind).toBe("missing");
    await a2.ses.getState().findIt(key, `${DOCS}/Moved`);
    await flush();
    const toast = a2.ses.getState().toasts.find((t) => t.kind === "renamed");
    expect(toast?.message).toMatch(/^Found in /);
    expect(a2.ses.getState().tabs[0].path).toBe(`${DOCS}/Moved/A.lag`);
  });

  it("F8: an old browser-storage backup is cleared once tabs were restored (never imported later as a stale tab)", async () => {
    const w = makeWorld();
    const a = await start(await computer(w, { device_id: "d-a", device_name: "Mac mini" }));
    await seedFile(w, a.dev, A);
    await a.ses.getState().open(A);
    let cleared = 0;
    const a2 = await a.restart({ legacyDraft: { read: () => ({ name: "old" }) as never, clear: () => { cleared++; } } });
    expect(cleared).toBe(1);
    expect(a2.ses.getState().tabs).toHaveLength(1);
  });

  it("moved: a change of the name's Unicode form only re-points quietly", async () => {
    const w = makeWorld();
    const a = await start(await computer(w, { device_id: "d-a", device_name: "Mac mini" }));
    const nfc = `${DOCS}/Café.lag`;
    const nfd = `${DOCS}/Café.lag`;
    await seedFile(w, a.dev, nfc);
    await a.ses.getState().open(nfc);
    a.dev.rename(nfc, nfd);
    await tick(w, 9000);
    expect(a.ses.getState().tabs[0].path).toBe(nfd);
    expect(a.ses.getState().toasts.some((t) => t.kind === "renamed")).toBe(false);
  });

  it("V2 (Rust side): the desktop backend runs one draft's writes and deletes in order, numbered", async () => {
    const order: string[] = [];
    let releaseWrite: () => void = () => undefined;
    const invoke = (async (cmd: string, args: Record<string, unknown>) => {
      order.push(`${cmd}:${String(args.seq)}`);
      if (cmd === "appstate_write_draft") await new Promise<void>((r) => { releaseWrite = r; });
      order.push(`done ${cmd}`);
      return null;
    }) as unknown as InvokeFn;
    const be = createTauriBackend({ invoke, listen: (async () => () => undefined) as unknown as ListenFn });
    const draft = { doc_key: "k-1", analysis_id: null, path: null, base_revision: null, sections: {}, saved_at: "" };
    const wr = be.writeDraft(draft);
    const del = be.deleteDraft("k-1");
    await flush(5);
    expect(order.map((x) => x.split(":")[0])).toEqual(["appstate_write_draft"]);   // the delete waits
    releaseWrite();
    await wr; await del;
    expect(order.map((x) => x.split(":")[0])).toEqual(["appstate_write_draft", "done appstate_write_draft", "appstate_delete_draft", "done appstate_delete_draft"]);
    const seqs = order.filter((x) => !x.startsWith("done")).map((x) => Number(x.split(":")[1]));
    expect(seqs[1]).toBeGreaterThan(seqs[0]);
  });
});
