/* ──────────────────────────────────────────────────────────
   API client for the Lab Analysis Suite FastAPI sidecar.
   Uses the Tauri IPC proxy (invoke → Rust proxy_request) to
   bypass WebView restrictions on localhost requests; falls back
   to browser fetch in a plain `vite dev` preview.
   ────────────────────────────────────────────────────────── */

import type {
  CheckRResponse,
  RunRResponse,
} from "./types";

const DEFAULT_BASE = "http://127.0.0.1:8765";

let _invoke: ((cmd: string, args: Record<string, unknown>) => Promise<unknown>) | null = null;
let _invokeReady = false;

async function getInvoke() {
  if (_invokeReady) return _invoke;
  const inTauri =
    typeof window !== "undefined" &&
    (("__TAURI_INTERNALS__" in window) || ("__TAURI__" in window) || ("__TAURI_IPC__" in window));
  if (!inTauri) {
    _invoke = null;
    _invokeReady = true;
    return _invoke;
  }
  try {
    const mod = await import("@tauri-apps/api/core");
    _invoke = mod.invoke;
  } catch {
    _invoke = null;
  }
  _invokeReady = true;
  return _invoke;
}

/** True when running inside the real Tauri runtime (vs. a browser dev preview). */
export async function isTauri(): Promise<boolean> {
  return (await getInvoke()) !== null;
}

