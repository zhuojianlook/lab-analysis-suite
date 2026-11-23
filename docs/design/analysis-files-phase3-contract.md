# Phase 3 contract — Check-out: read-only on the other computers while one is editing

Binding for the five phase 3 implementers: **rust**, **presence** (pure TS engine), **readonly** (read-only enforcement in the editor), **session** (wires presence into `useFileSession`), **ui** (banners, chip, status line, setting, simulator panel). They work in parallel and cannot talk, so everything at a boundary is decided here. Sources: the approved plan (`analysis-files-plan.md` §6, 7, 10, 11, 13, 14 row 3, 16 D3 / D6 / D9 / D10, 17), the phase 1 and phase 2 contracts with every "CHANGED BY" note, and the code as released in exp-0.2.21 (commit 92a88e5).

- **Normative TypeScript shapes:** `TauriApp/src/components/graph/file/contract.ts`, section 7 ("Phase 3") plus the members marked "Phase 3" in the earlier unions and constants. It is already in the repo and compiles (`tsc --noEmit`; vitest 24 files / 517 tests green with it). Nobody edits it. If something in it is wrong, say so in your final report and work around it.
- "Repo" = `/Users/zhuojianlook/Library/CloudStorage/Dropbox/GitHub Repos/Webtools/Analysis/TauriApp`. Paths below are relative to it unless they start with `/`.
- Phase 1 / 2 behaviour that this document does not mention stays exactly as it is.
- **Words.** The code says *note* for the plan's "beacon" (the `.laguse` file), and may say claim / epoch / seq / heartbeat / supersede. **The UI never does**: it says *note*, *editing*, *version*, *this computer*, *read-only*. The banned-word test (`files-ui/text.test.ts`) gains `beacon`, `claim`, `epoch`, `heartbeat`, `supersede`, `stale`, `seq`, `presence`, `linger`, `session id`.
- The four principles of plan §6.1 are requirements, tested in §8: the note is a courtesy (safety stays with the save check, the sibling scan, the journal and combining); **nothing is decided by comparing the clocks of two machines**; one note per device and a device writes only its own; **nobody with unsaved edits is ever frozen and no keystroke waits for disk or network**.
- Not in phase 3: request-to-edit / hand-over (plan §6.9; fields reserved), cell-level combining (phase 4).
- Where this contract narrows or changes the plan on purpose: §9.

---

## 1. The note file

### 1.1 Content

A note is a small UTF-8 text file (no BOM written; one is tolerated when reading):

```
Lab Analysis Suite note: shows who has this analysis open. Safe to delete.
{
 "format": "lasgraph-presence",
 "v": 1,
 "analysis_id": "a-3f0c…",
 "document_name": "Dose response.lag",
 "device_id": "d-6b1e…9f3c",
 "session_id": "s-…",
 "device_name": "Mac mini",
 "user_name": "Zhuo",
 "state": "editing",
 "head": "r-01JD…",
 "base_revision": "r-01JD…",
 "epoch": 3,
 "seq": 41,
 "supersedes": null,
 "updated_at": "2026-11-22T10:14:03.512Z",
 "request_to": null,
 "handover_to": null,
 "features": 2
}
```

- Line 1 is exactly `NOTE_FIRST_LINE`, then `\n`, then the object as `JSON.stringify(note, null, 1)` (one space of indent, keys in the order of `NoteJson`), then `\n`. Rust writes the same bytes with a writer that keeps that key order (test vector R2).
- **Reading** (`parseNote`, and its Rust twin): the file must be ≤ `LIMITS_P3.noteMaxBytes` (8192) bytes, else it is not a note and is not read further. The JSON is the text from the first `{` to the last `}`. It is a note when that parses and `format === "lasgraph-presence"`, `v === 1`, `analysis_id`, `document_name`, `device_id`, `session_id` are non-empty strings, `device_name`, `user_name`, `updated_at` are strings, `epoch` and `seq` are finite numbers ≥ 0, `head` and `base_revision` are strings or null. Tolerated: unknown keys (ignored, not kept); a `state` other than `"editing"` → `"idle"`; `supersedes` given as one object → a one-element list; `supersedes` entries without a string `device_id` and a number `epoch` are dropped (an empty list → `null`); `features` missing → `2`; `request_to` / `handover_to` anything → `null`. Anything else is not a note: it is ignored and never deleted.
- **Fields phase 3 writes:** all of the above. `state` is `idle` or `editing` only; `base_revision` is non-null exactly when `state` is `editing`; `supersedes` is non-null only when `state` is `editing`; `request_to` and `handover_to` are always `null`; `features` is `2`.
- **Reserved, never written:** `state: "requesting"`, `request_to`, `handover_to` (plan §6.9).
- `updated_at` is the writer's clock. It is used for display ("from Fri 18:02") and for the first-sight rule (§2.3) only.
- `epoch`: + 1 every time this computer starts editing the document (§5.3). `seq`: + 1 on **every** rewrite of the note, whatever the reason.
- Size: with 60-character names and a 255-byte document name a note is under 1.2 KB; a writer never produces more than 4096 bytes.

### 1.2 File name

`<stem> (in use on <device>, <tag>).laguse` in the **same folder as the document**.

- `<stem>` = `sanitizeNamePart(document file name without ".lag", 60, 120, "Analysis")`.
- `<device>` = `sanitizeNamePart(device_name, 30, 60, "computer")`.
- `<tag>` = `deviceTag(device_id, attempt)`: take the device id in lower case and keep only `0-9a-f`; attempt 0 = the last 4 of those characters, attempt 1 = the 4 before them, attempt 2 = the last 8; fewer characters than needed → filled with `0` on the left. (`d-6b1e…9f3c` → `9f3c`; `d-preview-this` has the hex characters `d`, `e`, `e` → `0dee`.)
- The writer uses attempt 0 unless a file with that name exists and is **another device's** note (read by content); then attempt 1, then 2. If all three are taken by other devices it writes attempt 2 anyway (matching is by content; the other device rewrites its own).

`sanitizeNamePart(text, maxChars, maxBytes, fallback)` — identical in TS (`presence.ts`) and Rust (`presence.rs`), per Unicode scalar value, **no normalisation**:

1. ASCII: keep `A-Z a-z 0-9`, space, `-`, `(`, `)`, `,`. Every other ASCII character (controls, `_ . ' " & # % ~ $ ! + = ; @ [ ] { } ^` and `/ \ : * ? < > |`) → one space.
2. Non-ASCII: U+0080–U+009F and the space characters U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 → one space. The invisible characters U+00AD, U+200B–U+200F, U+202A–U+202E, U+2060–U+2069, U+FEFF → removed. Every other character is kept (letters of every script, combining marks, CJK, emoji).
3. Runs of spaces → one space; trim spaces at both ends.
4. Cut to the first `maxChars` scalar values; then drop scalar values from the end while the UTF-8 length is over `maxBytes`; trim spaces again.
5. Empty → `fallback`.

So a name never starts with a dot or `~`, never contains `.tmp`, `.lock`, `~$`, `_vti_` or a character OneDrive / Windows refuse, never ends in a space or a dot (it always ends in `).laguse`), and the whole file name is at most 120 + 60 + 26 = 206 bytes.

| input | result |
|---|---|
| `Dose response`, `Mac mini`, `d-…9f3c` | `Dose response (in use on Mac mini, 9f3c).laguse` |
| stem `Exp_2: 50% (v1.3)` | `Exp 2 50 (v1 3)` |
| stem `.~hidden.tmp` | `hidden tmp` |
| stem `a/b\c:d*e?f"g<h>i\|j` | `a b c d e f g h i j` |
| device `Zhuo's MacBook-Pro` | `Zhuo s MacBook-Pro` |
| stem `用量反応 2026年` | unchanged |
| stem of 70 × `用` | 40 × `用` (60 characters = 180 bytes → cut to 120 bytes) |
| stem `naïve—test` | unchanged |
| stem of three spaces, or `...` | `Analysis` |
| device of 45 × `x` | 30 × `x` |
| stem `~$report.lock` | `report lock` |

The name is a label for people. **Nothing ever decides anything from a note's name** except that it ends in `.laguse` (any case) and does not start with `.`.

### 1.3 Writing (atomic, own folder only)

Rust writes a note like a save's temp step: the bytes go into `.~<note file name>.tmp-<8 hex>` **in the same folder** (the existing `temp_name_for` / `write_synced`), then a rename over the target. That temp name is hidden, has neither extension, is skipped by the sibling scan and by every listing, is ignored by Dropbox / OneDrive / iCloud (phase 0 spike), and orphans older than 10 min are already removed by `graphfile_read` in that folder. Never a bare `~` prefix with a `.tmp` ending. A failed write removes its temp file and is reported (§3.2); nothing is retried inside the command.

The target is always `parent(docPath) / noteFileName(...)`. A command never writes, renames or deletes outside the document's folder, never follows a symbolic link for the note itself (a symlink at the target name → `Invalid`), and never touches a file whose name does not end in `.laguse`.

### 1.4 Which document a note is about (matched by content)

A note applies to the document at path `P` with analysis id `A` when:

1. `note.analysis_id === A`, **and**
2. `note.document_name` names `P`'s file — TS (`noteApplies`): equal after NFC + lower-casing; Rust: equal ignoring ASCII case, or `parent(P)/document_name` exists and is the same file as `P` (device + inode, `is_same_file`; this covers NFC / NFD and case on macOS) — **or** `P` is the only local `.lag` file in the folder whose header has analysis id `A` (`sameIdFiles === 1`).

So after a Finder duplicate (two files, one id) each file only sees the notes that name it, and after a rename by another computer the note still applies while there is one file with that id. A note is an **orphan** when no `.lag` file in the folder has its analysis id. Notes that apply to another existing document of the folder are ignored for `P`.

### 1.5 Several notes of one device; conflict copies

Sync services make copies of notes too (`… (conflicted copy 2026-11-22).laguse`, `…-MACMINI.laguse`, `… (1).laguse`). All end in `.laguse` and are read by content. Among the notes of one `device_id` that apply to a document, **the highest `seq` wins**; ties → the later `updated_at` (plain string compare), then the smaller file path (`pickPerDevice`). The owner deletes its own extra copies whenever it writes (§3.2 step 6); other computers' leftovers go by the 24 h rule (§3.7).

### 1.6 Everything else ignores notes

`.laguse` files and their conflict copies are never analyses: the sibling / extra-copy scan (`list_lag_files`: `.lag` only — unchanged), Recent, Find it… (`graphfile_locate`: `.lag` only), `opens.rs` (`is_lag`), the file association (`ext ["lag"]`), `graphfile_scan_dir` (still lists them with `kind: "presence"`, `header: null`; no caller treats them as documents), the preview's path picker and `DevSimApi.files()` (session filters them out of every listing the UI shows). rust adds one test per Rust listing (R12); session one for the preview listings (S24).

---

## 2. Pure TypeScript module (owner: presence)

New file `src/components/graph/file/presence.ts` with `presence.test.ts` beside it (and `presence.scenarios.test.ts` if wanted). No I/O, no clock, no randomness, no store access; synchronous. It exports functions with **exactly** the names and types of `PresenceApi` (contract.ts §7.4) and checks that at compile time:

```ts
({ noteText, parseNote, sanitizeNamePart, deviceTag, noteFileName, isNoteFileName, noteApplies, pickPerDevice, emptyObs, observe,
   markGap, freshness, decide, gapDetected, olderPeer, multiDevice, shareDecision, liveNoteHeads, cleanupTargets,
   duplicateIdentity }) satisfies PresenceApi;
```

May import: `contract.ts` (types, `LIMITS_P3`, `NOTE_*`, `FEATURES_P3`), `format.ts` (types, `PRESENCE_EXT`). Nothing else.

### 2.1 Clock

Every time is a number the caller passes: **this computer's own clock in ms** (`deps.now()`; `Date.now()` in the app, the `ManualClock` in tests). The engine reads a note's `updated_at` only in the first-sight rule, and compares two notes' `updated_at` only as the tie-break of `pickPerDevice` (same device, same `seq`).

"Suspend-aware": the clock may jump (sleep, a corrected system clock). That is handled by **gap detection**, not by trusting intervals: `gapDetected(prevAt, now, intervalMs)` is true when `now − prevAt − intervalMs > LIMITS_P3.sleepGapMs` (a timer fired more than 90 s late) or `now < prevAt` (the clock went backwards). On a gap the caller calls `markGap` (§2.2) before anything else.

### 2.2 Observations — `observe(prev, notes, now, knows)`

`notes` = the foreign notes that apply to the document, one per device (the caller already ran `pickPerDevice` and removed its own). Returns a new `PresenceObs`; never mutates.

Per note `n`, with `o = prev.notes[n.device_id]`:

- **No `o` (first sight), or `o.checking`** (first look after a sleep gap): a new observation `{deviceId, sessionId, epoch, seq, state, firstSeenAt: now, changedAt: now, changes: 0, editingSince: state === "editing" ? now : null, oldAtFirstSight, checking: false}` with `oldAtFirstSight` = `Date.parse(n.updated_at)` is not finite, or `now − Date.parse(n.updated_at) > LIMITS_P3.firstSightOldMs`. One exception for the re-look after a gap: when `(session_id, epoch, seq)` differs from what `o` had, `changes: 1` and `oldAtFirstSight: false` (the note moved: it is alive).
- **`o` exists and `(session_id, epoch, seq)` is unchanged** → `o` as it is (with `state` copied).
- **Changed** → `{...o, sessionId, epoch, seq, state, changedAt: now, changes: o.changes + 1, oldAtFirstSight: false}`; `editingSince`: `now` when the state became `editing` or the epoch changed while editing; kept while it keeps editing in the same epoch; `null` when idle.
- Devices without a note in `notes` are dropped (a deleted note is forgotten at once, so arrival order does not matter).

`unknownSince`: for every version id `h` among the notes' `head` and (when editing) `base_revision` with `!knows(h)`: keep `prev.unknownSince[h]`, else `now`. Ids that are known now, or that no note declares any more, are dropped. `checkingSince` → `null`.

`markGap(prev, now)`: every observation gets `checking: true`; `unknownSince` is emptied (the waits start again with the next look); `checkingSince = prev.checkingSince ?? now`.

### 2.3 Freshness — `freshness(o, now, checkingSince)` (plan §6.3, on the observer's own time)

1. `o.checking`: while `now − checkingSince < LIMITS_P3.recheckMaxMs` (15 s) → `"checking"`. After that (the folder could not be listed after waking) go on with rule 2 as if the note had been first seen at `checkingSince`.
2. `o.changes === 0` (nothing has changed in front of me yet): `o.oldAtFirstSight` → `"quiet"` at once; otherwise `"active"` while `now − o.firstSeenAt < LIMITS_P3.freshFirstMs` (90 s), then `"quiet"`.
3. `o.changes ≥ 1`: `"active"` while `now − o.changedAt < LIMITS_P3.staleMs` (5 min), then `"quiet"`.

A wrong clock on the other computer can only change `oldAtFirstSight`: an `updated_at` in the past makes editing available sooner; one in the future gives at most 90 s of read-only (rule 2). Freshness matters only for `editing` notes; idle notes are never judged by it.

