import { describe, expect, it } from "vitest";
import type { Revision } from "./format";
import {
  findBase, isAncestor, isAncestorOrSelf, lowestCommonAncestors, newestFirst, relation, snapshotPool, survivorPath, tips,
  unionRevisions,
} from "./revisions";
import { ancestorSets, fileOf, randomDag, refs, rev, rng } from "./fixtures-p2/kit";

// R ─ A1 ─ A2            (linear on A)
//   └ B1 ─ B2            (fork at R)
// M = combine(A2, B2), N after M
const forked = (): Revision[] => [
  rev("R"), rev("A1", ["R"]), rev("A2", ["A1"]), rev("B1", ["R"]), rev("B2", ["B1"]),
  rev("M", ["A2", "B2"]), rev("N", ["M"]),
];

// Criss-cross: both sides combined A1 and B1, differently.
const crissCross = (): Revision[] => [
  rev("R"), rev("A1", ["R"]), rev("B1", ["R"]),
  rev("A2", ["A1", "B1"]), rev("B2", ["A1", "B1"]),
  rev("A3", ["A2"]), rev("B3", ["B2"]),
];

describe("M1 ancestry and relation", () => {
  it("linear, forked, combined", () => {
    const h = forked();
    expect(isAncestor(h, "R", "N")).toBe(true);
    expect(isAncestor(h, "B1", "M")).toBe(true);
    expect(isAncestor(h, "A2", "B2")).toBe(false);
    expect(isAncestor(h, "N", "N")).toBe(false);
    expect(isAncestorOrSelf(h, "N", "N")).toBe(true);
    expect(isAncestorOrSelf(h, "A1", "A2")).toBe(true);
    expect(isAncestorOrSelf(h, "A2", "A1")).toBe(false);
    expect(relation(h, "A2", "A2")).toBe("same");
    expect(relation(h, "A2", "A1")).toBe("older");
    expect(relation(h, "A1", "N")).toBe("newer");
    expect(relation(h, "A2", "B2")).toBe("diverged");
  });

  it("criss-cross", () => {
    const h = crissCross();
    expect(relation(h, "A3", "B3")).toBe("diverged");
    expect(isAncestor(h, "B1", "A3")).toBe(true);
    expect(isAncestor(h, "A2", "B3")).toBe(false);
  });

  it("unknown ids are never ancestors", () => {
    const h = forked();
    expect(isAncestor(h, "X", "N")).toBe(false);
    expect(isAncestor(h, "R", "X")).toBe(false);
    expect(isAncestorOrSelf(h, "X", "X")).toBe(false);
    expect(relation(h, "X", "N")).toBe("diverged");
    // A parent named but not in the list is no ancestor either.
    const partial = [rev("A1", ["gone"]), rev("A2", ["A1"])];
    expect(isAncestor(partial, "gone", "A2")).toBe(false);
    expect(isAncestor(partial, "A1", "A2")).toBe(true);
  });

  it("a 5,000-entry chain without stack overflow", () => {
    const h: Revision[] = [rev("c0")];
    for (let i = 1; i < 5000; i++) h.push(rev(`c${i}`, [`c${i - 1}`]));
    expect(isAncestor(h, "c0", "c4999")).toBe(true);
    expect(relation(h, "c4999", "c0")).toBe("older");
    expect(lowestCommonAncestors(h, "c4999", "c10")).toEqual(["c10"]);
    expect(newestFirst(h, () => 0).map((r) => r.id)[0]).toBe("c4999");
  });

  it("agrees with a brute force on random histories", () => {
    const r = rng(11);
    for (let t = 0; t < 40; t++) {
      const h = randomDag(r, 5 + r.int(30), { roots: 1 + r.int(2) });
      const anc = ancestorSets(h);
      for (let k = 0; k < 30; k++) {
        const a = r.pick(h).id, b = r.pick(h).id;
        expect(isAncestorOrSelf(h, a, b)).toBe(anc.get(b)!.has(a));
        expect(isAncestor(h, a, b)).toBe(a !== b && anc.get(b)!.has(a));
      }
    }
  });
});

describe("M2 lowest common ancestors", () => {
  it("simple fork → the fork point", () => {
    expect(lowestCommonAncestors(forked(), "A2", "B2")).toEqual(["R"]);
  });
  it("criss-cross → two", () => {
    expect(lowestCommonAncestors(crissCross(), "A3", "B3")).toEqual(["A1", "B1"]);
  });
  it("one side an ancestor → that side", () => {
    expect(lowestCommonAncestors(forked(), "A1", "N")).toEqual(["A1"]);
    expect(lowestCommonAncestors(forked(), "N", "N")).toEqual(["N"]);
  });
  it("no common history → none; unknown → none", () => {
    const h = [rev("X"), rev("Y"), rev("X1", ["X"])];
    expect(lowestCommonAncestors(h, "X1", "Y")).toEqual([]);
    expect(lowestCommonAncestors(h, "X1", "nope")).toEqual([]);
  });
  it("matches the definition on random histories, criss-cross combines included", () => {
    const r = rng(2026);
    let multi = 0;
    for (let t = 0; t < 120; t++) {
      const h = randomDag(r, 4 + r.int(40), { mergeP: 0.4, roots: 1 + r.int(2) });
      const anc = ancestorSets(h);
      for (let k = 0; k < 10; k++) {
        const a = r.pick(h).id, b = r.pick(h).id;
        const common = [...anc.get(a)!].filter((x) => anc.get(b)!.has(x));
        const expected = common.filter((c) => !common.some((d) => d !== c && anc.get(d)!.has(c))).sort();
        const got = lowestCommonAncestors(h, a, b);
        expect(got).toEqual(expected);
        expect(lowestCommonAncestors(h, b, a)).toEqual(got);
        if (got.length > 1) multi++;
      }
    }
    expect(multi).toBeGreaterThan(0);   // the generator does produce criss-crosses
  });
});

