/* Every sentence the files UI shows (contract §5.3–5.5). The controller hands
   over structured data (banners, cards, dialogs, toasts); this module words it.
   Plain words only: never "revision", "head", "journal", "hash", "manifest",
   "draft", "sibling", "displaced" or "analysis id" (contract §5.5, checklist 46). */

import type {
  BannerAction, BannerKind, FileSettings, RestoreCard, SessionToast, TabBanner, VersionInfo,
} from "../file/contract";

// ── platform ───────────────────────────────────────────────────────────────

export const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
export const IS_WINDOWS = typeof navigator !== "undefined" && /Win/i.test(navigator.platform);

/** "⌘S", "⇧⌘S" on a Mac; "Ctrl+S", "Ctrl+Shift+S" elsewhere. */
export function shortcutText(key: string, shift = false): string {
  if (IS_MAC) return `${shift ? "⇧" : ""}⌘${key.toUpperCase()}`;
  return `Ctrl+${shift ? "Shift+" : ""}${key.toUpperCase()}`;
}

export const REVEAL_LABEL = IS_MAC ? "Show in Finder" : IS_WINDOWS ? "Show in Explorer" : "Show in folder";

// ── times and people ───────────────────────────────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "just now", "5 min ago", "2 h ago", "yesterday", "12 Nov" (with the year when it isn't this year). */
export function whenText(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diff = now - t;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  const d = new Date(t);
  const today = new Date(now);
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) return `${Math.floor(diff / 3_600_000)} h ago`;
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "yesterday";
  const base = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === today.getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

/** Who saved a version: "Alice (Office iMac)"; "you on Office iMac" for my own
 *  name on another computer; "you" on this computer. */
export function whoText(v: VersionInfo | null | undefined, settings: FileSettings | null): string {
  if (!v) return "someone else";
  if (v.mine) return "you";
  const user = v.userName.trim();
  const device = v.deviceName.trim();
  if (user && settings && user === settings.userName.trim()) return device ? `you on ${device}` : "you";
  if (user && device) return `${user} (${device})`;
  if (user) return user;
  if (device) return `someone on ${device}`;
  return "someone else";
}

/** Capital first letter, for "who" at the start of a sentence. */
export const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** File name without folder; the stem without the .lag extension. */
export function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}
export function stemOf(path: string): string {
  return baseName(path).replace(/\.lag$/i, "");
}

// ── banners (contract §5.3) ────────────────────────────────────────────────

export type Severity = "success" | "info" | "warning" | "error";

const SEVERITY: Record<BannerKind, Severity> = {
  permission: "error", downloading: "info", missing: "warning", replaced: "warning", tooNew: "info",
  saveFailed: "error", notSaved: "warning", savedAside: "warning", savedOver: "warning", savedDisplaced: "warning",
  tookTheirs: "info", draftMismatch: "warning", copyQuestion: "info", extraCopy: "info", tempLocation: "info",
  rolledBack: "warning", newerOnDisk: "info", newerCopy: "info", olderCopy: "info", recovered: "success",
};

export function bannerSeverity(b: TabBanner): Severity {
  if (b.kind === "extraCopy") return b.relation === "newer" || b.relation === "diverged" ? "warning" : "info";
  return SEVERITY[b.kind];
}

export function bannerText(b: TabBanner, settings: FileSettings | null): string {
  const name = b.name ?? "this file";
  const folder = b.folderLabel ?? "its folder";
  const who = whoText(b.version, settings);
  const service = b.service ?? "the cloud folder";
  switch (b.kind) {
    case "permission": return "macOS hasn't allowed Lab Analysis Suite to read this folder.";
    case "downloading": return `Downloading from ${service}…`;
    case "missing": return `'${name}' is no longer in ${folder} (moved or deleted, possibly on another computer). Your work is still here.`;
    case "replaced": return "A different analysis is now saved under this name. Your work is still here.";
    case "tooNew": return "Made with a newer version of Lab Analysis Suite. Update to edit.";
    case "saveFailed": return `Not saved. ${b.message ?? "The file couldn't be written."}`;
    case "notSaved": return `Not saved yet — ${who} also changed this file. Choose what to keep.`;
    case "savedAside": return `The file couldn't be checked yet, so your changes were saved beside it as '${name}'.`;
    case "savedOver": return `Another computer saved over your last save. Nothing is lost — your version was saved as a copy: '${name}'.`;
    case "savedDisplaced": return `Saved. ${cap(who)} saved at the same moment; that version was kept as a copy: '${name}'.`;
    case "tookTheirs": return `Now showing the version saved by ${who}. Your version was saved as a copy: '${name}'.`;
    case "draftMismatch": return `You have unsaved changes from ${whenText(b.when) || "earlier"} that don't match this file.`;
    case "copyQuestion": {
      const other = b.path ? stemOf(b.path) : "Another file";
      return `'${other}' started as a copy of '${name}'. Is it a separate analysis, or another copy of the same one?`;
    }
    case "extraCopy":
      return b.relation === "newer" || b.relation === "diverged"
        ? `A second copy of this analysis, '${name}', has changes by ${who}.`
        : `'${name}' is an older copy of this analysis.`;
    case "tempLocation": return "This file is in a temporary folder. Choose where to keep it before editing.";
    case "rolledBack": {
      const when = whenText(b.version?.time);
      return `This file was put back to an earlier version (${when ? `${when}, ` : ""}saved by ${who}).`;
    }
    case "newerOnDisk":
      // After "Use the earlier version" with unsaved changes: the file has the earlier version, the tab my changes.
      return b.relation === "older"
        ? `The file now has the earlier version saved by ${who}. Your unsaved changes are still here.`
        : `${cap(who)} saved a newer version.`;
    case "newerCopy": {
      const when = whenText(b.version?.time);
      return `This is a newer version of '${name}' (saved by ${who}${when ? `, ${when}` : ""}). Your own file is in ${folder}.`;
    }
    case "olderCopy": {
      const when = whenText(b.version?.time);
      return `A newer version${when ? ` (saved ${when})` : ""} is in ${folder}.`;
    }
    case "recovered": return `Unsaved changes from ${whenText(b.when) || "your last session"} restored.`;
  }
  return "";
}

