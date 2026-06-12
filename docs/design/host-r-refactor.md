I have everything I need. I have full grounding in the actual file contents, the path threading (`r-env-dir` → config.R_ENV_DIR → r_bridge resolution), the frontend client patterns (`apiJson`, `proxy_request`, `tauri-plugin-dialog` for pickers), the capabilities, and the CI shape. Now I'll write the design doc.

This is a design/documentation task — I'll return the full markdown design doc directly as my final message (not a file), per instructions.

# Host-R Delivery Refactor — Design Doc

**Lab Analysis Suite — moving from bundled R to the user's local R + on-demand binary package installs.**

Grounded in the actual repo at `/Users/zhuojianlook/Library/CloudStorage/Dropbox/GitHub Repos/Webtools/Analysis`. File paths below are absolute where useful.

---

## 0. The current bundled-R data flow (what we're tearing out)

```
tauri.conf.json bundle.resources:["resources/r-env"]   ← ~300–700MB conda env shipped in installer
        │
lib.rs setup(): resource_dir()/resources/r-env  →  --r-env-dir <path>  →  sidecar
        │
config.py set_r_env_dir() → config.R_ENV_DIR
        │
r_bridge.py _resolve_rscript(): _bundled_rscript() FIRST, else _host_rscript()
        │  _r_env() injects R_HOME / R_LIBS_SITE / PATH / LD_LIBRARY_PATH for the bundled case
        ▼
   subprocess.run([Rscript, script.R], env=...)
```

The refactor's thesis: **delete the bundled engine, keep host-R discovery, add (a) a persisted custom-Rscript override, (b) a package manifest + check/install system that uses binary repos so the user never needs a compiler.**

---

## 1. Code changes — file by file

### 1.1 `TauriApp/src-tauri/tauri.conf.json` — drop the resource

**Change:** remove `bundle.resources`.

```jsonc
// REMOVE these lines (55–57):
"resources": [
  "resources/r-env"
]
```

