//! cargo tests for graphfile.rs (phase1-contract.md §9.4) and the Rust half
//! of the cross-language goldens (§9.3).

use super::*;

pub(crate) mod util {
    use super::super::*;
    use crate::appstate::DeviceEnv;
    use std::sync::atomic::AtomicU64;

    pub fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("las-p1-{tag}-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&d).unwrap();
        fs::canonicalize(&d).unwrap()
    }

    /// A context with its own state folder, a fixed device and short retries.
    pub fn ctx(dir: &Path) -> FileCtx {
        let mut c = FileCtx::new(Some(dir.join("state")));
        c.tuning = Tuning { incomplete_retry: Duration::from_millis(300), retry_step: Duration::from_millis(50) };
        c.device_env.set(DeviceEnv {
            hardware_id: Some("HW-TEST".into()),
            default_device_name: "Test Mac".into(),
            default_user_name: "Tester".into(),
        });
        c
    }

    pub fn collect(c: &FileCtx) -> Arc<Mutex<Vec<(String, Value)>>> {
        let ev = Arc::new(Mutex::new(Vec::new()));
        let e2 = ev.clone();
        c.set_emitter(Arc::new(move |n: &str, v: Value| lk(&e2).push((n.to_string(), v))));
        ev
    }

    pub fn part_of(text: &str) -> (String, Value) {
        let sha = sha256_hex(text.as_bytes());
        let name = format!("parts/{sha}.json");
        (name.clone(), json!({ "part": name, "sha256": sha, "bytes": text.len() }))
    }

    /// Builds manifests and files the way TS does (texts are opaque to Rust).
    #[derive(Clone)]
    pub struct Mk {
        pub aid: String,
        pub revs: Vec<Value>,
        pub parts: BTreeMap<String, String>,
        pub min_reader_version: u64,
    }

    impl Mk {
        pub fn new(aid: &str) -> Self {
            Mk { aid: aid.into(), revs: vec![], parts: BTreeMap::new(), min_reader_version: 1 }
        }
        pub fn rev(&mut self, id: &str, parents: &[&str], texts: [&str; 4]) -> &mut Self {
            let mut sections = serde_json::Map::new();
            for (n, t) in SECTION_NAMES.iter().zip(texts) {
                let (name, r) = part_of(t);
                self.parts.insert(name, t.to_string());
                sections.insert(n.to_string(), r);
            }
            self.revs.push(json!({
                "id": id, "parents": parents, "time": "2026-11-20T10:00:00Z", "user_name": "Alice",
                "device_id": "d-1", "device_name": "Office iMac", "session_id": "s-1", "app_version": "0.2.1",
                "kind": "save", "summary": "", "sections": Value::Object(sections), "content_hash": "x",
            }));
            self
        }
        pub fn manifest(&self, head: &str) -> String {
            serde_json::to_string(&json!({
                "format": "lasgraph", "format_version": 1, "min_reader_version": self.min_reader_version, "features": 1,
                "app": {"name": "Lab Analysis Suite", "version": "0.2.1", "platform": "macos"},
                "analysis_id": self.aid, "forked_from": null,
                "created": {"time": "2026-11-20T10:00:00Z", "user_name": "Alice", "device_id": "d-1", "device_name": "Office iMac"},
                "template": "column", "head": head, "revisions": self.revs, "x": {},
            }))
            .unwrap()
        }
        pub fn bytes(&self, head: &str) -> Vec<u8> {
            build_container(&self.manifest(head), &self.aid, head, &self.parts).unwrap()
        }
        /// Parts of revision `id`.
        pub fn parts_of(&self, id: &str) -> BTreeMap<String, String> {
            let r = self.revs.iter().find(|r| r["id"] == id).unwrap();
            SECTION_NAMES
                .iter()
                .map(|n| {
                    let name = r["sections"][n]["part"].as_str().unwrap().to_string();
                    (name.clone(), self.parts[&name].clone())
                })
                .collect()
        }
        pub fn args(&self, path: &Path, head: &str, expected: Option<&str>, new_parts: BTreeMap<String, String>) -> SaveArgs {
            SaveArgs {
                path: path.to_string_lossy().into_owned(),
                expected_head: expected.map(str::to_string),
                analysis_id: self.aid.clone(),
                doc_key: "k-test".into(),
                manifest_text: self.manifest(head),
                new_parts,
                replace_existing: false,
            }
        }
    }

    pub fn texts(tag: &str) -> [String; 4] {
        [
            format!("{{\"table\":\"{tag}\"}}"),
            format!("{{\"analysis\":\"{tag}\"}}"),
            format!("{{\"figure\":\"{tag}\"}}"),
            format!("{{\"scratch\":\"{tag}\"}}"),
        ]
    }

    pub fn t4(t: &[String; 4]) -> [&str; 4] {
        [&t[0], &t[1], &t[2], &t[3]]
    }

    static MT: AtomicU64 = AtomicU64::new(0);

    /// Write a file as another computer would, with a distinct mtime.
    pub fn put(p: &Path, bytes: &[u8]) {
        let tmp = p.with_file_name(format!(".put-{}", uuid::Uuid::new_v4().simple()));
        fs::write(&tmp, bytes).unwrap();
        fs::rename(&tmp, p).unwrap();
        bump_mtime(p);
    }

    pub fn bump_mtime(p: &Path) {
        let n = MT.fetch_add(1, Ordering::SeqCst) + 1;
        let t = SystemTime::now() + Duration::from_secs(n * 2);
        fs::OpenOptions::new().write(true).open(p).unwrap().set_modified(t).unwrap();
    }

    pub fn entries_of(bytes: &[u8]) -> Vec<(String, zip::CompressionMethod)> {
        let mut ar = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        (0..ar.len()).map(|i| {
            let f = ar.by_index_raw(i).unwrap();
            (f.name().to_string(), f.compression())
        }).collect()
    }

    pub fn temps_in(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".tmp"))
            .collect()
    }
}

use util::*;

fn one_rev(aid: &str, head: &str, tag: &str) -> Mk {
    let mut m = Mk::new(aid);
    let t = texts(tag);
    m.rev(head, &[], t4(&t));
    m
}

// ── container ────────────────────────────────────────────────────────────────

