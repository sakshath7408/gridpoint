/**
 * Adversarial stress test.
 *
 * test_core.ts checks that the things we claim are true. This checks that the
 * things we never claimed are *also* true — that nothing produces a NaN, an
 * orphaned assignment, a negative cost or a silently violated constraint under
 * any combination a judge might click through in two minutes.
 *
 * It is deliberately exhaustive rather than clever: every dataset x every K x
 * every fleet x every congestion profile, plus the degenerate inputs that
 * normally get discovered live, on stage.
 *
 *   npx tsx scripts/stress.ts
 */
import { SAMPLES } from '../lib/data';
import {
  run, sweepK, proveOptimality, stressTest, applyDemandScenario,
  VEHICLES, TRAFFIC, DEMAND_SCENARIOS, DEFAULT_CONSTRAINTS,
} from '../lib/engine';
import { haversineKm } from '../lib/geo';
import type { Neighborhood, Constraints } from '../lib/types';

let checks = 0, fails = 0;
const failures: string[] = [];

function bad(ctx: string, msg: string) {
  fails++;
  if (failures.length < 40) failures.push(`${ctx}: ${msg}`);
}
function ok(ctx: string, cond: boolean, msg: string) {
  checks++;
  if (!cond) bad(ctx, msg);
}
const finite = (n: unknown): boolean => typeof n === 'number' && Number.isFinite(n);

/** Every invariant that must hold for ANY result, whatever the inputs. */
function auditResult(ctx: string, ns: Neighborhood[], k: number, c: Constraints) {
  const r = run(ns, k, c);

  // --- nothing is NaN, Infinity or undefined
  ok(ctx, finite(r.total_cost), `total_cost not finite: ${r.total_cost}`);
  ok(ctx, finite(r.baseline_cost), `baseline_cost not finite: ${r.baseline_cost}`);
  ok(ctx, finite(r.improvement_pct), `improvement_pct not finite: ${r.improvement_pct}`);
  ok(ctx, r.total_cost > 0, `total_cost not positive: ${r.total_cost}`);

  if (r.breakdown) {
    for (const [key, v] of Object.entries(r.breakdown)) {
      ok(ctx, finite(v as number), `breakdown.${key} not finite: ${v}`);
      ok(ctx, (v as number) >= 0, `breakdown.${key} negative: ${v}`);
    }
    const sum = r.breakdown.delivery + r.breakdown.infrastructure;
    ok(ctx, Math.abs(sum - r.breakdown.total) < 0.5,
      `delivery+infrastructure (${sum.toFixed(2)}) != total (${r.breakdown.total.toFixed(2)})`);
  }

  // --- warehouses
  ok(ctx, r.warehouses.length === Math.min(k, ns.length),
    `expected ${Math.min(k, ns.length)} warehouses, got ${r.warehouses.length}`);
  for (const w of r.warehouses) {
    ok(ctx, finite(w.lat) && finite(w.lon), `warehouse ${w.id} has non-finite coords`);
    ok(ctx, w.lat >= -90 && w.lat <= 90, `warehouse ${w.id} lat out of range: ${w.lat}`);
    ok(ctx, w.lon >= -180 && w.lon <= 180, `warehouse ${w.id} lon out of range: ${w.lon}`);
  }
  // a depot must sit inside the demand's bounding box, generously padded.
  // Outside it means the solver diverged, which is the failure mode that
  // produced "Delhi connecting to Bengaluru".
  const lats = ns.map((n) => n.lat), lons = ns.map((n) => n.lon);
  const pad = 0.5;
  for (const w of r.warehouses) {
    ok(ctx, w.lat >= Math.min(...lats) - pad && w.lat <= Math.max(...lats) + pad,
      `warehouse ${w.id} escaped the data's latitude range`);
    ok(ctx, w.lon >= Math.min(...lons) - pad && w.lon <= Math.max(...lons) + pad,
      `warehouse ${w.id} escaped the data's longitude range`);
  }

  // --- assignments: total, and pointing at something real
  const ids = new Set(r.warehouses.map((w) => w.id));
  for (const n of ns) {
    const a = r.assignments[n.id];
    ok(ctx, a !== undefined, `neighborhood ${n.id} unassigned`);
    if (a !== undefined) ok(ctx, ids.has(a), `neighborhood ${n.id} assigned to unknown warehouse "${a}"`);
  }
  ok(ctx, Object.keys(r.assignments).length === ns.length,
    `assignment count ${Object.keys(r.assignments).length} != ${ns.length}`);

  // --- impact must divide by the SAME baseline the headline does
  if (r.impact) {
    const expected = Math.max(0, r.baseline_cost - r.total_cost) * 365;
    ok(ctx, Math.abs(r.impact.savedPerYear - expected) < 1,
      `impact.savedPerYear ${r.impact.savedPerYear.toFixed(0)} != (baseline-total)*365 ${expected.toFixed(0)}`);
    ok(ctx, finite(r.impact.co2TonnesPerYear) && r.impact.co2TonnesPerYear >= 0, 'co2TonnesPerYear bad');
    ok(ctx, r.impact.savedPerYear >= 0, 'negative annual saving');
  }

  // --- improvement_pct must agree with the costs it summarises
  const pct = ((r.baseline_cost - r.total_cost) / r.baseline_cost) * 100;
  ok(ctx, Math.abs(pct - r.improvement_pct) < 0.05,
    `improvement_pct ${r.improvement_pct.toFixed(3)} != derived ${pct.toFixed(3)}`);

  // --- capacity, when asked for
  const cap = c.capacity ?? 0;
  if (cap > 0) {
    const load: Record<string, number> = {};
    for (const n of ns) { const a = r.assignments[n.id]; load[a] = (load[a] ?? 0) + n.orders; }
    const over = Object.entries(load).filter(([, v]) => v > cap + 0.001);
    // Over-capacity is allowed ONLY when total demand genuinely exceeds total
    // capacity — otherwise the assignment ignored the constraint.
    const totalDemand = ns.reduce((s, n) => s + n.orders, 0);
    if (over.length && totalDemand <= cap * r.warehouses.length) {
      bad(ctx, `capacity ${cap} exceeded at ${over.map(([w, v]) => `${w}=${v}`).join(', ')} though total demand ${totalDemand} fits`);
    }
    checks++;
  }

  // --- max radius: any violation must be REPORTED, not hidden
  if (c.maxRadiusKm && c.maxRadiusKm > 0) {
    const flagged = new Set(r.out_of_radius ?? []);
    for (const n of ns) {
      const w = r.warehouses.find((x) => x.id === r.assignments[n.id]);
      if (!w) continue;
      const d = haversineKm(n.lat, n.lon, w.lat, w.lon) * c.roadFactor;
      if (d > c.maxRadiusKm + 0.01) {
        ok(ctx, flagged.has(n.id),
          `${n.id} is ${d.toFixed(1)}km from its depot (limit ${c.maxRadiusKm}) but is NOT flagged`);
      }
    }
  }
  return r;
}

