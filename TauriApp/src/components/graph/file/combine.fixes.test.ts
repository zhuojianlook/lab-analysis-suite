/* Regression tests for the phase 2 review findings (fixer). Each test names the finding it covers. */

import { describe, expect, it } from "vitest";
import { type RevisionP2 } from "./contract";
import { buildNextFile, fileAt, openFile, revisionOf } from "./docCodec";
import type { GraphFileData } from "./format";
import {
  DBX, PFILE as P, activeTab, authorFor, bannerOf, contentAt, editCell, editTitle, flush, lostVersions, pair, pressBanner, syncPair, tick,
  withAnswer, type Computer, type Pair,
} from "./testkit";

const cellOf = (c: Computer, r = 0) => c.graph.getState().doc!.cells[r][0][0];
const titleOf = (c: Computer) => c.graph.getState().figure.title;
const kinds = (c: Computer) => activeTab(c).banners.map((b) => `${b.kind}${b.state ? `:${b.state}` : ""}`);

/** Another computer ("Lab PC", Carol) saved over the head's parent (last writer wins), or on top of the head. */
async function saveOver(s: Pair, change: "table" | "figure", value: string, fromHead = false): Promise<string> {
  const f = s.a.dev.localFile(P)!;
  const parent = fromHead ? f.manifest.head : revisionOf(f.manifest, f.manifest.head)!.parents[0];
  const base = fileAt(f, parent)!;
  const c = openFile(base)!;
  const next = change === "figure" ? { ...c, figure: { ...c.figure, title: value } }
    : { ...c, doc: { ...c.doc, cells: c.doc.cells.map((row, r) => row.map((reps, k) => (r === 0 && k === 0 ? [value, ...reps.slice(1)] : reps))) } };
  const theirs = await buildNextFile(base, next, { time: s.w.clock.now(), author: { ...authorFor(s.a.dev, "Carol"), device_id: "d-c", device_name: "Lab PC" } });
  s.w.forceReplace(P, theirs);
  return theirs.manifest.head;
}

/** A copy of the file's version `from` with one change by Bob, as a file on its own. */
async function bobsCopy(s: Pair, from: GraphFileData, change: "analysis" | "figure" | "table", value = "Bob"): Promise<GraphFileData> {
  const c = openFile(from)!;
  const next = change === "analysis" ? { ...c, analysis: { ...c.analysis, alpha: 0.01 } }
    : change === "figure" ? { ...c, figure: { ...c.figure, title: value } }
      : { ...c, doc: { ...c.doc, cells: c.doc.cells.map((row, r) => row.map((reps, k) => (r === 2 && k === 0 ? [value, ...reps.slice(1)] : reps))) } };
  return buildNextFile(from, next, { time: s.w.clock.now(), author: { ...authorFor(s.b.dev, "Bob"), device_id: "d-bob", device_name: "Bob's Mac" } });
}

describe("merge F1: an edit typed while Save meets another version is kept", () => {
  for (const when of ["save", "read"] as const) {
    it(`typed during the ${when}`, async () => {
      const s = await pair(500);
      const { a, b } = s;
      await editCell(b, "mine");
      await editTitle(a, "Theirs");
      await a.ses.getState().save();
      await syncPair(s);
      let typed = false;
      if (when === "save") {
        const orig = b.dev.save.bind(b.dev);
        b.dev.save = async (req) => {
          const res = await orig(req);
          if (!typed) { typed = true; b.graph.getState().setCell(1, 0, 0, "typed after Save"); }
          return res;
        };
      } else {
        const orig = b.dev.read.bind(b.dev);
        b.dev.read = async (...args: Parameters<typeof orig>) => {
          const res = await orig(...args);
          if (!typed && activeTab(b).saving !== undefined) { typed = true; b.graph.getState().setCell(1, 0, 0, "typed after Save"); }
          return res;
        };
      }
      const out = await b.ses.getState().save();
      await flush();
      await tick(s.w, 3000);
      expect(typed).toBe(true);
      expect(out.ok).toBe(true);
      // The typed value is in the tab (as unsaved changes on top of the combined version) or already saved.
      expect(cellOf(b, 1)).toBe("typed after Save");
      const onDisk = contentAt(b.dev, P)!.doc.cells[1][0][0];
      if (onDisk !== "typed after Save") expect(activeTab(b).dirty).toBe(true);
      expect(titleOf(b)).toBe("Theirs");
      expect(cellOf(b)).toBe("mine");
    });
  }
});

