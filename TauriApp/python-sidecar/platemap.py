"""Plate Mapper — build N-well plate layouts with multiple value fields and
export the combined table to Excel / TSV. No R needed.

Ported from the standalone Streamlit platemapper (platemap.py): one editable
grid per user-defined value field; the combined table emits one row per well
that has at least one non-empty value, as `Cell Position` + a column per field.
"""

from __future__ import annotations

import base64
import io
from typing import Dict, List

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()

# plate type -> (row letters, number of columns)
PLATES: Dict[str, Dict[str, object]] = {
    "6":   {"rows": "AB",               "cols": 3},
    "12":  {"rows": "ABC",              "cols": 4},
    "24":  {"rows": "ABCD",             "cols": 6},
    "48":  {"rows": "ABCDEF",           "cols": 8},
    "96":  {"rows": "ABCDEFGH",         "cols": 12},
    "384": {"rows": "ABCDEFGHIJKLMNOP", "cols": 24},
}


def _plate_spec(plate: str):
    p = PLATES.get(str(plate))
    if not p:
        return None
    rows = list(str(p["rows"]))
    cols = list(range(1, int(p["cols"]) + 1))
    return rows, cols


@router.get("/api/platemap/plates")
def list_plates():
    return {
        "plates": {
            k: {"rows": list(str(v["rows"])), "cols": list(range(1, int(v["cols"]) + 1))}
            for k, v in PLATES.items()
        }
    }


class ExportRequest(BaseModel):
    plate: str = "96"
    value_labels: List[str]
    # One grid per value label (same order). Each maps a well key ("A1") to its
    # string value. Empty/missing wells are simply absent.
    grids: List[Dict[str, str]] = []
    fmt: str = "both"  # "xlsx" | "tsv" | "both"


def _combined(plate: str, value_labels: List[str], grids: List[Dict[str, str]]):
    spec = _plate_spec(plate)
    if not spec:
        return ["Cell Position"] + list(value_labels), []
    rows, cols = spec
    # Pad/truncate grids to align with the labels.
    grids = list(grids) + [{} for _ in range(max(0, len(value_labels) - len(grids)))]
    grids = grids[: len(value_labels)]
    header = ["Cell Position"] + list(value_labels)
    out: List[List[str]] = []
    for r in rows:
        for c in cols:
            well = f"{r}{c}"
            vals = [str((g.get(well, "") or "")).strip() for g in grids]
            if any(vals):
                out.append([well] + vals)
    return header, out


@router.post("/api/platemap/export")
def export(body: ExportRequest):
    header, data = _combined(body.plate, body.value_labels, body.grids)

    result: Dict[str, object] = {
        "n_rows": len(data),
        "header": header,
        "rows": data,
        "tsv": None,
        "xlsx_b64": None,
    }

    if body.fmt in ("tsv", "both"):
        lines = ["\t".join(header)] + ["\t".join(map(str, row)) for row in data]
        result["tsv"] = "\n".join(lines) + "\n"

    if body.fmt in ("xlsx", "both"):
        import xlsxwriter

        buf = io.BytesIO()
        wb = xlsxwriter.Workbook(buf, {"in_memory": True})
        ws = wb.add_worksheet("labels")
        bold = wb.add_format({"bold": True})
        for ci, h in enumerate(header):
            ws.write(0, ci, h, bold)
        for ri, row in enumerate(data, start=1):
            for ci, val in enumerate(row):
                ws.write(ri, ci, val)
        wb.close()
        result["xlsx_b64"] = base64.b64encode(buf.getvalue()).decode()

    return result
