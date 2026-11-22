/* The tree of versions beside the Versions list (phase 2 contract §6.1), drawn
   from the controller's lane layout like `git log --graph`: one dot per
   version, lines to its parents, one colour per computer, dashed lines for
   versions that are only in an extra copy, and short dashed stubs where a
   separate analysis was made. Pure drawing: the layout is worked out in
   file/laneGraph.ts. */

import { memo } from "react";
import type { LaneLayout, VersionStub } from "../file/contract";

export const ROW_HEIGHT = 44;
export const LANE_WIDTH = 16;
/** Left / right padding of the graph column. */
export const GRAPH_PAD = 10;

/** Eight computer colours (wrapping); grey for versions combined automatically. */
export const DEVICE_COLORS = ["#4f9cf9", "#f0883e", "#3fb950", "#db61a2", "#a371f7", "#d29922", "#39c5cf", "#f85149"] as const;
export const AUTO_COLOR = "#8b8d94";
export const deviceColor = (i: number) => (i < 0 ? AUTO_COLOR : DEVICE_COLORS[i % DEVICE_COLORS.length]);

/** Width of the graph column for a layout (with room for stubs when there are any). */
export function graphWidth(layout: LaneLayout, stubs: readonly VersionStub[] = []): number {
  const lanes = Math.max(1, layout.laneCount) + (stubs.length ? 1 : 0);
  return GRAPH_PAD * 2 + (lanes - 1) * LANE_WIDTH + 6;
}

const laneX = (lane: number) => GRAPH_PAD + 3 + lane * LANE_WIDTH;
const rowY = (row: number) => row * ROW_HEIGHT + ROW_HEIGHT / 2;

/** A line from a child (higher) to a parent. Same lane: straight. Otherwise vertical in the higher lane,
 *  with the bend at the end that is in the other lane (the contract's guarantee keeps that lane free). */
export function edgePath(fromRow: number, fromLane: number, toRow: number, toLane: number): string {
  const x1 = laneX(fromLane), y1 = rowY(fromRow), x2 = laneX(toLane), y2 = rowY(toRow);
  if (fromLane === toLane) return `M${x1} ${y1}L${x2} ${y2}`;
  const bend = Math.min(ROW_HEIGHT * 0.7, (y2 - y1) / 2);
  if (fromLane > toLane) {
    // The child's lane runs down; bend into the parent's lane just above it.
    return `M${x1} ${y1}L${x1} ${y2 - bend}C${x1} ${y2 - bend / 3} ${x2} ${y2 - bend * 0.6} ${x2} ${y2}`;
  }
  // The parent's lane is the higher one: bend out of the child's row, then run down.
  return `M${x1} ${y1}C${x1} ${y1 + bend * 0.6} ${x2} ${y1 + bend / 3} ${x2} ${y1 + bend}L${x2} ${y2}`;
}

export const LaneGraph = memo(function LaneGraph({ layout, stubs, selectedId, faded, currentId }: {
  layout: LaneLayout;
  stubs: readonly VersionStub[];
  selectedId: string | null;
  /** Rows drawn lighter (versions that can no longer be opened). */
  faded: ReadonlySet<string>;
  currentId: string | null;
}) {
  const width = graphWidth(layout, stubs);
  const height = Math.max(ROW_HEIGHT, layout.rows.length * ROW_HEIGHT);
  const byId = new Map(layout.rows.map((r) => [r.id, r] as const));
  const stubLane = Math.max(1, layout.laneCount);
  return (
    <svg data-testid="versions-graph" width={width} height={height} viewBox={`0 0 ${width} ${height}`}
      style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none", overflow: "visible" }} aria-hidden="true">
      {layout.edges.map((e) => (
        <path key={`${e.from}>${e.to}`} data-testid="lane-edge" data-from={e.from} data-to={e.to} data-dashed={e.dashed ? "true" : "false"}
          d={edgePath(e.fromRow, e.fromLane, e.toRow, e.toLane)} fill="none" stroke={deviceColor(e.colorIndex)} strokeWidth={2}
          strokeLinecap="round" strokeDasharray={e.dashed ? "4 3" : undefined} opacity={faded.has(e.from) && faded.has(e.to) ? 0.45 : 0.9} />
      ))}
      {stubs.map((s) => {
        const r = byId.get(s.from);
        if (!r) return null;
        const x1 = laneX(r.lane), y1 = rowY(r.row), x2 = laneX(stubLane), y2 = y1 + ROW_HEIGHT * 0.42;
        return (
          <g key={s.path} data-testid="lane-stub" data-from={s.from} data-name={s.name}>
            <path d={`M${x1} ${y1}C${x1 + 6} ${y1 + 8} ${x2 - 4} ${y2 - 10} ${x2} ${y2 - 2}`} fill="none" stroke={AUTO_COLOR}
              strokeWidth={1.5} strokeDasharray="3 3" />
            <circle cx={x2} cy={y2 + 1} r={3} fill="none" stroke={AUTO_COLOR} strokeWidth={1.5} />
          </g>
        );
      })}
      {layout.rows.map((r) => {
        const x = laneX(r.lane), y = rowY(r.row), c = deviceColor(r.colorIndex);
        const working = r.id === "working";
        const sel = r.id === selectedId;
        return (
          <g key={r.id}>
            {sel && <circle cx={x} cy={y} r={9} fill="none" stroke={c} strokeOpacity={0.5} strokeWidth={2} />}
            <circle data-testid="lane-dot" data-id={r.id} data-lane={r.lane} data-color={r.colorIndex}
              cx={x} cy={y} r={r.id === currentId ? 6 : 5}
              fill={working ? "transparent" : c} stroke={working ? c : r.id === currentId ? "#fff" : "none"}
              strokeWidth={working ? 2 : 1.5} strokeDasharray={working ? "2 2" : undefined}
              opacity={faded.has(r.id) ? 0.45 : 1} />
          </g>
        );
      })}
    </svg>
  );
});
