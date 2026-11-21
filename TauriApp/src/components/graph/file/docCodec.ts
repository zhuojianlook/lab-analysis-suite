/* Store content ⇄ file sections ⇄ GraphFileData (contract §4): the four
   section parts of a document, revisions and manifests, ids. Pure apart from
   hashing (WebCrypto) and random ids. Everything stored goes through
   canonicalJson, so the same content always gives the same parts. */

import type { GraphDoc } from "../../../api/graph";
import { openContent, type DocContent } from "../../../store/graphStore";
import type { DraftRecord } from "./backend";
import type { VersionInfo } from "./contract";
import {
  FEATURES, FORMAT, FORMAT_VERSION, SECTION_NAMES, canonicalJson, contentHash, isAncestorOrSelf, makePart, sha256Hex,
  type GraphFileData, type Manifest, type PartRef, type Revision, type RevisionKind, type SectionName,
} from "./format";
import { fromFileSections, toFileSections, type FileAnalysis, type FileFigure, type FileTable } from "./idMap";

export const APP_NAME = "Lab Analysis Suite";

/** The four sections in file form (the scratchpad as its parsed object, null = empty). */
export interface FileSections4 {
  table: FileTable;
  analysis: FileAnalysis;
  figure: FileFigure;
  scratchpad: unknown | null;
}

/** Who writes a revision. */
export interface Author {
  user_name: string;
  device_id: string;
  device_name: string;
  session_id: string;
  app_version: string;
  platform: string;
}

// ── ids ──────────────────────────────────────────────────────────────────────

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

/** 26-character ULID (Crockford base32, 48-bit time in ms + 80 random bits). */
export function ulid(now = Date.now()): string {
  let t = Math.max(0, Math.floor(now));
  let time = "";
  for (let i = 0; i < 10; i++) { time = CROCKFORD[t % 32] + time; t = Math.floor(t / 32); }
  const r = randomBytes(16);
  let rand = "";
  for (let i = 0; i < 16; i++) rand += CROCKFORD[r[i] % 32];
  return time + rand;
}

export const newRevisionId = (now?: number) => `r-${ulid(now)}`;
export const newAnalysisId = () => `a-${globalThis.crypto.randomUUID()}`;
export const newDocKey = () => `k-${globalThis.crypto.randomUUID()}`;

/** Id of a two-parent revision: the same on every computer for the same parents and content (contract §4.9). */
export async function mergeRevisionId(parents: string[], contentHashHex: string): Promise<string> {
  return `r-m-${(await sha256Hex([...parents].sort().join("\n") + "\n" + contentHashHex)).slice(0, 26)}`;
}

// ── content ⇄ sections ⇄ parts ──────────────────────────────────────────────

/** The file form of a document's content. */
export function sectionsOf(c: DocContent): FileSections4 {
  const s = toFileSections({ doc: c.doc, analysis: c.analysis, figure: c.figure });
  return { ...s, scratchpad: c.scratch ? (JSON.parse(c.scratch) as unknown) : null };
}

/** File form → content in the open form (the load pipeline included); null when it isn't a Graphs table. */
export function contentOfSections(sec: Record<string, unknown>): DocContent | null {
  const open = fromFileSections({ table: sec.table, analysis: sec.analysis, figure: sec.figure });
  if (!open) return null;
  return openContent({ doc: open.doc, analysis: open.analysis, figure: open.figure, scratch: sec.scratchpad ?? null });
}

/** What the content is after being written and read back: the store's baseline after a save (plan §19). */
export function roundTrip(c: DocContent): DocContent {
  const back = contentOfSections(JSON.parse(canonicalJson(sectionsOf(c))) as Record<string, unknown>);
  return back ?? c;
}

export interface BuiltParts {
  refs: Record<SectionName, PartRef>;
  /** "parts/<sha>.json" → text. */
  texts: Record<string, string>;
  contentHash: string;
}

export async function partsOf(sec: FileSections4): Promise<BuiltParts> {
  const refs = {} as Record<SectionName, PartRef>;
  const texts: Record<string, string> = {};
  for (const name of SECTION_NAMES) {
    const p = await makePart(sec[name]);
    refs[name] = p.ref;
    texts[p.ref.part] = p.text;
  }
  return { refs, texts, contentHash: await contentHash(refs) };
}

