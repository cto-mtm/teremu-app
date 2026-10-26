<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { currencySymbol } from '../i18n'
import { amountField, dateOrderFor, decimalMarkForCurrency, detectDelimiter, parseAmount, parseDate, splitCsvLine } from '../lib/csv'
import { useInvoicesStore } from '../stores/invoices'
import { useKitchenStore } from '../stores/kitchen'
import { useAuthStore } from '../stores/auth'
import { todayFor } from '../lib/dates'
import { useQueryAction } from '../composables/useQueryAction'
import {
  actualMarginPct,
  foodCostSeries,
  ingredientSpend,
  menuEngineering,
  pantryValue,
  priceChangePct,
  priceHistory,
  realtimeSpend,
  vendorWeeklySpend,
  vendorKey,
  weeklySeries,
} from '../lib/domain'
import type { ExpenseEntry, Ingredient, MenuItem, RevenueEntry } from '../lib/types'
import { CHART_COLORS, CHART_REST_COLOR, QUADRANT_COLORS } from '../lib/palette'
import BaseButton from '../components/BaseButton.vue'
import InfoButton from '../components/InfoButton.vue'
import MenuMatrix from '../components/MenuMatrix.vue'
import PageLoader from '../components/PageLoader.vue'
import ProvidersPanel from '../components/ProvidersPanel.vue'
import SpendDrilldown from '../components/SpendDrilldown.vue'
import Sparkline from '../components/Sparkline.vue'

const { t, n, d, locale } = useI18n()
const route = useRoute()
const router = useRouter()
const invoicesStore = useInvoicesStore()
const kitchen = useKitchenStore()
const auth = useAuthStore()
const canEdit = computed(() => auth.can('finance', 'edit'))
// Restaurant labor rate (Settings) — 0/unset keeps costs ingredients-only.
const laborRate = computed(() => auth.profile?.laborRatePerHour ?? 0)

// ── Dashboard tabs. Local state, NOT a router navigation: a panel
// switch is within-page UI (docs/animations.md draws that line), so it
// must not pay the auth guard, the scroll reset, or a full-page
// startViewTransition snapshot. The URL still mirrors the tab for deep
// links — read once on load, written back via history.replaceState.
type Tab = 'overview' | 'categories' | 'providers'
const tabs = computed<Tab[]>(() =>
  auth.can('vendors') ? ['overview', 'categories', 'providers'] : ['overview', 'categories'],
)
const initialTab = route.query.tab as Tab
const tab = ref<Tab>(tabs.value.includes(initialTab) ? initialTab : 'overview')
// A tab arriving by query while mounted (the assistant's openScreen handoff
// from Pulse to Pulse) switches too; the watcher below mirrors it back.
watch(
  () => route.query.tab,
  (v) => {
    if (typeof v === 'string' && tabs.value.includes(v as Tab)) tab.value = v as Tab
  },
)
// Panels lazy-mount on first visit and stay alive (v-show) afterwards,
// so the drill position and computed caches survive tab switches.
const seen = ref<Record<Tab, boolean>>({ overview: true, categories: false, providers: false })
watch(
  tab,
  (v) => {
    seen.value[v] = true
    const url = new URL(window.location.href)
    if (v === 'overview') url.searchParams.delete('tab')
    else url.searchParams.set('tab', v)
    history.replaceState(history.state, '', url)
  },
  { immediate: true },
)

// ── Spend by delivery date (facturado + recibido) ─────────────────
// The weekly charts date food spend by the day the goods landed:
// approved albaranes no factura covers yet are added, and covered ones
// keep their own week while the factura keeps only what they do not
// explain. The breakdowns (Top ingredients, Categories) use the full
// factura lines plus the pending notes, so no line is ever lost to the
// re-dating; reconciliation runs once here and the Categories panel is
// handed its documents. Price history & alerts stay on facturas —
// albarán prices are estimates, not payments — and so do the vendor
// pages.
const realtime = computed(() => realtimeSpend(invoicesStore.invoices, kitchen.ingredientMap))

// ── Expenses vs revenue (8 weeks) — includes tagged non-food spend ──
const series = computed(() => weeklySeries(realtime.value.seriesDocs, kitchen.revenue, kitchen.expenses))
const thisWeek = computed(() => series.value[series.value.length - 1])

