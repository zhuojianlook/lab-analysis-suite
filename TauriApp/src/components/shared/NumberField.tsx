import { useEffect, useState } from "react";
import { TextField, type TextFieldProps } from "@mui/material";

/** Numeric input that edits a local string and commits a clamped number only
 *  on blur or Enter — so partial input (e.g. "8" on the way to "800") never
 *  reaches the parent, which matters when the parent live-renders a figure. */
export function NumberField({
  value,
  onCommit,
  min,
  max,
  step,
  ...props
}: Omit<TextFieldProps, "value" | "onChange" | "type"> & {
  value: number;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => { setText(String(value)); }, [value]);

  const commit = () => {
    const n = Number(text);
    if (text.trim() === "" || !Number.isFinite(n)) { setText(String(value)); return; }
    const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
    setText(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };

  return (
    <TextField
      {...props}
      type="number"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
      slotProps={{ htmlInput: { min, max, step } }}
    />
  );
}
