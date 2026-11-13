"""Statistics for the Graphs tool (Prism-style data tables).

Pure functions, no FastAPI / R: `compute(table, analysis)` takes a GraphTable
(numbers) and a GraphAnalysis and returns an AnalyzeResult dict. Every float
goes through `_num`, so NaN / inf never reach JSON; a test that cannot be
computed (too few values, zero variance) reports p = None, star "ns" and a
note instead of a misleading P.

Conventions (validated against R / GraphPad reference values in the tests):
- Missing values are dropped per group.
- diff = mean(b) - mean(a); a is the earlier column / the control.
- SD uses n - 1; 95% CIs use t(0.975, df).
- Quartiles use numpy's "weibull" method (= Prism / R type 6).
- Stars follow GraphPad's GP style (see `_star`).
- "Zero variance" means zero up to floating-point noise relative to the
  magnitude of the data (`_tiny`), never relative to the between-group spread.
- Tukey (studentized range) and Dunnett P values / critical values come from
  deterministic numerical integrals (`_MaxStat`), not scipy's per-call
  quadrature (slow) or quasi-Monte-Carlo (inaccurate in the tail).
"""

from __future__ import annotations

import functools
import itertools
import math
import re
import threading
import warnings
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np
from scipy import special as _sp
from scipy import stats as ss
from scipy.optimize import brentq

TEMPLATES = ("column", "grouped", "xy")

TESTS_BY_TEMPLATE = {
    "column": ("none", "unpaired_t", "welch_t", "paired_t", "mann_whitney", "wilcoxon",
               "anova", "welch_anova", "kruskal"),
    "grouped": ("none", "two_way"),
    "xy": ("none", "linreg"),
}

POSTHOC_FOR_TEST = {
    "anova": ("none", "tukey", "dunnett", "sidak", "bonferroni"),
    "welch_anova": ("none", "games_howell"),
    "kruskal": ("none", "dunn"),
    "two_way": ("none", "tukey", "sidak", "bonferroni"),
}

# post-hoc -> allowed `compare` values (missing = any)
POSTHOC_COMPARE = {
    ("anova", "tukey"): ("all",),
    ("anova", "dunnett"): ("control",),
    ("kruskal", "dunn"): ("all", "control"),
    ("two_way", "tukey"): ("all", "control"),
}

TEST_LABELS = {
    "unpaired_t": "Unpaired t test",
    "welch_t": "Unpaired t test with Welch's correction",
    "paired_t": "Paired t test",
    "mann_whitney": "Mann-Whitney test",
    "wilcoxon": "Wilcoxon matched-pairs signed rank test",
    "anova": "Ordinary one-way ANOVA",
    "welch_anova": "Welch's ANOVA",
    "kruskal": "Kruskal-Wallis test",
    "two_way": "Two-way ANOVA",
    "linreg": "Simple linear regression",
}

POSTHOC_LABELS = {
    "tukey": "Tukey's multiple comparisons test",
    "dunnett": "Dunnett's multiple comparisons test",
    "sidak": "Šídák's multiple comparisons test",
    "bonferroni": "Bonferroni's multiple comparisons test",
    "dunn": "Dunn's multiple comparisons test",
    "games_howell": "Games-Howell's multiple comparisons test",
}

EXACT_N_MAX = 50          # exact Mann-Whitney / Wilcoxon only up to this n
SPEARMAN_EXACT_N_MAX = 9  # exact permutation P for Spearman below n = 10
MAX_COMPARISONS = 5000    # more post-hoc rows than this are not listed (unreadable, slow to draw)
REL_NOISE = 1e-12         # values / SDs below this fraction of the data magnitude are float noise

TOO_LARGE_NOTE = "The values are too large to analyse (their sums of squares overflow)"
CONTROL_EMPTY_WARNING = "The control has no values: choose a control with data to see the comparisons."
NO_PAIRS_WARNING = "No pairs chosen yet: tick at least one pair to compare."


class InvalidAnalysis(ValueError):
    """The request itself is malformed / an unsupported combination."""


# ── small helpers ───────────────────────────────────────────────────────────

def _num(x) -> Optional[float]:
    """float, or None for NaN / inf / non-numbers (JSON has no NaN)."""
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def _star(p: Optional[float], sig: float) -> str:
    """GraphPad Prism (GP) style: * P≤0.05, ** P≤0.01, *** P≤0.001, **** P≤0.0001.
    `sig` (α) only decides what counts as significant; a missing P is "ns".
    Must stay identical to qpcr._star (parity-tested)."""
    if p is None or not (p <= sig and p <= 0.05):
        return "ns"
    if p <= 0.0001:
        return "****"
    if p <= 0.001:
        return "***"
    if p <= 0.01:
        return "**"
    return "*"


def _int_or_none(v) -> Optional[int]:
    try:
        if v is None or isinstance(v, bool):
            return None
        f = float(v)
        if not math.isfinite(f) or f != int(f):
            return None
        return int(f)
    except (TypeError, ValueError):
        return None


def _cell(v) -> List[float]:
    """A table cell -> list of finite floats (missing dropped)."""
    if v is None:
        return []
    if isinstance(v, (list, tuple)):
        out = []
        for x in v:
            n = None if isinstance(x, bool) else _num(x)
            if n is not None:
                out.append(n)
        return out
    n = None if isinstance(v, bool) else _num(v)
    return [] if n is None else [n]


_BAD_CHARS = re.compile("[\x00\ud800-\udfff]")


def clean_text(v: Any) -> str:
    """str(v) safe for JSON / UTF-8 / R: NUL dropped, lone UTF-16 surrogates
    (half of a broken emoji) replaced by U+FFFD."""
    s = "" if v is None else str(v)
    return _BAD_CHARS.sub(lambda m: "" if m.group() == "\x00" else "�", s)


def _titles(v) -> List[str]:
    if not isinstance(v, (list, tuple)):
        return []
    return [clean_text(t) for t in v]


def _sumsq(*arrays) -> float:
    """Sum of squares of the raw values: the magnitude `_tiny` is relative to."""
    return float(sum(np.sum(np.square(np.asarray(a, dtype=float))) for a in arrays))


def _finite(*xs) -> bool:
    return all(x is not None and math.isfinite(x) for x in xs)


def _tiny(ss_resid: float, scale: float) -> bool:
    """A residual sum of squares that is zero up to floating-point noise.
    `scale` is the sum of squares of the raw values (`_sumsq`): rounding noise
    in an SS is about N * (eps * |y|)^2, so an SS below REL_NOISE^2 of it (a
    residual SD below ~1e-12 of the data magnitude) is noise, whatever the
    spread between groups."""
    return ss_resid <= REL_NOISE * REL_NOISE * max(scale, 0.0) or ss_resid <= 1e-300


@functools.lru_cache(maxsize=1024)
def _t975(df: int) -> float:
    return float(ss.t.ppf(0.975, df))


def _sem_ci(x: np.ndarray):
    n = len(x)
    if n < 2:
        return None, None, None, None
    sd = float(np.std(x, ddof=1))
    sem = sd / math.sqrt(n)
    h = _t975(n - 1) * sem
    m = float(np.mean(x))
    return sd, sem, m - h, m + h


def describe(x: Sequence[float]) -> dict:
    x = np.asarray(x, dtype=float)
    n = int(len(x))
    if n == 0:
        return {"n": 0, "mean": None, "sd": None, "sem": None, "ci_lo": None, "ci_hi": None,
                "median": None, "q1": None, "q3": None, "min": None, "max": None}
    sd, sem, lo, hi = _sem_ci(x)
    q1, med, q3 = np.percentile(x, [25, 50, 75], method="weibull")   # weibull 50% = the median
    return {"n": n, "mean": _num(np.mean(x)), "sd": _num(sd), "sem": _num(sem),
            "ci_lo": _num(lo), "ci_hi": _num(hi), "median": _num(med),
            "q1": _num(q1), "q3": _num(q3), "min": _num(np.min(x)), "max": _num(np.max(x))}


def _comparison(row, a, b, label, diff=None, se=None, stat_name=None, stat=None, df=None,
                p_raw=None, p_adj=None, ci_lo=None, ci_hi=None, alpha=0.05, note=None) -> dict:
    p_adj = _num(p_adj)
    star = _star(p_adj, alpha)
    return {"row": row, "a": a, "b": b, "label": label, "diff": _num(diff), "se": _num(se),
            "statistic_name": stat_name, "statistic": _num(stat), "df": _num(df),
            "p_raw": _num(p_raw), "p_adj": p_adj, "ci_lo": _num(ci_lo), "ci_hi": _num(ci_hi),
            "star": star, "significant": p_adj is not None and star != "ns", "note": note}


def _test(tid, method=None, stat_name=None, stat=None, df=None, df2=None, p=None, alpha=0.05,
          note=None, label=None) -> dict:
    p = _num(p)
    return {"id": tid, "label": label or TEST_LABELS.get(tid, tid), "method": method,
            "statistic_name": stat_name, "statistic": _num(stat), "df": _num(df), "df2": _num(df2),
            "p": p, "star": _star(p, alpha), "note": note}


