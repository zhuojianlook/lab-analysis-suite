//! Phase 3 "check-out": the small `.laguse` note a computer keeps beside an
//! analysis while it has it open (phase3-contract.md §1, §3; plan §6).
//!
//! The note is a courtesy: safety stays with the save check, the sibling
//! scan, the journal and combining. One note per device, and a device only
//! ever writes, replaces or deletes its own — another computer's note is
//! deleted only through `presence_remove_foreign`, after the bytes were read
//! again unchanged. Nothing here compares the clocks of two machines: the
//! note's `updated_at` is written for display and never read back here.
//!
//! Every command is confined to the document's own folder and to names that
//! end in `.laguse`; the note itself is never written through a symbolic link.
//! Rust composes the note's JSON (the heartbeat runs without the page), with
//! exactly the bytes `presence.ts noteText` produces.

use crate::graphfile::{
    file_identity, has_lag_ext, is_dataless, is_same_file, lk, mtime_ms, name_has_ext, path_str, read_header,
    rename_replace, sha256_hex, temp_name_for, valid_id, wall_ms, write_synced, ErrKind, FResult, FileCtx, FileErr,
    HookPoint, EVT_FILE, EXT,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

// ═════════════════════════════════════════════════════════════════════════════
// Constants (contract.ts LIMITS_P3, NOTE_*)
// ═════════════════════════════════════════════════════════════════════════════

pub const NOTE_FIRST_LINE: &str = "Lab Analysis Suite note: shows who has this analysis open. Safe to delete.";
pub const NOTE_FORMAT: &str = "lasgraph-presence";
pub const NOTE_EXT: &str = "laguse";
/// A file larger than this is not a note (never read further).
pub const NOTE_MAX_BYTES: u64 = 8192;
/// A writer never produces more.
pub const NOTE_WRITE_MAX: usize = 4096;
/// Most `.laguse` files looked at in one folder (by name order).
pub const NOTES_PER_FOLDER: usize = 200;
pub const HEARTBEAT: Duration = Duration::from_millis(60_000);
pub const INPUT_WINDOW: Duration = Duration::from_millis(600_000);
pub const IDLE_KEEPALIVE: Duration = Duration::from_millis(6 * 3600_000);
pub const QUIT_DELETE: Duration = Duration::from_millis(1500);
/// After the frontend's take_pending_opens: leftovers of an earlier launch are swept.
pub const SWEEP_DELAY: Duration = Duration::from_secs(20);
/// A failed heartbeat rewrite is tried again after this long.
pub const RETRY_AFTER: Duration = Duration::from_secs(10);
/// `manifest.features` / note `features` of phase 3.
pub const FEATURES: u64 = 2;
pub const STEM_CHARS: usize = 60;
pub const STEM_BYTES: usize = 120;
pub const DEVICE_CHARS: usize = 30;
pub const DEVICE_BYTES: usize = 60;
const SEEN_MAX: usize = 1000;
const SEEN_WRITE_EVERY: Duration = Duration::from_secs(5);
const SUPERSEDES_MAX: usize = 32;
/// Note files are read on reader threads (fixer round 2, RV-1): a call waits for the reads it started at most
/// this long, then goes on with what it has (the last content read of each file); a read still running is taken
/// in by a later call. The poll (every 3 s per active file) waits least, presence_list (the 1.5 s open budget of
/// the frontend) more, presence_set / presence_clear (the seq of my own notes) a little.
pub const READ_WAIT_POLL: Duration = Duration::from_millis(200);
pub const READ_WAIT_LIST: Duration = Duration::from_millis(1000);
pub const READ_WAIT_SET: Duration = Duration::from_millis(300);
/// At most this many reader threads at once (each runs for one folder and one kind: local or online-only).
pub const READERS_MAX: usize = 16;
/// A failed read (offline, an I/O error) of the same file version is not tried again before this.
pub const READ_RETRY_AFTER: Duration = Duration::from_secs(10);
const NOTES_FILE: &str = "graph-notes.json";
const OWN_FILE: &str = "graph-notes-own.json";

// ═════════════════════════════════════════════════════════════════════════════
// The note (contract §1.1)
// ═════════════════════════════════════════════════════════════════════════════

/// `NoteTarget` of contract.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoteTarget {
    pub device_id: String,
    pub epoch: u64,
}

/// `NoteJson` of contract.ts. Field order = the file's key order. snake_case:
/// it is the file's own format and passes through to the frontend as it is.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NoteJson {
    pub format: String,
    pub v: u64,
    pub analysis_id: String,
    pub document_name: String,
    pub device_id: String,
    pub session_id: String,
    pub device_name: String,
    pub user_name: String,
    /// "idle" | "editing".
    pub state: String,
    pub head: Option<String>,
    pub base_revision: Option<String>,
    pub epoch: u64,
    pub seq: u64,
    pub supersedes: Option<Vec<NoteTarget>>,
    pub updated_at: String,
    /// Reserved (plan §6.9): always null.
    pub request_to: Option<String>,
    pub handover_to: Option<String>,
    pub features: u64,
}

impl NoteJson {
    pub fn editing(&self) -> bool {
        self.state == "editing"
    }
}

/// The text of a note file: first line, then `JSON.stringify(note, null, 1)`, then "\n".
pub fn note_text(n: &NoteJson) -> String {
    let mut buf = Vec::new();
    let fmt = serde_json::ser::PrettyFormatter::with_indent(b" ");
    let mut ser = serde_json::Serializer::with_formatter(&mut buf, fmt);
    // A struct of strings and numbers always serialises.
    let _ = n.serialize(&mut ser);
    format!("{NOTE_FIRST_LINE}\n{}\n", String::from_utf8_lossy(&buf))
}

fn num_u64(v: &Value) -> Option<u64> {
    if let Some(u) = v.as_u64() {
        return Some(u);
    }
    let f = v.as_f64()?;
    (f.is_finite() && f >= 0.0).then(|| f as u64)
}

fn str_of(o: &serde_json::Map<String, Value>, k: &str) -> Option<String> {
    o.get(k).and_then(Value::as_str).map(str::to_string)
}

fn nonempty(o: &serde_json::Map<String, Value>, k: &str) -> Option<String> {
    str_of(o, k).filter(|s| !s.is_empty())
}

/// string or null (a missing key counts as null).
fn opt_str(o: &serde_json::Map<String, Value>, k: &str) -> Result<Option<String>, ()> {
    match o.get(k) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        _ => Err(()),
    }
}

fn target_of(v: &Value) -> Option<NoteTarget> {
    let o = v.as_object()?;
    let device_id = o.get("device_id")?.as_str()?.to_string();
    let epoch = num_u64(o.get("epoch")?)?;
    Some(NoteTarget { device_id, epoch })
}

/// `parseNote` (contract §1.1). None: not a note (ignored, never deleted).
pub fn parse_note(bytes: &[u8]) -> Option<NoteJson> {
    if bytes.len() as u64 > NOTE_MAX_BYTES {
        return None;
    }
    let text = String::from_utf8_lossy(bytes);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let a = text.find('{')?;
    let b = text.rfind('}')?;
    if b < a {
        return None;
    }
    let v: Value = serde_json::from_str(&text[a..=b]).ok()?;
    let o = v.as_object()?;
    if o.get("format").and_then(Value::as_str) != Some(NOTE_FORMAT) {
        return None;
    }
    if o.get("v").and_then(Value::as_f64) != Some(1.0) {
        return None;
    }
    let supersedes: Vec<NoteTarget> = match o.get("supersedes") {
        Some(Value::Array(a)) => a.iter().filter_map(target_of).collect(),
        Some(x @ Value::Object(_)) => target_of(x).into_iter().collect(),
        _ => vec![],
    };
    Some(NoteJson {
        format: NOTE_FORMAT.into(),
        v: 1,
        analysis_id: nonempty(o, "analysis_id")?,
        document_name: nonempty(o, "document_name")?,
        device_id: nonempty(o, "device_id")?,
        session_id: nonempty(o, "session_id")?,
        device_name: str_of(o, "device_name")?,
        user_name: str_of(o, "user_name")?,
        state: if o.get("state").and_then(Value::as_str) == Some("editing") { "editing".into() } else { "idle".into() },
        head: opt_str(o, "head").ok()?,
        base_revision: opt_str(o, "base_revision").ok()?,
        epoch: num_u64(o.get("epoch")?)?,
        seq: num_u64(o.get("seq")?)?,
        supersedes: (!supersedes.is_empty()).then_some(supersedes),
        updated_at: str_of(o, "updated_at")?,
        request_to: None,
        handover_to: None,
        features: o.get("features").and_then(num_u64).unwrap_or(FEATURES),
    })
}

