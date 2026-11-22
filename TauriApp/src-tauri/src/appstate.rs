//! The app's own records (phase1-contract.md §1.6, plan §3): device identity,
//! open tabs (session), Recent files, per-document unsaved work (drafts) and
//! the library export map. All under the state folder (`StateDir`, see
//! devenv.rs), written atomically (temp + rename).
//!
//! Session, drafts, Recent and the export map are stored as opaque JSON after
//! minimal checks, so the TypeScript side can add optional fields without a
//! Rust change.

use crate::graphfile::{atomic_write, lk, sha256_hex, valid_id, wall_ms, FResult, FileCtx, FileErr};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub const RECENT_MAX: usize = 50;
const NAME_MAX: usize = 60;

// ═════════════════════════════════════════════════════════════════════════════
// Device identity
// ═════════════════════════════════════════════════════════════════════════════

/// `DeviceIdentity` of backend.ts (snake_case on the wire).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DeviceIdentity {
    pub device_id: String,
    pub device_name: String,
    pub user_name: String,
    pub session_id: String,
}

/// device.json
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DeviceFile {
    pub v: u32,
    pub device_id: String,
    pub device_name: Option<String>,
    pub user_name: Option<String>,
    pub hw_hash: Option<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
}

/// What the OS says: hardware id and default names. Computed once per launch
/// (it runs small system tools); tests inject their own.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DeviceEnv {
    pub hardware_id: Option<String>,
    pub default_device_name: String,
    pub default_user_name: String,
}

#[derive(Default)]
pub struct DeviceEnvCell(Mutex<Option<Arc<DeviceEnv>>>);

impl DeviceEnvCell {
    pub fn get(&self) -> Arc<DeviceEnv> {
        let mut g = lk(&self.0);
        if let Some(e) = g.as_ref() {
            return e.clone();
        }
        let e = Arc::new(detect_device_env());
        *g = Some(e.clone());
        e
    }
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn set(&self, env: DeviceEnv) {
        *lk(&self.0) = Some(Arc::new(env));
    }
}

fn run_text(cmd: &str, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new(cmd).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty()).then_some(s)
}

fn strip_local(s: &str) -> String {
    s.trim().trim_end_matches(".local").to_string()
}

fn hostname() -> Option<String> {
    std::env::var("COMPUTERNAME")
        .ok()
        .or_else(|| std::env::var("HOSTNAME").ok())
        .filter(|s| !s.trim().is_empty())
        .or_else(|| fs::read_to_string("/etc/hostname").ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()))
        .or_else(|| run_text("hostname", &[]))
        .map(|s| strip_local(&s))
}

/// macOS `"IOPlatformUUID" = "…"` line of `ioreg -rd1 -c IOPlatformExpertDevice`.
#[cfg_attr(not(any(test, target_os = "macos")), allow(dead_code))]
pub fn parse_ioreg_uuid(text: &str) -> Option<String> {
    let line = text.lines().find(|l| l.contains("\"IOPlatformUUID\""))?;
    let v = line.split('=').nth(1)?.trim().trim_matches('"').to_string();
    (!v.is_empty()).then_some(v)
}

/// Windows `reg query … /v MachineGuid` output → the GUID.
#[cfg_attr(not(any(test, target_os = "windows")), allow(dead_code))]
pub fn parse_reg_guid(text: &str) -> Option<String> {
    let line = text.lines().find(|l| l.contains("MachineGuid"))?;
    line.split_whitespace().last().map(str::to_string)
}