def _empty_result() -> dict:
    return {"warnings": [], "descriptives": [], "normality": [], "test": None, "anova_table": [],
            "comparisons": [], "regression": [], "correlation": []}


# ── input normalisation ─────────────────────────────────────────────────────

def normalize_analysis(template: str, analysis: Optional[dict]) -> dict:
    """Fill defaults and reject unsupported combinations (InvalidAnalysis)."""
    if analysis is not None and not isinstance(analysis, dict):
        raise InvalidAnalysis("The analysis settings must be an object.")
    a = dict(analysis or {})
    # clean_text: these strings are echoed in error messages, which must stay encodable
    test = clean_text(a.get("test") or "none")
    posthoc = clean_text(a.get("posthoc") or "none")
    compare = clean_text(a.get("compare") or "all")
    within = clean_text(a.get("within") or "rows")
    family = clean_text(a.get("family") or "all")
    correlation = clean_text(a.get("correlation") or "none")
    alpha = _num(a.get("alpha"))
    if alpha is None:
        alpha = 0.05
    if not (0 < alpha < 1):
        raise InvalidAnalysis("alpha must be between 0 and 1.")
    if template not in TEMPLATES:
        raise InvalidAnalysis(f"Unknown table template '{template}'.")
    if test not in TESTS_BY_TEMPLATE[template]:
        raise InvalidAnalysis(f"The test '{test}' is not available for a {template} table.")
    allowed_ph = POSTHOC_FOR_TEST.get(test, ("none",))
    if posthoc not in allowed_ph:
        raise InvalidAnalysis(f"The post-hoc test '{posthoc}' can't follow '{test}'.")
    if compare not in ("all", "control", "selected"):
        raise InvalidAnalysis(f"Unknown comparison set '{compare}'.")
    allowed_cmp = POSTHOC_COMPARE.get((test, posthoc))
    if allowed_cmp and compare not in allowed_cmp:
        raise InvalidAnalysis(f"{POSTHOC_LABELS[posthoc]} needs compare = {' or '.join(allowed_cmp)}.")
    if within not in ("rows", "columns"):
        raise InvalidAnalysis("within must be 'rows' or 'columns'.")
    if family not in ("all", "per_row"):
        raise InvalidAnalysis("family must be 'all' or 'per_row'.")
    if correlation not in ("none", "pearson", "spearman"):
        raise InvalidAnalysis(f"Unknown correlation '{correlation}'.")
    pairs = []
    raw_pairs = a.get("pairs")
    if raw_pairs is not None and not isinstance(raw_pairs, (list, tuple)):
        raise InvalidAnalysis("pairs must be a list of [a, b] index pairs.")
    for pr in raw_pairs or []:
        if not isinstance(pr, (list, tuple)) or len(pr) != 2:
            raise InvalidAnalysis("pairs must be a list of [a, b] index pairs.")
        i, j = _int_or_none(pr[0]), _int_or_none(pr[1])
        if i is None or j is None or i < 0 or j < 0 or i == j:
            raise InvalidAnalysis("pairs must hold two different non-negative indices.")
        pairs.append([i, j])
    control = _int_or_none(a.get("control"))
    if control is not None and control < 0:
        raise InvalidAnalysis("control must be a non-negative index.")
    return {"test": test, "posthoc": posthoc, "compare": compare, "control": control,
            "pairs": pairs, "alpha": float(alpha), "within": within, "family": family,
            "correlation": correlation}


def normalize_table(table: Optional[dict]) -> dict:
    if table is not None and not isinstance(table, dict):
        raise InvalidAnalysis("The data table must be an object.")
    t = dict(table or {})
    template = clean_text(t.get("template") or "column")
    if template not in TEMPLATES:
        raise InvalidAnalysis(f"Unknown table template '{template}'.")
    col_titles = _titles(t.get("col_titles"))
    row_titles = _titles(t.get("row_titles"))
    raw = t.get("values") or []
    if not isinstance(raw, (list, tuple)):
        raise InvalidAnalysis("values must be a list of rows.")
    n_cols = max([len(col_titles)] + [len(r) for r in raw if isinstance(r, (list, tuple))])
    values = []
    for r in raw:
        r = list(r) if isinstance(r, (list, tuple)) else []
        values.append([_cell(r[c]) if c < len(r) else [] for c in range(n_cols)])
    while len(col_titles) < n_cols:
        col_titles.append(f"Data set {len(col_titles) + 1}")
    x_raw = t.get("x") or []
    x = [(None if isinstance(v, bool) else _num(v)) for v in (x_raw if isinstance(x_raw, (list, tuple)) else [])]
    while len(x) < len(values):
        x.append(None)
    if template == "grouped":
        while len(row_titles) < len(values):
            row_titles.append(f"Row {len(row_titles) + 1}")
    return {"template": template, "col_titles": col_titles, "row_titles": row_titles,
            "x_title": clean_text(t.get("x_title")),
            "x": x, "values": values, "n_cols": n_cols, "n_rows": len(values)}


# ── public entry ────────────────────────────────────────────────────────────

def compute(table: Optional[dict], analysis: Optional[dict]) -> dict:
    """GraphTable + GraphAnalysis -> AnalyzeResult. Malformed input gives
    {"error", "code": "invalid"}; data that can't support the analysis gives
    {"error", "code": "data"} with the descriptives still filled in."""
    res = _empty_result()
    try:
        tb = normalize_table(table)
        an = normalize_analysis(tb["template"], analysis)
    except InvalidAnalysis as e:
        res.update(error=str(e), code="invalid")
        return res
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        with np.errstate(all="ignore"):
            if tb["template"] == "column":
                _column(tb, an, res)
            elif tb["template"] == "grouped":
                _grouped(tb, an, res)
            else:
                _xy(tb, an, res)
    return res


def public(result: dict) -> dict:
    """Drop internal keys (prefixed "_") before the result goes to the client."""
    return {k: v for k, v in result.items() if not k.startswith("_")}


# ── Dunnett / Tukey distributions (deterministic numerical integrals) ───────

_GL10_X, _GL10_W = np.polynomial.legendre.leggauss(10)
_SQ2PI = math.sqrt(2.0 * math.pi)


def _gl_nodes(breaks: np.ndarray):
    """Composite 10-point Gauss-Legendre nodes / weights over consecutive breakpoints."""
    a, b = breaks[:-1, None], breaks[1:, None]
    h = (b - a) / 2.0
    return ((a + b) / 2.0 + h * _GL10_X).ravel(), (h * _GL10_W).ravel()


_U01, _W01 = _gl_nodes(np.linspace(0.0, 1.0, 9))   # 8 panels x 10 nodes on [0, 1]
# graded towards 0, for s-windows that start at 0 (f_s ~ s^(df-1) is not smooth
# there when df is fractional, e.g. the Welch df of Games-Howell)
_U0G, _W0G = _gl_nodes(np.concatenate([[0.0], np.geomspace(1e-6, 0.125, 10), np.linspace(0.25, 1.0, 7)]))


@functools.lru_cache(maxsize=256)
def _s_grid(df: float) -> np.ndarray:
    s_up = math.sqrt(ss.chi2.isf(1e-40, df) / df)
    return np.linspace(0.0, s_up, 601)[1:]


def _log_fs(s: np.ndarray, df: float) -> np.ndarray:
    """log density of s = sqrt(chi2_df / df)."""
    h = df / 2.0
    with np.errstate(divide="ignore"):
        return math.log(2.0) + h * math.log(h) - _sp.gammaln(h) + (df - 1.0) * np.log(s) - h * s * s


