import { describe, expect, it } from 'vitest'
import {
  actualMarginPct,
  foodSpend,
  ingredientSpend,
  reconciliationCandidates,
  startOfWeekFor,
  isFoodInvoice,
  ingredientResolver,
  possibleDuplicates,
  pantryValue,
  priceChangePct,
  realtimeSpend,
  recipesUsing,
  lineOverlap,
  valueNote,
  receiptsForIngredient,
  reconcileDeliveryNotes,
  suggestIngredients,
  unusedIngredients,
} from './domain'
import type { Ingredient, Invoice, MenuItem } from './types'

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
  const note = (over: Partial<Invoice> = {}) => inv({ docType: 'delivery_note', ...over })

  it('matches a note to the same vendor’s invoice whose value it explains', () => {
    const n = note({ total: 98 })
    const far = inv({ total: 300 })
    const close = inv({ total: 100, vendorName: 'ACME produce' })
    const [row] = reconcileDeliveryNotes([n, far, close])
    expect(row.match?.id).toBe(close.id)
    expect(row.status).toBe('matched')
  })

  // A second note dated after the factura can never be covered by it, but
  // it does mean the vendor has more than one note: the lone-pair
  // exception (below) stays out of these cases.
  const decoy = () => note({ invoiceDate: '2026-06-01', total: 7 })

  it('leaves a note unmatched for another vendor, or when no invoice is near its value', () => {
    const n = note({ total: 98 })
    expect(reconcileDeliveryNotes([n, inv({ vendorName: 'Other Foods', total: 98 })])[0].status).toBe('unmatched')
    expect(reconcileDeliveryNotes([n, decoy(), inv({ total: 300 })])[0].status).toBe('unmatched')
  })

  it('lets a factura cover the oldest notes that add up to it (consolidated billing)', () => {
    const a = note({ invoiceDate: '2026-10-02', total: 40 })
    const b = note({ invoiceDate: '2026-10-09', total: 35 })
    const c = note({ invoiceDate: '2026-10-16', total: 25 })
    const d = note({ invoiceDate: '2026-10-23', total: 30 })
    const bill = inv({ invoiceDate: '2026-10-31', total: 100 })
    const rows = reconcileDeliveryNotes([a, b, c, d, bill])
    expect(rows.map((r) => r.match?.id ?? null)).toEqual([bill.id, bill.id, bill.id, null])
  })

  it('never lets a factura cover a delivery made after it — early-month notes stay pending', () => {
    const october = note({ invoiceDate: '2026-10-20', total: 100 })
    const november = note({ invoiceDate: '2026-11-02', total: 100 })
    const bill = inv({ invoiceDate: '2026-11-05', total: 100 })
    const rows = reconcileDeliveryNotes([november, october, bill])
    expect(rows.find((r) => r.note.id === october.id)?.match?.id).toBe(bill.id)
    expect(rows.find((r) => r.note.id === november.id)?.status).toBe('unmatched')
  })

  it('reaches back further than 40 days for a late factura, but not past 120', () => {
    const n = note({ invoiceDate: '2026-05-10', total: 100 })
    expect(reconcileDeliveryNotes([n, inv({ invoiceDate: '2026-07-01', total: 100 })])[0].status).toBe('matched')
    expect(reconcileDeliveryNotes([n, inv({ invoiceDate: '2026-10-01', total: 100 })])[0].status).toBe('unmatched')
  })

  it('offers a claimed note to no later factura', () => {
    const n = note({ invoiceDate: '2026-10-02', total: 100 })
    const first = inv({ invoiceDate: '2026-10-05', total: 100 })
    const second = inv({ invoiceDate: '2026-10-12', total: 100 })
    const [row] = reconcileDeliveryNotes([n, second, first])
    expect(row.match?.id).toBe(first.id)
  })

  it('attaches an unpriced note only to a factura its priced notes do not explain', () => {
    const priced = note({ invoiceDate: '2026-10-02', total: 100, lineItems: [line('Leek', 100)] })
    const blank = note({ invoiceDate: '2026-10-09', total: 0, lineItems: [] })
    const bill = inv({ invoiceDate: '2026-10-31', total: 100, lineItems: [line('Leek', 100)] })
    const rows = reconcileDeliveryNotes([priced, blank, bill])
    expect(rows.map((r) => r.status)).toEqual(['matched', 'unmatched'])
    const lone = note({ invoiceDate: '2026-10-09', total: 0, lineItems: [] })
    expect(reconcileDeliveryNotes([lone, bill])[0].match?.id).toBe(bill.id)
  })

  it('sizes the band by how sure the value is: printed lines tight, pantry estimates loose', () => {
    // (Different products, so the only evidence is the money.)
    const printed = note({ lineItems: [line('Leek', 90)], total: 90 })
    expect(reconcileDeliveryNotes([printed, decoy(), inv({ lineItems: [line('Onion', 100)], total: 100 })])[0].status).toBe('unmatched')
    const unpriced = { name: 'Leek', qty: 9, unit: 'kg' as const, unitPrice: 0, total: 0, ingredientId: 'leek' }
    const pantry = new Map([['leek', ing({ id: 'leek', unit: 'kg', lastUnitPrice: 10 })]])
    const estimated = note({ lineItems: [unpriced], total: 0 })
    const bill = inv({ lineItems: [line('Leek', 100)], total: 100 })
    expect(valueNote(estimated, pantry)).toMatchObject({ total: 90, firm: 0, soft: 90, unvalued: 0 })
    expect(reconcileDeliveryNotes([estimated, bill], pantry)[0].status).toBe('matched')
  })

  it('claims a note whose lines are on the factura even when its estimate drifted far', () => {
    const drifted = note({ invoiceDate: '2026-10-02', lineItems: [line('Salmon', 60), line('Tuna', 20)], total: 80 })
    const bill = inv({ invoiceDate: '2026-10-31', lineItems: [line('salmon', 70), line('tuna', 30)], total: 100 })
    expect(lineOverlap(drifted, bill)).toBe(1)
    expect(reconcileDeliveryNotes([drifted, bill])[0].match?.id).toBe(bill.id)
    // …but never more goods than the factura bills.
    const bigger = note({ invoiceDate: '2026-10-09', lineItems: [line('Salmon', 100), line('Tuna', 50)], total: 150 })
    expect(reconcileDeliveryNotes([bigger, note({ invoiceDate: '2026-11-09', total: 7 }), bill])[0].status).toBe('unmatched')
  })

  it('keeps the closest factura as a near miss on an unmatched row', () => {
    const n = note({ invoiceDate: '2026-10-02', lineItems: [line('Leek', 80)], total: 80 })
    const far = inv({ invoiceDate: '2026-10-10', lineItems: [line('Onion', 300)], total: 300 })
    const close = inv({ invoiceDate: '2026-10-20', lineItems: [line('Onion', 100)], total: 100 })
    const [row] = reconcileDeliveryNotes([n, far, close])
    expect(row.status).toBe('unmatched')
    expect(row.nearMiss?.invoice.id).toBe(close.id)
    expect(row.nearMiss?.gapPct).toBeCloseTo(-20)
    expect(row.nearMiss?.overlap).toBe(0)
    expect(reconciliationCandidates([n, far, close], n, close.id)[0].id).toBe(close.id)
    expect(reconcileDeliveryNotes([n, inv({ vendorName: 'Other' })])[0].nearMiss).toBeUndefined()
  })

  it('pairs a vendor’s lone note with its lone factura whatever OCR made of the money', () => {
    const n = note({ invoiceDate: '2026-10-02', lineItems: [line('Lechuga', 80)], total: 80 })
    const bill = inv({ invoiceDate: '2026-10-02', lineItems: [line('Tomate', 300)], total: 300 })
    expect(reconcileDeliveryNotes([n, bill])[0].match?.id).toBe(bill.id)
    // …but not when there is a second note the factura might mean instead,
    const other = note({ invoiceDate: '2026-10-01', lineItems: [line('Cebolla', 10)], total: 10 })
    expect(reconcileDeliveryNotes([n, other, bill]).map((r) => r.status)).toEqual(['unmatched', 'unmatched'])
    // …nor a second factura the note might belong to,
    expect(reconcileDeliveryNotes([n, bill, inv({ invoiceDate: '2026-10-03', total: 500 })])[0].status).toBe('unmatched')
    // …nor across the never-after rule.
    const later = note({ invoiceDate: '2026-10-20', lineItems: [line('Lechuga', 80)], total: 80 })
    expect(reconcileDeliveryNotes([later, bill])[0].status).toBe('unmatched')
    // An unexplained factura the note cannot reach is no alternative.
    const stale = inv({ invoiceDate: '2026-03-01', total: 500 })
    expect(reconcileDeliveryNotes([n, bill, stale])[0].match?.id).toBe(bill.id)
  })

  it('compares food value (the lines), not the printed total with tax', () => {
    const n = note({ lineItems: [line('Tomato', 50), line('Onion', 50)], total: 100 })
    const bill = inv({ lineItems: [line('tomato', 50), line('Onion', 50)], total: 121 })
    expect(reconcileDeliveryNotes([n, bill])[0].status).toBe('matched')
  })

  it('flags a >2% price difference on a shared line as price_mismatch', () => {
    const n = note({ lineItems: [line('Tomato', 2.0), line('Onion', 1.0)], total: 3 })
    const bill = inv({ lineItems: [line('tomato', 2.2), line('Onion', 1.01)], total: 3.21 })
    const [row] = reconcileDeliveryNotes([n, bill])
    expect(row.status).toBe('price_mismatch')
    expect(row.diffs).toEqual([{ name: 'Tomato', notePrice: 2.0, invoicePrice: 2.2 }])
  })

  it('honours a manual link over the heuristic and skips handled notes', () => {
    const linked = inv({ vendorName: 'Somebody Else', total: 999 })
    const n = note({ reconInvoiceId: linked.id } as Partial<Invoice>)
    const handled = note({ reconHandled: true } as Partial<Invoice>)
    const rows = reconcileDeliveryNotes([n, handled, inv(), linked])
    expect(rows).toHaveLength(1)
    expect(rows[0].match?.id).toBe(linked.id)
  })

  it('skips a note diverted to an expense — the expense ledger already has it', () => {
    const diverted = note({ expenseTag: 'Limpieza' } as Partial<Invoice>)
    expect(reconcileDeliveryNotes([diverted, inv()])).toEqual([])
  })
})

