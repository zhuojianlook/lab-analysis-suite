/* Phase 4 contract §2.3, §2.4, §2.6, §8 F1–F7: the analysis and graph settings
   combined field by field, and the automatic adjustments. Fixtures plus seeded
   property tests over generated settings (no fast-check in this project). */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PALETTES } from "../graphModel";
import { LIMITS_P4, type FineChoices, type FineConflict, type FineMerge, type NormalisedSide, type SectionValues } from "./contract";
import { canonicalJson } from "./format";
import type { FileAnalysis, FileFigure, FileTable } from "./idMap";
import { normaliseSections } from "./graphMerge";
import { detectAdjustments, mergeAnalysis, mergeFigure, shortText } from "./mergeFields";
import { allBases, clone, countingIds, sampleSections } from "./fixtures-p2/docs";
import { rng, type Rng } from "./fixtures-p2/kit";

let restoreIds: () => void;
beforeAll(() => { restoreIds = countingIds(); });
afterAll(() => restoreIds());

type Obj = Record<string, unknown>;
const C = (v: unknown) => canonicalJson(v);

async function normSide(s: SectionValues): Promise<NormalisedSide> {
  const n = await normaliseSections(s);
  if (!n) throw new Error("not a document");
  return n;
}
async function norm(s: SectionValues): Promise<SectionValues> {
  return clone((await normSide(s)).sections) as unknown as SectionValues;
}

const swapChoice = (c: FineChoices): FineChoices =>
  Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v === "mine" ? "theirs" : v === "theirs" ? "mine" : v]));
const allChoices = (cs: FineConflict[], side: "mine" | "theirs"): FineChoices => Object.fromEntries(cs.map((c) => [c.id, side]));
const swapFrom = (f: string) => (f === "mine" ? "theirs" : f === "theirs" ? "mine" : f);

/** The symmetry rule §2.1.4 for one module. */
function expectSymmetric<T>(a: FineMerge<T>, b: FineMerge<T>) {
  expect(b.conflicts.map((c) => c.id)).toEqual(a.conflicts.map((c) => c.id));
  for (let i = 0; i < a.conflicts.length; i++) {
    const x = a.conflicts[i], y = b.conflicts[i];
    expect(y.items.map((it) => ({ ...it, mine: it.theirs, theirs: it.mine }))).toEqual(x.items);
    expect(y.deletedBy).toEqual(x.deletedBy === undefined ? undefined : swapFrom(x.deletedBy));
  }
  expect(b.combined).toBe(a.combined);
  expect(b.auto.map((x) => ({ ...x, from: swapFrom(x.from) }))).toEqual(a.auto);
  if (a.conflicts.length === 0) expect(C(b.value)).toBe(C(a.value));
}

// ═════════════════════════════════════════════════════════════════════════════
// Analysis
// ═════════════════════════════════════════════════════════════════════════════

const baseAnalysis = () => ({
  test: "anova", posthoc: "tukey", compare: "all", control: null as string | null, pairs: [["col-a", "col-b"], ["col-b", "col-c"]],
  alpha: 0.05, within: "rows", family: "all", correlation: "none",
});

const A = (b: Obj, m: Obj, t: Obj, ch?: FineChoices) =>
  mergeAnalysis({ base: b as unknown as FileAnalysis, mine: m as unknown as FileAnalysis, theirs: t as unknown as FileAnalysis }, ch) as unknown as FineMerge<Obj>;

