// Phase 3 fix "typed-edit claim": an open editor with typed text (a Scratchpad cell, a number field) is editing in
// progress. Its first keystroke claims (graphStore.beginTyping → the claim hook), so the tab is never made
// read-only in the middle of typing; background flushes (Save, drafts, the read-only check) never try to commit a
// half-typed formula loudly; a pristine editor may still be closed by read-only.
//
// The bug this reproduces (exp-0.2.25): "=SUM(" typed in a Scratchpad cell (not committed), another computer starts
// editing → the controller's read-only check flushed the Scratchpad with commitEdit → the formula was refused, the
// "There's a problem with this formula" alert came up, the guard was set, and the grid closed the editor: the text
// was lost although the person was typing. `LegacySheet` below models that old Scratchpad behaviour exactly (no
// typing report, a loud commit on every flush, every open edit closed by read-only); `Sheet` is the fixed one,
// built from the real openEdit.ts rules over a real SheetSession.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { initSync } from "@ironcalc/wasm";
import { createGraphStore, isDirty, type GraphStoreApi } from "../../../store/graphStore";
import { closeBrackets } from "../scratchpad/formulaEdit";
import { TypingReporter, backgroundCommit, editTyped, type OpenEdit } from "../scratchpad/openEdit";
import { SheetSession } from "../scratchpad/sheetSession";
import { LIMITS_P2, LIMITS_P3 } from "./contract";
import { activeTab, editCell, flush, group, guardOf, modeOf, notesOf, tick, type Computer, type Group } from "./testkit";

vi.setConfig({ testTimeout: 60_000 });

type Fs = { readFileSync(p: string): Uint8Array };
type NodeModule = { createRequire(url: string): { resolve(id: string): string } };
const nodeMod = async <T>(name: string): Promise<T> => (await import(/* @vite-ignore */ name)) as T;

beforeAll(async () => {
  const fs = await nodeMod<Fs>("node:fs");
  const { createRequire } = await nodeMod<NodeModule>("node:module");
  initSync({ module: fs.readFileSync(createRequire(import.meta.url).resolve("@ironcalc/wasm/wasm_bg.wasm")) });
});

const S = 1000, MIN = 60 * S;
const sync = (g: Group, extra = 500) => tick(g.w, 2 * g.delay + extra);

/** The Scratchpad as the app runs it (ScratchpadTab + SheetGrid), on a real SheetSession. */
class Sheet {
  session = new SheetSession("");
  ed: OpenEdit | null = null;
  /** Formula-problem alerts shown (ScratchpadTab's notice). */
  alerts: string[] = [];
  private version = this.session.version;
  private typing: TypingReporter;

  constructor(readonly graph: GraphStoreApi, readonly legacy = false) {
    this.typing = new TypingReporter((typed) => {
      if (this.legacy) return;   // exp-0.2.25 reported nothing
      const st = this.graph.getState();
      if (typed) st.beginTyping("scratchpad"); else st.endTyping("scratchpad");
    });
    // SheetGrid's read-only effect.
    graph.subscribe((s, prev) => {
      if (!s.guard || prev.guard || !this.ed) return;
      if (this.legacy || !editTyped(this.session, this.ed)) this.setEdit(null);
    });
  }

  private setEdit(e: OpenEdit | null) { this.ed = e; this.typing.update(this.session, e); }

  /** F2 / double-click / focusing the formula bar: an editor with the cell's own text. */
  open(r: number, c: number) {
    if (this.graph.getState().guard) return;
    this.setEdit({ r, c, text: this.session.input(r, c) });
  }

  /** Keystrokes: the first one on a selected cell opens the editor with it. */
  type(text: string, r = 1, c = 1) {
    if (!this.ed && this.graph.getState().guard) return;
    this.setEdit(this.ed ? { ...this.ed, text: this.ed.text + text } : { r, c, text });
  }

  escape() { this.setEdit(null); }

  /** A typed edit parked by leaving the Scratchpad tab (ViewMemo.edit, fixer V-1). */
  parked: OpenEdit | null = null;
  /** Commits made by flushes (not by the person's Enter) while an editor held typed text. */
  flushCommits: string[] = [];

