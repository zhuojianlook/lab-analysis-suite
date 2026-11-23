/* Every sentence the files UI shows (contract §5.3–5.5). The controller hands
   over structured data (banners, cards, dialogs, toasts); this module words it.
   Plain words only: never "revision", "head", "journal", "hash", "manifest",
   "draft", "sibling", "displaced" or "analysis id" (contract §5.5, checklist 46). */

import type {
  BannerAction, BannerKind, FileSettings, FileTab, PeerView, RestoreCard, SessionToast, ShareMode, SharingView, StatusLine, TabBanner, TabPresence,
  VersionChip, VersionInfo,
} from "../file/contract";
import { SECTION_PHRASE } from "../file/contract";
import { SECTION_NAMES, type SectionName } from "../file/format";

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
  const day = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === today.getFullYear() ? day : `${day} ${d.getFullYear()}`;
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

/** "Alice (Office iMac)" → "Alice (Office iMac)'s"; "you" → "your". */
export function possessive(who: string): string {
  if (who === "you") return "your";
  return who.endsWith("s") && !who.endsWith(")") ? `${who}'` : `${who}'s`;
}

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
  tookTheirs: "info", combined: "success", draftMismatch: "warning", copyQuestion: "info", extraCopy: "info", tempLocation: "info",
  rolledBack: "warning", newerOnDisk: "info", newerCopy: "info", olderCopy: "info", recovered: "success",
  // Phase 3 (who is editing): severities only, so the baseline compiles; the texts are the ui implementer's (phase3-contract.md §6).
  resuming: "info", continuedElsewhere: "info", bothEditing: "warning", waitingNewer: "info", editingElsewhere: "info",
  editingInfo: "info", unconfirmed: "info", olderPeer: "warning",
};

