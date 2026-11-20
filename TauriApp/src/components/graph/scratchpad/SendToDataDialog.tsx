/* Confirmation for "Send selection to Data": shows what will land where and
   what it replaces, then pastes the values into the Data table as one undo step. */

import { useEffect, useMemo, useState } from "react";
import {
  Alert, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, Stack, Typography,
} from "@mui/material";
import { useGraphStore } from "../../../store/graphStore";
import { MAX_COLS, MAX_ROWS, leadCols, previewPaste, type PasteAnchor, type PasteResult } from "../graphModel";
import { MOD_KEY } from "../GraphLibrary";
import { rangeName, type CellRange } from "./scratchModel";

export interface SendInfo {
  range: CellRange;
  tsv: string;
  rows: number;
  cols: number;
  errors: number;
  /** Date-formatted cells (sent as their serial numbers). */
  dates?: number;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function SendToDataDialog({ info, onClose, onSent }: {
  info: SendInfo | null;
  onClose: () => void;
  onSent: (r: PasteResult) => void;
}) {
  const doc = useGraphStore((s) => s.doc);
  const template = doc?.template ?? "column";
  const hasLead = template !== "column";
  const [leadFirst, setLeadFirst] = useState(true);
  const [clearFirst, setClearFirst] = useState(false);

  useEffect(() => { if (info) { setLeadFirst(true); setClearFirst(false); } }, [info]);

  const anchor: PasteAnchor = { row: 0, fc: hasLead && leadFirst ? 0 : leadCols(template).length };
  const preview = useMemo(
    () => (doc && info ? previewPaste(doc, anchor, info.tsv, clearFirst) : null),
    [doc, info, anchor.fc, clearFirst], // eslint-disable-line react-hooks/exhaustive-deps
  );

  if (!info || !doc) return null;
  const replace = !!preview && preview.overwritten > 0;
  const confirm = () => {
    const res = useGraphStore.getState().sendBlock(anchor, info.tsv, clearFirst);
    if (res) onSent(res);
    else onClose();
  };

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Send to the Data table</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={1.5}>
          <Typography variant="body2">
            Send <b>{rangeName(info.range)}</b> ({plural(info.rows, "row")} × {plural(info.cols, "column")}) to the Data table,
            starting at its first row{hasLead && leadFirst ? " and first column" : ""}. Values are sent at full precision.
          </Typography>
          {hasLead && (
            <FormControlLabel
              control={<Checkbox size="small" checked={leadFirst} onChange={(e) => setLeadFirst(e.target.checked)} />}
              label={<Typography variant="body2">
                {template === "xy" ? "The first selected column is the X values" : "The first selected column is the row titles"}
              </Typography>} />
          )}
          <FormControlLabel
            control={<Checkbox size="small" checked={clearFirst} onChange={(e) => setClearFirst(e.target.checked)} />}
            label={<Typography variant="body2">Clear the Data table first (otherwise values outside this block are kept)</Typography>} />
          {preview?.titles && <Alert severity="info">The first row will be used as column titles.</Alert>}
          {replace && (
            <Alert severity="warning">
              This replaces {plural(preview!.overwritten, "existing value")} in the Data table ({MOD_KEY} + Z on the Data tab undoes it).
            </Alert>
          )}
          {preview?.truncated && (
            <Alert severity="warning">Values beyond {MAX_COLS} groups / {MAX_ROWS} rows will be left out.</Alert>
          )}
          {!!info.dates && (
            <Alert severity="info">
              {plural(info.dates, "date")} will be sent as {info.dates === 1 ? "its" : "their"} Excel serial number{info.dates === 1 ? "" : "s"} (days since 1900,
              e.g. 1/1/2024 → 45292), since the Data table holds numbers only.
            </Alert>
          )}
          {info.errors > 0 && (
            <Alert severity="warning">{plural(info.errors, "cell")} with errors will be sent as blank.</Alert>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button autoFocus variant="contained" color={replace ? "warning" : "primary"} onClick={confirm} disabled={!preview}>
          {replace ? "Replace and send" : "Send"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
