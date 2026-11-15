/* Colour palette picker for rail step 3 (Graph → Colours & legend).

   Offers the built-in palettes plus every palette of the user's installed R
   package ggprism (which reproduces GraphPad Prism's colour schemes), read at
   runtime from GET /api/graph/palettes — no ggprism data ships with the app.
   Browsing / searching the list never touches the figure: only choosing a
   palette changes the colours (one re-render). */

import { useEffect, useMemo, useRef, useState, type Ref, type RefObject } from "react";

/** One DOM node into several refs (MUI's own input ref + ours). */
function mergeRefs<T>(...refs: (Ref<T> | undefined)[]) {
  return (node: T | null) => {
    for (const r of refs) {
      if (typeof r === "function") r(node);
      else if (r) (r as RefObject<T | null>).current = node;
    }
  };
}
import {
  Autocomplete, Box, Button, FormControlLabel, ListSubheader, Stack, Switch, TextField, Typography, createFilterOptions,
} from "@mui/material";
import { getGraphPalettes, type GraphFigure, type GraphPalettes, type Template } from "../../api/graph";
import {
  APP_GROUP, PALETTES, applyPalette, humanizePalette, isLightHex, paletteOptions, prismGroup, prismScheme, reversePalette,
  type PaletteOption,
} from "./graphModel";

// ── loading (one request per session; re-probed while unavailable) ─────────

const FAILED: GraphPalettes = {
  available: false, source: "ggprism", version: null, r: null, reason: "probe_failed",
  message: "The Prism palettes couldn't be loaded, so only the built-in palettes are available.",
  colour: {}, fill: {}, themes: {},
};

let palPromise: Promise<GraphPalettes> | null = null;
let palResolved: GraphPalettes | null = null;

function loadPalettes(force = false): Promise<GraphPalettes> {
  if (force) palPromise = null;
  if (!palPromise) {
    palPromise = getGraphPalettes()
      .then((r) => (r && typeof r === "object" && typeof r.available === "boolean" ? r : FAILED))
      .catch(() => FAILED)
      .then((v) => {
        // R / ggprism may be installed or fixed while the app is open.
        if (!v.available) palPromise = null;
        palResolved = v;
        return v;
      });
  }
  return palPromise;
}

function usePalettes(): { palettes: GraphPalettes | null; retry: () => void } {
  const [palettes, setPalettes] = useState<GraphPalettes | null>(palResolved?.available ? palResolved : null);
  useEffect(() => {
    let cancelled = false;
    void loadPalettes().then((v) => { if (!cancelled) setPalettes(v); });
    return () => { cancelled = true; };
  }, []);
  const retry = () => {
    setPalettes(null);
    void loadPalettes(true).then(setPalettes);
  };
  return { palettes, retry };
}

// ── pieces ───────────────────────────────────────────────────────────────────

/** A strip of colour swatches. Decorative (the palette name is always shown as
 *  text); the divider-coloured border keeps white / black / pale swatches
 *  visible on light and dark app themes. */
export function Swatches({ colors, width = 108, height = 14 }: { colors: string[]; width?: number | string; height?: number }) {
  return (
    <Box aria-hidden sx={{
      display: "flex", width, height, flexShrink: 0, border: 1, borderColor: "divider", borderRadius: 0.5, overflow: "hidden",
    }}>
      {colors.map((c, i) => <Box key={i} sx={{ flex: 1, bgcolor: c }} />)}
    </Box>
  );
}

const filter = createFilterOptions<PaletteOption>({ stringify: (o) => `${o.label} ${o.name}` });

/** Text for screen readers only. */
const srOnly = {
  border: 0, clip: "rect(0 0 0 0)", height: "1px", margin: "-1px", overflow: "hidden", padding: 0,
  position: "absolute", whiteSpace: "nowrap", width: "1px",
} as const;

const Caption = ({ children }: { children: React.ReactNode }) => (
  <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5 }}>{children}</Typography>
);

