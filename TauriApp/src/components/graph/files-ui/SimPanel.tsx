import { useEffect, useState, type ReactNode } from "react";
import { Box, Button, Divider, IconButton, MenuItem, Paper, Stack, TextField, Tooltip, Typography } from "@mui/material";
import ComputerIcon from "@mui/icons-material/Computer";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import { useFileSession } from "../file/session";
import { useDisk } from "./PathPicker";
import { stemOf } from "./text";

const OPEN_KEY = "las.files.simPanel";

function SimButton({ id, children, onClick, disabled, off }: { id: string; children: ReactNode; onClick: () => void; disabled?: boolean; off: boolean }) {
  return (
    <Button size="small" variant="outlined" color="inherit" data-testid={id} disabled={off || disabled} onClick={onClick}
      sx={{ justifyContent: "flex-start", py: 0.1, px: 0.75, fontSize: 11, lineHeight: 1.4, borderColor: "divider", textAlign: "left", minWidth: 0 }}>
      {children}
    </Button>
  );
}

/** Browser preview only (dev builds): acts as the other computer, Finder and the
 *  sync service on the simulated disk (contract §4.14, §5.1). The app only
 *  learns about each change through its normal checks. */
export function SimPanel() {
  const { disk, folders, files } = useDisk();
  const activePath = useFileSession((s) => s.tabs.find((t) => t.key === s.activeKey)?.path ?? null);
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(OPEN_KEY) === "1"; } catch { return false; } });
  const [picked, setPicked] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [moveTo, setMoveTo] = useState("");
  const [denied, setDenied] = useState<string[]>([]);
  const [note, setNote] = useState<string>("");
  const [busy, setBusy] = useState(false);

  // Follow the active tab's file until another file is picked here.
  const path = picked && files.some((f) => f.path === picked) ? picked : activePath && files.some((f) => f.path === activePath) ? activePath : files[0]?.path ?? "";
  const file = files.find((f) => f.path === path) ?? null;
  const folder = file?.folder ?? "";
  useEffect(() => { setNewName(path ? `${stemOf(path)} renamed` : ""); }, [path]);
  const otherFolders = folders.filter((f) => f !== folder && f.startsWith("/Users/me/"));
  const target = moveTo && otherFolders.includes(moveTo) ? moveTo : otherFolders[0] ?? "";

  const toggle = () => setOpen((o) => { try { localStorage.setItem(OPEN_KEY, o ? "0" : "1"); } catch { /* ignore */ } return !o; });

  const run = async (what: string, fn: () => Promise<unknown> | unknown) => {
    if (!disk) return;
    setBusy(true);
    setNote(`${what}…`);
    try {
      const r = await fn();
      setNote(`${what}: ${typeof r === "boolean" ? (r ? "the app would quit now" : "the app stays open") : "done"}${typeof r === "string" ? ` (${r.startsWith("/") ? r.slice(r.lastIndexOf("/") + 1) : r.slice(0, 14)})` : ""}`);
      if (typeof r === "string" && r.startsWith("/") && r.endsWith(".lag") && files.every((f) => f.path !== r)) setPicked(r);
    } catch (e) {
      setNote(`${what}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const isDenied = denied.includes(folder);

  return (
    <Paper elevation={8} data-testid="sim-panel"
      sx={{ position: "fixed", right: 12, bottom: 12, zIndex: 1250, width: open ? 380 : "auto", border: 1, borderColor: "warning.dark", bgcolor: "#262628" }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ px: 1.25, py: 0.5, cursor: "pointer" }} onClick={toggle} data-testid="sim-toggle">
        <ComputerIcon sx={{ fontSize: 16, color: "warning.main" }} />
        <Typography variant="caption" sx={{ fontWeight: 600, flexGrow: 1 }}>Other computer (test)</Typography>
        <IconButton size="small" aria-label={open ? "Collapse" : "Expand"} sx={{ p: 0.25 }}>
          {open ? <ExpandMoreIcon sx={{ fontSize: 16 }} /> : <ExpandLessIcon sx={{ fontSize: 16 }} />}
        </IconButton>
      </Stack>
      {open && (
        <Box sx={{ px: 1.25, pb: 1.25, maxHeight: "62vh", overflow: "auto" }}>
          <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 1 }}>
            Acts as {disk?.otherDevice ?? "the other computer"}, Finder and Dropbox on the simulated disk.
          </Typography>
          <TextField select size="small" fullWidth label="File" value={path} sx={{ "& .MuiSelect-select": { py: "6px", fontSize: 12.5 } }} onChange={(e) => setPicked(e.target.value)}
            slotProps={{ htmlInput: { "data-testid": "sim-file" } }}>
            {files.map((f) => (
              <MenuItem key={f.path} value={f.path} dense>
                <Typography variant="body2" noWrap title={f.path}>{f.path.replace("/Users/me/", "")}{f.dataless ? " (online only)" : ""}</Typography>
              </MenuItem>
            ))}
          </TextField>
          {file && (
            <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5 }} noWrap>
              version {file.head ? file.head.slice(-6) : "–"}{file.incomplete ? " · still arriving" : ""}
            </Typography>
          )}
          <Box sx={{ mt: 1, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 0.5, "& > .full": { gridColumn: "1 / -1" } }}>
            <Typography className="full" variant="overline" color="text.secondary" sx={{ lineHeight: 1.6 }}>Other computer</Typography>
            <SimButton off={busy || !disk} id="sim-edit" disabled={!file} onClick={() => void run("Edit and save", () => disk!.remoteEdit(path))}>Edit and save</SimButton>
            <SimButton off={busy || !disk} id="sim-edit-figure" disabled={!file} onClick={() => void run("Edit graph title and save", () => disk!.remoteEdit(path, { section: "figure" }))}>Edit graph title and save</SimButton>
            <SimButton off={busy || !disk} id="sim-conflict" disabled={!file} onClick={() => void run("Conflicted copy", () => disk!.remoteConflictCopy(path))}>Make a conflicted copy</SimButton>
            <SimButton off={busy || !disk} id="sim-replace" disabled={!file} onClick={() => void run("Save over it", () => disk!.remoteReplace(path))}>Save over it (replace my last save)</SimButton>
            <SimButton off={busy || !disk} id="sim-rollback" disabled={!file} onClick={() => void run("Put back earlier version", () => disk!.rollback(path))}>Put back earlier version</SimButton>
            <SimButton off={busy || !disk} id="sim-sendback" disabled={!file} onClick={() => void run("Send back edited copy", () => disk!.sendBack(path, "/Users/me/Downloads"))}>Send back edited copy (to Downloads)</SimButton>
            <SimButton off={busy || !disk} id="sim-other" disabled={!file} onClick={() => void run("Different analysis here", () => disk!.replaceWithOther(path))}>Put a different analysis here</SimButton>
            <Divider className="full" sx={{ my: 0.25 }} />
            <Typography className="full" variant="overline" color="text.secondary" sx={{ lineHeight: 1.6 }}>Finder</Typography>
            <Stack className="full" direction="row" spacing={0.5}>
              <TextField size="small" value={newName} onChange={(e) => setNewName(e.target.value)} sx={{ flexGrow: 1 }}
                slotProps={{ htmlInput: { "data-testid": "sim-name", style: { fontSize: 12, padding: "4px 8px" } } }} />
              <SimButton off={busy || !disk} id="sim-rename" disabled={!file || !newName.trim()} onClick={() => void run("Rename", () => disk!.rename(path, newName.trim()))}>Rename</SimButton>
            </Stack>
            <SimButton off={busy || !disk} id="sim-duplicate" disabled={!file} onClick={() => void run("Duplicate", () => disk!.duplicateInFinder(path, `${stemOf(path)} copy`))}>Duplicate in Finder</SimButton>
            <Stack className="full" direction="row" spacing={0.5}>
              <TextField select size="small" value={target} onChange={(e) => setMoveTo(e.target.value)} sx={{ flexGrow: 1, minWidth: 0, "& .MuiSelect-select": { py: "4px", fontSize: 12 } }}
                slotProps={{ htmlInput: { "data-testid": "sim-move-to" } }}>
                {otherFolders.map((f) => <MenuItem key={f} value={f} dense>{f.replace("/Users/me/", "")}</MenuItem>)}
              </TextField>
              <SimButton off={busy || !disk} id="sim-move" disabled={!file || !target} onClick={() => void run("Move", () => disk!.move(path, target))}>Move</SimButton>
            </Stack>
            <SimButton off={busy || !disk} id="sim-delete" disabled={!file} onClick={() => void run("Delete", () => disk!.remove(path))}>Delete</SimButton>
            <Divider className="full" sx={{ my: 0.25 }} />
            <Typography className="full" variant="overline" color="text.secondary" sx={{ lineHeight: 1.6 }}>Dropbox and macOS</Typography>
            <SimButton off={busy || !disk} id="sim-dataless" disabled={!file} onClick={() => void run(file?.dataless ? "Download" : "Online only", () => disk!.setOnlineOnly(path, !file?.dataless))}>
              {file?.dataless ? "Online-only: turn off (download)" : "Online-only: turn on"}
            </SimButton>
            <SimButton off={busy || !disk} id="sim-incomplete" disabled={!file} onClick={() => void run("Still arriving for 8 s", () => disk!.setIncomplete(path, 8000))}>Still arriving (8 s)</SimButton>
            <SimButton off={busy || !disk} id="sim-deny" disabled={!folder} onClick={() => void run(isDenied ? "Unblock folder" : "Block folder", () => {
              disk!.setPermissionDenied(folder, !isDenied);
              setDenied((d) => (isDenied ? d.filter((x) => x !== folder) : [...d, folder]));
            })}>
              {isDenied ? "Unblock folder" : "Block folder"} ({folder.split("/").pop()})
            </SimButton>
            <SimButton off={busy || !disk} id="sim-race" disabled={!file} onClick={() => void run("Race next save", () => disk!.armSaveRace(path))}>Race next save</SimButton>
            <SimButton off={busy || !disk} id="sim-offline" disabled={!file} onClick={() => void run("Offline next save", () => disk!.armOffline(path))}>Offline next save</SimButton>
            <Divider className="full" sx={{ my: 0.25 }} />
            <Stack className="full" direction="row" spacing={0.5}>
              <SimButton off={busy || !disk} id="sim-advance" onClick={() => void run("+10 s", () => disk!.advance(10_000))}>+10 s</SimButton>
              <Tooltip title="Runs the quit routine, as quitting the app would">
                <span><SimButton off={busy || !disk} id="sim-quit" onClick={() => void run("Quit", () => useFileSession.getState().quitRoutine("menu"))}>Quit…</SimButton></span>
              </Tooltip>
              <SimButton off={busy || !disk} id="sim-reset" onClick={() => disk?.reset()}>Reset</SimButton>
            </Stack>
          </Box>
          {note && <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 1 }} data-testid="sim-note">{note}</Typography>}
        </Box>
      )}
    </Paper>
  );
}
