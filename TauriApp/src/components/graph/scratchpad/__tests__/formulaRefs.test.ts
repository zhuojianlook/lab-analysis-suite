// Scratchpad reference colouring: references in a formula, their offsets, ranges and colours.
import { beforeAll, describe, expect, it } from "vitest";
import { formulaRefs, pointRefName, segments, uniqueRanges, cpToUtf16, utf16ToCp } from "../formulaRefs";
import { SCRATCH_COLS, SCRATCH_ROWS } from "../scratchModel";
import { initWasm } from "./wasmInit";

beforeAll(initWasm);

const g = (r1: number, c1: number, r2 = r1, c2 = c1) => ({ r1, c1, r2, c2 });
const texts = (f: string) => formulaRefs(f).map((r) => f.slice(r.start, r.end));
const CASES = [
  "=SUM(A1:A3,A5)*$A$2", "=A1+$A$1+a1", "=SUM( A1 : B2 ,c3)", "=B3:A1", "=A:A", "=3:5", "=LOG10+LOG10(A1)", "=XFD1",
  "=Sheet1!D4+Sheet2!B2", '="A1"&B2', '="😀"&A1', "=SUM(A1:", "abc", "A1", "=A1+  B2 ", "=A1#+B1",
];

describe("formulaRefs", () => {
  it("ranges, colours and offsets", () => {
    const f = "=SUM(A1:A3,A5)*$A$2";
    const r = formulaRefs(f);
    expect(r.map((x) => x.range)).toEqual([g(1, 1, 3, 1), g(5, 1), g(2, 1)]);
    expect(r.map((x) => x.color)).toEqual([0, 1, 2]);
    expect(texts(f)).toEqual(["A1:A3", "A5", "$A$2"]);
  });
  it("same range, same colour", () => {
    const r = formulaRefs("=A1+$A$1+a1");
    expect(r).toHaveLength(3);
    expect(r.map((x) => x.color)).toEqual([0, 0, 0]);
    expect(uniqueRanges(r)).toHaveLength(1);
  });
  it("spaced ranges and normalisation", () => {
    const f = "=SUM( A1 : B2 ,c3)";
    const r = formulaRefs(f);
    expect(r[0].range).toEqual(g(1, 1, 2, 2));
    expect(f.slice(r[0].start, r[0].end)).toBe("A1 : B2");
    expect(r[1].range).toEqual(g(3, 3));
    expect(formulaRefs("=B3:A1")[0].range).toEqual(g(1, 1, 3, 2));
    expect(texts("=A1+  B2 ")).toEqual(["A1", "B2"]);
  });
  it("whole columns and rows are clamped to the grid", () => {
    expect(formulaRefs("=A:A")[0].range).toEqual(g(1, 1, SCRATCH_ROWS, 1));
    expect(formulaRefs("=3:5")[0].range).toEqual(g(3, 1, 5, SCRATCH_COLS));
  });
  it("names, out-of-grid cells, other sheets and strings are not references", () => {
    expect(formulaRefs("=LOG10+LOG10(A1)").map((x) => x.range)).toEqual([g(1, 1)]);
    expect(formulaRefs("=XFD1")).toEqual([]);
    expect(formulaRefs("=Sheet1!D4+Sheet2!B2").map((x) => x.range)).toEqual([g(4, 4)]);
    expect(formulaRefs('="A1"&B2').map((x) => x.range)).toEqual([g(2, 2)]);
    expect(formulaRefs("abc")).toEqual([]);
    expect(formulaRefs("A1")).toEqual([]);
    expect(formulaRefs("=SUM(A1:").map((x) => x.range)).toEqual([g(1, 1)]);
  });
  it("UTF-16 offsets after astral characters", () => {
    const r = formulaRefs('="😀"&A1');
    expect(r).toHaveLength(1);
    expect(r[0].start).toBe(6);
    expect(r[0].end).toBe(8);
    expect(cpToUtf16('="😀"&A1', 5)).toBe(6);
    expect(utf16ToCp('="😀"&A1', 6)).toBe(5);
    expect(cpToUtf16("=abc", 2)).toBe(2);
  });
  it("seven colours, then the cycle repeats", () => {
    const r = formulaRefs("=A1+B1+C1+D1+E1+F1+G1+H1");
    expect(r.map((x) => x.color)).toEqual([0, 1, 2, 3, 4, 5, 6, 0]);
  });
  it("segments round-trip", () => {
    for (const f of CASES) expect(segments(f, formulaRefs(f)).map((s) => s.text).join("")).toBe(f);
    const s = segments("=A1+B2", formulaRefs("=A1+B2"));
    expect(s).toEqual([{ text: "=" }, { text: "A1", color: 0 }, { text: "+" }, { text: "B2", color: 1 }]);
  });
});

describe("pointRefName", () => {
  it("cells, ranges, whole columns and rows", () => {
    expect(pointRefName(g(1, 1))).toBe("A1");
    expect(pointRefName(g(5, 2, 1, 1))).toBe("A1:B5");
    expect(pointRefName(g(1, 2, SCRATCH_ROWS, 2))).toBe("B:B");
    expect(pointRefName(g(1, 2, SCRATCH_ROWS, 4))).toBe("B:D");
    expect(pointRefName(g(3, 1, 3, SCRATCH_COLS))).toBe("3:3");
    expect(pointRefName(g(3, 1, 5, SCRATCH_COLS))).toBe("3:5");
  });
});
