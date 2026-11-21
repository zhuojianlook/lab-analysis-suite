import { Box, Button, Chip, CircularProgress, IconButton, Stack, Tooltip, Typography } from "@mui/material";
import SaveOutlinedIcon from "@mui/icons-material/SaveOutlined";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import { useFileSession } from "../file/session";
import type { FileTab } from "../file/contract";
import { BannerSlot } from "./BannerSlot";
import { FileMenu } from "./FileMenu";
import { REVEAL_LABEL, STATUS, shortcutText } from "./text";

/** Height of the document bar. Fixed, so a banner appearing in it never moves the workspace. */
export const DOC_BAR_HEIGHT = 60;

function statusOf(tab: FileTab): string {
  if (tab.status === "opening") return STATUS.opening;
  if (tab.saving) return STATUS.saving;
  if (tab.notSaved) return STATUS.notSaved;
  if (tab.readOnly) return STATUS.readOnly;
  if (tab.dirty) return STATUS.dirty;
  return tab.path ? STATUS.saved : "";
}

/** Title (the file name), the folder line with Show in Finder, the banner slot,
 *  the save state, Save and the File menu (contract §5.1 DocBar + BannerSlot). */
export function DocBar({ tab }: { tab: FileTab }) {
  const status = statusOf(tab);
  const canSave = !tab.readOnly && !tab.saving && tab.status === "ready";
  const save = () => void useFileSession.getState().save(tab.key);
  const reveal = () => void useFileSession.getState().reveal(tab.key);
  const hasBanner = !!tab.banner;

  return (
    <Stack direction="row" alignItems="center" spacing={1.5} data-testid="doc-bar"
      sx={{ height: DOC_BAR_HEIGHT, flexShrink: 0, px: 2, py: 0.75, borderBottom: 1, borderColor: "divider", bgcolor: "background.default", minWidth: 0 }}>
      <Box sx={{ minWidth: 120, maxWidth: hasBanner ? "26%" : "45%", flexShrink: 1 }}>
        <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
          <Typography variant="subtitle1" noWrap data-testid="doc-title" title={tab.title}
            sx={{ fontWeight: 600, lineHeight: 1.25, minWidth: 0 }}>
            {tab.title}
          </Typography>
          {tab.dirty && (
            <Tooltip title={STATUS.dirty}>
              <Box aria-label={STATUS.dirty} sx={{ width: 7, height: 7, borderRadius: "50%", bgcolor: "warning.main", flexShrink: 0 }} />
            </Tooltip>
          )}
          {tab.readOnly && <Chip size="small" variant="outlined" label={STATUS.readOnly} sx={{ height: 18, fontSize: 10.5 }} />}
        </Stack>
        <Stack direction="row" spacing={0.5} alignItems="center" sx={{ minWidth: 0, height: 20 }}>
          {tab.path ? (
            <>
              <FolderOutlinedIcon sx={{ fontSize: 13, color: "text.secondary", flexShrink: 0 }} />
              <Typography variant="caption" color="text.secondary" noWrap data-testid="doc-folder" title={tab.path}>
                {tab.folderLabel}
              </Typography>
              <Tooltip title={REVEAL_LABEL}>
                <IconButton size="small" aria-label={REVEAL_LABEL} data-testid="doc-reveal" onClick={reveal} sx={{ p: 0.25 }}>
                  <OpenInNewIcon sx={{ fontSize: 12 }} />
                </IconButton>
              </Tooltip>
            </>
          ) : (
            <Typography variant="caption" color="text.disabled" noWrap data-testid="doc-folder">{STATUS.untitled}</Typography>
          )}
        </Stack>
      </Box>

      <Box sx={{ flexGrow: 1, minWidth: 0, height: "100%", display: "flex", alignItems: "center" }}>
        <BannerSlot tab={tab} />
      </Box>

      <Stack direction="row" spacing={1} alignItems="center" sx={{ flexShrink: 0 }}>
        {tab.saving && <CircularProgress size={12} />}
        <Typography variant="caption" color={tab.notSaved ? "warning.main" : "text.secondary"} noWrap data-testid="doc-status"
          sx={{ display: hasBanner ? { xs: "none", lg: "block" } : "block" }}>
          {status}
        </Typography>
        <Tooltip title={shortcutText("s")}>
          <span>
            <Button size="small" variant={tab.dirty ? "contained" : "outlined"} disabled={!canSave} onClick={save}
              data-testid="doc-save" startIcon={<SaveOutlinedIcon />}>
              Save
            </Button>
          </span>
        </Tooltip>
        <FileMenu />
      </Stack>
    </Stack>
  );
}
