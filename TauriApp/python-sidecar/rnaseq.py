"""Bulk RNA-seq differential expression (DESeq2).

Inputs: a raw counts matrix (genes x samples) + sample metadata (coldata) +
a design formula + a contrast. Runs DESeq2 as an async R job and returns a
results table + volcano / MA / PCA / sample-distance / top-variable-genes
heatmaps. The DESeq2/ggplot/pheatmap R packages install on first use via the
package gate (manifest 'rnaseq').
"""

from __future__ import annotations

import io
import uuid
from typing import Dict, List, Optional

import pandas as pd
from fastapi import APIRouter
from pydantic import BaseModel

import r_bridge
import rjobs

router = APIRouter()

_SESS: Dict[str, dict] = {}


def _resc(s: str) -> str:
    return str(s).replace("\\", "\\\\").replace('"', '\\"')


def _volcano_ggplot(src: str, padj: float, lfc: float, top_n: int, title: str) -> str:
    """R that draws a volcano from a results data.frame `src` (cols include
    gene, log2FoldChange, pvalue, padj), colouring Up/Down/NS by the given
    padj + |log2FC| thresholds and labelling the top_n hits with ggrepel.
    Opens its own device via mpfig_plot(); caller stages around it."""
    t = _resc(title)
    return f'''
.vdf <- {src}
if (!"gene" %in% colnames(.vdf)) .vdf$gene <- rownames(.vdf)
.vdf$neglog10p <- -log10(.vdf$pvalue)
.vdf$sig <- ifelse(!is.na(.vdf$padj) & .vdf$padj < {padj} & abs(.vdf$log2FoldChange) > {lfc},
                   ifelse(.vdf$log2FoldChange > 0, "Up", "Down"), "NS")
.lab <- subset(.vdf, sig != "NS" & !is.na(padj))
.lab <- .lab[order(.lab$padj), ]
if (nrow(.lab) > {int(top_n)}) .lab <- .lab[1:{int(top_n)}, ]
suppressMessages(library(ggplot2))
.gg <- ggplot(.vdf, aes(log2FoldChange, neglog10p, colour=sig)) +
  geom_point(size=0.7, alpha=0.7) +
  scale_colour_manual(values=c(Up="#c1666b", Down="#5a7fa8", NS="grey70")) +
  geom_vline(xintercept=c(-{lfc}, {lfc}), linetype="dashed") +
  geom_hline(yintercept=-log10({padj}), linetype="dashed") +
  labs(title="{t}", x="log2 fold change", y="-log10 p-value", colour=NULL) +
  theme_classic(base_size=14)
if (requireNamespace("ggrepel", quietly=TRUE) && nrow(.lab) > 0)
  .gg <- .gg + ggrepel::geom_text_repel(data=.lab, aes(label=gene), size=3, max.overlaps=20, show.legend=FALSE)
mpfig_plot()
print(.gg)
'''


class UploadRequest(BaseModel):
    counts_csv: str
    coldata_csv: str


