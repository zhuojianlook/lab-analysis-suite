"""qPCR ΔΔCt analysis.

Ported from the standalone Streamlit qPCR app: parse paired LightCycler
`*_qpcr.txt` (Cp per well) + `*_platemap.txt` (well -> Gene + Sample), compute
ΔΔCt fold-change, run t-test or ANOVA+Tukey, and render a ggplot2 chart with
error bars + significance brackets. The default layout puts all genes on a
single graph (genes on the x-axis, bars/violins dodged by sample); a faceted
(one panel per gene) layout is also available. Bracket geometry — including the
dodged x-positions for the grouped layout — is computed here so the R template
stays purely presentational.
"""

from __future__ import annotations

import io
import itertools
import math
import re
from typing import Dict, List, Optional

import numpy as np
import pandas as pd
from fastapi import APIRouter, File, UploadFile
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool
from scipy.stats import ttest_ind
from statsmodels.stats.multicomp import pairwise_tukeyhsd

import qpcr_library
import r_bridge

router = APIRouter()

# Plate-map cells that mean "unassigned well" — pandas' default NA markers
# minus "NA" and "None", which are plausible sample names.
PLATEMAP_BLANKS = ["", "#N/A", "#N/A N/A", "#NA", "-1.#IND", "-1.#QNAN", "-NaN", "-nan", "1.#IND", "1.#QNAN",
                   "<NA>", "N/A", "n/a", "NULL", "null", "NaN", "nan"]


# ── Parsing ─────────────────────────────────────────────────────────────────

class QpcrFileError(ValueError):
    """A file whose table could not be found; the message is shown as is."""


def _decode(data: bytes) -> str:
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("latin-1", errors="replace")


def _cells(line: str) -> List[str]:
    return [c.strip().strip('"').strip().lower() for c in line.split("\t")]


def _table_text(data: bytes, wants: List[set], what: str, expected: str) -> str:
    """The tab-separated table in `data`, from its header row on.

    Exports carry text before the table: the LightCycler's "Experiment: …"
    line, or a block of "#" comment lines from plate-map generators such as
    the OT-2 Config Builder. The header is the first row (within the first
    200 lines) that has a column from every set in `wants`
    (case-insensitive). Blank and "#" lines are skipped."""
    lines = _decode(data).splitlines()
    for i, line in enumerate(lines[:200]):
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        cells = set(_cells(line))
        if all(cells & w for w in wants):
            return "\n".join(lines[i:])
    raise QpcrFileError(f"{what}: couldn't find the table header ({expected}). Is this the right file?")


_POS = {"pos", "cell position", "well", "position", "well position"}


def _rename_like(df: pd.DataFrame, names: set, to: str) -> pd.DataFrame:
    for c in df.columns:
        if str(c).strip().lower() in names:
            return df.rename(columns={c: to})
    return df


def _parse_pair_wells(qpcr_bytes: bytes, platemap_bytes: bytes) -> pd.DataFrame:
    """Every plate-mapped well with its position and Cp (NaN = undetermined),
    unfiltered — what the run library stores."""
    qtext = _table_text(qpcr_bytes, [{"pos"}, {"cp"}], "qPCR file", "Pos and Cp columns")
    dq = pd.read_csv(io.StringIO(qtext), sep="\t", dtype=str, keep_default_na=False)
    dq = _rename_like(_rename_like(dq, {"pos"}, "Pos"), {"cp"}, "Cp")[["Pos", "Cp"]]
    # Plate-map labels are text: read them as such so an all-numeric Sample
    # column doesn't become "1.0" in one run and "1" in another, and a sample
    # literally named "NA" isn't read as missing.
    ptext = _table_text(platemap_bytes, [_POS, {"gene"}, {"sample"}], "Plate map", "Cell Position, Gene and Sample columns")
    dl = pd.read_csv(io.StringIO(ptext), sep="\t", dtype=str, keep_default_na=False, na_values=PLATEMAP_BLANKS)
    dl = _rename_like(_rename_like(_rename_like(dl, _POS, "Pos"), {"gene"}, "Gene"), {"sample"}, "Sample")[["Pos", "Gene", "Sample"]]
    dq["Pos"] = dq["Pos"].astype(str).str.strip()
    dl["Pos"] = dl["Pos"].str.strip()
    merged = pd.merge(dq, dl, on="Pos", how="inner").dropna(subset=["Sample", "Gene"])
    merged["Sample"] = merged["Sample"].str.strip()
    merged["Gene"] = merged["Gene"].str.strip()
    merged = merged[(merged["Sample"] != "") & (merged["Gene"] != "")]
    merged["Cp"] = pd.to_numeric(merged["Cp"], errors="coerce")
    return merged.rename(columns={"Pos": "Well"})[["Well", "Sample", "Gene", "Cp"]].reset_index(drop=True)


def _parse_pair(qpcr_bytes: bytes, platemap_bytes: bytes, drop_high_cp: bool) -> pd.DataFrame:
    df = _parse_pair_wells(qpcr_bytes, platemap_bytes).dropna(subset=["Cp"])
    if drop_high_cp:
        df = df[df["Cp"] < 35]
    return df[["Sample", "Gene", "Cp"]].reset_index(drop=True)


def _records(df: pd.DataFrame) -> List[dict]:
    """DataFrame -> JSON-safe records (NaN/inf -> None; JSON has no NaN, and an
    SD over a single replicate is NaN)."""
    clean = df.replace([np.inf, -np.inf], np.nan)
    return clean.astype(object).where(clean.notna(), None).to_dict("records")


async def _read_pairs(files: List[UploadFile]):
    """Group uploaded files into LightCycler pairs by stem. Returns
    ({stem: (qpcr_bytes, platemap_bytes)}, [unpaired file names], [errors]).
    A stem given twice in one drop (e.g. same-named files from two folders) is
    rejected rather than pairing one experiment's Cp with another's plate map."""
    qpcr_files: Dict[str, bytes] = {}
    plate_files: Dict[str, bytes] = {}
    names: Dict[str, str] = {}
    dupes = set()
    for f in files:
        data = await f.read()
        name = f.filename or ""
        stem = _stem(name)
        if name.endswith("_platemap.txt"):
            target = plate_files
        elif name.endswith("_qpcr.txt"):
            target = qpcr_files
        else:
            continue
        if stem in target and target[stem] != data:  # the same file dropped twice is fine
            dupes.add(stem)
        target[stem] = data
        names.setdefault(stem, name)
    errors = [f"{s}: more than one file with this name in the drop — add them separately" for s in sorted(dupes)]
    paired = {s: (qpcr_files[s], plate_files[s]) for s in sorted(set(qpcr_files) & set(plate_files)) if s not in dupes}
    unpaired = sorted(names[s] for s in (set(qpcr_files) ^ set(plate_files)) if s not in dupes)
    return paired, unpaired, errors


def _stem(name: str) -> str:
    base = name.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    return base.replace("_qpcr.txt", "").replace("_platemap.txt", "")


@router.post("/api/qpcr/upload")
async def upload(files: List[UploadFile] = File(...), drop_high_cp: bool = False):
    paired, _unpaired, errors = await _read_pairs(files)
    pairs = []
    for stem, (qb, pb) in paired.items():
        try:
            df = _parse_pair(qb, pb, drop_high_cp)
            pairs.append({"name": stem, "records": df.to_dict("records"), "n_rows": len(df)})
        except Exception as e:  # noqa: BLE001
            errors.append(f"{stem}: {e}")

    if not pairs:
        return {"pairs": [], "genes_common": [], "genes_all": [], "samples": [],
                "errors": errors or ["No matching *_qpcr.txt / *_platemap.txt pairs found."]}

    gene_sets = [set(p["records"] and pd.DataFrame(p["records"])["Gene"].unique()) for p in pairs]
    genes_common = sorted(set.intersection(*gene_sets)) if gene_sets else []
    genes_all = sorted(set.union(*gene_sets)) if gene_sets else []
    samples = sorted({r["Sample"] for p in pairs for r in p["records"]})
    return {"pairs": pairs, "genes_common": genes_common, "genes_all": genes_all,
            "samples": samples, "errors": errors}


# ── Run library (persistent; see qpcr_library) ──────────────────────────────

def _library() -> dict:
    return {"runs": qpcr_library.list_runs(), "path": qpcr_library.db_path()}


@router.get("/api/qpcr/library")
def library():
    return _library()


def _store_pairs(paired: Dict[str, tuple]):
    added, replaced, errors = [], [], []
    for stem, (qb, pb) in paired.items():
        existing = qpcr_library.find_run(stem)
        if existing and existing["source"] != "lightcycler":
            errors.append(f"{stem}: a manually entered plate already has this name — rename or remove it first")
            continue
        try:
            wells = _parse_pair_wells(qb, pb)
            if wells.empty:
                errors.append(f"{stem}: no wells matched the plate map")
                continue
            (replaced if qpcr_library.save_run(stem, "lightcycler", wells) else added).append(stem)
        except Exception as e:  # noqa: BLE001
            errors.append(f"{stem}: {e}")
    return added, replaced, errors


@router.post("/api/qpcr/library/import")
async def library_import(files: List[UploadFile] = File(...)):
    """Parse LightCycler pairs and store them (same run name replaces)."""
    paired, unpaired, errors = await _read_pairs(files)
    # Parsing + SQLite writes are blocking; keep them off the event loop so a
    # slow or locked database can't stall /api/health or other requests.
    added, replaced, store_errors = await run_in_threadpool(_store_pairs, paired)
    lib = await run_in_threadpool(_library)
    return {"added": added, "replaced": replaced, "unpaired": unpaired, "errors": errors + store_errors, **lib}


class ManualRunRequest(BaseModel):
    name: str
    records: List[dict]             # [{Well?, Sample, Gene, Cp}]
    replaces: Optional[str] = None  # the manual run this plate was saved as (rename)


@router.post("/api/qpcr/library/manual")
def library_manual(body: ManualRunRequest):
    name = body.name.strip()
    if not name:
        return {"error": "Give the plate a name."}
    df = pd.DataFrame(body.records)
    if df.empty:
        return {"error": "No complete wells (each needs Gene + Sample + Cp)."}
    existing = qpcr_library.find_run(name)
    if existing and existing["source"] != "manual":
        return {"error": f"An imported run is already called \"{name}\" — choose another name for this plate."}
    if "Well" not in df.columns:
        df["Well"] = None
    df["Cp"] = pd.to_numeric(df["Cp"], errors="coerce")
    replaced = qpcr_library.save_run(name, "manual", df)
    # Saved under a new name: that's a rename — drop the old copy so the plate
    # isn't in the library (and ticked) twice.
    renamed_from = None
    old = (body.replaces or "").strip()
    if old and old != name:
        prev = qpcr_library.find_run(old)
        if prev and prev["source"] == "manual":
            qpcr_library.delete_run(prev["id"])
            renamed_from = old
    return {"replaced": replaced, "renamed_from": renamed_from, **_library()}


