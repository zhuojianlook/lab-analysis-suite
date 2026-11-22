import { describe, expect, it } from "vitest";
import {
  applyShownOrder, moveAnnouncement, moveItem, orderGenes, panelKey, parseStore, refsFirst, savedOrderFor, withSavedOrder,
} from "./geneOrder";

describe("orderGenes", () => {
  it("follows the saved order, filtered to the shown genes", () => {
    expect(orderGenes(["KERA", "ACTA2", "LUM", "TNC"], ["ACTA2", "TNC", "KERA"])).toEqual(["KERA", "ACTA2", "TNC"]);
  });
  it("appends genes that were never arranged, in selection order", () => {
    expect(orderGenes(["LUM", "ACTA2"], ["ACTA2", "TNC", "LUM", "B3GNT7"])).toEqual(["LUM", "ACTA2", "TNC", "B3GNT7"]);
  });
  it("is the selection order when nothing is saved", () => {
    expect(orderGenes([], ["GAPDH", "TNC", "ACTA2"])).toEqual(["GAPDH", "TNC", "ACTA2"]);
  });
  it("drops genes no longer shown and ignores duplicates", () => {
    expect(orderGenes(["A", "B", "A", "C"], ["C", "A"])).toEqual(["A", "C"]);
    expect(orderGenes(["A"], ["B", "B"])).toEqual(["B"]);
  });
});