export function bannerSeverity(b: TabBanner): Severity {
  if (b.kind === "extraCopy") return b.relation === "newer" || b.relation === "diverged" ? "warning" : "info";
  if (b.kind === "savedOver" && b.state === "combining") return "info";
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
    case "savedOver":
      if (b.state === "combining") return "Another computer saved over your last save. Nothing is lost — combining both now.";
      if (b.state === "choose") return "Another computer saved over your last save. Nothing is lost. Choose what to keep.";
      return `Another computer saved over your last save. Nothing is lost — your version was saved as a copy: '${name}'.`;
    case "savedDisplaced": return `Saved. ${cap(who)} saved at the same moment; that version was kept as a copy: '${name}'.`;
    case "tookTheirs": return `Now showing the version saved by ${who}. Your version was saved as a copy: '${name}'.`;
    case "combined": {
      const list = sectionPhrases(b.sections ?? []);
      // Combined with my own save that another computer's save had replaced.
      if (b.version?.mine) return `Combined with your earlier save.${list ? ` Taken from it: ${list}.` : ""}`;
      return `Combined with the version saved by ${whoLine(b.version, settings)}.${list ? ` Taken from it: ${list}.` : ""}`;
    }
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
    // Phase 3 (who is editing; phase3-contract.md §6.2).
    case "resuming": return "Checking for changes made while this computer was asleep…";
    case "continuedElsewhere": {
      const p = b.peers?.[0];
      const at = p?.editingSince != null ? ` at ${clockText(p.editingSince)}` : "";
      return `${p?.sameUser ? "You" : peerUser(p)} continued on ${peerDevice(p)}${at}. Your unsaved changes here are kept and will be combined.`;
    }
    case "bothEditing": {
      const peers = b.peers ?? [];
      const list = joinNames(peers.map((p) => `${peerDevice(p)} (${p.sameUser ? "your other computer" : peerUser(p)})`));
      return `Also being edited on ${list || "another computer"}. Nothing is lost — the ${peers.length > 1 ? "versions are" : "two versions are"} combined when you save.`;
    }
    case "waitingNewer": return `${cap(peerDevice(b.peers?.[0]))} saved a newer version — loading it…`;
    case "editingElsewhere": {
      if (b.checking) return "Checking who is editing…";
      const peers = b.peers ?? [];
      const p = peers[0];
      if (peers.length <= 1) {
        if (p?.sameUser) return `You have this open on ${peerDevice(p)} with changes not yet saved there. Both sets of changes will be combined when that computer saves.`;
        const ago = p ? agoText(p.changedAt) : "";
        return `${peerUser(p)} is editing on ${peerDevice(p)}${ago ? ` (note updated ${ago})` : ""}. You'll see their changes each time they save.`;
      }
      const devices = joinNames(peers.map(peerDevice));
      if (peers.every((x) => x.sameUser)) {
        return `You have this open on ${devices} with changes not yet saved there. Both sets of changes will be combined when those computers save.`;
      }
      const users = uniq(peers.map((x) => (x.sameUser ? "you" : peerUser(x))));
      return `${cap(joinNames(users))} ${users.length > 1 ? "are" : "is"} editing this version on ${devices}. You'll see their changes each time they save.`;
    }
    case "editingInfo": {
      const peers = b.peers ?? [];
      const quiet = peers.filter((x) => x.state === "editing" && x.freshness === "quiet" && x.basedOn === "myVersion");
      const group = quiet.length ? quiet : peers;
      const allMe = group.length > 0 && group.every((x) => x.sameUser);
      const who = allMe ? "You" : cap(joinNames(uniq(group.map((x) => (x.sameUser ? "you" : peerUser(x))))));
      const devices = joinNames(group.map(peerDevice)) || "another computer";
      const one = group.length === 1 ? group[0] : null;
      const t = one ? noteClock(one.updatedAt) : null;
      if (quiet.length) {
        const when = t ? ` ${t.today ? "at" : "on"} ${t.text}` : "";
        return `${who} started editing on ${devices}${when} and may have unsaved changes there.`;
      }
      const from = t ? ` from ${t.text}` : "";
      if (allMe) return `You have unsaved changes on ${devices}${from}; they will be combined when ${group.length > 1 ? "those computers save" : "that computer saves"}.`;
      const plural = uniq(group.map((x) => (x.sameUser ? "you" : peerUser(x)))).length > 1 || allMe;
      const named = one && !one.sameUser && one.userName.trim() ? one.userName.trim() : null;
      const saver = named ? `${named} saves` : group.length > 1 ? "those computers save" : "that computer saves";
      return `${who} ${plural ? "have" : "has"} unsaved changes on ${devices}${from}; they will be combined when ${saver}.`;
    }
    case "unconfirmed": return "Couldn't confirm the newest version yet.";
    case "olderPeer": {
      const p = b.peers?.[0];
      const device = p?.deviceName.trim();
      return `${device ? device : "The other computer"} runs an older version that doesn't show who is editing — update it.`;
    }
  }
  return "";
}

const peerDevice = (p: PeerView | undefined) => p?.deviceName.trim() || "another computer";
const peerUser = (p: PeerView | undefined) => p?.userName.trim() || "Someone";
const uniq = (xs: string[]) => xs.filter((x, i) => xs.indexOf(x) === i);

/** "Alice" · "Alice and Bob" · "Alice, Bob and 1 other" · "Alice, Bob and 2 others". */
export function joinNames(names: readonly string[]): string {
  const n = names.filter((x) => x !== "");
  if (n.length <= 1) return n[0] ?? "";
  if (n.length === 2) return `${n[0]} and ${n[1]}`;
  const rest = n.length - 2;
  return `${n[0]}, ${n[1]} and ${rest} other${rest === 1 ? "" : "s"}`;
}

/** Where "now" comes from for texts: this computer's clock (the browser preview's simulator swaps in its own). */
let nowSource: () => number = () => Date.now();
export function setUiNow(fn: (() => number) | null): void { nowSource = fn ?? (() => Date.now()); }
export const uiNow = (): number => nowSource();

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const two = (n: number) => String(n).padStart(2, "0");

