"""
GridPoint — Module C: standalone exact verifier (Rajath).

Independent check on solver.py. This file deliberately imports NOTHING from
the rest of the project - its own haversine, its own cost loop, its own
optimiser - so that agreeing with solver.py means something. If both files
shared code, a bug in that code would pass unnoticed.

Two exact methods, both brute force, both guaranteed optimal on the instances
they can finish:

  solve_exact(neighborhoods, K)
      DISCRETE optimum: warehouses may only sit ON neighborhood locations.
      Tries every combination of K sites. Fast: C(N, K) evaluations.
      A correct continuous solver must do at least this well.

  solve_exact_continuous(neighborhoods, K)
      CONTINUOUS optimum: warehouses may sit anywhere. Enumerates every way
      to split the neighborhoods into K groups, places each group's warehouse
      at its exact weighted geometric median (found by golden-section search,
      not Weiszfeld - a different algorithm from solver.py, on purpose), and
      keeps the cheapest split. Exponential (Stirling numbers), so N <= 10.
      This is the true optimum of the objective solver.py claims to minimise.

Helpers for the app and for the demo:

  verify(neighborhoods, K, plan)         PASS / FAIL / SKIP for a solver plan
  spot_check(neighborhoods, K, solve_fn) verify on random small sub-instances
                                         when the full dataset is too big

Standard library only.
"""

import math
import itertools
import random

EARTH_RADIUS_KM = 6371.0
KM_PER_DEGREE = math.pi * EARTH_RADIUS_KM / 180.0


def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """
    Calculate the great circle distance in kilometers between two points
    on the earth (specified in decimal degrees).
    """
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)

    a = math.sin(delta_phi / 2) ** 2 + \
        math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

    return EARTH_RADIUS_KM * c


# ---------------------------------------------------------------------------
# Input checks
# ---------------------------------------------------------------------------