describe("merge F2 / safety F3: combining with an extra copy while the tab's own file is ahead", () => {
  it("unsaved changes + a newer version in the file + a diverged copy: Combine… takes in the file first, then the copy", async () => {
    const s = await pair(500, "dropbox", { notes: false });     // phase 3: edits on both computers within seconds
    const { a, b } = s;
    const seed = b.dev.localFile(P)!;
    await editCell(b, "B saved", 1); await b.ses.getState().save(); await syncPair(s);
    await editCell(b, "B unsaved");
    await editTitle(a, "A title"); await a.ses.getState().save(); await syncPair(s);
    expect(bannerOf(b, "newerOnDisk")).not.toBeNull();
    const copyPath = `${DBX}/Dose response (Bob's conflicted copy).lag`;
    b.dev.place(copyPath, await bobsCopy(s, seed, "analysis"));
    await tick(s.w, 12_000);
    const banner = activeTab(b).banners.find((x) => x.kind === "extraCopy");
    expect(banner?.actions).toContain("combine");
    const writes0 = b.dev.journalCopies().length;
    await b.ses.getState().bannerAction(activeTab(b).key, banner!.id, "combine");
    await flush();
    expect(b.ses.getState().dialog?.kind ?? null).toBeNull();
    const m = b.dev.localFile(P)!.manifest;
    expect(activeTab(b).baseRevision).toBe(m.head);
    expect(cellOf(b)).toBe("B unsaved");
    expect(titleOf(b)).toBe("A title");
    expect(b.graph.getState().analysis.alpha).toBe(0.01);
    expect(b.ses.getState().toasts.some((t) => t.message?.includes("keeps changing"))).toBe(false);
    // Bounded saved copies: the working copy is written once, not once per attempt.
    expect(b.dev.journalCopies().length - writes0).toBeLessThanOrEqual(3);
    expect(lostVersions(s.w)).toEqual([]);
  });
});

describe("merge F5: a side that doesn't normalise the same way twice is not compared", () => {
  it("a table without row ids falls back instead of looking like a conflict with itself", async () => {
    const { normaliseSections, combine } = await import("./graphMerge");
    const { sectionsOf } = await import("./docCodec");
    const s = await pair(0);
    const sec = sectionsOf(openFile(s.a.dev.localFile(P)!)!) as unknown as Record<string, unknown>;
    const table = { ...(sec.table as Record<string, unknown>) };
    delete table.row_ids;
    const damaged = { ...sec, table } as never;
    expect(await normaliseSections(sec as never)).not.toBeNull();
    expect(await normaliseSections(damaged)).toBeNull();
    const plan = await combine({ base: damaged, baseKind: "lca", mine: damaged, theirs: damaged });
    expect(plan.ok).toBe(false);
  });
});