  /** Leaving the Scratchpad tab (ScratchpadTab's unmount → SheetGrid.park, then writeStore / endTyping). */
  leave() {
    const out = backgroundCommit(this.session, this.ed);
    if (out.kind === "committed") this.setEdit(null);
    else if (out.kind === "kept" && !this.legacy) { this.parked = this.ed; this.ed = null; this.typing.detach(); }
    else this.setEdit(null);   // exp-0.2.25 / pristine: the editor is gone with the grid
    this.writeStore();
    if (!this.parked) this.graph.getState().endTyping("scratchpad");
  }

  /** Back on the Scratchpad tab (same session): a parked edit opens again and is typing again. */
  back() {
    const ed = this.parked;
    this.parked = null;
    this.ed = ed;
    this.typing.update(this.session, ed);
  }

  /** The person's own Enter: refused entries raise the alert and stay open. */
  enter(): boolean {
    const ed = this.ed;
    if (!ed) return true;
    this.session.readOnly = !!this.graph.getState().guard;
    const res = this.session.setInput(ed.r, ed.c, closeBrackets(ed.text));
    if (!res.ok) { if (res.reason !== "readonly") this.alerts.push(res.message); return false; }
    this.setEdit(null);
    this.writeStore();
    return true;
  }

  /** ScratchController.flush (the file controller's deps.flushScratch). */
  flush(commitEdit: boolean) {
    // exp-0.2.25's controller flushed with commitEdit before making the tab read-only (the fixed one no longer
    // does, fixer V-3): the legacy model commits on every flush to reproduce that.
    if (commitEdit || this.legacy) {
      if (this.legacy) this.enter();   // exp-0.2.25: gridRef.commitEdit() — the person's commit, alert included
      else {
        const typed = this.ed?.text ?? "";
        const out = backgroundCommit(this.session, this.ed);
        if (out.kind === "committed") { this.flushCommits.push(typed); this.setEdit(null); }
      }
    }
    this.writeStore();
  }

  private writeStore() {
    const st = this.graph.getState();
    if (st.guard || this.session.version === this.version) return;
    this.version = this.session.version;
    st.setScratch(this.session.serialize());
  }
}

/** Two computers (A "Mac mini", B "MacBook") with the file open; B's Scratchpad is a `Sheet`. In most tests A
 *  starts editing inside the sync delay (B's note has not reached it yet), as "Start editing there" does in the
 *  preview's simulator: otherwise A would see B's claim and be read-only itself. */
async function setup(legacy = false, users = ["Alice", "Zhuo"]): Promise<{ g: Group; a: Computer; b: Computer; sheet: () => Sheet }> {
  let sheet: Sheet | null = null;
  const g = await group(2, {
    users,
    deps: [{}, { flushScratch: (o) => sheet?.flush(!!o?.commitEdit) }],
  });
  const [a, b] = g.cs;
  sheet = new Sheet(b.graph, legacy);
  await sync(g);
  expect(guardOf(b)).toBe(null);
  expect(notesOf(b.dev, g.path, "d-b2b2")[0].note!.state).toBe("idle");
  return { g, a, b, sheet: () => sheet! };
}

