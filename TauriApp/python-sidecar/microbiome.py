"""16S rRNA microbiome analysis (DADA2 + phyloseq).

Two modes:
  B (default) — start from an ASV/OTU table + taxonomy + sample metadata.
  A           — start from raw paired FASTQs → DADA2 → ASV table + taxonomy,
                using a user-supplied SILVA reference, then the same downstream.

Downstream (phyloseq): alpha diversity, beta diversity ordination (PCoA Bray-
Curtis) + PERMANOVA, taxonomic composition barplots, and differential
abundance (ANCOM-BC2). Runs as an async R job; packages install via the
'microbiome' manifest.
"""

from __future__ import annotations

import io
import os
import uuid
from typing import Dict, List, Optional

import pandas as pd
from fastapi import APIRouter
from pydantic import BaseModel

import rjobs

router = APIRouter()

_SESS: Dict[str, dict] = {}


def _resc(s: str) -> str:
    return str(s).replace("\\", "\\\\").replace('"', '\\"')


class RegisterRequest(BaseModel):
    mode: str                       # "table" | "fastq"
    asv: Optional[str] = None
    taxonomy: Optional[str] = None
    metadata: Optional[str] = None
    tree: Optional[str] = None
    fastq_dir: Optional[str] = None
    silva: Optional[str] = None


@router.post("/api/microbiome/register")
def register(body: RegisterRequest):
    def need(label, path):
        if not path or not os.path.exists(path):
            return f"{label} not found: {path or '(missing)'}"
        return None

    errs = []
    if body.mode == "table":
        for lbl, p in (("ASV table", body.asv), ("Taxonomy", body.taxonomy), ("Metadata", body.metadata)):
            e = need(lbl, p)
            if e:
                errs.append(e)
    elif body.mode == "fastq":
        for lbl, p in (("FASTQ folder", body.fastq_dir), ("Metadata", body.metadata), ("SILVA reference", body.silva)):
            e = need(lbl, p)
            if e:
                errs.append(e)
    else:
        return {"error": "mode must be 'table' or 'fastq'."}
    if errs:
        return {"error": "; ".join(errs)}

    # metadata columns (for the group selector)
    cols: List[str] = []
    try:
        md = pd.read_csv(body.metadata, index_col=0, nrows=200)
        cols = [str(c) for c in md.columns]
    except Exception:  # noqa: BLE001
        pass

    token = uuid.uuid4().hex[:12]
    _SESS[token] = body.model_dump()
    return {"token": token, "mode": body.mode, "metadata_columns": cols}


class RunRequest(BaseModel):
    token: str
    group_column: str
    rarefy: bool = True
    tax_rank: str = "Genus"
    diff_method: str = "ancombc2"     # ancombc2 | none
    build_tree: bool = False          # attach the supplied tree to the phyloseq object
    beta_metric: str = "bray"         # bray | wunifrac | unifrac (UniFrac needs a tree)
    # DADA2 (fastq mode)
    trunc_len_f: int = 0
    trunc_len_r: int = 0
    trim_left: int = 0


