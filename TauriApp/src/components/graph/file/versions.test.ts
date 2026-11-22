// The Versions panel's state and actions (phase2-contract.md §5.3, §5.8, §5.10;
// checklist S12–S14): the list with its lane layout and chips, the read-only
// preview and compare, Bring back (a new version, history never rewritten) and
// Save this version as a new analysis.
import { describe, expect, it } from "vitest";
import { isDirty } from "../../../store/graphStore";
import { MENU, SUMMARY, WORKING_ROW, type RevisionP2 } from "./contract";
import { buildNextFile, openFile, revisionOf } from "./docCodec";
import {
  DBX, PFILE as P, activeTab, authorFor, editCell, editTitle, firstCell, contentAt, flush, pair, syncPair, tick, withAnswer, type Pair,
} from "./testkit";

const V = (s: Pair, who: "a" | "b" = "a") => s[who].ses.getState().versions!;

async function history(s: Pair, n: number) {
  for (let k = 0; k < n; k++) {
    await editCell(s.a, `v${k}`);
    await s.a.ses.getState().save();
    s.w.clock.advance(60_000);
  }
}

describe("S14: the list", () => {
  it("rows newest first with the lane layout; chips; the working row; 25 more saves → the oldest are too old, all listed", async () => {
    const s = await pair(500);
    const { a } = s;
    await history(s, 3);
    await a.ses.getState().openVersions();
    let v = V(s);
    expect(v).toMatchObject({ tabKey: activeTab(a).key, name: "Dose response", loading: false, tooOld: 0, selectedId: null });
    expect(v.rows.map((r) => r.id)).toEqual(v.layout.rows.map((r) => r.id));
    expect(v.rows).toHaveLength(4);
    expect(v.rows[0]).toMatchObject({ id: a.dev.localHead(P), chips: ["current"], summary: "Changed the table", openable: true, foreign: false });
    expect(v.rows[0].who).toMatchObject({ userName: "Zhuo", deviceName: "Mac mini", mine: true });
    expect(v.rows[3].summary).toBe(SUMMARY.first);
    expect(v.layout.laneCount).toBe(1);
    expect(v.devices).toEqual([{ deviceId: "d-a", deviceName: "Mac mini", mine: true }]);
    // Unsaved changes: a first row.
    await editCell(a, "unsaved");
    await a.ses.getState().openVersions();
    v = V(s);
    expect(v.rows[0]).toMatchObject({ id: WORKING_ROW, kind: "working", chips: ["unsaved"], summary: "Unsaved changes", who: null });
    expect(v.rows[1].chips).toEqual(["current"]);
    await a.ses.getState().save();
    await flush();
    expect(V(s).rows[0].chips).toEqual(["current"]);           // rebuilt after the save
    // 25 more saves while the other computer has the file closed: there, the oldest can't be opened any more
    // (this computer still has its own saved copies of them).
    await s.b.ses.getState().closeTab();
    await history(s, 25);
    await flush();
    expect(V(s).rows).toHaveLength(30);
    expect(V(s).tooOld).toBe(0);
    await syncPair(s);
    await s.b.ses.getState().open(P);
    await s.b.ses.getState().openVersions();
    v = V(s, "b");
    expect(v.rows).toHaveLength(30);
    expect(v.tooOld).toBeGreaterThan(0);
    const old = v.rows.find((r) => r.chips.includes("tooOld"))!;
    expect(old).toMatchObject({ openable: false });
    expect(v.rows.indexOf(old)).toBeGreaterThanOrEqual(20);
    expect(v.rows.filter((r) => r.openable).length).toBeGreaterThanOrEqual(20);
    await s.b.ses.getState().selectVersion(old.id);
    expect(V(s, "b").preview).toMatchObject({ loading: false, content: null });
    // The menu item toggles it; a tab switch closes it.
    await a.ses.getState().menu(MENU.versions);
    expect(a.ses.getState().versions).toBeNull();
    await a.ses.getState().menu(MENU.versions);
    expect(a.ses.getState().versions).not.toBeNull();
    await a.ses.getState().showStart();
    expect(a.ses.getState().versions).toBeNull();
  });

  it("a combine joins two lanes; an extra copy's versions are foreign with its name; a separated file is a stub", async () => {
    const s = await pair(500);
    const { a, b } = s;
    await editCell(b, "mine");
    await editTitle(a, "Theirs");
    await a.ses.getState().save();
    await syncPair(s);
    await b.ses.getState().save();
    await b.ses.getState().openVersions();
    let v = V(s, "b");
    expect(v.rows[0].chips).toEqual(["current", "combined"]);
    expect(v.rows[0].who).toBeNull();                         // combined automatically
    expect(v.layout.laneCount).toBe(2);
    expect(v.devices.map((d) => d.deviceId).sort()).toEqual(["d-a", "d-b"]);
    // An extra copy with a version of its own.
    const f = b.dev.localFile(P)!;
    const c = openFile(f)!;
    const copy = `${DBX}/Dose response (Bob's conflicted copy 2026-11-20).lag`;
    const next = await buildNextFile(f, { ...c, figure: { ...c.figure, title: "Bob" } }, { time: s.w.clock.now(), author: { ...authorFor(b.dev, "Bob"), device_id: "d-bob" } });
    b.dev.place(copy, next);
    await tick(s.w, 300);
    await b.ses.getState().openVersions();
    v = V(s, "b");
    expect(v.rows.find((r) => r.id === next.manifest.head)).toMatchObject({ foreign: true, copyName: "Dose response (Bob's conflicted copy 2026-11-20)", copyPath: copy });
    // Save this version as a new analysis → a stub hangs off it.
    const m = v.rows.find((r) => r.chips.includes("current"))!.id;
    b.picks.push(`${DBX}/Split`);
    const out = await b.ses.getState().saveVersionAsNew(m);
    expect(out.ok).toBe(true);
    const k1 = b.ses.getState().tabs[0].key;
    await b.ses.getState().openVersions(k1);
    expect(V(s, "b").stubs).toEqual([{ from: m, name: "Split", path: `${DBX}/Split.lag` }]);
  });
});

