import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openContent } from "../../../store/graphStore";
import { deleteCol, sampleDoc } from "../graphModel";
import { LIMITS_P2, SUMMARY, type CombinePlan, type SectionValues } from "./contract";
import { makeRevision, mergeRevisionId, partsOf, sectionsOf, type Author } from "./docCodec";
import { SECTION_NAMES, type Revision, type SectionName } from "./format";
import { applyChoices, combine, combineDelayMs, combineRevision, normaliseSections } from "./graphMerge";
import { allBases, clone, countingIds, editSection, sampleSections } from "./fixtures-p2/docs";
import { rng } from "./fixtures-p2/kit";

let restoreIds: () => void;
beforeAll(() => { restoreIds = countingIds(); });
afterAll(() => restoreIds());

const author: Author = { user_name: "Alice", device_id: "d-alice", device_name: "Office iMac", session_id: "s-9", app_version: "0.2.21", platform: "macos" };
const T = Date.UTC(2026, 10, 22, 10);

/** The file form after the load pipeline (a fixed point). */
async function norm(s: SectionValues): Promise<SectionValues> {
  const n = await normaliseSections(s);
  if (!n) throw new Error("not a document");
  return clone(n.sections) as unknown as SectionValues;
}

async function hashOf(s: SectionValues): Promise<string> {
  return (await normaliseSections(s))!.parts.contentHash;
}

async function plan(base: SectionValues | null, mine: SectionValues, theirs: SectionValues, baseKind: "lca" | "nearest" | "ambiguous" | "none" = "lca"): Promise<CombinePlan> {
  const out = await combine({ base, baseKind, mine, theirs });
  if (!out.ok) throw new Error("unreadable");
  return out;
}

const statuses = (p: CombinePlan) => Object.fromEntries(p.sections.map((s) => [s.key, s.status]));

/** A revision for one side, with the side's stored section refs. */
async function sideRev(id: string, s: SectionValues, time: number, who: Author = author): Promise<Revision> {
  const parts = await partsOf((await normaliseSections(s))!.sections);
  return makeRevision({ id, parents: ["r-base"], kind: "save", time, author: who, summary: "", parts });
}

const edited = async (r: ReturnType<typeof rng>, b: SectionValues, keys: SectionName[]) => {
  const x = clone(b);
  for (const k of keys) editSection(r, x, k);
  return norm(x);
};

describe("M8 properties over generated documents", () => {
  it("combine(b,x,b) = x; combine(b,b,x) = x; combine(b,x,x) = x; conflict-free is symmetric; same id from both sides", async () => {
    const r = rng(20261122);
    const bases = await Promise.all(allBases().map(norm));
    let cases = 0, conflictFree = 0, withChoice = 0;
    for (let i = 0; i < 240; i++) {
      const b = bases[i % bases.length];
      const pickKeys = () => SECTION_NAMES.filter(() => r.chance(0.4));
      const kx = pickKeys(), ky = r.chance(0.5) ? SECTION_NAMES.filter((k) => !kx.includes(k) && r.chance(0.5)) : pickKeys();
      const x = await edited(r, b, kx.length ? kx : ["table"]);
      const y = await edited(r, b, ky);
      const hx = await hashOf(x);

      for (const [mine, theirs] of [[x, b], [b, x], [x, x]] as const) {
        const p = await plan(b, mine, theirs);
        expect(p.needsChoice).toBe(false);
        expect(p.result!.parts.contentHash).toBe(hx);
        expect(p.result!.repairs).toEqual([]);
        expect(p.autoApplicable).toBe(true);
      }

      const pxy = await plan(b, x, y), pyx = await plan(b, y, x);
      expect(pxy.needsChoice).toBe(pyx.needsChoice);
      const mirror = { same: "same", mine: "theirs", theirs: "mine", both: "both" } as const;
      for (let k = 0; k < 4; k++) expect(pyx.sections[k].status).toBe(mirror[pxy.sections[k].status]);
      if (!pxy.needsChoice) {
        conflictFree++;
        expect(pyx.result!.parts.contentHash).toBe(pxy.result!.parts.contentHash);
        expect(pyx.result!.repairs).toEqual(pxy.result!.repairs);
        // Any automatic repair means somebody looks first.
        expect(pxy.autoApplicable).toBe(pxy.result!.repairs.length === 0);
        // The same automatic combine whichever computer works it out.
        const rx = await sideRev("r-01JX" + i, x, T + 1000, author);
        const ry = await sideRev("r-01JY" + i, y, T + 2000, { ...author, device_id: "d-bob", user_name: "Bob" });
        const a = await combineRevision({ mine: rx, theirs: ry, result: pxy.result!, auto: true });
        const c = await combineRevision({ mine: ry, theirs: rx, result: pyx.result!, auto: true });
        expect(c).toEqual(a);
        expect(JSON.stringify(c)).toBe(JSON.stringify(a));
        expect(a.id).toBe(await mergeRevisionId([rx.id, ry.id], pxy.result!.parts.contentHash));
      } else {
        withChoice++;
        expect(pxy.result).toBeNull();
        expect(pxy.autoApplicable).toBe(false);
        // Choosing gives each side's section where chosen.
        const allMine = await applyChoices(pxy, Object.fromEntries(SECTION_NAMES.map((k) => [k, "mine"])));
        if (allMine && !allMine.repairs.length) expect(allMine.parts.contentHash).toBe(await hashOf(x));
      }
      cases++;
    }
    expect(cases).toBeGreaterThanOrEqual(200);
    expect(conflictFree).toBeGreaterThan(40);
    expect(withChoice).toBeGreaterThan(20);
  }, 60_000);

  it("two-way: a section is taken only where both sides agree", async () => {
    const r = rng(9);
    const b = await norm(sampleSections("grouped"));
    const x = await edited(r, b, ["table"]);
    const p = await plan(null, x, b, "none");
    expect(p.twoWay).toBe(true);
    expect(p.baseKind).toBe("none");
    expect(statuses(p)).toEqual({ table: "both", analysis: "same", figure: "same", scratchpad: "same" });
    expect(p.autoApplicable).toBe(false);
  });
});