class _MaxStat:
    """Upper tail of T = M / s with s = sqrt(chi2_df / df) independent of M >= 0:

        P(T >= c) = integral_0^inf f_s(s) G(c s) ds,    G(x) = P(M >= x).

    The subclass supplies G (`_log_g_exact`, a Gauss-Legendre integral whose
    complement is accumulated with log1p / expm1, so far-tail P values keep
    full relative precision) and `_la`, a cheap upper bound of log G that is
    within `slack` nats of it (a Bonferroni bound). G is tabulated lazily as a
    piecewise Chebyshev interpolant of log G on unit x-panels (shared by every
    df and every comparison); `_la` only locates the s-window that holds the
    integrand, which is then integrated by Gauss-Legendre. Deterministic, and
    accurate to ~1e-10 relative against adaptive-quadrature references."""

    H, DEG, XMAX = 1.0, 16, 37.0   # G underflows a double beyond x ~ 37

    def __init__(self, slack: float):
        self.slack = float(slack)
        self._coef: Dict[int, np.ndarray] = {}
        self._lock = threading.Lock()
        j = np.arange(self.DEG + 1)
        self._t = np.cos(np.pi * (j + 0.5) / (self.DEG + 1))

    def _log_g_exact(self, xs: np.ndarray) -> np.ndarray:  # pragma: no cover - abstract
        raise NotImplementedError

    def _la(self, x: np.ndarray) -> np.ndarray:  # pragma: no cover - abstract
        raise NotImplementedError

    def _panel(self, j: int) -> np.ndarray:
        c = self._coef.get(j)
        if c is None:
            xs = j * self.H + (self._t + 1.0) / 2.0 * self.H
            with np.errstate(all="ignore"):
                lg = self._log_g_exact(xs)
            lg = np.where(np.isfinite(lg), lg, -1e4)
            c = np.polynomial.chebyshev.chebfit(self._t, lg, self.DEG)
            with self._lock:
                self._coef[j] = c
        return c

    def log_g(self, x) -> np.ndarray:
        x = np.asarray(x, dtype=float)
        out = np.full(x.shape, -np.inf)
        out[x <= 0] = 0.0
        ok = (x > 0) & (x < self.XMAX)
        if np.any(ok):
            xo = x[ok]
            idx = np.floor(xo / self.H).astype(int)
            C = np.stack([self._panel(j) for j in range(int(idx.max()) + 1)])[idx]
            t = 2.0 * (xo - idx * self.H) / self.H - 1.0
            b1 = np.zeros_like(t)
            b2 = np.zeros_like(t)
            for kk in range(self.DEG, 0, -1):   # Clenshaw
                b1, b2 = C[:, kk] + 2.0 * t * b1 - b2, b1
            out[ok] = np.minimum(C[:, 0] + t * b1 - b2, 0.0)
        return out

    def sf(self, c, df: float) -> np.ndarray:
        """P(T >= c) for an array of c (two-sided statistics: pass |stat|)."""
        c = np.abs(np.atleast_1d(np.asarray(c, dtype=float)))
        out = np.ones(c.shape)
        out[~np.isfinite(c)] = 0.0
        m = np.isfinite(c) & (c > 0)
        if not np.any(m):
            return out
        cm = c[m]
        with np.errstate(all="ignore"):
            if not math.isfinite(df) or df > 1e6:   # s is 1 to double precision
                out[m] = np.exp(self.log_g(cm))
                return out
            sg = _s_grid(float(df))
            L = _log_fs(sg, df)[None, :] + self._la(cm[:, None] * sg[None, :])
            above = L > (L.max(axis=1) - 60.0 - self.slack)[:, None]
            n = len(sg)
            first = np.argmax(above, axis=1)
            last = n - 1 - np.argmax(above[:, ::-1], axis=1)
            lo = np.where(first > 0, sg[np.maximum(first - 1, 0)], 0.0)
            hi = sg[np.minimum(last + 1, n - 1)]
            val = np.empty(cm.shape)
            for sel, u, w in ((lo > 0, _U01, _W01), (lo <= 0, _U0G, _W0G)):
                if np.any(sel):
                    S = lo[sel, None] + (hi - lo)[sel, None] * u[None, :]
                    W = (hi - lo)[sel, None] * w[None, :]
                    lg = self.log_g((cm[sel, None] * S).ravel()).reshape(S.shape)
                    val[sel] = np.sum(W * np.exp(_log_fs(S, df) + lg), axis=1)
        out[m] = np.minimum(val, 1.0)
        return out

    def isf(self, alpha: float, df: float, lo: float, hi: float) -> float:
        """The c with P(T >= c) = alpha, bracketed by [lo, hi]."""
        f = lambda c: float(self.sf(c, df)[0]) - alpha  # noqa: E731
        a, b = lo * (1 - 1e-6), hi * (1 + 1e-6)
        if f(a) <= 0:
            return a
        if f(b) >= 0:
            return b
        return brentq(f, a, b, xtol=1e-12, rtol=1e-12)


class _DunnettDist(_MaxStat):
    """M = max_i |Z_i| with Z_i = b_i W + d_i E_i (correlation b_i b_j,
    b_i = sqrt(n_i / (n_i + n_0))): two-sided Dunnett many-to-one statistic
    for treatments of size n_i against a control of size n_0."""

    def __init__(self, n_treat: Sequence[int], n0: int):
        u, mult = np.unique(np.asarray(n_treat, dtype=float), return_counts=True)
        self.b = np.sqrt(u / (u + n0))
        self.d = np.sqrt(n0 / (u + n0))
        self.mult = mult.astype(float)
        self.k = int(len(n_treat))
        super().__init__(math.log(self.k))

    def _la(self, x):
        return np.minimum(0.0, math.log(2.0 * self.k) + _sp.log_ndtr(-x))

    def _z_breaks(self, x0: float, x1: float) -> np.ndarray:
        # the integrand over W peaks at z = x b_i with width d_i: refine there
        zmax = float(self.b.max()) * x1 + 10.0
        fine = [(bu * x0 - 9 * du, bu * x1 + 9 * du, 1.5 * du) for bu, du in zip(self.b, self.d) if 1.5 * du < 1.0]
        out, z = [0.0], 0.0
        while z < zmax:
            step = 1.0
            for lo, hi, st in fine:
                if lo - 1.0 <= z <= hi:
                    step = min(step, st)
            z = min(zmax, z + step)
            out.append(z)
        return np.asarray(out)

    def _log_g_exact(self, xs):
        z, w = _gl_nodes(self._z_breaks(float(xs.min()), float(xs.max())))
        wz = 2.0 * w * np.exp(-0.5 * z * z) / _SQ2PI      # the integrand is even in z
        X, Z = xs[:, None, None], z[None, None, :]
        B, D = self.b[None, :, None], self.d[None, :, None]
        q = np.minimum(_sp.ndtr((-X - B * Z) / D) + _sp.ndtr((B * Z - X) / D), 1.0)   # P(|Z_i| >= x | W = z)
        lsum = np.einsum("u,xuz->xz", self.mult, np.log1p(-q))
        return np.log(np.maximum(-np.expm1(lsum) @ wz, 0.0))


class _RangeDist(_MaxStat):
    """M = range of k iid standard normals: the studentized range (Tukey)."""

    def __init__(self, k: int):
        self.k = int(k)
        super().__init__(math.log(self.k * (self.k - 1) / 2.0))

    def _la(self, x):
        return np.minimum(0.0, math.log(self.k * (self.k - 1.0)) + _sp.log_ndtr(-x / math.sqrt(2.0)))

    def _log_g_exact(self, xs):
        # P(range >= w) = k int phi(z) [Phi(z)^(k-1) - (Phi(z) - Phi(z-w))^(k-1)] dz, the
        # bracket evaluated as Phi(z)^(k-1) * -expm1((k-1) log1p(-Phi(z-w)/Phi(z))).
        k = self.k
        z, w = _gl_nodes(np.arange(-10.0, max(2.0, float(xs.max()) / 2.0) + 12.5, 0.5))
        r = np.minimum(_sp.ndtr(z[None, :] - xs[:, None]) / _sp.ndtr(z)[None, :], 1.0)
        inner = np.exp((k - 1) * _sp.log_ndtr(z))[None, :] * -np.expm1((k - 1) * np.log1p(-r))
        dens = k * w * np.exp(-0.5 * z * z) / _SQ2PI
        return np.log(np.maximum(inner @ dens, 0.0))


@functools.lru_cache(maxsize=64)
def _range_dist(k: int) -> _RangeDist:
    return _RangeDist(k)


def ptukey_sf(q, k: int, df: float) -> np.ndarray:
    """Studentized range upper tail P(Q >= q) for k means and df error DF."""
    return _range_dist(int(k)).sf(q, df)


@functools.lru_cache(maxsize=4096)
def qtukey(conf: float, k: int, df: float) -> float:
    """Studentized range quantile (Tukey critical value)."""
    a = 1.0 - conf
    lo = math.sqrt(2.0) * ss.t.isf(a / 2.0, df)          # one pair
    if k <= 2:
        return lo
    hi = math.sqrt(2.0) * ss.t.isf(a / (k * (k - 1.0)), df)   # Bonferroni over k(k-1)/2 pairs
    return _range_dist(int(k)).isf(a, df, lo, hi)


def dunnett_crit(dist: _DunnettDist, alpha: float, df: float) -> float:
    lo = ss.t.isf(alpha / 2.0, df)                      # one treatment
    if dist.k <= 1:
        return lo
    return dist.isf(alpha, df, lo, ss.t.isf(alpha / (2.0 * dist.k), df))   # Bonferroni bound


# ── Column tables ───────────────────────────────────────────────────────────

def _column_groups(tb) -> List[np.ndarray]:
    return [np.array([v for row in tb["values"] for v in row[c]], dtype=float) for c in range(tb["n_cols"])]


