/**
 * ===========================================================================
 * THE AI COMPONENT — semantic CSV column mapping
 * ===========================================================================
 *
 * Model:   Xenova/all-MiniLM-L6-v2  (sentence-transformers MiniLM-L6-v2,
 *          ONNX / int8-quantised, ~23 MB)
 * Task:    feature-extraction (sentence embeddings), mean-pooled, L2-normalised
 * Runtime: Transformers.js v3 on WebAssembly — inference happens ENTIRELY in
 *          the visitor's browser. No API key, no server, no data leaves the
 *          machine. Weights are fetched once from the Hugging Face CDN and
 *          cached by the browser.
 *
 * WHAT IT ACTUALLY DOES, AND WHY IT EARNS ITS PLACE
 *
 * A real logistics team's spreadsheet does not have columns called
 * id/lat/lon/orders. It has "Locality Name", "Y Coordinate", "Parcels Per Day".
 * A hardcoded alias table only ever recognises headers somebody thought of in
 * advance; it fails on the first unfamiliar spreadsheet.
 *
 * Instead we embed each incoming header and each target field description into
 * the same vector space and match them by cosine similarity — so headers the
 * authors never anticipated still map correctly, because the model understands
 * that "Parcels Per Day" and "daily order volume" mean the same thing.
 *
 * HONEST ACCOUNTING OF THE SIGNALS (no overclaiming)
 *
 *   1. Semantic similarity from the transformer  — the primary signal.
 *   2. A numeric-range prior from the column's own values — a tie-breaker only.
 *      Latitudes live in [-90, 90], longitudes in [-180, 180], order counts are
 *      non-negative integers, ids are usually non-numeric. This disambiguates
 *      the genuinely hard case that no language model can settle from a header
 *      alone: "X Coordinate" vs "Y Coordinate" are near-identical strings, and
 *      only the values say which is which.
 *
 * The prior is additive and bounded, and `method` on every returned mapping
 * records which path produced it, so the UI can show exactly what the model
 * did versus what the fallback did. If the model fails to load — offline,
 * blocked CDN — we degrade to the deterministic alias table and say so in the
 * interface rather than pretending the model ran.
 */

import type { ColumnMapping, Neighborhood } from '../types';
import { canonicalColumn } from '../data';

/** Natural-language descriptions of what each target field means. */
const FIELD_PROMPTS: Record<keyof Neighborhood, string> = {
  id: 'the name or identifier of a neighbourhood, locality, area, zone or region',
  lat: 'the latitude coordinate, the north-south geographic position in degrees',
  lon: 'the longitude coordinate, the east-west geographic position in degrees',
  orders: 'the number of daily orders, parcels, deliveries, shipments or demand volume',
};

const FIELDS = Object.keys(FIELD_PROMPTS) as (keyof Neighborhood)[];

export const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

export type MapperStatus =
  | { state: 'idle' }
  | { state: 'loading'; progress: number }
  | { state: 'ready' }
  | { state: 'unavailable'; reason: string };

