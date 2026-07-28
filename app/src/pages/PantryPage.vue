<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useKitchenStore } from '../stores/kitchen'
import { useAuthStore } from '../stores/auth'
import { useSettingsStore } from '../stores/settings'
import { groceryList, normalizeName, productionPlan, type GroceryRow } from '../lib/domain'
import { CATEGORIES, type Category, type Unit } from '../lib/types'
import BaseButton from '../components/BaseButton.vue'
import PageLoader from '../components/PageLoader.vue'

/**
 * The Theoretical Pantry — a reference table, not a daily ledger.
 * Purchases (invoices) add stock, sales (revenue entries) subtract it.
 * Tap any quantity, type the physical count, and the system
 * recalibrates from that true-up.
 */
const { t, n, d } = useI18n()
const kitchen = useKitchenStore()
const auth = useAuthStore()
const canEdit = computed(() => auth.can('pantry', 'edit'))

const editingId = ref<string | null>(null)
const countVal = ref('')

// ── Manual ingredient creation (cold-start / menu building) ─────
const settings = useSettingsStore()
const showAdd = ref(false)
const addName = ref('')
const addUnit = ref<Unit>('kg')
const addCategory = ref<Category>('other')
const addPrice = ref('')
const addStock = ref('')
const addBusy = ref(false)

async function createIngredient(): Promise<void> {
  addBusy.value = true
  const created = await kitchen.addIngredient(
    addName.value.trim(),
    addUnit.value,
    addCategory.value,
    Number(addPrice.value) > 0 ? Number(addPrice.value) : undefined,
    Number(addStock.value) > 0 ? Number(addStock.value) : undefined,
  )
  addBusy.value = false
  if (created) {
    showAdd.value = false
    addName.value = ''
    addPrice.value = ''
    addStock.value = ''
  } else {
    alert(kitchen.error?.includes('exists') ? t('pantry.add.exists') : t('pantry.add.failed'))
  }
}

// ── Search / filter / sort ──────────────────────────────────────
const search = ref('')
const catFilter = ref<'all' | Category>('all')
const sortBy = ref<'name' | 'stock' | 'value'>('name')

const filtered = computed(() => {
  const q = normalizeName(search.value)
  const list = kitchen.ingredients.filter(
    (i) =>
      (catFilter.value === 'all' || i.category === catFilter.value) &&
      (!q || i.nameKey.includes(q)),
  )
  switch (sortBy.value) {
    case 'stock':
      return [...list].sort((a, b) => a.theoreticalQty - b.theoreticalQty)
    case 'value':
      return [...list].sort(
        (a, b) =>
          Math.max(0, b.theoreticalQty) * (b.lastUnitPrice ?? 0) -
          Math.max(0, a.theoreticalQty) * (a.lastUnitPrice ?? 0),
      )
    default:
      return list // API already sorts by name
  }
})

// ── Production plan: "40 salmon + 60 risotto for Saturday" ──────
const showPlan = ref(false)
const planQty = ref<Record<string, string>>({})

const plan = computed(() => {
  const selections = Object.entries(planQty.value)
    .map(([menuItemId, qty]) => ({ menuItemId, qty: Number(qty) || 0 }))
    .filter((s) => s.qty > 0)
  return productionPlan(selections, kitchen.menuItems, kitchen.ingredientMap)
})
const planToBuy = computed(() => plan.value.filter((r) => r.toBuy > 0))

// ── Grocery list: usage rate (last 14 days of sales) vs stock ───
const COVER_DAYS = 7
const showGrocery = ref(false)
const copied = ref(false)

const grocery = computed(() =>
  groceryList(kitchen.ingredients, kitchen.menuItems, kitchen.revenue, COVER_DAYS),
)

/** Rows grouped by the vendor you last bought each ingredient from. */
const groceryByVendor = computed(() => {
  const map = new Map<string, GroceryRow[]>()
  for (const row of grocery.value) {
    const vendor = row.ingredient.lastVendorName ?? ''
    map.set(vendor, [...(map.get(vendor) ?? []), row])
  }
  return [...map.entries()].map(([vendor, rows]) => ({ vendor, rows }))
})

// ── Send order per vendor (email via API, WhatsApp via wa.me) ───
const sentVendor = ref<string | null>(null)

function contactFor(vendorName: string) {
  return kitchen.vendorContacts.find((c) => c.vendorKey === normalizeName(vendorName))
}

function orderLines(rows: GroceryRow[]) {
  return rows
    .filter((r) => r.suggestedQty > 0)
    .map((r) => ({ name: r.ingredient.name, qty: r.suggestedQty, unit: r.ingredient.unit }))
}

