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
    const words = /\b(revision|head|journal|hash|manifest|sibling|displaced|draft|analysis id|merge|lca|base|ancestor|lane|snapshot|beacon|claim|epoch|heartbeat|supersede|stale|seq|presence|linger|session id)s?\b/i;
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
    expect(V.readOnly).toBe("Read-only");
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

// ── phase 3: who is editing (phase3-contract.md §6.2–6.5, checklist U1) ─────

import type { PeerView, TabPresence } from "../file/contract";
import {
  SHARE_LABEL, SHARE_SHORT, STATUS, T, agoText, attemptBannerOf, clockText, docStatusText, editAnywayText, joinNames, sharingStatusText,
} from "./text";

describe("phase 3 wording", () => {
  const at = (h: number, m: number, dayOffset = 0) => { const d = new Date(NOW); d.setDate(d.getDate() + dayOffset); d.setHours(h, m, 0, 0); return d.getTime(); };
  const peer = (p: Partial<PeerView> = {}): PeerView => ({
    deviceId: "d-alice", deviceName: "Office iMac", userName: "Alice", sameUser: false, state: "editing", freshness: "active",
    basedOn: "myVersion", updatedAt: new Date(NOW - 60_000).toISOString(), editingSince: NOW - 5 * 60_000, changedAt: NOW - 10_000,
    superseded: false, supersedesMe: false, ...p,
  });
  const bob = (p: Partial<PeerView> = {}) => peer({ deviceId: "d-bob", deviceName: "Lab MacBook", userName: "Bob", ...p });
  const mine = (p: Partial<PeerView> = {}) => peer({ deviceId: "d-mbp", deviceName: "MacBook-Pro", userName: "Me", sameUser: true, ...p });
  const b = (kind: TabBanner["kind"], peers: PeerView[], p: Partial<TabBanner> = {}): TabBanner => ({ id: kind, kind, actions: [], dismissible: false, peers, ...p });
  const txt = (bb: TabBanner) => bannerText(bb, settings);

  it("clockText: today, this week, earlier", () => {
    const now = at(20, 0);
    expect(clockText(at(19, 40), now)).toBe("19:40");
    expect(clockText(at(9, 5), now)).toBe("09:05");
    const fri = at(18, 2, -2);
    expect(clockText(fri, now)).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) 18:02$/);
    expect(clockText(at(18, 2, -10), now)).toMatch(/^\d{1,2} [A-Z][a-z]{2} 18:02$/);
    expect(clockText(Date.parse("2024-03-05T10:00:00Z"), now)).toMatch(/ 2024 \d\d:\d\d$/);
    expect(clockText(NaN, now)).toBe("");
    expect(joinNames(["Alice"])).toBe("Alice");
    expect(joinNames(["Alice", "Bob"])).toBe("Alice and Bob");
    expect(joinNames(["Alice", "Bob", "Carol"])).toBe("Alice, Bob and 1 other");
    expect(joinNames(["Alice", "Bob", "Carol", "Dan"])).toBe("Alice, Bob and 2 others");
    expect(agoText(NOW - 2 * 60_000, NOW)).toBe("2 min ago");
    expect(agoText(null, NOW)).toBe("");
  });

  it("editingElsewhere: one and two computers, same user and not", () => {
    expect(txt(b("editingElsewhere", [peer({ changedAt: Date.now() - 5000 })])))
      .toBe("Alice is editing on Office iMac (note updated just now). You'll see their changes each time they save.");
    expect(txt(b("editingElsewhere", [peer({ changedAt: Date.now() - 2 * 60_000 - 5000 })])))
      .toBe("Alice is editing on Office iMac (note updated 2 min ago). You'll see their changes each time they save.");
    expect(txt(b("editingElsewhere", [mine()])))
      .toBe("You have this open on MacBook-Pro with changes not yet saved there. Both sets of changes will be combined when that computer saves.");
    expect(txt(b("editingElsewhere", [peer(), bob()])))
      .toBe("Alice and Bob are editing this version on Office iMac and Lab MacBook. You'll see their changes each time they save.");
    expect(txt(b("editingElsewhere", [mine(), mine({ deviceId: "d-2", deviceName: "Office iMac" })])))
      .toBe("You have this open on MacBook-Pro and Office iMac with changes not yet saved there. Both sets of changes will be combined when those computers save.");
    expect(txt(b("editingElsewhere", [peer(), mine()])))
      .toBe("Alice and you are editing this version on Office iMac and MacBook-Pro. You'll see their changes each time they save.");
    expect(txt(b("editingElsewhere", [peer()], { checking: true }))).toBe("Checking who is editing…");
    expect(txt(b("editingElsewhere", [peer({ userName: " ", deviceName: "" })])))
      .toMatch(/^Someone is editing on another computer/);
  });

  it("waiting, unconfirmed, older peer", () => {
    expect(txt(b("waitingNewer", [peer()]))).toBe("Office iMac saved a newer version — loading it…");
    expect(txt(b("waitingNewer", [peer({ deviceName: "" })]))).toBe("Another computer saved a newer version — loading it…");
    expect(txt(b("unconfirmed", []))).toBe("Couldn't confirm the newest version yet.");
    expect(txt(b("olderPeer", [peer({ state: "idle", basedOn: null })])))
      .toBe("Office iMac runs an older version that doesn't show who is editing — update it.");
    expect(txt(b("olderPeer", []))).toBe("The other computer runs an older version that doesn't show who is editing — update it.");
  });

  it("editingInfo: a quiet note on my version, and unsaved changes on an older version", () => {
    const quiet = peer({ freshness: "quiet", updatedAt: "not a time" });
    expect(txt(b("editingInfo", [quiet]))).toBe("Alice started editing on Office iMac and may have unsaved changes there.");
    const q2 = peer({ freshness: "quiet", updatedAt: new Date(Date.now() - 3600_000).toISOString() });
    expect(txt(b("editingInfo", [q2]))).toMatch(/^Alice started editing on Office iMac (at \d\d:\d\d|on \w{3} \d\d:\d\d) and may have unsaved changes there\.$/);
    expect(txt(b("editingInfo", [mine({ freshness: "quiet", updatedAt: "x" })])))
      .toBe("You started editing on MacBook-Pro and may have unsaved changes there.");
    const older = peer({ basedOn: "older", updatedAt: "x" });
    expect(txt(b("editingInfo", [older]))).toBe("Alice has unsaved changes on Office iMac; they will be combined when Alice saves.");
    expect(txt(b("editingInfo", [mine({ basedOn: "older", updatedAt: "x" })])))
      .toBe("You have unsaved changes on MacBook-Pro; they will be combined when that computer saves.");
    expect(txt(b("editingInfo", [peer({ basedOn: "older", updatedAt: new Date(Date.now() - 60_000).toISOString() })])))
      .toMatch(/^Alice has unsaved changes on Office iMac from (\w{3} )?\d\d:\d\d; they will be combined when Alice saves\.$/);
    expect(txt(b("editingInfo", [older, bob({ basedOn: "older", updatedAt: "x" })])))
      .toBe("Alice and Bob have unsaved changes on Office iMac and Lab MacBook; they will be combined when those computers save.");
  });

  it("both editing, continued elsewhere, after sleep", () => {
    expect(txt(b("bothEditing", [peer()])))
      .toBe("Also being edited on Office iMac (Alice). Nothing is lost — the two versions are combined when you save.");
    expect(txt(b("bothEditing", [mine()])))
      .toBe("Also being edited on MacBook-Pro (your other computer). Nothing is lost — the two versions are combined when you save.");
    expect(txt(b("bothEditing", [peer(), bob()])))
      .toBe("Also being edited on Office iMac (Alice) and Lab MacBook (Bob). Nothing is lost — the versions are combined when you save.");
    const since = Date.now() - 60_000;
    const clock = clockText(since);
    expect(txt(b("continuedElsewhere", [peer({ editingSince: since })])))
      .toBe(`Alice continued on Office iMac at ${clock}. Your unsaved changes here are kept and will be combined.`);
    expect(txt(b("continuedElsewhere", [mine({ editingSince: since })])))
      .toBe(`You continued on MacBook-Pro at ${clock}. Your unsaved changes here are kept and will be combined.`);
    expect(txt(b("resuming", [peer()]))).toBe("Checking for changes made while this computer was asleep…");
    expect(bannerSeverity(b("bothEditing", []))).toBe("warning");
    expect(bannerSeverity(b("editingElsewhere", []))).toBe("info");
    expect(bannerSeverity(b("olderPeer", []))).toBe("warning");
  });

  it("action labels", () => {
    expect(bannerActionLabel("editingElsewhere", "editHere")).toBe("Edit here");
    expect(bannerActionLabel("editingElsewhere", "editAnyway")).toBe("Edit anyway…");
    expect(bannerActionLabel("bothEditing", "keepEditing")).toBe("Keep editing");
    expect(bannerActionLabel("bothEditing", "saveCopy")).toBe("Save my changes as a separate copy…");
    expect(bannerActionLabel("editingInfo", "dismiss")).toBe("OK");
    expect(bannerActionLabel("olderPeer", "dismiss")).toBe("OK");
  });

  it("the status line and the chip", () => {
    const who: VersionInfo = v({ time: ago(2 * 60_000) });
    const pres = (p: Partial<TabPresence> = {}): TabPresence => ({
      mode: "editable", readOnly: false, guard: null, peers: [], mine: "idle",
      sharing: { choice: null, fallback: "auto", on: true, why: "cloud", service: "Dropbox" }, status: null, attempt: 0, ...p,
    });
    const tab = (p: Record<string, unknown> = {}) => ({ status: "ready" as const, saving: false, notSaved: false, readOnly: null, dirty: false, path: "/x/a.lag", ...p });
    expect(STATUS.readOnly).toBe("Read-only");
    expect(docStatusText(tab(), settings, NOW)).toBe("All changes saved");
    expect(docStatusText(tab({ presence: pres({ status: { kind: "upToDate", who, seenAt: null } }) }), settings, NOW))
      .toBe("Up to date · Alice (Office iMac) saved 2 min ago");
    expect(docStatusText(tab({ presence: pres({ status: { kind: "upToDate", who, seenAt: NOW - 5000 } }) }), settings, NOW))
      .toBe("Up to date · Alice (Office iMac) saved just now");
    expect(docStatusText(tab({ presence: pres({ readOnly: true, guard: "editingElsewhere", status: { kind: "upToDate", who, seenAt: NOW - 5000 } }) }), settings, NOW))
      .toBe("Alice (Office iMac) saved just now"); // fixer F4: the chip already says "Read-only"
    expect(docStatusText(tab({ presence: pres({ readOnly: true, guard: "editingElsewhere" }) }), settings, NOW)).toBe("Read-only");
    expect(docStatusText(tab({ readOnly: "tooNew" }), settings, NOW)).toBe("Read-only");
    expect(docStatusText(tab({ dirty: true, presence: pres({ status: { kind: "upToDate", who, seenAt: null } }) }), settings, NOW)).toBe("Unsaved changes");
    expect(docStatusText(tab({ status: "opening" }), settings, NOW)).toBe("Opening…");
    expect(docStatusText(tab({ path: null }), settings, NOW)).toBe("");
    expect(docStatusText(tab({ presence: pres({ status: { kind: "upToDate", who: v({ userName: "Me" }), seenAt: NOW - 5000 } }) }), settings, NOW))
      .toBe("Up to date · You on Office iMac saved just now");
  });

  it("the banner a refused edit points at", () => {
    const ro = b("editingElsewhere", [peer()], { actions: ["editAnyway"] });
    const other = b("newerCopy", []);
    const pres = (guard: TabPresence["guard"]) => ({ guard });
    expect(attemptBannerOf({ banners: [other, ro], presence: pres("editingElsewhere"), readOnly: null })).toBe(ro);
    const wait = b("waitingNewer", [peer()]);
    expect(attemptBannerOf({ banners: [wait, ro], presence: pres("waiting"), readOnly: null })).toBe(wait);
    const res = b("resuming", [], { actions: ["keepEditing"] });
    expect(attemptBannerOf({ banners: [other, res], presence: pres("resuming"), readOnly: null })).toBe(res);
    const tooNew = b("tooNew", []);
    expect(attemptBannerOf({ banners: [tooNew], readOnly: "tooNew" })).toBe(tooNew);
    expect(attemptBannerOf({ banners: [other], presence: pres(null), readOnly: null })).toBe(null);
  });

  it("dialogs, the setting and the toast", () => {
    expect(T.editAnywayTitle).toBe("Edit anyway?");
    expect(editAnywayText([peer()])).toBe("Alice may have unsaved changes. If you both edit, the two versions are combined on save. Continue?");
    expect(editAnywayText([peer(), bob()])).toBe("Alice and Bob may have unsaved changes. If you both edit, the two versions are combined on save. Continue?");
    expect([T.editAnywayGo, T.cancel]).toEqual(["Edit anyway", "Cancel"]);
    expect([T.resumeSaveTitle, T.resumeSaveGo, T.resumeWait]).toEqual(["Save now?", "Save now", "Wait"]);
    expect(T.resumeSaveBody).toBe("This computer was asleep. Changes made on another computer may not have arrived yet. If someone else saved meanwhile, the two versions are combined.");
    expect([T.resumeEditTitle, T.resumeEditGo]).toEqual(["Keep editing?", "Keep editing"]);
    expect(T.resumeEditBody).toBe("This computer was asleep. Changes made on another computer may not have arrived yet. If you both edit, the two versions are combined on save.");
    expect(T.sharingTitle).toBe("Show others when I'm editing this file");
    expect(T.sharingDefault(SHARE_SHORT.auto)).toBe("Use my default (Automatically)");
    expect(SHARE_LABEL).toEqual({ auto: "Automatically (in cloud folders)", always: "Always", never: "Never" });
    const sv = (why: Parameters<typeof sharingStatusText>[0]["why"], service: string | null = null) => sharingStatusText({ why, service });
    expect(sv("cloud", "Dropbox")).toBe("On. This file is in Dropbox, so a small note file is kept next to it while it is open here.");
    expect(sv("otherComputers")).toBe("On. This file has been used on another computer.");
    expect(sv("always")).toBe("On. A small note file is kept next to this file while it is open here.");
    expect(sv("local")).toBe("Off. This file is not in a cloud folder and has only been used on this computer.");
    expect(sv("never")).toBe("Off. Other computers can't see when you are editing this file.");
    expect(sv("untitled")).toBe("Save the analysis to a file first.");
    expect(T.sharingHelp).toContain("Lock editing");
    expect(T.sharingHelp).toMatch(/^While you edit, other computers that have this file open show it as read-only until you save\./);
    expect([T.settingsShare, T.settingsShareHelp]).toEqual(["Show others when I'm editing", "Used for files that have no choice of their own."]);
    expect(MENU_TEXT.sharing).toBe("Show Others When I'm Editing…");
    expect(toastText({ id: 1, tone: "info", kind: "deviceIdChanged" }, settings))
      .toBe("This computer was using the same identity as another one. It now has its own.");
  });

  it("never uses internal words in the new texts (§6.7)", () => {
    const words = /\b(beacon|claim|epoch|heartbeat|supersede[sd]?|stale|seq|presence|linger|session id|revision|head|draft|base)s?\b/i;
    const all: string[] = [];
    const sets: PeerView[][] = [[peer()], [mine()], [peer(), bob()], [mine(), mine({ deviceId: "x" })], [peer(), mine()], [], [peer({ freshness: "quiet" })],
      [peer({ basedOn: "older" })], [mine({ basedOn: "older" })], [peer({ userName: "", deviceName: "" })]];
    for (const kind of ["resuming", "continuedElsewhere", "bothEditing", "waitingNewer", "editingElsewhere", "editingInfo", "unconfirmed", "olderPeer"] as const) {
      for (const ps of sets) for (const checking of [false, true]) all.push(txt(b(kind, ps, { checking })));
    }
    for (const why of ["always", "cloud", "otherComputers", "never", "local", "untitled"] as const) all.push(sharingStatusText({ why, service: "Dropbox" }));
    for (const x of Object.values(T)) all.push(typeof x === "function" ? String((x as (...a: unknown[]) => unknown)("Alice", 2)) : x);
    all.push(...Object.values(SHARE_LABEL), ...Object.values(STATUS), editAnywayText([peer()]), editAnywayText([peer(), bob()]));
    for (const s of all) { expect(s.length).toBeGreaterThan(0); expect(s).not.toMatch(words); }
  });
});
