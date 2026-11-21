//! Poll state machine with an injected clock and a temp folder
//! (phase1-contract.md §3, §9.4).

use super::*;
use crate::graphfile::tests::util::*;
use crate::graphfile::{save, SaveArgs, SaveReply};
use std::fs;
use std::sync::Mutex;

fn cfg() -> WatchCfg {
    WatchCfg { stable_wait: Duration::ZERO, look_timeout: None, ..Default::default() }
}

struct World {
    dir: PathBuf,
    ctx: Arc<FileCtx>,
    ev: Arc<Mutex<Vec<(String, Value)>>>,
    m: Mk,
}

impl World {
    fn new(tag: &str) -> Self {
        let dir = tmpdir(tag);
        let ctx = Arc::new(ctx(&dir));
        let ev = collect(&ctx);
        let mut m = Mk::new("a-w");
        m.rev("r-1", &[], t4(&texts("1")));
        World { dir, ctx, ev, m }
    }
    fn p(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }
    /// Save through the app (journal, record, track update).
    fn app_save(&self, p: &Path, head: &str, expected: Option<&str>) -> SaveReply {
        let a: SaveArgs = self.m.args(p, head, expected, self.m.parts.clone());
        save(&self.ctx, &a).unwrap()
    }
    /// Another computer's write.
    fn remote(&self, p: &Path, head: &str) {
        put(p, &self.m.bytes(head));
    }
    fn next(&mut self, id: &str, parent: &str) {
        let t = texts(id);
        self.m.rev(id, &[parent], t4(&t));
    }
    fn track(&self, p: &Path, head: &str, now: u64) {
        track(&self.ctx, p, true, Some(head.into()), Some("a-w".into()), now, &cfg());
    }
    fn tick(&self, now: u64) -> Vec<Value> {
        tick(&self.ctx, now, &cfg());
        let mut e = lk(&self.ev);
        let out = e.iter().map(|(n, v)| {
            assert_eq!(n, crate::graphfile::EVT_FILE);
            v.clone()
        }).collect();
        e.clear();
        out
    }
    fn tracked(&self) -> Vec<PathBuf> {
        lk(&self.ctx.watch).tracks.keys().cloned().collect()
    }
    fn s(&self, name: &str) -> String {
        self.p(name).to_string_lossy().into_owned()
    }
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn changed_cadence_and_own_save_not_reported() {
    let mut w = World::new("w-changed");
    let a = w.p("A.lag");
    w.app_save(&a, "r-1", None);
    w.track(&a, "r-1", 0);
    assert!(w.tick(0).is_empty(), "first look: same head, nothing");
    assert_eq!(lk(&w.ctx.watch).tracks[&a].next_due, 3000);
    // another computer saves r-2
    w.next("r-2", "r-1");
    w.remote(&a, "r-2");
    assert!(w.tick(2999).is_empty(), "not due yet");
    assert_eq!(w.tick(3000), vec![json!({"type":"changed","path":w.s("A.lag"),"head":"r-2"})]);
    assert!(w.tick(6000).is_empty(), "reported once");
    // background tabs: every 10 s
    track(&w.ctx, &a, false, None, None, 6000, &cfg());
    w.tick(9000);
    assert_eq!(lk(&w.ctx.watch).tracks[&a].next_due, 19_000, "background: 10 s");
    // the app's own save is never "changed"
    w.next("r-3", "r-2");
    assert!(matches!(w.app_save(&a, "r-3", Some("r-2")), SaveReply::Saved { .. }));
    poll_now(&w.ctx);
    assert!(w.tick(20_000).is_empty());
    assert_eq!(lk(&w.ctx.watch).tracks[&a].head.as_deref(), Some("r-3"));
}

#[test]
fn rename_is_followed_after_two_looks_and_five_seconds() {
    let mut w = World::new("w-moved");
    let a = w.p("A.lag");
    w.app_save(&a, "r-1", None);
    w.track(&a, "r-1", 0);
    w.tick(0);
    fs::rename(&a, w.p("B.lag")).unwrap();
    assert!(w.tick(3000).is_empty(), "first absent look");
    // the second look is scheduled at absent_since + 5 s
    assert_eq!(lk(&w.ctx.watch).tracks[&a].next_due, 8000);
    assert!(w.tick(7999).is_empty());
    assert_eq!(w.tick(8000), vec![json!({"type":"moved","from":w.s("A.lag"),"to":w.s("B.lag"),"head":"r-1"})]);
    assert_eq!(w.tracked(), vec![w.p("B.lag")]);
    // a later save goes to B; the old name is not recreated
    w.next("r-2", "r-1");
    let r = w.app_save(&w.p("B.lag"), "r-2", Some("r-1"));
    assert!(matches!(r, SaveReply::Saved { .. }));
    assert!(!a.exists());
    poll_now(&w.ctx);
    assert!(w.tick(9000).is_empty(), "own save not reported after the move");
}

#[test]
fn delete_then_create_within_five_seconds_is_not_missing() {
    let mut w = World::new("w-recreate");
    let a = w.p("A.lag");
    w.app_save(&a, "r-1", None);
    w.track(&a, "r-1", 0);
    w.tick(0);
    let bytes = fs::read(&a).unwrap();
    fs::remove_file(&a).unwrap();
    assert!(w.tick(3000).is_empty());
    w.next("r-2", "r-1");
    w.remote(&a, "r-2");
    let _ = bytes;
    assert_eq!(w.tick(8000), vec![json!({"type":"changed","path":w.s("A.lag"),"head":"r-2"})]);
}

#[test]
fn conflict_copy_present_is_never_adopted() {
    let w = World::new("w-copy");
    let a = w.p("A.lag");
    let copy = w.p("A (Office iMac's conflicted copy).lag");
    w.app_save(&a, "r-1", None);
    w.remote(&copy, "r-1");
    w.track(&a, "r-1", 0);
    assert!(w.tick(0).is_empty(), "copy present at track time: seeded, not announced");
    fs::remove_file(&a).unwrap();
    assert!(w.tick(3000).is_empty());
    assert_eq!(w.tick(8000), vec![json!({"type":"missing","path":w.s("A.lag"),"candidates":[w.s("A (Office iMac's conflicted copy).lag")]})]);
    assert_eq!(w.tracked(), vec![a.clone()], "not re-pointed");
    assert!(w.tick(11_000).is_empty(), "missing sent once");
    // the save does not adopt it either
    let r = w.app_save(&a, "r-1", Some("r-1"));
    assert_eq!(r, SaveReply::Missing);
    // the file comes back (delete-then-create finished late)
    w.remote(&a, "r-1");
    assert_eq!(w.tick(14_000), vec![json!({"type":"back","path":w.s("A.lag"),"head":"r-1"})]);
}

#[test]
fn copy_seen_as_sibling_then_original_deleted_is_not_followed() {
    let mut w = World::new("w-sib");
    let a = w.p("A.lag");
    w.app_save(&a, "r-1", None);
    w.track(&a, "r-1", 0);
    w.tick(0);
    let copy = w.p("A copy.lag");
    w.remote(&copy, "r-1");
    assert_eq!(
        w.tick(3000),
        vec![json!({"type":"sibling","path":w.s("A.lag"),"sibling":w.s("A copy.lag"),"header":{"analysis_id":"a-w","head":"r-1"}})]
    );
    assert!(w.tick(6000).is_empty(), "sibling once");
    w.next("r-2", "r-1");
    w.remote(&copy, "r-2");
    assert_eq!(w.tick(9000)[0]["header"]["head"], "r-2", "again when its head changes");
    fs::remove_file(&a).unwrap();
    w.tick(12_000);
    let e = w.tick(17_000);
    assert_eq!(e[0]["type"], "missing");
    assert_eq!(w.tracked(), vec![a]);
}

#[test]
fn two_candidates_give_missing_with_both() {
    let w = World::new("w-two");
    let a = w.p("A.lag");
    w.app_save(&a, "r-1", None);
    w.track(&a, "r-1", 0);
    w.tick(0);
    fs::rename(&a, w.p("B.lag")).unwrap();
    w.remote(&w.p("C.lag"), "r-1");
    w.tick(3000);
    assert_eq!(w.tick(8000), vec![json!({"type":"missing","path":w.s("A.lag"),"candidates":[w.s("B.lag"), w.s("C.lag")]})]);
    // C goes away: B is now the single safe successor
    fs::remove_file(w.p("C.lag")).unwrap();
    assert_eq!(w.tick(11_000)[0]["type"], "moved");
    assert_eq!(w.tracked(), vec![w.p("B.lag")]);
}

#[test]
fn older_or_diverged_head_is_not_followed_and_other_id_never_adopted() {
    let mut w = World::new("w-older");
    let a = w.p("A.lag");
    w.next("r-2", "r-1");
    w.app_save(&a, "r-2", None);
    w.track(&a, "r-2", 0);
    w.tick(0);
    fs::remove_file(&a).unwrap();
    // an older copy (head r-1) appears under a new name
    let mut older = w.m.clone();
    older.revs.truncate(1);
    put(&w.p("B.lag"), &older.bytes("r-1"));
    // and a file of another analysis
    let mut other = Mk::new("a-other");
    other.rev("r-x", &[], t4(&texts("x")));
    put(&w.p("D.lag"), &other.bytes("r-x"));
    w.tick(3000);
    let e = w.tick(8000);
    assert_eq!(e, vec![json!({"type":"missing","path":w.s("A.lag"),"candidates":[w.s("B.lag")]})]);
    // another analysis at the tracked path: replaced, once
    put(&a, &other.bytes("r-x"));
    let e = w.tick(11_000);
    assert_eq!(e[0], json!({"type":"replaced","path":w.s("A.lag"),"analysisId":"a-other"}));
    assert!(e[1..].iter().all(|x| x["type"] == "sibling" && x["sibling"] == w.s("B.lag")), "{e:?}");
    assert!(w.tick(14_000).is_empty(), "replaced once");
    assert_eq!(lk(&w.ctx.watch).tracks[&a].state, TState::Replaced);
    // ours again → back
    w.remote(&a, "r-2");
    assert_eq!(w.tick(17_000), vec![json!({"type":"back","path":w.s("A.lag"),"head":"r-2"})]);
}

#[test]
fn unreadable_then_back() {
    let mut w = World::new("w-unread");
    let a = w.p("A.lag");
    w.app_save(&a, "r-1", None);
    w.track(&a, "r-1", 0);
    w.tick(0);
    put(&a, b"PK\x03\x04 arriving...");
    assert_eq!(w.tick(3000), vec![json!({"type":"unreadable","path":w.s("A.lag"),"reason":"Incomplete"})]);
    assert!(w.tick(6000).is_empty(), "sent when the reason starts or changes");
    w.next("r-2", "r-1");
    w.remote(&a, "r-2");
    assert_eq!(w.tick(9000), vec![json!({"type":"back","path":w.s("A.lag"),"head":"r-2"})]);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&a, fs::Permissions::from_mode(0o000)).unwrap();
        bump_mtime_unchecked(&a);
        let locked = fs::File::open(&a).is_err();
        let e = w.tick(12_000);
        fs::set_permissions(&a, fs::Permissions::from_mode(0o644)).unwrap();
        if locked {
            assert_eq!(e, vec![json!({"type":"unreadable","path":w.s("A.lag"),"reason":"PermissionDenied"})]);
            assert_eq!(w.tick(15_000), vec![json!({"type":"back","path":w.s("A.lag"),"head":"r-2"})]);
        }
    }
}

