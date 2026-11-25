/* The small part of the Scratchpad that lives in the main bundle: a handle the
   lazily loaded tab registers, so the rest of the Graphs tool (save, the
   unsaved-changes guard, the draft backup, the rail buttons) can reach it
   without importing the formula engine. */

import { create } from "zustand";

export interface ScratchController {
  /** Write pending changes into the graph store; with `commitEdit`, first commit an open cell edit the way a
   *  commit the person did not ask for does (openEdit.ts): typed text the sheet accepts is written, a refused
   *  entry (a half-typed formula) stays in its editor with no alert, a pristine editor is left alone. */
  flush(commitEdit: boolean): void;
  /** Copy the selection's displayed values (TSV) to the clipboard. */
  copy(): void;
  /** Open the "Send selection to Data" dialog. */
  openSend(): void;
  /** Clear every cell (one undo step). */
  clearAll(): void;
  focus(): void;
}

let controller: ScratchController | null = null;

export function registerScratchController(c: ScratchController | null): void {
  controller = c;
}

export const scratchController = (): ScratchController | null => controller;

/** Make the store's `scratch` current (no-op when the Scratchpad was never opened).
 *  `commitEdit` (save, close, the unsaved-changes guard, the person's own combine) also commits a cell being
 *  typed in when it can be committed (never an alert: see ScratchController.flush); the background draft
 *  backup, the read-only / after-sleep checks and the automatic combine leave an open editor alone. */
export function flushScratch(opts: { commitEdit?: boolean } = {}): void {
  try { controller?.flush(!!opts.commitEdit); } catch { /* the sheet must never block a save */ }
}

export interface ScratchUi {
  /** The engine is loaded and the sheet is on screen. */
  ready: boolean;
  /** Selection, e.g. "B2:D9" (with rows × columns). */
  sel: string;
  selRows: number;
  selCols: number;
  /** Non-empty cells. */
  cells: number;
  /** Too large to save (over SCRATCH_LIMIT). */
  over: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

export const useScratchUi = create<ScratchUi>(() => ({
  ready: false, sel: "A1", selRows: 1, selCols: 1, cells: 0, over: false, canUndo: false, canRedo: false,
}));
