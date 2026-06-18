import { create } from "zustand";
import { plateSpec } from "./platemapStore";

export type QField = "Gene" | "Sample" | "Cp";

interface QpcrManualState {
  plate: string;
  values: Record<QField, Record<string, string>>; // field -> well("A1") -> value
  setPlate: (p: string) => void;
  setCell: (field: QField, well: string, value: string) => void;
  clear: () => void;
}

export const useQpcrManualStore = create<QpcrManualState>((set) => ({
  plate: "96",
  values: { Gene: {}, Sample: {}, Cp: {} },
  setPlate: (plate) => set({ plate }),
  setCell: (field, well, value) =>
    set((s) => ({ values: { ...s.values, [field]: { ...s.values[field], [well]: value } } })),
  clear: () => set({ values: { Gene: {}, Sample: {}, Cp: {} } }),
}));

/** Wells where Gene + Sample + numeric Cp are all present → qPCR records. */
export function buildQpcrRecords(
  values: Record<QField, Record<string, string>>,
  plate: string,
): { Sample: string; Gene: string; Cp: number }[] {
  const { rows, cols } = plateSpec(plate);
  const recs: { Sample: string; Gene: string; Cp: number }[] = [];
  for (const r of rows) {
    for (const c of cols) {
      const w = `${r}${c}`;
      const g = (values.Gene[w] || "").trim();
      const s = (values.Sample[w] || "").trim();
      const cp = (values.Cp[w] || "").trim();
      if (g && s && cp !== "") {
        const n = Number(cp);
        if (!Number.isNaN(n)) recs.push({ Sample: s, Gene: g, Cp: n });
      }
    }
  }
  return recs;
}
