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
from typing import Dict, List, Optional

import numpy as np
import pandas as pd
from fastapi import APIRouter, File, UploadFile
from pydantic import BaseModel
from scipy.stats import ttest_ind
from statsmodels.formula.api import ols
from statsmodels.stats.multicomp import pairwise_tukeyhsd

import r_bridge

router = APIRouter()

# LightCycler export columns to drop (Include, Color, Concentration, Standard, Status)
QPCR_DROP_COLS = [0, 1, 5, 6, 7]


# ── Parsing ─────────────────────────────────────────────────────────────────

def _parse_pair(qpcr_bytes: bytes, platemap_bytes: bytes, drop_high_cp: bool) -> pd.DataFrame:
    dq = pd.read_csv(io.BytesIO(qpcr_bytes), sep="\t", skiprows=1)
    dq = dq.drop(dq.columns[QPCR_DROP_COLS], axis=1)
    dl = pd.read_csv(io.BytesIO(platemap_bytes), sep="\t")
    if "Cell Position" in dl.columns:
        dl = dl.rename(columns={"Cell Position": "Pos"})
    merged = pd.merge(dq, dl, on="Pos", how="left").dropna()
    merged["Cp"] = pd.to_numeric(merged["Cp"], errors="coerce")
    merged = merged.dropna(subset=["Cp"])
    if drop_high_cp:
        merged = merged[merged["Cp"] < 35]
    keep = [c for c in ("Sample", "Gene", "Cp") if c in merged.columns]
    return merged[keep].reset_index(drop=True)


def _stem(name: str) -> str:
    base = name.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    return base.replace("_qpcr.txt", "").replace("_platemap.txt", "")


@router.post("/api/qpcr/upload")
async def upload(files: List[UploadFile] = File(...), drop_high_cp: bool = False):
    qpcr_files: Dict[str, bytes] = {}
    plate_files: Dict[str, bytes] = {}
    for f in files:
        data = await f.read()
        name = f.filename or ""
        if name.endswith("_platemap.txt"):
            plate_files[_stem(name)] = data
        elif name.endswith("_qpcr.txt"):
            qpcr_files[_stem(name)] = data
        else:
            # tolerate unsuffixed: guess by header later — skip for now
            continue

    pairs = []
    errors = []
    for stem in sorted(set(qpcr_files) & set(plate_files)):
        try:
            df = _parse_pair(qpcr_files[stem], plate_files[stem], drop_high_cp)
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


# ── ΔΔCt analysis + stats ───────────────────────────────────────────────────

class AnalyzeRequest(BaseModel):
    pairs: List[dict]               # [{name, records:[{Sample,Gene,Cp}]}]
    reference_genes: List[str]
    target_genes: List[str]
    control: str
    experimental: List[str]
    method: str = "auto"            # auto | ttest | anova


def _star(p: float, sig: float) -> str:
    if p < sig / 100:
        return "****"
    if p < sig / 10:
        return "***"
    if p < sig:
        return "**"
    return "ns"


