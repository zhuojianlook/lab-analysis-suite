import { useState } from "react";
import { Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField, Typography } from "@mui/material";
import { useFileSession } from "../file/session";
import { T } from "./text";

/** Your name and this computer's name: written into every version saved here. */
export function SettingsDialog() {
  const settings = useFileSession((s) => s.settings);
  const [user, setUser] = useState(settings?.userName ?? "");
  const [device, setDevice] = useState(settings?.deviceName ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const close = () => useFileSession.getState().closeDialog();
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await useFileSession.getState().setSettings({ userName: user.trim(), deviceName: device.trim() });
    } catch {
      setErr("The settings couldn't be saved. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={close} maxWidth="xs" fullWidth slotProps={{ paper: { "data-testid": "settings-dialog" } as object }}>
      <DialogTitle>{T.settingsTitle}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <TextField label={T.settingsUser} value={user} onChange={(e) => setUser(e.target.value)} helperText={T.settingsUserHelp}
            autoFocus fullWidth slotProps={{ htmlInput: { maxLength: 60, "data-testid": "settings-user" } }} />
          <TextField label={T.settingsDevice} value={device} onChange={(e) => setDevice(e.target.value)} helperText={T.settingsDeviceHelp}
            fullWidth slotProps={{ htmlInput: { maxLength: 60, "data-testid": "settings-device" } }}
            onKeyDown={(e) => { if (e.key === "Enter") void save(); }} />
          {err && <Typography variant="caption" color="error">{err}</Typography>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button color="inherit" onClick={close} data-testid="settings-cancel">Cancel</Button>
        <Button variant="contained" disabled={busy} onClick={() => void save()} data-testid="settings-save">Save</Button>
      </DialogActions>
    </Dialog>
  );
}
