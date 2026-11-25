/* Fixer round 3: a property test over whole histories (ported from the round-3 re-verifier's fuzz). Three
   computers edit one table, save and combine with each other in random order; every combine takes the common
   version as a real history gives it (the nearest version both have). Every value a computer types is tagged
   "<entry>.<n>", so the test sees, whatever the row ids, which entry each value belongs to:
   - a row of a result holding values of two entries is two people's entries in one row (never, asked or not);
   - an entry in two rows, an entry lost without a question, a place that does not follow the three-way rule;
   - both computers get the same bytes and the same questions;
   - combining a result again with either side asks nothing and changes no row.
   Seeded; ENTITY_SEEDS=… ENTITY_SEED0=… for a longer search (the default is small, for CI).

   Known and accepted (phase 4 contract §2.2.2, "CHANGED BY fixer round 3"): combining a result again with the
   side that deleted a row an earlier combine had moved (or that holds such a row twice) can ask about that row
   or bring the row back (nothing shows the move any more); the order of rows can differ on a re-combine (RV2-3). A version with two nearest common versions (a
   criss-cross) is only checked for mixed rows and for both computers agreeing. */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GraphDoc, Template } from "../../../api/graph";
import { deleteRow, ensureRows, insertRow } from "../graphModel";
import type { FineChoices, FineConflict, SideKey } from "./contract";
import { canonicalJson } from "./format";
import { normaliseSections } from "./graphMerge";
import type { FileTable } from "./idMap";
import { mergeTable } from "./mergeTable";
import { clone, countingIds, sampleSections } from "./fixtures-p2/docs";

let restoreIds: () => void;
beforeAll(() => { restoreIds = countingIds(); });
afterAll(() => restoreIds());

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const SEEDS = Number(env.ENTITY_SEEDS ?? 12);
const SEED0 = Number(env.ENTITY_SEED0 ?? 1);
const STEPS = 40;

async function ft(d: GraphDoc): Promise<FileTable> {
  const n = await normaliseSections({ ...sampleSections(d.template), table: { ...d, v: 2 }, scratchpad: null });
  if (!n) throw new Error("not a document");
  return clone(n.sections.table) as FileTable;
}
const toDoc = (t: FileTable): GraphDoc => clone({ ...t, v: 1 }) as unknown as GraphDoc;
const text = (t: FileTable | null) => (t ? canonicalJson(t) : "null");
/** A table's rows by id (order aside). */
const rowsById = (t: FileTable | null) => (t ? canonicalJson({ ...t, rows: Object.fromEntries(t.row_ids.map((id, i) => [id, [t.row_titles[i], t.x[i], t.cells[i]]])), row_ids: [...t.row_ids].sort(), row_titles: null, x: null, cells: null }) : "null");

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

const UNCH = 0, MINE = 2, THEIRS = 3, CONF = 4;
function three(b: string, m: string, t: string) {
  if (m === t) return m === b ? UNCH : 1;
  if (m === b) return THEIRS;
  if (t === b) return MINE;
  return CONF;
}

/** "coincide": values are small numbers that often repeat (entries look alike); "entry": tagged values. */
type Mode = "entry" | "coincide";
const entOf = (v: string): string | null => { if (v === "") return null; const i = v.indexOf("."); return i < 0 ? "?" + v : v.slice(0, i); };

interface View { ents: Map<string, { rows: string[]; vals: Map<string, string> }>; mixed: string[]; mixedIds: string[] }
function view(t: FileTable): View {
  const ents = new Map<string, { rows: string[]; vals: Map<string, string> }>();
  const mixed: string[] = [], mixedIds: string[] = [];
  t.row_ids.forEach((rid, i) => {
    const places: [string, string][] = [];
    if (t.template === "grouped") places.push(["title", t.row_titles[i] ?? ""]);
    if (t.template === "xy") places.push(["x", t.x[i] ?? ""]);
    t.col_ids.forEach((cid, j) => { for (let k = 0; k < t.n_rep; k++) places.push([`c:${cid}:${k}`, t.cells[i]?.[j]?.[k] ?? ""]); });
    const es = new Set(places.map(([, v]) => entOf(v)).filter((e): e is string => e !== null));
    if (es.size > 1) { mixed.push(`${rid}:{${[...es].join(",")}}`); mixedIds.push(rid); }
    for (const e of es) {
      const ent = ents.get(e) ?? { rows: [] as string[], vals: new Map<string, string>() };
      ent.rows.push(rid);
      for (const [p, v] of places) if (entOf(v) === e) ent.vals.set(p, v);
      ents.set(e, ent);
    }
  });
  return { ents, mixed, mixedIds };
}

