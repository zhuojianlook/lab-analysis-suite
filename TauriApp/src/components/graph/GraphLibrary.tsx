import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert, Box, Button, Chip, CircularProgress, Dialog, DialogContent, DialogTitle, IconButton, Paper, Stack, TextField,
  Tooltip, Typography,
} from "@mui/material";
import BarChartIcon from "@mui/icons-material/BarChart";
import StackedBarChartIcon from "@mui/icons-material/StackedBarChart";
import ShowChartIcon from "@mui/icons-material/ShowChart";
import CloseIcon from "@mui/icons-material/Close";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import NoteAddOutlinedIcon from "@mui/icons-material/NoteAddOutlined";
import RefreshIcon from "@mui/icons-material/Refresh";
import SaveOutlinedIcon from "@mui/icons-material/SaveOutlined";
import type { SvgIconComponent } from "@mui/icons-material";
import {
  deleteGraphAnalysis, duplicateGraphAnalysis, getGraphAnalysis, getGraphLibrary, isGraphError, renameGraphAnalysis,
  saveGraphAnalysis, type GraphLibraryList, type GraphSummary, type Template,
} from "../../api/graph";
import { clearDraft, isDirty, readLastId, useGraphStore, writeLastId } from "../../store/graphStore";
import { TEMPLATES, migrateDoc } from "./graphModel";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const MOD_KEY = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform) ? "⌘" : "Ctrl";

const TEMPLATE_ICON: Record<Template, SvgIconComponent> = { column: BarChartIcon, grouped: StackedBarChartIcon, xy: ShowChartIcon };
const TEMPLATE_LABEL: Record<Template, string> = { column: "Column", grouped: "Grouped", xy: "XY" };

/** Library timestamps: epoch seconds/ms or ISO text (no zone = local time). */
export function formatWhen(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "";
  const ms = typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : Date.parse(String(v).replace(" ", "T"));
  if (!Number.isFinite(ms)) return String(v);
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? `Today ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
    : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

// ── library state + actions ─────────────────────────────────────────────────

export interface GraphLib {
  analyses: GraphSummary[] | null;
  path: string;
  error: string | null;
  refresh: () => Promise<void>;
  adopt: (l: GraphLibraryList) => void;
  /** Each returns an error message, or null on success. */
  open: (id: number) => Promise<string | null>;
  duplicate: (id: number) => Promise<string | null>;
  rename: (id: number, name: string) => Promise<string | null>;
  remove: (id: number) => Promise<string | null>;
}

export function useGraphLibrary(): GraphLib {
  const [analyses, setAnalyses] = useState<GraphSummary[] | null>(null);
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);

  const adopt = useCallback((l: GraphLibraryList) => {
    if (Array.isArray(l.analyses)) setAnalyses(l.analyses);
    if (typeof l.path === "string") setPath(l.path);
    setError(null);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await getGraphLibrary();
      if (isGraphError(res)) { setError(res.error); return; }
      adopt(res);
    } catch (e) {
      setError(`Couldn't open the graph library: ${errMsg(e)}`);
    }
  }, [adopt]);

  useEffect(() => { void refresh(); }, [refresh]);

  const open = useCallback(async (id: number) => {
    try {
      const res = await getGraphAnalysis(id);
      if (isGraphError(res) || !res.analysis) {
        if (res.code === "not_found") void refresh();
        return res.code === "not_found" ? "That analysis is no longer in the library." : res.error || "Couldn't open the analysis.";
      }
      const saved = res.analysis;
      const doc = migrateDoc(saved.table);
      if (!doc) return "This analysis was saved by a newer version of the app and can't be opened here.";
      useGraphStore.getState().load({ doc, analysis: saved.analysis, figure: saved.figure, name: saved.name, id: saved.id, saved: true });
      writeLastId(saved.id);
      clearDraft();
      return null;
    } catch (e) {
      return errMsg(e);
    }
  }, [refresh]);

  const duplicate = useCallback(async (id: number) => {
    try {
      const res = await duplicateGraphAnalysis(id);
      if (isGraphError(res)) return res.error;
      adopt(res);
      return null;
    } catch (e) {
      return errMsg(e);
    }
  }, [adopt]);

  const rename = useCallback(async (id: number, name: string) => {
    try {
      const res = await renameGraphAnalysis(id, name);
      if (isGraphError(res)) {
        if (res.code === "name_exists") return `An analysis named “${res.conflict?.name ?? name}” already exists.`;
        if (res.code === "not_found") { void refresh(); return "That analysis is no longer in the library."; }
        return res.error;
      }
      adopt(res);
      if (useGraphStore.getState().currentId === id) useGraphStore.getState().markRenamed(res.analysis.name);
      return null;
    } catch (e) {
      return errMsg(e);
    }
  }, [adopt, refresh]);

  const remove = useCallback(async (id: number) => {
    try {
      const res = await deleteGraphAnalysis(id);
      if (isGraphError(res)) return res.error;
      adopt(res);
      // Deleting the open analysis keeps it on screen as an unsaved document.
      if (useGraphStore.getState().currentId === id) useGraphStore.getState().detach();
      if (readLastId() === id) writeLastId(null);
      return null;
    } catch (e) {
      return errMsg(e);
    }
  }, [adopt]);

  return { analyses, path, error, refresh, adopt, open, duplicate, rename, remove };
}

