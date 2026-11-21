import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from "@mui/material";
import { useFileSession } from "../file/session";
import { T } from "./text";

/** Quitting with unsaved changes. Keeping them for next time is the default. */
export function QuitDialog({ dirty }: { dirty: { key: string; title: string }[] }) {
  const answer = (choice: "saveAll" | "keep" | "cancel") => useFileSession.getState().answerDialog({ kind: "quit", choice });
  return (
    <Dialog open onClose={() => answer("cancel")} maxWidth="sm" fullWidth slotProps={{ paper: { "data-testid": "quit-dialog" } as object }}>
      <DialogTitle sx={{ pb: 0.5 }}>{T.quitTitle(dirty.length)}</DialogTitle>
      <DialogContent>
        <Box component="ul" sx={{ m: 0, mt: 0.5, pl: 2.5 }}>
          {dirty.map((d) => <Typography key={d.key} component="li" variant="body2">{d.title}</Typography>)}
        </Box>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>{T.quitSub}</Typography>
      </DialogContent>
      <DialogActions>
        <Button color="inherit" data-testid="quit-cancel" onClick={() => answer("cancel")} sx={{ mr: "auto" }}>Cancel</Button>
        <Button variant="outlined" color="inherit" data-testid="quit-saveAll" onClick={() => answer("saveAll")}>{T.quitSaveAll}</Button>
        <Button variant="contained" data-testid="quit-keep" autoFocus onClick={() => answer("keep")}>{T.quitKeep}</Button>
      </DialogActions>
    </Dialog>
  );
}