/** A row's places with text (title, X, cells by column id and replicate). */
function placesOf(t: FileTable, rid: string): Map<string, string> {
  const out = new Map<string, string>(), i = t.row_ids.indexOf(rid);
  if (i < 0) return out;
  if (t.template === "grouped" && t.row_titles[i]) out.set("title", t.row_titles[i]);
  if (t.template === "xy" && t.x[i]) out.set("x", t.x[i]);
  t.col_ids.forEach((cid, j) => { for (let k = 0; k < t.n_rep; k++) if (t.cells[i]?.[j]?.[k]) out.set(`${cid}:${k}`, t.cells[i][j][k]); });
  return out;
}

/** The rows a question is about (a row an earlier combine moved counts under both its ids). */
function askedRows(cs: FineConflict[], moved: { id: string; was: string }[]): Set<string> {
  const out = new Set<string>();
  for (const c of cs) {
    if (c.rowId) out.add(c.rowId);
    for (const it of c.items) if (it.rowId) out.add(it.rowId);
  }
  for (const m of moved) if (out.has(m.id)) out.add(m.was);
  return out;
}

interface Stats { fine: number; questions: number; moved: number; split: number; violations: string[] }

async function history(seed: number, template: Template, mode: Mode, st: Stats) {
  const r = rng(seed);
  const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)];
  let entN = 0;
  const cnt = new Map<string, number>();
  const nextVal = (e: string) => {
    if (mode === "coincide") return String(1 + Math.floor(r() * 3));
    const n = (cnt.get(e) ?? 0) + 1; cnt.set(e, n); return `${e}.${n}`;
  };
  const newEnt = () => String(++entN);
  const nCols = template === "column" ? 3 : 2, nRep = template === "grouped" ? 2 : 1;
  let doc: GraphDoc = ensureRows({
    v: 1, template, col_titles: Array.from({ length: nCols }, (_, i) => `C${i}`), x_title: "X", n_rep: nRep,
    row_titles: [], x: [], cells: [], row_ids: [], col_ids: Array.from({ length: nCols }, (_, i) => `col-c${i}`),
  } as unknown as GraphDoc);
  for (let i = 0, n = 3 + Math.floor(r() * 3); i < n; i++) {
    const e = newEnt();
    const cells = doc.cells.map((row) => row.map((reps) => [...reps]));
    const titles = [...doc.row_titles], xs = [...doc.x];
    if (template === "grouped") titles[i] = nextVal(e);
    if (template === "xy") xs[i] = nextVal(e);
    for (let j = 0; j < nCols; j++) cells[i][j][0] = nextVal(e);
    doc = ensureRows({ ...doc, cells, row_titles: titles, x: xs });
  }
  const t0 = await ft(doc);
  interface Ver { t: FileTable; parents: string[]; dev: string }
  const vers = new Map<string, Ver>();
  let vn = 0;
  const addVer = (t: FileTable, parents: string[], dev: string) => { const id = `r-${String(++vn).padStart(4, "0")}`; vers.set(id, { t, parents, dev }); return id; };
  const root = addVer(t0, [], "d-0000");
  const comps = ["d-1111", "d-2222", "d-3333"].map((dev) => ({ dev, head: root, work: clone(t0) }));
  type Comp = (typeof comps)[number];
  const anc = (id: string): Set<string> => {
    const out = new Set<string>(); const todo = [id];
    while (todo.length) { const x = todo.pop()!; if (out.has(x)) continue; out.add(x); todo.push(...vers.get(x)!.parents); }
    return out;
  };
  const lca = (a: string, b: string): { id: string; ambiguous: boolean } => {
    const A = anc(a), Bs = anc(b);
    const common = [...A].filter((x) => Bs.has(x));
    const best = common.filter((x) => !common.some((y) => y !== x && anc(y).has(x))).sort();
    return { id: best[0], ambiguous: best.length > 1 };
  };
  const save = (c: Comp) => { if (text(c.work) !== text(vers.get(c.head)!.t)) c.head = addVer(clone(c.work), [c.head], c.dev); };

  const editOp = async (c: Comp) => {
    let d = toDoc(c.work);
    const rows = d.row_ids.map((_, i) => i);
    const hasData = (i: number) => (template === "grouped" && d.row_titles[i] !== "") || (template === "xy" && d.x[i] !== "") || d.cells[i].some((reps) => reps.some((v) => v !== ""));
    const blank = rows.filter((i) => !hasData(i)), full = rows.filter(hasData);
    const x = r();
    if (x < 0.35 && blank.length) {
      // A new entry into a blank row, most often the first blank row at the end (where everyone types).
      const firstTail = (() => { let i = d.row_ids.length; while (i > 0 && !hasData(i - 1)) i--; return i; })();
      const i = r() < 0.75 && firstTail < d.row_ids.length ? firstTail : pick(blank);
      const e = newEnt();
      const cells = d.cells.map((row) => row.map((reps) => [...reps]));
      const titles = [...d.row_titles], xs = [...d.x];
      if (template === "grouped" && r() < 0.8) titles[i] = nextVal(e);
      if (template === "xy") xs[i] = nextVal(e);
      const j = Math.floor(r() * nCols);
      cells[i][j][Math.floor(r() * d.n_rep)] = nextVal(e);
      if (r() < 0.5) cells[i][(j + 1) % nCols][0] = nextVal(e);
      d = { ...d, cells, row_titles: titles, x: xs };
    } else if (x < 0.85 && full.length) {
      // A change to an existing entry (a row that is not mixed already).
      const i = pick(full);
      const es = new Set<string>();
      if (template === "grouped" && d.row_titles[i]) es.add(entOf(d.row_titles[i])!);
      if (template === "xy" && d.x[i]) es.add(entOf(d.x[i])!);
      d.cells[i].forEach((reps) => reps.forEach((v) => { const q = entOf(v); if (q) es.add(q); }));
      if (mode === "entry" && es.size !== 1) return;
      const e = mode === "entry" ? [...es][0] : "z";
      const cells = d.cells.map((row) => row.map((reps) => [...reps]));
      const titles = [...d.row_titles], xs = [...d.x];
      const y = r();
      if (template === "grouped" && y < 0.2) titles[i] = nextVal(e);
      else if (template === "xy" && y < 0.2) xs[i] = nextVal(e);
      else cells[i][Math.floor(r() * nCols)][Math.floor(r() * d.n_rep)] = nextVal(e);
      d = { ...d, cells, row_titles: titles, x: xs };
    } else if (x < 0.93 && full.length > 1) {
      d = deleteRow(d, pick(full));
    } else {
      d = insertRow(d, Math.floor(r() * d.row_ids.length));
    }
    c.work = await ft(ensureRows(d));
  };

  const keyOf = (id: string): SideKey => ({ deviceId: vers.get(id)!.dev, revisionId: id });
  const swapC = (ch: FineChoices) => Object.fromEntries(Object.entries(ch).map(([k, v]) => [k, v === "mine" ? "theirs" : "mine"])) as FineChoices;
  const bad = (where: string, what: string) => st.violations.push(`${where}: ${what}`);

  const combine = async (c: Comp, o: Comp) => {
    save(c);
    const h1 = c.head, h2 = o.head;
    if (anc(h1).has(h2)) return;
    if (anc(h2).has(h1)) { c.head = h2; c.work = clone(vers.get(h2)!.t); return; }
    const { id: bId, ambiguous } = lca(h1, h2);
    const B = vers.get(bId)!.t, M = vers.get(h1)!.t, T = vers.get(h2)!.t;
    let res: FileTable;
    if (text(M) === text(T) || text(B) === text(T)) res = clone(M);
    else if (text(B) === text(M)) res = clone(T);
    else {
      st.fine++;
      const k1 = keyOf(h1), k2 = keyOf(h2);
      const where = `seed ${seed} ${template} ${mode} base ${bId} mine ${h1} theirs ${h2}${ambiguous ? " (two common versions)" : ""}`;
      const p0 = await mergeTable({ base: B, mine: M, theirs: T, mineKey: k1, theirsKey: k2 });
      const ch: FineChoices = Object.fromEntries(p0.conflicts.map((cf) => [cf.id, r() < 0.5 ? "mine" : "theirs"]));
      st.questions += p0.conflicts.length;
      st.moved += p0.rowNotes?.moved.length ?? 0; st.split += p0.rowNotes?.split.length ?? 0;
      const p = p0.conflicts.length ? await mergeTable({ base: B, mine: M, theirs: T, mineKey: k1, theirsKey: k2 }, ch) : p0;
      if (!p.value) { bad(where, "no result with every choice made"); return; }
      res = p.value;
      // Both computers: the same questions and the same bytes.
      const q0 = await mergeTable({ base: B, mine: T, theirs: M, mineKey: k2, theirsKey: k1 });
      if (p0.conflicts.map((x) => x.id).sort().join() !== q0.conflicts.map((x) => x.id).sort().join()) bad(where, "questions differ by computer");
      const q = p0.conflicts.length ? await mergeTable({ base: B, mine: T, theirs: M, mineKey: k2, theirsKey: k1 }, swapC(ch)) : q0;
      if (text(q.value) !== text(res)) bad(where, "bytes differ by computer");
      if (p0.orderChecks.length !== q0.orderChecks.length) bad(where, "order checks differ by computer");
      if (mode === "entry" && !p0.conflicts.some((z) => z.kind === "section")) {
        const vb = view(B), vm = view(M), vt = view(T), vr = view(res);
        // Never two people's entries in one row, asked or not. Accepted (contract §2.2.2, round 3, open (2)): a row
        // of the base with data but without a label (title / X) or with one value only, that one side rewrote
        // while the other changed it too (changing every value can't be told from another entry there).
        const wasOf = new Map((p0.rowNotes?.moved ?? []).map((x) => [x.id, x.was]));
        const oneValueFix = (rid: string) => {
          const bid = B.row_ids.includes(rid) ? rid : wasOf.get(rid) ?? rid;
          const pb = placesOf(B, bid);
          if (pb.size === 0 || (pb.size >= 2 && pb.has(template === "xy" ? "x" : "title"))) return false;
          return [M, T].some((s) => [rid, bid].some((id) => s.row_ids.includes(id) && [...pb].every(([k, v]) => placesOf(s, id).get(k) !== v)));
        };
        const accepted = new Set(vr.mixedIds.filter(oneValueFix));
        const mixedBad = vr.mixed.filter((_, n) => !accepted.has(vr.mixedIds[n]));
        if (mixedBad.length && !vm.mixed.length && !vt.mixed.length) bad(where, `two entries in one row ${mixedBad.join(" ")}${p0.conflicts.length ? " (after the choices)" : ""}`);
        if (!ambiguous) {
          const asked = askedRows(p0.conflicts, p0.rowNotes?.moved ?? []);
          // An entry in two rows (unless a row of it was asked about: keeping a row one side deleted can do that).
          for (const [e, ent] of vr.ents) {
            if (ent.rows.length > 1 && !((vm.ents.get(e)?.rows.length ?? 0) > 1) && !((vt.ents.get(e)?.rows.length ?? 0) > 1) && !ent.rows.some((id) => asked.has(id) || accepted.has(id))) bad(where, `entry ${e} in two rows`);
          }
          for (const e of new Set([...vb.ents.keys(), ...vm.ents.keys(), ...vt.ents.keys(), ...vr.ents.keys()])) {
            const b = vb.ents.get(e), m = vm.ents.get(e), t = vt.ents.get(e), rr = vr.ents.get(e);
            if ((b?.rows.length ?? 0) > 1 || (m?.rows.length ?? 0) > 1 || (t?.rows.length ?? 0) > 1) continue;
            if ([b, m, t, rr].flatMap((z) => z?.rows ?? []).some((id) => accepted.has(id))) continue;
            const wasAsked = [b, m, t, rr].flatMap((z) => z?.rows ?? []).some((id) => asked.has(id));
            const changed = (s: typeof m) => !!s && !!b && [...new Set([...s.vals.keys(), ...b.vals.keys()])].some((pl) => (s.vals.get(pl) ?? "") !== (b.vals.get(pl) ?? ""));
            if (!m && !t) { if (rr) bad(where, `entry ${e} deleted on both sides but there`); continue; }
            if (b && (!m || !t)) {
              if (changed(m ?? t)) { if (!wasAsked) bad(where, `entry ${e} deleted on one side, changed on the other, not asked`); }
              else if (rr) bad(where, `entry ${e} deleted on one side (unchanged on the other) but there`);
              continue;
            }
            if (!rr) { if (!wasAsked) bad(where, `entry ${e} lost without a question`); continue; }
            for (const pl of new Set([...(b?.vals.keys() ?? []), ...(m?.vals.keys() ?? []), ...(t?.vals.keys() ?? []), ...rr.vals.keys()])) {
              const bv = b?.vals.get(pl) ?? "", mv = m?.vals.get(pl) ?? "", tv = t?.vals.get(pl) ?? "", got = rr.vals.get(pl) ?? "";
              const c3 = three(bv, mv, tv);
              if (c3 === CONF) { if (got !== mv && got !== tv) bad(where, `entry ${e} ${pl}: ${got} is neither side's`); else if (!wasAsked) bad(where, `entry ${e} ${pl}: changed on both sides, not asked`); }
              else {
                const want = c3 === THEIRS ? tv : mv;
                if (got !== want && !(wasAsked && (got === mv || got === tv))) bad(where, `entry ${e} ${pl}: "${got}", want "${want}"`);
              }
            }
          }
        }
      }
      // Combining the result again with either side: nothing asked, no row changed.
      if (!p0.conflicts.length && !ambiguous) {
        // Accepted: the side that deleted a row an earlier combine had moved, against the result (nothing shows the
        // move any more: it is asked about, or taken as deleted).
        // The same when a side holds such a row twice already (an earlier choice kept both).
        const moved = p0.rowNotes?.moved ?? [];
        const twice = (s: FileTable) => { const keys = s.row_ids.map((_, i) => canonicalJson([s.row_titles[i], s.x[i], s.cells[i]])).filter((k) => /[^",[\]]/.test(k)); return new Set(keys).size < keys.length; };
        const lost = (s: FileTable) => moved.length > 0 && (moved.some((x) => !s.row_ids.includes(x.was)) || twice(s));
        for (const [x, y] of [[res, M], [res, T], [M, res], [T, res]] as const) {
          if (lost(x === res ? y : x)) continue;
          const again = await mergeTable({ base: B, mine: x, theirs: y, mineKey: k1, theirsKey: k2 });
          if (again.conflicts.length) { bad(where, `combining again asks ${again.conflicts.map((z) => z.id).join(", ")}`); break; }
          if (rowsById(again.value) !== rowsById(res)) { bad(where, "combining again changes the rows"); break; }
        }
      }
    }
    c.head = addVer(res, [h1, h2], c.dev);
    c.work = clone(res);
  };

  for (let s = 0; s < STEPS; s++) {
    const c = pick(comps);
    const y = r();
    if (y < 0.55) await editOp(c);
    else if (y < 0.7) save(c);
    else { const o = pick(comps.filter((z) => z !== c)); save(o); await combine(c, o); }
  }
}

describe("histories of three computers (entries tagged)", () => {
  for (const mode of ["entry", "coincide"] as const) {
    for (const template of ["grouped", "xy", "column"] as const) {
      it(`${mode} values, ${template}`, async () => {
        const st: Stats = { fine: 0, questions: 0, moved: 0, split: 0, violations: [] };
        for (let seed = SEED0; seed < SEED0 + SEEDS; seed++) await history(seed * 7919 + template.length * 13 + (mode === "entry" ? 0 : 5), template, mode, st);
        expect(st.violations).toEqual([]);
        expect(st.fine).toBeGreaterThan(SEEDS * 3);
      }, 600_000);
    }
  }
  it("the known cases from the re-verifier (seeds 158471, 229729, 17516906, 18475105, 16709181, 16622007, 102973, 158458, 134649)", async () => {
    const st: Stats = { fine: 0, questions: 0, moved: 0, split: 0, violations: [] };
    for (const [seed, template] of [[158471, "grouped"], [229729, "column"], [16709181, "grouped"], [16622007, "xy"], [102973, "xy"], [158458, "column"], [134649, "xy"], [17516906, "column"], [18475105, "column"]] as const) {
      await history(seed, template, "entry", st);
    }
    expect(st.violations).toEqual([]);
  }, 600_000);
});
