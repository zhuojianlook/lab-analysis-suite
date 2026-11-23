//! Analysis files (`.lag`): the ZIP container, full validation, the header
//! (ZIP comment) read, save with the full check, the journal of every
//! validated head, displaced copies, folder scan and Find it…
//! (phase1-contract.md §1, plan §1, §7, §8).
//!
//! TypeScript produces every JSON text that goes into a file; this module
//! writes those bytes unchanged, hashes them and copies them. It parses a copy
//! of the manifest to check it and never parses a part.
//!
//! Every public operation here is synchronous and blocking; the Tauri commands
//! at the end run them on a blocking thread raced against a timeout
//! (`blocking`), so a hung cloud folder never blocks the UI.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{self, Cursor, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

// ═════════════════════════════════════════════════════════════════════════════
// Constants (mirror format.ts / contract.ts LIMITS)
// ═════════════════════════════════════════════════════════════════════════════

pub const EXT: &str = "lag";
pub const PRESENCE_EXT: &str = "laguse";
pub const MAGIC: &str = "LASGRAPH1";
pub const MIME: &str = "application/vnd.labanalysissuite.graph+zip";
pub const FORMAT: &str = "lasgraph";
pub const READER_VERSION: u64 = 1;
pub const SECTION_NAMES: [&str; 4] = ["table", "analysis", "figure", "scratchpad"];

/// Largest `.lag` file read or written.
pub const READ_LIMIT: u64 = 64 * 1024 * 1024;
/// Largest total of inflated entries in one file.
pub const INFLATE_LIMIT: u64 = 256 * 1024 * 1024;
/// Tail of a file read to find the ZIP comment (64 KB comment + EOCD record).
pub const HEADER_TAIL: u64 = 64 * 1024 + 22;

pub const COMMAND_TIMEOUT: Duration = Duration::from_millis(15_000);
pub const SAVE_TIMEOUT: Duration = Duration::from_millis(30_000);
pub const LOCATE_TIMEOUT: Duration = Duration::from_millis(22_000);

/// Orphan temp files (`.~*.tmp-*`) older than this are removed when a file in
/// their folder is read.
const ORPHAN_TEMP_AGE: Duration = Duration::from_secs(10 * 60);

pub const EVT_FILE: &str = "graphfile://event";
pub const EVT_LOCATE_PROGRESS: &str = "graphfile://locate-progress";

// ═════════════════════════════════════════════════════════════════════════════
// Errors (contract §1.1)
// ═════════════════════════════════════════════════════════════════════════════

/// Serialised as the bare variant name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ErrKind {
    NotFound,
    PermissionDenied,
    OfflineOrTimeout,
    Incomplete,
    Dataless,
    TooNew,
    IdentityMismatch,
    Invalid,
    Io,
    Cancelled,
    NoStateDir,
}

/// What every file / app-state command rejects with (`RustError` in contract.ts).
#[derive(Debug, Clone, Serialize)]
pub struct FileErr {
    pub kind: ErrKind,
    pub message: String,
    pub data: Option<Value>,
}

pub type FResult<T> = Result<T, FileErr>;

impl FileErr {
    pub fn new(kind: ErrKind, message: impl Into<String>) -> Self {
        FileErr { kind, message: message.into(), data: None }
    }
    pub fn with_data(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
    }
    pub fn incomplete(reason: &str) -> Self {
        FileErr::new(ErrKind::Incomplete, format!("the file is incomplete ({reason})"))
            .with_data(json!({ "reason": reason }))
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        FileErr::new(ErrKind::Invalid, message)
    }
    pub fn io(message: impl Into<String>) -> Self {
        FileErr::new(ErrKind::Io, message)
    }
    pub fn no_state_dir() -> Self {
        FileErr::new(ErrKind::NoStateDir, "the app has no folder for its own records")
    }
    pub fn timeout() -> Self {
        FileErr::new(ErrKind::OfflineOrTimeout, "the folder didn't answer in time")
    }
    pub fn identity(found: Option<&str>) -> Self {
        FileErr::new(ErrKind::IdentityMismatch, "a different analysis is saved under this name")
            .with_data(json!({ "found": found }))
    }
    pub fn too_new(min_reader_version: u64) -> Self {
        FileErr::new(ErrKind::TooNew, "the file was made with a newer version of the app")
            .with_data(json!({ "min_reader_version": min_reader_version }))
    }
    pub fn dataless(path: &Path) -> Self {
        FileErr::new(ErrKind::Dataless, format!("{} is online-only", path.display()))
    }

    /// Map an OS error on `path` to a kind (contract §1.1 table).
    pub fn from_io(e: &io::Error, path: &Path) -> Self {
        let kind = io_kind(e, path);
        FileErr::new(kind, format!("{}: {}", path.display(), e))
    }
}

fn io_kind(e: &io::Error, path: &Path) -> ErrKind {
    #[cfg(unix)]
    if let Some(code) = e.raw_os_error() {
        match code {
            libc::ENOENT | libc::ENOTDIR => return ErrKind::NotFound,
            libc::EPERM | libc::EACCES => return ErrKind::PermissionDenied,
            libc::ETIMEDOUT => return ErrKind::OfflineOrTimeout,
            libc::EIO | libc::ENETDOWN | libc::ENETUNREACH | libc::EHOSTUNREACH if is_cloud_path(path) => {
                return ErrKind::OfflineOrTimeout
            }
            _ => {}
        }
    }
    #[cfg(not(unix))]
    let _ = path;
    match e.kind() {
        io::ErrorKind::NotFound => ErrKind::NotFound,
        io::ErrorKind::PermissionDenied => ErrKind::PermissionDenied,
        io::ErrorKind::TimedOut => ErrKind::OfflineOrTimeout,
        _ => ErrKind::Io,
    }
}

/// Is `path` inside a cloud-synced folder (File Provider / sync client)?
pub fn is_cloud_path(path: &Path) -> bool {
    let s = path.to_string_lossy();
    if s.contains("/Library/CloudStorage/") || s.contains("/Library/Mobile Documents/") {
        return true;
    }
    path.components().any(|c| {
        let n = c.as_os_str().to_string_lossy();
        n == "Dropbox" || n.starts_with("OneDrive") || n == "Google Drive" || n == "iCloudDrive"
    })
}

/// Ids used in file names (contract §0.4).
pub fn valid_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 80 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn check_id(what: &str, s: &str) -> FResult<()> {
    if valid_id(s) {
        Ok(())
    } else {
        Err(FileErr::invalid(format!("bad {what}: {s:?}")))
    }
}

/// Lock a mutex, recovering from poisoning (no panic ever crosses a command).
pub fn lk<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn wall_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let d = Sha256::digest(bytes);
    let mut s = String::with_capacity(64);
    for b in d.iter() {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn rand_hex8() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..8].to_string()
}

pub fn has_lag_ext(p: &Path) -> bool {
    p.extension().map(|e| e.to_string_lossy().eq_ignore_ascii_case(EXT)).unwrap_or(false)
}

pub(crate) fn name_has_ext(name: &str, ext: &str) -> bool {
    match name.rfind('.') {
        Some(i) if i > 0 => name[i + 1..].eq_ignore_ascii_case(ext),
        _ => false,
    }
}

pub(crate) fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

// ═════════════════════════════════════════════════════════════════════════════
// Stat
// ═════════════════════════════════════════════════════════════════════════════

/// `FileStat` of contract.ts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileStat {
    pub path: String,
    pub size: u64,
    /// Milliseconds since the epoch.
    pub mtime: i64,
    pub dataless: bool,
}

pub fn mtime_ms(m: &fs::Metadata) -> i64 {
    match m.modified() {
        Ok(t) => match t.duration_since(UNIX_EPOCH) {
            Ok(d) => d.as_millis() as i64,
            Err(e) => -(e.duration().as_millis() as i64),
        },
        Err(_) => 0,
    }
}

/// Online-only placeholder, from stat flags (never opens the file).
pub fn is_dataless(m: &fs::Metadata) -> bool {
    #[cfg(target_os = "macos")]
    {
        use std::os::macos::fs::MetadataExt;
        m.st_flags() & 0x4000_0000 != 0 // SF_DATALESS
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS | FILE_ATTRIBUTE_OFFLINE
        m.file_attributes() & (0x0040_0000 | 0x0000_1000) != 0
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = m;
        false
    }
}

pub fn stat_of(path: &Path, m: &fs::Metadata) -> FileStat {
    FileStat { path: path_str(path), size: m.len(), mtime: mtime_ms(m), dataless: is_dataless(m) }
}

/// stat (following symlinks) with typed errors. A directory is `NotFound`.
pub fn stat_path(path: &Path) -> FResult<FileStat> {
    match fs::metadata(path) {
        Ok(m) if m.is_dir() => Err(FileErr::new(ErrKind::NotFound, format!("{} is a folder", path.display()))),
        Ok(m) => Ok(stat_of(path, &m)),
        Err(e) => Err(FileErr::from_io(&e, path)),
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// Header (ZIP comment)
// ═════════════════════════════════════════════════════════════════════════════

/// `FileHeader` of format.ts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileHeader {
    pub analysis_id: String,
    pub head: String,
}

/// `LASGRAPH1 <analysis_id> <head>` → header.
pub fn parse_comment(c: &[u8]) -> Option<FileHeader> {
    let s = std::str::from_utf8(c).ok()?;
    if !s.is_ascii() {
        return None;
    }
    let mut it = s.split(' ');
    let (m, a, h) = (it.next()?, it.next()?, it.next()?);
    if it.next().is_some() || m != MAGIC || a.is_empty() || h.is_empty() {
        return None;
    }
    if !a.bytes().chain(h.bytes()).all(|b| b.is_ascii_graphic()) {
        return None;
    }
    Some(FileHeader { analysis_id: a.to_string(), head: h.to_string() })
}

/// The comment of the end-of-central-directory record at the end of `tail`.
pub fn eocd_comment(tail: &[u8]) -> Option<&[u8]> {
    if tail.len() < 22 {
        return None;
    }
    let mut i = tail.len() - 22;
    loop {
        if tail[i..i + 4] == [0x50, 0x4b, 0x05, 0x06] {
            let clen = u16::from_le_bytes([tail[i + 20], tail[i + 21]]) as usize;
            if i + 22 + clen == tail.len() {
                return Some(&tail[i + 22..]);
            }
        }
        if i == 0 {
            return None;
        }
        i -= 1;
    }
}

/// Header read (contract §1.3): stat, then at most the last 64 KB + 22 bytes.
pub fn read_header(path: &Path) -> FResult<(FileHeader, FileStat)> {
    let st = stat_path(path)?;
    if st.dataless {
        return Err(FileErr::dataless(path));
    }
    if st.size < 22 {
        return Err(FileErr::incomplete("comment"));
    }
    let mut f = fs::File::open(path).map_err(|e| FileErr::from_io(&e, path))?;
    let len = f.metadata().map(|m| m.len()).unwrap_or(st.size);
    let start = len.saturating_sub(HEADER_TAIL);
    f.seek(SeekFrom::Start(start)).map_err(|e| FileErr::from_io(&e, path))?;
    let mut tail = Vec::with_capacity((len - start) as usize);
    f.take(HEADER_TAIL).read_to_end(&mut tail).map_err(|e| FileErr::from_io(&e, path))?;
    let h = eocd_comment(&tail).and_then(parse_comment).ok_or_else(|| FileErr::incomplete("comment"))?;
    Ok((h, st))
}

// ═════════════════════════════════════════════════════════════════════════════
// Manifest checks
// ═════════════════════════════════════════════════════════════════════════════

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PartRef {
    pub part: String,
    pub sha256: String,
    pub bytes: u64,
}

fn parse_ref(v: &Value) -> Option<PartRef> {
    Some(PartRef {
        part: v.get("part")?.as_str()?.to_string(),
        sha256: v.get("sha256")?.as_str()?.to_string(),
        bytes: v.get("bytes")?.as_u64()?,
    })
}

/// `parts/<64 lowercase hex>.json` → the hex.
pub fn part_hex(name: &str) -> Option<&str> {
    let hex = name.strip_prefix("parts/")?.strip_suffix(".json")?;
    (hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))).then_some(hex)
}

fn ref_consistent(r: &PartRef) -> bool {
    part_hex(&r.part) == Some(r.sha256.as_str())
}

#[derive(Debug, Clone)]
pub struct ManifestInfo {
    pub analysis_id: String,
    pub head: String,
    /// The head revision's four section parts.
    pub head_refs: Vec<PartRef>,
    /// Every well-formed part referenced by a revision with sections.
    pub all_refs: BTreeMap<String, PartRef>,
}

