/* The Scratchpad's open cell edit and the rest of the app (phase 3 fix "typed-edit claim").

   An open editor whose text differs from what the cell holds is editing in progress: its first keystroke
   claims the analysis (graphStore.beginTyping → the file controller's claim hook), so this computer is never
   made read-only while someone is typing, however long ago the last key came.

   Commits the person did not ask for in the sheet (Save, Save As, Close, the draft backup, leaving a tab) are
   "background" commits: they write an entry that can be written and leave one that can't (a half-typed
   "=SUM(") in its editor, without a message. Only the person's own Enter / Tab / click commit shows the
   "There's a problem with this formula" alert. Commits nobody asked for at all (the automatic combine, the
   read-only and after-sleep checks) don't touch a typed editor (fixer V-2, V-3: flushScratch commitEdit false).
   Leaving the Scratchpad tab parks a typed editor the sheet refused (ViewMemo.edit, fixer V-1): it is open again,
   with its text, when the Scratchpad comes back for the same document. Pure TypeScript (no React), shared by SheetGrid and the tests. */

import { closeBrackets } from "./formulaEdit";
import type { EditResult, SheetSession } from "./sheetSession";

/** The part of the grid's edit state these rules need. */
export interface OpenEdit { r: number; c: number; text: string }

/** The editor holds typed text: it differs from what the cell holds now. An editor opened with F2, a
 *  double-click or by focusing the formula bar is pristine until a keystroke changes its text. */
export const editTyped = (session: SheetSession, ed: OpenEdit | null): boolean =>
  !!ed && ed.text !== session.input(ed.r, ed.c);

/** What a background commit did with the open edit:
 *  - `none`: no edit was open;
 *  - `pristine`: nothing typed — nothing written, the editor is left as it is (a read-only guard may close it);
 *  - `committed`: written (`res` is the session's ok result; the editor closes);
 *  - `kept`: refused (an incomplete formula, the sheet is full, read-only): nothing written, no message, the
 *    editor stays open with its text. `res` is the refusal (the caller still handles `fatal`). */
export type BackgroundCommit =
  | { kind: "none" }
  | { kind: "pristine" }
  | { kind: "committed"; res: EditResult & { ok: true } }
  | { kind: "kept"; res: EditResult & { ok: false } };

/** Commit the open edit on the person's behalf (see the file comment). */
export function backgroundCommit(session: SheetSession, ed: OpenEdit | null): BackgroundCommit {
  if (!ed) return { kind: "none" };
  if (!editTyped(session, ed)) return { kind: "pristine" };
  const res = session.setInput(ed.r, ed.c, closeBrackets(ed.text));
  return res.ok ? { kind: "committed", res } : { kind: "kept", res };
}

/** Tells the graph store whether the open edit holds typed text: `report(true)` on every keystroke that leaves
 *  the text different from the cell (each one is input for the file controller), `report(false)` once when that
 *  ends (committed, cancelled, closed, typed back to the cell's text, the grid unmounted). */
export class TypingReporter {
  private last: string | null = null;
  private readonly report: (typed: boolean) => void;

  constructor(report: (typed: boolean) => void) { this.report = report; }

  /** After every change of the edit state. */
  update(session: SheetSession, ed: OpenEdit | null): void {
    if (ed && editTyped(session, ed)) {
      if (this.last === ed.text) return;   // a mode / origin change: not a keystroke
      this.last = ed.text;
      this.report(true);
      return;
    }
    this.end();
  }

  /** The edit is parked (the grid unmounts and keeps it for its next mount, fixer V-1): forget it without
   *  reporting, so the typing stays recorded in the graph store while the Scratchpad is away. */
  detach(): void { this.last = null; }

  /** The edit is gone (or pristine). */
  end(): void {
    if (this.last === null) return;
    this.last = null;
    this.report(false);
  }

  get typed(): boolean { return this.last !== null; }
}