#[test]
fn container_round_trip_and_layout() {
    let m = one_rev("a-1", "r-1", "x \u{1F600} µ \"q\" 1e-7");
    let b = m.bytes("r-1");
    assert_eq!(b, m.bytes("r-1"), "same input → same bytes");
    let v = validate_bytes(&b).unwrap();
    assert_eq!(v.header, FileHeader { analysis_id: "a-1".into(), head: "r-1".into() });
    assert_eq!(v.manifest_text, m.manifest("r-1"));
    assert_eq!(v.parts, m.parts);
    assert!(!v.too_new());
    let ents = entries_of(&b);
    assert_eq!(ents[0], ("mimetype".to_string(), zip::CompressionMethod::Stored));
    assert_eq!(ents[1], ("manifest.json".to_string(), zip::CompressionMethod::Deflated));
    let names: Vec<_> = ents[2..].iter().map(|e| e.0.clone()).collect();
    let mut sorted = names.clone();
    sorted.sort();
    assert_eq!(names, sorted, "parts sorted by name");
    assert_eq!(eocd_comment(&b), Some("LASGRAPH1 a-1 r-1".as_bytes()));
    // the mimetype entry: stored, no extra field, MIME right after the 30-byte header + name
    assert_eq!(&b[0..4], &[0x50, 0x4b, 0x03, 0x04]);
    let name_len = u16::from_le_bytes([b[26], b[27]]) as usize;
    let extra_len = u16::from_le_bytes([b[28], b[29]]);
    assert_eq!(extra_len, 0);
    assert_eq!(&b[30..30 + name_len], b"mimetype");
    assert_eq!(&b[30 + name_len..30 + name_len + MIME.len()], MIME.as_bytes());
    // DOS time 1980-01-01 00:00:00
    assert_eq!(u16::from_le_bytes([b[10], b[11]]), 0);
    assert_eq!(u16::from_le_bytes([b[12], b[13]]), 0b0000000000100001);
    // general purpose flag: no data descriptor
    assert_eq!(u16::from_le_bytes([b[6], b[7]]) & 0x8, 0);
}

#[test]
fn too_new_reads_with_flag() {
    let mut m = one_rev("a-1", "r-1", "x");
    m.min_reader_version = 2;
    let v = validate_bytes(&m.bytes("r-1")).unwrap();
    assert!(v.too_new());
}

#[test]
fn truncated_files_are_incomplete() {
    let b = one_rev("a-1", "r-1", "truncate me please, a longer text so the file is bigger").bytes("r-1");
    for n in [0usize, 1, 10, 22, b.len() / 3, b.len() / 2, b.len() - 30, b.len() - 1] {
        let e = validate_bytes(&b[..n]).unwrap_err();
        assert_eq!(e.kind, ErrKind::Incomplete, "truncated to {n}: {e:?}");
    }
}

#[test]
fn corrupt_files_map_to_kinds() {
    let m = one_rev("a-1", "r-1", "corrupt");
    let b = m.bytes("r-1");
    // a flipped byte inside a part's stored data
    let (start, size) = {
        let mut ar = zip::ZipArchive::new(Cursor::new(&b[..])).unwrap();
        let i = (0..ar.len()).find(|i| ar.name_for_index(*i).unwrap().starts_with("parts/")).unwrap();
        let f = ar.by_index_raw(i).unwrap();
        (f.data_start() as usize, f.compressed_size() as usize)
    };
    let mut c = b.clone();
    c[start + size / 2] ^= 0x55;
    assert_eq!(validate_bytes(&c).unwrap_err().kind, ErrKind::Incomplete);
    // the comment says another head than the manifest
    let lie = build_container(&m.manifest("r-1"), "a-1", "r-2", &m.parts).unwrap();
    let e = validate_bytes(&lie).unwrap_err();
    assert_eq!((e.kind, e.data.clone()), (ErrKind::Incomplete, Some(json!({"reason": "comment"}))));
    // a part whose content does not match its name
    let mut parts = m.parts.clone();
    let k = parts.keys().next().unwrap().clone();
    parts.insert(k, "{\"other\":1}".into());
    let e = validate_bytes(&build_container(&m.manifest("r-1"), "a-1", "r-1", &parts).unwrap()).unwrap_err();
    assert_eq!(e.data, Some(json!({"reason": "part"})));
    // a head part missing
    let mut parts = m.parts.clone();
    parts.pop_first();
    let e = validate_bytes(&build_container(&m.manifest("r-1"), "a-1", "r-1", &parts).unwrap()).unwrap_err();
    assert_eq!(e.data, Some(json!({"reason": "part"})));
    // head not among the revisions
    let e = validate_bytes(&build_container(&m.manifest("r-9"), "a-1", "r-9", &m.parts).unwrap()).unwrap_err();
    assert_eq!(e.data, Some(json!({"reason": "manifest"})));
    // another format → Invalid
    let other = m.manifest("r-1").replace("\"lasgraph\"", "\"other\"");
    assert_eq!(validate_bytes(&build_container(&other, "a-1", "r-1", &m.parts).unwrap()).unwrap_err().kind, ErrKind::Invalid);
    // some other ZIP → Invalid
    use zip::write::SimpleFileOptions;
    let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
    w.start_file("readme.txt", SimpleFileOptions::default()).unwrap();
    w.write_all(b"hello").unwrap();
    let other_zip = w.finish().unwrap().into_inner();
    assert_eq!(validate_bytes(&other_zip).unwrap_err().kind, ErrKind::Invalid);
    let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
    w.start_file("mimetype", SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored)).unwrap();
    w.write_all(b"application/zip").unwrap();
    assert_eq!(validate_bytes(&w.finish().unwrap().into_inner()).unwrap_err().kind, ErrKind::Invalid);
    // not a ZIP at all
    assert_eq!(validate_bytes(b"just some text that is long enough").unwrap_err().kind, ErrKind::Incomplete);
}

