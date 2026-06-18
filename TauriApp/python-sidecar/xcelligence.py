"""xCELLigence E-Plate 96 impedance analysis.

Ported from the standalone Streamlit xCELLigence app: parse the Layout + Cell
Index sheets of an .xlsx export, normalize to a reference sample, ratio-to-
baseline, quarter-hour-align the time index, aggregate replicates, and render a
time-course line graph + an endpoint bar chart (ANOVA + Tukey) in ggplot2.

Parsed data is cached server-side under a session token so the (potentially
large) impedance tables aren't shuttled back and forth between steps.
"""

from __future__ import annotations

import io
import uuid
from typing import Dict, List, Optional

import numpy as np
import pandas as pd
from fastapi import APIRouter, File, UploadFile
from pydantic import BaseModel
from scipy import stats
from statsmodels.stats.multicomp import pairwise_tukeyhsd

import r_bridge

router = APIRouter()

_SESSIONS: Dict[str, dict] = {}


# ── Parsing ─────────────────────────────────────────────────────────────────

def _well_sample_mapping(layout_df: pd.DataFrame) -> Dict[str, Optional[str]]:
    mapping: Dict[str, Optional[str]] = {}
    for _, row in layout_df.iterrows():
        row_label = row.iloc[0]
        for col_index, cell in enumerate(row.iloc[1:], start=1):
            well = f"{row_label}{layout_df.columns[col_index]}"
            mapping[well] = str(cell).strip() if pd.notnull(cell) else None
    return mapping


def _process_blocks(cell_index_df: pd.DataFrame, mapping: Dict[str, Optional[str]]) -> pd.DataFrame:
    """Return a wide pivot: index = Time (s), columns = 'Sample - Well'."""
    col0 = cell_index_df.iloc[:, 0].astype(str)
    starts = cell_index_df[col0.str.startswith("Cell Index at: ", na=False)].index[2:]
    blocks = []
    for ri in starts:
        tp = str(cell_index_df.iloc[ri, 0]).replace("Cell Index at: ", "")
        secs = pd.to_timedelta(tp).total_seconds()
        block = cell_index_df.iloc[ri + 2: ri + 10, 1:13].copy()
        block.columns = range(1, 13)
        block.index = list("ABCDEFGH")
        block = block.stack().reset_index()
        block.columns = ["Row", "Column", "Value"]
        block["Well"] = block["Row"] + block["Column"].astype(str)
        block["Sample"] = block["Well"].map(mapping)
        block = block.dropna(subset=["Sample"])
        block["Value"] = pd.to_numeric(block["Value"], errors="coerce")
        block["Time"] = secs
        block["Sample_Well"] = block["Sample"] + " - " + block["Well"]
        blocks.append(block)
    if not blocks:
        return pd.DataFrame()
    combined = pd.concat(blocks).sort_values("Time")
    pivot = combined.pivot(index="Time", columns="Sample_Well", values="Value")
    cols = sorted(pivot.columns, key=lambda x: (x.split(" - ")[0], x.split(" - ")[1]))
    return pivot[cols]


def _round_quarter_hours(seconds: float) -> float:
    minutes = seconds // 60
    rem = minutes % 15
    minutes = minutes - rem if rem < 7.5 else minutes + (15 - rem)
    return round(minutes / 60.0, 4)


def _samples_of(cols: List[str]) -> List[str]:
    return sorted({c.split(" - ")[0] for c in cols if " - " in c})


@router.post("/api/xcelligence/upload")
async def upload(files: List[UploadFile] = File(...)):
    parsed = []
    errors = []
    for f in files:
        try:
            data = await f.read()
            layout = pd.read_excel(io.BytesIO(data), sheet_name="Layout")
            cidx = pd.read_excel(io.BytesIO(data), sheet_name="Cell Index")
            pivot = _process_blocks(cidx, _well_sample_mapping(layout))
            if pivot.empty:
                errors.append(f"{f.filename}: no Cell Index blocks found.")
                continue
            parsed.append({"name": f.filename, "pivot": pivot})
        except Exception as e:  # noqa: BLE001
            errors.append(f"{f.filename}: {e}")
    if not parsed:
        return {"token": None, "files": [], "errors": errors or ["No valid files."]}
    token = uuid.uuid4().hex[:12]
    _SESSIONS[token] = {"parsed": parsed}
    files_out = [{
        "name": p["name"],
        "samples": _samples_of(list(p["pivot"].columns)),
        "wells": list(p["pivot"].columns),
        "n_timepoints": int(p["pivot"].shape[0]),
    } for p in parsed]
    return {"token": token, "files": files_out, "errors": errors}


# ── Normalize / ratio / aggregate ───────────────────────────────────────────

