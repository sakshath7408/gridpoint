'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';

import {
  SAMPLES, DEFAULT_SAMPLE, MESSY_DEMO_CSV, parseCsv, parseCsvHeaders, validate, toCsv,
} from '@/lib/data';
import {
  run, sweepK, proveOptimality, applyDemandScenario, stressTest,
  DEFAULT_CONSTRAINTS, VEHICLES, TRAFFIC, DEMAND_SCENARIOS,
  type KSweepPoint, type ProofReport,
} from '@/lib/engine';
import type { ColumnMapping, Constraints, Neighborhood, Result, Robustness } from '@/lib/types';
import { SERIES, CHART } from '@/lib/palette';
import { mapColumns, loadModel, onStatus, MODEL_ID, type MapperStatus } from '@/lib/ai/columnMapper';

const MapView = dynamic(() => import('@/components/MapView'), { ssr: false });
const KSweepChart = dynamic(() => import('@/components/KSweepChart'), { ssr: false });

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
const inrK = (n: number) =>
  n >= 100000 ? `₹${(n / 100000).toFixed(1)}L` : n >= 1000 ? `₹${(n / 1000).toFixed(1)}k` : `₹${Math.round(n)}`;
const num = (n: number) => Math.round(n).toLocaleString('en-IN');

type Source = 'sample' | 'upload' | 'manual';
type Tab = 'costs' | 'areas' | 'proof';

interface UploadInfo {
  fileName: string; mapping: ColumnMapping[]; usedModel: boolean; parseErrors: string[];
}

const STEPS: [string, string][] = [
  ['Place the warehouses', 'Weighted k-medians finds the K points minimising order-weighted cost. Not k-means — cost is linear in distance, not squared.'],
  ['Assign every area', 'Each one goes to the warehouse genuinely cheapest to serve it from.'],
  ['Price the network', 'Trips, fuel, driver hours and rent become one rupees-per-day figure.'],
  ['Compare and prove', 'Against one central depot, against k-means, and against exhaustive search.'],
];

/* ----------------------------- small pieces ----------------------------- */

/** Eases a number towards its target so the headline never just "appears". */
function useCountUp(target: number, ms = 900) {
  const [v, setV] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    const a = from.current, b = target;
    from.current = target;
    if (a === b) return;
    if (typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches) { setV(b); return; }
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / ms);
      const e = 1 - Math.pow(1 - p, 3);
      setV(a + (b - a) * e);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

function Fold({ title, tag, children }: { title: string; tag?: string; children: React.ReactNode }) {
  return (
    <details className="fold">
      <summary>
        <span className="chev">
          <svg width="8" height="8" viewBox="0 0 10 10" fill="none">
            <path d="M3.5 2 7 5l-3.5 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        {title}
        {tag && <span className="tag">{tag}</span>}
      </summary>
      <div className="fold-body">{children}</div>
    </details>
  );
}

function Slider({ label, value, min, max, step = 1, onChange, display }: {
  label: string; value: number; min: number; max: number; step?: number;
  onChange: (v: number) => void; display: string;
}) {
  return (
    <div className="field">
      <div className="label"><span>{label}</span><b className="num">{display}</b></div>
      <input type="range" min={min} max={max} step={step} value={value}
             onChange={(e) => onChange(+e.target.value)}
             style={{ ['--pct' as string]: `${((value - min) / (max - min)) * 100}%` }} />
    </div>
  );
}

const Icon = {
  copy: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.8" /><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
    </svg>
  ),
  link: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6.5 9.5 9.5 6.5" /><path d="M7 4.5 8.2 3.3a2.6 2.6 0 0 1 3.7 3.7L10.7 8.2" /><path d="M9 11.5 7.8 12.7a2.6 2.6 0 0 1-3.7-3.7L5.3 7.8" />
    </svg>
  ),
  download: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2.5v8" /><path d="m5 7.5 3 3 3-3" /><path d="M3 13.5h10" />
    </svg>
  ),
  check: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="m3.5 8.5 3 3 6-7" />
    </svg>
  ),
  tick: (
    <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m3.5 8.5 3 3 6-7" />
    </svg>
  ),
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/* --------------------------------- page --------------------------------- */

