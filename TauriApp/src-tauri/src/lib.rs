mod appstate;
mod cloud;
mod devenv;
mod engine;
// Debug builds only: the files self-test hook (LAS_E2E_SCRIPT).
#[cfg(debug_assertions)]
mod deve2e;
mod engineproc;
mod graphfile;
mod graphwatch;
mod menu;
mod opens;
mod presence;
mod quit;
#[cfg(target_os = "macos")]
mod quit_macos;

use graphfile::FileCtx;
use quit::{Act, FinishHow, QuitDriver, QuitSource};
use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_updater::UpdaterExt;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use engine::Engine;

#[derive(serde::Serialize, Clone)]
struct UpdateProgress {
    downloaded: u64,
    total: Option<u64>,
}

#[tauri::command]
fn get_sidecar_port(state: tauri::State<'_, Arc<Engine>>) -> u16 {
    state.port()
}

#[tauri::command]
fn get_sidecar_error(state: tauri::State<'_, Arc<Engine>>) -> Option<String> {
    state.last_error()
}

/// HTTP client that never routes through a system/env proxy. The sidecar lives
/// on 127.0.0.1, but a configured HTTP(S)_PROXY / ALL_PROXY env var or a macOS
/// system proxy would otherwise make reqwest try to proxy localhost and fail
/// with "error sending request" — even though the sidecar is up (curl works).
///
/// Timeouts: connecting to a local engine takes milliseconds, so 5 s without a
/// connection means it is not there (or hung). The overall limit has to cover
/// the longest request the engine answers synchronously: R console commands
/// (`/api/analysis/run-console`, up to 600 s) and R plots (120 s); long R jobs
/// and package installs are polled, not held open. 15 minutes leaves room.
///
/// No idle connections are kept (`pool_max_idle_per_host(0)`): the engine
/// (uvicorn) closes an idle keep-alive connection after 5 s, and a request
/// sent on a pooled connection at that moment fails with a reset although the
/// engine is fine. A new local connection per request costs well under 1 ms.
fn local_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| local_client_builder().build().unwrap_or_else(|_| reqwest::Client::new()))
}

fn local_client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .no_proxy()
        .pool_max_idle_per_host(0)
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15 * 60))
}

/// The engine's port, if a request may be sent there now (engine.rs
/// `request_gate`): only this launch's confirmed engine, never another
/// program that answers on the port. A debug build's external engine is
/// health-checked here before the first request (the frontend's own health
/// poll may not have run yet).
async fn engine_port_for_request(eng: &Engine) -> Result<u16, String> {
    if eng.external_unchecked() {
        if let Ok(body) = probe_health(eng.port()).await {
            judge_health(eng, &body);
        }
    }
    eng.may_send().map_err(|why| format!("{ENGINE_NOT_ANSWERING} {why}"))?;
    Ok(eng.port())
}

const ENGINE_NOT_ANSWERING: &str = "The analysis engine isn't answering.";

/// User-facing text for a failed request to the engine.
fn engine_request_error(e: &reqwest::Error, what: &str) -> String {
    if e.is_timeout() && !e.is_connect() {
        format!("{ENGINE_NOT_ANSWERING} No reply within 15 minutes. ({e})")
    } else if e.is_connect() || e.is_request() || e.is_body() {
        // Refused, connect timeout, or the connection dropped mid-request
        // (the engine stopped; the app restarts it).
        format!("{ENGINE_NOT_ANSWERING} It may be starting or restarting; try again in a moment. ({e})")
    } else {
        format!("{what} failed: {e}")
    }
}

/// Proxy HTTP requests to the sidecar through Rust, bypassing WebView restrictions
/// on localhost (WKWebView / WebView2 block fetch() to http://127.0.0.1).
/// The port is read per request: it changes when the engine is restarted.
#[tauri::command]
async fn proxy_request(
    method: String,
    path: String,
    body: Option<String>,
    state: tauri::State<'_, Arc<Engine>>,
) -> Result<String, String> {
    let port = engine_port_for_request(&state).await?;
    let url = format!("http://127.0.0.1:{}{}", port, path);
    let client = local_client();

    let req = match method.to_uppercase().as_str() {
        "GET" => client.get(&url),
        "POST" => {
            let mut r = client.post(&url);
            if let Some(b) = body {
                r = r.header("Content-Type", "application/json").body(b);
            }
            r
        }
        "PUT" => {
            let mut r = client.put(&url);
            if let Some(b) = body {
                r = r.header("Content-Type", "application/json").body(b);
            }
            r
        }
        "PATCH" => {
            let mut r = client.patch(&url);
            if let Some(b) = body {
                r = r.header("Content-Type", "application/json").body(b);
            }
            r
        }
        "DELETE" => client.delete(&url),
        _ => return Err(format!("Unsupported method: {}", method)),
    };

    let resp = req.send().await.map_err(|e| engine_request_error(&e, "Request"))?;
    let text = resp.text().await.map_err(|e| engine_request_error(&e, "Reading the response"))?;
    Ok(text)
}

