import { Box, Checkbox, Chip, FormControlLabel, MenuItem, Stack, TextField, ToggleButton, ToggleButtonGroup, Tooltip, Typography } from "@mui/material";
import type { AnalyzeResult, CompareId, GraphAnalysis, PosthocId, Template, TestId } from "../../api/graph";
import { RailHeading } from "../shared/RailSection";
import {
  POSTHOC_LABELS, TEST_LABELS, comparesFor, defaultPosthoc, formatNum, formatP, hasPosthoc, posthocsFor, testsFor,
} from "./graphModel";

const TEST_NOTES: Partial<Record<TestId, string>> = {
  none: "Descriptive statistics only — no P values.",
  unpaired_t: "Assumes both groups are sampled from Gaussian populations with equal SDs.",
  welch_t: "Does not assume equal SDs — the safer default for two independent groups.",
  paired_t: "Each row is a matched pair (same subject before/after). Rows missing either value are left out.",
  mann_whitney: "Non-parametric: compares ranks, no Gaussian assumption.",
  wilcoxon: "Non-parametric paired test: each row is a matched pair.",
  anova: "Assumes Gaussian populations with equal SDs. Follow with a multiple-comparisons test.",
  welch_anova: "One-way ANOVA that does not assume equal SDs; pair with Games-Howell.",
  kruskal: "Non-parametric one-way test on ranks; pair with Dunn's test.",
  two_way: "Row factor, column factor and their interaction. Replicates are independent values (not repeated measures).",
  linreg: "Least-squares straight line per data set. Replicate Y values are each treated as a separate point.",
};

const POSTHOC_NOTES: Partial<Record<PosthocId, string>> = {
  tukey: "Every mean against every other.",
  dunnett: "Every mean against the control only.",
  sidak: "Šídák-corrected comparisons — slightly more power than Bonferroni.",
  bonferroni: "Bonferroni-corrected comparisons (most conservative).",
  dunn: "Dunn's test on rank sums, adjusted for multiple comparisons.",
  games_howell: "Pairwise comparisons that do not assume equal SDs.",
};

const COMPARE_LABELS: Record<CompareId, string> = { all: "All pairs", control: "Vs control", selected: "Chosen pairs" };

/** Non-parametric alternative to suggest when normality fails. */
const ALTERNATIVE: Partial<Record<TestId, TestId>> = {
  unpaired_t: "mann_whitney", welch_t: "mann_whitney", paired_t: "wilcoxon", anova: "kruskal", welch_anova: "kruskal",
};

