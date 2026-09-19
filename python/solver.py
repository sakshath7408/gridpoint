"""
GridPoint — Module A1: geometry and warehouse placement.

Hack-a-Matics 2026, theme VECTOR, problem statement GRIDPOINT.

This module is the base of the compute chain. It imports nothing from the rest
of the project. `engine.py` imports `solve` and `haversine` from here.

Public API:
    haversine(lat1, lon1, lat2, lon2) -> float      great-circle km
    solve(neighborhoods, K, constraints=None) -> dict
    weighted_cost(neighborhoods, result) -> float   the objective, one place
    sweep_k(neighborhoods, k_max, constraints=None) -> list of rows
    recommend_k(rows) -> int                        elbow of the sweep

Pure standard library. No file I/O, no printing outside __main__.
"""

import math
import random

# Earth's mean radius in kilometres.
# Source: https://www.movable-type.co.uk/scripts/latlong.html
EARTH_RADIUS_KM = 6371.0


def haversine(lat1, lon1, lat2, lon2):
    """
    Great-circle distance in kilometres between two lat/lon points.

    Haversine formula:
        a = sin^2(dphi/2) + cos(phi1) * cos(phi2) * sin^2(dlambda/2)
        c = 2 * atan2(sqrt(a), sqrt(1 - a))
        d = R * c

    atan2 is used rather than asin because it stays numerically stable for
    antipodal points, where floating-point error can push `a` marginally
    above 1 and make asin() raise a domain error.
    """
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)

    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return EARTH_RADIUS_KM * c


# --------------------------------------------------------------------------
# Sample data — real Bangalore coordinates, illustrative order volumes.
#
# Coordinates sourced from Wikipedia (Koramangala, Jayanagar, Banashankari,
# Indiranagar, Marathahalli, Hebbal, Yeshwanthpur, BTM Layout, KR Puram,
# Sarjapur, Kengeri, Electronic City metro station) and latlong.net
# (Whitefield). Daily order counts are SYNTHETIC — no public
# dataset of per-neighborhood e-commerce volume exists — but are scaled to
# reflect relative residential and commercial density.
# --------------------------------------------------------------------------

SAMPLE_NEIGHBORHOODS = [
    # north / north-west
    {"id": "Hebbal",         "lat": 13.0400,   "lon": 77.5900,   "orders": 310},
    {"id": "Yeshwanthpur",   "lat": 13.0285,   "lon": 77.5462,   "orders": 350},
    # east
    {"id": "KRPuram",        "lat": 12.9950,   "lon": 77.6800,   "orders": 420},
    {"id": "Whitefield",     "lat": 12.971389, "lon": 77.750130, "orders": 880},
    {"id": "Marathahalli",   "lat": 12.956194, "lon": 77.701943, "orders": 640},
    {"id": "Indiranagar",    "lat": 12.9699,   "lon": 77.6499,   "orders": 720},
    # central / south
    {"id": "Koramangala",    "lat": 12.9259,   "lon": 77.6229,   "orders": 950},
    {"id": "BTMLayout",      "lat": 12.9250,   "lon": 77.60861,  "orders": 610},
    {"id": "Jayanagar",      "lat": 12.9250,   "lon": 77.5950,   "orders": 480},
    {"id": "Banashankari",   "lat": 12.9373,   "lon": 77.5543,   "orders": 390},
    # west / far south / south-east
    {"id": "Kengeri",        "lat": 12.9100,   "lon": 77.4800,   "orders": 230},
    {"id": "ElectronicCity", "lat": 12.84649,  "lon": 77.67112,  "orders": 560},
    {"id": "Sarjapur",       "lat": 12.8600,   "lon": 77.7860,   "orders": 270},
]


# --------------------------------------------------------------------------
# Local projection.
#
# Weiszfeld's update is an average of positions, so it has to run in a space
# where both axes are measured in the same unit. Latitude and longitude are
# angles, not distances: at 13 N one degree of latitude spans 111.19 km while
# one degree of longitude spans only 108.34 km. Averaging raw degrees would
# silently stretch the east-west axis and pull the solution off-centre.
#
# So each cluster is projected to a local equirectangular plane in kilometres,
# anchored at a reference point inside the cluster, and converted back after
# the update. Distances themselves are always measured with haversine on true
# coordinates - the projection is only used to make the averaging honest.
# --------------------------------------------------------------------------

