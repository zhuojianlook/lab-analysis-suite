/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Sidecar base URL for a plain `vite dev` browser preview (ignored inside Tauri). */
  readonly VITE_API_BASE?: string;
}
