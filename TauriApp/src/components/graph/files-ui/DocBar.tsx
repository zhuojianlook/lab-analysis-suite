import { Box, Button, Chip, CircularProgress, IconButton, Stack, Tooltip, Typography, alpha } from "@mui/material";
import SaveOutlinedIcon from "@mui/icons-material/SaveOutlined";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import HistoryIcon from "@mui/icons-material/History";
import { useFileSession } from "../file/session";
import type { FileTab } from "../file/contract";
import { BannerSlot } from "./BannerSlot";
import { FileMenu } from "./FileMenu";
import { REVEAL_LABEL, STATUS, V, attemptBannerOf, bannerText, docStatusText, shortcutText } from "./text";
import { useTicker } from "./useTicker";

/** Height of the document bar. Fixed, so a banner appearing in it never moves the workspace. */
export const DOC_BAR_HEIGHT = 60;

/** Read-only because the file is too new, or because another computer is editing / a newer version is loading. */
export const isReadOnlyTab = (tab: FileTab) => !!tab.readOnly || !!tab.presence?.readOnly;

/** Title (the file name), the folder line with Show in Finder, the banner slot,
 *  the save state, Save and the File menu (contract §5.1 DocBar + BannerSlot). */
export function DocBar({ tab }: { tab: FileTab }) {
  const settings = useFileSession((s) => s.settings);
  // "Up to date · Alice saved 2 min ago" stays current.
  const now = useTicker(30_000, !!tab.presence?.status);
  const status = docStatusText(tab, settings, now);
  const readOnly = isReadOnlyTab(tab);
  const canSave = !readOnly && !tab.saving && tab.status === "ready";
  const roBanner = readOnly ? attemptBannerOf(tab) : null;
  const roWhy = roBanner ? bannerText(roBanner, settings) : "";
  const save = () => void useFileSession.getState().save(tab.key);
  const reveal = () => void useFileSession.getState().reveal(tab.key);
  const hasBanner = !!tab.banner;
  const versionsOpen = useFileSession((s) => s.versions?.tabKey === tab.key);
  const toggleVersions = () => {
    const s = useFileSession.getState();
    if (s.versions?.tabKey === tab.key) s.closeVersions();
    else void s.openVersions(tab.key);
  };

  return (
    <Stack direction="row" alignItems="center" spacing={1.5} data-testid="doc-bar"
      sx={{ height: DOC_BAR_HEIGHT, flexShrink: 0, px: 2, py: 0.75, borderBottom: 1, borderColor: "divider", bgcolor: "background.default", minWidth: 0 }}>
      <Box sx={{ minWidth: 120, maxWidth: hasBanner ? "26%" : "45%", flexShrink: 0 }}>
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
          {readOnly && (
            <Tooltip title={roWhy} enterDelay={300}>
              <Chip size="small" variant="outlined" label={STATUS.readOnly} data-testid="doc-readonly"
                sx={{ height: 18, fontSize: 10.5, flexShrink: 0, "& .MuiChip-label": { px: 0.75 } }} />
            </Tooltip>
          )}
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
        <Typography variant="caption" color={tab.notSaved ? "warning.main" : "text.secondary"} noWrap data-testid="doc-status" title={status}
          sx={{
            // Who saved stays visible beside a banner from md up while read-only (it replaces the per-save toasts; fixer F4).
            display: hasBanner ? (readOnly && tab.presence?.status ? { xs: "none", md: "block" } : { xs: "none", lg: "block" }) : "block",
            maxWidth: hasBanner ? 240 : 320, overflow: "hidden", textOverflow: "ellipsis",
          }}>
          {status}
        </Typography>
        <Tooltip title={readOnly ? STATUS.readOnlySave : shortcutText("s")}>
          {/* A click on the disabled Save of a read-only tab counts as an edit attempt (the banner's button pulses). */}
          <span data-testid="doc-save-wrap"
            onClick={() => { if (readOnly && !tab.saving) useFileSession.getState().reportEditAttempt("command", "save", tab.key); }}>
            <Button size="small" variant={tab.dirty ? "contained" : "outlined"} disabled={!canSave} onClick={save}
              data-testid="doc-save" startIcon={<SaveOutlinedIcon />}>
              Save
            </Button>
          </span>
        </Tooltip>
        <Tooltip title={V.versionsButton}>
          <span>
            <IconButton size="small" aria-label={V.versionsButton} aria-pressed={versionsOpen} data-testid="doc-versions"
              data-pressed={versionsOpen ? "true" : "false"} disabled={!tab.path} onClick={toggleVersions}
              sx={{
                border: 1, borderColor: versionsOpen ? "primary.main" : "divider", borderRadius: 1, p: 0.5,
                color: versionsOpen ? "primary.main" : "text.secondary",
                bgcolor: (t) => (versionsOpen ? alpha(t.palette.primary.main, 0.22) : "transparent"),
                "&:hover": { bgcolor: (t) => alpha(t.palette.primary.main, versionsOpen ? 0.3 : 0.08) },
              }}>
              <HistoryIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </span>
        </Tooltip>
        <FileMenu />
      </Stack>
    </Stack>
  );
}
