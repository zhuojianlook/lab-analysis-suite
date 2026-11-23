import { create, type StoreApi, type UseBoundStore } from "zustand";
import type { GraphAnalysis, GraphDoc, GraphFigure, Template } from "../api/graph";
import * as M from "../components/graph/graphModel";
import { sanitizeScratch, type ScratchDoc } from "../components/graph/scratchpad/scratchModel";
import type { BlockedEdit, EditGuard, EditPath, StoreGuardApi } from "../components/graph/file/contract";

/** What one undo step restores: the table, plus — for structural steps that
 *  move columns/rows around — everything indexed by column/row. */
interface Snapshot {
  doc: GraphDoc;
  /** Column/row insert, delete, clear, replicate change or paste: undo also
   *  restores the series colours/labels and the control/pair indices. Typing
   *  steps never move indices, so undoing them leaves those settings alone. */
  structural: boolean;
  colors: string[];
  labels: string[];
  /** The palette bookkeeping that goes with `colors` (name, captured colours,
   *  reverse, edited flag, axis scheme), so undo never leaves the picker naming
   *  a palette the restored colours don't come from. */
  palette: Pick<GraphFigure, (typeof M.PALETTE_KEYS)[number]>;
  control: number | null;
  pairs: [number, number][];
  /** Phase 2: a "whole content" step (after a combine): undo puts back all four parts. */
  whole?: { analysis: GraphAnalysis; figure: GraphFigure; scratch: string };
  /** Phase 2: the step's label ("Undo: combine with Alice's changes"); absent for ordinary steps. */
  label?: string;
}

const UNDO_LIMIT = 20;

/** Which analysis file the open document is (phase 1: analyses saved as files). */
export interface FileRef {
  /** Local key of the open document (session tab, draft). */
  docKey: string;
  /** null only for documents that have none yet. */
  analysisId: string | null;
  /** Head of the file the content is based on; null = never saved. */
  baseRevision: string | null;
  /** null = untitled. */
  path: string | null;
}

/** The content of a document as the store holds it (index-based open form). */
export interface DocContent {
  doc: GraphDoc;
  analysis: GraphAnalysis;
  figure: GraphFigure;
  /** Canonical scratchpad text ("" = empty). */
  scratch: string;
}

export interface GraphState extends StoreGuardApi {
  /** The open document; null = start screen. */
  doc: GraphDoc | null;
  analysis: GraphAnalysis;
  figure: GraphFigure;
  /** Library name ("" = not named yet). Not part of the saved content key. */
  name: string;
  /** `name` at the last save/open (null when savedSnapshot is null). Kept apart from
   *  the content key so the name can later become the file name. */
  savedName: string | null;
  /** Library id of the saved version this document came from (null = never saved / deleted). */
  currentId: number | null;
  /** snapshotKey() (content only: table, analysis, figure) at the last save/open;
   *  null = has unsaved changes by definition. */
  savedSnapshot: string | null;
  undoStack: Snapshot[];
  /** Cell being typed in — consecutive edits of one cell share one undo step. */
  lastEditKey: string | null;
  /** Bumped whenever a different document is opened/created/closed. */
  docSerial: number;
  /** How the current document was opened. */
  openedAs: "new" | "sample" | "saved" | "draft";
  /** The Scratchpad sheet as canonical JSON text ("" = empty). Saved with the
   *  analysis, but never part of the statistics or the figure. */
  scratch: string;
  /** `scratch` at the last save/open (null when savedSnapshot is null). */
  savedScratch: string | null;
  /** The file this document is (null = the old in-app library / nothing open). */
  file: FileRef | null;
  /** Bumped by every change of doc, analysis, figure or scratch (edits, loads, reloads). */
  editSerial: number;

  newDoc: (t: Template, sample: boolean) => void;
  load: (p: {
    doc: GraphDoc; analysis?: Partial<GraphAnalysis>; figure?: Partial<GraphFigure>; name: string; id: number | null; saved: boolean;
    /** Saved scratchpad (object, JSON text or null); sanitized. */
    scratch?: unknown;
  }) => void;
  close: () => void;
  setName: (name: string) => void;
  /** Saved as `id`; `sent` is exactly what was sent (later edits stay unsaved). */
  markSaved: (id: number, name: string, sent: Pick<GraphState, "doc" | "analysis" | "figure" | "scratch">) => void;
  markRenamed: (name: string) => void;
  detach: () => void;

