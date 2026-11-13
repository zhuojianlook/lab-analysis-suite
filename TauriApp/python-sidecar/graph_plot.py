"""R (ggplot2) rendering for the Graphs tool.

Every number the figure shows — x positions, centre / error values, box
quartiles, fit lines, confidence bands and significance-bracket geometry — is
computed here in Python (with graph_stats) so the R script is purely
presentational and can't disagree with the statistics table.

Rules carried over from the qPCR plots (each one fixed a real bug there):
- R gets column / row INDICES, never names, in the CSV (read.csv turns a
  title "01" into 1 and "NA" into a missing value). Titles go into the script
  as escaped string literals.
- Every layer is drawn at an explicit lane x and uses position="identity"
  (geom_boxplot otherwise dodges and re-packs boxes off their lanes).
- Point jitter is seeded and never moves points vertically.
- Never name an R variable `bg` (it shadows mpfig_render's argument).
"""

from __future__ import annotations

import math
import re
from typing import Any, Dict, List, Optional

import numpy as np

import graph_stats as gs
import r_bridge

PALETTE = ["#4C72B0", "#DD8452", "#55A868", "#C44E52", "#8172B3",
           "#937860", "#DA8BC3", "#8C8C8C", "#CCB974", "#64B5CD"]

COLUMN_TYPES = ("dot", "bar", "box", "violin", "gbar", "gdot")
XY_TYPES = ("xy_points", "xy_line", "xy_fit")
CENTERS = ("mean_sd", "mean_sem", "mean_ci", "median_iqr")
_HEX = re.compile(r"^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$")
_R2 = "\x00R2\x00"   # placeholder for "R²" in equation labels (split out before escaping)
MAX_BRACKETS = 200    # more significance brackets than this are not drawn (unreadable)
_CTRL = re.compile(r"[\x00-\x1f\x7f]")


# ── R literal helpers (local copies; graph modules don't import qpcr) ───────

def _resc(s: Any) -> str:
    """Body of an R double-quoted string literal. NUL is dropped (R strings
    can't hold it, and a raw NUL ends R's source line, which would let the
    rest of the script be read inside out), lone surrogates become U+FFFD
    (they can't be written as UTF-8), every other control character is
    written as a \\uXXXX escape."""
    s = gs.clean_text(s).replace("\\", "\\\\").replace('"', '\\"')
    return _CTRL.sub(lambda m: "\\u%04x" % ord(m.group()), s)


def _r_vec(items: List[Any]) -> str:
    return "c(" + ", ".join(f'"{_resc(i)}"' for i in items) + ")"


def _r_num(x: Any) -> str:
    v = gs._num(x)
    return "NA" if v is None else repr(float(v))


def _r_nums(xs: List[Any]) -> str:
    return "c(" + ", ".join(_r_num(x) for x in xs) + ")"


def _theme_layer(theme: str, font_size: int) -> str:
    if theme == "classic":
        return f'p <- p + ggplot2::theme_classic(base_size={int(font_size)})\n'
    if theme == "minimal":
        return f'p <- p + ggplot2::theme_minimal(base_size={int(font_size)})\n'
    return (f'if (requireNamespace("ggprism", quietly=TRUE)) p <- p + ggprism::theme_prism(base_size={int(font_size)}) '
            f'else p <- p + ggplot2::theme_classic(base_size={int(font_size)})\n')


def _transparent_layer(transparent: bool) -> str:
    if not transparent:
        return ""
    return ("p <- p + ggplot2::theme(plot.background=ggplot2::element_rect(fill='transparent', colour=NA), "
            "panel.background=ggplot2::element_rect(fill='transparent', colour=NA), "
            "legend.background=ggplot2::element_rect(fill='transparent', colour=NA), "
            "legend.key=ggplot2::element_rect(fill='transparent', colour=NA))\n")


# ── figure settings ─────────────────────────────────────────────────────────

def _clamp(v, lo, hi, default):
    n = gs._num(v)
    if n is None:
        return default
    return min(hi, max(lo, n))


def _bool(v, default):
    return v if isinstance(v, bool) else default


def _str(v) -> str:
    return "" if v is None else str(v)