export default function Page() {
  const [source, setSource] = useState<Source>('sample');
  const [sampleName, setSampleName] = useState(DEFAULT_SAMPLE);
  const [uploaded, setUploaded] = useState<Neighborhood[] | null>(null);
  const [uploadInfo, setUploadInfo] = useState<UploadInfo | null>(null);
  const [manualText, setManualText] = useState(() => toCsv(SAMPLES[DEFAULT_SAMPLE].slice(0, 6)));

  const [scenarioId, setScenarioId] = useState(DEMAND_SCENARIOS[0].id);
  const [k, setK] = useState(3);
  const [vehicleId, setVehicleId] = useState(DEFAULT_CONSTRAINTS.vehicle.id);
  const [trafficId, setTrafficId] = useState(DEFAULT_CONSTRAINTS.traffic.id);
  const [fuelPrice, setFuelPrice] = useState(DEFAULT_CONSTRAINTS.fuelPrice);
  const [driverWage, setDriverWage] = useState(DEFAULT_CONSTRAINTS.driverWage);
  const [whCost, setWhCost] = useState(DEFAULT_CONSTRAINTS.warehouseCostPerDay);
  const [useCapacity, setUseCapacity] = useState(false);
  const [capacity, setCapacity] = useState(1400);
  const [useRadius, setUseRadius] = useState(false);
  const [maxRadius, setMaxRadius] = useState(10);

  const [hasRun, setHasRun] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState(0);            // 0 idle · 1..4 solving step
  const [result, setResult] = useState<Result | null>(null);
  const [sweep, setSweep] = useState<{ points: KSweepPoint[]; optimalK: number } | null>(null);
  const [proof, setProof] = useState<ProofReport | null>(null);
  const [robust, setRobust] = useState<Robustness | null>(null);
  const [mapMode, setMapMode] = useState<'before' | 'after'>('before');
  const [focused, setFocused] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('costs');
  const [ai, setAi] = useState<MapperStatus>({ state: 'idle' });
  const [aiBusy, setAiBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [autoRun, setAutoRun] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => onStatus(setAi), []);

  const baseData = useMemo<Neighborhood[]>(() => {
    if (source === 'sample') return SAMPLES[sampleName] ?? [];
    if (source === 'upload') return uploaded ?? [];
    return parseCsv(manualText).rows;
  }, [source, sampleName, uploaded, manualText]);

  const manualReport = useMemo(() => (source === 'manual' ? parseCsv(manualText) : null), [source, manualText]);
  const scenario = DEMAND_SCENARIOS.find((s) => s.id === scenarioId) ?? DEMAND_SCENARIOS[0];
  const neighborhoods = useMemo(() => applyDemandScenario(baseData, scenario), [baseData, scenario]);
  const validation = useMemo(() => validate(neighborhoods), [neighborhoods]);
  const totalOrders = neighborhoods.reduce((s, n) => s + n.orders, 0);
  const maxK = Math.max(1, Math.min(neighborhoods.length, 8));

  const vehicle = VEHICLES.find((v) => v.id === vehicleId) ?? VEHICLES[0];
  const traffic = TRAFFIC.find((t) => t.id === trafficId) ?? TRAFFIC[1];

  const constraints = useMemo<Constraints>(() => ({
    capacity: useCapacity ? capacity : 0,
    maxRadiusKm: useRadius ? maxRadius : 0,
    vehicle, traffic, fuelPrice, driverWage,
    warehouseCostPerDay: whCost, roadFactor: DEFAULT_CONSTRAINTS.roadFactor,
  }), [useCapacity, capacity, useRadius, maxRadius, vehicle, traffic, fuelPrice, driverWage, whCost]);

  useEffect(() => { if (k > maxK) setK(maxK); }, [maxK, k]);

  /* ---- permalink: the whole scenario lives in the URL hash ---- */
  useEffect(() => {
    try {
      const h = new URLSearchParams(window.location.hash.replace(/^#/, ''));
      const s = h.get('s'); if (s && SAMPLES[s]) setSampleName(s);
      const kk = Number(h.get('k')); if (kk >= 1 && kk <= 8) setK(kk);
      const v = h.get('v'); if (v && VEHICLES.some((x) => x.id === v)) setVehicleId(v);
      const t = h.get('t'); if (t && TRAFFIC.some((x) => x.id === t)) setTrafficId(t);
      const f = Number(h.get('f')); if (f >= 40 && f <= 160) setFuelPrice(f);
      const w = Number(h.get('w')); if (w >= 60 && w <= 400) setDriverWage(w);
      const r = Number(h.get('r')); if (r >= 500 && r <= 15000) setWhCost(r);
      const cap = Number(h.get('cap')); if (cap >= 200 && cap <= 4000) { setUseCapacity(true); setCapacity(cap); }
      const rad = Number(h.get('rad')); if (rad >= 2 && rad <= 40) { setUseRadius(true); setMaxRadius(rad); }
      const sc = h.get('sc'); if (sc && DEMAND_SCENARIOS.some((x) => x.id === sc)) setScenarioId(sc);
      if (h.get('run') === '1') setAutoRun(true);
    } catch { /* malformed hash: ignore */ }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated || source !== 'sample') return;
    const p = new URLSearchParams();
    p.set('s', sampleName); p.set('k', String(k));
    if (vehicleId !== DEFAULT_CONSTRAINTS.vehicle.id) p.set('v', vehicleId);
    if (trafficId !== DEFAULT_CONSTRAINTS.traffic.id) p.set('t', trafficId);
    if (fuelPrice !== DEFAULT_CONSTRAINTS.fuelPrice) p.set('f', String(fuelPrice));
    if (driverWage !== DEFAULT_CONSTRAINTS.driverWage) p.set('w', String(driverWage));
    if (whCost !== DEFAULT_CONSTRAINTS.warehouseCostPerDay) p.set('r', String(whCost));
    if (useCapacity) p.set('cap', String(capacity));
    if (useRadius) p.set('rad', String(maxRadius));
    if (scenarioId !== DEMAND_SCENARIOS[0].id) p.set('sc', scenarioId);
    if (hasRun) p.set('run', '1');
    window.history.replaceState(null, '', `#${p.toString()}`);
  }, [hydrated, source, sampleName, k, vehicleId, trafficId, fuelPrice, driverWage, whCost,
      useCapacity, capacity, useRadius, maxRadius, scenarioId, hasRun]);

  /* ---- solving ---- */
  const compute = useCallback(() => {
    if (!validation.ok || neighborhoods.length === 0) return;
    const kk = Math.min(k, neighborhoods.length);
    const r = run(neighborhoods, kk, constraints);
    setResult(r);
    setSweep(sweepK(neighborhoods, maxK, constraints));
    setProof(proveOptimality(neighborhoods, kk, constraints));
    setRobust(stressTest(neighborhoods, r.warehouses, constraints, 16));
  }, [neighborhoods, k, constraints, validation.ok, maxK]);

  // First run walks the four steps visibly. Each step is the real computation
  // for that stage; we only hold each one on screen long enough to be read.
  const handleRun = useCallback(async () => {
    if (!validation.ok || busy) return;
    if (hasRun) { compute(); return; }
    setBusy(true);
    const kk = Math.min(k, neighborhoods.length);
    const hold = async (i: number, work: () => void) => {
      setStage(i); await frame();
      const t0 = performance.now(); work();
      const left = 160 - (performance.now() - t0);
      if (left > 0) await sleep(left);
    };
    const box: { r: Result | null } = { r: null };
    await hold(1, () => { box.r = run(neighborhoods, kk, constraints); });
    await hold(2, () => { setResult(box.r); });
    await hold(3, () => { setSweep(sweepK(neighborhoods, maxK, constraints)); });
    await hold(4, () => {
      setProof(proveOptimality(neighborhoods, kk, constraints));
      if (box.r) setRobust(stressTest(neighborhoods, box.r.warehouses, constraints, 16));
    });
    await sleep(120);
    setHasRun(true); setMapMode('after'); setBusy(false); setStage(0);
  }, [validation.ok, busy, hasRun, compute, k, neighborhoods, constraints, maxK]);

  useEffect(() => { if (hasRun) compute(); }, [hasRun, compute]);

  useEffect(() => {
    if (autoRun && hydrated && validation.ok && !hasRun && !busy) { setAutoRun(false); void handleRun(); }
  }, [autoRun, hydrated, validation.ok, hasRun, busy, handleRun]);

  // ⌘/Ctrl + Enter runs it from anywhere on the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void handleRun(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleRun]);

  const ingestCsv = async (text: string, fileName: string) => {
    setAiBusy(true);
    const headers = parseCsvHeaders(text);
    const rows = text.split(/\r?\n/).slice(1, 9).filter((l) => l.trim() !== '')
      .map((l) => l.split(',').map((c) => c.trim()));
    const outcome = await mapColumns(headers, rows);
    const report = parseCsv(text, outcome.mapping);
    setUploaded(report.rows);
    setUploadInfo({ fileName, mapping: outcome.mapping, usedModel: outcome.usedModel, parseErrors: report.errors });
    setSource('upload'); setHasRun(false); setMapMode('before'); setAiBusy(false);
  };

  const resetRun = () => { setHasRun(false); setMapMode('before'); };

  /* ---- share / export ---- */
  const flash = (msg: string, key: string) => {
    setToast(msg); setDone(key);
    window.setTimeout(() => setToast(null), 1800);
    window.setTimeout(() => setDone(null), 1400);
  };

  const copyText = async (text: string, msg: string, key: string) => {
    try { await navigator.clipboard.writeText(text); flash(msg, key); }
    catch { flash('Could not access the clipboard', key); }
  };

  const summaryText = () => {
    if (!result || !sweep || !bd) return '';
    const base = sweep.points[0].total;
    return [
      `GridPoint — ${neighborhoods.length} areas, ${num(totalOrders)} orders/day (${source === 'sample' ? sampleName : 'uploaded data'}).`,
      `K=${result.warehouses.length}: ${inr(result.total_cost)}/day vs ${inr(base)} for one central depot — ${saving.toFixed(1)}% cheaper.`,
      `Cost optimum is K=${sweep.optimalK}${sweep.optimalK !== result.warehouses.length ? ` (${inr(sweep.points[sweep.optimalK - 1].total)}/day)` : ''}.`,
      `Weighted k-medians beats a k-means network at the same K by ${(result.placement_gain_pct ?? 0).toFixed(1)}%.`,
      result.impact ? `Saves ${inrK(result.impact.savedPerYear)}/year and avoids ${result.impact.co2TonnesSavedPerYear.toFixed(0)} t CO₂.` : '',
      robust && robust.trials > 0 ? `Regret under ±${robust.swingPct}% demand shift: ${robust.meanRegretPct.toFixed(1)}%.` : '',
      `Fleet: ${vehicle.label}, ${traffic.label.toLowerCase()} traffic, fuel ₹${fuelPrice}/L, driver ₹${driverWage}/hr, rent ${inr(whCost)}/day.`,
    ].filter(Boolean).join('\n');
  };

  const exportCsv = () => {
    if (!result) return;
    const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const rows = ['type,id,lat,lon,orders_per_day,assigned_to,distance_km'];
    result.warehouses.forEach((w) =>
      rows.push(`warehouse,${q(w.id)},${w.lat.toFixed(6)},${w.lon.toFixed(6)},${result.load?.[w.id] ?? ''},,`));
    neighborhoods.forEach((n) =>
      rows.push(`area,${q(n.id)},${n.lat},${n.lon},${n.orders},${q(result.assignments[n.id] ?? '')},${result.distances_km?.[n.id]?.toFixed(3) ?? ''}`));
    const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: `gridpoint-network-k${result.warehouses.length}.csv` });
    a.click(); URL.revokeObjectURL(url);
    flash('Network exported as CSV', 'csv');
  };

  /* ---- derived ---- */
  const optimalK = sweep?.optimalK ?? null;
  const bd = result?.breakdown;
  const showAfter = hasRun && mapMode === 'after' && !!result;
  const saving = sweep && result
    ? ((sweep.points[0].total - result.total_cost) / sweep.points[0].total) * 100 : 0;
  const savingShown = useCountUp(hasRun ? saving : 0);
  const showResults = hasRun && !!result && !!bd;

  const stepState = (i: number): 'idle' | 'active' | 'done' =>
    stage === 0 ? 'idle' : i + 1 < stage ? 'done' : i + 1 === stage ? 'active' : 'idle';

  return (
    <div className="app">
      {/* the map is the page */}
      <div className="map-host">
        <MapView neighborhoods={neighborhoods} result={result}
                 mode={showAfter ? 'after' : 'before'} focusedWarehouse={focused} />
      </div>

      <header className="head glass">
        <div className="brand">
          <span className="logo-mark">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M8 1.5 14 5v6l-6 3.5L2 11V5l6-3.5Z" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />
              <circle cx="8" cy="8" r="2" fill="#fff" />
            </svg>
          </span>
          <span className="logo">GridPoint</span>
          <span className="logo-sub">Where should the warehouse go?</span>
        </div>
        <div className="head-spacer" />
        {hasRun && result && (
          <div className="seg" style={{ width: 140 }}>
            <button aria-pressed={mapMode === 'before'} onClick={() => setMapMode('before')}>Before</button>
            <button aria-pressed={mapMode === 'after'} onClick={() => setMapMode('after')}>After</button>
          </div>
        )}
        <button className="btn primary" onClick={() => void handleRun()} disabled={!validation.ok || busy}
                title="⌘ Enter / Ctrl Enter">
          {busy ? <><span className="spin" /> Solving</> : hasRun ? 'Re-run' : 'Optimise'}
          {!busy && <span className="kbd">⌘↩</span>}
        </button>
      </header>

      {/* ------------------------------ left ------------------------------ */}
      <aside className="panel left glass">
        <div className="panel-scroll">
          <section className="block">
            <div className="eyebrow"><span className="idx">01</span>Input</div>
            <div className="h">Neighborhood data</div>
            <p className="why">Where customers are, and how much they order.</p>

            <div className="seg" style={{ marginBottom: 10 }}>
              <button aria-pressed={source === 'sample'} onClick={() => { setSource('sample'); resetRun(); }}>Sample</button>
              <button aria-pressed={source === 'upload'} onClick={() => setSource('upload')}>Upload</button>
              <button aria-pressed={source === 'manual'} onClick={() => { setSource('manual'); resetRun(); }}>Type</button>
            </div>

            {source === 'sample' && (
              <select value={sampleName} onChange={(e) => { setSampleName(e.target.value); resetRun(); }}>
                {Object.keys(SAMPLES).map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            )}

            {source === 'upload' && (
              <>
                <input ref={fileRef} type="file" accept=".csv,text/csv" style={{ display: 'none' }}
                       onChange={(e) => { const f = e.target.files?.[0]; if (f) f.text().then((t) => ingestCsv(t, f.name)); }} />
                <button className="btn wide" onClick={() => fileRef.current?.click()} disabled={aiBusy}>
                  {aiBusy ? <><span className="spin" /> Reading</> : 'Choose a CSV'}
                </button>
                <button className="btn ghost sm" onClick={() => ingestCsv(MESSY_DEMO_CSV, 'unfamiliar_headers.csv')} disabled={aiBusy}>
                  Try one with unfamiliar headers →
                </button>
                {uploadInfo && (
                  <div style={{ marginTop: 6 }}>
                    <div className="label">
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{uploadInfo.fileName}</span>
                      <span className={`pill ${uploadInfo.usedModel ? 'accent' : 'warn'}`}>
                        <span className="dot" />{uploadInfo.usedModel ? 'AI mapped' : 'alias table'}
                      </span>
                    </div>
                    {uploadInfo.mapping.map((m) => (
                      <div className="kv" key={m.sourceColumn}>
                        <dt style={{ maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.sourceColumn}</dt>
                        <dd style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span className="faint">→</span>
                          <code className="mono" style={{ color: 'var(--accent-3)', fontSize: 11.5 }}>{m.field}</code>
                          {m.method === 'semantic' && <span className="num faint" style={{ fontSize: 10 }}>{(m.confidence * 100).toFixed(0)}%</span>}
                        </dd>
                      </div>
                    ))}
                    {uploadInfo.parseErrors.length > 0 && (
                      <div className="msg err" style={{ marginTop: 8 }}>
                        <ul>{uploadInfo.parseErrors.slice(0, 3).map((e, i) => <li key={i}>{e}</li>)}</ul>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}

            {source === 'manual' && (
              <>
                <div className="label"><span>One row per area</span><span className="mono faint" style={{ fontSize: 10.5 }}>id, lat, lon, orders</span></div>
                <textarea value={manualText} spellCheck={false} rows={7}
                          onChange={(e) => { setManualText(e.target.value); resetRun(); }}
                          style={{ fontFamily: 'var(--mono)', fontSize: 11, lineHeight: 1.6, resize: 'vertical' }} />
                {manualReport && manualReport.errors.length > 0 && (
                  <div className="msg err" style={{ marginTop: 8 }}>
                    <ul>{manualReport.errors.slice(0, 3).map((e, i) => <li key={i}>{e}</li>)}</ul>
                  </div>
                )}
              </>
            )}

            {validation.ok ? (
              <p className="note" style={{ marginTop: 10 }}>
                <b className="num" style={{ color: 'var(--ink)' }}>{neighborhoods.length}</b> areas ·{' '}
                <b className="num" style={{ color: 'var(--ink)' }}>{num(totalOrders)}</b> orders/day
              </p>
            ) : (
              <div className="msg err" style={{ marginTop: 10, marginBottom: 0 }}>
                <ul>{validation.errors.slice(0, 3).map((e, i) => <li key={i}>{e}</li>)}</ul>
              </div>
            )}
          </section>

          <section className="block">
            <div className="eyebrow"><span className="idx">02</span>Decision</div>
            <div className="h">How many warehouses</div>
            <p className="why">More warehouses, shorter trips, more rent. One number balances it.</p>
            <Slider label="Warehouses (K)" value={k} min={1} max={maxK} onChange={setK} display={String(k)} />
            {optimalK !== null && (
              k === optimalK
                ? <p className="note"><span style={{ color: 'var(--accent-3)' }}>K={optimalK}</span> is the cost optimum for this network.</p>
                : <button className="btn wide sm tint" onClick={() => setK(optimalK)}>
                    Use the optimum · K={optimalK}
                  </button>
            )}
          </section>

          <Fold title="Fleet & costs" tag={`${vehicle.label} · ${traffic.label}`}>
            <div className="field">
              <div className="label"><span>Vehicle</span></div>
              <select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
                {VEHICLES.map((v) => <option key={v.id} value={v.id}>{v.label} — {v.capacity} orders/trip</option>)}
              </select>
            </div>
            <div className="field">
              <div className="label"><span>Traffic</span></div>
              <select value={trafficId} onChange={(e) => setTrafficId(e.target.value)}>
                {TRAFFIC.map((t) => <option key={t.id} value={t.id}>{t.label} — {t.description}</option>)}
              </select>
            </div>
            <Slider label="Fuel" value={fuelPrice} min={40} max={160} onChange={setFuelPrice} display={`₹${fuelPrice}/L`} />
            <Slider label="Driver" value={driverWage} min={60} max={400} step={5} onChange={setDriverWage} display={`₹${driverWage}/hr`} />
            <Slider label="Facility rent" value={whCost} min={500} max={15000} step={250} onChange={setWhCost} display={`${inr(whCost)}/day`} />
          </Fold>

          <Fold title="Constraints" tag={[useCapacity && 'capacity', useRadius && 'radius'].filter(Boolean).join(' · ') || 'none'}>
            <label className="check" style={{ marginBottom: useCapacity ? 10 : 12 }}>
              <input type="checkbox" checked={useCapacity} onChange={(e) => setUseCapacity(e.target.checked)} />
              Cap orders per warehouse
            </label>
            {useCapacity && <Slider label="Capacity" value={capacity} min={200} max={4000} step={50} onChange={setCapacity} display={`${num(capacity)}/day`} />}
            <label className="check" style={{ marginBottom: useRadius ? 10 : 0 }}>
              <input type="checkbox" checked={useRadius} onChange={(e) => setUseRadius(e.target.checked)} />
              Maximum service radius
            </label>
            {useRadius && <Slider label="Radius" value={maxRadius} min={2} max={40} onChange={setMaxRadius} display={`${maxRadius} km`} />}
          </Fold>

          <Fold title="Demand scenario" tag={scenario.label}>
            <select value={scenarioId} onChange={(e) => setScenarioId(e.target.value)}>
              {DEMAND_SCENARIOS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
            <p className="note" style={{ marginTop: 8 }}>{scenario.description}</p>
          </Fold>

          <Fold title="AI component" tag={ai.state === 'ready' ? 'loaded' : ai.state === 'loading' ? `${ai.progress}%` : ai.state === 'unavailable' ? 'offline' : 'on demand'}>
            <p className="why" style={{ marginTop: 0 }}>
              A sentence-transformer runs <em>in this browser</em> to read spreadsheet
              headers by meaning. No API key, no server.
            </p>
            <div className="kv"><dt>Model</dt><dd style={{ fontSize: 11.5 }}>MiniLM-L6-v2</dd></div>
            <div className="kv"><dt>Runtime</dt><dd style={{ fontSize: 11.5 }}>WebAssembly, on-device</dd></div>
            {ai.state === 'idle' && (
              <button className="btn wide sm" style={{ marginTop: 10 }} onClick={() => loadModel().catch(() => {})}>
                Preload (~23 MB)
              </button>
            )}
            <p className="note mono faint" style={{ marginTop: 9, fontSize: 10 }}>{MODEL_ID}</p>
          </Fold>
        </div>
        <footer className="panel-foot">
          <span>Weighted k-medians · Weiszfeld · certified</span>
          <a href="https://github.com/sakshath7408/gridpoint" target="_blank" rel="noreferrer">
            Source ↗
          </a>
        </footer>
      </aside>

      {/* ------------------------------ right ------------------------------ */}
      <aside className="panel right glass">
        <div className="panel-scroll">
          {!showResults ? (
            <section className="block">
              <div className="eyebrow">{busy ? 'Solving' : 'What happens next'}</div>
              <div className="h">{busy ? 'Working through the four steps' : 'Four steps, one answer'}</div>
              <p className="why">
                {busy ? 'Each step is the real computation for that stage.' : <>Press <b style={{ color: 'var(--ink)' }}>Optimise</b> to run them.</>}
              </p>
              <div className="timeline">
                {STEPS.map(([t, d], i) => {
                  const st = stepState(i);
                  return (
                    <div className="tl-row" key={i} data-state={st}>
                      <span className="tl-dot">{st === 'done' ? Icon.tick : i + 1}</span>
                      <div><div className="tl-t">{t}</div><div className="tl-d">{d}</div></div>
                    </div>
                  );
                })}
              </div>
            </section>
          ) : (
            <>
              <div className="hero rise">
                <div className="hero-top">
                  <div className="eyebrow" style={{ whiteSpace: 'nowrap' }}>Cheaper than one central depot</div>
                  <div className="hero-actions">
                    <button className="icon-btn" data-done={done === 'sum'} title="Copy a one-paragraph summary"
                            onClick={() => copyText(summaryText(), 'Summary copied', 'sum')}>{done === 'sum' ? Icon.check : Icon.copy}</button>
                    <button className="icon-btn" data-done={done === 'link'} title="Copy a link to this exact scenario"
                            onClick={() => copyText(window.location.href, 'Link copied — opens on this result', 'link')}>{done === 'link' ? Icon.check : Icon.link}</button>
                    <button className="icon-btn" data-done={done === 'csv'} title="Export warehouses and assignments as CSV"
                            onClick={exportCsv}>{done === 'csv' ? Icon.check : Icon.download}</button>
                  </div>
                </div>
                <div className="hero-value num">{savingShown.toFixed(1)}<span className="unit">%</span></div>
                <div className="hero-sub num">
                  {sweep ? <><b>{inr(result!.total_cost)}</b> per day, down from {inr(sweep.points[0].total)}</> : ''}
                </div>
                <div className="hero-bar">
                  <span style={{ background: CHART.delivery, width: `${(bd!.delivery / bd!.total) * 100}%` }} />
                  <span style={{ background: CHART.infrastructure, width: `${(bd!.infrastructure / bd!.total) * 100}%` }} />
                </div>
                <div className="hero-key">
                  <span><i style={{ background: CHART.delivery }} />Delivery <b className="num">{inrK(bd!.delivery)}</b></span>
                  <span><i style={{ background: CHART.infrastructure }} />Facilities <b className="num">{inrK(bd!.infrastructure)}</b></span>
                </div>
              </div>

              <div className="stats rise-2">
                <div className="stat">
                  <div className="stat-l">Saved per year</div>
                  <div className="stat-v num">{result!.impact ? inrK(result!.impact.savedPerYear) : '—'}</div>
                  <div className="stat-s">at today's demand</div>
                </div>
                <div className="stat">
                  <div className="stat-l">CO₂ avoided</div>
                  <div className="stat-v num">{result!.impact ? `${result!.impact.co2TonnesSavedPerYear.toFixed(0)} t` : '—'}</div>
                  <div className="stat-s">per year</div>
                </div>
                <div className="stat">
                  <div className="stat-l">vs k-means</div>
                  <div className="stat-v num" style={{ color: 'var(--good)' }}>−{(result!.placement_gain_pct ?? 0).toFixed(1)}%</div>
                  <div className="stat-s">at equal K</div>
                </div>
              </div>

              {sweep && (
                <section className="block rise-3">
                  <div className="eyebrow">The trade-off</div>
                  <p className="why" style={{ marginTop: 5 }}>
                    Each warehouse buys back delivery cost and adds rent. The total bottoms
                    out at <b style={{ color: 'var(--accent-3)' }}>K={sweep.optimalK}</b>.
                  </p>
                  <KSweepChart points={sweep.points} optimalK={sweep.optimalK} currentK={Math.min(k, maxK)} onPick={setK} />
                </section>
              )}

              <div className="rise-4">
                <div className="tabs" role="tablist">
                  <button role="tab" aria-selected={tab === 'costs'} onClick={() => setTab('costs')}>Costs</button>
                  <button role="tab" aria-selected={tab === 'areas'} onClick={() => setTab('areas')}>Areas</button>
                  <button role="tab" aria-selected={tab === 'proof'} onClick={() => setTab('proof')}>Proof</button>
                </div>

                {tab === 'costs' && (
                  <section className="block">
                    <dl>
                      <div className="kv"><dt>Fuel &amp; upkeep</dt><dd className="num">{inr(bd!.fuel)}</dd></div>
                      <div className="kv"><dt>Driver time</dt><dd className="num">{inr(bd!.driver)}</dd></div>
                      <div className="kv"><dt>Facilities</dt><dd className="num">{inr(bd!.infrastructure)}</dd></div>
                      <div className="kv total"><dt>Total per day</dt><dd className="num">{inr(bd!.total)}</dd></div>
                      <div className="kv"><dt>Per order</dt><dd className="num">₹{(bd!.total / Math.max(totalOrders, 1)).toFixed(2)}</dd></div>
                      <div className="kv"><dt>Vehicle-km per day</dt><dd className="num">{num(bd!.vehicleKm)}</dd></div>
                      {result!.impact && <div className="kv"><dt>CO₂ per day</dt><dd className="num">{result!.impact.co2KgPerDay.toFixed(0)} kg</dd></div>}
                    </dl>
                    {robust && robust.trials > 0 && (
                      <p className="note" style={{ marginTop: 12 }}>
                        <strong style={{ color: 'var(--ink-2)' }}>Survives change.</strong> Across {robust.trials} runs
                        with demand shifted ±{robust.swingPct}%, keeping these warehouses costs{' '}
                        <strong className="num" style={{ color: robust.meanRegretPct < 3 ? 'var(--good)' : 'var(--warning)' }}>
                          {robust.meanRegretPct.toFixed(1)}%
                        </strong>{' '}
                        more than re-optimising with hindsight.
                      </p>
                    )}
                    <p className="note" style={{ marginTop: 9 }}>
                      Trunk leg plus rent. Delivery <em>inside</em> an area is excluded — it
                      barely changes with warehouse position, so it cannot move the optimum.
                    </p>
                  </section>
                )}

                {tab === 'areas' && (
                  <table className="tbl">
                    <thead><tr><th>Area</th><th className="r">Orders</th><th>Depot</th><th className="r">km</th></tr></thead>
                    <tbody>
                      {neighborhoods.map((n) => {
                        const wid = result!.assignments[n.id];
                        const idx = result!.warehouses.findIndex((w) => w.id === wid);
                        const d = result!.distances_km?.[n.id];
                        const far = result!.out_of_radius?.includes(n.id);
                        return (
                          <tr key={n.id} onMouseEnter={() => setFocused(wid)} onMouseLeave={() => setFocused(null)}>
                            <td style={{ color: 'var(--ink)' }}>{n.id}</td>
                            <td className="r num">{num(n.orders)}</td>
                            <td><span className="sw" style={{ background: SERIES[idx % SERIES.length] }} />{wid}</td>
                            <td className="r num" style={far ? { color: 'var(--warning)' } : {}}>{d !== undefined ? d.toFixed(1) : '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}

                {tab === 'proof' && proof && (
                  <section className="block">
                    <span className={`pill ${proof.verdict === 'globally-optimal' || proof.verdict === 'certified' ? 'good' : 'warn'}`}>
                      <span className="dot" />{proof.verdict.replace(/-/g, ' ')}
                    </span>
                    <p className="note" style={{ color: 'var(--ink-2)', margin: '10px 0 12px' }}>{proof.claim}</p>
                    <dl>
                      {proof.discreteTractable && <div className="kv"><dt>Sitings enumerated</dt><dd className="num">{num(proof.subsetsEnumerated)}</dd></div>}
                      <div className="kv"><dt>Perturbations tested</dt><dd className="num">{num(proof.localProbes)}</dd></div>
                      <div className="kv"><dt>k-means penalty</dt><dd className="num" style={{ color: 'var(--good)' }}>+{proof.kmeansPenaltyPct.toFixed(2)}%</dd></div>
                    </dl>
                  </section>
                )}
              </div>
            </>
          )}
        </div>
      </aside>

      {/* ------------------------- map overlays ------------------------- */}
      <div className="map-badges glass">
        <span className="badge"><b className="num">{neighborhoods.length}</b> areas</span>
        <span className="badge"><b className="num">{num(totalOrders)}</b> orders/day</span>
        {showAfter && <span className="badge"><b className="num">{result!.warehouses.length}</b> warehouses</span>}
        {showAfter && !!result!.over_capacity?.length && (
          <span className="badge warn">over capacity · <b>{result!.over_capacity.join(', ')}</b></span>
        )}
        {showAfter && !!result!.out_of_radius?.length && (
          <span className="badge warn"><b className="num">{result!.out_of_radius.length}</b> beyond {maxRadius} km</span>
        )}
      </div>

      <div className="map-legend glass">
        <div className="legend-title">{showAfter ? 'Optimised network' : 'Demand today'}</div>
        {showAfter ? (
          <>
            {result!.warehouses.map((w, i) => (
              <div key={w.id} className="legend-row"
                   style={{ cursor: 'pointer', opacity: focused && focused !== w.id ? 0.3 : 1 }}
                   onMouseEnter={() => setFocused(w.id)} onMouseLeave={() => setFocused(null)}>
                <span className="legend-dot" style={{ background: SERIES[i % SERIES.length] }} />
                {w.id}
                <span className="num dim" style={{ marginLeft: 'auto', paddingLeft: 14 }}>{num(result!.load?.[w.id] ?? 0)}</span>
              </div>
            ))}
            <div className="legend-row faint" style={{ fontSize: 10.5, marginTop: 3 }}>orders served per day</div>
          </>
        ) : (
          <>
            <div className="legend-row"><span className="legend-dot round" style={{ background: '#8a8a96' }} />one area</div>
            <div className="legend-row faint" style={{ fontSize: 10.5 }}>circle area = daily orders</div>
            {hasRun && <div className="legend-row"><span className="legend-dot hollow" />naive depot</div>}
          </>
        )}
      </div>

      {toast && <div className="toast glass">{toast}</div>}
    </div>
  );
}
