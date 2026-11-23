/* Phase 3 engine, property tests (phase3-contract.md §2.4 "Properties", §8 P7–P10) with a small seeded random
   generator (fixtures-p2/kit.ts `rng`; fast-check is not installed).

   - decide() depends only on its current inputs: any order of the notes, of the observation records, of the
     arrivals of notes / deletions / the document gives the same answer once everything has arrived;
   - a tab with unsaved changes (or holding) is never readOnly / waiting;
   - a clean tab is readOnly only while an editing note on its version is alive by this computer's own record
     (a seq change within 5 min, or first seen within 90 s and not old then); waiting at most 2 min;
   - a wrong clock on the other computer (or on this one) can only make editing available sooner, except that
     a note dated in the future is believed for its first 90 s (and a wait for its version lasts 2 min);
   - nextCheckAt is never later than the next change of the answer;
   - deterministic, and the inputs are not changed. */
import { describe, expect, it } from "vitest";
import { LIMITS_P3, type NoteJson, type NoteTarget, type PresenceDecision, type PresenceInput, type PresenceObs } from "./contract";
import { decide, emptyObs, markGap, observe } from "./presence";
import { rng, type Rng } from "./fixtures-p2/kit";
import { H, KNOWN, ME, MIN, S, T0, input, iso, note } from "./fixtures-p3/notes";

const L = LIMITS_P3;

/** The part of a decision the UI and the controller act on (peers' freshness of idle notes is display only). */
function core(d: PresenceDecision) {
  return {
    mode: d.mode, about: d.about, blockers: d.blockers, yieldedTo: d.yieldedTo, checking: d.checking,
    unconfirmed: d.unconfirmed, waitingFor: d.waiting && [d.waiting.head, d.waiting.deviceId], editing: d.peers.filter((p) => p.state === "editing").map((p) => [p.deviceId, p.freshness, p.basedOn, p.superseded, p.supersedesMe]),
  };
}
/** What must not depend on when exactly within a short window things arrived. */
const modeOf = (d: PresenceDecision) => ({ mode: d.mode, about: d.about, blockers: d.blockers, yieldedTo: d.yieldedTo, checking: d.checking });
const blocked = (d: PresenceDecision) => d.mode === "readOnly" || d.mode === "waiting";

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}

// ── random inputs ───────────────────────────────────────────────────────────

const DEVICES = [
  { device_id: "d-alice-9f3c", device_name: "Office iMac", user_name: "Alice" },
  { device_id: "d-bob-1a2b", device_name: "Lab MacBook", user_name: "Bob" },
  { device_id: "d-mini-77aa", device_name: "Mac mini", user_name: "Zhuo" }, // my own other computer
  { device_id: "d-anon-0001", device_name: "", user_name: "" },
];

function genNote(r: Rng, dev = r.pick(DEVICES), at = T0): NoteJson {
  const editing = r.chance(0.6);
  const targets: NoteTarget[] = [];
  if (r.chance(0.3)) {
    const n = 1 + r.int(2);
    for (let i = 0; i < n; i++) targets.push({ device_id: r.chance(0.4) ? ME.deviceId : r.pick(DEVICES).device_id, epoch: r.int(4) });
  }
  const when = r.pick([-3 * H, -11 * MIN, -9 * MIN, -MIN, 0, MIN, 2 * H]);
  return note({
    ...dev, session_id: `s-${dev.device_id}-${r.int(2)}`,
    state: editing ? "editing" : "idle",
    head: r.pick(["r-0", "r-1", "r-1", "r-8", "r-9", null]),
    base_revision: editing ? r.pick(["r-0", "r-1", "r-1", "r-1", "r-9", null]) : r.chance(0.1) ? "r-1" : null,
    epoch: r.int(4), seq: r.int(30),
    supersedes: targets.length ? targets : null,
    updated_at: r.chance(0.05) ? "garbage" : iso(at + when),
  });
}

