I now have a complete picture of the architecture, the bridge, the prelude helpers, the upload commands, and the established tab pattern. Here is the design doc.

---

# Spatial Transcriptomics Tab — Design Doc

Lab Analysis Suite. Built to match the existing tab pattern: Python endpoints under `/api/spatial/*` do file parsing/validation + orchestration; the analysis + plots run in **R via an `Rscript` subprocess**. Because the pipeline far exceeds the 120 s `run-r` timeout, this tab uses a **long-running async job** (not `run-r`), modeled on multipanelfigure's `alignZStack` / `pollAlignStatus`.

A critical constraint shapes everything below: **R is the user's own install, no bundled packages**. Spatial analysis depends on the **Seurat** stack, which on the user's machine must install **without a compiler toolchain**. That is feasible via binary repos (P3M / CRAN / Bioconductor binaries) and is the single biggest install-time risk — handled explicitly in §5.

---

## 1. Platform scope + recommendation

| Platform | Output dir shape | R support today | Verdict |
|---|---|---|---|
| **10x Visium** (spot-based) | Space Ranger `outs/` (`filtered_feature_bc_matrix/` + `spatial/`) | `Seurat::Load10X_Spatial` — first-class | **v1 primary** ✅ |
| **Visium HD** (2/8/16 µm bins) | Space Ranger `outs/binned_outputs/square_0##um/` | `Load10X_Spatial(bin.size=...)` in Seurat ≥5.1; 8µm bin is huge (>1M bins → on-disk `BPCells`) | **v1.1 fork** (8µm only, behind a flag) |
| **Xenium** (imaging, single-cell, ~400 genes) | Xenium bundle (`cell_feature_matrix/`, `cells.parquet`, morphology OME-TIFF) | `LoadXenium`; needs `arrow` for parquet; FOV/`ImageDimPlot` API differs sharply | **v2 fork** |
| **CosMx / SMI** (imaging) | flat-file export (exprMat, metadata, fov_positions) | `LoadNanostring` / community loaders; messy, version-drift | **v2 fork** |

**Recommendation — v1 = Visium only.** Visium is the most common, has the cleanest loader (`Load10X_Spatial`), one canonical directory layout, and a stable Seurat API. Imaging platforms (Xenium/CosMx) are not just "another loader" — they have single-cell resolution (no deconvolution needed, different QC), millions of cells, FOV-tiled coordinates, and a different plotting family (`ImageDimPlot`/`ImageFeaturePlot` vs `SpatialDimPlot`). Forcing them into one tab would compromise the Visium UX.

**Architect the tab so the fork is a `platform` enum, not a rewrite.** Python validates the folder and emits a `platform` field (`visium` / `visium_hd` / `xenium` / `cosmx`); the R driver dispatches on it. v1 only accepts `visium`; the others return a clear "not yet supported in v1" validation error. This makes Visium HD and Xenium additive later.

**Decision fork F1 — platforms in v1.** → **Recommend: Visium spot-based only.** Visium HD behind a feature flag in v1.1 (it reuses 90% of the pipeline but needs `BPCells` on-disk matrices for the 8µm bin — a different memory story). Xenium/CosMx are v2.

---

## 2. Input formats

Two entry paths, surfaced as a toggle in the uploader.

### A) Space Ranger output folder (primary)

The user picks **one folder** via a native directory dialog. Because these dirs are large (HE/fluorescence TIFF often 50–500 MB), use the **from-disk** path (`upload_files_from_paths`), never base64. Expected layout (Space Ranger `outs/`):

```
<sample>/
  filtered_feature_bc_matrix/          # (or filtered_feature_bc_matrix.h5)
    matrix.mtx.gz  features.tsv.gz  barcodes.tsv.gz
  spatial/
    tissue_lowres_image.png            # used for the overlay (low-res)
    tissue_hires_image.png             # optional, sharper overlay
    scalefactors_json.json             # spot-diameter + image scale factors
    tissue_positions.csv               # (older: tissue_positions_list.csv, no header)
    aligned_fiducials.jpg              # optional, ignored
```

