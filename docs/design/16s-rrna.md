I now have a complete and accurate picture of the existing contracts. Critically, `upload_files_from_paths` reads files by basename and re-uploads as multipart — which is wrong for multi-GB FASTQs/folders, so my design must note a from-disk *path-handoff* variant rather than re-streaming bytes. I have everything I need to write a concrete, implementable design doc grounded in this exact scaffold.

Here is the design document.

---

# 16S rRNA Microbiome Analysis Tab — Design Doc

Target app: Lab Analysis Suite (Tauri v2 + React 19 + FastAPI sidecar + host R). This tab joins qPCR / xCELLigence / RNA-seq / Plate Mapper and follows the same `Python parse+orchestrate → R compute+plot` split, but adds a **long-running async job layer** the scaffold does not yet have (the current `/api/analysis/run-r` is synchronous with a 120 s cap — unusable for DADA2).

Tab module: `python-sidecar/microbiome.py` (registered the same way RNA-seq is — add `"microbiome"` to the loader loop in `api_server.py` line 83). Frontend: `src/components/microbiome/`, store `src/store/microbiomeStore.ts`, R templates under `r-env/rscripts/microbiome/`.

---

## 0. Naming & where R is invoked (grounding in the existing code)

- **Short R steps** (downstream phyloseq plots, alpha/beta, barplots, diff-abundance) reuse the existing bridge contract: a CSV is materialized as `data`, the script calls `mpfig_plot(...)` / `mpfig_data(df,name)`, and PNGs + CSV tables come back. But these still want longer than 120 s and produce many figures, so they run inside the **job worker** (below), not via the public `/api/analysis/run-r`.
- **The job worker** is new: `microbiome.py` writes a full `.R` file to a per-job working directory and spawns `Rscript script.R` with `subprocess.Popen` (so we can stream stdout while it runs). It reuses `r_bridge._resolve_rscript()` and `r_bridge._r_env()` for R discovery and env — **do not duplicate** R-location logic. Because R is now the host's (never bundled), `_resolve_rscript` returns `(host_rscript, False)` and `_r_env` returns `None` (inherit parent env) — fine.
- **Progress** is surfaced by printing `@@PROGRESS stage=<id> pct=<int> msg=<text>` markers to stdout from R; the Python worker tails the process's stdout, regex-parses those lines, and updates the in-memory job record that `GET /status/{job_id}` returns. This is the concrete realization of the multipanelfigure `alignZStack/pollAlignStatus` shape.

A small refactor: hoist `_resolve_rscript`, `_r_env`, `_r_prelude` so `microbiome.py` can import them. They're already module-level functions in `r_bridge.py`, so `from r_bridge import _resolve_rscript, _r_env, _r_prelude` works as-is.

---

## 1. THE BIG FORK — Pipeline entry point (Mode A vs Mode B)

This is the first thing the UI asks. **RECOMMENDATION: support BOTH, as two explicit modes selected by a top-of-tab toggle.** They share 100% of the downstream half (Section 3); they differ only in how the phyloseq object is *built*.

### Mode A — Raw paired-end FASTQs → DADA2 (the "from scratch" ask)
Full denoising pipeline. Heavy. Produces an ASV table + taxonomy + (optionally) a tree, which then feeds the shared downstream half.

DADA2 step chain (canonical):
`filterAndTrim → learnErrors (fwd) → learnErrors (rev) → dada (fwd) → dada (rev) → mergePairs → makeSequenceTable → removeBimeraDenovo → assignTaxonomy [→ addSpecies] → (optional) DECIPHER+phangorn tree`.

**Heavy parts, called out explicitly:**

- **Per-sample compute.** `learnErrors` and `dada` dominate. Realistic on a 4–8 core laptop, V3–V4 (~250 bp reads, ~50k reads/sample), `multithread=TRUE`:
  - `filterAndTrim`: ~2–5 s/sample.
  - `learnErrors`: runs **once per direction over a read subset** (default `nbases=1e8`), ~1–4 min total each (not per sample) — but this is the single most "stalls with no output" step, so it must emit progress.
  - `dada`: ~3–15 s/sample/direction.
  - `mergePairs` + `makeSequenceTable` + `removeBimeraDenovo`: seconds to ~1 min.
  - `assignTaxonomy` against SILVA: **the second long pole** — naive Bayes over all ASVs, ~1–5 min for a few thousand ASVs but can be 10+ min and **memory-spiky** (loads the whole reference into RAM).
  - **Total for ~20 samples V3–V4: ~15–40 min.** For 50–100 samples or 2×300 bp: easily 1–3 h. → mandatory async job + progress + cancel.