describe("M9 section statuses", () => {
  it("same / mine / theirs / both, three-way", async () => {
    const r = rng(3);
    const b = await norm(sampleSections("column"));
    const x = clone(b), y = clone(b);
    editSection(r, x, "table");
    editSection(r, y, "figure");
    (x.analysis as { alpha: number }).alpha = 0.01;
    (y.analysis as { alpha: number }).alpha = 0.1;
    const p = await plan(b, x, y);
    expect(statuses(p)).toEqual({ table: "mine", analysis: "both", figure: "theirs", scratchpad: "same" });
    expect(p.sections.map((s) => s.pick)).toEqual(["mine", null, "theirs", "mine"]);
    expect(p.sections.map((s) => s.autoResolvable)).toEqual([true, false, true, true]);
    expect(p.needsChoice).toBe(true);
    expect(p.twoWay).toBe(false);
    expect(p.mine.sections.table).toEqual(x.table);
    expect(p.base).not.toBeNull();
  });

  it("both sides making the same change → same", async () => {
    const b = await norm(sampleSections("xy"));
    const x = clone(b), y = clone(b);
    (x.figure as { title: string }).title = "Dose response";
    (y.figure as { title: string }).title = "Dose response";
    const p = await plan(b, x, y);
    expect(statuses(p).figure).toBe("same");
    expect(p.autoApplicable).toBe(true);
  });

  it("two-way: differing sections are both, equal ones same; the base kind follows", async () => {
    const b = await norm(sampleSections("column"));
    const x = clone(b), y = clone(b);
    (x.figure as { title: string }).title = "A";
    const p = await plan(null, x, y, "lca");
    expect(p.twoWay).toBe(true);
    expect(p.baseKind).toBe("none");
    expect(statuses(p)).toEqual({ table: "same", analysis: "same", figure: "both", scratchpad: "same" });
    // A base that does not normalise counts as none.
    const q = await plan({ table: "nope", analysis: null, figure: null, scratchpad: null }, x, y, "lca");
    expect(q.twoWay).toBe(true);
    expect(q.base).toBeNull();
    // ambiguous / nearest: three-way presets, but never automatic.
    const z = clone(b);
    (z.analysis as { alpha: number }).alpha = 0.01;
    for (const kind of ["ambiguous", "nearest"] as const) {
      const s = await plan(b, x, z, kind);
      expect(s.needsChoice).toBe(false);
      expect(s.result).not.toBeNull();
      expect(s.autoApplicable).toBe(false);
    }
  });

  it("an unreadable side → ok: false naming it", async () => {
    const b = await norm(sampleSections("column"));
    const bad = { table: { v: 9 }, analysis: {}, figure: {}, scratchpad: null };
    expect(await combine({ base: b, baseKind: "lca", mine: bad, theirs: b })).toEqual({ ok: false, reason: "unreadable", side: "mine" });
    expect(await combine({ base: b, baseKind: "lca", mine: b, theirs: bad })).toEqual({ ok: false, reason: "unreadable", side: "theirs" });
    expect(await normaliseSections(null as never)).toBeNull();
  });
});

