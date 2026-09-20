'use client';

import { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { Map as MLMap, Marker } from 'maplibre-gl';
import { LngLatBounds } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Neighborhood, Result } from '@/lib/types';
import { SERIES } from '@/lib/palette';

/**
 * Basemap sources — both completely keyless, so the app has no API tokens
 * anywhere and cannot break because a quota ran out mid-demo.
 *
 * Primary: OpenFreeMap vector tiles (free, no key, no rate limit).
 * Fallback: OpenStreetMap raster, darkened in CSS, used automatically if the
 * vector style fails to load. Verified live in the browser, not assumed.
 */
const VECTOR_STYLE = 'https://tiles.openfreemap.org/styles/positron';

/**
 * The map STARTS on this style: no network at all, just a background colour.
 *
 * This matters more than it looks. MapLibre only fires `load` once its style
 * resolves, and our data layers are added on `load` — so if a tile server is
 * slow or unreachable, a network-dependent initial style means the judges see
 * an entirely empty rectangle: no neighborhoods, no warehouses, no lines.
 *
 * Booting blank guarantees the DATA renders instantly and unconditionally.
 * The basemap is then layered in underneath as an upgrade if it arrives, and
 * its absence costs us a pretty backdrop rather than the whole visualisation.
 */
const BLANK_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0f0f16' } }],
};

const RASTER_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};

/** Fetch with a hard timeout, so a hanging network cannot hang the map. */
async function probe(url: string, ms = 3500): Promise<Response | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return res.ok ? res : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Slide a real basemap in underneath the data — but only after PROVING the
 * source actually responds.
 *
 * This ordering is the whole point. Adding a tile source whose requests fail
 * leaves MapLibre permanently in "style not loaded", and in that state it
 * paints nothing at all — not the basemap, and not our data either. Verified:
 * with tiles unreachable, a blindly-added raster source dropped
 * queryRenderedFeatures() to 0 and the map went completely black.
 *
 * So we probe first and only graft what answers. Worst case the backdrop stays
 * plain and every neighborhood, line and warehouse still renders.
 */
async function upgradeBasemap(m: MLMap): Promise<'vector' | 'raster' | 'none'> {
  const insertBeforeData = (layer: maplibregl.LayerSpecification) => {
    m.addLayer(layer, m.getLayer('lines') ? 'lines' : undefined);
  };

  // --- vector (preferred): the style JSON doubles as the reachability probe.
  const styleRes = await probe(VECTOR_STYLE);
  if (styleRes) {
    try {
      const style = (await styleRes.json()) as maplibregl.StyleSpecification;
      for (const [id, src] of Object.entries(style.sources ?? {})) {
        if (!m.getSource(id)) m.addSource(id, src);
      }
      for (const layer of style.layers ?? []) {
        if (layer.type === 'background') continue;
        if (m.getLayer(layer.id)) continue;
        // Positron is a LIGHT style. Rather than ship a second stylesheet, we
        // knock every layer back to a low opacity so it reads as a faint grey
        // substrate on the dark plane — present enough to orient you, quiet
        // enough that the data is unambiguously the subject.
        const l = { ...layer } as Record<string, unknown>;
        const paint = { ...((layer as { paint?: Record<string, unknown> }).paint ?? {}) };
        if (layer.type === 'fill')   { paint['fill-opacity'] = 0.07; }
        if (layer.type === 'line')   { paint['line-opacity'] = 0.13; }
        if (layer.type === 'symbol') { paint['text-opacity'] = 0.30; paint['icon-opacity'] = 0.18; }
        l.paint = paint;
        insertBeforeData(l as maplibregl.LayerSpecification);
      }
      return 'vector';
    } catch { /* fall through */ }
  }

  // --- raster fallback: probe one real tile before trusting the source.
  const tileRes = await probe('https://tile.openstreetmap.org/10/730/438.png');
  if (tileRes) {
    try {
      if (!m.getSource('osm')) {
        m.addSource('osm', RASTER_STYLE.sources.osm as maplibregl.SourceSpecification);
      }
      if (!m.getLayer('osm')) {
        insertBeforeData({
          id: 'osm', type: 'raster', source: 'osm',
          paint: { 'raster-opacity': 0.18, 'raster-saturation': -1, 'raster-brightness-max': 0.55 },
        });
      }
      return 'raster';
    } catch { /* fall through */ }
  }

  // --- neither reachable: keep the blank backdrop. The data still renders.
  return 'none';
}

export type MapMode = 'before' | 'after';

interface Props {
  neighborhoods: Neighborhood[];
  result: Result | null;
  mode: MapMode;
  focusedWarehouse: string | null;
}

