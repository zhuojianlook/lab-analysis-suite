import { useEffect, useState } from "react";
import { AppBar, Box, Chip, IconButton, Tab, Tabs, Toolbar, Tooltip, Typography } from "@mui/material";
import ScienceIcon from "@mui/icons-material/Science";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import { checkHealth, lastHealthError, getSidecarError } from "../../api/client";
import { useRStore } from "../../store/rStore";
import { AboutDialog } from "../shared/AboutDialog";
import { RStatusBanner } from "../shared/RStatusBanner";
import { RPackageGate } from "../shared/RPackageGate";
import { QpcrView } from "../qpcr/QpcrView";
import { XcelligenceView } from "../xcelligence/XcelligenceView";
import { RnaseqView } from "../rnaseq/RnaseqView";
import { ScrnaView } from "../scrna/ScrnaView";
import { SpatialView } from "../spatial/SpatialView";
import { MicrobiomeView } from "../microbiome/MicrobiomeView";
import { PlatemapView } from "../platemap/PlatemapView";

const TABS = [
  { label: "qPCR", render: () => <RPackageGate tab="qpcr"><QpcrView /></RPackageGate> },
  { label: "xCELLigence", render: () => <RPackageGate tab="xcelligence"><XcelligenceView /></RPackageGate> },
  { label: "Bulk RNA-seq", render: () => <RPackageGate tab="rnaseq"><RnaseqView /></RPackageGate> },
  { label: "scRNA-seq", render: () => <RPackageGate tab="scrnaseq"><ScrnaView /></RPackageGate> },
  { label: "Spatial", render: () => <RPackageGate tab="spatial"><SpatialView /></RPackageGate> },
  { label: "16S rRNA", render: () => <RPackageGate tab="microbiome"><MicrobiomeView /></RPackageGate> },
  { label: "Plate Mapper", render: () => <PlatemapView /> },
] as const;

type Status = "checking" | "ok" | "down";

export function AppShell() {
  const [tab, setTab] = useState(0);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [health, setHealth] = useState<Status>("checking");
  const [engineErr, setEngineErr] = useState("");
  const rState = useRStore((s) => s.state);
  const recheckR = useRStore((s) => s.recheck);

  // Poll sidecar health until it comes up. The PyInstaller --onefile sidecar
  // (pandas/scipy/statsmodels) extracts + imports on FIRST launch, which can
  // take 30-90s on macOS — so poll fast for ~2 min, then keep slow-retrying so
  // a late start still recovers. If it never comes up, surface the sidecar's
  // captured stderr (the real reason) instead of a generic request error.
  useEffect(() => {
    let cancelled = false;
    let tries = 0;
    const poll = async () => {
      const ok = await checkHealth();
      if (cancelled) return;
      if (ok) {
        setHealth("ok");
        setEngineErr("");
        recheckR();
        return;
      }
      tries += 1;
      if (tries < 120) {
        setHealth("checking");
        setTimeout(poll, 1000);
      } else {
        setHealth("down");
        if (!engineErr) {
          const se = await getSidecarError();
          if (!cancelled && se) setEngineErr(se);
        }
        setTimeout(poll, 5000);
      }
    };
    poll();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recheckR]);

  const healthChip = {
    checking: <Chip size="small" color="default" label="Engine: starting…" />,
    ok: <Chip size="small" color="success" label="Engine: ready" />,
    down: (
      <Tooltip title={engineErr || lastHealthError || "Sidecar not reachable"}>
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
          <Tooltip title="About & updates">
            <IconButton size="small" onClick={() => setAboutOpen(true)} sx={{ color: "text.secondary" }}>
              <InfoOutlinedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          {rChip}
          {healthChip}
        </Toolbar>
        <Tabs
          value={tab}
          onChange={(_, v) => setTab(v)}
          variant="scrollable"
          scrollButtons="auto"
          sx={{ minHeight: 40, borderTop: "1px solid", borderColor: "divider" }}
        >
          {TABS.map((t) => (
            <Tab key={t.label} label={t.label} sx={{ minHeight: 40, textTransform: "none" }} />
          ))}
        </Tabs>
      </AppBar>
      <RStatusBanner />
      <Box sx={{ flexGrow: 1, overflow: "auto", bgcolor: "background.default" }}>{TABS[tab].render()}</Box>
      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
    </Box>
  );
}
