# Graphs: analyses as files, with versions, combining and check-out editing — final plan (v2)

Planning only. Nothing in the repo was changed, built or run for this revision.

## 0. Basis

- **Verified (by the research and critique passes, read-only in the repo):** all code references (store shape, synchronous setters, normalisation effect, scratchpad session rebuild rule, no menu / no close handling in `lib.rs`, port 8765 hard-coded in debug, stale `Cargo.lock` containing zip 4.6.1 / sha2 0.10.9 / uuid 1.22.0, CI matrix).
- **Verified on this Mac only:** Dropbox is a File Provider domain on the local APFS volume; Dropbox conflicted-copy naming; Dropbox syncs dotfiles and `*.lock`.
- **Documented by vendors / reported (URLs in section 16):** ignore lists, conflict behaviour, latency figures.
- **Assumed, to be proven by the phase 0 spikes:** Cmd+Q / Cmd+W routing through a custom menu on tauri 2.10.3; `RunEvent::Opened` on 2.10.3; macOS privacy prompts for cloud folders; rename-over inside a File Provider folder; that the in-use note name syncs on each service; watcher events for remote changes (not relied on).
- **Not tested anywhere:** Windows, Linux, iCloud Drive, OneDrive, Google Drive.
- I did not re-read the code for this revision; where two critiques disagreed I chose and say so in section 15.

### What changed from v1 (summary)

1. Re-cut around the primary use (one person, same cloud file, several own computers). Change detection, the journal and a lossless conflict choice move into the first file release.
2. The in-use note becomes a **per-device beacon** that states facts ("open here, on version X, editing or not"). Editability is derived from the current set of beacons, so arrival order no longer matters. The request / hand-over handshake is deferred; "Edit here" is instant.
3. No edit is ever gated on disk or network. Read-only is a synchronous flag kept current by a poll.
4. Local state is keyed by a per-document local key and path, never by `analysis_id` alone (two files may share an id).
5. Rollbacks are never auto-reverted; rename-follow never adopts a copy; combining produces the same result id on every computer.
6. Combining ships at section level first, cell level later. Row and column ids are in the file from day one.
7. Fewer new dependencies: no `notify`, no `trash`, no single-instance plugin until the Windows pass.

## 1. File format

### 1.1 Extension — decision D1

- Recommended **`.lag`** ("Lab Analysis Graph"): three letters like `.mpf`; no fileinfo/filext entry found; no registered macOS type on this Mac.
- Alternative `.lasg` (no hits either; reads better; close to LiDAR `.las`).
- One constant in Rust and one in TS; changeable until phase 1 ships. Magic string in the file is `LASGRAPH1`, independent of the extension.
- In-use note: `.laguse` (section 6). Not registered as a file association.

### 1.2 Container

ZIP, written whole on each save. Never SQLite in a synced folder.

```
mimetype                 stored, first entry: application/vnd.labanalysissuite.graph+zip
manifest.json            identity + revision history + pointers
parts/<sha256>.json      content-addressed section blobs (canonical JSON, deflated)
preview.png              optional (phase 5)
ZIP comment              LASGRAPH1 <analysis_id> <head_revision_id>
```

The comment is a **hint** for cheap scans (Locate, sibling scan). It is never trusted alone for a save decision (section 7).

### 1.3 manifest.json

```jsonc
{
  "format": "lasgraph",
  "format_version": 1,
  "min_reader_version": 1,          // bumped whenever a release adds a field an older app would drop
  "features": 1,                    // 1 = files; 2 = shows who is editing (beacons); lets a newer app warn about an older peer
  "app": { "name": "Lab Analysis Suite", "version": "…", "platform": "…" },
  "analysis_id": "a-<uuidv4>",
  "forked_from": null,              // { analysis_id, revision_id } when made a separate analysis
  "created": { "time": "…Z", "user_name": "…", "device_id": "d-…", "device_name": "…" },
  "template": "column",
  "head": "r-…",
  "revisions": [
    { "id": "r-<ulid>",             // merge revisions: "r-m-" + first 26 hex of sha256(sorted parents + content_hash)
      "parents": ["r-…"],           // 0 root, 1 save, 2 combine
      "time": "…Z",                 // display only; never used to decide anything
      "user_name": "…", "device_id": "d-…", "device_name": "…", "session_id": "s-…",
      "app_version": "…",
      "kind": "save",               // save | merge | restore | import
      "summary": "Data: 12 cells. Figure: title.",
      "sections": {                 // null = snapshot no longer stored
        "table": { "part": "parts/<sha>.json", "sha256": "<sha>", "bytes": 10234 },
        "analysis": {…}, "figure": {…}, "scratchpad": {…} },
      "content_hash": "<sha256 of the four section hashes>" }
  ],
  "x": {}
}
```

- No title in the file: the display name is the file name. `name` leaves the dirty key.
- Section shapes: `table` = `GraphDoc` v2 (v1 + `row_ids[]`, `col_ids[]`); `analysis` stores `control`/`pairs` as column ids; `figure` stores per-series colour/label keyed by column id; `scratchpad` unchanged. In memory and towards the sidecar everything stays index-based; `idMap.ts` converts at load and save.
- Section blobs and `content_hash` are computed over the **normalised file form** (after migrate → defaults → normalise → id map), so opening a file can never make it differ from itself.
- When two manifests are unioned (combine, lossless conflict), a non-null section pointer always wins and the part is copied from whichever file has it.

### 1.4 Integrity

Every full read checks: ZIP opens; `mimetype`/`format` right; comment agrees with manifest; SHA-256 of every part the head references. On success Rust records `{size, mtime, whole-file sha256, head}` for that path. Any failure = "incomplete copy", never a new version, never a reason to drop the file. Text: **"Still downloading from Dropbox…"** (service name when known) with automatic retry. Read limit 64 MB.

### 1.5 Compatibility

- `min_reader_version` above the app's → open read-only: **"Made with a newer version of Lab Analysis Suite. Update to edit."**
- Unknown-field round-tripping is **deferred** (it needs a refactor of `migrateDoc`, `mergeSettings`, `sanitizePaletteFields`, `resizeSeries`, which have no tests). Rule until then: any release that adds a stored field bumps `min_reader_version`.
- Migrations run in memory; the file is rewritten only on Save.

## 2. Identity

