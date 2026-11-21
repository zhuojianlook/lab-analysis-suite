import { useCallback, useEffect, useState } from "react";
import { Alert, Box, Button, Chip, CircularProgress, Paper, Stack, TextField, Typography } from "@mui/material";
import BarChartIcon from "@mui/icons-material/BarChart";
import StackedBarChartIcon from "@mui/icons-material/StackedBarChart";
import ShowChartIcon from "@mui/icons-material/ShowChart";
import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import RefreshIcon from "@mui/icons-material/Refresh";
import type { SvgIconComponent } from "@mui/icons-material";
import { getGraphLibrary, isGraphError, type GraphLibraryList, type GraphSummary, type Template } from "../../api/graph";
import { TEMPLATES } from "./graphModel";
import { useFileSession } from "./file/session";
import { FileMenu } from "./files-ui/FileMenu";
import { RecentFiles } from "./files-ui/RecentFiles";
import { T, shortcutText } from "./files-ui/text";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const MOD_KEY = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform) ? "⌘" : "Ctrl";

const TEMPLATE_ICON: Record<Template, SvgIconComponent> = { column: BarChartIcon, grouped: StackedBarChartIcon, xy: ShowChartIcon };
const TEMPLATE_LABEL: Record<Template, string> = { column: "Column", grouped: "Grouped", xy: "XY" };

/** Library timestamps: epoch seconds/ms or ISO text (no zone = local time). */
export function formatWhen(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "";
  const ms = typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : Date.parse(String(v).replace(" ", "T"));
  if (!Number.isFinite(ms)) return String(v);
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? `Today ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
    : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

// ── the old in-app library (read-only backup since analyses are files) ──────

export interface GraphLib {
  analyses: GraphSummary[] | null;
  path: string;
  error: string | null;
  refresh: () => Promise<void>;
  adopt: (l: GraphLibraryList) => void;
}

/** The old library's list, read from the engine. Nothing here changes the library. */
export function useGraphLibrary(): GraphLib {
  const [analyses, setAnalyses] = useState<GraphSummary[] | null>(null);
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);

  const adopt = useCallback((l: GraphLibraryList) => {
    if (Array.isArray(l.analyses)) setAnalyses(l.analyses);
    if (typeof l.path === "string") setPath(l.path);
    setError(null);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await getGraphLibrary();
      if (isGraphError(res)) { setError(res.error); return; }
      adopt(res);
    } catch (e) {
      setError(`Couldn't open the old library: ${errMsg(e)}`);
    }
  }, [adopt]);

  useEffect(() => { void refresh(); }, [refresh]);

  return { analyses, path, error, refresh, adopt };
}

