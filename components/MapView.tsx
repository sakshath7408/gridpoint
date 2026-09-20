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
 * Turning a LIGHT basemap into a real dark one.
 *
 * Positron is a light style. The obvious move — drop every layer to a low
 * opacity over a dark plane — does not work: it washes parks, water, landuse
 * and roads into nearly the same muddy grey, because opacity compresses all of
 * them toward the backdrop at once. It reads as a smudge, not a map.
 *
 * So for dark we RECOLOUR rather than dim. Each layer gets an explicit colour
 * from a dark ramp, keyed off the layer id (these are the real OpenMapTiles /
 * Positron ids, read from the running map rather than guessed). Roads stay
 * legible because they are genuinely lighter than the land, water reads as
 * water because it is blue-dark rather than grey-dark, and labels get a dark
 * halo — without one, light text on a dark map smears into the lines under it.
 *
 * Light mode keeps Positron's own colours and only softens them, which is what
 * the style was designed for.
 */
const DARK = {
  land:        '#0e0e14',
  water:       '#101c2e',   // clearly blue-dark, so water reads as water
  waterway:    '#16293f',
  park:        '#0f1913',
  wood:        '#0d160f',
  ice:         '#12151c',
  // Landuse sits within a hair of the land colour on purpose. At city zoom the
  // residential polygons are what turn a dark map into visual noise, and they
  // tell you nothing a warehouse siting tool needs.
  residential: '#0f0f15',
  building:    '#1c1c25',
  aeroway:     '#14141b',

  // Roads ARE the dark map. They have to be decisively lighter than the land,
  // not a suggestion of a line.
  motorway:    '#7d7d8e',
  motorwayCase:'#22222b',
  major:       '#5f5f6f',
  majorCase:   '#1e1e26',
  minor:       '#43434f',
  path:        '#2e2e38',
  subtle:      '#3a3a45',
  rail:        '#353541',
  boundary:    '#454552',

  // Labels are near-white and set in Bold, with a tight dark halo. Grey text at
  // partial opacity is the single thing that made the old dark map unreadable.
  label:       '#f2f2f7',
  labelMinor:  '#c4c4d0',
  halo:        '#06060a',
} as const;

/**
 * Bold face for dark-mode labels.
 *
 * Verified against the live style before adopting: the Positron style already
 * declares "Noto Sans Bold" for some layers and the glyph endpoint returns 200
 * for that stack, so requesting it cannot leave us with missing text. The
 * original stack is kept as a fallback regardless.
 */
const BOLD_FONT = ['Noto Sans Bold', 'Noto Sans Regular'];

/** Explicit dark colour for a Positron layer, by id. */
function darkFill(id: string): string {
  if (id === 'water') return DARK.water;
  if (id === 'park') return DARK.park;
  if (id.includes('wood') || id.includes('grass')) return DARK.wood;
  if (id.includes('ice_shelf') || id.includes('glacier')) return DARK.ice;
  if (id.includes('residential') || id.startsWith('landuse')) return DARK.residential;
  if (id === 'building') return DARK.building;
  if (id.includes('aeroway') || id.includes('pier')) return DARK.aeroway;
  return DARK.residential;
}

function darkLine(id: string): string {
  if (id === 'waterway') return DARK.waterway;
  if (id.includes('motorway')) return id.includes('casing') ? DARK.motorwayCase : DARK.motorway;
  if (id.includes('major')) {
    if (id.includes('casing')) return DARK.majorCase;
    if (id.includes('subtle')) return DARK.subtle;
    return DARK.major;
  }
  if (id.includes('minor')) return DARK.minor;
  if (id.includes('path')) return DARK.path;
  if (id.includes('railway')) return DARK.rail;
  if (id.includes('boundary')) return DARK.boundary;
  if (id.includes('aeroway') || id.includes('pier')) return DARK.aeroway;
  return DARK.minor;
}

/** Settlement names carry the map; road names and shields recede. */
function darkLabel(id: string): string {
  if (id.startsWith('label_')) return DARK.label;
  return DARK.labelMinor;
}

/**
 * Restyle one basemap layer for the given theme.
 * Returns a NEW layer object — never mutates the fetched style, which is
 * cached and re-used every time the theme changes.
 */
