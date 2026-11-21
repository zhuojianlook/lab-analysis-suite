import { describe, expect, it } from "vitest";
import { isDirty } from "../../../store/graphStore";
import { LIMITS } from "./contract";
import {
  DBX, DOCS, computer, contentAt, firstCell, flush, makeWorld, seedFile, start, tick, withAnswer,
} from "./testkit";

const last = <T>(a: readonly T[]): T | undefined => a[a.length - 1];

const P = `${DBX}/Dose response.lag`;

describe("open / save / reopen", () => {
  it("a new document saved to a file, edited, saved again, nothing written when unchanged, clean after restart", async () => {
    const w = makeWorld();
    const a = await start(await computer(w, { device_id: "d-a", device_name: "Mac mini" }));
    const s = a.ses.getState();
    expect(s.ready).toBe(true);
    const o = await s.newDoc("column", true);
    expect(o.ok).toBe(true);
    expect(a.ses.getState().tabs[0].title).toBe("Untitled");
    expect(a.ses.getState().tabs[0].dirty).toBe(false);
    a.picks.push(`${DOCS}/A`);
    const r = await a.ses.getState().save();
    expect(r).toEqual({ ok: true, path: `${DOCS}/A.lag` });
    let t = a.ses.getState().tabs[0];
    expect(t).toMatchObject({ title: "A", path: `${DOCS}/A.lag`, folderLabel: "Documents", dirty: false });
    expect(a.dev.localHead(`${DOCS}/A.lag`)).toBe(t.baseRevision);
    expect(isDirty(a.graph.getState())).toBe(false);
    expect(a.graph.getState().file).toMatchObject({ path: `${DOCS}/A.lag`, docKey: t.key });

    a.graph.getState().setCell(0, 0, 0, "99");
    await flush();
    expect(a.ses.getState().tabs[0].dirty).toBe(true);
    const r2 = await a.ses.getState().save();
    expect(r2.ok).toBe(true);
    t = a.ses.getState().tabs[0];
    expect(t.dirty).toBe(false);
    expect(firstCell(contentAt(a.dev, `${DOCS}/A.lag`))).toBe("99");
    const head2 = a.dev.localHead(`${DOCS}/A.lag`);
    const saves = a.dev.saves.length;
    expect((await a.ses.getState().save()).ok).toBe(true);
    expect(a.dev.saves.length).toBe(saves);                 // nothing written
    expect(a.dev.localHead(`${DOCS}/A.lag`)).toBe(head2);

    const a2 = await a.restart();
    const t2 = a2.ses.getState().tabs[0];
    expect(t2).toMatchObject({ path: `${DOCS}/A.lag`, dirty: false, status: "ready" });
    expect(a2.ses.getState().activeKey).toBe(t2.key);
    expect(isDirty(a2.graph.getState())).toBe(false);
    expect(firstCell({ doc: a2.graph.getState().doc! } as never)).toBe("99");
    expect(a2.ses.getState().toasts.some((x) => x.kind === "restoredDrafts")).toBe(false);
  });

  it("opening a file never makes the tab dirty; Recent lists it", async () => {
    const w = makeWorld();
    const a = await start(await computer(w, { device_id: "d-a", device_name: "Mac mini" }));
    await seedFile(w, a.dev, P);
    const o = await a.ses.getState().open(P);
    expect(o.ok).toBe(true);
    await tick(w, 5000);
    const s = a.ses.getState();
    expect(s.tabs[0]).toMatchObject({ title: "Dose response", folderLabel: "Dropbox › Lab", dirty: false, status: "ready", service: "Dropbox" });
    expect(isDirty(a.graph.getState())).toBe(false);
    expect(s.recent[0]).toMatchObject({ path: P, name: "Dose response", open: true });
    const again = await a.ses.getState().open(P);
    expect(again).toEqual({ ok: true, key: s.tabs[0].key });
    expect(a.ses.getState().toasts.some((x) => x.kind === "alreadyOpen")).toBe(true);
  });

  it("closing a tab with unsaved changes asks: cancel keeps it, discard drops the changes", async () => {
    const w = makeWorld();
    const a = await start(await computer(w, { device_id: "d-a", device_name: "Mac mini" }));
    await seedFile(w, a.dev, P);
    await a.ses.getState().open(P);
    a.graph.getState().setCell(0, 0, 0, "7");
    await tick(w, 1500);
    const key = a.ses.getState().activeKey!;
    expect(await a.dev.readDraft(key)).not.toBeNull();
    expect(await withAnswer(a, () => a.ses.getState().closeTab(), { kind: "closeDirty", choice: "cancel" })).toBe(false);
    expect(a.ses.getState().tabs).toHaveLength(1);
    expect(await withAnswer(a, () => a.ses.getState().closeTab(), { kind: "closeDirty", choice: "discard" })).toBe(true);
    expect(a.ses.getState().tabs).toHaveLength(0);
    expect(await a.dev.readDraft(key)).toBeNull();
    expect(a.graph.getState().doc).toBeNull();
  });

  it("caps tabs at 12", async () => {
    const w = makeWorld();
    const a = await start(await computer(w, { device_id: "d-a", device_name: "Mac mini" }));
    for (let i = 0; i < LIMITS.tabCap; i++) expect((await a.ses.getState().newDoc("column")).ok).toBe(true);
    expect(await a.ses.getState().newDoc("column")).toEqual({ ok: false, reason: "limit" });
    expect(last(a.ses.getState().toasts)?.kind).toBe("tabLimit");
    expect(a.ses.getState().tabs.map((t) => t.title).slice(0, 3)).toEqual(["Untitled", "Untitled 2", "Untitled 3"]);
  });
});

