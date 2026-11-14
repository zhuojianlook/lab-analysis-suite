import { useEffect, useState, type ReactNode } from "react";
import {
  Box, Chip, FormControlLabel, MenuItem, Slider, Stack, Switch, TextField, ToggleButton, ToggleButtonGroup, Typography,
} from "@mui/material";
import type { GraphFigure, Template } from "../../api/graph";
import { RailHeading } from "../shared/RailSection";
import { NumberField } from "../shared/NumberField";
import { CENTERS, PALETTES, templateInfo } from "./graphModel";

/** Caption + slider with the current value shown on the right. */
export function LabeledSlider({
  label, value, onChange, min, max, step, format,
}: {
  label: string; value: number; onChange: (v: number) => void;
  min: number; max: number; step: number; format?: (v: number) => string;
}) {
  return (
    <Box sx={{ px: 0.5, mt: 0.5 }}>
      <Stack direction="row" justifyContent="space-between">
        <Typography variant="caption" color="text.secondary">{label}</Typography>
        <Typography variant="caption">{format ? format(value) : value}</Typography>
      </Stack>
      <Slider value={value} min={min} max={max} step={step} onChange={(_, v) => onChange(v as number)} sx={{ py: 1 }} />
    </Box>
  );
}

export const Grid2 = ({ children }: { children: ReactNode }) => (
  <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1 }}>{children}</Box>
);

/** Number input where blank means "automatic" (null). Commits on blur/Enter. */
function OptionalNumberField({ label, value, onCommit }: { label: string; value: number | null; onCommit: (v: number | null) => void }) {
  const [text, setText] = useState(value === null ? "" : String(value));
  useEffect(() => { setText(value === null ? "" : String(value)); }, [value]);
  const commit = () => {
    const t = text.trim().replace(/^(-?\d+),(\d+)$/, "$1.$2");
    if (t === "") { if (value !== null) onCommit(null); return; }
    const n = Number(t);
    if (!Number.isFinite(n)) { setText(value === null ? "" : String(value)); return; }
    if (n !== value) onCommit(n);
  };
  return (
    <TextField size="small" label={label} value={text} placeholder="Auto"
      onChange={(e) => setText(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
      slotProps={{ inputLabel: { shrink: true }, htmlInput: { inputMode: "decimal" } }} />
  );
}

/** Axis and graph titles. Used at the top of rail step 3 and, `dense`, as a
 *  one-line row above the figure on the Graph canvas (same store fields, so the
 *  two stay in sync). */
export function TitleFields({
  figure, setFigure, template, dense,
}: {
  figure: GraphFigure;
  setFigure: (patch: Partial<GraphFigure>) => void;
  template: Template;
  dense?: boolean;
}) {
  const xPlaceholder = template === "xy" ? "X column title" : "Optional";
  // Explicit accessible names: the rail and the canvas row show the same three
  // fields at once, so the canvas copies say where they are.
  const where = dense ? " (above the figure)" : "";
  const input = (name: string) => ({ "aria-label": `${name}${where}` });
  const y = (
    <TextField size="small" label="Y axis title" value={figure.ylabel ?? ""} placeholder="e.g. Weight (g)"
      onChange={(e) => setFigure({ ylabel: e.target.value })} fullWidth
      slotProps={{ inputLabel: { shrink: true }, htmlInput: input("Y axis title") }} />
  );
  const x = (
    <TextField size="small" label="X axis title" value={figure.xlabel ?? ""} placeholder={xPlaceholder}
      onChange={(e) => setFigure({ xlabel: e.target.value })} fullWidth
      slotProps={{ inputLabel: { shrink: true }, htmlInput: input("X axis title") }} />
  );
  const title = (
    <TextField size="small" label="Graph title" value={figure.title ?? ""} placeholder="Optional"
      onChange={(e) => setFigure({ title: e.target.value })} fullWidth
      slotProps={{ inputLabel: { shrink: true }, htmlInput: input("Graph title") }} />
  );
  if (dense) {
    return (
      <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 1 }}>
        {y}{x}{title}
      </Box>
    );
  }
  return (
    <Stack spacing={1}>
      {y}
      <Grid2>{x}{title}</Grid2>
    </Stack>
  );
}

