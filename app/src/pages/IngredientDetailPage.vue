<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useInvoicesStore } from '../stores/invoices'
import { useKitchenStore } from '../stores/kitchen'
import { useAuthStore } from '../stores/auth'
import {
  dishesUsing,
  ingredientWeeklyQty,
  normalizeName,
  priceChangePct,
  priceHistory,
  receiptsForIngredient,
} from '../lib/domain'
import { CATEGORIES, type Category } from '../lib/types'
import Sparkline from '../components/Sparkline.vue'
import MiniBars from '../components/MiniBars.vue'

/**
 * One ingredient end to end: theoretical stock, price trend, the dishes
 * whose margins depend on it, every approved receipt containing it, and
 * the vendors who supply it.
 */
const { t, n, d } = useI18n()
const route = useRoute()
const router = useRouter()
const invoicesStore = useInvoicesStore()
const kitchen = useKitchenStore()
const auth = useAuthStore()

const ingredient = computed(() => kitchen.ingredientMap.get(String(route.params.id)))
const change = computed(() => (ingredient.value ? priceChangePct(ingredient.value) : null))
const dishes = computed(() =>
  ingredient.value ? dishesUsing(kitchen.menuItems, ingredient.value.id) : [],
)
const receipts = computed(() =>
  ingredient.value ? receiptsForIngredient(invoicesStore.invoices, ingredient.value) : [],
)
const history = computed(() =>
  ingredient.value ? priceHistory(invoicesStore.invoices, ingredient.value) : [],
)
const weeklyQty = computed(() =>
  ingredient.value ? ingredientWeeklyQty(invoicesStore.invoices, ingredient.value) : [],
)

