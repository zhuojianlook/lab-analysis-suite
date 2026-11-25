/* Phase 4 composition (phase4-contract.md §2.7, checklist G1–G8): combineFine /
   applyFineChoices / peersCombineAlike / combineRevision with combine_v, on the
   phase 2 generated documents and on hand-made fine cases. */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DocContent } from "../../../store/graphStore";
import { deleteCol, insertRow, remapAnalysis, remapFigure } from "../graphModel";
import {
  COMBINE_V, type CombineChoices, type CombinePlanP4, type FineChoice, type SectionValues, type SideKey,
} from "./contract";
import { contentOfSections, makeRevision, mergeRevisionId, partsOf, sectionsOf, type Author } from "./docCodec";
import { SECTION_NAMES, type Revision, type SectionName } from "./format";
import { applyFineChoices, combine, combineFine, combineRevision, normaliseSections, peersCombineAlike } from "./graphMerge";
import { allBases, clone, countingIds, editSection, sampleSections } from "./fixtures-p2/docs";
import { rng } from "./fixtures-p2/kit";

let restoreIds: () => void;
beforeAll(() => { restoreIds = countingIds(); });
afterAll(() => restoreIds());

const author: Author = { user_name: "Alice", device_id: "d-alice", device_name: "Office iMac", session_id: "s-9", app_version: "0.2.26", platform: "macos" };
const T0 = Date.UTC(2026, 10, 25, 10);
const KA: SideKey = { deviceId: "d-aaaa", revisionId: "r-01JA" };
const KB: SideKey = { deviceId: "d-bbbb", revisionId: "r-01JB" };

async function norm(s: SectionValues): Promise<SectionValues> {
  const n = await normaliseSections(s);
  if (!n) throw new Error("not a document");
  return clone(n.sections) as unknown as SectionValues;
}
const hashOf = async (s: SectionValues) => (await normaliseSections(s))!.parts.contentHash;

async function fine(base: SectionValues | null, mine: SectionValues, theirs: SectionValues, keys: [SideKey, SideKey] = [KA, KB],
  baseKind: "lca" | "nearest" | "ambiguous" | "none" = "lca"): Promise<CombinePlanP4> {
  const out = await combineFine({ base, baseKind, mine, theirs, mineKey: keys[0], theirsKey: keys[1] });
  if (!out.ok) throw new Error("unreadable");
  return out;
}

/** Edit through the open form (as the editor does), back to file form after the pipeline. */
async function via(s: SectionValues, fn: (c: DocContent) => DocContent): Promise<SectionValues> {
  const c = contentOfSections(clone(s) as unknown as Record<string, unknown>);
  if (!c) throw new Error("not a document");
  return norm(sectionsOf(fn(c)) as unknown as SectionValues);
}
const setCell = (r: number, col: number, v: string, rep = 0) => (c: DocContent): DocContent => {
  const cells = c.doc.cells.map((row) => row.map((reps) => [...reps]));
  cells[r][col][rep] = v;
  return { ...c, doc: { ...c.doc, cells } };
};
const delCol = (col: number) => (c: DocContent): DocContent => {
  const op = { type: "delete" as const, at: col };
  return { ...c, doc: deleteCol(c.doc, col), analysis: remapAnalysis(c.analysis, c.doc.template, "col", op), figure: remapFigure(c.figure, op) };
};
const insertTop = (v: string) => (c: DocContent): DocContent => {
  const doc = insertRow(c.doc, 0);
  const cells = doc.cells.map((row, i) => (i === 0 ? row.map((reps) => reps.map((x, k) => (k === 0 ? v : x))) : row));
  const x = doc.template === "xy" ? doc.x.map((xv, i) => (i === 0 ? v : xv)) : doc.x;
  return { ...c, doc: { ...doc, cells, x }, analysis: remapAnalysis(c.analysis, doc.template, "row", { type: "insert", at: 0 }) };
};

