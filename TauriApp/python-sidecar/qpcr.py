"""qPCR ΔΔCt analysis.

Ported from the standalone Streamlit qPCR app: parse paired LightCycler
`*_qpcr.txt` (Cp per well) + `*_platemap.txt` (well -> Gene + Sample), compute
ΔΔCt fold-change, run t-test or ANOVA+Tukey, and render a faceted ggplot2 bar
chart with error bars + significance brackets (bracket geometry is computed
here so the R template stays purely presentational).
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
    summary: List[dict]                       # [{Gene,Sample,mean,sd,sem,n}]
    ttest_results: List[dict] = []
    anova_tukey_results: List[dict] = []
    gene_order: List[str]
    sample_order: List[str]
    colors: Dict[str, str] = {}               # sample -> hex
    labels: Dict[str, str] = {}               # sample -> legend label
    error_type: str = "SD"                    # SD | SEM
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
    sdf = pd.DataFrame(body.summary)
    if sdf.empty:
        return {"success": False, "stderr": "No summary data to plot.", "plots": []}
    err_col = "sd" if body.error_type.upper() == "SD" else "sem"
    sdf["err"] = sdf[err_col].fillna(0.0)
    sdf = sdf[["Gene", "Sample", "mean", "err"]]

    # bracket geometry (per gene, stacked above the tallest bar+err)
    sample_idx = {s: i + 1 for i, s in enumerate(body.sample_order)}
    comps = _build_comparisons(body)
    brackets = []  # Gene, x1, x2, y, label
    for gene in body.gene_order:
        gtops = sdf[sdf["Gene"] == gene]
        if gtops.empty:
            continue
        base = float((gtops["mean"] + gtops["err"]).max())
        base = base if base > 0 else 1.0
        step = base * 0.10
        k = 0
        for (cg, s1, s2, p, star) in comps:
            if cg != gene or s1 not in sample_idx or s2 not in sample_idx:
                continue
            y = base * 1.06 + k * step
            brackets.append((gene, sample_idx[s1], sample_idx[s2], y, star))
            k += 1

    colors = [body.colors.get(s, "#888888") for s in body.sample_order]
    labels = [body.labels.get(s, s) for s in body.sample_order]

    export_fmt = "tiff" if str(body.export_format).lower() in ("tiff", "tif") else "png"
    bg = "transparent" if body.transparent else "white"
    transparent_theme = (
        " + theme(plot.background=element_rect(fill='transparent', colour=NA), "
        "panel.background=element_rect(fill='transparent', colour=NA), "
        "legend.background=element_rect(fill='transparent', colour=NA), "
        "legend.box.background=element_rect(fill='transparent', colour=NA), "
        "legend.key=element_rect(fill='transparent', colour=NA))"
        if body.transparent else ""
    )

    # bracket data.frame as an inline R literal
    if brackets:
        # NOTE: keep this distinct from `bg` (the background colour) below — a
        # name collision here previously corrupted the mpfig_render(bg=...) arg.
        bgene = _r_vec([b[0] for b in brackets])
        bx1 = "c(" + ", ".join(str(b[1]) for b in brackets) + ")"
        bx2 = "c(" + ", ".join(str(b[2]) for b in brackets) + ")"
        by = "c(" + ", ".join(f"{b[3]:.6f}" for b in brackets) + ")"
        bl = _r_vec([b[4] for b in brackets])
        bracket_block = (
            f'bdf <- data.frame(Gene=factor({bgene}, levels={_r_vec(body.gene_order)}), '
            f'x1={bx1}, x2={bx2}, y={by}, label={bl}, stringsAsFactors=FALSE)\n'
            'p <- p + geom_segment(data=bdf, aes(x=x1, xend=x2, y=y, yend=y), inherit.aes=FALSE, linewidth=0.4) +\n'
            '  geom_text(data=bdf, aes(x=(x1+x2)/2, y=y, label=label), inherit.aes=FALSE, vjust=-0.2, size=' + str(max(2, body.font_size // 3)) + ')\n'
        )
    else:
        bracket_block = ""

    code = f"""
library(ggplot2)
data$Gene <- factor(data$Gene, levels={_r_vec(body.gene_order)})
data$Sample <- factor(data$Sample, levels={_r_vec(body.sample_order)})
.cols <- {_r_vec(colors)}; names(.cols) <- {_r_vec(body.sample_order)}
.labs <- {_r_vec(labels)}
p <- ggplot(data, aes(x=Sample, y=mean, fill=Sample)) +
  geom_col(width=0.7, colour="black", linewidth=0.3) +
  geom_errorbar(aes(ymin=pmax(0, mean-err), ymax=mean+err), width=0.25, linewidth=0.4) +
  facet_wrap(~Gene, scales="free_y") +
  scale_fill_manual(values=.cols, labels=.labs) +
  labs(title="{_resc(body.title)}", x="{_resc(body.xlabel)}", y="{_resc(body.ylabel)}", fill=NULL) +
  theme_classic(base_size={int(body.font_size)}) +
  theme(axis.text.x=element_text(angle=45, hjust=1))
{bracket_block}
p <- p{transparent_theme}
mpfig_render(p, width={int(body.width)}, height={int(body.height)}, res={int(body.dpi)}, format="{export_fmt}", bg="{bg}")
mpfig_data(data, "qpcr_plot_data")
"""
    summary_csv = sdf.to_csv(index=False)
    res = r_bridge.run_r(r_bridge.RunRRequest(code=code, data_csv=summary_csv, timeout_sec=120))
    return res
