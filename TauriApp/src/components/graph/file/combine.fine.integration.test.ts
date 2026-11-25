/* Phase 4 integration (contract §3.1, §2.7, checklist G1 / G8 / T3 / T7 on the whole composition): the three
   real modules behind combineFine, fed with documents edited the way the editor edits them (structural edits
   with the settings following, rows padded with fresh blank rows, ids minted per computer). For every
   generated pair: both computers (sides and SideKeys swapped) see the same conflict ids and the same
   autoApplicable, and get the same bytes, the same combined-version id and the same automatic revision; the
   result is already in stored form; combining it again with either side changes nothing; no conflict-free
   edit is lost. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openContent, type DocContent } from "../../../store/graphStore";
import { canonScratch, parseScratch } from "../scratchpad/scratchModel";
import {
  deleteCol, deleteRow, ensureRows, insertCol, insertRow, remapAnalysis, remapFigure, sampleDoc, setIdSource, setNRep,
} from "../graphModel";
import type { CombineChoices, CombinePlanP4, FineChoice, SectionValues, SideKey } from "./contract";
import { contentOfSections, makeRevision, mergeRevisionId, partsOf, sectionsOf, type Author } from "./docCodec";
import { canonicalJson, type Revision } from "./format";
import type { Template } from "../../../api/graph";
import { applyFineChoices, combine, combineFine, combineRevision, normaliseSections } from "./graphMerge";
import { clone } from "./fixtures-p2/docs";
import { rng } from "./fixtures-p2/kit";

type Rng = ReturnType<typeof rng>;
const CASES = Number((globalThis as { process?: { env?: Record<string, string> } }).process?.env?.P4_INT_CASES ?? 300);
const SEED = Number((globalThis as { process?: { env?: Record<string, string> } }).process?.env?.P4_INT_SEED ?? 4242);

let prefix = "b";
const counters: Record<string, number> = {};
let restore: (kind: "row" | "col") => string;
beforeAll(() => {
  restore = setIdSource((kind) => {
    const k = `${kind}-${prefix}`;
    counters[k] = (counters[k] ?? 0) + 1;
    return `${k}${counters[k].toString(36).padStart(5, "0")}`;
  });
});
afterAll(() => { setIdSource(restore); });

const author: Author = { user_name: "Alice", device_id: "d-alice", device_name: "Office iMac", session_id: "s-9", app_version: "0.2.26", platform: "macos" };
const KX: SideKey = { deviceId: "d-1111", revisionId: "r-01JX" };
const KY: SideKey = { deviceId: "d-2222", revisionId: "r-01JY" };

/** As the editor stores a document. */
const stored = (c: DocContent): DocContent => openContent({ doc: ensureRows(c.doc), analysis: c.analysis, figure: c.figure, scratch: c.scratch });
async function toSections(c: DocContent): Promise<SectionValues> {
  const n = await normaliseSections(sectionsOf(stored(c)) as unknown as SectionValues);
  if (!n) throw new Error("not a document");
  return clone(n.sections) as unknown as SectionValues;
}
const open = (s: SectionValues): DocContent => contentOfSections(clone(s) as unknown as Record<string, unknown>)!;

const word = (r: Rng) => r.pick(["1", "2.5", "3", "10", "x", "", "7", "42", "0.1"]);

