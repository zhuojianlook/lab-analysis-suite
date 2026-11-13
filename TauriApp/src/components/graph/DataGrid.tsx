import { memo, useCallback, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { Box, Divider, IconButton, Menu, MenuItem, Typography } from "@mui/material";
import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import { useGraphStore } from "../../store/graphStore";
import {
  MAX_COLS, MAX_ROWS, colHasData, isMultiPaste, leadCols, parseCell, rowHasData, type PasteResult,
} from "./graphModel";

const GUTTER = 38;
const LEAD_W = 120;
const H1 = 34;
const H2 = 22;

/** One value cell. Subscribes only to its own text, so typing re-renders one input. */
const DataCell = memo(function DataCell({ r, c, k, fc, w }: { r: number; c: number; k: number; fc: number; w: number }) {
  const value = useGraphStore((s) => s.doc?.cells[r]?.[c]?.[k] ?? "");
  const setCell = useGraphStore((s) => s.setCell);
  const invalid = value !== "" && parseCell(value).invalid;
  return (
    <td>
      <input
        data-gr={r}
        data-gc={fc}
        className={invalid ? "invalid" : undefined}
        title={invalid ? "Not a number — ignored" : undefined}
        aria-label={`Row ${r + 1}, column ${c + 1}${k ? `, replicate ${k + 1}` : ""}`}
        value={value}
        onChange={(e) => setCell(r, c, k, e.target.value)}
        style={{ width: w, textAlign: "right" }}
      />
    </td>
  );
});

/** The X value (XY) or row title (grouped) at the start of a row. */
const LeadCell = memo(function LeadCell({ r, kind }: { r: number; kind: "x" | "rowtitle" }) {
  const value = useGraphStore((s) => (kind === "x" ? s.doc?.x[r] : s.doc?.row_titles[r]) ?? "");
  const setX = useGraphStore((s) => s.setX);
  const setRowTitle = useGraphStore((s) => s.setRowTitle);
  const invalid = kind === "x" && value !== "" && parseCell(value).invalid;
  return (
    <td className="lead">
      <input
        data-gr={r}
        data-gc={0}
        className={invalid ? "invalid" : undefined}
        aria-label={kind === "x" ? `X value, row ${r + 1}` : `Row title, row ${r + 1}`}
        placeholder={kind === "rowtitle" ? `Row ${r + 1}` : undefined}
        value={value}
        onChange={(e) => (kind === "x" ? setX(r, e.target.value) : setRowTitle(r, e.target.value))}
        style={{ width: LEAD_W - 8, textAlign: kind === "x" ? "right" : "left" }}
      />
    </td>
  );
});

const ColTitle = memo(function ColTitle({ c, fc, onMenu }: { c: number; fc: number; onMenu: (el: HTMLElement, c: number) => void }) {
  const value = useGraphStore((s) => s.doc?.col_titles[c] ?? "");
  const setColTitle = useGraphStore((s) => s.setColTitle);
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.25 }}>
      <input
        data-gr={-1}
        data-gc={fc}
        className="title"
        aria-label={`Title of column ${c + 1}`}
        value={value}
        onChange={(e) => setColTitle(c, e.target.value)}
        style={{ flexGrow: 1, minWidth: 0, width: "100%" }}
      />
      <IconButton size="small" aria-label={`Column ${c + 1} options`} onClick={(e) => onMenu(e.currentTarget, c)} sx={{ p: 0.25 }}>
        <ArrowDropDownIcon sx={{ fontSize: 18 }} />
      </IconButton>
    </Box>
  );
});

const XTitle = memo(function XTitle() {
  const value = useGraphStore((s) => s.doc?.x_title ?? "");
  const setXTitle = useGraphStore((s) => s.setXTitle);
  return (
    <input data-gr={-1} data-gc={0} className="title" aria-label="Title of the X column" value={value}
      onChange={(e) => setXTitle(e.target.value)} style={{ width: LEAD_W - 8 }} />
  );
});

