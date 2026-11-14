import { useEffect, useMemo, useRef, useState } from "react";
import {
  Box, Button, Checkbox, Divider, FormControlLabel, IconButton, Stack, Tooltip, Typography,
} from "@mui/material";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import CheckIcon from "@mui/icons-material/Check";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import {
  getGraphSoftware, type AnalyzeResult, type GraphAnalysis, type GraphFigure, type GraphTable, type SoftwareVersions,
} from "../../api/graph";
import { buildFigureText, normalityApplies, type FigureText } from "./figureText";

/* Auto-generated figure legend + statistical methods beside the rendered
   figure. The text is a pure function of the document (figureText.ts), so it
   is read-only: it can never drift from the statistics or the figure. Users
   finish the wording in their manuscript after copying. */

// UI prefs are best-effort (localStorage can be unavailable).
const readPref = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const writePref = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };
export const PREF_TEXT_PANEL = "las.graph.textPanel";
const PREF_NORMALITY = "las.graph.textNormality";
export const readTextPanelOpen = () => readPref(PREF_TEXT_PANEL) !== "closed";
export const writeTextPanelOpen = (open: boolean) => writePref(PREF_TEXT_PANEL, open ? "open" : "closed");

// ── software versions (loaded once; retried on the next mount until R answers) ──
type Software = Partial<SoftwareVersions> | null;
let swPromise: Promise<Software> | null = null;
let swResolved: Software = null;

async function tauriAppVersion(): Promise<string | null> {
  try {
    const m = await import("@tauri-apps/api/app");
    const v = await m.getVersion();
    return typeof v === "string" && v ? v : null;
  } catch {
    return null; // browser preview: no Tauri runtime
  }
}

function loadSoftware(): Promise<Software> {
  if (!swPromise) {
    swPromise = Promise.all([getGraphSoftware().catch(() => null), tauriAppVersion()]).then(([sw, app]) => {
      // Without the engine's answer there is nothing honest to cite but the app.
      const v: Software = sw ? { ...sw, app: app || sw.app || null } : null;
      if (!sw || !sw.r || !sw.ggplot2) swPromise = null; // R may be installed / fixed while the app is open
      swResolved = v;
      return v;
    });
  }
  return swPromise;
}

function useSoftware(): Software {
  const [sw, setSw] = useState<Software>(swResolved);
  useEffect(() => {
    let cancelled = false;
    void loadSoftware().then((v) => { if (!cancelled) setSw(v); });
    return () => { cancelled = true; };
  }, []);
  return sw;
}

// ── clipboard ────────────────────────────────────────────────────────────────
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall back below */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

const srOnly = {
  position: "absolute", width: 1, height: 1, p: 0, m: "-1px", overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0,
} as const;

function CopyButton({ text, label = "Copy", what, disabled }: { text: string; label?: string; what: string; disabled?: boolean }) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const onClick = async () => {
    const ok = await copyText(text);
    setState(ok ? "ok" : "fail");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 1500);
  };
  const status = state === "ok" ? "Copied" : state === "fail" ? "Copy failed" : "";
  return (
    <>
      <Button size="small" disabled={disabled || !text} onClick={() => void onClick()}
        aria-label={state === "idle" ? `Copy ${what}` : undefined}
        color={state === "fail" ? "error" : "primary"}
        startIcon={state === "ok" ? <CheckIcon sx={{ fontSize: 16 }} /> : <ContentCopyIcon sx={{ fontSize: 16 }} />}
        sx={{ minWidth: 0, py: 0.25, flexShrink: 0 }}>
        {status || label}
      </Button>
      {/* announce the outcome to screen readers */}
      <Box component="span" role="status" aria-live="polite" sx={srOnly}>{status}</Box>
    </>
  );
}

function TextBlock({ heading, text, what, disabled }: { heading: string; text: string; what: string; disabled?: boolean }) {
  return (
    <Box>
      <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1} sx={{ mb: 0.5 }}>
        <Typography variant="overline" color="text.secondary" sx={{ lineHeight: 1.6, fontSize: 10.5, letterSpacing: 0.8 }}>
          {heading}
        </Typography>
        <CopyButton text={text} what={what} disabled={disabled} />
      </Stack>
      <Typography variant="body2" sx={{ userSelect: "text", whiteSpace: "pre-wrap", lineHeight: 1.6, cursor: "text" }}>
        {text}
      </Typography>
    </Box>
  );
}