describe("M10 repairs", () => {
  /** A column table with four filled columns (so deleting one keeps the test valid). */
  async function fourCols(): Promise<SectionValues> {
    const d = sampleDoc("column");
    const doc = { ...d, col_titles: [...d.col_titles, "Treatment 3"], col_ids: [...d.col_ids, "col-extra0001"],
      cells: d.cells.map((row, i) => [...row, [i < 10 ? String(5 + i / 10) : ""]]) };
    return norm(clone(sectionsOf(openContent({ doc }))) as unknown as SectionValues);
  }

  it("mine deletes a column, theirs points the analysis at it → a result with a repair, not automatic", async () => {
    const b = await fourCols();
    const victim = (b.table as { col_ids: string[] }).col_ids[3];
    const keep = (b.table as { col_ids: string[] }).col_ids[0];
    const openB = (await normaliseSections(b))!.content;
    const mine = await norm(clone(sectionsOf({ ...openB, doc: deleteCol(openB.doc, 3), figure: { ...openB.figure, colors: openB.figure.colors.slice(0, 3), labels: openB.figure.labels.slice(0, 3) } })) as unknown as SectionValues);
    const theirs = clone(b);
    (theirs.analysis as { pairs: [string, string][] }).pairs = [[keep, victim]];
    const t2 = await norm(theirs);
    expect((t2.analysis as { pairs: unknown[] }).pairs).toEqual([[keep, victim]]);
    const p = await plan(b, mine, t2);
    expect(statuses(p)).toEqual({ table: "mine", analysis: "theirs", figure: "mine", scratchpad: "same" });
    expect(p.needsChoice).toBe(false);
    expect(p.result!.repairs).toEqual(["analysis"]);
    expect((p.result!.sections.analysis as { pairs: unknown[] }).pairs).toEqual([]);
    expect(p.autoApplicable).toBe(false);
  });

  it("mine deletes a column, theirs recolours that column's series → the graph needs a choice; taking theirs is adjusted", async () => {
    const b = await fourCols();
    const victim = (b.table as { col_ids: string[] }).col_ids[3];
    const openB = (await normaliseSections(b))!.content;
    const mine = await norm(clone(sectionsOf({ ...openB, doc: deleteCol(openB.doc, 3), figure: { ...openB.figure, colors: openB.figure.colors.slice(0, 3), labels: openB.figure.labels.slice(0, 3) } })) as unknown as SectionValues);
    const theirs = clone(b);
    (theirs.figure as { series: Record<string, { color: string }> }).series[victim].color = "#123456";
    const p = await plan(b, mine, await norm(theirs));
    // Deleting a column drops its series entry too, so both sides changed the graph.
    expect(statuses(p)).toEqual({ table: "mine", analysis: "same", figure: "both", scratchpad: "same" });
    expect(p.autoApplicable).toBe(false);
    const res = await applyChoices(p, { figure: "theirs" });
    expect(res!.repairs).toEqual(["figure"]);
    expect(res!.from.figure).toBe("theirs");
    // The adjusted graph is mine's (the recoloured series has no column any more).
    expect(res!.parts.refs.figure.sha256).toBe(p.mine.parts.refs.figure.sha256);
  });

  it("property: whenever the pipeline adjusts the result, it is never applied automatically", async () => {
    const r = rng(1010);
    let repaired = 0;
    for (let i = 0; i < 30; i++) {
      const b = await fourCols();
      const ids = (b.table as { col_ids: string[] }).col_ids;
      const del = 1 + r.int(ids.length - 1);
      const openB = (await normaliseSections(b))!.content;
      const keepIdx = [...openB.figure.colors.keys()].filter((k) => k !== del);
      const mine = await norm(clone(sectionsOf({ ...openB, doc: deleteCol(openB.doc, del),
        figure: { ...openB.figure, colors: keepIdx.map((k) => openB.figure.colors[k]), labels: keepIdx.map((k) => openB.figure.labels[k]) } })) as unknown as SectionValues);
      const theirs = clone(b);
      (theirs.analysis as { pairs: [string, string][] }).pairs = [[ids[0], ids[del]]];
      if (r.chance(0.5)) editSection(r, theirs, "scratchpad");
      const p = await plan(b, mine, await norm(theirs));
      if (p.result && p.result.repairs.length) repaired++;
      expect(p.autoApplicable).toBe(!!p.result && p.result.repairs.length === 0 && !p.needsChoice);
      expect(p.result?.repairs ?? []).toContain("analysis");
    }
    expect(repaired).toBe(30);
  });

  it("mine edits cells, theirs changes the title → no repair, automatic", async () => {
    const r = rng(4);
    const b = await norm(sampleSections("column"));
    const x = clone(b);
    editSection(r, x, "table");
    const y = clone(b);
    (y.figure as { title: string }).title = "Plant growth";
    const p = await plan(b, await norm(x), await norm(y));
    expect(p.result!.repairs).toEqual([]);
    expect(p.autoApplicable).toBe(true);
    expect(p.result!.from).toEqual({ table: "mine", analysis: "same", figure: "theirs", scratchpad: "same" });
    expect((p.result!.sections.figure as { title: string }).title).toBe("Plant growth");
    expect(p.result!.sections.table).toEqual((await normaliseSections(x))!.sections.table);
  });
});