/// Manifest checks (contract §1.3 step 6). `strict` (save): every revision's
/// sections must be well-formed and consistent; otherwise only the head's.
pub fn check_manifest(m: &Value, strict: bool) -> Result<ManifestInfo, String> {
    let aid = m.get("analysis_id").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or("no analysis_id")?;
    let head = m.get("head").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or("no head")?;
    let revs = m.get("revisions").and_then(Value::as_array).ok_or("no revisions")?;
    let mut head_refs: Option<Vec<PartRef>> = None;
    let mut all_refs = BTreeMap::new();
    for r in revs {
        let id = r.get("id").and_then(Value::as_str);
        if strict && id.is_none() {
            return Err("a revision has no id".into());
        }
        let is_head = id == Some(head);
        let sections = r.get("sections").unwrap_or(&Value::Null);
        if sections.is_null() {
            if is_head {
                return Err("the head revision has no sections".into());
            }
            continue;
        }
        let Some(obj) = sections.as_object() else {
            if strict || is_head {
                return Err("sections is not an object".into());
            }
            continue;
        };
        let refs: Vec<Option<PartRef>> = SECTION_NAMES.iter().map(|n| obj.get(*n).and_then(parse_ref)).collect();
        if refs.iter().any(Option::is_none) {
            if strict || is_head {
                return Err(format!("revision {} lacks a section", id.unwrap_or("?")));
            }
            continue;
        }
        let refs: Vec<PartRef> = refs.into_iter().flatten().collect();
        if strict && !refs.iter().all(ref_consistent) {
            return Err(format!("revision {} names a part that doesn't match its hash", id.unwrap_or("?")));
        }
        for pr in &refs {
            if ref_consistent(pr) {
                all_refs.insert(pr.part.clone(), pr.clone());
            }
        }
        if is_head && head_refs.is_none() {
            head_refs = Some(refs);
        }
    }
    let head_refs = head_refs.ok_or("head is not among the revisions")?;
    Ok(ManifestInfo { analysis_id: aid.to_string(), head: head.to_string(), head_refs, all_refs })
}

/// Is `anc` the same as or an ancestor of `rev` in this manifest's history?
pub fn is_ancestor_or_self(m: &Value, anc: &str, rev: &str) -> bool {
    let mut parents: HashMap<&str, Vec<&str>> = HashMap::new();
    if let Some(revs) = m.get("revisions").and_then(Value::as_array) {
        for r in revs {
            if let Some(id) = r.get("id").and_then(Value::as_str) {
                let ps = r
                    .get("parents")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(Value::as_str).collect())
                    .unwrap_or_default();
                parents.insert(id, ps);
            }
        }
    }
    let mut seen = HashSet::new();
    let mut stack = vec![rev];
    while let Some(id) = stack.pop() {
        if id == anc {
            return true;
        }
        if !seen.insert(id) {
            continue;
        }
        if let Some(ps) = parents.get(id) {
            stack.extend(ps.iter().copied());
        }
    }
    false
}

// ═════════════════════════════════════════════════════════════════════════════
// Container: write and full validation
// ═════════════════════════════════════════════════════════════════════════════

/// Build the whole file in memory (contract §1.3 "Writing").
pub fn build_container(manifest_text: &str, aid: &str, head: &str, parts: &BTreeMap<String, String>) -> FResult<Vec<u8>> {
    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, DateTime, ZipWriter};
    let zerr = |e: zip::result::ZipError| FileErr::io(format!("couldn't build the file: {e}"));
    let ioerr = |e: io::Error| FileErr::io(format!("couldn't build the file: {e}"));
    let base = SimpleFileOptions::default().last_modified_time(DateTime::default()).unix_permissions(0o644);
    let stored = base.compression_method(CompressionMethod::Stored);
    let deflated = base.compression_method(CompressionMethod::Deflated);
    let mut w = ZipWriter::new(Cursor::new(Vec::new()));
    w.start_file("mimetype", stored).map_err(zerr)?;
    w.write_all(MIME.as_bytes()).map_err(ioerr)?;
    w.start_file("manifest.json", deflated).map_err(zerr)?;
    w.write_all(manifest_text.as_bytes()).map_err(ioerr)?;
    for (name, text) in parts {
        w.start_file(name.as_str(), deflated).map_err(zerr)?;
        w.write_all(text.as_bytes()).map_err(ioerr)?;
    }
    w.set_comment(format!("{MAGIC} {aid} {head}"));
    Ok(w.finish().map_err(zerr)?.into_inner())
}

/// A file that passed full validation.
#[derive(Debug, Clone)]
pub struct Validated {
    pub manifest_text: String,
    pub manifest: Value,
    pub header: FileHeader,
    /// Every `parts/<sha>.json` entry → its text.
    pub parts: BTreeMap<String, String>,
    pub min_reader_version: u64,
    /// SHA-256 of the whole file.
    pub sha256: String,
}

impl Validated {
    pub fn too_new(&self) -> bool {
        self.min_reader_version > READER_VERSION
    }
    pub fn raw(&self) -> RawFile {
        RawFile { manifest_text: self.manifest_text.clone(), parts: self.parts.clone() }
    }
    /// A string field of the head revision.
    pub fn head_field(&self, key: &str) -> String {
        self.manifest
            .get("revisions")
            .and_then(Value::as_array)
            .and_then(|a| a.iter().find(|r| r.get("id").and_then(Value::as_str) == Some(&self.header.head)))
            .and_then(|r| r.get(key))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    }
}

enum EntryErr {
    TooBig,
    Bad,
}

fn read_entry<R: Read + Seek>(ar: &mut zip::ZipArchive<R>, idx: usize, budget: &mut u64) -> Result<Vec<u8>, EntryErr> {
    let mut f = ar.by_index(idx).map_err(|_| EntryErr::Bad)?;
    if f.size() > *budget {
        return Err(EntryErr::TooBig);
    }
    let mut buf = Vec::with_capacity(f.size().min(1 << 20) as usize);
    (&mut f).take(*budget + 1).read_to_end(&mut buf).map_err(|_| EntryErr::Bad)?;
    if buf.len() as u64 > *budget {
        return Err(EntryErr::TooBig);
    }
    *budget -= buf.len() as u64;
    Ok(buf)
}

/// Full validation of a file's bytes (contract §1.3 steps 3–10).
pub fn validate_bytes(bytes: &[u8]) -> FResult<Validated> {
    if bytes.is_empty() {
        return Err(FileErr::incomplete("empty"));
    }
    if bytes.len() as u64 > READ_LIMIT {
        return Err(FileErr::invalid("the file is too large"));
    }
    let too_big = || FileErr::invalid("the file is too large when unpacked");
    let mut ar = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| FileErr::incomplete("zip"))?;
    if ar.len() == 0 {
        return Err(FileErr::invalid("not an analysis file"));
    }
    let mut budget = INFLATE_LIMIT;
    {
        let f = ar.by_index(0).map_err(|_| FileErr::incomplete("zip"))?;
        if f.name() != "mimetype" || f.compression() != zip::CompressionMethod::Stored || f.size() > 256 {
            return Err(FileErr::invalid("not an analysis file"));
        }
    }
    let mime = read_entry(&mut ar, 0, &mut budget).map_err(|_| FileErr::incomplete("zip"))?;
    if mime != MIME.as_bytes() {
        return Err(FileErr::invalid("not an analysis file"));
    }
    let midx = ar.index_for_name("manifest.json").ok_or_else(|| FileErr::incomplete("manifest"))?;
    let mbytes = read_entry(&mut ar, midx, &mut budget).map_err(|e| match e {
        EntryErr::TooBig => too_big(),
        EntryErr::Bad => FileErr::incomplete("manifest"),
    })?;
    let manifest_text = String::from_utf8(mbytes).map_err(|_| FileErr::invalid("not an analysis file"))?;
    let manifest: Value = serde_json::from_str(&manifest_text).map_err(|_| FileErr::invalid("not an analysis file"))?;
    if manifest.get("format").and_then(Value::as_str) != Some(FORMAT) {
        return Err(FileErr::invalid("not an analysis file"));
    }
    let info = check_manifest(&manifest, false).map_err(|_| FileErr::incomplete("manifest"))?;
    // The same id rule as a save (contract §0.4): a file this app could open
    // but never save again (and never journal) is refused at once.
    if !valid_id(&info.analysis_id) || !valid_id(&info.head) {
        return Err(FileErr::invalid("the file's ids aren't ones this app makes"));
    }
    let expected = format!("{MAGIC} {} {}", info.analysis_id, info.head);
    if ar.comment() != expected.as_bytes() {
        return Err(FileErr::incomplete("comment"));
    }
    let mut parts = BTreeMap::new();
    for i in 0..ar.len() {
        let name = match ar.name_for_index(i) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if !(name.starts_with("parts/") && name.ends_with(".json")) {
            continue;
        }
        let hex = part_hex(&name).ok_or_else(|| FileErr::incomplete("part"))?.to_string();
        let data = read_entry(&mut ar, i, &mut budget).map_err(|e| match e {
            EntryErr::TooBig => too_big(),
            EntryErr::Bad => FileErr::incomplete("part"),
        })?;
        if sha256_hex(&data) != hex {
            return Err(FileErr::incomplete("part"));
        }
        let text = String::from_utf8(data).map_err(|_| FileErr::incomplete("part"))?;
        parts.insert(name, text);
    }
    for r in &info.head_refs {
        let ok = ref_consistent(r) && parts.get(&r.part).map(|t| t.len() as u64 == r.bytes).unwrap_or(false);
        if !ok {
            return Err(FileErr::incomplete("part"));
        }
    }
    let min_reader_version = manifest.get("min_reader_version").and_then(Value::as_u64).unwrap_or(1);
    Ok(Validated {
        manifest_text,
        header: FileHeader { analysis_id: info.analysis_id, head: info.head },
        manifest,
        parts,
        min_reader_version,
        sha256: sha256_hex(bytes),
    })
}

/// Read a whole file (contract §1.3 steps 1–2): stat first (never opens an
/// online-only file), then open, fstat and read.
pub fn read_file_bytes(path: &Path) -> FResult<(Vec<u8>, FileStat)> {
    read_bytes(path, true)
}

/// `read_file_bytes`; `ask_download` false: an online-only file is reported
/// `Dataless` without asking for its download (peek, remove copy).
fn read_bytes(path: &Path, ask_download: bool) -> FResult<(Vec<u8>, FileStat)> {
    let st = stat_path(path)?;
    if st.dataless {
        // Never read here (a read could block for the whole download); ask for it in the background.
        if ask_download {
            request_download(path);
        }
        return Err(FileErr::dataless(path));
    }
    if st.size > READ_LIMIT {
        return Err(FileErr::invalid("the file is too large"));
    }
    if st.size == 0 {
        return Err(FileErr::incomplete("empty"));
    }
    let mut f = fs::File::open(path).map_err(|e| FileErr::from_io(&e, path))?;
    let m = f.metadata().map_err(|e| FileErr::from_io(&e, path))?;
    let st = stat_of(path, &m);
    let mut buf = Vec::with_capacity(st.size as usize);
    (&mut f).take(READ_LIMIT + 1).read_to_end(&mut buf).map_err(|e| FileErr::from_io(&e, path))?;
    if buf.len() as u64 > READ_LIMIT {
        return Err(FileErr::invalid("the file is too large"));
    }
    Ok((buf, st))
}

pub fn read_validated(path: &Path) -> FResult<(Validated, FileStat, Vec<u8>)> {
    let (bytes, st) = read_file_bytes(path)?;
    let v = validate_bytes(&bytes)?;
    Ok((v, st, bytes))
}

/// `read_validated` that never asks for an online-only file's download.
pub fn read_validated_quiet(path: &Path) -> FResult<(Validated, FileStat, Vec<u8>)> {
    let (bytes, st) = read_bytes(path, false)?;
    let v = validate_bytes(&bytes)?;
    Ok((v, st, bytes))
}

