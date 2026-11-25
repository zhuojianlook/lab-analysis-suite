/* Phase 3 (read-only while another computer is editing): the editor's way of showing and enforcing
   "this can't be changed right now". The graph store refuses every change anyway; these make the
   controls look unavailable and turn a click on them into a reported edit attempt (the banner's
   button pulses). No layout changes: the same elements are rendered with or without the guard. */

import { useCallback, useEffect, type ReactNode } from "react";
import { Box, type SxProps, type Theme } from "@mui/material";
import { useGraphStore } from "../../store/graphStore";
import type { EditPath } from "./file/contract";

/** The open analysis is read-only (the store has a guard). */
export const useReadOnly = (): boolean => useGraphStore((s) => s.guard !== null);

/** Report an edit attempt that never reached a store action. */
export const reportBlocked = (path: EditPath, action: string): void => useGraphStore.getState().noteBlockedEdit(path, action);

/** Phase 3 fix: for a field that keeps typed text until it commits (blur / Enter): pass the result as its
 *  `onTyping`. Its first keystroke claims the analysis (graphStore.beginTyping), as a committed change would, so
 *  this computer is never made read-only while the person is typing in it. */
export function useTypingReport(owner: string): (typed: boolean) => void {
  useEffect(() => () => useGraphStore.getState().endTyping(owner), [owner]);
  return useCallback((typed: boolean) => {
    const st = useGraphStore.getState();
    if (typed) st.beginTyping(owner); else st.endTyping(owner);
  }, [owner]);
}

/** Opacity of controls that can't be used while the analysis is read-only. */
export const READONLY_OPACITY = 0.6;

/** One rail section body (or another group of setting controls): while `on`, everything inside is
 *  `inert` (no focus, no clicks, no keys), dimmed, and a transparent layer on top reports a click as an
 *  edit attempt of `path`. Scrolling the rail over it still works (wheel events reach the rail). */
export function RailGuard({ on, path, children, sx }: { on: boolean; path: EditPath; children: ReactNode; sx?: SxProps<Theme> }) {
  return (
    <Box data-railguard={path} data-readonly={on ? "true" : "false"} aria-disabled={on ? "true" : undefined}
      sx={[{ position: "relative" }, ...(Array.isArray(sx) ? sx : sx ? [sx] : [])]}>
      <Box inert={on || undefined} sx={{ opacity: on ? READONLY_OPACITY : 1, transition: "opacity 0.15s" }}>
        {children}
      </Box>
      {on && (
        <Box data-testid={`railguard-${path}`} aria-hidden
          onPointerDown={(e) => { if (e.button === 0) reportBlocked(path, "control"); }}
          sx={{ position: "absolute", inset: 0, zIndex: 2, cursor: "default" }} />
      )}
    </Box>
  );
}

/** Wraps one disabled-while-read-only button (MUI's disabled buttons take no pointer events): a click
 *  on it is reported as an edit attempt. The wrapper is there with or without `on` (no layout change). */
export function BlockedClick({ on, path, action, children, sx }: {
  on: boolean; path: EditPath; action: string; children: ReactNode; sx?: SxProps<Theme>;
}) {
  return (
    <Box component="span" data-blocked-click={action}
      sx={[{ display: "inline-flex", minWidth: 0 }, ...(Array.isArray(sx) ? sx : sx ? [sx] : [])]}
      onPointerDown={on ? (e) => { if (e.button === 0) reportBlocked(path, action); } : undefined}>
      {children}
    </Box>
  );
}