/** One editor-like edit. */
function edit(r: Rng, c: DocContent): DocContent {
  const d = c.doc;
  const nRows = d.cells.length, nCols = d.col_titles.length;
  const op = r.int(14);
  const cells = () => d.cells.map((row) => row.map((reps) => [...reps]));
  switch (op) {
    case 0: case 1: case 2: case 3: {                   // a value (also in the blank rows at the end)
      const cs = cells();
      cs[r.int(nRows)][r.int(nCols)][r.int(d.n_rep)] = word(r);
      return { ...c, doc: { ...d, cells: cs } };
    }
    case 4: {                                           // a row inserted with values
      const at = r.int(nRows);
      const doc = insertRow(d, at);
      const cs = doc.cells.map((row, i) => (i === at ? row.map((reps) => reps.map((v, k) => (k === 0 ? word(r) || "5" : v))) : row));
      const x = doc.template === "xy" ? doc.x.map((v, i) => (i === at ? String(r.int(50)) : v)) : doc.x;
      return { ...c, doc: { ...doc, cells: cs, x }, analysis: remapAnalysis(c.analysis, d.template, "row", { type: "insert", at }) };
    }
    case 5: {                                           // a row deleted
      if (nRows < 2) return c;
      const at = r.int(nRows);
      return { ...c, doc: deleteRow(d, at), analysis: remapAnalysis(c.analysis, d.template, "row", { type: "delete", at }) };
    }
    case 6: {                                           // a column inserted
      if (nCols >= 8) return c;
      const at = r.int(nCols + 1);
      const op2 = { type: "insert" as const, at };
      return { ...c, doc: insertCol(d, at), analysis: remapAnalysis(c.analysis, d.template, "col", op2), figure: remapFigure(c.figure, op2) };
    }
    case 7: {                                           // a column deleted
      if (nCols < 2) return c;
      const at = r.int(nCols);
      const op2 = { type: "delete" as const, at };
      return { ...c, doc: deleteCol(d, at), analysis: remapAnalysis(c.analysis, d.template, "col", op2), figure: remapFigure(c.figure, op2) };
    }
    case 8: {                                           // a column / row title
      if (r.chance(0.5)) { const t = [...d.col_titles]; t[r.int(nCols)] = `C${r.int(99)}`; return { ...c, doc: { ...d, col_titles: t } }; }
      const t = [...d.row_titles]; t[r.int(nRows)] = `R${r.int(99)}`; return { ...c, doc: { ...d, row_titles: t } };
    }
    case 9:                                             // replicates
      return d.template === "column" ? c : { ...c, doc: setNRep(d, Math.max(1, Math.min(4, d.n_rep + (r.chance(0.5) ? 1 : -1)))) };
    case 10: {                                          // graph settings
      const w = r.int(5);
      if (w === 0) return { ...c, figure: { ...c.figure, title: `T${r.int(999)}` } };
      if (w === 1) return { ...c, figure: { ...c.figure, y_min: r.pick([0, 1, null]), y_max: r.pick([100, 50, null]) } as never };
      if (w === 2) return { ...c, figure: { ...c.figure, width: r.pick([5, 6, 8]) } as never };
      if (w === 3) { const colors = [...c.figure.colors]; if (colors.length) colors[r.int(colors.length)] = r.pick(["#ff0000", "#00ff00", "#0000ff"]); return { ...c, figure: { ...c.figure, colors } }; }
      const labels = [...c.figure.labels]; if (labels.length) labels[r.int(labels.length)] = `L${r.int(9)}`; return { ...c, figure: { ...c.figure, labels } };
    }
    case 11:                                            // analysis settings
      return { ...c, analysis: { ...c.analysis, alpha: r.pick([0.05, 0.01, 0.1]) } };
    case 12: {                                          // scratchpad cells
      const doc = parseScratch(c.scratch ?? "");
      const by = new Map(doc.cells.map((x) => [`${x[0]}:${x[1]}`, x] as const));
      for (let i = 0; i < 1 + r.int(3); i++) { const rr = 1 + r.int(6), cc = 1 + r.int(4); by.set(`${rr}:${cc}`, [rr, cc, r.pick(["1", "2", "=A1*2", "hello", "=SUM(A1:A3)"])]); }
      return { ...c, scratch: canonScratch({ ...doc, cells: [...by.values()] }) };
    }
    default: {                                          // scratchpad: a row inserted at the top
      const doc = parseScratch(c.scratch ?? "");
      return { ...c, scratch: canonScratch({ ...doc, cells: doc.cells.map((x) => { const y = [...x] as typeof x; y[0] = x[0] + 1; return y; }) }) };
    }
  }
}

async function side(r: Rng, b: SectionValues, who: string, n: number): Promise<SectionValues> {
  prefix = who;
  let c = open(b);
  for (let i = 0; i < n; i++) c = stored(edit(r, c));
  prefix = "b";
  return toSections(c);
}

async function plan(base: SectionValues, mine: SectionValues, theirs: SectionValues, km: SideKey, kt: SideKey): Promise<CombinePlanP4> {
  const p = await combineFine({ base, baseKind: "lca", mine, theirs, mineKey: km, theirsKey: kt });
  if (!p.ok) throw new Error("unreadable");
  return p;
}
const ids = (p: CombinePlanP4) => p.sections.flatMap((s) => s.conflicts.map((c) => c.id)).sort();
const all = (p: CombinePlanP4, pick: (c: { id: string; options: readonly FineChoice[] }, i: number) => FineChoice): CombineChoices =>
  ({ fine: Object.fromEntries(p.sections.flatMap((s) => s.conflicts.map((c, i) => [c.id, pick(c, i)]))) });
