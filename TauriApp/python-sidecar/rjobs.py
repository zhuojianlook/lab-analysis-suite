"""Shared async R-job runner for the heavy pipelines (DESeq2, scRNA, Spatial,
16S). A job runs an Rscript subprocess in its own work dir, writes plots to
plots/ and tables to tables/, and emits `@@STAGE:name:frac` / `@@ERROR:msg`
markers on stdout that a reader thread parses into progress. Results are
collected when the process exits. Poll with status().
"""

from __future__ import annotations

import base64
import glob
import os
import subprocess
import tempfile
import threading
import uuid
from typing import Dict, Optional, Union

import r_bridge

_JOBS: Dict[str, dict] = {}
_LOCK = threading.Lock()


def _prelude(plot_dir: str, table_dir: str) -> str:
    pd_ = plot_dir.replace("\\", "/")
    td = table_dir.replace("\\", "/")
    return f'''
.plot_dir <- "{pd_}"; .table_dir <- "{td}"; .plot_count <- 0
mpfig_plot <- function(filename=NULL, width=1200, height=900, res=150) {{
  while (dev.cur() > 1) try(dev.off(), silent=TRUE)
  .plot_count <<- .plot_count + 1
  if (is.null(filename)) filename <- sprintf("plot_%02d.png", .plot_count)
  grDevices::png(file.path(.plot_dir, filename), width=width, height=height, res=res)
}}
mpfig_data <- function(df, name="table") {{
  utils::write.csv(df, file.path(.table_dir, paste0(name, ".csv")), row.names=FALSE); invisible(df)
}}
las_stage <- function(name, frac=NA) {{ cat(sprintf("@@STAGE:%s:%s\\n", name, ifelse(is.na(frac), "", as.character(frac)))); flush.console() }}
las_error <- function(msg) {{ cat(sprintf("@@ERROR:%s\\n", msg)); flush.console() }}
'''


def start_r_job(code: str, inputs: Optional[Dict[str, Union[str, bytes]]] = None, timeout: int = 1800) -> str:
    rscript, is_bundled = r_bridge._resolve_rscript()
    job_id = uuid.uuid4().hex[:12]
    with _LOCK:
        _JOBS[job_id] = {"status": "queued", "stage": "queued", "progress": 0.0, "tail": "", "error": None}
    if not rscript:
        with _LOCK:
            _JOBS[job_id].update(status="error", error="R is not available.")
        return job_id

    workdir = tempfile.mkdtemp(prefix="las_rjob_")
    plot_dir = os.path.join(workdir, "plots")
    table_dir = os.path.join(workdir, "tables")
    os.makedirs(plot_dir, exist_ok=True)
    os.makedirs(table_dir, exist_ok=True)
    for fn, content in (inputs or {}).items():
        path = os.path.join(workdir, fn)
        if isinstance(content, bytes):
            with open(path, "wb") as f:
                f.write(content)
        else:
            with open(path, "w", encoding="utf-8") as f:
                f.write(content)

    with open(os.path.join(workdir, "job.R"), "w", encoding="utf-8") as f:
        f.write(_prelude(plot_dir, table_dir) + "\n" + code + "\n")

    env = r_bridge._r_env(rscript, is_bundled)
    threading.Thread(
        target=_run, args=(job_id, rscript, os.path.join(workdir, "job.R"), workdir, plot_dir, table_dir, env, timeout),
        daemon=True,
    ).start()
    return job_id


def _run(job_id, rscript, sp, workdir, plot_dir, table_dir, env, timeout):
    with _LOCK:
        _JOBS[job_id].update(status="running", stage="starting")
    try:
        proc = subprocess.Popen(
            [rscript, sp], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, env=env, cwd=workdir, bufsize=1,
        )
    except Exception as e:  # noqa: BLE001
        with _LOCK:
            _JOBS[job_id].update(status="error", error=str(e))
        return

    tail = []
    for line in iter(proc.stdout.readline, ""):
        line = line.rstrip("\n")
        if not line:
            continue
        tail.append(line)
        if len(tail) > 80:
            tail = tail[-80:]
        upd = {"tail": "\n".join(tail)}
        if line.startswith("@@STAGE:"):
            parts = line[len("@@STAGE:"):].split(":")
            upd["stage"] = parts[0]
            if len(parts) > 1 and parts[1]:
                try:
                    upd["progress"] = float(parts[1])
                except ValueError:
                    pass
        elif line.startswith("@@ERROR:"):
            upd["error"] = line[len("@@ERROR:"):]
        with _LOCK:
            _JOBS[job_id].update(**upd)
    proc.wait()

    plots = []
    for p in sorted(glob.glob(os.path.join(plot_dir, "*.png"))):
        with open(p, "rb") as f:
            plots.append(base64.b64encode(f.read()).decode())
    tables = []
    for c in sorted(glob.glob(os.path.join(table_dir, "*.csv"))):
        with open(c, "r", encoding="utf-8") as f:
            tables.append({"name": os.path.splitext(os.path.basename(c))[0], "csv": f.read()})

    with _LOCK:
        prior_err = _JOBS[job_id].get("error")
        ok = proc.returncode == 0 and not prior_err
        _JOBS[job_id].update(
            status="done" if ok else "error",
            progress=1.0 if ok else _JOBS[job_id].get("progress", 0.0),
            plots=plots, tables=tables,
            error=prior_err or (None if ok else f"R exited with code {proc.returncode}. Tail:\n" + "\n".join(tail[-15:])),
        )


def status(job_id: str) -> dict:
    with _LOCK:
        j = _JOBS.get(job_id)
        if not j:
            return {"status": "error", "error": "Unknown job id."}
        out = dict(j)
    # Only ship the (large) plots/tables once the job is done.
    if out.get("status") != "done":
        out["plots"] = []
        out["tables"] = []
    return out