export function bannerActionLabel(kind: BannerKind, action: BannerAction): string {
  switch (action) {
    case "openPrivacy": return "Open Privacy settings";
    case "retry": return kind === "saveFailed" ? "Try again" : "Retry";
    case "findIt": return "Find it…";
    case "saveAs": return kind === "missing" ? "Save a new copy here" : "Save as a new file…";
    case "choose": return kind === "newerOnDisk" ? "Choose what to keep…" : "Choose…";
    case "later":
      return kind === "newerCopy" ? "Open separately" : kind === "olderCopy" ? "Keep working here" : "Later";
    case "dismiss": return "OK";
    case "openCopy": return "Open the copy";
    case "useEarlier": return "Use the earlier version";
    case "backToLatest": return "Go back to my latest";
    case "separate": return "A separate analysis";
    case "same": return "The same analysis";
    case "notSame": return "This is a different analysis";
    case "updateMine": return "Update my file with it";
    case "openThatOne": return "Open that one";
    case "openAsNew": return "Open them as a new analysis";
    case "discardDraft": return "Discard";
    case "chooseLocation": return "Choose where to keep it…";
  }
  return action;
}

// ── cards (contract §5.4) ──────────────────────────────────────────────────

export function cardTitle(c: RestoreCard): string {
  const service = c.service ?? "the cloud folder";
  switch (c.kind) {
    case "waiting": return `Waiting for ${service}…`;
    case "downloading": return `Downloading from ${service}…`;
    case "missing": return `Can't find '${c.name}'.`;
    case "permission": return "macOS hasn't allowed Lab Analysis Suite to read this folder.";
    case "unreadable": return `'${c.name}' can't be read.`;
  }
  return "";
}

export function cardBody(c: RestoreCard): string {
  switch (c.kind) {
    case "waiting": return `'${c.name}' hasn't arrived on this computer yet. If it was moved, use Find it…`;
    case "downloading": return `'${c.name}' is being downloaded to this computer.`;
    case "missing": return `Last seen in ${c.folderLabel}.`;
    case "permission": return c.folderLabel;
    case "unreadable": return "It may still be downloading, or it isn't a Lab Analysis Suite analysis.";
  }
  return "";
}

export const CARD_DRAFT_LINE = "Your unsaved changes for this file are kept.";

// ── toasts ─────────────────────────────────────────────────────────────────

export function toastText(t: SessionToast, settings: FileSettings | null): string {
  switch (t.kind) {
    case "renamed": return t.message ?? `Renamed to '${t.name ?? ""}'`;
    case "saved": return "Saved";
    case "reloaded": return `Updated to the version saved by ${whoText(t.version, settings)}`;
    case "tabLimit": return "12 analyses are open. Close one to open another.";
    case "alreadyOpen": return `'${t.name ?? ""}' is already open.`;
    case "restoredDrafts": return "Unsaved changes restored.";
    case "error": return t.message ?? "Something went wrong.";
  }
  return t.message ?? "";
}

// ── document bar ───────────────────────────────────────────────────────────

export const STATUS = {
  saving: "Saving…",
  notSaved: "Not saved",
  dirty: "Unsaved changes",
  saved: "All changes saved",
  untitled: "Not saved to a file yet",
  readOnly: "Read only",
  opening: "Opening…",
} as const;

// ── dialogs (contract §5.5) ────────────────────────────────────────────────

