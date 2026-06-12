import { useEffect, useState } from "react";
import { AppBar, Box, Chip, Tab, Tabs, Toolbar, Tooltip, Typography } from "@mui/material";
import ScienceIcon from "@mui/icons-material/Science";
import { checkHealth, lastHealthError } from "../../api/client";
import { useRStore } from "../../store/rStore";
import { RStatusBanner } from "../shared/RStatusBanner";
import { RPackageGate } from "../shared/RPackageGate";
import { QpcrView } from "../qpcr/QpcrView";
import { XcelligenceView } from "../xcelligence/XcelligenceView";
import { RnaseqView } from "../rnaseq/RnaseqView";
import { PlatemapView } from "../platemap/PlatemapView";

const TABS = [
  { label: "qPCR", render: () => <RPackageGate tab="qpcr"><QpcrView /></RPackageGate> },
  { label: "xCELLigence", render: () => <RPackageGate tab="xcelligence"><XcelligenceView /></RPackageGate> },
  { label: "Bulk RNA-seq", render: () => <RPackageGate tab="rnaseq"><RnaseqView /></RPackageGate> },
  { label: "Plate Mapper", render: () => <PlatemapView /> },
] as const;

type Status = "checking" | "ok" | "down";

export function AppShell() {
  const [tab, setTab] = useState(0);
  const [health, setHealth] = useState<Status>("checking");
  const rState = useRStore((s) => s.state);
  const recheckR = useRStore((s) => s.recheck);

  // Poll sidecar health until it comes up (PyInstaller cold start can take a
  // few seconds), then probe R once.
  useEffect(() => {
    let cancelled = false;
    let tries = 0;
    const poll = async () => {
      const ok = await checkHealth();
      if (cancelled) return;
      if (ok) {
        setHealth("ok");
        recheckR();
        return;
      }
      if (++tries > 30) {
        setHealth("down");
        return;
      }
      setTimeout(poll, 1000);
    };
    poll();
    return () => {
      cancelled = true;
    };
  }, [recheckR]);

  const healthChip = {
    checking: <Chip size="small" color="default" label="Engine: starting…" />,
    ok: <Chip size="small" color="success" label="Engine: ready" />,
    down: (
      <Tooltip title={lastHealthError || "Sidecar not reachable"}>
        <Chip size="small" color="error" label="Engine: down" />
      </Tooltip>
    ),
  }[health];

  const rChip = !rState ? (
    <Chip size="small" variant="outlined" label="R: checking…" />
  ) : rState.installed ? (
    <Tooltip title={`${rState.version}${rState.bundled ? " (portable)" : ""}`}>
      <Chip size="small" color="success" variant="outlined" label="R: ready" />
    </Tooltip>
  ) : (
    <Tooltip title="R not found — install it or set a custom Rscript path">
      <Chip size="small" color="warning" variant="outlined" label="R: not found" />
    </Tooltip>
  );

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
      <RStatusBanner />
      <Box sx={{ flexGrow: 1, overflow: "auto", bgcolor: "background.default" }}>{TABS[tab].render()}</Box>
    </Box>
  );
}