// ═════════════════════════════════════════════════════════════════════════════
// Wire types
// ═════════════════════════════════════════════════════════════════════════════

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawFile {
    pub manifest_text: String,
    pub parts: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadReply {
    pub manifest_text: String,
    pub parts: BTreeMap<String, String>,
    pub stat: FileStat,
    pub read_only: Option<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HeaderReply {
    pub header: FileHeader,
    pub stat: FileStat,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveArgs {
    pub path: String,
    pub expected_head: Option<String>,
    pub analysis_id: String,
    pub doc_key: String,
    pub manifest_text: String,
    #[serde(default)]
    pub new_parts: BTreeMap<String, String>,
    #[serde(default)]
    pub replace_existing: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SaveReply {
    Saved {
        path: String,
        head: String,
        stat: FileStat,
    },
    SavedAside {
        path: String,
        head: String,
        stat: FileStat,
    },
    SavedButDisplaced {
        path: String,
        head: String,
        stat: FileStat,
        #[serde(rename = "displacedHead")]
        displaced_head: String,
    },
    Conflict {
        head: String,
    },
    Missing,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct JournalHead {
    pub analysis_id: String,
    pub path: String,
    pub revision_id: String,
    pub confirmed: bool,
    pub first_seen: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DisplacedEntry {
    pub id: String,
    pub original: String,
    pub analysis_id: String,
    pub head: String,
    pub reason: String,
    pub at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub mtime: i64,
    pub kind: &'static str,
    pub dataless: bool,
    pub header: Option<FileHeader>,
}

// ═════════════════════════════════════════════════════════════════════════════
// Shared context
// ═════════════════════════════════════════════════════════════════════════════

/// What Rust remembers about a path after a full read or save (contract §1.2).
#[derive(Debug, Clone, PartialEq)]
pub struct ValRecord {
    pub size: u64,
    pub mtime: i64,
    pub sha256: String,
    pub analysis_id: String,
    pub head: String,
    pub too_new: bool,
}

/// Per-path exclusive locks (save, journal write, and the poll's try-lock).
#[derive(Default)]
pub struct PathLocks {
    held: Mutex<HashSet<PathBuf>>,
    cv: Condvar,
}

pub struct PathGuard<'a> {
    locks: &'a PathLocks,
    path: PathBuf,
}

impl PathLocks {
    pub fn lock(&self, p: &Path) -> PathGuard<'_> {
        let mut held = lk(&self.held);
        while held.contains(p) {
            held = self.cv.wait(held).unwrap_or_else(|e| e.into_inner());
        }
        held.insert(p.to_path_buf());
        PathGuard { locks: self, path: p.to_path_buf() }
    }
    pub fn try_lock(&self, p: &Path) -> Option<PathGuard<'_>> {
        let mut held = lk(&self.held);
        if held.contains(p) {
            return None;
        }
        held.insert(p.to_path_buf());
        Some(PathGuard { locks: self, path: p.to_path_buf() })
    }
}

impl Drop for PathGuard<'_> {
    fn drop(&mut self) {
        lk(&self.locks.held).remove(&self.path);
        self.locks.cv.notify_all();
    }
}

pub type Emitter = Arc<dyn Fn(&str, Value) + Send + Sync>;

/// Tunables that tests shorten.
#[derive(Debug, Clone)]
pub struct Tuning {
    /// Save: how long an incomplete target is retried before saving aside.
    pub incomplete_retry: Duration,
    pub retry_step: Duration,
}

impl Default for Tuning {
    fn default() -> Self {
        Tuning { incomplete_retry: Duration::from_secs(10), retry_step: Duration::from_millis(500) }
    }
}

type PathHook = Box<dyn FnMut(&Path) -> FResult<()> + Send>;

#[derive(Clone, Copy)]
pub(crate) enum HookPoint {
    BeforeDisplace,
    BeforeRename,
    BeforeRemoveMove,
    BeforeNoteRename,
}

/// Test seams inside a save (None in the app).
#[derive(Default)]
pub struct Hooks {
    /// After the target check, before the target is linked aside.
    pub before_displace: Option<PathHook>,
    /// After the temp file is written and synced, right before the rename.
    pub before_rename: Option<PathHook>,
    /// Remove copy (phase 2): after the copy was read and judged, before it is
    /// stat'ed again and moved. Called with the copy's path.
    pub before_remove_move: Option<PathHook>,
    /// Remove copy: move by copy + verify + delete, as across volumes.
    pub force_copy_move: bool,
    /// Phase 3 note write: after the temp file is written, before the rename over the note.
    pub before_note_rename: Option<PathHook>,
}

pub struct FileCtx {
    pub state_dir: Option<PathBuf>,
    /// This launch's session id (a new one after `appstate_new_device_id`).
    session: RwLock<String>,
    pub tuning: Tuning,
    pub locks: PathLocks,
    records: Mutex<HashMap<PathBuf, ValRecord>>,
    journal_lock: Mutex<()>,
    displaced_lock: Mutex<()>,
    state_lock: Mutex<()>,
    locates: Mutex<HashMap<String, Arc<AtomicBool>>>,
    emitter: RwLock<Option<Emitter>>,
    pub watch: Mutex<crate::graphwatch::WatchState>,
    pub dir_cache: Mutex<HashMap<PathBuf, crate::graphwatch::CacheEntry>>,
    pub hooks: Mutex<Hooks>,
    /// Hardware id + default names (computed once; tests inject).
    pub device_env: crate::appstate::DeviceEnvCell,
    /// Drafts: doc_key → sequence number of the last write / delete applied
    /// (the lock also serialises the file operations themselves).
    pub draft_order: Mutex<HashMap<String, u64>>,
    /// Phase 3: this computer's notes (presence.rs).
    pub presence: Mutex<crate::presence::PresenceState>,
    /// Phase 3: what each `.laguse` file read so far contained, by (size, mtime, identity), and the reader
    /// threads that read them (presence.rs `read_notes`; shared with those threads).
    pub note_reader: Arc<crate::presence::NoteReader>,
    /// Phase 3: one note operation per document at a time (separate from the save locks).
    pub note_locks: PathLocks,
    /// Phase 3: serialises writes of the two note records in the state folder.
    pub note_persist: Mutex<()>,
}

pub fn new_session_id() -> String {
    format!("s-{}", uuid::Uuid::new_v4())
}

impl FileCtx {
    pub fn new(state_dir: Option<PathBuf>) -> Self {
        FileCtx {
            state_dir,
            session: RwLock::new(new_session_id()),
            tuning: Tuning::default(),
            locks: PathLocks::default(),
            records: Mutex::new(HashMap::new()),
            journal_lock: Mutex::new(()),
            displaced_lock: Mutex::new(()),
            state_lock: Mutex::new(()),
            locates: Mutex::new(HashMap::new()),
            emitter: RwLock::new(None),
            watch: Mutex::new(Default::default()),
            dir_cache: Mutex::new(HashMap::new()),
            hooks: Mutex::new(Hooks::default()),
            device_env: Default::default(),
            draft_order: Mutex::new(HashMap::new()),
            presence: Mutex::new(Default::default()),
            note_reader: Arc::new(Default::default()),
            note_locks: PathLocks::default(),
            note_persist: Mutex::new(()),
        }
    }

    pub fn session_id(&self) -> String {
        self.session.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn set_session_id(&self, s: String) {
        *self.session.write().unwrap_or_else(|e| e.into_inner()) = s;
    }

    pub fn set_emitter(&self, e: Emitter) {
        *self.emitter.write().unwrap_or_else(|e| e.into_inner()) = Some(e);
    }

    pub fn emit(&self, name: &str, payload: Value) {
        let e = self.emitter.read().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(e) = e {
            e(name, payload);
        }
    }

    pub fn state(&self) -> FResult<&Path> {
        self.state_dir.as_deref().ok_or_else(FileErr::no_state_dir)
    }

    /// Serialises read-modify-write of the app's small record files.
    pub fn state_guard(&self) -> MutexGuard<'_, ()> {
        lk(&self.state_lock)
    }

    pub fn record(&self, p: &Path) -> Option<ValRecord> {
        lk(&self.records).get(p).cloned()
    }

    pub fn set_record(&self, p: &Path, v: &Validated, st: &FileStat) {
        lk(&self.records).insert(
            p.to_path_buf(),
            ValRecord {
                size: st.size,
                mtime: st.mtime,
                sha256: v.sha256.clone(),
                analysis_id: v.header.analysis_id.clone(),
                head: v.header.head.clone(),
                too_new: v.too_new(),
            },
        );
    }

    pub(crate) fn run_hook(&self, which: HookPoint, p: &Path) -> FResult<()> {
        let mut hooks = lk(&self.hooks);
        let slot = match which {
            HookPoint::BeforeDisplace => &mut hooks.before_displace,
            HookPoint::BeforeRename => &mut hooks.before_rename,
            HookPoint::BeforeRemoveMove => &mut hooks.before_remove_move,
            HookPoint::BeforeNoteRename => &mut hooks.before_note_rename,
        };
        match slot {
            Some(h) => h(p),
            None => Ok(()),
        }
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// Small file helpers
// ═════════════════════════════════════════════════════════════════════════════

/// fsync; on macOS F_FULLFSYNC (to the platter), falling back to fsync.
fn full_sync(f: &fs::File) -> io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::io::AsRawFd;
        // SAFETY: plain fcntl on an open descriptor owned by `f`.
        let r = unsafe { libc::fcntl(f.as_raw_fd(), libc::F_FULLFSYNC) };
        if r != -1 {
            return Ok(());
        }
    }
    f.sync_all()
}

pub(crate) fn write_synced(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut f = fs::OpenOptions::new().write(true).create_new(true).open(path)?;
    f.write_all(bytes)?;
    full_sync(&f)?;
    Ok(())
}

/// Atomic replace of an app record: `.<name>.tmp-<hex>` beside it, fsync, rename.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = path.parent().ok_or_else(|| io::Error::other("no parent folder"))?;
    fs::create_dir_all(dir)?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = dir.join(format!(".{name}.tmp-{}", rand_hex8()));
    let res = (|| {
        let mut f = fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, path)
    })();
    if res.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    res
}

/// Rename that never replaces an existing file. macOS: renamex_np(RENAME_EXCL),
/// elsewhere (or when the volume doesn't support it) check-then-rename.
fn rename_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        if let (Ok(a), Ok(b)) = (CString::new(from.as_os_str().as_bytes()), CString::new(to.as_os_str().as_bytes())) {
            // SAFETY: two valid NUL-terminated paths.
            let r = unsafe { libc::renamex_np(a.as_ptr(), b.as_ptr(), libc::RENAME_EXCL) };
            if r == 0 {
                return Ok(());
            }
            let e = io::Error::last_os_error();
            match e.raw_os_error() {
                Some(libc::ENOTSUP) | Some(libc::EINVAL) => {}
                Some(libc::EEXIST) => return Err(io::Error::new(io::ErrorKind::AlreadyExists, e)),
                _ => return Err(e),
            }
        }
    }
    if fs::symlink_metadata(to).is_ok() {
        return Err(io::Error::new(io::ErrorKind::AlreadyExists, "the file already exists"));
    }
    fs::rename(from, to)
}

/// Rename over an existing file. Windows: a sharing violation is retried 5×
/// over 2 s.
pub(crate) fn rename_replace(from: &Path, to: &Path) -> FResult<()> {
    let mut tries = 0;
    loop {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) => {
                let busy = cfg!(windows) && matches!(e.raw_os_error(), Some(32) | Some(5) | Some(33));
                if busy && tries < 5 {
                    tries += 1;
                    std::thread::sleep(Duration::from_millis(400));
                    continue;
                }
                if busy {
                    return Err(FileErr::io("couldn't replace the file, it's in use"));
                }
                return Err(FileErr::from_io(&e, to));
            }
        }
    }
}

/// Temp name for a save (contract §1.4 step 6): `.~<name>.tmp-<8 hex>`.
pub fn temp_name_for(target: &Path) -> PathBuf {
    let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    target.with_file_name(format!(".~{name}.tmp-{}", rand_hex8()))
}

pub fn is_save_temp_name(name: &str) -> bool {
    name.starts_with(".~") && name.contains(".tmp-")
}

/// Delete orphan save temps older than 10 min in `dir` (best effort).
pub fn cleanup_orphan_temps(dir: &Path) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    let now = SystemTime::now();
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if !is_save_temp_name(&name) {
            continue;
        }
        let old = e
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| now.duration_since(t).ok())
            .map(|d| d >= ORPHAN_TEMP_AGE)
            .unwrap_or(false);
        if old {
            let _ = fs::remove_file(e.path());
        }
    }
}