/** A random but self-consistent input: notes, an observation history built with observe / markGap, flags. */
function genInput(r: Rng): PresenceInput {
  const extra = new Set(r.chance(0.5) ? ["r-9"] : []);
  if (r.chance(0.3)) extra.add("r-8");
  const knows = (id: string) => KNOWN.has(id) || extra.has(id);
  let t = T0;
  let obs = emptyObs();
  let notes: NoteJson[] = [];
  const devs = r.shuffle(DEVICES).slice(0, r.int(DEVICES.length + 1));
  const steps = 1 + r.int(4);
  for (let i = 0; i < steps; i++) {
    t += r.pick([0, 5 * S, 30 * S, 80 * S, 3 * MIN, 6 * MIN]);
    if (i && r.chance(0.12)) { obs = markGap(obs, t); continue; }
    notes = devs.filter(() => r.chance(0.85)).map((d) => genNote(r, d, t));
    if (!(i === steps - 1 && r.chance(0.2))) obs = observe(obs, notes, t, knows); // sometimes the record lags behind
  }
  const now = t + r.pick([0, 1, 10 * S, 89 * S, 91 * S, 2 * MIN, 4 * MIN, 6 * MIN, 30 * MIN]);
  const overrides: NoteTarget[] = r.chance(0.3) ? notes.filter(() => r.chance(0.5)).map((n) => ({ device_id: n.device_id, epoch: r.chance(0.8) ? n.epoch : n.epoch + 1 })) : [];
  return input(notes, obs, {
    now, knows, diskHead: r.pick(["r-1", "r-1", "r-0", "r-9", null]),
    dirty: r.chance(0.3), holding: r.chance(0.3), myEpoch: r.int(4), resuming: r.chance(0.15), overrides,
  });
}

function reversedObs(o: PresenceObs): PresenceObs {
  return {
    notes: Object.fromEntries(Object.entries(o.notes).reverse()),
    unknownSince: Object.fromEntries(Object.entries(o.unknownSince).reverse()),
    checkingSince: o.checkingSince,
  };
}

