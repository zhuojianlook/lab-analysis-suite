//! Phase 3: is a path inside a folder a sync service keeps on several
//! computers? (`graphfile_cloud_info`, phase3-contract.md §3.9, plan §6.8.)
//!
//! The lists of roots are pure functions of an injected environment (home
//! folder, environment variables, the text of Dropbox's `info.json` files and
//! a few folder listings), so the lists of all three systems are tested on
//! every platform. Only `gather_env` touches the machine. The file-provider
//! attribute is not used (it needs native code).

use crate::graphfile::{FResult, FileErr};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// `CloudInfo` of contract.ts.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudInfo {
    pub cloud: bool,
    pub service: Option<String>,
    pub root: Option<String>,
}

impl CloudInfo {
    pub fn none() -> Self {
        CloudInfo { cloud: false, service: None, root: None }
    }
}

/// What the root lists are computed from.
#[derive(Debug, Clone, Default)]
pub struct CloudEnv {
    /// macOS / Linux: $HOME. Windows: %USERPROFILE%.
    pub home: Option<String>,
    /// Environment variables (Windows: OneDrive, OneDriveConsumer, OneDriveCommercial).
    pub vars: BTreeMap<String, String>,
    /// Texts of the Dropbox `info.json` files that exist.
    pub dropbox_info: Vec<String>,
    /// macOS: names of the direct child folders of ~/Library/CloudStorage.
    pub cloud_storage: Vec<String>,
    /// Names of the direct child folders of the home folder.
    pub home_children: Vec<String>,
    /// macOS: names in /Volumes.
    pub volumes: Vec<String>,
    /// Windows: the path's own drive ("G:") when "G:\My Drive" exists.
    pub my_drive_drive: Option<String>,
    /// Debug builds: LAS_CLOUD_ROOTS (empty in release builds).
    pub debug_roots: Vec<String>,
}

fn join(os: &str, base: &str, rest: &str) -> String {
    let sep = if os == "windows" { '\\' } else { '/' };
    let b = base.trim_end_matches(['/', '\\']);
    format!("{b}{sep}{rest}")
}

/// The `path` of every top-level account (personal / business) in a Dropbox `info.json`.
pub fn dropbox_paths(text: &str) -> Vec<String> {
    let Ok(Value::Object(m)) = serde_json::from_str::<Value>(text) else { return vec![] };
    let mut out: Vec<String> = Vec::new();
    for key in ["personal", "business"] {
        if let Some(p) = m.get(key).and_then(|a| a.get("path")).and_then(Value::as_str) {
            if !p.is_empty() && !out.iter().any(|x| x == p) {
                out.push(p.to_string());
            }
        }
    }
    out
}

/// Service of a folder in ~/Library/CloudStorage, from its name.
pub fn cloud_storage_service(name: &str) -> String {
    if name.starts_with("Dropbox") {
        "Dropbox".into()
    } else if name.starts_with("OneDrive") {
        "OneDrive".into()
    } else if name.starts_with("GoogleDrive") {
        "Google Drive".into()
    } else if name.starts_with("Box") {
        "Box".into()
    } else if name.starts_with("iCloud") {
        "iCloud Drive".into()
    } else {
        name.split('-').next().unwrap_or(name).to_string()
    }
}

