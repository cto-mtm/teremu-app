import { describe, expect, it } from 'vitest'
import { previewBase } from './money'

describe('previewBase', () => {
  it('converts a printed amount to base at "document units per one base unit", 2 dp', () => {
    expect(previewBase(100, 0.92)).toBe(108.7)
    expect(previewBase(3650, 36.5)).toBe(100)
  })

  it('refuses a missing, zero, negative or non-finite rate', () => {
    expect(previewBase(100, 0)).toBeNull()
    expect(previewBase(100, -1)).toBeNull()
    expect(previewBase(100, Number.NaN)).toBeNull()
    expect(previewBase(100, Number.POSITIVE_INFINITY)).toBeNull()
  })
})