describe("M11 one pipeline for every side", () => {
  it("a section stored in an older form (a field the defaults add is missing) is the same as the current form", async () => {
    const b = await norm(sampleSections("column"));
    const old = clone(b);
    const fig = old.figure as Record<string, unknown>;
    delete fig.show_legend;
    delete fig.fig_label;
    delete fig.palette;
    delete fig.palette_reverse;
    const tbl = old.table as Record<string, unknown>;
    tbl.v = 1;                                      // a table written before the id-map format number
    const n = await normaliseSections(old);
    expect(n!.parts.refs.figure.sha256).toBe((await normaliseSections(b))!.parts.refs.figure.sha256);
    const y = clone(b);
    (y.figure as { title: string }).title = "New";
    const p = await plan(b, old, await norm(y));
    expect(statuses(p)).toEqual({ table: "same", analysis: "same", figure: "theirs", scratchpad: "same" });
    const q = await plan(old, b, b);
    expect(q.sections.every((s) => s.status === "same")).toBe(true);
  });
});

describe("M12 applyChoices", () => {
  it("all mine = mine, all theirs = theirs, a missing choice → null, an overridden preset is honoured", async () => {
    const r = rng(12);
    const b = await norm(sampleSections("grouped"));
    const x = clone(b), y = clone(b);
    editSection(r, x, "table");
    (x.figure as { title: string }).title = "Mine";
    (y.figure as { title: string }).title = "Theirs";
    y.scratchpad = { v: 1, cells: [[1, 1, "42"]] };
    const p = await plan(b, await norm(x), await norm(y));
    expect(statuses(p)).toEqual({ table: "mine", analysis: "same", figure: "both", scratchpad: "theirs" });
    expect(await applyChoices(p, {})).toBeNull();
    const all = (side: "mine" | "theirs") => Object.fromEntries(SECTION_NAMES.map((k) => [k, side]));
    expect((await applyChoices(p, all("mine")))!.parts.contentHash).toBe(p.mine.parts.contentHash);
    expect((await applyChoices(p, all("theirs")))!.parts.contentHash).toBe(p.theirs.parts.contentHash);
    const one = await applyChoices(p, { figure: "theirs" });
    expect(one!.from).toEqual({ table: "mine", analysis: "same", figure: "theirs", scratchpad: "theirs" });
    expect((one!.sections.figure as { title: string }).title).toBe("Theirs");
    expect(one!.sections.scratchpad).toEqual({ v: 1, cells: [[1, 1, "42"]] });
    // Overriding a preset: keep my scratchpad although only theirs changed it.
    const two = await applyChoices(p, { figure: "mine", scratchpad: "mine" });
    expect(two!.from.scratchpad).toBe("mine");
    expect(two!.sections.scratchpad).toEqual(p.mine.sections.scratchpad);
    // The result does not share objects with the sides.
    expect(one!.sections.table).not.toBe(p.mine.sections.table);
  });
});