describe("M3 findBase", () => {
  const all = () => true;
  it("lca when stored", () => {
    expect(findBase(forked(), "A2", "B2", all)).toEqual({ kind: "lca", id: "R" });
  });
  it("nearest when the lowest common version's content is gone but an older one is stored", () => {
    const h = [rev("R"), rev("X", ["R"]), rev("A", ["X"]), rev("B", ["X"])];
    expect(findBase(h, "A", "B", (id) => id !== "X")).toEqual({ kind: "nearest", id: "R" });
    // Of two stored common versions on one line, the lower one (closest to the sides) is taken.
    const h2 = [rev("R0"), rev("R"), rev("X", ["R"]), rev("Y", ["X"]), rev("A", ["Y"]), rev("B", ["Y"])];
    h2[1] = rev("R", ["R0"]);
    expect(findBase(h2, "A", "B", (id) => id === "R" || id === "R0")).toEqual({ kind: "nearest", id: "R" });
  });
  it("ambiguous for a criss-cross (smallest stored id)", () => {
    expect(findBase(crissCross(), "A3", "B3", all)).toEqual({ kind: "ambiguous", id: "A1" });
    expect(findBase(crissCross(), "A3", "B3", (id) => id !== "A1")).toEqual({ kind: "ambiguous", id: "B1" });
    // Neither lowest stored → the nearest stored common one.
    expect(findBase(crissCross(), "A3", "B3", (id) => id === "R")).toEqual({ kind: "nearest", id: "R" });
  });
  it("none when nothing common is stored, or no common history", () => {
    expect(findBase(forked(), "A2", "B2", () => false)).toEqual({ kind: "none" });
    expect(findBase([rev("X"), rev("Y")], "X", "Y", all)).toEqual({ kind: "none" });
  });
  it("notDiverged with the relation of theirs to mine", () => {
    expect(findBase(forked(), "A2", "A2", all)).toEqual({ kind: "notDiverged", relation: "same" });
    expect(findBase(forked(), "A2", "A1", all)).toEqual({ kind: "notDiverged", relation: "older" });
    expect(findBase(forked(), "A1", "N", all)).toEqual({ kind: "notDiverged", relation: "newer" });
  });
  it("content found only in a third file (the saved copy) counts", () => {
    const h = forked();
    const strip = (rs: Revision[], keep: string[]) => rs.map((r) => (keep.includes(r.id) ? r : { ...r, sections: null }));
    const partsFor = (ids: string[]) => {
      const p: Record<string, string> = {};
      for (const id of ids) for (const ref of Object.values(refs(`t${id}`, `a${id}`, `f${id}`, `s${id}`))) p[ref.part] = `{"x":"${id}"}`;
      return p;
    };
    const withRefs = (rs: Revision[]) => rs.map((r) => (r.sections ? { ...r, sections: refs(`t${r.id}`, `a${r.id}`, `f${r.id}`, `s${r.id}`) } : r));
    const mine = fileOf(withRefs(strip(h.slice(0, 3), ["A2"])), partsFor(["A2"]), "A2");
    const theirs = fileOf(withRefs(strip([h[0], h[3], h[4]], ["B2"])), partsFor(["B2"]), "B2");
    const revs = unionRevisions(mine.manifest, theirs.manifest);
    const twoFiles = snapshotPool([mine, theirs]);
    expect(findBase(revs, "A2", "B2", twoFiles.has)).toEqual({ kind: "none" });
    const journal = fileOf(withRefs([h[0]]), partsFor(["R"]), "R");
    const pool = snapshotPool([mine, theirs, journal]);
    expect(findBase(revs, "A2", "B2", pool.has)).toEqual({ kind: "lca", id: "R" });
    expect(pool.get("R")).toEqual({ table: { x: "R" }, analysis: { x: "R" }, figure: { x: "R" }, scratchpad: { x: "R" } });
  });
  it("a throwing stored() counts as not stored", () => {
    expect(findBase(forked(), "A2", "B2", () => { throw new Error("x"); })).toEqual({ kind: "none" });
  });
});

