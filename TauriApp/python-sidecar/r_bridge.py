"""Python -> R bridge.

Ported from the multipanelfigure sidecar's `/api/analysis/run-r` machinery and
adapted to prefer a BUNDLED R engine (a relocated conda env shipped under the
app's resources/) over a host-installed R. The bundled path also injects
R_HOME / R_LIBS / PATH so DESeq2, ggplot2, etc. load from the bundled library.

Every tab renders its figures by POSTing a data CSV + an R script to
`/api/analysis/run-r`. The R script loads the CSV as `data`, draws with
ggplot2 inside `mpfig_plot(...)` blocks, and writes result tables with
`mpfig_data(df, name)`. The bridge returns base64 PNGs + the CSV tables.
"""

from __future__ import annotations

import base64
import glob as glob_mod
import os
import platform
import shutil
import subprocess
import sys
import tempfile
from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel

import config

router = APIRouter()


# ── R discovery ─────────────────────────────────────────────────────────────

def _bundled_rscript() -> Optional[str]:
    """Locate Rscript inside the bundled conda R env (config.R_ENV_DIR)."""
    base = config.R_ENV_DIR
    if not base or not os.path.isdir(base):
        return None
    exe = "Rscript.exe" if platform.system() == "Windows" else "Rscript"
    # Common conda layouts across platforms.
    candidates = [
        os.path.join(base, "bin", exe),                 # unix conda
        os.path.join(base, "Scripts", exe),             # win conda wrapper
        os.path.join(base, "Library", "bin", exe),      # win conda
        os.path.join(base, "Lib", "R", "bin", "x64", exe),  # win conda actual
        os.path.join(base, "lib", "R", "bin", exe),     # unix conda actual
    ]
    for c in candidates:
        if os.path.isfile(c):
            return c
    # Bounded recursive fallback.
    for found in glob_mod.glob(os.path.join(base, "**", exe), recursive=True):
        if os.path.isfile(found):
            return found
    return None


def _host_rscript(custom_path: Optional[str] = None) -> Optional[str]:
    """Find a host-installed Rscript (dev / fallback)."""
    if custom_path and os.path.isfile(custom_path):
        return custom_path
    found = shutil.which("Rscript")
    if found:
        return found
    candidates = []
    system = platform.system()
    if system == "Darwin":
        candidates = [
            "/usr/local/bin/Rscript",
            "/opt/homebrew/bin/Rscript",
            "/Library/Frameworks/R.framework/Versions/Current/Resources/bin/Rscript",
            "/Library/Frameworks/R.framework/Resources/bin/Rscript",
            os.path.expanduser("~/Library/Frameworks/R.framework/Resources/bin/Rscript"),
        ]
    elif system == "Windows":
        prog_files = os.environ.get("ProgramFiles", r"C:\Program Files")
        r_dir = os.path.join(prog_files, "R")
        if os.path.isdir(r_dir):
            for ver_dir in sorted(os.listdir(r_dir), reverse=True):
                candidates.append(os.path.join(r_dir, ver_dir, "bin", "Rscript.exe"))
    else:
        candidates = ["/usr/bin/Rscript", "/usr/local/bin/Rscript", "/snap/bin/Rscript"]
    for c in candidates:
        if c and os.path.isfile(c):
            return c
    return None


def _resolve_rscript(custom_path: Optional[str] = None):
    """Return (rscript_path | None, is_bundled).

    Order: explicit per-request path -> persisted user setting -> optional
    bundled/portable R (LAS_R_ENV_DIR) -> host discovery.
    """
    if custom_path and os.path.isfile(custom_path):
        return custom_path, False
    try:
        import r_settings
        saved = r_settings.get("rscript_path")
        if saved and os.path.isfile(saved):
            return saved, False
    except Exception:  # noqa: BLE001
        pass
    b = _bundled_rscript()
    if b:
        return b, True
    return _host_rscript(custom_path), False


def _r_env(rscript: str, is_bundled: bool) -> Optional[dict]:
    """Build the subprocess env for a BUNDLED R so it finds its own R_HOME /
    library / shared libs. Returns None for a host R (inherit the parent env).
    """
    if not is_bundled:
        return None
    base = config.R_ENV_DIR
    env = os.environ.copy()
    if platform.system() == "Windows":
        r_home = os.path.join(base, "Lib", "R")
        path_parts = [
            os.path.join(base, "Library", "bin"),
            os.path.join(base, "Scripts"),
            os.path.join(r_home, "bin", "x64"),
            base,
        ]
    else:
        r_home = os.path.join(base, "lib", "R")
        path_parts = [os.path.join(base, "bin"), os.path.join(base, "lib")]
    if os.path.isdir(r_home):
        env["R_HOME"] = r_home
        env["R_LIBS_SITE"] = os.path.join(r_home, "library")
        env["R_LIBS"] = os.path.join(r_home, "library")
    sep = os.pathsep
    env["PATH"] = sep.join([p for p in path_parts if os.path.isdir(p)] + [env.get("PATH", "")])
    # conda's own shared libs (libR, BLAS/LAPACK, gfortran rt) on unix.
    if platform.system() == "Linux":
        env["LD_LIBRARY_PATH"] = sep.join(
            [os.path.join(base, "lib")] + ([env["LD_LIBRARY_PATH"]] if env.get("LD_LIBRARY_PATH") else [])
        )
    return env


