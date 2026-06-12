import { useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  IconButton,
  MenuItem,
  Snackbar,
  Stack,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import GridOnIcon from "@mui/icons-material/GridOn";
import DescriptionIcon from "@mui/icons-material/Description";
import ClearAllIcon from "@mui/icons-material/ClearAll";
import { usePlatemapStore, plateSpec, PLATE_DIMS } from "../../store/platemapStore";
import { exportPlatemap, saveDownload, utf8ToB64 } from "../../api/client";

const PLATE_OPTIONS = ["6", "12", "24", "48", "96", "384"];

/** A single editable well cell. Subscribes only to its own value so a keystroke
 *  doesn't re-render the whole plate (a 384-well plate has 384 cells). */
function WellCell({ fieldIdx, well }: { fieldIdx: number; well: string }) {
  const value = usePlatemapStore((s) => s.fields[fieldIdx]?.values[well] ?? "");
  const setCell = usePlatemapStore((s) => s.setCell);
  return (
    <input
      value={value}
      onChange={(e) => setCell(fieldIdx, well, e.target.value)}
      style={{
        width: 62,
        height: 34,
        textAlign: "center",
        background: value ? "#3a4a5a" : "#2c2c2e",
        color: "#e5e5ea",
        border: "1px solid #48484a",
        borderRadius: 3,
        fontSize: 12,
        outline: "none",
      }}
    />
  );
}

function PlateGrid({ fieldIdx, plate }: { fieldIdx: number; plate: string }) {
  const { rows, cols } = plateSpec(plate);
  return (
    <Box sx={{ overflow: "auto", maxHeight: "calc(100vh - 320px)", pb: 1 }}>
      <table style={{ borderCollapse: "separate", borderSpacing: 4 }}>
        <thead>
          <tr>
            <th style={{ width: 36 }} />
            {cols.map((c) => (
              <th key={c} style={{ width: 62, color: "#8e8e93", fontSize: 12, fontWeight: 600 }}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r}>
              <td
                style={{
                  width: 36,
                  textAlign: "center",
                  color: "#e5e5ea",
                  fontWeight: 700,
                  background: "#333",
                  borderRadius: 3,
                }}
              >
                {r}
              </td>
              {cols.map((c) => (
                <td key={c}>
                  <WellCell fieldIdx={fieldIdx} well={`${r}${c}`} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Box>
  );
}

export function PlatemapView() {
  const plate = usePlatemapStore((s) => s.plate);
  const fields = usePlatemapStore((s) => s.fields);
  const activeField = usePlatemapStore((s) => s.activeField);
  const { setPlate, setActiveField, setFieldLabel, addField, removeField, clearValues } =
    usePlatemapStore();

  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ msg: string; sev: "success" | "error" } | null>(null);

  // Combined preview, computed live from the per-field grids.
  const preview = useMemo(() => {
    const { rows, cols } = plateSpec(plate);
    const out: string[][] = [];
    for (const r of rows) {
      for (const c of cols) {
        const well = `${r}${c}`;
        const vals = fields.map((f) => (f.values[well] ?? "").trim());
        if (vals.some(Boolean)) out.push([well, ...vals]);
      }
    }
    return out;
  }, [plate, fields]);

  const doExport = async (fmt: "xlsx" | "tsv") => {
    setBusy(true);
    try {
      const res = await exportPlatemap(
        plate,
        fields.map((f) => f.label),
        fields.map((f) => f.values),
        fmt,
      );
      if (res.n_rows === 0) {
        setToast({ msg: "Nothing to export — all wells are empty.", sev: "error" });
        return;
      }
      let saved = false;
      if (fmt === "xlsx" && res.xlsx_b64) {
        saved = await saveDownload(
          "plate_labels.xlsx",
          res.xlsx_b64,
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        );
      } else if (fmt === "tsv" && res.tsv != null) {
        saved = await saveDownload("plate_labels.txt", utf8ToB64(res.tsv), "text/tab-separated-values");
      }
      if (saved) setToast({ msg: `Exported ${res.n_rows} wells.`, sev: "success" });
    } catch (e) {
      setToast({ msg: e instanceof Error ? e.message : String(e), sev: "error" });
    } finally {
      setBusy(false);
    }
  };

  const activeLabel = fields[activeField]?.label ?? "";
  const [nr, nc] = PLATE_DIMS[plate] ?? [8, 12];

  return (
    <Box sx={{ p: 2, height: "100%", display: "flex", flexDirection: "column", gap: 1.5 }}>
      {/* Toolbar */}
      <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap">
        <TextField
          select
          label="Plate"
          value={plate}
          onChange={(e) => setPlate(e.target.value)}
          sx={{ width: 130 }}
        >
          {PLATE_OPTIONS.map((p) => (
            <MenuItem key={p} value={p}>
              {p}-well
            </MenuItem>
          ))}
        </TextField>
        <Typography variant="caption" color="text.secondary">
          {nr} rows × {nc} cols
        </Typography>
        <Box sx={{ flexGrow: 1 }} />
        <Button startIcon={<ClearAllIcon />} color="inherit" onClick={clearValues}>
          Clear
        </Button>
        <Button
          variant="outlined"
          startIcon={<GridOnIcon />}
          disabled={busy}
          onClick={() => doExport("xlsx")}
        >
          Export Excel
        </Button>
        <Button
          variant="outlined"
          startIcon={<DescriptionIcon />}
          disabled={busy}
          onClick={() => doExport("tsv")}
        >
          Export TSV
        </Button>
      </Stack>

      {/* Field tabs */}
      <Stack direction="row" spacing={1} alignItems="center">
        <Tabs
          value={activeField}
          onChange={(_, v) => setActiveField(v)}
          variant="scrollable"
          scrollButtons="auto"
          sx={{ minHeight: 36, flexGrow: 1 }}
        >
          {fields.map((f, i) => (
            <Tab key={i} label={f.label || `Value ${i + 1}`} sx={{ minHeight: 36, textTransform: "none" }} />
          ))}
        </Tabs>
        <Tooltip title="Add value field">
          <IconButton size="small" onClick={addField}>
            <AddIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>

      {/* Active field: rename + remove + grid */}
      <Stack direction="row" spacing={1} alignItems="center">
        <TextField
          label="Value label"
          value={activeLabel}
          onChange={(e) => setFieldLabel(activeField, e.target.value)}
          sx={{ width: 240 }}
        />
        <Tooltip title="Remove this value field">
          <span>
            <IconButton
              size="small"
              color="error"
              disabled={fields.length <= 1}
              onClick={() => removeField(activeField)}
            >
              <DeleteOutlineIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>

      <PlateGrid fieldIdx={activeField} plate={plate} />

      {/* Combined preview */}
      <Typography variant="subtitle2" sx={{ mt: 1 }}>
        Combined table — {preview.length} well{preview.length === 1 ? "" : "s"}
      </Typography>
      <Box sx={{ overflow: "auto", maxHeight: 200, border: "1px solid", borderColor: "divider", borderRadius: 1 }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
          <thead>
            <tr>
              <th style={thStyle}>Cell Position</th>
              {fields.map((f, i) => (
                <th key={i} style={thStyle}>
                  {f.label || `Value ${i + 1}`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.slice(0, 500).map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td key={j} style={tdStyle}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </Box>

      <Snackbar
        open={!!toast}
        autoHideDuration={4000}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        {toast ? (
          <Alert severity={toast.sev} variant="filled" onClose={() => setToast(null)}>
            {toast.msg}
          </Alert>
        ) : undefined}
      </Snackbar>
    </Box>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "4px 8px",
  position: "sticky",
  top: 0,
  background: "#2c2c2e",
  borderBottom: "1px solid #48484a",
  color: "#8e8e93",
};
const tdStyle: React.CSSProperties = {
  padding: "3px 8px",
  borderBottom: "1px solid #38383a",
  color: "#e5e5ea",
};
