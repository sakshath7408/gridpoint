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
import {
  mapColumns, loadModel, onStatus, MODEL_ID, type MapperStatus,
} from '@/lib/ai/columnMapper';

const MapView = dynamic(() => import('@/components/MapView'), { ssr: false });
const KSweepChart = dynamic(() => import('@/components/KSweepChart'), { ssr: false });

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
const inrK = (n: number) =>
  n >= 100000 ? `₹${(n / 100000).toFixed(1)}L` : n >= 1000 ? `₹${(n / 1000).toFixed(1)}k` : `₹${Math.round(n)}`;
const num = (n: number) => Math.round(n).toLocaleString('en-IN');
const pct = (v: number) => `${(v / 100)}`;

type Source = 'sample' | 'upload' | 'manual';
type Tab = 'breakdown' | 'assignment' | 'proof';

interface UploadInfo {
  fileName: string;
  mapping: ColumnMapping[];
  usedModel: boolean;
  parseErrors: string[];
}

/** A collapsible group. Advanced controls stay one click away, never in the face. */
function Fold({
  title, tag, children, defaultOpen = false,
}: { title: string; tag?: string; children: React.ReactNode; defaultOpen?: boolean }) {
  return (
    <details className="fold" open={defaultOpen}>
      <summary>
        <span className="chev">
          <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
            <path d="M3.5 2 7 5l-3.5 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        {title}
        {tag && <span className="tag">{tag}</span>}
      </summary>
      <div className="fold-body">{children}</div>
    </details>
  );
}

