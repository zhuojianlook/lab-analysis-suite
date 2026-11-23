// Phase 3 contract §4.1 / §4.3: the read-only guard of the graph store (G1–G3) and the claim hook's
// userEditSerial (G2). Every user action is a no-op under each guard reason and is reported; loads,
// reloads in place, the clean-up, markFileSaved and setFileRef never count as the person's edits.
import { describe, expect, it } from "vitest";
import type { GraphDoc } from "../api/graph";
import type { EditGuardReason, EditPath } from "../components/graph/file/contract";
import { createGraphStore, isDirty, openContent, type FileRef, type GraphState, type GraphStoreApi } from "./graphStore";

const REASONS: EditGuardReason[] = ["tooNew", "editingElsewhere", "waiting", "checking", "resuming"];

const tableDoc = (template: GraphDoc["template"] = "grouped"): GraphDoc => ({
  v: 1, template, col_titles: ["A", "B"], row_titles: ["r1", "r2", "r3"], x_title: "X", n_rep: 2,
  x: ["1", "2", "3"],
  cells: [[["1", "2"], ["3", "4"]], [["5", "6"], ["7", "8"]], [["9", ""], ["", "1"]]],
} as unknown as GraphDoc);

const FILE: FileRef = { docKey: "t1", analysisId: "a-1", baseRevision: "r-1", path: "/x/Dose.lag" };

function opened(template: GraphDoc["template"] = "grouped"): GraphStoreApi {
  const st = createGraphStore();
  st.getState().loadFile({ file: FILE, name: "Dose", doc: tableDoc(template), saved: true,
    scratch: { v: 1, cells: [[1, 1, "5"]] } });
  return st;
}

/** A store with one undo step, so `undo` has something it could undo. */
function withHistory(template: GraphDoc["template"] = "grouped"): GraphStoreApi {
  const st = opened(template);
  st.getState().setCell(0, 0, 0, "42");
  return st;
}

/** Content and bookkeeping a refused action must leave exactly as it was. */
const frozen = (s: GraphState) => JSON.stringify({
  doc: s.doc, analysis: s.analysis, figure: s.figure, scratch: s.scratch, name: s.name,
  editSerial: s.editSerial, userEditSerial: s.userEditSerial, undo: s.undoStack.length, lastEditKey: s.lastEditKey,
  dirty: isDirty(s), file: s.file, savedSnapshot: s.savedSnapshot,
});

/** Every user action of the §4.1 table, with arguments that change something when there is no guard. */
const ACTIONS: { action: string; path: EditPath; run: (s: GraphState) => unknown; nothing: unknown }[] = [
  { action: "setCell", path: "table", run: (s) => s.setCell(1, 1, 0, "99"), nothing: undefined },
  { action: "setX", path: "table", run: (s) => s.setX(0, "7"), nothing: undefined },
  { action: "setRowTitle", path: "table", run: (s) => s.setRowTitle(0, "first"), nothing: undefined },
  { action: "setColTitle", path: "table", run: (s) => s.setColTitle(0, "Ctrl"), nothing: undefined },
  { action: "setXTitle", path: "table", run: (s) => s.setXTitle("Dose"), nothing: undefined },
  { action: "setNRep", path: "table", run: (s) => s.setNRep(3), nothing: undefined },
  { action: "insertCol", path: "table", run: (s) => s.insertCol(1), nothing: undefined },
  { action: "deleteCol", path: "table", run: (s) => s.deleteCol(1), nothing: undefined },
  { action: "clearCol", path: "table", run: (s) => s.clearCol(0), nothing: undefined },
  { action: "insertRow", path: "table", run: (s) => s.insertRow(1), nothing: undefined },
  { action: "deleteRow", path: "table", run: (s) => s.deleteRow(0), nothing: undefined },
  { action: "clearRow", path: "table", run: (s) => s.clearRow(0), nothing: undefined },
  { action: "paste", path: "table", run: (s) => s.paste({ row: 0, fc: 1 }, "1\t2\n3\t4"), nothing: null },
  { action: "sendBlock", path: "table", run: (s) => s.sendBlock({ row: 0, fc: 1 }, "1\t2\n3\t4", true), nothing: null },
  { action: "setAnalysis", path: "analysis", run: (s) => s.setAnalysis({ alpha: 0.01 }), nothing: undefined },
  { action: "setFigure", path: "figure", run: (s) => s.setFigure({ title: "New title" }), nothing: undefined },
  { action: "setScratch", path: "scratchpad", run: (s) => s.setScratch('{"v":1,"cells":[[1,1,"6"]]}'), nothing: undefined },
  { action: "setName", path: "name", run: (s) => s.setName("Renamed"), nothing: undefined },
  { action: "undo", path: "undo", run: (s) => s.undo(), nothing: false },
];

