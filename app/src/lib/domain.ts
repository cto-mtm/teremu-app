// Pure domain math — no I/O, no Vue. Everything the Pulse, Menu and
// Pantry pages derive client-side from the fetched collections.

import type { Category, ExpenseEntry, Ingredient, Invoice, MenuItem, RecipeLine, RevenueEntry, Unit } from './types'
import { convertQty } from './units'
import {
  expandUsage,
  foldName,
  IngredientIndex,
  ingredientKeys,
  isDish,
  nameSimilarity,
  normalizeName,
  pairSubcategory,
  plateCost,
  prepLaborCost,
  qtyInStockUnit,
  subMultiplier,
  SUBCATEGORIES,
} from '@teremu/shared'

export { foldName, ingredientKeys, normalizeName }

/** Milliseconds in one day — shared constant for all time math below. */
const DAY_MS = 86_400_000

/**
 * A FOOD invoice: approved, not diverted to a tagged expense, and not a
 * delivery note (the matching factura carries the money — counting both
 * would double everything). Every pantry / food-cost / vendor-spend
 * aggregation filters on this.
 */
export const isFoodInvoice = (inv: Invoice): boolean =>
  inv.status === 'approved' && !inv.expenseTag && inv.docType !== 'delivery_note'

// ── Delivery-note reconciliation (albarán ↔ factura) ────────────────

export interface ReconciliationRow {
  note: Invoice
  match: Invoice | null
  status: 'matched' | 'price_mismatch' | 'unmatched'
  diffs: { name: string; notePrice: number; invoicePrice: number }[]
}

const RECON_WINDOW_DAYS = 40

/** Shared line items priced differently on note vs invoice (>2%). */
function priceDiffs(note: Invoice, invoice: Invoice): ReconciliationRow['diffs'] {
  const invPrices = new Map(
    invoice.lineItems.filter((l) => l.unitPrice > 0).map((l) => [normalizeName(l.name), l.unitPrice]),
  )
  const diffs: ReconciliationRow['diffs'] = []
  for (const line of note.lineItems) {
    if (line.unitPrice <= 0) continue
    const invPrice = invPrices.get(normalizeName(line.name))
    if (invPrice == null) continue
    if (Math.abs(invPrice - line.unitPrice) > Math.max(0.02, line.unitPrice * 0.02)) {
      diffs.push({ name: line.name, notePrice: line.unitPrice, invoicePrice: invPrice })
    }
  }
  return diffs
}

/**
 * Pair each delivery note with its most plausible invoice: same vendor,
 * dated within the window, closest total. A manual link
 * (note.reconInvoiceId) overrides the auto-matcher; notes marked
 * handled are excluded entirely, and so are notes diverted to an
 * expense — the expense ledger already carries that money, and only
 * food facturas are candidates. Price differences on shared line items
 * (>2%) surface as diffs — that's the billing-error catch.
 */
export function reconcileDeliveryNotes(invoices: Invoice[]): ReconciliationRow[] {
  const notes = invoices.filter(
    (i) =>
      i.docType === 'delivery_note' &&
      !i.reconHandled &&
      !i.expenseTag &&
      (i.status === 'approved' || i.status === 'needs_review'),
  )
  const bills = invoices.filter((i) => isFoodInvoice(i) && i.vendorName)

  return notes.map((note) => {
    // Manual link wins over the heuristic.
    if (note.reconInvoiceId) {
      const linked = invoices.find((i) => i.id === note.reconInvoiceId)
      if (linked) {
        const diffs = priceDiffs(note, linked)
        return { note, match: linked, status: diffs.length ? ('price_mismatch' as const) : ('matched' as const), diffs }
      }
    }

    const noteKey = note.vendorName ? normalizeName(note.vendorName) : ''
    const noteTime = note.invoiceDate ? new Date(note.invoiceDate + 'T12:00:00').getTime() : null
    const candidates = bills.filter((b) => {
      if (!noteKey || normalizeName(b.vendorName!) !== noteKey) return false
      if (noteTime == null || !b.invoiceDate) return true
      const dt = Math.abs(new Date(b.invoiceDate + 'T12:00:00').getTime() - noteTime)
      return dt <= RECON_WINDOW_DAYS * 86_400_000
    })
    if (candidates.length === 0) return { note, match: null, status: 'unmatched' as const, diffs: [] }

    const match = candidates.reduce((best, b) =>
      Math.abs((b.total ?? 0) - (note.total ?? 0)) < Math.abs((best.total ?? 0) - (note.total ?? 0)) ? b : best,
    )
    const diffs = priceDiffs(note, match)
    return { note, match, status: diffs.length ? ('price_mismatch' as const) : ('matched' as const), diffs }
  })
}