const W = 640
const H = 200
const PAD = 8
const maxY = computed(() => Math.max(1, ...series.value.flatMap((p) => [p.expenses, p.revenue])))
function points(key: 'expenses' | 'revenue'): string {
  const pts = series.value
  return pts
    .map((p, i) => {
      const x = PAD + (i * (W - 2 * PAD)) / Math.max(1, pts.length - 1)
      const y = H - PAD - (p[key] / maxY.value) * (H - 2 * PAD)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}

// ── Food-cost % with target band ────────────────────────────────
const foodCost = computed(() => foodCostSeries(realtime.value.seriesDocs, kitchen.revenue))
const fcThisWeek = computed(() => foodCost.value[foodCost.value.length - 1]?.pct ?? null)
const FC = { w: 300, h: 150, pad: 8 }
const fcMax = computed(() => Math.max(50, ...foodCost.value.map((p) => p.pct ?? 0)) * 1.15)
const fcY = (pct: number) => FC.h - FC.pad - (pct / fcMax.value) * (FC.h - 2 * FC.pad)
const fcX = (i: number) => FC.pad + (i * (FC.w - 2 * FC.pad)) / Math.max(1, foodCost.value.length - 1)
const fcPoints = computed(() =>
  foodCost.value
    .map((p, i) => (p.pct == null ? null : `${fcX(i).toFixed(1)},${fcY(p.pct).toFixed(1)}`))
    .filter(Boolean)
    .join(' '),
)

// Every-other-week x-axis ticks for the two half-width charts.
const weekTicks = computed(() => series.value.filter((_, i) => i % 2 === 0))

// ── Vendor spend, stacked weekly (click a segment → vendor page) ─
const VENDOR_COLORS = [...CHART_COLORS.slice(0, 4), CHART_REST_COLOR]
const vendorSpend = computed(() => vendorWeeklySpend(realtime.value.seriesDocs))
const vendorLegend = computed(() =>
  vendorSpend.value.vendors.map((v, i) => ({ ...v, color: VENDOR_COLORS[i % VENDOR_COLORS.length] })),
)
const VS = { w: 300, h: 150, pad: 8 }
const vendorRects = computed(() => {
  const weeks = vendorSpend.value.weeks
  const max = Math.max(1, ...weeks.map((w) => w.total))
  const slot = (VS.w - 2 * VS.pad) / Math.max(1, weeks.length)
  const barW = slot * 0.55
  const rects: { x: number; y: number; h: number; color: string; key: string; name: string; amount: number }[] = []
  weeks.forEach((w, i) => {
    let yCursor = VS.h - VS.pad
    w.segments.forEach((seg, si) => {
      if (seg.amount <= 0) return
      const h = ((VS.h - 2 * VS.pad) * seg.amount) / max
      yCursor -= h
      rects.push({
        x: VS.pad + i * slot + (slot - barW) / 2,
        y: yCursor,
        h,
        color: VENDOR_COLORS[si % VENDOR_COLORS.length],
        key: seg.key,
        name: seg.name,
        amount: seg.amount,
      })
    })
  })
  return { rects, barW, max }
})

// ── Menu engineering matrix (MenuMatrix: zoom, tap → detail) ────
const QUADRANTS = ['star', 'plowhorse', 'puzzle', 'dog'] as const
const engineering = computed(() =>
  menuEngineering(kitchen.menuItems, kitchen.revenue, kitchen.ingredientMap, laborRate.value, auth.tax),
)

// ── Price watch: most volatile ingredients, with sparklines ─────
const priceWatch = computed(() =>
  kitchen.pantry
    .map((ing) => ({ ing, hist: priceHistory(invoicesStore.invoices, ing), change: priceChangePct(ing) }))
    .filter((x) => x.hist.length >= 2)
    .sort((a, b) => Math.abs(b.change ?? 0) - Math.abs(a.change ?? 0))
    .slice(0, 4),
)

// ── Pareto: top ingredients by spend ────────────────────────────
const topSpend = computed(() => ingredientSpend(realtime.value.breakdownDocs, 8))
const topSpendMax = computed(() => topSpend.value[0]?.total ?? 1)

// ── Stat cards ──────────────────────────────────────────────────
const stockValue = computed(() => pantryValue(kitchen.ingredients))

// ── Alerts ──────────────────────────────────────────────────────
const priceAlerts = computed(() => {
  const list: { ing: Ingredient; change: number }[] = []
  for (const ing of kitchen.pantry) {
    const change = priceChangePct(ing)
    if (change != null && Math.abs(change) >= 5) list.push({ ing, change })
  }
  return list.sort((a, b) => Math.abs(b.change) - Math.abs(a.change)).slice(0, 4)
})

const menuMap = computed(() => new Map(kitchen.menuItems.map((m) => [m.id, m])))

const marginAlerts = computed(() => {
  const list: { m: MenuItem; margin: number; cost: number }[] = []
  for (const m of kitchen.dishes) {
    const { margin, cost } = actualMarginPct(m, kitchen.ingredientMap, menuMap.value, laborRate.value, auth.tax)
    if (margin != null && margin < m.targetMarginPct) list.push({ m, margin, cost })
  }
  return list.slice(0, 3)
})

// ── Recent entries (revenue + expenses) with edit/delete ────────
type Entry =
  | { kind: 'revenue'; id: string; date: string; amount: number; raw: RevenueEntry }
  | { kind: 'expense'; id: string; date: string; amount: number; raw: ExpenseEntry }

const entries = computed<Entry[]>(() => {
  const rev = kitchen.revenue.map(
    (r): Entry => ({ kind: 'revenue', id: r.id, date: r.date, amount: r.amount, raw: r }),
  )
  const exp = kitchen.expenses.map(
    (e): Entry => ({ kind: 'expense', id: e.id, date: e.date, amount: e.amount, raw: e }),
  )
  return [...rev, ...exp].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8)
})

/** POS entries are rebuilt from the POS's own orders, so they are read-only here. */
const isPos = (en: Entry): boolean => en.kind === 'revenue' && (en.raw as RevenueEntry).source === 'pos'

/** The POS day's sales that matched no dish, when there are any. */
function unattributedOf(en: Entry): { amount: number; count: number; provider: string } | null {
  if (!isPos(en)) return null
  const r = en.raw as RevenueEntry
  return r.unattributed && r.unattributed.count > 0 ? { ...r.unattributed, provider: r.provider ?? 'square' } : null
}

function entryLabel(en: Entry): string {
  if (isPos(en)) return t('pulse.posRevenue')
  if (en.kind === 'revenue') return t('pulse.legendRevenue')
  const e = en.raw as ExpenseEntry
  return e.vendorName ? `${e.tag} · ${e.vendorName}` : e.tag
}

function editEntry(en: Entry): void {
  if (en.kind === 'revenue') {
    const r = en.raw as RevenueEntry
    editingRevenueId.value = r.id
    date.value = r.date
    amount.value = String(r.amount)
    sold.value = Object.fromEntries(r.itemsSold.map((s) => [s.menuItemId, String(s.qty)]))
    showSheet.value = true
  } else {
    const e = en.raw as ExpenseEntry
    editingExpenseId.value = e.id
    expDate.value = e.date
    expAmount.value = String(e.amount)
    expTag.value = e.tag
    expVendor.value = e.vendorName ?? ''
    expNote.value = e.note ?? ''
    showExpense.value = true
  }
}

async function removeEntry(en: Entry): Promise<void> {
  if (!confirm(t('common.action.confirmDelete'))) return
  if (en.kind === 'revenue') await kitchen.deleteRevenue(en.id)
  else await kitchen.deleteExpense(en.id)
}

// ── Expense entry sheet (tagged, non-food) ──────────────────────
const showExpense = ref(false)
const editingExpenseId = ref<string | null>(null)
const expDate = ref(todayFor(auth.profile?.timezone))
const expAmount = ref('')
const expTag = ref('')
const expVendor = ref('')
const expNote = ref('')
const expBusy = ref(false)

async function saveExpense(): Promise<void> {
  expBusy.value = true
  const args = [
    expDate.value,
    Number(expAmount.value) || 0,
    expTag.value.trim(),
    expNote.value.trim() || undefined,
    expVendor.value.trim() || undefined,
  ] as const
  const ok = editingExpenseId.value
    ? await kitchen.updateExpense(editingExpenseId.value, ...args)
    : await kitchen.addExpense(...args)
  expBusy.value = false
  if (ok) {
    showExpense.value = false
    editingExpenseId.value = null
    expAmount.value = ''
    expTag.value = ''
    expVendor.value = ''
    expNote.value = ''
  } else {
    alert(
      kitchen.error?.includes('expense_tag_limit')
        ? t('pulse.expenseSheet.tagLimit')
        : t('pulse.expenseSheet.saveFailed'),
    )
  }
}

// ── Revenue entry sheet ─────────────────────────────────────────
const showSheet = ref(false)
const editingRevenueId = ref<string | null>(null)
const date = ref(todayFor(auth.profile?.timezone))
const amount = ref('')
const sold = ref<Record<string, string>>({})
const busy = ref(false)

async function saveRevenue(): Promise<void> {
  busy.value = true
  const itemsSold = Object.entries(sold.value)
    .map(([menuItemId, qty]) => ({ menuItemId, qty: Number(qty) || 0 }))
    .filter((x) => x.qty > 0)
  const ok = editingRevenueId.value
    ? await kitchen.updateRevenue(editingRevenueId.value, date.value, Number(amount.value) || 0, itemsSold)
    : await kitchen.addRevenue(date.value, Number(amount.value) || 0, itemsSold)
  busy.value = false
  if (ok) {
    showSheet.value = false
    editingRevenueId.value = null
    amount.value = ''
    sold.value = {}
  } else {
    alert(kitchen.error?.includes('pos_covers_date') ? t('pulse.sheet.posCoversDate') : t('pulse.sheet.saveFailed'))
  }
}

// ── CSV import: daily sales totals (date,amount), POS-lite ──────
const csvInput = ref<HTMLInputElement | null>(null)
const csvBusy = ref(false)

async function importCsv(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (csvInput.value) csvInput.value.value = ''
  if (!file) return
  csvBusy.value = true
  try {
    const text = await file.text()
    const delimiter = detectDelimiter(text)
    // A POS export follows the restaurant, not the reader: dates in the
    // country's order, decimals in the base currency's (B2).
    const decimal = decimalMarkForCurrency(auth.profile?.currency)
    const dateOrder = auth.profile?.countryProfile?.dateOrder ?? dateOrderFor(locale.value)
    const existing = new Set(kitchen.revenue.map((r) => r.date))
    let ok = 0
    let skipped = 0
    let bad = 0
    let firstRow = true
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line) continue
      const fields = splitCsvLine(line, delimiter)
      const dateStr = parseDate(fields[0] ?? '', dateOrder)
      const header = firstRow
      firstRow = false
      if (!dateStr) {
        // A first line that isn't data is the header, whatever it says
        // ("fecha;importe", "Día;Ventas"…); anything later is malformed.
        if (!header) bad += 1
        continue
      }
      const amount = parseAmount(amountField(fields, delimiter), decimal)
      if (!Number.isFinite(amount) || amount <= 0) {
        bad += 1
        continue
      }
      if (existing.has(dateStr)) {
        skipped += 1
        continue
      }
      const created = await kitchen.addRevenue(dateStr, +amount.toFixed(2), [])
      if (created) {
        existing.add(dateStr)
        ok += 1
      } else {
        bad += 1
      }
    }
    alert(t('pulse.csv.done', { ok, skipped, bad }))
  } catch {
    alert(t('pulse.csv.failed'))
  } finally {
    csvBusy.value = false
  }
}