export function GraphAnalysisControls({
  template, analysis, setAnalysis, entities, nGroups, nRows, result,
}: {
  template: Template;
  analysis: GraphAnalysis;
  setAnalysis: (fn: (a: GraphAnalysis) => GraphAnalysis) => void;
  /** Names of what comparisons are made between (columns, or rows when a grouped table compares within columns). */
  entities: string[];
  nGroups: number;
  nRows: number;
  result: AnalyzeResult | null;
}) {
  const a = analysis;
  const available = testsFor(template, nGroups, nRows);
  const offered = available.includes(a.test) ? available : [...available, a.test];
  const usable = available.includes(a.test);
  const posthocs = posthocsFor(a.test);
  const compares = comparesFor(a.posthoc);
  const twoWay = a.test === "two_way";
  const showCompare = hasPosthoc(a.test) && a.posthoc !== "none";

  const changeTest = (test: TestId) =>
    setAnalysis((x) => {
      const posthoc = defaultPosthoc(test, entities.length);
      const opts = comparesFor(posthoc);
      return { ...x, test, posthoc, compare: opts.includes(x.compare) ? x.compare : opts[0] };
    });

  const changePosthoc = (posthoc: PosthocId) =>
    setAnalysis((x) => {
      const opts = comparesFor(posthoc);
      const compare = opts.includes(x.compare) ? x.compare : opts[0];
      return { ...x, posthoc, compare, control: compare === "control" && x.control === null ? 0 : x.control };
    });

  const togglePair = (i: number, j: number) =>
    setAnalysis((x) => {
      const has = x.pairs.some(([p, q]) => (p === i && q === j) || (p === j && q === i));
      return { ...x, pairs: has ? x.pairs.filter(([p, q]) => !((p === i && q === j) || (p === j && q === i))) : [...x.pairs, [i, j]] };
    });

  const needs = template === "column"
    ? "Needs two or more columns with values."
    : template === "grouped" ? "Needs values in two or more columns and two or more rows." : "Needs X values and at least one Y data set.";

  const normality = result?.normality ?? [];
  const failing = normality.filter((n) => n.passed === false);
  const alt = ALTERNATIVE[a.test];

  const allPairs: [number, number][] = [];
  for (let i = 0; i < entities.length; i++) for (let j = i + 1; j < entities.length; j++) allPairs.push([i, j]);
  const entityWord = template === "grouped" && a.within === "columns" ? "row" : "column";

  return (
    <Box>
      <RailHeading first>Test</RailHeading>
      <TextField select fullWidth size="small" label="Statistical test" value={a.test}
        onChange={(e) => changeTest(e.target.value as TestId)}>
        {offered.map((t) => (
          <MenuItem key={t} value={t} disabled={!available.includes(t)}>{TEST_LABELS[t]}</MenuItem>
        ))}
      </TextField>
      <Typography variant="caption" color={usable ? "text.secondary" : "warning.main"} component="div" sx={{ mt: 0.5 }}>
        {usable ? TEST_NOTES[a.test] : `${needs} Until then only descriptive statistics are shown.`}
      </Typography>

      {twoWay && (
        <>
          <RailHeading>Multiple comparisons</RailHeading>
          <ToggleButtonGroup fullWidth exclusive size="small" value={a.within}
            onChange={(_, v) => { if (v) setAnalysis((x) => ({ ...x, within: v, control: null, pairs: [] })); }}>
            <ToggleButton value="rows">Within each row</ToggleButton>
            <ToggleButton value="columns">Within each column</ToggleButton>
          </ToggleButtonGroup>
          <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5 }}>
            {a.within === "rows"
              ? "Compares the column groups at each row (e.g. WT vs KO at each time point)."
              : "Compares the rows within each column group (e.g. time points within WT)."}
          </Typography>
        </>
      )}

      {hasPosthoc(a.test) && (
        <>
          {!twoWay && <RailHeading>Multiple comparisons</RailHeading>}
          <TextField select fullWidth size="small" label="Post-hoc test" value={a.posthoc} sx={{ mt: twoWay ? 1 : 0 }}
            onChange={(e) => changePosthoc(e.target.value as PosthocId)}>
            {posthocs.map((p) => <MenuItem key={p} value={p}>{POSTHOC_LABELS[p]}</MenuItem>)}
          </TextField>
          {POSTHOC_NOTES[a.posthoc] && (
            <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5 }}>{POSTHOC_NOTES[a.posthoc]}</Typography>
          )}
        </>
      )}

      {showCompare && compares.length > 1 && (
        <ToggleButtonGroup fullWidth exclusive size="small" value={a.compare} sx={{ mt: 1 }}
          onChange={(_, v) => { if (v) setAnalysis((x) => ({ ...x, compare: v, control: v === "control" && x.control === null ? 0 : x.control })); }}>
          {compares.map((c) => <ToggleButton key={c} value={c}>{COMPARE_LABELS[c]}</ToggleButton>)}
        </ToggleButtonGroup>
      )}

      {showCompare && a.compare === "control" && (
        <TextField select fullWidth size="small" label={`Control ${entityWord}`} value={a.control ?? 0} sx={{ mt: 1 }}
          onChange={(e) => setAnalysis((x) => ({ ...x, control: Number(e.target.value) }))}>
          {entities.map((name, i) => <MenuItem key={i} value={i}>{name}</MenuItem>)}
        </TextField>
      )}

      {showCompare && a.compare === "selected" && (
        <Box sx={{ mt: 1, maxHeight: 220, overflow: "auto", border: 1, borderColor: "divider", borderRadius: 1, px: 1, py: 0.5 }}>
          {allPairs.length === 0 && <Typography variant="caption" color="text.secondary">Needs two or more {entityWord}s.</Typography>}
          {allPairs.map(([i, j]) => (
            <FormControlLabel key={`${i}-${j}`} sx={{ display: "flex", ml: -0.5, mr: 0 }}
              control={<Checkbox size="small" sx={{ p: 0.5 }}
                checked={a.pairs.some(([p, q]) => (p === i && q === j) || (p === j && q === i))}
                onChange={() => togglePair(i, j)} />}
              label={<Typography variant="body2" noWrap>{entities[i]} vs {entities[j]}</Typography>} />
          ))}
        </Box>
      )}
      {showCompare && a.compare === "selected" && a.pairs.length === 0 && allPairs.length > 0 && (
        <Typography variant="caption" color="warning.main" component="div" sx={{ mt: 0.5 }}>Tick at least one pair to compare.</Typography>
      )}

      {twoWay && showCompare && (
        <TextField select fullWidth size="small" label="Correct for multiple comparisons across" value={a.family} sx={{ mt: 1 }}
          onChange={(e) => setAnalysis((x) => ({ ...x, family: e.target.value as GraphAnalysis["family"] }))}>
          <MenuItem value="all">All comparisons (one family)</MenuItem>
          <MenuItem value="per_row">Each {a.within === "rows" ? "row" : "column"} separately</MenuItem>
        </TextField>
      )}

      {template === "xy" && (
        <>
          <RailHeading>Correlation</RailHeading>
          <TextField select fullWidth size="small" label="Correlation coefficient" value={a.correlation}
            onChange={(e) => setAnalysis((x) => ({ ...x, correlation: e.target.value as GraphAnalysis["correlation"] }))}>
            <MenuItem value="none">None</MenuItem>
            <MenuItem value="pearson">Pearson r (linear, Gaussian)</MenuItem>
            <MenuItem value="spearman">Spearman r (rank, non-parametric)</MenuItem>
          </TextField>
        </>
      )}

      <RailHeading>Significance level</RailHeading>
      <TextField select size="small" label="α" value={a.alpha} sx={{ width: 120 }}
        onChange={(e) => setAnalysis((x) => ({ ...x, alpha: Number(e.target.value) }))}>
        {[0.05, 0.01, 0.001].map((v) => <MenuItem key={v} value={v}>{v}</MenuItem>)}
      </TextField>
      <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5 }}>
        Stars use the GraphPad convention: * ≤ 0.05, ** ≤ 0.01, *** ≤ 0.001, **** ≤ 0.0001. α sets which results count as significant.
      </Typography>

      {normality.length > 0 && template !== "xy" && (
        <>
          <RailHeading>Normality (Shapiro-Wilk)</RailHeading>
          <Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap">
            {normality.map((n) => (
              <Tooltip key={`${n.col}-${n.label}`}
                title={n.passed === null ? (n.note || "Not tested (needs at least 3 values)") : `W = ${formatNum(n.w)}, P = ${formatP(n.p)}, n = ${n.n}${n.note ? ` — ${n.note}` : ""}`}>
                <Chip size="small" variant="outlined"
                  color={n.passed === true ? "success" : n.passed === false ? "warning" : "default"}
                  label={`${n.label}: ${n.passed === true ? "normal" : n.passed === false ? "not normal" : "n/a"}`} />
              </Tooltip>
            ))}
          </Stack>
          {failing.length > 0 && alt && (
            <Typography variant="caption" color="warning.main" component="div" sx={{ mt: 0.5 }}>
              {failing.length === 1 ? `${failing[0].label} departs` : `${failing.length} groups depart`} from a Gaussian distribution
              (P &lt; 0.05). Consider the {TEST_LABELS[alt]}.
            </Typography>
          )}
          <Typography variant="caption" color="text.disabled" component="div" sx={{ mt: 0.5 }}>
            With small samples a normality test has little power — passing it doesn't prove the data are Gaussian.
          </Typography>
        </>
      )}
    </Box>
  );
}
