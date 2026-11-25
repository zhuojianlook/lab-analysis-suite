/* Phase 4 UI (phase 4 contract §6, checklist U1): every new string, the label of
   `combine` per banner state, the word sweep of §6.8, and the dialog's blocks
   rendered to static markup (the dialog itself is a portal; its parts are not). */

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  CombineSectionViewP4, CombineStateP4, CompareResult, FineAdjustment, FineAuto, FineConflict, TabBanner, VersionInfo,
} from "../file/contract";
import { LIMITS_P4 } from "../file/contract";
import type { GraphDoc } from "../../../api/graph";
import type { DocContent } from "../../../store/graphStore";
import { defaultAnalysis, defaultFigure } from "../graphModel";
import textSource from "./text.ts?raw";
import {
  C, F, GROUP_TITLE, adjustmentLine, autoLine, bannerActionLabel, bannerSeverity, bannerText, conflictHeading, fieldLabel, orderCheckText,
  settingValue, shortValue, testName, type FineTextCtx,
} from "./text";
import { MiniRowTable, miniColumns, rowOthersDiffer } from "./CompareView";
import { VersionTable } from "./ReadOnlyViews";
import { CombineDialog } from "./CombineDialog";
import CombineDialogSource from "./CombineDialog.tsx?raw";
import ToastsSource from "./Toasts.tsx?raw";
import BannerSlotSource from "./BannerSlot.tsx?raw";
import { AutoList, ConflictBlock, SectionPane, WholeBlock, makeTextCtx, type DialogNames, type PaneCtx } from "./CombineFine";
import { asP4 } from "./CombineDialog";

const NOW = Date.parse("2026-11-22T12:00:00Z");
const v = (p: Partial<VersionInfo> = {}): VersionInfo =>
  ({ head: "r-x", userName: "Alice", deviceName: "Office iMac", time: new Date(NOW - 300_000).toISOString(), mine: false, ...p });
const settings = { userName: "Me", deviceName: "This Mac" };

// ── fixtures ───────────────────────────────────────────────────────────────

function doc(p: Partial<GraphDoc> & { cells: string[][][] }): GraphDoc {
  const nRows = p.cells.length;
  const nCols = p.cells[0]?.length ?? 0;
  return {
    v: 1, template: "column", x_title: "", n_rep: 1,
    col_titles: Array.from({ length: nCols }, (_, c) => `G${c + 1}`),
    row_titles: Array.from({ length: nRows }, () => ""),
    x: Array.from({ length: nRows }, () => ""),
    row_ids: Array.from({ length: nRows }, (_, r) => `row-${r + 1}`),
    col_ids: Array.from({ length: nCols }, (_, c) => `col-${c + 1}`),
    ...p,
  };
}
const content = (d: GraphDoc, scratch = ""): DocContent =>
  ({ doc: d, analysis: defaultAnalysis(d.template, d.col_titles.length, d.cells.length), figure: defaultFigure(d.template, d.col_titles.length), scratch });

const cmp: CompareResult = {
  sections: [{ key: "table", same: false }, { key: "analysis", same: true }, { key: "figure", same: true }, { key: "scratchpad", same: true }],
  table: { changedCells: 1, addedRows: 0, removedRows: 0, addedCols: 0, removedCols: 0, changedTitles: 0, cells: [] },
  settings: [], scratchpadCells: 0,
};

const mineDoc = doc({ cells: [[["1"], ["2"], ["3"]], [["4"], ["5"], ["6"]], [["7"], ["8"], ["9"]]], col_titles: ["WT", "KO", ""] });
const theirsDoc = doc({ cells: [[["10"], ["2"], ["3"]], [["4"], ["5"], ["6"]], [["7"], ["8"], ["9"]]], col_titles: ["WT", "KO", ""] });

const rowConflict: FineConflict = {
  id: "table:row:row-1", section: "table", kind: "row", rowId: "row-1", options: ["mine", "theirs"], more: 0,
  items: [{ what: "cell", rowId: "row-1", colId: "col-1", rep: 0, base: "0", mine: "1", theirs: "10" }],
};

function section(p: Partial<CombineSectionViewP4> & { key: CombineSectionViewP4["key"] }): CombineSectionViewP4 {
  return { status: "both", choice: null, level: "fine", conflicts: [], choices: {}, left: 0, combined: 0, auto: [], orderChecks: [], ...p };
}

function state(sections: CombineSectionViewP4[], p: Partial<CombineStateP4> = {}): CombineStateP4 {
  return {
    tabKey: "t1", name: "Dose response", origin: "save", source: { kind: "disk" }, copyName: null, index: 1, total: 1,
    mine: v({ userName: "Me", deviceName: "This Mac", mine: true }), mineUnsaved: true, theirs: v(), since: v({ head: "r-b" }), twoWay: false,
    sections, adjusted: [], canApply: false, applying: false,
    mineContent: content(mineDoc), theirsContent: content(theirsDoc), compare: cmp, error: null,
    adjustments: [], toChoose: sections.reduce((a, s) => a + s.left, 0), combinedCount: 0, resultContent: null,
    ...p,
  };
}

const names: DialogNames = {
  mineName: "Mine", theirsName: "Alice's", mineWord: "mine", theirsWord: "Alice's", whoTheirs: "Alice (Office iMac)",
  mineLabel: "Mine: This Mac", theirsLabel: "Theirs: Alice (Office iMac)", fromMine: "from mine",
};
const sideWords = { mineShort: "mine", theirsShort: "Alice", minePhrase: F.onThisComputer, theirsPhrase: F.by("Alice (Office iMac)") };
const ctxOf = (s: CombineStateP4): PaneCtx => ({ s, names, text: makeTextCtx(s, sideWords), disabled: false });
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

