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

export type Channel = "stable" | "experimental";

const REPO_RAW = "https://raw.githubusercontent.com/zhuojianlook/lab-analysis-suite/updater";
const CH_KEY = "las.updateChannel";

function manifestUrl(ch: Channel): string {
  return ch === "experimental" ? `${REPO_RAW}/latest-experimental.json` : `${REPO_RAW}/latest.json`;
}
function loadChannel(): Channel {
  try {
    return localStorage.getItem(CH_KEY) === "experimental" ? "experimental" : "stable";
  } catch {
    return "stable";
  }
}

interface UpdaterState {
  channel: Channel;
  status: UpdaterStatus;
  version: string;
  progress: number; // 0..1
  error: string;
  lastManual: boolean;
  setChannel: (c: Channel) => void;
  check: (manual?: boolean) => Promise<void>;
  install: () => Promise<void>;
  restart: () => Promise<void>;
  dismiss: () => void;
}

export const useUpdaterStore = create<UpdaterState>((set, get) => ({
  channel: loadChannel(),
  status: "idle",
  version: "",
  progress: 0,
  error: "",
  lastManual: false,

  setChannel: (channel) => {
    try {
      localStorage.setItem(CH_KEY, channel);
    } catch {
      /* ignore */
    }
    set({ channel, status: "idle", error: "", version: "", progress: 0 });
  },

  check: async (manual = false) => {
    if (!(await isTauri())) {
      set({ status: manual ? "none" : "idle", lastManual: manual });
      return;
    }
    set({ status: "checking", error: "", lastManual: manual });
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const r = (await invoke("check_update", { manifestUrl: manifestUrl(get().channel) })) as {
        available: boolean;
        version: string;
      };
      if (r.available) set({ status: "available", version: r.version });
      else set({ status: "none" });
    } catch (e) {
      set({ status: "error", error: e instanceof Error ? e.message : String(e) });
    }
  },

  install: async () => {
    set({ status: "downloading", progress: 0, error: "" });
    let unlisten: (() => void) | null = null;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<{ downloaded: number; total: number | null }>(
        "updater://progress",
        (e) => {
          const { downloaded, total } = e.payload;
          set({ progress: total ? downloaded / total : 0 });
        },
      );
      await invoke("download_and_install_update", { manifestUrl: manifestUrl(get().channel) });
      set({ status: "ready", progress: 1 });
    } catch (e) {
      set({ status: "error", error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (unlisten) unlisten();
    }
  },

  restart: async () => {
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  },

  dismiss: () => set({ status: "idle", error: "", progress: 0 }),
}));
