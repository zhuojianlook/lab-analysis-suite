import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Box, Typography } from "@mui/material";
import DragIndicatorIcon from "@mui/icons-material/DragIndicator";
import { moveAnnouncement, moveItem } from "./geneOrder";

/** Drag state. `target` = the index the gene would land at (0..n-1). */
type Drag = { gene: string; from: number; target: number; dy: number; outside: boolean };
type DragData = Drag & {
  pointerId: number; startY: number; pointerY: number; pointerX: number; startScroll: number;
  scroller: HTMLElement | null; raf: number; el: HTMLElement;
};

const ROW_H = 30;     // px
const EDGE = 40;      // px from the rail's top/bottom edge where dragging auto-scrolls
const MAX_SPEED = 14; // px per frame
const OUTSIDE = 80;   // px beside the list where releasing cancels the move

/** Nearest scrolling ancestor (the rail). */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

/** Reorderable list of the plotted genes. Drag a row (pointer events, so it
 *  works the same in every webview and never meets the file-drop zone), or
 *  use the handle from the keyboard: Alt+↑/↓ moves a gene; Space picks it up,
 *  the arrows move it, Space/Enter drops it and Escape puts it back. */
export function GeneOrderList({ genes, refs, onChange }: {
  genes: string[];
  refs: ReadonlySet<string>;
  onChange: (next: string[]) => void;
}) {
  const rows = useRef(new Map<string, HTMLElement>());
  const list = useRef<HTMLElement | null>(null);
  const handles = useRef(new Map<string, HTMLElement>());
  const data = useRef<DragData | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [grabbed, setGrabbed] = useState<{ gene: string; original: string[] } | null>(null);
  const [said, setSaid] = useState("");
  const refocus = useRef<string | null>(null);
  const genesRef = useRef(genes);
  genesRef.current = genes;

  // Keyboard moves re-order the DOM, which can drop focus: put it back.
  useLayoutEffect(() => {
    const g = refocus.current;
    if (g && document.activeElement !== handles.current.get(g)) handles.current.get(g)?.focus();
    refocus.current = null;
  });

  // ── pointer drag ─────────────────────────────────────────────────────────

  const update = () => {
    const d = data.current;
    if (!d) return;
    const ds = d.scroller ? d.scroller.scrollTop - d.startScroll : 0;
    // Layout positions (offsetTop ignores the shift transforms below).
    const top = list.current?.getBoundingClientRect().top ?? 0;
    let target = 0;
    for (const g of genesRef.current) {
      if (g === d.gene) continue;
      const el = rows.current.get(g);
      if (el && top + el.offsetTop + el.offsetHeight / 2 < d.pointerY) target++;
    }
    d.dy = d.pointerY - d.startY + ds;
    d.target = target;
    d.outside = droppedOutside(d.pointerX);
    setDrag({ gene: d.gene, from: d.from, target, dy: d.dy, outside: d.outside });
  };

  const tick = () => {
    const d = data.current;
    if (!d) return;
    if (d.scroller) {
      const r = d.scroller.getBoundingClientRect();
      // Only while there is more of the list to bring into view in that
      // direction (not on past its end, into the rest of the rail).
      const l = list.current?.getBoundingClientRect();
      const moreBelow = !l || l.bottom > r.bottom + 1;
      const moreAbove = !l || l.top < r.top - 1;
      const up = moreAbove && d.pointerY - r.top < EDGE ? (EDGE - (d.pointerY - r.top)) / EDGE : 0;
      const down = moreBelow && r.bottom - d.pointerY < EDGE ? (EDGE - (r.bottom - d.pointerY)) / EDGE : 0;
      const v = Math.round(MAX_SPEED * (Math.min(1, down) - Math.min(1, up)));
      if (v) {
        const before = d.scroller.scrollTop;
        d.scroller.scrollTop += v;
        if (d.scroller.scrollTop !== before) update();
      }
    }
    d.raf = requestAnimationFrame(tick);
  };

  const finish = (commit: boolean) => {
    const d = data.current;
    if (!d) return;
    data.current = null;
    cancelAnimationFrame(d.raf);
    try { d.el.releasePointerCapture(d.pointerId); } catch { /* already released */ }
    setDrag(null);
    if (commit && d.target !== d.from) {
      const next = moveItem(genesRef.current, d.from, d.target);
      onChange(next);
      setSaid(moveAnnouncement(d.gene, d.target, next.length));
    } else if (!commit) {
      setSaid(`Move of ${d.gene} cancelled.`);
    }
  };

  // Escape cancels a drag in progress.
  useEffect(() => {
    if (!drag) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!drag]);

  useEffect(() => () => { if (data.current) cancelAnimationFrame(data.current.raf); }, []);

  const onPointerDown = (e: PointerEvent<HTMLElement>, gene: string, index: number) => {
    if (e.button !== 0 || data.current || genes.length < 2) return;
    e.preventDefault();   // no text selection, and keep focus where it is
    const el = e.currentTarget;
    try { el.setPointerCapture(e.pointerId); } catch { /* the pointer is gone already */ }
    const scroller = scrollParent(el);
    data.current = {
      gene, from: index, target: index, dy: 0, outside: false, pointerId: e.pointerId, startY: e.clientY, pointerY: e.clientY, pointerX: e.clientX,
      startScroll: scroller?.scrollTop ?? 0, scroller, raf: 0, el,
    };
    data.current.raf = requestAnimationFrame(tick);
    setGrabbed(null);
    setDrag({ gene, from: index, target: index, dy: 0, outside: false });
  };

  /** Released well to the side of the list (e.g. over the canvas): cancel. */
  const droppedOutside = (x: number) => {
    const l = list.current?.getBoundingClientRect();
    return !!l && (x < l.left - OUTSIDE || x > l.right + OUTSIDE);
  };

  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    const d = data.current;
    if (!d || e.pointerId !== d.pointerId) return;
    d.pointerY = e.clientY;
    d.pointerX = e.clientX;
    update();
  };

  // ── keyboard ─────────────────────────────────────────────────────────────

  const moveBy = (gene: string, step: number) => {
    const from = genes.indexOf(gene);
    const to = Math.max(0, Math.min(genes.length - 1, from + step));
    if (from < 0 || to === from) {
      setSaid(`${gene} is already ${step < 0 ? "first" : "last"}.`);
      return;
    }
    refocus.current = gene;
    onChange(moveItem(genes, from, to));
    setSaid(moveAnnouncement(gene, to, genes.length));
  };

  const onHandleKey = (e: KeyboardEvent<HTMLElement>, gene: string) => {
    const k = e.key;
    if ((k === "ArrowUp" || k === "ArrowDown") && (e.altKey || grabbed?.gene === gene)) {
      e.preventDefault();
      e.stopPropagation();
      moveBy(gene, k === "ArrowUp" ? -1 : 1);
    } else if (k === " " || k === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (grabbed?.gene === gene) {
        setGrabbed(null);
        setSaid(`${gene} dropped at position ${genes.indexOf(gene) + 1} of ${genes.length}.`);
      } else {
        setGrabbed({ gene, original: genes });
        setSaid(`${gene} picked up, position ${genes.indexOf(gene) + 1} of ${genes.length}. Arrow keys move it, Space drops it, Escape cancels.`);
      }
    } else if (k === "Escape" && grabbed?.gene === gene) {
      e.preventDefault();
      e.stopPropagation();
      refocus.current = gene;
      onChange(grabbed.original);
      setGrabbed(null);
      setSaid(`Move of ${gene} cancelled.`);
    }
  };

  // ── render ───────────────────────────────────────────────────────────────

  // While dragging, the other rows slide apart to open a gap where the gene
  // will land, and a dashed outline marks that slot.
  const step = rows.current.get(genes[0])?.offsetHeight ?? ROW_H;
  const shift = (i: number) => {
    if (!drag || drag.outside) return 0;
    if (drag.target > drag.from && i > drag.from && i <= drag.target) return -step;
    if (drag.target < drag.from && i >= drag.target && i < drag.from) return step;
    return 0;
  };

  return (
    <Box>
      <Box role="list" aria-label="Gene order" ref={list} sx={{ position: "relative", userSelect: "none" }}>
        {drag && !drag.outside && (
          <Box aria-hidden sx={{
            position: "absolute", left: 0, right: 0, top: drag.target * step, height: step, borderRadius: 1,
            border: "2px dashed", borderColor: "primary.main", bgcolor: "action.hover", pointerEvents: "none",
          }} />
        )}
        {genes.map((g, i) => {
          const dragging = drag?.gene === g;
          const isGrabbed = grabbed?.gene === g;
          return (
            <Box
              key={g}
              role="listitem"
              ref={(el: HTMLElement | null) => { if (el) rows.current.set(g, el); else rows.current.delete(g); }}
              onPointerDown={(e) => onPointerDown(e, g, i)}
              onPointerMove={onPointerMove}
              onPointerUp={(e) => { if (data.current?.pointerId === e.pointerId) finish(!droppedOutside(e.clientX)); }}
              onPointerCancel={() => finish(false)}
              sx={{
                position: "relative",
                display: "flex", alignItems: "center", gap: 0.75, height: ROW_H, pl: 0.25, pr: 1,
                borderRadius: 1, cursor: drag ? "grabbing" : "grab", touchAction: "none",
                border: 1, borderColor: isGrabbed ? "primary.main" : "transparent",
                bgcolor: dragging ? "background.paper" : isGrabbed ? "action.selected" : "transparent",
                boxShadow: dragging ? 6 : "none",
                transform: dragging ? `translateY(${drag.dy}px)` : drag ? `translateY(${shift(i)}px)` : undefined,
                transition: drag && !dragging ? "transform 120ms ease" : "none",
                zIndex: dragging ? 2 : drag ? 1 : undefined,
                opacity: dragging ? (drag.outside ? 0.5 : 0.95) : 1,
                "&:hover": drag ? undefined : { bgcolor: isGrabbed ? "action.selected" : "action.hover" },
              }}
            >
              <Box
                component="span"
                role="button"
                tabIndex={0}
                ref={(el: HTMLElement | null) => { if (el) handles.current.set(g, el); else handles.current.delete(g); }}
                aria-label={`Move ${g}, position ${i + 1} of ${genes.length}`}
                aria-pressed={isGrabbed}
                aria-describedby="qpcr-gene-order-help"
                onKeyDown={(e) => onHandleKey(e, g)}
                onBlur={() => { if (isGrabbed) setGrabbed(null); }}
                sx={{
                  display: "grid", placeItems: "center", width: 24, height: 24, borderRadius: 0.75, color: "text.secondary",
                  "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main", outlineOffset: 0 },
                }}
              >
                <DragIndicatorIcon sx={{ fontSize: 18 }} />
              </Box>
              <Typography variant="body2" noWrap sx={{ flexGrow: 1, minWidth: 0 }}>{g}</Typography>
              {refs.has(g) && <Typography variant="caption" color="text.secondary">(ref)</Typography>}
            </Box>
          );
        })}
      </Box>
      <Typography id="qpcr-gene-order-help" variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5 }}>
        Drag to reorder (drop beside the list to cancel), or focus a handle and press Alt+↑/↓.
      </Typography>
      <Box aria-live="polite" sx={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" }}>
        {said}
      </Box>
    </Box>
  );
}
