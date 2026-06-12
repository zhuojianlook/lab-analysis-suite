import { create } from "zustand";

export interface PlateField {
  label: string;
  /** well key ("A1") -> value */
  values: Record<string, string>;
}

/** rows x cols per plate type. */
export const PLATE_DIMS: Record<string, [number, number]> = {
  "6": [2, 3],
  "12": [3, 4],
  "24": [4, 6],
  "48": [6, 8],
  "96": [8, 12],
  "384": [16, 24],
};

export function plateSpec(plate: string): { rows: string[]; cols: number[] } {
  const [nr, nc] = PLATE_DIMS[plate] ?? PLATE_DIMS["96"];
  return {
    rows: Array.from({ length: nr }, (_, i) => String.fromCharCode(65 + i)),
    cols: Array.from({ length: nc }, (_, i) => i + 1),
  };
}

interface PlatemapState {
  plate: string;
  fields: PlateField[];
  activeField: number;
  setPlate: (p: string) => void;
  setActiveField: (i: number) => void;
  setFieldLabel: (i: number, label: string) => void;
  addField: () => void;
  removeField: (i: number) => void;
  setCell: (i: number, well: string, value: string) => void;
  clearValues: () => void;
}

export const usePlatemapStore = create<PlatemapState>((set) => ({
  plate: "96",
  fields: [
    { label: "Gene", values: {} },
    { label: "Sample", values: {} },
  ],
  activeField: 0,
  setPlate: (plate) => set({ plate }),
  setActiveField: (activeField) => set({ activeField }),
  setFieldLabel: (i, label) =>
    set((s) => ({ fields: s.fields.map((f, idx) => (idx === i ? { ...f, label } : f)) })),
  addField: () =>
    set((s) => ({
      fields: [...s.fields, { label: `Value ${s.fields.length + 1}`, values: {} }],
      activeField: s.fields.length,
    })),
  removeField: (i) =>
    set((s) => {
      const fields = s.fields.filter((_, idx) => idx !== i);
      const safe = fields.length ? fields : [{ label: "Value 1", values: {} }];
      return { fields: safe, activeField: Math.max(0, Math.min(s.activeField, safe.length - 1)) };
    }),
  setCell: (i, well, value) =>
    set((s) => ({
      fields: s.fields.map((f, idx) =>
        idx === i ? { ...f, values: { ...f.values, [well]: value } } : f,
      ),
    })),
  clearValues: () => set((s) => ({ fields: s.fields.map((f) => ({ ...f, values: {} })) })),
}));