describe("F1 analysis: per field", () => {
  it("one side's change is taken; both alike → same; both differently → a conflict per field", () => {
    const b = baseAnalysis();
    const m1 = A(b, { ...b, alpha: 0.01 }, b);
    expect(m1.conflicts).toEqual([]);
    expect((m1.value as Obj).alpha).toBe(0.01);
    expect(m1.auto).toEqual([{ what: "field", field: "alpha", from: "mine", before: "0.05", after: "0.01" }]);
    expect(m1.combined).toBe(1);

    const t1 = A(b, b, { ...b, family: "per_row" });
    expect(t1.auto).toEqual([{ what: "field", field: "family", from: "theirs", before: "all", after: "per_row" }]);

    const same = A(b, { ...b, alpha: 0.01 }, { ...b, alpha: 0.01 });
    expect(same.conflicts).toEqual([]);
    expect(same.auto[0].from).toBe("same");

    const both = A(b, { ...b, alpha: 0.01, family: "per_row" }, { ...b, alpha: 0.1 });
    expect(both.value).toBeNull();
    expect(both.conflicts).toEqual([{
      id: "analysis:field:alpha", section: "analysis", kind: "field", field: "alpha", options: ["mine", "theirs"],
      items: [{ what: "field", field: "alpha", base: "0.05", mine: "0.01", theirs: "0.1" }], more: 0,
    }]);
    expect(both.combined).toBe(1);   // family, from mine
    expect((A(b, { ...b, alpha: 0.01, family: "per_row" }, { ...b, alpha: 0.1 }, { "analysis:field:alpha": "theirs" }).value as Obj))
      .toMatchObject({ alpha: 0.1, family: "per_row" });
    expect((A(b, { ...b, alpha: 0.01 }, { ...b, alpha: 0.1 }, { "analysis:field:alpha": "mine" }).value as Obj).alpha).toBe(0.01);
    // "both" is not an option here, an unknown word neither: no choice.
    expect(A(b, { ...b, alpha: 0.01 }, { ...b, alpha: 0.1 }, { "analysis:field:alpha": "both" }).value).toBeNull();
    expect(A(b, { ...b, alpha: 0.01 }, { ...b, alpha: 0.1 }, { "analysis:field:alpha": "x" as never }).value).toBeNull();
    // A choice for another id does not count.
    expect(A(b, { ...b, alpha: 0.01 }, { ...b, alpha: 0.1 }, { "figure:field:alpha": "mine" }).value).toBeNull();
  });

  it("conflicts come in sorted field order; all are returned whatever the choices", () => {
    const b = baseAnalysis();
    const m = { ...b, within: "columns", alpha: 0.01, test: "kruskal" };
    const t = { ...b, within: "rows2", alpha: 0.1, test: "welch_anova" };
    const r = A(b, m, t, { "analysis:field:alpha": "mine" });
    expect(r.conflicts.map((c) => c.id)).toEqual(["analysis:field:alpha", "analysis:field:test", "analysis:field:within"]);
    expect(r.value).toBeNull();
    const all = A(b, m, t, allChoices(r.conflicts, "theirs"));
    expect(all.value).toMatchObject({ alpha: 0.1, test: "welch_anova", within: "rows2" });
  });

  it("a field this app does not know is carried; 'not there' is a value of its own", () => {
    const b = baseAnalysis();
    expect((A(b, { ...b, zz: { q: 1 } }, b).value as Obj).zz).toEqual({ q: 1 });
    expect((A(b, b, { ...b, zz: 7 }).value as Obj).zz).toBe(7);
    const withZ = { ...b, zz: 1 };
    const { zz: _z, ...noZ } = withZ;
    // One side removed it, the other left it → removed.
    expect(Object.prototype.hasOwnProperty.call(A(withZ, noZ, withZ).value, "zz")).toBe(false);
    // One removed it, the other changed it → a conflict whose mine side is "not there".
    const r = A(withZ, noZ, { ...b, zz: 2 });
    expect(r.conflicts[0]).toMatchObject({ id: "analysis:field:zz", items: [{ base: "1", mine: null, theirs: "2" }] });
    expect(Object.prototype.hasOwnProperty.call(A(withZ, noZ, { ...b, zz: 2 }, { "analysis:field:zz": "mine" }).value, "zz")).toBe(false);
    expect((A(withZ, noZ, { ...b, zz: 2 }, { "analysis:field:zz": "theirs" }).value as Obj).zz).toBe(2);
  });

  it("the result shares nothing with the sides", () => {
    const b = baseAnalysis();
    const m = { ...b, zz: { deep: [1] } };
    const r = A(b, m, b).value as Obj;
    (r.zz as { deep: number[] }).deep.push(2);
    (r.pairs as string[][])[0][0] = "x";
    expect(m.zz.deep).toEqual([1]);
    expect(b.pairs[0][0]).toBe("col-a");
  });
});

describe("F2 analysis: pairs as a set", () => {
  const b = baseAnalysis();   // pairs a|b, b|c
  it("one side adds a pair, the other removes another → both effects, no conflict", () => {
    const m = { ...b, pairs: [["col-a", "col-b"], ["col-b", "col-c"], ["col-a", "col-d"]] };
    const t = { ...b, pairs: [["col-b", "col-c"]] };
    const r = A(b, m, t);
    expect(r.conflicts).toEqual([]);
    expect((r.value as Obj).pairs).toEqual([["col-b", "col-c"], ["col-a", "col-d"]]);
    expect(r.auto).toEqual([{ what: "field", field: "pairs", from: "same", before: shortText(b.pairs), after: shortText([["col-b", "col-c"], ["col-a", "col-d"]]) }]);
    // Symmetric.
    const s = A(b, t, m);
    expect(C(s.value)).toBe(C(r.value));
  });

  it("[a, b] and [b, a] are one pair; added pairs sorted by key, as the adding side wrote them", () => {
    const m = { ...b, pairs: [["col-c", "col-b"], ["col-z", "col-a"], ["col-a", "col-b"]] };         // flipped b|c, added a|z
    const t = { ...b, pairs: [["col-b", "col-a"], ["col-d", "col-c"], ["col-b", "col-c"]] };         // flipped a|b, added c|d
    const r = A(b, m, t);
    expect(r.conflicts).toEqual([]);
    // Base order first, each turned round as the side that turned it has it; then a|z (mine's), c|d (theirs').
    expect((r.value as Obj).pairs).toEqual([["col-b", "col-a"], ["col-c", "col-b"], ["col-z", "col-a"], ["col-d", "col-c"]]);
    expect(C(A(b, t, m).value)).toBe(C(r.value));
    // Unturned on both → as in the base.
    const r0 = A(b, { ...b, pairs: [...b.pairs, ["col-q", "col-r"]] }, { ...b, pairs: [["col-b", "col-c"]] });
    expect((r0.value as Obj).pairs).toEqual([["col-b", "col-c"], ["col-q", "col-r"]]);
    // Both add the same pair, oriented differently: the canonically smaller one.
    const m2 = { ...b, pairs: [...b.pairs, ["col-e", "col-d"]], alpha: 0.2 };
    const t2 = { ...b, pairs: [["col-d", "col-e"]] };
    const r2 = A(b, m2, t2);
    expect((r2.value as Obj).pairs).toEqual([["col-d", "col-e"]]);
    expect(C(A(b, t2, m2).value)).toBe(C(r2.value));
  });

  it("an unchanged side's list comes back byte for byte (plain rule when two lists are the same)", () => {
    const m = { ...b, pairs: [["col-c", "col-b"], ["col-b", "col-a"]] };   // only reordered / flipped
    expect((A(b, m, b).value as Obj).pairs).toEqual(m.pairs);
    expect((A(b, b, m).value as Obj).pairs).toEqual(m.pairs);
    expect((A(b, m, m).value as Obj).pairs).toEqual(m.pairs);
    expect(A(b, b, b).auto).toEqual([]);
    // Never a conflict, even when both sides remove everything differently.
    expect(A(b, { ...b, pairs: [] }, { ...b, pairs: [["col-x", "col-y"]] }).conflicts).toEqual([]);
    expect((A(b, { ...b, pairs: [] }, { ...b, pairs: [["col-x", "col-y"]] }).value as Obj).pairs).toEqual([["col-x", "col-y"]]);
  });
});