describe("safety F1 / ux F3: a choice already made does not come back after the tab is closed and reopened", () => {
  it("an edit taken back before saving is not written in by itself", async () => {
    const s = await pair(500);
    const { a, b } = s;
    await editCell(b, "B!"); await editTitle(b, "Draft title");
    await editCell(a, "A!"); await a.ses.getState().save(); await syncPair(s);
    expect(await b.ses.getState().save()).toEqual({ ok: false, reason: "conflict" });
    b.ses.getState().cancelCombine();
    await editTitle(b, "");
    await b.ses.getState().save();
    await b.ses.getState().setSectionChoice("table", "mine");
    expect((await b.ses.getState().applyCombine()).ok).toBe(true);
    await syncPair(s);
    const head = b.dev.localHead(P);
    await b.ses.getState().closeTab(); await flush();
    await b.ses.getState().open(P); await flush();
    expect(kinds(b).filter((k) => k.startsWith("savedOver"))).toEqual([]);
    await tick(s.w, 30_000);
    await syncPair(s);
    expect(b.dev.localHead(P)).toBe(head);
    expect(titleOf(b)).toBe("");
    expect(titleOf(a)).toBe("");
  });

  it("Save → dialog → Cancel → discard and close → reopen: nothing offered, nothing written", async () => {
    const s = await pair(500);
    const { a, b } = s;
    await editCell(b, "B-discarded");
    await editCell(a, "A!"); await a.ses.getState().save(); await syncPair(s);
    await b.ses.getState().save();
    b.ses.getState().cancelCombine();
    await withAnswer(b, () => b.ses.getState().closeTab(), { kind: "closeDirty", choice: "discard" } as never);
    await flush();
    const writes = b.dev.written.length;
    await b.ses.getState().open(P); await flush();
    await tick(s.w, 30_000);
    expect(kinds(b).filter((k) => k.startsWith("savedOver"))).toEqual([]);
    expect(b.dev.written.length).toBe(writes);
    expect(cellOf(b)).toBe("A!");
  });

  it("Cancel, Choose…, Mine, Apply, close, reopen: no extra version and no automatic combine", async () => {
    const s = await pair(500);
    const { a, b } = s;
    await editCell(b, "B!");
    await editCell(a, "A!"); await a.ses.getState().save(); await syncPair(s);
    await b.ses.getState().save();
    b.ses.getState().cancelCombine();
    await pressBanner(b, "notSaved", "choose");
    await b.ses.getState().setSectionChoice("table", "mine");
    expect((await b.ses.getState().applyCombine()).ok).toBe(true);
    await syncPair(s);
    const n = b.dev.localFile(P)!.manifest.revisions.length;
    await b.ses.getState().closeTab(); await flush();
    await b.ses.getState().open(P); await flush();
    await tick(s.w, 30_000);
    expect(b.dev.localFile(P)!.manifest.revisions.length).toBe(n);
    expect(kinds(b).filter((k) => k.startsWith("savedOver"))).toEqual([]);
  });

  it("Keep both as separate files for my replaced save, then close and reopen: not asked again", async () => {
    const s = await pair(500, "lww");
    const { a } = s;
    await editCell(a, "my save"); await a.ses.getState().save(); await syncPair(s);
    await saveOver(s, "table", "theirs");
    await tick(s.w, 30_000);
    expect(kinds(a)).toContain("savedOver:choose");
    await pressBanner(a, "savedOver", "combine");
    expect(a.ses.getState().dialog?.kind).toBe("combine");
    a.picks.push(`${DBX}/Dose response (my copy).lag`);
    await a.ses.getState().keepBothAsSeparate(); await flush();
    expect(activeTab(a).path).toBe(`${DBX}/Dose response (my copy).lag`);
    expect(kinds(a).filter((k) => k.startsWith("savedOver"))).toEqual([]);
    const files = a.dev.localPaths().length;
    await a.ses.getState().closeTab(); await flush();
    await a.ses.getState().open(P); await flush();
    await tick(s.w, 15_000);
    expect(kinds(a).filter((k) => k.startsWith("savedOver"))).toEqual([]);
    expect(a.dev.localPaths().length).toBe(files);
  });
});

describe("safety F2: rollback with unsaved changes, then Use the earlier version", () => {
  it("Save then succeeds, on top of the earlier version, and my latest version is kept in the history", async () => {
    const s = await pair(500);
    const { a } = s;
    await editCell(a, "r2"); await a.ses.getState().save(); const r2 = a.dev.localHead(P)!;
    await editCell(a, "r3"); await a.ses.getState().save(); const r3 = a.dev.localHead(P)!;
    await syncPair(s);
    await editTitle(a, "unsaved title");
    s.w.forceReplace(P, fileAt(a.dev.localFile(P)!, r2)!);
    await tick(s.w, 30_000);
    expect(kinds(a)).toContain("rolledBack");
    await pressBanner(a, "rolledBack", "useEarlier");
    expect(activeTab(a).dirty).toBe(true);
    const out = await a.ses.getState().save();
    await flush();
    expect(out.ok).toBe(true);
    const m = a.dev.localFile(P)!.manifest;
    expect(revisionOf(m, m.head)!.parents).toEqual([r2]);
    expect(revisionOf(m, r3)).not.toBeNull();
    expect(titleOf(a)).toBe("unsaved title");
    expect(contentAt(a.dev, P)!.figure.title).toBe("unsaved title");
    expect(kinds(a)).not.toContain("rolledBack");
    expect(activeTab(a).notSaved).toBe(false);
  });
});