// ── saved-analysis list ─────────────────────────────────────────────────────

function LibraryRow({ item, lib, highlight, isOpen, onOpen }: {
  item: GraphSummary; lib: GraphLib; highlight: boolean; isOpen: boolean; onOpen: (id: number) => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async (fn: () => Promise<string | null>, after?: () => void) => {
    setBusy(true);
    setErr(null);
    const e = await fn();
    setBusy(false);
    if (e) setErr(e); else after?.();
  };

  const submitRename = () => {
    const name = (renaming ?? "").trim();
    if (!name) { setErr("Give it a name."); return; }
    if (name === item.name) { setRenaming(null); return; }
    void run(() => lib.rename(item.id, name), () => setRenaming(null));
  };

  const Icon = TEMPLATE_ICON[item.template] ?? BarChartIcon;
  return (
    <Box sx={{
      px: 1.25, py: 0.75, borderRadius: 1, border: 1,
      borderColor: highlight ? "primary.main" : "transparent",
      bgcolor: highlight ? "rgba(90,127,168,0.08)" : "transparent",
      "&:hover": { bgcolor: "action.hover" },
    }}>
      <Stack direction="row" spacing={1.25} alignItems="center">
        <Icon sx={{ fontSize: 20, color: "text.secondary", flexShrink: 0 }} />
        <Box sx={{ minWidth: 0, flexGrow: 1 }}>
          {renaming !== null ? (
            <TextField size="small" autoFocus fullWidth value={renaming} onChange={(e) => setRenaming(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submitRename(); if (e.key === "Escape") { setRenaming(null); setErr(null); } }}
              slotProps={{ htmlInput: { "aria-label": "New name" } }} />
          ) : (
            <Box sx={{ cursor: "pointer" }} onClick={() => onOpen(item.id)}>
              <Stack direction="row" spacing={0.75} alignItems="center">
                <Typography variant="body2" noWrap sx={{ fontWeight: 500 }}>{item.name}</Typography>
                <Chip size="small" variant="outlined" label={TEMPLATE_LABEL[item.template] ?? item.template} sx={{ height: 18, fontSize: 10.5 }} />
                {isOpen && <Chip size="small" color="primary" variant="outlined" label="open" sx={{ height: 18, fontSize: 10.5 }} />}
              </Stack>
              <Typography variant="caption" color="text.secondary" noWrap component="div">
                {item.n_cols} {item.template === "xy" ? "data set" : "group"}{item.n_cols === 1 ? "" : "s"} · {item.n_rows} row{item.n_rows === 1 ? "" : "s"}
                {item.updated_at ? ` · edited ${formatWhen(item.updated_at)}` : ""}
              </Typography>
            </Box>
          )}
        </Box>
        {busy && <CircularProgress size={14} />}
        {renaming !== null ? (
          <>
            <Button size="small" onClick={submitRename} disabled={busy}>Rename</Button>
            <Button size="small" color="inherit" onClick={() => { setRenaming(null); setErr(null); }}>Cancel</Button>
          </>
        ) : confirmDelete ? (
          <>
            <Typography variant="caption" color="text.secondary">Delete permanently?</Typography>
            <Button size="small" color="error" disabled={busy} onClick={() => void run(() => lib.remove(item.id), () => setConfirmDelete(false))}>Delete</Button>
            <Button size="small" color="inherit" onClick={() => setConfirmDelete(false)}>Keep</Button>
          </>
        ) : (
          <>
            <Button size="small" variant={highlight ? "contained" : "text"} onClick={() => onOpen(item.id)}>
              {highlight ? "Continue" : "Open"}
            </Button>
            <Tooltip title="Duplicate">
              <IconButton size="small" aria-label={`Duplicate ${item.name}`} onClick={() => void run(() => lib.duplicate(item.id))}>
                <ContentCopyIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
            <Tooltip title="Rename">
              <IconButton size="small" aria-label={`Rename ${item.name}`} onClick={() => { setRenaming(item.name); setErr(null); }}>
                <EditOutlinedIcon sx={{ fontSize: 17 }} />
              </IconButton>
            </Tooltip>
            <Tooltip title="Delete">
              <IconButton size="small" aria-label={`Delete ${item.name}`} onClick={() => setConfirmDelete(true)}>
                <DeleteOutlineIcon sx={{ fontSize: 17 }} />
              </IconButton>
            </Tooltip>
          </>
        )}
      </Stack>
      {err && <Alert severity="error" onClose={() => setErr(null)} sx={{ mt: 0.75, py: 0 }}>{err}</Alert>}
    </Box>
  );
}

export function LibraryList({ lib, highlightId, onOpen }: { lib: GraphLib; highlightId: number | null; onOpen: (id: number) => void }) {
  const [filter, setFilter] = useState("");
  const currentId = useGraphStore((s) => (s.doc ? s.currentId : null));
  const items = lib.analyses ?? [];
  const q = items.length > 8 ? filter.trim().toLowerCase() : "";
  const shown = q ? items.filter((a) => a.name.toLowerCase().includes(q)) : items;

  if (lib.analyses === null) {
    return lib.error ? (
      <Alert severity="error" action={<Button color="inherit" size="small" startIcon={<RefreshIcon />} onClick={() => void lib.refresh()}>Retry</Button>}>
        {lib.error}
      </Alert>
    ) : (
      <Stack direction="row" spacing={1} alignItems="center" sx={{ py: 1 }}>
        <CircularProgress size={14} />
        <Typography variant="body2" color="text.secondary">Opening the library…</Typography>
      </Stack>
    );
  }
  return (
    <Box>
      {items.length > 8 && (
        <TextField size="small" fullWidth placeholder="Filter analyses" value={filter} onChange={(e) => setFilter(e.target.value)} sx={{ mb: 1 }} />
      )}
      {!items.length && (
        <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>
          Nothing saved yet. Saved analyses are kept here, with their data, tests and graph settings, between launches.
        </Typography>
      )}
      {q && !shown.length && <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>No analyses match “{filter.trim()}”.</Typography>}
      <Stack spacing={0.25}>
        {shown.map((a) => (
          <LibraryRow key={a.id} item={a} lib={lib} highlight={a.id === highlightId} isOpen={a.id === currentId} onOpen={onOpen} />
        ))}
      </Stack>
      {lib.error && <Alert severity="error" sx={{ mt: 1 }}>{lib.error}</Alert>}
      {lib.path && (
        <Typography variant="caption" color="text.disabled" component="div" sx={{ mt: 1.5, wordBreak: "break-all" }}>
          Library file: {lib.path}
        </Typography>
      )}
    </Box>
  );
}

// ── start screen ────────────────────────────────────────────────────────────

/** Shown when no document is open: pick a template, or reopen a saved analysis. */
export function StartScreen({ lib, notice }: { lib: GraphLib; notice?: string | null }) {
  const newDoc = useGraphStore((s) => s.newDoc);
  const [lastId] = useState(readLastId);
  const [err, setErr] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  const open = async (id: number) => {
    setOpening(true);
    setErr(await lib.open(id));
    setOpening(false);
  };

  return (
    <Box sx={{ height: "100%", overflow: "auto" }}>
      <Box sx={{ maxWidth: 980, mx: "auto", px: 3, py: 4 }}>
        <Typography variant="h5" sx={{ fontWeight: 600 }}>Graphs</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 3, maxWidth: 680 }}>
          Type or paste data into a table, pick a test and get a publication-ready graph. Analyses are saved in the
          app's library and can be reopened, re-saved or deleted later.
        </Typography>
        {notice && <Alert severity="info" sx={{ mb: 2 }}>{notice}</Alert>}

        <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "repeat(3, 1fr)" }, gap: 2 }}>
          {TEMPLATES.map((t) => {
            const Icon = TEMPLATE_ICON[t.id];
            return (
              <Paper key={t.id} variant="outlined" sx={{ p: 2, display: "flex", flexDirection: "column" }}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Icon sx={{ color: "primary.main" }} />
                  <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>{t.label}</Typography>
                </Stack>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1, flexGrow: 1 }}>{t.blurb}</Typography>
                <Typography variant="caption" color="text.disabled" sx={{ mt: 1 }}>
                  {t.graphs.map((g) => g.label).join(" · ")}
                </Typography>
                <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
                  <Button variant="contained" size="small" onClick={() => newDoc(t.id, false)}>Start empty</Button>
                  <Button size="small" onClick={() => newDoc(t.id, true)}>Start with sample data</Button>
                </Stack>
              </Paper>
            );
          })}
        </Box>

        <Stack direction="row" alignItems="center" sx={{ mt: 4, mb: 1 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 600, flexGrow: 1 }}>Saved analyses</Typography>
          {opening && <CircularProgress size={16} />}
        </Stack>
        {err && <Alert severity="error" onClose={() => setErr(null)} sx={{ mb: 1 }}>{err}</Alert>}
        <LibraryList lib={lib} highlightId={lastId} onOpen={(id) => void open(id)} />
      </Box>
    </Box>
  );
}