/// The engine's state for the status indicators and the R tool gates:
/// `state` is "ok" (this launch's engine answered with its token), "starting",
/// "restarting", "foreign" (another program answers on the engine's port) or
/// "down". The token itself never leaves Rust.
#[derive(serde::Serialize)]
struct EngineHealth {
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    port: u16,
    /// Changes every time the engine is (re)started.
    generation: u32,
}

#[tauri::command]
async fn engine_health(state: tauri::State<'_, Arc<Engine>>) -> Result<EngineHealth, String> {
    use engine::{Status, Verdict};
    let eng = state.inner().clone();
    let port = eng.port();
    let generation = eng.generation();
    let status = eng.status();
    let out = |state: &'static str, detail: Option<String>| Ok(EngineHealth { state, detail, port, generation });
    match &status {
        Status::Restarting { attempt } => {
            return out("restarting", Some(format!("The analysis engine stopped unexpectedly; restarting it (attempt {attempt}).")))
        }
        Status::Down(msg) => return out("down", Some(msg.clone())),
        Status::Stopped => return out("down", Some("The analysis engine was stopped.".into())),
        _ => {}
    }
    if port == 0 {
        return out("starting", None);
    }
    let body = match probe_health(port).await {
        Ok(body) => body,
        Err(e) => {
            return if status == Status::Starting {
                out("starting", None)
            } else {
                out("down", Some(format!("{ENGINE_NOT_ANSWERING} (port {port}: {e})")))
            }
        }
    };
    match judge_health(&eng, &body) {
        Verdict::Ours => out(engine::state_when_ours(&status), None),
        Verdict::Foreign(why) => out(
            "foreign",
            Some(format!(
                "Another program is answering on the engine's port {port}: {why}. It is not used."
            )),
        ),
    }
}

/// GET /api/health on the engine's port; the body of any answer.
async fn probe_health(port: u16) -> Result<String, reqwest::Error> {
    static HEALTH_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    let client = HEALTH_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .no_proxy()
            .pool_max_idle_per_host(0) // see local_client
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    });
    let r = client.get(format!("http://127.0.0.1:{port}/api/health")).send().await?;
    Ok(r.text().await.unwrap_or_default())
}

/// Judge a health answer; for a debug build's external engine (no supervisor
/// confirming it) also remember the verdict, which the proxy relies on.
fn judge_health(eng: &Engine, body: &str) -> engine::Verdict {
    let verdict = engine::verify_health(body, eng.token().as_deref());
    if eng.status() == engine::Status::External {
        eng.note_external(match verdict {
            engine::Verdict::Ours => engine::ExternalVerdict::Ours,
            engine::Verdict::Foreign(_) => engine::ExternalVerdict::Foreign,
        });
    }
    verdict
}

/// Start the engine again after the app gave up restarting it (the gates'
/// Try again while the engine is down). True when a new start was begun.
#[tauri::command]
fn restart_engine(state: tauri::State<'_, Arc<Engine>>) -> bool {
    state.inner().restart()
}

/// Kill the sidecar process — called before update restart. Final: the
/// engine is not restarted afterwards.
#[tauri::command]
async fn kill_sidecar(state: tauri::State<'_, Arc<Engine>>) -> Result<(), String> {
    state.stop();
    Ok(())
}

