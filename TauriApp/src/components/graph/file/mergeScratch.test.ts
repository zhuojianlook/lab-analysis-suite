/* Phase 4 contract §2.5, §8 X1–X8: the Scratchpad combined cell by cell, the
   shift check, "both side by side" and moving formulas. Fixtures plus seeded
   property tests over generated sheets. */

import { describe, expect, it } from "vitest";
import { LIMITS_P4, type FineChoices, type FineConflict, type ScratchMerge } from "./contract";
import { mergeScratch, shiftCheck, shiftFormula, sideBySide } from "./mergeScratch";
import { canonScratch, sanitizeScratch, SCRATCH_COLS, type ScratchCell } from "../scratchpad/scratchModel";
import { rng, type Rng } from "./fixtures-p2/kit";

type Doc = { v: 1; cells: ScratchCell[]; cols?: Record<string, number> } | null;

/** A sheet in file form (canonical object, null = empty). */
function sheet(cells: ScratchCell[], cols?: Record<string, number>): Doc {
  const t = canonScratch({ cells, cols });
  return t ? (JSON.parse(t) as Doc) : null;
}
const text = (d: unknown) => sanitizeScratch(d ?? "");
const S = (b: Doc, m: Doc, t: Doc, ch?: FineChoices) => mergeScratch({ base: b, mine: m, theirs: t }, ch);
const allChoices = (cs: FineConflict[], side: "mine" | "theirs"): FineChoices => Object.fromEntries(cs.map((c) => [c.id, side]));
const swapChoice = (c: FineChoices): FineChoices =>
  Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v === "mine" ? "theirs" : v === "theirs" ? "mine" : v]));
const swapFrom = (f: string) => (f === "mine" ? "theirs" : f === "theirs" ? "mine" : f);

/** n numbered cells in a block (column-major down `rows` rows from A1). */
function block(n: number, rows = 10, c0 = 1, r0 = 1, prefix = "v"): ScratchCell[] {
  return Array.from({ length: n }, (_, i) => [r0 + (i % rows), c0 + Math.floor(i / rows), `${prefix}${i}`] as ScratchCell);
}
const cellsOf = (d: Doc) => d?.cells ?? [];
const edit = (d: Doc, f: (cells: ScratchCell[]) => ScratchCell[], cols?: Record<string, number>) =>
  sheet(f(cellsOf(d).map((c) => [...c] as ScratchCell)), cols ?? d?.cols);
const set = (r: number, c: number, input: string, fmt?: string) => (cells: ScratchCell[]) =>
  [...cells.filter((x) => !(x[0] === r && x[1] === c)), (fmt ? [r, c, input, fmt] : [r, c, input]) as ScratchCell];
const clear = (r: number, c: number) => (cells: ScratchCell[]) => cells.filter((x) => !(x[0] === r && x[1] === c));

function expectSymmetric(a: ScratchMerge, b: ScratchMerge) {
  expect(b.conflicts.map((c) => c.id)).toEqual(a.conflicts.map((c) => c.id));
  expect(b.shift).toBe(a.shift);
  for (let i = 0; i < a.conflicts.length; i++) {
    expect(b.conflicts[i].items.map((it) => ({ ...it, mine: it.theirs, theirs: it.mine }))).toEqual(a.conflicts[i].items);
    expect(b.conflicts[i].options).toEqual(a.conflicts[i].options);
  }
  expect(b.combined).toBe(a.combined);
  expect(b.auto.map((x) => ({ ...x, from: swapFrom(x.from) }))).toEqual(a.auto);
  if (!a.conflicts.length) expect(text(b.value)).toBe(text(a.value));
}

