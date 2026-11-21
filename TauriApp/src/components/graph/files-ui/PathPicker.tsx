import { useEffect, useMemo, useState } from "react";
import {
  Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField, Typography,
} from "@mui/material";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import InsertDriveFileOutlinedIcon from "@mui/icons-material/InsertDriveFileOutlined";
import CloudOffOutlinedIcon from "@mui/icons-material/CloudOffOutlined";
import { useFileSession } from "../file/session";
import type { DevSimApi, PathPickerRequest, SimFile } from "../file/contract";
import { baseName } from "./text";

/** The simulated disk of the browser preview (the simulator in dev builds; the same world, without the panel, otherwise). */
export async function previewDisk(): Promise<DevSimApi> {
  const m = await import("../file/devSim");
  const sim = m.devSim();
  if (sim) return sim;
  const p = await import("../file/previewBackend");
  return m.makeDevSim(p.previewBackend());
}

/** Keeps a list of the simulated disk's folders and files, live. */
export function useDisk(): { disk: DevSimApi | null; folders: string[]; files: SimFile[] } {
  const [disk, setDisk] = useState<DevSimApi | null>(null);
  const [, setTick] = useState(0);
  useEffect(() => {
    let off: (() => void) | null = null;
    let alive = true;
    void previewDisk().then((d) => {
      if (!alive) return;
      setDisk(d);
      off = d.subscribe(() => setTick((n) => n + 1));
    });
    return () => { alive = false; off?.(); };
  }, []);
  return { disk, folders: disk?.folders() ?? [], files: disk?.files() ?? [] };
}

const HOME = "/Users/me";
const label = (dir: string) => (dir === HOME ? "Home" : dir.startsWith(HOME + "/") ? dir.slice(HOME.length + 1) : dir);
const depth = (dir: string) => (dir.startsWith(HOME + "/") ? dir.slice(HOME.length + 1).split("/").length : 0);

