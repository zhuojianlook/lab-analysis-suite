use tauri::{Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;
use std::sync::{Arc, Mutex};
use std::io::{BufRead, BufReader};

#[derive(serde::Serialize, Clone)]
struct UpdateProgress {
    downloaded: u64,
    total: Option<u64>,
}

#[tauri::command]
fn get_sidecar_port(state: tauri::State<'_, SidecarPort>) -> u16 {
    state.0
}

#[tauri::command]
fn get_sidecar_error(state: tauri::State<'_, SidecarError>) -> Option<String> {
    state.0.lock().unwrap().clone()
}

/// HTTP client that never routes through a system/env proxy. The sidecar lives
/// on 127.0.0.1, but a configured HTTP(S)_PROXY / ALL_PROXY env var or a macOS
/// system proxy would otherwise make reqwest try to proxy localhost and fail
/// with "error sending request" — even though the sidecar is up (curl works).
fn local_client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// Proxy HTTP requests to the sidecar through Rust, bypassing WebView restrictions
/// on localhost (WKWebView / WebView2 block fetch() to http://127.0.0.1).
#[tauri::command]
async fn proxy_request(
    method: String,
    path: String,
    body: Option<String>,
    state: tauri::State<'_, SidecarPort>,
) -> Result<String, String> {
    let port = state.0;
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

    let resp = req.send().await.map_err(|e| format!("Request failed: {}", e))?;
    let text = resp.text().await.map_err(|e| format!("Failed to read response: {}", e))?;
    Ok(text)
}

/// Kill the sidecar process — called before update restart.
#[tauri::command]
async fn kill_sidecar(state: tauri::State<'_, SidecarChild>) -> Result<(), String> {
    kill_sidecar_process(&state.0);
    Ok(())
}

/// Helper to kill sidecar and any child processes.
fn kill_sidecar_process(child_mutex: &Arc<Mutex<Option<std::process::Child>>>) {
    if let Ok(mut guard) = child_mutex.lock() {
        if let Some(mut child) = guard.take() {
            eprintln!("[cleanup] Killing engine process");
            let _ = child.kill();
        }
    }
    // On Windows, PyInstaller --onefile spawns a child process that may survive.
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/IM", "api-server.exe", "/T"])
            .output();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = std::process::Command::new("pkill")
            .args(["-f", "api-server"])
            .output();
    }
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
    state: tauri::State<'_, SidecarPort>,
) -> Result<String, String> {
    let port = state.0;
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
        .map_err(|e| format!("Upload request failed: {}", e))?;
    let text = resp.text().await
        .map_err(|e| format!("Failed to read upload response: {}", e))?;
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
    state: tauri::State<'_, SidecarPort>,
) -> Result<String, String> {
    let port = state.0;
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
        .map_err(|e| format!("Upload request failed: {}", e))?;
    let text = resp.text().await
        .map_err(|e| format!("Failed to read upload response: {}", e))?;
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

struct SidecarPort(u16);
struct SidecarError(Arc<Mutex<Option<String>>>);
struct SidecarChild(Arc<Mutex<Option<std::process::Child>>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_process::init())
    // Remembers window size + position across launches.
    .plugin(tauri_plugin_window_state::Builder::default().build())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      let sidecar_error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
      let sidecar_child: Arc<Mutex<Option<std::process::Child>>> = Arc::new(Mutex::new(None));

      // The app uses the user's locally-installed R. Power users on locked-down
      // machines can point at a portable R tree via the LAS_R_ENV_DIR env var;
      // normally unset → the sidecar discovers the host R itself.
      let r_env_dir: Option<String> = std::env::var("LAS_R_ENV_DIR").ok().filter(|s| !s.is_empty());

      // Launch sidecar in production; in dev, assume it's already running.
      let port: u16;
      if cfg!(debug_assertions) {
        port = 8765;
      } else {
        // The engine is a PyInstaller --onedir folder bundled under
        // Contents/Resources/engine (resource_dir/engine) — no per-launch
        // extraction, so it starts fast. Spawn its executable directly.
        match app.path().resource_dir() {
          Ok(res_dir) => {
            let engine_dir = res_dir.join("engine");
            let exe_name = if cfg!(target_os = "windows") { "api-server.exe" } else { "api-server" };
            let engine_exe = engine_dir.join(exe_name);

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

            let mut command = std::process::Command::new(&engine_exe);
            command.arg("--port").arg("8765");
            if let Some(ref dir) = r_env_dir {
              command.arg("--r-env-dir").arg(dir);
            }
            command.current_dir(&engine_dir);
            command.stdout(std::process::Stdio::piped());
            command.stderr(std::process::Stdio::piped());
            #[cfg(target_os = "windows")]
            {
              use std::os::windows::process::CommandExt;
              command.creation_flags(0x08000000); // CREATE_NO_WINDOW
            }

            match command.spawn() {
              Ok(mut child) => {
                if let Some(out) = child.stdout.take() {
                  std::thread::spawn(move || {
                    for line in BufReader::new(out).lines().map_while(Result::ok) {
                      eprintln!("[engine] {}", line);
                    }
                  });
                }
                if let Some(errpipe) = child.stderr.take() {
                  let err_clone = sidecar_error.clone();
                  std::thread::spawn(move || {
                    for line in BufReader::new(errpipe).lines().map_while(Result::ok) {
                      eprintln!("[engine stderr] {}", line);
                      if let Ok(mut e) = err_clone.lock() {
                        let current = e.get_or_insert_with(String::new);
                        if current.len() < 2000 {
                          current.push_str(&line);
                          current.push('\n');
                        }
                      }
                    }
                  });
                }
                *sidecar_child.lock().unwrap() = Some(child);
              }
              Err(e) => {
                let msg = format!("Failed to spawn engine ({}): {}", engine_exe.display(), e);
                eprintln!("{}", msg);
                *sidecar_error.lock().unwrap() = Some(msg);
              }
            }
          }
          Err(e) => {
            let msg = format!("Failed to resolve resource dir: {}", e);
            eprintln!("{}", msg);
            *sidecar_error.lock().unwrap() = Some(msg);
          }
        }
        port = 8765;
      }

      app.manage(SidecarPort(port));
      app.manage(SidecarError(sidecar_error));
      app.manage(SidecarChild(sidecar_child));
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      get_sidecar_port,
      get_sidecar_error,
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
      kill_sidecar
    ])
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app_handle, event| {
      match event {
        tauri::RunEvent::Exit => {
          if let Some(state) = app_handle.try_state::<SidecarChild>() {
            kill_sidecar_process(&state.0);
          }
        }
        tauri::RunEvent::ExitRequested { .. } => {
          if let Some(state) = app_handle.try_state::<SidecarChild>() {
            kill_sidecar_process(&state.0);
          }
        }
        _ => {}
      }
    });
}