/** Invoices a note could plausibly link to by hand (same vendor first). */
export function reconciliationCandidates(invoices: Invoice[], note: Invoice): Invoice[] {
  const noteKey = note.vendorName ? normalizeName(note.vendorName) : ''
  return invoices
    .filter((i) => isFoodInvoice(i) && i.id !== note.id)
    .sort((a, b) => {
      const aSame = a.vendorName && normalizeName(a.vendorName) === noteKey ? 0 : 1
      const bSame = b.vendorName && normalizeName(b.vendorName) === noteKey ? 0 : 1
      if (aSame !== bSame) return aSame - bSame
      return (b.invoiceDate ?? '').localeCompare(a.invoiceDate ?? '')
    })
    .slice(0, 20)
}

// ── Billed vs real-time spend (factura vs albarán consolidation) ────

export interface RealtimeSpend {
  /** Billed invoices + pending delivery notes shaped as invoices. */
  docs: Invoice[]
  /** Value received but not yet billed — the billed↔realtime delta. */
  pendingTotal: number
  pendingCount: number
  /** Pending lines nobody could price (no line price, no pantry price). */
  unvaluedLines: number
}

/**
 * The REAL-TIME view of food spend. Facturas alone are the accounting
 * truth, but a vendor on consolidated billing delivers for weeks on
 * albaranes before the factura lands — so this view adds every approved
 * delivery note that no factura covers yet (reconciliation says
 * unmatched, not marked handled). Once the factura arrives and matches,
 * its notes drop out and the factura takes over: the two views converge
 * and nothing is ever double-counted.
 *
 * Pending notes are returned as invoice-shaped docs (docType flipped,
 * lines valued) so every existing aggregate — weeklySeries,
 * vendorWeeklySpend, spendTree — consumes them unchanged. Albarán lines
 * are often unpriced: a line is valued at its own printed price, else
 * at the matched ingredient's current price (unit-converted), else it
 * counts as received-but-unvalued.
 */
export function realtimeSpend(
  invoices: Invoice[],
  ingredientsById: Map<string, Ingredient>,
): RealtimeSpend {
  const pendingNotes = reconcileDeliveryNotes(invoices)
    .filter((r) => r.status === 'unmatched' && r.note.status === 'approved')
    .map((r) => r.note)

  let pendingTotal = 0
  let unvaluedLines = 0
  const docs = [...invoices]
  for (const note of pendingNotes) {
    const lineItems = note.lineItems.map((line) => {
      if (line.total > 0) return line
      const ing = line.ingredientId ? ingredientsById.get(line.ingredientId) : undefined
      if (ing?.lastUnitPrice != null) {
        const qty = line.unit === ing.unit ? line.qty : convertQty(line.qty, line.unit, ing.unit)
        if (qty != null) return { ...line, total: +(qty * ing.lastUnitPrice).toFixed(2) }
      }
      unvaluedLines += 1
      return line
    })
    const total = +lineItems.reduce((s, l) => s + l.total, 0).toFixed(2)
    pendingTotal += total
    docs.push({ ...note, docType: 'invoice', lineItems, total })
  }
  return {
    docs,
    pendingTotal: +pendingTotal.toFixed(2),
    pendingCount: pendingNotes.length,
    unvaluedLines,
  }
}

/**
 * Plate costing lives in @teremu/shared (shared/src/cost.ts) so the API's
 * assistant quotes the same number this UI shows. Re-exported under the
 * historical name for the call sites below and in the pages.
 */
export { plateCost } from '@teremu/shared'

export function actualMarginPct(
  item: MenuItem,
  ingredients: Map<string, Ingredient>,
  menuItems: Map<string, MenuItem> = new Map(),
  laborRatePerHour = 0,
): { margin: number | null; cost: number; foodCost: number; laborCost: number; missing: boolean } {
  const costs = plateCost(item, ingredients, menuItems, laborRatePerHour)
  if (item.price <= 0) return { margin: null, ...costs }
  return { margin: ((item.price - costs.cost) / item.price) * 100, ...costs }
}

/** % change between the last two known prices for an ingredient. */
export function priceChangePct(ing: Ingredient): number | null {
  if (ing.lastUnitPrice == null || ing.prevUnitPrice == null || ing.prevUnitPrice === 0)
    return null
  return ((ing.lastUnitPrice - ing.prevUnitPrice) / ing.prevUnitPrice) * 100
}

export interface WeekPoint {
  weekStart: string // YYYY-MM-DD (Monday)
  expenses: number
  revenue: number
}

function startOfWeek(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7)) // Monday
  return x
}

/**
 * Build an 8-week expenses-vs-revenue series for the Pulse chart.
 * `otherExpenses` (tagged, non-food) are added into the expenses line;
 * leave it empty for food-only math (foodCostSeries does).
 */