class FileParams(BaseModel):
    name: str
    drop_wells: List[str] = []
    normalize_sample: str
    base_time_h: float = 0.0


class ProcessRequest(BaseModel):
    token: str
    params: List[FileParams]


def _process_file(pivot: pd.DataFrame, p: FileParams) -> pd.DataFrame:
    df = pivot.drop(columns=[c for c in p.drop_wells if c in pivot.columns]).copy()
    # adjust time → hours, quarter-hour rounded, zeroed to first reading
    t0 = df.index[0]
    df.index = [(_round_quarter_hours(t - t0)) for t in df.index]
    df.index.name = "Time_h"
    # Bin readings that fall in the same quarter-hour bucket (instruments that
    # sample more often than every 15 min produce several rows per bucket).
    # Averaging both performs the quarter-hour alignment and guarantees a unique
    # index — without this, duplicate index labels make every downstream
    # `.loc[t]` / `.at[t, col]` return a Series and crash the analysis.
    if not df.index.is_unique:
        df = df.groupby(level=0).mean()
    df = df.sort_index()
    df.index.name = "Time_h"
    # normalize: subtract the reference sample's per-timepoint mean
    ref_cols = [c for c in df.columns if c.split(" - ")[0] == p.normalize_sample]
    if ref_cols:
        ref_mean = df[ref_cols].mean(axis=1)
        df = df.sub(ref_mean, axis=0)
    # ratio to baseline row (closest adjusted time)
    if len(df.index):
        base_idx = int(np.argmin([abs(t - p.base_time_h) for t in df.index]))
        base_row = df.iloc[base_idx].replace(0, np.nan)
        df = df.div(base_row, axis=1)
    return df


@router.post("/api/xcelligence/process")
def process(body: ProcessRequest):
    sess = _SESSIONS.get(body.token)
    if not sess:
        return {"error": "Session expired — please re-upload."}
    param_by_name = {p.name: p for p in body.params}
    frames = []
    for p in sess["parsed"]:
        fp = param_by_name.get(p["name"])
        if not fp:
            continue
        frames.append(_process_file(p["pivot"], fp))
    if not frames:
        return {"error": "No files processed."}
    combined = frames[0]
    for fr in frames[1:]:
        combined = combined.join(fr, how="outer", lsuffix="", rsuffix="_dup")
    combined = combined.sort_index()

    well_cols = [c for c in combined.columns if " - " in c]
    samples = _samples_of(well_cols)
    summary_rows = []
    for s in samples:
        scols = [c for c in well_cols if c.split(" - ")[0] == s]
        m = combined[scols].mean(axis=1)
        sd = combined[scols].std(axis=1)
        for t in combined.index:
            summary_rows.append({"Time_h": float(t), "Sample": s,
                                 "mean": float(m.loc[t]) if pd.notnull(m.loc[t]) else None,
                                 "sd": float(sd.loc[t]) if pd.notnull(sd.loc[t]) else 0.0})

    sess["combined"] = combined
    sess["well_cols"] = well_cols
    return {
        "samples": samples,
        "times_h": [float(t) for t in combined.index],
        "summary": summary_rows,
        "n_wells": len(well_cols),
    }


# ── Endpoint bar stats (ANOVA + Tukey at a timepoint) ───────────────────────

def _stars(p: float) -> str:
    if p < 0.00005:
        return "****"
    if p < 0.0005:
        return "***"
    if p < 0.005:
        return "**"
    if p < 0.05:
        return "*"
    return "ns"


class BarStatsRequest(BaseModel):
    token: str
    time_h: float
    samples: List[str]


@router.post("/api/xcelligence/bar-stats")
def bar_stats(body: BarStatsRequest):
    sess = _SESSIONS.get(body.token)
    if not sess or "combined" not in sess:
        return {"error": "Run processing first."}
    combined = sess["combined"]
    # nearest available time row
    t = min(combined.index, key=lambda x: abs(x - body.time_h))
    well_cols = sess["well_cols"]
    reps = []
    for s in body.samples:
        for c in [c for c in well_cols if c.split(" - ")[0] == s]:
            v = combined.at[t, c]
            if pd.notnull(v):
                reps.append({"Sample": s, "Well": c.split(" - ")[1], "Value": float(v)})
    rep_df = pd.DataFrame(reps)
    if rep_df.empty:
        return {"error": "No replicate data at this timepoint."}
    summ = rep_df.groupby("Sample")["Value"].agg(["mean", "std", "count"]).reset_index()
    summ.columns = ["Sample", "mean", "sd", "n"]

    comparisons = []
    groups = [rep_df[rep_df["Sample"] == s]["Value"].dropna().values for s in body.samples]
    groups = [g for g in groups if len(g) > 0]
    if len(groups) > 1:
        try:
            f, p = stats.f_oneway(*groups)
            if p < 0.05:
                flat = np.concatenate(groups)
                labels = np.concatenate([[s] * len(g) for s, g in zip(body.samples, groups)])
                tuk = pairwise_tukeyhsd(flat, labels, 0.05)
                for row in tuk.summary().data[1:]:
                    g1, g2, md, padj, lo, hi, rej = row
                    comparisons.append({"group1": str(g1), "group2": str(g2),
                                        "p": float(padj), "star": _stars(float(padj)), "reject": bool(rej)})
        except Exception:  # noqa: BLE001
            pass
    return {"time_h": float(t), "replicates": reps, "summary": summ.to_dict("records"),
            "comparisons": comparisons}


