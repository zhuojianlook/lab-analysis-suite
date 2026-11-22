import { describe, expect, it } from "vitest";
import type { FileEvent, SaveRequest } from "./backend";
import { fileProblem, isAncestorOrSelf, type GraphFileData, type Revision, type SectionName } from "./format";
import { MISSING_CONFIRM_MS, ManualClock, MemoryWorld, type ConflictMode } from "./memoryBackend";

const DIR = "/Dropbox/Lab";
const P = `${DIR}/Dose response.lag`;
const AID = "a-11111111-1111-4111-8111-111111111111";

/** A small valid file: `revs` = [id, parents][] in order, head = last. */
function makeFile(revs: [string, string[]][], aid = AID, minReader = 1): GraphFileData {
  const parts: Record<string, string> = {};
  const revisions: Revision[] = revs.map(([id, parents]) => {
    const sections = {} as Record<SectionName, { part: string; sha256: string; bytes: number }>;
    for (const name of ["table", "analysis", "figure", "scratchpad"] as SectionName[]) {
      const text = JSON.stringify({ name, id });
      const sha = `${name}-${id}`;
      parts[`parts/${sha}.json`] = text;
      sections[name] = { part: `parts/${sha}.json`, sha256: sha, bytes: text.length };
    }
    return {
      id, parents, time: "2026-01-01T00:00:00Z", user_name: "u", device_id: "d-x", device_name: "x", session_id: "s",
      app_version: "0", kind: "save", summary: "", sections, content_hash: `h-${id}`,
    };
  });
  return {
    manifest: {
      format: "lasgraph", format_version: 1, min_reader_version: minReader, features: 1,
      app: { name: "Lab Analysis Suite", version: "0", platform: "test" }, analysis_id: aid, forked_from: null,
      created: { time: "2026-01-01T00:00:00Z", user_name: "u", device_id: "d-x", device_name: "x" },
      template: "column", head: revs[revs.length - 1][0], revisions, x: {},
    },
    parts,
  };
}

/** A save of a whole file (every part sent as new). */
function req(path: string, expectedHead: string | null, file: GraphFileData, docKey = "k"): SaveRequest {
  return { path, expectedHead, analysisId: file.manifest.analysis_id, docKey, manifest: file.manifest, newParts: file.parts };
}

/** Only the parts of `file`'s head revision that `prev` doesn't have. */
function onlyNewParts(file: GraphFileData, prev: GraphFileData): Record<string, string> {
  return Object.fromEntries(Object.entries(file.parts).filter(([k]) => !(k in prev.parts)));
}

const ids = (js: { revision_id: string }[]) => js.map((j) => j.revision_id);

function world(mode: ConflictMode = "dropbox", delays = { up: 1000, down: 2000 }) {
  const w = new MemoryWorld({ mode, clock: new ManualClock() });
  const a = w.addDevice({ device_id: "d-a", device_name: "Mac mini", uploadDelayMs: delays.up, downloadDelayMs: delays.down });
  const b = w.addDevice({ device_id: "d-b", device_name: "MacBook", uploadDelayMs: delays.up, downloadDelayMs: delays.down });
  return { w, a, b };
}

const r1 = makeFile([["r-1", []]]);
const r2 = makeFile([["r-1", []], ["r-2", ["r-1"]]]);
const r2b = makeFile([["r-1", []], ["r-2b", ["r-1"]]]);

describe("format helpers", () => {
  it("validates files and walks history", () => {
    expect(fileProblem(r2)).toBeNull();
    expect(fileProblem({})).not.toBeNull();
    const broken = makeFile([["r-1", []]]);
    broken.parts = {};
    expect(fileProblem(broken)).toMatch(/part missing/);
    expect(isAncestorOrSelf(r2.manifest, "r-1", "r-2")).toBe(true);
    expect(isAncestorOrSelf(r2.manifest, "r-2", "r-1")).toBe(false);
  });
});