class DeleteRunRequest(BaseModel):
    run_id: int


@router.post("/api/qpcr/library/delete")
def library_delete(body: DeleteRunRequest):
    qpcr_library.delete_run(body.run_id)
    return _library()


# ── ΔΔCt analysis + stats ───────────────────────────────────────────────────

class AnalyzeRequest(BaseModel):
    pairs: List[dict] = []          # ad-hoc data: [{name, records:[{Sample,Gene,Cp}]}]
    run_ids: List[int] = []         # or library runs (used when pairs is empty)
    cp_max: Optional[float] = None  # exclude wells with Cp >= cp_max; None keeps all
    reference_genes: List[str]
    target_genes: List[str]
    control: str
    experimental: List[str]
    method: str = "auto"            # auto | ttest | anova
    best_of_three: bool = False     # gene x sample with >= 4 replicates: keep the 3 closest (see _best_of_three)


def _num(x) -> Optional[float]:
    """float, or None for NaN/inf — JSON has neither, and a test over a single
    replicate or zero variance produces them."""
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def _star(p: Optional[float], sig: float) -> str:
    """GraphPad Prism (GP) style: * P≤0.05, ** P≤0.01, *** P≤0.001, **** P≤0.0001.
    `sig` (α) only decides what counts as significant — a P above it is "ns" —
    so each asterisk count always means the same P range, as in Prism.
    A missing P (None) or a NaN one reads as "ns"."""
    if p is None or not (p <= sig and p <= 0.05):
        return "ns"
    if p <= 0.0001:
        return "****"
    if p <= 0.001:
        return "***"
    if p <= 0.01:
        return "**"
    return "*"


# ── Best of three ───────────────────────────────────────────────────────────
#
# Where a gene x sample has 4 or more replicates, keep the 3 closest values and
# leave the rest out. Two steps:
#   1. Reference genes, within each run, on Cp — before the run's reference Cp
#      is averaged (each run is normalised to its own plate).
#   2. Target genes, pooled across runs, on dCp — each well already
#      normalised to its own plate's reference genes for that sample, so plates
#      with an offset can be compared. With one run this is the 3 closest Cps.
#      (Reference genes are not trimmed again here: every reference well kept
#      in step 1 was used to normalise its plate.)
# "Closest" = the triple with the smallest range (max - min); ties go to the
# smallest SD, then to the earliest run and well, so the choice is repeatable.

_WELL_RE = re.compile(r"^\s*([A-Za-z]+)\s*0*(\d+)\s*$")


def _well_key(w) -> tuple:
    """Plate order for a well name: A1 < A2 < A10 < B1 < AA1. Other names
    sort after those (as text), missing wells last."""
    if w is None or (isinstance(w, float) and math.isnan(w)):
        return (2, 0, "", 0, "")
    m = _WELL_RE.match(str(w))
    if m:
        row = m.group(1).upper()
        return (0, len(row), row, int(m.group(2)), "")
    return (1, 0, "", 0, str(w))


def _closest_three(values: List[float], order: List[tuple]) -> List[int]:
    """Positions (into `values`) of the 3 values to keep. `order` gives each
    value's (run, well) sort key, used only to break exact ties."""
    n = len(values)
    if n <= 3:
        return list(range(n))
    idx = sorted(range(n), key=lambda i: order[i])
    if n <= 40:
        cands = itertools.combinations(idx, 3)
    else:   # the smallest range is always a window of 3 neighbours in value order
        by_v = sorted(idx, key=lambda i: (values[i], order[i]))
        cands = (tuple(sorted(by_v[k:k + 3], key=lambda i: order[i])) for k in range(n - 2))
    best = None
    for c in cands:
        v = [values[i] for i in c]
        key = (round(max(v) - min(v), 9), round(float(np.std(v, ddof=1)), 9), [order[i] for i in c])
        if best is None or key < best[0]:
            best = (key, c)
    return sorted(best[1])


def _pick_three(df: pd.DataFrame, value: str, by: List[str]) -> pd.Series:
    """Boolean mask over `df`: True for the rows kept by best of three within
    each `by` group (groups of 3 or fewer rows keep everything)."""
    keep = pd.Series(True, index=df.index)
    for _, grp in df.groupby(by, sort=False):
        if len(grp) <= 3:
            continue
        order = list(zip(grp["_run"], grp["Well"].map(_well_key) if "Well" in grp else [()] * len(grp), grp["_pos"]))
        kept = set(_closest_three(grp[value].tolist(), order))
        for i, ix in enumerate(grp.index):
            if i not in kept:
                keep[ix] = False
    return keep


def _complete_samples(ref: pd.DataFrame, refs: List[str]) -> set:
    """Samples for which every reference gene has at least one well."""
    n = ref.groupby("Sample")["Gene"].nunique()
    return set(n[n == len(refs)].index)


@router.post("/api/qpcr/analyze")
def analyze(body: AnalyzeRequest):
    refs = list(dict.fromkeys(body.reference_genes))
    if not refs:
        return {"error": "Choose at least one reference gene."}
    frames = []
    for p in body.pairs or qpcr_library.load_records(body.run_ids):
        df = pd.DataFrame(p.get("records") or [])
        if df.empty:
            continue
        df["Cp"] = pd.to_numeric(df["Cp"], errors="coerce")
        # Where each well came from (run order, row in the run): best of three
        # breaks ties with it and reports left-out wells by run. Dropped below.
        df["_run"], df["_runname"], df["_pos"] = len(frames), p.get("name", ""), range(len(df))
        measured = df.dropna(subset=["Cp"])          # undetermined wells
        kept = measured[measured["Cp"] < body.cp_max] if body.cp_max is not None else measured
        frames.append((p.get("name", ""), measured, kept))
    if not frames:
        return {"error": "No data."}

    keep_samples = [body.control] + body.experimental
    # Fold change for the reference genes too: with a single reference it is ~1
    # by construction, but the figure can show it on request. (Not tested.)
    fc_genes = list(dict.fromkeys(body.target_genes + refs))

    warnings = []
    combined = pd.DataFrame()
    left_out = []            # best of three: DataFrames of the wells left out
    trimmed_groups = set()   # (Gene, Sample) that had more than 3 replicates
    for run_name, measured, df in frames:
        ref_dropped = None
        if body.best_of_three:
            # Step 1: reference genes, within this run, on Cp.
            is_ref = df["Gene"].isin(refs)
            keep = _pick_three(df[is_ref], "Cp", ["Gene", "Sample"])
            if not keep.all():
                ref_dropped = df.loc[keep[~keep].index].copy()
                trimmed_groups.update(zip(ref_dropped["Gene"], ref_dropped["Sample"]))
                df = df.drop(index=ref_dropped.index)
        ref = df[df["Gene"].isin(refs)]
        # Normalise a sample only if EVERY reference gene was measured for it in
        # this run; pooling runs normalised to different reference sets gives a
        # false fold change.
        complete = _complete_samples(ref, refs)
        incomplete = sorted(s for s in set(df.loc[df["Gene"].isin(fc_genes), "Sample"]) - complete if s in keep_samples)
        if incomplete:
            measured_ok = _complete_samples(measured[measured["Gene"].isin(refs)], refs)
            by_limit = [s for s in incomplete if s in measured_ok]
            for group, why in (([s for s in incomplete if s not in measured_ok], "measured"),
                               (by_limit, f"below the Cp limit ({body.cp_max:g})" if body.cp_max is not None else "measured")):
                if group:
                    warnings.append(f"{run_name}: {', '.join(group)} left out — not every reference gene "
                                    f"({', '.join(refs)}) was {why} for {'it' if len(group) == 1 else 'them'} in this run.")
        # Reference Cp per sample = mean of the per-gene means, so a reference
        # gene that lost a replicate isn't under-weighted (a well-pooled mean
        # shifted the fold change whenever replicate counts differed).
        avg_ref = (ref[ref["Sample"].isin(complete)].groupby(["Sample", "Gene"])["Cp"].mean()
                   .groupby("Sample").mean().reset_index().rename(columns={"Cp": "Average_Ref_Cp"}))
        tar = df[df["Gene"].isin(fc_genes)]
        m = pd.merge(tar, avg_ref, on="Sample")
        m["dCp"] = m["Cp"] - m["Average_Ref_Cp"]
        combined = pd.concat([combined, m], ignore_index=True)
        if ref_dropped is not None:
            d = pd.merge(ref_dropped, avg_ref, on="Sample", how="left")
            d["dCp"] = d["Cp"] - d["Average_Ref_Cp"]
            d["Step"] = "reference"
            left_out.append(d)

    if body.best_of_three and not combined.empty:
        # Step 2: target genes, pooled across runs, on dCp. Reference genes were
        # trimmed in step 1 only: every reference well kept there normalised its
        # plate, so dropping it again here would misreport what was used.
        tgt = ~combined["Gene"].isin(refs)
        keep = _pick_three(combined[tgt], "dCp", ["Gene", "Sample"]).reindex(combined.index, fill_value=True).astype(bool)
        if not keep.all():
            d = combined[~keep].copy()
            d["Step"] = "replicates"
            left_out.append(d)
            trimmed_groups.update(zip(d["Gene"], d["Sample"]))
            combined = combined[keep].reset_index(drop=True)

    if combined.empty:
        return {"error": "No target/reference data after matching genes.", "warnings": warnings}
    if body.control not in set(combined["Sample"]):
        return {"error": f"The control sample {body.control} has no usable data (check the reference genes and the Cp limit).",
                "warnings": warnings}

    ctrl = combined[combined["Sample"] == body.control].groupby("Gene")["dCp"].mean().reset_index()
    ctrl = ctrl.rename(columns={"dCp": "Control_dCp"})
    combined = pd.merge(combined, ctrl, on="Gene")
    combined["ddCp"] = combined["dCp"] - combined["Control_dCp"]
    combined["Fold_Change"] = 2 ** (-combined["ddCp"])

    grouped = combined.groupby(["Sample", "Gene"])["Fold_Change"]
    combined["SD"] = grouped.transform("std")
    combined["SEM"] = grouped.transform(lambda x: np.std(x, ddof=1) / np.sqrt(len(x)) if len(x) > 1 else 0.0)

    final = combined[combined["Sample"].isin(keep_samples)].copy()
    present = set(final["Sample"])
    not_compared = [s for s in body.experimental if s not in present]
    if not_compared and len(not_compared) == len(body.experimental):
        return {"error": "None of the samples to compare has usable data (check the reference genes and the Cp limit).",
                "warnings": warnings}
    if not_compared:
        warnings.append(f"{', '.join(not_compared)} {'has' if len(not_compared) == 1 else 'have'} no usable data "
                        f"and {'is' if len(not_compared) == 1 else 'are'} not compared.")

    # stats — target genes only (a reference gene's fold change is ~1 by construction)
    n_groups = len(body.experimental) + 1
    do_ttest = body.method == "ttest" or (body.method == "auto" and n_groups == 2)
    do_anova = body.method == "anova" or (body.method == "auto" and n_groups > 2)

    ttest_results = []
    if do_ttest:
        for gene in body.target_genes:
            cvals = final[(final["Sample"] == body.control) & (final["Gene"] == gene)]["Fold_Change"]
            for exp in body.experimental:
                evals = final[(final["Sample"] == exp) & (final["Gene"] == gene)]["Fold_Change"]
                if not (len(cvals) and len(evals)):
                    continue
                # Welch's t needs >= 2 replicates per side; report the comparison either way.
                t = p = None
                if len(cvals) > 1 and len(evals) > 1:
                    t, p = (_num(v) for v in ttest_ind(cvals, evals, equal_var=False))
                    if t is None:  # zero variance on both sides: t is inf/NaN and scipy's p=0 means nothing
                        p = None
                ttest_results.append({"Gene": gene, "Control": body.control, "Experimental": exp,
                                      "n_control": int(len(cvals)), "n_experimental": int(len(evals)),
                                      "T_Statistic": t, "p_val": p})

    anova_tukey_results = []
    if do_anova:
        for gene in body.target_genes:
            sub = final[final["Gene"] == gene]
            if sub["Sample"].nunique() < 2:
                continue
            # No within-group variance anywhere (e.g. every well at the Cp cap, or
            # one well per sample): Tukey's P is 0 or NaN, which means nothing.
            if sub.groupby("Sample")["Fold_Change"].var(ddof=1).fillna(0).eq(0).all():
                means = sub.groupby("Sample")["Fold_Change"].mean()
                for g1, g2 in itertools.combinations(sorted(means.index), 2):
                    anova_tukey_results.append({"Gene": gene, "Group1": str(g1), "Group2": str(g2),
                                                "Mean_Diff": _num(means[g2] - means[g1]), "p_val": None,
                                                "Significant": False})
                continue
            try:
                tuk = pairwise_tukeyhsd(endog=sub["Fold_Change"], groups=sub["Sample"], alpha=0.05)
                # The summary table rounds p-adj to 4 dp (7.8e-05 -> 0.0001), which
                # would put P just above 0.0001 into "****"; use the exact values
                # (same row order as the summary).
                for row, p_exact in zip(tuk.summary().data[1:], tuk.pvalues):
                    g1, g2, md, padj, lo, hi, rej = row
                    anova_tukey_results.append({"Gene": gene, "Group1": str(g1), "Group2": str(g2),
                                                "Mean_Diff": _num(md), "p_val": _num(p_exact),
                                                "Significant": bool(rej)})
            except Exception:  # noqa: BLE001
                pass

    # per (Gene, Sample) summary for plotting
    summ = (final.groupby(["Gene", "Sample"])
            .agg(mean=("Fold_Change", "mean"), sd=("SD", "mean"), sem=("SEM", "mean"),
                 n=("Fold_Change", "size")).reset_index())

    per_well = final.drop(columns=[c for c in ("Average_Ref_Cp", "_run", "_pos") if c in final])
    if body.best_of_three:
        # Kept wells from several plates share well names: say which run each
        # came from, next to the well (as the left-out list does). Only with
        # best of three, so the output without it is unchanged.
        per_well = per_well.rename(columns={"_runname": "Run"})
        cols = [c for c in per_well.columns if c != "Run"]
        at = cols.index("Well") + 1 if "Well" in cols else 0
        per_well = per_well[cols[:at] + ["Run"] + cols[at:]]
    else:
        per_well = per_well.drop(columns=["_runname"])
    out = {
        "analysis_data": _records(per_well),
        "summary": _records(summ),
        "ttest_results": ttest_results,
        "anova_tukey_results": anova_tukey_results,
        "warnings": warnings,
    }
    if body.best_of_three:
        out.update(_best_of_three_report(left_out, trimmed_groups, keep_samples))
    return out