describe("M13 the id of a combined version", () => {
  it("hand-computed vector; parents in either order", async () => {
    const a = "r-01HZZZZZZZZZZZZZZZZZZZZZZA", b = "r-01HAAAAAAAAAAAAAAAAAAAAAAB";
    const h = "0123456789abcdef".repeat(4);
    const expected = "r-m-6c374144188e2dddd331fec414";
    expect(await mergeRevisionId([a, b], h)).toBe(expected);
    expect(await mergeRevisionId([b, a], h)).toBe(expected);
    // The exact bytes: the sorted parents and the content hash joined by "\n", UTF-8, nothing else
    // (the expected value above was computed outside the app with `shasum -a 256`).
    const buf = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${b}\n${a}\n${h}`));
    const direct = [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 26);
    expect(expected).toBe(`r-m-${direct}`);
  });
});

describe("M14 combineRevision", () => {
  async function setup() {
    const r = rng(14);
    const b = await norm(sampleSections("column"));
    const x = clone(b), y = clone(b);
    editSection(r, x, "table");
    (y.figure as { title: string }).title = "T";
    const p = await plan(b, await norm(x), await norm(y));
    const mine = await sideRev("r-01JMINE00000000000000000", x, T + 5000);
    const theirs = await sideRev("r-01JAAAA00000000000000000", y, T + 9000, { ...author, device_id: "d-bob", user_name: "Bob", device_name: "MacBook" });
    return { p, mine, theirs };
  }

  it("automatic form: blank author, sorted parents, the later time, sections_from", async () => {
    const { p, mine, theirs } = await setup();
    const rv = await combineRevision({ mine, theirs, result: p.result!, auto: true, author, time: T + 99999 });
    expect(rv.parents).toEqual([theirs.id, mine.id]);
    expect(rv.id).toBe(await mergeRevisionId([mine.id, theirs.id], p.result!.parts.contentHash));
    expect(rv.id.startsWith("r-m-")).toBe(true);
    expect(rv.id.length).toBe(4 + 26);
    expect([rv.user_name, rv.device_id, rv.device_name, rv.session_id, rv.app_version]).toEqual(["", "", "", "", ""]);
    expect(rv.time).toBe(theirs.time);
    expect(rv.kind).toBe("merge");
    expect(rv.auto).toBe(true);
    expect(rv.summary).toBe(SUMMARY.combinedAuto);
    expect(rv.sections).toEqual(p.result!.parts.refs);
    expect(rv.content_hash).toBe(p.result!.parts.contentHash);
    expect(rv.sections_from).toEqual({ table: mine.id, figure: theirs.id });
    // Phase 4 §2.7.3: plus the rules' version (left out only when playing an older app).
    expect(Object.keys(rv)).toEqual(["id", "parents", "time", "user_name", "device_id", "device_name", "session_id", "app_version", "kind", "summary", "sections", "content_hash", "auto", "sections_from", "combine_v"]);
    expect(rv.combine_v).toBe(1);
    const old = await combineRevision({ mine, theirs, result: p.result!, auto: true, author, time: T + 99999, legacy: true });
    expect("combine_v" in old).toBe(false);
    expect({ ...old, combine_v: 1 }).toEqual(rv);
  });

  it("chosen form carries the author and time; no auto key; a repaired section is left out of sections_from", async () => {
    const { p, mine, theirs } = await setup();
    const rv = await combineRevision({ mine, theirs, result: p.result!, auto: false, author, time: T });
    expect(rv.user_name).toBe("Alice");
    expect(rv.device_id).toBe("d-alice");
    expect(rv.device_name).toBe("Office iMac");
    expect(rv.session_id).toBe("s-9");
    expect(rv.app_version).toBe("0.2.21");
    expect(rv.time).toBe(new Date(T).toISOString());
    expect(rv.summary).toBe(SUMMARY.combinedChosen);
    expect("auto" in rv).toBe(false);
    expect(rv.parents).toEqual([theirs.id, mine.id]);
    const repaired = { ...p.result!, parts: { ...p.result!.parts, refs: { ...p.result!.parts.refs, table: { ...p.result!.parts.refs.table, sha256: "f".repeat(64) } } } };
    const rv2 = await combineRevision({ mine, theirs, result: repaired, auto: false, author, time: T });
    expect(rv2.sections_from).toEqual({ figure: theirs.id });
    await expect(combineRevision({ mine, theirs, result: p.result!, auto: false })).rejects.toThrow();
  });
});

describe("M15 combineDelayMs", () => {
  it("within 2000–10000, stable per id, different for two ids", async () => {
    expect(await combineDelayMs("d-a")).toBe(5530);
    expect(await combineDelayMs("d-b")).toBe(2422);
    expect(await combineDelayMs("d-a")).toBe(5530);
    const r = rng(15);
    for (let i = 0; i < 200; i++) {
      const d = await combineDelayMs(`d-${r.int(1e9)}`);
      expect(d).toBeGreaterThanOrEqual(LIMITS_P2.combineDelayMinMs);
      expect(d).toBeLessThanOrEqual(LIMITS_P2.combineDelayMaxMs);
      expect(Number.isInteger(d)).toBe(true);
    }
  });
});
