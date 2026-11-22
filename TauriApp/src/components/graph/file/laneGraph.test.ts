import { describe, expect, it } from "vitest";
import type { LaneLayout, LaneNode } from "./contract";
import { layoutLanes } from "./laneGraph";
import { randomDag, rng } from "./fixtures-p2/kit";

const T0 = Date.UTC(2026, 10, 1, 9);
const node = (id: string, parents: string[], minutes: number, deviceId = "d-a", foreign = false): LaneNode =>
  ({ id, parents, time: new Date(T0 + minutes * 60_000).toISOString(), deviceId, ...(foreign ? { foreign } : {}) });

/** Every invariant of contract §3.6 that holds for any input. */
function checkInvariants(nodes: readonly LaneNode[], head: string | null, L: LaneLayout) {
  const ids = new Set(nodes.map((n) => n.id));
  expect(L.rows.length).toBe(ids.size);
  expect(new Set(L.rows.map((r) => r.id))).toEqual(ids);
  L.rows.forEach((r, i) => expect(r.row).toBe(i));
  const row = new Map(L.rows.map((r) => [r.id, r]));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // Children above parents; one edge per known (child, parent) pair; edges connect existing rows.
  let expectedEdges = 0;
  for (const n of byId.values()) for (const p of new Set(n.parents)) if (ids.has(p) && p !== n.id) {
    expectedEdges++;
    expect(row.get(p)!.row).toBeGreaterThan(row.get(n.id)!.row);
  }
  expect(L.edges.length).toBe(expectedEdges);
  for (const e of L.edges) {
    expect(row.get(e.from)!.row).toBe(e.fromRow);
    expect(row.get(e.to)!.row).toBe(e.toRow);
    expect(row.get(e.from)!.lane).toBe(e.fromLane);
    expect(row.get(e.to)!.lane).toBe(e.toLane);
    expect(e.dashed).toBe(byId.get(e.from)!.foreign === true);
    const hi = e.fromLane >= e.toLane ? e.from : e.to;
    expect(e.colorIndex).toBe(row.get(e.fromLane === e.toLane ? e.from : hi)!.colorIndex);
  }
  // Lane 0 = the head's first-parent chain (first known parent).
  const start = head !== null && ids.has(head) ? head : L.rows[0]?.id;
  const chain = new Set<string>();
  for (let cur: string | undefined = start; cur !== undefined && !chain.has(cur);) {
    chain.add(cur);
    cur = byId.get(cur)!.parents.find((p) => ids.has(p) && p !== cur);
  }
  for (const r of L.rows) expect(r.lane === 0).toBe(chain.has(r.id));
  // The edge guarantee: lane max(fromLane, toLane) holds no other row strictly between.
  for (const e of L.edges) {
    const lane = Math.max(e.fromLane, e.toLane);
    for (let i = e.fromRow + 1; i < e.toRow; i++) expect(L.rows[i].lane === lane ? `${e.from}→${e.to} passes ${L.rows[i].id}` : "").toBe("");
  }
  // Lanes don't overlap: two vertical runs in one lane over the same rows share an end.
  const runs = L.edges.map((e) => ({ lane: Math.max(e.fromLane, e.toLane), lo: e.fromRow, hi: e.toRow, from: e.from, to: e.to }));
  for (let i = 0; i < runs.length; i++) for (let j = i + 1; j < runs.length; j++) {
    const a = runs[i], b = runs[j];
    if (a.lane !== b.lane || a.from === b.from || a.to === b.to) continue;
    const overlap = Math.max(a.lo, b.lo) < Math.min(a.hi, b.hi);
    expect(overlap ? `${a.from}→${a.to} / ${b.from}→${b.to} in lane ${a.lane}` : "").toBe("");
  }
  // Colours.
  const devs: string[] = [];
  for (let i = L.rows.length - 1; i >= 0; i--) {
    const d = byId.get(L.rows[i].id)!.deviceId;
    if (d && !devs.includes(d)) devs.push(d);
  }
  expect(L.devices).toEqual(devs);
  for (const r of L.rows) {
    const d = byId.get(r.id)!.deviceId;
    expect(r.colorIndex).toBe(d ? devs.indexOf(d) : -1);
  }
  expect(L.laneCount).toBe(L.rows.length ? Math.max(...L.rows.map((r) => r.lane)) + 1 : 0);
}