export function weeklySeries(
  invoices: Invoice[],
  revenue: RevenueEntry[],
  otherExpenses: ExpenseEntry[] = [],
): WeekPoint[] {
  const weeks: WeekPoint[] = []
  const thisWeek = startOfWeek(new Date())
  for (let i = 7; i >= 0; i--) {
    const ws = new Date(thisWeek.getTime() - i * 7 * DAY_MS)
    weeks.push({ weekStart: ws.toISOString().slice(0, 10), expenses: 0, revenue: 0 })
  }
  const bucket = (dateStr: string | null, fallbackMs?: number): WeekPoint | null => {
    const d = dateStr ? new Date(dateStr + 'T12:00:00') : fallbackMs ? new Date(fallbackMs) : null
    if (!d || Number.isNaN(d.getTime())) return null
    const ws = startOfWeek(d).toISOString().slice(0, 10)
    return weeks.find((w) => w.weekStart === ws) ?? null
  }
  for (const inv of invoices) {
    if (!isFoodInvoice(inv) || inv.total == null) continue
    const w = bucket(inv.invoiceDate, inv.createdAt)
    if (w) w.expenses += inv.total
  }
  for (const r of revenue) {
    const w = bucket(r.date)
    if (w) w.revenue += r.amount
  }
  for (const e of otherExpenses) {
    const w = bucket(e.date)
    if (w) w.expenses += e.amount
  }
  return weeks
}

// ── Vendors & ingredient history (derived — no manual tagging) ──────

export interface VendorSummary {
  key: string // normalized name — used as the route param
  name: string
  invoiceCount: number // food invoices + tagged expense entries
  totalSpend: number
  lastDate: string | null
  /** Derived: ingredient categories this vendor supplies (food side). */
  categories: Category[]
  /** Derived: expense tags paid to this vendor (service side). */
  tags: string[]
}

/**
 * Vendor directory merged from BOTH sources: food vendors come from
 * approved invoices, service payees (photographer, hosting…) come from
 * expenses with a vendorName. Tags are derived, never hand-maintained.
 */
export function vendorSummaries(
  invoices: Invoice[],
  expenses: ExpenseEntry[] = [],
): VendorSummary[] {
  type Acc = Omit<VendorSummary, 'categories' | 'tags'> & {
    cats: Set<Category>
    tagSet: Set<string>
  }
  const map = new Map<string, Acc>()
  const acc = (key: string, name: string): Acc => {
    let v = map.get(key)
    if (!v) {
      v = { key, name, invoiceCount: 0, totalSpend: 0, lastDate: null, cats: new Set(), tagSet: new Set() }
      map.set(key, v)
    }
    return v
  }

  for (const inv of invoices) {
    if (!isFoodInvoice(inv) || !inv.vendorName) continue
    const key = normalizeName(inv.vendorName)
    if (!key) continue
    const v = acc(key, inv.vendorName)
    v.invoiceCount += 1
    v.totalSpend += inv.total ?? 0
    if (inv.invoiceDate && (!v.lastDate || inv.invoiceDate > v.lastDate)) v.lastDate = inv.invoiceDate
    for (const line of inv.lineItems) {
      if (line.category && line.category !== 'other') v.cats.add(line.category)
    }
  }

  for (const e of expenses) {
    if (!e.vendorName) continue
    const key = normalizeName(e.vendorName)
    if (!key) continue
    const v = acc(key, e.vendorName)
    v.invoiceCount += 1
    v.totalSpend += e.amount
    if (!v.lastDate || e.date > v.lastDate) v.lastDate = e.date
    v.tagSet.add(e.tag)
  }

  return [...map.values()]
    .map(({ cats, tagSet, ...v }) => ({
      ...v,
      categories: [...cats],
      tags: [...tagSet],
    }))
    .sort((a, b) => b.totalSpend - a.totalSpend)
}

/** One vendor's food invoices, newest first. */
export function vendorInvoicesFor(invoices: Invoice[], vendorKey: string): Invoice[] {
  return invoices
    .filter((i) => isFoodInvoice(i) && i.vendorName && normalizeName(i.vendorName) === vendorKey)
    .sort((a, b) => (b.invoiceDate ?? '').localeCompare(a.invoiceDate ?? ''))
}

/** Expense entries paid to one vendor (service side), newest first. */
export function vendorExpensesFor(expenses: ExpenseEntry[], vendorKey: string): ExpenseEntry[] {
  return expenses
    .filter((e) => e.vendorName && normalizeName(e.vendorName) === vendorKey)
    .sort((a, b) => b.date.localeCompare(a.date))
}

export interface SuppliedLine {
  /** Dedup key: resolved ingredient id, else the normalized line name. */
  key: string
  ingredientId: string | null
  name: string
  unit: Unit
  unitPrice: number
  date: string
}

/** Latest price paid to ONE vendor per ingredient, name-sorted.
 * Pass the vendor's invoices (see vendorInvoicesFor). */
