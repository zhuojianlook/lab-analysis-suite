"""Lab Analysis Suite — FastAPI sidecar.

Holds ALL analysis logic (pandas / scipy / statsmodels). Plotting is delegated
to R via r_bridge. The Tauri shell spawns this as the PyInstaller --onedir
executable "las-engine" on a free port it picks, and proxies HTTP to it on
127.0.0.1:<port>. The shell also passes a per-launch token in the environment
(LAS_ENGINE_TOKEN); /api/health echoes it so the shell can tell this engine
from another program answering on the same port.
"""

from __future__ import annotations

import argparse
import os
import sys

print("[las-engine] booting (loading analysis libraries)…", flush=True)

import traceback

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from starlette.middleware.base import BaseHTTPMiddleware

import config
from r_bridge import router as r_router

app = FastAPI(title="Lab Analysis Suite", version=config.APP_VERSION)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class PrivateNetworkMiddleware(BaseHTTPMiddleware):
    """WebView2 (Windows) sends a CORS-RFC1918 preflight for requests to
    127.0.0.1 from the app origin; answer it so fetch() / proxied calls work."""

    async def dispatch(self, request: Request, call_next):
        if request.method == "OPTIONS":
            resp = Response(status_code=204)
            resp.headers["Access-Control-Allow-Origin"] = "*"
            resp.headers["Access-Control-Allow-Methods"] = "*"
            resp.headers["Access-Control-Allow-Headers"] = "*"
            resp.headers["Access-Control-Allow-Private-Network"] = "true"
            return resp
        # Catch unhandled endpoint exceptions HERE (inside the outermost user
        # middleware) and return a JSON envelope. The app-level
        # exception_handler(Exception) does NOT work reliably with
        # BaseHTTPMiddleware (the error escapes via ServerErrorMiddleware as
        # plain-text "Internal Server Error"), which the JSON-parsing frontend
        # surfaces as the cryptic "JSON Parse error: Unexpected identifier
        # Internal". Catching at this layer guarantees a parseable error body.
        try:
            resp = await call_next(request)
        except Exception as exc:  # noqa: BLE001
            print(f"[error] {request.method} {request.url.path}: {exc}\n{traceback.format_exc()}",
                  file=sys.stderr, flush=True)
            msg = f"{type(exc).__name__}: {exc}"
            resp = JSONResponse(status_code=500, content={"error": msg, "detail": msg})
        resp.headers["Access-Control-Allow-Private-Network"] = "true"
        return resp


app.add_middleware(PrivateNetworkMiddleware)


# ── Core endpoints ──────────────────────────────────────────────────────────

# Identity for GET /api/health (src-tauri/src/engine.rs ENGINE_APP_ID).
ENGINE_APP_ID = "lab-analysis-suite"
ENV_ENGINE_TOKEN = "LAS_ENGINE_TOKEN"
# This launch's token, set in main() from the environment. None for a dev
# engine started by hand (the app then checks the app name only).
_engine_token: str | None = None


def set_engine_token(token: str | None) -> None:
    global _engine_token
    _engine_token = token or None


def take_engine_token_from_env() -> str | None:
    """Read the launch token and remove it from the environment, so R and other
    subprocesses this engine starts do not inherit it. The token only tells
    this launch's engine apart from another program on the port; it is not a
    secret (/api/health returns it to any local caller) and must never be used
    to authorize anything."""
    return os.environ.pop(ENV_ENGINE_TOKEN, "") or None


def health_payload(token: str | None) -> dict:
    out = {"status": "ok", "app": ENGINE_APP_ID}
    if token:
        out["token"] = token
    return out


# async: answered on the event loop, not in the worker thread pool, so the
# app's liveness check (engine.rs `Liveness`) gets an answer even while every
# worker thread is busy with long R calls.
@app.get("/api/health")
async def health():
    return health_payload(_engine_token)


@app.get("/api/version")
def version():
    return {"build": config.APP_VERSION}


@app.post("/api/analysis/warmup")
def warmup():
    """Force lazy imports (pandas/scipy/statsmodels) so the first real request
    doesn't pay the cold-start cost. Safe to call repeatedly."""
    try:
        import numpy  # noqa: F401
        import pandas  # noqa: F401
        import scipy  # noqa: F401
        return {"status": "warm"}
    except Exception as e:  # noqa: BLE001
        return {"status": "error", "detail": str(e)}


# ── Routers ─────────────────────────────────────────────────────────────────

app.include_router(r_router)

# R settings (Rscript-path persistence) + the package check/install system.
from r_settings import router as r_settings_router  # noqa: E402
from r_packages import router as r_packages_router  # noqa: E402
app.include_router(r_settings_router)
app.include_router(r_packages_router)

# Tab routers are added as each tab is implemented (Phase 2). Imported lazily
# so the sidecar still boots while a module is a work in progress.
for _mod in ("platemap", "qpcr", "xcelligence", "rnaseq", "scrna", "spatial", "microbiome", "graph"):
    try:
        _m = __import__(_mod)
        if hasattr(_m, "router"):
            app.include_router(_m.router)
    except ImportError:
        pass
    except Exception as _e:  # noqa: BLE001
        print(f"[startup] failed to load {_mod} router: {_e}", file=sys.stderr, flush=True)


def _watch_parent(pid: int) -> None:
    """Exit when the app that started us is gone (crash, force-quit), so an
    orphaned engine never keeps the port for the next launch."""
    import threading
    import time

    started_under = os.getppid() if os.name != "nt" else None

    def alive() -> bool:
        if os.name == "nt":
            import ctypes
            k32 = ctypes.windll.kernel32
            h = k32.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
            if not h:
                return False
            try:
                return k32.WaitForSingleObject(h, 0) == 0x102  # WAIT_TIMEOUT
            finally:
                k32.CloseHandle(h)
        # Re-parented (to launchd/init) means the app is gone, even if its pid
        # was reused by something else.
        if started_under == pid and os.getppid() != pid:
            return False
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            return True

    def loop() -> None:
        while True:
            time.sleep(2)
            if not alive():
                print(f"[las-engine] parent {pid} gone; exiting", flush=True)
                os._exit(0)

    threading.Thread(target=loop, daemon=True, name="parent-watch").start()


def main():
    parser = argparse.ArgumentParser(description="Lab Analysis Suite sidecar")
    # The app always passes --port (a free port it picked). The default is only
    # for starting a dev engine by hand, and is deliberately not 8765: that
    # port belongs to other apps' engines (and to releases up to 0.2.22).
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--r-env-dir", dest="r_env_dir", default=None,
                        help="Path to the bundled R engine (relocated conda env).")
    parser.add_argument("--parent-pid", dest="parent_pid", type=int, default=None,
                        help="Exit when this process (the app) is gone.")
    args = parser.parse_args()

    set_engine_token(take_engine_token_from_env())

    if args.parent_pid:
        _watch_parent(args.parent_pid)

    config.set_r_env_dir(args.r_env_dir)

    import uvicorn
    print(f"[las-engine] listening on http://{args.host}:{args.port}", flush=True)
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