// ═════════════════════════════════════════════════════════════════════════════
// File names (contract §1.2)
// ═════════════════════════════════════════════════════════════════════════════

/// `sanitizeNamePart`: identical to presence.ts, per Unicode scalar value, no normalisation.
pub fn sanitize_name_part(text: &str, max_chars: usize, max_bytes: usize, fallback: &str) -> String {
    let mut mapped = String::with_capacity(text.len());
    for c in text.chars() {
        let u = c as u32;
        if u < 0x80 {
            if c.is_ascii_alphanumeric() || matches!(c, ' ' | '-' | '(' | ')' | ',') {
                mapped.push(c);
            } else {
                mapped.push(' ');
            }
        } else if (0x80..=0x9F).contains(&u)
            || matches!(u, 0xA0 | 0x1680 | 0x2000..=0x200A | 0x2028 | 0x2029 | 0x202F | 0x205F | 0x3000)
        {
            mapped.push(' ');
        } else if matches!(u, 0xAD | 0x200B..=0x200F | 0x202A..=0x202E | 0x2060..=0x2069 | 0xFEFF) {
            // invisible: removed
        } else {
            mapped.push(c);
        }
    }
    let mut collapsed = String::with_capacity(mapped.len());
    for c in mapped.chars() {
        if c == ' ' && collapsed.ends_with(' ') {
            continue;
        }
        collapsed.push(c);
    }
    let mut cut: String = collapsed.trim_matches(' ').chars().take(max_chars).collect();
    while cut.len() > max_bytes {
        cut.pop();
    }
    let cut = cut.trim_matches(' ');
    if cut.is_empty() {
        fallback.to_string()
    } else {
        cut.to_string()
    }
}

/// `deviceTag`: attempt 0 = the last 4 hex digits of the id; 1 = the 4 before them; 2 = the last 8.
pub fn device_tag(device_id: &str, attempt: u8) -> String {
    let hex: Vec<char> = device_id.to_lowercase().chars().filter(|c| matches!(c, '0'..='9' | 'a'..='f')).collect();
    let (skip, n) = match attempt {
        0 => (0, 4),
        1 => (4, 4),
        _ => (0, 8),
    };
    let end = hex.len().saturating_sub(skip);
    let start = end.saturating_sub(n);
    let got: String = hex[start..end].iter().collect();
    format!("{}{got}", "0".repeat(n - got.chars().count()))
}

/// The document's file name without ".lag" (any case). A name that is only ".lag" leaves an empty stem
/// ("Analysis" after sanitising), as in presence.ts.
fn doc_stem(doc_file_name: &str) -> &str {
    let n = doc_file_name.len();
    if n >= 4 && doc_file_name.is_char_boundary(n - 4) && doc_file_name[n - 4..].eq_ignore_ascii_case(".lag") {
        &doc_file_name[..n - 4]
    } else {
        doc_file_name
    }
}

/// `noteFileName`: "<stem> (in use on <device>, <tag>).laguse".
pub fn note_file_name(doc_file_name: &str, device_name: &str, device_id: &str, attempt: u8) -> String {
    let stem = sanitize_name_part(doc_stem(doc_file_name), STEM_CHARS, STEM_BYTES, "Analysis");
    let device = sanitize_name_part(device_name, DEVICE_CHARS, DEVICE_BYTES, "computer");
    format!("{stem} (in use on {device}, {}).{NOTE_EXT}", device_tag(device_id, attempt))
}

/// `isNoteFileName`: a note or a sync service's copy of one.
pub fn is_note_file_name(name: &str) -> bool {
    !name.starts_with('.') && name_has_ext(name, NOTE_EXT)
}

// ═════════════════════════════════════════════════════════════════════════════
// Time
// ═════════════════════════════════════════════════════════════════════════════

/// Days since 1970-01-01 → (year, month, day) (H. Hinnant's civil_from_days).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// "2026-11-22T10:14:03.512Z" (UTC, ms) — `Date.prototype.toISOString`.
pub fn iso_utc(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let milli = ms.rem_euclid(1000);
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    let sod = secs.rem_euclid(86_400);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{milli:03}Z", sod / 3600, sod % 3600 / 60, sod % 60)
}

// ═════════════════════════════════════════════════════════════════════════════
// State (contract §3.1)
// ═════════════════════════════════════════════════════════════════════════════

/// This computer's registered note for one document.
#[derive(Debug, Clone)]
pub struct OwnNote {
    pub file: PathBuf,
    pub note: NoteJson,
    pub last_write: Instant,
    pub last_input: Option<Instant>,
    /// The heartbeat rewrites it (cleared by a sleep gap until the next presence_set).
    pub beating: bool,
    /// A failed rewrite: not again before this.
    pub retry_at: Option<Instant>,
    /// A rewrite is running.
    pub busy: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SeenEntry {
    pub sha: String,
    pub since: i64,
}

pub struct PresenceState {
    pub own: HashMap<PathBuf, OwnNote>,
    /// The app is quitting: no note is written any more. Never reset.
    pub closing: bool,
    /// Note file → (sha of its bytes, wall ms since when this computer saw exactly these bytes).
    pub seen: HashMap<PathBuf, SeenEntry>,
    seen_loaded: bool,
    seen_dirty: bool,
    seen_saved_at: Option<Instant>,
    /// Every note file this app created and has not deleted.
    pub written: BTreeSet<PathBuf>,
    written_loaded: bool,
    /// This computer's device id (device.json), once read. Earlier ids (`aliases`) do not count:
    /// they may be another running computer's (a migrated or cloned Mac keeps using its id).
    own_ids: Option<BTreeSet<String>>,
    /// The highest seq written per document path in this launch: a note cleared and written again
    /// (setting Never → Always) never goes back to a lower seq.
    pub seq_floor: HashMap<PathBuf, u64>,
    /// Debug builds: notes only below these folders (`LAS_NOTE_ROOTS`). None: no guard (release).
    pub note_roots: Option<Vec<PathBuf>>,
    pub heartbeat: Duration,
    sweep_scheduled: bool,
}

impl Default for PresenceState {
    fn default() -> Self {
        PresenceState {
            own: HashMap::new(),
            closing: false,
            seen: HashMap::new(),
            seen_loaded: false,
            seen_dirty: false,
            seen_saved_at: None,
            written: BTreeSet::new(),
            written_loaded: false,
            own_ids: None,
            seq_floor: HashMap::new(),
            note_roots: if cfg!(debug_assertions) { Some(crate::devenv::note_roots_from_env()) } else { None },
            heartbeat: HEARTBEAT,
            sweep_scheduled: false,
        }
    }
}

/// (size, mtime, identity) of a note file as listed.
type NoteKey = (u64, i64, Option<(u64, u64)>);

/// Tests: called on the reader thread right before a note file is read (a slow or stuck download).
pub type NoteReadHook = Arc<dyn Fn(&Path) + Send + Sync>;

/// What each note file read so far contained, and the reads under way (fixer round 2, RV-1).
#[derive(Default)]
pub struct NoteCache {
    /// The last content read per file (kept while a newer version is being read: the last good content).
    entries: HashMap<PathBuf, CachedFile>,
    /// Files actually read (tests).
    pub reads: u64,
    /// Files queued or being read.
    pending: HashSet<PathBuf>,
    /// Per (folder, online-only): the files its reader thread still has to read. A key is present while that
    /// reader runs, so one folder has at most two readers: a stuck download never holds up a local file.
    queues: HashMap<(PathBuf, bool), VecDeque<(PathBuf, NoteKey)>>,
    /// A read that failed: not again for that version before READ_RETRY_AFTER.
    failed: HashMap<PathBuf, (NoteKey, Instant)>,
    /// Tests: see `NoteReadHook`.
    pub read_hook: Option<NoteReadHook>,
    /// Tests: these files count as online-only (dataless), as `is_dataless` reports for a cloud placeholder.
    pub fake_dataless: HashSet<PathBuf>,
}

/// The note cache and the signal its reader threads give when a read is done.
#[derive(Default)]
pub struct NoteReader {
    pub cache: Mutex<NoteCache>,
    done: Condvar,
}

#[derive(Clone)]
struct CachedFile {
    key: NoteKey,
    parsed: Option<(NoteJson, String)>,
}

fn load_records(ctx: &FileCtx, st: &mut PresenceState) {
    let Some(state) = ctx.state_dir.as_deref() else {
        st.seen_loaded = true;
        st.written_loaded = true;
        return;
    };
    if !st.seen_loaded {
        st.seen_loaded = true;
        let p = state.join(NOTES_FILE);
        if let Ok(b) = fs::read(&p) {
            let parsed = serde_json::from_slice::<Value>(&b).ok().and_then(|v| {
                let m = v.get("seen")?.as_object()?.clone();
                let mut out = HashMap::new();
                for (k, e) in m {
                    if let Ok(se) = serde_json::from_value::<SeenEntry>(e) {
                        out.insert(PathBuf::from(k), se);
                    }
                }
                Some(out)
            });
            match parsed {
                Some(m) => {
                    for (k, v) in m {
                        st.seen.entry(k).or_insert(v);
                    }
                }
                None => {
                    let _ = fs::rename(&p, state.join(format!("{NOTES_FILE}.bad-{}", wall_ms())));
                }
            }
        }
    }
    if !st.written_loaded {
        st.written_loaded = true;
        let p = state.join(OWN_FILE);
        if let Ok(b) = fs::read(&p) {
            let parsed = serde_json::from_slice::<Value>(&b).ok().and_then(|v| {
                Some(v.get("files")?.as_array()?.iter().filter_map(|f| f.as_str().map(PathBuf::from)).collect::<Vec<_>>())
            });
            match parsed {
                Some(files) => st.written.extend(files),
                None => {
                    let _ = fs::rename(&p, state.join(format!("{OWN_FILE}.bad-{}", wall_ms())));
                }
            }
        }
    }
}

fn state_lock(ctx: &FileCtx) -> std::sync::MutexGuard<'_, PresenceState> {
    let mut g = lk(&ctx.presence);
    if !g.seen_loaded || !g.written_loaded {
        load_records(ctx, &mut g);
    }
    g
}

