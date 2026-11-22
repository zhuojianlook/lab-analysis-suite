/* Generated documents for the combine tests: real Graphs content in file form,
   with ids from a counter (setIdSource) so runs are repeatable, and random
   edits per section. */

import type { Template } from "../../../../api/graph";
import { openContent } from "../../../../store/graphStore";
import { FIXTURES } from "../../__tests__/fixtures";
import { migrateDoc, sampleDoc, setIdSource } from "../../graphModel";
import type { SectionValues } from "../contract";
import { sectionsOf } from "../docCodec";
import type { SectionName } from "../format";
import type { Rng } from "./kit";

/** Make minted row / column ids predictable. Returns the restore function. */
export function countingIds(): () => void {
  let n = 0;
  const prev = setIdSource((kind) => `${kind}-t${(n++).toString(36).padStart(6, "0")}`);
  return () => { setIdSource(prev); };
}

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** A document's four sections in file form (a fresh object). */
export function sampleSections(t: Template): SectionValues {
  return clone(sectionsOf(openContent({ doc: sampleDoc(t) }))) as unknown as SectionValues;
}

export function fixtureSections(i: number): SectionValues {
  const f = FIXTURES[i];
  const c = openContent({ doc: migrateDoc(f.table)!, analysis: f.analysis as never, figure: f.figure as never, scratch: f.scratchpad });
  return clone(sectionsOf(c)) as unknown as SectionValues;
}

/** Every base document the property tests start from: the three templates and every fixture. */
export function allBases(): SectionValues[] {
  return [sampleSections("column"), sampleSections("grouped"), sampleSections("xy"), ...FIXTURES.map((_, i) => fixtureSections(i))];
}

type T = { cells: string[][][]; row_ids: string[]; col_ids: string[]; n_rep: number };
const COLORS = ["#112233", "#445566", "#778899", "#aa0000", "#00aa00", "#0000aa"];

/** One random change to one section (in place). Table edits never touch the last row,
 *  so the load pipeline never has to add a row (which would mint a new id). */
export function editSection(r: Rng, s: SectionValues, k: SectionName): void {
  if (k === "table") {
    const t = s.table as T;
    const rows = Math.max(1, t.cells.length - 1);
    const row = r.int(rows), col = r.int(t.col_ids.length), rep = r.int(Math.max(1, t.n_rep));
    t.cells[row][col][rep] = String(Math.round(r.next() * 10000) / 100);
  } else if (k === "figure") {
    const f = s.figure as { title: string; point_size: number; series: Record<string, { color: string }> };
    const what = r.int(3);
    if (what === 0) f.title = `Title ${r.int(1e6)}`;
    else if (what === 1) f.point_size = 1 + r.int(9);
    else {
      const ids = Object.keys(f.series);
      if (ids.length) f.series[r.pick(ids)].color = r.pick(COLORS);
      else f.title = `Title ${r.int(1e6)}`;
    }
  } else if (k === "analysis") {
    const a = s.analysis as { alpha: number; family: string };
    a.alpha = r.pick([0.001, 0.01, 0.1, 0.2].filter((x) => x !== a.alpha));
  } else {
    s.scratchpad = { v: 1, cells: [[1 + r.int(5), 1 + r.int(5), String(r.int(100000))]] };
  }
}
