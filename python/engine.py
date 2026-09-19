"""
GridPoint — Module A2: cost, comparison and the run() pipeline.

Hack-a-Matics 2026, theme VECTOR, problem statement GRIDPOINT.

This is the single entry point to the compute side. `app.py` calls `run()` and
renders what comes back. `engine.py` imports `solver.py` and nothing else from
the project.

    data.py  ->  solver.py  ->  engine.py  ->  app.py

Public API:
    run(neighborhoods, K, constraints=None, ...) -> RESULT dict
    weighted_cost(neighborhoods, result) -> float      (re-exported from solver)
    centroid_baseline(neighborhoods) -> plan
    kmeans_baseline(neighborhoods, K) -> plan
    comparison_ladder(neighborhoods, K, optimized) -> list of rungs
    impact(saving_order_km, cost_per_km, co2_g_per_km) -> dict
    robustness(neighborhoods, K, warehouses, ...) -> dict
    cross_check(neighborhoods, K) -> "PASS" | "FAIL" | "SKIP"

A "plan" everywhere below means {"warehouses": [...], "assignments": {...}},
the same two frozen keys `solve()` returns, so `weighted_cost` scores every
plan with the one shared function. Three separately written cost loops is how
a demo ends up showing numbers that disagree with each other.

Pure standard library. No file I/O, no printing outside __main__ and
cross_check().
"""

import random

from solver import solve, haversine, weighted_cost, SAMPLE_NEIGHBORHOODS

# The frozen output contract. app.py depends on exactly these five keys.
RESULT_KEYS = ("warehouses", "assignments", "total_cost", "baseline_cost", "improvement_pct")

# Fixed so the demo gives the same comparison numbers every run.
DEFAULT_SEED = 20260919

BASELINE_DEFINITION = (
    "One warehouse at the plain (unweighted) centroid of all neighborhoods: "
    "the point you would pick by eyeballing the middle of the map. Every "
    "neighborhood is served from there."
)


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def _nearest_assignment(neighborhoods, warehouses):
    """Assign every neighborhood to its nearest warehouse (haversine)."""
    return {
        n["id"]: min(
            warehouses,
            key=lambda w: haversine(n["lat"], n["lon"], w["lat"], w["lon"]),
        )["id"]
        for n in neighborhoods
    }


def _plan(centres, neighborhoods, prefix="B"):
    """Turn a list of (lat, lon) centres into a plan with nearest assignment."""
    warehouses = [
        {"id": f"{prefix}{i + 1}", "lat": float(lat), "lon": float(lon)}
        for i, (lat, lon) in enumerate(centres)
    ]
    return {"warehouses": warehouses, "assignments": _nearest_assignment(neighborhoods, warehouses)}


def improvement_pct(baseline_cost, total_cost):
    """
    100 * (baseline - optimized) / baseline.

    Positive means the optimized plan is cheaper. Returns 0.0 when the
    baseline itself costs nothing (every neighborhood on the same point), so
    the UI never sees a division by zero.
    """
    if baseline_cost <= 0:
        return 0.0
    return 100.0 * (baseline_cost - total_cost) / baseline_cost


# ---------------------------------------------------------------------------
# Rung 1 — the naive "original arrangement"
# ---------------------------------------------------------------------------

def centroid_baseline(neighborhoods):
    """
    The unoptimized arrangement used for `baseline_cost`.

    See BASELINE_DEFINITION. Unweighted on purpose: the point is to model what
    someone does before any optimization, and eyeballing a map does not weight
    by orders.
    """
    n = len(neighborhoods)
    lat = sum(p["lat"] for p in neighborhoods) / n
    lon = sum(p["lon"] for p in neighborhoods) / n
    return _plan([(lat, lon)], neighborhoods, prefix="C")


# ---------------------------------------------------------------------------
# Rung 2 — the industry-standard answer: textbook k-means
# ---------------------------------------------------------------------------

