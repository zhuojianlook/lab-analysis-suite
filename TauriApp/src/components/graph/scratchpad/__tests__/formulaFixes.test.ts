// Regressions from the Scratchpad formula-editing review: missing brackets on Enter, F4 offsets after astral
// characters, lone surrogates, F4's $ form kept by the next pointed reference, point-mode click rules (header
// modifier-click), the double-click echo after a list pick, the dashed pending outline, caret scrolling.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Model } from "@ironcalc/wasm";
import {
  PICK_ECHO_MS, closeBrackets, cycleReferenceUtf16, dollarsOf, isPickEcho, pointHow, scrollToShow, withDollars,
} from "../formulaEdit";
import { cpToUtf16, formulaRefs, refContaining, utf16ToCp } from "../formulaRefs";
import { SheetSession } from "../sheetSession";
import { initWasm } from "./wasmInit";

let model: Model;
beforeAll(async () => {
  await initWasm();
  model = new Model("Scratchpad", "en", "UTC", "en");
});
afterAll(() => { try { model.free(); } catch { /* ok */ } });

describe("closeBrackets (F1)", () => {
  it("adds every missing ) at the end", () => {
    expect(closeBrackets("=ROUND(AVERAGE(A1:A3")).toBe("=ROUND(AVERAGE(A1:A3))");
    expect(closeBrackets("=MIN(MAX(A1:A3")).toBe("=MIN(MAX(A1:A3))");
    expect(closeBrackets("=IF(A1>0,SUM(A1:A3")).toBe("=IF(A1>0,SUM(A1:A3))");
    expect(closeBrackets("=SUM((A1+A2")).toBe("=SUM((A1+A2))");
    expect(closeBrackets("=ROUND(AVERAGE(A1:A3)")).toBe("=ROUND(AVERAGE(A1:A3))");
    expect(closeBrackets("=IF(A1>0,ROUND(AVERAGE(A1:A3")).toBe("=IF(A1>0,ROUND(AVERAGE(A1:A3)))");
    expect(closeBrackets("=SUM(A1:A3")).toBe("=SUM(A1:A3)");
  });
  it("leaves balanced, over-closed, non-formula and unclosed-string text alone", () => {
    for (const t of ["=SUM(A1:A3)", "=A1+1", "=SUM(A1))", "abc(", "", "=", '=CONCAT("a(', '="a""(', "=IF(A1,\"(\",B1)"]) {
      expect([t, closeBrackets(t)]).toEqual([t, t]);
    }
    expect(closeBrackets('=CONCAT("(",A1')).toBe('=CONCAT("(",A1)');
    expect(closeBrackets('=LEN("a""b"')).toBe('=LEN("a""b")');
  });
  it("the closed text is accepted where the raw one is refused", () => {
    const s = new SheetSession("");
    for (let i = 1; i <= 3; i++) expect(s.setInput(i, 1, String([1, 2, 4][i - 1])).ok).toBe(true);
    const cases: [string, string][] = [
      ["=MIN(MAX(A1:A3", "4"],
      ["=IF(A1>0,SUM(A1:A3", "7"],
      ["=SUM((A1+A2", "3"],
      ["=ROUND(AVERAGE(A1:A3),MIN(1,2", "2.3"],
      ["=IF(A1>0,ROUND(AVERAGE(A1:A3),MAX(0,1", "2.3"],
    ];
    for (const [t] of cases) expect([t, s.setInput(5, 1, t).ok]).toEqual([t, false]);   // refused as typed
    // ROUND needs its digits argument: no bracket fix makes that valid (the hint shows it).
    expect(s.setInput(4, 1, closeBrackets("=ROUND(AVERAGE(A1:A3")).ok).toBe(false);
    for (const [t, v] of cases) {
      expect([t, s.setInput(4, 1, closeBrackets(t)).ok]).toEqual([t, true]);
      expect([t, s.display(4, 1)]).toEqual([t, v]);
    }
  });
});

describe("cycleReferenceUtf16 (F3)", () => {
  const cycle = (t: string, a: number, b: number) => model.cycleReference(t, a, b);
  const t = '="😀"&A1+B2';   // UTF-16 length 11; A1 = [6, 8), B2 = [9, 11)
  it("cycles the reference at the caret after an astral character", () => {
    expect(t.length).toBe(11);
    const r = cycleReferenceUtf16(t, 8, 8, cycle);
    expect(r.text).toBe('="😀"&$A$1+B2');
    expect(r.text.slice(r.end - 4, r.end)).toBe("$A$1");
  });
  it("works at the end of the text (the raw call threw)", () => {
    const r = cycleReferenceUtf16(t, 11, 11, cycle);
    expect(r.text).toBe('="😀"&A1+$B$2');
    expect(r.end).toBe(r.text.length);
  });
  it("plain text keeps its offsets", () => {
    const r = cycleReferenceUtf16("=A1", 3, 3, cycle);
    expect(r).toMatchObject({ text: "=$A$1", end: 5 });
  });
});

