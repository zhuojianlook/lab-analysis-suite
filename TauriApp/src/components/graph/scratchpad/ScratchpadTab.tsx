/* Graphs → Scratchpad tab (lazy chunk, with the IronCalc engine): an Excel-like
   sheet for working values out before they go into the Data table. Saved with
   the analysis (graph store `scratch`); never part of the statistics or figure. */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Alert, Box, Button, CircularProgress, IconButton, MenuItem, Select, Stack, Tooltip, Typography,
} from "@mui/material";
import UndoIcon from "@mui/icons-material/Undo";
import RedoIcon from "@mui/icons-material/Redo";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import EastIcon from "@mui/icons-material/East";
import { clearDraft, isDirty, useGraphStore, writeDraft } from "../../../store/graphStore";
import { MOD_KEY } from "../GraphLibrary";
import type { PasteResult } from "../graphModel";
import { loadEngine } from "./engine";
import { FATAL_MSG, SheetSession, type EditResult } from "./sheetSession";
import { SheetGrid, type SheetGridHandle, type ViewMemo } from "./SheetGrid";
import { SendToDataDialog, type SendInfo } from "./SendToDataDialog";
import { registerScratchController, useScratchUi } from "./scratchBridge";
import { SCRATCH_LIMIT, rangeName, scratchCellCount, type CellRange } from "./scratchModel";

// ── session lifetime (module level: survives switching tabs) ────────────────

interface Current { serial: number; session: SheetSession; lastText: string; flushed: number; key: number; view: ViewMemo }
let current: Current | null = null;
/** The engine trapped once: it can't be used again until the window reloads. */
let engineDead = false;
let keySeq = 0;
let writeTimer: ReturnType<typeof setTimeout> | null = null;

/** The session for this document and saved text; rebuilt when either changed from outside. */
function acquire(serial: number, text: string): Current {
  if (engineDead) throw new Error(FATAL_MSG);
  if (!current || current.serial !== serial || current.lastText !== text) {
    if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
    current?.session.dispose();
    const session = new SheetSession(text);
    current = { serial, session, lastText: text, flushed: session.version, key: ++keySeq, view: { top: 0, left: 0 } };
  }
  return current;
}

/** Serialise pending changes into the graph store (only for the document they belong to). */
function writeStore(): void {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  const cur = current;
  if (!cur || cur.session.broken) return;   // a broken engine can't be read: the store keeps the last good text
  const st = useGraphStore.getState();
  if (!st.doc || st.docSerial !== cur.serial || cur.flushed === cur.session.version) return;
  const text = cur.session.serialize();
  cur.lastText = text;
  cur.flushed = cur.session.version;
  useScratchUi.setState({ over: text.length > SCRATCH_LIMIT, cells: scratchCellCount(text) });
  st.setScratch(text);
}

/** Before reloading the window after an engine crash: the draft backup must be current. */
function flushDraftNow(): void {
  const st = useGraphStore.getState();
  if (isDirty(st)) writeDraft(st); else clearDraft();
}

/** After an edit: write now when it is the first change since saving (so the
 *  unsaved dot appears at once), otherwise debounced. */
function scheduleWrite(): void {
  const st = useGraphStore.getState();
  if (st.scratch === st.savedScratch) { writeStore(); return; }
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(writeStore, 250);
}

const FORMATS: [string, string][] = [
  ["general", "General"], ["0", "0"], ["0.00", "0.00"], ["0.000", "0.000"], ["#,##0.00", "1,234.56"],
  ["0.00E+00", "1.23E+03"], ["0%", "0%"], ["0.00%", "0.00%"], ["m/d/yyyy", "Date (m/d/yyyy)"],
];

type Notice = { severity: "warning" | "info" | "error" | "success"; text: string } | null;

