import { create } from "zustand";
import { isTauri } from "../api/client";

export type UpdaterStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "none"
  | "error";

// The Update object from the plugin is non-serializable, so keep it out of state.
let _update: { version: string; downloadAndInstall: (cb: (e: unknown) => void) => Promise<void> } | null = null;

interface UpdaterState {
  status: UpdaterStatus;
  version: string;
  progress: number; // 0..1
  error: string;
  lastManual: boolean;
  check: (manual?: boolean) => Promise<void>;
  install: () => Promise<void>;
  restart: () => Promise<void>;
  dismiss: () => void;
}

export const useUpdaterStore = create<UpdaterState>((set) => ({
  status: "idle",
  version: "",
  progress: 0,
  error: "",
  lastManual: false,

  check: async (manual = false) => {
    if (!(await isTauri())) {
      set({ status: manual ? "none" : "idle", lastManual: manual });
      return;
    }
    set({ status: "checking", error: "", lastManual: manual });
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const upd = await check();
      if (upd) {
        _update = upd as never;
        set({ status: "available", version: upd.version });
      } else {
        set({ status: "none" });
      }
    } catch (e) {
      set({ status: "error", error: e instanceof Error ? e.message : String(e) });
    }
  },

  install: async () => {
    if (!_update) return;
    set({ status: "downloading", progress: 0 });
    try {
      let total = 0;
      let got = 0;
      await _update.downloadAndInstall((event: unknown) => {
        const ev = event as { event: string; data?: { contentLength?: number; chunkLength?: number } };
        if (ev.event === "Started") total = ev.data?.contentLength ?? 0;
        else if (ev.event === "Progress") {
          got += ev.data?.chunkLength ?? 0;
          set({ progress: total ? got / total : 0 });
        } else if (ev.event === "Finished") set({ progress: 1 });
      });
      set({ status: "ready" });
    } catch (e) {
      set({ status: "error", error: e instanceof Error ? e.message : String(e) });
    }
  },

  restart: async () => {
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  },

  dismiss: () => set({ status: "idle", error: "", progress: 0 }),
}));
