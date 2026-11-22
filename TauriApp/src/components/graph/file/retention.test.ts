import { describe, expect, it } from "vitest";
import { LIMITS_P2, type RetentionCtx } from "./contract";
import type { Manifest, Revision } from "./format";
import { applyRetention, keptSnapshots } from "./retention";
import { newestFirst } from "./revisions";
import { manifestOf, randomDag, rev, rng } from "./fixtures-p2/kit";

const DAY = 24 * 3600 * 1000;
const NOW = Date.UTC(2026, 10, 22, 12);

/** A linear history of `n` saves on one computer, seen here one minute apart (oldest first). */
function linear(n: number, device = "d-a"): { m: Manifest; seen: Record<string, number> } {
  const revs: Revision[] = [];
  const seen: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const id = `r-${String(i).padStart(3, "0")}`;
    revs.push(rev(id, i ? [revs[i - 1].id] : [], { minutes: i, device_id: device }));
    seen[id] = NOW - (n - i) * 60_000;
  }
  return { m: manifestOf(revs), seen };
}

const ctx = (firstSeen: Record<string, number>, more: Partial<RetentionCtx> = {}): RetentionCtx =>
  ({ now: NOW, firstSeen, unconfirmedHeads: [], beaconHeads: [], ...more });

const storedIds = (m: Manifest) => m.revisions.filter((r) => r.sections).map((r) => r.id);

