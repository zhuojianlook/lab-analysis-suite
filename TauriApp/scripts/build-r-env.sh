#!/usr/bin/env bash
# Build the bundled R engine (conda env) and place it into the Tauri bundle
# resources at TauriApp/src-tauri/resources/r-env. Requires `micromamba` on
# PATH (and `tar`). Run on macOS or Linux. Windows uses build-r-env.ps1.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"            # Analysis/
ENV_FILE="$ROOT/r-env/environment.yml"
OUT="$ROOT/TauriApp/src-tauri/resources/r-env"
TMP="${RUNNER_TEMP:-/tmp}"
BUILD_PREFIX="$TMP/r-build"
TARBALL="$TMP/r-env.tar.gz"

echo "==> Creating R env from $ENV_FILE"
rm -rf "$BUILD_PREFIX"
micromamba create -y -p "$BUILD_PREFIX" -f "$ENV_FILE"
micromamba install -y -p "$BUILD_PREFIX" -c conda-forge conda-pack

echo "==> Smoke test (build env): DESeq2 + ggplot2 load"
micromamba run -p "$BUILD_PREFIX" Rscript -e 'suppressMessages({library(DESeq2); library(ggplot2)}); cat("build-env OK\n")'

echo "==> conda-pack (relocatable tarball)"
rm -f "$TARBALL"
micromamba run -p "$BUILD_PREFIX" conda-pack -p "$BUILD_PREFIX" -o "$TARBALL" --n-threads -1 --compress-level 6 --force

echo "==> Unpack into bundle resources: $OUT"
rm -rf "$OUT"; mkdir -p "$OUT"
tar -xzf "$TARBALL" -C "$OUT"
"$OUT/bin/conda-unpack"

echo "==> Prune docs/help/tests to cut size"
find "$OUT/lib/R/library" -maxdepth 2 -type d \
  \( -name doc -o -name help -o -name tests -o -name html -o -name examples -o -name doc-examples \) \
  -prune -exec rm -rf {} + 2>/dev/null || true
rm -rf "$OUT/share/doc" "$OUT/man" "$OUT/share/man" 2>/dev/null || true

echo "==> Smoke test (packed env)"
"$OUT/bin/Rscript" -e 'suppressMessages({library(DESeq2); library(ggplot2)}); cat("packed-env OK\n")'
du -sh "$OUT" 2>/dev/null || true
echo "==> Bundled R engine ready at $OUT"