async function emailOrder(vendorName: string, rows: GroceryRow[]): Promise<void> {
  const lines = orderLines(rows)
  if (!lines.length) return
  const ok = await kitchen.sendOrder(normalizeName(vendorName), vendorName, lines)
  if (ok) {
    sentVendor.value = vendorName
    setTimeout(() => (sentVendor.value = null), 2500)
  } else {
    alert(t('pantry.grocery.orderFailed'))
  }
}

function whatsappUrl(vendorName: string, rows: GroceryRow[]): string {
  const phone = contactFor(vendorName)?.phone?.replace(/[^\d]/g, '') ?? ''
  const text = [
    `${t('pantry.grocery.title')} — ${vendorName}:`,
    ...orderLines(rows).map((l) => `• ${l.name}: ${l.qty} ${t('common.unit.' + l.unit)}`),
  ].join('\n')
  return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`
}

async function copyList(): Promise<void> {
  const lines: string[] = []
  for (const group of groceryByVendor.value) {
    lines.push(`${group.vendor || t('pantry.grocery.vendorUnknown')}:`)
    for (const row of group.rows) {
      const qty =
        row.suggestedQty > 0
          ? `${row.suggestedQty} ${t('common.unit.' + row.ingredient.unit)}`
          : `(${t('pantry.grocery.check')})`
      lines.push(`  - ${row.ingredient.name}: ${qty}`)
    }
  }
  await navigator.clipboard.writeText(lines.join('\n'))
  copied.value = true
  setTimeout(() => (copied.value = false), 2000)
}

function startEdit(id: string, current: number): void {
  editingId.value = id
  countVal.value = String(Math.max(0, +current.toFixed(1)))
}

async function commit(id: string): Promise<void> {
  const qty = Number(countVal.value)
  editingId.value = null
  if (!Number.isFinite(qty) || qty < 0) return
  await kitchen.trueUp(id, qty)
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h1 class="text-xl font-bold">{{ t('pantry.title') }}</h1>
        <p class="mt-1 text-xs text-smoke">{{ t('pantry.subtitle') }}</p>
      </div>
      <div class="flex shrink-0 flex-wrap gap-2">
        <BaseButton v-if="canEdit" variant="ghost" @click="showAdd = true">
          + {{ t('pantry.add.cta') }}
        </BaseButton>
        <BaseButton v-if="kitchen.activeMenuItems.length" variant="ghost" @click="showPlan = true">
          {{ t('pantry.plan.cta') }}
        </BaseButton>
        <BaseButton v-if="kitchen.ingredients.length" @click="showGrocery = true">
          {{ t('pantry.grocery.cta') }}
        </BaseButton>
      </div>
    </div>

    <!-- Production plan sheet -->
    <Transition name="list">
      <div
        v-if="showPlan"
        class="fixed inset-0 z-40 flex items-end justify-center bg-black/30 backdrop-blur-sm sm:items-center"
        @click="showPlan = false"
      >
        <div
          class="max-h-[85vh] w-full space-y-4 overflow-auto rounded-t-2xl bg-white/95 p-5 backdrop-blur-md sm:max-w-lg sm:rounded-2xl"
          @click.stop
        >
          <div>
            <h2 class="text-lg font-bold">{{ t('pantry.plan.title') }}</h2>
            <p class="mt-0.5 text-xs text-smoke">{{ t('pantry.plan.desc') }}</p>
          </div>

          <div class="space-y-2">
            <div v-for="m in kitchen.activeMenuItems" :key="m.id" class="flex items-center gap-3">
              <div class="min-w-0 flex-1 truncate text-sm">{{ m.name }}</div>
              <input
                v-model="planQty[m.id]"
                type="number"
                inputmode="numeric"
                min="0"
                class="input w-20 text-center"
                :placeholder="t('pantry.plan.qtyPlaceholder')"
              />
            </div>
          </div>

          <template v-if="plan.length">
            <div class="border-t border-gray-100 pt-3 text-sm font-semibold">
              {{ t('pantry.plan.resultTitle') }}
            </div>
            <p v-if="planToBuy.length === 0" class="text-sm text-herb-700">
              {{ t('pantry.plan.covered') }}
            </p>
            <div v-else class="divide-y divide-gray-100 rounded-xl border border-gray-100">
              <div v-for="row in plan" :key="row.ingredient.id" class="flex items-center justify-between px-3 py-2.5">
                <div class="min-w-0">
                  <div class="truncate text-sm font-medium">{{ row.ingredient.name }}</div>
                  <div class="text-[11px] text-smoke">
                    {{
                      t('pantry.plan.row', {
                        required: n(row.required) + ' ' + t('common.unit.' + row.ingredient.unit),
                        stock: n(row.stock) + ' ' + t('common.unit.' + row.ingredient.unit),
                      })
                    }}
                  </div>
                </div>
                <div
                  class="shrink-0 text-sm font-semibold"
                  :class="row.toBuy > 0 ? 'text-coral-600' : 'text-herb-700'"
                >
                  {{
                    row.toBuy > 0
                      ? t('pantry.plan.buy', { qty: n(row.toBuy), unit: t('common.unit.' + row.ingredient.unit) })
                      : t('pantry.plan.inStock')
                  }}
                </div>
              </div>
            </div>
          </template>
        </div>
      </div>
    </Transition>

    <!-- Manual ingredient sheet -->
    <Transition name="list">
      <div
        v-if="showAdd"
        class="fixed inset-0 z-40 flex items-end justify-center bg-black/30 backdrop-blur-sm sm:items-center"
        @click="showAdd = false"
      >
        <div
          class="max-h-[85vh] w-full space-y-4 overflow-auto rounded-t-2xl bg-white/95 p-5 backdrop-blur-md sm:max-w-md sm:rounded-2xl"
          @click.stop
        >
          <div>
            <h2 class="text-lg font-bold">{{ t('pantry.add.title') }}</h2>
            <p class="mt-0.5 text-xs text-smoke">{{ t('pantry.add.desc') }}</p>
          </div>
          <input v-model="addName" class="input" :placeholder="t('pantry.add.name')" />
          <div class="grid grid-cols-2 gap-3">
            <select v-model="addUnit" class="input" :aria-label="t('triage.detail.unit')">
              <option v-for="u in settings.unitChoices" :key="u" :value="u">{{ t('common.unit.' + u) }}</option>
            </select>
            <select v-model="addCategory" class="input" :aria-label="t('common.filter.allCategories')">
              <option v-for="c in CATEGORIES" :key="c" :value="c">{{ t('common.category.' + c) }}</option>
            </select>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <label class="space-y-1 text-sm">
              <span class="text-xs text-smoke">{{ t('pantry.add.price') }}</span>
              <input v-model="addPrice" type="number" inputmode="decimal" step="0.01" class="input" />
            </label>
            <label class="space-y-1 text-sm">
              <span class="text-xs text-smoke">{{ t('pantry.add.stock') }}</span>
              <input v-model="addStock" type="number" inputmode="decimal" class="input" />
            </label>
          </div>
          <BaseButton variant="herb" class="w-full py-3" :disabled="addBusy || !addName.trim()" @click="createIngredient">
            {{ addBusy ? t('common.action.saving') : t('common.action.save') }}
          </BaseButton>
        </div>
      </div>
    </Transition>

    <PageLoader v-if="kitchen.loading && !kitchen.ingredients.length" :cards="0" :lines="6" />

    <div v-else-if="kitchen.ingredients.length === 0" class="card py-10 text-center text-sm text-smoke">
      {{ t('pantry.empty') }}
    </div>

    <template v-else>
      <div class="flex flex-wrap gap-2">
        <input v-model="search" class="input min-w-40 flex-1" :placeholder="t('common.filter.search')" />
        <select v-model="catFilter" class="input w-auto">
          <option value="all">{{ t('common.filter.allCategories') }}</option>
          <option v-for="c in CATEGORIES" :key="c" :value="c">{{ t('common.category.' + c) }}</option>
        </select>
        <select v-model="sortBy" class="input w-auto">
          <option value="name">{{ t('common.filter.sortName') }}</option>
          <option value="stock">{{ t('common.filter.sortStock') }}</option>
          <option value="value">{{ t('common.filter.sortValue') }}</option>
        </select>
      </div>

      <div v-if="filtered.length === 0" class="card py-8 text-center text-sm text-smoke">
        {{ t('common.filter.noResults') }}
      </div>

      <div v-else class="card divide-y divide-gray-100 overflow-hidden p-0">
      <div v-for="ing in filtered" :key="ing.id" class="flex items-center gap-3 px-4 py-3">
        <!-- Name links to the ingredient detail (dishes, receipts, vendors);
             the quantity button stays a tap-to-true-up affordance. -->
        <RouterLink :to="`/pantry/${ing.id}`" class="group min-w-0 flex-1">
          <div
            class="truncate font-medium group-hover:text-ember-700"
            :style="{ viewTransitionName: 'ingredient-' + ing.id }"
          >
            {{ ing.name }}
          </div>
          <div class="text-xs text-smoke">
            {{ t('pantry.pricePerUnit', { price: n(ing.lastUnitPrice ?? 0, 'currency'), unit: t('common.unit.' + ing.unit) }) }}
            <template v-if="ing.lastCountAt">
              · {{ t('pantry.counted', { date: d(new Date(ing.lastCountAt), 'short') }) }}
            </template>
          </div>
        </RouterLink>

        <input
          v-if="editingId === ing.id"
          v-model="countVal"
          type="number"
          inputmode="decimal"
          class="input w-24 text-right font-semibold"
          :aria-label="t('pantry.countLabel')"
          autofocus
          @blur="commit(ing.id)"
          @keydown.enter="commit(ing.id)"
        />
        <button
          v-else-if="canEdit"
          class="rounded-lg px-2 py-1 text-right hover:bg-gray-50"
          :class="ing.theoreticalQty <= 0 ? 'text-coral-600' : ''"
          @click="startEdit(ing.id, ing.theoreticalQty)"
        >
          <span class="font-bold">{{ n(+ing.theoreticalQty.toFixed(1)) }}</span>
          <span class="text-xs text-smoke"> {{ t('common.unit.' + ing.unit) }}</span>
        </button>
        <span v-else class="px-2 py-1 text-right" :class="ing.theoreticalQty <= 0 ? 'text-coral-600' : ''">
          <span class="font-bold">{{ n(+ing.theoreticalQty.toFixed(1)) }}</span>
          <span class="text-xs text-smoke"> {{ t('common.unit.' + ing.unit) }}</span>
        </span>
      </div>
      </div>
    </template>

    <p v-if="kitchen.ingredients.length > 0" class="px-1 text-xs text-smoke">
      {{ t('pantry.tip') }}
    </p>

    <!-- Grocery list sheet -->
    <Transition name="list">
      <div
        v-if="showGrocery"
        class="fixed inset-0 z-40 flex items-end justify-center bg-black/30 backdrop-blur-sm sm:items-center"
        @click="showGrocery = false"
      >
        <div
          class="max-h-[85vh] w-full space-y-4 overflow-auto rounded-t-2xl bg-white/95 p-5 backdrop-blur-md sm:max-w-md sm:rounded-2xl"
          @click.stop
        >
          <div>
            <h2 class="text-lg font-bold">{{ t('pantry.grocery.title') }}</h2>
            <p class="mt-0.5 text-xs text-smoke">{{ t('pantry.grocery.subtitle', { days: COVER_DAYS }) }}</p>
          </div>

          <div v-if="grocery.length === 0" class="py-6 text-center text-sm text-smoke">
            {{ t('pantry.grocery.empty') }}
          </div>

          <div v-for="group in groceryByVendor" v-else :key="group.vendor" class="space-y-1">
            <div class="flex items-center justify-between gap-2">
              <div class="text-xs font-semibold text-smoke uppercase">
                {{ group.vendor || t('pantry.grocery.vendorUnknown') }}
              </div>
              <div v-if="group.vendor" class="flex gap-1.5">
                <button
                  v-if="canEdit && contactFor(group.vendor)?.email"
                  class="rounded-full bg-ember-50 px-2.5 py-1 text-[11px] font-semibold text-ember-700 hover:bg-ember-100"
                  @click="emailOrder(group.vendor, group.rows)"
                >
                  {{ sentVendor === group.vendor ? t('pantry.grocery.orderSent') : t('pantry.grocery.sendEmail') }}
                </button>
                <a
                  v-if="contactFor(group.vendor)?.phone"
                  :href="whatsappUrl(group.vendor, group.rows)"
                  target="_blank"
                  rel="noopener"
                  class="rounded-full bg-herb-50 px-2.5 py-1 text-[11px] font-semibold text-herb-700 hover:bg-herb-100"
                >
                  WhatsApp
                </a>
              </div>
            </div>
            <p
              v-if="group.vendor && !contactFor(group.vendor)"
              class="text-[11px] text-smoke"
            >
              {{ t('pantry.grocery.noContact') }}
            </p>
            <div class="divide-y divide-gray-100 rounded-xl border border-gray-100">
              <div v-for="row in group.rows" :key="row.ingredient.id" class="flex items-center justify-between px-3 py-2.5">
                <div class="min-w-0">
                  <div class="truncate text-sm font-medium">{{ row.ingredient.name }}</div>
                  <div class="text-[11px]" :class="row.daysLeft <= 1 ? 'text-coral-600' : 'text-smoke'">
                    {{
                      row.daysLeft === 0 && row.usagePerDay === 0
                        ? t('pantry.grocery.out')
                        : t('pantry.grocery.daysLeft', { n: Math.max(0, Math.floor(row.daysLeft)) })
                    }}
                  </div>
                </div>
                <div class="shrink-0 text-sm font-semibold">
                  {{
                    row.suggestedQty > 0
                      ? t('pantry.grocery.suggested', { qty: n(row.suggestedQty), unit: t('common.unit.' + row.ingredient.unit) })
                      : t('pantry.grocery.check')
                  }}
                </div>
              </div>
            </div>
          </div>

          <BaseButton v-if="grocery.length" class="w-full py-3" @click="copyList">
            {{ copied ? t('pantry.grocery.copied') : t('pantry.grocery.copy') }}
          </BaseButton>
        </div>
      </div>
    </Transition>
  </div>
</template>
