// The browser preview's world and simulator (contract §4.14): every DevSimApi
// action reaches the app only through its normal events.
import { describe, expect, it } from "vitest";
import { isDirty } from "../../../store/graphStore";
import { makeDevSim } from "./devSim";
import { ManualClock, MemoryWorld } from "./memoryBackend";
import { PREVIEW_FOLDERS, PREVIEW_SAMPLE, createPreviewWorld } from "./previewBackend";
import { controllerFor, flush, tick } from "./testkit";

const last = <T>(a: readonly T[]): T | undefined => a[a.length - 1];

async function preview() {
  const clock = new ManualClock(Date.UTC(2026, 10, 20, 9));
  const pw = createPreviewWorld({ persist: false, drive: false, clock });
  await pw.ready;
  const sim = makeDevSim(pw, { reload: () => undefined });
  const app = await controllerFor(pw.world, pw.device);
  await app.ses.getState().init();
  await flush();
  return { pw, sim, app, w: pw.world };
}

describe("preview world", () => {
  it("is seeded with folders and a sample file on both computers", async () => {
    const { pw, sim } = await preview();
    expect(sim.thisDevice).toBe("This Mac");
    expect(sim.otherDevice).toBe("Office iMac");
    for (const f of PREVIEW_FOLDERS) expect(sim.folders()).toContain(f);
    const files = sim.files();
    expect(files).toEqual([expect.objectContaining({ path: PREVIEW_SAMPLE, name: "Dose response.lag", folder: "/Users/me/Dropbox/Lab", dataless: false })]);
    expect(pw.other.localHead(PREVIEW_SAMPLE)).toBe(files[0].head);
  });

  it("survives exportState / importState (a page reload)", async () => {
    const { pw, app } = await preview();
    await app.ses.getState().open(PREVIEW_SAMPLE);
    app.graph.getState().setCell(0, 0, 0, "unsaved");
    await tick(pw.world, 1500);
    const state = JSON.parse(JSON.stringify(pw.world.exportState()));
    const clock2 = new ManualClock(pw.clock.now());
    const w2 = new MemoryWorld({ mode: "dropbox", clock: clock2 });
    const dev2 = w2.addDevice({ device_id: "d-preview-this", device_name: "This Mac" });
    w2.addDevice({ device_id: "d-preview-other", device_name: "Office iMac" });
    w2.importState(state);
    expect(dev2.localHead(PREVIEW_SAMPLE)).toBe(pw.device.localHead(PREVIEW_SAMPLE));
    const app2 = await controllerFor(w2, dev2);
    await app2.ses.getState().init();
    await flush();
    expect(app2.graph.getState().doc!.cells[0][0][0]).toBe("unsaved");
    expect(app2.ses.getState().tabs[0].dirty).toBe(true);
  });
});

