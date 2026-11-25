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
import type { Instance as PopperInstance } from "@popperjs/core";
import { findFunction, searchFunctions, type FnEntry } from "./functionCatalog";
import { REF_COLORS, formulaRefs, pointRefName, refContaining, rgba, uniqueRanges } from "./formulaRefs";
import {
  NO_ASSIST, applyCompletion, assist, closeBrackets, cycleReferenceUtf16, dollarsOf, insertReference, isPickEcho, pointHow,
  scrollToShow, withDollars, type Assist, type Complete, type Pending,
} from "./formulaEdit";
import { ArgHintPopup, ColouredText, FN_LIST_ID, FN_LIST_PAGE, FunctionListPopup, fnOptionId } from "./FormulaAssist";
import { TypingReporter, backgroundCommit, editTyped } from "./openEdit";

const ROW_H = 24;
const HEAD_H = 24;
const GUTTER = 46;
const OVERSCAN = 3;
const FONT_PX = 12;

const C_CELL = "#1f1f21";
const C_HEAD = "#2c2c2e";
/** Body grid lines, the formula-bar input border. */
const C_LINE = "#4e4e53";
/** Header cell separators. */
const C_HEAD_LINE = "#5a5a5f";
const C_ERR = "#ff8a80";
const HIDDEN = {
  border: 0, clip: "rect(0 0 0 0)", height: "1px", margin: "-1px", overflow: "hidden", padding: 0,
  position: "absolute", whiteSpace: "nowrap", width: "1px",
} as const;

interface Pos { r: number; c: number }
/** a = anchor corner, f = focus (moving) corner, act = active cell (inside the range). */
export interface Sel { a: Pos; f: Pos; act: Pos }
/** Selection and scroll position, kept by the owner across remounts (switching tabs). */
/** Kept by the Scratchpad tab across remounts (switching tabs). `edit` (fixer V-1): a typed edit the sheet refused
 *  when the tab was left (a half-typed "=SUM("), opened again with its text on the next mount. */
export interface ViewMemo { sel?: Sel; top: number; left: number; edit?: EditState }
export interface EditState { r: number; c: number; text: string; mode: "enter" | "edit"; origin: "cell" | "bar" }
type MenuKind = "cell" | "row" | "col";

const one = (p: Pos): Sel => ({ a: p, f: p, act: p });
const rangeOf = (s: Sel): CellRange => norm({ r1: s.a.r, c1: s.a.c, r2: s.f.r, c2: s.f.c });
const clampR = (r: number) => Math.min(SCRATCH_ROWS, Math.max(1, r));
const clampC = (c: number) => Math.min(SCRATCH_COLS, Math.max(1, c));
const inRange = (g: CellRange, r: number, c: number) => r >= g.r1 && r <= g.r2 && c >= g.c1 && c <= g.c2;
/** macOS: Cmd-click adds a reference (Ctrl-click opens the context menu there); elsewhere Ctrl-click. */
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const D_ARROW: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
type EditEl = HTMLInputElement | HTMLTextAreaElement;
/** Where a click / arrow key may insert a reference (point mode). */
interface PointTarget { el: EditEl; origin: "cell" | "bar"; atPending: boolean; afterRef: boolean; unionOnly: boolean }