const swap = (v: FineChoice): FineChoice => (v === "mine" ? "theirs" : v === "theirs" ? "mine" : v);

async function rev(id: string, s: SectionValues, k: SideKey): Promise<Revision> {
  const parts = await partsOf((await normaliseSections(s))!.sections);
  return { ...makeRevision({ id, parents: ["r-base"], kind: "save", time: 1, author: { ...author, device_id: k.deviceId }, summary: "", parts }), combine_v: 1 } as Revision;
}

interface T0 { template: string; n_rep: number; row_ids: string[]; col_ids: string[]; cells: string[][][]; row_titles: string[]; x: string[] }
function tableLossCheck(b: SectionValues, x: SectionValues, y: SectionValues, res: SectionValues, where: string, asked?: ReadonlySet<string>): void {
  const [tb, tx, ty, tr] = [b, x, y, res].map((v) => (v as unknown as { table: T0 }).table);
  // CHANGED BY fixer round 3 (the safety net): a row asked about that the result has exactly as one side has it was
  // a choice of the whole row (one side rewrote its label and every value: maybe another entry).
  const rowOf = (t: T0, rid: string) => { const i = t.row_ids.indexOf(rid); return i < 0 ? null : JSON.stringify([t.row_titles[i], t.x[i], t.cells[i].map((reps) => reps.slice(0, t.n_rep))]); };
  const chosenWhole = (rid: string) => !!asked?.has(rid) && (rowOf(tr, rid) === rowOf(tx, rid) || rowOf(tr, rid) === rowOf(ty, rid));
  if (new Set([tb.template, tx.template, ty.template]).size > 1) return;
  const cell = (t: T0, rid: string, cid: string, k: number) => {
    const r = t.row_ids.indexOf(rid), c = t.col_ids.indexOf(cid);
    return k >= t.n_rep ? "" : t.cells[r]?.[c]?.[k] ?? "";
  };
  const K = Math.max(tx.n_rep, ty.n_rep);
  tb.row_ids.forEach((rid, bi) => {
    const data = (tb.row_titles[bi] ?? "").trim() || (tb.x[bi] ?? "").trim() || tb.cells[bi].some((reps) => reps.some((v) => v.trim()));
    if (!data || ![tx, ty, tr].every((t) => t.row_ids.includes(rid)) || chosenWhole(rid)) return;
    for (const cid of tb.col_ids) {
      if (![tx, ty, tr].every((t) => t.col_ids.includes(cid))) continue;
      for (let k = 0; k < K; k++) {
        const bv = cell(tb, rid, cid, k), xv = cell(tx, rid, cid, k), yv = cell(ty, rid, cid, k);
        const want = xv === yv ? xv : xv === bv ? yv : yv === bv ? xv : null;
        if (want !== null) expect(cell(tr, rid, cid, k), `${where}: cell ${rid}/${cid}/${k} lost`).toBe(want);
      }
    }
  });
}

