import { useEffect, useRef, useState } from "react";
import { Box, Button, CircularProgress, IconButton, Popover, Stack, Tooltip, Typography, alpha, useTheme } from "@mui/material";
import { keyframes } from "@mui/material/styles";
import CloseIcon from "@mui/icons-material/Close";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import CloudDownloadOutlinedIcon from "@mui/icons-material/CloudDownloadOutlined";
import { useFileSession } from "../file/session";
import { LIMITS_P3, type FileTab, type TabBanner } from "../file/contract";
import { attemptBannerOf, bannerActionLabel, bannerSeverity, bannerText, type Severity } from "./text";
import { useTicker } from "./useTicker";

/** A refused edit: the banner's button glows a few times (no layout change: a shadow, not a border). */
const glow = (c: string) => keyframes`
  0% { box-shadow: 0 0 0 0 ${alpha(c, 0.75)}; }
  70% { box-shadow: 0 0 0 7px ${alpha(c, 0)}; }
  100% { box-shadow: 0 0 0 0 ${alpha(c, 0)}; }
`;
const PULSE_ROUNDS = Math.max(1, Math.round(LIMITS_P3.attemptPulseMs / 1000));

/** True for attemptPulseMs after tab.presence.attempt grew (restarts with every new attempt); `n` changes with each. */
function useAttemptPulse(tab: FileTab): { on: boolean; n: number } {
  const attempt = tab.presence?.attempt ?? 0;
  const seen = useRef({ key: tab.key, attempt });
  const [pulse, setPulse] = useState({ on: false, n: 0 });
  useEffect(() => {
    const prev = seen.current;
    seen.current = { key: tab.key, attempt };
    if (prev.key !== tab.key || attempt <= prev.attempt) return;
    setPulse((p) => ({ on: true, n: p.n + 1 }));
  }, [tab.key, attempt]);
  useEffect(() => {
    if (!pulse.on) return;
    const h = setTimeout(() => setPulse((p) => ({ ...p, on: false })), LIMITS_P3.attemptPulseMs);
    return () => clearTimeout(h);
  }, [pulse.on, pulse.n]);
  useEffect(() => { setPulse((p) => (p.on ? { ...p, on: false } : p)); }, [tab.key]);
  return pulse;
}

const ICONS: Record<Severity, typeof InfoOutlinedIcon> = {
  error: ErrorOutlineIcon, warning: WarningAmberIcon, info: InfoOutlinedIcon, success: CheckCircleOutlineIcon,
};

