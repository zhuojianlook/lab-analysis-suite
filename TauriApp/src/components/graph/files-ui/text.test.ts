import { describe, expect, it } from "vitest";
import { BANNER_ORDER, type BannerAction, type TabBanner, type VersionInfo } from "../file/contract";
import textSource from "./text.ts?raw";
import {
  C, CHIP_TEXT, MENU_TEXT, SECTION_TITLE, V, bannerActionLabel, bannerSeverity, bannerText, cardBody, cardTitle, possessive,
  sectionPhrases, theirsLabel, toastText, whenText, whoLine, whoText,
} from "./text";

const NOW = Date.parse("2026-11-22T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const v = (p: Partial<VersionInfo> = {}): VersionInfo => ({ head: "r-x", userName: "Alice", deviceName: "Office iMac", time: ago(5 * 60_000), mine: false, ...p });
const settings = { userName: "Me", deviceName: "This Mac" };

describe("whenText", () => {
  it("words recent times plainly", () => {
    expect(whenText(ago(10_000), NOW)).toBe("just now");
    expect(whenText(ago(5 * 60_000), NOW)).toBe("5 min ago");
    expect(whenText(ago(2 * 3_600_000), NOW)).toBe("2 h ago");
    expect(whenText("", NOW)).toBe("");
    expect(whenText("not a date", NOW)).toBe("");
    expect(whenText(new Date(NOW + 60_000).toISOString(), NOW)).toBe("just now");
  });
  it("uses yesterday and a short date further back", () => {
    const y = new Date(NOW); y.setDate(y.getDate() - 1); y.setHours(9, 0, 0, 0);
    expect(whenText(y.toISOString(), NOW)).toBe("yesterday");
    const old = new Date(NOW); old.setDate(old.getDate() - 10);
    expect(whenText(old.toISOString(), NOW)).toMatch(/^\d{1,2} [A-Z][a-z]{2}$/);
    expect(whenText("2024-03-05T10:00:00Z", NOW)).toMatch(/2024$/);
  });
});

describe("whoText", () => {
  it("names the other person and computer, or you", () => {
    expect(whoText(v(), settings)).toBe("Alice (Office iMac)");
    expect(whoText(v({ userName: "Me" }), settings)).toBe("you on Office iMac");
    expect(whoText(v({ mine: true }), settings)).toBe("you");
    expect(whoText(null, settings)).toBe("someone else");
    expect(whoText(v({ userName: "", deviceName: "" }), settings)).toBe("someone else");
  });
});

describe("banner and card texts", () => {
  const ACTIONS: BannerAction[] = [
    "openPrivacy", "retry", "findIt", "saveAs", "choose", "later", "dismiss", "openCopy", "useEarlier", "backToLatest", "separate",
    "same", "notSame", "updateMine", "openThatOne", "openAsNew", "discardDraft", "chooseLocation",
    "combine", "remove", "keep", "whatChanged", "undo",
  ];
  const all: string[] = [];
  for (const kind of BANNER_ORDER) {
    for (const relation of ["older", "newer", "same", "diverged"] as const) {
      const b: TabBanner = {
        id: kind, kind, actions: [], dismissible: true, name: "Dose response", path: "/x/Dose response copy.lag", folderLabel: "Dropbox › Lab",
        service: "Dropbox", version: v(), relation, when: ago(60_000), message: "The folder didn't answer in time.",
      };
      all.push(bannerText(b, settings));
      for (const a of ACTIONS) all.push(bannerActionLabel(kind, a));
    }
  }
  for (const kind of ["waiting", "downloading", "missing", "permission", "unreadable"] as const) {
    const c = { key: "k", kind, name: "Dose response", path: "/x/Dose response.lag", folderLabel: "Dropbox › Lab", service: "Dropbox", hasDraft: true };
    all.push(cardTitle(c), cardBody(c));
  }
  for (const state of ["combining", "choose"] as const) {
    all.push(bannerText({ id: "s", kind: "savedOver", state, actions: [], dismissible: false, version: v() }, settings));
  }
  all.push(bannerText({ id: "c", kind: "combined", actions: [], dismissible: true, version: v(), sections: ["table", "figure"] }, settings));
  all.push(...Object.values(CHIP_TEXT), ...Object.values(SECTION_TITLE), MENU_TEXT.versions);
  const texts = (o: Record<string, unknown>) => {
    for (const x of Object.values(o)) {
      if (typeof x === "string") all.push(x);
      else if (typeof x === "function") all.push(String((x as (...a: unknown[]) => unknown)("Dose response", "Office iMac", "2 h ago")), String((x as (...a: unknown[]) => unknown)(2, 3)));
    }
  };
  texts(V); texts(C);
  for (const kind of ["renamed", "saved", "reloaded", "tabLimit", "alreadyOpen", "restoredDrafts", "error", "combined", "broughtBack", "copyRemoved", "savedAsNew"] as const) {
    all.push(toastText({ id: 1, tone: "info", kind, name: "B", version: v(), message: "x" }, settings));
  }

  it("every banner kind has text", () => {
    for (const s of all) expect(s.length).toBeGreaterThan(0);
  });

  it("follows the wording table", () => {
    const b = (kind: TabBanner["kind"], p: Partial<TabBanner> = {}): TabBanner =>
      ({ id: kind, kind, actions: [], dismissible: true, version: v(), name: "Dose response", folderLabel: "Dropbox › Lab", ...p });
    expect(bannerText(b("newerOnDisk"), settings)).toBe("Alice (Office iMac) saved a newer version.");
    expect(bannerText(b("missing"), settings)).toBe("'Dose response' is no longer in Dropbox › Lab (moved or deleted, possibly on another computer). Your work is still here.");
    expect(bannerText(b("extraCopy", { relation: "same" }), settings)).toBe("'Dose response' is an older copy of this analysis.");
    expect(bannerText(b("extraCopy", { relation: "diverged" }), settings)).toBe("A second copy of this analysis, 'Dose response', has changes by Alice (Office iMac).");
    expect(bannerText(b("copyQuestion", { path: "/a/Exp 2.lag", name: "Exp 1" }), settings))
      .toBe("'Exp 2' started as a copy of 'Exp 1'. Is it a separate analysis, or another copy of the same one?");
    expect(bannerText(b("downloading", { service: null }), settings)).toBe("Downloading from the cloud folder…");
    expect(bannerActionLabel("newerCopy", "later")).toBe("Open separately");
    expect(bannerActionLabel("missing", "saveAs")).toBe("Save a new copy here");
    expect(toastText({ id: 1, tone: "info", kind: "reloaded", version: v() }, settings)).toBe("Updated to the version saved by Alice (Office iMac)");
  });

  it("never uses internal words (checklist 46)", () => {
    const src = textSource;
    expect(src.length).toBeGreaterThan(1000);
    // String literals only (comments may explain the rule).
    const literals = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").match(/(["'`])(?:\\.|(?!\1).)*\1/g) ?? [];
    const words = /\b(revision|head|journal|hash|manifest|sibling|displaced|draft|analysis id|merge|lca|base|ancestor|lane|snapshot)s?\b/i;
    for (const l of literals) expect(l).not.toMatch(words);
    for (const s of all) expect(s).not.toMatch(words);
  });
});

describe("phase 2 wording (phase 2 contract §6.2–6.4)", () => {
  const b = (kind: TabBanner["kind"], p: Partial<TabBanner> = {}): TabBanner =>
    ({ id: kind, kind, actions: [], dismissible: true, version: v(), name: "Dose response", ...p });

  it("banners", () => {
    expect(bannerText(b("newerOnDisk"), settings)).toBe("Alice (Office iMac) saved a newer version.");
    expect(bannerActionLabel("newerOnDisk", "combine")).toBe("Combine my changes with it");
    expect(bannerActionLabel("newerOnDisk", "later")).toBe("Later");
    expect(bannerText(b("savedOver", { state: "combining" }), settings))
      .toBe("Another computer saved over your last save. Nothing is lost — combining both now.");
    expect(bannerSeverity(b("savedOver", { state: "combining" }))).toBe("info");
    expect(bannerText(b("savedOver", { state: "choose" }), settings))
      .toBe("Another computer saved over your last save. Nothing is lost. Choose what to keep.");
    expect(bannerSeverity(b("savedOver", { state: "choose" }))).toBe("warning");
    expect(bannerActionLabel("savedOver", "combine")).toBe("Choose…");
    expect(bannerText(b("savedOver", { name: "Dose response (my version)" }), settings))
      .toBe("Another computer saved over your last save. Nothing is lost — your version was saved as a copy: 'Dose response (my version)'.");
    expect(bannerText(b("combined", { sections: ["figure"] }), settings))
      .toBe("Combined with the version saved by Alice (Office iMac). Taken from it: the graph.");
    expect(bannerText(b("combined", { sections: ["figure", "table"] }), settings))
      .toBe("Combined with the version saved by Alice (Office iMac). Taken from it: the table and the graph.");
    expect(bannerText(b("combined", { sections: [] }), settings)).toBe("Combined with the version saved by Alice (Office iMac).");
    expect(bannerText(b("combined", { sections: [], version: v({ userName: "", deviceName: "" }) }), settings))
      .toBe("Combined with the version saved by another computer.");
    // Combined with my own save that another computer's save had replaced (ux F4).
    expect(bannerText(b("combined", { sections: ["table"], version: v({ mine: true }) }), settings))
      .toBe("Combined with your earlier save. Taken from it: the table.");
    expect(bannerSeverity(b("combined"))).toBe("success");
    expect(bannerActionLabel("combined", "whatChanged")).toBe("What changed");
    expect(bannerActionLabel("combined", "undo")).toBe("Undo");
    expect(bannerText(b("extraCopy", { relation: "older", name: "Dose response (old copy)" }), settings))
      .toBe("'Dose response (old copy)' is an older copy of this analysis.");
    expect(bannerActionLabel("extraCopy", "remove")).toBe("Remove it");
    expect(bannerActionLabel("extraCopy", "keep")).toBe("Keep");
    expect(bannerActionLabel("extraCopy", "combine")).toBe("Combine…");
    expect(bannerActionLabel("extraCopy", "notSame")).toBe("This is a different analysis");
    expect(bannerSeverity(b("extraCopy", { relation: "diverged" }))).toBe("warning");
  });

  it("toasts", () => {
    const t = (kind: "combined" | "broughtBack" | "copyRemoved" | "savedAsNew", p = {}) => toastText({ id: 1, tone: "success", kind, ...p }, settings);
    expect(t("combined", { version: v() })).toBe("Combined with Alice (Office iMac)'s changes");
    expect(t("combined", { version: v({ userName: "", deviceName: "" }) })).toBe("Combined with another computer's changes");
    expect(t("broughtBack", { version: v({ time: new Date(Date.now() - 5 * 60_000).toISOString() }) })).toBe("Brought back the version from 5 min ago");
    expect(t("combined", { version: v({ mine: true }) })).toBe("Combined with your earlier save");
    expect(t("copyRemoved", { name: "Dose response (old copy)" })).toBe("Removed 'Dose response (old copy)'. The app keeps it for 30 days.");
    // The combine dialog names the sides by what they are when the other side is my own replaced save.
    expect(C.nowInFile("Alice (Office iMac)", false)).toBe("In the file now: saved by Alice (Office iMac)");
    expect(C.replacedSave("2 h ago")).toBe("Your save that was replaced (2 h ago)");
    expect(t("savedAsNew", { name: "Dose response (earlier version)" })).toBe("Saved as a new analysis: 'Dose response (earlier version)'");
  });

  it("sections, chips and people", () => {
    expect(sectionPhrases(["table"])).toBe("the table");
    expect(sectionPhrases(["figure", "table"])).toBe("the table and the graph");
    expect(sectionPhrases(["figure", "analysis", "table"])).toBe("the table, the analysis settings and the graph");
    expect(sectionPhrases([])).toBe("");
    expect(SECTION_TITLE).toEqual({ table: "Data table", analysis: "Analysis settings", figure: "Graph", scratchpad: "Scratchpad" });
    expect(CHIP_TEXT).toEqual({
      current: "Current", combined: "Combined", broughtBack: "Brought back", fromOldLibrary: "From old library",
      tooOld: "Too old to open", unsaved: "Not saved yet",
    });
    expect(whoLine(v({ userName: "", deviceName: "" }), settings)).toBe("another computer");
    expect(whoLine(v(), settings)).toBe("Alice (Office iMac)");
    expect(theirsLabel(v(), settings)).toBe("Alice's");
    expect(theirsLabel(v({ userName: "" }), settings)).toBe("Theirs");
    expect(theirsLabel(v({ userName: "Me" }), settings)).toBe("Theirs");
    expect(possessive("you")).toBe("your");
    expect(MENU_TEXT.versions).toBe("Versions");
  });

  it("the Versions panel and the preview", () => {
    expect(V.title).toBe("Versions");
    expect(V.loading).toBe("Loading versions…");
    expect(V.workingSummary).toBe("Unsaved changes");
    expect(V.workingLine("This Mac")).toBe("you · This Mac · now");
    expect(V.autoLine("2 h ago")).toBe("Combined automatically · 2 h ago");
    expect(V.rowLine("you", "This Mac", "2 h ago")).toBe("you · This Mac · 2 h ago");
    expect(V.copyLabel("Dose response (conflicted copy)")).toBe("In 'Dose response (conflicted copy)'");
    expect(V.stubLabel("Dose response (earlier version)")).toBe("Separate analysis: 'Dose response (earlier version)'");
    expect(V.legend).toBe("Computers");
    expect(V.tooOldFooter).toBe("Older versions are listed but can no longer be opened.");
    expect(V.readOnly).toBe("Read only");
    expect(V.tooOldBody).toBe("This version is too old to open. Its entry is kept so you can see who saved it and when.");
    expect([V.compare, V.bringBack, V.saveAsNew, V.closePreview])
      .toEqual(["Compare with current", "Bring this version back", "Save this version as a new analysis…", "Close"]);
    expect([V.same, V.different, V.thisVersion, V.current, V.cellsDiffer(3), V.andMore(5)])
      .toEqual(["Same", "Different", "This version", "Current", "3 cells differ", "and 5 more"]);
    expect(V.cellsDiffer(1)).toBe("1 cell differs");
    expect(V.previewTitle("Changed the table", "you", "2 h ago")).toBe("Changed the table — you, 2 h ago");
    expect(V.bringBackTitle("2 h ago")).toBe("Bring back the version from 2 h ago?");
    expect(V.bringBackBody).toBe("You have unsaved changes. They are saved as a version first, so nothing is lost.");
    expect(V.bringBackSave).toBe("Save, then bring it back");
  });

  it("the combine dialog", () => {
    expect(C.title("Dose response", "2 h ago")).toBe("Two versions of 'Dose response' changed since 2 h ago");
    expect(C.titleTwoWay("Dose response")).toBe("Two versions of 'Dose response'");
    expect(C.mine("This Mac", false)).toBe("Mine: This Mac");
    expect(C.mine("This Mac", true)).toBe("Mine: This Mac, with unsaved changes");
    expect(C.theirs("Alice (Office iMac)")).toBe("Theirs: Alice (Office iMac)");
    expect(C.theirsCopy("Dose response (conflicted copy)", "Alice (Office iMac)")).toBe("Theirs: 'Dose response (conflicted copy)', saved by Alice (Office iMac)");
    expect(C.queue(2, 3)).toBe("Copy 2 of 3");
    expect(C.twoWay).toBe("These two copies were last the same too long ago to compare part by part. Choose which to keep for each part that differs.");
    expect([C.unchanged, C.combinedChip, C.chooseChip, C.fromMine, C.fromTheirs("Alice"), C.mineButton])
      .toEqual(["Unchanged", "Combined", "Choose", "from mine", "from Alice", "Mine"]);
    expect(C.notChanged(2)).toBe("Not changed (2)");
    expect(C.combinedAuto(1)).toBe("Combined automatically (1)");
    expect(C.toChoose(1)).toBe("1 to choose");
    expect(C.adjusted(sectionPhrases(["figure"])))
      .toBe("Adjusted automatically: the graph. Some settings pointed at rows or columns that are no longer in the table. Check the result after applying.");
    expect([C.cancel, C.keepBoth, C.apply]).toEqual(["Cancel", "Keep both as separate files", "Apply"]);
    expect(C.footnote).toBe("Nothing is saved until you press Apply. Both versions stay in the file's history.");
  });
});