/** Raw request — Rust proxy if available, else browser fetch. Returns text. */
export async function apiRequest(path: string, method = "GET", body?: string): Promise<string> {
  const invoke = await getInvoke();
  if (invoke) {
    return invoke("proxy_request", { method, path, body: body ?? null }) as Promise<string>;
  }
  const res = await fetch(`${DEFAULT_BASE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body,
  });
  return res.text();
}

/** Request + JSON parse, throwing on FastAPI `detail` error envelopes. */
export async function apiJson<T>(path: string, method = "GET", body?: string): Promise<T> {
  const text = await apiRequest(path, method, body);
  const parsed = JSON.parse(text);
  if (parsed && parsed.detail) {
    throw new Error(`API error: ${JSON.stringify(parsed.detail)}`);
  }
  return parsed as T;
}

/** Multipart upload of base64 file payloads through the Rust proxy. */
export async function uploadFiles(
  path: string,
  files: File[],
  fieldName = "files",
): Promise<string> {
  const invoke = await getInvoke();
  if (invoke) {
    const filesData: { name: string; data: string }[] = [];
    for (const f of files) {
      const buf = await f.arrayBuffer();
      const bytes = new Uint8Array(buf);
      const CHUNK = 8192;
      const chunks: string[] = [];
      for (let i = 0; i < bytes.length; i += CHUNK) {
        chunks.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)));
      }
      filesData.push({ name: f.name, data: btoa(chunks.join("")) });
    }
    return invoke("proxy_upload", { path, files: filesData, fieldName }) as Promise<string>;
  }
  const form = new FormData();
  for (const f of files) form.append(fieldName, f);
  const res = await fetch(`${DEFAULT_BASE}${path}`, { method: "POST", body: form });
  return res.text();
}

/** Save base64 bytes to a user-chosen path (Rust side; verifies the write). */
export async function saveBase64ToPath(path: string, dataB64: string): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) throw new Error("Saving files requires the desktop app.");
  await invoke("save_base64_to_path", { path, dataB64 });
}

export let lastHealthError = "";

/** Is the sidecar reachable? */
export async function checkHealth(): Promise<boolean> {
  try {
    const text = await apiRequest("/api/health");
    const data = JSON.parse(text);
    if (data.status === "ok") {
      lastHealthError = "";
      return true;
    }
    lastHealthError = `Health response: ${text.substring(0, 200)}`;
    return false;
  } catch (e) {
    lastHealthError = e instanceof Error ? e.message : String(e);
    return false;
  }
}

/** Is R (bundled or host) available to the sidecar? */
export async function checkR(): Promise<CheckRResponse> {
  return apiJson<CheckRResponse>("/api/analysis/check-r");
}

/** Run an R/ggplot script against a data CSV via the shared bridge. */
export async function runR(code: string, dataCsv: string): Promise<RunRResponse> {
  return apiJson<RunRResponse>(
    "/api/analysis/run-r",
    "POST",
    JSON.stringify({ code, data_csv: dataCsv }),
  );
}

/** Run a raw R command (e.g. install.packages) via the bridge console. */
export async function runRConsole(command: string): Promise<{ success: boolean; stdout: string; stderr: string }> {
  return apiJson("/api/analysis/run-console", "POST", JSON.stringify({ command }));
}

// ── R settings + package management ─────────────────────

export async function getRSettings(): Promise<{ rscript_path: string; app_data_dir: string }> {
  return apiJson("/api/analysis/get-settings");
}

/** Persist a custom Rscript path (empty clears it); returns a fresh probe. */
export async function setRscriptPath(rscriptPath: string): Promise<CheckRResponse> {
  return apiJson("/api/analysis/set-rscript", "POST", JSON.stringify({ rscript_path: rscriptPath }));
}

export interface PackageStatus {
  name: string;
  installed: boolean;
  version: string;
}

export async function checkPackages(
  tab: string,
): Promise<{ r_available: boolean; packages: PackageStatus[]; all_installed: boolean }> {
  return apiJson(`/api/analysis/check-packages?tab=${encodeURIComponent(tab)}`);
}

export async function installPackages(
  tab: string,
): Promise<{ job_id: string | null; n_packages?: number; error?: string }> {
  return apiJson("/api/analysis/install-packages", "POST", JSON.stringify({ tab }));
}

export interface InstallStatus {
  status: "queued" | "running" | "done" | "error";
  stage: string;
  progress: number;
  tail_log: string;
  error: string | null;
}

export async function installStatus(jobId: string): Promise<InstallStatus> {
  return apiJson(`/api/analysis/install-status/${encodeURIComponent(jobId)}`);
}

/** Open a URL in the OS default browser (Rust command), or a new tab in dev. */
export async function openExternal(url: string): Promise<void> {
  const invoke = await getInvoke();
  if (invoke) {
    await invoke("open_url", { url });
    return;
  }
  window.open(url, "_blank");
}

/** Native file picker → returns a chosen path (or null), app-only. */
export async function pickFile(title: string): Promise<string | null> {
  if (!(await isTauri())) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const res = await open({ multiple: false, directory: false, title });
  return typeof res === "string" ? res : null;
}

/** Check for + download + install an app update (Rust-driven). */
export async function downloadAndInstallUpdate(manifestUrl: string): Promise<string> {
  const invoke = await getInvoke();
  if (!invoke) throw new Error("Updates require the desktop app.");
  return invoke("download_and_install_update", { manifestUrl }) as Promise<string>;
}

// ── Plate Mapper ────────────────────────────────────────
export interface PlatemapExport {
  n_rows: number;
  header: string[];
  rows: string[][];
  tsv: string | null;
  xlsx_b64: string | null;
}

export async function exportPlatemap(
  plate: string,
  valueLabels: string[],
  grids: Record<string, string>[],
  fmt: "xlsx" | "tsv" | "both",
): Promise<PlatemapExport> {
  return apiJson<PlatemapExport>(
    "/api/platemap/export",
    "POST",
    JSON.stringify({ plate, value_labels: valueLabels, grids, fmt }),
  );
}

// ── File save helpers ───────────────────────────────────

/** Encode a UTF-8 string to base64 (btoa alone is latin1-only). */
export function utf8ToB64(s: string): string {
  return btoa(unescape(encodeURIComponent(s)));
}

/** Save base64 bytes to a user-chosen path (native dialog in the app), or
 *  fall back to a normal browser download in a `vite dev` preview. */
export async function saveDownload(suggestedName: string, dataB64: string, mime: string): Promise<boolean> {
  if (await isTauri()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({ defaultPath: suggestedName });
    if (!path) return false;
    await saveBase64ToPath(path, dataB64);
    return true;
  }
  const bin = atob(dataB64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const blob = new Blob([arr], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = suggestedName;
  a.click();
  URL.revokeObjectURL(url);
  return true;
}