describe("X1 cells by address", () => {
  const base = sheet([[1, 1, "1"], [1, 2, "2"], [2, 1, "=A1*2"], [2, 2, "x", "0.00"]]);

  it("different cells → combined", () => {
    const m = edit(base, set(1, 1, "10"));
    const t = edit(base, set(3, 3, "new"));
    const r = S(base, m, t);
    expect(r.conflicts).toEqual([]);
    expect(r.shift).toBe(false);
    expect(text(r.value)).toBe(canonScratch({ cells: [[1, 1, "10"], [1, 2, "2"], [2, 1, "=A1*2"], [2, 2, "x", "0.00"], [3, 3, "new"]] }));
    expect(r.auto).toEqual([
      { what: "scratch", addr: "A1", from: "mine", before: "1", after: "10" },
      { what: "scratch", addr: "C3", from: "theirs", before: null, after: "new" },
    ]);
    expect(r.combined).toBe(2);
  });

  it("the same cell differently → scratchpad:cell:<A1>; alike → combined (from: same)", () => {
    const r = S(base, edit(base, set(1, 2, "m")), edit(base, set(1, 2, "t")));
    expect(r.value).toBeNull();
    expect(r.conflicts).toEqual([{
      id: "scratchpad:cell:B1", section: "scratchpad", kind: "cell", addr: "B1", row: 1, col: 2, options: ["mine", "theirs"],
      items: [{ what: "scratch", addr: "B1", base: "2", mine: "m", theirs: "t" }], more: 0,
    }]);
    expect(text(S(base, edit(base, set(1, 2, "m")), edit(base, set(1, 2, "t")), { "scratchpad:cell:B1": "theirs" }).value))
      .toBe(text(edit(base, set(1, 2, "t"))));
    expect(S(base, edit(base, set(1, 2, "m")), edit(base, set(1, 2, "t")), { "scratchpad:cell:B1": "both" }).value).toBeNull();
    const same = S(base, edit(base, set(1, 2, "s")), edit(base, set(1, 2, "s")));
    expect(same.conflicts).toEqual([]);
    expect(same.auto).toEqual([{ what: "scratch", addr: "B1", from: "same", before: "2", after: "s" }]);
  });

  it("one clears, the other edits → a conflict; a format is part of the value", () => {
    const r = S(base, edit(base, clear(2, 1)), edit(base, set(2, 1, "=A1*3")));
    expect(r.conflicts[0]).toMatchObject({ id: "scratchpad:cell:A2", items: [{ what: "scratch", addr: "A2", base: "=A1*2", mine: null, theirs: "=A1*3" }] });
    expect(r.conflicts[0].items.length).toBe(1);   // no format line: neither side has a format
    expect(text(S(base, edit(base, clear(2, 1)), edit(base, set(2, 1, "=A1*3")), { "scratchpad:cell:A2": "mine" }).value))
      .toBe(text(edit(base, clear(2, 1))));
    // One changes the format, the other the input of one cell → asks, with a format line.
    const f = S(base, edit(base, set(2, 2, "x", "0%")), edit(base, set(2, 2, "y", "0.00")));
    expect(f.conflicts[0].items).toEqual([
      { what: "scratch", addr: "B2", base: "x", mine: "x", theirs: "y" },
      { what: "scratchFormat", addr: "B2", base: "0.00", mine: "0%", theirs: "0.00" },
    ]);
    // Format only on one side → taken.
    expect(text(S(base, edit(base, set(2, 2, "x", "0%")), base).value)).toBe(text(edit(base, set(2, 2, "x", "0%"))));
  });

  it("widths never conflict: one side's change is taken, both changed → the larger", () => {
    const b = sheet([[1, 1, "a"]], { 2: 120 });
    const r = S(b, sheet([[1, 1, "a"]], { 2: 150, 3: 40 }), sheet([[1, 1, "a"]], { 2: 200 }));
    expect(r.conflicts).toEqual([]);
    expect((r.value as Doc)!.cols).toEqual({ 2: 200, 3: 40 });
    expect(r.auto).toEqual([
      { what: "colWidth", field: "B", from: "theirs", before: "120", after: "200" },
      { what: "colWidth", field: "C", from: "mine", before: null, after: "40" },
    ]);
    // One side back to the default (no width stored), the other narrower → the default (larger) wins.
    const d = S(b, sheet([[1, 1, "a"]]), sheet([[1, 1, "a"]], { 2: 50 }));
    expect((d.value as Doc)!.cols).toBeUndefined();
    const e = S(b, sheet([[1, 1, "a"]]), sheet([[1, 1, "a"]], { 2: 300 }));
    expect((e.value as Doc)!.cols).toEqual({ 2: 300 });
  });

  it("conflicts in row-major order; auto capped, combined counts everything", () => {
    const b = sheet(block(5));
    const m = sheet([[3, 1, "m"], [1, 2, "m"], [1, 1, "m"]]), t = sheet([[3, 1, "t"], [1, 2, "t"], [1, 1, "t"]]);
    expect(S(b, m, t).conflicts.map((c) => c.addr)).toEqual(["A1", "B1", "A3"]);
    const big = sheet([[1, 1, "x"]]);
    const many = sheet([[1, 1, "x"], ...Array.from({ length: 80 }, (_, i) => [i + 2, 1, `m${i}`] as ScratchCell)]);
    const r = S(big, many, sheet([[1, 1, "x"], [1, 2, "t"]]));
    expect(r.combined).toBe(81);
    expect(r.auto.length).toBe(LIMITS_P4.autoItems);
  });
});