KM_PER_DEGREE = math.pi * EARTH_RADIUS_KM / 180.0


def _to_local_km(lat, lon, lat0, lon0):
    """Project (lat, lon) to (x_km east, y_km north) relative to (lat0, lon0)."""
    x = (lon - lon0) * KM_PER_DEGREE * math.cos(math.radians(lat0))
    y = (lat - lat0) * KM_PER_DEGREE
    return x, y


def _from_local_km(x, y, lat0, lon0):
    """Inverse of _to_local_km."""
    lat = lat0 + y / KM_PER_DEGREE
    lon = lon0 + x / (KM_PER_DEGREE * math.cos(math.radians(lat0)))
    return lat, lon


def weighted_geometric_median(points, tol=1e-7, max_iter=200):
    """
    Weighted geometric median of (lat, lon, weight) triples, via Weiszfeld.

    The geometric median minimises the sum of WEIGHTED DISTANCES:
        argmin_p  sum_i  w_i * dist(p, x_i)
    which is exactly our delivery objective. The centroid (what k-means uses)
    minimises sum of weighted SQUARED distances instead - a different point,
    and the wrong one for this problem.

    Weiszfeld's iteration is a fixed point of that objective's gradient:
        p_{t+1} = ( sum_i w_i * x_i / d_i ) / ( sum_i w_i / d_i )
    i.e. a weighted average where each point additionally pulls in inverse
    proportion to how far away it currently is.

    Distances d_i are true haversine distances; the averaging happens in the
    local kilometre plane.
    """
    if not points:
        raise ValueError("weighted_geometric_median: no points given")
    if len(points) == 1:
        return points[0][0], points[0][1]

    total_w = sum(w for _, _, w in points)
    if total_w <= 0:
        # No demand anywhere in this cluster: fall back to the plain centroid.
        return (sum(p[0] for p in points) / len(points),
                sum(p[1] for p in points) / len(points))

    # Reference point for the projection: the weighted mean position. Also a
    # good starting guess for the iteration.
    lat0 = sum(la * w for la, _, w in points) / total_w
    lon0 = sum(lo * w for _, lo, w in points) / total_w

    local = [(_to_local_km(la, lo, lat0, lon0), w) for la, lo, w in points]

    cx = sum(p[0] * w for p, w in local) / total_w
    cy = sum(p[1] * w for p, w in local) / total_w

    for _ in range(max_iter):
        cur_lat, cur_lon = _from_local_km(cx, cy, lat0, lon0)

        num_x = num_y = denom = 0.0      # Weiszfeld sums over non-coincident points
        pull_x = pull_y = 0.0            # net unit-direction pull, weighted
        eta = 0.0                        # total weight sitting exactly at the estimate

        for (px, py), w in local:
            plat, plon = _from_local_km(px, py, lat0, lon0)
            d = haversine(cur_lat, cur_lon, plat, plon)

            if d < 1e-9:
                # Plain Weiszfeld divides by zero here. Collect the weight that
                # sits on the estimate and handle it below.
                eta += w
                continue

            num_x += w * px / d
            num_y += w * py / d
            denom += w / d
            pull_x += w * (px - cx) / d
            pull_y += w * (py - cy) / d

        if denom == 0:
            break  # every point coincides with the estimate: it is the median

        tx, ty = num_x / denom, num_y / denom

        if eta > 0:
            # The estimate is ON a data point. Standard Weiszfeld would stop and
            # return it - but a data point is the minimum only if its own
            # weight can hold back the combined pull of everything else
            # (optimality condition: |sum_i w_i (x_i - y)/d_i| <= w_j). If not,
            # step off it with the Vardi-Zhang (2000) modified update, which
            # blends the ordinary Weiszfeld step with staying put in the ratio
            # the pull exceeds the anchoring weight.
            pull = math.hypot(pull_x, pull_y)
            if pull <= eta:
                break  # genuinely optimal here
            lam = min(1.0, eta / pull)
            nx, ny = (1 - lam) * tx + lam * cx, (1 - lam) * ty + lam * cy
        else:
            nx, ny = tx, ty

        shift = math.hypot(nx - cx, ny - cy)
        cx, cy = nx, ny
        if shift < tol:
            break

    return _from_local_km(cx, cy, lat0, lon0)