/// Every known root for `os` ("macos" / "windows" / anything else = Linux), in match order.
pub fn cloud_roots(os: &str, e: &CloudEnv) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut add = |p: String, s: &str| {
        if !p.is_empty() && !out.iter().any(|(x, _)| *x == p) {
            out.push((p, s.to_string()));
        }
    };
    let home = e.home.clone().filter(|h| !h.is_empty());
    let dropbox_info: Vec<String> = e.dropbox_info.iter().flat_map(|t| dropbox_paths(t)).collect();
    let mut kids = e.home_children.clone();
    kids.sort();
    match os {
        "macos" => {
            if let Some(h) = &home {
                let mut cs = e.cloud_storage.clone();
                cs.sort();
                for c in cs {
                    add(join(os, h, &format!("Library/CloudStorage/{c}")), &cloud_storage_service(&c));
                }
                add(join(os, h, "Library/Mobile Documents"), "iCloud Drive");
            }
            for p in dropbox_info {
                add(p, "Dropbox");
            }
            if let Some(h) = &home {
                add(join(os, h, "Dropbox"), "Dropbox");
                for k in kids.iter().filter(|k| k.starts_with("Dropbox (")) {
                    add(join(os, h, k), "Dropbox");
                }
                add(join(os, h, "OneDrive"), "OneDrive");
                for k in kids.iter().filter(|k| k.starts_with("OneDrive - ")) {
                    add(join(os, h, k), "OneDrive");
                }
                add(join(os, h, "Google Drive"), "Google Drive");
            }
            add("/Volumes/GoogleDrive".into(), "Google Drive");
            let mut vols = e.volumes.clone();
            vols.sort();
            for v in vols.iter().filter(|v| v.starts_with("GoogleDrive-")) {
                add(format!("/Volumes/{v}"), "Google Drive");
            }
            if let Some(h) = &home {
                add(join(os, h, "Box"), "Box");
                add(join(os, h, "Box Sync"), "Box");
            }
        }
        "windows" => {
            for k in ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"] {
                if let Some(v) = e.vars.get(k) {
                    add(v.trim_end_matches(['/', '\\']).to_string(), "OneDrive");
                }
            }
            for p in dropbox_info {
                add(p, "Dropbox");
            }
            if let Some(h) = &home {
                add(join(os, h, "Dropbox"), "Dropbox");
                add(join(os, h, "Google Drive"), "Google Drive");
                add(join(os, h, "My Drive"), "Google Drive");
            }
            if let Some(d) = &e.my_drive_drive {
                add(format!("{d}\\My Drive"), "Google Drive");
                add(format!("{d}\\Shared drives"), "Google Drive");
            }
            if let Some(h) = &home {
                add(join(os, h, "iCloudDrive"), "iCloud Drive");
                add(join(os, h, "Box"), "Box");
            }
        }
        _ => {
            for p in dropbox_info {
                add(p, "Dropbox");
            }
            if let Some(h) = &home {
                add(join(os, h, "Dropbox"), "Dropbox");
                add(join(os, h, "OneDrive"), "OneDrive");
                add(join(os, h, "GoogleDrive"), "Google Drive");
                add(join(os, h, "google-drive"), "Google Drive");
                add(join(os, h, "Nextcloud"), "Nextcloud");
                add(join(os, h, "ownCloud"), "ownCloud");
                add(join(os, h, "pCloudDrive"), "pCloud");
            }
        }
    }
    for r in &e.debug_roots {
        add(r.clone(), "Test cloud");
    }
    out
}

/// Path components for a whole-component prefix compare (Windows: either separator, ASCII case ignored).
fn comps(os: &str, s: &str) -> Vec<String> {
    if os == "windows" {
        s.split(['\\', '/']).filter(|c| !c.is_empty()).map(|c| c.to_ascii_lowercase()).collect()
    } else {
        s.split('/').filter(|c| !c.is_empty()).map(str::to_string).collect()
    }
}

/// The first root `folder` is inside (or equal to), by whole components.
pub fn match_root(os: &str, folder: &str, roots: &[(String, String)]) -> Option<(String, String)> {
    let f = comps(os, folder);
    roots
        .iter()
        .find(|(r, _)| {
            let rc = comps(os, r);
            !rc.is_empty() && f.len() >= rc.len() && f[..rc.len()] == rc[..]
        })
        .cloned()
}

fn child_dirs(dir: &Path) -> Vec<String> {
    let Ok(rd) = fs::read_dir(dir) else { return vec![] };
    rd.flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir() || t.is_symlink()).unwrap_or(false))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| !n.starts_with('.'))
        .collect()
}

/// Debug builds only: the folders of `LAS_CLOUD_ROOTS`.
pub fn debug_roots(debug: bool, raw: Option<&str>) -> Vec<String> {
    if !debug {
        return vec![];
    }
    crate::devenv::parse_path_list(raw.unwrap_or(""), cfg!(windows)).iter().map(|p| p.to_string_lossy().into_owned()).collect()
}