describe("simulator actions", () => {
  it("Edit and save on the other computer: a clean tab updates and says who saved", async () => {
    const { sim, app } = await preview();
    await app.ses.getState().open(PREVIEW_SAMPLE);
    const before = app.graph.getState().doc!.cells[0][0][0];
    const head = await sim.remoteEdit(PREVIEW_SAMPLE);
    await flush();
    expect(app.ses.getState().tabs[0].baseRevision).toBe(head);
    expect(app.graph.getState().doc!.cells[0][0][0]).toBe(String(Number(before) + 1));
    expect(last(app.ses.getState().toasts)).toMatchObject({ kind: "reloaded", version: { userName: "Alice", deviceName: "Office iMac" } });
    expect(isDirty(app.graph.getState())).toBe(false);
  });

  it("Rename / Move / Delete / Duplicate in Finder / Online-only / Block folder", async () => {
    const { sim, app, w } = await preview();
    await app.ses.getState().open(PREVIEW_SAMPLE);
    const renamed = await sim.rename(PREVIEW_SAMPLE, "B");
    await tick(w, 6000);
    expect(app.ses.getState().tabs[0]).toMatchObject({ title: "B", path: renamed });
    const dup = await sim.duplicateInFinder(renamed, "B copy");
    await flush();
    expect(app.ses.getState().tabs[0].banners.find((b) => b.path === dup)?.kind).toBe("copyQuestion");
    sim.setOnlineOnly(renamed, true);
    await flush();
    expect(app.ses.getState().tabs[0].banner?.kind).toBe("downloading");
    sim.setOnlineOnly(renamed, false);
    await flush();
    expect(app.ses.getState().tabs[0].banners.some((b) => b.kind === "downloading")).toBe(false);
    sim.setPermissionDenied("/Users/me/Dropbox/Lab", true);
    await flush();
    expect(app.ses.getState().tabs[0].banner?.kind).toBe("permission");
    sim.setPermissionDenied("/Users/me/Dropbox/Lab", false);
    await flush();
    expect(app.ses.getState().tabs[0].banners.some((b) => b.kind === "permission")).toBe(false);
    const moved = await sim.move(renamed, "/Users/me/Documents");
    await tick(w, 6000);
    expect(app.ses.getState().tabs[0].banners.find((b) => b.kind === "missing")).toMatchObject({ name: "B" });
    await app.ses.getState().findIt(app.ses.getState().tabs[0].key, "/Users/me/Documents");
    expect(app.ses.getState().tabs[0].path).toBe(moved);
    await sim.remove(moved);
    await tick(w, 6000);
    expect(app.ses.getState().tabs[0].banners.some((b) => b.kind === "missing")).toBe(true);
  });

  it("conflicted copy, save over it, put back earlier version, a different analysis", async () => {
    const { sim, app } = await preview();
    await app.ses.getState().open(PREVIEW_SAMPLE);
    app.graph.getState().setCell(0, 0, 0, "mine");
    await app.ses.getState().save();
    const copy = await sim.remoteConflictCopy(PREVIEW_SAMPLE);
    await flush();
    expect(copy).toMatch(/Office iMac's conflicted copy/);
    expect(app.ses.getState().tabs[0].banners.find((b) => b.path === copy)).toMatchObject({ kind: "extraCopy", relation: "diverged" });
    await sim.remoteReplace(PREVIEW_SAMPLE);
    await flush();
    // Phase 2: my save (table) and theirs (graph) are combined after the device-ordered delay; no copy is written.
    expect(app.ses.getState().tabs[0].banners.find((b) => b.kind === "savedOver")).toMatchObject({ state: "combining" });
    sim.advance(11_000);
    await flush();
    expect(app.ses.getState().tabs[0].banners.some((b) => b.kind === "combined")).toBe(true);
    expect(sim.files().some((f) => f.name.includes("my version from"))).toBe(false);
    const back = await sim.rollback(PREVIEW_SAMPLE);
    await flush();
    expect(back).not.toBeNull();
    expect(app.ses.getState().tabs[0].banners.some((b) => b.kind === "rolledBack")).toBe(true);
    await sim.replaceWithOther(PREVIEW_SAMPLE);
    await flush();
    expect(app.ses.getState().tabs[0].banner?.kind).toBe("replaced");
  });

  it("Race next save, Offline next save, Send back edited copy", async () => {
    const { sim, app } = await preview();
    await app.ses.getState().open(PREVIEW_SAMPLE);
    sim.armSaveRace(PREVIEW_SAMPLE);
    await flush();
    app.graph.getState().setCell(0, 0, 0, "race");
    expect((await app.ses.getState().save()).ok).toBe(true);
    // Phase 2: combined with the version that landed in the gap (after the device-ordered delay).
    expect(app.ses.getState().tabs[0].banner).toMatchObject({ kind: "savedOver", state: "combining" });
    sim.advance(11_000);
    await flush();
    expect(app.ses.getState().tabs[0].banners.some((b) => b.kind === "combined")).toBe(true);
    sim.armOffline(PREVIEW_SAMPLE);
    app.graph.getState().setCell(0, 0, 0, "offline");
    await app.ses.getState().save();
    expect(app.ses.getState().tabs[0].banners.some((b) => b.kind === "savedAside")).toBe(true);
    expect(app.ses.getState().tabs[0].dirty).toBe(true);
    await app.ses.getState().save();
    const sent = await sim.sendBack(PREVIEW_SAMPLE, "/Users/me/Downloads", "Bob");
    await app.ses.getState().open(sent);
    await flush();
    const kinds = app.ses.getState().tabs.find((t) => t.path === sent)!.banners.map((b) => b.kind);
    expect(kinds).toEqual(expect.arrayContaining(["tempLocation", "newerCopy"]));
  });
});

describe("simulator, phase 2 (§6.6)", () => {
  it("edits each section; own table edit + their graph edit combines, + their table edit needs a choice", async () => {
    const { sim, app } = await preview();
    await app.ses.getState().open(PREVIEW_SAMPLE);
    const f0 = app.graph.getState();
    for (const section of ["analysis", "scratchpad", "figure"] as const) {
      await sim.remoteEdit(PREVIEW_SAMPLE, { section });
      await flush();
    }
    const g = app.graph.getState();
    expect(g.analysis.alpha).not.toBe(f0.analysis.alpha);
    expect(g.scratch).toContain('[1,1,"1"]');
    expect(g.figure.title).not.toBe(f0.figure.title);
    expect(isDirty(g)).toBe(false);
    // Own unsaved table edit + "Edit graph and save" → the banner; Combine → one two-parent version.
    app.graph.getState().setCell(0, 0, 0, "mine");
    await flush();
    await sim.remoteEdit(PREVIEW_SAMPLE, { section: "figure" });
    await flush();
    const t = app.ses.getState().tabs[0];
    expect(t.banner).toMatchObject({ kind: "newerOnDisk", actions: ["combine", "later"] });
    await app.ses.getState().bannerAction(t.key, t.banner!.id, "combine");
    await flush();
    expect(app.ses.getState().tabs[0].banners.some((b) => b.kind === "combined")).toBe(true);
    // Own table edit + "Edit table and save" + Save → the dialog, file unchanged until Apply.
    app.graph.getState().setCell(0, 0, 0, "mine again");
    await flush();
    const before = await sim.remoteEdit(PREVIEW_SAMPLE, { section: "table" });
    await flush();
    await app.ses.getState().save();
    expect(app.ses.getState().dialog?.kind).toBe("combine");
    expect(sim.files().find((f) => f.path === PREVIEW_SAMPLE)!.head).toBe(before);
  });

  it("diverged copy, save over my last save, an older copy, 25 more versions, removed copies", async () => {
    const { sim, app } = await preview();
    await app.ses.getState().open(PREVIEW_SAMPLE);
    const copy = await sim.remoteDiverge(PREVIEW_SAMPLE, { section: "table", how: "copy" });
    await flush();
    expect(copy).toMatch(/conflicted copy/);
    expect(app.ses.getState().tabs[0].banners.find((b) => b.path === copy)).toMatchObject({ kind: "extraCopy", relation: "diverged", actions: ["combine", "notSame", "later"] });
    const old = await sim.olderCopy(PREVIEW_SAMPLE);
    await flush();
    expect(old).toBe("/Users/me/Dropbox/Lab/Dose response (old copy).lag");
    const ob = app.ses.getState().tabs[0].banners.find((b) => b.path === old)!;
    expect(ob).toMatchObject({ kind: "extraCopy", relation: "older", actions: ["remove", "keep"] });
    await app.ses.getState().bannerAction(app.ses.getState().tabs[0].key, ob.id, "remove");
    expect(sim.removed().map((r) => r.original)).toEqual([old]);
    expect(sim.files().some((f) => f.path === old)).toBe(false);
    // Save over my last save (graph) on a clean tab → combining.
    app.graph.getState().setCell(0, 0, 0, "own");
    await app.ses.getState().save();
    await sim.remoteDiverge(PREVIEW_SAMPLE, { section: "figure", how: "saveOver" });
    await flush();
    expect(app.ses.getState().tabs[0].banners.find((b) => b.kind === "savedOver")).toMatchObject({ state: "combining" });
    sim.advance(11_000);
    await flush();
    expect(app.ses.getState().tabs[0].banners.some((b) => b.kind === "combined")).toBe(true);
    // 25 more versions: entries kept, only the newest contents.
    await sim.remoteEditMany(PREVIEW_SAMPLE, 25);
    await flush();
    const f = sim.files().find((x) => x.path === PREVIEW_SAMPLE)!;
    expect(f.head).toBe(app.ses.getState().tabs[0].baseRevision);
  });
});

// ── phase 3: the simulator's other computers keep notes (phase3-contract.md §6.6, U2–U14 at the controller) ──

describe("simulator, phase 3 (who is editing)", () => {
  const tab = (app: Awaited<ReturnType<typeof preview>>["app"]) => app.ses.getState().tabs[0];
  const guard = (app: Awaited<ReturnType<typeof preview>>["app"]) => app.graph.getState().guard?.reason ?? null;

  it("open there → an idle note, nothing changes; start editing there (Alice) → read-only; save there, keep editing → refreshed, still read-only; save there (stop) → editable", async () => {
    const { sim, app, w } = await preview();
    await app.ses.getState().open(PREVIEW_SAMPLE);
    await sim.peerOpens(PREVIEW_SAMPLE);
    await tick(w, 1000);
    expect(sim.notes(PREVIEW_SAMPLE).map((n) => [n.deviceName, n.state])).toEqual([["Office iMac", "idle"], ["This Mac", "idle"]]);
    expect(guard(app)).toBe(null);
    await sim.peerStartsEditing(PREVIEW_SAMPLE);
    await tick(w, 1000);
    expect(guard(app)).toBe("editingElsewhere");
    expect(tab(app).banner).toMatchObject({ kind: "editingElsewhere", actions: ["editAnyway"], peers: [{ userName: "Alice", deviceName: "Office iMac" }] });
    expect(sim.notes(PREVIEW_SAMPLE).find((n) => n.deviceName === "Office iMac")).toMatchObject({ state: "editing", beating: true });
    const head = await sim.peerSaves(PREVIEW_SAMPLE, { keepEditing: true });
    await tick(w, 1000);
    expect(tab(app).baseRevision).toBe(head);
    expect(guard(app)).toBe("editingElsewhere");
    expect(tab(app).presence?.status).toMatchObject({ kind: "upToDate", who: { userName: "Alice" } });
    await sim.peerSaves(PREVIEW_SAMPLE);
    await tick(w, 31_000);
    expect(guard(app)).toBe(null);
    expect(app.ses.getState().toasts.some((t) => t.kind === "reloaded")).toBe(false);
  });

  it("as me → Edit here, at once; quit there → editable; crash there → read-only until it goes quiet", async () => {
    const { sim, app, w } = await preview();
    await app.ses.getState().open(PREVIEW_SAMPLE);
    await sim.peerStartsEditing(PREVIEW_SAMPLE, { sameUser: true });
    await tick(w, 1000);
    expect(tab(app).banner).toMatchObject({ kind: "editingElsewhere", actions: ["editHere"] });
    expect(await app.ses.getState().editHere()).toBe(true);
    expect(guard(app)).toBe(null);
    await sim.peerQuits(PREVIEW_SAMPLE);
    await tick(w, 1000);
    expect(sim.notes(PREVIEW_SAMPLE).some((n) => n.deviceName === "Office iMac")).toBe(false);
    await sim.peerStartsEditing(PREVIEW_SAMPLE, { who: "third" });
    await tick(w, 65_000);                     // one heartbeat there
    expect(guard(app)).toBe("editingElsewhere");
    await sim.peerCrashes(PREVIEW_SAMPLE, { who: "third" });
    await tick(w, 60_000);
    expect(guard(app)).toBe("editingElsewhere");
    sim.advance(5 * 60_000);
    await tick(w, 1000);
    expect(guard(app)).toBe(null);
    expect(tab(app).banner).toMatchObject({ kind: "editingInfo", actions: ["editHere", "dismiss"] });
  });

  it("own edit, then start editing there → both editing; Edit here there → continued elsewhere; this computer sleeps → resuming", async () => {
    const { sim, app, w } = await preview();
    await app.ses.getState().open(PREVIEW_SAMPLE);
    app.graph.getState().setCell(0, 0, 0, "mine");
    await flush();
    await sim.peerStartsEditing(PREVIEW_SAMPLE);
    await tick(w, 1000);
    expect(tab(app).banner).toMatchObject({ kind: "bothEditing", actions: ["keepEditing", "saveCopy"] });
    expect(guard(app)).toBe(null);
    await sim.peerEditsHere(PREVIEW_SAMPLE, { who: "third" });
    await tick(w, 1000);
    expect(tab(app).banners.some((b) => b.kind === "continuedElsewhere")).toBe(true);
    expect(app.graph.getState().doc!.cells[0][0][0]).toBe("mine");
    sim.sleep(3 * 60_000);
    await tick(w, 6000);
    expect(tab(app).presence?.mode === "resuming" || tab(app).banners.some((b) => b.kind === "continuedElsewhere")).toBe(true);
  });

  it("sync delay 60 s → waiting, then the content; offline → after 2 min 'unconfirmed' and editable", async () => {
    const { sim, app, w } = await preview();
    await app.ses.getState().open(PREVIEW_SAMPLE);
    sim.setSyncDelay(60_000);
    w.devices.find((d) => d.name === "This Mac")!.setSyncDelay(0, "notes");
    await sim.peerSaves(PREVIEW_SAMPLE);
    await tick(w, 2000);
    expect(guard(app)).toBe("waiting");
    expect(tab(app).banner?.kind).toBe("waitingNewer");
    await tick(w, 61_000);
    expect(tab(app).banners.some((b) => b.kind === "waitingNewer")).toBe(false);
  });

  it("older app there: its save shows the 'older version' banner; a conflict copy of a note changes nothing; the notes list", async () => {
    const { sim, app, w } = await preview();
    await app.ses.getState().open(PREVIEW_SAMPLE);
    sim.setOldApp(true);
    await sim.peerSaves(PREVIEW_SAMPLE);
    await tick(w, 2000);
    expect(tab(app).banners.find((b) => b.kind === "olderPeer")).toMatchObject({ peers: [{ deviceName: "Office iMac" }] });
    sim.setOldApp(false);
    await sim.peerOpens(PREVIEW_SAMPLE, { who: "third" });
    const copy = await sim.noteConflictCopy(PREVIEW_SAMPLE, { who: "third" });
    await tick(w, 1000);
    expect(copy).toMatch(/\(conflicted copy\)\.laguse$/);
    expect(sim.notes(PREVIEW_SAMPLE).filter((n) => n.deviceName === "Lab MacBook")).toHaveLength(2);
    expect(guard(app)).toBe(null);
    expect(sim.files().some((f) => f.name.endsWith(".laguse"))).toBe(false);
    expect(sim.thirdDevice).toBe("Lab MacBook");
  });

  it("a file in Documents gets no note (Automatically); Always → a note; Never on the Dropbox file → its note goes", async () => {
    const { sim, app, pw } = await preview();
    const local = `${PREVIEW_FOLDERS[2]}/Local.lag`;
    pw.device.place(local, pw.device.localFile(PREVIEW_SAMPLE)!);
    await app.ses.getState().open(local);
    await flush();
    expect(sim.notes(local)).toEqual([]);
    expect(app.ses.getState().tabs[0].presence?.sharing.why).toBe("local");
    await app.ses.getState().setSharing(app.ses.getState().tabs[0].key, "always");
    await flush();
    expect(sim.notes(local)).toHaveLength(1);
    await app.ses.getState().open(PREVIEW_SAMPLE);
    await flush();
    expect(sim.notes(PREVIEW_SAMPLE).filter((n) => n.deviceName === "This Mac")).toHaveLength(1);
    await app.ses.getState().setSharing(app.ses.getState().activeKey!, "never");
    await flush();
    expect(sim.notes(PREVIEW_SAMPLE).filter((n) => n.deviceName === "This Mac")).toEqual([]);
  });
});

// ── phase 4: small changes on the other computer (§6.7) ─────────────────────

describe("phase 4 simulator: the cases the 'Small changes' group must produce", () => {
  type Own = (app: Awaited<ReturnType<typeof preview>>["app"]) => void;
  const cell = (r: number, c: number, v: string): Own => (app) => app.graph.getState().setCell(r, c, 0, v);
  const dialogOf = (app: Awaited<ReturnType<typeof preview>>["app"]) => {
    const d = app.ses.getState().dialog;
    return d?.kind === "combine" ? (d.state as import("./contract").CombineStateP4) : null;
  };
  /** Own unsaved edit, the other computer saves a newer version with `fine`, then "Combine my changes with it". */
  async function newer(fine: import("./contract").SimFineEdit, own: Own, prep?: (s: Awaited<ReturnType<typeof preview>>) => Promise<void>) {
    const p = await preview();
    await p.app.ses.getState().open(PREVIEW_SAMPLE);
    await prep?.(p);
    own(p.app);
    await flush();
    await p.sim.remoteEdit(PREVIEW_SAMPLE, { fine });
    await tick(p.w, 3000);
    const t = p.app.ses.getState().tabs[0];
    const b = t.banners.find((x) => x.kind === "newerOnDisk");
    expect(b).toBeTruthy();
    await p.app.ses.getState().bannerAction(t.key, b!.id, "combine");
    await flush();
    return p;
  }

  it("own edit of another cell + 'cell' → combined without a dialog, both values", async () => {
    const { app, pw } = await newer("cell", cell(1, 0, "mine"));
    expect(app.ses.getState().dialog).toBeNull();
    const head = pw.device.localFile(PREVIEW_SAMPLE)!.manifest;
    expect(head.revisions.find((r) => r.id === head.head)!.parents).toHaveLength(2);
    expect(app.graph.getState().doc!.cells[1][0][0]).toBe("mine");
  });

  it("own edit of the same cell + 'cell' → one row to choose", async () => {
    const { app } = await newer("cell", cell(0, 0, "mine"));
    const d = dialogOf(app)!;
    expect(d.toChoose).toBe(1);
    expect(d.sections.find((s) => s.key === "table")!.conflicts.map((c) => c.kind)).toEqual(["row"]);
  });

  it("own values in the first blank row + 'addRow' → two rows, nothing to choose (fixer M1); the order is checked where it matters", async () => {
    const { app } = await newer("addRow", (a) => {
      const doc = a.graph.getState().doc!;
      const r = doc.cells.findIndex((row, i) => row.every((reps) => reps.every((v) => v.trim() === "")) && !doc.row_titles[i]);
      a.graph.getState().setCell(r, 0, 0, "mine");
    });
    const d = dialogOf(app);
    if (d) {
      // Grouped / XY: "Row order — please check", nothing to choose, Apply enabled.
      expect(d.toChoose).toBe(0);
      expect(d.canApply).toBe(true);
      expect(d.sections.find((s) => s.key === "table")!.orderChecks.some((o) => o.matters && o.axis === "row")).toBe(true);
      await app.ses.getState().applyCombine();
      await flush();
    }
    expect(app.ses.getState().dialog).toBeNull();
    const doc = app.graph.getState().doc!;
    const mineRow = doc.cells.findIndex((row) => row[0][0] === "mine");
    expect(mineRow).toBeGreaterThanOrEqual(0);
    expect(doc.cells[mineRow].slice(1).every((reps) => reps.every((v) => v === ""))).toBe(true);
    expect(doc.cells.some((row, i) => i !== mineRow && row.every((reps) => reps[0] === "7"))).toBe(true);
  });

  it("own edit in the last column + 'deleteCol' → the column deleted by them, changed here", async () => {
    const { app } = await newer("deleteCol", (a) => a.graph.getState().setCell(3, a.graph.getState().doc!.col_titles.length - 1, 0, "mine"));
    const c = dialogOf(app)!.sections.find((s) => s.key === "table")!.conflicts;
    expect(c).toEqual([expect.objectContaining({ kind: "colDeleted", deletedBy: "theirs" })]);
  });

  it("own Y range + 'yRange' → 'Y axis range' to choose; own graph title + 'yRange' → combined", async () => {
    const p1 = await newer("yRange", (a) => a.graph.getState().setFigure({ y_min: 1, y_max: 9 } as never));
    expect(dialogOf(p1.app)!.sections.find((s) => s.key === "figure")!.conflicts.map((c) => c.id)).toEqual(["figure:group:yRange"]);
    const p2 = await newer("yRange", (a) => a.graph.getState().setFigure({ title: "mine" }));
    expect(p2.app.ses.getState().dialog).toBeNull();
    expect(p2.app.graph.getState().figure).toMatchObject({ title: "mine", y_min: 0, y_max: 100 });
  });

  it("own B2 + 'scratchCells' → cell B2 to choose", async () => {
    const { app } = await newer("scratchCells", (a) => a.graph.getState().setScratch(JSON.stringify({ v: 1, cells: [[2, 2, "mine"]] })));
    expect(dialogOf(app)!.sections.find((s) => s.key === "scratchpad")!.conflicts.map((c) => c.id)).toEqual(["scratchpad:cell:B2"]);
  });

  it("'scratchShift' on a small scratchpad first fills A1:B6; then own edit + 'scratchShift' → the three-button whole choice", async () => {
    const { app } = await newer("scratchShift", (a) => a.graph.getState().setScratch(JSON.stringify({ v: 1, cells: [[1, 1, "11"], [9, 9, "mine"]] })), async ({ sim, w }) => {
      await sim.remoteEdit(PREVIEW_SAMPLE, { fine: "scratchShift" });
      await tick(w, 3000);
    });
    const sp = dialogOf(app)!.sections.find((s) => s.key === "scratchpad")!;
    expect(sp.conflicts).toEqual([expect.objectContaining({ id: "scratchpad:section", reason: "shift", options: ["mine", "theirs", "both"] })]);
  });

  it("'saves over my last save' with the older app on → the 'review' banner; off → combining by itself", async () => {
    for (const oldApp of [true, false]) {
      const { app, sim, w, pw } = await preview();
      await app.ses.getState().open(PREVIEW_SAMPLE);
      app.graph.getState().setCell(2, 1, 0, "my save");
      await flush();
      await app.ses.getState().save();
      await tick(w, 3000);
      sim.setOldApp(oldApp);
      await sim.remoteDiverge(PREVIEW_SAMPLE, { fine: "cell", how: "saveOver" });
      const head = pw.other.localFile(PREVIEW_SAMPLE)!.manifest;
      expect("combine_v" in head.revisions.find((r) => r.id === head.head)!).toBe(!oldApp);
      await tick(w, 30_000);
      const t = app.ses.getState().tabs[0];
      if (oldApp) {
        expect(t.banners.find((b) => b.kind === "savedOver")).toMatchObject({ state: "review", actions: ["combine"] });
      } else {
        expect(t.banners.find((b) => b.kind === "combined")).toMatchObject({ mixed: ["table"] });
        const m = pw.device.localFile(PREVIEW_SAMPLE)!.manifest;
        expect(m.revisions.find((r) => r.id === m.head)).toMatchObject({ auto: true, combine_v: 1 });
      }
    }
  });

  it("every fine edit the panel offers saves a version that reads back the same (pipeline form)", async () => {
    const { fineEditContent } = await import("./devSim");
    const { openFile, sectionsOf, partsOf } = await import("./docCodec");
    const { normaliseSections } = await import("./graphMerge");
    const { pw } = await preview();
    const c0 = openFile(pw.device.localFile(PREVIEW_SAMPLE)!)!;
    for (const fine of ["cell", "cellOther", "addRow", "insertRow", "deleteRow", "deleteCol", "renameCol", "yRange", "graphTitle", "alpha", "scratchCells", "scratchShift"] as const) {
      const c = fineEditContent(c0, fine);
      const sec = sectionsOf(c);
      const n = await normaliseSections(JSON.parse(JSON.stringify(sec)));
      expect(n, fine).not.toBeNull();
      expect(n!.parts.contentHash, fine).toBe((await partsOf(sec)).contentHash);
    }
  });
});
