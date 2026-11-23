/* Phase 3 engine, unit tests P1–P11 (phase3-contract.md §8). Property tests: presence.scenarios.test.ts. */
import { describe, expect, it } from "vitest";
import presenceSource from "./presence.ts?raw";
import { LIMITS_P3, NOTE_FIRST_LINE, type NoteJson, type NoteObs, type PresenceApi } from "./contract";
import {
  cleanupTargets, decide, deviceTag, duplicateIdentity, emptyObs, freshness, gapDetected, isNoteFileName, liveNoteHeads,
  markGap, multiDevice, noteApplies, noteFileName, noteText, observe, olderPeer, parseNote, pickPerDevice, presenceApi,
  sanitizeNamePart, shareDecision, utf8Length,
} from "./presence";
import { manifestOf, rev } from "./fixtures-p2/kit";
import { H, KNOWN, ME, MIN, S, T0, bob, editing, input, iso, look, note, record } from "./fixtures-p3/notes";

const L = LIMITS_P3;
const stem = (s: string) => sanitizeNamePart(s, L.nameStemChars, L.nameStemBytes, "Analysis");
const dev = (s: string) => sanitizeNamePart(s, L.nameDeviceChars, L.nameDeviceBytes, "computer");
const knows = (id: string) => KNOWN.has(id);

// The api object is the contract's shape (also checked by `satisfies` in presence.ts).
const api: PresenceApi = presenceApi;

