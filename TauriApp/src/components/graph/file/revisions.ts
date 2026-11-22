/* Version history as a graph (phase 2 contract §3.1–3.2): ancestry, lowest
   common ancestors, the base rule for a combine, a stable newest-first order,
   the stored contents of several files, and which of several files of one
   analysis stays. Pure: no I/O, no clock, no randomness. Every walk is
   iterative and visits each revision once, so histories with thousands of
   entries are fine. Revision objects are never rebuilt (unknown fields of a
   newer app travel along untouched). */

import type { BaseChoice, HeadRelation, RevisionsApi, SectionValues, SnapshotPool } from "./contract";
import { SECTION_NAMES, type GraphFileData, type Manifest, type Revision } from "./format";

/** The part of a revision the graph functions look at. */
type Node = Pick<Revision, "id" | "parents">;

// ── index (cached per array) ────────────────────────────────────────────────

interface Index<T extends Node> {
  len: number;
  first: Node | undefined;
  last: Node | undefined;
  byId: Map<string, T>;
  /** id → ids of the revisions that name it as a parent (known children only, no duplicates). */
  children: Map<string, string[]>;
}

const cache = new WeakMap<readonly Node[], Index<Node>>();

/** By id (first entry wins for a duplicated id) and the child lists. Cached
 *  per array; a changed length or first / last entry rebuilds it. */
function indexOf<T extends Node>(revs: readonly T[]): Index<T> {
  const hit = cache.get(revs) as Index<T> | undefined;
  if (hit && hit.len === revs.length && hit.first === revs[0] && hit.last === revs[revs.length - 1]) return hit;
  const byId = new Map<string, T>();
  for (const r of revs) if (r && typeof r.id === "string" && !byId.has(r.id)) byId.set(r.id, r);
  const children = new Map<string, string[]>();
  for (const r of byId.values()) {
    const ps = Array.isArray(r.parents) ? r.parents : [];
    const seen = new Set<string>();
    for (const p of ps) {
      if (typeof p !== "string" || seen.has(p) || !byId.has(p)) continue;
      seen.add(p);
      const list = children.get(p);
      if (list) list.push(r.id); else children.set(p, [r.id]);
    }
  }
  const idx: Index<T> = { len: revs.length, first: revs[0], last: revs[revs.length - 1], byId, children };
  cache.set(revs, idx as unknown as Index<Node>);
  return idx;
}

const parentsOf = (r: Node | undefined): readonly string[] => (r && Array.isArray(r.parents) ? r.parents : []);

/** Known ancestors of `id` including itself (empty when `id` is unknown). */
function ancestorsOrSelf(idx: Index<Node>, id: string): Set<string> {
  const out = new Set<string>();
  if (!idx.byId.has(id)) return out;
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    if (out.has(cur)) continue;
    out.add(cur);
    for (const p of parentsOf(idx.byId.get(cur))) if (idx.byId.has(p) && !out.has(p)) stack.push(p);
  }
  return out;
}

// ── RevisionsApi ────────────────────────────────────────────────────────────

export function unionRevisions(...manifests: readonly Pick<Manifest, "revisions">[]): Revision[] {
  const byId = new Map<string, Revision>();
  const order: string[] = [];
  for (const m of manifests) {
    for (const r of m?.revisions ?? []) {
      if (!r || typeof r.id !== "string") continue;
      const prev = byId.get(r.id);
      if (!prev) { byId.set(r.id, r); order.push(r.id); } else if (!prev.sections && r.sections) byId.set(r.id, r);
    }
  }
  return order.map((id) => byId.get(id)!);
}

export function isAncestorOrSelf(revs: readonly Revision[], ancestor: string, rev: string): boolean {
  const idx = indexOf(revs);
  if (!idx.byId.has(rev) || !idx.byId.has(ancestor)) return false;
  if (ancestor === rev) return true;
  const seen = new Set<string>();
  const stack = [rev];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === ancestor) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const p of parentsOf(idx.byId.get(cur))) if (idx.byId.has(p) && !seen.has(p)) stack.push(p);
  }
  return false;
}

export function isAncestor(revs: readonly Revision[], ancestor: string, rev: string): boolean {
  return ancestor !== rev && isAncestorOrSelf(revs, ancestor, rev);
}

