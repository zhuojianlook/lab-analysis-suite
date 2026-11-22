import { create } from "zustand";
import { checkR } from "../api/client";
import type { CheckRResponse } from "../api/types";
import { gateRPath } from "../components/shared/rPackageGateLogic";

interface RState {
  /** null = not yet probed. */
  state: CheckRResponse | null;
  checking: boolean;
  /** The last probe failed (engine gone again, error); AppShell retries on
   *  its next health poll. */
  failed: boolean;
  /** Last non-empty Rscript path seen; the package gates key on it. */
  lastPath: string;
  recheck: () => Promise<void>;
  setState: (s: CheckRResponse) => void;
}

export const useRStore = create<RState>((set, get) => ({
  state: null,
  checking: false,
  failed: false,
  lastPath: "",
  recheck: async () => {
    set({ checking: true });
    try {
      const r = await checkR();
      set({ state: r, checking: false, failed: false, lastPath: gateRPath(get().lastPath, r.path) });
    } catch {
      // A failed probe says nothing about R. Keep what is known (the tools
      // stay open; this is often the engine dying again right after a
      // restart) and retry; only with nothing known yet show "not found".
      set((s) => ({
        state: s.state ?? { installed: false, version: "", path: "" },
        checking: false,
        failed: true,
      }));
    }
  },
  setState: (state) => set((s) => ({ state, failed: false, lastPath: gateRPath(s.lastPath, state.path) })),
}));
