"""Persistent R settings (the user's chosen Rscript path) + the OS app-data dir.

The sidecar owns this (not the frontend) because the sidecar is the process that
actually spawns Rscript and may need the path on the very first call, before the
UI has hydrated any store. Stored as a small JSON in the OS app-data dir.
"""

from __future__ import annotations

import json
import os
import platform
from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()

APP_IDENTIFIER = "LabAnalysisSuite"


def app_data_dir() -> str:
    system = platform.system()
    if system == "Darwin":
        base = os.path.expanduser("~/Library/Application Support")
    elif system == "Windows":
        base = os.environ.get("APPDATA") or os.path.expanduser("~")
    else:
        base = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
    d = os.path.join(base, APP_IDENTIFIER)
    try:
        os.makedirs(d, exist_ok=True)
    except Exception:  # noqa: BLE001
        pass
    return d


def _settings_path() -> str:
    return os.path.join(app_data_dir(), "settings.json")


def load_settings() -> dict:
    try:
        with open(_settings_path(), "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return {}


def save_settings(d: dict) -> None:
    try:
        with open(_settings_path(), "w", encoding="utf-8") as f:
            json.dump(d, f, indent=2)
    except Exception:  # noqa: BLE001
        pass


def get(key: str, default=None):
    return load_settings().get(key, default)


def set_value(key: str, value) -> dict:
    s = load_settings()
    s[key] = value
    save_settings(s)
    return s


# ── Endpoints ───────────────────────────────────────────────────────────────

@router.get("/api/analysis/get-settings")
def get_settings():
    s = load_settings()
    return {"rscript_path": s.get("rscript_path", ""), "app_data_dir": app_data_dir()}


class SetRscriptRequest(BaseModel):
    rscript_path: Optional[str] = None


@router.post("/api/analysis/set-rscript")
def set_rscript(body: SetRscriptRequest):
    # Persist (empty clears the override) then re-probe so the UI gets a fresh
    # CheckRResponse for the newly-set interpreter.
    set_value("rscript_path", (body.rscript_path or "").strip())
    import r_bridge
    return r_bridge.check_r(body.rscript_path or None)
