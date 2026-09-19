// GridPoint — geometry primitives.
//
// TypeScript transliteration of the reference Python implementation
// (python/solver.py, owned by Tejas). Every function here has a 1:1
// counterpart there, and scripts/cross_validate.ts asserts the two agree
// to within 1e-9 across all sample datasets and every K.
//
// Do not "improve" the math here. If the model changes, it changes in the
// Python first and gets re-transliterated, so the two stay provably identical.

import type { Neighborhood } from './types';

export const EARTH_RADIUS_KM = 6371.0088;

/** Great-circle distance between two lat/lon points, in kilometres. */
export function haversineKm(
  lat1: number, lon1: number,
  lat2: number, lon2: number,
): number {
  const toRad = Math.PI / 180;
  const p1 = lat1 * toRad;
  const p2 = lat2 * toRad;
  const dPhi = p2 - p1;
  const dLam = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dLam / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export interface Point { lat: number; lon: number }

/**
 * Order-weighted arithmetic mean position.
 *
 * This minimises weighted SQUARED distance — it is what k-MEANS converges to.
 * We compute it only to seed Weiszfeld and to demonstrate, in the Proof panel,
 * that it is the WRONG centre for a delivery-cost objective.
 */
export function weightedCentroid(points: Neighborhood[], weights?: number[]): Point {
  if (points.length === 0) return { lat: 0, lon: 0 };
  const w = weights ?? points.map((p) => Math.max(p.orders, 0));
  const total = w.reduce((s, x) => s + x, 0);
  if (total <= 0) {
    return {
      lat: points.reduce((s, p) => s + p.lat, 0) / points.length,
      lon: points.reduce((s, p) => s + p.lon, 0) / points.length,
    };
  }
  return {
    lat: points.reduce((s, p, i) => s + p.lat * w[i], 0) / total,
    lon: points.reduce((s, p, i) => s + p.lon * w[i], 0) / total,
  };
}

/**
 * Weiszfeld's algorithm — the order-weighted GEOMETRIC MEDIAN.
 *
 * Minimises  sum_i  w_i * d(x, p_i)   — weighted straight-line distance.
 * That is exactly the delivery-cost objective, which is why this, and not the
 * centroid, is the correct centre for warehouse placement.
 *
 * Iteratively reweighted least squares: each step re-solves a weighted mean
 * with weights w_i / d(x, p_i), which provably decreases the objective.
 */
export function weightedMedian(
  points: Neighborhood[],
  weights?: number[],
  iterations = 400,
  tol = 1e-12,
): Point {
  if (points.length === 0) return { lat: 0, lon: 0 };
  const w = weights ?? points.map((p) => Math.max(p.orders, 0));

  let { lat, lon } = weightedCentroid(points, w);

  for (let iter = 0; iter < iterations; iter++) {
    let numLat = 0, numLon = 0, denom = 0;

    for (let i = 0; i < points.length; i++) {
      const wi = w[i];
      if (wi <= 0) continue;
      const d = haversineKm(lat, lon, points[i].lat, points[i].lon);
      // Sitting exactly on a demand point: that point IS the optimum.
      if (d < 1e-9) return { lat: points[i].lat, lon: points[i].lon };
      const inv = wi / d;
      numLat += points[i].lat * inv;
      numLon += points[i].lon * inv;
      denom += inv;
    }

    if (denom === 0) break;
    const newLat = numLat / denom;
    const newLon = numLon / denom;
    const converged = Math.abs(newLat - lat) < tol && Math.abs(newLon - lon) < tol;
    lat = newLat;
    lon = newLon;
    if (converged) break;
  }

  return { lat, lon };
}

/** Plain unweighted geographic centre — the naive "put it in the middle" baseline. */
export function geographicCentre(points: Neighborhood[]): Point {
  if (points.length === 0) return { lat: 0, lon: 0 };
  return {
    lat: points.reduce((s, p) => s + p.lat, 0) / points.length,
    lon: points.reduce((s, p) => s + p.lon, 0) / points.length,
  };
}

/** Deterministic PRNG (mulberry32) so every run of the solver is reproducible. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