const compact = (L: LaneLayout) => L.rows.map((r) => `${r.id}@${r.lane}`).join(" ");

describe("M18 lane graph", () => {
  it("empty", () => {
    expect(layoutLanes([], null)).toEqual({ rows: [], edges: [], laneCount: 0, devices: [] });
  });

  it("golden: linear history → one lane", () => {
    const nodes = [node("r1", [], 0), node("r2", ["r1"], 10), node("r3", ["r2"], 20, "d-b"), node("r4", ["r3"], 30)];
    const L = layoutLanes(nodes, "r4");
    checkInvariants(nodes, "r4", L);
    expect(compact(L)).toBe("r4@0 r3@0 r2@0 r1@0");
    expect(L.laneCount).toBe(1);
    expect(L.devices).toEqual(["d-a", "d-b"]);
    expect(L.rows.map((r) => r.colorIndex)).toEqual([0, 1, 0, 0]);
    expect(L.edges.map((e) => `${e.from}>${e.to}`)).toEqual(["r4>r3", "r3>r2", "r2>r1"]);
  });

  it("golden: fork and combine → two lanes joining at the combine", () => {
    // R by a; A1 by a; B1, B2 by b (another computer); M = combine (automatic, no device).
    const nodes = [
      node("R", [], 0), node("A1", ["R"], 10), node("B1", ["R"], 12, "d-b"), node("B2", ["B1"], 25, "d-b"),
      node("A2", ["A1"], 20), node("r-m-x", ["A2", "B2"], 30, ""),
    ];
    const L = layoutLanes(nodes, "r-m-x");
    checkInvariants(nodes, "r-m-x", L);
    expect(compact(L)).toBe("r-m-x@0 B2@1 A2@0 B1@1 A1@0 R@0");
    expect(L.laneCount).toBe(2);
    const toM = L.edges.filter((e) => e.from === "r-m-x");
    expect(toM.map((e) => `${e.to}:${e.toLane}`)).toEqual(["A2:0", "B2:1"]);
    expect(L.rows[0].colorIndex).toBe(-1);
    expect(L.devices).toEqual(["d-a", "d-b"]);
    // The edge into lane 1 takes the other computer's colour.
    expect(toM[1].colorIndex).toBe(1);
    expect(L.edges.find((e) => e.from === "B1")!.colorIndex).toBe(1);
  });

  it("golden: fork, combine and a foreign copy branch (dashed); lane 0 stays the file's line though the copy is newer", () => {
    const nodes = [
      node("R", [], 0), node("A1", ["R"], 10), node("B1", ["R"], 12, "d-b"), node("M", ["A1", "B1"], 20, ""),
      node("A2", ["M"], 30),
      // A copy in the folder, newer than this file's head, branching from M.
      node("C1", ["M"], 40, "d-c", true), node("C2", ["C1"], 50, "d-c", true),
    ];
    const L = layoutLanes(nodes, "A2");
    checkInvariants(nodes, "A2", L);
    expect(compact(L)).toBe("C2@1 C1@1 A2@0 M@0 B1@1 A1@0 R@0");
    expect(L.edges.filter((e) => e.dashed).map((e) => `${e.from}>${e.to}`)).toEqual(["C2>C1", "C1>M"]);
    expect(L.laneCount).toBe(2);
    expect(L.devices).toEqual(["d-a", "d-b", "d-c"]);
  });

  it("golden: three computers", () => {
    const nodes = [
      node("R", [], 0),
      node("A1", ["R"], 10), node("B1", ["R"], 11, "d-b"), node("C1", ["R"], 12, "d-c"),
      node("A2", ["A1"], 20), node("B2", ["B1"], 21, "d-b"), node("C2", ["C1"], 22, "d-c"),
      node("M1", ["A2", "B2"], 30, ""), node("M2", ["C2", "M1"], 40, ""),
      node("A3", ["M2"], 50),
    ];
    const L = layoutLanes(nodes, "A3");
    checkInvariants(nodes, "A3", L);
    expect(compact(L)).toBe("A3@0 M2@0 M1@1 C2@0 B2@2 A2@1 C1@0 B1@2 A1@1 R@0");
    expect(L.laneCount).toBe(3);
    expect(L.devices).toEqual(["d-a", "d-b", "d-c"]);
  });

  it("k branches alive at once → at most k lanes", () => {
    const r = rng(8);
    for (let k = 1; k <= 6; k++) {
      const nodes: LaneNode[] = [node("R", [], 0)];
      const tips: string[] = [];
      for (let b = 0; b < k; b++) tips.push("R");
      for (let step = 1; step <= 5; step++) for (const b of r.shuffle([...Array(k).keys()])) {
        const id = `b${b}-${step}`;
        nodes.push(node(id, [tips[b]], step * 10 + b, `d-${b}`));
        tips[b] = id;
      }
      const L = layoutLanes(nodes, tips[0]);
      checkInvariants(nodes, tips[0], L);
      expect(L.laneCount).toBeLessThanOrEqual(k);
      // Then combine them one after another into branch 0.
      let head = tips[0];
      for (let b = 1; b < k; b++) {
        const id = `m${b}`;
        nodes.push(node(id, [head, tips[b]].sort(), 100 + b, ""));
        head = id;
      }
      const L2 = layoutLanes(nodes, head);
      checkInvariants(nodes, head, L2);
      expect(L2.laneCount).toBeLessThanOrEqual(k);
    }
  });

  it("deterministic under shuffling; invariants on random histories (criss-cross, copies, skew)", () => {
    const r = rng(31337);
    for (let t = 0; t < 150; t++) {
      const revs = randomDag(r, 2 + r.int(60), { mergeP: 0.3, roots: 1 + r.int(2), skew: r.chance(0.3) ? 120 : 0 });
      const nodes: LaneNode[] = revs.map((x) => ({
        id: x.id, parents: x.parents, time: x.time, deviceId: r.chance(0.1) ? "" : x.device_id, ...(r.chance(0.15) ? { foreign: true } : {}),
      }));
      // A parent that is not in the list is ignored.
      if (r.chance(0.2)) nodes.push(node("orphan", ["missing-parent"], 5));
      const head = r.chance(0.2) ? null : r.chance(0.1) ? "unknown" : r.pick(nodes).id;
      const L = layoutLanes(nodes, head);
      checkInvariants(nodes, head, L);
      for (let k = 0; k < 3; k++) expect(layoutLanes(r.shuffle(nodes), head)).toEqual(L);
    }
  });

  it("parents missing from the list and repeated parents are ignored", () => {
    const nodes = [node("A", ["gone"], 0), node("B", ["A", "A"], 10)];
    const L = layoutLanes(nodes, "B");
    expect(L.edges.length).toBe(1);
    expect(compact(L)).toBe("B@0 A@0");
  });

  it("2,000 nodes lay out in under 200 ms", () => {
    const r = rng(2000);
    const revs = randomDag(r, 2000, { mergeP: 0.15, skew: 30 });
    const nodes: LaneNode[] = revs.map((x) => ({ id: x.id, parents: x.parents, time: x.time, deviceId: x.device_id }));
    layoutLanes(nodes.slice(0, 200), null);           // warm up
    const t0 = performance.now();
    const L = layoutLanes(nodes, revs[revs.length - 1].id);
    const ms = performance.now() - t0;
    expect(L.rows.length).toBe(2000);
    expect(ms).toBeLessThan(200);
  });

  it("realistic: two computers saving one file over a long time stay in two lanes", () => {
    // a and b take turns; now and then they diverge for a while and are combined.
    const nodes: LaneNode[] = [node("r0", [], 0)];
    let head = "r0", minute = 1, n = 0;
    const r = rng(99);
    for (let round = 0; round < 40; round++) {
      if (r.chance(0.6)) {
        const id = `s${n++}`;
        nodes.push(node(id, [head], minute++, r.pick(["d-a", "d-b"])));
        head = id;
      } else {
        let a = head, b = head;
        for (let i = 0; i < 1 + r.int(3); i++) { const id = `a${n++}`; nodes.push(node(id, [a], minute++, "d-a")); a = id; }
        for (let i = 0; i < 1 + r.int(3); i++) { const id = `b${n++}`; nodes.push(node(id, [b], minute++, "d-b")); b = id; }
        const id = `m${n++}`;
        nodes.push(node(id, [a, b].sort(), minute++, ""));
        head = id;
      }
    }
    const L = layoutLanes(nodes, head);
    checkInvariants(nodes, head, L);
    expect(L.laneCount).toBe(2);
  });
});
