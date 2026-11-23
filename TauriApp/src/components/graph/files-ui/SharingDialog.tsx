import { useState } from "react";
import {
  Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, Radio, RadioGroup, Stack, Typography,
} from "@mui/material";
import { useFileSession } from "../file/session";
import type { ShareMode, SharingView } from "../file/contract";
import { SHARE_LABEL, SHARE_SHORT, T, sharingStatusText } from "./text";

type Choice = ShareMode | "default";

/** "Show others when I'm editing this file" (phase 3 contract §6.5): this file's own choice, applied at once.
 *  Esc / backdrop = Close. */
export function SharingDialog({ tabKey, title, sharing }: { tabKey: string; title: string; sharing: SharingView }) {
  const [busy, setBusy] = useState(false);
  const value: Choice = sharing.choice ?? "default";
  const close = () => useFileSession.getState().closeDialog();
  const pick = async (c: Choice) => {
    if (c === value) return;
    setBusy(true);
    try { await useFileSession.getState().setSharing(tabKey, c === "default" ? null : c); } finally { setBusy(false); }
  };
  const options: { c: Choice; label: string }[] = [
    { c: "default", label: T.sharingDefault(SHARE_SHORT[sharing.fallback]) },
    { c: "auto", label: SHARE_LABEL.auto },
    { c: "always", label: SHARE_LABEL.always },
    { c: "never", label: SHARE_LABEL.never },
  ];
  return (
    <Dialog open onClose={close} maxWidth="xs" fullWidth slotProps={{ paper: { "data-testid": "sharing-dialog" } as object }}>
      <DialogTitle sx={{ pb: 0.25 }}>{T.sharingTitle}</DialogTitle>
      <DialogContent>
        <Typography variant="caption" color="text.secondary" component="div" noWrap title={title} sx={{ mb: 1 }}>{title}</Typography>
        <RadioGroup value={value} onChange={(e) => void pick(e.target.value as Choice)}>
          {options.map((o) => (
            <FormControlLabel key={o.c} value={o.c} disabled={busy} data-testid={`sharing-${o.c}`} data-checked={value === o.c ? "true" : "false"}
              control={<Radio size="small" sx={{ py: 0.5 }} />}
              label={<Typography variant="body2">{o.label}</Typography>} />
          ))}
        </RadioGroup>
        <Stack direction="row" spacing={1} alignItems="flex-start" sx={{ mt: 1.25, p: 1, borderRadius: 1, bgcolor: "action.hover" }}>
          <Box sx={{ width: 8, height: 8, borderRadius: "50%", mt: 0.6, flexShrink: 0, bgcolor: sharing.on ? "success.main" : "text.disabled" }} />
          <Typography variant="body2" data-testid="sharing-status" data-on={sharing.on ? "true" : "false"}>{sharingStatusText(sharing)}</Typography>
        </Stack>
        <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1.25, mb: 0 }}>{T.sharingHelp}</Typography>
      </DialogContent>
      <DialogActions>
        <Button variant="contained" data-testid="sharing-close" autoFocus onClick={close}>{T.sharingClose}</Button>
      </DialogActions>
    </Dialog>
  );
}