async function sideRev(id: string, s: SectionValues, time: number, who: Author = author, v: number | null = COMBINE_V): Promise<Revision> {
  const parts = await partsOf((await normaliseSections(s))!.sections);
  const r = makeRevision({ id, parents: ["r-base"], kind: "save", time, author: who, summary: "", parts });
  return v === null ? r : { ...r, combine_v: v } as Revision;
}

const conflictIds = (p: CombinePlanP4) => p.sections.flatMap((s) => s.conflicts.map((c) => c.id)).sort();
const allChoices = (p: CombinePlanP4, side: "mine" | "theirs"): CombineChoices =>
  ({ fine: Object.fromEntries(p.sections.flatMap((s) => s.conflicts.map((c) => [c.id, side as FineChoice]))) });
const levels = (p: CombinePlanP4) => Object.fromEntries(p.sections.map((s) => [s.key, `${s.status}/${s.level}`]));

const edited = async (r: ReturnType<typeof rng>, b: SectionValues, keys: SectionName[]) => {
  const x = clone(b);
  for (const k of keys) editSection(r, x, k);
  return norm(x);
};

describe("G1 combineFine on generated documents", () => {
  it("(b,x,b) = x, (b,x,x) = x, symmetric when conflict-free, the same automatic revision from both sides, G8 re-combining", async () => {
    const r = rng(20261125);
    const bases = await Promise.all(allBases().map(norm));
    let cases = 0, conflictFree = 0, withChoice = 0, fineCount = 0;
    for (let i = 0; i < 300; i++) {
      const b = bases[i % bases.length];
      // Both sides often change the same section (combined inside), sometimes the same place (a choice).
      const kx = SECTION_NAMES.filter(() => r.chance(0.45));
      const ky = r.chance(0.6) ? [...kx] : SECTION_NAMES.filter(() => r.chance(0.45));
      const x = await edited(r, b, kx.length ? kx : ["table"]);
      const y = await edited(r, b, ky);
      const hx = await hashOf(x);
      for (const [mine, theirs] of [[x, b], [b, x], [x, x]] as const) {
        const p = await fine(b, mine, theirs);
        expect(p.needsChoice).toBe(false);
        expect(p.result!.parts.contentHash).toBe(hx);
        expect(p.result!.repairs).toEqual([]);
        expect(p.autoApplicable).toBe(true);
      }
      const pxy = await fine(b, x, y, [KA, KB]);
      const pyx = await fine(b, y, x, [KB, KA]);
      expect(conflictIds(pyx)).toEqual(conflictIds(pxy));
      expect(pyx.needsChoice).toBe(pxy.needsChoice);
      if (pxy.level === "fine") fineCount++;
      if (!pxy.needsChoice) {
        conflictFree++;
        expect(pyx.result!.parts.contentHash).toBe(pxy.result!.parts.contentHash);
        expect(pyx.autoApplicable).toBe(pxy.autoApplicable);
        const rx = await sideRev("r-01JX" + i, x, T0 + 1000);
        const ry = await sideRev("r-01JY" + i, y, T0 + 2000, { ...author, device_id: "d-bob", user_name: "Bob" });
        const a = await combineRevision({ mine: rx, theirs: ry, result: pxy.result!, auto: true });
        const c = await combineRevision({ mine: ry, theirs: rx, result: pyx.result!, auto: true });
        expect(c).toEqual(a);
        expect(JSON.stringify(c)).toBe(JSON.stringify(a));
        expect(a.combine_v).toBe(COMBINE_V);
        expect(a.id).toBe(await mergeRevisionId([rx.id, ry.id], pxy.result!.parts.contentHash));
        // G8: combining the result again with either side gives the result.
        const res = await norm(pxy.result!.sections as unknown as SectionValues);
        for (const side of [x, y]) {
          const again = await fine(side, res, side);
          expect(again.result?.parts.contentHash).toBe(pxy.result!.parts.contentHash);
        }
      } else {
        withChoice++;
        expect(pxy.result).toBeNull();
        expect(pxy.autoApplicable).toBe(false);
        // Every choice swapped gives the same bytes from the other side.
        const m = await applyFineChoices(pxy, allChoices(pxy, "mine"));
        const t = await applyFineChoices(pyx, allChoices(pyx, "theirs"));
        expect(m).not.toBeNull();
        expect(t!.parts.contentHash).toBe(m!.parts.contentHash);
      }
      cases++;
    }
    expect(cases).toBe(300);
    expect(conflictFree).toBeGreaterThan(60);
    expect(withChoice).toBeGreaterThan(20);
    expect(fineCount).toBeGreaterThan(60);
  }, 120_000);
});