describe("P7 / P8 generated inputs", () => {
  it("unsaved changes or holding → never readOnly, never waiting (1000 cases)", () => {
    const r = rng(0x5eed01);
    let both = 0;
    for (let i = 0; i < 1000; i++) {
      const inp = genInput(r);
      for (const flags of [{ dirty: true, holding: false }, { dirty: false, holding: true }, { dirty: true, holding: true }]) {
        const d = decide({ ...inp, ...flags });
        expect(["readOnly", "waiting"]).not.toContain(d.mode);
        expect(d.blockers).toEqual([]);
        expect(d.waiting).toBeNull();
        if (d.mode === "bothEditing") both++;
      }
    }
    expect(both).toBeGreaterThan(100); // the generator does reach the interesting cases
  });

  it("any order of the notes and of the records → the same decision; deterministic; inputs unchanged (1000 cases)", () => {
    const r = rng(0x5eed02);
    const modes = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const inp = deepFreeze(genInput(r));
      const d = decide(inp);
      modes.add(d.mode);
      expect(decide(inp)).toEqual(d);
      expect(decide({ ...inp, notes: r.shuffle(inp.notes) })).toEqual(d);
      expect(decide({ ...inp, notes: [...inp.notes].reverse(), obs: reversedObs(inp.obs) })).toEqual(d);
      // Duplicated notes (an unreduced listing) change nothing either.
      expect(decide({ ...inp, notes: r.shuffle([...inp.notes, ...inp.notes]) })).toEqual(d);
      expect(observe(inp.obs, r.shuffle(inp.notes), inp.now, inp.knows)).toEqual(observe(inp.obs, inp.notes, inp.now, inp.knows));
    }
    expect([...modes].sort()).toEqual(["bothEditing", "editable", "info", "readOnly", "resuming", "waiting"]);
  });

  it("adding a note and removing it again → the decision as before (500 cases)", () => {
    const r = rng(0x5eed03);
    for (let i = 0; i < 500; i++) {
      const inp = genInput(r);
      const before = decide(inp);
      const used = new Set(inp.notes.map((n) => n.device_id));
      const free = DEVICES.filter((d) => !used.has(d.device_id));
      if (!free.length) continue;
      const x = genNote(r, r.pick(free), inp.now);
      const withX = observe(inp.obs, [...inp.notes, x], inp.now, inp.knows);
      const without = observe(withX, inp.notes, inp.now, inp.knows);
      const direct = observe(inp.obs, inp.notes, inp.now, inp.knows);
      expect(decide({ ...inp, obs: without })).toEqual(decide({ ...inp, obs: direct }));
      // … and the removed note has no effect at once.
      expect(decide({ ...inp, obs: withX, notes: inp.notes }).peers.map((p) => p.deviceId)).not.toContain(x.device_id);
      // With no change to the other notes, the decision is the one before (the extra record is ignored).
      if (inp.notes.every((n) => inp.obs.notes[n.device_id] && inp.obs.notes[n.device_id].seq === n.seq && inp.obs.notes[n.device_id].sessionId === n.session_id && inp.obs.notes[n.device_id].epoch === n.epoch && !inp.obs.notes[n.device_id].checking)) {
        expect(core(decide({ ...inp, obs: without }))).toEqual(core(before));
      }
    }
  });

  it("nothing changes before nextCheckAt (1000 cases)", () => {
    const r = rng(0x5eed04);
    let flips = 0;
    for (let i = 0; i < 1000; i++) {
      const inp = genInput(r);
      const d = decide(inp);
      const end = d.nextCheckAt ?? inp.now + 48 * H;
      expect(end).toBeGreaterThan(inp.now);
      const c = core(d);
      for (const s of [inp.now + 1, Math.floor((inp.now + end) / 2), end - 1, ...Array.from({ length: 4 }, () => inp.now + Math.floor(r.next() * (end - inp.now)))]) {
        if (s < inp.now || s >= end) continue;
        const later = decide({ ...inp, now: s });
        expect(core(later)).toEqual(c);
        // A wait whose start is on record keeps its end (one not yet on record starts at each look).
        if (d.waiting && Object.prototype.hasOwnProperty.call(inp.obs.unknownSince, d.waiting.head)) expect(later.waiting).toEqual(d.waiting);
      }
      if (d.nextCheckAt !== null) {
        const after = decide({ ...inp, now: d.nextCheckAt });
        if (JSON.stringify(core(after)) !== JSON.stringify(c)) flips++;
        expect(after.nextCheckAt === null || after.nextCheckAt > d.nextCheckAt).toBe(true);
      }
    }
    expect(flips).toBeGreaterThan(100);
  });
});

// ── arrival orders ──────────────────────────────────────────────────────────

