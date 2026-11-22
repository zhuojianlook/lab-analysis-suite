/* What a version says about itself (phase 2 contract §3.5): the summary text
   stored with a new version, the text a Versions row shows, and what differs
   between two versions ("Compare with current", the combine dialog). Plain
   words only; the fixed phrases live in contract.ts (SUMMARY, SECTION_PHRASE).
   Pure. */

import {
  LIMITS_P2, SECTION_PHRASE, SUMMARY,
  type CompareResult, type RevisionP2, type SummariesApi,
} from "./contract";
import type { FileSections4 } from "./docCodec";
import { SECTION_NAMES, canonicalJson, type PartRef, type Revision, type RevisionKind, type SectionName } from "./format";

export function changedSections(prev: Record<SectionName, PartRef>, next: Record<SectionName, PartRef>): SectionName[] {
  return SECTION_NAMES.filter((n) => prev?.[n]?.sha256 !== next?.[n]?.sha256);
}

export function sectionList(keys: readonly SectionName[]): string {
  const set = new Set(keys);
  const phrases = SECTION_NAMES.filter((n) => set.has(n)).map((n) => SECTION_PHRASE[n]);
  if (phrases.length <= 1) return phrases[0] ?? "";
  return `${phrases.slice(0, -1).join(", ")} and ${phrases[phrases.length - 1]}`;
}

export function summaryText(p: {
  kind: RevisionKind; root: boolean; auto?: boolean;
  prev: Record<SectionName, PartRef> | null | undefined; next: Record<SectionName, PartRef>;
}): string {
  if (p.kind === "import") return SUMMARY.imported;
  if (p.kind === "restore") return SUMMARY.broughtBack;
  if (p.kind === "merge") return p.auto ? SUMMARY.combinedAuto : SUMMARY.combinedChosen;
  if (p.root) return SUMMARY.first;
  if (!p.prev) return SUMMARY.saved;
  const changed = changedSections(p.prev, p.next);
  return changed.length ? SUMMARY.changedPrefix + sectionList(changed) : SUMMARY.noChanges;
}

export function displaySummary(rev: Revision, firstParent: Revision | null): string {
  const r = rev as RevisionP2;
  if (r.kind === "import" || r.kind === "restore" || r.kind === "merge") {
    return summaryText({ kind: r.kind, root: false, auto: r.auto === true, prev: null, next: r.sections ?? ({} as Record<SectionName, PartRef>) });
  }
  if (r.sections && firstParent?.sections) {
    const changed = changedSections(firstParent.sections, r.sections);
    if (changed.length) return SUMMARY.changedPrefix + sectionList(changed);
    // A version that only made the file a separate analysis keeps saying so.
    return r.summary === SUMMARY.separated ? SUMMARY.separated : SUMMARY.noChanges;
  }
  if (!Array.isArray(r.parents) || r.parents.length === 0) return SUMMARY.first;
  const stored = typeof r.summary === "string" ? r.summary.trim().replace(/\.+$/, "").trim() : "";
  return stored || SUMMARY.saved;
}

// ── compare ─────────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "");