describe("G2 the same as the older rules when no section is 'both'", () => {
  it("300 pairs that changed different sections: same content hash, repairs, id; never automatic where combine is not", async () => {
    const r = rng(2002);
    const bases = await Promise.all(allBases().map(norm));
    let n = 0, autoBoth = 0;
    for (let i = 0; n < 300 && i < 1000; i++) {
      const b = bases[i % bases.length];
      const ks = [...SECTION_NAMES].sort(() => r.next() - 0.5);
      const cut = 1 + r.int(3);
      const x = await edited(r, b, ks.slice(0, cut));
      const y = await edited(r, b, ks.slice(cut, cut + 1 + r.int(4 - cut)));
      const old = await combine({ base: b, baseKind: "lca", mine: x, theirs: y });
      const p = await fine(b, x, y);
      if (!old.ok) throw new Error("unreadable");
      // An edit of one section can change another one through the pipeline (a table edit that changes which
      // tests can run): such pairs are not "different sections" after all.
      if (old.sections.some((s) => s.status === "both")) { expect(p.level).toBe("fine"); continue; }
      expect(p.sections.some((s) => s.status === "both")).toBe(false);
      expect(p.level).toBe("section");
      expect(p.needsChoice).toBe(false);
      expect(p.result!.parts.contentHash).toBe(old.result!.parts.contentHash);
      expect(p.result!.parts.texts).toEqual(old.result!.parts.texts);
      expect(p.result!.repairs).toEqual(old.result!.repairs);
      expect(p.result!.from).toEqual(old.result!.from);
      expect(p.result!.mixed).toEqual([]);
      const ids = ["r-01JP" + i, "r-01JQ" + i];
      expect(await mergeRevisionId(ids, p.result!.parts.contentHash)).toBe(await mergeRevisionId(ids, old.result!.parts.contentHash));
      if (p.autoApplicable) expect(old.autoApplicable).toBe(true);
      if (p.autoApplicable && old.autoApplicable) autoBoth++;
      n++;
    }
    expect(n).toBe(300);
    expect(autoBoth).toBeGreaterThan(200);
  }, 120_000);
});

describe("G3 fine cases end to end", () => {
  it("different cells of the table: combined inside, automatic, mixed, sections_from without the table", async () => {
    const b = await norm(sampleSections("column"));
    const x = await via(b, setCell(0, 0, "11"));
    const y = await via(b, setCell(4, 1, "22"));
    const p = await fine(b, x, y);
    expect(levels(p)).toMatchObject({ table: "both/fine" });
    expect(p.level).toBe("fine");
    expect(p.needsChoice).toBe(false);
    expect(p.autoApplicable).toBe(true);
    expect(p.result!.mixed).toEqual(["table"]);
    expect(p.result!.from.table).toBe("mine");
    const t = p.result!.content.doc;
    expect(t.cells[0][0][0]).toBe("11");
    expect(t.cells[4][1][0]).toBe("22");
    const rx = await sideRev("r-01JMINE", x, T0), ry = await sideRev("r-01JTHEIRS", y, T0 + 10);
    const rev = await combineRevision({ mine: rx, theirs: ry, result: p.result!, auto: true });
    expect(rev.sections_from).toEqual({});
    expect(rev.combine_v).toBe(1);
  });

  it("the same cell: a row to choose, no result; choosing the row gives one; a whole-section choice takes that side's table", async () => {
    const b = await norm(sampleSections("column"));
    const x = await via(b, (c) => setCell(3, 2, "9")(setCell(0, 0, "11")(c)));
    const y = await via(b, setCell(0, 0, "33"));
    const p = await fine(b, x, y);
    expect(p.needsChoice).toBe(true);
    expect(p.result).toBeNull();
    const tbl = p.sections.find((s) => s.key === "table")!;
    expect(tbl.level).toBe("fine");
    expect(tbl.conflicts).toHaveLength(1);
    expect(tbl.conflicts[0]).toMatchObject({ section: "table", kind: "row" });
    expect(tbl.conflicts[0].id).toBe(`table:row:${(b.table as { row_ids: string[] }).row_ids[0]}`);
    expect(await applyFineChoices(p, {})).toBeNull();
    const r = await applyFineChoices(p, { fine: { [tbl.conflicts[0].id]: "theirs" } });
    expect(r!.content.doc.cells[0][0][0]).toBe("33");
    expect(r!.content.doc.cells[3][2][0]).toBe("9");
    expect(r!.mixed).toEqual(["table"]);
    const whole = await applyFineChoices(p, { sections: { table: "theirs" } });
    expect(whole!.parts.refs.table.sha256).toBe(p.theirs.parts.refs.table.sha256);
    expect(whole!.from.table).toBe("theirs");
    expect(whole!.mixed).toEqual([]);
    // A choice that is not among the options counts as none.
    expect(await applyFineChoices(p, { fine: { [tbl.conflicts[0].id]: "both" } })).toBeNull();
  });
});

