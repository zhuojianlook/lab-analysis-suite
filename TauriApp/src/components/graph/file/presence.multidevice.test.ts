// Phase 3 multi-device scenarios (phase3-contract.md §8 X1 / X2; plan §13): one file in a synced folder, A edits,
// saves, edits, saves and stops while B and C have it open and clean — under sync delays, offline stretches,
// notes and files arriving in either order, wrong clocks, sleep, crashes, a shared device id, conflict copies of
// notes, an app without notes, Edit here and two editors. After every simulated second the X2 invariants are
// checked on every computer:
//   1. a tab with unsaved changes (or holding) is never frozen: guard null or "resuming", and "resuming" ≤ 45 s;
//   2. a clean tab is read-only only while a fresh editing note on its version exists (by its own observation);
//      "waiting" ≤ 2 min, "checking" ≤ 15 s;
//   3. 5 min 10 s (+ the sync delay) after A crashed or went to sleep nobody has a guard;
//   4. at most one combine per pair; 5. no note is left after a normal quit; 7. nothing is lost and everyone ends
//   on the same version.
import { describe, expect, it, vi } from "vitest";
import { isDirty } from "../../../store/graphStore";
import { LIMITS_P3 } from "./contract";
import { noteText } from "./presence";
import {
  DOCS, activeTab, computer, duplicateCombines, editCell, flush, group, guardOf, lostVersions, makeWorld, notesBeside, seedFile, start, tick,
  type Computer, type Group, type TestDeps,
} from "./testkit";

vi.setConfig({ testTimeout: 120_000 });

/** Let every pending promise chain run (setImmediate: no 1 ms timer clamp). */
async function settleNow(rounds = 12): Promise<void> {
  const immediate = (globalThis as unknown as { setImmediate: (f: () => void) => void }).setImmediate;
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => immediate(r));
}

const S = 1000, MIN = 60 * S, H = 60 * MIN;

interface Track { resumingSince: number | null; waitingSince: number | null; checkingSince: number | null }

class Checker {
  readonly tracks = new Map<Computer, Track>();
  /** Device → when it stopped (crash / sleep): others must have no guard 5 min 10 s (+ delay) later. */
  readonly stopped = new Map<string, number>();
  failures: string[] = [];
  constructor(readonly g: Group, readonly slack: number) {}

  check(): void {
    const now = this.g.w.clock.now();
    for (const c of this.g.cs) {
      if (c.dev.isCrashed() || c.dev.isAsleep()) continue;
      const tab = c.ses.getState().tabs.find((t) => t.key === c.ses.getState().activeKey);
      if (!tab?.path) continue;
      const tr = this.tracks.get(c) ?? { resumingSince: null, waitingSince: null, checkingSince: null };
      this.tracks.set(c, tr);
      const guard = guardOf(c);
      const pr = c.ses.internal.presence(tab.key)!;
      const dirty = isDirty(c.graph.getState());
      const at = `${c.dev.name} @${(now - this.g.w.clock.now()) || ""}${new Date(now).toISOString()}`;
      // 1. never frozen
      if ((dirty || pr.holding) && guard !== null && guard !== "resuming") this.failures.push(`${at}: guard ${guard} on a tab with unsaved changes`);
      const since = (k: keyof Track, on: boolean, max: number, what: string) => {
        if (!on) { tr[k] = null; return; }
        tr[k] ??= now;
        if (now - tr[k]! > max) this.failures.push(`${at}: ${what} for ${now - tr[k]!} ms`);
      };
      since("resumingSince", guard === "resuming", LIMITS_P3.resumeMs + 2 * S, "resuming");
      since("waitingSince", guard === "waiting", LIMITS_P3.waitNewerMs + 2 * S, "waiting");
      since("checkingSince", guard === "checking", LIMITS_P3.recheckMaxMs + 2 * S, "checking");
      // 2. read-only only with a fresh editing note on my version (by my own observation, my clock)
      if (guard === "editingElsewhere" && !dirty) {
        const cnow = c.ses.internal.deps.now();
        const ok = pr.records.some((r) => {
          if (!r.applies || r.own || r.note.state !== "editing" || r.note.base_revision !== tab.baseRevision) return false;
          const o = pr.obs.notes[r.note.device_id];
          if (!o) return true;
          if (o.changes > 0) return cnow - o.changedAt < LIMITS_P3.staleMs + S;
          return !o.oldAtFirstSight && cnow - o.firstSeenAt < LIMITS_P3.freshFirstMs + S;
        });
        if (!ok) this.failures.push(`${at}: read-only without a fresh editing note on its version`);
      }
      // 3. nobody waits for a stopped computer
      for (const [dev, t0] of this.stopped) {
        const stillStopped = this.g.cs.some((x) => x.dev.deviceId === dev && (x.dev.isCrashed() || x.dev.isAsleep()));
        const d = pr.decision;
        const because = !!d && (d.blockers.some((b) => b.device_id === dev) || d.waiting?.deviceId === dev || (d.checking && d.about.includes(dev)));
        if (stillStopped && c.dev.deviceId !== dev && now - t0 > LIMITS_P3.staleMs + 10 * S + this.slack && guard !== null && guard !== "tooNew" && because) {
          this.failures.push(`${at}: guard ${guard} ${now - t0} ms after ${dev} stopped`);
        }
      }
    }
  }

