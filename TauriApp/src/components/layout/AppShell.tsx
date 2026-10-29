import { useEffect, useState, type ReactNode } from "react";
import { Box } from "@mui/material";
import BiotechIcon from "@mui/icons-material/Biotech";
import TimelineIcon from "@mui/icons-material/Timeline";
import ScatterPlotIcon from "@mui/icons-material/ScatterPlot";
import BubbleChartIcon from "@mui/icons-material/BubbleChart";
import BlurOnIcon from "@mui/icons-material/BlurOn";
import GrainIcon from "@mui/icons-material/Grain";
import GridOnIcon from "@mui/icons-material/GridOn";
import CollectionsIcon from "@mui/icons-material/Collections";
import type { SvgIconComponent } from "@mui/icons-material";
import { checkHealth, lastHealthError, getSidecarError } from "../../api/client";
import { useRStore } from "../../store/rStore";
import { useFiguresStore } from "../../store/figuresStore";
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
import { FiguresView } from "../figures/FiguresView";
import { NavSidebar, type NavStatus } from "./NavSidebar";

interface Tool {
  id: string;
  label: string;
  group: string;
  icon: SvgIconComponent;
  render: () => ReactNode;
}

const TOOLS: Tool[] = [
  { id: "qpcr", label: "qPCR", group: "Assays", icon: BiotechIcon, render: () => <RPackageGate tab="qpcr"><QpcrView /></RPackageGate> },
  { id: "xcelligence", label: "xCELLigence", group: "Assays", icon: TimelineIcon, render: () => <RPackageGate tab="xcelligence"><XcelligenceView /></RPackageGate> },
  { id: "rnaseq", label: "Bulk RNA-seq", group: "Sequencing", icon: ScatterPlotIcon, render: () => <RPackageGate tab="rnaseq"><RnaseqView /></RPackageGate> },
  { id: "scrnaseq", label: "scRNA-seq", group: "Sequencing", icon: BubbleChartIcon, render: () => <RPackageGate tab="scrnaseq"><ScrnaView /></RPackageGate> },
  { id: "spatial", label: "Spatial", group: "Sequencing", icon: BlurOnIcon, render: () => <RPackageGate tab="spatial"><SpatialView /></RPackageGate> },
  { id: "microbiome", label: "16S rRNA", group: "Sequencing", icon: GrainIcon, render: () => <RPackageGate tab="microbiome"><MicrobiomeView /></RPackageGate> },
  { id: "platemap", label: "Plate Mapper", group: "Tools", icon: GridOnIcon, render: () => <PlatemapView /> },
  { id: "figures", label: "Figures", group: "Tools", icon: CollectionsIcon, render: () => <FiguresView /> },
];

const PREF_TOOL = "las.activeTool";
const PREF_COLLAPSED = "las.navCollapsed";

// localStorage can be unavailable (private mode, blocked storage) — UI prefs are best-effort.
const readPref = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const writePref = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

type Health = "checking" | "ok" | "down";

export function AppShell() {
  const [active, setActive] = useState<string>(() => {
    const saved = readPref(PREF_TOOL);
    return TOOLS.some((t) => t.id === saved) ? saved! : TOOLS[0].id;
  });
  // Tools mount on first visit and then stay mounted (hidden), so switching
  // keeps each tool's data, results, running jobs and scroll position.
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set([active]));
  // Default to the icon rail on narrower windows so the workspaces keep their room.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    const saved = readPref(PREF_COLLAPSED);
    return saved === null ? window.innerWidth < 1440 : saved === "1";
  });
  const [aboutOpen, setAboutOpen] = useState(false);
  const [health, setHealth] = useState<Health>("checking");
  const [engineErr, setEngineErr] = useState("");
  const rState = useRStore((s) => s.state);
  const recheckR = useRStore((s) => s.recheck);
  const figureCount = useFiguresStore((s) => s.figures.length);

  const select = (id: string) => {
    setActive(id);
    setVisited((s) => (s.has(id) ? s : new Set(s).add(id)));
    writePref(PREF_TOOL, id);
  };

  const toggleCollapsed = () => {
    setCollapsed((c) => { writePref(PREF_COLLAPSED, c ? "0" : "1"); return !c; });
  };

  // ⌘/Ctrl + 1…8 jumps to a tool.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || !/^[1-9]$/.test(e.key)) return;
      const tool = TOOLS[Number(e.key) - 1];
      if (!tool) return;
      e.preventDefault();
      select(tool.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const statuses: NavStatus[] = [
    {
      checking: { label: "Engine starting…", tone: "pending" as const },
      ok: { label: "Engine ready", tone: "ok" as const },
      down: { label: "Engine down", tone: "error" as const, detail: engineErr || lastHealthError || "Sidecar not reachable" },
    }[health],
    !rState
      ? { label: "R: checking…", tone: "pending" }
      : rState.installed
        ? { label: "R ready", tone: "ok", detail: `${rState.version}${rState.bundled ? " (portable)" : ""}` }
        : { label: "R not found", tone: "warn", detail: "Install R or set a custom Rscript path" },
  ];

  return (
    <Box sx={{ height: "100vh", display: "flex" }}>
      <NavSidebar
        items={TOOLS.map((t) => ({ ...t, badge: t.id === "figures" ? figureCount : undefined }))}
        active={active}
        onSelect={select}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        statuses={statuses}
        onAbout={() => setAboutOpen(true)}
      />
      <Box sx={{ flexGrow: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <RStatusBanner />
        <Box sx={{ flexGrow: 1, minHeight: 0, position: "relative", bgcolor: "background.default" }}>
          {TOOLS.map((t) =>
            visited.has(t.id) ? (
              <Box
                key={t.id}
                role="region"
                aria-label={t.label}
                hidden={active !== t.id}
                sx={{ position: "absolute", inset: 0, overflow: "auto", display: active === t.id ? "block" : "none" }}
              >
                {t.render()}
              </Box>
            ) : null,
          )}
        </Box>
      </Box>
      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
    </Box>
  );
}