#[test]
fn read_limits_and_empty_file() {
    let d = tmpdir("limits");
    let big = d.join("big.lag");
    let f = fs::File::create(&big).unwrap();
    f.set_len(READ_LIMIT + 1).unwrap();
    drop(f);
    let e = read_file_bytes(&big).unwrap_err();
    assert_eq!(e.kind, ErrKind::Invalid, "{e:?}");
    let empty = d.join("empty.lag");
    fs::write(&empty, b"").unwrap();
    assert_eq!(read_file_bytes(&empty).unwrap_err().kind, ErrKind::Incomplete);
    assert_eq!(read_file_bytes(&d.join("nope.lag")).unwrap_err().kind, ErrKind::NotFound);
    assert_eq!(read_header(&d.join("nope.lag")).unwrap_err().kind, ErrKind::NotFound);
    assert_eq!(read_header(&empty).unwrap_err().kind, ErrKind::Incomplete);
    // a ZIP over the inflate limit is refused without inflating it all
    let mut budget = 10u64;
    let b = one_rev("a-1", "r-1", &"z".repeat(100)).bytes("r-1");
    let mut ar = zip::ZipArchive::new(Cursor::new(&b[..])).unwrap();
    let i = (0..ar.len()).find(|i| ar.name_for_index(*i).unwrap().starts_with("parts/")).unwrap();
    assert!(matches!(read_entry(&mut ar, i, &mut budget), Err(EntryErr::TooBig)));
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn header_read_uses_the_tail() {
    let d = tmpdir("header");
    let m = one_rev("a-h", "r-h", &"y".repeat(200_000));
    let p = d.join("H.lag");
    fs::write(&p, m.bytes("r-h")).unwrap();
    let (h, st) = read_header(&p).unwrap();
    assert_eq!(h, FileHeader { analysis_id: "a-h".into(), head: "r-h".into() });
    assert_eq!(st.path, p.to_string_lossy());
    assert!(!st.dataless && st.mtime > 0);
    fs::write(&p, b"PK no comment here, definitely not a zip file at all").unwrap();
    assert_eq!(read_header(&p).unwrap_err().kind, ErrKind::Incomplete);
    assert_eq!(parse_comment(b"LASGRAPH1 a-1 r-1"), Some(FileHeader { analysis_id: "a-1".into(), head: "r-1".into() }));
    assert_eq!(parse_comment(b"LASGRAPH1 a-1"), None);
    assert_eq!(parse_comment(b"LASGRAPH2 a-1 r-1"), None);
    assert_eq!(parse_comment(b"LASGRAPH1 a-1 r-1 x"), None);
    let _ = fs::remove_dir_all(&d);
}

// ── save ─────────────────────────────────────────────────────────────────────

#[test]
fn save_new_next_stale_and_kept_parts() {
    let d = tmpdir("save");
    let c = ctx(&d);
    let p = d.join("Dose response.lag");
    let mut m = one_rev("a-s", "r-1", "one");
    let r = save(&c, &m.args(&p, "r-1", None, m.parts.clone())).unwrap();
    let SaveReply::Saved { path, head, stat } = r else { panic!("{r:?}") };
    assert_eq!((path.as_str(), head.as_str()), (p.to_str().unwrap(), "r-1"));
    assert_eq!(stat.size, fs::metadata(&p).unwrap().len());
    assert!(temps_in(&d).is_empty());
    let first = read_validated(&p).unwrap().0;
    // second save: only the changed table part is sent
    let t2 = texts("two");
    let one = texts("one");
    m.rev("r-2", &["r-1"], [&t2[0], &one[1], &one[2], &one[3]]);
    let (tname, _) = part_of(&t2[0]);
    let r = save(&c, &m.args(&p, "r-2", Some("r-1"), BTreeMap::from([(tname, t2[0].clone())]))).unwrap();
    assert!(matches!(r, SaveReply::Saved { ref head, .. } if head == "r-2"), "{r:?}");
    let second = read_validated(&p).unwrap().0;
    assert_eq!(second.parts.len(), 5);
    for (k, v) in &first.parts {
        assert_eq!(second.parts.get(k), Some(v), "kept part {k} byte for byte");
    }
    // a stale base → conflict, nothing written
    let before = fs::read(&p).unwrap();
    let mut stale = m.clone();
    stale.revs.truncate(1);
    let t3 = texts("three");
    stale.rev("r-3", &["r-1"], t4(&t3));
    let r = save(&c, &stale.args(&p, "r-3", Some("r-1"), stale.parts_of("r-3"))).unwrap();
    assert_eq!(r, SaveReply::Conflict { head: "r-2".into() });
    assert_eq!(fs::read(&p).unwrap(), before);
    // expectedHead null on an existing analysis → conflict; another analysis → identity
    assert_eq!(save(&c, &m.args(&p, "r-2", None, m.parts.clone())).unwrap(), SaveReply::Conflict { head: "r-2".into() });
    let o = one_rev("a-other", "r-o", "o");
    assert_eq!(save(&c, &o.args(&p, "r-o", None, o.parts.clone())).unwrap_err().kind, ErrKind::IdentityMismatch);
    assert_eq!(save(&c, &o.args(&p, "r-o", Some("r-2"), o.parts.clone())).unwrap_err().kind, ErrKind::IdentityMismatch);
    // a non-analysis file in the way
    let junk = d.join("junk.lag");
    fs::write(&junk, b"hello").unwrap();
    assert_eq!(save(&c, &o.args(&junk, "r-o", None, o.parts.clone())).unwrap_err().kind, ErrKind::Invalid);
    assert!(temps_in(&d).is_empty());
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn save_argument_checks() {
    let d = tmpdir("args");
    let c = ctx(&d);
    let p = d.join("A.lag");
    let m = one_rev("a-x", "r-1", "x");
    // missing part
    let mut few = m.parts.clone();
    few.pop_first();
    let e = save(&c, &m.args(&p, "r-1", None, few)).unwrap_err();
    assert_eq!(e.kind, ErrKind::Invalid);
    assert!(e.message.contains("part missing"), "{}", e.message);
    assert!(!p.exists() && temps_in(&d).is_empty());
    // a new part whose text does not match its name
    let mut bad = m.parts.clone();
    let k = bad.keys().next().unwrap().clone();
    bad.insert(k, "{}".into());
    assert_eq!(save(&c, &m.args(&p, "r-1", None, bad)).unwrap_err().kind, ErrKind::Invalid);
    // wrong extension, relative path, other analysis id, missing folder
    assert_eq!(save(&c, &m.args(&d.join("A.zip"), "r-1", None, m.parts.clone())).unwrap_err().kind, ErrKind::Invalid);
    assert_eq!(save(&c, &m.args(Path::new("rel/A.lag"), "r-1", None, m.parts.clone())).unwrap_err().kind, ErrKind::Invalid);
    let mut a = m.args(&p, "r-1", None, m.parts.clone());
    a.analysis_id = "a-y".into();
    assert_eq!(save(&c, &a).unwrap_err().kind, ErrKind::Invalid);
    assert_eq!(save(&c, &m.args(&d.join("no/such/A.lag"), "r-1", None, m.parts.clone())).unwrap_err().kind, ErrKind::NotFound);
    // the session has this path open as another document
    fs::create_dir_all(d.join("state")).unwrap();
    fs::write(d.join("state/graph-session.json"), serde_json::to_vec(&json!({"v":1,"tabs":[{"doc_key":"k-other","path":p.to_string_lossy()}]})).unwrap()).unwrap();
    let e = save(&c, &m.args(&p, "r-1", None, m.parts.clone())).unwrap_err();
    assert_eq!((e.kind, e.data), (ErrKind::IdentityMismatch, Some(json!({"found": null}))));
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn temp_names() {
    let t = temp_name_for(Path::new("/x/Dose response.lag"));
    let n = t.file_name().unwrap().to_string_lossy().into_owned();
    assert!(n.starts_with(".~Dose response.lag.tmp-"), "{n}");
    let hex = n.rsplit("tmp-").next().unwrap();
    assert!(hex.len() == 8 && hex.bytes().all(|b| b.is_ascii_hexdigit()));
    assert!(!n.ends_with(".tmp") && !n.starts_with("~"));
    assert_eq!(t.parent(), Some(Path::new("/x")));
}

#[test]
fn interrupted_write_leaves_the_old_file() {
    let d = tmpdir("interrupt");
    let c = ctx(&d);
    let p = d.join("A.lag");
    let mut m = one_rev("a-i", "r-1", "old");
    save(&c, &m.args(&p, "r-1", None, m.parts.clone())).unwrap();
    let before = fs::read(&p).unwrap();
    let t = texts("new");
    m.rev("r-2", &["r-1"], t4(&t));
    lk(&c.hooks).before_rename = Some(Box::new(|_| Err(FileErr::io("power cut"))));
    let e = save(&c, &m.args(&p, "r-2", Some("r-1"), m.parts_of("r-2"))).unwrap_err();
    assert_eq!(e.message, "power cut");
    assert_eq!(fs::read(&p).unwrap(), before, "old file intact");
    assert!(temps_in(&d).is_empty(), "temp removed");
    // and a new file is never half-created
    let q = d.join("B.lag");
    let n = one_rev("a-j", "r-1", "b");
    assert!(save(&c, &n.args(&q, "r-1", None, n.parts.clone())).is_err());
    assert!(!q.exists() && temps_in(&d).is_empty());
    lk(&c.hooks).before_rename = None;
    // the journal of the old head is intact and the next save works
    assert!(matches!(save(&c, &m.args(&p, "r-2", Some("r-1"), m.parts_of("r-2"))).unwrap(), SaveReply::Saved { .. }));
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn saved_but_displaced_when_a_remote_save_lands_in_the_gap() {
    let d = tmpdir("displaced");
    let c = ctx(&d);
    let p = d.join("A.lag");
    let mut m = one_rev("a-d", "r-00000001", "base");
    save(&c, &m.args(&p, "r-00000001", None, m.parts.clone())).unwrap();
    // their version: same content under another head id of the same length → same size
    let mut swapped = None;
    for ch in (b'A'..=b'Z').chain(b'a'..=b'z') {
        let id = format!("r-0000000{}", ch as char);
        let t = one_rev("a-d", &id, "base");
        let b = t.bytes(&id);
        if b.len() as u64 == fs::metadata(&p).unwrap().len() {
            swapped = Some((id, b));
            break;
        }
    }
    let (their_head, their_bytes) = swapped.expect("an equal-size version");
    let mtime = fs::metadata(&p).unwrap().modified().unwrap();
    let ours = texts("mine");
    m.rev("r-00000002", &["r-00000001"], t4(&ours));
    let pp = p.clone();
    lk(&c.hooks).before_displace = Some(Box::new(move |_| {
        let tmp = pp.with_file_name(".swap");
        fs::write(&tmp, &their_bytes).unwrap();
        fs::rename(&tmp, &pp).unwrap();
        fs::OpenOptions::new().write(true).open(&pp).unwrap().set_modified(mtime).unwrap();
        Ok(())
    }));
    let r = save(&c, &m.args(&p, "r-00000002", Some("r-00000001"), m.parts_of("r-00000002"))).unwrap();
    match r {
        SaveReply::SavedButDisplaced { head, displaced_head, .. } => {
            assert_eq!(head, "r-00000002");
            assert_eq!(displaced_head, their_head);
        }
        other => panic!("{other:?}"),
    }
    // their head is journaled; no displaced link is left behind
    assert!(c.read_journal("a-d", &their_head).unwrap().is_some());
    assert!(c.list_displaced().unwrap().is_empty());
    let leftovers = fs::read_dir(d.join("state/displaced"))
        .map(|r| r.flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".lag")).count())
        .unwrap_or(0);
    assert_eq!(leftovers, 0);
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn saved_aside_when_the_head_cannot_be_established() {
    let d = tmpdir("aside");
    let c = ctx(&d);
    let p = d.join("Dose response.lag");
    let mut m = one_rev("a-a", "r-1", "base");
    save(&c, &m.args(&p, "r-1", None, m.parts.clone())).unwrap();
    // the file is replaced by something still arriving (stays broken for > retry time)
    put(&p, b"PK\x03\x04 still downloading");
    let t = texts("mine");
    m.rev("r-2", &["r-1"], t4(&t));
    let r = save(&c, &m.args(&p, "r-2", Some("r-1"), m.parts_of("r-2"))).unwrap();
    let SaveReply::SavedAside { path, head, .. } = r else { panic!("{r:?}") };
    assert_eq!(head, "r-2");
    assert_eq!(path, d.join("Dose response (unsynced from Test Mac).lag").to_string_lossy());
    assert_eq!(fs::read(&p).unwrap(), b"PK\x03\x04 still downloading", "never overwritten");
    // a second one gets " 2"
    let r = save(&c, &m.args(&p, "r-2", Some("r-1"), m.parts_of("r-2"))).unwrap();
    let SaveReply::SavedAside { path, .. } = r else { panic!("{r:?}") };
    assert!(path.ends_with("Dose response (unsynced from Test Mac) 2.lag"), "{path}");
    assert_eq!(aside_name(Path::new("/x/A.lag"), "Zhuo's Mac/Pro ✓", 1), PathBuf::from("/x/A (unsynced from Zhuos MacPro).lag"));
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn save_follows_a_rename_and_reports_missing() {
    let d = tmpdir("follow-save");
    let c = ctx(&d);
    let ev = collect(&c);
    let p = d.join("A.lag");
    let mut m = one_rev("a-f", "r-1", "x");
    save(&c, &m.args(&p, "r-1", None, m.parts.clone())).unwrap();
    let q = d.join("B.lag");
    fs::rename(&p, &q).unwrap();
    let t = texts("y");
    m.rev("r-2", &["r-1"], t4(&t));
    let r = save(&c, &m.args(&p, "r-2", Some("r-1"), m.parts_of("r-2"))).unwrap();
    assert!(matches!(&r, SaveReply::Saved { path, head, .. } if path == q.to_str().unwrap() && head == "r-2"), "{r:?}");
    assert!(!p.exists(), "the old name is not recreated");
    let evs = lk(&ev).clone();
    assert_eq!(evs.len(), 1);
    assert_eq!(evs[0].1, json!({"type":"moved","from":p.to_string_lossy(),"to":q.to_string_lossy(),"head":"r-1"}));
    // gone with no successor → missing, nothing written
    fs::remove_file(&q).unwrap();
    m.rev("r-3", &["r-2"], t4(&texts("z")));
    assert_eq!(save(&c, &m.args(&q, "r-3", Some("r-2"), m.parts_of("r-3"))).unwrap(), SaveReply::Missing);
    assert!(fs::read_dir(&d).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().ends_with(".lag")));
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn save_as_replace_keeps_a_displaced_copy() {
    let d = tmpdir("replace");
    let c = ctx(&d);
    let p = d.join("A.lag");
    let o = one_rev("a-old", "r-o", "old analysis");
    save(&c, &o.args(&p, "r-o", None, o.parts.clone())).unwrap();
    let n = one_rev("a-new", "r-n", "new analysis");
    let mut a = n.args(&p, "r-n", None, n.parts.clone());
    a.replace_existing = true;
    assert!(matches!(save(&c, &a).unwrap(), SaveReply::Saved { .. }));
    assert_eq!(read_header(&p).unwrap().0.analysis_id, "a-new");
    let list = c.list_displaced().unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!((list[0].analysis_id.as_str(), list[0].head.as_str(), list[0].reason.as_str()), ("a-old", "r-o", "replaced"));
    assert_eq!(c.read_displaced(&list[0].id).unwrap().unwrap().header.head, "r-o");
    // prune by age
    c.prune(10, u64::MAX, 0).unwrap();
    assert!(c.list_displaced().unwrap().is_empty());
    let _ = fs::remove_dir_all(&d);
}

// ── journal ──────────────────────────────────────────────────────────────────

#[test]
fn journal_confirm_rule() {
    let d = tmpdir("journal");
    let c = ctx(&d);
    let p = d.join("A.lag");
    let ps = p.to_string_lossy().into_owned();
    let mut m = one_rev("a-j", "r-1", "1");
    save(&c, &m.args(&p, "r-1", None, m.parts.clone())).unwrap();
    let heads = c.journal_heads("a-j", Some(&ps)).unwrap();
    assert_eq!(heads.len(), 1);
    assert!(!heads[0].confirmed);
    // the working copy W (not on disk) is journaled unconfirmed and confirms nothing
    m.rev("r-w", &["r-1"], t4(&texts("w")));
    c.write_journal(&ps, &RawFile { manifest_text: m.manifest("r-w"), parts: m.parts.clone() }).unwrap();
    assert!(c.journal_heads("a-j", Some(&ps)).unwrap().iter().all(|h| !h.confirmed));
    // r-2 on disk (child of r-1): r-1 confirmed, r-w (not an ancestor) stays unconfirmed
    m.rev("r-2", &["r-1"], t4(&texts("2")));
    save(&c, &m.args(&p, "r-2", Some("r-1"), m.parts_of("r-2"))).unwrap();
    let heads = c.journal_heads("a-j", Some(&ps)).unwrap();
    let st: BTreeMap<_, _> = heads.iter().map(|h| (h.revision_id.clone(), h.confirmed)).collect();
    assert_eq!(st, BTreeMap::from([("r-1".to_string(), true), ("r-w".to_string(), false), ("r-2".to_string(), false)]));
    assert_eq!(heads.first().unwrap().revision_id, "r-1", "oldest first");
    // a read journals what it sees; another path keeps its own entries
    let q = d.join("copy.lag");
    fs::copy(&p, &q).unwrap();
    read(&c, &q).unwrap();
    assert_eq!(c.journal_heads("a-j", Some(&q.to_string_lossy())).unwrap().len(), 1);
    assert_eq!(c.journal_heads("a-j", None).unwrap().len(), 4);
    assert_eq!(c.read_journal("a-j", "r-w").unwrap().unwrap().header.head, "r-w");
    assert!(c.read_journal("a-j", "r-zz").unwrap().is_none());
    assert_eq!(c.read_journal("a-j", "../x").unwrap_err().kind, ErrKind::Invalid);
    // write_journal requires the head's parts
    let mut few = m.parts.clone();
    few.retain(|k, _| !m.parts_of("r-2").contains_key(k));
    assert_eq!(c.write_journal(&ps, &RawFile { manifest_text: m.manifest("r-2"), parts: few }).unwrap_err().kind, ErrKind::Invalid);
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn journal_pruning_keeps_unconfirmed_and_newest() {
    let d = tmpdir("prune");
    let c = ctx(&d);
    let p = d.join("A.lag");
    let mut m = one_rev("a-p", "r-00", "0");
    save(&c, &m.args(&p, "r-00", None, m.parts.clone())).unwrap();
    // an unconfirmed working copy, older than everything below
    let ps = p.to_string_lossy().into_owned();
    let mut w = m.clone();
    w.rev("r-w", &["r-00"], t4(&texts("w")));
    c.write_journal(&ps, &RawFile { manifest_text: w.manifest("r-w"), parts: w.parts.clone() }).unwrap();
    std::thread::sleep(Duration::from_millis(3));
    for i in 1..15 {
        let id = format!("r-{i:02}");
        let parent = format!("r-{:02}", i - 1);
        m.rev(&id, &[&parent], t4(&texts(&id)));
        save(&c, &m.args(&p, &id, Some(&parent), m.parts_of(&id))).unwrap();
        std::thread::sleep(Duration::from_millis(3));
    }
    c.prune(10, 0, i64::MAX).unwrap();
    let left: BTreeSet<String> = c.journal_heads("a-p", None).unwrap().into_iter().map(|h| h.revision_id).collect();
    assert!(left.contains("r-w") && left.contains("r-14"), "{left:?}");
    assert_eq!(left.len(), 11, "newest 10 + the unconfirmed one: {left:?}");
    assert!(!left.contains("r-00"));
    assert!(c.read_journal("a-p", "r-00").unwrap().is_none());
    assert!(c.read_journal("a-p", "r-05").unwrap().is_some());
    let _ = fs::remove_dir_all(&d);
}

// ── scan and locate ──────────────────────────────────────────────────────────

#[test]
fn scan_dir_lists_graph_and_presence_files() {
    let d = tmpdir("scan");
    let m = one_rev("a-1", "r-1", "x");
    fs::write(d.join("b.lag"), m.bytes("r-1")).unwrap();
    fs::write(d.join("a.LAG"), b"partial").unwrap();
    fs::write(d.join("x (in use on Mac, 1a2b).laguse"), b"note").unwrap();
    fs::write(d.join(".hidden.lag"), m.bytes("r-1")).unwrap();
    fs::write(d.join("notes.txt"), b"x").unwrap();
    fs::create_dir(d.join("folder.lag")).unwrap();
    let e = scan_dir(&d).unwrap();
    let names: Vec<_> = e.iter().map(|x| (x.name.as_str(), x.kind)).collect();
    assert_eq!(names, vec![("a.LAG", "graph"), ("b.lag", "graph"), ("x (in use on Mac, 1a2b).laguse", "presence")]);
    assert!(e[0].header.is_none());
    assert_eq!(e[1].header, Some(FileHeader { analysis_id: "a-1".into(), head: "r-1".into() }));
    assert_eq!(scan_dir(&d.join("nope")).unwrap_err().kind, ErrKind::NotFound);
    let _ = fs::remove_dir_all(&d);
}

fn run_locate(dir: &Path, aid: &str, limits: LocateLimits, step_ms: u64, cancel: bool) -> FResult<LocateReply> {
    let flag = AtomicBool::new(cancel);
    let clock = std::cell::Cell::new(0u64);
    let now = || {
        clock.set(clock.get() + step_ms);
        clock.get()
    };
    let mut progress = |_: u64, _: usize| {};
    locate(dir, aid, &flag, limits, &now, &mut progress)
}

#[test]
fn locate_bounds_and_skips() {
    let d = tmpdir("locate");
    let m = one_rev("a-loc", "r-1", "x");
    let b = m.bytes("r-1");
    let mut deep = d.clone();
    for i in 0..10 {
        deep = deep.join(format!("l{i}"));
        fs::create_dir_all(&deep).unwrap();
        if i == 2 || i == 9 {
            fs::write(deep.join(format!("at{i}.lag")), &b).unwrap();
        }
    }
    for skip in [".hidden", "node_modules", "Thing.app", "Lib.photoslibrary"] {
        fs::create_dir_all(d.join(skip)).unwrap();
        fs::write(d.join(skip).join("x.lag"), &b).unwrap();
    }
    fs::write(d.join(".dot.lag"), &b).unwrap();
    fs::write(d.join("other.lag"), one_rev("a-zzz", "r-1", "o").bytes("r-1")).unwrap();
    fs::write(d.join("broken.lag"), b"PK nope").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(d.join("l0"), d.join("link")).unwrap();
    let r = run_locate(&d, "a-loc", LocateLimits::default(), 0, false).unwrap();
    let found: Vec<_> = r.matches.iter().map(|x| Path::new(&x.path).file_name().unwrap().to_string_lossy().into_owned()).collect();
    assert_eq!(found, vec!["at2.lag".to_string()], "depth 9 is beyond the bound; hidden / node_modules / bundles / symlinks skipped");
    assert_eq!(r.truncated, Some("depth"));
    assert_eq!(r.matches[0].user_name, "Alice");
    assert_eq!(r.matches[0].device_name, "Office iMac");
    assert_eq!(r.matches[0].head, "r-1");
    assert_eq!(r.online_only_count, 0);
    // a deeper bound finds both, newest mtime first
    bump_mtime(&d.join("l0/l1/l2/l3/l4/l5/l6/l7/l8/l9/at9.lag"));
    let r = run_locate(&d, "a-loc", LocateLimits { depth: 20, ..Default::default() }, 0, false).unwrap();
    assert_eq!(r.matches.len(), 2);
    assert!(r.matches[0].path.ends_with("at9.lag"));
    assert_eq!(r.truncated, None);
    // entries bound
    let r = run_locate(&d, "a-loc", LocateLimits { entries: 5, ..Default::default() }, 0, false).unwrap();
    assert_eq!((r.truncated, r.scanned), (Some("entries"), 5));
    // time bound with an injected clock
    let r = run_locate(&d, "a-loc", LocateLimits { time_ms: 1000, ..Default::default() }, 400, false).unwrap();
    assert_eq!(r.truncated, Some("time"));
    // cancel
    assert_eq!(run_locate(&d, "a-loc", LocateLimits::default(), 0, true).unwrap_err().kind, ErrKind::Cancelled);
    // unreadable root / missing root
    assert_eq!(run_locate(&d.join("nope"), "a-loc", LocateLimits::default(), 0, false).unwrap_err().kind, ErrKind::NotFound);
    let _ = fs::remove_dir_all(&d);
}

#[cfg(unix)]
#[test]
fn locate_reports_unreadable_folders() {
    use std::os::unix::fs::PermissionsExt;
    let d = tmpdir("locate-perm");
    let locked = d.join("locked");
    fs::create_dir_all(&locked).unwrap();
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
    let readable = fs::read_dir(&locked).is_ok(); // root ignores modes
    let r = run_locate(&d, "a-x", LocateLimits::default(), 0, false).unwrap();
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
    if !readable {
        assert_eq!(r.skipped_folders, vec![locked.to_string_lossy().into_owned()]);
    }
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn errors_serialise_as_the_contract_says() {
    let e = FileErr::incomplete("zip");
    assert_eq!(serde_json::to_value(&e).unwrap(), json!({"kind":"Incomplete","message":"the file is incomplete (zip)","data":{"reason":"zip"}}));
    let e = FileErr::too_new(3);
    assert_eq!(serde_json::to_value(&e).unwrap()["data"], json!({"min_reader_version": 3}));
    let st = FileStat { path: "/a".into(), size: 1, mtime: 2, dataless: false };
    let r = SaveReply::SavedButDisplaced { path: "/a".into(), head: "r-1".into(), stat: st.clone(), displaced_head: "r-0".into() };
    assert_eq!(serde_json::to_value(&r).unwrap(), json!({"kind":"savedButDisplaced","path":"/a","head":"r-1","stat":{"path":"/a","size":1,"mtime":2,"dataless":false},"displacedHead":"r-0"}));
    assert_eq!(serde_json::to_value(SaveReply::Missing).unwrap(), json!({"kind":"missing"}));
    assert_eq!(serde_json::to_value(SaveReply::SavedAside { path: "/b".into(), head: "h".into(), stat: st }).unwrap()["kind"], "savedAside");
    let rr = ReadReply { manifest_text: "{}".into(), parts: BTreeMap::new(), stat: FileStat { path: "/a".into(), size: 1, mtime: 2, dataless: false }, read_only: None };
    let v = serde_json::to_value(&rr).unwrap();
    assert!(v.get("manifestText").is_some() && v.get("readOnly").is_some());
    let a: SaveArgs = serde_json::from_value(json!({"path":"/a.lag","expectedHead":null,"analysisId":"a-1","docKey":"k","manifestText":"{}","newParts":{}})).unwrap();
    assert!(!a.replace_existing);
    let io = io::Error::from_raw_os_error(13);
    assert_eq!(FileErr::from_io(&io, Path::new("/x")).kind, ErrKind::PermissionDenied);
    let io = io::Error::from_raw_os_error(2);
    assert_eq!(FileErr::from_io(&io, Path::new("/x")).kind, ErrKind::NotFound);
}

#[test]
fn orphan_temps_are_cleaned_on_read() {
    let d = tmpdir("orphans");
    let c = ctx(&d);
    let p = d.join("A.lag");
    let m = one_rev("a-o", "r-1", "x");
    fs::write(&p, m.bytes("r-1")).unwrap();
    let old = d.join(".~A.lag.tmp-deadbeef");
    let fresh = d.join(".~A.lag.tmp-cafebabe");
    fs::write(&old, b"x").unwrap();
    fs::write(&fresh, b"x").unwrap();
    fs::OpenOptions::new().write(true).open(&old).unwrap().set_modified(SystemTime::now() - Duration::from_secs(3600)).unwrap();
    let r = read(&c, &p).unwrap();
    assert_eq!(r.read_only, None);
    assert!(!old.exists() && fresh.exists());
    let _ = fs::remove_dir_all(&d);
}

// ── goldens (contract §9.3) ──────────────────────────────────────────────────

fn replace_dir(v: &mut Value, dir: &str) {
    match v {
        Value::String(s) => {
            if s.contains(dir) {
                *s = s.replace(dir, "$DIR");
            }
        }
        Value::Array(a) => a.iter_mut().for_each(|x| replace_dir(x, dir)),
        Value::Object(o) => o.values_mut().for_each(|x| replace_dir(x, dir)),
        _ => {}
    }
}

#[test]
fn goldens() {
    let Some(root) = std::env::var_os("LAS_P1_GOLDENS").map(PathBuf::from) else {
        println!("goldens skipped (LAS_P1_GOLDENS not set)");
        return;
    };
    let ts = root.join("ts");
    if !ts.join("expect.json").exists() {
        println!("goldens skipped ({} has no ts/expect.json)", root.display());
        return;
    }
    let out = root.join("rust");
    fs::create_dir_all(&out).unwrap();
    let expect: Value = serde_json::from_slice(&fs::read(ts.join("expect.json")).unwrap()).unwrap();
    let d = tmpdir("goldens");
    let work = d.join("work");
    fs::create_dir_all(&work).unwrap();
    let dir_s = work.to_string_lossy().into_owned();
    let c = ctx(&d);
    let mut checked = 0;
    for name in expect["order"].as_array().unwrap() {
        let name = name.as_str().unwrap();
        let case = &expect["cases"][name];
        let fixture: Value = serde_json::from_slice(&fs::read(ts.join(format!("{name}.json"))).unwrap()).unwrap();
        let mut req: SaveArgs = serde_json::from_value(fixture["req"].clone()).unwrap();
        req.path = req.path.replace("$DIR", &dir_s);
        let res = save(&c, &req);
        let mut reply_json = match &res {
            Ok(r) => serde_json::to_value(r).unwrap(),
            Err(e) => json!({ "error": e }),
        };
        replace_dir(&mut reply_json, &dir_s);
        fs::write(out.join(format!("{name}.reply.json")), serde_json::to_vec_pretty(&reply_json).unwrap()).unwrap();
        match (&res, case["error"].as_str()) {
            (Err(e), Some(kind)) => assert_eq!(serde_json::to_value(e.kind).unwrap(), json!(kind), "{name}: {e:?}"),
            (Err(e), None) => panic!("{name}: unexpected error {e:?}"),
            (Ok(r), Some(kind)) => panic!("{name}: expected error {kind}, got {r:?}"),
            (Ok(r), None) => {
                let rv = serde_json::to_value(r).unwrap();
                let want = &case["reply"];
                assert_eq!(rv["kind"], want["kind"], "{name}: {rv}");
                if let Some(h) = want.get("head") {
                    assert_eq!(&rv["head"], h, "{name}");
                }
            }
        }
        let path = PathBuf::from(&req.path);
        let wrote = matches!(&res, Ok(SaveReply::Saved { .. }));
        if let Some(comment) = case["comment"].as_str() {
            let b = fs::read(&path).unwrap();
            assert_eq!(eocd_comment(&b), Some(comment.as_bytes()), "{name}: comment");
        }
        if let Some(parts) = case["parts"].as_object() {
            let v = read_validated(&path).unwrap().0;
            for (pname, sha) in parts {
                let text = v.parts.get(pname).unwrap_or_else(|| panic!("{name}: part {pname} missing"));
                assert_eq!(sha256_hex(text.as_bytes()), sha.as_str().unwrap(), "{name}: {pname}");
            }
        }
        if wrote {
            let b = fs::read(&path).unwrap();
            assert_eq!(entries_of(&b)[0], ("mimetype".to_string(), zip::CompressionMethod::Stored));
            fs::write(out.join(format!("{name}.lag")), &b).unwrap();
            let rr = read(&c, &path).unwrap();
            let mut rv = serde_json::to_value(&rr).unwrap();
            rv["stat"]["mtime"] = json!(0);
            replace_dir(&mut rv, &dir_s);
            assert_eq!(rr.manifest_text, req.manifest_text, "{name}: manifest byte for byte");
            fs::write(out.join(format!("{name}.read.json")), serde_json::to_vec_pretty(&rv).unwrap()).unwrap();
        }
        checked += 1;
    }
    // TS-written files, if any, must validate.
    if let Ok(rd) = fs::read_dir(&ts) {
        for e in rd.flatten() {
            if e.file_name().to_string_lossy().ends_with(".lag") {
                let v = validate_bytes(&fs::read(e.path()).unwrap());
                assert!(v.is_ok(), "{}: {:?}", e.path().display(), v.err());
                checked += 1;
            }
        }
    }
    println!("goldens: {checked} checked, written to {}", out.display());
    let _ = fs::remove_dir_all(&d);
}

/// Real cloud folder check (run by hand): LAS_CLOUD_TEST_DIR names an empty
/// folder inside a synced folder. Saves twice (rename over the file), reads
/// back, and checks that no temp file is left.
#[test]
#[ignore]
fn cloud_folder_save_and_rename_over() {
    let Some(dir) = std::env::var_os("LAS_CLOUD_TEST_DIR").map(PathBuf::from) else { return };
    fs::create_dir_all(&dir).unwrap();
    let state = tmpdir("cloud-state");
    let c = ctx(&state);
    let p = dir.join("Cloud test.lag");
    let mut m = one_rev("a-cloud-test", "r-1", "first");
    let t0 = Instant::now();
    let r = save(&c, &m.args(&p, "r-1", None, m.parts.clone())).unwrap();
    println!("save 1: {r:?} in {:?}", t0.elapsed());
    for i in 2..=4 {
        let id = format!("r-{i}");
        let parent = format!("r-{}", i - 1);
        m.rev(&id, &[&parent], t4(&texts(&id)));
        let t0 = Instant::now();
        let r = save(&c, &m.args(&p, &id, Some(&parent), m.parts_of(&id))).unwrap();
        println!("save {i}: {r:?} in {:?}", t0.elapsed());
        assert!(matches!(r, SaveReply::Saved { .. }));
    }
    let (v, _, _) = read_validated(&p).unwrap();
    assert_eq!(v.header.head, "r-4");
    std::thread::sleep(Duration::from_secs(3));
    let names: Vec<String> = fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    println!("folder: {names:?}");
    assert!(names.iter().all(|n| !n.contains(".tmp")), "{names:?}");
    // rename in the folder and follow on save
    let q = dir.join("Cloud test renamed.lag");
    fs::rename(&p, &q).unwrap();
    m.rev("r-5", &["r-4"], t4(&texts("r-5")));
    let r = save(&c, &m.args(&p, "r-5", Some("r-4"), m.parts_of("r-5"))).unwrap();
    println!("save after rename: {r:?}");
    assert!(matches!(&r, SaveReply::Saved { path, .. } if Path::new(path) == q));
    let _ = fs::remove_dir_all(&state);
}

// ───────────── fixes after the phase 1 review ─────────────

/// V4: a file whose ids break the id rule is refused on open (it could never be saved or journaled).
#[test]
fn ids_outside_the_rule_are_refused_on_open() {
    let d = tmpdir("weird-ids");
    let c = ctx(&d);
    for aid in ["a.with.dots", "../../../escape", "a b"] {
        let mut m = Mk::new(aid);
        m.rev("r-1", &[], t4(&texts("one")));
        // build_container writes whatever it is given; the comment parser rejects spaces itself
        let p = d.join("X.lag");
        put(&p, &m.bytes("r-1"));
        let e = read(&c, &p).unwrap_err();
        assert!(matches!(e.kind, ErrKind::Invalid | ErrKind::Incomplete), "{aid}: {e:?}");
        assert!(!d.join("escape").exists());
    }
    let mut m = Mk::new("a-ok");
    m.rev("r.bad", &[], t4(&texts("one")));
    let p = d.join("Y.lag");
    put(&p, &m.bytes("r.bad"));
    assert_eq!(read(&c, &p).unwrap_err().kind, ErrKind::Invalid);
    let _ = fs::remove_dir_all(&d);
}

/// V3: a save whose command gave up (cancel flag) writes nothing, even when it was past every other check.
#[test]
fn a_cancelled_save_writes_nothing() {
    let d = tmpdir("cancel");
    let c = ctx(&d);
    let p = d.join("A.lag");
    let mut m = one_rev("a-c", "r-1", "old");
    save(&c, &m.args(&p, "r-1", None, m.parts.clone())).unwrap();
    let before = fs::read(&p).unwrap();
    m.rev("r-2", &["r-1"], t4(&texts("new")));
    // cancelled before it starts
    let flag = AtomicBool::new(true);
    let e = save_cancellable(&c, &m.args(&p, "r-2", Some("r-1"), m.parts_of("r-2")), &flag).unwrap_err();
    assert_eq!(e.kind, ErrKind::OfflineOrTimeout);
    assert_eq!(fs::read(&p).unwrap(), before);
    // cancelled while it waits (set from inside, right before the rename): old file intact, no temp left
    let flag = Arc::new(AtomicBool::new(false));
    let f2 = flag.clone();
    lk(&c.hooks).before_rename = Some(Box::new(move |_| {
        f2.store(true, Ordering::SeqCst);
        Ok(())
    }));
    let e = save_cancellable(&c, &m.args(&p, "r-2", Some("r-1"), m.parts_of("r-2")), &flag).unwrap_err();
    assert_eq!(e.kind, ErrKind::OfflineOrTimeout);
    assert_eq!(fs::read(&p).unwrap(), before, "old file intact");
    assert!(temps_in(&d).is_empty(), "temp removed");
    // a new file is not created either
    let q = d.join("B.lag");
    let n = one_rev("a-n", "r-1", "b");
    flag.store(false, Ordering::SeqCst);
    assert!(save_cancellable(&c, &n.args(&q, "r-1", None, n.parts.clone()), &flag).is_err());
    assert!(!q.exists() && temps_in(&d).is_empty());
    lk(&c.hooks).before_rename = None;
    assert!(matches!(save(&c, &m.args(&p, "r-2", Some("r-1"), m.parts_of("r-2"))).unwrap(), SaveReply::Saved { .. }));
    let _ = fs::remove_dir_all(&d);
}

/// F1: while the file still can't be checked, a repeated Save replaces the app's own aside copy
/// instead of adding " 2", " 3", …; every version stays in the journal.
#[test]
fn repeated_saves_aside_reuse_the_first_copy() {
    let d = tmpdir("aside-reuse");
    let c = ctx(&d);
    let p = d.join("Dose.lag");
    let mut m = one_rev("a-r", "r-1", "base");
    save(&c, &m.args(&p, "r-1", None, m.parts.clone())).unwrap();
    crate::graphwatch::track(&c, &p, true, Some("r-1".into()), Some("a-r".into()), 0, &Default::default());
    put(&p, b"PK\x03\x04 still downloading");
    m.rev("r-2", &["r-1"], t4(&texts("two")));
    let SaveReply::SavedAside { path: p1, .. } = save(&c, &m.args(&p, "r-2", Some("r-1"), m.parts_of("r-2"))).unwrap() else { panic!() };
    // the same base, more work: a second save aside
    let mut m2 = one_rev("a-r", "r-1", "base");
    m2.rev("r-3", &["r-1"], t4(&texts("three")));
    let SaveReply::SavedAside { path: p2, head, .. } = save(&c, &m2.args(&p, "r-3", Some("r-1"), m2.parts_of("r-3"))).unwrap() else { panic!() };
    assert_eq!(p1, p2, "the first copy is reused");
    assert_eq!(head, "r-3");
    assert_eq!(read_validated(Path::new(&p2)).unwrap().0.header.head, "r-3");
    assert!(c.read_journal("a-r", "r-2").unwrap().is_some(), "the replaced copy's version is in the journal");
    // a copy somebody else changed is not reused
    let other = one_rev("a-r", "r-9", "theirs");
    put(Path::new(&p2), &other.bytes("r-9"));
    let mut m3 = one_rev("a-r", "r-1", "base");
    m3.rev("r-4", &["r-1"], t4(&texts("four")));
    let SaveReply::SavedAside { path: p3, .. } = save(&c, &m3.args(&p, "r-4", Some("r-1"), m3.parts_of("r-4"))).unwrap() else { panic!() };
    assert_ne!(p3, p2);
    assert!(p3.ends_with(" 2.lag"), "{p3}");
    let _ = fs::remove_dir_all(&d);
}

/// V1 (save side): after a case-only rename the save goes to the spelling on disk and says so.
#[test]
fn save_after_a_case_only_rename_keeps_the_new_spelling() {
    let d = tmpdir("case-save");
    let c = ctx(&d);
    let ev = collect(&c);
    let p = d.join("data.lag");
    let mut m = one_rev("a-case", "r-1", "one");
    save(&c, &m.args(&p, "r-1", None, m.parts.clone())).unwrap();
    let q = d.join("Data.lag");
    fs::rename(&p, &q).unwrap();
    if fs::metadata(&p).is_err() {
        eprintln!("case-sensitive volume: nothing to check");
        let _ = fs::remove_dir_all(&d);
        return;
    }
    assert_eq!(on_disk_spelling(&p), Some(q.clone()));
    assert_eq!(on_disk_spelling(&q), None);
    m.rev("r-2", &["r-1"], t4(&texts("two")));
    let r = save(&c, &m.args(&p, "r-2", Some("r-1"), m.parts_of("r-2"))).unwrap();
    assert!(matches!(&r, SaveReply::Saved { path, .. } if Path::new(path) == q), "{r:?}");
    let names: Vec<String> = fs::read_dir(&d).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.ends_with(".lag")).collect();
    assert_eq!(names, vec!["Data.lag".to_string()]);
    assert!(lk(&ev).iter().any(|(_, v)| v["type"] == "moved" && v["to"] == q.to_string_lossy().as_ref()));
    let _ = fs::remove_dir_all(&d);
}

/// F1: asking for a download of a local file is harmless and returns at once.
#[test]
fn request_download_never_blocks() {
    let d = tmpdir("download");
    let p = d.join("A.lag");
    fs::write(&p, b"x").unwrap();
    let t0 = Instant::now();
    request_download(&p);
    request_download(&p);
    request_download(&d.join("missing.lag"));
    assert!(t0.elapsed() < Duration::from_millis(200));
    std::thread::sleep(Duration::from_millis(50));
    let _ = fs::remove_dir_all(&d);
}
