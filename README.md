# Sludge — *Where should the warehouse go?*

### by Sakshath, Tejas and Rajath

**Hack-a-Matics 2026** · Pentagram (Mathematical Society of BMSCE) × BMSCE IEEE Computer Society
Theme: **VECTOR** · Problem statement 1: **GRIDPOINT**

> The product is called **Sludge**. *GridPoint* is the problem statement we are
> answering, and it survives in the repository name, the deployment URL and the
> manual's filename — renaming those would break links for no benefit. Where you
> see GridPoint in a path, it is a path; where you see Sludge, it is the product.

A warehouse location optimisation platform. Give it neighborhoods with daily
order volumes, and it answers three questions a logistics company actually has:

1. **Where** should warehouses go?
2. **How many** should there be?
3. **Which** neighborhood does each one serve?

Everything runs in the browser. No backend, no API keys, nothing to fall over
during a demo.

---

## The result, in one line

On a 12-zone Bengaluru dataset (3,880 orders/day, two-wheeler fleet):

| Network | Cost/day | |
|---|---|---|
| One depot, sited optimally — the best a single-depot operation can do | **₹27,870** | — |
| Sludge, K = 4 (the cost optimum it finds itself) | **₹18,824** | **32.5% cheaper** |
| A k-means network at the same K | ₹19,222 | 2.1% worse than ours |

That is **₹33.0 lakh a year** and **37 t of CO₂** avoided.

The baseline is deliberately the *strongest* single-depot alternative — the weighted
1-median, found by the same solver — not a depot dumped at the map centre. Comparing
against a badly-sited depot would have reported 36.9% instead of 32.5%. We quote the
smaller number because it is the one that survives scrutiny.

---

## The mathematics

### Why k-medians and not k-means

This is the crux, and it is the reason we did not simply call a clustering library.

Delivery cost is **linear in distance**. k-means minimises **squared** distance.
Those are different objectives, and the difference is not academic: squaring lets
one distant, high-volume neighborhood drag a warehouse toward it far harder than
its real cost justifies.

