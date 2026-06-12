# scRNA-seq Analysis Tab — Implementation Design (Seurat v5, R)

This design slots into the existing patterns I verified in the repo:
- The shared R bridge (`TauriApp/python-sidecar/r_bridge.py`) with its prelude (`data<-read.csv`, `mpfig_plot()`, `mpfig_data()`), `Rscript` subprocess invocation, and `_resolve_rscript()` host-R discovery.
- The Rust upload commands `proxy_upload` (base64) and `upload_files_from_paths` (from disk) in `TauriApp/src-tauri/src/lib.rs`, both POSTing multipart to a sidecar endpoint.
- The frontend client (`TauriApp/src/api/client.ts`) and `apiJson`/`apiRequest`/`uploadFiles` helpers.
- New convention: **R is the user's local install, no bundled packages.**

The key departure from the other tabs: the shared `/api/analysis/run-r` is **unusable** here (120 s cap, CSV-only data channel, single subprocess, base64 PNGs in RAM). scRNA-seq needs minutes-to-tens-of-minutes runs, binary inputs (mtx/h5/rds), and a persistent on-disk object. So this tab gets its **own router with a long-running async job pattern** (mirroring multipanelfigure's `alignZStack`/`pollAlignStatus`), and R is invoked as a **direct `Rscript` subprocess** that writes plots to a job directory rather than through the shared bridge.

---

## 1. ENGINE recommendation

**Recommend: Seurat v5 (CRAN) as the analysis engine, with `BPCells` on-disk matrices for large datasets.**

| Engine | Pros | Cons | Fit here |
|---|---|---|---|
| **Seurat v5** (R) | De-facto standard; one object holds counts+embeddings+metadata; native ggplot output (`DimPlot`, `FeaturePlot`, `VlnPlot`, `DotPlot`) drops straight into `mpfig_plot`; v5 `BPCells` layer streams matrices from disk → handles 1M+ cells in modest RAM; huge tutorial corpus your domain user already knows | Large dependency tree; v5/v4 API churn (`layers` vs `slots`) | **Best.** Plotting-in-R is the stated constraint and Seurat's plots *are* ggplot objects. |
| Bioconductor `scran`+`SingleCellExperiment`+`scater` | Rigorous, modular, lighter object; great for QC stats | More glue code; plots less turnkey; integration (`batchelor`/`fastMNN`) extra | Good alternative engine; keep `scater`/`scran` as *companions* (richer QC), not the primary. |
| Python `scanpy`/`anndata` | Fast, memory-efficient, leiden native | Plotting is matplotlib (violates "plot in R"); adds a Python scientific stack to the sidecar; `.h5ad` interop friction | **Reject as engine.** But **accept `.h5ad` as an input format** (read via `schard`/`zellkonverter`). |

Companion packages we still pull from Bioconductor: `SingleR`+`celldex` (annotation), `scDblFinder` (doublets), `glmGamPoi` (fast SCTransform backend). `presto` (fast Wilcoxon for `FindAllMarkers`) and `harmony` from CRAN.

---

## 2. INPUT formats

All inputs land in a **per-job staging dir** on disk (`<app_data>/scrna/jobs/<job_id>/input/`). The UI never streams matrices through base64 — it uses `upload_files_from_paths` (native dialog → disk paths → multipart) so 10x matrices and `.h5ad` go straight from disk.

Accepted formats (auto-detected server-side by file signature, with an explicit override dropdown):

1. **10x Cell Ranger filtered matrix directory** — `matrix.mtx.gz` + `barcodes.tsv.gz` + `features.tsv.gz`. User picks the *folder* via the native dialog (Tauri `dialog.open({ directory: true })`); we enumerate and send all three files. Read in R with `Seurat::Read10X(dir)`.
2. **10x `.h5`** — `filtered_feature_bc_matrix.h5` (or `raw_*`). Single file picker. Read with `Seurat::Read10X_h5()` (needs `hdf5r`).
3. **Plain counts matrix** — genes × cells `.csv`/`.tsv`(`.gz`), genes in rows, cell barcodes in columns. File picker. Read with `data.table::fread()` → `as.sparse()`. UI exposes an "orientation" toggle (genes-in-rows vs cells-in-rows) because this is the #1 user error.
4. **`.rds`** — a previously-saved Seurat object (e.g. from a prior run of this tab, or user-supplied). `readRDS()`. Lets users resume/re-cluster without recomputing.
5. **`.h5ad`** (AnnData) — read via `schard::h5ad2seurat()` (lightweight, CRAN-adjacent) with `zellkonverter` (Bioc) as the heavier fallback. We coerce to Seurat.

**Multi-sample / per-sample metadata.** A core UI panel: a **sample table** (editable MUI DataGrid). Rows = one per input (folder/file). Columns: `sample_id`, plus arbitrary user-added covariate columns (`condition`, `donor`, `batch`, `timepoint`…). Alternatively the user uploads a `sample_metadata.csv` keyed on `sample_id`. On load we create one Seurat object per sample, tag `obj$sample_id <- ...` and the covariate columns, then `merge()` into one object with sample-prefixed barcodes (`add.cell.ids = sample_ids`). This `sample_id` column drives integration grouping, split UMAPs, and per-sample QC.

---

## 3. STANDARD WORKFLOW — Seurat functions + UI parameters

Stages are emitted as stdout markers (`@@STAGE:<name>:<pct>`) the Python job watcher parses for progress (§6). Defaults below are the UI defaults.

| Stage | Seurat / pkg call | Exposed UI params (default) |
|---|---|---|
| **0. Load + merge** | `Read10X`/`Read10X_h5`/`fread`; `CreateSeuratObject(min.cells, min.features)`; `merge()` | `min.cells` (3), `min.features` (200) |
| **1. QC metrics** | `PercentageFeatureSet(pattern="^MT-"/"^mt-")` → `percent.mt`; optional `percent.ribo` (`^RP[SL]`), `percent.hb` (hemoglobin) | mito gene pattern (auto: human `^MT-` / mouse `^mt-`, with override) |
| **2. Filter** | subset on `nFeature_RNA`, `nCount_RNA`, `percent.mt` | `nFeature_RNA` min **200** / max **6000**; `nCount_RNA` min **500** / max **40000**; `percent.mt` max **15%**. Each as a slider with a live histogram overlay so thresholds are set *after* seeing the QC violins. |
| **2b. Doublets (optional)** | `scDblFinder` (per-sample), drop predicted doublets | toggle **off** by default; expected rate auto from cell count |
| **3. Normalize** | **Fork A:** `NormalizeData(method="LogNormalize", scale.factor=1e4)` → `FindVariableFeatures` → `ScaleData`. **Fork B:** `SCTransform(vst.flavor="v2")` (needs `glmGamPoi`) | radio: **LogNormalize (default)** vs SCTransform; `scale.factor` (1e4) |
| **4. HVGs** | `FindVariableFeatures(selection.method="vst", nfeatures=...)` (LogNorm path) | `nfeatures` (**2000**) |
| **5. Scale** | `ScaleData(features, vars.to.regress=...)` | regress-out checkboxes: `percent.mt`, `nCount_RNA` (default none — it's slow) |
| **6. PCA** | `RunPCA(npcs=...)` | `npcs` (**50**); compute dims (**30**) used downstream — surfaced after the elbow plot |
| **7. Integration (multi-sample)** | v5 `IntegrateLayers(method = HarmonyIntegration / CCAIntegration / RPCAIntegration, orig.reduction="pca", new.reduction="integrated.dr")`, grouping by `sample_id` | method radio (see Fork); `group.by` = sample/batch column |
| **8. Neighbors** | `FindNeighbors(reduction = pca|integrated.dr, dims=1:N)` | `dims` (**1:30**) |
| **9. UMAP** | `RunUMAP(dims, reduction)` | `n.neighbors` (30), `min.dist` (0.3) — advanced/collapsed |
| **10. Cluster** | `FindClusters(resolution, algorithm)` | `resolution` (**0.8**); algorithm (Louvain default; Leiden optional — note Leiden needs `leidenalg` via reticulate, so we offer **igraph-Leiden** `algorithm=4` to stay pure-R) |
| **11. Markers** | `FindAllMarkers(only.pos=TRUE, min.pct=0.1, logfc.threshold=0.25, test.use="wilcox")` accelerated by **`presto`** | `min.pct` (0.1), `logfc.threshold` (0.25), `only.pos` (on) |
| **12. Annotation (optional)** | **Fork:** manual marker dotplot, *or* `SingleR(test, ref=celldex::<ref>, labels=ref$label.main)` | annotation mode radio; reference dropdown (HumanPrimaryCellAtlas / MonacoImmune / MouseRNAseq…) |

The UI runs this as **one job** but exposes a **"re-run from stage"** affordance: because clustering/markers/UMAP are cheap relative to load+normalize+integrate, the saved `.rds` checkpoint after stage 7 lets the user sweep `resolution`/`dims` without recomputing the expensive front half (re-run starts at stage 8).

---

## 4. OUTPUTS

**Tables** (written via the job's table dir → returned as CSV, same `{name, csv}[]` shape as the bridge):
- `qc_summary` — per sample: n cells pre/post filter, median genes/UMIs, median %mt, doublets removed.
- `cluster_sizes` — cluster × (n cells, % of total, n cells per sample → composition).
- `cluster_markers` — full `FindAllMarkers` (gene, cluster, avg_log2FC, pct.1, pct.2, p_val_adj).
- `top_markers` — top N per cluster (for the dotplot/heatmap).
- `annotation` — per-cluster SingleR label + score (if run).
- `run_parameters` — every param used (provenance/reproducibility).

**Figures** (each via `mpfig_plot(...)` → ggplot/Seurat print → PNG; exported TIFF/PNG/SVG by re-rendering at requested device, matching the other tabs' export panel):
- QC violins (`VlnPlot` for nFeature/nCount/percent.mt, split by sample) + QC scatter (`FeatureScatter` nCount vs nFeature).
- Elbow plot (`ElbowPlot`) — drives the `dims` choice.
- UMAP by cluster (`DimPlot group.by="seurat_clusters" label=TRUE`).
- UMAP by sample / condition (`DimPlot group.by="sample_id"`, and `split.by` for side-by-side batch-effect visual check).
- Marker dotplot (`DotPlot` of top markers) and marker heatmap (`DoHeatmap` of top N per cluster).
- Feature plots (`FeaturePlot`) for a user-entered gene list.
- (If annotated) UMAP colored by predicted cell type + SingleR score heatmap.

---

## 5. R PACKAGE SET — binary-install feasibility

Strategy: **install with `pak`**, pointed at **Posit Public Package Manager (P3M) binary repos** so the user needs **no compiler**. `pak` resolves CRAN+Bioconductor in one transaction and pulls platform binaries on Windows/macOS.

Bootstrap (run via `/api/analysis/run-console`, our long timeout):
```r
options(repos = c(P3M = sprintf(
  "https://packagemanager.posit.co/cran/__linux__/%s/latest",  # win/mac use the plain binary URL
  "jammy")))
# On win/mac point repos at the binary CRAN snapshot + set Bioc to P3M too.
install.packages("pak")
pak::pkg_install(c(
  "Seurat", "SeuratObject", "harmony", "presto", "ggplot2", "patchwork",
  "data.table", "hdf5r", "schard", "R.utils",
  "bioc::glmGamPoi", "bioc::scDblFinder", "bioc::SingleR", "bioc::celldex",
  "bioc::BPCells"
))
```

| Package | Repo | Binary? | ~Size | Notes |
|---|---|---|---|---|
| Seurat + SeuratObject | CRAN | Yes (win/mac) | ~30–40 MB w/ deps (Matrix, Rcpp, RcppEigen, uwot, igraph…) | The weight item: ~40–60 deps. P3M binaries make this minutes, not the ~30+ min source build. |
| harmony | CRAN | Yes | small (Rcpp) | recommended integration |
| presto | CRAN | Yes | small | fast Wilcoxon; huge speedup for `FindAllMarkers` |
| ggplot2, patchwork | CRAN | Yes | small | plotting |
| data.table | CRAN | Yes | ~5 MB | fast CSV/TSV read |
| hdf5r | CRAN | **Binary on win/mac; needs libhdf5 to compile on Linux** | ~3 MB | required for `.h5`/`.h5ad`. **Compilation risk on Linux only.** |
| schard | CRAN | Yes | small | `.h5ad` → Seurat |
| glmGamPoi | Bioc | Yes (binaries) | small | SCTransform v2 backend |
| scDblFinder | Bioc | Yes | ~moderate (pulls SingleCellExperiment, scran deps) | doublets |
| SingleR | Bioc | Yes | moderate | annotation |
| celldex | Bioc | Yes (pkg small) | small pkg, **but downloads reference data at runtime** (see below) | references |
| BPCells | CRAN/GitHub | **needs compilation (C++); no reliable binary** | ~moderate | large-data on-disk. **Flag: make this OPTIONAL/lazy** — only install when user opts into >200k-cell mode. |

**Compilation flags:**
- **BPCells** is the real toolchain risk (C++17, sometimes from GitHub). Don't install it in the default bootstrap. Gate it behind the "large dataset (on-disk)" toggle and warn the user they'll need Rtools (Win) / Xcode CLT (mac) / build-essential (Linux) for that path only.
- **hdf5r** compiles on Linux without system `libhdf5-dev`. On Linux, prefer the P3M `__linux__` binary which bundles it; if it falls back to source, surface the apt/yum hint.

**External reference data the USER effectively supplies / downloads:**
- **`celldex` references** are downloaded on first use from ExperimentHub (~tens of MB each, cached under `ExperimentHub`). The UI must (a) show this is a one-time download and (b) require network. Offer a "pre-download reference" button. This is the only large external data dependency, and it's optional (annotation is optional).
- No genome/reference FASTA needed — this tab starts from a *count matrix*, not FASTQs (alignment/Cell Ranger is upstream and out of scope).

The tab's R install state is checked the same way `check-r` works, plus a new `/api/scrna/check-packages` that runs a tiny `Rscript -e 'requireNamespace(...)'` probe and returns `{missing: [...], hasCompiler: bool}` so the UI can offer **"Install required packages"** before the user can run anything.

---

## 6. RUNTIME / MEMORY + the async job

**Memory reality (in-memory Seurat path, dense `ScaleData` is the peak):**
- ~5k cells: <2 GB, runs in ~1–2 min.
- ~20–30k cells (typical single 10x lane post-filter): ~4–8 GB, ~3–8 min.
- ~100k cells (multi-sample + integration): ~16–32 GB, 15–40 min; SCTransform + CCA integration is the worst case.
- ≥250k–1M cells: requires **BPCells on-disk** layer or it OOMs; even then expect long UMAP/integration times.

`ScaleData` densifies the HVG matrix and is the RAM spike; restricting scaling to HVGs (default) and offering `vars.to.regress` only opt-in keeps it bounded. Integration (CCA especially) is the time spike.

**Async job pattern** (own router, mirrors `alignZStack`/`pollAlignStatus`):

```
POST /api/scrna/run        body: {job_id, params}        -> {job_id, status:"queued"}
GET  /api/scrna/status/{job_id}  -> {status, progress, stage, message, result?, error?}
```

- `POST /run` spins up a **detached `subprocess.Popen(["Rscript", pipeline.R, params.json, job_dir])`** (NOT through the 120 s `run_r`), records it in an in-process `JOBS` dict keyed by `job_id`, and returns immediately. R is invoked via the resolved host `Rscript` (reusing `_resolve_rscript()` + `_r_env()` from `r_bridge.py`).
- The R pipeline (`r-env/rscripts/scrna_pipeline.R`) prints **stage markers** to stdout: `@@STAGE:normalize:40` etc., and `@@ERROR:...` on `tryCatch` failure. A background thread (`threading.Thread`) reads the pipe line-by-line and updates `JOBS[job_id] = {status, progress, stage, message}`.
- On exit, R has written `result.json` (paths to plots + tables + the `.rds` checkpoint) into `job_dir`; the watcher flips status to `done`/`error` and the next `/status` poll returns `result` (plots base64-encoded on read, tables as CSV — same response shape the frontend already renders).
- **Cancel:** `POST /api/scrna/cancel/{job_id}` → `Popen.terminate()`. **Cleanup:** job dirs GC'd on a TTL.
- Frontend polls `/status` every ~1.5 s and renders a `LinearProgress` with the stage label, exactly like the multipanelfigure z-stack poller.

Progress weighting (cheap front, expensive middle): load 5 → QC 10 → filter 15 → normalize 35 → PCA 45 → integrate 70 → neighbors/UMAP 85 → cluster 90 → markers 97 → annotate 100.

---

## 7. PYTHON endpoints + UI controls + Zustand store

**New module `TauriApp/python-sidecar/scrna.py`** (auto-loaded — add `"scrna"` to the loop in `api_server.py` line 83):

```
POST /api/scrna/create-job                 -> {job_id}              # mkdir staging
POST /api/scrna/upload/{job_id}            (multipart, from-disk)   # 10x dir / h5 / csv / rds / h5ad
POST /api/scrna/validate/{job_id}          -> {format, n_genes, n_cells_est, organism_guess, warnings[]}
GET  /api/scrna/check-packages             -> {missing[], hasCompiler}
POST /api/scrna/install-packages           -> streams to run-console bootstrap (pak)
POST /api/scrna/run                        body:{job_id, params}    -> {job_id, status}
GET  /api/scrna/status/{job_id}            -> {status, progress, stage, message, result?, error?}
POST /api/scrna/rerun-cluster/{job_id}     body:{dims,resolution}   # cheap re-run from rds checkpoint
POST /api/scrna/cancel/{job_id}
GET  /api/scrna/celldex-refs               -> [{id,label,organism}]
POST /api/scrna/export-figure/{job_id}     body:{plot, format, w,h,dpi} -> re-render TIFF/PNG/SVG
```

**UI controls** (MUI, left config rail + right results panel, matching sibling tabs):
- **Data panel:** native folder/file picker (Tauri dialog) → from-disk upload; sample DataGrid (sample_id + covariates); format/organism override; validation summary card.
- **QC panel:** the live histograms + the three threshold sliders; doublet toggle.
- **Normalization panel:** LogNormalize/SCTransform radio; `nfeatures`; `npcs`; regress-out checkboxes.
- **Integration panel** (shown only when >1 sample): method radio (Harmony/CCA/RPCA); `group.by` selector.
- **Clustering panel:** `dims` (shown with the elbow plot), `resolution` slider, algorithm select.
- **Markers/Annotation panel:** marker thresholds; annotation mode radio + celldex reference dropdown ("downloads ~X MB once" hint); feature-plot gene textbox.
- **Run bar:** "Install packages" (disabled-until-needed) → "Run pipeline" → `LinearProgress` with stage + Cancel.
- **Results:** tabbed plots gallery (each with TIFF/PNG/SVG export) + tables (DataGrid with CSV download), reusing the shared results panel.

**Zustand store `TauriApp/src/store/scrnaStore.ts`:**
```ts
interface ScrnaState {
  jobId: string | null;
  samples: SampleRow[];                 // {sampleId, sourcePath, format, covariates:{}}
  validation: ValidationResult | null;
  params: {
    minCells: number; minFeatures: number;
    qc: { nFeatureMin; nFeatureMax; nCountMin; nCountMax; percentMtMax };
    mitoPattern: string; removeDoublets: boolean;
    normalization: 'LogNormalize' | 'SCTransform'; nfeatures: number;
    varsToRegress: string[];
    npcs: number; dims: number;
    integration: { enabled: boolean; method: 'harmony'|'cca'|'rpca'; groupBy: string };
    clustering: { resolution: number; algorithm: number };
    markers: { minPct: number; logfcThreshold: number; onlyPos: boolean };
    annotation: { mode: 'none'|'manual'|'singler'; celldexRef: string; featureGenes: string[] };
  };
  packages: { missing: string[]; hasCompiler: boolean; installing: boolean };
  job: { status: 'idle'|'queued'|'running'|'done'|'error'; progress: number; stage: string; message: string };
  result: { plots: { name: string; png: string }[]; tables: { name: string; csv: string }[] } | null;
  // actions: createJob, addSamples(paths), validate, checkPackages, installPackages,
  //          run, poll(jobId), rerunCluster, cancel, reset, exportFigure
}
```
Polling uses `setInterval` calling `apiJson('/api/scrna/status/'+jobId)`; on `done` it stores `result` and stops. Uploads go through `upload_files_from_paths` (from-disk) via a thin `uploadFromPaths()` client helper added next to `uploadFiles()`.

---

## 8. DECISION FORKS (recommendation in bold; alt noted)

1. **Engine → Seurat v5 (recommended).** Plotting-in-R is the binding constraint and Seurat plots are ggplot. *Alt:* scran/SCE if you want stricter stats; scanpy rejected as engine but supported as `.h5ad` input.
2. **Normalization → LogNormalize default (recommended).** Faster, lighter, fewer deps, predictable RAM, and what most users expect for first-pass clustering. *Alt:* SCTransform v2 (needs `glmGamPoi`) — better for low-depth/heterogeneous data; offer it as a radio, not the default.
3. **Integration → Harmony (recommended).** Fast, low-memory, robust, one extra small CRAN dep, integrates in PCA space without densifying. *Alt:* Seurat CCA (best for strong cross-condition shifts but slow/RAM-heavy) and RPCA (faster than CCA, good for large/many samples) — both offered; warn that CCA is the OOM risk at >50k cells.
4. **Annotation → manual marker dotplot as default + SingleR optional (recommended).** Manual needs no downloads and no network; SingleR/celldex is excellent but pulls reference data on first use and is organism/reference-sensitive. Make SingleR a clearly-labeled opt-in with a reference dropdown and a "download once" notice. *Alt:* skip annotation entirely (clusters only).
5. **Max dataset size → support up to ~200k cells in the default in-memory path; gate >200k behind an opt-in BPCells "on-disk" mode (recommended).** Keeps the default install compiler-free and RAM-bounded; the heavy/compilation-prone BPCells path is only paid for by users who explicitly need million-cell datasets and accept the toolchain requirement. *Alt:* hard-cap at 200k with a clear error and a "downsample to N cells" option (`subset(cells = sample(...))`) for users without a compiler.

---

**Files to create:** `TauriApp/python-sidecar/scrna.py` (router + async job manager), `r-env/rscripts/scrna_pipeline.R` (the staged pipeline with `@@STAGE`/`@@ERROR` markers and `result.json` output), `TauriApp/src/components/scrna/ScrnaView.tsx`, `TauriApp/src/store/scrnaStore.ts`; extend `TauriApp/src/api/client.ts` (add `uploadFromPaths`, `createScrnaJob`, `pollScrnaStatus`) and `TauriApp/src/api/types.ts`; register `"scrna"` in the router loop at `TauriApp/python-sidecar/api_server.py:83`. No Rust changes required — `proxy_request`, `upload_files_from_paths`, and `save_base64_to_path` already cover every transport this tab needs.