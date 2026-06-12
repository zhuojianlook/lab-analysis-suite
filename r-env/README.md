# `r-env` — optional portable R (power users only)

**The app uses the user's locally-installed R by default.** It is NOT bundled.
On first use of an R-backed tab, the app installs that tab's R packages as
binaries via `pak` + Posit Public Package Manager (no compiler needed on
Windows/macOS; Linux LTS via distro-tagged P3M). See the package system in
`TauriApp/python-sidecar/r_packages.py`.

This folder is kept only as an **optional** way to build a self-contained
portable R tree for locked-down machines (no admin rights to run the CRAN
installer, air-gapped labs). It is **not** part of the release build.

## Build a portable R (optional)

`environment.yml` lists R + the packages. Build it with micromamba + conda-pack
using `../TauriApp/scripts/build-r-env.sh` (macOS/Linux) or `build-r-env.ps1`
(Windows), then point the app at it:

```bash
export LAS_R_ENV_DIR=/path/to/portable/r-env   # the Tauri shell forwards this
                                                # to the sidecar as --r-env-dir
```

The sidecar's `r_bridge.py` will then resolve `Rscript` inside that tree and set
`R_HOME` / `R_LIBS` / `PATH` accordingly, instead of discovering a host R.

`rscripts/` holds the versioned ggplot/analysis R templates the tabs feed
through `/api/analysis/run-r` (added per tab).
