import { useRef, useState, type DragEvent } from "react";
import { Box, Typography } from "@mui/material";
import UploadFileIcon from "@mui/icons-material/UploadFile";

/** Drag-and-drop target that also opens the file picker on click or Enter.
 *  The Tauri window sets dragDropEnabled=false, so HTML5 drop events receive
 *  real File objects there as well as in a browser preview. Files whose names
 *  don't end in one of the `accept` extensions are ignored. */
export function FileDropZone({
  accept,
  multiple = true,
  onFiles,
  title,
  hint,
  disabled,
}: {
  accept?: string;
  multiple?: boolean;
  onFiles: (files: File[]) => void;
  title: string;
  hint?: string;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const exts = (accept ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const keep = (list: FileList | null) =>
    Array.from(list ?? []).filter((f) => !exts.length || exts.some((e) => f.name.toLowerCase().endsWith(e)));
  const browse = () => { if (!disabled) inputRef.current?.click(); };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (disabled) return;
    const fs = keep(e.dataTransfer.files);
    if (fs.length) onFiles(fs);
  };

  return (
    <Box
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      onClick={browse}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); browse(); } }}
      onDragOver={(e) => { e.preventDefault(); if (!disabled) setOver(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false); }}
      onDrop={onDrop}
      sx={{
        border: "1.5px dashed",
        borderColor: over ? "primary.main" : "divider",
        bgcolor: over ? "action.hover" : "transparent",
        borderRadius: 1.5,
        px: 2,
        py: 2.25,
        textAlign: "center",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "border-color .15s, background-color .15s",
        "&:hover": { borderColor: disabled ? "divider" : "primary.main" },
        "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main", outlineOffset: 2 },
      }}
    >
      <UploadFileIcon sx={{ color: over ? "primary.main" : "text.secondary", mb: 0.25 }} />
      <Typography variant="body2">{title}</Typography>
      {hint && <Typography variant="caption" color="text.secondary" component="div">{hint}</Typography>}
      <input
        ref={inputRef}
        type="file"
        hidden
        multiple={multiple}
        accept={accept}
        onChange={(e) => {
          const fs = keep(e.target.files);
          e.target.value = ""; // allow re-selecting the same files
          if (fs.length) onFiles(fs);
        }}
      />
    </Box>
  );
}
