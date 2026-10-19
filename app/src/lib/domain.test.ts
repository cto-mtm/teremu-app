import { describe, expect, it } from 'vitest'
import { isFoodInvoice, pantryValue, priceChangePct, reconcileDeliveryNotes } from './domain'
import type { Ingredient, Invoice } from './types'

// domain.ts is the client-side math behind Pulse, Menu and Pantry. The
// cases here pin the rules that, when wrong, double-count or hide money:
// what counts as food spend, and albarán ↔ factura reconciliation.

let seq = 0
const inv = (over: Partial<Invoice> = {}): Invoice =>
  ({
    id: `inv-${(seq += 1)}`,
    status: 'approved',
    docType: 'invoice',
    vendorName: 'Acme Produce',
    invoiceDate: '2026-05-10',
    imagePath: 'x.jpg',
    lineItems: [],
    total: 100,
    ...over,
  }) as Invoice

const line = (name: string, unitPrice: number) => ({ name, qty: 1, unit: 'kg' as const, unitPrice, total: unitPrice })

const ing = (over: Partial<Ingredient> = {}): Ingredient =>
  ({ id: 'i', name: 'x', unit: 'kg', lastUnitPrice: null, prevUnitPrice: null, theoreticalQty: 0, ...over }) as Ingredient

describe('isFoodInvoice', () => {
  it('counts approved, untagged invoices only — never delivery notes', () => {
    expect(isFoodInvoice(inv())).toBe(true)
    expect(isFoodInvoice(inv({ status: 'needs_review' }))).toBe(false)
    expect(isFoodInvoice(inv({ docType: 'delivery_note' }))).toBe(false)
    expect(isFoodInvoice(inv({ expenseTag: 'utilities' } as Partial<Invoice>))).toBe(false)
  })
})

describe('reconcileDeliveryNotes', () => {
  it('matches a note to the same vendor’s invoice with the closest total', () => {
    const note = inv({ docType: 'delivery_note', total: 98 })
    const far = inv({ total: 300 })
    const close = inv({ total: 100, vendorName: 'ACME produce' })
    const [row] = reconcileDeliveryNotes([note, far, close])
    expect(row.match?.id).toBe(close.id)
    expect(row.status).toBe('matched')
  })

  it('leaves a note unmatched outside the 40-day window or for another vendor', () => {
    const note = inv({ docType: 'delivery_note', invoiceDate: '2026-05-10' })
    const late = inv({ invoiceDate: '2026-07-01' })
    const other = inv({ vendorName: 'Other Foods' })
    expect(reconcileDeliveryNotes([note, late, other])[0].status).toBe('unmatched')
  })

  it('flags a >2% price difference on a shared line as price_mismatch', () => {
    const note = inv({ docType: 'delivery_note', lineItems: [line('Tomato', 2.0), line('Onion', 1.0)] })
    const bill = inv({ lineItems: [line('tomato', 2.2), line('Onion', 1.01)] })
    const [row] = reconcileDeliveryNotes([note, bill])
    expect(row.status).toBe('price_mismatch')
    expect(row.diffs).toEqual([{ name: 'Tomato', notePrice: 2.0, invoicePrice: 2.2 }])
  })

  it('honours a manual link over the heuristic and skips handled notes', () => {
    const linked = inv({ vendorName: 'Somebody Else', total: 999 })
    const note = inv({ docType: 'delivery_note', reconInvoiceId: linked.id } as Partial<Invoice>)
    const handled = inv({ docType: 'delivery_note', reconHandled: true } as Partial<Invoice>)
    const rows = reconcileDeliveryNotes([note, handled, inv(), linked])
    expect(rows).toHaveLength(1)
    expect(rows[0].match?.id).toBe(linked.id)
  })
})

describe('priceChangePct / pantryValue', () => {
  it('is the % change between the last two prices, null without both', () => {
    expect(priceChangePct(ing({ lastUnitPrice: 11, prevUnitPrice: 10 }))).toBeCloseTo(10)
    expect(priceChangePct(ing({ lastUnitPrice: 11 }))).toBeNull()
    expect(priceChangePct(ing({ lastUnitPrice: 11, prevUnitPrice: 0 }))).toBeNull()
  })

  it('values stock at last price, ignoring negative theoretical qty and unpriced items', () => {
    expect(
      pantryValue([
        ing({ theoreticalQty: 3, lastUnitPrice: 2 }),
        ing({ theoreticalQty: -5, lastUnitPrice: 10 }),
        ing({ theoreticalQty: 4 }),
      ]),
    ).toBe(6)
  })
})