export default function MapView({ neighborhoods, result, mode, focusedWarehouse }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const markers = useRef<Marker[]>([]);
  const [ready, setReady] = useState(false);
  const fitted = useRef('');
  const lastMode = useRef<MapMode>('before');

  // ---- create the map once ----
  useEffect(() => {
    if (!container.current || map.current) return;

    const m = new maplibregl.Map({
      container: container.current,
      style: BLANK_STYLE,
      center: [77.62, 12.95],
      zoom: 10.2,
      attributionControl: { compact: true },
    });
    map.current = m;
    // Debug handle — lets us inspect layers/sources from the console or an
    // automated browser check without wiring a bespoke bridge each time.
    if (typeof window !== 'undefined') {
      (window as unknown as { __gpmap?: MLMap }).__gpmap = m;
    }

    // Data layers go on as soon as the (instant, offline) blank style is up.
    m.on('load', () => {
      setReady(true);
      void upgradeBasemap(m);
    });

    // MapLibre measures its container once at construction. In a flex/grid
    // layout that can happen before the final height is resolved, leaving a
    // canvas that is the wrong size for the rest of the session (observed:
    // 898x300 inside an 898x894 box, which hid every marker). Watch the box
    // and tell the map whenever it actually changes.
    const ro = new ResizeObserver(() => m.resize());
    ro.observe(container.current);

    return () => { ro.disconnect(); m.remove(); map.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- draw everything ----
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;

    const maxOrders = Math.max(...neighborhoods.map((n) => n.orders), 1);
    const showResult = mode === 'after' && result && result.warehouses.length > 0;

    const colourOf = (wid: string) => {
      const i = result?.warehouses.findIndex((w) => w.id === wid) ?? -1;
      return i >= 0 ? SERIES[i % SERIES.length] : '#7d7d8d';
    };

    // --- assignment / baseline lines ---
    const lines = {
      type: 'FeatureCollection' as const,
      features: neighborhoods.flatMap((n) => {
        let target: { lat: number; lon: number } | undefined;
        let colour = '#7d7d8d';
        let dim = false;

        if (showResult) {
          const wid = result!.assignments[n.id];
          target = result!.warehouses.find((w) => w.id === wid);
          colour = colourOf(wid);
          dim = !!focusedWarehouse && focusedWarehouse !== wid;
        } else if (result?.baseline_warehouse) {
          target = result.baseline_warehouse;
        }
        if (!target) return [];

        return [{
          type: 'Feature' as const,
          properties: { colour, opacity: dim ? 0.05 : 0.30, width: 1 },
          geometry: {
            type: 'LineString' as const,
            coordinates: [[n.lon, n.lat], [target.lon, target.lat]],
          },
        }];
      }),
    };

    // --- neighborhood circles ---
    const points = {
      type: 'FeatureCollection' as const,
      features: neighborhoods.map((n) => {
        const wid = showResult ? result!.assignments[n.id] : '';
        const dim = showResult && !!focusedWarehouse && focusedWarehouse !== wid;
        const out = result?.out_of_radius?.includes(n.id) && showResult;
        return {
          type: 'Feature' as const,
          properties: {
            id: n.id,
            orders: n.orders,
            // Tint, don't saturate. The fill is a wash of the warehouse colour
            // so the grouping is legible at a glance; the ring carries the
            // actual hue. Before a run everything is plain neutral.
            colour: showResult ? colourOf(wid) : '#8a8a96',
            radius: 5 + 13 * Math.sqrt(n.orders / maxOrders),
            opacity: dim ? 0.06 : showResult ? 0.20 : 0.16,
            stroke: out ? '#fab219' : showResult ? colourOf(wid) : '#9a9aa6',
            strokeW: out ? 1.6 : 1.1,
            strokeOpacity: dim ? 0.15 : out ? 0.95 : 0.75,
          },
          geometry: { type: 'Point' as const, coordinates: [n.lon, n.lat] },
        };
      }),
    };

    const setData = (id: string, data: GeoJSON.FeatureCollection) => {
      const src = m.getSource(id) as maplibregl.GeoJSONSource | undefined;
      if (src) src.setData(data);
    };

    if (!m.getSource('lines')) {
      m.addSource('lines', { type: 'geojson', data: lines });
      m.addLayer({
        id: 'lines', type: 'line', source: 'lines',
        layout: { 'line-cap': 'round' },
        paint: {
          'line-color': ['get', 'colour'],
          'line-width': ['get', 'width'],
          'line-opacity': ['get', 'opacity'],
        },
      });
      m.addSource('points', { type: 'geojson', data: points });
      m.addLayer({
        id: 'points', type: 'circle', source: 'points',
        paint: {
          'circle-radius': ['get', 'radius'],
          'circle-color': ['get', 'colour'],
          'circle-opacity': ['get', 'opacity'],
          'circle-stroke-color': ['get', 'stroke'],
          'circle-stroke-width': ['get', 'strokeW'],
          'circle-stroke-opacity': ['get', 'strokeOpacity'],
        },
      });

      const popup = new maplibregl.Popup({ closeButton: false, offset: 12, className: 'gp-pop' });
      m.on('mouseenter', 'points', (e) => {
        m.getCanvas().style.cursor = 'pointer';
        const f = e.features?.[0];
        if (!f) return;
        const p = f.properties as { id: string; orders: number };
        const d = result?.distances_km?.[p.id];
        popup
          .setLngLat((f.geometry as GeoJSON.Point).coordinates as [number, number])
          .setHTML(
            `<strong>${p.id}</strong><br/>${Number(p.orders).toLocaleString('en-IN')} orders/day` +
            (d !== undefined && showResult ? `<br/>${d.toFixed(2)} km to depot` : ''),
          )
          .addTo(m);
      });
      m.on('mouseleave', 'points', () => { m.getCanvas().style.cursor = ''; popup.remove(); });
    } else {
      setData('lines', lines);
      setData('points', points);
    }

    // --- warehouse markers (HTML, so each carries a visible label:
    //     identity never rests on colour alone) ---
    markers.current.forEach((mk) => mk.remove());
    markers.current = [];

    // Markers pulse once when the optimised network first appears, so the eye
    // is led to the answer. Styled from globals.css (.gp-marker) so the map
    // chrome and the panels share one design system.
    const justRevealed = !!showResult && lastMode.current !== 'after';
    lastMode.current = showResult ? 'after' : 'before';

    const addMarker = (
      lat: number, lon: number, label: string, load: string | null, colour: string,
      baseline: boolean, dim: boolean, pulse: boolean,
    ) => {
      const el = document.createElement('div');
      el.className = `gp-marker${baseline ? ' baseline' : ''}${dim ? ' dim' : ''}${pulse ? ' pulse' : ''}`;
      el.style.setProperty('--mk', baseline ? 'rgba(255,255,255,.28)' : colour);
      if (!baseline) {
        const sq = document.createElement('span');
        sq.className = 'sq';
        el.appendChild(sq);
      }
      el.appendChild(document.createTextNode(label));
      if (load) {
        const ld = document.createElement('span');
        ld.className = 'load';
        ld.textContent = `· ${load}`;
        el.appendChild(ld);
      }
      markers.current.push(new maplibregl.Marker({ element: el }).setLngLat([lon, lat]).addTo(m));
    };

    if (showResult) {
      result!.warehouses.forEach((w, i) => {
        const load = result!.load?.[w.id];
        addMarker(
          w.lat, w.lon, w.id,
          load ? load.toLocaleString('en-IN') : null,
          SERIES[i % SERIES.length], false,
          !!focusedWarehouse && focusedWarehouse !== w.id,
          justRevealed,
        );
      });
    } else if (result?.baseline_warehouse) {
      addMarker(
        result.baseline_warehouse.lat, result.baseline_warehouse.lon,
        'Baseline depot', null, '#7d7d8d', true, false, false,
      );
    }

    // --- fit bounds, but only when the dataset itself changes ---
    //
    // The panels FLOAT over the map, so the canvas is wider than the part of it
    // the user can actually see. Fitting to the full canvas pushes points
    // underneath the panels — invisible, and worse, silently: the default
    // sample happens to sit mid-canvas so it looks correct. Pad by the real
    // occluded widths instead. Below 1240px the panels stack (see globals.css),
    // so the whole canvas is visible and the padding goes back to symmetric.
    const key = neighborhoods.map((n) => `${n.lat},${n.lon}`).join('|');
    if (key && key !== fitted.current) {
      fitted.current = key;
      const b = new LngLatBounds();
      neighborhoods.forEach((n) => b.extend([n.lon, n.lat]));
      const floating = typeof window !== 'undefined' && window.innerWidth > 1240;
      // left panel 300 + gutter, right panel 360 + gutter, header 46 + gutter,
      // then a little breathing room so markers are not flush against a panel.
      const padding = floating
        ? { left: 340, right: 400, top: 110, bottom: 70 }
        : 60;
      // A marker label is ~110px wide and hangs off its point, so cap the zoom
      // low enough that two nearby depots do not overlap into mush.
      if (!b.isEmpty()) m.fitBounds(b, { padding, duration: 700, maxZoom: 13 });
    }
  }, [neighborhoods, result, mode, ready, focusedWarehouse]);

  return (
    <div className="map-wrap">
      <div ref={container} style={{ position: 'absolute', inset: 0 }} />
      {!ready && (
        <div className="map-empty">
          <div>
            <div className="spin" style={{ margin: '0 auto 10px' }} />
            Loading basemap…
          </div>
        </div>
      )}
    </div>
  );
}
