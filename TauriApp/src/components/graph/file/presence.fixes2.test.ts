// Regression tests for the phase 3 re-verifier findings fixed by the fixer, round 2 (RV-1, RV-2, RV-4).
// Two or three MemoryDevices on the ManualClock, as in presence.fixes.test.ts.

import { describe, expect, it, vi } from "vitest";
import { noteText } from "./presence";
import type { NoteJson } from "./contract";
import {
  DBX, activeTab, editCell, flush, group, guardOf, modeOf, notesBeside, notesOf, tick, type Computer, type Group,
} from "./testkit";

vi.setConfig({ testTimeout: 120_000 });
const S = 1000, MIN = 60 * S;

const readOnly = (c: Computer) => guardOf(c) === "editingElsewhere" || guardOf(c) === "checking" || guardOf(c) === "waiting";
const myNotes = (c: Computer, path: string, id: string) => notesBeside(c.dev, path).filter((n) => n.note?.device_id === id);

// ── RV-1 ─────────────────────────────────────────────────────────────────────

describe("fixer round 2 RV-1: notes in a folder kept online-only are still read", () => {
  it("another computer's editing note arrives online-only: read (its download asked for), and this computer turns read-only", async () => {
    const g = await group(2, { delay: 500 });
    const [a, b] = g.cs;
    b.dev.notesOnlineOnly = true;      // B's Dropbox keeps the folder online-only from now on
    b.dev.noteHydrateMs = 1500;
    await editCell(a, "A1");
    await tick(g.w, 1200, 100);        // A's editing note has reached B's disk, online-only
    const onDisk = notesOf(b.dev, g.path, "d-a1a1")[0];
    expect(onDisk.note!.state).toBe("editing");
    expect(guardOf(b)).toBe(null);     // what B read of it before is all it knows yet (A's idle note)
    await tick(g.w, 3 * S, 250);       // the download the read asked for arrives
    expect(guardOf(b)).toBe("editingElsewhere");
    // A keeps typing for 2 min: every newer version of the note arrives online-only too; B stays read-only.
    for (let k = 0; k < 12; k++) {
      await editCell(a, `A ${k}`);
      await tick(g.w, 10 * S, 500);
      expect(guardOf(b), `B at ${k}`).toBe("editingElsewhere");
    }
  });

  it("opening a file whose notes are all online-only: not held up, read-only once the note has arrived; offline: editable, then read-only when back online", async () => {
    const g = await group(3, { delay: 500 });
    const [a, b, c] = g.cs;
    await editCell(a, "A1");
    for (const x of [b, c]) { await x.ses.getState().closeTab(); x.dev.notesOnlineOnly = true; x.dev.noteHydrateMs = 2000; }
    await tick(g.w, 3 * S);
    // A rewrites its note (a heartbeat-like change): the copies on B and C are online-only now.
    await editCell(a, "A2");
    await tick(g.w, 2 * S);
    c.dev.setOnline(false);
    const t0 = g.w.clock.now();
    expect((await b.ses.getState().open(g.path)).ok).toBe(true);
    expect(g.w.clock.now() - t0).toBeLessThanOrEqual(1500); // the open is never held back by a download
    await tick(g.w, 4 * S, 250);
    expect(guardOf(b)).toBe("editingElsewhere");
    // C is offline: its download cannot happen; the file opens, editable, nothing hangs.
    expect((await c.ses.getState().open(g.path)).ok).toBe(true);
    await tick(g.w, 10 * S, 500);
    expect(guardOf(c)).toBe(null);
    c.dev.setOnline(true);
    await tick(g.w, 5 * S, 250);
    expect(guardOf(c)).toBe("editingElsewhere");
  });
});

// ── RV-2 ─────────────────────────────────────────────────────────────────────

/** After `move` puts A's open file at `to`: A types, and its note says so beside `to` (none left at `from`);
 *  B, with `to` open, is read-only. */
async function noteFollows(g: Group, from: string, to: string): Promise<void> {
  const [a, b] = g.cs;
  expect(activeTab(a).path).toBe(to);
  await editCell(a, "typed after the move");
  await tick(g.w, 4 * S, 250);
  const mine = myNotes(a, to, "d-a1a1");
  expect(mine.map((n) => n.note!.document_name)).toEqual([to.slice(to.lastIndexOf("/") + 1)]);
  expect(mine[0].note!.state).toBe("editing");
  if (from.slice(0, from.lastIndexOf("/")) !== to.slice(0, to.lastIndexOf("/"))) expect(myNotes(a, from, "d-a1a1")).toEqual([]);
  if (activeTab(b)?.path !== to) {
    if (activeTab(b)) await b.ses.getState().closeTab();
    expect((await b.ses.getState().open(to)).ok).toBe(true);
    await tick(g.w, 3 * S, 250);
  }
  expect(guardOf(b)).toBe("editingElsewhere");
  for (let k = 0; k < 6; k++) {
    await editCell(a, `more ${k}`);
    await tick(g.w, 10 * S, 500);
    expect(guardOf(b), `B at ${k}`).toBe("editingElsewhere");
  }
}