const A = `${DOCS}/A.lag`;
const B = `${DOCS}/B.lag`;
const C = `${DOCS}/C.lag`;

async function oneComputer() {
  const w = makeWorld();
  const a = await start(await computer(w, { device_id: "d-a", device_name: "Mac mini" }));
  return { w, a };
}

describe("tabs: one document in memory", () => {
  it("switching keeps each tab's unsaved changes; the store holds only the active one", async () => {
    const { w, a } = await oneComputer();
    for (const p of [A, B, C]) await seedFile(w, a.dev, p);
    const ka = (await a.ses.getState().open(A) as { key: string }).key;
    const kb = (await a.ses.getState().open(B) as { key: string }).key;
    const kc = (await a.ses.getState().open(C) as { key: string }).key;
    a.graph.getState().setCell(0, 0, 0, "c1");
    await a.ses.getState().switchTab(ka);
    expect(a.graph.getState().file?.docKey).toBe(ka);
    a.graph.getState().setCell(0, 0, 0, "a1");
    await a.ses.getState().switchTab(kb);
    expect(a.graph.getState().file?.docKey).toBe(kb);
    expect(isDirty(a.graph.getState())).toBe(false);
    await a.ses.getState().switchTab(kc);
    expect(a.graph.getState().doc!.cells[0][0][0]).toBe("c1");
    expect(isDirty(a.graph.getState())).toBe(true);
    await a.ses.getState().switchTab(ka);
    expect(a.graph.getState().doc!.cells[0][0][0]).toBe("a1");
    const dirty = Object.fromEntries(a.ses.getState().tabs.map((t) => [t.title, t.dirty]));
    expect(dirty).toEqual({ A: true, B: false, C: true });
    // Files on disk are untouched.
    expect(firstCell(contentAt(a.dev, A))).not.toBe("a1");
    // Saving a background tab saves its unsaved changes from its draft.
    expect((await a.ses.getState().save(kc)).ok).toBe(true);
    expect(firstCell(contentAt(a.dev, C))).toBe("c1");
    expect(a.ses.getState().tabs.find((t) => t.key === kc)!.dirty).toBe(false);
    expect(await a.dev.readDraft(kc)).toBeNull();
    expect(a.graph.getState().file?.docKey).toBe(ka);
  });

  it("closing the active tab activates its right neighbour, else the left one, else the start screen", async () => {
    const { w, a } = await oneComputer();
    for (const p of [A, B, C]) await seedFile(w, a.dev, p);
    for (const p of [A, B, C]) await a.ses.getState().open(p);
    const [ka, kb, kc] = a.ses.getState().tabs.map((t) => t.key);
    await a.ses.getState().switchTab(kb);
    await a.ses.getState().closeTab();
    expect(a.ses.getState().activeKey).toBe(kc);
    await a.ses.getState().closeTab();
    expect(a.ses.getState().activeKey).toBe(ka);
    await a.ses.getState().closeTab();
    expect(a.ses.getState().activeKey).toBeNull();
    expect(a.graph.getState().doc).toBeNull();
    expect((await a.dev.readSession()).tabs).toEqual([]);
  });

  it("showStart keeps the tabs; New from the menu shows the start screen", async () => {
    const { w, a } = await oneComputer();
    await seedFile(w, a.dev, A);
    await a.ses.getState().open(A);
    await a.ses.getState().menu("file.new");
    expect(a.ses.getState().activeKey).toBeNull();
    expect(a.ses.getState().tabs).toHaveLength(1);
    expect(a.ses.getState().focusSerial).toBe(1);
  });
});