def _column(tb, an, res):
    titles = tb["col_titles"]
    groups = _column_groups(tb)
    alpha = an["alpha"]
    for c, g in enumerate(groups):
        res["descriptives"].append({"row": None, "col": c, "label": titles[c], **describe(g)})
    for c, g in enumerate(groups):
        if len(g) == 0:
            continue
        row = {"col": c, "label": titles[c], "n": int(len(g)), "w": None, "p": None, "passed": None, "note": None}
        if len(g) < 3:
            row["note"] = "Needs at least 3 values"
        elif len(g) > 5000:
            row["note"] = "Too many values for Shapiro-Wilk (max 5000)"
        elif float(np.ptp(g)) == 0:
            row["note"] = "All values are identical"
        else:
            w, p = ss.shapiro(g)
            row.update(w=_num(w), p=_num(p))
            row["passed"] = None if row["p"] is None else bool(row["p"] > 0.05)
        res["normality"].append(row)

    test = an["test"]
    if test == "none":
        return
    if test in ("unpaired_t", "welch_t", "paired_t", "mann_whitney", "wilcoxon"):
        _two_group(tb, an, groups, res)
    else:
        _one_way(tb, an, groups, res)


def _pair_for_two_group(an, n_cols, groups) -> Tuple[int, int]:
    """The compared pair: the first chosen pair, else the first two columns
    that hold values (an empty leading / middle column is skipped)."""
    if an["pairs"]:
        a, b = an["pairs"][0]
    else:
        used = [i for i in range(n_cols) if len(groups[i]) > 0]
        a, b = (used[0], used[1]) if len(used) >= 2 else (0, 1)
    if a >= n_cols or b >= n_cols:
        raise InvalidAnalysis("The compared columns don't exist in the table.")
    return a, b


def _subject_values(tb, c) -> List[Optional[float]]:
    """Per-row value of column c for paired tests (mean of the cell's replicates)."""
    out = []
    for row in tb["values"]:
        v = row[c]
        out.append(float(np.mean(v)) if v else None)
    return out


def _snap_differences(d: np.ndarray, tol: float) -> np.ndarray:
    """Remove float noise from paired differences before zero / tie detection:
    |d| <= tol becomes 0, and |d| values within tol of each other (clustered
    from the smallest up) share one magnitude. tol is relative to the data's
    magnitude, so the result does not depend on the units."""
    d = np.array(d, dtype=float)
    if tol <= 0 or not len(d):
        return d
    d[np.abs(d) <= tol] = 0.0
    mag = np.abs(d)
    order = np.argsort(mag, kind="mergesort")
    rep = None
    for i in order:
        if mag[i] == 0:
            continue
        if rep is None or mag[i] - rep > tol:
            rep = mag[i]
        d[i] = math.copysign(rep, d[i])
    return d


def _two_group(tb, an, groups, res):
    titles = tb["col_titles"]
    alpha = an["alpha"]
    test = an["test"]
    try:
        ia, ib = _pair_for_two_group(an, tb["n_cols"], groups)
    except InvalidAnalysis as e:
        res.update(error=str(e), code="invalid")
        return
    label = f"{titles[ib]} vs. {titles[ia]}"
    a, b = groups[ia], groups[ib]

    if test in ("paired_t", "wilcoxon"):
        va, vb = _subject_values(tb, ia), _subject_values(tb, ib)
        both = [(x, y) for x, y in zip(va, vb) if x is not None and y is not None]
        dropped = sum(1 for x, y in zip(va, vb) if (x is None) != (y is None))
        if dropped:
            res["warnings"].append(f"{dropped} row(s) with a value in only one of the two columns were left out of the paired test.")
        pa = np.array([p[0] for p in both], dtype=float)
        pb = np.array([p[1] for p in both], dtype=float)
        scale = float(np.max(np.abs(np.concatenate([pa, pb])))) if len(pa) else 0.0
        if not math.isfinite(scale) or not np.all(np.isfinite(pb - pa)):
            scale = math.inf
        tol = REL_NOISE * scale
        if test == "paired_t":
            _paired_t(pb - pa, tol, ia, ib, label, alpha, res)
        else:
            _wilcoxon(_snap_differences(pb - pa, tol) if math.isfinite(tol) else np.full(len(pa), math.inf),
                      ia, ib, label, alpha, res)
        return

    if test in ("unpaired_t", "welch_t"):
        _unpaired_t(a, b, ia, ib, label, alpha, test == "welch_t", res)
        return
    _mann_whitney(a, b, ia, ib, label, alpha, res)


def _unpaired_t(a, b, ia, ib, label, alpha, welch, res):
    tid = "welch_t" if welch else "unpaired_t"
    na, nb = len(a), len(b)
    diff = float(np.mean(b) - np.mean(a)) if na and nb else None
    note = None
    t = df = p = se = lo = hi = None
    if na < 2 or nb < 2:
        note = "Each group needs at least 2 values"
    else:
        va, vb = float(np.var(a, ddof=1)), float(np.var(b, ddof=1))
        ssw = (na - 1) * va + (nb - 1) * vb
        scale = _sumsq(a, b)
        if not _finite(va, vb, ssw, scale, diff):
            note = TOO_LARGE_NOTE
        elif _tiny(ssw, scale):
            note = "Zero variance within both groups: the test can't be computed"
        else:
            if welch:
                se2 = va / na + vb / nb
                df = se2 ** 2 / ((va / na) ** 2 / (na - 1) + (vb / nb) ** 2 / (nb - 1))
            else:
                df = na + nb - 2
                se2 = (ssw / df) * (1 / na + 1 / nb)
            se = math.sqrt(se2)
            t = diff / se
            p = float(2 * ss.t.sf(abs(t), df))
            h = ss.t.ppf(0.975, df) * se
            lo, hi = diff - h, diff + h
    res["test"] = _test(tid, "two-tailed", "t", t, df, None, p, alpha, note)
    res["comparisons"].append(_comparison(None, ia, ib, label, diff, se, "t", t, df, p, p, lo, hi, alpha, note))


def _paired_t(d, tol, ia, ib, label, alpha, res):
    """t, P, mean difference, SE and CI all from the same differences d = b - a."""
    n = len(d)
    note = None
    t = df = p = se = lo = hi = None
    diff = float(np.mean(d)) if n else None
    if n < 2:
        note = "Needs at least 2 complete pairs"
    else:
        sd = float(np.std(d, ddof=1))
        if not _finite(sd, diff, tol):
            note = TOO_LARGE_NOTE
        elif sd <= tol:
            note = "Every pair has the same difference: the test can't be computed"
        else:
            df = n - 1
            se = sd / math.sqrt(n)
            t = diff / se
            p = float(2 * ss.t.sf(abs(t), df))
            h = ss.t.ppf(0.975, df) * se
            lo, hi = diff - h, diff + h
    res["test"] = _test("paired_t", "two-tailed", "t", t, df, None, p, alpha, note)
    res["comparisons"].append(_comparison(None, ia, ib, label, diff, se, "t", t, df, p, p, lo, hi, alpha, note))


def _has_ties(x) -> bool:
    return len(np.unique(x)) < len(x)


# Exact conditional (permutation) distributions on midranks, as Prism 6+ and
# R >= 4.4 use: exact P values remain available when there are ties. Midranks
# are multiples of 1/2, so the DP works on 2*rank integers.

def _exact_signed_rank_p(ranks: np.ndarray, v_obs: float) -> float:
    """Two-sided exact P for the signed-rank sum V = sum of positive ranks,
    under the 2^n equally likely sign assignments (R's tail convention)."""
    r2 = np.rint(np.asarray(ranks, dtype=float) * 2).astype(np.int64)
    total = int(r2.sum())
    dist = np.zeros(total + 1)
    dist[0] = 1.0
    for r in r2:
        shifted = np.zeros_like(dist)
        shifted[r:] = dist[:total + 1 - r]
        dist = (dist + shifted) * 0.5
    q = int(round(v_obs * 2))
    lower = float(dist[:q + 1].sum())
    upper = float(dist[q:].sum())
    p = 2 * (upper if 2 * q > total else lower)
    return min(1.0, p)


def _exact_rank_sum_p(ranks_a: np.ndarray, ranks_all: np.ndarray) -> float:
    """Two-sided exact P for the rank sum of group a over all C(N, na)
    equally likely splits of the pooled midranks: min(2*lower, 2*upper, 1)."""
    r2 = np.rint(np.asarray(ranks_all, dtype=float) * 2).astype(np.int64)
    na = len(ranks_a)
    total = int(r2.sum())
    # dist[k, s] = number of k-subsets with 2*rank-sum s (floats: ratios only)
    dist = np.zeros((na + 1, total + 1))
    dist[0, 0] = 1.0
    for r in r2:
        dist[1:, r:] += dist[:-1, :total + 1 - r].copy()
    row = dist[na]
    row = row / row.sum()
    q = int(round(float(np.sum(ranks_a)) * 2))
    return min(1.0, 2 * float(row[:q + 1].sum()), 2 * float(row[q:].sum()))


