"""Runtime configuration shared across the sidecar.

Populated once from CLI args in api_server.main(); read by the R bridge and
tab modules. Kept deliberately tiny so importing it has no side effects.
"""

from typing import Optional

APP_VERSION: str = "0.2.1"

# Absolute path to the bundled R engine directory (a relocated conda env),
# passed by the Tauri shell as --r-env-dir. None in dev / browser preview,
# in which case the bridge falls back to a host-installed R.
R_ENV_DIR: Optional[str] = None


def set_r_env_dir(path: Optional[str]) -> None:
    global R_ENV_DIR
    R_ENV_DIR = path or None
