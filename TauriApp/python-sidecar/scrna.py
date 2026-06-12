"""Single-cell RNA-seq analysis (Seurat v5).

The user registers a local data path (a 10x Cell Ranger folder, a .h5, a counts
.csv, an .h5ad, or a saved .rds Seurat object); the pipeline runs as an async R
job: QC -> filter -> normalize (LogNormalize/SCT) -> HVG -> PCA -> (Harmony
integration) -> UMAP -> clustering -> markers -> optional SingleR annotation.
Packages install on first use via the 'scrnaseq' manifest.
"""

from __future__ import annotations

import os
import uuid
from typing import Dict

from fastapi import APIRouter
from pydantic import BaseModel

import rjobs

router = APIRouter()

_SESS: Dict[str, dict] = {}


def _resc(s: str) -> str:
    return str(s).replace("\\", "\\\\").replace('"', '\\"')


def _detect(path: str) -> str:
    if os.path.isdir(path):
        try:
            files = os.listdir(path)
        except Exception:  # noqa: BLE001
            return "unknown"
        if any(f.startswith("matrix.mtx") for f in files):
            return "10x_dir"
        return "dir"
    low = path.lower()
    if low.endswith(".h5"):
        return "h5"
    if low.endswith(".h5ad"):
        return "h5ad"
    if low.endswith(".rds"):
        return "rds"
    if low.endswith((".csv", ".tsv", ".txt", ".csv.gz", ".tsv.gz")):
        return "csv"
    return "unknown"


class RegisterRequest(BaseModel):
    path: str


@router.post("/api/scrna/register")
def register(body: RegisterRequest):
    if not os.path.exists(body.path):
        return {"error": f"Path not found: {body.path}"}
    t = _detect(body.path)
    if t in ("unknown", "dir"):
        return {"error": "Unrecognized input. Provide a 10x folder (matrix.mtx + barcodes + features), a .h5, .h5ad, .rds, or a counts .csv."}
    token = uuid.uuid4().hex[:12]
    _SESS[token] = {"path": body.path, "type": t}
    return {"token": token, "input_type": t, "path": body.path}


class RunRequest(BaseModel):
    token: str
    species: str = "human"            # human | mouse
    min_cells: int = 3
    min_features: int = 200
    max_features: int = 6000
    max_counts: int = 40000
    max_mito: float = 15.0
    normalization: str = "LogNormalize"   # LogNormalize | SCT
    nfeatures: int = 2000
    npcs: int = 50
    dims: int = 30
    resolution: float = 0.8
    integration: str = "none"         # none | harmony
    annotation: str = "none"          # none | singler
    orientation: str = "genes_rows"   # csv only: genes_rows | cells_rows
    max_cells: int = 200000
    use_bpcells: bool = False


def _read_block(path: str, input_type: str, orientation: str) -> str:
    p = _resc(path)
    if input_type == "10x_dir":
        return f'counts <- Seurat::Read10X("{p}")\nobj <- CreateSeuratObject(counts, min.cells=MINC, min.features=MINF)\n'
    if input_type == "h5":
        return f'counts <- Seurat::Read10X_h5("{p}")\nif (is.list(counts)) counts <- counts[[1]]\nobj <- CreateSeuratObject(counts, min.cells=MINC, min.features=MINF)\n'
    if input_type == "rds":
        return f'obj <- readRDS("{p}")\nif (!inherits(obj, "Seurat")) las_error("RDS is not a Seurat object")\n'
    if input_type == "h5ad":
        return (f'if (!requireNamespace("schard", quietly=TRUE)) las_error("Reading .h5ad needs the schard package")\n'
                f'obj <- schard::h5ad2seurat("{p}")\n')
    # csv
    transpose = "counts <- t(counts)\n" if orientation == "cells_rows" else ""
    return (f'counts <- as.matrix(data.table::fread("{p}"), rownames=1)\n{transpose}'
            f'counts <- as(counts, "CsparseMatrix")\nobj <- CreateSeuratObject(counts, min.cells=MINC, min.features=MINF)\n')