  setCell: (r: number, c: number, k: number, v: string) => void;
  setX: (r: number, v: string) => void;
  setRowTitle: (r: number, v: string) => void;
  setColTitle: (c: number, v: string) => void;
  setXTitle: (v: string) => void;
  setNRep: (n: number) => void;
  insertCol: (at: number) => void;
  deleteCol: (c: number) => void;
  clearCol: (c: number) => void;
  insertRow: (at: number) => void;
  deleteRow: (r: number) => void;
  clearRow: (r: number) => void;
  paste: (anchor: M.PasteAnchor, text: string) => M.PasteResult | null;
  /** Scratchpad → Data: optionally blank every value first, then paste — one undo step. */
  sendBlock: (anchor: M.PasteAnchor, text: string, clearFirst: boolean) => M.PasteResult | null;
  /** Replace the scratchpad text (touches nothing else: no undo step, no analysis/figure change). */
  setScratch: (text: string) => void;
  /** The automatic settings clean-up (M.normalizeSettings) for the current table;
   *  no undo step, no change when the settings already fit. load/newDoc run it
   *  before taking the saved baseline. */
  normalize: () => void;
  undo: () => boolean;

  setAnalysis: (patch: Partial<GraphAnalysis> | ((a: GraphAnalysis) => GraphAnalysis)) => void;
  setFigure: (patch: Partial<GraphFigure> | ((f: GraphFigure) => GraphFigure)) => void;

  // ── analyses saved as files (phase 1) ──
  /** Open a file's content: the load pipeline (ids → defaults → clean-up), the baseline
   *  taken afterwards. `name` is the tab title (never makes the document dirty).
   *  `inPlace`: a reload of the same document (docSerial kept, so the Scratchpad session
   *  survives when its text is unchanged). */
  loadFile: (p: {
    file: FileRef; name: string; doc: GraphDoc; analysis?: Partial<GraphAnalysis>; figure?: Partial<GraphFigure>;
    scratch?: unknown; saved: boolean; inPlace?: boolean;
  }) => void;
  /** Put unsaved work (a draft) on top of a loaded file: content changes; the baseline and `file` stay. */
  replaceWorking: (p: { doc: GraphDoc; analysis?: Partial<GraphAnalysis>; figure?: Partial<GraphFigure>; scratch?: unknown }) => void;
  /** Saved as `file`. `sent` is the round-tripped file form of what was saved: it becomes the
   *  baseline, and the in-memory content when nothing was edited since the save was built
   *  (`editSerialAtBuild`; omitted = nothing was). */
  markFileSaved: (file: FileRef, name: string, sent: DocContent, editSerialAtBuild?: number) => void;
  /** Path / base / id change without touching the content (rename follow, Save As). */
  setFileRef: (patch: Partial<FileRef>, name?: string) => void;

  // ── phase 2: reload in place ──
  /** Replace the open document's content with a version from the file (phase 2 contract §5.7). Applies
   *  only when the document, its base and its editSerial are still what the caller saw; else false and
   *  nothing changes. The baseline is taken after the load pipeline; docSerial is kept; the undo stack is
   *  emptied, or — with `undo` — holds exactly one step that puts the whole previous content back.
   *  `working` (optional): content shown on top of the new baseline (unsaved changes carried over). */
  replaceContent: (p: ReplaceContentArgs) => boolean;
  /** Label of the top undo step (null for ordinary steps or an empty stack). */
  undoLabel: () => string | null;
}

export interface ReplaceContentArgs {
  docKey: string; expectedBase: string | null; expectedEditSerial: number;
  file: FileRef; name: string;
  doc: GraphDoc; analysis?: Partial<GraphAnalysis>; figure?: Partial<GraphFigure>; scratch?: unknown;
  /** After a combine: one undo step that puts back what was there, with this label. */
  undo?: { label: string };
  /** Unsaved changes to show on top of the new version (the baseline stays the version). */
  working?: { doc: GraphDoc; analysis?: Partial<GraphAnalysis>; figure?: Partial<GraphFigure>; scratch?: unknown };
}