describe("P1 names", () => {
  it("every row of the §1.2 table", () => {
    expect(noteFileName("Dose response.lag", "Mac mini", "d-6b1e-4a7c-9f3c")).toBe("Dose response (in use on Mac mini, 9f3c).laguse");
    expect(noteFileName("Dose response", "Mac mini", "d-6b1e-4a7c-9f3c")).toBe("Dose response (in use on Mac mini, 9f3c).laguse");
    expect(stem("Exp_2: 50% (v1.3)")).toBe("Exp 2 50 (v1 3)");
    expect(stem(".~hidden.tmp")).toBe("hidden tmp");
    expect(stem('a/b\\c:d*e?f"g<h>i|j')).toBe("a b c d e f g h i j");
    expect(dev("Zhuo's MacBook-Pro")).toBe("Zhuo s MacBook-Pro");
    expect(stem("用量反応 2026年")).toBe("用量反応 2026年");
    expect(stem("用".repeat(70))).toBe("用".repeat(40));
    expect(stem("naïve—test")).toBe("naïve—test");
    expect(stem("   ")).toBe("Analysis");
    expect(stem("...")).toBe("Analysis");
    expect(dev("x".repeat(45))).toBe("x".repeat(30));
    expect(stem("~$report.lock")).toBe("report lock");
  });

  it("odd spaces, invisible and control characters", () => {
    expect(stem("a b c　d")).toBe("a b c d");
    expect(stem("a​b­c﻿d‮e⁦f")).toBe("abcdef");
    expect(stem("a\u0085b\u0009c\u0000d\u007f")).toBe("a b c d");
    expect(stem("  lead  and   trail  ")).toBe("lead and trail");
    expect(stem("é Ä 😀 ภาษาไทย हिन्दी")).toBe("é Ä 😀 ภาษาไทย हिन्दी"); // no normalisation
    expect(stem("ab\ud800cd")).toBe("abcd"); // a lone surrogate cannot be in a name
  });

  it("the byte limit cuts whole characters and trims again", () => {
    // 59 × "a" + " " + "😀": 61 characters → cut to 60 ("…a "), trimmed.
    expect(stem("a".repeat(59) + " 😀")).toBe("a".repeat(59));
    // 30 × 4-byte emoji = 120 bytes: fits; 31 → cut to 30.
    expect(stem("😀".repeat(31))).toBe("😀".repeat(30));
    expect(utf8Length(stem("😀".repeat(31)))).toBe(120);
    // 255-byte stem of mixed scripts.
    const long = ("Ä用😀b").repeat(26).slice(0, 255);
    expect(utf8Length(stem(long))).toBeLessThanOrEqual(120);
    expect(Array.from(stem(long)).length).toBeLessThanOrEqual(60);
  });

  it("device tags", () => {
    expect(deviceTag("d-6b1e…9f3c", 0)).toBe("9f3c");
    expect(deviceTag("d-preview-this", 0)).toBe("0dee");
    expect(deviceTag("d-0123456789ABCDEF", 0)).toBe("cdef");
    expect(deviceTag("d-0123456789ABCDEF", 1)).toBe("89ab");
    expect(deviceTag("d-0123456789ABCDEF", 2)).toBe("89abcdef");
    expect(deviceTag("x-12345", 1)).toBe("0001");
    expect(deviceTag("x-12345", 2)).toBe("00012345");
    expect(deviceTag("d-12345", 0)).toBe("2345");
    expect(deviceTag("xyz", 0)).toBe("0000"); // no hex digits at all
    expect(deviceTag("", 2)).toBe("00000000");
    expect(noteFileName("X.lag", "Mac", "d-0123456789abcdef", 1)).toBe("X (in use on Mac, 89ab).laguse");
    expect(noteFileName("X.LAG", "", "d-1")).toBe("X (in use on computer, 00d1).laguse"); // "d" is a hex digit too
  });

  it("generated names never break the rules", () => {
    const alphabet = [..."aZ09 -(),._'\"&#%~$!+=;@[]{}^/\\:*?<>|\t\n", " ", "​", "\u0085", "é", "用", "😀", "́", "‮"];
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    for (let i = 0; i < 400; i++) {
      const gen = (n: number) => Array.from({ length: n }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join("");
      const name = noteFileName(gen(Math.floor(rnd() * 120)) + ".lag", gen(Math.floor(rnd() * 50)), gen(10), (i % 3) as 0 | 1 | 2);
      expect(name.startsWith(".") || name.startsWith("~")).toBe(false);
      expect(utf8Length(name)).toBeLessThanOrEqual(206);
      expect(name).toMatch(/\)\.laguse$/);
      expect(isNoteFileName(name)).toBe(true);
      const parts = name.slice(0, -".laguse".length);
      expect(/[\x00-\x1f\x7f_.'"&#%~$!+=;@[\]{}^/\\:*?<>|]/.test(parts)).toBe(false);
      expect(name).not.toMatch(/ {2}/);
      expect(name.toLowerCase()).not.toMatch(/\.tmp|\.lock|~\$|_vti_/);
    }
  });

  it("isNoteFileName", () => {
    expect(isNoteFileName("X (in use on Mac, 1a2b).laguse")).toBe(true);
    expect(isNoteFileName("X (in use on Mac, 1a2b) (conflicted copy 2026-11-22).laguse")).toBe(true);
    expect(isNoteFileName("X.LAGUSE")).toBe(true);
    expect(isNoteFileName(".~X.laguse.tmp-1a2b3c4d")).toBe(false);
    expect(isNoteFileName(".X.laguse")).toBe(false);
    expect(isNoteFileName("X.lag")).toBe(false);
    expect(isNoteFileName("X.laguse.tmp")).toBe(false);
  });
});

describe("P2 note text", () => {
  const example: NoteJson = {
    format: "lasgraph-presence", v: 1, analysis_id: "a-3f0c…", document_name: "Dose response.lag", device_id: "d-6b1e…9f3c",
    session_id: "s-…", device_name: "Mac mini", user_name: "Zhuo", state: "editing", head: "r-01JD…", base_revision: "r-01JD…",
    epoch: 3, seq: 41, supersedes: null, updated_at: "2026-11-22T10:14:03.512Z", request_to: null, handover_to: null, features: 2,
  };
  const exampleText = `Lab Analysis Suite note: shows who has this analysis open. Safe to delete.
{
 "format": "lasgraph-presence",
 "v": 1,
 "analysis_id": "a-3f0c…",
 "document_name": "Dose response.lag",
 "device_id": "d-6b1e…9f3c",
 "session_id": "s-…",
 "device_name": "Mac mini",
 "user_name": "Zhuo",
 "state": "editing",
 "head": "r-01JD…",
 "base_revision": "r-01JD…",
 "epoch": 3,
 "seq": 41,
 "supersedes": null,
 "updated_at": "2026-11-22T10:14:03.512Z",
 "request_to": null,
 "handover_to": null,
 "features": 2
}
`;

  it("the exact text of the §1.1 example, and back", () => {
    expect(noteText(example)).toBe(exampleText);
    expect(parseNote(exampleText)).toEqual(example);
    expect(noteText(parseNote(exampleText)!)).toBe(exampleText);
  });

  it("keys in NoteJson order whatever the object's order; extra keys left out", () => {
    const shuffled = Object.fromEntries(Object.entries(example).reverse()) as unknown as NoteJson;
    expect(noteText({ ...shuffled, extra: 1 } as NoteJson)).toBe(exampleText);
  });

  it("supersedes as a list", () => {
    const n = { ...example, supersedes: [{ device_id: "d-a", epoch: 2 }, { device_id: "d-b", epoch: 7 }] };
    const t = noteText(n);
    expect(t).toContain(' "supersedes": [\n  {\n   "device_id": "d-a",\n   "epoch": 2\n  },\n  {\n   "device_id": "d-b",\n   "epoch": 7\n  }\n ],\n');
    expect(parseNote(t)).toEqual(n);
  });

  const json = (o: Record<string, unknown>) => `${NOTE_FIRST_LINE}\n${JSON.stringify(o, null, 1)}\n`;
  const base = { ...example } as Record<string, unknown>;

  it("tolerances", () => {
    expect(parseNote("﻿" + exampleText)).toEqual(example); // a BOM
    expect(parseNote(JSON.stringify(example))).toEqual(example); // no first line
    expect(parseNote("junk before " + JSON.stringify(example) + " junk after")).toEqual(example);
    const extra = parseNote(json({ ...base, color: "red", nested: { a: 1 } }))!;
    expect(extra).toEqual(example);
    expect("color" in extra).toBe(false);
    expect(parseNote(json({ ...base, state: "requesting" }))!.state).toBe("idle");
    expect(parseNote(json({ ...base, state: 5 }))!.state).toBe("idle");
    const { state: _s, ...noState } = base;
    expect(parseNote(json(noState))!.state).toBe("idle");
    expect(parseNote(json({ ...base, supersedes: { device_id: "d-x", epoch: 4 } }))!.supersedes).toEqual([{ device_id: "d-x", epoch: 4 }]);
    expect(parseNote(json({ ...base, supersedes: [{ device_id: "d-x", epoch: 4, more: 1 }, { device_id: 3, epoch: 1 }, { epoch: 2 }, "x", null] }))!.supersedes)
      .toEqual([{ device_id: "d-x", epoch: 4 }]);
    expect(parseNote(json({ ...base, supersedes: [{ device_id: 3 }] }))!.supersedes).toBeNull();
    expect(parseNote(json({ ...base, supersedes: [] }))!.supersedes).toBeNull();
    const { features: _f, ...noFeatures } = base;
    expect(parseNote(json(noFeatures))!.features).toBe(2);
    expect(parseNote(json({ ...base, features: 1 }))!.features).toBe(1);
    const req = parseNote(json({ ...base, request_to: { device_id: "d-x" }, handover_to: "d-y" }))!;
    expect(req.request_to).toBeNull();
    expect(req.handover_to).toBeNull();
    expect(parseNote(json({ ...base, head: null, base_revision: null }))).toMatchObject({ head: null, base_revision: null });
    const { head: _h, base_revision: _b, ...noHeads } = base;
    expect(parseNote(json(noHeads))).toMatchObject({ head: null, base_revision: null }); // missing = null
    expect(parseNote(json({ ...base, device_name: "", user_name: "" }))).toMatchObject({ device_name: "", user_name: "" });
    expect(parseNote(json({ ...base, epoch: 0, seq: 0 }))).toMatchObject({ epoch: 0, seq: 0 });
  });

  it("rejected", () => {
    expect(parseNote(exampleText + " ".repeat(L.noteMaxBytes))).toBeNull(); // over 8192 bytes
    const padded = exampleText.replace("Mac mini", "M" + "é".repeat(4200)); // ~8.4 KB of 2-byte characters
    expect(utf8Length(padded)).toBeGreaterThan(L.noteMaxBytes);
    expect(padded.length).toBeLessThan(L.noteMaxBytes);
    expect(parseNote(padded)).toBeNull(); // the limit is in bytes
    expect(parseNote("")).toBeNull();
    expect(parseNote(NOTE_FIRST_LINE)).toBeNull();
    expect(parseNote("} {")).toBeNull();
    expect(parseNote(NOTE_FIRST_LINE + "\n{ not json }")).toBeNull();
    expect(parseNote("[" + JSON.stringify(example) + "]")).not.toBeNull(); // first { to last }: the object inside
    expect(parseNote(json({ ...base, format: "lasgraph" }))).toBeNull();
    expect(parseNote(json({ ...base, v: 2 }))).toBeNull();
    expect(parseNote(json({ ...base, v: "1" }))).toBeNull();
    for (const k of ["analysis_id", "document_name", "device_id", "session_id"]) {
      const { [k]: _gone, ...rest } = base;
      expect(parseNote(json(rest))).toBeNull();
      expect(parseNote(json({ ...base, [k]: "" }))).toBeNull();
      expect(parseNote(json({ ...base, [k]: 7 }))).toBeNull();
    }
    for (const k of ["device_name", "user_name", "updated_at"]) {
      const { [k]: _gone, ...rest } = base;
      expect(parseNote(json(rest))).toBeNull();
    }
    expect(parseNote(json({ ...base, seq: "41" }))).toBeNull();
    expect(parseNote(json({ ...base, seq: -1 }))).toBeNull();
    expect(parseNote(json({ ...base, epoch: null }))).toBeNull();
    expect(parseNote(exampleText.replace('"seq": 41', '"seq": 1e999'))).toBeNull(); // Infinity
    expect(parseNote(json({ ...base, head: 5 }))).toBeNull();
    expect(parseNote(json({ ...base, base_revision: [] }))).toBeNull();
  });
});

describe("P3 which notes count", () => {
  const doc = (fileName: string, sameIdFiles = 2) => ({ analysisId: "a-1", fileName, sameIdFiles });

  it("noteApplies: by name, case and NFC / NFD", () => {
    expect(noteApplies({ analysis_id: "a-1", document_name: "Dose response.lag" }, doc("Dose response.lag"))).toBe(true);
    expect(noteApplies({ analysis_id: "a-1", document_name: "DOSE RESPONSE.LAG" }, doc("Dose response.lag"))).toBe(true);
    expect(noteApplies({ analysis_id: "a-1", document_name: "Résumé.lag" }, doc("Résumé.lag"))).toBe(true);
    expect(noteApplies({ analysis_id: "a-1", document_name: "Other.lag" }, doc("Dose response.lag"))).toBe(false);
  });

  it("noteApplies: the sole file with the id; never another analysis", () => {
    expect(noteApplies({ analysis_id: "a-1", document_name: "Old name.lag" }, doc("Dose response.lag", 1))).toBe(true);
    expect(noteApplies({ analysis_id: "a-1", document_name: "Old name.lag" }, doc("Dose response.lag", 2))).toBe(false);
    expect(noteApplies({ analysis_id: "a-1", document_name: "Old name.lag" }, doc("Dose response.lag", 0))).toBe(false);
    expect(noteApplies({ analysis_id: "a-2", document_name: "Dose response.lag" }, doc("Dose response.lag", 1))).toBe(false);
    // After a Finder duplicate: each file sees only the note naming it.
    const n = { analysis_id: "a-1", document_name: "Dose response.lag" };
    expect(noteApplies(n, doc("Dose response.lag", 2))).toBe(true);
    expect(noteApplies(n, doc("Dose response copy.lag", 2))).toBe(false);
  });

  it("pickPerDevice: highest seq, then later updated_at, then smaller path; conflict copies collapse", () => {
    const a5 = record(note({ seq: 5 }), { file: "/d/b.laguse" });
    const a7 = record(note({ seq: 7 }), { file: "/d/z.laguse" });
    const a7later = record(note({ seq: 7, updated_at: iso(T0 + S) }), { file: "/d/y.laguse" });
    const a7later2 = record(note({ seq: 7, updated_at: iso(T0 + S) }), { file: "/d/x (conflicted copy).laguse" });
    const b1 = record(bob({ seq: 1 }), { file: "/d/a.laguse" });
    expect(pickPerDevice([a5, a7, b1]).map((r) => r.file)).toEqual(["/d/z.laguse", "/d/a.laguse"]); // by device id
    const out = pickPerDevice([a5, a7, a7later, a7later2, b1]);
    expect(out).toHaveLength(2);
    expect(out.find((r) => r.note.device_id === note().device_id)!.file).toBe("/d/x (conflicted copy).laguse");
    // Any order → the same answer.
    const perms = [[a5, a7, a7later, a7later2, b1], [b1, a7later2, a7later, a7, a5], [a7later, b1, a5, a7later2, a7]];
    for (const p of perms) expect(pickPerDevice(p)).toEqual(out);
    // Seq beats updated_at.
    const hiSeqOld = record(note({ seq: 9, updated_at: iso(T0 - H) }), { file: "/d/q.laguse" });
    expect(pickPerDevice([a7later, hiSeqOld])[0].file).toBe("/d/q.laguse");
    expect(pickPerDevice([])).toEqual([]);
  });
});

describe("P4 observe", () => {
  it("first sight: old, not old, unreadable time", () => {
    const fresh = note({ updated_at: iso(T0 - 9 * MIN) });
    const old = bob({ updated_at: iso(T0 - 11 * MIN) });
    const weird = note({ device_id: "d-c", updated_at: "last Tuesday" });
    const o = observe(emptyObs(), [fresh, old, weird], T0, knows);
    expect(o.notes[fresh.device_id]).toEqual({
      deviceId: fresh.device_id, sessionId: "s-alice", epoch: 0, seq: 1, state: "idle", firstSeenAt: T0, changedAt: T0, changes: 0,
      editingSince: null, oldAtFirstSight: false, checking: false,
    });
    expect(o.notes[old.device_id].oldAtFirstSight).toBe(true);
    expect(o.notes["d-c"].oldAtFirstSight).toBe(true);
    // Exactly 10 min is not "more than 10 min".
    expect(observe(emptyObs(), [note({ updated_at: iso(T0 - 10 * MIN) })], T0, knows).notes[fresh.device_id].oldAtFirstSight).toBe(false);
    expect(o.checkingSince).toBeNull();
  });

  it("a seq, epoch or session change counts as a change; the same note does not", () => {
    const o1 = observe(emptyObs(), [editing({ seq: 3 })], T0, knows);
    const same = observe(o1, [editing({ seq: 3, updated_at: iso(T0 + H) })], T0 + 10 * S, knows);
    expect(same.notes["d-alice-9f3c"]).toEqual(o1.notes["d-alice-9f3c"]);
    for (const ch of [{ seq: 4 }, { epoch: 2 }, { session_id: "s-alice-2" }]) {
      const o2 = observe(o1, [editing({ seq: 3, ...ch })], T0 + 20 * S, knows);
      const ob = o2.notes["d-alice-9f3c"];
      expect(ob.changes).toBe(1);
      expect(ob.changedAt).toBe(T0 + 20 * S);
      expect(ob.firstSeenAt).toBe(T0);
      expect(ob.oldAtFirstSight).toBe(false);
    }
  });

  it("a change makes an old-at-first-sight note alive", () => {
    const o1 = observe(emptyObs(), [editing({ updated_at: iso(T0 - H) })], T0, knows);
    expect(o1.notes["d-alice-9f3c"].oldAtFirstSight).toBe(true);
    // A change with a recent time of its own: alive at once.
    const now = observe(o1, [editing({ seq: 2, updated_at: iso(T0 + MIN) })], T0 + MIN, knows).notes["d-alice-9f3c"];
    expect(now).toMatchObject({ oldAtFirstSight: false, changes: 1, changedAt: T0 + MIN });
  });

  it("fixer VP-4: a change that is itself old by my clock arrived late — the first one is not a sign of life", () => {
    const id = "d-alice-9f3c";
    const o1 = observe(emptyObs(), [editing({ updated_at: iso(T0 - H) })], T0, knows);
    const o2 = observe(o1, [editing({ seq: 2, updated_at: iso(T0 - H) })], T0 + MIN, knows);
    expect(o2.notes[id]).toMatchObject({ oldAtFirstSight: true, changes: 0, seq: 2 });
    expect(freshness(o2.notes[id], T0 + MIN, null)).toBe("quiet");
    // A second old-looking change in a row: the note keeps moving (its writer's clock is wrong) → alive.
    const o3 = observe(o2, [editing({ seq: 3, updated_at: iso(T0 - H + MIN) })], T0 + 2 * MIN, knows);
    expect(o3.notes[id]).toMatchObject({ oldAtFirstSight: false, changes: 1, changedAt: T0 + 2 * MIN });
    expect(freshness(o3.notes[id], T0 + 2 * MIN, null)).toBe("active");
    // … and stays so while it keeps moving with that clock.
    const o4 = observe(o3, [editing({ seq: 4, updated_at: iso(T0 - H + 2 * MIN) })], T0 + 3 * MIN, knows);
    expect(o4.notes[id]).toMatchObject({ changes: 2, changedAt: T0 + 3 * MIN });
    // A live note (changes seen) whose next change arrives 30 min late (I was offline): quiet at once.
    const a1 = observe(emptyObs(), [editing({ seq: 5, updated_at: iso(T0) })], T0, knows);
    const a2 = observe(a1, [editing({ seq: 6, updated_at: iso(T0 + MIN) })], T0 + MIN, knows);
    expect(freshness(a2.notes[id], T0 + MIN, null)).toBe("active");
    const a3 = observe(a2, [editing({ seq: 7, updated_at: iso(T0 + 2 * MIN) })], T0 + 32 * MIN, knows);
    expect(a3.notes[id].changes).toBe(1);
    expect(freshness(a3.notes[id], T0 + 32 * MIN, null)).toBe("quiet");
  });

  it("a removed note is forgotten", () => {
    const o1 = observe(emptyObs(), [note(), bob()], T0, knows);
    const o2 = observe(o1, [bob()], T0 + S, knows);
    expect(Object.keys(o2.notes)).toEqual(["d-bob-1a2b"]);
    const o3 = observe(o2, [note(), bob()], T0 + 2 * S, knows);
    expect(o3.notes["d-alice-9f3c"].firstSeenAt).toBe(T0 + 2 * S); // a new first sight
  });

  it("editingSince", () => {
    const id = "d-alice-9f3c";
    let o = observe(emptyObs(), [note()], T0, knows);
    expect(o.notes[id].editingSince).toBeNull();
    o = observe(o, [editing({ seq: 2 })], T0 + 10 * S, knows);
    expect(o.notes[id].editingSince).toBe(T0 + 10 * S); // became editing
    o = observe(o, [editing({ seq: 3 })], T0 + 70 * S, knows);
    expect(o.notes[id].editingSince).toBe(T0 + 10 * S); // kept in the same epoch
    o = observe(o, [editing({ seq: 4, epoch: 2 })], T0 + 80 * S, knows);
    expect(o.notes[id].editingSince).toBe(T0 + 80 * S); // a new epoch
    o = observe(o, [note({ seq: 5, epoch: 2 })], T0 + 90 * S, knows);
    expect(o.notes[id].editingSince).toBeNull(); // idle
    expect(observe(emptyObs(), [editing()], T0 + 5, knows).notes[id].editingSince).toBe(T0 + 5); // first sight editing
  });

  it("unknownSince: added, kept, dropped", () => {
    const k = (id: string) => KNOWN.has(id);
    let o = observe(emptyObs(), [editing({ head: "r-9", base_revision: "r-8" })], T0, k);
    expect(o.unknownSince).toEqual({ "r-8": T0, "r-9": T0 });
    o = observe(o, [editing({ head: "r-9", base_revision: "r-9", seq: 2 })], T0 + 10 * S, k);
    expect(o.unknownSince).toEqual({ "r-9": T0 }); // kept; r-8 no longer declared
    o = observe(o, [editing({ head: "r-9", base_revision: "r-9", seq: 2 })], T0 + 20 * S, (id) => k(id) || id === "r-9");
    expect(o.unknownSince).toEqual({}); // known now
    // An idle note's base_revision is not a declared version.
    expect(observe(emptyObs(), [note({ head: "r-1", base_revision: "r-7" })], T0, k).unknownSince).toEqual({});
    expect(observe(emptyObs(), [note({ head: null })], T0, k).unknownSince).toEqual({});
  });

  it("does not mutate; markGap", () => {
    const o1 = observe(emptyObs(), [editing({ head: "r-9", base_revision: "r-9" })], T0, knows);
    const snap = JSON.stringify(o1);
    const g = markGap(o1, T0 + H);
    expect(JSON.stringify(o1)).toBe(snap);
    expect(g.notes["d-alice-9f3c"].checking).toBe(true);
    expect(g.unknownSince).toEqual({});
    expect(g.checkingSince).toBe(T0 + H);
    expect(markGap(g, T0 + 2 * H).checkingSince).toBe(T0 + H); // the first gap counts
    // The next look clears it.
    const after = observe(g, [editing({ head: "r-9", base_revision: "r-9" })], T0 + H + S, knows);
    expect(after.checkingSince).toBeNull();
    expect(after.notes["d-alice-9f3c"].checking).toBe(false);
    expect(after.unknownSince).toEqual({ "r-9": T0 + H + S }); // the wait starts again
  });

  it("the re-look after a gap: a moved note is alive, an unmoved one is a new first sight", () => {
    const id = "d-alice-9f3c";
    const o1 = observe(emptyObs(), [editing({ seq: 3, updated_at: iso(T0) })], T0, knows);
    const g = markGap(o1, T0 + 2 * H);
    const unmoved = observe(g, [editing({ seq: 3, updated_at: iso(T0) })], T0 + 2 * H + S, knows).notes[id];
    expect(unmoved).toMatchObject({ firstSeenAt: T0 + 2 * H + S, changes: 0, oldAtFirstSight: true, checking: false });
    const moved = observe(g, [editing({ seq: 90, updated_at: iso(T0 + 2 * H) })], T0 + 2 * H + S, knows).notes[id];
    expect(moved).toMatchObject({ firstSeenAt: T0 + 2 * H + S, changedAt: T0 + 2 * H + S, changes: 1, oldAtFirstSight: false });
    // Moved but dated far in the past (fixer VP-4): it may have arrived late (written before I woke) — quiet now;
    // its next change counts, also with that clock.
    const gs = observe(g, [editing({ seq: 90, updated_at: "2001-01-01T00:00:00.000Z" })], T0 + 2 * H + S, knows);
    expect(gs.notes[id]).toMatchObject({ oldAtFirstSight: true, changes: 0 });
    const skewed = observe(gs, [editing({ seq: 91, updated_at: "2001-01-01T00:01:00.000Z" })], T0 + 2 * H + MIN, knows).notes[id];
    expect(skewed).toMatchObject({ oldAtFirstSight: false, changes: 1 });
  });

  it("odd device ids are kept as own keys", () => {
    const o = observe(emptyObs(), [note({ device_id: "__proto__" }), note({ device_id: "constructor", head: "constructor" })], T0, knows);
    expect(Object.keys(o.notes).sort()).toEqual(["__proto__", "constructor"]);
    expect(Object.getPrototypeOf(o.notes)).toBe(Object.prototype);
    expect(o.unknownSince).toEqual({ constructor: T0 });
    const d = decide(input([note({ device_id: "constructor", state: "editing", base_revision: "r-1", epoch: 1 })], emptyObs()));
    expect(d.mode).toBe("readOnly");
  });
});

describe("P5 freshness", () => {
  const ob = (over: Partial<NoteObs> = {}): NoteObs => ({
    deviceId: "d-a", sessionId: "s", epoch: 1, seq: 1, state: "editing", firstSeenAt: T0, changedAt: T0, changes: 0,
    editingSince: T0, oldAtFirstSight: false, checking: false, ...over,
  });

  it("old at first sight → quiet at once", () => {
    expect(freshness(ob({ oldAtFirstSight: true }), T0, null)).toBe("quiet");
  });
  it("otherwise active for 90 s, then quiet without a change", () => {
    expect(freshness(ob(), T0, null)).toBe("active");
    expect(freshness(ob(), T0 + 90 * S - 1, null)).toBe("active");
    expect(freshness(ob(), T0 + 90 * S, null)).toBe("quiet");
  });
  it("after a change: active for 5 min", () => {
    const o = ob({ changes: 3, changedAt: T0 + MIN });
    expect(freshness(o, T0 + MIN + 5 * MIN - 1, null)).toBe("active");
    expect(freshness(o, T0 + MIN + 5 * MIN, null)).toBe("quiet");
  });
  it("checking for at most 15 s after markGap, then the first-sight rule from the gap", () => {
    const g = T0 + H;
    const o = ob({ changes: 5, changedAt: g - 10 * S, checking: true });
    expect(freshness(o, g, g)).toBe("checking");
    expect(freshness(o, g + 15 * S - 1, g)).toBe("checking");
    expect(freshness(o, g + 15 * S, g)).toBe("active");
    expect(freshness(o, g + 90 * S - 1, g)).toBe("active");
    expect(freshness(o, g + 90 * S, g)).toBe("quiet");
    expect(freshness(ob({ checking: true, oldAtFirstSight: true }), g + 15 * S, g)).toBe("quiet");
    // A checking flag without a recorded gap is ignored.
    expect(freshness(ob({ checking: true }), T0 + S, null)).toBe("active");
  });
  it("the re-look after a gap with a moved seq is active", () => {
    const o1 = observe(emptyObs(), [editing({ seq: 3 })], T0, knows);
    const g = markGap(o1, T0 + 2 * H);
    const o2 = observe(g, [editing({ seq: 4, updated_at: iso(T0 + 2 * H) })], T0 + 2 * H + S, knows);
    expect(freshness(o2.notes["d-alice-9f3c"], T0 + 2 * H + S, o2.checkingSince)).toBe("active");
    expect(freshness(o2.notes["d-alice-9f3c"], T0 + 2 * H + S + 5 * MIN, o2.checkingSince)).toBe("quiet");
    // fixer VP-4: moved, but written 2 h ago (before I slept; it arrived late) → quiet at once.
    const o3 = observe(g, [editing({ seq: 4, updated_at: iso(T0) })], T0 + 2 * H + S, knows);
    expect(freshness(o3.notes["d-alice-9f3c"], T0 + 2 * H + S, o3.checkingSince)).toBe("quiet");
  });
  it("this computer's clock going backwards without a noted gap never prolongs anything", () => {
    expect(freshness(ob({ changes: 1, changedAt: T0 }), T0 - S, null)).toBe("quiet");
    expect(freshness(ob(), T0 - S, null)).toBe("quiet");
  });
});

describe("P6 decide, clean tab", () => {
  it("idle notes alone → editable", () => {
    const n = [note(), bob()];
    const d = decide(input(n, look(n)));
    expect(d).toMatchObject({ mode: "editable", about: [], blockers: [], waiting: null, unconfirmed: false, yieldedTo: null });
    expect(d.peers.map((p) => p.deviceId)).toEqual(["d-bob-1a2b", "d-alice-9f3c"]); // Lab MacBook < Office iMac
    expect(decide(input([], emptyObs())).mode).toBe("editable");
  });

  it("read-only for an active editing note on my version", () => {
    const n = [editing()];
    const d = decide(input(n, look(n)));
    expect(d.mode).toBe("readOnly");
    expect(d.about).toEqual(["d-alice-9f3c"]);
    expect(d.blockers).toEqual([{ device_id: "d-alice-9f3c", epoch: 1 }]);
    expect(d.checking).toBe(false);
    expect(d.nextCheckAt).toBe(T0 + 90 * S);
    expect(d.peers[0]).toMatchObject({ basedOn: "myVersion", freshness: "active", sameUser: false, superseded: false, supersedesMe: false, updatedAt: iso(T0), editingSince: T0, changedAt: T0 });
    // A note without an observation counts as first seen now.
    expect(decide(input([editing({ updated_at: iso(T0 + H) })], emptyObs(), { now: T0 + H })).mode).toBe("readOnly");
    // … unless it is old by then.
    expect(decide(input(n, emptyObs(), { now: T0 + H })).mode).toBe("info");
  });

  it("same user", () => {
    const n = [editing({ user_name: " Zhuo " })];
    expect(decide(input(n, look(n))).peers[0].sameUser).toBe(true);
    expect(decide(input([editing({ user_name: "" })], emptyObs(), { me: { deviceId: ME.deviceId, userName: "" } })).peers[0].sameUser).toBe(false);
  });

  it("not read-only when quiet, on an older version, or overridden — information only", () => {
    const quiet = [editing({ updated_at: iso(T0 - H) })];
    expect(decide(input(quiet, look(quiet))).mode).toBe("info");
    const n = [editing()];
    expect(decide(input(n, look(n), { now: T0 + 90 * S })).mode).toBe("info"); // quiet after 90 s
    const older = [editing({ head: "r-0", base_revision: "r-0" })];
    const d = decide(input(older, look(older)));
    expect(d.mode).toBe("info");
    expect(d.peers[0].basedOn).toBe("older");
    const ov = decide(input(n, look(n), { overrides: [{ device_id: "d-alice-9f3c", epoch: 1 }] }));
    expect(ov.mode).toBe("info");
    expect(ov.about).toEqual(["d-alice-9f3c"]);
    // An override of another epoch does not count: a new claim.
    expect(decide(input(n, look(n), { overrides: [{ device_id: "d-alice-9f3c", epoch: 0 }] })).mode).toBe("readOnly");
  });

  it("overridden by another note: that note decides", () => {
    const a = editing({ epoch: 4 });
    const b = bob({ state: "editing", base_revision: "r-1", epoch: 2, supersedes: [{ device_id: "d-alice-9f3c", epoch: 4 }] });
    const d = decide(input([a, b], look([a, b])));
    expect(d.mode).toBe("readOnly");
    expect(d.about).toEqual(["d-bob-1a2b", "d-alice-9f3c"]); // both names
    expect(d.blockers).toEqual([{ device_id: "d-bob-1a2b", epoch: 2 }, { device_id: "d-alice-9f3c", epoch: 4 }]);
    expect(d.peers.find((p) => p.deviceId === "d-alice-9f3c")!.superseded).toBe(true);
    // The overriding note quiet → only the superseded one is left in B → information only.
    const obs = look([a, b]);
    const later = observe(obs, [editing({ epoch: 4, seq: 2 }), b], T0 + 80 * S, knows); // A moved, B did not
    const d2 = decide(input([editing({ epoch: 4, seq: 2 }), b], later, { now: T0 + 100 * S }));
    expect(d2.mode).toBe("info");
    // The overriding note idle → it no longer overrides.
    const bIdle = bob({ supersedes: [{ device_id: "d-alice-9f3c", epoch: 4 }] });
    expect(decide(input([a, bIdle], look([a, bIdle]))).mode).toBe("readOnly");
    expect(decide(input([a, bIdle], look([a, bIdle]))).about).toEqual(["d-alice-9f3c"]);
  });

  it("two blockers → both in about and blockers", () => {
    const a = editing();
    const b = bob({ state: "editing", base_revision: "r-1", epoch: 3 });
    const d = decide(input([b, a], look([a, b])));
    expect(d.mode).toBe("readOnly");
    expect(d.about).toEqual(["d-bob-1a2b", "d-alice-9f3c"]);
    expect(d.blockers).toHaveLength(2);
  });

  it("waiting for an unknown version: 2 min, then unconfirmed", () => {
    const n = [note({ head: "r-9" })];
    const obs = look(n);
    const d = decide(input(n, obs, { now: T0 + 10 * S }));
    expect(d.mode).toBe("waiting");
    expect(d.waiting).toEqual({ head: "r-9", deviceId: "d-alice-9f3c", since: T0, until: T0 + 2 * MIN });
    expect(d.about).toEqual(["d-alice-9f3c"]);
    expect(d.nextCheckAt).toBe(T0 + 2 * MIN);
    const d2 = decide(input(n, obs, { now: T0 + 2 * MIN }));
    expect(d2).toMatchObject({ mode: "editable", unconfirmed: true, waiting: null });
    // The version arrives → no wait, no "unconfirmed".
    const k2 = (id: string) => knows(id) || id === "r-9";
    expect(decide(input(n, observe(obs, n, T0 + MIN, k2), { now: T0 + MIN, knows: k2 }))).toMatchObject({ mode: "editable", unconfirmed: false });
  });

  it("waiting: 20 s for a note that was old at first sight", () => {
    const n = [editing({ head: "r-9", base_revision: "r-9", updated_at: iso(T0 - H) })];
    const obs = look(n);
    expect(decide(input(n, obs, { now: T0 + 19 * S })).mode).toBe("waiting");
    const d = decide(input(n, obs, { now: T0 + 20 * S }));
    expect(d.mode).toBe("info"); // quiet editing note on an unknown version: information only
    expect(d.unconfirmed).toBe(true);
  });

  it("waiting: an editing note based on an unknown version (head known) waits while it is active", () => {
    const n = [editing({ head: "r-1", base_revision: "r-7" })];
    const d = decide(input(n, look(n)));
    expect(d.mode).toBe("waiting");
    expect(d.waiting!.head).toBe("r-7");
    expect(d.peers[0].basedOn).toBe("unknown");
  });

  it("waiting: the candidate that lasts longest", () => {
    const a = note({ head: "r-8" });
    const b = bob({ head: "r-9" });
    const o1 = look([a]);
    const o2 = observe(o1, [a, b], T0 + 30 * S, knows);
    const d = decide(input([a, b], o2, { now: T0 + 40 * S }));
    expect(d.waiting).toEqual({ head: "r-9", deviceId: "d-bob-1a2b", since: T0 + 30 * S, until: T0 + 150 * S });
    expect(d.nextCheckAt).toBe(T0 + 90 * S + 30 * S); // r-8's wait ends first
  });

  it("checking: read-only while every standing note is being re-checked", () => {
    const n = [editing({ seq: 4 })];
    const g = markGap(look(n), T0 + H);
    const d = decide(input(n, g, { now: T0 + H + S }));
    expect(d).toMatchObject({ mode: "readOnly", checking: true });
    expect(d.peers[0].freshness).toBe("checking");
    expect(d.nextCheckAt).toBe(T0 + H + 15 * S);
    // Not listed after 15 s: as if first seen at the gap (active 90 s, then quiet).
    expect(decide(input(n, g, { now: T0 + H + 20 * S }))).toMatchObject({ mode: "readOnly", checking: false });
    expect(decide(input(n, g, { now: T0 + H + 90 * S })).mode).toBe("info");
  });

  it("the record behind the note: the note moved → alive now", () => {
    const o = look([editing({ seq: 1 })]);
    const d = decide(input([editing({ seq: 2 })], o, { now: T0 + 4 * MIN }));
    expect(d.mode).toBe("readOnly"); // first sight was 4 min ago, but the seq moved since
    expect(decide(input([editing({ seq: 1 })], o, { now: T0 + 4 * MIN })).mode).toBe("info");
  });

  it("my own note is never a peer", () => {
    const mine = editing({ device_id: ME.deviceId });
    expect(decide(input([mine], look([mine]))).mode).toBe("editable");
  });

  it("an editing note without a base counts for nothing but its head", () => {
    const n = [editing({ base_revision: null })];
    expect(decide(input(n, look(n))).mode).toBe("editable");
  });
});

describe("P7 decide, unsaved changes or holding", () => {
  const n = [editing()];
  it("bothEditing with an active editing peer; never readOnly / waiting", () => {
    for (const flags of [{ dirty: true }, { holding: true }, { dirty: true, holding: true }]) {
      const d = decide(input(n, look(n), flags));
      expect(d.mode).toBe("bothEditing");
      expect(d.about).toEqual(["d-alice-9f3c"]);
      expect(d.yieldedTo).toBeNull();
      expect(decide(input([note({ head: "r-9" })], look([note({ head: "r-9" })]), flags)).mode).toBe("editable");
    }
  });

  it("yieldedTo when a note names my epoch, not another epoch", () => {
    const over = bob({ state: "editing", base_revision: "r-1", epoch: 2, supersedes: [{ device_id: ME.deviceId, epoch: 5 }] });
    const d = decide(input([over], look([over]), { holding: true, myEpoch: 5, dirty: true }));
    expect(d).toMatchObject({ mode: "bothEditing", yieldedTo: "d-bob-1a2b", about: ["d-bob-1a2b"] });
    expect(d.peers[0].supersedesMe).toBe(true);
    expect(decide(input([over], look([over]), { holding: true, myEpoch: 4, dirty: true })).yieldedTo).toBeNull();
    // Only while I hold my claim.
    expect(decide(input([over], look([over]), { holding: false, myEpoch: 5, dirty: true })).yieldedTo).toBeNull();
    // Two notes naming me: the smaller device id.
    const over2 = note({ state: "editing", base_revision: "r-1", epoch: 2, supersedes: [{ device_id: ME.deviceId, epoch: 5 }] });
    expect(decide(input([over2, over], look([over, over2]), { holding: true, myEpoch: 5 })).yieldedTo).toBe("d-alice-9f3c");
    // It wins over resuming.
    expect(decide(input([over], look([over]), { holding: true, myEpoch: 5, resuming: true })).mode).toBe("bothEditing");
  });

  it("resuming while the flag is set and no note overrides me", () => {
    const d = decide(input(n, look(n), { holding: true, dirty: true, resuming: true }));
    expect(d).toMatchObject({ mode: "resuming", about: ["d-alice-9f3c"] });
    expect(decide(input([note()], look([note()]), { holding: true, resuming: true })).about).toEqual([]);
  });

  it("info when the only editing peers are quiet", () => {
    const q = [editing({ updated_at: iso(T0 - H) })];
    expect(decide(input(q, look(q), { dirty: true }))).toMatchObject({ mode: "info", about: ["d-alice-9f3c"] });
    expect(decide(input([note()], look([note()]), { dirty: true })).mode).toBe("editable");
  });

  it("an overridden peer that is still editing is 'both editing' (after Edit here)", () => {
    const d = decide(input(n, look(n), { holding: true, myEpoch: 1, overrides: [{ device_id: "d-alice-9f3c", epoch: 1 }] }));
    expect(d.mode).toBe("bothEditing");
  });
});

describe("P10 gaps and nextCheckAt", () => {
  it("gapDetected", () => {
    expect(gapDetected(T0, T0 + 5 * S + 89 * S, 5 * S)).toBe(false);
    expect(gapDetected(T0, T0 + 5 * S + 90 * S, 5 * S)).toBe(false);
    expect(gapDetected(T0, T0 + 5 * S + 91 * S, 5 * S)).toBe(true);
    expect(gapDetected(T0, T0 - 1, 5 * S)).toBe(true);
    expect(gapDetected(T0, T0, 5 * S)).toBe(false);
  });

  it("advancing to nextCheckAt changes the mode or gives a later time", () => {
    const cases = [
      { n: [editing()], obs: look([editing()]), at: T0 + 10 * S },
      { n: [note({ head: "r-9" })], obs: look([note({ head: "r-9" })]), at: T0 + 10 * S },
      { n: [editing({ seq: 2 })], obs: observe(look([editing()]), [editing({ seq: 2 })], T0 + 30 * S, knows), at: T0 + 30 * S },
      { n: [editing()], obs: markGap(look([editing()]), T0 + 10 * S), at: T0 + 10 * S },
    ];
    for (const c of cases) {
      let now = c.at;
      let d = decide(input(c.n, c.obs, { now }));
      const modes = [d.mode];
      for (let i = 0; i < 10 && d.nextCheckAt !== null; i++) {
        expect(d.nextCheckAt).toBeGreaterThan(now);
        // Just before it: unchanged.
        expect(decide(input(c.n, c.obs, { now: d.nextCheckAt - 1 })).mode).toBe(d.mode);
        now = d.nextCheckAt;
        const next = decide(input(c.n, c.obs, { now }));
        expect(next.mode !== d.mode || next.nextCheckAt === null || next.nextCheckAt > now).toBe(true);
        d = next;
        modes.push(d.mode);
      }
      expect(d.nextCheckAt).toBeNull(); // it settles
      expect(modes.length).toBeGreaterThan(1);
    }
  });
});

describe("P11 helpers", () => {
  it("olderPeer", () => {
    const m = manifestOf([rev("r-1", [], { device_id: "d-alice-9f3c", device_name: "Office iMac", user_name: "Alice" }),
      rev("r-2", ["r-1"], { device_id: "" })]);
    expect(olderPeer(m, ME.deviceId, [])).toEqual({ deviceId: "d-alice-9f3c", deviceName: "Office iMac", userName: "Alice" });
    expect(olderPeer({ ...m, features: 2 }, ME.deviceId, [])).toBeNull();
    expect(olderPeer(m, "d-alice-9f3c", [])).toBeNull(); // saved by me
    expect(olderPeer(m, ME.deviceId, [note()])).toBeNull(); // that computer shows notes
    expect(olderPeer(m, ME.deviceId, [bob()])).not.toBeNull();
    expect(olderPeer({ ...m, head: "r-x" }, ME.deviceId, [])).toBeNull();
    const anon = manifestOf([rev("r-1", [], { device_id: "" })]);
    expect(olderPeer(anon, ME.deviceId, [])).toBeNull();
    // A cycle does not hang.
    const cyc = manifestOf([rev("r-1", ["r-2"], { device_id: "" }), rev("r-2", ["r-1"], { device_id: "" })]);
    expect(olderPeer(cyc, ME.deviceId, [])).toBeNull();
  });

  it("multiDevice", () => {
    const mine = manifestOf([rev("r-1", [], { device_id: ME.deviceId }), rev("r-2", ["r-1"], { device_id: "" })]);
    expect(multiDevice(mine, ME.deviceId, [])).toBe(false);
    expect(multiDevice(mine, ME.deviceId, [note()])).toBe(true);
    expect(multiDevice(manifestOf([rev("r-1", [], { device_id: "d-x" })]), ME.deviceId, [])).toBe(true);
    expect(multiDevice(null, ME.deviceId, [])).toBe(false);
  });

  it("shareDecision, every row", () => {
    const p = { choice: null, fallback: "auto" as const, untitled: false, cloud: false, multiDevice: false };
    expect(shareDecision({ ...p, untitled: true, choice: "always" })).toEqual({ on: false, why: "untitled" });
    expect(shareDecision({ ...p, choice: "never", cloud: true })).toEqual({ on: false, why: "never" });
    expect(shareDecision({ ...p, choice: "always" })).toEqual({ on: true, why: "always" });
    expect(shareDecision({ ...p, cloud: true })).toEqual({ on: true, why: "cloud" });
    expect(shareDecision({ ...p, multiDevice: true })).toEqual({ on: true, why: "otherComputers" });
    expect(shareDecision(p)).toEqual({ on: false, why: "local" });
    expect(shareDecision({ ...p, fallback: "never", cloud: true })).toEqual({ on: false, why: "never" });
    expect(shareDecision({ ...p, fallback: "always" })).toEqual({ on: true, why: "always" });
    expect(shareDecision({ ...p, fallback: "never", choice: "auto", cloud: true })).toEqual({ on: true, why: "cloud" });
  });

  it("liveNoteHeads", () => {
    expect(liveNoteHeads([editing({ head: "r-3", base_revision: "r-2" }), note({ head: "r-1" }), bob({ head: "r-3" }), note({ head: null })]))
      .toEqual(["r-1", "r-2", "r-3"]);
    expect(liveNoteHeads([])).toEqual([]);
  });

  it("cleanupTargets: 23 h 59 min no, 24 h yes, never own, never another document's note", () => {
    const at = T0 + 24 * H;
    const r = (over: Parameters<typeof record>[1]) => record(note(), over);
    expect(cleanupTargets([r({ unchangedSince: at - 24 * H + MIN })], at)).toEqual([]);
    expect(cleanupTargets([r({ unchangedSince: at - 24 * H, file: "/d/a.laguse", sha: "x" })], at)).toEqual([{ file: "/d/a.laguse", sha: "x" }]);
    expect(cleanupTargets([r({ unchangedSince: T0 - H, own: true })], at)).toEqual([]);
    expect(cleanupTargets([r({ unchangedSince: T0 - H, applies: false, orphan: false })], at)).toEqual([]);
    expect(cleanupTargets([r({ unchangedSince: T0 - H, applies: false, orphan: true, file: "/d/o.laguse", sha: "o" })], at))
      .toEqual([{ file: "/d/o.laguse", sha: "o" }]);
    expect(cleanupTargets([r({ unchangedSince: 0 })], at)).toEqual([]);
  });

  it("duplicateIdentity", () => {
    const me = { deviceId: ME.deviceId, sessionId: ME.sessionId };
    const twin = (seq: number) => record(note({ device_id: ME.deviceId, session_id: "s-twin", seq }), { own: true });
    expect(duplicateIdentity([twin(3)], [twin(4)], me)).toBe(true);
    expect(duplicateIdentity([twin(3)], [twin(3)], me)).toBe(false); // a crash leftover never moves
    expect(duplicateIdentity([], [twin(4)], me)).toBe(false);
    const mine = (seq: number) => record(note({ device_id: ME.deviceId, session_id: ME.sessionId, seq }), { own: true });
    expect(duplicateIdentity([mine(3)], [mine(9)], me)).toBe(false); // my own heartbeat
    expect(duplicateIdentity([record(note({ seq: 1 }))], [record(note({ seq: 2 }))], me)).toBe(false); // another device
  });
});

describe("P9 the other computer's clock", () => {
  it("updated_at is read only for the first-sight rule, the tie-break, display and the format", () => {
    const src: string = presenceSource;
    const noBlocks = src.replace(/\/\*[\s\S]*?\*\//g, "");
    const lines = noBlocks.split("\n").filter((l) => /updated_at/.test(l) && !/^\s*\/\//.test(l));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).toMatch(/clock-ok: (format|first sight|tie-break|display)/);
    expect(lines.filter((l) => /first sight/.test(l))).toHaveLength(1);
    // Date.parse only in the first-sight rule; no clock of this computer is read anywhere.
    const code = noBlocks.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
    expect(code.match(/Date\.parse/g)).toHaveLength(1);
    expect(code).not.toMatch(/Date\.now|new Date|performance\.now|Math\.random/);
  });
});

describe("api object", () => {
  it("has every member", () => {
    expect(Object.keys(api).sort()).toEqual([
      "cleanupTargets", "decide", "deviceTag", "duplicateIdentity", "emptyObs", "freshness", "gapDetected", "isNoteFileName",
      "liveNoteHeads", "markGap", "multiDevice", "noteApplies", "noteFileName", "noteText", "observe", "olderPeer", "parseNote",
      "pickPerDevice", "sanitizeNamePart", "shareDecision",
    ]);
  });
});