// ---------------------------------------------------------------------------
console.log('=== 1. every dataset x every K ===');
for (const [label, ns] of Object.entries(SAMPLES)) {
  for (let k = 1; k <= Math.min(8, ns.length); k++) {
    auditResult(`${label} K=${k}`, ns, k, DEFAULT_CONSTRAINTS);
  }
  // sweep must be internally consistent and its optimum must be the real argmin
  const sw = sweepK(ns, Math.min(8, ns.length), DEFAULT_CONSTRAINTS);
  const argmin = sw.points.reduce((a, b) => (b.total < a.total ? b : a)).k;
  ok(label, sw.optimalK === argmin, `optimalK=${sw.optimalK} but argmin of the curve is K=${argmin}`);
  for (let i = 1; i < sw.points.length; i++) {
    ok(label, sw.points[i].delivery <= sw.points[i - 1].delivery + 0.01,
      `delivery cost ROSE from K=${i} to K=${i + 1} — more depots cannot cost more to drive`);
  }
  // the headline baseline must equal the K=1 network
  const r1 = run(ns, 1, DEFAULT_CONSTRAINTS);
  ok(label, Math.abs(r1.baseline_cost - sw.points[0].total) < 1,
    `baseline ${r1.baseline_cost.toFixed(0)} != sweep K=1 total ${sw.points[0].total.toFixed(0)}`);
}

console.log('=== 2. every fleet x every congestion profile ===');
const big = SAMPLES['Bengaluru — 12 zones'];
for (const vehicle of VEHICLES) {
  for (const traffic of TRAFFIC) {
    auditResult(`${vehicle.label}/${traffic.label}`, big, 4,
      { ...DEFAULT_CONSTRAINTS, vehicle, traffic });
  }
}