def _best_of_three_report(left_out: List[pd.DataFrame], groups: set, samples: List[str]) -> dict:
    """The wells best of three left out (for the samples in the analysis) and
    a one-line note saying how many."""
    keep = set(samples)
    rows = []
    for d in left_out:
        for r in d.to_dict("records"):
            if r["Sample"] not in keep:
                continue
            rows.append({"Gene": r["Gene"], "Sample": r["Sample"], "Run": r["_runname"],
                         "Well": None if pd.isna(r.get("Well")) else str(r.get("Well")),
                         "Cp": _num(r["Cp"]), "dCp": _num(r.get("dCp")), "Step": r["Step"],
                         "_k": (r["_run"], _well_key(r.get("Well")), r["_pos"])})
    rows.sort(key=lambda r: (r["Gene"], r["Sample"], r["_k"]))
    for r in rows:
        del r["_k"]
    n_groups = len({g for g in groups if g[1] in keep})
    if rows:
        note = (f"Best of three: {len(rows)} well{'s' if len(rows) != 1 else ''} left out "
                f"({n_groups} gene × sample group{'s' if n_groups != 1 else ''} had more than 3 replicates).")
    else:
        note = "Best of three: no gene × sample has more than 3 replicates, so no wells were left out."
    return {"excluded_wells": rows, "best_of_three_note": note}


# ── Plot (ggplot2 via the R bridge) ─────────────────────────────────────────

class PlotRequest(BaseModel):
    points: List[dict] = []                   # per-replicate [{Gene, Sample, value}]
    summary: List[dict] = []                  # fallback [{Gene,Sample,mean,sd,sem,n}]
    ttest_results: List[dict] = []
    anova_tukey_results: List[dict] = []
    gene_order: List[str]
    sample_order: List[str]
    colors: Dict[str, str] = {}               # sample -> hex
    labels: Dict[str, str] = {}               # sample -> legend label
    error_type: str = "SD"                    # SD | SEM
    layout: str = "grouped"                   # grouped (one graph, genes on x, dodged by sample) | faceted (one panel per gene)
    plot_type: str = "bar"                    # bar | violin | box | dot
    show_points: bool = False                 # overlay individual replicate points
    point_size: float = 1.8
    bar_width: float = 0.7
    theme: str = "prism"                      # prism | classic | minimal
    significance_level: float = 0.05
    hide_ns: bool = True
    brackets: str = "all"                     # all | control (only comparisons with the control = first sample)
    sample_labels: bool = False               # faceted: sample names under each panel (the legend names them otherwise)
    title: str = "Fold change per gene"
    xlabel: str = "Sample"
    ylabel: str = "Fold change"
    font_size: int = 14
    width: int = 1200
    height: int = 800
    dpi: int = 150
    export_format: str = "png"                 # png | tiff (publication export)
    transparent: bool = False                  # transparent background on export