/** A moment on this computer's clock: "19:40" today, "Fri 18:02" within the last 7 days, "12 Nov 18:02" before that
 *  (with the year when it isn't this year). "" when it isn't a time. */
export function clockText(ms: number, now: number = uiNow()): string {
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const today = new Date(now);
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  if (d.toDateString() === today.toDateString()) return hm;
  const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (ms < startToday && startToday - ms < 6 * 86_400_000) return `${DAYS[d.getDay()]} ${hm}`;
  const day = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return `${d.getFullYear() === today.getFullYear() ? day : `${day} ${d.getFullYear()}`} ${hm}`;
}

/** A note's own time (the other computer's clock; display only). null when it doesn't parse. */
function noteClock(iso: string): { text: string; today: boolean } | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const text = clockText(t);
  return text ? { text, today: !text.includes(" ") } : null;
}

/** whenText for a time on this computer's clock (ms). */
export function agoText(ms: number | null | undefined, now: number = uiNow()): string {
  if (ms == null || !Number.isFinite(ms)) return "";
  return whenText(new Date(ms).toISOString(), now);
}

/** The kind of banner a refused edit points at (its button pulses), for a tab's guard. */
export const PRESENCE_KINDS: readonly BannerKind[] = [
  "resuming", "continuedElsewhere", "bothEditing", "waitingNewer", "editingElsewhere", "editingInfo", "unconfirmed", "olderPeer",
];
export function attemptBannerOf(tab: { banners: TabBanner[]; presence?: { guard: string | null } | undefined; readOnly: "tooNew" | null }): TabBanner | null {
  const g = tab.presence?.guard ?? (tab.readOnly ? "tooNew" : null);
  const want: BannerKind[] =
    g === "editingElsewhere" || g === "checking" ? ["editingElsewhere"]
      : g === "waiting" ? ["waitingNewer"]
        : g === "resuming" ? ["resuming"]
          : g === "tooNew" ? ["tooNew"] : [];
  for (const k of want) { const b = tab.banners.find((x) => x.kind === k); if (b) return b; }
  return tab.banners.find((x) => PRESENCE_KINDS.includes(x.kind) && x.actions.some((a) => a !== "dismiss"))
    ?? tab.banners.find((x) => PRESENCE_KINDS.includes(x.kind) || x.kind === "tooNew") ?? null;
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
    case "combine":
      return kind === "newerOnDisk" ? "Combine my changes with it" : kind === "extraCopy" ? "Combine…" : "Choose…";
    case "remove": return "Remove it";
    case "keep": return "Keep";
    case "whatChanged": return "What changed";
    case "undo": return "Undo";
    // Phase 3
    case "editHere": return "Edit here";
    case "editAnyway": return "Edit anyway…";
    case "keepEditing": return "Keep editing";
    case "saveCopy": return "Save my changes as a separate copy…";
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
    case "combined": return t.version?.mine ? "Combined with your earlier save" : `Combined with ${possessive(whoLine(t.version, settings))} changes`;
    case "broughtBack": return `Brought back the version from ${whenText(t.version?.time) || "earlier"}`;
    case "copyRemoved": return `Removed '${t.name ?? ""}'. The app keeps it for 30 days.`;
    case "savedAsNew": return `Saved as a new analysis: '${t.name ?? ""}'`;
    case "deviceIdChanged": return "This computer was using the same identity as another one. It now has its own.";
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
  readOnly: "Read-only",
  opening: "Opening…",
  /** The Save button's tooltip while the tab is read-only. */
  readOnlySave: "Read-only right now",
} as const;

interface DocStatusInput {
  status: FileTab["status"];
  saving: boolean;
  notSaved: boolean;
  readOnly: FileTab["readOnly"];
  dirty: boolean;
  path: string | null;
  presence?: TabPresence;
}