describe("the bug: a half-typed formula when another computer starts editing", () => {
  it("exp-0.2.25 behaviour (LegacySheet): alert, read-only, the typed text lost", async () => {
    const { g, a, b, sheet } = await setup(true);
    sheet().type("=SUM(");
    await flush();
    await editCell(a, "A1");
    await sync(g);
    expect(sheet().alerts).toEqual([expect.stringMatching(/problem with this formula/i)]);
    expect(guardOf(b)).toBe("editingElsewhere");
    expect(sheet().ed).toBe(null);
    expect(notesOf(b.dev, g.path, "d-b2b2")[0].note!.state).toBe("idle");
  });

  it("fixed: the first keystroke claims; B stays editable (both editing), no alert, the text stays in its editor", async () => {
    const { g, a, b, sheet } = await setup();
    sheet().type("=");
    await flush();
    // The first keystroke claimed: B's note says editing although nothing is committed and the tab is clean.
    expect(notesOf(b.dev, g.path, "d-b2b2")[0].note!.state).toBe("editing");
    expect(isDirty(b.graph.getState())).toBe(false);
    expect(activeTab(b).dirty).toBe(false);
    sheet().type("SUM(");
    await editCell(a, "A1");
    await sync(g);
    expect(guardOf(b)).toBe(null);
    expect(modeOf(b)).toBe("bothEditing");
    expect(modeOf(a)).toBe("bothEditing");   // the other computer sees "also being edited"
    expect(sheet().alerts).toEqual([]);
    expect(sheet().ed).toMatchObject({ r: 1, c: 1, text: "=SUM(" });
    // Still typing: it finishes the formula and commits it with Enter.
    sheet().type("2,3)");
    expect(sheet().enter()).toBe(true);
    await flush();
    expect(sheet().session.display(1, 1)).toBe("5");
    expect(isDirty(b.graph.getState())).toBe(true);
    expect(guardOf(b)).toBe(null);
  });

  it("a long pause in the middle of a formula, then my other computer presses Edit here: B keeps editing (past the 30 s linger)", async () => {
    const { g, a, b, sheet } = await setup(false, ["Zhuo", "Zhuo"]);
    sheet().type("=SUM(");
    await flush();
    await tick(g.w, 3 * MIN, 1000);
    expect(notesOf(b.dev, g.path, "d-b2b2")[0].note!.state).toBe("editing");
    expect(guardOf(a)).toBe("editingElsewhere");
    expect(await a.ses.getState().editHere()).toBe(true);
    await editCell(a, "A1");
    await sync(g);
    expect(guardOf(b)).toBe(null);
    expect(modeOf(b)).toBe("bothEditing");
    expect(activeTab(b).presence!.mine).toBe("editing");
    expect(sheet().ed?.text).toBe("=SUM(");
    // Escape: nothing was changed; the clean tab's hold ends 30 s after its last input → read-only (A is editing).
    sheet().escape();
    expect(b.graph.getState().typing).toEqual([]);
    await tick(g.w, LIMITS_P3.lingerMs + 2 * g.delay + 2 * S, 1000);
    expect(notesOf(b.dev, g.path, "d-b2b2")[0].note!.state).toBe("idle");
    expect(guardOf(b)).toBe("editingElsewhere");
  });
});

describe("background flushes never commit an incomplete formula loudly", () => {
  it("Save and the draft backup leave '=SUM(' in its editor with no alert; a complete one is committed", async () => {
    const { b, sheet } = await setup();
    sheet().type("=SUM(");
    await flush();
    await b.ses.getState().save();
    await b.ses.internal.flushDraftNow();
    await flush();
    expect(sheet().alerts).toEqual([]);
    expect(sheet().ed?.text).toBe("=SUM(");
    expect(b.graph.getState().typing).toEqual(["scratchpad"]);
    // A complete formula is written by the flush (Save), the editor closes.
    sheet().escape();
    sheet().type("=2*3", 2, 1);
    await b.ses.getState().save();
    await flush();
    expect(sheet().ed).toBe(null);
    expect(sheet().session.display(2, 1)).toBe("6");
    expect(b.graph.getState().scratch).toContain("=2*3");
    expect(isDirty(b.graph.getState())).toBe(false);
    expect(sheet().alerts).toEqual([]);
  });

  it("a complete formula typed (not committed) when the other computer starts editing: claimed, then saved by Save", async () => {
    const { g, a, b, sheet } = await setup();
    sheet().type("=1+1");
    await flush();
    await editCell(a, "A1");
    await sync(g);
    expect(guardOf(b)).toBe(null);
    expect(modeOf(b)).toBe("bothEditing");
    expect(sheet().ed?.text).toBe("=1+1");
    await b.ses.getState().save();
    await flush();
    expect(sheet().ed).toBe(null);
    expect(sheet().session.display(1, 1)).toBe("2");
    expect(sheet().alerts).toEqual([]);
  });
});