describe("combineFine with the real modules, editor-like edits", () => {
  it(`${CASES} generated pairs: same result on both computers and as the older rules where those combine, stored form, re-combining changes nothing`, async () => {
    const r = rng(SEED);
    const stats = { auto: 0, conflicts: 0, adjusted: 0, order: 0, whole: 0 };
    for (let i = 0; i < CASES; i++) {
      const t: Template = r.pick(["column", "grouped", "xy"]);
      prefix = "b";
      const base = await toSections(openContent({ doc: sampleDoc(t) }));
      const x = await side(r, base, `x${i.toString(36)}`, 1 + r.int(4));
      const y = await side(r, base, `y${i.toString(36)}`, 1 + r.int(4));
      const where = `case ${i} (${t})`;
      const p1 = await plan(base, x, y, KX, KY);
      const p2 = await plan(base, y, x, KY, KX);
      expect(ids(p2), where).toEqual(ids(p1));
      expect(p2.autoApplicable, where).toBe(p1.autoApplicable);
      expect(p2.level, where).toBe(p1.level);
      if (p1.sections.some((s) => s.level === "whole" && s.conflicts.some((c) => c.kind === "section"))) stats.whole++;
      // An older app (section-level rules) never writes something different by itself (§3.3): it combines by
      // itself only when no part changed on both sides, and then this build gives the same bytes.
      const old = await combine({ base, baseKind: "lca", mine: x, theirs: y } as never);
      if (old.ok && old.autoApplicable) {
        expect(p1.level, where).toBe("section");
        expect(p1.result!.parts.contentHash, where).toBe(old.result!.parts.contentHash);
      }
      if (p1.level === "section" && old.ok) {
        expect(old.autoApplicable || !p1.autoApplicable, `${where}: automatic only here`).toBe(true);
        if (old.result) expect(p1.result!.parts.contentHash, where).toBe(old.result.parts.contentHash);
      }
      if (!p1.needsChoice) {
        expect(p1.result && p2.result, where).toBeTruthy();
        expect(p2.result!.parts.contentHash, where).toBe(p1.result!.parts.contentHash);
        // The result is in stored form: the pipeline gives it back unchanged.
        const again = await normaliseSections(clone(p1.result!.sections) as unknown as SectionValues);
        expect(again!.parts.contentHash, where).toBe(p1.result!.parts.contentHash);
        // The same automatic revision object from both computers.
        const [rx, ry] = [await rev("r-01JX", x, KX), await rev("r-01JY", y, KY)];
        const a1 = await combineRevision({ mine: rx, theirs: ry, result: p1.result!, auto: true, time: 5, author } as never);
        const a2 = await combineRevision({ mine: ry, theirs: rx, result: p2.result!, auto: true, time: 5, author } as never);
        expect(canonicalJson(a2), where).toBe(canonicalJson(a1));
        expect(a1.id).toBe(await mergeRevisionId(["r-01JX", "r-01JY"], p1.result!.parts.contentHash));
        if (p1.autoApplicable) stats.auto++;
        if (p1.result!.adjustments.length) stats.adjusted++;
        if (p1.result!.orderChecks.some((o) => o.matters)) stats.order++;
        // Fixer (finding M3): no conflict-free table edit is lost — in every row with data in the common version
        // that both sides and the result have, each cell is the three-way value.
        tableLossCheck(base, x, y, p1.result!.sections as unknown as SectionValues, where);
        // Re-combining the result with either side (that side as the base) changes nothing (G8 / T7).
        const res = clone(p1.result!.sections) as unknown as SectionValues;
        for (const [b2, other] of [[x, x], [y, y]] as const) {
          const q = await plan(b2, res, other, KX, KY);
          expect(q.needsChoice, `${where}: re-combine asks ${ids(q).join(",")}`).toBe(false);
          expect(q.result!.parts.contentHash, `${where}: re-combine changed it`).toBe(p1.result!.parts.contentHash);
        }
      } else {
        stats.conflicts++;
        expect(p1.result, where).toBeNull();
        // Every choice swapped on the other computer gives the same bytes; all-mine and all-theirs both give a result.
        const c1 = all(p1, (c, k) => c.options[(i + k) % c.options.length]);
        const c2: CombineChoices = { fine: Object.fromEntries(Object.entries(c1.fine!).map(([k, v]) => [k, swap(v)])) };
        const r1 = await applyFineChoices(p1, c1);
        const r2 = await applyFineChoices(p2, c2);
        expect(r1 && r2, `${where}: no result with every conflict chosen`).toBeTruthy();
        expect(r2!.parts.contentHash, where).toBe(r1!.parts.contentHash);
        for (const sidePick of ["mine", "theirs"] as const) {
          const rr = await applyFineChoices(p1, all(p1, () => sidePick));
          expect(rr, `${where}: all ${sidePick}`).toBeTruthy();
        }
      }
    }
    // The generator reaches every kind of outcome.
    expect(stats.auto).toBeGreaterThan(CASES / 10);
    expect(stats.conflicts).toBeGreaterThan(CASES / 10);
    expect(stats.adjusted + stats.order).toBeGreaterThan(0);
    console.log(`integration fuzz: ${JSON.stringify(stats)}`);
  }, 300_000);
});

// ── fixer round 2 (finding RV-1): both type into the same blank row, then one keeps typing ─────────────────

const SPLIT_CASES = Number((globalThis as { process?: { env?: Record<string, string> } }).process?.env?.P4_SPLIT_CASES ?? 250);
const SPLIT_SEED = Number((globalThis as { process?: { env?: Record<string, string> } }).process?.env?.P4_SPLIT_SEED ?? 977);