# ── R prelude (helpers injected before every user script) ───────────────────

def _r_prelude(data_path: str, plot_dir: str, table_dir: str, export_dir: str) -> str:
    dp = data_path.replace("\\", "/")
    pd_ = plot_dir.replace("\\", "/")
    td = table_dir.replace("\\", "/")
    ed = export_dir.replace("\\", "/")
    return f"""
options(repos = c(CRAN = "https://cloud.r-project.org"))
# Load the data CSV the sidecar wrote.
data <- if (file.exists("{dp}") && file.info("{dp}")$size > 1) read.csv("{dp}", check.names = FALSE) else data.frame()

.plot_dir <- "{pd_}"
.table_dir <- "{td}"
.export_dir <- "{ed}"
.plot_count <- 0
.export_count <- 0

# Open a PNG device for the next plot. Call before each ggplot print().
# bg may be "white" (default) or "transparent".
mpfig_plot <- function(filename = NULL, width = 1200, height = 900, res = 150, bg = "white") {{
  while (dev.cur() > 1) try(dev.off(), silent = TRUE)
  .plot_count <<- .plot_count + 1
  if (is.null(filename)) filename <- sprintf("plot_%02d.png", .plot_count)
  grDevices::png(file.path(.plot_dir, filename), width = width, height = height, res = res, bg = bg)
}}

# Render a ggplot object to (a) a PNG preview the WebView can display, and
# (b) an optional publication export in the requested format / background.
# format: "png" | "tiff" ; bg: "white" | "transparent".
mpfig_render <- function(p, width = 1200, height = 900, res = 150, format = "png", bg = "white") {{
  mpfig_plot(width = width, height = height, res = res, bg = "white")
  print(p)
  while (dev.cur() > 1) try(dev.off(), silent = TRUE)
  fmt <- tolower(as.character(format))
  if (fmt %in% c("tiff", "tif") || !identical(bg, "white")) {{
    .export_count <<- .export_count + 1
    ext <- if (fmt %in% c("tiff", "tif")) "tiff" else "png"
    ef <- file.path(.export_dir, sprintf("export_%02d.%s", .export_count, ext))
    if (ext == "tiff") {{
      grDevices::tiff(ef, width = width, height = height, res = res, bg = bg, compression = "lzw")
    }} else {{
      grDevices::png(ef, width = width, height = height, res = res, bg = bg)
    }}
    print(p)
    while (dev.cur() > 1) try(dev.off(), silent = TRUE)
  }}
}}

# Write a data.frame out as a result table the UI can show / download.
mpfig_data <- function(df, name = "table") {{
  utils::write.csv(df, file = file.path(.table_dir, paste0(name, ".csv")), row.names = FALSE)
  invisible(df)
}}

# Word-wrap helper (hard-breaks over-long tokens too) so long labels/titles
# don't get clipped by a fixed-size device.
.mpfig_wrap <- function(x, width = 24) {{
  width <- max(4L, as.integer(width))
  vapply(as.character(x), function(s) {{
    if (is.na(s) || !nzchar(s)) return(s)
    words <- unlist(strsplit(s, "[[:space:]]+"))
    broken <- unlist(lapply(words, function(w) {{
      if (nchar(w) <= width) return(w)
      st <- seq(1, nchar(w), by = width)
      substring(w, st, pmin(st + width - 1, nchar(w)))
    }}))
    lines <- character(0); cur <- ""
    for (w in broken) {{
      cand <- if (nzchar(cur)) paste(cur, w) else w
      if (nchar(cand) > width && nzchar(cur)) {{ lines <- c(lines, cur); cur <- w }} else cur <- cand
    }}
    if (nzchar(cur)) lines <- c(lines, cur)
    paste(lines, collapse = "\\n")
  }}, character(1), USE.NAMES = FALSE)
}}
"""


# ── Endpoints ───────────────────────────────────────────────────────────────

@router.get("/api/analysis/check-r")
def check_r(rscript_path: Optional[str] = None):
    rscript, is_bundled = _resolve_rscript(rscript_path)
    if not rscript:
        return {"installed": False, "version": "", "path": "", "bundled": False}
    try:
        env = _r_env(rscript, is_bundled)
        result = subprocess.run(
            [rscript, "--version"], capture_output=True, text=True, timeout=15, env=env
        )
        version = (result.stderr + result.stdout).strip().split("\n")[0]
        return {"installed": True, "version": version, "path": rscript, "bundled": is_bundled}
    except Exception as e:  # noqa: BLE001
        return {"installed": False, "version": str(e), "path": rscript, "bundled": is_bundled}