describe("drafts and restoring the last session", () => {
  it("restores titled and untitled unsaved work after a restart, with the active tab last", async () => {
    const { w, a } = await oneComputer();
    await seedFile(w, a.dev, A);
    await a.ses.getState().open(A);
    a.graph.getState().setCell(0, 0, 0, "fileEdit");
    await a.ses.getState().newDoc("grouped", true);
    a.graph.getState().setCell(0, 0, 0, "untitledEdit");
    await tick(w, 1500);                         // the debounced draft
    const a2 = await a.restart();
    const s = a2.ses.getState();
    expect(s.tabs.map((t) => t.title)).toEqual(["A", "Untitled (recovered)"]);
    expect(s.activeKey).toBe(s.tabs[1].key);
    expect(a2.graph.getState().doc!.cells[0][0][0]).toBe("untitledEdit");
    expect(a2.graph.getState().doc!.template).toBe("grouped");
    expect(isDirty(a2.graph.getState())).toBe(true);
    expect(s.tabs.every((t) => t.banners.some((b) => b.kind === "recovered"))).toBe(true);
    expect(s.toasts.find((x) => x.kind === "restoredDrafts")?.count).toBe(2);
    await a2.ses.getState().switchTab(s.tabs[0].key);
    expect(a2.graph.getState().doc!.cells[0][0][0]).toBe("fileEdit");
    expect(a2.ses.getState().tabs[0].dirty).toBe(true);
    // After a save and another restart there is nothing to restore for it.
    expect((await a2.ses.getState().save()).ok).toBe(true);
    const a3 = await a2.restart();
    const t = a3.ses.getState().tabs.find((x) => x.title === "A")!;
    expect(t.dirty).toBe(false);
    expect(t.banners.some((b) => b.kind === "recovered")).toBe(false);
  });

  it("an untitled tab that was never edited is not restored", async () => {
    const { a } = await oneComputer();
    await a.ses.getState().newDoc("column", true);
    const a2 = await a.restart();
    expect(a2.ses.getState().tabs).toEqual([]);
  });

  it("a draft based on an older version: newer version banner, Save meets the conflict sheet", async () => {
    const { w, a } = await oneComputer();
    await seedFile(w, a.dev, A);
    await a.ses.getState().open(A);
    a.graph.getState().setCell(0, 0, 0, "mine");
    await tick(w, 1500);
    // Meanwhile (app not looking) the file got a newer version.
    const other = w.addDevice({ device_id: "d-x", device_name: "Office iMac", user_name: "Alice" });
    void other;
    const f = a.dev.localFile(A)!;
    const { buildNextFile } = await import("./docCodec");
    const next = await buildNextFile(f, { ...contentAt(a.dev, A)!, figure: { ...contentAt(a.dev, A)!.figure, title: "theirs" } }, {
      time: w.clock.now(), author: { user_name: "Alice", device_id: "d-x", device_name: "Office iMac", session_id: "s", app_version: "t", platform: "macos" },
    });
    a.dev.place(A, next);
    const a2 = await a.restart();
    const t = a2.ses.getState().tabs[0];
    expect(t.baseRevision).toBe(f.manifest.head);
    expect(t.banners.map((b) => b.kind)).toContain("newerOnDisk");
    expect(a2.graph.getState().doc!.cells[0][0][0]).toBe("mine");
    const r = await a2.ses.getState().save();
    expect(r).toEqual({ ok: false, reason: "conflict" });
    expect(a2.ses.getState().dialog?.kind).toBe("conflict");
  });

  it("a draft that doesn't match the file is offered, never dropped", async () => {
    const { w, a } = await oneComputer();
    await seedFile(w, a.dev, A);
    await a.ses.getState().open(A);
    const key = a.ses.getState().activeKey!;
    a.graph.getState().setCell(0, 0, 0, "orphan");
    await tick(w, 1500);
    const d = (await a.dev.readDraft(key))!;
    await a.dev.writeDraft({ ...d, base_revision: "r-not-in-this-file" });
    const a2 = await a.restart();
    const t = a2.ses.getState().tabs[0];
    const banner = t.banners.find((b) => b.kind === "draftMismatch")!;
    expect(banner).toBeTruthy();
    expect(isDirty(a2.graph.getState())).toBe(false);
    expect((await a2.dev.listDrafts()).length).toBe(1);   // kept under its own key
    await a2.ses.getState().bannerAction(t.key, banner.id, "openAsNew");
    const s = a2.ses.getState();
    expect(s.tabs.map((x) => x.title)).toEqual(["A", "A (recovered)"]);
    expect(a2.graph.getState().doc!.cells[0][0][0]).toBe("orphan");
  });

  it("restores a file renamed while the app was closed (same folder, one candidate)", async () => {
    const { w, a } = await oneComputer();
    await seedFile(w, a.dev, A);
    await a.ses.getState().open(A);
    a.dev.rename(A, `${DOCS}/A renamed.lag`);
    const a2 = await a.restart();
    expect(a2.ses.getState().tabs[0]).toMatchObject({ path: `${DOCS}/A renamed.lag`, title: "A renamed", status: "ready" });
    expect(a2.ses.getState().toasts.some((x) => x.kind === "renamed")).toBe(true);
    expect(a2.ses.getState().recent[0].path).toBe(`${DOCS}/A renamed.lag`);
  });

  it("a missing file gives the card; Remove from this list keeps its draft and marks Recent", async () => {
    const { w, a } = await oneComputer();
    await seedFile(w, a.dev, A);
    await a.ses.getState().open(A);
    a.graph.getState().setCell(0, 0, 0, "keep me");
    await tick(w, 1500);
    a.dev.remove(A);
    const a2 = await a.restart();
    const s = a2.ses.getState();
    expect(s.cards).toMatchObject([{ kind: "missing", name: "A", folderLabel: "Documents", hasDraft: true }]);
    expect(s.tabs[0].status).toBe("missing");
    expect(a2.graph.getState().doc).toBeNull();
    await a2.ses.getState().forget(s.tabs[0].key);
    expect(a2.ses.getState().tabs).toEqual([]);
    expect(a2.ses.getState().recent[0]).toMatchObject({ path: A, missing: true });
    await a2.ses.getState().openRecover();
    const d = a2.ses.getState().dialog;
    expect(d?.kind === "recover" && d.drafts.map((x) => x.name)).toEqual(["A"]);
    const o = await a2.ses.getState().recoverDraft(d?.kind === "recover" ? d.drafts[0].docKey : "");
    expect(o.ok).toBe(true);
    expect(a2.ses.getState().tabs[0].title).toBe("A (recovered)");
    expect(a2.graph.getState().doc!.cells[0][0][0]).toBe("keep me");
  });

  it("a file in a cloud folder: 'waiting' first, opens by itself when it arrives", async () => {
    const { w, a } = await oneComputer();
    const f = await seedFile(w, a.dev, P);
    await a.ses.getState().open(P);
    a.dev.remove(P);
    const a2 = await a.restart();
    expect(a2.ses.getState().cards[0]?.kind).toBe("waiting");
    await tick(w, 9000);
    expect(a2.ses.getState().cards[0]?.kind).toBe("waiting");
    a2.dev.place(P, f);
    await tick(w, 3500);
    expect(a2.ses.getState().cards).toEqual([]);
    expect(a2.ses.getState().tabs[0].status).toBe("ready");
    expect(a2.graph.getState().file?.path).toBe(P);
  });

  it("a file in a cloud folder that never arrives: the missing card after 60 s", async () => {
    const { w, a } = await oneComputer();
    await seedFile(w, a.dev, P);
    await a.ses.getState().open(P);
    a.dev.remove(P);
    const a2 = await a.restart();
    await tick(w, 61_000);
    expect(a2.ses.getState().cards[0]?.kind).toBe("missing");
  });

  it("a blocked folder gives the permission card; Retry opens once allowed", async () => {
    const { w, a } = await oneComputer();
    await seedFile(w, a.dev, A);
    await a.ses.getState().open(A);
    a.dev.setPermissionDenied(DOCS, true);
    const a2 = await a.restart();
    expect(a2.ses.getState().cards[0]?.kind).toBe("permission");
    a2.dev.setPermissionDenied(DOCS, false);
    await a2.ses.getState().retry(a2.ses.getState().tabs[0].key);
    expect(a2.ses.getState().cards).toEqual([]);
    expect(a2.graph.getState().file?.path).toBe(A);
  });
});