def _is_real(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def _validate(neighborhoods, K):
    """Refuse bad input loudly. A verifier that returns cost 0.0 for garbage
    input would report PASS for anything compared against it."""
    if not isinstance(neighborhoods, (list, tuple)) or not neighborhoods:
        raise ValueError("verifier: neighborhoods must be a non-empty list")
    if isinstance(K, bool) or not isinstance(K, int) or K < 1:
        raise ValueError(f"verifier: K must be a whole number >= 1, got {K!r}")
    seen = set()
    for n in neighborhoods:
        for key in ("id", "lat", "lon", "orders"):
            if key not in n:
                raise ValueError(f"verifier: neighborhood missing '{key}': {n!r}")
        if n["id"] in seen:
            raise ValueError(f"verifier: duplicate neighborhood id {n['id']!r}")
        seen.add(n["id"])
        if not _is_real(n["lat"]) or not -90 <= n["lat"] <= 90:
            raise ValueError(f"verifier: {n['id']!r} has invalid latitude {n['lat']!r}")
        if not _is_real(n["lon"]) or not -180 <= n["lon"] <= 180:
            raise ValueError(f"verifier: {n['id']!r} has invalid longitude {n['lon']!r}")
        if not _is_real(n["orders"]) or n["orders"] < 0:
            raise ValueError(f"verifier: {n['id']!r} has invalid orders {n['orders']!r}")


def _distance_matrix(neighborhoods):
    """D[i][j] = km between neighborhood i and neighborhood j. Computed once;
    the combination search then does lookups only, not trigonometry."""
    pts = [(n["lat"], n["lon"]) for n in neighborhoods]
    n = len(pts)
    D = [[0.0] * n for _ in range(n)]
    for i in range(n):
        for j in range(i + 1, n):
            d = haversine(*pts[i], *pts[j])
            D[i][j] = D[j][i] = d
    return D


def weighted_cost(neighborhoods: list, chosen_ids: list) -> float:
    """
    Assign each neighborhood to its nearest chosen warehouse (a set of
    neighborhood ids used as sites), summing (orders * distance).
    """
    chosen = set(chosen_ids)
    warehouses = [n for n in neighborhoods if n["id"] in chosen]

    total_cost = 0.0
    for n in neighborhoods:
        min_dist = float('inf')
        for w in warehouses:
            dist = haversine(n["lat"], n["lon"], w["lat"], w["lon"])
            if dist < min_dist:
                min_dist = dist
        total_cost += n["orders"] * min_dist

    return total_cost


def plan_cost(neighborhoods: list, plan: dict) -> float:
    """
    Cost of a solver-shaped plan {"warehouses": [{id, lat, lon}],
    "assignments": {nid: wid}}, using the assignments AS GIVEN (a plan built
    under a capacity limit may legitimately not use the nearest warehouse).
    Independent re-implementation of solver.weighted_cost.
    """
    wpos = {w["id"]: (w["lat"], w["lon"]) for w in plan["warehouses"]}
    total = 0.0
    for n in neighborhoods:
        wid = plan["assignments"][n["id"]]
        total += n["orders"] * haversine(n["lat"], n["lon"], *wpos[wid])
    return total


# ---------------------------------------------------------------------------
# Exact method 1: discrete (warehouses on neighborhood locations)
# ---------------------------------------------------------------------------

def solve_exact(neighborhoods: list, K: int, max_evaluations: int = 5_000_000) -> dict:
    """
    Exact optimum when warehouses must sit on neighborhood locations.

    Every combination of K sites is scored; nothing is skipped, so the answer
    is the true discrete minimum. Returns a plan in the same shape as
    solver.solve() so the two can be scored by the same code:

        {"warehouses":  [{"id": site_id, "lat", "lon"}],   # id = the neighborhood used as a site
         "assignments": {neighborhood_id: site_id},
         "total_cost":  float,
         "combinations_searched": int}

    Work is C(N, K) * N lookups on a precomputed distance matrix.
    `max_evaluations` stops a request that would run for minutes: raise it
    knowingly, or use spot_check() for large inputs.
    """
    _validate(neighborhoods, K)
    n = len(neighborhoods)
    K = min(K, n)

    combos = math.comb(n, K)
    if combos * n > max_evaluations:
        raise ValueError(
            f"verifier: C({n},{K}) = {combos:,} combinations x {n} neighborhoods exceeds "
            f"max_evaluations={max_evaluations:,}. Use spot_check() or a smaller slice.")

    D = _distance_matrix(neighborhoods)
    orders = [n_["orders"] for n_ in neighborhoods]

    best_cost = float('inf')
    best_sites = None
    for sites in itertools.combinations(range(n), K):
        cost = 0.0
        for i in range(n):
            row = D[i]
            cost += orders[i] * min(row[s] for s in sites)
            if cost >= best_cost:
                break  # cannot beat the incumbent; skip the rest of this combo
        if cost < best_cost:
            best_cost, best_sites = cost, sites

    warehouses = [{"id": neighborhoods[s]["id"], "lat": neighborhoods[s]["lat"],
                   "lon": neighborhoods[s]["lon"]} for s in best_sites]
    assignments = {}
    for i, nb in enumerate(neighborhoods):
        s = min(best_sites, key=lambda s_: D[i][s_])
        assignments[nb["id"]] = neighborhoods[s]["id"]

    return {
        "warehouses": warehouses,
        "assignments": assignments,
        "total_cost": best_cost,
        "combinations_searched": combos,
    }


# ---------------------------------------------------------------------------
# Exact method 2: continuous (warehouses anywhere)
# ---------------------------------------------------------------------------

def _golden_min(f, lo, hi, tol):
    """Golden-section search for the minimum of a unimodal f on [lo, hi].
    Returns (argmin, min). Exact to within `tol` for convex f."""
    if hi - lo <= tol:
        x = (lo + hi) / 2
        return x, f(x)
    invphi = (math.sqrt(5) - 1) / 2
    a, b = lo, hi
    c = b - invphi * (b - a)
    d = a + invphi * (b - a)
    fc, fd = f(c), f(d)
    while b - a > tol:
        if fc < fd:
            b, d, fd = d, c, fc
            c = b - invphi * (b - a)
            fc = f(c)
        else:
            a, c, fc = c, d, fd
            d = a + invphi * (b - a)
            fd = f(d)
    x = (a + b) / 2
    return x, f(x)


def _geometric_median_search(points, precision_km=0.001):
    """
    Weighted geometric median of (lat, lon, w) triples, to within
    `precision_km`, by nested golden-section search.

    The objective  f(lat, lon) = sum_i w_i * dist_i  is convex over a
    city-sized region, and so is  g(lat) = min over lon of f(lat, lon)
    (minimising out one variable preserves convexity). Golden-section search
    is exact for convex functions, so a 1-D search over lat, with an inner
    1-D search over lon at each probe, finds the true minimum - unlike grid
    refinement, which can shrink its box past a minimum lying in a narrow
    diagonal valley (an earlier version of this file did exactly that).

    Shares no code or reasoning with the Weiszfeld iteration in solver.py,
    which is the point of a verifier. Returns (lat, lon, cost).
    """
    if len(points) == 1:
        return points[0][0], points[0][1], 0.0

    def cost_at(la, lo):
        return sum(w * haversine(la, lo, pl, po) for pl, po, w in points)

    lat_lo = min(p[0] for p in points); lat_hi = max(p[0] for p in points)
    lon_lo = min(p[1] for p in points); lon_hi = max(p[1] for p in points)
    mid_lat = (lat_lo + lat_hi) / 2
    tol_lat = precision_km / KM_PER_DEGREE
    tol_lon = precision_km / (KM_PER_DEGREE * max(math.cos(math.radians(mid_lat)), 1e-9))

    inner = {}

    def g(la):
        # Inner search is 10x tighter than the outer one, so the noise in
        # g(la) cannot mislead the outer comparisons near the optimum.
        lo, v = _golden_min(lambda lo_: cost_at(la, lo_), lon_lo, lon_hi, tol_lon / 10)
        inner[la] = lo
        return v

    la, v = _golden_min(g, lat_lo, lat_hi, tol_lat)
    lo = inner.get(la)
    if lo is None:
        lo, v = _golden_min(lambda lo_: cost_at(la, lo_), lon_lo, lon_hi, tol_lon / 10)
    best = (v, la, lo)

    # The minimum of a weighted-distance sum often sits exactly on a data
    # point (a cone tip). Search handles that, but checking the points
    # directly costs nothing and removes any doubt.
    for pl, po, w in points:
        c = cost_at(pl, po)
        if c < best[0]:
            best = (c, pl, po)

    return best[1], best[2], best[0]


def _partitions(n, K):
    """Every split of range(n) into exactly K non-empty groups, as a label
    list (restricted growth strings: label[i] <= max(label[:i]) + 1)."""
    labels = [0] * n

    def rec(i, m):
        if i == n:
            if m == K:
                yield list(labels)
            return
        if n - i < K - m:
            return  # not enough items left to open the remaining groups
        for lab in range(min(m + 1, K)):
            labels[i] = lab
            yield from rec(i + 1, max(m, lab + 1))

    yield from rec(0, 0)


def _stirling2(n, k):
    S = [[0] * (k + 1) for _ in range(n + 1)]
    S[0][0] = 1
    for i in range(1, n + 1):
        for j in range(1, k + 1):
            S[i][j] = j * S[i - 1][j] + S[i - 1][j - 1]
    return S[n][k]


def solve_exact_continuous(neighborhoods: list, K: int, precision_km: float = 0.001,
                           max_n: int = 10) -> dict:
    """
    Exact optimum with warehouses allowed ANYWHERE - the problem solver.py
    actually claims to solve.

    Every partition of the neighborhoods into K groups is enumerated. For each
    group the exact weighted geometric median is computed (cached per group,
    so each of the <= 2^N groups is solved once) and the partition's cost is
    the sum. The cheapest partition is the global optimum: the true optimal
    plan induces SOME partition, and that partition's median cost equals the
    optimum, so the minimum over all partitions can be no higher.

    Cost is accurate to within  total_orders * precision_km  order-km.

    Exponential: S(N, K) partitions and up to 2^N medians. Capped at
    max_n = 10 neighborhoods (about 4 s). Returns the same shape as
    solve_exact() plus "partitions_searched" and "tolerance_order_km".
    """
    _validate(neighborhoods, K)
    n = len(neighborhoods)
    K = min(K, n)
    if n > max_n:
        raise ValueError(f"verifier: continuous brute force is capped at {max_n} neighborhoods "
                         f"(got {n}); use solve_exact() or spot_check() instead")

    pts = [(nb["lat"], nb["lon"], nb["orders"]) for nb in neighborhoods]
    cache = {}

    def median_of(mask):
        if mask not in cache:
            members = [pts[i] for i in range(n) if mask >> i & 1]
            cache[mask] = _geometric_median_search(members, precision_km)
        return cache[mask]

    best_cost, best_labels = float('inf'), None
    searched = 0
    for labels in _partitions(n, K):
        searched += 1
        masks = [0] * K
        for i, lab in enumerate(labels):
            masks[lab] |= 1 << i
        cost = 0.0
        for m in masks:
            cost += median_of(m)[2]
            if cost >= best_cost:
                break
        if cost < best_cost:
            best_cost, best_labels = cost, labels

    masks = [0] * K
    for i, lab in enumerate(best_labels):
        masks[lab] |= 1 << i
    centres = [median_of(m) for m in masks]
    warehouses = [{"id": f"C{k + 1}", "lat": c[0], "lon": c[1]} for k, c in enumerate(centres)]

    # Final plan uses nearest-warehouse assignment, which can only be <= the
    # partition cost.
    assignments, total = {}, 0.0
    for nb in neighborhoods:
        k = min(range(K), key=lambda k_: haversine(nb["lat"], nb["lon"], centres[k_][0], centres[k_][1]))
        assignments[nb["id"]] = warehouses[k]["id"]
        total += nb["orders"] * haversine(nb["lat"], nb["lon"], centres[k][0], centres[k][1])

    return {
        "warehouses": warehouses,
        "assignments": assignments,
        "total_cost": total,
        "partitions_searched": searched,
        "tolerance_order_km": sum(p[2] for p in pts) * precision_km,
    }


# ---------------------------------------------------------------------------
# Verdicts
# ---------------------------------------------------------------------------

def verify(neighborhoods: list, K: int, plan: dict, tolerance_pct: float = 0.1,
           continuous: bool = True) -> dict:
    """
    Independently check a solver plan against the exact optimum.

    Returns:
        {"verdict": "PASS" | "FAIL" | "SKIP",
         "plan_cost", "discrete_optimum", "continuous_optimum" (or None),
         "gap_pct"  : plan cost vs the tightest optimum available (+ = worse),
         "note"     : one plain sentence for the UI}

    PASS  plan is within tolerance_pct of the exact optimum, or better.
    FAIL  plan is more than tolerance_pct above it: the heuristic missed.
    SKIP  instance too large for brute force (N > 10 for continuous; use
          spot_check), or the plan has a different number of warehouses.

    Only meaningful for UNCONSTRAINED plans: a capacity or radius limit can
    legitimately force a plan above the unconstrained optimum.
    """
    _validate(neighborhoods, K)
    n = len(neighborhoods)
    if len(plan["warehouses"]) != min(K, n):
        return {"verdict": "SKIP", "plan_cost": None, "discrete_optimum": None,
                "continuous_optimum": None, "gap_pct": None,
                "note": f"plan has {len(plan['warehouses'])} warehouses, expected {min(K, n)}"}

    pc = plan_cost(neighborhoods, plan)
    try:
        disc = solve_exact(neighborhoods, K)["total_cost"]
    except ValueError as e:
        return {"verdict": "SKIP", "plan_cost": pc, "discrete_optimum": None,
                "continuous_optimum": None, "gap_pct": None, "note": str(e)}

    cont = None
    slack = 0.0
    if continuous and n <= 10:
        res = solve_exact_continuous(neighborhoods, K)
        cont, slack = res["total_cost"], res["tolerance_order_km"]

    # Internal consistency: freeing the warehouses can never cost more than
    # pinning them to neighborhoods. If it does, the continuous search failed
    # and must not be trusted as a reference.
    if cont is not None and cont > disc + slack + 1e-9:
        raise RuntimeError(f"verifier: continuous optimum {cont:,.3f} exceeds discrete optimum "
                           f"{disc:,.3f} - search error, do not trust this result")

    reference = cont if cont is not None else disc
    gap_pct = 0.0 if reference == 0 else (pc - reference) / reference * 100
    ok = pc <= reference * (1 + tolerance_pct / 100) + slack
    kind = "continuous" if cont is not None else "discrete"

    if ok and pc < reference - slack:
        note = f"plan beats the exact {kind} optimum search by {-gap_pct:.3f}% (within grid tolerance)"
    elif ok:
        note = f"plan matches the exact {kind} optimum ({gap_pct:+.3f}%)"
    else:
        note = f"plan is {gap_pct:.2f}% above the exact {kind} optimum"

    return {"verdict": "PASS" if ok else "FAIL", "plan_cost": pc,
            "discrete_optimum": disc, "continuous_optimum": cont,
            "gap_pct": gap_pct, "note": note}


def spot_check(neighborhoods: list, K: int, solve_fn, samples: int = 5, size: int = 8,
               seed: int = 0, tolerance_pct: float = 0.1) -> dict:
    """
    When the dataset is too big for brute force, draw `samples` random
    sub-instances of `size` neighborhoods, solve each with `solve_fn`
    (pass solver.solve - this module never imports it) and verify each
    against the exact optimum.

    Returns {"passed": int, "samples": int, "verdict": "PASS"|"FAIL",
             "results": [verify() dicts]}.

    An honest badge for large uploads: "optimal on 5/5 random sub-instances"
    is evidence the heuristic is working on THIS data, not a guarantee for
    the full instance.
    """
    _validate(neighborhoods, K)
    rng = random.Random(seed)
    n = len(neighborhoods)
    size = min(size, n)
    results = []
    for _ in range(samples if size < n else 1):
        sub = rng.sample(list(neighborhoods), size) if size < n else list(neighborhoods)
        sub.sort(key=lambda x: str(x["id"]))
        plan = solve_fn(sub, min(K, size))
        results.append(verify(sub, min(K, size), plan, tolerance_pct))
    passed = sum(r["verdict"] == "PASS" for r in results)
    return {"passed": passed, "samples": len(results),
            "verdict": "PASS" if passed == len(results) else "FAIL",
            "results": results}


# ---------------------------------------------------------------------------
# Demo — `python verifier.py`
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import json
    import time

    sample_neighborhoods = [
        {"id": "N1", "lat": 12.9716, "lon": 77.5946, "orders": 120},
        {"id": "N2", "lat": 12.9352, "lon": 77.6245, "orders": 80},
        {"id": "N3", "lat": 12.9141, "lon": 77.6353, "orders": 150},
        {"id": "N4", "lat": 12.9856, "lon": 77.5255, "orders": 90},
        {"id": "N5", "lat": 12.9591, "lon": 77.7479, "orders": 200},
        {"id": "N6", "lat": 13.0104, "lon": 77.5511, "orders": 60}
    ]

    K = 2
    print("GridPoint — verifier.py (exact brute force)\n")
    t = time.time()
    disc = solve_exact(sample_neighborhoods, K)
    print(f"Discrete optimum, K={K}  ({disc['combinations_searched']} combinations, {time.time()-t:.3f}s)")
    print(json.dumps({k: disc[k] for k in ("warehouses", "assignments", "total_cost")}, indent=2))

    t = time.time()
    cont = solve_exact_continuous(sample_neighborhoods, K)
    print(f"\nContinuous optimum, K={K}  ({cont['partitions_searched']} partitions, {time.time()-t:.3f}s)")
    print(json.dumps({k: cont[k] for k in ("warehouses", "assignments", "total_cost")}, indent=2))
    print(f"\ncontinuous beats discrete by {(disc['total_cost']-cont['total_cost'])/disc['total_cost']*100:.2f}% "
          f"(warehouses free to sit anywhere)")

    # Optional: if solver.py is on the path, cross-check it live.
    try:
        from solver import solve, SAMPLE_NEIGHBORHOODS
    except ImportError:
        solve = None
    if solve is not None:
        print("\nCross-check against solver.py")
        for k in (1, 2, 3):
            v = verify(sample_neighborhoods, k, solve(sample_neighborhoods, k))
            print(f"  [{v['verdict']}] 6 pts, K={k}: {v['note']}")
        small = sorted(SAMPLE_NEIGHBORHOODS, key=lambda x: x["id"])[:9]
        for k in (2, 3):
            t = time.time()
            v = verify(small, k, solve(small, k))
            print(f"  [{v['verdict']}] 9 Bangalore pts, K={k}: {v['note']}  ({time.time()-t:.1f}s)")
        sc = spot_check(SAMPLE_NEIGHBORHOODS, 3, solve, samples=5, size=8)
        print(f"  [{sc['verdict']}] spot check on 13-pt sample: optimal on {sc['passed']}/{sc['samples']} random 8-pt sub-instances")