fn read_json_file(path: &Path) -> Option<Value> {
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write_json_atomic(path: &Path, v: &Value) -> FResult<()> {
    let bytes = serde_json::to_vec_pretty(v).map_err(|e| FileErr::io(e.to_string()))?;
    atomic_write(path, &bytes).map_err(|e| FileErr::from_io(&e, path))
}

// ═════════════════════════════════════════════════════════════════════════════
// Journal (contract §1.5)
// ═════════════════════════════════════════════════════════════════════════════

#[derive(Debug, Default, Serialize, Deserialize)]
struct JournalIndex {
    v: u32,
    entries: Vec<JournalHead>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct DisplacedIndex {
    v: u32,
    entries: Vec<DisplacedEntry>,
}

fn load_index<T: Default + for<'de> Deserialize<'de>>(path: &Path) -> T {
    match fs::read(path) {
        Ok(b) => match serde_json::from_slice::<T>(&b) {
            Ok(v) => v,
            Err(_) => {
                let _ = fs::rename(path, path.with_extension(format!("json.bad-{}", wall_ms())));
                T::default()
            }
        },
        Err(_) => T::default(),
    }
}

fn save_index<T: Serialize>(path: &Path, idx: &T) -> FResult<()> {
    let v = serde_json::to_value(idx).map_err(|e| FileErr::io(e.to_string()))?;
    write_json_atomic(path, &v)
}

impl FileCtx {
    fn journal_dir(&self) -> FResult<PathBuf> {
        Ok(self.state()?.join("journal"))
    }

    fn displaced_dir(&self) -> FResult<PathBuf> {
        Ok(self.state()?.join("displaced"))
    }

    /// Journal a head (contract §1.5): copy the bytes if not there, add the
    /// index entry, and — when the head was seen on disk at `path` — confirm
    /// every older entry of the same (analysis, path) it descends from.
    pub fn journal_head(&self, path: &str, v: &Validated, bytes: &[u8], seen_on_disk: bool) -> FResult<()> {
        let aid = &v.header.analysis_id;
        let head = &v.header.head;
        check_id("analysis id", aid)?;
        check_id("version id", head)?;
        let dir = self.journal_dir()?;
        let _g = lk(&self.journal_lock);
        let file = dir.join(aid).join(format!("{head}.lag"));
        if !file.exists() {
            atomic_write(&file, bytes).map_err(|e| FileErr::from_io(&e, &file))?;
        }
        let idx_path = dir.join("index.json");
        let mut idx: JournalIndex = load_index(&idx_path);
        idx.v = 1;
        let mut changed = false;
        if !idx.entries.iter().any(|e| &e.analysis_id == aid && e.path == path && &e.revision_id == head) {
            idx.entries.push(JournalHead {
                analysis_id: aid.clone(),
                path: path.to_string(),
                revision_id: head.clone(),
                confirmed: false,
                first_seen: wall_ms(),
            });
            changed = true;
        }
        if seen_on_disk {
            for e in idx.entries.iter_mut() {
                if &e.analysis_id == aid
                    && e.path == path
                    && &e.revision_id != head
                    && !e.confirmed
                    && is_ancestor_or_self(&v.manifest, &e.revision_id, head)
                {
                    e.confirmed = true;
                    changed = true;
                }
            }
        }
        if changed {
            save_index(&idx_path, &idx)?;
        }
        Ok(())
    }

    /// Journal, logging instead of failing (the file itself is fine).
    pub fn journal_best_effort(&self, path: &str, v: &Validated, bytes: &[u8], seen_on_disk: bool) {
        if let Err(e) = self.journal_head(path, v, bytes, seen_on_disk) {
            if e.kind != ErrKind::NoStateDir {
                log::warn!("[graphfile] couldn't keep a safety copy of {path}: {}", e.message);
            }
        }
    }

    pub fn journal_heads(&self, aid: &str, path: Option<&str>) -> FResult<Vec<JournalHead>> {
        let dir = self.journal_dir()?;
        let _g = lk(&self.journal_lock);
        let idx: JournalIndex = load_index(&dir.join("index.json"));
        let mut out: Vec<JournalHead> = idx
            .entries
            .into_iter()
            .filter(|e| e.analysis_id == aid && path.map(|p| p == e.path).unwrap_or(true))
            .collect();
        out.sort_by_key(|e| e.first_seen);
        Ok(out)
    }

    pub fn has_journal_copy(&self, aid: &str, rev: &str) -> bool {
        match self.journal_dir() {
            Ok(d) if valid_id(aid) && valid_id(rev) => d.join(aid).join(format!("{rev}.lag")).exists(),
            _ => false,
        }
    }

    /// A journaled copy, validated; a damaged or missing copy → None.
    pub fn read_journal(&self, aid: &str, rev: &str) -> FResult<Option<Validated>> {
        check_id("analysis id", aid)?;
        check_id("version id", rev)?;
        let file = self.journal_dir()?.join(aid).join(format!("{rev}.lag"));
        match fs::read(&file) {
            Ok(b) => Ok(validate_bytes(&b).ok().filter(|v| v.header.analysis_id == aid && v.header.head == rev)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(FileErr::from_io(&e, &file)),
        }
    }

    /// `graphfile_write_journal`: build the file from `raw` and journal it unconfirmed.
    pub fn write_journal(&self, path: &str, raw: &RawFile) -> FResult<()> {
        self.state()?;
        let manifest: Value = serde_json::from_str(&raw.manifest_text).map_err(|_| FileErr::invalid("the manifest isn't JSON"))?;
        if manifest.get("format").and_then(Value::as_str) != Some(FORMAT) {
            return Err(FileErr::invalid("not an analysis file"));
        }
        let info = check_manifest(&manifest, false).map_err(FileErr::invalid)?;
        check_id("analysis id", &info.analysis_id)?;
        check_id("version id", &info.head)?;
        let mut parts = BTreeMap::new();
        for (name, text) in &raw.parts {
            let hex = part_hex(name).ok_or_else(|| FileErr::invalid(format!("bad part name {name}")))?;
            if sha256_hex(text.as_bytes()) != hex {
                return Err(FileErr::invalid(format!("part {name} doesn't match its name")));
            }
            if info.all_refs.contains_key(name) {
                parts.insert(name.clone(), text.clone());
            }
        }
        for r in &info.head_refs {
            match parts.get(&r.part) {
                Some(t) if ref_consistent(r) && t.len() as u64 == r.bytes => {}
                _ => return Err(FileErr::invalid(format!("part missing: {}", r.part))),
            }
        }
        let bytes = build_container(&raw.manifest_text, &info.analysis_id, &info.head, &parts)?;
        let v = validate_bytes(&bytes)?;
        self.journal_head(path, &v, &bytes, false)
    }

    /// Startup pruning (contract §1.5): journal — keep unconfirmed entries and
    /// the newest `keep` versions per analysis; beyond that delete the oldest
    /// confirmed while over `budget` bytes. Displaced — drop entries older
    /// than `max_age_ms`.
    pub fn prune(&self, keep: usize, budget: u64, max_age_ms: i64) -> FResult<()> {
        let jdir = self.journal_dir()?;
        {
            let _g = lk(&self.journal_lock);
            let idx_path = jdir.join("index.json");
            let mut idx: JournalIndex = load_index(&idx_path);
            // (aid, rev) → (newest first_seen, protected)
            let mut revs: HashMap<(String, String), (i64, bool)> = HashMap::new();
            for e in &idx.entries {
                let r = revs.entry((e.analysis_id.clone(), e.revision_id.clone())).or_insert((e.first_seen, false));
                r.0 = r.0.max(e.first_seen);
                r.1 |= !e.confirmed;
            }
            let mut per_aid: HashMap<String, Vec<(i64, String)>> = HashMap::new();
            for ((a, r), (t, _)) in &revs {
                per_aid.entry(a.clone()).or_default().push((*t, r.clone()));
            }
            for (a, mut list) in per_aid {
                list.sort_by(|x, y| y.0.cmp(&x.0));
                for (_, r) in list.into_iter().take(keep) {
                    if let Some(v) = revs.get_mut(&(a.clone(), r)) {
                        v.1 = true;
                    }
                }
            }
            // Files on disk with their size; files without an index entry are deletable first.
            let mut files: Vec<(i64, String, String, PathBuf, u64)> = Vec::new();
            let mut total: u64 = 0;
            if let Ok(rd) = fs::read_dir(&jdir) {
                for d in rd.flatten() {
                    if !d.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                        continue;
                    }
                    let aid = d.file_name().to_string_lossy().into_owned();
                    let Ok(inner) = fs::read_dir(d.path()) else { continue };
                    for f in inner.flatten() {
                        let name = f.file_name().to_string_lossy().into_owned();
                        let Some(rev) = name.strip_suffix(".lag") else { continue };
                        let size = f.metadata().map(|m| m.len()).unwrap_or(0);
                        total += size;
                        match revs.get(&(aid.clone(), rev.to_string())) {
                            Some((_, true)) => {}
                            Some((t, false)) => files.push((*t, aid.clone(), rev.to_string(), f.path(), size)),
                            None => files.push((i64::MIN, aid.clone(), rev.to_string(), f.path(), size)),
                        }
                    }
                }
            }
            files.sort_by_key(|f| f.0);
            let mut changed = false;
            for (_, aid, rev, p, size) in files {
                if total <= budget {
                    break;
                }
                if fs::remove_file(&p).is_ok() {
                    total = total.saturating_sub(size);
                    let before = idx.entries.len();
                    idx.entries.retain(|e| !(e.analysis_id == aid && e.revision_id == rev));
                    changed |= idx.entries.len() != before;
                }
            }
            if changed {
                idx.v = 1;
                save_index(&idx_path, &idx)?;
            }
        }
        let ddir = self.displaced_dir()?;
        let _g = lk(&self.displaced_lock);
        let idx_path = ddir.join("index.json");
        let mut idx: DisplacedIndex = load_index(&idx_path);
        let now = wall_ms();
        let before = idx.entries.len();
        idx.entries.retain(|e| {
            let keep = now - e.at < max_age_ms;
            if !keep {
                let _ = fs::remove_file(ddir.join(format!("{}.lag", e.id)));
            }
            keep
        });
        if idx.entries.len() != before {
            idx.v = 1;
            save_index(&idx_path, &idx)?;
        }
        Ok(())
    }

    // ── displaced copies ──────────────────────────────────────────────────────

    pub fn list_displaced(&self) -> FResult<Vec<DisplacedEntry>> {
        let dir = self.displaced_dir()?;
        let _g = lk(&self.displaced_lock);
        let idx: DisplacedIndex = load_index(&dir.join("index.json"));
        Ok(idx.entries)
    }

    pub fn read_displaced(&self, id: &str) -> FResult<Option<Validated>> {
        check_id("id", id)?;
        let file = self.displaced_dir()?.join(format!("{id}.lag"));
        match fs::read(&file) {
            Ok(b) => Ok(validate_bytes(&b).ok()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(FileErr::from_io(&e, &file)),
        }
    }

    /// Hard-link (else copy) `target` into displaced/; without a state folder
    /// (or when both fail) keep its bytes in memory.
    fn make_displaced(&self, target: &Path) -> FResult<Displaced> {
        let id = format!("x-{}", uuid::Uuid::new_v4());
        if let Ok(dir) = self.displaced_dir() {
            if fs::create_dir_all(&dir).is_ok() {
                let dest = dir.join(format!("{id}.lag"));
                if fs::hard_link(target, &dest).is_ok() || fs::copy(target, &dest).is_ok() {
                    return Ok(Displaced { id, file: Some(dest), bytes: None });
                }
                let _ = fs::remove_file(&dest);
            }
        }
        let bytes = fs::read(target).map_err(|e| FileErr::from_io(&e, target))?;
        Ok(Displaced { id, file: None, bytes: Some(bytes) })
    }

    fn keep_displaced(&self, d: Displaced, original: &Path, header: Option<FileHeader>, reason: &str) {
        let Ok(dir) = self.displaced_dir() else { return };
        let file = match (&d.file, &d.bytes) {
            (Some(f), _) => f.clone(),
            (None, Some(b)) => {
                let f = dir.join(format!("{}.lag", d.id));
                if atomic_write(&f, b).is_err() {
                    return;
                }
                f
            }
            _ => return,
        };
        let _ = file;
        let _g = lk(&self.displaced_lock);
        let idx_path = dir.join("index.json");
        let mut idx: DisplacedIndex = load_index(&idx_path);
        idx.v = 1;
        let (aid, head) = header.map(|h| (h.analysis_id, h.head)).unwrap_or_default();
        idx.entries.push(DisplacedEntry {
            id: d.id,
            original: path_str(original),
            analysis_id: aid,
            head,
            reason: reason.to_string(),
            at: wall_ms(),
        });
        if let Err(e) = save_index(&idx_path, &idx) {
            log::warn!("[graphfile] couldn't record a displaced copy: {}", e.message);
        }
    }
}

struct Displaced {
    id: String,
    file: Option<PathBuf>,
    bytes: Option<Vec<u8>>,
}

impl Displaced {
    fn read(&self) -> Option<Vec<u8>> {
        match (&self.file, &self.bytes) {
            (_, Some(b)) => Some(b.clone()),
            (Some(f), None) => fs::read(f).ok(),
            _ => None,
        }
    }
    fn drop_file(&self) {
        if let Some(f) = &self.file {
            let _ = fs::remove_file(f);
        }
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// Read (graphfile_read)
// ═════════════════════════════════════════════════════════════════════════════

pub fn read(ctx: &FileCtx, path: &Path) -> FResult<ReadReply> {
    let (v, st, bytes) = read_validated(path)?;
    ctx.set_record(path, &v, &st);
    ctx.journal_best_effort(&path_str(path), &v, &bytes, true);
    if let Some(dir) = path.parent() {
        cleanup_orphan_temps(dir);
    }
    Ok(ReadReply {
        read_only: v.too_new().then_some("tooNew"),
        manifest_text: v.manifest_text,
        parts: v.parts,
        stat: st,
    })
}

// ═════════════════════════════════════════════════════════════════════════════
// Folder listing, safe follow rule
// ═════════════════════════════════════════════════════════════════════════════

/// `.lag` files directly in `dir`: not hidden, regular (symlinks skipped).
/// `(path, stat)`; dataless ones included (callers decide).
pub fn list_lag_files(dir: &Path) -> FResult<Vec<(PathBuf, FileStat)>> {
    let rd = fs::read_dir(dir).map_err(|e| FileErr::from_io(&e, dir))?;
    let mut out = Vec::new();
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || !name_has_ext(&name, EXT) {
            continue;
        }
        let Ok(m) = fs::symlink_metadata(e.path()) else { continue };
        if !m.is_file() {
            continue;
        }
        out.push((e.path(), stat_of(&e.path(), &m)));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

/// Which file a path names on disk: (device, inode) on unix; None elsewhere or on error.
pub fn file_identity(p: &Path) -> Option<(u64, u64)> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        fs::metadata(p).ok().map(|m| (m.dev(), m.ino()))
    }
    #[cfg(not(unix))]
    {
        let _ = p;
        None
    }
}

/// Is `p` (an entry of a folder listing) the very file `path` names? Compares
/// identity, not spelling: on a case- or normalisation-insensitive volume
/// `data.lag` and `Data.lag` (or NFC / NFD names) are one file. `me` =
/// `file_identity(path)`. Off unix: a case-insensitive compare of the paths.
pub fn is_same_file(p: &Path, path: &Path, me: Option<(u64, u64)>) -> bool {
    if p == path {
        return true;
    }
    #[cfg(unix)]
    {
        me.is_some() && file_identity(p) == me
    }
    #[cfg(not(unix))]
    {
        let _ = me;
        p.to_string_lossy().to_lowercase() == path.to_string_lossy().to_lowercase()
    }
}

/// The spelling the folder listing has for the file `path` names, when it is
/// not `path` itself: a rename that only changed case (or Unicode
/// normalisation) leaves `stat(path)` working, so only the listing shows it.
/// None when the listing has `path` exactly, or the file isn't there.
pub fn on_disk_spelling(path: &Path) -> Option<PathBuf> {
    let dir = path.parent()?;
    let me = file_identity(path);
    #[cfg(unix)]
    if me.is_none() {
        return None;
    }
    let files = list_lag_files(dir).ok()?;
    if files.iter().any(|(p, _)| p == path) {
        return None;
    }
    let hits: Vec<PathBuf> = files.into_iter().map(|(p, _)| p).filter(|p| is_same_file(p, path, me)).collect();
    if hits.len() == 1 {
        hits.into_iter().next()
    } else {
        None
    }
}

// ── online-only files ──────────────────────────────────────────────────────

/// Paths whose download is being asked for (one background reader each).
static DOWNLOADS: Mutex<BTreeSet<PathBuf>> = Mutex::new(BTreeSet::new());

/// An open file is online-only: ask the system to download it. Reading an
/// online-only file is what makes macOS's file provider (Dropbox, iCloud
/// Drive, …) and Windows cloud files fetch it, so a background thread reads
/// it once (bounded) and drops the bytes; the next look or read sees a local
/// file. Never blocks the caller; one reader per path at a time.
pub fn request_download(path: &Path) {
    #[cfg(any(target_os = "macos", windows))]
    {
        let p = path.to_path_buf();
        if !lk(&DOWNLOADS).insert(p.clone()) {
            return;
        }
        let spawned = std::thread::Builder::new().name("graphfile-download".into()).spawn(move || {
            let r = fs::File::open(&p).and_then(|f| io::copy(&mut f.take(READ_LIMIT), &mut io::sink()));
            match r {
                Ok(n) => log::info!("[graphfile] download asked for {} ({n} bytes)", p.display()),
                Err(e) => log::warn!("[graphfile] couldn't download {}: {e}", p.display()),
            }
            lk(&DOWNLOADS).remove(&p);
        });
        if spawned.is_err() {
            lk(&DOWNLOADS).remove(path);
        }
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = path;
    }
}

pub struct Follow {
    /// The one safe successor (validated), if any.
    pub follow: Option<(PathBuf, Validated, FileStat)>,
    /// Every same-id file in the folder (sorted), for the chooser.
    pub same_id: Vec<PathBuf>,
}

/// The safe follow rule (contract §3.3): candidates are same-folder files with
/// the analysis id in their comment and not in `exclude`; follow only exactly
/// one that validates and whose head equals or descends from `base`.
pub fn follow_candidates(path: &Path, aid: &str, base: Option<&str>, exclude: &BTreeSet<PathBuf>) -> FResult<Follow> {
    let dir = path.parent().ok_or_else(|| FileErr::invalid("no folder"))?;
    let mut same_id = Vec::new();
    for (p, st) in list_lag_files(dir)? {
        if p == path || st.dataless {
            continue;
        }
        if let Ok((h, _)) = read_header(&p) {
            if h.analysis_id == aid {
                same_id.push(p);
            }
        }
    }
    let cands: Vec<&PathBuf> = same_id.iter().filter(|p| !exclude.contains(*p)).collect();
    let mut follow = None;
    if cands.len() == 1 {
        if let Ok((v, st, _)) = read_validated(cands[0]) {
            let descends = base.map(|b| is_ancestor_or_self(&v.manifest, b, &v.header.head)).unwrap_or(true);
            if v.header.analysis_id == aid && descends {
                follow = Some((cands[0].clone(), v, st));
            }
        }
    }
    Ok(Follow { follow, same_id })
}

// ═════════════════════════════════════════════════════════════════════════════
// Save (graphfile_save, contract §1.4)
// ═════════════════════════════════════════════════════════════════════════════

struct Prep {
    info: ManifestInfo,
}

enum PlanKind {
    New,
    /// keep: the replaced file's displaced copy is kept (Save As over a file).
    Replace { keep: bool },
    Aside,
}

struct Plan {
    kind: PlanKind,
    /// Stat the target had when it was checked (Replace).
    prev: Option<FileStat>,
    /// The validated target (when it was read for the check).
    replaced: Option<Validated>,
}

enum Check {
    Follow { to: PathBuf, head: String, stat: FileStat },
    Missing,
    Conflict(String),
    Retry,
    Write(Plan),
}

enum Outcome {
    Done(SaveReply),
    Restart,
}

/// Step 1 (arguments) and the session part of step 2 (identity).
fn prepare_save(ctx: &FileCtx, req: &SaveArgs, path: &Path) -> FResult<Prep> {
    if !path.is_absolute() {
        return Err(FileErr::invalid("the path isn't absolute"));
    }
    if !has_lag_ext(path) || path.file_name().is_none() {
        return Err(FileErr::invalid("the file name must end in .lag"));
    }
    let manifest: Value = serde_json::from_str(&req.manifest_text).map_err(|_| FileErr::invalid("the manifest isn't JSON"))?;
    if manifest.get("format").and_then(Value::as_str) != Some(FORMAT) {
        return Err(FileErr::invalid("the manifest isn't an analysis manifest"));
    }
    let info = check_manifest(&manifest, true).map_err(FileErr::invalid)?;
    if info.analysis_id != req.analysis_id {
        return Err(FileErr::invalid("the manifest belongs to another analysis"));
    }
    check_id("analysis id", &info.analysis_id)?;
    check_id("version id", &info.head)?;
    if let Some(eh) = &req.expected_head {
        check_id("expected version id", eh)?;
    }
    for (name, text) in &req.new_parts {
        let hex = part_hex(name).ok_or_else(|| FileErr::invalid(format!("bad part name {name}")))?;
        if sha256_hex(text.as_bytes()) != hex {
            return Err(FileErr::invalid(format!("part {name} doesn't match its name")));
        }
    }
    let parent = path.parent().ok_or_else(|| FileErr::invalid("no folder"))?;
    match fs::metadata(parent) {
        Ok(m) if m.is_dir() => {}
        Ok(_) => return Err(FileErr::new(ErrKind::NotFound, format!("{} is not a folder", parent.display()))),
        Err(e) => return Err(FileErr::from_io(&e, parent)),
    }
    // Identity: the stored session must not have this path open as another document.
    if let Some(state) = &ctx.state_dir {
        if let Some(s) = read_json_file(&state.join("graph-session.json")) {
            let clash = s.get("tabs").and_then(Value::as_array).map(|tabs| {
                tabs.iter().any(|t| {
                    t.get("path").and_then(Value::as_str) == Some(req.path.as_str())
                        && t.get("doc_key").and_then(Value::as_str).map(|k| k != req.doc_key).unwrap_or(false)
                })
            });
            if clash == Some(true) {
                let found = read_header(path).ok().map(|(h, _)| h.analysis_id);
                return Err(FileErr::identity(found.as_deref()));
            }
        }
    }
    Ok(Prep { info })
}

/// Validate a file, retrying `Incomplete` for `tuning.incomplete_retry`.
fn validate_with_retry(ctx: &FileCtx, p: &Path) -> FResult<(Validated, FileStat, Vec<u8>)> {
    let start = Instant::now();
    loop {
        match read_validated(p) {
            Err(e) if e.kind == ErrKind::Incomplete && start.elapsed() < ctx.tuning.incomplete_retry => {
                std::thread::sleep(ctx.tuning.retry_step);
            }
            other => return other,
        }
    }
}

/// Step 3: what is at the target, and what to do.
fn check_target(ctx: &FileCtx, req: &SaveArgs, target: &Path, followed: bool) -> FResult<Check> {
    let st = match stat_path(target) {
        Ok(s) => Some(s),
        Err(e) if e.kind == ErrKind::NotFound => None,
        Err(e) => return Err(e),
    };
    let aid = req.analysis_id.as_str();
    match (st, req.expected_head.as_deref()) {
        (None, None) => Ok(Check::Write(Plan { kind: PlanKind::New, prev: None, replaced: None })),
        (None, Some(eh)) => {
            if followed {
                return Ok(Check::Missing);
            }
            let exclude = crate::graphwatch::copy_table_of(ctx, target);
            let f = follow_candidates(target, aid, Some(eh), &exclude).unwrap_or(Follow { follow: None, same_id: vec![] });
            Ok(match f.follow {
                Some((to, v, st)) => Check::Follow { to, head: v.header.head, stat: st },
                None => Check::Missing,
            })
        }
        (Some(s), None) => {
            if s.dataless {
                request_download(target);
                if !req.replace_existing {
                    return Err(FileErr::dataless(target));
                }
                return Ok(Check::Write(Plan { kind: PlanKind::Replace { keep: true }, prev: Some(s), replaced: None }));
            }
            match read_validated(target) {
                Ok((v, vst, _)) => {
                    if !req.replace_existing {
                        if v.header.analysis_id != aid {
                            return Err(FileErr::identity(Some(&v.header.analysis_id)));
                        }
                        return Ok(Check::Conflict(v.header.head));
                    }
                    Ok(Check::Write(Plan { kind: PlanKind::Replace { keep: true }, prev: Some(vst), replaced: Some(v) }))
                }
                Err(e) if e.kind == ErrKind::PermissionDenied => Err(e),
                Err(e) if e.kind == ErrKind::NotFound => Ok(Check::Retry),
                Err(_) if req.replace_existing => {
                    Ok(Check::Write(Plan { kind: PlanKind::Replace { keep: true }, prev: Some(s), replaced: None }))
                }
                Err(_) => Err(FileErr::invalid("a file that is not an analysis is in the way")),
            }
        }
        (Some(s), Some(eh)) => {
            if s.dataless {
                request_download(target);
                return Ok(Check::Write(Plan { kind: PlanKind::Aside, prev: Some(s), replaced: None }));
            }
            if let Some(rec) = ctx.record(target) {
                if rec.size == s.size && rec.mtime == s.mtime {
                    if rec.analysis_id != aid {
                        return Err(FileErr::identity(Some(&rec.analysis_id)));
                    }
                    if rec.too_new {
                        return Err(FileErr::too_new(READER_VERSION + 1));
                    }
                    if rec.head != eh {
                        return Ok(Check::Conflict(rec.head));
                    }
                    return Ok(Check::Write(Plan { kind: PlanKind::Replace { keep: false }, prev: Some(s), replaced: None }));
                }
            }
            match validate_with_retry(ctx, target) {
                Ok((v, vst, _)) => {
                    ctx.set_record(target, &v, &vst);
                    if v.header.analysis_id != aid {
                        return Err(FileErr::identity(Some(&v.header.analysis_id)));
                    }
                    if v.too_new() {
                        return Err(FileErr::too_new(v.min_reader_version));
                    }
                    if v.header.head != eh {
                        return Ok(Check::Conflict(v.header.head));
                    }
                    Ok(Check::Write(Plan { kind: PlanKind::Replace { keep: false }, prev: Some(vst), replaced: Some(v) }))
                }
                Err(e) if e.kind == ErrKind::PermissionDenied => Err(e),
                Err(e) if e.kind == ErrKind::NotFound => Ok(Check::Retry),
                Err(_) => Ok(Check::Write(Plan { kind: PlanKind::Aside, prev: Some(s), replaced: None })),
            }
        }
    }
}

/// Step 5: every part a revision with sections references, from (in order)
/// the request, the replaced file, the journal copy of the expected head,
/// the target read now, and other journal copies of this analysis.
fn assemble(
    ctx: &FileCtx,
    prep: &Prep,
    req: &SaveArgs,
    replaced: Option<&Validated>,
    lazy_target: Option<&Path>,
) -> FResult<BTreeMap<String, String>> {
    let aid = &prep.info.analysis_id;
    let mut journal_copy: Option<Option<Validated>> = None;
    let mut target_copy: Option<Option<Validated>> = None;
    let mut others: Option<Vec<Validated>> = None;
    let mut out = BTreeMap::new();
    for (name, r) in &prep.info.all_refs {
        let mut text = req.new_parts.get(name).cloned();
        if text.is_none() {
            text = replaced.and_then(|v| v.parts.get(name).cloned());
        }
        if text.is_none() {
            let jc = journal_copy.get_or_insert_with(|| {
                req.expected_head.as_deref().and_then(|eh| ctx.read_journal(aid, eh).ok().flatten())
            });
            text = jc.as_ref().and_then(|v| v.parts.get(name).cloned());
        }
        if text.is_none() {
            if let Some(t) = lazy_target {
                let tc = target_copy.get_or_insert_with(|| read_validated(t).ok().map(|x| x.0));
                text = tc.as_ref().and_then(|v| v.parts.get(name).cloned());
            }
        }
        if text.is_none() {
            let os = others.get_or_insert_with(|| {
                let mut heads = ctx.journal_heads(aid, None).unwrap_or_default();
                heads.reverse();
                let mut seen = HashSet::new();
                heads
                    .into_iter()
                    .filter(|h| seen.insert(h.revision_id.clone()))
                    .take(20)
                    .filter_map(|h| ctx.read_journal(aid, &h.revision_id).ok().flatten())
                    .collect()
            });
            text = os.iter().find_map(|v| v.parts.get(name).cloned());
        }
        let text = text.ok_or_else(|| FileErr::invalid(format!("part missing: {name}")))?;
        if text.len() as u64 != r.bytes {
            return Err(FileErr::invalid(format!("part {name} has another size than the manifest says")));
        }
        out.insert(name.clone(), text);
    }
    Ok(out)
}

fn build_for(prep: &Prep, req: &SaveArgs, parts: &BTreeMap<String, String>) -> FResult<Vec<u8>> {
    // Never write a file that a read would refuse (§1.3 step 9).
    let unpacked = MIME.len() as u64 + req.manifest_text.len() as u64 + parts.values().map(|t| t.len() as u64).sum::<u64>();
    if unpacked > INFLATE_LIMIT {
        return Err(FileErr::invalid("the analysis is too large to save (over 256 MB unpacked)"));
    }
    let bytes = build_container(&req.manifest_text, &prep.info.analysis_id, &prep.info.head, parts)?;
    if bytes.len() as u64 > READ_LIMIT {
        return Err(FileErr::invalid("the analysis is too large to save (over 64 MB)"));
    }
    Ok(bytes)
}

/// Write `bytes` to a temp file beside `target` (fsynced).
fn write_temp(target: &Path, bytes: &[u8]) -> FResult<PathBuf> {
    let tmp = temp_name_for(target);
    if let Err(e) = write_synced(&tmp, bytes) {
        let _ = fs::remove_file(&tmp);
        return Err(FileErr::from_io(&e, &tmp));
    }
    Ok(tmp)
}

/// Step 9: re-open and validate; record, journal, tell the poll.
fn verify_saved(ctx: &FileCtx, prep: &Prep, target: &Path, seen_as: &Path) -> FResult<(Validated, FileStat)> {
    let (v, st, bytes) =
        read_validated(target).map_err(|e| FileErr::io(format!("the saved file couldn't be checked: {}", e.message)))?;
    if v.header.analysis_id != prep.info.analysis_id || v.header.head != prep.info.head {
        return Err(FileErr::io("the file changed right after it was saved"));
    }
    ctx.set_record(target, &v, &st);
    ctx.journal_best_effort(&path_str(seen_as), &v, &bytes, true);
    Ok((v, st))
}

fn device_name(ctx: &FileCtx) -> String {
    crate::appstate::device(ctx).map(|d| d.device_name).unwrap_or_default()
}

/// `<stem> (unsynced from <device>).lag`, made free with ` 2`, ` 3`, …
pub fn aside_name(target: &Path, device: &str, n: u32) -> PathBuf {
    let stem = target.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let mut dev: String = device.chars().filter(|c| c.is_alphanumeric() || *c == ' ' || *c == '-').collect();
    dev = dev.split_whitespace().collect::<Vec<_>>().join(" ");
    if dev.is_empty() {
        dev = "this computer".into();
    }
    let suffix = if n <= 1 { String::new() } else { format!(" {n}") };
    target.with_file_name(format!("{stem} (unsynced from {dev}){suffix}.{EXT}"))
}

/// An aside copy this app wrote earlier for `target` (it is in the track's copy
/// table with the head it was written with, and nobody changed it since): a
/// repeated save while the file still can't be checked replaces it instead of
/// adding " 2", " 3", … (the earlier one is in the journal).
fn own_aside(ctx: &FileCtx, target: &Path, cand: &Path, aid: &str) -> bool {
    let Some(head) = crate::graphwatch::copy_head(ctx, target, cand) else { return false };
    matches!(read_header(cand), Ok((h, st)) if !st.dataless && h.analysis_id == aid && h.head == head)
}

/// The save was given up (the command timed out): nothing more may be written.
fn check_cancel(cancel: &AtomicBool) -> FResult<()> {
    if cancel.load(Ordering::SeqCst) {
        Err(FileErr::new(ErrKind::OfflineOrTimeout, "the save took too long and was stopped; nothing was written"))
    } else {
        Ok(())
    }
}

fn write_aside(ctx: &FileCtx, prep: &Prep, req: &SaveArgs, target: &Path, cancel: &AtomicBool) -> FResult<Outcome> {
    let parts = assemble(ctx, prep, req, None, None)?;
    let bytes = build_for(prep, req, &parts)?;
    let dev = device_name(ctx);
    let tmp = write_temp(target, &bytes)?;
    if let Err(e) = check_cancel(cancel) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    let mut placed = None;
    for n in 1..=200 {
        let cand = aside_name(target, &dev, n);
        if fs::symlink_metadata(&cand).is_ok() {
            if own_aside(ctx, target, &cand, &prep.info.analysis_id) {
                if let Err(e) = rename_replace(&tmp, &cand) {
                    let _ = fs::remove_file(&tmp);
                    return Err(e);
                }
                placed = Some(cand);
                break;
            }
            continue;
        }
        match rename_no_replace(&tmp, &cand) {
            Ok(()) => {
                placed = Some(cand);
                break;
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => {
                let _ = fs::remove_file(&tmp);
                return Err(FileErr::from_io(&e, &cand));
            }
        }
    }
    let Some(aside) = placed else {
        let _ = fs::remove_file(&tmp);
        return Err(FileErr::io("no free name for the copy"));
    };
    let (v, st) = verify_saved(ctx, prep, &aside, &aside)?;
    crate::graphwatch::add_copy(ctx, target, &aside, &v.header.head);
    Ok(Outcome::Done(SaveReply::SavedAside { path: path_str(&aside), head: v.header.head, stat: st }))
}

fn write_and_replace(
    ctx: &FileCtx,
    prep: &Prep,
    req: &SaveArgs,
    target: &Path,
    plan: Plan,
    attempt: u32,
    cancel: &AtomicBool,
) -> FResult<Outcome> {
    let lazy = matches!(plan.kind, PlanKind::Replace { keep: false }).then_some(target);
    match plan.kind {
        PlanKind::Aside => write_aside(ctx, prep, req, target, cancel),
        PlanKind::New => {
            let parts = assemble(ctx, prep, req, plan.replaced.as_ref(), lazy)?;
            let bytes = build_for(prep, req, &parts)?;
            let tmp = write_temp(target, &bytes)?;
            let res = ctx
                .run_hook(HookPoint::BeforeRename, target)
                .and_then(|_| check_cancel(cancel))
                .and_then(|_| match rename_no_replace(&tmp, target) {
                Ok(()) => Ok(true),
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Ok(false),
                Err(e) => Err(FileErr::from_io(&e, target)),
            });
            match res {
                Ok(true) => {}
                Ok(false) => {
                    let _ = fs::remove_file(&tmp);
                    return Ok(Outcome::Restart);
                }
                Err(e) => {
                    let _ = fs::remove_file(&tmp);
                    return Err(e);
                }
            }
            let (v, st) = verify_saved(ctx, prep, target, target)?;
            crate::graphwatch::note_saved(ctx, target, &v.header.analysis_id, &v.header.head, &st);
            Ok(Outcome::Done(SaveReply::Saved { path: path_str(target), head: v.header.head, stat: st }))
        }
        PlanKind::Replace { keep } => {
            let parts = assemble(ctx, prep, req, plan.replaced.as_ref(), lazy)?;
            let bytes = build_for(prep, req, &parts)?;
            let tmp = write_temp(target, &bytes)?;
            let cleanup = |d: Option<&Displaced>| {
                let _ = fs::remove_file(&tmp);
                if let Some(d) = d {
                    d.drop_file();
                }
            };
            if let Err(e) = ctx.run_hook(HookPoint::BeforeDisplace, target).and_then(|_| check_cancel(cancel)) {
                cleanup(None);
                return Err(e);
            }
            let d = match ctx.make_displaced(target) {
                Ok(d) => d,
                Err(e) if e.kind == ErrKind::NotFound => {
                    cleanup(None);
                    return Ok(Outcome::Restart);
                }
                Err(e) => {
                    cleanup(None);
                    return Err(e);
                }
            };
            let now = match stat_path(target) {
                Ok(s) => s,
                Err(e) => {
                    cleanup(Some(&d));
                    return if e.kind == ErrKind::NotFound { Ok(Outcome::Restart) } else { Err(e) };
                }
            };
            let moved = plan.prev.as_ref().map(|p| p.size != now.size || p.mtime != now.mtime).unwrap_or(false);
            if moved && attempt == 0 {
                cleanup(Some(&d));
                return Ok(Outcome::Restart);
            }
            if let Err(e) = ctx
                .run_hook(HookPoint::BeforeRename, target)
                .and_then(|_| check_cancel(cancel))
                .and_then(|_| rename_replace(&tmp, target))
            {
                cleanup(Some(&d));
                return Err(e);
            }
            // Step 8: what was replaced.
            let dbytes = d.read();
            let dv = dbytes.as_deref().and_then(|b| validate_bytes(b).ok());
            let mut displaced_head = None;
            if keep {
                let header = dv.as_ref().map(|v| v.header.clone()).or_else(|| {
                    dbytes.as_deref().and_then(|b| eocd_comment(b)).and_then(parse_comment)
                });
                ctx.keep_displaced(d, target, header, "replaced");
            } else {
                match dv {
                    Some(v) if v.header.analysis_id == prep.info.analysis_id => {
                        let eh = req.expected_head.as_deref().unwrap_or("");
                        if v.header.head != eh || !ctx.has_journal_copy(&v.header.analysis_id, &v.header.head) {
                            ctx.journal_best_effort(&path_str(target), &v, dbytes.as_deref().unwrap_or(&[]), true);
                        }
                        if v.header.head != eh {
                            displaced_head = Some(v.header.head.clone());
                        }
                        d.drop_file();
                    }
                    other => {
                        let header = other.map(|v| v.header).or_else(|| {
                            dbytes.as_deref().and_then(|b| eocd_comment(b)).and_then(parse_comment)
                        });
                        ctx.keep_displaced(d, target, header, "replaced");
                    }
                }
            }
            let (v, st) = verify_saved(ctx, prep, target, target)?;
            crate::graphwatch::note_saved(ctx, target, &v.header.analysis_id, &v.header.head, &st);
            let path = path_str(target);
            let head = v.header.head;
            Ok(Outcome::Done(match displaced_head {
                Some(dh) => SaveReply::SavedButDisplaced { path, head, stat: st, displaced_head: dh },
                None => SaveReply::Saved { path, head, stat: st },
            }))
        }
    }
}

/// `graphfile_save` (contract §1.4).
#[allow(dead_code)] // tests (and tools) call it without a sequence / cancel flag
pub fn save(ctx: &FileCtx, req: &SaveArgs) -> FResult<SaveReply> {
    save_cancellable(ctx, req, &AtomicBool::new(false))
}

/// `save` that stops before anything is written once `cancel` is set (the
/// command gave up waiting: the frontend was told the save failed, so a late
/// write would be a save nobody knows about). Checked after the path lock is
/// taken and right before the rename.
pub fn save_cancellable(ctx: &FileCtx, req: &SaveArgs, cancel: &AtomicBool) -> FResult<SaveReply> {
    let path = PathBuf::from(&req.path);
    let prep = prepare_save(ctx, req, &path)?;
    let mut guards = vec![ctx.locks.lock(&path)];
    check_cancel(cancel)?;
    let mut target = path.clone();
    let mut followed = false;
    let mut restarts = 0u32;
    // Renamed by case only (or a Unicode-normalisation variant): the file is
    // still found by its old spelling; save under the spelling it has now.
    if let Some(sp) = on_disk_spelling(&target) {
        if let Ok((h, st)) = read_header(&sp) {
            if h.analysis_id == req.analysis_id {
                crate::graphwatch::rekey(ctx, &target, &sp, &h.head, &st);
                ctx.emit(EVT_FILE, json!({ "type": "moved", "from": path_str(&target), "to": path_str(&sp), "head": h.head }));
                guards.push(ctx.locks.lock(&sp));
                target = sp;
            }
        }
    }
    loop {
        if restarts > 2 {
            return Err(FileErr::io("the file kept changing while saving"));
        }
        match check_target(ctx, req, &target, followed)? {
            Check::Missing => return Ok(SaveReply::Missing),
            Check::Conflict(head) => return Ok(SaveReply::Conflict { head }),
            Check::Retry => restarts += 1,
            Check::Follow { to, head, stat } => {
                crate::graphwatch::rekey(ctx, &target, &to, &head, &stat);
                ctx.emit(EVT_FILE, json!({ "type": "moved", "from": path_str(&target), "to": path_str(&to), "head": head }));
                guards.push(ctx.locks.lock(&to));
                target = to;
                followed = true;
            }
            Check::Write(plan) => match write_and_replace(ctx, &prep, req, &target, plan, restarts, cancel)? {
                Outcome::Done(r) => return Ok(r),
                Outcome::Restart => restarts += 1,
            },
        }
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// Scan and Find it…
// ═════════════════════════════════════════════════════════════════════════════

/// `graphfile_scan_dir` (contract §1.7).
pub fn scan_dir(dir: &Path) -> FResult<Vec<DirEntry>> {
    match fs::metadata(dir) {
        Ok(m) if m.is_dir() => {}
        Ok(_) => return Err(FileErr::new(ErrKind::NotFound, format!("{} is not a folder", dir.display()))),
        Err(e) => return Err(FileErr::from_io(&e, dir)),
    }
    let rd = fs::read_dir(dir).map_err(|e| FileErr::from_io(&e, dir))?;
    let mut out = Vec::new();
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let kind = if name_has_ext(&name, EXT) {
            "graph"
        } else if name_has_ext(&name, PRESENCE_EXT) {
            "presence"
        } else {
            continue;
        };
        let Ok(m) = fs::symlink_metadata(e.path()) else { continue };
        if !m.is_file() {
            continue;
        }
        let st = stat_of(&e.path(), &m);
        let header = if kind == "graph" && !st.dataless { read_header(&e.path()).ok().map(|x| x.0) } else { None };
        out.push(DirEntry { name, path: st.path, size: st.size, mtime: st.mtime, kind, dataless: st.dataless, header });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocateMatch {
    pub path: String,
    pub head: String,
    pub stat: FileStat,
    pub user_name: String,
    pub device_name: String,
    pub time: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocateReply {
    pub matches: Vec<LocateMatch>,
    pub online_only: Vec<String>,
    pub online_only_count: u64,
    pub skipped_folders: Vec<String>,
    pub truncated: Option<&'static str>,
    pub scanned: u64,
}

#[derive(Debug, Clone, Copy)]
pub struct LocateLimits {
    pub depth: usize,
    pub entries: u64,
    pub time_ms: u64,
}

impl Default for LocateLimits {
    fn default() -> Self {
        LocateLimits { depth: 8, entries: 50_000, time_ms: 20_000 }
    }
}

const BUNDLE_EXTS: [&str; 10] =
    ["app", "bundle", "framework", "plugin", "kext", "pkg", "photoslibrary", "musiclibrary", "xcodeproj", "lproj"];

fn is_bundle(name: &str) -> bool {
    BUNDLE_EXTS.iter().any(|e| name_has_ext(name, e))
}

/// Find it… (contract §3.4). `now_ms` is a clock in ms (injected by tests);
/// `progress(scanned, matches)` is called about every 250 ms.
pub fn locate(
    dir: &Path,
    aid: &str,
    cancel: &AtomicBool,
    limits: LocateLimits,
    now_ms: &dyn Fn() -> u64,
    progress: &mut dyn FnMut(u64, usize),
) -> FResult<LocateReply> {
    match fs::metadata(dir) {
        Ok(m) if m.is_dir() => {}
        Ok(_) => return Err(FileErr::new(ErrKind::NotFound, format!("{} is not a folder", dir.display()))),
        Err(e) => return Err(FileErr::from_io(&e, dir)),
    }
    let start = now_ms();
    let mut last_progress = start;
    let mut reply = LocateReply {
        matches: vec![],
        online_only: vec![],
        online_only_count: 0,
        skipped_folders: vec![],
        truncated: None,
        scanned: 0,
    };
    let cancelled = || FileErr::new(ErrKind::Cancelled, "the search was stopped");
    let mut queue: VecDeque<(PathBuf, usize)> = VecDeque::from([(dir.to_path_buf(), 0)]);
    'walk: while let Some((d, depth)) = queue.pop_front() {
        if cancel.load(Ordering::SeqCst) {
            return Err(cancelled());
        }
        if now_ms().saturating_sub(start) >= limits.time_ms {
            reply.truncated = Some("time");
            break;
        }
        let rd = match fs::read_dir(&d) {
            Ok(rd) => rd,
            Err(e) => {
                if d == dir {
                    return Err(FileErr::from_io(&e, &d));
                }
                if io_kind(&e, &d) == ErrKind::PermissionDenied && reply.skipped_folders.len() < 20 {
                    reply.skipped_folders.push(path_str(&d));
                }
                continue;
            }
        };
        for e in rd {
            let Ok(e) = e else { continue };
            if reply.scanned >= limits.entries {
                reply.truncated = Some("entries");
                break 'walk;
            }
            reply.scanned += 1;
            if reply.scanned % 64 == 0 {
                if cancel.load(Ordering::SeqCst) {
                    return Err(cancelled());
                }
                let now = now_ms();
                if now.saturating_sub(start) >= limits.time_ms {
                    reply.truncated = Some("time");
                    break 'walk;
                }
                if now.saturating_sub(last_progress) >= 250 {
                    last_progress = now;
                    progress(reply.scanned, reply.matches.len());
                }
            }
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                if name == "node_modules" || is_bundle(&name) {
                    continue;
                }
                if depth + 1 > limits.depth {
                    if reply.truncated.is_none() {
                        reply.truncated = Some("depth");
                    }
                    continue;
                }
                queue.push_back((e.path(), depth + 1));
            } else if ft.is_file() && name_has_ext(&name, EXT) {
                let p = e.path();
                let Ok(m) = fs::symlink_metadata(&p) else { continue };
                if is_dataless(&m) {
                    reply.online_only_count += 1;
                    if reply.online_only.len() < 50 {
                        reply.online_only.push(path_str(&p));
                    }
                    continue;
                }
                let Ok((h, _)) = read_header(&p) else { continue };
                if h.analysis_id != aid {
                    continue;
                }
                if let Ok((v, st, _)) = read_validated(&p) {
                    if v.header.analysis_id == aid {
                        reply.matches.push(LocateMatch {
                            path: path_str(&p),
                            head: v.header.head.clone(),
                            stat: st,
                            user_name: v.head_field("user_name"),
                            device_name: v.head_field("device_name"),
                            time: v.head_field("time"),
                        });
                    }
                }
            }
        }
    }
    // A "time" or "entries" stop outranks "depth".
    reply.matches.sort_by(|a, b| b.stat.mtime.cmp(&a.stat.mtime).then(a.path.cmp(&b.path)));
    progress(reply.scanned, reply.matches.len());
    Ok(reply)
}

impl FileCtx {
    fn locate_flag(&self, token: &str) -> Arc<AtomicBool> {
        lk(&self.locates).entry(token.to_string()).or_insert_with(|| Arc::new(AtomicBool::new(false))).clone()
    }
    pub fn cancel_locate(&self, token: &str) {
        self.locate_flag(token).store(true, Ordering::SeqCst);
    }
    fn end_locate(&self, token: &str) {
        lk(&self.locates).remove(token);
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// Phase 2: peek and remove an extra copy (phase2-contract.md §4.1, §4.2)
// ═════════════════════════════════════════════════════════════════════════════

/// How long displaced copies (replaced files, removed extra copies) are kept
/// (`LIMITS_P2.removedKeepMs`); applied by the startup pruning.
pub const DISPLACED_KEEP_MS: i64 = 30 * 24 * 3600 * 1000;

/// `PeekReply` of contract.ts.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PeekReply {
    pub manifest_text: String,
    pub stat: FileStat,
    pub read_only: Option<&'static str>,
}

/// `graphfile_peek`: the full validation of a read (same errors), returning
/// the manifest only. No journal entry, no validation record, no track is
/// touched and an online-only file is not asked for.
pub fn peek(path: &Path) -> FResult<PeekReply> {
    let (v, st, _) = read_validated_quiet(path)?;
    Ok(PeekReply { read_only: v.too_new().then_some("tooNew"), manifest_text: v.manifest_text, stat: st })
}

/// `RemoveCopyArgs` of contract.ts.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveCopyArgs {
    pub path: String,
    pub keeper: String,
    pub analysis_id: String,
}

/// `RemoveCopyReply` of contract.ts.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RemoveCopyReply {
    Removed {
        #[serde(rename = "displacedId")]
        displaced_id: String,
        head: String,
    },
    Refused {
        /// "notOlder" | "otherAnalysis" | "sameFile" | "open"
        reason: &'static str,
        head: Option<String>,
        #[serde(rename = "keeperHead")]
        keeper_head: Option<String>,
    },
}

fn refused(reason: &'static str, head: Option<&str>, keeper_head: Option<&str>) -> RemoveCopyReply {
    RemoveCopyReply::Refused { reason, head: head.map(str::to_string), keeper_head: keeper_head.map(str::to_string) }
}

/// The path locks of two files, taken in sorted path order. The second is
/// only tried (and everything released and retried when it is held), so a
/// save that holds one of them and waits for the other can't deadlock with us.
fn lock_both<'a>(ctx: &'a FileCtx, a: &Path, b: &Path) -> FResult<(PathGuard<'a>, Option<PathGuard<'a>>)> {
    let (first, second) = if a <= b { (a, b) } else { (b, a) };
    if first == second {
        return Ok((ctx.locks.lock(first), None));
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let g1 = ctx.locks.lock(first);
        if let Some(g2) = ctx.locks.try_lock(second) {
            return Ok((g1, Some(g2)));
        }
        drop(g1);
        if Instant::now() >= deadline {
            return Err(FileErr::io("the file is busy, try again in a moment"));
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// Is `copy` a tracked (open) file? By path, or by identity (another spelling
/// of a tracked file) unless that file is the keeper itself (then it is the
/// `sameFile` case).
fn is_tracked(ctx: &FileCtx, copy: &Path, keeper: &Path) -> bool {
    let tracked: Vec<PathBuf> = lk(&ctx.watch).tracks.keys().cloned().collect();
    if tracked.iter().any(|t| t == copy) {
        return true;
    }
    let me = file_identity(copy);
    let keeper_id = file_identity(keeper);
    tracked.iter().any(|t| is_same_file(t, copy, me) && !is_same_file(t, keeper, keeper_id))
}

fn is_cross_device(e: &io::Error) -> bool {
    #[cfg(unix)]
    {
        e.raw_os_error() == Some(libc::EXDEV)
    }
    #[cfg(windows)]
    {
        e.raw_os_error() == Some(17) // ERROR_NOT_SAME_DEVICE
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = e;
        false
    }
}

fn same_stat(a: &FileStat, b: &FileStat) -> bool {
    a.size == b.size && a.mtime == b.mtime && !b.dataless
}

/// What was read and judged in one round of `remove_copy`.
struct Judged {
    bytes: Vec<u8>,
    stat: FileStat,
    identity: Option<(u64, u64)>,
    sha256: String,
    analysis_id: String,
    head: String,
}

impl FileCtx {
    fn add_displaced(&self, e: &DisplacedEntry) -> FResult<()> {
        let dir = self.displaced_dir()?;
        fs::create_dir_all(&dir).map_err(|err| FileErr::from_io(&err, &dir))?;
        let _g = lk(&self.displaced_lock);
        let idx_path = dir.join("index.json");
        let mut idx: DisplacedIndex = load_index(&idx_path);
        idx.v = 1;
        idx.entries.push(e.clone());
        save_index(&idx_path, &idx)
    }

    /// Change (`Some`) or drop (`None`) the head of a displaced entry.
    fn amend_displaced(&self, id: &str, head: Option<String>) {
        let Ok(dir) = self.displaced_dir() else { return };
        let _g = lk(&self.displaced_lock);
        let idx_path = dir.join("index.json");
        let mut idx: DisplacedIndex = load_index(&idx_path);
        match head {
            Some(h) => idx.entries.iter_mut().filter(|e| e.id == id).for_each(|e| e.head = h.clone()),
            None => idx.entries.retain(|e| e.id != id),
        }
        idx.v = 1;
        if let Err(e) = save_index(&idx_path, &idx) {
            log::warn!("[graphfile] couldn't update the record of removed copies: {}", e.message);
        }
    }
}

/// Step 8: move `from` to `dest`. rename; across volumes write the bytes that
/// were judged, check them and only then remove the original. Ok(true) = moved
/// as judged. Ok(false) = the file changed in the last instant and couldn't be
/// put back: it stays in `dest` (nothing is lost) and the caller fixes the
/// record. Err = nothing moved.
fn move_copy(ctx: &FileCtx, from: &Path, dest: &Path, j: &Judged) -> FResult<bool> {
    let force_copy = lk(&ctx.hooks).force_copy_move;
    if !force_copy {
        match fs::rename(from, dest) {
            Ok(()) => {
                // The rename moved whatever was there: make sure it is what was judged.
                let same = fs::read(dest).map(|b| sha256_hex(&b) == j.sha256).unwrap_or(false);
                if same {
                    return Ok(true);
                }
                if rename_no_replace(dest, from).is_ok() {
                    return Err(FileErr::incomplete("changing"));
                }
                return Ok(false);
            }
            Err(e) if !is_cross_device(&e) => return Err(FileErr::from_io(&e, from)),
            Err(_) => {}
        }
    }
    atomic_write(dest, &j.bytes).map_err(|e| FileErr::from_io(&e, dest))?;
    let kept = fs::read(dest).map(|b| sha256_hex(&b) == j.sha256).unwrap_or(false);
    if !kept {
        let _ = fs::remove_file(dest);
        return Err(FileErr::io("the copy couldn't be kept safely, so it wasn't removed"));
    }
    let unchanged = stat_path(from).map(|s| same_stat(&j.stat, &s)).unwrap_or(false) && file_identity(from) == j.identity;
    if !unchanged {
        let _ = fs::remove_file(dest);
        return Err(FileErr::incomplete("changing"));
    }
    if let Err(e) = fs::remove_file(from) {
        let _ = fs::remove_file(dest);
        return Err(FileErr::from_io(&e, from));
    }
    Ok(true)
}

/// `graphfile_remove_copy` (phase2-contract.md §4.2): move an extra copy into
/// `<state>/displaced/` when its head is the keeper's head or an ancestor of
/// it in the keeper's history, both files re-read right now. Never deletes.
#[cfg_attr(not(test), allow(dead_code))]
pub fn remove_copy(ctx: &FileCtx, req: &RemoveCopyArgs) -> FResult<RemoveCopyReply> {
    remove_copy_cancellable(ctx, req, &AtomicBool::new(false))
}

/// `remove_copy` that moves nothing once `cancel` is set (the command gave up
/// waiting and told the frontend it failed).
pub fn remove_copy_cancellable(ctx: &FileCtx, req: &RemoveCopyArgs, cancel: &AtomicBool) -> FResult<RemoveCopyReply> {
    let copy = PathBuf::from(&req.path);
    let keeper = PathBuf::from(&req.keeper);
    // 1. arguments, state folder
    for p in [&copy, &keeper] {
        if !p.is_absolute() {
            return Err(FileErr::invalid("the path isn't absolute"));
        }
        if !has_lag_ext(p) || p.file_name().is_none() {
            return Err(FileErr::invalid("the file name must end in .lag"));
        }
    }
    let ddir = ctx.displaced_dir()?;
    let _guards = lock_both(ctx, &copy, &keeper)?;
    check_cancel(cancel)?;
    // 2. an open file is never removed
    if is_tracked(ctx, &copy, &keeper) {
        return Ok(refused("open", None, None));
    }
    if fs::symlink_metadata(&copy).map(|m| m.file_type().is_symlink()).unwrap_or(false) {
        return Err(FileErr::invalid("the copy is a link, not a file"));
    }
    let mut round = 0;
    let judged = loop {
        round += 1;
        // 3. re-read both now (nothing moved on any error)
        let (kv, _, _) = read_validated_quiet(&keeper)?;
        let (cv, cst, cbytes) = read_validated_quiet(&copy)?;
        let identity = file_identity(&copy);
        let (ch, kh) = (cv.header.head.as_str(), kv.header.head.as_str());
        // 4. one file under two names
        if is_same_file(&copy, &keeper, file_identity(&keeper)) {
            return Ok(refused("sameFile", Some(ch), Some(kh)));
        }
        // 5. both are this analysis
        if cv.header.analysis_id != req.analysis_id || kv.header.analysis_id != req.analysis_id {
            return Ok(refused("otherAnalysis", Some(ch), Some(kh)));
        }
        // 6. the copy has nothing the keeper lacks
        if !is_ancestor_or_self(&kv.manifest, ch, kh) {
            return Ok(refused("notOlder", Some(ch), Some(kh)));
        }
        ctx.run_hook(HookPoint::BeforeRemoveMove, &copy)?;
        // 7. unchanged since it was read?
        let now = stat_path(&copy)?;
        if same_stat(&cst, &now) && file_identity(&copy) == identity {
            break Judged {
                sha256: cv.sha256.clone(),
                analysis_id: cv.header.analysis_id.clone(),
                head: cv.header.head.clone(),
                bytes: cbytes,
                stat: cst,
                identity,
            };
        }
        if round >= 2 {
            return Err(FileErr::incomplete("changing"));
        }
    };
    check_cancel(cancel)?;
    // 8. move into displaced/ (the record first: a crash leaves a record of a
    // missing file, never a file nobody can find)
    let id = format!("x-{}", uuid::Uuid::new_v4());
    let dest = ddir.join(format!("{id}.lag"));
    ctx.add_displaced(&DisplacedEntry {
        id: id.clone(),
        original: req.path.clone(),
        analysis_id: judged.analysis_id.clone(),
        head: judged.head.clone(),
        reason: "removedCopy".into(),
        at: wall_ms(),
    })?;
    match move_copy(ctx, &copy, &dest, &judged) {
        Ok(true) => {}
        Ok(false) => {
            // Kept in displaced/ as it is now; record what it really holds.
            let head = fs::read(&dest).ok().and_then(|b| validate_bytes(&b).ok()).map(|v| v.header.head);
            ctx.amend_displaced(&id, Some(head.unwrap_or_default()));
            crate::graphwatch::forget_copy(ctx, &copy);
            lk(&ctx.records).remove(&copy);
            return Err(FileErr::incomplete("changing"));
        }
        Err(e) => {
            ctx.amend_displaced(&id, None);
            return Err(e);
        }
    }
    // 9. nothing is reported about it any more
    crate::graphwatch::forget_copy(ctx, &copy);
    lk(&ctx.records).remove(&copy);
    // 10.
    Ok(RemoveCopyReply::Removed { displaced_id: id, head: judged.head })
}

// ═════════════════════════════════════════════════════════════════════════════
// Running blocking work from async commands
// ═════════════════════════════════════════════════════════════════════════════

fn panic_text(p: Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = p.downcast_ref::<&str>() {
        s.to_string()
    } else if let Some(s) = p.downcast_ref::<String>() {
        s.clone()
    } else {
        "unknown".into()
    }
}

/// Run `f` on a blocking thread, raced against `timeout` (contract §1.2). A
/// panic inside becomes an `Io` error; a timeout becomes `OfflineOrTimeout`
/// (the blocked thread finishes on its own and its result is dropped).
pub async fn blocking<T, F>(timeout: Duration, f: F) -> FResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> FResult<T> + Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::channel();
    let _work = tauri::async_runtime::spawn_blocking(move || {
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f))
            .unwrap_or_else(|p| Err(FileErr::io(format!("internal error: {}", panic_text(p)))));
        let _ = tx.send(r);
    });
    match tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(timeout)).await {
        Ok(Ok(r)) => r,
        Ok(Err(std::sync::mpsc::RecvTimeoutError::Timeout)) => Err(FileErr::timeout()),
        Ok(Err(std::sync::mpsc::RecvTimeoutError::Disconnected)) => Err(FileErr::io("internal error: the work stopped")),
        Err(e) => Err(FileErr::io(format!("internal error: {e}"))),
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// Tauri commands
// ═════════════════════════════════════════════════════════════════════════════

pub type Ctx = Arc<FileCtx>;

#[tauri::command]
pub async fn graphfile_read(ctx: tauri::State<'_, Ctx>, path: String) -> Result<ReadReply, FileErr> {
    let ctx = ctx.inner().clone();
    blocking(COMMAND_TIMEOUT, move || read(&ctx, Path::new(&path))).await
}

#[tauri::command]
pub async fn graphfile_header(path: String) -> Result<HeaderReply, FileErr> {
    blocking(COMMAND_TIMEOUT, move || read_header(Path::new(&path)).map(|(header, stat)| HeaderReply { header, stat })).await
}

#[tauri::command]
pub async fn graphfile_save(ctx: tauri::State<'_, Ctx>, req: SaveArgs) -> Result<SaveReply, FileErr> {
    let ctx = ctx.inner().clone();
    let cancel = Arc::new(AtomicBool::new(false));
    let flag = cancel.clone();
    let r = blocking(SAVE_TIMEOUT, move || save_cancellable(&ctx, &req, &flag)).await;
    if matches!(&r, Err(e) if e.kind == ErrKind::OfflineOrTimeout) {
        // The frontend is told the save failed: the worker must not write it later.
        cancel.store(true, Ordering::SeqCst);
    }
    r
}

#[derive(Serialize)]
pub struct ScanReply {
    entries: Vec<DirEntry>,
}

#[tauri::command]
pub async fn graphfile_scan_dir(dir: String) -> Result<ScanReply, FileErr> {
    blocking(COMMAND_TIMEOUT, move || scan_dir(Path::new(&dir)).map(|entries| ScanReply { entries })).await
}

#[tauri::command]
pub async fn graphfile_locate(
    ctx: tauri::State<'_, Ctx>,
    dir: String,
    analysis_id: String,
    token: String,
) -> Result<LocateReply, FileErr> {
    let ctx = ctx.inner().clone();
    let flag = ctx.locate_flag(&token);
    let ctx2 = ctx.clone();
    let tok = token.clone();
    let r = blocking(LOCATE_TIMEOUT, move || {
        let t0 = Instant::now();
        let now = move || t0.elapsed().as_millis() as u64;
        let mut progress = |scanned: u64, matches: usize| {
            ctx2.emit(EVT_LOCATE_PROGRESS, json!({ "token": tok, "scanned": scanned, "matches": matches }));
        };
        locate(Path::new(&dir), &analysis_id, &flag, LocateLimits::default(), &now, &mut progress)
    })
    .await;
    ctx.end_locate(&token);
    r
}

#[tauri::command]
pub async fn graphfile_locate_cancel(ctx: tauri::State<'_, Ctx>, token: String) -> Result<(), FileErr> {
    ctx.cancel_locate(&token);
    Ok(())
}

#[tauri::command]
pub async fn graphfile_journal_heads(
    ctx: tauri::State<'_, Ctx>,
    analysis_id: String,
    path: Option<String>,
) -> Result<Vec<JournalHead>, FileErr> {
    let ctx = ctx.inner().clone();
    blocking(COMMAND_TIMEOUT, move || ctx.journal_heads(&analysis_id, path.as_deref())).await
}

#[tauri::command]
pub async fn graphfile_read_journal(
    ctx: tauri::State<'_, Ctx>,
    analysis_id: String,
    revision_id: String,
) -> Result<Option<RawFile>, FileErr> {
    let ctx = ctx.inner().clone();
    blocking(COMMAND_TIMEOUT, move || Ok(ctx.read_journal(&analysis_id, &revision_id)?.map(|v| v.raw()))).await
}

#[tauri::command]
pub async fn graphfile_write_journal(ctx: tauri::State<'_, Ctx>, path: String, file: RawFile) -> Result<(), FileErr> {
    let ctx = ctx.inner().clone();
    blocking(COMMAND_TIMEOUT, move || {
        let _g = ctx.locks.lock(Path::new(&path));
        ctx.write_journal(&path, &file)
    })
    .await
}

#[tauri::command]
pub async fn graphfile_list_displaced(ctx: tauri::State<'_, Ctx>) -> Result<Vec<DisplacedEntry>, FileErr> {
    let ctx = ctx.inner().clone();
    blocking(COMMAND_TIMEOUT, move || ctx.list_displaced()).await
}

#[tauri::command]
pub async fn graphfile_read_displaced(ctx: tauri::State<'_, Ctx>, id: String) -> Result<Option<RawFile>, FileErr> {
    let ctx = ctx.inner().clone();
    blocking(COMMAND_TIMEOUT, move || Ok(ctx.read_displaced(&id)?.map(|v| v.raw()))).await
}

#[tauri::command]
pub async fn graphfile_peek(path: String) -> Result<PeekReply, FileErr> {
    blocking(COMMAND_TIMEOUT, move || peek(Path::new(&path))).await
}

#[tauri::command]
pub async fn graphfile_remove_copy(ctx: tauri::State<'_, Ctx>, req: RemoveCopyArgs) -> Result<RemoveCopyReply, FileErr> {
    let ctx = ctx.inner().clone();
    let cancel = Arc::new(AtomicBool::new(false));
    let flag = cancel.clone();
    let r = blocking(COMMAND_TIMEOUT, move || remove_copy_cancellable(&ctx, &req, &flag)).await;
    if matches!(&r, Err(e) if e.kind == ErrKind::OfflineOrTimeout) {
        // The frontend is told it failed: the worker must not move the file later.
        cancel.store(true, Ordering::SeqCst);
    }
    r
}

/// Show the file in Finder / Explorer / the file manager.
#[tauri::command]
pub async fn graphfile_reveal(path: String) -> Result<(), FileErr> {
    let p = PathBuf::from(&path);
    let r = {
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open").arg("-R").arg(&p).spawn()
        }
        #[cfg(target_os = "windows")]
        {
            std::process::Command::new("explorer").arg(format!("/select,{}", p.display())).spawn()
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            let parent = p.parent().map(Path::to_path_buf).unwrap_or_else(|| p.clone());
            std::process::Command::new("xdg-open").arg(parent).spawn()
        }
    };
    r.map(|_| ()).map_err(|e| FileErr::from_io(&e, &p))
}

#[cfg(test)]
#[path = "graphfile_tests.rs"]
pub(crate) mod tests;