def kmeans_baseline(neighborhoods, K, restarts=20, seed=DEFAULT_SEED):
    """
    What most teams ship: plain Lloyd k-means on raw (lat, lon) degrees,
    unweighted centroids, squared Euclidean distance, best of `restarts`
    random starts. This is what `sklearn.cluster.KMeans().fit(coords)` does
    to a coordinate table.

    It is the wrong model for delivery on three counts, each of which the
    GridPoint solver fixes:
      * squared distance     -> vans pay linear distance (k-median, not k-means)
      * unweighted centroid  -> a 900-order neighborhood should pull harder
      * degrees as a plane   -> a degree of longitude is shorter than latitude

    To keep the comparison fair the resulting centres are STILL scored with
    the shared weighted haversine cost and nearest-warehouse assignment, so
    the only thing being compared is where the warehouses ended up.
    Constraints are ignored here: this is a baseline, not a solution.
    """
    K = min(K, len(neighborhoods))
    rng = random.Random(seed)
    best_centres, best_cost = None, float("inf")

    for _ in range(restarts):
        centres = [(n["lat"], n["lon"]) for n in rng.sample(neighborhoods, K)]
        for _ in range(100):
            groups = [[] for _ in range(K)]
            for n in neighborhoods:
                j = min(range(K), key=lambda j: (n["lat"] - centres[j][0]) ** 2
                                                  + (n["lon"] - centres[j][1]) ** 2)
                groups[j].append(n)
            new = [
                (sum(n["lat"] for n in g) / len(g), sum(n["lon"] for n in g) / len(g)) if g else centres[j]
                for j, g in enumerate(groups)
            ]
            if new == centres:
                break
            centres = new

        plan = _plan(centres, neighborhoods, prefix="K")
        cost = weighted_cost(neighborhoods, plan)
        if cost < best_cost:
            best_centres, best_cost = centres, cost

    return _plan(best_centres, neighborhoods, prefix="K")


def comparison_ladder(neighborhoods, K, optimized):
    """
    Three rungs, worst to best, each scored with the same cost function.
    `improvement_pct` on every rung is relative to rung 1 (the naive
    baseline), so the numbers read as a running total of savings.
    """
    rungs = [
        ("naive", "Naive: one warehouse at the map centre", centroid_baseline(neighborhoods)),
        ("kmeans", f"Textbook k-means, K={min(K, len(neighborhoods))}", kmeans_baseline(neighborhoods, K)),
        ("gridpoint", f"GridPoint weighted k-median, K={len(optimized['warehouses'])}", optimized),
    ]
    naive_cost = weighted_cost(neighborhoods, rungs[0][2])
    out = []
    for key, label, plan in rungs:
        cost = weighted_cost(neighborhoods, plan)
        out.append({
            "key": key,
            "label": label,
            "cost": float(cost),
            "improvement_pct": float(improvement_pct(naive_cost, cost)),
            "warehouses": plan["warehouses"],
            "assignments": plan["assignments"],
        })
    # Saving of each rung over the one just below it: "what did THIS idea buy?"
    for prev, cur in zip(out, out[1:]):
        cur["saving_vs_prev_pct"] = float(improvement_pct(prev["cost"], cur["cost"]))
    out[0]["saving_vs_prev_pct"] = None
    return out


# ---------------------------------------------------------------------------
# Real units — order-km is not a number anyone remembers
# ---------------------------------------------------------------------------

