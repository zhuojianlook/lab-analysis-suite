# Lab Analysis Suite

A cross-platform (macOS / Windows / Linux) desktop app that combines four lab
analysis tools into one tabbed application with an internal auto-updater:

- **qPCR** — ΔΔCt gene-expression analysis (t-test / ANOVA + Tukey)
- **xCELLigence** — E-Plate impedance time-course analysis
- **Bulk RNA-seq** — DESeq2 differential-expression pipeline
- **Plate Mapper** — 6–384 well plate layout builder + Excel/TSV export

## Architecture

```
React + TypeScript + MUI (WebView, 4 tabs)
        │  Tauri IPC proxy (invoke → Rust)
        ▼
Rust (Tauri v2)  — spawns sidecar, proxies HTTP, auto-updater
        │  http://127.0.0.1:8765
        ▼
Python FastAPI sidecar  — ALL analysis logic (pandas / scipy / statsmodels)
        │  subprocess: Rscript (R_HOME/R_LIBS → bundled R)
        ▼
Bundled R engine (conda: ggplot2 + DESeq2)  — ALL plotting, shipped offline
```

The Python↔R bridge (`python-sidecar/r_bridge.py`) is adapted from the
`multipanelfigure` app. Plotting is done entirely in R/ggplot2.

## Repo layout

```
Analysis/
  TauriApp/            # the app (mirrors multipanelfigure/TauriApp)
    src/               # React frontend (tabs in components/<tab>/)
    src-tauri/         # Rust shell + tauri.conf.json + capabilities
      resources/r-env/ # bundled R engine (gitignored; CI/build populated)
    python-sidecar/    # FastAPI sidecar: api_server.py, r_bridge.py, <tab>.py
    scripts/           # build-sidecar.sh (PyInstaller)
  r-env/               # bundled R engine spec (environment.yml) + R templates
  .github/workflows/   # release CI (Phase 3)
```

## Build from source

Prerequisites: Node 18+, Rust 1.77+, Python 3.10+, and micromamba/conda.

```bash
cd TauriApp
npm install

# Build the Python sidecar (PyInstaller)
python -m venv .venv && . .venv/bin/activate
pip install -r python-sidecar/requirements.txt
./scripts/build-sidecar.sh                 # → src-tauri/binaries/api-server-<triple>

# Build the bundled R engine (see ../r-env/README.md), then:
#   cp -R <unpacked r-env> src-tauri/resources/r-env

# Dev (run sidecar separately, then Vite + Tauri):
python python-sidecar/api_server.py --port 8765 &
npm run tauri dev

# Production bundle:
npm run tauri build
```

## Setup tasks before the first release

1. Create a GitHub repo `zhuojianlook/lab-analysis-suite`; push; create an
   orphan `updater` branch.
2. `npm run tauri signer generate` → put the **public** key in
   `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`, currently a
   placeholder) and the private key + password in CI secrets
   `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
3. (macOS, optional) self-signed cert in `MACOS_CERT_P12_BASE64` /
   `MACOS_CERT_PASSWORD` — do NOT name it `APPLE_SIGNING_IDENTITY` (keeps the
   hardened runtime off so the bundled R can dlopen its libs).

## Status

- [x] Phase 0 — scaffold + sidecar handshake (sidecar verified; app build runs on your toolchain)
- [ ] Phase 1 — bundled R proof-of-concept
- [ ] Phase 2 — tabs (Plate Mapper, qPCR, xCELLigence, Bulk RNA-seq)
- [ ] Phase 3 — updater + CI release pipeline
- [ ] Phase 4 — packaging / signing per OS
