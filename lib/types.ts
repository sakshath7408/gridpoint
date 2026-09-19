// GridPoint — shared types.
// The Neighborhood and Result shapes are the team's FROZEN CONTRACT.
// Everything beyond `improvement_pct` on Result is an additive extra.

export interface Neighborhood {
  id: string;
  lat: number;
  lon: number;
  orders: number;
}

export interface Warehouse {
  id: string;
  lat: number;
  lon: number;
}

/** The frozen RESULT contract, plus additive extras the UI renders when present. */
export interface Result {
  warehouses: Warehouse[];
  assignments: Record<string, string>;
  total_cost: number;
  baseline_cost: number;
  improvement_pct: number;

  // ---- additive extras ----
  baseline_warehouse?: Warehouse;
  distances_km?: Record<string, number>;
  load?: Record<string, number>;
  cost_units?: string;
  breakdown?: CostBreakdown;
  baseline_breakdown?: CostBreakdown;
  perNeighborhood?: Record<string, NeighborhoodCost>;
  out_of_radius?: string[];
  over_capacity?: string[];
  iterations?: number;
  objectiveOrderKm?: number;
  baselineObjectiveOrderKm?: number;

  /**
   * Same K, but placed by weighted k-MEANS — i.e. what a team that reached for
   * a clustering library would ship. The like-for-like control that isolates
   * the value of using the correct objective.
   */
  naive_k_cost?: number;
  naive_k_warehouses?: Warehouse[];
  /** % more per day that the k-means network would cost. Positive = we win. */
  naive_k_penalty_pct?: number;
  /** Cost reduction from placement alone, holding K fixed. Always >= 0. */
  placement_gain_pct?: number;

  /** Real-world impact figures for the headline cards. */
  impact?: Impact;
  /** How well the plan survives demand it was not optimised for. */
  robustness?: Robustness;

  // ---- ALIASES for Tejas's Python engine ----
  // His engine.py emits `loads` / `unserved` / `baseline`; this one emits
  // `load` / `out_of_radius` / `baseline_warehouse`. Both are populated so the
  // UI reads either implementation without a translation layer.
  loads?: Record<string, number>;
  unserved?: string[];
  baseline?: { definition: string; warehouses: Warehouse[]; assignments: Record<string, string> };
}

export interface Impact {
  kmPerDay: number;
  kmPerYear: number;
  /** Rupees SAVED per day/year versus the single-central-depot baseline. */
  savedPerDay: number;
  savedPerYear: number;
  co2KgPerDay: number;
  co2TonnesPerYear: number;
  /** CO2 avoided per year versus the baseline, in tonnes. */
  co2TonnesSavedPerYear: number;
  assumption: string;
}

export interface Robustness {
  trials: number;
  /** Average % by which keeping this plan costs more than re-optimising. */
  meanRegretPct: number;
  worstRegretPct: number;
  swingPct: number;
  verdict: string;
}

export interface CostBreakdown {
  /** ₹/day spent moving goods (fuel + driver). */
  delivery: number;
  fuel: number;
  driver: number;
  /** ₹/day amortised cost of operating the warehouses themselves. */
  infrastructure: number;
  total: number;
  /** Total vehicle-km driven per day across all routes. */
  vehicleKm: number;
  /** Total driver-hours per day. */
  driverHours: number;
  /** Pure order-weighted km — the abstract objective, kept for cross-validation. */
  orderKm: number;
}

export interface NeighborhoodCost {
  warehouseId: string;
  straightLineKm: number;
  roadKm: number;
  trips: number;
  vehicleKm: number;
  hours: number;
  fuel: number;
  driver: number;
  total: number;
  withinRadius: boolean;
}

export interface Vehicle {
  id: string;
  label: string;
  /** Orders carried per trip. */
  capacity: number;
  /** Litres burned per km. */
  fuelPerKm: number;
  /** Free-flow average speed, km/h. */
  speedKmph: number;
  /** Fixed ₹/km for wear, tyres, maintenance. */
  upkeepPerKm: number;
  /**
   * Tailpipe CO2 in grams per km. Derived from fuel burn, not invented:
   * petrol 2.31 kg CO2/litre, diesel 2.68 kg CO2/litre. The electric van is
   * grid emissions instead (~0.157 kWh/km x ~0.70 kg CO2/kWh, Indian grid),
   * so it is low but not zero — which is the honest number.
   */
  co2GramsPerKm: number;
  emoji: string;
}

export interface TrafficProfile {
  id: string;
  label: string;
  /** Effective speed is divided by this. 1.0 = free flow. */
  congestion: number;
  description: string;
}

export interface DemandScenario {
  id: string;
  label: string;
  description: string;
  /** Multiplier applied to every neighborhood's orders. */
  globalGrowth: number;
  /**
   * Extra growth applied to the outer ring of neighborhoods (suburban sprawl)
   * or to the dense core (urban infill). Positive = outward, negative = inward.
   */
  sprawlBias: number;
}

export interface Constraints {
  /** Max orders/day a single warehouse can handle. 0/undefined = unlimited. */
  capacity?: number;
  /** Neighborhoods beyond this road distance are flagged. 0/undefined = no limit. */
  maxRadiusKm?: number;
  vehicle: Vehicle;
  traffic: TrafficProfile;
  /** ₹ per litre of fuel. */
  fuelPrice: number;
  /** ₹ per driver-hour, fully loaded. */
  driverWage: number;
  /** ₹/day to operate one warehouse (rent + staff + utilities, amortised). */
  warehouseCostPerDay: number;
  /** Straight-line km × this = actual road km. ~1.3 for a typical Indian city grid. */
  roadFactor: number;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export interface ParseReport {
  rows: Neighborhood[];
  errors: string[];
  /** Which source column was mapped to each field, and how confident we were. */
  columnMapping?: ColumnMapping[];
}

export interface ColumnMapping {
  sourceColumn: string;
  field: keyof Neighborhood;
  confidence: number;
  method: 'exact' | 'alias' | 'semantic';
}
