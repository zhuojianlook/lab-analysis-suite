"""qPCR ΔΔCt analysis.

Ported from the standalone Streamlit qPCR app: parse paired LightCycler
`*_qpcr.txt` (Cp per well) + `*_platemap.txt` (well -> Gene + Sample), compute
ΔΔCt fold-change, run t-test or ANOVA+Tukey, and render a ggplot2 chart with
error bars + significance brackets. The default layout puts all genes on a
single graph (genes on the x-axis, bars/violins dodged by sample); a faceted
(one panel per gene) layout is also available. Bracket geometry — including the
dodged x-positions for the grouped layout — is computed here so the R template
stays purely presentational.
"""

from __future__ import annotations

import io
import math
from typing import Dict, List, Optional

import numpy as np
import pandas as pd
from fastapi import APIRouter, File, UploadFile
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool
from scipy.stats import ttest_ind
from statsmodels.formula.api import ols
from statsmodels.stats.multicomp import pairwise_tukeyhsd

import qpcr_library
import r_bridge

router = APIRouter()

# LightCycler export columns to drop (Include, Color, Concentration, Standard, Status)
QPCR_DROP_COLS = [0, 1, 5, 6, 7]


# ── Parsing ─────────────────────────────────────────────────────────────────

def _parse_pair_wells(qpcr_bytes: bytes, platemap_bytes: bytes) -> pd.DataFrame:
    """Every plate-mapped well with its position and Cp (NaN = undetermined),
    unfiltered — what the run library stores."""
    dq = pd.read_csv(io.BytesIO(qpcr_bytes), sep="\t", skiprows=1)
    dq = dq.drop(dq.columns[QPCR_DROP_COLS], axis=1)
    # Plate-map labels are text: read them as such so an all-numeric Sample
    # column doesn't become "1.0" in one run and "1" in another, and a sample
    # literally named "NA" isn't read as missing.
    dl = pd.read_csv(io.BytesIO(platemap_bytes), sep="\t", dtype=str, keep_default_na=False, na_values=[""])
    if "Cell Position" in dl.columns:
        dl = dl.rename(columns={"Cell Position": "Pos"})
    dq["Pos"] = dq["Pos"].astype(str).str.strip()
    dl["Pos"] = dl["Pos"].str.strip()
    merged = pd.merge(dq, dl, on="Pos", how="inner").dropna(subset=["Sample", "Gene"])
    merged["Sample"] = merged["Sample"].str.strip()
    merged["Gene"] = merged["Gene"].str.strip()
    merged = merged[(merged["Sample"] != "") & (merged["Gene"] != "")]
    merged["Cp"] = pd.to_numeric(merged["Cp"], errors="coerce")
    return merged.rename(columns={"Pos": "Well"})[["Well", "Sample", "Gene", "Cp"]].reset_index(drop=True)


def _parse_pair(qpcr_bytes: bytes, platemap_bytes: bytes, drop_high_cp: bool) -> pd.DataFrame:
    df = _parse_pair_wells(qpcr_bytes, platemap_bytes).dropna(subset=["Cp"])
    if drop_high_cp:
        df = df[df["Cp"] < 35]
    return df[["Sample", "Gene", "Cp"]].reset_index(drop=True)


def _records(df: pd.DataFrame) -> List[dict]:
    """DataFrame -> JSON-safe records (NaN/inf -> None; JSON has no NaN, and an
    SD over a single replicate is NaN)."""
    clean = df.replace([np.inf, -np.inf], np.nan)
    return clean.astype(object).where(clean.notna(), None).to_dict("records")


async def _read_pairs(files: List[UploadFile]):
    """Group uploaded files into LightCycler pairs by stem. Returns
    ({stem: (qpcr_bytes, platemap_bytes)}, [unpaired file names], [errors]).
    A stem given twice in one drop (e.g. same-named files from two folders) is
    rejected rather than pairing one experiment's Cp with another's plate map."""
    qpcr_files: Dict[str, bytes] = {}
    plate_files: Dict[str, bytes] = {}
    names: Dict[str, str] = {}
    dupes = set()
    for f in files:
        data = await f.read()
        name = f.filename or ""
        stem = _stem(name)
        if name.endswith("_platemap.txt"):
            target = plate_files
        elif name.endswith("_qpcr.txt"):
            target = qpcr_files
        else:
            continue
        if stem in target:
            dupes.add(stem)
        target[stem] = data
        names.setdefault(stem, name)
    errors = [f"{s}: more than one file with this name in the drop — add them separately" for s in sorted(dupes)]
    paired = {s: (qpcr_files[s], plate_files[s]) for s in sorted(set(qpcr_files) & set(plate_files)) if s not in dupes}
    unpaired = sorted(names[s] for s in (set(qpcr_files) ^ set(plate_files)) if s not in dupes)
    return paired, unpaired, errors