describe("X2 shift check, rule A (much changed)", () => {
  const base = sheet(block(10));
  const changeN = (n: number) => edit(base, (cells) => cells.map((c, i) => (i < n ? [c[0], c[1], `changed${i}`] as ScratchCell : c)));
  it("10 base cells, 4 changed → true; 3 changed → false", () => {
    expect(shiftCheck(base, changeN(4))).toBe(true);
    expect(shiftCheck(base, changeN(3))).toBe(false);
    // Removing counts as changing.
    expect(shiftCheck(base, edit(base, (cells) => cells.slice(4)))).toBe(true);
    // Formats are ignored, and cells added outside the base never count.
    expect(shiftCheck(base, edit(base, (cells) => [...cells.map((c) => [c[0], c[1], c[2], "0.0"] as ScratchCell), ...block(40, 10, 5, 1, "n")]))).toBe(false);
  });
  it("9 base cells, all changed → false by rule A", () => {
    const b9 = sheet(block(9));
    expect(shiftCheck(b9, edit(b9, (cells) => cells.map((c, i) => [c[0], c[1], `z${i}`] as ScratchCell)))).toBe(false);
    expect(shiftCheck(null, sheet(block(30)))).toBe(false);
    expect(shiftCheck(b9, null)).toBe(false);   // 9 cells gone: < 10 for A; nothing reappears for B
  });
});

describe("X3 shift check, rule B (content moved)", () => {
  it("a row inserted above 20 cells → true (also by B alone: 20 cells of 100)", () => {
    const b = sheet(block(20, 5));
    const moved = sheet([[1, 1, "Inserted"], ...cellsOf(b).map((c) => [c[0] + 1, c[1], c[2]] as ScratchCell)]);
    expect(shiftCheck(b, moved)).toBe(true);
    // Rule B on its own: 100 base cells, a block of 20 moved down one row (20 changed < 30 %).
    const b100 = sheet(block(100, 20));
    const part = edit(b100, (cells) => cells.map((c) => (c[1] === 5 ? [c[0] + 1, 6 + 10, c[2]] as ScratchCell : c)));
    expect(shiftCheck(b100, part)).toBe(true);
  });
  it("6 cells moved one column right among 40 → true; 4 moved → true; 1 moved → false (fixer M2: 2 cells are enough)", () => {
    const b = sheet(block(40, 10));                     // A1:D10
    const move = (n: number) => edit(b, (cells) => {
      const out = cells.filter((c) => !(c[1] === 4 && c[0] <= n));
      for (const c of cells) if (c[1] === 4 && c[0] <= n) out.push([c[0], 5, c[2]]);
      return out;
    });
    expect(shiftCheck(b, move(6))).toBe(true);
    expect(shiftCheck(b, move(4))).toBe(true);
    expect(shiftCheck(b, move(2))).toBe(true);
    expect(shiftCheck(b, move(1))).toBe(false);
  });
  it("a column of identical values scrolled by one → false; content that was already there is not moved content", () => {
    const b = sheet(Array.from({ length: 20 }, (_, i) => [i + 1, 1, "5"] as ScratchCell));
    const scrolled = sheet(Array.from({ length: 20 }, (_, i) => [i + 2, 1, "5"] as ScratchCell));
    expect(shiftCheck(b, scrolled)).toBe(false);
    // 50 base cells (A1:E10), 6 of them cleared while the same texts stand elsewhere already → no offset.
    const b2 = sheet([...block(50, 10), ...block(6, 10, 9, 1)]);   // v0..v5 also in column I
    const cleared = edit(b2, (cells) => cells.filter((c) => !(c[1] === 1 && c[0] <= 6)));
    expect(shiftCheck(b2, cleared)).toBe(false);
  });
  it("the offset needs at least half of the changed cells (and 5)", () => {
    const b = sheet(block(100, 20));
    // 12 changed: 6 moved by (0, +10), 6 simply edited → 6 ≥ max(5, 6) → true.
    const s1 = edit(b, (cells) => cells.map((c, i) => (i < 6 ? [c[0], c[1] + 10, c[2]] as ScratchCell : i < 12 ? [c[0], c[1], "edited"] as ScratchCell : c)));
    expect(shiftCheck(b, s1)).toBe(true);
    // 14 changed: 6 moved, 8 edited → 6 < 7 → false.
    const s2 = edit(b, (cells) => cells.map((c, i) => (i < 6 ? [c[0], c[1] + 10, c[2]] as ScratchCell : i < 14 ? [c[0], c[1], "edited"] as ScratchCell : c)));
    expect(shiftCheck(b, s2)).toBe(false);
  });
});

