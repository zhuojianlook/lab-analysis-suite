import { create } from "zustand";
import { checkR } from "../api/client";
import type { CheckRResponse } from "../api/types";

interface RState {
  /** null = not yet probed. */
  state: CheckRResponse | null;
  checking: boolean;
  recheck: () => Promise<void>;
  setState: (s: CheckRResponse) => void;
}

export const useRStore = create<RState>((set) => ({
  state: null,
  checking: false,
  recheck: async () => {
    set({ checking: true });
    try {
      const r = await checkR();
      set({ state: r, checking: false });
    } catch {
      set({ state: { installed: false, version: "", path: "" }, checking: false });
    }
  },
  setState: (state) => set({ state }),
}));