describe("fixer round 2 RV-2: the note follows every path change", () => {
  it("Find it… on the open document (another computer moved the file to another folder)", async () => {
    const g = await group(2, { delay: 500 });
    const [a, b] = g.cs;
    const to = `${DBX}/Moved/Dose response.lag`;
    b.dev.rename(g.path, to, 0);
    await tick(g.w, 15 * S, 500);
    expect(activeTab(a).banners.some((x) => x.kind === "missing")).toBe(true);
    expect(myNotes(a, g.path, "d-a1a1")).toEqual([]);   // missing → my note went
    await a.ses.getState().findIt(activeTab(a).key, `${DBX}/Moved`);
    await flush();
    await noteFollows(g, g.path, to);
  });

  it("Find it… with unsaved changes made while the file was missing: my note says editing at once", async () => {
    const g = await group(2, { delay: 500 });
    const [a, b] = g.cs;
    const to = `${DBX}/Moved/Dose response.lag`;
    b.dev.rename(g.path, to, 0);
    await tick(g.w, 15 * S, 500);
    await editCell(a, "typed while missing");
    await a.ses.getState().findIt(activeTab(a).key, `${DBX}/Moved`);
    await tick(g.w, 3 * S, 250);
    expect(myNotes(a, to, "d-a1a1").map((n) => n.note!.state)).toEqual(["editing"]);
    await b.ses.getState().closeTab();                   // B's own tab lost the file too (moved to another folder)
    expect((await b.ses.getState().open(to)).ok).toBe(true);
    await tick(g.w, 3 * S, 250);
    expect(guardOf(b)).toBe("editingElsewhere");
  });

  it("rename followed (another computer renamed it in the same folder)", async () => {
    const g = await group(2, { delay: 500 });
    const [, b] = g.cs;
    const to = `${DBX}/Renamed elsewhere.lag`;
    b.dev.rename(g.path, to, 0);
    await tick(g.w, 15 * S, 500);
    await noteFollows(g, g.path, to);
  });

  it("move found by identity (renamed on this computer: the poll's \"moved\")", async () => {
    const g = await group(2, { delay: 500 });
    const [a] = g.cs;
    const to = `${DBX}/Dose response moved.lag`;
    a.dev.rename(g.path, to, 0);
    await tick(g.w, 15 * S, 500);
    await noteFollows(g, g.path, to);
  });

  it("Save As the same analysis while the file is missing", async () => {
    const g = await group(2, { delay: 500 });
    const [a] = g.cs;
    const f = a.dev.localFile(g.path)!;
    a.dev.remove(g.path);
    await tick(g.w, 15 * S, 500);
    expect(activeTab(a).banners.some((x) => x.kind === "missing")).toBe(true);
    const to = `${DBX}/Saved again.lag`;
    a.picks.push(to);
    expect((await a.ses.getState().saveAs("same")).ok).toBe(true);
    await tick(g.w, 2 * S, 250);
    expect(f.manifest.analysis_id).toBe(activeTab(a).analysisId);
    await noteFollows(g, g.path, to);
  });

  it("Save As the same analysis (both files stay): the note is beside the new file only", async () => {
    const g = await group(2, { delay: 500 });
    const [a] = g.cs;
    const to = `${DBX}/Second name.lag`;
    a.picks.push(to);
    expect((await a.ses.getState().saveAs("same")).ok).toBe(true);
    await tick(g.w, 2 * S, 250);
    await noteFollows(g, g.path, to);
    expect(myNotes(a, to, "d-a1a1").map((n) => n.note!.document_name)).toEqual(["Second name.lag"]);
  });
});

// ── RV-4 ─────────────────────────────────────────────────────────────────────

function fakeWindow(): { win: Window; fire: (ev: string) => void } {
  const handlers = new Map<string, (() => void)[]>();
  const win = { addEventListener: (ev: string, h: () => void) => { handlers.set(ev, [...(handlers.get(ev) ?? []), h]); } } as unknown as Window;
  return { win, fire: (ev) => { for (const h of handlers.get(ev) ?? []) h(); } };
}

