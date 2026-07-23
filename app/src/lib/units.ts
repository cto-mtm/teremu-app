import { UNITS, type Unit } from './types'

/**
 * Unit conversion + unit-system preference lists.
 * ⚠ Conversion factors are mirrored in firebase/functions/src/units.ts
 * (same sync rule as the schemas): mass and volume convert within their
 * dimension, each↔dozen converts, containers (case/box/bunch) are
 * vendor-specific sizes and only match themselves.
 */
const TO_BASE: Partial<Record<Unit, { dim: 'mass' | 'volume' | 'count'; factor: number }>> = {
  g: { dim: 'mass', factor: 1 },
  kg: { dim: 'mass', factor: 1000 },
  oz: { dim: 'mass', factor: 28.3495 },
  lb: { dim: 'mass', factor: 453.592 },
  ml: { dim: 'volume', factor: 1 },
  L: { dim: 'volume', factor: 1000 },
  floz: { dim: 'volume', factor: 29.5735 },
  pt: { dim: 'volume', factor: 473.176 },
  qt: { dim: 'volume', factor: 946.353 },
  gal: { dim: 'volume', factor: 3785.41 },
  each: { dim: 'count', factor: 1 },
  dozen: { dim: 'count', factor: 12 },
}

/** Convert qty between units, or null when dimensions don't match. */
export function convertQty(qty: number, from: Unit, to: Unit): number | null {
  if (from === to) return qty
  const f = TO_BASE[from]
  const t = TO_BASE[to]
  if (!f || !t || f.dim !== t.dim) return null
  return (qty * f.factor) / t.factor
}

/** Units a recipe line may use for an ingredient stocked in `unit`. */
export function compatibleUnits(unit: Unit): Unit[] {
  const dim = TO_BASE[unit]?.dim
  if (!dim) return [unit] // containers: only themselves
  return UNITS.filter((u) => TO_BASE[u]?.dim === dim)
}

export type UnitSystem = 'metric' | 'imperial'

const NEUTRAL: Unit[] = ['each', 'dozen', 'case', 'box', 'bunch']
export const METRIC_UNITS: Unit[] = ['kg', 'g', 'L', 'ml', ...NEUTRAL]
export const IMPERIAL_UNITS: Unit[] = ['lb', 'oz', 'gal', 'qt', 'pt', 'floz', ...NEUTRAL]

export function unitsForSystem(system: UnitSystem): Unit[] {
  return system === 'imperial' ? IMPERIAL_UNITS : METRIC_UNITS
}