pub fn detect_device_env() -> DeviceEnv {
    #[cfg(target_os = "macos")]
    {
        DeviceEnv {
            hardware_id: run_text("/usr/sbin/ioreg", &["-rd1", "-c", "IOPlatformExpertDevice"]).and_then(|t| parse_ioreg_uuid(&t)),
            default_device_name: run_text("/usr/sbin/scutil", &["--get", "ComputerName"])
                .map(|s| strip_local(&s))
                .or_else(hostname)
                .unwrap_or_default(),
            default_user_name: run_text("/usr/bin/id", &["-F"])
                .or_else(|| std::env::var("USER").ok())
                .unwrap_or_default(),
        }
    }
    #[cfg(target_os = "windows")]
    {
        DeviceEnv {
            hardware_id: run_text("reg", &["query", r"HKLM\SOFTWARE\Microsoft\Cryptography", "/v", "MachineGuid"])
                .and_then(|t| parse_reg_guid(&t)),
            default_device_name: hostname().unwrap_or_default(),
            default_user_name: std::env::var("USERNAME").unwrap_or_default(),
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        DeviceEnv {
            hardware_id: fs::read_to_string("/etc/machine-id").ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
            default_device_name: hostname().unwrap_or_default(),
            default_user_name: std::env::var("USER").unwrap_or_default(),
        }
    }
}

fn new_device_id() -> String {
    format!("d-{}", uuid::Uuid::new_v4())
}

fn hw_hash(env: &DeviceEnv) -> Option<String> {
    env.hardware_id.as_ref().map(|h| sha256_hex(format!("las-device:{h}").as_bytes()))
}

/// Read (creating or updating) device.json under `state`.
pub fn load_device(state: &Path, env: &DeviceEnv) -> FResult<DeviceFile> {
    let path = state.join("device.json");
    let stored: Option<DeviceFile> = match fs::read(&path) {
        Ok(b) => match serde_json::from_slice::<DeviceFile>(&b) {
            Ok(d) if valid_id(&d.device_id) => Some(d),
            _ => {
                let _ = fs::rename(&path, state.join(format!("device.json.bad-{}", wall_ms())));
                None
            }
        },
        Err(_) => None,
    };
    let cur = hw_hash(env);
    let (rec, changed) = match stored {
        None => (
            DeviceFile { v: 1, device_id: new_device_id(), device_name: None, user_name: None, hw_hash: cur, aliases: vec![] },
            true,
        ),
        Some(mut d) => match (&d.hw_hash, &cur) {
            (Some(stored), Some(now)) if stored != now => {
                // Copied to another computer (or restored from a backup there):
                // a new id, the old one kept as an alias. No question asked.
                let old = std::mem::replace(&mut d.device_id, new_device_id());
                d.aliases.push(old);
                d.hw_hash = cur;
                (d, true)
            }
            (None, Some(_)) => {
                d.hw_hash = cur;
                (d, true)
            }
            _ => (d, false),
        },
    };
    if changed {
        write_value(&path, &serde_json::to_value(&rec).map_err(|e| FileErr::io(e.to_string()))?)?;
    }
    Ok(rec)
}

pub fn identity_of(rec: &DeviceFile, env: &DeviceEnv, session_id: &str) -> DeviceIdentity {
    DeviceIdentity {
        device_id: rec.device_id.clone(),
        device_name: rec.device_name.clone().unwrap_or_else(|| env.default_device_name.clone()),
        user_name: rec.user_name.clone().unwrap_or_else(|| env.default_user_name.clone()),
        session_id: session_id.to_string(),
    }
}

/// `appstate_device`.
pub fn device(ctx: &FileCtx) -> FResult<DeviceIdentity> {
    let state = ctx.state()?;
    let env = ctx.device_env.get();
    let _g = ctx.state_guard();
    let rec = load_device(state, &env)?;
    Ok(identity_of(&rec, &env, &ctx.session_id))
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicePatch {
    pub device_name: Option<String>,
    pub user_name: Option<String>,
}

/// Trim, cut to 60 characters; empty → None (back to the default).
pub fn clean_name(s: &str) -> Option<String> {
    let t: String = s.trim().chars().take(NAME_MAX).collect();
    let t = t.trim().to_string();
    (!t.is_empty()).then_some(t)
}

/// `appstate_set_device`.
pub fn set_device(ctx: &FileCtx, patch: &DevicePatch) -> FResult<DeviceIdentity> {
    let state = ctx.state()?;
    let env = ctx.device_env.get();
    let _g = ctx.state_guard();
    let mut rec = load_device(state, &env)?;
    if let Some(n) = &patch.device_name {
        rec.device_name = clean_name(n);
    }
    if let Some(n) = &patch.user_name {
        rec.user_name = clean_name(n);
    }
    write_value(&state.join("device.json"), &serde_json::to_value(&rec).map_err(|e| FileErr::io(e.to_string()))?)?;
    Ok(identity_of(&rec, &env, &ctx.session_id))
}

// ═════════════════════════════════════════════════════════════════════════════
// JSON records
// ═════════════════════════════════════════════════════════════════════════════

fn write_value(path: &Path, v: &Value) -> FResult<()> {
    let bytes = serde_json::to_vec_pretty(v).map_err(|e| FileErr::io(e.to_string()))?;
    atomic_write(path, &bytes).map_err(|e| FileErr::from_io(&e, path))
}

enum Loaded {
    Missing,
    Bad,
    Ok(Value),
}

fn load_value(path: &Path) -> FResult<Loaded> {
    match fs::read(path) {
        Ok(b) => Ok(serde_json::from_slice::<Value>(&b).map(Loaded::Ok).unwrap_or(Loaded::Bad)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Loaded::Missing),
        Err(e) => Err(FileErr::from_io(&e, path)),
    }
}

pub fn default_session() -> Value {
    json!({ "v": 1, "tabs": [] })
}

fn session_ok(v: &Value) -> bool {
    v.get("tabs").map(Value::is_array).unwrap_or(false)
}

/// `appstate_read_session`: missing → default; unparsable → renamed aside
/// (`graph-session.json.bad-<ms>`) and default.
pub fn read_session(ctx: &FileCtx) -> FResult<Value> {
    let state = ctx.state()?;
    let path = state.join("graph-session.json");
    let _g = ctx.state_guard();
    match load_value(&path)? {
        Loaded::Missing => Ok(default_session()),
        Loaded::Ok(v) if session_ok(&v) => Ok(v),
        _ => {
            let _ = fs::rename(&path, state.join(format!("graph-session.json.bad-{}", wall_ms())));
            Ok(default_session())
        }
    }
}

pub fn write_session(ctx: &FileCtx, session: &Value) -> FResult<()> {
    if !session_ok(session) {
        return Err(FileErr::invalid("session.tabs must be a list"));
    }
    let state = ctx.state()?;
    let _g = ctx.state_guard();
    write_value(&state.join("graph-session.json"), session)
}

fn drafts_dir(ctx: &FileCtx) -> FResult<PathBuf> {
    Ok(ctx.state()?.join("drafts"))
}

fn draft_path(ctx: &FileCtx, doc_key: &str) -> FResult<PathBuf> {
    if !valid_id(doc_key) {
        return Err(FileErr::invalid(format!("bad document key {doc_key:?}")));
    }
    Ok(drafts_dir(ctx)?.join(format!("{doc_key}.json")))
}

pub fn read_draft(ctx: &FileCtx, doc_key: &str) -> FResult<Option<Value>> {
    let p = draft_path(ctx, doc_key)?;
    match load_value(&p)? {
        Loaded::Ok(v) if v.is_object() => Ok(Some(v)),
        _ => Ok(None),
    }
}

#[allow(dead_code)] // tests (and tools) call it without a sequence / cancel flag
pub fn write_draft(ctx: &FileCtx, draft: &Value) -> FResult<()> {
    write_draft_seq(ctx, draft, None)
}

#[allow(dead_code)] // tests (and tools) call it without a sequence / cancel flag
pub fn delete_draft(ctx: &FileCtx, doc_key: &str) -> FResult<()> {
    delete_draft_seq(ctx, doc_key, None)
}

/// Writes and deletes of one document's draft happen one at a time and in
/// the order the frontend made them: each carries a sequence number, and a
/// call older than the last one applied for that key is dropped (it was
/// overtaken, e.g. a write that timed out and finished late). `None`: always
/// applied (older frontends, tests).
fn draft_op(ctx: &FileCtx, key: &str, seq: Option<u64>, op: impl FnOnce() -> FResult<()>) -> FResult<()> {
    let mut order = lk(&ctx.draft_order);
    if let (Some(s), Some(last)) = (seq, order.get(key)) {
        if s <= *last {
            return Ok(());
        }
    }
    op()?;
    if let Some(s) = seq {
        order.insert(key.to_string(), s);
    }
    Ok(())
}

pub fn write_draft_seq(ctx: &FileCtx, draft: &Value, seq: Option<u64>) -> FResult<()> {
    let key = draft.get("doc_key").and_then(Value::as_str).ok_or_else(|| FileErr::invalid("the draft has no doc_key"))?;
    let p = draft_path(ctx, key)?;
    draft_op(ctx, key, seq, || write_value(&p, draft))
}

pub fn delete_draft_seq(ctx: &FileCtx, doc_key: &str, seq: Option<u64>) -> FResult<()> {
    let p = draft_path(ctx, doc_key)?;
    draft_op(ctx, doc_key, seq, || match fs::remove_file(&p) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(FileErr::from_io(&e, &p)),
    })
}

pub fn list_drafts(ctx: &FileCtx) -> FResult<Vec<Value>> {
    let dir = drafts_dir(ctx)?;
    let rd = match fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(FileErr::from_io(&e, &dir)),
    };
    let mut names: Vec<PathBuf> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            let n = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            !n.starts_with('.') && n.ends_with(".json")
        })
        .collect();
    names.sort();
    Ok(names
        .into_iter()
        .filter_map(|p| match load_value(&p) {
            Ok(Loaded::Ok(v)) if v.get("doc_key").and_then(Value::as_str).is_some() => Some(v),
            _ => None,
        })
        .collect())
}

