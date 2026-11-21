// Cross-language golden fixtures (contract §9.3), TypeScript half.
//
// 1. Builds five save requests exactly as the controller would (canonical
//    manifest text, content-addressed parts) with fixed ids and times, and
//    checks they are reproducible. When LAS_P1_GOLDENS names a folder, writes
//    them to <folder>/ts/ (save-0N-*.json + expect.json).
// 2. When <folder>/rust/ exists (written by `cargo test goldens`), reads the
//    Rust results back: the manifest text and the parts come back byte for
//    byte, every part's name is the SHA-256 of its text, and the .lag file
//    has "mimetype" stored first and the expected ZIP comment.
import { describe, expect, it } from "vitest";
import type { GraphDoc } from "../../../api/graph";
import { openContent, type DocContent } from "../../../store/graphStore";
import { sampleDoc, setIdSource } from "../graphModel";
import type { SaveArgs } from "./contract";
import { makeRevision, newManifest, partsOf, sectionsOf, withRevision, type Author, type BuiltParts } from "./docCodec";
import { MIME, canonicalJson, sha256Hex, type Manifest } from "./format";

const AID = "a-00000000-0000-4000-8000-0000000000a1";
const AID_U = "a-00000000-0000-4000-8000-0000000000a4";
const AID_B = "a-00000000-0000-4000-8000-0000000000a5";
const rid = (n: number) => `r-01JDGQ${String(n).padStart(20, "0")}`;
const T = (n: number) => Date.UTC(2026, 10, 20, 9, n);
const AUTHOR: Author = {
  user_name: "Golden", device_id: "d-00000000-0000-4000-8000-0000000000d1", device_name: "Golden Mac",
  session_id: "s-00000000-0000-4000-8000-0000000000e1", app_version: "0.0.0-golden", platform: "macos",
};
const ORDER = ["save-01-new", "save-02-next", "save-03-stale", "save-04-unicode", "save-05-badhash"] as const;
type CaseName = (typeof ORDER)[number];

interface Expect {
  reply: { kind: string; head?: string } | null;
  error: string | null;
  comment: string | null;
  parts: Record<string, string> | null;
}

/** Contents with fixed row / column ids. */
function fixed<T>(fn: () => T): T {
  let n = 0;
  const prev = setIdSource((kind) => `${kind}-golden${String(++n).padStart(4, "0")}`);
  try { return fn(); } finally { setIdSource(prev); }
}

const withCell = (c: DocContent, v: string): DocContent => {
  const cells = c.doc.cells.map((row) => row.map((reps) => [...reps]));
  cells[0][0][0] = v;
  return { ...c, doc: { ...c.doc, cells } };
};

function req(name: string, p: { expectedHead: string | null; analysisId: string; manifest: Manifest; newParts: Record<string, string> }): SaveArgs {
  return {
    path: `$DIR/${name}.lag`, expectedHead: p.expectedHead, analysisId: p.analysisId, docKey: "k-00000000-0000-4000-8000-0000000000c1",
    manifestText: canonicalJson(p.manifest), newParts: p.newParts, replaceExisting: false,
  };
}

async function partHashes(texts: Record<string, string>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(texts).sort()) out[k] = await sha256Hex(texts[k]);
  return out;
}

const only = (p: BuiltParts, sections: string[]) =>
  Object.fromEntries(Object.entries(p.texts).filter(([k]) => sections.some((s) => p.refs[s as keyof BuiltParts["refs"]].part === k)));