describe("a pristine editor may be closed by read-only", () => {
  it("F2 on a cell, nothing typed, the other computer starts editing → read-only, the editor closed, no claim, no alert", async () => {
    const { g, a, b, sheet } = await setup();
    sheet().open(1, 1);
    await flush();
    expect(b.graph.getState().typing).toEqual([]);
    expect(notesOf(b.dev, g.path, "d-b2b2")[0].note!.state).toBe("idle");
    await editCell(a, "A1");
    await sync(g);
    expect(guardOf(b)).toBe("editingElsewhere");
    expect(sheet().ed).toBe(null);
    expect(sheet().alerts).toEqual([]);
    expect(b.graph.getState().blocked).toBe(null);
  });

  it("a typed editor that read-only reaches anyway (after sleep: resuming) keeps its text", async () => {
    const { g, b, sheet } = await setup();
    // Unsaved change + typing, then the computer sleeps: the after-sleep guard (resuming) comes.
    b.graph.getState().setCell(0, 0, 0, "x");
    sheet().type("=SUM(");
    await flush();
    await tick(g.w, 5 * S);
    b.dev.sleep(5 * MIN);
    await tick(g.w, 5 * MIN + 2 * S, 1000);
    expect(guardOf(b)).toBe("resuming");
    expect(sheet().ed?.text).toBe("=SUM(");
    expect(sheet().alerts).toEqual([]);
  });
});

describe("other fields", () => {
  it("Data grid (writes every keystroke): typing claims, the other computer's edit gives both editing", async () => {
    const { g, a, b } = await setup();
    b.graph.getState().setCell(3, 0, 0, "4");
    await flush();
    expect(notesOf(b.dev, g.path, "d-b2b2")[0].note!.state).toBe("editing");
    await editCell(a, "A1");
    await sync(g);
    expect(guardOf(b)).toBe(null);
    expect(modeOf(b)).toBe("bothEditing");
    b.graph.getState().setCell(3, 0, 0, "4.5");
    expect(b.graph.getState().doc!.cells[3][0][0]).toBe("4.5");
  });

  it("a number field typed into (not committed): claims, never read-only; its value is committed afterwards", async () => {
    const { g, a, b } = await setup();
    b.graph.getState().beginTyping("figure:width");   // NumberField's onTyping(true)
    await flush();
    expect(notesOf(b.dev, g.path, "d-b2b2")[0].note!.state).toBe("editing");
    expect(isDirty(b.graph.getState())).toBe(false);
    await editCell(a, "A1");
    await sync(g);
    expect(guardOf(b)).toBe(null);
    expect(modeOf(b)).toBe("bothEditing");
    b.graph.getState().endTyping("figure:width");     // blur → commit
    b.graph.getState().setFigure({ width: 1200 });
    expect(b.graph.getState().figure.width).toBe(1200);
  });

  it("newer content waits while an editor holds typed text (a clean tab is not replaced under the editor)", async () => {
    const { g, a, b, sheet } = await setup();
    sheet().type("=SUM(");
    await flush();
    await editCell(a, "from A");
    await a.ses.getState().save();
    await sync(g, 2 * S);
    expect(b.graph.getState().doc!.cells[0][0][0]).not.toBe("from A");
    expect(sheet().ed?.text).toBe("=SUM(");
    sheet().escape();
    await tick(g.w, LIMITS_P2.replaceRetryMs * 4, 250);
    expect(b.graph.getState().doc!.cells[0][0][0]).toBe("from A");
  });
});

