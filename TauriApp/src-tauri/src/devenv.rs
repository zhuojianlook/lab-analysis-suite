//! Which engine port and which state folder this build uses.
//!
//! Release builds: the bundled engine on a free port picked at each start
//! (engine.rs), and the app's own data folder for its records (overridable
//! with `LAS_STATE_DIR`).
//!
//! Falling back to 8765 (the port release builds used up to 0.2.22, still used
//! by other apps' engines) or to the app data folder would silently talk to —
//! and write into — another app or the installed copy of this one. A debug build therefore
//! refuses to start unless both `LAS_SIDECAR_PORT` and `LAS_STATE_DIR` are
//! set, and refuses the installed app's port and folders even when they are
//! given explicitly. It also runs under its own identifier (`DEV_IDENTIFIER`),
//! so the folders Tauri and its plugins derive from the identifier (config,
//! data, cache, logs) are never the installed app's.

use std::path::{Component, Path, PathBuf};

/// The fixed engine port release builds used up to 0.2.22 (and other apps'
/// engines still use). Nothing listens on it for this app any more; it is kept
/// so a debug build refuses it and the port picker never chooses it.
pub const RELEASE_SIDECAR_PORT: u16 = 8765;
/// The installed app's bundle identifier (tauri.conf.json `identifier`).
pub const RELEASE_IDENTIFIER: &str = "com.zhuojianlook.analysis";
/// Identifier a debug build runs under instead.
pub const DEV_IDENTIFIER: &str = "com.zhuojianlook.analysis.dev";
/// Name of the engine's data folder (python-sidecar/r_settings.py APP_IDENTIFIER).
pub const ENGINE_DATA_NAME: &str = "LabAnalysisSuite";

pub const ENV_SIDECAR_PORT: &str = "LAS_SIDECAR_PORT";
pub const ENV_STATE_DIR: &str = "LAS_STATE_DIR";

#[derive(Debug, PartialEq, Eq)]
pub struct DevEnv {
    pub port: u16,
    pub state_dir: PathBuf,
}

/// Read the two variables a debug build needs. Empty counts as unset.
pub fn dev_env_from_process() -> Result<DevEnv, String> {
    let port = std::env::var(ENV_SIDECAR_PORT).ok();
    let state = std::env::var(ENV_STATE_DIR).ok();
    let forbidden = installed_app_dirs(std::env::consts::OS, &|k| {
        std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from)
    });
    parse_dev_env(port.as_deref(), state.as_deref(), &forbidden)
}

/// Folders that belong to the installed app on `os`: everything Tauri derives
/// from its identifier (app data / config / cache / logs / WebKit) and the
/// engine's data folder. `env` reads an environment variable.
pub fn installed_app_dirs(os: &str, env: &dyn Fn(&str) -> Option<PathBuf>) -> Vec<PathBuf> {
    let home = env("HOME").or_else(|| env("USERPROFILE"));
    let mut bases: Vec<PathBuf> = Vec::new();
    match os {
        "macos" | "ios" => {
            if let Some(h) = &home {
                for sub in ["Library/Application Support", "Library/Caches", "Library/Logs", "Library/WebKit", "Library/Preferences"] {
                    bases.push(h.join(sub));
                }
            }
        }
        "windows" => {
            for k in ["APPDATA", "LOCALAPPDATA"] {
                if let Some(p) = env(k) {
                    bases.push(p);
                }
            }
        }
        _ => {
            for (var, fallback) in [("XDG_DATA_HOME", ".local/share"), ("XDG_CONFIG_HOME", ".config"), ("XDG_CACHE_HOME", ".cache")] {
                if let Some(p) = env(var).or_else(|| home.as_ref().map(|h| h.join(fallback))) {
                    bases.push(p);
                }
            }
        }
    }
    let mut out = Vec::new();
    for b in bases {
        for name in [RELEASE_IDENTIFIER, ENGINE_DATA_NAME] {
            let p = b.join(name);
            if !out.contains(&p) {
                out.push(p);
            }
        }
    }
    out
}

/// `path` with `.` dropped and `..` applied (no file system access).
fn lexical(path: &Path) -> Vec<String> {
    let fold = cfg!(any(target_os = "macos", target_os = "windows")); // case-insensitive by default there
    let mut parts: Vec<String> = Vec::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                parts.pop();
            }
            other => {
                let s = other.as_os_str().to_string_lossy().into_owned();
                parts.push(if fold { s.to_lowercase() } else { s });
            }
        }
    }
    parts
}

/// Is `path` the same as or inside `dir` (lexically)?
pub fn is_within(path: &Path, dir: &Path) -> bool {
    let (p, d) = (lexical(path), lexical(dir));
    p.len() >= d.len() && p[..d.len()] == d[..]
}

