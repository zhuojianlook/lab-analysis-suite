// Opening a document never marks it changed; the name is not part of the content
// key; analysis / plot requests are byte-identical to the build before ids.
import { beforeAll, describe, expect, it } from "vitest";
import type { GraphDoc } from "../../../api/graph";
import * as M from "../graphModel";
import { isDirty, readDraft, snapshotKey, useGraphStore, writeDraft } from "../../../store/graphStore";
import { EDIT_SCRIPT, FIXTURES, type Fixture } from "./fixtures";
import golden from "./golden-pre-ids.json";

beforeAll(() => {
  const mem = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => { mem.set(k, String(v)); },
    removeItem: (k: string) => { mem.delete(k); },
  };
});

const st = useGraphStore;
/** First 16 hex digits of SHA-256 (as in golden-pre-ids.json). */
async function h(t: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

/** What GraphView's clean-up effect does: run when its dependencies change. */
let lastDeps = "";
function effect() {
  const s = st.getState();
  const doc = s.doc!;
  const table = M.toNumericTable(doc);
  const hasData = M.hasNumbers(table);
  const withinCols = doc.template === "grouped" && s.analysis.within === "columns";
  const deps = JSON.stringify([s.docSerial, hasData, M.usedCols(table), M.usedRows(table),
    withinCols ? doc.cells.length : doc.col_titles.length, s.analysis.within]);
  if (deps === lastDeps) return;
  lastDeps = deps;
  if (hasData) s.normalize();
}

/** GraphView's request keys. */
function keys() {
  const s = st.getState();
  const table = M.toNumericTable(s.doc!);
  const anKey = `${JSON.stringify(table)}|${JSON.stringify(M.effectiveAnalysis(s.analysis, table))}`;
  const plotKey = `${anKey}|${JSON.stringify(M.effectiveFigure(s.figure, table))}`;
  return { anKey, plotKey };
}

const stripIds = (d: GraphDoc) => { const { row_ids: _r, col_ids: _c, ...rest } = d; return rest; };

/** Open a fixture the way the library does. */
function open(f: Fixture) {
  const doc = M.migrateDoc(f.table)!;
  st.getState().load({ doc, analysis: f.analysis as never, figure: f.figure as never, name: f.id, id: 1, saved: true, scratch: f.scratchpad });
}

describe.each(FIXTURES.map((f) => [f.id, f] as const))("open %s", (_id, f) => {
  it("is clean after load and stays clean after the clean-up effect", () => {
    open(f);
    expect(isDirty(st.getState())).toBe(false);
    effect();
    expect(isDirty(st.getState())).toBe(false);
    // Running the clean-up again changes nothing either.
    const before = st.getState();
    st.getState().normalize();
    expect(st.getState().analysis).toBe(before.analysis);
    expect(st.getState().figure).toBe(before.figure);
  });

  it("opening twice gives the same settings (only fresh ids differ for documents saved without ids)", () => {
    open(f);
    const a = st.getState();
    open(f);
    const b = st.getState();
    expect(b.analysis).toEqual(a.analysis);
    expect(b.figure).toEqual(a.figure);
    expect(stripIds(b.doc!)).toEqual(stripIds(a.doc!));
  });

  it("re-opening the saved form (with ids) is clean and keeps the ids", () => {
    open(f);
    const s = st.getState();
    const saved = JSON.parse(JSON.stringify({ table: s.doc, analysis: s.analysis, figure: s.figure }));
    st.getState().load({ doc: M.migrateDoc(saved.table)!, analysis: saved.analysis, figure: saved.figure, name: "n", id: 2, saved: true });
    const r = st.getState();
    expect(isDirty(r)).toBe(false);
    expect(r.doc).toEqual(s.doc);
    expect(snapshotKey(r)).toBe(snapshotKey(s));
  });

  it("restoring it as a draft gives the same document", () => {
    open(f);
    const s = st.getState();
    expect(writeDraft(s)).toBe("saved");
    const d = readDraft()!;
    st.getState().load({ doc: d.doc, analysis: d.analysis, figure: d.figure, name: d.name, id: d.currentId, saved: false, scratch: d.scratchpad });
    expect(st.getState().doc).toEqual(s.doc);
    expect(st.getState().analysis).toEqual(s.analysis);
    expect(st.getState().figure).toEqual(s.figure);
  });

  it("analysis / plot keys and every edit step match the build before ids", async () => {
    const steps = (golden as Record<string, { op: string; an: string; plot: string; dirty: boolean; doc: string; analysis: string; figure: string; undo: number }[]>)[f.id];
    expect(steps).toBeTruthy();
    lastDeps = "";
    open(f);
    // Texts are taken synchronously after each step and hashed afterwards.
    const texts: { op: string; an: string; plot: string; doc: string; analysis: string; figure: string; undo: number }[] = [];
    const rec = (op: string) => {
      const s = st.getState();
      const k = keys();
      texts.push({
        op, an: k.anKey, plot: k.plotKey, doc: JSON.stringify(stripIds(s.doc!)),
        analysis: JSON.stringify(s.analysis), figure: JSON.stringify(s.figure), undo: s.undoStack.length,
      });
    };
    rec("load");
    effect();
    rec("open");
    for (const [op, ...args] of EDIT_SCRIPT) {
      (st.getState() as unknown as Record<string, (...a: unknown[]) => unknown>)[op](...args);
      effect();
      rec(op);
    }
    const got = await Promise.all(texts.map(async (t) => ({
      op: t.op, an: await h(t.an), plot: await h(t.plot), doc: await h(t.doc),
      analysis: await h(t.analysis), figure: await h(t.figure), undo: t.undo,
    })));
    // Before ids the clean-up ran after load (as an effect); now it runs inside
    // load. From the moment the document is on screen ("open") on, everything matches.
    const want = steps.map(({ dirty: _d, ...rest }) => rest);
    expect(got.slice(1)).toEqual(want.slice(1));
    expect(got[0].an === want[0].an || got[0].an === want[1].an).toBe(true);
  });
});

describe("the documents that used to open as changed", () => {
  it("are the ones the clean-up changes, and now open clean", () => {
    const g = golden as Record<string, { dirty: boolean }[]>;
    const wasDirty = FIXTURES.filter((f) => g[f.id][1].dirty).map((f) => f.id);
    expect(wasDirty.length).toBeGreaterThan(0);
    for (const id of wasDirty) {
      open(FIXTURES.find((f) => f.id === id)!);
      effect();
      expect(isDirty(st.getState())).toBe(false);
    }
  });
});

describe("name and dirty state", () => {
  it("snapshotKey holds only the content", () => {
    open(FIXTURES[0]);
    const s = st.getState();
    const k = JSON.parse(snapshotKey(s));
    expect(Object.keys(k).sort()).toEqual(["analysis", "doc", "figure"]);
    expect(snapshotKey({ ...s, name: "something else" } as typeof s)).toBe(snapshotKey(s));
  });

  it("renaming in the field still shows unsaved changes; typing the old name back is clean", () => {
    open(FIXTURES[0]);
    st.getState().setName("Other");
    expect(isDirty(st.getState())).toBe(true);
    st.getState().setName(FIXTURES[0].id);
    expect(isDirty(st.getState())).toBe(false);
  });

  it("markSaved / markRenamed / detach / close / newDoc", () => {
    open(FIXTURES[0]);
    st.getState().setName("Saved as");
    const s = st.getState();
    st.getState().markSaved(9, "Saved as", { doc: s.doc, analysis: s.analysis, figure: s.figure, scratch: s.scratch });
    expect(isDirty(st.getState())).toBe(false);
    st.getState().markRenamed("Renamed in library");
    expect(st.getState().name).toBe("Renamed in library");
    expect(isDirty(st.getState())).toBe(false);
    st.getState().setCell(0, 0, 0, "123");
    st.getState().markRenamed("Again");
    expect(isDirty(st.getState())).toBe(true);
    st.getState().undo();
    expect(isDirty(st.getState())).toBe(false);
    st.getState().detach();
    expect(isDirty(st.getState())).toBe(true);
    st.getState().newDoc("grouped", true);
    expect(isDirty(st.getState())).toBe(false);
    st.getState().close();
    expect(isDirty(st.getState())).toBe(false);
  });

  it("a draft (not saved) is dirty from the start", () => {
    const f = FIXTURES[1];
    st.getState().load({ doc: M.migrateDoc(f.table)!, analysis: f.analysis as never, figure: f.figure as never, name: "d", id: 4, saved: false });
    expect(isDirty(st.getState())).toBe(true);
  });
});
