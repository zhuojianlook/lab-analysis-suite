/* Section-level combining (plan §9.3; phase 2 contract §2, §3.4). Base, mine
   and theirs all go through the same load pipeline before anything is
   compared, so different app versions cannot create differences nobody made.
   A section changed on one side only is taken from that side; a section both
   changed differently needs a choice. After the result is put together it goes
   through the pipeline once more: whatever that changes is an automatic repair
   and always means somebody looks before it is written. Pure apart from
   hashing; no clock, no randomness, no device-specific content in an
   automatic combine. */

import {
  COMBINE_V, LIMITS_P2, SUMMARY,
  type BaseKind, type CombineChoices, type CombineOutcome, type CombineOutcomeP4, type CombinePlan, type CombinePlanP4,
  type CombineResult, type CombineResultP4, type CombineSection, type CombineSectionP4, type FineAdjustment, type FineChoice,
  type FineChoices, type FineConflict, type FineMerge, type GraphMergeApiP4, type NormalisedSide, type OrderCheck,
  type RevisionP4, type SectionStatus, type SectionValues, type SideKey, type SidePick, type TableMerge,
} from "./contract";
import { contentOfSections, mergeRevisionId, partsOf, sectionsOf, type Author, type FileSections4 } from "./docCodec";
import { SECTION_NAMES, canonicalJson, sha256Hex, type Revision, type SectionName } from "./format";
import type { FileAnalysis, FileFigure, FileTable } from "./idMap";
import { mergeTable } from "./mergeTable";
import { detectAdjustments, mergeAnalysis, mergeFigure } from "./mergeFields";
import { mergeScratch, sideBySide } from "./mergeScratch";

// ── the one pipeline ────────────────────────────────────────────────────────

export async function normaliseSections(raw: SectionValues): Promise<NormalisedSide | null> {
  if (!raw || typeof raw !== "object") return null;
  let content;
  try { content = contentOfSections(raw as Record<string, unknown>); } catch { return null; }
  if (!content) return null;
  const sections = sectionsOf(content);
  const parts = await partsOf(sections);
  // The pipeline gives rows and columns that have no valid id (a damaged or hand-made file) a new random
  // one, so such a side would differ from itself on every pass and identical content would look like a
  // conflict. A side that doesn't come out the same twice is not comparable: combining falls back to the
  // phase 1 choices (a base like that means a two-way comparison). Files the app writes always come out the same.
  let again;
  try { again = contentOfSections(raw as Record<string, unknown>); } catch { return null; }
  if (!again || (await partsOf(sectionsOf(again))).contentHash !== parts.contentHash) return null;
  return { content, sections, parts };
}

const hashOf = (s: NormalisedSide, k: SectionName) => s.parts.refs[k].sha256;

/** A side's section as a fresh object (parsed from its canonical text), so nothing is shared with the side. */
function sectionValue(s: NormalisedSide, k: SectionName): unknown {
  return JSON.parse(s.parts.texts[s.parts.refs[k].part]);
}

// ── combine ─────────────────────────────────────────────────────────────────

export async function combine(input: {
  base: SectionValues | null; baseKind: BaseKind; mine: SectionValues; theirs: SectionValues;
}): Promise<CombineOutcome> {
  const M = await normaliseSections(input.mine);
  if (!M) return { ok: false, reason: "unreadable", side: "mine" };
  const T = await normaliseSections(input.theirs);
  if (!T) return { ok: false, reason: "unreadable", side: "theirs" };
  const B = input.base && input.baseKind !== "none" ? await normaliseSections(input.base) : null;
  const baseKind: BaseKind = B ? input.baseKind : "none";

  const sections: CombineSection[] = SECTION_NAMES.map((key) => {
    const m = hashOf(M, key), t = hashOf(T, key), b = B ? hashOf(B, key) : null;
    let status: SectionStatus;
    if (m === t) status = "same";
    else if (b !== null && t === b) status = "mine";
    else if (b !== null && m === b) status = "theirs";
    else status = "both";
    const pick: SidePick | null = status === "both" ? null : status === "theirs" ? "theirs" : "mine";
    return { key, status, pick, autoResolvable: status !== "both" };
  });
  const needsChoice = sections.some((s) => s.status === "both");
  const plan: CombinePlan = {
    ok: true, twoWay: !B, baseKind, sections, needsChoice, autoApplicable: false, result: null,
    mine: M, theirs: T, base: B,
  };
  if (!needsChoice) plan.result = await applyChoices(plan, {});
  plan.autoApplicable = baseKind === "lca" && !needsChoice && plan.result !== null && plan.result.repairs.length === 0;
  return plan;
}