export function GraphFigureControls({
  template, figure, setFigure, seriesTitles, hasComparisons,
}: {
  template: Template;
  figure: GraphFigure;
  setFigure: (patch: Partial<GraphFigure>) => void;
  /** Column / data-set titles, in order (legend label placeholders). */
  seriesTitles: string[];
  /** The analysis produces pairwise comparisons that can be drawn as brackets. */
  hasComparisons: boolean;
}) {
  const f = figure;
  const g = f.graph_type;
  const graphs = templateInfo(template).graphs;
  const pointsInherent = g === "dot" || g === "gdot" || g === "xy_points" || g === "xy_line" || g === "xy_fit";
  const centerInherent = g === "box" || g === "violin";
  const hasBars = g === "bar" || g === "gbar" || g === "box" || g === "violin";

  const applyPalette = (name: string) => {
    const pal = PALETTES[name];
    setFigure({ colors: seriesTitles.map((_, i) => pal[i % pal.length]) });
  };

  return (
    <Box>
      <RailHeading first>Graph type</RailHeading>
      <ToggleButtonGroup fullWidth exclusive size="small" value={g}
        onChange={(_, v) => { if (v) setFigure({ graph_type: v }); }}>
        {graphs.map((x) => <ToggleButton key={x.id} value={x.id} sx={{ px: 0.5 }}>{x.label}</ToggleButton>)}
      </ToggleButtonGroup>

      <RailHeading>Titles</RailHeading>
      <TitleFields figure={f} setFigure={setFigure} template={template} />
      <LabeledSlider label="Font size" value={f.font_size} onChange={(v) => setFigure({ font_size: v })} min={8} max={28} step={1} format={(v) => `${v} pt`} />

      <RailHeading>Style</RailHeading>

      <Box>
        <Grid2>
          <TextField select size="small" label={template === "xy" ? "Replicates as" : "Centre & error"} value={f.center}
            disabled={centerInherent} onChange={(e) => setFigure({ center: e.target.value as GraphFigure["center"] })}>
            {CENTERS.map((c) => <MenuItem key={c.id} value={c.id}>{c.label}</MenuItem>)}
          </TextField>
          <TextField select size="small" label="Theme" value={f.theme} onChange={(e) => setFigure({ theme: e.target.value as GraphFigure["theme"] })}>
            <MenuItem value="prism">Prism</MenuItem>
            <MenuItem value="classic">Classic</MenuItem>
            <MenuItem value="minimal">Minimal</MenuItem>
          </TextField>
        </Grid2>
        {centerInherent && (
          <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5 }}>
            {g === "box"
              ? "Boxes span the 25th–75th percentiles with a line at the median; whiskers reach the minimum and maximum."
              : "Violins show the distribution (kernel density) with a line at the median; groups with fewer than 3 values are drawn as points."}
          </Typography>
        )}
      </Box>

      {g === "xy_fit" && (
        <Stack sx={{ mt: 0.5 }}>
          <FormControlLabel sx={{ ml: -0.5 }}
            control={<Switch size="small" checked={f.show_band} onChange={(e) => setFigure({ show_band: e.target.checked })} />}
            label={<Typography variant="body2">95% confidence band</Typography>} />
          <FormControlLabel sx={{ ml: -0.5 }}
            control={<Switch size="small" checked={f.show_equation} onChange={(e) => setFigure({ show_equation: e.target.checked })} />}
            label={<Typography variant="body2">Show equation and R²</Typography>} />
        </Stack>
      )}

      <RailHeading>Data points</RailHeading>
      <FormControlLabel sx={{ ml: -0.5 }}
        control={<Switch size="small" checked={f.show_points || pointsInherent} disabled={pointsInherent}
          onChange={(e) => setFigure({ show_points: e.target.checked })} />}
        label={<Typography variant="body2">Show individual values</Typography>} />
      {(f.show_points || pointsInherent) && (
        <LabeledSlider label="Point size" value={f.point_size} onChange={(v) => setFigure({ point_size: v })} min={0.5} max={6} step={0.1} />
      )}
      {hasBars && (
        <LabeledSlider label={g === "bar" || g === "gbar" ? "Bar width" : "Width"} value={f.bar_width}
          onChange={(v) => setFigure({ bar_width: v })} min={0.2} max={1} step={0.05} format={(v) => v.toFixed(2)} />
      )}

      {template !== "xy" && (
        <>
          <RailHeading>Significance</RailHeading>
          <Grid2>
            <TextField select size="small" label="Brackets" value={f.sig_show} disabled={!hasComparisons}
              onChange={(e) => setFigure({ sig_show: e.target.value as GraphFigure["sig_show"] })}>
              <MenuItem value="significant">Significant only</MenuItem>
              <MenuItem value="all">All (incl. ns)</MenuItem>
              <MenuItem value="none">None</MenuItem>
            </TextField>
            <TextField select size="small" label="Label" value={f.sig_label} disabled={!hasComparisons || f.sig_show === "none"}
              onChange={(e) => setFigure({ sig_label: e.target.value as GraphFigure["sig_label"] })}>
              <MenuItem value="stars">Stars</MenuItem>
              <MenuItem value="p">P values</MenuItem>
            </TextField>
          </Grid2>
          {!hasComparisons && (
            <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5 }}>
              Brackets appear when the analysis compares groups.
            </Typography>
          )}
        </>
      )}

      <RailHeading>Y axis range</RailHeading>
      <Grid2>
        <OptionalNumberField label="Y min" value={f.y_min} onCommit={(v) => setFigure({ y_min: v })} />
        <OptionalNumberField label="Y max" value={f.y_max} onCommit={(v) => setFigure({ y_max: v })} />
      </Grid2>
      {f.y_min !== null && f.y_max !== null && f.y_min >= f.y_max && (
        <Typography variant="caption" color="warning.main" component="div" sx={{ mt: 0.5 }}>Y min must be below Y max.</Typography>
      )}

      <RailHeading>Colours &amp; legend</RailHeading>
      <Stack direction="row" spacing={0.75} sx={{ mb: 1 }}>
        {Object.keys(PALETTES).map((name) => (
          <Chip key={name} size="small" variant="outlined" label={name} onClick={() => applyPalette(name)} />
        ))}
      </Stack>
      <Stack spacing={0.75}>
        {seriesTitles.map((title, i) => (
          <Stack key={i} direction="row" spacing={1} alignItems="center">
            <input type="color" value={f.colors[i] ?? "#888888"} aria-label={`Colour for ${title}`}
              onChange={(e) => {
                const colors = [...f.colors];
                colors[i] = e.target.value;
                setFigure({ colors });
              }}
              style={{ width: 30, height: 30, padding: 0, border: "1px solid #48484a", borderRadius: 4, background: "none", cursor: "pointer", flexShrink: 0 }} />
            <TextField size="small" fullWidth value={f.labels[i] ?? ""} placeholder={title}
              onChange={(e) => {
                const labels = [...f.labels];
                while (labels.length <= i) labels.push("");
                labels[i] = e.target.value;
                setFigure({ labels });
              }}
              slotProps={{ htmlInput: { "aria-label": `Legend label for ${title}` } }} />
          </Stack>
        ))}
      </Stack>
      <FormControlLabel sx={{ ml: -0.5, mt: 0.5 }}
        control={<Switch size="small" checked={f.show_legend} onChange={(e) => setFigure({ show_legend: e.target.checked })} />}
        label={<Typography variant="body2">Show legend</Typography>} />
      <Typography variant="caption" color="text.secondary" component="div">
        A blank label uses the column title.
      </Typography>

      <RailHeading>Export</RailHeading>
      <Stack spacing={1}>
        <Grid2>
          <NumberField size="small" label="Width (px)" value={f.width} onCommit={(v) => setFigure({ width: v })} min={300} max={8000} step={100} />
          <NumberField size="small" label="Height (px)" value={f.height} onCommit={(v) => setFigure({ height: v })} min={300} max={8000} step={100} />
        </Grid2>
        <Grid2>
          <TextField select size="small" label="DPI" value={f.dpi} onChange={(e) => setFigure({ dpi: Number(e.target.value) })}>
            {[100, 150, 300, 600].map((d) => <MenuItem key={d} value={d}>{d}</MenuItem>)}
          </TextField>
          <ToggleButtonGroup fullWidth exclusive size="small" value={f.export_format}
            onChange={(_, v) => { if (v) setFigure({ export_format: v }); }}>
            <ToggleButton value="png">PNG</ToggleButton>
            <ToggleButton value="tiff">TIFF</ToggleButton>
          </ToggleButtonGroup>
        </Grid2>
        <FormControlLabel sx={{ ml: -0.5 }}
          control={<Switch size="small" checked={f.transparent} onChange={(e) => setFigure({ transparent: e.target.checked })} />}
          label={<Typography variant="body2">Transparent background</Typography>} />
      </Stack>
    </Box>
  );
}