export interface SheetGridHandle {
  /** Commit an open edit (no move). False when the commit failed and the editor stays open. `background`: a
   *  commit the person did not ask for (Save, drafts, the read-only check — see openEdit.ts): only typed text is
   *  written, and an entry that can't be written (a half-typed formula) stays in its editor with no message. */
  commitEdit: (opts?: { background?: boolean }) => boolean;
  /** Copy the selection's displayed values to the system clipboard. */
  copyValues: () => void;
  focus: () => void;
  selection: () => CellRange;
  /** Forget the cut/copy marquee (after an edit made elsewhere). */
  clearMarquee: () => void;
  /** Fixer V-1: the grid is about to unmount (leaving the Scratchpad tab). A background commit first; a typed
   *  entry it refused (a half-typed formula, or any entry while read-only) is kept in the view memo and opens
   *  again on the next mount. True when an edit was parked (its typing stays recorded in the graph store). */
  park: () => boolean;
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
  /** Phase 3: the analysis is read-only right now. No cell editor opens; Delete, paste, cut (the copy half
   *  still copies), fill, resizing and the menu's changes do nothing and are reported through `onBlocked`.
   *  Selecting, scrolling, moving and copying work. */
  readOnly?: boolean;
  /** A refused change (one call per gesture), e.g. "type", "paste", "delete", "fill". */
  onBlocked?: (action: string) => void;
  /** Phase 3 fix: the open edit holds typed text (true on every keystroke that leaves it different from the
   *  cell) or no longer does (false, once). The owner turns it into graphStore.beginTyping / endTyping. */
  onTyping?: (typed: boolean) => void;
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
  { session, rev, onResult, onUndo, onRedo, onSelectionChange, onNotice, memo, readOnly = false, onBlocked, onTyping }, ref,
) {
  const theme = useTheme();
  const measure = useMeasure(String(theme.typography.fontFamily ?? "sans-serif"));
  const primary = theme.palette.primary.main;

  const [sel, setSelState] = useState<Sel>(() => memo?.sel ?? one({ r: 1, c: 1 }));
  // A parked edit (fixer V-1) opens again where it was, with its text and caret at the end.
  const [edit, setEditState] = useState<EditState | null>(() => memo?.edit ?? null);
  const [view, setView] = useState({ top: 0, left: 0, w: 800, h: 500 });
  const [marquee, setMarquee] = useState<CellRange | null>(null);
  const [fillPreview, setFillPreview] = useState<CellRange | null>(null);
  const [resizing, setResizing] = useState<{ cols: number[]; w: number } | null>(null);
  const [menu, setMenu] = useState<{ kind: MenuKind; x: number; y: number } | null>(null);
  const [widthDlg, setWidthDlg] = useState<{ value: string } | null>(null);
  const [nameText, setNameText] = useState<string | null>(null);

  const selRef = useRef(sel);
  selRef.current = sel;
  const roRef = useRef(readOnly);
  roRef.current = readOnly;
  const onBlockedRef = useRef(onBlocked);
  onBlockedRef.current = onBlocked;
  const onTypingRef = useRef(onTyping);
  onTypingRef.current = onTyping;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  /** Phase 3 fix: reports whether the open edit holds typed text (its first keystroke claims the analysis). */
  const typing = useMemo(() => new TypingReporter((typed) => onTypingRef.current?.(typed)), []);
  useEffect(() => {
    // A restored edit (fixer V-1) holds typed text: it is typing again (reported; the store may already list it).
    // Not keyed on memo.edit, so a StrictMode re-run reports it again after its simulated cleanup ended it.
    if (memo?.edit) memo.edit = undefined;
    typing.update(sessionRef.current, editRef.current);
    return () => typing.end();
  }, [typing]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Read-only: report the refused gesture; true when it was refused. */
  const refused = useCallback((action: string): boolean => {
    if (!roRef.current) return false;
    onBlockedRef.current?.(action);
    return true;
  }, []);
  const editRef = useRef(edit);
  editRef.current = edit;
  const proxyRef = useRef<HTMLTextAreaElement>(null);
  const barRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const tabStartCol = useRef<number | null>(null);
  const selectAllStage = useRef(0);
  const pendingCopy = useRef<{ cut: boolean } | null>(null);
  /** Reference inserted in point mode: [start, end) in the editor text, and the cells it spans. */
  const pointRef = useRef<Pending | null>(null);
  const pendingCaret = useRef<{ el: "cell" | "bar"; pos: number } | null>(edit ? { el: edit.origin, pos: edit.text.length } : null);
  /** The open editor's selection (UTF-16), for the render-time assist; handlers read the element instead. */
  const [caret, setCaret] = useState({ s: 0, e: 0 });
  const [edScroll, setEdScroll] = useState({ left: 0, top: 0 });
  const [barScroll, setBarScroll] = useState({ left: 0, top: 0 });
  /** Highlighted row of the function list, and the editor text for which Escape closed the list. */
  const [acIndex, setAcIndex] = useState(0);
  const [acDismissed, setAcDismissed] = useState<string | null>(null);
  const listPopper = useRef<PopperInstance | null>(null);
  const hintPopper = useRef<PopperInstance | null>(null);
  /** Which editor element has the keyboard focus (the popups only show while the open edit's one does). */
  const [focused, setFocused] = useState<"cell" | "bar" | null>(null);
  /** When a function was last picked from the list with the mouse (to swallow the rest of a double-click). */
  const pickedAt = useRef(-Infinity);

  const setSel = useCallback((s: Sel) => { selRef.current = s; if (memo) memo.sel = s; setSelState(s); }, [memo]);
  const setEdit = useCallback((e: EditState | null) => {
    editRef.current = e;
    setEditState(e);
    if (!e) setAcDismissed(null);   // a closed list is forgotten with the edit
    typing.update(sessionRef.current, e);
  }, [typing]);

  // ── formula assist (autocomplete, argument hint, point mode) ─────────────
  /** The engine's completion context for a formula (sheet and cell don't matter). */
  const complete = useCallback<Complete>((f, cur) => session.model.getFormulaCompletion(0, 1, 1, f, cur), [session]);
  /** The element the open edit types into. */
  const activeEl = (): EditEl | null => (editRef.current?.origin === "bar" ? barRef.current : proxyRef.current);
  /** The assist at the editor's caret right now (read from the element, for event handlers). */
  const assistNow = (): Assist => {
    const ed = editRef.current, el = activeEl();
    if (!ed || !el || roRef.current) return NO_ASSIST;
    const st = el.selectionStart ?? ed.text.length;
    return assist(ed.text, st, el.selectionEnd ?? st, complete);
  };
  const syncCaret = (el: EditEl | null) => {
    if (!el) return;
    const st = el.selectionStart ?? 0, en = el.selectionEnd ?? st;
    setCaret((c) => (c.s === st && c.e === en ? c : { s: st, e: en }));
  };
  const syncScroll = (el: EditEl | null, set: typeof setEdScroll) => {
    if (!el) return;
    const left = el.scrollLeft, top = el.scrollTop;
    set((v) => (v.left === left && v.top === top ? v : { left, top }));
  };
  /** The editor's selection moved (click, arrow keys, typing): track it; leaving the pointed reference ends it. */
  const onEditorSelect = (el: EditEl) => {
    syncCaret(el);
    const pr = pointRef.current;
    if (pr && !pendingCaret.current && (el.selectionStart !== pr.end || el.selectionEnd !== pr.end)) pointRef.current = null;
  };
  // Render-time assist (popups, ARIA). One engine call per text change or caret move.
  const as = useMemo(() => (edit && !readOnly ? assist(edit.text, caret.s, caret.e, complete) : NO_ASSIST),
    [edit?.text, caret.s, caret.e, readOnly, complete]); // eslint-disable-line react-hooks/exhaustive-deps
  const fnPartial = as.fn?.partial;
  const items = useMemo(() => (fnPartial ? searchFunctions(fnPartial) : []), [fnPartial]);
  const edFocused = !!edit && focused === edit.origin;
  const listOpen = edFocused && !readOnly && items.length > 0 && acDismissed !== edit!.text;
  const acCur = Math.min(acIndex, Math.max(0, items.length - 1));
  useLayoutEffect(() => { setAcIndex(0); }, [fnPartial]);

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
  useEffect(() => { if (editRef.current?.origin !== "bar") focusProxy(); }, [focusProxy]);

  // A double-click on a function in the list (the Excel habit): the first press picks it and closes the list,
  // so the second press would land on whatever is under it (a cell: a stray reference). Swallow that press.
  useEffect(() => {
    const swallow = (e: MouseEvent) => {
      if (isPickEcho(e.detail, performance.now(), pickedAt.current)) { e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener("mousedown", swallow, true);
    window.addEventListener("dblclick", swallow, true);
    return () => {
      window.removeEventListener("mousedown", swallow, true);
      window.removeEventListener("dblclick", swallow, true);
    };
  }, []);

  // Restore the caret after a point-mode insertion / F4.
  useLayoutEffect(() => {
    const p = pendingCaret.current;
    if (!p) return;
    pendingCaret.current = null;
    const el = p.el === "bar" ? barRef.current : proxyRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(p.pos, p.pos);
    // setSelectionRange doesn't scroll an input in Chromium: bring the caret (the new reference's end) into view.
    const max = el.scrollWidth - el.clientWidth;
    if (max > 0) {
      const x = p.pos >= el.value.length ? el.scrollWidth : (p.el === "bar" ? 7 : 6) + measure(el.value.slice(0, p.pos));
      el.scrollLeft = scrollToShow(x, el.scrollLeft, el.clientWidth, max);
    }
    syncCaret(el);
    syncScroll(el, p.el === "bar" ? setBarScroll : setEdScroll);
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
    const res = session.setInput(ed.r, ed.c, closeBrackets(ed.text));
    if (!apply(res)) return false;
    pointRef.current = null;
    setEdit(null);
    return true;
  }, [session, apply, setEdit]);

  /** A commit the person did not ask for (openEdit.ts): never an alert, a refused entry stays in its editor. */
  const commitBackground = useCallback((): boolean => {
    const out = backgroundCommit(session, editRef.current);
    if (out.kind === "committed") {
      apply(out.res);
      pointRef.current = null;
      setEdit(null);
      return true;
    }
    if (out.kind === "kept") {
      if (out.res.reason === "fatal") onResult(out.res);   // the engine is gone: the tab shows that
      return false;
    }
    return true;
  }, [session, apply, setEdit, onResult]);

  const cancelEdit = useCallback(() => {
    pointRef.current = null;
    setEdit(null);
    focusProxy();
  }, [setEdit, focusProxy]);

  // The analysis became read-only with an edit open. A pristine editor (opened, nothing typed) closes: it holds
  // nothing, and read-only opens no editor. A typed one stays open with its text (phase 3 fix): its first
  // keystroke claimed, so read-only should not come at all; if it does anyway (e.g. the after-sleep "resuming"
  // guard), the text is kept and Enter commits it once the guard is gone (until then the commit is refused and
  // reported).
  useEffect(() => {
    const ed = editRef.current;
    if (!readOnly || !ed) return;
    if (editTyped(session, ed)) return;
    cancelEdit();
  }, [readOnly]); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (refused("type")) return;
    const p = selRef.current.act;
    const t = text ?? session.input(p.r, p.c);
    setEdit({ r: p.r, c: p.c, text: t, mode, origin });
    setMarquee(null);
    pendingCaret.current = { el: origin, pos: t.length };
  }, [session, setEdit, refused]);

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
    if (cut) refused("cut");     // read-only: the session only copies
    const g = rangeOf(selRef.current);
    const tsv = session.copy(g, cut);
    setMarquee(g);
    return tsv;
  }, [session, refused]);

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
    if (refused("paste")) return;
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
  const structural = (fn: () => EditResult) => { setMenu(null); if (!refused("menu")) apply(fn()); focusProxy(); };
  const g = range;
  const nRows = g.r2 - g.r1 + 1, nCols = g.c2 - g.c1 + 1;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

  const autoFit = (c: number) => {
    if (refused("resize")) return;
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
      const st = el.selectionStart ?? ed.text.length;
      const { text, end } = cycleReferenceUtf16(ed.text, st, el.selectionEnd ?? st, (t, a, b) => session.model.cycleReference(t, a, b));
      // The pointed reference is still the one a click or an arrow replaces, with its new $ form (which the
      // replacement keeps, as in Excel); pointing by keyboard carries on.
      const pr = pointRef.current;
      if (pr) {
        const hit = formulaRefs(text).find((r) => r.start === pr.start);
        pointRef.current = hit ? { ...pr, end: hit.end, abs: dollarsOf(text.slice(hit.start, hit.end)) } : null;
      }
      setEdit({ ...ed, text, mode: pointRef.current ? ed.mode : "edit" });
      pendingCaret.current = { el: origin, pos: end };
    } catch { /* not on a reference */ }
  };

  /** Keys while editing (in the cell or the formula bar). Returns true when handled. */
  const editKey = (e: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>, origin: "cell" | "bar"): boolean => {
    const ed = editRef.current!;
    const mod = e.metaKey || e.ctrlKey;
    if (listOpen) {
      const n = items.length;
      switch (e.key) {
        case "ArrowDown": setAcIndex((acCur + 1) % n); return true;
        case "ArrowUp": setAcIndex((acCur - 1 + n) % n); return true;
        case "PageDown": setAcIndex(Math.min(n - 1, acCur + FN_LIST_PAGE)); return true;
        case "PageUp": setAcIndex(Math.max(0, acCur - FN_LIST_PAGE)); return true;
        case "Tab": acceptFn(items[acCur]); return true;
        case "Enter": if (!e.altKey && !mod) { acceptFn(items[acCur]); return true; } break;
        case "Escape": setAcDismissed(ed.text); return true;
        default: break;
      }
    }
    switch (e.key) {
      case "Enter":
        if (e.altKey) {
          if (origin === "cell") return false;   // a line break inside the cell (textarea default)
          return true;
        }
        if (mod) {
          const s = rangeOf(selRef.current);
          const res = session.enterInRange(inRange(s, ed.r, ed.c) ? s : { r1: ed.r, c1: ed.c, r2: ed.r, c2: ed.c }, ed.r, ed.c, closeBrackets(ed.text));
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
        const [dr, dc] = D_ARROW[e.key];
        // Enter mode at a reference position: the arrow keys point at cells (Shift extends, Cmd/Ctrl jumps).
        const pt = ed.mode === "enter" && !e.altKey ? pointable() : null;
        if (pt && !pt.unionOnly) {
          const pr = pointRef.current;
          const base = pt.atPending && pr ? pr.focus : { r: ed.r, c: ed.c };
          const next = mod ? jump(base, dr, dc) : { r: clampR(base.r + dr), c: clampC(base.c + dc) };
          const anchor = e.shiftKey && pt.atPending && pr ? pr.anchor : next;
          pointTo(anchor, next, pt.atPending ? "replace" : "insert");
          scrollIntoView(next);
          return true;
        }
        if (ed.mode === "edit" || origin === "bar" || mod) return false;   // caret moves inside the text
        if (commit()) { tabStartCol.current = null; moveTo({ r: ed.r + dr, c: ed.c + dc }); focusProxy(); }
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
        case "d": if (!refused("fill")) apply(session.fill(rangeOf(s), "down")); return true;
        case "r": if (!refused("fill")) apply(session.fill(rangeOf(s), "right")); return true;
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
      case "Delete": case "Backspace": if (!refused("delete")) apply(session.clear(rangeOf(s))); return true;
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
    if (ed) { setEdit({ ...ed, text }); pointRef.current = null; setAcDismissed(null); syncCaret(proxyRef.current); return; }
    if (text === "") return;
    if (refused("type")) return;   // the proxy is controlled: its text goes back to ""
    const p = selRef.current.act;
    setMarquee(null);
    setEdit({ r: p.r, c: p.c, text, mode: "enter", origin: "cell" });
    setAcDismissed(null);
    syncCaret(proxyRef.current);
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

  /** Where (and how) a click or an arrow key may insert a reference now; null = it commits instead. */
  const pointable = (): PointTarget | null => {
    const ed = editRef.current;
    if (!ed || roRef.current || !ed.text.startsWith("=")) return null;
    const el = activeEl();
    if (!el) return null;
    const a = assistNow();
    const pr = pointRef.current;
    const atPending = !!pr && el.selectionStart === el.selectionEnd && el.selectionStart === pr.end;
    if (atPending || a.canPoint) return { el, origin: ed.origin, atPending, afterRef: a.afterRef, unionOnly: false };
    if (a.afterRef) return { el, origin: ed.origin, atPending: false, afterRef: true, unionOnly: true };
    return null;
  };

  /** Point at cells anchor→focus: insert / replace the pending / add ",ref". The reference becomes the pending one. */
  const pointTo = (anchor: Pos, focus: Pos, how: "insert" | "replace" | "union") => {
    const ed = editRef.current, el = activeEl();
    if (!ed || !el) return;
    const pr = pointRef.current;
    const mode = how === "replace" && !pr ? "insert" : how;
    const abs = mode === "replace" ? pr?.abs : undefined;
    const ref = withDollars(pointRefName(norm({ r1: anchor.r, c1: anchor.c, r2: focus.r, c2: focus.c })), abs);
    const st = el.selectionStart ?? ed.text.length;
    const res = insertReference(ed.text, st, el.selectionEnd ?? st, pr, ref, mode);
    pointRef.current = { start: res.start, end: res.end, anchor, focus, abs };
    setAcDismissed(null);
    setEdit({ ...ed, text: res.text });
    pendingCaret.current = { el: ed.origin, pos: res.end };
  };

  /** Accept a function from the autocomplete list: "NAME(" with the caret inside. The cell is not committed. */
  const acceptFn = (fn: FnEntry | undefined) => {
    const ed = editRef.current, el = activeEl();
    if (!ed || !el || !fn) return;
    const a = assistNow();
    if (!a.fn) return;
    const res = applyCompletion(ed.text, a.fn.start, el.selectionStart ?? ed.text.length, fn);
    pointRef.current = null;
    setEdit({ ...ed, text: res.text });
    pendingCaret.current = { el: ed.origin, pos: res.caret };
  };

  const onBodyMouseDown = (e: ReactMouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target === proxyRef.current && editRef.current) return;   // caret placement inside the editor
    e.preventDefault();
    const p = cellFromPoint(e.clientX, e.clientY);
    const pt = pointable();
    const pr = pointRef.current;
    const ph = pt ? pointHow(pt, !!pr, e.shiftKey, IS_MAC ? e.metaKey : e.ctrlKey) : null;
    if (ph) {
      const anchor = ph.extend && pr ? pr.anchor : p;
      pointTo(anchor, p, ph.how);
      let last = p;
      drag((x, y) => {
        const q = cellFromPoint(x, y);
        if (q.r === last.r && q.c === last.c) return;
        last = q;
        pointTo(anchor, q, "replace");
      });
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
    const el = bodyRef.current!;
    const rect = el.getBoundingClientRect();
    const at = (x: number, y: number) => (axis === "col"
      ? clampC(colAt(x - rect.left + el.scrollLeft))
      : clampR(Math.floor((y - rect.top + el.scrollTop) / ROW_H) + 1));
    const i = at(e.clientX, e.clientY);
    // Point mode: a header click inserts the whole column(s) / row(s) (A:A, 3:5).
    const pt = pointable();
    const pr = pointRef.current;
    const ph = pt ? pointHow(pt, !!pr, e.shiftKey, IS_MAC ? e.metaKey : e.ctrlKey) : null;
    if (ph) {
      const from = ph.extend && pr ? (axis === "col" ? pr.anchor.c : pr.anchor.r) : i;
      const ends = (j: number): [Pos, Pos] => (axis === "col"
        ? [{ r: 1, c: from }, { r: SCRATCH_ROWS, c: j }]
        : [{ r: from, c: 1 }, { r: j, c: SCRATCH_COLS }]);
      pointTo(...ends(i), ph.how);
      let last = i;
      drag((x, y) => { const j = at(x, y); if (j !== last) { last = j; pointTo(...ends(j), "replace"); } });
      return;
    }
    if (editRef.current && !commit()) return;
    focusProxy();
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
    if (refused("resize")) return;
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
    if (refused("fill")) return;
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
    commitEdit: (opts) => (opts?.background ? commitBackground() : commit()),
    copyValues,
    focus: focusProxy,
    selection: () => rangeOf(selRef.current),
    clearMarquee: () => { setMarquee(null); session.clip = null; },
    park: () => {
      if (commitBackground()) return false;
      const ed = editRef.current;
      if (!ed || !memo || !editTyped(session, ed)) return false;
      memo.edit = { ...ed };
      typing.detach();
      return true;
    },
  }), [commit, commitBackground, copyValues, focusProxy, session, memo, typing]);

  // ── formula bar ───────────────────────────────────────────────────────────
  const barValue = edit ? edit.text : session.barText(act.r, act.c);
  const onBarFocus = () => {
    setFocused("bar");
    const ed = editRef.current;
    if (ed) {
      // An edit started in the cell moves to the bar (as the textarea's focus moves it back): its caret and
      // selection are the ones point mode and the popups use from now on.
      if (ed.origin !== "bar") { setEdit({ ...ed, origin: "bar", mode: "edit" }); syncCaret(barRef.current); }
      return;
    }
    if (roRef.current) return;
    const p = selRef.current.act;
    setEdit({ r: p.r, c: p.c, text: session.input(p.r, p.c), mode: "edit", origin: "bar" });
  };
  const onBarKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (!editRef.current && roRef.current) {
      // Read-only: the formula bar shows the cell's contents (selectable, copyable) and opens no editor.
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === "Escape" || e.key === "Enter" || e.key === "Tab") { e.preventDefault(); e.stopPropagation(); focusProxy(); return; }
      if (!mod && (e.key.length === 1 || e.key === "Backspace" || e.key === "Delete")) refused("type");
      else if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.stopPropagation(); refused("undo"); }
      return;
    }
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
  // The cell, line and header blocks are memoised so a keystroke in the editor (or a caret move) re-renders
  // only the editor, the mirror, the reference highlights and the popups.
  const cells = useMemo(() => {
    const out: ReactElement[] = [];
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const text = session.display(r, c);
        if (text === "") continue;
        const type = session.cellType(r, c);
        const w = colX[c] - colX[c - 1];
        const isNum = type === CELL_NUMBER;
        // Too wide: a General number is shortened as Excel does; anything else shows ####.
        const shown = isNum && measure(text) > w - 6
          ? session.fitGeneral(r, c, (t) => measure(t) <= w - 6) ?? "#".repeat(Math.max(1, Math.floor((w - 6) / 7)))
          : text;
        out.push(
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
    return out;
  }, [session, rev, r0, r1, c0, c1, colX, measure, range.r1, range.c1, range.r2, range.c2]); // eslint-disable-line react-hooks/exhaustive-deps

  // Grid lines: explicit 1px divs (a gradient background is faint in Chromium and can vanish in WKWebView).
  const lines = useMemo(() => {
    const out: ReactElement[] = [];
    const base = { position: "absolute", background: C_LINE, pointerEvents: "none" } as const;
    for (let c = c0; c <= c1; c++) {
      out.push(<div key={`c${c}`} style={{ ...base, left: Math.round(colX[c]) - 1, top: (r0 - 1) * ROW_H, width: 1, height: (r1 - r0 + 1) * ROW_H }} />);
    }
    const left = Math.round(colX[c0 - 1]), width = Math.round(colX[c1]) - left;
    for (let r = r0; r <= r1; r++) {
      out.push(<div key={`r${r}`} style={{ ...base, left, top: r * ROW_H - 1, width, height: 1 }} />);
    }
    return out;
  }, [r0, r1, c0, c1, colX]);

  const rect = (q: CellRange) => ({
    left: colX[q.c1 - 1], top: (q.r1 - 1) * ROW_H, width: colX[q.c2] - colX[q.c1 - 1], height: (q.r2 - q.r1 + 1) * ROW_H,
  });
  const multi = range.r1 !== range.r2 || range.c1 !== range.c2;
  const selRect = rect(range);
  const actRect = rect({ r1: act.r, c1: act.c, r2: act.r, c2: act.c });

  const editing = !!edit;
  const edRect = edit ? rect({ r1: edit.r, c1: edit.c, r2: edit.r, c2: edit.c }) : actRect;
  const edWidth = edit ? Math.min(Math.max(edRect.width, measure(edit.text) + 16), Math.max(edRect.width, totalW - edRect.left)) : actRect.width;

  // Header handlers through a ref, so the memoised headers never call a stale closure.
  const headFns = useRef({ resizeMouseDown, autoFit });
  headFns.current = { resizeMouseDown, autoFit };
  const colHeads = useMemo(() => {
    const out: ReactElement[] = [];
    for (let c = c0; c <= c1; c++) {
      const on = c >= range.c1 && c <= range.c2;
      const whole = range.r1 === 1 && range.r2 === SCRATCH_ROWS && on;
      out.push(
        <div key={c} role="columnheader" aria-colindex={c + 1} style={{
          position: "absolute", left: colX[c - 1], top: 0, width: colX[c] - colX[c - 1], height: HEAD_H, lineHeight: `${HEAD_H}px`,
          textAlign: "center", borderRight: `1px solid ${C_HEAD_LINE}`, boxSizing: "border-box", userSelect: "none",
          background: whole ? "rgba(90,127,168,0.45)" : on ? "rgba(90,127,168,0.22)" : undefined,
          color: on ? theme.palette.text.primary : theme.palette.text.secondary, fontSize: 11,
        }}>
          {colName(c)}
          <span onMouseDown={(e) => headFns.current.resizeMouseDown(c)(e)}
            onDoubleClick={(e) => { e.stopPropagation(); headFns.current.autoFit(c); }}
            style={{ position: "absolute", right: -3, top: 0, width: 7, height: HEAD_H, cursor: "col-resize", zIndex: 1 }} />
        </div>,
      );
    }
    return out;
  }, [c0, c1, colX, range.r1, range.c1, range.r2, range.c2, theme]);
  const rowHeads = useMemo(() => {
    const out: ReactElement[] = [];
    for (let r = r0; r <= r1; r++) {
      const on = r >= range.r1 && r <= range.r2;
      const whole = range.c1 === 1 && range.c2 === SCRATCH_COLS && on;
      out.push(
        <div key={r} role="rowheader" aria-rowindex={r + 1} style={{
          position: "absolute", left: 0, top: (r - 1) * ROW_H, width: GUTTER, height: ROW_H, lineHeight: `${ROW_H}px`,
          textAlign: "center", borderBottom: `1px solid ${C_HEAD_LINE}`, boxSizing: "border-box", userSelect: "none", fontSize: 11,
          background: whole ? "rgba(90,127,168,0.45)" : on ? "rgba(90,127,168,0.22)" : undefined,
          color: on ? theme.palette.text.primary : theme.palette.text.secondary,
        }}>
          {r}
        </div>,
      );
    }
    return out;
  }, [r0, r1, range.r1, range.c1, range.r2, range.c2, theme]);

  // Reference colours: the open editor's text, or the selected cell's formula (one cell only; read-only too).
  const actInput = session.input(act.r, act.c);
  const hlText = edit ? edit.text : (!multi ? actInput : "");
  const refs = useMemo(() => formulaRefs(hlText), [hlText]);
  // The pending reference's outline is dashed: the reference whose text holds the pointed span (for "A1:" then a
  // click on A5 that is the whole "A1:A5").
  const pend = edit ? pointRef.current : null;
  const pendRef = pend ? refContaining(refs, pend.start, pend.end) : undefined;
  const pendRange = pendRef?.range;
  const refBoxes = uniqueRanges(refs).map(({ range: q, color }) => {
    const g2 = { r1: q.r1, c1: q.c1, r2: Math.min(q.r2, SCRATCH_ROWS), c2: Math.min(q.c2, SCRATCH_COLS) };
    const dashed = !!pendRange && pendRange.r1 === g2.r1 && pendRange.c1 === g2.c1 && pendRange.r2 === g2.r2 && pendRange.c2 === g2.c2;
    const hex = REF_COLORS[color];
    return (
      <div key={`${g2.r1},${g2.c1},${g2.r2},${g2.c2}`} data-ref-color={color} style={{
        position: "absolute", ...rect(g2), boxSizing: "border-box", pointerEvents: "none",
        border: `${editing ? 2 : 1}px ${dashed ? "dashed" : "solid"} ${hex}`, background: rgba(hex, editing ? 0.16 : 0.10),
      }} />
    );
  });
  const mirrorOn = refs.length > 0;
  /** The bar shows the analysed text (not a spill child's anchor formula), so its colours line up. */
  const barMirror = mirrorOn && barValue === hlText;
  const transparentText = { color: "transparent", WebkitTextFillColor: "transparent", caretColor: theme.palette.text.primary } as const;
  // Keep the mirrors' scroll in step with their editors (a long formula in the bar scrolls).
  useLayoutEffect(() => {
    if (!mirrorOn) return;
    if (editing) syncScroll(proxyRef.current, setEdScroll);
    syncScroll(barRef.current, setBarScroll);
  });

  // Popups: anchored on the element being typed in; the hint shows when the list is closed.
  const anchorEl = edit ? (edit.origin === "bar" ? barRef.current : proxyRef.current) : null;
  const hintFn = as.arg ? findFunction(as.arg.name) : undefined;
  const hintOpen = edFocused && !readOnly && !listOpen && !!hintFn;
  useLayoutEffect(() => { listPopper.current?.update(); hintPopper.current?.update(); }, [edit?.text, edWidth]);
  const comboAria = (origin: "cell" | "bar") => (listOpen && edit?.origin === origin ? {
    role: "combobox", "aria-autocomplete": "list", "aria-haspopup": "listbox", "aria-expanded": true,
    "aria-controls": FN_LIST_ID, "aria-activedescendant": fnOptionId(acCur),
  } as const : {});

  const submitWidth = () => {
    const n = Number(widthDlg?.value);
    setWidthDlg(null);
    if (Number.isFinite(n) && n > 0) apply(session.setColWidth(g.c1, g.c2, n));
    focusProxy();
  };

  const live = `${cellName(act.r, act.c)}, ${session.display(act.r, act.c) || "blank"}${actInput.startsWith("=") ? `, formula ${actInput}` : ""}`;
  const selName = nameText ?? rangeName(range);
  const menuItems = (() => {
    if (!menu) return null;
    const items: ReactElement[] = [];
    const add = (key: string, label: string, fn: () => EditResult, danger = false) =>
      items.push(<MenuItem key={key} dense disabled={readOnly} sx={danger ? { color: "error.main" } : undefined} onClick={() => structural(fn)}>{label}</MenuItem>);
    if (menu.kind === "cell") {
      items.push(<MenuItem key="cut" dense disabled={readOnly} onClick={() => { setMenu(null); focusProxy(); pendingCopy.current = { cut: true }; let ok = false; try { ok = document.execCommand("cut"); } catch { ok = false; } if (!ok || pendingCopy.current) { pendingCopy.current = null; writeClipboard(doCopy(true)); } }}>
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
      items.push(<MenuItem key="w" dense disabled={readOnly} onClick={() => { setMenu(null); setWidthDlg({ value: String(Math.round(widths[g.c1])) }); }}>Column width…</MenuItem>);
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
        <span style={{ position: "relative", flexGrow: 1, minWidth: 0, display: "flex" }}>
          <input ref={barRef} aria-label={`Contents of ${cellName(act.r, act.c)} (formula bar)`} value={barValue}
            readOnly={readOnly && !edit} aria-readonly={(readOnly && !edit) || undefined}
            spellCheck={false} autoCapitalize="off" autoCorrect="off" autoComplete="off"
            style={{ flexGrow: 1, minWidth: 0, ...(barMirror ? transparentText : null) }}
            {...comboAria("bar")}
            onFocus={onBarFocus}
            onBlur={() => setFocused(null)}
            onChange={(e) => {
              const ed = editRef.current;
              // Typing in the bar keeps its mode (F2 toggles pointing there); coming from the cell it becomes "edit".
              if (ed) setEdit({ ...ed, text: e.target.value, origin: "bar", mode: ed.origin === "bar" ? ed.mode : "edit" });
              else { const p = selRef.current.act; setEdit({ r: p.r, c: p.c, text: e.target.value, mode: "edit", origin: "bar" }); }
              pointRef.current = null;
              setAcDismissed(null);
              syncCaret(e.currentTarget);
            }}
            onSelect={(e) => { if (editRef.current?.origin === "bar") onEditorSelect(e.currentTarget); syncScroll(e.currentTarget, setBarScroll); }}
            onKeyUp={(e) => { if (editRef.current?.origin === "bar") syncCaret(e.currentTarget); syncScroll(e.currentTarget, setBarScroll); }}
            onMouseUp={(e) => { if (editRef.current?.origin === "bar") syncCaret(e.currentTarget); }}
            onScroll={(e) => syncScroll(e.currentTarget, setBarScroll)}
            onKeyDown={onBarKeyDown} />
          {barMirror && (
            <ColouredText text={barValue} refs={refs} scrollLeft={barScroll.left} scrollTop={0} style={{
              // The font is inherited like the input's (no `font` shorthand: it would reset line-height). The input
              // centres its text in its 22px content box; a 22px line box does the same.
              position: "absolute", inset: 0, boxSizing: "border-box", padding: "0 6px", border: "1px solid transparent",
              lineHeight: "22px", fontVariantNumeric: "tabular-nums",
            }} />
          )}
        </span>
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
        }} sx={{ bgcolor: C_HEAD, borderRight: `1px solid ${C_HEAD_LINE}`, borderBottom: `1px solid ${C_HEAD_LINE}`, cursor: "cell" }} />
        <Box sx={{ position: "relative", overflow: "hidden", bgcolor: C_HEAD, borderBottom: `1px solid ${C_HEAD_LINE}`, cursor: "s-resize" }}
          onMouseDown={headerMouseDown("col")} onContextMenu={onContextMenu("col")}
          onWheel={(e) => { if (bodyRef.current) bodyRef.current.scrollLeft += e.deltaX || e.deltaY; }}>
          <div style={{ position: "absolute", left: 0, top: 0, width: totalW, height: HEAD_H, transform: `translateX(${-view.left}px)` }}>
            {colHeads}
          </div>
        </Box>
        <Box sx={{ position: "relative", overflow: "hidden", bgcolor: C_HEAD, borderRight: `1px solid ${C_HEAD_LINE}`, cursor: "e-resize" }}
          onMouseDown={headerMouseDown("row")} onContextMenu={onContextMenu("row")}
          onWheel={(e) => { if (bodyRef.current) bodyRef.current.scrollTop += e.deltaY; }}>
          <div style={{ position: "absolute", left: 0, top: 0, width: GUTTER, height: totalH, transform: `translateY(${-view.top}px)` }}>
            {rowHeads}
          </div>
        </Box>
        <Box ref={bodyRef} onScroll={onScroll} onMouseDown={onBodyMouseDown} onDoubleClick={onBodyDoubleClick}
          onContextMenu={onContextMenu("cell")}
          sx={{ position: "relative", overflow: "auto", cursor: "cell", outline: "none" }}>
          <div style={{ position: "relative", width: totalW, height: totalH }}>
            {lines}
            {cells}
            {refBoxes}
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
              <div title={readOnly ? undefined : "Drag to fill"} onMouseDown={fillMouseDown} style={{
                position: "absolute", left: selRect.left + selRect.width - 4, top: selRect.top + selRect.height - 4, width: 7, height: 7,
                background: readOnly ? theme.palette.text.disabled : primary, border: `1px solid ${C_CELL}`,
                cursor: readOnly ? "default" : "crosshair", zIndex: 2,
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
              {...comboAria("cell")}
              onChange={(e) => onProxyChange(e.target.value)}
              onKeyDown={onProxyKeyDown}
              onSelect={(e) => { if (editRef.current?.origin === "cell") onEditorSelect(e.currentTarget); syncScroll(e.currentTarget, setEdScroll); }}
              onKeyUp={(e) => { if (editRef.current?.origin === "cell") syncCaret(e.currentTarget); syncScroll(e.currentTarget, setEdScroll); }}
              onMouseUp={(e) => { if (editRef.current?.origin === "cell") syncCaret(e.currentTarget); }}
              onScroll={(e) => syncScroll(e.currentTarget, setEdScroll)}
              onFocus={() => { setFocused("cell"); const ed = editRef.current; if (ed && ed.origin === "bar") setEdit({ ...ed, origin: "cell" }); }}
              onBlur={() => setFocused(null)}
              style={{
                position: "absolute", left: edRect.left, top: edRect.top, width: edWidth, height: ROW_H, boxSizing: "border-box",
                margin: 0, padding: "0 4px", lineHeight: `${ROW_H - 2}px`, resize: "none", overflow: "hidden", zIndex: 3,
                font: "inherit", fontSize: FONT_PX, color: theme.palette.text.primary,
                background: editing ? "#2a3442" : "transparent", border: editing ? `2px solid ${primary}` : "none",
                outline: "none", opacity: editing ? 1 : 0, caretColor: editing ? undefined : "transparent",
                pointerEvents: editing ? "auto" : "none", whiteSpace: "pre",
                ...(editing && mirrorOn ? transparentText : null),
              }}
            />
            {editing && mirrorOn && (
              <ColouredText text={edit!.text} refs={refs} scrollLeft={edScroll.left} scrollTop={edScroll.top} style={{
                position: "absolute", left: edRect.left, top: edRect.top, width: edWidth, height: ROW_H, boxSizing: "border-box",
                // Same box as the textarea. Its `font: inherit` resets its line-height to the inherited one, which
                // the mirror inherits too (so no lineHeight here).
                padding: "0 4px", border: "2px solid transparent", fontSize: FONT_PX, zIndex: 4,
              }} />
            )}
          </div>
        </Box>
      </Box>
      <div id="scratch-live" aria-live="polite" style={HIDDEN}>{live}</div>

      {/* Outside the grid: events in these portalled popups must not bubble to the grid's mouse handlers. */}
      <FunctionListPopup open={listOpen} anchorEl={anchorEl} popperRef={listPopper} lineColor={C_LINE} items={items} index={acCur}
        partial={as.fn?.partial ?? ""} onPick={(fn) => { pickedAt.current = performance.now(); acceptFn(fn); }} onHover={setAcIndex} />
      <ArgHintPopup open={hintOpen} anchorEl={anchorEl} popperRef={hintPopper} lineColor={C_LINE} fn={hintFn} argIndex={as.arg?.index ?? 0} />

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
