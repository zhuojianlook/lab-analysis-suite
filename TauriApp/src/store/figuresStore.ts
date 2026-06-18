import { create } from "zustand";

export interface FigureItem {
  id: string;
  title: string;
  png: string; // base64 (no data: prefix)
  source: string; // which tab produced it
}

interface FiguresState {
  figures: FigureItem[];
  add: (png: string, title: string, source: string) => void;
  remove: (id: string) => void;
  clear: () => void;
}

let _seq = 0;

/** Session-lived collection of figures the user has "sent" from any analysis
 *  tab. Groundwork for exporting into the Multi-Panel Figure Builder. */
export const useFiguresStore = create<FiguresState>((set) => ({
  figures: [],
  add: (png, title, source) =>
    set((s) => ({ figures: [...s.figures, { id: `fig${++_seq}`, title, png, source }] })),
  remove: (id) => set((s) => ({ figures: s.figures.filter((f) => f.id !== id) })),
  clear: () => set({ figures: [] }),
}));
