import { useEffect, useState, type ReactNode } from "react";
import { Box, Button, Divider, FormControlLabel, IconButton, MenuItem, Paper, Stack, Switch, TextField, ToggleButton, ToggleButtonGroup, Tooltip, Typography } from "@mui/material";
import ComputerIcon from "@mui/icons-material/Computer";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import { useFileSession } from "../file/session";
import { useDisk } from "./PathPicker";
import { setUiNow, stemOf } from "./text";
import { useTicker } from "./useTicker";
import type { SimFineEdit, SimNote, SimWho } from "../file/contract";

const OPEN_KEY = "las.files.simPanel";

/** "Its clock" choices of the simulator (phase 3 contract §6.6). */
const SKEWS: { label: string; ms: () => number }[] = [
  { label: "right", ms: () => 0 },
  { label: "+2 h", ms: () => 2 * 3600_000 },
  { label: "−2 h", ms: () => -2 * 3600_000 },
  { label: "year 2001", ms: () => Date.UTC(2001, 5, 1, 12) - Date.now() },
];
const DELAYS = [0, 5000, 60_000];

/** Phase 4 (contract §6.7): small, exact changes the other computer makes, and how it saves them. */
type FineHow = "edit" | "saveOver" | "copy";
const FINE_HOW: { value: FineHow; label: string }[] = [
  { value: "edit", label: "saves a newer version" },
  { value: "saveOver", label: "saves over my last save" },
  { value: "copy", label: "makes a conflicted copy" },
];
const FINE_EDITS: { id: string; label: string; fine: SimFineEdit }[] = [
  { id: "sim-fine-cell", label: "Change the first value", fine: "cell" },
  { id: "sim-fine-cell-other", label: "Change a value in row 3", fine: "cellOther" },
  { id: "sim-fine-add-row", label: "Add a row of values", fine: "addRow" },
  { id: "sim-fine-insert-row", label: "Insert a row at the top", fine: "insertRow" },
  { id: "sim-fine-delete-row", label: "Delete row 1", fine: "deleteRow" },
  { id: "sim-fine-delete-col", label: "Delete the last column", fine: "deleteCol" },
  { id: "sim-fine-rename-col", label: "Rename the first column", fine: "renameCol" },
  { id: "sim-fine-yrange", label: "Set the Y axis range", fine: "yRange" },
  { id: "sim-fine-title", label: "Change the graph title", fine: "graphTitle" },
  { id: "sim-fine-alpha", label: "Change the significance level", fine: "alpha" },
  { id: "sim-fine-scratch", label: "Edit scratchpad cells", fine: "scratchCells" },
  { id: "sim-fine-scratch-shift", label: "Insert a scratchpad row", fine: "scratchShift" },
];