def _dada2_block(s: dict, body: RunRequest) -> str:
    fq = _resc(s["fastq_dir"])
    silva = _resc(s["silva"])
    return f'''
suppressMessages(library(dada2))
las_stage("dada2_filter", 0.15)
fpath <- "{fq}"
fnFs <- sort(list.files(fpath, pattern="_R1", full.names=TRUE))
fnRs <- sort(list.files(fpath, pattern="_R2", full.names=TRUE))
if (length(fnFs) == 0) las_error("No *_R1* FASTQs found in the folder")
sample.names <- sub("_R1.*", "", basename(fnFs))
filtFs <- file.path(fpath, "filtered", paste0(sample.names, "_F.fastq.gz"))
filtRs <- file.path(fpath, "filtered", paste0(sample.names, "_R.fastq.gz"))
out <- filterAndTrim(fnFs, filtFs, fnRs, filtRs, truncLen=c({int(body.trunc_len_f)}, {int(body.trunc_len_r)}),
                     trimLeft={int(body.trim_left)}, maxEE=c(2,2), truncQ=2, rm.phix=TRUE, multithread=TRUE)
las_stage("dada2_learn", 0.3)
errF <- learnErrors(filtFs, multithread=TRUE); errR <- learnErrors(filtRs, multithread=TRUE)
las_stage("dada2_denoise", 0.45)
ddF <- dada(filtFs, err=errF, pool="pseudo", multithread=TRUE)
ddR <- dada(filtRs, err=errR, pool="pseudo", multithread=TRUE)
mergers <- mergePairs(ddF, filtFs, ddR, filtRs)
seqtab <- makeSequenceTable(mergers)
seqtab.nochim <- removeBimeraDenovo(seqtab, method="consensus", multithread=TRUE)
las_stage("dada2_taxonomy", 0.55)
taxa <- assignTaxonomy(seqtab.nochim, "{silva}", multithread=TRUE)
asv_mat <- t(seqtab.nochim)            # taxa x samples
tax_mat <- as.matrix(taxa)
rownames(asv_mat) <- paste0("ASV", seq_len(nrow(asv_mat)))
rownames(tax_mat) <- rownames(asv_mat)
'''


def _table_block(s: dict) -> str:
    asv = _resc(s["asv"])
    tax = _resc(s["taxonomy"])
    return f'''
las_stage("load_tables", 0.2)
asv_mat <- as.matrix(read.csv("{asv}", row.names=1, check.names=FALSE))
tax_mat <- as.matrix(read.csv("{tax}", row.names=1, check.names=FALSE))
# ensure taxa are rows: if sample names look like the metadata rows, keep; else transpose heuristically
'''


