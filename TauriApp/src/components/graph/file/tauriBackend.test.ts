// The Tauri backend is a thin mapping (contract §1.7, §9.2): checked here with a
// fake invoke / listen that answers with the reply shapes of contract.ts.
import { describe, expect, it } from "vitest";
import { openContent } from "../../../store/graphStore";
import { sampleDoc } from "../graphModel";
import type { FileEvent } from "./backend";
import type { RawFile, SaveArgs } from "./contract";
import { buildNewFile } from "./docCodec";
import { canonicalJson, type GraphFileData } from "./format";
import { createTauriBackend, rustError, type InvokeFn, type ListenFn } from "./tauriBackend";

const last = <T>(a: readonly T[]): T | undefined => a[a.length - 1];

const STAT = { path: "/d/a.lag", size: 10, mtime: 5, dataless: false };

async function file(): Promise<GraphFileData> {
  return buildNewFile({
    content: openContent({ doc: sampleDoc("column") }), analysisId: "a-1", forkedFrom: null, time: 0,
    author: { user_name: "u", device_id: "d", device_name: "n", session_id: "s", app_version: "1", platform: "macos" },
  });
}
const raw = (f: GraphFileData): RawFile => ({ manifestText: canonicalJson(f.manifest), parts: f.parts });

function fake(handler: (cmd: string, args: Record<string, unknown>) => unknown) {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  const listeners = new Map<string, ((e: { payload: unknown }) => void)[]>();
  const invoke = (async (cmd: string, args: Record<string, unknown>) => {
    calls.push({ cmd, args });
    return handler(cmd, args);
  }) as unknown as InvokeFn;
  const listen = (async (event: string, h: (e: { payload: unknown }) => void) => {
    listeners.set(event, [...(listeners.get(event) ?? []), h]);
    return () => undefined;
  }) as unknown as ListenFn;
  const emit = (event: string, payload: unknown) => { for (const h of listeners.get(event) ?? []) h({ payload }); };
  return { calls, invoke, listen, emit, listeners };
}