describe("X4 a rearranged side → one whole choice", () => {
  const base = sheet(block(20, 5));
  const mine = edit(base, set(1, 1, "mine edit"));
  const theirs = sheet([[1, 1, "Inserted"], ...cellsOf(base).map((c) => [c[0] + 1, c[1], c[2]] as ScratchCell)]);
  it("shift: true, the single scratchpad:section conflict with both offered; mine / theirs / both", () => {
    const r = S(base, mine, theirs);
    expect(r.shift).toBe(true);
    expect(r.combined).toBe(0);
    expect(r.auto).toEqual([]);
    expect(r.value).toBeNull();
    expect(r.conflicts).toEqual([{
      id: "scratchpad:section", section: "scratchpad", kind: "section", reason: "shift", options: ["mine", "theirs", "both"], items: [], more: 0,
    }]);
    expect(text(S(base, mine, theirs, { "scratchpad:section": "mine" }).value)).toBe(text(mine));
    expect(text(S(base, mine, theirs, { "scratchpad:section": "theirs" }).value)).toBe(text(theirs));
    expect(text(S(base, mine, theirs, { "scratchpad:section": "both" }).value)).toBe(text(sideBySide(mine, theirs)));
    // Cell choices do not count for the whole choice.
    expect(S(base, mine, theirs, { "scratchpad:cell:A1": "mine" }).value).toBeNull();
    // Symmetric (the rearranged side may be either).
    expectSymmetric(r, S(base, theirs, mine));
  });
  it("runs only when both sides changed the sheet", () => {
    for (const [m, t] of [[theirs, base], [base, theirs], [theirs, theirs]]) {
      const r = S(base, m, t);
      expect(r.shift).toBe(false);
      expect(r.conflicts).toEqual([]);
      expect(text(r.value)).toBe(text(theirs));
    }
  });
  it("without 'both' when side by side does not fit", () => {
    const wide = edit(mine, set(1, SCRATCH_COLS - 1, "far"));
    const r = S(base, wide, theirs);
    expect(r.conflicts[0].options).toEqual(["mine", "theirs"]);
    expect(S(base, wide, theirs, { "scratchpad:section": "both" }).value).toBeNull();
  });
});

describe("X5 both side by side", () => {
  it("theirs' cells and widths land d columns right, d = mine's last used column + 1; mine untouched", () => {
    const mine = sheet([[1, 1, "a"], [4, 3, "c", "0.0"]], { 1: 50, 6: 70 });
    const theirs = sheet([[1, 1, "x"], [2, 2, "=A1+B$1", "0%"]], { 1: 200, 2: 60 });
    const both = sideBySide(mine, theirs) as Doc;
    // d = 3 + 1 = 4: column D stays blank, theirs starts at E.
    expect(both).toEqual(sheet([[1, 1, "a"], [4, 3, "c", "0.0"], [1, 5, "x"], [2, 6, "=E1+F$1", "0%"]], { 1: 50, 5: 200, 6: 70 }));
    expect(text(both)).toBe(canonScratch(both!));
  });
  it("empty sides; null past column 300 (cell or reference)", () => {
    expect(sideBySide(null, null)).toBeNull();
    const t = sheet([[1, 1, "x"]]);
    expect(sideBySide(null, t)).toEqual(t);
    expect(sideBySide(t, null)).toEqual(t);
    expect(sideBySide(sheet([[1, 200, "m"]]), sheet([[1, 100, "t"]]))).toBeNull();               // 100 + 201 > 300
    expect(sideBySide(sheet([[1, 200, "m"]]), sheet([[1, 99, "t"]]))).toEqual(sheet([[1, 200, "m"], [1, 300, "t"]]));
    expect(sideBySide(sheet([[1, 10, "m"]]), sheet([[1, 1, "=KM1"]]))).toBeNull();                 // KM (299) + 11 > 300
    // A width that would land past the sheet is left out (a width holds no value).
    expect(sideBySide(sheet([[1, 10, "m"]]), sheet([[1, 1, "t"]], { 295: 40 }))).toEqual(sheet([[1, 10, "m"], [1, 12, "t"]]));
  });
});