| Thing | Form | Where |
|---|---|---|
| `analysis_id` | `a-`+UUIDv4 | in the file; shared by all copies; changes only when the user says "this is a separate analysis" |
| `revision_id` | `r-`+ULID (saves), `r-m-`+hash (combines) | in the file |
| `doc_key` | local random key per open document | session file only; keys drafts, tabs, per-path records. Two files with the same `analysis_id` have different `doc_key`s |
| `device_id` | `d-`+UUIDv4 | `device.json`, stored with a hash of a hardware id (macOS IOPlatformUUID, Windows MachineGuid, Linux `/etc/machine-id`). On mismatch: regenerate silently, keep the old id as an alias for journal lookups. No question to the user. |
| `session_id` | random per app launch | in beacons and revisions. A beacon with my `device_id` but a foreign `session_id`/`seq` = duplicate identity → regenerate `device_id` at once and tell the user. |
| `device_name`, `user_name` | text, editable in Settings | defaults: ComputerName / `COMPUTERNAME` / hostname without `.local`; OS user |

Inode, NTFS file id and xattrs are never used.

## 3. App data and registries

Location (decision D2): Tauri app-data dir (`com.zhuojianlook.analysis`), owned by Rust, overridable with `LAS_STATE_DIR`. The sidecar's `LabAnalysisSuite` folder is not touched.

```
device.json
graph-session.json        open tabs: [{doc_key, analysis_id|null, path|null, base_revision, accepted_head, active}]
graph-recent.json         keyed by PATH (analysis_id is an attribute), max 50
drafts/<doc_key>.json     {analysis_id, path, base_revision, sections, saved_at}; also for untitled documents
journal/<analysis_id>/<revision_id>.lag   every head this device has VALIDATED (saved, loaded or fast-forwarded)
journal/index.json        per (analysis_id, path): heads seen, "confirmed" flag (a descendant has been seen on disk)
displaced/                files moved aside (replaced targets, removed extra copies), kept 30 days
export-map.json           migration progress per library row
```

- Session is written at every open, close, tab switch and path change. A new untitled document gets its `analysis_id` and `doc_key` at New and is listed with `path: null`, so it is restored after a crash as "Untitled (recovered)".
- Drafts are never deleted automatically except after a verified save of that document. File → **Recover unsaved work…** lists all drafts with dates.
- Journal entries are kept until a descendant head has been observed on disk and at least the newest 10 per analysis; total cap 500 MB, oldest confirmed first.
- All writes are atomic (temp + rename).

## 4. Opening, restoring, finding

### 4.1 Typed errors

Every Rust file command is `async` and does IO in `spawn_blocking` with a 15 s timeout. Errors are typed: `NotFound`, `PermissionDenied`, `OfflineOrTimeout`, `Incomplete`, `Dataless` (online-only; found by `stat` flags before any read), `TooNew`. The poll only `stat`s; it reads only when size/mtime changed and the file is local.

- `PermissionDenied` → **"macOS hasn't allowed Lab Analysis Suite to read this folder."** [Open Privacy settings] [Retry]. Never "can't find".
- `Dataless`/pending read → **"Downloading from Dropbox…"** in the tab.

### 4.2 Startup restore (per session entry, off the UI thread)

1. Path exists, validates, id matches → open; apply the draft if present (4.5).
2. Path under a known cloud root and missing → **"Waiting for Dropbox…"** with silent retries for up to 60 s before anything else is offered.
3. Missing → same-folder search under the **safe follow rule** (5.2).
4. Else the card: **"Can't find 'Dose response'. Last seen in Dropbox › Lab."** [Retry] [Find it…]; under ⋯: **Remove from this list (the file was deleted)**. Removing keeps the entry in Recent marked missing, and keeps the draft (reachable from Recover unsaved work…).
5. Then files passed by double-click, then a stat-only check of the 20 newest Recent paths against the journal invariant (section 8).

### 4.3 Opening a file whose id is already known at another path

Recent and session are keyed by path, so nothing is re-pointed silently.

- Head is newer than my known copy → **"This is a newer version of 'Dose response' (saved by Bob, 2 h ago). [Update my file with it] [Open separately]"**. "Update" writes the result to my original path.
- Head is older → chip "Older copy" and banner: **"A newer version (saved 18 Nov) is in Dropbox › Lab. [Open that one] [Keep working here]"**.
- Same head or diverged, and not a sync-conflict name → the copy question (4.4).
- File is in a temp / Mail attachment / Downloads / read-only location → **"This file is in a temporary folder. Choose where to keep it before editing."** → Save As with "same analysis" preselected.

### 4.4 Two files, one id (the Finder-duplicate / template case)

When a second file with the same id is first seen (same folder, or opened), and its name does not look like a sync conflict copy and it was not produced by this session's own conflict handling, ask once, before any combine offer:

**"'Exp 2' started as a copy of 'Exp 1'. Is it a separate analysis, or another copy of the same one?"** [A separate analysis] [The same analysis]

- "Separate" writes a new `analysis_id` with `forked_from` at once. Beacons, drafts and combine offers no longer connect the two.
- "Same" records the pair in the per-directory copy table (5.2) and proceeds to the sibling rules (9.4).
- File → **Duplicate as a new analysis…** is the supported template route.

### 4.5 Drafts on open

- Draft base equals the file head → restore as unsaved changes.
- Draft base is an ancestor of the head → restore as unsaved changes on the old base; the normal "newer version on disk" flow follows (section 9).
- Draft base is not in the file's history (rollback, replaced file) → **"You have unsaved changes from 12 Nov that don't match this file. [Open them as a new analysis] [Compare] [Discard]"**. Never dropped silently.

### 4.6 Find it… (Locate)

1. User picks a folder. Rust walks it: depth ≤ 8, ≤ 50,000 entries, ≤ 20 s, skipping hidden folders, `node_modules`, `.git`, bundles, symlinks, and folders returning permission errors (reported at the end). Cancel + live count.
2. Only files with our extension; online-only files are counted, not read.
3. Local candidates: read the comment (last 64 KB), then validate matches fully.
4. One match → reopen. Several → list (path, last saver, when), newest head preselected. None but N online-only → **"N files haven't been downloaded to this computer yet. Download them to check?"** (the download step ships in phase 5; before that the text names the files). None → **"Not found in this folder."** [Choose another folder].

## 5. Change detection and rename tracking

### 5.1 Polling (no watcher crate in the first releases)

One Rust timer thread: every 3 s for the active tab, 10 s for other open tabs, immediately on window focus and after a detected sleep gap. Per open file: `stat` the path, list the parent directory for `*.lag` and `*.laguse` (cached by name/size/mtime; only changed entries are re-read). Emits `graphfile://changed | moved | missing | sibling | presence`. A file is examined only when stable (same size/mtime on two looks 300 ms apart) and fully valid. Own saves are recognised by revision id. `notify` can be added behind the same events later if measurements justify it.

### 5.2 Safe follow rule (rename in the same folder)

Sync clients often apply an update as delete + create, so a missing path proves nothing.

