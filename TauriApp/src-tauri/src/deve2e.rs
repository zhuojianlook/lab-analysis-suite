//! DEBUG BUILDS ONLY: a self-test hook for the analysis-file features.
//!
//! `lib.rs` declares this module and registers its commands only under
//! `cfg(debug_assertions)`, so a release build contains none of it. The
//! frontend half (`src/components/graph/file/e2e.ts`) is loaded only when
//! `import.meta.env.DEV`. Nothing happens unless `LAS_E2E_SCRIPT` names a JSON
//! script: then the page runs the scripted steps through the real controller
//! and Rust commands, writes `LAS_STATE_DIR/e2e-result.json` and quits.
//!
//! The file operations here stand in for Finder / another computer (rename,
//! copy over, delete). They are refused outside the script's `roots`.

use crate::quit::{QuitDriver, QuitSource};
use serde_json::Value;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use tauri::Manager;

pub const ENV_SCRIPT: &str = "LAS_E2E_SCRIPT";

fn script() -> Result<Option<Value>, String> {
    let Some(p) = std::env::var_os(ENV_SCRIPT).filter(|v| !v.is_empty()) else { return Ok(None) };
    let text = std::fs::read_to_string(&p).map_err(|e| format!("e2e script {}: {e}", PathBuf::from(&p).display()))?;
    serde_json::from_str(&text).map(Some).map_err(|e| format!("e2e script: {e}"))
}

fn roots() -> Vec<PathBuf> {
    script()
        .ok()
        .flatten()
        .and_then(|s| s.get("roots").and_then(|r| r.as_array()).cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|v| v.as_str().map(PathBuf::from))
        .filter(|p| p.is_absolute())
        .collect()
}

/// Absolute, no `..`, inside one of the script's roots.
fn allowed(p: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(p);
    if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(format!("e2e: refused path {p:?}"));
    }
    if roots().iter().any(|r| path.starts_with(r)) {
        Ok(path)
    } else {
        Err(format!("e2e: {p:?} is outside the script's roots"))
    }
}

fn state_dir() -> Result<PathBuf, String> {
    std::env::var_os(crate::devenv::ENV_STATE_DIR)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| "e2e: LAS_STATE_DIR is not set".to_string())
}

#[tauri::command]
pub fn dev_e2e_script() -> Result<Option<Value>, String> {
    script()
}