export function relation(revs: readonly Revision[], mine: string, other: string): HeadRelation {
  if (mine === other) return "same";
  if (isAncestor(revs, other, mine)) return "older";
  if (isAncestor(revs, mine, other)) return "newer";
  return "diverged";
}

/** Members of `set` (closed under ancestors) that have no child in `set`. */
function lowestOf(idx: Index<Node>, set: Set<string>): string[] {
  const out: string[] = [];
  for (const id of set) if (!(idx.children.get(id) ?? []).some((c) => set.has(c))) out.push(id);
  return out.sort(cmpStr);
}

const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function commonAncestors(idx: Index<Node>, a: string, b: string): Set<string> {
  const A = ancestorsOrSelf(idx, a);
  const out = new Set<string>();
  if (!A.size) return out;
  for (const id of ancestorsOrSelf(idx, b)) if (A.has(id)) out.add(id);
  return out;
}

export function lowestCommonAncestors(revs: readonly Revision[], a: string, b: string): string[] {
  const idx = indexOf(revs);
  // The common set is closed under ancestors, so "not a strict ancestor of another member"
  // is "no child inside the set".
  return lowestOf(idx, commonAncestors(idx, a, b));
}

export function findBase(revs: readonly Revision[], mine: string, theirs: string, stored: (revisionId: string) => boolean): BaseChoice {
  const rel = relation(revs, mine, theirs);
  if (rel !== "diverged") return { kind: "notDiverged", relation: rel };
  const idx = indexOf(revs);
  const common = commonAncestors(idx, mine, theirs);
  const lowest = lowestOf(idx, common);
  const has = (id: string) => { try { return !!stored(id); } catch { return false; } };
  if (lowest.length === 1 && has(lowest[0])) return { kind: "lca", id: lowest[0] };
  if (lowest.length > 1) {
    const s = lowest.find(has);           // sorted, so the first stored one is the smallest
    if (s !== undefined) return { kind: "ambiguous", id: s };
  }
  // Among the stored common ancestors, those that are no strict ancestor of another
  // stored one: walk the common set children-first, carrying "has a stored descendant".
  const storedSet = new Set<string>();
  for (const id of common) if (has(id)) storedSet.add(id);
  if (!storedSet.size) return { kind: "none" };
  const below = storedDescendantFlags(idx, common, storedSet);
  const nearest = [...storedSet].filter((id) => !below.get(id)).sort(cmpStr);
  return nearest.length ? { kind: "nearest", id: nearest[0] } : { kind: "none" };
}

/** For each id of `set` (closed under ancestors): does a strict descendant inside `set` belong to `marked`? */
function storedDescendantFlags(idx: Index<Node>, set: Set<string>, marked: Set<string>): Map<string, boolean> {
  const pending = new Map<string, number>();       // children inside the set not processed yet
  for (const id of set) pending.set(id, (idx.children.get(id) ?? []).filter((c) => set.has(c)).length);
  const flag = new Map<string, boolean>();
  const ready = [...set].filter((id) => pending.get(id) === 0);
  for (const id of set) flag.set(id, false);
  while (ready.length) {
    const id = ready.pop()!;
    const carry = flag.get(id)! || marked.has(id);
    for (const p of parentsOf(idx.byId.get(id))) {
      if (!set.has(p)) continue;
      if (carry) flag.set(p, true);
      const n = pending.get(p)! - 1;
      pending.set(p, n);
      if (n === 0) ready.push(p);
    }
  }
  return flag;
}

export function tips(revs: readonly Revision[]): string[] {
  const idx = indexOf(revs);
  return [...idx.byId.keys()].filter((id) => !(idx.children.get(id)?.length)).sort(cmpStr);
}

