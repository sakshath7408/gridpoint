// GridPoint — cost model and pipeline.
//
// TypeScript transliteration of python/engine.py (owned by Tejas).
// Cross-validated by scripts/cross_validate.ts.
//
// ---------------------------------------------------------------------------
// THE MODEL
//
// For neighborhood i served from warehouse w:
//
//   straightKm  = haversine(i, w)
//   roadKm      = straightKm x roadFactor          (roads are not straight lines)
//   trips       = ceil(orders_i / vehicleCapacity) (a van can only hold so much)
//   vehicleKm   = 2 x roadKm x trips               (every trip is a round trip)
//   speed_eff   = vehicleSpeed / congestion        (traffic slows the fleet)
//   hours       = vehicleKm / speed_eff
//
//   fuel_i      = vehicleKm x fuelPerKm x fuelPrice
//   upkeep_i    = vehicleKm x upkeepPerKm
//   driver_i    = hours x driverWage
//   cost_i      = fuel_i + upkeep_i + driver_i                      [Rs/day]
//
// Substituting gives
//
//   cost_i = straightKm x [ 2 x trips x roadFactor x ratePerKm ]
//   ratePerKm = fuelPerKm x fuelPrice + upkeepPerKm + driverWage / speed_eff
//
// The bracketed term is a CONSTANT per neighborhood. So minimising total rupees
// is still exactly a weighted k-medians problem — just with weight_i equal to
// a neighborhood's true cost-per-km-of-separation instead of its raw order
// count. The whole vehicle/fuel/traffic model therefore costs nothing extra in
// the optimiser; it only changes the weights. That is the key modelling insight.
//
//   totalCost = sum_i cost_i  +  K x warehouseCostPerDay
//
// The second term is what makes "how many warehouses?" a real question with a
// real answer rather than a slider the user guesses at. See sweepK().
// ---------------------------------------------------------------------------

import { haversineKm, geographicCentre, makeRng } from './geo';
import {
  placeWarehouses, placeWarehousesKMeans,
  exactDiscretePMedian, certifyLocalOptimum,
} from './solver';
import type {
  Constraints, CostBreakdown, DemandScenario, Neighborhood,
  NeighborhoodCost, Result, Vehicle, Warehouse,
} from './types';

// co2GramsPerKm is DERIVED, not invented: petrol 2.31 kg CO2/L, diesel 2.68 kg
// CO2/L, multiplied by that vehicle's litres per km. The electric van is grid
// emissions instead (~0.157 kWh/km x ~0.70 kg CO2/kWh for the Indian grid) —
// low but deliberately not zero, because that would be dishonest.
export const VEHICLES: Vehicle[] = [
  { id: 'bike',  label: 'Two-wheeler',   capacity: 25,  fuelPerKm: 0.020, speedKmph: 34, upkeepPerKm: 0.9, co2GramsPerKm: 46,  emoji: '🛵' },
  { id: 'auto',  label: 'Three-wheeler', capacity: 60,  fuelPerKm: 0.033, speedKmph: 28, upkeepPerKm: 1.6, co2GramsPerKm: 76,  emoji: '🛺' },
  { id: 'van',   label: 'Delivery van',  capacity: 180, fuelPerKm: 0.085, speedKmph: 30, upkeepPerKm: 3.4, co2GramsPerKm: 228, emoji: '🚐' },
  { id: 'truck', label: 'Light truck',   capacity: 420, fuelPerKm: 0.150, speedKmph: 26, upkeepPerKm: 6.2, co2GramsPerKm: 402, emoji: '🚚' },
  // EV CO2 is grid-derived, not zero: ~0.20 kWh/km x 0.710 kg CO2/kWh (CEA
  // v21.0, FY2024-25) = 142 g/km. Cleaner than a diesel van; not emission-free.
  { id: 'ev',    label: 'Electric van',  capacity: 150, fuelPerKm: 0.011, speedKmph: 30, upkeepPerKm: 2.1, co2GramsPerKm: 142, emoji: '🔋' },
];