export async function applyChoices(plan: CombinePlan, choices: Partial<Record<SectionName, SidePick>>): Promise<CombineResult | null> {
  const sideOf: Record<SectionName, SidePick> = {} as Record<SectionName, SidePick>;
  for (const s of plan.sections) {
    const c = choices?.[s.key];
    const side = c === "mine" || c === "theirs" ? c : s.pick;
    if (side === null) return null;
    sideOf[s.key] = side;
  }
  const assembled = {} as SectionValues;
  for (const k of SECTION_NAMES) assembled[k] = sectionValue(sideOf[k] === "mine" ? plan.mine : plan.theirs, k);
  const re = await normaliseSections(assembled);
  if (!re) return null;
  const from = {} as Record<SectionName, SidePick | "same">;
  const repairs: SectionName[] = [];
  for (const s of plan.sections) {
    from[s.key] = s.status === "same" ? "same" : sideOf[s.key];
    const picked = sideOf[s.key] === "mine" ? plan.mine : plan.theirs;
    if (hashOf(re, s.key) !== hashOf(picked, s.key)) repairs.push(s.key);
  }
  return { content: re.content, sections: re.sections as FileSections4, parts: re.parts, from, repairs };
}

// ── the combined version ────────────────────────────────────────────────────

export async function combineRevision(p: {
  mine: Revision; theirs: Revision; result: CombineResult; auto: boolean; author?: Author; time?: number; legacy?: boolean;
}): Promise<RevisionP4> {
  const contentHash = p.result.parts.contentHash;
  const parents = [p.mine.id, p.theirs.id].sort();
  const id = await mergeRevisionId(parents, contentHash);
  const sections_from: Partial<Record<SectionName, string>> = {};
  for (const k of SECTION_NAMES) {
    const a = p.mine.sections?.[k]?.sha256, b = p.theirs.sections?.[k]?.sha256;
    if (a === b) continue;
    const r = p.result.parts.refs[k].sha256;
    if (r === a) sections_from[k] = p.mine.id;
    else if (r === b) sections_from[k] = p.theirs.id;
  }
  // In section order whatever order the two parents came in.
  const sortedFrom = Object.fromEntries(SECTION_NAMES.filter((k) => k in sections_from).map((k) => [k, sections_from[k]!]));
  const sections = { ...p.result.parts.refs };
  // Phase 4 §2.7.3: the rules' version on every combine this build makes (a constant, so two computers still
  // build the same object); never in the id.
  const v: { combine_v?: number } = p.legacy ? {} : { combine_v: COMBINE_V };
  if (p.auto) {
    const ta = typeof p.mine.time === "string" ? p.mine.time : "";
    const tb = typeof p.theirs.time === "string" ? p.theirs.time : "";
    return {
      id, parents, time: ta > tb ? ta : tb,
      user_name: "", device_id: "", device_name: "", session_id: "", app_version: "",
      kind: "merge", summary: SUMMARY.combinedAuto, sections, content_hash: contentHash,
      auto: true, sections_from: sortedFrom, ...v,
    };
  }
  if (!p.author || typeof p.time !== "number") throw new Error("combineRevision: a chosen combine needs author and time");
  return {
    id, parents, time: new Date(p.time).toISOString(),
    user_name: p.author.user_name, device_id: p.author.device_id, device_name: p.author.device_name,
    session_id: p.author.session_id, app_version: p.author.app_version,
    kind: "merge", summary: SUMMARY.combinedChosen, sections, content_hash: contentHash,
    sections_from: sortedFrom, ...v,
  };
}

/** Phase 4 §3.3: both versions of the pair were made by an app with this build's rules. */
export function peersCombineAlike(mine: Revision, theirs: Revision): boolean {
  const v = (r: Revision) => (r as RevisionP4 | null | undefined)?.combine_v;
  return v(mine) === COMBINE_V && v(theirs) === COMBINE_V;
}

export async function combineDelayMs(deviceId: string): Promise<number> {
  const span = LIMITS_P2.combineDelayMaxMs - LIMITS_P2.combineDelayMinMs + 1;
  return LIMITS_P2.combineDelayMinMs + (parseInt((await sha256Hex(String(deviceId ?? ""))).slice(0, 8), 16) % span);
}

// ── phase 4: fine-level combining (phase 4 contract §2.7) ───────────────────

/** A choice that is among the conflict's options, else undefined (§2.1.7). */
const validChoice = (c: FineConflict, v: FineChoice | undefined): FineChoice | undefined =>
  v !== undefined && c.options.includes(v) ? v : undefined;

/** The whole-section choice of a two-way comparison (§2.7.1 step 3). */
const twoWayConflict = (k: SectionName): FineConflict => ({
  id: `${k}:section`, section: k, kind: "section", reason: "twoWay", options: ["mine", "theirs"], items: [], more: 0,
});