@router.post("/api/rnaseq/upload")
def upload(body: UploadRequest):
    try:
        counts = pd.read_csv(io.StringIO(body.counts_csv), index_col=0)
        coldata = pd.read_csv(io.StringIO(body.coldata_csv), index_col=0)
    except Exception as e:  # noqa: BLE001
        return {"error": f"Parse error: {e}"}

    counts.columns = [str(c) for c in counts.columns]
    coldata.index = [str(i) for i in coldata.index]
    common = [s for s in coldata.index if s in counts.columns]
    if not common:
        return {"error": "No sample names shared between counts columns and coldata rows."}

    # factor columns + their levels (non-numeric, low-cardinality)
    factors = {}
    for col in coldata.columns:
        ser = coldata[col]
        if ser.dtype == object or ser.nunique() <= max(2, len(common) // 2):
            levels = sorted({str(v) for v in ser.dropna().unique()})
            if 1 < len(levels) <= 20:
                factors[str(col)] = levels

    token = uuid.uuid4().hex[:12]
    _SESS[token] = {"counts_csv": body.counts_csv, "coldata_csv": body.coldata_csv}
    return {
        "token": token,
        "n_genes": int(counts.shape[0]),
        "samples": common,
        "n_samples_matched": len(common),
        "factors": factors,
    }


class RunRequest(BaseModel):
    token: str
    design: str                 # RHS of the formula, e.g. "condition" or "batch + condition"
    contrast_factor: str
    contrast_numerator: str
    contrast_denominator: str
    min_count: int = 10
    lfc_shrink: bool = True


def _deseq2_code(body: RunRequest) -> str:
    fac = _resc(body.contrast_factor)
    num = _resc(body.contrast_numerator)
    den = _resc(body.contrast_denominator)
    design = _resc(body.design.strip() or body.contrast_factor)
    shrink = "TRUE" if body.lfc_shrink else "FALSE"
    volcano = _volcano_ggplot("resdf", 0.05, 1.0, 15, "Volcano")
    return f'''
las_stage("loading", 0.05)
counts <- as.matrix(read.csv("counts.csv", row.names=1, check.names=FALSE))
coldata <- read.csv("coldata.csv", row.names=1, check.names=FALSE, stringsAsFactors=TRUE)
counts <- counts[, rownames(coldata), drop=FALSE]
counts[is.na(counts)] <- 0
storage.mode(counts) <- "integer"
suppressMessages(library(DESeq2)); suppressMessages(library(ggplot2))
fac <- "{fac}"; num <- "{num}"; den <- "{den}"
coldata[[fac]] <- relevel(factor(coldata[[fac]]), ref=den)
las_stage("DESeq", 0.2)
dds <- DESeqDataSetFromMatrix(countData=counts, colData=coldata, design=as.formula("~ {design}"))
dds <- dds[rowSums(counts(dds)) >= {int(body.min_count)}, ]
dds <- DESeq(dds)
las_stage("results", 0.55)
res <- results(dds, contrast=c(fac, num, den))
coefname <- paste0(fac, "_", num, "_vs_", den)
if ({shrink} && coefname %in% resultsNames(dds)) {{
  res <- tryCatch({{ suppressMessages(library(apeglm)); lfcShrink(dds, coef=coefname, type="apeglm") }},
                  error=function(e) res)
}}
resdf <- as.data.frame(res)
resdf <- cbind(gene=rownames(resdf), resdf)
resdf <- resdf[order(resdf$padj), ]
mpfig_data(resdf, "deseq2_results")

las_stage("plots", 0.75)
{volcano}
mpfig_plot()
print(ggplot(resdf, aes(baseMean, log2FoldChange, colour=(!is.na(padj) & padj < 0.05))) +
        geom_point(size=0.6, alpha=0.6) + scale_x_log10() +
        scale_colour_manual(values=c(`FALSE`="grey70", `TRUE`="#c1666b"), guide="none") +
        labs(title="MA plot", x="mean of normalized counts", y="log2 fold change") +
        theme_classic(base_size=14))

vsd <- tryCatch(vst(dds, blind=FALSE), error=function(e) varianceStabilizingTransformation(dds, blind=FALSE))
pcd <- plotPCA(vsd, intgroup=fac, returnData=TRUE)
pv <- round(100 * attr(pcd, "percentVar"))
mpfig_plot()
print(ggplot(pcd, aes(PC1, PC2, colour=.data[[fac]])) + geom_point(size=3) +
        labs(title="PCA (vst)", x=paste0("PC1: ", pv[1], "%"), y=paste0("PC2: ", pv[2], "%"), colour=fac) +
        theme_classic(base_size=14))

suppressMessages(library(pheatmap))
sampleDists <- dist(t(assay(vsd)))
mpfig_plot()
pheatmap(as.matrix(sampleDists), clustering_distance_rows=sampleDists,
         clustering_distance_cols=sampleDists, main="Sample-to-sample distances")

rv <- apply(assay(vsd), 1, var)
topv <- head(order(rv, decreasing=TRUE), 30)
mat <- assay(vsd)[topv, , drop=FALSE]; mat <- mat - rowMeans(mat)
mpfig_plot()
pheatmap(mat, annotation_col=as.data.frame(colData(vsd)[, fac, drop=FALSE]),
         main="Top 30 variable genes (vst, centered)")
las_stage("done", 1.0)
'''


@router.post("/api/rnaseq/run")
def run(body: RunRequest):
    sess = _SESS.get(body.token)
    if not sess:
        return {"job_id": None, "error": "Session expired — please re-upload."}
    job_id = rjobs.start_r_job(
        _deseq2_code(body),
        inputs={"counts.csv": sess["counts_csv"], "coldata.csv": sess["coldata_csv"]},
        timeout=1800,
    )
    return {"job_id": job_id}


@router.get("/api/rnaseq/status/{job_id}")
def status(job_id: str):
    return rjobs.status(job_id)


class VolcanoRequest(BaseModel):
    results_csv: str                # the deseq2_results table CSV
    padj: float = 0.05
    lfc: float = 1.0
    top_n: int = 15
    title: str = "Volcano"


@router.post("/api/rnaseq/volcano")
def volcano(body: VolcanoRequest):
    """Re-render only the volcano from an existing results table at new padj /
    |log2FC| thresholds — no DESeq2 re-run. Synchronous via the R bridge."""
    code = _volcano_ggplot("data", body.padj, body.lfc, body.top_n, body.title)
    return r_bridge.run_r(r_bridge.RunRRequest(code=code, data_csv=body.results_csv, timeout_sec=120))
