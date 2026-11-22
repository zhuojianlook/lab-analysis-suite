"""Smoke-test a built analysis engine (release CI, after PyInstaller).

    python smoke-engine.py <engine executable> [extra args...]
    python smoke-engine.py python -B api_server.py      # the dev engine

Starts the engine the way the app does (a free port with --port, a launch
token in LAS_ENGINE_TOKEN, --parent-pid), then checks that:
  * GET /api/health answers {"status": "ok", "app": "lab-analysis-suite"}
    with the token it was given (src-tauri/src/engine.rs verify_health);
  * /api/analysis/check-packages exists (any answer but 404) — the route
    another app's engine lacked.
Stops the engine it started (by its pid) and exits non-zero on any failure.
Uses a throw-away data folder (LAS_DATA_DIR), never the user's.
Standard library only, so it runs on every CI runner.
"""

from __future__ import annotations

import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

APP_ID = "lab-analysis-suite"
LEGACY_PORT = 8765  # other apps' engines live there; never used
BOOT_TIMEOUT_S = 180


def free_port() -> int:
    for _ in range(32):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        if port != LEGACY_PORT:
            return port
    raise SystemExit("no free port")


def get(port: int, path: str, timeout: float = 5) -> tuple[int, str]:
    # No proxy: a runner's HTTP(S)_PROXY must not route localhost.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(f"http://127.0.0.1:{port}{path}", timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def resolve(exe: str) -> str:
    # Windows: dist/las-engine/las-engine -> las-engine.exe
    if not os.path.exists(exe) and os.path.exists(exe + ".exe"):
        return exe + ".exe"
    return exe


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 2
    cmd = [resolve(argv[0]), *argv[1:]]
    # LAS_SMOKE_PORT: a fixed port for local runs; CI lets the OS pick one.
    port = int(os.environ.get("LAS_SMOKE_PORT") or 0) or free_port()
    token = "smoke-" + secrets.token_hex(16)
    data_dir = tempfile.mkdtemp(prefix="las-smoke-")
    env = dict(os.environ, LAS_ENGINE_TOKEN=token, LAS_DATA_DIR=data_dir)
    full = [*cmd, "--port", str(port), "--parent-pid", str(os.getpid())]
    print(f"[smoke] starting {cmd[0]} on port {port}", flush=True)
    proc = subprocess.Popen(full, env=env)
    failures: list[str] = []
    try:
        deadline = time.monotonic() + BOOT_TIMEOUT_S
        body = None
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                failures.append(f"the engine exited during start-up (code {proc.returncode})")
                break
            try:
                status, text = get(port, "/api/health", timeout=3)
                if status == 200:
                    body = text
                    break
            except OSError:
                pass
            time.sleep(1)
        if body is None and not failures:
            failures.append(f"no health answer within {BOOT_TIMEOUT_S} s")
        if body is not None:
            print(f"[smoke] health answered after {BOOT_TIMEOUT_S - (deadline - time.monotonic()):.1f} s", flush=True)
            try:
                h = json.loads(body)
            except ValueError:
                h = {}
                failures.append("the health answer is not JSON")
            if h.get("status") != "ok":
                failures.append("health status is not ok")
            if h.get("app") != APP_ID:
                failures.append(f"health does not name the app (app={h.get('app')!r})")
            if h.get("token") != token:
                failures.append("health does not echo the launch token")
            try:
                status, _ = get(port, "/api/analysis/check-packages?names=stats", timeout=90)
                print(f"[smoke] /api/analysis/check-packages -> HTTP {status}", flush=True)
                if status == 404:
                    failures.append("/api/analysis/check-packages is missing (404)")
            except OSError as e:
                failures.append(f"/api/analysis/check-packages did not answer ({e})")
    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=10)
        shutil.rmtree(data_dir, ignore_errors=True)
    if failures:
        for f in failures:
            print(f"[smoke] FAIL: {f}", flush=True)
        return 1
    print("[smoke] OK: the engine identifies itself and has its routes", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
