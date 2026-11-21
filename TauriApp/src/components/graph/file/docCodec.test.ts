import { describe, expect, it } from "vitest";
import { createGraphStore, isDirty, openContent } from "../../../store/graphStore";
import { migrateDoc, sampleDoc } from "../graphModel";
import { EDIT_SCRIPT, FIXTURES } from "../__tests__/fixtures";
import {
  buildNewFile, buildNextFile, completeParts, contentOfDraft, draftOf, fileAt, mergeRevisionId, openFile, partsOf, relationOf,
  revisionOf, roundTrip, sectionsOf, ulid, unionManifests, versionInfo, type Author,
} from "./docCodec";
import { canonicalJson, fileProblem, sha256Hex } from "./format";
import { cloudServiceOf, folderLabel, isConflictCopyName, isTempLocation, safeFileName, withGraphExt } from "./paths";

const author: Author = { user_name: "Zhuo", device_id: "d-a", device_name: "Mac mini", session_id: "s-1", app_version: "t", platform: "macos" };
const T0 = Date.UTC(2026, 10, 20, 9);

const fixtureContent = (i: number) => {
  const f = FIXTURES[i];
  return openContent({ doc: migrateDoc(f.table)!, analysis: f.analysis as never, figure: f.figure as never, scratch: f.scratchpad });
};

describe("docCodec: open → save → reopen → save is byte-identical", () => {
  it.each(FIXTURES.map((f, i) => [f.id, i] as const))("%s", async (_id, i) => {
    const c = fixtureContent(i);
    const file = await buildNewFile({ content: c, analysisId: "a-x", forkedFrom: null, time: T0, author });
    expect(fileProblem(file)).toBeNull();
    const opened = openFile(file)!;
    const again = await partsOf(sectionsOf(opened));
    expect(again.texts).toEqual(file.parts);
    expect(again.contentHash).toBe(revisionOf(file.manifest, file.manifest.head)!.content_hash);
    for (const [k, text] of Object.entries(file.parts)) expect(k).toBe(`parts/${await sha256Hex(text)}.json`);
    // Through a graph store: opening never makes it dirty, and the baseline after a save is the file form.
    const g = createGraphStore();
    g.getState().loadFile({ file: { docKey: "k", analysisId: "a-x", baseRevision: file.manifest.head, path: "/x.lag" }, name: "x", ...opened, saved: true });
    expect(isDirty(g.getState())).toBe(false);
    expect(g.getState().file?.baseRevision).toBe(file.manifest.head);
    // Every edit step: save form → reopen → same bytes.
    const st = g.getState() as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const [op, ...args] of EDIT_SCRIPT) {
      st[op](...args);
      const s = g.getState();
      const sent = roundTrip({ doc: s.doc!, analysis: s.analysis, figure: s.figure, scratch: s.scratch });
      const p1 = await partsOf(sectionsOf(sent));
      const p2 = await partsOf(sectionsOf(roundTrip(sent)));
      expect(p2.texts).toEqual(p1.texts);
    }
  });

  it("a save with nothing edited since it was built takes the file form as the content and is clean", () => {
    const g = createGraphStore();
    const c = fixtureContent(0);
    g.getState().loadFile({ file: { docKey: "k", analysisId: "a", baseRevision: "r-1", path: "/a.lag" }, name: "a", ...c, saved: true });
    g.getState().setCell(0, 0, 0, "1");
    const serial = g.getState().editSerial;
    const sent = roundTrip({ ...c, doc: g.getState().doc! });
    g.getState().markFileSaved({ docKey: "k", analysisId: "a", baseRevision: "r-2", path: "/a.lag" }, "a", sent, serial);
    expect(isDirty(g.getState())).toBe(false);
    // An edit made after the save was built stays unsaved.
    g.getState().setCell(0, 0, 0, "2");
    const serial2 = g.getState().editSerial - 1;
    g.getState().markFileSaved({ docKey: "k", analysisId: "a", baseRevision: "r-3", path: "/a.lag" }, "a", roundTrip({ ...c, doc: { ...g.getState().doc!, cells: sent.doc.cells } }), serial2);
    expect(g.getState().doc!.cells[0][0][0]).toBe("2");
    expect(isDirty(g.getState())).toBe(true);
  });

  it("editSerial counts content changes only; the name never makes a file document dirty", () => {
    const g = createGraphStore();
    const c = fixtureContent(1);
    g.getState().loadFile({ file: { docKey: "k", analysisId: "a", baseRevision: "r", path: "/a.lag" }, name: "a", ...c, saved: true });
    const s0 = g.getState().editSerial;
    g.getState().setFileRef({ path: "/b.lag" }, "b");
    expect(g.getState().editSerial).toBe(s0);
    expect(isDirty(g.getState())).toBe(false);
    expect(g.getState().name).toBe("b");
    g.getState().setFigure({ title: "t" });
    expect(g.getState().editSerial).toBe(s0 + 1);
    g.getState().replaceWorking(c);
    expect(g.getState().undoStack).toEqual([]);
    const ds = g.getState().docSerial;
    g.getState().loadFile({ file: { docKey: "k", analysisId: "a", baseRevision: "r2", path: "/b.lag" }, name: "b", ...c, saved: true, inPlace: true });
    expect(g.getState().docSerial).toBe(ds);
  });

  it("drafts carry the file form and come back as the same content", () => {
    const c = fixtureContent(3);
    const d = draftOf({ docKey: "k", analysisId: "a", path: "/a.lag", baseRevision: "r", content: c, savedAt: T0, title: "a" });
    expect(d.saved_at).toBe(new Date(T0).toISOString());
    const back = contentOfDraft(JSON.parse(JSON.stringify(d)))!;
    expect(canonicalJson(sectionsOf(back))).toBe(canonicalJson(sectionsOf(c)));
  });
});

