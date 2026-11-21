import { useState } from "react";
import { Box, Chip, IconButton, Menu, MenuItem, Stack, Tooltip, Typography } from "@mui/material";
import InsertDriveFileOutlinedIcon from "@mui/icons-material/InsertDriveFileOutlined";
import MoreHorizIcon from "@mui/icons-material/MoreHoriz";
import { useFileSession } from "../file/session";
import type { RecentItem } from "../file/contract";
import { T, whenText } from "./text";

function RecentRow({ item }: { item: RecentItem }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const st = useFileSession.getState;
  const open = () => void st().openRecent(item.path);
  return (
    <Box data-testid="recent-item" data-path={item.path} role="button" tabIndex={0}
      onClick={open} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } }}
      sx={{
        px: 1.25, py: 0.75, borderRadius: 1, cursor: "pointer", display: "flex", alignItems: "center", gap: 1.25,
        "&:hover": { bgcolor: "action.hover" }, "&:hover .recent-more": { opacity: 1 },
        "&:focus-visible": { outline: 2, outlineColor: "primary.main", outlineStyle: "solid" },
      }}>
      <InsertDriveFileOutlinedIcon sx={{ fontSize: 20, color: item.missing ? "text.disabled" : "text.secondary", flexShrink: 0 }} />
      <Box sx={{ minWidth: 0, flexGrow: 1 }}>
        <Stack direction="row" spacing={0.75} alignItems="center">
          <Typography variant="body2" noWrap sx={{ fontWeight: 500, color: item.missing ? "text.secondary" : "text.primary" }}>{item.name}</Typography>
          {item.missing && <Chip size="small" color="warning" variant="outlined" label={T.recentMissing} sx={{ height: 18, fontSize: 10.5 }} />}
          {item.open && <Chip size="small" color="primary" variant="outlined" label="open" sx={{ height: 18, fontSize: 10.5 }} />}
        </Stack>
        <Typography variant="caption" color="text.secondary" noWrap component="div" title={item.path}>
          {item.folderLabel}{item.openedAt ? ` · ${T.recentOpened(whenText(item.openedAt))}` : ""}
        </Typography>
      </Box>
      <Tooltip title="More">
        <IconButton size="small" aria-label={`More for ${item.name}`} className="recent-more" data-testid="recent-more"
          onClick={(e) => { e.stopPropagation(); setAnchor(e.currentTarget); }} sx={{ opacity: anchor ? 1 : 0.4 }}>
          <MoreHorizIcon sx={{ fontSize: 18 }} />
        </IconButton>
      </Tooltip>
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)} onClick={(e) => e.stopPropagation()}>
        <MenuItem dense data-testid="recent-remove" onClick={() => { setAnchor(null); void st().removeRecent(item.path); }}>
          {T.recentRemove}
        </MenuItem>
      </Menu>
    </Box>
  );
}

/** Recent files on the start screen (contract §5.1), in place of the old in-app list. */
export function RecentFiles() {
  const recent = useFileSession((s) => s.recent);
  const ready = useFileSession((s) => s.ready);
  return (
    <Box data-testid="recent-list">
      {ready && recent.length === 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>{T.recentEmpty}</Typography>
      )}
      <Stack spacing={0.25}>
        {recent.map((r) => <RecentRow key={r.path} item={r} />)}
      </Stack>
    </Box>
  );
}
