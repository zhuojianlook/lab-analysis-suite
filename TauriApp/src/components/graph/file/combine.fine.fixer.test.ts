// Phase 4 fixer: regression tests for the session findings of the phase 4 review (VS-1, VS-2, VS-3, VUX-3,
// VUX-4, VUX-6, VUX-9) and the table rule M1 end to end. Each one failed on the code before the fix.
// MemoryDevices on the ManualClock.
import { describe, expect, it, vi } from "vitest";
import { openContent, type DocContent } from "../../../store/graphStore";
import { ensureRows } from "../graphModel";
import { COMBINE_V, LIMITS_P3, type CombineStateP4 } from "./contract";
import { buildNextFile, fileAt, openFile, revisionOf, type Author } from "./docCodec";
import type { GraphFileData } from "./format";
import { LOOK_AGAIN_NEWER } from "./session";
import {
  PFILE as P, activeTab, bannerOf, combineState, contentAt, editCell, editCellAt, flush, group, guardOf, lostVersions, pair,
  syncPair, tick, type Computer, type Pair,
} from "./testkit";

vi.setConfig({ testTimeout: 60_000 });

const S = 1000;
const carl: Author = { user_name: "Carl", device_id: "d-c", device_name: "Lab PC", session_id: "s-c", app_version: "t", platform: "macos" };
const stored = (c: DocContent): DocContent => openContent({ doc: ensureRows(c.doc), analysis: c.analysis, figure: c.figure, scratch: c.scratch });
const withCell = (r: number, col: number, v: string) => (c: DocContent): DocContent => {
  const cells = c.doc.cells.map((row) => row.map((reps) => [...reps]));
  cells[r][col][0] = v;
  return { ...c, doc: { ...c.doc, cells } };
};
const stamp = (f: GraphFileData): GraphFileData =>
  ({ ...f, manifest: { ...f.manifest, revisions: f.manifest.revisions.map((r) => (r.id === f.manifest.head ? { ...r, combine_v: COMBINE_V } : r)) } });
async function saveOverFine(w: Pair["w"], dev: Computer["dev"], path: string, fn: (c: DocContent) => DocContent): Promise<string> {
  const f = dev.localFile(path)!;
  const parent = revisionOf(f.manifest, f.manifest.head)!.parents[0];
  const base = fileAt(f, parent)!;
  const next = stamp(await buildNextFile(base, stored(fn(openFile(base)!)), { time: w.clock.now(), author: carl }));
  w.forceReplace(path, next);
  return next.manifest.head;
}
const st = (c: Computer): CombineStateP4 => {
  const s = combineState(c);
  if (!s) throw new Error(`no combine dialog (have ${c.ses.getState().dialog?.kind ?? "none"})`);
  return s;
};
const tableOf = (s: CombineStateP4) => s.sections.find((x) => x.key === "table")!;

describe("fixer VS-1: typing while the dialog is open, then Apply", () => {
  it("the tab still shows the versions the other computer saves later", async () => {
    const s = await pair(2000, "dropbox", { notes: false });
    const { a, b } = s;
    await editCellAt(b, 0, 0, "B!");
    await editCellAt(a, 0, 0, "A!");
    await a.ses.getState().save();
    await syncPair(s);
    expect((await b.ses.getState().save()).ok).toBe(false);
    await b.ses.getState().setConflictChoice(tableOf(st(b)).conflicts[0].id, "theirs");
    await editCellAt(b, 7, 1, "typed");                       // contract S8: typed while the dialog is open
    expect((await b.ses.getState().applyCombine()).ok).toBe(true);
    expect(b.ses.getState().dialog).toBeNull();
    expect(contentAt(b.dev, P)!.doc.cells[7][1][0]).toBe("typed");
    await syncPair(s);
    for (let n = 1; n <= 3; n++) {
      await editCellAt(a, 3, 1, `A${n}`);
      expect((await a.ses.getState().save()).ok).toBe(true);
      await syncPair(s);
    }
    await tick(s.w, 10 * 60 * S);
    expect(b.graph.getState().doc!.cells[3][1][0]).toBe("A3");
    expect(activeTab(b).baseRevision).toBe(b.dev.localHead(P));
    expect(lostVersions(s.w)).toEqual([]);
  });
});

describe("fixer VS-2 / VUX-6: an adjustment that appears after the person looked", () => {
  it("Apply shows it first (nothing written), says why, and the second Apply writes what is shown", async () => {
    const s = await pair(2000, "dropbox", { notes: false });
    const { a, b } = s;
    await editCellAt(b, 0, 0, "B!");
    b.graph.getState().deleteCol(2);
    await flush();
    await editCellAt(a, 0, 0, "A!");
    a.graph.getState().setAnalysis({ test: "anova", posthoc: "tukey", compare: "pairs", pairs: [[0, 1]] } as never);
    await flush();
    await a.ses.getState().save();
    await syncPair(s);
    expect((await b.ses.getState().save()).ok).toBe(false);
    await b.ses.getState().setConflictChoice(tableOf(st(b)).conflicts[0].id, "mine");
    expect(st(b).adjustments).toEqual([]);
    expect(st(b).canApply).toBe(true);
    // The other computer adds a comparison that names the column I deleted.
    a.graph.getState().setAnalysis({ pairs: [[0, 1], [0, 2]] } as never);
    await flush();
    expect((await a.ses.getState().save()).ok).toBe(true);
    await syncPair(s);
    const writes = b.dev.written.length;
    const out = await b.ses.getState().applyCombine();
    expect(out.ok).toBe(false);
    expect(b.dev.written.length).toBe(writes);
    const again = st(b);
    expect(again.error).toBe(LOOK_AGAIN_NEWER);
    expect(again.adjustments.length).toBeGreaterThan(0);
    expect(again.adjustments.some((x) => x.section === "analysis")).toBe(true);
    // The choice made is still there; Apply now writes what the dialog shows.
    expect(again.canApply).toBe(true);
    const shown = again.resultContent!;
    expect((await b.ses.getState().applyCombine()).ok).toBe(true);
    expect(contentAt(b.dev, P)!.analysis).toEqual(shown.analysis);
    expect(contentAt(b.dev, P)!.doc.cells[0][0][0]).toBe("B!");
  });
});