/// Validate the debug-build settings. All problems are reported at once.
/// `forbidden`: the installed app's folders (see installed_app_dirs).
pub fn parse_dev_env(port: Option<&str>, state_dir: Option<&str>, forbidden: &[PathBuf]) -> Result<DevEnv, String> {
    let mut problems: Vec<String> = Vec::new();

    let port = match port.map(str::trim).filter(|s| !s.is_empty()) {
        None => {
            problems.push(format!(
                "{ENV_SIDECAR_PORT} is not set (the port of the dev engine you started, e.g. 8766)"
            ));
            None
        }
        Some(raw) => match raw.parse::<u16>() {
            Ok(RELEASE_SIDECAR_PORT) => {
                problems.push(format!(
                    "{ENV_SIDECAR_PORT}={RELEASE_SIDECAR_PORT} is the installed app's engine port; use another (e.g. 8766)"
                ));
                None
            }
            Ok(p) if p > 0 => Some(p),
            _ => {
                problems.push(format!("{ENV_SIDECAR_PORT}={raw:?} is not a port number (1-65535)"));
                None
            }
        },
    };

    let state_dir = match state_dir.map(str::trim).filter(|s| !s.is_empty()) {
        None => {
            problems.push(format!(
                "{ENV_STATE_DIR} is not set (a scratch folder for this build's records, e.g. one made with mktemp -d)"
            ));
            None
        }
        Some(raw) => {
            let p = PathBuf::from(raw);
            if let Some(dir) = forbidden.iter().find(|d| p.is_absolute() && is_within(&p, d)) {
                problems.push(format!(
                    "{ENV_STATE_DIR}={raw:?} is inside the installed app's folder {}",
                    dir.display()
                ));
                None
            } else if p.is_absolute() {
                Some(p)
            } else {
                problems.push(format!("{ENV_STATE_DIR}={raw:?} must be an absolute path"));
                None
            }
        }
    };

    match (port, state_dir) {
        (Some(port), Some(state_dir)) if problems.is_empty() => Ok(DevEnv { port, state_dir }),
        _ => Err(format!(
            "Debug build refused to start:\n  - {}\n\
             A debug build never uses port {RELEASE_SIDECAR_PORT} or the app's own folders, \
             because those belong to the installed Lab Analysis Suite.\n\
             Example:\n  \
             {ENV_SIDECAR_PORT}=8766 {ENV_STATE_DIR}=\"$(mktemp -d)\" npm run tauri dev\n\
             (start the dev engine first: python python-sidecar/api_server.py --port 8766)",
            problems.join("\n  - ")
        )),
    }
}