// ── generated analysis settings ─────────────────────────────────────────────

const ENT = ["col-a", "col-b", "col-c", "col-d", "col-e"];
function editAnalysis(r: Rng, a0: Obj, ents = ENT, stable = false): Obj {
  const a = clone(a0) as Obj;
  const n = 1 + r.int(3);
  for (let i = 0; i < n; i++) {
    const what = r.int(stable ? 5 : 9);
    const pairs = a.pairs as string[][];
    if (what === 0) a.alpha = r.pick([0.001, 0.01, 0.05, 0.1, 0.2].filter((x) => x !== a.alpha));
    else if (what === 1) a.family = a.family === "all" ? "per_row" : "all";
    else if (what === 2) {
      const [x, y] = r.shuffle(ents);
      if (!pairs.some((p) => (p[0] === x && p[1] === y) || (p[0] === y && p[1] === x))) pairs.push([x, y]);
    } else if (what === 3) { if (pairs.length) pairs.splice(r.int(pairs.length), 1); }
    else if (what === 4) { if (r.chance(0.5)) a.zz = r.int(1000); else delete a.zz; }
    else if (what === 5) { if (pairs.length) { const p = pairs[r.int(pairs.length)]; p.reverse(); } }
    else if (what === 6) a.control = r.chance(0.3) ? null : r.pick(ents);
    else if (what === 7) a.test = r.pick(["anova", "kruskal", "welch_anova", "none"]);
    else a.within = a.within === "rows" ? "columns" : "rows";
  }
  return a;
}

