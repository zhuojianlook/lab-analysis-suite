import { useState } from "react";
import { Box, Button, CircularProgress, IconButton, Menu, MenuItem, Paper, Stack, Tooltip, Typography } from "@mui/material";
import MoreHorizIcon from "@mui/icons-material/MoreHoriz";
import SearchIcon from "@mui/icons-material/Search";
import RefreshIcon from "@mui/icons-material/Refresh";
import CloudDownloadOutlinedIcon from "@mui/icons-material/CloudDownloadOutlined";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import { useFileSession } from "../file/session";
import type { RestoreCard } from "../file/contract";
import { CARD_DRAFT_LINE, REVEAL_LABEL, cardBody, cardTitle } from "./text";

/** What the canvas shows for a tab whose file couldn't be opened (contract §5.4). */
export function RestoreCardView({ card }: { card: RestoreCard }) {
  const [moreAnchor, setMoreAnchor] = useState<HTMLElement | null>(null);
  const st = useFileSession.getState;
  const desktop = useFileSession((s) => s.desktop);
  const spinner = card.kind === "waiting" || card.kind === "downloading";
  const Icon = card.kind === "missing" ? HelpOutlineIcon : card.kind === "permission" ? LockOutlinedIcon
    : card.kind === "unreadable" ? ErrorOutlineIcon : CloudDownloadOutlinedIcon;

  return (
    <Box sx={{ flexGrow: 1, display: "grid", placeItems: "center", p: 3, overflow: "auto" }}>
      <Paper variant="outlined" data-testid="restore-card" data-kind={card.kind} sx={{ p: 3, width: 520, maxWidth: "100%" }}>
        <Stack direction="row" spacing={2} alignItems="flex-start">
          {spinner ? <CircularProgress size={26} sx={{ mt: 0.25, flexShrink: 0 }} />
            : <Icon sx={{ fontSize: 30, color: card.kind === "missing" ? "warning.main" : card.kind === "permission" ? "error.main" : "text.secondary", flexShrink: 0 }} />}
          <Box sx={{ minWidth: 0, flexGrow: 1 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>{cardTitle(card)}</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, wordBreak: "break-word" }}>{cardBody(card)}</Typography>
            {card.hasDraft && (
              <Typography variant="body2" sx={{ mt: 1 }}>{CARD_DRAFT_LINE}</Typography>
            )}
            {card.kind === "waiting" && (
              // Waiting for the cloud service can take a while: the file may also have been moved or deleted.
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 2 }} useFlexGap flexWrap="wrap">
                <Button variant="outlined" startIcon={<SearchIcon />} data-testid="card-find" onClick={() => void st().findIt(card.key)}>Find it…</Button>
                <Box sx={{ flexGrow: 1 }} />
                <Tooltip title="More">
                  <IconButton size="small" aria-label="More" data-testid="card-more" onClick={(e) => setMoreAnchor(e.currentTarget)}>
                    <MoreHorizIcon />
                  </IconButton>
                </Tooltip>
                <Menu anchorEl={moreAnchor} open={!!moreAnchor} onClose={() => setMoreAnchor(null)}>
                  <MenuItem dense data-testid="card-forget" onClick={() => { setMoreAnchor(null); void st().forget(card.key); }}>
                    Remove from this list (the file was deleted)
                  </MenuItem>
                </Menu>
              </Stack>
            )}
            {card.kind === "downloading" && (
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 2 }} useFlexGap flexWrap="wrap">
                {desktop && (
                  <Button variant="outlined" data-testid="card-reveal" onClick={() => void st().reveal(card.key)}>{REVEAL_LABEL}</Button>
                )}
                <Button variant="text" data-testid="card-close" onClick={() => void st().closeTab(card.key)}>Close tab</Button>
              </Stack>
            )}
            {!spinner && (
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 2 }} useFlexGap flexWrap="wrap">
                {card.kind === "missing" && (
                  <>
                    <Button variant="contained" startIcon={<SearchIcon />} data-testid="card-find" onClick={() => void st().findIt(card.key)}>Find it…</Button>
                    <Button variant="outlined" startIcon={<RefreshIcon />} data-testid="card-retry" onClick={() => void st().retry(card.key)}>Retry</Button>
                    <Box sx={{ flexGrow: 1 }} />
                    <Tooltip title="More">
                      <IconButton size="small" aria-label="More" data-testid="card-more" onClick={(e) => setMoreAnchor(e.currentTarget)}>
                        <MoreHorizIcon />
                      </IconButton>
                    </Tooltip>
                    <Menu anchorEl={moreAnchor} open={!!moreAnchor} onClose={() => setMoreAnchor(null)}>
                      <MenuItem dense data-testid="card-forget" onClick={() => { setMoreAnchor(null); void st().forget(card.key); }}>
                        Remove from this list (the file was deleted)
                      </MenuItem>
                    </Menu>
                  </>
                )}
                {card.kind === "permission" && (
                  <>
                    <Button variant="contained" data-testid="card-privacy" onClick={() => void st().openPrivacySettings()}>Open Privacy settings</Button>
                    <Button variant="outlined" startIcon={<RefreshIcon />} data-testid="card-retry" onClick={() => void st().retry(card.key)}>Retry</Button>
                  </>
                )}
                {card.kind === "unreadable" && (
                  <>
                    <Button variant="contained" startIcon={<RefreshIcon />} data-testid="card-retry" onClick={() => void st().retry(card.key)}>Try again</Button>
                    <Button variant="outlined" data-testid="card-close" onClick={() => void st().closeTab(card.key)}>Close tab</Button>
                  </>
                )}
              </Stack>
            )}
          </Box>
        </Stack>
      </Paper>
    </Box>
  );
}
