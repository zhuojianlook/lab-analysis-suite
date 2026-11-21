import { useState } from "react";
import {
  Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, LinearProgress, Radio, Stack, Typography,
} from "@mui/material";
import { useFileSession } from "../file/session";
import type { FindState, LocateMatch } from "../file/contract";
import { T, baseName, whenText, whoText } from "./text";

/** "Lab › Old › Dose response.lag": where a match is, below the searched folder. */
function placeOf(m: LocateMatch, f: FindState): string {
  const dir = f.dir.replace(/\/+$/, "");
  const rel = m.path.startsWith(dir + "/") ? m.path.slice(dir.length + 1) : m.path;
  const parts = rel.split("/");
  const file = parts.pop() ?? rel;
  return [f.folderLabel, ...parts].filter(Boolean).join(" › ") + ` › ${file}`;
}

/** Find it…: search a folder for the file by what's inside it, not its name (contract §4.11, §5.5). */
export function FindDialog({ find }: { find: FindState }) {
  const settings = useFileSession((s) => s.settings);
  const [picked, setPicked] = useState(0);
  const st = useFileSession.getState;
  const result = find.result;
  const matches = result?.ok ? result.matches : [];
  const cancel = () => st().cancelFind();

  let body;
  if (find.phase === "scanning") {
    body = (
      <Stack spacing={1.5}>
        <Typography variant="body2" data-testid="find-progress">{T.findScanning(find.folderLabel, find.scanned)}</Typography>
        <LinearProgress />
      </Stack>
    );
  } else if (!result) {
    body = null;
  } else if (!result.ok) {
    body = <Alert severity="error">{result.code === "PermissionDenied" ? "This folder can't be read." : result.code === "NotFound" ? "This folder can't be found." : "The folder couldn't be searched."}</Alert>;
  } else {
    body = (
      <Stack spacing={1.25}>
        {matches.length > 1 && (
          <>
            <Typography variant="body2">{T.findSeveral(matches.length)}</Typography>
            <Stack spacing={0.5}>
              {matches.map((m, i) => {
                const who = whoText({ head: m.head, userName: m.userName, deviceName: m.deviceName, time: m.time, mine: !!settings && m.userName === settings.userName && m.deviceName === settings.deviceName }, settings);
                return (
                  <Box key={m.path} data-testid="find-match" data-path={m.path} onClick={() => setPicked(i)}
                    onDoubleClick={() => void st().chooseFound(m.path)}
                    sx={{
                      display: "flex", alignItems: "center", gap: 1, px: 1, py: 0.5, borderRadius: 1, cursor: "pointer", border: 1,
                      borderColor: picked === i ? "primary.main" : "divider", "&:hover": { bgcolor: "action.hover" },
                    }}>
                    <Radio size="small" checked={picked === i} onChange={() => setPicked(i)} sx={{ p: 0.5 }} />
                    <Box sx={{ minWidth: 0 }}>
                      <Typography variant="body2" noWrap title={m.path}>{placeOf(m, find)}</Typography>
                      <Typography variant="caption" color="text.secondary">saved by {who}{m.time ? ` · ${whenText(m.time)}` : ""}</Typography>
                    </Box>
                  </Box>
                );
              })}
            </Stack>
          </>
        )}
        {matches.length === 0 && result.onlineOnlyCount > 0 && (
          <Box>
            <Typography variant="body2">{T.findOnlineOnly(result.onlineOnlyCount)}</Typography>
            <Box component="ul" sx={{ my: 0.5, pl: 2.5 }}>
              {result.onlineOnly.map((p) => <Typography key={p} component="li" variant="body2" title={p}>{baseName(p)}</Typography>)}
            </Box>
            <Typography variant="body2" color="text.secondary">{T.findOnlineOnlyHint}</Typography>
          </Box>
        )}
        {matches.length === 0 && result.onlineOnlyCount === 0 && (
          <Typography variant="body2" data-testid="find-none">{T.findNone}</Typography>
        )}
        {result.truncated && <Typography variant="caption" color="text.secondary">{T.findTruncated}</Typography>}
        {result.skippedFolders.length > 0 && (
          <Typography variant="caption" color="text.secondary">{T.findSkipped(result.skippedFolders.length)}</Typography>
        )}
      </Stack>
    );
  }

  return (
    <Dialog open onClose={cancel} maxWidth="sm" fullWidth slotProps={{ paper: { "data-testid": "find-dialog" } as object }}>
      <DialogTitle sx={{ pb: 1 }}>{T.findTitle(find.name)}</DialogTitle>
      <DialogContent>{body}</DialogContent>
      <DialogActions>
        {find.phase === "results" && (
          <Button color="inherit" data-testid="find-another" onClick={() => void st().findIt(find.tabKey)} sx={{ mr: "auto" }}>
            {T.findAnother}
          </Button>
        )}
        <Button color="inherit" data-testid="find-cancel" onClick={cancel}>{find.phase === "scanning" ? "Cancel" : "Close"}</Button>
        {matches.length > 1 && (
          <Button variant="contained" data-testid="find-open" onClick={() => void st().chooseFound(matches[Math.min(picked, matches.length - 1)].path)}>
            Open
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