describe("safety F4: Use the earlier version is remembered after the tab is closed", () => {
  it("not asked again on reopen; the next save takes the dropped version into the history", async () => {
    const s = await pair(500);
    const { a } = s;
    await editCell(a, "r2"); await a.ses.getState().save(); const r2 = a.dev.localHead(P)!;
    await editCell(a, "r3"); await a.ses.getState().save(); const r3 = a.dev.localHead(P)!;
    await syncPair(s);
    s.w.forceReplace(P, fileAt(a.dev.localFile(P)!, r2)!);
    await tick(s.w, 30_000);
    await pressBanner(a, "rolledBack", "useEarlier");
    await a.ses.getState().closeTab(); await flush();
    await a.ses.getState().open(P); await flush(); await tick(s.w, 15_000);
    expect(kinds(a)).toEqual([]);
    await editCell(a, "after");
    expect((await a.ses.getState().save()).ok).toBe(true);
    const m = a.dev.localFile(P)!.manifest;
    expect(revisionOf(m, r3)).not.toBeNull();
    // Closed and opened again once more: r3 is in the file's history now, so nothing to ask.
    await a.ses.getState().closeTab(); await a.ses.getState().open(P); await flush(); await tick(s.w, 15_000);
    expect(kinds(a)).toEqual([]);
  });
});

describe("safety F5: extra-copy banners of a copy that is gone", () => {
  it("pressing Combine… or Remove it drops the banner quietly", async () => {
    const s = await pair(500);
    const { b } = s;
    const seed = b.dev.localFile(P)!;
    await editCell(b, "B"); await b.ses.getState().save();
    const copyPath = `${DBX}/Dose response (Bob's conflicted copy).lag`;
    b.dev.place(copyPath, await bobsCopy(s, seed, "figure"));
    await tick(s.w, 12_000);
    const banner = activeTab(b).banners.find((x) => x.kind === "extraCopy")!;
    expect(banner).toBeTruthy();
    b.dev.remove(copyPath);
    await b.ses.getState().bannerAction(activeTab(b).key, banner.id, "combine"); await flush();
    expect(activeTab(b).banners.filter((x) => x.kind === "extraCopy" || x.kind === "saveFailed")).toEqual([]);
    expect(b.ses.getState().dialog).toBeNull();
  });
});

describe("safety F6: Go back to my latest never overwrites a version saved meanwhile", () => {
  it("another computer saved on top of the earlier version: combined, not overwritten", async () => {
    const s = await pair(500, "lww");
    const { a } = s;
    await editCell(a, "r2"); await a.ses.getState().save(); const r2 = a.dev.localHead(P)!;
    await editCell(a, "r3"); await a.ses.getState().save(); const r3 = a.dev.localHead(P)!;
    await syncPair(s);
    s.w.forceReplace(P, fileAt(a.dev.localFile(P)!, r2)!);
    await tick(s.w, 30_000);
    expect(kinds(a)).toContain("rolledBack");
    const carol = await saveOver(s, "table", "carol", true);
    await tick(s.w, 30_000);
    // The rollback note no longer fits (the file moved on from the earlier version): it goes, and my latest
    // version is offered for combining. Pressing "Go back to my latest" on a note still shown does the same.
    const rb = activeTab(a).banners.find((x) => x.kind === "rolledBack");
    if (rb) { await a.ses.getState().bannerAction(activeTab(a).key, rb.id, "backToLatest"); await flush(); }
    else await pressBanner(a, "savedOver", "combine");
    await tick(s.w, 2_000);
    expect(a.dev.localHead(P)).toBe(carol);
    const dlg = a.ses.getState().dialog;
    if (dlg?.kind === "combine") {
      await a.ses.getState().setSectionChoice("table", "mine");
      expect((await a.ses.getState().applyCombine()).ok).toBe(true);
      await flush();
    }
    // Carol's version was never overwritten: it is in the file's history right after "Go back to my latest".
    await tick(s.w, 30_000);
    const m = a.dev.localFile(P)!.manifest;
    expect(revisionOf(m, carol)).not.toBeNull();
    expect(revisionOf(m, r3)).not.toBeNull();
    expect(lostVersions(s.w)).toEqual([]);
  });
});