describe("X6 shiftFormula", () => {
  it.each([
    ["=A1+$B$2", 2, "=C1+$D$2"],
    ["=SUM(A1:A5)", 1, "=SUM(B1:B5)"],
    ["=A:A", 1, "=B:B"],
    ["=SUM($A:$C)*2", 3, "=SUM($D:$F)*2"],
    ['="A1"&B1', 1, '="A1"&C1'],
    ['="say ""A1"" now"&A1', 1, '="say ""A1"" now"&B1'],
    ["=LOG10(C3)", 1, "=LOG10(D3)"],
    ["=ATAN2(A1,B2)", 1, "=ATAN2(B1,C2)"],
    ["=Sheet1!A1", 1, "=Sheet1!B1"],
    ["='My A1 data'!A1", 1, "='My A1 data'!B1"],
    ["=3:5", 4, "=3:5"],
    ["=SUM(3:5)", 4, "=SUM(3:5)"],
    ["=Z1", 1, "=AA1"],
    ["=a1*2", 1, "=b1*2"],
    ["=MyName1+A1B", 1, "=MyName1+A1B"],
    ["=1E5+A1", 1, "=1E5+B1"],
    ["=A0+A1", 1, "=A0+B1"],
    ["=TRUE", 5, "=TRUE"],
    ["=A1", 0, "=A1"],
    ["abc", 3, "abc"],
    ["12.5", 3, "12.5"],
    ["A1", 3, "A1"],
    ["", 3, ""],
  ])("%s moved %i → %s", (input, d, out) => { expect(shiftFormula(input as string, d as number)).toBe(out); });
  it("null when a column would pass the sheet", () => {
    expect(shiftFormula("=KN1", 1)).toBeNull();
    expect(shiftFormula("=KM1", 1)).toBe("=KN1");
    expect(shiftFormula("=A:KN", 1)).toBeNull();
    expect(shiftFormula("=SUM(A1:KM9)", 2)).toBeNull();
    expect(shiftFormula('="KN1"', 5)).toBe('="KN1"');
  });
});

describe("X7 empty sides", () => {
  const s = sheet([[1, 1, "a"], [2, 2, "b"]]);
  it("null in each position", () => {
    expect(S(null, null, null).value).toBeNull();
    expect(S(null, null, null).conflicts).toEqual([]);
    expect(text(S(null, s, null).value)).toBe(text(s));
    expect(text(S(null, null, s).value)).toBe(text(s));
    expect(S(s, null, s).value).toBeNull();
    expect(S(s, s, null).value).toBeNull();
    expect(text(S(null, s, s).value)).toBe(text(s));
    // Both added cells, one the same, one different → one conflict.
    const r = S(null, sheet([[1, 1, "a"], [1, 2, "m"]]), sheet([[1, 1, "a"], [1, 2, "t"]]));
    expect(r.conflicts.map((c) => c.id)).toEqual(["scratchpad:cell:B1"]);
    expect(r.conflicts[0].items[0].base).toBeNull();
    // One cleared everything, the other edited a cell → that cell asks.
    const cl = S(s, null, edit(s, set(1, 1, "A!")));
    expect(cl.conflicts.map((c) => c.id)).toEqual(["scratchpad:cell:A1"]);
    expect(cl.combined).toBe(1);   // B2 removed
    expect(S(s, null, edit(s, set(1, 1, "A!")), { "scratchpad:cell:A1": "mine" }).value).toBeNull();
    // Not a scratchpad at all counts as empty.
    expect(text(S("nonsense" as never, s, null as never).value)).toBe(text(s));
  });
});

// ── generated sheets ────────────────────────────────────────────────────────