export function vendorSuppliedLines(vendorInvoices: Invoice[]): SuppliedLine[] {
  const map = new Map<string, SuppliedLine>()
  for (const inv of vendorInvoices) {
    for (const line of inv.lineItems) {
      const key = line.ingredientId ?? foldName(line.name)
      const date = inv.invoiceDate ?? ''
      const existing = map.get(key)
      if (!existing || date > existing.date) {
        map.set(key, {
          key,
          ingredientId: line.ingredientId ?? null,
          name: line.name,
          unit: line.unit,
          unitPrice: line.unitPrice,
          date,
        })
      }
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export interface ReceiptLine {
  invoiceId: string
  date: string | null
  vendorName: string | null
  qty: number
  unit: Unit
  unitPrice: number
  total: number
}

// ── Ingredient identity (docs/architecture.md §Ingredient identity) ──

/** Name → the pantry ingredient approval would put it on, through the
 * same tiered lookup (shared/src/identity.ts). Build once per list. */
export function ingredientResolver(ingredients: Ingredient[]): (name: string) => Ingredient | null {
  const byId = new Map(ingredients.map((i) => [i.id, i]))
  const index = new IngredientIndex(ingredients.map((i) => [i.id, i] as const))
  return (name) => byId.get(index.resolve(name) ?? '') ?? null
}

/** Best non-archived candidates for an unmatched invoice line, by name
 * similarity against every key; same category first. */
export function suggestIngredients(
  name: string,
  category: Category | null | undefined,
  ingredients: Ingredient[],
  floor = 0.55,
  top = 3,
): { ingredient: Ingredient; score: number }[] {
  return ingredients
    .filter((i) => !i.archived)
    .map((i) => ({
      ingredient: i,
      score: Math.max(nameSimilarity(name, i.name), ...(i.aliases ?? []).map((a) => nameSimilarity(name, a))),
    }))
    .filter((s) => s.score >= floor)
    .sort((a, b) => {
      const ca = category && a.ingredient.category === category ? 0 : 1
      const cb = category && b.ingredient.category === category ? 0 : 1
      return ca - cb || b.score - a.score
    })
    .slice(0, top)
}

/** Likely duplicate pairs in the pantry: live, same category, names at
 * least 0.8 alike (the listing importer's bar). Each pair once, closest
 * first; `a` sorts before `b` by name. */
export function possibleDuplicates(ingredients: Ingredient[]): { a: Ingredient; b: Ingredient; score: number }[] {
  const live = ingredients.filter((i) => !i.archived).sort((x, y) => x.name.localeCompare(y.name))
  const out: { a: Ingredient; b: Ingredient; score: number }[] = []
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i]!
      const b = live[j]!
      if (a.category !== b.category) continue
      const score = nameSimilarity(a.name, b.name)
      if (score >= 0.8) out.push({ a, b, score })
    }
  }
  return out.sort((x, y) => y.score - x.score)
}

/**
 * Every approved purchase of one ingredient, newest first. Matches by
 * the resolved ingredientId; falls back to name matching (nameKey, folded
 * name, aliases) for invoices approved before ids were stored.
 */
export function receiptsForIngredient(invoices: Invoice[], ing: Ingredient): ReceiptLine[] {
  const rows: ReceiptLine[] = []
  const keys = ingredientKeys(ing)
  for (const inv of invoices) {
    if (!isFoodInvoice(inv)) continue
    for (const line of inv.lineItems) {
      const match = line.ingredientId
        ? line.ingredientId === ing.id
        : normalizeName(line.name) === ing.nameKey || keys.includes(foldName(line.name))
      if (match) {
        rows.push({
          invoiceId: inv.id,
          date: inv.invoiceDate,
          vendorName: inv.vendorName,
          qty: line.qty,
          unit: line.unit,
          unitPrice: line.unitPrice,
          total: line.total,
        })
      }
    }
  }
  return rows.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
}

/**
 * Ingredients no active recipe uses, so they never reach a plate cost —
 * the pantry flags them (docs/prep-recipes.md § Unused ingredients).
 * Cleaning supplies and anything the owner marked "not in recipes" are
 * left out. An ingredient inside a prep counts as used: the prep is a
 * recipe.
 */
export function unusedIngredients(ingredients: Ingredient[], menuItems: MenuItem[]): Ingredient[] {
  const used = new Set(menuItems.filter((m) => m.active).flatMap((m) => m.recipe.map((r) => r.ingredientId)))
  return ingredients.filter((i) => !used.has(i.id) && !i.notInRecipes && i.category !== 'cleaning')
}

/**
 * Active recipes (dishes and preps) with a line on this ingredient or
 * sub-recipe, one entry per line, in the line's own qty/unit. Direct use
 * only: an ingredient inside a prep is "used" by the prep, and the prep
 * shows its own users.
 */
export function recipesUsing(
  menuItems: MenuItem[],
  ref: { ingredientId: string } | { subItemId: string },
): { item: MenuItem; qty: number; unit?: Unit }[] {
  const hits = (r: RecipeLine) =>
    'ingredientId' in ref ? r.ingredientId === ref.ingredientId : r.subItemId === ref.subItemId
  return menuItems
    .filter((m) => m.active)
    .flatMap((m) => m.recipe.filter(hits).map((r) => ({ item: m, qty: r.qty, unit: r.unit })))
}

// ── Production planning (events / catering) ─────────────────────────

export interface PlanRow {
  ingredient: Ingredient
  required: number // stock units
  stock: number
  toBuy: number
}

/**
 * "I'm producing 40 salmon and 60 risotto": expand the recipes, compare
 * required quantities against theoretical stock, and say what to buy.
 */