/** A setting's value as short text: strings as they are, numbers / booleans via String, else canonical JSON (60 characters at most). */
function shortText(v: unknown): string {
  if (v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  let s: string;
  try { s = canonicalJson(v); } catch { s = ""; }
  return s.length > 60 ? s.slice(0, 59) + "…" : s;
}

const canon = (v: unknown): string => { try { return canonicalJson(v ?? null); } catch { return ""; } };

function compareTable(aRaw: unknown, bRaw: unknown): CompareResult["table"] {
  const a = isObj(aRaw) ? aRaw : {}, b = isObj(bRaw) ? bRaw : {};
  const ids = (t: Obj, k: string) => arr(t[k]).map((x) => (typeof x === "string" ? x : ""));
  const aRows = ids(a, "row_ids"), bRows = ids(b, "row_ids"), aCols = ids(a, "col_ids"), bCols = ids(b, "col_ids");
  const index = (list: string[]) => { const m = new Map<string, number>(); list.forEach((id, i) => { if (id && !m.has(id)) m.set(id, i); }); return m; };
  const aRowAt = index(aRows), bRowAt = index(bRows), aColAt = index(aCols), bColAt = index(bCols);
  const count = (from: Map<string, number>, other: Map<string, number>) => [...from.keys()].filter((id) => !other.has(id)).length;
  const aCells = arr(a.cells), bCells = arr(b.cells);
  const cellAt = (cells: unknown[], r: number, c: number, k: number) => text(arr(arr(cells[r])[c])[k]);
  const nRep = (t: Obj, cells: unknown[]) => Math.max(1, Number.isInteger(t.n_rep) ? (t.n_rep as number) : 0,
    ...cells.map((row) => Math.max(0, ...arr(row).map((cell) => arr(cell).length))));
  const reps = Math.max(nRep(a, aCells), nRep(b, bCells));
  const cells: CompareResult["table"]["cells"] = [];
  let changedCells = 0;
  for (const [rowId, br] of bRowAt) {
    const ar = aRowAt.get(rowId);
    if (ar === undefined) continue;
    for (const [colId, bc] of bColAt) {
      const ac = aColAt.get(colId);
      if (ac === undefined) continue;
      for (let k = 0; k < reps; k++) {
        const va = cellAt(aCells, ar, ac, k), vb = cellAt(bCells, br, bc, k);
        if (va === vb) continue;
        changedCells++;
        if (cells.length < LIMITS_P2.compareCells) cells.push({ rowId, colId, rep: k, a: va, b: vb });
      }
    }
  }
  let changedTitles = 0;
  const aRowT = arr(a.row_titles), bRowT = arr(b.row_titles), aX = arr(a.x), bX = arr(b.x);
  for (const [rowId, br] of bRowAt) {
    const ar = aRowAt.get(rowId);
    if (ar === undefined) continue;
    if (text(aRowT[ar]) !== text(bRowT[br])) changedTitles++;
    if (text(aX[ar]) !== text(bX[br])) changedTitles++;
  }
  const aColT = arr(a.col_titles), bColT = arr(b.col_titles);
  for (const [colId, bc] of bColAt) {
    const ac = aColAt.get(colId);
    if (ac !== undefined && text(aColT[ac]) !== text(bColT[bc])) changedTitles++;
  }
  return {
    changedCells, addedRows: count(bRowAt, aRowAt), removedRows: count(aRowAt, bRowAt),
    addedCols: count(bColAt, aColAt), removedCols: count(aColAt, bColAt), changedTitles, cells,
  };
}

function compareSettings(section: "analysis" | "figure", aRaw: unknown, bRaw: unknown, out: CompareResult["settings"]): void {
  const a = isObj(aRaw) ? aRaw : {}, b = isObj(bRaw) ? bRaw : {};
  const own = (o: Obj, k: string) => Object.prototype.hasOwnProperty.call(o, k);
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const field of keys) {
    if (out.length >= LIMITS_P2.compareSettings) return;
    const va = own(a, field) ? a[field] : undefined, vb = own(b, field) ? b[field] : undefined;
    if (va === undefined && vb === undefined) continue;
    if (va !== undefined && vb !== undefined && canon(va) === canon(vb)) continue;
    out.push({ section, field, a: shortText(va), b: shortText(vb) });
  }
}

/** Cell addresses (and column widths) whose stored value differs; at least 1 whenever the scratchpads differ. */
function compareScratch(aRaw: unknown, bRaw: unknown): number {
  if (canon(aRaw) === canon(bRaw)) return 0;
  const cellsOf = (raw: unknown) => {
    const m = new Map<string, string>();
    for (const c of arr(isObj(raw) ? raw.cells : null)) {
      const t = arr(c);
      if (t.length < 3) continue;
      m.set(`${String(t[0])},${String(t[1])}`, canon(t.slice(2)));
    }
    return m;
  };
  const colsOf = (raw: unknown) => {
    const m = new Map<string, string>();
    const cols = isObj(raw) && isObj(raw.cols) ? raw.cols : {};
    for (const k of Object.keys(cols)) m.set(k, canon(cols[k]));
    return m;
  };
  const diff = (x: Map<string, string>, y: Map<string, string>) => {
    let n = 0;
    for (const k of new Set([...x.keys(), ...y.keys()])) if (x.get(k) !== y.get(k)) n++;
    return n;
  };
  return Math.max(1, diff(cellsOf(aRaw), cellsOf(bRaw)) + diff(colsOf(aRaw), colsOf(bRaw)));
}

export function compareSections(a: FileSections4, b: FileSections4): CompareResult {
  const settings: CompareResult["settings"] = [];
  compareSettings("analysis", a?.analysis, b?.analysis, settings);
  compareSettings("figure", a?.figure, b?.figure, settings);
  return {
    sections: SECTION_NAMES.map((key) => ({ key, same: canon(a?.[key]) === canon(b?.[key]) })),
    table: compareTable(a?.table, b?.table),
    settings,
    scratchpadCells: compareScratch(a?.scratchpad ?? null, b?.scratchpad ?? null),
  };
}

({ changedSections, sectionList, summaryText, displaySummary, compareSections }) satisfies SummariesApi;