/// Release builds: `LAS_STATE_DIR` when set to an absolute path, otherwise the
/// app data folder. Nothing is created here.
pub fn release_state_dir(env_override: Option<&str>, app_data_dir: Option<PathBuf>) -> Option<PathBuf> {
    env_override
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(Path::new)
        .filter(|p| p.is_absolute())
        .map(Path::to_path_buf)
        .or(app_data_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_set_is_ok() {
        let env = parse_dev_env(Some("8766"), Some("/tmp/las-state"), &[]).unwrap();
        assert_eq!(env, DevEnv { port: 8766, state_dir: PathBuf::from("/tmp/las-state") });
    }

    #[test]
    fn whitespace_is_trimmed() {
        let env = parse_dev_env(Some(" 8766 "), Some(" /tmp/x "), &[]).unwrap();
        assert_eq!(env.port, 8766);
        assert_eq!(env.state_dir, PathBuf::from("/tmp/x"));
    }

    #[test]
    fn unset_port_fails_and_never_defaults_to_release_port() {
        let err = parse_dev_env(None, Some("/tmp/x"), &[]).unwrap_err();
        assert!(err.contains("LAS_SIDECAR_PORT is not set"), "{err}");
        assert!(!err.contains("LAS_STATE_DIR is not set"), "{err}");
    }

    #[test]
    fn empty_counts_as_unset() {
        let err = parse_dev_env(Some(""), Some("  "), &[]).unwrap_err();
        assert!(err.contains("LAS_SIDECAR_PORT is not set"), "{err}");
        assert!(err.contains("LAS_STATE_DIR is not set"), "{err}");
    }

    #[test]
    fn both_unset_reports_both() {
        let err = parse_dev_env(None, None, &[]).unwrap_err();
        assert!(err.contains("LAS_SIDECAR_PORT is not set"), "{err}");
        assert!(err.contains("LAS_STATE_DIR is not set"), "{err}");
    }

    #[test]
    fn bad_port_rejected() {
        for bad in ["0", "65536", "-1", "abc", "8766x"] {
            let err = parse_dev_env(Some(bad), Some("/tmp/x"), &[]).unwrap_err();
            assert!(err.contains("is not a port number"), "{bad}: {err}");
        }
    }

    #[test]
    fn relative_state_dir_rejected() {
        let err = parse_dev_env(Some("8766"), Some("state"), &[]).unwrap_err();
        assert!(err.contains("must be an absolute path"), "{err}");
    }

    #[test]
    fn release_state_dir_prefers_absolute_override() {
        let app = Some(PathBuf::from("/app/data"));
        assert_eq!(release_state_dir(Some("/o"), app.clone()), Some(PathBuf::from("/o")));
        assert_eq!(release_state_dir(Some(""), app.clone()), app);
        assert_eq!(release_state_dir(Some("rel"), app.clone()), app);
        assert_eq!(release_state_dir(None, app.clone()), app);
        assert_eq!(release_state_dir(None, None), None);
    }

    fn mac_env(k: &str) -> Option<PathBuf> {
        (k == "HOME").then(|| PathBuf::from("/Users/u"))
    }

    #[test]
    fn release_port_rejected_even_when_given() {
        let err = parse_dev_env(Some("8765"), Some("/tmp/x"), &[]).unwrap_err();
        assert!(err.contains("installed app's engine port"), "{err}");
    }

    #[test]
    fn state_dir_inside_installed_app_folders_rejected() {
        let forbidden = installed_app_dirs("macos", &mac_env);
        for bad in [
            "/Users/u/Library/Application Support/com.zhuojianlook.analysis",
            "/Users/u/Library/Application Support/com.zhuojianlook.analysis/dev",
            "/Users/u/Library/Application Support/LabAnalysisSuite/x",
            "/Users/u/Library/Logs/com.zhuojianlook.analysis",
            "/Users/u/Library/Application Support/x/../com.zhuojianlook.analysis/./y",
        ] {
            let err = parse_dev_env(Some("8766"), Some(bad), &forbidden).unwrap_err();
            assert!(err.contains("inside the installed app's folder"), "{bad}: {err}");
        }
        if cfg!(target_os = "macos") {
            // APFS is case-insensitive by default.
            let err = parse_dev_env(Some("8766"), Some("/Users/u/library/application support/LABANALYSISSUITE"), &forbidden).unwrap_err();
            assert!(err.contains("inside the installed app's folder"), "{err}");
        }
        for ok in [
            "/tmp/las-state",
            "/Users/u/Library/Application Support/com.zhuojianlook.analysis.dev",
            "/Users/u/Library/Application Support/com.zhuojianlook.analysis-x",
        ] {
            assert!(parse_dev_env(Some("8766"), Some(ok), &forbidden).is_ok(), "{ok}");
        }
    }

    #[test]
    fn installed_app_dirs_per_os() {
        let mac = installed_app_dirs("macos", &mac_env);
        assert!(mac.contains(&PathBuf::from("/Users/u/Library/Application Support/com.zhuojianlook.analysis")));
        assert!(mac.contains(&PathBuf::from("/Users/u/Library/Application Support/LabAnalysisSuite")));
        assert!(mac.contains(&PathBuf::from("/Users/u/Library/Logs/com.zhuojianlook.analysis")));
        let linux = installed_app_dirs("linux", &|k| match k {
            "HOME" => Some(PathBuf::from("/home/u")),
            "XDG_CONFIG_HOME" => Some(PathBuf::from("/cfg")),
            _ => None,
        });
        assert!(linux.contains(&PathBuf::from("/home/u/.local/share/com.zhuojianlook.analysis")));
        assert!(linux.contains(&PathBuf::from("/cfg/LabAnalysisSuite")));
        assert!(linux.contains(&PathBuf::from("/home/u/.cache/com.zhuojianlook.analysis")));
        let win = installed_app_dirs("windows", &|k| (k == "APPDATA").then(|| PathBuf::from("C:/Users/u/AppData/Roaming")));
        assert_eq!(win, vec![
            PathBuf::from("C:/Users/u/AppData/Roaming/com.zhuojianlook.analysis"),
            PathBuf::from("C:/Users/u/AppData/Roaming/LabAnalysisSuite"),
        ]);
        assert!(installed_app_dirs("macos", &|_| None).is_empty());
    }

    #[test]
    fn release_identifier_matches_tauri_conf() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], RELEASE_IDENTIFIER);
        assert_ne!(DEV_IDENTIFIER, RELEASE_IDENTIFIER);
    }
}