#[tauri::command]
async fn download_and_install_update(
    app: tauri::AppHandle,
    manifest_url: String,
) -> Result<String, String> {
    eprintln!("[updater] Checking update from: {}", manifest_url);
    let url = url::Url::parse(&manifest_url)
        .map_err(|e| format!("Invalid URL: {}", e))?;
    let updater = app.updater_builder()
        .endpoints(vec![url])
        .map_err(|e| format!("Failed to set endpoints: {}", e))?
        .build()
        .map_err(|e| format!("Failed to build updater: {}", e))?;

    let update = updater.check().await
        .map_err(|e| format!("Update check failed: {}", e))?;
    let update = update.ok_or_else(|| "No update available".to_string())?;
    eprintln!("[updater] Got update: version={}", update.version);

    let mut total_downloaded = 0u64;
    let app_for_progress = app.clone();
    let app_for_finished = app.clone();
    update.download_and_install(
        move |chunk, total| {
            total_downloaded += chunk as u64;
            let _ = app_for_progress.emit(
                "updater://progress",
                UpdateProgress { downloaded: total_downloaded, total },
            );
        },
        move || {
            let _ = app_for_finished.emit::<()>("updater://finished", ());
            eprintln!("[updater] Download complete, installing...");
        },
    ).await.map_err(|e| format!("Download/install failed: {}", e))?;

    Ok("Installed. Please restart the app to apply.".to_string())
}

/// Check a specific channel's manifest (stable or experimental) without
/// installing. Returns {available, version, notes}.
#[tauri::command]
async fn check_update(app: tauri::AppHandle, manifest_url: String) -> Result<serde_json::Value, String> {
    let url = url::Url::parse(&manifest_url).map_err(|e| format!("Invalid URL: {}", e))?;
    let updater = app.updater_builder()
        .endpoints(vec![url]).map_err(|e| format!("Failed to set endpoints: {}", e))?
        .build().map_err(|e| format!("Failed to build updater: {}", e))?;
    let update = updater.check().await.map_err(|e| format!("Update check failed: {}", e))?;
    Ok(match update {
        Some(u) => serde_json::json!({ "available": true, "version": u.version, "notes": u.body }),
        None => serde_json::json!({ "available": false, "version": "", "notes": null }),
    })
}

#[tauri::command]
async fn save_base64_to_path(path: String, data_b64: String) -> Result<(), String> {
    let bytes = base64_decode(&data_b64).map_err(|e| format!("Base64 decode: {}", e))?;
    let expected_len = bytes.len();
    std::fs::write(&path, &bytes).map_err(|e| format!("Write failed: {}", e))?;
    // Post-write verification — surface a real error if the filesystem
    // silently truncated the write (disk full, quota, write-through lag).
    match std::fs::metadata(&path) {
        Ok(meta) => {
            let written = meta.len() as usize;
            if written < expected_len.max(1) {
                let _ = std::fs::remove_file(&path);
                return Err(format!(
                    "Save incomplete: wrote {} bytes, expected {} (disk may be full).",
                    written, expected_len
                ));
            }
        }
        Err(e) => return Err(format!("Verify failed: {}", e)),
    }
    Ok(())
}

/// Move a file from `src` to `dest`. Same-volume rename with copy+remove fallback.
#[tauri::command]
async fn move_file(src: String, dest: String) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&dest).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match std::fs::rename(&src, &dest) {
        Ok(()) => Ok(()),
        Err(_) => {
            std::fs::copy(&src, &dest).map_err(|e| format!("Copy failed: {}", e))?;
            let _ = std::fs::remove_file(&src);
            Ok(())
        }
    }
}

/// Return a file's size in bytes, or -1 if it doesn't exist.
#[tauri::command]
async fn file_size(path: String) -> Result<i64, String> {
    match std::fs::metadata(&path) {
        Ok(meta) => Ok(meta.len() as i64),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(-1),
        Err(e) => Err(format!("Stat failed: {}", e)),
    }
}

/// Delete a file. Succeeds silently if it's already gone.
#[tauri::command]
async fn delete_file(path: String) -> Result<(), String> {
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Delete failed: {}", e)),
    }
}

/// Open a URL with the OS default handler.
#[tauri::command]
async fn open_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(&url).spawn().map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd").args(["/C", "start", "", &url]).spawn().map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        std::process::Command::new("xdg-open").arg(&url).spawn().map_err(|e| e.to_string())?;
        Ok(())
    }
}

/// Proxy a multipart file upload (base64 payloads) to the sidecar through Rust.
#[tauri::command]
async fn proxy_upload(
    path: String,
    files: Vec<FileData>,
    field_name: String,
    state: tauri::State<'_, Arc<Engine>>,
) -> Result<String, String> {
    let port = engine_port_for_request(&state).await?;
    let url = format!("http://127.0.0.1:{}{}", port, path);
    let client = local_client();

    let mut form = reqwest::multipart::Form::new();
    for file in files {
        let decoded = base64_decode(&file.data).map_err(|e| format!("Base64 decode error: {}", e))?;
        let part = reqwest::multipart::Part::bytes(decoded)
            .file_name(file.name)
            .mime_str("application/octet-stream")
            .map_err(|e| format!("MIME error: {}", e))?;
        form = form.part(field_name.clone(), part);
    }

    let resp = client.post(&url).multipart(form).send().await
        .map_err(|e| engine_request_error(&e, "Upload"))?;
    let text = resp.text().await
        .map_err(|e| engine_request_error(&e, "Reading the upload response"))?;
    Ok(text)
}

