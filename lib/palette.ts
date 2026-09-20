/**
 * Validated categorical palette (dark mode, surface #15151d).
 *
 * Checked with the data-viz validator — all six checks PASS:
 *   lightness band · chroma floor · CVD separation (worst adjacent ΔE 8.4)
 *   normal-vision floor (worst adjacent ΔE 19.3) · contrast ≥ 3:1
 *
 * Slots are assigned in fixed order and never cycled through a generated hue.
 * On the map every warehouse also carries a text label, so identity never
 * depends on colour alone — which is what makes the 8-slot adjacent-pair
 * result safe to use for simultaneously visible markers.
 */
export const SERIES = [
  '#3987e5', // 1 blue
  '#d95926', // 2 orange
  '#199e70', // 3 aqua
  '#c98500', // 4 yellow
  '#d55181', // 5 magenta
  '#008300', // 6 green
  '#9085e9', // 7 violet
  '#e66767', // 8 red
] as const;

/**
 * Chart roles. The trade-off chart has two series, so it does not draw on the
 * categorical slots at all: the part the optimiser can move (delivery) takes
 * the product accent, and the part it cannot (rent) is a neutral. The pair is
 * separated by lightness (L* ≈ 68 vs 42) as well as hue, so it survives every
 * colour-vision deficiency, and the legend is always drawn.
 */
export const CHART = {
  delivery: '#a78bfa',
  infrastructure: '#5a5a68',
  baseline: '#7d7d8d',
  accent: '#a78bfa',
} as const;

export const STATUS = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
} as const;

export const INK = {
  primary: '#ffffff',
  secondary: '#b9b9c6',
  muted: '#898781',
  grid: '#2c2c2a',
  baseline: '#383835',
} as const;
