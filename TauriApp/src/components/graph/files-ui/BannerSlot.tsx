import { useState } from "react";
import { Box, Button, CircularProgress, IconButton, Popover, Stack, Tooltip, Typography, alpha, useTheme } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import CloudDownloadOutlinedIcon from "@mui/icons-material/CloudDownloadOutlined";
import { useFileSession } from "../file/session";
import type { FileTab, TabBanner } from "../file/contract";
import { bannerActionLabel, bannerSeverity, bannerText, type Severity } from "./text";

const ICONS: Record<Severity, typeof InfoOutlinedIcon> = {
  error: ErrorOutlineIcon, warning: WarningAmberIcon, info: InfoOutlinedIcon, success: CheckCircleOutlineIcon,
};

function BannerBody({ tab, banner, compact, more, onMore }: {
  tab: FileTab; banner: TabBanner; compact: boolean; more?: number; onMore?: (el: HTMLElement) => void;
}) {
  const theme = useTheme();
  const settings = useFileSession((s) => s.settings);
  const sev = bannerSeverity(banner);
  const color = theme.palette[sev].main;
  const Icon = banner.kind === "downloading" ? CloudDownloadOutlinedIcon : ICONS[sev];
  const text = bannerText(banner, settings);
  const act = (a: TabBanner["actions"][number]) => void useFileSession.getState().bannerAction(tab.key, banner.id, a);
  return (
    <Stack direction="row" spacing={1} alignItems="center" data-testid="file-banner" data-kind={banner.kind}
      role={sev === "error" || sev === "warning" ? "alert" : "status"}
      sx={{
        minWidth: 0, flexGrow: 1, height: compact ? "100%" : "auto", px: 1.25, py: compact ? 0 : 1, borderRadius: 1,
        bgcolor: alpha(color, 0.12), border: 1, borderColor: alpha(color, 0.35),
      }}>
      {banner.kind === "savedOver" && banner.state === "combining"
        ? <CircularProgress size={15} sx={{ color, flexShrink: 0 }} data-testid="banner-combining" />
        : <Icon sx={{ fontSize: 18, color, flexShrink: 0 }} />}
      <Tooltip title={compact ? text : ""} placement="bottom-start" enterDelay={600}>
        <Typography variant="body2" sx={{
          flexGrow: 1, minWidth: 0, fontSize: 12.5, lineHeight: 1.3,
          ...(compact ? { fontSize: 12, lineHeight: 1.25, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" } : {}),
        }}>
          {text}
        </Typography>
      </Tooltip>
      <Stack direction="row" spacing={0.5} sx={{ flexShrink: 0 }} alignItems="center">
        {banner.actions.map((a, i) => (
          <Button key={a} size="small" variant={i === 0 ? "outlined" : "text"} color="inherit" data-testid={`banner-${a}`}
            onClick={() => act(a)} sx={{ whiteSpace: "nowrap", py: 0.25, borderColor: alpha(color, 0.6) }}>
            {bannerActionLabel(banner.kind, a)}
          </Button>
        ))}
        {more ? (
          <Button size="small" color="inherit" data-testid="banner-more" sx={{ whiteSpace: "nowrap", minWidth: 0, py: 0.25, color: "text.secondary" }}
            onClick={(e) => onMore?.(e.currentTarget)}>
            +{more} more
          </Button>
        ) : null}
        {banner.dismissible && !banner.actions.includes("dismiss") && (
          <Tooltip title="Close">
            <IconButton size="small" aria-label="Close" data-testid="banner-dismiss"
              onClick={() => useFileSession.getState().dismissBanner(tab.key, banner.id)}>
              <CloseIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        )}
      </Stack>
    </Stack>
  );
}

/** The one banner slot of a document (contract §5.1): the most important banner,
 *  "+n more" for the rest. It lives inside the fixed-height document bar, so a
 *  banner coming or going never moves the workspace. */
export function BannerSlot({ tab }: { tab: FileTab }) {
  const [moreAnchor, setMoreAnchor] = useState<HTMLElement | null>(null);
  const banner = tab.banner;
  if (!banner) return null;
  const rest = tab.banners.slice(1);
  return (
    <>
      <BannerBody tab={tab} banner={banner} compact more={rest.length} onMore={setMoreAnchor} />
      <Popover open={!!moreAnchor && rest.length > 0} anchorEl={moreAnchor} onClose={() => setMoreAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }} transformOrigin={{ vertical: "top", horizontal: "right" }}>
        <Box sx={{ p: 1, width: 560, maxWidth: "90vw" }}>
          <Stack spacing={1}>
            {rest.map((b) => <BannerBody key={b.id} tab={tab} banner={b} compact={false} />)}
          </Stack>
        </Box>
      </Popover>
    </>
  );
}
