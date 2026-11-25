// Regression tests for the phase 3 verifier findings fixed by the fixer (VP-1 … VP-5, VS-1 … VS-6, F2, F6, F9).
// Two or three MemoryDevices on the ManualClock, as in presence.multidevice.test.ts.

import { describe, expect, it, vi } from "vitest";
import { isDirty } from "../../../store/graphStore";
import { emptyObs, markGap, noteText, observe } from "./presence";
import { createPreviewWorld, freezePreviewPersist, PREVIEW_STORAGE_KEY } from "./previewBackend";
import type { NoteJson } from "./contract";
import {
  DBX, PFILE, activeTab, computer, editCell, editTitle, flush, group, guardOf, makeWorld, modeOf, notesBeside, notesOf, seedFile, start, tick,
  withAnswer, type Computer,
} from "./testkit";

vi.setConfig({ testTimeout: 120_000 });
const S = 1000, MIN = 60 * S;

const readOnly = (c: Computer) => guardOf(c) === "editingElsewhere" || guardOf(c) === "checking" || guardOf(c) === "waiting";

describe("fixer VP-1: an earlier device id (alias) is not this computer's own", () => {
  it("a Mac set up from another Mac's backup sees that Mac editing and never deletes its note", async () => {
    const w = makeWorld();
    const spec = [["d-a1a1", "Mac mini"], ["d-b2b2", "MacBook"], ["d-c3c3", "New Mac"]] as const;
    const cs: Computer[] = [];
    for (let k = 0; k < 3; k++) {
      cs.push(await start(await computer(w, {
        device_id: spec[k][0], device_name: spec[k][1], user_name: "Zhuo", session_id: `s-${k}`,
        uploadDelayMs: 500, downloadDelayMs: 500, noteUploadDelayMs: 500, noteDownloadDelayMs: 500,
      })));
    }
    const [a, b, c] = cs;
    // C's device.json after Migration Assistant: a new id, A's id kept as an alias.
    (c.dev as unknown as { aliases: string[] }).aliases.push("d-a1a1");
    await seedFile(w, a.dev, PFILE);
    await tick(w, 3 * S);
    for (const x of cs) expect((await x.ses.getState().open(PFILE)).ok).toBe(true);
    await tick(w, 5 * S);
    await editCell(a, "A1");
    await tick(w, 5 * S);
    expect(guardOf(b)).toBe("editingElsewhere");
    expect(guardOf(c)).toBe("editingElsewhere");
    const editingOn = (x: Computer) => notesBeside(x.dev, PFILE).filter((n) => n.note?.device_id === "d-a1a1" && n.note?.state === "editing").length;
    // 2 min of A typing: B and C stay read-only, A's note is never removed by C's writes.
    for (let k = 0; k < 24; k++) {
      a.graph.getState().setCell(2, 0, 0, `k${k}`);
      await flush();
      await tick(w, 5 * S, 500);
      expect(guardOf(b), `B at ${k}`).toBe("editingElsewhere");
      expect(guardOf(c), `C at ${k}`).toBe("editingElsewhere");
      expect(editingOn(b), `A's note on B at ${k}`).toBe(1);
    }
    expect(isDirty(a.graph.getState())).toBe(true);
    expect(editingOn(a)).toBe(1);
  });
});

describe("fixer VP-2: Edit here lasts as long as this computer is editing", () => {
  // Changed by fixer round 2 (RV-4): Edit here without typing is no longer ended by the 30 s rule (it means "I'm
  // editing now"); leaving the window (or the tab) ends it, and then the tab is read-only again while the other
  // computer edits on — VP-2's point.
  it("after Edit here without typing and leaving the window, the tab is read-only again while the other computer edits on", async () => {
    const handlers = new Map<string, (() => void)[]>();
    const win = { addEventListener: (ev: string, h: () => void) => { handlers.set(ev, [...(handlers.get(ev) ?? []), h]); } } as unknown as Window;
    const g = await group(2, { delay: 500, deps: [{}, { window: win }] });
    const [a, b] = g.cs;
    await editCell(a, "A1");
    await tick(g.w, 3 * S);
    expect(guardOf(b)).toBe("editingElsewhere");
    expect(await b.ses.getState().editHere()).toBe(true);
    expect(guardOf(b)).toBe(null);
    await tick(g.w, 40 * S, 500); // B typed nothing: still editing (RV-4)
    expect(notesOf(b.dev, g.path, "d-b2b2")[0].note!.state).toBe("editing");
    for (const h of handlers.get("blur") ?? []) h(); // B leaves the window: its hold ends
    await flush();
    await tick(g.w, 2 * S, 500);
    expect(notesOf(b.dev, g.path, "d-b2b2")[0].note!.state).toBe("idle");
    let ro = 0;
    for (let k = 0; k < 9; k++) {
      await editCell(a, `A more ${k}`);
      await tick(g.w, 20 * S, 500);
      if (k % 3 === 2) { await a.ses.getState().save(); await editCell(a, `A after save ${k}`); }
      if (guardOf(b) === "editingElsewhere") ro++;
    }
    expect(ro).toBeGreaterThanOrEqual(8);
  });
});

