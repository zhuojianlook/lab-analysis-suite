import { describe, expect, it } from "vitest";
import type { GraphAnalysis } from "../../../api/graph";
import * as M from "../graphModel";
import { isDirty, useGraphStore } from "../../../store/graphStore";
import { EDIT_SCRIPT, FIXTURES } from "../__tests__/fixtures";
import { canonicalJson, contentHash, makePart, sha256Hex, SECTION_NAMES } from "./format";
import { entityIds, fromFileSections, toFileSections, type OpenSections } from "./idMap";

const st = useGraphStore;

function openFixture(i: number) {
  const f = FIXTURES[i];
  st.getState().load({ doc: M.migrateDoc(f.table)!, analysis: f.analysis as never, figure: f.figure as never, name: f.id, id: 1, saved: true });
  const s = st.getState();
  return { doc: s.doc!, analysis: s.analysis, figure: s.figure };
}

describe("id map", () => {
  it.each(FIXTURES.map((f, i) => [f.id, i] as const))("round trip of %s (open form → file form → open form)", (_id, i) => {
    const open = openFixture(i);
    const file = toFileSections(open);
    // Through JSON, as it would be stored.
    const back = fromFileSections(JSON.parse(JSON.stringify(file)))!;
    expect(back.doc).toEqual(open.doc);
    expect(back.analysis).toEqual(open.analysis);
    expect(back.figure).toEqual(open.figure);
    // And the file form is stable.
    expect(toFileSections(back)).toEqual(file);
  });

  it("stores control / pairs and series by id", () => {
    const open = openFixture(0); // column, Dunnett vs control 0
    const file = toFileSections({ ...open, analysis: { ...open.analysis, pairs: [[0, 2], [1, 2]] } });
    expect(file.table.v).toBe(2);
    expect(file.analysis.control).toBe(open.doc.col_ids[0]);
    expect(file.analysis.pairs).toEqual([[open.doc.col_ids[0], open.doc.col_ids[2]], [open.doc.col_ids[1], open.doc.col_ids[2]]]);
    expect(Object.keys(file.figure.series)).toEqual(open.doc.col_ids);
    expect(file.figure.series[open.doc.col_ids[1]]).toEqual({ color: open.figure.colors[1], label: open.figure.labels[1] });
    expect(file.figure).not.toHaveProperty("colors");
    expect(file.figure).not.toHaveProperty("prism_palette");
  });

  it("grouped tables comparing within columns refer to rows", () => {
    const open = openFixture(2); // grouped-within-columns
    expect(open.analysis.within).toBe("columns");
    expect(entityIds(open.doc, open.analysis)).toBe(open.doc.row_ids);
    const file = toFileSections(open);
    expect(file.analysis.control).toBe(open.doc.row_ids[open.analysis.control!]);
    expect(file.analysis.pairs[0]).toEqual([open.doc.row_ids[open.analysis.pairs[0][0]], open.doc.row_ids[open.analysis.pairs[0][1]]]);
  });

  it("references survive a column being deleted and inserted elsewhere (ids, not positions)", () => {
    const open = openFixture(10); // four columns, pairs
    const a: GraphAnalysis = { ...open.analysis, compare: "selected", pairs: [[1, 3]], control: 3 };
    const file = toFileSections({ ...open, analysis: a });
    // Another version of the table: column 0 removed, a new column inserted at 1.
    let doc = M.deleteCol(open.doc, 0);
    doc = M.insertCol(doc, 1);
    const back = fromFileSections({ ...file, table: { ...doc, v: 2 } })!;
    // B (was 1) is now 0, D (was 3) is now 3 (one removed before it, one inserted before it).
    expect(back.analysis.pairs).toEqual([[0, 3]]);
    expect(back.analysis.control).toBe(3);
    expect(back.figure.colors[0]).toBe(open.figure.colors[1]);
    expect(back.figure.colors[1]).toBe("");   // the new column had no stored colour
  });

  it("drops references to unknown ids and indices past the table", () => {
    const open = openFixture(0);
    const file = toFileSections({ ...open, analysis: { ...open.analysis, control: 99, pairs: [[0, 99], [0, 1]] } });
    expect(file.analysis.control).toBeNull();
    expect(file.analysis.pairs).toHaveLength(1);
    const back = fromFileSections({ ...file, analysis: { ...file.analysis, control: "col-gone", pairs: [["col-gone", open.doc.col_ids[0]]] } })!;
    expect(back.analysis.control).toBeNull();
    expect(back.analysis.pairs).toEqual([]);
  });

  it("refuses what isn't a Graphs table", () => {
    expect(fromFileSections({ table: null, analysis: {}, figure: {} })).toBeNull();
    expect(fromFileSections({ table: { v: 3, template: "column" }, analysis: {}, figure: {} })).toBeNull();
    expect(fromFileSections({ table: { v: 2, template: "pie" }, analysis: {}, figure: {} })).toBeNull();
  });

  it("request keys never see ids", () => {
    const open = openFixture(5);
    const table = M.toNumericTable(open.doc);
    const text = JSON.stringify([table, M.effectiveAnalysis(open.analysis, table), M.effectiveFigure(open.figure, table)]);
    for (const id of [...open.doc.row_ids, ...open.doc.col_ids]) expect(text).not.toContain(id);
  });
});