/// Read what the lists need from this machine, for `folder` (canonical).
pub fn gather_env(folder: &Path) -> CloudEnv {
    let var = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
    let os = std::env::consts::OS;
    let home = if os == "windows" { var("USERPROFILE").or_else(|| var("HOME")) } else { var("HOME") };
    let mut e = CloudEnv { home: home.clone(), ..Default::default() };
    for k in ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"] {
        if let Some(v) = var(k) {
            e.vars.insert(k.to_string(), v);
        }
    }
    let mut info_files: Vec<PathBuf> = Vec::new();
    if os == "windows" {
        for k in ["APPDATA", "LOCALAPPDATA"] {
            if let Some(v) = var(k) {
                info_files.push(Path::new(&v).join("Dropbox").join("info.json"));
            }
        }
    } else if let Some(h) = &home {
        info_files.push(Path::new(h).join(".dropbox").join("info.json"));
    }
    for f in info_files {
        if let Ok(t) = fs::read_to_string(&f) {
            e.dropbox_info.push(t);
        }
    }
    if let Some(h) = &home {
        if os == "macos" {
            e.cloud_storage = child_dirs(&Path::new(h).join("Library").join("CloudStorage"));
        }
        e.home_children = child_dirs(Path::new(h));
    }
    if os == "macos" {
        e.volumes = child_dirs(Path::new("/Volumes"));
    }
    if os == "windows" {
        let s = folder.to_string_lossy();
        let b = s.as_bytes();
        if b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
            let d = s[..2].to_ascii_uppercase();
            if Path::new(&format!("{d}\\My Drive")).is_dir() {
                e.my_drive_drive = Some(d);
            }
        }
    }
    e.debug_roots = debug_roots(cfg!(debug_assertions), std::env::var(crate::devenv::ENV_CLOUD_ROOTS).ok().as_deref());
    e
}

fn canonical_str(p: &str) -> String {
    match fs::canonicalize(p) {
        Ok(c) => {
            let s = c.to_string_lossy().into_owned();
            // Windows: drop the verbatim prefix canonicalize adds.
            s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(s)
        }
        Err(_) => p.to_string(),
    }
}

/// The answer for `folder` with the roots of `env` (both made canonical when they exist).
pub fn cloud_info_in(os: &str, folder: &Path, env: &CloudEnv) -> CloudInfo {
    let f = canonical_str(&folder.to_string_lossy());
    let roots: Vec<(String, String)> = cloud_roots(os, env).into_iter().map(|(r, s)| (canonical_str(&r), s)).collect();
    match match_root(os, &f, &roots) {
        Some((root, service)) => {
            let root = if root.len() > 1 { root.trim_end_matches(['/', '\\']).to_string() } else { root };
            CloudInfo { cloud: true, service: Some(service), root: Some(root) }
        }
        None => CloudInfo::none(),
    }
}

/// `graphfile_cloud_info`: `path` may be a file or a folder.
pub fn cloud_info(path: &str) -> FResult<CloudInfo> {
    let p = PathBuf::from(path);
    if !p.is_absolute() {
        return Err(FileErr::invalid(format!("not an absolute path: {path:?}")));
    }
    let folder = if p.is_dir() { p.clone() } else { p.parent().map(Path::to_path_buf).unwrap_or(p.clone()) };
    let folder = fs::canonicalize(&folder).unwrap_or(folder);
    let env = gather_env(&folder);
    Ok(cloud_info_in(std::env::consts::OS, &folder, &env))
}