- **The large external TAXONOMY REFERENCE the user must supply.** DADA2 needs a DADA2-formatted reference FASTA. We do **not** bundle it (licensing + size + it goes stale). Options:
  - **SILVA v138.2** `silva_nr99_v138.2_toGenus_trainset.fa.gz` (~**130 MB**) + optional `silva_v138.2_assignSpecies.fa.gz` (~**76 MB**). **RECOMMENDED default** — best genus-level resolution for 16S, the DADA2 community standard, directly consumable by `assignTaxonomy`/`addSpecies`.
  - **GTDB** (DADA2-formatted SSU sets, ~**90–200 MB**) — better for prokaryotic taxonomy consistency / genome-based names; offer as an alternative.
  - **GreenGenes2** — increasingly used but its DADA2-trainset packaging is less turnkey; offer as "advanced".
  - **UI handling:** a "Taxonomy reference" picker — native file dialog (`tauri_plugin_dialog`) to point at the `.fa.gz` train set (+ optional species set). We store the **absolute path** and pass it to R; we never upload it. The tab shows a one-line "Don't have one? Download SILVA v138.2 (≈130 MB)" link that opens the SILVA/DADA2 reference page in the browser. The path is persisted in the store so the user sets it once. `check-r`-style preflight: a tiny endpoint stat's the file and verifies it gzip-opens.
- **Primer trimming.** Decision the user must get right or everything downstream is wrong:
  - If reads still contain PCR primers (common for V3–V4 341F/805R), they must be removed. **RECOMMENDED:** expose `trimLeft=c(fwd_len, rev_len)` in `filterAndTrim` for **fixed-length** primers (fast, no extra tool, pure DADA2). 
  - For **variable-length / heterogeneity-spacer** primers, fixed `trimLeft` is wrong — you need `cutadapt`. Since the host may not have cutadapt and we don't want a toolchain dependency, **do NOT make cutadapt mandatory.** Design: a "Primers" UI section with three choices — (1) *Already removed* (demux'd by sequencer, common for Illumina V3–V4 kits), (2) *Fixed-length trim* → `trimLeft` (recommended path), (3) *Sequence-based (cutadapt)* → only enabled if a `cutadapt` binary is detected on `PATH`; otherwise greyed out with a tooltip. Recommendation surfaced inline: "Most Illumina V3–V4 data is already demultiplexed and primer-free; verify by inspecting the first 20 bp of a few reads."
  - We also surface the **quality-profile plot first** (`dada2::plotQualityProfile` on 2–4 samples) as a *pre-flight* so the user picks `truncLen` sensibly before committing to the full run. This is a fast (<30 s) sub-job.