interface ModuleOut { level: "whole" | "fine"; merge: FineMerge<unknown> }

/** The fine-level module of one "both" section, three-way (B set). Figure: `colIds` null in the plan. */
async function runModule(
  k: SectionName, B: NormalisedSide, M: NormalisedSide, T: NormalisedSide, keys: { mineKey: SideKey; theirsKey: SideKey },
  choices: FineChoices, colIds: readonly string[] | null,
): Promise<ModuleOut> {
  switch (k) {
    case "table": {
      const r = await mergeTable({
        base: B.sections.table as FileTable, mine: M.sections.table as FileTable, theirs: T.sections.table as FileTable,
        mineKey: keys.mineKey, theirsKey: keys.theirsKey,
      }, choices);
      return { level: r.whole ? "whole" : "fine", merge: r };
    }
    case "analysis":
      return {
        level: "fine",
        merge: mergeAnalysis({ base: B.sections.analysis as FileAnalysis, mine: M.sections.analysis as FileAnalysis, theirs: T.sections.analysis as FileAnalysis }, choices),
      };
    case "figure":
      return {
        level: "fine",
        merge: mergeFigure({
          base: B.sections.figure as FileFigure, mine: M.sections.figure as FileFigure, theirs: T.sections.figure as FileFigure, colIds,
        }, choices),
      };
    case "scratchpad": {
      const r = mergeScratch({ base: B.sections.scratchpad ?? null, mine: M.sections.scratchpad ?? null, theirs: T.sections.scratchpad ?? null }, choices);
      return { level: r.shift ? "whole" : "fine", merge: r };
    }
  }
}

export async function combineFine(input: {
  base: SectionValues | null; baseKind: BaseKind; mine: SectionValues; theirs: SectionValues;
  mineKey: SideKey; theirsKey: SideKey;
}): Promise<CombineOutcomeP4> {
  // 1. The sides through the one pipeline (as combine steps 1–2).
  const M = await normaliseSections(input.mine);
  if (!M) return { ok: false, reason: "unreadable", side: "mine" };
  const T = await normaliseSections(input.theirs);
  if (!T) return { ok: false, reason: "unreadable", side: "theirs" };
  const B = input.base && input.baseKind !== "none" ? await normaliseSections(input.base) : null;
  const baseKind: BaseKind = B ? input.baseKind : "none";
  const keys = { mineKey: { ...input.mineKey }, theirsKey: { ...input.theirsKey } };

  // 2.–3. Status by hashes; a "both" section is combined inside where it can be.
  const sections: CombineSectionP4[] = [];
  for (const key of SECTION_NAMES) {
    const m = hashOf(M, key), t = hashOf(T, key), b = B ? hashOf(B, key) : null;
    let status: SectionStatus;
    if (m === t) status = "same";
    else if (b !== null && t === b) status = "mine";
    else if (b !== null && m === b) status = "theirs";
    else status = "both";
    const pick: SidePick | null = status === "both" ? null : status === "theirs" ? "theirs" : "mine";
    const s: CombineSectionP4 = { key, status, pick, autoResolvable: true, level: "whole", conflicts: [], combined: 0, auto: [], orderChecks: [] };
    if (status === "both") {
      if (!B) s.conflicts = [twoWayConflict(key)];
      else {
        const out = await runModule(key, B, M, T, keys, {}, null);
        s.level = out.level;
        s.conflicts = out.merge.conflicts;
        s.combined = out.merge.combined;
        s.auto = out.merge.auto;
        s.orderChecks = out.merge.orderChecks;
        // Fixer round 2 (RV-1, RV-3): which rows are not the same row on both sides although they share an id.
        const notes = (out.merge as TableMerge).rowNotes;
        if (key === "table" && notes) s.rowNotes = notes;
      }
    }
    // 4.
    s.autoResolvable = s.conflicts.length === 0;
    sections.push(s);
  }
  const needsChoice = sections.some((s) => s.conflicts.length > 0);
  const plan: CombinePlanP4 = {
    ok: true, twoWay: !B, baseKind, sections, needsChoice, autoApplicable: false, result: null,
    mine: M, theirs: T, base: B, level: sections.some((s) => s.status === "both") ? "fine" : "section", mineKey: keys.mineKey, theirsKey: keys.theirsKey,
  };
  // 5.–6.
  if (!needsChoice) plan.result = await applyFineChoices(plan, {});
  const r = plan.result;
  plan.autoApplicable = baseKind === "lca" && !needsChoice && r !== null
    && r.repairs.length === 0 && r.adjustments.length === 0 && !r.orderChecks.some((o) => o.matters);
  return plan;
}