/** Distinct vendors from this ingredient's receipts, with last price. */
const suppliers = computed(() => {
  const map = new Map<string, { name: string; key: string; count: number; lastPrice: number; lastDate: string }>()
  for (const r of receipts.value) {
    if (!r.vendorName) continue
    const key = normalizeName(r.vendorName)
    const existing = map.get(key)
    const date = r.date ?? ''
    if (existing) {
      existing.count += 1
      if (date > existing.lastDate) {
        existing.lastDate = date
        existing.lastPrice = r.unitPrice
      }
    } else {
      map.set(key, { name: r.vendorName, key, count: 1, lastPrice: r.unitPrice, lastDate: date })
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count)
})
</script>

<template>
  <div v-if="!ingredient" class="py-10 text-center text-sm text-smoke">
    {{ t('pantry.detail.notFound') }}
  </div>

  <div v-else class="space-y-4">
    <div class="flex items-center gap-3">
      <button class="text-smoke" :aria-label="t('common.action.back')" @click="router.push('/pantry')">←</button>
      <!-- HERO TARGET: same name as the pantry row -->
      <h1
        class="min-w-0 flex-1 truncate text-xl leading-tight font-bold"
        :style="{ viewTransitionName: 'ingredient-' + ingredient.id }"
      >
        {{ ingredient.name }}
      </h1>
      <!-- Category: OCR's guess, correctable here -->
      <select
        class="input w-auto text-xs"
        :value="ingredient.category"
        :disabled="!auth.can('pantry', 'edit')"
        :aria-label="t('common.filter.allCategories')"
        @change="kitchen.setCategory(ingredient.id, ($event.target as HTMLSelectElement).value as Category)"
      >
        <option v-for="c in CATEGORIES" :key="c" :value="c">{{ t('common.category.' + c) }}</option>
      </select>
    </div>

    <div class="grid grid-cols-2 gap-3">
      <div class="card">
        <div class="text-xs text-smoke">{{ t('pantry.detail.stock') }}</div>
        <div class="mt-1 text-2xl font-bold" :class="ingredient.theoreticalQty <= 0 ? 'text-coral-600' : ''">
          {{ n(+ingredient.theoreticalQty.toFixed(1)) }}
          <span class="text-sm font-medium text-smoke">{{ t('common.unit.' + ingredient.unit) }}</span>
        </div>
      </div>
      <div class="card">
        <div class="text-xs text-smoke">{{ t('pantry.detail.lastPrice') }}</div>
        <div class="mt-1 flex items-baseline gap-2">
          <span class="text-2xl font-bold">{{ n(ingredient.lastUnitPrice ?? 0, 'currency') }}</span>
          <span v-if="change != null && Math.abs(change) >= 1" :class="change > 0 ? 'chip-up' : 'chip-down'">
            {{ change > 0 ? '↑' : '↓' }} {{ Math.abs(change).toFixed(1) }}%
          </span>
        </div>
      </div>
    </div>

    <div v-if="history.length >= 2" class="card">
      <div class="mb-2 flex items-center justify-between text-sm">
        <span class="font-semibold">{{ t('pantry.detail.priceTitle') }}</span>
        <span class="text-[11px] text-smoke">
          {{ n(Math.min(...history.map((h) => h.unitPrice)), 'currency') }} –
          {{ n(Math.max(...history.map((h) => h.unitPrice)), 'currency') }}
        </span>
      </div>
      <div class="h-20 w-full">
        <Sparkline :values="history.map((h) => h.unitPrice)" :width="600" :height="80" stretch />
      </div>
      <div class="mt-1 flex justify-between text-[10px] text-smoke">
        <span>{{ d(new Date(history[0].date + 'T12:00:00'), 'short') }}</span>
        <span>{{ d(new Date(history[history.length - 1].date + 'T12:00:00'), 'short') }}</span>
      </div>
    </div>

    <div v-if="weeklyQty.some((v) => v > 0)" class="card">
      <div class="mb-2 text-sm font-semibold">
        {{ t('pantry.detail.purchasesTitle') }}
        <span class="ml-1 text-[11px] font-normal text-smoke">({{ t('common.unit.' + ingredient.unit) }})</span>
      </div>
      <MiniBars :values="weeklyQty" :height="56" color="#2e9e5b" />
    </div>

    <div class="card p-0">
      <div class="px-4 pt-3 pb-1 text-sm font-semibold">{{ t('pantry.detail.dishesTitle') }}</div>
      <div v-if="dishes.length === 0" class="px-4 pb-4 text-xs text-smoke">
        {{ t('pantry.detail.dishesEmpty') }}
      </div>
      <div v-else class="divide-y divide-gray-100">
        <RouterLink
          v-for="{ item, qty, unit } in dishes"
          :key="item.id"
          :to="`/menu/${item.id}`"
          class="flex items-center justify-between px-4 py-3 hover:bg-gray-50"
        >
          <div class="text-sm font-medium">{{ item.name }}</div>
          <div class="text-xs text-smoke">
            {{ t('pantry.detail.perPlate', { qty: n(qty), unit: t('common.unit.' + (unit ?? ingredient.unit)) }) }}
          </div>
        </RouterLink>
      </div>
    </div>

    <div v-if="suppliers.length" class="card p-0">
      <div class="px-4 pt-3 pb-1 text-sm font-semibold">{{ t('pantry.detail.vendorsTitle') }}</div>
      <div class="divide-y divide-gray-100">
        <RouterLink
          v-for="s in suppliers"
          :key="s.key"
          :to="`/vendors/${s.key}`"
          class="flex items-center justify-between px-4 py-3 hover:bg-gray-50"
        >
          <div class="text-sm font-medium">{{ s.name }}</div>
          <div class="text-xs text-smoke">
            {{ t('vendors.receipts', { n: s.count }) }} ·
            {{ n(s.lastPrice, 'currency') }}/{{ t('common.unit.' + ingredient.unit) }}
          </div>
        </RouterLink>
      </div>
    </div>

    <div class="card p-0">
      <div class="px-4 pt-3 pb-1 text-sm font-semibold">{{ t('pantry.detail.receiptsTitle') }}</div>
      <div v-if="receipts.length === 0" class="px-4 pb-4 text-xs text-smoke">
        {{ t('pantry.detail.receiptsEmpty') }}
      </div>
      <div v-else class="divide-y divide-gray-100">
        <div v-for="(r, i) in receipts" :key="r.invoiceId + i" class="flex items-center justify-between px-4 py-3">
          <div class="min-w-0">
            <div class="text-sm font-medium">{{ r.vendorName ?? '—' }}</div>
            <div class="text-xs text-smoke">
              {{ r.date ? d(new Date(r.date + 'T12:00:00'), 'short') : '—' }} ·
              {{ n(r.qty) }} {{ t('common.unit.' + r.unit) }} × {{ n(r.unitPrice, 'currency') }}
            </div>
          </div>
          <div class="shrink-0 text-sm font-semibold">{{ n(r.total, 'currency') }}</div>
        </div>
      </div>
    </div>
  </div>
</template>