def _resc(s: str) -> str:
    return (str(s).replace("\\", "\\\\").replace('"', '\\"')
            .replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t"))


def _r_vec(items: List[str]) -> str:
    return "c(" + ", ".join(f'"{_resc(i)}"' for i in items) + ")"


def _theme_layer(theme: str, font_size: float) -> str:
    fs = f"{float(font_size):.2f}"
    if theme == "classic":
        return f'p <- p + ggplot2::theme_classic(base_size={fs})\n'
    if theme == "minimal":
        return f'p <- p + ggplot2::theme_minimal(base_size={fs})\n'
    return (f'if (requireNamespace("ggprism", quietly=TRUE)) p <- p + ggprism::theme_prism(base_size={fs}) '
            f'else p <- p + ggplot2::theme_classic(base_size={fs})\n')


def _transparent_layer(transparent: bool) -> str:
    if not transparent:
        return ""
    return ("p <- p + ggplot2::theme(plot.background=ggplot2::element_rect(fill='transparent', colour=NA), "
            "panel.background=ggplot2::element_rect(fill='transparent', colour=NA), "
            "legend.background=ggplot2::element_rect(fill='transparent', colour=NA), "
            "legend.key=ggplot2::element_rect(fill='transparent', colour=NA))\n")


def _build_comparisons(body: PlotRequest):
    out = []
    rows = [(r["Gene"], r["Control"], r["Experimental"], r.get("p_val")) for r in body.ttest_results]
    rows += [(r["Gene"], r["Group1"], r["Group2"], r.get("p_val")) for r in body.anova_tukey_results]
    control = body.sample_order[0] if body.sample_order else None
    for gene, s1, s2, p in rows:
        if p is None:            # untestable (single replicate / zero variance) — draw nothing
            continue
        if body.brackets == "control" and control not in (s1, s2):
            continue
        st = _star(p, body.significance_level)
        if body.hide_ns and st == "ns":
            continue
        out.append((gene, s1, s2, p, st))
    return out


def _indexed(df: pd.DataFrame, genes: List[str], samples: List[str]) -> pd.DataFrame:
    """Swap Gene/Sample names for 1-based indices into `genes`/`samples` before
    the CSV goes to R: R's read.csv would turn a sample called "01" into 1 and
    one called "NA" into a missing value. R rebuilds the factors from the index."""
    gi = {g: i + 1 for i, g in enumerate(genes)}
    si = {s: i + 1 for i, s in enumerate(samples)}
    out = df.copy()
    out["gi"] = out.pop("Gene").map(gi)
    out["si"] = out.pop("Sample").map(si)
    return out


# ── Figure geometry (computed here so the R code stays presentational) ──────

_LABEL_BREAK = re.compile(r"(?<=[_\- /])")


def _wrap_label(s: str, width: int) -> str:
    """Wrap a sample name onto lines of at most `width` characters, breaking
    after "_", "-", "/" or spaces (a run longer than a line is hard-broken).
    Nothing is dropped, so the full name is always shown."""
    s = str(s)
    width = max(4, int(width))
    if len(s) <= width:
        return s
    toks: List[str] = []
    for t in _LABEL_BREAK.split(s):
        # A separator stays with the text before it ("20251210_" is not split
        # into "20251210" + a lone "_"): a line may run one character over.
        while len(t.rstrip("_-/ ")) > width:
            toks.append(t[:width])
            t = t[width:]
        if t:
            toks.append(t)
    lines: List[str] = []
    cur = ""
    for t in toks:
        if cur and len(cur) + len(t.rstrip("_-/ ")) > width:
            lines.append(cur)
            cur = t
        else:
            cur += t
    if cur:
        lines.append(cur)
    return "\n".join(ln.strip() for ln in lines if ln.strip())


def _shorten(s: str, width: int, head: Optional[int] = None) -> str:
    """`s` cut to `width` characters by dropping its middle ("start…end");
    `head` = characters kept at the start (default: half)."""
    if len(s) <= width:
        return s
    head = width // 2 if head is None else max(1, min(head, width - 1))
    tail = width - 1 - head
    return s[:head] + "…" + (s[len(s) - tail:] if tail > 0 else "")


def _shorten_all(names: List[str], width: int) -> List[str]:
    """_shorten for a set of names, moving the cut so that different names
    stay different where possible (the part that differs is often mid-name)."""
    for head in sorted(range(1, width), key=lambda h: abs(h - width // 2)):
        out = [_shorten(n, width, head) for n in names]
        if len(set(out)) == len(set(names)):
            return out
    return [_shorten(n, width) for n in names]


def _lines(s: str) -> List[str]:
    return str(s).split("\n")


def _bracket_levels(brackets: List[tuple], label_half: Optional[List[float]] = None) -> List[int]:
    """Stack level (1 = lowest) per bracket: within a gene, shorter brackets go
    lower and brackets that don't overlap share a level (Prism-like), instead
    of one level per comparison. brackets = [(gene, x1, x2, ...)];
    label_half = half the width of each bracket's star, in x units, so stars
    on one level don't run into each other."""
    levels = [0] * len(brackets)
    by_gene: Dict[str, List[int]] = {}
    for i, b in enumerate(brackets):
        by_gene.setdefault(b[0], []).append(i)
    for idx in by_gene.values():
        used: List[List[tuple]] = []        # per level: occupied [lo, hi] spans
        for i in sorted(idx, key=lambda i: (abs(brackets[i][2] - brackets[i][1]), min(brackets[i][1], brackets[i][2]))):
            lo, hi = sorted((brackets[i][1], brackets[i][2]))
            if label_half:
                mid = (lo + hi) / 2.0
                lo, hi = min(lo, mid - label_half[i]), max(hi, mid + label_half[i])
            for lv, spans in enumerate(used):
                # touching ends would merge two brackets into one line: keep a gap
                if all(hi < a - 1e-6 or lo > b + 1e-6 for a, b in spans):
                    spans.append((lo, hi))
                    levels[i] = lv + 1
                    break
            else:
                used.append([(lo, hi)])
                levels[i] = len(used)
    return levels


class _Px:
    """Rough text metrics in device pixels (bold sans), for layout decisions."""

    def __init__(self, dpi: int):
        self.ppt = dpi / 72.0

    def char(self, pt: float) -> float:
        return 0.6 * pt * self.ppt

    def line(self, pt: float) -> float:
        return 1.2 * pt * self.ppt

    def text_w(self, s: str, pt: float) -> float:
        return max(len(ln) for ln in _lines(s)) * self.char(pt)


def _legend_box(labels: List[str], wrap: int, ncol: int, pt: float, px: _Px):
    """Wrapped labels and the (width, height) in px of a legend with `ncol` columns."""
    wrapped = [_wrap_label(lb, wrap) for lb in labels]
    key = 1.15 * pt * px.ppt
    ew = key + 0.5 * pt * px.ppt + max(px.text_w(w, pt) for w in wrapped) + 1.0 * pt * px.ppt
    # Wrapped entries get a gap between them (_legend_layer), so the lines of
    # one name don't run into the next.
    gap = _LEGEND_GAP * pt * px.ppt if any("\n" in w for w in wrapped) else 0.35 * pt * px.ppt
    eh = max(key, max(len(_lines(w)) for w in wrapped) * px.line(pt)) + gap
    nrow = math.ceil(len(labels) / ncol)
    return wrapped, ncol * ew + 10, nrow * eh + 10


def _choose_grid(n: int, w: float, h: float, n_samples: int, strip: float, xaxis, yaxis: float,
                 sp_x: float, sp_y: float, min_pw: float = 0.0, min_ph: float = 0.0):
    """(ncol, nrow, panel_w, panel_h): the grid whose panels are closest to a
    pleasant aspect ratio (wider when a panel holds more samples). `xaxis` is
    the height of the x axis, or a function of the panel width returning
    (height, penalty) — sample names wrap differently in narrow panels. With a
    free y but shared x scale, facet_wrap draws the x axis once, under the
    bottom panel of each column, so it costs its height once, not per row.
    Panels narrower than `min_pw` (the gene name) or shorter than `min_ph`
    (room for the significance brackets) are penalised."""
    target = min(1.6, max(0.95, 0.85 + 0.09 * n_samples))
    best = None
    for ncol in range(1, n + 1):
        nrow = math.ceil(n / ncol)
        if (nrow - 1) * ncol >= n:            # a wholly empty row
            continue
        pw = (w - ncol * yaxis - (ncol - 1) * sp_x) / ncol
        xa, penalty = xaxis(pw) if callable(xaxis) else (xaxis, 0.0)
        ph = (h - nrow * strip - xa - (nrow - 1) * sp_y) / nrow
        if pw <= 10 or ph <= 10:
            continue
        score = abs(math.log((pw / ph) / target)) + 0.05 * (nrow * ncol - n) + penalty
        if pw < min_pw:
            score += 1.0 + 2.0 * (min_pw / pw - 1)
        if ph < min_ph:
            score += 5.0 * (min_ph / ph - 1)   # strongly: else brackets get left out
        if best is None or score < best[0]:
            best = (score, ncol, nrow, pw, ph)
    if best is None:                          # absurdly small figure: one row
        return n, 1, max(10.0, w / n), max(10.0, h)
    return best[1], best[2], best[3], best[4]


# Significance brackets: a level is 0.85 star heights, plus a gap below the
# lowest and the star above the highest; together at most _BRACKET_FMAX of a
# panel's height (the data keep the rest). Stars shrink to _STAR_MIN of their
# size (not below _STAR_MIN_PT) before brackets that still don't fit are left out.
_BRACKET_FMAX = 0.72
_STAR_MIN = 0.5
_STAR_MIN_PT = 6.0


def _bracket_need(levels: int, star_px: float) -> float:
    """Height (px) that `levels` stacked brackets with their stars take."""
    return (0.4 + 0.85 * max(0, levels - 1) + 0.75) * star_px


def _fit_strip(genes: List[str], pw: float, fs: float, px: _Px):
    """Gene names for the panel titles, wrapped at spaces / separators to the
    panel width, and the font size (shrunk, down to 65%, when one word is still
    too wide). Returns (labels, pt, lines)."""
    pt = fs
    names = [str(g) for g in genes] or [""]
    # A word is never split ("BIGLY/CAN"): the font shrinks instead, and a word
    # still too wide at 65% runs a little into the gap beside its panel.
    longest_word = max(len(t.strip(" _-/")) for g in names for t in _LABEL_BREAK.split(g) or [g])
    for _ in range(8):
        chars = max(4, int(pw * 0.96 / px.char(pt)))
        if longest_word <= chars or pt <= fs * 0.65 + 1e-6:
            break
        pt = max(fs * 0.65, pt * 0.9)
    width = max(chars, longest_word)
    wrapped = [_wrap_label(g, width) if len(g) > width else g for g in names]
    lines = max(len(_lines(w)) for w in wrapped)
    return wrapped, pt, lines


def _facet_layout(n: int, labels: List[str], body: PlotRequest, n_levels: int = 0) -> dict:
    """Grid, font scale, legend placement and label wrapping for the panel-per-
    gene figure, from the panel count, the samples, the figure size and how
    many significance-bracket levels a panel must hold (`n_levels`)."""
    px = _Px(body.dpi)
    W, H = float(body.width), float(body.height)
    S = max(1, len(labels))
    fs0 = float(body.font_size)
    genes = [str(g) for g in body.gene_order]

    def frame(fs: float):
        has_title, has_x = bool(body.title.strip()), bool(body.xlabel.strip())
        top = (px.line(fs * 1.25) + 0.6 * fs * px.ppt) if has_title else 0.5 * fs * px.ppt
        left = (px.line(fs) + 0.4 * fs * px.ppt) if body.ylabel.strip() else 0.3 * fs * px.ppt
        bottom = (px.line(fs) + 0.4 * fs * px.ppt) if has_x else 0.3 * fs * px.ppt
        return W - left - 0.6 * fs * px.ppt, H - top - bottom

    def parts(fs: float):
        strip = px.line(fs) + 0.5 * fs * px.ppt
        yaxis = 4.2 * px.char(fs * 0.85) + 0.5 * fs * px.ppt
        return strip, yaxis, 1.1 * fs * px.ppt, 0.5 * fs * px.ppt   # strip, y axis, spacing x, spacing y

    def name_w(fs: float) -> float:
        """Width a gene title wants: the longest name, but one very long name
        is wrapped / shrunk rather than forcing a grid of narrow columns."""
        ws = sorted(px.text_w(g, fs) for g in genes) or [0.0]
        return min(ws[-1], 1.5 * ws[len(ws) // 2]) * 1.05 + 0.6 * fs * px.ppt

    def bracket_ph(fs: float) -> float:
        """Panel height the brackets need at the smallest star size."""
        if n_levels <= 0:
            return 0.0
        star_px = max(_STAR_MIN_PT, _STAR_MIN * fs * 1.15) * px.ppt
        return _bracket_need(n_levels, star_px) / _BRACKET_FMAX

    # Font scale from a first guess at the panel size: a 12-panel figure at
    # 1200 x 800 px keeps readable (not oversized) text; a physically small
    # figure (high dpi, few pixels) scales further down, to about 5 pt.
    fw, fh = frame(fs0)
    strip, yaxis, spx, spy = parts(fs0)
    _, _, pw0, ph0 = _choose_grid(n, fw * 0.85, fh, S, strip, 0.3 * fs0 * px.ppt, yaxis, spx, spy, name_w(fs0))
    cell_in = math.sqrt(max(1.0, pw0) * max(1.0, ph0)) / body.dpi
    k = min(1.0, max(0.42, 0.45 + 0.32 * cell_in))
    fs = min(fs0, max(5.0, fs0 * k))
    k = fs / fs0
    fw, fh = frame(fs)
    strip, yaxis, spx, spy = parts(fs)
    leg_pt = fs * 0.9
    tick_pt = fs * 0.85
    min_pw = name_w(fs)
    min_ph = bracket_ph(fs)

    def x_labels(pw: float):
        """(wrapped sample names, rotated 90°?, axis height px, font pt, fits?)
        for the names under the panels — None when they are off (the legend
        names the samples). Horizontal and wrapped when the slots are wide
        enough (more lines allowed with few samples); otherwise vertical,
        wrapped onto as many lines as a slot can hold, so neighbouring names
        never overlap (45° names run into the next one)."""
        if not body.sample_labels:
            return None, False, 0.3 * fs * px.ppt, tick_pt, True
        slot = pw / (S + 0.2)                     # the discrete scale pads 0.6 slot each side
        budget = (0.2 if n_levels > 3 else 0.3) * H   # at most this tall (less when brackets need the room)
        pad = 0.6 * fs * px.ppt
        max_h_lines = 5 if S <= 3 else 3
        longest = max(len(str(lb)) for lb in labels)
        for tp in (tick_pt, tick_pt * 0.85, tick_pt * 0.72):
            chars = int(slot * 0.92 / px.char(tp))
            if chars >= min(5, longest):          # short names ("A", "WT") need less
                # wrapped one short of the slot: a separator may run one over
                wrapped = [str(lb) if len(str(lb)) <= chars else _wrap_label(lb, chars - 1) for lb in labels]
                n_lines = max(len(_lines(w)) for w in wrapped)
                height = n_lines * px.line(tp) + pad
                if n_lines <= max_h_lines and height <= budget:
                    return wrapped, False, height, tp, True
            # n lines at lineheight 0.9 stack to about (1 + 0.9 (n - 1)) x the font size
            max_lines = int((slot * 0.95 / (tp * px.ppt) - 1) / 0.9) + 1 if slot * 0.95 >= tp * px.ppt else 0
            if max_lines >= 1:
                longest = max(len(str(lb)) for lb in labels)
                for width in range(8, max(9, longest + 1)):
                    wrapped = [_wrap_label(lb, width) for lb in labels]
                    if max(len(_lines(w)) for w in wrapped) <= max_lines:
                        break
                height = max(px.text_w(w, tp) for w in wrapped) + pad
                if height <= budget:
                    return wrapped, True, height, tp, True
        # Doesn't fit: the smallest font, vertical, one line per name, long
        # names shortened in the middle to the height budget — the legend
        # still names every sample in full. (Wrapped names would overlap.)
        tp = tick_pt * 0.72
        chars = max(6, int((budget - pad) / px.char(tp)))
        short = _shorten_all([str(lb) for lb in labels], chars)
        return short, True, max(px.text_w(w, tp) for w in short) + pad, tp, False

    def grid(w: float, h: float):
        def xaxis(pw: float):
            xl = x_labels(pw)
            return xl[2], 0.0 if xl[4] else 2.0
        g = _choose_grid(n, w, h, S, strip, xaxis, yaxis, spx, spy, min_pw, min_ph)
        xl, ang, xa, tp, fits = x_labels(g[2])
        return g, xl, ang, xa, tp, fits

    def score(g, fits: bool = True) -> float:
        """Bigger panels are better; panels too short for their brackets, or
        sample names that run into each other, much less so."""
        pw, ph = g[2], g[3]
        return pw * ph * (min(1.0, ph / min_ph) ** 2 if min_ph else 1.0) * (1.0 if fits else 0.25)

    options = []
    # 1) In the empty cells of the last row — costs no space at all. (Not with
    # sample names on: the columns beside the gap draw theirs into it.)
    g, xl, ang, xa, tp, fits = grid(fw, fh)
    ncol, nrow, pw, ph = g
    empty = ncol * nrow - n
    if empty > 0 and not body.sample_labels:
        reg_w = empty * (pw + yaxis + spx) - spx
        reg_h = ph + strip + xa
        for wrap in (22, 18, 15, 12):
            lcols = max(1, min(S, int(reg_w * 0.95 // max(1.0, _legend_box(labels, wrap, 1, leg_pt, px)[1]))))
            wrapped, lw, lh = _legend_box(labels, wrap, lcols, leg_pt, px)
            if lw <= reg_w * 0.98 and lh <= reg_h * 0.95:
                options.append(dict(pos="inside", wrapped=wrapped, lcols=lcols, grid=g, xl=xl, ang=ang, xa=xa, tp=tp,
                                    inside=(1 - empty / (2.0 * ncol), 0.5 / nrow), score=score(g, fits) * 1.15))
                break
    # 2) Right: one column of wrapped labels (two if very tall).
    for wrap in (20, 16, 13):
        for lcols in (1, 2):
            wrapped, lw, lh = _legend_box(labels, wrap, lcols, leg_pt, px)
            if lh <= fh * 0.92 and lw <= W * 0.3:
                g2 = grid(fw - lw, fh)
                options.append(dict(pos="right", wrapped=wrapped, lcols=lcols, grid=g2[0], xl=g2[1], ang=g2[2],
                                    xa=g2[3], tp=g2[4], score=score(g2[0], g2[5])))
                break
        else:
            continue
        break
    # 3) Bottom: as many columns as fit across the figure.
    for wrap in (24, 18, 14):
        one = _legend_box(labels, wrap, 1, leg_pt, px)[1]
        lcols = max(1, min(S, int((W * 0.96) // max(1.0, one))))
        wrapped, lw, lh = _legend_box(labels, wrap, lcols, leg_pt, px)
        if lh <= fh * 0.3 or wrap == 14:
            g3 = grid(fw, fh - lh)
            options.append(dict(pos="bottom", wrapped=wrapped, lcols=lcols, grid=g3[0], xl=g3[1], ang=g3[2],
                                xa=g3[3], tp=g3[4], score=score(g3[0], g3[5])))
            break
    best = max(options, key=lambda o: o["score"])
    ncol, nrow, pw, ph = best["grid"]
    # Gene titles: wrapped / shrunk to the panel width. Extra title lines come
    # out of the panel height.
    strip_labels, strip_pt, strip_lines = _fit_strip(genes, pw, fs, px)
    ph -= (strip_lines - 1) * px.line(strip_pt) + (strip_pt - fs) * 1.2 * px.ppt
    # Fewer y ticks in short panels, so their labels don't run together.
    ph_pt = ph / px.ppt
    y_breaks = 4 if ph_pt >= 7 * tick_pt else 3     # n=2 can leave a panel with one label
    return dict(fs=fs, k=k, ncol=ncol, nrow=nrow, panel_h=max(20.0, ph), panel_w=max(20.0, pw), legend=best, tick_pt=tick_pt,
                leg_pt=leg_pt, spx=spx / px.ppt, spy=spy / px.ppt, strip_labels=strip_labels, strip_pt=strip_pt,
                y_breaks=y_breaks)


def _grouped_legend(labels: List[str], body: PlotRequest) -> dict:
    """Legend for the single graph: on the right as before, with long sample
    names wrapped; below the graph when even wrapped they'd take too much width."""
    px = _Px(body.dpi)
    pt = float(body.font_size) * 0.9
    W, H = float(body.width), float(body.height)
    if max((len(str(lb)) for lb in labels), default=0) <= 24:   # short names: the legend as it always was
        return dict(pos="right", wrapped=[str(lb) for lb in labels], lcols=1)
    for wrap in (24, 20, 16):
        wrapped, lw, lh = _legend_box(labels, wrap, 1, pt, px)
        if lw <= W * 0.3 and lh <= H * 0.8:
            return dict(pos="right", wrapped=wrapped, lcols=1)
    for wrap in (24, 18):
        one = _legend_box(labels, wrap, 1, pt, px)[1]
        lcols = max(1, min(len(labels), int((W * 0.96) // max(1.0, one))))
        wrapped, lw, lh = _legend_box(labels, wrap, lcols, pt, px)
        if lh <= H * 0.3:
            break
    return dict(pos="bottom", wrapped=wrapped, lcols=lcols)


_LEGEND_GAP = 0.6   # space between wrapped legend entries, in units of the legend font size


def _legend_layer(leg: dict, text_pt: Optional[float], key_pt: Optional[float], override: str = "",
                  base_pt: Optional[float] = None) -> str:
    """Legend position/columns as ggplot code. An 'inside' legend needs
    ggplot2 >= 3.5 (legend.position.inside); older versions put it below.
    `override` = extra guide_legend() arguments (e.g. bigger dot-plot keys).
    When a name is wrapped, entries get a gap between them (`base_pt` = the
    legend font size when `text_pt` isn't set)."""
    guide = (f'p <- p + ggplot2::guides(fill=ggplot2::guide_legend(ncol={int(leg["lcols"])}, byrow=TRUE{override}))\n')
    size = f"size={text_pt:.2f}, " if text_pt else ""
    key = f'legend.key.size=ggplot2::unit({key_pt:.2f}, "pt"), ' if key_pt else ""
    gap_pt = _LEGEND_GAP * float(text_pt or base_pt or 11.0)
    # ggplot2 >= 3.5 spaces keys with legend.key.spacing.y; older versions only
    # through the text margins.
    spaced = any("\n" in str(w) for w in leg.get("wrapped", []))
    spacing = ('if (utils::packageVersion("ggplot2") >= "3.5.0") p <- p + ggplot2::theme('
               f'legend.key.spacing.y=ggplot2::unit({gap_pt:.2f}, "pt")) '
               'else p <- p + ggplot2::theme(legend.text=ggplot2::element_text('
               f'margin=ggplot2::margin(t={gap_pt / 2:.2f}, b={gap_pt / 2:.2f}, l={0.4 * gap_pt:.2f})))\n') if spaced else ""
    style = (f'p <- p + ggplot2::theme(legend.text=ggplot2::element_text({size}lineheight=0.9), '
             f'{key}legend.title=ggplot2::element_blank())\n'
             'if (utils::packageVersion("ggplot2") >= "3.5.0") p <- p + ggplot2::theme(legend.key.justification="left")\n'
             + spacing)
    if leg["pos"] == "inside":
        x, y = leg["inside"]
        pos = ('if (utils::packageVersion("ggplot2") >= "3.5.0") p <- p + ggplot2::theme(legend.position="inside", '
               f'legend.position.inside=c({x:.4f}, {y:.4f}), legend.justification.inside=c(0.5, 0.5)) '
               'else p <- p + ggplot2::theme(legend.position="bottom")\n')
    else:
        pos = f'p <- p + ggplot2::theme(legend.position="{leg["pos"]}")\n'
    return guide + style + pos


@router.post("/api/qpcr/plot")
def plot(body: PlotRequest):
    # Per-replicate points drive the plot (needed for points/violin/box); the
    # summary (mean/err) for bars + brackets is computed in R from them.
    pts = pd.DataFrame(body.points)
    if pts.empty and body.summary:
        s = pd.DataFrame(body.summary)
        pts = s[["Gene", "Sample"]].copy()
        pts["value"] = s["mean"]
    if pts.empty or "value" not in pts.columns:
        return {"success": False, "stderr": "No per-replicate data to plot.", "plots": []}
    pts = pts[["Gene", "Sample", "value"]].dropna()
    # Only what was asked for: analyze also returns reference-gene rows, which
    # must not appear unless they are in gene_order.
    pts = pts[pts["Gene"].isin(body.gene_order) & pts["Sample"].isin(body.sample_order)]
    if pts.empty:
        return {"success": False, "stderr": "No data for the selected genes and samples.", "plots": []}

    sample_idx = {s: i + 1 for i, s in enumerate(body.sample_order)}
    gene_idx = {g: i + 1 for i, g in enumerate(body.gene_order)}
    n_samples = max(1, len(body.sample_order))

    colors = [body.colors.get(s, "#888888") for s in body.sample_order]
    labels = [body.labels.get(s, s) for s in body.sample_order]
    export_fmt = "tiff" if str(body.export_format).lower() in ("tiff", "tif") else "png"
    bg = "transparent" if body.transparent else "white"
    ptype = body.plot_type if body.plot_type in ("bar", "violin", "box", "dot") else "bar"
    faceted = str(body.layout).lower() == "faceted"
    bw = min(1.0, max(0.05, float(body.bar_width)))
    show_pts = body.show_points or ptype == "dot"
    angle = 'p <- p + ggplot2::theme(axis.text.x=ggplot2::element_text(angle=45, hjust=1, vjust=1))\n'
    px = _Px(body.dpi)
    # Dot plots: the legend shows the (coloured) points; make its keys readable.
    key_override = f", override.aes=list(size={max(2.5, float(body.point_size) * 1.3):.2f})" if ptype == "dot" else ""

    comps = _build_comparisons(body)
    # Violins need 2+ values; a single replicate is drawn as a point instead.
    violin_single = ('.vd <- dat %>% dplyr::group_by(Gene, Sample) %>% dplyr::filter(dplyr::n() >= 2) %>% dplyr::ungroup()\n'
                     '.v1 <- dat %>% dplyr::group_by(Gene, Sample) %>% dplyr::filter(dplyr::n() < 2) %>% dplyr::ungroup()\n')
    single_pt = f'size={max(2.2, float(body.point_size) * 1.5):.2f}, shape=23, colour="black", stroke=0.4, show.legend=FALSE'

    if faceted:
        n_panels = len([g for g in body.gene_order if g in set(pts["Gene"])])
        # How high the brackets stack (before star widths are known), so the
        # layout leaves panels tall enough for them.
        est = [(cg, sample_idx[s1], sample_idx[s2]) for (cg, s1, s2, _p, _st) in comps
               if cg in gene_idx and s1 in sample_idx and s2 in sample_idx]
        fl = _facet_layout(max(1, n_panels), labels, body, max(_bracket_levels(est), default=0))
        fs = fl["fs"]
        leg = fl["legend"]
        legend_labels = leg["wrapped"]
        star_pt = fs * 1.15
        panel_h = fl["panel_h"]
        # One panel per gene; the x-axis inside each panel is Sample. drop=FALSE
        # keeps every sample's slot so bracket positions (sample index) hold.
        if ptype == "bar":
            geom = (f'p <- p + ggplot2::geom_col(data=summ, ggplot2::aes(Sample, mean, fill=Sample), width={bw}, colour="black", linewidth=0.3) + '
                    'ggplot2::geom_errorbar(data=summ, ggplot2::aes(Sample, ymin=pmax(0, mean-err), ymax=mean+err), width=0.25, linewidth=0.4)\n')
        elif ptype == "violin":
            geom = (violin_single +
                    f'p <- p + ggplot2::geom_violin(data=.vd, ggplot2::aes(Sample, value, fill=Sample), width={max(bw, 0.5)}, trim=FALSE, colour="black", linewidth=0.3, alpha=0.85)\n'
                    f'if (nrow(.v1) > 0) p <- p + ggplot2::geom_point(data=.v1, ggplot2::aes(Sample, value, fill=Sample), {single_pt})\n')
        elif ptype == "box":
            geom = f'p <- p + ggplot2::geom_boxplot(data=dat, ggplot2::aes(Sample, value, fill=Sample), width={bw}, outlier.shape=NA, colour="black", linewidth=0.3, alpha=0.85)\n'
        else:  # dot (flat crossbar at the mean)
            geom = f'p <- p + ggplot2::geom_crossbar(data=summ, ggplot2::aes(Sample, y=mean, ymin=mean, ymax=mean), width={min(0.8, bw)}, linewidth=0.4, colour="black")\n'
        # Dot plots colour the points by sample (they are the only thing that
        # carries the colour); over bars/boxes/violins the points stay white.
        pfill = "fill=Sample" if ptype == "dot" else ""
        pconst = "" if ptype == "dot" else 'fill="white", '
        points_layer = (
            f'p <- p + ggplot2::geom_point(data=dat, ggplot2::aes(Sample, value{", " + pfill if pfill else ""}), position=ggplot2::position_jitter(width={0.18 * bw:.3f}, height=0, seed=1), size={body.point_size}, shape=21, {pconst}colour="black", stroke=0.4)\n'
            if show_pts else ""
        )
        xl = fl["legend"]["xl"]
        x_scale = (f'ggplot2::scale_x_discrete(drop=FALSE, labels={_r_vec(xl)})' if xl
                   else 'ggplot2::scale_x_discrete(drop=FALSE)')
        # Fold change is never negative: start the axis at 0 (flush for bars /
        # dots); few, clean ticks per panel ("2.5", not "2.50").
        # Violins and boxes show a distribution: their axis fits the data.
        zero = ptype in ("bar", "dot")
        lo = "0" if zero else "0.04"
        # Gene titles wrapped / shrunk to the panel width (by index, like the data).
        strip = _r_vec(fl["strip_labels"])
        layout_layer = (
            f'.strip <- {strip}; names(.strip) <- .genes\n'
            f'p <- p + ggplot2::facet_wrap(~Gene, scales="free_y", ncol={fl["ncol"]}, labeller=ggplot2::as_labeller(.strip)) + {x_scale} + '
            f'ggplot2::scale_y_continuous(expand=ggplot2::expansion(mult=c({lo}, 0.04)), breaks=scales::breaks_extended(n={fl["y_breaks"]}), labels=.num)'
            + (' + ggplot2::expand_limits(y=0)\n' if zero else '\n')
        )
        if not xl:
            x_text = 'axis.text.x=ggplot2::element_blank(), axis.ticks.x=ggplot2::element_blank()'
        elif fl["legend"]["ang"]:
            x_text = f'axis.text.x=ggplot2::element_text(size={fl["legend"]["tp"]:.2f}, angle=90, hjust=1, vjust=0.5, lineheight=0.9)'
        else:
            x_text = f'axis.text.x=ggplot2::element_text(size={fl["legend"]["tp"]:.2f}, lineheight=0.9)'
        xangle_layer = (
            'p <- p + ggplot2::theme('
            f'plot.title=ggplot2::element_text(size={fs * 1.25:.2f}, face="bold", hjust=0.5), '
            f'axis.title=ggplot2::element_text(size={fs:.2f}), '
            f'axis.text.y=ggplot2::element_text(size={fl["tick_pt"]:.2f}), {x_text}, '
            'strip.background=ggplot2::element_blank(), '
            f'strip.text=ggplot2::element_text(size={fl["strip_pt"]:.2f}, face="bold", lineheight=0.9, margin=ggplot2::margin(b={0.35 * fs:.1f})), '
            f'panel.spacing.x=ggplot2::unit({fl["spx"]:.1f}, "pt"), panel.spacing.y=ggplot2::unit({fl["spy"]:.1f}, "pt"))\n'
        ) + _legend_layer(leg, fl["leg_pt"], fl["leg_pt"] * 1.15, key_override)
        theme_fs = fs
    else:
        star_pt = max(2, body.font_size // 3) * 2.845
        gl = _grouped_legend(labels, body)
        legend_labels = gl["wrapped"]
        # Single graph: genes on the x-axis, one fixed lane per sample. Every
        # layer is drawn at the lane centre xp — the same position _dx() gives
        # the brackets — so a gene missing a sample leaves a gap rather than
        # shifting bars/points under the wrong significance star (position
        # dodges re-pack per gene and disagree with each other).
        # position="identity" everywhere: geom_boxplot otherwise defaults to
        # dodge2, which re-packs touching boxes off their lanes.
        if ptype == "bar":
            geom = ('p <- p + ggplot2::geom_col(data=summ, ggplot2::aes(xp, mean, fill=Sample), position="identity", width=.w, colour="black", linewidth=0.3) + '
                    'ggplot2::geom_errorbar(data=summ, ggplot2::aes(xp, ymin=pmax(0, mean-err), ymax=mean+err), position="identity", width=.w * 0.35, linewidth=0.4)\n')
        elif ptype == "violin":
            geom = (violin_single +
                    'p <- p + ggplot2::geom_violin(data=.vd, ggplot2::aes(xp, value, fill=Sample, group=interaction(Gene, Sample)), position="identity", width=.w, trim=FALSE, colour="black", linewidth=0.3, alpha=0.85)\n'
                    f'if (nrow(.v1) > 0) p <- p + ggplot2::geom_point(data=.v1, ggplot2::aes(xp, value, fill=Sample), {single_pt})\n')
        elif ptype == "box":
            geom = 'p <- p + ggplot2::geom_boxplot(data=dat, ggplot2::aes(xp, value, fill=Sample, group=interaction(Gene, Sample)), position="identity", width=.w, outlier.shape=NA, colour="black", linewidth=0.3, alpha=0.85)\n'
        else:  # dot (flat crossbar at the mean)
            geom = 'p <- p + ggplot2::geom_crossbar(data=summ, ggplot2::aes(xp, y=mean, ymin=mean, ymax=mean), position="identity", width=.w * 0.9, linewidth=0.4, colour="black")\n'
        pfill = ", fill=Sample" if ptype == "dot" else ""
        pconst = "" if ptype == "dot" else 'fill="white", '
        points_layer = (
            f'p <- p + ggplot2::geom_point(data=dat, ggplot2::aes(xp, value{pfill}), position=ggplot2::position_jitter(width=.w * 0.22, height=0, seed=1), size={body.point_size}, shape=21, {pconst}colour="black", stroke=0.4)\n'
            if show_pts else ""
        )
        layout_layer = ('p <- p + ggplot2::scale_x_continuous(breaks=seq_along(.genes), labels=.genes, expand=c(0, 0)) + '
                        'ggplot2::coord_cartesian(xlim=c(0.5, length(.genes) + 0.5))\n')
        # The legend keeps the theme's look; only wrapped / moved legends change.
        restyle = gl["pos"] != "right" or any("\n" in w for w in legend_labels)
        xangle_layer = (angle if len(body.gene_order) > 8 else "") + (
            _legend_layer(gl, None, None, key_override, base_pt=body.font_size * 0.9) if restyle else
            f'p <- p + ggplot2::guides(fill=ggplot2::guide_legend({key_override.lstrip(", ")}))\n' if key_override else "")
        # The plotting area, roughly: what's left of the figure after the
        # title, the gene labels and a bottom legend.
        panel_h = float(body.height) * (0.62 if len(body.gene_order) > 8 else 0.72)
        theme_fs = body.font_size

    theme_layer = _theme_layer(body.theme, theme_fs)
    transparent_theme = _transparent_layer(body.transparent)

    # Significance brackets. Faceted layout uses integer Sample positions within
    # each panel; grouped layout uses the lane centres: gene g (1-based) with S
    # samples places sample j (1-based) at g + bw*((2j-1-S)/(2S)), exactly the
    # xp computed in R.
    notes: List[str] = []
    if faceted:
        brackets = [(cg, sample_idx[s1], sample_idx[s2], star)
                    for (cg, s1, s2, _p, star) in comps
                    if cg in gene_idx and s1 in sample_idx and s2 in sample_idx]
    else:
        def _dx(gi: int, j: int) -> float:
            return round(gi + bw * ((2 * j - 1 - n_samples) / (2.0 * n_samples)), 5)
        brackets = [(cg, _dx(gene_idx[cg], sample_idx[s1]), _dx(gene_idx[cg], sample_idx[s2]), star)
                    for (cg, s1, s2, _p, star) in comps
                    if cg in gene_idx and s1 in sample_idx and s2 in sample_idx]

    if brackets:
        # Star widths in x units (faceted: S slots plus the discrete scale's
        # 0.6 padding each side; grouped: one unit per gene).
        if faceted:
            unit_px = max(1.0, fl["panel_w"]) / (n_samples + 0.2)
        else:
            unit_px = float(body.width) * (0.62 if gl["pos"] == "right" else 0.85) / max(1, len(body.gene_order))
        half = [0.5 * (len(b[3]) * 0.5 + 0.3) * star_pt * px.ppt / unit_px for b in brackets]
        levels = _bracket_levels(brackets, half)
        # Vertical geometry as fractions of the panel height, so a bracket
        # level is always a little taller than its star whatever the panel's
        # y range: R puts the top of the axis at D = top / (1 - space needed).
        # Too many levels for the panel height: smaller stars (down to
        # _STAR_MIN) first; brackets that still don't fit are left out (and
        # the figure says so) rather than squeezed until the stars overlap.
        n_lv = max(levels)
        room = _BRACKET_FMAX * panel_h
        need = _bracket_need(n_lv, star_pt * px.ppt)
        if need > room:
            floor_pt = min(star_pt, max(_STAR_MIN_PT, _STAR_MIN * star_pt))
            star_pt = max(floor_pt, star_pt * room / need)
        star_px = star_pt * px.ppt
        cap = max(1, int((room - _bracket_need(1, star_px)) / (0.85 * star_px) + 1e-9) + 1)
        if n_lv > cap:
            keep = [lv <= cap for lv in levels]
            dropped = sorted({b[0] for b, k in zip(brackets, keep) if not k}, key=lambda g: gene_idx[g])
            n_drop = keep.count(False)
            brackets = [b for b, k in zip(brackets, keep) if k]
            levels = [lv for lv, k in zip(levels, keep) if k]
            more = (" Choose “Vs control only”, or make the figure taller." if body.brackets != "control"
                    else " Make the figure taller, or use fewer panels.")
            notes.append(f"{n_drop} significance bracket{'s' if n_drop != 1 else ''} didn't fit and "
                         f"{'are' if n_drop != 1 else 'is'} not drawn ({', '.join(map(str, dropped))}).{more} "
                         "All results are in the Results tab.")
        frac = lambda v: max(0.0, v / max(20.0, panel_h))  # noqa: E731
        gap_f, step_f, txt_f, tick_f = frac(0.4 * star_px), frac(0.85 * star_px), frac(0.75 * star_px), frac(0.2 * star_px)
        bgi = "c(" + ", ".join(str(gene_idx[b[0]]) for b in brackets) + ")"
        bx1 = "c(" + ", ".join(str(b[1]) for b in brackets) + ")"
        bx2 = "c(" + ", ".join(str(b[2]) for b in brackets) + ")"
        blv = "c(" + ", ".join(str(lv) for lv in levels) + ")"
        blabels = _r_vec([b[3] for b in brackets])
        # The highest thing drawn for a gene: error bar tops, and the points
        # when they are shown (a replicate can sit above the error bar).
        if ptype == "bar":
            top_expr = ('dplyr::full_join(summ %>% dplyr::group_by(Gene) %>% dplyr::summarise(t1=max(mean+err, na.rm=TRUE), .groups="drop"), '
                        f'dat %>% dplyr::group_by(Gene) %>% dplyr::summarise(t2={"max(value, na.rm=TRUE)" if show_pts else "-Inf"}, .groups="drop"), by="Gene") %>% '
                        'dplyr::mutate(top=pmax(t1, t2, na.rm=TRUE)) %>% dplyr::select(Gene, top)')
        elif ptype == "violin":
            top_expr = ('dat %>% dplyr::group_by(Gene, Sample) %>% dplyr::summarise(t=max(value, na.rm=TRUE) + '
                        'if (dplyr::n() >= 2) 3 * stats::bw.nrd0(value) else 0, .groups="drop") %>% '
                        'dplyr::group_by(Gene) %>% dplyr::summarise(top=max(t, na.rm=TRUE), .groups="drop")')
        else:
            top_expr = 'dat %>% dplyr::group_by(Gene) %>% dplyr::summarise(top=max(value, na.rm=TRUE), .groups="drop")'
        shared_d = "" if faceted else 'bdf$D <- max(c(bdf$D, topdf$top), na.rm=TRUE)\n  '
        blank = ('p <- p + ggplot2::geom_blank(data=unique(bdf[c("Gene", "D")]), ggplot2::aes(y=D), inherit.aes=FALSE)'
                 if faceted else 'p <- p + ggplot2::expand_limits(y=max(bdf$D))')
        bracket_block = (
            f'bdf <- data.frame(Gene=factor(.genes[{bgi}], levels=.genes), x1={bx1}, x2={bx2}, lv={blv}, label={blabels}, stringsAsFactors=FALSE)\n'
            f'topdf <- as.data.frame({top_expr})\n'
            # left-join + drop brackets whose gene has no plotted data (else a
            # 0-row bdf would crash geom_segment with "x1 not found").
            'bdf <- merge(bdf, topdf, by="Gene", all.x=TRUE)\n'
            'bdf <- bdf[is.finite(bdf$top), , drop=FALSE]\n'
            'if (nrow(bdf) > 0) {\n'
            f'  .gap <- {gap_f:.5f}; .step <- {step_f:.5f}; .txt <- {txt_f:.5f}; .tick <- {tick_f:.5f}; .fmax <- 0.72\n'
            '  bdf$top <- pmax(bdf$top, 0)\n'
            '  .L <- ave(bdf$lv, bdf$Gene, FUN=max)\n'
            # Too many levels for the panel: squeeze the step rather than push
            # the data into a sliver at the bottom.
            '  .stp <- ifelse(.L > 1, pmin(.step, (.fmax - .gap - .txt) / pmax(.L - 1, 1)), .step)\n'
            '  .fr <- pmin(.gap + (.L - 1) * .stp + .txt, .fmax)\n'
            '  bdf$D <- ifelse(bdf$top > 0, bdf$top / (1 - .fr), 1)\n'
            f'  {shared_d}bdf$y <- bdf$top + (.gap + (bdf$lv - 1) * .stp) * bdf$D\n'
            '  bdf$yt <- bdf$y - .tick * bdf$D\n'
            '  bdf$vj <- ifelse(bdf$label == "ns", -0.25, 0.15)\n'
            '  p <- p + ggplot2::geom_segment(data=bdf, ggplot2::aes(x=x1, xend=x2, y=y, yend=y), inherit.aes=FALSE, linewidth=0.4) + '
            'ggplot2::geom_segment(data=bdf, ggplot2::aes(x=x1, xend=x1, y=y, yend=yt), inherit.aes=FALSE, linewidth=0.4) + '
            'ggplot2::geom_segment(data=bdf, ggplot2::aes(x=x2, xend=x2, y=y, yend=yt), inherit.aes=FALSE, linewidth=0.4) + '
            f'ggplot2::geom_text(data=bdf, ggplot2::aes(x=(x1+x2)/2, y=y, label=label, vjust=vj), inherit.aes=FALSE, size={star_pt / 2.845:.2f})\n'
            f'  {blank}\n'
            '}\n'
        )
    else:
        bracket_block = ""

    xlab = f'"{_resc(body.xlabel)}"' if body.xlabel.strip() else "NULL"
    ylab = f'"{_resc(body.ylabel)}"' if body.ylabel.strip() else "NULL"
    code = f"""
suppressMessages({{ library(ggplot2); library(dplyr) }})
.genes <- {_r_vec(body.gene_order)}
.samples <- {_r_vec(body.sample_order)}
dat <- data
dat$Gene <- factor(.genes[dat$gi], levels=.genes)
dat$Sample <- factor(.samples[dat$si], levels=.samples)
.cols <- {_r_vec(colors)}; names(.cols) <- .samples
.labs <- {_r_vec(legend_labels)}
.num <- function(x) {{ out <- format(x, trim=TRUE, scientific=FALSE, drop0trailing=TRUE); out[is.na(x)] <- NA; out }}
.S <- length(.samples); .bw <- {bw}; .w <- .bw / .S
.lane <- function(g, s) as.integer(g) + .bw * ((2 * as.integer(s) - 1 - .S) / (2 * .S))
summ <- dat %>% dplyr::group_by(Gene, Sample) %>% dplyr::summarise(mean=mean(value), sd=sd(value), sem=sd(value)/sqrt(dplyr::n()), .groups="drop")
summ$err <- {'summ$sem' if body.error_type.upper() == 'SEM' else 'summ$sd'}
summ$err[is.na(summ$err)] <- 0
summ$xp <- .lane(summ$Gene, summ$Sample)
dat$xp <- .lane(dat$Gene, dat$Sample)
p <- ggplot2::ggplot()
{geom}{points_layer}{layout_layer}p <- p + ggplot2::scale_fill_manual(values=.cols, labels=.labs, drop=FALSE) + ggplot2::labs(title="{_resc(body.title)}", x={xlab}, y={ylab}, fill=NULL)
{theme_layer}{xangle_layer}{bracket_block}{transparent_theme}mpfig_render(p, width={int(body.width)}, height={int(body.height)}, res={int(body.dpi)}, format="{export_fmt}", bg="{bg}")
mpfig_data(dplyr::select(summ, -xp), "qpcr_summary")
"""
    data = _indexed(pts, body.gene_order, body.sample_order)
    res = r_bridge.run_r(r_bridge.RunRRequest(code=code, data_csv=data.to_csv(index=False), timeout_sec=120))
    if notes and isinstance(res, dict):
        res["notes"] = notes
    return res


# ── Raw Cp plot (QC: reference-gene stability + detection limit) ────────────

class CpPlotRequest(BaseModel):
    run_ids: List[int] = []                   # library runs (or pairs, as for analyze)
    pairs: List[dict] = []
    gene_order: List[str]
    sample_order: List[str]
    reference_genes: List[str] = []           # labelled "(ref)" on the axis
    cp_limit: float = 35.0                    # dotted line; Cp at/above = not detected
    colors: Dict[str, str] = {}
    labels: Dict[str, str] = {}
    theme: str = "prism"
    point_size: float = 1.8
    font_size: int = 14
    title: str = "Raw Cp values"
    width: int = 1200
    height: int = 800
    dpi: int = 150
    export_format: str = "png"
    transparent: bool = False
    # Wells best of three left out of the analysis ({Run, Well, Gene, Sample,
    # Cp} as /analyze returned them): drawn hollow and grey, not in the mean.
    excluded_wells: List[dict] = []


def _mark_excluded(df: pd.DataFrame, excluded: List[dict]) -> pd.Series:
    """1 for the rows of `df` (Run, Well, Gene, Sample, Cp) that are in
    `excluded`, else 0. Each listed well marks one row, so two wells with the
    same identity and Cp are counted right."""
    def key(run, well, gene, sample, cp):
        cp = None if cp is None or (isinstance(cp, float) and math.isnan(cp)) else round(float(cp), 4)
        well = None if well is None or (isinstance(well, float) and math.isnan(well)) else str(well)
        return (str(run), well, str(gene), str(sample), cp)
    want: Dict[tuple, int] = {}
    for e in excluded:
        k = key(e.get("Run"), e.get("Well"), e.get("Gene"), e.get("Sample"), e.get("Cp"))
        want[k] = want.get(k, 0) + 1
    out = []
    for run, well, gene, sample, cp in df[["Run", "Well", "Gene", "Sample", "Cp"]].itertuples(index=False):
        k = key(run, well, gene, sample, cp)
        if want.get(k, 0) > 0:
            want[k] -= 1
            out.append(1)
        else:
            out.append(0)
    return pd.Series(out, index=df.index, dtype=int)


@router.post("/api/qpcr/plot-cp")
def plot_cp(body: CpPlotRequest):
    """Raw Cp per gene x sample, reference genes included, with a dotted line at
    the Cp limit so genes near or past detection are easy to spot and exclude.
    Undetermined wells (no Cp) are drawn at the limit as crosses."""
    rows = [(r.get("Gene"), r.get("Sample"), r.get("Cp"), p.get("name", ""), r.get("Well"))
            for p in body.pairs or qpcr_library.load_records(body.run_ids)
            for r in p.get("records") or []]
    df = pd.DataFrame(rows, columns=["Gene", "Sample", "Cp", "Run", "Well"])
    df["Cp"] = pd.to_numeric(df["Cp"], errors="coerce")
    df = df[df["Gene"].isin(body.gene_order) & df["Sample"].isin(body.sample_order)].copy()
    marked = bool(body.excluded_wells)
    if marked:
        df["bo"] = _mark_excluded(df, body.excluded_wells)
    df = df.drop(columns=["Run", "Well"])
    if df.empty:
        return {"success": False, "stderr": "No wells for the selected genes and samples.", "plots": []}

    lim = float(body.cp_limit)
    present_genes, present_samples = set(df["Gene"]), set(df["Sample"])
    genes = [g for g in body.gene_order if g in present_genes]
    refs = [g for g in genes if g in set(body.reference_genes)]
    genes = refs + [g for g in genes if g not in set(refs)]          # references first
    samples = [s for s in body.sample_order if s in present_samples]
    angled = len(genes) > 8
    # A two-line "(ref)" label collides with its neighbours once labels are angled.
    xlabels = [(f"{g} (ref)" if angled else f"{g}\n(ref)") if g in refs else g for g in genes]
    colors = [body.colors.get(s, "#888888") for s in samples]
    labels = [body.labels.get(s, s) for s in samples]
    export_fmt = "tiff" if str(body.export_format).lower() in ("tiff", "tif") else "png"
    bg = "transparent" if body.transparent else "white"
    divider = (f'p <- p + ggplot2::geom_vline(xintercept={len(refs) + 0.5}, colour="grey75", linewidth=0.4)\n'
               if 0 < len(refs) < len(genes) else "")
    xangle = ('p <- p + ggplot2::theme(axis.text.x=ggplot2::element_text(angle=45, hjust=1, vjust=1))\n'
              if angled else "")
    df["nd"] = df["Cp"].isna().astype(int)
    df["Cp"] = df["Cp"].fillna(lim)
    # Best of three: left-out wells are drawn hollow and grey and kept out of
    # the mean, so the bar shows what the analysis used.
    if marked:
        bo_split = 'dat$bo[is.na(dat$bo)] <- 0\nbo <- dat[dat$bo == 1, , drop=FALSE]\ndet <- dat[dat$nd == 0 & dat$bo == 0, , drop=FALSE]\n'
        bo_layer = (f'if (nrow(bo) > 0) p <- p + ggplot2::geom_point(data=bo, ggplot2::aes(x, Cp), shape=21, fill="white", colour="grey55", '
                    f'stroke=0.7, size={body.point_size}, position=ggplot2::position_jitter(width=.w * 0.22, height=0, seed=3))\n')
        caption = ('.cap <- c(if (nrow(und) > 0) "× undetermined well (no Cp), drawn at the limit", '
                   'if (nrow(bo) > 0) "Hollow grey dots: wells left out by best of three (not in the mean)")\n'
                   '.cap <- if (length(.cap)) paste(.cap, collapse="\\n") else NULL\n')
        bo_summ = ", n_left_out=sum(bo)"
        used = "nd == 0 & bo == 0"
    else:
        bo_split = bo_layer = bo_summ = ""
        used = "nd == 0"
        caption = '.cap <- if (nrow(und) > 0) "× undetermined well (no Cp), drawn at the limit" else NULL\n'

    # One fixed lane per sample (as in the grouped fold-change plot), so the
    # mean bars always sit on their own wells even when a gene lacks a sample.
    code = f"""
suppressMessages({{ library(ggplot2); library(dplyr) }})
.genes <- {_r_vec(genes)}
.samples <- {_r_vec(samples)}
dat <- data
dat$Gene <- factor(.genes[dat$gi], levels=.genes)
dat$Sample <- factor(.samples[dat$si], levels=.samples)
.cols <- {_r_vec(colors)}; names(.cols) <- .samples
.lim <- {lim}
.S <- length(.samples); dw <- 0.8; .w <- dw / .S
dat$x <- as.integer(dat$Gene) + dw * ((2 * as.integer(dat$Sample) - 1 - .S) / (2 * .S))
det <- dat[dat$nd == 0, , drop=FALSE]
{bo_split}und <- dat[dat$nd == 1, , drop=FALSE]
{caption}mn <- det %>% dplyr::group_by(Gene, Sample, x) %>% dplyr::summarise(m=mean(Cp), .groups="drop")
p <- ggplot2::ggplot()
p <- p + ggplot2::annotate("rect", xmin=-Inf, xmax=Inf, ymin=.lim, ymax=Inf, fill="#c1666b", alpha=0.08)
{divider}p <- p + ggplot2::geom_crossbar(data=mn, ggplot2::aes(x=x, y=m, ymin=m, ymax=m), width=.w * 0.9, linewidth=0.3, colour="black")
p <- p + ggplot2::geom_point(data=det, ggplot2::aes(x, Cp, fill=Sample), shape=21, colour="black", stroke=0.3, size={body.point_size}, position=ggplot2::position_jitter(width=.w * 0.22, height=0, seed=1))
if (nrow(und) > 0) p <- p + ggplot2::geom_point(data=und, ggplot2::aes(x, Cp), shape=4, colour="#c1666b", stroke=0.9, size={body.point_size * 1.1:.2f}, position=ggplot2::position_jitter(width=.w * 0.22, height=0, seed=2))
{bo_layer}p <- p + ggplot2::geom_hline(yintercept=.lim, linetype="dotted", colour="#c1666b", linewidth=0.8)
p <- p + ggplot2::annotate("text", x=Inf, y=.lim, label=sprintf("Cp %g", .lim), hjust=1.05, vjust=-0.6, colour="#c1666b", size={max(3, body.font_size / 3.5):.2f})
p <- p + ggplot2::expand_limits(y=.lim + 1)
p <- p + ggplot2::scale_fill_manual(values=.cols, labels={_r_vec(labels)}, drop=FALSE)
p <- p + ggplot2::scale_x_continuous(breaks=seq_along(.genes), labels={_r_vec(xlabels)}, expand=c(0, 0)) + ggplot2::coord_cartesian(xlim=c(0.5, length(.genes) + 0.5))
p <- p + ggplot2::labs(title="{_resc(body.title)}", x=NULL, y="Cp", fill=NULL, caption=.cap)
{_theme_layer(body.theme, body.font_size)}{xangle}{_transparent_layer(body.transparent)}mpfig_render(p, width={int(body.width)}, height={int(body.height)}, res={int(body.dpi)}, format="{export_fmt}", bg="{bg}")
summ <- dat %>% dplyr::group_by(Gene, Sample) %>% dplyr::summarise(
  mean_Cp=if (any({used})) mean(Cp[{used}]) else NA_real_, sd=sd(Cp[{used}]), n_wells=dplyr::n(),
  n_undetermined=sum(nd), n_at_or_above_limit=sum(nd == 0 & Cp >= .lim){bo_summ}, .groups="drop")
mpfig_data(summ, "qpcr_cp_summary")
"""
    data = _indexed(df, genes, samples)
    return r_bridge.run_r(r_bridge.RunRRequest(code=code, data_csv=data.to_csv(index=False), timeout_sec=120))