def impact(saving_order_km, cost_per_km=None, co2_g_per_km=None, days_per_year=365):
    """
    Translate a saving in order-km into things a judge remembers.

    Assumption, stated on screen: one order = one one-way delivery trip, so
    an order-km saved is a kilometre a van does not drive. `cost_per_km`
    (currency per km) and `co2_g_per_km` (grams CO2 per km) are USER-SET
    parameters from the app, not facts this module claims to know. Either may
    be None, in which case that line is left out.
    """
    out = {
        "assumption": "one order = one one-way delivery trip",
        "km_per_day": float(saving_order_km),
        "km_per_year": float(saving_order_km * days_per_year),
    }
    if cost_per_km is not None:
        out["cost_per_day"] = float(saving_order_km * cost_per_km)
        out["cost_per_year"] = float(saving_order_km * cost_per_km * days_per_year)
    if co2_g_per_km is not None:
        out["co2_kg_per_day"] = float(saving_order_km * co2_g_per_km / 1000.0)
        out["co2_tonnes_per_year"] = float(saving_order_km * co2_g_per_km * days_per_year / 1_000_000.0)
    return out


# ---------------------------------------------------------------------------
# Robustness — does the plan survive demand changes?
# ---------------------------------------------------------------------------

def robustness(neighborhoods, K, warehouses, trials=200, shift=0.30,
               constraints=None, seed=DEFAULT_SEED):
    """
    Stress test. `trials` times: nudge every neighborhood's daily orders by a
    random factor in [1 - shift, 1 + shift], keep the given warehouses where
    they are (re-assigning nearest), and compare that cost with what a fresh
    re-optimization on the shifted demand would achieve.

    Returns how far (percent) the fixed plan sits above the re-optimized
    ideal: mean, worst, and how many trials stayed within 5%. Small numbers
    mean the warehouse sites are a robust decision, not a fit to one day's
    data. Deterministic for a given seed.
    """
    rng = random.Random(seed)
    gaps = []
    for _ in range(trials):
        shifted = [dict(n, orders=max(0, round(n["orders"] * rng.uniform(1 - shift, 1 + shift))))
                   for n in neighborhoods]
        fixed = {"warehouses": warehouses, "assignments": _nearest_assignment(shifted, warehouses)}
        fixed_cost = weighted_cost(shifted, fixed)
        ideal_cost = weighted_cost(shifted, solve(shifted, K, constraints))
        gaps.append(0.0 if ideal_cost <= 0 else 100.0 * (fixed_cost - ideal_cost) / ideal_cost)
    return {
        "trials": trials,
        "demand_shift_pct": float(shift * 100),
        "mean_gap_pct": float(sum(gaps) / len(gaps)),
        "worst_gap_pct": float(max(gaps)),
        "within_5pct": int(sum(g <= 5.0 for g in gaps)),
    }


# ---------------------------------------------------------------------------
# run() — the pipeline app.py calls
# ---------------------------------------------------------------------------

def run(neighborhoods, K, constraints=None, cost_per_km=None, co2_g_per_km=None,
        robustness_trials=0):
    """
    Full compute pipeline.

      1. placement     = solve(neighborhoods, K, constraints)      # A1
      2. total_cost    = weighted cost of that placement
      3. baseline_cost = weighted cost of centroid_baseline()
      4. improvement_pct
      5. comparison ladder (naive -> k-means -> GridPoint)
      6. impact in real units, robustness stress test (optional)

    Returns the RESULT contract:
        {
          "warehouses":      [{"id", "lat", "lon"}],
          "assignments":     {neighborhood_id: warehouse_id},
          "total_cost":      float,   # optimized weighted cost, order-km
          "baseline_cost":   float,   # naive single central warehouse
          "improvement_pct": float,   # 100 * (baseline - total) / baseline
        }
    plus these ADDITIVE keys (app.py may ignore any of them):
          "baseline":    {"definition", "warehouses", "assignments"}
          "comparison":  [rung, rung, rung]   see comparison_ladder()
          "impact":      see impact()
          "robustness":  see robustness(), or None when robustness_trials == 0
          loads / distances_km / unserved / over_capacity   passed through
                                                            from solve()

    `cost_per_km` and `co2_g_per_km` are user-set sliders in the app.
    `robustness_trials` is 0 by default because each trial re-runs the
    solver. Measured on the 13-neighborhood sample: 50 trials took about
    4 seconds, so 50 is the demo value; 200 is for the write-up, not the
    live click.
    """
    if not neighborhoods:
        raise ValueError("run: neighborhoods is empty")

    placement = solve(neighborhoods, K, constraints)
    total_cost = weighted_cost(neighborhoods, placement)

    baseline = centroid_baseline(neighborhoods)
    baseline_cost = weighted_cost(neighborhoods, baseline)

    result = dict(placement)  # keeps solver's additive keys
    result.update({
        "warehouses": placement["warehouses"],
        "assignments": placement["assignments"],
        "total_cost": float(total_cost),
        "baseline_cost": float(baseline_cost),
        "improvement_pct": float(improvement_pct(baseline_cost, total_cost)),
        "baseline": {"definition": BASELINE_DEFINITION, **baseline},
        "comparison": comparison_ladder(neighborhoods, K, placement),
        "impact": impact(baseline_cost - total_cost, cost_per_km, co2_g_per_km),
        "robustness": (robustness(neighborhoods, K, placement["warehouses"],
                                  trials=robustness_trials, constraints=constraints)
                       if robustness_trials > 0 else None),
    })
    return result