describe("fixer VUX-4: 'Use … for the rest'", () => {
  it("fills only the ones without a choice; the choices made stay", async () => {
    const s = await pair();
    const { a, b } = s;
    for (const [r, col, v] of [[0, 0, "b0"], [1, 1, "b1"], [2, 2, "b2"]] as const) await editCellAt(b, r, col, v);
    for (const [r, col, v] of [[0, 0, "a0"], [1, 1, "a1"], [2, 2, "a2"]] as const) await editCellAt(a, r, col, v);
    await a.ses.getState().save();
    await syncPair(s);
    await b.ses.getState().save();
    const ids = tableOf(st(b)).conflicts.map((c) => c.id);
    expect(ids).toHaveLength(3);
    await b.ses.getState().setConflictChoice(ids[1], "theirs");
    await b.ses.dialogExtras.setRestInSection("table", "mine");
    expect(tableOf(st(b)).choices).toEqual({ [ids[0]]: "mine", [ids[1]]: "theirs", [ids[2]]: "mine" });
    expect(st(b).toChoose).toBe(0);
    const r = st(b).resultContent!.doc.cells;
    expect([r[0][0][0], r[1][1][0], r[2][2][0]]).toEqual(["b0", "a1", "b2"]);
    // "for all" still sets every one.
    await b.ses.getState().setAllInSection("table", "theirs");
    expect(Object.values(tableOf(st(b)).choices)).toEqual(["theirs", "theirs", "theirs"]);
  });
});

describe("fixer VUX-3: Cancel keeps the choices for the same pair", () => {
  it("reopened through Save: the choices are back; a different version of the other side starts afresh", async () => {
    const s = await pair();
    const { a, b } = s;
    await editCellAt(b, 0, 0, "B!");
    await editCellAt(a, 0, 0, "A!");
    await a.ses.getState().save();
    await syncPair(s);
    await b.ses.getState().save();
    const id = tableOf(st(b)).conflicts[0].id;
    await b.ses.getState().setConflictChoice(id, "theirs");
    b.ses.getState().cancelCombine();
    expect(b.ses.getState().dialog).toBeNull();
    await b.ses.getState().save();
    expect(tableOf(st(b)).choices).toEqual({ [id]: "theirs" });
    b.ses.getState().cancelCombine();
    // The other computer saves the same cell again: that conflict is no longer the same, so nothing is carried.
    await editCellAt(a, 0, 0, "A!!");
    await a.ses.getState().save();
    await syncPair(s);
    await b.ses.getState().save();
    expect(tableOf(st(b)).choices).toEqual({});
    expect(st(b).toChoose).toBe(1);
  });
});

describe("fixer VS-3: a waiting unprompted combine on a read-only tab", () => {
  it("when the combined version arrives meanwhile, the tab shows it at once instead of waiting for the guard", async () => {
    const g = await group(2, { delay: 500, users: ["Alice", "Zhuo"], deps: [{}, { combineDelayMs: async () => 20 * S }] });
    const [a, b] = g.cs;
    await editCell(b, "B1");
    await b.ses.getState().save();
    await tick(g.w, LIMITS_P3.lingerMs + 5 * S);
    a.graph.getState().setFigure({ title: "A editing" });
    await flush();
    await tick(g.w, 3 * S);
    expect(guardOf(b)).toBe("editingElsewhere");
    // Carl saves over B's last save from the version before it (another cell of the table): B waits its delay.
    await saveOverFine(g.w, b.dev, g.path, withCell(5, 1, "carl"));
    await tick(g.w, 2 * S);
    expect(bannerOf(b, "savedOver")).toMatchObject({ state: "combining" });
    // Alice saves (her unsaved title combines with Carl's version) and goes on editing.
    expect((await a.ses.getState().save()).ok).toBe(true);
    a.graph.getState().setFigure({ title: "A still editing" });
    await flush();
    await tick(g.w, 30 * S);
    expect(guardOf(b)).not.toBeNull();                         // still read-only
    expect(activeTab(b).baseRevision).toBe(b.dev.localHead(g.path));
    expect(bannerOf(b, "savedOver")).toBeNull();
    const doc = b.graph.getState().doc!;
    expect(doc.cells[5][1][0]).toBe("carl");
    expect(doc.cells[0][0][0]).toBe("B1");
    expect(b.graph.getState().figure.title).toBe("A editing");
  });
});