export const TRAFFIC: import('./types').TrafficProfile[] = [
  { id: 'free',  label: 'Free flow',   congestion: 1.00, description: 'Empty roads — night dispatch' },
  { id: 'light', label: 'Light',       congestion: 1.25, description: 'Mid-morning, off-peak' },
  { id: 'peak',  label: 'Peak hour',   congestion: 1.85, description: 'Bengaluru 9am / 6pm reality' },
  { id: 'gridlock', label: 'Gridlock', congestion: 2.60, description: 'Monsoon evening, everything stopped' },
];

export const DEMAND_SCENARIOS: DemandScenario[] = [
  { id: 'today',   label: 'Today',          description: 'Current observed order volume',              globalGrowth: 1.00, sprawlBias: 0 },
  { id: 'growth',  label: '+40% in 1 year', description: 'Uniform growth across the whole city',       globalGrowth: 1.40, sprawlBias: 0 },
  { id: 'sprawl',  label: 'Suburban sprawl',description: 'Outer areas grow far faster than the core',  globalGrowth: 1.35, sprawlBias: 0.9 },
  { id: 'infill',  label: 'Urban infill',   description: 'Dense core densifies, outskirts flatten',    globalGrowth: 1.30, sprawlBias: -0.7 },
  { id: 'downturn',label: 'Downturn',       description: 'Orders fall 25% across the board',           globalGrowth: 0.75, sprawlBias: 0 },
];

// Calibrated against Indian quick-commerce / dark-store economics:
//  - Two-wheelers are the real last-mile fleet, and their small per-trip
//    capacity is what makes warehouse placement financially decisive.
//  - Rs 2,500/day is a compact ~2,000 sqft urban micro-fulfilment centre
//    (rent + staff + utilities, amortised) — not a regional mega-warehouse.
// Every one of these is user-adjustable in the UI; these are only the defaults.
//
// SCOPE NOTE (stated in the UI and the README): the cost model covers the
// TRUNK leg — warehouse to neighborhood — plus facility cost. Distribution
// *within* a neighborhood is deliberately excluded: it is essentially
// independent of where the warehouse sits, so it cannot change the optimum,
// and including it would only inflate the headline number.
/**
 * Defaults, each sourced. See `lib/sources.ts` for the full provenance table,
 * which the interface and the user manual both render.
 */
export const DEFAULT_CONSTRAINTS: Constraints = {
  capacity: 0,
  maxRadiusKm: 0,
  vehicle: VEHICLES[0],
  traffic: TRAFFIC[1],
  fuelPrice: 111,          // Rs/litre — Bengaluru pump price, 19 Sep 2026 (Rs 110.93)
  driverWage: 120,         // Rs/hour — metro rider gross Rs 15-30k/mo over ~208 h, upper-middle
  warehouseCostPerDay: 2500, // Rs/day — 500-800 sq ft micro-hub, ~Rs 75k/month
  roadFactor: 1.32,        // urban street-network circuity, measured 1.2-1.4
};

// ---------------------------------------------------------------------------
// Cost primitives
// ---------------------------------------------------------------------------

/** Rs charged per kilometre actually driven, given vehicle + traffic + fuel price. */
export function ratePerKm(c: Constraints): number {
  const effectiveSpeed = c.vehicle.speedKmph / c.traffic.congestion;
  return (
    c.vehicle.fuelPerKm * c.fuelPrice +
    c.vehicle.upkeepPerKm +
    c.driverWage / effectiveSpeed
  );
}

/**
 * A neighborhood's cost per km of straight-line separation from its warehouse.
 * This is the weight handed to the k-medians solver.
 */
export function costWeight(n: Neighborhood, c: Constraints): number {
  const trips = Math.ceil(Math.max(n.orders, 0) / Math.max(c.vehicle.capacity, 1));
  return 2 * trips * c.roadFactor * ratePerKm(c);
}

