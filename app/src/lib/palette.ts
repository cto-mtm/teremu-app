// The one categorical chart palette (ember/herb/ink/smoke lead — the
// same brand hues main.css declares as tokens). Every hand-rolled SVG
// chart indexes into this list so a brand tweak is a one-file change.
export const CHART_COLORS = [
  '#ff751f', // ember
  '#2e9e5b', // herb
  '#1c1410', // ink
  '#7a6f66', // smoke
  '#dc3448', // coral
  '#f0b429',
  '#4f7cac',
  '#8b5cf6',
  '#0d9488',
  '#b45309',
] as const

/** Aggregated-tail / "others" slices and segments. */
export const CHART_REST_COLOR = '#d1d5db'