type Tab = { template: string; n_rep: number; row_ids: string[]; col_ids: string[]; cells: string[][][]; row_titles: string[]; x: string[] };
const tab = (s: SectionValues) => (s as unknown as { table: Tab }).table;
/** A row's title, X and values (every column, every replicate), or null when the table lacks it. */
function rowText(s: SectionValues, id: string): string | null {
  const t = tab(s);
  const i = t.row_ids.indexOf(id);
  if (i < 0) return null;
  return JSON.stringify([t.row_titles[i] ?? "", t.template === "xy" ? t.x[i] ?? "" : "", t.cells[i].map((reps) => reps.slice(0, t.n_rep))]);
}
const valueAt = (s: SectionValues, id: string, c: number, k: number) => {
  const t = tab(s);
  const i = t.row_ids.indexOf(id);
  return i < 0 || k >= t.n_rep ? null : t.cells[i]?.[c]?.[k] ?? "";
};

/** Values for the stories: from a few words (two entries can then read alike, by chance), or never seen before. */
let fresh = 0;
const valueFor = (r: Rng, coincide: boolean) => (coincide ? r.pick(["1", "2.5", "3", "10", "7", "42", "0.1", "8", "9.9"]) : `${++fresh}.25`);

/** Type into the row `id`: a label (grouped title / XY value) and some values. */
function typeInto(r: Rng, c: DocContent, id: string, nValues: number, label: boolean, coincide: boolean): DocContent {
  const d = c.doc;
  const i = d.row_ids!.indexOf(id);
  if (i < 0) return c;
  const cells = d.cells.map((row) => row.map((reps) => [...reps]));
  for (let n = 0; n < nValues; n++) cells[i][r.int(d.col_titles.length)][r.int(d.n_rep)] = valueFor(r, coincide);
  const row_titles = [...d.row_titles], x = [...d.x];
  if (label && d.template === "grouped") row_titles[i] = coincide ? `Mouse ${r.int(20)}` : `Mouse ${++fresh}`;
  if (label && d.template === "xy") x[i] = coincide ? String(100 + r.int(50)) : String(1000 + ++fresh);
  return stored({ ...c, doc: { ...d, cells, row_titles, x } });
}
/** A few values typed anywhere (rows with data or not), no structural change. */
function valuesAnywhere(r: Rng, c: DocContent, n: number, coincide: boolean): DocContent {
  const d = c.doc;
  const cells = d.cells.map((row) => row.map((reps) => [...reps]));
  for (let k = 0; k < n; k++) cells[r.int(cells.length)][r.int(d.col_titles.length)][r.int(d.n_rep)] = valueFor(r, coincide);
  return stored({ ...c, doc: { ...d, cells } });
}

/** The checks of the main property on one combine (both computers, older rules, stored form, re-combining). Returns
 *  the result with choices (all the first option when something is to choose). */
async function checkPair(base: SectionValues, p: SectionValues, q: SectionValues, where: string, pick: "mine" | "theirs", strict = true): Promise<SectionValues> {
  const p1 = await plan(base, p, q, KX, KY);
  const p2 = await plan(base, q, p, KY, KX);
  expect(ids(p2), where).toEqual(ids(p1));
  expect(p2.autoApplicable, where).toBe(p1.autoApplicable);
  const old = await combine({ base, baseKind: "lca", mine: p, theirs: q } as never);
  if (old.ok && old.autoApplicable) expect(p1.result!.parts.contentHash, `${where}: older rules`).toBe(old.result!.parts.contentHash);
  if (!p1.needsChoice) {
    expect(p2.result!.parts.contentHash, where).toBe(p1.result!.parts.contentHash);
    const again = await normaliseSections(clone(p1.result!.sections) as unknown as SectionValues);
    expect(again!.parts.contentHash, `${where}: stored form`).toBe(p1.result!.parts.contentHash);
    const res = clone(p1.result!.sections) as unknown as SectionValues;
    // With entries that may read alike by chance only the form the session uses (that side as the base) is checked.
    const sets = strict ? [[p, res, p], [q, res, q], [base, res, p], [base, p, res], [base, res, q], [base, q, res]] as const : [[p, res, p], [q, res, q]] as const;
    for (const [b2, x2, y2] of sets) {
      const again2 = await plan(b2, x2, y2, KX, KY);
      expect(again2.needsChoice, `${where}: re-combine asks ${ids(again2).join(",")}`).toBe(false);
      expect(again2.result!.parts.contentHash, `${where}: re-combine changed it`).toBe(p1.result!.parts.contentHash);
    }
    return res;
  }
  const c1 = all(p1, () => pick);
  const c2: CombineChoices = { fine: Object.fromEntries(Object.entries(c1.fine!).map(([k, v]) => [k, swap(v)])) };
  const r1 = await applyFineChoices(p1, c1), r2 = await applyFineChoices(p2, c2);
  expect(r1 && r2, `${where}: no result with every conflict chosen`).toBeTruthy();
  expect(r2!.parts.contentHash, where).toBe(r1!.parts.contentHash);
  return clone(r1!.sections) as unknown as SectionValues;
}