async function build(): Promise<{ cases: Record<CaseName, { req: SaveArgs }>; expect: { order: readonly CaseName[]; cases: Record<CaseName, Expect> } }> {
  const c1 = fixed(() => openContent({ doc: sampleDoc("column") }));
  const p1 = await partsOf(sectionsOf(c1));
  const r1 = makeRevision({ id: rid(1), parents: [], kind: "save", time: T(1), author: AUTHOR, summary: "Saved.", parts: p1 });
  const m1 = newManifest({ analysisId: AID, forkedFrom: null, time: T(0), author: AUTHOR, template: "column", root: r1 });

  const c2 = withCell(c1, "9.99");
  const p2 = await partsOf(sectionsOf(c2));
  const r2 = makeRevision({ id: rid(2), parents: [rid(1)], kind: "save", time: T(2), author: AUTHOR, summary: "Changed data.", parts: p2 });
  const m2 = withRevision(m1, r2, AUTHOR, "column");

  const c3 = { ...c1, figure: { ...c1.figure, title: "stale" } };
  const p3 = await partsOf(sectionsOf(c3));
  const r3 = makeRevision({ id: rid(3), parents: [rid(1)], kind: "save", time: T(3), author: AUTHOR, summary: "Changed graph.", parts: p3 });
  const m3 = withRevision(m1, r3, AUTHOR, "column");

  const c4 = fixed(() => {
    const doc: GraphDoc = sampleDoc("column");
    return openContent({
      doc: { ...doc, col_titles: ["Größe µ", "试验 😀", 'He said "hi" \\ ok'], row_titles: doc.row_titles.map((t, i) => (i === 0 ? "line sep nbsp" : t)) },
      figure: { title: "Größe µ 试验 😀", y_min: 1e-7, ylabel: 'quote " and \\ backslash' },
      scratch: { v: 1, cells: [[1, 1, "Größe 😀"], [2, 1, "=A1&\"x\""]] },
    });
  });
  const p4 = await partsOf(sectionsOf(c4));
  const r4 = makeRevision({ id: rid(4), parents: [], kind: "save", time: T(4), author: { ...AUTHOR, user_name: "Zhuó 试验" }, summary: "Saved.", parts: p4 });
  const m4 = newManifest({ analysisId: AID_U, forkedFrom: null, time: T(4), author: AUTHOR, template: "column", root: r4 });

  const p5 = await partsOf(sectionsOf(withCell(c1, "bad")));
  const r5 = makeRevision({ id: rid(5), parents: [], kind: "save", time: T(5), author: AUTHOR, summary: "Saved.", parts: p5 });
  const m5 = newManifest({ analysisId: AID_B, forkedFrom: null, time: T(5), author: AUTHOR, template: "column", root: r5 });
  const bad = { ...p5.texts };
  bad[p5.refs.table.part] = `${bad[p5.refs.table.part]} `;      // text no longer matches the hash in its name

  const cases: Record<CaseName, { req: SaveArgs }> = {
    "save-01-new": { req: req("Dose response", { expectedHead: null, analysisId: AID, manifest: m1, newParts: p1.texts }) },
    "save-02-next": { req: req("Dose response", { expectedHead: rid(1), analysisId: AID, manifest: m2, newParts: only(p2, ["table"]) }) },
    "save-03-stale": { req: req("Dose response", { expectedHead: rid(1), analysisId: AID, manifest: m3, newParts: only(p3, ["figure"]) }) },
    "save-04-unicode": { req: req("Größe µ 试验 😀", { expectedHead: null, analysisId: AID_U, manifest: m4, newParts: p4.texts }) },
    "save-05-badhash": { req: req("Bad hash", { expectedHead: null, analysisId: AID_B, manifest: m5, newParts: bad }) },
  };
  const expectJson = {
    order: ORDER,
    cases: {
      "save-01-new": { reply: { kind: "saved", head: rid(1) }, error: null, comment: `LASGRAPH1 ${AID} ${rid(1)}`, parts: await partHashes(p1.texts) },
      "save-02-next": { reply: { kind: "saved", head: rid(2) }, error: null, comment: `LASGRAPH1 ${AID} ${rid(2)}`, parts: await partHashes({ ...p1.texts, ...p2.texts }) },
      "save-03-stale": { reply: { kind: "conflict", head: rid(2) }, error: null, comment: null, parts: null },
      "save-04-unicode": { reply: { kind: "saved", head: rid(4) }, error: null, comment: `LASGRAPH1 ${AID_U} ${rid(4)}`, parts: await partHashes(p4.texts) },
      "save-05-badhash": { reply: null, error: "Invalid", comment: null, parts: null },
    } satisfies Record<CaseName, Expect>,
  };
  return { cases, expect: expectJson };
}

// node:fs / node:zlib, loaded only in this test (no @types/node in the project).
type Fs = { mkdirSync(p: string, o: { recursive: boolean }): void; writeFileSync(p: string, d: string): void; readFileSync(p: string, e?: string): Uint8Array & string; existsSync(p: string): boolean };
type Zlib = { inflateRawSync(b: Uint8Array): Uint8Array };
const nodeMod = async <M>(name: string): Promise<M> => (await import(/* @vite-ignore */ name)) as M;
const goldenDir = (): string | null => (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.LAS_P1_GOLDENS ?? null;

/** The ZIP's comment and entries in central-directory order (name, method, data). */
function readZip(buf: Uint8Array, zlib: Zlib): { comment: string; entries: { name: string; method: number; data: Uint8Array }[] } {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("no end of central directory");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const commentLen = dv.getUint16(eocd + 20, true);
  const dec = new TextDecoder();
  const comment = dec.decode(buf.subarray(eocd + 22, eocd + 22 + commentLen));
  const entries: { name: string; method: number; data: Uint8Array }[] = [];
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("bad central directory");
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), cLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    if (dv.getUint32(local, true) !== 0x04034b50) throw new Error("bad local header");
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const raw = buf.subarray(start, start + csize);
    entries.push({ name, method, data: method === 0 ? raw : zlib.inflateRawSync(raw) });
    p += 46 + nameLen + extraLen + cLen;
  }
  return { comment, entries };
}