/** The sections of a revision stored in a file (parsed), or null when its snapshot is not in the file. */
export function revisionSections(file: GraphFileData, revId = file.manifest.head): Record<SectionName, unknown> | null {
  const rev = file.manifest.revisions.find((r) => r.id === revId);
  if (!rev?.sections) return null;
  const out = {} as Record<SectionName, unknown>;
  for (const name of SECTION_NAMES) {
    const text = file.parts[rev.sections[name].part];
    if (typeof text !== "string") return null;
    try { out[name] = JSON.parse(text); } catch { return null; }
  }
  return out;
}

/** A file's content (head unless another revision is named), or null. */
export function openFile(file: GraphFileData, revId?: string): DocContent | null {
  const sec = revisionSections(file, revId);
  return sec ? contentOfSections(sec) : null;
}

/** Template of the file's head content. */
export function templateOf(file: GraphFileData): GraphDoc["template"] | null {
  const t = file.manifest.template;
  return t === "column" || t === "grouped" || t === "xy" ? t : null;
}

// ── revisions and manifests ─────────────────────────────────────────────────

const SECTION_LABEL: Record<SectionName, string> = { table: "data", analysis: "analysis", figure: "graph", scratchpad: "scratchpad" };

/** Short description of what changed (stored; display only). */
export function summaryOf(prev: Record<SectionName, PartRef> | null | undefined, next: Record<SectionName, PartRef>): string {
  if (!prev) return "Saved.";
  const changed = SECTION_NAMES.filter((n) => prev[n]?.sha256 !== next[n].sha256).map((n) => SECTION_LABEL[n]);
  return changed.length ? `Changed ${changed.join(", ")}.` : "No changes.";
}

export function makeRevision(p: {
  id: string; parents: string[]; kind: RevisionKind; time: number; author: Author; summary: string; parts: BuiltParts;
}): Revision {
  return {
    id: p.id, parents: [...p.parents], time: new Date(p.time).toISOString(),
    user_name: p.author.user_name, device_id: p.author.device_id, device_name: p.author.device_name,
    session_id: p.author.session_id, app_version: p.author.app_version, kind: p.kind, summary: p.summary,
    sections: { ...p.parts.refs }, content_hash: p.parts.contentHash,
  };
}

/** A manifest for a new analysis with one root revision. */
export function newManifest(p: {
  analysisId: string; forkedFrom: Manifest["forked_from"]; time: number; author: Author; template: string; root: Revision;
}): Manifest {
  return {
    format: FORMAT, format_version: FORMAT_VERSION, min_reader_version: 1, features: FEATURES,
    app: { name: APP_NAME, version: p.author.app_version, platform: p.author.platform },
    analysis_id: p.analysisId, forked_from: p.forkedFrom,
    created: { time: new Date(p.time).toISOString(), user_name: p.author.user_name, device_id: p.author.device_id, device_name: p.author.device_name },
    template: p.template, head: p.root.id, revisions: [p.root], x: {},
  };
}

/** The manifest with `rev` added as the new head (this app's format numbers and name). */
export function withRevision(m: Manifest, rev: Revision, author: Author, template?: string): Manifest {
  return {
    ...m, format: FORMAT, format_version: FORMAT_VERSION, min_reader_version: 1, features: FEATURES,
    app: { name: APP_NAME, version: author.app_version, platform: author.platform },
    template: template ?? m.template,
    head: rev.id,
    revisions: [...m.revisions.filter((r) => r.id !== rev.id), rev],
    x: m.x ?? {},
  };
}

/** Both histories, by id; a stored snapshot (non-null sections) always wins. Head and the rest from `a`. */
export function unionManifests(a: Manifest, b: Manifest): Manifest {
  const byId = new Map<string, Revision>();
  const order: string[] = [];
  for (const r of [...a.revisions, ...b.revisions]) {
    const prev = byId.get(r.id);
    if (!prev) { byId.set(r.id, r); order.push(r.id); } else if (!prev.sections && r.sections) byId.set(r.id, r);
  }
  return { ...a, revisions: order.map((id) => byId.get(id)!) };
}

export const revisionOf = (m: Manifest, id: string | null | undefined): Revision | null =>
  (id ? m.revisions.find((r) => r.id === id) ?? null : null);