/// graph-notes-own.json (on every change).
fn persist_written(ctx: &FileCtx) {
    let Some(state) = ctx.state_dir.as_deref() else { return };
    let _p = lk(&ctx.note_persist);
    let files: Vec<String> = state_lock(ctx).written.iter().map(|p| path_str(p)).collect();
    let v = json!({ "v": 1, "files": files });
    if let Err(e) = crate::graphfile::atomic_write(&state.join(OWN_FILE), v.to_string().as_bytes()) {
        log::warn!("[presence] couldn't write {OWN_FILE}: {e}");
    }
}

/// graph-notes.json: at most every 5 s (`force`: now, when anything changed).
fn persist_seen(ctx: &FileCtx, force: bool) {
    let Some(state) = ctx.state_dir.as_deref() else { return };
    let _p = lk(&ctx.note_persist);
    let snapshot = {
        let mut st = state_lock(ctx);
        if !st.seen_dirty {
            return;
        }
        if !force && st.seen_saved_at.map(|t| t.elapsed() < SEEN_WRITE_EVERY).unwrap_or(false) {
            return;
        }
        if st.seen.len() > SEEN_MAX {
            let mut by_age: Vec<(i64, PathBuf)> = st.seen.iter().map(|(k, v)| (v.since, k.clone())).collect();
            by_age.sort();
            let extra = st.seen.len() - SEEN_MAX;
            for (_, k) in by_age.into_iter().take(extra) {
                st.seen.remove(&k);
            }
        }
        st.seen_dirty = false;
        st.seen_saved_at = Some(Instant::now());
        let mut m = serde_json::Map::new();
        for (k, v) in &st.seen {
            m.insert(path_str(k), json!({ "sha": v.sha, "since": v.since }));
        }
        json!({ "v": 1, "seen": Value::Object(m) })
    };
    if let Err(e) = crate::graphfile::atomic_write(&state.join(NOTES_FILE), snapshot.to_string().as_bytes()) {
        log::warn!("[presence] couldn't write {NOTES_FILE}: {e}");
    }
}

/// This computer's identity and the id that counts as "own": the current device id only.
/// An earlier id (`aliases` in device.json) is NOT own: after Migration Assistant, a restore from
/// another Mac's backup or a duplicate identity, that id is still used by the other computer, and
/// treating its notes as mine would hide its editing and delete its live note (fixer VP-1). Notes
/// this computer wrote under an earlier id are deleted when the id changes (`forget_own`).
fn identity(ctx: &FileCtx) -> FResult<(crate::appstate::DeviceIdentity, BTreeSet<String>)> {
    let ident = crate::appstate::device(ctx)?;
    let mut ids: BTreeSet<String> = BTreeSet::new();
    ids.insert(ident.device_id.clone());
    lk(&ctx.presence).own_ids = Some(ids.clone());
    Ok((ident, ids))
}

/// The own ids, read once (empty without a state folder).
pub fn own_ids(ctx: &FileCtx) -> BTreeSet<String> {
    if let Some(ids) = lk(&ctx.presence).own_ids.clone() {
        return ids;
    }
    identity(ctx).map(|(_, ids)| ids).unwrap_or_default()
}

/// `appstate_new_device_id` happened: every OwnNote is dropped from the registry, and the note
/// files this launch wrote under the old identity (`old_id` + `old_session`) are deleted — the other
/// computer that has the old id writes its own notes with another session id, so those are never
/// touched. The controller writes the notes again under the new id.
pub fn forget_own(ctx: &FileCtx, old_id: &str, old_session: &str) {
    let files: Vec<PathBuf> = {
        let mut st = state_lock(ctx);
        let mut files: Vec<PathBuf> = st.own.drain().map(|(_, o)| o.file).collect();
        for w in &st.written {
            if !files.contains(w) {
                files.push(w.clone());
            }
        }
        st.own_ids = None;
        files
    };
    for f in files {
        delete_if(ctx, &f, &|n: &NoteJson| n.device_id == old_id && n.session_id == old_session);
    }
    persist_written(ctx);
    persist_seen(ctx, false);
}

// ═════════════════════════════════════════════════════════════════════════════
// Folder listing and matching (contract §1.4, §3.6)
// ═════════════════════════════════════════════════════════════════════════════

#[derive(Debug, Clone)]
pub struct NoteFile {
    pub path: PathBuf,
    pub size: u64,
    pub mtime: i64,
    /// Online-only (not downloaded yet): reading it makes the cloud client download it.
    pub dataless: bool,
}

/// One listing of a folder: the `.laguse` files and the `.lag` files.
#[derive(Default)]
struct Folder {
    /// Regular, not hidden, sorted by name, at most NOTES_PER_FOLDER.
    notes: Vec<NoteFile>,
    /// Every note name in the folder (before the bound).
    all_notes: BTreeSet<PathBuf>,
    truncated: bool,
    /// Local `.lag` files and the analysis id in their header (None: unreadable).
    lags: Vec<(PathBuf, Option<String>)>,
    has_dataless: bool,
}

