/* The lane graph of the Versions panel (plan §9.5; phase 2 contract §3.6),
   like `git log --graph`: one row per version, newest first; lane 0 is the
   file's current version and its first-parent line; other lines get the
   lowest free lane; one colour per computer. Pure — the UI only draws.

   Drawing rule the UI follows (contract.ts LaneEdge): an edge between two
   lanes runs vertically in the higher of the two lanes, with a bend at the end
   that is in the other lane. The layout guarantees that for every edge the
   lane max(fromLane, toLane) holds no other row strictly between fromRow and
   toRow, and that no two lines share a lane over the same rows.

   How:
   1. Rows: newestFirst by time (children always above their parents).
   2. Lines: lane 0 is the head's first-parent chain. Walking rows top to
      bottom, a node not yet in a line starts one, and the line follows first
      parents while the parent has no line yet. A line other than lane 0 also
      ends at a combine (a version with two parents) and before a parent that
      has another child higher up than the line's node — so an edge arriving
      at a line from elsewhere never passes another node of that line, and an
      edge leaving a line never passes the line's own continuation.
   3. Lanes: lines in the order they were started each take the lowest lane
      ≥ 1 that is free over the rows the line spans plus the edges it would
      carry (edges to lines in lower lanes, and — not knowing yet — edges to
      lines not placed yet). Half-open edge ends let a line continue in the
      same lane right where another ends. */

import type { LaneEdge, LaneGraphApi, LaneLayout, LaneNode, LaneRow } from "./contract";
import { newestFirst } from "./revisions";

interface Span { lo: number; hi: number }   // doubled row coordinates, inclusive

export function layoutLanes(nodes: readonly LaneNode[], head: string | null): LaneLayout {
  // Unique nodes (first wins), parents restricted to known nodes, without repeats.
  const byId = new Map<string, LaneNode>();
  for (const n of nodes) if (n && typeof n.id === "string" && !byId.has(n.id)) byId.set(n.id, n);
  const known = new Map<string, LaneNode>();
  for (const n of byId.values()) {
    const ps: string[] = [];
    for (const p of Array.isArray(n.parents) ? n.parents : []) if (byId.has(p) && p !== n.id && !ps.includes(p)) ps.push(p);
    known.set(n.id, { ...n, parents: ps });
  }
  const list = [...known.values()];
  const order = newestFirst(list, (n) => Date.parse(n.time));
  const rowOf = new Map<string, number>();
  order.forEach((n, i) => rowOf.set(n.id, i));
  const children = new Map<string, string[]>();
  for (const n of order) for (const p of n.parents) {
    const c = children.get(p);
    if (c) c.push(n.id); else children.set(p, [n.id]);
  }

  // ── lines ──
  const lineOf = new Map<string, number>();
  const lines: string[][] = [];
  const start = head !== null && known.has(head) ? head : order[0]?.id;
  if (start !== undefined) {
    const chain: string[] = [];
    let cur: string | undefined = start;
    while (cur !== undefined && !lineOf.has(cur)) {
      lineOf.set(cur, 0);
      chain.push(cur);
      cur = known.get(cur)!.parents[0];
    }
    lines.push(chain);
  }
  for (const n of order) {
    if (lineOf.has(n.id)) continue;
    const id = lines.length;
    const line: string[] = [];
    let cur: string | undefined = n.id;
    while (cur !== undefined) {
      lineOf.set(cur, id);
      line.push(cur);
      const node: LaneNode = known.get(cur)!;
      if (node.parents.length >= 2) break;                    // a combine ends a line
      const p: string | undefined = node.parents[0];
      if (p === undefined || lineOf.has(p)) break;
      const r = rowOf.get(cur)!;
      if ((children.get(p) ?? []).some((c) => c !== cur && rowOf.get(c)! < r)) break;
      cur = p;
    }
    lines.push(line);
  }

  // ── lanes ──
  const laneOfLine: number[] = lines.map(() => -1);
  if (lines.length) laneOfLine[0] = 0;
  const taken = new Map<number, Span[]>();                     // lane → reserved spans
  const free = (lane: number, s: Span) => !(taken.get(lane) ?? []).some((t) => t.lo <= s.hi && s.lo <= t.hi);
  for (let li = 1; li < lines.length; li++) {
    const line = lines[li];
    const rows = line.map((id) => rowOf.get(id)!);
    const nodeSpan: Span = { lo: 2 * Math.min(...rows), hi: 2 * Math.max(...rows) };
    // Edges to other lines: [span, other line].
    const edges: [Span, number][] = [];
    for (const id of line) {
      const r = rowOf.get(id)!;
      for (const p of known.get(id)!.parents) {
        const o = lineOf.get(p)!;
        if (o !== li) edges.push([{ lo: 2 * r, hi: 2 * rowOf.get(p)! - 1 }, o]);
      }
      for (const c of children.get(id) ?? []) {
        const o = lineOf.get(c)!;
        if (o !== li) edges.push([{ lo: 2 * rowOf.get(c)! + 1, hi: 2 * r }, o]);
      }
    }
    for (let lane = 1; ; lane++) {
      let lo = nodeSpan.lo, hi = nodeSpan.hi;
      for (const [s, o] of edges) {
        const ol = laneOfLine[o];
        if (ol === -1 || ol < lane) { lo = Math.min(lo, s.lo); hi = Math.max(hi, s.hi); }
      }
      const span = { lo, hi };
      if (free(lane, span)) {
        laneOfLine[li] = lane;
        const t = taken.get(lane);
        if (t) t.push(span); else taken.set(lane, [span]);
        break;
      }
    }
  }

  // ── colours ──
  const devices: string[] = [];
  for (let i = order.length - 1; i >= 0; i--) {
    const d = order[i].deviceId;
    if (typeof d === "string" && d !== "" && !devices.includes(d)) devices.push(d);
  }
  const colorOf = (n: LaneNode) => (typeof n.deviceId === "string" && n.deviceId !== "" ? devices.indexOf(n.deviceId) : -1);

  // ── out ──
  const laneOf = (id: string) => laneOfLine[lineOf.get(id)!];
  const rows: LaneRow[] = order.map((n, row) => ({ id: n.id, row, lane: laneOf(n.id), colorIndex: colorOf(n) }));
  const edges: LaneEdge[] = [];
  for (const n of order) {
    for (const p of n.parents) {
      const fromLane = laneOf(n.id), toLane = laneOf(p);
      const pn = known.get(p)!;
      const colorIndex = fromLane === toLane ? colorOf(n) : fromLane > toLane ? colorOf(n) : colorOf(pn);
      edges.push({
        from: n.id, to: p, fromRow: rowOf.get(n.id)!, toRow: rowOf.get(p)!, fromLane, toLane,
        dashed: byId.get(n.id)!.foreign === true, colorIndex,
      });
    }
  }
  const laneCount = rows.reduce((m, r) => Math.max(m, r.lane + 1), 0);
  return { rows, edges, laneCount, devices };
}

({ layoutLanes }) satisfies LaneGraphApi;