/** The saved content (table incl. row/column ids, analysis, figure); compared to
 *  tell whether there are unsaved changes. The name and the scratchpad are
 *  compared separately. */
export const snapshotKey = (s: Pick<GraphState, "doc" | "analysis" | "figure">) =>
  JSON.stringify({ doc: s.doc, analysis: s.analysis, figure: s.figure });

export const isDirty = (s: GraphState) =>
  !!s.doc && (s.savedSnapshot === null || s.scratch !== s.savedScratch || s.name !== s.savedName
    || s.savedSnapshot !== snapshotKey(s));

const paletteFields = (f: GraphFigure): Snapshot["palette"] => {
  const out: Record<string, unknown> = {};
  for (const k of M.PALETTE_KEYS) out[k] = f[k];
  return out as Snapshot["palette"];
};

const snap = (s: GraphState, structural: boolean): Snapshot => ({
  doc: s.doc!,
  structural,
  colors: s.figure.colors,
  labels: s.figure.labels,
  palette: paletteFields(s.figure),
  control: s.analysis.control,
  pairs: s.analysis.pairs,
});

const pushUndo = (s: GraphState, structural: boolean) => [...s.undoStack.slice(-(UNDO_LIMIT - 1)), snap(s, structural)];

/** Initial analysis + figure for a document (counts taken from its data). */
function defaultsFor(doc: GraphDoc) {
  const table = M.toNumericTable(doc);
  const nGroups = M.hasNumbers(table) ? M.usedCols(table) : doc.col_titles.length;
  const nRows = M.hasNumbers(table) ? M.usedRows(table) : doc.cells.length;
  return {
    analysis: M.defaultAnalysis(doc.template, nGroups, nRows),
    figure: M.defaultFigure(doc.template, doc.col_titles.length, doc.x_title),
  };
}

/** Saved settings layered over the defaults, so records from older versions
 *  that lack a newer field still open with every field set; then the
 *  automatic clean-up, so opening a document never changes it afterwards. */
function openSettings(doc: GraphDoc, analysis?: Partial<GraphAnalysis>, figure?: Partial<GraphFigure>) {
  const m = mergeSettings(doc, analysis, figure);
  return M.normalizeSettings(doc, m.analysis, m.figure);
}

function mergeSettings(doc: GraphDoc, analysis?: Partial<GraphAnalysis>, figure?: Partial<GraphFigure>) {
  const d = defaultsFor(doc);
  const saved = (figure && typeof figure === "object" ? figure : {}) as Record<string, unknown>;
  const { prism_palette: _pp, ...rest } = saved;   // derived for the plot request only; never stored
  const merged = { ...d.figure, ...rest } as GraphFigure;
  // Documents from before palettes were named: show which built-in palette
  // their colours are ("" = custom colours); the figure itself is unchanged.
  const pal = Object.prototype.hasOwnProperty.call(saved, "palette")
    ? M.sanitizePaletteFields(saved)
    : { palette: M.inferAppPalette(Array.isArray(merged.colors) ? merged.colors : []),
      palette_reverse: false, palette_edited: false, axis_scheme: false };
  const { palette_colors: _pc, ...noPc } = merged;
  return {
    analysis: { ...d.analysis, ...(analysis ?? {}) } as GraphAnalysis,
    figure: M.resizeSeries({ ...noPc, ...pal } as GraphFigure, doc.col_titles.length),
  };
}

const placeholder = defaultsFor(M.emptyDoc("column"));

/** The load pipeline without the store: ids minted where missing, settings layered
 *  over the defaults and cleaned up, scratchpad sanitized. Opening this content
 *  never changes it. */
export function openContent(p: { doc: GraphDoc; analysis?: Partial<GraphAnalysis>; figure?: Partial<GraphFigure>; scratch?: unknown }): DocContent {
  const doc = M.withIds(p.doc);
  return { doc, ...openSettings(doc, p.analysis, p.figure), scratch: sanitizeScratch(p.scratch) };
}