#[cfg(unix)]
fn bump_mtime_unchecked(p: &Path) {
    // set_modified needs a writable handle; use utimes through std on the path's parent trick: re-chmod briefly
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(p, fs::Permissions::from_mode(0o644)).unwrap();
    bump_mtime(p);
    fs::set_permissions(p, fs::Permissions::from_mode(0o000)).unwrap();
}

#[test]
fn file_still_changing_is_left_for_the_next_look() {
    let mut w = World::new("w-stable");
    let a = w.p("A.lag");
    w.app_save(&a, "r-1", None);
    w.track(&a, "r-1", 0);
    w.tick(0);
    w.next("r-2", "r-1");
    w.remote(&a, "r-2");
    let a2 = a.clone();
    let late = w.m.bytes("r-2");
    let writer = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(100));
        put(&a2, &late);
    });
    let slow = WatchCfg { stable_wait: Duration::from_millis(300), look_timeout: None, ..Default::default() };
    tick(&w.ctx, 3000, &slow);
    writer.join().unwrap();
    assert!(lk(&w.ev).is_empty(), "size/mtime moved during the 300 ms: wait");
    assert_eq!(w.tick(6000), vec![json!({"type":"changed","path":w.s("A.lag"),"head":"r-2"})]);
}

#[test]
fn a_save_in_progress_makes_the_poll_skip() {
    let w = World::new("w-skip");
    let a = w.p("A.lag");
    w.app_save(&a, "r-1", None);
    w.track(&a, "r-1", 0);
    let g = w.ctx.locks.lock(&a);
    assert!(w.tick(0).is_empty());
    assert!(!lk(&w.ctx.watch).tracks[&a].seeded, "skipped");
    drop(g);
    w.tick(500);
    assert!(lk(&w.ctx.watch).tracks[&a].seeded);
}