def _mann_whitney(a, b, ia, ib, label, alpha, res):
    na, nb = len(a), len(b)
    note = None
    U = p = None
    method = None
    diff = float(np.median(b) - np.median(a)) if na and nb else None
    if na < 1 or nb < 1:
        note = "Each group needs at least 1 value"
    else:
        pooled = np.concatenate([a, b])
        if float(np.ptp(pooled)) == 0:
            note = "All values are identical: the test can't be computed"
        else:
            exact = na <= EXACT_N_MAX and nb <= EXACT_N_MAX
            ranks = ss.rankdata(pooled)
            u1 = float(ranks[:na].sum() - na * (na + 1) / 2)
            U = min(u1, na * nb - u1)
            if exact:
                method = "exact" if not _has_ties(pooled) else "exact (ties handled by midranks)"
                p = _exact_rank_sum_p(ranks[:na], ranks)
            else:
                method = "normal approximation"
                p = float(ss.mannwhitneyu(a, b, alternative="two-sided", method="asymptotic",
                                          use_continuity=True).pvalue)
    res["test"] = _test("mann_whitney", method, "U", U, None, None, p, alpha, note)
    res["comparisons"].append(_comparison(None, ia, ib, label, diff, None, "U", U, None, p, p, None, None, alpha,
                                          note or "diff = difference between medians"))


def _wilcoxon(d, ia, ib, label, alpha, res):
    """d = b - a, already cleaned of float noise (`_snap_differences`).
    W is Prism's sum of signed ranks (W+ - W-, sign following b - a); scipy
    supplies only the P value."""
    note = None
    W = p = w_pos = w_neg = None
    method = None
    nz = d[d != 0]
    diff = float(np.median(d)) if len(d) else None
    if not np.all(np.isfinite(d)):
        note, nz = TOO_LARGE_NOTE, d[:0]
    elif len(nz) < 2:
        note = "Needs at least 2 pairs with a non-zero difference"
    else:
        exact = len(nz) <= EXACT_N_MAX
        ranks = ss.rankdata(np.abs(nz))
        w_pos, w_neg = float(ranks[nz > 0].sum()), float(ranks[nz < 0].sum())
        if exact:
            method = "exact" if not _has_ties(np.abs(nz)) else "exact (ties handled by midranks)"
            p = _exact_signed_rank_p(ranks, w_pos)
        else:
            method = "normal approximation"
            p = float(ss.wilcoxon(nz, zero_method="wilcox", correction=True, alternative="two-sided",
                                  method="approx").pvalue)
        W = w_pos - w_neg
        if len(nz) < len(d):
            res["warnings"].append(f"{len(d) - len(nz)} pair(s) with zero difference were dropped (n used = {len(nz)}).")
    t = _test("wilcoxon", method, "W", W, None, None, p, alpha, note)
    t["n"] = int(len(nz))
    t["sum_pos_ranks"] = _num(w_pos)
    t["sum_neg_ranks"] = _num(w_neg)
    res["test"] = t
    res["comparisons"].append(_comparison(None, ia, ib, label, diff, None, "W", W, None, p, p, None, None, alpha,
                                          note or "diff = median of the paired differences; W = sum of signed ranks"))


# ── One-way (≥2 groups) ─────────────────────────────────────────────────────

def _comparison_pairs(an, usable: List[int], n_cols: int) -> List[Tuple[int, int]]:
    cmp_ = an["compare"]
    if cmp_ == "control":
        ctrl = an["control"] if an["control"] is not None else 0
        if ctrl >= n_cols:
            raise InvalidAnalysis("The control column doesn't exist in the table.")
        return [(ctrl, j) for j in range(n_cols) if j != ctrl]
    if cmp_ == "selected":
        # an empty choice is the UI's own intermediate state: no comparisons yet
        for i, j in an["pairs"]:
            if i >= n_cols or j >= n_cols:
                raise InvalidAnalysis("A selected pair refers to a column that doesn't exist.")
        return [tuple(p) for p in an["pairs"]]
    return [(i, j) for i, j in itertools.combinations(range(n_cols), 2)]


def _filter_pairs(pairs, usable, titles, res):
    keep = [(i, j) for i, j in pairs if i in usable and j in usable]
    if len(keep) < len(pairs):
        res["warnings"].append("Comparisons involving a column with no values were skipped.")
    return keep


def _one_way(tb, an, groups, res):
    titles = tb["col_titles"]
    alpha = an["alpha"]
    test, posthoc = an["test"], an["posthoc"]
    usable = [c for c, g in enumerate(groups) if len(g) > 0]
    empty = [titles[c] for c, g in enumerate(groups) if len(g) == 0]
    if empty:
        res["warnings"].append("Columns with no values were ignored: " + ", ".join(empty) + ".")
    if len(usable) < 2:
        res.update(error="At least two columns need values for this test.", code="data")
        return
    try:
        pairs = _comparison_pairs(an, usable, tb["n_cols"]) if posthoc != "none" else []
    except InvalidAnalysis as e:
        res.update(error=str(e), code="invalid")
        return
    if posthoc != "none" and an["compare"] == "selected" and not an["pairs"]:
        res["warnings"].append(NO_PAIRS_WARNING)
    if posthoc == "dunnett" or (posthoc == "dunn" and an["compare"] == "control"):
        ctrl = an["control"] if an["control"] is not None else 0
        if ctrl not in usable:
            # keep the omnibus test; only the comparisons need a usable control
            res["warnings"].append(CONTROL_EMPTY_WARNING)
            pairs = []
    pairs = _filter_pairs(pairs, usable, titles, res)
    gs = [groups[c] for c in usable]
    k = len(gs)
    N = int(sum(len(g) for g in gs))

    if test == "anova":
        _anova(tb, an, groups, usable, gs, k, N, pairs, res)
    elif test == "welch_anova":
        _welch_anova(tb, an, groups, usable, gs, k, pairs, res)
    else:
        _kruskal(tb, an, groups, usable, gs, k, N, pairs, res)


def _anova(tb, an, groups, usable, gs, k, N, pairs, res):
    titles, alpha, posthoc = tb["col_titles"], an["alpha"], an["posthoc"]
    allv = np.concatenate(gs)
    grand = float(np.mean(allv))
    ssb = float(sum(len(g) * (np.mean(g) - grand) ** 2 for g in gs))
    ssw = float(sum(np.sum((g - np.mean(g)) ** 2) for g in gs))
    sst = ssb + ssw
    dfb, dfw = k - 1, N - k
    note = None
    F = p = mse = None
    scale = _sumsq(allv)
    if dfw < 1:
        note = "Needs more values than groups (no residual degrees of freedom)"
    elif not _finite(ssb, ssw, scale):
        note = TOO_LARGE_NOTE
    elif _tiny(ssw, scale):
        note = "Zero variance within every group: the test can't be computed"
    else:
        mse = ssw / dfw
        F = (ssb / dfb) / mse
        p = float(ss.f.sf(F, dfb, dfw))
    t = _test("anova", None, "F", F, dfb, dfw, p, alpha, note)
    t["r2"] = _num(ssb / sst) if sst > 0 else None
    res["test"] = t
    res["anova_table"] = [
        {"source": "Treatment (between columns)", "ss": _num(ssb), "df": dfb, "ms": _num(ssb / dfb) if dfb else None,
         "f": _num(F), "p": _num(p)},
        {"source": "Residual (within columns)", "ss": _num(ssw), "df": dfw, "ms": _num(mse), "f": None, "p": None},
        {"source": "Total", "ss": _num(sst), "df": N - 1, "ms": None, "f": None, "p": None},
    ]
    if posthoc == "none" or not pairs:
        return
    m = {c: float(np.mean(groups[c])) for c in usable}
    n = {c: len(groups[c]) for c in usable}
    if mse is None:
        for i, j in pairs:
            res["comparisons"].append(_comparison(None, i, j, f"{titles[j]} vs. {titles[i]}", m[j] - m[i],
                                                  alpha=alpha, note=note))
        return
    if posthoc == "tukey":
        qcrit = qtukey(0.95, k, dfw)
        diffs = np.array([m[j] - m[i] for i, j in pairs])
        ses = np.array([math.sqrt(mse * (1 / n[i] + 1 / n[j])) for i, j in pairs])
        qs = np.abs(diffs) / ses * math.sqrt(2)
        pvs = ptukey_sf(qs, k, dfw)
        for (i, j), diff, se, q, pv in zip(pairs, diffs, ses, qs, pvs):
            h = qcrit / math.sqrt(2) * se
            res["comparisons"].append(_comparison(None, i, j, f"{titles[j]} vs. {titles[i]}", diff, se, "q", q, dfw,
                                                  pv, pv, diff - h, diff + h, alpha))
    elif posthoc == "dunnett":
        ctrl = an["control"] if an["control"] is not None else 0
        treat = [j for (_i, j) in pairs]
        dist = _DunnettDist([n[j] for j in treat], n[ctrl])
        crit = dunnett_crit(dist, 0.05, dfw)
        diffs = np.array([m[j] - m[ctrl] for j in treat])
        ses = np.array([math.sqrt(mse * (1 / n[j] + 1 / n[ctrl])) for j in treat])
        tvs = diffs / ses
        pvs = dist.sf(np.abs(tvs), dfw)
        for j, diff, se, tv, pv in zip(treat, diffs, ses, tvs, pvs):
            res["comparisons"].append(_comparison(None, ctrl, j, f"{titles[j]} vs. {titles[ctrl]}", diff, se, "t",
                                                  tv, dfw, pv, pv, diff - crit * se, diff + crit * se, alpha))
    else:  # sidak / bonferroni
        mcount = len(pairs)
        if posthoc == "sidak":
            a_adj = 1 - (1 - 0.05) ** (1 / mcount)
        else:
            a_adj = 0.05 / mcount
        tcrit = ss.t.ppf(1 - a_adj / 2, dfw)
        for i, j in pairs:
            diff = m[j] - m[i]
            se = math.sqrt(mse * (1 / n[i] + 1 / n[j]))
            tv = diff / se
            praw = float(2 * ss.t.sf(abs(tv), dfw))
            padj = _adjust(praw, mcount, posthoc)
            res["comparisons"].append(_comparison(None, i, j, f"{titles[j]} vs. {titles[i]}", diff, se, "t", tv, dfw,
                                                  praw, padj, diff - tcrit * se, diff + tcrit * se, alpha))


