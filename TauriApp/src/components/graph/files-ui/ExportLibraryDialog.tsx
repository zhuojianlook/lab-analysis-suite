import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, LinearProgress, Stack, Typography } from "@mui/material";
import { useFileSession } from "../file/session";
import type { ExportState } from "../file/contract";
import { T } from "./text";

/** One-time export of the old in-app library to files (plan §12, contract §5.5). */
export function ExportLibraryDialog({ state }: { state: ExportState }) {
  const st = useFileSession.getState;
  const running = state.phase === "running";
  const close = () => st().closeDialog();
  const exported = state.done;
  return (
    <Dialog open onClose={running ? undefined : close} maxWidth="sm" fullWidth slotProps={{ paper: { "data-testid": "export-dialog" } as object }}>
      <DialogTitle sx={{ pb: 1 }}>{T.exportTitle}</DialogTitle>
      <DialogContent>
        {state.phase === "confirm" && (
          <Stack spacing={1}>
            <Typography variant="body2">{T.exportConfirm(state.total)}</Typography>
            {state.already > 0 && <Typography variant="body2" color="text.secondary">{T.exportAlready(state.already)}</Typography>}
            <Typography variant="caption" color="text.secondary">
              Each analysis becomes its own file. The old in-app list isn't changed.
            </Typography>
          </Stack>
        )}
        {running && (
          <Stack spacing={1}>
            <Typography variant="body2" data-testid="export-progress">{T.exportProgress(state.done, state.total)}</Typography>
            <LinearProgress variant="determinate" value={state.total ? (100 * (state.done + state.failed.length)) / state.total : 0} />
          </Stack>
        )}
        {state.phase === "done" && (
          <Stack spacing={1} data-testid="export-result">
            <Typography variant="body2" sx={{ fontWeight: 600 }}>{T.exportDone(exported, state.total)}</Typography>
            {state.failed.length > 0 && (
              <Box>
                <Typography variant="body2" color="warning.main">{T.exportFailed(state.failed.length)}</Typography>
                <Box component="ul" sx={{ my: 0.5, pl: 2.5 }}>
                  {state.failed.map((f) => (
                    <Typography key={f.id} component="li" variant="body2">{f.name} — {f.reason}</Typography>
                  ))}
                </Box>
              </Box>
            )}
            {state.dir && exported > 0 && (
              <Typography variant="body2" color="text.secondary">{T.exportClosing(state.folderLabel)}</Typography>
            )}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        {state.phase === "confirm" && (
          <>
            <Button color="inherit" data-testid="export-close" onClick={close}>{T.exportNotNow}</Button>
            <Button variant="contained" data-testid="export-start" autoFocus onClick={() => void st().exportLibrary()}>{T.exportChoose}</Button>
          </>
        )}
        {state.phase === "done" && (
          <>
            {state.failed.length > 0 && (
              <Button color="inherit" data-testid="export-retry" onClick={() => void st().exportLibrary(state.dir ?? undefined)} sx={{ mr: "auto" }}>
                Try again
              </Button>
            )}
            <Button variant="contained" data-testid="export-close" onClick={close}>Close</Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}