describe("rename, move and Find it…", () => {
  it("a live rename is followed: title, Recent and the next save use the new name", async () => {
    const { w, a } = await oneComputer();
    await seedFile(w, a.dev, A);
    await a.ses.getState().open(A);
    a.dev.rename(A, `${DOCS}/B2.lag`);
    await tick(w, 6000);
    const t = a.ses.getState().tabs[0];
    expect(t).toMatchObject({ title: "B2", path: `${DOCS}/B2.lag` });
    expect(a.ses.getState().toasts.some((x) => x.kind === "renamed" && x.name === "B2")).toBe(true);
    a.graph.getState().setCell(0, 0, 0, "after rename");
    await a.ses.getState().save();
    expect(a.dev.localPaths()).toEqual([`${DOCS}/B2.lag`]);
    expect(firstCell(contentAt(a.dev, `${DOCS}/B2.lag`))).toBe("after rename");
  });

  it("a deleted file with a Finder copy beside it is not followed: the missing banner; Find it… picks it up", async () => {
    const { w, a } = await oneComputer();
    await seedFile(w, a.dev, A);
    await a.ses.getState().open(A);
    a.dev.duplicate(A, `${DOCS}/A copy.lag`);
    await tick(w, 500);
    a.dev.remove(A);
    await tick(w, 6000);
    const t = a.ses.getState().tabs[0];
    expect(t.path).toBe(A);
    const missing = t.banners.find((b) => b.kind === "missing")!;
    expect(missing.candidates).toEqual([{ path: `${DOCS}/A copy.lag`, name: "A copy" }]);
    a.graph.getState().setCell(0, 0, 0, "still editable");
    await a.ses.getState().findIt(t.key, DOCS);
    await flush();
    expect(a.ses.getState().tabs[0].path).toBe(`${DOCS}/A copy.lag`);
    expect(a.graph.getState().doc!.cells[0][0][0]).toBe("still editable");
  });

  it("Find it…: one match is used at once, several are listed, none says so", async () => {
    const { w, a } = await oneComputer();
    const f = await seedFile(w, a.dev, A);
    await a.ses.getState().open(A);
    const key = a.ses.getState().activeKey!;
    a.dev.rename(A, `${HOME_PROJ}/sub/A.lag`);
    const a2 = await a.restart();
    expect(a2.ses.getState().cards[0]?.kind).toBe("missing");
    // none
    await a2.ses.getState().findIt(key, `${HOME}/Elsewhere`);
    let d = a2.ses.getState().dialog;
    expect(d?.kind === "find" && d.find.phase).toBe("results");
    expect(d?.kind === "find" && d.find.result?.ok && d.find.result.matches).toEqual([]);
    // several
    a2.dev.place(`${HOME_PROJ}/other/A old.lag`, f);
    await a2.ses.getState().findIt(key, HOME_PROJ);
    d = a2.ses.getState().dialog;
    expect(d?.kind === "find" && d.find.result?.ok && d.find.result.matches.map((m) => m.path).sort()).toEqual([`${HOME_PROJ}/other/A old.lag`, `${HOME_PROJ}/sub/A.lag`]);
    await a2.ses.getState().chooseFound(`${HOME_PROJ}/sub/A.lag`);
    expect(a2.ses.getState().dialog).toBeNull();
    expect(a2.ses.getState().tabs[0]).toMatchObject({ path: `${HOME_PROJ}/sub/A.lag`, status: "ready" });
    expect(a2.graph.getState().file?.path).toBe(`${HOME_PROJ}/sub/A.lag`);
    // one (after another move)
    a2.dev.rename(`${HOME_PROJ}/sub/A.lag`, `${HOME}/Final/A.lag`);
    await tick(w, 6000);
    await a2.ses.getState().findIt(key, `${HOME}/Final`);
    expect(a2.ses.getState().dialog).toBeNull();
    expect(a2.ses.getState().tabs[0].path).toBe(`${HOME}/Final/A.lag`);
    expect(a2.ses.getState().tabs[0].banners.some((b) => b.kind === "missing")).toBe(false);
  });
});