def normalize_figure(figure: Optional[dict], template: str, warnings: List[str]) -> dict:
    f = dict(figure) if isinstance(figure, dict) else {}   # junk / stale settings fall back to defaults
    gt = gs.clean_text(f.get("graph_type") or "")
    if template == "xy":
        if gt not in XY_TYPES:
            if gt:
                warnings.append(f"'{gt}' isn't an XY graph; drew points instead.")
            gt = "xy_points"
    else:
        gt = {"gbar": "bar", "gdot": "dot"}.get(gt, gt)
        if gt not in ("dot", "bar", "box", "violin"):
            if gt:
                warnings.append(f"'{gt}' isn't available for this table; drew bars instead.")
            gt = "bar"
    center = f.get("center") if f.get("center") in CENTERS else "mean_sd"
    return {
        "graph_type": gt, "center": center,
        "show_points": _bool(f.get("show_points"), False),
        "point_size": _clamp(f.get("point_size"), 0.2, 10, 1.8),
        "bar_width": _clamp(f.get("bar_width"), 0.1, 1.0, 0.7),
        "show_band": _bool(f.get("show_band"), True),
        "show_equation": _bool(f.get("show_equation"), False),
        "sig_show": f.get("sig_show") if f.get("sig_show") in ("significant", "all", "none") else "significant",
        "sig_label": f.get("sig_label") if f.get("sig_label") in ("stars", "p") else "stars",
        "title": _str(f.get("title")), "xlabel": f.get("xlabel"), "ylabel": _str(f.get("ylabel")),
        "font_size": int(_clamp(f.get("font_size"), 6, 40, 14)),
        "y_min": gs._num(f.get("y_min")), "y_max": gs._num(f.get("y_max")),
        "colors": f.get("colors") if isinstance(f.get("colors"), list) else [],
        "labels": f.get("labels") if isinstance(f.get("labels"), list) else [],
        "show_legend": _bool(f.get("show_legend"), template != "column"),
        "theme": f.get("theme") if f.get("theme") in ("prism", "classic", "minimal") else "prism",
        "width": int(_clamp(f.get("width"), 200, 8000, 1200)),
        "height": int(_clamp(f.get("height"), 200, 8000, 900)),
        "dpi": int(_clamp(f.get("dpi"), 50, 1200, 150)),
        "export_format": "tiff" if str(f.get("export_format") or "").lower() in ("tiff", "tif") else "png",
        "transparent": _bool(f.get("transparent"), False),
    }


def _colors(fig, n) -> List[str]:
    out = []
    for i in range(n):
        c = fig["colors"][i] if i < len(fig["colors"]) else None
        out.append(c if isinstance(c, str) and _HEX.match(c) else PALETTE[i % len(PALETTE)])
    return out


def _labels(fig, titles) -> List[str]:
    out = []
    for i, t in enumerate(titles):
        lab = fig["labels"][i] if i < len(fig["labels"]) else None
        out.append(lab if isinstance(lab, str) and lab.strip() else t)
    return out


def _center(d: dict, center: str):
    if center == "median_iqr":
        return d["median"], d["q1"], d["q3"]
    m = d["mean"]
    if m is None:
        return None, None, None
    if center == "mean_ci":
        return m, d["ci_lo"], d["ci_hi"]
    e = d["sem"] if center == "mean_sem" else d["sd"]
    if e is None:
        return m, None, None
    return m, m - e, m + e


def lane(cluster: int, j: int, S: int, bw: float) -> float:
    """Centre of lane j (1-based) of S in cluster `cluster` (1-based)."""
    return round(cluster + bw * ((2 * j - 1 - S) / (2.0 * S)), 6)


# ── entry ───────────────────────────────────────────────────────────────────

def _fail(msg: str, warnings: Optional[List[str]] = None) -> dict:
    return {"success": False, "stdout": "", "stderr": msg, "plots": [], "tables": [], "exports": [],
            "warnings": warnings or []}


def render(table: Optional[dict], analysis: Optional[dict], figure: Optional[dict],
           result: Optional[dict] = None) -> dict:
    warnings: List[str] = []
    try:
        tb = gs.normalize_table(table)
    except gs.InvalidAnalysis as e:
        return _fail(str(e))
    if result is None:
        result = gs.compute(table, analysis)
    if result.get("code") == "invalid":
        return _fail(result.get("error") or "Invalid analysis settings.")
    warnings.extend(result.get("warnings") or [])
    if result.get("error"):
        warnings.append(result["error"])
    try:
        an = gs.normalize_analysis(tb["template"], analysis)
    except gs.InvalidAnalysis as e:
        return _fail(str(e))
    fig = normalize_figure(figure, tb["template"], warnings)
    if not any(v for row in tb["values"] for v in row):
        return _fail("The table has no values to plot.", warnings)
    if tb["template"] == "xy":
        code, csv = _xy_code(tb, fig, result, warnings)
    else:
        code, csv = _column_code(tb, an, fig, result, warnings)
    if code is None:
        return _fail(csv, warnings)
    res = r_bridge.run_r(r_bridge.RunRRequest(code=code, data_csv=csv, timeout_sec=120))
    res = dict(res)
    res["warnings"] = warnings
    return res


