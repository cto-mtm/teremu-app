import { describe, expect, it } from 'vitest'
import { compatibleUnits, IMPERIAL_UNITS, METRIC_UNITS, unitsForSystem } from './units'

describe('compatibleUnits', () => {
  it('offers every unit of the same dimension for a recipe line', () => {
    expect(compatibleUnits('kg').sort()).toEqual(['g', 'kg', 'lb', 'oz'])
    expect(compatibleUnits('each').sort()).toEqual(['dozen', 'each'])
  })

  it('offers containers only themselves (vendor-specific sizes)', () => {
    expect(compatibleUnits('case')).toEqual(['case'])
  })
})

describe('unitsForSystem', () => {
  it('picks the metric or imperial dropdown, both keeping the neutral counts', () => {
    expect(unitsForSystem('metric')).toBe(METRIC_UNITS)
    expect(unitsForSystem('imperial')).toBe(IMPERIAL_UNITS)
    for (const list of [METRIC_UNITS, IMPERIAL_UNITS]) expect(list).toContain('each')
    expect(METRIC_UNITS).not.toContain('lb')
  })
})
