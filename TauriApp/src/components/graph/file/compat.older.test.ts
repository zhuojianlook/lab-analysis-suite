// Phase 4 (contract §3.4 row 10, §3.5): files written by the RELEASED exp-0.2.25 code (fixtures-p4/older.ts)
// open in this build, combine cell by cell, and save; every older version is kept byte for byte, combine_v
// is added only to new versions, the format fields stay as they were.
import { describe, expect, it, vi } from "vitest";
import { COMBINE_V, type RevisionP4 } from "./contract";
import { openFile } from "./docCodec";
import { P2_COMBINED_FILE, P3_FILE } from "./fixtures-p4/older";
import { fileProblem, type GraphFileData } from "./format";
import { PFILE as P, bannerOf, combineState, editCellAt, flush, headRev, lostVersions, duplicateCombines, pair, syncPair, tick } from "./testkit";

vi.setConfig({ testTimeout: 60_000 });

const FILES: Record<string, GraphFileData> = { "p3-file": P3_FILE, "p2comb-file": P2_COMBINED_FILE };
const load = (n: string) => structuredClone(FILES[n]);

for (const name of ["p3-file", "p2comb-file"]) {
  describe(`an older file (${name})`, () => {
    it("on Save with unsaved changes: combined cell by cell at once; older versions untouched", async () => {
      const data = load(name);
      expect(fileProblem(data)).toBeNull();
      const s = await pair(500);
      const { w, a, b } = s;
      w.forceReplace(P, data);
      await syncPair(s);
      for (const c of [a, b]) { await c.ses.getState().closeTab(); expect((await c.ses.getState().open(P)).ok).toBe(true); await flush(); }
      expect(a.dev.localHead(P)).toBe(data.manifest.head);
      await editCellAt(a, 4, 0, "A cell");
      expect((await a.ses.getState().save()).ok).toBe(true);
      await editCellAt(b, 5, 1, "B cell");
      await syncPair(s);
      const r = await b.ses.getState().save();
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(b.ses.getState().dialog).toBeNull();
      await syncPair(s);
      for (const dev of [a.dev, b.dev]) {
        const f = dev.localFile(P)!;
        expect(fileProblem(f)).toBeNull();
        const h = headRev(dev, P)!;
        expect(h.parents.length).toBe(2);
        expect(h.combine_v).toBe(COMBINE_V);
        const c = openFile(f)!;
        expect(c.doc.cells[4][0][0]).toBe("A cell");
        expect(c.doc.cells[5][1][0]).toBe("B cell");
        for (const old of data.manifest.revisions) expect(f.manifest.revisions.find((x) => x.id === old.id)).toEqual(old);
        const fresh = f.manifest.revisions.filter((x) => !data.manifest.revisions.some((o) => o.id === x.id)) as RevisionP4[];
        expect(fresh.every((x) => x.combine_v === COMBINE_V)).toBe(true);
        expect(f.manifest.format_version).toBe(data.manifest.format_version);
        expect(f.manifest.min_reader_version).toBe(data.manifest.min_reader_version);
        expect(f.manifest.features).toBe(data.manifest.features);
      }
      expect(bannerOf(b, "combined")).toMatchObject({ mixed: ["table"] });
      expect(lostVersions(w)).toEqual([]);
      expect(duplicateCombines(w)).toEqual([]);
    });

    it("the same cell on both: the dialog with one row to choose; nothing written until Apply", async () => {
      const data = load(name);
      const s = await pair(500);
      const { w, a, b } = s;
      w.forceReplace(P, data);
      await syncPair(s);
      for (const c of [a, b]) { await c.ses.getState().closeTab(); expect((await c.ses.getState().open(P)).ok).toBe(true); await flush(); }
      await editCellAt(a, 0, 0, "A same");
      expect((await a.ses.getState().save()).ok).toBe(true);
      await editCellAt(b, 0, 0, "B same");
      await syncPair(s);
      const head = b.dev.localHead(P);
      const r = await b.ses.getState().save();
      expect(r.ok).toBe(false);
      const st = combineState(b)!;
      expect(st.toChoose).toBe(1);
      const t = st.sections.find((x) => x.key === "table")!;
      expect(t.conflicts.map((c) => c.kind)).toEqual(["row"]);
      await tick(w, 5000);
      expect(b.dev.localHead(P)).toBe(head);
      await b.ses.getState().setConflictChoice(t.conflicts[0].id, "mine");
      expect((await b.ses.getState().applyCombine()).ok).toBe(true);
      expect(openFile(b.dev.localFile(P)!)!.doc.cells[0][0][0]).toBe("B same");
      expect(headRev(b.dev, P)!.combine_v).toBe(COMBINE_V);
    });
  });
}
