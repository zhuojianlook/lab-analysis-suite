import { Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from "@mui/material";
import { useFileSession } from "../file/session";
import { T } from "./text";

/** After this computer woke up while editing: Save, or the first new edit, asks first (phase 3 contract §6.5).
 *  Esc / backdrop = Wait. */
export function ResumeDialog({ what }: { what: "save" | "edit" }) {
  const answer = (choice: "go" | "wait") => useFileSession.getState().answerDialog({ kind: "resumeConfirm", choice });
  const save = what === "save";
  return (
    <Dialog open onClose={() => answer("wait")} maxWidth="xs" fullWidth slotProps={{ paper: { "data-testid": "resume-dialog", "data-what": what } as object }}>
      <DialogTitle sx={{ pb: 0.5 }}>{save ? T.resumeSaveTitle : T.resumeEditTitle}</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary">{save ? T.resumeSaveBody : T.resumeEditBody}</Typography>
      </DialogContent>
      <DialogActions>
        <Button color="inherit" data-testid="resume-wait" onClick={() => answer("wait")}>{T.resumeWait}</Button>
        <Button variant="contained" data-testid="resume-go" autoFocus onClick={() => answer("go")}>{save ? T.resumeSaveGo : T.resumeEditGo}</Button>
      </DialogActions>
    </Dialog>
  );
}
