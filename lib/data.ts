// GridPoint — data ingestion and validation.
// TypeScript transliteration of python/data.py (Module B1).

import type { ColumnMapping, Neighborhood, ParseReport, ValidationResult } from './types';

export const REQUIRED_COLUMNS = ['id', 'lat', 'lon', 'orders'] as const;

/**
 * Deterministic header aliases. This is the FALLBACK path — the primary path is
 * the in-browser embedding model in lib/ai/columnMapper.ts, which matches
 * headers by meaning. This table exists so the app still works offline, before
 * the model has downloaded, or if inference fails.
 */
const COLUMN_ALIASES: Record<string, keyof Neighborhood> = {
  id: 'id', name: 'id', neighborhood: 'id', neighbourhood: 'id',
  area: 'id', zone: 'id', locality: 'id', region: 'id', ward: 'id',
  lat: 'lat', latitude: 'lat', y: 'lat', ycoord: 'lat',
  lon: 'lon', lng: 'lon', long: 'lon', longitude: 'lon', x: 'lon', xcoord: 'lon',
  orders: 'orders', order: 'orders', demand: 'orders', weight: 'orders',
  volume: 'orders', dailyorders: 'orders', deliveries: 'orders',
  parcels: 'orders', shipments: 'orders',
};

function cleanKey(key: string): string {
  return String(key ?? '').trim().toLowerCase().replace(/[\s_\-.]/g, '');
}

export function canonicalColumn(header: string): keyof Neighborhood | null {
  return COLUMN_ALIASES[cleanKey(header)] ?? null;
}

// ---------------------------------------------------------------------------
// Coercion — every helper reports, none of them throw
// ---------------------------------------------------------------------------

function coerceFloat(v: unknown, field: string, where: string): [number | null, string | null] {
  if (v === null || v === undefined) return [null, `${where}: '${field}' is missing.`];
  let text = String(v).trim().replace(/°/g, '');
  if (text === '') return [null, `${where}: '${field}' is empty.`];
  text = (text.split(',').length === 2 && !text.includes('.'))
    ? text.replace(',', '.')
    : text.replace(/,/g, '');
  const n = Number(text);
  if (!Number.isFinite(n)) return [null, `${where}: '${field}' is not a number (got "${v}").`];
  return [n, null];
}

function coerceInt(v: unknown, field: string, where: string): [number | null, string | null] {
  if (v === null || v === undefined) return [null, `${where}: '${field}' is missing.`];
  const text = String(v).trim().replace(/[,_]/g, '');
  if (text === '') return [null, `${where}: '${field}' is empty.`];
  const n = Number(text);
  if (!Number.isFinite(n)) return [null, `${where}: '${field}' is not a number (got "${v}").`];
  if (!Number.isInteger(n)) {
    return [null, `${where}: '${field}' must be a whole number of orders (got "${v}").`];
  }
  return [n, null];
}