Keep `"targets": "all"` for now (it's about *installer formats*, not R). **Recommendation:** leave `targets` alone — it's orthogonal to this refactor. Delete the now-empty `TauriApp/src-tauri/resources/r-env/` directory from the tree (and add `src-tauri/resources/` to `.gitignore` if it isn't already, in case the build script ever repopulates it during a power-user portable build).

**Impact:** installer drops from the conda-env-bloated size to ~90MB (Tauri shell + WebView assets + the PyInstaller sidecar `binaries/api-server-*`). No R inside.

### 1.2 `TauriApp/src-tauri/src/lib.rs` — the `--r-env-dir` arg

**DECISION FORK A — keep `--r-env-dir` as a power-user portable-R override, or drop it?**

**Recommendation: REPURPOSE, don't drop.** Rename the *concept* but keep one optional arg, because it costs almost nothing and gives power users / locked-down lab machines (no admin rights to run the CRAN installer) an escape hatch: point the app at a portable R tree on a USB stick or network share. But:

- Stop deriving it from `resource_dir()/resources/r-env` (that path no longer exists).
- Source it from an **env var** the user can set, not from the bundle. This keeps lib.rs from inventing a path that's always absent.

Concretely, replace lines 337–345 and the arg-push at 380–385:

```rust
// Optional portable-R override for power users / offline lab machines.
// Read from an env var so we don't fabricate a bundle path that no longer exists.
// The normal path is: no override → sidecar discovers the host R / uses the
// persisted custom Rscript path (see r_bridge.py).
let r_env_dir: Option<String> = std::env::var("LAS_R_ENV_DIR").ok().filter(|s| !s.is_empty());
```

```rust
let mut args: Vec<String> = vec!["--port".into(), "8765".into()];
if let Some(ref dir) = r_env_dir {
  args.push("--r-env-dir".into());
  args.push(dir.clone());
}
```

Also **add an app-data dir arg** so the sidecar knows where to persist its config (custom Rscript path, package-install state). Tauri owns the canonical per-OS app-data location; pass it down rather than re-deriving it in Python:

```rust
let app_data_dir: Option<String> = app.path().app_data_dir().ok()
    .map(|p| p.to_string_lossy().to_string());
// ...
if let Some(ref d) = app_data_dir {
  args.push("--app-data-dir".into());
  args.push(d.clone());
}
```

**Alternative (rejected):** drop `--r-env-dir` entirely. Cleaner, but removes the only offline/locked-down-machine story. Cheap to keep, so keep it.

**Also in lib.rs:** the whole macOS "sign without hardened runtime so bundled R dylibs can dlopen" rationale (comments at 166–168, 203–204) no longer applies to R — there are no bundled R dylibs. The *sidecar* PyInstaller binary still needs to dlopen its own libs, so keep ad-hoc signing, but the comments should be corrected (see §1.4). No code change in lib.rs for that beyond the arg edits.

### 1.3 `TauriApp/python-sidecar/config.py` — add app-data dir + custom-Rscript persistence

`R_ENV_DIR` stays (now fed only by the optional portable override). Add an app-data dir and helpers:

```python
APP_VERSION: str = "0.1.0"
R_ENV_DIR: Optional[str] = None        # optional portable R (LAS_R_ENV_DIR)
APP_DATA_DIR: Optional[str] = None     # per-OS app-data dir from Tauri

def set_r_env_dir(path): ...
def set_app_data_dir(path):
    global APP_DATA_DIR
    APP_DATA_DIR = path or None

def settings_path() -> str:
    base = APP_DATA_DIR or os.path.join(os.path.expanduser("~"), ".lab-analysis-suite")
    os.makedirs(base, exist_ok=True)
    return os.path.join(base, "r-settings.json")
```

`r-settings.json` is the single source of truth for the persisted custom Rscript path:
```json
{ "rscript_path": "/opt/R/4.4.1/bin/Rscript", "user_repos": "https://p3m.dev/cran/__linux__/jammy/latest" }
```

### 1.4 `TauriApp/python-sidecar/r_bridge.py` — host-first discovery, persisted custom path, env-injection only for portable

This is the heart of the refactor. Changes:

**(a) Flip resolution to host-first; portable is the fallback override.**

```python
def _read_settings() -> dict:
    try:
        with open(config.settings_path(), "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}

def _resolve_rscript(custom_path: Optional[str] = None):
    """Return (rscript_path | None, is_portable).
    Priority: explicit per-call custom_path → persisted settings rscript_path
    → portable env (R_ENV_DIR) → host discovery."""
    # 1. explicit override from this call
    if custom_path and os.path.isfile(custom_path):
        return custom_path, False
    # 2. persisted custom path
    saved = _read_settings().get("rscript_path")
    if saved and os.path.isfile(saved):
        return saved, False
    # 3. optional portable R (power user)
    p = _portable_rscript()       # was _bundled_rscript(), unchanged logic on config.R_ENV_DIR
    if p:
        return p, True
    # 4. host R on PATH / well-known locations
    return _host_rscript(), False
```

**(b) `_r_env()` stays but only fires for the portable case** (`is_portable=True`) — it's literally the renamed `is_bundled` branch. Host R inherits the parent env (returns `None`), which is correct: the user's R already knows its own `R_HOME`.

**(c) Inject the binary repo into the prelude / console** (this is what makes on-demand installs toolchain-free — see §3). Replace the hard-coded CRAN repo line in `_r_prelude` and `run_console`:

```python
def _repos_option() -> str:
    """Return an R options(repos=...) line that prefers Posit P3M BINARY repos
    for the host OS so install.packages() pulls prebuilt binaries (no compiler)."""
    user_repo = _read_settings().get("user_repos")
    if user_repo:
        return f'options(repos = c(P3M = "{user_repo}", CRAN = "https://cloud.r-project.org"))'
    sysname = platform.system()
    if sysname in ("Windows", "Darwin"):
        # P3M serves win/mac BINARIES under the plain "latest" path; R picks the binary.
        return 'options(repos = c(P3M = "https://p3m.dev/cran/latest", CRAN = "https://cloud.r-project.org"))'
    # Linux: P3M needs a distro-tagged URL for binaries; we resolve it per-distro at
    # install time (see install-packages). Default to source CRAN here.
    return 'options(repos = c(CRAN = "https://cloud.r-project.org"))'
```

Use `_repos_option()` wherever the old hard-coded `options(repos=...)` appears (prelude line 139, console line 291).

**(d) `check_r` / `RunRRequest` / `RConsoleRequest` keep the `rscript_path` param** — the frontend passes the persisted path on every call (belt-and-suspenders; the sidecar also reads it from settings). Rename the `bundled` response field to keep the API stable but mean "portable" internally:

```python
return {"installed": True, "version": version, "path": rscript, "bundled": is_portable}
```

Keep the JSON key `bundled` so `CheckRResponse.bundled` in `types.ts` doesn't churn; just document that it now means "portable/non-host". (Optional: add `"is_host": not is_portable` for clarity.)

**(e) Add the settings write endpoint + package endpoints** (new code, §2–§3).

### 1.5 `.github/workflows/release.yml` — massively simpler CI

Remove from the `build-tauri` job:
- The `Cache conda packages` step (138–144).
- The `mamba-org/setup-micromamba@v2` step (145–148).
- Both `Build bundled R engine` steps (149–156).
- From the macOS sign step: the `--deep` rationale comment about "hundreds of nested R dylibs" (220–221) is now wrong — but **keep `codesign --force --deep` and NO `--options runtime`**, because the *PyInstaller sidecar* still dlopens its own bundled libs and library validation would still break it. Just fix the comment.

Rename the job comment "Build the bundled R engine + the Tauri app" → "Build the Tauri app". Net effect: the matrix build loses the slowest, flakiest steps (conda solve + conda-pack per OS), CI time drops a lot, and no `resources/` artifact is produced. The sidecar build job is untouched.

### 1.6 `r-env/environment.yml` + `TauriApp/scripts/build-r-env.{sh,ps1}`

**DECISION FORK B — delete, or repurpose as an optional "portable R" builder?**

**Recommendation: REPURPOSE, demote, don't run in CI.** Move them out of the release path and keep them as a *developer/power-user* tool that builds a portable conda R tree the user can point `LAS_R_ENV_DIR` at (the §1.2 override). Concretely:
- Move `r-env/` → `tools/portable-r/` and the scripts → `tools/portable-r/build.sh|.ps1`.
- Change the build-script `OUT` to a neutral location (`tools/portable-r/out/`), not `src-tauri/resources/r-env`, so a stray build can't accidentally re-bloat the installer.
- Add a `tools/portable-r/README.md`: "This is NOT shipped. It builds a self-contained R for offline/locked-down machines; set `LAS_R_ENV_DIR=<path>` before launching."

**Alternative (rejected):** delete outright. Loses the offline story and the only known-good way to get DESeq2 onto an air-gapped lab box. The maintenance cost of keeping a non-CI script is near zero.

---

## 2. "R NOT FOUND" UX + the custom-path persistence

### 2.1 The gate

A single app-level **boot gate** in the React shell. On startup the existing `checkHealth()` already runs; add a `checkR()` immediately after. Render an `RGateBanner`/`RGateModal` whenever `installed === false`.

- **Modal (blocking) vs banner (non-blocking):** use a **dismissible banner at the top of every tab** plus a blocking modal only when the user clicks "Run" on a tab. R-less users can still browse the UI, read help, upload files — they just can't compute. **Recommendation: banner + run-time modal**, not a hard boot modal (a hard modal on a fresh machine before they've even seen the app is hostile).

The banner copy:
> **R is not installed.** Lab Analysis Suite uses your computer's R to run analyses and draw figures. Install R (free), then click *Recheck*. Already have R somewhere unusual? *Choose Rscript manually*.

Two buttons:
1. **Install R** → `open_url` (the existing Rust command) to the correct CRAN installer per OS:
   - macOS: `https://cran.r-project.org/bin/macosx/` (and a note: pick the arm64 `.pkg` on Apple Silicon).
   - Windows: `https://cran.r-project.org/bin/windows/base/`
   - Linux: `https://cran.r-project.org/bin/linux/` (distro-specific; for Ubuntu link the CRAN apt instructions).
   Detect OS in the frontend via `navigator.userAgent` / a tiny `/api/system/os` echo from the sidecar (it already knows `platform.system()`).
2. **Choose Rscript manually** → `tauri-plugin-dialog` open-file picker (already in capabilities: `dialog:allow-open`) filtered to the `Rscript`/`Rscript.exe` binary. On pick, POST the path to the new settings endpoint, then re-run `checkR()`.

### 2.2 Where the custom path persists + how it's threaded

**DECISION FORK C — persist in a Tauri Store (frontend) or a sidecar-written JSON (Python)?**

**Recommendation: sidecar-written JSON in the OS app-data dir**, because the *sidecar* is the process that actually spawns Rscript and must work even on the very first call before the frontend has hydrated any store. Frontend-only persistence would force every code path through JS. So:

- New endpoint `POST /api/analysis/set-rscript {rscript_path}` → validates the file runs `Rscript --version`, writes `config.settings_path()` JSON, returns the same shape as `check-r`.
- New endpoint `GET /api/analysis/get-settings` → returns `{rscript_path, user_repos}` so the frontend can show the current value.
- **Threading:** `_resolve_rscript()` reads the persisted path itself (§1.4a), so *every* `run-r` / `run-console` / `check-packages` / `install-packages` automatically honors it — no per-call plumbing required. The frontend *also* passes `rscript_path` on calls as a redundant override (already supported by `RunRRequest.rscript_path`), which lets the modal "test this path" before committing it.

Add to `client.ts`:
```ts
export async function setRscriptPath(p: string): Promise<CheckRResponse> {
  return apiJson("/api/analysis/set-rscript", "POST", JSON.stringify({ rscript_path: p }));
}
export async function getRSettings(): Promise<{ rscript_path: string; user_repos: string }> {
  return apiJson("/api/analysis/get-settings");
}
```

A small **Zustand store** `src/store/rStore.ts` holds `{ rState: CheckRResponse|null, recheck(), setPath() }` and is the single source the banner + every tab's run-gate subscribe to.

---

## 3. The REQUIRED-PACKAGES system (toolchain-free, binary-first)

### 3.1 Per-tab manifests

Each tab declares the R packages it needs, split CRAN vs Bioconductor. Keep the manifest **in the sidecar** (Python) as the source of truth so install logic and gating share it, and expose it to the frontend via an endpoint.

`python-sidecar/r_packages.py`:
```python
MANIFESTS = {
  "common":      {"cran": ["ggplot2","dplyr","tidyr","scales","ggrepel","svglite","RColorBrewer"], "bioc": []},
  "qpcr":        {"cran": ["ggsignif","rstatix"], "bioc": []},
  "xcelligence": {"cran": ["zoo"], "bioc": []},
  "rnaseq":      {"cran": ["pheatmap","ggrepel"], "bioc": ["DESeq2","apeglm"]},
  # NEW tabs declare theirs here, e.g.:
  # "scrnaseq":  {"cran": ["Seurat","Matrix"], "bioc": []},
  # "microbiome":{"cran": [], "bioc": ["phyloseq","dada2","ANCOMBC"]},
}
def needed(tab): 
    m = MANIFESTS["common"]; t = MANIFESTS.get(tab, {"cran":[],"bioc":[]})
    return {"cran": sorted(set(m["cran"]+t["cran"])), "bioc": sorted(set(m["bioc"]+t["bioc"]))}
```

### 3.2 `GET /api/analysis/check-packages?names=DESeq2,ggplot2,...`

Runs a tiny R one-liner that reports installed/version per name:
```r
pkgs <- strsplit(Sys.getenv("LAS_PKGS"), ",")[[1]]
for (p in pkgs) {
  v <- tryCatch(as.character(packageVersion(p)), error=function(e) NA)
  cat(p, "\t", ifelse(is.na(v),"MISSING",v), "\n", sep="")
}
```
The sidecar parses stdout into `[{name, installed, version}]`. (Pass names via env var, not string interpolation, to avoid injection.) Cache the result in the frontend per tab; invalidate after an install finishes.

### 3.3 `POST /api/analysis/install-packages` — binary-first, streaming

This is the crux: **install without a user toolchain.** Strategy, in order:

**Set binary repos first**, then install. Use the `_repos_option()` line (§1.4c) so `install.packages()` pulls **CRAN binaries from Posit Public Package Manager (P3M)** on Windows/macOS. P3M serves prebuilt `.zip`(win) / `.tgz`(mac) for the platform R asks for — **no Rtools, no Xcode CLT** needed for the vast majority of CRAN packages.

**Recommendation: use `pak` as the installer engine.** Rationale: `pak` (a) installs from binary repos by default, (b) resolves Bioconductor + CRAN in one transaction, (c) handles system dependencies, and (d) gives clean machine-readable progress. Bootstrap it from binary too:
```r
if (!requireNamespace("pak", quietly=TRUE))
  install.packages("pak", repos = sprintf("https://r-lib.github.io/p/pak/stable/%s/%s/%s",
     .Platform$pkgType, R.Version()$os, R.Version()$arch))
```
`pak`'s own repo ships prebuilt `pak` binaries per platform → bootstrapping `pak` itself needs no compiler. Then:
```r
options(repos = c(P3M = "<binary repo>", CRAN="https://cloud.r-project.org"))
pak::pkg_install(c("ggplot2","DESeq2","apeglm",...))   # CRAN + Bioc names both work
```

**Alternative (rejected as default):** plain `install.packages(type="binary")` + `BiocManager::install()`. Works, but `BiocManager` defaults can fall back to source for Bioc packages, and you must manage two repo systems by hand. Keep this as the **fallback path** if `pak` bootstrap fails (rare, e.g. exotic Linux), behind a try/catch that the sidecar detects from stderr.

**Bioconductor binaries:** P3M also hosts Bioc binaries for win/mac; `pak` knows the Bioc repos for the user's R version. So `DESeq2`/`apeglm` install as binaries on win/mac. **No compiler needed.**

### 3.4 Per-OS reality (the toolchain question, spelled out)

| | Windows | macOS | Linux |
|---|---|---|---|
| CRAN binaries via P3M | ✅ `.zip`, no Rtools | ✅ `.tgz`, no Xcode CLT | ⚠️ binaries only via **distro-tagged** P3M URL (e.g. `.../jammy/latest`); else **source** → needs gcc/gfortran (usually present) |
| Bioc binaries via P3M/pak | ✅ | ✅ | ⚠️ same distro-tag caveat; else source |
| Toolchain needed? | ❌ (only if a pkg has no binary → then Rtools) | ❌ (only if forced to source → then Xcode CLT) | usually has gcc; **gfortran** sometimes missing |

**Heavy-package binary reliability:**
- **DESeq2, apeglm, pheatmap, ggplot2, dplyr, svglite, ggsignif, rstatix** → reliable binaries on win/mac via P3M/pak. Linux: reliable on Ubuntu LTS via tagged P3M; otherwise source (DESeq2 compiles fine with gcc, no special tools).
- **Seurat** → reliable win/mac binary; pulls a large dep graph (Rcpp, RcppEigen, RcppArmadillo, uwot, ...). All binary on win/mac. Linux source-compiles heavily (slow but no special tools beyond gcc).
- **phyloseq, ANCOMBC** → Bioc binaries on win/mac via P3M; fine.
- **dada2** ⚠️ **flag this one.** It has a heavy C++ core. Win/mac binaries exist on P3M/Bioc for *supported* R versions, but lag new R releases. On Linux it source-compiles (needs gcc/g++, ~minutes). **If a binary isn't available for the user's exact R version**, the only options are: (1) tell the user to install a CRAN R version that has binaries (most robust), or (2) compile (needs a toolchain). The UI must surface this explicitly rather than silently hanging.

**Linux distro-tag resolution:** at install time, the sidecar reads `/etc/os-release` and builds the P3M URL `https://p3m.dev/cran/__linux__/<codename>/latest` for supported distros (jammy/focal/noble, etc.). If the distro is unsupported, fall back to source CRAN and warn that gcc/gfortran are required (check via `which gcc gfortran` and surface a clear message).

### 3.5 Rough sizes / times (set user expectations in the UI)

| Package set | Download | Disk | Realistic first-install (binary) |
|---|---|---|---|
| common (ggplot2 + deps) | ~30–60 MB | ~150 MB | 30–90 s |
| rnaseq (DESeq2+apeglm + Bioc deps) | ~80–150 MB | ~400 MB | 2–5 min |
| scRNA-seq (Seurat) | ~150–250 MB | ~700 MB–1 GB | 3–8 min |
| microbiome (phyloseq+dada2+ANCOMBC) | ~120–200 MB | ~600 MB | 4–10 min (binary) / 15–30+ min if source |

Show these as estimates in the install dialog so a 5-minute Seurat install doesn't look like a hang.

---

## 4. UX for long package installs + run-gating

### 4.1 Where it runs + streaming

Installs run through R, so reuse the R-subprocess machinery — but the existing `run-console` is **request/response only** (returns after the whole thing finishes). For multi-minute installs you need progress. Two options:

**DECISION FORK D — extend `run-console` with the long-job/poll pattern, or open a streaming endpoint?**

**Recommendation: reuse the established long-running job pattern** (the same `POST start → returns job_id → GET status` shape the spec mandates for the analysis tabs, modeled on multipanelfigure's `alignZStack`/`pollAlignStatus`). Don't invent a second mechanism. So:

- `POST /api/analysis/install-packages {tab | names, scope}` → spawns `Rscript install.R` as a **background subprocess** (sidecar keeps a `jobs[job_id]` dict with `{status, stage, progress, log, error}`), returns `{job_id}` immediately.
- `GET /api/analysis/install-status/{job_id}` → `{status: queued|running|done|error, stage, progress, tail_log}`.
- Progress is surfaced by **parsing `pak`/R stdout markers.** `pak::pkg_install()` emits per-package lines; emit explicit markers from the install.R wrapper for robust parsing:
  ```r
  cat("LAS_STAGE: resolving\n"); ...
  for (p in pkgs) { cat(sprintf("LAS_PKG_START: %s\n", p)); ...; cat(sprintf("LAS_PKG_DONE: %s (%d/%d)\n", p, i, n)) }
  cat("LAS_STAGE: done\n")
  ```
  The sidecar reads the subprocess stdout line-by-line (a reader thread), updates `jobs[job_id].progress = i/n`, and the frontend polls every ~1.5 s.

**Alternative (rejected):** Server-Sent Events / chunked streaming through the Rust `proxy_request`. The Rust proxy does `resp.text().await` (buffers the whole body) — SSE wouldn't stream through it without changing the proxy. The poll pattern fits the existing architecture with zero Rust changes.

### 4.2 The install dialog

- Triggered from the per-tab run-gate (below) or a global Settings → "R packages" panel.
- Shows: list of needed packages with installed/missing badges (from `check-packages`), a size/time estimate, an **Install required packages** button.
- During install: a progress bar (`progress` from status), the current package ("Installing DESeq2… (3/9)"), and a collapsible live log (`tail_log`). A **Cancel** button kills the job subprocess (sidecar `jobs[job_id].proc.kill()`).
- On `error`: show the tail of stderr and, for the dada2 / no-binary case, a specific message: *"No prebuilt binary for dada2 on your R version. Install R 4.x from CRAN (recommended) or a compiler toolchain, then retry."* with the CRAN link.

### 4.3 Gating each tab's "Run"

Every tab's Run button calls a shared `useTabReadiness(tab)` hook that:
1. ensures `rStore.installed === true` (else show the §2 banner/modal),
2. calls `check-packages` for that tab's manifest,
3. if anything missing → disable Run, show **"Install required packages (N missing)"** which opens the §4.2 dialog,
4. when the install job reports `done`, re-run `check-packages`, enable Run.

Cache readiness per tab in the Zustand store; invalidate on install completion and on Rscript-path change.

---

## 5. Implications for existing tabs (qPCR / xCELLigence / DESeq2 / Plate Mapper) + phasing

**They all now depend on host R + on-demand packages.** Specifically:
- **qPCR, xCELLigence, RNA-seq** call `run-r` with ggplot2 (and DESeq2/apeglm for RNA-seq). Previously these were guaranteed present in the bundled env. Now their first run on a fresh machine would fail with `there is no package called 'ggplot2'`. **Fix:** route every tab through the §4.3 readiness gate so "common" packages (ggplot2 etc.) get installed before the first `run-r`. The RNA-seq tab additionally gates on `DESeq2`+`apeglm`.
- **Plate Mapper** likely does no R (pure pandas/layout) — if so it needs **no** gate. Confirm and, if R-free, exempt it so it works even with no R installed (a nice "the app isn't useless without R" win).
- The `bundled` field in `CheckRResponse` now means "portable" — any UI that says "Bundled R engine" must change to "Using your R at `<path>`" / "Using portable R". Search the rnaseq/qpcr/xcelligence components for copy referencing bundled R.
- The hard-coded `options(repos = "https://cloud.r-project.org")` in the prelude meant source installs if any tab ever installed mid-run; now centralized through `_repos_option()` → binary repos.

**Updated phasing (maps to the existing task list — Phase 1 "Bundled R PoC" is now obsolete):**
- **Phase 1 (was bundled-R PoC) → "Host-R delivery":** §1 code changes (tauri.conf, lib.rs, config, r_bridge, CI), §2 R-not-found gate + persisted path, §3 check/install endpoints + `r_packages.py` manifest, §4 install job + readiness hook. This unblocks *every* tab.
- **Phase 2a–2d (existing tabs):** add the §4.3 readiness gate to each; flip "bundled R" copy; Plate Mapper exempted if R-free.
- **Phase 3 (CI/updater):** apply §1.5 — drop micromamba/conda-pack steps; installers shrink; fix the macOS-signing comment (keep deep ad-hoc sign for the sidecar, not for R).
- **Phase 4 (packaging/polish):** per-OS smoke test of "fresh machine → install R → install packages → run a tab" on win/mac/linux; verify P3M binary URLs resolve; verify the dada2-no-binary error path renders correctly.
- **New tabs (the 3 being designed):** declare manifests in `r_packages.py`; they inherit the gate for free.

---

## 6. Concrete change list (checklist)

| File | Action |
|---|---|
| `TauriApp/src-tauri/tauri.conf.json` | Remove `bundle.resources:["resources/r-env"]`. Delete `src-tauri/resources/r-env/`. |
| `TauriApp/src-tauri/src/lib.rs` | Replace `resource_dir()`-derived `r_env_dir` with `env::var("LAS_R_ENV_DIR")`. Add `--app-data-dir` from `app.path().app_data_dir()`. Fix stale "bundled R dylibs" comments. |
| `TauriApp/python-sidecar/config.py` | Add `APP_DATA_DIR`, `set_app_data_dir`, `settings_path()`. |
| `TauriApp/python-sidecar/api_server.py` | Call `config.set_app_data_dir(args.app_data_dir)`; add `--app-data-dir` arg. Keep `--r-env-dir`. |
| `TauriApp/python-sidecar/r_bridge.py` | Host-first `_resolve_rscript` reading persisted path; rename `_bundled_rscript`→`_portable_rscript` (logic unchanged); `_r_env` fires only for portable; add `_repos_option()` (P3M binary) and use in prelude + console; rename `is_bundled`→`is_portable`. Add `set-rscript`, `get-settings`, `check-packages`, `install-packages`, `install-status/{job_id}` endpoints + a `jobs` dict + stdout-reader thread + marker parsing. |
| `TauriApp/python-sidecar/r_packages.py` (NEW) | Per-tab CRAN/Bioc manifests + `needed(tab)`; `install.R` wrapper emitting `LAS_PKG_*` markers via `pak`. |
| `.github/workflows/release.yml` | Remove conda cache, setup-micromamba, both build-r-env steps. Fix macOS sign comment (keep deep ad-hoc sign for sidecar). |
| `r-env/` + `TauriApp/scripts/build-r-env.{sh,ps1}` | Move to `tools/portable-r/`; retarget `OUT` away from `src-tauri/resources`; add README "not shipped; for `LAS_R_ENV_DIR`". |
| `TauriApp/src/api/client.ts` | Add `setRscriptPath`, `getRSettings`, `checkPackages`, `installPackages`, `pollInstall`. Document `bundled`→portable. |
| `TauriApp/src/api/types.ts` | Add `PackageStatus`, `InstallJobStatus`; note `bundled` = portable. |
| `TauriApp/src/store/rStore.ts` (NEW) | Zustand store: R state, per-tab readiness, recheck/setPath/installForTab. |
| `TauriApp/src/components/shared/RGateBanner.tsx`, `RInstallDialog.tsx`, `RSettings` (NEW) | Banner + manual-path picker (`dialog:allow-open`) + install-progress dialog. |
| Each tab component (`qpcr/`, `xcelligence/`, `rnaseq/`) | Wrap Run in `useTabReadiness(tab)`; replace "bundled R" copy. Plate Mapper exempt if R-free. |

**Capabilities:** no change — `dialog:allow-open`, `shell:default`, `process:default` already cover the file picker and subprocess needs. `open_url` already exists for the CRAN links.

**Net result:** installer ~90 MB; CI loses its slowest steps; the app works against any CRAN R the user installs; required packages install as toolchain-free binaries via P3M/`pak`, gated per tab with streamed progress; one documented escape hatch (`LAS_R_ENV_DIR` portable R) for offline/locked-down machines; one flagged risk (`dada2` binary availability) handled with an explicit user message.