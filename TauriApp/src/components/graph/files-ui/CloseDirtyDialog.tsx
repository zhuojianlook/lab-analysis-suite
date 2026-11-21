import { Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from "@mui/material";
import { useFileSession } from "../file/session";
import { T } from "./text";

/** Closing a tab with unsaved changes: Save / Discard changes / Cancel. */
export function CloseDirtyDialog({ title }: { title: string }) {
  const answer = (choice: "save" | "discard" | "cancel") => useFileSession.getState().answerDialog({ kind: "closeDirty", choice });
  return (
    <Dialog open onClose={() => answer("cancel")} maxWidth="xs" fullWidth slotProps={{ paper: { "data-testid": "close-dialog" } as object }}>
      <DialogTitle sx={{ pb: 0.5 }}>{T.closeDirty(title)}</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary">{T.closeDirtySub}</Typography>
      </DialogContent>
      <DialogActions>
        <Button color="error" data-testid="close-discard" onClick={() => answer("discard")} sx={{ mr: "auto" }}>Discard changes</Button>
        <Button color="inherit" data-testid="close-cancel" onClick={() => answer("cancel")}>Cancel</Button>
        <Button variant="contained" data-testid="close-save" autoFocus onClick={() => answer("save")}>Save</Button>
      </DialogActions>
    </Dialog>
  );
}