describe("tauriBackend mapping", () => {
  it("read parses the manifest text; errors become typed codes; track sends what was read", async () => {
    const f = await file();
    const fk = fake((cmd, args) => {
      if (cmd === "graphfile_read" && args.path === "/d/a.lag") return { ...raw(f), stat: STAT, readOnly: null };
      if (cmd === "graphfile_read") throw { kind: "Dataless", message: "online only", data: null };
      if (cmd === "graphfile_header") throw "panicked at …";
      return null;
    });
    const be = createTauriBackend(fk);
    const r = await be.read("/d/a.lag");
    expect(r).toEqual({ ok: true, file: f, stat: STAT, readOnly: null });
    expect(await be.read("/d/b.lag")).toEqual({ ok: false, code: "Dataless", message: "online only" });
    expect(await be.header("/d/a.lag")).toEqual({ ok: false, code: "Io", message: "panicked at …" });
    be.track("/d/a.lag", { active: true });
    be.track("/d/new.lag");
    await Promise.resolve();
    expect(fk.calls.filter((c) => c.cmd === "graphfile_track").map((c) => c.args)).toEqual([
      { path: "/d/a.lag", active: true, head: f.manifest.head, analysisId: "a-1" },
      { path: "/d/new.lag", active: false, head: null, analysisId: null },
    ]);
  });

  it("save sends canonical manifest text and maps every reply kind", async () => {
    const f = await file();
    const replies: unknown[] = [
      { kind: "saved", path: "/d/b.lag", head: "r-2", stat: STAT },
      { kind: "savedAside", path: "/d/a (unsynced from n).lag", head: "r-2", stat: STAT },
      { kind: "savedButDisplaced", path: "/d/a.lag", head: "r-2", stat: STAT, displacedHead: "r-x" },
      { kind: "conflict", head: "r-9" },
      { kind: "missing" },
    ];
    let i = 0;
    const fk = fake((cmd) => {
      if (cmd !== "graphfile_save") return null;
      if (i < replies.length) return replies[i++];
      throw { kind: "IdentityMismatch", message: "other", data: { found: "a-2" } };
    });
    const be = createTauriBackend(fk);
    const req = { path: "/d/a.lag", expectedHead: "r-1", analysisId: "a-1", docKey: "k", manifest: f.manifest, newParts: f.parts };
    expect(await be.save(req)).toEqual({ ok: true, kind: "saved", path: "/d/b.lag", head: "r-2", stat: STAT });
    const sent = fk.calls[0].args.req as SaveArgs;
    expect(sent).toEqual({ ...req, manifest: undefined, manifestText: canonicalJson(f.manifest), replaceExisting: false });
    expect(Object.keys(sent)).not.toContain("manifest");
    expect(await be.save(req)).toMatchObject({ ok: true, kind: "savedAside" });
    expect(await be.save(req)).toMatchObject({ ok: true, kind: "savedButDisplaced", displacedHead: "r-x" });
    expect(await be.save(req)).toEqual({ ok: false, kind: "conflict", head: "r-9" });
    expect(await be.save(req)).toEqual({ ok: false, kind: "missing" });
    expect(await be.save({ ...req, replaceExisting: true })).toEqual({ ok: false, kind: "error", code: "IdentityMismatch", message: "other" });
    expect((last(fk.calls)!.args.req as SaveArgs).replaceExisting).toBe(true);
    // The followed path is what track sends next.
    be.track("/d/b.lag", { active: true });
    await Promise.resolve();
    expect(last(fk.calls)).toEqual({ cmd: "graphfile_track", args: { path: "/d/b.lag", active: true, head: "r-2", analysisId: "a-1" } });
  });

  it("records, journal and displaced pass through; NoStateDir is an Io error for files", async () => {
    const f = await file();
    const fk = fake((cmd, args) => {
      switch (cmd) {
        case "graphfile_read_journal": return args.revisionId === "r-1" ? raw(f) : null;
        case "graphfile_read_displaced": return raw(f);
        case "graphfile_journal_heads": return [{ analysis_id: "a-1", path: "/d/a.lag", revision_id: "r-1", confirmed: false, first_seen: 1 }];
        case "appstate_read_session": return { v: 1, tabs: [] };
        case "graphfile_scan_dir": throw { kind: "NoStateDir", message: "x", data: null };
        default: return null;
      }
    });
    const be = createTauriBackend(fk);
    expect(await be.readJournal("a-1", "r-1")).toEqual(f);
    expect(await be.readJournal("a-1", "r-0")).toBeNull();
    expect(await be.readDisplaced("x-1")).toEqual(f);
    expect(await be.journalHeads("a-1")).toHaveLength(1);
    expect(last(fk.calls)).toEqual({ cmd: "graphfile_journal_heads", args: { analysisId: "a-1", path: null } });
    await be.writeJournal("/d/a.lag", f);
    expect(last(fk.calls)).toEqual({ cmd: "graphfile_write_journal", args: { path: "/d/a.lag", file: raw(f) } });
    await be.writeDraft({ doc_key: "k", analysis_id: null, path: null, base_revision: null, sections: {}, saved_at: "t" });
    expect(last(fk.calls)?.cmd).toBe("appstate_write_draft");
    await be.writeRecent([]);
    expect(last(fk.calls)).toEqual({ cmd: "appstate_write_recent", args: { entries: [] } });
    await be.writeExportMap({ v: 1, rows: {} });
    expect(last(fk.calls)).toEqual({ cmd: "appstate_write_export_map", args: { map: { v: 1, rows: {} } } });
    await be.setDevice({ userName: "Z" });
    expect(last(fk.calls)).toEqual({ cmd: "appstate_set_device", args: { patch: { userName: "Z" } } });
    expect(await be.readSession()).toEqual({ v: 1, tabs: [] });
    expect(await be.scanDir("/d")).toEqual({ ok: false, code: "Io", message: "x" });
    be.untrack("/d/a.lag");
    be.pollNow();
    await be.reveal("/d/a.lag");
    expect(fk.calls.slice(-3).map((c) => c.cmd)).toEqual(["graphfile_untrack", "graphfile_poll_now", "graphfile_reveal"]);
  });

  it("one event listener for the app's lifetime; moved updates what track sends", async () => {
    const f = await file();
    const fk = fake((cmd) => (cmd === "graphfile_read" ? { ...raw(f), stat: STAT, readOnly: null } : null));
    const be = createTauriBackend(fk);
    await be.read("/d/a.lag");
    const got: FileEvent[] = [];
    be.subscribe((e) => got.push(e));
    be.subscribe(() => undefined);
    await Promise.resolve();
    expect(fk.listeners.get("graphfile://event")).toHaveLength(1);
    fk.emit("graphfile://event", { type: "moved", from: "/d/a.lag", to: "/d/b.lag", head: "r-5" });
    fk.emit("graphfile://event", { type: "changed", path: "/d/b.lag", head: "r-6" });
    expect(got.map((e) => e.type)).toEqual(["moved", "changed"]);
    be.track("/d/b.lag");
    await Promise.resolve();
    expect(last(fk.calls)?.args).toEqual({ path: "/d/b.lag", active: false, head: "r-6", analysisId: "a-1" });
  });

  it("locate: progress by token, cancel, typed failure", async () => {
    let resolveLocate: (v: unknown) => void = () => undefined;
    const fk = fake((cmd) => {
      if (cmd === "graphfile_locate") return new Promise((r) => { resolveLocate = r; });
      return null;
    });
    const be = createTauriBackend(fk);
    const progress: number[] = [];
    const run = be.locate("/Users/me", "a-1", (p) => progress.push(p.scanned));
    await Promise.resolve();
    await Promise.resolve();
    fk.emit("graphfile://locate-progress", { token: run.token, scanned: 120, matches: 0 });
    fk.emit("graphfile://locate-progress", { token: "other", scanned: 999, matches: 0 });
    be.cancelLocate(run.token);
    resolveLocate({ matches: [], onlineOnly: [], onlineOnlyCount: 0, skippedFolders: [], truncated: null, scanned: 300 });
    expect(await run.result).toMatchObject({ ok: true, scanned: 300 });
    expect(progress).toEqual([120]);
    expect(fk.calls.find((c) => c.cmd === "graphfile_locate")?.args).toEqual({ dir: "/Users/me", analysisId: "a-1", token: run.token });
    expect(fk.calls.find((c) => c.cmd === "graphfile_locate_cancel")?.args).toEqual({ token: run.token });
    const fk2 = fake(() => { throw { kind: "Cancelled", message: "stopped", data: null }; });
    expect(await createTauriBackend(fk2).locate("/x", "a", undefined).result).toEqual({ ok: false, code: "Cancelled", message: "stopped" });
  });

  it("rustError accepts only RustError objects", () => {
    expect(rustError({ kind: "TooNew", message: "m", data: { min_reader_version: 2 } })).toEqual({ kind: "TooNew", message: "m" });
    expect(rustError({ kind: "Weird", message: "m" })).toEqual({ kind: "Io", message: "Unexpected error." });
    expect(rustError(new Error("boom"))).toEqual({ kind: "Io", message: "boom" });
  });
});