describe("P8 arrival order of notes, deletions and the document", () => {
  it("once everything has arrived the answer is the same whatever the order (300 scenarios × 20 orders)", () => {
    const r = rng(0x5eed05);
    for (let sc = 0; sc < 300; sc++) {
      const t0 = T0 + sc * H;
      // Final notes: a few devices; some with earlier versions on the way; some that appear and are deleted.
      const devs = r.shuffle(DEVICES);
      const finals: NoteJson[] = [];
      const events: { dev: string; key: number; note: NoteJson | null }[] = [];
      for (const dev of devs) {
        const kind = r.int(3); // 0 absent, 1 present, 2 appears then deleted
        if (kind === 0) continue;
        const fin = { ...genNote(r, dev, t0), updated_at: iso(t0 - r.int(60) * S) }; // recent, by a right clock
        const versions = [fin];
        for (let k = r.int(3); k > 0; k--) versions.unshift({ ...versions[0], seq: Math.max(0, versions[0].seq - 1 - r.int(3)) });
        versions.forEach((v, k) => events.push({ dev: dev.device_id, key: k, note: v }));
        if (kind === 2) events.push({ dev: dev.device_id, key: versions.length, note: null });
        else finals.push(fin);
      }
      const docVersions = r.shuffle(["r-8", "r-9"]).slice(0, r.int(3));
      const finalKnows = (id: string) => KNOWN.has(id) || docVersions.includes(id);
      const flags = { dirty: r.chance(0.3), holding: r.chance(0.2), myEpoch: r.int(4), resuming: false };
      const diskHead = r.pick(["r-1", "r-1", "r-0", "r-9"]);
      const T = t0 + 3 * S;
      const reference = modeOf(decide(input(finals, observe(emptyObs(), finals, T, finalKnows), { now: T, knows: finalKnows, diskHead, ...flags })));
      for (let ord = 0; ord < 20; ord++) {
        // A random interleaving that keeps each device's own versions in order (a file only moves forward).
        const queue = new Map<string, typeof events>();
        for (const e of events) queue.set(e.dev, [...(queue.get(e.dev) ?? []), e]);
        const order: (typeof events[number] | "doc")[] = [];
        const pending = [...queue.values()].map((q) => [...q]);
        const docAt = r.int(events.length + 1);
        while (pending.some((q) => q.length)) {
          if (order.length === docAt) order.push("doc");
          const q = r.pick(pending.filter((p) => p.length));
          // Sometimes an intermediate version is never seen at all.
          const e = q.shift()!;
          if (q.length && e.note && r.chance(0.3)) continue;
          order.push(e);
        }
        if (!order.includes("doc")) order.push("doc");
        let obs = emptyObs();
        const visible = new Map<string, NoteJson>();
        let docIn = false;
        let t = t0;
        for (const e of order) {
          t += 100;
          if (e === "doc") docIn = true;
          else if (e.note) visible.set(e.dev, e.note);
          else visible.delete(e.dev);
          const k = (id: string) => KNOWN.has(id) || (docIn && docVersions.includes(id));
          obs = observe(obs, [...visible.values()], t, k);
        }
        obs = observe(obs, [...visible.values()], T, finalKnows); // the last listing
        expect([...visible.values()].sort((a, b) => (a.device_id < b.device_id ? -1 : 1))).toEqual([...finals].sort((a, b) => (a.device_id < b.device_id ? -1 : 1)));
        expect(modeOf(decide(input(r.shuffle(finals), obs, { now: T, knows: finalKnows, diskHead, ...flags })))).toEqual(reference);
      }
    }
  });
});

// ── timelines: other computers editing, saving, crashing; this computer polling ─────────────

interface Write { t: number; dev: string; note: NoteJson | null }
interface Scenario { writes: Write[]; docs: { at: number; version: string }[]; noteDelay: Record<string, number>; horizon: number; sleeps: { at: number; ms: number; listAfter: number }[] }

