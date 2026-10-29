import { Box } from "@mui/material";
import type { KeyboardEvent, ReactNode } from "react";

/** Desktop two-pane workspace: a fixed-width control rail (own scroll, with an
 *  optional sticky footer for the primary action) beside a flexible output
 *  canvas. Each pane scrolls independently so the output stays in view while
 *  the controls are adjusted. Collapses to one scrolling column when narrow. */
export function Workspace({
  rail,
  railFooter,
  children,
  railWidth = 360,
  onKeyDown,
}: {
  rail: ReactNode;
  railFooter?: ReactNode;
  children: ReactNode;
  railWidth?: number;
  onKeyDown?: (e: KeyboardEvent) => void;
}) {
  return (
    <Box
      onKeyDown={onKeyDown}
      sx={{
        height: "100%",
        minHeight: 0,
        display: "flex",
        flexDirection: { xs: "column", md: "row" },
        overflow: { xs: "auto", md: "hidden" },
      }}
    >
      <Box
        component="aside"
        sx={{
          width: { md: railWidth },
          flexShrink: 0,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          bgcolor: "background.paper",
          borderRight: { xs: 0, md: 1 },
          borderBottom: { xs: 1, md: 0 },
          borderColor: "divider",
        }}
      >
        <Box sx={{ flexGrow: 1, minHeight: 0, overflow: { md: "auto" } }}>{rail}</Box>
        {railFooter && (
          <Box sx={{ p: 1.5, borderTop: 1, borderColor: "divider", bgcolor: "background.paper" }}>
            {railFooter}
          </Box>
        )}
      </Box>
      <Box
        component="main"
        sx={{
          flexGrow: 1,
          minWidth: 0,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          overflow: { md: "auto" },
        }}
      >
        {children}
      </Box>
    </Box>
  );
}