describe("one computer", () => {
  it("save, read, header, scan, journal", async () => {
    const { a } = world();
    expect((await a.read(P)).ok).toBe(false);
    const s1 = await a.save(req(P, null, r1));
    expect(s1).toMatchObject({ ok: true, kind: "saved", head: "r-1" });
    const read = await a.read(P);
    expect(read.ok && read.file.manifest.head).toBe("r-1");
    const hdr = await a.header(P);
    expect(hdr.ok && hdr.header).toEqual({ analysis_id: AID, head: "r-1" });
    const scan = await a.scanDir(DIR);
    expect(scan.ok && scan.entries.map((e) => [e.name, e.kind, e.header?.head])).toEqual([["Dose response.lag", "graph", "r-1"]]);
    expect(await a.save(req(P, null, r2))).toEqual({ ok: false, kind: "conflict", head: "r-1" });
    expect(await a.save(req(P, "r-0", r2))).toEqual({ ok: false, kind: "conflict", head: "r-1" });
    expect(await a.save(req(P, "r-1", r2))).toMatchObject({ ok: true, kind: "saved", head: "r-2" });
    const heads = await a.journalHeads(AID, P);
    expect(ids(heads)).toEqual(["r-1", "r-2"]);
    expect(heads.map((j) => j.confirmed)).toEqual([true, false]);   // r-2 on disk descends from r-1
    expect((await a.readJournal(AID, "r-1"))?.manifest.head).toBe("r-1");
    expect(await a.readJournal(AID, "r-x")).toBeNull();
  });

  it("refuses invalid files, reports missing, too-new and placeholder files", async () => {
    const { a } = world();
    const bad = makeFile([["r-1", []]]);
    bad.parts = {};
    expect(await a.save(req(P, null, bad))).toMatchObject({ ok: false, kind: "error", code: "Invalid" });
    expect(await a.save(req(P, "r-1", r2))).toEqual({ ok: false, kind: "missing" });
    await a.save(req(`${DIR}/new.lag`, null, makeFile([["r-9", []]], AID, 99)));
    expect(await a.read(`${DIR}/new.lag`)).toMatchObject({ ok: true, readOnly: "tooNew" });
    expect(await a.read(P)).toMatchObject({ ok: false, code: "NotFound" });
    await a.save(req(P, null, r1));
    a.makeDataless(P);
    expect(await a.read(P)).toMatchObject({ ok: false, code: "Dataless" });
    const aside = await a.save(req(P, "r-1", r2));
    expect(aside).toMatchObject({ ok: true, kind: "savedAside", path: `${DIR}/Dose response (unsynced from Mac mini).lag` });
    a.hydrate(P);
    expect((await a.read(P)).ok).toBe(true);
  });

  it("reports a save that replaced another head than the one checked", async () => {
    const { a } = world();
    await a.save(req(P, null, r1));
    a.armDisplace(P, r2b);
    const res = await a.save(req(P, "r-1", r2));
    expect(res).toMatchObject({ ok: true, kind: "savedButDisplaced", displacedHead: "r-2b" });
    expect(ids(await a.journalHeads(AID))).toContain("r-2b");
    const displaced = await a.listDisplaced();
    expect(displaced).toMatchObject([{ original: P, head: "r-2b", reason: "replaced", analysis_id: AID }]);
    expect((await a.readDisplaced(displaced[0].id))?.manifest.head).toBe("r-2b");
  });

  it("sessions, drafts and identity are per computer", async () => {
    const { a, b } = world();
    await a.writeSession({ v: 1, tabs: [{ doc_key: "k1", analysis_id: AID, path: P, base_revision: "r-1", accepted_head: null, active: true }] });
    await a.writeDraft({ doc_key: "k1", analysis_id: AID, path: P, base_revision: "r-1", sections: { table: {} }, saved_at: "x" });
    expect((await a.readSession()).tabs).toHaveLength(1);
    expect((await b.readSession()).tabs).toHaveLength(0);
    expect(await a.readDraft("k1")).toMatchObject({ base_revision: "r-1" });
    expect(await b.readDraft("k1")).toBeNull();
    expect(await a.listDrafts()).toHaveLength(1);
    await a.deleteDraft("k1");
    expect(await a.listDrafts()).toHaveLength(0);
    expect((await a.device()).device_name).toBe("Mac mini");
    expect((await b.device()).device_id).toBe("d-b");
  });
});