describe("moveItem", () => {
  it("moves down and up", () => {
    expect(moveItem(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveItem(["a", "b", "c", "d"], 3, 0)).toEqual(["d", "a", "b", "c"]);
  });
  it("clamps the target and ignores a bad source", () => {
    expect(moveItem(["a", "b", "c"], 0, 99)).toEqual(["b", "c", "a"]);
    expect(moveItem(["a", "b", "c"], 2, -5)).toEqual(["c", "a", "b"]);
    expect(moveItem(["a", "b"], 5, 0)).toEqual(["a", "b"]);
  });
});

describe("applyShownOrder", () => {
  it("keeps hidden genes in their slots", () => {
    // TNC hidden (e.g. un-ticked); the shown three are reversed
    expect(applyShownOrder(["A", "TNC", "B", "C"], ["C", "B", "A"])).toEqual(["C", "TNC", "B", "A"]);
  });
  it("adds genes not saved yet", () => {
    expect(applyShownOrder(["A", "B"], ["NEW", "A", "B"])).toEqual(["NEW", "A", "B"]);
    expect(applyShownOrder([], ["B", "A"])).toEqual(["B", "A"]);
  });
  it("round-trips: what is shown afterwards is what was arranged", () => {
    const saved = ["GAPDH", "KERA", "LUM", "ACTA2", "TNC"];
    const shown = ["ACTA2", "LUM", "KERA"];                 // GAPDH and TNC hidden
    const arranged = moveItem(orderGenes(saved, shown), 2, 0);
    const next = applyShownOrder(saved, arranged);
    expect(orderGenes(next, shown)).toEqual(arranged);
    expect(orderGenes(next, ["GAPDH", ...shown, "TNC"])).toEqual(["GAPDH", ...arranged, "TNC"]);
  });
  it("a gene re-ticked later comes back where it was", () => {
    const saved = applyShownOrder([], ["TNC", "ACTA2", "KERA"]);
    expect(orderGenes(saved, ["ACTA2", "KERA"])).toEqual(["ACTA2", "KERA"]);
    expect(orderGenes(saved, ["ACTA2", "KERA", "TNC"])).toEqual(["TNC", "ACTA2", "KERA"]);
  });
});

describe("refsFirst", () => {
  it("puts reference genes first, each group in the user's order", () => {
    expect(refsFirst(["TNC", "ACTB", "ACTA2", "GAPDH"], ["GAPDH", "ACTB", "ACTA2", "TNC"], ["GAPDH", "ACTB"]))
      .toEqual(["ACTB", "GAPDH", "TNC", "ACTA2"]);
  });
});

describe("persistence", () => {
  const key1 = panelKey(["TNC", "ACTA2", "GAPDH"]);
  it("keys a panel by its genes regardless of order", () => {
    expect(panelKey(["GAPDH", "ACTA2", "TNC"])).toBe(key1);
  });
  it("reads malformed values as empty", () => {
    expect(parseStore(null)).toEqual({ panels: {}, recent: [] });
    expect(parseStore("not json")).toEqual({ panels: {}, recent: [] });
    expect(parseStore("[1,2]")).toEqual({ panels: {}, recent: [] });
    expect(parseStore(JSON.stringify({ panels: { a: ["x", 3] }, recent: ["a", "gone", 5] })))
      .toEqual({ panels: { a: ["x"] }, recent: ["a"] });
  });
  it("saves per panel; a panel never arranged has no order (does not borrow another's)", () => {
    let s = withSavedOrder(parseStore(null), key1, ["TNC", "ACTA2"]);
    expect(savedOrderFor(s, key1)).toEqual(["TNC", "ACTA2"]);
    expect(savedOrderFor(s, "other")).toEqual([]);
    expect(orderGenes(savedOrderFor(s, "other"), ["KERA", "ACTA2", "TNC"])).toEqual(["KERA", "ACTA2", "TNC"]);
    s = withSavedOrder(s, "other", ["X"]);
    expect(savedOrderFor(s, key1)).toEqual(["TNC", "ACTA2"]);
    expect(s.recent).toEqual(["other", key1]);
  });
  it("a reset panel stays in selection order (does not borrow)", () => {
    let s = withSavedOrder(parseStore(null), "a", ["B", "A"]);
    s = withSavedOrder(s, "b", []);
    expect(savedOrderFor(s, "b")).toEqual([]);
    expect(orderGenes(savedOrderFor(s, "b"), ["A", "B"])).toEqual(["A", "B"]);
  });
  it("forgets the oldest panels past the cap", () => {
    let s = parseStore(null);
    for (let i = 0; i < 40; i++) s = withSavedOrder(s, `p${i}`, [`g${i}`]);
    expect(Object.keys(s.panels)).toHaveLength(30);
    expect(s.panels.p0).toBeUndefined();
    expect(s.panels.p39).toEqual(["g39"]);
    expect(s.recent[0]).toBe("p39");
  });
  it("stores only the panel's own genes", () => {
    const s = withSavedOrder(parseStore(null), "a", ["ITGA5", "TNC", "GAPDH", "FN1"], ["GAPDH", "TNC", "KERA"]);
    expect(s.panels.a).toEqual(["TNC", "GAPDH"]);
  });
  it("forgets a panel on null", () => {
    const s = withSavedOrder(withSavedOrder(parseStore(null), "a", ["x"]), "a", null);
    expect(s.panels).toEqual({});
    expect(s.recent).toEqual([]);
  });
});

describe("reference genes without a saved place", () => {
  it("go first, as before any order was saved", () => {
    expect(orderGenes(["TNC", "ACTA2", "KERA"], ["GAPDH", "ACTA2", "KERA", "TNC"], ["GAPDH"]))
      .toEqual(["GAPDH", "TNC", "ACTA2", "KERA"]);
  });
  it("keep their saved place once arranged", () => {
    expect(orderGenes(["TNC", "GAPDH", "ACTA2"], ["GAPDH", "ACTA2", "TNC"], ["GAPDH"]))
      .toEqual(["TNC", "GAPDH", "ACTA2"]);
  });
  it("other new genes still go last", () => {
    expect(orderGenes(["TNC"], ["GAPDH", "ACTA2", "TNC"], ["GAPDH"])).toEqual(["GAPDH", "TNC", "ACTA2"]);
  });
});

describe("moveAnnouncement", () => {
  it("is 1-based", () => {
    expect(moveAnnouncement("KERA", 0, 12)).toBe("KERA moved to position 1 of 12.");
  });
});