describe("G1: every user action is refused under a guard", () => {
  for (const reason of REASONS) {
    for (const a of ACTIONS) {
      it(`${a.action} under "${reason}"`, () => {
        const st = withHistory();
        st.getState().setGuard({ reason });
        const before = frozen(st.getState());
        const serial = st.getState().blocked?.serial ?? 0;
        const out = a.run(st.getState());
        expect(out).toBe(a.nothing);
        expect(frozen(st.getState())).toBe(before);
        expect(st.getState().blocked).toEqual({ serial: serial + 1, path: a.path, action: a.action });
      });
    }
  }

  it("each refusal gets the next serial", () => {
    const st = withHistory();
    st.getState().setGuard({ reason: "editingElsewhere" });
    st.getState().setCell(0, 0, 0, "1");
    st.getState().setFigure({ title: "x" });
    st.getState().noteBlockedEdit("scratchpad", "type");
    expect(st.getState().blocked).toEqual({ serial: 3, path: "scratchpad", action: "type" });
  });

  it("setScratch with the text it already has is neither applied nor reported", () => {
    const st = opened();
    st.getState().setGuard({ reason: "editingElsewhere" });
    st.getState().setScratch(st.getState().scratch);
    expect(st.getState().blocked).toBeNull();
  });

  it("without a guard each action applies (the arguments above really change something)", () => {
    for (const a of ACTIONS) {
      const st = withHistory();
      const before = frozen(st.getState());
      a.run(st.getState());
      expect(frozen(st.getState()), a.action).not.toBe(before);
      expect(st.getState().blocked, a.action).toBeNull();
    }
  });

  it("an empty store refuses nothing it would not have done anyway", () => {
    const st = createGraphStore();
    st.getState().setGuard({ reason: "waiting" });
    expect(st.getState().paste({ row: 0, fc: 0 }, "1\t2")).toBeNull();
    expect(st.getState().blocked?.action).toBe("paste");
  });
});

