import { Button, Stack, Typography } from "@mui/material";
import FolderIcon from "@mui/icons-material/Folder";
import InsertDriveFileIcon from "@mui/icons-material/InsertDriveFile";
import { pickFile, pickFolder } from "../../api/client";

/** Lets the user pick a local folder or file path natively (so large omics
 *  inputs are read in place, not uploaded). */
export function DataPathInput({
  value,
  onPick,
  folderLabel = "Choose folder",
  fileLabel = "Choose file",
  allowFolder = true,
  allowFile = true,
}: {
  value: string;
  onPick: (path: string) => void;
  folderLabel?: string;
  fileLabel?: string;
  allowFolder?: boolean;
  allowFile?: boolean;
}) {
  return (
    <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
      {allowFolder && (
        <Button variant="outlined" startIcon={<FolderIcon />}
          onClick={async () => { const p = await pickFolder(folderLabel); if (p) onPick(p); }}>
          {folderLabel}
        </Button>
      )}
      {allowFile && (
        <Button variant="outlined" startIcon={<InsertDriveFileIcon />}
          onClick={async () => { const p = await pickFile(fileLabel); if (p) onPick(p); }}>
          {fileLabel}
        </Button>
      )}
      <Typography variant="caption" color="text.secondary" sx={{ wordBreak: "break-all" }}>
        {value || "no path selected"}
      </Typography>
    </Stack>
  );
}