describe("safety F6 (the press comes before the change is noticed)", () => {
  it("Go back to my latest reads the file first: a version saved on top is never overwritten", async () => {
    const s = await pair(500, "lww");
    const { a } = s;
    await editCell(a, "r2"); await a.ses.getState().save(); const r2 = a.dev.localHead(P)!;
    await editCell(a, "r3"); await a.ses.getState().save(); const r3 = a.dev.localHead(P)!;
    await syncPair(s);
    s.w.forceReplace(P, fileAt(a.dev.localFile(P)!, r2)!);
    await tick(s.w, 30_000);
    const rb = activeTab(a).banners.find((x) => x.kind === "rolledBack")!;
    expect(rb).toBeTruthy();
    // Carol's save on top of the earlier version lands on this disk; the press comes before it is noticed.
    const f = a.dev.localFile(P)!;
    const c = openFile(f)!;
    const theirs = await buildNextFile(f, { ...c, doc: { ...c.doc, cells: c.doc.cells.map((row, r) => row.map((reps, k) => (r === 0 && k === 0 ? ["carol", ...reps.slice(1)] : reps))) } },
      { time: s.w.clock.now(), author: { ...authorFor(a.dev, "Carol"), device_id: "d-c", device_name: "Lab PC" } });
    const carol = theirs.manifest.head;
    a.dev.place(P, theirs);
    await a.ses.getState().bannerAction(activeTab(a).key, rb.id, "backToLatest"); await flush();
    expect(a.dev.localHead(P)).toBe(carol);
    expect(a.ses.getState().dialog?.kind).toBe("combine");
    await a.ses.getState().setSectionChoice("table", "mine");
    expect((await a.ses.getState().applyCombine()).ok).toBe(true);
    const m = a.dev.localFile(P)!.manifest;
    expect(revisionOf(m, carol)).not.toBeNull();
    expect(revisionOf(m, r3)).not.toBeNull();
    expect(cellOf(a)).toBe("r3");
  });
});

describe("safety F7: a held reload of a tab that was left", () => {
  it("no stale newer-version banner on the background tab or after coming back", async () => {
    let busy = false;
    const s = await pair(500, "dropbox", { depsB: { interactionBusy: () => busy } });
    const { a, b } = s;
    const key = activeTab(b).key;
    busy = true;
    await editTitle(a, "A1"); await a.ses.getState().save(); await syncPair(s);
    expect(activeTab(b).updating).toBe(true);
    await b.ses.getState().newDoc("column"); await flush();
    busy = false; await tick(s.w, 3000);
    const t = b.ses.getState().tabs.find((x) => x.key === key)!;
    expect(t.banners.map((x) => x.kind)).not.toContain("newerOnDisk");
    expect(t.baseRevision).toBe(b.dev.localHead(P));
    await b.ses.getState().switchTab(key); await flush(); await tick(s.w, 12_000);
    expect(kinds(b)).not.toContain("newerOnDisk");
    expect(titleOf(b)).toBe("A1");
  });
});

describe("safety F8: a choice is shown again when the other side changed that part since", () => {
  it("dialog open, the other computer saves another table edit, Apply → the dialog again, nothing written", async () => {
    const s = await pair(500);
    const { a, b } = s;
    await editCell(b, "B!");
    await editCell(a, "A1"); await a.ses.getState().save(); await syncPair(s);
    await b.ses.getState().save();
    expect(b.ses.getState().dialog?.kind).toBe("combine");
    await b.ses.getState().setSectionChoice("table", "mine");
    await editCell(a, "A2", 1, 0); await a.ses.getState().save(); await syncPair(s);
    const head = b.dev.localHead(P);
    const out = await b.ses.getState().applyCombine(); await flush();
    expect(out.ok).toBe(false);
    expect(b.ses.getState().dialog?.kind).toBe("combine");
    expect(b.dev.localHead(P)).toBe(head);
    await b.ses.getState().setSectionChoice("table", "theirs");
    expect((await b.ses.getState().applyCombine()).ok).toBe(true);
    expect(b.graph.getState().doc!.cells[1][0][0]).toBe("A2");
  });
});

