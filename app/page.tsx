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
  const [tab, setTab] = useState<Tab>('costs');
  const [ai, setAi] = useState<MapperStatus>({ state: 'idle' });
  const [aiBusy, setAiBusy] = useState(false);
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
    requestAnimationFrame(() => { compute(); setHasRun(true); setMapMode('after'); setBusy(false); });
  };

  useEffect(() => { if (hasRun) compute(); }, [hasRun, compute]);

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
  const saving = sweep && result
    ? ((sweep.points[0].total - result.total_cost) / sweep.points[0].total) * 100 : 0;

  return (
    <div className="app">
      {/* the map is the page */}
      <div className="map-host">
        <MapView neighborhoods={neighborhoods} result={result}
                 mode={showAfter ? 'after' : 'before'} focusedWarehouse={focused} />
      </div>

      <header className="head">
        <span className="logo-mark">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
            <path d="M8 1.5 14 5v6l-6 3.5L2 11V5l6-3.5Z" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />
            <circle cx="8" cy="8" r="2" fill="#fff" />
          </svg>
        </span>
        <span className="logo">GridPoint</span>
        <span className="logo-sub">Where should the warehouse go?</span>
        <div className="head-spacer" />
        {hasRun && result && (
          <div className="seg" style={{ width: 132 }}>
            <button aria-pressed={mapMode === 'before'} onClick={() => setMapMode('before')}>Before</button>
            <button aria-pressed={mapMode === 'after'} onClick={() => setMapMode('after')}>After</button>
          </div>
        )}
        <button className="btn primary" onClick={handleRun} disabled={!validation.ok || busy}>
          {busy ? <><span className="spin" /> Solving</> : hasRun ? 'Re-run' : 'Optimise'}
        </button>
      </header>

      {/* ------------------------------ left ------------------------------ */}
      <aside className="panel left">
        <div className="panel-scroll">
          <section className="block">
            <div className="h"><span className="n">1</span>Neighborhood data</div>
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
                  <div style={{ marginTop: 5 }}>
                    <div className="label">
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{uploadInfo.fileName}</span>
                      <span className={`pill ${uploadInfo.usedModel ? 'accent' : 'warn'}`}>
                        {uploadInfo.usedModel ? 'AI mapped' : 'alias table'}
                      </span>
                    </div>
                    {uploadInfo.mapping.map((m) => (
                      <div className="kv" key={m.sourceColumn}>
                        <dt style={{ maxWidth: 125, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.sourceColumn}</dt>
                        <dd style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          <span className="dim">→</span>
                          <code style={{ color: 'var(--accent-2)' }}>{m.field}</code>
                          {m.method === 'semantic' && <span className="num dim" style={{ fontSize: 9.5 }}>{(m.confidence * 100).toFixed(0)}%</span>}
                        </dd>
                      </div>
                    ))}
                    {uploadInfo.parseErrors.length > 0 && (
                      <div className="msg err" style={{ marginTop: 7 }}>
                        <ul>{uploadInfo.parseErrors.slice(0, 3).map((e, i) => <li key={i}>{e}</li>)}</ul>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}

            {source === 'manual' && (
              <>
                <div className="label"><span>One row per area</span><span className="dim">id, lat, lon, orders</span></div>
                <textarea value={manualText} spellCheck={false} rows={7}
                          onChange={(e) => { setManualText(e.target.value); resetRun(); }}
                          style={{ fontFamily: 'var(--mono)', fontSize: 11, lineHeight: 1.6, resize: 'vertical' }} />
                {manualReport && manualReport.errors.length > 0 && (
                  <div className="msg err" style={{ marginTop: 7 }}>
                    <ul>{manualReport.errors.slice(0, 3).map((e, i) => <li key={i}>{e}</li>)}</ul>
                  </div>
                )}
              </>
            )}

            {validation.ok ? (
              <p className="note" style={{ marginTop: 9 }}>
                <b className="num" style={{ color: 'var(--ink)' }}>{neighborhoods.length}</b> areas ·{' '}
                <b className="num" style={{ color: 'var(--ink)' }}>{num(totalOrders)}</b> orders/day
              </p>
            ) : (
              <div className="msg err" style={{ marginTop: 9, marginBottom: 0 }}>
                <ul>{validation.errors.slice(0, 3).map((e, i) => <li key={i}>{e}</li>)}</ul>
              </div>
            )}
          </section>

          <section className="block">
            <div className="h"><span className="n">2</span>How many warehouses</div>
            <p className="why">More warehouses, shorter trips, more rent. One number balances it.</p>
            <Slider label="Warehouses (K)" value={k} min={1} max={maxK} onChange={setK} display={String(k)} />
            {optimalK !== null && (
              k === optimalK
                ? <p className="note">K={optimalK} is the cost optimum here.</p>
                : <button className="btn wide sm" onClick={() => setK(optimalK)} style={{ color: 'var(--accent-2)' }}>
                    Use the optimum · K={optimalK}
                  </button>
            )}
          </section>

          <Fold title="Fleet & costs" tag={`${vehicle.emoji} ${traffic.label}`}>
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
          </Fold>

          <Fold title="Constraints" tag={[useCapacity && 'capacity', useRadius && 'radius'].filter(Boolean).join(' · ') || 'none'}>
            <label className="check" style={{ marginBottom: useCapacity ? 9 : 11 }}>
              <input type="checkbox" checked={useCapacity} onChange={(e) => setUseCapacity(e.target.checked)} />
              Cap orders per warehouse
            </label>
            {useCapacity && <Slider label="Capacity" value={capacity} min={200} max={4000} step={50} onChange={setCapacity} display={`${num(capacity)}/day`} />}
            <label className="check" style={{ marginBottom: useRadius ? 9 : 0 }}>
              <input type="checkbox" checked={useRadius} onChange={(e) => setUseRadius(e.target.checked)} />
              Maximum service radius
            </label>
            {useRadius && <Slider label="Radius" value={maxRadius} min={2} max={40} onChange={setMaxRadius} display={`${maxRadius} km`} />}
          </Fold>

          <Fold title="Demand scenario" tag={scenario.label}>
            <select value={scenarioId} onChange={(e) => setScenarioId(e.target.value)}>
              {DEMAND_SCENARIOS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
            <p className="note" style={{ marginTop: 6 }}>{scenario.description}</p>
          </Fold>

          <Fold title="AI component" tag={ai.state === 'ready' ? 'loaded' : ai.state === 'loading' ? `${ai.progress}%` : ai.state === 'unavailable' ? 'offline' : 'on demand'}>
            <p className="why" style={{ marginTop: 0 }}>
              A sentence-transformer runs <em>in this browser</em> to read spreadsheet
              headers by meaning. No API key, no server.
            </p>
            <div className="kv"><dt>Model</dt><dd style={{ fontSize: 10.5 }}>MiniLM-L6-v2</dd></div>
            <div className="kv"><dt>Runtime</dt><dd style={{ fontSize: 10.5 }}>WebAssembly, on-device</dd></div>
            {ai.state === 'idle' && (
              <button className="btn wide sm" style={{ marginTop: 9 }} onClick={() => loadModel().catch(() => {})}>
                Preload (~23 MB)
              </button>
            )}
            <p className="note mono" style={{ marginTop: 8, fontSize: 10 }}>{MODEL_ID}</p>
          </Fold>
        </div>
      </aside>

      {/* ------------------------------ right ------------------------------ */}
      <aside className="panel right">
        <div className="panel-scroll">
          {!hasRun || !result || !bd ? (
            <section className="block">
              <div className="h">What happens next</div>
              <p className="why">Press <strong style={{ color: 'var(--ink)' }}>Optimise</strong> to run these four steps.</p>
              {[
                ['Place the warehouses', 'Weighted k-medians finds the K points minimising order-weighted cost. Not k-means — cost is linear in distance, not squared.'],
                ['Assign every area', 'Each one goes to the warehouse genuinely cheapest to serve it from.'],
                ['Price the network', 'Trips, fuel, driver hours and rent become one rupees-per-day figure.'],
                ['Compare and prove', 'Against one central depot, against k-means, and against exhaustive search.'],
              ].map(([t, d], i) => (
                <div className="step-row" key={i}>
                  <span className="step-n">{i + 1}</span>
                  <div><div className="step-t">{t}</div><div className="step-d">{d}</div></div>
                </div>
              ))}
            </section>
          ) : (
            <>
              <div className="hero">
                <div className="hero-label">Cheaper than one depot in the middle</div>
                <div className="hero-value num" style={{ color: 'var(--accent-2)' }}>{saving.toFixed(1)}%</div>
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
                  <div className="stat-l">Saved per year</div>
                  <div className="stat-v num">{result.impact ? inrK(result.impact.savedPerYear) : '—'}</div>
                  <div className="stat-s num">{result.impact ? `${result.impact.co2TonnesSavedPerYear.toFixed(0)} t CO₂ avoided` : ''}</div>
                </div>
                <div className="stat">
                  <div className="stat-l">vs k-means</div>
                  <div className="stat-v num" style={{ color: 'var(--good)' }}>−{(result.placement_gain_pct ?? 0).toFixed(1)}%</div>
                  <div className="stat-s">same K, worse maths</div>
                </div>
              </div>

              {sweep && (
                <section className="block">
                  <div className="h">The trade-off</div>
                  <p className="why">
                    Each warehouse buys back delivery cost and adds rent. The total bottoms
                    out at <strong style={{ color: 'var(--accent-2)' }}>K={sweep.optimalK}</strong>.
                  </p>
                  <KSweepChart points={sweep.points} optimalK={sweep.optimalK} currentK={Math.min(k, maxK)} onPick={setK} />
                </section>
              )}

              <div className="tabs" role="tablist">
                <button role="tab" aria-selected={tab === 'costs'} onClick={() => setTab('costs')}>Costs</button>
                <button role="tab" aria-selected={tab === 'areas'} onClick={() => setTab('areas')}>Areas</button>
                <button role="tab" aria-selected={tab === 'proof'} onClick={() => setTab('proof')}>Proof</button>
              </div>

              {tab === 'costs' && (
                <section className="block">
                  <dl>
                    <div className="kv"><dt>Fuel &amp; upkeep</dt><dd className="num">{inr(bd.fuel)}</dd></div>
                    <div className="kv"><dt>Driver time</dt><dd className="num">{inr(bd.driver)}</dd></div>
                    <div className="kv"><dt>Facilities</dt><dd className="num">{inr(bd.infrastructure)}</dd></div>
                    <div className="kv"><dt style={{ color: 'var(--ink)' }}>Total per day</dt><dd className="num">{inr(bd.total)}</dd></div>
                    <div className="kv"><dt>Per order</dt><dd className="num">₹{(bd.total / Math.max(totalOrders, 1)).toFixed(2)}</dd></div>
                    <div className="kv"><dt>Vehicle-km/day</dt><dd className="num">{num(bd.vehicleKm)}</dd></div>
                    {result.impact && <div className="kv"><dt>CO₂/day</dt><dd className="num">{result.impact.co2KgPerDay.toFixed(0)} kg</dd></div>}
                  </dl>
                  {robust && robust.trials > 0 && (
                    <p className="note" style={{ marginTop: 10 }}>
                      <strong style={{ color: 'var(--ink-2)' }}>Survives change:</strong> across {robust.trials} runs
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
                  <p className="note" style={{ color: 'var(--ink-2)', margin: '9px 0 11px' }}>{proof.claim}</p>
                  <dl>
                    {proof.discreteTractable && <div className="kv"><dt>Sitings enumerated</dt><dd className="num">{num(proof.subsetsEnumerated)}</dd></div>}
                    <div className="kv"><dt>Perturbations tested</dt><dd className="num">{num(proof.localProbes)}</dd></div>
                    <div className="kv"><dt>k-means penalty</dt><dd className="num" style={{ color: 'var(--good)' }}>+{proof.kmeansPenaltyPct.toFixed(2)}%</dd></div>
                  </dl>
                </section>
              )}
            </>
          )}
        </div>
      </aside>

      {/* ------------------------- map overlays ------------------------- */}
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
                   style={{ cursor: 'pointer', opacity: focused && focused !== w.id ? 0.3 : 1 }}
                   onMouseEnter={() => setFocused(w.id)} onMouseLeave={() => setFocused(null)}>
                <span className="legend-dot" style={{ background: SERIES[i % SERIES.length] }} />
                {w.id}
                <span className="num dim" style={{ marginLeft: 'auto' }}>{num(result!.load?.[w.id] ?? 0)}</span>
              </div>
            ))}
          </>
        ) : (
          <>
            <div className="legend-row"><span className="legend-dot" style={{ background: '#8a8a96' }} />one area</div>
            <div className="legend-row dim" style={{ fontSize: 10 }}>size = daily orders</div>
            {hasRun && <div className="legend-row"><span className="legend-dot hollow" />naive depot</div>}
          </>
        )}
      </div>
    </div>
  );
}