/** The computer whose entry moved (base `s0`, its row `R`, now `s`) and the other side `o`, combined as `res`: the
 *  row `R` is the other computer's (as `o` has it) and the moved row `X` holds this computer's changes.
 *  CHANGED BY fixer round 3 (the safety net): when the moved row was asked about (`askedX`) and the result has it
 *  exactly as the chosen side has it, that was a choice of the whole row (one side rewrote every value of it). */
function entriesKept(s0: SectionValues, s: SectionValues, o: SectionValues, res: SectionValues, R: string, X: string, pick: "mine" | "theirs", where: string, askedX = false) {
  const t = tab(res);
  expect(t.row_ids.filter((id) => id === X).length, `${where}: moved row`).toBe(1);
  expect(JSON.parse(rowText(res, R) ?? "null")?.slice(0, 2), `${where}: the other's entry (label)`).toEqual(JSON.parse(rowText(o, R) ?? "null")?.slice(0, 2));
  if (askedX && rowText(res, X) === (pick === "mine" ? rowText(s, R) : rowText(o, X))) return;
  const ts = tab(s), to = tab(o);
  const K = Math.min(ts.n_rep, to.n_rep, t.n_rep, tab(s0).n_rep);
  t.col_ids.forEach((cid, c) => {
    const cs = ts.col_ids.indexOf(cid), co = to.col_ids.indexOf(cid), c0 = tab(s0).col_ids.indexOf(cid);
    if (cs !== c || co !== c || c0 !== c) return;           // only value edits here: the columns line up
    for (let k = 0; k < K; k++) {
      expect(valueAt(res, R, c, k), `${where}: row ${R} ${cid}/${k} is the other computer's`).toBe(valueAt(o, R, c, k));
      const b = valueAt(s0, R, c, k), mv = valueAt(s, R, c, k), ov = valueAt(o, X, c, k);
      const want = mv === ov ? mv : ov === b ? mv : mv === b ? ov : null;
      if (want !== null) expect(valueAt(res, X, c, k), `${where}: moved row ${cid}/${k}`).toBe(want);
      else expect([mv, ov], `${where}: moved row ${cid}/${k} chosen`).toContain(valueAt(res, X, c, k));
    }
  });
  void pick;
}

/** Generated stories. `coincide`: the values come from a few words, so two entries can read alike by chance — then only
 *  what holds whatever the values are is checked (both computers alike, the older rules, stored form, re-combining
 *  with that side as the base); otherwise also that every new value goes into its own entry's row. */
