# Phase 1 contract — Graphs analyses saved as files

Binding for the three phase 1 implementers (Rust, TS core, TS UI). They work in parallel and cannot talk, so anything at a boundary is decided here. Sources: the approved plan (`analysis-files-plan.md`, sections 0–14 and 19), the phase 0 code, the spikes under `scratchpad/spikes/menuapp`.

- **Normative TypeScript shapes:** `TauriApp/src/components/graph/file/contract.ts` (already in the repo; compiles with `tsc --noEmit`). Nobody edits it; if something in it is wrong, say so in your final report and work around it.
- "Repo" = `/Users/zhuojianlook/Library/CloudStorage/Dropbox/GitHub Repos/Webtools/Analysis/TauriApp`. "Scratch" = `/private/tmp/claude-501/-Users-zhuojianlook-Library-CloudStorage-Dropbox-GitHub-Repos-Webtools-Analysis/90ad6687-9e70-49b7-a233-23429ecd07f0/scratchpad`.
- Deviations from the plan that this contract makes on purpose are listed in §11.

## 0. Ground rules at the boundaries

1. **Who writes JSON.** TypeScript produces every JSON text that goes into a file: each part (`canonicalJson(section)`) and the manifest (`canonicalJson(manifest)` → `manifestText`). Rust writes those bytes unchanged, hashes them and copies them. Rust parses a *copy* of the manifest to check it, and never parses a part. Rust never re-serialises either.
2. **Wire naming.** Command argument names and the envelope types of `contract.ts` are camelCase (`#[serde(rename_all = "camelCase")]`). Phase 0 record types keep snake_case fields and pass through Rust as they are: `FileHeader {analysis_id, head}`, `DeviceIdentity`, `GraphSession`/`SessionTab`, `DraftRecord`, `JournalHead`, `DisplacedEntry`, `RecentEntry`, `ExportMap`. `FileStat {path,size,mtime,dataless}` and `DirEntry {name,path,size,mtime,kind,dataless,header}` are single words either way.
3. **Opaque records.** Rust stores `GraphSession`, `DraftRecord`, `RecentEntry[]`, `ExportMap` as `serde_json::Value` after the minimal checks in §1.6, so TS core can add optional fields without a Rust change. Rust reads only: `session.tabs[].path`, `session.tabs[].doc_key`, `draft.doc_key`.
4. **Ids.** Minted in TS: `analysis_id` = `a-` + `crypto.randomUUID()`; revision id = `r-` + 26-character ULID (Crockford base32, time-ordered); `doc_key` = `k-` + `crypto.randomUUID()`. Minted in Rust: `device_id` = `d-` + UUIDv4, `session_id` = `s-` + UUIDv4 (per launch), displaced id = `x-` + UUIDv4. Rust rejects with `Invalid` any id used in a file name that does not match `^[A-Za-z0-9_-]{1,80}$`.
5. **Paths** are absolute strings with `/` separators on macOS/Linux. Phase 1 is macOS; Rust code must still compile on Windows and Linux (CI builds them) with `cfg` fallbacks.
6. **Only TS core talks to Tauri** for file features (`invoke`, `listen`, plugin-dialog). The UI uses `useFileSession` and nothing else.
7. **UI text** is owned by the UI (`files-ui/text.ts`). The controller gives structured data (`TabBanner`, `RestoreCard`, …), never sentences, except `saveFailed.message` / toast `message` which carry a plain sentence built by TS core from the error kind (table in §4.9).

---

## 1. Rust: commands

All in `src-tauri/src/`: `graphfile.rs` (container, read, save, journal, displaced, scan, locate), `graphwatch.rs` (poll thread), `appstate.rs` (device, session, recent, drafts, export map), `menu.rs`, `quit.rs` (+ `quit_macos.rs` for the hook), `opens.rs` (pending opens). Register every command in `lib.rs` `generate_handler!`. No capability change is needed (custom commands and app events are covered by `core:default`; `dialog:default` already grants open/save).

### 1.1 Error type

```rust
#[derive(serde::Serialize)]
pub struct FileErr { pub kind: ErrKind, pub message: String, pub data: Option<serde_json::Value> }
#[derive(serde::Serialize)]            // serialised as the bare variant name
pub enum ErrKind { NotFound, PermissionDenied, OfflineOrTimeout, Incomplete, Dataless, TooNew,
                   IdentityMismatch, Invalid, Io, Cancelled, NoStateDir }
```

Every command in this section returns `Result<T, FileErr>`; `invoke` rejects with `{kind, message, data}` (`RustError` in contract.ts). `data` is `null` unless stated.

| kind | when |
|---|---|
| `NotFound` | no file / folder at the path (ENOENT, ENOTDIR) |
| `PermissionDenied` | EPERM / EACCES on stat, open, read_dir, write |
| `OfflineOrTimeout` | the blocking work did not finish in the timeout; ETIMEDOUT; a read that fails on a file-provider path with EIO/ENETDOWN-type errors |
| `Dataless` | online-only placeholder, found by stat flags **before any read** (macOS `st_flags & 0x4000_0000` SF_DATALESS; Windows attributes `0x0040_0000` or `0x0000_1000`; Linux never) |
| `Incomplete` | the bytes are there but fail validation in a way a still-arriving file would (§1.3). `data: {reason}` |
| `Invalid` | definitely not an analysis file (§1.3), a bad argument, a save whose parts are missing or whose hash does not match, file over the size limit |
| `TooNew` | save only: the file at the path has `min_reader_version` > 1. `data: {min_reader_version}` |
| `IdentityMismatch` | save only (§1.4 step 2). `data: {found: <analysis id at the path or null>}` |
| `Io` | any other OS error (disk full, read-only volume, name too long) |
| `Cancelled` | `graphfile_locate` stopped by cancel |
| `NoStateDir` | `StateDir(None)`: every `appstate_*`, journal and displaced command |

### 1.2 Execution rules

- Every command is `async`. Disk work runs in `tauri::async_runtime::spawn_blocking`, raced against a timeout: **15 s** (`LIMITS.commandTimeoutMs`) for all, **30 s** for `graphfile_save`, **22 s** for `graphfile_locate` (its own 20 s bound stops it first). On timeout the command rejects `OfflineOrTimeout`; the blocked thread is left to finish and its result is dropped (a save that finishes late is still a valid save — the next poll reports it as `changed`).
  CHANGED BY fixer (review V3): a save that times out is **cancelled**, not left to land later: `graphfile_save` sets a cancel flag on timeout and the save checks it after taking the path lock and right before the rename (and the aside rename); when set it stops with `OfflineOrTimeout`, deletes its temp file and writes nothing. (A late save was reported to nobody: the frontend had been told it failed, `note_saved` hid it from the poll, and the next Save met a conflict with it.)
- Implement the timeout without new crates (e.g. `std::sync::mpsc::recv_timeout` inside a second blocking task, or `tokio::time::timeout` if the `time` feature is already unified — check with `cargo tree -e features`; do not change the lock for it).
- `graphfile_save` and `graphfile_write_journal` take a **per-path mutex** (`Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>`). The poll thread takes the same mutex with `try_lock` and skips the path for this round when a save holds it.
- Rust keeps a **validation record** per path in memory: `{size, mtime_ms, sha256_of_file, analysis_id, head}`, set after every successful full read and save.

### 1.3 Container (plan §1.2–1.4)

Constants (mirror `format.ts`): extension `lag`, magic `LASGRAPH1`, MIME `application/vnd.labanalysissuite.graph+zip`, format `lasgraph`, reader version `1`.

**Writing** (always the whole file, built in memory):

1. Entry 1: `mimetype`, **stored** (no compression), no extra field, content = the MIME string, no newline.
2. Entry 2: `manifest.json`, deflate, content = `manifestText` bytes.
3. Then every part, sorted by name (`parts/<sha256>.json`), deflate.
4. ZIP comment: `LASGRAPH1 <analysis_id> <head_revision_id>` (single spaces, ASCII).
5. Every entry: DOS time 1980-01-01 00:00:00, unix mode 0644, no extra fields, no data descriptors if the `zip` crate allows (write to a `Cursor<Vec<u8>>`, which is seekable). Deflate level: the crate default. Same input → same bytes (the golden tests rely on it within one build).

Crate: `zip = { version = "~4.6", default-features = false, features = ["deflate-flate2"] }` plus `flate2 = "1"` (default features = the pure-Rust backend already in the lock). **Do not** enable zip's `deflate` feature: it pulls `zopfli` and `zlib-rs`, which are not in `Cargo.lock`. Also add `sha2 = "0.10"`, `uuid = { version = "1", features = ["v4"] }`, `libc = "0.2"` (unix, for `F_FULLFSYNC`). All four are already in the lock; the only lock edits allowed are the dependency lists of `app` and `zip`. Verify with `cargo build --locked`.

**Full read / validation** (`graphfile_read`, and inside save and poll):

1. stat: missing → `NotFound`; dataless → `Dataless`; size > 64 MB → `Invalid` ("too large"); size 0 → `Incomplete`.
2. Read the whole file; SHA-256 of the bytes (for the validation record).
3. ZIP opens (end-of-central-directory found and central directory parses), else `Incomplete {reason:"zip"}`.
4. First entry is `mimetype`, stored, content equals the MIME. A ZIP that opens cleanly but has another first entry or content → **`Invalid`** (it is some other file). 
5. `manifest.json` exists and inflates (CRC ok), else `Incomplete`. It parses as JSON with `format == "lasgraph"`, else `Invalid`.
6. Manifest checks: `analysis_id` is a string; `head` names a revision in `revisions`; that revision's `sections` is an object with `table`, `analysis`, `figure`, `scratchpad`, each `{part, sha256, bytes}`. Failure → `Incomplete {reason:"manifest"}`.
7. ZIP comment equals `LASGRAPH1 <analysis_id> <head>`, else `Incomplete {reason:"comment"}`.
8. Every `parts/*.json` entry present inflates and its SHA-256 equals the hex in its name; every part the **head** references is present with matching `sha256` and byte length. Failure → `Incomplete {reason:"part"}`. Parts of older revisions may be absent (pruned) — not an error.
9. Total inflated size > 256 MB → `Invalid`.
10. `readOnly = "tooNew"` when `min_reader_version` (default 1) > 1; the read still succeeds.

CHANGED BY fixer (review V4): after step 6, `analysis_id` and `head` must match the id rule of §0.4, else **`Invalid`** ("the file's ids aren't ones this app makes"). Such a file could be opened but never saved or journaled.

CHANGED BY fixer (review F1): a full read that finds the file dataless (step 1) still rejects `Dataless` without reading, but first asks for the download: `request_download(path)` reads the file once on its own background thread (bounded to 64 MB, bytes dropped; one reader per path), which is what makes macOS's file provider / Windows cloud files fetch it. The same is done by a poll look that finds a tracked file dataless (§3.2 step 4) and by a save whose target is dataless. `graphfile_header`, scans and Find it… never ask for downloads.

On success: set the validation record, **journal the head** (§1.5), delete orphan temp files (`.~*.tmp-*` older than 10 min) in the file's folder, return `ReadReply {manifestText, parts, stat, readOnly}` with `parts` = every part entry in the file.

**Header read** (`graphfile_header`): stat (same `NotFound` / `Dataless` / `PermissionDenied`), then read at most the last 64 KB + 22 bytes, find the end-of-central-directory record, parse the comment. No comment / wrong magic → `Incomplete`. Returns `{header:{analysis_id, head}, stat}`. Never journals. It is a hint: never used alone for a save decision.

`FileStat.mtime` = modification time in ms since the epoch (number).

### 1.4 `graphfile_save { req: SaveArgs } → SaveReply`

Under the path mutex, in this order (plan §7 step 3):