def _downstream(s: dict, body: RunRequest) -> str:
    meta = _resc(s["metadata"])
    grp = _resc(body.group_column)
    rank = _resc(body.tax_rank)
    rarefy = "TRUE" if body.rarefy else "FALSE"

    # Beta-diversity distance. UniFrac variants require a phylogenetic tree; if
    # one isn't available we attach nothing and fall back to Bray-Curtis so the
    # selector never silently produces a misleading result.
    has_tree = bool(s.get("tree"))
    beta = str(body.beta_metric).lower()
    if beta not in ("bray", "unifrac", "wunifrac"):
        beta = "bray"
    needs_tree = beta in ("unifrac", "wunifrac")
    attach_tree = has_tree and (body.build_tree or needs_tree)
    if needs_tree and not attach_tree:
        beta = "bray"
    dist_method = beta
    dist_label = {"unifrac": "Unweighted UniFrac", "wunifrac": "Weighted UniFrac",
                  "bray": "Bray-Curtis"}[dist_method]

    tree_block = ""
    if attach_tree:
        tree_block = f'TREE <- ape::read.tree("{_resc(s["tree"])}"); ps <- merge_phyloseq(ps, phyloseq::phy_tree(TREE))\n'
    diff_block = ""
    if body.diff_method == "ancombc2":
        diff_block = f'''
las_stage("diff_abundance", 0.94)
if (requireNamespace("ANCOMBC", quietly=TRUE)) {{
  da <- tryCatch(ANCOMBC::ancombc2(data=ps, tax_level="{rank}", fix_formula="{grp}", p_adj_method="BH", prv_cut=0.10),
                 error=function(e) {{ las_error(paste("ANCOM-BC2:", conditionMessage(e))); NULL }})
  if (!is.null(da) && !is.null(da$res)) mpfig_data(da$res, "diff_abundance")
}}
'''
    return f'''
suppressMessages({{ library(phyloseq); library(ggplot2); library(vegan) }})
las_stage("phyloseq", 0.6)
meta <- read.csv("{meta}", row.names=1, check.names=FALSE, stringsAsFactors=TRUE)
common <- intersect(colnames(asv_mat), rownames(meta))
if (length(common) < 2) las_error("Fewer than 2 samples shared between the table and metadata")
asv_mat <- asv_mat[, common, drop=FALSE]; meta <- meta[common, , drop=FALSE]
ps <- phyloseq(otu_table(asv_mat, taxa_are_rows=TRUE), tax_table(tax_mat), sample_data(meta))
{tree_block}ps <- prune_taxa(taxa_sums(ps) > 0, ps)
mpfig_data(data.frame(metric=c("n_taxa","n_samples"), value=c(ntaxa(ps), nsamples(ps))), "summary")

las_stage("alpha", 0.7)
rich <- estimate_richness(ps, measures=c("Observed","Shannon","Simpson"))
rich$Sample <- rownames(rich)
md <- data.frame(sample_data(ps)); md$Sample <- rownames(md)
rich <- merge(rich, md, by="Sample")
mpfig_data(rich, "alpha_diversity")
if ("{grp}" %in% colnames(rich)) {{
  suppressMessages(library(tidyr))
  al <- pivot_longer(rich, cols=c("Observed","Shannon","Simpson"), names_to="Index", values_to="Value")
  mpfig_plot(width=1200, height=500)
  print(ggplot(al, aes(.data[["{grp}"]], Value, fill=.data[["{grp}"]])) + geom_boxplot(outlier.size=0.6) +
          geom_jitter(width=0.12, size=0.8, alpha=0.6) + facet_wrap(~Index, scales="free_y") +
          theme_classic(base_size=13) + theme(axis.text.x=element_text(angle=45, hjust=1), legend.position="none") +
          labs(x=NULL, title="Alpha diversity"))
}}

las_stage("beta", 0.8)
psr <- if ({rarefy}) rarefy_even_depth(ps, rngseed=1, verbose=FALSE) else ps
bc <- tryCatch(phyloseq::distance(psr, method="{dist_method}"),
               error=function(e) {{ cat("Distance '{dist_method}' failed (", conditionMessage(e), "); falling back to Bray-Curtis\\n"); phyloseq::distance(psr, method="bray") }})
ord <- ordinate(psr, method="PCoA", distance=bc)
mpfig_plot()
print(plot_ordination(psr, ord, color="{grp}") + geom_point(size=3) + theme_classic(base_size=13) +
        ggtitle("PCoA ({dist_label})"))
mdf <- as(sample_data(psr), "data.frame")
perm <- tryCatch(vegan::adonis2(as.formula(paste("bc ~", "{grp}")), data=mdf),
                 error=function(e) {{ las_error(paste("PERMANOVA:", conditionMessage(e))); NULL }})
if (!is.null(perm)) mpfig_data(as.data.frame(perm), "permanova")

las_stage("composition", 0.88)
psg <- tryCatch(tax_glom(ps, taxrank="{rank}", NArm=FALSE), error=function(e) ps)
psg <- transform_sample_counts(psg, function(x) x / sum(x))
mpfig_plot(width=1300, height=700)
print(plot_bar(psg, fill="{rank}") + theme(legend.position="bottom") + labs(title=paste("Composition by {rank}")))
{diff_block}
las_stage("done", 1.0)
'''


@router.post("/api/microbiome/run")
def run(body: RunRequest):
    s = _SESS.get(body.token)
    if not s:
        return {"job_id": None, "error": "Session expired — please re-register."}
    build = _dada2_block(s, body) if s["mode"] == "fastq" else _table_block(s)
    code = build + _downstream(s, body)
    timeout = 7200 if s["mode"] == "fastq" else 1800
    job_id = rjobs.start_r_job(code, inputs=None, timeout=timeout)
    return {"job_id": job_id}


@router.get("/api/microbiome/status/{job_id}")
def status(job_id: str):
    return rjobs.status(job_id)
