/**
 * The app's ONE place for money arithmetic across currencies
 * (docs/multi-currency.md). Everything the app aggregates is already in
 * the restaurant's base currency — the server converts once at approval
 * and ships base as the canonical amounts — so the only arithmetic left
 * on the client is a Triage PREVIEW of what a printed figure will become.
 * The server recomputes from the rate; nothing previewed here is stored.
 *
 * Rate convention (fx/types.ts on the API): document units per ONE base
 * unit, so base = printed / rate. Rounding mirrors fx/convert.ts (2 dp).
 *
 * Phase 2 adds the display-currency lens here (`useMoney()`), which is
 * why this module — and not a page — owns the rate math.
 */
export function previewBase(printed: number, rate: number): number | null {
  if (!(rate > 0) || !Number.isFinite(rate)) return null
  return +(printed / rate).toFixed(2)
}
