/** Gene order for the qPCR figures (view-only: it never changes the analysis).
 *
 *  The user's arrangement is kept as one "saved" list of gene names. What is
 *  plotted is that list filtered to the genes currently shown, with genes that
 *  were never arranged appended at the end in selection order. Moving a gene
 *  in the shown list writes the new order back into the saved list without
 *  disturbing where the hidden genes sit, so un-ticking and re-ticking a gene
 *  (or toggling the reference genes) keeps the user's arrangement. */

/** Genes in `shown`, in the saved order; genes not in `saved` follow in their
 *  `shown` order — except those in `lead` (the reference genes), which go
 *  first, where they have always been. */
export function orderGenes(saved: readonly string[], shown: readonly string[], lead: readonly string[] = []): string[] {
  const want = new Set(shown);
  const inSaved = new Set(saved);
  const first = new Set(lead);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const g of shown) {
    if (first.has(g) && !inSaved.has(g) && !seen.has(g)) { out.push(g); seen.add(g); }
  }
  for (const g of saved) {
    if (want.has(g) && !seen.has(g)) { out.push(g); seen.add(g); }
  }
  for (const g of shown) {
    if (!seen.has(g)) { out.push(g); seen.add(g); }
  }
  return out;
}

/** `list` with the item at `from` moved to index `to` (indices into the result). */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  if (from < 0 || from >= out.length) return out;
  const [it] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(to, out.length)), 0, it);
  return out;
}

/** The saved order after the shown genes were rearranged to `shownOrder`:
 *  genes not yet saved are added (at the end, in their shown order), then the
 *  slots the shown genes occupy are refilled in the new order, so hidden genes
 *  keep their places. */
export function applyShownOrder(saved: readonly string[], shownOrder: readonly string[]): string[] {
  const shown = new Set(shownOrder);
  const base = orderGenes(saved, shownOrder);           // shown genes, saved order first
  const full = [...dedupe(saved), ...base.filter((g) => !saved.includes(g))];
  let k = 0;
  return full.map((g) => (shown.has(g) ? shownOrder[k++] : g));
}

/** Reference genes first (each group in the saved order), then the rest — the Cp graph's order. */
export function refsFirst(saved: readonly string[], genes: readonly string[], refs: readonly string[]): string[] {
  const r = new Set(refs);
  const ordered = orderGenes(saved, genes);
  return [...ordered.filter((g) => r.has(g)), ...ordered.filter((g) => !r.has(g))];
}

/** Text for a screen reader after a move. */
export function moveAnnouncement(gene: string, index: number, count: number): string {
  return `${gene} moved to position ${index + 1} of ${count}.`;
}

function dedupe(list: readonly string[]): string[] {
  return [...new Set(list)];
}

// ── persistence (per gene panel, best-effort) ─────────────────────────────

export const PREF_GENE_ORDER = "las.qpcr.geneOrder";
const MAX_PANELS = 30;

type Store = { panels: Record<string, string[]>; recent: string[] };

/** Key for a gene panel: the genes the ticked runs contain. */
export function panelKey(genes: readonly string[]): string {
  return [...genes].sort().join("\u0001");
}

/** Parse the stored value; anything malformed reads as empty. */
export function parseStore(raw: string | null): Store {
  try {
    const v = raw ? JSON.parse(raw) : null;
    if (v && typeof v === "object" && v.panels && typeof v.panels === "object" && Array.isArray(v.recent)) {
      const panels: Record<string, string[]> = {};
      for (const [k, list] of Object.entries(v.panels as Record<string, unknown>)) {
        if (Array.isArray(list)) panels[k] = list.filter((g): g is string => typeof g === "string");
      }
      return { panels, recent: (v.recent as unknown[]).filter((k): k is string => typeof k === "string" && k in panels) };
    }
  } catch { /* fall through */ }
  return { panels: {}, recent: [] };
}

/** The saved order for a panel; a panel never arranged has none (its genes
 *  are shown in the order they were chosen — another experiment's order
 *  would look arbitrary here). */
export function savedOrderFor(store: Store, key: string): string[] {
  return store.panels[key] ?? [];
}

/** Store with `order` saved for `key` (null forgets it), most recent first, capped. */
export function withSavedOrder(store: Store, key: string, order: string[] | null, genes?: readonly string[]): Store {
  // Only the panel's own genes are kept (nothing from another experiment).
  if (order && genes) { const g = new Set(genes); order = order.filter((x) => g.has(x)); }
  const panels = { ...store.panels };
  let recent = store.recent.filter((k) => k !== key);
  if (order === null) {
    delete panels[key];
  } else {
    panels[key] = order;
    recent = [key, ...recent];
  }
  for (const k of recent.slice(MAX_PANELS)) delete panels[k];
  return { panels, recent: recent.slice(0, MAX_PANELS) };
}

export function readGeneOrderStore(): Store {
  try { return parseStore(localStorage.getItem(PREF_GENE_ORDER)); } catch { return { panels: {}, recent: [] }; }
}

export function writeGeneOrderStore(store: Store): void {
  try { localStorage.setItem(PREF_GENE_ORDER, JSON.stringify(store)); } catch { /* ignore */ }
}