/** Who saved a revision and when, for banners. */
export function versionInfo(m: Manifest, id: string, myDeviceId: string | null): VersionInfo {
  const r = revisionOf(m, id);
  return {
    head: id, userName: r?.user_name ?? "", deviceName: r?.device_name ?? "", time: r?.time ?? "",
    mine: !!r && !!myDeviceId && r.device_id === myDeviceId,
  };
}

/** How `other`'s head relates to `mine`'s head: older / same / newer / diverged. */
export function relationOf(mine: Manifest, mineHead: string, other: Manifest, otherHead: string): "older" | "same" | "newer" | "diverged" {
  if (mineHead === otherHead) return "same";
  if (isAncestorOrSelf(mine, otherHead, mineHead) || isAncestorOrSelf(other, otherHead, mineHead)) return "older";
  if (isAncestorOrSelf(other, mineHead, otherHead) || isAncestorOrSelf(mine, mineHead, otherHead)) return "newer";
  return "diverged";
}

/** Strict ancestor in `m`. */
export const isStrictAncestor = (m: Pick<Manifest, "revisions">, ancestor: string, rev: string) =>
  ancestor !== rev && isAncestorOrSelf(m, ancestor, rev);

/** Every part a manifest references (revisions with stored snapshots). */
export function referencedParts(m: Manifest): Set<string> {
  const out = new Set<string>();
  for (const r of m.revisions) if (r.sections) for (const n of SECTION_NAMES) out.add(r.sections[n].part);
  return out;
}

/** Make every stored snapshot of `m` available from `have` (parts by name): a
 *  revision whose parts are nowhere is looked up with `fetch` (the journal), and
 *  when still missing its snapshot is marked as no longer stored (its metadata
 *  stays). The head is never dropped: null when its parts are missing. */
export async function completeParts(
  m: Manifest, have: Record<string, string>, fetch: (revisionId: string) => Promise<GraphFileData | null>,
): Promise<{ manifest: Manifest; parts: Record<string, string> } | null> {
  const parts: Record<string, string> = { ...have };
  const own = (k: string) => Object.prototype.hasOwnProperty.call(parts, k);
  const revisions: Revision[] = [];
  for (const r of m.revisions) {
    if (!r.sections) { revisions.push(r); continue; }
    const missing = () => SECTION_NAMES.some((n) => !own(r.sections![n].part));
    if (missing()) {
      const j = await fetch(r.id).catch(() => null);
      if (j) for (const n of SECTION_NAMES) {
        const k = r.sections[n].part;
        if (!own(k) && typeof j.parts[k] === "string") parts[k] = j.parts[k];
      }
    }
    if (missing()) {
      if (r.id === m.head) return null;
      revisions.push({ ...r, sections: null });
    } else revisions.push(r);
  }
  const manifest = { ...m, revisions };
  const used = referencedParts(manifest);
  return { manifest, parts: Object.fromEntries(Object.entries(parts).filter(([k]) => used.has(k))) };
}

/** A file as read, with every older version whose snapshot isn't (fully) in
 *  it marked as no longer stored (its entry — who, when — stays). A file can
 *  arrive like that (pruned, or damaged in transit); without this, the next
 *  save would name parts that exist nowhere and every save would fail. The
 *  head is never touched. */
export function withAbsentSnapshotsDropped(file: GraphFileData): GraphFileData {
  const own = (k: string) => Object.prototype.hasOwnProperty.call(file.parts, k) && typeof file.parts[k] === "string";
  let changed = false;
  const revisions = file.manifest.revisions.map((r) => {
    if (!r.sections || r.id === file.manifest.head) return r;
    if (SECTION_NAMES.every((n) => own(r.sections![n].part))) return r;
    changed = true;
    return { ...r, sections: null };
  });
  return changed ? { ...file, manifest: { ...file.manifest, revisions } } : file;
}

/** How many of the newest versions keep their full content in the file (plan §7.2, decision D4). */
export const SNAPSHOTS_KEPT = 20;

/** Which versions keep their full content (plan §7.2, the part phase 1 needs):
 *  the head; the newest `keep` versions; both parents of every combined
 *  version; every version whose next version was saved on another computer
 *  (where work passed between computers; kept with no time limit for now).
 *  Every other version keeps its entry (who, when) without its content, so a
 *  file doesn't grow with every save. Metadata is never removed. */
