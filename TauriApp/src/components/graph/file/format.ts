/* Analysis files (.lag): names, constants and the manifest shape (plan §1).
   Types only plus small pure checks — reading and writing the ZIP container is
   done in Rust (phase 1); the TypeScript side sees a file as its manifest plus
   the JSON text of its section parts. */

/** File extension (decision D1), without the dot. */
export const GRAPH_EXT = "lag";
/** In-use note (beacon) extension. Not registered as a file association. */
export const PRESENCE_EXT = "laguse";
/** First token of the ZIP comment, independent of the extension. */
export const MAGIC = "LASGRAPH1";
export const MIME = "application/vnd.labanalysissuite.graph+zip";
export const FORMAT = "lasgraph";
export const FORMAT_VERSION = 1;
/** The newest format this build reads; a file whose min_reader_version is higher opens read-only. */
export const READER_VERSION = 1;
/** 1 = files; 2 = shows who is editing (beacons). */
export const FEATURES = 1;

export type SectionName = "table" | "analysis" | "figure" | "scratchpad";
export const SECTION_NAMES: readonly SectionName[] = ["table", "analysis", "figure", "scratchpad"];

/** A content-addressed section blob inside the file. */
export interface PartRef {
  /** "parts/<sha256>.json" */
  part: string;
  sha256: string;
  bytes: number;
}

export type RevisionKind = "save" | "merge" | "restore" | "import";

export interface Revision {
  /** "r-<ulid>" for saves, "r-m-<hash>" for combines. */
  id: string;
  /** 0 = root, 1 = save, 2 = combine. */
  parents: string[];
  /** Display only; never used to decide anything. */
  time: string;
  user_name: string;
  device_id: string;
  device_name: string;
  session_id: string;
  app_version: string;
  kind: RevisionKind;
  summary: string;
  /** null = the snapshot of this revision is no longer stored (metadata only). */
  sections: Record<SectionName, PartRef> | null;
  /** sha256 over the four section hashes. */
  content_hash: string;
}

export interface Manifest {
  format: typeof FORMAT;
  format_version: number;
  min_reader_version: number;
  features: number;
  app: { name: string; version: string; platform: string };
  /** "a-<uuidv4>"; shared by all copies of one analysis. */
  analysis_id: string;
  forked_from: { analysis_id: string; revision_id: string } | null;
  created: { time: string; user_name: string; device_id: string; device_name: string };
  template: string;
  head: string;
  revisions: Revision[];
  x: Record<string, unknown>;
}

/** A whole analysis file as TypeScript sees it: the manifest and each stored
 *  part's JSON text, keyed by its path ("parts/<sha>.json"). */
export interface GraphFileData {
  manifest: Manifest;
  parts: Record<string, string>;
}

/** What the ZIP comment says (a hint for cheap scans; never trusted alone for a save). */
export interface FileHeader {
  analysis_id: string;
  head: string;
}

export const headerOf = (f: GraphFileData): FileHeader => ({ analysis_id: f.manifest.analysis_id, head: f.manifest.head });

/** Structural check of a file (the Rust reader also verifies hashes): why it is
 *  not a usable analysis file, or null when it is. */
export function fileProblem(f: unknown): string | null {
  if (!f || typeof f !== "object") return "not a file";
  const { manifest: m, parts } = f as Partial<GraphFileData>;
  if (!m || typeof m !== "object" || m.format !== FORMAT) return "not an analysis file";
  if (!parts || typeof parts !== "object") return "no parts";
  if (typeof m.analysis_id !== "string" || !m.analysis_id) return "no analysis id";
  if (!Array.isArray(m.revisions)) return "no revisions";
  const head = m.revisions.find((r) => r && r.id === m.head);
  if (!head) return "head revision missing";
  if (!head.sections) return "head snapshot missing";
  for (const name of SECTION_NAMES) {
    const ref = head.sections[name];
    if (!ref || typeof parts[ref.part] !== "string") return `part missing: ${name}`;
  }
  return null;
}

/** Is `ancestor` the same as or an ancestor of `rev` in this manifest's history? */
export function isAncestorOrSelf(m: Pick<Manifest, "revisions">, ancestor: string, rev: string): boolean {
  const byId = new Map(m.revisions.map((r) => [r.id, r]));
  const seen = new Set<string>();
  const stack = [rev];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === ancestor) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const p of byId.get(id)?.parents ?? []) stack.push(p);
  }
  return false;
}

/** "Dose response.lag" → "Dose response"; "/a/b/x.lag" → "x". */
export function fileStem(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

export function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

// ── canonical form and hashes (plan §1.3) ────────────────────────────────────

/** Canonical JSON text: object keys sorted (by UTF-16 code unit), no
 *  whitespace, otherwise as JSON.stringify (undefined / functions left out of
 *  objects and written as null in arrays, non-finite numbers as null). The
 *  same content always gives the same text, whatever order its keys were set
 *  in, so section blobs and their hashes depend only on the content. */
export function canonicalJson(value: unknown): string {
  const out: string[] = [];
  const write = (v: unknown, inArray: boolean): boolean => {
    if (v === null) { out.push("null"); return true; }
    switch (typeof v) {
      case "string": out.push(JSON.stringify(v)); return true;
      case "number": out.push(Number.isFinite(v) ? JSON.stringify(v) : "null"); return true;
      case "boolean": out.push(v ? "true" : "false"); return true;
      case "bigint": throw new TypeError("canonicalJson: BigInt is not JSON");
      case "undefined": case "function": case "symbol":
        if (inArray) { out.push("null"); return true; }
        return false;
    }
    const obj = v as Record<string, unknown> & { toJSON?: () => unknown };
    if (typeof obj.toJSON === "function") return write(obj.toJSON(), inArray);
    if (Array.isArray(obj)) {
      out.push("[");
      obj.forEach((item, i) => { if (i) out.push(","); write(item, true); });
      out.push("]");
      return true;
    }
    out.push("{");
    let first = true;
    for (const k of Object.keys(obj).sort()) {
      const mark = out.length;
      if (!first) out.push(",");
      out.push(JSON.stringify(k), ":");
      if (write(obj[k], false)) first = false;
      else out.length = mark;            // value left out: drop its key too
    }
    out.push("}");
    return true;
  };
  if (!write(value, false)) throw new TypeError("canonicalJson: value has no JSON form");
  return out.join("");
}

/** Lowercase hex SHA-256 of a text's UTF-8 bytes (WebCrypto: browsers, the
 *  Tauri webview and Node ≥ 18). */
export async function sha256Hex(text: string): Promise<string> {
  const buf = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A section's stored blob: its canonical text and the reference to it. */
export async function makePart(section: unknown): Promise<{ ref: PartRef; text: string }> {
  const text = canonicalJson(section);
  const sha256 = await sha256Hex(text);
  return { text, ref: { part: `parts/${sha256}.json`, sha256, bytes: new TextEncoder().encode(text).length } };
}

/** content_hash of a revision: SHA-256 over the four section hashes in section order. */
export async function contentHash(sections: Record<SectionName, Pick<PartRef, "sha256">>): Promise<string> {
  return sha256Hex(SECTION_NAMES.map((n) => sections[n].sha256).join("\n"));
}