#[tauri::command]
pub fn dev_e2e_result(result: Value) -> Result<String, String> {
    let p = state_dir()?.join("e2e-result.json");
    let text = serde_json::to_string_pretty(&result).map_err(|e| e.to_string())?;
    std::fs::write(&p, text).map_err(|e| format!("e2e: write {}: {e}", p.display()))?;
    Ok(p.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn dev_e2e_log(line: String) {
    eprintln!("[e2e] {line}");
    log::info!("[e2e] {line}");
}

/// rename {path → to} · copyOver {path → to: written beside `to`, then renamed
/// over it, like a sync client; `to` need not exist} · remove {path} · list
/// {path: folder → every name, hidden ones too} · exists {path} · mkdir {path}
/// · menu {path: a menu item id such as "file.versions" → `app://menu` is
/// emitted exactly as a click on that item does; Quit is refused, use
/// `dev_e2e_quit`}.
/// Phase 3: writeText {path, to: the text → written atomically, like a sync
/// client placing another computer's note} · readText {path → the text, or
/// null when there is no such file} · wake {path: "<gapMs>" → exactly what
/// the poll thread does after a sleep gap: the note heartbeat stops and
/// `graphfile://event {type: "wake", gapMs}` is emitted}. `list` includes
/// `.laguse` names (it lists every name).
#[tauri::command]
pub fn dev_e2e_fs(app: tauri::AppHandle, op: String, path: String, to: Option<String>) -> Result<Value, String> {
    if op == "menu" {
        return menu_click(&app, &path);
    }
    if op == "wake" {
        let gap: i64 = path.trim().parse().map_err(|_| format!("e2e: wake needs the gap in ms, got {path:?}"))?;
        let ctx = app.try_state::<Arc<crate::graphfile::FileCtx>>().ok_or("e2e: no file context")?;
        crate::presence::on_wake(&ctx, gap);
        return Ok(Value::Null);
    }
    let p = allowed(&path)?;
    let target = || -> Result<PathBuf, String> { allowed(to.as_deref().ok_or("e2e: `to` missing")?) };
    match op.as_str() {
        "rename" => {
            let t = target()?;
            std::fs::rename(&p, &t).map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "copyOver" => {
            let t = target()?;
            let dir = t.parent().ok_or("e2e: no parent")?;
            let tmp = dir.join(format!(".~e2e-{}.tmp-{:08x}", std::process::id(), rand32()));
            std::fs::copy(&p, &tmp).map_err(|e| e.to_string())?;
            std::fs::rename(&tmp, &t).map_err(|e| {
                let _ = std::fs::remove_file(&tmp);
                e.to_string()
            })?;
            Ok(Value::Null)
        }
        "remove" => {
            std::fs::remove_file(&p).map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "writeText" => {
            let text = to.as_deref().ok_or("e2e: `to` (the text) missing")?;
            if text.len() > 64 * 1024 {
                return Err("e2e: writeText is for small files".into());
            }
            let dir = p.parent().ok_or("e2e: no parent")?;
            let tmp = dir.join(format!(".~e2e-{}.tmp-{:08x}", std::process::id(), rand32()));
            std::fs::write(&tmp, text.as_bytes()).map_err(|e| e.to_string())?;
            std::fs::rename(&tmp, &p).map_err(|e| {
                let _ = std::fs::remove_file(&tmp);
                e.to_string()
            })?;
            Ok(Value::Null)
        }
        "readText" => match std::fs::read(&p) {
            Ok(b) => Ok(Value::from(String::from_utf8_lossy(&b).into_owned())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
            Err(e) => Err(e.to_string()),
        },
        "list" => {
            let mut names: Vec<String> = std::fs::read_dir(&p)
                .map_err(|e| e.to_string())?
                .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
                .collect();
            names.sort();
            Ok(Value::from(names))
        }
        "exists" => Ok(Value::from(Path::new(&p).exists())),
        "mkdir" => {
            std::fs::create_dir_all(&p).map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        other => Err(format!("e2e: unknown op {other:?}")),
    }
}

/// The `menu` op: what `menu::on_click` emits for a click on `id`.
fn menu_click(app: &tauri::AppHandle, id: &str) -> Result<Value, String> {
    use tauri::Emitter;
    if id == crate::menu::QUIT {
        return Err("e2e: use dev_e2e_quit to quit".into());
    }
    let ev = crate::menu::resolve_click(id, &[]).ok_or_else(|| format!("e2e: unknown menu item {id:?}"))?;
    app.emit(crate::menu::EVT_MENU, &ev).map_err(|e| e.to_string())?;
    Ok(Value::Null)
}

fn rand32() -> u32 {
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    n ^ std::process::id().rotate_left(16)
}

/// Ask to quit the way a person would: `menu` (Quit item / Cmd+Q), `window`
/// (the red close button), `terminate` (macOS: NSApp terminate:, which is what
/// Dock Quit, logout and AppleScript quit send — through the
/// applicationShouldTerminate: hook).
#[tauri::command]
pub fn dev_e2e_quit(app: tauri::AppHandle, quit: tauri::State<'_, Arc<QuitDriver>>, how: String) -> Result<(), String> {
    match how.as_str() {
        "menu" => {
            quit.request(QuitSource::Menu);
            Ok(())
        }
        "window" => {
            let w = app.get_webview_window("main").ok_or("e2e: no main window")?;
            w.close().map_err(|e| e.to_string())
        }
        "terminate" => {
            #[cfg(target_os = "macos")]
            {
                app.run_on_main_thread(|| {
                    if let Some(mtm) = objc2::MainThreadMarker::new() {
                        objc2_app_kit::NSApplication::sharedApplication(mtm).terminate(None);
                    }
                })
                .map_err(|e| e.to_string())
            }
            #[cfg(not(target_os = "macos"))]
            {
                quit.request(QuitSource::System);
                Ok(())
            }
        }
        other => Err(format!("e2e: unknown quit {other:?}")),
    }
}
