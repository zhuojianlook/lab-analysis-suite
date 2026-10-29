import type { QpcrLibraryRun } from "../../api/client";

/** The runs included in an analysis, combined. */
export interface Dataset {
  runs: QpcrLibraryRun[];
  runIds: number[];
  genesAll: string[];
  /** Genes present in every included run. */
  genesCommon: string[];
  samples: string[];
  wells: number;
  /** How many of the included runs contain each gene / sample. */
  geneRuns: Map<string, number>;
  sampleRuns: Map<string, number>;
  /** How many of the included runs have at least one DETERMINED Cp for each gene. */
  geneDetectedRuns: Map<string, number>;
}

export function buildDataset(runs: QpcrLibraryRun[]): Dataset {
  const geneRuns = new Map<string, number>();
  const sampleRuns = new Map<string, number>();
  const geneDetectedRuns = new Map<string, number>();
  for (const r of runs) {
    r.genes.forEach((g) => geneRuns.set(g, (geneRuns.get(g) ?? 0) + 1));
    r.samples.forEach((s) => sampleRuns.set(s, (sampleRuns.get(s) ?? 0) + 1));
    new Set(r.cells.filter((c) => c.cps.length > 0).map((c) => c.gene))
      .forEach((g) => geneDetectedRuns.set(g, (geneDetectedRuns.get(g) ?? 0) + 1));
  }
  const genesAll = [...geneRuns.keys()].sort();
  return {
    runs,
    runIds: runs.map((r) => r.id).sort((a, b) => a - b),
    genesAll,
    genesCommon: genesAll.filter((g) => geneRuns.get(g) === runs.length),
    samples: [...sampleRuns.keys()].sort(),
    wells: runs.reduce((n, r) => n + r.n_wells, 0),
    geneRuns,
    sampleRuns,
    geneDetectedRuns,
  };
}

/** Wells and how many of them are undetermined or at/above `limit`, for one
 *  gene x sample across `runs`. */
export function wellCounts(runs: QpcrLibraryRun[], gene: string, sample: string | null, limit: number) {
  let n = 0;
  let high = 0;
  const cps: number[] = [];
  for (const r of runs) {
    for (const c of r.cells) {
      if (c.gene !== gene || (sample !== null && c.sample !== sample)) continue;
      n += c.cps.length + c.n_nd;
      high += c.n_nd + c.cps.filter((v) => v >= limit).length;
      cps.push(...c.cps);
    }
  }
  return { n, high, cps };
}

/** Genes that are effectively not detected in some samples: for a gene x
 *  sample, at least half of its wells are undetermined or at/above the Cp
 *  limit (LightCycler reports wells that never amplified at its cycle cap,
 *  e.g. exactly 35). Returns gene -> the samples where that happens. */
export function notDetected(
  runs: QpcrLibraryRun[], genes: string[], samples: string[], limit: number,
): Map<string, string[]> {
  const agg = new Map<string, { n: number; high: number }>();
  for (const r of runs) {
    for (const c of r.cells) {
      const k = `${c.gene}\u0000${c.sample}`;
      const a = agg.get(k) ?? { n: 0, high: 0 };
      a.n += c.cps.length + c.n_nd;
      a.high += c.n_nd + c.cps.filter((v) => v >= limit).length;
      agg.set(k, a);
    }
  }
  const out = new Map<string, string[]>();
  for (const g of genes) {
    const bad = samples.filter((s) => {
      const a = agg.get(`${g}\u0000${s}`);
      return !!a && a.n > 0 && a.high / a.n >= 0.5;
    });
    if (bad.length) out.set(g, bad);
  }
  return out;
}

/** HSL (degrees, %, %) -> #rrggbb — the colour input and R both need hex. */
function hslHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const lig = l / 100;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return lig - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
  };
  const hex = (x: number) => Math.round(x * 255).toString(16).padStart(2, "0");
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`;
}

/** Give each sample without a colour the first palette colour not used by the
 *  current samples, then golden-angle hues once the palette runs out. Only the
 *  current samples count as "used", so colours don't depend on which runs were
 *  ticked earlier; the search is bounded, so huge sample sets just reuse colours. */
export function assignColors(prev: Record<string, string>, samples: string[], palette: string[]): Record<string, string> {
  const next = { ...prev };
  const used = new Set(samples.filter((s) => next[s]).map((s) => next[s].toLowerCase()));
  let k = 0;
  for (const s of samples) {
    if (next[s]) continue;
    let c = palette.find((p) => !used.has(p.toLowerCase()));
    for (let tries = 0; (!c || used.has(c)) && tries < 720; tries++) c = hslHex(Math.round(k++ * 137.508) % 360, 45, 52);
    next[s] = c!;
    used.add(next[s].toLowerCase());
  }
  return next;
}

/** Subset of a per-sample map (keeps request keys stable for live re-renders). */
export function pick<T>(m: Record<string, T>, keys: string[]): Record<string, T> {
  return Object.fromEntries(keys.filter((k) => k in m).map((k) => [k, m[k]]));
}
