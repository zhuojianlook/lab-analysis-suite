import { useState } from "react";
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, Radio, RadioGroup, Typography } from "@mui/material";
import { useFileSession } from "../file/session";
import type { SessionDialog } from "../file/contract";
import { T } from "./text";
import { isReadOnlyTab } from "./DocBar";

type D = Extract<SessionDialog, { kind: "saveAsKind" }>;

/** Save As: "a new analysis, or the same analysis in a new place?" (decision D7). */
export function SaveAsKindDialog({ d }: { d: D }) {
  // Read-only (another computer is editing): "the same analysis" would write into it, so it is not offered (fixer F5).
  const readOnly = useFileSession((s) => { const t = s.tabs.find((x) => x.key === s.activeKey); return !!t && isReadOnlyTab(t); });
  const [picked, setChoice] = useState<"new" | "same">(d.preselect);
  const choice = readOnly ? "new" : picked;
  const answer = (c: "new" | "same" | "cancel") => useFileSession.getState().answerDialog({ kind: "saveAsKind", choice: c });
  const option = (value: "new" | "same", title: string, sub: string, disabled = false) => (
    <FormControlLabel value={value} data-testid={`saveas-${value}`} sx={{ alignItems: "flex-start", mt: 1, mr: 0 }} disabled={disabled}
      control={<Radio size="small" sx={{ mt: -0.5 }} />}
      label={
        <Box>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>{title}</Typography>
          <Typography variant="caption" color="text.secondary">{sub}</Typography>
        </Box>
      } />
  );
  return (
    <Dialog open onClose={() => answer("cancel")} maxWidth="sm" fullWidth slotProps={{ paper: { "data-testid": "saveas-dialog" } as object }}>
      <DialogTitle sx={{ pb: 0.5 }}>Save As</DialogTitle>
      <DialogContent>
        <Typography variant="caption" color="text.secondary" component="div">{T.saveAsSub(d.folderLabel, d.name)}</Typography>
        <Typography variant="body2" sx={{ mt: 1.5 }}>{T.saveAsQuestion}</Typography>
        <RadioGroup value={choice} onChange={(e) => setChoice(e.target.value as "new" | "same")} sx={{ mt: 0.5 }}>
          {option("new", T.saveAsNew, T.saveAsNewSub)}
          {option("same", T.saveAsSame, readOnly ? T.saveAsSameReadOnly : T.saveAsSameSub, readOnly)}
        </RadioGroup>
      </DialogContent>
      <DialogActions>
        <Button color="inherit" data-testid="saveas-cancel" onClick={() => answer("cancel")}>Cancel</Button>
        <Button variant="contained" data-testid="saveas-save" autoFocus onClick={() => answer(choice)}>Save</Button>
      </DialogActions>
    </Dialog>
  );
}