const INPUTS = ["1", "2.5", "abc", "=A1*2", "=SUM(A1:B3)", "'007", "x"];
function baseSheet(r: Rng): Doc {
  const n = 20 + r.int(25);
  const cells: ScratchCell[] = [];
  for (let i = 0; i < n; i++) {
    const row = 1 + r.int(12), col = 1 + r.int(6);
    cells.push(r.chance(0.15) ? [row, col, `${r.pick(INPUTS)}${i}`, "0.00"] : [row, col, `${r.pick(INPUTS)}${i}`]);
  }
  const cols: Record<string, number> = {};
  for (let i = 0; i < r.int(3); i++) cols[String(1 + r.int(8))] = 30 + r.int(500);
  return sheet(cells, cols);
}
/** 1–3 small edits (never enough to look rearranged). */
function editSheet(r: Rng, d: Doc): Doc {
  let cells = cellsOf(d).map((c) => [...c] as ScratchCell);
  const cols = { ...(d?.cols ?? {}) };
  for (let i = 0, n = 1 + r.int(3); i < n; i++) {
    const what = r.int(6);
    // Mostly a cell near the top left, so both sides often meet in one cell.
    const row = 1 + r.int(r.chance(0.5) ? 3 : 14), col = 1 + r.int(r.chance(0.5) ? 2 : 8);
    if (what <= 1) cells = set(row, col, `e${r.int(50)}`)(cells);
    else if (what === 2 && cells.length) { const c = r.pick(cells); cells = clear(c[0], c[1])(cells); }
    else if (what === 3 && cells.length) { const c = r.pick(cells); cells = set(c[0], c[1], c[2], r.pick(["0%", "0.0", ""]))(cells); }
    else if (what === 4) cols[String(1 + r.int(8))] = 30 + r.int(500);
    else delete cols[String(1 + r.int(8))];
  }
  return sheet(cells, cols);
}
/** Every cell moved down one row (a rearranged sheet). */
const shiftDown = (d: Doc): Doc => sheet([[1, 1, "Inserted"], ...cellsOf(d).map((c) => [c[0] + 1, c[1], ...c.slice(2)] as unknown as ScratchCell)], d?.cols);

describe("X1/X8 properties over generated sheets (T1–T3, T6, T7, pipeline form)", () => {
  it("hold for 400 cases", () => {
    const r = rng(7_2026_11);
    let conflicted = 0, shifts = 0;
    for (let i = 0; i < 400; i++) {
      const b = r.chance(0.05) ? null : baseSheet(r);
      let x = editSheet(r, b), y = r.chance(0.1) && b && b.cells.length >= 10 ? shiftDown(b) : editSheet(r, b);
      if (r.chance(0.2)) {   // both type into one cell
        const row = 1 + r.int(5), col = 1 + r.int(3);
        x = edit(x, set(row, col, `cx${i}`));
        if (!(y && y.cells[0]?.[2] === "Inserted")) y = edit(y, set(row, col, `cy${i}`));
      }
      // T1, T2
      for (const [m, t] of [[x, b], [b, x], [x, x]]) {
        const out = S(b, m, t);
        expect(out.conflicts).toEqual([]);
        expect(text(out.value)).toBe(text(x));
        expect(out.value === null || typeof out.value === "object").toBe(true);
      }
      // T3
      const xy = S(b, x, y), yx = S(b, y, x);
      expectSymmetric(xy, yx);
      // X8: whatever comes out is what sanitizeScratch gives back.
      const check = (v: unknown) => { expect(text(v)).toBe(v === null ? "" : canonScratch(v as never)); if (v !== null) expect(JSON.parse(text(v))).toEqual(v); };
      check(xy.value);
      if (xy.shift) {
        shifts++;
        for (const ch of xy.conflicts[0].options) {
          const v1 = S(b, x, y, { "scratchpad:section": ch }).value;
          check(v1);
          if (ch !== "both") expect(text(v1)).toBe(text(S(b, y, x, swapChoice({ "scratchpad:section": ch })).value));
        }
        continue;
      }
      if (xy.conflicts.length) {
        conflicted++;
        for (const side of ["mine", "theirs"] as const) {
          const ch = allChoices(xy.conflicts, side);
          const v1 = S(b, x, y, ch).value as Doc, v2 = S(b, y, x, swapChoice(ch)).value;
          check(v1);
          expect(text(v2)).toBe(text(v1));
          // T6: each conflicted cell as the chosen side has it.
          const chosen = side === "mine" ? x : y;
          const at = (d: Doc, row: number, col: number) => cellsOf(d).find((c) => c[0] === row && c[1] === col) ?? null;
          for (const c of xy.conflicts) expect(at(v1, c.row!, c.col!)).toEqual(at(chosen, c.row!, c.col!));
        }
        continue;
      }
      // T7
      const res = xy.value as Doc;
      for (const [bb, m, t] of [[x, res, x], [y, res, y], [b, res, x], [b, res, y]]) {
        const out = S(bb, m, t);
        expect(out.conflicts).toEqual([]);
        expect(text(out.value)).toBe(text(res));
      }
    }
    expect(conflicted).toBeGreaterThan(20);
    expect(shifts).toBeGreaterThan(5);
  });
});