function buildNeighborhood(
  raw: Partial<Record<keyof Neighborhood, unknown>>, where: string,
): [Neighborhood | null, string[]] {
  const errors: string[] = [];

  const idRaw = raw.id;
  let id: string | null = null;
  if (idRaw === null || idRaw === undefined) errors.push(`${where}: 'id' is missing.`);
  else if (String(idRaw).trim() === '') errors.push(`${where}: 'id' is empty.`);
  else id = String(idRaw).trim();

  const [lat, e1] = coerceFloat(raw.lat, 'lat', where); if (e1) errors.push(e1);
  const [lon, e2] = coerceFloat(raw.lon, 'lon', where); if (e2) errors.push(e2);
  const [orders, e3] = coerceInt(raw.orders, 'orders', where); if (e3) errors.push(e3);

  if (errors.length > 0) return [null, errors];
  return [{ id: id!, lat: lat!, lon: lon!, orders: orders! }, []];
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

function splitCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === delimiter && !inQuotes) {
      out.push(cur); cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function detectDelimiter(headerLine: string): string {
  const candidates = [',', ';', '\t', '|'];
  let best = ',';
  let bestCount = -1;
  for (const d of candidates) {
    const count = headerLine.split(d).length;
    if (count > bestCount) { bestCount = count; best = d; }
  }
  return best;
}

export function parseCsvHeaders(text: string): string[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return [];
  return splitCsvLine(lines[0], detectDelimiter(lines[0]));
}

/**
 * Parse CSV text into neighborhoods.
 *
 * `mapping` (from the AI column mapper, or from the alias table) says which
 * source column feeds which field. Bad rows are collected and reported — one
 * malformed line never costs you the rest of the file.
 */
export function parseCsv(text: string, mapping?: ColumnMapping[]): ParseReport {
  const clean = text.replace(/^﻿/, '');
  if (clean.trim() === '') return { rows: [], errors: ['The CSV file is empty.'] };

  const lines = clean.split(/\r?\n/);
  const headerLine = lines.find((l) => l.trim() !== '');
  if (!headerLine) return { rows: [], errors: ['The CSV file is empty.'] };

  const delimiter = detectDelimiter(headerLine);
  const headers = splitCsvLine(headerLine, delimiter);

  const resolved: ColumnMapping[] = mapping ?? headers.flatMap((h) => {
    const field = canonicalColumn(h);
    return field
      ? [{ sourceColumn: h, field, confidence: 1, method: 'alias' as const }]
      : [];
  });

  const byField = new Map<keyof Neighborhood, string>();
  for (const m of resolved) if (!byField.has(m.field)) byField.set(m.field, m.sourceColumn);

  const missing = REQUIRED_COLUMNS.filter((c) => !byField.has(c));
  if (missing.length > 0) {
    return {
      rows: [],
      errors: [
        `CSV is missing required column(s): ${missing.join(', ')}. ` +
        `Found: ${headers.join(', ')}. Expected: id, lat, lon, orders.`,
      ],
      columnMapping: resolved,
    };
  }

  const headerIndex = new Map(headers.map((h, i) => [h, i]));
  const rows: Neighborhood[] = [];
  const errors: string[] = [];
  const startIdx = lines.indexOf(headerLine) + 1;

  for (let li = startIdx; li < lines.length; li++) {
    const line = lines[li];
    if (line.trim() === '') continue;
    const cells = splitCsvLine(line, delimiter);
    const raw: Partial<Record<keyof Neighborhood, unknown>> = {};
    for (const [field, col] of byField) raw[field] = cells[headerIndex.get(col) ?? -1];

    if (Object.values(raw).every((v) => v === undefined || String(v).trim() === '')) continue;

    const [rec, rowErrors] = buildNeighborhood(raw, `Row ${li + 1}`);
    if (rowErrors.length > 0) errors.push(...rowErrors);
    else rows.push(rec!);
  }

  if (rows.length === 0 && errors.length === 0) {
    errors.push('The CSV has a header but no data rows.');
  }
  return { rows, errors, columnMapping: resolved };
}

/** Manual-entry rows from the editable table. */
export function parseRows(
  input: Array<Partial<Record<string, unknown>>>,
): ParseReport {
  const rows: Neighborhood[] = [];
  const errors: string[] = [];

  input.forEach((row, i) => {
    const where = `Row ${i + 1}`;
    const mapped: Partial<Record<keyof Neighborhood, unknown>> = {};
    for (const [k, v] of Object.entries(row)) {
      const field = canonicalColumn(k);
      if (field && mapped[field] === undefined) mapped[field] = v;
    }
    const blank = Object.values(mapped).every(
      (v) => v === null || v === undefined || String(v).trim() === '',
    );
    if (blank) return;
    const [rec, rowErrors] = buildNeighborhood(mapped, where);
    if (rowErrors.length > 0) errors.push(...rowErrors);
    else rows.push(rec!);
  });

  if (rows.length === 0 && errors.length === 0) errors.push('No rows were entered.');
  return { rows, errors };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validate(neighborhoods: unknown): ValidationResult {
  if (neighborhoods === null || neighborhoods === undefined) {
    return { ok: false, errors: ['No data loaded. Pick a sample, upload a CSV, or enter rows manually.'] };
  }
  if (!Array.isArray(neighborhoods)) {
    return { ok: false, errors: [`Expected a list of neighborhoods, got ${typeof neighborhoods}.`] };
  }
  if (neighborhoods.length === 0) {
    return { ok: false, errors: ['Need at least 1 neighborhood — the dataset is empty.'] };
  }

  const errors: string[] = [];
  const seen = new Map<string, number>();

  neighborhoods.forEach((item: unknown, idx: number) => {
    const index = idx + 1;
    let label = `Neighborhood #${index}`;

    if (typeof item !== 'object' || item === null) {
      errors.push(`${label}: expected an object, got ${typeof item}.`);
      return;
    }
    const rec = item as Record<string, unknown>;

    const missing = REQUIRED_COLUMNS.filter((c) => !(c in rec));
    if (missing.length > 0) {
      errors.push(`${label}: missing key(s) ${missing.join(', ')}.`);
      return;
    }

    const id = rec.id;
    if (typeof id !== 'string') errors.push(`${label}: 'id' must be text.`);
    else if (id.trim() === '') errors.push(`${label}: 'id' is empty — every neighborhood needs a name.`);
    else {
      label = `"${id}"`;
      if (seen.has(id)) {
        errors.push(`Duplicate id "${id}": used by neighborhood #${seen.get(id)} and #${index}. Ids must be unique.`);
      } else seen.set(id, index);
    }

    const lat = rec.lat;
    if (typeof lat !== 'number' || Number.isNaN(lat)) errors.push(`${label}: 'lat' must be a number.`);
    else if (lat < -90 || lat > 90) errors.push(`${label}: latitude ${lat} is out of range — must be between -90 and 90.`);

    const lon = rec.lon;
    if (typeof lon !== 'number' || Number.isNaN(lon)) errors.push(`${label}: 'lon' must be a number.`);
    else if (lon < -180 || lon > 180) errors.push(`${label}: longitude ${lon} is out of range — must be between -180 and 180.`);

    const orders = rec.orders;
    if (typeof orders !== 'number' || !Number.isInteger(orders)) errors.push(`${label}: 'orders' must be a whole number.`);
    else if (orders < 0) errors.push(`${label}: orders is ${orders} — orders cannot be negative.`);
  });

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Sample datasets
// ---------------------------------------------------------------------------
// Seven Indian metros. Coordinates are approximate locality CENTROIDS, good to
// roughly a kilometre — which is the right precision for this model, because a
// "neighborhood" here is the demand centre of an area several kilometres
// across, not a survey point. Each set is validated geometrically: every zone
// inside its city's metro bounding box, no transposed lat/lon, no duplicate
// coordinates, and a spread consistent with a single delivery region.
//
// Order counts are INVENTED demand figures for demonstration. They are shaped
// to be plausible — tech corridors and satellite townships order more than old
// central districts — but they are not real company data and are not presented
// as such.

export const SAMPLES: Record<string, Neighborhood[]> = {
  'Bengaluru — 12 zones': [
    { id: 'Koramangala',     lat: 12.9352, lon: 77.6245, orders: 420 },
    { id: 'Indiranagar',     lat: 12.9784, lon: 77.6408, orders: 310 },
    { id: 'Jayanagar',       lat: 12.9250, lon: 77.5938, orders: 260 },
    { id: 'Whitefield',      lat: 12.9698, lon: 77.7500, orders: 540 },
    { id: 'Hebbal',          lat: 13.0358, lon: 77.5970, orders: 180 },
    { id: 'Electronic City', lat: 12.8452, lon: 77.6602, orders: 610 },
    { id: 'Rajajinagar',     lat: 12.9916, lon: 77.5526, orders: 150 },
    { id: 'HSR Layout',      lat: 12.9116, lon: 77.6473, orders: 390 },
    { id: 'Yelahanka',       lat: 13.1007, lon: 77.5963, orders: 120 },
    { id: 'Marathahalli',    lat: 12.9591, lon: 77.6974, orders: 470 },
    { id: 'Banashankari',    lat: 12.9250, lon: 77.5667, orders: 230 },
    { id: 'Malleshwaram',    lat: 13.0035, lon: 77.5709, orders: 200 },
  ],
  'Delhi NCR — 10 zones': [
    { id: 'Connaught Place', lat: 28.6304, lon: 77.2177, orders: 340 },
    { id: 'Karol Bagh',      lat: 28.6519, lon: 77.1909, orders: 290 },
    { id: 'Saket',           lat: 28.5245, lon: 77.2066, orders: 380 },
    { id: 'Dwarka',          lat: 28.5921, lon: 77.0460, orders: 520 },
    { id: 'Rohini',          lat: 28.7495, lon: 77.0565, orders: 460 },
    { id: 'Lajpat Nagar',    lat: 28.5677, lon: 77.2433, orders: 310 },
    { id: 'Vasant Kunj',     lat: 28.5200, lon: 77.1591, orders: 270 },
    { id: 'Noida Sec 18',    lat: 28.5707, lon: 77.3260, orders: 590 },
    { id: 'Gurugram Cyber',  lat: 28.4950, lon: 77.0890, orders: 640 },
    { id: 'Shahdara',        lat: 28.6730, lon: 77.2890, orders: 250 },
  ],
  'Mumbai — 9 zones': [
    { id: 'Andheri',    lat: 19.1197, lon: 72.8468, orders: 520 },
    { id: 'Bandra',     lat: 19.0596, lon: 72.8295, orders: 410 },
    { id: 'Dadar',      lat: 19.0178, lon: 72.8478, orders: 330 },
    { id: 'Powai',      lat: 19.1176, lon: 72.9060, orders: 290 },
    { id: 'Borivali',   lat: 19.2307, lon: 72.8567, orders: 380 },
    { id: 'Thane',      lat: 19.2183, lon: 72.9781, orders: 450 },
    { id: 'Navi Mumbai',lat: 19.0330, lon: 73.0297, orders: 400 },
    { id: 'Colaba',     lat: 18.9067, lon: 72.8147, orders: 170 },
    { id: 'Malad',      lat: 19.1868, lon: 72.8489, orders: 360 },
  ],
  'Hyderabad — 9 zones': [
    { id: 'Banjara Hills',   lat: 17.4156, lon: 78.4347, orders: 330 },
    { id: 'Jubilee Hills',   lat: 17.4326, lon: 78.4071, orders: 300 },
    { id: 'Gachibowli',      lat: 17.4401, lon: 78.3489, orders: 580 },
    { id: 'HITEC City',      lat: 17.4435, lon: 78.3772, orders: 620 },
    { id: 'Kukatpally',      lat: 17.4849, lon: 78.4138, orders: 410 },
    { id: 'Secunderabad',    lat: 17.4399, lon: 78.4983, orders: 350 },
    { id: 'Ameerpet',        lat: 17.4374, lon: 78.4487, orders: 290 },
    { id: 'LB Nagar',        lat: 17.3457, lon: 78.5522, orders: 320 },
    { id: 'Kompally',        lat: 17.5370, lon: 78.4870, orders: 190 },
  ],
  'Chennai — 9 zones': [
    { id: 'T. Nagar',        lat: 13.0418, lon: 80.2341, orders: 380 },
    { id: 'Adyar',           lat: 13.0012, lon: 80.2565, orders: 320 },
    { id: 'Velachery',       lat: 12.9815, lon: 80.2180, orders: 400 },
    { id: 'Anna Nagar',      lat: 13.0850, lon: 80.2101, orders: 350 },
    { id: 'Guindy',          lat: 13.0067, lon: 80.2206, orders: 290 },
    { id: 'Sholinganallur',  lat: 12.9010, lon: 80.2279, orders: 560 },
    { id: 'Mylapore',        lat: 13.0339, lon: 80.2698, orders: 260 },
    { id: 'Porur',           lat: 13.0381, lon: 80.1565, orders: 330 },
    { id: 'Ambattur',        lat: 13.1143, lon: 80.1548, orders: 300 },
  ],
  'Pune — 9 zones': [
    { id: 'Koregaon Park',   lat: 18.5362, lon: 73.8939, orders: 300 },
    { id: 'Hinjewadi',       lat: 18.5936, lon: 73.7301, orders: 610 },
    { id: 'Kothrud',         lat: 18.5074, lon: 73.8077, orders: 340 },
    { id: 'Viman Nagar',     lat: 18.5679, lon: 73.9143, orders: 380 },
    { id: 'Hadapsar',        lat: 18.5089, lon: 73.9260, orders: 420 },
    { id: 'Baner',           lat: 18.5590, lon: 73.7868, orders: 390 },
    { id: 'Camp',            lat: 18.5136, lon: 73.8788, orders: 250 },
    { id: 'Wakad',           lat: 18.5975, lon: 73.7626, orders: 360 },
    { id: 'Katraj',          lat: 18.4488, lon: 73.8600, orders: 220 },
  ],
  'Kolkata — 9 zones': [
    { id: 'Park Street',     lat: 22.5535, lon: 88.3520, orders: 320 },
    { id: 'Salt Lake',       lat: 22.5867, lon: 88.4171, orders: 480 },
    { id: 'New Town',        lat: 22.5800, lon: 88.4600, orders: 440 },
    { id: 'Ballygunge',      lat: 22.5254, lon: 88.3661, orders: 300 },
    { id: 'Howrah',          lat: 22.5958, lon: 88.2636, orders: 410 },
    { id: 'Behala',          lat: 22.4989, lon: 88.3186, orders: 290 },
    { id: 'Dum Dum',         lat: 22.6420, lon: 88.4312, orders: 270 },
    { id: 'Garia',           lat: 22.4620, lon: 88.3900, orders: 310 },
    { id: 'Rajarhat',        lat: 22.6190, lon: 88.4530, orders: 230 },
  ],
  'Bengaluru — 8 zones': [
    { id: 'Koramangala',     lat: 12.9352, lon: 77.6245, orders: 420 },
    { id: 'Indiranagar',     lat: 12.9784, lon: 77.6408, orders: 310 },
    { id: 'Jayanagar',       lat: 12.9250, lon: 77.5938, orders: 260 },
    { id: 'Whitefield',      lat: 12.9698, lon: 77.7500, orders: 540 },
    { id: 'Hebbal',          lat: 13.0358, lon: 77.5970, orders: 180 },
    { id: 'Electronic City', lat: 12.8452, lon: 77.6602, orders: 610 },
    { id: 'Rajajinagar',     lat: 12.9916, lon: 77.5526, orders: 150 },
    { id: 'HSR Layout',      lat: 12.9116, lon: 77.6473, orders: 390 },
  ],
  'Small demo — 4 zones': [
    { id: 'Koramangala', lat: 12.9352, lon: 77.6245, orders: 420 },
    { id: 'Indiranagar', lat: 12.9784, lon: 77.6408, orders: 310 },
    { id: 'Jayanagar',   lat: 12.9250, lon: 77.5938, orders: 260 },
    { id: 'Whitefield',  lat: 12.9698, lon: 77.7500, orders: 540 },
  ],
};

export const DEFAULT_SAMPLE = 'Bengaluru — 12 zones';

export function toCsv(rows: Neighborhood[]): string {
  const head = 'id,lat,lon,orders\n';
  return head + rows.map((r) => `${r.id},${r.lat},${r.lon},${r.orders}`).join('\n') + '\n';
}

/** A deliberately messy CSV used in the demo to show the AI column mapper working. */
export const MESSY_DEMO_CSV = `Locality Name,Y Coordinate,X Coordinate,Parcels Per Day,Manager
Koramangala,12.9352,77.6245,420,R. Iyer
Indiranagar,12.9784,77.6408,310,S. Nair
Jayanagar,12.9250,77.5938,260,A. Rao
Whitefield,12.9698,77.7500,540,M. Khan
Hebbal,13.0358,77.5970,180,P. Das
Electronic City,12.8452,77.6602,610,V. Menon
`;
