// Phase 3 contract §4.3 G4: a read-only Scratchpad session changes nothing. Every edit returns reason
// "readonly" and leaves serialize() byte-identical; undo / redo are false; copy, tsvDisplayed and display work.
import { beforeAll, describe, expect, it } from "vitest";
import { initSync } from "@ironcalc/wasm";
import { READONLY_MSG, SheetSession, type EditResult } from "../scratchpad/sheetSession";

// node:fs / node:module, loaded only in this test (no @types/node in the project).
type Fs = { readFileSync(p: string): Uint8Array };
type NodeModule = { createRequire(url: string): { resolve(id: string): string } };
const nodeMod = async <T>(name: string): Promise<T> => (await import(/* @vite-ignore */ name)) as T;

beforeAll(async () => {
  const fs = await nodeMod<Fs>("node:fs");
  const { createRequire } = await nodeMod<NodeModule>("node:module");
  initSync({ module: fs.readFileSync(createRequire(import.meta.url).resolve("@ironcalc/wasm/wasm_bg.wasm")) });
});

const g = (r1: number, c1: number, r2 = r1, c2 = c1) => ({ r1, c1, r2, c2 });

/** A sheet with values, a formula, a format, a column width and one undo + one redo step available. */
function filled(): SheetSession {
  const s = new SheetSession("");
  for (let i = 1; i <= 4; i++) expect(s.setInput(i, 1, String(i * 10)).ok).toBe(true);
  expect(s.setInput(5, 1, "=SUM(A1:A4)").ok).toBe(true);
  expect(s.setInput(1, 2, "Item 1").ok).toBe(true);
  expect(s.setNumFmt(g(1, 1, 4, 1), "0.00").ok).toBe(true);
  expect(s.setColWidth(3, 3, 140).ok).toBe(true);
  expect(s.setInput(6, 6, "undo me").ok).toBe(true);
  expect(s.undoStep()).toBe(true);           // leaves one redo step
  return s;
}

const isReadonly = (r: EditResult) => !r.ok && r.reason === "readonly" && r.message === READONLY_MSG;

describe("G4: SheetSession.readOnly", () => {
  const edits: [string, (s: SheetSession) => EditResult][] = [
    ["setInput", (s) => s.setInput(2, 2, "5")],
    ["setInput clearing", (s) => s.setInput(1, 1, "")],
    ["setInput bad formula", (s) => s.setInput(2, 2, "=SUM(")],
    ["enterInRange", (s) => s.enterInRange(g(1, 3, 3, 3), 1, 3, "=A1*2")],
    ["clear", (s) => s.clear(g(1, 1, 5, 2))],
    ["clearAll", (s) => s.clearAll()],
    ["setNumFmt", (s) => s.setNumFmt(g(1, 1, 5, 1), "0%")],
    ["setColWidth", (s) => s.setColWidth(1, 2, 200)],
    ["insertRows", (s) => s.insertRows(1, 2)],
    ["deleteRows", (s) => s.deleteRows(1, 1)],
    ["insertCols", (s) => s.insertCols(1, 1)],
    ["deleteCols", (s) => s.deleteCols(1, 1)],
    ["paste external", (s) => s.paste(g(8, 1), "1\t2\n3\t4")],
    ["paste one value", (s) => s.paste(g(8, 1, 9, 2), "7")],
    ["fill down", (s) => s.fill(g(1, 1, 4, 1), "down")],
    ["fill right", (s) => s.fill(g(1, 1, 1, 3), "right")],
    ["autoFill", (s) => s.autoFill(g(1, 2), g(1, 2, 6, 2))],
  ];

  for (const [name, run] of edits) {
    it(`${name} is refused and changes nothing`, () => {
      const s = filled();
      const before = s.serialize();
      const v0 = s.version;
      s.readOnly = true;
      expect(isReadonly(run(s))).toBe(true);
      expect(s.serialize()).toBe(before);
      expect(s.version).toBe(v0);
      // the same edit works once the guard is gone
      s.readOnly = false;
      expect(run(s).ok || name === "setInput bad formula").toBe(true);
    }, 60_000);   // clearAll over the whole sheet takes seconds once it really runs
  }

  it("paste of the sheet's own copy (internal clipboard) is refused", () => {
    const s = filled();
    const tsv = s.copy(g(1, 1, 5, 1));
    const before = s.serialize();
    s.readOnly = true;
    expect(isReadonly(s.paste(g(1, 4), tsv))).toBe(true);
    expect(s.serialize()).toBe(before);
  });

  it("cut only copies: the text comes back, the cells stay, a later paste does not move them", () => {
    const s = filled();
    const before = s.serialize();
    s.readOnly = true;
    const tsv = s.copy(g(1, 1, 2, 1), true);
    expect(tsv).toBe("10.00\n20.00");
    expect(s.clip?.cut).toBe(false);
    expect(s.serialize()).toBe(before);
    s.readOnly = false;
    expect(s.paste(g(1, 4), tsv).ok).toBe(true);
    expect(s.display(1, 1)).toBe("10.00");     // copied, not moved
    expect(s.display(1, 4)).toBe("10.00");
  });

  it("undo and redo do nothing", () => {
    const s = filled();
    expect(s.canUndo() && s.canRedo()).toBe(true);
    const before = s.serialize();
    s.readOnly = true;
    expect(s.canUndo()).toBe(false);
    expect(s.canRedo()).toBe(false);
    expect(s.undoStep()).toBe(false);
    expect(s.redoStep()).toBe(false);
    expect(s.serialize()).toBe(before);
    s.readOnly = false;
    expect(s.canUndo() && s.canRedo()).toBe(true);
  });

  it("reading and copying work", () => {
    const s = filled();
    s.readOnly = true;
    expect(s.display(5, 1)).toBe("100");
    expect(s.display(1, 1)).toBe("10.00");
    expect(s.input(5, 1)).toBe("=SUM(A1:A4)");
    expect(s.tsvDisplayed(g(1, 1, 2, 2))).toBe("10.00\tItem 1\n20.00\t");
    expect(s.copy(g(5, 1))).toBe("100");
    expect(s.valuesForData(g(1, 1, 2, 1)).tsv).toBe("10\n20");
    expect(s.usedRange()).toEqual(g(1, 1, 5, 2));
  });
});