#[test]
fn threaded_look_times_out_softly() {
    let w = World::new("w-thread");
    let a = w.p("A.lag");
    w.app_save(&a, "r-1", None);
    w.track(&a, "r-1", 0);
    let c = WatchCfg { stable_wait: Duration::ZERO, look_timeout: Some(Duration::from_secs(5)), ..Default::default() };
    tick(&w.ctx, 0, &c);
    assert!(lk(&w.ev).is_empty());
    assert!(lk(&w.ctx.watch).tracks[&a].seeded);
}

#[test]
fn untrack_and_track_update_keep_state() {
    let w = World::new("w-untrack");
    let a = w.p("A.lag");
    w.app_save(&a, "r-1", None);
    w.track(&a, "r-1", 0);
    w.tick(0);
    lk(&w.ctx.watch).tracks.get_mut(&a).unwrap().copy_table.insert(w.p("X.lag"));
    track(&w.ctx, &a, false, None, None, 100, &cfg());
    assert!(copy_table_of(&w.ctx, &a).contains(&w.p("X.lag")), "update keeps the copy table");
    untrack(&w.ctx, &a);
    assert!(w.tracked().is_empty());
}

#[test]
fn rename_before_the_first_look_is_followed_not_seeded_as_a_copy() {
    // Found by the app smoke run: the seeding look was dropped (a save bumped
    // the track), the file was renamed, and the next seeding listing put the
    // new name into the copy table. Seeding now waits until the path exists.
    let mut w = World::new("w-seed-race");
    let a = w.p("Smoke test.lag");
    w.app_save(&a, "r-1", None);
    w.track(&a, "r-1", 0);
    w.next("r-2", "r-1");
    assert!(matches!(w.app_save(&a, "r-2", Some("r-1")), SaveReply::Saved { .. }));
    fs::rename(&a, w.p("Renamed.lag")).unwrap();
    assert!(w.tick(0).is_empty());
    assert!(!lk(&w.ctx.watch).tracks[&a].seeded);
    assert!(copy_table_of(&w.ctx, &a).is_empty());
    assert_eq!(w.tick(5000), vec![json!({"type":"moved","from":w.s("Smoke test.lag"),"to":w.s("Renamed.lag"),"head":"r-2"})]);
}