# ---------------------------------------------------------------------------
# Cross-check against the exact brute-force verifier (Rajath, verifier.py)
# ---------------------------------------------------------------------------

def _cost_of(verifier_output, neighborhoods):
    """
    Accept the verifier's answer as either a plan, a dict carrying a cost, or
    a bare number. ASSUMPTION (unverified until verifier.py lands): it exposes
    solve_exact(neighborhoods, K) returning one of those shapes.
    """
    if isinstance(verifier_output, (int, float)):
        return float(verifier_output)
    if isinstance(verifier_output, dict):
        if "warehouses" in verifier_output and "assignments" in verifier_output:
            return weighted_cost(neighborhoods, verifier_output)
        for key in ("total_cost", "cost"):
            if key in verifier_output:
                return float(verifier_output[key])
    raise TypeError(f"cross_check: unrecognised verifier output {type(verifier_output).__name__}")


def cross_check(neighborhoods, K, tolerance_pct=1.0, verbose=True):
    """
    Compare run()'s optimized cost with verifier.solve_exact on a small
    instance (N <= 10, K <= 3 recommended: brute force is exponential).

    PASS  heuristic within `tolerance_pct` of the exact optimum, or cheaper
          (the verifier may search only discrete candidate sites, while the
          solver places warehouses anywhere, so beating it is legitimate).
    FAIL  heuristic more than `tolerance_pct` above the exact optimum.
    SKIP  verifier.py not importable yet.

    Prints one line and returns the verdict string.
    """
    try:
        from verifier import solve_exact
    except ImportError as e:
        if verbose:
            print(f"[SKIP] verifier cross-check: {e}")
        return "SKIP"

    if len(neighborhoods) > 10 or K > 3:
        if verbose:
            print(f"[SKIP] verifier cross-check: N={len(neighborhoods)}, K={K} too large for brute force")
        return "SKIP"

    ours = run(neighborhoods, K)["total_cost"]
    exact = _cost_of(solve_exact(neighborhoods, K), neighborhoods)
    gap_pct = 0.0 if exact <= 0 else 100.0 * (ours - exact) / exact
    verdict = "PASS" if gap_pct <= tolerance_pct else "FAIL"
    if verbose:
        note = " (heuristic beat the discrete optimum)" if gap_pct < -1e-9 else ""
        print(f"[{verdict}] N={len(neighborhoods)} K={K}  heuristic {ours:,.2f}  "
              f"exact {exact:,.2f}  gap {gap_pct:+.3f}%{note}")
    return verdict


# ---------------------------------------------------------------------------
# Acceptance run:  python engine.py
# ---------------------------------------------------------------------------

