"""Persistent qPCR run library — a small SQLite database in the app-data dir.

Every imported LightCycler run (or manually entered plate) is stored once with
ALL of its plate-mapped wells, including Cp >= 35 and undetermined (no Cp)
wells, so the library grows across sessions and survives app updates. Filters
such as the Cp limit are applied at analysis time, never at import, so changing
them never needs a re-import. A run is identified by its name (the file stem);
importing the same name again replaces it.
"""

from __future__ import annotations

import datetime
import os
import sqlite3
from contextlib import contextmanager
from typing import Iterable, List

import pandas as pd

import r_settings

_SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    name     TEXT NOT NULL UNIQUE,
    source   TEXT NOT NULL,          -- 'lightcycler' | 'manual'
    added_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS wells (
    run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    well   TEXT,
    sample TEXT NOT NULL,
    gene   TEXT NOT NULL,
    cp     REAL                       -- NULL = undetermined
);
CREATE INDEX IF NOT EXISTS wells_run ON wells(run_id);
"""


def db_path() -> str:
    return os.path.join(r_settings.app_data_dir(), "qpcr_library.sqlite3")


@contextmanager
def _connect():
    con = sqlite3.connect(db_path())
    try:
        con.executescript(_SCHEMA)
        con.execute("PRAGMA foreign_keys = ON")
        yield con
        con.commit()
    finally:
        con.close()


def save_run(name: str, source: str, wells: pd.DataFrame) -> bool:
    """Insert a run, or replace the run with the same name. `wells` needs
    Well, Sample, Gene, Cp columns (Cp NaN = undetermined). Returns True if an
    existing run was replaced."""
    now = datetime.datetime.now().isoformat(timespec="seconds")
    rows = [
        (None if pd.isna(w) else str(w), str(s), str(g), None if pd.isna(c) else float(c))
        for w, s, g, c in wells[["Well", "Sample", "Gene", "Cp"]].itertuples(index=False)
    ]
    with _connect() as con:
        existing = con.execute("SELECT id FROM runs WHERE name = ?", (name,)).fetchone()
        if existing:
            run_id = existing[0]
            con.execute("DELETE FROM wells WHERE run_id = ?", (run_id,))
            con.execute("UPDATE runs SET source = ?, added_at = ? WHERE id = ?", (source, now, run_id))
        else:
            run_id = con.execute(
                "INSERT INTO runs (name, source, added_at) VALUES (?, ?, ?)", (name, source, now)
            ).lastrowid
        con.executemany(
            "INSERT INTO wells (run_id, well, sample, gene, cp) VALUES (?, ?, ?, ?, ?)",
            [(run_id, *r) for r in rows],
        )
    return existing is not None


def delete_run(run_id: int) -> None:
    with _connect() as con:
        con.execute("DELETE FROM runs WHERE id = ?", (run_id,))


def list_runs() -> List[dict]:
    """Every run with its well counts and, per gene x sample, the measured Cp
    values and the number of undetermined wells — enough for the UI to show
    what each run contains and to flag genes above any Cp limit."""
    with _connect() as con:
        runs = con.execute("SELECT id, name, source, added_at FROM runs ORDER BY name").fetchall()
        wells = con.execute("SELECT run_id, gene, sample, cp FROM wells").fetchall()
    cells: dict = {}
    for run_id, gene, sample, cp in wells:
        c = cells.setdefault(run_id, {}).setdefault((gene, sample), {"gene": gene, "sample": sample, "cps": [], "n_nd": 0})
        if cp is None:
            c["n_nd"] += 1
        else:
            c["cps"].append(round(cp, 3))
    out = []
    for run_id, name, source, added_at in runs:
        rc = sorted(cells.get(run_id, {}).values(), key=lambda c: (c["gene"], c["sample"]))
        out.append({
            "id": run_id,
            "name": name,
            "source": source,
            "added_at": added_at,
            "n_wells": sum(len(c["cps"]) + c["n_nd"] for c in rc),
            "n_undetermined": sum(c["n_nd"] for c in rc),
            "genes": sorted({c["gene"] for c in rc}),
            "samples": sorted({c["sample"] for c in rc}),
            "cells": rc,
        })
    return out


def load_records(run_ids: Iterable[int]) -> List[dict]:
    """The selected runs as analysis input: [{name, records: [{Well, Sample,
    Gene, Cp}]}], undetermined wells included (Cp None)."""
    ids = [int(i) for i in run_ids]
    if not ids:
        return []
    marks = ",".join("?" * len(ids))
    with _connect() as con:
        runs = con.execute(f"SELECT id, name FROM runs WHERE id IN ({marks}) ORDER BY name", ids).fetchall()
        wells = con.execute(f"SELECT run_id, well, sample, gene, cp FROM wells WHERE run_id IN ({marks})", ids).fetchall()
    by_run: dict = {rid: [] for rid, _ in runs}
    for rid, well, sample, gene, cp in wells:
        by_run[rid].append({"Well": well, "Sample": sample, "Gene": gene, "Cp": cp})
    return [{"name": name, "records": by_run[rid]} for rid, name in runs]