class RunRRequest(BaseModel):
    code: str
    data_csv: str = ""
    rscript_path: Optional[str] = None
    timeout_sec: int = 120


@router.post("/api/analysis/run-r")
def run_r(body: RunRRequest):
    rscript, is_bundled = _resolve_rscript(body.rscript_path)
    if not rscript:
        return {
            "success": False,
            "stdout": "",
            "stderr": "R is not available. The bundled R engine was not found.",
            "plots": [],
            "tables": [],
        }

    with tempfile.TemporaryDirectory(prefix="las_r_") as tmpdir:
        data_path = os.path.join(tmpdir, "data.csv")
        with open(data_path, "w", encoding="utf-8") as f:
            f.write((body.data_csv or "").rstrip() + "\n")
        plot_dir = os.path.join(tmpdir, "plots")
        table_dir = os.path.join(tmpdir, "tables")
        export_dir = os.path.join(tmpdir, "exports")
        os.makedirs(plot_dir, exist_ok=True)
        os.makedirs(table_dir, exist_ok=True)
        os.makedirs(export_dir, exist_ok=True)

        script = _r_prelude(data_path, plot_dir, table_dir, export_dir)
        script += "\n# ── user code ──\n" + body.code + "\n"
        script += "\nwhile (dev.cur() > 1) try(dev.off(), silent = TRUE)\n"

        script_path = os.path.join(tmpdir, "analysis.R")
        with open(script_path, "w", encoding="utf-8") as f:
            f.write(script)

        env = _r_env(rscript, is_bundled)
        try:
            result = subprocess.run(
                [rscript, script_path],
                capture_output=True, text=True,
                timeout=max(10, int(body.timeout_sec)), cwd=tmpdir, env=env,
            )
        except subprocess.TimeoutExpired:
            return {"success": False, "stdout": "", "stderr": f"R script timed out after {body.timeout_sec}s.", "plots": [], "tables": []}
        except Exception as e:  # noqa: BLE001
            return {"success": False, "stdout": "", "stderr": str(e), "plots": [], "tables": []}

        plots_b64 = []
        for png_path in sorted(glob_mod.glob(os.path.join(plot_dir, "*.png"))):
            with open(png_path, "rb") as pf:
                plots_b64.append(base64.b64encode(pf.read()).decode())

        tables_out = []
        for csv_path in sorted(glob_mod.glob(os.path.join(table_dir, "*.csv"))):
            try:
                with open(csv_path, "r", encoding="utf-8") as cf:
                    tables_out.append({
                        "name": os.path.splitext(os.path.basename(csv_path))[0],
                        "csv": cf.read(),
                    })
            except Exception as _e:  # noqa: BLE001
                print(f"[run-r] failed to read table {csv_path}: {_e}", file=sys.stderr, flush=True)

        # Publication exports (TIFF / transparent PNG) written via mpfig_render().
        exports_out = []
        for exp_path in sorted(glob_mod.glob(os.path.join(export_dir, "*"))):
            ext = os.path.splitext(exp_path)[1].lower().lstrip(".")
            fmt = "tiff" if ext in ("tiff", "tif") else "png"
            with open(exp_path, "rb") as ef:
                exports_out.append({
                    "name": os.path.splitext(os.path.basename(exp_path))[0],
                    "format": fmt,
                    "b64": base64.b64encode(ef.read()).decode(),
                })

        return {
            "success": result.returncode == 0,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "plots": plots_b64,
            "tables": tables_out,
            "exports": exports_out,
        }


class RConsoleRequest(BaseModel):
    command: str
    rscript_path: Optional[str] = None
    timeout_sec: int = 600


@router.post("/api/analysis/run-console")
def run_console(body: RConsoleRequest):
    rscript, is_bundled = _resolve_rscript(body.rscript_path)
    if not rscript:
        return {"success": False, "stdout": "", "stderr": "R is not available."}
    cmd = (body.command or "").strip()
    if not cmd:
        return {"success": False, "stdout": "", "stderr": "Empty command."}
    with tempfile.TemporaryDirectory(prefix="las_rc_") as tmpdir:
        script = 'options(repos = c(CRAN = "https://cloud.r-project.org"))\n' + cmd + "\n"
        script_path = os.path.join(tmpdir, "console.R")
        with open(script_path, "w", encoding="utf-8") as f:
            f.write(script)
        env = _r_env(rscript, is_bundled)
        try:
            result = subprocess.run(
                [rscript, script_path], capture_output=True, text=True,
                timeout=max(10, int(body.timeout_sec)), cwd=tmpdir, env=env,
            )
            return {"success": result.returncode == 0, "stdout": result.stdout, "stderr": result.stderr}
        except subprocess.TimeoutExpired:
            return {"success": False, "stdout": "", "stderr": f"Command timed out after {body.timeout_sec}s."}
        except Exception as e:  # noqa: BLE001
            return {"success": False, "stdout": "", "stderr": str(e)}