describe('realtimeSpend', () => {
  const food = (docs: Invoice[]) => docs.filter(isFoodInvoice).reduce((s, i) => s + foodSpend(i), 0)

  it('is billed + pending notes, never counting a note filed as an expense', () => {
    const bill = inv({ total: 100 })
    const pending = inv({ docType: 'delivery_note', vendorName: 'Late Biller', total: 40, lineItems: [line('Leek', 40)] })
    const diverted = inv({
      docType: 'delivery_note',
      vendorName: 'Cleaning Co',
      expenseTag: 'Limpieza',
      total: 25,
      lineItems: [line('total', 25)],
    } as Partial<Invoice>)
    const rt = realtimeSpend([bill, pending, diverted], new Map())
    expect(rt.pendingCount).toBe(1)
    expect(rt.pendingTotal).toBe(40)
    expect(rt.oldestPending).toBe(pending.invoiceDate)
    expect(food(rt.seriesDocs)).toBeCloseTo(food([bill]) + rt.pendingTotal, 2)
    // The breakdowns see the same money, with the pending note's lines.
    expect(food(rt.breakdownDocs)).toBeCloseTo(food(rt.seriesDocs), 2)
    expect(ingredientSpend(rt.breakdownDocs).map((r) => r.name)).toEqual(['Leek'])
  })

  it('keeps a covered note at its delivery date and leaves the factura only the remainder', () => {
    const a = inv({ docType: 'delivery_note', invoiceDate: '2026-10-02', lineItems: [line('Leek', 40)], total: 40 })
    const b = inv({ docType: 'delivery_note', invoiceDate: '2026-10-16', lineItems: [line('Leek', 35)], total: 35 })
    const bill = inv({ invoiceDate: '2026-10-31', lineItems: [line('Leek', 75), line('Delivery', 3)], total: 94 })
    const rt = realtimeSpend([bill, a, b], new Map())
    expect(rt.pendingCount).toBe(0)
    expect(food(rt.seriesDocs)).toBeCloseTo(food([bill]), 2)
    const byDate = Object.fromEntries(rt.seriesDocs.filter(isFoodInvoice).map((d) => [d.invoiceDate, foodSpend(d)]))
    expect(byDate).toEqual({ '2026-10-02': 40, '2026-10-16': 35, '2026-10-31': 3 })
    // …while the breakdowns keep the factura's lines whole and leave the
    // covered notes out: no ingredient is lost to the re-dating.
    expect(rt.breakdownDocs.map((d) => d.id)).toEqual([bill.id])
    expect(ingredientSpend(rt.breakdownDocs)).toEqual([
      { ingredientId: null, name: 'Leek', total: 75 },
      { ingredientId: null, name: 'Delivery', total: 3 },
    ])
  })

  it('lets the notes itemize a covered factura approved without lines', () => {
    // A monthly factura approved from its summary page: 78 billed, no
    // lines. Its two notes explain 75 of it; the 3 left is a fee.
    const a = inv({ docType: 'delivery_note', invoiceDate: '2026-10-02', lineItems: [line('Leek', 40)], total: 40 })
    const b = inv({ docType: 'delivery_note', invoiceDate: '2026-10-16', lineItems: [line('Onion', 35)], total: 35 })
    const bill = inv({ invoiceDate: '2026-10-31', lineItems: [], total: 78 })
    const rt = realtimeSpend([bill, a, b], new Map())
    expect(rt.pendingCount).toBe(0)
    // Series and breakdowns are the same picture: the notes' goods at
    // their dates, the factura's unexplained remainder on its own.
    expect(rt.breakdownDocs).toEqual(rt.seriesDocs)
    expect(food(rt.breakdownDocs)).toBeCloseTo(78, 2)
    expect(ingredientSpend(rt.breakdownDocs)).toEqual([
      { ingredientId: null, name: 'Leek', total: 40 },
      { ingredientId: null, name: 'Onion', total: 35 },
    ])
  })

  it('never shows more than Billed: notes that over-explain their factura are scaled to it', () => {
    const a = inv({ docType: 'delivery_note', invoiceDate: '2026-10-02', lineItems: [line('Leek', 60)], total: 60 })
    const b = inv({ docType: 'delivery_note', invoiceDate: '2026-10-16', lineItems: [line('Leek', 55)], total: 55 })
    const bill = inv({ invoiceDate: '2026-10-31', lineItems: [line('leek', 100)], total: 100 })
    const rt = realtimeSpend([bill, a, b], new Map())
    expect(food(rt.seriesDocs)).toBeCloseTo(100, 1)
    const byDate = Object.fromEntries(rt.seriesDocs.filter(isFoodInvoice).map((d) => [d.invoiceDate, foodSpend(d)]))
    expect(byDate['2026-10-02']).toBeCloseTo(52.17, 1)
    expect(byDate['2026-10-16']).toBeCloseTo(47.83, 1)
    expect(byDate['2026-10-31']).toBeUndefined()
    // The breakdown still has the factura, whole, and nothing else.
    expect(rt.breakdownDocs).toEqual([bill])
  })

  it('drops a factura its notes fully explain', () => {
    const a = inv({ docType: 'delivery_note', invoiceDate: '2026-10-02', lineItems: [line('Leek', 100)], total: 100 })
    const bill = inv({ invoiceDate: '2026-10-31', lineItems: [line('Leek', 100)], total: 121 })
    const rt = realtimeSpend([bill, a], new Map())
    expect(rt.seriesDocs.filter(isFoodInvoice).map((d) => d.invoiceDate)).toEqual(['2026-10-02'])
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

describe('recipesUsing', () => {
  const item = (id: string, recipe: MenuItem['recipe'], over: Partial<MenuItem> = {}): MenuItem => ({
    id, name: id, price: 10, targetMarginPct: 70, recipe, active: true, ...over,
  })
  const menu = [
    item('stock', [{ ingredientId: 'bones', qty: 4, unit: 'kg' }], { kind: 'prep', price: 0, yield: { qty: 2, unit: 'L' } }),
    item('steak', [{ subItemId: 'stock', qty: 50, unit: 'ml' }, { ingredientId: 'salt', qty: 2, unit: 'g' }, { ingredientId: 'salt', qty: 1, unit: 'g' }]),
    item('old', [{ ingredientId: 'bones', qty: 1 }], { active: false }),
  ]

  it('lists active recipes, preps included, one entry per line', () => {
    expect(recipesUsing(menu, { ingredientId: 'bones' }).map((u) => u.item.id)).toEqual(['stock'])
    expect(recipesUsing(menu, { ingredientId: 'salt' }).map((u) => u.qty)).toEqual([2, 1])
  })

  it('finds the users of a prep by its sub-recipe lines', () => {
    expect(recipesUsing(menu, { subItemId: 'stock' })).toEqual([{ item: menu[1], qty: 50, unit: 'ml' }])
  })

  it('is empty for an ingredient no active recipe uses', () => {
    expect(recipesUsing(menu, { ingredientId: 'saffron' })).toEqual([])
  })
})

describe('unusedIngredients', () => {
  const ing = (id: string, over: Partial<Ingredient> = {}) => ({ id, category: 'produce', ...over }) as Ingredient
  const dish = (recipe: MenuItem['recipe'], active = true) =>
    ({ id: 'd' + recipe.length, name: 'd', price: 10, targetMarginPct: 70, recipe, active }) as MenuItem

  it('flags only ingredients no active recipe uses', () => {
    const ings = [ing('lemon'), ing('salt'), ing('old')]
    const menu = [dish([{ ingredientId: 'lemon', qty: 1 }]), dish([{ ingredientId: 'old', qty: 1 }, { ingredientId: 'x', qty: 1 }], false)]
    expect(unusedIngredients(ings, menu).map((i) => i.id)).toEqual(['salt', 'old'])
  })

  it('leaves out cleaning supplies and what the owner marked "not in recipes"', () => {
    const ings = [ing('bleach', { category: 'cleaning' }), ing('bags', { notInRecipes: true }), ing('salt')]
    expect(unusedIngredients(ings, []).map((i) => i.id)).toEqual(['salt'])
  })
})

// ── Ingredient identity (docs/architecture.md §Ingredient identity) ──

const pantryIng = (id: string, name: string, over: Partial<Ingredient> = {}): Ingredient =>
  ing({ id, name, nameKey: name.toLowerCase().replace(/[^a-z0-9 ]/g, ''), category: 'meat', ...over })

describe('receiptsForIngredient (alias-aware)', () => {
  const jamon = pantryIng('jam', 'Jamón ibérico', { nameKey: 'jamn ibrico', aliases: ['jamon bellota'] })

  it('matches id-less lines by folded name and by alias', () => {
    const rows = receiptsForIngredient(
      [inv({ lineItems: [line('JAMON IBERICO', 30), line('Jamon bellota', 40), line('Chorizo', 5)] })],
      jamon,
    )
    expect(rows.map((r) => r.unitPrice)).toEqual([30, 40])
  })

  it('never claims a line resolved to a different ingredient', () => {
    const rows = receiptsForIngredient([inv({ lineItems: [{ ...line('Jamón ibérico', 30), ingredientId: 'other' }] })], jamon)
    expect(rows).toHaveLength(0)
  })
})

describe('ingredientSpend', () => {
  it('groups id-less "Jamón" and "JAMON" into one row', () => {
    const rows = ingredientSpend([inv({ lineItems: [line('Jamón', 10), line('JAMON', 15)] })])
    expect(rows).toHaveLength(1)
    expect(rows[0].total).toBe(25)
  })
})

describe('ingredientResolver', () => {
  const matchIngredientByName = (name: string, all: Ingredient[]) => ingredientResolver(all)(name)
  const pork = pantryIng('pork', 'Pork chop', { aliases: ['prk chop'] })
  const jamon = pantryIng('jam', 'Jamón', { nameKey: 'jamn' })
  const oldBeef = pantryIng('beef-old', 'Beef', { archived: true })
  const beef = pantryIng('beef', 'Beef')

  it('matches by nameKey, folded name and alias', () => {
    const all = [pork, jamon]
    expect(matchIngredientByName('PORK CHOP', all)?.id).toBe('pork')
    expect(matchIngredientByName('JAMON', all)?.id).toBe('jam')
    expect(matchIngredientByName('Prk. Chop', all)?.id).toBe('pork')
  })

  it('prefers a live ingredient over an archived one', () => {
    expect(matchIngredientByName('beef', [oldBeef, beef])?.id).toBe('beef')
  })

  it("never lets another ingredient's alias shadow an exact name", () => {
    const thief = pantryIng('thief', 'Lomo', { aliases: ['pork chop'] })
    expect(matchIngredientByName('PORK CHOP', [thief, pork])?.id).toBe('pork')
  })

  it('misses an unknown name', () => {
    expect(matchIngredientByName('Salmon', [pork, jamon])).toBeNull()
    expect(matchIngredientByName('  ', [pork])).toBeNull()
  })
})

describe('suggestIngredients', () => {
  const pantry = [
    pantryIng('a', 'Pork chop'), // 0.62
    pantryIng('b', 'Pork chops', { category: 'produce' }), // 0.55
    pantryIng('c', 'Pork chp'), // 1
    pantryIng('d', 'PORK CHP (fresh)'),
    pantryIng('e', 'Pork chp', { archived: true }),
    pantryIng('f', 'Olive oil'),
  ]

  it('keeps candidates above the floor, same category first, top 3, no archived', () => {
    const got = suggestIngredients('PORK CHP', 'produce', pantry).map((s) => s.ingredient.id)
    expect(got[0]).toBe('b')
    expect(got).toHaveLength(3)
    expect(got).not.toContain('e')
    expect(got).not.toContain('f')
  })

  it('returns nothing below the floor', () => {
    expect(suggestIngredients('Salmon fillet', 'meat', pantry)).toEqual([])
  })
})

describe('possibleDuplicates', () => {
  it('lists each close pair once, same category only, archived excluded, closest first', () => {
    const pantry = [
      pantryIng('1', 'Chuleta de cerdo'),
      pantryIng('2', 'CHULETA CERDO 1KG'),
      pantryIng('3', 'Chuleta de cerdo', { category: 'produce' }),
      pantryIng('4', 'Croquetas de jamón'),
      pantryIng('5', 'CROQUETAS JAMON'),
      pantryIng('6', 'Croquetas jamón', { archived: true }),
      pantryIng('7', 'Olive oil'),
    ]
    const pairs = possibleDuplicates(pantry).map((p) => [p.a.id, p.b.id].sort().join('-'))
    expect(pairs).toEqual(['4-5', '1-2'])
  })
})

describe('foodSpend (docs/us-market-readiness.md A7)', () => {
  it('is the sum of the lines, not the printed total that carries tax and delivery', () => {
    const i = inv({ lineItems: [line('tomato', 40), line('onion', 50)], total: 100 })
    expect(foodSpend(i)).toBe(90)
  })

  it('falls back to the total when the document has no priced lines', () => {
    expect(foodSpend(inv({ lineItems: [], total: 100 }))).toBe(100)
    expect(foodSpend(inv({ lineItems: [], total: null }))).toBe(0)
  })
})

describe('actualMarginPct (docs/us-market-readiness.md A6)', () => {
  const dish = { id: 'd', name: 'Soup', price: 11, active: true, recipe: [{ ingredientId: 'i', qty: 1, unit: 'kg' }], targetMarginPct: 65 } as unknown as MenuItem
  const ings = new Map([['i', ing({ id: 'i', lastUnitPrice: 3 })]])

  it('uses the printed price when menu prices are pre-tax', () => {
    expect(actualMarginPct(dish, ings).margin).toBeCloseTo(((11 - 3) / 11) * 100, 5)
  })

  it('nets an inclusive price by the rate before the margin', () => {
    expect(actualMarginPct(dish, ings, new Map(), 0, { pricesIncludeTax: true, rate: 0.1 }).margin).toBeCloseTo(70, 5)
  })
})

describe('credit memos (docs/us-market-readiness.md A8)', () => {
  it('count as food documents whose money comes OUT of spend', () => {
    const credit = inv({ docType: 'credit_memo', lineItems: [line('tomato', 40)], total: 40 })
    expect(isFoodInvoice(credit)).toBe(true)
    expect(foodSpend(credit)).toBe(-40)
    const spend = ingredientSpend([inv({ lineItems: [line('tomato', 100)], total: 100 }), credit])
    expect(spend).toEqual([{ ingredientId: null, name: 'tomato', total: 60 }])
  })
})

describe('delivery notes and credit memos (A8)', () => {
  it('never pairs an albarán with a credit memo, by heuristic or as a candidate', () => {
    const note = inv({ id: 'note', docType: 'delivery_note', vendorName: 'Acme', invoiceDate: '2026-10-20', lineItems: [line('tomato', 84)], total: 84 })
    const credit = inv({ id: 'credit', docType: 'credit_memo', vendorName: 'Acme', invoiceDate: '2026-10-21', lineItems: [line('tomato', 84)], total: 84 })
    const bill = inv({ id: 'bill', docType: 'invoice', vendorName: 'Acme', invoiceDate: '2026-10-22', lineItems: [line('tomato', 84)], total: 84 })
    const [row] = reconcileDeliveryNotes([note, credit, bill])
    expect(row?.match?.id).toBe('bill')
    expect(reconciliationCandidates([note, credit, bill], note).map((i) => i.id)).toEqual(['bill'])
    expect(reconcileDeliveryNotes([note, credit])[0]?.match).toBeFalsy()
  })
})

describe('startOfWeekFor (docs/us-market-readiness.md B7)', () => {
  // Wednesday 2026-10-28.
  const wed = new Date(2026, 9, 28, 15, 30)
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

  it('starts a US week on Sunday and everyone else\'s on Monday', () => {
    expect(iso(startOfWeekFor(wed, 0))).toBe('2026-10-25')
    expect(iso(startOfWeekFor(wed, 1))).toBe('2026-10-26')
  })

  it('keeps a Sunday in the Sunday-start week and sends it back a week on Monday-start', () => {
    const sun = new Date(2026, 9, 25, 9)
    expect(iso(startOfWeekFor(sun, 0))).toBe('2026-10-25')
    expect(iso(startOfWeekFor(sun, 1))).toBe('2026-10-19')
  })
})
