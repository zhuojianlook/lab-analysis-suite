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

Statistics live in graph_stats, R code generation in graph_plot and the
SQLite store in graph_library. Keep every @router decorator directly above
its def: api_server swallows import errors, so a broken module silently
removes the whole tool.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import threading
from collections import OrderedDict
from typing import Any, Dict, Optional

from fastapi import APIRouter, Body

import graph_library as lib
import graph_plot
import graph_stats

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