/// Deduplicate by `path` (first wins), drop entries without a path, cut to 50.
pub fn clean_recent(entries: &[Value]) -> Vec<Value> {
    let mut seen = std::collections::HashSet::new();
    entries
        .iter()
        .filter(|e| match e.get("path").and_then(Value::as_str) {
            Some(p) => seen.insert(p.to_string()),
            None => false,
        })
        .take(RECENT_MAX)
        .cloned()
        .collect()
}

pub fn read_recent(ctx: &FileCtx) -> FResult<Vec<Value>> {
    let p = ctx.state()?.join("graph-recent.json");
    let _g = ctx.state_guard();
    Ok(match load_value(&p)? {
        Loaded::Ok(Value::Array(a)) => clean_recent(&a),
        _ => vec![],
    })
}

pub fn write_recent(ctx: &FileCtx, entries: &[Value]) -> FResult<()> {
    let p = ctx.state()?.join("graph-recent.json");
    let _g = ctx.state_guard();
    write_value(&p, &Value::Array(clean_recent(entries)))
}

pub fn default_export_map() -> Value {
    json!({ "v": 1, "rows": {} })
}

pub fn read_export_map(ctx: &FileCtx) -> FResult<Value> {
    let p = ctx.state()?.join("export-map.json");
    let _g = ctx.state_guard();
    Ok(match load_value(&p)? {
        Loaded::Ok(v) if v.get("rows").map(Value::is_object).unwrap_or(false) => v,
        _ => default_export_map(),
    })
}

