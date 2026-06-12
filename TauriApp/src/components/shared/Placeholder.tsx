import { Box, Typography } from "@mui/material";

/** Simple centered placeholder used by tabs that are not yet implemented. */
export function Placeholder({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <Box
      sx={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 1,
        color: "text.secondary",
        px: 4,
        textAlign: "center",
      }}
    >
      <Typography variant="h6" sx={{ color: "text.primary" }}>
        {title}
      </Typography>
      {subtitle && <Typography variant="body2">{subtitle}</Typography>}
    </Box>
  );
}
