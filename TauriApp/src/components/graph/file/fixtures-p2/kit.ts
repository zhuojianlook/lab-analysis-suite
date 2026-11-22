/* Helpers for the phase 2 engine tests (imported by *.test.ts only): a seeded
   random generator (no fast-check in this project), revisions, random
   histories and files. */

import type { GraphFileData, Manifest, PartRef, Revision, SectionName } from "../format";

/** mulberry32: a small seeded generator, same sequence on every machine. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)],
    chance: (p: number) => next() < p,
    shuffle: <T>(xs: readonly T[]): T[] => {
      const out = [...xs];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
  };
}
export type Rng = ReturnType<typeof rng>;

const ref = (s: string): PartRef => ({ part: `parts/${s}.json`, sha256: s, bytes: 1 });
export const refs = (t = "t0", a = "a0", f = "f0", s = "s0"): Record<SectionName, PartRef> =>
  ({ table: ref(t), analysis: ref(a), figure: ref(f), scratchpad: ref(s) });

const T0 = Date.UTC(2026, 10, 1, 9);

/** A revision with sensible defaults; `time` in minutes after a fixed start unless a string is given. */
export function rev(id: string, parents: string[] = [], extra: Partial<Revision> & { minutes?: number } = {}): Revision {
  const { minutes, ...rest } = extra;
  return {
    id, parents, time: new Date(T0 + (minutes ?? 0) * 60_000).toISOString(),
    user_name: "Zhuo", device_id: "d-a", device_name: "Mac", session_id: "s", app_version: "t",
    kind: parents.length > 1 ? "merge" : "save", summary: "", sections: refs(), content_hash: "c-" + id,
    ...rest,
  };
}

export function manifestOf(revisions: Revision[], head = revisions[revisions.length - 1]?.id ?? ""): Manifest {
  return {
    format: "lasgraph", format_version: 1, min_reader_version: 1, features: 1,
    app: { name: "t", version: "t", platform: "t" }, analysis_id: "a-1", forked_from: null,
    created: { time: "", user_name: "", device_id: "", device_name: "" }, template: "column", head, revisions, x: {},
  };
}

export const fileOf = (revisions: Revision[], parts: Record<string, string> = {}, head?: string): GraphFileData =>
  ({ manifest: manifestOf(revisions, head), parts });

/** A random history: node i picks one earlier parent, or two (a combine) of
 *  which neither is an ancestor of the other. Times run forward with up to
 *  ±skew minutes of noise. Ids are not in creation order. */
export function randomDag(r: Rng, n: number, opts: { mergeP?: number; roots?: number; skew?: number; devices?: string[] } = {}): Revision[] {
  const mergeP = opts.mergeP ?? 0.25, roots = opts.roots ?? 1, skew = opts.skew ?? 0;
  const devices = opts.devices ?? ["d-a", "d-b", "d-c"];
  const out: Revision[] = [];
  const anc: Set<string>[] = [];
  const idAt = (i: number) => `r-${((i * 7919 + 13) % 100000).toString(36).padStart(4, "0")}-${i}`;
  for (let i = 0; i < n; i++) {
    const id = idAt(i);
    let parents: number[] = [];
    if (i >= roots) {
      const a = r.int(i);
      parents = [a];
      if (r.chance(mergeP) && i > 1) {
        const cands = [...Array(i).keys()].filter((b) => b !== a && !anc[a].has(idAt(b)) && !anc[b].has(idAt(a)));
        if (cands.length) parents.push(r.pick(cands));
      }
    }
    const pids = parents.map(idAt);
    const set = new Set<string>([id]);
    for (const p of parents) for (const x of anc[p]) set.add(x);
    anc.push(set);
    out.push(rev(id, pids.length > 1 ? [...pids].sort() : pids, {
      minutes: i * 10 + (skew ? r.int(2 * skew + 1) - skew : 0), device_id: r.pick(devices),
    }));
  }
  return out;
}

/** Brute force: ancestors-or-self of every revision. */
export function ancestorSets(revs: readonly Revision[]): Map<string, Set<string>> {
  const byId = new Map(revs.map((r) => [r.id, r]));
  const memo = new Map<string, Set<string>>();
  const get = (id: string): Set<string> => {
    const hit = memo.get(id);
    if (hit) return hit;
    const s = new Set<string>([id]);
    for (const p of byId.get(id)?.parents ?? []) if (byId.has(p)) for (const x of get(p)) s.add(x);
    memo.set(id, s);
    return s;
  };
  for (const r of revs) get(r.id);
  return memo;
}
