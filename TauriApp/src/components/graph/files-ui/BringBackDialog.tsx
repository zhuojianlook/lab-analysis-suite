import { Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from "@mui/material";
import { useFileSession } from "../file/session";
import type { VersionInfo } from "../file/contract";
import { V, whenText } from "./text";

/** "Bring back the version from …?" when the tab has unsaved changes (phase 2 contract §6.2). */
export function BringBackDialog({ version }: { version: VersionInfo }) {
  const answer = (choice: "saveFirst" | "cancel") => useFileSession.getState().answerDialog({ kind: "bringBackDirty", choice });
  return (
    <Dialog open onClose={() => answer("cancel")} maxWidth="xs" fullWidth slotProps={{ paper: { "data-testid": "bringback-dialog" } as object }}>
      <DialogTitle sx={{ pb: 0.5 }}>{V.bringBackTitle(whenText(version.time) || "earlier")}</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary">{V.bringBackBody}</Typography>
      </DialogContent>
      <DialogActions>
        <Button color="inherit" data-testid="bringback-cancel" onClick={() => answer("cancel")}>{V.cancel}</Button>
        <Button variant="contained" data-testid="bringback-save" autoFocus onClick={() => answer("saveFirst")}>{V.bringBackSave}</Button>
      </DialogActions>
    </Dialog>
  );
}