describe("graph store: beginTyping / endTyping", () => {
  const loaded = () => {
    const st = createGraphStore();
    st.getState().newDoc("column", true);
    return st;
  };

  it("bumps userEditSerial on every keystroke; no content change, no undo step, not unsaved", () => {
    const st = loaded();
    const s0 = st.getState();
    expect(st.getState().beginTyping("scratchpad")).toBe(true);
    expect(st.getState().beginTyping("scratchpad")).toBe(true);
    const s1 = st.getState();
    expect(s1.userEditSerial).toBe(s0.userEditSerial + 2);
    expect(s1.editSerial).toBe(s0.editSerial);
    expect(s1.undoStack).toBe(s0.undoStack);
    expect(s1.typing).toEqual(["scratchpad"]);
    expect(isDirty(s1)).toBe(false);
    st.getState().beginTyping("figure:width");
    st.getState().endTyping("scratchpad");
    expect(st.getState().typing).toEqual(["figure:width"]);
    st.getState().endTyping("nope");
    expect(st.getState().typing).toEqual(["figure:width"]);
  });

  it("under a guard: the owner is recorded, nothing bumped, nothing reported", () => {
    const st = loaded();
    st.getState().setGuard({ reason: "editingElsewhere" });
    const s0 = st.getState();
    expect(st.getState().beginTyping("scratchpad")).toBe(false);
    expect(st.getState().userEditSerial).toBe(s0.userEditSerial);
    expect(st.getState().blocked).toBe(null);
    expect(st.getState().typing).toEqual(["scratchpad"]);
  });

  it("no document: refused; another document: forgotten; a reload in place keeps it", () => {
    const st = createGraphStore();
    expect(st.getState().beginTyping("scratchpad")).toBe(false);
    st.getState().newDoc("column", true);
    st.getState().beginTyping("scratchpad");
    const doc = st.getState().doc!;
    const file = { docKey: "k", analysisId: "a", baseRevision: "r", path: "/p.lag" };
    st.getState().loadFile({ file, name: "p", doc, saved: true, inPlace: true });
    expect(st.getState().typing).toEqual(["scratchpad"]);
    st.getState().loadFile({ file, name: "p", doc, saved: true });
    expect(st.getState().typing).toEqual([]);
    st.getState().beginTyping("scratchpad");
    st.getState().close();
    expect(st.getState().typing).toEqual([]);
  });
});

describe("openEdit rules", () => {
  it("backgroundCommit: none / pristine / committed / kept, never touching a refused entry", () => {
    const s = new SheetSession("");
    expect(s.setInput(1, 1, "7").ok).toBe(true);
    expect(backgroundCommit(s, null)).toEqual({ kind: "none" });
    expect(backgroundCommit(s, { r: 1, c: 1, text: "7" })).toEqual({ kind: "pristine" });
    const before = s.serialize();
    const kept = backgroundCommit(s, { r: 2, c: 1, text: "=SUM(" });
    expect(kept.kind).toBe("kept");
    expect(s.serialize()).toBe(before);
    expect(backgroundCommit(s, { r: 2, c: 1, text: "=A1*2" }).kind).toBe("committed");
    expect(s.display(2, 1)).toBe("14");
  });

  it("TypingReporter: true per keystroke, false once when the text is the cell's again or the edit closes", () => {
    const s = new SheetSession("");
    expect(s.setInput(1, 1, "a").ok).toBe(true);
    const log: boolean[] = [];
    const t = new TypingReporter((x) => log.push(x));
    t.update(s, { r: 1, c: 1, text: "a" });        // pristine (F2)
    t.update(s, { r: 1, c: 1, text: "ab" });
    t.update(s, { r: 1, c: 1, text: "ab" });       // mode / origin change only
    t.update(s, { r: 1, c: 1, text: "abc" });
    t.update(s, { r: 1, c: 1, text: "a" });        // typed back
    t.update(s, null);
    t.end();
    expect(log).toEqual([true, true, false]);
  });
});

// ── fixer round (verifier V-1 … V-3) ────────────────────────────────────────