describe("G4 across sections", () => {
  it("mine deletes a column, theirs adds a pair naming it: a result with a setting adjustment, not automatic", async () => {
    const b = await norm(sampleSections("column"));
    const ids = (b.table as { col_ids: string[] }).col_ids;
    const x = await via(b, delCol(2));
    const yRaw = clone(b);
    (yRaw.analysis as { pairs: string[][] }).pairs = [[ids[0], ids[2]]];
    const y = await norm(yRaw);
    expect((y.analysis as { pairs: string[][] }).pairs).toEqual([[ids[0], ids[2]]]);
    const p = await fine(b, x, y);
    expect(p.needsChoice).toBe(false);
    expect(p.result).not.toBeNull();
    expect(p.result!.adjustments.some((a) => a.kind === "setting" && a.section === "analysis" && a.field === "pairs")).toBe(true);
    expect(p.autoApplicable).toBe(false);
  });

  it("mine deletes a column, theirs recolours another column and edits a cell: automatic", async () => {
    const b = await norm(sampleSections("column"));
    const ids = (b.table as { col_ids: string[] }).col_ids;
    const x = await via(b, delCol(2));
    const yRaw = await via(b, setCell(5, 0, "7.5"));
    (yRaw.figure as { series: Record<string, { color: string }> }).series[ids[1]].color = "#123456";
    const y = await norm(yRaw);
    const p = await fine(b, x, y);
    expect(p.needsChoice).toBe(false);
    expect(p.result!.adjustments).toEqual([]);
    expect(p.autoApplicable).toBe(true);
    const c = p.result!.content;
    expect(c.doc.col_ids).toEqual(ids.slice(0, 2));
    expect(c.doc.cells[5][0][0]).toBe("7.5");
    expect(c.figure.colors[1]).toBe("#123456");
  });
});

describe("G5 order checks", () => {
  it("XY: both inserted a row at the top → not automatic; column table → automatic; with a paired test → not", async () => {
    const bxy = await norm(sampleSections("xy"));
    const pxy = await fine(bxy, await via(bxy, insertTop("3")), await via(bxy, insertTop("4")));
    expect(pxy.needsChoice).toBe(false);
    expect(pxy.result!.orderChecks.some((o) => o.axis === "row" && o.matters && o.ids.length === 2)).toBe(true);
    expect(pxy.autoApplicable).toBe(false);

    const bc = await norm(sampleSections("column"));
    const pc = await fine(bc, await via(bc, insertTop("3")), await via(bc, insertTop("4")));
    expect(pc.needsChoice).toBe(false);
    expect(pc.result!.orderChecks.every((o) => !o.matters)).toBe(true);
    expect(pc.autoApplicable).toBe(true);

    // The same column table (two columns) with a paired test.
    const b2 = await via(bc, (c) => ({ ...delCol(2)(c), analysis: { ...delCol(2)(c).analysis, test: "paired_t" } }));
    expect((b2.analysis as { test: string }).test).toBe("paired_t");
    const s3 = await via(b2, insertTop("3")), s4 = await via(b2, insertTop("4"));
    const pp = await fine(b2, s3, s4);
    expect(pp.needsChoice).toBe(false);
    expect(pp.result!.orderChecks.some((o) => o.axis === "row" && o.matters)).toBe(true);
    expect(pp.autoApplicable).toBe(false);
    // Swapped sides: the same order (decided by the device ids, not by who is "mine").
    const pq = await fine(b2, s4, s3, [KB, KA]);
    expect(pq.result!.parts.contentHash).toBe(pp.result!.parts.contentHash);
  });
});

