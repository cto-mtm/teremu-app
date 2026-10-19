<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useInvoicesStore } from '../stores/invoices'
import { useKitchenStore } from '../stores/kitchen'
import { useAuthStore } from '../stores/auth'
import {
  ingredientWeeklyQty,
  normalizeName,
  priceChangePct,
  priceHistory,
  receiptsForIngredient,
  recipesUsing,
} from '../lib/domain'
import { CATEGORIES, SUBCATEGORIES, type Category, type Subcategory } from '../lib/types'
import Sparkline from '../components/Sparkline.vue'
import MiniBars from '../components/MiniBars.vue'
import BaseButton from '../components/BaseButton.vue'
import LinkToRecipeSheet from '../components/LinkToRecipeSheet.vue'

/**
 * One ingredient end to end: theoretical stock, price trend, the recipes
 * whose costs depend on it (or a warning when none do), every approved
 * receipt containing it, and the vendors who supply it.
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
  ingredient.value ? recipesUsing(kitchen.menuItems, { ingredientId: ingredient.value.id }) : [],
)
const receipts = computed(() =>
  ingredient.value ? receiptsForIngredient(invoicesStore.invoices, ingredient.value) : [],
)

// ── Unused warning: link it to a recipe, or say it never goes in one ──
const isUnused = computed(() => !!ingredient.value && kitchen.unused.some((i) => i.id === ingredient.value!.id))
const canLink = computed(() => auth.can('menu', 'edit'))
const canDismiss = computed(() => auth.can('pantry', 'edit'))
const linkOpen = ref(false)
const dismissBusy = ref(false)
async function setNotInRecipes(value: boolean): Promise<void> {
  if (!ingredient.value) return
  dismissBusy.value = true
  const ok = await kitchen.setNotInRecipes(ingredient.value.id, value)
  dismissBusy.value = false
  if (!ok) alert(t('pantry.detail.dismissFailed'))
}
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
      <!-- Category + subcategory: OCR's guess, correctable here. A new
           category clears the subcategory (the old pairing is invalid). -->
      <select
        class="input w-auto text-xs"
        :value="ingredient.category"
        :disabled="!auth.can('pantry', 'edit')"
        :aria-label="t('common.filter.allCategories')"
        @change="kitchen.setCategory(ingredient.id, ($event.target as HTMLSelectElement).value as Category)"
      >
        <option v-for="c in CATEGORIES" :key="c" :value="c">{{ t('common.category.' + c) }}</option>
      </select>
      <select
        v-if="SUBCATEGORIES[ingredient.category].length"
        class="input w-auto text-xs"
        :value="ingredient.subcategory ?? ''"
        :disabled="!auth.can('pantry', 'edit')"
        :aria-label="t('common.filter.allSubcategories')"
        @change="
          kitchen.setCategory(
            ingredient.id,
            ingredient.category,
            (($event.target as HTMLSelectElement).value || null) as Subcategory | null,
          )
        "
      >
        <option value="">{{ t('common.subcategory.none') }}</option>
        <option v-for="s in SUBCATEGORIES[ingredient.category]" :key="s" :value="s">
          {{ t('common.subcategory.' + s) }}
        </option>
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
            {{ change > 0 ? '↑' : '↓' }} {{ n(Math.abs(change) / 100, 'percent') }}
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
      <div
        v-if="isUnused"
        class="mx-4 mb-4 space-y-2 rounded-xl border border-ember-100 bg-ember-50 p-3"
        role="status"
      >
        <p class="text-sm font-semibold text-ember-700">⚠ {{ t('pantry.detail.unusedTitle') }}</p>
        <p class="text-xs text-ink/70">{{ t('pantry.detail.unusedBody') }}</p>
        <div v-if="canLink || canDismiss" class="flex flex-wrap gap-2 pt-1">
          <BaseButton v-if="canLink" @click="linkOpen = true">+ {{ t('pantry.detail.linkCta') }}</BaseButton>
          <BaseButton v-if="canDismiss" variant="ghost" :disabled="dismissBusy" @click="setNotInRecipes(true)">
            {{ t('pantry.detail.dismiss') }}
          </BaseButton>
        </div>
      </div>
      <div v-else-if="dishes.length === 0" class="px-4 pb-4 text-xs text-smoke">
        {{ t('pantry.detail.dishesEmpty') }}
        <template v-if="ingredient.notInRecipes">
          · {{ t('pantry.detail.dismissed') }}
          <button
            v-if="canDismiss"
            class="font-semibold text-ember-700 hover:underline"
            :disabled="dismissBusy"
            @click="setNotInRecipes(false)"
          >
            {{ t('pantry.detail.undo') }}
          </button>
        </template>
      </div>
      <div v-else class="divide-y divide-gray-100">
        <RouterLink
          v-for="({ item, qty, unit }, i) in dishes"
          :key="item.id + ':' + i"
          :to="`/menu/${item.id}`"
          class="flex items-center justify-between px-4 py-3 hover:bg-gray-50"
        >
          <div class="text-sm font-medium">{{ item.name }}</div>
          <div class="text-xs text-smoke">
            {{ t(item.kind === 'prep' ? 'pantry.detail.perBatch' : 'pantry.detail.perPlate', { qty: n(qty), unit: t('common.unit.' + (unit ?? ingredient.unit)) }) }}
          </div>
        </RouterLink>
      </div>
      <button
        v-if="dishes.length && canLink"
        class="w-full border-t border-gray-100 px-4 py-2.5 text-left text-xs font-semibold text-ember-700 hover:bg-gray-50"
        @click="linkOpen = true"
      >
        + {{ t('pantry.detail.linkCta') }}
      </button>
    </div>

    <LinkToRecipeSheet v-model="linkOpen" :ingredient="ingredient" />

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