def _check_result_shape(r):
    """Assert the frozen contract: five keys, correct types, ids consistent."""
    for k in RESULT_KEYS:
        assert k in r, f"RESULT missing key {k!r}"
    assert isinstance(r["warehouses"], list) and r["warehouses"], "warehouses must be a non-empty list"
    for w in r["warehouses"]:
        assert set(w) >= {"id", "lat", "lon"}, f"warehouse missing id/lat/lon: {w}"
        assert isinstance(w["id"], str) and isinstance(w["lat"], float) and isinstance(w["lon"], float)
    assert isinstance(r["assignments"], dict)
    wids = {w["id"] for w in r["warehouses"]}
    assert set(r["assignments"].values()) <= wids, "assignment points at an unknown warehouse id"
    for k in ("total_cost", "baseline_cost", "improvement_pct"):
        assert isinstance(r[k], float), f"{k} must be float, got {type(r[k]).__name__}"


if __name__ == "__main__":
    nb = SAMPLE_NEIGHBORHOODS
    total_orders = sum(n["orders"] for n in nb)

    print("GridPoint — engine.py")
    print(f"{len(nb)} neighborhoods, {total_orders} daily orders")
    print(f"baseline = {BASELINE_DEFINITION}\n")

    # 1. Frozen contract, every K, and optimizing must never lose to the baseline.
    for K in (1, 2, 3, 4):
        r = run(nb, K)
        _check_result_shape(r)
        assert set(r["assignments"]) == {n["id"] for n in nb}, "every neighborhood must be assigned"
        assert r["total_cost"] <= r["baseline_cost"] + 1e-9, f"K={K}: optimized cost above baseline"
        print(f"K={K}  optimized {r['total_cost']:10,.1f}   baseline {r['baseline_cost']:10,.1f}"
              f"   improvement {r['improvement_pct']:5.1f}%   shape OK")

    # 2. The comparison ladder, with the full RESULT for the demo K.
    K = 3
    r = run(nb, K, cost_per_km=12.0, co2_g_per_km=150.0, robustness_trials=50)
    print(f"\nComparison ladder, K={K}  (cost in order-km; % vs the naive rung)")
    for rung in r["comparison"]:
        prev = "" if rung["saving_vs_prev_pct"] is None else f"   saves {rung['saving_vs_prev_pct']:4.1f}% over the rung below"
        print(f"  {rung['label']:46s} {rung['cost']:10,.0f}   {rung['improvement_pct']:5.1f}%{prev}")

    imp = r["impact"]
    print(f"\nImpact vs naive  (demo sliders: 12.0 currency/km, 150 g CO2/km; {imp['assumption']})")
    print(f"  {imp['km_per_day']:12,.0f} km/day not driven      {imp['km_per_year']:14,.0f} km/year")
    print(f"  {imp['cost_per_day']:12,.0f} currency/day saved    {imp['cost_per_year']:14,.0f} currency/year")
    print(f"  {imp['co2_kg_per_day']:12,.0f} kg CO2/day avoided    {imp['co2_tonnes_per_year']:14,.1f} tonnes CO2/year")

    rb = r["robustness"]
    print(f"\nRobustness  ({rb['trials']} trials, demand shifted up to ±{rb['demand_shift_pct']:.0f}% per neighborhood)")
    print(f"  fixed plan is on average {rb['mean_gap_pct']:.1f}% above re-optimizing, worst {rb['worst_gap_pct']:.1f}%,"
          f" {rb['within_5pct']}/{rb['trials']} trials within 5%")

    # 3. Exact-optimum cross-check on a small slice (N=8, K=2).
    print("\nVerifier cross-check")
    small = sorted(nb, key=lambda n: n["id"])[:8]
    cross_check(small, 2)

    # 4. The RESULT dict itself, frozen keys only, as app.py will see them.
    print("\nRESULT (frozen keys)")
    for k in RESULT_KEYS:
        v = r[k]
        if k == "assignments":
            v = dict(sorted(v.items()))
        print(f"  {k:16s} {v if not isinstance(v, float) else round(v, 2)}")
    print(f"  additive keys    {sorted(set(r) - set(RESULT_KEYS))}")