export function costWeights(ns: Neighborhood[], c: Constraints): number[] {
  return ns.map((n) => costWeight(n, c));
}

function costOne(
  n: Neighborhood, w: Warehouse, c: Constraints,
): NeighborhoodCost {
  const straightLineKm = haversineKm(n.lat, n.lon, w.lat, w.lon);
  const roadKm = straightLineKm * c.roadFactor;
  const trips = Math.ceil(Math.max(n.orders, 0) / Math.max(c.vehicle.capacity, 1));
  const vehicleKm = 2 * roadKm * trips;
  const effectiveSpeed = c.vehicle.speedKmph / c.traffic.congestion;
  const hours = effectiveSpeed > 0 ? vehicleKm / effectiveSpeed : 0;
  const fuel = vehicleKm * c.vehicle.fuelPerKm * c.fuelPrice;
  const upkeep = vehicleKm * c.vehicle.upkeepPerKm;
  const driver = hours * c.driverWage;
  return {
    warehouseId: w.id,
    straightLineKm, roadKm, trips, vehicleKm, hours,
    fuel: fuel + upkeep,
    driver,
    total: fuel + upkeep + driver,
    withinRadius: !c.maxRadiusKm || roadKm <= c.maxRadiusKm,
  };
}

function summarise(
  ns: Neighborhood[],
  assignments: Record<string, string>,
  warehouses: Warehouse[],
  c: Constraints,
): { breakdown: CostBreakdown; per: Record<string, NeighborhoodCost> } {
  const byId = new Map(warehouses.map((w) => [w.id, w]));
  const per: Record<string, NeighborhoodCost> = {};
  let fuel = 0, driver = 0, vehicleKm = 0, driverHours = 0, orderKm = 0;

  for (const n of ns) {
    const w = byId.get(assignments[n.id]);
    if (!w) continue;
    const row = costOne(n, w, c);
    per[n.id] = row;
    fuel += row.fuel;
    driver += row.driver;
    vehicleKm += row.vehicleKm;
    driverHours += row.hours;
    orderKm += n.orders * row.straightLineKm;
  }

  const infrastructure = warehouses.length * c.warehouseCostPerDay;
  const delivery = fuel + driver;
  return {
    breakdown: {
      delivery, fuel, driver, infrastructure,
      total: delivery + infrastructure,
      vehicleKm, driverHours, orderKm,
    },
    per,
  };
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

function assignNearest(
  ns: Neighborhood[], warehouses: Warehouse[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of ns) {
    let best = warehouses[0];
    let bestD = Infinity;
    for (const w of warehouses) {
      const d = haversineKm(n.lat, n.lon, w.lat, w.lon);
      if (d < bestD) { bestD = d; best = w; }
    }
    out[n.id] = best.id;
  }
  return out;
}

/**
 * Capacity-aware assignment. Largest neighborhoods claim first (they are the
 * hardest to place), each taking the nearest warehouse with room left. If every
 * warehouse is full it still goes to the nearest one and the overflow is
 * reported rather than silently hidden.
 */
function assignWithCapacity(
  ns: Neighborhood[], warehouses: Warehouse[], capacity: number,
): Record<string, string> {
  const remaining = new Map(warehouses.map((w) => [w.id, capacity]));
  const order = [...ns].sort((a, b) => b.orders - a.orders);
  const out: Record<string, string> = {};

  for (const n of order) {
    const ranked = [...warehouses].sort(
      (a, b) =>
        haversineKm(n.lat, n.lon, a.lat, a.lon) -
        haversineKm(n.lat, n.lon, b.lat, b.lon),
    );
    const fits = ranked.find((w) => (remaining.get(w.id) ?? 0) >= n.orders);
    const chosen = fits ?? ranked[0];
    out[n.id] = chosen.id;
    remaining.set(chosen.id, (remaining.get(chosen.id) ?? 0) - n.orders);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Demand scenarios (bonus: "model changes in customer demand")
// ---------------------------------------------------------------------------

/**
 * Project a dataset forward under a demand scenario.
 *
 * `sprawlBias` scales a neighborhood's growth by how far it sits from the city
 * centre, normalised to [0,1] across the dataset — so "suburban sprawl" really
 * does grow the edges and leave the core flat, rather than applying a flat
 * multiplier and calling it a scenario.
 */
export function applyDemandScenario(
  ns: Neighborhood[], scenario: DemandScenario,
): Neighborhood[] {
  if (scenario.globalGrowth === 1 && scenario.sprawlBias === 0) return ns;

  const centre = geographicCentre(ns);
  const dists = ns.map((n) => haversineKm(n.lat, n.lon, centre.lat, centre.lon));
  const maxD = Math.max(...dists, 1e-9);

  return ns.map((n, i) => {
    const radial = dists[i] / maxD;               // 0 at centre, 1 at the edge
    const bias = scenario.sprawlBias * (radial - 0.5) * 2; // -1..+1 across the city
    const growth = Math.max(0, scenario.globalGrowth * (1 + bias * 0.5));
    return { ...n, orders: Math.max(0, Math.round(n.orders * growth)) };
  });
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Real-world impact
// ---------------------------------------------------------------------------

/**
 * Translate the optimisation into the units a person actually feels:
 * kilometres not driven, rupees not spent, and CO2 not emitted.
 *
 * Deliberately reported as SAVINGS against the un-optimised baseline rather
 * than as totals. A total is just "how big is your delivery operation"; the
 * saving is what this model is responsible for.
 */
function buildImpact(
  optimised: CostBreakdown,
  baseline: CostBreakdown,
  c: Constraints,
): import('./types').Impact {
  const gPerKm = c.vehicle.co2GramsPerKm;
  const co2KgPerDay = (optimised.vehicleKm * gPerKm) / 1000;
  const baselineCo2KgPerDay = (baseline.vehicleKm * gPerKm) / 1000;
  const savedPerDay = Math.max(0, baseline.total - optimised.total);

  return {
    kmPerDay: optimised.vehicleKm,
    kmPerYear: optimised.vehicleKm * 365,
    savedPerDay,
    savedPerYear: savedPerDay * 365,
    co2KgPerDay,
    co2TonnesPerYear: (co2KgPerDay * 365) / 1000,
    co2TonnesSavedPerYear: Math.max(0, ((baselineCo2KgPerDay - co2KgPerDay) * 365) / 1000),
    assumption:
      `${c.vehicle.label} at ${gPerKm} g CO2/km, ` +
      `${Math.round(c.roadFactor * 100) / 100}x road detour factor, 365 operating days.`,
  };
}

// ---------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------

/**
 * Stress-test a plan against demand it was NOT optimised for.
 *
 * A plan that is optimal today but falls apart the moment demand shifts is a
 * bad plan. For each trial we perturb every neighborhood's orders by up to
 * +/-`swingPct`, then compare two things on that perturbed world:
 *
 *   (a) keeping the warehouses we already built  — what actually happens
 *   (b) re-optimising from scratch               — the unattainable ideal
 *
 * The gap is REGRET: what our commitment costs us versus perfect hindsight.
 * A low mean regret means the siting is genuinely robust, not just tuned.
 *
 * Deterministic: seeded PRNG, so the reported figure is reproducible.
 */
export function stressTest(
  neighborhoods: Neighborhood[],
  warehouses: Warehouse[],
  constraints: Constraints,
  trials = 24,
  swingPct = 30,
  seed = 20260920,
): import('./types').Robustness {
  if (neighborhoods.length === 0 || warehouses.length === 0) {
    return { trials: 0, meanRegretPct: 0, worstRegretPct: 0, swingPct, verdict: 'not run' };
  }

  const rng = makeRng(seed);
  const swing = swingPct / 100;
  const regrets: number[] = [];

  for (let t = 0; t < trials; t++) {
    const shifted = neighborhoods.map((n) => ({
      ...n,
      orders: Math.max(0, Math.round(n.orders * (1 + (rng() * 2 - 1) * swing))),
    }));

    // (a) keep the existing sites, re-assign and re-cost under the new demand
    const keptAssignments = constraints.capacity && constraints.capacity > 0
      ? assignWithCapacity(shifted, warehouses, constraints.capacity)
      : assignNearest(shifted, warehouses);
    const kept = summarise(shifted, keptAssignments, warehouses, constraints).breakdown.total;

    // (b) the best we could have done knowing the new demand
    const ideal = run(shifted, warehouses.length, constraints).total_cost;

    if (ideal > 0) regrets.push(((kept - ideal) / ideal) * 100);
  }

  if (regrets.length === 0) {
    return { trials: 0, meanRegretPct: 0, worstRegretPct: 0, swingPct, verdict: 'not run' };
  }

  const mean = regrets.reduce((a, b) => a + b, 0) / regrets.length;
  const worst = Math.max(...regrets);
  const verdict =
    mean < 1 ? 'Very robust — demand can move a lot before re-siting pays.'
    : mean < 3 ? 'Robust — the plan holds up under realistic demand swings.'
    : mean < 7 ? 'Moderately sensitive — worth revisiting if demand shifts.'
    : 'Sensitive — this siting depends heavily on current demand.';

  return {
    trials: regrets.length,
    meanRegretPct: mean,
    worstRegretPct: worst,
    swingPct,
    verdict,
  };
}

export function run(
  neighborhoods: Neighborhood[],
  k = 1,
  constraints: Constraints = DEFAULT_CONSTRAINTS,
): Result {
  if (neighborhoods.length === 0) {
    return {
      warehouses: [], assignments: {},
      total_cost: 0, baseline_cost: 0, improvement_pct: 0,
    };
  }

  const c = constraints;
  const kk = Math.max(1, Math.min(Math.floor(k), neighborhoods.length));
  const weights = costWeights(neighborhoods, c);

  // ---- Baseline: ONE warehouse, sited as well as a single warehouse can be.
  //
  // This used to be the plain geographic centre — the "put it in the middle of
  // the map" decision. That flattered us. Measuring a K-depot network against a
  // deliberately badly-placed depot inflates the saving, and the honest
  // counterfactual is not a company that sites its one warehouse stupidly: it
  // is a company that sites its one warehouse WELL and still only has one.
  //
  // So the baseline is now the weighted 1-median of the same demand, found by
  // the same solver. Every rupee we claim to save is therefore saved against
  // the best possible single-depot operation, not against a straw man. It is
  // the smaller number and the defensible one.
  //
  // It also makes the interface self-consistent: the headline percentage, the
  // rupees-per-year tile and the CO2 tile now all divide by the same thing.
  const basePlacement = placeWarehouses(neighborhoods, 1, weights);
  const centre = basePlacement.centers[0] ?? geographicCentre(neighborhoods);
  const baselineWarehouse: Warehouse = {
    id: 'Baseline',
    lat: Number(centre.lat.toFixed(6)),
    lon: Number(centre.lon.toFixed(6)),
  };
  const baselineAssignments = Object.fromEntries(
    neighborhoods.map((n) => [n.id, 'Baseline']),
  );
  const baselineSummary = summarise(
    neighborhoods, baselineAssignments, [baselineWarehouse], c,
  );

  // ---- Optimised placement.
  const placement = placeWarehouses(neighborhoods, kk, weights);
  let warehouses: Warehouse[] = placement.centers.map((p, i) => ({
    id: `W${i + 1}`,
    lat: Number(p.lat.toFixed(6)),
    lon: Number(p.lon.toFixed(6)),
  }));

  let assignments = c.capacity && c.capacity > 0
    ? assignWithCapacity(neighborhoods, warehouses, c.capacity)
    : assignNearest(neighborhoods, warehouses);

  // ---- Stable, meaningful ids: W1 is ALWAYS the busiest warehouse.
  // Without this the label attached to a site is an accident of solver
  // iteration order, so "W1" means something different between two runs and
  // nobody can compare screenshots. Convention adopted from the Python engine.
  {
    const loadOf = (wid: string) => neighborhoods
      .filter((n) => assignments[n.id] === wid)
      .reduce((s2, n) => s2 + n.orders, 0);
    const ordered = [...warehouses].sort((a, b) => loadOf(b.id) - loadOf(a.id));
    const rename = new Map(ordered.map((w, i) => [w.id, `W${i + 1}`]));
    warehouses = ordered.map((w) => ({ ...w, id: rename.get(w.id)! }));
    assignments = Object.fromEntries(
      Object.entries(assignments).map(([nid, wid]) => [nid, rename.get(wid) ?? wid]),
    );
  }

  const summary = summarise(neighborhoods, assignments, warehouses, c);

  const baselineCost = baselineSummary.breakdown.total;
  const totalCost = summary.breakdown.total;
  const improvement = baselineCost > 0
    ? ((baselineCost - totalCost) / baselineCost) * 100
    : 0;

  // ---- Reporting extras.
  const load: Record<string, number> = {};
  for (const w of warehouses) {
    load[w.id] = neighborhoods
      .filter((n) => assignments[n.id] === w.id)
      .reduce((s, n) => s + n.orders, 0);
  }
  const distances: Record<string, number> = {};
  for (const n of neighborhoods) distances[n.id] = summary.per[n.id]?.straightLineKm ?? 0;

  // ---- Like-for-like control: same K, placed by weighted k-means.
  // This is what a team that reached for sklearn.cluster.KMeans would ship.
  // Costing it through the identical pipeline isolates exactly what choosing
  // the right objective is worth, with the warehouse count held fixed.
  const kmeansPlacement = placeWarehousesKMeans(neighborhoods, kk, weights);
  const kmeansWarehouses: Warehouse[] = kmeansPlacement.centers.map((p, i) => ({
    id: `N${i + 1}`,
    lat: Number(p.lat.toFixed(6)),
    lon: Number(p.lon.toFixed(6)),
  }));
  const kmeansAssignments = c.capacity && c.capacity > 0
    ? assignWithCapacity(neighborhoods, kmeansWarehouses, c.capacity)
    : assignNearest(neighborhoods, kmeansWarehouses);
  const kmeansSummary = summarise(neighborhoods, kmeansAssignments, kmeansWarehouses, c);
  const naiveKCost = kmeansSummary.breakdown.total;

  const outOfRadius = c.maxRadiusKm && c.maxRadiusKm > 0
    ? neighborhoods.filter((n) => !summary.per[n.id]?.withinRadius).map((n) => n.id)
    : undefined;
  const overCapacity = c.capacity && c.capacity > 0
    ? Object.entries(load).filter(([, v]) => v > c.capacity!).map(([kk2]) => kk2)
    : undefined;

  return {
    warehouses,
    assignments,
    total_cost: totalCost,
    baseline_cost: baselineCost,
    improvement_pct: improvement,
    baseline_warehouse: baselineWarehouse,
    distances_km: distances,
    load,
    cost_units: '₹/day',
    breakdown: summary.breakdown,
    baseline_breakdown: baselineSummary.breakdown,
    perNeighborhood: summary.per,
    out_of_radius: outOfRadius,
    over_capacity: overCapacity,
    iterations: placement.iterations,
    objectiveOrderKm: summary.breakdown.orderKm,
    baselineObjectiveOrderKm: baselineSummary.breakdown.orderKm,
    impact: buildImpact(summary.breakdown, baselineSummary.breakdown, c),
    loads: load,
    unserved: outOfRadius,
    baseline: {
      definition: 'One warehouse, sited optimally (weighted 1-median) — the best a single-depot operation can do',
      warehouses: [baselineWarehouse],
      assignments: baselineAssignments,
    },
    naive_k_cost: naiveKCost,
    naive_k_warehouses: kmeansWarehouses,
    naive_k_penalty_pct: totalCost > 0 ? ((naiveKCost - totalCost) / totalCost) * 100 : 0,
    placement_gain_pct: naiveKCost > 0 ? ((naiveKCost - totalCost) / naiveKCost) * 100 : 0,
  };
}

// ---------------------------------------------------------------------------
// Bonus: infrastructure cost vs delivery cost trade-off
// ---------------------------------------------------------------------------

export interface KSweepPoint {
  k: number;
  delivery: number;
  infrastructure: number;
  total: number;
  improvementPct: number;
}

/**
 * Sweep K and return the full trade-off curve.
 *
 * Adding a warehouse always cuts delivery cost and always adds a fixed
 * infrastructure cost. The sum therefore has a genuine interior minimum: there
 * is a mathematically correct number of warehouses to build, and this finds it.
 * The app stops being "pick K with a slider" and starts answering the question
 * the company actually has.
 */
export function sweepK(
  neighborhoods: Neighborhood[],
  maxK: number,
  constraints: Constraints = DEFAULT_CONSTRAINTS,
): { points: KSweepPoint[]; optimalK: number } {
  const limit = Math.max(1, Math.min(maxK, neighborhoods.length, 10));
  const points: KSweepPoint[] = [];

  for (let k = 1; k <= limit; k++) {
    const r = run(neighborhoods, k, constraints);
    points.push({
      k,
      delivery: r.breakdown?.delivery ?? 0,
      infrastructure: r.breakdown?.infrastructure ?? 0,
      total: r.total_cost,
      improvementPct: r.improvement_pct,
    });
  }

  let optimalK = 1;
  let best = Infinity;
  for (const p of points) {
    if (p.total < best) { best = p.total; optimalK = p.k; }
  }
  return { points, optimalK };
}

// ---------------------------------------------------------------------------
// Proof of optimality (math credibility panel)
// ---------------------------------------------------------------------------
//
// Two certificates, because K=1 and K>1 are different kinds of mathematical
// statement and we do not blur them:
//
//   K = 1  The weighted 1-median objective is CONVEX. Weiszfeld's iteration is
//          a descent method on it, so its fixed point is the global minimum.
//          A theorem. No search required.
//
//   K > 1  k-medians is NP-hard, so no polynomial method certifies global
//          optimality. We prove two weaker but genuinely rigorous things:
//            (a) our continuous solution is at least as good as the EXACT
//                optimum of the discrete p-median problem over all C(n,k)
//                subsets of the demand points (solved by full enumeration);
//            (b) it is a certified LOCAL optimum: no perturbation of any
//                single warehouse anywhere within a 2 km fine grid improves
//                the objective.
//
// That is an honest claim we can defend, rather than a green "OPTIMAL" badge
// that means nothing.

export interface ProofReport {
  k: number;
  n: number;
  heuristicObjective: number;

  /** Exact optimum of the discrete p-median problem over the demand points. */
  discreteOptimum: number;
  discreteSiteIds: string[];
  subsetsEnumerated: number;
  discreteTractable: boolean;
  /** % by which placing warehouses freely beats the best on-demand-point siting. */
  continuousAdvantagePct: number;

  /** Local-optimality certificate. */
  isLocalOptimum: boolean;
  localProbes: number;
  localBestImprovementPct: number;

  /** Control: weighted k-means, scored on the same true delivery objective. */
  kmeansObjective: number;
  kmeansPenaltyPct: number;

  verdict: 'globally-optimal' | 'certified' | 'partially-certified' | 'failed';
  claim: string;
}

export function proveOptimality(
  neighborhoods: Neighborhood[],
  k: number,
  constraints: Constraints = DEFAULT_CONSTRAINTS,
): ProofReport {
  const n = neighborhoods.length;
  const weights = costWeights(neighborhoods, constraints);
  const heuristic = placeWarehouses(neighborhoods, k, weights);
  const kmeans = placeWarehousesKMeans(neighborhoods, k, weights);
  const kk = Math.max(1, Math.min(Math.floor(k), n));

  // --- Certificate (a): exact discrete p-median by full enumeration.
  let subsets = 1;
  for (let i = 0; i < kk; i++) subsets = (subsets * (n - i)) / (i + 1);
  const discreteTractable = subsets <= 2_000_000;

  let discreteOptimum = NaN;
  let discreteSiteIds: string[] = [];
  let subsetsEnumerated = 0;
  if (discreteTractable) {
    const exact = exactDiscretePMedian(neighborhoods, kk, weights);
    discreteOptimum = exact.objective;
    discreteSiteIds = exact.siteIds;
    subsetsEnumerated = exact.evaluated;
  }

  const continuousAdvantagePct = discreteTractable && discreteOptimum > 0
    ? ((discreteOptimum - heuristic.objective) / discreteOptimum) * 100
    : NaN;

  // --- Certificate (b): local optimality under single-warehouse perturbation.
  const local = certifyLocalOptimum(neighborhoods, heuristic.centers, weights);

  const kmeansPenaltyPct = heuristic.objective > 0
    ? ((kmeans.objective - heuristic.objective) / heuristic.objective) * 100
    : 0;

  // --- Verdict.
  let verdict: ProofReport['verdict'];
  let claim: string;

  const REL_TOL = 1e-9;
  const beatsDiscrete =
    discreteTractable && heuristic.objective <= discreteOptimum * (1 + REL_TOL);

  if (kk === 1) {
    verdict = local.isLocalOptimum ? 'globally-optimal' : 'failed';
    claim =
      'Provably the GLOBAL optimum. The weighted 1-median objective is convex, ' +
      "so Weiszfeld's descent converges to the global minimum — this is a theorem, " +
      `not a search. Verified numerically: none of ${local.probesEvaluated.toLocaleString()} ` +
      'perturbations within 2 km improves it.';
  } else if (beatsDiscrete && local.isLocalOptimum) {
    verdict = 'certified';
    claim =
      `k-medians is NP-hard at K=${kk}, so global optimality cannot be certified in ` +
      `polynomial time. Two things are proven instead. (1) Exactly solving the discrete ` +
      `p-median problem — all ${subsetsEnumerated.toLocaleString()} ways of siting ${kk} ` +
      `warehouses on the demand points — gives a solution this one matches or beats` +
      (continuousAdvantagePct > 0.01
        ? ` by ${continuousAdvantagePct.toFixed(2)}%.`
        : '.') +
      ` (2) It is a certified local optimum: ${local.probesEvaluated.toLocaleString()} ` +
      'perturbations of individual warehouses within 2 km all cost more.';
  } else if (local.isLocalOptimum || beatsDiscrete) {
    verdict = 'partially-certified';
    claim =
      (local.isLocalOptimum
        ? `Certified local optimum (${local.probesEvaluated.toLocaleString()} perturbations tested). `
        : `Local-optimality check found a ${local.bestImprovementPct.toFixed(3)}% better nearby placement. `) +
      (discreteTractable
        ? beatsDiscrete
          ? 'Also matches or beats the exact discrete p-median optimum.'
          : 'The exact discrete p-median optimum is better — raise the restart count.'
        : `Exact enumeration skipped: C(${n},${kk}) is too large.`);
  } else {
    verdict = 'failed';
    claim =
      `Both checks failed at K=${kk}: a nearby placement is ` +
      `${local.bestImprovementPct.toFixed(3)}% cheaper. The solver needs more restarts.`;
  }

  return {
    k: kk, n,
    heuristicObjective: heuristic.objective,
    discreteOptimum,
    discreteSiteIds,
    subsetsEnumerated,
    discreteTractable,
    continuousAdvantagePct,
    isLocalOptimum: local.isLocalOptimum,
    localProbes: local.probesEvaluated,
    localBestImprovementPct: local.bestImprovementPct,
    kmeansObjective: kmeans.objective,
    kmeansPenaltyPct,
    verdict,
    claim,
  };
}