1. **Arguments.** Parse `manifestText`. `Invalid` unless: it passes the manifest checks of §1.3 (5–6); `manifest.analysis_id == req.analysisId`; `req.path` ends with `.lag`; every key of `newParts` is `parts/<64 hex>.json` and the SHA-256 of its text's UTF-8 bytes equals that hex; the parent folder exists (else `NotFound`).
2. **Identity.** `IdentityMismatch` when the stored session (`graph-session.json`) has a tab with `path == req.path` and another `doc_key`; or when a readable valid file at the path has another `analysis_id` (unless `replaceExisting`).
3. **Check the target.**
   - *Path absent, `expectedHead == null`* → write new (step 5).
   - *Path absent, `expectedHead != null`* → run the safe follow rule (§3.3) once, immediately, using the copy table of the track for this path if there is one. One safe successor → continue with that path as the target (the reply's `path` says where; re-key the track; emit `moved`). Otherwise → `{kind:"missing"}`, nothing written.
   - *Path present, `expectedHead == null`*: `replaceExisting == false` → valid analysis file: `{kind:"conflict", head}`; anything else: `Invalid` ("a file that is not an analysis is in the way"). `replaceExisting == true` → hard-link (else copy) the existing file into `displaced/` with reason `"replaced"` (keep that entry), then write new.
   - *Path present, `expectedHead != null`*: stat. Dataless → step 4. If size and mtime equal the validation record → head is the record's head. Otherwise validate fully; `Incomplete` → retry every 500 ms for up to 10 s, then step 4; valid → use its head. `TooNew` file → reject `TooNew`. Head ≠ `expectedHead` → `{kind:"conflict", head}`, nothing written.
4. **Head cannot be established** (dataless, still incomplete, read error other than permission) → do not overwrite. Write the new file as `<stem> (unsynced from <device name>).lag` in the same folder (free name: append ` 2`, ` 3`, …; device name sanitised to letters, digits, space, `-`), journal it, reply `{kind:"savedAside", path:<aside path>, head, stat}`.
   CHANGED BY fixer (review F1): a repeated save aside **replaces** the aside copy the app wrote earlier for this target (it is in the track's copy table with the head it was written with, and its header still shows that head) instead of adding ` 2`, ` 3`, …; the replaced one is in the journal. A copy anyone else changed is never replaced.
5. **Assemble.** For every revision with non-null `sections`, each referenced part comes from, in order: `newParts`; the file being replaced; the journal copy of `expectedHead`. A part found nowhere → `Invalid` ("part missing: …"), nothing written. Parts no revision references are dropped. Build the ZIP in memory (§1.3).
   CHANGED BY fixer (review V6): the unpacked total (mimetype + manifest + parts) over 256 MB → `Invalid` before anything is written (a read would refuse that file).
   CHANGED BY fixer (review V1): before step 3, when the folder listing has the target under another spelling (a case-only or Unicode-normalisation rename: `stat` of the old spelling still works) and it is the same file (device + inode), the save goes to the spelling on disk: re-key the track, emit `moved`, the reply's `path` says where.
6. **Write.** Temp file in the **same folder** named `.~<target file name>.tmp-<8 random hex>` (example: `.~Dose response.lag.tmp-3fa9c1d2`). Never a name that starts with a bare `~` and never one that ends in `.tmp`. Write, `fsync` (`fcntl(F_FULLFSYNC)` on macOS, falling back to `fsync`), close.
7. **Replace.** If a target exists: hard-link (else copy) it to `displaced/<id>.lag`; re-stat the target — if size/mtime differ from step 3, re-run step 3 once (a remote save landed; usually ends in `conflict`, the temp file is deleted). Rename the temp over the target immediately after the fsync (no waiting). Windows sharing violation: retry 5× over 2 s, then `Io` ("couldn't replace the file, it's in use") with the temp file deleted.
8. **Look at what was replaced.** Validate the displaced copy. Head == `expectedHead` → delete the displaced link (the journal already has that head). Another valid head → journal it (path = target), delete the displaced link, and the reply becomes `savedButDisplaced {displacedHead}`. Not valid → keep the displaced entry (reason `"replaced"`).
9. **Verify.** Re-open the target and validate fully (failure → `Io`; the previous content is still in the journal). Copy to the journal, set the validation record, and update the poll track for this path (head, size, mtime) so the poll does not report the app's own save.
10. Reply `{kind:"saved", path, head, stat}`.

On any error after step 6 the temp file is removed. The old file is never truncated in place.

### 1.5 Journal and displaced copies

```
<state>/journal/<analysis_id>/<revision_id>.lag     a full copy of the file with that head
<state>/journal/index.json                          { "v": 1, "entries": JournalHead[] }
<state>/displaced/<id>.lag
<state>/displaced/index.json                        { "v": 1, "entries": DisplacedEntry[] }
```

- **Journal a head** (after every successful `graphfile_read`, every save incl. aside, every displaced head found, and `graphfile_write_journal`): copy the file bytes to `journal/<aid>/<rev>.lag` if not there; add `JournalHead {analysis_id, path, revision_id, confirmed:false, first_seen:<now ms>}` unless that triple exists; then, **only when the head was seen on disk at that path** (not for `write_journal`), set `confirmed = true` on every other entry with the same `(analysis_id, path)` whose `revision_id` is a strict ancestor of the head in this manifest.
- `graphfile_journal_heads {analysisId, path|null}` → entries, oldest `first_seen` first.
- `graphfile_read_journal {analysisId, revisionId}` → `RawFile` or `null` (validated like a read; a damaged copy → `null`).
- `graphfile_write_journal {path, file}` → builds the ZIP from `file` (all parts the head references must be in `file.parts`, else `Invalid`) and journals it unconfirmed.
- `graphfile_list_displaced` / `graphfile_read_displaced {id}` as in `backend.ts`.
- **Pruning at startup** (background thread): journal — keep every unconfirmed entry and the newest 10 per analysis; beyond that delete oldest confirmed first while the folder is over 500 MB. Displaced — delete entries older than 30 days. Index writes are atomic (temp + rename, temp name `.<name>.tmp-<hex>` — the state folder is not synced).

### 1.6 App records (`appstate.rs`)

State folder `S` = managed `StateDir` (release: Tauri app-data dir of `com.zhuojianlook.analysis`, or `LAS_STATE_DIR`; debug: `LAS_STATE_DIR`, see `devenv.rs`). Created on first write. Layout:

```
S/device.json            { v:1, device_id, device_name|null, user_name|null, hw_hash|null, aliases:[] }
S/graph-session.json     GraphSession            (default { v:1, tabs:[] })
S/graph-recent.json      RecentEntry[]           (default [])
S/drafts/<doc_key>.json  DraftRecord
S/export-map.json        ExportMap               (default { v:1, rows:{} })
S/journal/…  S/displaced/…                       (§1.5)
```

| command | args | result | notes |
|---|---|---|---|
| `appstate_device` | — | `DeviceIdentity` | Creates `device.json` on first call. `hw_hash` = SHA-256 hex of `"las-device:" + hardware id` (macOS: `IOPlatformUUID` from `ioreg -rd1 -c IOPlatformExpertDevice`; Windows: `MachineGuid`; Linux: `/etc/machine-id`). Stored hash present and different → new `device_id`, old one appended to `aliases`, no question. Hardware id unreadable → keep the id. `device_name` null → default: macOS `scutil --get ComputerName`, else hostname without `.local`. `user_name` null → macOS `id -F`, else `$USER` / `%USERNAME%`. `session_id` is made once per launch. |
| `appstate_set_device` | `{patch: DevicePatch}` | `DeviceIdentity` | Trim, cut to 60 chars; empty string → back to default (stores null). |
| `appstate_read_session` | — | `GraphSession` | Missing → default. Unparsable → rename to `graph-session.json.bad-<ms>`, return default. |
| `appstate_write_session` | `{session}` | `null` | `Invalid` unless `session.tabs` is an array. Atomic. |
| `appstate_read_draft` | `{docKey}` | `DraftRecord \| null` | |
| `appstate_write_draft` | `{draft}` | `null` | File name from `draft.doc_key` (id rule §0.4). Atomic. |
| `appstate_delete_draft` | `{docKey}` | `null` | Missing is fine. |
| | | | CHANGED BY fixer (review V2): `appstate_write_draft` and `appstate_delete_draft` take an optional `seq` (number). Writes and deletes of one `doc_key` run one at a time (a lock), and a call whose `seq` is not higher than the last one applied for that key is dropped (it was overtaken). `tauriBackend.ts` also chains each key's calls (and `writeSession`) in order and sends a growing `seq` (`Date.now()*1000 + n`). `contract.ts` lists only `draft` / `docKey`; the extra argument is passed with a cast. |
| `appstate_list_drafts` | — | `DraftRecord[]` | Unreadable files skipped. |
| `appstate_read_recent` | — | `RecentEntry[]` | |
| `appstate_write_recent` | `{entries}` | `null` | Stored deduplicated by `path` (first wins), cut to 50. |
| `appstate_read_export_map` | — | `ExportMap` | |
| `appstate_write_export_map` | `{map}` | `null` | |

### 1.7 Other file commands

| command | args | result | notes |
|---|---|---|---|
| `graphfile_read` | `{path}` | `ReadReply` | §1.3 |
| `graphfile_header` | `{path}` | `HeaderReply` | §1.3 |
| `graphfile_save` | `{req}` | `SaveReply` | §1.4 |
| `graphfile_scan_dir` | `{dir}` | `{entries: DirEntry[]}` | Direct children only, files only, sorted by name. `kind`: `graph` for `.lag`, `presence` for `.laguse`, else `other` (**only `graph` and `presence` entries are returned**). `header` = comment of local, non-dataless `.lag` files whose comment parses; else `null`. Hidden names (leading `.`) skipped. |
| `graphfile_locate` | `LocateArgs` | `LocateReply` | §3.4 |
| `graphfile_locate_cancel` | `{token}` | `null` | |
| `graphfile_track` | `TrackArgs` | `null` | §3.1. Sync-fast (no disk work on the calling thread). |
| `graphfile_untrack` | `{path}` | `null` | |
| `graphfile_poll_now` | — | `null` | Makes every track due now. |
| `graphfile_reveal` | `{path}` | `null` | macOS `open -R <path>`; Windows `explorer /select,`; Linux `xdg-open <parent>`. |
| `app_info` | — | `AppInfo` | `tempDirs` on macOS: `std::env::temp_dir()` (canonical), `/private/tmp`, `/private/var/folders`, `~/Library/Mail`, `~/Library/Containers/com.apple.mail`, `~/Downloads`. |
| `take_pending_opens` | — | `string[]` | §2.3 |
| `app_set_menu_state` | `{state: MenuState}` | `null` | §6.1 |
| `app_quit_reply` | `QuitReplyArgs` | `null` | §6.3 |

`FileBackend` method → command:

| `FileBackend` (backend.ts / `FileBackendP1`) | command(s) | mapping done in `tauriBackend.ts` |
|---|---|---|
| `device()` | `appstate_device` | |
| `read(path)` | `graphfile_read` | parse `manifestText` → `GraphFileData`; reject → `FileError {ok:false, code, message}` |
| `header(path)` | `graphfile_header` | |
| `save(req)` | `graphfile_save` | `manifestText = canonicalJson(req.manifest)`; `replaceExisting = req.replaceExisting ?? false`; reply kinds `saved`/`savedAside`/`savedButDisplaced` → `ok:true`; `conflict`/`missing` → `ok:false`; reject → `{ok:false, kind:"error", code, message}` |
| `scanDir(dir)` | `graphfile_scan_dir` | |
| `readSession/writeSession` | `appstate_read_session` / `appstate_write_session` | |
| `readDraft/writeDraft/deleteDraft/listDrafts` | `appstate_*_draft(s)` | |
| `journalHeads(aid, path?)` | `graphfile_journal_heads` (`path: path ?? null`) | |
| `readJournal` / `readDisplaced` | `graphfile_read_journal` / `graphfile_read_displaced` | parse manifest |
| `writeJournal(path, file)` | `graphfile_write_journal` | `file.manifestText = canonicalJson(file.manifest)` |
| `listDisplaced` | `graphfile_list_displaced` | |
| `readRecent/writeRecent` | `appstate_read_recent` / `appstate_write_recent` | |
| `readExportMap/writeExportMap` | `appstate_read_export_map` / `appstate_write_export_map` | |
| `track(path, {active})` | `graphfile_track` | the backend remembers `head`/`analysisId` from its last `read`/`save`/`header` of that path and sends them |
| `untrack(path)` | `graphfile_untrack` | |
| `subscribe(l)` | `listen(EVT.file)` | one listener for the app's lifetime; payload passed on as `FileEventP1` |
| `appInfo()` | `app_info` | |
| `setDevice(patch)` | `appstate_set_device` | |
| `locate / cancelLocate` | `graphfile_locate` / `graphfile_locate_cancel` + `listen(EVT.locateProgress)` | |
| `pollNow()` | `graphfile_poll_now` | |
| `reveal(path)` | `graphfile_reveal` | |

Any command rejecting with something that is not a `RustError` object (a panic string) maps to code `Io`.

---

## 2. Rust → frontend events

Emitted with `app.emit(name, payload)` (all windows). Names and payload types: `EVT` and the types beside it in contract.ts.

### 2.1 `graphfile://event` — `RustFileEvent`

| type | payload | when (details in §3) |
|---|---|---|
| `changed` | `{path, head}` | stable, fully valid file with the tracked analysis id and a head other than the track's |
| `moved` | `{from, to, head}` | renamed in its folder and followed; the track is re-keyed to `to` |
| `missing` | `{path, candidates}` | absent ≥ 5 s on two looks, no single safe successor; once per disappearance |
| `back` | `{path, head}` | a valid file with the tracked id is at the path again after `missing` / `unreadable` / `replaced` |
| `sibling` | `{path, sibling, header}` | another file with the same analysis id appeared in the folder, or its head changed |
| `unreadable` | `{path, reason}` | exists but dataless / incomplete / permission / timeout; sent when the reason starts or changes |
| `replaced` | `{path, analysisId}` | a valid file with a different analysis id is at the path |

### 2.2 `app://menu` — `MenuEvent {id, path}`

`id` ∈ `MENU` (contract.ts). `path` is set only for `file.open_recent`. Emitted for every custom menu item; Rust does nothing else for them except `app.quit`, which also starts the quit handshake (§6.3) — the frontend does **not** act on a `MenuEvent` with id `app.quit` (it gets `app://quit-requested`).

### 2.3 Opened files

- `RunEvent::Opened { urls }` (macOS; arrives before `setup` and before the window): convert each `file://` URL to a path, keep those ending in `.lag` (case-insensitive). If the frontend has not called `take_pending_opens` yet → push to a static buffer. Otherwise emit `app://open-files {paths}` and bring the main window to the front (`show`, `unminimize`, `set_focus`).
- Also at startup: process arguments that are existing paths ending in `.lag` go into the same buffer (Windows/Linux double-click, and `open -a` with `--args`).
- `take_pending_opens` → drains and returns the buffer, and marks the frontend ready. It is the frontend's "I am listening" signal: it must have subscribed to `app://open-files`, `app://menu`, `app://quit-requested` and `graphfile://event` **before** calling it.

### 2.4 `app://quit-requested` — `QuitRequest {requestId, source}`; see §6.3.

### 2.5 `graphfile://locate-progress` — `LocateProgress {token, scanned, matches}`, about every 250 ms during a locate.

---

## 3. Poll protocol (`graphwatch.rs`)

No watcher crate. One thread, started in `setup`, ticking every 500 ms.

### 3.1 Tracks

`graphfile_track {path, active, head, analysisId}` creates or updates the track keyed by `path` (updating never resets its copy table or missing state; `head`/`analysisId` non-null overwrite the stored ones). On creation the folder is scanned once and every other `.lag` with the same analysis id goes into the track's **copy table** without an event (the controller does its own `scanDir` on open).

Track state: `{path, active, analysis_id, head, record:{size,mtime}, copy_table: Set<path>, absent_since, absent_looks, state: Ok|Missing|Unreadable(reason)|Replaced, sibling_heads: Map<path, head>}`.

A track is **due** every `3000 ms` when `active`, every `10000 ms` otherwise; all tracks are due immediately on `graphfile_poll_now`, on main-window focus (`WindowEvent::Focused(true)`, handled in Rust), and when a tick arrives more than 90 s late (the computer slept).

### 3.2 One look at a due track

Skip if the path's save mutex is held. Then:

1. `stat(path)`.
2. **Absent** → §3.3.
3. **Error** → `PermissionDenied` or `OfflineOrTimeout` → state `Unreadable(reason)`; emit `unreadable` if the state changed.
4. **Dataless** → state `Unreadable(Dataless)`; emit `unreadable` if changed. Never read.
5. **Present, size and mtime equal the record, state Ok** → nothing.
6. **Otherwise** (changed, or returning from a non-Ok state): wait 300 ms and stat again; if size or mtime moved, leave it for the next look. Read the header (comment). 
   - No valid comment → state `Unreadable(Incomplete)`; emit if changed.
   - Comment's analysis id ≠ track's → validate fully; valid → state `Replaced`, emit `replaced {analysisId}` once; invalid → `Unreadable(Incomplete)`.
   - Same id, comment head == track head → update the record; if the state was not Ok → state Ok, emit `back {head}`.
   - Same id, other head → **validate fully** (§1.3; this does *not* journal — the controller's `read` does). Invalid → `Unreadable(Incomplete)` (looked at again next round). Valid → update record and track head; state was Ok → emit `changed {head}`; state was not Ok → emit `back {head}` (the controller treats `back` like `changed` plus "it is here again").
7. **Siblings.** List the folder (`*.lag`, not hidden, not dataless), cached by name/size/mtime so only new or changed entries have their comment read. For each *other* file whose comment has the track's analysis id: add it to the copy table; if it is new, or its head differs from `sibling_heads[path]` → validate it fully and, if valid, emit `sibling {path, sibling, header}` and remember the head. (Files in the copy table at track creation are remembered with their head then, so they are not announced until they change.)
   CHANGED BY fixer (review V1): "other file" means another file by **identity** (device + inode on unix; a case-insensitive path compare elsewhere), never by the spelling of the name. When the listing has the tracked file only under another spelling (renamed by case or Unicode normalisation), the track follows it at once: re-key, emit `moved {from, to, head}` (no 5 s wait and no safe-follow check: it is the same file). The frontend shows no "Renamed" toast when only the Unicode form changed.

Own saves never produce `changed`: `graphfile_save` writes the new head and stat into the track before releasing the mutex.

### 3.3 Absent path — the safe follow rule (plan §5.2)

- First absent look: set `absent_since`, `absent_looks = 1`. Nothing else.
- The path counts as gone when `absent_looks ≥ 2` **and** `now − absent_since ≥ 5000 ms`. If it reappears before that, clear both (a sync client's delete-then-create) and continue with §3.2 step 6.
- When gone: candidates = files **in the same folder** with the track's analysis id in their comment that are **not in the copy table**. Follow only when there is **exactly one** candidate, it validates fully, and its head **equals or descends from** the track's head (`track.head` is an ancestor-or-self of the candidate's head in the candidate's own manifest; a null track head counts as satisfied). Then: re-key the track to the candidate (keep the copy table minus the candidate), state Ok, emit `moved {from, to, head}`.
- Otherwise state `Missing`, emit `missing {path, candidates}` once, where `candidates` = **all** same-id files in the folder (including copy-table ones), sorted — for the chooser.
- While `Missing`, each look repeats the test: the path is back → §3.2 step 6 (`back`); a single safe successor has arrived → `moved`. No second `missing`.
- A file with a different analysis id is never a candidate and never adopted. Other folders are never searched by the poll (the controller offers Find it…).
- The same rule runs once, without the 5 s wait, inside `graphfile_save` (§1.4 step 3).

### 3.4 Find it… (`graphfile_locate {dir, analysisId, token}`)

Walk `dir` breadth-first on a blocking thread.

- Bounds: depth ≤ 8 below `dir`; ≤ 50,000 directory entries looked at; ≤ 20 s. Hitting one sets `truncated` and returns what was found.
- Skipped folders: names starting with `.`; `node_modules`; bundles (a folder whose name ends in `.app`, `.bundle`, `.framework`, `.plugin`, `.kext`, `.pkg`, `.photoslibrary`, `.musiclibrary`, `.xcodeproj`, `.lproj`); symlinks (never followed); folders that return a permission error (first 20 listed in `skippedFolders`).
- Only files ending in `.lag` (not hidden). Dataless ones are counted in `onlineOnlyCount` (first 50 paths in `onlineOnly`) and **not read**.
- Local ones: read only the tail (≤ 64 KB + 22 bytes) for the comment. Comment id == `analysisId` → validate fully; valid → a `LocateMatch` (`userName`, `deviceName`, `time` from the head revision).
- `matches` sorted by `stat.mtime` descending. Emits `graphfile://locate-progress` about every 250 ms. `graphfile_locate_cancel {token}` → the command rejects `Cancelled`.
- `dir` unreadable → `PermissionDenied` / `NotFound`.

---

## 4. TS core: the session controller

Files (all under `src/components/graph/file/`, owned by TS core):

| file | content |
|---|---|
| `session.ts` | `export const useFileSession = create<FileSessionState>(…)` — the only thing the UI imports for behaviour |
| `tauriBackend.ts` | `FileBackendP1` over `invoke`/`listen` |
| `previewBackend.ts` | builds the preview world: `MemoryWorld` (mode `dropbox`) + this computer + one other computer, real-time clock driver, persistence |
| `devSim.ts` | `export function devSim(): DevSimApi \| null` |
| `docCodec.ts` | store content ⇄ file sections ⇄ `GraphFileData` (uses `idMap.ts`, `format.ts`): `buildSave`, `openFile`, `draftOf`, revision building, `ulid()`, `mergeRevisionId()` |
| `paths.ts` | `folderLabel(path, home)`, `cloudServiceOf(path, home)`, `isTempLocation(path, tempDirs)`, `safeFileName(name)` |
| `libraryExport.ts` | §8 |
| `backend.ts`, `memoryBackend.ts`, `format.ts`, `idMap.ts` | phase 0, extended (below) |

### 4.1 Changes to phase 0 files (TS core)

- `backend.ts`: `FileErrorCode` gains `"Io"`; `FileEvent` becomes exactly `FileEventP1` (adds `back`, `unreadable`, `replaced`; `moved` gains `head`); `SaveRequest` gains `replaceExisting?: boolean`; `SessionTab` gains optional `title?: string` (untitled documents), `template?: string`, `known_copies?: string[]` (paths of copies this session made or the person answered about), `copy_answer?: Record<string, "same">`. Export `type { FileBackendP1 }` from contract.ts is implemented by `MemoryDevice` and the Tauri backend.
- `memoryBackend.ts`: emit `back` / `unreadable` / `replaced` with the meaning of §2.1 and `moved.head`; implement `appInfo`, `setDevice`, `locate` (prefix walk with the same result shape; honours a scripted permission-denied folder and dataless files), `cancelLocate`, `pollNow`, `reveal` (no-op); honour `replaceExisting`; scripting hooks the simulator needs (permission-denied folders, forced-incomplete for a time, `armOffline`); `exportState()` / `importState()` for persistence. Existing tests must keep passing (adjust only where an event gained a field).
- `graphStore.ts` — **additive only**; every current export keeps working (the old-library code and the scratch test suites use `load`, `currentId`, `markSaved`, `writeDraft`, `readDraft`, `DRAFT_LIMIT`, …):
  - state `file: { docKey: string; analysisId: string; baseRevision: string | null; path: string | null } | null` and `editSerial: number` (bumped by every action that changes `doc`, `analysis`, `figure` or `scratch`);
  - `loadFile({ file, name, doc, analysis, figure, scratch, saved })` — the existing load pipeline (ids → defaults → clean-up) with the baseline taken afterwards; sets `currentId: null`; `openedAs: saved ? "saved" : "draft"`;
  - `replaceWorking({ doc, analysis, figure, scratch })` — put a draft on top of a loaded file: content changes, baseline (`savedSnapshot`, `savedScratch`, `savedName`) and `file` stay; undo stack cleared;
  - `markFileSaved(file, name, sent)` — baseline and in-memory content from the round-tripped file form (plan §19 rule), `file` updated;
  - `setFileRef(patch, name?)` — path / base change without touching content (rename follow, Save As);
  - `name` is the tab title and is always equal to `savedName` for file documents (the name is the file name; it never makes a document dirty);
  - `newDoc(t, sample)` stays; the controller calls it and then sets `file`.
- `api/graph.ts`: no change needed. `src/api/files.ts` is optional.

### 4.2 Backend choice and init

`init()` (idempotent; called by `FilesHost` at app start, **not** by `GraphView`, because the Graphs tool mounts lazily):

1. `desktop = await isTauri()` (`src/api/client.ts`). Desktop → `tauriBackend`; else → `previewBackend` (only when `import.meta.env.DEV`; a production web build without Tauri gets the preview backend too, without the simulator panel).
2. Subscribe: `backend.subscribe`, and in the desktop `listen(EVT.menu)`, `listen(EVT.openFiles)`, `listen(EVT.quitRequested)`.
3. Read `appInfo`, `device` (→ `settings`), `readRecent` (→ `recent`), `readSession`.
4. Restore the session (§4.5). Then `take_pending_opens` → `open(path)` for each. Then, in the background, the startup check of the 20 newest Recent paths (§4.8) and the old-library count (`getGraphLibrary()` + export map → `oldLibrary`; retried while the engine is still starting).
5. Legacy draft: if `readDraft()` (localStorage `las.graph.draft`) returns one and the session had no tabs, open it as an untitled document named `<its name> (recovered)` (or `Untitled (recovered)`), write the new draft record, then `clearDraft()`.
6. `ready = true`. Push the menu state.

In the preview also: `window.addEventListener("beforeunload", …)` flushes synchronously (the memory backend persists to `localStorage` key `las.files.preview.v1` on every change); `window.addEventListener("focus", () => backend.pollNow())`.

### 4.3 One document in memory

`graphStore` holds the active tab's document. Every other tab exists only as its `SessionTab` record plus, when it had unsaved changes, its draft on disk.

**Switch (`switchTab(key)`), also used by open / new / close:** set `busy`; `flushScratch({commitEdit:true})`; if the active tab is dirty → `writeDraft` (awaited) else `deleteDraft`; `track(oldPath, {active:false})`; load the target: `read(path)` → `fromFileSections` → `loadFile(saved:true)` → if a draft exists apply §4.6 → `track(path, {active:true})`; write the session; clear `busy`. A target that cannot be read becomes a card (§4.5) and `activeKey` still moves to it. Untitled target: `loadFile(saved:false)` from its draft, or `newDoc` + empty when it has none.

`showStart()`: flush as above, `graphStore.close()`, `activeKey = null`.

**Dirty flag:** for the active tab `isDirty(graphStore)`, mirrored into `tabs[].dirty` by a store subscription; for background tabs the value at the time they were left.

**Tab cap:** opening a 13th tab is refused: toast `tabLimit`, outcome `{ok:false, reason:"limit"}`.

### 4.4 Drafts and session flush

- **Draft record** = `{doc_key, analysis_id, path, base_revision, sections: {table, analysis, figure, scratchpad}, saved_at}` with the sections in **file form** (`toFileSections` + the scratchpad as its parsed object or `null`).
- Written: 1 s (`LIMITS.draftDebounceMs`) after the last store change while dirty; on tab switch / `showStart`; in `quitRoutine`; on window blur. Each write first calls `flushScratch()` (without `commitEdit` for the debounced write; with it for switch and quit).
- Deleted: after a verified save of that document; when the active tab is clean again (edits undone); on "Discard" in the close dialog; by `deleteDraft` from Recover. **Never** on `forget`, on a failed open, or on close of a tab whose file is missing.
- **Session** (`writeSession`) after every: open, close, switch, new, path change (Save As, rename follow, Find it), base change (save, reload), `accepted_head` change. Writes are serialised (one in flight, latest wins).
- Recent (`writeRecent`): on open, save-as, rename follow (old path replaced by the new one in place), find. Newest first.

### 4.5 Opening and restoring

`open(path?)`: no path → pick (§4.10). Already open (same path) → `switchTab`, toast `alreadyOpen`. Else create the tab (`status:"opening"`), `read(path)`:

| result | tab |
|---|---|
| ok | `status:"ready"`; journal invariant check (§4.8); copy checks (§4.7); temp-location banner if `isTempLocation`; `readOnly:"tooNew"` → banner `tooNew` |
| `Dataless` | card `downloading`; retried every 3 s |
| `Incomplete` | card `downloading` for up to 10 s of retries (every 1 s), then card `unreadable` |
| `PermissionDenied` | card `permission` |
| `OfflineOrTimeout` | card `downloading`, retried every 5 s |
| `NotFound` | user-initiated open: toast `error` and no tab. Restore: below |
| `Invalid` | card `unreadable` (user-initiated: toast `error`, no tab) |

**Startup restore**, per `SessionTab` with a path, in session order, the previously active one last (so it ends up loaded); nothing blocks the UI (tabs appear at once with `status:"opening"`):

1. `header(path)` ok and the id matches → the tab is ready to load (only the active one is actually read now). Id differs → treat as missing (never adopt).
2. `NotFound` and `cloudServiceOf(path)` is non-null → card `waiting`, silent retry every 3 s for 60 s.
3. Then (or at once outside cloud folders): same-folder search with the safe follow rule — `scanDir(parent)`; candidates = entries whose header id matches; exactly one, `read` it, its manifest has `base_revision` as ancestor-or-self of its head → re-point the tab (toast `renamed`). (No copy table exists across launches; `known_copies` of the session tab are excluded.)
4. Else card `missing`.
5. Untitled tabs (`path: null`): restored from their draft with title `<title> (recovered)` if the draft has changes; an untitled tab without a draft is dropped.

CHANGED BY fixer (review F2, F5, F6):
- The same-folder follow (step 3) runs **first**, also for cloud paths: a file renamed on the other computer while this one was closed is followed at once. While the 60 s cloud wait is still running, a candidate with a sync-conflict name (`isConflictCopyName`) is not followed (the original may simply not have arrived); after the wait it may be. The `waiting` card has Find it… and ⋯ "Remove from this list".
- Candidates exclude `known_copies` **and** `seen_copies` (new optional `SessionTab.seen_copies: string[]`, last 50): every same-id file the controller has seen beside the file (sibling event or the scan on open). A Finder duplicate is then never taken for the file after a restart.
- A background tab whose header checks out is tracked at once (`track(path, {active:false})`), and `tauriBackend.header()` remembers `{head, analysisId}` for the track (§1.7).
- `open(path)` (§4.5) now does what this section says: the tab is inserted with `status:"opening"` (not active) before the read, and a repeat `open` of a path being opened returns the same promise (one tab per path).

Restored tabs with a draft get banner `recovered` and one toast `restoredDrafts {count}`.

Card actions: `retry(key)` re-runs the open; `findIt(key, dir?)` → §4.11; `forget(key)` removes the tab from the session, keeps the draft, marks the Recent entry `missing`; `openPrivacySettings()` → desktop: `invoke("open_url", {url:"x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders"})`.

### 4.6 Draft on open (plan §4.5)

- `draft.base_revision == file head` → `replaceWorking(draft)`: unsaved changes.
- base is a strict ancestor of the head → `loadFile` from the **draft's base is not available**, so: load the file, `replaceWorking(draft)`, set the tab's `baseRevision` to the draft's base, add banner `newerOnDisk` (the normal "newer version on disk" flow; Save meets a conflict).
- base not in the file's history → load the file clean; banner `draftMismatch {when}` with `openAsNew` (opens the draft as an untitled document, then deletes that draft key) and `discardDraft`.

### 4.7 Poll events → what the controller does

All checks are skipped for a tab that is `saving`. `R` = tab base, `H` = head reported.

| event | clean tab | tab with unsaved changes |
|---|---|---|
| `changed` / `back`, `H` descends from `R` | read; active tab: `loadFile` in place if `editSerial` and base still match after the read (else treat as unsaved), toast `reloaded {version}`; background tab: just update `baseRevision` | read (journals it); banner `newerOnDisk {version}` — actions `choose`, `later` |
| `changed` / `back`, `H` is a strict ancestor of a head journaled for this path, and `H != accepted_head` | banner `rolledBack {version}` — `useEarlier`, `backToLatest`; the tab keeps its content | same |
| `changed` / `back`, `H` neither descends from nor is an ancestor of my newest journaled head for this path (another computer saved over my save) | write my journaled version beside the file as `<stem> (my version from <this computer>).lag` (`readJournal` → `save` with `expectedHead:null`), add it to `known_copies`, reload from disk, banner `savedOver {name: copy, path}` — `openCopy`, `dismiss` | banner `newerOnDisk` (the conflict sheet handles it at Save; "take theirs" writes my copy) and additionally the copy of the journaled version as on the left |
| `moved` | re-point tab, Recent and session; `setFileRef`; toast `renamed {name}` | same |
| `missing` | banner `missing {name, folderLabel, candidates}` — `findIt`, `saveAs`; the document stays open and editable | same |
| `back` | remove `missing` / `downloading` / `permission` / `replaced` banners, then as `changed` | same |
| `unreadable` | `Dataless`/`Incomplete`/`OfflineOrTimeout` → banner `downloading {service}`; `PermissionDenied` → banner `permission` | same |
| `replaced` | banner `replaced` — `saveAs` | same |
| `sibling` | §"copies" below | same |

`useEarlier`: set `accepted_head = H`, load `H`. `backToLatest`: `readJournal(aid, J)` and `save` it over the file (`expectedHead: H`, manifest = the journal copy's, `newParts` = all its parts); then reload.

**Copies (plan §4.3, §4.4, §9.4)** — on `sibling`, and on open via `scanDir(parent)`:

- Sibling path in `known_copies` → ignore.
- Read the sibling. Relation of its head to the tab's: `older`/`same`/`newer`/`diverged`.
- If its name is not a sync-conflict name (`/conflicted copy|conflict|\(unsynced from /i`, or OneDrive's `<stem>-<DEVICE>`; **CHANGED BY impl:ts-core:** also this app's own `(my version from …)` / `(version from …)` copies, so the *other* computer gets the extra-copy note for them instead of the "separate or same?" question) and no answer is stored → banner `copyQuestion {name: this, path: sibling}` — `separate`, `same`. `separate` → rewrite **the sibling** as a new analysis (new `analysis_id`, `forked_from {analysis_id, revision_id: its head}`, one new revision `kind:"save"` on top of its history, same content) with `save(expectedHead: its head)`, and add it to `known_copies`. **CHANGED BY impl:ts-core:** written with `save(expectedHead: null, replaceExisting: true, docKey: <the sibling's tab key if it is open, else a fresh one>)` instead. With `expectedHead: its head` the save would always be refused with `IdentityMismatch` by §1.4 step 2 (the file at the path has the old analysis id, the request the new one, and `replaceExisting` is only for `expectedHead: null`). The old version of the copy goes to `displaced/` (reason `"replaced"`), so nothing is lost; the cost is no head check between the read and the write (a remote save landing in that gap is displaced, not lost). Same for `notSame`. `same` → store `copy_answer[sibling] = "same"` and go on to the next rule.
- Else banner `extraCopy {name: sibling, path, relation, version}`: `older`/`same` → actions `dismiss` only; `newer`/`diverged` → `notSame` (does what `separate` does), `later`. Phase 1 only warns; nothing is removed or combined.
  CHANGED BY fixer (review F4): `newer` (the copy strictly descends from my version, e.g. a colleague's edited copy saved next to mine) → actions `updateMine`, `notSame`, `later`. `updateMine` on an `extraCopy` saves the copy's file over mine (`expectedHead` = my file's head; lossless: my versions are in its history), stores `copy_answer = "same"` and reloads the tab (clean) or shows `newerOnDisk` (unsaved changes). The "same analysis at another path" check below also runs for Recent entries **in the same folder**, but there only for the `newerCopy` case (a returned copy saved next to my file); such a path then skips the copy question.

**Same analysis at another path (plan §4.3)** — on open of path `P` with id `A`: for the other paths `Q` that Recent lists with `analysis_id == A` and whose `header(Q)` reads: `Q`'s head is a strict ancestor in `P`'s manifest → banner `newerCopy {path: Q, folderLabel, version: P's head}` — `updateMine` (save `P`'s content over `Q`: `save({path:Q, expectedHead: Q's head, manifest: P's, newParts: all})`, then close this tab and open `Q`), `later` ("Open separately"). `P`'s head is a strict ancestor of `Q`'s (needs `read(Q)`) → banner `olderCopy {path: Q, folderLabel, version: Q's head}` — `openThatOne`, `later`. Equal or diverged → `copyQuestion` as above. This is the "sent to a colleague and came back" flow.

### 4.8 Journal invariant (plan §8)

`checkInvariant(path, manifest)`: `heads = journalHeads(aid, path)`; ignore confirmed ones and the manifest's head itself. For the newest unconfirmed `J`: disk head descends from `J` → fine. Disk head is a strict ancestor of `J` (needs `readJournal(aid, J)` to see `J`'s history) and `!= accepted_head` → `rolledBack`. Otherwise → `savedOver`. Run on open, on `changed`/`back`, and at startup for the 20 newest Recent paths that are **not** open: `header` only; if its head is not among the journaled heads for that path, mark nothing and do nothing more in phase 1 except set `RecentItem.missing` when the header read says `NotFound`.

### 4.9 Save, Save As, Duplicate, conflict

**`save(key?)`** — works for the active tab (from the store) and for a background tab (from its draft; a background tab without a draft has nothing to save):

1. `flushScratch({commitEdit:true})`. Untitled → `saveAs("new")`. `readOnly` → `{ok:false, reason:"failed"}` with banner `tooNew`. Scratchpad over `SCRATCH_LIMIT` → banner `saveFailed`.
2. Build the four parts (`makePart`), `content_hash`. Equal to the base revision's → mark saved, delete the draft, `{ok:true}` without writing.
3. New revision `{id: r-<ulid>, parents:[base], kind:"save", time, user_name, device_id, device_name, session_id, app_version, summary, sections, content_hash}`; manifest = the file's manifest (kept from the last read / save, per tab) with the revision appended and `head` set; `format_version 1`, `min_reader_version 1`, `features 1`, `app {name:"Lab Analysis Suite", version, platform}`.
   CHANGED BY fixer (review V6, V5): (a) every manifest the controller writes (save, keep mine) keeps full snapshots only for the head, the newest 20 versions, both parents of every combined version and every version whose next version was saved on another device (plan §7.2 without the 180-day limit); older versions keep their entry with `sections: null` (`pruneSnapshots` in docCodec.ts). (b) Every file the controller reads (and every journal copy) goes through `withAbsentSnapshotsDropped`: an older version whose parts aren't all in the file gets `sections: null`, so the next save never names parts that exist nowhere.
   CHANGED BY fixer (review V1, V2, V5): one save per tab at a time (a second `save(key)` while one runs returns the running one's promise). A save that finishes after its tab was left keeps the kept changes written when it was left if they differ from what was saved (re-based on the new head; the tab stays "unsaved"). `resolveConflict` first takes in edits made since the working copy was built (typed during the save, or kept changes written since): it rebuilds and journals the working copy; "Use theirs" writes a newer copy if more was typed while the copy was written.
4. `backend.save({path, expectedHead: base, analysisId, docKey, manifest, newParts})`.
5. Result:
   - `saved` → `markFileSaved` (baseline from the round-tripped file form), delete draft, session, Recent, toast `saved`; if `path` differs from the request (followed a rename) also re-point + toast `renamed`.
   - `savedButDisplaced {displacedHead}` → as `saved`; then `readJournal(aid, displacedHead)` → write it beside the file as `<stem> (version from <their device>).lag` (`known_copies`), banner `savedDisplaced {name, path, version}`.
   - `savedAside` → the tab stays on its path, still dirty, draft kept; add the aside path to `known_copies`; banner `savedAside {name: aside stem, path}`.
   - `conflict {head}` → `read(path)` (theirs; journals it); `writeJournal(path, <working copy as a real revision W = parents [base]>)`; open dialog `{kind:"conflict", info}`; tab `notSaved`; `{ok:false, reason:"conflict"}`.
   - `missing` → banner `missing`; `{ok:false, reason:"failed"}`.
   - error → banner `saveFailed {message}` with actions `retry`, `dismiss`; draft kept. Messages: `PermissionDenied` "The file's folder can't be written to."; `Io` "The file couldn't be written. Check that the disk isn't full."; `OfflineOrTimeout` "The folder didn't answer in time."; `IdentityMismatch` "A different analysis is saved under this name."; `TooNew` "This file was made with a newer version of Lab Analysis Suite."; `Invalid` "The file couldn't be put together. Nothing was changed."

**`resolveConflict(choice)`** (dialog `conflict`; `T` = their head, `W` = my journaled working revision):

- `keepMine` → revision `K`: `id = mergeRevisionId([T, W.id], content_hash)`, `parents: [T, W.id]`, `kind: "merge"`, content = mine, `summary: "Kept this computer's version"`. Manifest = union of their manifest's revisions and mine (+ `W`, `K`), by id, non-null `sections` winning; `head = K`. `save({expectedHead: T, newParts: my parts})`. Theirs stays in the history (openable in phase 2). On another `conflict` the sheet reopens with the newer `theirs`.
  `mergeRevisionId(parents, contentHash)` = `"r-m-" + sha256Hex([...parents].sort().join("\n") + "\n" + contentHash).slice(0, 26)`.
- `takeTheirs` → write `W` beside the file as `<stem> (my version from <this computer>).lag` (same analysis id; `save` with `expectedHead:null`; free name with ` 2`…); add to `known_copies`; load theirs into the tab; delete the draft; banner `tookTheirs {name: copy stem, path, version: theirs}` — `openCopy`, `dismiss`.
- `separateCopy` → pick a place (suggested `<stem> (my copy).lag`); write mine there as a **new analysis** (as Save As "new"); the tab moves to the new file; the original path stays in Recent, untouched on disk.
- `cancel` → close the sheet; banner `notSaved {version: theirs}` with action `choose` (reopens the sheet).

Banner action `choose` on `newerOnDisk` does steps "read theirs + journal W + open the sheet" without attempting a save (`origin:"banner"`).

**`saveAs(mode = "ask")`**: pick a place (suggested `<title>.lag`, start folder = the file's folder). Extension `.lag` is added when missing. If `mode == "ask"` → dialog `saveAsKind {preselect}`: `same` when the source `isTempLocation`, else `new`. Untitled documents skip the question (`new`).
- `new` → new `analysis_id`, `forked_from {analysis_id, revision_id: base}` (null for untitled), `created` = now / this device, **one root revision** (`parents: []`, `kind:"save"`) with the current content; row/column ids kept.
- `same` → same id and full history; a new revision only if there are unsaved changes.
- Both: `save({expectedHead:null, replaceExisting:true, …})` (the OS dialog already asked about replacing; the preview picker asks itself). Refused with banner `saveFailed` when the chosen path is open in another tab. The tab re-points to the new path; old path stays in Recent; untrack old / track new.

**`duplicate()`** ("Duplicate as a new analysis…"): pick a place (suggested `<title> copy.lag`); write as Save As "new" with the current content **without** changing the current tab (it keeps its path, base and unsaved state); open the new file in a new tab.

**`closeTab(key?)`**: clean, or untitled and never edited → close. Dirty → dialog `closeDirty`: `save` → save then close (stays open if the save did not succeed); `discard` → delete draft, close; `cancel` → `false`. Closing = untrack, remove from session, activate the neighbour tab (right, else left, else start screen).

**`reloadFromDisk(key?)`**: clean tab only; `read` + `loadFile`.

### 4.10 Dialogs for paths

`pickPath(req: PathPickerRequest): Promise<string | null>` inside the controller:

- Desktop: `@tauri-apps/plugin-dialog` — `open({multiple:false, filters:[{name:"Lab Analysis Suite analysis", extensions:["lag"]}], defaultPath})`, `save({filters:[same], defaultPath: <startDir>/<suggestedName>})`, `open({directory:true})`. (`dialog:allow-open` / `dialog:allow-save` are already granted in `capabilities/default.json`.)
- Preview: set `pathPicker = req`, resolve when the UI calls `answerPathPicker(path | null)`. For mode `save` on an existing path the **UI picker** asks "Replace 'x'?" before answering.

### 4.11 Find it…

`findIt(key, dir?)`: no dir → `pickPath({mode:"folder", title:"Choose a folder to search"})`. Open dialog `{kind:"find", find:{phase:"scanning", …}}`; `backend.locate(dir, analysisId, onProgress)` updates `scanned`. Result → `phase:"results"`. Exactly one match → use it at once (dialog closes, toast `renamed`). `chooseFound(path)` re-points the tab (session, Recent, track) and opens it; a draft is applied by §4.6. `cancelFind()` cancels the search and closes the dialog. The UI's "Choose another folder" button calls `findIt(key)` again.

### 4.12 Quit routine (frontend half; Rust half in §6.3)

`quitRoutine(source)`:

1. Re-entry while one is running → returns the same promise.
2. `flushScratch({commitEdit:true})`; write the active tab's draft if dirty; write the session. (Background tabs already have theirs.)
3. `source == "update"` → resolve `true` (unsaved changes come back after the restart).
4. No dirty tab → resolve `true`.
5. Else, in the desktop, `invoke(CMD.quitReply, {requestId, stage:"flushed"})`, then dialog `{kind:"quit", dirty}`:
   - `saveAll` → `save(key)` for each dirty tab in strip order (untitled ones go through Save As). The first that does not return `ok` stops the run: `switchTab` to it, resolve `false`.
   - `keep` → resolve `true`. This is the default button.
   - `cancel` → resolve `false`.
6. The `EVT.quitRequested` handler calls `quitRoutine(req.source)` and then `invoke(CMD.quitReply, {requestId, stage: ok ? "proceed" : "cancel"})`.

### 4.13 Menu

`menu(id, path?)`: `file.new` → `showStart()` + `focusSerial++`;
CHANGED BY fixer (review F3): `file.save`, `file.save_as`, `file.duplicate` and `file.close_tab` act only when the Graphs tool is on screen (`SessionDeps.graphsVisible()`, a DOM check by default); otherwise they only do `focusSerial++` (bring Graphs forward). `file.recover`, `file.old_library` and `file.export_library` also do `focusSerial++` before opening their dialog. Original text:  `file.open` → `open()` + focus; `file.open_recent` → `openRecent(path)` + focus; `file.clear_recent` → `writeRecent([])`; `file.save` → `save()`; `file.save_as` → `saveAs()`; `file.duplicate` → `duplicate()`; `file.close_tab` → `closeTab()`; `file.recover` → `openRecover()`; `file.export_library` → `openExport()`; `file.old_library` → `openOldLibrary()`; `app.settings` → `openSettings()`; `app.about` → `aboutSerial++`; `app.quit` → nothing in the desktop (Rust sends `quit-requested`); in the preview → `quitRoutine("menu")`.

The controller calls `invoke(CMD.setMenuState, {state})` (debounced 100 ms) whenever `activeKey`, the active tab's `readOnly`/`saving`, `recent` or `oldLibrary` change: `hasDoc = activeKey != null`; `canSave = hasDoc && !readOnly && !saving`; `recent` = first 10 with `label = "<name> — <folderLabel>"`.

### 4.14 Preview backend and simulator

- World: `MemoryWorld({mode:"dropbox"})`; this computer `{device_id:"d-preview-this", device_name:"This Mac"}`; other computer `{device_id:"d-preview-other", device_name:"Office iMac", user_name:"Alice"}`; both with 0 ms sync delays. Folders seeded on first run: `/Users/me/Dropbox/Lab`, `/Users/me/Dropbox/Shared`, `/Users/me/Documents`, `/Users/me/Downloads`, with one sample file `/Users/me/Dropbox/Lab/Dose response.lag` (a real document built with `docCodec`, real hashes). `appInfo` → `{homeDir:"/Users/me", tempDirs:["/Users/me/Downloads","/private/tmp"], platform:"macos", appVersion:"preview", stateDir:"(preview)", debug:true}`.
- Clock: the `ManualClock` is driven by `setInterval(250 ms)` → `clock.advance(250)`; `DevSimApi.advance(ms)` jumps ahead. The device's poll behaviour is the memory backend's own (events on change; 5 s missing confirm).
- Persistence: the whole world (`exportState`) in `localStorage["las.files.preview.v1"]` after every change, restored on load — so "files left open are reopened on startup" can be tested with a page reload. `DevSimApi.reset()` removes the key and reloads.
- `devSim()` returns the `DevSimApi` (contract.ts) when `import.meta.env.DEV` and not Tauri, else `null`; the same object is on `window.__lasSim` for verifiers. Each method's meaning is in its doc comment. `remoteEdit` must produce a real next revision (parent = current head, author = the other computer) through `docCodec`, changing the first table cell (`section:"table"`, default) or the figure title.

### 4.15 Tests TS core must ship (vitest, `*.test.ts` beside the code, all on `memoryBackend`)

Session controller scenarios with two `MemoryDevice`s and the `ManualClock`: open/save/reopen is clean; tab switch keeps both tabs' unsaved work; cap 12; draft restore for titled and untitled; restore with missing / waiting / rename-followed files; `changed` reloads a clean tab and banners a dirty one; conflict sheet — each choice loses no revision (every head ever produced is in a file on disk or in the journal); rollback banner both actions; saved-over copy; `savedButDisplaced` and `savedAside` banners; copy question both answers; `newerCopy` "update mine"; Find it one / several / none; export library twice (second run exports nothing new, ids stable); quit routine outcomes. Plus `docCodec` (open → save → reopen → save byte-identical for every fixture) and `paths`.

---

## 5. TS UI

All new components in `src/components/graph/files-ui/`. Use MUI like the rest of the app. Every interactive element listed gets the `data-testid` shown (verifiers drive the preview with them).

### 5.1 Components

| file | what | where mounted |
|---|---|---|
| `FilesHost.tsx` | calls `useFileSession.getState().init()` once; renders the modal for `dialog`, `PathPicker` for `pathPicker`, `Toasts`, and in the preview `SimPanel`; preview-only key handling (Ctrl/Cmd+S save, +Shift+S save as) | `App.tsx`, beside `<UpdaterHost />` |
| `FileTabs.tsx` | tab strip `file-tabs`; one `file-tab-<key>` per tab: title, unsaved dot `tab-dirty`, icon for `notSaved` / a card / `readOnly`, close button `tab-close`; `+` button `tab-new` (→ `showStart()`); click → `switchTab` | top of `GraphView`, always (also on the start screen when tabs exist) |
| `DocBar.tsx` | replaces `FileBar`: title (the file name; not editable), second line `folderLabel` with a Reveal button `doc-reveal` (desktop only), status text (`Saving…`, `Not saved`, `Unsaved changes`, `All changes saved`), Save button `doc-save`, File menu button `file-menu-button` | under the tab strip when a tab is active and has no card |
| `FileMenu.tsx` | the dropdown of the File menu button, same items and order as the native menu (§6.1), each calling `menu(id)`; shows the shortcut text; "Open Recent" as a submenu; a small badge on "Export library to files…" when `oldLibrary.unexported > 0` | in `DocBar` and on the start screen |
| `BannerSlot.tsx` | shows `tab.banner` (`file-banner`, `data-kind=<kind>`), buttons `banner-<action>`, × `banner-dismiss`; "+n more" when there are more | under `DocBar`, above the canvas tabs |
| `RestoreCardView.tsx` | the card for the active tab (`restore-card`, `data-kind`) instead of the workspace | canvas area |
| `RecentFiles.tsx` | list `recent-list` of `recent` (`recent-item`): name, folder line, "opened <when>", "Can't be found" chip for `missing`, ⋯ menu: Remove from this list | start screen, replacing "Saved analyses" |
| `ConflictSheet.tsx` | dialog `conflict` (`conflict-sheet`; buttons `conflict-keepMine`, `conflict-takeTheirs`, `conflict-separateCopy`, `conflict-cancel`) | `FilesHost` |
| `SaveAsKindDialog.tsx` | dialog `saveAsKind` (`saveas-new`, `saveas-same`, `saveas-cancel`) | `FilesHost` |
| `CloseDirtyDialog.tsx` | dialog `closeDirty` (`close-save`, `close-discard`, `close-cancel`) | `FilesHost` |
| `QuitDialog.tsx` | dialog `quit` (`quit-saveAll`, `quit-keep`, `quit-cancel`) | `FilesHost` |
| `FindDialog.tsx` | dialog `find` (`find-dialog`, rows `find-match`, `find-another`, `find-cancel`) | `FilesHost` |
| `SettingsDialog.tsx` | dialog `settings` (`settings-user`, `settings-device`, `settings-save`) | `FilesHost` |
| `ExportLibraryDialog.tsx` | dialog `export` (`export-start`, `export-retry`, `export-close`) | `FilesHost` |
| `OldLibraryDialog.tsx` | dialog `oldLibrary`: the old in-app list, read-only, each row with **Open a copy** (→ `importLibraryRow(id)`) | `FilesHost` |
| `RecoverDialog.tsx` | dialog `recover`: rows with Open (→ `recoverDraft`) and Delete (→ `deleteDraft`, after a confirm) | `FilesHost` |
| `PathPicker.tsx` | preview only (`path-picker`): folder list from `devSim().folders()`, files from `devSim().files()`, a name field `path-picker-name` (save mode), OK `path-picker-ok`, Cancel `path-picker-cancel`; asks before replacing an existing file | `FilesHost` |
| `SimPanel.tsx` | preview only: collapsible panel bottom-left (`sim-panel`, toggle `sim-toggle`) titled "Other computer (test)". Pick a file, then buttons: Edit and save (`sim-edit`), Make a conflicted copy (`sim-conflict`), Save over it (`sim-replace`), Put back earlier version (`sim-rollback`), Rename (`sim-rename`), Move (`sim-move`), Delete (`sim-delete`), Duplicate in Finder (`sim-duplicate`), Send back edited copy (`sim-sendback`), Online-only on/off (`sim-dataless`), Block folder (`sim-deny`), Race next save (`sim-race`), Offline next save (`sim-offline`), +10 s (`sim-advance`), Reset (`sim-reset`) — each calls the `DevSimApi` method of the same meaning | `FilesHost` |
| `Toasts.tsx` | `toasts` as snackbars (auto-hide 5 s; errors 8 s) | `FilesHost` |
| `text.ts` | every string below; `whenText(iso)` ("just now", "5 min ago", "2 h ago", "yesterday", "12 Nov"); `whoText(version, settings)` | — |

Until TS core's `session.ts` exists, the UI implementer builds against a **scratch-only** stub `src/components/graph/file/session.ts` (`create<FileSessionState>(…)` with hand-set states) and does not copy it to the repo.

### 5.2 Changes to existing files (UI)

- `App.tsx`: mount `<FilesHost />`.
- `AppShell.tsx`: subscribe to `useFileSession` `focusSerial` → `select("graph")`; `aboutSerial` → `setAboutOpen(true)`.
- `GraphView.tsx`: layout becomes `FileTabs` → (`DocBar` → `BannerSlot` → existing canvas tabs/body) or `RestoreCardView` or the start screen. Remove the two legacy draft effects (restore-on-mount, debounced `writeDraft`) and `useGraphLibrary` from this view — the controller owns drafts. `if (!doc) → StartScreen` becomes: `activeKey == null` → start screen; active tab has a card → card; `busy` or no `doc` yet → a centred spinner. In `onKeyDown`, drop the Save / Save As / New / Open shortcuts in the desktop (the native menu has them); keep undo etc.
- `GraphLibrary.tsx`: `StartScreen` keeps the three template cards but **Start empty / Start with sample data call `useFileSession.getState().newDoc(t, sample)`**; the intro sentence becomes "Type or paste data into a table, pick a test and get a publication-ready graph. Each analysis is saved as a file you can keep in any folder."; below the cards: buttons **Open…** (`start-open`) and the File menu button; then "Recent files" (`RecentFiles`); then, when `oldLibrary.total > 0`, a line "Analyses saved before files: **Old library…** · **Export library to files…**" (`start-old-library`, `start-export`). `FileBar` is no longer used (delete it or leave it unexported). `LibraryList` / `useGraphLibrary` stay for `OldLibraryDialog` with rename / duplicate / delete buttons removed (the old library is a read-only backup).
- `src/store/updaterStore.ts` `restart()`: `await useFileSession.getState().quitRoutine("update")` **before** `relaunch()` (this is the only `relaunch()` call in `src/`).

### 5.3 Banner wording

`{name}` = `banner.name`, `{folder}` = `banner.folderLabel`, `{who}` = `whoText(banner.version)` ("Alice (Office iMac)"; for the same user name as mine: "you on Office iMac"), `{when}` = `whenText(...)`, `{service}` = `banner.service ?? "the cloud folder"`.

| kind | severity | text | buttons (action → label) |
|---|---|---|---|
| `permission` | error | macOS hasn't allowed Lab Analysis Suite to read this folder. | `openPrivacy` → Open Privacy settings · `retry` → Retry |
| `downloading` | info | Downloading from {service}… | — |
| `missing` | warning | '{name}' is no longer in {folder} (moved or deleted, possibly on another computer). Your work is still here. | `findIt` → Find it… · `saveAs` → Save a new copy here |
| `replaced` | warning | A different analysis is now saved under this name. Your work is still here. | `saveAs` → Save as a new file… |
| `tooNew` | info | Made with a newer version of Lab Analysis Suite. Update to edit. | — |
| `saveFailed` | error | Not saved. {message} | `retry` → Try again · `dismiss` |
| `notSaved` | warning | Not saved yet — {who} also changed this file. Choose what to keep. | `choose` → Choose… |
| `savedAside` | warning | The file couldn't be checked yet, so your changes were saved beside it as '{name}'. | `dismiss` → OK |
| `savedOver` | warning | Another computer saved over your last save. Nothing is lost — your version was saved as a copy: '{name}'. | `openCopy` → Open the copy · `dismiss` → OK |
| `savedDisplaced` | warning | Saved. {who} saved at the same moment; that version was kept as a copy: '{name}'. | `openCopy` → Open the copy · `dismiss` → OK |
| `tookTheirs` | info | Now showing the version saved by {who}. Your version was saved as a copy: '{name}'. | `openCopy` → Open the copy · `dismiss` → OK |
| `draftMismatch` | warning | You have unsaved changes from {when} that don't match this file. | `openAsNew` → Open them as a new analysis · `discardDraft` → Discard |
| `copyQuestion` | info | '{other}' started as a copy of '{this}'. Is it a separate analysis, or another copy of the same one? (`{other}` = file name of `banner.path`, `{this}` = `banner.name`) | `separate` → A separate analysis · `same` → The same analysis |
| `extraCopy` (older / same) | info | '{name}' is an older copy of this analysis. | `dismiss` → OK |
| `extraCopy` (newer / diverged) | warning | A second copy of this analysis, '{name}', has changes by {who}. | `notSame` → This is a different analysis · `later` → Later |
| `tempLocation` | info | This file is in a temporary folder. Choose where to keep it before editing. | `chooseLocation` → Choose where to keep it… (→ `saveAs("ask")`, "same" preselected) |
| `rolledBack` | warning | This file was put back to an earlier version ({when}, saved by {who}). | `useEarlier` → Use the earlier version · `backToLatest` → Go back to my latest |
| `newerOnDisk` | info | {who} saved a newer version. | `choose` → Choose what to keep… · `later` → Later |
| `newerCopy` | info | This is a newer version of '{name}' (saved by {who}, {when}). Your own file is in {folder}. | `updateMine` → Update my file with it · `later` → Open separately |
| `olderCopy` | info | A newer version (saved {when}) is in {folder}. | `openThatOne` → Open that one · `later` → Keep working here |
| `recovered` | success | Unsaved changes from {when} restored. | `dismiss` → OK |

`later` and `dismiss` both go through `bannerAction` (the controller removes the banner; `later` banners come back on the next relevant event).

### 5.4 Cards (`RestoreCardView`)

| kind | text | buttons |
|---|---|---|
| `waiting` | Waiting for {service}… / "'{name}' hasn't arrived on this computer yet." (spinner) | — |
| `downloading` | Downloading from {service}… (spinner) | — |
| `missing` | **Can't find '{name}'.** Last seen in {folder}. | Retry (`card-retry` → `retry`) · Find it… (`card-find` → `findIt`) · ⋯ menu (`card-more`): Remove from this list (the file was deleted) (`card-forget` → `forget`) |
| `permission` | **macOS hasn't allowed Lab Analysis Suite to read this folder.** {folder} | Open Privacy settings (`card-privacy` → `openPrivacySettings`) · Retry |
| `unreadable` | **'{name}' can't be read.** It may still be downloading, or it isn't a Lab Analysis Suite analysis. | Try again · Close tab (→ `closeTab`) |

When `hasDraft`: one more line "Your unsaved changes for this file are kept."

CHANGED BY fixer (review F1, F2): `waiting` body adds "If it was moved, use Find it…" and gets Find it… (`card-find`) and ⋯ Remove from this list (`card-more` / `card-forget`); `downloading` gets Show in Finder (`card-reveal`, desktop) and Close tab (`card-close`). A tab still being read shows a small spinner in the tab strip. `newerOnDisk` with `relation:"older"` (after "Use the earlier version" with unsaved changes) reads "The file now has the earlier version saved by {who}. Your unsaved changes are still here." Toast `renamed` shows `message` when given ("Found in {folder}" after Find it… in another folder). A save that finds no file also shows the toast "Not saved — the file can't be found. Use Find it… or save a new copy."

### 5.5 Dialogs

- **Conflict** — title "Not saved yet — {who} also changed this file". Body: "Choose what to keep. Nothing is lost either way." Three choices as large buttons with a second line each:
  - **Keep mine** — "Save my version as the newest. {who}'s version stays in the file's history."
  - **Use theirs** — "Show {who}'s version. Mine is saved as a copy next to the file."
  - **Save mine as a separate copy…** — "Choose a place for my version. This file is left as {who} saved it."
  - Cancel ("Decide later") — the tab stays "Not saved".
- **Save As kind** — "Is this a new analysis (for example a new experiment based on this one), or the same analysis in a new place?" Radio: **A new analysis** / **The same analysis in a new place**; buttons Save, Cancel. Subtitle: "Saving to {folder} as '{name}'".
- **Close with unsaved changes** — "Save changes to '{title}' before closing?" Save · Discard changes · Cancel.
- **Quit** — "You have unsaved changes in {n} analyses." (list of titles; "1 analysis" singular). Buttons: Save all · **Quit and keep unsaved changes for next time** (default) · Cancel.
- **Find** — scanning: "Looking in {folder}… {scanned} items checked" + Cancel. Results: several → "Found {n} copies. Choose the one to open." rows: path label · "saved by {who}" · {when}, first preselected, Open; none with online-only → "{n} files haven't been downloaded to this computer yet:" + names + "Download them in Finder, then try again."; none → "Not found in this folder."; `truncated` → extra line "The folder was too large to search completely."; `skippedFolders` → "{n} folders couldn't be read." Always: Choose another folder · Close.
- **Settings** — title "Settings". Fields: **Your name** (helper: "Shown to others on versions you save."), **This computer's name** (helper: "Tells your computers apart, for example 'Office iMac'."). Save · Cancel.
- **Export library** — confirm: "Analyses are now saved as files. Export your {total} saved analyses to a folder?" (+ "{already} are already exported." when > 0) Choose folder… · Not now. Running: progress "{done} of {total}". Done: "{done} of {total} exported." + when failed: "{k} failed:" list "name — reason" + Try again; closing line: "Your analyses are now ordinary files in {folder}. The old in-app list is kept unchanged as a backup."
- **Old library** — title "Old library", line "Analyses saved inside the app before files. This list is a backup and isn't changed." Rows: name · template · updated · **Open a copy**. Footer: Export library to files… · Close.
- **Recover unsaved work** — rows "{name} — {folder} — unsaved changes from {when}" · Open · Delete. Empty: "No unsaved work is waiting."

Toasts: `renamed` "Renamed to '{name}'" · `saved` "Saved" · `reloaded` "Updated to the version saved by {who}" · `tabLimit` "12 analyses are open. Close one to open another." · `alreadyOpen` "'{name}' is already open." · `restoredDrafts` "Unsaved changes restored." · `error` → `message`.

Words never shown in the UI: revision, head, journal, hash, manifest, draft (say "unsaved changes"), sibling, displaced, analysis id.

---

## 6. Rust: menu and quit

### 6.1 Menu (`menu.rs`)

Built with `tauri::menu` (`SubmenuBuilder`, `MenuItemBuilder`, `PredefinedMenuItem`) in `Builder::menu(|h| …)`, events in `Builder::on_menu_event` — the approach of the spike (`spikes/menuapp/src-tauri/src/lib.rs`, `build_menu`). Every custom item emits `app://menu {id, path:null}`.

macOS layout:

| menu | items |
|---|---|
| **Lab Analysis Suite** | About Lab Analysis Suite (`app.about`, custom) — separator — Settings… (`app.settings`, `CmdOrCtrl+,`) — separator — Services — separator — Hide, Hide Others, Show All (predefined) — separator — Quit Lab Analysis Suite (`app.quit`, **custom**, `CmdOrCtrl+Q`) |
| **File** | New (`file.new`, `CmdOrCtrl+N`) · Open… (`file.open`, `CmdOrCtrl+O`) · Open Recent ▸ (submenu id `file.open_recent`; items `file.open_recent.<i>`; separator; Clear Menu `file.clear_recent`) — separator — Save (`file.save`, `CmdOrCtrl+S`) · Save As… (`file.save_as`, `CmdOrCtrl+Shift+S`) · Duplicate as a New Analysis… (`file.duplicate`) — separator — Close Tab (`file.close_tab`, `CmdOrCtrl+W`) — separator — Recover Unsaved Work… (`file.recover`) · Old Library… (`file.old_library`) · Export Library to Files… (`file.export_library`) |
| **Edit** | exactly what `Menu::default` has: Undo, Redo, separator, Cut, Copy, Paste, Select All (predefined) |
| **View** | Enter Full Screen (predefined), as `Menu::default` |
| **Window** | Minimize, Zoom (predefined). **No** predefined Close Window (Cmd+W is Close Tab; the red button still works). |

Windows/Linux: same File / Edit / Window menus on the window; Settings… and Quit go at the end of File (`Exit`, no accelerator on Windows — Alt+F4 is the window path).

`app_set_menu_state {state}`: enable/disable Save (`canSave`), Save As / Duplicate / Close Tab (`hasDoc`), Export (`canExportLibrary`), Old Library (`hasOldLibrary`); rebuild the Open Recent submenu from `state.recent` (item text = `label`; empty → one disabled item "No Recent Files"). A click on `file.open_recent.<i>` emits `{id:"file.open_recent", path: recent[i].path}`. Initial state before the first call: Save / Save As / Duplicate / Close Tab / Export / Old Library disabled.

### 6.2 `applicationShouldTerminate:` hook (`quit_macos.rs`, macOS only)

Exactly the spike's working approach (`install_should_terminate` / `should_terminate` in the spike's `lib.rs`): in `setup`, on the main thread, take `NSApplication.sharedApplication().delegate()`, get its class (tao's private `TaoAppDelegateParent`), and `class_addMethod(cls, sel!(applicationShouldTerminate:), imp, c"Q@:@")` where `imp` is an `extern "C" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize` returning `1` (NSTerminateNow) or `2` (NSTerminateLater). The reply is `NSApplication::replyToApplicationShouldTerminate(bool)` on the main thread (`app.run_on_main_thread`).

Crates (macOS target only; all three are already in `Cargo.lock` at these versions through tao):

```toml
[target.'cfg(target_os = "macos")'.dependencies]
objc2 = "0.6"
objc2-app-kit = { version = "0.3", features = ["NSApplication", "NSResponder"] }
objc2-foundation = "0.3"
```

CHANGED BY impl:rust: with their default features these two crates pull objc2-cloud-kit / core-data / core-image / … into `Cargo.lock` (more than the allowed `app` / `zip` dependency-list edits). Shipped as `objc2-app-kit = { version = "0.3", default-features = false, features = ["std", "NSApplication", "NSResponder"] }` and `objc2-foundation = { version = "0.3", default-features = false, features = ["std"] }`; the lock diff is then only the `app` and `zip` lists.

Log loudly at startup (`eprintln!` + `log::error!`) if the delegate is null or `class_addMethod` returns false (then only the menu / window / ExitRequested paths protect a quit). `--locked` pins tao 0.34.6, where the class name is `TaoAppDelegateParent`.

### 6.3 Quit handshake (`quit.rs`)

State: `Idle | Asked { id, source, flushed, system_pending, since } | Allowed`, in a `Mutex`, plus `frontend_ready` (set by `take_pending_opens`).

`request(source)`:
- `Allowed` → let the exit go on.
- `frontend_ready == false` → `finish()` at once (nothing to flush; e.g. quit during startup).
- `Asked` already → do not emit again; if `source == system`, set `system_pending` (the hook returns NSTerminateLater).
- `Idle` → `Asked { id: next, … }`, emit `app://quit-requested {requestId, source}`, start the watchdog.

Sources: custom menu item `app.quit` → `menu`; `WindowEvent::CloseRequested` on the main window → `api.prevent_close()` + `window`; `applicationShouldTerminate:` → `system` (return 2 unless `Allowed`, then 1); `RunEvent::ExitRequested { code, api }` with `code != Some(i32::MAX)` and state not `Allowed` → `api.prevent_exit()` + `exit`.

`app_quit_reply {requestId, stage}` (a stale `requestId` is ignored):
- `flushed` → mark `flushed` (the watchdog stops its 5 s count).
- `proceed` → `finish()`.
- `cancel` → `Idle`; if `system_pending` → `replyToApplicationShouldTerminate(false)`.

Watchdog (a thread per request) — **always replies**:
- No stage within **5 s** (`LIMITS.quitFlushMs`) → `finish()` (the page is hung; drafts are at most 1 s old).
- After `flushed` with `system_pending` (Dock quit, logout, shutdown): **60 s** (`LIMITS.quitSystemAnswerMs`) for the person to answer, then `finish()` — the unsaved changes are already on disk as drafts.
- After `flushed` without `system_pending`: wait without limit (the person is looking at the dialog).

`finish()`: state `Allowed`; **stop the engine now** (`kill_sidecar_process`) — the engine is no longer stopped in `ExitRequested`; then, on the main thread, `replyToApplicationShouldTerminate(true)` if `system_pending`, else `app.exit(0)`.

`RunEvent::ExitRequested`: `code == Some(i32::MAX)` (the updater's restart, `RESTART_EXIT_CODE`) → **never** prevent, never start the routine (the frontend already ran `quitRoutine("update")` before `relaunch()`); `Allowed` → let through; otherwise as above. `RunEvent::Exit`: synchronous Rust-only backstop — stop the engine if it is still running. Nothing else in phase 1 (phase 3 adds beacon removal here).

The existing `kill_sidecar` command stays.

---

## 7. File association (`tauri.conf.json`)

Add under `"bundle"` (the spike built and registered with exactly these keys on tauri-cli 2.12.6):

```json
"fileAssociations": [
  {
    "ext": ["lag"],
    "name": "Lab Analysis Suite Analysis",
    "description": "Lab Analysis Suite analysis",
    "role": "Editor",
    "rank": "Owner",
    "mimeType": "application/vnd.labanalysissuite.graph+zip",
    "contentTypes": ["com.zhuojianlook.analysis.graph"],
    "exportedType": {
      "identifier": "com.zhuojianlook.analysis.graph",
      "conformsTo": ["public.data", "public.content"]
    }
  }
]
```

Nothing else in `tauri.conf.json` changes. The Rust implementer checks the built `Info.plist` has `CFBundleDocumentTypes` (role Editor, `LSHandlerRank` Owner, `LSItemContentTypes` = the UTI) and `UTExportedTypeDeclarations` (identifier, conforms to `public.data` + `public.content`, extension `lag`, MIME). Not `public.zip-archive`. An app under `/private/tmp` or `/var/folders` never becomes the default app — test double-click from `~/Library/Caches/LAS-phase1-test-DELETE-ME/`.

---

## 8. Library export (plan §12) — `libraryExport.ts`, TS core

Existing endpoints only (no Python change): `getGraphLibrary()` (`GET /api/graph/library`) and `getGraphAnalysis(id)` (`GET /api/graph/library/get?id=`), plus `backend.save`, `readExportMap` / `writeExportMap`.

`openExport()`: list the library and read the map → dialog `export {phase:"confirm", total, already}`. `exportLibrary(dir?)`: no dir → folder picker. Then for each library row, in list order:

1. Map row `m = map.rows[String(row.id)]`. **Skip** when `m.status == "done"`, `m.saved_at == String(row.updated_at)` and `header(m.path)` reads with `analysis_id == m.analysis_id` (counts as `already`).
2. `getGraphAnalysis(id)` → `migrateDoc(table)` (null → failed "made by a newer version").
3. **Ids, minted once:** `analysis_id = m?.analysis_id ?? new`; if `m.row_ids` / `m.col_ids` exist and their lengths equal the table's rows / columns, put them on the doc before `withIds`; otherwise mint (`withIds`) and record the minted ones. Write the map row (status `failed`, reason "not finished") **before** saving the file, so a crash cannot mint twice.
4. Build the file: sections via the normal load pipeline + `toFileSections` + scratchpad; one root revision `{parents: [], kind: "import", time: now, summary: "From the old library"}`; `created` = this device.
5. Target: `m.path` if it still holds this `analysis_id` (then a new revision `kind:"import"` with `parents:[its head]` and `expectedHead: its head` — only when `saved_at` changed); else `<dir>/<safeFileName(row.name)>.lag`, and if a file is there: same `analysis_id` → use it as just described; another → ` 2`, ` 3`, … No look-alike duplicates on a re-run.
6. `backend.save`; result → map row `{saved_at: String(row.updated_at), analysis_id, path, status: "done"|"failed", error?, row_ids, col_ids}`; `writeExportMap` after every row; update `ExportState`.

Exported files are added to Recent (not opened). `oldLibrary.unexported` = rows without a `done` map row at their current `updated_at`. The SQLite library is never modified. "Old library…" stays reachable while `oldLibrary.total > 0`.

`importLibraryRow(id)` (Old library → "Open a copy"): opens the row as an **untitled** document titled with the row's name, using the map's `analysis_id` / ids when the row was exported, else fresh ones; nothing is written until the person saves.

CHANGED BY fixer (review F10): the code mints a **fresh** `analysis_id` for "Open a copy" (row/column ids from the map are reused). That is the safer choice: reusing the exported file's id would give a second, unrelated file the same identity once saved. This section now says so: "Open a copy" is a new analysis.

---

## 9. Ownership, test seams, golden fixtures

### 9.1 File ownership (no overlaps)

| implementer | owns |
|---|---|
| **Rust** | `TauriApp/src-tauri/**` (sources, `Cargo.toml`, `Cargo.lock`, `tauri.conf.json`, `capabilities/`) |
| **TS core** | `src/components/graph/file/**` except `contract.ts` (read-only for everyone); `src/store/graphStore.ts`; `src/api/graph.ts`; new `src/api/files.ts` if useful |
| **TS UI** | `src/components/graph/files-ui/**` (new); `src/components/graph/GraphView.tsx`; `src/components/graph/GraphLibrary.tsx`; `src/App.tsx`; `src/components/layout/AppShell.tsx`; `src/store/updaterStore.ts` (the `restart()` change only); small hooks under `files-ui/` |

Nobody else touches `DataGrid.tsx`, the scratchpad, `graphModel.ts`, the Python sidecar or CI. `package.json` does not change (no new JS dependency; `@tauri-apps/plugin-dialog` ~2.6.0 already matches the Rust crate).

### 9.2 Testing TS without Tauri

- All TS tests run on `memoryBackend` (vitest, node). `tauriBackend.ts` must be a thin mapping (§1.7 table) with no logic of its own beyond parse / stringify and error mapping, and must import `@tauri-apps/api` **dynamically** (as `src/api/client.ts` does) so the preview and vitest never load it.
- `tauriBackend.ts` takes its `invoke` / `listen` through a small injectable seam (`createTauriBackend({invoke, listen})`), so TS core can unit-test the mapping with a fake `invoke` that returns the reply shapes of contract.ts.
- Rust provides nothing at TS test time. What ties the two together is the golden set below.

### 9.3 Cross-language golden fixtures

Folder: `<scratch>/p1-goldens/`. Paths inside fixtures use the placeholder `$DIR` (replaced by the consumer with its temp folder).

**TS core writes** (vitest test `file/goldens.test.ts`; it writes only when the env var `LAS_P1_GOLDENS` names the folder, and always checks the fixtures are reproducible in memory):

| file | content |
|---|---|
| `ts/save-01-new.json` | `{ "req": SaveArgs }` — new file `$DIR/Dose response.lag`, `expectedHead: null`, one root revision, four parts |
| `ts/save-02-next.json` | `{ "req": SaveArgs }` — second save of the same file: `expectedHead` = head of 01, only the changed part in `newParts` (table), history of two revisions |
| `ts/save-03-stale.json` | `{ "req": SaveArgs }` — based on head of 01 again (a stale base) → must give `conflict` with head of 02 |
| `ts/save-04-unicode.json` | `{ "req": SaveArgs }` — new file `$DIR/Größe µ 试验 😀.lag`; parts containing non-ASCII, an astral character, ` `, escaped quotes and a number like `1e-7` |
| `ts/save-05-badhash.json` | `{ "req": SaveArgs }` — a `newParts` key whose hex does not match its text → must reject `Invalid` |
| `ts/expect.json` | `{ "order": ["save-01-new","save-02-next","save-03-stale","save-04-unicode","save-05-badhash"], "cases": { "<name>": { "reply": {"kind": …, "head"?: …} \| null, "error": "<kind>" \| null, "comment": "LASGRAPH1 … …" \| null, "parts": { "parts/<sha>.json": "<sha256 of text>" } \| null } } }` |

**Rust consumes** (`cargo test goldens`, in `graphfile.rs` tests; reads the folder from env `LAS_P1_GOLDENS`; when unset or `ts/` is missing the test prints "goldens skipped" and passes): runs the cases in `order` against one temp folder through the real save code, asserts each reply / error kind and the ZIP comment, then **writes**:

| file | content |
|---|---|
| `rust/<name>.lag` | the file as it is on disk after that case (for 01, 02, 04) |
| `rust/<name>.reply.json` | the `SaveReply` JSON (or `{"error": RustError}`) with the temp folder replaced by `$DIR` |
| `rust/<name>.read.json` | `ReadReply` of `graphfile_read` on that file (`stat.path` with `$DIR`; `stat.mtime` = 0) |

**TS core reads back** (same `goldens.test.ts`, second half; skipped with a note when `rust/` is absent): for 01, 02, 04 — `read.json.manifestText` is byte-identical to the `manifestText` sent; `parts` texts equal what TS built (02: the three kept parts too); `sha256Hex` of every part text equals its name; and, with a ~40-line ZIP directory reader on `node:zlib`, `rust/<name>.lag` has `mimetype` as first entry (stored) and the expected comment. The integrator runs: TS write → cargo test → TS read.

### 9.4 Rust `cargo test --locked` (must ship)

Container round trip; every validation failure maps to the right kind (truncated at several lengths, flipped byte in a part, comment says another head, wrong mimetype → `Invalid`, zero-byte file); 64 MB limit; save: new / next / stale-base conflict / identity mismatch / missing part / bad hash; kept parts byte-identical; temp name pattern (`.~<name>.tmp-<8 hex>`, never ends in `.tmp`) and no temp left after success or failure; an interrupted write (inject a failure before the rename) leaves the old file intact; `savedButDisplaced` (swap the target between check and rename through a test hook); `savedAside` when the target is invalid for 10 s (make the retry time injectable); follow rule — rename followed; delete-then-create with a conflict copy present must **not** re-point; two candidates → missing; older head → missing; different id never adopted; poll state machine with an injected clock and a temp folder (changed, moved, missing, back, sibling once, unreadable, replaced; own save not reported); locate bounds (depth, entries, time with an injected clock, hidden / bundle / symlink skipping, cancel); journal confirm rule and pruning; device.json create / rename / hardware-hash mismatch (injected id); session / recent (dedupe, cap 50) / drafts / export-map round trips; atomic writes; quit state machine (every transition of §6.3 with injected time, including "watchdog always replies"); pending-opens buffer before and after ready; goldens.

---

## 10. Phase 1 acceptance checklist

"Preview" = Vite preview with the simulator (`localStorage['las.activeTool']='graph'`); "sim" = the Other computer panel or `window.__lasSim`. "App" = debug Tauri build with `LAS_SIDECAR_PORT` / `LAS_STATE_DIR` set, test files only under scratch or `~/Library/CloudStorage/Dropbox/LAS-phase1-test-DELETE-ME`.

**Saving to a file**
1. Preview: New → Start with sample data → Save → path picker → `/Users/me/Documents/A.lag`. Tab title "A", folder line "Documents", no unsaved dot; sim lists the file with a head.
2. Preview: edit a cell → unsaved dot → Save → dot gone; sim shows a new head. Save again with no change → nothing is written (head unchanged).
3. Preview: Save As → new place → question shows with "A new analysis" preselected; choosing it gives a file with a different analysis id; choosing "same" keeps the id. Tab now points at the new file.
4. Preview: Duplicate as a new analysis… → new tab on the new file; the original tab keeps its unsaved changes and path.
5. cargo: goldens pass in both directions (§9.3); a saved file's first entry is `mimetype` (stored), comment `LASGRAPH1 <id> <head>`.
6. App: Save into the Dropbox test folder; in Finder no `.~…tmp-…` file remains; the file opens again after an app restart.

**Tabs**
7. Preview: open three files; edit two without saving; switch between them — each keeps its own unsaved changes; only one document is in the store (`useGraphStore.getState().file.docKey` follows the active tab).
8. Preview: a 13th tab is refused with the "12 analyses are open" message.
9. Preview: close a tab with unsaved changes → Save / Discard changes / Cancel each behave as labelled.

**Reopen on startup, drafts**
10. Preview: two files open, one with unsaved changes, plus an edited untitled document → reload the page → three tabs back, same active tab, unsaved changes restored, the untitled one titled "… (recovered)", "Unsaved changes restored" shown.
11. App: same as 10 across quit and relaunch (quit with "Quit and keep unsaved changes for next time").
12. Preview: after a successful save and reload, no draft is restored for that tab.

**Recognised by id, not name; live rename**
13. Preview: tab open on `A.lag`; sim Rename → `B.lag`; within ~6 s the tab title becomes "B" with "Renamed to 'B'"; Save then writes `B.lag` and does not recreate `A.lag`.
14. Preview: sim Duplicate in Finder (`A copy.lag`), then delete `A.lag` → the tab does **not** jump to the copy; the missing banner appears with Find it….
15. Preview: close the app state (reload) after renaming a file while "closed" (sim Rename, then reload within the session) → the tab is restored on the new name.
16. cargo: follow-rule tests (rename followed; conflict copy present → not followed; two candidates; older head; other id).

**Missing at startup**
17. Preview: sim Move the open file to another folder, reload → card "Can't find '…'. Last seen in …" with Retry, Find it…, and under ⋯ "Remove from this list (the file was deleted)".
18. Preview: Find it… → pick the folder it was moved to → the tab reopens on it (unsaved changes, if any, applied). Pick a folder without it → "Not found in this folder." and "Choose another folder".
19. Preview: "Remove from this list" → tab gone; the file stays in Recent marked "Can't be found"; its unsaved changes are listed under Recover unsaved work….
20. Preview: file under `/Users/me/Dropbox/…` missing at reload → "Waiting for Dropbox…" first; sim restores it within 60 s → the tab opens by itself.
21. Preview: sim Block folder → card "macOS hasn't allowed…" with Open Privacy settings / Retry; unblock + Retry opens.
22. cargo: locate bounds (depth 8, 50,000 entries, 20 s, skips, cancel, online-only counted not read).

**Same file on two computers**
23. Preview: clean tab; sim Edit and save → within ~3 s the tab shows the new content and "Updated to the version saved by Alice (Office iMac)"; no unsaved dot.
24. Preview: tab with unsaved changes; sim Edit and save → banner "Alice (Office iMac) saved a newer version." Save → conflict sheet. Check each choice in turn (fresh setup each time): **Keep mine** → file head is mine, Alice's version is still in the file's history (`__lasSim` / test helper lists revisions); **Use theirs** → tab shows Alice's content and a file "… (my version from This Mac).lag" exists with my content; **Save mine as a separate copy…** → my content in the chosen new file with a new id, original untouched. In every case no revision is lost.
25. Preview: sim Race next save, then Save → "Saved. … that version was kept as a copy: '…'" and the copy file exists.
26. Preview: sim Offline next save, then Save → changes saved beside the file, banner says so, tab still has the unsaved dot.
27. Preview: sim Put back earlier version → banner "This file was put back to an earlier version…"; "Use the earlier version" loads it and the banner does not return after reload; "Go back to my latest" restores my last head on disk.
28. Preview: sim Save over it (replace my last save) → "Another computer saved over your last save. Nothing is lost — your version was saved as a copy: '…'"; the copy holds my last saved content.
29. Preview: sim Make a conflicted copy → warning banner about a second copy; nothing is deleted or merged.
30. Preview: sim Duplicate in Finder next to the open file → the copy question; "A separate analysis" gives the copy a new id (no further banners); "The same analysis" leads to the extra-copy note.
31. Preview: sim Online-only on the open file → "Downloading from Dropbox…"; off → banner clears and a changed head loads.
32. cargo: poll tests (3 s / 10 s cadence, stable-size rule, own save not reported, events of §2.1).
33. App (manual, two real computers on Dropbox — **cannot be automated here**): items 23, 24 and 13 with a real second computer.

**Sent to a colleague and back**
34. Preview: sim Send back edited copy into `/Users/me/Downloads` → open it → banner "This is a newer version of '…' (saved by …)". "Update my file with it" → my original file now has the newer head and is the open tab; the temporary-folder banner was shown for the Downloads copy.
35. Preview: open an older copy of a known file → "A newer version (saved …) is in …" with Open that one / Keep working here.

**Menu, quit, double-click (App)**
36. App: File menu has New, Open…, Open Recent, Save, Save As…, Duplicate as a New Analysis…, Close Tab, Recover Unsaved Work…, Old Library…, Export Library to Files…; app menu has About, Settings…, Quit. Cmd+S / Cmd+Shift+S / Cmd+O / Cmd+N / Cmd+W / Cmd+, / Cmd+Q do those things; Cmd+W never closes the window.
37. App: with unsaved changes — menu Quit, red close button → the quit dialog; Cancel keeps the app open; "Quit and keep…" quits and item 11 holds; "Save all" saves every tab then quits. The engine process is still running while the dialog is open and gone after quit (in a debug build: the dev engine is never killed).
38. App + cargo: Dock Quit / `osascript -e 'tell app … to quit'` goes through the same dialog (hook installed — startup log says so); with the page hung the app still quits within ~5 s (cargo: watchdog test). **Real logout and a real Cmd+Q keystroke need a person.**
39. App: Settings → change both names → the next saved version carries them (`read` → head revision `user_name` / `device_name`); they survive a restart.
40. App (built `.app` copied to `~/Library/Caches/LAS-phase1-test-DELETE-ME/`): `Info.plist` has the document type and exported UTI of §7; `open -a <app> file.lag` when the app is **not running** opens the file in a tab (pending buffer), and again when it **is running** (live event) the window comes forward with the file open; a second open of the same file just switches to its tab.
41. Code check: `updaterStore.restart()` awaits `quitRoutine("update")` before `relaunch()`; Rust never starts the routine for exit code `i32::MAX`. **A real update download + restart needs a person.**

**Recent and the old library**
42. Preview/App: the start screen shows Recent files (newest first, missing ones marked) instead of the in-app list; "Old library…" opens the old list read-only; "Open a copy" gives an untitled tab.
43. Preview (engine with a seeded library) : Export library to files… → pick a folder → "N of N exported."; files exist and open; run it again → nothing new is written, same analysis ids, same row/column ids (`export-map.json`). Break one row (name the target folder unwritable via sim) → "k failed" with Try again.
44. The SQLite library file's checksum is unchanged after the export.

**Regression gates**
45. `sh <scratch>/graph-fe-tests/run.sh`, `sh <scratch>/graph-tests/run_all.sh`, vitest, `tsc --noEmit`, `vite build` (scratch copy), `cargo test --locked` and `cargo build --locked` all pass. `git status` shows no `package.json` change and a `Cargo.lock` diff limited to the `app` and `zip` dependency lists.
46. UI text check: none of "revision", "head", "journal", "hash", "manifest", "sibling", "displaced" appears in `files-ui/text.ts` strings.

**Open manual checks carried from the plan (§19) — not verifiable by agents:** macOS privacy prompts on a clean account and after a re-signed update; Dropbox web version history after several saves; the same checks in Google Drive / OneDrive / iCloud Drive; real logout with unsaved work; a real updater run.

---

## 11. Where this contract narrows or changes the plan (on purpose)

1. **Temp file name** is `.~<name>.tmp-<rand>` (task instruction and the Dropbox spike), not the plan's `.~<name>.<rand>.tmp`.
2. **Manifest travels as text** (`manifestText`), so Rust never re-serialises JSON.
3. **Displaced copies** are kept only when the journal cannot hold the content (invalid replaced file, a file replaced through Save As). A replaced file with a valid head is journaled instead and its displaced link removed — otherwise every save would keep a full extra copy for 30 days.
4. **"Keep mine"** writes a two-parent version (their head + my journaled working version) so the file's newest version descends from both; the other computer then just sees a newer version. Its id uses the plan's `r-m-` formula, fixed here byte for byte.
5. **Phase 1 "replaced save"** (plan §8 "combining both now") → my journaled version is written beside the file as a copy and the disk version is loaded; combining is phase 2.
6. **One event channel** `graphfile://event` with a `type` field instead of one event name per kind; adds `back`, `unreadable`, `replaced`.
7. **Copy table** lives in memory per track (seeded when tracking starts) plus `known_copies` in the session; it is not persisted per directory.
8. **Startup check of Recent** is header-only and only marks missing files; the journal invariant is checked when a file is opened or changes.
9. **Legacy localStorage draft** is turned into an untitled "(recovered)" document at first start instead of being attached to its exported file.
10. **Too-new files**: no general read-only mode yet (phase 3 builds it); Save and Save As are disabled for that tab and the banner explains.
11. **"Recover unsaved work…"** ships as a simple list (Open / Delete) because "Remove from this list" must not strand unsaved changes.
12. **Quit asked by the system** proceeds after 60 s without an answer (unsaved changes are already kept), so logout is never blocked for good.