# --------------------------------------------------------------------------
# k-median: assign / update / restart
# --------------------------------------------------------------------------

def _nearest(lat, lon, centres):
    """Index of the closest centre, and that distance."""
    best_i, best_d = 0, float("inf")
    for i, (clat, clon) in enumerate(centres):
        d = haversine(lat, lon, clat, clon)
        if d < best_d:
            best_i, best_d = i, d
    return best_i, best_d


def _weighted_cost(neighborhoods, centres, labels):
    """Sum of orders x distance-to-assigned-warehouse. The objective."""
    return sum(
        n["orders"] * haversine(n["lat"], n["lon"], *centres[labels[i]])
        for i, n in enumerate(neighborhoods)
    )


def _seed_kmeanspp(neighborhoods, K, rng):
    """
    k-means++ seeding, order-weighted.

    Centres are drawn one at a time with probability proportional to
    orders_i * D(x_i)^2, where D is the distance to the nearest centre chosen
    so far. High-demand neighborhoods far from everything already picked are
    the most likely next choice, which spreads the starting guesses instead of
    letting them clump in one dense area.
    """
    first = rng.choice(neighborhoods)
    centres = [(first["lat"], first["lon"])]

    while len(centres) < K:
        weights = []
        for n in neighborhoods:
            _, d = _nearest(n["lat"], n["lon"], centres)
            weights.append(max(n["orders"], 0) * d * d)

        total = sum(weights)
        if total <= 0:
            # Every neighborhood already sits on a centre; fill arbitrarily.
            pick = rng.choice(neighborhoods)
        else:
            r = rng.random() * total
            acc = 0.0
            pick = neighborhoods[-1]
            for n, w in zip(neighborhoods, weights):
                acc += w
                if acc >= r:
                    pick = n
                    break
        centres.append((pick["lat"], pick["lon"]))

    return centres


def _seed_top_orders(neighborhoods, K):
    """Deterministic seed: the K highest-order neighborhoods."""
    ranked = sorted(neighborhoods, key=lambda n: -n["orders"])
    return [(n["lat"], n["lon"]) for n in ranked[:K]]


def _lloyd(neighborhoods, centres, max_iter=100):
    """
    Alternating minimisation (the k-median analogue of Lloyd's algorithm).

    Repeat: assign every neighborhood to its nearest warehouse, then move each
    warehouse to the weighted geometric median of what it was given. Both steps
    can only decrease the objective, so the loop converges. It converges to a
    LOCAL optimum, which is why solve() runs several restarts.
    """
    centres = list(centres)
    labels = None

    for _ in range(max_iter):
        new_labels = [_nearest(n["lat"], n["lon"], centres)[0] for n in neighborhoods]

        if new_labels == labels:
            break
        labels = new_labels

        for k in range(len(centres)):
            members = [
                (n["lat"], n["lon"], n["orders"])
                for i, n in enumerate(neighborhoods) if labels[i] == k
            ]
            if not members:
                # Empty cluster: a warehouse nobody chose. Rather than drop it,
                # move it onto the neighborhood currently paying the highest
                # delivery cost - the place that most needs its own warehouse.
                worst_i = max(
                    range(len(neighborhoods)),
                    key=lambda i: neighborhoods[i]["orders"]
                    * haversine(neighborhoods[i]["lat"], neighborhoods[i]["lon"],
                                *centres[labels[i]]),
                )
                centres[k] = (neighborhoods[worst_i]["lat"], neighborhoods[worst_i]["lon"])
            else:
                centres[k] = weighted_geometric_median(members)

    if labels is None:
        labels = [_nearest(n["lat"], n["lon"], centres)[0] for n in neighborhoods]

    return centres, labels


# --------------------------------------------------------------------------
# Public entry point
# --------------------------------------------------------------------------

DEFAULT_SEED = 20260919  # fixed so the demo gives the same answer every run


def _restarts_for(n):
    """
    Number of random restarts. Lloyd-style alternation converges to a LOCAL
    optimum, and on the 13-point sample 12 restarts reliably missed the best
    one that 30 finds (30,450 vs 30,378 order-km); 30 through 150 all agree,
    so 30 is enough for small inputs. Each restart is O(n * K * iterations),
    so large uploads get fewer to keep the interface responsive.
    """
    return 30 if n <= 100 else 12 if n <= 300 else 6