describe("fixer round 2 RV-4: Edit here means editing now", () => {
  it("Edit here without typing: editable with my note editing for minutes (no 30 s rule); leaving the window ends it", async () => {
    const w = fakeWindow();
    const g = await group(2, { delay: 500, deps: [{}, { window: w.win }] });
    const [a, b] = g.cs;
    await editCell(a, "A1");
    await tick(g.w, 3 * S);
    expect(guardOf(b)).toBe("editingElsewhere");
    expect(await b.ses.getState().editHere()).toBe(true);
    await flush();
    expect(notesOf(b.dev, g.path, "d-b2b2")[0].note!.state).toBe("editing"); // at once (D10)
    for (let k = 0; k < 18; k++) {          // 3 min, B types nothing, A keeps typing
      await editCell(a, `A ${k}`);
      await tick(g.w, 10 * S, 500);
      expect(guardOf(b), `B at ${k}`).toBe(null);
      expect(notesOf(b.dev, g.path, "d-b2b2")[0].note!.state, `B's note at ${k}`).toBe("editing");
    }
    w.fire("blur");
    await flush();
    await tick(g.w, 3 * S, 500);
    expect(notesOf(b.dev, g.path, "d-b2b2")[0].note!.state).toBe("idle");
    await editCell(a, "A after");
    await tick(g.w, 5 * S, 500);
    expect(guardOf(b)).toBe("editingElsewhere");   // VP-2: read-only again while A edits on
  });

  it("Edit here, then a save: the usual 30 s after the save end the hold", async () => {
    const g = await group(2, { delay: 500 });
    const [a, b] = g.cs;
    await editCell(a, "A1");
    await tick(g.w, 3 * S);
    expect(await b.ses.getState().editHere()).toBe(true);
    await tick(g.w, 2 * MIN, 1000);
    expect(notesOf(b.dev, g.path, "d-b2b2")[0].note!.state).toBe("editing");
    await editCell(b, "B1");
    await b.ses.getState().save();
    await tick(g.w, 20 * S, 500);
    expect(notesOf(b.dev, g.path, "d-b2b2")[0].note!.state).toBe("editing");
    await tick(g.w, 15 * S, 500);
    expect(notesOf(b.dev, g.path, "d-b2b2")[0].note!.state).toBe("idle");
  });

  it("the other computer presses Edit here back: my clean tab is read-only at once", async () => {
    const g = await group(2, { delay: 500 });
    const [a, b] = g.cs;
    await editCell(a, "A1");
    await a.ses.getState().save();
    await tick(g.w, 3 * S);
    expect(guardOf(b)).toBe("editingElsewhere");     // A's 30 s after its save
    expect(await b.ses.getState().editHere()).toBe(true);
    await tick(g.w, 3 * S, 250);
    expect(guardOf(a)).toBe("editingElsewhere");     // A (clean) yielded to B's claim
    expect(await a.ses.getState().editHere()).toBe(true);
    await tick(g.w, 3 * S, 250);
    expect(guardOf(b)).toBe("editingElsewhere");
    expect(notesOf(b.dev, g.path, "d-b2b2")[0].note!.state).toBe("idle");
    expect(guardOf(a)).toBe(null);
  });

  it("a claim made after mine (that computer had not seen my note yet): my clean tab yields at once", async () => {
    const g = await group(2, { delay: 500 });
    const [a, b] = g.cs;
    await editCell(a, "A1");
    await tick(g.w, 3 * S);
    expect(await b.ses.getState().editHere()).toBe(true);
    await tick(g.w, 3 * S, 250);
    expect(modeOf(b)).toBe("bothEditing");
    // A third computer starts editing B's version without having seen B's note (written straight onto B's disk).
    const t = activeTab(b);
    const n: NoteJson = {
      format: "lasgraph-presence", v: 1, analysis_id: t.analysisId!, document_name: "Dose response.lag", device_id: "d-c3c3",
      session_id: "s-c", device_name: "Lab iMac", user_name: "Zhuo", state: "editing", head: t.baseRevision, base_revision: t.baseRevision,
      epoch: 1, seq: 1, supersedes: null, updated_at: new Date(g.w.clock.now()).toISOString(), request_to: null, handover_to: null, features: 2,
    };
    b.dev.placeNote(`${DBX}/Dose response (in use on Lab iMac, c3c3).laguse`, noteText(n));
    await tick(g.w, 2 * S, 250);
    expect(readOnly(b)).toBe(true);
    expect(notesOf(b.dev, g.path, "d-b2b2")[0].note!.state).toBe("idle");
  });
});