def _stem(name: str) -> str:
    base = name.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    return base.replace("_qpcr.txt", "").replace("_platemap.txt", "")


@router.post("/api/qpcr/upload")
async def upload(files: List[UploadFile] = File(...), drop_high_cp: bool = False):
    paired, _unpaired, errors = await _read_pairs(files)
    pairs = []
    for stem, (qb, pb) in paired.items():
        try:
            df = _parse_pair(qb, pb, drop_high_cp)
            pairs.append({"name": stem, "records": df.to_dict("records"), "n_rows": len(df)})
        except Exception as e:  # noqa: BLE001
            errors.append(f"{stem}: {e}")

    if not pairs:
        return {"pairs": [], "genes_common": [], "genes_all": [], "samples": [],
                "errors": errors or ["No matching *_qpcr.txt / *_platemap.txt pairs found."]}

    gene_sets = [set(p["records"] and pd.DataFrame(p["records"])["Gene"].unique()) for p in pairs]
    genes_common = sorted(set.intersection(*gene_sets)) if gene_sets else []
    genes_all = sorted(set.union(*gene_sets)) if gene_sets else []
    samples = sorted({r["Sample"] for p in pairs for r in p["records"]})
    return {"pairs": pairs, "genes_common": genes_common, "genes_all": genes_all,
            "samples": samples, "errors": errors}


# ── Run library (persistent; see qpcr_library) ──────────────────────────────

def _library() -> dict:
    return {"runs": qpcr_library.list_runs(), "path": qpcr_library.db_path()}


@router.get("/api/qpcr/library")
def library():
    return _library()


def _store_pairs(paired: Dict[str, tuple]):
    added, replaced, errors = [], [], []
    for stem, (qb, pb) in paired.items():
        try:
            wells = _parse_pair_wells(qb, pb)
            if wells.empty:
                errors.append(f"{stem}: no wells matched the plate map")
                continue
            (replaced if qpcr_library.save_run(stem, "lightcycler", wells) else added).append(stem)
        except Exception as e:  # noqa: BLE001
            errors.append(f"{stem}: {e}")
    return added, replaced, errors


@router.post("/api/qpcr/library/import")
async def library_import(files: List[UploadFile] = File(...)):
    """Parse LightCycler pairs and store them (same run name replaces)."""
    paired, unpaired, errors = await _read_pairs(files)
    # Parsing + SQLite writes are blocking; keep them off the event loop so a
    # slow or locked database can't stall /api/health or other requests.
    added, replaced, store_errors = await run_in_threadpool(_store_pairs, paired)
    lib = await run_in_threadpool(_library)
    return {"added": added, "replaced": replaced, "unpaired": unpaired, "errors": errors + store_errors, **lib}


class ManualRunRequest(BaseModel):
    name: str
    records: List[dict]             # [{Well?, Sample, Gene, Cp}]


@router.post("/api/qpcr/library/manual")
def library_manual(body: ManualRunRequest):
    name = body.name.strip()
    if not name:
        return {"error": "Give the plate a name."}
    df = pd.DataFrame(body.records)
    if df.empty:
        return {"error": "No complete wells (each needs Gene + Sample + Cp)."}
    existing = qpcr_library.find_run(name)
    if existing and existing["source"] != "manual":
        return {"error": f"An imported run is already called \"{name}\" — choose another name for this plate."}
    if "Well" not in df.columns:
        df["Well"] = None
    df["Cp"] = pd.to_numeric(df["Cp"], errors="coerce")
    return {"replaced": qpcr_library.save_run(name, "manual", df), **_library()}


class DeleteRunRequest(BaseModel):
    run_id: int


@router.post("/api/qpcr/library/delete")
def library_delete(body: DeleteRunRequest):
    qpcr_library.delete_run(body.run_id)
    return _library()


# ── ΔΔCt analysis + stats ───────────────────────────────────────────────────

class AnalyzeRequest(BaseModel):
    pairs: List[dict] = []          # ad-hoc data: [{name, records:[{Sample,Gene,Cp}]}]
    run_ids: List[int] = []         # or library runs (used when pairs is empty)
    cp_max: Optional[float] = None  # exclude wells with Cp >= cp_max; None keeps all
    reference_genes: List[str]
    target_genes: List[str]
    control: str
    experimental: List[str]
    method: str = "auto"            # auto | ttest | anova