function BannerBody({ tab, banner, compact, more, onMore, pulse, onExpand }: {
  tab: FileTab; banner: TabBanner; compact: boolean; more?: number; onMore?: () => void; pulse?: number;
  /** Fixer VUX-10: a click on the (possibly cut) text of the compact banner shows it in full. */
  onExpand?: () => void;
}) {
  const theme = useTheme();
  const settings = useFileSession((s) => s.settings);
  // "note updated 2 min ago" and similar stay current.
  useTicker(30_000, !!banner.peers?.length);
  const sev = bannerSeverity(banner);
  const color = theme.palette[sev].main;
  const pulseSx = pulse ? {
    animation: `${glow(color)} 1s ease-out ${PULSE_ROUNDS}`,
    bgcolor: alpha(color, 0.28),
  } : {};
  const pulseButton = pulse && banner.actions.length > 0;
  const Icon = banner.kind === "downloading" ? CloudDownloadOutlinedIcon : ICONS[sev];
  const text = bannerText(banner, settings);
  const act = (a: TabBanner["actions"][number]) => void useFileSession.getState().bannerAction(tab.key, banner.id, a);
  return (
    <Stack direction="row" spacing={1} alignItems="center" data-testid="file-banner" data-kind={banner.kind}
      data-pulse={pulse && !pulseButton ? "true" : undefined}
      role={sev === "error" || sev === "warning" ? "alert" : "status"}
      sx={{
        minWidth: 0, flexGrow: 1, height: compact ? "100%" : "auto", px: 1.25, py: compact ? 0 : 1, borderRadius: 1,
        bgcolor: alpha(color, pulse ? 0.22 : 0.12), border: 1, borderColor: alpha(color, pulse ? 0.7 : 0.35),
        transition: "background-color 200ms, border-color 200ms",
        // A refused edit: the whole banner glows as well as its button, so it is noticed (fixer F8).
        ...(pulse ? { animation: `${glow(color)} 1s ease-out ${PULSE_ROUNDS}` } : {}),
      }}>
      {banner.kind === "savedOver" && banner.state === "combining"
        ? <CircularProgress size={15} sx={{ color, flexShrink: 0 }} data-testid="banner-combining" />
        : <Icon sx={{ fontSize: 18, color, flexShrink: 0 }} />}
      <Tooltip title={compact ? text : ""} placement="bottom-start" enterDelay={600}>
        <Typography variant="body2" data-testid="banner-text" onClick={compact ? onExpand : undefined} sx={{
          flexGrow: 1, minWidth: 0, fontSize: 12.5, lineHeight: 1.3,
          ...(compact ? { fontSize: 12, lineHeight: 1.25, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" } : {}),
          ...(compact && onExpand ? { cursor: "pointer" } : {}),
        }}>
          {text}
        </Typography>
      </Tooltip>
      <Stack direction="row" spacing={0.5} sx={{ flexShrink: 0 }} alignItems="center">
        {banner.actions.map((a, i) => (
          <Button key={i === 0 && pulseButton ? `${a}:${pulse}` : a} size="small" variant={i === 0 ? "outlined" : "text"} color="inherit"
            data-testid={`banner-${a}`} data-pulse={i === 0 && pulseButton ? "true" : undefined}
            onClick={() => act(a)}
            sx={{ whiteSpace: "nowrap", py: 0.25, borderColor: alpha(color, 0.6), ...(i === 0 && pulseButton ? pulseSx : {}) }}>
            {bannerActionLabel(banner.kind, a, banner.state)}
          </Button>
        ))}
        {more ? (
          <Button size="small" color="inherit" data-testid="banner-more" sx={{ whiteSpace: "nowrap", minWidth: 0, py: 0.25, color: "text.secondary" }}
            onClick={() => onMore?.()}>
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
  // The "+n more" list is anchored to the slot itself, which stays mounted while banners come and go (the
  // main banner is keyed by id and remounts; anchoring to its button left the list floating at the top left
  // with a detached anchor — fixer F1).
  const slotRef = useRef<HTMLDivElement | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [fullOpen, setFullOpen] = useState(false);
  const pulse = useAttemptPulse(tab);
  // While another computer is editing, the banner that says who (and offers Edit here) is always the main one, not
  // under "+n more" (fixer F3). A refused edit shows the banner that explains it as the main one while it pulses.
  const roMain = tab.presence?.readOnly ? attemptBannerOf(tab) : null;
  const target = pulse.on ? attemptBannerOf(tab) : null;
  const banner = target ?? roMain ?? tab.banner;
  const rest = banner ? tab.banners.filter((b) => b !== banner) : [];
  const mainId = banner?.id ?? null;
  useEffect(() => { setMoreOpen(false); setFullOpen(false); }, [mainId, tab.key]);
  useEffect(() => { if (rest.length === 0) setMoreOpen(false); }, [rest.length]);
  if (!banner) return null;
  return (
    <Box ref={slotRef} sx={{ display: "flex", alignItems: "center", flexGrow: 1, minWidth: 0, height: "100%" }}>
      <BannerBody key={banner.id} tab={tab} banner={banner} compact more={rest.length} onMore={() => setMoreOpen(true)} pulse={target ? pulse.n : undefined}
        onExpand={() => setFullOpen(true)} />
      <Popover open={fullOpen && !!slotRef.current} anchorEl={() => slotRef.current!} onClose={() => setFullOpen(false)}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }} transformOrigin={{ vertical: "top", horizontal: "left" }}>
        <Box sx={{ p: 1, width: 560, maxWidth: "90vw" }} data-testid="banner-full">
          <BannerBody tab={tab} banner={banner} compact={false} />
        </Box>
      </Popover>
      <Popover open={moreOpen && rest.length > 0 && !!slotRef.current} anchorEl={() => slotRef.current!} onClose={() => setMoreOpen(false)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }} transformOrigin={{ vertical: "top", horizontal: "right" }}>
        <Box sx={{ p: 1, width: 560, maxWidth: "90vw" }}>
          <Stack spacing={1}>
            {rest.map((b) => <BannerBody key={b.id} tab={tab} banner={b} compact={false} />)}
          </Stack>
        </Box>
      </Popover>
    </Box>
  );
}
