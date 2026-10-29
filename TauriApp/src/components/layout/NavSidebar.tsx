import { Badge, Box, ButtonBase, Divider, Tooltip, Typography } from "@mui/material";
import type { SvgIconComponent } from "@mui/icons-material";
import ScienceIcon from "@mui/icons-material/Science";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import KeyboardDoubleArrowLeftIcon from "@mui/icons-material/KeyboardDoubleArrowLeft";
import KeyboardDoubleArrowRightIcon from "@mui/icons-material/KeyboardDoubleArrowRight";

export interface NavItem {
  id: string;
  label: string;
  group: string;
  icon: SvgIconComponent;
  badge?: number;
}

export interface NavStatus {
  label: string;
  tone: "ok" | "warn" | "error" | "pending";
  detail?: string;
}

const WIDE = 200;
const NARROW = 56;
/** Darker than both the canvas (background.default) and the tools' control
 *  rails (background.paper), so the app frame reads apart from the workspace. */
const NAV_BG = "#161618";
const MOD = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform) ? "⌘" : "Ctrl+";

/** One clickable row: icon (+ label when expanded). Collapsed rows explain
 *  themselves with a tooltip instead. */
function NavRow({
  icon: Icon, label, hint, active, collapsed, badge, onClick,
}: {
  icon: SvgIconComponent; label: string; hint?: string; active?: boolean;
  collapsed: boolean; badge?: number; onClick: () => void;
}) {
  const row = (
    <ButtonBase
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      aria-label={collapsed ? label : undefined}
      sx={{
        position: "relative",
        width: "100%",
        height: 34,
        px: collapsed ? 0 : 1.25,
        gap: 1.25,
        justifyContent: collapsed ? "center" : "flex-start",
        borderRadius: 1.5,
        color: active ? "text.primary" : "text.secondary",
        bgcolor: active ? "action.selected" : "transparent",
        transition: "background-color .12s, color .12s",
        "&:hover": { bgcolor: active ? "action.selected" : "action.hover", color: "text.primary" },
        "&.Mui-focusVisible": { outline: "2px solid", outlineColor: "primary.main", outlineOffset: -2 },
        "&::before": active
          ? { content: '""', position: "absolute", left: -8, top: 8, bottom: 8, width: 3, borderRadius: 2, bgcolor: "primary.main" }
          : undefined,
      }}
    >
      <Badge
        badgeContent={badge}
        color="primary"
        max={99}
        invisible={!badge}
        sx={{ "& .MuiBadge-badge": { fontSize: 9, height: 15, minWidth: 15, px: 0.4 } }}
      >
        <Icon sx={{ fontSize: 19, color: active ? "primary.main" : "inherit" }} />
      </Badge>
      {!collapsed && (
        <Typography variant="body2" noWrap sx={{ fontWeight: active ? 600 : 400, flexGrow: 1, textAlign: "left" }}>
          {label}
        </Typography>
      )}
    </ButtonBase>
  );
  const tip = collapsed ? (hint ? `${label}  ·  ${hint}` : label) : hint;
  return tip ? (
    <Tooltip title={tip} placement="right" enterDelay={collapsed ? 150 : 800}>{row}</Tooltip>
  ) : row;
}

function StatusLine({ status, collapsed }: { status: NavStatus; collapsed: boolean }) {
  const color = { ok: "success.main", warn: "warning.main", error: "error.main", pending: "text.disabled" }[status.tone];
  const line = (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, height: 22, px: collapsed ? 0 : 1.25, justifyContent: collapsed ? "center" : "flex-start" }}>
      <Box sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: color, flexShrink: 0 }} />
      {!collapsed && <Typography variant="caption" color="text.secondary" noWrap>{status.label}</Typography>}
    </Box>
  );
  const tip = collapsed ? [status.label, status.detail].filter(Boolean).join(" — ") : status.detail;
  return tip ? <Tooltip title={tip} placement="right">{line}</Tooltip> : line;
}

/** Grouped, collapsible app navigation (replaces the old top tab strip):
 *  brand at the top, one section per tool group, engine/R status and app
 *  actions in the footer. */
export function NavSidebar({
  items, active, onSelect, collapsed, onToggleCollapsed, statuses, onAbout,
}: {
  items: NavItem[];
  active: string;
  onSelect: (id: string) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  statuses: NavStatus[];
  onAbout: () => void;
}) {
  const groups = [...new Set(items.map((i) => i.group))];
  return (
    <Box
      component="nav"
      aria-label="Analyses"
      sx={{
        width: collapsed ? NARROW : WIDE,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        bgcolor: NAV_BG,
        borderRight: 1,
        borderColor: "divider",
        overflow: "hidden",
        transition: "width .18s ease",
      }}
    >
      <Box sx={{ height: 52, flexShrink: 0, display: "flex", alignItems: "center", gap: 1, px: collapsed ? 0 : 1.75, justifyContent: collapsed ? "center" : "flex-start" }}>
        <ScienceIcon sx={{ fontSize: 20, color: "primary.main" }} />
        {!collapsed && <Typography variant="subtitle2" noWrap sx={{ fontWeight: 700 }}>Lab Analysis Suite</Typography>}
      </Box>

      <Box sx={{ flexGrow: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", px: 1, pb: 1 }}>
        {groups.map((g, gi) => (
          <Box key={g} sx={{ mt: gi ? 1.25 : 0.25 }}>
            {collapsed ? (
              gi > 0 && <Divider sx={{ mx: 1, mb: 1.25 }} />
            ) : (
              <Typography variant="overline" color="text.disabled"
                sx={{ display: "block", px: 1.25, fontSize: 10.5, letterSpacing: 0.8, lineHeight: 2.2 }}>
                {g}
              </Typography>
            )}
            <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25 }}>
              {items.filter((i) => i.group === g).map((i) => {
                const n = items.indexOf(i) + 1;
                return (
                  <NavRow key={i.id} icon={i.icon} label={i.label} badge={i.badge} collapsed={collapsed}
                    active={i.id === active} hint={n <= 9 ? `${MOD}${n}` : undefined} onClick={() => onSelect(i.id)} />
                );
              })}
            </Box>
          </Box>
        ))}
      </Box>

      <Box sx={{ flexShrink: 0, borderTop: 1, borderColor: "divider", px: 1, py: 1, display: "flex", flexDirection: "column", gap: 0.25 }}>
        <Box sx={{ mb: 0.5 }}>
          {statuses.map((s, i) => <StatusLine key={i} status={s} collapsed={collapsed} />)}
        </Box>
        <NavRow icon={InfoOutlinedIcon} label="About & updates" collapsed={collapsed} onClick={onAbout} />
        <NavRow icon={collapsed ? KeyboardDoubleArrowRightIcon : KeyboardDoubleArrowLeftIcon}
          label={collapsed ? "Expand sidebar" : "Collapse sidebar"} collapsed={collapsed} onClick={onToggleCollapsed} />
      </Box>
    </Box>
  );
}