/** Up to three other computers acting on a 5 s grid for `horizon`; this computer's file starts at r-1. */
function genScenario(r: Rng, horizon = 40 * MIN): Scenario {
  const peers = r.shuffle(DEVICES.slice(0, 3)).slice(0, 1 + r.int(3));
  type St = { mode: "absent" | "idle" | "editing" | "crashed"; beating: boolean; n: NoteJson; last: number; saves: number };
  const st = new Map<string, St>();
  const writes: Write[] = [];
  const docs: Scenario["docs"] = [];
  const noteDelay: Record<string, number> = {};
  const write = (dev: string, s: St, t: number, patch: Partial<NoteJson> | null) => {
    if (patch === null) { writes.push({ t, dev, note: null }); s.mode = "absent"; return; }
    s.n = { ...s.n, ...patch, seq: s.n.seq + 1, updated_at: iso(t) };
    s.last = t;
    writes.push({ t, dev, note: s.n });
  };
  for (const p of peers) {
    noteDelay[p.device_id] = r.pick([0, 5 * S, 60 * S]);
    const docDelay = r.pick([0, 5 * S, 60 * S, Number.POSITIVE_INFINITY]);
    const s: St = { mode: "absent", beating: false, n: note({ ...p, session_id: `s-${p.device_id}`, seq: r.int(5) }), last: 0, saves: 0 };
    st.set(p.device_id, s);
    (s as St & { docDelay: number }).docDelay = docDelay;
    if (r.chance(0.2)) { // a leftover from a crash an hour ago
      write(p.device_id, s, T0 - H, { state: "editing", base_revision: "r-1", epoch: 1 });
      s.mode = "crashed";
    } else if (r.chance(0.4)) {
      write(p.device_id, s, T0, { state: "idle", head: "r-1" });
      s.mode = "idle";
    }
  }
  for (let t = T0; t <= T0 + horizon; t += 5 * S) {
    for (const p of peers) {
      const s = st.get(p.device_id)!;
      const dd = (s as St & { docDelay: number }).docDelay;
      switch (s.mode) {
        case "absent": if (r.chance(0.03)) { write(p.device_id, s, t, { state: "idle", base_revision: null, supersedes: null, head: s.n.head ?? "r-1" }); s.mode = "idle"; } break;
        case "crashed": break;
        case "idle":
          if (r.chance(0.03)) {
            // Start editing; sometimes over another computer's claim ("Edit here").
            const others = [...st.entries()].filter(([id, o]) => id !== p.device_id && (o.mode === "editing" || o.mode === "crashed"));
            const sup = others.length && r.chance(0.3) ? [{ device_id: others[0][0], epoch: others[0][1].n.epoch }] : null;
            write(p.device_id, s, t, { state: "editing", base_revision: s.n.head, epoch: s.n.epoch + 1, supersedes: sup });
            s.mode = "editing"; s.beating = true;
          } else if (r.chance(0.005)) write(p.device_id, s, t, null);
          break;
        case "editing":
          if (r.chance(0.006)) { s.mode = "crashed"; break; }
          if (r.chance(0.01)) s.beating = !s.beating; // input stops / comes back
          if (r.chance(0.02)) {
            const v = `r-${p.device_id}-${++s.saves}`;
            write(p.device_id, s, t, { head: v, base_revision: v });
            docs.push({ at: t + dd, version: v });
          } else if (r.chance(0.015)) write(p.device_id, s, t, { state: "idle", base_revision: null, supersedes: null });
          else if (r.chance(0.004)) write(p.device_id, s, t, null);
          else if (s.beating && t - s.last >= L.heartbeatMs) write(p.device_id, s, t, {});
          break;
      }
    }
  }
  const sleeps = r.chance(0.3) ? [{ at: T0 + r.int(horizon / (5 * S)) * 5 * S, ms: r.pick([10 * MIN, 2 * H]), listAfter: r.pick([1 * S, 20 * S, 2 * MIN]) }] : [];
  // Docs arrive in time order.
  docs.sort((a, b) => a.at - b.at);
  return { writes: writes.sort((a, b) => a.t - b.t), docs, noteDelay, horizon, sleeps };
}

interface Step {
  t: number;
  d: PresenceDecision;
  dirty: PresenceDecision;
  holding: PresenceDecision;
  visible: NoteJson[];
  diskHead: string;
  knows: (id: string) => boolean;
  alive: (dev: string) => boolean;
  unknownFor: (h: string) => number | null;
  sinceWake: number | null;
  listedSinceWake: boolean;
  rec: Map<string, { firstSeen: number; lastChange: number | null; oldFirst: boolean; checking: boolean }>;
}

