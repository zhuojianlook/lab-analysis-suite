import { create } from "zustand";
import { isFreshOk, type EngineHealth } from "../api/engineHealth";

/** The analysis engine's health, polled by AppShell and read by the status
 *  indicators and the R package gates. */
interface EngineStore {
  health: EngineHealth;
  /** Counts fresh "ok"s (first start, every recovery, and a restart seen as a
   *  new engine generation), so gates can re-check after the engine comes back. */
  okSerial: number;
  /** When the engine last stopped being ok (or the app started); null while ok. */
  notOkSince: number | null;
  /** Record a poll result. True when this is a transition into "ok". */
  setHealth: (h: EngineHealth) => boolean;
  /** Ask for a health poll now (set by AppShell's poller). */
  pollNow: () => void;
  setPoller: (fn: () => void) => void;
}

export const useEngineStore = create<EngineStore>((set, get) => ({
  health: { state: "checking" },
  okSerial: 0,
  notOkSince: Date.now(),
  setHealth: (h) => {
    const becameOk = isFreshOk(get().health, h);
    set((s) => ({
      health: h,
      okSerial: becameOk ? s.okSerial + 1 : s.okSerial,
      notOkSince: h.state === "ok" ? null : (s.notOkSince ?? Date.now()),
    }));
    return becameOk;
  },
  pollNow: () => {},
  setPoller: (fn) => set({ pollNow: fn }),
}));
