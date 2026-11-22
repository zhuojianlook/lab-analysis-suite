import { useEffect, useState, type ReactNode } from "react";
import { Alert, Box, Snackbar } from "@mui/material";
import BiotechIcon from "@mui/icons-material/Biotech";
import TimelineIcon from "@mui/icons-material/Timeline";
import ScatterPlotIcon from "@mui/icons-material/ScatterPlot";
import BubbleChartIcon from "@mui/icons-material/BubbleChart";
import BlurOnIcon from "@mui/icons-material/BlurOn";
import GrainIcon from "@mui/icons-material/Grain";
import GridOnIcon from "@mui/icons-material/GridOn";
import BarChartIcon from "@mui/icons-material/BarChart";
import CollectionsIcon from "@mui/icons-material/Collections";
import type { SvgIconComponent } from "@mui/icons-material";
import { probeEngine, getSidecarError } from "../../api/client";
import { engineStatusLine, nextPollDelayMs, wasRestarted } from "../../api/engineHealth";
import { useEngineStore } from "../../store/engineStore";
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
import { GraphView } from "../graph/GraphView";
import { FiguresView } from "../figures/FiguresView";
import { useFileSession } from "../graph/file/session";
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
  { id: "graph", label: "Graphs", group: "Tools", icon: BarChartIcon, render: () => <RPackageGate tab="graph"><GraphView /></RPackageGate> },
  { id: "platemap", label: "Plate Mapper", group: "Tools", icon: GridOnIcon, render: () => <PlatemapView /> },
  { id: "figures", label: "Figures", group: "Tools", icon: CollectionsIcon, render: () => <FiguresView /> },
];

const PREF_TOOL = "las.activeTool";
const PREF_COLLAPSED = "las.navCollapsed";

// localStorage can be unavailable (private mode, blocked storage) — UI prefs are best-effort.
const readPref = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const writePref = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

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
  const health = useEngineStore((s) => s.health);
  const notOkSince = useEngineStore((s) => s.notOkSince);
  const [engineErr, setEngineErr] = useState("");
  // Re-render now and then while the engine is not ok, so "starting" turns
  // into "down" after the grace period even if nothing else changes.
  const [, setTick] = useState(0);
  // Shown once after the app restarted a dead engine: what was loaded into
  // open analyses lived in the old engine (in-memory sessions, jobs).
  const [restartNotice, setRestartNotice] = useState(false);
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

  // The files controller asks for the Graphs tool (a file opened from Finder, the
  // File menu) and for the About window (the app menu's About item).
  const focusSerial = useFileSession((s) => s.focusSerial);
  const aboutSerial = useFileSession((s) => s.aboutSerial);
  useEffect(() => {
    if (focusSerial > 0) select("graph");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSerial]);
  useEffect(() => {
    if (aboutSerial > 0) setAboutOpen(true);
  }, [aboutSerial]);

  // ⌘/Ctrl + 1…9 jumps to a tool (Graphs = 7, Plate Mapper = 8, Figures = 9).
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

  // Watch the engine for as long as the app runs: fast while it is starting,
  // restarting or down, every 10 s once it is up (so the indicators turn red
  // when it goes away, and come back when the app has restarted it). A
  // first start of the engine can take 30-90 s, so "starting" is shown as
  // "down" only after START_GRACE_MS. The state comes from Rust, which checks
  // the engine's per-launch token: another program answering on the port is
  // never shown as ready.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let again = false;
    const { setHealth, setPoller } = useEngineStore.getState();
    let lastOkGeneration: number | undefined;
    const poll = async () => {
      if (cancelled) return;
      if (inFlight) {
        again = true;
        return;
      }
      inFlight = true;
      clearTimeout(timer);
      const h = await probeEngine();
      inFlight = false;
      if (cancelled) return;
      if (setHealth(h)) {
        // Up (again): the R probe and anything cached from a dead engine are stale.
        setEngineErr("");
        recheckR();
        if (wasRestarted(lastOkGeneration, h)) setRestartNotice(true);
        lastOkGeneration = h.generation;
      } else if (h.state === "ok") {
        // The R probe after the last recovery failed (e.g. the engine died
        // again in between): try again rather than keep a stale answer.
        const r = useRStore.getState();
        if (r.failed && !r.checking) void recheckR();
      }
      if (h.state !== "ok") {
        const se = await getSidecarError();
        if (!cancelled) setEngineErr(se);
      }
      setTick((t) => t + 1);
      const since = useEngineStore.getState().notOkSince;
      const delay = again ? 0 : nextPollDelayMs(h.state, since == null ? 0 : Date.now() - since);
      again = false;
      timer = setTimeout(poll, delay);
    };
    setPoller(() => void poll());
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      setPoller(() => {});
    };
  }, [recheckR]);

  const engineOk = health.state === "ok";
  const statuses: NavStatus[] = [
    engineStatusLine(health, notOkSince == null ? 0 : Date.now() - notOkSince, engineErr),
    !engineOk
      ? { label: "R: waiting for engine", tone: "pending" }
      : !rState
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
      <Snackbar
        open={restartNotice}
        onClose={(_e, reason) => {
          if (reason !== "clickaway") setRestartNotice(false);
        }}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert severity="info" onClose={() => setRestartNotice(false)} sx={{ maxWidth: 560 }}>
          The analysis engine stopped and was restarted. Data loaded into an open analysis (uploads, running jobs) may
          need to be loaded again.
        </Alert>
      </Snackbar>
    </Box>
  );
}