export function productionPlan(
  selections: { menuItemId: string; qty: number }[],
  menuItems: MenuItem[],
  ingredients: Map<string, Ingredient>,
): PlanRow[] {
  const menuMap = new Map(menuItems.map((m) => [m.id, m]))
  const raw = expandUsage(selections, menuMap)
  const rows: PlanRow[] = []
  for (const [ingredientId, entries] of raw) {
    const ing = ingredients.get(ingredientId)
    if (!ing) continue
    const required = entries.reduce((s, e) => s + qtyInStockUnit(e, ing), 0)
    const stock = Math.max(0, ing.theoreticalQty)
    rows.push({
      ingredient: ing,
      required: +required.toFixed(2),
      stock: +stock.toFixed(1),
      toBuy: +Math.max(0, required - stock).toFixed(1),
    })
  }
  return rows.sort((a, b) => b.toBuy - a.toBuy)
}

// ── Dashboard visualizations ────────────────────────────────────────

export type Quadrant = 'star' | 'plowhorse' | 'puzzle' | 'dog'

export interface MenuEngineeringPoint {
  item: MenuItem
  units: number // total units sold (from revenue entries)
  margin: number // actual margin %
  quadrant: Quadrant
}

/**
 * The classic menu-engineering matrix: popularity (units sold) vs
 * margin %, split by the averages into stars / plowhorses (popular,
 * thin) / puzzles (profitable, slow) / dogs.
 */
export function menuEngineering(
  menuItems: MenuItem[],
  revenue: RevenueEntry[],
  ingredients: Map<string, Ingredient>,
  laborRatePerHour = 0,
): { points: MenuEngineeringPoint[]; avgUnits: number; avgMargin: number } {
  const units = new Map<string, number>()
  for (const r of revenue) {
    for (const s of r.itemsSold) units.set(s.menuItemId, (units.get(s.menuItemId) ?? 0) + s.qty)
  }
  const menuMap = new Map(menuItems.map((m) => [m.id, m]))
  const raw = menuItems
    .filter((m) => m.active && isDish(m)) // preps are never sold
    .map((m) => ({
      item: m,
      units: units.get(m.id) ?? 0,
      margin: actualMarginPct(m, ingredients, menuMap, laborRatePerHour).margin ?? 0,
    }))
  if (raw.length === 0) return { points: [], avgUnits: 0, avgMargin: 0 }
  const avgUnits = raw.reduce((s, p) => s + p.units, 0) / raw.length
  const avgMargin = raw.reduce((s, p) => s + p.margin, 0) / raw.length
  const points = raw.map((p) => ({
    ...p,
    quadrant: (p.units >= avgUnits
      ? p.margin >= avgMargin
        ? 'star'
        : 'plowhorse'
      : p.margin >= avgMargin
        ? 'puzzle'
        : 'dog') as Quadrant,
  }))
  return { points, avgUnits, avgMargin }
}

/**
 * Unit-price history for one ingredient, oldest first, normalized to
 * $/stock-unit — a vendor billing in lb and another in kg must land on
 * one comparable line. Incompatible units (case, box) are skipped.
 */
export function priceHistory(invoices: Invoice[], ing: Ingredient): { date: string; unitPrice: number }[] {
  const rows: { date: string; unitPrice: number }[] = []
  for (const r of receiptsForIngredient(invoices, ing)) {
    if (!r.date) continue
    const ratio = r.unit === ing.unit ? 1 : convertQty(1, r.unit, ing.unit)
    if (ratio == null || ratio === 0) continue
    rows.push({ date: r.date, unitPrice: +(r.unitPrice / ratio).toFixed(4) })
  }
  return rows.reverse()
}

export interface VendorWeekSpend {
  weekStart: string
  total: number
  segments: { key: string; name: string; amount: number }[]
}

/**
 * Weekly spend stacked by vendor (top 4 + "other") over the same
 * 8-week window as weeklySeries.
 */
export function vendorWeeklySpend(invoices: Invoice[]): {
  weeks: VendorWeekSpend[]
  vendors: { key: string; name: string }[]
} {
  const totals = new Map<string, { name: string; total: number }>()
  for (const inv of invoices) {
    if (!isFoodInvoice(inv) || !inv.vendorName || inv.total == null) continue
    const key = normalizeName(inv.vendorName)
    const v = totals.get(key) ?? { name: inv.vendorName, total: 0 }
    v.total += inv.total
    totals.set(key, v)
  }
  const top = [...totals.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 4)
  const topKeys = new Set(top.map(([k]) => k))
  const vendors = top.map(([key, v]) => ({ key, name: v.name }))
  if (totals.size > top.length) vendors.push({ key: 'other', name: 'other' })

  const base = weeklySeries(invoices, [])
  const weeks: VendorWeekSpend[] = base.map((w) => ({
    weekStart: w.weekStart,
    total: 0,
    segments: vendors.map((v) => ({ ...v, amount: 0 })),
  }))
  for (const inv of invoices) {
    if (!isFoodInvoice(inv) || !inv.vendorName || inv.total == null) continue
    const d = inv.invoiceDate ? new Date(inv.invoiceDate + 'T12:00:00') : new Date(inv.createdAt)
    for (const w of weeks) {
      const start = new Date(w.weekStart + 'T00:00:00').getTime()
      if (d.getTime() >= start && d.getTime() < start + 7 * DAY_MS) {
        const key = normalizeName(inv.vendorName)
        const seg = w.segments.find((s) => s.key === (topKeys.has(key) ? key : 'other'))
        if (seg) {
          seg.amount += inv.total
          w.total += inv.total
        }
        break
      }
    }
  }
  return { weeks, vendors }
}