describe("safety F9: Keep on an older copy, then the copy gets changes of its own", () => {
  it("the copy is offered again", async () => {
    const s = await pair(500);
    const { a } = s;
    const old = a.dev.localFile(P)!;
    await editCell(a, "newer"); await a.ses.getState().save();
    const copy = `${DBX}/Dose response (old copy).lag`;
    a.dev.place(copy, old); await tick(s.w, 12_000);
    await pressBanner(a, "extraCopy", "keep");
    expect(kinds(a)).not.toContain("extraCopy");
    a.dev.place(copy, await bobsCopy(s, old, "figure", "Bob's unique work")); await tick(s.w, 30_000);
    const b = activeTab(a).banners.find((x) => x.kind === "extraCopy" || x.kind === "copyQuestion");
    expect(b).toBeTruthy();
  });
});

describe("ux F5: a diverged copy answered Later comes back after the next save", () => {
  it("Later, edit, Save → the banner is there again", async () => {
    const s = await pair(500);
    const { b } = s;
    const seed = b.dev.localFile(P)!;
    await editCell(b, "B"); await b.ses.getState().save();
    b.dev.place(`${DBX}/Dose response (Bob's conflicted copy).lag`, await bobsCopy(s, seed, "figure"));
    await tick(s.w, 12_000);
    await pressBanner(b, "extraCopy", "later");
    expect(kinds(b)).not.toContain("extraCopy");
    await editCell(b, "B2", 1); await b.ses.getState().save(); await flush();
    expect(kinds(b)).toContain("extraCopy");
  });
});

describe("ux F6: combined banner and the Versions list", () => {
  it("the combined note goes with the next save", async () => {
    const s = await pair(500);
    const { a, b } = s;
    await editCell(b, "mine");
    await editTitle(a, "Theirs"); await a.ses.getState().save(); await syncPair(s);
    await pressBanner(b, "newerOnDisk", "combine");
    expect(kinds(b)).toContain("combined");
    await editCell(b, "again", 1); await b.ses.getState().save(); await flush();
    expect(kinds(b)).not.toContain("combined");
  });

  it("while my replaced save waits for a choice, the list has a row for it with the Current chip", async () => {
    const s = await pair(500, "lww");
    const { a } = s;
    await editCell(a, "my save"); await a.ses.getState().save(); const mine = a.dev.localHead(P)!; await syncPair(s);
    await saveOver(s, "table", "theirs");
    await tick(s.w, 30_000);
    expect(kinds(a)).toContain("savedOver:choose");
    await a.ses.getState().openVersions(); await flush();
    const row = a.ses.getState().versions!.rows.find((r) => r.id === mine);
    expect(row).toBeTruthy();
    expect(row!.chips).toContain("current");
    expect(row!.summary).toBe("Your last save — not in the file yet");
  });
});

describe("merge F7: at a combine, lane 0 follows this computer's line", () => {
  it("my parent of the combine is in lane 0", async () => {
    const s = await pair(500);
    const { a, b } = s;
    // A saves first (its version id is the smaller one); B's unsaved edit is combined with it afterwards.
    await editCell(b, "mine");
    await editTitle(a, "Theirs"); await a.ses.getState().save(); await syncPair(s);
    await pressBanner(b, "newerOnDisk", "combine");
    await syncPair(s);
    await b.ses.getState().openVersions(); await flush();
    const v = b.ses.getState().versions!;
    const m = b.dev.localFile(P)!.manifest;
    const combined = m.revisions.find((r) => r.parents.length === 2) as RevisionP2 | undefined;
    expect(combined).toBeTruthy();
    const myParent = combined!.parents.find((p) => revisionOf(m, p)!.device_id === "d-b")!;
    const lane = v.layout.rows.find((r) => r.id === myParent)!.lane;
    expect(lane).toBe(0);
  });
});