async function splitStories(cases: number, seed: number, coincide: boolean) {
    const r = rng(seed);
    const strict = !coincide;
    const stats = { stories: 0, leaver: 0, keeper: 0, chain: 0, unsure: 0, asked: 0, skipped: 0 };
    for (let i = 0; i < cases; i++) {
      const t: Template = r.pick(["column", "grouped", "xy"]);
      prefix = "b";
      const base = await toSections(openContent({ doc: sampleDoc(t) }));
      const bt = tab(base);
      const R = bt.row_ids[bt.row_ids.length - 1];             // the blank row the editor keeps at the end
      const where0 = `split case ${i} (${t})`;
      // Both type into it (and maybe make a few more edits elsewhere).
      const sideOf = async (who: string) => {
        prefix = who;
        let c = typeInto(r, open(base), R, 1 + r.int(3), true, coincide);
        for (let n = r.int(3); n > 0; n--) c = stored(edit(r, c));
        prefix = "b";
        return toSections(c);
      };
      const x = await sideOf(`x${i.toString(36)}`), y = await sideOf(`y${i.toString(36)}`);
      if (rowText(x, R) === null || rowText(y, R) === null || rowText(x, R) === rowText(y, R)) { stats.skipped++; continue; }
      const pick = r.pick(["mine", "theirs"] as const);
      const rr = await checkPair(base, x, y, `${where0} first combine`, pick, strict);
      // One of them keeps typing into what it still sees as its row (its version is the base of the next combine).
      const [s0, other] = r.chance(0.5) ? [x, y] : [y, x];
      void other;
      const leaver = rowText(rr, R) !== rowText(s0, R);
      // Its entry's new row: made by the combine (on neither side) and reading as its row did.
      const X = leaver
        ? tab(rr).row_ids.find((id) => !tab(x).row_ids.includes(id) && !tab(y).row_ids.includes(id) && rowText(rr, id) === rowText(s0, R))
        : undefined;
      if (leaver && !X) { stats.skipped++; continue; }     // its entry was changed by a choice in the first combine
      prefix = `s${i.toString(36)}`;
      let sc = typeInto(r, open(s0), R, 1 + r.int(3), r.chance(0.3), coincide);
      if (r.chance(0.3)) sc = valuesAnywhere(r, sc, 1, coincide);
      const s = await toSections(sc);
      // The other computer may go on from the combined version too.
      prefix = `o${i.toString(36)}`;
      const o = r.chance(0.5) ? rr : await toSections(valuesAnywhere(r, open(rr), 1 + r.int(2), coincide));
      prefix = "b";
      const where = `${where0} ${leaver ? "moved" : "kept"}`;
      const res = await checkPair(s0, s, o, where, pick, strict);
      const p = await plan(s0, s, o, KX, KY);
      if (p.needsChoice) stats.asked++;
      stats.stories++;
      if (!leaver) {
        stats.keeper++;
        if (strict) tableLossCheck(s0, s, o, res, where, new Set(p.sections.flatMap((q) => q.conflicts.flatMap((c) => (c.kind === "row" && c.rowId ? [c.rowId] : [])))));
        continue;
      }
      stats.leaver++;
      const askedOf = (pl: typeof p, id: string) => pl.sections.some((q) => q.conflicts.some((c) => c.id === `table:row:${id}`));
      if (strict) entriesKept(s0, s, o, res, R, X!, pick, where, askedOf(p, X!));
      // A chain: it types once more before either combined version reaches it; the other computer wrote `res`.
      if (r.chance(0.5)) {
        stats.chain++;
        prefix = `t${i.toString(36)}`;
        const s3 = await toSections(typeInto(r, open(s), R, 1 + r.int(2), r.chance(0.3), coincide));
        prefix = `p${i.toString(36)}`;
        const o3 = r.chance(0.5) ? res : await toSections(valuesAnywhere(r, open(res), 1 + r.int(2), coincide));
        prefix = "b";
        const w3 = `${where} chain`;
        const res3 = await checkPair(s, s3, o3, w3, pick, strict);
        const p3 = await plan(s, s3, o3, KX, KY);
        if (p3.sections.some((q) => q.conflicts.some((c) => c.id === `table:row:${R}`))) {
          // The other computer also changed the moved row, so the combine can't tell it is the moved row: then the
          // row is one choice as a whole (never two entries mixed) and nothing is combined by itself.
          stats.unsure++;
          expect(p3.autoApplicable, w3).toBe(false);
          if (strict) expect(rowText(res3, R), `${w3}: row chosen whole`).toBe(rowText(pick === "mine" ? s3 : o3, R));
        } else if (strict) entriesKept(s, s3, o3, res3, R, X!, pick, w3, askedOf(p3, X!));
      }
    }
    expect(stats.leaver).toBeGreaterThan(cases / 5);
    expect(stats.keeper).toBeGreaterThan(cases / 10);
    expect(stats.chain).toBeGreaterThan(0);
    console.log(`split-then-keep-typing fuzz (${coincide ? "values that may coincide" : "fresh values"}): ${JSON.stringify(stats)}`);
}

describe("fixer round 2 (RV-1): both type into the same blank row, then one keeps typing before the combined version arrives", () => {
  it(`${SPLIT_CASES} generated stories: its new values go into its own row on both computers, never into the other's entry`, async () => {
    await splitStories(SPLIT_CASES, SPLIT_SEED, false);
  }, 600_000);
  it(`${SPLIT_CASES} generated stories with values that may coincide: both computers alike, re-combining changes nothing`, async () => {
    await splitStories(SPLIT_CASES, SPLIT_SEED + 1, true);
  }, 600_000);
});
