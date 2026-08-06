// Pure domain math — no I/O, no Vue. Everything the Pulse, Menu and
// Pantry pages derive client-side from the fetched collections.

import type { Category, ExpenseEntry, Ingredient, Invoice, MenuItem, RevenueEntry, Unit } from './types'
import { convertQty } from './units'
import { normalizeName } from '@teremu/shared'

export { normalizeName }

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
 * handled are excluded entirely. Price differences on shared line items
 * (>2%) surface as diffs — that's the billing-error catch.
 */
export function reconcileDeliveryNotes(invoices: Invoice[]): ReconciliationRow[] {
  const notes = invoices.filter(
    (i) =>
      i.docType === 'delivery_note' &&
      !i.reconHandled &&
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

/** Recipe qty expressed in the ingredient's stock unit (price basis). */
function qtyInStockUnit(line: { qty: number; unit?: Unit }, ing: Ingredient): number {
  if (!line.unit) return line.qty // legacy: qty already in stock units
  return convertQty(line.qty, line.unit, ing.unit) ?? line.qty
}

/** Labor cost of one plate's prep time at the restaurant's rate. */
const prepLaborCost = (item: MenuItem, laborRatePerHour: number): number =>
  ((item.prepMinutes ?? 0) / 60) * laborRatePerHour

/**
 * Current plate cost of a dish from live (rolling) ingredient prices,
 * plus prep-time labor when the restaurant has a labor rate set
 * (cost = foodCost + laborCost). Sub-recipe lines ("side of rice"
 * inside "salmon with rice") expand recursively — their prep time
 * counts too — cycle-guarded per branch, depth-capped.
 */
export function plateCost(
  item: MenuItem,
  ingredients: Map<string, Ingredient>,
  menuItems: Map<string, MenuItem> = new Map(),
  laborRatePerHour = 0,
  path: Set<string> = new Set([item.id]),
): { cost: number; foodCost: number; laborCost: number; missing: boolean } {
  let foodCost = 0
  let laborCost = prepLaborCost(item, laborRatePerHour)
  let missing = false
  for (const line of item.recipe) {
    if (line.subItemId) {
      const sub = menuItems.get(line.subItemId)
      if (!sub || path.has(sub.id) || path.size > 4) {
        missing = true
        continue
      }
      const rec = plateCost(sub, ingredients, menuItems, laborRatePerHour, new Set([...path, sub.id]))
      foodCost += rec.foodCost * line.qty
      laborCost += rec.laborCost * line.qty
      missing = missing || rec.missing
      continue
    }
    const ing = line.ingredientId ? ingredients.get(line.ingredientId) : undefined
    if (!ing || ing.lastUnitPrice == null) {
      missing = true
      continue
    }
    foodCost += ing.lastUnitPrice * qtyInStockUnit(line, ing)
  }
  return { cost: foodCost + laborCost, foodCost, laborCost, missing }
}

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
  ingredientNames: string[]
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
  type Acc = Omit<VendorSummary, 'ingredientNames' | 'categories' | 'tags'> & {
    names: Set<string>
    cats: Set<Category>
    tagSet: Set<string>
  }
  const map = new Map<string, Acc>()
  const acc = (key: string, name: string): Acc => {
    let v = map.get(key)
    if (!v) {
      v = { key, name, invoiceCount: 0, totalSpend: 0, lastDate: null, names: new Set(), cats: new Set(), tagSet: new Set() }
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
      v.names.add(line.name)
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
    .map(({ names, cats, tagSet, ...v }) => ({
      ...v,
      ingredientNames: [...names],
      categories: [...cats],
      tags: [...tagSet],
    }))
    .sort((a, b) => b.totalSpend - a.totalSpend)
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

/**
 * Every approved purchase of one ingredient, newest first. Matches by
 * the resolved ingredientId; falls back to normalized-name matching for
 * invoices approved before ids were stored.
 */
export function receiptsForIngredient(invoices: Invoice[], ing: Ingredient): ReceiptLine[] {
  const rows: ReceiptLine[] = []
  for (const inv of invoices) {
    if (!isFoodInvoice(inv)) continue
    for (const line of inv.lineItems) {
      const match = line.ingredientId
        ? line.ingredientId === ing.id
        : normalizeName(line.name) === ing.nameKey
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

/** Dishes whose recipes include the ingredient (qty in recipe units). */
export function dishesUsing(menuItems: MenuItem[], ingredientId: string) {
  return menuItems
    .filter((m) => m.active && m.recipe.some((r) => r.ingredientId === ingredientId))
    .map((m) => {
      const line = m.recipe.find((r) => r.ingredientId === ingredientId)!
      return { item: m, qty: line.qty, unit: line.unit }
    })
}

/**
 * Expand recipes (sub-recipes included, cycle-guarded) into raw
 * ingredient usage entries — shared by pantry-usage math and the
 * production planner.
 */
function expandUsage(
  selections: { menuItemId: string; qty: number }[],
  menuItems: Map<string, MenuItem>,
): Map<string, { qty: number; unit?: Unit }[]> {
  const raw = new Map<string, { qty: number; unit?: Unit }[]>()
  const walk = (menuItemId: string, multiplier: number, path: Set<string>, depth: number): void => {
    if (depth > 4) return
    const item = menuItems.get(menuItemId)
    if (!item) return
    for (const line of item.recipe) {
      if (line.subItemId) {
        if (!path.has(line.subItemId)) {
          walk(line.subItemId, multiplier * line.qty, new Set([...path, line.subItemId]), depth + 1)
        }
        continue
      }
      if (!line.ingredientId) continue
      raw.set(line.ingredientId, [
        ...(raw.get(line.ingredientId) ?? []),
        { qty: line.qty * multiplier, unit: line.unit },
      ])
    }
  }
  for (const s of selections) {
    if (s.qty > 0) walk(s.menuItemId, s.qty, new Set([s.menuItemId]), 0)
  }
  return raw
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
    .filter((m) => m.active)
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
      const key = line.ingredientId ?? normalizeName(line.name)
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

/** The shared 8-week window used by detail-page charts and spendByTag. */
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
        if (!sub || sub.id === item.id) return null
        const subCost = plateCost(sub, ingredients, menuItems, laborRatePerHour, new Set([item.id, sub.id])).cost
        return { sub, qty: line.qty, cost: subCost * line.qty }
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

// ── Tagged expenses ─────────────────────────────────────────────────

/** Spend per category over the 8-week window: food (invoices) + tags. */
export function spendByTag(
  invoices: Invoice[],
  expenses: ExpenseEntry[],
): { key: string; tag: string | null; total: number }[] {
  const cutoff = new Date(Date.now() - WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10)
  let food = 0
  for (const inv of invoices) {
    if (inv.status === 'approved' && inv.total != null && (inv.invoiceDate ?? '') >= cutoff)
      food += inv.total
  }
  const map = new Map<string, { key: string; tag: string; total: number }>()
  for (const e of expenses) {
    if (e.date < cutoff) continue
    const row = map.get(e.tagKey) ?? { key: e.tagKey, tag: e.tag, total: 0 }
    row.total += e.amount
    map.set(e.tagKey, row)
  }
  const rows: { key: string; tag: string | null; total: number }[] = [
    { key: 'food', tag: null, total: food }, // tag null = "food" (localized by the caller)
    ...map.values(),
  ]
  return rows.filter((r) => r.total > 0).sort((a, b) => b.total - a.total)
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