def _csv(rows: List[dict], cols: List[str]) -> str:
    lines = [",".join(cols)]
    for r in rows:
        lines.append(",".join(_csv_num(r.get(c)) for c in cols))
    return "\n".join(lines) + "\n"


def _csv_num(v) -> str:
    n = gs._num(v)
    return "NA" if n is None else repr(float(n))


# ── Column / Grouped ────────────────────────────────────────────────────────

def _column_code(tb, an, fig, result, warnings):
    grouped = tb["template"] == "grouped"
    vals = tb["values"]
    n_rows, n_cols = tb["n_rows"], tb["n_cols"]
    if grouped:
        while n_rows > 0 and not any(vals[n_rows - 1]):
            n_rows -= 1
    ctitles = tb["col_titles"]
    labs = _labels(fig, ctitles)
    cols = _colors(fig, n_cols)
    bw = fig["bar_width"]
    gt = fig["graph_type"]
    show_pts = fig["show_points"] or gt == "dot"
    S = n_cols
    w = bw / S if grouped else bw

    elems, pts = [], []
    gid = 0
    clusters = range(n_rows) if grouped else [None]
    for r in clusters:
        for c in range(n_cols):
            v = vals[r][c] if grouped else [x for row in vals for x in row[c]]
            gid += 1
            if not v:
                continue
            xp = lane(r + 1, c + 1, S, bw) if grouped else float(c + 1)
            d = gs.describe(v)
            ctr, lo, hi = _center(d, fig["center"])
            vok = 1 if (gt != "violin" or d["n"] >= 3) else 0
            e = {"gid": gid, "ci": c + 1, "ri": (r + 1) if grouped else 0, "cluster": (r + 1) if grouped else (c + 1),
                 "xp": xp, "center": ctr, "lo": lo, "hi": hi, "q1": d["q1"], "med": d["median"], "q3": d["q3"],
                 "mn": d["min"], "mx": d["max"], "n": d["n"], "vok": vok, "d": d,
                 "rlabel": tb["row_titles"][r] if grouped else "", "clabel": ctitles[c]}
            elems.append(e)
            for y in v:
                pts.append({"kind": 0, "gid": gid, "ci": c + 1, "ri": e["ri"], "xp": xp, "y": y, "vok": vok})
    if not elems:
        return None, "The table has no values to plot."
    if gt == "violin" and any(e["vok"] == 0 for e in elems):
        warnings.append("Violins need at least 3 values; groups with fewer are shown as points.")

    # drawn extents (for brackets / axis limits)
    def top_of(e):
        if gt in ("box", "violin"):
            t = e["mx"]
        else:
            t = max(x for x in (e["center"], e["hi"]) if x is not None)
            if gt == "bar":
                t = max(t, 0.0)   # a bar spans value..0: brackets go above the baseline too
        if show_pts or (gt == "violin" and not e["vok"]):
            t = max(t, e["mx"])
        return t

    def bottom_of(e):
        if gt in ("box", "violin"):
            b = e["mn"]
        else:
            b = min(x for x in (e["center"], e["lo"]) if x is not None)
            if gt == "bar":
                b = min(b, 0.0)
        if show_pts:
            b = min(b, e["mn"])
        return b

    tops = {e["gid"]: top_of(e) for e in elems}
    data_top = max(tops.values())
    data_bot = min(bottom_of(e) for e in elems)
    if gt == "bar":
        data_bot = min(data_bot, 0.0)
    y_range = data_top - data_bot
    if not y_range or y_range <= 0:
        y_range = abs(data_top) or 1.0

    # significance brackets
    brackets = []
    if fig["sig_show"] != "none":
        by_key = {(e["ri"], e["ci"]): e for e in elems}
        for cmp_ in result.get("comparisons") or []:
            p = cmp_.get("p_adj")
            if p is None:
                continue
            star = cmp_.get("star") or "ns"
            if fig["sig_show"] == "significant" and star == "ns":
                continue
            a, b, row = cmp_.get("a"), cmp_.get("b"), cmp_.get("row")
            if grouped:
                if an["within"] == "rows":
                    ka, kb = (row + 1, a + 1), (row + 1, b + 1)
                else:
                    ka, kb = (a + 1, row + 1), (b + 1, row + 1)
            else:
                ka, kb = (0, a + 1), (0, b + 1)
            ea, eb = by_key.get(ka), by_key.get(kb)
            if ea is None or eb is None:
                continue
            if grouped:
                c_lo, c_hi = sorted((ea["cluster"], eb["cluster"]))
                top = max(tops[e["gid"]] for e in elems if c_lo <= e["cluster"] <= c_hi)
            else:
                top = data_top
            label = star if fig["sig_label"] == "stars" else gs.p_label(p)
            brackets.append({"x1": ea["xp"], "x2": eb["xp"], "top": top, "label": label})
    if len(brackets) > MAX_BRACKETS:
        warnings.append(f"{len(brackets)} significance brackets are too many to draw (the limit is {MAX_BRACKETS}); "
                        "the results table lists every comparison.")
        brackets = []
    brackets = gs.stack_brackets(brackets, y_range)
    top_all = max([data_top] + [b["y"] for b in brackets])

    ylim = None
    if fig["y_min"] is not None or fig["y_max"] is not None:
        lo = fig["y_min"] if fig["y_min"] is not None else (data_bot if gt == "bar" else data_bot - 0.05 * y_range)
        hi = fig["y_max"] if fig["y_max"] is not None else top_all + (0.08 * y_range if brackets else 0.05 * y_range)
        if hi <= lo:
            warnings.append("The Y axis maximum must be above the minimum; used automatic limits.")
        else:
            ylim = (lo, hi)

    # ── R script ──
    K = n_rows if grouped else n_cols
    xlabs = [tb["row_titles"][i] for i in range(n_rows)] if grouped else labs
    summ_cols = ["gid", "ci", "ri", "xp", "center", "lo", "hi", "q1", "med", "q3", "mn", "mx", "n"]
    summ = "data.frame(" + ", ".join(f"{k}={_r_nums([e[k] for e in elems])}" for k in summ_cols) + ")"
    ps = fig["point_size"]
    geom = ""
    if gt == "bar":
        geom = ('p <- p + ggplot2::geom_col(data=summ[!is.na(summ$center), , drop=FALSE], ggplot2::aes(x=xp, y=center, fill=f), '
                'position="identity", width=.w, colour="black", linewidth=0.3)\n'
                'if (nrow(summE) > 0) p <- p + ggplot2::geom_errorbar(data=summE, ggplot2::aes(x=xp, ymin=lo, ymax=hi), '
                'position="identity", width=.w * 0.35, linewidth=0.4)\n')
    elif gt == "dot":
        geom = ('if (nrow(summE) > 0) p <- p + ggplot2::geom_errorbar(data=summE, ggplot2::aes(x=xp, ymin=lo, ymax=hi), '
                'position="identity", width=.w * 0.35, linewidth=0.4)\n'
                'p <- p + ggplot2::geom_crossbar(data=summ[!is.na(summ$center), , drop=FALSE], ggplot2::aes(x=xp, y=center, ymin=center, ymax=center), '
                'position="identity", width=.w * 0.6, linewidth=0.4, colour="black")\n')
    elif gt == "box":
        geom = ('p <- p + ggplot2::geom_boxplot(data=summ, ggplot2::aes(x=xp, ymin=mn, lower=q1, middle=med, upper=q3, ymax=mx, group=gid, fill=f), '
                'stat="identity", position="identity", width=.w, colour="black", linewidth=0.3)\n')
    else:  # violin
        geom = ('datV <- dat[dat$vok == 1, , drop=FALSE]\n'
                'if (nrow(datV) > 0) p <- p + ggplot2::geom_violin(data=datV, ggplot2::aes(x=xp, y=y, group=gid, fill=f), '
                'position="identity", width=.w, trim=TRUE, scale="width", colour="black", linewidth=0.3)\n'
                'sV <- summ[summ$gid %in% datV$gid, , drop=FALSE]\n'
                'if (nrow(sV) > 0) p <- p + ggplot2::geom_crossbar(data=sV, ggplot2::aes(x=xp, y=med, ymin=med, ymax=med), '
                'position="identity", width=.w * 0.5, linewidth=0.4, colour="black")\n')
    pts_layer = ""
    if gt == "dot":
        pts_layer = (f'p <- p + ggplot2::geom_point(data=dat, ggplot2::aes(x=xp, y=y, fill=f), position=ggplot2::position_jitter(width=.w * 0.22, height=0, seed=1), '
                     f'shape=21, colour="black", stroke=0.4, size={ps})\n')
    elif show_pts:
        pts_layer = (f'p <- p + ggplot2::geom_point(data=dat, ggplot2::aes(x=xp, y=y), position=ggplot2::position_jitter(width=.w * 0.22, height=0, seed=1), '
                     f'shape=21, fill="white", colour="black", stroke=0.4, size={ps})\n')
    if gt == "violin" and not show_pts:
        pts_layer += (f'datP <- dat[dat$vok == 0, , drop=FALSE]\n'
                      f'if (nrow(datP) > 0) p <- p + ggplot2::geom_point(data=datP, ggplot2::aes(x=xp, y=y, fill=f), position=ggplot2::position_jitter(width=.w * 0.22, height=0, seed=1), '
                      f'shape=21, colour="black", stroke=0.4, size={ps})\n')

    coord = f"xlim=c(0.5, {K} + 0.5)"
    if ylim:
        coord += f", ylim=c({_r_num(ylim[0])}, {_r_num(ylim[1])})"
    yscale = ""
    if gt == "bar" and data_bot >= 0 and ylim is None:
        yscale = 'p <- p + ggplot2::scale_y_continuous(expand=ggplot2::expansion(mult=c(0, 0.05)))\n'
    bracket_block = ""
    if brackets:
        star_size = max(2, fig["font_size"] // 3)
        bracket_block = (
            f'bdf <- data.frame(x1={_r_nums([b["x1"] for b in brackets])}, x2={_r_nums([b["x2"] for b in brackets])}, '
            f'y={_r_nums([b["y"] for b in brackets])}, tick={_r_nums([b["tick"] for b in brackets])}, '
            f'label={_r_vec([b["label"] for b in brackets])}, stringsAsFactors=FALSE)\n'
            'p <- p + ggplot2::geom_segment(data=bdf, ggplot2::aes(x=x1, xend=x2, y=y, yend=y), inherit.aes=FALSE, linewidth=0.4) + '
            'ggplot2::geom_segment(data=bdf, ggplot2::aes(x=x1, xend=x1, y=y, yend=y - tick), inherit.aes=FALSE, linewidth=0.4) + '
            'ggplot2::geom_segment(data=bdf, ggplot2::aes(x=x2, xend=x2, y=y, yend=y - tick), inherit.aes=FALSE, linewidth=0.4) + '
            f'ggplot2::geom_text(data=bdf, ggplot2::aes(x=(x1 + x2) / 2, y=y, label=label), inherit.aes=FALSE, vjust=-0.25, size={star_size})\n'
            f'p <- p + ggplot2::expand_limits(y={_r_num(top_all + 0.06 * y_range)})\n'
        )
    angle = ('p <- p + ggplot2::theme(axis.text.x=ggplot2::element_text(angle=45, hjust=1, vjust=1))\n'
             if len(xlabs) > 8 else "")
    legend = "" if fig["show_legend"] else 'p <- p + ggplot2::theme(legend.position="none")\n'
    xlabel = _str(fig["xlabel"])

    # summary table (titles are R string literals, not CSV-parsed)
    tcols = []
    if grouped:
        tcols.append(("row", _r_vec([e["rlabel"] for e in elems])))
    tcols.append(("column", _r_vec([e["clabel"] for e in elems])))
    for k in ("n", "mean", "sd", "sem", "ci_lo", "ci_hi", "median", "q1", "q3", "min", "max"):
        tcols.append((k, _r_nums([e["d"][k] for e in elems])))
    table_df = "data.frame(" + ", ".join(f"{k}={v}" for k, v in tcols) + ", stringsAsFactors=FALSE, check.names=FALSE)"

    code = f"""
suppressMessages({{ library(ggplot2) }})
.cols <- {_r_vec(cols)}; names(.cols) <- as.character(seq_along(.cols))
.labs <- {_r_vec(labs)}
.w <- {_r_num(w)}
dat <- data[data$kind == 0, , drop=FALSE]
dat$f <- factor(dat$ci, levels=seq_along(.cols))
summ <- {summ}
summ$f <- factor(summ$ci, levels=seq_along(.cols))
summE <- summ[!is.na(summ$lo) & !is.na(summ$hi), , drop=FALSE]
p <- ggplot2::ggplot()
{geom}{pts_layer}p <- p + ggplot2::scale_fill_manual(values=.cols, labels=.labs, breaks=names(.cols), drop=FALSE, name=NULL)
p <- p + ggplot2::scale_x_continuous(breaks=seq_len({K}), labels={_r_vec(xlabs)}, expand=c(0, 0)) + ggplot2::coord_cartesian({coord})
{yscale}p <- p + ggplot2::labs(title="{_resc(fig['title'])}", x="{_resc(xlabel)}", y="{_resc(fig['ylabel'])}")
{_theme_layer(fig['theme'], fig['font_size'])}{angle}{legend}{bracket_block}{_transparent_layer(fig['transparent'])}mpfig_render(p, width={fig['width']}, height={fig['height']}, res={fig['dpi']}, format="{fig['export_format']}", bg="{'transparent' if fig['transparent'] else 'white'}")
mpfig_data({table_df}, "graph_summary")
"""
    csv = _csv(pts, ["kind", "gid", "ci", "ri", "xp", "x", "y", "lo", "hi", "vok"])
    return code, csv


# ── XY ──────────────────────────────────────────────────────────────────────

def _xy_code(tb, fig, result, warnings):
    vals, xs = tb["values"], tb["x"]
    n_cols = tb["n_cols"]
    titles = tb["col_titles"]
    labs = _labels(fig, titles)
    cols = _colors(fig, n_cols)
    gt = fig["graph_type"]
    rows, summ, eqs = [], [], []
    xs_used = [x for r, x in enumerate(xs) if x is not None and any(vals[r])]
    if not xs_used:
        return None, "No rows have both an X value and Y values."
    xspan = (max(xs_used) - min(xs_used)) or 1.0
    for c in range(n_cols):
        px, py = [], []
        for r in range(tb["n_rows"]):
            x = xs[r]
            if x is None or not vals[r][c]:
                continue
            d = gs.describe(vals[r][c])
            ctr, lo, hi = _center(d, fig["center"])
            summ.append({"ci": c + 1, "x": x, "center": ctr, "lo": lo, "hi": hi})
            for y in vals[r][c]:
                rows.append({"kind": 0, "ci": c + 1, "x": x, "y": y})
                px.append(x)
                py.append(y)
        if gt == "xy_fit" and len(px) >= 2:
            reg, band = gs.linreg(np.asarray(px, float), np.asarray(py, float))
            if reg["slope"] is None:
                warnings.append(f"{titles[c]}: {reg['note']}")
                continue
            gx = np.linspace(min(px), max(px), 101)
            gy = reg["intercept"] + reg["slope"] * gx
            for i in range(101):
                rows.append({"kind": 1, "ci": c + 1, "x": gx[i], "y": gy[i],
                             "lo": band["lo"][i] if band else None, "hi": band["hi"][i] if band else None})
            if fig["show_equation"]:
                r2 = reg["r2"]
                eq = reg["equation"] + (f", {_R2} = {r2:.4f}" if r2 is not None else "")
                eqs.append((f"{labs[c]}: " if n_cols > 1 else "") + eq)
        elif gt == "xy_fit":
            warnings.append(f"{titles[c]}: needs at least 2 points for a line.")

    def _vec(key, src):
        return _r_nums([s.get(key) for s in src])

    summ_df = "data.frame(" + ", ".join(f"{k}={_vec(k, summ)}" for k in ("ci", "x", "center", "lo", "hi")) + ")"
    ps = fig["point_size"]
    layers = ""
    if gt == "xy_fit":
        if fig["show_band"]:
            layers += ('fb <- fitd[!is.na(fitd$lo), , drop=FALSE]\n'
                       'if (nrow(fb) > 0) p <- p + ggplot2::geom_ribbon(data=fb, ggplot2::aes(x=x, ymin=lo, ymax=hi, fill=f, group=f), alpha=0.15, colour=NA)\n')
        layers += 'if (nrow(fitd) > 0) p <- p + ggplot2::geom_line(data=fitd, ggplot2::aes(x=x, y=y, colour=f, group=f), linewidth=0.8)\n'
    if gt == "xy_line":
        layers += 'p <- p + ggplot2::geom_line(data=summ[!is.na(summ$center), , drop=FALSE], ggplot2::aes(x=x, y=center, colour=f, group=f), linewidth=0.7)\n'
    if fig["show_points"]:
        layers += (f'p <- p + ggplot2::geom_point(data=dat, ggplot2::aes(x=x, y=y, fill=f), shape=21, colour="black", stroke=0.4, size={ps})\n')
    else:
        layers += (f'if (nrow(summE) > 0) p <- p + ggplot2::geom_errorbar(data=summE, ggplot2::aes(x=x, ymin=lo, ymax=hi, colour=f), width={_r_num(xspan * 0.02)}, linewidth=0.4)\n'
                   f'p <- p + ggplot2::geom_point(data=summ[!is.na(summ$center), , drop=FALSE], ggplot2::aes(x=x, y=center, fill=f), shape=21, colour="black", stroke=0.4, size={ps})\n')
    if eqs:
        # R² via an R "²" escape so the script stays ASCII whatever R's locale.
        label = "R\\u00b2".join(_resc(part) for part in "\n".join(eqs).split(_R2))
        layers += (f'p <- p + ggplot2::annotate("text", x=-Inf, y=Inf, hjust=-0.05, vjust=1.3, '
                   f'label="{label}", size={max(2, fig["font_size"] // 4)})\n')
    coord = ""
    if fig["y_min"] is not None or fig["y_max"] is not None:
        ys = [r["y"] for r in rows if r.get("y") is not None] + [s["hi"] for s in summ if s["hi"] is not None] + \
             [s["lo"] for s in summ if s["lo"] is not None]
        ymn, ymx = min(ys), max(ys)
        pad = 0.05 * ((ymx - ymn) or 1.0)
        lo = fig["y_min"] if fig["y_min"] is not None else ymn - pad
        hi = fig["y_max"] if fig["y_max"] is not None else ymx + pad
        if hi > lo:
            coord = f'p <- p + ggplot2::coord_cartesian(ylim=c({_r_num(lo)}, {_r_num(hi)}))\n'
        else:
            warnings.append("The Y axis maximum must be above the minimum; used automatic limits.")
    legend = "" if fig["show_legend"] else 'p <- p + ggplot2::theme(legend.position="none")\n'
    xlabel = tb["x_title"] if fig["xlabel"] is None else _str(fig["xlabel"])
    sub = [s for s in summ]
    table_df = ("data.frame(series=" + _r_vec([titles[s["ci"] - 1] for s in sub]) + ", x=" + _vec("x", sub) +
                ", center=" + _vec("center", sub) + ", lo=" + _vec("lo", sub) + ", hi=" + _vec("hi", sub) +
                ", stringsAsFactors=FALSE)")
    code = f"""
suppressMessages({{ library(ggplot2) }})
.cols <- {_r_vec(cols)}; names(.cols) <- as.character(seq_along(.cols))
.labs <- {_r_vec(labs)}
dat <- data[data$kind == 0, , drop=FALSE]
dat$f <- factor(dat$ci, levels=seq_along(.cols))
fitd <- data[data$kind == 1, , drop=FALSE]
fitd$f <- factor(fitd$ci, levels=seq_along(.cols))
summ <- {summ_df}
summ$f <- factor(summ$ci, levels=seq_along(.cols))
summE <- summ[!is.na(summ$lo) & !is.na(summ$hi), , drop=FALSE]
p <- ggplot2::ggplot()
{layers}p <- p + ggplot2::scale_fill_manual(values=.cols, labels=.labs, breaks=names(.cols), drop=FALSE, name=NULL, aesthetics=c("colour", "fill"))
{coord}p <- p + ggplot2::labs(title="{_resc(fig['title'])}", x="{_resc(xlabel)}", y="{_resc(fig['ylabel'])}")
{_theme_layer(fig['theme'], fig['font_size'])}{legend}{_transparent_layer(fig['transparent'])}mpfig_render(p, width={fig['width']}, height={fig['height']}, res={fig['dpi']}, format="{fig['export_format']}", bg="{'transparent' if fig['transparent'] else 'white'}")
mpfig_data({table_df}, "graph_summary")
"""
    csv = _csv(rows, ["kind", "ci", "x", "y", "lo", "hi"])
    return code, csv