function NoteLine({ n }: { n: SimNote }) {
  return (
    <Box sx={{ py: 0.25, borderTop: 1, borderColor: "divider", "&:first-of-type": { borderTop: 0 } }} data-testid="sim-note-file" data-state={n.state}>
      <Typography variant="caption" component="div" noWrap title={n.name} sx={{ fontSize: 11 }}>{n.name}</Typography>
      <Typography variant="caption" component="div" color="text.secondary" sx={{ fontSize: 10.5 }}>
        {n.state === "editing" ? "editing" : "open, not editing"}{n.beating ? " · kept up to date" : ""} · {n.userName || "no name"} · #{n.seq}
      </Typography>
    </Box>
  );
}

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
  // Phase 3: who acts in "Who is editing", and the simulator switches (per computer where it matters).
  const [who, setWho] = useState<SimWho>("other");
  const [sameUser, setSameUser] = useState(false);
  const [oldApp, setOldApp] = useState<Record<SimWho, boolean>>({ other: false, third: false });
  const [skew, setSkew] = useState<Record<SimWho, number>>({ other: 0, third: 0 });
  const [delay, setDelay] = useState(0);
  const [offline, setOffline] = useState(false);
  const [fineHow, setFineHow] = useState<FineHow>("edit");
  useTicker(1000, open);

  // Texts ("note updated 2 min ago") follow the simulated clock, which "+5 min" and "sleeps" move ahead.
  useEffect(() => {
    let alive = true;
    void import("../file/previewBackend").then((m) => { if (alive) { const pw = m.previewBackend(); setUiNow(() => pw.clock.now()); } });
    return () => { alive = false; setUiNow(null); };
  }, []);

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
  const notes: SimNote[] = (() => { try { return disk && path ? disk.notes(path) : []; } catch { return []; } })();
  const removed = disk?.removed().length ?? 0;

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
        <Box sx={{ px: 1.25, pb: 1.25, maxHeight: "56vh", overflow: "auto" }}>
          <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 1 }}>
            Acts as {disk?.otherDevice ?? "the other computer"}{disk?.thirdDevice ? ` and ${disk.thirdDevice}` : ""}, Finder and Dropbox on the simulated disk.
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
            <Typography className="full" variant="overline" color="text.secondary" sx={{ lineHeight: 1.6 }}>Who is editing</Typography>
            <Stack className="full" direction="row" spacing={1} alignItems="center">
              <ToggleButtonGroup size="small" exclusive value={who} onChange={(_, v: SimWho | null) => { if (v) setWho(v); }}
                sx={{ "& .MuiToggleButton-root": { py: 0.1, px: 0.75, fontSize: 11, textTransform: "none" } }}>
                <ToggleButton value="other" data-testid="sim-who-other">{disk?.otherDevice ?? "Office iMac"} (Alice)</ToggleButton>
                <ToggleButton value="third" data-testid="sim-who-third">{disk?.thirdDevice ?? "Lab MacBook"} (Bob)</ToggleButton>
              </ToggleButtonGroup>
              <FormControlLabel sx={{ ml: 0, mr: 0, "& .MuiFormControlLabel-label": { fontSize: 11 } }} label="as me"
                control={<Switch size="small" checked={sameUser} onChange={(e) => setSameUser(e.target.checked)} slotProps={{ input: { "data-testid": "sim-same-user" } as object }} />} />
            </Stack>
            <SimButton off={busy || !disk} id="sim-peer-open" disabled={!file} onClick={() => void run("Open the file there", () => disk!.peerOpens(path, { who, sameUser }))}>Open the file there</SimButton>
            <SimButton off={busy || !disk} id="sim-peer-edit" disabled={!file} onClick={() => void run("Start editing there", () => disk!.peerStartsEditing(path, { who, sameUser }))}>Start editing there</SimButton>
            <SimButton off={busy || !disk} id="sim-peer-save" disabled={!file} onClick={() => void run("Save there", () => disk!.peerSaves(path, { who }))}>Save there (stop editing)</SimButton>
            <SimButton off={busy || !disk} id="sim-peer-save-keep" disabled={!file} onClick={() => void run("Save there, keep editing", () => disk!.peerSaves(path, { who, keepEditing: true }))}>Save there, keep editing</SimButton>
            <SimButton off={busy || !disk} id="sim-peer-stop" disabled={!file} onClick={() => void run("Stop editing there", () => disk!.peerStops(path, { who }))}>Stop editing there (discard)</SimButton>
            <SimButton off={busy || !disk} id="sim-peer-edit-here" disabled={!file} onClick={() => void run("Press Edit here there", () => disk!.peerEditsHere(path, { who, sameUser }))}>Press “Edit here” there</SimButton>
            <SimButton off={busy || !disk} id="sim-peer-quit" disabled={!file} onClick={() => void run("Quit the app there", () => disk!.peerQuits(path, { who }))}>Quit the app there</SimButton>
            <SimButton off={busy || !disk} id="sim-peer-crash" disabled={!file} onClick={() => void run("Crash there", () => disk!.peerCrashes(path, { who }))}>Crash there (note left behind)</SimButton>
            <SimButton off={busy || !disk} id="sim-peer-sleep" disabled={!file} onClick={() => void run("Sleep there", () => disk!.peerSleeps(path, { who }))}>Sleep there</SimButton>
            <SimButton off={busy || !disk} id="sim-peer-wake" disabled={!file} onClick={() => void run("Wake there", () => disk!.peerWakes(path, { who }))}>Wake there</SimButton>
            <SimButton off={busy || !disk} id="sim-note-conflict" disabled={!file} onClick={() => void run("Conflict copy of its note", () => disk!.noteConflictCopy(path, { who }))}>Conflict copy of its note</SimButton>
            <SimButton off={busy || !disk} id="sim-old-app" onClick={() => void run(`Older app there: ${oldApp[who] ? "off" : "on"}`, () => {
              disk!.setOldApp(!oldApp[who], who);
              setOldApp((o) => ({ ...o, [who]: !o[who] }));
            })}>Older app there: {oldApp[who] ? "on" : "off"}</SimButton>
            <SimButton off={busy || !disk} id="sim-skew" onClick={() => void run(`Its clock: ${SKEWS[(skew[who] + 1) % SKEWS.length].label}`, () => {
              const next = (skew[who] + 1) % SKEWS.length;
              disk!.setClockSkew(SKEWS[next].ms(), who);
              setSkew((o) => ({ ...o, [who]: next }));
            })}>Its clock: {SKEWS[skew[who]].label}</SimButton>
            <SimButton off={busy || !disk} id="sim-delay" onClick={() => void run(`Sync delay: ${DELAYS[(DELAYS.indexOf(delay) + 1) % DELAYS.length] / 1000} s`, () => {
              const next = DELAYS[(DELAYS.indexOf(delay) + 1) % DELAYS.length];
              disk!.setSyncDelay(next);
              setDelay(next);
            })}>Sync delay: {delay / 1000} s</SimButton>
            <SimButton off={busy || !disk} id="sim-this-offline" onClick={() => void run(`This computer offline: ${offline ? "off" : "on"}`, () => {
              disk!.setOffline(!offline);
              setOffline((o) => !o);
            })}>This computer offline: {offline ? "on" : "off"}</SimButton>
            <SimButton off={busy || !disk} id="sim-sleep-3m" onClick={() => void run("This computer slept 3 min", () => disk!.sleep(3 * 60_000))}>This computer sleeps 3 min</SimButton>
            <SimButton off={busy || !disk} id="sim-sleep-2h" onClick={() => void run("This computer slept 2 h", () => disk!.sleep(2 * 3600_000))}>This computer sleeps 2 h</SimButton>
            <Box className="full" data-testid="sim-notes" data-count={notes.length}
              sx={{ border: 1, borderColor: "divider", borderRadius: 1, px: 0.75, py: 0.25, maxHeight: 110, overflow: "auto" }}>
              {notes.length === 0
                ? <Typography variant="caption" color="text.secondary" sx={{ fontSize: 11 }}>No note files beside this file.</Typography>
                : notes.map((n) => <NoteLine key={n.file} n={n} />)}
            </Box>
            <Divider className="full" sx={{ my: 0.25 }} />
            <Typography className="full" variant="overline" color="text.secondary" sx={{ lineHeight: 1.6 }}>Other computer</Typography>
            <SimButton off={busy || !disk} id="sim-edit-table" disabled={!file} onClick={() => void run("Edit table and save", () => disk!.remoteEdit(path, { section: "table" }))}>Edit table and save</SimButton>
            <SimButton off={busy || !disk} id="sim-edit-graph" disabled={!file} onClick={() => void run("Edit graph and save", () => disk!.remoteEdit(path, { section: "figure" }))}>Edit graph and save</SimButton>
            <SimButton off={busy || !disk} id="sim-edit-analysis" disabled={!file} onClick={() => void run("Edit analysis settings and save", () => disk!.remoteEdit(path, { section: "analysis" }))}>Edit analysis settings and save</SimButton>
            <SimButton off={busy || !disk} id="sim-edit-scratch" disabled={!file} onClick={() => void run("Edit scratchpad and save", () => disk!.remoteEdit(path, { section: "scratchpad" }))}>Edit scratchpad and save</SimButton>
            <SimButton off={busy || !disk} id="sim-many" disabled={!file} onClick={() => void run("Save 25 more versions", () => disk!.remoteEditMany(path, 25))}>Save 25 more versions</SimButton>
            <Divider className="full" sx={{ my: 0.25 }} />
            <Typography className="full" variant="overline" color="text.secondary" sx={{ lineHeight: 1.6 }}>Small changes</Typography>
            <TextField className="full" select size="small" fullWidth label="The other computer" value={fineHow}
              onChange={(e) => setFineHow(e.target.value as FineHow)} sx={{ "& .MuiSelect-select": { py: "4px", fontSize: 12 } }}
              slotProps={{ htmlInput: { "data-testid": "sim-fine-how" } }}>
              {FINE_HOW.map((h) => <MenuItem key={h.value} value={h.value} dense>{h.label}</MenuItem>)}
            </TextField>
            {FINE_EDITS.map((e) => (
              <SimButton key={e.id} off={busy || !disk} id={e.id} disabled={!file} onClick={() => void run(`${e.label} (${FINE_HOW.find((h) => h.value === fineHow)?.label})`, () => (
                fineHow === "edit" ? disk!.remoteEdit(path, { fine: e.fine }) : disk!.remoteDiverge(path, { fine: e.fine, how: fineHow })
              ))}>{e.label}</SimButton>
            ))}
            <Divider className="full" sx={{ my: 0.25 }} />
            <Typography className="full" variant="overline" color="text.secondary" sx={{ lineHeight: 1.6 }}>Worked separately</Typography>
            <SimButton off={busy || !disk} id="sim-diverge-copy-table" disabled={!file} onClick={() => void run("Diverged copy (table)", () => disk!.remoteDiverge(path, { section: "table", how: "copy" }))}>Make a diverged copy (table)</SimButton>
            <SimButton off={busy || !disk} id="sim-diverge-copy-graph" disabled={!file} onClick={() => void run("Diverged copy (graph)", () => disk!.remoteDiverge(path, { section: "figure", how: "copy" }))}>Make a diverged copy (graph)</SimButton>
            <SimButton off={busy || !disk} id="sim-saveover-table" disabled={!file} onClick={() => void run("Save over my last save (table)", () => disk!.remoteDiverge(path, { section: "table", how: "saveOver" }))}>Save over my last save (table)</SimButton>
            <SimButton off={busy || !disk} id="sim-saveover-graph" disabled={!file} onClick={() => void run("Save over my last save (graph)", () => disk!.remoteDiverge(path, { section: "figure", how: "saveOver" }))}>Save over my last save (graph)</SimButton>
            <SimButton off={busy || !disk} id="sim-older-copy" disabled={!file} onClick={() => void run("Add an older copy", () => disk!.olderCopy(path))}>Add an older copy</SimButton>
            <Divider className="full" sx={{ my: 0.25 }} />
            <Typography className="full" variant="overline" color="text.secondary" sx={{ lineHeight: 1.6 }}>Phase 1</Typography>
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
          </Box>
          <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5 }} data-testid="sim-removed" data-count={removed}>
            Copies removed on this computer: {removed}
          </Typography>
        </Box>
      )}
      {open && (
        // Always visible (outside the scrolling part): time and the last result.
        <Box sx={{ px: 1.25, pb: 1, pt: 0.75, borderTop: 1, borderColor: "divider" }}>
          <Stack direction="row" spacing={0.5}>
            <SimButton off={busy || !disk} id="sim-advance" onClick={() => void run("+10 s", () => disk!.advance(10_000))}>+10 s</SimButton>
            <SimButton off={busy || !disk} id="sim-advance-60" onClick={() => void run("+1 min", () => disk!.advance(60_000))}>+1 min</SimButton>
            <SimButton off={busy || !disk} id="sim-advance-300" onClick={() => void run("+5 min", () => disk!.advance(300_000))}>+5 min</SimButton>
            <Box sx={{ flexGrow: 1 }} />
            <Tooltip title="Runs the quit routine, as quitting the app would">
              <span><SimButton off={busy || !disk} id="sim-quit" onClick={() => void run("Quit", () => useFileSession.getState().quitRoutine("menu"))}>Quit…</SimButton></span>
            </Tooltip>
            <SimButton off={busy || !disk} id="sim-reset" onClick={() => disk?.reset()}>Reset</SimButton>
          </Stack>
          <Typography variant="caption" color="text.secondary" component="div" noWrap title={note} sx={{ mt: 0.5, minHeight: 18 }} data-testid="sim-note">{note}</Typography>
        </Box>
      )}
    </Paper>
  );
}
