"""Saved Graphs analyses — a small SQLite database in the app-data dir.

Each saved analysis is one row holding the data table (GraphDoc), the analysis
settings, the figure settings and the scratchpad (an Excel-like sheet of cell
inputs, frontend-owned shape with its own "v") as opaque JSON blobs, so the
frontend can evolve its document shape (doc_version) without a schema change
here. Schema v2 added the scratchpad_json column ('' = no scratchpad); older
libraries are migrated in place on first use, keeping every row. Names
are unique ignoring case. Re-saving an analysis replaces its row and gives it
a NEW id (as the qPCR run library does): the UI keys rendered results on ids,
so changed data must never look like the old analysis. created_at survives a
re-save.
"""

from __future__ import annotations

import datetime
import json
import os
import re
import sqlite3
from contextlib import contextmanager
from typing import Any, List, Optional

import r_settings

SCHEMA_VERSION = 2
MAX_BYTES = 5 * 1024 * 1024
MAX_SCRATCH_BYTES = 2 * 1024 * 1024   # the scratchpad has its own cap, separate from MAX_BYTES
MAX_NAME = 200
MAX_INT = 2 ** 63 - 1     # SQLite INTEGER range
_COLUMNS = {"id", "name", "template", "table_json", "analysis_json", "figure_json", "scratchpad_json",
            "doc_version", "created_at", "updated_at"}
_SURROGATE = re.compile("[\ud800-\udfff]")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS analyses (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL UNIQUE COLLATE NOCASE,
    template      TEXT NOT NULL,
    table_json    TEXT NOT NULL,
    analysis_json TEXT NOT NULL,
    figure_json   TEXT NOT NULL,
    scratchpad_json TEXT NOT NULL DEFAULT '',
    doc_version   INTEGER NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);