export const T = {
  conflictTitle: (who: string) => `Not saved yet — ${cap(who)} also changed this file`,
  conflictBody: "Choose what to keep. Nothing is lost either way.",
  keepMine: "Keep mine",
  keepMineSub: (who: string) => `Save my version as the newest. ${cap(who)}'s version stays in the file's history.`,
  useTheirs: "Use theirs",
  useTheirsSub: (who: string) => `Show ${who}'s version. Mine is saved as a copy next to the file.`,
  separateCopy: "Save mine as a separate copy…",
  separateCopySub: (who: string) => `Choose a place for my version. This file is left as ${who} saved it.`,
  decideLater: "Decide later",

  saveAsQuestion: "Is this a new analysis (for example a new experiment based on this one), or the same analysis in a new place?",
  saveAsSub: (folder: string, name: string) => `Saving to ${folder} as '${name}'`,
  saveAsNew: "A new analysis",
  saveAsNewSub: "It gets its own identity. Use this when you start a new experiment from this one.",
  saveAsSame: "The same analysis in a new place",
  saveAsSameSub: "It stays connected to the original, with its history. Use this to move a file you received.",

  closeDirty: (title: string) => `Save changes to '${title}' before closing?`,
  closeDirtySub: "Your changes are lost if you don't save them.",

  quitTitle: (n: number) => `You have unsaved changes in ${n === 1 ? "1 analysis" : `${n} analyses`}.`,
  quitSub: "Unsaved changes you keep come back the next time you open Lab Analysis Suite.",
  quitSaveAll: "Save all",
  quitKeep: "Quit and keep unsaved changes for next time",

  findScanning: (folder: string, n: number) => `Looking in ${folder}… ${n.toLocaleString()} item${n === 1 ? "" : "s"} checked`,
  findSeveral: (n: number) => `Found ${n} copies. Choose the one to open.`,
  findOnlineOnly: (n: number) => `${n} file${n === 1 ? " hasn't" : "s haven't"} been downloaded to this computer yet:`,
  findOnlineOnlyHint: "Download them in Finder, then try again.",
  findNone: "Not found in this folder.",
  findTruncated: "The folder was too large to search completely.",
  findSkipped: (n: number) => `${n} folder${n === 1 ? "" : "s"} couldn't be read.`,
  findAnother: "Choose another folder",
  findTitle: (name: string) => `Find '${name}'`,

  settingsTitle: "Settings",
  settingsUser: "Your name",
  settingsUserHelp: "Shown to others on versions you save.",
  settingsDevice: "This computer's name",
  settingsDeviceHelp: "Tells your computers apart, for example 'Office iMac'.",

  exportTitle: "Export library to files",
  exportConfirm: (total: number) => `Analyses are now saved as files. Export your ${total} saved ${total === 1 ? "analysis" : "analyses"} to a folder?`,
  exportAlready: (n: number) => `${n} ${n === 1 ? "is" : "are"} already exported.`,
  exportChoose: "Choose folder…",
  exportNotNow: "Not now",
  exportProgress: (done: number, total: number) => `${done} of ${total}`,
  exportDone: (done: number, total: number) => `${done} of ${total} exported.`,
  exportFailed: (k: number) => `${k} failed:`,
  exportClosing: (folder: string) => `Your analyses are now ordinary files in ${folder}. The old in-app list is kept unchanged as a backup.`,

  oldLibraryTitle: "Old library",
  oldLibraryLine: "Analyses saved inside the app before files. This list is a backup and isn't changed.",
  openACopy: "Open a copy",

  recoverTitle: "Recover unsaved work",
  recoverRow: (name: string, folder: string, when: string) =>
    `${name}${folder ? ` — ${folder}` : ""} — unsaved changes from ${when}`,
  recoverEmpty: "No unsaved work is waiting.",
  recoverDeleteConfirm: "Delete these unsaved changes? This can't be undone.",

  startIntro: "Type or paste data into a table, pick a test and get a publication-ready graph. Each analysis is saved as a file you can keep in any folder.",
  recentTitle: "Recent files",
  recentEmpty: "Files you open or save appear here.",
  recentMissing: "Can't be found",
  recentOpened: (when: string) => `opened ${when}`,
  recentRemove: "Remove from this list",
  oldLibraryLinePrefix: "Analyses saved before files:",
} as const;

/** Menu labels, in the order of the native File menu (contract §6.1). */
export const MENU_TEXT = {
  new: "New",
  open: "Open…",
  openRecent: "Open Recent",
  noRecent: "No Recent Files",
  clearRecent: "Clear Menu",
  save: "Save",
  saveAs: "Save As…",
  duplicate: "Duplicate as a New Analysis…",
  closeTab: "Close Tab",
  recover: "Recover Unsaved Work…",
  oldLibrary: "Old Library…",
  exportLibrary: "Export Library to Files…",
  settings: "Settings…",
} as const;
