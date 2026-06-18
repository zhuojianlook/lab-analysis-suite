"""Lab Analysis Suite — FastAPI sidecar.

Holds ALL analysis logic (pandas / scipy / statsmodels). Plotting is delegated
to a bundled R engine via r_bridge. The Tauri shell spawns this as a
PyInstaller --onefile binary and proxies HTTP to it on 127.0.0.1:<port>.
"""

from __future__ import annotations

import argparse
import sys

print("[api-server] booting (loading analysis libraries)…", flush=True)

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

@app.get("/api/health")
def health():
    return {"status": "ok"}


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
for _mod in ("platemap", "qpcr", "xcelligence", "rnaseq", "scrna", "spatial", "microbiome"):
    try:
        _m = __import__(_mod)
        if hasattr(_m, "router"):
            app.include_router(_m.router)
    except ImportError:
        pass
    except Exception as _e:  # noqa: BLE001
        print(f"[startup] failed to load {_mod} router: {_e}", file=sys.stderr, flush=True)


def main():
    parser = argparse.ArgumentParser(description="Lab Analysis Suite sidecar")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--r-env-dir", dest="r_env_dir", default=None,
                        help="Path to the bundled R engine (relocated conda env).")
    args = parser.parse_args()

    config.set_r_env_dir(args.r_env_dir)

    import uvicorn
    print(f"[api-server] listening on http://{args.host}:{args.port}", flush=True)
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