def _num(x) -> Optional[float]:
    """float, or None for NaN/inf — JSON has neither, and a test over a single
    replicate or zero variance produces them."""
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def _star(p: Optional[float], sig: float) -> str:
    """GraphPad Prism (GP) style: * P≤0.05, ** P≤0.01, *** P≤0.001, **** P≤0.0001.
    `sig` (α) only decides what counts as significant — a P above it is "ns" —
    so each asterisk count always means the same P range, as in Prism.
    A missing P (None) or a NaN one reads as "ns"."""
    if p is None or not (p <= sig and p <= 0.05):
        return "ns"
    if p <= 0.0001:
        return "****"
    if p <= 0.001:
        return "***"
    if p <= 0.01:
        return "**"
    return "*"


@router.post("/api/qpcr/analyze")
def analyze(body: AnalyzeRequest):
    frames = []
    for p in body.pairs or qpcr_library.load_records(body.run_ids):
        df = pd.DataFrame(p.get("records") or [])
        if df.empty:
            continue
        df["Cp"] = pd.to_numeric(df["Cp"], errors="coerce")
        df = df.dropna(subset=["Cp"])                # undetermined wells
        if body.cp_max is not None:
            df = df[df["Cp"] < body.cp_max]
        frames.append((p.get("name", ""), df))
    if not frames:
        return {"error": "No data."}

    refs = list(dict.fromkeys(body.reference_genes))
    keep_samples = [body.control] + body.experimental
    # Fold change for the reference genes too: with a single reference it is ~1
    # by construction, but the figure can show it on request. (Not tested.)
    fc_genes = list(dict.fromkeys(body.target_genes + refs))

    warnings = []
    combined = pd.DataFrame()
    for run_name, df in frames:
        ref = df[df["Gene"].isin(refs)]
        # Normalise a sample only if EVERY reference gene was measured for it in
        # this run; pooling runs normalised to different reference sets gives a
        # false fold change.
        n_refs = ref.groupby("Sample")["Gene"].nunique()
        complete = set(n_refs[n_refs == len(refs)].index)
        incomplete = sorted(s for s in set(df.loc[df["Gene"].isin(fc_genes), "Sample"]) - complete if s in keep_samples)
        if incomplete:
            why = "below the Cp limit" if body.cp_max is not None else "measured"
            warnings.append(f"{run_name}: {', '.join(incomplete)} left out — not every reference gene "
                            f"({', '.join(refs)}) was {why} for {'it' if len(incomplete) == 1 else 'them'} in this run.")
        avg_ref = (ref[ref["Sample"].isin(complete)].groupby("Sample")["Cp"].mean()
                   .reset_index().rename(columns={"Cp": "Average_Ref_Cp"}))
        tar = df[df["Gene"].isin(fc_genes)]
        m = pd.merge(tar, avg_ref, on="Sample")
        m["dCp"] = m["Cp"] - m["Average_Ref_Cp"]
        combined = pd.concat([combined, m], ignore_index=True)

    if combined.empty:
        return {"error": "No target/reference data after matching genes.", "warnings": warnings}
    if body.control not in set(combined["Sample"]):
        return {"error": f"The control sample {body.control} has no usable data (check the reference genes and the Cp limit).",
                "warnings": warnings}

    ctrl = combined[combined["Sample"] == body.control].groupby("Gene")["dCp"].mean().reset_index()
    ctrl = ctrl.rename(columns={"dCp": "Control_dCp"})
    combined = pd.merge(combined, ctrl, on="Gene")
    combined["ddCp"] = combined["dCp"] - combined["Control_dCp"]
    combined["Fold_Change"] = 2 ** (-combined["ddCp"])

    grouped = combined.groupby(["Sample", "Gene"])["Fold_Change"]
    combined["SD"] = grouped.transform("std")
    combined["SEM"] = grouped.transform(lambda x: np.std(x, ddof=1) / np.sqrt(len(x)) if len(x) > 1 else 0.0)

    final = combined[combined["Sample"].isin(keep_samples)].copy()

    # stats — target genes only (a reference gene's fold change is ~1 by construction)
    n_groups = len(body.experimental) + 1
    do_ttest = body.method == "ttest" or (body.method == "auto" and n_groups == 2)
    do_anova = body.method == "anova" or (body.method == "auto" and n_groups > 2)

    ttest_results = []
    if do_ttest:
        for gene in body.target_genes:
            cvals = final[(final["Sample"] == body.control) & (final["Gene"] == gene)]["Fold_Change"]
            for exp in body.experimental:
                evals = final[(final["Sample"] == exp) & (final["Gene"] == gene)]["Fold_Change"]
                if not (len(cvals) and len(evals)):
                    continue
                # Welch's t needs >= 2 replicates per side; report the comparison either way.
                t, p = ttest_ind(cvals, evals, equal_var=False) if len(cvals) > 1 and len(evals) > 1 else (None, None)
                ttest_results.append({"Gene": gene, "Control": body.control, "Experimental": exp,
                                      "n_control": int(len(cvals)), "n_experimental": int(len(evals)),
                                      "T_Statistic": _num(t), "p_val": _num(p)})

    anova_tukey_results = []
    if do_anova:
        for gene in body.target_genes:
            sub = final[final["Gene"] == gene]
            if sub["Sample"].nunique() > 1:
                try:
                    ols("Fold_Change ~ C(Sample)", data=sub).fit()
                    tuk = pairwise_tukeyhsd(endog=sub["Fold_Change"], groups=sub["Sample"], alpha=0.05)
                    # The summary table rounds p-adj to 4 dp (7.8e-05 -> 0.0001), which
                    # would put P just above 0.0001 into "****"; use the exact values
                    # (same row order as the summary).
                    for row, p_exact in zip(tuk.summary().data[1:], tuk.pvalues):
                        g1, g2, md, padj, lo, hi, rej = row
                        anova_tukey_results.append({"Gene": gene, "Group1": str(g1), "Group2": str(g2),
                                                    "Mean_Diff": _num(md), "p_val": _num(p_exact),
                                                    "Significant": bool(rej)})
                except Exception:  # noqa: BLE001
                    pass

    # per (Gene, Sample) summary for plotting
    summ = (final.groupby(["Gene", "Sample"])
            .agg(mean=("Fold_Change", "mean"), sd=("SD", "mean"), sem=("SEM", "mean"),
                 n=("Fold_Change", "size")).reset_index())

    return {
        "analysis_data": _records(final.drop(columns=[c for c in ("Average_Ref_Cp",) if c in final])),
        "summary": _records(summ),
        "ttest_results": ttest_results,
        "anova_tukey_results": anova_tukey_results,
        "warnings": warnings,
    }


