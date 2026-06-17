# Sample data

Small, synthetic datasets to exercise each tab end-to-end. All are validated
against the actual parsers in `TauriApp/python-sidecar/`. Numbers are made up —
they're for checking the pipeline runs and produces figures, not for biology.

| Tab | Files | How to load |
|---|---|---|
| **qPCR** | `qpcr/demo_qpcr.txt` + `qpcr/demo_platemap.txt` | Upload **both** files. Reference gene: **GAPDH**; targets: **MYC, IL6**; control sample: **Ctrl**; experimental: **Treat**. (MYC ≈ 2× up, IL6 ≈ 2× down in Treat.) |
| **xCELLigence** | `xcelligence/demo_xcelligence.xlsx` | Upload it. Normalize to **Ctrl**; samples **Ctrl** (A1–A3) vs **Treat** (A4–A6), 6 timepoints. |
| **Bulk RNA-seq** | `rnaseq/counts.csv` + `rnaseq/coldata.csv` | Counts = first uploader, metadata = second. Factor **condition** (Ctrl vs Treat), ~30 up / 30 down genes; `batch` also present. |
| **scRNA-seq** | `scrna/scrna_counts.csv` | Register this file (counts matrix, 600 genes × 300 cells, 3 populations). Species: any; defaults are fine. |
| **16S rRNA** | `microbiome/asv_table.csv` + `taxonomy.csv` + `metadata.csv` | Mode **ASV/OTU table**: ASV table, taxonomy, metadata. Group column: **Group** (GroupA vs GroupB). |
| **Plate Mapper** | — | No input needed; just build a layout and export. |
| **Spatial** | *(none — needs real Visium)* | Synthetic Visium isn't meaningful (needs the tissue image + Space Ranger `spatial/`). Use a real public dataset, e.g. 10x Genomics Visium demos (download a Space Ranger `outs/` folder) or a SeuratData `stxBrain` `.rds`. |

## Notes
- These are **tiny** sets so runs finish fast. Real experiments will be larger
  and slower (especially scRNA-seq and the 16S DADA2-from-FASTQ mode).
- The R-backed tabs need R installed; each tab installs its R packages on first
  use (binary, no compiler needed).
- qPCR Cp values: GAPDH≈20 (reference), MYC Ctrl 25 / Treat 24, IL6 Ctrl 23 /
  Treat 24 — so MYC ≈ 2-fold up and IL6 ≈ 2-fold down after the ΔΔCt math.
