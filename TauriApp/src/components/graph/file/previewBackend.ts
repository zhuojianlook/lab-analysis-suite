/* The browser preview's simulated world (contract §4.14): a Dropbox-like sync
   service, this computer and one other computer ("Office iMac", Alice), with a
   few folders and a sample analysis. Time runs in real time (a ManualClock
   advanced every 250 ms), and the whole world is kept in localStorage so a page
   reload behaves like quitting and starting the app again. */

import { sampleDoc } from "../graphModel";
import { openContent } from "../../../store/graphStore";
import type { AppInfo } from "./contract";
import { buildNewFile, newAnalysisId, newDocKey, type Author } from "./docCodec";
import { ManualClock, MemoryWorld, type MemoryDevice, type MemoryWorldState } from "./memoryBackend";

export const PREVIEW_STORAGE_KEY = "las.files.preview.v1";
export const PREVIEW_HOME = "/Users/me";
export const PREVIEW_FOLDERS = [`${PREVIEW_HOME}/Dropbox/Lab`, `${PREVIEW_HOME}/Dropbox/Shared`, `${PREVIEW_HOME}/Documents`, `${PREVIEW_HOME}/Downloads`];
export const PREVIEW_SAMPLE = `${PREVIEW_HOME}/Dropbox/Lab/Dose response.lag`;
export const PREVIEW_APP_INFO: AppInfo = {
  homeDir: PREVIEW_HOME, tempDirs: [`${PREVIEW_HOME}/Downloads`, "/private/tmp"], platform: "macos", appVersion: "preview",
  stateDir: "(preview)", debug: true,
};

export interface PreviewWorld {
  world: MemoryWorld;
  clock: ManualClock;
  /** This computer (the app's backend). */
  device: MemoryDevice;
  /** The other computer. */
  other: MemoryDevice;
  /** Resolves once a fresh world has its sample file. */
  ready: Promise<void>;
  /** Write the world to localStorage now (page unload). */
  persistNow(): void;
}

export const authorOf = (d: { name: string; deviceId: string }, userName: string, sessionId = "s-preview"): Author => ({
  user_name: userName, device_id: d.deviceId, device_name: d.name, session_id: sessionId, app_version: "preview", platform: "macos",
});

function storage(): Storage | null {
  try { return typeof localStorage !== "undefined" ? localStorage : null; } catch { return null; }
}

/** A preview world. `persist` / `drive`: use localStorage / a real-time clock (both off in tests). */
export function createPreviewWorld(opts: { persist?: boolean; drive?: boolean; clock?: ManualClock } = {}): PreviewWorld {
  const persist = opts.persist ?? true;
  const clock = opts.clock ?? new ManualClock(Date.now());
  const world = new MemoryWorld({ mode: "dropbox", clock, syncFolders: [`${PREVIEW_HOME}/Dropbox`] });
  const common = { appInfo: PREVIEW_APP_INFO, strictFolders: true, folders: PREVIEW_FOLDERS };
  const device = world.addDevice({ device_id: "d-preview-this", device_name: "This Mac", user_name: "Me", session_id: `s-preview-${Date.now().toString(36)}`, ...common });
  const other = world.addDevice({ device_id: "d-preview-other", device_name: "Office iMac", user_name: "Alice", ...common });

  let restored = false;
  const st = persist ? storage() : null;
  if (st) {
    try {
      const text = st.getItem(PREVIEW_STORAGE_KEY);
      if (text) { world.importState(JSON.parse(text) as MemoryWorldState); restored = true; }
    } catch { restored = false; }
  }

  const persistNow = () => {
    if (!st) return;
    try { st.setItem(PREVIEW_STORAGE_KEY, JSON.stringify(world.exportState())); } catch (e) { console.warn("[files preview] not saved:", e); }
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (st) world.onChange(() => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; persistNow(); }, 200);
  });

  const ready = (async () => {
    if (restored) return;
    const doc = sampleDoc("column");
    const content = openContent({ doc });
    const file = await buildNewFile({
      content, analysisId: newAnalysisId(), forkedFrom: null, time: clock.now(), author: authorOf(device, "Me"),
    });
    await device.save({ path: PREVIEW_SAMPLE, expectedHead: null, analysisId: file.manifest.analysis_id, docKey: newDocKey(), manifest: file.manifest, newParts: file.parts });
    clock.advance(0);
    persistNow();
  })();

  if (opts.drive ?? true) {
    const iv = setInterval(() => clock.advance(250), 250);
    (iv as { unref?: () => void }).unref?.();
  }
  return { world, clock, device, other, ready, persistNow };
}

let instance: PreviewWorld | null = null;

/** The preview's world (one per page). */
export function previewBackend(): PreviewWorld {
  return (instance ??= createPreviewWorld());
}
