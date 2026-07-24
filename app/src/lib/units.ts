import { UNITS, type Unit } from './types'

// The core conversion function lives in @teremu/shared (single source of truth).
export { convertQty } from '@teremu/shared'

/**
 * App-specific unit helpers: compatible-unit lists for recipe editors,
 * and the metric/imperial preference system for dropdowns.
 */

// Dimension lookup (needed by compatibleUnits below). Kept private — the
// actual conversion math uses convertQty from @teremu/shared.
const DIM: Partial<Record<Unit, 'mass' | 'volume' | 'count'>> = {
  g: 'mass', kg: 'mass', oz: 'mass', lb: 'mass',
  ml: 'volume', L: 'volume', floz: 'volume', pt: 'volume', qt: 'volume', gal: 'volume',
  each: 'count', dozen: 'count',
}

/** Units a recipe line may use for an ingredient stocked in `unit`. */
export function compatibleUnits(unit: Unit): Unit[] {
  const dim = DIM[unit]
  if (!dim) return [unit] // containers: only themselves
  return UNITS.filter((u) => DIM[u] === dim)
}

export type UnitSystem = 'metric' | 'imperial'

const NEUTRAL: Unit[] = ['each', 'dozen', 'case', 'box', 'bunch']
export const METRIC_UNITS: Unit[] = ['kg', 'g', 'L', 'ml', ...NEUTRAL]
export const IMPERIAL_UNITS: Unit[] = ['lb', 'oz', 'gal', 'qt', 'pt', 'floz', ...NEUTRAL]

export function unitsForSystem(system: UnitSystem): Unit[] {
  return system === 'imperial' ? IMPERIAL_UNITS : METRIC_UNITS
}