/** Max-heap by (key, id). */
class Heap {
  private a: { k: number; id: string }[] = [];
  get size() { return this.a.length; }
  private static before(x: { k: number; id: string }, y: { k: number; id: string }) {
    return x.k > y.k || (x.k === y.k && x.id > y.id);
  }
  push(v: { k: number; id: string }) {
    const a = this.a;
    a.push(v);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!Heap.before(a[i], a[p])) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }
  pop(): { k: number; id: string } | undefined {
    const a = this.a;
    if (!a.length) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && Heap.before(a[l], a[m])) m = l;
        if (r < a.length && Heap.before(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

/** Every revision before its parents; among those that may come next, the larger
 *  `key` first, then the larger id. Generic so the lane layout can use it for
 *  its nodes. A cycle (damaged history) cannot stop it: the best remaining
 *  revision is then taken anyway, so every revision appears exactly once. */
export function newestFirst<T extends Node>(revs: readonly T[], key: (r: T) => number): T[] {
  const idx = indexOf(revs);
  const keyOf = new Map<string, number>();
  for (const [id, r] of idx.byId) {
    let k: number;
    try { k = Number(key(r)); } catch { k = NaN; }
    keyOf.set(id, Number.isNaN(k) ? -Infinity : k);
  }
  const waiting = new Map<string, number>();       // children not placed yet
  for (const id of idx.byId.keys()) waiting.set(id, idx.children.get(id)?.length ?? 0);
  const heap = new Heap();
  for (const [id, n] of waiting) if (n === 0) heap.push({ k: keyOf.get(id)!, id });
  const out: T[] = [];
  const placed = new Set<string>();
  const place = (id: string) => {
    placed.add(id);
    const r = idx.byId.get(id)!;
    out.push(r);
    const seen = new Set<string>();
    for (const p of parentsOf(r)) {
      if (seen.has(p) || !idx.byId.has(p) || placed.has(p)) continue;
      seen.add(p);
      const n = waiting.get(p)! - 1;
      waiting.set(p, n);
      if (n === 0) heap.push({ k: keyOf.get(p)!, id: p });
    }
  };
  while (out.length < idx.byId.size) {
    const next = heap.pop();
    if (next) { if (!placed.has(next.id)) place(next.id); continue; }
    // Only a cycle gets here: take the best revision not placed yet.
    let best: string | null = null;
    for (const id of idx.byId.keys()) {
      if (placed.has(id)) continue;
      if (best === null) { best = id; continue; }
      const kb = keyOf.get(best)!, ki = keyOf.get(id)!;
      if (ki > kb || (ki === kb && id > best)) best = id;
    }
    place(best!);
  }
  return out;
}

export function snapshotPool(files: readonly GraphFileData[]): SnapshotPool {
  /** revision id → the files that claim its content, in order. */
  const claims = new Map<string, { file: GraphFileData; rev: Revision }[]>();
  for (const file of files) {
    for (const rev of file?.manifest?.revisions ?? []) {
      if (!rev || typeof rev.id !== "string" || !rev.sections) continue;
      const list = claims.get(rev.id);
      if (list) list.push({ file, rev }); else claims.set(rev.id, [{ file, rev }]);
    }
  }
  const memo = new Map<string, SectionValues | null>();
  const load = (id: string): SectionValues | null => {
    if (memo.has(id)) return memo.get(id)!;
    let found: SectionValues | null = null;
    for (const { file, rev } of claims.get(id) ?? []) {
      found = sectionsIn(file, rev);
      if (found) break;
    }
    memo.set(id, found);
    return found;
  };
  return {
    has: (id) => load(id) !== null,
    get: (id) => load(id),
  };
}

/** The four parsed parts of `rev` from `file`, or null when one is missing or is not JSON. */
function sectionsIn(file: GraphFileData, rev: Revision): SectionValues | null {
  const parts = file.parts ?? {};
  const out = {} as SectionValues;
  for (const name of SECTION_NAMES) {
    const ref = rev.sections?.[name];
    if (!ref || typeof ref.part !== "string" || !Object.prototype.hasOwnProperty.call(parts, ref.part)) return null;
    const text = parts[ref.part];
    if (typeof text !== "string") return null;
    try { out[name] = JSON.parse(text); } catch { return null; }
  }
  return out;
}

export function survivorPath(paths: readonly string[]): string {
  let best: string | null = null;
  const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
  for (const p of paths) {
    if (typeof p !== "string") continue;
    if (best === null) { best = p; continue; }
    const a = nameOf(p), b = nameOf(best);
    if (a.length !== b.length) { if (a.length < b.length) best = p; continue; }
    if (a !== b) { if (a < b) best = p; continue; }
    if (p < best) best = p;
  }
  return best ?? "";
}

({ unionRevisions, isAncestor, isAncestorOrSelf, relation, lowestCommonAncestors, findBase, tips, newestFirst, snapshotPool, survivorPath }) satisfies RevisionsApi;