describe("fixer V-1: leaving the Scratchpad tab with a half-typed formula", () => {
  it("the entry is parked, not lost: back on the tab it is open again with its text, still typing (claimed)", async () => {
    const { g, a, b, sheet } = await setup();
    sheet().type("=SUM(", 3, 2);
    await flush();
    sheet().leave();   // e.g. the Data tab
    expect(sheet().ed).toBe(null);
    expect(b.graph.getState().typing).toEqual(["scratchpad"]);
    expect(sheet().alerts).toEqual([]);
    // Away from the Scratchpad, the other computer starts editing: B is still editing (both editing).
    await editCell(a, "A1");
    await sync(g);
    expect(guardOf(b)).toBe(null);
    expect(modeOf(b)).toBe("bothEditing");
    sheet().back();
    expect(sheet().ed).toEqual({ r: 3, c: 2, text: "=SUM(" });
    sheet().type("1,2)");
    expect(sheet().enter()).toBe(true);
    expect(sheet().session.display(3, 2)).toBe("3");
    expect(b.graph.getState().typing).toEqual([]);
  });

  it("exp-0.2.25 (LegacySheet): leaving the tab dropped the entry", async () => {
    const { sheet } = await setup(true);
    sheet().type("=SUM(", 3, 2);
    sheet().leave();
    sheet().back();
    expect(sheet().ed).toBe(null);
    expect(sheet().session.input(3, 2)).toBe("");
  });

  it("a complete entry is committed by leaving the tab (as before); a pristine editor just closes", async () => {
    const { b, sheet } = await setup();
    sheet().type("=2*3", 1, 1);
    sheet().leave();
    expect(sheet().session.display(1, 1)).toBe("6");
    expect(sheet().parked).toBe(null);
    expect(b.graph.getState().typing).toEqual([]);
    sheet().back();
    sheet().open(1, 1);
    sheet().leave();
    expect(sheet().parked).toBe(null);
    expect(b.graph.getState().typing).toEqual([]);
  });
});

describe("fixer V-2: waking from sleep with an entry typed (not committed)", () => {
  it("a valid entry is not committed by the after-sleep check: the editor stays open and editable; Enter commits after the guard", async () => {
    const { g, a, b, sheet } = await setup();
    sheet().type("12", 5, 2);
    await flush();
    await editCell(a, "A1");
    await sync(g);
    expect(modeOf(b)).toBe("bothEditing");
    b.dev.sleep(3 * MIN);
    await tick(g.w, 3 * MIN + 2 * S, 1000);
    expect(guardOf(b)).toBe("resuming");
    expect(sheet().ed).toEqual({ r: 5, c: 2, text: "12" });
    expect(sheet().session.input(5, 2)).toBe("");   // exp-0.2.25 + first fix: "12" committed, the editor closed
    expect(sheet().flushCommits).toEqual([]);
    // The next key goes into the open editor (no "Keep editing?" question for it).
    sheet().type("3");
    expect(sheet().ed?.text).toBe("123");
    expect(b.ses.getState().dialog).toBe(null);
    await tick(g.w, LIMITS_P3.resumeMs + 2 * S, 1000);
    expect(guardOf(b)).toBe(null);
    expect(sheet().enter()).toBe(true);
    await flush();
    expect(sheet().session.display(5, 2)).toBe("123");
    expect(isDirty(b.graph.getState())).toBe(true);
    expect(sheet().alerts).toEqual([]);
  });
});

describe("fixer V-3: automatic flushes leave a typed entry alone", () => {
  it("two computers save at once with B typing '=SUM(A1' afterwards: the combine nobody asked for never commits it", async () => {
    const { g, a, b, sheet } = await setup(false, ["Zhuo", "Zhuo"]);
    await editCell(a, "A!", 1, 0);
    await editCell(b, "B!", 2, 0);
    await a.ses.getState().save();
    await b.ses.getState().save();
    sheet().type("=SUM(A1", 1, 3);
    await flush();
    for (let k = 0; k < 4; k++) await sync(g, 2 * S);
    expect(sheet().flushCommits).toEqual([]);
    expect(sheet().ed?.text).toBe("=SUM(A1");
    expect(sheet().alerts).toEqual([]);
    expect(guardOf(b)).toBe(null);
    // Done typing: Enter commits the formula; nothing of either save is lost.
    sheet().type(":A5)");
    expect(sheet().enter()).toBe(true);
    for (let k = 0; k < 4; k++) await sync(g, 2 * S);
    expect(sheet().session.input(1, 3)).toBe("=SUM(A1:A5)");
  });
});
