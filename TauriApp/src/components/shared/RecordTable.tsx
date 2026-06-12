import { Box, Button, Typography } from "@mui/material";
import DownloadIcon from "@mui/icons-material/Download";
import { saveDownload, utf8ToB64 } from "../../api/client";

function fmt(v: unknown): string {
  if (typeof v === "number") {
    if (!isFinite(v)) return String(v);
    return Math.abs(v) !== 0 && (Math.abs(v) < 1e-3 || Math.abs(v) >= 1e5)
      ? v.toExponential(3)
      : v.toFixed(4).replace(/\.?0+$/, "");
  }
  return v == null ? "" : String(v);
}

/** Render an array of flat record objects as a table, with CSV download. */
export function RecordTable({
  rows,
  title,
  downloadName,
  maxRows = 500,
}: {
  rows: Record<string, unknown>[];
  title?: string;
  downloadName?: string;
  maxRows?: number;
}) {
  if (!rows || rows.length === 0) return null;
  const cols = Object.keys(rows[0]);

  const downloadCsv = () => {
    const header = cols.join(",");
    const body = rows
      .map((r) => cols.map((c) => {
        const v = r[c];
        const s = v == null ? "" : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(","))
      .join("\n");
    saveDownload(downloadName || "table.csv", utf8ToB64(header + "\n" + body + "\n"), "text/csv");
  };

  return (
    <Box>
      {(title || downloadName) && (
        <Box sx={{ display: "flex", alignItems: "center", mb: 0.5 }}>
          {title && <Typography variant="subtitle2">{title}</Typography>}
          <Box sx={{ flexGrow: 1 }} />
          {downloadName && (
            <Button size="small" startIcon={<DownloadIcon />} onClick={downloadCsv}>
              CSV
            </Button>
          )}
        </Box>
      )}
      <Box sx={{ overflow: "auto", maxHeight: 280, border: "1px solid", borderColor: "divider", borderRadius: 1 }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c} style={th}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, maxRows).map((r, i) => (
              <tr key={i}>
                {cols.map((c) => (
                  <td key={c} style={td}>{fmt(r[c])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </Box>
    </Box>
  );
}

const th: React.CSSProperties = {
  textAlign: "left", padding: "4px 8px", position: "sticky", top: 0,
  background: "#2c2c2e", borderBottom: "1px solid #48484a", color: "#8e8e93", whiteSpace: "nowrap",
};
const td: React.CSSProperties = {
  padding: "3px 8px", borderBottom: "1px solid #38383a", color: "#e5e5ea", whiteSpace: "nowrap",
};
