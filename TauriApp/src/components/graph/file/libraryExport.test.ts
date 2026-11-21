import { describe, expect, it } from "vitest";
import { isDirty } from "../../../store/graphStore";
import { revisionOf } from "./docCodec";
import { DOCS, addLibraryRow, computer, contentAt, fakeLibrary, flush, makeWorld, seedFile, start } from "./testkit";

const LIB = `${DOCS}/Library`;

async function setup(n = 3) {
  const w = makeWorld();
  const lib = fakeLibrary(n);
  const a = await start(await computer(w, { device_id: "d-a", device_name: "Mac mini" }, { library: lib }));
  return { w, lib, a };
}

const exportState = (a: Awaited<ReturnType<typeof setup>>["a"]) => {
  const d = a.ses.getState().dialog;
  if (d?.kind !== "export") throw new Error("no export dialog");
  return d.state;
};

describe("library export", () => {
  it("exports every row once; a second run writes nothing and keeps every id", async () => {
    const { a } = await setup(3);
    expect(a.ses.getState().oldLibrary).toEqual({ total: 3, unexported: 3 });
    await a.ses.getState().openExport();
    expect(exportState(a)).toMatchObject({ phase: "confirm", total: 3, already: 0 });
    await a.ses.getState().exportLibrary(LIB);
    expect(exportState(a)).toMatchObject({ phase: "done", total: 3, done: 3, failed: [], folderLabel: "Documents › Library" });
    const paths = [1, 2, 3].map((i) => `${LIB}/Experiment ${i}.lag`);
    expect(a.dev.localPaths()).toEqual(paths);
    for (const p of paths) {
      const f = a.dev.localFile(p)!;
      expect(f.manifest.revisions).toHaveLength(1);
      expect(revisionOf(f.manifest, f.manifest.head)).toMatchObject({ kind: "import", summary: "From the old library", parents: [] });
    }
    expect(contentAt(a.dev, paths[0])!.scratch).toContain('"5"');
    const map1 = await a.dev.readExportMap();
    expect(Object.values(map1.rows).every((r) => r.status === "done" && r.row_ids?.length && r.col_ids?.length)).toBe(true);
    expect(map1.rows["1"].analysis_id).toBe(a.dev.localFile(paths[0])!.manifest.analysis_id);
    expect(contentAt(a.dev, paths[0])!.doc.row_ids).toEqual(map1.rows["1"].row_ids);
    expect(a.ses.getState().oldLibrary).toEqual({ total: 3, unexported: 0 });
    expect(a.ses.getState().recent.map((r) => r.path)).toEqual(paths);
    expect(a.ses.getState().tabs).toEqual([]);                  // added to Recent, not opened

    const written = a.dev.written.length;
    await a.ses.getState().exportLibrary(LIB);
    expect(exportState(a)).toMatchObject({ done: 3, already: 3, failed: [] });
    expect(a.dev.written.length).toBe(written);
    expect(await a.dev.readExportMap()).toEqual(map1);
  });

  it("a row changed in the library is exported again into the same file, same ids, no look-alike", async () => {
    const { a, lib } = await setup(2);
    await a.ses.getState().exportLibrary(LIB);
    const map1 = await a.dev.readExportMap();
    addLibraryRow(lib, 2, "Experiment 2", "2026-02-02 11:00:00");
    const saved = lib.saved.get(2)!;
    (saved.table as { cells: string[][][] }).cells[0][0][0] = "42";
    await a.ses.getState().exportLibrary(LIB);
    expect(exportState(a)).toMatchObject({ done: 2, already: 1 });
    const f = a.dev.localFile(`${LIB}/Experiment 2.lag`)!;
    expect(f.manifest.revisions).toHaveLength(2);
    expect(f.manifest.analysis_id).toBe(map1.rows["2"].analysis_id);
    expect(contentAt(a.dev, `${LIB}/Experiment 2.lag`)!.doc.cells[0][0][0]).toBe("42");
    expect(contentAt(a.dev, `${LIB}/Experiment 2.lag`)!.doc.row_ids).toEqual(map1.rows["2"].row_ids);
    expect(a.dev.localPaths()).toHaveLength(2);
  });

  it("failures are listed with a reason; Try again exports only what failed; ids are minted once", async () => {
    const { w, a } = await setup(3);
    // Another analysis already has the first name: the export takes the next free one.
    await seedFile(w, a.dev, `${LIB}/Experiment 1.lag`);
    a.dev.setPermissionDenied(LIB, true);
    await a.ses.getState().exportLibrary(LIB);
    const st = exportState(a);
    expect(st.done).toBe(0);
    expect(st.failed.map((f) => f.name)).toEqual(["Experiment 1", "Experiment 2", "Experiment 3"]);
    expect(st.failed[0].reason).toMatch(/can't be written|couldn't/);
    const map1 = await a.dev.readExportMap();
    expect(map1.rows["2"]).toMatchObject({ status: "failed" });
    expect(map1.rows["2"].row_ids?.length).toBeGreaterThan(0);
    a.dev.setPermissionDenied(LIB, false);
    await a.ses.getState().exportLibrary(LIB);
    expect(exportState(a)).toMatchObject({ done: 3, failed: [] });
    const map2 = await a.dev.readExportMap();
    for (const k of ["1", "2", "3"]) {
      expect(map2.rows[k].analysis_id).toBe(map1.rows[k].analysis_id);
      expect(map2.rows[k].row_ids).toEqual(map1.rows[k].row_ids);
    }
    expect(map2.rows["1"].path).toBe(`${LIB}/Experiment 1 2.lag`);
  });

  it("Old library → Open a copy gives an untitled document with the exported ids; nothing is written", async () => {
    const { a } = await setup(2);
    await a.ses.getState().exportLibrary(LIB);
    const map = await a.dev.readExportMap();
    const written = a.dev.written.length;
    a.ses.getState().openOldLibrary();
    expect(a.ses.getState().dialog?.kind).toBe("oldLibrary");
    const o = await a.ses.getState().importLibraryRow(1);
    expect(o.ok).toBe(true);
    expect(a.ses.getState().dialog).toBeNull();
    expect(a.ses.getState().tabs[0]).toMatchObject({ title: "Experiment 1", path: null, dirty: true });
    expect(a.graph.getState().doc!.row_ids).toEqual(map.rows["1"].row_ids);
    expect(isDirty(a.graph.getState())).toBe(true);
    expect(a.dev.written.length).toBe(written);
  });

  it("the old-library count waits for the engine", async () => {
    const w = makeWorld();
    const lib = fakeLibrary(2);
    lib.fail = true;
    const a = await start(await computer(w, { device_id: "d-a", device_name: "Mac mini" }, { library: lib }));
    expect(a.ses.getState().oldLibrary).toBeNull();
    lib.fail = false;
    w.clock.advance(3000);
    await flush();
    expect(a.ses.getState().oldLibrary).toEqual({ total: 2, unexported: 2 });
  });
});

describe("the old browser draft", () => {
  it("becomes an untitled '(recovered)' document once, when no tabs were open", async () => {
    const w = makeWorld();
    const { sampleDoc } = await import("../graphModel");
    let cleared = 0;
    const legacy = {
      v: 1 as const, name: "Old work", currentId: 4, doc: sampleDoc("xy"), analysis: {} as never, figure: {} as never, at: Date.UTC(2026, 10, 1),
      scratchpad: null,
    };
    const a = await start(await computer(w, { device_id: "d-a", device_name: "Mac mini" }, {
      legacyDraft: { read: () => (cleared ? null : legacy), clear: () => { cleared++; } },
    }));
    const t = a.ses.getState().tabs[0];
    expect(t).toMatchObject({ title: "Old work (recovered)", path: null, dirty: true });
    expect(t.banners[0]?.kind).toBe("recovered");
    expect(cleared).toBe(1);
    expect(await a.dev.readDraft(t.key)).not.toBeNull();
    const a2 = await a.restart();
    expect(a2.ses.getState().tabs.map((x) => x.title)).toEqual(["Old work (recovered)"]);
  });
});
