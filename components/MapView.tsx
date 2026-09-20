'use client';

import { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { Map as MLMap, Marker } from 'maplibre-gl';
import { LngLatBounds } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Neighborhood, Result } from '@/lib/types';
import { seriesFor, MAP_NEUTRAL, type Theme } from '@/lib/palette';

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
const blankStyle = (theme: Theme): maplibregl.StyleSpecification => ({
  version: 8,
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': MAP_NEUTRAL[theme].bg } }],
});

/**
 * How hard to knock the basemap back, per theme.
 *
 * Positron is a light style. On paper it can run near full strength; on the
 * dark plane the same layers must drop to a faint grey substrate or they glow.
 * Stored so the theme toggle can repaint grafted layers in place rather than
 * tearing the style down and rebuilding it.
 */
const BASEMAP_PAINT = {
  light: { fill: 0.72, line: 0.55, text: 0.62, icon: 0.4,  raster: 0.5  },
  dark:  { fill: 0.07, line: 0.13, text: 0.30, icon: 0.18, raster: 0.18 },
} as const;

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
async function upgradeBasemap(m: MLMap, theme: Theme, grafted: string[]): Promise<'vector' | 'raster' | 'none'> {
  const P = BASEMAP_PAINT[theme];
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
        // At full strength the basemap competes with the data. Soften every
        // layer so streets and labels read as context — present enough to
        // orient you, quiet enough that the circles and markers are
        // unambiguously the subject. How far to soften depends on the theme.
        const l = { ...layer } as Record<string, unknown>;
        const paint = { ...((layer as { paint?: Record<string, unknown> }).paint ?? {}) };
        if (layer.type === 'fill')   { paint['fill-opacity'] = P.fill; }
        if (layer.type === 'line')   { paint['line-opacity'] = P.line; }
        if (layer.type === 'symbol') { paint['text-opacity'] = P.text; paint['icon-opacity'] = P.icon; }
        l.paint = paint;
        insertBeforeData(l as maplibregl.LayerSpecification);
        grafted.push(layer.id);
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
          paint: theme === 'light'
            ? { 'raster-opacity': P.raster, 'raster-saturation': -1, 'raster-brightness-min': 0.35 }
            : { 'raster-opacity': P.raster, 'raster-saturation': -1, 'raster-brightness-max': 0.55 },
        });
        grafted.push('osm');
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
  theme: Theme;
}

export default function MapView({ neighborhoods, result, mode, focusedWarehouse, theme }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const markers = useRef<Marker[]>([]);
  const [ready, setReady] = useState(false);
  const fitted = useRef('');
  const lastMode = useRef<MapMode>('before');
  // Ids of the basemap layers we grafted, so a theme switch can repaint them
  // in place. Rebuilding the style instead would drop our data layers and
  // re-run the whole probe — a visible flicker on every toggle.
  const grafted = useRef<string[]>([]);
  // Read inside the map-creation effect, which must not re-run on theme change.
  const themeRef = useRef<Theme>(theme);
  themeRef.current = theme;

  // ---- create the map once ----
  useEffect(() => {
    if (!container.current || map.current) return;

    const m = new maplibregl.Map({
      container: container.current,
      style: blankStyle(themeRef.current),
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
      void upgradeBasemap(m, themeRef.current, grafted.current);
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

    const SERIES = seriesFor(theme);
    const NEUTRAL = MAP_NEUTRAL[theme];

    const colourOf = (wid: string) => {
      const i = result?.warehouses.findIndex((w) => w.id === wid) ?? -1;
      return i >= 0 ? SERIES[i % SERIES.length] : NEUTRAL.baseline;
    };

    // --- assignment / baseline lines ---
    const lines = {
      type: 'FeatureCollection' as const,
      features: neighborhoods.flatMap((n) => {
        let target: { lat: number; lon: number } | undefined;
        let colour: string = NEUTRAL.baseline;
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
          properties: { colour, opacity: dim ? 0.06 : 0.42, width: 1.2 },
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
            colour: showResult ? colourOf(wid) : NEUTRAL.fill,
            radius: 5 + 13 * Math.sqrt(n.orders / maxOrders),
            opacity: dim ? 0.06 : showResult ? 0.22 : 0.14,
            stroke: out ? NEUTRAL.warn : showResult ? colourOf(wid) : NEUTRAL.stroke,
            strokeW: out ? 1.6 : 1.1,
            strokeOpacity: dim ? 0.15 : out ? 1 : 0.9,
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
        'Baseline depot', null, NEUTRAL.baseline, true, false, false,
      );
    }

    // --- fit bounds, but only when the dataset itself changes ---
    //
    // The panels DOCK beside the map, so the whole canvas is visible and the
    // only things that can cover a data point are the two small overlays:
    // the stats strip top-left (~30px) and the legend bottom-left (~130px on
    // the "after" view). Pad for those, plus room for marker labels, which
    // hang ~110px to the right of their point.
    //
    // If a future layout floats panels over the map again, this padding must
    // grow to the occluded widths — and be verified with the occlusion check,
    // not by eye: the default sample sits mid-canvas and hides the bug.
    const key = neighborhoods.map((n) => `${n.lat},${n.lon}`).join('|');
    if (key && key !== fitted.current) {
      fitted.current = key;
      const b = new LngLatBounds();
      neighborhoods.forEach((n) => b.extend([n.lon, n.lat]));
      const padding = { top: 64, right: 130, bottom: 150, left: 64 };
      if (!b.isEmpty()) m.fitBounds(b, { padding, duration: 700, maxZoom: 13 });
    }
  }, [neighborhoods, result, mode, ready, focusedWarehouse, theme]);

  // ---- repaint the basemap when the theme changes ----
  // Data layers are redrawn by the effect above (theme is in its deps); the
  // grafted basemap layers are not React-owned, so they are repainted here.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const P = BASEMAP_PAINT[theme];
    try {
      if (m.getLayer('bg')) m.setPaintProperty('bg', 'background-color', MAP_NEUTRAL[theme].bg);
      for (const id of grafted.current) {
        const layer = m.getLayer(id);
        if (!layer) continue;
        if (layer.type === 'fill')   m.setPaintProperty(id, 'fill-opacity', P.fill);
        if (layer.type === 'line')   m.setPaintProperty(id, 'line-opacity', P.line);
        if (layer.type === 'symbol') {
          m.setPaintProperty(id, 'text-opacity', P.text);
          m.setPaintProperty(id, 'icon-opacity', P.icon);
        }
        if (layer.type === 'raster') {
          m.setPaintProperty(id, 'raster-opacity', P.raster);
          // brightness-max suits the dark plane, brightness-min the light one;
          // clear the other so a toggle does not leave both applied.
          if (theme === 'dark') {
            m.setPaintProperty(id, 'raster-brightness-min', 0);
            m.setPaintProperty(id, 'raster-brightness-max', 0.55);
          } else {
            m.setPaintProperty(id, 'raster-brightness-max', 1);
            m.setPaintProperty(id, 'raster-brightness-min', 0.35);
          }
        }
      }
    } catch { /* style mid-reload: the next draw picks it up */ }
  }, [theme, ready]);

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