#[derive(serde::Deserialize)]
struct FileData {
    name: String,
    data: String,  // base64 encoded
}

/// Upload files directly from disk paths — avoids base64/IPC size limits.
#[tauri::command]
async fn upload_files_from_paths(
    api_path: String,
    file_paths: Vec<String>,
    field_name: String,
    state: tauri::State<'_, Arc<Engine>>,
) -> Result<String, String> {
    let port = engine_port_for_request(&state).await?;
    let url = format!("http://127.0.0.1:{}{}", port, api_path);
    let client = local_client();

    let mut form = reqwest::multipart::Form::new();
    for file_path in &file_paths {
        let path = std::path::Path::new(file_path);
        let file_name = path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();
        let data = std::fs::read(path)
            .map_err(|e| format!("Failed to read file {}: {}", file_path, e))?;
        let part = reqwest::multipart::Part::bytes(data)
            .file_name(file_name)
            .mime_str("application/octet-stream")
            .map_err(|e| format!("MIME error: {}", e))?;
        form = form.part(field_name.clone(), part);
    }

    let resp = client.post(&url).multipart(form).send().await
        .map_err(|e| engine_request_error(&e, "Upload"))?;
    let text = resp.text().await
        .map_err(|e| engine_request_error(&e, "Reading the upload response"))?;
    Ok(text)
}

fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    let lookup = |c: u8| -> Result<u8, String> {
        match c {
            b'A'..=b'Z' => Ok(c - b'A'),
            b'a'..=b'z' => Ok(c - b'a' + 26),
            b'0'..=b'9' => Ok(c - b'0' + 52),
            b'+' => Ok(62),
            b'/' => Ok(63),
            b'=' => Ok(0),
            _ => Err(format!("Invalid base64 char: {}", c as char)),
        }
    };
    let bytes: Vec<u8> = input.bytes().filter(|&b| b != b'\n' && b != b'\r').collect();
    let mut result = Vec::with_capacity(bytes.len() * 3 / 4);
    for chunk in bytes.chunks(4) {
        if chunk.len() < 4 { break; }
        let a = lookup(chunk[0])?;
        let b = lookup(chunk[1])?;
        let c = lookup(chunk[2])?;
        let d = lookup(chunk[3])?;
        result.push((a << 2) | (b >> 4));
        if chunk[2] != b'=' { result.push((b << 4) | (c >> 2)); }
        if chunk[3] != b'=' { result.push((c << 6) | d); }
    }
    Ok(result)
}

// ── Phase 1 app commands: opened files, menu state, quit handshake ─────────

/// Files opened before the frontend listened; marks the frontend ready (for
/// open-files events and for the quit handshake).
#[tauri::command]
fn take_pending_opens(quit: tauri::State<'_, Arc<QuitDriver>>, ctx: tauri::State<'_, Arc<FileCtx>>) -> Vec<String> {
    quit.set_frontend_ready();
    // Phase 3: notes left by an earlier launch (crash) and not taken over by a reopened tab.
    presence::schedule_sweep(ctx.inner(), presence::SWEEP_DELAY);
    opens::take()
}

/// Phase 3: delete this computer's notes before the app goes (time-limited; idempotent).
fn delete_own_notes(app: &tauri::AppHandle) {
    if let Some(ctx) = app.try_state::<Arc<FileCtx>>() {
        if !presence::delete_all_own(ctx.inner(), presence::QUIT_DELETE) {
            log::warn!("[presence] not every note could be deleted in time");
        }
    }
}

#[tauri::command]
async fn app_set_menu_state(
    app: tauri::AppHandle,
    handles: tauri::State<'_, menu::MenuHandles<tauri::Wry>>,
    state: menu::MenuState,
) -> Result<(), graphfile::FileErr> {
    menu::apply_state(&app, &handles, &state).map_err(|e| graphfile::FileErr::io(format!("menu: {e}")))
}