function LibraryRow({ item, onOpen }: { item: GraphSummary; onOpen: (id: number) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const Icon = TEMPLATE_ICON[item.template] ?? BarChartIcon;
  const open = async () => {
    setBusy(true);
    try { await onOpen(item.id); } finally { setBusy(false); }
  };
  return (
    <Box data-testid="old-library-item" sx={{ px: 1.25, py: 0.75, borderRadius: 1, "&:hover": { bgcolor: "action.hover" } }}>
      <Stack direction="row" spacing={1.25} alignItems="center">
        <Icon sx={{ fontSize: 20, color: "text.secondary", flexShrink: 0 }} />
        <Box sx={{ minWidth: 0, flexGrow: 1 }}>
          <Stack direction="row" spacing={0.75} alignItems="center">
            <Typography variant="body2" noWrap sx={{ fontWeight: 500 }}>{item.name}</Typography>
            <Chip size="small" variant="outlined" label={TEMPLATE_LABEL[item.template] ?? item.template} sx={{ height: 18, fontSize: 10.5 }} />
          </Stack>
          <Typography variant="caption" color="text.secondary" noWrap component="div">
            {item.n_cols} {item.template === "xy" ? "data set" : "group"}{item.n_cols === 1 ? "" : "s"} · {item.n_rows} row{item.n_rows === 1 ? "" : "s"}
            {item.updated_at ? ` · edited ${formatWhen(item.updated_at)}` : ""}
          </Typography>
        </Box>
        {busy && <CircularProgress size={14} />}
        <Button size="small" variant="outlined" disabled={busy} onClick={() => void open()} data-testid="old-library-open">{T.openACopy}</Button>
      </Stack>
    </Box>
  );
}

/** The old library, read-only: each row can be opened as a copy (a new, unsaved analysis). */
export function LibraryList({ lib, onOpen }: { lib: GraphLib; onOpen: (id: number) => Promise<void> }) {
  const [filter, setFilter] = useState("");
  const items = lib.analyses ?? [];
  const q = items.length > 8 ? filter.trim().toLowerCase() : "";
  const shown = q ? items.filter((a) => a.name.toLowerCase().includes(q)) : items;

  if (lib.analyses === null) {
    return lib.error ? (
      <Alert severity="error" action={<Button color="inherit" size="small" startIcon={<RefreshIcon />} onClick={() => void lib.refresh()}>Retry</Button>}>
        {lib.error}
      </Alert>
    ) : (
      <Stack direction="row" spacing={1} alignItems="center" sx={{ py: 1 }}>
        <CircularProgress size={14} />
        <Typography variant="body2" color="text.secondary">Opening the old library…</Typography>
      </Stack>
    );
  }
  return (
    <Box>
      {items.length > 8 && (
        <TextField size="small" fullWidth placeholder="Filter analyses" value={filter} onChange={(e) => setFilter(e.target.value)} sx={{ mb: 1 }} />
      )}
      {!items.length && <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>The old library is empty.</Typography>}
      {q && !shown.length && <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>No analyses match “{filter.trim()}”.</Typography>}
      <Stack spacing={0.25}>
        {shown.map((a) => <LibraryRow key={a.id} item={a} onOpen={onOpen} />)}
      </Stack>
      {lib.error && <Alert severity="error" sx={{ mt: 1 }}>{lib.error}</Alert>}
      {lib.path && (
        <Typography variant="caption" color="text.disabled" component="div" sx={{ mt: 1.5, wordBreak: "break-all" }}>
          Library file: {lib.path}
        </Typography>
      )}
    </Box>
  );
}

// ── start screen ────────────────────────────────────────────────────────────

/** Shown when no tab is active: pick a template, open a file, or reopen a recent one. */
export function StartScreen() {
  const oldLibrary = useFileSession((s) => s.oldLibrary);
  const st = useFileSession.getState;
  const linkSx = { p: 0, minWidth: 0, verticalAlign: "baseline", fontSize: "inherit", fontWeight: 600 } as const;

  return (
    <Box sx={{ height: "100%", overflow: "auto" }} data-testid="start-screen">
      <Box sx={{ maxWidth: 980, mx: "auto", px: 3, py: 4 }}>
        <Typography variant="h5" sx={{ fontWeight: 600 }}>Graphs</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 3, maxWidth: 680 }}>{T.startIntro}</Typography>

        <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "repeat(3, 1fr)" }, gap: 2 }}>
          {TEMPLATES.map((t) => {
            const Icon = TEMPLATE_ICON[t.id];
            return (
              <Paper key={t.id} variant="outlined" sx={{ p: 2, display: "flex", flexDirection: "column" }}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Icon sx={{ color: "primary.main" }} />
                  <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>{t.label}</Typography>
                </Stack>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1, flexGrow: 1 }}>{t.blurb}</Typography>
                <Typography variant="caption" color="text.disabled" sx={{ mt: 1 }}>
                  {t.graphs.map((g) => g.label).join(" · ")}
                </Typography>
                <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
                  <Button variant="contained" size="small" data-testid={`start-empty-${t.id}`} onClick={() => void st().newDoc(t.id, false)}>Start empty</Button>
                  <Button size="small" data-testid={`start-sample-${t.id}`} onClick={() => void st().newDoc(t.id, true)}>Start with sample data</Button>
                </Stack>
              </Paper>
            );
          })}
        </Box>

        <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 3 }}>
          <Button variant="outlined" startIcon={<FolderOpenIcon />} data-testid="start-open" onClick={() => void st().open()}
            title={shortcutText("o")}>
            Open…
          </Button>
          <FileMenu variant="outlined" />
        </Stack>

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 4, mb: 1 }}>{T.recentTitle}</Typography>
        <RecentFiles />

        {(oldLibrary?.total ?? 0) > 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 3 }}>
            {T.oldLibraryLinePrefix}{" "}
            <Button size="small" sx={linkSx} data-testid="start-old-library" onClick={() => st().openOldLibrary()}>Old library…</Button>
            {" · "}
            <Button size="small" sx={linkSx} data-testid="start-export" onClick={() => void st().openExport()}>Export library to files…</Button>
            {(oldLibrary?.unexported ?? 0) > 0 && ` (${oldLibrary!.unexported} not exported yet)`}
          </Typography>
        )}
      </Box>
    </Box>
  );
}