// Deep links (the assistant's openScreen handoff): /?sheet=revenue|expense
// opens the entry sheet for members who may log (the tab param stays).
useQueryAction('sheet', {
  revenue: () => {
    if (canEdit.value) openNewRevenue()
  },
  expense: () => {
    if (canEdit.value) openNewExpense()
  },
})

// Fresh forms for "+" buttons; closing a sheet drops any edit context.
function openNewRevenue(): void {
  editingRevenueId.value = null
  date.value = todayFor(auth.profile?.timezone)
  amount.value = ''
  sold.value = {}
  showSheet.value = true
}
function openNewExpense(): void {
  editingExpenseId.value = null
  expDate.value = todayFor(auth.profile?.timezone)
  expAmount.value = ''
  expTag.value = ''
  expVendor.value = ''
  expNote.value = ''
  showExpense.value = true
}
watch(showSheet, (open) => {
  if (!open) editingRevenueId.value = null
})
watch(showExpense, (open) => {
  if (!open) editingExpenseId.value = null
})
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <h1 class="text-xl font-bold">{{ t('pulse.title') }}</h1>
      <div class="flex flex-wrap gap-2">
        <template v-if="canEdit">
          <BaseButton variant="ghost" :disabled="csvBusy" :title="t('pulse.csv.hint')" @click="csvInput?.click()">
            {{ csvBusy ? t('common.action.saving') : t('pulse.csv.cta') }}
          </BaseButton>
          <input ref="csvInput" type="file" accept=".csv,text/csv" hidden @change="importCsv" />
          <BaseButton variant="ghost" @click="openNewExpense">+ {{ t('pulse.logExpense') }}</BaseButton>
          <BaseButton variant="ghost" @click="openNewRevenue">+ {{ t('pulse.logRevenue') }}</BaseButton>
        </template>
        <RouterLink v-if="auth.can('scan')" to="/scan" class="btn-primary">{{ t('pulse.scanCta') }}</RouterLink>
      </div>
    </div>

    <!-- Tab strip: Overview / Categories / Providers -->
    <div class="flex gap-1 rounded-xl bg-gray-100 p-1 sm:inline-flex" role="tablist" :aria-label="t('pulse.title')">
      <button
        v-for="tb in tabs"
        :key="tb"
        role="tab"
        :aria-selected="tab === tb"
        class="flex-1 rounded-lg px-3 py-1.5 text-sm font-medium sm:flex-none"
        :class="tab === tb ? 'bg-white text-ink shadow-sm' : 'text-smoke hover:text-ink'"
        @click="tab = tb"
      >
        {{ t('pulse.tabs.' + tb) }}
      </button>
    </div>

    <!-- Loading skeleton -->
    <PageLoader v-if="kitchen.loading && !kitchen.revenue.length" />

    <template v-else>

    <!-- Categories: hierarchical spend pie with breadcrumb drill-down -->
    <SpendDrilldown v-if="seen.categories" v-show="tab === 'categories'" :docs="realtime.breakdownDocs" />

    <!-- Providers: the whole vendor directory inline -->
    <ProvidersPanel v-if="seen.providers" v-show="tab === 'providers'" />

    <!-- Overview -->
    <div v-show="tab === 'overview'" class="space-y-4">

    <!-- Stat cards -->
    <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
      <div class="card">
        <div class="text-xs text-smoke">{{ t('pulse.expensesThisWeek') }}</div>
        <div class="mt-1 text-2xl font-bold">{{ n(thisWeek?.expenses ?? 0, 'currency') }}</div>
      </div>
      <div class="card">
        <div class="text-xs text-smoke">{{ t('pulse.revenueThisWeek') }}</div>
        <div class="mt-1 text-2xl font-bold text-herb-700">{{ n(thisWeek?.revenue ?? 0, 'currency') }}</div>
      </div>
      <div class="card">
        <div class="text-xs text-smoke">{{ t('pulse.foodCostThisWeek') }}</div>
        <div
          class="mt-1 text-2xl font-bold"
          :class="fcThisWeek == null ? '' : fcThisWeek > 35 ? 'text-coral-600' : 'text-herb-700'"
        >
          {{ fcThisWeek == null ? '—' : n(fcThisWeek / 100, 'percent') }}
        </div>
      </div>
      <RouterLink to="/pantry" class="card block hover:border-ember/40">
        <div class="text-xs text-smoke">{{ t('pulse.pantryValue') }}</div>
        <div class="mt-1 text-2xl font-bold">{{ n(stockValue, 'currency') }}</div>
      </RouterLink>
    </div>

    <!-- Received, not yet billed: what the charts count that the books
         do not yet — the one card that says this money is in flight -->
    <RouterLink
      v-if="realtime.pendingCount > 0"
      to="/triage"
      class="card flex items-center justify-between gap-3 border-ember/30 hover:border-ember/60"
    >
      <div class="min-w-0">
        <div class="text-sm font-semibold">{{ t('pulse.pendingNotes') }}</div>
        <div class="text-xs text-smoke">
          {{ t('pulse.pendingNotesDetail', { n: realtime.pendingCount }) }}
          <template v-if="realtime.oldestPending">
            · {{ t('pulse.pendingOldest', { date: d(new Date(realtime.oldestPending + 'T12:00:00'), 'short') }) }}
          </template>
          <template v-if="realtime.unvaluedLines">
            · {{ t('pulse.pendingUnvalued', { n: realtime.unvaluedLines }) }}
          </template>
        </div>
      </div>
      <div class="shrink-0 text-lg font-bold text-ember-700">
        {{ n(realtime.pendingTotal, 'currency') }}
      </div>
    </RouterLink>

    <!-- Expenses vs revenue -->
    <div class="card">
      <div class="mb-2 flex items-center justify-between text-sm">
        <span class="flex items-center gap-1">
          <span class="font-semibold">{{ t('pulse.chartTitle') }}</span>
          <InfoButton :title="t('pulse.chartTitle')">
            <p>{{ t('pulse.info.revenue.p1') }}</p>
            <p>{{ t('pulse.info.revenue.p2') }}</p>
            <p>{{ t('pulse.info.revenue.p3') }}</p>
          </InfoButton>
        </span>
        <span class="flex items-center gap-3 text-[11px] text-smoke">
          <span class="flex items-center gap-1"><span class="h-1.5 w-4 rounded bg-herb" />{{ t('pulse.legendRevenue') }}</span>
          <span class="flex items-center gap-1"><span class="h-1.5 w-4 rounded bg-coral" />{{ t('pulse.legendExpenses') }}</span>
        </span>
      </div>
      <svg :viewBox="`0 0 ${W} ${H}`" class="h-48 w-full" role="img" :aria-label="t('pulse.chartTitle')">
        <line v-for="f in [0.25, 0.5, 0.75]" :key="f" :x1="PAD" :x2="W - PAD" :y1="H * f" :y2="H * f" stroke="#F3F4F6" />
        <polyline :points="points('revenue')" fill="none" stroke="#2E9E5B" stroke-width="2.5" stroke-linejoin="round" />
        <polyline :points="points('expenses')" fill="none" stroke="#DC3448" stroke-width="2.5" stroke-linejoin="round" />
      </svg>
      <div class="mt-1 flex justify-between text-[10px] text-smoke">
        <span v-for="p in series" :key="p.weekStart">{{ d(new Date(p.weekStart + 'T12:00:00'), 'weekday') }}</span>
      </div>
    </div>

    <div class="grid gap-3 md:grid-cols-2">
      <!-- Food-cost % with target band -->
      <div class="card">
        <div class="mb-2 flex items-center justify-between text-sm">
          <span class="flex items-center gap-1">
            <span class="font-semibold">{{ t('pulse.foodCostTitle') }}</span>
            <InfoButton :title="t('pulse.foodCostTitle')">
              <p>{{ t('pulse.info.foodCost.p1') }}</p>
              <p>{{ t('pulse.info.foodCost.p2') }}</p>
            </InfoButton>
          </span>
          <span class="text-[11px] text-smoke">{{ t('pulse.foodCostBand') }}</span>
        </div>
        <svg :viewBox="`0 0 ${FC.w} ${FC.h}`" class="h-44 w-full md:h-36" role="img" :aria-label="t('pulse.foodCostTitle')">
          <rect :x="FC.pad" :y="fcY(35)" :width="FC.w - 2 * FC.pad" :height="Math.max(0, fcY(28) - fcY(35))" fill="#ECF8F0" />
          <line :x1="FC.pad" :x2="FC.w - FC.pad" :y1="fcY(35)" :y2="fcY(35)" stroke="#2E9E5B" stroke-dasharray="3 3" stroke-width="1" />
          <line :x1="FC.pad" :x2="FC.w - FC.pad" :y1="fcY(28)" :y2="fcY(28)" stroke="#2E9E5B" stroke-dasharray="3 3" stroke-width="1" />
          <text :x="FC.w - FC.pad - 2" :y="fcY(35) - 4" text-anchor="end" font-size="9" fill="#1E6B3D">{{ n(0.35, 'percentWhole') }}</text>
          <text :x="FC.w - FC.pad - 2" :y="fcY(28) + 11" text-anchor="end" font-size="9" fill="#1E6B3D">{{ n(0.28, 'percentWhole') }}</text>
          <text v-if="fcThisWeek != null" :x="FC.pad + 2" :y="FC.pad + 9" font-size="9" fill="#7A6F66">
            {{ n(fcMax / 100, 'percentWhole') }}
          </text>
          <line :x1="FC.pad" :x2="FC.w - FC.pad" :y1="FC.h - FC.pad" :y2="FC.h - FC.pad" stroke="#E5E7EB" />
          <polyline :points="fcPoints" fill="none" stroke="#FF751F" stroke-width="2.5" stroke-linejoin="round" />
        </svg>
        <div class="mt-1 flex justify-between text-[10px] text-smoke">
          <span v-for="p in weekTicks" :key="p.weekStart">{{ d(new Date(p.weekStart + 'T12:00:00'), 'weekday') }}</span>
        </div>
      </div>

      <!-- Vendor spend stacked bars: click a segment to open the vendor -->
      <div class="card">
        <div class="mb-2 flex items-center gap-1 text-sm">
          <span class="font-semibold">{{ t('pulse.vendorSpendTitle') }}</span>
          <InfoButton :title="t('pulse.vendorSpendTitle')">
            <p>{{ t('pulse.info.vendorSpend.p1') }}</p>
            <p>{{ t('pulse.info.vendorSpend.p2') }}</p>
          </InfoButton>
        </div>
        <svg :viewBox="`0 0 ${VS.w} ${VS.h}`" class="h-44 w-full md:h-36" role="img" :aria-label="t('pulse.vendorSpendTitle')">
          <line v-for="f in [1 / 3, 2 / 3]" :key="f" :x1="VS.pad" :x2="VS.w - VS.pad" :y1="VS.pad + f * (VS.h - 2 * VS.pad)" :y2="VS.pad + f * (VS.h - 2 * VS.pad)" stroke="#F3F4F6" />
          <line :x1="VS.pad" :x2="VS.w - VS.pad" :y1="VS.h - VS.pad" :y2="VS.h - VS.pad" stroke="#E5E7EB" />
          <text :x="VS.pad + 2" :y="VS.pad + 9" font-size="9" fill="#7A6F66">{{ n(vendorRects.max, 'currency') }}</text>
          <rect
            v-for="(r, i) in vendorRects.rects"
            :key="i"
            :x="r.x"
            :y="r.y"
            :width="vendorRects.barW"
            :height="r.h"
            :fill="r.color"
            rx="1.5"
            :class="r.key !== 'other' ? 'cursor-pointer' : ''"
            @click="r.key !== 'other' && router.push(`/vendors/${r.key}`)"
          >
            <title>{{ r.name }} · {{ n(r.amount, 'currency') }}</title>
          </rect>
        </svg>
        <div class="mt-1 flex justify-between text-[10px] text-smoke">
          <span v-for="p in weekTicks" :key="p.weekStart">{{ d(new Date(p.weekStart + 'T12:00:00'), 'weekday') }}</span>
        </div>
        <div class="mt-2 flex flex-wrap gap-2">
          <component
            :is="v.key !== 'other' ? RouterLink : 'span'"
            v-for="v in vendorLegend"
            :key="v.key"
            :to="v.key !== 'other' ? `/vendors/${v.key}` : undefined"
            class="flex items-center gap-1.5 text-[11px] text-smoke"
            :class="v.key !== 'other' ? 'hover:text-ink' : ''"
          >
            <span class="h-2 w-2 rounded-full" :style="{ background: v.color }" />
            {{ v.key === 'other' ? t('pulse.otherVendors') : v.name }}
          </component>
        </div>
      </div>
    </div>

    <!-- Menu engineering matrix: zoomable, tap a dish for its detail -->
    <div v-if="engineering.points.length" class="card">
      <MenuMatrix :points="engineering.points" :avg-units="engineering.avgUnits" :avg-margin="engineering.avgMargin">
        <template #info>
          <InfoButton :title="t('pulse.matrixTitle')">
            <p>{{ t('pulse.info.matrix.p1') }}</p>
            <p>{{ t('pulse.info.matrix.p2') }}</p>
            <ul class="space-y-1.5">
              <li v-for="q in QUADRANTS" :key="q" class="flex gap-2">
                <span class="mt-1.5 h-2 w-2 shrink-0 rounded-full" :style="{ background: QUADRANT_COLORS[q] }" />
                <span><strong class="text-ink">{{ t(`pulse.quadrant.${q}`) }}</strong> — {{ t(`pulse.quadrantAdvice.${q}`) }}</span>
              </li>
            </ul>
            <p>{{ t('pulse.info.matrix.p3') }}</p>
          </InfoButton>
        </template>
      </MenuMatrix>
    </div>

    <div class="grid gap-3 md:grid-cols-2">
      <!-- Price watch: click through to the ingredient -->
      <div class="card">
        <div class="mb-2 flex items-center gap-1 text-sm">
          <span class="font-semibold">{{ t('pulse.priceWatchTitle') }}</span>
          <InfoButton :title="t('pulse.priceWatchTitle')">
            <p>{{ t('pulse.info.priceWatch.p1') }}</p>
            <p>{{ t('pulse.info.priceWatch.p2') }}</p>
          </InfoButton>
        </div>
        <div v-if="priceWatch.length === 0" class="text-xs text-smoke">{{ t('pulse.priceWatchEmpty') }}</div>
        <div v-else class="divide-y divide-gray-100">
          <RouterLink
            v-for="{ ing, hist, change } in priceWatch"
            :key="ing.id"
            :to="`/pantry/${ing.id}`"
            class="flex items-center gap-3 py-2 hover:bg-gray-50"
          >
            <div class="min-w-0 flex-1">
              <div class="truncate text-sm font-medium">{{ ing.name }}</div>
              <div class="text-[11px] text-smoke">
                {{ n(ing.lastUnitPrice ?? 0, 'currency') }}/{{ t('common.unit.' + ing.unit) }}
              </div>
            </div>
            <Sparkline :values="hist.map((h) => h.unitPrice)" :width="90" :height="26" />
            <span v-if="change != null" :class="change > 0 ? 'chip-up' : 'chip-down'">
              {{ change > 0 ? '↑' : '↓' }}{{ n(Math.abs(change) / 100, 'percent') }}
            </span>
          </RouterLink>
        </div>
      </div>

      <!-- Pareto: top ingredients by spend, click through -->
      <div class="card">
        <div class="mb-2 flex items-center gap-1 text-sm">
          <span class="font-semibold">{{ t('pulse.topSpendTitle') }}</span>
          <InfoButton :title="t('pulse.topSpendTitle')">
            <p>{{ t('pulse.info.topSpend.p1') }}</p>
            <p>{{ t('pulse.info.topSpend.p2') }}</p>
          </InfoButton>
        </div>
        <div class="space-y-2">
          <component
            :is="row.ingredientId ? RouterLink : 'div'"
            v-for="row in topSpend"
            :key="row.ingredientId ?? row.name"
            :to="row.ingredientId ? `/pantry/${row.ingredientId}` : undefined"
            class="block"
            :class="row.ingredientId ? 'group cursor-pointer' : ''"
          >
            <div class="mb-0.5 flex items-center justify-between text-xs">
              <span class="truncate font-medium group-hover:text-ember-700">{{ row.name }}</span>
              <span class="text-smoke">{{ n(row.total, 'currency') }}</span>
            </div>
            <div class="h-2 rounded-full bg-gray-100">
              <div class="h-2 rounded-full bg-ember" :style="{ width: (row.total / topSpendMax) * 100 + '%' }" />
            </div>
          </component>
        </div>
      </div>
    </div>

    <!-- Spend by category moved to the Categories tab (richer: a
         drillable pie with subcategories and breadcrumbs) -->

    <!-- Recent entries: revenue + expenses, editable -->
    <div v-if="entries.length" class="card p-0">
      <div class="px-4 pt-3 pb-1 text-sm font-semibold">{{ t('pulse.entriesTitle') }}</div>
      <div class="divide-y divide-gray-100">
        <div v-for="en in entries" :key="en.kind + en.id" class="flex items-center gap-3 px-4 py-2.5">
          <div class="min-w-0 flex-1">
            <div class="truncate text-sm font-medium">{{ entryLabel(en) }}</div>
            <div class="text-xs text-smoke">{{ d(new Date(en.date + 'T12:00:00'), 'short') }}</div>
            <RouterLink
              v-if="unattributedOf(en)"
              :to="`/integrations/${unattributedOf(en)!.provider}`"
              class="text-xs font-medium text-ember hover:underline"
            >
              {{ t('pulse.posUnattributed', { amount: n(unattributedOf(en)!.amount, 'currency'), count: unattributedOf(en)!.count }) }}
            </RouterLink>
          </div>
          <div class="shrink-0 text-sm font-semibold" :class="en.kind === 'revenue' ? 'text-herb-700' : ''">
            {{ en.kind === 'revenue' ? '+' : '−' }}{{ n(en.amount, 'currency') }}
          </div>
          <template v-if="canEdit && !isPos(en)">
            <button class="shrink-0 text-xs font-medium text-smoke hover:text-ink" @click="editEntry(en)">
              {{ t('common.action.edit') }}
            </button>
            <button class="shrink-0 text-xs font-medium text-smoke hover:text-coral-600" @click="removeEntry(en)">
              {{ t('common.action.delete') }}
            </button>
          </template>
        </div>
      </div>
    </div>

    <!-- Alerts: every entity links to its page -->
    <div class="card">
      <div class="mb-3 text-sm font-semibold">{{ t('pulse.alertsTitle') }}</div>
      <div v-if="priceAlerts.length === 0 && marginAlerts.length === 0" class="text-sm text-smoke">
        {{ t('pulse.noAlerts') }}
      </div>
      <div class="space-y-3">
        <div v-for="{ ing, change } in priceAlerts" :key="ing.id" class="flex items-start gap-3 text-sm">
          <span :class="change > 0 ? 'text-coral' : 'text-herb'" class="mt-0.5 shrink-0 font-bold">
            {{ change > 0 ? '↑' : '↓' }}
          </span>
          <div>
            <i18n-t :keypath="change > 0 ? 'pulse.priceUp' : 'pulse.priceDown'" tag="span">
              <template #vendor>
                <component
                  :is="ing.lastVendorName ? RouterLink : 'span'"
                  :to="ing.lastVendorName ? `/vendors/${vendorKey(ing.lastVendorName)}` : undefined"
                  class="font-semibold"
                  :class="ing.lastVendorName ? 'underline decoration-gray-300 hover:text-ember-700' : ''"
                >
                  {{ ing.lastVendorName ?? '—' }}
                </component>
              </template>
              <template #name>
                <RouterLink :to="`/pantry/${ing.id}`" class="font-semibold underline decoration-gray-300 hover:text-ember-700">
                  {{ ing.name }}
                </RouterLink>
              </template>
              <template #pct>
                <span :class="change > 0 ? 'chip-up' : 'chip-down'">{{ n(Math.abs(change) / 100, 'percent') }}</span>
              </template>
            </i18n-t>
            <span class="text-smoke">
              {{
                t('pulse.priceDetail', {
                  prev: n(ing.prevUnitPrice ?? 0, 'currency'),
                  last: n(ing.lastUnitPrice ?? 0, 'currency'),
                  unit: t('common.unit.' + ing.unit),
                })
              }}
            </span>
          </div>
        </div>

        <div v-for="{ m, margin, cost } in marginAlerts" :key="m.id" class="flex items-start gap-3 text-sm">
          <span class="mt-0.5 shrink-0 font-bold text-coral">↓</span>
          <div>
            <i18n-t keypath="pulse.marginSlip" tag="span">
              <template #name>
                <RouterLink
                  :to="`/menu/${m.id}`"
                  class="font-semibold underline decoration-gray-300 hover:text-ember-700"
                >
                  {{ m.name }}
                </RouterLink>
              </template>
              <template #pct><span class="chip-up">{{ n(margin / 100, 'percent') }}</span></template>
            </i18n-t>
            <span class="text-smoke">
              {{ t('pulse.marginDetail', { target: m.targetMarginPct, cost: n(cost, 'currency') }) }}
            </span>
          </div>
        </div>
      </div>
    </div>
    </div>
    </template>

    <!-- Expense sheet -->
    <Transition name="list">
      <div
        v-if="showExpense"
        class="fixed inset-0 z-40 flex items-end justify-center bg-black/30 backdrop-blur-sm sm:items-center"
        @click="showExpense = false"
      >
        <div
          class="max-h-[85vh] w-full space-y-4 overflow-auto rounded-t-2xl bg-white/95 p-5 backdrop-blur-md sm:max-w-md sm:rounded-2xl"
          @click.stop
        >
          <h2 class="text-lg font-bold">{{ t('pulse.expenseSheet.title') }}</h2>
          <div class="grid grid-cols-2 gap-3">
            <label class="space-y-1 text-sm">
              <span class="text-xs text-smoke">{{ t('pulse.sheet.date') }}</span>
              <input v-model="expDate" type="date" class="input" />
            </label>
            <label class="space-y-1 text-sm">
              <span class="text-xs text-smoke">{{ t('pulse.expenseSheet.amount', { symbol: currencySymbol }) }}</span>
              <input v-model="expAmount" type="number" inputmode="decimal" class="input" placeholder="0.00" />
            </label>
          </div>
          <label class="block space-y-1 text-sm">
            <span class="text-xs text-smoke">{{ t('pulse.expenseSheet.tag') }}</span>
            <!-- Free-form tag; datalist suggests every tag already used -->
            <input v-model="expTag" class="input" :placeholder="t('pulse.expenseSheet.tagPlaceholder')" list="expense-tags" />
            <datalist id="expense-tags">
              <option v-for="tag in kitchen.expenseTags" :key="tag" :value="tag" />
            </datalist>
          </label>
          <label class="block space-y-1 text-sm">
            <span class="text-xs text-smoke">{{ t('pulse.expenseSheet.vendor') }}</span>
            <input v-model="expVendor" class="input" />
          </label>
          <label class="block space-y-1 text-sm">
            <span class="text-xs text-smoke">{{ t('pulse.expenseSheet.note') }}</span>
            <input v-model="expNote" class="input" />
          </label>
          <BaseButton variant="herb" class="w-full py-3" :disabled="expBusy || !expAmount || !expTag.trim()" @click="saveExpense">
            {{ expBusy ? t('common.action.saving') : t('common.action.save') }}
          </BaseButton>
        </div>
      </div>
    </Transition>

    <!-- Revenue sheet -->
    <Transition name="list">
      <div
        v-if="showSheet"
        class="fixed inset-0 z-40 flex items-end justify-center bg-black/30 backdrop-blur-sm sm:items-center"
        @click="showSheet = false"
      >
        <div
          class="max-h-[85vh] w-full space-y-4 overflow-auto rounded-t-2xl bg-white/95 p-5 backdrop-blur-md sm:max-w-md sm:rounded-2xl"
          @click.stop
        >
          <h2 class="text-lg font-bold">{{ t('pulse.sheet.title') }}</h2>
          <div class="grid grid-cols-2 gap-3">
            <label class="space-y-1 text-sm">
              <span class="text-xs text-smoke">{{ t('pulse.sheet.date') }}</span>
              <input v-model="date" type="date" class="input" />
            </label>
            <label class="space-y-1 text-sm">
              <span class="text-xs text-smoke">{{ t('pulse.sheet.amount', { symbol: currencySymbol }) }}</span>
              <input v-model="amount" type="number" inputmode="decimal" class="input" placeholder="0.00" />
              <span class="block text-[11px] text-smoke">{{ t('pulse.sheet.amountHint') }}</span>
            </label>
          </div>
          <div v-if="kitchen.dishes.length" class="space-y-2">
            <div class="text-xs text-smoke">{{ t('pulse.sheet.dishesHint') }}</div>
            <div v-for="m in kitchen.dishes" :key="m.id" class="flex items-center gap-3">
              <div class="flex-1 text-sm">{{ m.name }}</div>
              <input v-model="sold[m.id]" type="number" inputmode="numeric" class="input w-20 text-center" placeholder="0" />
            </div>
          </div>
          <BaseButton variant="herb" class="w-full py-3" :disabled="busy || !amount" @click="saveRevenue">
            {{ busy ? t('common.action.saving') : t('common.action.save') }}
          </BaseButton>
        </div>
      </div>
    </Transition>
  </div>
</template>
