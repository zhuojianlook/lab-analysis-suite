"""Graphs tool — Prism-style data tables, statistics and figures.

Endpoints (all JSON; errors are HTTP 200 {"error", "code"} so the client's
parseApi shows them instead of throwing; the Rust proxy has no DELETE, so
deletes are POST):

  GET  /api/graph/library                -> {analyses, path}
  GET  /api/graph/library/get?id=        -> {analysis}
  POST /api/graph/library/save           -> {analysis, replaced, analyses, path}
  POST /api/graph/library/rename         -> {analysis, analyses, path}
  POST /api/graph/library/duplicate      -> {analysis, analyses, path}
  POST /api/graph/library/delete         -> {analyses, path}
  POST /api/graph/analyze                -> AnalyzeResult
  POST /api/graph/plot                   -> run-r response + {warnings}
  GET  /api/graph/software               -> {app, python, numpy, scipy, r, ggplot2, ggprism}
                                            (versions for the methods text; each a string or null)

Statistics live in graph_stats, R code generation in graph_plot and the
SQLite store in graph_library. Keep every @router decorator directly above
its def: api_server swallows import errors, so a broken module silently
removes the whole tool.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import platform
import re
import subprocess
import tempfile
import threading
from collections import OrderedDict
from typing import Any, Dict, Optional

import numpy as np
import scipy
from fastapi import APIRouter, Body

import config
import graph_library as lib
import graph_plot
import graph_stats
import r_bridge

router = APIRouter()


def _err(e: lib.LibraryError) -> dict:
    out = {"error": str(e), "code": e.code}
    if e.conflict:
        out["conflict"] = e.conflict
    return out


def _listing() -> dict:
    return {"analyses": lib.list_analyses(), "path": lib.db_path()}


_INT_RE = re.compile(r"^\s*[+-]?[0-9]{1,30}\s*$")


def _id(v: Any) -> Optional[int]:
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, str) and _INT_RE.match(v):
        v = int(v.strip())           # query strings: exact, not via float
    if isinstance(v, int):           # exact, however large (float() would round it)
        if abs(v) > lib.MAX_INT:
            raise lib.LibraryError("id is out of range.", "invalid")
        return v
    try:
        f = float(v)
    except (TypeError, ValueError, OverflowError):
        raise lib.LibraryError("id must be a number.", "invalid")
    if not math.isfinite(f) or f != math.floor(f):
        raise lib.LibraryError("id must be a whole number.", "invalid")
    if abs(f) >= 2.0 ** 63:
        raise lib.LibraryError("id is out of range.", "invalid")
    return int(f)


def _body(body: Any) -> Dict[str, Any]:
    if not isinstance(body, dict):
        raise lib.LibraryError("The request body must be a JSON object.", "invalid")
    return body


@router.get("/api/graph/library")
def library():
    try:
        return _listing()
    except lib.LibraryError as e:
        return {**_err(e), "analyses": [], "path": lib.db_path()}


@router.get("/api/graph/library/get")
def library_get(id: Optional[str] = None):  # noqa: A002 - query name is part of the API
    try:
        aid = _id(id)
        if aid is None:
            raise lib.LibraryError("id is required.", "invalid")
        return {"analysis": lib.get_analysis(aid)}
    except lib.LibraryError as e:
        return _err(e)


@router.post("/api/graph/library/save")
def library_save(body: Any = Body(None)):
    try:
        b = _body(body)
        summary, replaced = lib.save_analysis(
            _id(b.get("id")), b.get("name"), b.get("template"), b.get("table"), b.get("analysis"),
            b.get("figure"), b.get("doc_version", 1), bool(b.get("overwrite", False)))
        return {"analysis": summary, "replaced": replaced, **_listing()}
    except lib.LibraryError as e:
        return _err(e)


@router.post("/api/graph/library/rename")
def library_rename(body: Any = Body(None)):
    try:
        b = _body(body)
        aid = _id(b.get("id"))
        if aid is None:
            raise lib.LibraryError("id is required.", "invalid")
        return {"analysis": lib.rename_analysis(aid, b.get("name")), **_listing()}
    except lib.LibraryError as e:
        return _err(e)


@router.post("/api/graph/library/duplicate")
def library_duplicate(body: Any = Body(None)):
    try:
        b = _body(body)
        aid = _id(b.get("id"))
        if aid is None:
            raise lib.LibraryError("id is required.", "invalid")
        return {"analysis": lib.duplicate_analysis(aid, b.get("name")), **_listing()}
    except lib.LibraryError as e:
        return _err(e)


@router.post("/api/graph/library/delete")
def library_delete(body: Any = Body(None)):
    try:
        b = _body(body)
        aid = _id(b.get("id"))
        if aid is None:
            raise lib.LibraryError("id is required.", "invalid")
        lib.delete_analysis(aid)
        return _listing()
    except lib.LibraryError as e:
        return _err(e)


# The app posts the same table + analysis to /analyze and then /plot, and
# re-plots on every figure-only change: keep the last few statistics results
# so a plot never recomputes them.
_CACHE: "OrderedDict[str, dict]" = OrderedDict()
_CACHE_LOCK = threading.Lock()
_CACHE_SIZE = 4


def _compute(table: Any, analysis: Any) -> dict:
    try:
        key = hashlib.sha1(json.dumps([table, analysis], sort_keys=True, default=repr)
                           .encode("utf-8", "surrogatepass")).hexdigest()
    except (TypeError, ValueError, RecursionError):
        return graph_stats.compute(table, analysis)
    with _CACHE_LOCK:
        hit = _CACHE.get(key)
        if hit is not None:
            _CACHE.move_to_end(key)
            return hit
    res = graph_stats.compute(table, analysis)
    with _CACHE_LOCK:
        _CACHE[key] = res
        while len(_CACHE) > _CACHE_SIZE:
            _CACHE.popitem(last=False)
    return res


def _unexpected(e: Exception) -> str:
    return f"The analysis couldn't be computed ({type(e).__name__}: {e})."


@router.post("/api/graph/analyze")
def analyze(body: Any = Body(None)):
    if not isinstance(body, dict):
        return {**graph_stats._empty_result(), "error": "The request body must be a JSON object.", "code": "invalid"}
    try:
        return graph_stats.public(_compute(body.get("table"), body.get("analysis")))
    except Exception as e:  # noqa: BLE001 - the contract is an error envelope, never an HTTP 500
        return {**graph_stats._empty_result(), "error": _unexpected(e), "code": "invalid"}


@router.post("/api/graph/plot")
def plot(body: Any = Body(None)):
    if not isinstance(body, dict):
        return graph_plot._fail("The request body must be a JSON object.")
    try:
        table, analysis = body.get("table"), body.get("analysis")
        return graph_plot.render(table, analysis, body.get("figure"), result=_compute(table, analysis))
    except Exception as e:  # noqa: BLE001
        return graph_plot._fail(_unexpected(e))


# ── software versions (cited in the generated statistical methods) ─────────
#
# Only versions read from the running engine are reported; anything unknown is
# None (the client then leaves it out rather than guessing). The R probe is
# cached per Rscript path once R, ggplot2 and ggprism all answered; a failure
# or a missing package is not cached, so installing R / a package while the
# app is open shows up on the next request.

_R_PROBE = (
    'cat("R\\t", as.character(getRversion()), "\\n", sep="")\n'
    'for (p in c("ggplot2", "ggprism")) {\n'
    '  v <- tryCatch(as.character(utils::packageVersion(p)), error=function(e) "MISSING")\n'
    '  cat(p, "\\t", v, "\\n", sep="")\n'
    '}\n'
)
_R_KEYS = {"R": "r", "ggplot2": "ggplot2", "ggprism": "ggprism"}
_VERSION_RE = re.compile(r"^[0-9]+(?:[.-][0-9]+){0,4}$")
_R_CACHE: Dict[str, dict] = {}
_R_CACHE_LOCK = threading.Lock()


def _version(v: Any) -> Optional[str]:
    s = str(v).strip() if v is not None else ""
    return s if _VERSION_RE.match(s) else None


def _r_versions() -> dict:
    out: Dict[str, Optional[str]] = {"r": None, "ggplot2": None, "ggprism": None}
    try:
        rscript, is_bundled = r_bridge._resolve_rscript()
    except Exception:  # noqa: BLE001
        return out
    if not rscript:
        return out
    with _R_CACHE_LOCK:
        hit = _R_CACHE.get(rscript)
    if hit is not None:
        return dict(hit)
    try:
        env = r_bridge._r_env(rscript, is_bundled) or os.environ.copy()
        with tempfile.TemporaryDirectory(prefix="las_versions_") as tmp:
            sp = os.path.join(tmp, "versions.R")
            with open(sp, "w", encoding="utf-8") as f:
                f.write(_R_PROBE)
            res = subprocess.run([rscript, sp], capture_output=True, text=True, timeout=20, env=env)
    except Exception:  # noqa: BLE001 - no R, timeout, unreadable output: versions stay unknown
        return out
    for line in (res.stdout or "").splitlines():
        if "\t" not in line:
            continue
        name, ver = line.split("\t", 1)
        key = _R_KEYS.get(name.strip())
        if key:
            out[key] = _version(ver)
    if all(out.values()):
        with _R_CACHE_LOCK:
            _R_CACHE[rscript] = dict(out)
    return out


def _safe(fn) -> Optional[str]:
    try:
        return _version(fn())
    except Exception:  # noqa: BLE001
        return None


@router.get("/api/graph/software")
def software():
    out = {"app": _safe(lambda: config.APP_VERSION), "python": _safe(platform.python_version),
           "numpy": _safe(lambda: np.__version__), "scipy": _safe(lambda: scipy.__version__),
           "r": None, "ggplot2": None, "ggprism": None}
    try:
        out.update(_r_versions())
    except Exception:  # noqa: BLE001 - never an HTTP 500: unknown versions are simply omitted
        pass
    return out