console.log('=== 3. constraints: capacity and service radius ===');
for (const cap of [0, 500, 1200, 2500, 5000]) {
  for (const rad of [0, 5, 12, 30]) {
    auditResult(`cap=${cap} rad=${rad}`, big, 3,
      { ...DEFAULT_CONSTRAINTS, capacity: cap, maxRadiusKm: rad });
  }
}

console.log('=== 4. demand scenarios ===');
for (const sc of DEMAND_SCENARIOS) {
  const shifted = applyDemandScenario(big, sc);
  ok(sc.label, shifted.length === big.length, 'scenario changed the number of areas');
  ok(sc.label, shifted.every((n) => finite(n.orders) && n.orders >= 0), 'scenario produced bad order counts');
  auditResult(`scenario ${sc.label}`, shifted, 4, DEFAULT_CONSTRAINTS);
}

console.log('=== 5. degenerate and hostile inputs ===');
const one: Neighborhood[] = [{ id: 'solo', lat: 12.97, lon: 77.59, orders: 100 }];
auditResult('single area', one, 1, DEFAULT_CONSTRAINTS);
auditResult('single area, K>n', one, 5, DEFAULT_CONSTRAINTS);

const identical: Neighborhood[] = Array.from({ length: 6 }, (_, i) =>
  ({ id: `dup${i}`, lat: 12.97, lon: 77.59, orders: 50 }));
auditResult('six coincident points', identical, 3, DEFAULT_CONSTRAINTS);

const collinear: Neighborhood[] = Array.from({ length: 7 }, (_, i) =>
  ({ id: `line${i}`, lat: 12.9 + i * 0.02, lon: 77.6, orders: 100 }));
auditResult('perfectly collinear', collinear, 3, DEFAULT_CONSTRAINTS);

const oneHeavy: Neighborhood[] = [
  { id: 'whale', lat: 12.97, lon: 77.59, orders: 100000 },
  { id: 'a', lat: 13.10, lon: 77.70, orders: 1 },
  { id: 'b', lat: 12.85, lon: 77.50, orders: 1 },
  { id: 'c', lat: 13.00, lon: 77.40, orders: 1 },
];
const rHeavy = auditResult('one dominant area', oneHeavy, 1, DEFAULT_CONSTRAINTS);
{
  const w = rHeavy.warehouses[0];
  const d = haversineKm(w.lat, w.lon, 12.97, 77.59);
  ok('one dominant area', d < 1,
    `1-median sat ${d.toFixed(2)}km from an area holding 99.997% of demand — should be almost on top of it`);
}

const tiny: Neighborhood[] = [
  { id: 'p', lat: 12.9700, lon: 77.5900, orders: 10 },
  { id: 'q', lat: 12.9701, lon: 77.5901, orders: 10 },
  { id: 'r', lat: 12.9702, lon: 77.5899, orders: 10 },
];
auditResult('metres apart', tiny, 2, DEFAULT_CONSTRAINTS);

const farApart: Neighborhood[] = [
  { id: 'blr', lat: 12.97, lon: 77.59, orders: 500 },
  { id: 'del', lat: 28.61, lon: 77.21, orders: 500 },
];
auditResult('1700km apart', farApart, 2, DEFAULT_CONSTRAINTS);

const zeroOrders: Neighborhood[] = [
  { id: 'z1', lat: 12.97, lon: 77.59, orders: 0 },
  { id: 'z2', lat: 13.01, lon: 77.62, orders: 0 },
  { id: 'z3', lat: 12.93, lon: 77.55, orders: 5 },
];
auditResult('mostly zero orders', zeroOrders, 2, DEFAULT_CONSTRAINTS);

console.log('=== 6. extreme cost parameters ===');
for (const p of [
  { fuelPrice: 0 }, { fuelPrice: 1000 },
  { driverWage: 0 }, { driverWage: 5000 },
  { warehouseCostPerDay: 0 }, { warehouseCostPerDay: 500000 },
  { roadFactor: 1 }, { roadFactor: 3 },
]) {
  auditResult(`param ${JSON.stringify(p)}`, big, 3, { ...DEFAULT_CONSTRAINTS, ...p });
}