const GridRow = memo(function GridRow({ r, nCols, nRep, lead, w, onRowMenu }: {
  r: number; nCols: number; nRep: number; lead: "x" | "rowtitle" | null; w: number;
  onRowMenu: (el: HTMLElement, r: number) => void;
}) {
  const offset = lead ? 1 : 0;
  const cells = [];
  for (let c = 0; c < nCols; c++) {
    for (let k = 0; k < nRep; k++) {
      cells.push(<DataCell key={`${c}:${k}`} r={r} c={c} k={k} fc={offset + c * nRep + k} w={w} />);
    }
  }
  return (
    <tr>
      <td className="gutter">
        <button type="button" className="rownum" aria-label={`Row ${r + 1} options`} onClick={(e) => onRowMenu(e.currentTarget, r)}>
          {r + 1}
        </button>
      </td>
      {lead && <LeadCell r={r} kind={lead} />}
      {cells}
    </tr>
  );
});

type MenuState = { el: HTMLElement; index: number; confirm: boolean } | null;

/** Spreadsheet-style data table for the open document. Paste blocks from
 *  Excel/Prism (tab-separated), Enter/Tab/arrows to move, ⌘/Ctrl+Z to undo. */
export function DataGrid({ onPasted, maxHeight }: { onPasted: (r: PasteResult) => void; maxHeight: string }) {
  const template = useGraphStore((s) => s.doc?.template ?? "column");
  const nRep = useGraphStore((s) => (s.doc?.template === "column" ? 1 : s.doc?.n_rep ?? 1));
  const nCols = useGraphStore((s) => s.doc?.col_titles.length ?? 0);
  const nRows = useGraphStore((s) => s.doc?.cells.length ?? 0);
  const store = useGraphStore;
  const boxRef = useRef<HTMLDivElement>(null);
  const [colMenu, setColMenu] = useState<MenuState>(null);
  const [rowMenu, setRowMenu] = useState<MenuState>(null);
  const openColMenu = useCallback((el: HTMLElement, index: number) => setColMenu({ el, index, confirm: false }), []);
  const openRowMenu = useCallback((el: HTMLElement, index: number) => setRowMenu({ el, index, confirm: false }), []);

  const lead = template === "xy" ? "x" : template === "grouped" ? "rowtitle" : null;
  const nLead = leadCols(template).length;
  const nFlat = nLead + nCols * nRep;
  const w = nRep > 3 ? 60 : 72;

  /** The input at (row, flat column); on the title row, the title covering it. */
  const inputAt = (r: number, fc: number): HTMLInputElement | null => {
    const root = boxRef.current;
    if (!root || fc < 0 || fc >= nFlat || r < -1 || r >= nRows) return null;
    let target = fc;
    if (r === -1 && fc >= nLead) target = nLead + Math.floor((fc - nLead) / nRep) * nRep;
    return root.querySelector<HTMLInputElement>(`input[data-gr="${r}"][data-gc="${target}"]`);
  };

  const focusAt = (r: number, fc: number) => {
    const el = inputAt(r, fc);
    if (!el) return false;
    el.focus();
    el.select();
    return true;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    if (el.tagName !== "INPUT" || el.dataset.gr === undefined) return;
    const input = el as HTMLInputElement;
    const r = Number(input.dataset.gr), fc = Number(input.dataset.gc);
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "z") {
      if (store.getState().undo()) e.preventDefault();
      return;
    }
    if (mod || e.altKey) return;
    // On the title row a group title spans its replicate sub-columns.
    const span = r === -1 && fc >= nLead ? nRep : 1;
    const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
    const atEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
    let moved = false;
    switch (e.key) {
      case "Enter": focusAt(e.shiftKey ? r - 1 : r + 1, fc); moved = true; break;
      case "Tab": moved = focusAt(r, e.shiftKey ? fc - 1 : fc + span); break;
      case "ArrowUp": moved = focusAt(r - 1, fc); break;
      case "ArrowDown": moved = focusAt(r + 1, fc); break;
      case "ArrowLeft": if (atStart) moved = focusAt(r, fc - 1); break;
      case "ArrowRight": if (atEnd) moved = focusAt(r, fc + span); break;
      default: return;
    }
    if (moved) e.preventDefault();
  };

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    if (el.tagName !== "INPUT" || el.dataset.gr === undefined) return;
    const text = e.clipboardData.getData("text/plain");
    if (!isMultiPaste(text)) return; // a single value pastes normally
    e.preventDefault();
    const res = store.getState().paste({ row: Number(el.dataset.gr), fc: Number(el.dataset.gc) }, text);
    if (res) onPasted(res);
  };

  const doc = () => store.getState().doc!;
  const colAction = (fn: () => void) => { fn(); setColMenu(null); };
  const rowAction = (fn: () => void) => { fn(); setRowMenu(null); };
  const countCol = (c: number) => doc().cells.reduce((n, row) => n + (row[c] ?? []).filter((v) => v.trim() !== "").length, 0);
  const countRow = (r: number) =>
    (doc().cells[r] ?? []).reduce((n, reps) => n + reps.filter((v) => v.trim() !== "").length, 0)
    + (doc().row_titles[r]?.trim() ? 1 : 0) + (doc().x[r]?.trim() ? 1 : 0);

  const leadHeader = lead === "x" ? <XTitle />
    : lead === "rowtitle" ? <Typography variant="caption" color="text.secondary">Row title</Typography> : null;

  const rows = [];
  for (let r = 0; r < nRows; r++) {
    rows.push(<GridRow key={r} r={r} nCols={nCols} nRep={nRep} lead={lead} w={w}
      onRowMenu={openRowMenu} />);
  }

  const st = store.getState();
  const cm = colMenu, rm = rowMenu;
  return (
    <Box
      ref={boxRef}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      sx={{
        overflow: "auto",
        maxHeight,
        border: 1,
        borderColor: "divider",
        borderRadius: 1,
        alignSelf: "flex-start",
        maxWidth: "100%",
        "& table": { borderCollapse: "separate", borderSpacing: 0, fontSize: 12 },
        "& td, & th": { p: 0, borderRight: "1px solid #3a3a3c", borderBottom: "1px solid #3a3a3c", bgcolor: "#1f1f21" },
        "& thead th": { position: "sticky", top: 0, zIndex: 2, bgcolor: "#2c2c2e", height: H1, px: 0.5, fontWeight: 500 },
        "& thead tr.sub th": { top: H1, height: H2, color: "text.secondary", fontSize: 11 },
        "& .gutter": { position: "sticky", left: 0, zIndex: 1, width: GUTTER, minWidth: GUTTER, bgcolor: "#2c2c2e", textAlign: "center" },
        "& .lead": { position: "sticky", left: GUTTER, zIndex: 1, bgcolor: "#232325" },
        "& thead .gutter, & thead .lead": { zIndex: 3 },
        "& input": {
          height: 26, boxSizing: "border-box", px: 0.75, border: "1px solid transparent", outline: "none",
          bgcolor: "transparent", color: "text.primary", font: "inherit", fontVariantNumeric: "tabular-nums",
        },
        "& input:focus": { borderColor: "primary.main", bgcolor: "#2a3442" },
        "& input.invalid": { borderColor: "#ff453a", color: "#ff8a80" },
        "& input.title": { fontWeight: 600, textAlign: "left" },
        "& .rownum": {
          width: "100%", height: 26, border: 0, bgcolor: "transparent", color: "text.secondary", font: "inherit",
          fontSize: 11, cursor: "pointer", "&:hover": { color: "text.primary", bgcolor: "action.hover" },
        },
      }}
    >
      <table>
        <thead>
          <tr>
            <th className="gutter" rowSpan={nRep > 1 ? 2 : 1} />
            {lead && <th className="lead" rowSpan={nRep > 1 ? 2 : 1} style={{ width: LEAD_W }}>{leadHeader}</th>}
            {Array.from({ length: nCols }, (_, c) => (
              <th key={c} colSpan={nRep} style={{ minWidth: Math.max(w * nRep, 96) }}>
                <ColTitle c={c} fc={nLead + c * nRep} onMenu={openColMenu} />
              </th>
            ))}
          </tr>
          {nRep > 1 && (
            <tr className="sub">
              {Array.from({ length: nCols }, (_, c) =>
                Array.from({ length: nRep }, (_, k) => <th key={`${c}:${k}`}>{k + 1}</th>))}
            </tr>
          )}
        </thead>
        <tbody>{rows}</tbody>
      </table>

      <Menu anchorEl={cm?.el} open={!!cm} onClose={() => setColMenu(null)}>
        {cm && !cm.confirm && [
          <MenuItem key="l" dense disabled={nCols >= MAX_COLS} onClick={() => colAction(() => st.insertCol(cm.index))}>Insert column left</MenuItem>,
          <MenuItem key="r" dense disabled={nCols >= MAX_COLS} onClick={() => colAction(() => st.insertCol(cm.index + 1))}>Insert column right</MenuItem>,
          <Divider key="d" />,
          <MenuItem key="c" dense disabled={!colHasData(doc(), cm.index)} onClick={() => colAction(() => st.clearCol(cm.index))}>Clear values</MenuItem>,
          <MenuItem key="x" dense disabled={nCols <= 1} sx={{ color: "error.main" }}
            onClick={() => (colHasData(doc(), cm.index) ? setColMenu({ ...cm, confirm: true }) : colAction(() => st.deleteCol(cm.index)))}>
            Delete column
          </MenuItem>,
        ]}
        {cm?.confirm && [
          <MenuItem key="q" dense disabled sx={{ "&.Mui-disabled": { opacity: 1 } }}>
            Delete “{doc().col_titles[cm.index] || `column ${cm.index + 1}`}” and its {countCol(cm.index)} values?
          </MenuItem>,
          <MenuItem key="y" dense sx={{ color: "error.main" }} onClick={() => colAction(() => st.deleteCol(cm.index))}>Delete</MenuItem>,
          <MenuItem key="n" dense onClick={() => setColMenu(null)}>Cancel</MenuItem>,
        ]}
      </Menu>

      <Menu anchorEl={rm?.el} open={!!rm} onClose={() => setRowMenu(null)}>
        {rm && !rm.confirm && [
          <MenuItem key="a" dense disabled={nRows >= MAX_ROWS} onClick={() => rowAction(() => st.insertRow(rm.index))}>Insert row above</MenuItem>,
          <MenuItem key="b" dense disabled={nRows >= MAX_ROWS} onClick={() => rowAction(() => st.insertRow(rm.index + 1))}>Insert row below</MenuItem>,
          <Divider key="d" />,
          <MenuItem key="c" dense disabled={!rowHasData(doc(), rm.index)} onClick={() => rowAction(() => st.clearRow(rm.index))}>Clear row</MenuItem>,
          <MenuItem key="x" dense sx={{ color: "error.main" }}
            onClick={() => (rowHasData(doc(), rm.index) ? setRowMenu({ ...rm, confirm: true }) : rowAction(() => st.deleteRow(rm.index)))}>
            Delete row
          </MenuItem>,
        ]}
        {rm?.confirm && [
          <MenuItem key="q" dense disabled sx={{ "&.Mui-disabled": { opacity: 1 } }}>
            Delete row {rm.index + 1} and its {countRow(rm.index)} values?
          </MenuItem>,
          <MenuItem key="y" dense sx={{ color: "error.main" }} onClick={() => rowAction(() => st.deleteRow(rm.index))}>Delete</MenuItem>,
          <MenuItem key="n" dense onClick={() => setRowMenu(null)}>Cancel</MenuItem>,
        ]}
      </Menu>
    </Box>
  );
}