def _scrna_code(body: RunRequest, path: str, input_type: str) -> str:
    mito = "^MT-" if body.species == "human" else "^mt-"
    norm_block = (
        'obj <- SCTransform(obj, vars.to.regress=NULL, verbose=FALSE)\n.assay <- "SCT"\n'
        if body.normalization == "SCT" else
        'obj <- NormalizeData(obj, verbose=FALSE)\n'
        f'obj <- FindVariableFeatures(obj, nfeatures={int(body.nfeatures)}, verbose=FALSE)\n'
        'obj <- ScaleData(obj, verbose=FALSE)\n.assay <- "RNA"\n'
    )
    integ_block = (
        'if (length(unique(obj$orig.ident)) > 1 && requireNamespace("harmony", quietly=TRUE)) {\n'
        '  obj <- harmony::RunHarmony(obj, group.by.vars="orig.ident")\n  .red <- "harmony"\n'
        '} else .red <- "pca"\n'
        if body.integration == "harmony" else '.red <- "pca"\n'
    )
    singler_block = (
        '\nlas_stage("annotation", 0.9)\n'
        'if (requireNamespace("SingleR", quietly=TRUE) && requireNamespace("celldex", quietly=TRUE)) {\n'
        '  ref <- tryCatch(celldex::HumanPrimaryCellAtlasData(), error=function(e) NULL)\n'
        '  if (!is.null(ref)) {\n'
        '    pred <- SingleR::SingleR(test=as.matrix(Seurat::GetAssayData(obj, layer="data")), ref=ref, labels=ref$label.main)\n'
        '    obj$SingleR <- pred$labels\n'
        '    mpfig_plot(); print(Seurat::DimPlot(obj, group.by="SingleR", label=TRUE, reduction="umap") + ggplot2::theme(legend.position="right"))\n'
        '    mpfig_data(as.data.frame(table(obj$SingleR)), "cell_type_counts")\n'
        '  }\n}\n'
        if body.annotation == "singler" else ""
    )
    read_block = _read_block(path, input_type, body.orientation)

    return f'''
suppressMessages({{ library(Seurat); library(ggplot2) }})
MINC <- {int(body.min_cells)}; MINF <- {int(body.min_features)}
las_stage("loading", 0.05)
{read_block}
DefaultAssay(obj) <- "RNA"
las_stage("QC", 0.15)
obj[["percent.mt"]] <- PercentageFeatureSet(obj, pattern="{mito}")
mpfig_plot(width=1400, height=700)
print(VlnPlot(obj, features=c("nFeature_RNA","nCount_RNA","percent.mt"), ncol=3, pt.size=0))
mpfig_data(data.frame(metric=c("cells_pre"), value=c(ncol(obj))), "qc_summary")

# downsample huge datasets unless BPCells is requested
if (ncol(obj) > {int(body.max_cells)} && !{str(body.use_bpcells).upper()}) {{
  set.seed(1); obj <- obj[, sample(colnames(obj), {int(body.max_cells)})]
}}
las_stage("filter", 0.25)
obj <- subset(obj, subset = nFeature_RNA > {int(body.min_features)} & nFeature_RNA < {int(body.max_features)} & nCount_RNA < {int(body.max_counts)} & percent.mt < {body.max_mito})

las_stage("normalize", 0.4)
{norm_block}
las_stage("PCA", 0.55)
obj <- RunPCA(obj, npcs={int(body.npcs)}, verbose=FALSE)
mpfig_plot(width=900, height=700); print(ElbowPlot(obj, ndims={int(body.npcs)}))
{integ_block}
las_stage("cluster", 0.7)
obj <- FindNeighbors(obj, reduction=.red, dims=1:{int(body.dims)}, verbose=FALSE)
obj <- FindClusters(obj, resolution={body.resolution}, verbose=FALSE)
obj <- RunUMAP(obj, reduction=.red, dims=1:{int(body.dims)}, verbose=FALSE)
mpfig_plot(); print(DimPlot(obj, reduction="umap", label=TRUE) + ggtitle("Clusters"))
if (length(unique(obj$orig.ident)) > 1) {{ mpfig_plot(); print(DimPlot(obj, reduction="umap", group.by="orig.ident")) }}
mpfig_data(as.data.frame(table(Idents(obj))), "cluster_sizes")

las_stage("markers", 0.82)
markers <- tryCatch(FindAllMarkers(obj, only.pos=TRUE, min.pct=0.1, logfc.threshold=0.25, verbose=FALSE),
                    error=function(e) {{ las_error(conditionMessage(e)); data.frame() }})
if (nrow(markers) > 0) {{
  mpfig_data(markers, "cluster_markers")
  top <- do.call(rbind, by(markers, markers$cluster, function(d) head(d[order(-d$avg_log2FC), ], 5)))
  mpfig_plot(width=1400, height=900); print(DotPlot(obj, features=unique(top$gene)) + ggplot2::coord_flip() + ggplot2::theme(axis.text.x=ggplot2::element_text(angle=45, hjust=1)))
}}
{singler_block}
las_stage("done", 1.0)
'''


@router.post("/api/scrna/run")
def run(body: RunRequest):
    sess = _SESS.get(body.token)
    if not sess:
        return {"job_id": None, "error": "Session expired — please re-register the data path."}
    code = _scrna_code(body, sess["path"], sess["type"])
    job_id = rjobs.start_r_job(code, inputs=None, timeout=3600)
    return {"job_id": job_id}


@router.get("/api/scrna/status/{job_id}")
def status(job_id: str):
    return rjobs.status(job_id)
