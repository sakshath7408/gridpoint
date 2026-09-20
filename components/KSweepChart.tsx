'use client';

/**
 * The infrastructure-vs-delivery trade-off.
 *
 * Form: stacked bar. The data's job is composition-within-magnitude across an
 * ordered categorical axis (K = 1, 2, 3 …). Stacking makes the point the chart
 * exists to make — that the total has a genuine interior minimum — visible as
 * a shape rather than something you have to read off numbers.
 *
 * Two series only, so the pair is all-pairs validated. Legend is always
 * present; the optimal K is direct-labelled; grid and axes are recessive;
 * every bar has a hover tooltip.
 */

import { useState } from 'react';
import type { KSweepPoint } from '@/lib/engine';
import { CHART, INK } from '@/lib/palette';

interface Props {
  points: KSweepPoint[];
  optimalK: number;
  currentK: number;
  onPick: (k: number) => void;
}

const W = 340, H = 186;
const PAD = { t: 26, r: 10, b: 30, l: 46 };

const inr = (n: number) =>
  n >= 1000 ? `₹${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `₹${Math.round(n)}`;
const inrFull = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

export default function KSweepChart({ points, optimalK, currentK, onPick }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  if (points.length === 0) return null;

  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;
  const max = Math.max(...points.map((p) => p.total)) * 1.08;
  const slot = plotW / points.length;
  const barW = Math.min(slot * 0.62, 26);

  const y = (v: number) => PAD.t + plotH - (v / max) * plotH;
  const xMid = (i: number) => PAD.l + slot * i + slot / 2;

  const ticks = [0, max / 2, max];
  const hoveredPoint = hover !== null ? points[hover] : null;

  return (
    <div style={{ position: 'relative', maxWidth: 400 }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label={`Total daily cost by number of warehouses. Minimum at K equals ${optimalK}.`}
        style={{ display: 'block', overflow: 'visible' }}
      >
        {/* recessive gridlines */}
        {ticks.map((t, i) => (
          <g key={i}>
            <line
              x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)}
              stroke={i === 0 ? INK.baseline : INK.grid} strokeWidth={1}
            />
            <text
              x={PAD.l - 7} y={y(t) + 3.5} textAnchor="end"
              fontSize={9} fill={INK.muted}
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {inr(t)}
            </text>
          </g>
        ))}

        {points.map((p, i) => {
          const isOpt = p.k === optimalK;
          const isCur = p.k === currentK;
          const isHov = hover === i;
          const x = xMid(i) - barW / 2;
          const yDel = y(p.delivery);
          const hDel = PAD.t + plotH - yDel;
          const yTot = y(p.total);
          // 2px surface gap between stacked segments
          const hInf = Math.max(yDel - yTot - 2, 1);

          return (
            <g
              key={p.k}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              onClick={() => onPick(p.k)}
              style={{ cursor: 'pointer' }}
            >
              {/* generous hit target */}
              <rect x={PAD.l + slot * i} y={PAD.t} width={slot} height={plotH} fill="transparent" />

              {/* infrastructure (top) — 4px rounded data-end */}
              <path
                d={`M${x},${yTot + hInf} L${x},${yTot + 4} Q${x},${yTot} ${x + 4},${yTot}
                    L${x + barW - 4},${yTot} Q${x + barW},${yTot} ${x + barW},${yTot + 4}
                    L${x + barW},${yTot + hInf} Z`}
                fill={CHART.infrastructure}
                opacity={isHov || isOpt ? 1 : 0.82}
              />
              {/* delivery (anchored to the baseline, square bottom) */}
              <rect
                x={x} y={yDel} width={barW} height={Math.max(hDel, 0)}
                fill={CHART.delivery}
                opacity={isHov || isOpt ? 1 : 0.82}
              />

              {/* selection ring on the K currently being viewed */}
              {isCur && (
                <rect
                  x={x - 3} y={yTot - 3} width={barW + 6} height={hDel + hInf + 8}
                  fill="none" stroke={CHART.accent} strokeWidth={1.5} rx={5}
                />
              )}

              {/* direct label on the optimum only — never a number on every bar */}
              {isOpt && (
                <text
                  x={xMid(i)} y={yTot - 8} textAnchor="middle"
                  fontSize={9.5} fontWeight={700} fill={CHART.accent}
                >
                  ★ {inr(p.total)}
                </text>
              )}

              <text
                x={xMid(i)} y={H - PAD.b + 13} textAnchor="middle"
                fontSize={10} fontWeight={isOpt ? 700 : 500}
                fill={isOpt ? CHART.accent : INK.muted}
                style={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {p.k}
              </text>
            </g>
          );
        })}

        <text
          x={PAD.l + plotW / 2} y={H - 2} textAnchor="middle"
          fontSize={9.5} fill={INK.muted}
        >
          number of warehouses (K)
        </text>
      </svg>

      {/* legend — always present for 2+ series */}
      <div style={{ display: 'flex', gap: 14, marginTop: 4, fontSize: 11, color: INK.secondary }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <i style={{ width: 9, height: 9, borderRadius: 2, background: CHART.delivery, display: 'block' }} />
          Delivery
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <i style={{ width: 9, height: 9, borderRadius: 2, background: CHART.infrastructure, display: 'block' }} />
          Facilities
        </span>
      </div>

      {hoveredPoint && (
        <div
          className="chart-tip"
          style={{
            left: `${((xMid(hover!) / W) * 100).toFixed(1)}%`,
            top: 0,
            transform: hover! > points.length / 2 ? 'translate(-105%, 0)' : 'translate(8px, 0)',
          }}
        >
          <div className="t">
            {hoveredPoint.k} warehouse{hoveredPoint.k > 1 ? 's' : ''}
            {hoveredPoint.k === optimalK ? ' · optimal' : ''}
          </div>
          <div className="r">
            <i style={{ background: CHART.delivery }} />Delivery
            <span>{inrFull(hoveredPoint.delivery)}</span>
          </div>
          <div className="r">
            <i style={{ background: CHART.infrastructure }} />Facilities
            <span>{inrFull(hoveredPoint.infrastructure)}</span>
          </div>
          <div className="r" style={{ borderTop: '1px solid rgba(255,255,255,.1)', marginTop: 4, paddingTop: 4 }}>
            <i style={{ background: 'transparent' }} />Total
            <span>{inrFull(hoveredPoint.total)}/day</span>
          </div>
        </div>
      )}
    </div>
  );
}
