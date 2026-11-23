// Scratchpad function catalog: the table matches what the engine evaluates; ranking and signatures.
import { beforeAll, describe, expect, it } from "vitest";
import { Model } from "@ironcalc/wasm";
import { FUNCTIONS, findFunction, searchFunctions, signatureParts } from "../functionCatalog";
import { initWasm } from "./wasmInit";

beforeAll(initWasm);

const names = (fs: { name: string }[]) => fs.map((f) => f.name);
const current = (p: { text: string; current: boolean }[]) => p.filter((x) => x.current).map((x) => x.text);

describe("function table", () => {
  it("has 493 unique, upper-case, sorted names, each with a description", () => {
    expect(FUNCTIONS.length).toBe(493);
    const n = names([...FUNCTIONS]);
    expect(new Set(n).size).toBe(n.length);
    for (const f of FUNCTIONS) {
      expect(f.name).toBe(f.name.toUpperCase());
      expect(f.desc.length).toBeGreaterThan(0);
    }
    expect([...n].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(n);
    expect(n.some((x) => x.startsWith("FORECAST.ETS"))).toBe(false);
    expect(findFunction("average")?.name).toBe("AVERAGE");
    expect(findFunction("nope")).toBeUndefined();
  });

  it("every function is known to the engine (no #NAME?)", () => {
    const fresh = () => new Model("Scratchpad", "en", "UTC", "en");
    let m = fresh();
    const unknown: string[] = [];
    for (const f of FUNCTIONS) {
      if (f.constant) continue;
      const min = f.args.filter((a) => !a.optional).length;
      const formula = `=${f.name}(${Array(min).fill("1").join(",")})`;
      try {
        m.setUserInput(0, 1, 1, formula);
        m.evaluate();
        if (m.getFormattedCellValue(0, 1, 1) === "#NAME?") unknown.push(f.name);
      } catch {
        try { m.free(); } catch { /* panicked instance */ }
        m = fresh();
      }
    }
    expect(unknown).toEqual([]);
  });
});

describe("searchFunctions", () => {
  it("prefix matches, common first", () => {
    // The prefix tier; names that only contain "AV" (DAVERAGE, RANK.AVG) follow in the contains tier.
    expect(names(searchFunctions("av"))).toEqual(["AVERAGE", "AVERAGEIF", "AVERAGEIFS", "AVEDEV", "AVERAGEA", "DAVERAGE", "RANK.AVG"]);
    expect(names(searchFunctions("s")).slice(0, 4)).toEqual(["SUM", "STDEV.S", "STDEV", "SQRT"]);
    expect(names(searchFunctions("std"))[0]).toBe("STDEV.S");
  });
  it("aliases", () => {
    // Alias tier (avg → AVERAGE…), then the contains tier (RANK.AVG).
    expect(names(searchFunctions("avg"))).toEqual(["AVERAGE", "AVERAGEIF", "AVERAGEIFS", "AVERAGEA", "RANK.AVG"]);
    expect(names(searchFunctions("avgif"))).toEqual(["AVERAGEIF", "AVERAGEIFS"]);
    expect(names(searchFunctions("mean"))[0]).toBe("AVERAGE");
    expect(names(searchFunctions("sem"))[0]).toBe("STDEV.S");
    expect(names(searchFunctions("ttest")).slice(0, 2)).toEqual(["TTEST", "T.TEST"]);   // TTEST itself is a prefix match
  });
  it("contains tier after prefix", () => {
    const d = names(searchFunctions("dev"));
    expect(d[0]).toBe("DEVSQ");
    expect(d.slice(1, 4)).toEqual(["STDEV.S", "STDEV", "STDEV.P"]);
    expect(d).toContain("AVEDEV");
  });
  it("nothing for empty or unknown", () => {
    expect(searchFunctions("")).toEqual([]);
    expect(searchFunctions("zzz")).toEqual([]);
    expect(searchFunctions("a", 3)).toHaveLength(3);
  });
});

describe("signatureParts", () => {
  const sig = (n: string, i?: number) => signatureParts(findFunction(n)!, i);
  it("text and the current argument", () => {
    expect(sig("AVERAGE").map((p) => p.text).join("")).toBe("AVERAGE(number1, [number2], …)");
    expect(current(sig("AVERAGE", 1))).toEqual(["number1"]);
    expect(current(sig("AVERAGE", 2))).toEqual(["[number2]"]);
    expect(current(sig("AVERAGE", 5))).toEqual(["[number2]"]);
    expect(current(sig("SUMIFS", 4))).toEqual(["[criteria_range2]"]);
    expect(current(sig("SUMIFS", 5))).toEqual(["[criteria2]"]);
    expect(current(sig("SUMIFS", 7))).toEqual(["[criteria2]"]);
    expect(current(sig("ROUND", 3))).toEqual([]);
    expect(sig("PI").map((p) => p.text).join("")).toBe("PI()");
    expect(sig("TRUE").map((p) => p.text).join("")).toBe("TRUE");
    expect(sig("IF").map((p) => p.text).join("")).toBe("IF(logical_test, value_if_true, [value_if_false])");
  });
});
