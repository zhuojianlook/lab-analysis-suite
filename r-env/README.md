# Bundled R engine (`r-env`)

The app ships a self-contained R runtime (a relocated conda env) so ggplot2 +
DESeq2 work offline with no host R install. `environment.yml` is the spec.

## Build locally (per platform, on that platform)

Requires [micromamba](https://mamba.readthedocs.io/en/latest/installation/micromamba-installation.html)
(or mamba/conda) and `conda-pack`.

```bash
# 1. Create the env into a local prefix
micromamba create -y -p ./build/r-env -f environment.yml

# 2. Smoke-test that DESeq2 + ggplot2 load
./build/r-env/bin/Rscript -e 'suppressMessages({library(DESeq2); library(ggplot2)}); cat("ok\n")'

# 3. Relocate (rewrites absolute prefixes/rpaths so the env works anywhere)
micromamba run -p ./build/r-env conda-pack -p ./build/r-env -o r-env.tar.gz
mkdir -p unpacked && tar -xzf r-env.tar.gz -C unpacked
./unpacked/bin/conda-unpack            # finalizes relocation

# 4. (optional) prune docs/help/tests to cut size
rm -rf unpacked/lib/R/library/*/doc unpacked/lib/R/library/*/help unpacked/lib/R/library/*/tests 2>/dev/null || true

# 5. Place into the Tauri bundle resources
rm -rf ../TauriApp/src-tauri/resources/r-env
cp -R unpacked ../TauriApp/src-tauri/resources/r-env
```

> Windows layout differs: Rscript is under `Scripts/` / `Library/bin/` /
> `Lib/R/bin/x64/`. `r_bridge.py` globs all of these, so just unpack the env to
> `resources/r-env` and it will be found.

## How the app finds it

The Tauri shell passes `--r-env-dir <resource_dir>/resources/r-env` to the
sidecar (`src-tauri/src/lib.rs`). `r_bridge.py` resolves `Rscript` inside it and
sets `R_HOME` / `R_LIBS_SITE` / `PATH` before invoking it.

## R plot templates

`rscripts/` holds the versioned ggplot/DESeq2 templates each tab feeds through
`/api/analysis/run-r` (added per tab in Phase 2).