#[tauri::command]
fn app_quit_reply(quit: tauri::State<'_, Arc<QuitDriver>>, request_id: u64, stage: String) -> Result<(), graphfile::FileErr> {
    let stage = quit::Stage::parse(&stage).ok_or_else(|| graphfile::FileErr::invalid(format!("unknown stage {stage:?}")))?;
    quit.reply(request_id, stage);
    Ok(())
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn bring_main_window_forward(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Debug builds only: `LAS_DEV_ENGINE_CMD` (a JSON array: program and its
/// first arguments, e.g. `["/path/venv/bin/python", "-B", "/path/api_server.py"]`)
/// makes the app start and supervise the engine exactly like a release build —
/// free port, token, restarts — so that path can be exercised without
/// packaging. Release builds never read it.
#[cfg(debug_assertions)]
fn dev_engine_hook(r_env_dir: Option<String>) -> Result<Option<engine::LaunchSpec>, String> {
    let Some(raw) = std::env::var("LAS_DEV_ENGINE_CMD").ok().filter(|s| !s.trim().is_empty()) else {
        return Ok(None);
    };
    let parts: Vec<String> = serde_json::from_str(&raw)
        .map_err(|e| format!("LAS_DEV_ENGINE_CMD must be a JSON array of strings: {e}"))?;
    let (program, rest) = parts.split_first().ok_or("LAS_DEV_ENGINE_CMD is empty")?;
    Ok(Some(engine::LaunchSpec {
        program: program.into(),
        pre_args: rest.to_vec(),
        cwd: None,
        r_env_dir,
    }))
}

#[cfg(not(debug_assertions))]
fn dev_engine_hook(_r_env_dir: Option<String>) -> Result<Option<engine::LaunchSpec>, String> {
    Ok(None)
}

/// Folder for the app's own records (open tabs, drafts, journal). `None` only
/// if a release build cannot resolve its app data folder.
#[allow(dead_code)] // read by the file features (phase 1)
struct StateDir(Option<std::path::PathBuf>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  // Debug builds: check LAS_SIDECAR_PORT / LAS_STATE_DIR before anything
  // starts, and exit with a plain message (an error returned from the setup
  // hook would abort inside the macOS app delegate with a long backtrace).
  let dev_env: Option<devenv::DevEnv> = if cfg!(debug_assertions) {
    let checked = devenv::dev_env_from_process().and_then(|dev| {
      std::fs::create_dir_all(&dev.state_dir).map_err(|e| {
        format!(
          "Debug build refused to start: cannot create {}={}: {}",
          devenv::ENV_STATE_DIR, dev.state_dir.display(), e
        )
      })?;
      Ok(dev)
    });
    match checked {
      Ok(dev) => Some(dev),
      Err(msg) => {
        eprintln!("\n[dev] {}\n", msg);
        std::process::exit(2);
      }
    }
  } else {
    None
  };

  // Remembers window size + position across launches. Debug builds keep this
  // file in LAS_STATE_DIR instead of the installed app's config folder (the
  // plugin joins the name onto that folder, so an absolute path replaces it).
  let window_state = match &dev_env {
    Some(dev) => tauri_plugin_window_state::Builder::default()
      .with_filename(dev.state_dir.join(".window-state.json").to_string_lossy())
      .build(),
    None => tauri_plugin_window_state::Builder::default().build(),
  };

  // Debug builds run under their own identifier, so every folder Tauri and its
  // plugins derive from it (app config / data / cache / logs) is separate from
  // the installed app's.
  // Files passed as arguments (Windows/Linux double-click, `open --args`).
  let cwd = std::env::current_dir().unwrap_or_default();
  let _ = opens::offer(opens::paths_from_args(std::env::args(), &cwd));

  let mut context = tauri::generate_context!();
  if dev_env.is_some() {
    context.config_mut().identifier = devenv::DEV_IDENTIFIER.to_string();
  }

  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_process::init())
    .plugin(window_state)
    .on_menu_event(|app, ev| {
      let handles = app.try_state::<menu::MenuHandles<tauri::Wry>>();
      if menu::on_click(app, handles.as_deref(), ev.id().as_ref()) {
        if let Some(q) = app.try_state::<Arc<QuitDriver>>() {
          q.request(QuitSource::Menu);
        }
      }
    })
    .setup(move |app| {
      // Debug builds log to the terminal and to LAS_STATE_DIR/logs, never to
      // the OS log folder (which is keyed by the app identifier).
      if let Some(dev) = &dev_env {
        use tauri_plugin_log::{Target, TargetKind};
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .clear_targets()
            .targets([
              Target::new(TargetKind::Stdout),
              Target::new(TargetKind::Folder { path: dev.state_dir.join("logs"), file_name: None }),
            ])
            .build(),
        )?;
      }

      // The app uses the user's locally-installed R. Power users on locked-down
      // machines can point at a portable R tree via the LAS_R_ENV_DIR env var;
      // normally unset → the sidecar discovers the host R itself.
      let r_env_dir: Option<String> = std::env::var("LAS_R_ENV_DIR").ok().filter(|s| !s.is_empty());

      // Release builds start the bundled engine on a free port with a
      // per-launch token and keep it running (engine.rs). Debug builds talk to
      // a dev engine already running on LAS_SIDECAR_PORT (devenv.rs — never
      // the installed app's port or data folder), unless the debug-only
      // LAS_DEV_ENGINE_CMD hook asks them to start one like a release build.
      let engine: Arc<Engine>;
      let state_dir: Option<std::path::PathBuf>;
      if cfg!(debug_assertions) {
        let dev = dev_env.as_ref().ok_or("debug build started without its dev settings")?;
        state_dir = Some(dev.state_dir.clone());
        engine = match dev_engine_hook(r_env_dir.clone())? {
          Some(spec) => {
            eprintln!(
              "[dev] starting the engine like a release build ({} …) on a free port; LAS_SIDECAR_PORT={} is not used",
              spec.program.display(), dev.port
            );
            let e = Engine::supervised(spec, engine::RespawnPolicy::default());
            e.start();
            e
          }
          None => Engine::external(dev.port),
        };
        eprintln!(
          "[dev] engine port {}, state folder {}, identifier {}",
          if engine.port() == 0 { "(picked at start)".to_string() } else { engine.port().to_string() },
          dev.state_dir.display(), app.config().identifier
        );
      } else {
        // The engine is a PyInstaller --onedir folder bundled under
        // Contents/Resources/engine (resource_dir/engine) — no per-launch
        // extraction, so it starts fast. Spawn its executable directly.
        match app.path().resource_dir() {
          Ok(res_dir) => {
            let engine_dir = res_dir.join("engine");
            let engine_exe = engine_dir.join(engine::engine_exe_name(std::env::consts::OS));

            // Windows: the installer updates in place and leaves files a new
            // version no longer ships; the engine was called api-server.exe up
            // to 0.2.22. Nothing starts it any more — just remove the dead copy
            // (best effort; an install folder that is not writable keeps it).
            #[cfg(target_os = "windows")]
            {
              let stale = engine_dir.join("api-server.exe");
              if stale.is_file() && std::fs::remove_file(&stale).is_ok() {
                eprintln!("[las-engine] removed the old engine file {}", stale.display());
              }
            }

            // macOS: clear the download quarantine off the whole .app (covers the
            // engine + its dylibs) and make the engine executable, so Gatekeeper
            // doesn't kill the spawned process.
            #[cfg(target_os = "macos")]
            {
              let _ = std::process::Command::new("chmod")
                .args(["+x", &engine_exe.to_string_lossy().to_string()]).output();
              let _ = std::process::Command::new("xattr")
                .args(["-cr", &engine_dir.to_string_lossy().to_string()]).output();
              if let Ok(cur) = std::env::current_exe() {
                if let Some(app_dir) = cur.parent().and_then(|p| p.parent()).and_then(|p| p.parent()) {
                  let _ = std::process::Command::new("xattr")
                    .args(["-cr", &app_dir.to_string_lossy().to_string()]).output();
                }
              }
            }

            engine = Engine::supervised(
              engine::LaunchSpec { program: engine_exe, pre_args: Vec::new(), cwd: Some(engine_dir), r_env_dir },
              engine::RespawnPolicy::default(),
            );
            engine.start();
          }
          Err(e) => {
            let msg = format!("Failed to resolve resource dir: {}", e);
            eprintln!("{}", msg);
            engine = Engine::failed(msg);
          }
        }
        // Resolved only; nothing is created until something is written there.
        state_dir = devenv::release_state_dir(
          std::env::var(devenv::ENV_STATE_DIR).ok().as_deref(),
          app.path().app_data_dir().ok(),
        );
      }

      // Analysis files: shared context, poll thread, startup pruning.
      let ctx = Arc::new(FileCtx::new(state_dir.clone()));
      {
        let h = app.handle().clone();
        ctx.set_emitter(Arc::new(move |name: &str, payload: serde_json::Value| {
          let _ = h.emit(name, payload);
        }));
      }
      graphwatch::start(ctx.clone());
      presence::start(ctx.clone());
      if state_dir.is_some() {
        let c = ctx.clone();
        std::thread::spawn(move || {
          if let Err(e) = c.prune(10, 500 * 1024 * 1024, graphfile::DISPLACED_KEEP_MS) {
            log::warn!("[graphfile] pruning safety copies failed: {}", e.message);
          }
        });
      }
      let notes_ctx = ctx.clone();
      app.manage(ctx);

      // App menu (custom Quit / Close Tab).
      let (app_menu, menu_handles) = menu::build(app.handle())?;
      app.set_menu(app_menu)?;
      app.manage(menu_handles);

      // Quit handshake; the engine is stopped only when the quit really happens.
      let quit_driver = {
        let h = app.handle().clone();
        let eng = engine.clone();
        QuitDriver::new(Box::new(move |_d, act| match act {
          Act::Emit { id, source } => {
            let _ = h.emit(quit::EVT_QUIT_REQUESTED, quit::QuitRequest { request_id: id, source });
          }
          Act::Finish(how) => {
            // Notes first (before the engine is stopped), at most 1.5 s.
            if !presence::delete_all_own(&notes_ctx, presence::QUIT_DELETE) {
              log::warn!("[presence] not every note could be deleted in time");
            }
            eng.stop();
            match how {
              #[cfg(target_os = "macos")]
              FinishHow::ReplyTerminate => quit_macos::reply_terminate(&h, true),
              #[cfg(not(target_os = "macos"))]
              FinishHow::ReplyTerminate => h.exit(0),
              FinishHow::Exit => h.exit(0),
              FinishHow::None => {}
            }
          }
          Act::CancelTerminate => {
            #[cfg(target_os = "macos")]
            quit_macos::reply_terminate(&h, false);
          }
          Act::StartWatchdog(_) => {}
        }))
      };
      #[cfg(target_os = "macos")]
      match quit_macos::install(quit_driver.clone()) {
        Ok(line) => {
          eprintln!("[quit] {line}");
          log::info!("[quit] {line}");
        }
        Err(e) => {
          eprintln!("[quit] ERROR: {e}. Dock Quit, logout and AppleScript quit will not ask about unsaved changes.");
          log::error!("[quit] {e}. Dock Quit, logout and AppleScript quit will not ask about unsaved changes.");
        }
      }
      app.manage(quit_driver);

      app.manage(engine);
      app.manage(StateDir(state_dir));
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      get_sidecar_port,
      get_sidecar_error,
      engine_health,
      restart_engine,
      proxy_request,
      proxy_upload,
      upload_files_from_paths,
      save_base64_to_path,
      move_file,
      file_size,
      delete_file,
      open_url,
      check_update,
      download_and_install_update,
      kill_sidecar,
      take_pending_opens,
      app_set_menu_state,
      app_quit_reply,
      appstate::app_info,
      appstate::appstate_device,
      appstate::appstate_set_device,
      appstate::appstate_read_session,
      appstate::appstate_write_session,
      appstate::appstate_read_draft,
      appstate::appstate_write_draft,
      appstate::appstate_delete_draft,
      appstate::appstate_list_drafts,
      appstate::appstate_read_recent,
      appstate::appstate_write_recent,
      appstate::appstate_read_export_map,
      appstate::appstate_write_export_map,
      appstate::appstate_read_seen,
      appstate::appstate_write_seen,
      graphfile::graphfile_read,
      graphfile::graphfile_header,
      graphfile::graphfile_save,
      graphfile::graphfile_scan_dir,
      graphfile::graphfile_locate,
      graphfile::graphfile_locate_cancel,
      graphfile::graphfile_journal_heads,
      graphfile::graphfile_read_journal,
      graphfile::graphfile_write_journal,
      graphfile::graphfile_list_displaced,
      graphfile::graphfile_read_displaced,
      graphfile::graphfile_reveal,
      graphfile::graphfile_peek,
      graphfile::graphfile_remove_copy,
      presence::presence_set,
      presence::presence_clear,
      presence::presence_input,
      presence::presence_list,
      presence::presence_remove_foreign,
      cloud::graphfile_cloud_info,
      appstate::appstate_new_device_id,
      graphwatch::graphfile_track,
      graphwatch::graphfile_untrack,
      graphwatch::graphfile_poll_now,
      #[cfg(debug_assertions)]
      deve2e::dev_e2e_script,
      #[cfg(debug_assertions)]
      deve2e::dev_e2e_result,
      #[cfg(debug_assertions)]
      deve2e::dev_e2e_log,
      #[cfg(debug_assertions)]
      deve2e::dev_e2e_fs,
      #[cfg(debug_assertions)]
      deve2e::dev_e2e_quit
    ])
    .build(context)
    .expect("error while building tauri application")
    .run(|app_handle, event| {
      let stop_engine = || {
        if let Some(eng) = app_handle.try_state::<Arc<Engine>>() {
          eng.stop();
        }
      };
      match event {
        // Synchronous Rust-only backstop.
        RunEvent::Exit => {
          delete_own_notes(app_handle);
          stop_engine()
        }
        RunEvent::ExitRequested { code, api, .. } => {
          if code == Some(quit::RESTART_EXIT_CODE) {
            // The updater's restart: cannot be prevented; the frontend ran its
            // quit routine before calling relaunch.
            delete_own_notes(app_handle);
            stop_engine();
            return;
          }
          match app_handle.try_state::<Arc<QuitDriver>>() {
            Some(q) => {
              if !q.allowed() {
                api.prevent_exit();
                q.request(QuitSource::Exit);
              }
            }
            None => {
              delete_own_notes(app_handle);
              stop_engine()
            }
          }
        }
        RunEvent::WindowEvent { label, event: WindowEvent::CloseRequested { api, .. }, .. } if label == "main" => {
          if let Some(q) = app_handle.try_state::<Arc<QuitDriver>>() {
            if !q.allowed() {
              api.prevent_close();
              q.request(QuitSource::Window);
            }
          }
        }
        RunEvent::WindowEvent { event: WindowEvent::Focused(true), .. } => {
          if let Some(ctx) = app_handle.try_state::<Arc<FileCtx>>() {
            graphwatch::poll_now(&ctx);
          }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Opened { urls } => {
          if let Some(paths) = opens::offer(opens::paths_from_urls(&urls)) {
            let _ = app_handle.emit(opens::EVT_OPEN_FILES, serde_json::json!({ "paths": paths }));
            bring_main_window_forward(app_handle);
          }
        }
        _ => {}
      }
    });
}

#[cfg(test)]
mod proxy_client_tests {
    use std::time::Duration;

    /// Many clients, each sending a request and then another just around
    /// uvicorn's 5 s keep-alive limit; returns how many sends failed.
    /// The clients start 25 ms apart: 160 connects at the same instant
    /// overflow macOS's listen backlog (kern.ipc.somaxconn = 128) and get
    /// resets that have nothing to do with keep-alive.
    fn race(make: fn() -> reqwest::Client, port: u16) -> usize {
        tauri::async_runtime::block_on(async move {
            let mut tasks = Vec::new();
            for i in 0..160u64 {
                let client = make();
                tasks.push(tauri::async_runtime::spawn(async move {
                    let url = format!("http://127.0.0.1:{port}/api/health");
                    let start = Duration::from_millis(i * 25);
                    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(start)).await;
                    let mut failed = 0;
                    for _ in 0..3 {
                        // POST: unlike a GET, it is not retried on a reused
                        // connection the server closed. Any answer counts
                        // (405 here); only a failed send is a failure.
                        if let Err(e) = client.post(&url).body("{}").send().await {
                            eprintln!("send failed: {e}");
                            failed += 1;
                        }
                        let d = Duration::from_millis(4_990 + i % 21);
                        let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await;
                    }
                    failed
                }));
            }
            let mut n = 0;
            for t in tasks {
                n += t.await.unwrap_or(1);
            }
            n
        })
    }

    /// Regression for "The analysis engine isn't answering" on a healthy
    /// engine: a pooled connection reused just as uvicorn closes it (idle
    /// 5 s) was reset. Needs a dev engine:
    /// `LAS_TEST_ENGINE_PORT=<port> cargo test -- --ignored keep_alive`
    #[test]
    #[ignore]
    fn keep_alive_race_does_not_fail_requests() {
        let port: u16 = std::env::var("LAS_TEST_ENGINE_PORT")
            .expect("set LAS_TEST_ENGINE_PORT to a running dev engine's port")
            .parse()
            .unwrap();
        // For comparison only (not asserted: the race window is milliseconds).
        let pooled = || reqwest::Client::builder().no_proxy().build().unwrap();
        eprintln!("pooled clients (the bug): {} of 480 sends failed", race(pooled, port));
        let failed = race(|| super::local_client_builder().build().unwrap(), port);
        eprintln!("local_client: {failed} of 480 sends failed");
        assert_eq!(failed, 0);
    }
}