function styleForTheme(layer: maplibregl.LayerSpecification, theme: Theme): maplibregl.LayerSpecification {
  const l = { ...layer } as Record<string, unknown>;
  const paint = { ...((layer as { paint?: Record<string, unknown> }).paint ?? {}) };
  const layout = { ...((layer as { layout?: Record<string, unknown> }).layout ?? {}) };
  const id = layer.id;

  if (theme === 'dark') {
    if (layer.type === 'fill') {
      paint['fill-color'] = darkFill(id);
      // Buildings give texture close in; everything else is flat and quiet.
      paint['fill-opacity'] = id === 'building' ? 0.45 : 1;
      delete paint['fill-outline-color'];
    }
    if (layer.type === 'line') {
      paint['line-color'] = darkLine(id);
      paint['line-opacity'] = 1;          // no translucent roads
    }
    if (layer.type === 'symbol') {
      paint['text-color'] = darkLabel(id);
      paint['text-opacity'] = 1;          // no translucent labels
      paint['text-halo-color'] = DARK.halo;
      paint['text-halo-width'] = 1.8;
      paint['text-halo-blur'] = 0.2;
      layout['text-font'] = BOLD_FONT;
      // Road shields are bitmaps drawn for a light background; they read as
      // stickers on a dark one and cannot be restyled, so they go.
      paint['icon-opacity'] = id.includes('shield') ? 0 : 0.55;
    }
  } else {
    // Positron's own colours, just quieter so the data stays the subject.
    if (layer.type === 'fill')   paint['fill-opacity'] = 0.72;
    if (layer.type === 'line')   paint['line-opacity'] = 0.55;
    if (layer.type === 'symbol') { paint['text-opacity'] = 0.62; paint['icon-opacity'] = 0.4; }
  }

  l.paint = paint;
  if (Object.keys(layout).length) l.layout = layout;
  return l as maplibregl.LayerSpecification;
}

/** Raster fallback tuning, per theme. */
const RASTER_PAINT = {
  light: { 'raster-opacity': 0.5,  'raster-saturation': -1, 'raster-brightness-min': 0.35 },
  dark:  { 'raster-opacity': 0.22, 'raster-saturation': -1, 'raster-brightness-max': 0.5 },
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
/** The fetched style, kept so a theme switch can re-graft without re-fetching. */
interface BasemapCache { style: maplibregl.StyleSpecification | null; kind: 'vector' | 'raster' | 'none'; }

/** Remove every layer we previously grafted, leaving our data layers alone. */
function ungraft(m: MLMap, grafted: string[]) {
  for (const id of grafted) { if (m.getLayer(id)) m.removeLayer(id); }
  grafted.length = 0;
}

/** Add the cached basemap, styled for `theme`, underneath our data layers. */
function graft(m: MLMap, cache: BasemapCache, theme: Theme, grafted: string[]) {
  const before = m.getLayer('lines') ? 'lines' : undefined;

  if (cache.kind === 'vector' && cache.style) {
    for (const [id, src] of Object.entries(cache.style.sources ?? {})) {
      if (!m.getSource(id)) m.addSource(id, src);
    }
    for (const layer of cache.style.layers ?? []) {
      if (layer.type === 'background') continue;
      if (m.getLayer(layer.id)) continue;
      m.addLayer(styleForTheme(layer, theme), before);
      grafted.push(layer.id);
    }
    return;
  }

  if (cache.kind === 'raster') {
    if (!m.getSource('osm')) {
      m.addSource('osm', RASTER_STYLE.sources.osm as maplibregl.SourceSpecification);
    }
    if (!m.getLayer('osm')) {
      m.addLayer({ id: 'osm', type: 'raster', source: 'osm', paint: { ...RASTER_PAINT[theme] } }, before);
      grafted.push('osm');
    }
  }
}

async function upgradeBasemap(
  m: MLMap, theme: Theme, grafted: string[], cache: BasemapCache,
): Promise<'vector' | 'raster' | 'none'> {
  // --- vector (preferred): the style JSON doubles as the reachability probe.
  const styleRes = await probe(VECTOR_STYLE);
  if (styleRes) {
    try {
      cache.style = (await styleRes.json()) as maplibregl.StyleSpecification;
      cache.kind = 'vector';
      graft(m, cache, theme, grafted);
      return 'vector';
    } catch { /* fall through */ }
  }

  // --- raster fallback: probe one real tile before trusting the source.
  const tileRes = await probe('https://tile.openstreetmap.org/10/730/438.png');
  if (tileRes) {
    try {
      cache.kind = 'raster';
      graft(m, cache, theme, grafted);
      return 'raster';
    } catch { /* fall through */ }
  }

  // --- neither reachable: keep the blank backdrop. The data still renders.
  cache.kind = 'none';
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
  const basemap = useRef<BasemapCache>({ style: null, kind: 'none' });
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
      void upgradeBasemap(m, themeRef.current, grafted.current, basemap.current);
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

  // ---- restyle the basemap when the theme changes ----
  // Dark is a full recolour, not a dimming, so there is no single paint
  // property to flip. We drop the grafted layers and re-add them from the
  // CACHED style JSON — no refetch, no flicker, and our data layers are never
  // touched because they are not in `grafted`.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    try {
      if (m.getLayer('bg')) m.setPaintProperty('bg', 'background-color', MAP_NEUTRAL[theme].bg);
      if (basemap.current.kind === 'none') return;
      ungraft(m, grafted.current);
      graft(m, basemap.current, theme, grafted.current);
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
