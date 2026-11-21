import { Box, CircularProgress, IconButton, Stack, Tooltip, Typography } from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import CloseIcon from "@mui/icons-material/Close";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import CloudDownloadOutlinedIcon from "@mui/icons-material/CloudDownloadOutlined";
import { useFileSession } from "../file/session";
import type { FileTab } from "../file/contract";
import { bannerSeverity, shortcutText } from "./text";

export const FILE_TABS_HEIGHT = 34;

/** Icon after a tab's title: something needs attention, it can't be edited, or it is still arriving. */
function tabIcon(t: FileTab) {
  if (t.status === "missing" || t.status === "permission" || t.status === "unreadable") {
    return { Icon: ErrorOutlineIcon, color: "error.main", label: t.status === "missing" ? "Can't be found" : "Can't be read" };
  }
  if (t.status === "waiting" || t.status === "downloading") return { Icon: CloudDownloadOutlinedIcon, color: "text.secondary", label: "Downloading" };
  if (t.notSaved) return { Icon: WarningAmberIcon, color: "warning.main", label: "Not saved" };
  const sev = t.banner ? bannerSeverity(t.banner) : null;
  if (sev === "error") return { Icon: ErrorOutlineIcon, color: "error.main", label: "Needs attention" };
  if (sev === "warning") return { Icon: WarningAmberIcon, color: "warning.main", label: "Needs attention" };
  if (t.readOnly) return { Icon: LockOutlinedIcon, color: "text.secondary", label: "Read only" };
  return null;
}

/** The strip of open analyses (contract §5.1): title, unsaved dot, a warning
 *  icon, × to close (middle-click also closes), + for the start screen. */
export function FileTabs() {
  const tabs = useFileSession((s) => s.tabs);
  const activeKey = useFileSession((s) => s.activeKey);
  const busy = useFileSession((s) => s.busy);
  const st = useFileSession.getState;

  const select = (key: string) => { if (!busy && key !== activeKey) void st().switchTab(key); };
  const close = (key: string) => void st().closeTab(key);

  return (
    <Stack direction="row" alignItems="stretch" data-testid="file-tabs" role="tablist" aria-label="Open analyses"
      sx={{ height: FILE_TABS_HEIGHT, flexShrink: 0, bgcolor: "#232325", borderBottom: 1, borderColor: "divider", pl: 0.5, minWidth: 0 }}>
      <Stack direction="row" alignItems="stretch" sx={{ minWidth: 0, overflowX: "auto", scrollbarWidth: "none", "&::-webkit-scrollbar": { display: "none" } }}>
        {tabs.map((t) => {
          const active = t.key === activeKey;
          const icon = tabIcon(t);
          return (
            <Box key={t.key} role="tab" aria-selected={active} data-testid={`file-tab-${t.key}`} data-active={active ? "true" : "false"}
              title={t.path ?? t.title}
              onClick={() => select(t.key)}
              onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
              onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); close(t.key); } }}
              sx={{
                display: "flex", alignItems: "center", gap: 0.75, pl: 1.5, pr: 0.5, minWidth: 96, maxWidth: 220, flexShrink: 1,
                cursor: active ? "default" : "pointer", userSelect: "none", position: "relative",
                bgcolor: active ? "background.default" : "transparent",
                borderRight: 1, borderColor: "divider",
                "&::before": active ? { content: '""', position: "absolute", left: 0, right: 0, top: 0, height: 2, bgcolor: "primary.main" } : {},
                "&:hover": { bgcolor: active ? "background.default" : "action.hover" },
                "&:hover .tab-close, & .tab-close:focus-visible": { opacity: 1 },
                "&:hover .tab-dot": { opacity: 0 },
              }}>
              <Typography variant="body2" noWrap sx={{ fontSize: 12.5, minWidth: 0, flexGrow: 1, color: active ? "text.primary" : "text.secondary" }}>
                {t.title}
              </Typography>
              {t.status === "opening" && !icon && (
                <CircularProgress size={11} thickness={5} aria-label="Opening" sx={{ flexShrink: 0, color: "text.secondary" }} />
              )}
              {icon && (
                <Tooltip title={icon.label}>
                  <icon.Icon sx={{ fontSize: 14, color: icon.color, flexShrink: 0 }} />
                </Tooltip>
              )}
              <Box sx={{ position: "relative", width: 22, height: 22, flexShrink: 0, display: "grid", placeItems: "center" }}>
                {t.dirty && (
                  <Box data-testid="tab-dirty" aria-label="Unsaved changes" className="tab-dot"
                    sx={{ width: 7, height: 7, borderRadius: "50%", bgcolor: "warning.main", position: "absolute", pointerEvents: "none" }} />
                )}
                <Tooltip title={`Close (${shortcutText("w")})`}>
                  <IconButton size="small" aria-label={`Close ${t.title}`} data-testid="tab-close" className="tab-close"
                    onClick={(e) => { e.stopPropagation(); close(t.key); }}
                    sx={{ p: 0.25, opacity: active && !t.dirty ? 1 : 0, "&:hover": { bgcolor: "action.selected" } }}>
                    <CloseIcon sx={{ fontSize: 14 }} />
                  </IconButton>
                </Tooltip>
              </Box>
            </Box>
          );
        })}
      </Stack>
      <Tooltip title="New analysis">
        <IconButton size="small" aria-label="New analysis" data-testid="tab-new" onClick={() => void st().showStart()}
          sx={{ alignSelf: "center", mx: 0.5 }}>
          <AddIcon sx={{ fontSize: 18 }} />
        </IconButton>
      </Tooltip>
    </Stack>
  );
}