describe("cross-language goldens (TypeScript half)", () => {
  it("the save requests are reproducible and self-consistent", async () => {
    const a = await build();
    const b = await build();
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    for (const name of ORDER) {
      const r = a.cases[name].req;
      expect(JSON.parse(r.manifestText)).toBeTruthy();
      expect(canonicalJson(JSON.parse(r.manifestText))).toBe(r.manifestText);
      for (const [k, text] of Object.entries(r.newParts)) {
        const ok = k === `parts/${await sha256Hex(text)}.json`;
        expect(ok).toBe(name !== "save-05-badhash" || !text.endsWith(" "));
      }
    }
    expect(Object.keys(a.cases["save-02-next"].req.newParts)).toHaveLength(1);
    expect(a.cases["save-04-unicode"].req.manifestText).toContain("Zhuó 试验");
    const allText = Object.values(a.cases["save-04-unicode"].req.newParts).join("");
    for (const s of ["Größe µ", "😀", " ", " ", '\\"hi\\"', "1e-7"]) expect(allText).toContain(s);
    const dir = goldenDir();
    if (!dir) return;
    const fs = await nodeMod<Fs>("node:fs");
    fs.mkdirSync(`${dir}/ts`, { recursive: true });
    for (const name of ORDER) fs.writeFileSync(`${dir}/ts/${name}.json`, JSON.stringify(a.cases[name], null, 2));
    fs.writeFileSync(`${dir}/ts/expect.json`, JSON.stringify(a.expect, null, 2));
  });

  it("reads the Rust results back when they exist", async () => {
    const dir = goldenDir();
    const fs = dir ? await nodeMod<Fs>("node:fs") : null;
    if (!dir || !fs || !fs.existsSync(`${dir}/rust`)) {
      console.log("[goldens] rust/ results absent: read-back skipped (the integrator runs TS write → cargo test → TS read)");
      return;
    }
    const zlib = await nodeMod<Zlib>("node:zlib");
    const { cases, expect: ex } = await build();
    for (const name of ["save-01-new", "save-02-next", "save-04-unicode"] as const) {
      const sent = cases[name].req;
      const read = JSON.parse(fs.readFileSync(`${dir}/rust/${name}.read.json`, "utf8")) as { manifestText: string; parts: Record<string, string> };
      expect(read.manifestText).toBe(sent.manifestText);
      const want = ex.cases[name].parts!;
      expect(Object.keys(read.parts).sort()).toEqual(Object.keys(want).sort());
      for (const [k, text] of Object.entries(read.parts)) {
        expect(k).toBe(`parts/${await sha256Hex(text)}.json`);
        if (Object.prototype.hasOwnProperty.call(sent.newParts, k)) expect(text).toBe(sent.newParts[k]);
      }
      const reply = JSON.parse(fs.readFileSync(`${dir}/rust/${name}.reply.json`, "utf8")) as { kind?: string; head?: string };
      expect(reply).toMatchObject(ex.cases[name].reply!);
      const zip = readZip(fs.readFileSync(`${dir}/rust/${name}.lag`) as Uint8Array, zlib);
      expect(zip.comment).toBe(ex.cases[name].comment);
      expect(zip.entries[0].name).toBe("mimetype");
      expect(zip.entries[0].method).toBe(0);
      expect(new TextDecoder().decode(zip.entries[0].data)).toBe(MIME);
      expect(zip.entries[1].name).toBe("manifest.json");
      expect(new TextDecoder().decode(zip.entries[1].data)).toBe(sent.manifestText);
    }
    // 02 kept 01's parts byte for byte.
    const r01 = JSON.parse(fs.readFileSync(`${dir}/rust/save-01-new.read.json`, "utf8")) as { parts: Record<string, string> };
    const r02 = JSON.parse(fs.readFileSync(`${dir}/rust/save-02-next.read.json`, "utf8")) as { parts: Record<string, string> };
    for (const [k, t] of Object.entries(r01.parts)) expect(r02.parts[k]).toBe(t);
    for (const name of ["save-03-stale", "save-05-badhash"] as const) {
      const reply = JSON.parse(fs.readFileSync(`${dir}/rust/${name}.reply.json`, "utf8")) as { kind?: string; head?: string; error?: { kind: string } };
      if (ex.cases[name].error) expect(reply.error?.kind).toBe(ex.cases[name].error);
      else expect(reply).toMatchObject(ex.cases[name].reply!);
    }
  });
});