"""


class LibraryError(Exception):
    """Carries an API error code ("invalid", "not_found", "name_exists", "db")."""

    def __init__(self, message: str, code: str, conflict: Optional[dict] = None):
        super().__init__(message)
        self.code = code
        self.conflict = conflict


def db_path() -> str:
    return os.path.join(r_settings.app_data_dir(), "graph_library.sqlite3")


@contextmanager
def _connect():
    con = None
    try:
        con = sqlite3.connect(db_path(), timeout=15)
        ver = con.execute("PRAGMA user_version").fetchone()[0]
        if ver > SCHEMA_VERSION:
            raise LibraryError(f"The Graphs library at {db_path()} was created by a newer version of the app. "
                               "Update the app to open it.", "db")
        con.executescript(_SCHEMA)
        have = _table_columns(con)
        # v1 -> v2: add the scratchpad column to an existing library (rows keep all data).
        if "scratchpad_json" not in have and (_COLUMNS - {"scratchpad_json"}) <= have:
            try:
                con.execute("ALTER TABLE analyses ADD COLUMN scratchpad_json TEXT NOT NULL DEFAULT ''")
                con.commit()
            except sqlite3.OperationalError as e:
                if "duplicate column name" not in str(e).lower():   # another connection migrated first
                    raise
            have = _table_columns(con)
        if not _COLUMNS <= have:
            raise LibraryError(f"The Graphs library at {db_path()} has an unexpected format "
                               f"(missing {', '.join(sorted(_COLUMNS - have))}).", "db")
        if ver < SCHEMA_VERSION:
            con.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
            con.commit()
    except sqlite3.Error as e:
        if con is not None:
            con.close()
        raise LibraryError(f"The Graphs library at {db_path()} couldn't be used ({e}).", "db") from e
    except BaseException:
        if con is not None:
            con.close()
        raise
    try:
        yield con
        con.commit()
    except (sqlite3.Error, OverflowError) as e:
        # read-only file, lock timeout, foreign schema, out-of-range integer...:
        # the documented {error, code: "db"} envelope, never an HTTP 500
        _rollback(con)
        raise LibraryError(f"The Graphs library at {db_path()} couldn't be used ({e}).", "db") from e
    except BaseException:
        _rollback(con)
        raise
    finally:
        con.close()


def _table_columns(con) -> set:
    return {r[1] for r in con.execute("PRAGMA table_info(analyses)").fetchall()}


def _rollback(con) -> None:
    try:
        con.rollback()
    except sqlite3.Error:
        pass


def _now() -> str:
    return datetime.datetime.now().isoformat(timespec="seconds")


def _len(v: Any) -> int:
    return len(v) if isinstance(v, (list, tuple)) else 0


def _blank(v: Any) -> bool:
    return v is None or (isinstance(v, str) and not v.strip())


def _list(v: Any) -> list:
    return v if isinstance(v, list) else []


def _data_dims(table: dict):
    """(rows, columns) that hold data, mirroring the frontend's rowHasData /
    colHasData: the saved GraphDoc is padded with blank rows (and may have
    blank columns), which must not count. A row counts if it has a value, an
    X value or a row title; a column if any row has a value in it."""
    cells = _list(table.get("cells"))
    rt, xs = _list(table.get("row_titles")), _list(table.get("x"))

    def reps(row, c):
        row = _list(row)
        return _list(row[c]) if c < len(row) else []

    n_cols_grid = max([_len(table.get("col_titles"))] + [len(_list(r)) for r in cells])
    used_cols = [c for c in range(n_cols_grid) if any(not _blank(v) for row in cells for v in reps(row, c))]
    n_rows = sum(1 for r, row in enumerate(cells)
                 if (r < len(rt) and not _blank(rt[r])) or (r < len(xs) and not _blank(xs[r]))
                 or any(not _blank(v) for c in range(len(_list(row))) for v in reps(row, c)))
    n_cols = len(used_cols) if used_cols else _len(table.get("col_titles"))
    return n_rows, n_cols


def _summary(row) -> dict:
    rid, name, template, table_json, created, updated = row
    try:
        table = json.loads(table_json)
    except (TypeError, ValueError):
        table = {}
    if not isinstance(table, dict):
        table = {}
    n_rows, n_cols = _data_dims(table)
    return {"id": rid, "name": name, "template": template, "n_rows": n_rows,
            "n_cols": n_cols, "created_at": created, "updated_at": updated}


def _scrub(v: Any) -> Any:
    """Replace lone UTF-16 surrogates (half of a broken emoji) in every string
    of a JSON value: they can't be encoded as UTF-8, so the stored analysis
    could never be sent back to the app."""
    if isinstance(v, str):
        return _SURROGATE.sub("\ufffd", v)
    if isinstance(v, list):
        return [_scrub(x) for x in v]
    if isinstance(v, dict):
        return {_scrub(k) if isinstance(k, str) else k: _scrub(x) for k, x in v.items()}
    return v


def _clean_name(name: Any) -> str:
    if not isinstance(name, str):
        raise LibraryError("A name is required.", "invalid")
    if _SURROGATE.search(name) or "\x00" in name:
        raise LibraryError("The name contains invalid characters.", "invalid")
    n = name.strip()
    if not n:
        raise LibraryError("A name is required.", "invalid")
    if len(n) > MAX_NAME:
        raise LibraryError(f"Names can be at most {MAX_NAME} characters.", "invalid")
    return n


def _find_name(con, name: str, exclude_id: Optional[int] = None):
    row = con.execute("SELECT id, name FROM analyses WHERE name = ? COLLATE NOCASE", (name,)).fetchone()
    if row and row[0] != exclude_id:
        return {"id": row[0], "name": row[1]}
    return None


_SUMMARY_COLS = "id, name, template, table_json, created_at, updated_at"


def _scratch_json(scratchpad: Any) -> str:
    """The scratchpad blob as stored ('' = none). Its shape belongs to the
    frontend; only the envelope ({"v": int, "cells": [...]}) and size are checked."""
    if scratchpad is None:
        return ""
    if not isinstance(scratchpad, dict):
        raise LibraryError("'scratchpad' must be an object.", "invalid")
    v, cells = scratchpad.get("v"), scratchpad.get("cells")
    if isinstance(v, bool) or not isinstance(v, int) or not 1 <= v <= MAX_INT or not isinstance(cells, list):
        raise LibraryError("The scratchpad has an unexpected format.", "invalid")
    cols = scratchpad.get("cols")
    if not cells and not (isinstance(cols, dict) and cols):
        return ""
    try:
        text = json.dumps(_scrub(scratchpad), allow_nan=False, separators=(",", ":"))
    except (TypeError, ValueError) as e:
        raise LibraryError(f"The scratchpad can't be stored ({e}).", "invalid") from e
    if len(text) > MAX_SCRATCH_BYTES:
        raise LibraryError("The scratchpad is too large to save (over 2 MB).", "invalid")
    return text


def _parse_scratch(text: Any) -> Optional[dict]:
    """Stored scratchpad -> dict, or None when empty or damaged (a damaged
    scratchpad must never stop the analysis itself from opening)."""
    if not isinstance(text, str) or not text:
        return None
    try:
        v = json.loads(text)
    except (TypeError, ValueError):
        return None
    return v if isinstance(v, dict) else None


def list_analyses() -> List[dict]:
    with _connect() as con:
        rows = con.execute(f"SELECT {_SUMMARY_COLS} FROM analyses ORDER BY updated_at DESC, id DESC").fetchall()
    return [_summary(r) for r in rows]


def get_analysis(aid: int) -> dict:
    with _connect() as con:
        row = con.execute(f"SELECT {_SUMMARY_COLS}, analysis_json, figure_json, doc_version, scratchpad_json "
                          "FROM analyses WHERE id = ?", (int(aid),)).fetchone()
    if not row:
        raise LibraryError("That saved analysis no longer exists.", "not_found")
    out = _summary(row[:6])
    try:
        out.update(table=json.loads(row[3]), analysis=json.loads(row[6]), figure=json.loads(row[7]), doc_version=row[8])
    except (TypeError, ValueError) as e:
        raise LibraryError("This saved analysis is damaged and can't be opened.", "db") from e
    out["scratchpad"] = _parse_scratch(row[9])
    return out


def _summary_by_id(con, aid: int) -> dict:
    return _summary(con.execute(f"SELECT {_SUMMARY_COLS} FROM analyses WHERE id = ?", (aid,)).fetchone())


def save_analysis(aid: Optional[int], name: Any, template: Any, table: Any, analysis: Any, figure: Any,
                  doc_version: Any = 1, overwrite: bool = False, scratchpad: Any = None):
    """Insert or replace. Returns (summary, replaced)."""
    name = _clean_name(name)
    if template not in ("column", "grouped", "xy"):
        raise LibraryError("Unknown table template.", "invalid")
    for label, blob in (("table", table), ("analysis", analysis), ("figure", figure)):
        if not isinstance(blob, dict):
            raise LibraryError(f"'{label}' must be an object.", "invalid")
    if isinstance(doc_version, bool) or not isinstance(doc_version, int) or not 1 <= doc_version <= MAX_INT:
        raise LibraryError("doc_version must be a positive integer.", "invalid")
    try:
        tj = json.dumps(_scrub(table), allow_nan=False)
        aj = json.dumps(_scrub(analysis), allow_nan=False)
        fj = json.dumps(_scrub(figure), allow_nan=False)
    except (TypeError, ValueError) as e:
        raise LibraryError(f"The analysis can't be stored ({e}).", "invalid") from e
    if len(tj) + len(aj) + len(fj) > MAX_BYTES:
        raise LibraryError("The analysis is too large to save (over 5 MB).", "invalid")
    sj = _scratch_json(scratchpad)
    now = _now()
    with _connect() as con:
        con.execute("BEGIN IMMEDIATE")
        created = None
        replaced = False
        if aid is not None:
            row = con.execute("SELECT created_at FROM analyses WHERE id = ?", (int(aid),)).fetchone()
            if row:
                created = row[0]
        clash = _find_name(con, name, exclude_id=int(aid) if aid is not None else None)
        if clash:
            if not overwrite:
                raise LibraryError(f"An analysis named '{clash['name']}' already exists.", "name_exists", clash)
            if created is None:
                created = con.execute("SELECT created_at FROM analyses WHERE id = ?", (clash["id"],)).fetchone()[0]
            con.execute("DELETE FROM analyses WHERE id = ?", (clash["id"],))
            replaced = True
        if aid is not None:
            cur = con.execute("DELETE FROM analyses WHERE id = ?", (int(aid),))
            replaced = replaced or cur.rowcount > 0
        new_id = con.execute(
            "INSERT INTO analyses (name, template, table_json, analysis_json, figure_json, scratchpad_json, doc_version, "
            "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (name, template, tj, aj, fj, sj, doc_version, created or now, now),
        ).lastrowid
        summary = _summary_by_id(con, new_id)
    return summary, replaced


def rename_analysis(aid: int, name: Any) -> dict:
    name = _clean_name(name)
    with _connect() as con:
        con.execute("BEGIN IMMEDIATE")
        if not con.execute("SELECT 1 FROM analyses WHERE id = ?", (int(aid),)).fetchone():
            raise LibraryError("That saved analysis no longer exists.", "not_found")
        clash = _find_name(con, name, exclude_id=int(aid))
        if clash:
            raise LibraryError(f"An analysis named '{clash['name']}' already exists.", "name_exists", clash)
        con.execute("UPDATE analyses SET name = ?, updated_at = ? WHERE id = ?", (name, _now(), int(aid)))
        return _summary_by_id(con, int(aid))


def duplicate_analysis(aid: int, name: Any = None) -> dict:
    with _connect() as con:
        con.execute("BEGIN IMMEDIATE")
        row = con.execute("SELECT name, template, table_json, analysis_json, figure_json, scratchpad_json, doc_version "
                          "FROM analyses WHERE id = ?", (int(aid),)).fetchone()
        if not row:
            raise LibraryError("That saved analysis no longer exists.", "not_found")
        if name is None or (isinstance(name, str) and not name.strip()):
            # trim the stem so the suffix always fits, and test the exact string inserted
            k = 1
            while True:
                suffix = " copy" if k == 1 else f" copy {k}"
                new_name = row[0][:MAX_NAME - len(suffix)].rstrip() + suffix
                if not _find_name(con, new_name):
                    break
                k += 1
        else:
            new_name = _clean_name(name)
            clash = _find_name(con, new_name)
            if clash:
                raise LibraryError(f"An analysis named '{clash['name']}' already exists.", "name_exists", clash)
        now = _now()
        new_id = con.execute(
            "INSERT INTO analyses (name, template, table_json, analysis_json, figure_json, scratchpad_json, doc_version, "
            "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", (new_name, *row[1:], now, now)).lastrowid
        return _summary_by_id(con, new_id)


def delete_analysis(aid: int) -> None:
    with _connect() as con:
        con.execute("DELETE FROM analyses WHERE id = ?", (int(aid),))