`Load10X_Spatial` needs the matrix **and** the `spatial/` dir together; the image + scalefactors are what make spatial plots possible (§4). Accept both the `.h5` (`filtered_feature_bc_matrix.h5`) and the MTX-triplet form — Python detects which is present and tells R via `matrix_kind`.

**Folder-upload mechanics.** The native dialog returns a directory path. Tauri walks it and calls `upload_files_from_paths` with the **relative-path-preserving** file list, or — better for a directory tree — a new thin Rust command `register_input_dir(path)` that POSTs just the **absolute folder path** to `/api/spatial/register-folder` and lets Python read it in place from disk (no copy of a 500 MB TIFF through HTTP). Recommend the **register-folder** approach: it's a desktop app, the sidecar runs locally, reading the user's folder in place is fastest and avoids duplicating big TIFFs.

> **Decision fork F2 — move bytes vs. read-in-place.** → **Recommend: read-in-place** (`register_input_dir` posts the path; Python validates and hands R the path). Falls back to `upload_files_from_paths` if the folder is on a network share the sidecar can't reach. This mirrors the project note that "large inputs should use the from-disk path."

### B) Pre-built Seurat `.rds` (power-user path)

A single `.rds` holding a Seurat object that already has a `SlideSeq`/`VisiumV1`/`VisiumV2` image in `obj@images`. The user picks the file; Python registers the path; R does `readRDS()` and **skips load+QC+SCT**, jumping to the stage the user selects (e.g. re-cluster, or just re-plot). Validate in R that `class(obj) == "Seurat"` and `length(obj@images) >= 1`, else error. This is the escape hatch for objects produced elsewhere (e.g. a lab's standard pipeline) and for re-plotting without recomputation.

**Reference (label transfer / deconvolution, fork in §3.4):** an optional **second** `.rds` — an annotated scRNA-seq reference Seurat object with a metadata column of cell-type labels (user names the column). Or, for RCTD, a reference counts matrix + a cell-type factor.

---

## 3. The workflow (Seurat-spatial), with tunable params

R driver = `spatial_pipeline.R`, invoked by Python as an `Rscript` subprocess (§6). It prints **stage markers** to stdout that Python parses for progress (§6). The pipeline is staged so the UI can show where it is and so the `.rds` entry can resume mid-pipeline.

### Stage 0 — Load
```r
obj <- Load10X_Spatial(
  data.dir   = data_dir,
  filename   = matrix_filename,      # "filtered_feature_bc_matrix.h5" or dir
  assay      = "Spatial",
  slice      = sample_name,
  filter.matrix = TRUE
)
```
Emit `##STAGE:load:done`. For the `.rds` path, `obj <- readRDS(path)` instead.

### Stage 1 — QC (params exposed)
Spatial QC differs from droplet scRNA: low-count spots are often real tissue edges, so be gentle.
```r
obj[["percent.mt"]] <- PercentageFeatureSet(obj, pattern = mt_pattern)  # "^MT-" human / "^mt-" mouse
# filter
obj <- subset(obj,
  subset = nFeature_Spatial >= min_features &
           nCount_Spatial   >= min_counts &
           percent.mt       <= max_pct_mt)
```
| UI param | Default | Notes |
|---|---|---|
| `min_features` (genes/spot) | 200 | Visium spots ≈ 1–10 cells; lower than scRNA |
| `min_counts` (UMI/spot) | 500 | |
| `max_pct_mt` | 30 | high MT = dying/edge spots |
| `mt_pattern` | `^MT-` | switch to `^mt-` for mouse (species selector) |
| `remove_mt_ribo_genes` | false | optionally drop MT/ribo genes from variable set |

Emit a **pre-filter vs post-filter spot count** for the QC table, plus violin plots (§4). Emit `##STAGE:qc:done`.

### Stage 2 — Normalization
**`SCTransform` with `assay="Spatial"`** is the Seurat-recommended spatial normalization (handles the strong technical depth variance across spots better than global log-norm).
```r
obj <- SCTransform(obj, assay = "Spatial", verbose = FALSE,
                   variable.features.n = n_hvg,        # default 3000
                   vst.flavor = "v2")
```
Emit `##STAGE:sct:done`.

> **Decision fork F3 — normalization.** → **Recommend: SCTransform (spatial).** It's the Seurat-documented default for Visium and gives better spatial feature plots. Alternative = classic `NormalizeData → FindVariableFeatures → ScaleData` (LogNormalize); expose it as a radio (`SCTransform` / `LogNormalize`) because SCT is RAM-heavier and slower, and some users prefer log-norm for comparability with their scRNA pipeline. The chosen assay name (`SCT` vs `Spatial`) flows into all downstream `assay=` args.

### Stage 3 — Dimensionality reduction + clustering
```r
obj <- RunPCA(obj, assay = active_assay, npcs = 50, verbose = FALSE)
obj <- FindNeighbors(obj, dims = 1:n_dims)            # n_dims default 30
obj <- FindClusters(obj, resolution = cluster_res,   # default 0.8
                    verbose = FALSE)
obj <- RunUMAP(obj, dims = 1:n_dims)
```
| UI param | Default |
|---|---|
| `n_hvg` | 3000 |
| `n_dims` (PCs) | 30 |
| `cluster_res` | 0.8 |
UMAP needs `uwot` (CRAN binary). Emit `##STAGE:cluster:done` and `##STAGE:umap:done`.

### Stage 4 — Spatial plots
`SpatialDimPlot` (clusters on tissue) + `SpatialFeaturePlot` (gene / QC metric on tissue) — see §4. These **require the tissue image** to be present in `obj@images` (it is, from `Load10X_Spatial`). Emit `##STAGE:spatialplots:done`.

### Stage 5 — Cluster markers
```r
markers <- FindAllMarkers(obj, assay = "SCT", only.pos = TRUE,
                          min.pct = 0.25, logfc.threshold = 0.25)
```
(For SCT assay, run `PrepSCTFindMarkers(obj)` first.) Emit top-N per cluster as a table. Emit `##STAGE:markers:done`.

### Stage 6 — Spatially variable features (Moran's I)
```r
obj <- FindSpatiallyVariableFeatures(
  obj, assay = "SCT",
  features = VariableFeatures(obj)[1:1000],   # cap for runtime
  selection.method = "moransi")               # "markvariogram" = slower, needs sf/spatstat
svf <- SpatiallyVariableFeatures(obj, method = "moransi")
```
**`moransi` needs the `Rfast2` package** (much faster than `markvariogram`). Cap the candidate feature set (default top 1000 HVGs) — running on all genes is very slow. Emit the ranked SVF table + a panel of `SpatialFeaturePlot` for the top SVGs. Emit `##STAGE:svf:done`.

> **Decision fork F4 — SVF method.** → **Recommend: `moransi` (+`Rfast2`)**, capped to top 1000 HVGs. `markvariogram` is the classic method but is slow and pulls heavier geospatial deps. Expose method as an advanced option.

### Stage 7 (optional fork) — Reference integration: deconvolution / label transfer

Visium spots are multi-cell, so users frequently want cell-type composition. Three families, increasing in cost:

1. **Seurat anchor label transfer** (`FindTransferAnchors` + `TransferData`) — gives a per-spot **predicted-celltype score matrix**; pure Seurat, no new heavy deps, runs in the same R process. **Lightweight.**
2. **`spacexr::RCTD`** (a.k.a. *spacexr*) — proper spot **deconvolution** (cell-type proportions per spot), the field standard for Visium. From GitHub, **needs compilation-free install path** — see §5 risk.
3. **cell2location** — Python/PyTorch/GPU, **out of scope** for an R-in-a-desktop-app (would mean shipping a torch env). Note it and decline.

> **Decision fork F5 — deconvolution in scope?** → **Recommend for v1: Seurat anchor label transfer ON (optional, behind a "Reference integration" accordion); RCTD behind an "advanced (installs spacexr)" toggle; cell2location out of scope.** Anchor transfer needs no extra packages beyond Seurat and answers most users' "what cell types are here" question well enough to ship. Offer RCTD as an opt-in because it's the gold standard, but gate it on a package install the user explicitly accepts (§5).

The reference path: user supplies the annotated scRNA `.rds` + names the label column → R runs `SCTransform` on the reference (if needed) → `FindTransferAnchors(reference, query=spatial, normalization.method="SCT")` → `TransferData` → store predictions as an assay → `SpatialFeaturePlot` of selected cell-type scores + a per-cluster composition table. Emit `##STAGE:integration:done`.

---

## 4. Outputs

### Tables (each written by `mpfig_data(df, name)` — surfaces in the results panel + CSV export)
- `qc_summary` — n spots pre/post filter, median genes/spot, median UMI/spot, median %MT, per-sample.
- `cluster_spot_counts` — cluster, n_spots, % of tissue.
- `cluster_markers` — gene, cluster, avg_log2FC, pct.1, pct.2, p_val_adj (top N per cluster, N configurable, default 25).
- `spatially_variable_genes` — gene, moransi observed, p-value, rank (top 100).
- `celltype_composition` *(if integration run)* — cluster × predicted cell type proportion.

### Figures (each via `mpfig_plot(filename, width, height, res)` → returned as base64 PNG)
The results panel already supports TIFF/PNG/SVG export of returned plots.
- `01_qc_violin` — `VlnPlot(nFeature/nCount/percent.mt)`.
- `02_qc_spatial` — `SpatialFeaturePlot(features=c("nCount_Spatial"))` (counts overlaid on tissue → reveals tissue-quality gradients).
- `03_umap_clusters` — `DimPlot(reduction="umap", label=TRUE)`.
- `04_spatial_clusters` — `SpatialDimPlot(obj, label=TRUE, label.size=3)` (clusters painted on the tissue image).
- `05_spatial_features` — `SpatialFeaturePlot(features = user_selected_genes)` (user picks genes; default = top SVGs).
- `06_top_svg_panel` — multi-panel `SpatialFeaturePlot` of top Moran's-I genes.
- `07_celltype_spatial` *(if integration)* — `SpatialFeaturePlot` of predicted cell-type scores.

**How the tissue image flows into the PNG (the key spatial detail).** `Load10X_Spatial` reads `spatial/tissue_lowres_image.png` + `scalefactors_json.json` and stores them inside `obj@images[[slice]]` (a `VisiumV1`/`VisiumV2` object holding the raster + spot coordinates in image pixel space). `SpatialDimPlot`/`SpatialFeaturePlot` are ggplot layers that draw that raster as the background and overlay spot points at the scaled coordinates. So **as long as the `spatial/` dir was present at load, the image is already inside the object** — `mpfig_plot()` opens the PNG device, we `print(p)`, and the overlay renders into the PNG with no extra image handling. Practical knobs: `image.alpha` (dim the H&E so spots pop), `pt.size.factor` (spot dot size — tune per slide), `crop=TRUE/FALSE`. Use `tissue_hires_image.png` when present for sharper exports; set `mpfig_plot(width=1600, height=1400, res=200)` for publication exports.

> **Decision fork F6 — tissue image handling.** → **Recommend: rely on `Load10X_Spatial`'s built-in image loading (lowres for interactive, hires for export); expose `image.alpha` + `pt.size.factor` + `crop` as sliders.** Don't hand-manage the raster. Only fall back to manual image injection for the `.rds` path if an object arrives without an image (then warn: "no tissue image in object — spatial overlays unavailable, only UMAP/violin").

---

## 5. R package set — CRAN vs Bioc, binary feasibility, sizes, compilation risks

This is the make-or-break section for "user's R, no toolchain."

| Package | Source | Role | Binary available? | ~Size | Compile risk |
|---|---|---|---|---|---|
| **Seurat** | CRAN | whole pipeline | ✅ win/mac binaries; Linux via **P3M** binaries | ~25 MB | none w/ binary |
| **SeuratObject** | CRAN | object/deps | ✅ | ~5 MB | none w/ binary |
| **sctransform** | CRAN | normalization | ✅ | small | none |
| **uwot** | CRAN | UMAP | ✅ | small | none |
| **Rfast2** | CRAN | Moran's I (fast) | ✅ | small | links to `Rfast`/RcppArmadillo — **use binary** |
| **ggplot2 / patchwork / dplyr** | CRAN | plotting/tables | ✅ | small | none |
| **hdf5r** | CRAN | read `.h5` matrix | ✅ win/mac binaries | small | **needs libhdf5 if compiled** → prefer binary, or use MTX path |
| **arrow** | CRAN | (Xenium parquet — v2 only) | ✅ binary | ~40 MB | heavy if compiled — binary only |
| **spacexr (RCTD)** | **GitHub** | deconvolution (opt-in fork) | ❌ no binary; `pak` builds from source but is **pure R + Rcpp** | small | **needs Rcpp compile** → toolchain risk |
| **BPCells** | GitHub | Visium HD on-disk (v1.1 only) | ❌ source, has C++ | — | compile risk (defer) |

**Binary install strategy (no toolchain required).** Drive installs through the existing `/api/analysis/run-console` endpoint, but **point R at binary repos** for the session:

- **Posit Public Package Manager (P3M)** gives **binary** CRAN packages for **Linux too** (the usual pain point — Linux CRAN normally compiles from source). Set:
  ```r
  options(repos = c(P3M = "https://packagemanager.posit.co/cran/__linux__/<distro>/latest"))
  # on win/mac, CRAN already serves binaries:
  options(repos = c(CRAN = "https://cloud.r-project.org"))
  install.packages(c("Seurat","Rfast2","hdf5r","uwot","patchwork"), type = "binary")
  ```
- Use **`pak`** as the installer (`pak::pkg_install(...)`): it resolves the full dependency graph, prefers binaries, and reports what (if anything) needs source. `pak` itself ships as a static binary — install it first.
- Detect OS/distro in Python (`platform.system()` / `/etc/os-release`) and build the right P3M URL; pass it into the console install script.

**Realistic install times (cold, binary):** Seurat + deps ≈ **2–5 min** on a warm broadband connection (it's ~80 transitive packages but all binary). With source compilation (no toolchain → **fails**; with toolchain → 20–40 min). So binaries aren't just faster — for a no-toolchain user they're the **only** path that works.

**Flagged risks / required actions:**
- **`spacexr` (RCTD) has no binary and uses Rcpp → requires a compiler.** This is the one fork that can break on a toolchain-less Windows user. Handling: (a) gate it behind an explicit "Install deconvolution engine (may require build tools)" button; (b) pre-flight `pkgbuild::has_build_tools()` and, if false on Windows, link the user to **Rtools**; on macOS check for the **Xcode CLT** (`xcode-select -p`). If unavailable, keep **Seurat anchor transfer** (no compile) as the always-available deconvolution-lite path.
- **`hdf5r` from source needs libhdf5.** Avoid by preferring the **MTX triplet** load path (no HDF5) and only using `.h5` when a binary `hdf5r` is present. Python picks the MTX path when both exist.
- **External reference data the USER must supply:** none required for the core Visium pipeline. The **only** external data is the **optional** annotated scRNA-seq reference (`.rds`) for the integration fork — the UI must explicitly ask for it (file picker + "name the cell-type column" text field) and clearly mark the whole accordion optional. No genome/transcriptome reference is needed (Space Ranger already did alignment upstream).
- **Package check endpoint:** add `GET /api/spatial/check-packages` → R one-liner returning `installed.packages()` membership for the required set, so the UI can show a green/red checklist and a one-click "Install missing packages" before any run.

---

## 6. Runtime / memory + async job & progress

**Why async (not `run-r`).** A single Visium slide through SCTransform + PCA + clustering + UMAP + FindAllMarkers + Moran's I is **~3–12 min** and **2–8 GB RAM**; with reference integration, 10–25 min. That blows the 120 s `run-r` timeout. Use the **multipanelfigure async job shape**.

**Where R is invoked.** Python `spatial.py` launches `Rscript spatial_pipeline.R --params <json> --workdir <dir>` as a **`subprocess.Popen`** (not the bounded `subprocess.run` in `run-r`), in a background thread, writing params/inputs to a per-job temp workdir and reading stdout line-by-line.

**Progress surfacing — parse R stdout markers.** The R driver prints `##STAGE:<name>:<start|done>` and `##PROGRESS:<0-100>` lines; Python's reader thread maps each marker to `{stage, progress}` in an in-process job registry. Final outputs (plots as base64 PNG, tables as CSV) are written by R to `workdir/plots` + `workdir/tables` (reusing the **exact `mpfig_plot` / `mpfig_data` prelude** so the file conventions match the rest of the app) and collected on completion — identical collection code to `run_r`'s glob-of-PNGs/CSVs.

```python
JOBS: dict[str, dict] = {}   # job_id -> {status, progress, stage, result, error}

STAGE_PROGRESS = {"load":10,"qc":20,"sct":40,"cluster":55,"umap":65,
                  "spatialplots":75,"markers":85,"svf":92,"integration":97}

@router.post("/api/spatial/run")
def run(body: SpatialRunRequest):
    job_id = uuid4().hex
    JOBS[job_id] = {"status":"queued","progress":0,"stage":"queued"}
    threading.Thread(target=_run_job, args=(job_id, body), daemon=True).start()
    return {"job_id": job_id}

@router.get("/api/spatial/status/{job_id}")
def status(job_id: str):
    j = JOBS.get(job_id)
    if not j: return {"status":"unknown"}
    return j  # {status, progress, stage, result|error}
```
`_run_job` resolves Rscript via the existing `_resolve_rscript()` / `_r_env()` from `r_bridge.py` (reused, not duplicated), runs `Popen`, streams stdout, updates `JOBS[job_id]`, and on exit packages `{plots, tables, stdout, stderr}` into `result`. Add `POST /api/spatial/cancel/{job_id}` (kills the process group). Memory guard: refuse to start if the slide's spot count × genes implies >~80% of free RAM (estimate in Python from matrix dims read during validation) and warn the user.

Frontend polling mirrors `pollAlignStatus`: after `run` returns `job_id`, poll `status/{job_id}` every ~1.5 s, render a stepper from `stage` + a progress bar from `progress`, stop on `done`/`error`.

---

## 7. Python endpoints + UI controls + store

### Python (`python-sidecar/spatial.py`, registered in `api_server.py`'s loader loop by adding `"spatial"` to the tuple)
- `POST /api/spatial/register-folder` `{path}` → validates Space Ranger layout, detects `matrix_kind` (h5/mtx) + `platform`, reads matrix dims for the RAM estimate, returns `{ok, platform, n_spots, n_genes, has_image, warnings}`.
- `POST /api/spatial/register-rds` `{path, kind:"object"|"reference"}` → validates it's a Seurat object (quick R probe).
- `GET  /api/spatial/check-packages` → `{installed:[...], missing:[...]}`.
- `POST /api/spatial/install-packages` `{packages, repo_url}` → drives binary install (long-running; can reuse the console pattern or its own job).
- `POST /api/spatial/run` `{folder_path|rds_path, params}` → returns `{job_id}`.
- `GET  /api/spatial/status/{job_id}` ; `POST /api/spatial/cancel/{job_id}`.

### UI (`src/components/spatial/`) — MUI
- **Uploader**: source toggle (Space Ranger folder / Seurat `.rds`); native folder/file picker; validation summary card (platform, #spots, #genes, image found ✓); package checklist with "Install missing".
- **Params panel** (accordions): *QC* (min_features/min_counts/max_pct_mt sliders, species → mt_pattern), *Normalization* (radio SCT/LogNormalize, n_hvg), *Clustering* (n_dims, resolution), *SVF* (method, top-N cap), *Reference integration* (optional accordion: reference `.rds` picker + label-column text field + RCTD toggle), *Plot* (image.alpha, pt.size.factor, crop, feature-gene selector).
- **Run/Results**: Run button → stepper (stages) + progress bar (from `status`); results panel reuses the shared plots/tables component (TIFF/PNG/SVG export already supported), one tab per figure + a tables tab.

### Store (`src/store/spatialStore.ts`, Zustand — matches other tabs)
```ts
interface SpatialState {
  source: 'folder' | 'rds';
  folderPath?: string; rdsPath?: string; referenceRdsPath?: string;
  validation?: { platform: string; nSpots: number; nGenes: number; hasImage: boolean; warnings: string[] };
  packages: { installed: string[]; missing: string[] };
  params: SpatialParams;          // qc, norm, cluster, svf, integration, plot
  job?: { id: string; status: string; stage: string; progress: number };
  result?: { plots: string[]; tables: { name: string; csv: string }[]; stdout: string };
  // actions: registerFolder, registerRds, checkPackages, installPackages,
  //          run, pollStatus, cancel, reset
}
```

---

## 8. Decision forks — consolidated recommendations

| # | Fork | Recommendation | Alternative kept available |
|---|---|---|---|
| **F1** | Platforms in v1 | **Visium spot-based only**; dispatch on a `platform` enum so HD/Xenium are additive | Visium HD v1.1 (flag, `BPCells`); Xenium/CosMx v2 |
| **F2** | Move bytes vs read-in-place | **Read-in-place** (`register_input_dir` posts the path; sidecar reads the folder) | `upload_files_from_paths` fallback for network shares |
| **F3** | Normalization | **SCTransform (spatial)** default | LogNormalize radio for speed/RAM/comparability |
| **F4** | SVF method | **Moran's I + `Rfast2`**, top-1000-HVG cap | `markvariogram` advanced option |
| **F5** | Deconvolution in scope | **Seurat anchor label transfer (optional, no extra deps)**; **RCTD/spacexr opt-in** behind explicit install; **cell2location out of scope** | RCTD for gold-standard proportions when user has build tools |
| **F6** | Tissue image | **Built-in `Load10X_Spatial` image (lowres interactive / hires export)** + alpha/size/crop sliders | Manual raster injection only for image-less `.rds`, with a warning |

**One-line build order:** (1) `register-folder` + validation + package checklist, (2) async job skeleton with stage markers, (3) core Visium pipeline through spatial plots, (4) markers + Moran's I, (5) reference integration fork. Ship after (4); (5) is additive.

---

Relevant existing files this design plugs into (absolute paths):
- `/Users/zhuojianlook/Library/CloudStorage/Dropbox/GitHub Repos/Webtools/Analysis/TauriApp/python-sidecar/r_bridge.py` — reuse `_resolve_rscript()`, `_r_env()`, and the `mpfig_plot`/`mpfig_data` prelude; the async job in `spatial.py` invokes `Rscript` the same way but via `Popen`.
- `/Users/zhuojianlook/Library/CloudStorage/Dropbox/GitHub Repos/Webtools/Analysis/TauriApp/python-sidecar/api_server.py` — add `"spatial"` to the router-loader tuple (line 83).
- `/Users/zhuojianlook/Library/CloudStorage/Dropbox/GitHub Repos/Webtools/Analysis/TauriApp/src-tauri/src/lib.rs` — `upload_files_from_paths` (line 254) for the fallback; add `register_input_dir` alongside it.
- `/Users/zhuojianlook/Library/CloudStorage/Dropbox/GitHub Repos/Webtools/Analysis/TauriApp/src/api/client.ts` + `types.ts` — add `spatialRun`/`spatialStatus` helpers and a `SpatialJobStatus` type next to the existing `runR`/`RunRResponse`.

New files to create: `TauriApp/python-sidecar/spatial.py`, `r-env/rscripts/spatial_pipeline.R`, `TauriApp/src/components/spatial/*`, `TauriApp/src/store/spatialStore.ts`.