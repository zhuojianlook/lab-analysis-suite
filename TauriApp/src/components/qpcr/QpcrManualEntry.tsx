import { useState } from "react";
import { Box, Button, MenuItem, Paper, Stack, Tab, Tabs, TextField, Typography } from "@mui/material";
import { plateSpec, PLATE_DIMS } from "../../store/platemapStore";
import { useQpcrManualStore, buildQpcrRecords, type QField } from "../../store/qpcrManualStore";

const FIELDS: QField[] = ["Gene", "Sample", "Cp"];

/** One well input. Subscribes only to its own (field, well) value so typing
 *  doesn't re-render the whole plate. */
function Cell({ field, well }: { field: QField; well: string }) {
  const value = useQpcrManualStore((s) => s.values[field][well] ?? "");
  const setCell = useQpcrManualStore((s) => s.setCell);
  return (
    <input
      value={value}
      onChange={(e) => setCell(field, well, e.target.value)}
      placeholder={field === "Cp" ? "" : ""}
      style={{
        width: field === "Cp" ? 54 : 64,
        height: 30,
        textAlign: "center",
        background: value ? "#3a4a5a" : "#2c2c2e",
        color: "#e5e5ea",
        border: "1px solid #48484a",
        borderRadius: 3,
        fontSize: 11,
        outline: "none",
      }}
    />
  );
}

/** Manual qPCR data entry: a plate grid with Gene / Sample / Cp per well
 *  (replaces uploading *_qpcr.txt + *_platemap.txt). Calls onLoad with the
 *  assembled records, which feed the same analysis flow as the file path. */
export function QpcrManualEntry({
  onLoad,
}: {
  onLoad: (recs: { Sample: string; Gene: string; Cp: number }[]) => void;
}) {
  const plate = useQpcrManualStore((s) => s.plate);
  const setPlate = useQpcrManualStore((s) => s.setPlate);
  const clear = useQpcrManualStore((s) => s.clear);
  // selector returns a number → parent re-renders only when the count changes,
  // not on every keystroke.
  const count = useQpcrManualStore((s) => buildQpcrRecords(s.values, s.plate).length);
  const [field, setField] = useState<QField>("Gene");
  const { rows, cols } = plateSpec(plate);

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="subtitle2" gutterBottom>
        Manual entry — assign Gene, Sample &amp; Cp per well
      </Typography>
      <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
        <TextField select size="small" label="Plate" value={plate} onChange={(e) => setPlate(e.target.value)} sx={{ width: 110 }}>
          {Object.keys(PLATE_DIMS).map((p) => (
            <MenuItem key={p} value={p}>{p}-well</MenuItem>
          ))}
        </TextField>
        <Tabs value={field} onChange={(_, v) => setField(v)} sx={{ minHeight: 36 }}>
          {FIELDS.map((f) => (
            <Tab key={f} value={f} label={f} sx={{ minHeight: 36, textTransform: "none" }} />
          ))}
        </Tabs>
        <Box sx={{ flexGrow: 1 }} />
        <Typography variant="caption" color="text.secondary">{count} complete well{count === 1 ? "" : "s"}</Typography>
        <Button size="small" onClick={clear}>Clear</Button>
      </Stack>

      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1 }}>
        Fill the <strong>{field}</strong> for each well (switch tabs for the others). A well counts once it has all three.
      </Typography>

      <Box sx={{ overflow: "auto", maxHeight: "calc(100vh - 380px)", pb: 1 }}>
        <table style={{ borderCollapse: "separate", borderSpacing: 3 }}>
          <thead>
            <tr>
              <th style={{ width: 28 }} />
              {cols.map((c) => (
                <th key={c} style={{ color: "#8e8e93", fontSize: 11, fontWeight: 600 }}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r}>
                <td style={{ width: 28, textAlign: "center", color: "#e5e5ea", fontWeight: 700, fontSize: 11, background: "#333", borderRadius: 3 }}>{r}</td>
                {cols.map((c) => (
                  <td key={c}><Cell field={field} well={`${r}${c}`} /></td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </Box>

      <Box sx={{ mt: 1.5 }}>
        <Button
          variant="contained"
          disabled={count === 0}
          onClick={() => onLoad(buildQpcrRecords(useQpcrManualStore.getState().values, plate))}
        >
          Load {count} well{count === 1 ? "" : "s"} into analysis
        </Button>
      </Box>
    </Paper>
  );
}