describe("G6 two-way and other bases", () => {
  it("no common version: every differing section one whole choice (twoWay); ambiguous / nearest: fine, never automatic", async () => {
    const b = await norm(sampleSections("grouped"));
    const x = await via(b, setCell(0, 0, "5", 1));
    const yRaw = await via(b, setCell(2, 1, "6", 2));
    (yRaw.figure as { title: string }).title = "Other";
    const y = await norm(yRaw);
    const p = await fine(null, x, y, [KA, KB], "none");
    expect(p.twoWay).toBe(true);
    expect(p.autoApplicable).toBe(false);
    for (const s of p.sections) {
      if (s.status === "same") { expect(s.conflicts).toEqual([]); continue; }
      expect(s.level).toBe("whole");
      expect(s.conflicts).toEqual([{ id: `${s.key}:section`, section: s.key, kind: "section", reason: "twoWay", options: ["mine", "theirs"], items: [], more: 0 }]);
    }
    const r = await applyFineChoices(p, { fine: { "table:section": "theirs", "figure:section": "mine" } });
    expect(r!.parts.refs.table.sha256).toBe(p.theirs.parts.refs.table.sha256);
    expect(r!.parts.refs.figure.sha256).toBe(p.mine.parts.refs.figure.sha256);
    for (const kind of ["ambiguous", "nearest"] as const) {
      const q = await fine(b, x, await via(b, setCell(2, 1, "6", 2)), [KA, KB], kind);
      expect(q.level).toBe("fine");
      expect(q.needsChoice).toBe(false);
      expect(q.result).not.toBeNull();
      expect(q.autoApplicable).toBe(false);
    }
  });
});

describe("G7 peersCombineAlike", () => {
  it("both 1 → true; one missing → false; one 2 → false", async () => {
    const s = await norm(sampleSections("column"));
    const a = await sideRev("r-1", s, T0), b = await sideRev("r-2", s, T0);
    expect(peersCombineAlike(a, b)).toBe(true);
    expect(peersCombineAlike(a, await sideRev("r-3", s, T0, author, null))).toBe(false);
    expect(peersCombineAlike(await sideRev("r-4", s, T0, author, null), b)).toBe(false);
    expect(peersCombineAlike(a, await sideRev("r-5", s, T0, author, 2))).toBe(false);
  });
});

describe("combineRevision legacy form", () => {
  it("an older app's combine has no combine_v and otherwise the same object and id", async () => {
    const b = await norm(sampleSections("column"));
    const x = await via(b, setCell(0, 0, "1")), y = await via(b, setCell(1, 0, "2"));
    const p = await fine(b, x, y);
    const rx = await sideRev("r-01JX", x, T0), ry = await sideRev("r-01JY", y, T0 + 5);
    const n = await combineRevision({ mine: rx, theirs: ry, result: p.result!, auto: false, author, time: T0 + 9 });
    const o = await combineRevision({ mine: rx, theirs: ry, result: p.result!, auto: false, author, time: T0 + 9, legacy: true });
    expect(n.combine_v).toBe(1);
    expect("combine_v" in o).toBe(false);
    expect(n.id).toBe(o.id);
    expect({ ...o, combine_v: 1 }).toEqual(n);
  });
});