@router.post("/api/qpcr/analyze")
def analyze(body: AnalyzeRequest):
    frames = [pd.DataFrame(p["records"]) for p in body.pairs if p.get("records")]
    if not frames:
        return {"error": "No data."}

    combined = pd.DataFrame()
    for df in frames:
        ref = df[df["Gene"].isin(body.reference_genes)]
        avg_ref = ref.groupby("Sample")["Cp"].mean().reset_index().rename(columns={"Cp": "Average_Ref_Cp"})
        tar = df[df["Gene"].isin(body.target_genes)]
        m = pd.merge(tar, avg_ref, on="Sample")
        m["dCp"] = m["Cp"] - m["Average_Ref_Cp"]
        combined = pd.concat([combined, m], ignore_index=True)

    if combined.empty:
        return {"error": "No target/reference data after matching genes."}

    ctrl = combined[combined["Sample"] == body.control].groupby("Gene")["dCp"].mean().reset_index()
    ctrl = ctrl.rename(columns={"dCp": "Control_dCp"})
    combined = pd.merge(combined, ctrl, on="Gene")
    combined["ddCp"] = combined["dCp"] - combined["Control_dCp"]
    combined["Fold_Change"] = 2 ** (-combined["ddCp"])

    grouped = combined.groupby(["Sample", "Gene"])["Fold_Change"]
    combined["SD"] = grouped.transform("std")
    combined["SEM"] = grouped.transform(lambda x: np.std(x, ddof=1) / np.sqrt(len(x)) if len(x) > 1 else 0.0)

    keep_samples = [body.control] + body.experimental
    final = combined[combined["Sample"].isin(keep_samples)].copy()

    # stats
    n_groups = len(body.experimental) + 1
    do_ttest = body.method == "ttest" or (body.method == "auto" and n_groups == 2)
    do_anova = body.method == "anova" or (body.method == "auto" and n_groups > 2)

    ttest_results = []
    if do_ttest:
        for gene in body.target_genes:
            cvals = final[(final["Sample"] == body.control) & (final["Gene"] == gene)]["Fold_Change"]
            for exp in body.experimental:
                evals = final[(final["Sample"] == exp) & (final["Gene"] == gene)]["Fold_Change"]
                if len(cvals) and len(evals):
                    t, p = ttest_ind(cvals, evals, equal_var=False)
                    ttest_results.append({"Gene": gene, "Control": body.control, "Experimental": exp,
                                          "T_Statistic": float(t), "p_val": float(p)})

    anova_tukey_results = []
    if do_anova:
        for gene in body.target_genes:
            sub = final[final["Gene"] == gene]
            if sub["Sample"].nunique() > 1:
                try:
                    ols("Fold_Change ~ C(Sample)", data=sub).fit()
                    tuk = pairwise_tukeyhsd(endog=sub["Fold_Change"], groups=sub["Sample"], alpha=0.05)
                    for row in tuk.summary().data[1:]:
                        g1, g2, md, padj, lo, hi, rej = row
                        anova_tukey_results.append({"Gene": gene, "Group1": str(g1), "Group2": str(g2),
                                                    "Mean_Diff": float(md), "p_val": float(padj),
                                                    "Significant": bool(rej)})
                except Exception:  # noqa: BLE001
                    pass

    # per (Gene, Sample) summary for plotting
    summ = (final.groupby(["Gene", "Sample"])
            .agg(mean=("Fold_Change", "mean"), sd=("SD", "mean"), sem=("SEM", "mean"),
                 n=("Fold_Change", "size")).reset_index())

    return {
        "analysis_data": final.drop(columns=[c for c in ("Average_Ref_Cp",) if c in final]).to_dict("records"),
        "summary": summ.to_dict("records"),
        "ttest_results": ttest_results,
        "anova_tukey_results": anova_tukey_results,
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


def _build_comparisons(body: PlotRequest):
    out = []
    for r in body.ttest_results:
        st = _star(r["p_val"], body.significance_level)
        if body.hide_ns and st == "ns":
            continue
        out.append((r["Gene"], r["Control"], r["Experimental"], r["p_val"], st))
    for r in body.anova_tukey_results:
        st = _star(r["p_val"], body.significance_level)
        if body.hide_ns and st == "ns":
            continue
        out.append((r["Gene"], r["Group1"], r["Group2"], r["p_val"], st))
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
    bw = max(0.05, float(body.bar_width))

    if faceted:
        # One panel per gene; the x-axis inside each panel is Sample.
        if ptype == "bar":
            geom = (f'p <- p + ggplot2::geom_col(data=summ, ggplot2::aes(Sample, mean, fill=Sample), width={bw}, colour="black", linewidth=0.3) + '
                    'ggplot2::geom_errorbar(data=summ, ggplot2::aes(Sample, ymin=pmax(0, mean-err), ymax=mean+err), width=0.25, linewidth=0.4)\n')
        elif ptype == "violin":
            geom = 'p <- p + ggplot2::geom_violin(data=dat, ggplot2::aes(Sample, value, fill=Sample), trim=FALSE, colour="black", linewidth=0.3, alpha=0.85)\n'
        elif ptype == "box":
            geom = 'p <- p + ggplot2::geom_boxplot(data=dat, ggplot2::aes(Sample, value, fill=Sample), outlier.shape=NA, colour="black", linewidth=0.3, alpha=0.85)\n'
        else:  # dot (flat crossbar at the mean — fun.min/max=mean so ymin/ymax aren't NA)
            geom = 'p <- p + ggplot2::stat_summary(data=dat, ggplot2::aes(Sample, value, fill=Sample), fun=mean, fun.min=mean, fun.max=mean, geom="crossbar", width=0.5, linewidth=0.3)\n'
        points_layer = (
            f'p <- p + ggplot2::geom_jitter(data=dat, ggplot2::aes(Sample, value), width=0.12, height=0, size={body.point_size}, shape=21, fill="white", colour="black", stroke=0.4)\n'
            if (body.show_points or ptype == "dot") else ""
        )
        layout_layer = 'p <- p + ggplot2::facet_wrap(~Gene, scales="free_y")\n'
        xangle_layer = 'p <- p + ggplot2::theme(axis.text.x=ggplot2::element_text(angle=45, hjust=1))\n'
    else:
        # Single graph: all genes on the x-axis, dodged by sample. preserve="single"
        # keeps each sample in a fixed lane even when a gene is missing a sample,
        # so the bars stay aligned with the Python-computed bracket x-positions.
        dodge = f'ggplot2::position_dodge(width={bw}, preserve="single")'
        if ptype == "bar":
            geom = (f'p <- p + ggplot2::geom_col(data=summ, ggplot2::aes(Gene, mean, fill=Sample), position={dodge}, width={bw}, colour="black", linewidth=0.3) + '
                    f'ggplot2::geom_errorbar(data=summ, ggplot2::aes(Gene, ymin=pmax(0, mean-err), ymax=mean+err, group=Sample), position={dodge}, width=0.2, linewidth=0.4)\n')
        elif ptype == "violin":
            geom = f'p <- p + ggplot2::geom_violin(data=dat, ggplot2::aes(Gene, value, fill=Sample), position={dodge}, width={bw}, trim=FALSE, colour="black", linewidth=0.3, alpha=0.85)\n'
        elif ptype == "box":
            geom = f'p <- p + ggplot2::geom_boxplot(data=dat, ggplot2::aes(Gene, value, fill=Sample), position={dodge}, width={bw}, outlier.shape=NA, colour="black", linewidth=0.3, alpha=0.85)\n'
        else:  # dot (flat crossbar at the mean, dodged by sample)
            geom = f'p <- p + ggplot2::stat_summary(data=dat, ggplot2::aes(Gene, value, fill=Sample, group=Sample), fun=mean, fun.min=mean, fun.max=mean, geom="crossbar", width={bw}, linewidth=0.3, colour="black", position={dodge})\n'
        # position_jitterdodge dodges by a MAPPED aesthetic (fill/colour/…), NOT
        # by group= — so map colour=Sample (giving it real dodge lanes) and force
        # the outlines back to black with an all-black, legend-less colour scale.
        points_layer = (
            f'p <- p + ggplot2::geom_point(data=dat, ggplot2::aes(Gene, value, colour=Sample), '
            f'position=ggplot2::position_jitterdodge(jitter.width=0.15, dodge.width={bw}), '
            f'size={body.point_size}, shape=21, fill="white", stroke=0.4) + '
            'ggplot2::scale_colour_manual(values=stats::setNames(rep("black", length(.cols)), names(.cols)), guide="none")\n'
            if (body.show_points or ptype == "dot") else ""
        )
        layout_layer = ""
        xangle_layer = ""

    if body.theme == "classic":
        theme_layer = f'p <- p + ggplot2::theme_classic(base_size={int(body.font_size)})\n'
    elif body.theme == "minimal":
        theme_layer = f'p <- p + ggplot2::theme_minimal(base_size={int(body.font_size)})\n'
    else:  # prism
        theme_layer = (f'if (requireNamespace("ggprism", quietly=TRUE)) p <- p + ggprism::theme_prism(base_size={int(body.font_size)}) '
                       f'else p <- p + ggplot2::theme_classic(base_size={int(body.font_size)})\n')

    transparent_theme = (
        "p <- p + ggplot2::theme(plot.background=ggplot2::element_rect(fill='transparent', colour=NA), "
        "panel.background=ggplot2::element_rect(fill='transparent', colour=NA), "
        "legend.background=ggplot2::element_rect(fill='transparent', colour=NA), "
        "legend.key=ggplot2::element_rect(fill='transparent', colour=NA))\n"
        if body.transparent else ""
    )

    # Significance brackets. Faceted layout uses integer Sample positions within
    # each panel; grouped layout uses absolute dodged x-positions on the Gene
    # axis: gene g (1-based) with S samples places sample j (1-based) at
    # g + bw*((2j-1-S)/(2S)) — the centre of position_dodge(width=bw).
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
        bgenes = _r_vec([b[0] for b in brackets])
        bx1 = "c(" + ", ".join(str(b[1]) for b in brackets) + ")"
        bx2 = "c(" + ", ".join(str(b[2]) for b in brackets) + ")"
        blabels = _r_vec([b[3] for b in brackets])
        top_expr = ('summ %>% dplyr::group_by(Gene) %>% dplyr::summarise(top=max(mean+err, na.rm=TRUE), .groups="drop")'
                    if ptype == "bar" else
                    'dat %>% dplyr::group_by(Gene) %>% dplyr::summarise(top=max(value, na.rm=TRUE), .groups="drop")')
        bracket_block = (
            f'bdf <- data.frame(Gene=factor({bgenes}, levels={_r_vec(body.gene_order)}), x1={bx1}, x2={bx2}, label={blabels}, stringsAsFactors=FALSE)\n'
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
dat <- data
dat$Gene <- factor(dat$Gene, levels={_r_vec(body.gene_order)})
dat$Sample <- factor(dat$Sample, levels={_r_vec(body.sample_order)})
.cols <- {_r_vec(colors)}; names(.cols) <- {_r_vec(body.sample_order)}
.labs <- {_r_vec(labels)}
summ <- dat %>% dplyr::group_by(Gene, Sample) %>% dplyr::summarise(mean=mean(value), sd=sd(value), sem=sd(value)/sqrt(dplyr::n()), .groups="drop")
summ$err <- {'summ$sem' if body.error_type.upper() == 'SEM' else 'summ$sd'}
summ$err[is.na(summ$err)] <- 0
p <- ggplot2::ggplot()
{geom}{points_layer}{layout_layer}p <- p + ggplot2::scale_fill_manual(values=.cols, labels=.labs) + ggplot2::labs(title="{_resc(body.title)}", x="{_resc(body.xlabel)}", y="{_resc(body.ylabel)}", fill=NULL)
{theme_layer}{xangle_layer}{bracket_block}{transparent_theme}mpfig_render(p, width={int(body.width)}, height={int(body.height)}, res={int(body.dpi)}, format="{export_fmt}", bg="{bg}")
mpfig_data(summ, "qpcr_summary")
"""
    res = r_bridge.run_r(r_bridge.RunRRequest(code=code, data_csv=pts.to_csv(index=False), timeout_sec=120))
    return res