/** The file form's stored text, as section blobs would hold it. */
const fileText = (o: OpenSections) => canonicalJson(toFileSections(o));

/** Open a file form the way phase 1 will: file form → open form → store.load. */
function reopen(text: string) {
  const back = fromFileSections(JSON.parse(text))!;
  st.getState().load({ doc: back.doc, analysis: back.analysis, figure: back.figure, name: "x", id: 1, saved: true });
  const s = st.getState();
  return { doc: s.doc!, analysis: s.analysis, figure: s.figure };
}

describe("canonical file form", () => {
  it("canonicalJson sorts keys at every level and follows JSON.stringify otherwise", () => {
    const a = { b: 1, a: [3, { y: undefined, x: "é\n", z: null }, undefined, NaN], c: { e: true, d: -0 } };
    const b = { c: { d: 0, e: true }, a: [3, { z: null, x: "é\n" }, null, null], b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":[3,{"x":"é\\n","z":null},null,null],"b":1,"c":{"d":0,"e":true}}');
    expect(JSON.parse(canonicalJson(a))).toEqual(JSON.parse(JSON.stringify(b)));
    expect(canonicalJson({ first: undefined, k: 1 })).toBe('{"k":1}');
    expect(canonicalJson({ k: 1, last: undefined })).toBe('{"k":1}');
    expect(canonicalJson([])).toBe("[]");
    expect(canonicalJson({})).toBe("{}");
  });

  it("parts and content hashes are content-addressed", async () => {
    const p1 = await makePart({ b: 1, a: "é" });
    const p2 = await makePart({ a: "é", b: 1 });
    expect(p1).toEqual(p2);
    expect(p1.ref.sha256).toBe(await sha256Hex('{"a":"é","b":1}'));
    expect(p1.ref.part).toBe(`parts/${p1.ref.sha256}.json`);
    expect(p1.ref.bytes).toBe(16);                       // é is two bytes
    const secs = Object.fromEntries(SECTION_NAMES.map((n) => [n, p1.ref])) as never;
    expect(await contentHash(secs)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("key order no longer depends on the edit history (sample column table after setX)", () => {
    st.getState().newDoc("column", true);
    st.getState().setX(0, "1");
    const s = st.getState();
    const open = { doc: s.doc!, analysis: s.analysis, figure: s.figure };
    // The same content with its keys in another order gives the same text.
    const shuffled = JSON.parse(JSON.stringify(toFileSections(open)), (_k, v) =>
      v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v);
    expect(canonicalJson(shuffled)).toBe(fileText(open));
    expect(fileText(open)).toBe(fileText(fromFileSections(JSON.parse(fileText(open)))!));
    expect(fileText(open)).toContain('"cells":[[["4.17"]');
    expect(fileText(open).indexOf('"analysis"')).toBeLessThan(fileText(open).indexOf('"figure"'));
  });

  it.each(FIXTURES.map((f, i) => [f.id, i] as const))("open → save → reopen → save gives the same bytes and hashes at every edit step: %s", async (_id, i) => {
    openFixture(i);
    const st0 = st.getState() as unknown as Record<string, (...a: unknown[]) => unknown>;
    const steps: [string, ...unknown[]][] = [["open"], ...EDIT_SCRIPT];
    for (const [op, ...args] of steps) {
      if (op !== "open") st0[op](...args);
      const s = st.getState();
      if (s.doc && M.hasNumbers(M.toNumericTable(s.doc))) s.normalize();   // GraphView's clean-up effect
      const t = st.getState();
      const saved = { doc: t.doc!, analysis: t.analysis, figure: t.figure };
      const text = fileText(saved);
      const reopened = reopen(text);
      // The reopened document is the one that was saved (its table in the form
      // opening gives it). Before there are numbers an edit can leave a control
      // / pair pointing past the table (the clean-up only runs with numbers, as
      // before ids); the file form drops it, so phase 1 takes the post-save
      // baseline from the file form.
      expect(reopened.doc).toEqual(M.migrateDoc(saved.doc));
      if (M.hasNumbers(M.toNumericTable(saved.doc))) expect(reopened.analysis).toEqual(saved.analysis);
      expect(reopened.figure).toEqual(saved.figure);
      // … and saving it again gives the same bytes, so the same hash.
      const again = fileText(reopened);
      expect(again).toBe(text);
      expect(await sha256Hex(again)).toBe(await sha256Hex(text));
      // Put the edited state back for the next step.
      st.setState({ doc: t.doc, analysis: t.analysis, figure: t.figure, undoStack: t.undoStack });
    }
  });
});

describe("stored ids that would break the file form", () => {
  it("__proto__, all-digit and wrong-kind ids are replaced on open", () => {
    const f = FIXTURES[0];
    const bad = { ...(f.table as object), col_ids: ["__proto__", "9", "row-aaaaaaaaaa"], row_ids: ["1"] };
    const doc = M.migrateDoc(bad)!;
    expect(doc.col_ids.every((id) => /^col-[0-9a-z]{4,60}$/.test(id))).toBe(true);
    expect(doc.row_ids.every((id) => /^row-[0-9a-z]{4,60}$/.test(id))).toBe(true);
    expect(doc.col_ids).not.toContain("__proto__");
    expect(M.isValidId("col-aaaaaaaaaa", "col")).toBe(true);
    expect(M.isValidId("col-aaaaaaaaaa", "row")).toBe(false);
    expect(M.isValidId("__proto__", "col")).toBe(false);
  });

  it("every column keeps its colour and label through the file form, in column order", () => {
    const open = openFixture(10);
    const file = JSON.parse(fileText(open));
    const back = fromFileSections(file)!;
    expect(back.figure.colors).toEqual(open.figure.colors);
    expect(back.figure.labels).toEqual(open.figure.labels);
  });
});

describe("references past the table before there are numbers", () => {
  it("are dropped on open, so memory and the file form agree", () => {
    const doc = M.emptyDoc("column");
    st.getState().load({ doc, analysis: { control: 7, pairs: [[0, 9], [0, 1]] } as never, figure: {} as never, name: "e", id: 1, saved: true });
    const s = st.getState();
    expect(s.analysis.control).toBeNull();
    expect(s.analysis.pairs).toEqual([[0, 1]]);
    const back = reopen(fileText({ doc: s.doc!, analysis: s.analysis, figure: s.figure }));
    expect(back.analysis).toEqual(s.analysis);
    expect(isDirty(st.getState())).toBe(false);
  });
});
