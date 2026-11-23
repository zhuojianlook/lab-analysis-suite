// Scratchpad formula editing: what may go at the caret (engine-backed), reference insertion, completion.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Model } from "@ironcalc/wasm";
import { applyCompletion, assist, insertReference, NO_ASSIST, type Complete } from "../formulaEdit";
import { findFunction } from "../functionCatalog";
import { initWasm } from "./wasmInit";

let model: Model;
let complete: Complete;
beforeAll(async () => {
  await initWasm();
  model = new Model("Scratchpad", "en", "UTC", "en");
  complete = (f, cur) => model.getFormulaCompletion(0, 1, 1, f, cur);
});
afterAll(() => { try { model.free(); } catch { /* ok */ } });

const at = (text: string, caret = text.length, end = caret) => assist(text, caret, end, complete);
const pos = { r: 1, c: 1 };

describe("assist", () => {
  it("canPoint where a reference may go", () => {
    for (const t of ["=", "=SUM(", "=SUM(A1,", "=SUM(A1, ", "=A1+", "=SUM(A1:", "=1+(", "=-", "=IF(A1>"]) {
      expect([t, at(t).canPoint]).toEqual([t, true]);
    }
    expect(at("=SUM()", 5).canPoint).toBe(true);
  });
  it("no pointing after a finished operand", () => {
    for (const t of ["=A1", "=SUM(A1", "=SUM(A1 ", "=SUM(A1:A2)", "=1", '="a', "abc"]) {
      expect([t, at(t).canPoint]).toEqual([t, false]);
    }
    expect(at("abc")).toBe(NO_ASSIST);
  });
  it("function name being typed", () => {
    expect(at("=av").fn).toEqual({ partial: "av", start: 1 });
    expect(at("=SUM(A1:B2)+av").fn).toEqual({ partial: "av", start: 12 });
    expect(at('="é😀"&av').fn?.start).toBe(7);
    expect(at("=A1:B").fn).toBeNull();
    expect(at("=av", 2).fn).toBeNull();
    expect(at("=A1").fn).toBeNull();
    expect(at("abc").fn).toBeNull();
    expect(at("=av", 1, 3).fn).toBeNull();
  });
  it("enclosing function and argument", () => {
    expect(at("=AVERAGE(").arg).toEqual({ name: "AVERAGE", index: 1 });
    expect(at("=AVERAGE(A1,").arg).toEqual({ name: "AVERAGE", index: 2 });
    expect(at("=SUM(1,2)*").arg).toBeNull();
    expect(at("=IF(A1>1,SUM(").arg).toEqual({ name: "SUM", index: 1 });
    expect(at("=IF(A1>1,SUM(B1),").arg).toEqual({ name: "IF", index: 3 });
    expect(at("=SUM({1,2},").arg).toEqual({ name: "SUM", index: 2 });
    expect(at("=SUM((A1+").arg).toEqual({ name: "SUM", index: 1 });
    expect(at("=FOO(").arg).toBeNull();
    expect(at("=sumifs(A:A,B:B,1,C:C,").arg).toEqual({ name: "SUMIFS", index: 5 });
  });
  it("afterRef", () => {
    expect(at("=SUM(A1").afterRef).toBe(true);
    expect(at("=SUM(A1,").afterRef).toBe(false);
  });
});

describe("insertReference", () => {
  it("insert, replace, union", () => {
    expect(insertReference("=SUM(", 5, 5, null, "A1", "insert")).toEqual({ text: "=SUM(A1", start: 5, end: 7 });
    const pending = { start: 5, end: 7, anchor: pos, focus: pos };
    expect(insertReference("=SUM(A1", 7, 7, pending, "A1:A4", "replace")).toEqual({ text: "=SUM(A1:A4", start: 5, end: 10 });
    expect(insertReference("=SUM(A1", 7, 7, pending, "B2", "union")).toEqual({ text: "=SUM(A1,B2", start: 8, end: 10 });
    expect(insertReference("=SUM(xyz)", 5, 8, null, "C3", "insert")).toEqual({ text: "=SUM(C3)", start: 5, end: 7 });
    expect(insertReference("=SUM()", 5, 5, null, "A1", "insert").text).toBe("=SUM(A1)");
  });
});

describe("applyCompletion", () => {
  const fn = (n: string) => findFunction(n)!;
  it("inserts NAME( with the caret inside", () => {
    expect(applyCompletion("=av", 1, 3, fn("AVERAGE"))).toEqual({ text: "=AVERAGE(", caret: 9 });
    expect(applyCompletion("=SUM(av)", 5, 7, fn("AVERAGE"))).toEqual({ text: "=SUM(AVERAGE()", caret: 13 });
    expect(applyCompletion("=av(", 1, 3, fn("AVERAGE"))).toEqual({ text: "=AVERAGE(", caret: 9 });
    expect(applyCompletion("=p", 1, 2, fn("PI"))).toEqual({ text: "=PI()", caret: 5 });
    expect(applyCompletion("=tr", 1, 3, fn("TRUE"))).toEqual({ text: "=TRUE", caret: 5 });
  });
});
