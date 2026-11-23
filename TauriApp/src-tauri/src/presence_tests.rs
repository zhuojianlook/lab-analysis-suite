//! cargo tests for presence.rs (phase3-contract.md §3.12, R1–R9, R12).

use super::*;
use crate::graphfile::tests::util::{collect, ctx as base_ctx, put, t4, texts, tmpdir, Mk};
use crate::graphwatch::{tick, track, WatchCfg};
use std::sync::Mutex;

// ── helpers ─────────────────────────────────────────────────────────────────

/// A context whose debug guard allows notes in `dir`.
fn pctx(dir: &Path) -> Arc<FileCtx> {
    let c = base_ctx(dir);
    lk(&c.presence).note_roots = Some(vec![dir.to_path_buf()]);
    Arc::new(c)
}

fn me(c: &FileCtx) -> crate::appstate::DeviceIdentity {
    crate::appstate::device(c).unwrap()
}

/// A `.lag` file with analysis id `aid` and one version `r-1`.
fn lag(dir: &Path, name: &str, aid: &str) -> PathBuf {
    let mut m = Mk::new(aid);
    m.rev("r-1", &[], t4(&texts(name)));
    let p = dir.join(name);
    fs::write(&p, m.bytes("r-1")).unwrap();
    p
}

fn note(aid: &str, doc: &str, dev: &str, seq: u64, state: &str) -> NoteJson {
    NoteJson {
        format: NOTE_FORMAT.into(),
        v: 1,
        analysis_id: aid.into(),
        document_name: doc.into(),
        device_id: dev.into(),
        session_id: "s-other".into(),
        device_name: "Office iMac".into(),
        user_name: "Alice".into(),
        state: state.into(),
        head: Some("r-1".into()),
        base_revision: (state == "editing").then(|| "r-1".to_string()),
        epoch: 1,
        seq,
        supersedes: None,
        updated_at: "2026-11-22T10:14:03.512Z".into(),
        request_to: None,
        handover_to: None,
        features: 2,
    }
}

/// Another computer's note, written the way a sync client places it.
fn place(dir: &Path, name: &str, n: &NoteJson) -> PathBuf {
    let p = dir.join(name);
    put(&p, note_text(n).as_bytes());
    p
}

fn args(doc: &Path, aid: &str, state: &str, epoch: f64) -> PresenceSetArgs {
    PresenceSetArgs {
        doc_path: path_str(doc),
        analysis_id: aid.into(),
        state: state.into(),
        head: Some("r-1".into()),
        base_revision: Some("r-1".into()),
        epoch,
        supersedes: vec![],
        input: false,
    }
}

fn written(r: PresenceSetReply) -> (PathBuf, NoteJson) {
    match r {
        PresenceSetReply::Written { file, note } => (PathBuf::from(file), note),
        other => panic!("not written: {other:?}"),
    }
}

fn read_back(p: &Path) -> NoteJson {
    parse_note(&fs::read(p).unwrap()).expect("a note")
}

