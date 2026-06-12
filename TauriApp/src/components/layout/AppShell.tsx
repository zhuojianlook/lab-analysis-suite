import { useEffect, useState } from "react";
import {
  AppBar,
  Box,
  Chip,
  Tab,
  Tabs,
  Toolbar,
  Tooltip,
  Typography,
} from "@mui/material";
import ScienceIcon from "@mui/icons-material/Science";
import { checkHealth, checkR, lastHealthError } from "../../api/client";
import { QpcrView } from "../qpcr/QpcrView";
import { XcelligenceView } from "../xcelligence/XcelligenceView";
import { RnaseqView } from "../rnaseq/RnaseqView";
import { PlatemapView } from "../platemap/PlatemapView";

const TABS = [
  { label: "qPCR", render: () => <QpcrView /> },
  { label: "xCELLigence", render: () => <XcelligenceView /> },
  { label: "Bulk RNA-seq", render: () => <RnaseqView /> },
  { label: "Plate Mapper", render: () => <PlatemapView /> },
] as const;

type Status = "checking" | "ok" | "down";

export function AppShell() {
  const [tab, setTab] = useState(0);
  const [health, setHealth] = useState<Status>("checking");
  const [rStatus, setRStatus] = useState<Status>("checking");
  const [rVersion, setRVersion] = useState<string>("");

  // Poll sidecar health until it comes up (PyInstaller cold start can take
  // a few seconds), then probe R once.
  useEffect(() => {
    let cancelled = false;
    let tries = 0;
    const poll = async () => {
      const ok = await checkHealth();
      if (cancelled) return;
      if (ok) {
        setHealth("ok");
        try {
          const r = await checkR();
          if (!cancelled) {
            setRStatus(r.installed ? "ok" : "down");
            setRVersion(r.version || "");
          }
        } catch {
          if (!cancelled) setRStatus("down");
        }
        return;
      }
      tries += 1;
      if (tries > 30) {
        setHealth("down");
        return;
      }
      setTimeout(poll, 1000);
    };
    poll();
    return () => {
      cancelled = true;
    };
  }, []);

  const healthChip = {
    checking: <Chip size="small" color="default" label="Engine: starting…" />,
    ok: <Chip size="small" color="success" label="Engine: ready" />,
    down: (
      <Tooltip title={lastHealthError || "Sidecar not reachable"}>
        <Chip size="small" color="error" label="Engine: down" />
      </Tooltip>
    ),
  }[health];

  const rChip = {
    checking: <Chip size="small" variant="outlined" label="R: checking…" />,
    ok: (
      <Tooltip title={rVersion}>
        <Chip size="small" color="success" variant="outlined" label="R: ready" />
      </Tooltip>
    ),
    down: (
      <Tooltip title="Bundled R not found (dev: install R or build the r-env)">
        <Chip size="small" color="warning" variant="outlined" label="R: unavailable" />
      </Tooltip>
    ),
  }[rStatus];

  return (
    <Box sx={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <AppBar position="static" elevation={0} sx={{ bgcolor: "background.paper" }}>
        <Toolbar variant="dense" sx={{ gap: 1.5 }}>
          <ScienceIcon fontSize="small" sx={{ color: "primary.main" }} />
          <Typography variant="subtitle1" sx={{ fontWeight: 600, mr: 2 }}>
            Lab Analysis Suite
          </Typography>
          <Box sx={{ flexGrow: 1 }} />
          {rChip}
          {healthChip}
        </Toolbar>
        <Tabs
          value={tab}
          onChange={(_, v) => setTab(v)}
          variant="fullWidth"
          sx={{ minHeight: 40, borderTop: "1px solid", borderColor: "divider" }}
        >
          {TABS.map((t) => (
            <Tab key={t.label} label={t.label} sx={{ minHeight: 40, textTransform: "none" }} />
          ))}
        </Tabs>
      </AppBar>
      <Box sx={{ flexGrow: 1, overflow: "auto", bgcolor: "background.default" }}>
        {TABS[tab].render()}
      </Box>
    </Box>
  );
}