### Mode B — Existing ASV/OTU table + taxonomy (the fast path)
Skip DADA2 entirely; build phyloseq directly from user tables. Seconds, not hours. This covers the very common case where denoising was already done (QIIME2, prior DADA2, a collaborator's table, a public dataset).

**RECOMMENDATION: this is the default landing mode** because it's instant and risk-free; Mode A is opt-in behind "I have raw FASTQs." Most users iterating on stats/figures live in Mode B.

---

## 2. INPUTS (precise formats + how provided)

### Mode A inputs
- **A folder of paired FASTQ(.gz).** Provided via native **folder picker** (`tauri_plugin_dialog`'s `open({directory:true})`). We send the **folder path** to the sidecar, not the bytes — multi-GB FASTQs must never go through base64 IPC or even the existing `upload_files_from_paths` (which re-streams bytes as multipart; fine for small files, wasteful here).
  - ⚠️ Implementation note: add a thin Rust command `submit_microbiome_job(folder_path, params_json)` (or reuse `proxy_request` with the folder path embedded in the JSON body) that hands the **path string** to `POST /api/microbiome/run`. The sidecar reads FASTQs from disk directly. The existing `upload_files_from_paths` is the wrong tool here; document this so nobody wires FASTQs through it.
  - **Filename pairing:** expect Illumina/Casava convention `SAMPLEID_*_R1_*.fastq.gz` / `_R2_`. The sidecar globs `_R1_`/`_R2_`, derives `sample_id` from the prefix, and returns the inferred pairing as a preview table for the user to confirm before running (catches orphan/mis-paired files). Expose a regex override for non-standard names.
- **Sample metadata table** (CSV/TSV/XLSX): one row per `sample_id`, required column `sample_id` (must match FASTQ-derived IDs), a `group` column (the primary comparison), plus arbitrary covariates (e.g. `sex`, `batch`, `timepoint`, numeric `age`). Uploaded via the small-file path (`proxy_upload` base64 is fine — it's a few KB) and parsed by pandas in Python; we validate that every FASTQ sample has a metadata row and vice-versa, returning a reconciliation report.

### Mode B inputs
- **ASV/OTU abundance table** (CSV/TSV/XLSX): rows = features (ASV/OTU IDs), columns = samples (counts; integers strongly preferred for diff-abundance). Or transposed — we auto-detect orientation by matching the sample axis to the metadata `sample_id`s and let the user flip if ambiguous.
- **Taxonomy table** (CSV/TSV): feature ID + 7 rank columns `Kingdom,Phylum,Class,Order,Family,Genus,Species` (accept QIIME2 `taxonomy.tsv` with a single `Taxon` string `d__...;p__...;...` and split it; accept `Confidence` column and ignore). Missing ranks → `NA`.
- **Sample metadata** — same spec as Mode A.
- **Optional rooted tree** (Newick `.nwk`/`.tree`) for UniFrac. If absent, UniFrac is disabled (see Section 8 fork) unless the user opts to build one from ASV sequences (only possible if a representative-sequences FASTA is also provided).
- **Optional representative sequences** (FASTA, feature ID → sequence): needed only if the user wants us to build a tree in Mode B.

All Mode B files are small enough for `proxy_upload` (base64). Python (pandas) parses, validates, harmonizes IDs, and writes three clean CSVs (`otu.csv`, `tax.csv`, `meta.csv`) into the job working dir for R.

---

## 3. DOWNSTREAM ANALYSIS (shared by A & B; phyloseq + friends)

Once Mode A or B has produced `otu / tax / meta [/ tree]`, the rest is identical and runs as R steps inside the job.

1. **Build phyloseq object.** `phyloseq(otu_table(mat, taxa_are_rows=TRUE), tax_table(taxmat), sample_data(meta) [, phy_tree(tree)])`.
2. **Filtering** (recommended defaults, all UI-exposed):
   - Drop non-bacterial lineages: remove `Kingdom != Bacteria/Archaea`, and `Order == "Chloroplast"` / `Family == "Mitochondria"` (host/plastid contamination) — checkbox, **on by default**.
   - Prevalence/abundance filter: keep features present in ≥ *N* samples (default 2) with total count ≥ *M* (default 5). Slider-exposed.
3. **Rarefaction — the debate, with a recommendation.** Rarefying to even depth throws away data and is statistically criticized (McMurdie & Holmes 2014), but it remains standard and defensible for **alpha- and beta-diversity** where library-size sensitivity is real. **RECOMMENDATION:**
   - For **alpha & beta diversity**: offer rarefaction to a user-chosen depth (default = a sensible quantile of sample sums, with a rarefaction-curve plot + a table of reads-lost-per-sample so the user picks the depth with eyes open). Default behavior: **rarefy for diversity, but make it a clearly-labeled toggle** with the alternative (no rarefaction) one click away.
   - For **differential abundance**: **never rarefy** — feed raw counts to the chosen method (ANCOM-BC / DESeq2 / ALDEx2 all model library size internally). This split (rarefy diversity, raw-count DA) is the defensible middle ground and is what the doc bakes in.
4. **ALPHA diversity.** `estimate_richness(ps, measures=c("Observed","Shannon","Simpson"))` (Chao1 optional). Per-sample table joined to metadata. **Group stats:** Wilcoxon (2 groups) / Kruskal–Wallis (>2 groups) with Dunn post-hoc + BH correction; choose test by group cardinality automatically. Output a stats table per metric.
5. **BETA diversity.** Distances via `phyloseq::distance`: **Bray–Curtis** and **Jaccard** always; **UniFrac (unweighted + weighted)** only if a tree exists (Section 8). Compute on rarefied (or relative-abundance-transformed) data.
6. **Ordination + PERMANOVA.** `ordinate(ps, method="PCoA"|"NMDS", distance=...)`; plot colored by `group` with ellipses. **PERMANOVA** via `vegan::adonis2(dist ~ group + covariate1 + ..., permutations=999, by="margin")` — the formula is built from the user-selected group + covariates so confounders are adjusted. Report R², pseudo-F, p per term. Add `vegan::betadisper` + permutest as a dispersion sanity check (PERMANOVA assumes homogeneous dispersion) and surface a warning if dispersion differs significantly.
7. **Taxonomic composition barplots.** Agglomerate with `tax_glom` (or `speedyseq::tax_glom` if available, much faster) to **Phylum** and **Genus**; convert to relative abundance; collapse low-abundance taxa into "Other" (top-N slider, default top 12); stacked bars faceted/grouped by `group`. Also emit the underlying mean-relative-abundance tables.
8. **Differential abundance.** Method fork in Section 8. **RECOMMENDED default: ANCOM-BC2** (`ANCOMBC::ancombc2`) — compositionally aware, controls FDR well, handles covariates, actively maintained. Output: log-fold-change, SE, W/test stat, p, q, and a "structural zero / differentially abundant" flag per taxon, at a chosen rank (default Genus). Alternatives wired but off by default: **ALDEx2** (CLR + Monte-Carlo, very robust, great for small n), **DESeq2** (reuses the RNA-seq tab's familiarity but needs a poscounts/GMPR size factor for sparse zero-inflated data — we set `sfType="poscounts"`), **corncob** (beta-binomial, models dispersion).

---

## 4. OUTPUTS

**Tables** (each written via `mpfig_data(df,name)` → returned as `{name,csv}`, shown in a results grid with per-table CSV/TSV download):
- `asv_table` (Mode A: ASV × sample counts; ASV IDs are md5 hashes of the sequence) and `asv_sequences` (ASV ID → sequence, FASTA-as-CSV).
- `taxonomy` (feature → 7 ranks [+ bootstrap confidence in Mode A]).
- `read_tracking` (Mode A only: input → filtered → denoised → merged → non-chimeric counts per sample — the canonical DADA2 QC table; a big retention drop here is the #1 diagnostic).
- `alpha_diversity` (per-sample Observed/Shannon/Simpson + metadata) and `alpha_stats` (per-metric group test results).
- `permanova_results` (term, Df, SumOfSqs, R², F, p) + `betadisper_results`.
- `diff_abundance` (taxon, rank, log2FC/lfc, SE, stat, p, q, significant flag).
- `taxa_composition_phylum` / `taxa_composition_genus` (mean relative abundance × group).
- `run_params` (every parameter used — provenance for reproducibility).

**Figures** (PNG from `mpfig_plot()`, plus the tab's TIFF/PNG/SVG export panel; for SVG we re-render the same ggplot to an `svglite`/`svg()` device on export-click):
- **Pre-flight:** quality-profile plot (Mode A), rarefaction curves.
- **Alpha:** boxplots (+ jitter) per metric, faceted by metric, grouped by `group`, with significance brackets.
- **Beta/ordination:** PCoA and NMDS scatter colored by `group` with confidence ellipses; axis % variance labels; optional secondary color for a covariate.
- **Composition:** stacked relative-abundance barplots at Phylum and Genus, grouped by `group`.
- **Diff-abundance:** a "volcano-style" or sorted log-fold-change bar/lollipop plot of significant taxa (color by direction), and an effect-size forest plot for ANCOM-BC.

All ggplot, all themable to match the other tabs.

---

## 5. R PACKAGE SET — CRAN vs Bioconductor, binary feasibility, sizes, compilation, reference-DB sizes

The hard constraint: **host R, no bundled packages, user may have NO C/C++/Fortran toolchain.** So we install from **binaries** wherever possible.

**Install strategy (RECOMMENDED):** drive installs through the existing `POST /api/analysis/run-console` using **`pak`** with **Posit Public Package Manager (P3M)** binary repos:
- On **Windows & macOS**, CRAN itself serves binaries, and **P3M serves binary Bioconductor + CRAN** packages — so `pak::pkg_install(...)` pulls prebuilt binaries, **no toolchain needed**.
- On **Linux**, CRAN has no binaries, but **P3M provides binary packages for specific distro/R-version combos**. We set the P3M binary repo URL (with the right `R_VERSION`/distro in the user agent / repo path) so Linux users also get binaries. Fallback if their distro is unsupported by P3M: source compile (needs build tools) — we **detect** this and warn loudly with the exact `apt/dnf` line to install `r-base-dev` + compilers, rather than silently failing mid-build.
- `pak` resolves the full dependency graph and installs in parallel, and is itself a single binary install — so a first-run "Install microbiome R packages" button runs one `pak::pkg_install(c(...))` call and streams progress.

| Package | Repo | Role | Approx installed size | Binary on win/mac? | Compilation risk |
|---|---|---|---|---|---|
| **dada2** | Bioconductor | denoising (Mode A) | ~15–30 MB (pulls Rcpp/RcppParallel) | Yes via P3M/Bioc binaries | Source build needs C++/`RcppParallel` toolchain — **avoid source**; use binaries |
| **phyloseq** | Bioconductor | core data object + diversity | ~10–20 MB | Yes | Low (depends on ade4, Biostrings) |
| **Biostrings / IRanges / S4Vectors** | Bioconductor | sequence infra (deps) | ~30–60 MB combined | Yes | Compiled C, but binaries exist |
| **vegan** | CRAN | adonis2, NMDS, betadisper, rarefaction | ~5 MB | Yes | Has Fortran — **use CRAN binary** |
| **DECIPHER** | Bioconductor | MSA for tree (optional) | ~10–20 MB | Yes | C; binary fine |
| **phangorn** | CRAN | NJ/ML tree (optional) | ~5 MB | Yes | C++; binary fine |
| **ANCOMBC** | Bioconductor | diff-abundance (default) | ~5–10 MB (+ deps incl. `nloptr`, `lme4`) | Yes | `nloptr` historically painful from source → **binary strongly preferred** |
| **ALDEx2** | Bioconductor | diff-abundance (alt) | ~3–5 MB | Yes | Low |
| **DESeq2** | Bioconductor | diff-abundance (alt) | already needed by RNA-seq tab — **reuse** | Yes | Already handled by RNA-seq tab |
| **corncob** | CRAN | diff-abundance (alt) | ~3 MB | Yes | C++; binary fine |
| **ggplot2 / tidyverse bits** | CRAN | plotting | already needed across tabs | Yes | reuse |
| **speedyseq** *(optional)* | GitHub | fast `tax_glom` | small | **No binary — GitHub source** | Needs compile/`remotes` → **make optional**, fall back to `phyloseq::tax_glom` |

**Compilation flags:**
- The only genuinely "needs-a-toolchain-if-no-binary" risks are `dada2` (RcppParallel), `ANCOMBC`→`nloptr`/`lme4`, and anything from GitHub (`speedyseq`). **All are avoidable** by sticking to P3M/Bioc binaries on win/mac and P3M on supported Linux. We mark `speedyseq` strictly optional.
- **`R` version coupling:** Bioconductor binaries are pinned to an R minor version. We read the host R version from `check-r`, map it to the matching Bioconductor release, and target that — if the host R is too old/new for the Bioc release with `dada2`, we surface a clear "your R is X; install R ≥ Y for the microbiome packages" message instead of a cryptic resolver error.

**Reference-DB sizes (USER-supplied, not packages):**
- SILVA v138.2 toGenus trainset ≈ **130 MB**; species set ≈ **76 MB**.
- GTDB DADA2 SSU sets ≈ **90–200 MB**.
- A built phylogenetic tree is computed, not downloaded.

**Total first-run install:** roughly **150–300 MB** of R packages + the user's chosen **~130–200 MB** reference DB. Realistic install time on binaries: **3–10 min** (network-bound). From source it could be **30–60+ min** and may fail without compilers — hence the binary-first mandate.

---

## 6. RUNTIME / MEMORY + ASYNC JOB / PROGRESS (DADA2 is the long pole)

**Job model (new infrastructure in `microbiome.py`):**
- In-process `JOBS: dict[job_id, JobRecord]` with `{status, progress, stage, stages_done, result, error, started_at, log_tail}`. `status ∈ {queued, running, done, error, canceled}`.
- `POST /api/microbiome/run` validates inputs, writes the working dir + the generated `.R` script, spawns `Rscript script.R` via `subprocess.Popen(stdout=PIPE, stderr=PIPE, text=True, env=_r_env(...), cwd=jobdir)` in a background `threading.Thread` (or `asyncio` task), and **immediately returns `{job_id}`**. (One job at a time per tab; a 2nd submit is rejected with the running job_id, mirroring a simple queue.)
- The worker thread reads R stdout **line-by-line**; lines matching `^@@PROGRESS stage=(\S+) pct=(\d+) msg=(.*)$` update the job record; everything is appended to a capped `log_tail` (last ~200 lines) for a live log view. On process exit it collects `plots/*.png` (base64) and `tables/*.csv` into `result` and sets `status=done` (or `error` with stderr tail).
- `GET /api/microbiome/status/{job_id}` → `{status, progress, stage, message, log_tail, result?, error?}`. Frontend polls every ~1.5 s (the `pollAlignStatus` shape).
- `POST /api/microbiome/cancel/{job_id}` → `Popen.terminate()` (then `kill` after grace) and marks `canceled`. Essential for a 2-hour DADA2 run started by mistake.

**R-side progress markers** (emitted with `cat("@@PROGRESS ...\n"); flush.console()` — but for `Rscript`, `cat(..., file=stdout())` + line-buffered output; we run with `R_CLI`/unbuffered or `flush`):
```
@@PROGRESS stage=filter pct=10 msg=Filtering and trimming (12/20 samples)
@@PROGRESS stage=learnErrors_fwd pct=25 msg=Learning forward error rates
@@PROGRESS stage=dada pct=45 msg=Denoising (18/20)
@@PROGRESS stage=merge pct=60 ...
@@PROGRESS stage=chimera pct=70 ...
@@PROGRESS stage=assignTax pct=85 msg=Assigning taxonomy (SILVA)
@@PROGRESS stage=tree pct=92 msg=Building phylogenetic tree
@@PROGRESS stage=downstream pct=97 msg=Alpha/beta/diff-abundance
@@PROGRESS stage=done pct=100
```
For per-sample loops (`filterAndTrim`, `dada`) we wrap in our own loop emitting fractional progress; `learnErrors` is a single opaque call so we bracket it (emit before/after) and the UI shows an indeterminate spinner for that stage with the stage label.

**Memory:**
- `assignTaxonomy` is the RAM peak — SILVA naive-Bayes loads the whole reference; budget **~3–8 GB** transient for SILVA. We set `multithread=TRUE` but warn that taxonomy assignment is memory-bound; on low-RAM machines we expose `multithread=FALSE` for that step.
- DADA2 denoising memory scales with unique sequences per sample, generally **<2–4 GB**. Whole pipeline comfortably fits in **8–16 GB**; we surface a pre-run estimate and a soft warning under 8 GB.
- Downstream (Mode B / the back half of A) is light: **<1–2 GB**, **seconds to ~1 min**.

---

## 7. PYTHON ENDPOINTS + UI CONTROLS + STORE

### Endpoints (`microbiome.py`, `router = APIRouter()`)
- `GET  /api/microbiome/preflight-r` → wraps `check-r` + checks whether the microbiome package set is installed (a tiny `Rscript -e 'requireNamespace(...)'`), returns `{r_ok, r_version, packages:{dada2:bool, phyloseq:bool, ...}, missing:[...]}`.
- `POST /api/microbiome/install-packages` → kicks an async **install job** (same job machinery) running the `pak::pkg_install(...)` console call; pollable so the UI streams install progress.
- `POST /api/microbiome/validate-fastq-folder` → `{folder_path, r1_regex, r2_regex}` → returns inferred sample pairing table (no compute).
- `POST /api/microbiome/quality-profile` → quick sub-job: DADA2 quality plots for N sample files → returns PNGs (informs truncLen).
- `POST /api/microbiome/upload-tables` (multipart via `proxy_upload`) → parse/validate Mode B tables, returns reconciliation report + a `dataset_token` for the working dir.
- `POST /api/microbiome/validate-ref` → stat + gzip-open the chosen reference FASTA path.
- `POST /api/microbiome/run` → start the main job (mode A or B in body), returns `{job_id}`.
- `GET  /api/microbiome/status/{job_id}` ; `POST /api/microbiome/cancel/{job_id}`.
- `POST /api/microbiome/export-figure` → re-render one figure to SVG/TIFF at requested DPI for the export panel.

Client additions in `src/api/client.ts` (mirroring existing helpers): `microbiomePreflight()`, `installMicrobiomePackages()`, `validateFastqFolder()`, `runMicrobiome(payload)`, `pollMicrobiomeStatus(jobId)`, `cancelMicrobiome(jobId)`, plus a `pickFolder()`/`pickFile()` wrapper around `tauri_plugin_dialog`. Add `MicrobiomeRunPayload`, `MicrobiomeStatus` to `types.ts`.

### UI controls (`src/components/microbiome/MicrobiomeView.tsx` + subcomponents)
- **Mode toggle** (Mode B default): "Start from tables (fast)" / "Start from raw FASTQs (DADA2)".
- **Setup banner**: R status + "Install microbiome R packages" button (only shows missing ones); reference-DB picker (Mode A); host-RAM hint.
- **Mode A panel:** folder picker + pairing preview table + regex override; primers section (3 choices, cutadapt greyed unless detected); DADA2 params (truncLen fwd/rev with the quality-profile plot inline, maxEE fwd/rev, truncQ, trimLeft, pooling `independent|pseudo|pool`, multithread, reference picker, "build tree?" toggle).
- **Mode B panel:** three/four uploaders (OTU, taxonomy, metadata, optional tree/seqs) + orientation auto-detect with manual flip.
- **Shared downstream params:** filtering toggles (chloroplast/mito, prevalence/abundance sliders), rarefaction toggle + depth slider (with rarefaction-curve preview), grouping variable + covariate multiselect (drives both adonis2 and DA formulas), beta metrics checklist (Bray/Jaccard/UniFrac — UniFrac disabled w/o tree), ordination method (PCoA/NMDS), top-N taxa for barplots, **diff-abundance method** (ANCOM-BC2 default) + rank selector + significance threshold.
- **Run/Progress:** Run button → stepper showing stage + % + live log tail + cancel.
- **Results:** tabbed results panel (Tables grid / Figures gallery with the shared TIFF/PNG/SVG export) — identical pattern to the other tabs.

### Store (`src/store/microbiomeStore.ts`, Zustand)
State: `mode`, `refDbPath`, `fastqFolder`, `pairing`, `primerMode`, `dada2Params`, `modeBFiles`, `downstreamParams` (filtering, rarefaction, grouping, covariates, betaMetrics, ordination, topN, daMethod, daRank), `packages`/`rStatus`, `jobId`, `jobStatus`, `progress`, `stage`, `logTail`, `result` (tables + figures), `error`. Actions: `setMode`, `pickRefDb`, `pickFastqFolder`, `validatePairing`, `loadModeBTables`, `installPackages`, `startRun`, `_poll`, `cancel`, `exportFigure`, `reset`. Persist the durable bits (`refDbPath`, last params) to `localStorage` so the user re-runs without re-picking the 130 MB reference.

---

## 8. DECISION FORKS — recommendations

| Fork | Options | **Recommendation** | Why / alternative kept available |
|---|---|---|---|
| **Entry point** | A raw FASTQ / B tables / both | **Both; Mode B is the default landing, Mode A behind "I have raw FASTQs"** | "From scratch" needs A; but most iteration happens on stats/figures (B). Shared downstream half makes both cheap. |
| **Taxonomy reference** | SILVA / GTDB / GreenGenes2 | **SILVA v138.2 (toGenus + species)**, user-supplied via file picker | DADA2 community standard, best genus resolution, turnkey trainset. GTDB offered for genome-based naming; GG2 as advanced. |
| **Primer removal** | trimLeft / cutadapt / already-removed | **Fixed-length `trimLeft`** for fixed primers; "already removed" honored; **cutadapt only if detected** | Keeps zero external-tool dependency in the common case; variable-length primers still possible if cutadapt present. |
| **Rarefaction** | rarefy all / never / split | **Rarefy for alpha+beta (toggle, with curves); raw counts for diff-abundance** | Defensible middle ground; respects McMurdie-Holmes critique for DA while keeping diversity library-size-robust. |
| **Diff-abundance method** | ANCOM-BC2 / ALDEx2 / DESeq2 / corncob | **ANCOM-BC2 default**; ALDEx2 for small-n; DESeq2 (poscounts) for RNA-seq-tab parity; corncob advanced | Compositional, FDR-controlled, covariate-aware, maintained. All four wired and selectable. |
| **Phylogenetic tree / UniFrac** | build tree (DECIPHER+phangorn) / skip | **Skip by default; offer "Build tree for UniFrac" as an opt-in** (Mode A always-possible; Mode B only if rep-seqs provided) | Tree building (MSA + NJ/ML) is slow and memory-heavy for thousands of ASVs and often dominated by Bray-Curtis conclusions anyway. UniFrac available when the user explicitly wants phylogeny-aware beta diversity. |
| **Pooling in `dada`** | independent / pseudo / pool | **`pseudo`** default | Best sensitivity-vs-cost tradeoff for rare ASVs shared across samples; `independent` (fast) and `pool` (most sensitive, slowest) selectable. |
| **Package install mechanism** | install.packages / BiocManager / **pak + P3M binaries** | **pak + P3M/Bioc binaries, R-version-matched** | No toolchain required on win/mac and supported Linux; parallel resolve; clean failure messaging when a Linux distro lacks binaries. |

---

## Key implementation gotchas (flagged for the builder)

1. **Don't route FASTQs through `upload_files_from_paths`** — it re-streams bytes as multipart (fine for KB metadata, wasteful/limiting for multi-GB folders). Hand the **folder path string** to the sidecar and read from disk in Python/R.
2. **120 s `run-r` is bypassed** — the main pipeline must use the new job/Popen path, not the synchronous bridge. Reuse `_resolve_rscript`/`_r_env`/`_r_prelude` by import; don't duplicate R discovery.
3. **R is the host's** — every endpoint must degrade gracefully when R is missing or packages aren't installed, surfacing the install button rather than erroring deep in a run. Bioconductor binaries are R-minor-version-pinned: read host R version first and target the matching Bioc release.
4. **`assignTaxonomy` RAM** is the silent OOM risk — estimate and warn pre-run; allow single-threaded taxonomy on low-RAM hosts.
5. **README is stale** (still says "bundled R / conda env DESeq2"); the NEW DECISION (host R) is already reflected by `check-r`'s host fallback, but the prose and `r-env/` framing should be updated when this tab lands.

Relevant files this design touches or depends on (absolute paths):
- `/Users/zhuojianlook/Library/CloudStorage/Dropbox/GitHub Repos/Webtools/Analysis/TauriApp/python-sidecar/r_bridge.py` (reuse `_resolve_rscript`, `_r_env`, `_r_prelude`, `run-console`)
- `/Users/zhuojianlook/Library/CloudStorage/Dropbox/GitHub Repos/Webtools/Analysis/TauriApp/python-sidecar/api_server.py` (add `"microbiome"` to the router loader loop, line 83)
- `/Users/zhuojianlook/Library/CloudStorage/Dropbox/GitHub Repos/Webtools/Analysis/TauriApp/python-sidecar/config.py`
- `/Users/zhuojianlook/Library/CloudStorage/Dropbox/GitHub Repos/Webtools/Analysis/TauriApp/src/api/client.ts` and `/Users/.../src/api/types.ts` (new helpers + types)
- `/Users/zhuojianlook/Library/CloudStorage/Dropbox/GitHub Repos/Webtools/Analysis/TauriApp/src-tauri/src/lib.rs` (`proxy_request`, `proxy_upload`, `upload_files_from_paths`, `save_base64_to_path`, dialog plugin already present)
- New: `/Users/.../TauriApp/python-sidecar/microbiome.py`, `/Users/.../TauriApp/src/components/microbiome/*`, `/Users/.../TauriApp/src/store/microbiomeStore.ts`, `/Users/.../r-env/rscripts/microbiome/*.R`