def _adjust(p: float, m: int, how: str) -> float:
    if how == "sidak":
        return _sidak(p, m)
    return float(min(1.0, m * p))


def _sidak(p: float, m: float) -> float:
    """1 - (1 - p)^m without losing tiny p to rounding."""
    if p >= 1:
        return 1.0
    return float(min(1.0, -math.expm1(m * math.log1p(-p))))


def _welch_anova(tb, an, groups, usable, gs, k, pairs, res):
    titles, alpha, posthoc = tb["col_titles"], an["alpha"], an["posthoc"]
    ns = np.array([len(g) for g in gs], dtype=float)
    note = None
    F = p = df2 = None
    if np.any(ns < 2):
        note = "Every column needs at least 2 values"
    else:
        vs = np.array([np.var(g, ddof=1) for g in gs])
        if not np.all(np.isfinite(vs)):
            note = TOO_LARGE_NOTE
        elif any(_tiny(v * (len(g) - 1), _sumsq(g)) for v, g in zip(vs, gs)):
            note = "A column has zero variance: Welch's ANOVA can't be computed"
        else:
            ms = np.array([np.mean(g) for g in gs])
            w = ns / vs
            W = w.sum()
            mw = float((w * ms).sum() / W)
            A = float((w * (ms - mw) ** 2).sum() / (k - 1))
            lam = float(((1 - w / W) ** 2 / (ns - 1)).sum())
            B = 1 + 2 * (k - 2) / (k * k - 1) * lam
            F = A / B
            df2 = (k * k - 1) / (3 * lam)
            p = float(ss.f.sf(F, k - 1, df2))
    res["test"] = _test("welch_anova", None, "W", F, k - 1, df2, p, alpha, note)
    if posthoc != "games_howell" or not pairs:
        return
    for i, j in pairs:
        a, b = groups[i], groups[j]
        diff = float(np.mean(b) - np.mean(a))
        lab = f"{titles[j]} vs. {titles[i]}"
        if len(a) < 2 or len(b) < 2:
            res["comparisons"].append(_comparison(None, i, j, lab, diff, alpha=alpha,
                                                  note="Each group needs at least 2 values"))
            continue
        va, vb = np.var(a, ddof=1) / len(a), np.var(b, ddof=1) / len(b)
        if _finite(va, vb) and _tiny((va * len(a)) * (len(a) - 1) + (vb * len(b)) * (len(b) - 1), _sumsq(a, b)):
            res["comparisons"].append(_comparison(None, i, j, lab, diff, alpha=alpha,
                                                  note="Zero variance in both groups"))
            continue
        se = math.sqrt(va + vb)
        dfw = (va + vb) ** 2 / (va ** 2 / (len(a) - 1) + vb ** 2 / (len(b) - 1))
        if not _finite(se, dfw, diff):
            res["comparisons"].append(_comparison(None, i, j, lab, diff, alpha=alpha, note=TOO_LARGE_NOTE))
            continue
        q = abs(diff) / se * math.sqrt(2)
        pv = float(ptukey_sf(q, k, dfw)[0])
        h = qtukey(0.95, k, round(dfw, 9)) / math.sqrt(2) * se
        res["comparisons"].append(_comparison(None, i, j, lab, diff, se, "q", q, dfw, pv, pv, diff - h, diff + h, alpha))


def _kruskal(tb, an, groups, usable, gs, k, N, pairs, res):
    titles, alpha, posthoc = tb["col_titles"], an["alpha"], an["posthoc"]
    allv = np.concatenate(gs)
    note = None
    H = p = None
    if float(np.ptp(allv)) == 0:
        note = "All values are identical: the test can't be computed"
    else:
        r = ss.kruskal(*gs)
        H, p = float(r.statistic), float(r.pvalue)
    res["test"] = _test("kruskal", None, "H", H, k - 1, None, p, alpha, note)
    if posthoc != "dunn" or not pairs:
        return
    ranks = ss.rankdata(allv)
    pos, mean_rank = 0, {}
    for c, g in zip(usable, gs):
        mean_rank[c] = float(np.mean(ranks[pos:pos + len(g)]))
        pos += len(g)
    _, counts = np.unique(allv, return_counts=True)
    tie = float(np.sum(counts ** 3 - counts)) / (12 * (N - 1))
    base = N * (N + 1) / 12 - tie
    mcount = len(pairs)
    for i, j in pairs:
        lab = f"{titles[j]} vs. {titles[i]}"
        diff = mean_rank[j] - mean_rank[i]
        if note or base <= 0:
            res["comparisons"].append(_comparison(None, i, j, lab, diff, alpha=alpha, note=note or "No variation"))
            continue
        se = math.sqrt(base * (1 / len(groups[i]) + 1 / len(groups[j])))
        z = diff / se
        praw = float(2 * ss.norm.sf(abs(z)))
        res["comparisons"].append(_comparison(None, i, j, lab, diff, se, "z", z, None, praw,
                                              min(1.0, mcount * praw), None, None, alpha,
                                              "diff = difference in mean ranks"))


# ── Grouped tables (two-way ANOVA) ──────────────────────────────────────────
#
# Type III sums of squares from the cell means (every cell is non-empty, so the
# cell-means model is the full model): the residual is the pooled within-cell
# SS; the interaction SS is the weighted (by n) lack of fit of the additive
# model to the cell means; a main-effect SS tests equality of the unweighted
# marginal means, which are independent across levels with variance
# sigma^2 * sum_c(1/n_rc) / C^2. This equals the effect-coded (contr.sum)
# regression of R's car::Anova(type = 3) without building the N x (R*C)
# design, so the cost is O(N + R*C*min(R, C)^2) instead of O(N * (R*C)^2).

def _additive_fit(m: np.ndarray, n: np.ndarray) -> np.ndarray:
    """Fitted cell means of the weighted (weights n) additive model
    mean_rc = a_r + b_c, via the reduced normal equations of the smaller factor."""
    if m.shape[0] < m.shape[1]:
        return _additive_fit(m.T, n.T).T
    nr = n.sum(axis=1)                                   # eliminate the (larger) row factor
    T = (n * m).sum(axis=1)
    A = np.diag(n.sum(axis=0)) - n.T @ (n / nr[:, None])
    rhs = (n * m).sum(axis=0) - n.T @ (T / nr)
    b = np.linalg.lstsq(A, rhs, rcond=None)[0]
    a = (T - n @ b) / nr
    return a[:, None] + b[None, :]


def _marginal_ss(m: np.ndarray, n: np.ndarray) -> float:
    """Type III SS of the row factor: equality of unweighted row means."""
    C = m.shape[1]
    mm = m.mean(axis=1)
    w = 1.0 / ((1.0 / n).sum(axis=1) / (C * C))
    return float(np.sum(w * (mm - np.sum(w * mm) / np.sum(w)) ** 2))


def two_way_anova(cells: Dict[Tuple[int, int], np.ndarray], R: int, C: int, interaction: bool = True) -> dict:
    """Type III two-way ANOVA. `cells[(r, c)]` holds the values of row level r /
    column level c (every cell non-empty)."""
    n = np.zeros((R, C))
    m = np.zeros((R, C))
    sse = scale = 0.0
    for (r, c), v in cells.items():
        v = np.asarray(v, dtype=float)
        n[r, c] = len(v)
        m[r, c] = float(np.mean(v))
        sse += float(np.sum((v - m[r, c]) ** 2))
        scale += float(np.sum(v * v))
    N = int(n.sum())
    lack = float(np.sum(n * (m - _additive_fit(m, n)) ** 2))       # additive model vs cell means
    if interaction:
        rss_full = sse
        df_res = N - R * C
        terms = [("Interaction", lack, (R - 1) * (C - 1)), ("Row factor", _marginal_ss(m, n), R - 1),
                 ("Column factor", _marginal_ss(m.T, n.T), C - 1)]
    else:
        rss_full = sse + lack
        df_res = N - (R + C - 1)
        col_w = (n * m).sum(axis=0) / n.sum(axis=0)              # model without the row factor
        row_w = (n * m).sum(axis=1) / n.sum(axis=1)              # model without the column factor
        terms = [("Row factor", float(np.sum(n * (m - col_w[None, :]) ** 2)) - lack, R - 1),
                 ("Column factor", float(np.sum(n * (m - row_w[:, None]) ** 2)) - lack, C - 1)]
    too_large = not _finite(rss_full, scale, *[t[1] for t in terms])
    untestable = too_large or df_res < 1 or _tiny(rss_full, scale)
    mse = None if untestable else rss_full / df_res
    rows = []
    for name, ss_term, df in terms:
        ss_term = max(0.0, ss_term)
        F = p = None
        if mse is not None:
            F = (ss_term / df) / mse
            p = float(ss.f.sf(F, df, df_res))
        rows.append({"source": name, "ss": _num(ss_term), "df": df, "ms": _num(ss_term / df), "f": _num(F), "p": _num(p)})
    rows.append({"source": "Residual", "ss": _num(rss_full), "df": df_res,
                 "ms": _num(rss_full / df_res) if df_res > 0 else None, "f": None, "p": None})
    return {"rows": rows, "mse": mse, "df_res": df_res, "rss": rss_full, "N": N, "too_large": too_large}


