import { useEffect, useRef, useState } from "react";
import { TextField, type TextFieldProps } from "@mui/material";

/** Numeric input that edits a local string and commits a clamped number only
 *  on blur or Enter — so partial input (e.g. "8" on the way to "800") never
 *  reaches the parent, which matters when the parent live-renders a figure.
 *  `onTyping` (optional): true on every keystroke that leaves the text different
 *  from `value`, false when that ends (commit, reset, unmount). */
export function NumberField({
  value,
  onCommit,
  min,
  max,
  step,
  onTyping,
  ...props
}: Omit<TextFieldProps, "value" | "onChange" | "type"> & {
  value: number;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  onTyping?: (typed: boolean) => void;
}) {
  const [text, setText] = useState(String(value));
  const typingRef = useRef(onTyping);
  typingRef.current = onTyping;
  useEffect(() => { setText(String(value)); typingRef.current?.(false); }, [value]);
  useEffect(() => () => typingRef.current?.(false), []);

  const commit = () => {
    onTyping?.(false);
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
      onChange={(e) => { setText(e.target.value); onTyping?.(e.target.value !== String(value)); }}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
      slotProps={{ htmlInput: { min, max, step } }}
    />
  );
}
