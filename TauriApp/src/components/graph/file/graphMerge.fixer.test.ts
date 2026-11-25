/* Phase 4 fixer, finding M1 end to end (combineFine with the real modules): two computers typing into the same
   blank row at the end of the table — the normal way to add data — give two rows, never one mixed row; on a
   paired table, a grouped table and an XY table that is an order to check (no automatic write), and every
   value both typed is in the result. Failed before the fix (one row, a mix, written automatically on a
   paired table). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openContent, type DocContent } from "../../../store/graphStore";
import { ensureRows, sampleDoc, setIdSource } from "../graphModel";
import type { CombinePlanP4, SectionValues, SideKey } from "./contract";
import { contentOfSections, sectionsOf } from "./docCodec";
import { applyFineChoices, combineFine, normaliseSections } from "./graphMerge";
import { clone } from "./fixtures-p2/docs";
import type { Template } from "../../../api/graph";

let prefix = "b";
const counters: Record<string, number> = {};
let restore: (kind: "row" | "col") => string;
beforeAll(() => {
  restore = setIdSource((kind) => {
    const k = `${kind}-${prefix}`;
    counters[k] = (counters[k] ?? 0) + 1;
    return `${k}${counters[k].toString(36).padStart(5, "0")}`;
  });
});
afterAll(() => { setIdSource(restore); });

const KX: SideKey = { deviceId: "d-1111", revisionId: "r-01JX" };
const KY: SideKey = { deviceId: "d-2222", revisionId: "r-01JY" };
const stored = (c: DocContent): DocContent => openContent({ doc: ensureRows(c.doc), analysis: c.analysis, figure: c.figure, scratch: c.scratch });
async function toSections(c: DocContent): Promise<SectionValues> {
  const n = await normaliseSections(sectionsOf(stored(c)) as unknown as SectionValues);
  return clone(n!.sections) as unknown as SectionValues;
}
const open = (s: SectionValues): DocContent => contentOfSections(clone(s) as unknown as Record<string, unknown>)!;
async function plan(base: SectionValues, mine: SectionValues, theirs: SectionValues, km = KX, kt = KY): Promise<CombinePlanP4> {
  const p = await combineFine({ base, baseKind: "lca", mine, theirs, mineKey: km, theirsKey: kt });
  if (!p.ok) throw new Error("unreadable");
  return p;
}
const setCells = (c: DocContent, edits: [number, number, string][], title?: [number, string]): DocContent => {
  const cells = c.doc.cells.map((row) => row.map((reps) => [...reps]));
  for (const [r, col, v] of edits) cells[r][col][0] = v;
  const row_titles = [...c.doc.row_titles];
  if (title) row_titles[title[0]] = title[1];
  return stored({ ...c, doc: { ...c.doc, cells, row_titles } });
};
/** The first row without data (the shared blank row the editor keeps). */
const firstBlank = (c: DocContent) => c.doc.cells.findIndex((row, i) => row.every((reps) => reps.every((v) => v.trim() === "")) && !c.doc.row_titles[i].trim() && !(c.doc.x[i] ?? "").trim());

async function baseOf(t: Template, f?: (c: DocContent) => DocContent): Promise<SectionValues> {
  prefix = "b";
  let c = openContent({ doc: sampleDoc(t) });
  if (f) c = stored(f(c));
  return toSections(c);
}