describe("M4 unionRevisions", () => {
  it("a stored entry wins over the same id without content, from either side; order of first appearance", () => {
    const a = [rev("R", [], { sections: null }), rev("A", ["R"])];
    const b = [rev("R"), rev("B", ["R"], { sections: null })];
    const c = [rev("B", ["R"])];
    const u = unionRevisions({ revisions: a }, { revisions: b }, { revisions: c });
    expect(u.map((r) => r.id)).toEqual(["R", "A", "B"]);
    expect(u[0]).toBe(b[0]);
    expect(u[2]).toBe(c[0]);
    const u2 = unionRevisions({ revisions: b }, { revisions: a });
    expect(u2[0]).toBe(b[0]);
    expect(u2.map((r) => r.id)).toEqual(["R", "B", "A"]);
  });
  it("carries the revision objects along unchanged (unknown fields survive)", () => {
    const odd = { ...rev("R"), zz: 1 } as Revision;
    expect(unionRevisions({ revisions: [odd] })[0]).toBe(odd);
  });
});

describe("M5 survivorPath", () => {
  it("shortest name, then alphabetical, then full path; any input order", () => {
    const paths = [
      "/D/Lab/Dose response (Alice's conflicted copy 2026-11-20).lag",
      "/D/Lab/Dose response.lag",
      "/D/Lab/Dose response (1).lag",
    ];
    const r = rng(5);
    for (let i = 0; i < 20; i++) expect(survivorPath(r.shuffle(paths))).toBe("/D/Lab/Dose response.lag");
    expect(survivorPath(["/x/b.lag", "/x/a.lag"])).toBe("/x/a.lag");
    expect(survivorPath(["/z/a.lag", "/y/a.lag"])).toBe("/y/a.lag");
    expect(survivorPath(["/long/folder/name/ab.lag", "/x/abc.lag"])).toBe("/long/folder/name/ab.lag");
    expect(survivorPath([])).toBe("");
  });
});

describe("M6 newestFirst and tips", () => {
  it("children before parents under ±2 h clock skew; larger key first, then larger id", () => {
    const r = rng(77);
    for (let t = 0; t < 60; t++) {
      const h = randomDag(r, 3 + r.int(40), { mergeP: 0.3, skew: 120 });
      const order = newestFirst(h, (x) => Date.parse(x.time));
      expect(order.length).toBe(h.length);
      const pos = new Map(order.map((x, i) => [x.id, i]));
      for (const x of h) for (const p of x.parents) expect(pos.get(p)!).toBeGreaterThan(pos.get(x.id)!);
      // Deterministic under shuffling.
      for (let k = 0; k < 3; k++) expect(newestFirst(r.shuffle(h), (x) => Date.parse(x.time)).map((x) => x.id)).toEqual(order.map((x) => x.id));
    }
  });
  it("tie-break and NaN keys", () => {
    const h = [rev("R"), rev("b", ["R"]), rev("a", ["R"]), rev("c", ["R"])];
    expect(newestFirst(h, () => 1).map((x) => x.id)).toEqual(["c", "b", "a", "R"]);
    expect(newestFirst(h, (x) => (x.id === "a" ? 5 : NaN)).map((x) => x.id)).toEqual(["a", "c", "b", "R"]);
  });
  it("survives a cycle (damaged history) and lists every revision once", () => {
    const h = [rev("x", ["y"]), rev("y", ["x"]), rev("z", ["x"])];
    const out = newestFirst(h, () => 0).map((r) => r.id);
    expect([...out].sort()).toEqual(["x", "y", "z"]);
    expect(out[0]).toBe("z");
  });
  it("tips", () => {
    expect(tips(forked())).toEqual(["N"]);
    expect(tips(crissCross())).toEqual(["A3", "B3"]);
  });
});

describe("snapshotPool", () => {
  it("first file wins; a revision counts only when all four parts are there and parse", () => {
    const r1 = rev("R", [], { sections: refs("t1", "a1", "f1", "s1") });
    const good = { "parts/t1.json": "1", "parts/a1.json": "2", "parts/f1.json": "3", "parts/s1.json": "null" };
    const missing = fileOf([r1], { "parts/t1.json": "9" });
    const broken = fileOf([r1], { ...good, "parts/f1.json": "{nope" });
    const ok = fileOf([r1], good);
    const ok2 = fileOf([r1], { ...good, "parts/t1.json": "7" });
    expect(snapshotPool([missing, broken]).has("R")).toBe(false);
    const p = snapshotPool([missing, broken, ok, ok2]);
    expect(p.has("R")).toBe(true);
    expect(p.get("R")).toEqual({ table: 1, analysis: 2, figure: 3, scratchpad: null });
    expect(p.get("nope")).toBeNull();
    // A revision without content never counts, even when its parts happen to be there.
    expect(snapshotPool([fileOf([{ ...r1, sections: null }], good)]).has("R")).toBe(false);
    // An inherited property is not a part.
    const proto = fileOf([rev("P", [], { sections: refs("__proto__", "a1", "f1", "s1") })], good);
    expect(snapshotPool([proto]).has("P")).toBe(false);
  });
});