So the update step uses the **geometric median** (Weiszfeld's algorithm) rather
than the centroid — the point minimising `Σ wᵢ · d(x, pᵢ)` rather than
`Σ wᵢ · d(x, pᵢ)²`. The app computes both and reports the gap in rupees, live.

### The cost model folds into the geometry for free

For neighborhood *i* served from warehouse *w*:

```
roadKm    = haversine(i, w) × roadFactor        roads are not straight lines
trips     = ceil(ordersᵢ / vehicleCapacity)     a two-wheeler holds 25 parcels
vehicleKm = 2 × roadKm × trips                  every trip is a round trip
speed_eff = vehicleSpeed / congestion           traffic slows the fleet
costᵢ     = vehicleKm × (fuelPerKm × fuelPrice + upkeepPerKm) + hours × driverWage
```

Substituting gives

```
costᵢ = straightKmᵢ × [ 2 × tripsᵢ × roadFactor × ratePerKm ]
```

The bracketed term is a **constant per neighborhood**. So minimising total rupees
is *still exactly* a weighted k-medians problem — the whole vehicle, fuel and
traffic model only changes the weights. It costs the optimiser nothing.

### How many warehouses — a real answer, not a slider

```
totalCost = Σ costᵢ  +  K × facilityCostPerDay
```

Each warehouse cuts delivery cost and adds fixed cost, so the total has a genuine
**interior minimum**. The app sweeps K and reports the optimum. On the sample
dataset that is K = 4.

### What we can honestly prove

We are careful to separate a theorem from a search.

| K | Claim | Basis |
|---|---|---|
| **K = 1** | **Provably the global optimum** | The weighted 1-median objective is convex; Weiszfeld is a descent method on it, so its fixed point is the global minimum. A theorem — no search involved. |
| **K > 1** | **Certified, not proven optimal** | k-medians is NP-hard. We prove two weaker but genuinely rigorous things instead. |

For K > 1 the two certificates are:

1. **Never worse than the exact discrete optimum.** We solve the discrete
   p-median problem exactly, enumerating all `C(n,k)` ways of siting K warehouses
   on the demand points, and warm-start Lloyd's iteration from it. Since Lloyd's
   decreases the objective monotonically, being worse than that optimum is
   mathematically impossible.
2. **Certified local optimum.** Every warehouse is perturbed independently across
   a fine grid within 2 km — hundreds of probes — and none improves the objective.

The app shows which claim applies, with the numbers behind it, in the **Proof** tab.

---

## The AI component

**Model:** [`Xenova/all-MiniLM-L6-v2`](https://huggingface.co/Xenova/all-MiniLM-L6-v2)
— sentence-transformers MiniLM-L6-v2, ONNX, int8-quantised (~23 MB)
**Task:** feature-extraction (sentence embeddings), mean-pooled, L2-normalised
**Runtime:** Transformers.js v3 on **WebAssembly, entirely in the browser**.
No API key, no server, no data leaves the machine.

### What it does

Real logistics spreadsheets do not have columns called `id / lat / lon / orders`.
They have *"Locality Name"*, *"Y Coordinate"*, *"Parcels Per Day"*. A hardcoded
alias table only recognises headers someone thought of in advance and fails on
the first unfamiliar file.

Instead we embed each incoming header and each target-field description into the
same vector space and match them by cosine similarity, then greedily assign so
each field claims exactly one column.

Try it: **Upload → "Try one with unfamiliar headers"**.

### Honest accounting of the signals

Two signals contribute, and we are explicit about their weight:

1. **Semantic similarity from the transformer — the primary signal.**
2. **A numeric-range prior from the column's own values — a tie-breaker only,**
   bounded to ±0.12. This settles the one case no language model can resolve from
   a header alone: *"X Coordinate"* and *"Y Coordinate"* are near-identical
   strings, and only the values reveal which is latitude.

Every returned mapping records which path produced it, and the UI displays
whether the model or the deterministic fallback ran. **If the model cannot load,
we fall back to an alias table and say so in the interface** rather than
pretending the model ran.

---

## Features

Every core requirement and **all eight bonus features** from the problem statement:

| Requirement | Where |
|---|---|
| Upload or enter neighborhood data | Sample / CSV upload / type-in, all validated |
| Visualise locations on a map | MapLibre, circle area ∝ daily orders |
| Select the number of warehouses | K slider, plus a computed optimum |
| Run an optimisation algorithm | Weighted k-medians, client-side |
| Assign each neighborhood | Colour-coded assignment lines |
| Calculate total distance and cost | Full ₹/day breakdown |
| Display optimised locations | Labelled warehouse markers with load |
| Compare original vs optimised | Before/after toggle + k-means control |
| Capacity and max service radius | Both, with violations flagged not hidden |
| **Bonus:** multiple warehouses | K = 1…8 |
| **Bonus:** warehouse capacity | Greedy capacity-aware assignment |
| **Bonus:** maximum delivery radius | Out-of-range neighborhoods highlighted |
| **Bonus:** vehicle types | 5 fleets, from two-wheeler to light truck |
| **Bonus:** fuel costs | Live ₹/litre input |
| **Bonus:** traffic-dependent times | 4 congestion profiles |
| **Bonus:** demand changes | 5 scenarios incl. sprawl vs infill |
| **Bonus:** infrastructure vs delivery trade-off | The K-sweep chart, with the optimum marked |

---

## Cross-validation — two implementations, one answer

The mathematics was written twice, independently: **Tejas in Python**
(`python/solver.py` — the reference, and the author of record for the model) and
**TypeScript** for the browser (`lib/solver.ts`). `npm run crossval` runs both on
the same dataset and checks they agree.

They are not bit-identical by construction — Python runs Weiszfeld on a local
tangent-plane projection while TypeScript runs it directly on the sphere with
haversine, and the restart seeds differ. So the agreement below is a real
measurement, not a tautology:

```
   K  |  python (order-km)  typescript (order-km)   gap    worst site gap
  ----+-------------------------------------------------------------------
   1  |          55490.66              55490.74   +0.000%        0.000 km
   2  |          37539.79              37539.82   +0.000%        0.002 km
   3  |          30378.14              30378.17   +0.000%        0.002 km
   4  |          23720.15              23720.18   +0.000%        0.000 km
   5  |          17904.77              17904.80   +0.000%        0.000 km
```

**Agreement to 0.0001% on cost and ~2 metres on warehouse position.** That is
the transliteration verified rather than asserted, and it catches the class of
bug no unit test would — a sign flip, a wrong convergence tolerance, an
off-by-one in a restart loop.

```bash
npm run crossval        # needs python3 on PATH
```

## Running it

```bash
npm install
npm run dev        # http://localhost:3000
npm run build      # production build
npx tsx scripts/test_core.ts   # 70 tests covering the maths and the data layer
npm run crossval               # TypeScript vs the Python reference
```

Requires Node 20+.

---

## Repository layout

```
app/                  Next.js app router — layout, page, design system
components/
  MapView.tsx         MapLibre map: circles, assignment lines, warehouse markers
  KSweepChart.tsx     The infrastructure-vs-delivery trade-off chart
lib/
  geo.ts              Haversine, weighted centroid, Weiszfeld geometric median
  solver.ts           Weighted k-medians, exact discrete p-median, local-opt certificate
  engine.ts           Cost model, run() pipeline, K-sweep, proof report
  data.ts             Parsing, validation, sample datasets
  palette.ts          Validated colour palette
  ai/columnMapper.ts  The AI component
python/
  solver.py           Reference implementation (Tejas) — the model of record
  engine.py           Reference pipeline
  verifier.py         Independent brute-force checker (Rajath)
  dump_reference.py   Emits reference output for cross-validation
scripts/
  test_core.ts        70 tests
  cross_validate.ts   TypeScript vs Python agreement check
```

---

## Open-source software used

*Disclosed per the hackathon rules. Everything below is used as a published
library or a public model; the optimisation, cost model, integration and UI are
our own work.*

| Package | Licence | What we use it for |
|---|---|---|
| [Next.js](https://nextjs.org) | MIT | React framework, static build |
| [React](https://react.dev) | MIT | UI |
| [MapLibre GL JS](https://maplibre.org) | BSD-3-Clause | Map rendering |
| [Transformers.js](https://github.com/huggingface/transformers.js) | Apache-2.0 | Running the AI model in-browser |
| [`Xenova/all-MiniLM-L6-v2`](https://huggingface.co/Xenova/all-MiniLM-L6-v2) | Apache-2.0 | The embedding model itself |
| [TypeScript](https://www.typescriptlang.org) | Apache-2.0 | Language |
| [tsx](https://github.com/privatenumber/tsx) | MIT | Running the test script |
| [Inter](https://rsms.me/inter/) via [Fontsource](https://fontsource.org) | OFL-1.1 | Typeface, self-hosted (no font CDN request at runtime) |
| [OpenFreeMap](https://openfreemap.org) | free, no key | Vector basemap tiles |
| [OpenStreetMap](https://www.openstreetmap.org/copyright) | ODbL | Basemap data and raster fallback |

**Pinned deliberately:** `maplibre-gl` is held at **5.24.x**. Version 6 has a
web-worker regression under Next 15's bundler — GeoJSON sources never parse and
the map silently renders nothing. Do not bump without re-testing the map.

---

## Engineering notes

A few decisions worth explaining, because they were all caused by something
actually going wrong rather than by preference.

**The map renders with zero network.** MapLibre only fires `load` once its style
resolves, and if a tile source is unreachable it stays in "style not loaded" and
paints *nothing* — not the basemap, and not your data either. So the map boots on
a blank style, draws the data immediately, and only grafts a basemap in after
probing that the tile server actually responds. If the venue wifi dies, the
visualisation still works.

**No backend, by choice.** Free-tier Python hosts cold-start for ~50 seconds,
which is the most common way a live demo dies. Moving the solver to the client
removes that failure mode entirely.

**Solver determinism.** Seeded PRNG throughout, so the same input always produces
the same warehouses — important when a judge asks you to run it twice.

---

## Team

| Module | Owner |
|---|---|
| Web application, data layer, cost-model wiring, AI component, deployment | Sakshath |
| Reference implementation (`solver.py`, `engine.py`) and mathematical modelling | Tejas |
| Brute-force verifier | Rajath |

The Python reference implementation is the author of record for the mathematics;
the TypeScript in this app is a transliteration of it, cross-validated against it.
