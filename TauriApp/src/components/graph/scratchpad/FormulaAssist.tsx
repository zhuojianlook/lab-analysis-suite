/* Formula-editing popups and the coloured-text mirror for the Scratchpad:
   the function autocomplete list, the argument hint, and the overlay that
   draws a formula's references in their colours over the (transparent) text
   of the in-cell editor or the formula bar. */

import { useEffect, useRef, type CSSProperties, type MutableRefObject } from "react";
import { Box, Paper, Popper, useTheme } from "@mui/material";
import type { Instance } from "@popperjs/core";
import { signatureParts, type FnEntry } from "./functionCatalog";
import { REF_COLORS, segments, type FormulaRef } from "./formulaRefs";

export const FN_LIST_ID = "scratch-fn-list";
export const fnOptionId = (i: number) => `scratch-fn-${i}`;
export const FN_LIST_PAGE = 8;
const ROW = 26;
const C_POP = "#2c2c2e";
/** Above the app bar and drawers, below menus and dialogs (which are modals): an open menu covers the popups. */
const popZ = (modal: number) => modal - 1;

const MODIFIERS = [
  { name: "offset", options: { offset: [0, 2] } },
  { name: "flip", options: { fallbackPlacements: ["top-start"] } },
  { name: "preventOverflow", options: { padding: 8, altAxis: true } },
];

interface PopBase {
  open: boolean;
  anchorEl: HTMLElement | null;
  popperRef?: MutableRefObject<Instance | null>;
  lineColor: string;
}

function Signature({ fn, argIndex }: { fn: FnEntry; argIndex?: number }) {
  return (
    <>
      {signatureParts(fn, argIndex).map((p, i) => (
        <Box key={i} component="span" sx={p.current ? { fontWeight: 700, color: "text.primary" } : undefined}>{p.text}</Box>
      ))}
    </>
  );
}

export function FunctionListPopup({ open, anchorEl, popperRef, lineColor, items, index, partial, onPick, onHover }: PopBase & {
  items: FnEntry[];
  index: number;
  /** The typed partial name (its matching prefix is tinted). */
  partial: string;
  onPick: (fn: FnEntry) => void;
  onHover: (i: number) => void;
}) {
  const theme = useTheme();
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`#${fnOptionId(index)}`);
    el?.scrollIntoView({ block: "nearest" });
  }, [open, index, items]);
  const cur = items[Math.min(index, items.length - 1)];
  const q = partial.toUpperCase();
  return (
    <Popper open={open && !!anchorEl && items.length > 0} anchorEl={anchorEl} placement="bottom-start" popperRef={popperRef}
      modifiers={MODIFIERS} sx={{ zIndex: popZ(theme.zIndex.modal) }}>
      <Paper elevation={8} onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
        sx={{ bgcolor: C_POP, border: `1px solid ${lineColor}`, width: "min(460px, calc(100vw - 16px))", fontSize: 12, overflow: "hidden" }}>
        <Box ref={listRef} role="listbox" id={FN_LIST_ID} aria-label="Functions" sx={{ maxHeight: FN_LIST_PAGE * ROW, overflowY: "auto" }}>
          {items.map((f, i) => {
            const prefix = f.name.startsWith(q) ? q.length : 0;
            return (
              <Box key={f.name} role="option" id={fnOptionId(i)} aria-selected={i === index}
                onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onPick(f); }}
                onMouseMove={() => { if (i !== index) onHover(i); }}
                sx={{
                  display: "flex", alignItems: "center", height: ROW, px: 1, gap: 1, cursor: "pointer", whiteSpace: "nowrap",
                  bgcolor: i === index ? "rgba(90,127,168,0.35)" : undefined,
                }}>
                <Box component="span" sx={{ fontWeight: 600, minWidth: 150, flexShrink: 0 }}>
                  {prefix > 0 && <Box component="span" sx={{ color: "primary.light" }}>{f.name.slice(0, prefix)}</Box>}
                  {f.name.slice(prefix)}
                </Box>
                <Box component="span" sx={{ color: "text.secondary", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{f.desc}</Box>
              </Box>
            );
          })}
        </Box>
        {cur && (
          <Box sx={{ borderTop: `1px solid ${lineColor}`, px: 1, py: 0.5, color: "text.secondary", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            <Signature fn={cur} />
          </Box>
        )}
      </Paper>
    </Popper>
  );
}

export function ArgHintPopup({ open, anchorEl, popperRef, lineColor, fn, argIndex }: PopBase & { fn: FnEntry | undefined; argIndex: number }) {
  const theme = useTheme();
  return (
    <Popper open={open && !!anchorEl && !!fn} anchorEl={anchorEl} placement="bottom-start" popperRef={popperRef}
      modifiers={MODIFIERS} sx={{ zIndex: popZ(theme.zIndex.modal), pointerEvents: "none" }}>
      {fn && (
        <Box role="tooltip" sx={{
          bgcolor: `${C_POP}ee`, border: `1px solid ${lineColor}`, p: "2px 8px", fontSize: 12, color: "text.secondary",
          maxWidth: "calc(100vw - 16px)", borderRadius: 0.5, pointerEvents: "none",
        }}>
          <Box sx={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}><Signature fn={fn} argIndex={argIndex} /></Box>
          <Box sx={{ fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{fn.desc}</Box>
        </Box>
      )}
    </Popper>
  );
}

/** The formula's text with each reference in its colour, drawn over an editor whose own text is transparent. */
export function ColouredText({ text, refs, scrollLeft, scrollTop, style }: {
  text: string; refs: FormulaRef[]; scrollLeft: number; scrollTop: number; style: CSSProperties;
}) {
  const theme = useTheme();
  return (
    <div aria-hidden data-formula-mirror="" style={{ pointerEvents: "none", overflow: "hidden", whiteSpace: "pre", ...style }}>
      <span style={{ display: "inline-block", transform: `translate(${-scrollLeft}px, ${-scrollTop}px)`, color: theme.palette.text.primary }}>
        {segments(text, refs).map((s, i) => (s.color === undefined
          ? <span key={i}>{s.text}</span>
          : <span key={i} style={{ color: REF_COLORS[s.color] }}>{s.text}</span>))}
      </span>
    </div>
  );
}