### 2.4 The tab's mode — `decide(input)` (plan §6.3, §6.6, §6.7)

Definitions, for every foreign note `p` with its observation `o` (a note without one is treated as first seen at `input.now`):

- `fresh(p)` = `freshness(o, now, obs.checkingSince)`.
- `basedOn(p)` (only when `state === "editing"`): `base_revision === diskHead` → `"myVersion"`; else `knows(base_revision)` → `"older"`; else `"unknown"`.
- `superseded(p)` = another foreign note `q` has `{device_id: p.device_id, epoch: p.epoch}` in `q.supersedes`.
- `overridden(p)` = `input.overrides` contains `{p.device_id, p.epoch}`.
- `supersedesMe(p)` = `input.holding` and `p.supersedes` contains `{me.deviceId, input.myEpoch}`.
- `sameUser(p)` = `p.user_name.trim() !== ""` and it equals `me.userName.trim()`.

`peers` = all foreign notes as `PeerView`, sorted: editing before idle, then by `deviceName`, then `deviceId`. `about` lists the device ids the mode is about, in that order.

**A. The tab has unsaved changes or I am holding (`dirty || holding`).** Never `readOnly`, never `waiting`.

1. Some `p` with `supersedesMe(p)` → mode **`bothEditing`**, `yieldedTo` = that device (the smallest device id when several), `about` = it.
2. Else `input.resuming` → mode **`resuming`**, `about` = the editing peers.
3. Else some editing `p` with `fresh(p) !== "quiet"` → mode **`bothEditing`**, `about` = all of those.
4. Else some editing `p` (all quiet) → mode **`info`**, `about` = them.
5. Else **`editable`**.

**B. The tab is clean and I am not holding.**

1. **Waiting for a newer version.** Candidates: every `p` with `p.head !== null && !knows(p.head)` (any state, any freshness), and every editing `p` with `basedOn(p) === "unknown"` and `fresh(p) !== "quiet"`. For a candidate: `h` = the unknown id; `since = obs.unknownSince[h] ?? now`; `limit` = `LIMITS_P3.waitOldNoteMs` (20 s) when `o.oldAtFirstSight && o.changes === 0`, else `LIMITS_P3.waitNewerMs` (2 min); `until = since + limit`. Any candidate with `now < until` → mode **`waiting`** with `waiting = {head: h, deviceId, since, until}` (the candidate with the latest `until`), `about` = its device. Candidates whose time ran out set `unconfirmed: true` and are otherwise ignored.
2. **Read-only.** `B` = the editing notes with `basedOn === "myVersion"`, `fresh !== "quiet"`, not `overridden`. When at least one member of `B` is **not** `superseded` → mode **`readOnly`**; `about` = all of `B` (superseded members included: "both names"); `blockers` = `{device_id, epoch}` of every member of `B`; `checking` = every non-superseded member is `"checking"`.
3. **Information only.** Any editing note that is quiet, or `basedOn === "older"`, or `overridden`, or a member of an all-superseded `B` → mode **`info`**, `about` = those.
4. Otherwise **`editable`**.

`nextCheckAt` = the earliest future moment at which a freshness or a wait used above flips (`firstSeenAt + 90 s`, `changedAt + 5 min`, `checkingSince + 15 s`, `until`), or `null`.

Properties the tests must hold (§8 P-tests): the result depends only on the current inputs (the same notes in any order give the same answer); `dirty || holding` ⇒ mode is neither `readOnly` nor `waiting`; a clean observer is `readOnly` only while an active (or checking) editing note based on its `diskHead` exists; with no change of the notes, `readOnly` ends at the latest 5 min after the last seq change seen (90 s after first sight when none was seen; at once when the note was old at first sight); `waiting` ends at the latest 2 min after the unknown version was first seen; removing a note removes its effect at once.

### 2.5 The small helpers

- `olderPeer(m, myDeviceId, notes)`: `m.features < FEATURES_P3`; from the head revision follow first parents to the first revision with `device_id !== ""`; that device is not `myDeviceId`; no note in `notes` has that `device_id` → `{deviceId, deviceName, userName}` of that revision; else `null`.
- `multiDevice(m, myDeviceId, notes)`: a revision with `device_id !== ""` and `!== myDeviceId`, or `notes.length > 0`.
- `shareDecision({choice, fallback, untitled, cloud, multiDevice})`: `untitled` → off / `untitled`; mode = `choice ?? fallback`; `"never"` → off / `never`; `"always"` → on / `always`; `"auto"`: `cloud` → on / `cloud`; else `multiDevice` → on / `otherComputers`; else off / `local`.
- `liveNoteHeads(notes)`: every non-null `head` and `base_revision`, unique, sorted.
- `cleanupTargets(records, now)`: `{file, sha}` of every record with `!own && (applies || orphan) && unchangedSince > 0 && now − unchangedSince ≥ LIMITS_P3.cleanupMs`.
- `duplicateIdentity(before, after, me)`: a note in `after` with `device_id === me.deviceId` and `session_id !== me.sessionId`, and a note in `before` with the same `device_id` and `session_id` and a **smaller** `seq`.
- `isNoteFileName(name)`: does not start with `.`, ends in `.laguse` ignoring case.

> **CHANGED BY presence:** points the text above left open, as `presence.ts` implements them (no signature changed; `presence.ts` also exports `presenceApi` — the whole `PresenceApi` object — and `utf8Length`):
> 1. `superseded(p)` and `supersedesMe(p)` count only `supersedes` of notes whose `state` is `editing` (a writer never sets it otherwise; an idle note that still lists it overrides nothing). `superseded` ignores a note naming its own device.
> 2. `decide` with a record that is behind the note (other `(session_id, epoch, seq)`, not `checking`) takes the note in as a change at `now` (as `observe` would); a note without a record is a first sight at `now`, and `nextCheckAt` then includes the moment it becomes old by this computer's clock (`Date.parse(updated_at) + firstSightOldMs`). Several notes of one device in `notes` (unreduced) → the `pickPerDevice` rule, then the note text, so the order never matters; a note with my own device id is ignored.
> 3. A negative span on this computer's clock (it went backwards and no gap was noted) counts as expired everywhere (freshness windows, waits): a wrong clock can only end read-only / waiting sooner.
> 4. An `editing` note with `base_revision: null` is never `myVersion` (`basedOn: "unknown"`) and is no waiting candidate for its base; a base equal to the note's head is one candidate, not two. `freshness` with `checking: true` but `checkingSince: null` uses rules 2 / 3.
> 5. `observe`: `editingSince` also restarts when the `session_id` changes while editing. Device ids and version ids are stored as own keys (a note with device id `__proto__` / `constructor` is handled like any other).
> 6. `parseNote`: `features` that is not a finite number → `2`; `supersedes` that is neither a list nor an object → `null`; the 8192 limit is on the UTF-8 bytes (a BOM counts); `head` / `base_revision` missing → `null` (as `presence.rs` reads them); present but not a string / `null` → not a note.
> 7. `sanitizeNamePart` removes a lone UTF-16 surrogate (it cannot occur in Rust). `deviceTag` lower-cases ASCII only.

