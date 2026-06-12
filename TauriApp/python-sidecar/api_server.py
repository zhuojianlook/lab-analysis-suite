"""Lab Analysis Suite — FastAPI sidecar.

Holds ALL analysis logic (pandas / scipy / statsmodels). Plotting is delegated
to a bundled R engine via r_bridge. The Tauri shell spawns this as a
PyInstaller --onefile binary and proxies HTTP to it on 127.0.0.1:<port>.
"""

from __future__ import annotations

import argparse
import sys

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
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
        resp = await call_next(request)
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

# Tab routers are added as each tab is implemented (Phase 2). Imported lazily
# so the sidecar still boots while a module is a work in progress.
for _mod in ("platemap", "qpcr", "xcelligence", "rnaseq"):
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
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
