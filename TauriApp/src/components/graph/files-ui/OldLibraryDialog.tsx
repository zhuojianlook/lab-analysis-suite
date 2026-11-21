import { Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from "@mui/material";
import { useFileSession } from "../file/session";
import { LibraryList, useGraphLibrary } from "../GraphLibrary";
import { T } from "./text";

/** "Old library…": the in-app list from before files, read-only (contract §5.5). */
export function OldLibraryDialog() {
  const lib = useGraphLibrary();
  const st = useFileSession.getState;
  const close = () => st().closeDialog();
  return (
    <Dialog open onClose={close} maxWidth="sm" fullWidth slotProps={{ paper: { "data-testid": "old-library-dialog" } as object }}>
      <DialogTitle sx={{ pb: 0.5 }}>{T.oldLibraryTitle}</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>{T.oldLibraryLine}</Typography>
        <LibraryList lib={lib} onOpen={async (id) => { await st().importLibraryRow(id); }} />
      </DialogContent>
      <DialogActions>
        <Button color="inherit" data-testid="old-library-export" onClick={() => void st().openExport()} sx={{ mr: "auto" }}>
          Export library to files…
        </Button>
        <Button variant="contained" data-testid="old-library-close" onClick={close}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