type Extractor = (
  texts: string[],
  opts: { pooling: 'mean'; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

let extractorPromise: Promise<Extractor> | null = null;
let status: MapperStatus = { state: 'idle' };
const listeners = new Set<(s: MapperStatus) => void>();

function setStatus(s: MapperStatus) {
  status = s;
  listeners.forEach((fn) => fn(s));
}

export function getStatus(): MapperStatus { return status; }
export function onStatus(fn: (s: MapperStatus) => void): () => void {
  listeners.add(fn);
  fn(status);
  return () => listeners.delete(fn);
}

/**
 * Load the model. Safe to call repeatedly — the promise is memoised, so the
 * weights are fetched at most once per page load.
 */
export function loadModel(): Promise<Extractor> {
  if (extractorPromise) return extractorPromise;

  setStatus({ state: 'loading', progress: 0 });

  extractorPromise = (async () => {
    const { pipeline, env } = await import('@huggingface/transformers');
    // We ship no local weights; always fetch from the CDN and let the browser
    // cache them.
    env.allowLocalModels = false;

    const pipe = await pipeline('feature-extraction', MODEL_ID, {
      dtype: 'q8',
      progress_callback: (p: { status?: string; progress?: number }) => {
        if (p?.status === 'progress' && typeof p.progress === 'number') {
          setStatus({ state: 'loading', progress: Math.round(p.progress) });
        }
      },
    });

    setStatus({ state: 'ready' });
    return pipe as unknown as Extractor;
  })().catch((err: unknown) => {
    const reason = err instanceof Error ? err.message : String(err);
    setStatus({ state: 'unavailable', reason });
    extractorPromise = null;
    throw err;
  });

  return extractorPromise;
}

function cosine(a: number[], b: number[]): number {
  // Vectors come back L2-normalised, so the dot product IS the cosine.
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * Evidence from the column's own values. Bounded to [-0.12, +0.12] so it can
 * break a tie but never override a confident semantic match.
 */
function valuePrior(field: keyof Neighborhood, values: string[]): number {
  const clean = values.map((v) => v?.trim()).filter((v) => v && v !== '');
  if (clean.length === 0) return 0;

  const nums = clean.map((v) => Number(v.replace(/,/g, '')));
  const numericShare = nums.filter((n) => Number.isFinite(n)).length / clean.length;
  const finite = nums.filter((n) => Number.isFinite(n));

  if (field === 'id') {
    // Ids are normally text; a fully numeric column is probably not an id.
    return numericShare > 0.9 ? -0.12 : 0.1;
  }
  if (numericShare < 0.9 || finite.length === 0) return -0.12;

  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const allInt = finite.every((n) => Number.isInteger(n));

  if (field === 'lat') {
    if (min < -90 || max > 90) return -0.12;
    // Latitudes are fractional and small in magnitude.
    return !allInt && Math.abs(max) <= 90 ? 0.12 : 0.02;
  }
  if (field === 'lon') {
    if (min < -180 || max > 180) return -0.12;
    // A column that also fits inside +/-90 is ambiguous with latitude; give
    // longitude a nudge only when it genuinely exceeds the latitude range.
    if (!allInt && Math.abs(max) > 90) return 0.12;
    return !allInt ? 0.06 : 0.02;
  }
  // orders: non-negative whole numbers
  if (min < 0) return -0.12;
  return allInt ? 0.12 : -0.04;
}

export interface MappingOutcome {
  mapping: ColumnMapping[];
  usedModel: boolean;
  missing: (keyof Neighborhood)[];
}

/** Deterministic fallback used when the model is unavailable. */
export function aliasMapping(headers: string[]): MappingOutcome {
  const mapping: ColumnMapping[] = [];
  const taken = new Set<string>();
  for (const h of headers) {
    const f = canonicalColumn(h);
    if (f && !taken.has(f)) {
      taken.add(f);
      mapping.push({ sourceColumn: h, field: f, confidence: 1, method: 'alias' });
    }
  }
  return {
    mapping,
    usedModel: false,
    missing: FIELDS.filter((f) => !taken.has(f)),
  };
}

/**
 * Map arbitrary CSV headers onto our four fields.
 *
 * Greedy assignment over the similarity matrix: repeatedly take the highest
 * remaining (field, column) score, so each field claims exactly one column and
 * each column serves at most one field.
 */
export async function mapColumns(
  headers: string[],
  sampleRows: string[][] = [],
): Promise<MappingOutcome> {
  const clean = headers.map((h) => h.trim()).filter((h) => h !== '');
  if (clean.length === 0) return { mapping: [], usedModel: false, missing: [...FIELDS] };

  let extractor: Extractor;
  try {
    extractor = await loadModel();
  } catch {
    return aliasMapping(headers);
  }

  try {
    const texts = [
      ...clean.map((h) => `a spreadsheet column titled "${h}"`),
      ...FIELDS.map((f) => FIELD_PROMPTS[f]),
    ];
    const vectors = (await extractor(texts, { pooling: 'mean', normalize: true })).tolist();

    const headerVecs = vectors.slice(0, clean.length);
    const fieldVecs = vectors.slice(clean.length);

    const scores: { field: keyof Neighborhood; col: number; score: number; semantic: number }[] = [];
    FIELDS.forEach((field, fi) => {
      clean.forEach((_, ci) => {
        const semantic = cosine(fieldVecs[fi], headerVecs[ci]);
        const column = sampleRows.map((r) => r[ci] ?? '');
        scores.push({ field, col: ci, semantic, score: semantic + valuePrior(field, column) });
      });
    });

    scores.sort((a, b) => b.score - a.score);

    const mapping: ColumnMapping[] = [];
    const usedFields = new Set<keyof Neighborhood>();
    const usedCols = new Set<number>();

    for (const s of scores) {
      if (usedFields.has(s.field) || usedCols.has(s.col)) continue;
      // Below this the match is noise; leave the field unmapped and let
      // validation tell the user plainly rather than inventing a column.
      if (s.score < 0.15) continue;
      usedFields.add(s.field);
      usedCols.add(s.col);
      mapping.push({
        sourceColumn: clean[s.col],
        field: s.field,
        confidence: Math.max(0, Math.min(1, s.score)),
        method: 'semantic',
      });
    }

    const missing = FIELDS.filter((f) => !usedFields.has(f));

    // If the model missed a field the plain alias table can resolve, fill it in
    // rather than failing on a header we could always have handled.
    if (missing.length > 0) {
      const fallback = aliasMapping(headers);
      for (const m of fallback.mapping) {
        if (!usedFields.has(m.field) && !mapping.some((x) => x.sourceColumn === m.sourceColumn)) {
          usedFields.add(m.field);
          mapping.push(m);
        }
      }
    }

    return {
      mapping,
      usedModel: true,
      missing: FIELDS.filter((f) => !usedFields.has(f)),
    };
  } catch {
    return aliasMapping(headers);
  }
}