/** The status text of the document bar (phase 3 contract §6.4): the first that applies. */
export function docStatusText(tab: DocStatusInput, settings: FileSettings | null, now: number = uiNow()): string {
  if (tab.status === "opening") return STATUS.opening;
  if (tab.saving) return STATUS.saving;
  if (tab.notSaved) return STATUS.notSaved;
  const st = tab.presence?.status ?? null;
  const saved = st ? `${cap(whoText(st.who, settings))} saved${savedWhen(st, now)}` : "";
  // Read-only: the chip beside the title says so; the status line says who saved (short enough to stay visible
  // beside a banner; fixer F4).
  if (tab.readOnly || tab.presence?.readOnly) return saved || STATUS.readOnly;
  if (tab.dirty) return STATUS.dirty;
  if (st) return `Up to date · ${saved}`;
  return tab.path ? STATUS.saved : "";
}

function savedWhen(st: StatusLine, now: number): string {
  const w = st.seenAt != null ? agoText(st.seenAt, now) : whenText(st.who.time, now);
  return w ? ` ${w}` : "";
}

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
  /** fixer F5: the "same analysis" choice while the tab is read-only. */
  saveAsSameReadOnly: "Not available right now: this analysis is read-only while it is edited on another computer.",

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

  // Phase 3 (phase3-contract.md §6.5)
  editAnywayTitle: "Edit anyway?",
  editAnywayBody: (users: string) => `${users} may have unsaved changes. If you both edit, the two versions are combined on save. Continue?`,
  editAnywayGo: "Edit anyway",
  cancel: "Cancel",
  resumeSaveTitle: "Save now?",
  resumeSaveBody: "This computer was asleep. Changes made on another computer may not have arrived yet. If someone else saved meanwhile, the two versions are combined.",
  resumeSaveGo: "Save now",
  resumeEditTitle: "Keep editing?",
  resumeEditBody: "This computer was asleep. Changes made on another computer may not have arrived yet. If you both edit, the two versions are combined on save.",
  resumeEditGo: "Keep editing",
  resumeWait: "Wait",
  sharingTitle: "Show others when I'm editing this file",
  sharingDefault: (name: string) => `Use my default (${name})`,
  sharingHelp: "While you edit, other computers that have this file open show it as read-only until you save. The note file is small and safe to delete. Dropbox also has its own \u201cLock editing\u201d (paid plans); you can use it as well.",
  sharingClose: "Close",
  settingsShare: "Show others when I'm editing",
  settingsShareHelp: "Used for files that have no choice of their own.",
} as const;

/** "Show others when I'm editing": the three modes as choices (§6.5). */
export const SHARE_LABEL: Record<ShareMode, string> = {
  auto: "Automatically (in cloud folders)",
  always: "Always",
  never: "Never",
};
/** The short name of a mode, for "Use my default (…)". */
export const SHARE_SHORT: Record<ShareMode, string> = { auto: "Automatically", always: "Always", never: "Never" };

/** The status line of the sharing dialog, from SharingView.why. */
export function sharingStatusText(v: Pick<SharingView, "why" | "service">): string {
  switch (v.why) {
    case "cloud": return `On. This file is in ${v.service ?? "a cloud folder"}, so a small note file is kept next to it while it is open here.`;
    case "otherComputers": return "On. This file has been used on another computer.";
    case "always": return "On. A small note file is kept next to this file while it is open here.";
    case "local": return "Off. This file is not in a cloud folder and has only been used on this computer.";
    case "never": return "Off. Other computers can't see when you are editing this file.";
    case "untitled": return "Save the analysis to a file first.";
  }
  return "";
}