describe("fixer M2: rows inserted or deleted near the end of a block with formula columns", () => {
  // 20 rows: A = a value, B = "=A{n}*2", C = "=B{n}+1" (60 cells), as the verifier's case.
  const base = sheet(Array.from({ length: 20 }, (_, i) => i + 1).flatMap((r) => [[r, 1, String(100 + r)], [r, 2, `=A${r}*2`], [r, 3, `=B${r}+1`]] as ScratchCell[]));
  /** "Insert row above" at row `at` as the Scratchpad does it: rows move down, formulas read the same at their new place. */
  const insertAbove = (at: number) => sheet(Array.from({ length: 20 }, (_, i) => i + 1).flatMap((r) => {
    const to = r >= at ? r + 1 : r;
    return [[to, 1, String(100 + r)], [to, 2, `=A${to}*2`], [to, 3, `=B${to}+1`]] as ScratchCell[];
  }));
  /** "Delete row" `at`: rows below move up. */
  const deleteRow = (at: number) => sheet(Array.from({ length: 20 }, (_, i) => i + 1).filter((r) => r !== at).flatMap((r) => {
    const to = r > at ? r - 1 : r;
    return [[to, 1, String(100 + r)], [to, 2, `=A${to}*2`], [to, 3, `=B${to}+1`]] as ScratchCell[];
  }));

  it("a row inserted above row 18 is a rearranged sheet (rule B with 3 moved cells)", () => {
    expect(shiftCheck(base, insertAbove(18))).toBe(true);
    expect(shiftCheck(base, deleteRow(18))).toBe(true);
  });
  it("case 1: theirs adds a formula pointing at row 20 → the whole choice, not a silent wrong reference", () => {
    const theirs = edit(base, (c) => [...c, [1, 5, "=A20"]]);
    const r = S(base, insertAbove(18), theirs);
    expect(r.shift).toBe(true);
    expect(r.conflicts.map((c) => c.id)).toEqual(["scratchpad:section"]);
    expectSymmetric(r, S(base, theirs, insertAbove(18)));
  });
  it("case 2: theirs corrects A18 → the whole choice, not a cell question about the inserted row", () => {
    const theirs = edit(base, set(18, 1, "999"));
    const r = S(base, insertAbove(18), theirs);
    expect(r.shift).toBe(true);
  });
  it("rule C: a row inserted above the last row (one value moves) and the other side changed or refers to it", () => {
    const mine = insertAbove(20);
    expect(shiftCheck(base, mine)).toBe(false);                                  // only A20 moved: not rule B
    expect(S(base, mine, edit(base, set(20, 1, "999"))).shift).toBe(true);     // the cell that moved
    expect(S(base, mine, edit(base, (c) => [...c, [1, 5, "=SUM(A15:A20)"]])).shift).toBe(true);   // a range over it
    expect(S(base, mine, edit(base, (c) => [...c, [1, 5, "=A21"]])).shift).toBe(true);           // where it went
    // Something elsewhere: still combined cell by cell.
    const far = S(base, mine, edit(base, set(2, 1, "5")));
    expect(far.shift).toBe(false);
    expect(far.conflicts).toEqual([]);
    // The last row deleted (nothing moves) and the other side changed a cell of it: a plain cell question.
    const del = S(base, deleteRow(20), edit(base, set(20, 1, "999")));
    expect(del.shift).toBe(false);
    expect(del.conflicts.map((c) => c.id)).toEqual(["scratchpad:cell:A20"]);
  });
  it("an edit that keeps its cell is not moved content: a formula on the other side that refers to it still combines by cell", () => {
    // Mine changes B2 and happens to type the old value in a new cell; theirs adds a formula that uses B2.
    const small = sheet([[1, 1, "a"], [2, 2, "1"], [3, 3, "x"]]);
    const mine = edit(small, (c) => [...set(2, 2, "2")(c), [5, 3, "1"]]);
    const theirs = edit(small, (c) => [...c, [1, 4, "=B2*2"]]);
    const r = S(small, mine, theirs);
    expect(r.shift).toBe(false);
    expect(r.conflicts).toEqual([]);
  });
});