  async run(ms: number): Promise<void> {
    const step = ms > 3 * MIN ? 5 * S : S;
    for (let t = 0; t < ms; t += step) {
      const d = Math.min(step, ms - t);
      for (let u = 0; u < d; u += 500) { this.g.w.clock.advance(Math.min(500, d - u)); await settleNow(); }
      this.check();
    }
    await flush();
  }
}

interface Opts {
  delay?: number;
  noteDelay?: number;
  fileDelay?: number;
  users?: string[];
  ids?: string[];
  deps?: TestDeps[];
  /** Before A's first edit / after it / after save 1 / after save 2. */
  beforeEdit?: (x: Ctx) => Promise<void> | void;
  afterEdit1?: (x: Ctx) => Promise<void> | void;
  afterSave1?: (x: Ctx) => Promise<void> | void;
  afterSave2?: (x: Ctx) => Promise<void> | void;
  /** Skip A's second edit and saves (A crashed or went away). */
  aStops?: boolean;
  /** Extra time at the end before the final checks. */
  settle?: number;
}

interface Ctx { g: Group; ck: Checker; a: Computer; b: Computer; c: Computer }

async function scenario(o: Opts = {}): Promise<Ctx> {
  const delay = o.delay ?? 1000;
  const g = await group(3, { delay, noteDelay: o.noteDelay, users: o.users, ids: o.ids, deps: o.deps });
  if (o.fileDelay !== undefined) for (const c of g.cs) c.dev.setSyncDelay(o.fileDelay, "files");
  if (o.noteDelay !== undefined) for (const c of g.cs) c.dev.setSyncDelay(o.noteDelay, "notes");
  const slack = 2 * Math.max(delay, o.noteDelay ?? 0, o.fileDelay ?? 0);
  const ck = new Checker(g, slack);
  const [a, b, c] = g.cs;
  const x: Ctx = { g, ck, a, b, c };
  await o.beforeEdit?.(x);
  await editCell(a, "v1");
  ck.check();
  await o.afterEdit1?.(x);
  await ck.run(20 * S);
  if (!o.aStops) {
    if (!a.dev.isCrashed()) await a.ses.getState().save();
    await o.afterSave1?.(x);
    await ck.run(20 * S);
    await editCell(a, "v2");
    await ck.run(20 * S);
    await a.ses.getState().save();
    await o.afterSave2?.(x);
  }
  await ck.run(LIMITS_P3.lingerMs + 2 * MIN + slack + (o.settle ?? 0));
  return x;
}

/** X2 end checks: nothing lost, no duplicate combines, everyone on the same version, no invariant broken;
 *  then a normal quit everywhere leaves no note behind (X2.5). */