- "Missing" is confirmed only after the path is absent on two consecutive polls (≥ 5 s).
- A per-directory **copy table** records every same-id file ever seen coexisting with the tracked path. Such a file is never a rename target.
- Follow silently only when there is exactly one candidate, it is not in the copy table, and its head equals or descends from the tab's revision. Toast: **"Renamed to 'Dose response v2'"**. The owner renames its own in-use note to match.
- Several candidates, or an older/diverged head → chooser.
- Moves to another folder: also look in folders of other open tabs and Recent; otherwise the tab shows **"'Dose response' is no longer in Dropbox › Lab (moved or deleted, possibly on another computer). Your work is still here."** [Find it…] [Save a new copy here]. The document stays open and editable in memory.
- A different `analysis_id` appearing at the path is never adopted.

## 6. Check-out editing (the in-use note)

### 6.1 Principles

- The note is a courtesy. Safety is the save check, the sibling scan, the journal and combining (sections 7–9).
- Nothing is decided by comparing clocks of two machines.
- One note per device; a device writes only its own. Notes state facts; nobody "wins".
- Nobody with unsaved edits is ever frozen. No keystroke waits for disk or network.

### 6.2 Beacon file

Written while a file is open on a device **and shared editing is on for that file** (6.8). Deleted on tab close and quit.

