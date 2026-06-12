# Lab Analysis Suite

A cross-platform (macOS / Windows / Linux) desktop app that combines lab
analysis tools into one tabbed application with an internal auto-updater:

- **qPCR** — ΔΔCt gene-expression analysis (t-test / ANOVA + Tukey)
- **xCELLigence** — E-Plate impedance time-course analysis
- **Bulk RNA-seq** — DESeq2 differential-expression pipeline
- **scRNA-seq** — Seurat v5 single-cell pipeline
- **Spatial** — Visium spatial transcriptomics (Seurat)
- **16S rRNA** — microbiome pipeline (DADA2 + phyloseq)
- **Plate Mapper** — 6–384 well plate layout builder + Excel/TSV export

## Architecture

```
React + TypeScript + MUI (WebView, tabs)
        │  Tauri IPC proxy (invoke → Rust)
        ▼
Rust (Tauri v2)  — spawns sidecar, proxies HTTP, auto-updater
        │  http://127.0.0.1:8765
        ▼
Python FastAPI sidecar  — ALL analysis logic (pandas / scipy / statsmodels)
        │  subprocess: Rscript  (the user's LOCAL R)
        ▼
R (user's install) + ggplot2 / DESeq2 / Seurat / dada2 — ALL plotting + heavy stats
```

**R is the user's local install** (not bundled — keeps installers ~90 MB). If R
is missing the app guides the user to install it; each tab installs the R
packages it needs on first use as **binaries** via `pak` + Posit P3M, so no
C/C++/Fortran toolchain is required on Windows/macOS (Linux LTS via P3M). Heavy
pipelines (scRNA-seq, spatial, 16S) run as background jobs with progress.

## Repo layout

```
Analysis/
  TauriApp/
    src/               # React frontend (tabs in components/<tab>/)
    src-tauri/         # Rust shell + tauri.conf.json + capabilities
    python-sidecar/    # FastAPI sidecar: api_server.py, r_bridge.py,
                       #   r_settings.py, r_packages.py, <tab>.py
    scripts/           # build-sidecar.sh (PyInstaller)
  r-env/               # OPTIONAL portable R for locked-down machines
  docs/design/         # full per-pipeline design docs
  .github/workflows/   # release CI (sidecar + Tauri + minisign updater)
```

## Build from source

Prerequisites: Node 18+, Rust 1.77+, Python 3.10+. (No R toolchain needed to
build the app; R is the end user's local install.)

```bash
cd TauriApp
npm install

# Build the Python sidecar (PyInstaller)
python -m venv .venv && . .venv/bin/activate
pip install -r python-sidecar/requirements.txt
./scripts/build-sidecar.sh                 # → src-tauri/binaries/api-server-<triple>

# Dev (run sidecar separately, then Vite + Tauri):
python python-sidecar/api_server.py --port 8765 &
npm run tauri dev

# Production bundle:
npm run tauri build
```

To exercise R features in dev, install R from https://cran.r-project.org/ (the
app discovers it automatically; you can also set a custom path in-app).

## Setup tasks before the first release

1. `gh auth refresh -h github.com -s workflow`, then push `main`.
2. `npm run tauri signer generate` → public key into `src-tauri/tauri.conf.json`
   (`plugins.updater.pubkey`, currently a placeholder) + private key + password
   in CI secrets `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
3. `npm run tauri icon <png>` to generate `src-tauri/icons/`.
4. (macOS, optional) self-signed cert in `MACOS_CERT_P12_BASE64` /
   `MACOS_CERT_PASSWORD` — do NOT name it `APPLE_SIGNING_IDENTITY`.

## Status

- [x] Phase 0 — scaffold + sidecar handshake (sidecar verified)
- [x] Plate Mapper tab (export verified)
- [~] Host-R refactor + R package system (manifests + binary installer done)
- [ ] qPCR · xCELLigence · Bulk RNA-seq (DESeq2)
- [ ] scRNA-seq · Spatial · 16S rRNA
- [ ] CI/updater first green release · packaging per OS
```