async function finish(x: Ctx, opts: { value?: string; sameHead?: boolean } = {}): Promise<void> {
  const { g, ck } = x;
  expect(ck.failures.slice(0, 5)).toEqual([]);
  expect(lostVersions(g.w)).toEqual([]);
  expect(duplicateCombines(g.w)).toEqual([]);
  const live = g.cs.filter((c) => !c.dev.isCrashed());
  if (opts.sameHead !== false) {
    const heads = new Set(live.map((c) => c.dev.localHead(g.path)));
    expect(heads.size).toBe(1);
    for (const c of live) if (!isDirty(c.graph.getState())) expect(activeTab(c).baseRevision).toBe(c.dev.localHead(g.path));
  }
  if (opts.value !== undefined) for (const c of live) if (!isDirty(c.graph.getState())) expect(c.graph.getState().doc!.cells[0][0][0]).toBe(opts.value);
  for (const c of live) expect(guardOf(c) === null || guardOf(c) === "tooNew").toBe(true);
  for (const c of live) c.dev.quit();
  await tick(g.w, 4 * MIN, 5000);
  for (const c of live) {
    const id = (await c.dev.device()).device_id;
    for (const d of g.cs) {
      const left = notesBeside(d.dev, g.path).filter((n) => n.note?.device_id === id && !/conflicted copy/.test(n.name));
      expect(left.map((n) => n.name), `${c.dev.name}'s note left on ${d.dev.name}`).toEqual([]);
    }
  }
}