Name: `<document stem> (in use on <device name>, <4 hex>).laguse`, sanitised to letters, digits, space, `-`, `()`, `,` (safe for OneDrive's character rules; no leading dot, `~`, `.tmp`, `.lock`). Matched by content, not name. First line of the file is plain text: `Lab Analysis Suite note: shows who has this analysis open. Safe to delete.` followed by JSON:

```jsonc
{ "format": "lasgraph-presence", "v": 1,
  "analysis_id": "a-…", "document_name": "Dose response.lag",   // applies only to the file with this name, or to the only file with this id in the folder
  "device_id": "d-…", "session_id": "s-…", "device_name": "Mac mini", "user_name": "Zhuo",
  "state": "idle",              // idle | editing     (reserved: requesting)
  "head": "r-…",                // last head this device wrote or validated
  "base_revision": "r-…",       // when editing: the head the unsaved edits are based on
  "epoch": 3,                   // +1 on each new claim
  "seq": 41,                    // +1 on every rewrite while editing (heartbeat)
  "supersedes": null,           // { device_id, epoch } when "Edit here" was used over someone's claim
  "updated_at": "…Z",           // display and leniency only
  "request_to": null, "handover_to": null,   // reserved for the later hand-over feature
  "features": 2 }
```

Writes: once on open (`idle`), on every head change (one small write per save), on claim, on heartbeat, on release. Several files per `device_id` (conflict copies of a note) are tolerated: highest `seq` wins.

### 6.3 How a tab decides what it is

From the set of beacons for this document (other devices only), with `D` = my disk head:

1. **Waiting for a newer version:** some beacon declares a `head` I do not have in my history. Tab is read-only: **"Mac mini saved a newer version — loading it…"**. Ends when the head arrives, or after 2 min of my own time (then editable with **"Couldn't confirm the newest version yet."**).
2. **Read-only:** a *fresh* `editing` beacon whose `base_revision` equals `D` (or is unknown to me → rule 1), not superseded by a later beacon.
3. **Information only:** an `editing` beacon based on an older revision than `D`, or a stale one: **"Alice has unsaved changes on MacBook-Pro from Fri 18:02; they will be combined when she saves."** Tab stays editable.
4. Otherwise **editable**.

Because this depends only on current contents, the order in which a note, a deletion and the document arrive does not matter.

Freshness (observer side, own suspend-aware time):
- First sight of a beacon: if its `updated_at` is more than 10 min old by my clock → stale at once (a wrong clock can only make editing available sooner). Otherwise fresh for 90 s pending a `seq` change.
- Afterwards: stale after 5 min without a `seq` change (3 missed 60 s beats + slow-service latency + margin).
- After a detected sleep gap on the observer, every observation becomes "re-checking" for one poll cycle, never "fresh".

### 6.4 Claim, heartbeat, release

- **Claim:** a store subscription sees the clean → dirty transition and asks Rust to write `state: editing, base_revision, epoch+1`. Load, live refresh and normalisation happen inside the store action before the baseline is taken, so they can never cause a claim.
- **Heartbeat:** Rust thread, every 60 s while editing and there was input in the last 10 min.
- **Release (decision D6):** on Save the beacon gets the new `head` immediately; `state` returns to `idle` after a short linger — 30 s without further input, or at once on tab close, quit, or window blur. This stops other computers flickering between read-only and editable when the user saves every minute and keeps typing. Discard/Revert also releases.
- **Quit / crash:** quit deletes own beacons (also as a backstop in `ExitRequested`/`Exit`). After a crash the beacon stays; others treat it as stale by 6.3; on next start this device rewrites it.
- **Cleanup:** any device may silently delete a foreign beacon it has judged stale for 24 h, and beacons whose document is gone.

### 6.5 What the other computer shows

- Read-only, same `user_name` as mine: **"You have this open on Mac mini (office) with changes not yet saved there. [Edit here] — both sets of changes will be combined when that computer saves."**
- Read-only, someone else: **"Alice is editing on MacBook-Pro (note updated 2 min ago). You'll see her changes each time she saves."** [Edit anyway…] → confirm **"Alice may have unsaved changes. If you both edit, the two versions are combined on save. Continue?"**
- Stale: **"Alice started editing on MacBook-Pro on Fri 18:02 and may have unsaved changes there. [Edit here]"**
- Status line instead of per-save toasts: **"Up to date · Alice saved 2 min ago"**.
- Read-only blocks only changes to saved content. Copy, export, tabs and view controls stay enabled. Chip "Read-only" beside the name; an edit attempt shows the banner's action.
- Peer runs an older app without beacons (`features` < 2 in its last revision): **"The other computer runs an older version that doesn't show who is editing — update it."**

**Edit here / Edit anyway** is instant: my beacon becomes `editing` with `supersedes: {their device_id, their epoch}`.

### 6.6 Two editors at once

Happens when both started inside the sync delay, when one was offline, or after Edit here. Neither beacon is deleted; no winner is computed.

- Both editors see: **"Also being edited on MacBook-Pro (Alice). Nothing is lost — the two versions are combined when you save."** [Keep editing] [Save my changes as a separate copy…]
- A third, clean device sees read-only with both names.
- Whoever saves second goes through combining (section 9).

### 6.7 Sleep and wake (fencing)

- Gap detection: the heartbeat/poll timer fires more than 90 s late by wall clock on this machine → the computer slept (no OS notification API needed; OS notifications can be added).
- After a gap while holding a claim: stop beating, mark the claim "resuming", show **"Checking for changes made while this computer was asleep…"** for 45 s or until a newer head / superseding beacon appears. Save and the first new edit ask for confirmation during the window.
- A holder that sees a beacon superseding its claim yields at once: **"You continued on MacBook at 19:40. Your unsaved changes here are kept and will be combined."**
- If nothing appeared, re-claim with a new epoch.

### 6.8 Where notes are written — decision D3

Per-file setting **"Show others when I'm editing this file: Automatically (in cloud folders) / Always / Never"**, default Automatically: on when the path is under a known cloud root (macOS `~/Library/CloudStorage/*`, `~/Library/Mobile Documents`, file-provider attribute; Windows OneDrive env paths, Dropbox `info.json` roots, Google Drive mount) or when the file's history or a beacon shows more than one device. A purely local file gets no note files. Help text mentions Dropbox's own "Lock editing" (paid plans) as an optional extra.

### 6.9 Deferred: request to edit / hand-over

Not in the first check-out release: with instant "Edit here" it adds a multi-state handshake over a channel with 5–60 s per leg, and for one person on two computers nobody is there to answer. Fields are reserved. If added later: requests judged by the same observer-side staleness; a request is ignored unless its target is still `editing`; a grant expires after 90 s if the grantee has not claimed.

## 7. Save

Save is explicit. Before any save, compare, combine, replace, draft write or tab switch: `flushScratch({commitEdit:true})`.

1. TS builds the section blobs (normalised file form), the new revision, and the unioned manifest. If `content_hash` equals the base's, stop.
2. Identity assertion: the store's `analysis_id` and `doc_key` must match the target path's record, or the save is refused.
3. Rust, under a per-path mutex, `graphfile_save(path, expected_head R, …)`:
   1. **Check.** `stat`: must be local (not online-only). If size and mtime equal the record from the last validation → head is R. Otherwise re-validate fully; valid with head R → go on; valid with another head → `Conflict{head}`; invalid → `Incomplete` (retry up to 10 s). Path gone → run the safe follow rule inside the command; found → save there; else `Missing`.
   2. If the head cannot be established (offline placeholder, still incomplete) → do **not** overwrite: write `<name> (unsynced from <device>).lag` beside it with the same id, journal it, return `SavedAside`. The sibling rules combine it later.
   3. Build the ZIP in memory (kept parts copied byte-for-byte).
   4. Write `.~<name>.<rand>.tmp` **in the same folder** (ignored by Dropbox, OneDrive and iCloud per their lists), fsync (`F_FULLFSYNC` on macOS). One strategy only.
      *Phase 0 spike (Dropbox 280.4):* `.~` temps are ignored without error and a rename-over keeps the Dropbox item id, even after a 12 s wait. A dot-temp without `~` that sits for 10 s is uploaded and the rename-over replaces the item id. **Never** a bare `~` prefix with a `.tmp` ending (`~x.tmp`, `~x.lag.ab12.tmp`): Dropbox reports "Can't sync with this filename". Rename straight after the fsync.
   5. *(Phase 0 spike: a hard link from a Dropbox file to a folder outside Dropbox works, keeps the old bytes after the rename-over and leaves the item id unchanged.)*
   5. Hard-link (else copy) the current target into `displaced/`, re-`stat` it against step 1, then rename the temp over the target. Windows sharing violation: retry 5× over 2 s; then report "couldn't replace the file, it's in use" (draft and temp intact).
   6. Read the displaced copy's head. If it is not R (a remote save landed in the gap) → journal it and report `SavedButDisplaced{head}` → combine flow.
   7. Re-open and validate; copy to the journal; update the validation record.
4. TS: mark saved, clear the draft, update session/Recent, update the beacon, run the sibling scan. Orphan temp files older than 10 min are deleted on open.

**When Save meets a newer or different file** (`Conflict`):
- First the working copy is written to the journal as a real revision.
- Different sections changed and nothing needed repair → combined and saved in one step (two parents). A banner stays until dismissed: **"Saved, combined with Alice's changes (Figure: title)."** [What changed] [Undo]. Undo = a new revision restoring my pre-combine version; hers stays in history.
- Otherwise a blocking sheet: **"Not saved yet — Alice also changed this file. Choose what to keep."** The tab shows "Not saved" until resolved; an OS notification is sent if the window is in the background.
- Before combining exists (phase 1) the sheet offers: **[Keep mine (theirs is kept in history)]**, **[Use theirs (mine is saved as a copy)]**, **[Save mine as a separate copy]**. There is no destructive Overwrite: "Keep mine" unions the histories and keeps their head's snapshot as a side branch.

### 7.1 Save As — decision D7

After the user picks the location: **"Is this a new analysis (for example a new experiment based on this one), or the same analysis in a new place?"** Preselected: *new analysis* normally; *same analysis* when the source is in a temporary folder or was just received. "Same" keeps the id; "new" mints one with `forked_from`. Safety net: files related by `forked_from` are offered **"This is based on your 'Dose response' — combine the changes?"** when opened together.

### 7.2 History kept in each file — decision D4

- Revision metadata: forever.
- Full snapshots: the head; the last 20 revisions; both parents of every combine; any revision whose child was made on a different device (the points where work passed between computers) for 180 days of locally observed time; any head declared in a live beacon; any head this device's journal holds unconfirmed.
- No byte budget in v1. Retention is by count and by when this device first saw a revision, never by the revision's own timestamp.
- Versions panel says where full copies stop: **"Older versions are listed but can no longer be opened."**

## 8. The journal invariant (lost-save recovery)

For every (analysis, path) this device knows: **the head on disk must descend from every head this device has journaled for that path.** Checked on open, on every poll change, on reappearance, and at startup for recent files.

| On-disk head vs my journaled head J | Meaning | Action |
|---|---|---|
| descends from J | normal | mark J confirmed |
| strict ancestor of J | rolled back (cloud version history, or an old copy put in place) | banner, no automatic action: **"This file was put back to an earlier version (12 Nov, saved by Bob). [Use the earlier version] [Go back to my latest]"**. The choice is stored as `accepted_head` so it is not asked again; dropped revisions are carried into history at the next save. |
| diverged from J | a save was replaced by another computer's (iCloud, probably Google Drive) | **"Another computer saved over your last save. Nothing is lost — combining both now."** → combine with the journal copy |

This is the only recovery path that works on all four services without native code. It also applies to heads authored by others that this device loaded.

## 9. Versions and combining

### 9.1 Relations (R = tab's base, H = head on disk)

| Relation | Clean tab | Tab with unsaved edits |
|---|---|---|
| H = R | nothing | nothing |
| H newer | reload in place (9.2) | banner **"Alice saved a newer version. [Combine my changes with it] [Later]"**; Save does the same. Phase 1–2: **[Save my version as a copy]** instead. |
| H older | rollback banner (section 8) | same |
| diverged | combine | combine, mine = working copy |

### 9.2 Reload in place (`replaceContent`)

- Takes `(doc_key, expected_base, expected_edit_serial)`; applies only if all still match at commit, else falls into the unsaved-edits path. Content and `base_revision` are set in one store update.
- Steps: flush scratchpad; run the load pipeline (migrate → defaults → normalise → id map) and take the baseline afterwards; clear the table undo stack (or leave one labelled step **"Undo: combine with Alice's changes"** after a combine); leave `scratch` untouched when its hash is unchanged so the sheet session survives; when it changed, rebuild the session and carry over scroll/selection; a content serial stops an old session writing over replaced text.
- Not applied while a cell editor, drag selection, menu or export is active — queued. The old figure stays with an "updating…" veil. Selection and scroll are anchored by row/column id.
- `docSerial` is not bumped.

### 9.3 Combining (`graphMerge.ts`, pure TS)

- **Base:** lowest common ancestor with a stored snapshot, looked for in both files **and the local journal**; else nearest stored common ancestor; else two-way.
- **Same pipeline for base, mine and theirs** before comparing, so different app versions cannot create differences nobody made. Section hashes are only an "identical, skip" shortcut.
- **Deterministic result:** a clean combine gets id `r-m-<hash(sorted parents + content_hash)>` and no device-specific content, so two computers combining the same pair produce the same revision. Before auto-writing, wait a device-ordered delay (2–10 s from `device_id`) and re-check whether the result already arrived.
- **Auto-apply only when** the two sides changed different sections and no automatic repair ran. Anything else shows a summary or the dialog.

Granularity by phase:

- **Phase 2 — section level.** Sections changed on one side only combine automatically. Same section changed on both → pick per section: Mine / Theirs, or **Keep both as separate files**.
- **Phase 4 — fine level.**
  - Data table: rows/columns by id (insertions united; a deletion wins unless the other side edited inside → conflict; same-place insertions ordered by `device_id` and flagged "row order — please check" for paired and XY tables); cells keyed `(row_id, col_id, replicate)`; titles and X by id; trailing blank rows ignored; `n_rep` larger wins unless values would be dropped. Conflicts shown per row.
  - Analysis: per field; `pairs` as a set of column-id pairs.
  - Figure: per field with atomic groups (palette group + series colours; width+height+dpi; y_min+y_max).
  - Scratchpad: cells by address, after a shift check (>30% of base cells changed on one side, or content reappearing at a constant offset → whole-section choice: Mine / Theirs / Both side by side).
  - Afterwards `normalizeAnalysis`, `effectiveAnalysis`, `resizeSeries`; anything they change is listed under "Adjusted automatically" and forces a review.
- Two-way (no common version left): whole-section choices with **"These two copies were last the same too long ago to compare cell by cell. Keep: [Mine] [Bob's] [Both as separate files]"**.

**Dialog:** header "Two versions of 'Dose response' changed since Tue 10:14" (mine: this Mac; theirs: Alice, MacBook-Pro); section list with chips (combined / n to choose / unchanged); side-by-side pane; collapsed "Combined automatically (17)"; footer [Cancel] [Keep both as separate files] [Apply]. Nothing is written until Apply. Several copies are handled one at a time: "Copy 2 of 3".

### 9.4 Extra copies in the folder (sync conflict copies)

Found by content (same id in the comment, then validated), on open, save and poll. Names only label the source. After the copy question (4.4) where it applies:

- Copy's head is an ancestor of or equal to mine → **"'… (conflicted copy)' is an older copy of this analysis."** [Remove it] [Keep].
- Newer or diverged → **"A second copy of this analysis has changes by Bob (iMac)."** [Combine…] [This is a different analysis] [Later]. Phase 1 only warns.
- **Which file survives** is the same on every computer: the shortest file name, ties alphabetical (conflict copies always have longer names). The tab re-points to it if needed.
- **Remove** moves the file to app-data `displaced/` (kept 30 days), and only if, re-read immediately before, its head is an ancestor of or equal to another same-id file on disk. No automatic deletion in any phase.

### 9.5 Versions panel

- Side panel (clock button). Rows newest first with an SVG lane graph like `git log --graph`: a dot per saved version, lines to parents, a second lane where two computers worked separately, lanes joining at a combine; one colour per device.
- Row: summary · name · computer · time as seen locally ("2 h ago"; a date when older than a day). Chips: Current, Combined, Brought back, From old library, "Too old to open".
- Extra copies and separated analyses appear as dashed branches labelled with their file names.
- Select a row → read-only preview and **Compare with current**. **Bring this version back** makes a new version with that content (history is never rewritten). **Save this version as a new analysis…**.
- Phase 2 ships the panel with the lane graph (the user asked for the tree specifically); the SVG lane layout is about 2–3 days.

## 10. Store and UI changes

- `graphStore`: `currentId` → `file {doc_key, analysis_id, base_revision, path}`; `readOnly`, `diskHead`, `presence` as synchronous state fed by the poll; `editSerial`; `replaceContent`; `load`/`replaceContent` run defaults + `normalizeAnalysis` + graph-type repair **inside the action before the baseline**, replacing the effect at `GraphView.tsx:326-331`. No `origin` flags.
- Mutators check `readOnly` synchronously. Read-only is also enforced in `SheetSession`'s edit entry point (reusing its `{ok:false, reason, message}` result), the scratch controller (`clearAll`, `openSend`), DataGrid and the settings panels (≈2–3 days on its own).
- **Tabs (decision D5):** a tab strip, but only one document lives in memory. A background tab is "closed with its draft on disk": switching flushes the active draft, then opens the other through the normal path. Cost: stats and plot recompute and undo resets on switch. Rust keeps polling and heartbeating for all open tabs. Cap 12.
- Tab strip (name, unsaved dot, read-only / warning icons), title with folder line and Reveal, File menu (New, Open…, Open Recent, Save, Save As…, Duplicate as a new analysis…, Close Tab, Versions, Recover unsaved work…, Export library to files…), Recent files in place of the library, one banner slot (order: permission → downloading → missing → not saved/conflict → extra copy → who is editing → newer/older version).
- **Quit and close.** A custom app menu built in `setup` replaces the predefined Quit and Close Window with items that emit to the frontend (Cmd/Ctrl+Q, Cmd/Ctrl+W = Close Tab). The red button / Alt+F4 and the updater's restart go through the same routine: flush scratchpad and drafts synchronously, then **[Save all] [Quit and keep unsaved changes for next time] [Cancel]** (keeping is the default; Discard exists only per tab), release beacons, exit. Save all stops at a tab that needs a choice and focuses it. Next start: **"Unsaved changes from yesterday restored."**
- **Settings:** Your name; This computer's name; Show others when I'm editing (default).
- **`FileBackend` TS interface** (read, save, header, scanDir, session/draft/device, subscribe) with a Tauri implementation and an **in-memory implementation** that has scriptable "other devices", delay and conflict modes. The browser preview and vitest use the in-memory one, so tabs, banners, combine dialog and read-only can be exercised without Tauri.

## 11. Where each piece lives

| Piece | Where |
|---|---|
| Container read/write, validation record, save, journal, displaced, scan, locate | Rust `src-tauri/src/graphfile.rs` (all `async` + `spawn_blocking` + timeout, typed errors) |
| Poll thread, beacons, heartbeat, gap detection | Rust `graphwatch.rs`, `presence.rs` |
| Session, Recent, drafts, device identity, export map | Rust `appstate.rs` |
| Menu, quit routine, `RunEvent::Opened` buffer + `take_pending_opens` | Rust `lib.rs` |
| Format, id map, revisions, combine, summaries | TS `src/components/graph/file/` (pure, tested) |
| Stores, `FileBackend`, UI | TS |
| Python sidecar | unchanged; library endpoints kept for export and "Old library" |

**Dependencies.** First, in its own commit: regenerate and commit `Cargo.lock`; then add `--locked` to CI. Then: `zip = "~4.6"` (already in the lock via the updater; default features off + deflate, check feature unification), `sha2 = "0.10"`, `uuid = "1"` with `v4` (both already in the lock). **Not added now:** `notify`, `trash`, `tauri-plugin-single-instance` (Windows pass). JS: no runtime dependency; dev-only `vitest`. No capability change expected (custom commands + events), to be confirmed in the spike.

**Debug builds:** read `LAS_SIDECAR_PORT` and `LAS_STATE_DIR`; when unset in dev, fail loudly instead of using 8765.

**File association** (macOS in phase 1; Windows/Linux in phase 5): `ext ["lag"]`, role Editor, rank Owner, MIME `application/vnd.labanalysissuite.graph+zip`, exported type `com.zhuojianlook.analysis.graph` conforming to `public.data` + `public.content` (not `public.zip-archive`). Check that the entry survives CI's re-sign and hand-built DMG, and that the CI certificate secret is set (ad-hoc signing would make macOS privacy grants reset on every update).

## 12. Migration

- First launch with a non-empty library: a small badge and File → **Export library to files…** (no blocking launch dialog). Dialog: **"Analyses are now saved as files. Export your N saved analyses to a folder?"**
- Frontend-driven via the existing `GET /api/graph/library` and `/library/get?id=` plus the Rust save. No Python change.
- `export-map.json` records per library row: saved time → `analysis_id`, exported path, status. A re-run exports only what is missing or failed: **"12 of 15 exported. 3 failed: [reason]. [Try again]"**. No duplicate look-alike files.
- One root revision `kind: import`; row/column ids minted once here.
- The old localStorage draft is applied on top of its exported file as unsaved changes (or opened as untitled if it had no library row) and kept until explicitly recovered or discarded.
- The SQLite database is never modified or deleted. "Old library…" stays reachable as long as it holds any unexported analysis. Closing text: **"Your analyses are now ordinary files in Dropbox › Lab. The old in-app list is kept unchanged as a backup."**

## 13. Tests

- **vitest (scratch copy / CI, never in the Dropbox repo):** combine fixtures and properties (merge(b,x,b)=x; merge(b,x,x)=x; symmetric when conflict-free; same result id from both sides); revisions (ancestor, common ancestor, union with non-null pointer winning, retention rules); id map; every structural table edit keeps ids aligned; **open or replaceContent of every fixture leaves the tab clean**; an edit interleaved between read and apply is not lost; undo after replace does not remove remote changes.
- **`cargo test`:** container round trip; truncated / corrupt / comment-says-R-but-bytes-differ rejected; save check refuses a changed head; interrupted write leaves the old file; displaced-file detection; safe follow rule (delete-then-create with a conflict copy present must not re-point); Locate bounds; presence rules with an injected clock including sleep on observer and holder.
- **In-memory multi-device scenarios** (FileBackend simulator; conflict modes Dropbox / OneDrive / silent last-writer-wins; delays 0 s, 5 s, 60 s, offline; partial delivery; delete-then-create; in-place partial overwrite; note before document and document before note; wake-before-sync; rename-versus-edit split; duplicate device id; ±2 h clock skew). Assertions: no revision is ever lost; all devices end on the same head; at most one combine revision per pair of heads; no file is removed unless its head is an ancestor of a surviving file.
- **Phase 0 spikes (about an hour each, throwaway app in the scratch folder):** custom menu Quit / Close Tab and updater restart on tauri 2.10.3; `RunEvent::Opened` cold and warm; privacy prompts on a clean macOS account (Documents, Dropbox); same-folder temp + rename inside Dropbox (conflict copies? version history kept?); does the chosen note name sync.
- **Manual on real services** — Dropbox with two computers first, then iCloud Drive, OneDrive, Google Drive, then Windows: save-to-visible time; two near-simultaneous saves; rapid saves; note syncing; online-only files. Results set the final poll, heartbeat and staleness numbers.

## 14. Phases

Sizes: S ≈ days, M ≈ 1–2 weeks, L ≈ 2–3 weeks. Each phase is releasable to Experimental. From phase 1 on, using one Dropbox file from two computers is safe (nothing lost), from phase 2 comfortable, from phase 3 it has the read-only behaviour.

| Phase | Content | Size | After it |
|---|---|---|---|
| **0 Groundwork** | Fresh `Cargo.lock` + `--locked`; vitest; row/column ids + id map; normalisation moved into `load`; `name` out of the dirty key; `FileBackend` interface + in-memory backend; the five spikes. | M | No visible change. |
| **1 Files** | File format; Rust read / validate / save with the full check, journal of every validated head, displaced copies; device identity + Settings; Open / Save / Save As / Duplicate / Close; tabs (one in memory); Recent; per-document drafts incl. untitled; session restore with waiting / missing / permission cards; bounded Find it…; 3 s poll with reload-when-clean, safe rename follow, journal invariant banners (rollback, replaced save → "saved as a copy"), extra-copy warning and the copy question; lossless conflict sheet; custom menu + quit routine; macOS file association and double-click; library export. | L+ (3–4 weeks) | Requirements 1–5 and the simple half of 6; migration. |
| **2 Versions and combining** | Versions panel with the tree and Bring back; section-level combining with deterministic ids; combining extra copies and journal-recovered saves; newer-version banner with Combine; Remove extra copy; retention rules. | M–L | Requirement 6 in full; safe and comfortable on all four services. |
| **3 Check-out** | Beacons, heartbeat, read-only everywhere incl. scratchpad, live refresh, Edit here / Edit anyway, both-editing banner, sleep/wake fencing, save linger, the "show others" setting, older-peer warning. | M | "Read-only on the other computers until I save." |
| **4 Fine combining** | Cell-level table, per-field settings, scratchpad cells with shift check, full combine dialog. | M–L | Fewer whole-section choices. |
| **5 Later / optional** | Request-to-edit hand-over; `notify` watcher; download-to-check in Find it…; `preview.png`; Windows/Linux association + single instance + Windows pass; byte-budget pruning; unknown-field round trip; OS thumbnails. | each S–M | |

## 15. Disposition of every critique finding

**Concurrency**
- C1 rename-follow adopts a copy — **Accept**: safe follow rule and copy table (5.2), also at startup and inside Save.
- C2 non-converging merges / mutual trashing — **Accept**: deterministic combine id, ordered delay, shortest-name survivor, removal only of ancestor-or-equal files, moved aside rather than trashed, never automatic (9.3, 9.4).
- C3 save check trusts the comment — **Accept**: validation record + full re-validation; never overwrite when the head can't be established; save aside (7).
- C4 waking holder revives a dead claim — **Accept**: `supersedes` fencing, gap detection, catch-up window (6.7). Gap detection by timer lateness rather than OS notifications (simpler; notifications optional).
- C5 journal misses closed files / others' saves — **Accept**: journal every validated head; invariant per (analysis, path); checked at startup for recent files (3, 8).
- C6 release by deletion is order-sensitive — **Accept**: persistent beacons with declared head (6.2, 6.3). Consequence: a note file is visible while the file is open in a cloud folder, not only while editing (decision D9).
- C7 loser deletes its note — **Accept**: beacons are never deleted on yield; no winner is computed (6.6).
- C8 late-arriving claims lock everyone — **Accept**: a claim blocks only if based on my current head (6.3).
- C9 duplicate device id — **Accept**: `session_id`, self-detection, hardware-id hash (2).
- C10 gap between check and rename — **Accept in part**: hard-link/copy the target aside before the rename and inspect it afterwards (7 step 5–6); native swap primitives rejected for now (per-OS code, untested in File Provider folders).
- C11 timers pause during sleep — **Accept**: wall-clock deltas on the same machine + "re-checking" after a gap (6.3, 6.7).
- C12 reload races with an edit — **Accept**: guarded `replaceContent` (9.2).
- C13 pruning removes the merge base — **Accept**: non-null pointer wins; retention by count and local observation (1.3, 7.2).
- C14a hand-over to an absent grantee — **Deferred with the feature**; the expiry rule is recorded (6.9). C14b rollback undone — **Accept** (8).

**Data loss / UX**
- U1 Finder duplicate — **Accept**: `doc_key`, `document_name` in beacons, the copy question, Duplicate command (2, 4.4, 6.2).
- U2 journal rule undoes rollbacks — **Accept** (8).
- U3 Save As breaks email round trip — **Accept with a change**: one Save As that asks "new analysis or same analysis in a new place", plus temp-folder prompt and `forked_from` safety net (4.3, 7.1) instead of two differently named commands.
- U4 phantom edits from normalisation — **Accept**: normalise inside the load action; hash over the normalised form (1.3, 10).
- U5 undo wipes remote changes; scratchpad flush — **Accept** (7, 9.2).
- U6 leftover note shows as fresh — **Accept**: first-sight leniency from `updated_at` (6.3).
- U7 phase order — **Accept**: journal, lossless conflict choice and extra-copy warning in phase 1; `features` number (14, 1.3).
- U8 conflicted save looks saved; unreviewed auto-merge — **Accept** (7, 9.3).
- U9 drafts with unknown base; untitled recovery — **Accept** (3, 4.5).
- U10 migration stranding / duplicates — **Accept** (12).
- U11 instant Edit here for own computers — **Accept**; the "auto-yield after 2 min idle" option is **not needed** because Edit here is instant for everyone (6.5).
- U12 flicker on every save — **Accept** as the recommended answer to D6 (30 s linger).
- U13 save after remote rename recreates old name — **Accept**: follow rule inside Save; reworded dialog (5.2, 7).
- U14 opening an older copy hijacks Recent — **Accept**: Recent/session keyed by path; older-copy banner (3, 4.3).
- U15 quit guard — **Accept** (10).
- U16 keystroke lands in wrong cell after pre-edit reload — **Accept by removal**: there is no pre-edit reload; refresh applies only to clean, idle tabs and anchors by id.
- U17 pruning forces hundreds of choices — **Accept**: journal as base source, cross-device parents kept 180 days, whole-section default for two-way (7.2, 9.3).
- U18 "new computer?" prompt — **Accept**: hardware-id hash, no question (2).
- U19 wording — **Accept**: "combine", plain setting names, locally observed times throughout.
- U20 note files look like junk — **Accept**: readable name, plain first line, owner renames/removes, silent cleanup after 24 h (6.2, 6.4).
- U21 live refresh disturbs a viewer — **Accept** (6.5, 9.2).
- U22 missing card for slow cloud folders — **Accept** (4.2).

**Feasibility**
- F1 phase order and size — **Accept**: re-cut (14); phase 1 honestly sized at 3–4 weeks.
- F2 no async gate on synchronous mutators — **Accept** (6.1, 10).
- F3 normalisation / `origin` flags — **Accept**: same fix as U4.
- F4 scratchpad session does not survive replace — **Accept** (9.2).
- F5 read-only beyond the store — **Accept** (10).
- F6 Cmd+Q / Cmd+W — **Accept**; spike first (10, 13).
- F7 macOS privacy denials — **Accept**: typed errors and a dedicated card (4.1).
- F8 browser preview / two-instance test — **Accept**: `FileBackend` + in-memory backend; env vars for port and state dir (10, 11).
- F9 handshake over-built — **Accept**: deferred, fields reserved. **Rejected in part**: "note present or absent only" — the beacon keeps a declared head and idle state, because C6/C7/C8 depend on it and it costs one small write per save.
- F10 in-memory parked tabs — **Accept**: background tab = closed with draft on disk, identity assertion on save (7, 10).
- F11 drop `notify` — **Accept** (5.1).
- F12 one temp strategy — **Accept**: same folder only (7).
- F13 dependency table / unimplementable pruning rule — **Accept** (7.2, 11).
- F14 blocking reads — **Accept** (4.1).
- F15 ids now, unknown-field round trip later — **Accept** (1.5).
- F16 note naming — **Accept in part**: keep `.laguse`, readable stem, owner follows renames, cached reads, not registered.

## 16. Decisions for the user

- **D1** Extension: `.lag` (recommended) or `.lasg`.
- **D2** Where the app keeps its own records (open tabs, unsaved-work backups, safety copies): the app's own data folder (recommended).
- **D3** In-use notes: Automatically in cloud folders (recommended) / Always / Never.
- **D4** History in each file: last 20 versions openable, the list kept forever (recommended).
- **D5** Several analyses open as tabs (recommended; switching recomputes the figure) or one at a time.
- **D6** When others can edit again: 30 s after Save without further typing, or at once on close / switching away (recommended); or strictly the moment Save is clicked; or only when the file is closed.
- **D7** Save As asks "new analysis or same analysis in a new place" (recommended) vs always new vs always same.
- **D8** Combining without asking only when the two computers changed different parts and nothing needed adjusting (recommended) vs always ask.
- **D9** A small visible note file beside the analysis while it is open in a cloud folder (required for the read-only behaviour). Acceptable?
- **D10** "Edit here" works instantly, also when the other computer has unsaved changes (recommended; the two are combined later); "Request to edit" hand-over postponed.
- **D11** Combining first works per part (data / analysis / figure / scratchpad), cell-by-cell later (recommended order) vs wait for cell-by-cell.

## 17. Main risks

- Only Dropbox on one Mac was inspected. Note syncing, same-folder rename behaviour and conflict behaviour on iCloud, OneDrive and Google Drive are assumptions until the manual checks.
- iCloud and probably Google Drive drop the losing save silently; recovery rests on the per-device journal. A device whose app data is wiped loses that net.
- Windows is built only on stable tags; Windows-specific behaviour is deferred and untested.
- Phase 1 is large; the spikes may change the menu/quit and file-association design.
- Until phase 4, two computers changing the same part means choosing one whole part or keeping both files.
- The scratchpad shift check is a heuristic; whole-section choices are always available.
- Older apps open files from newer apps read-only whenever a field was added.
- Check-out is advisory; its failure mode is an occasional combine, never loss.

## 18. Sources (third-party behaviour)

Dropbox: https://help.dropbox.com/sync/files-not-syncing · https://help.dropbox.com/files-folders/share/conflicted-copy · https://help.dropbox.com/organize/modified-date · https://help.dropbox.com/sync/extended-attributes · https://help.dropbox.com/organize/file-locking
OneDrive: https://support.microsoft.com/en-us/office/restrictions-and-limitations-in-onedrive-and-sharepoint-64883a5d-228e-48f5-b3d2-eb39e07630fa · https://support.microsoft.com/en-US/onedrive/duplicate-files-in-onedrive
iCloud: https://developer.apple.com/library/archive/technotes/tn2336/_index.html · https://developer.apple.com/forums/thread/804253 · https://www.iphone-ticker.de/icloud-drive-ordner-und-dateien-die-nicht-synchronisiert-werden-145052/
Google Drive: https://cloudscope.org/articles/cloud-sync-conflicted-copy-duplicate-files/
Latency: https://github.com/mattheworiordan/google-drive-dropbox-onedrive-performance-measured
Atomic save under sync clients: https://github.com/keepassxreboot/keepassxc/discussions/13050 · https://bugs.python.org/issue8828
SQLite in synced folders: https://sqlite.org/howtocorrupt.html
Placeholders: https://developer.apple.com/videos/play/wwdc2021/10182 · https://learn.microsoft.com/en-us/windows/win32/cfapi/build-a-cloud-file-sync-engine
Lock-file precedents: https://docs.libreoffice.org/desktop/html/lockfile_8hxx_source.html · https://support.microsoft.com/en-us/kb/313472
Clock skew: https://support.microsoft.com/en-us/kb/3205089
Tauri config: https://v2.tauri.app/reference/config/
Extension checks: https://fileinfo.com/extension/lgf · https://filext.com/file-extension/LGR · https://filext.com/file-extension/LSG

## 19. Phase 0 results carried into Phase 1

**Code already in place (phase 0):** `file/backend.ts` now has the journal per (analysis, path) with a `confirmed` flag (`journalHeads`, `readJournal`, `writeJournal` for the working copy at a conflict), Recent (`readRecent`/`writeRecent`, keyed by path, max 50), displaced copies (`listDisplaced`/`readDisplaced`) and the export map (`readExportMap`/`writeExportMap`, with the row/column ids minted once per library row). `read` returns a too-new file with `readOnly: "tooNew"` instead of an error. `SaveRequest` carries `analysisId` + `docKey` (identity assertion, `IdentityMismatch`) and the manifest plus `newParts` only; the backend copies kept parts byte for byte from the file being replaced or the journal copy of the base. A missing path runs the safe follow rule inside the save. `memoryBackend` simulates the follow rule (5 s confirm, copy table, descends-from check, `moved` / `missing{candidates}`). `format.ts` has `canonicalJson`, `sha256Hex`, `makePart`, `contentHash`; the file form's table goes through `migrateDoc`, and open → save → reopen → save is byte-identical for every fixture and edit step.

**Rules for phase 1:**
- After a save, take the store's baseline (and its in-memory doc/settings) from the round-tripped file form. Before there are numbers an edit can still leave a control / pair past the table (the clean-up runs only with numbers, as before ids); the file form drops it. Load already drops it.
- Library export mints ids once per library row and records them in `export-map.json`; "Duplicate as a new analysis" keeps the row/column ids (useful with `forked_from`). Old records without ids get new random ids on every open until exported or saved; harmless until combining.
- Quit routine: a custom menu does not catch Dock Quit, logout or AppleScript quit (straight to `RunEvent::Exit`). Add `applicationShouldTerminate:` to tao's `TaoAppDelegateParent` at runtime returning NSTerminateLater, give the routine a **hard timeout that always replies** (logout/shutdown waits on it, in a modal run-loop mode), and log loudly at startup if the class or method is missing (private tao name; `--locked` pins tao). Stop the engine only **after** the routine (today's ExitRequested handler stops it at once). Keep `RunEvent::Exit` as a synchronous Rust-only backstop. The updater restart (`ExitRequested(Some(i32::MAX))`) cannot be prevented: run the routine before calling relaunch and never start it on that exit code.
- File association: Opened arrives before `setup` and before the window; the buffer + `take_pending_opens` is required. An app under /private/tmp or /var/folders never becomes the default app (test from ~/Library/Caches or /Applications).
- Debug builds run as `com.zhuojianlook.analysis.dev`, log to `LAS_STATE_DIR/logs`, refuse port 8765 and the installed app's folders, and stop only the engine they spawned (none). WebKit still keeps the unbundled binary's data in `~/Library/{WebKit,Caches}/app` (not the installed app's).

**Manual checks still open (add to the phase 1 checklist):**
- Privacy prompts on a clean macOS account; answer one Dropbox ("files managed by Dropbox") prompt on a real launch and confirm the grant survives a re-signed update. The phase 0 spike only showed a blocked read with File Provider identity lookups, so a separate Dropbox prompt is probable, not proven.
- Dropbox web version history after a few rename-over saves.
- The same temp-name / rename / note-name tests in Google Drive (present on this Mac), then OneDrive and iCloud Drive.
- A real Cmd+Q keystroke, a real Dock Quit and a logout with unsaved work; a real updater download + install.

