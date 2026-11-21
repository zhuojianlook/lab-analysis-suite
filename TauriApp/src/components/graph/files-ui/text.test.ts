import { describe, expect, it } from "vitest";
import { BANNER_ORDER, type BannerAction, type TabBanner, type VersionInfo } from "../file/contract";
import textSource from "./text.ts?raw";
import { bannerActionLabel, bannerText, cardBody, cardTitle, toastText, whenText, whoText } from "./text";

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
  ];
  const all: string[] = [];
  for (const kind of BANNER_ORDER) {
    for (const relation of ["older", "newer"] as const) {
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
  for (const kind of ["renamed", "saved", "reloaded", "tabLimit", "alreadyOpen", "restoredDrafts", "error"] as const) {
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
    const words = /\b(revision|head|journal|hash|manifest|sibling|displaced|draft|analysis id)s?\b/i;
    for (const l of literals) expect(l).not.toMatch(words);
    for (const s of all) expect(s).not.toMatch(words);
  });
});