describe("M7 retention", () => {
  it("≤ 20 stored → the same object", () => {
    const { m, seen } = linear(20);
    expect(applyRetention(m, ctx(seen))).toBe(m);
    const { m: m2, seen: s2 } = linear(30);
    const once = applyRetention(m2, ctx(s2));
    expect(storedIds(once).length).toBe(20);
    // Applying it again changes nothing.
    expect(applyRetention(once, ctx(s2))).toBe(once);
  });

  it("keeps the head and the newest 20 by first-seen; entries never removed; other fields untouched", () => {
    const { m, seen } = linear(30);
    const out = applyRetention(m, ctx(seen));
    expect(out.revisions.length).toBe(30);
    expect(out.head).toBe(m.head);
    expect(storedIds(out)).toEqual(m.revisions.slice(10).map((r) => r.id));
    out.revisions.forEach((r, i) => {
      const before = m.revisions[i];
      if (r.sections) expect(r).toBe(before);
      else expect(r).toEqual({ ...before, sections: null });
    });
  });

  it("by first-seen, never by the version's own time", () => {
    const { m, seen } = linear(25);
    // Branch: a version with an OLD time that this computer saw just now, and one with
    // a NEW time that it saw long ago (both children of the root, so either order is valid).
    const recentOld = rev("r-x-recent", [m.revisions[0].id], { minutes: -5000, device_id: "d-a" });
    const oldNew = rev("r-x-old", [m.revisions[0].id], { minutes: 999999, device_id: "d-a" });
    const m2 = { ...m, revisions: [...m.revisions, recentOld, oldNew] };
    const s = { ...seen, [recentOld.id]: NOW, [oldNew.id]: NOW - 300 * DAY };
    const kept = keptSnapshots(m2, ctx(s));
    expect(kept.has(recentOld.id)).toBe(true);
    expect(kept.has(oldNew.id)).toBe(false);
  });

  it("a version not in the first-seen record counts as seen now", () => {
    const { m, seen } = linear(25);
    const s = { ...seen };
    delete s[m.revisions[0].id];          // the root, oldest by history
    // Topological order still puts the root last: children before parents.
    expect(keptSnapshots(m, ctx(s)).has(m.revisions[0].id)).toBe(false);
    // A side version without a record counts as seen now and is kept.
    const side = rev("r-side", [m.revisions[3].id], { device_id: "d-a" });
    expect(keptSnapshots({ ...m, revisions: [...m.revisions, side] }, ctx(seen)).has("r-side")).toBe(true);
  });

  it("both parents of every combine", () => {
    const { m, seen } = linear(40);
    const p1 = m.revisions[2].id, p2id = "r-b";
    const b = rev(p2id, [m.revisions[1].id], { device_id: "d-a" });
    const comb = rev("r-m-1", [p1, p2id].sort(), { device_id: "d-a" });
    const tail = rev("r-t", ["r-m-1"], { device_id: "d-a" });
    const m2 = { ...m, revisions: [...m.revisions, b, comb, tail], head: m.head };
    const s = { ...seen, [p2id]: NOW - 100 * DAY, "r-m-1": NOW - 99 * DAY, "r-t": NOW - 98 * DAY };
    const kept = keptSnapshots(m2, ctx(s));
    expect(kept.has(p1)).toBe(true);
    expect(kept.has(p2id)).toBe(true);
    expect(kept.has(m.revisions[1].id)).toBe(false);
  });

  it("hand-over point kept at 179 days and dropped at 181 days of local time, whatever its own time", () => {
    const { m, seen } = linear(40);
    const at = m.revisions[5].id;
    // The next version was saved on another computer.
    const revs = m.revisions.map((r, i) => (i === 6 ? { ...r, device_id: "d-b", time: "1999-01-01T00:00:00.000Z" } : r));
    const m2 = { ...m, revisions: revs };
    expect(keptSnapshots(m2, ctx({ ...seen, [at]: NOW - 179 * DAY })).has(at)).toBe(true);
    expect(keptSnapshots(m2, ctx({ ...seen, [at]: NOW - 181 * DAY })).has(at)).toBe(false);
    // A blank device (an automatic combine) is no hand-over.
    const blank = m.revisions.map((r, i) => (i === 6 ? { ...r, device_id: "" } : r));
    expect(keptSnapshots({ ...m, revisions: blank }, ctx({ ...seen, [at]: NOW - 10 * DAY })).has(at)).toBe(false);
  });

  it("beacon heads, unconfirmed heads and pinned versions are kept", () => {
    const { m, seen } = linear(40);
    const [a, b, c] = [m.revisions[1].id, m.revisions[2].id, m.revisions[3].id];
    const kept = keptSnapshots(m, ctx(seen, { beaconHeads: [a], unconfirmedHeads: [b], pinned: [c] }));
    expect([kept.has(a), kept.has(b), kept.has(c)]).toEqual([true, true, true]);
    expect(kept.has(m.revisions[4].id)).toBe(false);
    // Unknown ids in the lists do nothing.
    expect(keptSnapshots(m, ctx(seen, { pinned: ["nope"] })).has("nope")).toBe(false);
  });

  it("content never comes back", () => {
    const { m, seen } = linear(30);
    const gone = m.revisions.map((r, i) => (i === 25 ? { ...r, sections: null } : r));
    const m2 = { ...m, revisions: gone };
    const kept = keptSnapshots(m2, ctx(seen, { pinned: [m.revisions[25].id] }));
    expect(kept.has(m.revisions[25].id)).toBe(false);
    expect(applyRetention(m2, ctx(seen)).revisions[25].sections).toBeNull();
  });

  it("properties over random histories", () => {
    const r = rng(1234);
    for (let t = 0; t < 150; t++) {
      const revs = randomDag(r, 5 + r.int(70), { mergeP: 0.2 });
      const m = manifestOf(revs, r.pick(revs).id);
      const seen: Record<string, number> = {};
      for (const x of revs) if (r.chance(0.9)) seen[x.id] = NOW - r.int(400) * DAY;
      const unconfirmed = revs.filter(() => r.chance(0.05)).map((x) => x.id);
      const c = ctx(seen, { unconfirmedHeads: unconfirmed });
      const out = applyRetention(m, c);
      const kept = new Set(storedIds(out));
      expect(out.revisions.map((x) => x.id)).toEqual(revs.map((x) => x.id));   // never removes or reorders
      expect(out.head).toBe(m.head);
      expect(kept.has(m.head)).toBe(true);
      for (const id of unconfirmed) expect(kept.has(id)).toBe(true);
      const newest = newestFirst(revs, (x) => seen[x.id] ?? NOW).slice(0, LIMITS_P2.snapshotsKept);
      for (const x of newest) expect(kept.has(x.id)).toBe(true);
      const byId = new Map(revs.map((x) => [x.id, x]));
      for (const x of revs) {
        if (x.parents.length > 1) for (const p of x.parents) expect(kept.has(p)).toBe(true);
        for (const p of x.parents) {
          const pr = byId.get(p)!;
          if (x.device_id && x.device_id !== pr.device_id && NOW - (seen[p] ?? NOW) < LIMITS_P2.handoverKeepMs) expect(kept.has(p)).toBe(true);
        }
      }
      expect(keptSnapshots(m, c)).toEqual(kept);
      // Idempotent.
      expect(applyRetention(out, c)).toBe(out);
    }
  });
});