/** This computer polls every 5 s on its own clock (`offset` = how wrong it is); notes are dated with `skew`. */
function run(sc: Scenario, skew: number, offset: number): Step[] {
  const steps: Step[] = [];
  let obs = emptyObs();
  // The oracle's own, independent record of what this computer saw.
  const rec = new Map<string, { ident: string; firstSeen: number; lastChange: number | null; oldFirst: boolean; checking: boolean; late?: "one" | "skewed" }>();
  const unknownFirst = new Map<string, number>();
  let wakeAt: number | null = null;
  let listedSinceWake = true;
  let lastListing: NoteJson[] = [];
  // Notes reach this computer in the order they were written (per device the delay is constant).
  const delivered = sc.writes.map((w, k) => ({ w, k, at: w.t + sc.noteDelay[w.dev] })).sort((a, b) => a.at - b.at || a.k - b.k);
  let wi = 0;
  const latest = new Map<string, NoteJson | null>();
  const sleep = sc.sleeps[0];
  const shift = (n: NoteJson): NoteJson => {
    const t = Date.parse(n.updated_at);
    return { ...n, updated_at: iso(t + skew) };
  };
  for (let tt = T0; tt <= T0 + sc.horizon + 10 * MIN; tt += 5 * S) {
    let t = tt;
    if (sleep && t > sleep.at && t < sleep.at + sleep.ms) continue; // asleep: no timer runs
    let listing = true;
    if (sleep && t >= sleep.at + sleep.ms && wakeAt === null && t - (sleep.at + sleep.ms) < 5 * S) {
      wakeAt = t;
      obs = markGap(obs, t + offset);
      for (const v of rec.values()) v.checking = true;
      unknownFirst.clear();
      listedSinceWake = false;
    }
    if (wakeAt !== null && !listedSinceWake) listing = t >= wakeAt + sleep!.listAfter;
    const now = t + offset;
    const docsIn = sc.docs.filter((d) => d.at <= t);
    const known = new Set([...KNOWN, ...docsIn.map((d) => d.version)]);
    const knows = (id: string) => known.has(id);
    const diskHead = docsIn.length ? docsIn[docsIn.length - 1].version : "r-1";
    while (wi < delivered.length && delivered[wi].at <= t) { latest.set(delivered[wi].w.dev, delivered[wi].w.note); wi++; }
    const onDisk = [...latest.values()].filter((n): n is NoteJson => n !== null).map(shift);
    // The engine only knows what the last listing gave.
    if (listing) lastListing = onDisk;
    const visible = lastListing;
    if (listing) {
      obs = observe(obs, visible, now, knows);
      if (!listedSinceWake) listedSinceWake = true;
      const ident = (n: NoteJson) => `${n.session_id}|${n.epoch}|${n.seq}`;
      for (const id of [...rec.keys()]) if (!visible.some((n) => n.device_id === id)) rec.delete(id);
      for (const n of visible) {
        const o = rec.get(n.device_id);
        const old = !(now - Date.parse(n.updated_at) <= L.firstSightOldMs);
        if (!o) rec.set(n.device_id, { ident: ident(n), firstSeen: now, lastChange: null, oldFirst: old, checking: false });
        else if (o.checking) rec.set(n.device_id, o.ident === ident(n)
          ? { ident: ident(n), firstSeen: now, lastChange: null, oldFirst: old, checking: false }
          : old ? { ident: ident(n), firstSeen: now, lastChange: null, oldFirst: true, checking: false, late: "one" }
            : { ident: ident(n), firstSeen: now, lastChange: now, oldFirst: false, checking: false });
        else if (o.ident !== ident(n)) {
          // fixer VP-4: a change dated old by my clock arrived late — the first one in a row is not a sign of life.
          o.ident = ident(n);
          if (old && o.late !== "skewed") {
            if (o.late !== "one") o.late = "one";
            else { o.lastChange = now; o.oldFirst = false; o.late = "skewed"; }
          } else { o.lastChange = now; o.oldFirst = false; if (!old) o.late = undefined; }
        }
      }
      const declared = new Set<string>();
      for (const n of visible) {
        if (n.head !== null) declared.add(n.head);
        if (n.state === "editing" && n.base_revision !== null) declared.add(n.base_revision);
      }
      for (const h of [...unknownFirst.keys()]) if (!declared.has(h) || knows(h)) unknownFirst.delete(h);
      for (const h of declared) if (!knows(h) && !unknownFirst.has(h)) unknownFirst.set(h, now);
    }
    // Snapshots: the closures below must see this step's record, not a later one.
    const recNow = new Map([...rec].map(([k, v]) => [k, { ...v }]));
    const unknownNow = new Map(unknownFirst);
    const wakeNow = wakeAt;
    const alive = (dev: string) => {
      const o = recNow.get(dev);
      if (!o) return false;
      if (o.checking) return wakeNow !== null && now - (wakeNow + offset) < L.freshFirstMs && !o.oldFirst;
      return o.lastChange !== null ? now - o.lastChange < L.staleMs : !o.oldFirst && now - o.firstSeen < L.freshFirstMs;
    };
    const base = input(visible, obs, { now, knows, diskHead });
    steps.push({
      t, d: decide(base), dirty: decide({ ...base, dirty: true }), holding: decide({ ...base, holding: true, myEpoch: 1 }),
      visible, diskHead, knows, alive,
      unknownFor: (h) => (unknownNow.has(h) ? now - unknownNow.get(h)! : null),
      sinceWake: wakeAt === null ? null : now - (wakeAt + offset), listedSinceWake,
      rec: new Map([...recNow].map(([k, v]) => [k, { firstSeen: v.firstSeen, lastChange: v.lastChange, oldFirst: v.oldFirst, checking: v.checking }])),
    });
  }
  return steps;
}

