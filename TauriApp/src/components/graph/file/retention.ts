/* Which versions keep their full content in a file (plan §7.2, decision D4;
   phase 2 contract §3.3). By count and by when THIS computer first saw a
   version — a version's own `time` is never read. Entries are never removed
   and a version whose content is gone never gets it back. Pure. */

import { LIMITS_P2, type RetentionApi, type RetentionCtx } from "./contract";
import type { Manifest } from "./format";
import { newestFirst } from "./revisions";

export function keptSnapshots(m: Manifest, ctx: RetentionCtx): Set<string> {
  const revs = m.revisions;
  const stored = new Set(revs.filter((r) => r && r.sections).map((r) => r.id));
  const keep = new Set<string>();
  const add = (id: string | null | undefined) => { if (typeof id === "string" && stored.has(id)) keep.add(id); };
  const seenAt = (id: string) => {
    const t = ctx.firstSeen[id];
    return typeof t === "number" && Number.isFinite(t) ? t : ctx.now;
  };

  // 1. the head
  add(m.head);
  // 2. the newest LIMITS_P2.snapshotsKept stored versions, by first-seen order
  //    (the history order decides; versions without content take no place)
  let n = 0;
  for (const r of newestFirst(revs, (x) => seenAt(x.id))) {
    if (n >= LIMITS_P2.snapshotsKept) break;
    if (!stored.has(r.id)) continue;
    keep.add(r.id);
    n++;
  }
  const byId = new Map(revs.map((r) => [r.id, r] as const));
  for (const r of revs) {
    const parents = Array.isArray(r.parents) ? r.parents : [];
    // 3. both parents of every combine
    if (parents.length >= 2) for (const p of parents) add(p);
    // 4. hand-over points: the next version was made on another computer, seen here less than 180 days ago
    for (const p of parents) {
      const pr = byId.get(p);
      if (!pr || !stored.has(p)) continue;
      if (r.device_id !== "" && r.device_id !== pr.device_id && ctx.now - seenAt(p) < LIMITS_P2.handoverKeepMs) keep.add(p);
    }
  }
  // 5–7. heads other computers have open, unconfirmed saved copies of this computer, pinned
  for (const id of ctx.beaconHeads ?? []) add(id);
  for (const id of ctx.unconfirmedHeads ?? []) add(id);
  for (const id of ctx.pinned ?? []) add(id);
  return keep;
}

export function applyRetention(m: Manifest, ctx: RetentionCtx): Manifest {
  const keep = keptSnapshots(m, ctx);
  let changed = false;
  const revisions = m.revisions.map((r) => {
    if (!r.sections || keep.has(r.id)) return r;
    changed = true;
    return { ...r, sections: null };
  });
  return changed ? { ...m, revisions } : m;
}

({ keptSnapshots, applyRetention }) satisfies RetentionApi;
