# Build the bundled R engine (conda env) on Windows and place it into the
# Tauri bundle resources at TauriApp/src-tauri/resources/r-env.
# Requires `micromamba` on PATH and `tar` (ships with Windows 10+).
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = (Resolve-Path "$ScriptDir/../..").Path           # Analysis/
$EnvFile = Join-Path $Root "r-env/environment.yml"
$Out = Join-Path $Root "TauriApp/src-tauri/resources/r-env"
$Tmp = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$Build = Join-Path $Tmp "r-build"
$Tarball = Join-Path $Tmp "r-env.tar.gz"

Write-Host "==> Creating R env from $EnvFile"
if (Test-Path $Build) { Remove-Item -Recurse -Force $Build }
micromamba create -y -p $Build -f $EnvFile
micromamba install -y -p $Build -c conda-forge conda-pack

Write-Host "==> Smoke test (build env): DESeq2 + ggplot2 load"
micromamba run -p $Build Rscript -e 'suppressMessages({library(DESeq2); library(ggplot2)}); cat("build-env OK\n")'

Write-Host "==> conda-pack (relocatable tarball)"
if (Test-Path $Tarball) { Remove-Item -Force $Tarball }
micromamba run -p $Build conda-pack -p $Build -o $Tarball --n-threads -1 --compress-level 6 --force

Write-Host "==> Unpack into bundle resources: $Out"
if (Test-Path $Out) { Remove-Item -Recurse -Force $Out }
New-Item -ItemType Directory -Force -Path $Out | Out-Null
tar -xzf $Tarball -C $Out

# conda-unpack finalizes relocation (Windows: Scripts\conda-unpack.exe)
$Unpack = Get-ChildItem -Path $Out -Recurse -Filter "conda-unpack*" | Select-Object -First 1
if ($Unpack) { & $Unpack.FullName }

Write-Host "==> Smoke test (packed env)"
$Rscript = Get-ChildItem -Path $Out -Recurse -Filter "Rscript.exe" | Select-Object -First 1
if (-not $Rscript) { throw "Rscript.exe not found in packed env at $Out" }
& $Rscript.FullName -e 'suppressMessages({library(DESeq2); library(ggplot2)}); cat("packed-env OK\n")'
Write-Host "==> Bundled R engine ready at $Out"