const HOME = "/Users/me";
const HOME_PROJ = `${HOME}/Projects`;

describe("Save As, Duplicate, temporary folders", () => {
  it("Save As asks new vs same; 'new' gets another analysis id (forked from this one), 'same' keeps it", async () => {
    const { w, a } = await oneComputer();
    const f = await seedFile(w, a.dev, A);
    await a.ses.getState().open(A);
    a.picks.push(`${DOCS}/A new`);
    const r = await withAnswer(a, () => a.ses.getState().saveAs(), { kind: "saveAsKind", choice: "new" });
    expect(r).toEqual({ ok: true, path: `${DOCS}/A new.lag` });
    const nf = a.dev.localFile(`${DOCS}/A new.lag`)!;
    expect(nf.manifest.analysis_id).not.toBe(f.manifest.analysis_id);
    expect(nf.manifest.forked_from).toEqual({ analysis_id: f.manifest.analysis_id, revision_id: f.manifest.head });
    expect(nf.manifest.revisions).toHaveLength(1);
    // Row / column ids are kept.
    expect(contentAt(a.dev, `${DOCS}/A new.lag`)!.doc.col_ids).toEqual(contentAt(a.dev, A)!.doc.col_ids);
    expect(a.ses.getState().tabs[0]).toMatchObject({ path: `${DOCS}/A new.lag`, title: "A new", dirty: false });
    expect(a.ses.getState().recent.map((x) => x.path)).toEqual([`${DOCS}/A new.lag`, A]);
    a.picks.push(`${DOCS}/A same.lag`);
    const r2 = await withAnswer(a, () => a.ses.getState().saveAs(), { kind: "saveAsKind", choice: "same" });
    expect(r2.ok).toBe(true);
    expect(a.dev.localFile(`${DOCS}/A same.lag`)!.manifest.analysis_id).toBe(nf.manifest.analysis_id);
    expect(a.dev.localHead(`${DOCS}/A same.lag`)).toBe(nf.manifest.head);
    const d = a.ses.getState().dialog;
    expect(d).toBeNull();
  });

  it("Save As is refused onto a file open in another tab; cancelling the picker changes nothing", async () => {
    const { w, a } = await oneComputer();
    await seedFile(w, a.dev, A);
    await seedFile(w, a.dev, B);
    await a.ses.getState().open(A);
    await a.ses.getState().open(B);
    a.picks.push(A);
    expect(await a.ses.getState().saveAs("new")).toEqual({ ok: false, reason: "failed" });
    expect(a.ses.getState().tabs[1].banners[0]?.kind).toBe("saveFailed");
    expect(await a.ses.getState().saveAs("new")).toEqual({ ok: false, reason: "cancelled" });
  });

  it("Duplicate as a new analysis opens the copy in a new tab; the original keeps its unsaved changes", async () => {
    const { w, a } = await oneComputer();
    const f = await seedFile(w, a.dev, A);
    await a.ses.getState().open(A);
    a.graph.getState().setCell(0, 0, 0, "unsaved");
    const k0 = a.ses.getState().activeKey!;
    a.picks.push(`${DOCS}/A copy.lag`);
    const r = await a.ses.getState().duplicate();
    expect(r).toEqual({ ok: true, path: `${DOCS}/A copy.lag` });
    const s = a.ses.getState();
    expect(s.tabs.map((t) => t.title)).toEqual(["A", "A copy"]);
    expect(s.activeKey).not.toBe(k0);
    expect(a.dev.localFile(`${DOCS}/A copy.lag`)!.manifest.forked_from?.analysis_id).toBe(f.manifest.analysis_id);
    expect(firstCell(contentAt(a.dev, `${DOCS}/A copy.lag`))).toBe("unsaved");
    expect(firstCell(contentAt(a.dev, A))).not.toBe("unsaved");
    await a.ses.getState().switchTab(k0);
    expect(a.graph.getState().doc!.cells[0][0][0]).toBe("unsaved");
    expect(a.ses.getState().tabs[0]).toMatchObject({ path: A, dirty: true });
  });

  it("a file in Downloads gets the temporary-folder banner; Choose where to keep it preselects 'same'", async () => {
    const { w, a } = await oneComputer();
    await seedFile(w, a.dev, `${HOME}/Downloads/Mail.lag`);
    await a.ses.getState().open(`${HOME}/Downloads/Mail.lag`);
    const t = a.ses.getState().tabs[0];
    expect(t.banner?.kind).toBe("tempLocation");
    a.picks.push(`${DOCS}/Mail.lag`);
    const p = a.ses.getState().bannerAction(t.key, t.banner!.id, "chooseLocation");
    await flush();
    const d = a.ses.getState().dialog;
    expect(d?.kind === "saveAsKind" && d.preselect).toBe("same");
    a.ses.getState().answerDialog({ kind: "saveAsKind", choice: "same" });
    await p;
    expect(a.ses.getState().tabs[0]).toMatchObject({ path: `${DOCS}/Mail.lag`, banners: [] });
  });
});

