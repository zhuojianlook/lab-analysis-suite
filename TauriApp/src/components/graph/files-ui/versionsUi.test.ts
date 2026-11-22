import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LaneNode, VersionRow } from "../file/contract";
import { layoutLanes } from "../file/laneGraph";
import { AUTO_COLOR, DEVICE_COLORS, LaneGraph, ROW_HEIGHT, deviceColor, edgePath, graphWidth } from "./LaneGraph";
import { rowMeta, rowTimes } from "./VersionsPanel";

const T0 = Date.UTC(2026, 10, 1, 9);
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const node = (id: string, parents: string[], min: number, deviceId: string, foreign = false): LaneNode =>
  ({ id, parents, time: at(min), deviceId, ...(foreign ? { foreign } : {}) });

/** Three computers: A and B work apart and are combined automatically; C works apart and is combined by hand;
 *  an extra copy has a version of its own (foreign, dashed). */
const nodes: LaneNode[] = [
  node("r-01", [], 0, "dev-a"),
  node("r-02", ["r-01"], 10, "dev-a"),
  node("r-03", ["r-01"], 12, "dev-b"),
  node("r-m-1", ["r-02", "r-03"], 12, ""),
  node("r-04", ["r-m-1"], 20, "dev-c"),
  node("r-05", ["r-m-1"], 21, "dev-a"),
  node("r-m-2", ["r-04", "r-05"], 30, "dev-a"),
  node("r-06", ["r-m-2"], 40, "dev-b", true),
];

describe("LaneGraph (the Versions tree)", () => {
  const layout = layoutLanes(nodes, "r-m-2");
  const stubs = [{ from: "r-02", name: "Dose response (earlier version)", path: "/x/Dose response (earlier version).lag" }];
  const html = renderToStaticMarkup(createElement(LaneGraph, { layout, stubs, selectedId: "r-04", faded: new Set(["r-01"]), currentId: "r-m-2" }));

  it("draws one dot per version, in its lane, coloured by computer", () => {
    const dots = [...html.matchAll(/<circle data-testid="lane-dot" data-id="([^"]+)" data-lane="(\d+)" data-color="(-?\d+)"[^>]*fill="([^"]+)"/g)];
    expect(dots.map((d) => d[1]).sort()).toEqual(nodes.map((n) => n.id).sort());
    for (const d of dots) {
      const r = layout.rows.find((x) => x.id === d[1])!;
      expect(Number(d[2])).toBe(r.lane);
      expect(d[4]).toBe(deviceColor(r.colorIndex));
    }
    // Three computers → three different colours; the automatic combine is grey.
    expect(layout.devices).toEqual(["dev-a", "dev-b", "dev-c"]);
    const colourOf = (id: string) => dots.find((d) => d[1] === id)![4];
    expect(new Set([colourOf("r-02"), colourOf("r-03"), colourOf("r-04")]).size).toBe(3);
    expect(colourOf("r-m-1")).toBe(AUTO_COLOR);
  });

  it("draws one line per parent, dashed for a copy's own version, and lanes that join at a combine", () => {
    const edges = [...html.matchAll(/<path data-testid="lane-edge" data-from="([^"]+)" data-to="([^"]+)" data-dashed="(true|false)"/g)];
    expect(edges.length).toBe(layout.edges.length);
    expect(edges.length).toBe(nodes.reduce((n, x) => n + x.parents.length, 0));
    expect(edges.filter((e) => e[3] === "true").map((e) => e[1])).toEqual(["r-06"]);
    expect(edges.filter((e) => e[1] === "r-m-1").length).toBe(2);
    expect(layout.laneCount).toBeGreaterThanOrEqual(2);
    expect(html).toContain('data-testid="lane-stub" data-from="r-02"');
    expect(graphWidth(layout, stubs)).toBeGreaterThan(graphWidth(layout, []));
  });

  it("bends in the lower lane and runs straight in the higher one", () => {
    // Child in lane 1, parent in lane 0: straight down x of lane 1, bend at the end.
    const d = edgePath(0, 1, 3, 0);
    const xs = [...d.matchAll(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(xs[0][0]).toBe(xs[1][0]); // vertical first
    expect(xs[1][1]).toBeGreaterThan(2 * ROW_HEIGHT); // until just above the parent's row
    expect(edgePath(0, 0, 2, 0)).toMatch(/^M\S+ \S+L\S+ \S+$/);
  });

  it("has a fixed palette of 8 that wraps", () => {
    expect(DEVICE_COLORS.length).toBe(8);
    expect(deviceColor(9)).toBe(DEVICE_COLORS[1]);
    expect(deviceColor(-1)).toBe(AUTO_COLOR);
  });
});

describe("row texts", () => {
  const settings = { userName: "Me", deviceName: "This Mac" };
  const row = (id: string, who: VersionRow["who"], chips: VersionRow["chips"] = []): VersionRow => ({
    id, kind: id === "working" ? "working" : "save", summary: "Changed the table", who, chips, openable: true, foreign: false,
    copyName: null, copyPath: null, restoredFrom: null,
  });
  it("gives an automatic combine the later time of the versions it joins", () => {
    const layout = layoutLanes(nodes.slice(0, 4), "r-m-1");
    const rows = layout.rows.map((r) => {
      const n = nodes.find((x) => x.id === r.id)!;
      return row(r.id, n.deviceId ? { head: r.id, userName: "A", deviceName: "B", time: n.time, mine: false } : null);
    });
    expect(rowTimes(rows, layout).get("r-m-1")).toBe(at(12));
  });
  it("words line 2", () => {
    expect(rowMeta(row("r-1", { head: "r-1", userName: "Me", deviceName: "This Mac", time: at(0), mine: true }), "2 h ago", settings)).toBe("you · This Mac · 2 h ago");
    expect(rowMeta(row("r-1", { head: "r-1", userName: "Alice", deviceName: "Office iMac", time: at(0), mine: false }), "yesterday", settings)).toBe("Alice · Office iMac · yesterday");
    expect(rowMeta(row("r-1", null), "2 h ago", settings)).toBe("Combined automatically · 2 h ago");
    expect(rowMeta(row("working", null, ["unsaved"]), "", settings)).toBe("you · This Mac · now");
  });
});