describe("revisions and manifests", () => {
  it("ULIDs are 26 Crockford characters, ordered by time", () => {
    const a = ulid(T0);
    const b = ulid(T0 + 1);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
  });

  it("the combined version id depends only on the parents (in any order) and the content", async () => {
    const x = await mergeRevisionId(["r-b", "r-a"], "h");
    expect(x).toBe(await mergeRevisionId(["r-a", "r-b"], "h"));
    expect(x).toBe(`r-m-${(await sha256Hex("r-a\nr-b\nh")).slice(0, 26)}`);
    expect(await mergeRevisionId(["r-a", "r-b"], "h2")).not.toBe(x);
  });

  it("history: union keeps stored snapshots, fileAt cuts, relations, version info", async () => {
    const c = openContent({ doc: sampleDoc("column") });
    const f1 = await buildNewFile({ content: c, analysisId: "a-1", forkedFrom: null, time: T0, author });
    const f2 = await buildNextFile(f1, { ...c, figure: { ...c.figure, title: "2" } }, { time: T0 + 1, author });
    const f2b = await buildNextFile(f1, { ...c, figure: { ...c.figure, title: "2b" } }, { time: T0 + 2, author: { ...author, device_id: "d-b", device_name: "MacBook", user_name: "Alice" } });
    const h1 = f1.manifest.head, h2 = f2.manifest.head, h2b = f2b.manifest.head;
    expect(relationOf(f2.manifest, h2, f1.manifest, h1)).toBe("older");
    expect(relationOf(f1.manifest, h1, f2.manifest, h2)).toBe("newer");
    expect(relationOf(f2.manifest, h2, f2b.manifest, h2b)).toBe("diverged");
    expect(relationOf(f2.manifest, h2, f2.manifest, h2)).toBe("same");
    const noSnap = { ...f2.manifest, revisions: f2.manifest.revisions.map((r) => (r.id === h1 ? { ...r, sections: null } : r)) };
    const u = unionManifests(noSnap, f2b.manifest);
    expect(u.revisions.map((r) => r.id)).toEqual([h1, h2, h2b]);
    expect(revisionOf(u, h1)!.sections).not.toBeNull();
    expect(fileAt(f2, h1)!.manifest.revisions.map((r) => r.id)).toEqual([h1]);
    expect(Object.keys(fileAt(f2, h1)!.parts).sort()).toEqual(Object.keys(f1.parts).sort());
    expect(versionInfo(f2b.manifest, h2b, "d-a")).toMatchObject({ head: h2b, userName: "Alice", deviceName: "MacBook", mine: false });
    expect(versionInfo(f2.manifest, h2, "d-a").mine).toBe(true);
  });

  it("completeParts fetches missing snapshots from the journal and otherwise keeps metadata only", async () => {
    const c = openContent({ doc: sampleDoc("column") });
    const f1 = await buildNewFile({ content: c, analysisId: "a-1", forkedFrom: null, time: T0, author });
    const f2 = await buildNextFile(f1, { ...c, figure: { ...c.figure, title: "2" } }, { time: T0 + 1, author });
    const onlyHead = fileAt(f2, f2.manifest.head)!;
    const headParts = Object.fromEntries(Object.entries(f2.parts).filter(([k]) => Object.values(revisionOf(f2.manifest, f2.manifest.head)!.sections!).some((r) => r.part === k)));
    const viaJournal = await completeParts(f2.manifest, headParts, async (id) => (id === f1.manifest.head ? f1 : null));
    expect(viaJournal!.manifest).toEqual(f2.manifest);
    expect(Object.keys(viaJournal!.parts).sort()).toEqual(Object.keys(f2.parts).sort());
    const without = await completeParts(f2.manifest, headParts, async () => null);
    expect(revisionOf(without!.manifest, f1.manifest.head)!.sections).toBeNull();
    expect(fileProblem({ manifest: without!.manifest, parts: without!.parts })).toBeNull();
    expect(await completeParts(f2.manifest, {}, async () => null)).toBeNull();
    void onlyHead;
  });
});