/** Settle pending promises without moving the clock. */
async function settleNow(rounds = 12): Promise<void> {
  const im = (globalThis as { setImmediate?: (f: () => void) => void }).setImmediate!;
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => im(r));
}

describe("fixer VP-3: no editable gap between the editor's saved file and its rewritten note", () => {
  for (const [fd, nd] of [[0, 5000], [1000, 3000], [0, 0], [5000, 0]] as const) {
    it(`file delay ${fd} ms, note delay ${nd} ms`, async () => {
      const g = await group(2, { delay: fd, noteDelay: nd });
      for (const c of g.cs) { c.dev.setSyncDelay(fd, "files"); c.dev.setSyncDelay(nd, "notes"); }
      const [a, b] = g.cs;
      await editCell(a, "v1");
      await tick(g.w, 2 * Math.max(fd, nd) + 8 * S);
      expect(guardOf(b)).toBe("editingElsewhere");
      const editable: number[] = [];
      for (let k = 0; k < 3; k++) {
        expect((await a.ses.getState().save()).ok).toBe(true);
        await editCell(a, `w${k}`); // keeps typing
        for (let t = 0; t < 20 * S; t += 250) {
          g.w.clock.advance(250);
          await settleNow();
          if (!readOnly(b)) editable.push(g.w.clock.now());
        }
      }
      expect(editable.length).toBe(0);
      // The saves arrived (live refresh while read-only).
      expect(b.graph.getState().doc!.cells[0][0][0]).toBe("w1");
    });
  }
});

describe("fixer VP-4: an old note that arrives late does not count as alive", () => {
  for (const how of ["offline", "asleep"] as const) {
    it(`B was ${how} while A started editing and then crashed`, async () => {
      const g = await group(2, { delay: 1000 });
      const [a, b] = g.cs;
      if (how === "offline") b.dev.setOnline(false); else b.dev.sleep(30 * MIN + 10 * S);
      await editCell(a, "A1");
      await tick(g.w, 5 * S);
      a.dev.crash();
      await tick(g.w, 30 * MIN, 5000);
      if (how === "offline") b.dev.setOnline(true);
      let ro = 0;
      for (let k = 0; k < 3 * 60; k++) { await tick(g.w, 1000); if (readOnly(b)) ro++; }
      expect(ro).toBeLessThan(20);
      expect(modeOf(b)).toBe("info");
    });
  }
});

describe("fixer VP-5: after a wake-up the note is not kept up to date without input", () => {
  it("the re-claim by timer writes the note once; no rewrites until the person types", async () => {
    const g = await group(2, { delay: 500 });
    const [a] = g.cs;
    await editCell(a, "A1");
    await tick(g.w, 70 * S, 1000);
    a.dev.sleep(3 * MIN);                    // the last input stays within 10 min of the wake-up
    await tick(g.w, 3 * MIN + S, 5000);
    await tick(g.w, 50 * S, 1000); // the after-sleep window (45 s) ends: re-claim with a new epoch
    expect(modeOf(a)).not.toBe("resuming");
    const seq0 = notesOf(a.dev, g.path, "d-a1a1")[0].note!.seq;
    await tick(g.w, 4 * MIN, 5000);
    expect(notesOf(a.dev, g.path, "d-a1a1")[0].note!.seq).toBe(seq0);
    await editCell(a, "A2");
    await tick(g.w, 70 * S, 1000);
    expect(notesOf(a.dev, g.path, "d-a1a1")[0].note!.seq).toBeGreaterThan(seq0);
  });
});

describe("fixer VS-1: clicks after Save do not keep the other computers read-only", () => {
  for (const visible of [false, true]) {
    it(`window activity ${visible ? "in the graphs" : "in another tool"} after Save`, async () => {
      let act = Number.NEGATIVE_INFINITY;
      const g = await group(2, { users: ["Zhuo", "Alice"], deps: [{ lastActivity: () => act, graphsVisible: () => visible }, {}] });
      const [a, b] = g.cs;
      await editCell(a, "A1");
      expect((await a.ses.getState().save()).ok).toBe(true);
      await tick(g.w, 3 * S);
      expect(guardOf(b)).toBe("editingElsewhere");
      for (let s = 0; s < 24; s++) { act = g.w.clock.now(); await tick(g.w, 5 * S, 1000); } // 2 min of clicks
      expect(notesOf(a.dev, g.path, "d-a1a1")[0].note!.state).toBe("idle");
      expect(guardOf(b)).toBe(null);
    });
  }
});

