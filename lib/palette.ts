/**
 * Validated categorical palettes for BOTH themes.
 *
 * Dark is the default. Light is the same eight hues re-stepped for a light
 * surface — not a different palette, and not an automatic flip of the dark one.
 * Each set was run through the data-viz validator against its own surface:
 *
 *   DARK  (surface #0e0e11)
 *     lightness band PASS · chroma floor PASS
 *     CVD separation PASS  (worst adjacent ΔE 8.4, protan)
 *     normal-vision   PASS (worst adjacent ΔE 19.3)
 *     contrast        PASS (all eight ≥ 3:1)
 *
 *   LIGHT (surface #f4f3ee)
 *     lightness band PASS · chroma floor PASS
 *     CVD separation PASS  (worst adjacent ΔE 9.1, protan)
 *     normal-vision   PASS (worst adjacent ΔE 19.6)
 *     contrast        WARN — orange, aqua, yellow and magenta fall under 3:1
 *
 * The light-mode contrast warning is the validator's "relief required" case,
 * and it is relieved: every warehouse marker carries a visible text label, the
 * legend names every warehouse, and the Areas table lists every assignment.
 * Identity never rests on colour alone in either theme. If a redesign removes
 * the marker labels, the light palette is no longer defensible.
 *
 * Slot ORDER is the colour-blind-safety mechanism, not decoration. Candidate
 * orderings were enumerated and only those clearing every adjacent gate kept.
 * Do not shuffle, and never cycle past slot 8 — fold into "other" instead.
 */

export const SERIES_DARK = [
  '#3987e5', // 1 blue
  '#d95926', // 2 orange
  '#199e70', // 3 aqua
  '#c98500', // 4 yellow
  '#d55181', // 5 magenta
  '#008300', // 6 green
  '#9085e9', // 7 violet
  '#e66767', // 8 red
] as const;

export const SERIES_LIGHT = [
  '#2a78d6', // 1 blue
  '#eb6834', // 2 orange
  '#1baf7a', // 3 aqua
  '#eda100', // 4 yellow
  '#e87ba4', // 5 magenta
  '#008300', // 6 green
  '#4a3aa7', // 7 violet
  '#e34948', // 8 red
] as const;

/**
 * Chart roles for the trade-off chart (two stacked series).
 *
 * Deliberately NOT drawn from the categorical slots: on one screen, "blue"
 * must mean warehouse W1 and nothing else. The part the optimiser can move
 * (delivery) is the foreground tone; the part it cannot (rent) is a neutral.
 * The pair separates by lightness — ΔE 38 dark, ΔE 58 light — so it survives
 * every colour-vision deficiency, and the legend is always drawn on top of
 * that. The lightness/chroma checks do not apply: this is a two-tone
 * foreground/background pair, not a categorical palette.
 */
export const CHART_DARK = {
  delivery: '#c9c6ff',
  infrastructure: '#5a5a68',
  baseline: '#8a8a92',
  accent: '#c9c6ff',
} as const;

export const CHART_LIGHT = {
  delivery: '#26262d',
  infrastructure: '#d3d0c6',
  baseline: '#8a8a92',
  accent: '#16161a',
} as const;

/** Reserved status colours — never reused as a series. */
export const STATUS_DARK = {
  good: '#4ade80', warning: '#fab219', serious: '#f08a5d', critical: '#f87171',
} as const;
export const STATUS_LIGHT = {
  good: '#1f7a3a', warning: '#9a5b00', serious: '#b5451b', critical: '#c0392b',
} as const;

/** Text and structure tokens for chart internals. */
export const INK_DARK = {
  primary: '#f2f2f5', secondary: '#b9b9c6', muted: '#8a8a94',
  grid: '#2a2a31', baseline: '#3a3a43',
} as const;
export const INK_LIGHT = {
  primary: '#16161a', secondary: '#4a4a53', muted: '#78787f',
  grid: '#e7e5de', baseline: '#cfcdc5',
} as const;

export type Theme = 'dark' | 'light';

export const seriesFor = (t: Theme) => (t === 'light' ? SERIES_LIGHT : SERIES_DARK);
export const chartFor  = (t: Theme) => (t === 'light' ? CHART_LIGHT  : CHART_DARK);
export const inkFor    = (t: Theme) => (t === 'light' ? INK_LIGHT    : INK_DARK);
export const statusFor = (t: Theme) => (t === 'light' ? STATUS_LIGHT : STATUS_DARK);

/** Map-only neutrals: unassigned areas and the baseline depot, per theme. */
export const MAP_NEUTRAL = {
  dark:  { fill: '#8a8a96', stroke: '#9a9aa6', baseline: '#7d7d8d', bg: '#0f0f16', warn: '#fab219' },
  light: { fill: '#6f6f78', stroke: '#6f6f78', baseline: '#8a8a92', bg: '#f0efe9', warn: '#9a5b00' },
} as const;

/* ---- back-compat aliases: default theme is dark ---- */
export const SERIES = SERIES_DARK;
export const CHART = CHART_DARK;
export const INK = INK_DARK;
export const STATUS = STATUS_DARK;
