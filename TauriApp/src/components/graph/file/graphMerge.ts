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
  LIMITS_P2, SUMMARY,
  type BaseKind, type CombineOutcome, type CombinePlan, type CombineResult, type CombineSection, type GraphMergeApi,
  type NormalisedSide, type RevisionP2, type SectionStatus, type SectionValues, type SidePick,
} from "./contract";
import { contentOfSections, mergeRevisionId, partsOf, sectionsOf, type Author, type FileSections4 } from "./docCodec";
import { SECTION_NAMES, sha256Hex, type Revision, type SectionName } from "./format";

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
  mine: Revision; theirs: Revision; result: CombineResult; auto: boolean; author?: Author; time?: number;
}): Promise<RevisionP2> {
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
  if (p.auto) {
    const ta = typeof p.mine.time === "string" ? p.mine.time : "";
    const tb = typeof p.theirs.time === "string" ? p.theirs.time : "";
    return {
      id, parents, time: ta > tb ? ta : tb,
      user_name: "", device_id: "", device_name: "", session_id: "", app_version: "",
      kind: "merge", summary: SUMMARY.combinedAuto, sections, content_hash: contentHash,
      auto: true, sections_from: sortedFrom,
    };
  }
  if (!p.author || typeof p.time !== "number") throw new Error("combineRevision: a chosen combine needs author and time");
  return {
    id, parents, time: new Date(p.time).toISOString(),
    user_name: p.author.user_name, device_id: p.author.device_id, device_name: p.author.device_name,
    session_id: p.author.session_id, app_version: p.author.app_version,
    kind: "merge", summary: SUMMARY.combinedChosen, sections, content_hash: contentHash,
    sections_from: sortedFrom,
  };
}

export async function combineDelayMs(deviceId: string): Promise<number> {
  const span = LIMITS_P2.combineDelayMaxMs - LIMITS_P2.combineDelayMinMs + 1;
  return LIMITS_P2.combineDelayMinMs + (parseInt((await sha256Hex(String(deviceId ?? ""))).slice(0, 8), 16) % span);
}

({ normaliseSections, combine, applyChoices, combineRevision, combineDelayMs }) satisfies GraphMergeApi;