describe("fixer VS-2: Save As 'the same analysis' under a new name in the same folder", () => {
  it("leaves no note about the old file behind", async () => {
    const g = await group(2, { users: ["Zhuo", "Alice"] });
    const [a, b] = g.cs;
    await editCell(a, "A1");
    await tick(g.w, 3 * S);
    expect(guardOf(b)).toBe("editingElsewhere");
    a.picks.push(`${DBX}/Dose response v2.lag`);
    const r = await a.ses.getState().saveAs("same");
    await flush();
    expect(r.ok).toBe(true);
    await tick(g.w, 5 * S);
    const mine = notesBeside(a.dev, g.path).filter((n) => n.note?.device_id === "d-a1a1");
    expect(mine.map((n) => n.note!.document_name)).toEqual(["Dose response v2.lag"]);
    await tick(g.w, 2 * MIN, 5000);
    expect(notesBeside(a.dev, g.path).filter((n) => n.note?.device_id === "d-a1a1").map((n) => n.note!.document_name)).toEqual(["Dose response v2.lag"]);
    expect(guardOf(b)).toBe(null);
  });
});

describe("fixer VS-5: a new identity at most once per launch", () => {
  it("a second duplicate sighting in the same launch does not renew again", async () => {
    const g = await group(1, { delay: 0 });
    const [a] = g.cs;
    const dir = g.path.slice(0, g.path.lastIndexOf("/"));
    const place = async (id: string, session: string, seq: number, tag: string) => {
      const mine = notesOf(a.dev, g.path, (await a.dev.device()).device_id)[0].note!;
      const n: NoteJson = { ...mine, device_id: id, session_id: session, seq, device_name: "Twin", updated_at: new Date(g.w.clock.now()).toISOString() };
      a.dev.placeNote(`${dir}/Dose response (in use on Twin, ${tag}).laguse`, noteText(n));
      await tick(g.w, 3 * S);
    };
    const calls = () => a.dev.presenceCalls.filter((x) => x.cmd === "newDeviceId").length;
    // Another running app with my id: its note's seq grows under another session → a new identity.
    await place("d-a1a1", "s-twin", 5, "0001");
    await place("d-a1a1", "s-twin", 6, "0001");
    expect(calls()).toBe(1);
    // The other copy picks up the new id too (one device.json for both): not renewed again in this launch.
    const id2 = (await a.dev.device()).device_id;
    expect(id2).not.toBe("d-a1a1");
    await place(id2, "s-twin2", 1, "0002");
    await place(id2, "s-twin2", 2, "0002");
    expect(calls()).toBe(1);
  });
});

// Changed by the typed-edit fixer round (V-2): the flush still writes pending Scratchpad changes before the guard,
// but no longer commits an open cell entry (a typed editor stays open and editable under the guard).
describe("fixer VS-6: the after-sleep guard writes pending Scratchpad changes first", () => {
  it("flushScratch runs before the resuming guard is set, without commitEdit", async () => {
    const order: string[] = [];
    let ref: Computer | null = null;
    const g = await group(1, {
      deps: [{ flushScratch: (o?: { commitEdit?: boolean }) => { order.push(`flush:${ref ? guardOf(ref) ?? "-" : "?"}:${!!o?.commitEdit}`); } }],
    });
    const [a] = g.cs;
    ref = a;
    await editCell(a, "A1");
    await tick(g.w, 5 * S);
    order.length = 0;
    a.dev.sleep(5 * MIN);
    await tick(g.w, 5 * MIN + 2 * S, 1000);
    expect(guardOf(a)).toBe("resuming");
    expect(order[0]).toBe("flush:-:false");
  });
});

describe("fixer VS-4: opening never waits long for the notes", () => {
  it("a stalled listing does not hold the document back; its answer is taken in later", async () => {
    const g = await group(2, { users: ["Zhuo", "Alice"] });
    const [a, b] = g.cs;
    await editCell(a, "A1");
    await tick(g.w, 3 * S);
    await b.ses.getState().closeTab(activeTab(b).key);
    await tick(g.w, S);
    const orig = b.dev.presenceList.bind(b.dev);
    let slow = true;
    b.dev.presenceList = (p: string, id: string) => (slow
      ? new Promise((res) => g.w.clock.schedule(8 * S, () => { void orig(p, id).then(res); }))
      : orig(p, id));
    let done = false;
    const open = b.ses.getState().open(g.path).then((r) => { done = true; return r; });
    await tick(g.w, 2 * S, 250);
    expect(done).toBe(true);
    expect((await open).ok).toBe(true);
    slow = false;
    await tick(g.w, 10 * S, 500);
    expect(guardOf(b)).toBe("editingElsewhere");
  });
});

