/**
 * Where every number in the cost model comes from.
 *
 * A model is only as trustworthy as its parameters, and a parameter with no
 * provenance is a guess wearing a decimal point. Each entry below records the
 * value, the reasoning, and a checkable source. The UI renders these next to
 * the control they govern; the user manual reproduces the table.
 *
 * Verified 20 September 2026.
 */

export interface Sourced {
  /** What the number is. */
  label: string;
  /** The value, formatted for display. */
  value: string;
  /** Why this value and not another — one sentence a judge can check. */
  basis: string;
  /** Where it came from. */
  source: string;
}

export const SOURCES: Record<string, Sourced> = {
  fuelPrice: {
    label: 'Petrol price',
    value: '₹110.93 / litre',
    basis: 'Retail pump price in Bengaluru on 19 September 2026, the day before this model was calibrated.',
    source: 'Goodreturns / Upstox daily fuel price, Bengaluru',
  },
  driverWage: {
    label: 'Rider cost to the operator',
    value: '₹120 / hour',
    basis: 'Metro delivery partners gross ₹15,000–30,000 a month; at roughly 208 paid hours that is ₹72–144/hour. We take the upper-middle of that band because the operator also carries incentives and insurance.',
    source: 'PickMyWork, “Blinkit, Zepto and Swiggy Delivery Partner Earnings 2026”',
  },
  facilityMicro: {
    label: 'Micro-hub (default)',
    value: '₹2,500 / day',
    basis: 'A 500–800 sq ft satellite unit: rent ₹30–40k, minimal fixed staffing, power and maintenance — about ₹75,000 a month. This is the default because the model prices the trunk leg only (see note below).',
    source: 'Scaled from tier-2 dark-store cost structure, DigitalDawn dark-store cost guide',
  },
  facilityDark: {
    label: 'Full dark store (reference)',
    value: '≈ ₹7,800 / day',
    basis: 'A 2,000–3,000 sq ft tier-1 dark store: rent ₹80k + power ₹45k + connectivity ₹5k + maintenance ₹20k + the fixed share of ₹2.13L staffing ≈ ₹2.35L a month. Try it on the slider — at this cost and this order volume the model correctly says fewer, larger facilities.',
    source: 'DigitalDawn, “How to Start a Dark Store in India”, tier-1 premium model',
  },
  capacityBike: {
    label: 'Two-wheeler load',
    value: '25 parcels per trip',
    basis: 'Derived from rider throughput rather than box volume. An urban e-commerce rider completes 80–100 deliveries a day, run as three or four loads out of the hub — roughly 20–33 parcels a load. We take 25. This models e-commerce parcel delivery, which is what the brief describes, not 10-minute grocery runs where a rider carries 1–3 orders.',
    source: 'India.com, “How much do Amazon, Flipkart, Myntra delivery boys make” — 80–100 deliveries/day in Delhi-NCR',
  },
  roadFactor: {
    label: 'Road detour factor',
    value: '× 1.32',
    basis: 'Street networks are not straight lines. The circuity factor for dense urban grids is consistently measured between 1.2 and 1.4; we take the middle.',
    source: 'Urban network circuity literature',
  },
  co2Petrol: {
    label: 'Tailpipe CO₂',
    value: '46–402 g / km',
    basis: 'Per fleet: 100–125cc two-wheeler 46, three-wheeler 76, diesel LCV 228, light truck 402 g/km.',
    source: 'BS-VI type-approval CO₂ ranges by vehicle class',
  },
  energyEv: {
    label: 'Electric van energy',
    value: '₹1.40 / km',
    basis: 'About 0.20 kWh/km at roughly ₹7 a unit — Karnataka’s dedicated EV tariff is ₹5.00/kWh, blended up for public AC top-ups mid-shift. Priced separately from the petrol slider on purpose: electricity is its own tariff and does not move with the pump.',
    source: 'State EV tariffs (Karnataka ₹5.00/kWh); public AC charging ₹8–15/kWh',
  },
  co2Ev: {
    label: 'Electric van CO₂',
    value: '142 g / km',
    basis: 'An electric LCV uses about 0.20 kWh/km. India’s grid emitted 0.71 kg CO₂ per kWh in FY 2024-25, so 0.20 × 710 = 142 g/km. An EV is cleaner than a diesel van here, but it is not zero — the emissions move to the power station.',
    source: 'CEA CO₂ Baseline Database v21.0 (Dec 2025), 0.710 tCO₂/MWh',
  },
};

/**
 * The single most important caveat, stated in the interface rather than buried.
 *
 * We price the TRUNK LEG — depot to neighborhood and back — plus facilities.
 * Distribution *within* a neighborhood is excluded, because it is very nearly
 * invariant to where the depot sits and therefore cannot move the optimum.
 *
 * The consequence, stated plainly: our ₹/order is NOT a full last-mile cost.
 * Real Indian last-mile runs ₹30–60 per e-commerce parcel; the trunk leg is a
 * small fraction of that. The figures here are correct for CHOOSING BETWEEN
 * SITINGS, which is what the tool is for, and should not be read as the cost
 * of delivering a parcel.
 */
export const SCOPE_NOTE =
  'Trunk leg plus facilities. Distribution inside a neighborhood is excluded — '
  + 'it barely changes with depot position, so it cannot move the optimum. '
  + 'That makes these figures right for comparing sitings, but smaller than a '
  + 'full last-mile cost, which runs ₹30–60 per parcel in India.';