/// `prefer`: the document's file name; its notes (by the sanitised stem) are kept first when the folder
/// holds more than NOTES_PER_FOLDER notes (fixer VS-9).
fn list_folder(ctx: &FileCtx, dir: &Path, want_lags: bool, prefer: Option<&str>) -> FResult<Folder> {
    let rd = fs::read_dir(dir).map_err(|e| FileErr::from_io(&e, dir))?;
    let mut f = Folder::default();
    let mut lag_stats = Vec::new();
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let is_note = is_note_file_name(&name);
        let is_lag = want_lags && name_has_ext(&name, EXT);
        if !is_note && !is_lag {
            continue;
        }
        let Ok(m) = fs::symlink_metadata(e.path()) else { continue };
        if !m.is_file() {
            continue;
        }
        if is_note {
            f.all_notes.insert(e.path());
            // An online-only (dataless) note is listed too: it is read on a reader thread like every note
            // (`read_notes`), so a download that hangs while offline never holds up the poll or a command
            // (fixer VS-4), and another computer's note is still seen in a folder kept online-only (round 2, RV-1).
            let dataless = is_dataless(&m) || lk(&ctx.note_reader.cache).fake_dataless.contains(&e.path());
            f.notes.push(NoteFile { path: e.path(), size: m.len(), mtime: mtime_ms(&m), dataless });
        } else if is_dataless(&m) {
            f.has_dataless = true;
        } else {
            lag_stats.push(crate::graphfile::stat_of(&e.path(), &m));
        }
    }
    f.notes.sort_by(|a, b| a.path.cmp(&b.path));
    if f.notes.len() > NOTES_PER_FOLDER {
        if let Some(doc) = prefer {
            let lead = format!("{} (", sanitize_name_part(doc_stem(doc), STEM_CHARS, STEM_BYTES, "Analysis"));
            let starts = |n: &NoteFile| n.path.file_name().map(|x| x.to_string_lossy().starts_with(&lead)).unwrap_or(false);
            f.notes.sort_by_key(|n| !starts(n)); // stable: by name within each group
        }
        f.notes.truncate(NOTES_PER_FOLDER);
        f.notes.sort_by(|a, b| a.path.cmp(&b.path));
        f.truncated = true;
    }
    lag_stats.sort_by(|a, b| a.path.cmp(&b.path));
    for st in lag_stats {
        let p = PathBuf::from(&st.path);
        let h = crate::graphwatch::cached_header(ctx, &p, &st).map(|h| h.analysis_id);
        f.lags.push((p, h));
    }
    Ok(f)
}

fn read_capped(path: &Path) -> io::Result<Vec<u8>> {
    let f = fs::File::open(path)?;
    let mut buf = Vec::new();
    f.take(NOTE_MAX_BYTES + 1).read_to_end(&mut buf)?;
    Ok(buf)
}

/// Read a note file now (no cache): (note, sha). None: gone, a link, too big or not a note.
pub fn read_note_fresh(path: &Path) -> Option<(NoteJson, String)> {
    let m = fs::symlink_metadata(path).ok()?;
    if !m.is_file() || m.len() > NOTE_MAX_BYTES || is_dataless(&m) {
        return None;
    }
    let bytes = read_capped(path).ok()?;
    let note = parse_note(&bytes)?;
    Some((note, sha256_hex(&bytes)))
}

/// The content of each listed note file: (note, sha), or None (not a note, too big, or not read yet).
///
/// A file is read only when its (size, mtime, identity) changed since the last read. Every read runs on a
/// reader thread, one per folder and kind (local / online-only), at most READERS_MAX at once: reading an
/// online-only file makes the cloud client download it, which may take long or never end while offline.
/// The call waits for the reads it queued at most `wait`; a file whose read is still under way (or failed)
/// keeps its last content read, and the content of a finished read is there for the next call (the poll
/// takes it in within its next look). A stuck download costs one `wait`, once (fixer round 2, RV-1).
fn read_notes(ctx: &FileCtx, files: &[NoteFile], wait: Duration) -> Vec<Option<(NoteJson, String)>> {
    let keys: Vec<NoteKey> = files.iter().map(|nf| (nf.size, nf.mtime, file_identity(&nf.path))).collect();
    let rd = &ctx.note_reader;
    let t0 = Instant::now();
    let mut mine: Vec<PathBuf> = Vec::new();
    let mut start: Vec<(PathBuf, bool)> = Vec::new();
    {
        let mut c = lk(&rd.cache);
        for (nf, key) in files.iter().zip(&keys) {
            if nf.size > NOTE_MAX_BYTES || c.pending.contains(&nf.path) {
                continue;
            }
            if c.entries.get(&nf.path).map(|e| e.key == *key).unwrap_or(false) {
                continue;
            }
            if let Some((k, at)) = c.failed.get(&nf.path) {
                if k == key && t0.duration_since(*at) < READ_RETRY_AFTER {
                    continue;
                }
            }
            let Some(dir) = nf.path.parent().map(Path::to_path_buf) else { continue };
            let q = (dir, nf.dataless);
            if !c.queues.contains_key(&q) {
                if c.queues.len() >= READERS_MAX {
                    continue; // tried again on a later call
                }
                c.queues.insert(q.clone(), VecDeque::new());
                start.push(q.clone());
            }
            c.queues.get_mut(&q).map(|v| v.push_back((nf.path.clone(), *key)));
            c.pending.insert(nf.path.clone());
            mine.push(nf.path.clone());
        }
    }
    for q in start {
        spawn_reader(ctx.note_reader.clone(), q);
    }
    let deadline = t0 + wait;
    let mut c = lk(&rd.cache);
    while mine.iter().any(|p| c.pending.contains(p)) {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }
        c = match rd.done.wait_timeout(c, left) {
            Ok((g, _)) => g,
            Err(e) => e.into_inner().0,
        };
    }
    files
        .iter()
        .map(|nf| if nf.size > NOTE_MAX_BYTES { None } else { c.entries.get(&nf.path).and_then(|e| e.parsed.clone()) })
        .collect()
}

/// One reader thread: reads the files queued for (folder, online-only) one after the other until none is left.
fn spawn_reader(rd: Arc<NoteReader>, q: (PathBuf, bool)) {
    let r2 = rd.clone();
    let q2 = q.clone();
    let spawned = std::thread::Builder::new().name("presence-read".into()).spawn(move || loop {
        let (job, hook) = {
            let mut c = lk(&r2.cache);
            let next = c.queues.get_mut(&q2).and_then(|v| v.pop_front());
            match next {
                Some(j) => (j, c.read_hook.clone()),
                None => {
                    c.queues.remove(&q2);
                    return;
                }
            }
        };
        let (path, key) = job;
        if let Some(h) = hook {
            h(&path);
        }
        let res = read_capped(&path);
        {
            let mut c = lk(&r2.cache);
            c.pending.remove(&path);
            match res {
                Ok(bytes) => {
                    c.reads += 1;
                    let parsed = if bytes.len() as u64 > NOTE_MAX_BYTES {
                        None
                    } else {
                        parse_note(&bytes).map(|n| (n, sha256_hex(&bytes)))
                    };
                    c.failed.remove(&path);
                    c.entries.insert(path, CachedFile { key, parsed });
                }
                Err(e) if e.kind() == io::ErrorKind::NotFound => {
                    c.entries.remove(&path);
                    c.failed.remove(&path);
                }
                Err(e) => {
                    log::info!("[presence] couldn't read {}: {e}", path.display());
                    c.failed.insert(path, (key, Instant::now()));
                }
            }
        }
        r2.done.notify_all();
    });
    if let Err(e) = spawned {
        log::warn!("[presence] couldn't start a note reader: {e}");
        let mut c = lk(&rd.cache);
        let now = Instant::now();
        for (p, k) in c.queues.remove(&q).unwrap_or_default() {
            c.pending.remove(&p);
            c.failed.insert(p, (k, now));
        }
        drop(c);
        rd.done.notify_all();
    }
}

/// The last content read of a note file (no read now).
fn cached_note(ctx: &FileCtx, p: &Path) -> Option<(NoteJson, String)> {
    lk(&ctx.note_reader.cache).entries.get(p).and_then(|e| e.parsed.clone())
}

fn forget_cached(ctx: &FileCtx, p: &Path) {
    lk(&ctx.note_reader.cache).entries.remove(p);
}

/// The document a listing is about.
struct DocRef<'a> {
    path: &'a Path,
    dir: &'a Path,
    file_name: String,
    analysis_id: Option<&'a str>,
    me: Option<(u64, u64)>,
}

impl<'a> DocRef<'a> {
    fn new(path: &'a Path, analysis_id: Option<&'a str>) -> Option<Self> {
        Some(DocRef {
            path,
            dir: path.parent()?,
            file_name: path.file_name()?.to_string_lossy().into_owned(),
            analysis_id,
            me: file_identity(path),
        })
    }
}

