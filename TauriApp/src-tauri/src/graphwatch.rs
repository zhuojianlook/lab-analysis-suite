//! The poll thread for open analysis files (phase1-contract.md §3, plan §5).
//!
//! No watcher crate: one thread ticks every 500 ms; each tracked file is
//! looked at every 3 s while it is the active tab and every 10 s otherwise,
//! and at once on window focus, on `graphfile_poll_now` and after the
//! computer slept. A look is a stat; the file is read only when its size or
//! modification time changed and it is local. Events go to the frontend on
//! `graphfile://event` (`RustFileEvent` in contract.ts).
//!
//! The safe follow rule (rename in the same folder) never adopts a copy:
//! every same-id file seen beside the tracked one goes into the track's copy
//! table and can never be a rename target.
//!
//! Phase 3: a look also lists the notes (`.laguse`) beside the tracked file
//! (presence::scan_notes; a note is read only when its size or mtime changed)
//! and reports `presence` with the full list when it changed. A sleep gap is
//! reported as `wake` and stops this computer's note heartbeat.

use crate::graphfile::{
    file_identity, follow_candidates, is_same_file, list_lag_files, lk, read_header, read_validated, request_download,
    stat_path, wall_ms, ErrKind, FileCtx, FileErr, FileHeader, FileStat, Follow, EVT_FILE,
};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TState {
    Ok,
    Missing,
    /// "Incomplete" | "Dataless" | "PermissionDenied" | "OfflineOrTimeout"
    Unreadable(&'static str),
    Replaced,
}

#[derive(Debug, Clone)]
pub struct Track {
    pub path: PathBuf,
    pub active: bool,
    pub analysis_id: Option<String>,
    pub head: Option<String>,
    /// Size and mtime of the last valid look with the tracked id.
    pub record: Option<(u64, i64)>,
    /// Same-id files ever seen beside the tracked path: never rename targets.
    pub copy_table: BTreeSet<PathBuf>,
    pub absent_since: Option<u64>,
    pub absent_looks: u32,
    pub state: TState,
    pub sibling_heads: HashMap<PathBuf, String>,
    /// Stat of the other analysis's file while `Replaced` (not re-read until it changes).
    pub replaced_seen: Option<(u64, i64)>,
    pub next_due: u64,
    /// Bumped by every change from outside the poll (track, save, re-key);
    /// a look whose snapshot is older is dropped.
    pub gen: u64,
    pub seeded: bool,
    /// Phase 3: signature of the notes last reported (None: report the next listing whatever it is).
    pub notes_sig: Option<String>,
}

impl Track {
    fn new(path: PathBuf, now: u64) -> Self {
        Track {
            path,
            active: false,
            analysis_id: None,
            head: None,
            record: None,
            copy_table: BTreeSet::new(),
            absent_since: None,
            absent_looks: 0,
            state: TState::Ok,
            sibling_heads: HashMap::new(),
            replaced_seen: None,
            next_due: now,
            gen: 0,
            seeded: false,
            notes_sig: Some(crate::presence::empty_sig()),
        }
    }
}

pub struct WatchState {
    pub tracks: BTreeMap<PathBuf, Track>,
    epoch: Instant,
}

impl Default for WatchState {
    fn default() -> Self {
        WatchState { tracks: BTreeMap::new(), epoch: Instant::now() }
    }
}

/// Header cache for folder listings, keyed by path, valid while size/mtime match.
#[derive(Debug, Clone)]
pub struct CacheEntry {
    pub size: u64,
    pub mtime: i64,
    pub header: Option<FileHeader>,
}

#[derive(Debug, Clone)]
pub struct WatchCfg {
    pub active_ms: u64,
    pub background_ms: u64,
    /// Two stats this far apart must agree before a changed file is read.
    pub stable_wait: Duration,
    pub missing_ms: u64,
    /// Each look runs on its own thread with this timeout (None: inline, tests).
    pub look_timeout: Option<Duration>,
}

impl Default for WatchCfg {
    fn default() -> Self {
        WatchCfg {
            active_ms: 3000,
            background_ms: 10_000,
            stable_wait: Duration::from_millis(300),
            missing_ms: 5000,
            look_timeout: Some(Duration::from_secs(15)),
        }
    }
}

impl WatchCfg {
    fn interval(&self, active: bool) -> u64 {
        if active {
            self.active_ms
        } else {
            self.background_ms
        }
    }
}

/// Milliseconds on the poll's monotonic clock.
pub fn watch_now(ctx: &FileCtx) -> u64 {
    lk(&ctx.watch).epoch.elapsed().as_millis() as u64
}

// ═════════════════════════════════════════════════════════════════════════════
// Changes from commands and saves
// ═════════════════════════════════════════════════════════════════════════════

/// `graphfile_track`: create or update (never resets the copy table or the
/// missing state; non-null head / analysis id overwrite).
pub fn track(ctx: &FileCtx, path: &Path, active: bool, head: Option<String>, analysis_id: Option<String>, now: u64, cfg: &WatchCfg) {
    let mut w = lk(&ctx.watch);
    let t = w.tracks.entry(path.to_path_buf()).or_insert_with(|| Track::new(path.to_path_buf(), now));
    let became_active = active && !t.active;
    t.active = active;
    if let Some(h) = head {
        if t.head.as_ref() != Some(&h) {
            t.record = None;
        }
        t.head = Some(h);
    }
    if let Some(a) = analysis_id {
        if t.analysis_id.as_ref() != Some(&a) {
            t.seeded = false;
            t.record = None;
        }
        t.analysis_id = Some(a);
    }
    if became_active {
        t.next_due = t.next_due.min(now + cfg.active_ms);
    }
    t.gen += 1;
}

pub fn untrack(ctx: &FileCtx, path: &Path) {
    lk(&ctx.watch).tracks.remove(path);
}

/// Every track due now.
pub fn poll_now(ctx: &FileCtx) {
    for t in lk(&ctx.watch).tracks.values_mut() {
        t.next_due = 0;
    }
}

pub fn copy_table_of(ctx: &FileCtx, path: &Path) -> BTreeSet<PathBuf> {
    lk(&ctx.watch).tracks.get(path).map(|t| t.copy_table.clone()).unwrap_or_default()
}

/// A save followed a rename: the track now lives at `to`.
pub fn rekey(ctx: &FileCtx, from: &Path, to: &Path, head: &str, st: &FileStat) {
    let mut w = lk(&ctx.watch);
    if let Some(mut t) = w.tracks.remove(from) {
        t.path = to.to_path_buf();
        t.copy_table.remove(to);
        t.sibling_heads.remove(to);
        t.head = Some(head.to_string());
        t.record = Some((st.size, st.mtime));
        t.state = TState::Ok;
        t.absent_since = None;
        t.absent_looks = 0;
        t.notes_sig = None;
        t.gen += 1;
        w.tracks.insert(to.to_path_buf(), t);
    }
}

/// The app's own save: never reported as `changed`.
pub fn note_saved(ctx: &FileCtx, path: &Path, analysis_id: &str, head: &str, st: &FileStat) {
    let mut w = lk(&ctx.watch);
    if let Some(t) = w.tracks.get_mut(path) {
        t.analysis_id = Some(analysis_id.to_string());
        t.head = Some(head.to_string());
        t.record = Some((st.size, st.mtime));
        t.state = TState::Ok;
        t.absent_since = None;
        t.absent_looks = 0;
        t.replaced_seen = None;
        t.gen += 1;
    }
}

/// The head a copy had when it was put into `track_path`'s copy table (None
/// when it isn't in the table).
pub fn copy_head(ctx: &FileCtx, track_path: &Path, copy: &Path) -> Option<String> {
    let w = lk(&ctx.watch);
    let t = w.tracks.get(track_path)?;
    if !t.copy_table.contains(copy) {
        return None;
    }
    t.sibling_heads.get(copy).cloned()
}

/// A copy the app wrote beside a tracked file (saved aside): never a rename
/// target and not announced as a sibling.
pub fn add_copy(ctx: &FileCtx, track_path: &Path, copy: &Path, head: &str) {
    let mut w = lk(&ctx.watch);
    if let Some(t) = w.tracks.get_mut(track_path) {
        t.copy_table.insert(copy.to_path_buf());
        t.sibling_heads.insert(copy.to_path_buf(), head.to_string());
        t.gen += 1;
    }
}

/// An extra copy was moved away (phase 2 remove copy): drop it from every
/// track's copy table and sibling memory, and from the header cache, so
/// nothing more is reported about it. A file that later appears at that path
/// again is new to every track.
pub fn forget_copy(ctx: &FileCtx, copy: &Path) {
    {
        let mut w = lk(&ctx.watch);
        for t in w.tracks.values_mut() {
            let in_table = t.copy_table.remove(copy);
            let had_head = t.sibling_heads.remove(copy).is_some();
            if in_table || had_head {
                // A look in flight still has the old tables: its result is dropped.
                t.gen += 1;
            }
        }
    }
    lk(&ctx.dir_cache).remove(copy);
}

// ═════════════════════════════════════════════════════════════════════════════
// Events
// ═════════════════════════════════════════════════════════════════════════════

fn ps(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn ev_unreadable(path: &Path, reason: &str) -> Value {
    json!({ "type": "unreadable", "path": ps(path), "reason": reason })
}

fn set_unreadable(t: &mut Track, reason: &'static str, ev: &mut Vec<Value>) {
    if t.state != TState::Unreadable(reason) {
        t.state = TState::Unreadable(reason);
        ev.push(ev_unreadable(&t.path, reason));
    }
}

/// Unreadable reason for an error; None when the file just vanished.
fn reason_of(e: &FileErr) -> Option<&'static str> {
    match e.kind {
        ErrKind::NotFound => None,
        ErrKind::PermissionDenied => Some("PermissionDenied"),
        ErrKind::Dataless => Some("Dataless"),
        ErrKind::OfflineOrTimeout => Some("OfflineOrTimeout"),
        _ => Some("Incomplete"),
    }
}

fn set_unreadable_for(t: &mut Track, e: &FileErr, ev: &mut Vec<Value>) {
    if let Some(r) = reason_of(e) {
        set_unreadable(t, r, ev);
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// One look (contract §3.2)
// ═════════════════════════════════════════════════════════════════════════════

pub struct LookResult {
    pub track: Track,
    pub rekey_to: Option<PathBuf>,
    pub events: Vec<Value>,
}

pub(crate) fn cached_header(ctx: &FileCtx, p: &Path, st: &FileStat) -> Option<FileHeader> {
    if let Some(c) = lk(&ctx.dir_cache).get(p) {
        if c.size == st.size && c.mtime == st.mtime {
            return c.header.clone();
        }
    }
    let h = read_header(p).ok().map(|x| x.0);
    lk(&ctx.dir_cache).insert(p.to_path_buf(), CacheEntry { size: st.size, mtime: st.mtime, header: h.clone() });
    h
}

/// What a folder listing says about a tracked file.
struct Listing {
    /// Other same-id files (local, not hidden), with their header.
    others: Vec<(PathBuf, FileHeader)>,
    /// The tracked file under another spelling (renamed by case or Unicode
    /// normalisation only: `stat` of the old spelling still works), with its header.
    respelled: Option<(PathBuf, FileHeader)>,
}

/// Same-id files beside `t.path`. The tracked file itself is recognised by
/// identity (device + inode), never by the spelling of its name, so it is
/// never its own copy. None when the tracked file itself is gone by the end
/// of the listing: a rename that happened during this look must not put the
/// new name into the copy table (the tracked path is stat'ed again after the
/// folder is listed).
fn same_id_files(ctx: &FileCtx, t: &Track, aid: &str) -> Option<Listing> {
    let dir = t.path.parent()?;
    let me = file_identity(&t.path);
    let files = list_lag_files(dir).ok()?;
    let exact = files.iter().any(|(p, _)| *p == t.path);
    let mut out = Listing { others: Vec::new(), respelled: None };
    for (p, st) in files {
        if p == t.path || st.dataless {
            continue;
        }
        let Some(h) = cached_header(ctx, &p, &st).filter(|h| h.analysis_id == aid) else { continue };
        if is_same_file(&p, &t.path, me) {
            if !exact && out.respelled.is_none() {
                out.respelled = Some((p, h));
            }
            continue;
        }
        out.others.push((p, h));
    }
    match stat_path(&t.path) {
        Ok(_) => Some(out),
        Err(_) => None,
    }
}

/// At track creation: same-id files already there go into the copy table,
/// remembered with their head, without an event. False when it must be retried.
fn seed(ctx: &FileCtx, t: &mut Track, aid: &str) -> bool {
    let Some(files) = same_id_files(ctx, t, aid) else { return false };
    for (p, h) in files.others {
        t.copy_table.insert(p.clone());
        t.sibling_heads.insert(p, h.head);
    }
    true
}

/// Siblings (§3.2 step 7). Returns the new path when the tracked file turned
/// out to be renamed by case / normalisation only: the track follows it at
/// once (it is the same file, so no wait and no safe-follow check).
fn siblings(ctx: &FileCtx, t: &mut Track, ev: &mut Vec<Value>) -> Option<PathBuf> {
    let aid = t.analysis_id.clone()?;
    let listing = same_id_files(ctx, t, &aid)?;
    let mut moved_to = None;
    if let Some((to, h)) = listing.respelled {
        let head = t.head.clone().unwrap_or_else(|| h.head.clone());
        ev.push(json!({ "type": "moved", "from": ps(&t.path), "to": ps(&to), "head": head }));
        t.copy_table.remove(&to);
        t.sibling_heads.remove(&to);
        t.path = to.clone();
        t.notes_sig = None;
        moved_to = Some(to);
    }
    for (p, h) in listing.others {
        t.copy_table.insert(p.clone());
        if t.sibling_heads.get(&p) == Some(&h.head) {
            continue;
        }
        if let Ok((v, _, _)) = read_validated(&p) {
            if v.header.analysis_id == aid {
                ev.push(json!({
                    "type": "sibling", "path": ps(&t.path), "sibling": ps(&p),
                    "header": { "analysis_id": v.header.analysis_id, "head": v.header.head },
                }));
                t.sibling_heads.insert(p, v.header.head);
            }
        }
    }
    moved_to
}

fn mark_ok(t: &mut Track, head: &str, changed: bool, ev: &mut Vec<Value>) {
    if t.state == TState::Ok {
        if changed {
            ev.push(json!({ "type": "changed", "path": ps(&t.path), "head": head }));
        }
    } else {
        t.state = TState::Ok;
        t.replaced_seen = None;
        ev.push(json!({ "type": "back", "path": ps(&t.path), "head": head }));
    }
}

/// §3.2 step 6: the file is present and changed (or returning from a non-Ok state).
fn present_changed(ctx: &FileCtx, t: &mut Track, st: &FileStat, cfg: &WatchCfg, ev: &mut Vec<Value>) {
    if !cfg.stable_wait.is_zero() {
        std::thread::sleep(cfg.stable_wait);
    }
    match stat_path(&t.path) {
        Ok(s2) if s2.size == st.size && s2.mtime == st.mtime && !s2.dataless => {}
        _ => return, // still moving: next look
    }
    let hdr = match read_header(&t.path) {
        Ok((h, _)) => h,
        Err(e) => return set_unreadable_for(t, &e, ev),
    };
    let Some(aid) = t.analysis_id.clone() else {
        // Tracked without an id: adopt what is there, silently.
        match read_validated(&t.path) {
            Ok((v, vst, _)) => {
                ctx.set_record(&t.path, &v, &vst);
                t.analysis_id = Some(v.header.analysis_id.clone());
                t.head.get_or_insert(v.header.head.clone());
                t.record = Some((vst.size, vst.mtime));
                mark_ok(t, &v.header.head, false, ev);
            }
            Err(e) => set_unreadable_for(t, &e, ev),
        }
        return;
    };
    if hdr.analysis_id != aid {
        match read_validated(&t.path) {
            Ok((v, vst, _)) if v.header.analysis_id != aid => {
                t.replaced_seen = Some((vst.size, vst.mtime));
                if t.state != TState::Replaced {
                    t.state = TState::Replaced;
                    ev.push(json!({ "type": "replaced", "path": ps(&t.path), "analysisId": v.header.analysis_id }));
                }
            }
            Ok(_) => set_unreadable(t, "Incomplete", ev),
            Err(e) => set_unreadable_for(t, &e, ev),
        }
        return;
    }
    if t.head.as_deref() == Some(hdr.head.as_str()) {
        t.record = Some((st.size, st.mtime));
        mark_ok(t, &hdr.head, false, ev);
        return;
    }
    match read_validated(&t.path) {
        Ok((v, vst, _)) if v.header.analysis_id == aid => {
            ctx.set_record(&t.path, &v, &vst);
            let known = t.head.is_some();
            t.record = Some((vst.size, vst.mtime));
            t.head = Some(v.header.head.clone());
            mark_ok(t, &v.header.head, known, ev);
        }
        Ok(_) => set_unreadable(t, "Incomplete", ev),
        Err(e) => set_unreadable_for(t, &e, ev),
    }
}

/// §3.3: the path is absent. Returns the new path when the track was followed.
fn absent(ctx: &FileCtx, t: &mut Track, others: &BTreeSet<PathBuf>, now: u64, cfg: &WatchCfg, ev: &mut Vec<Value>) -> Option<PathBuf> {
    if t.state != TState::Missing {
        match t.absent_since {
            None => {
                t.absent_since = Some(now);
                t.absent_looks = 1;
                t.next_due = now + cfg.missing_ms;
                return None;
            }
            Some(since) => {
                t.absent_looks += 1;
                if !(t.absent_looks >= 2 && now.saturating_sub(since) >= cfg.missing_ms) {
                    t.next_due = t.next_due.min(since + cfg.missing_ms);
                    return None;
                }
            }
        }
    }
    let send_missing = |t: &mut Track, candidates: Vec<PathBuf>, ev: &mut Vec<Value>| {
        if t.state != TState::Missing {
            t.state = TState::Missing;
            let c: Vec<String> = candidates.iter().map(|p| ps(p)).collect();
            ev.push(json!({ "type": "missing", "path": ps(&t.path), "candidates": c }));
        }
    };
    let Some(aid) = t.analysis_id.clone() else {
        send_missing(t, vec![], ev);
        return None;
    };
    let mut exclude = t.copy_table.clone();
    exclude.extend(others.iter().cloned());
    match follow_candidates(&t.path, &aid, t.head.as_deref(), &exclude) {
        Ok(Follow { follow: Some((to, v, st)), .. }) => {
            ctx.set_record(&to, &v, &st);
            ev.push(json!({ "type": "moved", "from": ps(&t.path), "to": ps(&to), "head": v.header.head }));
            t.copy_table.remove(&to);
            t.sibling_heads.remove(&to);
            t.state = TState::Ok;
            t.absent_since = None;
            t.absent_looks = 0;
            t.head = Some(v.header.head);
            t.record = Some((st.size, st.mtime));
            t.path = to.clone();
            t.notes_sig = None;
            Some(to)
        }
        Ok(f) => {
            let mut c = f.same_id;
            c.sort();
            send_missing(t, c, ev);
            None
        }
        Err(_) => {
            send_missing(t, vec![], ev);
            None
        }
    }
}

/// Phase 3 (contract §3.6): the notes beside the tracked file; `presence` with
/// the full list when their signature changed. Nothing when the folder can't
/// be listed. Also while the file is missing or unreadable.
fn notes(ctx: &FileCtx, t: &mut Track, ev: &mut Vec<Value>) {
    let Some(aid) = t.analysis_id.clone() else { return };
    let Ok(reply) = crate::presence::scan_notes_within(ctx, &t.path, &aid, crate::presence::READ_WAIT_POLL) else { return };
    let sig = crate::presence::notes_sig(&reply.notes, &ctx.session_id());
    if t.notes_sig.as_deref() != Some(sig.as_str()) {
        t.notes_sig = Some(sig);
        ev.push(json!({ "type": "presence", "path": ps(&t.path), "notes": reply.notes }));
    }
}

/// One look at a due track. None when a save holds the path (skipped).
pub fn look(ctx: &FileCtx, mut t: Track, others: &BTreeSet<PathBuf>, now: u64, cfg: &WatchCfg) -> Option<LookResult> {
    let _g = ctx.locks.try_lock(&t.path)?;
    let mut ev = Vec::new();
    let mut rekey_to = None;
    if !t.seeded {
        if let Some(aid) = t.analysis_id.clone() {
            t.seeded = seed(ctx, &mut t, &aid);
        }
    }
    match stat_path(&t.path) {
        Err(e) if e.kind == ErrKind::NotFound => {
            rekey_to = absent(ctx, &mut t, others, now, cfg, &mut ev);
        }
        Err(e) => {
            let r = if e.kind == ErrKind::PermissionDenied { "PermissionDenied" } else { "OfflineOrTimeout" };
            set_unreadable(&mut t, r, &mut ev);
        }
        Ok(st) => {
            t.absent_since = None;
            t.absent_looks = 0;
            if st.dataless {
                // An open file is online-only: ask for its download (never read here).
                request_download(&t.path);
                set_unreadable(&mut t, "Dataless", &mut ev);
            } else {
                let unchanged = t.record == Some((st.size, st.mtime)) && t.state == TState::Ok;
                let still_replaced = t.state == TState::Replaced && t.replaced_seen == Some((st.size, st.mtime));
                if !unchanged && !still_replaced {
                    present_changed(ctx, &mut t, &st, cfg, &mut ev);
                }
                rekey_to = siblings(ctx, &mut t, &mut ev);
            }
        }
    }
    notes(ctx, &mut t, &mut ev);
    Some(LookResult { track: t, rekey_to, events: ev })
}

/// One round: look at every due track, apply, then emit.
pub fn tick(ctx: &Arc<FileCtx>, now: u64, cfg: &WatchCfg) {
    let (snaps, all): (Vec<Track>, BTreeSet<PathBuf>) = {
        let mut w = lk(&ctx.watch);
        let all = w.tracks.keys().cloned().collect();
        let mut snaps = Vec::new();
        for t in w.tracks.values_mut() {
            if t.next_due <= now {
                t.next_due = now + cfg.interval(t.active);
                snaps.push(t.clone());
            }
        }
        (snaps, all)
    };
    for snap in snaps {
        let mut others = all.clone();
        others.remove(&snap.path);
        let res = match cfg.look_timeout {
            None => look(ctx, snap.clone(), &others, now, cfg),
            Some(limit) => {
                let (tx, rx) = std::sync::mpsc::channel();
                let (c, s, o, cf) = (ctx.clone(), snap.clone(), others.clone(), cfg.clone());
                std::thread::spawn(move || {
                    let _ = tx.send(look(&c, s, &o, now, &cf));
                });
                match rx.recv_timeout(limit) {
                    Ok(r) => r,
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                        let mut t = snap.clone();
                        let mut ev = Vec::new();
                        set_unreadable(&mut t, "OfflineOrTimeout", &mut ev);
                        Some(LookResult { track: t, rekey_to: None, events: ev })
                    }
                    Err(_) => None,
                }
            }
        };
        let Some(res) = res else {
            // Skipped (a save holds the path): look again on the next tick.
            if let Some(t) = lk(&ctx.watch).tracks.get_mut(&snap.path) {
                t.next_due = t.next_due.min(now);
            }
            continue;
        };
        let applied = {
            let mut w = lk(&ctx.watch);
            match w.tracks.get(&snap.path) {
                Some(cur) if cur.gen == snap.gen => {
                    // poll_now during the look wins; otherwise the look's own schedule.
                    let next_due = if cur.next_due < snap.next_due { cur.next_due } else { res.track.next_due.max(now) };
                    let mut t = res.track;
                    t.next_due = next_due;
                    match res.rekey_to {
                        Some(to) if !w.tracks.contains_key(&to) => {
                            w.tracks.remove(&snap.path);
                            t.gen += 1;
                            w.tracks.insert(to, t);
                        }
                        Some(_) => {} // another tab tracks the target: leave both alone
                        None => {
                            w.tracks.insert(snap.path.clone(), t);
                        }
                    }
                    true
                }
                _ => false,
            }
        };
        if applied {
            for e in res.events {
                ctx.emit(EVT_FILE, e);
            }
        }
    }
}

/// Start the poll thread.
pub fn start(ctx: Arc<FileCtx>) {
    let spawned = std::thread::Builder::new().name("graphwatch".into()).spawn(move || {
        let cfg = WatchCfg::default();
        let mut last_wall = wall_ms();
        // How long the last look took on the monotonic clock (which does not run during sleep): a look that
        // blocked on a stalled folder is not a sleep (fixer VP-5).
        let mut busy_ms: i64 = 0;
        loop {
            std::thread::sleep(Duration::from_millis(500));
            let wall = wall_ms();
            let gap = wall - last_wall - busy_ms;
            if gap > 90_000 {
                // The computer slept: look at everything now, stop the note
                // heartbeat and tell the frontend (phase 3 `wake`).
                poll_now(&ctx);
                crate::presence::on_wake(&ctx, gap);
            }
            last_wall = wall;
            let now = watch_now(&ctx);
            let t0 = Instant::now();
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| tick(&ctx, now, &cfg))).is_err() {
                log::error!("[graphwatch] a look failed unexpectedly; continuing");
            }
            busy_ms = i64::try_from(t0.elapsed().as_millis()).unwrap_or(i64::MAX / 2);
        }
    });
    if let Err(e) = spawned {
        log::error!("[graphwatch] couldn't start the poll thread: {e}");
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// Tauri commands
// ═════════════════════════════════════════════════════════════════════════════

use crate::graphfile::Ctx;

#[tauri::command]
pub async fn graphfile_track(
    ctx: tauri::State<'_, Ctx>,
    path: String,
    active: bool,
    head: Option<String>,
    analysis_id: Option<String>,
) -> Result<(), FileErr> {
    let now = watch_now(&ctx);
    track(&ctx, Path::new(&path), active, head, analysis_id, now, &WatchCfg::default());
    Ok(())
}

#[tauri::command]
pub async fn graphfile_untrack(ctx: tauri::State<'_, Ctx>, path: String) -> Result<(), FileErr> {
    untrack(&ctx, Path::new(&path));
    Ok(())
}

#[tauri::command]
pub async fn graphfile_poll_now(ctx: tauri::State<'_, Ctx>) -> Result<(), FileErr> {
    poll_now(&ctx);
    Ok(())
}

#[cfg(test)]
#[path = "graphwatch_tests.rs"]
mod tests;