# ── Plot (ggplot2 via the R bridge) ─────────────────────────────────────────

class PlotRequest(BaseModel):
    points: List[dict] = []                   # per-replicate [{Gene, Sample, value}]
    summary: List[dict] = []                  # fallback [{Gene,Sample,mean,sd,sem,n}]
    ttest_results: List[dict] = []
    anova_tukey_results: List[dict] = []
    gene_order: List[str]
    sample_order: List[str]
    colors: Dict[str, str] = {}               # sample -> hex
    labels: Dict[str, str] = {}               # sample -> legend label
    error_type: str = "SD"                    # SD | SEM
    layout: str = "grouped"                   # grouped (one graph, genes on x, dodged by sample) | faceted (one panel per gene)
    plot_type: str = "bar"                    # bar | violin | box | dot
    show_points: bool = False                 # overlay individual replicate points
    point_size: float = 1.8
    bar_width: float = 0.7
    theme: str = "prism"                      # prism | classic | minimal
    significance_level: float = 0.05
    hide_ns: bool = True
    title: str = "Fold change per gene"
    xlabel: str = "Sample"
    ylabel: str = "Fold change"
    font_size: int = 14
    width: int = 1200
    height: int = 800
    dpi: int = 150
    export_format: str = "png"                 # png | tiff (publication export)
    transparent: bool = False                  # transparent background on export


def _resc(s: str) -> str:
    return str(s).replace("\\", "\\\\").replace('"', '\\"')


def _r_vec(items: List[str]) -> str:
    return "c(" + ", ".join(f'"{_resc(i)}"' for i in items) + ")"


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


def _build_comparisons(body: PlotRequest):
    out = []
    rows = [(r["Gene"], r["Control"], r["Experimental"], r.get("p_val")) for r in body.ttest_results]
    rows += [(r["Gene"], r["Group1"], r["Group2"], r.get("p_val")) for r in body.anova_tukey_results]
    for gene, s1, s2, p in rows:
        if p is None:            # untestable (single replicate / zero variance) — draw nothing
            continue
        st = _star(p, body.significance_level)
        if body.hide_ns and st == "ns":
            continue
        out.append((gene, s1, s2, p, st))
    return out


def _indexed(df: pd.DataFrame, genes: List[str], samples: List[str]) -> pd.DataFrame:
    """Swap Gene/Sample names for 1-based indices into `genes`/`samples` before
    the CSV goes to R: R's read.csv would turn a sample called "01" into 1 and
    one called "NA" into a missing value. R rebuilds the factors from the index."""
    gi = {g: i + 1 for i, g in enumerate(genes)}
    si = {s: i + 1 for i, s in enumerate(samples)}
    out = df.copy()
    out["gi"] = out.pop("Gene").map(gi)
    out["si"] = out.pop("Sample").map(si)
    return out