/** "Alice" / "Alice and Bob" for the Edit anyway dialog: the people (not me) the tab is read-only for. */
export function editAnywayText(peers: readonly PeerView[]): string {
  const users = uniq(peers.map((p) => (p.sameUser ? "you" : peerUser(p))).filter((u) => u !== "you"));
  const all = users.length ? users : uniq(peers.map((p) => peerUser(p)));
  return T.editAnywayBody(cap(joinNames(all)) || "Someone");
}

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
  versions: "Versions",
  sharing: "Show Others When I'm Editing…",
  recover: "Recover Unsaved Work…",
  oldLibrary: "Old Library…",
  exportLibrary: "Export Library to Files…",
  settings: "Settings…",
} as const;

// ── phase 2: sections, versions, combining (phase 2 contract §6) ────────────

/** A section as a title ("Data table"), contract §2.1. */
export const SECTION_TITLE: Record<SectionName, string> = {
  table: "Data table",
  analysis: "Analysis settings",
  figure: "Graph",
  scratchpad: "Scratchpad",
};

/** "the table" · "the table and the graph" · "the table, the analysis settings and the graph" (SECTION_NAMES order). */
export function sectionPhrases(keys: readonly SectionName[]): string {
  const p = SECTION_NAMES.filter((k) => keys.includes(k)).map((k) => SECTION_PHRASE[k]);
  if (p.length <= 1) return p[0] ?? "";
  return `${p.slice(0, -1).join(", ")} and ${p[p.length - 1]}`;
}

/** Who saved a version, for a list line: "you" stays lower case, a blank author is "another computer". */
export function whoLine(v: VersionInfo | null | undefined, settings: FileSettings | null): string {
  if (v && !v.mine && !v.userName.trim() && !v.deviceName.trim()) return "another computer";
  return whoText(v, settings);
}

/** "Alice's" for the Theirs button when a user name is known, else "Theirs". */
export function theirsLabel(v: VersionInfo | null | undefined, settings: FileSettings | null): string {
  const u = v?.userName.trim() ?? "";
  if (!v || v.mine || !u) return "Theirs";
  if (settings && u === settings.userName.trim()) return "Theirs";
  return u.endsWith("s") ? `${u}'` : `${u}'s`;
}

export const CHIP_TEXT: Record<VersionChip, string> = {
  current: "Current",
  combined: "Combined",
  broughtBack: "Brought back",
  fromOldLibrary: "From old library",
  tooOld: "Too old to open",
  unsaved: "Not saved yet",
};

/** The Versions panel and the read-only preview (§6.2). */
export const V = {
  title: "Versions",
  loading: "Loading versions…",
  close: "Close",
  workingSummary: "Unsaved changes",
  workingLine: (computer: string) => `you · ${computer || "this computer"} · now`,
  autoLine: (when: string) => `Combined automatically · ${when}`,
  rowLine: (name: string, computer: string, when: string) => [name, computer, when].filter(Boolean).join(" · "),
  copyLabel: (copyName: string) => `In '${copyName}'`,
  stubLabel: (name: string) => `Separate analysis: '${name}'`,
  legend: "Computers",
  thisComputer: "this computer",
  autoDevice: "Combined automatically",
  tooOldFooter: "Older versions are listed but can no longer be opened.",
  readOnly: "Read-only",
  previewTitle: (summary: string, who: string, when: string) => `${summary} — ${[who, when].filter(Boolean).join(", ")}`,
  tooOldBody: "This version is too old to open. Its entry is kept so you can see who saved it and when.",
  loadingVersion: "Opening this version…",
  compare: "Compare with current",
  bringBack: "Bring this version back",
  saveAsNew: "Save this version as a new analysis…",
  closePreview: "Close",
  tabGraph: "Graph",
  tabTable: "Table",
  tabScratch: "Scratchpad",
  graphUnavailable: "The graph can't be shown right now.",
  graphRendering: "Drawing the graph…",
  noData: "This version has no values in its table.",
  scratchEmpty: "The scratchpad of this version is empty.",
  same: "Same",
  different: "Different",
  thisVersion: "This version",
  graphsSideBySide: "Graphs side by side",
  current: "Current",
  cellsDiffer: (n: number) => `${n} cell${n === 1 ? "" : "s"} differ${n === 1 ? "s" : ""}`,
  andMore: (n: number) => `and ${n} more`,
  rowsAdded: (n: number) => `${n} row${n === 1 ? "" : "s"} added`,
  rowsRemoved: (n: number) => `${n} row${n === 1 ? "" : "s"} removed`,
  colsAdded: (n: number) => `${n} column${n === 1 ? "" : "s"} added`,
  colsRemoved: (n: number) => `${n} column${n === 1 ? "" : "s"} removed`,
  titlesChanged: (n: number) => `${n} title${n === 1 ? "" : "s"} changed`,
  settingLine: (field: string, a: string, b: string) => `${field}: ${a} → ${b}`,
  bringBackTitle: (when: string) => `Bring back the version from ${when}?`,
  bringBackBody: "You have unsaved changes. They are saved as a version first, so nothing is lost.",
  bringBackSave: "Save, then bring it back",
  cancel: "Cancel",
  versionsButton: "Versions",
  updating: "Updating…",
} as const;