# ── Plots (ggplot2 via the R bridge) ────────────────────────────────────────

def _resc(s: str) -> str:
    return str(s).replace("\\", "\\\\").replace('"', '\\"')


def _r_vec(items: List[str]) -> str:
    return "c(" + ", ".join(f'"{_resc(i)}"' for i in items) + ")"


class LinePlotRequest(BaseModel):
    token: str
    samples: List[str]
    colors: Dict[str, str] = {}
    labels: Dict[str, str] = {}
    show_sd: bool = True
    title: str = "Normalized Cell Index vs Time"
    xlabel: str = "Time (Hours)"
    ylabel: str = "Normalized Cell Index"
    width: int = 1400
    height: int = 800
    dpi: int = 150
    export_format: str = "png"                 # png | tiff
    transparent: bool = False


def _export_bits(export_format: str, transparent: bool):
    """Return (export_fmt, bg, transparent_theme_suffix) for the R template."""
    fmt = "tiff" if str(export_format).lower() in ("tiff", "tif") else "png"
    bg = "transparent" if transparent else "white"
    suffix = (
        " + theme(plot.background=element_rect(fill='transparent', colour=NA), "
        "panel.background=element_rect(fill='transparent', colour=NA), "
        "legend.background=element_rect(fill='transparent', colour=NA), "
        "legend.box.background=element_rect(fill='transparent', colour=NA), "
        "legend.key=element_rect(fill='transparent', colour=NA))"
        if transparent else ""
    )
    return fmt, bg, suffix


@router.post("/api/xcelligence/plot-line")
def plot_line(body: LinePlotRequest):
    sess = _SESSIONS.get(body.token)
    if not sess or "combined" not in sess:
        return {"success": False, "stderr": "Run processing first.", "plots": []}
    combined = sess["combined"]
    well_cols = sess["well_cols"]
    rows = []
    for s in body.samples:
        scols = [c for c in well_cols if c.split(" - ")[0] == s]
        m = combined[scols].mean(axis=1)
        sd = combined[scols].std(axis=1)
        for t in combined.index:
            if pd.notnull(m.loc[t]):
                rows.append({"Time_h": float(t), "Sample": s,
                             "mean": float(m.loc[t]), "sd": float(sd.loc[t]) if pd.notnull(sd.loc[t]) else 0.0})
    df = pd.DataFrame(rows)
    if df.empty:
        return {"success": False, "stderr": "No data for selected samples.", "plots": []}

    colors = [body.colors.get(s, "#5a7fa8") for s in body.samples]
    labels = [body.labels.get(s, s) for s in body.samples]
    export_fmt, bg, transparent_theme = _export_bits(body.export_format, body.transparent)
    ribbon = (
        "  geom_ribbon(aes(ymin=mean-sd, ymax=mean+sd, fill=Sample), alpha=0.18, colour=NA) +\n"
        if body.show_sd else ""
    )
    code = f"""
library(ggplot2)
data$Sample <- factor(data$Sample, levels={_r_vec(body.samples)})
.cols <- {_r_vec(colors)}; names(.cols) <- {_r_vec(body.samples)}
.labs <- {_r_vec(labels)}
p <- ggplot(data, aes(x=Time_h, y=mean, colour=Sample)) +
{ribbon}  geom_line(linewidth=0.7) + geom_point(size=1.6) +
  scale_colour_manual(values=.cols, labels=.labs) +
  scale_fill_manual(values=.cols, labels=.labs) +
  labs(title="{_resc(body.title)}", x="{_resc(body.xlabel)}", y="{_resc(body.ylabel)}", colour=NULL, fill=NULL) +
  theme_classic(base_size=14) + theme(legend.position="bottom")
p <- p{transparent_theme}
mpfig_render(p, width={int(body.width)}, height={int(body.height)}, res={int(body.dpi)}, format="{export_fmt}", bg="{bg}")
mpfig_data(data, "xcelligence_line_data")
"""
    return r_bridge.run_r(r_bridge.RunRRequest(code=code, data_csv=df.to_csv(index=False), timeout_sec=120))