def _grouped(tb, an, res):
    rtitles, ctitles = tb["row_titles"], tb["col_titles"]
    alpha = an["alpha"]
    R0, C0 = tb["n_rows"], tb["n_cols"]
    vals = tb["values"]
    for r in range(R0):
        for c in range(C0):
            res["descriptives"].append({"row": r, "col": c, "label": f"{rtitles[r]} · {ctitles[c]}",
                                        **describe(vals[r][c])})
    if an["test"] == "none":
        return
    rows = [r for r in range(R0) if any(vals[r][c] for c in range(C0))]
    cols = [c for c in range(C0) if any(vals[r][c] for r in range(R0))]
    if len(rows) < R0:
        res["warnings"].append("Rows with no values were ignored.")
    if len(cols) < C0:
        res["warnings"].append("Columns with no values were ignored.")
    if len(rows) < 2 or len(cols) < 2:
        res.update(error="Two-way ANOVA needs at least 2 rows and 2 columns with values.", code="data")
        return
    if any(not vals[r][c] for r in rows for c in cols):
        res.update(error="Every row × column combination needs at least one value for two-way ANOVA.", code="data")
        return
    R, C = len(rows), len(cols)
    cells = {(ri, ci): np.asarray(vals[r][c], dtype=float) for ri, r in enumerate(rows) for ci, c in enumerate(cols)}
    all_single = all(len(v) == 1 for v in cells.values())
    if all_single:
        res["warnings"].append("Only one value per cell: fitted the model without interaction "
                               "(the interaction can't be separated from residual error); no multiple comparisons.")
    fit = two_way_anova(cells, R, C, interaction=not all_single)
    res["anova_table"] = fit["rows"]
    mse, df_res = fit["mse"], fit["df_res"]
    note = None
    if mse is None:
        note = ("No residual degrees of freedom" if df_res < 1 else TOO_LARGE_NOTE if fit["too_large"]
                else "Zero variance within every cell: the test can't be computed")
    # A two-way ANOVA has no single overall P: the headline is the first term
    # (the interaction, or the row factor without one) and says so.
    main = fit["rows"][0]
    tst = _test("two_way", "Type III sums of squares", f"F ({main['source']})", main["f"], main["df"], df_res,
                main["p"], alpha, note)
    tst["label"] = TEST_LABELS["two_way"] + (" (no interaction)" if all_single else "") + f" — {main['source']}"
    tst["term"] = main["source"]
    res["test"] = tst
    if an["posthoc"] == "none" or all_single:
        return
    _two_way_posthoc(tb, an, vals, rows, cols, mse, df_res, note, res)


def _two_way_posthoc(tb, an, vals, rows, cols, mse, df_res, note, res):
    rtitles, ctitles = tb["row_titles"], tb["col_titles"]
    alpha, posthoc = an["alpha"], an["posthoc"]
    within_rows = an["within"] == "rows"
    # "outer" = the level we stay within; "inner" = the levels compared.
    outer, inner = (rows, cols) if within_rows else (cols, rows)
    otitles, ititles = (rtitles, ctitles) if within_rows else (ctitles, rtitles)
    n_inner = tb["n_cols"] if within_rows else tb["n_rows"]
    try:
        if an["compare"] == "control":
            ctrl = an["control"] if an["control"] is not None else 0
            if ctrl >= n_inner:
                raise InvalidAnalysis("The control level doesn't exist in the table.")
            if ctrl not in inner:
                # keep the ANOVA table; only the comparisons need a usable control
                res["warnings"].append(CONTROL_EMPTY_WARNING)
                return
            base = [(ctrl, j) for j in inner if j != ctrl]
        elif an["compare"] == "selected":
            if not an["pairs"]:          # the UI's intermediate state: omnibus only
                res["warnings"].append(NO_PAIRS_WARNING)
                return
            base = []
            for i, j in an["pairs"]:
                if i >= n_inner or j >= n_inner:
                    raise InvalidAnalysis("A selected pair refers to a level that doesn't exist.")
                if i in inner and j in inner:
                    base.append((i, j))
            if len(base) < len(an["pairs"]):
                res["warnings"].append("Comparisons involving a level with no values were skipped.")
        else:
            base = list(itertools.combinations(inner, 2))
    except InvalidAnalysis as e:
        res.update(error=str(e), code="invalid")
        return
    total = len(base) * len(outer)
    if total > MAX_COMPARISONS:
        res["warnings"].append(f"{total} multiple comparisons is too many to list (the limit is {MAX_COMPARISONS}); "
                               "choose fewer pairs, or compare within the other factor.")
        return
    if not total:
        return

    def cell(o, i):
        return vals[o][i] if within_rows else vals[i][o]

    combos = [(o, i, j) for o in outer for i, j in base]
    a_n = np.array([len(cell(o, i)) for o, i, _ in combos], dtype=float)
    b_n = np.array([len(cell(o, j)) for o, _, j in combos], dtype=float)
    diffs = np.array([float(np.mean(cell(o, j)) - np.mean(cell(o, i))) for o, i, j in combos])
    labels = [f"{otitles[o]}: {ititles[j]} vs. {ititles[i]}" for o, i, j in combos]
    if mse is None:
        for (o, i, j), diff, lab in zip(combos, diffs, labels):
            res["comparisons"].append(_comparison(o, i, j, lab, diff, alpha=alpha, note=note))
        return
    ses = np.sqrt(mse * (1 / a_n + 1 / b_n))
    tvs = diffs / ses
    praw = 2 * ss.t.sf(np.abs(tvs), df_res)
    # Family: every comparison ("all", the default), or each row / column separately.
    n_fam = len(outer) if an["family"] == "all" else 1
    m_fam = len(base) * n_fam
    level = "row" if within_rows else "column"
    tk_note = None
    if posthoc == "tukey":
        # Tukey (studentized range, k = levels compared) within each row / column;
        # with one family across the rows / columns the within-row P values are
        # Šídák-combined: P = 1 - (1 - P_tukey)^n_rows, CI at 0.95^(1/n_rows).
        k = len(inner)
        qs = np.abs(tvs) * math.sqrt(2)
        p_tk = ptukey_sf(qs, k, df_res)
        padj = np.array([_sidak(float(p), n_fam) for p in p_tk])
        h = qtukey(0.95 ** (1.0 / n_fam), k, df_res) / math.sqrt(2) * ses
        stat_name, stats_ = "q", qs
        if n_fam > 1:
            tk_note = (f"Tukey within each {level} (k = {k}), Šídák-corrected across the {n_fam} {level}s "
                       "(one family)")
    else:
        padj = np.array([_adjust(float(p), m_fam, posthoc) for p in praw])
        a_adj = (1 - 0.95 ** (1 / m_fam)) if posthoc == "sidak" else 0.05 / m_fam
        h = ss.t.ppf(1 - a_adj / 2, df_res) * ses
        stat_name, stats_ = "t", tvs
    for idx, ((o, i, j), lab) in enumerate(zip(combos, labels)):
        res["comparisons"].append(_comparison(o, i, j, lab, diffs[idx], ses[idx], stat_name, stats_[idx], df_res,
                                              praw[idx], padj[idx], diffs[idx] - h[idx], diffs[idx] + h[idx], alpha,
                                              tk_note))


# ── XY tables ───────────────────────────────────────────────────────────────

def _fmt4(v: float) -> str:
    s = f"{v:.4g}"
    return s


def equation(slope: float, intercept: float) -> str:
    sign = "-" if intercept < 0 else "+"
    return f"Y = {_fmt4(slope)}*X {sign} {_fmt4(abs(intercept))}"


