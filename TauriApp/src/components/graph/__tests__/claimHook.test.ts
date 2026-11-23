// Phase 3 contract §4.1 "The claim hook" / §5.3: the controller subscribes to the graph store and treats a
// change of userEditSerial as "the person changed something". This drives a store the way the app does
// (open, the editor's clean-up effect, live refresh, save, rename follow, the Scratchpad flushing its text,
// refused edits under a guard) and checks exactly which steps would claim.
import { describe, expect, it } from "vitest";
import type { GraphDoc } from "../../../api/graph";
import * as M from "../graphModel";
import { createGraphStore, isDirty, openContent, type FileRef, type GraphStoreApi } from "../../../store/graphStore";
import { FIXTURES } from "./fixtures";

const FILE: FileRef = { docKey: "k1", analysisId: "a-1", baseRevision: "r-1", path: "/d/Dose.lag" };

/** A controller stand-in: counts claims (a userEditSerial change on the loaded tab while not holding). */
function watch(st: GraphStoreApi) {
  const log: string[] = [];
  let holding = false;
  let step = "";
  const off = st.subscribe((s, prev) => {
    if (s.userEditSerial !== prev.userEditSerial && s.file?.docKey === FILE.docKey && !holding) {
      holding = true;
      log.push(step);
    }
  });
  return {
    run(name: string, fn: () => void) { step = name; fn(); },
    release() { holding = false; },
    claims: () => log,
    off,
  };
}

/** What GraphView's clean-up effect does after its dependencies change. */
function cleanUpEffect(st: GraphStoreApi) {
  const s = st.getState();
  if (!s.doc) return;
  if (M.hasNumbers(M.toNumericTable(s.doc))) s.normalize();
}

describe("claim hook firing matrix", () => {
  for (const f of FIXTURES) {
    it(`${f.id}: only the person's edits claim`, () => {
      const st = createGraphStore();
      const w = watch(st);
      const doc = M.migrateDoc(f.table) as GraphDoc | null;
      if (!doc) return;   // damaged fixtures are not documents
      const load = () => st.getState().loadFile({
        file: FILE, name: "Dose", doc, analysis: f.analysis as never, figure: f.figure as never, scratch: f.scratchpad, saved: true,
      });

      w.run("open", load);
      w.run("clean-up effect", () => cleanUpEffect(st));
      w.run("reload in place", () => st.getState().loadFile({ file: FILE, name: "Dose", doc, scratch: f.scratchpad, saved: true, inPlace: true }));
      w.run("clean-up effect again", () => cleanUpEffect(st));
      // The Scratchpad writes its canonical text back only after a change; writing the same text is no change.
      w.run("scratchpad flush, unchanged", () => st.getState().setScratch(st.getState().scratch));
      w.run("live refresh", () => {
        const s = st.getState();
        expect(s.replaceContent({ docKey: FILE.docKey, expectedBase: "r-1", expectedEditSerial: s.editSerial,
          file: { ...FILE, baseRevision: "r-2" }, name: "Dose", doc, analysis: f.analysis as never, figure: f.figure as never,
          scratch: f.scratchpad })).toBe(true);
      });
      w.run("combine result put in", () => {
        const s = st.getState();
        expect(s.replaceContent({ docKey: FILE.docKey, expectedBase: "r-2", expectedEditSerial: s.editSerial,
          file: { ...FILE, baseRevision: "r-3" }, name: "Dose", doc, undo: { label: "Undo: combine with Alice's changes" },
          working: { doc: M.emptyDoc(doc.template) } })).toBe(true);
      });
      w.run("restore unsaved work", () => st.getState().replaceWorking({ doc }));
      w.run("save", () => st.getState().markFileSaved({ ...FILE, baseRevision: "r-4" }, "Dose", openContent({ doc, scratch: null })));
      w.run("rename follow", () => st.getState().setFileRef({ path: "/d/Dose 2.lag" }, "Dose 2"));
      w.run("guard on", () => st.getState().setGuard({ reason: "editingElsewhere" }));
      w.run("refused typing", () => st.getState().setCell(0, 0, 0, "1234"));
      w.run("refused settings", () => { st.getState().setFigure({ title: "x" }); st.getState().setAnalysis({ alpha: 0.2 }); });
      w.run("refused scratchpad", () => st.getState().setScratch('{"v":1,"cells":[[3,3,"x"]]}'));
      w.run("refused undo", () => st.getState().undo());
      w.run("clean-up under the guard", () => cleanUpEffect(st));
      w.run("guard off", () => st.getState().setGuard(null));
      expect(w.claims()).toEqual([]);
      expect(isDirty(st.getState())).toBe(false);

      w.run("first keystroke", () => st.getState().setCell(0, 0, 0, "1234"));
      w.run("second keystroke", () => st.getState().setCell(0, 0, 0, "12345"));
      expect(w.claims()).toEqual(["first keystroke"]);

      w.release();
      w.run("save again", () => {
        const s = st.getState();
        s.markFileSaved({ ...FILE, baseRevision: "r-5" }, "Dose", { doc: s.doc!, analysis: s.analysis, figure: s.figure, scratch: s.scratch });
      });
      w.run("settings change", () => st.getState().setFigure({ title: "New title" }));
      w.release();
      w.run("scratchpad edit", () => st.getState().setScratch('{"v":1,"cells":[[9,9,"y"]]}'));
      w.release();
      w.run("undo", () => st.getState().undo());
      w.release();
      w.run("close", () => st.getState().close());
      w.run("open again", load);
      expect(w.claims()).toEqual(["first keystroke", "settings change", "scratchpad edit", "undo"]);
      w.off();
    });
  }
});