function checkSteps(steps: Step[], label: string): { readOnly: number; waiting: number; info: number } {
  const count = { readOnly: 0, waiting: 0, info: 0 };
  for (const s of steps) {
    const at = `${label} at +${(s.t - T0) / 1000}s`;
    // Never frozen.
    expect(["readOnly", "waiting"], at).not.toContain(s.dirty.mode);
    expect(["readOnly", "waiting"], at).not.toContain(s.holding.mode);
    const d = s.d;
    if (d.mode === "readOnly") {
      count.readOnly++;
      if (d.checking) {
        expect(s.sinceWake !== null && s.sinceWake < L.recheckMaxMs && !s.listedSinceWake, at).toBe(true);
      } else {
        // An editing note on my version that is alive by my own record.
        const ok = s.visible.some((n) => n.state === "editing" && n.base_revision === s.diskHead && d.about.includes(n.device_id) && s.alive(n.device_id));
        expect(ok, at).toBe(true);
      }
      for (const id of d.about) {
        const n = s.visible.find((v) => v.device_id === id)!;
        expect(n.state, at).toBe("editing");
        expect(n.base_revision, at).toBe(s.diskHead);
      }
    }
    if (d.mode === "waiting") {
      count.waiting++;
      const w = d.waiting!;
      expect(s.knows(w.head), at).toBe(false);
      const age = s.unknownFor(w.head);
      // Before the first listing after waking, the wait starts again (no record yet).
      expect(age === null ? !s.listedSinceWake : age < L.waitNewerMs, at).toBe(true);
      expect(w.until - w.since, at).toBeLessThanOrEqual(L.waitNewerMs);
    }
    if (d.mode === "info") count.info++;
    // The other way round: an alive, unchallenged editing note on my version with nothing to wait for → read-only.
    if (s.listedSinceWake) {
      const anyUnknownHead = s.visible.some((n) => n.head !== null && !s.knows(n.head));
      const standing = s.visible.filter((n) => n.state === "editing" && n.base_revision === s.diskHead && s.alive(n.device_id) &&
        !s.visible.some((q) => q.device_id !== n.device_id && q.state === "editing" && (q.supersedes ?? []).some((x) => x.device_id === n.device_id && x.epoch === n.epoch)));
      const anyUnknownBase = s.visible.some((n) => n.state === "editing" && n.base_revision !== null && !s.knows(n.base_revision) && s.alive(n.device_id));
      if (standing.length && !anyUnknownHead && !anyUnknownBase) expect(d.mode, at).toBe("readOnly");
    }
  }
  return count;
}