/** Weekly food-cost %: purchases ÷ revenue (null when no revenue). */
export function foodCostSeries(invoices: Invoice[], revenue: RevenueEntry[]) {
  return weeklySeries(invoices, revenue).map((w) => ({
    weekStart: w.weekStart,
    pct: w.revenue > 0 ? (w.expenses / w.revenue) * 100 : null,
  }))
}

/** Top ingredients by total spend across approved invoices (Pareto). */
export function ingredientSpend(
  invoices: Invoice[],
  limit = 10,
): { ingredientId: string | null; name: string; total: number }[] {
  const map = new Map<string, { ingredientId: string | null; name: string; total: number }>()
  for (const inv of invoices) {
    if (!isFoodInvoice(inv)) continue
    for (const line of inv.lineItems) {
      const key = line.ingredientId ?? foldName(line.name)
      const row = map.get(key) ?? { ingredientId: line.ingredientId ?? null, name: line.name, total: 0 }
      row.total += line.total
      map.set(key, row)
    }
  }
  return [...map.values()].sort((a, b) => b.total - a.total).slice(0, limit)
}

/** Money currently sitting in the walk-in: Σ qty × last price. */
export function pantryValue(ingredients: Ingredient[]): number {
  return ingredients.reduce(
    (s, i) => s + Math.max(0, i.theoreticalQty) * (i.lastUnitPrice ?? 0),
    0,
  )
}

// ── Detail-page charts ──────────────────────────────────────────────

/** The shared 8-week window used by detail-page charts and spendTree. */
const WINDOW_DAYS = 56

function weekIndex(dateStr: string | null, weeks: WeekPoint[]): number {
  if (!dateStr) return -1
  const t = new Date(dateStr + 'T12:00:00').getTime()
  return weeks.findIndex((w) => {
    const start = new Date(w.weekStart + 'T00:00:00').getTime()
    return t >= start && t < start + 7 * DAY_MS
  })
}

/** Units of one dish sold per week (8 weeks) for the dish detail bars. */
export function unitsSoldWeekly(revenue: RevenueEntry[], menuItemId: string): number[] {
  const weeks = weeklySeries([], [])
  const out = weeks.map(() => 0)
  for (const r of revenue) {
    const i = weekIndex(r.date, weeks)
    if (i < 0) continue
    for (const s of r.itemsSold) if (s.menuItemId === menuItemId) out[i] += s.qty
  }
  return out
}

/** One vendor's spend per week (8 weeks) for the vendor detail bars. */
export function vendorWeeklyTotals(invoices: Invoice[], vendorKey: string): number[] {
  const weeks = weeklySeries([], [])
  const out = weeks.map(() => 0)
  for (const inv of invoices) {
    if (!isFoodInvoice(inv) || !inv.vendorName || inv.total == null) continue
    if (normalizeName(inv.vendorName) !== vendorKey) continue
    const i = weekIndex(inv.invoiceDate, weeks)
    if (i >= 0) out[i] += inv.total
  }
  return out
}

/** Purchased quantity per week (8 weeks), in the ingredient's stock unit. */
export function ingredientWeeklyQty(invoices: Invoice[], ing: Ingredient): number[] {
  const weeks = weeklySeries([], [])
  const out = weeks.map(() => 0)
  for (const r of receiptsForIngredient(invoices, ing)) {
    const i = weekIndex(r.date, weeks)
    if (i < 0) continue
    const converted = r.unit === ing.unit ? r.qty : convertQty(r.qty, r.unit, ing.unit)
    if (converted != null) out[i] += converted
  }
  return out
}

export interface BreakdownRow {
  ingredient?: Ingredient
  sub?: MenuItem // sub-recipe component
  labor?: boolean // the dish's own prep time (qty = minutes)
  qty: number
  unit?: Unit
  cost: number
  share: number
}

/** Each recipe component's share of the plate cost, largest first.
 * With a labor rate set, the dish's own prep time appears as one more
 * row (sub-recipes already include theirs in their cost). */