describe("tauriBackend mapping, phase 2", () => {
  it("peek, removeCopy, the first-seen record", async () => {
    const f = await file();
    let removeReply: unknown = { kind: "removed", displacedId: "x-1", head: "r-1" };
    const fk = fake((cmd, args) => {
      if (cmd === "graphfile_peek" && args.path === "/d/a.lag") return { manifestText: canonicalJson(f.manifest), stat: STAT, readOnly: null };
      if (cmd === "graphfile_peek") throw { kind: "Incomplete", message: "arriving", data: null };
      if (cmd === "graphfile_remove_copy") { if (removeReply === "throw") throw { kind: "NotFound", message: "gone", data: null }; return removeReply; }
      if (cmd === "appstate_read_seen") return { v: 1, analyses: { "a-1": { "r-1": 1 } } };
      return null;
    });
    const be = createTauriBackend(fk);
    expect(await be.peek("/d/a.lag")).toEqual({ ok: true, manifest: f.manifest, stat: STAT, readOnly: null });
    expect(await be.peek("/d/b.lag")).toEqual({ ok: false, code: "Incomplete", message: "arriving" });
    const args = { path: "/d/c.lag", keeper: "/d/a.lag", analysisId: "a-1" };
    expect(await be.removeCopy(args)).toEqual({ ok: true, kind: "removed", displacedId: "x-1", head: "r-1" });
    expect(last(fk.calls)).toEqual({ cmd: "graphfile_remove_copy", args: { req: args } });
    removeReply = { kind: "refused", reason: "notOlder", head: "r-2", keeperHead: "r-1" };
    expect(await be.removeCopy(args)).toEqual({ ok: false, kind: "refused", reason: "notOlder", head: "r-2", keeperHead: "r-1" });
    removeReply = "throw";
    expect(await be.removeCopy(args)).toEqual({ ok: false, kind: "error", code: "NotFound", message: "gone" });
    expect(await be.readSeen()).toEqual({ v: 1, analyses: { "a-1": { "r-1": 1 } } });
    await be.writeSeen({ v: 1, analyses: {} });
    expect(last(fk.calls)).toEqual({ cmd: "appstate_write_seen", args: { seen: { v: 1, analyses: {} } } });
  });
});
