import { useRef, useState } from "react";
import { Badge, Box, Button, Divider, ListItemText, Menu, MenuItem, Typography } from "@mui/material";
import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import { useFileSession } from "../file/session";
import { MENU, type MenuId } from "../file/contract";
import { MENU_TEXT, shortcutText } from "./text";

/** The in-window File menu: the same items, order and shortcuts as the native
 *  File menu (contract §6.1), each calling the controller's menu(id). */
export function FileMenu({ variant = "text" }: { variant?: "text" | "outlined" }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [recentAnchor, setRecentAnchor] = useState<HTMLElement | null>(null);
  const recentItemRef = useRef<HTMLLIElement | null>(null);
  const activeKey = useFileSession((s) => s.activeKey);
  const tab = useFileSession((s) => s.tabs.find((t) => t.key === s.activeKey) ?? null);
  const recent = useFileSession((s) => s.recent);
  const oldLibrary = useFileSession((s) => s.oldLibrary);

  const hasDoc = activeKey !== null;
  const canSave = hasDoc && !!tab && !tab.readOnly && !tab.saving && tab.status === "ready";
  const hasOld = (oldLibrary?.total ?? 0) > 0;
  const unexported = oldLibrary?.unexported ?? 0;

  // Open Recent opens to the left when there is no room on the right (the button sits at the bar's right end).
  const openLeft = !!recentAnchor && recentAnchor.getBoundingClientRect().right + 300 > window.innerWidth;
  const close = () => { setRecentAnchor(null); setAnchor(null); };
  const run = (id: MenuId, path?: string) => {
    close();
    void useFileSession.getState().menu(id, path ?? null);
  };

  const item = (id: MenuId, label: string, opts: { disabled?: boolean; key?: string; shift?: boolean; badge?: number } = {}) => (
    <MenuItem key={id} dense disabled={opts.disabled} onClick={() => run(id)} onMouseEnter={() => setRecentAnchor(null)} data-testid={`menu-${id}`}>
      <ListItemText primary={
        opts.badge ? (
          <Badge color="primary" variant="dot" sx={{ "& .MuiBadge-dot": { right: -8, top: 6 } }}>{label}</Badge>
        ) : label
      } />
      {opts.key && (
        <Typography variant="caption" color="text.secondary" sx={{ ml: 3 }}>{shortcutText(opts.key, opts.shift)}</Typography>
      )}
    </MenuItem>
  );

  return (
    <>
      <Badge color="primary" variant="dot" invisible={unexported === 0} overlap="rectangular"
        sx={{ "& .MuiBadge-dot": { right: 6, top: 6 } }}>
        <Button size="small" variant={variant} color="inherit" endIcon={<ArrowDropDownIcon />}
          data-testid="file-menu-button" aria-haspopup="menu" onClick={(e) => setAnchor(e.currentTarget)}>
          File
        </Button>
      </Badge>
      <Menu anchorEl={anchor} open={!!anchor} onClose={close} slotProps={{ paper: { sx: { minWidth: 280 } } }}>
        {item(MENU.new, MENU_TEXT.new, { key: "n" })}
        {item(MENU.open, MENU_TEXT.open, { key: "o" })}
        <MenuItem dense ref={recentItemRef} data-testid="menu-file.open_recent"
          onClick={() => setRecentAnchor(recentItemRef.current)}
          onMouseEnter={() => setRecentAnchor(recentItemRef.current)}>
          <ListItemText primary={MENU_TEXT.openRecent} />
          <ChevronRightIcon fontSize="small" sx={{ color: "text.secondary", ml: 2 }} />
        </MenuItem>
        <Divider />
        {item(MENU.save, MENU_TEXT.save, { key: "s", disabled: !canSave })}
        {item(MENU.saveAs, MENU_TEXT.saveAs, { key: "s", shift: true, disabled: !hasDoc || !!tab?.readOnly })}
        {item(MENU.duplicate, MENU_TEXT.duplicate, { disabled: !hasDoc })}
        <Divider />
        {item(MENU.closeTab, MENU_TEXT.closeTab, { key: "w", disabled: !hasDoc })}
        {item(MENU.versions, MENU_TEXT.versions, { disabled: !hasDoc || !tab?.path })}
        <Divider />
        {item(MENU.recover, MENU_TEXT.recover)}
        {item(MENU.oldLibrary, MENU_TEXT.oldLibrary, { disabled: !hasOld })}
        {item(MENU.exportLibrary, MENU_TEXT.exportLibrary, { disabled: !hasOld, badge: unexported })}
        <Divider />
        {item(MENU.settings, MENU_TEXT.settings)}
      </Menu>
      <Menu anchorEl={recentAnchor} open={!!recentAnchor && !!anchor} onClose={() => setRecentAnchor(null)}
        anchorOrigin={{ vertical: "top", horizontal: openLeft ? "left" : "right" }}
        transformOrigin={{ vertical: "top", horizontal: openLeft ? "right" : "left" }}
        slotProps={{ paper: { sx: { minWidth: 260, maxWidth: 420, pointerEvents: "auto" } }, root: { sx: { pointerEvents: "none" } } }}
        disableAutoFocus disableEnforceFocus hideBackdrop>
        {recent.length === 0 && <MenuItem dense disabled>{MENU_TEXT.noRecent}</MenuItem>}
        {recent.slice(0, 10).map((r) => (
          <MenuItem key={r.path} dense onClick={() => run(MENU.openRecent, r.path)} data-testid="menu-recent-item">
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="body2" noWrap>{r.name}</Typography>
              <Typography variant="caption" color="text.secondary" noWrap component="div">{r.folderLabel}</Typography>
            </Box>
          </MenuItem>
        ))}
        {recent.length > 0 && <Divider />}
        {recent.length > 0 && <MenuItem dense onClick={() => run(MENU.clearRecent)}>{MENU_TEXT.clearRecent}</MenuItem>}
      </Menu>
    </>
  );
}