describe("copies of one analysis in a folder", () => {
  it("a Finder copy asks once; 'A separate analysis' gives it its own id", async () => {
    const { w, a } = await oneComputer();
    const f = await seedFile(w, a.dev, A);
    await a.ses.getState().open(A);
    a.dev.duplicate(A, `${DOCS}/Exp 2.lag`);
    await tick(w, 500);
    const t = a.ses.getState().tabs[0];
    const b = t.banners.find((x) => x.kind === "copyQuestion")!;
    expect(b).toMatchObject({ name: "A", path: `${DOCS}/Exp 2.lag` });
    await a.ses.getState().bannerAction(t.key, b.id, "separate");
    const copy = a.dev.localFile(`${DOCS}/Exp 2.lag`)!;
    expect(copy.manifest.analysis_id).not.toBe(f.manifest.analysis_id);
    expect(copy.manifest.forked_from).toEqual({ analysis_id: f.manifest.analysis_id, revision_id: f.manifest.head });
    // The old version of the copy is kept (moved aside), nothing is lost.
    expect((await a.dev.listDisplaced()).some((x) => x.original === `${DOCS}/Exp 2.lag` && x.head === f.manifest.head)).toBe(true);
    await tick(w, 1000);
    expect(a.ses.getState().tabs[0].banners).toEqual([]);
  });

  it("'The same analysis' leads to the extra-copy note; a conflicted copy with changes warns", async () => {
    const { w, a } = await oneComputer();
    await seedFile(w, a.dev, A);
    await a.ses.getState().open(A);
    a.dev.duplicate(A, `${DOCS}/A 2.lag`);
    await tick(w, 500);
    let t = a.ses.getState().tabs[0];
    await a.ses.getState().bannerAction(t.key, `copy:${DOCS}/A 2.lag`, "same");
    t = a.ses.getState().tabs[0];
    expect(t.banners.find((x) => x.id === `copy:${DOCS}/A 2.lag`)).toMatchObject({ kind: "extraCopy", relation: "same", actions: ["dismiss"] });
    // A newer conflicted copy.
    const { buildNextFile } = await import("./docCodec");
    const next = await buildNextFile(a.dev.localFile(A)!, { ...contentAt(a.dev, A)!, figure: { ...contentAt(a.dev, A)!.figure, title: "x" } }, {
      time: w.clock.now(), author: { user_name: "Bob", device_id: "d-b", device_name: "iMac", session_id: "s", app_version: "t", platform: "macos" },
    });
    a.dev.place(`${DOCS}/A (iMac's conflicted copy 2026-11-20).lag`, next);
    await tick(w, 500);
    t = a.ses.getState().tabs[0];
    expect(t.banners.find((x) => x.path === `${DOCS}/A (iMac's conflicted copy 2026-11-20).lag`)).toMatchObject({
      // Strictly newer: it can be taken into my file (lossless: my version is in its history).
      kind: "extraCopy", relation: "newer", actions: ["updateMine", "notSame", "later"], version: { userName: "Bob", deviceName: "iMac" },
    });
    // Nothing was removed or combined.
    expect(a.dev.localPaths().length).toBe(3);
    const a2 = await a.restart();
    // The answer is remembered: no question again for 'A 2'.
    expect(a2.ses.getState().tabs[0].banners.some((x) => x.kind === "copyQuestion")).toBe(false);
  });
});