/** The browser preview's Open / Save / Choose folder dialog over the simulated disk (contract §4.10, §5.1). */
export function PathPicker({ req }: { req: PathPickerRequest }) {
  const { folders: all, files } = useDisk();
  const folders = useMemo(() => all.filter((f) => f === HOME || f.startsWith(HOME + "/")), [all]);
  const [dir, setDir] = useState<string | null>(req.startDir);
  const [name, setName] = useState(req.suggestedName ?? "");
  const [file, setFile] = useState<string | null>(null);
  const [replace, setReplace] = useState<string | null>(null);
  const answer = (p: string | null) => useFileSession.getState().answerPathPicker(p);

  // Start in the requested folder, else the first folder under Dropbox.
  useEffect(() => {
    if (dir && folders.includes(dir)) return;
    if (!folders.length) return;
    setDir(folders.find((f) => f.includes("/Dropbox/")) ?? folders[0]);
  }, [folders, dir]);

  const inDir = files.filter((f) => f.folder === dir && f.name.toLowerCase().endsWith(".lag"));
  const target = (() => {
    if (!dir) return null;
    if (req.mode === "folder") return dir;
    if (req.mode === "open") return file;
    const n = name.trim();
    if (!n) return null;
    return `${dir}/${n.toLowerCase().endsWith(".lag") ? n : `${n}.lag`}`;
  })();

  const ok = () => {
    if (!target) return;
    if (req.mode === "save" && files.some((f) => f.path === target) && replace !== target) { setReplace(target); return; }
    answer(target);
  };

  return (
    <Dialog open onClose={() => answer(null)} maxWidth="md" fullWidth sx={{ zIndex: 1500 }}
      slotProps={{ paper: { "data-testid": "path-picker", "data-mode": req.mode } as object }}>
      <DialogTitle sx={{ pb: 1 }}>
        {req.title}
        <Typography variant="caption" color="text.secondary" component="div">Browser preview: a simulated disk, not your real files.</Typography>
      </DialogTitle>
      <DialogContent dividers sx={{ p: 0 }}>
        <Stack direction="row" sx={{ height: 340 }}>
          <Box sx={{ width: 260, borderRight: 1, borderColor: "divider", overflow: "auto", py: 0.5 }}>
            {folders.map((f) => (
              <Box key={f} data-testid="path-picker-folder" data-path={f} onClick={() => { setDir(f); setFile(null); setReplace(null); }}
                sx={{
                  display: "flex", alignItems: "center", gap: 0.75, py: 0.4, pr: 1, pl: 1 + depth(f) * 1.5, cursor: "pointer",
                  bgcolor: f === dir ? "action.selected" : "transparent", "&:hover": { bgcolor: f === dir ? "action.selected" : "action.hover" },
                }}>
                <FolderOutlinedIcon sx={{ fontSize: 16, color: "text.secondary" }} />
                <Typography variant="body2" noWrap>{label(f).split("/").pop()}</Typography>
              </Box>
            ))}
          </Box>
          <Box sx={{ flexGrow: 1, overflow: "auto", py: 0.5 }}>
            {req.mode === "folder" && (
              <Typography variant="caption" color="text.secondary" sx={{ px: 1.5, display: "block", py: 0.5 }}>Files in this folder:</Typography>
            )}
            {inDir.length === 0 && (
              <Typography variant="body2" color="text.secondary" sx={{ px: 1.5, py: 1 }}>No analyses in this folder.</Typography>
            )}
            {inDir.map((f) => {
              const selectable = req.mode !== "folder";
              const selected = req.mode === "open" ? f.path === file : req.mode === "save" && f.path === target;
              return (
                <Box key={f.path} data-testid="path-picker-file" data-path={f.path}
                  onClick={() => {
                    if (!selectable) return;
                    if (req.mode === "open") setFile(f.path); else setName(f.name.replace(/\.lag$/i, ""));
                    setReplace(null);
                  }}
                  onDoubleClick={() => { if (req.mode === "open") answer(f.path); }}
                  sx={{
                    display: "flex", alignItems: "center", gap: 0.75, px: 1.5, py: 0.4, cursor: selectable ? "pointer" : "default",
                    opacity: req.mode === "open" ? 1 : 0.7,
                    bgcolor: selected ? "action.selected" : "transparent", "&:hover": { bgcolor: selectable ? "action.hover" : "transparent" },
                  }}>
                  {f.dataless ? <CloudOffOutlinedIcon sx={{ fontSize: 16, color: "text.secondary" }} />
                    : <InsertDriveFileOutlinedIcon sx={{ fontSize: 16, color: "text.secondary" }} />}
                  <Typography variant="body2" noWrap>{f.name}</Typography>
                  {f.dataless && <Typography variant="caption" color="text.secondary">online only</Typography>}
                </Box>
              );
            })}
          </Box>
        </Stack>
      </DialogContent>
      <Box sx={{ px: 3, pt: 1.5 }}>
        {req.mode === "save" && (
          <TextField label="Name" size="small" fullWidth autoFocus value={name}
            onChange={(e) => { setName(e.target.value); setReplace(null); }}
            onKeyDown={(e) => { if (e.key === "Enter") ok(); }}
            slotProps={{ htmlInput: { "data-testid": "path-picker-name" } }} />
        )}
        <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.75, wordBreak: "break-all" }}>
          {target ?? (req.mode === "open" ? "Choose a file." : dir ?? "")}
        </Typography>
        {replace && (
          <Alert severity="warning" sx={{ mt: 1 }}>'{baseName(replace)}' already exists. Replace it?</Alert>
        )}
      </Box>
      <DialogActions>
        <Button color="inherit" data-testid="path-picker-cancel" onClick={() => answer(null)}>Cancel</Button>
        <Button variant="contained" data-testid="path-picker-ok" disabled={!target} onClick={ok}>
          {replace ? "Replace" : req.mode === "open" ? "Open" : req.mode === "folder" ? "Choose" : "Save"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
