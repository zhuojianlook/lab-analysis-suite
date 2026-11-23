import { Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from "@mui/material";
import { useFileSession } from "../file/session";
import type { PeerView } from "../file/contract";
import { T, editAnywayText } from "./text";

/** "Edit anyway?" before editing over someone else's editing (phase 3 contract §6.5). Esc / backdrop = Cancel. */
export function EditAnywayDialog({ peers }: { peers: PeerView[] }) {
  const answer = (choice: "edit" | "cancel") => useFileSession.getState().answerDialog({ kind: "editAnyway", choice });
  return (
    <Dialog open onClose={() => answer("cancel")} maxWidth="xs" fullWidth slotProps={{ paper: { "data-testid": "editanyway-dialog" } as object }}>
      <DialogTitle sx={{ pb: 0.5 }}>{T.editAnywayTitle}</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary">{editAnywayText(peers)}</Typography>
      </DialogContent>
      <DialogActions>
        <Button color="inherit" data-testid="editanyway-cancel" onClick={() => answer("cancel")}>{T.cancel}</Button>
        <Button variant="contained" data-testid="editanyway-go" autoFocus onClick={() => answer("edit")}>{T.editAnywayGo}</Button>
      </DialogActions>
    </Dialog>
  );
}