/// A plain file name (no separators, not "." / "..").
fn plain_name(n: &str) -> bool {
    !n.is_empty() && n != "." && n != ".." && !n.contains('/') && !n.contains('\\') && !n.contains('\0')
}

/// `document_name` names this file: equal ignoring ASCII case, or the same file on disk.
fn names_doc(note: &NoteJson, d: &DocRef) -> bool {
    if note.document_name.eq_ignore_ascii_case(&d.file_name) {
        return true;
    }
    if d.me.is_none() || !plain_name(&note.document_name) {
        return false;
    }
    let p = d.dir.join(&note.document_name);
    p.exists() && is_same_file(&p, d.path, d.me)
}

/// §1.4: same analysis id, and the note names this file or this is the only local `.lag` with that id.
fn applies(note: &NoteJson, d: &DocRef, f: &Folder) -> bool {
    let Some(aid) = d.analysis_id else { return names_doc(note, d) };
    if note.analysis_id != aid {
        return false;
    }
    if names_doc(note, d) {
        return true;
    }
    let same: Vec<&PathBuf> = f.lags.iter().filter(|(_, a)| a.as_deref() == Some(aid)).map(|(p, _)| p).collect();
    same.len() == 1 && is_same_file(same[0], d.path, d.me)
}

/// No `.lag` file in the folder has the note's analysis id (and none is online-only).
fn orphan(note: &NoteJson, f: &Folder) -> bool {
    !f.has_dataless && !f.lags.iter().any(|(_, a)| a.as_deref() == Some(note.analysis_id.as_str()))
}

/// `NoteRecord` of contract.ts.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NoteRecord {
    pub file: String,
    pub size: u64,
    pub mtime: i64,
    pub sha: String,
    pub unchanged_since: i64,
    pub note: NoteJson,
    pub applies: bool,
    pub orphan: bool,
    pub own: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresenceListReply {
    pub notes: Vec<NoteRecord>,
    pub truncated: bool,
}

fn check_doc_path(doc_path: &str) -> FResult<PathBuf> {
    let p = PathBuf::from(doc_path);
    let plain = p.components().all(|c| !matches!(c, Component::ParentDir | Component::CurDir));
    if !p.is_absolute() || !plain || !has_lag_ext(&p) || p.file_name().is_none() || p.parent().is_none() {
        return Err(FileErr::invalid(format!("not an analysis file path: {doc_path:?}")));
    }
    Ok(p)
}

/// §3.6: the notes in the document's folder that are about it, plus orphans. Never writes a note.
/// (presence_list: waits for new reads at most READ_WAIT_LIST.)
pub fn scan_notes(ctx: &FileCtx, doc_path: &Path, analysis_id: &str) -> FResult<PresenceListReply> {
    scan_notes_within(ctx, doc_path, analysis_id, READ_WAIT_LIST)
}

/// `scan_notes` waiting at most `wait` for the note files it has to read (the poll: READ_WAIT_POLL).
pub fn scan_notes_within(ctx: &FileCtx, doc_path: &Path, analysis_id: &str, wait: Duration) -> FResult<PresenceListReply> {
    let d = DocRef::new(doc_path, Some(analysis_id)).ok_or_else(|| FileErr::invalid("no folder"))?;
    let folder = list_folder(ctx, d.dir, true, Some(&d.file_name))?;
    let ids = own_ids(ctx);
    let mut parsed: Vec<(NoteFile, NoteJson, String)> = Vec::new();
    for (nf, got) in folder.notes.iter().zip(read_notes(ctx, &folder.notes, wait)) {
        if let Some((n, sha)) = got {
            parsed.push((nf.clone(), n, sha));
        }
    }
    let now = wall_ms();
    let mut out = Vec::new();
    {
        let mut st = state_lock(ctx);
        for (nf, note, sha) in parsed {
            let since = match st.seen.get(&nf.path) {
                Some(e) if e.sha == sha => e.since,
                _ => {
                    st.seen.insert(nf.path.clone(), SeenEntry { sha: sha.clone(), since: now });
                    st.seen_dirty = true;
                    now
                }
            };
            let ap = applies(&note, &d, &folder);
            let orph = orphan(&note, &folder);
            if !(ap || orph) {
                continue;
            }
            out.push(NoteRecord {
                file: path_str(&nf.path),
                size: nf.size,
                mtime: nf.mtime,
                sha,
                unchanged_since: since,
                own: ids.contains(&note.device_id),
                note,
                applies: ap,
                orphan: orph,
            });
        }
        let gone: Vec<PathBuf> =
            st.seen.keys().filter(|k| k.parent() == Some(d.dir) && !folder.all_notes.contains(*k)).cloned().collect();
        for k in gone {
            st.seen.remove(&k);
            st.seen_dirty = true;
        }
    }
    persist_seen(ctx, false);
    out.sort_by(|a, b| a.file.cmp(&b.file));
    Ok(PresenceListReply { notes: out, truncated: folder.truncated })
}

/// The poll's signature over (file, sha), leaving out this launch's own notes
/// (my own heartbeat must not wake the frontend).
pub fn notes_sig(records: &[NoteRecord], session_id: &str) -> String {
    let mut s = String::new();
    for r in records {
        if r.own && r.note.session_id == session_id {
            continue;
        }
        s.push_str(&r.file);
        s.push('\0');
        s.push_str(&r.sha);
        s.push('\n');
    }
    sha256_hex(s.as_bytes())
}

/// The signature of an empty listing (a new track starts with it).
pub fn empty_sig() -> String {
    sha256_hex(b"")
}

// ═════════════════════════════════════════════════════════════════════════════
// Writing and deleting own notes
// ═════════════════════════════════════════════════════════════════════════════

/// Atomic write in the target's own folder: `.~<name>.tmp-<8 hex>`, sync, rename over it.
fn write_note(ctx: &FileCtx, target: &Path, bytes: &[u8]) -> FResult<()> {
    let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if !is_note_file_name(&name) {
        return Err(FileErr::invalid(format!("not a note name: {name:?}")));
    }
    let tmp = temp_name_for(target);
    let r = (|| {
        write_synced(&tmp, bytes).map_err(|e| FileErr::from_io(&e, &tmp))?;
        ctx.run_hook(HookPoint::BeforeNoteRename, target)?;
        if let Ok(m) = fs::symlink_metadata(target) {
            if m.file_type().is_symlink() || m.is_dir() {
                return Err(FileErr::invalid(format!("{} is not a plain file", target.display())));
            }
        }
        rename_replace(&tmp, target)
    })();
    if r.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    forget_cached(ctx, target);
    r
}

/// Delete `p` only when it is a regular `.laguse` file that reads now as a note of one of `ids`.
/// Returns true when it is gone afterwards because of this call (or already was).
fn delete_if_own(ctx: &FileCtx, p: &Path, ids: &BTreeSet<String>) -> bool {
    delete_if(ctx, p, &|n: &NoteJson| ids.contains(&n.device_id))
}

/// Delete `p` only when it is a regular `.laguse` file that reads now as a note for which `pred` holds.
fn delete_if(ctx: &FileCtx, p: &Path, pred: &dyn Fn(&NoteJson) -> bool) -> bool {
    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if !is_note_file_name(&name) {
        return false;
    }
    let gone = match fs::symlink_metadata(p) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => true,
        Err(_) => return false,
        Ok(m) if !m.is_file() => return false,
        Ok(_) => {
            let Some((n, _)) = read_note_fresh(p) else { return false };
            if !pred(&n) {
                return false;
            }
            match fs::remove_file(p) {
                Ok(()) => true,
                Err(e) if e.kind() == io::ErrorKind::NotFound => true,
                Err(e) => {
                    log::warn!("[presence] couldn't delete {}: {e}", p.display());
                    false
                }
            }
        }
    };
    if gone {
        forget_cached(ctx, p);
        let mut st = state_lock(ctx);
        st.written.remove(p);
        if st.seen.remove(p).is_some() {
            st.seen_dirty = true;
        }
    }
    gone
}

