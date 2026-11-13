import { Alert, Box, Button, CircularProgress, Paper, Stack, Typography } from "@mui/material";
import DownloadIcon from "@mui/icons-material/Download";
import type { AnalyzeResult, Template } from "../../api/graph";
import { saveDownload, utf8ToB64 } from "../../api/client";
import { RecordTable } from "../shared/RecordTable";
import { formatNum, formatP, toCsv } from "./graphModel";
import { resultTables, type ResultTableData } from "./resultTables";

/** One results table: formatted on screen, raw full-precision numbers in its CSV. */
function ResultTable({ table, fileName }: { table: ResultTableData; fileName: string }) {
  const download = () => { void saveDownload(fileName, utf8ToB64(toCsv(table.csv)), "text/csv"); };
  return (
    <Box>
      <Box sx={{ display: "flex", alignItems: "center", mb: 0.5 }}>
        <Typography variant="subtitle2">{table.title}</Typography>
        <Box sx={{ flexGrow: 1 }} />
        <Button size="small" startIcon={<DownloadIcon />} onClick={download}>CSV</Button>
      </Box>
      <RecordTable rows={table.rows} />
    </Box>
  );
}

/** Analysis output: test summary, ANOVA table, multiple comparisons,
 *  regression / correlation and descriptive statistics, each with CSV export. */
export function GraphResults({ result, error, busy, template, rowTitles, withinTitles, baseName }: {
  result: AnalyzeResult | null;
  error: string | null;
  busy: boolean;
  template: Template;
  /** Row titles of the analysed table (descriptives are per table row). */
  rowTitles: string[];
  /** Outer-level titles of grouped comparisons: row titles, or column titles when comparing within each column. */
  withinTitles: string[];
  baseName: string;
}) {
  if (!result) {
    return (
      <Box sx={{ flexGrow: 1, display: "grid", placeItems: "center", py: 6 }}>
        {error ? <Alert severity="error" sx={{ maxWidth: 560 }}>{error}</Alert>
          : busy ? <Stack alignItems="center" spacing={1.5}><CircularProgress size={28} /><Typography variant="body2" color="text.secondary">Analysing…</Typography></Stack>
            : <Typography variant="body2" color="text.secondary">Enter values on the Data tab to see statistics.</Typography>}
      </Box>
    );
  }
  const t = result.test;
  const tables = resultTables(result, template, { rowTitles, withinTitles });

  return (
    <Stack spacing={3} sx={{ opacity: busy ? 0.6 : 1, transition: "opacity 120ms" }}>
      {result.error && <Alert severity="error">{result.error}</Alert>}
      {(result.warnings ?? []).length > 0 && (
        <Alert severity="warning">{result.warnings.map((w) => <div key={w}>{w}</div>)}</Alert>
      )}

      {t && (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="overline" color="text.secondary" sx={{ lineHeight: 1.4 }}>Test</Typography>
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>{t.label}</Typography>
          {t.method && <Typography variant="body2" color="text.secondary">{t.method}</Typography>}
          <Stack direction="row" spacing={3} useFlexGap flexWrap="wrap" sx={{ mt: 1.5 }}>
            {t.statistic !== null && (
              <Box>
                <Typography variant="caption" color="text.secondary">{t.statistic_name || "Statistic"}</Typography>
                <Typography variant="body1">{formatNum(t.statistic)}</Typography>
              </Box>
            )}
            {t.df !== null && (
              <Box>
                <Typography variant="caption" color="text.secondary">DF</Typography>
                <Typography variant="body1">{formatNum(t.df)}{t.df2 !== null ? `, ${formatNum(t.df2)}` : ""}</Typography>
              </Box>
            )}
            <Box>
              <Typography variant="caption" color="text.secondary">P value</Typography>
              <Typography variant="body1">{formatP(t.p)}</Typography>
            </Box>
            <Box>
              <Typography variant="caption" color="text.secondary">Summary</Typography>
              <Typography variant="body1" sx={{ fontWeight: 600 }}>{t.star || "ns"}</Typography>
            </Box>
          </Stack>
          {t.note && <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 1 }}>{t.note}</Typography>}
        </Paper>
      )}

      {tables.map((tb) => <ResultTable key={tb.id} table={tb} fileName={`${baseName}_${tb.id}.csv`} />)}
    </Stack>
  );
}