/** The combine dialog (§6.4). */
export const C = {
  /** Combining with my own save that another computer's save replaced: the sides are named by what they are. */
  nowInFile: (who: string, unsaved: boolean) => `In the file now: saved by ${who}${unsaved ? ", with your unsaved changes" : ""}`,
  replacedSave: (when: string) => `Your save that was replaced${when ? ` (${when})` : ""}`,
  nowInFileButton: "In the file now",
  replacedSaveButton: "Your save",
  sideNowInFile: "In the file now",
  sideReplaced: "Your replaced save",
  title: (name: string, since: string) => `Two versions of '${name}' changed since ${since}`,
  titleTwoWay: (name: string) => `Two versions of '${name}'`,
  mine: (computer: string, unsaved: boolean) => `Mine: ${computer || "this computer"}${unsaved ? ", with unsaved changes" : ""}`,
  theirs: (who: string) => `Theirs: ${who}`,
  theirsCopy: (copyName: string, who: string) => `Theirs: '${copyName}', saved by ${who}`,
  queue: (i: number, n: number) => `Copy ${i} of ${n}`,
  twoWay: "These two copies were last the same too long ago to compare part by part. Choose which to keep for each part that differs.",
  toChoose: (n: number) => `${n} to choose`,
  unchanged: "Unchanged",
  combinedChip: "Combined",
  chooseChip: "Choose",
  fromMine: "from mine",
  fromTheirs: (who: string) => `from ${who}`,
  notChanged: (n: number) => `Not changed (${n})`,
  combinedAuto: (n: number) => `Combined automatically (${n})`,
  mineButton: "Mine",
  adjusted: (list: string) => `Adjusted automatically: ${list}. Some settings pointed at rows or columns that are no longer in the table. Check the result after applying.`,
  cancel: "Cancel",
  keepBoth: "Keep both as separate files",
  apply: "Apply",
  footnote: "Nothing is saved until you press Apply. Both versions stay in the file's history.",
  sideMine: "Mine",
  sideTheirs: "Theirs",
  sideLabel: (side: string, who: string) => `${side}: ${who}`,
  sectionSame: "Both versions have the same content here.",
  notAvailable: "Nothing to show for this part.",
  scratchCells: (n: number) => `${n} cell${n === 1 ? "" : "s"} differ${n === 1 ? "s" : ""}`,
  noTableChange: "No cells differ.",
  noSettingsChange: "No settings differ.",
  willKeep: (side: string) => `Keeping ${side}`,
} as const;

/** The labelled undo step after a combine ("Undo: combine with Alice's changes"), as the store gives it. */
export const undoTooltip = (label: string | null) => label ?? "Undo";
