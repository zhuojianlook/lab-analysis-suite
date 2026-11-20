/* The Scratchpad's spreadsheet grid: a virtualised DOM grid (only the visible
   cells are rendered) over a SheetSession, with Excel-style selection,
   keyboard, in-cell editor, formula bar, clipboard, fill handle, column
   resize and context menus. One hidden <textarea> over the active cell is the
   grid's only focus target: it receives typing (IME included) and the
   copy / cut / paste events, which WebKit only fires on editable elements. */

import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState,
  type ClipboardEvent as ReactClipboardEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from "react";
import {
  Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Divider, ListItemText, Menu, MenuItem, TextField, Typography,
  useTheme,
} from "@mui/material";
import { MOD_KEY } from "../GraphLibrary";
import {
  DEFAULT_COL_WIDTH, MAX_COL_WIDTH, MIN_COL_WIDTH, SCRATCH_COLS, SCRATCH_ROWS, cellName, colName, norm, parseRangeName,
  rangeName, type CellRange,
} from "./scratchModel";
import { CELL_BOOLEAN, CELL_ERROR, CELL_NUMBER, type EditResult, type SheetSession } from "./sheetSession";

const ROW_H = 24;
const HEAD_H = 24;
const GUTTER = 46;
const OVERSCAN = 3;
const FONT_PX = 12;

const C_CELL = "#1f1f21";
const C_HEAD = "#2c2c2e";
const C_LINE = "#3a3a3c";
const C_ERR = "#ff8a80";
const HIDDEN = {
  border: 0, clip: "rect(0 0 0 0)", height: "1px", margin: "-1px", overflow: "hidden", padding: 0,
  position: "absolute", whiteSpace: "nowrap", width: "1px",
} as const;

interface Pos { r: number; c: number }
/** a = anchor corner, f = focus (moving) corner, act = active cell (inside the range). */
export interface Sel { a: Pos; f: Pos; act: Pos }
/** Selection and scroll position, kept by the owner across remounts (switching tabs). */
export interface ViewMemo { sel?: Sel; top: number; left: number }
interface EditState { r: number; c: number; text: string; mode: "enter" | "edit"; origin: "cell" | "bar" }
type MenuKind = "cell" | "row" | "col";