describe("fixer M1: both computers type into the same blank row", () => {
  it("paired column table: mine in column A, theirs in column B → two rows, an order to check, not written by itself", async () => {
    const base = await baseOf("column", (c) => ({
      ...c, analysis: { ...c.analysis, test: "paired_t" } as never,
      doc: { ...c.doc, col_titles: c.doc.col_titles.slice(0, 2), col_ids: c.doc.col_ids!.slice(0, 2), cells: c.doc.cells.map((r) => r.slice(0, 2)) },
      figure: { ...c.figure, colors: c.figure.colors.slice(0, 2), labels: c.figure.labels.slice(0, 2) },
    }));
    const bc = open(base);
    expect(bc.analysis.test).toBe("paired_t");
    const r = firstBlank(bc);
    prefix = "x"; const x = await toSections(setCells(bc, [[r, 0, "5"]]));
    prefix = "y"; const y = await toSections(setCells(bc, [[r, 1, "7"]]));
    const p = await plan(base, x, y);
    expect(p.needsChoice).toBe(false);
    expect(p.autoApplicable).toBe(false);
    expect(p.result!.orderChecks.some((o) => o.axis === "row" && o.matters)).toBe(true);
    const d = p.result!.content.doc;
    expect(d.cells[r]).toEqual([["5"], [""]]);
    expect(d.cells[r + 1]).toEqual([[""], ["7"]]);
    // The other computer gets the same bytes.
    expect((await plan(base, y, x, KY, KX)).result!.parts.contentHash).toBe(p.result!.parts.contentHash);
  });

  it("column table without a paired test: both append values → every value kept, combined by itself", async () => {
    const base = await baseOf("column");
    const bc = open(base);
    const r = firstBlank(bc);
    prefix = "x";
    let cx = bc;
    for (const [k, v] of ["m1", "m2", "m3"].entries()) cx = setCells(cx, [[r + k, 0, v]]);
    prefix = "y";
    let cy = bc;
    for (const [k, v] of ["t1", "t2"].entries()) cy = setCells(cy, [[r + k, 0, v]]);
    const [x, y] = [await toSections(cx), await toSections(cy)];
    const p = await plan(base, x, y);
    expect(p.needsChoice).toBe(false);
    expect(p.autoApplicable).toBe(true);
    const col0 = p.result!.content.doc.cells.map((row) => row[0][0]).filter((v) => /^[mt]\d$/.test(v));
    expect(col0).toEqual(["m1", "m2", "m3", "t1", "t2"]);
  });

  it("grouped table: two row titles and values in the same blank row → two rows, each with its own title and values", async () => {
    const base = await baseOf("grouped");
    const bc = open(base);
    const r = firstBlank(bc);
    prefix = "x"; const x = await toSections(setCells(bc, [[r, 0, "5"]], [r, "Mouse 7"]));
    prefix = "y"; const y = await toSections(setCells(bc, [[r, 1, "7"]], [r, "Mouse 9"]));
    const p = await plan(base, x, y);
    expect(p.needsChoice).toBe(false);
    expect(p.autoApplicable).toBe(false);
    const d = p.result!.content.doc;
    expect(d.row_titles.slice(r, r + 2)).toEqual(["Mouse 7", "Mouse 9"]);
    expect(d.cells[r][0][0]).toBe("5");
    expect(d.cells[r][1][0]).toBe("");
    expect(d.cells[r + 1][0][0]).toBe("");
    expect(d.cells[r + 1][1][0]).toBe("7");
    // Applying with no choices (there are none) gives the same.
    expect((await applyFineChoices(p, {}))!.parts.contentHash).toBe(p.result!.parts.contentHash);
  });

  it("XY table: two doses typed into the same blank row → two rows; no reading is stored at the other dose", async () => {
    const base = await baseOf("xy");
    const bc = open(base);
    const r = firstBlank(bc);
    const withX = (c: DocContent, xv: string) => { const xs = [...c.doc.x]; xs[r] = xv; return stored({ ...c, doc: { ...c.doc, x: xs } }); };
    prefix = "x"; const x = await toSections(withX(setCells(bc, [[r, 0, "5"]]), "10"));
    prefix = "y"; const y = await toSections(withX(setCells(bc, [[r, 0, "7"]]), "20"));
    const p = await plan(base, x, y);
    expect(p.needsChoice).toBe(false);
    expect(p.autoApplicable).toBe(false);
    const d = p.result!.content.doc;
    expect([d.x[r], d.cells[r][0][0]]).toEqual(["10", "5"]);
    expect([d.x[r + 1], d.cells[r + 1][0][0]]).toEqual(["20", "7"]);
  });
});