class BarPlotRequest(BaseModel):
    summary: List[dict]                 # [{Sample, mean, sd, n}]
    replicates: List[dict]              # [{Sample, Well, Value}]
    comparisons: List[dict] = []        # [{group1, group2, p, star}]
    sample_order: List[str]
    colors: Dict[str, str] = {}
    labels: Dict[str, str] = {}
    title: str = "Endpoint comparison"
    xlabel: str = "Condition"
    ylabel: str = "Normalized Cell Index"
    width: int = 1200
    height: int = 800
    dpi: int = 150
    export_format: str = "png"                 # png | tiff
    transparent: bool = False


@router.post("/api/xcelligence/plot-bar")
def plot_bar(body: BarPlotRequest):
    sdf = pd.DataFrame(body.summary)
    if sdf.empty:
        return {"success": False, "stderr": "No summary to plot.", "plots": []}
    idx = {s: i + 1 for i, s in enumerate(body.sample_order)}
    base = float((sdf["mean"] + sdf["sd"].fillna(0)).max()) or 1.0
    step = base * 0.08
    brackets = []
    k = 0
    for c in body.comparisons:
        if c.get("star", "ns") == "ns":
            continue
        if c["group1"] in idx and c["group2"] in idx:
            brackets.append((idx[c["group1"]], idx[c["group2"]], base * 1.05 + k * step, c["star"]))
            k += 1

    colors = [body.colors.get(s, "#5a7fa8") for s in body.sample_order]
    labels = [body.labels.get(s, s) for s in body.sample_order]
    export_fmt, bg, transparent_theme = _export_bits(body.export_format, body.transparent)
    rep_df = pd.DataFrame(body.replicates)
    rep_csv_inline = ""
    if not rep_df.empty:
        rs = _r_vec(list(rep_df["Sample"]))
        rv = "c(" + ", ".join(f"{float(v):.6f}" for v in rep_df["Value"]) + ")"
        rep_csv_inline = (
            f"rep <- data.frame(Sample=factor({rs}, levels={_r_vec(body.sample_order)}), Value={rv})\n"
            "p <- p + geom_jitter(data=rep, aes(x=Sample, y=Value), width=0.12, size=1.4, colour='black', fill='white', shape=21, inherit.aes=FALSE)\n"
        )
    if brackets:
        bx1 = "c(" + ", ".join(str(b[0]) for b in brackets) + ")"
        bx2 = "c(" + ", ".join(str(b[1]) for b in brackets) + ")"
        by = "c(" + ", ".join(f"{b[2]:.6f}" for b in brackets) + ")"
        bl = _r_vec([b[3] for b in brackets])
        bracket_block = (
            f"bdf <- data.frame(x1={bx1}, x2={bx2}, y={by}, label={bl})\n"
            "p <- p + geom_segment(data=bdf, aes(x=x1, xend=x2, y=y, yend=y), inherit.aes=FALSE, linewidth=0.4) +\n"
            "  geom_text(data=bdf, aes(x=(x1+x2)/2, y=y, label=label), inherit.aes=FALSE, vjust=-0.2, size=5)\n"
        )
    else:
        bracket_block = ""

    code = f"""
library(ggplot2)
data$Sample <- factor(data$Sample, levels={_r_vec(body.sample_order)})
.cols <- {_r_vec(colors)}; names(.cols) <- {_r_vec(body.sample_order)}
.labs <- {_r_vec(labels)}
p <- ggplot(data, aes(x=Sample, y=mean, fill=Sample)) +
  geom_col(width=0.7, colour="black", linewidth=0.3, alpha=0.8) +
  geom_errorbar(aes(ymin=mean-sd, ymax=mean+sd), width=0.25, linewidth=0.4) +
  scale_fill_manual(values=.cols, labels=.labs) +
  labs(title="{_resc(body.title)}", x="{_resc(body.xlabel)}", y="{_resc(body.ylabel)}", fill=NULL) +
  theme_classic(base_size=14) + theme(axis.text.x=element_text(angle=45, hjust=1))
{rep_csv_inline}{bracket_block}
p <- p{transparent_theme}
mpfig_render(p, width={int(body.width)}, height={int(body.height)}, res={int(body.dpi)}, format="{export_fmt}", bg="{bg}")
mpfig_data(data, "xcelligence_bar_data")
"""
    return r_bridge.run_r(r_bridge.RunRRequest(code=code, data_csv=sdf.to_csv(index=False), timeout_sec=120))