#[tauri::command]
pub async fn graphfile_cloud_info(path: String) -> Result<CloudInfo, FileErr> {
    crate::graphfile::blocking(crate::graphfile::COMMAND_TIMEOUT, move || cloud_info(&path)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mac_env() -> CloudEnv {
        CloudEnv {
            home: Some("/Users/u".into()),
            cloud_storage: vec!["Dropbox".into(), "OneDrive-Personal".into(), "GoogleDrive-a@b.com".into(), "Box-Box".into(), "pCloud-x".into()],
            home_children: vec!["Dropbox (Lab)".into(), "OneDrive - Uni".into(), "Documents".into(), "Dropbox2".into()],
            volumes: vec!["GoogleDrive-x".into(), "Macintosh HD".into()],
            dropbox_info: vec![r#"{"personal":{"path":"/Users/u/Dropbox Personal","host":1},"business":{"path":"/Users/u/Dropbox (Work)"}}"#.into(), "{not json".into()],
            ..Default::default()
        }
    }

    fn roots_of(os: &str, e: &CloudEnv) -> Vec<(String, String)> {
        cloud_roots(os, e)
    }

    fn svc(os: &str, e: &CloudEnv, folder: &str) -> Option<String> {
        match_root(os, folder, &roots_of(os, e)).map(|(_, s)| s)
    }

    /// R10: macOS list from an injected environment.
    #[test]
    fn macos_roots() {
        let e = mac_env();
        let r = roots_of("macos", &e);
        let has = |p: &str, s: &str| r.contains(&(p.to_string(), s.to_string()));
        assert!(has("/Users/u/Library/CloudStorage/Dropbox", "Dropbox"));
        assert!(has("/Users/u/Library/CloudStorage/OneDrive-Personal", "OneDrive"));
        assert!(has("/Users/u/Library/CloudStorage/GoogleDrive-a@b.com", "Google Drive"));
        assert!(has("/Users/u/Library/CloudStorage/Box-Box", "Box"));
        assert!(has("/Users/u/Library/CloudStorage/pCloud-x", "pCloud"), "else: the name up to the first -");
        assert!(has("/Users/u/Library/Mobile Documents", "iCloud Drive"));
        assert!(has("/Users/u/Dropbox Personal", "Dropbox") && has("/Users/u/Dropbox (Work)", "Dropbox"), "info.json");
        assert!(has("/Users/u/Dropbox", "Dropbox") && has("/Users/u/Dropbox (Lab)", "Dropbox"));
        assert!(has("/Users/u/OneDrive", "OneDrive") && has("/Users/u/OneDrive - Uni", "OneDrive"));
        assert!(has("/Users/u/Google Drive", "Google Drive") && has("/Volumes/GoogleDrive", "Google Drive"));
        assert!(has("/Volumes/GoogleDrive-x", "Google Drive"));
        assert!(has("/Users/u/Box", "Box") && has("/Users/u/Box Sync", "Box"));
        assert!(!r.iter().any(|(p, _)| p.ends_with("Dropbox2")), "only Dropbox (…) children");
        assert_eq!(svc("macos", &e, "/Users/u/Library/CloudStorage/Dropbox/Lab/x"), Some("Dropbox".into()));
        assert_eq!(svc("macos", &e, "/Users/u/Library/Mobile Documents/com~apple~CloudDocs/a"), Some("iCloud Drive".into()));
        assert_eq!(svc("macos", &e, "/Users/u/Documents/Lab"), None);
        assert_eq!(svc("macos", &e, "/Users/u/Library/CloudStorage"), None, "the CloudStorage folder itself is not a root");
    }

    /// R10: whole-component prefixes.
    #[test]
    fn whole_component_prefix() {
        let e = mac_env();
        assert_eq!(svc("macos", &e, "/Users/u/Dropbox2/a"), None, "~/Dropbox2 is not under ~/Dropbox");
        assert_eq!(svc("macos", &e, "/Users/u/Dropbox"), Some("Dropbox".into()), "the root itself");
        assert_eq!(svc("macos", &e, "/Users/u/Dropbox/"), Some("Dropbox".into()));
        assert_eq!(svc("macos", &e, "/Users/u/Boxes/a"), None);
        let w = CloudEnv { home: Some(r"C:\Users\u".into()), ..Default::default() };
        assert_eq!(svc("windows", &w, r"C:\Users\u\Dropbox2\x"), None);
        assert_eq!(svc("windows", &w, r"c:\users\U\DROPBOX\x"), Some("Dropbox".into()), "Windows ignores ASCII case");
    }

    /// R10: Windows list.
    #[test]
    fn windows_roots() {
        let mut vars = BTreeMap::new();
        vars.insert("OneDrive".to_string(), r"C:\Users\u\OneDrive".to_string());
        vars.insert("OneDriveCommercial".to_string(), r"C:\Users\u\OneDrive - Uni\".to_string());
        let e = CloudEnv {
            home: Some(r"C:\Users\u".into()),
            vars,
            dropbox_info: vec![r#"{"personal":{"path":"D:\\Dropbox"}}"#.into()],
            my_drive_drive: Some("G:".into()),
            ..Default::default()
        };
        let r = roots_of("windows", &e);
        let has = |p: &str, s: &str| r.contains(&(p.to_string(), s.to_string()));
        assert!(has(r"C:\Users\u\OneDrive", "OneDrive") && has(r"C:\Users\u\OneDrive - Uni", "OneDrive"));
        assert!(has(r"D:\Dropbox", "Dropbox") && has(r"C:\Users\u\Dropbox", "Dropbox"));
        assert!(has(r"C:\Users\u\Google Drive", "Google Drive") && has(r"C:\Users\u\My Drive", "Google Drive"));
        assert!(has(r"G:\My Drive", "Google Drive") && has(r"G:\Shared drives", "Google Drive"));
        assert!(has(r"C:\Users\u\iCloudDrive", "iCloud Drive") && has(r"C:\Users\u\Box", "Box"));
        assert_eq!(svc("windows", &e, r"G:\Shared drives\Team\x.lag"), Some("Google Drive".into()));
        assert_eq!(svc("windows", &e, r"D:\dropbox\Lab"), Some("Dropbox".into()));
        assert_eq!(svc("windows", &e, r"C:\Users\u\Documents"), None);
        let no_drive = CloudEnv { my_drive_drive: None, ..e.clone() };
        assert_eq!(svc("windows", &no_drive, r"G:\Shared drives\Team"), None, "only when X:\\My Drive exists");
    }

    /// R10: Linux list.
    #[test]
    fn linux_roots() {
        let e = CloudEnv {
            home: Some("/home/u".into()),
            dropbox_info: vec![r#"{"business":{"path":"/data/Dropbox (Lab)"}}"#.into()],
            ..Default::default()
        };
        for (f, s) in [
            ("/home/u/Dropbox/a", "Dropbox"),
            ("/data/Dropbox (Lab)/a", "Dropbox"),
            ("/home/u/OneDrive/a", "OneDrive"),
            ("/home/u/GoogleDrive/a", "Google Drive"),
            ("/home/u/google-drive/a", "Google Drive"),
            ("/home/u/Nextcloud/a", "Nextcloud"),
            ("/home/u/ownCloud/a", "ownCloud"),
            ("/home/u/pCloudDrive/a", "pCloud"),
        ] {
            assert_eq!(svc("linux", &e, f), Some(s.to_string()), "{f}");
        }
        assert_eq!(svc("linux", &e, "/home/u/Documents/a"), None);
        assert!(cloud_roots("linux", &CloudEnv::default()).is_empty());
    }

    /// R10: LAS_CLOUD_ROOTS only in debug builds; missing / bad info.json skipped silently.
    #[test]
    fn debug_roots_and_bad_info() {
        assert!(debug_roots(false, Some("/tmp/a")).is_empty(), "release builds ignore LAS_CLOUD_ROOTS");
        let sep = if cfg!(windows) { ";" } else { ":" };
        let abs = if cfg!(windows) { r"C:\t\a" } else { "/t/a" };
        let raw = format!("{abs}{sep}relative{sep}");
        assert_eq!(debug_roots(true, Some(&raw)), vec![abs.to_string()]);
        let e = CloudEnv { debug_roots: vec!["/t/a".into()], dropbox_info: vec!["".into(), "[]".into()], ..Default::default() };
        assert_eq!(svc("linux", &e, "/t/a/x"), Some("Test cloud".into()));
        assert_eq!(dropbox_paths("{\"personal\": 3}"), Vec::<String>::new());
    }

    /// R10: a symlinked ~/Dropbox resolves to its target (both sides are made canonical).
    #[cfg(unix)]
    #[test]
    fn symlinked_dropbox() {
        let base = std::env::temp_dir().join(format!("las-p3-cloud-{}", uuid::Uuid::new_v4().simple()));
        let real = base.join("real-dropbox");
        let home = base.join("home");
        fs::create_dir_all(real.join("Lab")).unwrap();
        fs::create_dir_all(&home).unwrap();
        std::os::unix::fs::symlink(&real, home.join("Dropbox")).unwrap();
        let e = CloudEnv { home: Some(home.to_string_lossy().into_owned()), ..Default::default() };
        // the file is reached through the real folder; the root is the symlink
        let i = cloud_info_in("linux", &real.join("Lab"), &e);
        assert!(i.cloud);
        assert_eq!(i.service.as_deref(), Some("Dropbox"));
        assert_eq!(PathBuf::from(i.root.unwrap()), fs::canonicalize(&real).unwrap());
        // and through the symlink
        assert!(cloud_info_in("linux", &home.join("Dropbox").join("Lab"), &e).cloud);
        assert!(!cloud_info_in("linux", &home, &e).cloud);
        // the command: relative refused, a file's folder is used
        assert_eq!(cloud_info("rel/x.lag").unwrap_err().kind, crate::graphfile::ErrKind::Invalid);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn wire_shape() {
        let v = serde_json::to_value(CloudInfo { cloud: true, service: Some("Dropbox".into()), root: Some("/x".into()) }).unwrap();
        assert_eq!(v, serde_json::json!({"cloud": true, "service": "Dropbox", "root": "/x"}));
        assert_eq!(serde_json::to_value(CloudInfo::none()).unwrap(), serde_json::json!({"cloud": false, "service": null, "root": null}));
    }
}
