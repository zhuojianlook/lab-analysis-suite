"""Graphs tool — Prism-style data tables, statistics and figures.

Endpoints (all JSON; errors are HTTP 200 {"error", "code"} so the client's
parseApi shows them instead of throwing; the Rust proxy has no DELETE, so
deletes are POST):

  GET  /api/graph/library                -> {analyses, path}
  GET  /api/graph/library/get?id=        -> {analysis}   (analysis.scratchpad: object or null)
  POST /api/graph/library/save           -> {analysis, replaced, analyses, path}
                                            (body may carry "scratchpad": {v, cells, cols?} or null;
                                             never sent to /analyze or /plot)
  POST /api/graph/library/rename         -> {analysis, analyses, path}
  POST /api/graph/library/duplicate      -> {analysis, analyses, path}
  POST /api/graph/library/delete         -> {analyses, path}
  POST /api/graph/analyze                -> AnalyzeResult
  POST /api/graph/plot                   -> run-r response + {warnings}
  GET  /api/graph/software               -> {app, python, numpy, scipy, r, ggplot2, ggprism}
                                            (versions for the methods text; each a string or null)
  GET  /api/graph/palettes               -> {available, source, version, r, reason, message,
                                             colour, fill, themes} (ggprism palettes and colour
                                             schemes read from the user's R; built-ins when not)

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
            b.get("figure"), b.get("doc_version", 1), bool(b.get("overwrite", False)), scratchpad=b.get("scratchpad"))
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
        res = graph_plot.render(table, analysis, body.get("figure"), result=_compute(table, analysis))
        _warn_unknown_scheme(body.get("figure"), res)
        return res
    except Exception as e:  # noqa: BLE001
        return graph_plot._fail(_unexpected(e))


def _warn_unknown_scheme(figure: Any, res: Any) -> None:
    """A well-formed scheme name the installed ggprism doesn't have (e.g. a
    document saved with another ggprism version) is drawn with the standard
    Prism theme by the R-side check; say so. Uses only an already cached
    palette probe, never starts one, so plotting is not slowed down."""
    try:
        if not isinstance(figure, dict) or not isinstance(res, dict):
            return
        pp = figure.get("prism_palette")
        theme = figure.get("theme") if figure.get("theme") in ("prism", "classic", "minimal") else "prism"
        if not isinstance(pp, str) or not pp or theme != "prism" or not graph_plot._PRISM_NAME.fullmatch(pp) or pp == "all_null":
            return
        rscript, _ = r_bridge._resolve_rscript()
        with _PAL_CACHE_LOCK:
            hit = _PAL_CACHE.get(rscript) if rscript else None
        if not hit or pp in (hit.get("themes") or {}):
            return
        msg = "Unknown Prism colour scheme; drew the standard Prism theme."
        warnings = res.get("warnings") if isinstance(res.get("warnings"), list) else []
        if msg not in warnings:
            warnings.append(msg)
        res["warnings"] = warnings
    except Exception:  # noqa: BLE001 - a warning must never break plotting
        return


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


# ── ggprism palettes (read from the user's installed ggprism) ──────────────
#
# Prism-style colour palettes and colour schemes come from ggprism's own
# `ggprism_data` at runtime: none of that (GPL) data is copied into the app or
# written to disk. Every name and colour read back is treated as untrusted and
# validated; the result is cached per Rscript path only when the probe
# succeeded, so installing R / ggprism while the app is open shows up on the
# next request (same policy as the software versions above).

_PAL_PROBE = (
    'cat("R\\t", as.character(getRversion()), "\\n", sep="")\n'
    'v <- tryCatch(as.character(utils::packageVersion("ggprism")), error=function(e) "MISSING")\n'
    'cat("ggprism\\t", v, "\\n", sep="")\n'
    'if (!identical(v, "MISSING")) {\n'
    '  d <- tryCatch(ggprism::ggprism_data, error=function(e) NULL)\n'
    '  emit <- function(kind, lst) for (n in names(lst)) {\n'
    '    x <- lst[[n]]\n'
    '    if (is.character(x) && length(x) > 0) cat(kind, "\\t", n, "\\t", paste(x, collapse=","), "\\n", sep="")\n'
    '  }\n'
    '  if (is.list(d)) {\n'
    '    emit("colour", d$colour_palettes)\n'
    '    emit("fill", d$fill_palettes)\n'
    '    for (n in names(d$themes)) {\n'
    '      t <- d$themes[[n]]\n'
    '      if (is.data.frame(t) && all(c("name", "value") %in% names(t)))\n'
    '        cat("theme\\t", n, "\\t", paste(paste0(t$name, "=", t$value), collapse=","), "\\n", sep="")\n'
    '    }\n'
    '    cat("END\\n")\n'
    '  }\n'
    '}\n'
)
_PAL_NAME_RE = re.compile(r"[a-z][a-z0-9_]{0,39}")      # used with fullmatch
_PAL_HEX_RE = re.compile(r"#[0-9A-Fa-f]{6}")             # used with fullmatch
_PAL_MAX_COLOURS = 64
_PAL_MAX_PALETTES = 200
# The theme entries ggprism::theme_prism(palette=) draws with. plottingAreaColor
# is deliberately left out: theme_prism paints the panel with it only for the
# "office" scheme (every other scheme's panel shows the page colour), so passing
# it on would mislead a UI preview into drawing a panel R never draws.
_THEME_KEYS = ("pageBackgroundColor", "axisColor", "axisLabelColor", "axisTitleColor", "graphTitleColor")
_THEME_REQUIRED = _THEME_KEYS
_PAL_MESSAGES = {
    "no_r": "R wasn't found, so only the built-in palettes are available. Set up R in Setup.",
    "no_ggprism": "The R package ggprism isn't installed, so only the built-in palettes are available. "
                  "Install it in Setup.",
    "probe_failed": "R didn't return the ggprism palettes, so only the built-in palettes are available.",
}
_PAL_CACHE: Dict[str, dict] = {}
_PAL_CACHE_LOCK = threading.Lock()


def _pal_envelope(reason: Optional[str], r_ver: Optional[str] = None, version: Optional[str] = None) -> dict:
    return {"available": reason is None, "source": "ggprism", "version": version, "r": r_ver,
            "reason": reason, "message": _PAL_MESSAGES.get(reason, "") if reason else "",
            "colour": {}, "fill": {}, "themes": {}}


def _pal_name(s: str) -> Optional[str]:
    n = s.strip()
    return n if _PAL_NAME_RE.fullmatch(n) and n != "all_null" else None


def _pal_colours(s: str) -> Optional[list]:
    items = [x.strip() for x in s.split(",")]
    if not items or len(items) > _PAL_MAX_COLOURS:
        return None
    if not all(_PAL_HEX_RE.fullmatch(x) for x in items):
        return None                       # never a partial palette
    return [x.upper() for x in items]


def _pal_theme(s: str) -> Optional[dict]:
    out: Dict[str, str] = {}
    for part in s.split(","):
        if "=" not in part:
            continue
        k, v = part.split("=", 1)
        k, v = k.strip(), v.strip()
        if k in _THEME_KEYS and k not in out:
            if not _PAL_HEX_RE.fullmatch(v):
                if k in _THEME_REQUIRED:
                    return None
                continue
            out[k] = v.upper()
    return out if all(k in out for k in _THEME_REQUIRED) else None


def _parse_palettes(stdout: str) -> dict:
    r_ver = gg_ver = None
    missing = saw_end = False
    colour: Dict[str, list] = {}
    fill: Dict[str, list] = {}
    themes_raw: Dict[str, dict] = {}
    for line in (stdout or "").splitlines():
        if line.strip() == "END":
            saw_end = True
            continue
        parts = line.split("\t")
        tag = parts[0].strip()
        if tag == "R" and len(parts) == 2:
            r_ver = _version(parts[1])
        elif tag == "ggprism" and len(parts) == 2:
            if parts[1].strip() == "MISSING":
                missing = True
            else:
                gg_ver = _version(parts[1])
        elif tag in ("colour", "fill", "theme") and len(parts) == 3:
            name = _pal_name(parts[1])
            if name is None:
                continue
            if tag == "theme":
                th = _pal_theme(parts[2])
                if th is not None and name not in themes_raw:
                    themes_raw[name] = th
                continue
            dest = colour if tag == "colour" else fill
            cols = _pal_colours(parts[2])
            if cols is not None and name not in dest and len(dest) < _PAL_MAX_PALETTES:
                dest[name] = cols
    if missing:
        return _pal_envelope("no_ggprism", r_ver)
    if not saw_end or not (colour or fill):
        return _pal_envelope("probe_failed", r_ver, gg_ver)
    themes = {n: t for n, t in themes_raw.items() if n in colour or n in fill}
    return {**_pal_envelope(None, r_ver, gg_ver), "colour": colour, "fill": fill, "themes": themes}


def _pal_copy(d: dict) -> dict:
    return json.loads(json.dumps(d))


def _probe_palettes() -> dict:
    try:
        rscript, is_bundled = r_bridge._resolve_rscript()
    except Exception:  # noqa: BLE001
        return _pal_envelope("no_r")
    if not rscript:
        return _pal_envelope("no_r")
    with _PAL_CACHE_LOCK:
        hit = _PAL_CACHE.get(rscript)
    if hit is not None:
        return _pal_copy(hit)
    try:
        env = r_bridge._r_env(rscript, is_bundled) or os.environ.copy()
        with tempfile.TemporaryDirectory(prefix="las_palettes_") as tmp:
            sp = os.path.join(tmp, "palettes.R")
            with open(sp, "w", encoding="utf-8") as f:
                f.write(_PAL_PROBE)
            res = subprocess.run([rscript, sp], capture_output=True, text=True, timeout=20, env=env)
    except Exception:  # noqa: BLE001 - no R, timeout, unreadable output
        return _pal_envelope("probe_failed")
    out = _parse_palettes(res.stdout or "")
    if out["available"]:
        with _PAL_CACHE_LOCK:
            _PAL_CACHE[rscript] = _pal_copy(out)
    return out


@router.get("/api/graph/palettes")
def palettes():
    try:
        return _probe_palettes()
    except Exception:  # noqa: BLE001 - never an HTTP 500: the app falls back to its built-in palettes
        return _pal_envelope("probe_failed")