export function costBreakdown(
  item: MenuItem,
  ingredients: Map<string, Ingredient>,
  menuItems: Map<string, MenuItem> = new Map(),
  laborRatePerHour = 0,
): BreakdownRow[] {
  const rows = item.recipe
    .map((line): Omit<BreakdownRow, 'share'> | null => {
      if (line.subItemId) {
        const sub = menuItems.get(line.subItemId)
        const mult = sub ? subMultiplier(line, sub) : null
        if (!sub || mult == null || sub.id === item.id) return null
        const subCost = plateCost(sub, ingredients, menuItems, laborRatePerHour, new Set([item.id, sub.id])).cost
        // unit set = an amount of the prep's yield; none = batches/portions
        return { sub, qty: line.qty, unit: line.unit, cost: subCost * mult }
      }
      const ing = line.ingredientId ? ingredients.get(line.ingredientId) : undefined
      if (!ing) return null
      return {
        ingredient: ing,
        qty: line.qty,
        unit: line.unit ?? ing.unit, // display in the authored unit
        cost: (ing.lastUnitPrice ?? 0) * qtyInStockUnit(line, ing),
      }
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
  const labor = prepLaborCost(item, laborRatePerHour)
  if (labor > 0) rows.push({ labor: true, qty: item.prepMinutes ?? 0, cost: labor })
  const total = rows.reduce((s, r) => s + r.cost, 0) || 1
  return rows
    .map((r) => ({ ...r, share: r.cost / total }))
    .sort((a, b) => b.cost - a.cost)
}

// ── Spend drill-down (Dashboard → Categories tab) ───────────────────

export type SpendNodeKind =
  | 'root'
  | 'food' // all approved food invoices ("raw materials")
  | 'tag' // one expense tag (staff, rent, marketing…)
  | 'category' // food category (meat, produce…)
  | 'subcategory' // second taxonomy level (beef, fruit…)
  | 'uncategorized' // lines/entries with no finer classification
  | 'ingredient' // leaf: one purchased product
  | 'vendor' // leaf: one payee under an expense tag

export interface SpendNode {
  /** Stable key within its parent (category id, tagKey, nameKey…). */
  key: string
  kind: SpendNodeKind
  /** User-data label (tag/vendor/ingredient). Null → localize from kind+key. */
  label: string | null
  total: number
  children: SpendNode[]
  /** Ingredient leaves resolved to a pantry item — enables deep links. */
  ingredientId?: string | null
}

const node = (
  key: string,
  kind: SpendNodeKind,
  label: string | null,
  total: number,
  children: SpendNode[] = [],
): SpendNode => ({ key, kind, label, total, children })

const byTotalDesc = (nodes: SpendNode[]): SpendNode[] =>
  nodes.filter((n) => n.total > 0).sort((a, b) => b.total - a.total)

/**
 * The full spend hierarchy over the 8-week window, aggregated at read
 * time from collections the dashboard already holds — zero extra reads
 * or writes, and never stale:
 *
 *   root ─ food ─ category ─ subcategory ─ ingredient
 *        └ tag ─ vendor
 *
 * Classification joins each line to its pantry ingredient when resolved:
 * the chef's CURRENT category wins over OCR's frozen guess, so a
 * correction re-buckets past spend retroactively. A null ingredient
 * subcategory means "unclassified" (not "cleared"), so the line's own
 * OCR guess still fills in — same semantics as the approval backfill.
 */
export function spendTree(
  invoices: Invoice[],
  expenses: ExpenseEntry[],
  ingredientsById: Map<string, Ingredient>,
): SpendNode {
  const cutoff = new Date(Date.now() - WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10)

  interface IngAcc { label: string; total: number; ingredientId: string | null }
  // Subcategory buckets keyed by sub ('' = unclassified within the category).
  const cats = new Map<Category, Map<string, Map<string, IngAcc>>>()
  let foodTotal = 0
  let linesTotal = 0

  for (const inv of invoices) {
    if (!isFoodInvoice(inv)) continue
    const date = inv.invoiceDate ?? new Date(inv.createdAt).toISOString().slice(0, 10)
    if (date < cutoff) continue
    foodTotal += inv.total ?? 0
    for (const line of inv.lineItems) {
      if (line.total <= 0) continue
      const ing = line.ingredientId ? ingredientsById.get(line.ingredientId) : undefined
      const cat = ing?.category ?? line.category ?? 'other'
      const sub = pairSubcategory(cat, ing?.subcategory ?? line.subcategory) ?? ''
      const ingKey = line.ingredientId ?? foldName(line.name)

      let subs = cats.get(cat)
      if (!subs) cats.set(cat, (subs = new Map()))
      let ings = subs.get(sub)
      if (!ings) subs.set(sub, (ings = new Map()))
      const acc = ings.get(ingKey) ?? {
        label: ing?.name ?? line.name,
        total: 0,
        ingredientId: line.ingredientId ?? null,
      }
      acc.total += line.total
      ings.set(ingKey, acc)
      linesTotal += line.total
    }
  }

  const ingredientNodes = (ings: Map<string, IngAcc>): SpendNode[] =>
    byTotalDesc(
      [...ings.entries()].map(([key, i]) => ({
        ...node(key, 'ingredient', i.label, i.total),
        ingredientId: i.ingredientId,
      })),
    )

  const categoryNodes = [...cats.entries()].map(([cat, subs]) => {
    // Categories without a sub-vocabulary ("other") drill straight to
    // ingredients (every line lands in the '' bucket there); the rest
    // group by subcategory, with an explicit bucket for lines nobody
    // has classified yet.
    const children =
      SUBCATEGORIES[cat].length === 0
        ? ingredientNodes(subs.get('') ?? new Map())
        : byTotalDesc(
            [...subs.entries()].map(([sub, ings]) => {
              const kids = ingredientNodes(ings)
              const total = kids.reduce((s, k) => s + k.total, 0)
              return sub === ''
                ? node('__uncat', 'uncategorized', null, total, kids)
                : node(sub, 'subcategory', null, total, kids)
            }),
          )
    const total = children.reduce((s, c) => s + c.total, 0)
    return node(cat, 'category', null, total, children)
  })

  // Approval recomputes invoice totals from the lines, so the two sums
  // normally agree; any legacy remainder surfaces honestly as one slice,
  // ranked with the rest. The food total is Σ children BY CONSTRUCTION
  // so slice shares always sum to 100%.
  if (foodTotal - linesTotal > 0.5) {
    categoryNodes.push(node('__uncat', 'uncategorized', null, foodTotal - linesTotal))
  }
  const foodChildren = byTotalDesc(categoryNodes)
  // '__food' (not a normalizable string) so no user expense tag — e.g.
  // one literally named "Food" — can collide with it among root children.
  const food = node(
    '__food',
    'food',
    null,
    foodChildren.reduce((s, c) => s + c.total, 0),
    foodChildren,
  )

  const tags = new Map<string, { label: string; total: number; vendors: Map<string, { label: string | null; total: number }> }>()
  for (const e of expenses) {
    if (e.date < cutoff) continue
    let tag = tags.get(e.tagKey)
    if (!tag) tags.set(e.tagKey, (tag = { label: e.tag, total: 0, vendors: new Map() }))
    tag.total += e.amount
    const vKey = e.vendorName ? normalizeName(e.vendorName) : ''
    const v = tag.vendors.get(vKey) ?? { label: e.vendorName ?? null, total: 0 }
    v.total += e.amount
    tag.vendors.set(vKey, v)
  }
  const tagNodes = [...tags.entries()].map(([key, tag]) =>
    node(
      key,
      'tag',
      tag.label,
      tag.total,
      byTotalDesc(
        [...tag.vendors.entries()].map(([vKey, v]) =>
          vKey === ''
            ? node('__uncat', 'uncategorized', null, v.total)
            : node(vKey, 'vendor', v.label, v.total),
        ),
      ),
    ),
  )

  const children = byTotalDesc([food, ...tagNodes])
  return node('root', 'root', null, children.reduce((s, c) => s + c.total, 0), children)
}

// ── Grocery list ────────────────────────────────────────────────────

export interface GroceryRow {
  ingredient: Ingredient
  usagePerDay: number
  daysLeft: number // Infinity when there's stock but no usage data
  suggestedQty: number
}

/**
 * "Generate grocery list": theoretical stock vs the usage rate implied
 * by dishes sold in the last `usageWindow` days. Suggests enough of
 * each ingredient to cover `coverDays` of service. A reference list to
 * walk into negotiations with — not a purchase order.
 */
export function groceryList(
  ingredients: Ingredient[],
  menuItems: MenuItem[],
  revenue: RevenueEntry[],
  coverDays = 7,
  usageWindow = 14,
): GroceryRow[] {
  const cutoff = new Date(Date.now() - usageWindow * DAY_MS).toISOString().slice(0, 10)
  // Accumulate raw usage entries (sub-recipes expand); converted
  // per-ingredient below — recipe lines may be authored in a different
  // compatible unit than the stock.
  const menuMap = new Map(menuItems.map((m) => [m.id, m]))
  const used = new Map<string, { qty: number; unit?: Unit }[]>()
  for (const r of revenue) {
    if (r.date < cutoff) continue
    for (const [ingredientId, entries] of expandUsage(r.itemsSold, menuMap)) {
      used.set(ingredientId, [...(used.get(ingredientId) ?? []), ...entries])
    }
  }

  const rows: GroceryRow[] = []
  for (const ing of ingredients) {
    const totalUsed = (used.get(ing.id) ?? []).reduce(
      (s, e) => s + qtyInStockUnit(e, ing),
      0,
    )
    const usagePerDay = totalUsed / usageWindow
    const stock = Math.max(0, ing.theoreticalQty)
    const daysLeft = usagePerDay > 0 ? stock / usagePerDay : Infinity
    // Needs buying if it won't cover the window — or it's flat out.
    if (usagePerDay > 0 && daysLeft < coverDays) {
      rows.push({
        ingredient: ing,
        usagePerDay,
        daysLeft,
        suggestedQty: Math.max(0.5, +(usagePerDay * coverDays - stock).toFixed(1)),
      })
    } else if (usagePerDay === 0 && ing.theoreticalQty <= 0 && ing.lastUnitPrice != null) {
      // Out of stock with no sales signal — surface it, let the chef decide.
      rows.push({ ingredient: ing, usagePerDay: 0, daysLeft: 0, suggestedQty: 0 })
    }
  }
  return rows.sort((a, b) => a.daysLeft - b.daysLeft)
}