#[test]
fn smoke_sequence_rename_after_own_saves() {
    let mut w = World::new("w-smoke");
    let a = w.p("Smoke test.lag");
    w.app_save(&a, "r-1", None);
    w.track(&a, "r-1", 0);
    w.tick(0);
    w.next("r-2", "r-1");
    assert!(matches!(w.app_save(&a, "r-2", Some("r-1")), SaveReply::Saved { .. }));
    w.tick(3000);
    fs::rename(&a, w.p("Renamed.lag")).unwrap();
    poll_now(&w.ctx);
    let e1 = w.tick(3500);
    let e2 = w.tick(8500);
    eprintln!("{e1:?} {e2:?} {:?}", lk(&w.ctx.watch).tracks.values().map(|t| (t.path.clone(), t.copy_table.clone(), t.head.clone())).collect::<Vec<_>>());
    assert_eq!(e2[0]["type"], "moved");
}

// ───────────── fixes after the phase 1 review ─────────────

/// V1: a rename that only changes case is followed as a rename; the file is never its own copy.
#[test]
fn case_only_rename_is_followed_not_a_sibling() {
    let w = World::new("case");
    let a = w.p("data.lag");
    w.app_save(&a, "r-1", None);
    w.track(&a, "r-1", 0);
    assert!(w.tick(0).is_empty());
    let b = w.p("Data.lag");
    fs::rename(&a, &b).unwrap();
    if fs::metadata(&a).is_err() {
        eprintln!("case-sensitive volume: the ordinary rename rule applies");
        return;
    }
    let mut all = vec![];
    for t in [3000u64, 6000, 9000, 12000] {
        all.extend(w.tick(t));
    }
    assert_eq!(all.len(), 1, "{all:?}");
    assert_eq!(all[0]["type"], "moved");
    assert_eq!(all[0]["from"], w.s("data.lag"));
    assert_eq!(all[0]["to"], w.s("Data.lag"));
    assert_eq!(all[0]["head"], "r-1");
    assert_eq!(w.tracked(), vec![b.clone()]);
    let t = &lk(&w.ctx.watch).tracks[&b];
    assert!(t.copy_table.is_empty(), "{:?}", t.copy_table);
}