@router.post("/api/qpcr/plot")
def plot(body: PlotRequest):
    # Per-replicate points drive the plot (needed for points/violin/box); the
    # summary (mean/err) for bars + brackets is computed in R from them.
    pts = pd.DataFrame(body.points)
    if pts.empty and body.summary:
        s = pd.DataFrame(body.summary)
        pts = s[["Gene", "Sample"]].copy()
        pts["value"] = s["mean"]
    if pts.empty or "value" not in pts.columns:
        return {"success": False, "stderr": "No per-replicate data to plot.", "plots": []}
    pts = pts[["Gene", "Sample", "value"]].dropna()
    # Only what was asked for: analyze also returns reference-gene rows, which
    # must not appear unless they are in gene_order.
    pts = pts[pts["Gene"].isin(body.gene_order) & pts["Sample"].isin(body.sample_order)]
    if pts.empty:
        return {"success": False, "stderr": "No data for the selected genes and samples.", "plots": []}

    sample_idx = {s: i + 1 for i, s in enumerate(body.sample_order)}
    gene_idx = {g: i + 1 for i, g in enumerate(body.gene_order)}
    n_samples = max(1, len(body.sample_order))

    colors = [body.colors.get(s, "#888888") for s in body.sample_order]
    labels = [body.labels.get(s, s) for s in body.sample_order]
    export_fmt = "tiff" if str(body.export_format).lower() in ("tiff", "tif") else "png"
    bg = "transparent" if body.transparent else "white"
    ptype = body.plot_type if body.plot_type in ("bar", "violin", "box", "dot") else "bar"
    star_size = max(2, body.font_size // 3)
    faceted = str(body.layout).lower() == "faceted"
    bw = min(1.0, max(0.05, float(body.bar_width)))
    show_pts = body.show_points or ptype == "dot"
    angle = 'p <- p + ggplot2::theme(axis.text.x=ggplot2::element_text(angle=45, hjust=1, vjust=1))\n'

    if faceted:
        # One panel per gene; the x-axis inside each panel is Sample. drop=FALSE
        # keeps every sample's slot so bracket positions (sample index) hold.
        if ptype == "bar":
            geom = (f'p <- p + ggplot2::geom_col(data=summ, ggplot2::aes(Sample, mean, fill=Sample), width={bw}, colour="black", linewidth=0.3) + '
                    'ggplot2::geom_errorbar(data=summ, ggplot2::aes(Sample, ymin=pmax(0, mean-err), ymax=mean+err), width=0.25, linewidth=0.4)\n')
        elif ptype == "violin":
            geom = 'p <- p + ggplot2::geom_violin(data=dat, ggplot2::aes(Sample, value, fill=Sample), trim=FALSE, colour="black", linewidth=0.3, alpha=0.85)\n'
        elif ptype == "box":
            geom = 'p <- p + ggplot2::geom_boxplot(data=dat, ggplot2::aes(Sample, value, fill=Sample), outlier.shape=NA, colour="black", linewidth=0.3, alpha=0.85)\n'
        else:  # dot (flat crossbar at the mean)
            geom = 'p <- p + ggplot2::geom_crossbar(data=summ, ggplot2::aes(Sample, y=mean, ymin=mean, ymax=mean, fill=Sample), width=0.5, linewidth=0.3, colour="black")\n'
        points_layer = (
            f'p <- p + ggplot2::geom_point(data=dat, ggplot2::aes(Sample, value), position=ggplot2::position_jitter(width=0.12, height=0, seed=1), size={body.point_size}, shape=21, fill="white", colour="black", stroke=0.4)\n'
            if show_pts else ""
        )
        layout_layer = 'p <- p + ggplot2::facet_wrap(~Gene, scales="free_y") + ggplot2::scale_x_discrete(drop=FALSE)\n'
        xangle_layer = angle
    else:
        # Single graph: genes on the x-axis, one fixed lane per sample. Every
        # layer is drawn at the lane centre xp — the same position _dx() gives
        # the brackets — so a gene missing a sample leaves a gap rather than
        # shifting bars/points under the wrong significance star (position
        # dodges re-pack per gene and disagree with each other).
        if ptype == "bar":
            geom = ('p <- p + ggplot2::geom_col(data=summ, ggplot2::aes(xp, mean, fill=Sample), width=.w, colour="black", linewidth=0.3) + '
                    'ggplot2::geom_errorbar(data=summ, ggplot2::aes(xp, ymin=pmax(0, mean-err), ymax=mean+err), width=.w * 0.35, linewidth=0.4)\n')
        elif ptype == "violin":
            geom = 'p <- p + ggplot2::geom_violin(data=dat, ggplot2::aes(xp, value, fill=Sample, group=interaction(Gene, Sample)), width=.w, trim=FALSE, colour="black", linewidth=0.3, alpha=0.85)\n'
        elif ptype == "box":
            geom = 'p <- p + ggplot2::geom_boxplot(data=dat, ggplot2::aes(xp, value, fill=Sample, group=interaction(Gene, Sample)), width=.w, outlier.shape=NA, colour="black", linewidth=0.3, alpha=0.85)\n'
        else:  # dot (flat crossbar at the mean)
            geom = 'p <- p + ggplot2::geom_crossbar(data=summ, ggplot2::aes(xp, y=mean, ymin=mean, ymax=mean, fill=Sample), width=.w * 0.9, linewidth=0.3, colour="black")\n'
        points_layer = (
            f'p <- p + ggplot2::geom_point(data=dat, ggplot2::aes(xp, value), position=ggplot2::position_jitter(width=.w * 0.22, height=0, seed=1), size={body.point_size}, shape=21, fill="white", colour="black", stroke=0.4)\n'
            if show_pts else ""
        )
        layout_layer = ('p <- p + ggplot2::scale_x_continuous(breaks=seq_along(.genes), labels=.genes, expand=c(0, 0)) + '
                        'ggplot2::coord_cartesian(xlim=c(0.5, length(.genes) + 0.5))\n')
        xangle_layer = angle if len(body.gene_order) > 8 else ""

    theme_layer = _theme_layer(body.theme, body.font_size)
    transparent_theme = _transparent_layer(body.transparent)

    # Significance brackets. Faceted layout uses integer Sample positions within
    # each panel; grouped layout uses the lane centres: gene g (1-based) with S
    # samples places sample j (1-based) at g + bw*((2j-1-S)/(2S)), exactly the
    # xp computed in R.
    comps = _build_comparisons(body)
    if faceted:
        brackets = [(cg, sample_idx[s1], sample_idx[s2], star)
                    for (cg, s1, s2, _p, star) in comps
                    if cg in gene_idx and s1 in sample_idx and s2 in sample_idx]
    else:
        def _dx(gi: int, j: int) -> float:
            return round(gi + bw * ((2 * j - 1 - n_samples) / (2.0 * n_samples)), 5)
        brackets = [(cg, _dx(gene_idx[cg], sample_idx[s1]), _dx(gene_idx[cg], sample_idx[s2]), star)
                    for (cg, s1, s2, _p, star) in comps
                    if cg in gene_idx and s1 in sample_idx and s2 in sample_idx]

    if brackets:
        bgi = "c(" + ", ".join(str(gene_idx[b[0]]) for b in brackets) + ")"
        bx1 = "c(" + ", ".join(str(b[1]) for b in brackets) + ")"
        bx2 = "c(" + ", ".join(str(b[2]) for b in brackets) + ")"
        blabels = _r_vec([b[3] for b in brackets])
        top_expr = ('summ %>% dplyr::group_by(Gene) %>% dplyr::summarise(top=max(mean+err, na.rm=TRUE), .groups="drop")'
                    if ptype == "bar" else
                    'dat %>% dplyr::group_by(Gene) %>% dplyr::summarise(top=max(value, na.rm=TRUE), .groups="drop")')
        bracket_block = (
            f'bdf <- data.frame(Gene=factor(.genes[{bgi}], levels=.genes), x1={bx1}, x2={bx2}, label={blabels}, stringsAsFactors=FALSE)\n'
            f'topdf <- as.data.frame({top_expr})\n'
            # left-join + drop brackets whose gene has no plotted data (else a
            # 0-row bdf would crash geom_segment with "x1 not found").
            'bdf <- merge(bdf, topdf, by="Gene", all.x=TRUE)\n'
            'bdf <- bdf[!is.na(bdf$top), , drop=FALSE]\n'
            'if (nrow(bdf) > 0) {\n'
            '  bdf <- do.call(rbind, by(bdf, bdf$Gene, function(d) { d$rank <- seq_len(nrow(d)); d }))\n'
            '  bdf$y <- bdf$top * 1.06 + (bdf$rank - 1) * bdf$top * 0.12\n'
            '  p <- p + ggplot2::geom_segment(data=bdf, ggplot2::aes(x=x1, xend=x2, y=y, yend=y), inherit.aes=FALSE, linewidth=0.4) + '
            f'ggplot2::geom_text(data=bdf, ggplot2::aes(x=(x1+x2)/2, y=y, label=label), inherit.aes=FALSE, vjust=-0.2, size={star_size})\n'
            '}\n'
        )
    else:
        bracket_block = ""

    code = f"""
suppressMessages({{ library(ggplot2); library(dplyr) }})
.genes <- {_r_vec(body.gene_order)}
.samples <- {_r_vec(body.sample_order)}
dat <- data
dat$Gene <- factor(.genes[dat$gi], levels=.genes)
dat$Sample <- factor(.samples[dat$si], levels=.samples)
.cols <- {_r_vec(colors)}; names(.cols) <- .samples
.labs <- {_r_vec(labels)}
.S <- length(.samples); .bw <- {bw}; .w <- .bw / .S
.lane <- function(g, s) as.integer(g) + .bw * ((2 * as.integer(s) - 1 - .S) / (2 * .S))
summ <- dat %>% dplyr::group_by(Gene, Sample) %>% dplyr::summarise(mean=mean(value), sd=sd(value), sem=sd(value)/sqrt(dplyr::n()), .groups="drop")
summ$err <- {'summ$sem' if body.error_type.upper() == 'SEM' else 'summ$sd'}
summ$err[is.na(summ$err)] <- 0
summ$xp <- .lane(summ$Gene, summ$Sample)
dat$xp <- .lane(dat$Gene, dat$Sample)
p <- ggplot2::ggplot()
{geom}{points_layer}{layout_layer}p <- p + ggplot2::scale_fill_manual(values=.cols, labels=.labs, drop=FALSE) + ggplot2::labs(title="{_resc(body.title)}", x="{_resc(body.xlabel)}", y="{_resc(body.ylabel)}", fill=NULL)
{theme_layer}{xangle_layer}{bracket_block}{transparent_theme}mpfig_render(p, width={int(body.width)}, height={int(body.height)}, res={int(body.dpi)}, format="{export_fmt}", bg="{bg}")
mpfig_data(dplyr::select(summ, -xp), "qpcr_summary")
"""
    data = _indexed(pts, body.gene_order, body.sample_order)
    res = r_bridge.run_r(r_bridge.RunRRequest(code=code, data_csv=data.to_csv(index=False), timeout_sec=120))
    return res


# ── Raw Cp plot (QC: reference-gene stability + detection limit) ────────────

class CpPlotRequest(BaseModel):
    run_ids: List[int] = []                   # library runs (or pairs, as for analyze)
    pairs: List[dict] = []
    gene_order: List[str]
    sample_order: List[str]
    reference_genes: List[str] = []           # labelled "(ref)" on the axis
    cp_limit: float = 35.0                    # dotted line; Cp at/above = not detected
    colors: Dict[str, str] = {}
    labels: Dict[str, str] = {}
    theme: str = "prism"
    point_size: float = 1.8
    font_size: int = 14
    title: str = "Raw Cp values"
    width: int = 1200
    height: int = 800
    dpi: int = 150
    export_format: str = "png"
    transparent: bool = False


@router.post("/api/qpcr/plot-cp")
def plot_cp(body: CpPlotRequest):
    """Raw Cp per gene x sample, reference genes included, with a dotted line at
    the Cp limit so genes near or past detection are easy to spot and exclude.
    Undetermined wells (no Cp) are drawn at the limit as crosses."""
    rows = [(r.get("Gene"), r.get("Sample"), r.get("Cp"))
            for p in body.pairs or qpcr_library.load_records(body.run_ids)
            for r in p.get("records") or []]
    df = pd.DataFrame(rows, columns=["Gene", "Sample", "Cp"])
    df["Cp"] = pd.to_numeric(df["Cp"], errors="coerce")
    df = df[df["Gene"].isin(body.gene_order) & df["Sample"].isin(body.sample_order)].copy()
    if df.empty:
        return {"success": False, "stderr": "No wells for the selected genes and samples.", "plots": []}

    lim = float(body.cp_limit)
    present_genes, present_samples = set(df["Gene"]), set(df["Sample"])
    genes = [g for g in body.gene_order if g in present_genes]
    refs = [g for g in genes if g in set(body.reference_genes)]
    genes = refs + [g for g in genes if g not in set(refs)]          # references first
    samples = [s for s in body.sample_order if s in present_samples]
    angled = len(genes) > 8
    # A two-line "(ref)" label collides with its neighbours once labels are angled.
    xlabels = [(f"{g} (ref)" if angled else f"{g}\n(ref)") if g in refs else g for g in genes]
    colors = [body.colors.get(s, "#888888") for s in samples]
    labels = [body.labels.get(s, s) for s in samples]
    export_fmt = "tiff" if str(body.export_format).lower() in ("tiff", "tif") else "png"
    bg = "transparent" if body.transparent else "white"
    divider = (f'p <- p + ggplot2::geom_vline(xintercept={len(refs) + 0.5}, colour="grey75", linewidth=0.4)\n'
               if 0 < len(refs) < len(genes) else "")
    xangle = ('p <- p + ggplot2::theme(axis.text.x=ggplot2::element_text(angle=45, hjust=1, vjust=1))\n'
              if angled else "")
    df["nd"] = df["Cp"].isna().astype(int)
    df["Cp"] = df["Cp"].fillna(lim)

    # One fixed lane per sample (as in the grouped fold-change plot), so the
    # mean bars always sit on their own wells even when a gene lacks a sample.
    code = f"""
suppressMessages({{ library(ggplot2); library(dplyr) }})
.genes <- {_r_vec(genes)}
.samples <- {_r_vec(samples)}
dat <- data
dat$Gene <- factor(.genes[dat$gi], levels=.genes)
dat$Sample <- factor(.samples[dat$si], levels=.samples)
.cols <- {_r_vec(colors)}; names(.cols) <- .samples
.lim <- {lim}
.S <- length(.samples); dw <- 0.8; .w <- dw / .S
dat$x <- as.integer(dat$Gene) + dw * ((2 * as.integer(dat$Sample) - 1 - .S) / (2 * .S))
det <- dat[dat$nd == 0, , drop=FALSE]
und <- dat[dat$nd == 1, , drop=FALSE]
mn <- det %>% dplyr::group_by(Gene, Sample, x) %>% dplyr::summarise(m=mean(Cp), .groups="drop")
p <- ggplot2::ggplot()
p <- p + ggplot2::annotate("rect", xmin=-Inf, xmax=Inf, ymin=.lim, ymax=Inf, fill="#c1666b", alpha=0.08)
{divider}p <- p + ggplot2::geom_crossbar(data=mn, ggplot2::aes(x=x, y=m, ymin=m, ymax=m), width=.w * 0.9, linewidth=0.3, colour="black")
p <- p + ggplot2::geom_point(data=det, ggplot2::aes(x, Cp, fill=Sample), shape=21, colour="black", stroke=0.3, size={body.point_size}, position=ggplot2::position_jitter(width=.w * 0.22, height=0, seed=1))
if (nrow(und) > 0) p <- p + ggplot2::geom_point(data=und, ggplot2::aes(x, Cp), shape=4, colour="#c1666b", stroke=0.9, size={body.point_size * 1.1:.2f}, position=ggplot2::position_jitter(width=.w * 0.22, height=0, seed=2))
p <- p + ggplot2::geom_hline(yintercept=.lim, linetype="dotted", colour="#c1666b", linewidth=0.8)
p <- p + ggplot2::annotate("text", x=Inf, y=.lim, label=sprintf("Cp %g", .lim), hjust=1.05, vjust=-0.6, colour="#c1666b", size={max(3, body.font_size / 3.5):.2f})
p <- p + ggplot2::expand_limits(y=.lim + 1)
p <- p + ggplot2::scale_fill_manual(values=.cols, labels={_r_vec(labels)}, drop=FALSE)
p <- p + ggplot2::scale_x_continuous(breaks=seq_along(.genes), labels={_r_vec(xlabels)}, expand=c(0, 0)) + ggplot2::coord_cartesian(xlim=c(0.5, length(.genes) + 0.5))
p <- p + ggplot2::labs(title="{_resc(body.title)}", x=NULL, y="Cp", fill=NULL, caption=if (nrow(und) > 0) "× undetermined well (no Cp), drawn at the limit" else NULL)
{_theme_layer(body.theme, body.font_size)}{xangle}{_transparent_layer(body.transparent)}mpfig_render(p, width={int(body.width)}, height={int(body.height)}, res={int(body.dpi)}, format="{export_fmt}", bg="{bg}")
summ <- dat %>% dplyr::group_by(Gene, Sample) %>% dplyr::summarise(
  mean_Cp=if (any(nd == 0)) mean(Cp[nd == 0]) else NA_real_, sd=sd(Cp[nd == 0]), n_wells=dplyr::n(),
  n_undetermined=sum(nd), n_at_or_above_limit=sum(nd == 0 & Cp >= .lim), .groups="drop")
mpfig_data(summ, "qpcr_cp_summary")
"""
    data = _indexed(df, genes, samples)
    return r_bridge.run_r(r_bridge.RunRRequest(code=code, data_csv=data.to_csv(index=False), timeout_sec=120))
