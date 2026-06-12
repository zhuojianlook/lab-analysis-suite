import { useState } from "react";
import { Alert, Button, Stack } from "@mui/material";
import { useRStore } from "../../store/rStore";
import { openExternal, pickFile, setRscriptPath } from "../../api/client";

/** Top-of-window banner shown when R isn't found. Non-blocking: the user can
 *  still browse tabs and the Plate Mapper (which needs no R). */
export function RStatusBanner() {
  const state = useRStore((s) => s.state);
  const setState = useRStore((s) => s.setState);
  const [dismissed, setDismissed] = useState(false);

  if (!state || state.installed || dismissed) return null;

  const locate = async () => {
    const path = await pickFile("Select your Rscript executable");
    if (path) setState(await setRscriptPath(path));
  };

  return (
    <Alert
      severity="warning"
      onClose={() => setDismissed(true)}
      sx={{ borderRadius: 0 }}
      action={
        <Stack direction="row" spacing={1}>
          <Button color="inherit" size="small" onClick={() => openExternal("https://cran.r-project.org/")}>
            Get R
          </Button>
          <Button color="inherit" size="small" onClick={locate}>
            Locate Rscript…
          </Button>
        </Stack>
      }
    >
      R wasn't found. Tabs that plot or run statistics need R — install it, or point the app at an existing Rscript.
    </Alert>
  );
}