describe("P-timelines", () => {
  it("read-only only while alive by my own record; waiting at most 2 min; never frozen with unsaved changes (150 scenarios)", () => {
    const r = rng(0x5eed06);
    const total = { readOnly: 0, waiting: 0, info: 0 };
    for (let i = 0; i < 150; i++) {
      const sc = genScenario(r);
      const c = checkSteps(run(sc, 0, 0), `scenario ${i}`);
      total.readOnly += c.readOnly; total.waiting += c.waiting; total.info += c.info;
    }
    // The scenarios do exercise every case.
    expect(total.readOnly).toBeGreaterThan(200);
    expect(total.waiting).toBeGreaterThan(20);
    expect(total.info).toBeGreaterThan(100);
  }, 60_000);

  it("with no seq change, read-only ends 5 min after the last change seen (90 s after a first sight)", () => {
    const r = rng(0x5eed07);
    for (let i = 0; i < 150; i++) {
      const steps = run(genScenario(r), 0, 0);
      for (const s of steps) {
        if (s.d.mode !== "readOnly" || s.d.checking) continue;
        const now = s.t;
        const live = s.d.about.filter((id) => {
          const o = s.rec.get(id);
          if (!o) return false;
          // Woken up and not listed yet: believed for 90 s from the wake-up at most.
          if (o.checking) return s.sinceWake !== null && s.sinceWake < L.freshFirstMs;
          return o.lastChange !== null ? now - o.lastChange < L.staleMs : now - o.firstSeen < L.freshFirstMs;
        });
        expect(live.length, `scenario ${i} +${(now - T0) / 1000}s`).toBeGreaterThan(0);
      }
    }
  }, 60_000);

  it("a wrong clock on the other computers, or on this one, only makes editing available sooner (50 scenarios × 8 clocks)", () => {
    const r = rng(0x5eed08);
    const Y2001 = Date.UTC(2001, 0, 1) - T0;
    const Y2099 = Date.UTC(2099, 0, 1) - T0;
    const clocks: { skew: number; offset: number; past: boolean }[] = [
      { skew: -2 * H, offset: 0, past: true }, { skew: Y2001, offset: 0, past: true },
      { skew: 2 * H, offset: 0, past: false }, { skew: Y2099, offset: 0, past: false },
      { skew: 0, offset: 2 * H, past: true }, { skew: 0, offset: Y2099, past: true }, // this computer ahead ≈ the others behind
      { skew: 0, offset: -2 * H, past: false }, { skew: 0, offset: Y2001, past: false },
    ];
    let differed = 0;
    for (let i = 0; i < 50; i++) {
      const sc = genScenario(r);
      const right = run(sc, 0, 0);
      for (const c of clocks) {
        const wrong = run(sc, c.skew, c.offset);
        expect(wrong.length).toBe(right.length);
        checkSteps(wrong, `scenario ${i} skew ${c.skew} offset ${c.offset}`);
        for (let k = 0; k < right.length; k++) {
          const a = right[k], b = wrong[k];
          if (!blocked(b.d) || blocked(a.d)) continue;
          differed++;
          const at = `scenario ${i} skew ${c.skew} offset ${c.offset} +${(b.t - T0) / 1000}s: ${b.d.mode}`;
          // Behind: never more read-only than with right clocks.
          expect(c.past, at).toBe(false);
          // Ahead: a note dated in the future is believed for its first 90 s; a wait for its version lasts ≤ 2 min.
          const now = b.t + c.offset;
          if (b.d.mode === "readOnly") {
            expect(b.d.about.some((id) => {
              const o = b.rec.get(id);
              if (!o) return false;
              if (o.checking) return b.sinceWake !== null && b.sinceWake < L.freshFirstMs;
              return o.lastChange === null && now - o.firstSeen < L.freshFirstMs;
            }), at).toBe(true);
          } else {
            expect(b.unknownFor(b.d.waiting!.head) ?? 0, at).toBeLessThan(L.waitNewerMs);
          }
        }
      }
    }
    expect(differed).toBeGreaterThan(0); // the future-dated case does occur (leftover notes from a crash)
  }, 60_000);

  it("every computer becomes editable within 5 min (+ one poll) of the editor's crash, whatever the clocks", () => {
    const r = rng(0x5eed09);
    for (let i = 0; i < 120; i++) {
      const sc = genScenario(r, 20 * MIN);
      for (const [skew, offset] of [[0, 0], [2 * H, 0], [-2 * H, 0], [0, 2 * H], [0, -2 * H]]) {
        const steps = run(sc, skew, offset);
        // After the last write of any kind (everyone has crashed or stopped) plus the slowest note delay,
        // 5 min 10 s later nobody is read-only (waiting ends after 2 min too).
        const last = Math.max(T0, ...sc.writes.map((w) => w.t + sc.noteDelay[w.dev]));
        const wake = sc.sleeps.length ? sc.sleeps[0].at + sc.sleeps[0].ms + sc.sleeps[0].listAfter : 0;
        for (const s of steps) {
          if (s.t < Math.max(last, wake) + L.staleMs + 10 * S) continue;
          expect(blocked(s.d), `scenario ${i} skew ${skew} offset ${offset} +${(s.t - T0) / 1000}s`).toBe(false);
        }
      }
    }
  }, 60_000);
});