describe("paths", () => {
  const H = "/Users/me";
  it("folder labels and cloud services", () => {
    expect(folderLabel(`${H}/Dropbox/Lab/x.lag`, H)).toBe("Dropbox › Lab");
    expect(folderLabel(`${H}/Library/CloudStorage/Dropbox/Lab/x.lag`, H)).toBe("Dropbox › Lab");
    expect(folderLabel(`${H}/Library/CloudStorage/Dropbox (Personal)/x.lag`, H)).toBe("Dropbox");
    expect(folderLabel(`${H}/Library/CloudStorage/GoogleDrive-me@x.org/My Drive/Data/x.lag`, H)).toBe("Google Drive › Data");
    expect(folderLabel(`${H}/Library/Mobile Documents/com~apple~CloudDocs/Lab/x.lag`, H)).toBe("iCloud Drive › Lab");
    expect(folderLabel(`${H}/Library/CloudStorage/OneDrive-Personal/a/b/c/x.lag`, H)).toBe("… › b › c");
    expect(folderLabel(`${H}/Documents/x.lag`, H)).toBe("Documents");
    expect(folderLabel(`${H}/x.lag`, H)).toBe("Home");
    expect(folderLabel(`/Volumes/Data/x.lag`, H)).toBe("Volumes › Data");
    expect(cloudServiceOf(`${H}/Library/CloudStorage/Dropbox/Lab/x.lag`, H)).toBe("Dropbox");
    expect(cloudServiceOf(`${H}/Library/CloudStorage/OneDrive-Personal/x.lag`, H)).toBe("OneDrive");
    expect(cloudServiceOf(`${H}/Library/Mobile Documents/com~apple~CloudDocs/x.lag`, H)).toBe("iCloud Drive");
    expect(cloudServiceOf(`${H}/Documents/x.lag`, H)).toBeNull();
    expect(cloudServiceOf(`/Users/other/Dropbox/x.lag`, H)).toBeNull();
  });

  it("temporary folders, safe names, extensions, copy names", () => {
    expect(isTempLocation(`${H}/Downloads/x.lag`, [`${H}/Downloads`])).toBe(true);
    expect(isTempLocation(`${H}/Downloads2/x.lag`, [`${H}/Downloads`])).toBe(false);
    expect(safeFileName(' a/b:c*?"<>| ')).toBe("a-b-c------");
    expect(safeFileName("..hidden")).toBe("hidden");
    expect(safeFileName("   ")).toBe("Untitled");
    expect(safeFileName("x".repeat(300)).length).toBe(120);
    expect(withGraphExt("/a/b")).toBe("/a/b.lag");
    expect(withGraphExt("/a/b.LAG")).toBe("/a/b.LAG");
    expect(isConflictCopyName("/d/A (MacBook's conflicted copy 2026-11-20).lag")).toBe(true);
    expect(isConflictCopyName("/d/A (unsynced from Mac mini).lag")).toBe(true);
    expect(isConflictCopyName("/d/A (my version from Mac mini).lag")).toBe(true);
    expect(isConflictCopyName("/d/A-MACBOOK.lag", "A")).toBe(true);
    expect(isConflictCopyName("/d/A copy.lag", "A")).toBe(false);
    expect(isConflictCopyName("/d/Exp 2.lag", "A")).toBe(false);
  });
});