fn names_in(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = fs::read_dir(dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    v.sort();
    v
}

fn notes_in(dir: &Path) -> Vec<String> {
    names_in(dir).into_iter().filter(|n| n.ends_with(".laguse")).collect()
}

// ── R1: names ───────────────────────────────────────────────────────────────

#[test]
fn r1_sanitize_and_tags() {
    let s = |t: &str| sanitize_name_part(t, STEM_CHARS, STEM_BYTES, "Analysis");
    let dv = |t: &str| sanitize_name_part(t, DEVICE_CHARS, DEVICE_BYTES, "computer");
    assert_eq!(note_file_name("Dose response.lag", "Mac mini", "d-6b1e\u{2026}9f3c", 0), "Dose response (in use on Mac mini, 9f3c).laguse");
    // a name that is only ".lag" has an empty stem, as in presence.ts (found by the integrator's cross-language run)
    assert_eq!(note_file_name(".lag", "m", "d-a", 0), "Analysis (in use on m, 00da).laguse");
    assert_eq!(note_file_name(".LAG", "m", "d-a", 0), "Analysis (in use on m, 00da).laguse");
    assert_eq!(s("Exp_2: 50% (v1.3)"), "Exp 2 50 (v1 3)");
    assert_eq!(s(".~hidden.tmp"), "hidden tmp");
    assert_eq!(s("a/b\\c:d*e?f\"g<h>i|j"), "a b c d e f g h i j");
    assert_eq!(dv("Zhuo's MacBook-Pro"), "Zhuo s MacBook-Pro");
    assert_eq!(s("用量反応 2026年"), "用量反応 2026年");
    assert_eq!(s(&"用".repeat(70)), "用".repeat(40), "60 characters = 180 bytes → cut to 120 bytes");
    assert_eq!(s("naïve—test"), "naïve—test");
    assert_eq!(s("   "), "Analysis");
    assert_eq!(s("..."), "Analysis");
    assert_eq!(dv(&"x".repeat(45)), "x".repeat(30));
    assert_eq!(s("~$report.lock"), "report lock");
    // controls, odd spaces → space; invisible characters removed
    assert_eq!(s("a\u{0}b\tc\u{85}d\u{a0}e\u{3000}f"), "a b c d e f");
    assert_eq!(s("in\u{200b}vis\u{feff}ible\u{202e}\u{ad}"), "invisible");
    assert_eq!(s("_vti_x"), "vti x");
    assert_eq!(dv(""), "computer");
    // tags
    assert_eq!(device_tag("d-6b1e\u{2026}9f3c", 0), "9f3c");
    assert_eq!(device_tag("d-preview-this", 0), "0dee");
    assert_eq!(device_tag("d-0123456789ABCDEF", 0), "cdef");
    assert_eq!(device_tag("d-0123456789ABCDEF", 1), "89ab");
    assert_eq!(device_tag("d-0123456789ABCDEF", 2), "89abcdef");
    assert_eq!(device_tag("xyz", 0), "0000", "no hex digits");
    assert_eq!(device_tag("d-preview-this", 1), "0000");
    assert_eq!(device_tag("d-preview-this", 2), "00000dee");
    // the whole name stays inside the rules, also for a 255-byte stem
    let stem = "é".repeat(127);
    let n = note_file_name(&format!("{stem}.lag"), &"Ж".repeat(40), "d-1", 0);
    assert!(n.len() <= 206, "{} bytes", n.len());
    assert!(!n.starts_with('.') && !n.starts_with('~') && n.ends_with(").laguse"));
    let any = note_file_name("~$a.tmp.lock .LAG", "./..", "x", 0);
    assert_eq!(any, "a tmp lock (in use on computer, 0000).laguse");
    assert!(!any.contains(".tmp") && !any.contains(".lock") && !any.contains("~$"));
    for bad in ['/', '\\', ':', '*', '?', '"', '<', '>', '|'] {
        assert!(!note_file_name(&format!("a{bad}b.lag"), &format!("c{bad}d"), "d-1", 0).contains(bad));
    }
    // a name is a note name by its extension only (any case), never when hidden
    assert!(is_note_file_name("X (in use on Mac, 1a2b).laguse"));
    assert!(is_note_file_name("X (in use on Mac, 1a2b) (conflicted copy 2026-11-22).laguse"));
    assert!(is_note_file_name("X (in use on Mac, 1a2b)-MACMINI.LAGUSE"));
    assert!(!is_note_file_name(".~X (in use on Mac, 1a2b).laguse.tmp-1234abcd"));
    assert!(!is_note_file_name(".X.laguse"));
    assert!(!is_note_file_name("X.lag") && !is_note_file_name("X.laguse.txt"));
}

// ── R2: bytes ───────────────────────────────────────────────────────────────

#[test]
fn r2_note_bytes_and_tolerances() {
    let mut n = note("a-3f0c", "Dose response.lag", "d-6b1e9f3c", 41, "editing");
    n.session_id = "s-1".into();
    n.device_name = "Mac mini".into();
    n.user_name = "Zhuo".into();
    n.head = Some("r-01JD".into());
    n.base_revision = Some("r-01JD".into());
    n.epoch = 3;
    let expected = "Lab Analysis Suite note: shows who has this analysis open. Safe to delete.\n{\n \"format\": \"lasgraph-presence\",\n \"v\": 1,\n \"analysis_id\": \"a-3f0c\",\n \"document_name\": \"Dose response.lag\",\n \"device_id\": \"d-6b1e9f3c\",\n \"session_id\": \"s-1\",\n \"device_name\": \"Mac mini\",\n \"user_name\": \"Zhuo\",\n \"state\": \"editing\",\n \"head\": \"r-01JD\",\n \"base_revision\": \"r-01JD\",\n \"epoch\": 3,\n \"seq\": 41,\n \"supersedes\": null,\n \"updated_at\": \"2026-11-22T10:14:03.512Z\",\n \"request_to\": null,\n \"handover_to\": null,\n \"features\": 2\n}\n";
    assert_eq!(note_text(&n), expected);
    assert_eq!(parse_note(expected.as_bytes()), Some(n.clone()));
    // a list of claims, and characters JSON.stringify escapes
    let mut m = n.clone();
    m.supersedes = Some(vec![NoteTarget { device_id: "d-x".into(), epoch: 2 }]);
    m.user_name = "Zh\"uo\\ \u{1}\n用".into();
    let t = note_text(&m);
    assert!(t.contains(" \"supersedes\": [\n  {\n   \"device_id\": \"d-x\",\n   \"epoch\": 2\n  }\n ],\n"), "{t}");
    assert!(t.contains(r#" "user_name": "Zh\"uo\\ \u0001\n用","#), "{t}");
    assert_eq!(parse_note(t.as_bytes()), Some(m));
    // tolerances
    let mut v: Value = serde_json::from_str(&expected[expected.find('{').unwrap()..]).unwrap();
    let as_text = |v: &Value| format!("\u{feff}{NOTE_FIRST_LINE}\n{}\ntrailing words", serde_json::to_string(v).unwrap());
    v["unknown"] = json!({"x": 1});
    v["state"] = json!("requesting");
    v["supersedes"] = json!({"device_id": "d-y", "epoch": 4});
    v["request_to"] = json!("d-z");
    v["handover_to"] = json!({"a": 1});
    v.as_object_mut().unwrap().remove("features");
    let p = parse_note(as_text(&v).as_bytes()).unwrap();
    assert_eq!(p.state, "idle", "unknown state → idle");
    assert_eq!(p.supersedes, Some(vec![NoteTarget { device_id: "d-y".into(), epoch: 4 }]), "one object → a list");
    assert_eq!((p.request_to.clone(), p.handover_to.clone(), p.features), (None, None, 2));
    assert!(!note_text(&p).contains("unknown"), "unknown keys are not kept");
    v["supersedes"] = json!([{"device_id": 5, "epoch": 1}, {"epoch": 1}, {"device_id": "d-q", "epoch": "x"}]);
    assert_eq!(parse_note(as_text(&v).as_bytes()).unwrap().supersedes, None, "bad entries dropped; empty → null");
    v["supersedes"] = json!([{"device_id": "d-q", "epoch": 7}, 3]);
    assert_eq!(parse_note(as_text(&v).as_bytes()).unwrap().supersedes.unwrap().len(), 1);
    // not a note
    let reject = |f: &dyn Fn(&mut Value)| {
        let mut w = v.clone();
        f(&mut w);
        parse_note(as_text(&w).as_bytes())
    };
    assert!(reject(&|w| w["format"] = json!("lasgraph")).is_none());
    assert!(reject(&|w| w["v"] = json!(2)).is_none());
    assert!(reject(&|w| w["device_id"] = json!("")).is_none());
    assert!(reject(&|w| {
        w.as_object_mut().unwrap().remove("session_id");
    })
    .is_none());
    assert!(reject(&|w| w["seq"] = json!("41")).is_none());
    assert!(reject(&|w| w["epoch"] = json!(-1)).is_none());
    assert!(reject(&|w| w["head"] = json!(5)).is_none());
    assert!(reject(&|w| w["user_name"] = json!(null)).is_none());
    assert!(parse_note(b"no object here").is_none());
    assert!(parse_note(b"} {").is_none());
    let mut big = as_text(&v);
    big.push_str(&" ".repeat(8193));
    assert!(parse_note(big.as_bytes()).is_none(), "over 8192 bytes is not a note");
    // ISO times
    assert_eq!(iso_utc(0), "1970-01-01T00:00:00.000Z");
    assert_eq!(iso_utc(1_763_640_000_000), "2025-11-20T12:00:00.000Z");
    assert_eq!(iso_utc(951_782_400_123), "2000-02-29T00:00:00.123Z");
    assert_eq!(iso_utc(4_102_444_799_999), "2099-12-31T23:59:59.999Z");
}

// ── R3: presence_set ────────────────────────────────────────────────────────

#[test]
fn r3_set_writes_replaces_and_continues() {
    let d = tmpdir("p3-set");
    let c = pctx(&d);
    let doc = lag(&d, "Dose response.lag", "a-1");
    let id = me(&c);
    let t0 = Instant::now();
    let (f1, n1) = written(set_note(&c, &args(&doc, "a-1", "idle", 0.0), t0).unwrap());
    let tag = device_tag(&id.device_id, 0);
    assert_eq!(f1, d.join(format!("Dose response (in use on Test Mac, {tag}).laguse")));
    assert_eq!(f1.parent(), doc.parent(), "beside the document, nowhere else");
    assert_eq!(fs::read_to_string(&f1).unwrap(), note_text(&n1));
    assert_eq!((n1.state.as_str(), n1.seq, n1.epoch, n1.base_revision.clone()), ("idle", 1, 0, None));
    assert_eq!((n1.device_id.clone(), n1.session_id.clone(), n1.user_name.clone()), (id.device_id.clone(), c.session_id(), "Tester".into()));
    assert_eq!(n1.document_name, "Dose response.lag");
    // a second call replaces it with seq + 1
    let mut a = args(&doc, "a-1", "editing", 1.0);
    a.supersedes = vec![TargetArg { device_id: "d-other".into(), epoch: 2.0 }];
    let (f2, n2) = written(set_note(&c, &a, t0).unwrap());
    assert_eq!(f2, f1);
    assert_eq!((n2.seq, n2.state.as_str(), n2.base_revision.as_deref()), (2, "editing", Some("r-1")));
    assert_eq!(n2.supersedes, Some(vec![NoteTarget { device_id: "d-other".into(), epoch: 2 }]));
    assert_eq!(read_back(&f1), n2);
    assert_eq!(notes_in(&d).len(), 1);
    assert!(!names_in(&d).iter().any(|n| n.contains(".tmp-")), "no temp left");
    // idle: no base, no claims
    let mut a = args(&doc, "a-1", "idle", 1.0);
    a.supersedes = vec![TargetArg { device_id: "d-other".into(), epoch: 2.0 }];
    let (_, n3) = written(set_note(&c, &a, t0).unwrap());
    assert_eq!((n3.base_revision, n3.supersedes, n3.seq), (None, None, 3));
    // an own leftover of an earlier launch with a higher seq (and an own conflict copy) → continued, deleted
    let mut left = note("a-1", "Dose response.lag", &id.device_id, 41, "editing");
    left.session_id = "s-earlier".into();
    let copy = place(&d, &format!("Dose response (in use on Test Mac, {tag}) (conflicted copy 2026-11-22).laguse"), &left);
    let (f4, n4) = written(set_note(&c, &args(&doc, "a-1", "idle", 1.0), t0).unwrap());
    assert_eq!(n4.seq, 42, "continued from the leftover");
    assert_eq!(f4, f1);
    assert!(!copy.exists(), "own conflict copy deleted");
    assert_eq!(notes_in(&d).len(), 1);
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn r3_names_taken_by_other_devices() {
    let d = tmpdir("p3-names");
    let c = pctx(&d);
    let doc = lag(&d, "A.lag", "a-1");
    let id = me(&c);
    let name = |att: u8| note_file_name("A.lag", "Test Mac", &id.device_id, att);
    // another device's note at the attempt-0 name → attempt 1
    let foreign = note("a-1", "A.lag", "d-other", 5, "editing");
    let f0 = place(&d, &name(0), &foreign);
    let (f, _) = written(set_note(&c, &args(&doc, "a-1", "idle", 0.0), Instant::now()).unwrap());
    assert_eq!(f, d.join(name(1)));
    assert_eq!(read_back(&f0), foreign, "the other device's note is untouched");
    // the next call keeps using attempt 1 (own note there)
    let (f, n) = written(set_note(&c, &args(&doc, "a-1", "idle", 0.0), Instant::now()).unwrap());
    assert_eq!((f, n.seq), (d.join(name(1)), 2));
    // a file at the name that is not a note is never overwritten
    let d2 = tmpdir("p3-names2");
    let c2 = pctx(&d2);
    let doc2 = lag(&d2, "A.lag", "a-1");
    let id2 = me(&c2);
    fs::write(d2.join(note_file_name("A.lag", "Test Mac", &id2.device_id, 0)), b"my shopping list").unwrap();
    let (f, _) = written(set_note(&c2, &args(&doc2, "a-1", "idle", 0.0), Instant::now()).unwrap());
    assert_eq!(f, d2.join(note_file_name("A.lag", "Test Mac", &id2.device_id, 1)));
    assert_eq!(fs::read(d2.join(note_file_name("A.lag", "Test Mac", &id2.device_id, 0))).unwrap(), b"my shopping list");
    // two documents whose names sanitise alike never share (or overwrite) one note
    let d3 = tmpdir("p3-names3");
    let c3 = pctx(&d3);
    let x = lag(&d3, "A b.lag", "a-1");
    let y = lag(&d3, "A_b.lag", "a-2");
    let (fx, nx) = written(set_note(&c3, &args(&x, "a-1", "idle", 0.0), Instant::now()).unwrap());
    let (fy, ny) = written(set_note(&c3, &args(&y, "a-2", "idle", 0.0), Instant::now()).unwrap());
    assert_ne!(fx, fy);
    assert_eq!((read_back(&fx), read_back(&fy)), (nx.clone(), ny));
    let (fx2, _) = written(set_note(&c3, &args(&x, "a-1", "editing", 1.0), Instant::now()).unwrap());
    assert_eq!(fx2, fx, "each keeps its own name");
    assert_eq!(notes_in(&d3).len(), 2);
    let _ = fs::remove_dir_all(&d);
    let _ = fs::remove_dir_all(&d2);
    let _ = fs::remove_dir_all(&d3);
}

#[test]
fn r3_refusals_guard_and_atomicity() {
    let d = tmpdir("p3-refuse");
    let c = pctx(&d);
    let doc = lag(&d, "A.lag", "a-1");
    let t = Instant::now();
    let kind = |a: PresenceSetArgs| set_note(&c, &a, t).unwrap_err().kind;
    let mut a = args(&doc, "a-1", "idle", 0.0);
    a.doc_path = "A.lag".into();
    assert_eq!(kind(a), ErrKind::Invalid, "not absolute");
    let mut a = args(&doc, "a-1", "idle", 0.0);
    a.doc_path = path_str(&d.join("A.txt"));
    assert_eq!(kind(a), ErrKind::Invalid, "not .lag");
    let mut a = args(&doc, "a-1", "idle", 0.0);
    a.doc_path = path_str(&d.join("sub").join("..").join("A.lag"));
    assert_eq!(kind(a), ErrKind::Invalid, "no ..");
    let mut a = args(&doc, "a-1", "idle", 0.0);
    a.analysis_id = "a/1".into();
    assert_eq!(kind(a), ErrKind::Invalid);
    let mut a = args(&doc, "a-1", "idle", 0.0);
    a.head = Some("../x".into());
    assert_eq!(kind(a), ErrKind::Invalid);
    assert_eq!(kind(args(&doc, "a-1", "idle", -1.0)), ErrKind::Invalid, "epoch ≥ 0");
    assert_eq!(kind(args(&doc, "a-1", "idle", 1.5)), ErrKind::Invalid);
    assert_eq!(kind(args(&doc, "a-1", "requesting", 0.0)), ErrKind::Invalid, "idle / editing only");
    assert_eq!(kind(args(&d.join("nope").join("A.lag"), "a-1", "idle", 0.0)), ErrKind::NotFound, "the folder must exist");
    // the document itself need not exist
    assert!(matches!(set_note(&c, &args(&d.join("Gone.lag"), "a-1", "idle", 0.0), t).unwrap(), PresenceSetReply::Written { .. }));
    assert!(clear_note(&c, &path_str(&d.join("Gone.lag"))).is_ok());
    // an interrupted write leaves the old note (and no temp)
    let (f, n1) = written(set_note(&c, &args(&doc, "a-1", "idle", 0.0), t).unwrap());
    lk(&c.hooks).before_note_rename = Some(Box::new(|_| Err(FileErr::io("power cut"))));
    assert_eq!(set_note(&c, &args(&doc, "a-1", "editing", 1.0), t).unwrap_err().kind, ErrKind::Io);
    lk(&c.hooks).before_note_rename = None;
    assert_eq!(read_back(&f), n1, "old note intact");
    assert_eq!(lk(&c.presence).own[&doc].note, n1, "registry as it was");
    assert!(!names_in(&d).iter().any(|n| n.contains(".tmp-")));
    // a temp left by a crash is never listed as a note
    fs::write(d.join(format!(".~{}.tmp-1234abcd", f.file_name().unwrap().to_string_lossy())), note_text(&n1)).unwrap();
    assert_eq!(scan_notes(&c, &doc, "a-1").unwrap().notes.len(), 1);
    // a symlink at the target name → Invalid, nothing written through it
    #[cfg(unix)]
    {
        let outside = tmpdir("p3-outside");
        fs::remove_file(&f).unwrap();
        let victim = outside.join("victim.txt");
        fs::write(&victim, b"keep").unwrap();
        std::os::unix::fs::symlink(&victim, &f).unwrap();
        assert_eq!(set_note(&c, &args(&doc, "a-1", "idle", 0.0), t).unwrap_err().kind, ErrKind::Invalid);
        assert_eq!(fs::read(&victim).unwrap(), b"keep");
        assert!(fs::symlink_metadata(&f).unwrap().file_type().is_symlink());
        // clearing never deletes through it either
        clear_note(&c, &path_str(&doc)).unwrap();
        assert_eq!(fs::read(&victim).unwrap(), b"keep");
        let _ = fs::remove_dir_all(&outside);
        fs::remove_file(&f).unwrap();
    }
    // debug guard: outside LAS_NOTE_ROOTS → off
    lk(&c.presence).note_roots = Some(vec![d.join("elsewhere")]);
    assert_eq!(set_note(&c, &args(&doc, "a-1", "idle", 0.0), t).unwrap(), PresenceSetReply::Off { reason: "debugRoot" });
    lk(&c.presence).note_roots = Some(vec![]);
    assert_eq!(set_note(&c, &args(&doc, "a-1", "idle", 0.0), t).unwrap(), PresenceSetReply::Off { reason: "debugRoot" });
    lk(&c.presence).note_roots = Some(vec![d.clone()]);
    // closing → off
    lk(&c.presence).closing = true;
    assert_eq!(set_note(&c, &args(&doc, "a-1", "idle", 0.0), t).unwrap(), PresenceSetReply::Off { reason: "closing" });
    let before = notes_in(&d);
    assert_eq!(notes_in(&d), before, "nothing written while closing");
    // wire shapes
    let v = serde_json::to_value(PresenceSetReply::Off { reason: "closing" }).unwrap();
    assert_eq!(v, json!({"kind": "off", "reason": "closing"}));
    let w = serde_json::to_value(PresenceSetReply::Written { file: "/x".into(), note: n1.clone() }).unwrap();
    assert_eq!(w["kind"], "written");
    assert_eq!(w["note"]["analysis_id"], "a-1");
    let a: PresenceSetArgs = serde_json::from_value(json!({
        "docPath": "/x/A.lag", "analysisId": "a-1", "state": "editing", "head": "r-1", "baseRevision": "r-1",
        "epoch": 2, "supersedes": [{"device_id": "d-1", "epoch": 1}], "input": true
    }))
    .unwrap();
    assert_eq!((a.epoch, a.supersedes.len(), a.input, a.base_revision.as_deref()), (2.0, 1, true, Some("r-1")));
    let _ = fs::remove_dir_all(&d);
}

// ── R4: presence_clear ──────────────────────────────────────────────────────

#[test]
fn r4_clear_deletes_only_my_notes_for_that_document() {
    let d = tmpdir("p3-clear");
    let c = pctx(&d);
    let a = lag(&d, "A.lag", "a-1");
    let b = lag(&d, "B.lag", "a-2");
    let id = me(&c);
    let (fa, _) = written(set_note(&c, &args(&a, "a-1", "editing", 1.0), Instant::now()).unwrap());
    let (fb, _) = written(set_note(&c, &args(&b, "a-2", "idle", 0.0), Instant::now()).unwrap());
    let foreign = place(&d, "A (in use on Office iMac, 9f3c).laguse", &note("a-1", "A.lag", "d-other", 3, "editing"));
    let mut old = note("a-1", "A.lag", &id.device_id, 1, "idle");
    old.session_id = "s-earlier".into();
    let leftover = place(&d, "A (in use on Old name, 0000).laguse", &old);
    clear_note(&c, &path_str(&a)).unwrap();
    assert!(!fa.exists() && !leftover.exists(), "my notes for A are gone");
    assert!(foreign.exists(), "a foreign note stays");
    assert!(fb.exists(), "my note of another document stays");
    assert!(!lk(&c.presence).own.contains_key(&a));
    assert!(lk(&c.presence).own.contains_key(&b));
    assert!(!lk(&c.presence).written.contains(&fa));
    // again: nothing to do, fine
    clear_note(&c, &path_str(&a)).unwrap();
    assert_eq!(clear_note(&c, "relative.lag").unwrap_err().kind, ErrKind::Invalid);
    let _ = fs::remove_dir_all(&d);
}

// ── R5: heartbeat ───────────────────────────────────────────────────────────

#[test]
fn r5_heartbeat_with_injected_clock() {
    let d = tmpdir("p3-beat");
    let c = pctx(&d);
    let doc = lag(&d, "A.lag", "a-1");
    let t0 = Instant::now();
    let at = |s: u64| t0 + Duration::from_secs(s);
    let mut a = args(&doc, "a-1", "editing", 1.0);
    a.input = true;
    let (f, _) = written(set_note(&c, &a, t0).unwrap());
    let seq = || read_back(&f).seq;
    assert_eq!(seq(), 1);
    assert_eq!(beat_once(&c, at(59), false), 0);
    assert_eq!(beat_once(&c, at(60), false), 1);
    assert_eq!(seq(), 2, "one rewrite after 60 s with recent input");
    assert_eq!(beat_once(&c, at(61), false), 0);
    assert_eq!(beat_once(&c, at(120), false), 1);
    assert_eq!(seq(), 3);
    for s in [180, 240, 300, 360, 420, 480, 540, 600] {
        assert_eq!(beat_once(&c, at(s), false), 1, "{s}");
    }
    assert_eq!(seq(), 11);
    assert_eq!(beat_once(&c, at(660), false), 0, "no input for more than 10 min → no rewrite");
    assert_eq!(beat_once(&c, at(900), false), 0);
    assert_eq!(read_back(&f).state, "editing", "still says editing");
    note_input(&c, &doc, at(950));
    assert_eq!(beat_once(&c, at(950), false), 1, "input again: at once, 60 s have passed");
    assert_eq!(seq(), 12);
    assert_eq!(beat_once(&c, at(1000), false), 0);
    // a sleep gap stops the beating until the next presence_set
    let ev = collect(&c);
    on_wake(&c, 125_000);
    assert_eq!(lk(&ev).as_slice(), &[(EVT_FILE.to_string(), json!({"type": "wake", "gapMs": 125_000}))]);
    note_input(&c, &doc, at(1100));
    assert_eq!(beat_once(&c, at(1100), false), 0, "stopped after the gap");
    assert_eq!(beat_once(&c, at(1300), false), 0);
    let mut a = args(&doc, "a-1", "editing", 2.0);
    a.input = true;
    set_note(&c, &a, at(1300)).unwrap();
    assert_eq!(seq(), 13);
    assert_eq!(beat_once(&c, at(1360), false), 1, "beating again after the set");
    assert_eq!(seq(), 14);
    // the heartbeat is skipped while a note operation holds the document
    {
        let _g = c.note_locks.lock(&doc);
        assert_eq!(beat_once(&c, at(1420), false), 1, "started");
        assert_eq!(seq(), 14, "but skipped for this round");
    }
    assert_eq!(beat_once(&c, at(1420), false), 1);
    assert_eq!(seq(), 15);
    // idle keep-alive every 6 h
    set_note(&c, &args(&doc, "a-1", "idle", 2.0), at(2000)).unwrap();
    assert_eq!(seq(), 16);
    assert_eq!(beat_once(&c, at(2000 + 6 * 3600 - 1), false), 0);
    on_wake(&c, 100_000);
    assert_eq!(beat_once(&c, at(2000 + 6 * 3600), false), 1, "not stopped by a gap");
    assert_eq!(read_back(&f).state, "idle");
    assert_eq!(seq(), 17);
    // a failed rewrite is tried again later
    lk(&c.hooks).before_note_rename = Some(Box::new(|_| Err(FileErr::io("disk full"))));
    let t2 = at(2000 + 12 * 3600);
    assert_eq!(beat_once(&c, t2, false), 1);
    assert_eq!(beat_once(&c, t2 + Duration::from_secs(1), false), 0, "not every second");
    lk(&c.hooks).before_note_rename = None;
    assert_eq!(beat_once(&c, t2 + RETRY_AFTER, false), 1);
    assert_eq!(seq(), 18);
    // closing: no rewrites at all
    lk(&c.presence).closing = true;
    assert_eq!(beat_once(&c, t2 + IDLE_KEEPALIVE * 2, true), 0);
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn r5_heartbeat_thread_variant() {
    let d = tmpdir("p3-beat-thread");
    let c = pctx(&d);
    let doc = lag(&d, "A.lag", "a-1");
    let t0 = Instant::now();
    let mut a = args(&doc, "a-1", "editing", 1.0);
    a.input = true;
    let (f, _) = written(set_note(&c, &a, t0).unwrap());
    assert_eq!(beat_once(&c, t0 + HEARTBEAT, true), 1);
    let deadline = Instant::now() + Duration::from_secs(5);
    while read_back(&f).seq < 2 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(read_back(&f).seq, 2);
    while lk(&c.presence).own[&doc].busy && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(!lk(&c.presence).own[&doc].busy);
    let _ = fs::remove_dir_all(&d);
}

// ── R6: scan_notes ──────────────────────────────────────────────────────────

#[test]
fn r6_scan_matching() {
    let d = tmpdir("p3-scan");
    let c = pctx(&d);
    let a = lag(&d, "A.lag", "a-1");
    lag(&d, "C.lag", "a-2");
    let by_case = place(&d, "x1.laguse", &note("a-1", "a.LAG", "d-x1", 1, "editing"));
    let by_id = place(&d, "x2.laguse", &note("a-1", "Old name.lag", "d-x2", 1, "editing"));
    let orphan_note = place(&d, "x3.laguse", &note("a-gone", "Z.lag", "d-x3", 1, "idle"));
    let other_doc = place(&d, "x4.laguse", &note("a-2", "C.lag", "d-x4", 1, "idle"));
    let wrong_id = place(&d, "x5.laguse", &note("a-9", "A.lag", "d-x5", 1, "idle"));
    fs::write(d.join("x6.laguse"), b"not a note at all").unwrap();
    let r = scan_notes(&c, &a, "a-1").unwrap();
    let get = |p: &Path| r.notes.iter().find(|n| n.file == path_str(p)).cloned();
    assert!(get(&by_case).unwrap().applies, "by name, ignoring case");
    assert!(get(&by_id).unwrap().applies, "the only file with that id");
    let o = get(&orphan_note).unwrap();
    assert!(o.orphan && !o.applies);
    assert!(get(&other_doc).is_none(), "a note of another existing document is not listed");
    let w = get(&wrong_id).unwrap();
    assert!(!w.applies && w.orphan, "another analysis id is never about this document");
    assert_eq!(r.notes.len(), 4);
    assert!(!r.truncated);
    assert!(r.notes.windows(2).all(|p| p[0].file < p[1].file), "sorted by file");
    let rec = get(&by_case).unwrap();
    assert_eq!(rec.sha, sha256_hex(&fs::read(&by_case).unwrap()));
    assert_eq!(rec.size, fs::metadata(&by_case).unwrap().len());
    assert!(!rec.own);
    // a second file with the same id (Finder duplicate): the sole-id rule no longer holds
    let b = d.join("A copy.lag");
    fs::copy(&a, &b).unwrap();
    let r = scan_notes(&c, &a, "a-1").unwrap();
    let get = |p: &Path| r.notes.iter().find(|n| n.file == path_str(p)).cloned();
    assert!(get(&by_case).unwrap().applies);
    assert!(get(&by_id).is_none(), "applies to neither of the two, and not an orphan");
    let rb = scan_notes(&c, &b, "a-1").unwrap();
    assert!(!rb.notes.iter().any(|n| n.file == path_str(&by_case)), "the note naming A is not about the copy");
    // wire shape
    let v = serde_json::to_value(&r).unwrap();
    assert!(v["notes"][0].get("unchangedSince").is_some() && v["notes"][0]["note"].get("analysis_id").is_some());
    assert_eq!(v["truncated"], false);
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn r6_scan_own_alias_bounds_cache_and_since() {
    let d = tmpdir("p3-scan2");
    let c = pctx(&d);
    let a = lag(&d, "A.lag", "a-1");
    let id = me(&c);
    let mine = place(&d, "mine.laguse", &note("a-1", "A.lag", &id.device_id, 1, "idle"));
    crate::appstate::new_device_identity(&c).unwrap();
    let r = scan_notes(&c, &a, "a-1").unwrap();
    // fixer VP-1: an earlier id is NOT own — another running computer may still use it.
    assert!(!r.notes.iter().find(|n| n.file == path_str(&mine)).unwrap().own, "an earlier id of this computer is not own");
    // an oversized file is skipped without being read
    fs::write(d.join("big.laguse"), vec![b' '; 9000]).unwrap();
    let reads0 = lk(&c.note_reader.cache).reads;
    let r1 = scan_notes(&c, &a, "a-1").unwrap();
    assert_eq!(lk(&c.note_reader.cache).reads, reads0, "nothing new read: unchanged files come from the cache, the big one is skipped");
    assert!(!r1.notes.iter().any(|n| n.file.ends_with("big.laguse")));
    let foreign = place(&d, "f.laguse", &note("a-1", "A.lag", "d-f", 1, "editing"));
    let r2 = scan_notes(&c, &a, "a-1").unwrap();
    assert_eq!(lk(&c.note_reader.cache).reads, reads0 + 1, "only the new file is read");
    let since = r2.notes.iter().find(|n| n.file == path_str(&foreign)).unwrap().unchanged_since;
    // unchangedSince survives a restart (graph-notes.json)
    persist_seen(&c, true);
    let c2 = pctx(&d);
    let r3 = scan_notes(&c2, &a, "a-1").unwrap();
    assert_eq!(r3.notes.iter().find(|n| n.file == path_str(&foreign)).unwrap().unchanged_since, since);
    // … and starts again when the bytes change
    std::thread::sleep(Duration::from_millis(5));
    place(&d, "f.laguse", &note("a-1", "A.lag", "d-f", 2, "editing"));
    let r4 = scan_notes(&c2, &a, "a-1").unwrap();
    assert!(r4.notes.iter().find(|n| n.file == path_str(&foreign)).unwrap().unchanged_since > since);
    // a deleted file is dropped from the record
    fs::remove_file(&foreign).unwrap();
    scan_notes(&c2, &a, "a-1").unwrap();
    assert!(!lk(&c2.presence).seen.contains_key(&foreign));
    // an unreadable record file is moved aside
    let state = d.join("state");
    fs::write(state.join("graph-notes.json"), b"{not json").unwrap();
    let c3 = pctx(&d);
    scan_notes(&c3, &a, "a-1").unwrap();
    assert!(names_in(&state).iter().any(|n| n.starts_with("graph-notes.json.bad-")));
    // bounded at 200 note files, by name order
    let d2 = tmpdir("p3-scan-many");
    let c4 = pctx(&d2);
    let a2 = lag(&d2, "A.lag", "a-1");
    for i in 0..205 {
        place(&d2, &format!("n{i:03}.laguse"), &note("a-1", "A.lag", &format!("d-{i}"), 1, "idle"));
    }
    let r = scan_notes(&c4, &a2, "a-1").unwrap();
    assert!(r.truncated);
    assert_eq!(r.notes.len(), NOTES_PER_FOLDER);
    assert!(r.notes.last().unwrap().file.ends_with("n199.laguse"));
    let _ = fs::remove_dir_all(&d);
    let _ = fs::remove_dir_all(&d2);
}

// ── R7: the poll ────────────────────────────────────────────────────────────

fn wcfg() -> WatchCfg {
    WatchCfg { stable_wait: Duration::ZERO, look_timeout: None, ..Default::default() }
}

fn presence_events(ev: &Arc<Mutex<Vec<(String, Value)>>>) -> Vec<Value> {
    let mut e = lk(ev);
    let out = e.iter().filter(|(_, v)| v["type"] == "presence").map(|(_, v)| v.clone()).collect();
    e.clear();
    out
}

#[test]
fn r7_poll_reports_note_changes() {
    let d = tmpdir("p3-poll");
    let c = pctx(&d);
    let ev = collect(&c);
    let a = lag(&d, "A.lag", "a-1");
    lag(&d, "C.lag", "a-2");
    track(&c, &a, true, Some("r-1".into()), Some("a-1".into()), 0, &wcfg());
    let mut now = 0;
    let mut look = || {
        tick(&c, now, &wcfg());
        now += 3000;
        presence_events(&ev)
    };
    assert!(look().is_empty(), "no notes: nothing");
    // a foreign note appears
    let f = place(&d, "A (in use on Office iMac, 9f3c).laguse", &note("a-1", "A.lag", "d-other", 1, "editing"));
    let e = look();
    assert_eq!(e.len(), 1);
    assert_eq!(e[0]["path"], path_str(&a));
    assert_eq!(e[0]["notes"].as_array().unwrap().len(), 1);
    assert_eq!(e[0]["notes"][0]["note"]["seq"], 1);
    assert!(look().is_empty(), "unchanged: nothing");
    // its seq changes
    place(&d, "A (in use on Office iMac, 9f3c).laguse", &note("a-1", "A.lag", "d-other", 2, "editing"));
    let e = look();
    assert_eq!(e.len(), 1);
    assert_eq!(e[0]["notes"][0]["note"]["seq"], 2);
    // my own note and its heartbeat: listed, but they never wake the frontend by themselves
    let t0 = Instant::now();
    let mut aa = args(&a, "a-1", "editing", 1.0);
    aa.input = true;
    set_note(&c, &aa, t0).unwrap();
    assert!(look().is_empty(), "my own note: no event");
    beat_once(&c, t0 + HEARTBEAT, false);
    assert!(look().is_empty(), "my own heartbeat: no event");
    // notes of an unrelated document: nothing
    place(&d, "C (in use on Office iMac, 9f3c).laguse", &note("a-2", "C.lag", "d-other", 1, "editing"));
    assert!(look().is_empty());
    // the foreign note disappears: one event with the full list (my own note only)
    fs::remove_file(&f).unwrap();
    let e = look();
    assert_eq!(e.len(), 1);
    let list = e[0]["notes"].as_array().unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0]["own"], true);
    assert!(look().is_empty());
    // a note of an earlier launch of mine (another session) does count
    let mut old = note("a-1", "A.lag", &me(&c).device_id, 1, "idle");
    old.session_id = "s-earlier".into();
    let left = place(&d, "A (in use on Old, 0000).laguse", &old);
    assert_eq!(look().len(), 1);
    fs::remove_file(&left).unwrap();
    assert_eq!(look().len(), 1);
    // after a re-key the new path gets an event even when nothing changed
    let st = crate::graphfile::stat_path(&a).unwrap();
    let a2 = d.join("A2.lag");
    fs::rename(&a, &a2).unwrap();
    crate::graphwatch::rekey(&c, &a, &a2, "r-1", &st);
    let e = look();
    assert_eq!(e.len(), 1);
    assert_eq!(e[0]["path"], path_str(&a2));
    // a folder that can't be listed: nothing
    let _ = fs::remove_dir_all(&d);
    assert!(look().is_empty());
}

// ── R8: presence_remove_foreign ─────────────────────────────────────────────

#[test]
fn r8_remove_foreign() {
    let d = tmpdir("p3-remove");
    let c = pctx(&d);
    let a = lag(&d, "A.lag", "a-1");
    let f = place(&d, "A (in use on Office iMac, 9f3c).laguse", &note("a-1", "A.lag", "d-other", 1, "editing"));
    let sha = sha256_hex(&fs::read(&f).unwrap());
    let req = |p: &Path, sha: &str| RemoveNoteArgs { file: path_str(p), sha: sha.into() };
    let kept = |r| match r {
        RemoveNoteReply::Kept { reason } => reason,
        RemoveNoteReply::Removed => "removed",
    };
    // changed since the decision
    place(&d, "A (in use on Office iMac, 9f3c).laguse", &note("a-1", "A.lag", "d-other", 2, "editing"));
    assert_eq!(kept(remove_foreign(&c, &req(&f, &sha)).unwrap()), "changed");
    assert!(f.exists());
    let sha2 = sha256_hex(&fs::read(&f).unwrap());
    scan_notes(&c, &a, "a-1").unwrap();
    assert!(lk(&c.presence).seen.contains_key(&f));
    assert_eq!(remove_foreign(&c, &req(&f, &sha2)).unwrap(), RemoveNoteReply::Removed);
    assert!(!f.exists());
    assert!(!lk(&c.presence).seen.contains_key(&f), "dropped from the record");
    assert_eq!(kept(remove_foreign(&c, &req(&f, &sha2)).unwrap()), "gone");
    // own
    let (mine, _) = written(set_note(&c, &args(&a, "a-1", "idle", 0.0), Instant::now()).unwrap());
    let msha = sha256_hex(&fs::read(&mine).unwrap());
    assert_eq!(kept(remove_foreign(&c, &req(&mine, &msha)).unwrap()), "own");
    assert!(mine.exists());
    // not a note: garbage, too big, a link
    let junk = d.join("junk.laguse");
    fs::write(&junk, b"hello").unwrap();
    assert_eq!(kept(remove_foreign(&c, &req(&junk, &sha256_hex(b"hello"))).unwrap()), "notANote");
    let big = d.join("big.laguse");
    fs::write(&big, vec![b'{'; 9000]).unwrap();
    assert_eq!(kept(remove_foreign(&c, &req(&big, "x")).unwrap()), "notANote");
    #[cfg(unix)]
    {
        let outside = tmpdir("p3-remove-out");
        let target = outside.join("T (in use on X, 1111).laguse");
        let text = note_text(&note("a-1", "A.lag", "d-other", 1, "idle"));
        fs::write(&target, &text).unwrap();
        let link = d.join("link.laguse");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert_eq!(kept(remove_foreign(&c, &req(&link, &sha256_hex(text.as_bytes()))).unwrap()), "notANote");
        assert!(target.exists() && link.exists(), "a link is never followed nor deleted");
        let _ = fs::remove_dir_all(&outside);
    }
    // refused names
    for bad in [d.join("A.lag"), d.join("notes.txt"), d.join(".hidden.laguse"), PathBuf::from("rel.laguse"), d.join("x").join("..").join("y.laguse")] {
        assert_eq!(remove_foreign(&c, &req(&bad, "x")).unwrap_err().kind, ErrKind::Invalid, "{}", bad.display());
    }
    assert!(d.join("A.lag").exists());
    assert_eq!(serde_json::to_value(RemoveNoteReply::Removed).unwrap(), json!({"kind": "removed"}));
    assert_eq!(serde_json::to_value(RemoveNoteReply::Kept { reason: "gone" }).unwrap(), json!({"kind": "kept", "reason": "gone"}));
    let _ = fs::remove_dir_all(&d);
}

// ── R9: quit, crash, start ──────────────────────────────────────────────────

#[test]
fn r9_quit_deletes_own_notes_and_sweep() {
    let d = tmpdir("p3-quit");
    let c = pctx(&d);
    let a = lag(&d, "A.lag", "a-1");
    let b = lag(&d, "B.lag", "a-2");
    let (fa, _) = written(set_note(&c, &args(&a, "a-1", "editing", 1.0), Instant::now()).unwrap());
    let (fb, _) = written(set_note(&c, &args(&b, "a-2", "idle", 0.0), Instant::now()).unwrap());
    let foreign = place(&d, "A (in use on Office iMac, 9f3c).laguse", &note("a-1", "A.lag", "d-other", 1, "editing"));
    let own_file = d.join("state").join("graph-notes-own.json");
    let rec: Value = serde_json::from_slice(&fs::read(&own_file).unwrap()).unwrap();
    assert_eq!(rec["files"].as_array().unwrap().len(), 2, "every note written is recorded");
    let t = Instant::now();
    assert!(delete_all_own(&c, QUIT_DELETE));
    assert!(t.elapsed() < QUIT_DELETE);
    assert!(!fa.exists() && !fb.exists(), "my notes are gone");
    assert!(foreign.exists(), "a foreign note stays");
    let rec: Value = serde_json::from_slice(&fs::read(&own_file).unwrap()).unwrap();
    assert!(rec["files"].as_array().unwrap().is_empty());
    assert!(lk(&c.presence).closing);
    // idempotent, and nothing is written afterwards
    let t = Instant::now();
    assert!(delete_all_own(&c, QUIT_DELETE));
    assert!(t.elapsed() < Duration::from_millis(100), "returns at once");
    assert_eq!(set_note(&c, &args(&a, "a-1", "idle", 0.0), Instant::now()).unwrap(), PresenceSetReply::Off { reason: "closing" });
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn r9_crash_leftovers_continue_and_sweep() {
    let d = tmpdir("p3-crash");
    let a = lag(&d, "A.lag", "a-1");
    let b = lag(&d, "B.lag", "a-2");
    // launch 1 writes notes and "crashes" (nothing deleted)
    let (fa, fb, s1) = {
        let c = pctx(&d);
        let mut x = args(&a, "a-1", "editing", 3.0);
        x.input = true;
        set_note(&c, &x, Instant::now()).unwrap();
        let (fa, n) = written(set_note(&c, &x, Instant::now()).unwrap());
        assert_eq!(n.seq, 2);
        let (fb, _) = written(set_note(&c, &args(&b, "a-2", "idle", 0.0), Instant::now()).unwrap());
        (fa, fb, c.session_id())
    };
    // launch 2: same state folder; the tab of A reopens, B's does not
    let c = pctx(&d);
    assert_ne!(c.session_id(), s1);
    let (fa2, n) = written(set_note(&c, &args(&a, "a-1", "idle", 0.0), Instant::now()).unwrap());
    assert_eq!(fa2, fa);
    assert_eq!((n.seq, n.session_id.clone()), (3, c.session_id()), "the leftover is found by content and continued");
    assert!(fb.exists(), "not yet: the sweep runs later");
    assert_eq!(sweep_leftovers(&c), 1);
    assert!(!fb.exists(), "a leftover of another session that is not registered now is deleted");
    assert!(fa.exists(), "a registered note is kept");
    let w = lk(&c.presence).written.clone();
    assert!(w.contains(&fa) && !w.contains(&fb));
    // entries whose file is gone are dropped
    let ghost = d.join("ghost (in use on X, 0000).laguse");
    lk(&c.presence).written.insert(ghost.clone());
    assert_eq!(sweep_leftovers(&c), 0);
    assert!(!lk(&c.presence).written.contains(&ghost));
    // a file of this session that is not registered is left alone
    let mut mine_now = note("a-2", "B.lag", &me(&c).device_id, 1, "idle");
    mine_now.session_id = c.session_id();
    let p = place(&d, "B (in use on Test Mac, 0000).laguse", &mine_now);
    lk(&c.presence).written.insert(p.clone());
    assert_eq!(sweep_leftovers(&c), 0);
    assert!(p.exists());
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn new_device_id_drops_registry_and_old_notes_are_replaced() {
    let d = tmpdir("p3-newid");
    let c = pctx(&d);
    let a = lag(&d, "A.lag", "a-1");
    let (f1, n1) = written(set_note(&c, &args(&a, "a-1", "idle", 0.0), Instant::now()).unwrap());
    // The other computer that keeps the old id writes its own note (another session id).
    let mut twin = n1.clone();
    twin.session_id = "s-twin".into();
    twin.device_name = "Twin Mac".into();
    let twin_file = place(&d, "A (in use on Twin Mac, 0000).laguse", &twin);
    let ident = crate::appstate::new_device_identity(&c).unwrap();
    assert!(lk(&c.presence).own.is_empty(), "registry dropped");
    assert!(!f1.exists(), "my note under the old id (this launch's session) is deleted at once");
    assert!(twin_file.exists(), "the other computer's note with the old id is never touched (fixer VP-1)");
    let (f2, n2) = written(set_note(&c, &args(&a, "a-1", "idle", 0.0), Instant::now()).unwrap());
    assert_eq!(n2.device_id, ident.device_id);
    assert_eq!(n2.session_id, ident.session_id);
    assert_eq!(n2.seq, n1.seq + 1, "the seq of this document goes on (never lower)");
    assert!(twin_file.exists(), "still there after my next write");
    assert_eq!(notes_in(&d).len(), 2);
    let r = scan_notes(&c, &a, "a-1").unwrap();
    assert!(!r.notes.iter().find(|x| x.file == path_str(&twin_file)).unwrap().own);
    assert!(r.notes.iter().find(|x| x.file == path_str(&f2)).unwrap().own);
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn rename_follow_and_computer_rename_leave_one_note() {
    let d = tmpdir("p3-rename");
    let c = pctx(&d);
    let a = lag(&d, "A.lag", "a-1");
    written(set_note(&c, &args(&a, "a-1", "idle", 0.0), Instant::now()).unwrap());
    // the computer is renamed: the note file is replaced by one with the new name
    crate::appstate::set_device(&c, &crate::appstate::DevicePatch { device_name: Some("Lab Mac".into()), user_name: None }).unwrap();
    let (f2, _) = written(set_note(&c, &args(&a, "a-1", "idle", 0.0), Instant::now()).unwrap());
    assert!(f2.file_name().unwrap().to_string_lossy().contains("in use on Lab Mac"));
    assert_eq!(notes_in(&d), vec![f2.file_name().unwrap().to_string_lossy().into_owned()]);
    // the document is renamed (moved): sync the new path, then clear the old one
    let b = d.join("B.lag");
    fs::rename(&a, &b).unwrap();
    let (f3, n3) = written(set_note(&c, &args(&b, "a-1", "idle", 0.0), Instant::now()).unwrap());
    clear_note(&c, &path_str(&a)).unwrap();
    assert_eq!(n3.document_name, "B.lag");
    assert_eq!(notes_in(&d), vec![f3.file_name().unwrap().to_string_lossy().into_owned()], "one note, for the new name");
    let _ = fs::remove_dir_all(&d);
}

// ── R12: notes are never analyses ───────────────────────────────────────────

#[test]
fn r12_listings_ignore_notes() {
    use crate::graphfile::{list_lag_files, locate, scan_dir, LocateLimits};
    let d = tmpdir("p3-listings");
    let x = lag(&d, "X.lag", "a-1");
    let n = note_text(&note("a-1", "X.lag", "d-other", 1, "editing"));
    for name in ["X (in use on Mac, 1a2b).laguse", "X (in use on Mac, 1a2b) (conflicted copy).laguse", "X (in use on Mac, 1a2b)-MACMINI.LAGUSE"] {
        fs::write(d.join(name), &n).unwrap();
    }
    // the sibling scan's listing
    let l = list_lag_files(&d).unwrap();
    assert_eq!(l.iter().map(|(p, _)| p.clone()).collect::<Vec<_>>(), vec![x.clone()]);
    // graphfile_scan_dir: listed as presence, without a header
    let s = scan_dir(&d).unwrap();
    let pres: Vec<_> = s.iter().filter(|e| e.kind == "presence").collect();
    assert_eq!(pres.len(), 3);
    assert!(pres.iter().all(|e| e.header.is_none()));
    assert_eq!(s.iter().filter(|e| e.kind == "graph").count(), 1);
    // Find it…
    let flag = std::sync::atomic::AtomicBool::new(false);
    let r = locate(&d, "a-1", &flag, LocateLimits::default(), &|| 0, &mut |_, _| {}).unwrap();
    assert_eq!(r.matches.len(), 1);
    assert!(r.matches[0].path.ends_with("X.lag"));
    // files opened from the command line / Finder
    let args: Vec<String> = std::iter::once("app".to_string())
        .chain(names_in(&d).into_iter().map(|n| path_str(&d.join(n))))
        .collect();
    assert_eq!(crate::opens::paths_from_args(args, &d), vec![path_str(&x)]);
    let urls: Vec<url::Url> = names_in(&d).iter().filter_map(|n| url::Url::from_file_path(d.join(n)).ok()).collect();
    assert_eq!(crate::opens::paths_from_urls(&urls), vec![path_str(&x)]);
    // the poll: never a sibling, never a rename target
    let c = pctx(&d);
    let ev = collect(&c);
    track(&c, &x, true, Some("r-1".into()), Some("a-1".into()), 0, &wcfg());
    tick(&c, 0, &wcfg());
    let evs: Vec<Value> = lk(&ev).iter().map(|(_, v)| v.clone()).collect();
    assert!(evs.iter().all(|v| v["type"] == "presence"), "{evs:?}");
    assert!(lk(&c.watch).tracks[&x].copy_table.is_empty());
    let _ = fs::remove_dir_all(&d);
}

// ── fixer regressions (VP-1, VP-5, VS-2, VS-3, VS-5, VS-9, F9) ─────────────────

/// VP-1: a computer migrated / restored from another Mac keeps that Mac's id as an alias. The other Mac
/// still uses it: its notes are foreign here, never deleted by my writes, clears or quit.
#[test]
fn fix_vp1_alias_notes_are_foreign() {
    let d = tmpdir("p3-fix-alias");
    let c = pctx(&d);
    let a = lag(&d, "A.lag", "a-1");
    // device.json as Migration Assistant leaves it: a new id, the original Mac's id kept as an alias.
    let state = d.join("state");
    me(&c);
    let mut rec: Value = serde_json::from_slice(&fs::read(state.join("device.json")).unwrap()).unwrap();
    rec["aliases"] = json!(["d-original-mac"]);
    fs::write(state.join("device.json"), rec.to_string()).unwrap();
    let c = pctx(&d);
    let orig = place(&d, "A (in use on Mac mini, 0000).laguse", &note("a-1", "A.lag", "d-original-mac", 7, "editing"));
    let r = scan_notes(&c, &a, "a-1").unwrap();
    let rec = r.notes.iter().find(|x| x.file == path_str(&orig)).unwrap();
    assert!(!rec.own && rec.applies, "the original Mac's editing note is another computer's");
    let mut x = args(&a, "a-1", "editing", 1.0);
    x.input = true;
    let (mine, n) = written(set_note(&c, &x, Instant::now()).unwrap());
    assert_eq!(n.seq, 1, "its seq is not continued");
    assert!(orig.exists(), "my write does not delete it");
    clear_note(&c, &path_str(&a)).unwrap();
    assert!(!mine.exists() && orig.exists(), "clear deletes only mine");
    set_note(&c, &x, Instant::now()).unwrap();
    assert!(delete_all_own(&c, QUIT_DELETE));
    assert_eq!(notes_in(&d), vec!["A (in use on Mac mini, 0000).laguse".to_string()], "quit deletes only mine");
    let rm = remove_foreign(&c, &RemoveNoteArgs { file: path_str(&orig), sha: rec.sha.clone() }).unwrap();
    assert_eq!(rm, RemoveNoteReply::Removed, "and the 24 h cleanup may remove it like any foreign note");
    let _ = fs::remove_dir_all(&d);
}

/// VP-5 (a): input from before a sleep does not keep the note rewritten after the wake-up.
#[test]
fn fix_vp5_wake_forgets_input() {
    let d = tmpdir("p3-fix-wake");
    let c = pctx(&d);
    let doc = lag(&d, "A.lag", "a-1");
    let t0 = Instant::now();
    let at = |s: u64| t0 + Duration::from_secs(s);
    let mut a = args(&doc, "a-1", "editing", 1.0);
    a.input = true;
    let (f, _) = written(set_note(&c, &a, t0).unwrap());
    on_wake(&c, 3_600_000);
    // the controller claims again by its timer, without input
    let mut b = args(&doc, "a-1", "editing", 2.0);
    b.input = false;
    set_note(&c, &b, at(45)).unwrap();
    let s0 = read_back(&f).seq;
    assert_eq!(beat_once(&c, at(110), false), 0, "no rewrite: nobody touched the computer since it woke");
    assert_eq!(read_back(&f).seq, s0);
    note_input(&c, &doc, at(120));
    assert_eq!(beat_once(&c, at(120), false), 1, "real input: rewritten again");
    let _ = fs::remove_dir_all(&d);
}

/// VS-2: the document renamed in the same folder and followed: one note, the old registration gone,
/// nothing writes the old note again.
#[test]
fn fix_vs2_rename_follow_leaves_one_note() {
    let d = tmpdir("p3-fix-rename");
    let c = pctx(&d);
    let doc = lag(&d, "Old name.lag", "a-1");
    let t0 = Instant::now();
    let mut a = args(&doc, "a-1", "editing", 1.0);
    a.input = true;
    written(set_note(&c, &a, t0).unwrap());
    let newdoc = d.join("New name.lag");
    fs::rename(&doc, &newdoc).unwrap();
    let mut b = args(&newdoc, "a-1", "editing", 1.0);
    b.input = true;
    let (nf, _) = written(set_note(&c, &b, t0).unwrap());
    assert_eq!(notes_in(&d), vec![nf.file_name().unwrap().to_string_lossy().into_owned()]);
    assert_eq!(lk(&c.presence).own.keys().cloned().collect::<Vec<_>>(), vec![newdoc.clone()], "the old registration is gone");
    for k in 1..4u32 {
        beat_once(&c, t0 + HEARTBEAT * k, false);
    }
    assert_eq!(notes_in(&d), vec![nf.file_name().unwrap().to_string_lossy().into_owned()], "no beat writes the old note again");
    // the controller clears the old path afterwards: the new note stays
    clear_note(&c, &path_str(&doc)).unwrap();
    assert!(nf.exists());
    let _ = fs::remove_dir_all(&d);
}

/// VS-3: quit racing with a note write never leaves a note behind.
#[test]
fn fix_vs3_quit_racing_with_writes() {
    // presence_set
    let d = tmpdir("p3-fix-quit-set");
    let c = pctx(&d);
    let doc = lag(&d, "A.lag", "a-1");
    written(set_note(&c, &args(&doc, "a-1", "idle", 0.0), Instant::now()).unwrap());
    let c2 = c.clone();
    lk(&c.hooks).before_note_rename = Some(Box::new(move |_| {
        delete_all_own(&c2, Duration::from_millis(1500));
        Ok(())
    }));
    let r = set_note(&c, &args(&doc, "a-1", "editing", 1.0), Instant::now()).unwrap();
    lk(&c.hooks).before_note_rename = None;
    assert_eq!(r, PresenceSetReply::Off { reason: "closing" });
    assert!(notes_in(&d).is_empty(), "nothing left: {:?}", notes_in(&d));
    let _ = fs::remove_dir_all(&d);
    // heartbeat
    let d = tmpdir("p3-fix-quit-beat");
    let c = pctx(&d);
    let doc = lag(&d, "A.lag", "a-1");
    let t0 = Instant::now();
    let mut a = args(&doc, "a-1", "editing", 1.0);
    a.input = true;
    written(set_note(&c, &a, t0).unwrap());
    let c2 = c.clone();
    lk(&c.hooks).before_note_rename = Some(Box::new(move |_| {
        delete_all_own(&c2, Duration::from_millis(1500));
        Ok(())
    }));
    assert_eq!(beat_once(&c, t0 + HEARTBEAT, false), 1);
    lk(&c.hooks).before_note_rename = None;
    assert!(notes_in(&d).is_empty(), "nothing left: {:?}", notes_in(&d));
    let _ = fs::remove_dir_all(&d);
}

/// VS-5: quit deletes only this launch's notes (a second copy of the app on the same state folder keeps
/// its own; leftovers of earlier launches go with the next start's sweep).
#[test]
fn fix_vs5_quit_only_this_launch() {
    let d = tmpdir("p3-fix-quit-session");
    let c = pctx(&d);
    let a = lag(&d, "A.lag", "a-1");
    let b = lag(&d, "B.lag", "a-2");
    let (fa, _) = written(set_note(&c, &args(&a, "a-1", "idle", 0.0), Instant::now()).unwrap());
    let mut other = note("a-2", "B.lag", &me(&c).device_id, 3, "idle");
    other.session_id = "s-second-copy".into();
    let fb = place(&d, "B (in use on Test Mac, 0000).laguse", &other);
    lk(&c.presence).written.insert(fb.clone());
    assert!(delete_all_own(&c, QUIT_DELETE));
    assert!(!fa.exists(), "mine is gone");
    assert!(fb.exists(), "the other launch's note stays");
    let _ = (b,);
    let _ = fs::remove_dir_all(&d);
}

/// VS-9: more than 200 notes in a folder: the document's own notes are looked at first.
#[test]
fn fix_vs9_prefers_the_documents_notes() {
    let d = tmpdir("p3-fix-many");
    let c = pctx(&d);
    let z = lag(&d, "zeta.lag", "a-z");
    for i in 0..205 {
        place(&d, &format!("n{i:03}.laguse"), &note("a-1", "A.lag", &format!("d-{i}"), 1, "idle"));
    }
    // "zeta (…" sorts after every "n…" name: without the preference it would be cut off.
    let mine = place(&d, "zeta (in use on Office iMac, 9f3c).laguse", &note("a-z", "zeta.lag", "d-other", 1, "editing"));
    let r = scan_notes(&c, &z, "a-z").unwrap();
    assert!(r.truncated);
    assert!(r.notes.iter().any(|x| x.file == path_str(&mine)), "the document's note is not cut off");
    let _ = fs::remove_dir_all(&d);
}

/// F9: a note cleared and written again (Never → Always) never goes back to a lower seq.
#[test]
fn fix_f9_seq_never_goes_down() {
    let d = tmpdir("p3-fix-seq");
    let c = pctx(&d);
    let a = lag(&d, "A.lag", "a-1");
    set_note(&c, &args(&a, "a-1", "idle", 0.0), Instant::now()).unwrap();
    let (_, n2) = written(set_note(&c, &args(&a, "a-1", "idle", 0.0), Instant::now()).unwrap());
    assert_eq!(n2.seq, 2);
    clear_note(&c, &path_str(&a)).unwrap();
    assert!(notes_in(&d).is_empty());
    let (_, n3) = written(set_note(&c, &args(&a, "a-1", "idle", 0.0), Instant::now()).unwrap());
    assert_eq!(n3.seq, 3, "continues after the clear");
    let _ = fs::remove_dir_all(&d);
}

// ── fixer round 2 ───────────────────────────────────────────────────────────

/// A download that takes as long as the test wants: the reader-thread hook waits until the gate opens.
struct Gate(Mutex<bool>, std::sync::Condvar);

impl Gate {
    fn new() -> Arc<Self> {
        Arc::new(Gate(Mutex::new(false), std::sync::Condvar::new()))
    }
    fn wait(&self) {
        let mut g = lk(&self.0);
        while !*g {
            g = self.1.wait(g).unwrap_or_else(|e| e.into_inner());
        }
    }
    fn open(&self) {
        *lk(&self.0) = true;
        self.1.notify_all();
    }
}

/// The hook: reads of `slow` wait for the gate in `slot` (replaceable), counted in `calls`.
fn slow_reads(c: &FileCtx, slow: &Path, slot: Arc<Mutex<Arc<Gate>>>, calls: Arc<std::sync::atomic::AtomicUsize>) {
    let fp = slow.to_path_buf();
    lk(&c.note_reader.cache).read_hook = Some(Arc::new(move |p: &Path| {
        if p == fp {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let g = lk(&slot).clone();
            g.wait();
        }
    }));
}

fn wait_reads(c: &FileCtx, at_least: u64) {
    let t = Instant::now();
    while lk(&c.note_reader.cache).reads < at_least {
        assert!(t.elapsed() < Duration::from_secs(10), "the read never finished");
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// RV-1: another computer's note in a folder kept online-only (not downloaded yet) is read — on a reader
/// thread, so the poll keeps its 3 s pace while the download takes its time (or hangs offline): the look
/// never waits more than READ_WAIT_POLL for it, the download is asked for once, a local note beside it is
/// read at once, and the note counts as soon as it has arrived. While a newer version of it is on its way,
/// the last content read stands (the note does not disappear for the frontend).
#[test]
fn fix_rv1_online_only_note_is_read_and_the_poll_keeps_its_pace() {
    let d = tmpdir("p3-rv1-poll");
    let c = pctx(&d);
    let ev = collect(&c);
    let a = lag(&d, "A.lag", "a-1");
    let name = "A (in use on Office iMac, 9f3c).laguse";
    let f = place(&d, name, &note("a-1", "A.lag", "d-other", 1, "editing"));
    lk(&c.note_reader.cache).fake_dataless.insert(f.clone());
    let slot = Arc::new(Mutex::new(Gate::new()));
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    slow_reads(&c, &f, slot.clone(), calls.clone());
    // As the app runs it: every look on its own thread with the 15 s limit.
    let cfg = WatchCfg { stable_wait: Duration::ZERO, look_timeout: Some(Duration::from_secs(15)), ..Default::default() };
    track(&c, &a, true, Some("r-1".into()), Some("a-1".into()), 0, &cfg);
    let mut now = 0u64;
    let mut look = |what: &str| {
        let t = Instant::now();
        tick(&c, now, &cfg);
        let took = t.elapsed();
        assert!(took < READ_WAIT_POLL + Duration::from_millis(600), "{what}: the look took {took:?} (the poll is every 3 s)");
        now += 3000;
        presence_events(&ev)
    };
    for k in 0..4 {
        assert!(look(&format!("look {k} while downloading")).is_empty(), "nothing known yet: no event");
    }
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1, "the download is asked for once, not on every look");
    // presence_list (opening the file) is not held up either.
    let t = Instant::now();
    assert!(scan_notes(&c, &a, "a-1").unwrap().notes.is_empty());
    assert!(t.elapsed() < Duration::from_millis(1500), "presence_list took {:?}", t.elapsed());
    // A local note beside it (a third computer) is read at once: the stuck download holds up nothing else.
    let third = place(&d, "A (in use on Lab PC, 77aa).laguse", &note("a-1", "A.lag", "d-third", 1, "idle"));
    let e = look("a local note appears");
    assert_eq!(e.len(), 1);
    assert_eq!(e[0]["notes"].as_array().unwrap().len(), 1);
    assert_eq!(e[0]["notes"][0]["file"], path_str(&third));
    // The download arrives: the next look has the note.
    lk(&slot).open();
    wait_reads(&c, 2);
    let e = look("downloaded");
    assert_eq!(e.len(), 1, "one presence event once the note has arrived");
    let list = e[0]["notes"].as_array().unwrap();
    assert_eq!(list.len(), 2);
    let rec = list.iter().find(|r| r["file"] == path_str(&f)).expect("the online-only note is listed");
    assert_eq!(rec["note"]["state"], "editing");
    assert_eq!(rec["applies"], true);
    assert_eq!(rec["own"], false);
    assert!(look("unchanged").is_empty());
    // A newer version of it is on its way (online-only again, slow): the last content read stands.
    *lk(&slot) = Gate::new();
    std::thread::sleep(Duration::from_millis(20));
    place(&d, name, &note("a-1", "A.lag", "d-other", 2, "editing"));
    let reads = lk(&c.note_reader.cache).reads;
    for k in 0..2 {
        assert!(look(&format!("newer version downloading {k}")).is_empty(), "the note neither disappears nor changes meanwhile");
    }
    let r = scan_notes(&c, &a, "a-1").unwrap();
    assert_eq!(r.notes.iter().find(|x| x.file == path_str(&f)).map(|x| x.note.seq), Some(1), "last content read");
    lk(&slot).open();
    wait_reads(&c, reads + 1);
    let e = look("newer version arrived");
    assert_eq!(e.len(), 1);
    let seq = e[0]["notes"].as_array().unwrap().iter().find(|r| r["file"] == path_str(&f)).unwrap()["note"]["seq"].clone();
    assert_eq!(seq, 2);
    let _ = fs::remove_dir_all(&d);
}

/// RV-1: a download that never ends (offline) costs one short wait, once: presence_set and presence_list
/// answer at once afterwards, and a failed read is tried again later (not on every look).
#[test]
fn fix_rv1_stuck_download_never_holds_up_commands() {
    let d = tmpdir("p3-rv1-stuck");
    let c = pctx(&d);
    let a = lag(&d, "A.lag", "a-1");
    let f = place(&d, "A (in use on Office iMac, 9f3c).laguse", &note("a-1", "A.lag", "d-other", 1, "editing"));
    lk(&c.note_reader.cache).fake_dataless.insert(f.clone());
    let slot = Arc::new(Mutex::new(Gate::new()));
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    slow_reads(&c, &f, slot.clone(), calls.clone());
    let t = Instant::now();
    let (mine, _) = written(set_note(&c, &args(&a, "a-1", "idle", 0.0), Instant::now()).unwrap());
    assert!(t.elapsed() < READ_WAIT_SET + Duration::from_millis(500), "presence_set took {:?}", t.elapsed());
    assert!(mine.exists());
    for _ in 0..3 {
        let t = Instant::now();
        let r = scan_notes(&c, &a, "a-1").unwrap();
        assert!(t.elapsed() < Duration::from_millis(300), "presence_list waited again: {:?}", t.elapsed());
        assert_eq!(r.notes.len(), 1, "my own note only, the other is still downloading");
        let t = Instant::now();
        set_note(&c, &args(&a, "a-1", "editing", 1.0), Instant::now()).unwrap();
        assert!(t.elapsed() < Duration::from_millis(300), "presence_set waited again: {:?}", t.elapsed());
    }
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    lk(&slot).open();
    let _ = fs::remove_dir_all(&d);
}
