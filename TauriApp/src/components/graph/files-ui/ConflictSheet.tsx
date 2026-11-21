import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, Typography } from "@mui/material";
import type { ReactNode } from "react";
import { useFileSession } from "../file/session";
import type { ConflictChoice, ConflictInfo } from "../file/contract";
import { T, whenText, whoText } from "./text";

function Choice({ id, title, sub, primary, onClick }: { id: ConflictChoice; title: string; sub: ReactNode; primary?: boolean; onClick: () => void }) {
  return (
    <Button fullWidth variant={primary ? "contained" : "outlined"} color={primary ? "primary" : "inherit"} onClick={onClick}
      data-testid={`conflict-${id}`}
      sx={{ justifyContent: "flex-start", textAlign: "left", py: 1.25, px: 2, borderColor: "divider" }}>
      <Box>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>{title}</Typography>
        <Typography variant="caption" component="div" sx={{ opacity: 0.85, fontWeight: 400 }}>{sub}</Typography>
      </Box>
    </Button>
  );
}

/** "Not saved yet — Alice also changed this file": the lossless choices of phase 1 (contract §5.5). */
export function ConflictSheet({ info }: { info: ConflictInfo }) {
  const settings = useFileSession((s) => s.settings);
  const who = whoText(info.theirs, settings);
  const resolve = (c: ConflictChoice) => void useFileSession.getState().resolveConflict(c);
  const when = whenText(info.theirs.time);
  return (
    <Dialog open onClose={() => resolve("cancel")} maxWidth="sm" fullWidth slotProps={{ paper: { "data-testid": "conflict-sheet" } as object }}>
      <DialogTitle sx={{ pb: 0.5 }}>{T.conflictTitle(who)}</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary">
          {T.conflictBody}{when ? ` '${info.name}' was saved by ${who} ${when}.` : ""}
        </Typography>
        <Stack spacing={1.25} sx={{ mt: 2 }}>
          <Choice id="keepMine" primary title={T.keepMine} sub={T.keepMineSub(who)} onClick={() => resolve("keepMine")} />
          <Choice id="takeTheirs" title={T.useTheirs} sub={T.useTheirsSub(who)} onClick={() => resolve("takeTheirs")} />
          <Choice id="separateCopy" title={T.separateCopy} sub={T.separateCopySub(who)} onClick={() => resolve("separateCopy")} />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button color="inherit" data-testid="conflict-cancel" onClick={() => resolve("cancel")}>{T.decideLater}</Button>
      </DialogActions>
    </Dialog>
  );
}
