"""Per-tab R package manifests + a toolchain-free installer.

Because R is the user's local install with no bundled packages, each tab declares
the R packages it needs (CRAN + Bioconductor). We check what's present and, on
demand, install the rest as BINARIES via `pak` + Posit Public Package Manager
(P3M) so the user needs no C/C++/Fortran toolchain on Windows/macOS (and Linux
LTS via distro-tagged P3M). Installs are long-running, so they use the same
job/poll pattern as the analysis tabs.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import threading
import uuid
from typing import Dict, List, Optional

from fastapi import APIRouter
from pydantic import BaseModel

import r_bridge

router = APIRouter()

# tab -> required packages. "common" is merged into every tab.
MANIFESTS: Dict[str, Dict[str, List[str]]] = {
    "common":      {"cran": ["ggplot2", "dplyr", "tidyr", "scales", "ggrepel", "svglite", "RColorBrewer"], "bioc": []},
    "qpcr":        {"cran": ["ggsignif", "rstatix"], "bioc": []},
    "xcelligence": {"cran": ["zoo"], "bioc": []},
    "rnaseq":      {"cran": ["pheatmap"], "bioc": ["DESeq2", "apeglm"]},
    "scrnaseq":    {"cran": ["Seurat", "Matrix", "harmony", "presto", "hdf5r"], "bioc": ["glmGamPoi", "SingleR", "celldex", "scDblFinder"]},
    "spatial":     {"cran": ["Seurat", "Rfast2", "hdf5r"], "bioc": []},
    "microbiome":  {"cran": ["vegan", "ggplot2"], "bioc": ["phyloseq", "dada2", "ANCOMBC"]},
}


def needed(tab: str) -> Dict[str, List[str]]:
    common = MANIFESTS["common"]
    t = MANIFESTS.get(tab, {"cran": [], "bioc": []})
    return {
        "cran": sorted(set(common["cran"] + t.get("cran", []))),
        "bioc": sorted(set(common["bioc"] + t.get("bioc", []))),
    }


# ── check-packages ──────────────────────────────────────────────────────────

@router.get("/api/analysis/packages")
def list_manifest(tab: str):
    return {"tab": tab, **needed(tab)}


@router.get("/api/analysis/check-packages")
def check_packages(tab: Optional[str] = None, names: Optional[str] = None):
    if tab:
        m = needed(tab)
        pkg_names = m["cran"] + m["bioc"]
    else:
        pkg_names = [n.strip() for n in (names or "").split(",") if n.strip()]
    rscript, is_bundled = r_bridge._resolve_rscript()
    if not rscript:
        return {"r_available": False, "packages": [], "all_installed": False}
    if not pkg_names:
        return {"r_available": True, "packages": [], "all_installed": True}

    # Pass names via env var (not interpolation) to avoid injection.
    probe = (
        'pkgs <- strsplit(Sys.getenv("LAS_PKGS"), ",")[[1]]\n'
        'for (p in pkgs) {\n'
        '  v <- tryCatch(as.character(packageVersion(p)), error=function(e) NA)\n'
        '  cat(p, "\\t", ifelse(is.na(v), "MISSING", v), "\\n", sep="")\n'
        '}\n'
    )
    env = r_bridge._r_env(rscript, is_bundled) or os.environ.copy()
    env["LAS_PKGS"] = ",".join(pkg_names)
    with tempfile.TemporaryDirectory(prefix="las_pkgchk_") as tmp:
        sp = os.path.join(tmp, "check.R")
        with open(sp, "w", encoding="utf-8") as f:
            f.write(probe)
        try:
            res = subprocess.run([rscript, sp], capture_output=True, text=True, timeout=60, env=env)
        except Exception as e:  # noqa: BLE001
            return {"r_available": True, "packages": [], "all_installed": False, "error": str(e)}
    out = []
    for line in (res.stdout or "").splitlines():
        if "\t" in line:
            name, ver = line.split("\t", 1)
            ver = ver.strip()
            out.append({"name": name.strip(), "installed": ver != "MISSING", "version": "" if ver == "MISSING" else ver})
    return {"r_available": True, "packages": out, "all_installed": all(p["installed"] for p in out) if out else True}


# ── install-packages (long-running job) ─────────────────────────────────────

_jobs: Dict[str, dict] = {}
_jobs_lock = threading.Lock()


def _install_script(pkgfile: str) -> str:
    # Binary-first: P3M for CRAN binaries (win/mac; Linux LTS via distro tag),
    # pak bootstrapped from its own binary repo, Bioc via "bioc::" prefix.
    return r'''
pkgs <- readLines(Sys.getenv("LAS_PKGFILE"))
pkgs <- pkgs[nzchar(pkgs)]

# Binary CRAN repo (Posit P3M). On Linux, tag by distro codename when possible.
p3m <- "https://p3m.dev/cran/latest"
if (grepl("linux", R.version$os)) {
  codename <- tryCatch({
    x <- readLines("/etc/os-release")
    v <- grep("^VERSION_CODENAME=", x, value=TRUE)
    if (length(v)) gsub('"', '', sub(".*=", "", v[1])) else ""
  }, error=function(e) "")
  if (nzchar(codename)) p3m <- sprintf("https://p3m.dev/cran/__linux__/%s/latest", codename)
}
options(repos = c(P3M = p3m, CRAN = "https://cloud.r-project.org"))

cat("LAS_STAGE: bootstrapping pak\n"); flush.console()
if (!requireNamespace("pak", quietly=TRUE)) {
  tryCatch(
    install.packages("pak", repos = sprintf(
      "https://r-lib.github.io/p/pak/stable/%s/%s/%s",
      .Platform$pkgType, R.version$os, R.version$arch)),
    error=function(e) cat(sprintf("LAS_WARN: pak bootstrap failed: %s\n", conditionMessage(e)))
  )
}
have_pak <- requireNamespace("pak", quietly=TRUE)

cat("LAS_STAGE: resolving\n"); flush.console()
n <- length(pkgs)
ok <- 0
for (i in seq_along(pkgs)) {
  p <- pkgs[i]
  cat(sprintf("LAS_PKG_START: %s\n", p)); flush.console()
  res <- tryCatch({
    if (have_pak) {
      pak::pkg_install(p, ask=FALSE, upgrade=FALSE)
    } else {
      # Fallback: BiocManager for bioc::, else install.packages(type=binary)
      if (startsWith(p, "bioc::")) {
        if (!requireNamespace("BiocManager", quietly=TRUE)) install.packages("BiocManager")
        BiocManager::install(sub("^bioc::", "", p), update=FALSE, ask=FALSE)
      } else {
        install.packages(p, type=ifelse(.Platform$pkgType=="source","source","binary"))
      }
    }
    TRUE
  }, error=function(e) { cat(sprintf("LAS_PKG_ERROR: %s :: %s\n", p, conditionMessage(e))); FALSE })
  if (isTRUE(res)) ok <- ok + 1
  cat(sprintf("LAS_PKG_DONE: %s (%d/%d)\n", p, i, n)); flush.console()
}
cat(sprintf("LAS_STAGE: done (%d/%d ok)\n", ok, n)); flush.console()
'''


def _run_install(job_id: str, pkgs: List[str]):
    rscript, is_bundled = r_bridge._resolve_rscript()
    if not rscript:
        with _jobs_lock:
            _jobs[job_id].update(status="error", error="R is not available.")
        return
    env = r_bridge._r_env(rscript, is_bundled) or os.environ.copy()
    tmpdir = tempfile.mkdtemp(prefix="las_pkginstall_")
    pkgfile = os.path.join(tmpdir, "pkgs.txt")
    with open(pkgfile, "w", encoding="utf-8") as f:
        f.write("\n".join(pkgs) + "\n")
    env["LAS_PKGFILE"] = pkgfile
    scriptpath = os.path.join(tmpdir, "install.R")
    with open(scriptpath, "w", encoding="utf-8") as f:
        f.write(_install_script(pkgfile))

    total = len(pkgs)
    try:
        proc = subprocess.Popen(
            [rscript, scriptpath], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, env=env, cwd=tmpdir, bufsize=1,
        )
    except Exception as e:  # noqa: BLE001
        with _jobs_lock:
            _jobs[job_id].update(status="error", error=str(e))
        return

    with _jobs_lock:
        _jobs[job_id].update(status="running", stage="starting")

    log_tail: List[str] = []
    for line in iter(proc.stdout.readline, ""):
        line = line.rstrip("\n")
        if not line:
            continue
        log_tail.append(line)
        if len(log_tail) > 60:
            log_tail = log_tail[-60:]
        upd = {"tail_log": "\n".join(log_tail)}
        if line.startswith("LAS_STAGE:"):
            upd["stage"] = line.split(":", 1)[1].strip()
        elif line.startswith("LAS_PKG_DONE:"):
            # ".. (i/n)"
            try:
                frac = line.split("(", 1)[1].split(")", 1)[0]
                i, n = frac.split("/")
                upd["progress"] = int(i) / max(1, int(n))
            except Exception:  # noqa: BLE001
                pass
        with _jobs_lock:
            _jobs[job_id].update(**upd)
    proc.wait()
    with _jobs_lock:
        _jobs[job_id].update(
            status="done" if proc.returncode == 0 else "error",
            progress=1.0 if proc.returncode == 0 else _jobs[job_id].get("progress", 0.0),
            error=None if proc.returncode == 0 else f"Installer exited with code {proc.returncode}",
        )


class InstallRequest(BaseModel):
    tab: Optional[str] = None
    cran: List[str] = []
    bioc: List[str] = []


@router.post("/api/analysis/install-packages")
def install_packages(body: InstallRequest):
    if body.tab:
        m = needed(body.tab)
        cran, bioc = m["cran"], m["bioc"]
    else:
        cran, bioc = body.cran, body.bioc
    # pak understands "bioc::Name" for Bioconductor packages.
    pkgs = list(cran) + [f"bioc::{b}" for b in bioc]
    if not pkgs:
        return {"job_id": None, "error": "No packages requested."}
    job_id = uuid.uuid4().hex[:12]
    with _jobs_lock:
        _jobs[job_id] = {"status": "queued", "stage": "queued", "progress": 0.0, "tail_log": "", "error": None}
    threading.Thread(target=_run_install, args=(job_id, pkgs), daemon=True).start()
    return {"job_id": job_id, "n_packages": len(pkgs)}


@router.get("/api/analysis/install-status/{job_id}")
def install_status(job_id: str):
    with _jobs_lock:
        job = _jobs.get(job_id)
        if not job:
            return {"status": "error", "error": "Unknown job id."}
        return dict(job)
