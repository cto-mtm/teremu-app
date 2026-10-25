import { describe, expect, it } from 'vitest'
import { whatsappLink, whatsappNumber } from './phone'

describe('whatsappNumber (docs/us-market-readiness.md B5)', () => {
  it("prefixes a local number with the restaurant's country code", () => {
    expect(whatsappNumber('(312) 555-0199', '1')).toBe('13125550199')
    expect(whatsappNumber('612 345 678', '34')).toBe('34612345678')
  })

  it('leaves an international number alone', () => {
    expect(whatsappNumber('+1 312 555 0199', '34')).toBe('13125550199')
    expect(whatsappNumber('+34 612 345 678', '1')).toBe('34612345678')
    expect(whatsappNumber('0034 612 345 678', '1')).toBe('34612345678')
  })

  it('does not double a code the number already carries, and drops a trunk zero', () => {
    expect(whatsappNumber('34612345678', '34')).toBe('34612345678')
    expect(whatsappNumber('0612345678', '34')).toBe('34612345678')
  })

  it('falls back to the digits when the restaurant has no country yet', () => {
    expect(whatsappNumber('612 345 678', null)).toBe('612345678')
    expect(whatsappNumber('   ', '1')).toBe('')
  })

  it('builds the wa.me link with an optional prefilled text', () => {
    expect(whatsappLink('612 345 678', '34')).toBe('https://wa.me/34612345678')
    expect(whatsappLink('612 345 678', '34', 'Pedido: 2 kg')).toBe('https://wa.me/34612345678?text=Pedido%3A%202%20kg')
    expect(whatsappLink('', '34')).toBe('')
  })
})