describe("two computers", () => {
  it("a save arrives on the other computer after the sync delay, with an event", async () => {
    const { w, a, b } = world();
    await a.save(req(P, null, r1));
    w.clock.advance(3000);
    expect(b.localHead(P)).toBe("r-1");
    const events: FileEvent[] = [];
    b.track(P, { active: true });
    b.subscribe((e) => events.push(e));
    await a.save(req(P, "r-1", r2));
    w.clock.advance(2999);
    expect(b.localHead(P)).toBe("r-1");
    w.clock.advance(1);
    expect(b.localHead(P)).toBe("r-2");
    expect(events).toEqual([{ type: "changed", path: P, head: "r-2" }]);
  });

  it("dropbox: two saves on the same version → the later one becomes a conflicted copy everywhere; nothing is lost", async () => {
    const { w, a, b } = world("dropbox");
    await a.save(req(P, null, r1));
    w.clock.settle();
    b.track(P);
    await a.save(req(P, "r-1", r2));
    w.clock.advance(500);
    await b.save(req(P, "r-1", r2b));
    w.clock.settle();
    const copies = w.cloudPaths();
    expect(copies).toHaveLength(2);
    expect(w.cloudHead(P)).toBe("r-2");
    const copy = copies.find((p) => p !== P)!;
    expect(copy).toMatch(/Dose response \(MacBook's conflicted copy \d{4}-\d\d-\d\d\)\.lag$/);
    expect(w.cloudHead(copy)).toBe("r-2b");
    for (const d of [a, b]) {
      expect(d.localHead(P)).toBe("r-2");
      expect(d.localHead(copy)).toBe("r-2b");
    }
    expect(b.events).toContainEqual({ type: "sibling", path: P, sibling: copy, header: { analysis_id: AID, head: "r-2b" } });
    expect(b.events).toContainEqual({ type: "changed", path: P, head: "r-2" });
  });

  it("onedrive naming", async () => {
    const { w, a, b } = world("onedrive");
    await a.save(req(P, null, r1));
    w.clock.settle();
    await a.save(req(P, "r-1", r2));
    await b.save(req(P, "r-1", r2b));
    w.clock.settle();
    expect(w.cloudPaths()).toEqual([`${DIR}/Dose response-MacBook.lag`, P]);
  });

  it("last writer wins: the service silently keeps one save; the other survives only in its computer's journal", async () => {
    const { w, a, b } = world("lww");
    await a.save(req(P, null, r1));
    w.clock.settle();
    await a.save(req(P, "r-1", r2));
    w.clock.advance(500);
    await b.save(req(P, "r-1", r2b));
    w.clock.settle();
    expect(w.cloudPaths()).toEqual([P]);
    expect(w.cloudHead(P)).toBe("r-2b");
    expect(a.localHead(P)).toBe("r-2b");
    expect(ids(await a.journalHeads(AID))).toContain("r-2");
  });

  it("offline: saves stay local until the computer is back online", async () => {
    const { w, a, b } = world();
    await a.save(req(P, null, r1));
    w.clock.settle();
    b.setOnline(false);
    await a.save(req(P, "r-1", r2));
    w.clock.settle();
    expect(b.localHead(P)).toBe("r-1");
    b.setOnline(true);
    w.clock.settle();
    expect(b.localHead(P)).toBe("r-2");
    a.setOnline(false);
    await a.save(req(P, "r-2", makeFile([["r-1", []], ["r-2", ["r-1"]], ["r-3", ["r-2"]]])));
    w.clock.settle();
    expect(w.cloudHead(P)).toBe("r-2");
    a.setOnline(true);
    w.clock.settle();
    expect(w.cloudHead(P)).toBe("r-3");
    expect(b.localHead(P)).toBe("r-3");
  });

  it("a partially delivered file reads as Incomplete, then completes", async () => {
    const w = new MemoryWorld({ clock: new ManualClock() });
    const a = w.addDevice({ device_id: "d-a", device_name: "A" });
    const b = w.addDevice({ device_id: "d-b", device_name: "B", downloadDelayMs: 100, partialDeliveryMs: 400 });
    await a.save(req(P, null, r1));
    w.clock.advance(150);
    expect(await b.read(P)).toMatchObject({ ok: false, code: "Incomplete" });
    expect(await b.save(req(P, "r-1", r2))).toMatchObject({ ok: true, kind: "savedAside" });
    w.clock.advance(400);
    expect((await b.read(P)).ok).toBe(true);
  });

  it("a deletion reaches the other computer as 'missing' only after the confirm delay", async () => {
    const { w, a, b } = world();
    await a.save(req(P, null, r1));
    w.clock.settle();
    b.track(P);
    a.remove(P);
    w.clock.advance(3000);                       // the deletion is on b
    expect(b.localHead(P)).toBeNull();
    expect(b.events).toEqual([]);
    w.clock.advance(MISSING_CONFIRM_MS);
    expect(b.events).toEqual([{ type: "missing", path: P, candidates: [] }]);
    expect(await b.save(req(P, "r-1", r2))).toEqual({ ok: false, kind: "missing" });
  });

  it("a rename that syncs as delete then create is followed (moved), on both computers", async () => {
    const { w, a, b } = world();
    await a.save(req(P, null, r1));
    w.clock.settle();
    a.track(P);
    b.track(P);
    const to = `${DIR}/Dose response v2.lag`;
    a.rename(P, to, 0);
    w.clock.settle();
    expect(a.events).toContainEqual({ type: "moved", from: P, to, head: "r-1" });
    expect(b.events).toContainEqual({ type: "moved", from: P, to, head: "r-1" });
    expect(b.events.some((e) => e.type === "missing")).toBe(false);
    expect(b.trackedPaths()).toEqual([to]);
    expect(w.cloudPaths()).toEqual([to]);
  });

  it("a rename whose new name arrives late: missing first, followed when it arrives", async () => {
    const { w, a, b } = world();
    await a.save(req(P, null, r1));
    w.clock.settle();
    b.track(P);
    const to = `${DIR}/Dose response v2.lag`;
    a.rename(P, to, 20_000);
    w.clock.advance(3000 + MISSING_CONFIRM_MS);
    expect(b.events).toEqual([{ type: "missing", path: P, candidates: [] }]);
    w.clock.settle();
    expect(b.events).toEqual([{ type: "missing", path: P, candidates: [] }, { type: "moved", from: P, to, head: "r-1" }]);
  });

  it("a save to a path renamed away goes to the file it was renamed to", async () => {
    const { w, a } = world();
    await a.save(req(P, null, r1));
    const to = `${DIR}/Dose response v2.lag`;
    a.rename(P, to);
    const res = await a.save(req(P, "r-1", r2));
    expect(res).toMatchObject({ ok: true, kind: "saved", path: to, head: "r-2" });
    expect(a.localHead(to)).toBe("r-2");
    expect(a.localHead(P)).toBeNull();
    w.clock.settle();
  });

  it("never follows to a copy seen beside the file, or when there are two candidates", async () => {
    const { w, a } = world();
    await a.save(req(P, null, r1));
    a.track(P);
    const copy = `${DIR}/Dose response copy.lag`;
    a.duplicate(P, copy);
    a.remove(P);
    w.clock.settle();
    expect(a.events.filter((e) => e.type !== "sibling")).toEqual([{ type: "missing", path: P, candidates: [copy] }]);
    expect(await a.save(req(P, "r-1", r2))).toEqual({ ok: false, kind: "missing" });

    const Q = `${DIR}/Other.lag`;
    const q1 = makeFile([["q-1", []]], "a-2");
    await a.save(req(Q, null, q1));
    a.track(Q);
    a.remove(Q);
    await a.save(req(`${DIR}/Other x.lag`, null, q1));
    await a.save(req(`${DIR}/Other y.lag`, null, q1));
    w.clock.settle();
    expect(a.events).toContainEqual({ type: "missing", path: Q, candidates: [`${DIR}/Other x.lag`, `${DIR}/Other y.lag`] });
  });

  it("never follows to an older or diverged version", async () => {
    const { w, a } = world();
    await a.save(req(P, null, r2));
    a.track(P);
    a.remove(P);
    await a.save(req(`${DIR}/Old.lag`, null, r2b));   // same id, diverged from r-2
    w.clock.settle();
    expect(a.events).toEqual([{ type: "missing", path: P, candidates: [`${DIR}/Old.lag`] }]);
  });

  it("a sync client's delete-then-create of the same path is not reported missing", async () => {
    const { w, a, b } = world();
    await a.save(req(P, null, r1));
    w.clock.settle();
    b.track(P);
    a.remove(P);
    w.clock.advance(3000);                       // deletion reached b
    await a.save(req(P, null, r2));              // recreated (as a sync client applies an update)
    w.clock.settle();
    expect(b.events).toEqual([{ type: "changed", path: P, head: "r-2" }]);
  });

  it("a deletion loses against a newer version from the other computer", async () => {
    const { w, a, b } = world();
    await a.save(req(P, null, r1));
    w.clock.settle();
    await a.save(req(P, "r-1", r2));
    w.clock.advance(1000);           // uploaded, not yet on b
    b.remove(P);
    w.clock.settle();
    expect(w.cloudHead(P)).toBe("r-2");
    expect(b.localHead(P)).toBe("r-2");
  });

  it("a Finder duplicate is a second file with the same analysis id (sibling event)", async () => {
    const { w, a } = world();
    await a.save(req(P, null, r1));
    a.track(P);
    a.duplicate(P, `${DIR}/Dose response copy.lag`);
    w.clock.settle();
    expect(a.events).toContainEqual({ type: "sibling", path: P, sibling: `${DIR}/Dose response copy.lag`, header: { analysis_id: AID, head: "r-1" } });
  });
});

describe("save details (plan §7)", () => {
  it("sends only new parts; kept parts are copied from the file being replaced", async () => {
    const { a } = world();
    await a.save(req(P, null, r1));
    const res = await a.save({ ...req(P, "r-1", r2), newParts: onlyNewParts(r2, r1) });
    expect(res).toMatchObject({ ok: true, kind: "saved", head: "r-2" });
    const read = await a.read(P);
    expect(read.ok && read.file.parts).toEqual(r2.parts);
  });

  it("kept parts come from the journal when the file is a placeholder (saved aside)", async () => {
    const { a } = world();
    await a.save(req(P, null, r1));
    a.makeDataless(P);
    const res = await a.save({ ...req(P, "r-1", r2), newParts: onlyNewParts(r2, r1) });
    expect(res).toMatchObject({ ok: true, kind: "savedAside" });
    const aside = await a.read((res as { path: string }).path);
    expect(aside.ok && aside.file.parts).toEqual(r2.parts);
  });

  it("a part found nowhere fails the save; parts no revision references are dropped", async () => {
    const { a } = world();
    expect(await a.save({ ...req(P, null, r2), newParts: onlyNewParts(r2, r1) })).toMatchObject({ ok: false, kind: "error", code: "Invalid" });
    expect(a.localHead(P)).toBeNull();
    await a.save({ ...req(P, null, r1), newParts: { ...r1.parts, "parts/stray.json": "{}" } });
    const read = await a.read(P);
    expect(read.ok && Object.keys(read.file.parts).sort()).toEqual(Object.keys(r1.parts).sort());
  });

  it("refuses a save whose identity doesn't match (§7 step 2)", async () => {
    const { a } = world();
    await a.save(req(P, null, r1, "k1"));
    expect(await a.save({ ...req(P, "r-1", r2), analysisId: "a-other" })).toMatchObject({ ok: false, code: "IdentityMismatch" });
    const other = makeFile([["r-1", []], ["r-2", ["r-1"]]], "a-other");
    expect(await a.save(req(P, "r-1", other))).toMatchObject({ ok: false, code: "IdentityMismatch" });
    await a.writeSession({ v: 1, tabs: [{ doc_key: "k1", analysis_id: AID, path: P, base_revision: "r-1", accepted_head: null, active: true }] });
    expect(await a.save(req(P, "r-1", r2, "k2"))).toMatchObject({ ok: false, code: "IdentityMismatch" });
    expect(await a.save(req(P, "r-1", r2, "k1"))).toMatchObject({ ok: true, kind: "saved" });
  });

  it("never overwrites a file made by a newer version", async () => {
    const { a } = world();
    await a.save(req(P, null, makeFile([["r-1", []]], AID, 99)));
    expect(await a.save(req(P, "r-1", r2))).toMatchObject({ ok: false, code: "TooNew" });
  });

  it("journals a working copy that isn't on disk; confirms heads only at their own path", async () => {
    const { a } = world();
    await a.save(req(P, null, r1));
    await a.writeJournal(P, r2b);
    expect((await a.readJournal(AID, "r-2b"))?.manifest.head).toBe("r-2b");
    const Q = `${DIR}/Elsewhere.lag`;
    await a.save(req(Q, null, r2));
    expect((await a.journalHeads(AID, P)).map((j) => [j.revision_id, j.confirmed])).toEqual([["r-1", false], ["r-2b", false]]);
    expect((await a.journalHeads(AID, Q)).map((j) => [j.revision_id, j.confirmed])).toEqual([["r-2", false]]);
    await expect(a.writeJournal(P, { ...r1, parts: {} })).rejects.toThrow(/part missing/);
  });

  it("Recent is keyed by path and capped; the export map round-trips", async () => {
    const { a } = world();
    const e = (i: number, path = `${DIR}/${i}.lag`) => ({ path, analysis_id: null, opened_at: `t${i}` });
    await a.writeRecent([e(0, P), e(1, P), ...Array.from({ length: 60 }, (_, i) => e(i + 2))]);
    const recent = await a.readRecent();
    expect(recent).toHaveLength(50);
    expect(recent[0]).toEqual(e(0, P));
    expect(recent.filter((r) => r.path === P)).toHaveLength(1);
    expect(await a.readExportMap()).toEqual({ v: 1, rows: {} });
    const m = { v: 1 as const, rows: { "7": { saved_at: "x", analysis_id: AID, path: P, status: "done" as const, row_ids: ["row-aaaa"], col_ids: ["col-aaaa"] } } };
    await a.writeExportMap(m);
    expect(await a.readExportMap()).toEqual(m);
  });
});

describe("phase 2 (§4 on the simulated disk)", () => {
  const C = `${DIR}/Dose response (old copy).lag`;

  it("peek: the manifest without parts, never journals", async () => {
    const { a } = world();
    await a.save(req(P, null, r2));
    const before = (await a.journalHeads(AID)).length;
    const pk = await a.peek(P);
    expect(pk.ok && pk.manifest).toEqual(r2.manifest);
    expect(pk.ok && "parts" in pk).toBe(false);
    expect((await a.journalHeads(AID)).length).toBe(before);
    expect(await a.peek(`${DIR}/none.lag`)).toMatchObject({ ok: false, code: "NotFound" });
  });

  it("removeCopy: moves an older or equal copy aside, refuses everything else; entries expire after 30 days", async () => {
    const { w, a } = world();
    await a.save(req(P, null, r2));
    a.place(C, r1);
    const r = await a.removeCopy({ path: C, keeper: P, analysisId: AID });
    expect(r).toMatchObject({ ok: true, kind: "removed", head: "r-1" });
    expect(a.localPaths()).toEqual([P]);
    expect((await a.listDisplaced()).find((x) => x.original === C)).toMatchObject({ reason: "removedCopy", head: "r-1", analysis_id: AID });
    expect(a.removedCopies()).toHaveLength(1);
    // Equal heads: removed.
    a.place(C, r2);
    expect((await a.removeCopy({ path: C, keeper: P, analysisId: AID })).ok).toBe(true);
    // Diverged, newer, other analysis, same file, open: refused, nothing moved.
    a.place(C, r2b);
    expect(await a.removeCopy({ path: C, keeper: P, analysisId: AID })).toMatchObject({ ok: false, kind: "refused", reason: "notOlder", head: "r-2b", keeperHead: "r-2" });
    const r3 = makeFile([["r-1", []], ["r-2", ["r-1"]], ["r-3", ["r-2"]]]);
    a.place(C, r3);
    expect(await a.removeCopy({ path: C, keeper: P, analysisId: AID })).toMatchObject({ reason: "notOlder" });
    a.place(C, makeFile([["r-1", []]], "a-other"));
    expect(await a.removeCopy({ path: C, keeper: P, analysisId: AID })).toMatchObject({ reason: "otherAnalysis" });
    expect(await a.removeCopy({ path: P, keeper: P, analysisId: AID })).toMatchObject({ reason: "sameFile" });
    a.place(C, r1);
    a.track(C);
    expect(await a.removeCopy({ path: C, keeper: P, analysisId: AID })).toMatchObject({ reason: "open" });
    a.untrack(C);
    expect(await a.removeCopy({ path: `${DIR}/gone.lag`, keeper: P, analysisId: AID })).toMatchObject({ ok: false, kind: "error", code: "NotFound" });
    expect(a.localPaths()).toEqual([C, P]);
    w.clock.advance(31 * 24 * 3600_000);
    expect(a.removedCopies()).toEqual([]);
  });

  it("the first-seen record round-trips and survives exportState / importState", async () => {
    const { w, a } = world();
    expect(await a.readSeen()).toEqual({ v: 1, analyses: {} });
    await a.writeSeen({ v: 1, analyses: { [AID]: { "r-1": 5 } } });
    expect(await a.readSeen()).toEqual({ v: 1, analyses: { [AID]: { "r-1": 5 } } });
    await expect(a.writeSeen({ v: 1, analyses: null } as never)).rejects.toThrow();
    const st = w.exportState();
    const w2 = new MemoryWorld({ clock: new ManualClock() });
    const a2 = w2.addDevice({ device_id: "d-a", device_name: "Mac mini" });
    w2.importState(st);
    expect(await a2.readSeen()).toEqual({ v: 1, analyses: { [AID]: { "r-1": 5 } } });
  });
});