// ── U1: texts ──────────────────────────────────────────────────────────────

describe("phase 4 wording (contract §6, U1)", () => {
  const b = (p: Partial<TabBanner>): TabBanner => ({ id: "x", kind: "savedOver", actions: ["combine"], dismissible: true, version: v(), ...p });

  it("the review banner and the label of combine per state", () => {
    expect(bannerText(b({ state: "review" }), settings))
      .toBe("Another computer saved over your last save. Nothing is lost — both sets of changes can be combined.");
    expect(bannerSeverity(b({ state: "review" }))).toBe("info");
    expect(bannerSeverity(b({ state: "choose" }))).toBe("warning");
    expect(bannerActionLabel("savedOver", "combine", "review")).toBe("Combine");
    expect(bannerActionLabel("savedOver", "combine", "choose")).toBe("Choose…");
    expect(bannerActionLabel("savedOver", "combine")).toBe("Choose…");
    expect(bannerActionLabel("newerOnDisk", "combine", "review")).toBe("Combine my changes with it");
    // Unchanged states.
    expect(bannerText(b({ state: "combining" }), settings)).toBe("Another computer saved over your last save. Nothing is lost — combining both now.");
    expect(bannerText(b({ state: "choose" }), settings)).toBe("Another computer saved over your last save. Nothing is lost. Choose what to keep.");
  });

  it("the combined banner names the parts holding changes from both", () => {
    const c = (p: Partial<TabBanner>) => bannerText({ id: "c", kind: "combined", actions: [], dismissible: true, version: v(), ...p }, settings);
    expect(c({ sections: [], mixed: ["table"] })).toBe("Combined with the version saved by Alice (Office iMac). Changes from both are in the table.");
    expect(c({ sections: ["figure"], mixed: ["table", "scratchpad"] }))
      .toBe("Combined with the version saved by Alice (Office iMac). Taken from it: the graph. Changes from both are in the table and the scratchpad.");
    expect(c({ sections: ["figure"] })).toBe("Combined with the version saved by Alice (Office iMac). Taken from it: the graph.");
    expect(c({ sections: ["figure"], mixed: [] })).toBe("Combined with the version saved by Alice (Office iMac). Taken from it: the graph.");
    expect(c({ sections: [], mixed: ["analysis"], version: v({ mine: true }) })).toBe("Combined with your earlier save. Changes from both are in the analysis settings.");
  });

  it("the dialog frame", () => {
    expect(C.toChoose(3)).toBe("3 to choose");
    expect([C.unchanged, C.combinedChip]).toEqual(["Unchanged", "Combined"]);
    expect(F.changesCombined(1)).toBe("1 change combined");
    expect(F.changesCombined(4)).toBe("4 changes combined");
    expect(C.combinedAuto(7)).toBe("Combined automatically (7)");
    expect(C.notChanged(2)).toBe("Not changed (2)");
    expect(C.twoWay).toBe("These two copies were last the same too long ago to compare cell by cell. Choose which to keep for each part that differs.");
    expect([C.cancel, C.keepBoth, C.apply]).toEqual(["Cancel", "Keep both as separate files", "Apply"]);
    expect(C.footnote).toBe("Nothing is saved until you press Apply. Both versions stay in the file's history.");
    expect(C.queue(2, 3)).toBe("Copy 2 of 3");
  });

  it("the blocks to choose (§6.2)", () => {
    expect(F.useAll("mine")).toBe("Use mine for all");
    expect(F.useAll("Alice's")).toBe("Use Alice's for all");
    expect(F.more(12)).toBe("and 12 more — use the buttons above to choose for all of them");
    expect(F.row(3, "")).toBe("Row 3");
    expect(F.row(3, "Day 2")).toBe("Row 3 · Day 2");
    expect(F.rowDeleted(2, F.onThisComputer, F.by("Alice (Office iMac)"))).toBe("Row 2 — deleted on this computer, changed by Alice (Office iMac)");
    expect(F.rowDeleted(2, F.by("Alice (Office iMac)"), F.onThisComputer)).toBe("Row 2 — deleted by Alice (Office iMac), changed on this computer");
    expect(F.colDeleted("KO", F.by("Alice (Office iMac)"), F.onThisComputer)).toBe("Column 'KO' — deleted by Alice (Office iMac), changed on this computer");
    expect(F.colDeleted("KO", F.onThisComputer, F.by("Alice (Office iMac)"))).toBe("Column 'KO' — deleted on this computer, changed by Alice (Office iMac)");
    expect([F.colTitle, F.xTitle]).toEqual(["Column title", "X title"]);
    expect(F.quoted("Mine", "Dose", "Alice's", "Dose (µM)")).toBe("Mine: 'Dose' · Alice's: 'Dose (µM)'");
    expect(F.values("Mine", "0.05", "Alice's", "0.01")).toBe("Mine: 0.05 · Alice's: 0.01");
    expect(GROUP_TITLE).toEqual({ colours: "Colours", size: "Size", yRange: "Y axis range" });
    expect(F.groupLine("Y axis from", "mine", "0", "Alice's", "10")).toBe("Y axis from: mine 0 · Alice's 10");
    expect(F.seriesLabel("WT")).toBe("Legend label of 'WT'");
    expect(F.valuesChanged(1)).toBe("1 value changed");
    expect(F.valuesChanged(3)).toBe("3 values changed");
    expect([F.deleteRow, F.keepRow, F.deleteCol, F.keepCol]).toEqual(["Delete the row", "Keep the row", "Delete the column", "Keep the column"]);
    expect(shortValue("")).toBe("(empty)");
    expect(shortValue(null)).toBe("(empty)");
    expect(fieldLabel("y_min")).toBe("Y axis from");
    expect(fieldLabel("my_new_setting")).toBe("My new setting");
  });

  it("whole choices (§6.3)", () => {
    expect(F.wholeTwoWay).toBe("These two copies were last the same too long ago to compare cell by cell. Keep:");
    expect(F.wholeShift).toBe("The scratchpad was rearranged on one computer, so it can't be combined cell by cell. Keep:");
    expect(F.wholeTable).toBe("These two tables are too different to combine row by row. Keep:");
    expect([F.bothSeparate, F.bothSideBySide]).toEqual(["Both as separate files", "Both side by side"]);
    expect(F.bothCaption).toBe("Both side by side puts the other sheet to the right of yours.");
  });

  it("adjusted automatically and the order notes (§6.4)", () => {
    const x = { colTitle: (id: string) => (id === "col-2" ? "KO" : id === "col-1" ? "WT" : ""), rowNo: () => 4, rowTitle: (id: string) => (id === "row-9" ? "Day 9" : "") };
    const a = (p: Partial<FineAdjustment>): FineAdjustment => ({ section: "analysis", kind: "setting", from: null, to: null, ...p });
    expect(F.adjustedTitle(2)).toBe("Adjusted automatically (2)");
    expect(F.adjustedFoot).toBe("Check the result after applying.");
    // Never a hidden id or a test's code: the column's title and the test's name.
    expect(adjustmentLine(a({ field: "control", from: "col-2", to: "" }), x)).toBe("Control group: KO → (empty)");
    expect(adjustmentLine(a({ field: "pairs", from: '[["col-1","col-2"]]', to: "[]" }), x)).toBe("Chosen pairs: [[WT,KO]] → []");
    expect(adjustmentLine(a({ field: "pairs", from: '[["row-9","row-3"]]', to: "[]" }), x)).toBe("Chosen pairs: [[Day 9,Row 4]] → []");
    expect(adjustmentLine(a({ field: "test", from: "welch_t", to: "anova" }), x)).toBe("Test: Welch's t test → One-way ANOVA");
    expect(adjustmentLine(a({ field: "posthoc", from: "none", to: "tukey" }), x)).toBe("Follow-up test: None → Tukey");
    expect(settingValue("title", 'A "quoted" title')).toBe('A "quoted" title');
    expect(adjustmentLine(a({ field: "compare", from: "control", to: "all" }), x)).toBe("Comparisons: Vs control → All pairs");
    expect(adjustmentLine(a({ section: "figure", field: "series.col-2" }), x)).toBe("Colour and label of 'KO'");
    expect(adjustmentLine(a({ kind: "testNotRun", field: "test", from: "paired_t", to: "none" }), x)).toBe("The chosen test (Paired t test) can't run on the combined table.");
    expect(adjustmentLine(a({ kind: "comparisons", field: "pairs" }), x)).toBe("Some chosen comparisons are not used with the combined table.");
    expect(adjustmentLine(a({ section: "table", kind: "replicates", from: "3", to: "4" }), x)).toBe("Replicates kept at 4 so no values are dropped.");
    expect(adjustmentLine(a({ section: "table", kind: "table" }), x)).toBe("The table was tidied up.");
    expect(adjustmentLine(a({ section: "scratchpad", kind: "scratchpad" }), x)).toBe("The scratchpad was tidied up.");
    expect(orderCheckText({ axis: "row" })).toBe("Row order — please check. Both computers added rows in the same place.");
    expect(orderCheckText({ axis: "col" })).toBe("Column order — please check. Both computers added columns in the same place.");
    expect(testName("welch_t")).toBe("Welch's t test");
    expect(testName("zz")).toBe("zz");
  });

  const tx: FineTextCtx = {
    rowNo: (id) => ({ "row-1": 1, "row-3": 3 } as Record<string, number>)[id] ?? null,
    rowTitle: (id) => (id === "row-3" ? "Day 3" : ""),
    colTitle: (id) => ({ "col-1": "Group A", "col-2": "KO" } as Record<string, string>)[id] ?? "",
    nRep: 1, ...sideWords,
  };
  const au = (p: Partial<FineAuto> & Pick<FineAuto, "what">): FineAuto => ({ from: "mine", before: null, after: null, ...p });

  it("combined automatically lines (§6.2)", () => {
    expect(autoLine(au({ what: "cell", rowId: "row-3", colId: "col-1", rep: 0, before: "5.1", after: "5.4" }), tx)).toBe("Row 3, Group A: 5.1 → 5.4 (mine)");
    expect(autoLine(au({ what: "cell", rowId: "row-3", colId: "col-1", rep: 1, before: "", after: "2" }), { ...tx, nRep: 3 })).toBe("Row 3, Group A, value 2: (empty) → 2 (mine)");
    expect(autoLine(au({ what: "rowAdded", from: "theirs", rowId: "row-9" }), tx)).toBe("Row added (Alice)");
    expect(autoLine(au({ what: "colRemoved", colId: "col-2", before: "KO" }), tx)).toBe("Column 'KO' removed (mine)");
    expect(autoLine(au({ what: "colAdded", from: "theirs", colId: "col-7", after: "Dose" }), tx)).toBe("Column 'Dose' added (Alice)");
    expect(autoLine(au({ what: "xTitle", from: "theirs", before: "", after: "Dose" }), tx)).toBe("X title: '' → 'Dose' (Alice)");
    expect(autoLine(au({ what: "colTitle", colId: "col-1", before: "", after: "WT" }), tx)).toBe("Column title: '' → 'WT' (mine)");
    expect(autoLine(au({ what: "scratch", addr: "B2", before: "1", after: "2" }), tx)).toBe("B2: 1 → 2 (mine)");
    expect(autoLine(au({ what: "replicates", from: "theirs", before: "3", after: "4" }), tx)).toBe("Replicates: 3 → 4 (Alice)");
    expect(autoLine(au({ what: "field", field: "alpha", from: "same", before: "0.05", after: "0.01" }), tx)).toBe("Significance level: 0.05 → 0.01 (both)");
    expect(autoLine(au({ what: "group", group: "yRange", from: "theirs" }), tx)).toBe("Y axis range (Alice)");
    expect(autoLine(au({ what: "rowRemoved", rowId: "row-3", before: "Day 3" }), tx)).toBe("Row 'Day 3' removed (mine)");
    expect(autoLine(au({ what: "rowRemoved", rowId: "row-4", before: "" }), tx)).toBe("Row removed (mine)");
    expect(autoLine(au({ what: "rowTitle", rowId: "row-3", before: "", after: "Day 3" }), tx)).toBe("Row 3 title: '' → 'Day 3' (mine)");
    expect(autoLine(au({ what: "x", rowId: "row-1", before: "1", after: "2" }), tx)).toBe("Row 1, X: 1 → 2 (mine)");
    expect(autoLine(au({ what: "seriesLabel", colId: "col-2", before: "", after: "Knock-out" }), tx)).toBe("Legend label of 'KO': '' → 'Knock-out' (mine)");
    expect(autoLine(au({ what: "colWidth", field: "C", before: "80", after: "120" }), tx)).toBe("Width of column C: 80 → 120 (mine)");
  });

  it("headings (§6.2)", () => {
    const c = (p: Partial<FineConflict> & Pick<FineConflict, "kind">): FineConflict => ({ id: "x", section: "table", options: ["mine", "theirs"], items: [], more: 0, ...p });
    expect(conflictHeading(c({ kind: "row", rowId: "row-1" }), tx)).toBe("Row 1");
    expect(conflictHeading(c({ kind: "row", rowId: "row-3" }), tx)).toBe("Row 3 · Day 3");
    expect(conflictHeading(c({ kind: "rowDeleted", rowId: "row-3", deletedBy: "theirs" }), tx)).toBe("Row 3 — deleted by Alice (Office iMac), changed on this computer");
    expect(conflictHeading(c({ kind: "rowDeleted", rowId: "row-3", deletedBy: "mine" }), tx)).toBe("Row 3 — deleted on this computer, changed by Alice (Office iMac)");
    expect(conflictHeading(c({ kind: "colDeleted", colId: "col-2", deletedBy: "theirs" }), tx)).toBe("Column 'KO' — deleted by Alice (Office iMac), changed on this computer");
    expect(conflictHeading(c({ kind: "colTitle", colId: "col-2" }), tx)).toBe("Column title");
    expect(conflictHeading(c({ kind: "tableField", field: "x_title" }), tx)).toBe("X title");
    expect(conflictHeading(c({ kind: "field", section: "analysis", field: "alpha" }), tx)).toBe("Significance level");
    expect(conflictHeading(c({ kind: "group", section: "figure", group: "yRange" }), tx)).toBe("Y axis range");
    expect(conflictHeading(c({ kind: "group", section: "figure", group: "colours" }), tx)).toBe("Colours");
    expect(conflictHeading(c({ kind: "seriesLabel", section: "figure", colId: "col-1" }), tx)).toBe("Legend label of 'Group A'");
    expect(conflictHeading(c({ kind: "cell", section: "scratchpad", addr: "B12" }), tx)).toBe("B12");
  });

  it("never uses internal words in the new strings (§6.8)", () => {
    const all: string[] = [];
    const texts = (o: Record<string, unknown>) => {
      for (const x of Object.values(o)) {
        if (typeof x === "string") all.push(x);
        else if (typeof x === "function") {
          all.push(String((x as (...a: unknown[]) => unknown)("Dose response", "Office iMac", "2 h ago", "x")));
          all.push(String((x as (...a: unknown[]) => unknown)(2, 3, 4, 5)));
        }
      }
    };
    texts(F); texts(GROUP_TITLE);
    all.push(C.twoWay, bannerText({ id: "r", kind: "savedOver", state: "review", actions: [], dismissible: true }, settings));
    all.push(bannerActionLabel("savedOver", "combine", "review"));
    all.push(bannerText({ id: "c", kind: "combined", actions: [], dismissible: true, version: v(), sections: ["figure"], mixed: ["table"] }, settings));
    const kinds: FineConflict["kind"][] = ["row", "rowDeleted", "colDeleted", "colTitle", "tableField", "field", "group", "seriesLabel", "cell"];
    for (const kind of kinds) all.push(conflictHeading({ id: "x", section: "table", kind, rowId: "row-3", colId: "col-2", field: "alpha", group: "size", addr: "A1", deletedBy: "mine", options: [], items: [], more: 0 }, tx));
    const whats: FineAuto["what"][] = ["cell", "rowTitle", "x", "colTitle", "xTitle", "replicates", "rowAdded", "rowRemoved", "colAdded", "colRemoved", "field", "group", "seriesLabel", "scratch", "colWidth"];
    for (const what of whats) for (const from of ["mine", "theirs", "same"] as const) all.push(autoLine(au({ what, from, rowId: "row-3", colId: "col-1", field: "alpha", group: "colours", addr: "B2", before: "1", after: "2" }), tx));
    for (const kind of ["setting", "testNotRun", "comparisons", "replicates", "table", "scratchpad"] as const) {
      all.push(adjustmentLine({ section: "analysis", kind, field: "pairs", from: "a", to: "b" }, tx));
    }
    all.push(orderCheckText({ axis: "row" }), orderCheckText({ axis: "col" }));
    expect(all.length).toBeGreaterThan(100);
    const banned = /\b(conflicts?|three-way|two-way|fine-level|atomic|shifts?|shifted|offsets?|replicate index|revisions?|heads?|journal|hash|manifest|merge[ds]?|lca|base|ancestor|field|fields|section|sections)\b/i;
    for (const s of all) expect(s, s).not.toMatch(banned);
    // Never an id.
    for (const s of all) expect(s, s).not.toMatch(/\b(row|col)-[0-9a-z]+/);
    // The whole source: "conflict" only as "conflicted copy" in a string literal.
    const literals = textSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").match(/(["'`])(?:\\.|(?!\1).)*\1/g) ?? [];
    for (const l of literals) {
      expect(l).not.toMatch(/\b(three-way|two-way|fine-level|atomic|replicate index)\b/i);
      expect(l.replace(/conflicted copy/gi, "")).not.toMatch(/\bconflicts?\b/i);
    }
  });
});