export default function ScratchpadTab({ onSent }: { onSent: (r: PasteResult) => void }) {
  const docSerial = useGraphStore((s) => s.docSerial);
  const scratch = useGraphStore((s) => s.scratch);
  const over = useScratchUi((s) => s.over);
  const [engine, setEngine] = useState<"loading" | "ready" | "error" | "dead">(engineDead ? "dead" : "loading");
  const [loadErr, setLoadErr] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [cur, setCur] = useState<Current | null>(null);
  const [rev, setRev] = useState(0);
  const [notice, setNotice] = useState<Notice>(null);
  const [selInfo, setSelInfo] = useState<{ range: CellRange; act: { r: number; c: number } }>({ range: { r1: 1, c1: 1, r2: 1, c2: 1 }, act: { r: 1, c: 1 } });
  const [send, setSend] = useState<SendInfo | null>(null);
  const gridRef = useRef<SheetGridHandle>(null);

  useEffect(() => {
    if (engineDead) return;
    let live = true;
    setEngine("loading");
    loadEngine().then(
      () => { if (live) setEngine("ready"); },
      (e: unknown) => { if (live) { setLoadErr(e instanceof Error ? e.message : String(e)); setEngine("error"); } },
    );
    return () => { live = false; };
  }, [attempt]);

  useEffect(() => {
    if (engine !== "ready") return;
    try {
      const c = acquire(docSerial, scratch);
      setCur((p) => (p === c && p.key === c.key ? p : c));
      useScratchUi.setState({ ready: true, cells: scratchCellCount(c.lastText), over: c.lastText.length > SCRATCH_LIMIT });
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e));
      setEngine("error");
    }
  }, [engine, docSerial, scratch]);

  const session = cur?.session ?? null;

  const onResult = useCallback((res: EditResult): boolean => {
    if (!res.ok && res.reason === "fatal") {
      engineDead = true;
      setEngine("dead");
      return false;
    }
    if (!res.ok) {
      setNotice({ severity: res.reason === "error" ? "error" : "warning", text: res.message });
      return false;
    }
    if (res.changed) {
      setRev((v) => v + 1);
      scheduleWrite();
      // A later successful edit retires an old warning (a fresh one, e.g. from
      // this paste, is set after this returns).
      setNotice((n) => (n && n.severity !== "info" ? null : n));
    }
    return true;
  }, []);

  const refreshUndo = useCallback(() => {
    const s = current?.session;
    useScratchUi.setState({ canUndo: !!s?.canUndo(), canRedo: !!s?.canRedo() });
  }, []);
  useEffect(refreshUndo, [rev, cur, refreshUndo]);

  const onUndo = useCallback(() => {
    const s = current?.session;
    if (s?.undoStep()) { setRev((v) => v + 1); scheduleWrite(); gridRef.current?.clearMarquee(); }
    else if (s?.broken) { engineDead = true; setEngine("dead"); }
  }, []);
  const onRedo = useCallback(() => {
    const s = current?.session;
    if (s?.redoStep()) { setRev((v) => v + 1); scheduleWrite(); gridRef.current?.clearMarquee(); }
    else if (s?.broken) { engineDead = true; setEngine("dead"); }
  }, []);

  const onSelectionChange = useCallback((range: CellRange, act: { r: number; c: number }) => {
    setSelInfo({ range, act });
    useScratchUi.setState({ sel: rangeName(range), selRows: range.r2 - range.r1 + 1, selCols: range.c2 - range.c1 + 1 });
  }, []);

  const onNotice = useCallback((severity: "warning" | "info" | "error", text: string) => setNotice({ severity, text }), []);

  const openSend = useCallback(() => {
    const s = current?.session;
    const grid = gridRef.current;
    if (!s || !grid) return;
    if (!grid.commitEdit()) return;
    writeStore();
    const used = s.usedRange();
    let g = grid.selection();
    if (g.r1 === g.r2 && g.c1 === g.c2 && used) g = used;
    // Only the part of the selection that holds data (a whole column is 5,000 rows).
    const r: CellRange | null = used
      ? { r1: Math.max(g.r1, used.r1), c1: Math.max(g.c1, used.c1), r2: Math.min(g.r2, used.r2), c2: Math.min(g.c2, used.c2) }
      : null;
    if (!r || r.r1 > r.r2 || r.c1 > r.c2) {
      setNotice({ severity: "info", text: "Select the cells to send first." });
      return;
    }
    setSend({ range: r, ...s.valuesForData(r) });
  }, []);

  const clearAll = useCallback(() => {
    const s = current?.session;
    if (!s) return;
    gridRef.current?.commitEdit();
    onResult(s.clearAll());
    gridRef.current?.focus();
  }, [onResult]);

  // Registered for the rail buttons, Save and the unsaved-changes guard.
  useEffect(() => {
    if (!session) return;
    registerScratchController({
      flush: (commitEdit) => { if (commitEdit) gridRef.current?.commitEdit(); writeStore(); },
      copy: () => gridRef.current?.copyValues(),
      openSend,
      clearAll,
      focus: () => gridRef.current?.focus(),
    });
    return () => registerScratchController(null);
  }, [session, openSend, clearAll]);

  // Leaving the tab (or the document): commit an open edit and write everything now.
  useLayoutEffect(() => () => {
    gridRef.current?.commitEdit();
    writeStore();
    useScratchUi.setState({ ready: false });
  }, []);

  if (engine === "dead") {
    return (
      <Box sx={{ flexGrow: 1, display: "grid", placeItems: "center", p: 2 }}>
        <Alert severity="error" sx={{ maxWidth: 560 }}
          action={<Button color="inherit" size="small" onClick={() => { flushDraftNow(); window.location.reload(); }}>Reload window</Button>}>
          {FATAL_MSG} Save the analysis, then reload the window to use the scratchpad again (unsaved changes in the Graphs
          tool are restored automatically). The entry was probably a formula that is too long or too deeply nested.
        </Alert>
      </Box>
    );
  }
  if (engine === "error") {
    return (
      <Box sx={{ flexGrow: 1, display: "grid", placeItems: "center" }}>
        <Alert severity="error" action={<Button color="inherit" size="small" onClick={() => setAttempt((n) => n + 1)}>Retry</Button>}>
          The scratchpad couldn't be loaded{loadErr ? ` (${loadErr})` : ""}. Its saved contents are kept.
        </Alert>
      </Box>
    );
  }
  if (!session || !cur) {
    return (
      <Box sx={{ flexGrow: 1, display: "grid", placeItems: "center" }}>
        <Stack alignItems="center" spacing={1.5}>
          <CircularProgress size={28} />
          <Typography variant="body2" color="text.secondary">Loading the scratchpad…</Typography>
        </Stack>
      </Box>
    );
  }

  const fmt = session.numFmt(selInfo.act.r, selInfo.act.c);
  const known = FORMATS.some(([f]) => f === fmt);

  return (
    <Stack spacing={1} sx={{ flexGrow: 1, minHeight: 0 }}>
      {notice && <Alert severity={notice.severity} onClose={() => setNotice(null)}>{notice.text}</Alert>}
      {over && (
        <Alert severity="warning">The scratchpad is too large to save. Delete some cells (or shorten long text) and try again.</Alert>
      )}
      <Box sx={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 280, border: 1, borderColor: "divider", borderRadius: 1, overflow: "hidden" }}>
        <Stack direction="row" spacing={0.5} alignItems="center" sx={{ px: 1, height: 38, flexShrink: 0, borderBottom: 1, borderColor: "divider", bgcolor: "#2c2c2e" }}>
          <Tooltip title={`Undo (${MOD_KEY} + Z)`}>
            <span>
              <IconButton size="small" aria-label="Undo" disabled={!session.canUndo()} onClick={() => { onUndo(); gridRef.current?.focus(); }}>
                <UndoIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title={`Redo (${MOD_KEY} + Shift + Z)`}>
            <span>
              <IconButton size="small" aria-label="Redo" disabled={!session.canRedo()} onClick={() => { onRedo(); gridRef.current?.focus(); }}>
                <RedoIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Select size="small" value={fmt} aria-label="Number format of the selected cells"
            onChange={(e) => {
              const g = gridRef.current?.selection() ?? selInfo.range;
              onResult(session.setNumFmt(g, String(e.target.value)));
              setTimeout(() => gridRef.current?.focus(), 0);
            }}
            sx={{ ml: 1, minWidth: 150, height: 28, fontSize: 13 }}>
            {!known && <MenuItem value={fmt} sx={{ fontSize: 13 }}>Custom ({fmt})</MenuItem>}
            {FORMATS.map(([f, label]) => <MenuItem key={f} value={f} sx={{ fontSize: 13 }}>{label}</MenuItem>)}
          </Select>
          <Box sx={{ flexGrow: 1 }} />
          <Tooltip title={`Copies the displayed values (${MOD_KEY} + C) — paste them into the Data table`}>
            <Button size="small" startIcon={<ContentCopyIcon />} onClick={() => gridRef.current?.copyValues()}>Copy values</Button>
          </Tooltip>
          <Button size="small" variant="contained" startIcon={<EastIcon />} onClick={openSend}>Send to Data…</Button>
        </Stack>
        <SheetGrid key={cur.key} ref={gridRef} session={session} rev={rev} onResult={onResult} onUndo={onUndo} onRedo={onRedo}
          onSelectionChange={onSelectionChange} onNotice={onNotice} memo={cur.view} />
      </Box>
      <SendToDataDialog info={send} onClose={() => { setSend(null); gridRef.current?.focus(); }}
        onSent={(r) => { setSend(null); onSent(r); }} />
    </Stack>
  );
}