const CONTENT_KEYS = ["doc", "analysis", "figure", "scratch"] as const;

/** The next refused change (phase 3 contract §4.1). */
const nextBlocked = (s: Pick<GraphState, "blocked">, path: EditPath, action: string): BlockedEdit =>
  ({ serial: (s.blocked?.serial ?? 0) + 1, path, action });

/** Same keys with identical values: a settings change that changes nothing is not a change. */
function sameFields<T extends object>(a: T, b: T): boolean {
  if (a === b) return true;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** Reset by every action that opens or closes a document: the controller sets the new tab's guard. */
const NO_GUARD = { guard: null, blocked: null } as const;

export type GraphStoreApi = UseBoundStore<StoreApi<GraphState>>;

/** A graph store (the app has one, `useGraphStore`; tests make one per simulated computer). */
export function createGraphStore(): GraphStoreApi {
  return create<GraphState>((rawSet, get) => {
    /** Depth of the user action running now (phase 3: its changes bump userEditSerial). */
    let userDepth = 0;
    /** An update is being applied: updates made meanwhile (by store listeners) are never the person's. */
    let applying = false;

    /** Every update that changes the content bumps editSerial; the update a user action makes also bumps
     *  userEditSerial when it changes the content or the name (the controller's "the person changed something"). */
    const set: typeof rawSet = ((partial: unknown, replace?: boolean) => {
      const byUser = userDepth > 0 && !applying;
      const was = applying;
      applying = true;
      try {
        rawSet((s: GraphState) => {
          const p = (typeof partial === "function" ? (partial as (s: GraphState) => Partial<GraphState>)(s) : partial) as Partial<GraphState> | null;
          if (!p) return {};
          const changed = CONTENT_KEYS.some((k) => k in p && p[k] !== s[k]);
          const out = changed && !("editSerial" in p) ? { ...p, editSerial: s.editSerial + 1 } : p;
          return byUser && (changed || ("name" in p && p.name !== s.name)) ? { ...out, userEditSerial: s.userEditSerial + 1 } : out;
        }, replace as false | undefined);
      } finally {
        applying = was;
      }
    }) as typeof rawSet;

    /** A change made by the person (phase 3 contract §4.1). While a guard is set it changes nothing, records
     *  the refusal in `blocked` (editSerial, the undo stack and lastEditKey untouched) and returns `nothing`.
     *  `noop`: arguments that would change nothing anyway are neither applied nor reported. */
    const user = <A extends unknown[], R>(
      path: EditPath, action: string, nothing: R, fn: (...a: A) => R, noop?: (s: GraphState, ...a: A) => boolean,
    ) => (...a: A): R => {
      const s = get();
      if (s.guard) {
        if (!noop?.(s, ...a)) rawSet((st) => ({ blocked: nextBlocked(st, path, action) }));
        return nothing;
      }
      userDepth++;
      try { return fn(...a); } finally { userDepth--; }
    };
    const tableEdit = <A extends unknown[], R>(action: string, nothing: R, fn: (...a: A) => R) => user("table", action, nothing, fn);

    /** Apply a change to the open document, recording an undo step. */
    const edit = (fn: (s: GraphState) => Partial<GraphState> | null) =>
      set((s) => {
        if (!s.doc) return {};
        const patch = fn(s);
        if (!patch) return {};
        return { ...patch, undoStack: pushUndo(s, true), lastEditKey: null };
      });

    /** Typing in one cell: one undo step per cell, not per keystroke. */
    const type = (key: string, fn: (doc: GraphDoc) => GraphDoc, extra?: (s: GraphState) => Partial<GraphState>) =>
      set((s) => {
        if (!s.doc) return {};
        return {
          doc: fn(s.doc),
          ...(extra ? extra(s) : {}),
          undoStack: s.lastEditKey === key ? s.undoStack : pushUndo(s, false),
          lastEditKey: key,
        };
      });

    return {
      doc: null,
      analysis: placeholder.analysis,
      figure: placeholder.figure,
      name: "",
      savedName: null,
      currentId: null,
      savedSnapshot: null,
      undoStack: [],
      lastEditKey: null,
      docSerial: 0,
      openedAs: "new",
      scratch: "",
      savedScratch: null,
      file: null,
      editSerial: 0,
      guard: null,
      userEditSerial: 0,
      blocked: null,

      newDoc: (t, sample) => {
        const doc = sample ? M.sampleDoc(t) : M.emptyDoc(t);
        const d = defaultsFor(doc);
        const next = { doc, ...M.normalizeSettings(doc, d.analysis, d.figure), name: "" };
        // A fresh document only counts as changed once it is edited.
        set((s) => ({
          ...next, savedName: "", currentId: null, savedSnapshot: snapshotKey(next), undoStack: [], lastEditKey: null,
          docSerial: s.docSerial + 1, openedAs: sample ? "sample" : "new", scratch: "", savedScratch: "", file: null, ...NO_GUARD,
        }));
      },

      load: ({ doc: raw, analysis, figure, name, id, saved, scratch }) => {
        // Ids minted for documents without them, defaults, clean-up: all before the
        // baseline, so a document is unchanged until the user changes it.
        const doc = M.withIds(raw);
        const next = { doc, ...openSettings(doc, analysis, figure), name };
        const sc = sanitizeScratch(scratch);
        set((s) => ({
          ...next, savedName: saved ? name : null, currentId: id, savedSnapshot: saved ? snapshotKey(next) : null,
          undoStack: [], lastEditKey: null,
          docSerial: s.docSerial + 1, openedAs: saved ? "saved" : "draft", scratch: sc, savedScratch: saved ? sc : null, file: null, ...NO_GUARD,
        }));
      },

      close: () => set((s) => ({
        doc: null, name: "", savedName: null, currentId: null, savedSnapshot: null, undoStack: [], lastEditKey: null, docSerial: s.docSerial + 1,
        scratch: "", savedScratch: null, file: null, ...NO_GUARD,
      })),

      setName: user("name", "setName", undefined, (name: string) => set({ name })),

      markSaved: (id, name, sent) => set({
        name, savedName: name, currentId: id, savedSnapshot: snapshotKey(sent), savedScratch: sent.scratch,
      }),

      // Renamed in the library: the saved version now carries the new name.
      markRenamed: (name) => set({ name, savedName: name }),

      // The open document's library record was deleted: keep it on screen, unsaved.
      detach: () => set({ currentId: null, savedSnapshot: null, savedScratch: null, savedName: null }),

      setScratch: user("scratchpad", "setScratch", undefined,
        (text: string) => set((s) => (s.scratch === text ? {} : { scratch: text })),
        (s, text) => s.scratch === text),

      // Neither a user action nor a load: under a guard it does nothing (and reports nothing).
      normalize: () => set((s) => {
        if (!s.doc || s.guard) return {};
        const n = M.normalizeSettings(s.doc, s.analysis, s.figure);
        return n.analysis === s.analysis && n.figure === s.figure ? {} : n;
      }),

      setCell: tableEdit("setCell", undefined, (r: number, c: number, k: number, v: string) =>
        type(`c:${r}:${c}:${k}`, (doc) => {
          const cells = [...doc.cells];
          const row = [...cells[r]];
          const reps = [...row[c]];
          reps[k] = v;
          row[c] = reps;
          cells[r] = row;
          return M.ensureRows({ ...doc, cells });
        })),

      setX: tableEdit("setX", undefined, (r: number, v: string) =>
        type(`x:${r}`, (doc) => {
          const x = [...doc.x];
          x[r] = v;
          return M.ensureRows({ ...doc, x });
        })),

      setRowTitle: tableEdit("setRowTitle", undefined, (r: number, v: string) =>
        type(`rt:${r}`, (doc) => {
          const row_titles = [...doc.row_titles];
          row_titles[r] = v;
          return M.ensureRows({ ...doc, row_titles });
        })),

      setColTitle: tableEdit("setColTitle", undefined, (c: number, v: string) =>
        type(`ct:${c}`, (doc) => {
          const col_titles = [...doc.col_titles];
          col_titles[c] = v;
          return { ...doc, col_titles };
        })),

      // The X axis label follows the X column title until it is edited separately.
      setXTitle: tableEdit("setXTitle", undefined, (v: string) =>
        type("xt", (doc) => ({ ...doc, x_title: v }), (s) => {
          const figure = M.followXLabel(s.figure, s.doc!.x_title, v);
          return figure === s.figure ? {} : { figure };
        })),

      setNRep: tableEdit("setNRep", undefined, (n: number) => edit((s) => {
        const doc = M.setNRep(s.doc!, n);
        return doc === s.doc ? null : { doc };
      })),

      insertCol: tableEdit("insertCol", undefined, (at: number) => edit((s) => {
        const doc = M.insertCol(s.doc!, at);
        if (doc === s.doc) return null;
        const op: M.IndexOp = { type: "insert", at };
        return { doc, analysis: M.remapAnalysis(s.analysis, doc.template, "col", op), figure: M.remapFigure(s.figure, op) };
      })),

      deleteCol: tableEdit("deleteCol", undefined, (c: number) => edit((s) => {
        if (s.doc!.col_titles.length <= 1) return { doc: M.clearCol(s.doc!, c) };
        const op: M.IndexOp = { type: "delete", at: c };
        return {
          doc: M.deleteCol(s.doc!, c),
          analysis: M.remapAnalysis(s.analysis, s.doc!.template, "col", op),
          figure: M.remapFigure(s.figure, op),
        };
      })),

      clearCol: tableEdit("clearCol", undefined, (c: number) => edit((s) => ({ doc: M.clearCol(s.doc!, c) }))),

      insertRow: tableEdit("insertRow", undefined, (at: number) => edit((s) => {
        const doc = M.insertRow(s.doc!, at);
        if (doc === s.doc) return null;
        return { doc, analysis: M.remapAnalysis(s.analysis, doc.template, "row", { type: "insert", at }) };
      })),

      deleteRow: tableEdit("deleteRow", undefined, (r: number) => edit((s) => ({
        doc: M.deleteRow(s.doc!, r),
        analysis: M.remapAnalysis(s.analysis, s.doc!.template, "row", { type: "delete", at: r }),
      }))),

      clearRow: tableEdit("clearRow", undefined, (r: number) => edit((s) => ({ doc: M.clearRow(s.doc!, r) }))),

      paste: tableEdit("paste", null, (anchor: M.PasteAnchor, text: string): M.PasteResult | null => {
        const s = get();
        if (!s.doc) return null;
        const res = M.applyPaste(s.doc, anchor, text);
        if (!res) return null;
        // A title line can set the X title: the axis label follows it as when typed.
        const figure = M.followXLabel(M.resizeSeries(s.figure, res.doc.col_titles.length), s.doc.x_title, res.doc.x_title);
        set({ doc: res.doc, figure, undoStack: pushUndo(s, true), lastEditKey: null });
        return res;
      }),

      sendBlock: tableEdit("sendBlock", null, (anchor: M.PasteAnchor, text: string, clearFirst: boolean): M.PasteResult | null => {
        const s = get();
        if (!s.doc) return null;
        const res = M.applyPaste(clearFirst ? M.clearValues(s.doc) : s.doc, anchor, text);
        if (!res) return null;
        const figure = M.followXLabel(M.resizeSeries(s.figure, res.doc.col_titles.length), s.doc.x_title, res.doc.x_title);
        set({ doc: res.doc, figure, undoStack: pushUndo(s, true), lastEditKey: null });
        return res;
      }),

      undo: user("undo", "undo", false, (): boolean => {
        const s = get();
        const prev = s.undoStack[s.undoStack.length - 1];
        if (!prev || !s.doc) return false;
        // An axis label still following the X title goes back with the title.
        const following = M.followXLabel(s.figure, s.doc.x_title, prev.doc.x_title);
        if (prev.whole) {
          set({
            doc: prev.doc, analysis: prev.whole.analysis, figure: prev.whole.figure, scratch: prev.whole.scratch,
            undoStack: s.undoStack.slice(0, -1), lastEditKey: null,
          });
          return true;
        }
        set({
          doc: prev.doc,
          ...(prev.structural ? {
            figure: { ...following, colors: prev.colors, labels: prev.labels, ...prev.palette },
            analysis: { ...s.analysis, control: prev.control, pairs: prev.pairs },
          } : following === s.figure ? {} : { figure: following }),
          undoStack: s.undoStack.slice(0, -1),
          lastEditKey: null,
        });
        return true;
      }),

      setAnalysis: user("analysis", "setAnalysis", undefined, (patch: Partial<GraphAnalysis> | ((a: GraphAnalysis) => GraphAnalysis)) => set((s) => {
        const analysis = typeof patch === "function" ? patch(s.analysis) : { ...s.analysis, ...patch };
        return sameFields(analysis, s.analysis) ? {} : { analysis };
      })),

      setFigure: user("figure", "setFigure", undefined, (patch: Partial<GraphFigure> | ((f: GraphFigure) => GraphFigure)) => set((s) => {
        const figure = typeof patch === "function" ? patch(s.figure) : { ...s.figure, ...patch };
        return sameFields(figure, s.figure) ? {} : { figure };
      })),

      loadFile: ({ file, name, doc, analysis, figure, scratch, saved, inPlace }) => {
        const c = openContent({ doc, analysis, figure, scratch });
        set((s) => ({
          ...c, name, savedName: name, currentId: null, file: { ...file },
          savedSnapshot: saved ? snapshotKey(c) : null, savedScratch: saved ? c.scratch : null,
          undoStack: [], lastEditKey: null,
          docSerial: inPlace ? s.docSerial : s.docSerial + 1, openedAs: saved ? "saved" : "draft", ...NO_GUARD,
        }));
      },

      replaceWorking: (p) => {
        if (!get().doc) return;
        const c = openContent(p);
        set({ ...c, undoStack: [], lastEditKey: null });
      },

      markFileSaved: (file, name, sent, editSerialAtBuild) => set((s) => {
        const untouched = editSerialAtBuild === undefined || editSerialAtBuild === s.editSerial;
        return {
          ...(untouched ? { doc: sent.doc, analysis: sent.analysis, figure: sent.figure, scratch: sent.scratch } : {}),
          name, savedName: name, file: { ...file }, savedSnapshot: snapshotKey(sent), savedScratch: sent.scratch,
        };
      }),

      setFileRef: (patch, name) => set((s) => ({
        file: { ...(s.file ?? { docKey: "", analysisId: null, baseRevision: null, path: null }), ...patch },
        ...(name !== undefined ? { name, savedName: s.savedName === null ? null : name } : {}),
      })),

      replaceContent: (p) => {
        const s0 = get();
        if (!s0.doc || s0.file?.docKey !== p.docKey || s0.file.baseRevision !== p.expectedBase || s0.editSerial !== p.expectedEditSerial) return false;
        const c = openContent({ doc: p.doc, analysis: p.analysis, figure: p.figure, scratch: p.scratch });
        const w = p.working ? openContent(p.working) : null;
        const shown = w ?? c;
        set((s) => {
          // An unchanged scratchpad keeps its identical text, so the Scratchpad's sheet session survives.
          const scratch = shown.scratch === s.scratch ? s.scratch : shown.scratch;
          const undoStack: Snapshot[] = p.undo
            ? [{ ...snap(s, true), whole: { analysis: s.analysis, figure: s.figure, scratch: s.scratch }, label: p.undo.label }]
            : [];
          return {
            doc: shown.doc, analysis: shown.analysis, figure: shown.figure, scratch,
            name: p.name, savedName: p.name, currentId: null, file: { ...p.file },
            savedSnapshot: snapshotKey(c), savedScratch: c.scratch,
            undoStack, lastEditKey: null, openedAs: "saved",
          };
        });
        return true;
      },

      // ── phase 3: read-only guard ──
      setGuard: (g: EditGuard | null) => {
        const cur = get().guard;
        if ((cur?.reason ?? null) === (g?.reason ?? null)) return;
        rawSet({ guard: g ? { reason: g.reason } : null });
      },

      noteBlockedEdit: (path: EditPath, action: string) => rawSet((s) => ({ blocked: nextBlocked(s, path, action) })),

      undoLabel: () => {
        const st = get().undoStack;
        return st.length ? st[st.length - 1].label ?? null : null;
      },
    };
  });
}

export const useGraphStore = createGraphStore();

// ── local persistence (best-effort: storage can be unavailable) ─────────────

const DRAFT_KEY = "las.graph.draft";
const LAST_ID_KEY = "las.graph.lastId";
/** Characters. Covers the largest table (26 groups × 500 rows × 10 replicates
 *  of 8-character values ≈ 1.46 M) while staying under WebKit's ~5 MB
 *  (UTF-16, so ~2.5 M characters) localStorage quota. */
export const DRAFT_LIMIT = 2_000_000;

export interface GraphDraft {
  v: 1;
  name: string;
  currentId: number | null;
  doc: GraphDoc;
  analysis: GraphAnalysis;
  figure: GraphFigure;
  at: number;
  /** Absent in drafts from older versions, and when it didn't fit (status "no_scratch"). */
  scratchpad?: ScratchDoc | null;
  /** The scratchpad had unsaved content but was left out to fit DRAFT_LIMIT: restoring
   *  must not treat it as empty (saving that over the analysis would erase its scratchpad). */
  scratchOmitted?: boolean;
}

/** "saved", or why the draft wasn't kept: "too_large" (over DRAFT_LIMIT) or
 *  "failed" (storage unavailable / quota). An older draft is removed either
 *  way, so a stale one can never be restored. "no_scratch": the draft was kept
 *  without the scratchpad, which alone would have taken it over the limit. */
export type DraftStatus = "saved" | "too_large" | "failed" | "no_scratch";

/** Save the open document's unsaved state as a local draft (best-effort). */
export function writeDraft(s: GraphState): DraftStatus {
  if (!s.doc) return "saved";
  const drop = () => { try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ } };
  try {
    const draft: GraphDraft = { v: 1, name: s.name, currentId: s.currentId, doc: s.doc, analysis: s.analysis, figure: s.figure, at: Date.now() };
    const base = JSON.stringify(draft);
    // The scratchpad is already canonical JSON text: splice it in, no double encoding.
    const full = s.scratch ? `${base.slice(0, -1)},"scratchpad":${s.scratch}}` : base;
    if (full.length <= DRAFT_LIMIT) {
      localStorage.setItem(DRAFT_KEY, full);
      return "saved";
    }
    const lean = s.scratch ? `${base.slice(0, -1)},"scratch_omitted":true}` : base;
    if (s.scratch && lean.length <= DRAFT_LIMIT) {
      localStorage.setItem(DRAFT_KEY, lean);
      return "no_scratch";
    }
    drop();
    return "too_large";
  } catch {
    drop();
    return "failed";
  }
}