fn under_roots(doc: &Path, roots: &[PathBuf]) -> bool {
    let dir = doc.parent().unwrap_or(doc);
    let dir = fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    roots.iter().any(|r| {
        let r = fs::canonicalize(r).unwrap_or_else(|_| r.clone());
        dir.starts_with(&r)
    })
}

/// `PresenceSetArgs` of contract.ts.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresenceSetArgs {
    pub doc_path: String,
    pub analysis_id: String,
    pub state: String,
    pub head: Option<String>,
    pub base_revision: Option<String>,
    pub epoch: f64,
    #[serde(default)]
    pub supersedes: Vec<TargetArg>,
    #[serde(default)]
    pub input: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TargetArg {
    pub device_id: String,
    pub epoch: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PresenceSetReply {
    Written { file: String, note: NoteJson },
    Off { reason: &'static str },
}

fn count(x: f64, what: &str) -> FResult<u64> {
    if x.is_finite() && x >= 0.0 && x.fract() == 0.0 {
        Ok(x as u64)
    } else {
        Err(FileErr::invalid(format!("bad {what}: {x}")))
    }
}

fn check_rev(what: &str, v: &Option<String>) -> FResult<()> {
    match v {
        Some(s) if !valid_id(s) => Err(FileErr::invalid(format!("bad {what}: {s:?}"))),
        _ => Ok(()),
    }
}

/// Pick the note's name (§1.2): attempt 0, unless that name is another device's note; then 1, then 2.
/// `mine(n)`: `n` is my own note about this document (reused). My own note about ANOTHER document
/// (two names that sanitise alike) and a file that is not a note are never overwritten.
fn choose_target(
    ctx: &FileCtx,
    dir: &Path,
    doc_name: &str,
    device_name: &str,
    device_id: &str,
    ids: &BTreeSet<String>,
    mine: &dyn Fn(&NoteJson) -> bool,
) -> FResult<PathBuf> {
    let mut last_foreign = None;
    for attempt in 0..3u8 {
        let p = dir.join(note_file_name(doc_name, device_name, device_id, attempt));
        match fs::symlink_metadata(&p) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(p),
            Err(e) => return Err(FileErr::from_io(&e, &p)),
            Ok(m) if m.file_type().is_symlink() => {
                return Err(FileErr::invalid(format!("{} is a link", p.display())));
            }
            Ok(m) if !m.is_file() => {}
            // An online-only file at the name is judged by its last content read (never read here: the
            // download may hang). Unknown → the name is not used (fixer round 2, RV-1).
            Ok(m) if is_dataless(&m) || lk(&ctx.note_reader.cache).fake_dataless.contains(&p) => match cached_note(ctx, &p) {
                Some((n, _)) if mine(&n) => return Ok(p),
                Some((n, _)) if !ids.contains(&n.device_id) => last_foreign = Some((attempt, p)),
                _ => {}
            },
            Ok(_) => match read_note_fresh(&p) {
                Some((n, _)) if mine(&n) => return Ok(p),
                Some((n, _)) if !ids.contains(&n.device_id) => last_foreign = Some((attempt, p)),
                _ => {} // not a note, or my note about another document: never overwritten
            },
        }
    }
    match last_foreign {
        // All three names are other devices' notes: attempt 2 anyway (matching is by content).
        Some((2, p)) => Ok(p),
        _ => Err(FileErr::io("no free name for the note in this folder")),
    }
}

/// `presence_set` (contract §3.2). `now`: the monotonic time of the call.
pub fn set_note(ctx: &FileCtx, req: &PresenceSetArgs, now: Instant) -> FResult<PresenceSetReply> {
    // 1. arguments
    let doc = check_doc_path(&req.doc_path)?;
    if !valid_id(&req.analysis_id) {
        return Err(FileErr::invalid(format!("bad analysis id: {:?}", req.analysis_id)));
    }
    check_rev("head", &req.head)?;
    check_rev("base revision", &req.base_revision)?;
    let epoch = count(req.epoch, "epoch")?;
    let editing = match req.state.as_str() {
        "editing" => true,
        "idle" => false,
        s => return Err(FileErr::invalid(format!("bad state: {s:?}"))),
    };
    if req.supersedes.len() > SUPERSEDES_MAX {
        return Err(FileErr::invalid("too many claims overridden"));
    }
    let mut supersedes = Vec::new();
    for t in &req.supersedes {
        if !valid_id(&t.device_id) {
            return Err(FileErr::invalid(format!("bad device id: {:?}", t.device_id)));
        }
        supersedes.push(NoteTarget { device_id: t.device_id.clone(), epoch: count(t.epoch, "epoch")? });
    }
    // 2. quitting / debug guard
    {
        let st = lk(&ctx.presence);
        if st.closing {
            return Ok(PresenceSetReply::Off { reason: "closing" });
        }
        if let Some(roots) = &st.note_roots {
            if !under_roots(&doc, roots) {
                return Ok(PresenceSetReply::Off { reason: "debugRoot" });
            }
        }
    }
    // 3. the folder
    let dir = doc.parent().ok_or_else(|| FileErr::invalid("no folder"))?.to_path_buf();
    match fs::metadata(&dir) {
        Ok(m) if m.is_dir() => {}
        Ok(_) => return Err(FileErr::new(ErrKind::NotFound, format!("{} is not a folder", dir.display()))),
        Err(e) => return Err(FileErr::from_io(&e, &dir)),
    }
    let _g = ctx.note_locks.lock(&doc);
    if lk(&ctx.presence).closing {
        return Ok(PresenceSetReply::Off { reason: "closing" });
    }
    // 4. the note
    let (ident, ids) = identity(ctx)?;
    let d = DocRef::new(&doc, Some(&req.analysis_id)).ok_or_else(|| FileErr::invalid("no folder"))?;
    let folder = list_folder(ctx, &dir, true, Some(&d.file_name))?;
    let mut own_here: Vec<(PathBuf, NoteJson)> = Vec::new();
    for (nf, got) in folder.notes.iter().zip(read_notes(ctx, &folder.notes, READ_WAIT_SET)) {
        if let Some((n, _)) = got {
            if ids.contains(&n.device_id) && applies(&n, &d, &folder) {
                own_here.push((nf.path.clone(), n));
            }
        }
    }
    let (prev, floor) = {
        let st = lk(&ctx.presence);
        (st.own.get(&doc).cloned(), st.seq_floor.get(&doc).copied())
    };
    let max_seq =
        own_here.iter().map(|(_, n)| n.seq).chain(prev.as_ref().map(|o| o.note.seq)).chain(floor).max().unwrap_or(0);
    let note = NoteJson {
        format: NOTE_FORMAT.into(),
        v: 1,
        analysis_id: req.analysis_id.clone(),
        document_name: d.file_name.clone(),
        device_id: ident.device_id.clone(),
        session_id: ident.session_id.clone(),
        device_name: ident.device_name.clone(),
        user_name: ident.user_name.clone(),
        state: if editing { "editing".into() } else { "idle".into() },
        head: req.head.clone(),
        base_revision: if editing { req.base_revision.clone() } else { None },
        epoch,
        seq: max_seq + 1,
        supersedes: (editing && !supersedes.is_empty()).then_some(supersedes),
        updated_at: iso_utc(wall_ms()),
        request_to: None,
        handover_to: None,
        features: FEATURES,
    };
    let text = note_text(&note);
    if text.len() > NOTE_WRITE_MAX {
        return Err(FileErr::invalid("the note would be too large"));
    }
    // 5. name and atomic write
    let registered = prev.as_ref().map(|o| o.file.clone());
    let mine = |n: &NoteJson| ids.contains(&n.device_id) && applies(n, &d, &folder);
    let target = choose_target(ctx, &dir, &d.file_name, &ident.device_name, &ident.device_id, &ids, &mine)
        .or_else(|e| registered.clone().filter(|r| r.exists()).ok_or(e))?;
    write_note(ctx, &target, text.as_bytes())?;
    let sha = sha256_hex(text.as_bytes());
    // 6. other own notes about this document (old names, conflict copies of mine)
    let mut stale: Vec<PathBuf> = own_here.into_iter().map(|(p, _)| p).filter(|p| *p != target).collect();
    if let Some(o) = &prev {
        if o.file != target && !stale.contains(&o.file) {
            stale.push(o.file.clone());
        }
    }
    // A stale note registered for ANOTHER document path that applies to this document (the document was
    // renamed in the same folder and followed): that registration goes too, or its heartbeat would write
    // the old note again (fixer VS-2).
    {
        let mut st = lk(&ctx.presence);
        let gone: Vec<PathBuf> =
            st.own.iter().filter(|(k, o)| **k != doc && stale.contains(&o.file)).map(|(k, _)| k.clone()).collect();
        for k in gone {
            st.own.remove(&k);
        }
    }
    for p in stale {
        delete_if_own(ctx, &p, &ids);
    }
    // 7. register — unless the app started quitting meanwhile: then the note just written goes again
    // (delete_all_own may have run between the check above and the rename; fixer VS-3).
    {
        let mut st = state_lock(ctx);
        if st.closing {
            drop(st);
            let (dev, ses) = (note.device_id.clone(), note.session_id.clone());
            delete_if(ctx, &target, &|n: &NoteJson| n.device_id == dev && n.session_id == ses);
            persist_written(ctx);
            return Ok(PresenceSetReply::Off { reason: "closing" });
        }
        st.seq_floor.insert(doc.clone(), note.seq);
        let last_input = if req.input { Some(now) } else { prev.as_ref().and_then(|o| o.last_input) };
        st.own.insert(
            doc.clone(),
            OwnNote { file: target.clone(), note: note.clone(), last_write: now, last_input, beating: true, retry_at: None, busy: false },
        );
        st.written.insert(target.clone());
        st.seen.insert(target.clone(), SeenEntry { sha, since: wall_ms() });
        st.seen_dirty = true;
    }
    persist_written(ctx);
    persist_seen(ctx, false);
    Ok(PresenceSetReply::Written { file: path_str(&target), note })
}

/// `presence_clear` (contract §3.3): my note(s) for the document are deleted and the beating stops.
pub fn clear_note(ctx: &FileCtx, doc_path: &str) -> FResult<()> {
    let doc = check_doc_path(doc_path)?;
    let _g = ctx.note_locks.lock(&doc);
    let prev = lk(&ctx.presence).own.remove(&doc);
    let ids = own_ids(ctx);
    let aid: Option<String> =
        prev.as_ref().map(|o| o.note.analysis_id.clone()).or_else(|| read_header(&doc).ok().map(|(h, _)| h.analysis_id));
    let mut cands: Vec<PathBuf> = prev.iter().map(|o| o.file.clone()).collect();
    if let Some(d) = DocRef::new(&doc, aid.as_deref()) {
        match list_folder(ctx, d.dir, true, Some(&d.file_name)) {
            Ok(folder) => {
                for (nf, got) in folder.notes.iter().zip(read_notes(ctx, &folder.notes, READ_WAIT_SET)) {
                    if let Some((n, _)) = got {
                        if ids.contains(&n.device_id) && applies(&n, &d, &folder) && !cands.contains(&nf.path) {
                            cands.push(nf.path.clone());
                        }
                    }
                }
            }
            Err(e) => log::info!("[presence] clear: couldn't list {}: {}", d.dir.display(), e.message),
        }
    }
    // Never a note another open document of this computer is registered with.
    let others: Vec<PathBuf> = lk(&ctx.presence).own.values().map(|o| o.file.clone()).collect();
    for c in cands {
        let mine_elsewhere = others.iter().any(|o| is_same_file(o, &c, file_identity(&c)));
        if !mine_elsewhere {
            delete_if_own(ctx, &c, &ids);
        }
    }
    persist_written(ctx);
    persist_seen(ctx, false);
    Ok(())
}

/// `presence_input` (contract §3.4): memory only.
pub fn note_input(ctx: &FileCtx, doc_path: &Path, now: Instant) {
    if let Some(o) = lk(&ctx.presence).own.get_mut(doc_path) {
        o.last_input = Some(now);
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// Heartbeat (contract §3.5)
// ═════════════════════════════════════════════════════════════════════════════

/// Is a rewrite due for this note at `now`?
pub fn rewrite_due(o: &OwnNote, now: Instant, heartbeat: Duration) -> bool {
    if o.busy || o.retry_at.map(|r| now < r).unwrap_or(false) {
        return false;
    }
    let since_write = now.saturating_duration_since(o.last_write);
    if o.note.editing() {
        let recent_input = o.last_input.map(|t| now.saturating_duration_since(t) <= INPUT_WINDOW).unwrap_or(false);
        o.beating && since_write >= heartbeat && recent_input
    } else {
        since_write >= IDLE_KEEPALIVE
    }
}

/// One heartbeat round at `now`. `spawn`: each rewrite on its own thread (the
/// app), else inline (tests). Returns how many rewrites were started.
pub fn beat_once(ctx: &Arc<FileCtx>, now: Instant, spawn: bool) -> usize {
    let due: Vec<PathBuf> = {
        let mut st = lk(&ctx.presence);
        if st.closing {
            return 0;
        }
        let hb = st.heartbeat;
        st.own
            .iter_mut()
            .filter(|(_, o)| rewrite_due(o, now, hb))
            .map(|(k, o)| {
                o.busy = true;
                k.clone()
            })
            .collect()
    };
    let n = due.len();
    for doc in due {
        if spawn {
            let c = ctx.clone();
            let spawned = std::thread::Builder::new().name("presence-beat".into()).spawn(move || rewrite(&c, &doc, now));
            if let Err(e) = spawned {
                log::warn!("[presence] couldn't start a rewrite: {e}");
            }
        } else {
            rewrite(ctx, &doc, now);
        }
    }
    n
}

fn rewrite(ctx: &FileCtx, doc: &Path, now: Instant) {
    let unbusy = |retry: bool| {
        if let Some(o) = lk(&ctx.presence).own.get_mut(doc) {
            o.busy = false;
            if retry {
                o.retry_at = Some(now + RETRY_AFTER);
            }
        }
    };
    let Some(_g) = ctx.note_locks.try_lock(doc) else {
        // A presence_set / clear holds it: skipped for this round.
        return unbusy(false);
    };
    let Some(snap) = lk(&ctx.presence).own.get(doc).cloned() else { return };
    if lk(&ctx.presence).closing {
        return unbusy(false);
    }
    let mut note = snap.note.clone();
    note.seq += 1;
    note.updated_at = iso_utc(wall_ms());
    let text = note_text(&note);
    match write_note(ctx, &snap.file, text.as_bytes()) {
        Ok(()) => {
            let mut st = state_lock(ctx);
            if st.closing {
                // Quit ran while this rewrite was on its way: the file it wrote goes again (fixer VS-3).
                drop(st);
                let (dev, ses) = (note.device_id.clone(), note.session_id.clone());
                delete_if(ctx, &snap.file, &|n: &NoteJson| n.device_id == dev && n.session_id == ses);
                return;
            }
            let floor = st.seq_floor.entry(doc.to_path_buf()).or_insert(0);
            *floor = (*floor).max(note.seq);
            if let Some(o) = st.own.get_mut(doc) {
                o.busy = false;
                o.retry_at = None;
                if o.file == snap.file && o.note.seq == snap.note.seq {
                    o.note = note;
                    o.last_write = now;
                }
            }
            st.seen.insert(snap.file.clone(), SeenEntry { sha: sha256_hex(text.as_bytes()), since: wall_ms() });
            st.seen_dirty = true;
        }
        Err(e) => {
            log::warn!("[presence] couldn't rewrite the note {}: {}", snap.file.display(), e.message);
            unbusy(true);
        }
    }
}

/// The poll thread saw a sleep gap: the heartbeat stops until the next
/// presence_set of each document, and the frontend hears `wake`.
pub fn on_wake(ctx: &FileCtx, gap_ms: i64) {
    for o in lk(&ctx.presence).own.values_mut() {
        o.beating = false;
        // Input from before the sleep does not count after it: `Instant` does not run during sleep, so it
        // would still look recent. The rewrites start again with the next real input (fixer VP-5).
        o.last_input = None;
    }
    ctx.emit(EVT_FILE, json!({ "type": "wake", "gapMs": gap_ms }));
}

/// Start the heartbeat thread (one tick per second on the monotonic clock).
pub fn start(ctx: Arc<FileCtx>) {
    if cfg!(debug_assertions) {
        if let Some(hb) = crate::devenv::note_heartbeat_from_env() {
            lk(&ctx.presence).heartbeat = hb;
        }
    }
    let spawned = std::thread::Builder::new().name("presence".into()).spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| beat_once(&ctx, Instant::now(), true))).is_err() {
            log::error!("[presence] a heartbeat round failed unexpectedly; continuing");
        }
        if lk(&ctx.presence).closing {
            break;
        }
    });
    if let Err(e) = spawned {
        log::error!("[presence] couldn't start the heartbeat thread: {e}");
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// Another computer's abandoned note (contract §3.7)
// ═════════════════════════════════════════════════════════════════════════════

#[derive(Debug, Clone, Deserialize)]
pub struct RemoveNoteArgs {
    pub file: String,
    pub sha: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RemoveNoteReply {
    Removed,
    Kept { reason: &'static str },
}

pub fn remove_foreign(ctx: &FileCtx, req: &RemoveNoteArgs) -> FResult<RemoveNoteReply> {
    let p = PathBuf::from(&req.file);
    let plain = p.components().all(|c| !matches!(c, Component::ParentDir | Component::CurDir));
    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if !p.is_absolute() || !plain || !is_note_file_name(&name) {
        return Err(FileErr::invalid(format!("not a note file: {:?}", req.file)));
    }
    let kept = |reason| Ok(RemoveNoteReply::Kept { reason });
    let m = match fs::symlink_metadata(&p) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => return kept("gone"),
        Err(e) => return Err(FileErr::from_io(&e, &p)),
        Ok(m) => m,
    };
    if !m.is_file() || m.len() > NOTE_MAX_BYTES {
        return kept("notANote");
    }
    let bytes = match read_capped(&p) {
        Ok(b) => b,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return kept("gone"),
        Err(e) => return Err(FileErr::from_io(&e, &p)),
    };
    let Some(note) = parse_note(&bytes) else { return kept("notANote") };
    if sha256_hex(&bytes) != req.sha {
        return kept("changed");
    }
    if own_ids(ctx).contains(&note.device_id) {
        return kept("own");
    }
    match fs::remove_file(&p) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => return kept("gone"),
        Err(e) => return Err(FileErr::from_io(&e, &p)),
    }
    forget_cached(ctx, &p);
    {
        let mut st = state_lock(ctx);
        if st.seen.remove(&p).is_some() {
            st.seen_dirty = true;
        }
    }
    persist_seen(ctx, false);
    Ok(RemoveNoteReply::Removed)
}

// ═════════════════════════════════════════════════════════════════════════════
// Quit, crash, start (contract §3.8)
// ═════════════════════════════════════════════════════════════════════════════

/// Quit: delete every note this app registered or wrote, within `limit`.
/// Idempotent; returns at once when nothing is registered. Returns true when
/// the deletions finished inside the limit.
pub fn delete_all_own(ctx: &Arc<FileCtx>, limit: Duration) -> bool {
    let files: Vec<PathBuf> = {
        let mut st = state_lock(ctx);
        st.closing = true;
        if st.own.is_empty() && st.written.is_empty() {
            return true;
        }
        let mut files: Vec<PathBuf> = st.own.drain().map(|(_, o)| o.file).collect();
        for w in &st.written {
            if !files.contains(w) {
                files.push(w.clone());
            }
        }
        files
    };
    let c = ctx.clone();
    let session = ctx.session_id();
    let (tx, rx) = std::sync::mpsc::channel();
    let spawned = std::thread::Builder::new().name("presence-quit".into()).spawn(move || {
        let ids = own_ids(&c);
        // Only this launch's notes: a second copy of the app on the same state folder keeps its own
        // (fixer VS-5); leftovers of earlier launches go with the next start's sweep.
        for f in &files {
            delete_if(&c, f, &|n: &NoteJson| ids.contains(&n.device_id) && n.session_id == session);
        }
        persist_written(&c);
        persist_seen(&c, true);
        let _ = tx.send(());
    });
    if spawned.is_err() {
        return false;
    }
    rx.recv_timeout(limit).is_ok()
}

/// Startup sweep: a file in `written` that is not registered now and still
/// reads as an own note of another session is deleted; entries whose file is
/// gone (or is no note of mine any more) are dropped. Returns how many were deleted.
pub fn sweep_leftovers(ctx: &FileCtx) -> usize {
    let (files, registered) = {
        let st = state_lock(ctx);
        if st.closing {
            return 0;
        }
        (st.written.iter().cloned().collect::<Vec<_>>(), st.own.values().map(|o| o.file.clone()).collect::<Vec<_>>())
    };
    let session = ctx.session_id();
    let ids = own_ids(ctx);
    let mut deleted = 0;
    let mut drop_entry = Vec::new();
    for f in files {
        if registered.contains(&f) {
            continue;
        }
        match fs::symlink_metadata(&f) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => drop_entry.push(f),
            Err(_) => {}
            Ok(_) => match read_note_fresh(&f) {
                Some((n, _)) if ids.contains(&n.device_id) => {
                    if n.session_id != session && delete_if_own(ctx, &f, &ids) {
                        deleted += 1;
                    }
                }
                _ => drop_entry.push(f),
            },
        }
    }
    {
        let mut st = state_lock(ctx);
        for f in drop_entry {
            st.written.remove(&f);
        }
    }
    persist_written(ctx);
    deleted
}