const PAIRED_TESTS = ["paired_t", "wilcoxon"];

export async function applyFineChoices(plan: CombinePlanP4, choices: CombineChoices): Promise<CombineResultP4 | null> {
  const fine: FineChoices = choices?.fine ?? {};
  const assembled = {} as SectionValues;
  /** Taken as a whole from this side (from = that side, as phase 2), else combined inside (from by hash). */
  const wholeFrom = {} as Record<SectionName, SidePick | null>;
  let tableIds: string[] | null = null;
  const moduleAdjust: FineAdjustment[] = [];
  const orderChecks: OrderCheck[] = [];
  const keys = { mineKey: plan.mineKey, theirsKey: plan.theirsKey };
  for (const k of SECTION_NAMES) {
    const s = plan.sections.find((x) => x.key === k)!;
    const sc = choices?.sections?.[k];
    if (sc === "mine" || sc === "theirs") {
      // 1. The whole section from that side, whatever its status or conflicts.
      assembled[k] = sectionValue(sc === "mine" ? plan.mine : plan.theirs, k);
      wholeFrom[k] = sc;
    } else if (s.status !== "both") {
      // 2.
      const side = s.pick ?? "mine";
      assembled[k] = sectionValue(side === "mine" ? plan.mine : plan.theirs, k);
      wholeFrom[k] = side;
    } else if (!plan.base || (s.level === "whole" && s.conflicts.length === 1 && s.conflicts[0].kind === "section")) {
      // 3. One whole choice (two-way, the table that can't be combined row by row, a rearranged scratchpad).
      const c = s.conflicts[0];
      const ch = c ? validChoice(c, fine[c.id]) : undefined;
      if (ch === "mine" || ch === "theirs") {
        assembled[k] = sectionValue(ch === "mine" ? plan.mine : plan.theirs, k);
        wholeFrom[k] = ch;
      } else if (ch === "both" && k === "scratchpad") {
        const both = sideBySide(plan.mine.sections.scratchpad ?? null, plan.theirs.sections.scratchpad ?? null);
        if (both === null) return null;
        assembled[k] = JSON.parse(canonicalJson(both));
        wholeFrom[k] = null;
      } else return null;
    } else {
      // 4. The module again with the choices (the figure follows the table decided in this call).
      const colIds = k === "figure" ? (tableIds ?? (assembled.table as FileTable | undefined)?.col_ids ?? null) : null;
      const out = await runModule(k, plan.base, plan.mine, plan.theirs, keys, fine, colIds);
      if (out.merge.value == null) return null;
      assembled[k] = out.merge.value;
      wholeFrom[k] = null;
      moduleAdjust.push(...out.merge.adjustments);
      orderChecks.push(...out.merge.orderChecks.map((o) => ({ ...o, ids: [...o.ids] })));
    }
    if (k === "table") {
      const ids = (assembled.table as FileTable | undefined)?.col_ids;
      tableIds = Array.isArray(ids) ? [...ids] : null;
    }
  }
  const re = await normaliseSections(assembled);
  if (!re) return null;
  const repairs: SectionName[] = [];
  const from = {} as Record<SectionName, SidePick | "same">;
  const mixed: SectionName[] = [];
  for (const s of plan.sections) {
    const k = s.key;
    const own = await sha256Hex(canonicalJson(assembled[k] === undefined ? null : assembled[k]));
    if (hashOf(re, k) !== own) repairs.push(k);
    if (s.status === "same") { from[k] = "same"; continue; }
    const w = wholeFrom[k];
    if (w) { from[k] = w; continue; }
    const h = hashOf(re, k);
    if (h === hashOf(plan.mine, k)) from[k] = "mine";
    else if (h === hashOf(plan.theirs, k)) from[k] = "theirs";
    else { from[k] = "mine"; mixed.push(k); }
  }
  // Rows both added in one place matter also for a paired test (§2.7.2).
  const paired = PAIRED_TESTS.includes(String(re.content.analysis.test));
  const checks = orderChecks.map((o) => (o.axis === "row" && paired ? { ...o, matters: true } : o));
  const adjustments = [
    ...moduleAdjust,
    ...detectAdjustments({ assembled, result: re, mine: plan.mine, theirs: plan.theirs }),
  ];
  return {
    content: re.content, sections: re.sections as FileSections4, parts: re.parts, from, repairs,
    adjustments, orderChecks: checks, mixed,
  };
}

({ normaliseSections, combine, applyChoices, combineRevision, combineDelayMs, combineFine, applyFineChoices, peersCombineAlike }) satisfies GraphMergeApiP4;