export function readDraft(): GraphDraft | null {
  try {
    const text = localStorage.getItem(DRAFT_KEY);
    if (!text) return null;
    const d = JSON.parse(text) as Partial<GraphDraft> & { scratch_omitted?: unknown };
    const doc = M.migrateDoc(d.doc);
    if (!doc) return null;
    return {
      v: 1,
      name: typeof d.name === "string" ? d.name : "",
      currentId: typeof d.currentId === "number" ? d.currentId : null,
      doc,
      analysis: (d.analysis ?? {}) as GraphAnalysis,
      figure: (d.figure ?? {}) as GraphFigure,
      at: typeof d.at === "number" ? d.at : 0,
      scratchpad: (d.scratchpad ?? null) as ScratchDoc | null,
      scratchOmitted: d.scratch_omitted === true,
    };
  } catch {
    return null;
  }
}

export function clearDraft(): void {
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
}

export function readLastId(): number | null {
  try {
    const v = localStorage.getItem(LAST_ID_KEY);
    const n = v === null ? NaN : Number(v);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

export function writeLastId(id: number | null): void {
  try {
    if (id === null) localStorage.removeItem(LAST_ID_KEY);
    else localStorage.setItem(LAST_ID_KEY, String(id));
  } catch { /* ignore */ }
}
