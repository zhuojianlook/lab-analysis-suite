import { useState } from "react";
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, Typography } from "@mui/material";
import { useFileSession } from "../file/session";
import type { DraftListItem } from "../file/contract";
import { T, whenText } from "./text";

/** Recover unsaved work…: unsaved changes that no open tab owns (contract §5.5, §11.11). */
export function RecoverDialog({ drafts }: { drafts: DraftListItem[] }) {
  const [confirm, setConfirm] = useState<string | null>(null);
  const st = useFileSession.getState;
  const close = () => st().closeDialog();
  return (
    <Dialog open onClose={close} maxWidth="sm" fullWidth slotProps={{ paper: { "data-testid": "recover-dialog" } as object }}>
      <DialogTitle sx={{ pb: 1 }}>{T.recoverTitle}</DialogTitle>
      <DialogContent>
        {drafts.length === 0 && <Typography variant="body2" color="text.secondary">{T.recoverEmpty}</Typography>}
        <Stack spacing={0.5}>
          {drafts.map((d) => (
            <Box key={d.docKey} data-testid="recover-item"
              sx={{ px: 1.25, py: 0.75, borderRadius: 1, border: 1, borderColor: "divider" }}>
              <Stack direction="row" spacing={1} alignItems="center">
                <Typography variant="body2" sx={{ flexGrow: 1, minWidth: 0 }} title={d.path ?? undefined}>
                  {T.recoverRow(d.name, d.folderLabel, whenText(d.savedAt) || "earlier")}
                </Typography>
                {confirm === d.docKey ? (
                  <>
                    <Button size="small" color="error" data-testid="recover-delete-confirm"
                      onClick={() => { setConfirm(null); void st().deleteDraft(d.docKey); }}>Delete</Button>
                    <Button size="small" color="inherit" onClick={() => setConfirm(null)}>Keep</Button>
                  </>
                ) : (
                  <>
                    <Button size="small" variant="outlined" data-testid="recover-open" onClick={() => void st().recoverDraft(d.docKey)}>Open</Button>
                    <Button size="small" color="inherit" data-testid="recover-delete" onClick={() => setConfirm(d.docKey)}>Delete</Button>
                  </>
                )}
              </Stack>
              {confirm === d.docKey && (
                <Typography variant="caption" color="text.secondary">{T.recoverDeleteConfirm}</Typography>
              )}
            </Box>
          ))}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button variant="contained" onClick={close} data-testid="recover-close">Close</Button>
      </DialogActions>
    </Dialog>
  );
}