export function pruneSnapshots(m: Manifest, keep = SNAPSHOTS_KEPT): Manifest {
  if (m.revisions.filter((r) => r.sections).length <= keep) return m;
  const keepIds = new Set<string>([m.head]);
  for (const r of m.revisions.slice(-keep)) keepIds.add(r.id);
  const byId = new Map(m.revisions.map((r) => [r.id, r] as const));
  for (const r of m.revisions) {
    if (r.parents.length > 1) for (const p of r.parents) keepIds.add(p);
    for (const p of r.parents) {
      const pr = byId.get(p);
      if (pr && pr.device_id !== r.device_id) keepIds.add(p);
    }
  }
  let changed = false;
  const revisions = m.revisions.map((r) => {
    if (!r.sections || keepIds.has(r.id)) return r;
    changed = true;
    return { ...r, sections: null };
  });
  return changed ? { ...m, revisions } : m;
}

/** Parts of `parts` that `file` doesn't already hold. */
export function partsNotIn(parts: Record<string, string>, file: GraphFileData | null): Record<string, string> {
  if (!file) return { ...parts };
  return Object.fromEntries(Object.entries(parts).filter(([k]) => !Object.prototype.hasOwnProperty.call(file.parts, k)));
}

// ── drafts ──────────────────────────────────────────────────────────────────

export function draftOf(p: {
  docKey: string; analysisId: string | null; path: string | null; baseRevision: string | null; content: DocContent;
  savedAt: number; title?: string; template?: string;
}): DraftRecord {
  return {
    doc_key: p.docKey, analysis_id: p.analysisId, path: p.path, base_revision: p.baseRevision,
    sections: sectionsOf(p.content) as unknown as Record<string, unknown>,
    saved_at: new Date(p.savedAt).toISOString(),
    ...(p.title !== undefined ? { title: p.title } : {}),
    ...(p.template !== undefined ? { template: p.template } : {}),
  };
}

export const contentOfDraft = (d: DraftRecord): DocContent | null =>
  d && d.sections && typeof d.sections === "object" ? contentOfSections(d.sections) : null;

// ── whole files ─────────────────────────────────────────────────────────────

/** A complete new file for `content`: one root revision. */
export async function buildNewFile(p: {
  content: DocContent; analysisId: string; forkedFrom: Manifest["forked_from"]; time: number; author: Author;
  kind?: RevisionKind; summary?: string;
}): Promise<GraphFileData> {
  const parts = await partsOf(sectionsOf(p.content));
  const root = makeRevision({
    id: newRevisionId(p.time), parents: [], kind: p.kind ?? "save", time: p.time, author: p.author,
    summary: p.summary ?? "Saved.", parts,
  });
  const manifest = newManifest({ analysisId: p.analysisId, forkedFrom: p.forkedFrom, time: p.time, author: p.author, template: p.content.doc.template, root });
  return { manifest, parts: parts.texts };
}

/** `file` with one more revision on top of its head (another computer's save, an import). */
export async function buildNextFile(file: GraphFileData, content: DocContent, p: {
  time: number; author: Author; kind?: RevisionKind; summary?: string;
}): Promise<GraphFileData> {
  const parts = await partsOf(sectionsOf(content));
  const prev = revisionOf(file.manifest, file.manifest.head);
  const rev = makeRevision({
    id: newRevisionId(p.time), parents: [file.manifest.head], kind: p.kind ?? "save", time: p.time, author: p.author,
    summary: p.summary ?? summaryOf(prev?.sections, parts.refs), parts,
  });
  return { manifest: withRevision(file.manifest, rev, p.author, content.doc.template), parts: { ...file.parts, ...parts.texts } };
}

/** The file as it was at an earlier revision (cloud version history): its ancestors only. */
export function fileAt(file: GraphFileData, revId: string): GraphFileData | null {
  const m = file.manifest;
  if (!revisionOf(m, revId)?.sections) return null;
  const keep = m.revisions.filter((r) => isAncestorOrSelf(m, r.id, revId));
  const manifest: Manifest = { ...m, head: revId, revisions: keep };
  const used = referencedParts(manifest);
  return { manifest, parts: Object.fromEntries(Object.entries(file.parts).filter(([k]) => used.has(k))) };
}
