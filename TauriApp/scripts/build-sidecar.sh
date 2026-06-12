#!/bin/bash
# Build the Python sidecar as a standalone binary using PyInstaller.
# Usage: ./scripts/build-sidecar.sh [target-triple]
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SIDECAR_DIR="$PROJECT_DIR/python-sidecar"
BIN_DIR="$PROJECT_DIR/src-tauri/binaries"

if [ -n "$1" ]; then
    TRIPLE="$1"
else
    TRIPLE=$(rustc -vV | grep 'host:' | awk '{print $2}')
fi

echo "Building sidecar for: $TRIPLE"
cd "$SIDECAR_DIR"

pyinstaller --onefile \
    --name "api-server" \
    --hidden-import=uvicorn.logging \
    --hidden-import=uvicorn.protocols.http \
    --hidden-import=uvicorn.protocols.http.auto \
    --hidden-import=uvicorn.protocols.websockets \
    --hidden-import=uvicorn.protocols.websockets.auto \
    --hidden-import=uvicorn.lifespan \
    --hidden-import=uvicorn.lifespan.on \
    --hidden-import=uvicorn.lifespan.off \
    --hidden-import=multipart \
    --hidden-import=multipart.multipart \
    --hidden-import=config \
    --hidden-import=r_bridge \
    --hidden-import=r_settings \
    --hidden-import=r_packages \
    --hidden-import=rjobs \
    --hidden-import=platemap \
    --hidden-import=qpcr \
    --hidden-import=xcelligence \
    --hidden-import=rnaseq \
    --hidden-import=scrna \
    --hidden-import=spatial \
    --hidden-import=microbiome \
    --collect-all pandas \
    --collect-all numpy \
    --collect-all scipy \
    --collect-all statsmodels \
    --collect-all openpyxl \
    --collect-all xlsxwriter \
    --exclude-module matplotlib \
    --exclude-module PIL \
    --exclude-module cv2 \
    --exclude-module tkinter \
    --noconfirm \
    api_server.py

mkdir -p "$BIN_DIR"
cp "dist/api-server" "$BIN_DIR/api-server-${TRIPLE}"
chmod +x "$BIN_DIR/api-server-${TRIPLE}"

echo ""
echo "Sidecar built: $BIN_DIR/api-server-${TRIPLE}"
ls -lh "$BIN_DIR/api-server-${TRIPLE}"