/// Called by take_pending_opens: the sweep runs once, `delay` later, in the background.
pub fn schedule_sweep(ctx: &Arc<FileCtx>, delay: Duration) {
    {
        let mut st = lk(&ctx.presence);
        if st.sweep_scheduled {
            return;
        }
        st.sweep_scheduled = true;
    }
    let c = ctx.clone();
    let _ = std::thread::Builder::new().name("presence-sweep".into()).spawn(move || {
        std::thread::sleep(delay);
        let n = sweep_leftovers(&c);
        if n > 0 {
            log::info!("[presence] removed {n} note(s) left by an earlier launch");
        }
    });
}

// ═════════════════════════════════════════════════════════════════════════════
// Tauri commands
// ═════════════════════════════════════════════════════════════════════════════

use crate::graphfile::{blocking, Ctx, COMMAND_TIMEOUT};

#[tauri::command]
pub async fn presence_set(ctx: tauri::State<'_, Ctx>, req: PresenceSetArgs) -> Result<PresenceSetReply, FileErr> {
    let ctx = ctx.inner().clone();
    let now = Instant::now();
    blocking(COMMAND_TIMEOUT, move || set_note(&ctx, &req, now)).await
}

#[tauri::command]
pub async fn presence_clear(ctx: tauri::State<'_, Ctx>, doc_path: String) -> Result<(), FileErr> {
    let ctx = ctx.inner().clone();
    blocking(COMMAND_TIMEOUT, move || clear_note(&ctx, &doc_path)).await
}

#[tauri::command]
pub async fn presence_input(ctx: tauri::State<'_, Ctx>, doc_path: String) -> Result<(), FileErr> {
    note_input(&ctx, Path::new(&doc_path), Instant::now());
    Ok(())
}

#[tauri::command]
pub async fn presence_list(ctx: tauri::State<'_, Ctx>, doc_path: String, analysis_id: String) -> Result<PresenceListReply, FileErr> {
    let ctx = ctx.inner().clone();
    blocking(COMMAND_TIMEOUT, move || {
        let doc = check_doc_path(&doc_path)?;
        if !valid_id(&analysis_id) {
            return Err(FileErr::invalid(format!("bad analysis id: {analysis_id:?}")));
        }
        scan_notes(&ctx, &doc, &analysis_id)
    })
    .await
}

#[tauri::command]
pub async fn presence_remove_foreign(ctx: tauri::State<'_, Ctx>, req: RemoveNoteArgs) -> Result<RemoveNoteReply, FileErr> {
    let ctx = ctx.inner().clone();
    blocking(COMMAND_TIMEOUT, move || remove_foreign(&ctx, &req)).await
}

#[cfg(test)]
#[path = "presence_tests.rs"]
mod tests;
