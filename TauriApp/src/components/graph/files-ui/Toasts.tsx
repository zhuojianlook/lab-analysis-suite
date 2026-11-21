import { useEffect } from "react";
import { Alert, Box, Stack } from "@mui/material";
import { useFileSession } from "../file/session";
import type { SessionToast } from "../file/contract";
import { toastText } from "./text";

function Toast({ t }: { t: SessionToast }) {
  const settings = useFileSession((s) => s.settings);
  useEffect(() => {
    const h = setTimeout(() => useFileSession.getState().dismissToast(t.id), t.tone === "error" ? 8000 : 5000);
    return () => clearTimeout(h);
  }, [t.id, t.tone]);
  return (
    <Alert severity={t.tone} variant="filled" data-testid="toast" data-kind={t.kind}
      onClose={() => useFileSession.getState().dismissToast(t.id)}
      sx={{ boxShadow: 6, minWidth: 260, maxWidth: 520, py: 0.25, alignItems: "center" }}>
      {toastText(t, settings)}
    </Alert>
  );
}

/** Short notes from the files controller (contract §5.5 "Toasts"), bottom centre. */
export function Toasts() {
  const toasts = useFileSession((s) => s.toasts);
  if (!toasts.length) return null;
  return (
    <Box sx={{ position: "fixed", bottom: 16, left: "50%", transform: "translateX(-50%)", zIndex: 1450, pointerEvents: "none" }}>
      <Stack spacing={1} alignItems="center" sx={{ "& > *": { pointerEvents: "auto" } }} data-testid="toasts">
        {toasts.map((t) => <Toast key={t.id} t={t} />)}
      </Stack>
    </Box>
  );
}
