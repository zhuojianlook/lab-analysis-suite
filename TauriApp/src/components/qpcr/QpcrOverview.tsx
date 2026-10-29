import { memo, type CSSProperties, type ReactNode } from "react";
import { Box, Chip, Stack, Typography } from "@mui/material";
import type { QpcrLibraryRun } from "../../api/client";
import { RecordTable } from "../shared/RecordTable";
import { wellCounts, type Dataset } from "./qpcrData";

const th: CSSProperties = {
  textAlign: "center", padding: "5px 10px", position: "sticky", top: 0, zIndex: 1,
  background: "#2c2c2e", borderBottom: "1px solid #48484a", color: "#8e8e93", whiteSpace: "nowrap", fontWeight: 600,
};
const td: CSSProperties = { padding: "3px 10px", borderBottom: "1px solid #38383a", color: "#e5e5ea", textAlign: "center", whiteSpace: "nowrap" };
const rowHead: CSSProperties = { ...td, textAlign: "left", position: "sticky", left: 0, background: "#1c1c1e" };
const WARN_BG = "rgba(212,160,90,0.22)";

interface Cell { text: string; title?: string; warn?: boolean }

/** Rows x runs presence table: well counts per run, a dash where absent. */
function Matrix({
  title, hint, rows, runs, cell, tag,
}: {
  title: string; hint: string; rows: string[]; runs: QpcrLibraryRun[];
  cell: (row: string, run: QpcrLibraryRun) => Cell | null; tag?: (row: string) => ReactNode;
}) {
  return (
    <Box>
      <Typography variant="subtitle2">{title}</Typography>
      <Typography variant="caption" color="text.secondary">{hint}</Typography>
      <Box sx={{ mt: 1, overflow: "auto", maxHeight: 440, border: 1, borderColor: "divider", borderRadius: 1 }}>
        <table style={{ borderCollapse: "separate", borderSpacing: 0, fontSize: 12, width: "100%" }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: "left", left: 0, zIndex: 2 }} />
              {runs.map((r) => <th key={r.id} style={th}>{r.name}</th>)}
              <th style={th}>Runs</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              let present = 0;
              const cells = runs.map((r) => {
                const c = cell(row, r);
                if (c) present += 1;
                return (
                  <td key={r.id} title={c?.title}
                    style={{ ...td, color: c ? td.color : "#636366", background: c?.warn ? WARN_BG : undefined }}>
                    {c ? c.text : "—"}
                  </td>
                );
              });
              return (
                <tr key={row}>
                  <td style={rowHead}>
                    <Stack direction="row" spacing={0.75} alignItems="center">
                      <span>{row}</span>
                      {tag?.(row)}
                    </Stack>
                  </td>
                  {cells}
                  <td style={{ ...td, color: present === runs.length ? "#8e8e93" : "#d4a05a" }}>{present}/{runs.length}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Box>
    </Box>
  );
}

/** What the included runs contain: a run summary, then genes x runs and
 *  samples x runs maps (well counts; amber = mostly at/above the Cp limit).
 *  Memoised: the per-run maps are costly and the parent re-renders on every
 *  keystroke, while these props only change with the data or selection. */
export const QpcrOverview = memo(function QpcrOverview({
  ds, refGenes, targetGenes, cpLimit,
}: {
  ds: Dataset; refGenes: string[]; targetGenes: string[]; cpLimit: number;
}) {
  const runRows = ds.runs.map((r) => ({
    Run: r.name, Source: r.source === "manual" ? "Manual entry" : "LightCycler", Added: r.added_at.replace("T", " "),
    Wells: r.n_wells, Undetermined: r.n_undetermined, Genes: r.genes.length, Samples: r.samples.length,
  }));

  const geneCell = (gene: string, run: QpcrLibraryRun): Cell | null => {
    if (!run.genes.includes(gene)) return null;
    const { n, cps } = wellCounts([run], gene, null, cpLimit);
    const lowSamples = run.samples.filter((s) => {
      const w = wellCounts([run], gene, s, cpLimit);
      return w.n > 0 && w.high / w.n >= 0.5;
    });
    const mean = cps.length ? cps.reduce((a, b) => a + b, 0) / cps.length : NaN;
    return {
      text: String(n),
      warn: lowSamples.length > 0,
      title: [
        `${n} wells`, Number.isFinite(mean) ? `mean Cp ${mean.toFixed(1)}` : "no Cp values",
        lowSamples.length ? `≥ Cp ${cpLimit} in: ${lowSamples.join(", ")}` : "",
      ].filter(Boolean).join(" · "),
    };
  };

  const sampleCell = (sample: string, run: QpcrLibraryRun): Cell | null => {
    if (!run.samples.includes(sample)) return null;
    const n = run.cells.filter((c) => c.sample === sample).reduce((k, c) => k + c.cps.length + c.n_nd, 0);
    const genes = run.cells.filter((c) => c.sample === sample).map((c) => c.gene);
    return { text: String(n), title: `${n} wells · genes: ${[...new Set(genes)].join(", ")}` };
  };

  const geneTag = (g: string) =>
    refGenes.includes(g) ? <Chip size="small" color="primary" label="ref" sx={{ height: 18, fontSize: 10 }} />
      : targetGenes.includes(g) ? <Chip size="small" variant="outlined" label="target" sx={{ height: 18, fontSize: 10 }} />
        : null;

  return (
    <Stack spacing={3}>
      <RecordTable rows={runRows} title={`Included runs (${ds.runs.length})`} downloadName="qpcr_runs.csv" />
      <Matrix
        title={`Genes × runs (${ds.genesAll.length})`}
        hint={`Wells per run; amber = at or above Cp ${cpLimit} (or undetermined) in half or more of a sample's wells. Hover for mean Cp.`}
        rows={ds.genesAll} runs={ds.runs} cell={geneCell} tag={geneTag}
      />
      <Matrix
        title={`Samples × runs (${ds.samples.length})`}
        hint="Wells per run. Hover for the genes measured."
        rows={ds.samples} runs={ds.runs} cell={sampleCell}
      />
    </Stack>
  );
});