/// V1: a tracked path in another Unicode normalisation than the name on disk is not its own copy.
#[test]
fn nfd_tracked_path_is_not_its_own_copy() {
    let w = World::new("nfd");
    let nfc = w.p("caf\u{e9}.lag");
    let nfd = w.p("cafe\u{301}.lag");
    w.app_save(&nfc, "r-1", None);
    if fs::metadata(&nfd).is_err() {
        eprintln!("normalisation-sensitive volume: nothing to check");
        return;
    }
    w.track(&nfd, "r-1", 0);
    let mut all = vec![];
    for t in [0u64, 3000, 6000, 9000] {
        all.extend(w.tick(t));
    }
    // at most a silent re-key to the spelling on disk; never a sibling / copy question
    assert!(all.iter().all(|e| e["type"] == "moved"), "{all:?}");
    for t in lk(&w.ctx.watch).tracks.values() {
        assert!(t.copy_table.is_empty(), "{:?}", t.copy_table);
    }
}

/// A real Finder duplicate beside a case-renamed file is still a copy.
#[test]
fn a_duplicate_is_still_a_sibling_after_identity_checks() {
    let w = World::new("dup-id");
    let a = w.p("A.lag");
    w.app_save(&a, "r-1", None);
    w.track(&a, "r-1", 0);
    assert!(w.tick(0).is_empty());
    fs::copy(&a, w.p("A copy.lag")).unwrap();
    let e = w.tick(3000);
    assert_eq!(e.len(), 1, "{e:?}");
    assert_eq!(e[0]["type"], "sibling");
    assert_eq!(e[0]["sibling"], w.s("A copy.lag"));
}