describe("fixer F2: the status line after my own Save that combined", () => {
  it("never says 'someone else' for an automatic combine of my save", async () => {
    const g = await group(2, { users: ["Zhuo", "Alice"], delay: 500 });
    const [a, b] = g.cs;
    await editCell(a, "A1");            // my table …
    await editTitle(b, "Alice's title"); // … and Alice's graph settings: combined without a question
    await tick(g.w, 2 * S);
    expect((await b.ses.getState().save()).ok).toBe(true);
    await tick(g.w, 3 * S);
    expect((await a.ses.getState().save()).ok).toBe(true);
    await tick(g.w, 10 * S, 500);
    const head = activeTab(a).baseRevision!;
    const rev = a.dev.localFile(g.path)!.manifest.revisions.find((r) => r.id === head)!;
    expect(rev.parents.length).toBe(2);             // my save was combined with Alice's
    expect(rev.device_id).toBe("");                 // … by the automatic combine (no author)
    expect(activeTab(a).dirty).toBe(false);
    expect(activeTab(a).presence?.status ?? null).toBe(null);   // "All changes saved", not "Someone else saved"
  });
});

describe("fixer F6: the start of another computer's editing survives this computer's sleep", () => {
  it("observe keeps editingSince over the re-look after a gap", () => {
    const T0 = Date.UTC(2026, 10, 22, 8, 0, 0);
    const base: NoteJson = {
      format: "lasgraph-presence", v: 1, analysis_id: "a-1", document_name: "X.lag", device_id: "d-alice", session_id: "s-1",
      device_name: "Office iMac", user_name: "Alice", state: "editing", head: "r-1", base_revision: "r-1", epoch: 2, seq: 5,
      supersedes: null, updated_at: new Date(T0).toISOString(), request_to: null, handover_to: null, features: 2,
    };
    const o1 = observe(emptyObs(), [base], T0, () => true);
    const g = markGap(o1, T0 + 2 * 3600 * S);
    const same = observe(g, [base], T0 + 2 * 3600 * S + S, () => true);
    expect(same.notes["d-alice"].editingSince).toBe(T0);
    const moved = observe(g, [{ ...base, seq: 9, updated_at: new Date(T0 + 2 * 3600 * S).toISOString() }], T0 + 2 * 3600 * S + S, () => true);
    expect(moved.notes["d-alice"].editingSince).toBe(T0);
    const newEpoch = observe(g, [{ ...base, epoch: 3, seq: 9, updated_at: new Date(T0 + 2 * 3600 * S).toISOString() }], T0 + 2 * 3600 * S + S, () => true);
    expect(newEpoch.notes["d-alice"].editingSince).toBe(T0 + 2 * 3600 * S + S);
  });
});

describe("fixer F9: a note written again after Never → Always continues its seq", () => {
  it("the seq never goes down", async () => {
    const g = await group(2);
    const [a] = g.cs;
    const key = activeTab(a).key;
    const seqNow = () => notesOf(a.dev, g.path, "d-a1a1")[0]?.note?.seq ?? null;
    const s1 = seqNow()!;
    await a.ses.getState().setSharing(key, "never");
    await tick(g.w, S);
    expect(seqNow()).toBe(null);
    await a.ses.getState().setSharing(key, "always");
    await tick(g.w, S);
    expect(seqNow()!).toBeGreaterThan(s1);
  });
});

describe("fixer F7: the simulator's Reset is not undone by the page's unload", () => {
  it("persistNow does nothing once frozen", async () => {
    const store = new Map<string, string>();
    const ls = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
    const g = globalThis as { localStorage?: unknown };
    const had = g.localStorage;
    g.localStorage = ls;
    try {
      const p = createPreviewWorld({ persist: true, drive: false });
      await p.ready;
      p.persistNow();
      expect(store.has(PREVIEW_STORAGE_KEY)).toBe(true);
      freezePreviewPersist();
      store.delete(PREVIEW_STORAGE_KEY);
      p.persistNow();
      expect(store.has(PREVIEW_STORAGE_KEY)).toBe(false);
    } finally { g.localStorage = had; }
  });
});

void withAnswer;
