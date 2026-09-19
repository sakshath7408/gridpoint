"""
Dump the Python reference solver's output as JSON, so the TypeScript port can
be checked against it.

Run from the repo root:  python3 python/dump_reference.py > /tmp/reference.json

The dataset is Tejas's SAMPLE_NEIGHBORHOODS — adopted as the single canonical
cross-validation input so both implementations are scored on identical data.
"""
import json
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import solver  # noqa: E402

out = {
    "dataset": solver.SAMPLE_NEIGHBORHOODS,
    "runs": [],
}

for k in (1, 2, 3, 4, 5):
    r = solver.solve(solver.SAMPLE_NEIGHBORHOODS, k)
    out["runs"].append({
        "k": k,
        "warehouses": r["warehouses"],
        "assignments": r["assignments"],
        "objective_order_km": solver.weighted_cost(solver.SAMPLE_NEIGHBORHOODS, r),
    })

json.dump(out, sys.stdout, indent=1)
