/**
 * Print the headline figures the README and the user manual quote.
 *
 * Every number a document claims about this tool has to come from the tool,
 * not from a note someone took three hours ago. This script is the single
 * source of those numbers: run it, quote what it prints.
 *
 * It deliberately prints the figures as the INTERFACE reports them, because
 * that is what a reader has in front of them when they check the document
 * against the app. Two different baselines exist in the engine and mixing
 * them is how a document ends up contradicting its own product:
 *
 *   run().baseline_cost   one depot, sited by the solver  <- what the UI shows
 *   sweepK().improvementPct   measured against the naive geographic centre
 *
 *   npx tsx scripts/headline.ts
 */
import { SAMPLES, DEFAULT_SAMPLE } from '../lib/data';
import { run, sweepK, proveOptimality, DEFAULT_CONSTRAINTS } from '../lib/engine';

const label = DEFAULT_SAMPLE;
const ns = SAMPLES[label];
if (!ns) throw new Error('headline sample not found — did lib/data.ts change?');

const c = DEFAULT_CONSTRAINTS;
const sweep = sweepK(ns, Math.min(8, ns.length), c);
const kStar = sweep.optimalK;

const inr = (n: number) => '₹' + Math.round(n).toLocaleString('en-IN');
const lakh = (n: number) => '₹' + (n / 100000).toFixed(1) + 'L';

console.log('dataset   ', label, `— ${ns.length} zones, ${ns.reduce((a, n) => a + n.orders, 0).toLocaleString('en-IN')} orders/day`);
console.log('vehicle   ', c.vehicle.label, `(${c.vehicle.co2GramsPerKm} g CO2/km)`);
console.log('facility  ', inr(c.warehouseCostPerDay) + '/day');
console.log('optimal K ', kStar);

for (const k of [3, kStar]) {
  const r = run(ns, k, c);
  const proof = proveOptimality(ns, k, c);
  console.log(`\n=== K=${k}${k === kStar ? '  (the optimum)' : '  (slider default)'} — AS THE UI REPORTS IT ===`);
  console.log('  cheaper than one central depot', r.improvement_pct.toFixed(1) + '%');
  console.log('  total per day                 ', inr(r.total_cost));
  console.log('  down from                     ', inr(r.baseline_cost));
  console.log('  saved per year                ', r.impact ? lakh(r.impact.savedPerYear) : 'n/a');
  console.log('  CO2 avoided per year          ', r.impact ? r.impact.co2TonnesSavedPerYear.toFixed(0) + ' t' : 'n/a');
  console.log('  vs k-means at equal K         ', (proof.kmeansPenaltyPct >= 0 ? '-' : '+') + Math.abs(proof.kmeansPenaltyPct).toFixed(1) + '%');
  console.log('  cost per order                ', '₹' + (r.breakdown ? (r.breakdown.total / ns.reduce((a, n) => a + n.orders, 0)).toFixed(2) : '?'));
}

console.log('\n=== K sweep (improvementPct here is vs the NAIVE geographic centre) ===');
for (const p of sweep.points) {
  console.log(
    `  K=${p.k}  delivery ${inr(p.delivery).padStart(9)}  infra ${inr(p.infrastructure).padStart(8)}` +
    `  total ${inr(p.total).padStart(9)}${p.k === kStar ? '   <-- optimal' : ''}`,
  );
}