def linreg(x: np.ndarray, y: np.ndarray, alpha: float = 0.05) -> Tuple[dict, Optional[dict]]:
    """Least-squares line; returns (regression row, band or None)."""
    n = len(x)
    out = {"n": int(n), "slope": None, "slope_se": None, "slope_lo": None, "slope_hi": None,
           "intercept": None, "intercept_se": None, "intercept_lo": None, "intercept_hi": None,
           "r2": None, "sy_x": None, "f": None, "df_num": 1, "df_den": None, "p": None, "star": "ns",
           "x_intercept": None, "equation": None, "note": None}
    if n < 2:
        out["note"] = "Needs at least 3 points"
        return out, None
    if float(np.ptp(x)) == 0:
        out["note"] = "All X values are identical: no line can be fitted"
        return out, None
    xbar, ybar = float(np.mean(x)), float(np.mean(y))
    sxx = float(np.sum((x - xbar) ** 2))
    sxy = float(np.sum((x - xbar) * (y - ybar)))
    sst = float(np.sum((y - ybar) ** 2))
    if not (_finite(xbar, ybar, sxx, sxy, sst) and sxx > 0):
        out["note"] = TOO_LARGE_NOTE
        return out, None
    slope = sxy / sxx
    icpt = ybar - slope * xbar
    if not _finite(slope, icpt):
        out["note"] = TOO_LARGE_NOTE
        return out, None
    resid = (y - ybar) - slope * (x - xbar)          # centred: no cancellation against the intercept
    rss = float(np.sum(resid * resid))
    out.update(slope=_num(slope), intercept=_num(icpt), equation=equation(slope, icpt),
               x_intercept=_num(-icpt / slope) if slope != 0 else None)
    if n < 3:
        out["note"] = "Needs at least 3 points for standard errors and P"
        return out, None
    df = n - 2
    out["df_den"] = df
    if sst <= 0:
        out["note"] = "All Y values are identical"
        out["sy_x"] = 0.0
        return out, None
    scale = _sumsq(y) + slope * slope * _sumsq(x)   # magnitude of the fitted values' rounding noise
    if not _finite(rss, scale):
        out["note"] = TOO_LARGE_NOTE
        return out, None
    if _tiny(rss, scale):
        out.update(r2=1.0, sy_x=0.0, note="The points lie exactly on a line: standard errors and P are undefined")
        return out, None
    s = math.sqrt(rss / df)
    se_b = s / math.sqrt(sxx)
    se_a = s * math.sqrt(1 / n + xbar * xbar / sxx)
    if not (_finite(se_b, se_a) and se_b > 0):
        out["note"] = "Standard errors and P are undefined for these values"
        return out, None
    tc = ss.t.ppf(0.975, df)
    tval = slope / se_b
    p = float(2 * ss.t.sf(abs(tval), df))
    out.update(slope_se=_num(se_b), slope_lo=_num(slope - tc * se_b), slope_hi=_num(slope + tc * se_b),
               intercept_se=_num(se_a), intercept_lo=_num(icpt - tc * se_a), intercept_hi=_num(icpt + tc * se_a),
               r2=_num(1 - rss / sst), sy_x=_num(s), f=_num(tval * tval), p=_num(p), star=_star(_num(p), alpha))
    gx = np.linspace(float(np.min(x)), float(np.max(x)), 101)
    gy = icpt + slope * gx
    h = tc * s * np.sqrt(1 / n + (gx - xbar) ** 2 / sxx)
    band = {"x": gx.tolist(), "y": gy.tolist(), "lo": (gy - h).tolist(), "hi": (gy + h).tolist()}
    return out, band


def _spearman_exact_p(xr: np.ndarray, yr: np.ndarray, rho_obs: float) -> float:
    n = len(xr)
    xc = xr - xr.mean()
    perms = np.array(list(itertools.permutations(range(n))), dtype=np.int16)
    Y = yr[perms]
    Yc = Y - Y.mean(axis=1, keepdims=True)
    num = Yc @ xc
    den = np.sqrt((xc ** 2).sum() * (Yc ** 2).sum(axis=1))
    rho = num / den
    return float(np.mean(np.abs(rho) >= abs(rho_obs) - 1e-12))


def correlation(x: np.ndarray, y: np.ndarray, method: str, alpha: float = 0.05) -> dict:
    n = len(x)
    out = {"method": method, "n": int(n), "r": None, "p": None, "ci_lo": None, "ci_hi": None, "star": "ns", "note": None}
    if n < 3:
        out["note"] = "Needs at least 3 X values"
        return out
    if float(np.ptp(x)) == 0 or float(np.ptp(y)) == 0:
        out["note"] = "X or Y is constant: correlation is undefined"
        return out
    if method == "pearson":
        r, p = ss.pearsonr(x, y)
        out.update(r=_num(r), p=_num(p))
        if n >= 4 and abs(r) < 1:
            z, se = math.atanh(r), 1 / math.sqrt(n - 3)
            zc = ss.norm.ppf(0.975)
            out.update(ci_lo=_num(math.tanh(z - zc * se)), ci_hi=_num(math.tanh(z + zc * se)))
    else:
        xr, yr = ss.rankdata(x), ss.rankdata(y)
        rho = float(np.corrcoef(xr, yr)[0, 1])
        if n <= SPEARMAN_EXACT_N_MAX:
            p = _spearman_exact_p(xr, yr, rho)
            out["note"] = "Exact permutation P"
        else:
            p = float(ss.spearmanr(x, y).pvalue)
        out.update(r=_num(rho), p=_num(p))
    out["star"] = _star(out["p"], alpha)
    return out


def _xy(tb, an, res):
    titles = tb["col_titles"]
    alpha = an["alpha"]
    xs, vals = tb["x"], tb["values"]
    missing_x = [r for r in range(tb["n_rows"]) if xs[r] is None and any(vals[r])]
    if missing_x:
        res["warnings"].append(f"{len(missing_x)} row(s) with Y values but no X value were ignored.")
    for r in range(tb["n_rows"]):
        for c in range(tb["n_cols"]):
            if xs[r] is None or not vals[r][c]:
                continue
            res["descriptives"].append({"row": r, "col": c, "label": f"{titles[c]} at X = {xs[r]:g}",
                                        **describe(vals[r][c])})
    bands = {}
    if an["test"] == "linreg":
        fitted = 0
        for c in range(tb["n_cols"]):
            px = [xs[r] for r in range(tb["n_rows"]) if xs[r] is not None for _ in vals[r][c]]
            py = [v for r in range(tb["n_rows"]) if xs[r] is not None for v in vals[r][c]]
            if not py:
                continue
            row, band = linreg(np.asarray(px, float), np.asarray(py, float), alpha)
            if row["slope"] is not None:
                fitted += 1
            res["regression"].append({"col": c, "label": titles[c], **row})
            if band:
                bands[c] = band
        if fitted == 0:
            msg = next((r["note"] for r in res["regression"] if r["note"]), None) or "No data set has enough points to fit a line."
            res.update(error=msg, code="data")
        res["test"] = None
    res["_bands"] = bands
    if an["correlation"] != "none":
        for c in range(tb["n_cols"]):
            pts = [(xs[r], float(np.mean(vals[r][c]))) for r in range(tb["n_rows"]) if xs[r] is not None and vals[r][c]]
            if not pts:
                continue
            x = np.array([p[0] for p in pts]); y = np.array([p[1] for p in pts])
            res["correlation"].append({"col": c, "label": titles[c], **correlation(x, y, an["correlation"], alpha)})


# ── significance-bracket geometry ───────────────────────────────────────────

def p_label(p: float) -> str:
    if p < 0.0001:
        return "P<0.0001"
    return "P=" + f"{p:.3g}"


def stack_brackets(brackets: List[dict], y_range: float) -> List[dict]:
    """Assign y (and a stacking level) to brackets [{x1, x2, top, label}].
    Shorter spans are placed first; ties broken by the left x. Each bracket
    starts one step (0.08 * range) above its own `top` and moves up until it is
    at least one step away from every already-placed bracket whose x-span
    overlaps it (touching counts as overlap). Placing by y, not by level index,
    keeps brackets with different tops (grouped clusters) from landing on the
    same line; with a shared top it gives the classic lowest-free-level stack."""
    rng = y_range if y_range and y_range > 0 else 1.0
    step = 0.08 * rng
    items = []
    for b in brackets:
        lo, hi = min(b["x1"], b["x2"]), max(b["x1"], b["x2"])
        items.append({**b, "_lo": lo, "_hi": hi})
    items.sort(key=lambda b: (round(b["_hi"] - b["_lo"], 6), round(b["_lo"], 6)))  # rounded: float noise must not reorder
    placed: List[dict] = []
    for b in items:
        over = sorted((p["y"] for p in placed if not (p["_hi"] < b["_lo"] or b["_hi"] < p["_lo"])))
        y = b["top"] + step
        for py in over:
            if abs(py - y) < step * (1 - 1e-9):
                y = py + step
        b["y"] = y
        b["level"] = max(0, int(round((y - b["top"]) / step)) - 1)
        b["tick"] = 0.02 * rng
        placed.append(b)
    return [{k: v for k, v in b.items() if not k.startswith("_")} for b in placed]
