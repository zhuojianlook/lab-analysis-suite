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
./scripts/build-sidecar.sh                 # → src-tauri/binaries/las-engine-<triple>

# Dev (run the engine separately, then Vite + Tauri). Port 8765 (other apps'
# engines; this app's releases up to 0.2.22) and the app's own folders belong
# to someone else, so the dev engine gets
# another port and a scratch data folder, and a debug build must be told both
# (it refuses to start without LAS_SIDECAR_PORT / LAS_STATE_DIR, and refuses
# 8765 or a folder inside the installed app's folders):
LAS_DATA_DIR="$(mktemp -d)" python python-sidecar/api_server.py --port 8766 &
LAS_SIDECAR_PORT=8766 LAS_STATE_DIR="$(mktemp -d)" npm run tauri dev

# Or let the debug build start and supervise the engine like a release build
# (free port, per-launch token, restart when it dies):
LAS_DEV_ENGINE_CMD='["'"$PWD"'/.venv/bin/python", "-B", "'"$PWD"'/python-sidecar/api_server.py"]' \
  LAS_SIDECAR_PORT=8766 LAS_STATE_DIR="$(mktemp -d)" npm run tauri dev

# Check a built engine identifies itself (release CI runs this on the frozen
# las-engine; it also takes the dev engine command):
python scripts/smoke-engine.py python-sidecar/dist/las-engine/las-engine

# Frontend unit tests (vitest):
npm test

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

- [x] Phase 0 — scaffold + sidecar handshake
- [x] Host-R refactor + R package system (pak/P3M binary installer)
- [x] All 7 tabs: Plate Mapper · qPCR · xCELLigence · Bulk RNA-seq (DESeq2) ·
      scRNA-seq · Spatial · 16S rRNA
- [x] CI/updater release pipeline (3-OS GitHub Actions)
- [ ] First green CI release + packaging/signing per OS (needs the setup tasks above)

All Python analysis logic + the 34 sidecar routes are verified locally. The
TypeScript/Tauri build and the R/ggplot/Seurat/DESeq2/DADA2 templates are
verified when you build and run with Node + Rust + R installed (`npm install`,
then the two dev commands above).
```