const one = (p: Pos): Sel => ({ a: p, f: p, act: p });
const rangeOf = (s: Sel): CellRange => norm({ r1: s.a.r, c1: s.a.c, r2: s.f.r, c2: s.f.c });
const clampR = (r: number) => Math.min(SCRATCH_ROWS, Math.max(1, r));
const clampC = (c: number) => Math.min(SCRATCH_COLS, Math.max(1, c));
const inRange = (g: CellRange, r: number, c: number) => r >= g.r1 && r <= g.r2 && c >= g.c1 && c <= g.c2;
/** After these characters a click on a cell inserts a reference (point mode). */
const POINT_AFTER = /[=(,+\-*/^&<>:;\s]$/;

export interface SheetGridHandle {
  /** Commit an open edit (no move). False when the commit failed and the editor stays open. */
  commitEdit: () => boolean;
  /** Copy the selection's displayed values to the system clipboard. */
  copyValues: () => void;
  focus: () => void;
  selection: () => CellRange;
  /** Forget the cut/copy marquee (after an edit made elsewhere). */
  clearMarquee: () => void;
}

export interface SheetGridProps {
  session: SheetSession;
  /** Bumped by the owner after every change, so the grid re-reads the sheet. */
  rev: number;
  /** Apply the result of an edit (refresh, save, alerts); returns whether it succeeded. */
  onResult: (res: EditResult) => boolean;
  onUndo: () => void;
  onRedo: () => void;
  onSelectionChange: (range: CellRange, act: Pos) => void;
  /** Shown when part of a paste was clipped etc. */
  onNotice: (severity: "warning" | "info" | "error", text: string) => void;
  /** Where the selection and scroll position are remembered between mounts. */
  memo?: ViewMemo;
}

/** Text width in px (cached canvas measureText). */
function useMeasure(fontFamily: string) {
  return useMemo(() => {
    const ctx = typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;
    if (ctx) ctx.font = `${FONT_PX}px ${fontFamily}`;
    const cache = new Map<string, number>();
    return (t: string) => {
      let w = cache.get(t);
      if (w === undefined) {
        w = ctx ? ctx.measureText(t).width : t.length * 7;
        if (cache.size > 5000) cache.clear();
        cache.set(t, w);
      }
      return w;
    };
  }, [fontFamily]);
}

export const SheetGrid = forwardRef<SheetGridHandle, SheetGridProps>(function SheetGrid(
  { session, rev, onResult, onUndo, onRedo, onSelectionChange, onNotice, memo }, ref,
) {
  const theme = useTheme();
  const measure = useMeasure(String(theme.typography.fontFamily ?? "sans-serif"));
  const primary = theme.palette.primary.main;

  const [sel, setSelState] = useState<Sel>(() => memo?.sel ?? one({ r: 1, c: 1 }));
  const [edit, setEditState] = useState<EditState | null>(null);
  const [view, setView] = useState({ top: 0, left: 0, w: 800, h: 500 });
  const [marquee, setMarquee] = useState<CellRange | null>(null);
  const [fillPreview, setFillPreview] = useState<CellRange | null>(null);
  const [resizing, setResizing] = useState<{ cols: number[]; w: number } | null>(null);
  const [menu, setMenu] = useState<{ kind: MenuKind; x: number; y: number } | null>(null);
  const [widthDlg, setWidthDlg] = useState<{ value: string } | null>(null);
  const [nameText, setNameText] = useState<string | null>(null);

  const selRef = useRef(sel);
  selRef.current = sel;
  const editRef = useRef(edit);
  editRef.current = edit;
  const proxyRef = useRef<HTMLTextAreaElement>(null);
  const barRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const tabStartCol = useRef<number | null>(null);
  const selectAllStage = useRef(0);
  const pendingCopy = useRef<{ cut: boolean } | null>(null);
  /** Reference inserted in point mode: [start, end) in the editor text. */
  const pointRef = useRef<{ start: number; end: number; anchor: Pos } | null>(null);
  const pendingCaret = useRef<{ el: "cell" | "bar"; pos: number } | null>(null);

  const setSel = useCallback((s: Sel) => { selRef.current = s; if (memo) memo.sel = s; setSelState(s); }, [memo]);
  const setEdit = useCallback((e: EditState | null) => { editRef.current = e; setEditState(e); }, []);

  const range = rangeOf(sel);
  const act = sel.act;

  // ── column geometry ───────────────────────────────────────────────────────
  const widths = useMemo(() => {
    const w = new Float64Array(SCRATCH_COLS + 1);
    for (let c = 1; c <= SCRATCH_COLS; c++) w[c] = session.colWidth(c);
    return w;
  }, [session, rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const colX = useMemo(() => {
    const x = new Float64Array(SCRATCH_COLS + 1);
    for (let c = 1; c <= SCRATCH_COLS; c++) {
      const w = resizing && resizing.cols.includes(c) ? resizing.w : widths[c];
      x[c] = x[c - 1] + w;
    }
    return x;
  }, [widths, resizing]);
  const colW = (c: number) => colX[c] - colX[c - 1];
  const totalW = colX[SCRATCH_COLS];
  const totalH = SCRATCH_ROWS * ROW_H;
  const colAt = useCallback((x: number) => {
    let lo = 1, hi = SCRATCH_COLS;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (colX[mid] <= x) lo = mid + 1; else hi = mid;
    }
    return lo;
  }, [colX]);

  // ── viewport ──────────────────────────────────────────────────────────────
  const readView = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    setView((v) => (v.top === el.scrollTop && v.left === el.scrollLeft && v.w === el.clientWidth && v.h === el.clientHeight
      ? v : { top: el.scrollTop, left: el.scrollLeft, w: el.clientWidth, h: el.clientHeight }));
  }, []);
  // Read synchronously (React batches the update per event); no rAF, which a hidden window pauses.
  const onScroll = () => {
    const el = bodyRef.current;
    if (el && memo) { memo.top = el.scrollTop; memo.left = el.scrollLeft; }
    readView();
  };
  useLayoutEffect(() => {
    // Back where the sheet was scrolled to before switching tabs.
    const el = bodyRef.current;
    if (el && memo && (memo.top || memo.left)) { el.scrollTop = memo.top; el.scrollLeft = memo.left; }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    readView();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => readView());
    ro.observe(el);
    return () => ro.disconnect();
  }, [readView]);

  const r0 = Math.max(1, Math.floor(view.top / ROW_H) + 1 - OVERSCAN);
  const r1 = Math.min(SCRATCH_ROWS, Math.ceil((view.top + view.h) / ROW_H) + OVERSCAN);
  const c0 = Math.max(1, colAt(view.left) - 1);
  const c1 = Math.min(SCRATCH_COLS, colAt(view.left + view.w) + 1);

  const scrollIntoView = useCallback((p: Pos) => {
    const el = bodyRef.current;
    if (!el) return;
    const top = (p.r - 1) * ROW_H, bottom = top + ROW_H;
    const left = colX[p.c - 1], right = colX[p.c];
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
    if (left < el.scrollLeft) el.scrollLeft = left;
    else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = Math.min(left, right - el.clientWidth);
  }, [colX]);

  const focusProxy = useCallback(() => {
    const el = proxyRef.current;
    if (el && document.activeElement !== el) el.focus({ preventScroll: true });
  }, []);

  useEffect(() => { onSelectionChange(range, act); }, [range.r1, range.c1, range.r2, range.c2, act.r, act.c]); // eslint-disable-line react-hooks/exhaustive-deps

  // Focus the grid when it first appears.
  useEffect(() => { focusProxy(); }, [focusProxy]);

  // Restore the caret after a point-mode insertion / F4.
  useLayoutEffect(() => {
    const p = pendingCaret.current;
    if (!p) return;
    pendingCaret.current = null;
    const el = p.el === "bar" ? barRef.current : proxyRef.current;
    if (el) { el.focus({ preventScroll: true }); el.setSelectionRange(p.pos, p.pos); }
  });

  // ── edits ─────────────────────────────────────────────────────────────────
  const apply = useCallback((res: EditResult, after?: (res: EditResult & { ok: true }) => void) => {
    const ok = onResult(res);
    if (ok && res.ok) {
      if (res.changed) { setMarquee(null); session.clip = null; }
      after?.(res);
    }
    return ok;
  }, [onResult, session]);

  const moveTo = useCallback((p: Pos, extend = false) => {
    const q = { r: clampR(p.r), c: clampC(p.c) };
    const s = selRef.current;
    setSel(extend ? { a: s.a, f: q, act: s.a } : one(q));
    scrollIntoView(q);
  }, [setSel, scrollIntoView]);

  /** Write the open editor's text into its cell. */
  const commit = useCallback((): boolean => {
    const ed = editRef.current;
    if (!ed) return true;
    const res = session.setInput(ed.r, ed.c, ed.text);
    if (!apply(res)) return false;
    pointRef.current = null;
    setEdit(null);
    return true;
  }, [session, apply, setEdit]);

  const cancelEdit = useCallback(() => {
    pointRef.current = null;
    setEdit(null);
    focusProxy();
  }, [setEdit, focusProxy]);

  /** Move the active cell for Enter / Tab: inside a multi-cell selection it cycles, as in Excel. */
  const stepActive = useCallback((dr: number, dc: number) => {
    const s = selRef.current;
    const g = rangeOf(s);
    if (g.r1 !== g.r2 || g.c1 !== g.c2) {
      let { r, c } = s.act;
      if (dc) {
        c += dc;
        if (c > g.c2) { c = g.c1; r = r + 1 > g.r2 ? g.r1 : r + 1; }
        if (c < g.c1) { c = g.c2; r = r - 1 < g.r1 ? g.r2 : r - 1; }
      } else {
        r += dr;
        if (r > g.r2) { r = g.r1; c = c + 1 > g.c2 ? g.c1 : c + 1; }
        if (r < g.r1) { r = g.r2; c = c - 1 < g.c1 ? g.c2 : c - 1; }
      }
      setSel({ ...s, act: { r, c } });
      scrollIntoView({ r, c });
      return;
    }
    moveTo({ r: s.act.r + dr, c: s.act.c + dc });
  }, [setSel, scrollIntoView, moveTo]);

  const enterKey = useCallback((back: boolean) => {
    const s = selRef.current;
    const g = rangeOf(s);
    const multi = g.r1 !== g.r2 || g.c1 !== g.c2;
    if (!multi && tabStartCol.current !== null && !back) {
      const c = tabStartCol.current;
      tabStartCol.current = null;
      moveTo({ r: s.act.r + 1, c });
      return;
    }
    tabStartCol.current = null;
    stepActive(back ? -1 : 1, 0);
  }, [moveTo, stepActive]);

  const tabKey = useCallback((back: boolean) => {
    if (tabStartCol.current === null) tabStartCol.current = selRef.current.act.c;
    stepActive(0, back ? -1 : 1);
  }, [stepActive]);

  const startEdit = useCallback((mode: "enter" | "edit", text?: string, origin: "cell" | "bar" = "cell") => {
    const p = selRef.current.act;
    const t = text ?? session.input(p.r, p.c);
    setEdit({ r: p.r, c: p.c, text: t, mode, origin });
    setMarquee(null);
    pendingCaret.current = { el: origin, pos: t.length };
  }, [session, setEdit]);

  /** ⌘/Ctrl+arrow: jump to the edge of the data block (Excel rule). */
  const jump = useCallback((p: Pos, dr: number, dc: number): Pos => {
    const filled = (r: number, c: number) => !session.isEmpty(r, c);
    const ok = (r: number, c: number) => r >= 1 && r <= SCRATCH_ROWS && c >= 1 && c <= SCRATCH_COLS;
    let r = p.r, c = p.c;
    if (!ok(r + dr, c + dc)) return p;
    if (filled(r, c) && filled(r + dr, c + dc)) {
      while (ok(r + dr, c + dc) && filled(r + dr, c + dc)) { r += dr; c += dc; }
      return { r, c };
    }
    r += dr; c += dc;
    while (ok(r + dr, c + dc) && !filled(r, c)) { r += dr; c += dc; }
    return { r, c };
  }, [session]);

  const lastUsed = useCallback((): Pos => {
    const u = session.usedRange();
    return u ? { r: u.r2, c: u.c2 } : { r: 1, c: 1 };
  }, [session]);

  // ── clipboard ─────────────────────────────────────────────────────────────
  const doCopy = useCallback((cut: boolean): string => {
    const g = rangeOf(selRef.current);
    const tsv = session.copy(g, cut);
    setMarquee(g);
    return tsv;
  }, [session]);

  const writeClipboard = (text: string) => {
    try { void navigator.clipboard?.writeText(text).catch(() => undefined); } catch { /* unavailable */ }
  };

  const copyValues = useCallback(() => {
    if (!commit()) return;
    focusProxy();
    let ok = false;
    pendingCopy.current = { cut: false };
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    if (!ok || pendingCopy.current) { pendingCopy.current = null; writeClipboard(doCopy(false)); }
    const g = rangeOf(selRef.current);
    onNotice("info", `Copied ${rangeName(g)} — paste it into the Data table (or Excel) with ${MOD_KEY} + V.`);
  }, [commit, focusProxy, doCopy, onNotice]);

  const isProxy = (t: EventTarget | null) => t === proxyRef.current;

  const onCopy = (e: ReactClipboardEvent) => {
    if (!isProxy(e.target) || editRef.current) return;
    e.preventDefault();
    const cut = pendingCopy.current?.cut ?? false;
    pendingCopy.current = null;
    e.clipboardData.setData("text/plain", doCopy(cut));
  };
  const onCut = (e: ReactClipboardEvent) => {
    if (!isProxy(e.target) || editRef.current) return;
    e.preventDefault();
    pendingCopy.current = null;
    e.clipboardData.setData("text/plain", doCopy(true));
  };
  const onPaste = (e: ReactClipboardEvent) => {
    if (!isProxy(e.target) || editRef.current) return;
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    const wasCut = !!session.clip?.cut;
    const res = session.paste(rangeOf(selRef.current), text);
    const ok = onResult(res);
    if (ok && res.ok) {
      if (wasCut) setMarquee(null);
      if (res.range) setSel({ a: { r: res.range.r1, c: res.range.c1 }, f: { r: res.range.r2, c: res.range.c2 }, act: { r: res.range.r1, c: res.range.c1 } });
      if (res.truncated) onNotice("warning", "Part of the paste fell outside the scratchpad and was left out.");
      else if (res.asText) {
        onNotice("warning", `${res.asText.count === 1 ? `${res.asText.first} looked like a formula but couldn't be read, so it was pasted as text`
          : `${res.asText.count} cells (first ${res.asText.first}) looked like formulas but couldn't be read, so they were pasted as text`}. ${res.asText.why}`);
      }
    }
  };

  // WebKit only enables Copy / Cut / Paste (and fires the events) with a selection
  // in an editable element: cancelling the before* events enables them.
  useEffect(() => {
    const el = proxyRef.current;
    if (!el) return;
    const enable = (e: Event) => { if (!editRef.current) e.preventDefault(); };
    el.addEventListener("beforecopy", enable);
    el.addEventListener("beforecut", enable);
    el.addEventListener("beforepaste", enable);
    return () => {
      el.removeEventListener("beforecopy", enable);
      el.removeEventListener("beforecut", enable);
      el.removeEventListener("beforepaste", enable);
    };
  }, []);

  // ── structural edits (context menu) ───────────────────────────────────────
  const structural = (fn: () => EditResult) => { setMenu(null); apply(fn()); focusProxy(); };
  const g = range;
  const nRows = g.r2 - g.r1 + 1, nCols = g.c2 - g.c1 + 1;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

  const autoFit = (c: number) => {
    let w = 0;
    for (const r of session.rowsWithData(c)) w = Math.max(w, measure(session.display(r, c)));
    const px = w ? Math.min(400, Math.max(MIN_COL_WIDTH, Math.ceil(w + 14))) : DEFAULT_COL_WIDTH;
    const s = rangeOf(selRef.current);
    const whole = s.r1 === 1 && s.r2 === SCRATCH_ROWS && c >= s.c1 && c <= s.c2;
    apply(session.setColWidth(whole ? s.c1 : c, whole ? s.c2 : c, px));
  };

  // ── keyboard ──────────────────────────────────────────────────────────────
  const cycleRef = (el: HTMLInputElement | HTMLTextAreaElement, origin: "cell" | "bar") => {
    const ed = editRef.current;
    if (!ed) return;
    try {
      const [text, , end] = session.model.cycleReference(ed.text, el.selectionStart ?? ed.text.length, el.selectionEnd ?? ed.text.length);
      setEdit({ ...ed, text, mode: "edit" });
      pendingCaret.current = { el: origin, pos: end };
    } catch { /* not on a reference */ }
  };

  /** Keys while editing (in the cell or the formula bar). Returns true when handled. */
  const editKey = (e: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>, origin: "cell" | "bar"): boolean => {
    const ed = editRef.current!;
    const mod = e.metaKey || e.ctrlKey;
    switch (e.key) {
      case "Enter":
        if (e.altKey) {
          if (origin === "cell") return false;   // a line break inside the cell (textarea default)
          return true;
        }
        if (mod) {
          const s = rangeOf(selRef.current);
          const res = session.enterInRange(inRange(s, ed.r, ed.c) ? s : { r1: ed.r, c1: ed.c, r2: ed.r, c2: ed.c }, ed.r, ed.c, ed.text);
          if (apply(res)) { pointRef.current = null; setEdit(null); focusProxy(); }
          return true;
        }
        if (commit()) { enterKey(e.shiftKey); focusProxy(); }
        return true;
      case "Tab":
        if (commit()) { tabKey(e.shiftKey); focusProxy(); }
        return true;
      case "Escape":
        cancelEdit();
        return true;
      case "F2":
        setEdit({ ...ed, mode: ed.mode === "enter" ? "edit" : "enter" });
        return true;
      case "F4":
        cycleRef(e.currentTarget, origin);
        return true;
      case "ArrowUp": case "ArrowDown": case "ArrowLeft": case "ArrowRight": {
        if (ed.mode === "edit" || origin === "bar" || mod) return false;   // caret moves inside the text
        const d: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
        if (commit()) { tabStartCol.current = null; const [dr, dc] = d[e.key]; moveTo({ r: ed.r + dr, c: ed.c + dc }); focusProxy(); }
        return true;
      }
      default:
        return false;
    }
  };

  const navKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>): boolean => {
    const mod = e.metaKey || e.ctrlKey;
    const s = selRef.current;
    const k = e.key;
    const lower = k.length === 1 ? k.toLowerCase() : k;
    if (mod && !e.altKey) {
      switch (lower) {
        case "z": if (e.shiftKey) onRedo(); else onUndo(); return true;
        case "y": if (!e.shiftKey) { onRedo(); return true; } return false;
        case "d": apply(session.fill(rangeOf(s), "down")); return true;
        case "r": apply(session.fill(rangeOf(s), "right")); return true;
        case "a": {
          const u = session.usedRange();
          if (selectAllStage.current === 0 && u && !(u.r1 === u.r2 && u.c1 === u.c2)) {
            selectAllStage.current = 1;
            setSel({ a: { r: u.r1, c: u.c1 }, f: { r: u.r2, c: u.c2 }, act: { r: u.r1, c: u.c1 } });
          } else {
            selectAllStage.current = 0;
            setSel({ a: { r: 1, c: 1 }, f: { r: SCRATCH_ROWS, c: SCRATCH_COLS }, act: { r: 1, c: 1 } });
          }
          return true;
        }
        case "c": case "x": {
          // Let the native copy/cut event run; if this WebKit build doesn't fire it, write the text directly.
          const cut = lower === "x";
          pendingCopy.current = { cut };
          setTimeout(() => {
            if (pendingCopy.current) { pendingCopy.current = null; writeClipboard(doCopy(cut)); }
          }, 0);
          return false;
        }
        case "Home": moveTo({ r: 1, c: 1 }, e.shiftKey); return true;
        case "End": moveTo(lastUsed(), e.shiftKey); return true;
        case "ArrowUp": case "ArrowDown": case "ArrowLeft": case "ArrowRight": {
          const d: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
          const [dr, dc] = d[k];
          const from = e.shiftKey ? s.f : s.act;
          moveTo(jump(from, dr, dc), e.shiftKey);
          tabStartCol.current = null;
          return true;
        }
        default: return false;
      }
    }
    if (e.altKey) return false;
    switch (k) {
      case "ArrowUp": case "ArrowDown": case "ArrowLeft": case "ArrowRight": {
        const d: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
        const [dr, dc] = d[k];
        const from = e.shiftKey ? s.f : s.act;
        moveTo({ r: from.r + dr, c: from.c + dc }, e.shiftKey);
        tabStartCol.current = null;
        return true;
      }
      case "Enter": enterKey(e.shiftKey); return true;
      case "Tab": tabKey(e.shiftKey); return true;
      case "Home": moveTo({ r: (e.shiftKey ? s.f : s.act).r, c: 1 }, e.shiftKey); return true;
      case "PageDown": case "PageUp": {
        const n = Math.max(1, Math.floor((bodyRef.current?.clientHeight ?? 400) / ROW_H) - 1);
        const from = e.shiftKey ? s.f : s.act;
        moveTo({ r: from.r + (k === "PageDown" ? n : -n), c: from.c }, e.shiftKey);
        return true;
      }
      case "Delete": case "Backspace": apply(session.clear(rangeOf(s))); return true;
      case "F2": startEdit("edit"); return true;
      case "Escape":
        if (marquee) { setMarquee(null); session.clip = null; return true; }
        // Leave the grid for the tab strip (keyboard users can always get out).
        document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
        return true;
      case "ContextMenu": openMenuAtActive("cell"); return true;
      case "F10": if (e.shiftKey) { openMenuAtActive("cell"); return true; } return false;
      default: return false;
    }
  };

  const openMenuAtActive = (kind: MenuKind) => {
    const el = bodyRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const p = selRef.current.act;
    setMenu({ kind, x: rect.left + colX[p.c] - el.scrollLeft - 8, y: rect.top + p.r * ROW_H - el.scrollTop });
  };

  const onProxyKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key !== "a" && e.key !== "A") selectAllStage.current = 0;
    const handled = editRef.current ? editKey(e, "cell") : navKey(e);
    if (handled) { e.preventDefault(); e.stopPropagation(); }
    else if (editRef.current && (e.metaKey || e.ctrlKey) && e.key === "Enter") e.stopPropagation();
  };

  const onProxyChange = (text: string) => {
    const ed = editRef.current;
    if (ed) { setEdit({ ...ed, text }); pointRef.current = null; return; }
    if (text === "") return;
    const p = selRef.current.act;
    setMarquee(null);
    setEdit({ r: p.r, c: p.c, text, mode: "enter", origin: "cell" });
  };

  // ── mouse ─────────────────────────────────────────────────────────────────
  const cellFromPoint = useCallback((clientX: number, clientY: number): Pos => {
    const el = bodyRef.current!;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left + el.scrollLeft;
    const y = clientY - rect.top + el.scrollTop;
    return { r: clampR(Math.floor(y / ROW_H) + 1), c: clampC(colAt(x)) };
  }, [colAt]);

  /** Drag helper: follows the mouse (auto-scrolling at the edges) until the button is released. */
  const drag = (onMove: (x: number, y: number) => void, onUp?: () => void) => {
    const el = bodyRef.current;
    const move = (ev: MouseEvent) => {
      if (el) {
        const rect = el.getBoundingClientRect();
        if (ev.clientY > rect.bottom) el.scrollTop += 20; else if (ev.clientY < rect.top) el.scrollTop -= 20;
        if (ev.clientX > rect.right) el.scrollLeft += 20; else if (ev.clientX < rect.left) el.scrollLeft -= 20;
      }
      onMove(ev.clientX, ev.clientY);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      onUp?.();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  /** In point mode (editing a formula after an operator), a click inserts a reference. */
  const pointable = (): { el: HTMLInputElement | HTMLTextAreaElement; origin: "cell" | "bar" } | null => {
    const ed = editRef.current;
    if (!ed || !ed.text.startsWith("=")) return null;
    const origin = ed.origin;
    const el = origin === "bar" ? barRef.current : proxyRef.current;
    if (!el) return null;
    const caret = el.selectionStart ?? ed.text.length;
    const pr = pointRef.current;
    if (pr && caret === pr.end) return { el, origin };
    return POINT_AFTER.test(ed.text.slice(0, caret)) ? { el, origin } : null;
  };

  /** Insert (or, while dragging, `extend` = replace the just-inserted) reference at the caret. */
  const insertRef = (target: { el: HTMLInputElement | HTMLTextAreaElement; origin: "cell" | "bar" }, from: Pos, to: Pos, extend = false) => {
    const ed = editRef.current!;
    const pr = pointRef.current;
    const caret = target.el.selectionStart ?? ed.text.length;
    const replace = !!pr && (extend || caret === pr.end);
    const start = replace ? pr!.start : caret;
    const end = replace ? pr!.end : (target.el.selectionEnd ?? caret);
    const g2 = norm({ r1: from.r, c1: from.c, r2: to.r, c2: to.c });
    const ref2 = rangeName(g2);
    const text = ed.text.slice(0, start) + ref2 + ed.text.slice(end);
    pointRef.current = { start, end: start + ref2.length, anchor: from };
    setEdit({ ...ed, text });
    pendingCaret.current = { el: target.origin, pos: start + ref2.length };
  };

  const onBodyMouseDown = (e: ReactMouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target === proxyRef.current && editRef.current) return;   // caret placement inside the editor
    e.preventDefault();
    const p = cellFromPoint(e.clientX, e.clientY);
    const pt = pointable();
    if (pt) {
      insertRef(pt, p, p);
      drag((x, y) => { const q = cellFromPoint(x, y); insertRef(pt, pointRef.current?.anchor ?? p, q, true); });
      return;
    }
    if (editRef.current && !commit()) return;
    focusProxy();
    tabStartCol.current = null;
    const s = selRef.current;
    if (e.shiftKey) setSel({ a: s.a, f: p, act: s.a });
    else setSel(one(p));
    const a = e.shiftKey ? s.a : p;
    drag((x, y) => { const q = cellFromPoint(x, y); setSel({ a, f: q, act: a }); });
  };

  const onBodyDoubleClick = (e: ReactMouseEvent) => {
    const p = cellFromPoint(e.clientX, e.clientY);
    if (editRef.current) return;
    setSel(one(p));
    selRef.current = one(p);
    startEdit("edit");
  };

  const onContextMenu = (kind: MenuKind) => (e: ReactMouseEvent) => {
    e.preventDefault();
    if (editRef.current && !commit()) return;
    focusProxy();
    if (kind === "cell") {
      const p = cellFromPoint(e.clientX, e.clientY);
      if (!inRange(rangeOf(selRef.current), p.r, p.c)) setSel(one(p));
    }
    setMenu({ kind, x: e.clientX, y: e.clientY });
  };

  const headerMouseDown = (axis: "col" | "row") => (e: ReactMouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    if (editRef.current && !commit()) return;
    focusProxy();
    const el = bodyRef.current!;
    const rect = el.getBoundingClientRect();
    const at = (x: number, y: number) => (axis === "col"
      ? clampC(colAt(x - rect.left + el.scrollLeft))
      : clampR(Math.floor((y - rect.top + el.scrollTop) / ROW_H) + 1));
    const i = at(e.clientX, e.clientY);
    const s = selRef.current;
    const start = e.shiftKey ? (axis === "col" ? s.a.c : s.a.r) : i;
    const selFor = (j: number): Sel => (axis === "col"
      ? { a: { r: 1, c: start }, f: { r: SCRATCH_ROWS, c: j }, act: { r: Math.max(1, Math.floor(el.scrollTop / ROW_H) + 1), c: start } }
      : { a: { r: start, c: 1 }, f: { r: j, c: SCRATCH_COLS }, act: { r: start, c: Math.max(1, colAt(el.scrollLeft)) } });
    setSel(selFor(i));
    drag((x, y) => setSel(selFor(at(x, y))));
  };

  const resizeMouseDown = (c: number) => (e: ReactMouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (editRef.current && !commit()) return;
    const s = rangeOf(selRef.current);
    const whole = s.r1 === 1 && s.r2 === SCRATCH_ROWS && c >= s.c1 && c <= s.c2;
    const cols = whole ? Array.from({ length: s.c2 - s.c1 + 1 }, (_, i) => s.c1 + i) : [c];
    const x0 = e.clientX, w0 = widths[c];
    let w = w0;
    setResizing({ cols, w });
    drag((x) => {
      w = Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, Math.round(w0 + x - x0)));
      setResizing({ cols, w });
    }, () => {
      setResizing(null);
      if (w !== w0) apply(session.setColWidth(cols[0], cols[cols.length - 1], w));
      focusProxy();
    });
  };

  const fillMouseDown = (e: ReactMouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (editRef.current && !commit()) return;
    const src = rangeOf(selRef.current);
    let preview: CellRange | null = null;
    drag((x, y) => {
      const q = cellFromPoint(x, y);
      const down = q.r > src.r2 ? q.r - src.r2 : q.r < src.r1 ? src.r1 - q.r : 0;
      const right = q.c > src.c2 ? q.c - src.c2 : q.c < src.c1 ? src.c1 - q.c : 0;
      if (!down && !right) preview = null;
      else if (down >= right) preview = q.r > src.r2 ? { ...src, r2: q.r } : { ...src, r1: q.r };
      else preview = q.c > src.c2 ? { ...src, c2: q.c } : { ...src, c1: q.c };
      setFillPreview(preview);
    }, () => {
      setFillPreview(null);
      if (preview) {
        const to = preview;
        apply(session.autoFill(src, to), () => setSel({ a: { r: to.r1, c: to.c1 }, f: { r: to.r2, c: to.c2 }, act: { r: to.r1, c: to.c1 } }));
      }
      focusProxy();
    });
  };

  // ── imperative handle ─────────────────────────────────────────────────────
  useImperativeHandle(ref, () => ({
    commitEdit: () => commit(),
    copyValues,
    focus: focusProxy,
    selection: () => rangeOf(selRef.current),
    clearMarquee: () => { setMarquee(null); session.clip = null; },
  }), [commit, copyValues, focusProxy, session]);

  // ── formula bar ───────────────────────────────────────────────────────────
  const barValue = edit ? edit.text : session.barText(act.r, act.c);
  const onBarFocus = () => {
    if (editRef.current) return;
    const p = selRef.current.act;
    setEdit({ r: p.r, c: p.c, text: session.input(p.r, p.c), mode: "edit", origin: "bar" });
  };
  const onBarKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (!editRef.current) onBarFocus();
    const handled = editKey(e, "bar");
    if (handled) { e.preventDefault(); e.stopPropagation(); }
    else if ((e.metaKey || e.ctrlKey) && (e.key === "Enter" || e.key.toLowerCase() === "z")) e.stopPropagation();
  };
  const submitName = () => {
    const t = (nameText ?? "").trim();
    setNameText(null);
    const r2 = parseRangeName(t);
    if (r2) {
      setSel({ a: { r: r2.r1, c: r2.c1 }, f: { r: r2.r2, c: r2.c2 }, act: { r: r2.r1, c: r2.c1 } });
      scrollIntoView({ r: r2.r1, c: r2.c1 });
    } else if (t) onNotice("warning", `“${t}” isn't a cell or range (try B2 or A1:C10).`);
    focusProxy();
  };

  // ── render ────────────────────────────────────────────────────────────────
  const cells: ReactElement[] = [];
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const text = session.display(r, c);
      if (text === "") continue;
      const type = session.cellType(r, c);
      const w = colW(c);
      const isNum = type === CELL_NUMBER;
      // Too wide: a General number is shortened as Excel does; anything else shows ####.
      const shown = isNum && measure(text) > w - 6
        ? session.fitGeneral(r, c, (t) => measure(t) <= w - 6) ?? "#".repeat(Math.max(1, Math.floor((w - 6) / 7)))
        : text;
      cells.push(
        <div key={`${r}:${c}`} role="gridcell" aria-rowindex={r + 1} aria-colindex={c + 1}
          aria-selected={inRange(range, r, c)}
          style={{
            position: "absolute", left: colX[c - 1], top: (r - 1) * ROW_H, width: w - 1, height: ROW_H - 1,
            lineHeight: `${ROW_H - 1}px`, padding: "0 4px", boxSizing: "border-box", overflow: "hidden",
            whiteSpace: "pre", textOverflow: isNum ? "clip" : "ellipsis",
            textAlign: isNum ? "right" : type === CELL_BOOLEAN || type === CELL_ERROR ? "center" : "left",
            color: type === CELL_ERROR ? C_ERR : undefined, pointerEvents: "none",
          }}>
          {shown}
        </div>,
      );
    }
  }
  const lines: ReactElement[] = [];
  for (let c = c0; c <= c1; c++) {
    lines.push(<div key={c} style={{ position: "absolute", left: colX[c] - 1, top: (r0 - 1) * ROW_H, width: 1, height: (r1 - r0 + 1) * ROW_H, background: C_LINE }} />);
  }

  const rect = (q: CellRange) => ({
    left: colX[q.c1 - 1], top: (q.r1 - 1) * ROW_H, width: colX[q.c2] - colX[q.c1 - 1], height: (q.r2 - q.r1 + 1) * ROW_H,
  });
  const multi = range.r1 !== range.r2 || range.c1 !== range.c2;
  const selRect = rect(range);
  const actRect = rect({ r1: act.r, c1: act.c, r2: act.r, c2: act.c });

  const editing = !!edit;
  const edRect = edit ? rect({ r1: edit.r, c1: edit.c, r2: edit.r, c2: edit.c }) : actRect;
  const edWidth = edit ? Math.min(Math.max(edRect.width, measure(edit.text) + 16), Math.max(edRect.width, totalW - edRect.left)) : actRect.width;

  const colHeads: ReactElement[] = [];
  for (let c = c0; c <= c1; c++) {
    const on = c >= range.c1 && c <= range.c2;
    const whole = range.r1 === 1 && range.r2 === SCRATCH_ROWS && on;
    colHeads.push(
      <div key={c} role="columnheader" aria-colindex={c + 1} style={{
        position: "absolute", left: colX[c - 1], top: 0, width: colW(c), height: HEAD_H, lineHeight: `${HEAD_H}px`,
        textAlign: "center", borderRight: `1px solid ${C_LINE}`, boxSizing: "border-box", userSelect: "none",
        background: whole ? "rgba(90,127,168,0.45)" : on ? "rgba(90,127,168,0.22)" : undefined,
        color: on ? theme.palette.text.primary : theme.palette.text.secondary, fontSize: 11,
      }}>
        {colName(c)}
        <span onMouseDown={resizeMouseDown(c)} onDoubleClick={(e) => { e.stopPropagation(); autoFit(c); }}
          style={{ position: "absolute", right: -3, top: 0, width: 7, height: HEAD_H, cursor: "col-resize", zIndex: 1 }} />
      </div>,
    );
  }
  const rowHeads: ReactElement[] = [];
  for (let r = r0; r <= r1; r++) {
    const on = r >= range.r1 && r <= range.r2;
    const whole = range.c1 === 1 && range.c2 === SCRATCH_COLS && on;
    rowHeads.push(
      <div key={r} role="rowheader" aria-rowindex={r + 1} style={{
        position: "absolute", left: 0, top: (r - 1) * ROW_H, width: GUTTER, height: ROW_H, lineHeight: `${ROW_H}px`,
        textAlign: "center", borderBottom: `1px solid ${C_LINE}`, boxSizing: "border-box", userSelect: "none", fontSize: 11,
        background: whole ? "rgba(90,127,168,0.45)" : on ? "rgba(90,127,168,0.22)" : undefined,
        color: on ? theme.palette.text.primary : theme.palette.text.secondary,
      }}>
        {r}
      </div>,
    );
  }

  const submitWidth = () => {
    const n = Number(widthDlg?.value);
    setWidthDlg(null);
    if (Number.isFinite(n) && n > 0) apply(session.setColWidth(g.c1, g.c2, n));
    focusProxy();
  };

  const actInput = session.input(act.r, act.c);
  const live = `${cellName(act.r, act.c)}, ${session.display(act.r, act.c) || "blank"}${actInput.startsWith("=") ? `, formula ${actInput}` : ""}`;
  const selName = nameText ?? rangeName(range);
  const menuItems = (() => {
    if (!menu) return null;
    const items: ReactElement[] = [];
    const add = (key: string, label: string, fn: () => EditResult, danger = false) =>
      items.push(<MenuItem key={key} dense sx={danger ? { color: "error.main" } : undefined} onClick={() => structural(fn)}>{label}</MenuItem>);
    if (menu.kind === "cell") {
      items.push(<MenuItem key="cut" dense onClick={() => { setMenu(null); focusProxy(); pendingCopy.current = { cut: true }; let ok = false; try { ok = document.execCommand("cut"); } catch { ok = false; } if (!ok || pendingCopy.current) { pendingCopy.current = null; writeClipboard(doCopy(true)); } }}>
        <ListItemText>Cut</ListItemText><Typography variant="caption" color="text.secondary">{MOD_KEY}X</Typography></MenuItem>);
      items.push(<MenuItem key="copy" dense onClick={() => { setMenu(null); copyValues(); }}>
        <ListItemText>Copy</ListItemText><Typography variant="caption" color="text.secondary">{MOD_KEY}C</Typography></MenuItem>);
      items.push(<MenuItem key="paste" dense disabled><ListItemText>Paste with {MOD_KEY}V</ListItemText></MenuItem>);
      add("clear", "Clear contents", () => session.clear(g));
      items.push(<Divider key="d1" />);
    }
    if (menu.kind !== "col") {
      add("ra", `Insert ${plural(nRows, "row")} above`, () => session.insertRows(g.r1, nRows));
      add("rb", `Insert ${plural(nRows, "row")} below`, () => session.insertRows(g.r2 + 1, nRows));
    }
    if (menu.kind !== "row") {
      add("cl", `Insert ${plural(nCols, "column")} left`, () => session.insertCols(g.c1, nCols));
      add("cr", `Insert ${plural(nCols, "column")} right`, () => session.insertCols(g.c2 + 1, nCols));
    }
    items.push(<Divider key="d2" />);
    if (menu.kind !== "col") add("rd", nRows === 1 ? `Delete row ${g.r1}` : `Delete rows ${g.r1}–${g.r2}`, () => session.deleteRows(g.r1, nRows), true);
    if (menu.kind !== "row") add("cd", nCols === 1 ? `Delete column ${colName(g.c1)}` : `Delete columns ${colName(g.c1)}–${colName(g.c2)}`, () => session.deleteCols(g.c1, nCols), true);
    if (menu.kind !== "cell") add("cc", "Clear contents", () => session.clear(g));
    if (menu.kind === "col") {
      items.push(<MenuItem key="w" dense onClick={() => { setMenu(null); setWidthDlg({ value: String(Math.round(widths[g.c1])) }); }}>Column width…</MenuItem>);
    }
    return items;
  })();

  return (
    <Box data-scratchpad="" sx={{ display: "flex", flexDirection: "column", minHeight: 0, flexGrow: 1, fontSize: FONT_PX }}
      onCopy={onCopy} onCut={onCut} onPaste={onPaste}>
      {/* formula bar */}
      <Box sx={{
        display: "flex", alignItems: "center", gap: 1, px: 1, height: 34, flexShrink: 0, borderBottom: 1, borderColor: "divider", bgcolor: C_HEAD,
        "& input": {
          height: 24, boxSizing: "border-box", px: 0.75, bgcolor: C_CELL, color: "text.primary", font: "inherit",
          fontVariantNumeric: "tabular-nums", border: `1px solid ${C_LINE}`, borderRadius: 0.5, outline: "none",
        },
        "& input:focus": { borderColor: "primary.main" },
      }}>
        <input aria-label="Cell reference (type a cell or range and press Enter to go there)" value={selName} style={{ width: 96 }}
          onFocus={(e) => { setNameText(rangeName(rangeOf(selRef.current))); e.currentTarget.select(); }}
          onChange={(e) => setNameText(e.target.value)}
          onBlur={() => setNameText(null)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); submitName(); }
            else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setNameText(null); focusProxy(); }
          }} />
        <Typography variant="caption" sx={{ fontStyle: "italic", color: "text.secondary", fontWeight: 600, px: 0.5 }} aria-hidden>fx</Typography>
        <input ref={barRef} aria-label={`Contents of ${cellName(act.r, act.c)} (formula bar)`} value={barValue}
          spellCheck={false} autoCapitalize="off" autoCorrect="off" autoComplete="off" style={{ flexGrow: 1, minWidth: 0 }}
          onFocus={onBarFocus}
          onChange={(e) => {
            const ed = editRef.current;
            if (ed) setEdit({ ...ed, text: e.target.value, origin: "bar", mode: "edit" });
            else { const p = selRef.current.act; setEdit({ r: p.r, c: p.c, text: e.target.value, mode: "edit", origin: "bar" }); }
            pointRef.current = null;
          }}
          onKeyDown={onBarKeyDown} />
      </Box>

      {/* grid */}
      <Box role="grid" aria-label="Scratchpad" aria-rowcount={SCRATCH_ROWS + 1} aria-colcount={SCRATCH_COLS + 1}
        aria-multiselectable="true"
        sx={{
          position: "relative", flexGrow: 1, minHeight: 0, display: "grid",
          gridTemplateColumns: `${GUTTER}px minmax(0, 1fr)`, gridTemplateRows: `${HEAD_H}px minmax(0, 1fr)`,
          bgcolor: C_CELL, fontVariantNumeric: "tabular-nums", color: "text.primary",
        }}>
        <Box title="Select all" onMouseDown={(e) => {
          e.preventDefault();
          if (editRef.current && !commit()) return;
          focusProxy();
          setSel({ a: { r: 1, c: 1 }, f: { r: SCRATCH_ROWS, c: SCRATCH_COLS }, act: { r: 1, c: 1 } });
        }} sx={{ bgcolor: C_HEAD, borderRight: `1px solid ${C_LINE}`, borderBottom: `1px solid ${C_LINE}`, cursor: "cell" }} />
        <Box sx={{ position: "relative", overflow: "hidden", bgcolor: C_HEAD, borderBottom: `1px solid ${C_LINE}`, cursor: "s-resize" }}
          onMouseDown={headerMouseDown("col")} onContextMenu={onContextMenu("col")}
          onWheel={(e) => { if (bodyRef.current) bodyRef.current.scrollLeft += e.deltaX || e.deltaY; }}>
          <div style={{ position: "absolute", left: 0, top: 0, width: totalW, height: HEAD_H, transform: `translateX(${-view.left}px)` }}>
            {colHeads}
          </div>
        </Box>
        <Box sx={{ position: "relative", overflow: "hidden", bgcolor: C_HEAD, borderRight: `1px solid ${C_LINE}`, cursor: "e-resize" }}
          onMouseDown={headerMouseDown("row")} onContextMenu={onContextMenu("row")}
          onWheel={(e) => { if (bodyRef.current) bodyRef.current.scrollTop += e.deltaY; }}>
          <div style={{ position: "absolute", left: 0, top: 0, width: GUTTER, height: totalH, transform: `translateY(${-view.top}px)` }}>
            {rowHeads}
          </div>
        </Box>
        <Box ref={bodyRef} onScroll={onScroll} onMouseDown={onBodyMouseDown} onDoubleClick={onBodyDoubleClick}
          onContextMenu={onContextMenu("cell")}
          sx={{ position: "relative", overflow: "auto", cursor: "cell", outline: "none" }}>
          <div style={{
            position: "relative", width: totalW, height: totalH,
            backgroundImage: `repeating-linear-gradient(to bottom, transparent 0, transparent ${ROW_H - 1}px, ${C_LINE} ${ROW_H - 1}px, ${C_LINE} ${ROW_H}px)`,
          }}>
            {lines}
            {cells}
            {/* selection */}
            <div style={{
              position: "absolute", ...selRect, boxSizing: "border-box", pointerEvents: "none",
              background: multi ? "rgba(90,127,168,0.16)" : undefined, border: multi ? `1px solid ${primary}` : undefined,
            }} />
            <div style={{ position: "absolute", ...actRect, boxSizing: "border-box", border: `2px solid ${primary}`, pointerEvents: "none" }} />
            {marquee && (
              <div style={{ position: "absolute", ...rect(marquee), boxSizing: "border-box", border: `2px dashed ${theme.palette.success.main}`, pointerEvents: "none" }} />
            )}
            {fillPreview && (
              <div style={{ position: "absolute", ...rect(fillPreview), boxSizing: "border-box", border: `1px dashed ${theme.palette.text.secondary}`, pointerEvents: "none" }} />
            )}
            {!editing && (
              <div title="Drag to fill" onMouseDown={fillMouseDown} style={{
                position: "absolute", left: selRect.left + selRect.width - 4, top: selRect.top + selRect.height - 4, width: 7, height: 7,
                background: primary, border: `1px solid ${C_CELL}`, cursor: "crosshair", zIndex: 2,
              }} />
            )}
            <textarea
              ref={proxyRef}
              aria-label={editing ? `Editing ${cellName(edit!.r, edit!.c)}` : `Scratchpad, ${cellName(act.r, act.c)}`}
              aria-describedby="scratch-live"
              value={edit ? edit.text : ""}
              wrap="off"
              rows={1}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              onChange={(e) => onProxyChange(e.target.value)}
              onKeyDown={onProxyKeyDown}
              onFocus={() => { const ed = editRef.current; if (ed && ed.origin === "bar") setEdit({ ...ed, origin: "cell" }); }}
              style={{
                position: "absolute", left: edRect.left, top: edRect.top, width: edWidth, height: ROW_H, boxSizing: "border-box",
                margin: 0, padding: "0 4px", lineHeight: `${ROW_H - 2}px`, resize: "none", overflow: "hidden", zIndex: 3,
                font: "inherit", fontSize: FONT_PX, color: theme.palette.text.primary,
                background: editing ? "#2a3442" : "transparent", border: editing ? `2px solid ${primary}` : "none",
                outline: "none", opacity: editing ? 1 : 0, caretColor: editing ? undefined : "transparent",
                pointerEvents: editing ? "auto" : "none", whiteSpace: "pre",
              }}
            />
          </div>
        </Box>
      </Box>
      <div id="scratch-live" aria-live="polite" style={HIDDEN}>{live}</div>

      <Menu open={!!menu} onClose={() => { setMenu(null); focusProxy(); }} anchorReference="anchorPosition"
        anchorPosition={menu ? { top: menu.y, left: menu.x } : undefined}>
        {menuItems}
      </Menu>

      <Dialog open={!!widthDlg} onClose={() => { setWidthDlg(null); focusProxy(); }}>
        <DialogTitle>Column width</DialogTitle>
        <DialogContent>
          <TextField autoFocus size="small" type="number" label="Width in pixels" value={widthDlg?.value ?? ""}
            onChange={(e) => setWidthDlg({ value: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submitWidth(); } }}
            slotProps={{ htmlInput: { min: MIN_COL_WIDTH, max: MAX_COL_WIDTH } }} sx={{ mt: 1, width: 180 }}
            helperText={`${MIN_COL_WIDTH}–${MAX_COL_WIDTH}`} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => { setWidthDlg(null); focusProxy(); }}>Cancel</Button>
          <Button variant="contained" onClick={submitWidth}>OK</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
});