function Slider({
  label, value, min, max, step = 1, onChange, display,
}: {
  label: string; value: number; min: number; max: number; step?: number;
  onChange: (v: number) => void; display: string;
}) {
  return (
    <div className="field">
      <div className="label"><span>{label}</span><b className="num">{display}</b></div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(+e.target.value)}
        style={{ ['--pct' as string]: `${((value - min) / (max - min)) * 100}%` }}
      />
    </div>
  );
}

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
  const [result, setResult] = useState<Result | null>(null);
  const [sweep, setSweep] = useState<{ points: KSweepPoint[]; optimalK: number } | null>(null);
  const [proof, setProof] = useState<ProofReport | null>(null);
  const [robust, setRobust] = useState<Robustness | null>(null);
  const [mapMode, setMapMode] = useState<'before' | 'after'>('before');
  const [focused, setFocused] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('breakdown');
  const [ai, setAi] = useState<MapperStatus>({ state: 'idle' });
  const [aiBusy, setAiBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => onStatus(setAi), []);

  /* ------------------------------ data ------------------------------ */
  const baseData = useMemo<Neighborhood[]>(() => {
    if (source === 'sample') return SAMPLES[sampleName] ?? [];
    if (source === 'upload') return uploaded ?? [];
    return parseCsv(manualText).rows;
  }, [source, sampleName, uploaded, manualText]);

  const manualReport = useMemo(
    () => (source === 'manual' ? parseCsv(manualText) : null), [source, manualText],
  );

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
    warehouseCostPerDay: whCost,
    roadFactor: DEFAULT_CONSTRAINTS.roadFactor,
  }), [useCapacity, capacity, useRadius, maxRadius, vehicle, traffic, fuelPrice, driverWage, whCost]);

  useEffect(() => { if (k > maxK) setK(maxK); }, [maxK, k]);

  /* ----------------------------- compute ----------------------------- */
  const compute = useCallback(() => {
    if (!validation.ok || neighborhoods.length === 0) return;
    const kk = Math.min(k, neighborhoods.length);
    const r = run(neighborhoods, kk, constraints);
    setResult(r);
    setSweep(sweepK(neighborhoods, maxK, constraints));
    setProof(proveOptimality(neighborhoods, kk, constraints));
    setRobust(stressTest(neighborhoods, r.warehouses, constraints, 16));
  }, [neighborhoods, k, constraints, validation.ok, maxK]);

  const handleRun = () => {
    if (!validation.ok) return;
    setBusy(true);
    requestAnimationFrame(() => {
      compute(); setHasRun(true); setMapMode('after'); setBusy(false);
    });
  };

  useEffect(() => { if (hasRun) compute(); }, [hasRun, compute]);

  /* --------------------------- upload + AI --------------------------- */
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

  const optimalK = sweep?.optimalK ?? null;
  const bd = result?.breakdown;
  const showAfter = hasRun && mapMode === 'after' && !!result;
  const networkSaving = sweep && result
    ? ((sweep.points[0].total - result.total_cost) / sweep.points[0].total) * 100 : 0;

  return (
    <div className="app">
      {/* ============================= header ============================= */}
      <header className="head">
        <div className="logo">
          <span className="logo-mark">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M8 1.5 14 5v6l-6 3.5L2 11V5l6-3.5Z" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />
              <circle cx="8" cy="8" r="2" fill="#fff" />
            </svg>
          </span>
          GridPoint
        </div>
        <span className="logo-sub">Where should the warehouse go?</span>
        <div className="head-spacer" />
        {hasRun && result && (
          <div className="seg" style={{ width: 150 }}>
            <button aria-pressed={mapMode === 'before'} onClick={() => setMapMode('before')}>Before</button>
            <button aria-pressed={mapMode === 'after'} onClick={() => setMapMode('after')}>After</button>
          </div>
        )}
        <button className="btn primary" onClick={handleRun} disabled={!validation.ok || busy}>
          {busy ? <><span className="spin" /> Solving…</> : hasRun ? 'Re-run' : 'Optimise'}
        </button>
      </header>

      {/* ============================== left ============================== */}
      <aside className="panel-col left">
        {/* 1 — data */}
        <section className="block">
          <div className="h"><span className="n">1</span>Neighborhood data</div>
          <p className="why">
            Where your customers are and how much they order. Any of the three routes
            ends in the same validated shape.
          </p>

          <div className="seg" style={{ marginBottom: 12 }}>
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
                {aiBusy ? <><span className="spin" /> Reading…</> : 'Choose a CSV'}
              </button>
              <button className="btn ghost sm" onClick={() => ingestCsv(MESSY_DEMO_CSV, 'unfamiliar_headers.csv')} disabled={aiBusy}>
                Try one with unfamiliar headers →
              </button>

              {uploadInfo && (
                <div style={{ marginTop: 6 }}>
                  <div className="label">
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{uploadInfo.fileName}</span>
                    <span className={`pill ${uploadInfo.usedModel ? 'accent' : 'warn'}`}>
                      {uploadInfo.usedModel ? 'AI mapped' : 'alias table'}
                    </span>
                  </div>
                  {uploadInfo.mapping.map((m) => (
                    <div className="kv" key={m.sourceColumn}>
                      <dt style={{ maxWidth: 135, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.sourceColumn}</dt>
                      <dd style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span className="dim">→</span>
                        <code style={{ color: 'var(--accent-2)' }}>{m.field}</code>
                        {m.method === 'semantic' && <span className="num dim" style={{ fontSize: 10 }}>{(m.confidence * 100).toFixed(0)}%</span>}
                      </dd>
                    </div>
                  ))}
                  {uploadInfo.parseErrors.length > 0 && (
                    <div className="msg err" style={{ marginTop: 8 }}>
                      <ul>{uploadInfo.parseErrors.slice(0, 4).map((e, i) => <li key={i}>{e}</li>)}</ul>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {source === 'manual' && (
            <>
              <div className="label"><span>One row per area</span><span className="dim">id, lat, lon, orders</span></div>
              <textarea
                value={manualText} spellCheck={false} rows={8}
                onChange={(e) => { setManualText(e.target.value); resetRun(); }}
                style={{ fontFamily: 'var(--mono)', fontSize: 11.5, lineHeight: 1.6, resize: 'vertical' }}
              />
              {manualReport && manualReport.errors.length > 0 && (
                <div className="msg err" style={{ marginTop: 8 }}>
                  <ul>{manualReport.errors.slice(0, 3).map((e, i) => <li key={i}>{e}</li>)}</ul>
                </div>
              )}
            </>
          )}

          {validation.ok ? (
            <p className="note" style={{ marginTop: 11 }}>
              <b className="num" style={{ color: 'var(--ink)' }}>{neighborhoods.length}</b> areas ·{' '}
              <b className="num" style={{ color: 'var(--ink)' }}>{num(totalOrders)}</b> orders/day
            </p>
          ) : (
            <div className="msg err" style={{ marginTop: 11, marginBottom: 0 }}>
              <ul>{validation.errors.slice(0, 4).map((e, i) => <li key={i}>{e}</li>)}</ul>
            </div>
          )}
        </section>

        {/* 2 — network size */}
        <section className="block">
          <div className="h"><span className="n">2</span>How many warehouses</div>
          <p className="why">
            More warehouses means shorter trips but more rent. There is a number that
            balances the two — we work it out for you.
          </p>
          <Slider label="Warehouses (K)" value={k} min={1} max={maxK} onChange={setK} display={String(k)} />
          {optimalK !== null && (
            k === optimalK
              ? <p className="note">★ K={optimalK} is the cost optimum at these settings.</p>
              : <button className="btn wide sm" onClick={() => setK(optimalK)}
                        style={{ color: 'var(--accent-2)' }}>
                  Use the optimum · K={optimalK}
                </button>
          )}
        </section>

        {/* advanced, folded */}
        <Fold title="Fleet & costs" tag={`${vehicle.emoji} ${traffic.label}`}>
          <p className="why" style={{ marginTop: 0 }}>
            These set the rupees-per-kilometre the optimiser is actually minimising.
          </p>
          <div className="field">
            <div className="label"><span>Vehicle</span></div>
            <select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
              {VEHICLES.map((v) => <option key={v.id} value={v.id}>{v.emoji} {v.label} — {v.capacity}/trip</option>)}
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
          <p className="note">Facility rent is per warehouse. Lower it and a denser network wins.</p>
        </Fold>

        <Fold title="Constraints" tag={[useCapacity && 'capacity', useRadius && 'radius'].filter(Boolean).join(' · ') || 'none'}>
          <p className="why" style={{ marginTop: 0 }}>
            Real limits. Anything they break is flagged rather than quietly hidden.
          </p>
          <label className="check" style={{ marginBottom: useCapacity ? 10 : 12 }}>
            <input type="checkbox" checked={useCapacity} onChange={(e) => setUseCapacity(e.target.checked)} />
            Cap orders per warehouse
          </label>
          {useCapacity && (
            <Slider label="Capacity" value={capacity} min={200} max={4000} step={50} onChange={setCapacity} display={`${num(capacity)}/day`} />
          )}
          <label className="check" style={{ marginBottom: useRadius ? 10 : 0 }}>
            <input type="checkbox" checked={useRadius} onChange={(e) => setUseRadius(e.target.checked)} />
            Maximum service radius
          </label>
          {useRadius && (
            <Slider label="Radius" value={maxRadius} min={2} max={40} onChange={setMaxRadius} display={`${maxRadius} km`} />
          )}
        </Fold>

        <Fold title="Demand scenario" tag={scenario.label}>
          <p className="why" style={{ marginTop: 0 }}>
            Plan for the city you will have, not the one you have today.
          </p>
          <select value={scenarioId} onChange={(e) => setScenarioId(e.target.value)}>
            {DEMAND_SCENARIOS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
          <p className="note" style={{ marginTop: 7 }}>{scenario.description}</p>
        </Fold>

        <Fold title="AI component" tag={ai.state === 'ready' ? 'loaded' : ai.state === 'loading' ? `${ai.progress}%` : ai.state === 'unavailable' ? 'offline' : 'on demand'}>
          <p className="why" style={{ marginTop: 0 }}>
            A real transformer runs <em>in this browser</em> to read spreadsheet headers by
            meaning — so a file with columns nobody anticipated still loads.
          </p>
          <div className="kv"><dt>Model</dt><dd style={{ fontSize: 11 }}>MiniLM-L6-v2</dd></div>
          <div className="kv"><dt>Runtime</dt><dd style={{ fontSize: 11 }}>WebAssembly, on-device</dd></div>
          <div className="kv"><dt>API keys</dt><dd style={{ fontSize: 11 }}>none</dd></div>
          {ai.state === 'idle' && (
            <button className="btn wide sm" style={{ marginTop: 10 }} onClick={() => loadModel().catch(() => {})}>
              Preload model (~23 MB)
            </button>
          )}
          <p className="note" style={{ marginTop: 9 }}><code>{MODEL_ID}</code></p>
        </Fold>
      </aside>

      {/* ============================= centre ============================= */}
      <main className="center">
        <div className="map-host">
          <MapView neighborhoods={neighborhoods} result={result} mode={showAfter ? 'after' : 'before'} focusedWarehouse={focused} />

          <div className="map-badges">
            <span className="badge"><b className="num">{neighborhoods.length}</b> areas</span>
            <span className="badge"><b className="num">{num(totalOrders)}</b> orders/day</span>
            {showAfter && <span className="badge"><b className="num">{result!.warehouses.length}</b> warehouses</span>}
            {showAfter && !!result!.over_capacity?.length && (
              <span className="badge warn">over capacity: <b>{result!.over_capacity.join(', ')}</b></span>
            )}
            {showAfter && !!result!.out_of_radius?.length && (
              <span className="badge warn"><b className="num">{result!.out_of_radius.length}</b> beyond {maxRadius} km</span>
            )}
          </div>

          <div className="map-legend">
            <div className="legend-title">{showAfter ? 'Optimised network' : 'Demand today'}</div>
            {showAfter ? (
              <>
                {result!.warehouses.map((w, i) => (
                  <div key={w.id} className="legend-row"
                       style={{ cursor: 'pointer', opacity: focused && focused !== w.id ? 0.35 : 1 }}
                       onMouseEnter={() => setFocused(w.id)} onMouseLeave={() => setFocused(null)}>
                    <span className="legend-dot" style={{ background: SERIES[i % SERIES.length] }} />
                    {w.id}
                    <span className="num dim" style={{ marginLeft: 'auto' }}>{num(result!.load?.[w.id] ?? 0)}</span>
                  </div>
                ))}
                <div className="legend-row dim" style={{ fontSize: 10.5, marginTop: 4 }}>hover a row to isolate it</div>
              </>
            ) : (
              <>
                <div className="legend-row"><span className="legend-dot" style={{ background: '#7d7d8d' }} />one area</div>
                <div className="legend-row dim" style={{ fontSize: 10.5 }}>circle size = daily orders</div>
                {hasRun && <div className="legend-row"><span className="legend-dot ring" />naive central depot</div>}
              </>
            )}
          </div>
        </div>
      </main>

      {/* ============================== right ============================== */}
      <aside className="panel-col right">
        {!hasRun || !result || !bd ? (
          <section className="block">
            <div className="h">What happens next</div>
            <p className="why">Press <strong style={{ color: 'var(--ink)' }}>Optimise</strong> and the model runs these four steps.</p>
            <div className="steps">
              {[
                ['Place the warehouses', 'Weighted k-medians finds the K points that minimise order-weighted delivery cost. Not k-means — cost is linear in distance, not squared.'],
                ['Assign every area', 'Each neighborhood goes to the warehouse that is genuinely cheapest to serve it from, respecting any capacity limit.'],
                ['Price the network', 'Trips, fuel, driver hours and facility rent become one rupees-per-day figure.'],
                ['Compare and prove', 'Against a single central depot, against a k-means network, and against exhaustive search.'],
              ].map(([t, d], i) => (
                <div className="step-row" key={i}>
                  <span className="step-n">{i + 1}</span>
                  <div><div className="step-t">{t}</div><div className="step-d">{d}</div></div>
                </div>
              ))}
            </div>
            <p className="note" style={{ marginTop: 12 }}>
              The map right now shows raw demand — one circle per area, sized by daily orders.
            </p>
          </section>
        ) : (
          <>
            <div className="hero">
              <div className="hero-label">Cheaper than one depot in the middle</div>
              <div className="hero-value num">{networkSaving.toFixed(1)}%</div>
              <div className="hero-sub num">
                {sweep ? `${inr(sweep.points[0].total)} → ${inr(result.total_cost)} per day` : ''}
              </div>
              <div className="hero-bar">
                <span style={{ background: CHART.delivery, width: `${(bd.delivery / bd.total) * 100}%` }} />
                <span style={{ background: CHART.infrastructure, width: `${(bd.infrastructure / bd.total) * 100}%` }} />
              </div>
              <div className="hero-key">
                <span><i style={{ background: CHART.delivery }} />Delivery {inrK(bd.delivery)}</span>
                <span><i style={{ background: CHART.infrastructure }} />Facilities {inrK(bd.infrastructure)}</span>
              </div>
            </div>

            <div className="stats">
              <div className="stat">
                <div className="stat-l">Per order</div>
                <div className="stat-v num">₹{(bd.total / Math.max(totalOrders, 1)).toFixed(2)}</div>
                <div className="stat-s num">{num(bd.vehicleKm)} veh-km/day</div>
              </div>
              <div className="stat">
                <div className="stat-l">vs k-means network</div>
                <div className="stat-v num" style={{ color: 'var(--good)' }}>−{(result.placement_gain_pct ?? 0).toFixed(1)}%</div>
                <div className="stat-s">same K, worse maths</div>
              </div>
              {result.impact && (
                <>
                  <div className="stat">
                    <div className="stat-l">Saved per year</div>
                    <div className="stat-v num">{inrK(result.impact.savedPerYear)}</div>
                    <div className="stat-s num">{inr(result.impact.savedPerDay)}/day</div>
                  </div>
                  <div className="stat">
                    <div className="stat-l">CO₂ avoided</div>
                    <div className="stat-v num">{result.impact.co2TonnesSavedPerYear.toFixed(1)} t</div>
                    <div className="stat-s">per year</div>
                  </div>
                </>
              )}
            </div>

            {sweep && (
              <section className="block">
                <div className="h">The trade-off</div>
                <p className="why">
                  Every warehouse buys back delivery cost and adds rent. The total bottoms
                  out at <strong style={{ color: 'var(--accent-2)' }}>K={sweep.optimalK}</strong>. Click a bar to try it.
                </p>
                <KSweepChart points={sweep.points} optimalK={sweep.optimalK} currentK={Math.min(k, maxK)} onPick={setK} />
                {robust && robust.trials > 0 && (
                  <p className="note" style={{ marginTop: 12, paddingTop: 11, borderTop: '1px solid var(--hairline-2)' }}>
                    <strong style={{ color: 'var(--ink-2)' }}>Does it survive change?</strong>{' '}
                    Across {robust.trials} runs with demand shifted up to ±{robust.swingPct}%, keeping
                    these warehouses costs on average{' '}
                    <strong className="num" style={{ color: robust.meanRegretPct < 3 ? 'var(--good)' : 'var(--warning)' }}>
                      {robust.meanRegretPct.toFixed(1)}%
                    </strong>{' '}
                    more than re-optimising from scratch. {robust.verdict}
                  </p>
                )}
              </section>
            )}

            <div className="tabs" role="tablist">
              <button role="tab" aria-selected={tab === 'breakdown'} onClick={() => setTab('breakdown')}>Costs</button>
              <button role="tab" aria-selected={tab === 'assignment'} onClick={() => setTab('assignment')}>Assignment</button>
              <button role="tab" aria-selected={tab === 'proof'} onClick={() => setTab('proof')}>Proof</button>
            </div>

            {tab === 'breakdown' && (
              <section className="block">
                <dl>
                  <div className="kv"><dt>Fuel &amp; upkeep</dt><dd className="num">{inr(bd.fuel)}</dd></div>
                  <div className="kv"><dt>Driver time</dt><dd className="num">{inr(bd.driver)}</dd></div>
                  <div className="kv"><dt>Facilities</dt><dd className="num">{inr(bd.infrastructure)}</dd></div>
                  <div className="kv"><dt style={{ color: 'var(--ink)' }}>Total per day</dt><dd className="num">{inr(bd.total)}</dd></div>
                  <div className="kv"><dt>Per year</dt><dd className="num">{inrK(bd.total * 365)}</dd></div>
                  <div className="kv"><dt>Driver hours/day</dt><dd className="num">{bd.driverHours.toFixed(1)}</dd></div>
                </dl>
                {result.impact && (
                  <p className="note" style={{ marginTop: 10 }}>
                    <strong style={{ color: 'var(--ink-2)' }}>{result.impact.co2KgPerDay.toFixed(0)} kg CO₂/day</strong>{' '}
                    ({result.impact.co2TonnesPerYear.toFixed(1)} t/yr) from {num(result.impact.kmPerDay)} vehicle-km.
                    <br />{result.impact.assumption}
                  </p>
                )}
                <p className="note" style={{ marginTop: 10 }}>
                  Covers the trunk leg — warehouse to neighborhood — plus rent. Delivery
                  <em> inside</em> an area is excluded on purpose: it barely changes with
                  warehouse position, so it cannot move the optimum.
                </p>
              </section>
            )}

            {tab === 'assignment' && (
              <table className="tbl">
                <thead><tr><th>Area</th><th className="r">Orders</th><th>Depot</th><th className="r">km</th></tr></thead>
                <tbody>
                  {neighborhoods.map((n) => {
                    const wid = result.assignments[n.id];
                    const idx = result.warehouses.findIndex((w) => w.id === wid);
                    const d = result.distances_km?.[n.id];
                    const far = result.out_of_radius?.includes(n.id);
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
                  {proof.verdict.replace(/-/g, ' ')}
                </span>
                <p className="note" style={{ color: 'var(--ink-2)', margin: '10px 0 12px' }}>{proof.claim}</p>
                <dl>
                  {proof.discreteTractable && (
                    <div className="kv"><dt>Sitings enumerated</dt><dd className="num">{num(proof.subsetsEnumerated)}</dd></div>
                  )}
                  <div className="kv"><dt>Perturbations tested</dt><dd className="num">{num(proof.localProbes)}</dd></div>
                  <div className="kv"><dt>k-means penalty</dt><dd className="num" style={{ color: 'var(--good)' }}>+{proof.kmeansPenaltyPct.toFixed(2)}%</dd></div>
                </dl>
              </section>
            )}
          </>
        )}
      </aside>
    </div>
  );
}