export function FigureTextPanel({
  table, analysis, figure, result, busy, stale, error, renderFailed, side, panelWidth = 340, open, onToggle,
}: {
  table: GraphTable;
  /** effectiveAnalysis(...): what was sent to the engine. */
  analysis: GraphAnalysis;
  /** effectiveFigure(...): what was sent to the engine. */
  figure: GraphFigure;
  /** The result for exactly this table + analysis, or null. */
  result: AnalyzeResult | null;
  /** The statistics for the current data are still being computed. */
  busy: boolean;
  /** The figure on screen was rendered from older settings. */
  stale: boolean;
  /** The analysis request failed (no result at all). */
  error: string | null;
  /** The latest R render failed: the text describes settings, not a drawn figure. */
  renderFailed?: boolean;
  /** Beside the figure (true) or stacked below it (false). */
  side: boolean;
  /** Width beside the figure (px). */
  panelWidth?: number;
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  const software = useSoftware();
  const [normality, setNormality] = useState(() => readPref(PREF_NORMALITY) === "1");
  const showNormality = normalityApplies(table.template, analysis.test);

  const fresh = useMemo<FigureText>(
    () => buildFigureText({ table, analysis, figure, result, software, options: { normality: showNormality && normality } }),
    [table, analysis, figure, result, software, normality, showNormality],
  );
  // While the statistics for new data are computing, keep the previous text
  // (dimmed) instead of flashing the "no statistics" variant.
  const [settled, setSettled] = useState<FigureText>(fresh);
  useEffect(() => { if (!busy) setSettled(fresh); }, [busy, fresh]);
  const text = busy ? settled : fresh;

  const notes = useMemo(() => {
    if (busy || !error || result) return text.notes;
    return [`The statistics could not be computed: ${error}`, ...text.notes.filter((n) => n !== "Statistics are not available yet.")];
  }, [busy, error, result, text.notes]);

  const empty = !text.legend && !text.methods;
  const both = [text.legend, text.methods].filter(Boolean).join("\n\n");

  // ── collapsed ──
  if (!open) {
    if (side) {
      return (
        <Box sx={{ width: 36, flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 1, pt: 0.5,
          border: 1, borderColor: "divider", borderRadius: 1, bgcolor: "background.paper", alignSelf: "stretch", cursor: "pointer" }}
          onClick={() => onToggle(true)}>
          <Tooltip title="Show the figure legend & methods" placement="left">
            <IconButton size="small" aria-label="Show the figure legend and methods"><ChevronLeftIcon fontSize="small" /></IconButton>
          </Tooltip>
          <Typography variant="caption" color="text.secondary" sx={{ writingMode: "vertical-rl", letterSpacing: 0.5, userSelect: "none" }}>
            Legend &amp; methods
          </Typography>
        </Box>
      );
    }
    return (
      <Box sx={{ border: 1, borderColor: "divider", borderRadius: 1, bgcolor: "background.paper", px: 1.5, py: 0.5,
        display: "flex", alignItems: "center", cursor: "pointer" }} onClick={() => onToggle(true)}>
        <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>Legend &amp; methods</Typography>
        <IconButton size="small" aria-label="Show the figure legend and methods"><ExpandMoreIcon fontSize="small" /></IconButton>
      </Box>
    );
  }

  // ── open ──
  return (
    <Box component="section" aria-label="Figure legend and methods"
      sx={{
        border: 1, borderColor: "divider", borderRadius: 1, bgcolor: "background.paper",
        ...(side ? { width: panelWidth, flexShrink: 0, maxHeight: "calc(100vh - 170px)", overflow: "auto" } : { width: "100%" }),
      }}>
      <Stack direction="row" alignItems="center" spacing={1}
        sx={{ px: 1.5, py: 0.75, borderBottom: 1, borderColor: "divider", position: side ? "sticky" : "static", top: 0,
          bgcolor: "background.paper", zIndex: 1 }}>
        <Typography variant="subtitle2" noWrap sx={{ flexGrow: 1, minWidth: 0 }}>Legend &amp; methods</Typography>
        {!empty && <CopyButton text={both} label="Copy both" what="the legend and the methods" disabled={busy} />}
        <Tooltip title="Hide">
          <IconButton size="small" onClick={() => onToggle(false)} aria-label="Hide the figure legend and methods">
            {side ? <ChevronRightIcon fontSize="small" /> : <ExpandLessIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
      </Stack>

      <Stack spacing={1.75} sx={{ p: 1.5, opacity: busy ? 0.6 : 1, transition: "opacity 0.15s" }}>
        {renderFailed && (
          <Typography variant="caption" color="error" component="div">
            The figure could not be rendered, so this text does not describe a drawn figure. Fix the error and re-render before using it.
          </Typography>
        )}
        {(busy || stale) && (
          <Typography variant="caption" color="text.secondary" component="div">
            {busy ? "Updating statistics… (copy is available when done)" : "The text reflects the current settings; re-render the graph to match."}
          </Typography>
        )}
        {empty ? (
          <Typography variant="body2" color="text.secondary">{notes[0] ?? "Enter data to generate the text."}</Typography>
        ) : (
          <>
            <TextBlock heading="Figure legend" text={text.legend} what="the figure legend" disabled={busy} />
            <TextBlock heading="Statistical methods" text={text.methods} what="the statistical methods" disabled={busy} />
            {showNormality && (
              <FormControlLabel sx={{ ml: -0.75, mt: -0.5 }}
                control={<Checkbox size="small" checked={normality}
                  onChange={(e) => { setNormality(e.target.checked); writePref(PREF_NORMALITY, e.target.checked ? "1" : "0"); }} />}
                label={<Typography variant="body2">Mention the normality test (Shapiro–Wilk)</Typography>} />
            )}
            {notes.length > 0 && (
              <>
                <Divider />
                <Box>
                  <Typography variant="overline" color="text.secondary" component="div"
                    sx={{ lineHeight: 1.6, fontSize: 10.5, letterSpacing: 0.8, mb: 0.25 }}>
                    Check before use
                  </Typography>
                  <Box component="ul" sx={{ m: 0, pl: 2.25, listStyleType: "disc", "& li::marker": { color: "text.secondary" } }}>
                    {notes.map((n, i) => (
                      <Typography key={i} component="li" variant="caption" color="text.secondary" sx={{ display: "list-item", mb: 0.5 }}>
                        {n}
                      </Typography>
                    ))}
                  </Box>
                  <Typography variant="caption" color="text.disabled" component="div" sx={{ mt: 0.5 }}>
                    Generated from the data, the analysis and the graph settings; updates as they change. Notes are not copied.
                  </Typography>
                </Box>
              </>
            )}
          </>
        )}
      </Stack>
    </Box>
  );
}