// ── the blocks, rendered ───────────────────────────────────────────────────

describe("the combine dialog's blocks (§6.2–6.4)", () => {
  it("miniColumns: the differing columns plus up to 6 neighbours", () => {
    const ids = Array.from({ length: 20 }, (_, i) => `c${i}`);
    expect(miniColumns(ids, new Set(["c10"]))).toEqual(["c7", "c8", "c9", "c10", "c11", "c12", "c13"]);
    expect(miniColumns(ids, new Set(["c0"]))).toEqual(["c0", "c1", "c2", "c3", "c4", "c5", "c6"]);
    expect(miniColumns(ids.slice(0, 3), new Set(["c1"]))).toEqual(["c0", "c1", "c2"]);
    expect(miniColumns(ids, new Set())).toEqual(ids.slice(0, 6));
  });

  it("a row to choose: the mini-table with both lines, the differing cell marked on both", () => {
    const out = html(createElement(MiniRowTable, {
      rowId: "row-1", items: rowConflict.items,
      sides: [{ side: "mine", label: "Mine", doc: mineDoc }, { side: "theirs", label: "Alice's", doc: theirsDoc }],
    }));
    expect(out).toContain('data-testid="combine-conflict-table"');
    expect(out.match(/data-testid="combine-conflict-cell"/g)?.length).toBe(6);
    expect(out.match(/data-diff="true"/g)?.length).toBe(2);
    expect(out).toMatch(/data-side="mine" data-diff="true" data-col="col-1" data-rep="0"[^>]*>1</);
    expect(out).toMatch(/data-side="theirs" data-diff="true" data-col="col-1" data-rep="0"[^>]*>10</);
    expect(out).toContain(">WT<");
    expect(out).toContain(">Group C<"); // a blank column title as the table shows it
    expect(out).toContain(">Alice&#x27;s<");
  });

  it("a row block: heading, buttons, choice and tint", () => {
    const s = state([section({ key: "table", conflicts: [rowConflict], left: 1 })]);
    const none = html(createElement(ConflictBlock, { c: rowConflict, choice: null, ctx: ctxOf(s) }));
    expect(none).toContain('data-testid="combine-conflict"');
    expect(none).toContain('data-id="table:row:row-1"');
    expect(none).toContain('data-kind="row"');
    expect(none).toContain('data-choice=""');
    expect(none).toContain(">Row 1<");
    expect(none).toMatch(/data-testid="combine-conflict-mine"[^>]*aria-pressed="false"[^>]*>Mine</);
    expect(none).toMatch(/data-testid="combine-conflict-theirs"[^>]*>Alice&#x27;s</);
    const chosen = html(createElement(ConflictBlock, { c: rowConflict, choice: "theirs", ctx: ctxOf(s) }));
    expect(chosen).toContain('data-choice="theirs"');
    expect(chosen).toMatch(/data-testid="combine-conflict-theirs"[^>]*aria-pressed="true"/);
  });

  it("a deleted column: the heading names who deleted it, the buttons say delete / keep", () => {
    const c: FineConflict = {
      id: "table:col:col-3", section: "table", kind: "colDeleted", colId: "col-3", deletedBy: "theirs", options: ["mine", "theirs"], more: 0,
      items: [{ what: "cell", rowId: "row-2", colId: "col-3", rep: 0, base: "6", mine: "60", theirs: null }],
    };
    const out = html(createElement(ConflictBlock, { c, choice: null, ctx: ctxOf(state([])) }));
    expect(out).toContain("Column &#x27;Group C&#x27; — deleted by Alice (Office iMac), changed on this computer");
    expect(out).toContain("1 value changed");
    expect(out).toContain("Row 2: 6 → 60");
    expect(out).toMatch(/data-testid="combine-conflict-theirs"[^>]*>Delete the column</);
    expect(out).toMatch(/data-testid="combine-conflict-mine"[^>]*>Keep the column</);
    expect(out.indexOf("Delete the column")).toBeLessThan(out.indexOf("Keep the column"));
  });

  it("a deleted row: only the side that still has it", () => {
    const c: FineConflict = {
      id: "table:row:row-2", section: "table", kind: "rowDeleted", rowId: "row-2", deletedBy: "mine", options: ["mine", "theirs"], more: 0,
      items: [{ what: "cell", rowId: "row-2", colId: "col-2", rep: 0, base: "5", mine: null, theirs: "50" }],
    };
    const out = html(createElement(ConflictBlock, { c, choice: null, ctx: ctxOf(state([])) }));
    expect(out).toContain("Row 2 — deleted on this computer, changed by Alice (Office iMac)");
    expect(out).toContain('data-side="theirs"');
    expect(out).not.toContain('<tr data-side="mine"');
    expect(out).toMatch(/data-testid="combine-conflict-mine"[^>]*>Delete the row</);
    expect(out).toMatch(/data-testid="combine-conflict-theirs"[^>]*>Keep the row</);
  });

  it("settings, groups and scratchpad cells", () => {
    const ctx = ctxOf(state([]));
    const f: FineConflict = { id: "analysis:field:alpha", section: "analysis", kind: "field", field: "alpha", options: ["mine", "theirs"], more: 0,
      items: [{ what: "field", field: "alpha", base: "0.05", mine: "0.01", theirs: "0.1" }] };
    expect(html(createElement(ConflictBlock, { c: f, choice: null, ctx }))).toContain("Mine: 0.01 · Alice&#x27;s: 0.1");
    const g: FineConflict = { id: "figure:group:yRange", section: "figure", kind: "group", group: "yRange", options: ["mine", "theirs"], more: 0,
      items: [{ what: "field", field: "y_min", base: "", mine: "0", theirs: "" }, { what: "field", field: "y_max", base: "", mine: "", theirs: "100" }] };
    const go = html(createElement(ConflictBlock, { c: g, choice: null, ctx }));
    expect(go).toContain(">Y axis range<");
    expect(go).toContain("Y axis from: mine 0 · Alice&#x27;s (empty)");
    expect(go).toContain("Y axis to: mine (empty) · Alice&#x27;s 100");
    const col: FineConflict = { id: "figure:group:colours", section: "figure", kind: "group", group: "colours", options: ["mine", "theirs"], more: 0,
      items: [{ what: "seriesColor", colId: "col-1", base: "#111111", mine: "#ff0000", theirs: "#00ff00" }] };
    const co = html(createElement(ConflictBlock, { c: col, choice: null, ctx }));
    expect(co).toContain('data-testid="combine-conflict-swatch"');
    expect(co).toContain("background-color:#ff0000");
    const cell: FineConflict = { id: "scratchpad:cell:B2", section: "scratchpad", kind: "cell", addr: "B2", row: 2, col: 2, options: ["mine", "theirs"], more: 0,
      items: [{ what: "scratch", addr: "B2", base: "1", mine: "5", theirs: null }, { what: "scratchFormat", addr: "B2", base: "", mine: "0.00", theirs: "" }] };
    const ce = html(createElement(ConflictBlock, { c: cell, choice: null, ctx }));
    expect(ce).toContain(">B2<");
    expect(ce).toContain("Mine: 5 · Alice&#x27;s: (empty)");
    expect(ce).toContain("Number format: mine 0.00 · Alice&#x27;s (empty)");
  });

  it("whole choices: two-way, rearranged scratchpad (with and without both), table", () => {
    const ctx = ctxOf(state([]));
    const w = (reason: "twoWay" | "shift" | "table", options: FineConflict["options"]): FineConflict =>
      ({ id: "scratchpad:section", section: "scratchpad", kind: "section", reason, options, items: [], more: 0 });
    const two = html(createElement(WholeBlock, { c: w("twoWay", ["mine", "theirs"]), choice: null, ctx }));
    expect(two).toContain('data-reason="twoWay"');
    expect(two).toContain(F.wholeTwoWay);
    expect(two).toContain('data-testid="combine-keep-separate"');
    expect(two).not.toContain("combine-conflict-both");
    const shift = html(createElement(WholeBlock, { c: w("shift", ["mine", "theirs", "both"]), choice: "both", ctx }));
    expect(shift).toContain("The scratchpad was rearranged on one computer, so it can&#x27;t be combined cell by cell. Keep:");
    expect(shift).toMatch(/data-testid="combine-conflict-both"[^>]*aria-pressed="true"[^>]*>Both side by side</);
    expect(shift).toContain(F.bothCaption);
    expect(shift).not.toContain("combine-keep-separate");
    const noBoth = html(createElement(WholeBlock, { c: w("shift", ["mine", "theirs"]), choice: null, ctx }));
    expect(noBoth).not.toContain("combine-conflict-both");
    expect(noBoth).not.toContain(F.bothCaption);
    expect(html(createElement(WholeBlock, { c: w("table", ["mine", "theirs"]), choice: null, ctx }))).toContain(F.wholeTable);
  });

  it("the pane: use-all buttons from two blocks, a cap at 200 blocks, the order note with markers", () => {
    const many = Array.from({ length: LIMITS_P4.dialogConflicts + 5 }, (_, i): FineConflict => ({ ...rowConflict, id: `table:row:row-${i + 1}`, rowId: `row-${i + 1}` }));
    const sec = section({ key: "table", conflicts: many, left: many.length });
    const out = html(createElement(SectionPane, { sec, ctx: ctxOf(state([sec])) }));
    expect(out.match(/data-testid="combine-conflict"/g)?.length).toBe(LIMITS_P4.dialogConflicts);
    expect(out).toContain('data-testid="combine-more"');
    expect(out).toContain("and 5 more — use the buttons above to choose for all of them");
    expect(out).toMatch(/data-testid="combine-all-mine"[^>]*>Use mine for all</);
    expect(out).toMatch(/data-testid="combine-all-theirs"[^>]*>Use Alice&#x27;s for all</);
    // One block: no use-all buttons.
    const one = section({ key: "table", conflicts: [rowConflict], left: 1 });
    expect(html(createElement(SectionPane, { sec: one, ctx: ctxOf(state([one])) }))).not.toContain("combine-all-mine");
    // Nothing to choose, an order to check: the note, the combined order with markers, the side-by-side view.
    const result = content(doc({ cells: [[["1"], ["2"], ["3"]], [["3"], ["3"], ["3"]], [["4"], ["5"], ["6"]]], row_ids: ["row-1", "row-x", "row-2"] }));
    const ord = section({ key: "table", combined: 2, orderChecks: [{ axis: "row", ids: ["row-x"], matters: true }, { axis: "col", ids: [], matters: false }],
      auto: [{ what: "rowAdded", from: "theirs", rowId: "row-x", before: null, after: "" }, { what: "rowAdded", from: "mine", rowId: "row-y", before: null, after: "" }] });
    const o = html(createElement(SectionPane, { sec: ord, ctx: ctxOf(state([ord], { resultContent: result, canApply: true })) }));
    expect(o.match(/data-testid="combine-order-check"/g)?.length).toBe(1);
    expect(o).toContain('data-axis="row"');
    // Fixer VUX-2: the note names the rows (by their place in the combined table).
    expect(o).toContain("Row order — please check (row 2). Both computers added rows in the same place.");
    expect(o).toContain('data-testid="combine-table-result"');
    expect(o).toMatch(/data-testid="order-mark" data-axis="row"/);
    expect(o).toContain('data-testid="combine-side-by-side"');
    expect(o).toMatch(/data-testid="combine-auto-list" data-open="true"/);
    expect(o).toContain("Combined automatically (2)");
    expect(o.match(/data-testid="combine-auto-item"/g)?.length).toBe(2);
  });

  it("the automatic list is collapsed while the part has something to choose, and counts what is not listed", () => {
    const sec = section({ key: "table", conflicts: [rowConflict], left: 1, combined: 60,
      auto: [{ what: "cell", from: "theirs", rowId: "row-2", colId: "col-1", rep: 0, before: "4", after: "40" }] });
    const out = html(createElement(AutoList, { sec, ctx: ctxOf(state([sec])), initiallyOpen: false }));
    expect(out).toContain('data-open="false"');
    expect(out).toContain("Combined automatically (60)");
    const open = html(createElement(AutoList, { sec, ctx: ctxOf(state([sec])), initiallyOpen: true }));
    expect(open).toContain("Row 2, WT: 4 → 40 (Alice)");
    expect(open).toContain("and 59 more");
  });

  it("reads a phase 2 dialog state as one with nothing to choose inside", () => {
    const p2 = state([]);
    const legacy = {
      ...p2, sections: [{ key: "table", status: "both", choice: null }, { key: "analysis", status: "mine", choice: "mine" }],
    } as unknown as CombineStateP4;
    for (const k of ["adjustments", "toChoose", "combinedCount", "resultContent"] as const) delete (legacy as Partial<CombineStateP4>)[k];
    const s = asP4(legacy);
    expect(s.toChoose).toBe(1);
    expect(s.combinedCount).toBe(1);
    expect(s.adjustments).toEqual([]);
    expect(s.sections[0]).toMatchObject({ level: "whole", conflicts: [], left: 1 });
    expect(s.sections[1]).toMatchObject({ level: "whole", left: 0 });
  });
});

// ── fixer: the UI findings of the phase 4 review ───────────────────────────

describe("fixer: the combine dialog after the phase 4 review", () => {
  const wide = doc({
    template: "grouped", n_rep: 5,
    cells: [Array.from({ length: 12 }, (_, c) => Array.from({ length: 5 }, (_, k) => `${c}.${k}`))],
    col_titles: Array.from({ length: 12 }, (_, c) => `G${c + 1}`), row_titles: ["Mouse 1"],
  });
  const wideTheirs = { ...wide, cells: [wide.cells[0].map((reps, c) => reps.map((x, k) => (c === 0 && k === 0 ? "T" : c === 5 && k === 2 ? "U" : x)))] };

  it("VUX-5: a wide row shows the values to choose without the whole row; the count is in the heading; no title column when the titles agree", () => {
    expect(miniColumns(Array.from({ length: 12 }, (_, i) => `c${i}`), new Set(["c0", "c5", "c11"]), 5)).toEqual(["c0", "c5", "c11"]);
    expect(miniColumns(Array.from({ length: 12 }, (_, i) => `c${i}`), new Set(["c5"]), 1)).toEqual(["c2", "c3", "c4", "c5", "c6", "c7", "c8"]);
    const items = [
      { what: "cell" as const, rowId: "row-1", colId: "col-1", rep: 0, base: "x", mine: "0.0", theirs: "T" },
      { what: "cell" as const, rowId: "row-1", colId: "col-6", rep: 2, base: "x", mine: "5.2", theirs: "U" },
    ];
    const out = html(createElement(MiniRowTable, {
      rowId: "row-1", items, sides: [{ side: "mine", label: "Mine", doc: wide }, { side: "theirs", label: "Alice's", doc: wideTheirs }],
    }));
    expect(out.match(/<th[^>]*colSpan="5"/gi)?.length ?? out.match(/colspan="5"/g)?.length).toBe(2);   // two columns, not twelve
    expect(out).not.toContain(">Row title<");
    const c: FineConflict = { id: "table:row:row-1", section: "table", kind: "row", rowId: "row-1", options: ["mine", "theirs"], more: 0, items };
    const s = state([section({ key: "table", conflicts: [c], left: 1 })], { mineContent: content(wide), theirsContent: content(wideTheirs) });
    expect(html(createElement(ConflictBlock, { c, choice: null, ctx: ctxOf(s) }))).toContain("2 values to choose");
  });

  it("VUX-1: other values of the row that only one side changed are named; once chosen, a third line shows the row as saved", () => {
    const m2 = doc({ cells: [[["1"], ["2"], ["3"]]] });
    const t2 = doc({ cells: [[["10"], ["20"], ["3"]]] });
    const sides = [{ side: "mine" as const, label: "Mine", doc: m2 }, { side: "theirs" as const, label: "Alice's", doc: t2 }];
    const items = [{ what: "cell" as const, rowId: "row-1", colId: "col-1", rep: 0, base: "0", mine: "1", theirs: "10" }];
    expect(rowOthersDiffer("row-1", sides, items)).toBe(1);
    const c: FineConflict = { id: "table:row:row-1", section: "table", kind: "row", rowId: "row-1", options: ["mine", "theirs"], more: 0, items };
    const s0 = state([section({ key: "table", conflicts: [c], left: 1 })], { mineContent: content(m2), theirsContent: content(t2) });
    expect(html(createElement(ConflictBlock, { c, choice: null, ctx: ctxOf(s0) }))).toContain("1 other value in this row changed on one side only and is kept whichever you choose.");
    const result = content(doc({ cells: [[["1"], ["20"], ["3"]]] }));
    const s1 = state([section({ key: "table", conflicts: [c], left: 0, choices: { [c.id]: "mine" } })],
      { mineContent: content(m2), theirsContent: content(t2), resultContent: result, canApply: true });
    const out = html(createElement(ConflictBlock, { c, choice: "mine", ctx: ctxOf(s1) }));
    expect(out).toContain('data-testid="combine-conflict-result"');
    expect(out).toContain(">Combined<");
    expect(out).toMatch(/data-side="result" data-col="col-2" data-rep="0" data-other="true"[^>]*>20</);
    expect(out).not.toContain("kept whichever you choose");
  });

  it("VUX-2: marked rows below the first 60 are shown with their neighbours", () => {
    const n = 100;
    const big = doc({ template: "xy", cells: Array.from({ length: n }, (_, r) => [[String(r)]]), x: Array.from({ length: n }, (_, r) => String(r)) });
    const marks = new Set(["row-81", "row-82"]);
    const out = html(createElement(VersionTable, { doc: big, dense: true, maxRows: 60, markRows: marks, markTitle: "m", nearMarked: true }));
    expect(out.match(/data-testid="order-mark"/g)?.length).toBe(2);
    expect(out).toContain('data-testid="table-near-marked"');
    expect(out).toContain('data-row="78"');
    expect(out).not.toContain('data-row="1"');
    // Without the option (or with the marks on top) the first rows as before.
    const top = html(createElement(VersionTable, { doc: big, dense: true, maxRows: 60, markRows: new Set(["row-2"]), markTitle: "m", nearMarked: true }));
    expect(top).not.toContain("table-near-marked");
    expect(top.match(/data-testid="order-mark"/g)?.length).toBe(1);
    const ord = section({ key: "table", orderChecks: [{ axis: "row", ids: ["row-81", "row-82"], matters: true }] });
    const o = html(createElement(SectionPane, { sec: ord, ctx: ctxOf(state([ord], { resultContent: content(big), canApply: true })) }));
    expect(o).toContain("Row order — please check (rows 81–82). Both computers added rows in the same place.");
    expect(o.match(/data-testid="order-mark"/g)!.length).toBeGreaterThanOrEqual(2);
  });

  it("VUX-4: with some chosen, 'Use … for the rest' appears", () => {
    const many = Array.from({ length: 3 }, (_, i): FineConflict => ({ ...rowConflict, id: `table:row:row-${i + 1}`, rowId: `row-${i + 1}` }));
    const none = section({ key: "table", conflicts: many, left: 3 });
    expect(html(createElement(SectionPane, { sec: none, ctx: ctxOf(state([none])) }))).not.toContain("combine-rest-mine");
    const some = section({ key: "table", conflicts: many, left: 2, choices: { [many[0].id]: "theirs" } });
    const out = html(createElement(SectionPane, { sec: some, ctx: ctxOf(state([some])) }));
    expect(out).toMatch(/data-testid="combine-rest-mine"[^>]*>Use mine for the rest</);
    expect(out).toMatch(/data-testid="combine-rest-theirs"[^>]*>Use Alice&#x27;s for the rest</);
  });

  it("VUX-7: blank rows at the end are not counted as added or removed in the part's summary", () => {
    const m3 = doc({ cells: [[["1"]], [["2"]], [[""]]], row_ids: ["row-1", "row-2", "row-pm"] });
    const t3 = doc({ cells: [[["1"]], [["3"]], [[""]]], row_ids: ["row-1", "row-2", "row-pt"] });
    const c3: CompareResult = { ...cmp, table: { ...cmp.table, changedCells: 1, addedRows: 1, removedRows: 1 } };
    const sec = section({ key: "table" });
    const out = html(createElement(SectionPane, { sec, ctx: ctxOf(state([sec], { compare: c3, mineContent: content(m3), theirsContent: content(t3) })) }));
    expect(out).toContain("1 cell differs");
    expect(out).not.toMatch(/row added|rows added|row removed|rows removed/);
  });

  it("VUX-8 / VUX-3 / VUX-10: the group counts parts; a click beside the window does not close it; no toasts over it", () => {
    expect(F.combinedParts(2)).toBe("Combined automatically (2 parts)");
    expect(F.combinedParts(1)).toBe("Combined automatically (1 part)");
    expect(CombineDialogSource).toContain("F.combinedParts(auto.length)");
    expect(CombineDialogSource).toMatch(/onClose=\{\(_e, reason\) => \{ if \(reason !== "backdropClick"\) cancel\(\); \}\}/);
    expect(ToastsSource).toMatch(/s\.dialog\?\.kind === "combine"/);
    // A banner cut short in the document bar opens in full on a click on its text.
    expect(BannerSlotSource).toContain('data-testid="banner-full"');
    expect(BannerSlotSource).toMatch(/onClick=\{compact \? onExpand : undefined\}/);
    expect(typeof CombineDialog).toBe("function");
  });
});