export function PalettePicker({
  template, figure, setFigure, n,
}: {
  template: Template;
  figure: GraphFigure;
  setFigure: (patch: Partial<GraphFigure>) => void;
  /** Number of data sets (colours to assign). */
  n: number;
}) {
  const { palettes, retry } = usePalettes();
  const pid = typeof figure.palette === "string" ? figure.palette : "";

  const options = useMemo(() => {
    const list = paletteOptions(template, palettes);
    // A saved palette this engine can't list (no R here, another ggprism
    // version): keep showing its name and the colours captured when applied.
    if (pid && !list.some((o) => o.id === pid)) {
      const prism = pid.startsWith("prism:");
      const name = pid.slice(prism ? 6 : 4);
      const colors = figure.palette_colors?.length ? figure.palette_colors
        : !prism && Object.prototype.hasOwnProperty.call(PALETTES, name) ? PALETTES[name] : [];
      if (colors.length) {
        list.push({
          id: pid, group: prism ? prismGroup(palettes?.version) : APP_GROUP, name,
          label: prism ? humanizePalette(name) : name, colors, hasScheme: false,
        });
      }
    }
    return list;
  }, [template, palettes, pid, figure.palette_colors]);

  const active = options.find((o) => o.id === pid) ?? null;
  const edited = !!active && figure.palette_edited === true;
  const k = active?.colors.length ?? 0;

  // Re-choosing the active palette resets hand-edited colours. MUI's
  // Autocomplete never calls onChange for the option that is already the
  // value, so a click / Enter on it is handled here instead.
  const resetColours = () => { if (active) setFigure(applyPalette(figure, active, n)); };
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [inputValue, setInputValue] = useState(active?.label ?? "");
  useEffect(() => { if (!open) setInputValue(active?.label ?? ""); }, [open, active?.label]);

  // Prism colour scheme (axes / text): only where it has an effect.
  const schemeName = pid.startsWith("prism:") ? pid.slice(6) : "";
  const theme = schemeName && palettes?.available && Object.prototype.hasOwnProperty.call(palettes.themes, schemeName)
    ? palettes.themes[schemeName] : undefined;
  const schemeEnabled = !!theme && figure.theme === "prism";
  const unavailable = !!palettes && !palettes.available;
  const schemeReason = !palettes ? "Loading Prism palettes…"
    : !palettes.available ? palettes.message
      : !schemeName ? "Pick a Prism palette to use its colour scheme."
        : !theme ? "ggprism has no colour scheme for this palette."
          : figure.theme !== "prism" ? "Needs the Prism theme (Style → Theme)."
            : "";
  // Shows what the figure actually asks for. While the palettes can't be
  // listed (no answer from R) a saved scheme still draws, so it stays shown
  // (switched on but disabled) rather than appearing off.
  const schemeOn = !!prismScheme(figure) && (schemeEnabled || !palettes?.available);
  // Turning a scheme off is always allowed; turning one on needs it to apply.
  const schemeDisabled = !schemeEnabled && !schemeOn;
  // Transparent export with a scheme: the preview keeps the scheme's page
  // colour; say so, and warn when the ink is light (white axes on a clear page).
  const lightInk = !!theme && isLightHex(theme.axisColor);

  return (
    <Box sx={{ mb: 1 }}>
      <Autocomplete<PaletteOption, false, true, false>
        size="small" fullWidth disableClearable autoHighlight openOnFocus
        options={options}
        open={open}
        onOpen={() => setOpen(true)}
        onClose={() => setOpen(false)}
        inputValue={inputValue}
        onInputChange={(_, v) => setInputValue(v)}
        onKeyDown={(e) => {
          // The highlighted option, as MUI announces it to assistive tech
          // (onHighlightChange isn't called for the highlight set on opening).
          const input = e.target as HTMLElement;
          const ad = input.getAttribute?.("aria-activedescendant");
          const hl = ad ? input.ownerDocument.getElementById(ad) : null;
          if (e.key === "Enter" && open && edited && hl?.dataset.paletteId === pid) {
            resetColours();
            setOpen(false);
          }
        }}
        groupBy={(o) => o.group}
        value={active as PaletteOption}
        isOptionEqualToValue={(o, v) => o.id === v.id}
        getOptionLabel={(o) => o.label}
        filterOptions={filter}
        noOptionsText="No palette matches"
        onChange={(_, o) => {
          if (o) setFigure(applyPalette(figure, o, n));
          // focus stays in the field: select its text so a new search replaces the label
          requestAnimationFrame(() => inputRef.current?.select());
        }}
        slotProps={{ listbox: { sx: { maxHeight: 320 } } }}
        renderGroup={(params) => (
          <li key={params.key}>
            <ListSubheader component="div" sx={{ top: -8, lineHeight: 1.4, py: 0.75 }}>
              {params.group}
              {params.group !== APP_GROUP && options.some((o) => o.group === params.group && o.hasScheme) && (
                <Typography variant="caption" color="text.secondary" component="div">
                  Aa = has a matching Prism colour scheme for the axes and text
                </Typography>
              )}
            </ListSubheader>
            <Box component="ul" sx={{ p: 0 }}>{params.children}</Box>
          </li>
        )}
        renderOption={(props, o) => {
          const { key, ...rest } = props as typeof props & { key: string };
          const onClick = (e: React.MouseEvent<HTMLLIElement>) => {
            rest.onClick?.(e);
            if (o.id === pid && edited) resetColours();
          };
          return (
            <Box component="li" key={key} {...rest} data-palette-id={o.id} onClick={onClick} sx={{ gap: 1 }}>
              <Typography variant="body2" sx={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {o.label}
              </Typography>
              {o.hasScheme && <Box component="span" sx={srOnly}>, has a Prism colour scheme</Box>}
              {o.hasScheme && (
                <Box component="span" aria-hidden title="Has a Prism colour scheme" sx={{
                  fontSize: 10, lineHeight: "14px", px: 0.5, border: 1, borderColor: "divider", borderRadius: 0.5, color: "text.secondary",
                }}>Aa</Box>
              )}
              <Swatches colors={o.colors} />
            </Box>
          );
        }}
        renderInput={(params) => (
          <TextField {...params} label="Palette" placeholder="Custom colours — search palettes…"
            slotProps={{
              inputLabel: { ...params.InputLabelProps, shrink: true },
              htmlInput: { ...params.inputProps, "aria-label": "Colour palette", ref: mergeRefs(params.inputProps.ref, inputRef) },
            }} />
        )}
      />

      {active ? (
        <Box sx={{ mt: 0.75 }}>
          <Swatches colors={active.colors} width="100%" />
          {edited ? (
            <Stack direction="row" alignItems="center" spacing={1}>
              <Caption>{active.label} · edited by hand</Caption>
              <Button size="small" onClick={resetColours} sx={{ mt: 0.25, py: 0, minWidth: 0 }}>Reset colours</Button>
            </Stack>
          ) : (
            <Caption>{`${active.label} · ${k} colour${k === 1 ? "" : "s"}`}</Caption>
          )}
          {k > 0 && k < n && (
            <Caption>This palette has {k} colour{k === 1 ? "" : "s"}; with {n} data sets the colours repeat.</Caption>
          )}
          {active.kindDiffers && (
            <Caption>{template === "xy" ? "Using Prism's line/symbol colours." : "Using Prism's fill colours."}</Caption>
          )}
        </Box>
      ) : (
        <Caption>Custom colours</Caption>
      )}

      {palettes && !palettes.available && (
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mt: 0.5 }}>
          <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>{palettes.message}</Typography>
          <Button size="small" onClick={retry}>Try again</Button>
        </Stack>
      )}

      <Stack sx={{ mt: 0.5 }}>
        <FormControlLabel sx={{ ml: -0.5 }}
          control={<Switch size="small" checked={!!figure.palette_reverse} disabled={n < 2}
            onChange={() => setFigure(reversePalette(figure))} />}
          label={<Typography variant="body2">Reverse order</Typography>} />
        <FormControlLabel sx={{ ml: -0.5, alignItems: "flex-start", mt: 0.25 }}
          control={<Switch size="small" checked={schemeOn} disabled={schemeDisabled}
            onChange={(e) => setFigure({ axis_scheme: e.target.checked })} />}
          label={<Typography variant="body2" sx={{ pt: 0.25 }}>Colour the axes and text to match (Prism colour scheme)</Typography>} />
        {schemeReason && !unavailable && <Caption>{schemeReason}</Caption>}
        {schemeOn && !schemeEnabled && unavailable && (
          <Caption>The saved colour scheme is still drawn; switch it off to use black axes and text.</Caption>
        )}
        {schemeOn && theme && (
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.5 }}>
            <Box aria-hidden sx={{
              width: 40, height: 26, flexShrink: 0, bgcolor: theme.pageBackgroundColor, border: `1px solid ${theme.axisColor}`,
              borderLeftWidth: 2, borderBottomWidth: 2, borderRadius: 0.5, display: "flex", alignItems: "center", justifyContent: "center",
              color: theme.graphTitleColor, fontSize: 12, fontWeight: 600,
            }}>Aa</Box>
            {theme.pageBackgroundColor.toUpperCase() !== "#FFFFFF" && (
              <Typography variant="caption" color="text.secondary">
                {figure.transparent
                  ? lightInk
                    ? "The preview keeps the page colour so the light axes and text stay visible; the exported file is transparent, so place it on a dark background."
                    : "The preview keeps the page colour; the exported file is transparent."
                  : "This scheme has a coloured page background; “Transparent background” removes it from the exported file."}
              </Typography>
            )}
          </Stack>
        )}
      </Stack>
    </Box>
  );
}