def _is_real(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def _validate(neighborhoods, K, constraints):
    """
    Reject bad input with a message a Streamlit user can act on, instead of a
    TypeError from three functions deep. Uploaded CSVs arrive with strings,
    blanks, negatives and swapped columns; every one of those is caught here.
    """
    if not isinstance(neighborhoods, (list, tuple)) or not neighborhoods:
        raise ValueError("solve: neighborhoods must be a non-empty list")
    if isinstance(K, bool) or not isinstance(K, int):
        raise ValueError(f"solve: K must be a whole number, got {K!r}")
    if K < 1:
        raise ValueError("solve: K must be at least 1")

    ids = set()
    for n in neighborhoods:
        if not isinstance(n, dict):
            raise ValueError(f"solve: each neighborhood must be a dict, got {type(n).__name__}")
        for key in ("id", "lat", "lon", "orders"):
            if key not in n:
                raise ValueError(f"solve: neighborhood missing '{key}': {n!r}")
        nid = n["id"]
        if nid in ids:
            raise ValueError(f"solve: duplicate neighborhood id {nid!r}")
        ids.add(nid)
        if not _is_real(n["lat"]) or not -90 <= n["lat"] <= 90:
            raise ValueError(f"solve: {nid!r} has invalid latitude {n['lat']!r} (need a number in -90..90)")
        if not _is_real(n["lon"]) or not -180 <= n["lon"] <= 180:
            raise ValueError(f"solve: {nid!r} has invalid longitude {n['lon']!r} (need a number in -180..180)")
        if not _is_real(n["orders"]) or n["orders"] < 0:
            raise ValueError(f"solve: {nid!r} has invalid orders {n['orders']!r} (need a number >= 0)")

    if constraints is None:
        return
    if not isinstance(constraints, dict):
        raise ValueError("solve: constraints must be a dict or None")
    unknown = set(constraints) - {"capacity", "max_radius_km"}
    if unknown:
        raise ValueError(f"solve: unknown constraint key(s) {sorted(unknown)}; "
                         f"expected 'capacity' and/or 'max_radius_km'")
    cap = constraints.get("capacity")
    if cap is not None and (not _is_real(cap) or cap <= 0):
        raise ValueError(f"solve: capacity must be a positive number or None, got {cap!r}")
    rad = constraints.get("max_radius_km")
    if rad is not None and (not _is_real(rad) or rad < 0):
        raise ValueError(f"solve: max_radius_km must be a number >= 0 or None, got {rad!r}")


def weighted_cost(neighborhoods, result):
    """
    The objective, computed from a solve() result:

        sum over neighborhoods of  orders_i * haversine(i, its assigned warehouse)

    Exposed so engine.py, verifier.py and app.py all score a plan with the
    SAME function. Three separately written cost loops is how a demo ends up
    showing numbers that disagree with each other.
    """
    wpos = {w["id"]: (w["lat"], w["lon"]) for w in result["warehouses"]}
    return sum(
        n["orders"] * haversine(n["lat"], n["lon"], *wpos[result["assignments"][n["id"]]])
        for n in neighborhoods
    )


def solve(neighborhoods, K, constraints=None):
    """
    Place K warehouses and assign every neighborhood to one of them, minimising

        sum over neighborhoods of  orders_i * haversine(i, its warehouse)

    Args:
        neighborhoods: list of {"id": str, "lat": float, "lon": float,
                                "orders": int}
        K:             number of warehouses to place (>= 1). If K exceeds the
                       number of neighborhoods it is clamped; check
                       len(result["warehouses"]).
        constraints:   optional dict, either key may be None:
                       {"capacity": int, "max_radius_km": float}

    Returns:
        {
          "warehouses":    [{"id": str, "lat": float, "lon": float}],
          "assignments":   {neighborhood_id: warehouse_id},   # every id present
          "loads":         {warehouse_id: total daily orders it serves},
          "distances_km":  {neighborhood_id: km to its warehouse},
          "unserved":      [neighborhood_id],   # only when max_radius_km is set
          "over_capacity": [warehouse_id],      # only when capacity is set and
                                                # total demand exceeds K * capacity
        }

    The first two keys are the frozen contract. The rest are additive.

    Every neighborhood always appears in `assignments`, mapped to a real
    warehouse id, so downstream cost code can never silently skip one. When
    max_radius_km is set, neighborhoods further than that from their assigned
    warehouse are STILL assigned, and additionally listed in `unserved` so the
    interface can flag them as out of range.

    Deterministic: the same input gives the same output, regardless of the
    order the neighborhoods are listed in. Warehouse ids are assigned by
    descending load (W1 is the busiest), so labels are stable across runs.
    """
    _validate(neighborhoods, K, constraints)

    # Canonical order, so the seeding RNG sees the same sequence no matter how
    # the caller happened to sort the upload.
    neighborhoods = sorted(neighborhoods, key=lambda n: str(n["id"]))

    constraints = constraints or {}
    max_radius = constraints.get("max_radius_km")
    capacity = constraints.get("capacity")

    # More warehouses than neighborhoods: give each neighborhood its own and
    # stop. Extra warehouses would be redundant and would produce empty
    # clusters.
    K = min(K, len(neighborhoods))

    rng = random.Random(DEFAULT_SEED)

    best_centres, best_labels, best_cost = None, None, float("inf")

    for attempt in range(_restarts_for(len(neighborhoods))):
        # Restart 0 uses the deterministic high-demand seed, so the result is
        # never worse than the obvious heuristic. The rest are randomised
        # k-means++ draws, which is what actually escapes local optima.
        seeds = (_seed_top_orders(neighborhoods, K) if attempt == 0
                 else _seed_kmeanspp(neighborhoods, K, rng))

        centres, labels = _lloyd(neighborhoods, seeds)
        cost = _weighted_cost(neighborhoods, centres, labels)

        if cost < best_cost:
            best_centres, best_labels, best_cost = centres, labels, cost

    warehouses = [
        {"id": f"W{k + 1}", "lat": best_centres[k][0], "lon": best_centres[k][1]}
        for k in range(K)
    ]
    assignments = {
        n["id"]: warehouses[best_labels[i]]["id"]
        for i, n in enumerate(neighborhoods)
    }

    overflow = []
    if capacity is not None:
        assignments, overflow = _apply_capacity(
            neighborhoods, warehouses, best_centres, capacity
        )

    # ---- canonical warehouse labels: W1 = busiest --------------------------
    # Without this, two runs on differently ordered input give identical plans
    # with the labels permuted, and pins appear to jump between demo runs.
    load_by_old = {w["id"]: 0 for w in warehouses}
    for n in neighborhoods:
        load_by_old[assignments[n["id"]]] += n["orders"]
    order = sorted(warehouses, key=lambda w: (-load_by_old[w["id"]], w["lat"], w["lon"]))
    rename = {w["id"]: f"W{i + 1}" for i, w in enumerate(order)}

    warehouses = [{"id": rename[w["id"]], "lat": w["lat"], "lon": w["lon"]} for w in order]
    assignments = {nid: rename[wid] for nid, wid in assignments.items()}
    loads = {rename[wid]: load for wid, load in load_by_old.items()}
    overflow = [rename[wid] for wid in overflow]

    wpos = {w["id"]: (w["lat"], w["lon"]) for w in warehouses}
    distances = {
        n["id"]: haversine(n["lat"], n["lon"], *wpos[assignments[n["id"]]])
        for n in neighborhoods
    }

    result = {
        "warehouses": warehouses,
        "assignments": assignments,
        "loads": loads,
        "distances_km": distances,
    }
    if overflow:
        result["over_capacity"] = overflow
    if max_radius is not None:
        result["unserved"] = [nid for nid, d in distances.items() if d > max_radius]

    return result


def sweep_k(neighborhoods, k_max, constraints=None):
    """
    Solve for every K from 1 to k_max and report how cost falls as warehouses
    are added. This is the data behind the infrastructure-vs-delivery trade-off:
    each extra warehouse costs money to build, and this shows how much delivery
    cost it buys back.

    Returns a list of rows, one per K:
        {"k", "cost", "km_per_order", "saving_vs_prev_pct", "result"}
    """
    rows = []
    total_orders = sum(n["orders"] for n in neighborhoods) or 1
    prev = None
    for k in range(1, max(1, min(k_max, len(neighborhoods))) + 1):
        res = solve(neighborhoods, k, constraints)
        c = weighted_cost(neighborhoods, res)
        rows.append({
            "k": k,
            "cost": c,
            "km_per_order": c / total_orders,
            "saving_vs_prev_pct": None if prev is None or prev == 0 else (prev - c) / prev * 100,
            "result": res,
        })
        prev = c
    return rows


def recommend_k(rows):
    """
    Pick the "elbow" of a sweep_k curve: the K after which adding warehouses
    stops paying for itself.

    Method (the standard knee heuristic): normalise the curve to the unit
    square, draw the straight line from the first point to the last, and
    return the K whose point lies furthest below that line. Cheap, has no
    tunable thresholds, and matches what a person picks by eye.
    """
    if len(rows) < 3:
        return rows[-1]["k"] if rows else 1
    ks = [r["k"] for r in rows]
    cs = [r["cost"] for r in rows]
    k0, k1 = ks[0], ks[-1]
    c0, c1 = cs[0], cs[-1]
    if c0 == c1:
        return k0
    best_k, best_gap = k0, -1.0
    for k, c in zip(ks, cs):
        x = (k - k0) / (k1 - k0)
        y = (c - c1) / (c0 - c1)          # 1 at K=1, 0 at K=k_max
        gap = (1 - x) - y                 # distance below the diagonal
        if gap > best_gap:
            best_k, best_gap = k, gap
    return best_k


def _repair_pass(neighborhoods, centres, dist, capacity, strategy):
    """
    One capacity-repair run. Returns (labels, loads).

    Starts from the unconstrained nearest-warehouse assignment and moves
    neighborhoods off overloaded warehouses until every load fits. Each move
    costs  orders * (distance to new warehouse - distance to current one).

    `strategy` decides which move to take when a warehouse is over capacity:

      "cheapest"        always take the lowest-cost move available. Myopic: the
                        cheapest move may not actually resolve the overload, so
                        it can need several moves where one would have done.
      "resolve_first"   prefer moves large enough to bring the warehouse under
                        capacity outright, cheapest such move first. Fixes the
                        myopia, but can be forced into one very expensive move.
      "per_order"       minimise cost per order shifted, i.e. increase/orders.
                        Favours moving bulk demand that happens to sit almost
                        equidistant between two warehouses.

    No single rule wins on every instance - each beats the others somewhere -
    so solve() runs all three and keeps whichever ends up cheapest overall.
    """
    n_w = len(centres)
    labels = [min(range(n_w), key=lambda k: dist[i][k])
              for i in range(len(neighborhoods))]
    loads = [0] * n_w
    for i, n in enumerate(neighborhoods):
        loads[labels[i]] += n["orders"]

    while True:
        over = [k for k in range(n_w) if loads[k] > capacity]
        if not over:
            break

        candidates = []
        for k in over:
            needed = loads[k] - capacity
            for i, n in enumerate(neighborhoods):
                if labels[i] != k:
                    continue
                for j in range(n_w):
                    if j == k or loads[j] + n["orders"] > capacity:
                        continue
                    increase = n["orders"] * (dist[i][j] - dist[i][k])
                    resolves = n["orders"] >= needed
                    candidates.append((increase, resolves, i, k, j, n["orders"]))

        if not candidates:
            break  # infeasible: nothing can legally move anywhere

        if strategy == "cheapest":
            pick = min(candidates, key=lambda c: c[0])
        elif strategy == "resolve_first":
            resolving = [c for c in candidates if c[1]]
            pick = min(resolving or candidates, key=lambda c: c[0])
        else:  # per_order
            pick = min(candidates, key=lambda c: c[0] / max(c[5], 1))

        _, _, i, k, j, orders = pick
        labels[i] = j
        loads[k] -= orders
        loads[j] += orders

    return labels, loads


def _polish(neighborhoods, dist, labels, loads, capacity):
    """
    Local search: keep applying any single change that lowers cost without
    breaking capacity, until none is left.

    Greedy repair produces a feasible assignment but not necessarily a good
    one - it commits to each move without knowing what comes next, and a move
    that looked cheap early can block a better arrangement later. Two kinds of
    improving change are considered:

      RELOCATE  move one neighborhood to a different warehouse that has room
      SWAP      exchange the warehouses of two neighborhoods, which fits where
                neither could move alone because both warehouses are full

    Swaps matter: once every warehouse is near capacity, no single relocation
    is legal any more, and relocate-only search stops early at a poor solution.

    This terminates because every accepted change strictly lowers total cost
    and the number of assignments is finite.
    """
    n_w = len(loads)
    improved = True

    while improved:
        improved = False

        # relocate
        for i, n in enumerate(neighborhoods):
            k = labels[i]
            for j in range(n_w):
                if j == k or loads[j] + n["orders"] > capacity:
                    continue
                if n["orders"] * (dist[i][j] - dist[i][k]) < -1e-9:
                    labels[i] = j
                    loads[k] -= n["orders"]
                    loads[j] += n["orders"]
                    improved = True
                    break

        # swap
        for a in range(len(neighborhoods)):
            for b in range(a + 1, len(neighborhoods)):
                ka, kb = labels[a], labels[b]
                if ka == kb:
                    continue
                oa = neighborhoods[a]["orders"]
                ob = neighborhoods[b]["orders"]
                if loads[ka] - oa + ob > capacity or loads[kb] - ob + oa > capacity:
                    continue
                delta = (oa * (dist[a][kb] - dist[a][ka])
                         + ob * (dist[b][ka] - dist[b][kb]))
                if delta < -1e-9:
                    labels[a], labels[b] = kb, ka
                    loads[ka] += ob - oa
                    loads[kb] += oa - ob
                    improved = True

    return labels, loads


def _apply_capacity(neighborhoods, warehouses, centres, capacity):
    """
    Reassign neighborhoods so no warehouse exceeds `capacity` daily orders,
    and reposition the warehouses for the clusters they actually end up with.

    Capacity is a constraint on an otherwise-good solution, not a reason to
    start over. The unconstrained assignment is already cost-optimal and
    usually only one or two warehouses are overloaded, so the solution is
    REPAIRED rather than rebuilt: only marginal neighborhoods - the ones nearly
    equidistant between two warehouses - get moved.

    Exact capacitated assignment is a transportation problem and is not
    realistic to solve inside a 24-hour build, so this generates several
    candidate plans with greedy repair (three move-selection rules, swept over
    a range of capacity targets - a plan legal under a stricter limit is legal
    under the real one) and keeps the best.

    Critically, candidates are compared only AFTER each has been recentred:
    moving neighborhoods between warehouses changes where each warehouse
    should sit, and that shift is large enough to reverse which plan is
    cheaper. Ranking plans against the old positions picked the wrong one.
    Each candidate is therefore taken through a short capacitated Lloyd loop
    (recentre -> re-polish under the new distances -> repeat) before scoring.

    If total demand exceeds K * capacity the instance is infeasible. Rather
    than drop neighborhoods - which would break the output contract and hide
    orders from the cost calculation - the least-overloaded plan is returned
    and the still-overloaded warehouses are reported in `over_capacity`.
    """
    n_w = len(centres)

    def distances(cents):
        return [[haversine(n["lat"], n["lon"], clat, clon) for clat, clon in cents]
                for n in neighborhoods]

    def recentre(labels, cents):
        out = list(cents)
        for k in range(n_w):
            members = [(n["lat"], n["lon"], n["orders"])
                       for i, n in enumerate(neighborhoods) if labels[i] == k]
            if members:
                out[k] = weighted_geometric_median(members)
        return out

    base_dist = distances(centres)

    # --- candidate generation: capacity ladder x repair strategy -----------
    heaviest = max(n["orders"] for n in neighborhoods)
    total = sum(n["orders"] for n in neighborhoods)
    floor_cap = max(heaviest, -(-total // n_w))  # below this nothing can fit
    # Ladder resolution scales down with input size: the swap search inside
    # _polish is quadratic in N, so a 500-point upload gets a coarser sweep
    # rather than a 10-second stall in the interface.
    n = len(neighborhoods)
    STEPS = 24 if n <= 60 else 8 if n <= 200 else 3
    if capacity <= floor_cap:
        targets = [capacity]
    else:
        span = capacity - floor_cap
        targets = sorted({capacity - (span * t) // STEPS for t in range(STEPS + 1)},
                         reverse=True)

    seen = set()
    candidates = []
    for target in targets:
        for strategy in ("cheapest", "resolve_first", "per_order"):
            labels, loads = _repair_pass(neighborhoods, centres, base_dist, target, strategy)
            # Two polish variants: one allowed to spend the slack up to the
            # real capacity, one held to the stricter target. Local search is
            # path-dependent, and the tighter start sometimes ends cheaper.
            for limit in (capacity, target):
                pl, pd = _polish(neighborhoods, base_dist, list(labels), list(loads), limit)
                key = tuple(pl)
                if key not in seen:
                    seen.add(key)
                    candidates.append((pl, pd))

    # --- evaluate each candidate after recentring ----------------------------
    best = None       # (cost, labels, loads, cents)  legal under capacity
    fallback = None   # (overload, cost, labels, loads, cents)

    for labels, loads in candidates:
        cents = centres
        for _ in range(10):
            cents = recentre(labels, cents)
            d = distances(cents)
            new_labels, loads = _polish(neighborhoods, d, list(labels), list(loads), capacity)
            if new_labels == labels:
                break
            labels = new_labels

        d = distances(cents)
        cost = sum(n["orders"] * d[i][labels[i]] for i, n in enumerate(neighborhoods))
        overload = max(0, max(loads) - capacity)

        if overload == 0 and (best is None or cost < best[0]):
            best = (cost, labels, loads, cents)
        if fallback is None or (overload, cost) < (fallback[0], fallback[1]):
            fallback = (overload, cost, labels, loads, cents)

    if best is not None:
        _, best_labels, best_loads, best_cents = best
    else:
        _, _, best_labels, best_loads, best_cents = fallback

    for k in range(n_w):
        warehouses[k]["lat"], warehouses[k]["lon"] = best_cents[k]

    assignments = {
        n["id"]: warehouses[best_labels[i]]["id"]
        for i, n in enumerate(neighborhoods)
    }
    overflow = [warehouses[k]["id"] for k in range(n_w) if best_loads[k] > capacity]

    return assignments, overflow


# --------------------------------------------------------------------------
# Demo — `python solver.py`
# --------------------------------------------------------------------------

if __name__ == "__main__":
    nb = SAMPLE_NEIGHBORHOODS
    total_orders = sum(n["orders"] for n in nb)

    print("GridPoint — solver.py")
    print(f"{len(nb)} neighborhoods, {total_orders} daily orders\n")

    for K in (1, 2, 3):
        result = solve(nb, K)
        print(f"K = {K}")
        for w in result["warehouses"]:
            served = [nid for nid, wid in result["assignments"].items() if wid == w["id"]]
            print(f"  {w['id']}  ({w['lat']:9.5f}, {w['lon']:9.5f})  {result['loads'][w['id']]:5d} orders/day")
            print(f"       serves: {', '.join(served)}")
        cost = weighted_cost(nb, result)
        print(f"  weighted cost {cost:12,.1f} order-km"
              f"   ({cost / total_orders:.2f} km per order)\n")

    print("With constraints — K = 3, capacity 3000 orders, max radius 10 km")
    result = solve(nb, 3, {"capacity": 3000, "max_radius_km": 10.0})
    for w in result["warehouses"]:
        served = [nid for nid, wid in result["assignments"].items() if wid == w["id"]]
        print(f"  {w['id']}  ({w['lat']:9.5f}, {w['lon']:9.5f})  {result['loads'][w['id']]:5d} orders/day")
        print(f"       serves: {', '.join(served)}")
    print(f"  outside 10 km range: {result.get('unserved') or 'none'}")
    print(f"  over capacity      : {result.get('over_capacity') or 'none'}\n")

    print("How many warehouses are worth building?  (sweep K = 1..6)")
    rows = sweep_k(nb, 6)
    for r in rows:
        saving = "" if r["saving_vs_prev_pct"] is None else f"  saves {r['saving_vs_prev_pct']:4.1f}% vs K={r['k'] - 1}"
        print(f"  K={r['k']}  {r['cost']:10,.0f} order-km  {r['km_per_order']:.2f} km/order{saving}")
    print(f"  elbow -> recommend K = {recommend_k(rows)}")