> **CHANGED BY fixer:** (verifier findings VP-4, F6; no signature changed)
> 1. §2.2 **late arrivals** (VP-4): a change of `(session_id, epoch, seq)` whose own `updated_at` is more than `firstSightOldMs` before *now* (by this computer's clock: it was written long ago and reached me late — I was offline, asleep or just started) is taken in (identity updated) **without** counting as a sign of life: `changes`, `changedAt` and `oldAtFirstSight` stay as they were. A second such change in a row does count (the note keeps moving: its writer's clock is wrong) and from then on old-looking changes count until a change with a recent time is seen. The re-look after a gap treats a moved note whose time is old the same way (a first sight that is old; its next change counts). The mark is an extra key `late` on the observation (not in contract.ts's `NoteObs`). So the other computer's clock is still used only in the direction that frees a tab; a wrong clock costs at most one rewrite (60 s) of read-only. `decide`'s `nextCheckAt` includes the moment a change it takes in itself would turn old. P4 / P5 / P9 tests and the scenario oracle were updated.
> 2. §2.2 re-look after a gap (F6): `editingSince` is kept when the note is still the same editing period (same session and epoch, still editing), so "continued on … at {clock}" no longer jumps to the wake-up time.

---

## 3. Rust (owner: rust)

New file `src-tauri/src/presence.rs` (+ `presence_tests.rs`); changes in `graphwatch.rs` (listing and events), `quit.rs` / `lib.rs` (delete on quit, register the commands), `menu.rs` (one item), `appstate.rs` (new device id), `devenv.rs` (debug env vars), `deve2e.rs` (§3.11). **No new crate**, `Cargo.lock` unchanged, `cargo build --locked` keeps working (ISO times: a small days-to-civil function, no `chrono`). All commands follow phase 1 §1.2 (async, `spawn_blocking`, 15 s timeout, typed `FileErr`) except `presence_input`, which only touches memory. Names and shapes: `CMD`, `Commands`, `PresenceSetArgs`, `PresenceSetReply`, `PresenceListReply`, `NoteRecord`, `NoteJson`, `RemoveNoteArgs`, `RemoveNoteReply`, `CloudInfo`, `RustFileEventP3` in contract.ts. Envelopes are camelCase; **`NoteJson` is snake_case** (it is the file's own format and passes through as it is).

### 3.1 State

In `FileCtx`: `presence: Mutex<PresenceState>` with

- `own: HashMap<PathBuf /*docPath*/, OwnNote>`; `OwnNote {file: PathBuf, note: NoteJson, last_write: Instant, last_input: Option<Instant>, beating: bool}`;
- `closing: bool`;
- `seen: HashMap<PathBuf /*note file*/, (String /*sha*/, i64 /*since, wall ms*/)>`, persisted as `<state>/graph-notes.json` `{"v":1,"seen":{"<path>":{"sha":"…","since":…}}}` (atomic; written at most every 5 s and in the quit path; at most 1000 entries, the oldest `since` dropped; an unparsable file is moved to `.bad-<ms>` like the session);
- `written: BTreeSet<PathBuf>` — every note file this app created and has not deleted, persisted as `<state>/graph-notes-own.json` `{"v":1,"files":[…]}` (atomic, on every change). Without a state folder both live in memory only.

"Own" everywhere = the note's `device_id` equals this computer's device id **or one of its `aliases`** (`device.json`).

### 3.2 `presence_set { req: PresenceSetArgs } → PresenceSetReply`

1. `Invalid` unless `docPath` is absolute and ends in `.lag`, the ids match the id rule (phase 1 §0.4), `epoch ≥ 0` and `state` is `idle` / `editing`.
2. `closing` → `{kind: "off", reason: "closing"}`. **Debug builds:** unless `docPath` is under one of the folders in env `LAS_NOTE_ROOTS` (a list separated by `:`; `;` on Windows) → `{kind: "off", reason: "debugRoot"}` — a debug app never writes a note beside a real file. Release builds ignore the variable.
3. The folder must exist (`NotFound` / `PermissionDenied` as for any path). The document itself need not be readable.
4. Build the note: `document_name` = the file name of `docPath`; device id / name, user name and session id from the device identity; `state`, `head`, `base_revision` (`null` unless editing), `epoch`, `supersedes` (`null` when the list is empty or the state is idle) from `req`; `updated_at` = now (UTC, ms, `Z`); `features: 2`; **`seq` = 1 + max(the registered note's seq for this `docPath`, the seq of every own note in the folder that applies to it)**.
5. Target name by §1.2 (attempts 0 → 1 → 2); write atomically (§1.3).
6. Delete every **other** own note file in the folder that applies to this document (an old name after a rename of the document or the computer, conflict copies of my note), each only after reading it as an own note.
7. Register: `own[docPath] = {file, note, last_write: now, last_input: req.input ? now : the previous value, beating: true}`; add `file` to `written`; record the file in `seen`.
8. Reply `{kind: "written", file, note}`.

Calls for one `docPath` run one at a time and in arrival order (a lock per `docPath`); a slow folder never blocks another document's note. Errors reject with `FileErr` (`PermissionDenied`, `OfflineOrTimeout`, `Io`, `NotFound`) and leave the registry as it was.

### 3.3 `presence_clear { docPath } → null`

Removes `own[docPath]` and deletes its file and every other own note in the folder that applies to the document (each read as an own note first; missing is fine; errors are logged, not returned). Used when a tab is closed, the setting is switched off, the document is gone, or the path changed.

### 3.4 `presence_input { docPath } → null`

Memory only: `own[docPath].last_input = now` (monotonic `Instant`). Unknown path → nothing. **This is how input times reach Rust**: the controller calls it at most every `LIMITS_P3.inputPingMs` (30 s) per document while there is input (§5.3); `presence_set` with `input: true` counts too.

### 3.5 The heartbeat thread

One thread `presence`, started in `setup`, ticking every 1 s on `Instant` (which does not run during sleep). For each `OwnNote`:

- `state == editing && beating && now − last_write ≥ 60 s` and `last_input` within 10 min (`LIMITS_P3.heartbeatMs`, `inputWindowMs`) → rewrite the note with `seq + 1` and a new `updated_at` (the same atomic write, under the document's note lock; skipped for this round when the lock is held).
- `state == idle && now − last_write ≥ 6 h` (`idleKeepAliveMs`) → rewrite likewise, so the note of a running app never looks abandoned for 24 h.
- No input for 10 min → no rewrite: the note stays `editing` and other computers judge it quiet after 5 min. When input comes back (`presence_input`), the next tick rewrites at once if 60 s have passed.
- A failed rewrite is logged and tried again on the next due tick; it is never reported to the frontend.

**Sleep gap.** The poll thread (`graphwatch::start`) already notices a tick more than 90 s late by wall clock. On that it now also sets `beating = false` on every `OwnNote` — the heartbeat **stops** until the next `presence_set` for that document; the controller decides whether to claim again (§5.6) — and emits `graphfile://event` `{type: "wake", gapMs}`. The idle keep-alive is not affected.

### 3.6 Listing — `presence_list { docPath, analysisId } → PresenceListReply`, and the poll

One function `scan_notes(ctx, doc_path, analysis_id)` used by the command and by the poll:

1. List the document's folder once (`read_dir`); take regular files (no symlinks) whose name does not start with `.` and ends in `.laguse` (any case), sorted by name, at most `LIMITS_P3.notesPerFolder` (200; more → `truncated: true`).
2. Per file: `stat`; a size over 8192 → skip. Cached in memory by `(path, size, mtime)`: only a new or changed file is read (one read of ≤ 8 KB), parsed (§1.1) and hashed (SHA-256 of its bytes). Not a note → skipped (and remembered as such for that size / mtime).
3. `applies` by §1.4 (the same-id `.lag` files come from the header cache the sibling scan keeps); `orphan` when no local `.lag` in the folder has the note's analysis id (while the folder holds a dataless `.lag`, nothing is an orphan: it may be that document); `own` by §3.1.
4. `unchangedSince`: `seen[file]` with the same `sha` → its `since`; else `since = now` (wall ms), recorded. Entries of this folder whose file is gone are dropped.
5. Return the records with `applies || orphan` (own ones included), sorted by `file`.

`presence_list` runs it for any `.lag` path, tracked or not. It never writes or deletes a note.

**The poll (no extra load).** A look at a due track (phase 1 §3.2) runs `scan_notes` after the sibling step: one more listing of the same folder, and no file is read unless its size or mtime changed. The track keeps `notes_sig` = a hash over the sorted `(file, sha)` of the returned records, **leaving out own notes whose `session_id` is this launch's** (my own heartbeat must not wake the frontend). When the signature differs from the last one sent for that track (the first look counts as different when the list is not empty) → emit

```json
{ "type": "presence", "path": "<tracked path>", "notes": [ … NoteRecord … ] }
```

with the full current list (own notes included). The scan also runs while the track is `Missing` / `Unreadable` when the folder can be listed; when it cannot, nothing is emitted. After a re-key the signature is reset so the new path gets an event.

### 3.7 `presence_remove_foreign { req: RemoveNoteArgs } → RemoveNoteReply`

`Invalid` unless `file` is absolute, its name ends in `.laguse` and does not start with `.`. Then: not there → `kept / gone`; a symlink, over 8192 bytes or not a note → `kept / notANote`; the SHA-256 of the bytes read **now** ≠ `req.sha` → `kept / changed`; own → `kept / own`; else `remove_file` → `removed` (and it is dropped from `seen`). This is the only way another computer's note is ever deleted; the decision (unchanged for 24 h, §2.5 `cleanupTargets`) is the controller's.

### 3.8 Quit, crash, start

- **Quit.** `presence::delete_all_own(ctx, 1500 ms)`: set `closing`; on a helper thread delete every file of `own` and of `written` that still reads as an own note; wait for it at most `LIMITS_P3.quitDeleteMs`; write the two records. It is called (a) at the start of the quit machine's finish action in `lib.rs`, before the engine is stopped; (b) in `RunEvent::ExitRequested` for the updater's restart code and when there is no quit driver; (c) in `RunEvent::Exit` as the synchronous backstop. It is idempotent and returns at once when nothing is registered. A cancelled quit (`stage: "cancel"`) never reaches it.
- **Crash / power loss.** The notes stay; other computers judge them by §2.3. On the next start, tabs that reopen call `presence_set`, which finds the leftover by content, continues from its `seq` and replaces it. 20 s after the frontend's `take_pending_opens`, a background thread goes through `written`: a file that is not registered now and still reads as an own note with **another** `session_id` is deleted; entries whose file is gone are dropped.
- `closing` is never reset (the process is ending).

### 3.9 Cloud folders — `graphfile_cloud_info { path } → CloudInfo`

`path` may be a file or a folder; relative → `Invalid`. Take the file's folder, make it canonical when it exists (so a symlinked `~/Dropbox` resolves), and compare **whole-component path prefixes** with the roots below (each root made canonical too when it exists); the first match wins. `root` = the matched folder; `service` as given. Platform code is `cfg`-gated and compiles on the three CI targets; each list is a pure function `cloud_roots(os, env: &CloudEnv) -> Vec<(PathBuf, String)>` (home folder, env vars and the text of the `info.json` files are passed in), so all three lists are unit-tested on every platform.

| OS | roots (service) |
|---|---|
| macOS | every direct child folder of `~/Library/CloudStorage` (service from its name: starts with `Dropbox` → Dropbox; `OneDrive` → OneDrive; `GoogleDrive` → Google Drive; `Box` → Box; `iCloud` → iCloud Drive; else the name up to the first `-`) · `~/Library/Mobile Documents` (iCloud Drive) · the `path` values of `personal` / `business` in `~/.dropbox/info.json` (Dropbox) · `~/Dropbox`, `~/Dropbox (…)` (Dropbox) · `~/OneDrive`, `~/OneDrive - …` (OneDrive) · `~/Google Drive`, `/Volumes/GoogleDrive`, `/Volumes/GoogleDrive-…` (Google Drive) · `~/Box`, `~/Box Sync` (Box) |
| Windows | env `OneDrive`, `OneDriveConsumer`, `OneDriveCommercial` (OneDrive) · the `path` values in `%APPDATA%\Dropbox\info.json` and `%LOCALAPPDATA%\Dropbox\info.json`, and `%USERPROFILE%\Dropbox` (Dropbox) · `%USERPROFILE%\Google Drive`, `%USERPROFILE%\My Drive`, and for the path's own drive `X:` the folders `X:\My Drive` and `X:\Shared drives` when `X:\My Drive` exists (Google Drive) · `%USERPROFILE%\iCloudDrive` (iCloud Drive) · `%USERPROFILE%\Box` (Box). The comparison ignores ASCII case. |
| Linux | the `path` values in `~/.dropbox/info.json`, and `~/Dropbox` (Dropbox) · `~/OneDrive` (OneDrive) · `~/GoogleDrive`, `~/google-drive` (Google Drive) · `~/Nextcloud` (Nextcloud) · `~/ownCloud` (ownCloud) · `~/pCloudDrive` (pCloud) |
| debug builds, all | additionally every folder in env `LAS_CLOUD_ROOTS` (same list format as `LAS_NOTE_ROOTS`), service `Test cloud` |

No match → `{cloud: false, service: null, root: null}`. An `info.json` that is missing or does not parse is skipped silently. Nothing is cached beyond the call.

### 3.10 Smaller changes

- **Menu** (`menu.rs`): item id `file.sharing` (`MENU.sharing`), label **Show Others When I'm Editing…**, no shortcut, after "Versions", enabled with `MenuState.hasDoc`; it emits `app://menu {id: "file.sharing", path: null}`; `resolve_click` knows it.
- **`appstate_new_device_id → DeviceIdentity`** (`appstate.rs`): a new `d-<uuid>`, the old id appended to `aliases`, a **new `session_id`** for this launch, `device.json` written atomically; `NoStateDir` without a state folder. Afterwards every `OwnNote` is dropped from the registry without touching its file (the controller writes the notes again; step 6 of §3.2 then removes the old ones, which are "own" through the alias).
- `appstate_set_device`: unchanged. The controller rewrites the notes after the computer or the user was renamed (§5.3).
- `graphfile_scan_dir`, `graphfile_locate`, `opens.rs`, `list_lag_files`: unchanged in behaviour; tests are added that note files and their conflict copies are never taken for analyses (R12).

### 3.11 Self-test hook (debug builds only, `deve2e.rs`, `devenv.rs`)

`dev_e2e_fs` gains: `{op: "writeText", path, to: <text>}` (atomic write of a small text file inside the script's roots — the runner places another computer's note with it), `{op: "readText", path}` → the text or null, `{op: "wake", path: "<gapMs>"}` (emits `graphfile://event {type: "wake", gapMs}` and stops the beating exactly as the poll thread does on a gap); `list` must return `.laguse` names too. Debug env `LAS_NOTE_HEARTBEAT_MS` shortens the 60 s heartbeat for the self-test. None of this exists in release builds.

### 3.12 Tests rust must ship (`cargo test --locked`; today 90 passed / 1 ignored)

- **R1** `sanitize_name_part` and `device_tag`: every row of the §1.2 table (the same vectors as P1).
- **R2** Note bytes: a fixed note → exactly the §1.1 layout; parse → equal; each tolerance of §1.1; over 8192 bytes → not a note.
- **R3** `presence_set`: the file appears with the expected name and content; a second call replaces it with `seq + 1`; an own leftover with a higher `seq` in the folder is continued from; an own conflict copy is deleted; another device's note at the attempt-0 name → attempt 1 is used; refuses a `docPath` that is not `.lag` or not absolute; an interrupted write (temp left) leaves the old note; a symlink at the target → `Invalid`; `closing` → `off`; the debug guard → `off` outside `LAS_NOTE_ROOTS`.
- **R4** `presence_clear` deletes own notes for that document and nothing else (a foreign note and an own note of another document stay).
- **R5** Heartbeat with an injected clock: a rewrite every 60 s while editing with input in the last 10 min; none after 10 min without input; again after input; none after a gap until the next set; idle keep-alive at 6 h.
- **R6** `scan_notes`: applies by name, by the sole-id rule, not for the other of two same-id files; orphan; own / alias; bounded at 200 with `truncated`; an oversized file skipped; unchanged files are not read again (count the reads); `unchangedSince` survives a restart through `graph-notes.json` and starts again when the bytes change.
- **R7** Poll: a foreign note appearing, changing seq and disappearing each emit one `presence` event with the full list; my own heartbeat emits none; notes of an unrelated document emit none.
- **R8** `presence_remove_foreign`: removes only when the bytes are unchanged; `changed`, `gone`, `own`, `notANote`; refuses names that are not `.laguse`.
- **R9** Quit: `delete_all_own` removes every registered note within the limit, leaves foreign notes, is idempotent; the startup sweep deletes a leftover own note of another session and keeps a registered one.
- **R10** `cloud_roots` for each OS from an injected environment; whole-component prefixes (`~/Dropbox2` is not under `~/Dropbox`); a symlinked `~/Dropbox`; `LAS_CLOUD_ROOTS` in debug only.
- **R11** Menu `resolve_click("file.sharing")`; `appstate_new_device_id` keeps the alias and changes the session id.
- **R12** `list_lag_files`, `graphfile_scan_dir` (`kind: "presence"`, no header), `graphfile_locate` and `opens::paths_from_args` with `X (in use on Mac, 1a2b).laguse` and `X (in use on Mac, 1a2b) (conflicted copy).laguse` present: never an analysis, never a sibling, never opened.
- **R13** `cargo build --locked` with an unchanged `Cargo.lock`; `cargo check --locked --release`.

> **CHANGED BY rust:** small, deliberate refinements (no shape in contract.ts changes):
> 1. §1.2 / §3.2 step 5: a name is "taken" not only by another device's note but also by a file there that is not a note, and by **my own note about another document** (two document names that sanitise alike, e.g. `A b.lag` and `A_b.lag`, would otherwise share one note file and overwrite each other). The fallback "attempt 2 anyway" applies only when attempt 2 is another device's note; otherwise the call fails with `Io` (a non-note file is never overwritten).
> 2. §1.1 reading in Rust: a missing `head` / `base_revision` key counts as `null`; a `features` that is not a number counts as `2`; a fractional `epoch` / `seq` is truncated. (Rust is what parses notes on the desktop; `presence.ts` may be stricter — it only matters for hand-made files.)
> 3. §3.2 also refuses (`Invalid`) a `docPath` with `.` / `..` components, a non-integer `epoch`, more than 32 `supersedes` entries, and a note text over 4096 bytes. Without a state folder `presence_set` rejects `NoStateDir` (there is no device identity); `presence_list` still works and treats nothing as own.
> 4. §3.5: a failed heartbeat rewrite is tried again 10 s later (not on every 1 s tick).
> 5. §3.9: `graphfile_cloud_info` lives in a new file `src-tauri/src/cloud.rs` (not `presence.rs`).
> 6. §3.6 poll: the phase 1 poll tests (`graphwatch_tests.rs`) now leave `presence` events out of their exact event lists — after every re-key the new path gets a `presence` event, as this section requires; R7 checks them.

> **CHANGED BY integrator:** (1) §1.2 `<stem>`: a document whose whole file name is `.lag` (any case) has an empty stem, so its note is named `Analysis (in use on …).laguse` in Rust too (`presence.rs doc_stem` kept `.lag` as the stem; `presence.ts` already followed this section). Found by the cross-language run (1515 generated names × 3 attempts, 1500 sanitiser cases, 305 note texts byte-compared). (2) Known, accepted difference in reading hand-made notes (rust's note 2 above): an `epoch` / `seq` that is fractional or larger than 2^64 is truncated / saturated by Rust and kept as it is by `presence.ts`; Rust is what reads notes on the desktop, and the app never writes such values.

> **CHANGED BY fixer:** (verifier findings VP-1, VP-5, VS-2 … VS-5, VS-9, F9; no shape in contract.ts changed)
> 1. §3.1 **"Own" = this computer's current device id only** (VP-1). An alias in `device.json` is no longer own: after Migration Assistant, a restore from another Mac's backup or a duplicate identity, the other computer still uses that id, and counting its notes as mine hid its editing and deleted its live note. §3.10 `appstate_new_device_id`: instead of relying on the alias, the note files written under the old id **in this launch** (old device id + old session id) are deleted at once; the other computer's notes with that id have another session id and are never touched. Notes written under an old id in an earlier launch are left to the 24 h cleanup like any foreign note. At most 16 aliases are kept. (`device_with_aliases` is test-only now.)
> 2. §3.2 step 6 (VS-2): when a stale own note that applies to this document is registered for **another** document path (the document was renamed in the same folder and followed), that registration is removed and the file deleted — before, it was skipped and its heartbeat kept writing the old note. Step 7 (VS-3): under the presence lock, a `closing` that was set while the note was being written makes the call delete the file it just wrote (only if it still reads as this launch's note) and reply `off / closing`; the heartbeat's rewrite does the same. So a quit racing with a write never leaves a note.
> 3. §3.2 step 4 (F9): `seq` also continues from the highest seq written for that document path in this launch (`seq_floor`), so a note cleared and written again (Never → Always) never goes back to a lower seq.
> 4. §3.5 (VP-5): a sleep gap also forgets `last_input` (the monotonic clock does not run during sleep, so input from before the sleep looked recent and an unattended wake kept the note rewritten for up to 10 min); the rewrites start again with the next real input. The poll thread measures the gap without the time its own look took (a look blocked on a stalled folder for over 90 s is not a sleep).
> 5. §3.6 (VS-4, VS-9): an online-only (dataless) `.laguse` is not read (reading it would make the cloud client download it, which can hang offline); it counts once it has arrived. `read_note_fresh` skips it too. With more than 200 notes in a folder, the notes whose name starts with the document's sanitised stem are kept first before the bound.
> 6. §3.8 quit (VS-5): `delete_all_own` deletes only notes of **this launch's session** (a second copy of the app on the same state folder keeps its notes); leftovers of earlier launches go with the next start's sweep, as after a crash. Still open: the 20 s startup sweep of one copy can delete the other running copy's idle note (it comes back at that copy's next write; an editing note within 60 s). A single-instance guard (forwarding the path to the running app, needed on Windows / Linux anyway) would remove this; it needs a crate and is not in this phase.

---

> **CHANGED BY fixer (round 2):** (re-verifier finding RV-1; no shape in contract.ts changed)
> 1. §3.6 / fixer note 5 above (VS-4) **narrowed: online-only notes are read again, never on the caller's thread.** Skipping a dataless `.laguse` meant that while Dropbox / OneDrive / Google Drive kept the folder online-only, another computer's editing note was never read and this computer never became read-only. Now `list_folder` lists every note (dataless ones flagged) and `read_notes` reads them on **reader threads**: one per (folder, kind) — kind = local or online-only, so a stuck download never holds up a local note — at most `READERS_MAX` (16) at once; a file is read when its (size, mtime, identity) changed; the read of an online-only file is what makes the cloud client download it. A call waits only for the reads it queued itself, at most **200 ms in the poll** (`READ_WAIT_POLL`; the 3 s cadence holds), **1 s in `presence_list`** (`READ_WAIT_LIST`; within the frontend's 1.5 s open budget), **300 ms in `presence_set` / `presence_clear`** (`READ_WAIT_SET`); a file whose read is still under way or failed keeps its **last content read** (it neither disappears nor changes for the frontend), and a finished read is taken in by the next look, whose signature change emits the usual `presence` event. A failed read of the same version is tried again after 10 s; a download that never ends costs one wait, once, and holds one reader thread (bounded). `choose_target` judges an online-only file at a name by its last content read; `read_note_fresh` (deleting own notes, `presence_remove_foreign`, the startup sweep) still never reads an online-only file (VS-4 kept: offline never hangs watching, opening or a command). Tests: `fix_rv1_online_only_note_is_read_and_the_poll_keeps_its_pace` (a blocking read hook on a note marked online-only: every look < 0.8 s while it hangs, the download asked for once, a local note beside it read at once, the note in the next look once it arrived, the last content kept while a newer version downloads) and `fix_rv1_stuck_download_never_holds_up_commands`. Test seams `NoteCache.read_hook` / `fake_dataless` (always compiled, unset in the app).

## 4. Read-only enforcement in the editor (owner: readonly)

Files: `src/store/graphStore.ts`, `src/components/graph/GraphView.tsx`, `DataGrid.tsx`, `GraphAnalysisControls.tsx`, `GraphFigureControls.tsx`, `PalettePicker.tsx`, `FigureTextPanel.tsx`, `GraphResults.tsx`, `scratchpad/*`, and tests under `src/components/graph/__tests__/` and beside the store. The only channel to the controller is the store (below); readonly adds no call into `useFileSession`.

### 4.1 The store guard (`graphStore.ts`)

`GraphState` gains the members of `StoreGuardApi` (contract.ts §7.5): `guard`, `userEditSerial`, `blocked`, `setGuard`, `noteBlockedEdit`. Initially `guard: null`, `userEditSerial: 0`, `blocked: null`.

**User actions.** Each one, when `guard !== null`, changes nothing, sets `blocked = {serial: (blocked?.serial ?? 0) + 1, path, action: "<its name>"}` and returns its "nothing happened" value (`undefined`; `null` for `paste` / `sendBlock`; `false` for `undo`). When it is applied and really changed the content or the name, it bumps `userEditSerial` by one.

| action | `path` |
|---|---|
| `setCell`, `setX`, `setRowTitle`, `setColTitle`, `setXTitle`, `setNRep`, `insertCol`, `deleteCol`, `clearCol`, `insertRow`, `deleteRow`, `clearRow`, `paste`, `sendBlock` | `table` |
| `setAnalysis` | `analysis` |
| `setFigure` | `figure` |
| `setScratch` (only when the text differs) | `scratchpad` |
| `setName` | `name` |
| `undo` | `undo` |

Implement it in one place (the internal helpers `edit` and `type`, and one wrapper for the remaining actions), not by sprinkling checks.

**Never guarded, never bump `userEditSerial`:** `newDoc`, `load`, `loadFile`, `replaceWorking`, `replaceContent`, `markSaved`, `markFileSaved`, `markRenamed`, `detach`, `setFileRef`, `close`, `setGuard`, `noteBlockedEdit`. `newDoc`, `load`, `loadFile` and `close` reset `guard` and `blocked` to `null` in the same update (the controller sets the guard of the newly loaded tab right after, in the same tick). `replaceContent` keeps the guard and still applies under it (live refresh while read-only).

**`normalize`** (the automatic settings clean-up) is neither: under a guard it does nothing and reports nothing; without one it applies as today and does **not** bump `userEditSerial`.

`setGuard(g)`: sets `guard`, nothing else (the same reason again → no update). `noteBlockedEdit(path, action)`: sets `blocked` with the next serial — for edit paths that never reach a store action (the Scratchpad sheet, a dimmed control that was clicked, the controller's own refusals).

With `guard === null`, `editSerial`, `isDirty`, the undo stack and every existing behaviour are unchanged. A blocked action never touches `editSerial`, `undoStack` or `lastEditKey`.

**The claim hook.** The controller subscribes to the store and treats `s.userEditSerial !== prev.userEditSerial` as "the person changed something" (§5.3). By construction it cannot fire for a load, a live refresh, the automatic clean-up, `replaceWorking`, `replaceContent`, `markFileSaved` or `setFileRef`. readonly ships the test for exactly that list (G2).

### 4.2 What the editor does while `guard !== null`

`GraphEditor` reads `const guard = useGraphStore((s) => s.guard)` and hands `readOnly = !!guard` down. The editor's root element gets `data-testid="graph-editor"`, `data-readonly="true|false"` and `data-guard="<reason or empty>"`.

**Blocked — every edit path:**

| where | while read-only |
|---|---|
| Data grid: cells, X values, row / column titles, X title (`DataGrid.tsx`) | the `<input>`s get the `readOnly` attribute (not `disabled`: focus, arrow / Enter / Tab movement, selection and ⌘C keep working) and `aria-readonly`; a `beforeinput`, `paste`, `cut` or `drop` on them is prevented and reported with `noteBlockedEdit("table", "type" \| "paste" \| "cut" \| "drop")` |
| multi-cell paste | prevented, reported (`paste`) |
| ⌘Z / Ctrl+Z in the grid | prevented, reported (`undo`). The grid has no redo. |
| column / row menus: Insert left / right / above / below, Clear, Delete | the menu opens, its items are disabled |
| table section of the rail (`GraphView.tsx`): replicates, add / remove column, add row, their confirm bars | disabled |
| analysis section (`GraphAnalysisControls.tsx`); graph section (`GraphFigureControls.tsx`: labels, graph type, font, centre / error bars, theme, switches, sliders, Y min / max, series colours and labels, legend, width / height / DPI / export format / transparent); `PalettePicker.tsx`; the fields of `FigureTextPanel.tsx` that write to the graph settings | not usable. Technique: each section **body** is wrapped in one `RailGuard` (a small new component): `inert` + `aria-disabled="true"` + dimmed to 60 % opacity, under a transparent catcher whose `pointerdown` calls `noteBlockedEdit(<that section's path>, "control")`. Section **headers** (collapse / expand) stay outside it and keep working. |
| Scratchpad (`sheetSession.ts`, `SheetGrid.tsx`, `ScratchpadTab.tsx`) | `SheetSession` gains `readOnly: boolean` (set by `ScratchpadTab` from the guard). When set, `mutate()` — the one entry of every change — returns `{ok: false, reason: "readonly", message: "This analysis is read-only right now."}` (`EditResult.reason` gains `"readonly"`), and `undoStep()` / `redoStep()` return `false`; the model does not change. `SheetGrid`: no cell editor opens (typing, F2, double-click, Enter); Delete / Backspace, paste, cut (the copy half still copies), the fill handle, ⌘Enter fill, ⌘Z / ⇧⌘Z, the format menu and column resizing change nothing — each reported once per gesture with `noteBlockedEdit("scratchpad", "<what>")`. Selecting, scrolling, keyboard movement, **Copy values** and ⌘C work. The toolbar's undo / redo / format controls and the rail buttons **Send selection to Data…** and **Clear scratchpad…** are disabled; `ScratchController.clearAll` and `openSend` do nothing (reported). `flush()` still works. A result with `reason: "readonly"` is **not** shown as a sheet error (the banner speaks). |
| `SendToDataDialog` | cannot open; if it is open when the guard arrives, its Send button is disabled |
| the "Undo: combine with …" button in the canvas tab strip | disabled |

**Stays enabled** (read-only blocks only changes to saved content): the canvas tabs (Data / Graph / Results / Scratchpad), the rail's collapse / expand, scrolling and selecting everywhere, copying from the grid, the Scratchpad and the result tables, **Render graph** and ⌘Enter, the **Live update** switch, figure and table **downloads / exports** (they use the stored settings), the methods text's **Copy**, opening and closing the text panel, the Versions panel with preview and **Compare with current**, and — outside this implementer's files — New, Open, Save As (as a new analysis), Duplicate, Close Tab, Show in Finder, the tab strip.

The **live analysis and live figure** keep running: content replaced by `replaceContent` re-runs them as today.

**When the guard arrives while something is open.** The controller sets a guard only on a clean, idle tab, after committing an open Scratchpad edit (§5.4), so no typed text can be lost. readonly still makes these safe: an open column / row confirm bar or replicate confirm closes; a focused grid input keeps focus (now `readOnly`).

**How an edit attempt surfaces.** Every refused change ends in `blocked.serial` growing — through a guarded store action or `noteBlockedEdit`. The controller watches it (§5.5) and the UI pulses the banner's button (§6.3). readonly shows no message of its own.

### 4.3 Tests readonly must ship (vitest)

- **G1** Every user action of the §4.1 table is a no-op under each guard reason and sets `blocked` with the right path; `editSerial`, `userEditSerial`, the undo stack, the content and `isDirty` are untouched.
- **G2** `userEditSerial` grows by exactly one for each applied user action and **never** for `newDoc`, `load`, `loadFile`, `replaceWorking`, `replaceContent` (with and without `working` / `undo`), `markFileSaved`, `setFileRef`, `normalize`, `setGuard`, `noteBlockedEdit`, or a blocked action.
- **G3** `loadFile` / `load` / `newDoc` / `close` reset the guard; `replaceContent` keeps it and still applies under it.
- **G4** `SheetSession.readOnly`: `setInput`, `enterInRange`, `clear`, `clearAll`, `setNumFmt`, `setColWidth`, `insertRows` / `deleteRows` / `insertCols` / `deleteCols`, `paste`, `fill`, `autoFill` and the cut half of `copy(g, true)` leave `serialize()` byte-identical and return `reason: "readonly"` (cut still returns the copied text); `undoStep` / `redoStep` are false; `copy`, `tsvDisplayed`, `display` work.
- **G5** Without a guard every existing test (`graph-fe-tests`, the scratchpad tests, the store tests) passes unchanged.

Browser checks: §8, G6–G9.

---

## 5. The session controller (owner: session)

`useFileSession` becomes `create<FileSessionStateP3>`; the backend type becomes `FileBackendP3`. Files: `file/session.ts`, `backend.ts`, `memoryBackend.ts`, `previewBackend.ts`, `tauriBackend.ts`, `devSim.ts`, `e2e.ts`, `testkit.ts`, the retention wiring (the call, not the module), **one line in `format.ts`** (`FEATURES = 2`, with the tests that assert `features === 1` updated), and tests. While `presence.ts` and the store guard do not exist, session builds against scratch-only stand-ins that satisfy `PresenceApi` / `StoreGuardApi` and follow §2 / §4.1, and does not copy them to the repo. ui and readonly likewise build against a scratch stub of the session typed `FileSessionStateP3`.

### 5.1 Other files session changes

- `backend.ts`: `FileEvent = FileEventP3`; re-export `FileBackendP3`; `FileMemo` gains `share?: ShareMode` (this file's own choice); `GraphSession` gains `share_default?: ShareMode`. Presence itself is never stored: it is rebuilt at start.
- `tauriBackend.ts`: thin mappings — `presenceSet` → `presence_set` (reply → `ok: true`; reject → `FileError`), chained per `docPath` so calls stay in order; `presenceClear` → `presence_clear` (same chain; errors swallowed); `presenceInput` → `presence_input` (fire and forget); `presenceList` → `presence_list`; `presenceRemoveForeign` → `presence_remove_foreign` (`removed` → true, anything else false); `cloudInfo` → `graphfile_cloud_info` (reject → `{cloud: false, service: null, root: null}`); `newDeviceId` → `appstate_new_device_id`. The `presence` and `wake` events pass through `subscribe`. Tested with the fake `invoke`.
- `memoryBackend.ts`: `MemoryDevice implements FileBackendP3`, and the world learns **note files**: small text files beside the `.lag` files that sync between devices as files do (the same delay and offline queue; when two devices wrote the same name the service keeps a conflict copy), listed by `scanDir` with `kind: "presence"`. `presenceSet` follows §3.2 (name, `seq`, own copies removed) using `presence.ts` (`noteText`, `noteFileName`, `parseNote`, `noteApplies`); `presenceList` follows §3.6 (`unchangedSince` on the device's clock, kept in `exportState`); the poll emits `presence` under the §3.6 signature rule; the heartbeat runs on the `ManualClock` (60 s with input within 10 min; idle keep-alive 6 h); `cloudInfo` answers from the world's synced folders; `newDeviceId`. Helpers for tests and the simulator: `sleep(ms)` (the device's timers do not run, then a `wake` event with the gap), `crash()` (notes left, nothing runs), `quit()` (own notes deleted), `setSyncDelay(ms)` with separate delays for notes and for analysis files, `setClockSkew(ms)` (shifts only the `updated_at` it writes), `placeNote(path, text)`, `noteFiles(dir)`.
- `devSim.ts`: `DevSimApiP3` (§6.6). `previewBackend.ts`: a third device ("Lab MacBook", Bob) and whatever the above needs.
- `e2e.ts`: phase `"presence"` (§8 E-tests).

### 5.2 State

Public: `FileTab.presence` (`TabPresence`); banner kinds `resuming`, `continuedElsewhere`, `bothEditing`, `waitingNewer`, `editingElsewhere`, `editingInfo`, `unconfirmed`, `olderPeer` with `TabBanner.peers` / `checking`; banner actions `editHere`, `editAnyway`, `keepEditing`, `saveCopy`; dialogs `editAnyway`, `resumeConfirm`, `sharing`; toast `deviceIdChanged`; `FileSettings.shareDefault`; `SaveOutcome` reason `readOnly`; the actions of `FileSessionStateP3`.

Internal per tab: `records: NoteRecord[]` (the last listing), `obs: PresenceObs`, `decision`, `cloud: CloudInfo | null`, `share: ShareMode | null`, `holding`, `epoch`, `overrides: NoteTarget[]`, `lastInputAt`, the linger timer, `resume: {since} | null`, `written` (what my note on disk says: state, head, base, epoch, supersedes; `null` = no note), `dismissed` (peer claims whose banner was closed), the guard retry timer, `attempt`, `hadForeignNote`. Global: the presence timer (every `LIMITS_P3.tickMs` on `deps.timers`), `lastTickAt`, `shareDefault`.

New dependencies (`SessionDeps`, with defaults): `lastActivity(): number` (default: the time of the last `keydown` / `pointerdown` in the window, from the listeners `hookPointer` already installs; tests: a settable value) and `nativeWake: boolean` (default = `desktop`: sleep gaps come from the backend's `wake` event and the controller's own detector is off; preview and tests: `gapDetected` on the presence timer).

### 5.3 My note: when it is written

`notesOn(tab)` = `shareDecision({choice: share, fallback: shareDefault, untitled: !path, cloud: cloud.cloud, multiDevice: multiDevice(manifest, me, foreign notes)}).on`. The note states facts: **`editing` exactly while `holding`**, else `idle`. `sync(key)` compares the wanted note with `written` and calls `backend.presenceSet` only when something differs (state, head, base, epoch, supersedes) — never on a timer; the 60 s rewrites are the backend's. From the caller's point of view every call is fire-and-forget (no user action awaits one); a failed write is tried again at the next `sync` and never shown.

| moment | what happens |
|---|---|
| **Open** (a tab's file was read: open, restore, Find it…, `back`) | `cloudInfo(path)`; `presenceList` → `records`; `epoch` = the highest epoch among own notes found (a leftover after a crash), else 0; `observe`; `decide`; `sync`. A clean tab → `idle`. A tab that opens **with unsaved changes** (restored from the last session) → `holding = true`, `epoch + 1`, `editing` (it does have unsaved changes; without input the note goes quiet for others after 5 min). `notesOn` false → no note, and an own leftover is cleared (`presenceClear`). |
| **Version change** (my save, a combine, Bring back, a live refresh, a reload) | `sync` — one small write with the new `head` (and `base_revision` = the new version while holding). |
| **Claim** | the store subscription sees `userEditSerial` change on the loaded tab while `!holding` → `holding = true`, `epoch += 1`, base = the tab's base, `supersedes` = `overrides` plus every quiet editing peer based on my version; `sync` with `input: true`. The keystroke is already applied; nothing is awaited. Never fired by a load, a live refresh, the clean-up, `replaceContent` or `markFileSaved` (§4.1). |
| **Input** | every `userEditSerial` change, and every presence tick on which `deps.lastActivity()` is newer than the last ping while the active tab is holding: `lastInputAt = now`, the linger timer restarts, and `backend.presenceInput(path)` at most every `inputPingMs`. |
| **Release (D6)** | `holding` ends and `sync` writes `idle`: (a) the tab is clean and `lingerMs` (30 s) passed since the later of the last save and the last input; (b) **at once**, when the tab is clean: window `blur`, switching to another tab or to the start screen; (c) **at once**: every path that throws the unsaved changes away or replaces the content (`reloadFromDisk`, `discardDraft`, "Use theirs", Bring back, a live refresh), and a yield on a clean tab (§5.6). A tab with unsaved changes never releases: its note keeps saying `editing`, and without input it goes quiet by itself. |
| **Save while holding** | after `saved`: the note at once with the new version as head and base; still `editing`; the linger restarts. A person who saves every minute and keeps typing never makes the other computers flicker. |
| **Close tab** | `presenceClear(path)` once the close is certain. |
| **Quit** | nothing in the controller: Rust deletes every own note in its quit path (§3.8). The preview's simulated quit (`quitRoutine` resolving true without the desktop) calls `presenceClear` for every tab. |
| **File gone / back / moved** | `missing`, `replaced` → `presenceClear(path)`; `back` → as Open; `moved {from, to}` and Save As to a new path → `sync` for the new path, then `presenceClear(old)`. |
| **Setting or names changed** | `setSharing`, `setSharingDefault`, `setSettings` (the names) → every tab is evaluated again: `sync` or `presenceClear`. |

A `presenceSet` reply `off` → `mine: "none"`, and no retry until the next change. `TabPresence.mine` mirrors `written`.

### 5.4 Evaluating a tab

`evaluate(key)` runs on: open; a `presence` event (new `records` → `observe`); a file event that changes the tab's base, the head on disk or the manifest; the store's dirty flag changing; `holding` changing; window focus; the presence tick once `now ≥ decision.nextCheckAt`; a gap; a setting change. It is synchronous:

1. `foreign` = the notes of `pickPerDevice(records.filter((r) => r.applies && !r.own))`.
2. `d = decide({me, now, diskHead, knows, dirty, holding, myEpoch: epoch, resuming: !!resume, overrides, notes: foreign, obs})` with `diskHead` = the tab's base when it is clean, else the last head read from disk for the path; `knows(id)` = the id is in the tab's manifest.
3. **Guard** wanted: the file's `readOnly: "tooNew"` → `tooNew`; `d.mode === "readOnly"` → `d.checking ? "checking" : "editingElsewhere"`; `"waiting"` → `waiting`; `"resuming"` → `resuming`; else none.
   - Clearing a guard is immediate (`graph.setGuard(null)` in this tick).
   - **Setting** `editingElsewhere` / `checking` / `waiting` on the loaded tab: first `deps.flushScratch({commitEdit: true})`; if the store is dirty now or `userEditSerial` moved, that was a claim → evaluate again (the answer is `bothEditing`, not read-only). If `deps.interactionBusy()` → not yet: try again in `applyHoldRetryMs` (500 ms). Otherwise `graph.setGuard({reason})`. So a tab never becomes read-only in the middle of a typed value, and a tab with unsaved changes never at all.
   - `tooNew` and `resuming` are set at once.
   - A background tab has no store: only `tab.presence` is updated; its guard is set when the tab is loaded (`switchTab` → load → `evaluate` in the same tick, before the editor paints).
4. `tab.presence = {mode: d.mode, readOnly, guard, peers: d.peers, mine, sharing, status, attempt}` with `readOnly` = the guard is `editingElsewhere`, `checking` or `waiting` (not `resuming`, which only asks before the first new edit; `tooNew` stays `tab.readOnly`); banners brought in line (§5.5); `sync(key)`; menu state (`canSave = hasDoc && !saving && !tab.readOnly && !presence.readOnly`).
5. `d.mode === "waiting"` → `backend.pollNow()` now and on every tick while it lasts.

The presence tick also: detects a gap (unless `nativeWake`); after each new listing runs `cleanupTargets(records, now)` (at most 5 `presenceRemoveForeign` calls per listing); and checks `duplicateIdentity(previous records, records, me)` → `backend.newDeviceId()`, the controller's `device` replaced, toast `deviceIdChanged`, every tab synced again.

### 5.5 Banners, Edit here, both editing

One presence banner per kind, id = the kind, rebuilt from `d` at every evaluation (left untouched when nothing changed, so the UI does not flicker):

| mode / condition | banner | actions | dismissible |
|---|---|---|---|
| `readOnly`, `d.checking` | `editingElsewhere {peers, checking: true}` | — | no |
| `readOnly`, every `about` peer `sameUser` | `editingElsewhere {peers}` | `editHere` | no |
| `readOnly`, otherwise | `editingElsewhere {peers}` | `editAnyway` | no |
| `waiting` | `waitingNewer {peers: [that device]}` | — | no |
| `d.unconfirmed`, not waiting | `unconfirmed` | — | yes (stays closed until the tab's base changes) |
| `info`, with a quiet peer based on my version | `editingInfo {peers}` | `editHere`, `dismiss` | yes |
| `info`, otherwise (older version, overridden) | `editingInfo {peers}` | `dismiss` | yes |
| `bothEditing`, `d.yieldedTo` set | `continuedElsewhere {peers: [it]}` | `keepEditing`, `saveCopy` | no |
| `bothEditing`, otherwise | `bothEditing {peers}` | `keepEditing`, `saveCopy` | no |
| `resuming` | `resuming {peers}` | `keepEditing` | no |
| `olderPeer(manifest, me, foreign)` not null | `olderPeer {peers: [a PeerView made from that version's names]}` | `dismiss` | yes (stays closed for that head) |

`peers` in a banner = the `about` peers. `dismiss` / `keepEditing` on `editingInfo`, `bothEditing`, `continuedElsewhere` record the peers' `{device_id, epoch}` in `dismissed`: the banner stays away until another peer or a new epoch appears.

**`editHere(key, confirmed)`** — also the banner actions `editHere` (= `editHere(key, true)` when every peer is `sameUser`, else as `editAnyway`) and `editAnyway` (= `editHere(key, false)`):

1. Mode `readOnly`, not `checking`: when some `about` peer is not `sameUser` and `confirmed` is not true → dialog `editAnyway {peers}`; `cancel` → false. Then, **in one synchronous step**: `overrides` += `d.blockers`; `holding = true`; `epoch += 1`; `graph.setGuard(null)`; evaluate (the mode is now `bothEditing`; its banner is already marked dismissed for these peers, so the person just edits); `sync` with `supersedes = d.blockers`, `input: true`. Resolves true. Nothing waits for the other computer or for the disk (D10).
2. Mode `info` with a quiet peer on my version: the same without a dialog (no guard to clear).
3. Any other mode → false.

Without typing, the hold ends by the linger rule (30 s, blur, tab switch) and the note returns to `idle`; `overrides` stay for the life of the tab, so the tab stays editable against those claims. A **new** epoch of the other computer is a new claim and makes a clean tab read-only again.

**An edit attempt.** The controller subscribes to `blocked.serial` of the store: for the loaded tab `attempt += 1` (the UI pulses the banner's button). With guard `resuming` it opens the dialog `resumeConfirm {what: "edit"}` instead (§5.6). The controller's own refusals call `graph.getState().noteBlockedEdit("command", "<action>")`, so they take the same path; `reportEditAttempt(path, action, key)` is the UI's entry to it.

**While a guard other than `resuming` is set, the controller writes nothing into the document's file:** `save`, `saveAs("same")`, `bringBack`, `undoCombine`, `startCombine`, `applyCombine`, `useEarlierVersion`, `goBackToMyLatest`, the banner action `updateMine`, and the automatic combine all refuse — the attempt is reported and they resolve `{ok: false, reason: "readOnly"}` (the `void` ones do nothing). An automatic combine that is waiting stays pending (`savedOver {state: "combining"}`, its timer stopped) and is looked at again when the guard clears. Still allowed: `saveAs("new")`, `duplicate`, `saveVersionAsNew`, `saveAsSeparateCopy`, `removeExtraCopy`, `markDifferentAnalysis`, `keep` (they write other files or only this computer's records), viewing and comparing versions, closing, revealing.

`saveAsSeparateCopy(key)` = the phase 1 `separateCopy` path: pick a place, my version becomes a new analysis there, the tab moves to it (its note at the old path is cleared), this file is left as it is on disk.

### 5.6 Sleep and wake (plan §6.7)

A gap = a `wake` event from the backend, or (preview, tests) `gapDetected(lastTickAt, now, tickMs)`. On a gap, for every tab: `obs = markGap(obs, now)`; `backend.pollNow()`; `presenceList` → `observe` → `evaluate`. Until that answer arrives the notes are `checking`: a clean tab that would be read-only shows "Checking who is editing…", for at most 15 s.

For a tab that was **holding**:

- **Clean** (inside the 30 s after a save, or after Edit here without edits) → release at once (`idle`); no window.
- **With unsaved changes** → `resume = {since: now}`: mode `resuming`, its banner, guard `resuming` on the loaded tab. The backend has stopped beating by itself. The window ends with whichever comes first:
  1. **A note that overrides my claim** (`d.yieldedTo`) → `resume = null`, the guard cleared; the tab keeps its unsaved changes and stays editable; banner `continuedElsewhere`; my note stays `editing` with its old epoch (this computer does have unsaved changes) and `sync` registers it again so it beats with input.
  2. **A newer version of the file arrives** (phase 2 table A with another head than the tab's base) → `resume = null`, the guard cleared, re-claim; the phase 2 routing shows `newerOnDisk` and combines as usual.
  3. **The person says so**: `keepEditing`, or `go` in `resumeConfirm` → `resume = null`, the guard cleared, re-claim.
  4. **`LIMITS_P3.resumeMs` (45 s) passed** with none of the above → `resume = null`, the guard cleared, re-claim.
  - **Re-claim** = `epoch += 1` and `sync` (`editing`, base = the tab's base, no `supersedes`).
- During the window: **Save** → dialog `resumeConfirm {what: "save"}`; `go` → case 3, then the save runs (the save check and combining protect the file as always); `wait` → `{ok: false, reason: "cancelled"}`. **The first new edit** is refused once by the guard and opens `resumeConfirm {what: "edit"}`; `go` → case 3 and the person types again; `wait` → the window goes on. Unsaved changes are never touched, and the unsaved-work backup keeps being written.

A yield outside a window works the same way: whenever `d.yieldedTo` appears, a tab with unsaved changes gets the banner `continuedElsewhere` and nothing else; a clean holding tab releases at once (the other computer's claim then makes it read-only by rule B2).

### 5.7 Waiting, live refresh, status line

- **Waiting** (guard `waiting`, banner `waitingNewer`): ends when the announced version is in the tab's history — the phase 1 / 2 reload-when-clean brings it in (`changed` → `replaceContent`) — or at `d.waiting.until`; then the banner `unconfirmed`.
- **Live refresh while read-only**: the phase 2 machinery unchanged — table A "newer + clean tab" → `replaceContent` (which ignores the guard), held back only by `holdReplace` / `interactionBusy`. Each save by the editor therefore appears by itself, and the tab stays read-only until the editor's note says `idle` or goes quiet, because after the refresh the editor's `base_revision` equals this tab's version again.
- **Status line instead of toasts**: the toast `reloaded` is not shown for a live refresh on a tab that has, or had since it was opened, a foreign note (`hadForeignNote`). `tab.presence.status = {kind: "upToDate", who: versionInfo(head), seenAt: seen.analyses[aid][head] ?? null}` whenever the tab is clean and its newest version was saved on another computer (`!who.mine`), else `null`. Tabs that never saw a foreign note keep the toast.

### 5.8 Combining, retention, compatibility

- A read-only tab never writes a combine (§5.5). A tab with unsaved changes is never read-only, so "Combine my changes with it", combining on Save and the dialog work exactly as in phase 2 while `bothEditing`.
- After Edit here over someone's unsaved changes both computers have unsaved changes on the same version: whoever saves second gets the phase 2 combine. Nothing new is needed.
- **Retention**: `retain()` passes `beaconHeads: liveNoteHeads(the notes of the last listing that apply to that analysis, own and foreign)`; the simulator's other computers pass the notes they can see.
- **`manifest.features`** is `2` in every manifest this build writes (`format.ts FEATURES`). Phase 1 / 2 apps ignore the field when reading and write `1` when they save — which is what `olderPeer` looks at.
- A phase 1 / 2 app beside a phase 3 app writes no note and ignores notes; it never becomes read-only; its saves reach the phase 3 app as newer versions or combines exactly as before. The phase 3 app shows `olderPeer` once per head.

### 5.9 "Show others when I'm editing" (plan §6.8, D3)

- Per file: `GraphSession.files[path].share` (absent = it follows the default). Default: `GraphSession.share_default` (absent = `"auto"`), mirrored in `settings.shareDefault`.
- `openSharing(key)` → dialog `sharing {tabKey, title, sharing: SharingView}`; `menu(MENU.sharing)` does it for the active tab. `setSharing(key, choice)` stores the choice, evaluates the tab and writes or clears the note at once; an open dialog gets the new `sharing`. `setSharingDefault(mode)` stores it and evaluates every tab.
- `SharingView.service` = `cloud.service ?? serviceOf(path)`.
- Automatically = on in a cloud folder (`cloudInfo`), or when the file's history or a foreign note shows another computer (`multiDevice`). A purely local file of one computer gets **no note file** in Automatically mode.
- Reading notes does not depend on the setting: a tab always observes the notes beside its file.

### 5.10 What changes in phase 1 / 2 behaviour

1. `manifest.features` is written as `2`.
2. The toast `reloaded` is suppressed where a foreign note exists (§5.7); the status line is new.
3. A too-new file is really read-only now (guard `tooNew`), not only "Save disabled".
4. `save`, `bringBack`, the combine actions and the other writers of §5.5 can resolve `reason: "readOnly"`.
5. `MenuState.canSave` is false while the tab is read-only (`presence.readOnly`), as it already was for a too-new file.
6. Automatic combines wait while the tab is read-only.
7. `retain()` gets the notes' versions.
8. No listing shown to the person contains `.laguse` files (preview picker, simulator file list).
9. The preview's simulated quit clears the simulated notes; on the desktop Rust does it.
10. New session records `FileMemo.share` and `GraphSession.share_default` (older builds keep them: the session is stored as given).

Everything else — tabs, the unsaved-work backups, Recent, cards, Find it…, Save As, the copy question, rename follow, the journal check, routing tables A–E, the combine dialog, Versions — is unchanged. Existing tests that assert a changed behaviour (the `reloaded` toast with a foreign note present, `features === 1`) are rewritten to the new behaviour.

> **CHANGED BY session:** how `session.ts` and the memory backend settle points this section left open (no shape in contract.ts changed):
> 1. `knows(id)` (decide's input) is true also for a version this computer has already seen for that analysis (`graph-seen.json`): after a file was put back to an earlier version, another computer's note that still names the newer version is not "a version on its way" (no 2 min wait for a version this computer had).
> 2. After a path change the old note is cleared with `presenceClear(old)` only when the folder or the analysis id changed. For a rename in the same folder `presence_set` for the new name already removed the old note (§3.2 step 6), and `presence_clear(old)` would also delete the NEW note (it applies to the old path by the sole-id rule). **rust:** `presence_clear` should skip a file that is registered for another document path (the memory backend does).
> 3. `FileMemo.note_epoch` (new optional field in `backend.ts`) keeps the highest epoch used per file, so a file closed and reopened, or opened after a restart without a leftover note, never repeats an epoch another computer may have overridden ("Edit here").
> 4. A background tab restored with unsaved changes (a draft) holds the document too (its note says `editing`, like the active tab in §5.3 Open).
> 5. On open the controller awaits `cloudInfo` + `presenceList` (both fast, no person's action waits on them) before the document is put into the editor, so a tab that must be read-only never shows editable first.
> 6. The browser preview's controller runs on the simulated clock and this computer's simulated timers (`makePreviewBackend` returns `now` / `timers`), so the simulator's "+5 min" and "This computer sleeps" reach it. `nativeWake` is `null` = desktop.
> 7. `tab.presence.status` is set whenever the tab is clean and its version was saved on another computer (not only where a note was seen); the `reloaded` toast is left out only where a foreign note was seen (§5.7).
> 8. `settings.shareDefault` is always present (`"auto"` when nothing was chosen).
> 9. Tests: `MemoryWorld` takes `noteRoots` (like `LAS_NOTE_ROOTS`; `[]` = no device writes notes) and `MemoryDevice.writesNoNotes` models an app without notes. The phase 1 / 2 tests in which two computers edit within seconds of each other run with `makeWorld(…, { notes: false })` (with notes the second computer is read-only, which is phase 3's point); the phase 3 tests run with notes everywhere.
> 10. Known edge (presence.ts rule §2.2): when another computer's last heartbeat reaches this computer only after this computer woke up (it was written within the sync delay before the sleep), the re-look counts it as a change and the tab can stay read-only up to 5 min after the wake-up, also if that computer crashed long before.

> **CHANGED BY fixer:** (verifier findings VP-2, VP-3, VS-1, VS-2, VS-4, VS-5, VS-6, F2; no shape in contract.ts changed)
> 1. §5.5 **Edit here lasts as long as this computer is editing** (VP-2; replaces "overrides stay for the life of the tab"): `overrides` are emptied whenever the hold ends (the 30 s after Save / Edit here without edits, blur, tab switch, discard, a yield, a clean holder's wake-up, the file gone). So after Edit here without typing, the other computer's ongoing claim makes this clean tab read-only again until that computer saves and stops — "read-only until it is saved". `dismissed` is kept (a closed information banner stays closed).
> 2. §5.4 / §9.16 **no flicker across the editor's save** (VP-3; §9.16 no longer applies): for 30 s after the tab's version changed, an editing note of the computer that saved that version (the version's `device_id`), still naming an ancestor of it as `base_revision`, and unchanged (same seq) since the version arrived, is given to `decide` as based on the new version — its rewritten note is on its way (the two files sync separately). The evaluation timer also fires when those 30 s end. Freshness still applies to the note.
> 3. §5.3 Input (VS-1): window activity (`deps.lastActivity`) counts only for an active tab that **has unsaved changes**, while `deps.graphsVisible()`. A clean tab's 30 s after Save are counted from the save and real edits (`userEditSerial`) only, so clicks elsewhere never keep other computers read-only (D6).
> 4. §5.3 path change (VS-2; replaces session's note 2): after `presenceSet` for the new path resolved, `presenceClear(old)` is **always** called. `presence_clear` never deletes a note registered for another document path (Rust and the memory backend), so the new note stays; after Save As "the same analysis" under a new name in the same folder the old note used to stay and keep beating.
> 5. §5.4 Open (VS-4; narrows session's note 5): opening waits for `cloudInfo` + `presenceList` at most 1.5 s; a later answer is taken in and the tab evaluated then (a stalled folder never holds the document back).
> 6. §5.4 duplicate identity (VS-5): `newDeviceId` at most once per launch.
> 7. §5.4 guard `resuming` (VS-6): set after `deps.flushScratch({commitEdit: true})`, like the read-only guards (an open Scratchpad cell entry could not be committed under the guard and was lost when the Scratchpad closed).
> 8. §5.7 status (F2): the version named is its author when that is another computer; for an automatic combine (no author) the newest person's version it combined — none when one of those is mine (my save combined it). Before, it said "Someone else saved".
> 9. Session's note 10 (known edge) is resolved by the presence fixer note 1 (late arrivals).

---

> **CHANGED BY fixer (round 2):** (re-verifier findings RV-1, RV-2, RV-4; no shape in contract.ts changed)
> 1. §5.5 **Edit here means "I'm editing now"** (RV-4; replaces fixer note 1's "the 30 s after … Edit here without edits"): Edit here / Edit anyway / the `editingInfo` Edit here claim at once (`editing`, D10) and that hold is **not** ended by the 30 s rule until the first edit or Save in it (`editHereHold`); after that the usual D6 rules apply (30 s after Save without input). It still ends at once, on a clean tab, with window blur, a tab switch, closing the tab, discard / reload paths, a clean holder's wake-up, a yield to a note that names my claim (the other computer pressed Edit here back), and — new, for every clean holding tab — **an editing claim on this tab's version, live, that was not known when my hold began** (`claimSeen`: the other computers' editing claims and my overrides at claim time; that computer claimed after me without having seen my note, or claimed again). When the hold ends, `overrides` are emptied as before (VP-2 kept: the tab is read-only again while the other computer keeps editing).
> 2. §5.3 path change (RV-2): **one code path**, `presenceRepath(key, from, to)`, runs at the end of `repoint` (Find it…, the same-folder rename search, the poll's `moved` by identity, a save that followed the file, a combine into the other copy) and of `moveTabToNewFile` (Save As the same or a new analysis, a separate copy): the `gone` mark of the old path is cleared, a tab with unsaved changes holds the document as on Open (`editing`, epoch + 1), and `evaluate` lists the notes beside the new path, writes my note there and clears the old one (fixer note 4). Before, after Find it… on an open document whose file had gone missing (and after Save As while missing) `gone` stayed set and no note was written for the found file. The `moved` handler's own `presenceOpen` + `evaluate` is gone (it is this path now).
> 3. Memory backend (RV-1): `MemoryDevice.notesOnlineOnly` / `noteHydrateMs` model a folder kept online-only — other computers' notes arrive dataless; a read asks for the download (done `noteHydrateMs` later while online, retried while offline), keeps the last text read meanwhile and polls the folder when the download is done (as `read_notes`).
> 4. Tests: `presence.fixes2.test.ts` (RV-1 ×2, RV-2 ×6: Find it… clean and with unsaved changes, rename followed, move by identity, Save As the same analysis while missing and with both files kept; RV-4 ×4). The VP-2 test in `presence.fixes.test.ts` now leaves the window before expecting read-only again.

## 6. UI (owner: ui)

Files: `src/components/graph/files-ui/**` only. The UI calls only `useFileSession` (now `FileSessionStateP3`) and `devSim()`; it reads `tab.presence` and never the notes. Texts live in `files-ui/text.ts` (the contract author added first wordings for the new banner kinds and action labels so the baseline passes; ui owns the file and completes them to the tables below).

### 6.1 Placement and test ids

| where | what | `data-testid` |
|---|---|---|
| `DocBar.tsx`, beside the title | chip **Read-only** while `tab.readOnly` (too new) or `tab.presence?.readOnly`; tooltip = the banner's text | `doc-readonly` |
| `DocBar.tsx`, status text | §6.4 | `doc-status` (exists) |
| `DocBar.tsx`, Save button | disabled while read-only; tooltip "Read-only right now"; a click on the disabled button's wrapper calls `reportEditAttempt("command", "save")` | `doc-save` (exists) |
| `BannerSlot.tsx` | the new kinds. When `tab.presence.attempt` changes, the first button of the presence banner is highlighted and pulses for `LIMITS_P3.attemptPulseMs` with `data-pulse="true"`; if the presence banner is under "+n more" at that moment, it is shown as the main banner for that time | `file-banner` + `data-kind` (exists); `banner-editHere`, `banner-editAnyway`, `banner-keepEditing`, `banner-saveCopy` |
| `FileTabs.tsx` | a small lock icon on a tab that is read-only; a small "two people" icon while `presence.mode === "bothEditing"` | `tab-readonly`, `tab-both` |
| `FileMenu.tsx` | item **Show Others When I'm Editing…** after Versions (→ `openSharing()`); Save disabled while read-only | `menu-sharing` |
| `EditAnywayDialog.tsx` (new) | dialog `editAnyway` | `editanyway-dialog`, `editanyway-go`, `editanyway-cancel` |
| `ResumeDialog.tsx` (new) | dialog `resumeConfirm` | `resume-dialog`, `resume-go`, `resume-wait` |
| `SharingDialog.tsx` (new) | dialog `sharing` | `sharing-dialog`, `sharing-default`, `sharing-auto`, `sharing-always`, `sharing-never`, `sharing-status`, `sharing-close` |
| `SettingsDialog.tsx` | a select **Show others when I'm editing** (the default) under the two names | `settings-share` |
| `FilesHost.tsx` | mounts the three dialogs | — |
| `SimPanel.tsx` | §6.6 | `sim-*` |
| `Toasts.tsx` / `text.ts` | toast `deviceIdChanged` | — |

Esc or the backdrop: on `editAnyway` = Cancel; on `resumeConfirm` = Wait; on `sharing` = Close.

### 6.2 Banner wording

`{user}` = the peer's user name ("Someone" when blank); `{device}` = its computer name ("another computer" when blank); `{clock}` = `clockText(ms)` in **this** computer's time — "19:40" today, "Fri 18:02" within the last 7 days, "12 Nov 18:02" before that; `{note time}` = `clockText(Date.parse(peer.updatedAt))` (the other computer's clock, display only; when it does not parse, the phrase with its preposition is left out); `{ago}` = `whenText` of `peer.changedAt`. Two peers: names joined with "and" ("Alice and Bob", "Mac mini and MacBook-Pro"); more: "Alice, Bob and 1 other".

| kind | severity | text | buttons |
|---|---|---|---|
| `editingElsewhere`, same user | info | You have this open on {device} with changes not yet saved there. Both sets of changes will be combined when that computer saves. | **Edit here** |
| `editingElsewhere`, someone else | info | {User} is editing on {device} (note updated {ago}). You'll see their changes each time they save. | **Edit anyway…** |
| `editingElsewhere`, two or more | info | {Users} are editing this version on {devices}. You'll see their changes each time they save. — all of them you: You have this open on {devices} with changes not yet saved there. Both sets of changes will be combined when those computers save. | **Edit anyway…** / **Edit here** |
| `editingElsewhere`, `checking` | info | Checking who is editing… | — |
| `waitingNewer` | info | {Device} saved a newer version — loading it… | — |
| `unconfirmed` | info | Couldn't confirm the newest version yet. | (×) |
| `editingInfo`, quiet, on my version | info | {User} started editing on {device} on {note time} and may have unsaved changes there. — same user: You started editing on {device} on {note time} and may have unsaved changes there. | **Edit here** · OK |
| `editingInfo`, older version | info | {User} has unsaved changes on {device} from {note time}; they will be combined when {user} saves. — same user: You have unsaved changes on {device} from {note time}; they will be combined when that computer saves. | OK |
| `bothEditing` | warning | Also being edited on {device} ({user}). Nothing is lost — the two versions are combined when you save. — same user: Also being edited on {device} (your other computer). Nothing is lost — the two versions are combined when you save. | **Keep editing** · Save my changes as a separate copy… |
| `continuedElsewhere` | info | You continued on {device} at {clock}. Your unsaved changes here are kept and will be combined. — someone else: {User} continued on {device} at {clock}. Your unsaved changes here are kept and will be combined. (`{clock}` from `peer.editingSince`) | **Keep editing** · Save my changes as a separate copy… |
| `resuming` | info | Checking for changes made while this computer was asleep… | **Keep editing** |
| `olderPeer` | warning | {Device} runs an older version that doesn't show who is editing — update it. — no name: The other computer runs an older version that doesn't show who is editing — update it. | OK |

`bannerActionLabel`: `editHere` → "Edit here"; `editAnyway` → "Edit anyway…"; `keepEditing` → "Keep editing"; `saveCopy` → "Save my changes as a separate copy…"; `dismiss` on the new kinds → "OK".

### 6.3 The read-only chip and the edit attempt

Chip text **Read-only** (`STATUS.readOnly` changes from "Read only" to "Read-only"; the Versions preview's chip may follow). The chip does not say why — the banner does. An edit attempt (typing in a cell, a click on a dimmed rail section, ⌘S, the disabled Save) makes the banner's button pulse; there is no toast and no dialog.

### 6.4 Status line (`doc-status`)

The first that applies: Opening… · Saving… · Not saved · **Read-only** (`tab.readOnly || presence.readOnly`; with `presence.status`: "Read-only · {Who} saved {when}") · Unsaved changes · **Up to date · {Who} saved {when}** (clean and `presence.status` set) · All changes saved. `{Who}` = `cap(whoText(status.who, settings))`; `{when}` = `whenText` of `status.seenAt ?? status.who.time`. Example: "Up to date · Alice (Office iMac) saved 2 min ago". The text is refreshed at least every 30 s while it is shown.

### 6.5 Dialogs and the setting

**Edit anyway** — title "Edit anyway?"; body "{User} may have unsaved changes. If you both edit, the two versions are combined on save. Continue?" (two or more: "{Users} may have unsaved changes. …"); buttons **Edit anyway** · Cancel.

**After sleep** — `what: "save"`: title "Save now?"; body "This computer was asleep. Changes made on another computer may not have arrived yet. If someone else saved meanwhile, the two versions are combined."; buttons **Save now** · Wait. `what: "edit"`: title "Keep editing?"; body "This computer was asleep. Changes made on another computer may not have arrived yet. If you both edit, the two versions are combined on save."; buttons **Keep editing** · Wait.

**Show others when I'm editing this file** (`sharing`) — that title; four choices (radio): **Use my default ({the default's name})** (`sharing-default`, selected when `choice` is null) · **Automatically (in cloud folders)** · **Always** · **Never**. A status line (`sharing-status`) from `SharingView.why`:

| `why` | text |
|---|---|
| `cloud` | On. This file is in {service}, so a small note file is kept next to it while it is open here. |
| `otherComputers` | On. This file has been used on another computer. |
| `always` | On. A small note file is kept next to this file while it is open here. |
| `local` | Off. This file is not in a cloud folder and has only been used on this computer. |
| `never` | Off. Other computers can't see when you are editing this file. |
| `untitled` | Save the analysis to a file first. |

Help text under it: "While you edit, other computers that have this file open show it as read-only until you save. The note file is small and safe to delete. Dropbox also has its own "Lock editing" (paid plans); you can use it as well." Button **Close**. Every choice applies at once (`setSharing`).

**Settings** — the select "Show others when I'm editing" with the three modes; helper text "Used for files that have no choice of their own."

Toast `deviceIdChanged`: "This computer was using the same identity as another one. It now has its own."

> **CHANGED BY fixer:** (verifier findings F1, F3, F4, F5, F7, F8)
> 1. §6.4 (F4): while read-only, the status line is "{Who} saved {when}" without the "Read-only · " prefix (the chip says it) and stays visible beside a banner from the `md` width up (max 240 px), since it replaces the per-save toasts.
> 2. §6.1 BannerSlot (F3): while `presence.readOnly`, the banner that says who is editing (or the waiting one) is always the main banner, not only during the 4 s pulse; other banners (extra copy, …) go under "+n more". `BANNER_ORDER` in contract.ts is unchanged; the slot overrides it. (F1) The "+n more" list is anchored to the slot (which stays mounted) and closes when the main banner changes or nothing is left in it. (F8) A refused edit makes the whole banner glow as well as its first button.
> 3. Save As (F5): while the tab is read-only, "The same analysis in a new place" is disabled with the line "Not available right now: this analysis is read-only while it is edited on another computer."
> 4. Simulator (F7): Reset stops the preview from saving its world (the page's unload handler wrote it back after the key was removed).

### 6.6 Simulator panel (browser preview)

`devSim()` returns `DevSimApiP3`. A new group **Who is editing** at the top of the panel, acting on the picked file. A switch row chooses who acts — **Office iMac (Alice)** / **Lab MacBook (Bob)** (`sim-who-other`, `sim-who-third`) — and **as me** (`sim-same-user`: the acting computer uses *my* user name, "my own other computer").

| button (`data-testid`) | label | calls |
|---|---|---|
| `sim-peer-open` | Open the file there | `peerOpens(path, {who, sameUser})` |
| `sim-peer-edit` | Start editing there | `peerStartsEditing(path, {who, sameUser})` |
| `sim-peer-save` | Save there (stop editing) | `peerSaves(path, {who})` |
| `sim-peer-save-keep` | Save there, keep editing | `peerSaves(path, {who, keepEditing: true})` |
| `sim-peer-stop` | Stop editing there (discard) | `peerStops(path, {who})` |
| `sim-peer-quit` | Quit the app there | `peerQuits(path, {who})` |
| `sim-peer-crash` | Crash there (note left behind) | `peerCrashes(path, {who})` |
| `sim-peer-sleep` / `sim-peer-wake` | Sleep there / Wake there | `peerSleeps` / `peerWakes` |
| `sim-peer-edit-here` | Press "Edit here" there | `peerEditsHere(path, {who, sameUser})` |
| `sim-note-conflict` | Conflict copy of its note | `noteConflictCopy(path, {who})` |
| `sim-old-app` | Older app there: on / off | `setOldApp(on, who)` |
| `sim-skew` | Its clock: right / +2 h / −2 h / year 2001 | `setClockSkew(ms, who)` |
| `sim-delay` | Sync delay: 0 s / 5 s / 60 s | `setSyncDelay(ms)` |
| `sim-this-offline` | This computer offline: on / off | `setOffline(on)` |
| `sim-sleep-3m`, `sim-sleep-2h` | This computer sleeps 3 min / 2 h | `sleep(ms)` |
| `sim-advance-60`, `sim-advance-300` | +1 min · +5 min (beside the existing +10 s) | `advance(ms)` |
| `sim-notes` | the note files beside the picked file: name · state · "kept up to date" when `beating` (from `notes(path)`), refreshed on every change | — |

Every existing `sim-*` id keeps its meaning. `peerStartsEditing` on a file the peer has not opened opens it first; `peerSaves` without a `peerStartsEditing` before it starts editing first. `peerEditsHere` makes the peer's note `editing` with `supersedes` = this computer's current claim (when this computer is not editing it simply starts editing). The simulated peers follow the same note rules as the app (§3.2, §3.5; the 30 s after `peerSaves` without `keepEditing`), through the same `presence.ts` functions.

### 6.7 Words

Never in the UI: everything on the phase 1 / 2 lists, plus **beacon, claim, epoch, heartbeat, supersede, stale, seq, presence, linger, session id**. ui extends the sweep to every new banner (each row of §6.2 with one and two peers, same user and not), dialog, status and setting string.

---

## 7. File ownership (no overlaps)

| implementer | owns |
|---|---|
| **rust** | `src-tauri/**` (new `presence.rs`, `presence_tests.rs`; changes in `graphwatch.rs`, `quit.rs`, `lib.rs`, `menu.rs`, `appstate.rs`, `devenv.rs`, `deve2e.rs` and their tests) |
| **presence** | new `src/components/graph/file/presence.ts`, `presence.test.ts`, optionally `presence.scenarios.test.ts` and fixtures under `file/fixtures-p3/` |
| **readonly** | `src/store/graphStore.ts` (+ its tests), `src/components/graph/GraphView.tsx` and everything under `src/components/graph/` **except** `file/` and `files-ui/`: `DataGrid.tsx`, `GraphAnalysisControls.tsx`, `GraphFigureControls.tsx`, `PalettePicker.tsx`, `FigureTextPanel.tsx`, `GraphResults.tsx`, `GraphLibrary.tsx`, `scratchpad/**`, `__tests__/**` |
| **session** | `src/components/graph/file/session.ts`, `backend.ts`, `memoryBackend.ts`, `previewBackend.ts`, `tauriBackend.ts`, `devSim.ts`, `e2e.ts`, `testkit.ts`, the one-line `FEATURES` change in `format.ts`, the existing tests of these files, new tests `presence.session.test.ts`, `presence.multidevice.test.ts` |
| **ui** | `src/components/graph/files-ui/**` (including `text.ts`, `text.test.ts`) |
| **nobody** (read-only) | `contract.ts`, `docCodec.ts`, `idMap.ts`, `paths.ts`, `revisions.ts`, `retention.ts`, `graphMerge.ts`, `summaries.ts`, `laneGraph.ts`, `libraryExport.ts`, `graphModel.ts`, `src/App.tsx`, the layout, the Python sidecar, CI, `package.json`, `Cargo.toml`, `Cargo.lock`; `goldens.test.ts` except what `FEATURES = 2` forces (session) |

Already done by the contract author: section 7 and the marked members in `contract.ts`; in `files-ui/text.ts` the severities, first banner texts and action labels of the new kinds (so `Record<BannerKind, …>` and the test "every banner kind has text" keep passing). From here `text.ts` is ui's.

`GraphView.tsx` is readonly's: the UI needs nothing mounted there in this phase (every new dialog goes through `FilesHost`).

---

## 8. Acceptance checklist

Where it runs: **V** = vitest (scratch copy), **C** = `cargo test --locked`, **B** = browser preview with the simulator, **E** = real-app self-test (`LAS_E2E_SCRIPT`, phase `"presence"`), **M** = by hand on two real computers. Baseline that must stay green throughout: `tsc --noEmit`, `vite build` (and `grep -r dev_e2e_ dist` finds nothing), vitest (24 files / 517 tests + the new ones), `graph-fe-tests/run.sh`, `graph-tests/run_all.sh`, `cargo test --locked` (90 passed / 1 ignored + the new ones), `cargo check --locked --release`.

### Pure engine (presence) — V

1. **P1** `sanitizeNamePart`, `deviceTag`, `noteFileName`: every row of the §1.2 table; a 255-byte stem; an empty device name; an id without hex digits; the result never starts with `.` or `~`, has no character outside the rule and is ≤ 206 UTF-8 bytes. (rust's R1 uses the same vectors.)
2. **P2** `noteText` / `parseNote`: round trip; the exact text of the §1.1 example; every tolerance of §1.1; rejected: over 8192 bytes, no object, wrong `format` / `v`, a missing id, a `seq` that is not a number.
3. **P3** `noteApplies`: by name (case, NFC against NFD), by the sole-id rule, not for the second of two same-id files, never for another analysis id. `pickPerDevice`: the highest seq; both tie-breaks; conflict copies of one device collapse to one.
4. **P4** `observe`: first sight (old, not old, unreadable `updated_at`); a seq, epoch or session change counts as a change; a removed note is forgotten; the `editingSince` rules; `unknownSince` kept, added and dropped.
5. **P5** `freshness`: old at first sight → quiet at once; otherwise active for 90 s and then quiet without a change; after a change active for 5 min; `checking` for at most 15 s after `markGap`, then the first-sight rule; the re-look after a gap with a moved seq is active.
6. **P6** `decide`, clean tab: waiting for an unknown version (2 min; 20 s for a note that was old at first sight; `unconfirmed` afterwards); read-only for an active editing note on my version; **not** read-only for the same note when it is quiet, on an older version, overridden, or overridden by another note (then that note decides); information only for those; two blockers → both in `about` and `blockers`; idle notes alone → editable.
7. **P7** `decide`, unsaved changes or holding: never `readOnly` / `waiting`, for any set of notes (property test over generated notes, ≥ 500 cases, fixed seed); `bothEditing` with an active editing peer; `yieldedTo` when a note names my epoch (and not when it names another epoch); `resuming` while the flag is set and no note overrides me; `info` when the only editing peers are quiet.
8. **P8** Order independence: any permutation of the same notes → the same decision; adding and then removing a note → the decision as before.
9. **P9** Clocks: every `updated_at` shifted by ±2 h, set to 2001 and to 2099 → never a read-only longer than 90 s without a seq change, and the decision otherwise as in the unshifted case except through the first-sight rule; a source check that `updated_at` is read only in `observe` (first sight) and `pickPerDevice` (tie-break).
10. **P10** `gapDetected`: 89 s late no, 91 s late yes, clock backwards yes. `nextCheckAt` is exactly the next flip (advance to it → the mode changes or a later time is given).
11. **P11** `olderPeer`, `multiDevice`, `shareDecision` (every row), `liveNoteHeads`, `cleanupTargets` (23 h 59 min no, 24 h yes, never own, never a note of another existing document), `duplicateIdentity`.

### Rust — C

12. **R1–R13** as listed in §3.12.

### Store and editor (readonly) — V and B

13. **G1–G5** as listed in §4.3 (V).
14. **G6** (B; "Start editing there" on a clean tab, so the tab is read-only) Typing in a data cell changes nothing and the input keeps its value; multi-cell paste, ⌘Z and Delete do nothing; the column and row menus open with their items disabled; the replicate / add / remove buttons, every analysis and graph control, the palette picker and the text panel's fields are dimmed and do not react; in the Scratchpad no editor opens, paste / Delete / fill / undo / redo / format do nothing, **Clear scratchpad…** and **Send selection to Data…** are disabled. After each attempt `useGraphStore.getState().blocked.serial` has grown and `isDirty` is false.
15. **G7** (B, same state) Still working: selecting and copying cells (grid and Scratchpad, "Copy values"), the canvas tabs, collapsing rail sections, Render graph, downloading the figure, the Versions panel with preview and compare, Show in Finder, Save As → "A new analysis", Duplicate.
16. **G8** (B) "Save there, keep editing" → the new value appears in the read-only grid and graph by itself and the tab stays read-only; after "Edit scratchpad and save" there, the Scratchpad shows the new A1.
17. **G9** (B) A cell is being typed in when the other computer starts editing: the typed value is kept and the tab shows "Also being edited…" (it is not read-only).

### Controller (session) — V, two or three `MemoryDevice`s on the `ManualClock`

18. **S1** Open in a synced folder → an idle note with my version beside the file on the simulated disk; a local folder with Automatically → **no note file**; Always → a note; Never → none, and an existing one is removed; a local file whose history has another computer → a note (`why: "otherComputers"`).
19. **S2** Claim: the first applied user edit writes `editing` with `epoch + 1` and `base_revision` = the tab's base, without awaiting anything (the store has the edit while the write is still pending). **No claim** from: open, restore of a clean tab, live refresh, `replaceContent` after a combine, the clean-up effect, `markFileSaved`, a refused edit.
20. **S3** Heartbeat and input: `seq` grows every 60 s while editing with input; it stops 10 min after the last input; `presenceInput` is called at most every 30 s.
21. **S4** Release (D6): after Save the note has the new version at once and stays `editing`; 30 s later without input → `idle`; input inside the 30 s keeps it; window blur or a tab switch on a clean tab → `idle` at once; a tab with unsaved changes stays `editing` through blur and tab switch; discard / revert → `idle` at once; close tab → the note file is gone; simulated quit → all own notes gone.
22. **S5** Observer: B clean, A starts editing → B is `readOnly` (guard `editingElsewhere`, a banner with A's names, `editHere` for the same user, `editAnyway` otherwise); every store user action on B is refused and `presence.attempt` grows; A saves → B shows the new content (live refresh, no toast, `status.kind === "upToDate"`), still read-only; 30 s later → B editable, no banner.
23. **S6** Edit here (same user): instant — in the same tick the guard is cleared and B's note is `editing` with `supersedes` = A's `{device_id, epoch}`; A (with unsaved changes) shows `continuedElsewhere` and keeps its content; whoever saves second combines (one two-parent version). Edit anyway (another user): the dialog first; Cancel changes nothing.
24. **S7** Both editing: A and B start inside the sync delay → both `bothEditing`, neither note deleted, nobody read-only; `keepEditing` hides the banner until a new epoch; `saveAsSeparateCopy` moves the tab to a new analysis and clears its note at the old path; a third, clean computer C is `readOnly` with both in `about`.
25. **S8** Never frozen: through every transition of S5–S7 a tab with unsaved changes (or holding) never has a guard other than `resuming`; a guard is not set while `interactionBusy()` and is set once it is false; an open Scratchpad edit is committed before the guard and then counts as a claim.
26. **S9** Waiting: a note announces a version B does not have → `waiting` (guard, banner); the file arrives → reload, the banner gone; it never arrives → after 2 min of B's time editable with `unconfirmed`; a note that was old at first sight waits 20 s.
27. **S10** Quiet notes: A crashes while editing → B is editable (mode `info`, the banner with `editHere`) at the latest 5 min after the last seq change B saw; a B that first opens the file 20 min after the crash is editable at once. B typing then claims with `supersedes` naming A's quiet claim.
28. **S11** Sleep on the observer: B sleeps 2 h while A edited and stopped → on wake B is `checking` for one listing, then editable; with A still editing → read-only again after the re-look.
29. **S12** Sleep on the holder: A with unsaved changes sleeps → on wake `resuming` (banner, guard `resuming`, no beating); Save asks `resumeConfirm`; the first edit is refused once and asks; `go` re-claims with a new epoch; 45 s with nothing → re-claim; a note overriding A's claim seen in the window → `continuedElsewhere`, content kept, note still `editing`; a newer version in the window → the phase 2 `newerOnDisk` banner; a holder that was clean → `idle` at once.
30. **S13** A read-only tab writes nothing into its file: `save`, `saveAs("same")`, `bringBack`, `applyCombine`, `startCombine`, `undoCombine`, `useEarlierVersion`, `goBackToMyLatest`, `updateMine` → `reason: "readOnly"` (or nothing), with the attempt counted; an automatic combine waits and is written after the guard clears; `saveAs("new")`, `duplicate`, `saveVersionAsNew`, `removeExtraCopy` still work.
31. **S14** Too-new file: guard `tooNew`, every edit refused.
32. **S15** Older peer: the other computer saves with `features: 1` and has no note → banner `olderPeer` once per head; with a note → none.
33. **S16** Retention: a manifest written while a foreign note declares version `X` (old enough to lose its content otherwise) keeps `X`'s content.
34. **S17** A conflict copy of a note (same device, lower seq) changes nothing; the owner's next write removes its own copy; a foreign note unchanged for 24 h is removed (`presenceRemoveForeign`, after the re-read), one that changed at 23 h is not; an orphan likewise.
35. **S18** Duplicate device id: a second running app with my device id → `newDeviceId` is called, the toast, the notes rewritten under the new id; a crash leftover with my device id (its seq never moves) does **not** trigger it and is replaced.
36. **S19** Rename follow (`moved`) and Save As to a new path: a note for the new name and none left for the old one; `missing` → the note is cleared; `back` → written again.
37. **S20** The computer renamed in Settings → the note file is replaced by one with the new name; no second own note remains.
38. **S21** `features` is 2 in every manifest written; a phase 1 / 2 fixture opens unchanged; a file saved by the simulated older app opens and saves.
39. **S22** `tauriBackend` mappings with the fake `invoke` (every new command, both events, the order per `docPath`).
40. **S23** Menu: `canSave` false while the tab is read-only (and true during `resuming`); `menu(MENU.sharing)` opens the dialog; `menu(MENU.save)` on a read-only tab counts an attempt and writes nothing.
41. **S24** No listing shown to the person contains a `.laguse` file (preview picker, `DevSimApi.files()`, Recent, Find it… results of the memory backend).

### Multi-device scenarios — V (`presence.multidevice.test.ts`; plan §13)

42. **X1 The matrix.** Computers A (editor) and B (observer), plus C where stated, on one file in a synced folder. A opens, edits, saves, edits again, saves, stops; B and C have the file open and clean. Run for each of:
    - sync delay 0 s, 5 s, 60 s (notes and files alike);
    - B offline during A's whole session, then back; A offline (its notes never leave), then back;
    - **notes arriving before the document** (note delay 0, file delay 60 s) and **after it** (note delay 60 s, file delay 0);
    - **the note's deletion arriving before the document** (A quits right after saving and the delete syncs first) and after it;
    - A's clock wrong by +2 h, −2 h, and wildly (2001, 2099); the same for B's clock;
    - sleep on the editor (A sleeps 10 min in the middle of editing and wakes), sleep on the observer (B sleeps 10 min; 2 h);
    - A crashes while editing; A crashes while idle; A starts again 1 h later;
    - duplicate device id (A and C share one);
    - a conflict copy of A's note; a conflict copy of B's note;
    - older peer (A runs the app without notes);
    - three computers: A edits, B presses Edit here, C watches; A and B both edit, C watches.
43. **X2 Assertions**, checked by helpers after every simulated step:
    1. **No unsaved edits are ever frozen or lost.** Whenever a tab is dirty (or its controller is holding), its store guard is `null` or `resuming`, and `resuming` never lasts more than 45 s; every value typed in a scenario is in a saved version, or still in a tab or its unsaved-work backup, at the end.
    2. **A clean observer is read-only only while a fresh editing note based on its version exists.** Whenever a clean tab's guard is `editingElsewhere`, the listing it last saw has another device's `editing` note whose `base_revision` is that tab's base, with — by the observer's own record — a seq change within 5 min or a first sight within 90 s. Guard `waiting` only with a note announcing a version the tab does not have, for at most 2 min. Guard `checking` for at most 15 s.
    3. **Every device becomes editable within 5 min of an editor crash or sleep** (each device's own time, plus one poll cycle): 5 min 10 s after A crashed or went to sleep no other tab has a guard — also with A's or the observer's clock wrong in either direction.
    4. **At most one combine per pair.** Among all revisions of all files at the end, no two two-parent revisions have the same sorted parents (the phase 2 assertion, now with Edit here in play).
    5. **Notes are never left behind after a normal quit.** After `quit()` of a device and once the sync has settled, no note with its device id is on any device's disk, apart from sync-conflict copies that only other devices hold — and those are gone after the 24 h rule.
    6. **No note for a local file in Automatically mode.** A file in a folder that is not synced, which only one computer ever saved, never gets a note file, whatever is done with it.
    7. The phase 2 assertions hold in every scenario: no version is ever lost; all computers end on the same version once everything is saved and synced.

### UI — V (text) and B (browser preview: `las.activeTool = "graph"`, the simulator panel)

44. **U1** (V) The wording tables of §6.2, §6.4, §6.5 for one and two peers, same user and not; the banned-word sweep with the new words; `clockText`.
45. **U2** (B) "Open the file there" → nothing changes on screen and `sim-notes` lists an idle note. "Start editing there" (as Alice) → chip **Read-only**; banner "Alice is editing on Office iMac (note updated just now). You'll see their changes each time they save." [Edit anyway…]; Save disabled; a lock on the tab. Typing in a cell → the button pulses (`data-pulse`), nothing changes.
46. **U3** (B) The same with **as me** → "You have this open on Office iMac with changes not yet saved there. …" [Edit here]; pressing it → editable at once, the chip gone. "Save there" afterwards → the phase 2 newer-version / combine flow when I typed something, a plain refresh when I did not.
47. **U4** (B) [Edit anyway…] → the confirm dialog; Cancel keeps read-only; Edit anyway → editable.
48. **U5** (B) "Save there, keep editing" → the value updates in place, the status reads "Read-only · Alice (Office iMac) saved just now", no toast. "Save there (stop editing)" and three times "+10 s" → editable, the status reads "Up to date · Alice (Office iMac) saved …".
49. **U6** (B) "Quit the app there" while it is editing → editable within one poll. "Crash there" → still read-only; "+5 min" → "Alice started editing on Office iMac on … and may have unsaved changes there." [Edit here], and the tab is editable.
50. **U7** (B) An own edit (unsaved), then "Start editing there" → "Also being edited on Office iMac (Alice). Nothing is lost — …" [Keep editing] [Save my changes as a separate copy…]; the tab is **not** read-only. Lab MacBook starting too → both names.
51. **U8** (B) An own edit, then "Press "Edit here" there" → "Alice continued on Office iMac at {time}. Your unsaved changes here are kept and will be combined."; with **as me** → "You continued on Office iMac at …".
52. **U9** (B) An own edit, then "This computer sleeps 3 min" → "Checking for changes made while this computer was asleep…" [Keep editing]; Save → the "Save now?" dialog; typing → the "Keep editing?" dialog; after 45 s (five times "+10 s") the banner is gone.
53. **U10** (B) A clean tab, "This computer sleeps 2 h" while the other is editing → "Checking who is editing…" briefly, then read-only again; after "Crash there" and the sleep → editable.
54. **U11** (B) Sync delay 60 s and "Save there": first "Office iMac saved a newer version — loading it…", then the content. With "This computer offline" on → after 2 min "Couldn't confirm the newest version yet." and the tab is editable.
55. **U12** (B) "Older app there: on" and "Edit table and save" → "Office iMac runs an older version that doesn't show who is editing — update it." [OK].
56. **U13** (B) "Conflict copy of its note" → nothing changes on screen; `sim-notes` lists two files.
57. **U14** (B) File menu → Show Others When I'm Editing… → the dialog. A file in Documents shows "Off. This file is not in a cloud folder…" and `sim-notes` is empty; **Always** → a note appears; **Never** on the Dropbox file → its note disappears. Settings → the default select.
58. **U15** (B) Nothing jumps sideways when a banner changes; everything works at 1280 × 800; the viewport is reset to desktop and the preview tab closed afterwards.

### Real app — E (debug build, `LAS_E2E_SCRIPT`, phase `"presence"`; folders under the scratch area with `LAS_NOTE_ROOTS` and `LAS_CLOUD_ROOTS` set to them; one run also in `~/Library/CloudStorage/Dropbox/LAS-phase3-test-DELETE-ME`, moved to the Trash afterwards)

59. **E1** Open a file in a `LAS_CLOUD_ROOTS` folder → a note file with the §1.2 name and the §1.1 content is there (`readText`), `state: "idle"`, my version. Open one outside → no `.laguse` in that folder.
60. **E2** An edit → the note says `editing` with `epoch` + 1; after one heartbeat (`LAS_NOTE_HEARTBEAT_MS` shortened) `seq` has grown; Save → the new `head` at once; 30 s later `idle`.
61. **E3** The runner writes another computer's `editing` note for my version (`writeText`) → within one poll the tab is read-only (guard `editingElsewhere`) and a `setCell` is refused; the runner rewrites it with a higher seq → still read-only; deletes it → editable within one poll.
62. **E4** While read-only: another computer's save (a staged file copied over) plus its note with the new version → the content refreshes and the tab is still read-only.
63. **E5** `editHere` → my note carries `supersedes` for the foreign claim; the tab is editable.
64. **E6** `{op: "wake"}` while holding with unsaved changes → `resuming`; a foreign note naming my epoch → `continuedElsewhere`, the content intact.
65. **E7** Close the tab → the note is gone. Reopen, edit, `dev_e2e_quit` → after exit no `.laguse` of this app is left in the folder. `terminate` (kill) while editing → the note is left; the next start with the same state folder replaces it (new session id, `seq` continued), and for a file that is not reopened the 20 s sweep deletes it.
66. **E8** File menu → Show Others When I'm Editing… (`dev_e2e_fs` op `menu` with `file.sharing`) opens the dialog; **Never** removes the note.
67. **E9** In the Dropbox test folder: the note file is written and listed, and its name passes the name rules (a second real computer is the manual check M1).
68. **E10** The `vite build` output has no `dev_e2e_`; a release `cargo check` has none of the debug operations.

### By hand, on two real computers — M (cannot be automated here; say so in the report)

69. **M1** The same Dropbox file on two Macs with the same user name: edit on one → the other shows read-only within the sync delay; Save → the other refreshes; 30 s → editable; Edit here; quit → no note left in the folder on either Mac. Then the same on OneDrive / iCloud Drive / Google Drive, and on Windows when that pass happens (plan §17: only Dropbox on one Mac was ever inspected).

---

## 9. Where this contract narrows or changes the plan (on purpose)

1. **`supersedes` is a list** (`[{device_id, epoch}, …]` or `null`), not one object: Edit here over two editors must name both. Readers accept the plan's single object.
2. **The name sanitiser keeps non-ASCII characters** (letters of any script, combining marks, emoji) and applies the plan's allow-list to ASCII only; it removes control, odd-space and invisible characters. A strict "letters and digits" class is not available identically in Rust (no new crate) and TypeScript, and would break Thai and Hindi names apart. The result still meets OneDrive's rules.
3. **The 4-hex tag comes from the device id** (its last hex digits), with two fallback tags when another device's note already has the name.
4. **Rust composes the note's JSON** (the heartbeat runs without the page), not TypeScript — an exception to phase 1 ground rule 0.1, limited to note files.
5. **A quiet (stale) editing note leaves the tab editable** and offers [Edit here] as an explicit take-over; simply typing takes over too (the claim names the quiet claim). Plan §6.5 lists [Edit here] for a stale note while §6.3 says the tab stays editable; both hold this way.
6. **Waiting is cut to 20 s when the announcing note was already old at first sight**, so the leftover note of a crashed computer cannot make every opening of the file wait 2 min.
7. **Idle notes are refreshed every 6 h**, and **the 24 h cleanup is "bytes unchanged for 24 h by this computer's record"** — one rule for abandoned editing notes, abandoned idle notes, conflict copies and notes whose document is gone. (The plan removes the last kind at once; here they wait 24 h too, because "document gone" cannot be told from "document not synced yet".)
8. **After the observer wakes up, a clean tab that would be read-only is conservatively read-only ("Checking who is editing…") for one listing, at most 15 s**, instead of an undefined in-between state.
9. **The file-provider attribute is not used for cloud detection** (it needs native code); the folder rules, Dropbox's `info.json` and the "another computer in the history or a note" rule cover it. A cloud folder outside the listed roots gets notes as soon as a second computer shows up, or with **Always**.
10. **Release on blur / tab switch applies to clean tabs** (the 30 s after a save, or after Edit here without edits). A tab with unsaved changes keeps saying `editing` — that is the fact the other computers need; without input it goes quiet after 5 min and nobody is held up.
11. **A tab restored with unsaved changes writes `editing` at once** (it has unsaved changes), although nothing was typed in this launch.
12. **Debug builds write notes only under `LAS_NOTE_ROOTS`**, so a development app can never leave a note beside a real file.
13. **The per-file setting is a dialog** (File menu → Show Others When I'm Editing…) with the default in Settings; it is stored in this computer's own records, not in the file (each computer decides for itself).
14. **`reloaded` toasts give way to the status line only where a note of another computer exists**; a file replaced by other means (copied over, no notes) still shows the toast.
15. **The duplicate-identity check is narrow**: it reacts to a second *running* app with my device id (a seq that grows under another session id), not to a leftover that never moves — which is the normal picture after a crash.
16. ~~**Known short flicker**~~ (removed by the fixer, see §5 "CHANGED BY fixer" 2): when the editor saves and the document reaches an observer before the editor's rewritten note does, the observer now stays read-only for up to 30 s while that note is on its way.
17. **The grid has no redo**, so "undo/redo" in the read-only list means: undo in the grid, undo and redo in the Scratchpad. There is **no name field** in the editor since phase 1 (the name is the file name); the store's `setName` is guarded all the same.
18. **Keeping selection and scroll by row / column id during a live refresh** (plan §9.2) is still not in this phase (narrowed out in phase 2 §9.7); a read-only viewer keeps its scroll position by index.