describe("quit routine", () => {
  it("no unsaved work: quits at once; 'keep' keeps drafts; 'cancel' stays", async () => {
    const { w, a } = await oneComputer();
    await seedFile(w, a.dev, A);
    await a.ses.getState().open(A);
    expect(await a.ses.getState().quitRoutine("menu")).toBe(true);
    a.graph.getState().setCell(0, 0, 0, "q");
    expect(await withAnswer(a, () => a.ses.getState().quitRoutine("window"), { kind: "quit", choice: "cancel" })).toBe(false);
    expect(await withAnswer(a, () => a.ses.getState().quitRoutine("menu"), { kind: "quit", choice: "keep" })).toBe(true);
    expect(await a.dev.readDraft(a.ses.getState().activeKey!)).not.toBeNull();
    // The updater's restart never asks.
    expect(await a.ses.getState().quitRoutine("update")).toBe(true);
    expect(a.ses.getState().dialog).toBeNull();
    const a2 = await a.restart();
    expect(a2.graph.getState().doc!.cells[0][0][0]).toBe("q");
  });

  it("'Save all' saves every tab (untitled ones through Save As) in strip order", async () => {
    const { w, a } = await oneComputer();
    await seedFile(w, a.dev, A);
    await a.ses.getState().open(A);
    a.graph.getState().setCell(0, 0, 0, "a!");
    await a.ses.getState().newDoc("column", true);
    a.graph.getState().setCell(0, 0, 0, "u!");
    a.picks.push(`${DOCS}/U.lag`);
    expect(await withAnswer(a, () => a.ses.getState().quitRoutine("menu"), { kind: "quit", choice: "saveAll" })).toBe(true);
    expect(firstCell(contentAt(a.dev, A))).toBe("a!");
    expect(firstCell(contentAt(a.dev, `${DOCS}/U.lag`))).toBe("u!");
    expect(a.ses.getState().tabs.every((t) => !t.dirty)).toBe(true);
  });

  it("'Save all' stops at a tab that needs a choice and shows it", async () => {
    const { w, a } = await oneComputer();
    await seedFile(w, a.dev, A);
    await seedFile(w, a.dev, B);
    await a.ses.getState().open(A);
    a.graph.getState().setCell(0, 0, 0, "a!");
    await a.ses.getState().open(B);
    a.graph.getState().setCell(0, 0, 0, "b!");
    const ka = a.ses.getState().tabs[0].key;
    a.picks.push(null);
    a.dev.setPermissionDenied(DOCS, true);
    const ok = await withAnswer(a, () => a.ses.getState().quitRoutine("menu"), { kind: "quit", choice: "saveAll" });
    expect(ok).toBe(false);
    expect(a.ses.getState().activeKey).toBe(ka);
    // The blocked folder is reported first; the failed save is listed too.
    expect(a.ses.getState().tabs[0].banner?.kind).toBe("permission");
    expect(a.ses.getState().tabs[0].banners.find((b) => b.kind === "saveFailed")?.message).toBe("The file's folder can't be written to.");
    expect(a.ses.getState().tabs[0].dirty).toBe(true);
  });

  it("desktop: quit-requested → flushed → dialog → proceed / cancel replies", async () => {
    const w = makeWorld();
    const a = await start(await computer(w, { device_id: "d-a", device_name: "Mac mini" }, { desktop: true }));
    await seedFile(w, a.dev, A);
    await a.ses.getState().open(A);
    a.graph.getState().setCell(0, 0, 0, "z");
    a.emit("app://quit-requested", { requestId: 7, source: "system" });
    await flush();
    expect(a.invoked).toContainEqual({ cmd: "app_quit_reply", args: { requestId: 7, stage: "flushed" } });
    a.ses.getState().answerDialog({ kind: "quit", choice: "cancel" });
    await flush();
    expect(a.invoked).toContainEqual({ cmd: "app_quit_reply", args: { requestId: 7, stage: "cancel" } });
    a.emit("app://quit-requested", { requestId: 8, source: "menu" });
    await flush();
    a.ses.getState().answerDialog({ kind: "quit", choice: "keep" });
    await flush();
    expect(a.invoked).toContainEqual({ cmd: "app_quit_reply", args: { requestId: 8, stage: "proceed" } });
    // Menu state is pushed (debounced) for the native menu.
    await tick(w, 200);
    const menu = last(a.invoked.filter((x) => x.cmd === "app_set_menu_state"))!.args as { state: { hasDoc: boolean; canSave: boolean; recent: { label: string }[] } };
    expect(menu.state).toMatchObject({ hasDoc: true, canSave: true });
    expect(menu.state.recent[0].label).toBe("A — Documents");
    // Files opened from Finder.
    await seedFile(w, a.dev, B);
    a.emit("app://open-files", { paths: [B] });
    await flush();
    expect(a.ses.getState().tabs.map((t) => t.title)).toEqual(["A", "B"]);
    expect(a.ses.getState().focusSerial).toBeGreaterThan(0);
    // Menu events.
    a.emit("app://menu", { id: "app.settings", path: null });
    await flush();
    expect(a.ses.getState().dialog?.kind).toBe("settings");
  });
});

describe("settings", () => {
  it("names are stored and go into the next saved version", async () => {
    const { w, a } = await oneComputer();
    await seedFile(w, a.dev, A);
    await a.ses.getState().open(A);
    await a.ses.getState().setSettings({ userName: "  Zhuo Jian  ", deviceName: "Lab Mac" });
    expect(a.ses.getState().settings).toEqual({ userName: "Zhuo Jian", deviceName: "Lab Mac" });
    a.graph.getState().setCell(0, 0, 0, "n");
    await a.ses.getState().save();
    const f = a.dev.localFile(A)!;
    const head = f.manifest.revisions.find((r) => r.id === f.manifest.head)!;
    expect(head).toMatchObject({ user_name: "Zhuo Jian", device_name: "Lab Mac", device_id: "d-a" });
    const a2 = await a.restart();
    expect(a2.ses.getState().settings).toEqual({ userName: "Zhuo Jian", deviceName: "Lab Mac" });
  });
});