describe("X1 the matrix: A edits, saves, edits, saves, stops; B and C watch", () => {
  for (const delay of [0, 5 * S, 60 * S]) {
    it(`sync delay ${delay / S} s`, async () => {
      const x = await scenario({
        delay,
        afterEdit1: async ({ b, ck }) => {
          await ck.run(2 * delay + 2 * S);
          expect(guardOf(b)).toBe("editingElsewhere");
        },
      });
      await finish(x, { value: "v2" });
    });
  }

  it("B offline during A's whole session, then back", async () => {
    const x = await scenario({
      beforeEdit: ({ b }) => b.dev.setOnline(false),
      afterSave2: async ({ b, ck }) => { await ck.run(40 * S); expect(guardOf(b)).toBe(null); b.dev.setOnline(true); },
    });
    await finish(x, { value: "v2" });
  });

  it("A offline (its notes never leave), then back", async () => {
    const x = await scenario({
      beforeEdit: ({ a }) => a.dev.setOnline(false),
      afterSave2: async ({ a, b, c, ck }) => { expect(guardOf(b)).toBe(null); expect(guardOf(c)).toBe(null); await ck.run(5 * S); a.dev.setOnline(true); },
    });
    await finish(x, { value: "v2" });
  });

  it("notes arrive before the document (notes 0 s, files 60 s)", async () => {
    const x = await scenario({ delay: 0, noteDelay: 0, fileDelay: 60 * S });
    await finish(x, { value: "v2" });
  });

  it("notes arrive after the document (notes 60 s, files 0 s)", async () => {
    const x = await scenario({ delay: 0, noteDelay: 60 * S, fileDelay: 0 });
    await finish(x, { value: "v2" });
  });

  it("the note's deletion arrives before the document (A quits right after saving)", async () => {
    const x = await scenario({
      delay: 0, noteDelay: 0, fileDelay: 60 * S,
      afterSave2: async ({ a }) => { await flush(); a.dev.quit(); },
    });
    x.g.cs.splice(0, 1);       // A has quit: the others go on
    await finish(x, { value: "v2" });
  });

  it("the note's deletion arrives after the document", async () => {
    const x = await scenario({
      delay: 0, noteDelay: 60 * S, fileDelay: 0,
      afterSave2: async ({ a }) => { await flush(); a.dev.quit(); },
    });
    x.g.cs.splice(0, 1);
    await finish(x, { value: "v2" });
  });

  for (const [label, skew] of [["+2 h", 2 * H], ["−2 h", -2 * H], ["2001", Date.UTC(2001, 0, 1) - Date.UTC(2026, 10, 20)], ["2099", Date.UTC(2099, 0, 1) - Date.UTC(2026, 10, 20)]] as const) {
    it(`A's clock wrong (${label})`, async () => {
      const x = await scenario({ beforeEdit: ({ a }) => a.dev.setClockSkew(skew), deps: [{ skewMs: skew }] });
      await finish(x, { value: "v2" });
    });
    it(`B's clock wrong (${label})`, async () => {
      const x = await scenario({ beforeEdit: ({ b }) => b.dev.setClockSkew(skew), deps: [{}, { skewMs: skew }] });
      await finish(x, { value: "v2" });
    });
  }

  it("sleep on the editor: A sleeps 10 min in the middle of editing and wakes", async () => {
    const x = await scenario({
      afterEdit1: async ({ a, ck, g }) => {
        await ck.run(5 * S);
        a.dev.sleep(10 * MIN);
        ck.stopped.set(a.dev.deviceId, g.w.clock.now());
        await ck.run(10 * MIN + 10 * S);
        ck.stopped.clear();
        await ck.run(LIMITS_P3.resumeMs + 5 * S);     // the after-sleep window ends by itself (Save would ask)
      },
    });
    await finish(x, { value: "v2" });
  });

  for (const ms of [10 * MIN, 2 * H]) {
    it(`sleep on the observer: B sleeps ${ms / MIN} min`, async () => {
      const x = await scenario({
        afterEdit1: async ({ b, ck }) => { await ck.run(5 * S); b.dev.sleep(ms); },
        settle: ms,
      });
      await finish(x, { value: "v2" });
    });
  }

  it("A crashes while editing; starts again 1 h later and saves: nothing lost", async () => {
    const x = await scenario({
      aStops: true,
      afterEdit1: async ({ a, b, ck, g }) => {
        await ck.run(5 * S);
        a.dev.crash();
        ck.stopped.set(a.dev.deviceId, g.w.clock.now());
        await ck.run(6 * MIN);
        expect(guardOf(b)).toBe(null);
        b.graph.getState().setFigure({ title: "B after the crash" });     // another section: combined without a choice
        await flush();
        await b.ses.getState().save();
        await ck.run(1 * H);
        ck.stopped.clear();
        a.dev.relaunch();
        const { controllerFor } = await import("./testkit");
        const a2 = await controllerFor(g.w, a.dev);
        await a2.ses.getState().init();
        await flush();
        g.cs[0] = a2;
        expect(isDirty(a2.graph.getState())).toBe(true);            // the unsaved "v1" came back from its backup
        await ck.run(10 * S);
        await a2.ses.getState().save();
      },
    });
    await finish(x);
    const f = x.g.cs[1].dev.localFile(x.g.path)!;
    const { openFile } = await import("./docCodec");
    const cont = openFile(f)!;
    expect(cont.doc.cells[0][0][0]).toBe("v1");
    expect(cont.figure.title).toBe("B after the crash");
  });

  it("A crashes while idle: nobody is held up", async () => {
    const x = await scenario({
      afterSave2: async ({ a, ck, g }) => {
        await ck.run(LIMITS_P3.lingerMs + 10 * S);
        a.dev.crash();
        ck.stopped.set(a.dev.deviceId, g.w.clock.now());
      },
    });
    x.g.cs.splice(0, 1);
    await finish(x, { value: "v2" });
  });

  it("duplicate device id (A and C share one)", async () => {
    const x = await scenario({ ids: ["d-a1a1", "d-b2b2", "d-a1a1"] });
    await finish(x, { value: "v2" });
    const ids = new Set([...x.g.cs].map((c) => c.dev.presenceCalls.some((k) => k.cmd === "newDeviceId")));
    expect(ids.has(true)).toBe(true);
  });

  it("a conflict copy of A's note (on B) and of B's own note", async () => {
    const x = await scenario({
      afterEdit1: async ({ a, b, ck }) => {
        await ck.run(5 * S);
        const an = notesBeside(b.dev, x0(a)).find((n) => n.note?.device_id === "d-a1a1")!;
        b.dev.placeNote(an.path.replace(".laguse", " (conflicted copy 2026-11-20).laguse"), noteText({ ...an.note!, seq: 0, state: "idle" }));
        const bn = notesBeside(b.dev, x0(a)).find((n) => n.note?.device_id === "d-b2b2")!;
        b.dev.placeNote(bn.path.replace(".laguse", " (1).laguse"), noteText({ ...bn.note!, seq: 0 }));
        await ck.run(5 * S);
        expect(guardOf(b)).toBe("editingElsewhere");
      },
    });
    await finish(x, { value: "v2" });
  });

  it("older peer: A runs an app without notes — nobody is ever read-only", async () => {
    const x = await scenario({ beforeEdit: ({ a }) => { a.dev.writesNoNotes = true; } });
    for (const c of x.g.cs) expect(guardOf(c)).toBe(null);
    await finish(x, { value: "v2" });
  });

  it("three computers: A edits, B presses Edit here and saves, C watches; A saves later: one combine", async () => {
    const x = await scenario({
      aStops: true,
      afterEdit1: async ({ a, b, c, ck }) => {
        await ck.run(5 * S);
        expect(guardOf(c)).toBe("editingElsewhere");
        expect(await b.ses.getState().editHere()).toBe(true);
        b.graph.getState().setFigure({ title: "B" });           // another section than A's: combined without a choice
        await flush();
        await ck.run(5 * S);
        expect(activeTab(a).banners.some((k) => k.kind === "continuedElsewhere")).toBe(true);
        expect(guardOf(c)).toBe("editingElsewhere");
        await b.ses.getState().save();
        await ck.run(10 * S);
        await a.ses.getState().save();
        await ck.run(10 * S);
      },
    });
    await finish(x);
    const { openFile } = await import("./docCodec");
    const cont = openFile(x.g.cs[2].dev.localFile(x.g.path)!)!;
    expect([cont.doc.cells[0][0][0], cont.figure.title]).toEqual(["v1", "B"]);
  });

  it("three computers: A and B both edit inside the sync delay, C watches both", async () => {
    const x = await scenario({
      delay: 3 * S,
      aStops: true,
      beforeEdit: async ({ b }) => { await editCell(b, "B", 1); },
      afterEdit1: async ({ a, b, c, ck }) => {
        await ck.run(8 * S);
        expect(activeTab(a).presence?.mode).toBe("bothEditing");
        expect(activeTab(b).presence?.mode).toBe("bothEditing");
        expect(guardOf(c)).toBe("editingElsewhere");
        expect(activeTab(c).banners.find((k) => k.kind === "editingElsewhere")?.peers?.length).toBe(2);
        await a.ses.getState().save();
        await ck.run(10 * S);
        await b.ses.getState().save();
        await ck.run(20 * S);
      },
    });
    await finish(x);
  });
});

const x0 = (c: Computer) => activeTab(c).path!;

describe("X2.6 no note for a local file in Automatically mode", () => {
  it("whatever is done with it", async () => {
    const w = makeWorld();
    const a = await start(await computer(w, { device_id: "d-a1a1", device_name: "Mac mini" }));
    const P = `${DOCS}/Only here.lag`;
    await seedFile(w, a.dev, P);
    await a.ses.getState().open(P);
    for (let k = 0; k < 3; k++) { await editCell(a, `x${k}`); await a.ses.getState().save(); await tick(w, 40 * S); }
    a.picks.push(`${DOCS}/Only here 2`);
    await a.ses.getState().saveAs("new");
    await tick(w, 70 * S);
    await a.ses.getState().closeTab();
    expect(a.dev.allNoteFiles()).toEqual([]);
    expect(a.dev.presenceCalls.filter((c) => c.cmd === "presenceSet")).toEqual([]);     // never even asked
  });
});
