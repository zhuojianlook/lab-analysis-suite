"""Spatial transcriptomics (10x Visium, Seurat).

Register a Space Ranger output folder (filtered_feature_bc_matrix(.h5) + spatial/)
or a saved .rds; the pipeline runs as an async R job: load -> QC -> SCTransform
-> PCA -> clustering -> UMAP -> spatial cluster/feature plots -> spatially
variable features (Moran's I). Packages install via the 'spatial' manifest.
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


class RegisterRequest(BaseModel):
    path: str


@router.post("/api/spatial/register")
def register(body: RegisterRequest):
    if not os.path.exists(body.path):
        return {"error": f"Path not found: {body.path}"}
    if os.path.isdir(body.path):
        files = os.listdir(body.path)
        has_mat = any(f.startswith("filtered_feature_bc_matrix") for f in files) or "filtered_feature_bc_matrix.h5" in files
        has_sp = "spatial" in files
        if not (has_mat and has_sp):
            return {"error": "Folder must be a Space Ranger output with a filtered_feature_bc_matrix(.h5) and a spatial/ subfolder."}
        t = "visium_dir"
    elif body.path.lower().endswith(".rds"):
        t = "rds"
    else:
        return {"error": "Provide a Space Ranger output folder or a saved .rds Seurat object."}
    token = uuid.uuid4().hex[:12]
    _SESS[token] = {"path": body.path, "type": t}
    return {"token": token, "input_type": t, "path": body.path}


class RunRequest(BaseModel):
    token: str
    species: str = "human"
    normalization: str = "SCT"        # SCT | LogNormalize
    dims: int = 30
    resolution: float = 0.8
    n_svf: int = 1000


def _spatial_code(body: RunRequest, path: str, input_type: str) -> str:
    p = _resc(path)
    mito = "^MT-" if body.species == "human" else "^mt-"
    load = (f'obj <- Load10X_Spatial("{p}")\n' if input_type == "visium_dir"
            else f'obj <- readRDS("{p}")\n')
    if body.normalization == "SCT":
        norm = 'obj <- SCTransform(obj, assay="Spatial", verbose=FALSE)\n.assay <- "SCT"\n'
    else:
        norm = ('obj <- NormalizeData(obj, assay="Spatial", verbose=FALSE)\n'
                'obj <- FindVariableFeatures(obj, assay="Spatial", verbose=FALSE)\n'
                'obj <- ScaleData(obj, assay="Spatial", verbose=FALSE)\n.assay <- "Spatial"\n')
    return f'''
suppressMessages({{ library(Seurat); library(ggplot2) }})
las_stage("loading", 0.05)
{load}
las_stage("QC", 0.15)
obj[["percent.mt"]] <- PercentageFeatureSet(obj, pattern="{mito}")
mpfig_plot(width=1200, height=500); print(VlnPlot(obj, features=c("nCount_Spatial","nFeature_Spatial"), pt.size=0, ncol=2))
mpfig_plot(); print(SpatialFeaturePlot(obj, features="nCount_Spatial"))
las_stage("normalize", 0.35)
{norm}
DefaultAssay(obj) <- .assay
las_stage("dimred", 0.55)
obj <- RunPCA(obj, assay=.assay, verbose=FALSE)
obj <- FindNeighbors(obj, dims=1:{int(body.dims)}, verbose=FALSE)
obj <- FindClusters(obj, resolution={body.resolution}, verbose=FALSE)
obj <- RunUMAP(obj, dims=1:{int(body.dims)}, verbose=FALSE)
mpfig_plot(); print(DimPlot(obj, reduction="umap", label=TRUE) + ggtitle("Clusters"))
mpfig_plot(); print(SpatialDimPlot(obj, label=TRUE, label.size=3))
mpfig_data(as.data.frame(table(Idents(obj))), "cluster_spot_counts")
las_stage("markers", 0.7)
markers <- tryCatch(FindAllMarkers(obj, only.pos=TRUE, min.pct=0.1, logfc.threshold=0.25, verbose=FALSE),
                    error=function(e) {{ las_error(conditionMessage(e)); data.frame() }})
if (nrow(markers) > 0) mpfig_data(markers, "cluster_markers")
las_stage("svf", 0.85)
obj <- tryCatch(FindSpatiallyVariableFeatures(obj, assay=.assay,
        features=head(VariableFeatures(obj), {int(body.n_svf)}), selection.method="moransi"),
        error=function(e) {{ las_error(conditionMessage(e)); obj }})
svf <- tryCatch(SpatiallyVariableFeatures(obj, selection.method="moransi"),
        error=function(e) tryCatch(SpatiallyVariableFeatures(obj, method="moransi"), error=function(e2) character(0)))
if (length(svf) > 0) {{
  mpfig_plot(width=1300, height=900); print(SpatialFeaturePlot(obj, features=head(svf, 6), ncol=3))
  mpfig_data(data.frame(feature=head(svf, 50)), "spatially_variable_genes")
}}
las_stage("done", 1.0)
'''


@router.post("/api/spatial/run")
def run(body: RunRequest):
    sess = _SESS.get(body.token)
    if not sess:
        return {"job_id": None, "error": "Session expired — please re-register the data path."}
    job_id = rjobs.start_r_job(_spatial_code(body, sess["path"], sess["type"]), inputs=None, timeout=3600)
    return {"job_id": job_id}


@router.get("/api/spatial/status/{job_id}")
def status(job_id: str):
    return rjobs.status(job_id)
