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
    expect(app.ses.getState().tabs[0].banners.some((b) => b.kind === "savedOver")).toBe(true);
    expect(sim.files().some((f) => f.name === "Dose response (my version from This Mac).lag")).toBe(true);
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
    expect(app.ses.getState().tabs[0].banner?.kind).toBe("savedDisplaced");
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