describe("F1 properties (T1–T3, T6, T7) over generated analysis settings", () => {
  it("holds for 400 cases", () => {
    const r = rng(4_2026_11);
    let conflicted = 0;
    for (let i = 0; i < 400; i++) {
      const b = r.chance(0.3) ? editAnalysis(r, baseAnalysis()) : baseAnalysis() as unknown as Obj;
      const x = editAnalysis(r, b), y = editAnalysis(r, b);
      // T1, T2
      for (const [m, t] of [[x, b], [b, x], [x, x]]) {
        const out = A(b, m, t);
        expect(out.conflicts).toEqual([]);
        expect(C(out.value)).toBe(C(x));
      }
      // T3
      const xy = A(b, x, y), yx = A(b, y, x);
      expectSymmetric(xy, yx);
      if (xy.conflicts.length) {
        conflicted++;
        for (const side of ["mine", "theirs"] as const) {
          const ch = allChoices(xy.conflicts, side);
          const v1 = A(b, x, y, ch).value, v2 = A(b, y, x, swapChoice(ch)).value;
          expect(v1).not.toBeNull();
          expect(C(v2)).toBe(C(v1));
          // T6: every conflicted field as the chosen side has it; the other side's own changes still there.
          const chosen = side === "mine" ? x : y, other = side === "mine" ? y : x;
          for (const c of xy.conflicts) expect(C((v1 as Obj)[c.field!] ?? null)).toBe(C(chosen[c.field!] ?? null));
          for (const k of Object.keys(other)) {
            if (k === "pairs" || xy.conflicts.some((c) => c.field === k)) continue;
            if (C(other[k]) !== C(b[k] ?? null) && C(chosen[k] ?? null) === C(b[k] ?? null)) expect(C((v1 as Obj)[k])).toBe(C(other[k]));
          }
        }
        continue;
      }
      // T7
      const res = xy.value as unknown as Obj;
      for (const [bb, m, t] of [[x, res, x], [y, res, y], [b, res, x], [b, res, y]]) {
        const out = A(bb, m, t);
        expect(out.conflicts).toEqual([]);
        expect(C(out.value)).toBe(C(res));
      }
    }
    expect(conflicted).toBeGreaterThan(15);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Graph settings
// ═════════════════════════════════════════════════════════════════════════════

const F = (b: Obj, m: Obj, t: Obj, colIds: readonly string[] | null, ch?: FineChoices) =>
  mergeFigure({ base: b as unknown as FileFigure, mine: m as unknown as FileFigure, theirs: t as unknown as FileFigure, colIds }, ch) as unknown as FineMerge<Obj>;

function baseFigure(): Obj {
  return {
    graph_type: "dot", title: "", width: 900, height: 800, dpi: 150, y_min: null, y_max: null,
    palette: "app:Default", palette_colors: PALETTES.Default, palette_reverse: false, palette_edited: false, axis_scheme: false,
    series: {
      "col-a": { color: "#5a7fa8", label: "" }, "col-b": { color: "#63a66a", label: "" }, "col-c": { color: "#c1666b", label: "" },
    },
  };
}
const COLS = ["col-a", "col-b", "col-c"];
const withSeries = (f: Obj, fn: (s: Record<string, { color: string; label: string }>) => void): Obj => {
  const g = clone(f);
  fn(g.series as Record<string, { color: string; label: string }>);
  return g;
};

describe("F3 graph settings: atomic groups", () => {
  it("mine changes y_min, theirs y_max → one conflict for the Y range (never a silent mix)", () => {
    const b = baseFigure();
    const r = F(b, { ...b, y_min: 0 }, { ...b, y_max: 100 }, COLS);
    expect(r.value).toBeNull();
    expect(r.conflicts).toEqual([{
      id: "figure:group:yRange", section: "figure", kind: "group", group: "yRange", options: ["mine", "theirs"],
      items: [
        { what: "field", field: "y_min", base: "", mine: "0", theirs: "" },
        { what: "field", field: "y_max", base: "", mine: "", theirs: "100" },
      ],
      more: 0,
    }]);
    const mine = F(b, { ...b, y_min: 0 }, { ...b, y_max: 100 }, COLS, { "figure:group:yRange": "mine" }).value as Obj;
    expect([mine.y_min, mine.y_max]).toEqual([0, null]);
    const theirs = F(b, { ...b, y_min: 0 }, { ...b, y_max: 100 }, COLS, { "figure:group:yRange": "theirs" }).value as Obj;
    expect([theirs.y_min, theirs.y_max]).toEqual([null, 100]);
  });

  it("mine changes width, theirs the title → combined; both members of size from one side", () => {
    const b = baseFigure();
    const r = F(b, { ...b, width: 1200 }, { ...b, title: "Hello" }, COLS);
    expect(r.conflicts).toEqual([]);
    expect(r.value).toMatchObject({ width: 1200, title: "Hello", height: 800 });
    expect(r.auto.map((a) => [a.what, a.group ?? a.field, a.from])).toEqual([["group", "size", "mine"], ["field", "title", "theirs"]]);
    // width on one side, height on the other: the size group conflicts.
    const s = F(b, { ...b, width: 1200 }, { ...b, height: 500 }, COLS);
    expect(s.conflicts.map((c) => c.id)).toEqual(["figure:group:size"]);
    const v = F(b, { ...b, width: 1200 }, { ...b, height: 500 }, COLS, { "figure:group:size": "theirs" }).value as Obj;
    expect([v.width, v.height, v.dpi]).toEqual([900, 500, 150]);
  });

  it("a palette on one side and a hand-picked colour on the other → the colours group; taking a side takes all of it", () => {
    const b = baseFigure();
    const pal = PALETTES.Dark2.map((c) => c.toLowerCase());
    const m = withSeries({ ...b, palette: "app:Dark2", palette_colors: pal }, (s) => { s["col-a"].color = pal[0]; s["col-b"].color = pal[1]; s["col-c"].color = pal[2]; });
    const t = withSeries({ ...b, palette_edited: true }, (s) => { s["col-b"].color = "#000000"; });
    const r = F(b, m, t, COLS);
    expect(r.conflicts.map((c) => c.id)).toEqual(["figure:group:colours"]);
    const items = r.conflicts[0].items;
    expect(items.map((i) => i.what === "field" ? i.field : `colour ${i.colId}`))
      .toEqual(["palette", "palette_colors", "palette_edited", "colour col-a", "colour col-b", "colour col-c"]);
    expect(items[4]).toEqual({ what: "seriesColor", colId: "col-b", base: "#63a66a", mine: pal[1], theirs: "#000000" });
    const vm = F(b, m, t, COLS, { "figure:group:colours": "mine" }).value as Obj;
    expect(vm).toMatchObject({ palette: "app:Dark2", palette_colors: pal, palette_edited: false });
    expect(Object.values(vm.series as Obj).map((e) => (e as { color: string }).color)).toEqual(pal.slice(0, 3));
    const vt = F(b, m, t, COLS, { "figure:group:colours": "theirs" }).value as Obj;
    expect(vt).toMatchObject({ palette: "app:Default", palette_edited: true });
    expect(Object.values(vt.series as Obj).map((e) => (e as { color: string }).color)).toEqual(["#5a7fa8", "#000000", "#c1666b"]);
  });

  it("a group's items are capped for display, the rest counted", () => {
    const ids = Array.from({ length: 26 }, (_, i) => `col-${String.fromCharCode(97 + i)}x`);
    const b = { ...baseFigure(), series: Object.fromEntries(ids.map((id) => [id, { color: "#111111", label: "" }])) };
    const m = { ...withSeries(b, (s) => { for (const id of ids) s[id].color = "#222222"; }), palette: "" };
    const t = { ...withSeries(b, (s) => { for (const id of ids) s[id].color = "#333333"; }), palette: "app:Set2" };
    const c = F(b, m, t, ids).conflicts[0];
    expect(c.items.length).toBe(LIMITS_P4.conflictItems);
    expect(c.more).toBe(27 - LIMITS_P4.conflictItems);
  });
});

describe("F4 graph settings and columns", () => {
  it("mine deletes a column, theirs recolours another → combined; series = colIds in order", () => {
    const b = baseFigure();
    const m = withSeries(b, (s) => { delete s["col-c"]; });
    const t = withSeries({ ...b, palette_edited: true }, (s) => { s["col-a"].color = "#123456"; });
    const r = F(b, m, t, ["col-a", "col-b"]);
    expect(r.conflicts).toEqual([]);
    const v = r.value as Obj;
    expect(Object.keys(v.series as Obj)).toEqual(["col-a", "col-b"]);
    expect((v.series as Obj)["col-a"]).toEqual({ color: "#123456", label: "" });
    expect(v.palette_edited).toBe(true);
  });

  it("mine adds a column, theirs switches palette → no conflict; the new column keeps mine's colour", () => {
    const b = baseFigure();
    const m = withSeries(b, (s) => { s["col-n"] = { color: "#d4a05a", label: "New" }; });
    const pal = PALETTES.Set2.map((c) => c.toLowerCase());
    const t = withSeries({ ...b, palette: "app:Set2", palette_colors: pal }, (s) => { s["col-a"].color = pal[0]; s["col-b"].color = pal[1]; s["col-c"].color = pal[2]; });
    const r = F(b, m, t, ["col-a", "col-b", "col-c", "col-n"]);
    expect(r.conflicts).toEqual([]);
    const v = r.value as Obj;
    expect(v.palette).toBe("app:Set2");
    expect(v.series).toEqual({
      "col-a": { color: pal[0], label: "" }, "col-b": { color: pal[1], label: "" }, "col-c": { color: pal[2], label: "" },
      "col-n": { color: "#d4a05a", label: "New" },
    });
    expect(Object.keys(v.series as Obj)).toEqual(["col-a", "col-b", "col-c", "col-n"]);
  });

  it("the label of one column on both → figure:label:<id>; one side's label is taken", () => {
    const b = baseFigure();
    const m = withSeries(b, (s) => { s["col-b"].label = "Mine B"; s["col-a"].label = "A!"; });
    const t = withSeries(b, (s) => { s["col-b"].label = "Theirs B"; });
    const r = F(b, m, t, COLS);
    expect(r.conflicts).toEqual([{
      id: "figure:label:col-b", section: "figure", kind: "seriesLabel", colId: "col-b", options: ["mine", "theirs"],
      items: [{ what: "seriesLabel", colId: "col-b", base: "", mine: "Mine B", theirs: "Theirs B" }], more: 0,
    }]);
    expect(r.auto).toEqual([{ what: "seriesLabel", colId: "col-a", from: "mine", before: "", after: "A!" }]);
    const v = F(b, m, t, COLS, { "figure:label:col-b": "theirs" }).value as Obj;
    expect((v.series as Obj)["col-b"]).toEqual({ color: "#63a66a", label: "Theirs B" });
    expect((v.series as Obj)["col-a"]).toEqual({ color: "#5a7fa8", label: "A!" });
  });

  it("colIds null → value null with the same conflicts; a column nobody has gets a blank entry; dropped columns go", () => {
    const b = baseFigure();
    const m = { ...b, y_min: 1 }, t = { ...b, y_max: 2, title: "T" };
    const withCols = F(b, m, t, COLS), without = F(b, m, t, null);
    expect(without.value).toBeNull();
    expect(without.conflicts).toEqual(withCols.conflicts);
    const ok = F(b, { ...b, title: "x" }, b, null);
    expect(ok.conflicts).toEqual([]);
    expect(ok.value).toBeNull();
    const v = F(b, b, b, ["col-b", "col-q"]).value as Obj;
    expect(v.series).toEqual({ "col-b": { color: "#63a66a", label: "" }, "col-q": { color: "", label: "" } });
  });

  it("a column both sides have but the base lacks: the same colour on both is not a change of the colours group", () => {
    const b = baseFigure();
    // Both have col-n (e.g. a combined version combined again) with the same colour; mine also recolours col-a.
    const m = withSeries({ ...b, palette_edited: true }, (s) => { s["col-n"] = { color: "#abcdef", label: "" }; s["col-a"].color = "#000000"; });
    const t = withSeries(b, (s) => { s["col-n"] = { color: "#abcdef", label: "" }; });
    const r = F(b, m, t, [...COLS, "col-n"]);
    expect(r.conflicts).toEqual([]);
    expect(((r.value as Obj).series as Obj)["col-a"]).toEqual({ color: "#000000", label: "" });
    expect(((r.value as Obj).series as Obj)["col-n"]).toEqual({ color: "#abcdef", label: "" });
    // Different colours for it on the two sides do count (its base colour is "not there").
    const t2 = withSeries(b, (s) => { s["col-n"] = { color: "#fedcba", label: "" }; });
    const r2 = F(b, m, t2, [...COLS, "col-n"]);
    expect(r2.conflicts.map((c) => c.id)).toEqual(["figure:group:colours"]);
    expect(r2.conflicts[0].items).toContainEqual({ what: "seriesColor", colId: "col-n", base: null, mine: "#abcdef", theirs: "#fedcba" });
  });

  it("is cheap: 26 columns, 500 calls well under a second", () => {
    const ids = Array.from({ length: 26 }, (_, i) => `col-${String.fromCharCode(97 + i)}xxx`);
    const b = { ...baseFigure(), series: Object.fromEntries(ids.map((id) => [id, { color: "#111111", label: id }])) };
    const m = withSeries({ ...b, title: "m" }, (s) => { s[ids[3]].label = "x"; });
    const t = withSeries({ ...b, y_min: 3 }, (s) => { s[ids[5]].color = "#222222"; });
    const t0 = performance.now();
    for (let i = 0; i < 500; i++) F(b, m, t, ids);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it("conflict order: groups (colours, size, yRange), fields sorted, labels sorted by id", () => {
    const b = baseFigure();
    const m = withSeries({ ...b, zfield: 1, title: "m", y_min: 0, width: 1, palette: "" }, (s) => { s["col-c"].label = "m"; s["col-a"].label = "m"; });
    const t = withSeries({ ...b, zfield: 2, title: "t", y_max: 5, height: 2, palette: "app:Set2", graph_type: "bar" }, (s) => { s["col-c"].label = "t"; s["col-a"].label = "t"; });
    const ids = F(b, { ...m, graph_type: "box" }, t, COLS).conflicts.map((c) => c.id);
    expect(ids).toEqual([
      "figure:group:colours", "figure:group:size", "figure:group:yRange",
      "figure:field:graph_type", "figure:field:title", "figure:field:zfield",
      "figure:label:col-a", "figure:label:col-c",
    ]);
  });
});

// ── generated graph settings ────────────────────────────────────────────────

const PAL_KEYS = Object.keys(PALETTES);
const hex = (r: Rng) => "#" + Array.from({ length: 6 }, () => "0123456789abcdef"[r.int(16)]).join("");
let newCol = 0;

function editFigure(r: Rng, f0: Obj, columns: boolean): Obj {
  const f = clone(f0);
  const series = f.series as Record<string, { color: string; label: string }>;
  const n = 1 + r.int(3);
  for (let i = 0; i < n; i++) {
    const ids = Object.keys(series);
    const what = r.int(columns ? 12 : 10);
    if (what === 0) f.title = `T${r.int(1000)}`;
    else if (what === 1) f.point_size = 1 + r.int(9);
    else if (what === 2) f[r.pick(["width", "height", "dpi"])] = 100 + r.int(2000);
    else if (what === 3) f[r.pick(["y_min", "y_max"])] = r.chance(0.2) ? null : r.int(200) - 50;
    else if (what === 4) {
      const k = r.pick(PAL_KEYS);
      const pal = PALETTES[k].map((c) => c.toLowerCase());
      f.palette = `app:${k}`; f.palette_colors = pal; f.palette_edited = false;
      ids.forEach((id, j) => { series[id].color = pal[j % pal.length]; });
    } else if (what === 5) { if (ids.length) { series[r.pick(ids)].color = hex(r); f.palette_edited = true; } }
    else if (what === 6) { if (ids.length) series[r.pick(ids)].label = `L${r.int(100)}`; }
    else if (what === 7) { if (r.chance(0.5)) f.zz = r.int(100); else delete f.zz; }
    else if (what === 8) f.font_size = 8 + r.int(20);
    else if (what === 9) f.show_legend = !f.show_legend;
    else if (what === 10) series[`col-zz${(newCol++).toString(36)}`] = { color: hex(r), label: "" };
    else if (ids.length > 1) delete series[r.pick(ids)];
  }
  return f;
}

/** The combined table's columns for a figure-only test: base columns both kept, then added ones (mine's, theirs'). */
function colsOf(b: Obj, m: Obj, t: Obj): string[] {
  const sb = b.series as Obj, sm = m.series as Obj, st = t.series as Obj;
  const out = Object.keys(sb).filter((id) => id in sm && id in st);
  for (const id of Object.keys(sm)) if (!(id in sb) && !out.includes(id)) out.push(id);
  for (const id of Object.keys(st)) if (!(id in sb) && !out.includes(id)) out.push(id);
  return out;
}

describe("F5 properties over generated graph settings", () => {
  it("T1–T3, T6, T7 hold (with column changes), 400 cases", async () => {
    const r = rng(5_2026_11);
    const bases = await Promise.all(allBases().map(norm));
    let conflicted = 0;
    for (let i = 0; i < 400; i++) {
      const b = (bases[i % bases.length].figure) as Obj;
      const x = editFigure(r, b, true), y = editFigure(r, b, true);
      for (const [m, t] of [[x, b], [b, x], [x, x]]) {
        const out = F(b, m, t, Object.keys(x.series as Obj));
        expect(out.conflicts).toEqual([]);
        expect(C(out.value)).toBe(C(x));
        expect(Object.keys((out.value as Obj).series as Obj)).toEqual(Object.keys(x.series as Obj));
      }
      const cols = colsOf(b, x, y);
      const xy = F(b, x, y, cols), yx = F(b, y, x, cols);
      expectSymmetric(xy, yx);
      if (xy.conflicts.length) {
        conflicted++;
        for (const side of ["mine", "theirs"] as const) {
          const ch = allChoices(xy.conflicts, side);
          const v1 = F(b, x, y, cols, ch).value as Obj, v2 = F(b, y, x, cols, swapChoice(ch)).value;
          expect(v1).not.toBeNull();
          expect(C(v2)).toBe(C(v1));
          const chosen = side === "mine" ? x : y;
          for (const c of xy.conflicts) {
            for (const it of c.items) {
              if (it.what === "field") expect(C(v1[it.field!] ?? null)).toBe(C(chosen[it.field!] ?? null));
              else expect(((v1.series as Obj)[it.colId!] as Obj)[it.what === "seriesColor" ? "color" : "label"])
                .toBe(((chosen.series as Obj)[it.colId!] as Obj)[it.what === "seriesColor" ? "color" : "label"]);
            }
          }
        }
        continue;
      }
      expect(Object.keys((xy.value as Obj).series as Obj)).toEqual(cols);
      const res = xy.value as Obj;
      for (const [bb, m, t] of [[x, res, x], [y, res, y], [b, res, x], [b, res, y]]) {
        const out = F(bb, m, t, cols);
        expect(out.conflicts).toEqual([]);
        expect(C(out.value)).toBe(C(res));
      }
    }
    expect(conflicted).toBeGreaterThan(40);
  });

  it("pipeline form: normaliseSections of a document with the result's analysis / figure gives the same texts (300 cases)", async () => {
    const r = rng(55_2026);
    const bases = await Promise.all(allBases().map(norm));
    let checked = 0;
    for (let i = 0; i < 300; i++) {
      const b = bases[i % bases.length];
      const ents = (b.table as FileTable).col_ids;
      const xs = await norm({ ...clone(b), figure: editFigure(r, b.figure as Obj, false), analysis: ents.length > 1 ? editAnalysis(r, b.analysis as Obj, ents, true) : b.analysis });
      const ys = await norm({ ...clone(b), figure: editFigure(r, b.figure as Obj, false), analysis: ents.length > 1 ? editAnalysis(r, b.analysis as Obj, ents, true) : b.analysis });
      let fm = F(b.figure as Obj, xs.figure as Obj, ys.figure as Obj, ents);
      if (fm.conflicts.length) fm = F(b.figure as Obj, xs.figure as Obj, ys.figure as Obj, ents, allChoices(fm.conflicts, r.chance(0.5) ? "mine" : "theirs"));
      let am = A(b.analysis as Obj, xs.analysis as Obj, ys.analysis as Obj);
      if (am.conflicts.length) am = A(b.analysis as Obj, xs.analysis as Obj, ys.analysis as Obj, allChoices(am.conflicts, "theirs"));
      const doc = { ...clone(b), figure: fm.value, analysis: am.value } as unknown as SectionValues;
      const again = await normSide(doc);
      expect(C(again.sections.figure)).toBe(C(fm.value));
      expect(C(again.sections.analysis)).toBe(C(am.value));
      checked++;
    }
    expect(checked).toBe(300);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Automatic adjustments
// ═════════════════════════════════════════════════════════════════════════════

/** A column table in file form with the given cells (rows × columns, one replicate), padded by the pipeline. */
/** Rows padded to 12 (the last ones blank) with fixed ids, so the pipeline never has to add a row. */
function pad<T>(rows: T[], blank: () => T): T[] {
  const out = [...rows];
  while (out.length < 12) out.push(blank());
  return out;
}
function columnTable(cols: string[], rows0: string[][]): FileTable {
  const rows = pad(rows0, () => cols.map(() => ""));
  return {
    v: 2, template: "column", col_titles: cols.map((c) => c.toUpperCase()), row_titles: rows.map(() => ""), x_title: "X", n_rep: 1,
    x: rows.map(() => ""), cells: rows.map((r) => r.map((v) => [v])), row_ids: rows.map((_, i) => `row-r${i}xx`), col_ids: cols.map((c) => `col-${c}xxx`),
  } as unknown as FileTable;
}
function groupedTable(rows0: string[][][]): FileTable {
  const rows = pad(rows0, () => [["", ""], ["", ""]]);
  return {
    v: 2, template: "grouped", col_titles: ["WT", "KO"], row_titles: rows.map((_, i) => (i < rows0.length ? `R${i}` : "")), x_title: "X", n_rep: 2,
    x: rows.map(() => ""), cells: rows, row_ids: rows.map((_, i) => `row-g${i}xx`), col_ids: ["col-wtxx", "col-koxx"],
  } as unknown as FileTable;
}

async function sidesFor(base: SectionValues, edit: (s: SectionValues) => void): Promise<NormalisedSide> {
  const s = clone(base);
  edit(s);
  return normSide(s);
}

describe("F6 detectAdjustments", () => {
  it("no difference → []", async () => {
    for (const b of allBases()) {
      const n = await normSide(b);
      expect(detectAdjustments({ assembled: clone(n.sections) as unknown as SectionValues, result: n, mine: n, theirs: n })).toEqual([]);
    }
  });

  it("a pair naming a column the combined table lacks → a 'setting' on pairs", async () => {
    const t = columnTable(["a", "b", "c"], [["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"]]);
    const base = await norm({ ...sampleSections("column"), table: t, analysis: { ...(sampleSections("column").analysis as Obj), pairs: [] } } as SectionValues);
    // Mine deleted column c (the table shrinks); theirs added the pair a–c.
    const mine = await sidesFor(base, (s) => {
      const tb = s.table as FileTable;
      tb.col_ids = tb.col_ids.slice(0, 2); tb.col_titles = tb.col_titles.slice(0, 2); tb.cells = tb.cells.map((row) => row.slice(0, 2));
      delete (s.figure as Obj as { series: Obj }).series["col-cxxx"];
    });
    const theirs = await sidesFor(base, (s) => { (s.analysis as Obj).pairs = [["col-axxx", "col-cxxx"]]; });
    const assembled = { ...clone(mine.sections), analysis: clone(theirs.sections.analysis) } as unknown as SectionValues;
    const result = await normSide(assembled);
    const adj = detectAdjustments({ assembled, result, mine, theirs });
    expect(adj).toContainEqual({ section: "analysis", kind: "setting", field: "pairs", from: shortText([["col-axxx", "col-cxxx"]]), to: "[]" });
    expect(adj.every((a) => a.section === "analysis")).toBe(true);
  });

  it("a test that can run on each side but not on the result → testNotRun; one that already could not on both → nothing", async () => {
    const g = groupedTable([[["1", "2"], ["3", "4"]], [["5", "6"], ["7", "8"]], [["2", "3"], ["4", "5"]]]);
    const s0 = sampleSections("grouped");
    const base = await norm({ ...s0, table: g } as SectionValues);
    expect((base.analysis as Obj).test).toBe("two_way");
    const clearRow = (s: SectionValues, i: number) => { (s.table as FileTable).cells[i] = [["", ""], ["", ""]]; (s.table as FileTable).row_titles[i] = ""; };
    const mine = await sidesFor(base, (s) => clearRow(s, 0));
    const theirs = await sidesFor(base, (s) => clearRow(s, 1));
    expect(mine.sections.analysis.test).toBe("two_way");
    const assembled = clone(mine.sections) as unknown as SectionValues;
    clearRow(assembled, 1);
    const result = await normSide(assembled);
    const adj = detectAdjustments({ assembled, result, mine, theirs });
    expect(adj).toEqual([{ section: "analysis", kind: "testNotRun", field: "test", from: "two_way", to: "none" }]);

    // Already impossible on both sides (one row of data each): nothing new.
    const m1 = await sidesFor(base, (s) => { clearRow(s, 0); clearRow(s, 1); });
    const t1 = await sidesFor(base, (s) => { clearRow(s, 0); clearRow(s, 1); (s.figure as Obj).title = "x"; });
    const as1 = clone(t1.sections) as unknown as SectionValues;
    expect(detectAdjustments({ assembled: as1, result: await normSide(as1), mine: m1, theirs: t1 })).toEqual([]);
  });

  it("a control the result cannot use → comparisons (control)", async () => {
    const t = columnTable(["a", "b", "c", "d"], [["1", "2", "3", "4"], ["5", "6", "7", "8"], ["1", "2", "3", "4"]]);
    const s0 = sampleSections("column");
    const base = await norm({ ...s0, table: t, analysis: { ...(s0.analysis as Obj), test: "anova", posthoc: "dunnett", compare: "control", control: "col-dxxx" } } as SectionValues);
    expect((base.analysis as Obj).control).toBe("col-dxxx");
    const clearD = (s: SectionValues, rows: number[]) => { for (const i of rows) (s.table as FileTable).cells[i][3] = [""]; };
    const mine = await sidesFor(base, (s) => clearD(s, [0]));
    const theirs = await sidesFor(base, (s) => clearD(s, [1, 2]));
    const assembled = clone(mine.sections) as unknown as SectionValues;
    clearD(assembled, [1, 2]);
    const result = await normSide(assembled);
    const adj = detectAdjustments({ assembled, result, mine, theirs });
    expect(adj).toEqual([{ section: "analysis", kind: "comparisons", field: "control", from: "col-dxxx", to: "" }]);
  });

  it("comparisons the result cannot use → comparisons (pairs); not counted for a two-group test on a column table", async () => {
    const g: FileTable = {
      ...groupedTable([[["1", "2"], ["3", "4"]], [["5", "6"], ["7", "8"]], [["2", "3"], ["4", "5"]]]),
    };
    // A third column C with data in rows 0 and 1 only.
    g.col_titles = [...g.col_titles, "C"]; g.col_ids = [...g.col_ids, "col-ccxx"];
    g.cells = g.cells.map((row, i) => [...row, i === 0 ? ["9", "9"] : i === 1 ? ["8", "8"] : ["", ""]]);
    const s0 = sampleSections("grouped");
    const base = await norm({ ...s0, table: g, analysis: { ...(s0.analysis as Obj), pairs: [["col-wtxx", "col-ccxx"]] }, figure: { ...(s0.figure as Obj), series: {} } } as SectionValues);
    expect((base.analysis as Obj).pairs).toEqual([["col-wtxx", "col-ccxx"]]);
    const clearC = (s: SectionValues, i: number) => { (s.table as FileTable).cells[i][2] = ["", ""]; };
    const mine = await sidesFor(base, (s) => clearC(s, 0));
    const theirs = await sidesFor(base, (s) => clearC(s, 1));
    const assembled = clone(mine.sections) as unknown as SectionValues;
    clearC(assembled, 1);
    const result = await normSide(assembled);
    expect(detectAdjustments({ assembled, result, mine, theirs }))
      .toEqual([{ section: "analysis", kind: "comparisons", field: "pairs", from: shortText([["col-wtxx", "col-ccxx"]]), to: "[]" }]);
    // Already unused on both sides → nothing.
    expect(detectAdjustments({ assembled, result, mine: result, theirs: result })).toEqual([]);

    // Column table, two-group test: the pair is worked out from the data, stored pairs never count.
    const t = columnTable(["a", "b", "c"], [["1", "2", ""], ["3", "4", ""], ["5", "6", ""]]);
    const c0 = sampleSections("column");
    const cb = await norm({ ...c0, table: t, analysis: { ...(c0.analysis as Obj), test: "unpaired_t", pairs: [["col-axxx", "col-cxxx"]] } } as SectionValues);
    expect((cb.analysis as Obj).test).toBe("unpaired_t");
    const n = await normSide(cb);
    const n2 = await sidesFor(cb, (s) => { (s.analysis as Obj).alpha = 0.01; });
    expect(detectAdjustments({ assembled: clone(n.sections) as unknown as SectionValues, result: n, mine: n2, theirs: n2 })).toEqual([]);
  });

  it("the list is capped", async () => {
    const base = await norm(sampleSections("column"));
    const n = await normSide(base);
    const assembled = clone(base) as Obj;
    // 60 series entries for columns the table does not have: each one dropped by the pipeline.
    const ser = (assembled.figure as { series: Obj }).series;
    for (let i = 0; i < 60; i++) ser[`col-gone${i}`] = { color: "#000000", label: "" };
    const result = await normSide(assembled as unknown as SectionValues);
    const adj = detectAdjustments({ assembled: assembled as unknown as SectionValues, result, mine: n, theirs: n });
    expect(adj.length).toBe(LIMITS_P4.adjustments);
    expect(adj.every((a) => a.kind === "setting" && a.field!.startsWith("series.col-gone"))).toBe(true);
  });

  it("stored-form changes of the figure are listed per series entry; table / scratchpad as a whole", async () => {
    const base = await norm(sampleSections("column"));
    const n = await normSide(base);
    const assembled = clone(base) as Obj;
    const ser = (assembled.figure as { series: Obj }).series;
    const firstId = (base.table as FileTable).col_ids[0];
    delete ser[firstId];                                    // the pipeline puts a blank entry back
    (assembled.figure as Obj).graph_type = "xy_fit";        // not a Column graph: the pipeline replaces it
    assembled.scratchpad = { v: 1, cells: [[1, 1, ""]] };   // an empty input: tidied away
    const result = await normSide(assembled as unknown as SectionValues);
    const adj = detectAdjustments({ assembled: assembled as unknown as SectionValues, result, mine: n, theirs: n });
    expect(adj).toEqual([
      { section: "figure", kind: "setting", field: "graph_type", from: "xy_fit", to: "dot" },
      { section: "figure", kind: "setting", field: `series.${firstId}`, from: null, to: shortText({ color: "", label: "" }) },
      { section: "scratchpad", kind: "scratchpad", from: null, to: null },
    ]);
  });
});

describe("F7 shortText", () => {
  it.each([
    ["abc", "abc"], ["", ""], [12.5, "12.5"], [0, "0"], [true, "true"], [false, "false"], [null, ""], [undefined, ""],
    [[["col-a", "col-b"]], '[["col-a","col-b"]]'], [{ b: 1, a: 2 }, '{"a":2,"b":1}'],
  ])("%j → %j", (v, s) => { expect(shortText(v)).toBe(s); });
  it("cuts canonical JSON at 60 characters", () => {
    const long = Array.from({ length: 20 }, (_, i) => `item${i}`);
    const s = shortText(long);
    expect(s.length).toBe(60);
    expect(s.endsWith("…")).toBe(true);
    expect(s.slice(0, 59)).toBe(canonicalJson(long).slice(0, 59));
    expect(shortText("x".repeat(100))).toBe("x".repeat(100));   // strings as they are
  });
});