pub fn write_export_map(ctx: &FileCtx, map: &Value) -> FResult<()> {
    if !map.get("rows").map(Value::is_object).unwrap_or(false) {
        return Err(FileErr::invalid("map.rows must be an object"));
    }
    let p = ctx.state()?.join("export-map.json");
    let _g = ctx.state_guard();
    write_value(&p, map)
}

// ── first-seen record (phase 2, graph-seen.json) ─────────────────────────────

pub fn default_seen() -> Value {
    json!({ "v": 1, "analyses": {} })
}

fn seen_ok(v: &Value) -> bool {
    v.get("analyses").map(Value::is_object).unwrap_or(false)
}

/// `appstate_read_seen` (phase2-contract.md §4.3): `SeenMap` as stored.
/// Missing → default; unparsable or `analyses` not an object → renamed aside
/// (`graph-seen.json.bad-<ms>`) and default.
pub fn read_seen(ctx: &FileCtx) -> FResult<Value> {
    let state = ctx.state()?;
    let path = state.join("graph-seen.json");
    let _g = ctx.state_guard();
    match load_value(&path)? {
        Loaded::Missing => Ok(default_seen()),
        Loaded::Ok(v) if seen_ok(&v) => Ok(v),
        _ => {
            let _ = fs::rename(&path, state.join(format!("graph-seen.json.bad-{}", wall_ms())));
            Ok(default_seen())
        }
    }
}

/// `appstate_write_seen`: atomic; `Invalid` unless `seen.analyses` is an object.
pub fn write_seen(ctx: &FileCtx, seen: &Value) -> FResult<()> {
    if !seen_ok(seen) {
        return Err(FileErr::invalid("seen.analyses must be an object"));
    }
    let state = ctx.state()?;
    let _g = ctx.state_guard();
    write_value(&state.join("graph-seen.json"), seen)
}