describe("G2: userEditSerial — the claim hook", () => {
  it("grows by exactly one for each applied user action", () => {
    for (const a of ACTIONS) {
      const st = withHistory();
      const u0 = st.getState().userEditSerial;
      a.run(st.getState());
      expect(st.getState().userEditSerial, a.action).toBe(u0 + 1);
    }
  });

  it("several keystrokes in one cell: one per keystroke, one undo step", () => {
    const st = opened();
    const u0 = st.getState().userEditSerial;
    st.getState().setCell(0, 0, 0, "4");
    st.getState().setCell(0, 0, 0, "42");
    st.getState().setCell(0, 0, 0, "421");
    expect(st.getState().userEditSerial).toBe(u0 + 3);
    expect(st.getState().undoStack.length).toBe(1);
  });

  it("an action that changes nothing does not count", () => {
    const st = opened();
    const u0 = st.getState().userEditSerial;
    st.getState().undo();                                   // empty stack
    st.getState().setFigure({ title: st.getState().figure.title });
    st.getState().setAnalysis({ alpha: st.getState().analysis.alpha });
    st.getState().setScratch(st.getState().scratch);
    st.getState().setName(st.getState().name);
    expect(st.getState().userEditSerial).toBe(u0);
  });

  it("never for loads, reloads in place, the clean-up, saves, path changes or the guard itself", () => {
    const st = withHistory();
    const s = () => st.getState();
    const u0 = s().userEditSerial;
    const c = openContent({ doc: tableDoc(), scratch: null });
    const steps: [string, () => void][] = [
      ["newDoc", () => s().newDoc("column", true)],
      ["load", () => s().load({ doc: tableDoc(), name: "L", id: null, saved: true })],
      ["loadFile", () => s().loadFile({ file: FILE, name: "Dose", doc: tableDoc(), saved: true })],
      ["loadFile inPlace", () => s().loadFile({ file: FILE, name: "Dose", doc: tableDoc("xy"), saved: false, inPlace: true })],
      ["replaceWorking", () => s().replaceWorking({ doc: tableDoc("column") })],
      ["replaceContent", () => {
        const ok = s().replaceContent({ docKey: FILE.docKey, expectedBase: FILE.baseRevision, expectedEditSerial: s().editSerial,
          file: { ...FILE, baseRevision: "r-2" }, name: "Dose", doc: tableDoc() });
        expect(ok).toBe(true);
      }],
      ["replaceContent working + undo", () => {
        const ok = s().replaceContent({ docKey: FILE.docKey, expectedBase: "r-2", expectedEditSerial: s().editSerial,
          file: { ...FILE, baseRevision: "r-3" }, name: "Dose", doc: tableDoc(), undo: { label: "Undo: combine" },
          working: { doc: tableDoc("xy"), scratch: '{"v":1,"cells":[[2,2,"x"]]}' } });
        expect(ok).toBe(true);
      }],
      ["markFileSaved", () => s().markFileSaved({ ...FILE, baseRevision: "r-4" }, "Dose", c)],
      ["markFileSaved later edits", () => s().markFileSaved({ ...FILE, baseRevision: "r-5" }, "Dose", c, s().editSerial - 1)],
      ["setFileRef", () => s().setFileRef({ path: "/x/Other.lag" }, "Other")],
      ["markSaved", () => s().markSaved(3, "Other", s())],
      ["markRenamed", () => s().markRenamed("Again")],
      ["detach", () => s().detach()],
      ["normalize", () => {
        // A test the two groups no longer fit: the clean-up changes the analysis.
        st.setState({ analysis: { ...s().analysis, test: "two_way", posthoc: "tukey", control: 7, pairs: [[0, 9]] } });
        const a0 = s().analysis;
        s().normalize();
        expect(s().analysis).not.toBe(a0);
      }],
      ["setGuard", () => s().setGuard({ reason: "editingElsewhere" })],
      ["noteBlockedEdit", () => s().noteBlockedEdit("command", "save")],
      ["a blocked action", () => s().setCell(0, 0, 0, "blocked")],
      ["setGuard null", () => s().setGuard(null)],
      ["close", () => s().close()],
    ];
    for (const [name, fn] of steps) {
      fn();
      expect(s().userEditSerial, name).toBe(u0);
    }
  });

  it("an update made by a store listener during a user action is not the person's", () => {
    const st = opened();
    const u0 = st.getState().userEditSerial;
    let once = true;
    const off = st.subscribe(() => {
      if (!once) return;
      once = false;
      // e.g. a controller that reloads in place from inside its listener
      st.getState().setFileRef({ path: "/x/Moved.lag" }, "Moved");
      st.getState().markFileSaved(st.getState().file!, "Moved", openContent({ doc: tableDoc(), scratch: null }));
    });
    st.getState().setCell(0, 0, 0, "x");
    off();
    expect(st.getState().userEditSerial).toBe(u0 + 1);
  });
});