describe("lone surrogates (F5)", () => {
  it("count as one code point", () => {
    const t = '="\uD83D"&A1';
    expect(utf16ToCp(t, t.length)).toBe(t.length);
    expect(cpToUtf16(t, 6)).toBe(6);
    const refs = formulaRefs(t);
    expect(refs).toHaveLength(1);
    expect(t.slice(refs[0].start, refs[0].end)).toBe("A1");
  });
  it("a real pair is still two units", () => {
    const t = '="😀\uD83D"&A1';
    const refs = formulaRefs(t);
    expect(t.slice(refs[0].start, refs[0].end)).toBe("A1");
    expect(utf16ToCp(t, t.length)).toBe(t.length - 1);
  });
});

describe("F4's $ form (VX-3)", () => {
  it("dollarsOf", () => {
    expect(dollarsOf("$A$2")).toEqual({ c: true, r: true });
    expect(dollarsOf("A$2")).toEqual({ c: false, r: true });
    expect(dollarsOf("$A2:$B5")).toEqual({ c: true, r: false });
    expect(dollarsOf("$A:$C")).toEqual({ c: true, r: false });
    expect(dollarsOf("$3:$5")).toEqual({ c: false, r: true });
    expect(dollarsOf("A2")).toBeUndefined();
    expect(dollarsOf("A:A")).toBeUndefined();
  });
  it("withDollars", () => {
    expect(withDollars("A3", { c: true, r: true })).toBe("$A$3");
    expect(withDollars("A3:B5", { c: false, r: true })).toBe("A$3:B$5");
    expect(withDollars("A:C", { c: true, r: true })).toBe("$A:$C");
    expect(withDollars("3:5", { c: true, r: true })).toBe("$3:$5");
    expect(withDollars("A3", undefined)).toBe("A3");
  });
  it("round-trips with the engine's F4", () => {
    let t = "=A2";
    for (let i = 0; i < 4; i++) {
      t = cycleReferenceUtf16(t, t.length, t.length, (x, a, b) => model.cycleReference(x, a, b)).text;
      const ref = t.slice(1);
      expect(withDollars("A2", dollarsOf(ref))).toBe(ref);
    }
  });
});

describe("pointHow (F4: header modifier-click; same rules as the body)", () => {
  const at = { atPending: true, afterRef: true, unionOnly: false };
  const fresh = { atPending: false, afterRef: false, unionOnly: false };
  const typed = { atPending: false, afterRef: true, unionOnly: true };
  it("plain click", () => {
    expect(pointHow(fresh, false, false, false)).toEqual({ how: "insert", extend: false });
    expect(pointHow(at, true, false, false)).toEqual({ how: "replace", extend: false });
    expect(pointHow(typed, false, false, false)).toBeNull();
  });
  it("shift extends the pending reference", () => {
    expect(pointHow(at, true, true, false)).toEqual({ how: "replace", extend: true });
    expect(pointHow(fresh, false, true, false)).toEqual({ how: "insert", extend: false });
  });
  it("modifier adds ,ref after a reference (pending or typed)", () => {
    expect(pointHow(at, true, false, true)).toEqual({ how: "union", extend: false });
    expect(pointHow(typed, false, false, true)).toEqual({ how: "union", extend: false });
    expect(pointHow(fresh, false, false, true)).toEqual({ how: "insert", extend: false });
  });
});

describe("isPickEcho (VX-1)", () => {
  it("only the second press of a double-click right after a pick", () => {
    expect(isPickEcho(2, 1100, 1000)).toBe(true);
    expect(isPickEcho(3, 1100, 1000)).toBe(true);
    expect(isPickEcho(1, 1100, 1000)).toBe(false);
    expect(isPickEcho(2, 1000 + PICK_ECHO_MS, 1000)).toBe(false);
    expect(isPickEcho(2, 5, -Infinity)).toBe(false);
  });
});

describe("refContaining (VX-6: dashed pending outline)", () => {
  it("a click after a typed ':' makes the whole range pending", () => {
    const refs = formulaRefs("=A1:A5");
    const hit = refContaining(refs, 4, 6);   // the pointed "A5"
    expect(hit?.range).toEqual({ r1: 1, c1: 1, r2: 5, c2: 1 });
    expect(refContaining(formulaRefs("=SUM(A1,B2)"), 8, 10)?.range).toEqual({ r1: 2, c1: 2, r2: 2, c2: 2 });
    expect(refContaining(formulaRefs("=SUM(A1,B2)"), 1, 4)).toBeUndefined();
  });
});

describe("scrollToShow (VX-4)", () => {
  it("scrolls just enough to show x", () => {
    expect(scrollToShow(1200, 433, 681, 1000)).toBe(1200 + 8 - 681);
    expect(scrollToShow(500, 433, 681, 1000)).toBe(433);
    expect(scrollToShow(100, 433, 681, 1000)).toBe(92);
    expect(scrollToShow(2000, 0, 681, 500)).toBe(500);
    expect(scrollToShow(3, 50, 681, 500)).toBe(0);
  });
});