// ═════════════════════════════════════════════════════════════════════════════
// app_info
// ═════════════════════════════════════════════════════════════════════════════

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub app_version: String,
    pub platform: String,
    pub home_dir: String,
    pub temp_dirs: Vec<String>,
    pub state_dir: Option<String>,
    pub debug: bool,
}

fn no_trailing_slash(p: &Path) -> String {
    let s = p.to_string_lossy().into_owned();
    if s.len() > 1 {
        s.trim_end_matches(['/', '\\']).to_string()
    } else {
        s
    }
}

pub fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

/// Folders whose files should be moved before editing.
pub fn temp_dirs(home: &Path) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |p: PathBuf| {
        let s = no_trailing_slash(&p);
        if !out.contains(&s) {
            out.push(s);
        }
    };
    let tmp = std::env::temp_dir();
    push(fs::canonicalize(&tmp).unwrap_or(tmp));
    if cfg!(target_os = "macos") {
        push(PathBuf::from("/private/tmp"));
        push(PathBuf::from("/private/var/folders"));
        push(home.join("Library/Mail"));
        push(home.join("Library/Containers/com.apple.mail"));
    }
    push(home.join("Downloads"));
    out
}

pub fn build_app_info(version: &str, home: &Path, state_dir: Option<&Path>) -> AppInfo {
    AppInfo {
        app_version: version.to_string(),
        platform: platform().to_string(),
        home_dir: no_trailing_slash(home),
        temp_dirs: temp_dirs(home),
        state_dir: state_dir.map(no_trailing_slash),
        debug: cfg!(debug_assertions),
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// Tauri commands
// ═════════════════════════════════════════════════════════════════════════════

use crate::graphfile::{blocking, Ctx, COMMAND_TIMEOUT};

macro_rules! cmd {
    ($ctx:expr, $body:expr) => {{
        let ctx = $ctx.inner().clone();
        blocking(COMMAND_TIMEOUT, move || $body(&*ctx)).await
    }};
}

#[tauri::command]
pub async fn appstate_device(ctx: tauri::State<'_, Ctx>) -> Result<DeviceIdentity, FileErr> {
    cmd!(ctx, |c: &FileCtx| device(c))
}

#[tauri::command]
pub async fn appstate_set_device(ctx: tauri::State<'_, Ctx>, patch: DevicePatch) -> Result<DeviceIdentity, FileErr> {
    cmd!(ctx, move |c: &FileCtx| set_device(c, &patch))
}

#[tauri::command]
pub async fn appstate_read_session(ctx: tauri::State<'_, Ctx>) -> Result<Value, FileErr> {
    cmd!(ctx, |c: &FileCtx| read_session(c))
}

#[tauri::command]
pub async fn appstate_write_session(ctx: tauri::State<'_, Ctx>, session: Value) -> Result<(), FileErr> {
    cmd!(ctx, move |c: &FileCtx| write_session(c, &session))
}

#[tauri::command]
pub async fn appstate_read_draft(ctx: tauri::State<'_, Ctx>, doc_key: String) -> Result<Option<Value>, FileErr> {
    cmd!(ctx, move |c: &FileCtx| read_draft(c, &doc_key))
}

#[tauri::command]
pub async fn appstate_write_draft(ctx: tauri::State<'_, Ctx>, draft: Value, seq: Option<u64>) -> Result<(), FileErr> {
    cmd!(ctx, move |c: &FileCtx| write_draft_seq(c, &draft, seq))
}

#[tauri::command]
pub async fn appstate_delete_draft(ctx: tauri::State<'_, Ctx>, doc_key: String, seq: Option<u64>) -> Result<(), FileErr> {
    cmd!(ctx, move |c: &FileCtx| delete_draft_seq(c, &doc_key, seq))
}

#[tauri::command]
pub async fn appstate_list_drafts(ctx: tauri::State<'_, Ctx>) -> Result<Vec<Value>, FileErr> {
    cmd!(ctx, |c: &FileCtx| list_drafts(c))
}

#[tauri::command]
pub async fn appstate_read_recent(ctx: tauri::State<'_, Ctx>) -> Result<Vec<Value>, FileErr> {
    cmd!(ctx, |c: &FileCtx| read_recent(c))
}

#[tauri::command]
pub async fn appstate_write_recent(ctx: tauri::State<'_, Ctx>, entries: Vec<Value>) -> Result<(), FileErr> {
    cmd!(ctx, move |c: &FileCtx| write_recent(c, &entries))
}

#[tauri::command]
pub async fn appstate_read_export_map(ctx: tauri::State<'_, Ctx>) -> Result<Value, FileErr> {
    cmd!(ctx, |c: &FileCtx| read_export_map(c))
}

#[tauri::command]
pub async fn appstate_write_export_map(ctx: tauri::State<'_, Ctx>, map: Value) -> Result<(), FileErr> {
    cmd!(ctx, move |c: &FileCtx| write_export_map(c, &map))
}

#[tauri::command]
pub async fn appstate_read_seen(ctx: tauri::State<'_, Ctx>) -> Result<Value, FileErr> {
    cmd!(ctx, |c: &FileCtx| read_seen(c))
}

#[tauri::command]
pub async fn appstate_write_seen(ctx: tauri::State<'_, Ctx>, seen: Value) -> Result<(), FileErr> {
    cmd!(ctx, move |c: &FileCtx| write_seen(c, &seen))
}

#[tauri::command]
pub async fn app_info(app: tauri::AppHandle, ctx: tauri::State<'_, Ctx>) -> Result<AppInfo, FileErr> {
    use tauri::Manager;
    let home = app
        .path()
        .home_dir()
        .ok()
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
        .unwrap_or_default();
    Ok(build_app_info(&app.package_info().version.to_string(), &home, ctx.state_dir.as_deref()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("las-p1-appstate-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn ctx_in(dir: &Path) -> FileCtx {
        let c = FileCtx::new(Some(dir.to_path_buf()));
        c.device_env.set(DeviceEnv {
            hardware_id: Some("HW-1".into()),
            default_device_name: "Mac mini".into(),
            default_user_name: "Zhuo".into(),
        });
        c
    }

    /// V2: writes and deletes of one draft land in the order they were made, even when an
    /// older call arrives (or finishes) after a newer one.
    #[test]
    fn draft_writes_and_deletes_keep_their_order() {
        let d = tmp();
        let c = Arc::new(ctx_in(&d));
        let big = "x".repeat(3_000_000);
        for i in 0..20 {
            let key = format!("k-{i}");
            let draft = json!({"doc_key": key, "base_revision": "r-old", "blob": big});
            let c2 = c.clone();
            let w = std::thread::spawn(move || write_draft_seq(&c2, &draft, Some(10)).unwrap());
            std::thread::sleep(std::time::Duration::from_millis(2));
            delete_draft_seq(&c, &key, Some(11)).unwrap();
            w.join().unwrap();
            assert!(read_draft(&c, &key).unwrap().is_none(), "round {i}: a stale draft survived");
        }
        // an overtaken write is dropped; a newer one is applied
        let k = "k-order";
        write_draft_seq(&c, &json!({"doc_key": k, "n": 2}), Some(2)).unwrap();
        write_draft_seq(&c, &json!({"doc_key": k, "n": 1}), Some(1)).unwrap();
        assert_eq!(read_draft(&c, k).unwrap().unwrap()["n"], 2);
        delete_draft_seq(&c, k, Some(1)).unwrap();
        assert!(read_draft(&c, k).unwrap().is_some(), "an old delete doesn't remove newer work");
        write_draft_seq(&c, &json!({"doc_key": k, "n": 3}), Some(3)).unwrap();
        assert_eq!(read_draft(&c, k).unwrap().unwrap()["n"], 3);
        // calls without a number are always applied
        delete_draft(&c, k).unwrap();
        assert!(read_draft(&c, k).unwrap().is_none());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn device_create_rename_and_hardware_change() {
        let d = tmp();
        let c = ctx_in(&d);
        let a = device(&c).unwrap();
        assert!(a.device_id.starts_with("d-") && valid_id(&a.device_id));
        assert_eq!(a.device_name, "Mac mini");
        assert_eq!(a.user_name, "Zhuo");
        assert!(a.session_id.starts_with("s-"));
        // stable across calls
        assert_eq!(device(&c).unwrap().device_id, a.device_id);
        // rename: trimmed, cut to 60 chars, survives
        let long = format!("  {}  ", "x".repeat(80));
        let b = set_device(&c, &DevicePatch { device_name: Some("  Office iMac ".into()), user_name: Some(long) }).unwrap();
        assert_eq!(b.device_name, "Office iMac");
        assert_eq!(b.user_name.chars().count(), 60);
        assert_eq!(b.device_id, a.device_id);
        // empty → default again
        let b2 = set_device(&c, &DevicePatch { device_name: None, user_name: Some("   ".into()) }).unwrap();
        assert_eq!(b2.user_name, "Zhuo");
        assert_eq!(b2.device_name, "Office iMac");
        // other hardware (device.json copied to another computer): new id, alias kept
        let c2 = FileCtx::new(Some(d.clone()));
        c2.device_env.set(DeviceEnv { hardware_id: Some("HW-2".into()), default_device_name: "Other".into(), default_user_name: "Z".into() });
        let n = device(&c2).unwrap();
        assert_ne!(n.device_id, a.device_id);
        let rec: DeviceFile = serde_json::from_slice(&fs::read(d.join("device.json")).unwrap()).unwrap();
        assert_eq!(rec.aliases, vec![a.device_id.clone()]);
        assert_eq!(n.device_name, "Office iMac", "names stay");
        // unreadable hardware id: keep the id
        let c3 = FileCtx::new(Some(d.clone()));
        c3.device_env.set(DeviceEnv { hardware_id: None, default_device_name: "X".into(), default_user_name: "Y".into() });
        assert_eq!(device(&c3).unwrap().device_id, n.device_id);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn parse_hardware_ids() {
        let io = "+-o J314sAP  <class IOPlatformExpertDevice>\n    \"IOPlatformSerialNumber\" = \"X\"\n    \"IOPlatformUUID\" = \"1234-ABCD\"\n";
        assert_eq!(parse_ioreg_uuid(io).as_deref(), Some("1234-ABCD"));
        let reg = "\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\n    MachineGuid    REG_SZ    abcd-1234\n";
        assert_eq!(parse_reg_guid(reg).as_deref(), Some("abcd-1234"));
    }

    #[test]
    fn session_round_trip_bad_and_invalid() {
        let d = tmp();
        let c = ctx_in(&d);
        assert_eq!(read_session(&c).unwrap(), default_session());
        let s = json!({"v":1,"tabs":[{"doc_key":"k-1","path":"/a.lag","extra":{"x":1}}]});
        write_session(&c, &s).unwrap();
        assert_eq!(read_session(&c).unwrap(), s);
        assert_eq!(write_session(&c, &json!({"v":1})).unwrap_err().kind, crate::graphfile::ErrKind::Invalid);
        fs::write(d.join("graph-session.json"), b"{not json").unwrap();
        assert_eq!(read_session(&c).unwrap(), default_session());
        assert!(fs::read_dir(&d).unwrap().flatten().any(|e| e.file_name().to_string_lossy().starts_with("graph-session.json.bad-")));
        // no temp files left by atomic writes
        assert!(!fs::read_dir(&d).unwrap().flatten().any(|e| e.file_name().to_string_lossy().contains(".tmp-")));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn drafts_round_trip() {
        let d = tmp();
        let c = ctx_in(&d);
        assert_eq!(list_drafts(&c).unwrap(), Vec::<Value>::new());
        let dr = json!({"doc_key":"k-abc","analysis_id":null,"path":null,"base_revision":null,"sections":{"table":{"a":1}},"saved_at":"2026-01-01T00:00:00Z"});
        write_draft(&c, &dr).unwrap();
        assert_eq!(read_draft(&c, "k-abc").unwrap(), Some(dr.clone()));
        assert_eq!(list_drafts(&c).unwrap(), vec![dr]);
        fs::write(d.join("drafts").join("k-bad.json"), b"garbage").unwrap();
        assert_eq!(list_drafts(&c).unwrap().len(), 1, "unreadable skipped");
        assert_eq!(read_draft(&c, "../x").unwrap_err().kind, crate::graphfile::ErrKind::Invalid);
        assert!(write_draft(&c, &json!({"doc_key":"a/b"})).is_err());
        delete_draft(&c, "k-abc").unwrap();
        delete_draft(&c, "k-abc").unwrap();
        assert_eq!(read_draft(&c, "k-abc").unwrap(), None);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn recent_dedupe_and_cap() {
        let d = tmp();
        let c = ctx_in(&d);
        assert!(read_recent(&c).unwrap().is_empty());
        let mut entries: Vec<Value> =
            (0..70).map(|i| json!({"path": format!("/f{}.lag", i % 60), "analysis_id": null, "opened_at": i.to_string()})).collect();
        entries.insert(0, json!({"nopath": true}));
        write_recent(&c, &entries).unwrap();
        let back = read_recent(&c).unwrap();
        assert_eq!(back.len(), RECENT_MAX);
        assert_eq!(back[0]["path"], "/f0.lag");
        assert_eq!(back[0]["opened_at"], "0", "first wins");
        let paths: std::collections::HashSet<_> = back.iter().map(|e| e["path"].as_str().unwrap().to_string()).collect();
        assert_eq!(paths.len(), RECENT_MAX);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn export_map_round_trip() {
        let d = tmp();
        let c = ctx_in(&d);
        assert_eq!(read_export_map(&c).unwrap(), default_export_map());
        let m = json!({"v":1,"rows":{"3":{"saved_at":"x","analysis_id":"a-1","path":null,"status":"failed"}}});
        write_export_map(&c, &m).unwrap();
        assert_eq!(read_export_map(&c).unwrap(), m);
        assert!(write_export_map(&c, &json!({"rows": []})).is_err());
        let _ = fs::remove_dir_all(&d);
    }

    /// R8: first-seen record — default, round trip, bad file moved aside, invalid write refused.
    #[test]
    fn seen_map_default_round_trip_and_bad_file() {
        let d = tmp();
        let c = ctx_in(&d);
        assert_eq!(read_seen(&c).unwrap(), default_seen());
        assert!(!d.join("graph-seen.json").exists(), "reading never creates the file");
        let m = json!({"v":1,"analyses":{"a-1":{"r-01":1_763_640_000_000_i64,"r-m-0123456789abcdef0123456789":1_763_640_000_123_i64}},"zz":true});
        write_seen(&c, &m).unwrap();
        assert_eq!(read_seen(&c).unwrap(), m, "stored as it is given");
        assert_eq!(write_seen(&c, &json!({"v":1,"analyses":[]})).unwrap_err().kind, crate::graphfile::ErrKind::Invalid);
        assert_eq!(write_seen(&c, &json!({"v":1})).unwrap_err().kind, crate::graphfile::ErrKind::Invalid);
        assert_eq!(read_seen(&c).unwrap(), m, "a refused write changes nothing");
        let bad = |d: &Path| fs::read_dir(d).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with("graph-seen.json.bad-")).count();
        fs::write(d.join("graph-seen.json"), b"{not json").unwrap();
        assert_eq!(read_seen(&c).unwrap(), default_seen());
        assert_eq!(bad(&d), 1);
        assert!(!d.join("graph-seen.json").exists());
        std::thread::sleep(std::time::Duration::from_millis(3));
        fs::write(d.join("graph-seen.json"), br#"{"v":1,"analyses":"x"}"#).unwrap();
        assert_eq!(read_seen(&c).unwrap(), default_seen());
        assert_eq!(bad(&d), 2);
        assert_eq!(read_seen(&FileCtx::new(None)).unwrap_err().kind, crate::graphfile::ErrKind::NoStateDir);
        assert_eq!(write_seen(&FileCtx::new(None), &default_seen()).unwrap_err().kind, crate::graphfile::ErrKind::NoStateDir);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn no_state_dir() {
        let c = FileCtx::new(None);
        assert_eq!(read_session(&c).unwrap_err().kind, crate::graphfile::ErrKind::NoStateDir);
        assert_eq!(device(&c).unwrap_err().kind, crate::graphfile::ErrKind::NoStateDir);
        assert_eq!(read_recent(&c).unwrap_err().kind, crate::graphfile::ErrKind::NoStateDir);
    }

    #[test]
    fn app_info_shape() {
        let i = build_app_info("0.2.1", Path::new("/Users/me/"), Some(Path::new("/s/")));
        assert_eq!(i.home_dir, "/Users/me");
        assert_eq!(i.state_dir.as_deref(), Some("/s"));
        assert!(i.temp_dirs.contains(&"/Users/me/Downloads".to_string()));
        assert!(i.temp_dirs.iter().all(|d| !d.ends_with('/')));
        let v = serde_json::to_value(&i).unwrap();
        assert!(v.get("appVersion").is_some() && v.get("tempDirs").is_some() && v.get("stateDir").is_some());
    }
}