describe("G3: which actions reset the guard", () => {
  const resets: [string, (s: GraphState) => void][] = [
    ["newDoc", (s) => s.newDoc("column", false)],
    ["load", (s) => s.load({ doc: tableDoc(), name: "L", id: 4, saved: true })],
    ["loadFile", (s) => s.loadFile({ file: FILE, name: "Dose", doc: tableDoc(), saved: true })],
    ["loadFile inPlace", (s) => s.loadFile({ file: FILE, name: "Dose", doc: tableDoc(), saved: true, inPlace: true })],
    ["close", (s) => s.close()],
  ];
  for (const [name, fn] of resets) {
    it(`${name} resets guard and blocked in the same update`, () => {
      const st = opened();
      st.getState().setGuard({ reason: "editingElsewhere" });
      st.getState().setCell(0, 0, 0, "1");
      expect(st.getState().blocked).not.toBeNull();
      const seen: { guard: unknown; blocked: unknown }[] = [];
      const off = st.subscribe((s) => seen.push({ guard: s.guard, blocked: s.blocked }));
      fn(st.getState());
      off();
      expect(seen).toEqual([{ guard: null, blocked: null }]);
    });
  }

  it("replaceContent keeps the guard and still applies under it", () => {
    const st = opened();
    st.getState().setGuard({ reason: "editingElsewhere" });
    const next = tableDoc();
    (next.cells[0][0] as string[])[0] = "100";
    const ok = st.getState().replaceContent({
      docKey: FILE.docKey, expectedBase: FILE.baseRevision, expectedEditSerial: st.getState().editSerial,
      file: { ...FILE, baseRevision: "r-2" }, name: "Dose", doc: next, scratch: '{"v":1,"cells":[[1,1,"7"]]}',
    });
    expect(ok).toBe(true);
    const s = st.getState();
    expect(s.guard).toEqual({ reason: "editingElsewhere" });
    expect(s.doc!.cells[0][0][0]).toBe("100");
    expect(s.scratch).toContain('"7"');
    expect(s.file?.baseRevision).toBe("r-2");
    expect(isDirty(s)).toBe(false);
    expect(s.blocked).toBeNull();
  });

  it("markFileSaved, setFileRef, replaceWorking apply under a guard and keep it", () => {
    const st = opened();
    st.getState().setGuard({ reason: "tooNew" });
    st.getState().setFileRef({ path: "/y/Dose.lag" });
    st.getState().markFileSaved({ ...FILE, baseRevision: "r-9" }, "Dose", openContent({ doc: tableDoc("xy"), scratch: null }));
    expect(st.getState().file?.baseRevision).toBe("r-9");
    expect(st.getState().doc?.template).toBe("xy");
    st.getState().replaceWorking({ doc: tableDoc("column") });
    expect(st.getState().doc?.template).toBe("column");
    expect(st.getState().guard).toEqual({ reason: "tooNew" });
    expect(st.getState().blocked).toBeNull();
  });

  it("setGuard: the same reason again is no update; another reason or null is", () => {
    const st = opened();
    let n = 0;
    const off = st.subscribe(() => { n++; });
    st.getState().setGuard({ reason: "waiting" });
    st.getState().setGuard({ reason: "waiting" });
    expect(n).toBe(1);
    st.getState().setGuard({ reason: "editingElsewhere" });
    st.getState().setGuard(null);
    st.getState().setGuard(null);
    off();
    expect(n).toBe(3);
    expect(st.getState().guard).toBeNull();
  });

  it("normalize under a guard does nothing and reports nothing", () => {
    const st = opened();
    st.setState({ analysis: { ...st.getState().analysis, test: "two_way", posthoc: "tukey", control: 7 } });
    st.getState().setGuard({ reason: "editingElsewhere" });
    const a0 = st.getState().analysis;
    const e0 = st.getState().editSerial;
    st.getState().normalize();
    expect(st.getState().analysis).toBe(a0);
    expect(st.getState().editSerial).toBe(e0);
    expect(st.getState().blocked).toBeNull();
  });

  it("after the guard is cleared everything works as before", () => {
    const st = withHistory();
    st.getState().setGuard({ reason: "editingElsewhere" });
    st.getState().setCell(0, 0, 0, "blocked");
    st.getState().setGuard(null);
    st.getState().setCell(0, 0, 0, "ok");
    expect(st.getState().doc!.cells[0][0][0]).toBe("ok");
    // still one undo step for this cell: the refused keystroke did not touch lastEditKey
    expect(st.getState().undoStack.length).toBe(1);
    expect(st.getState().undo()).toBe(true);
    expect(st.getState().doc!.cells[0][0][0]).toBe("1");
  });
});