console.log('=== 6a. CO2 must be derived from fuel burn, not invented ===');
// petrol 2310 g CO2/litre, diesel 2680 g/litre. Every liquid-fuel vehicle's
// declared CO2 must fall out of its declared consumption - if someone edits one
// number and not the other, the table starts lying and nothing else would notice.
for (const v of VEHICLES) {
  if (!v.fuelPerKm) continue;                       // electric: grid-derived, checked separately
  const petrol = v.fuelPerKm * 2310, diesel = v.fuelPerKm * 2680;
  const matches = Math.abs(v.co2GramsPerKm - petrol) < 3 || Math.abs(v.co2GramsPerKm - diesel) < 3;
  ok(`co2/${v.id}`, matches,
    `${v.label}: ${v.co2GramsPerKm} g/km does not follow from ${v.fuelPerKm} L/km ` +
    `(petrol would be ${petrol.toFixed(0)}, diesel ${diesel.toFixed(0)})`);
}
{
  const ev = VEHICLES.find((v) => v.id === 'ev')!;
  ok('co2/ev', ev.fuelPerKm === 0 && ev.co2GramsPerKm > 0,
    'the electric van must burn no liquid fuel yet still carry grid emissions');
}

console.log('=== 6b. the electric van must not track the petrol price ===');
{
  const ev = VEHICLES.find((v) => v.id === 'ev')!;
  const van = VEHICLES.find((v) => v.id === 'van')!;
  const cheap = run(big, 3, { ...DEFAULT_CONSTRAINTS, vehicle: ev, fuelPrice: 50 });
  const dear  = run(big, 3, { ...DEFAULT_CONSTRAINTS, vehicle: ev, fuelPrice: 300 });
  ok('ev/petrol', Math.abs(cheap.total_cost - dear.total_cost) < 0.01,
    `electric van cost moved with the PETROL price: Rs${cheap.total_cost.toFixed(0)} at Rs50/L vs Rs${dear.total_cost.toFixed(0)} at Rs300/L`);
  // a diesel van, by contrast, absolutely should move
  const vCheap = run(big, 3, { ...DEFAULT_CONSTRAINTS, vehicle: van, fuelPrice: 50 });
  const vDear  = run(big, 3, { ...DEFAULT_CONSTRAINTS, vehicle: van, fuelPrice: 300 });
  ok('van/petrol', vDear.total_cost > vCheap.total_cost + 1,
    'diesel van cost did NOT move with the fuel price, which it must');
}

console.log('=== 7. determinism ===');
for (const [label, ns] of Object.entries(SAMPLES)) {
  const a = run(ns, 4, DEFAULT_CONSTRAINTS);
  const b = run(ns, 4, DEFAULT_CONSTRAINTS);
  ok(label, JSON.stringify(a.warehouses) === JSON.stringify(b.warehouses),
    'two identical runs produced different warehouses');
  ok(label, Math.abs(a.total_cost - b.total_cost) < 1e-9, 'two identical runs produced different costs');
}

console.log('=== 8. k-medians must never lose to k-means on its own objective ===');
for (const [label, ns] of Object.entries(SAMPLES)) {
  for (const k of [2, 3, 4]) {
    if (k > ns.length) continue;
    const pr = proveOptimality(ns, k, DEFAULT_CONSTRAINTS);
    ok(`${label} K=${k}`, pr.kmeansPenaltyPct >= -0.001,
      `k-means BEAT k-medians by ${(-pr.kmeansPenaltyPct).toFixed(3)}% on the linear objective`);
    ok(`${label} K=${k}`, finite(pr.kmeansPenaltyPct), 'kmeansPenaltyPct not finite');
  }
}

console.log('=== 9. robustness harness ===');
for (const [label, ns] of Object.entries(SAMPLES)) {
  const seed = run(ns, Math.min(3, ns.length), DEFAULT_CONSTRAINTS);
  const rb = stressTest(ns, seed.warehouses, DEFAULT_CONSTRAINTS);
  ok(label, finite(rb.meanRegretPct) && rb.meanRegretPct >= -0.001,
    `mean regret bad: ${rb.meanRegretPct}`);
  ok(label, rb.worstRegretPct >= rb.meanRegretPct - 0.001,
    'worst regret is below mean regret');
}

// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(64));
if (fails === 0) {
  console.log(`STRESS PASSED — ${checks} assertions, 0 failures`);
} else {
  console.log(`STRESS FAILED — ${checks} assertions, ${fails} failures\n`);
  for (const f of failures) console.log('  x ' + f);
  if (fails > failures.length) console.log(`  ... and ${fails - failures.length} more`);
  process.exitCode = 1;
}