// ── file bar (open document) ────────────────────────────────────────────────

type Prompt = { mode: "save" | "saveas"; value: string } | null;
type Conflict = { mode: "save" | "saveas"; name: string } | null;
type Pending = { label: string; run: () => void | Promise<void> } | null;

/** Name, unsaved-changes dot and Save / Save as / New / Open for the open
 *  document, plus the inline prompts those need (name, replace, unsaved). */
export function FileBar({ lib }: { lib: GraphLib }) {
  const name = useGraphStore((s) => s.name);
  const setName = useGraphStore((s) => s.setName);
  const currentId = useGraphStore((s) => s.currentId);
  const dirty = useGraphStore(isDirty);
  const [prompt, setPrompt] = useState<Prompt>(null);
  const [conflict, setConflict] = useState<Conflict>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [openDialog, setOpenDialog] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const pendingRef = useRef<Pending>(null);
  pendingRef.current = pending;

  const doSave = async (mode: "save" | "saveas", saveName: string, overwrite = false): Promise<boolean> => {
    const s = useGraphStore.getState();
    if (!s.doc) return false;
    const sent = { doc: s.doc, analysis: s.analysis, figure: s.figure };
    const body = {
      id: mode === "save" ? s.currentId : null, name: saveName, template: s.doc.template,
      table: sent.doc, analysis: sent.analysis, figure: sent.figure, doc_version: 1 as const, overwrite,
    };
    setSaving(true);
    setErr(null);
    try {
      let res = await saveGraphAnalysis(body);
      // The record this document came from was deleted elsewhere: save it as new.
      if (isGraphError(res) && res.code === "not_found" && body.id !== null) res = await saveGraphAnalysis({ ...body, id: null });
      if (isGraphError(res)) {
        if (res.code === "name_exists") { setConflict({ mode, name: res.conflict?.name ?? saveName }); setPrompt(null); }
        else setErr(res.error);
        return false;
      }
      useGraphStore.getState().markSaved(res.analysis.id, res.analysis.name, sent);
      lib.adopt(res);
      writeLastId(res.analysis.id);
      clearDraft();
      setPrompt(null);
      setConflict(null);
      setSavedNote(res.replaced ? `Saved — replaced the earlier “${res.analysis.name}”.` : null);
      const p = pendingRef.current;
      if (p) { setPending(null); await p.run(); }
      return true;
    } catch (e) {
      setErr(errMsg(e));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const save = () => {
    const s = useGraphStore.getState();
    if (!s.doc || saving) return;
    const n = s.name.trim();
    if (!n) { setPrompt({ mode: "save", value: "" }); setConflict(null); return; }
    void doSave("save", n);
  };

  const saveAs = () => {
    const n = useGraphStore.getState().name.trim();
    setConflict(null);
    setPrompt({ mode: "saveas", value: n ? `${n} copy` : "" });
  };

  const submitPrompt = () => {
    if (!prompt) return;
    const n = prompt.value.trim();
    if (!n) { setErr("Give the analysis a name."); return; }
    void doSave(prompt.mode, n);
  };

  /** Run `action` now, or after the user deals with unsaved changes. */
  const guard = (label: string, run: () => void | Promise<void>) => {
    if (isDirty(useGraphStore.getState())) setPending({ label, run });
    else void run();
  };

  const discard = () => {
    const p = pending;
    setPending(null);
    setPrompt(null);
    setConflict(null);
    clearDraft();
    if (p) void p.run();
  };

  const newDocument = () => guard("starting a new analysis", () => { useGraphStore.getState().close(); clearDraft(); });

  const openFromDialog = (id: number) => {
    setOpenDialog(false);
    const before = useGraphStore.getState();
    const isCurrent = id === before.currentId;
    if (isCurrent && !isDirty(before)) return;
    guard("opening another analysis", async () => {
      // Re-opening the open document: after "Discard" it is unchanged (same id,
      // same saved version, still dirty), so it is reverted from the library.
      // After "Save" it was re-saved (a new id and saved version) — there is
      // nothing to re-open, and `id` no longer exists in the library.
      if (isCurrent) {
        const now = useGraphStore.getState();
        if (now.currentId !== id || now.savedSnapshot !== before.savedSnapshot || !isDirty(now)) return;
      }
      const e = await lib.open(id);
      if (e) setErr(e);
    });
  };

  // ⌘/Ctrl+S saves — only while this tool is the one on screen.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== "s") return;
      if (!rootRef.current || rootRef.current.offsetParent === null) return;
      e.preventDefault();
      saveRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!savedNote) return;
    const t = setTimeout(() => setSavedNote(null), 4000);
    return () => clearTimeout(t);
  }, [savedNote]);

  const displayName = name.trim() || "Untitled analysis";
  return (
    <Box ref={rootRef} sx={{ borderBottom: 1, borderColor: "divider", flexShrink: 0 }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ px: 2, py: 0.75 }}>
        <TextField variant="standard" value={name} placeholder="Untitled analysis" onChange={(e) => setName(e.target.value)}
          slotProps={{ htmlInput: { "aria-label": "Analysis name", style: { fontWeight: 600 } }, input: { disableUnderline: false } }}
          sx={{ minWidth: 160, maxWidth: 360, flexGrow: 1 }} />
        <Tooltip title={dirty ? "Unsaved changes" : currentId !== null ? "Saved in the library" : "Not saved yet"}>
          <Box aria-label={dirty ? "Unsaved changes" : "Saved"} sx={{
            width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
            bgcolor: dirty ? "warning.main" : currentId !== null ? "success.main" : "text.disabled",
          }} />
        </Tooltip>
        {savedNote && <Typography variant="caption" color="text.secondary" noWrap>{savedNote}</Typography>}
        <Box sx={{ flexGrow: 1 }} />
        <Tooltip title={`${MOD_KEY} + S`}>
          <span>
            <Button size="small" variant={dirty ? "contained" : "outlined"} onClick={save} disabled={saving}
              startIcon={saving ? <CircularProgress size={14} color="inherit" /> : <SaveOutlinedIcon />}>
              Save
            </Button>
          </span>
        </Tooltip>
        <Button size="small" onClick={saveAs} disabled={saving}>Save as</Button>
        <Button size="small" startIcon={<NoteAddOutlinedIcon />} onClick={newDocument}>New</Button>
        <Button size="small" startIcon={<FolderOpenIcon />} onClick={() => { setOpenDialog(true); void lib.refresh(); }}>Open</Button>
      </Stack>

      {prompt && (
        <Stack direction="row" spacing={1} alignItems="center" sx={{ px: 2, pb: 1 }}>
          <Typography variant="body2" color="text.secondary" noWrap>{prompt.mode === "saveas" ? "Save a copy as" : "Save as"}</Typography>
          <TextField size="small" autoFocus value={prompt.value} placeholder="Analysis name" sx={{ width: 280 }}
            onChange={(e) => setPrompt({ ...prompt, value: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Enter") submitPrompt(); if (e.key === "Escape") setPrompt(null); }}
            slotProps={{ htmlInput: { "aria-label": "Analysis name" } }} />
          <Button size="small" variant="contained" onClick={submitPrompt} disabled={saving}>Save</Button>
          <Button size="small" color="inherit" onClick={() => setPrompt(null)}>Cancel</Button>
        </Stack>
      )}

      {conflict && (
        <Alert severity="warning" sx={{ mx: 2, mb: 1 }}
          action={
            <Stack direction="row" spacing={0.5}>
              <Button color="inherit" size="small" disabled={saving} onClick={() => void doSave(conflict.mode, conflict.name, true)}>Replace</Button>
              <Button color="inherit" size="small" onClick={() => { setConflict(null); setPrompt({ mode: conflict.mode, value: conflict.name }); }}>Cancel</Button>
            </Stack>
          }>
          An analysis named “{conflict.name}” already exists. Replace it?
        </Alert>
      )}

      {pending && (
        <Alert severity="info" sx={{ mx: 2, mb: 1 }}
          action={
            <Stack direction="row" spacing={0.5}>
              <Button color="inherit" size="small" disabled={saving} onClick={save}>Save</Button>
              <Button color="inherit" size="small" onClick={discard}>Discard</Button>
              <Button color="inherit" size="small" onClick={() => { setPending(null); setPrompt(null); }}>Cancel</Button>
            </Stack>
          }>
          Save changes to “{displayName}” before {pending.label}?
        </Alert>
      )}

      {err && <Alert severity="error" onClose={() => setErr(null)} sx={{ mx: 2, mb: 1 }}>{err}</Alert>}

      <Dialog open={openDialog} onClose={() => setOpenDialog(false)} fullWidth maxWidth="sm">
        <DialogTitle sx={{ display: "flex", alignItems: "center", pr: 1 }}>
          Open an analysis
          <Box sx={{ flexGrow: 1 }} />
          <IconButton aria-label="Close" onClick={() => setOpenDialog(false)}><CloseIcon /></IconButton>
        </DialogTitle>
        <DialogContent dividers>
          <LibraryList lib={lib} highlightId={null} onOpen={openFromDialog} />
        </DialogContent>
      </Dialog>
    </Box>
  );
}