describe("S12/S13: preview, compare, bring back, save as new", () => {
  it("select → read-only preview; compare with current; bring back makes a new version; same content writes nothing", async () => {
    const s = await pair(500);
    const { a } = s;
    await history(s, 2);
    const first = a.dev.localFile(P)!.manifest.revisions[0].id;
    await a.ses.getState().openVersions();
    await a.ses.getState().selectVersion(first);
    let v = V(s);
    expect(v.selectedId).toBe(first);
    expect(v.preview).toMatchObject({ id: first, loading: false });
    expect(v.preview!.content!.doc.cells[0][0][0]).not.toBe("v1");
    await a.ses.getState().compareWithCurrent(true);
    v = V(s);
    expect(v.comparing).toBe(true);
    expect(v.preview!.compare!.sections.find((x) => x.key === "table")!.same).toBe(false);
    expect(v.preview!.compare!.table.changedCells).toBe(1);
    expect(v.preview!.current!.doc.cells[0][0][0]).toBe("v1");
    expect(isDirty(a.graph.getState())).toBe(false);
    await a.ses.getState().selectVersion(null);
    expect(V(s).preview).toBeNull();
    // Bring back.
    const before = a.dev.localFile(P)!.manifest;
    const out = await a.ses.getState().bringBack(first);
    expect(out.ok).toBe(true);
    const m = a.dev.localFile(P)!.manifest;
    expect(m.revisions).toHaveLength(before.revisions.length + 1);
    const r = revisionOf(m, m.head)! as RevisionP2;
    expect(r).toMatchObject({ kind: "restore", restored_from: first, parents: [before.head], summary: SUMMARY.broughtBack });
    expect(r.content_hash).toBe(revisionOf(m, first)!.content_hash);
    expect(firstCell(contentAt(a.dev, P))).toBe(firstCell(openFile(a.dev.localFile(P)!, first)));
    expect(a.graph.getState().doc!.cells[0][0][0]).toBe(firstCell(contentAt(a.dev, P)));
    expect(activeTab(a)).toMatchObject({ dirty: false, baseRevision: m.head });
    expect(a.ses.getState().toasts.some((t) => t.kind === "broughtBack")).toBe(true);
    await flush();
    expect(V(s).rows[0].chips).toEqual(["current", "broughtBack"]);
    // The same content again: nothing written.
    const saves = a.dev.saves.length;
    expect(await a.ses.getState().bringBack(first)).toEqual({ ok: false, reason: "nothing" });
    expect(a.dev.saves.length).toBe(saves);
  });

  it("bring back with unsaved changes asks first and saves them as a version", async () => {
    const s = await pair(500);
    const { a } = s;
    await history(s, 1);
    const first = a.dev.localFile(P)!.manifest.revisions[0].id;
    await editCell(a, "unsaved work");
    await a.ses.getState().openVersions();
    expect(await withAnswer(a, () => a.ses.getState().bringBack(first), { kind: "bringBackDirty", choice: "cancel" })).toEqual({ ok: false, reason: "cancelled" });
    expect(a.graph.getState().doc!.cells[0][0][0]).toBe("unsaved work");
    const n = a.dev.localFile(P)!.manifest.revisions.length;
    expect((await withAnswer(a, () => a.ses.getState().bringBack(first), { kind: "bringBackDirty", choice: "saveFirst" })).ok).toBe(true);
    const m = a.dev.localFile(P)!.manifest;
    expect(m.revisions).toHaveLength(n + 2);
    const saved = revisionOf(m, revisionOf(m, m.head)!.parents[0])!;
    expect(firstCell(openFile(a.dev.localFile(P)!, saved.id))).toBe("unsaved work");
  });

  it("S13: save a version as a new analysis: new id, forked from that version, a new tab; the current tab is untouched", async () => {
    const s = await pair(500);
    const { a } = s;
    await history(s, 2);
    const first = a.dev.localFile(P)!.manifest.revisions[0].id;
    const k0 = activeTab(a).key;
    const head0 = a.dev.localHead(P);
    await a.ses.getState().openVersions();
    a.picks.push(`${DBX}/Old one`);
    const out = await a.ses.getState().saveVersionAsNew(first);
    expect(out.ok).toBe(true);
    const np = `${DBX}/Old one.lag`;
    expect(a.pickRequests[a.pickRequests.length - 1]).toMatchObject({ suggestedName: "Dose response (earlier version).lag", startDir: DBX });
    const nf = a.dev.localFile(np)!;
    expect(nf.manifest.analysis_id).not.toBe(a.dev.localFile(P)!.manifest.analysis_id);
    expect(nf.manifest.forked_from).toEqual({ analysis_id: a.dev.localFile(P)!.manifest.analysis_id, revision_id: first });
    expect(a.ses.getState().tabs.map((t) => t.path)).toEqual([P, np]);
    expect(activeTab(a).path).toBe(np);
    expect(a.ses.getState().toasts.some((t) => t.kind === "savedAsNew" && t.name === "Old one")).toBe(true);
    expect(a.dev.localHead(P)).toBe(head0);
    expect(a.ses.internal.knownCopies(k0)).toContain(np);
  });

  it("Undo on the combined banner brings my version from before the combine back; What changed opens compare", async () => {
    const s = await pair(500);
    const { a, b } = s;
    await editCell(b, "mine");
    await editTitle(a, "Theirs");
    await a.ses.getState().save();
    await syncPair(s);
    await b.ses.getState().save();
    const k = activeTab(b).key;
    await b.ses.getState().showWhatChanged(k);
    const v = V(s, "b");
    expect(v.comparing).toBe(true);
    expect(v.preview?.compare?.sections.find((x) => x.key === "figure")?.same).toBe(false);
    const m = b.dev.localFile(P)!.manifest;
    expect((await b.ses.getState().undoCombine(k)).ok).toBe(true);
    const m2 = b.dev.localFile(P)!.manifest;
    expect(m2.revisions).toHaveLength(m.revisions.length + 1);
    expect(revisionOf(m2, m2.head)).toMatchObject({ kind: "restore" });
    expect(b.graph.getState().figure.title).not.toBe("Theirs");
    expect(b.graph.getState().doc!.cells[0][0][0]).toBe("mine");
    expect(activeTab(b).banners.some((x) => x.kind === "combined")).toBe(false);
    // Their version stays in the history.
    expect(revisionOf(m2, a.dev.localHead(P)!)?.sections).not.toBeNull();
  });
});
