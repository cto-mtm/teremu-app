<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useKitchenStore } from '../stores/kitchen'
import { useAuthStore } from '../stores/auth'
import { actualMarginPct, costBreakdown, recipesUsing, unitsSoldWeekly } from '../lib/domain'
import BaseButton from '../components/BaseButton.vue'
import MiniBars from '../components/MiniBars.vue'

/**
 * One dish end to end: pricing and margin, sales trend, and which
 * ingredients the plate cost is made of (each linking to its page).
 * A prep (docs/prep-recipes.md) shows its yield, batch cost, cost per
 * yield unit and the recipes that use it instead of price and sales.
 */
const { t, n, d } = useI18n()
const route = useRoute()
const router = useRouter()
const kitchen = useKitchenStore()
const auth = useAuthStore()

const dish = computed(() => kitchen.menuItems.find((m) => m.id === String(route.params.id)))
const menuMap = computed(() => new Map(kitchen.menuItems.map((m) => [m.id, m])))
// Restaurant labor rate (Settings) — 0/unset keeps costs ingredients-only.
const laborRate = computed(() => auth.profile?.laborRatePerHour ?? 0)
const margin = computed(() =>
  dish.value
    ? actualMarginPct(dish.value, kitchen.ingredientMap, menuMap.value, laborRate.value, auth.tax)
    : { margin: null, cost: 0, foodCost: 0, laborCost: 0, missing: false },
)
const isPrep = computed(() => dish.value?.kind === 'prep')
const unitCost = computed(() => (dish.value?.yield?.qty ? margin.value.cost / dish.value.yield.qty : null))
/** Recipes that use this one, with the amount each line takes. */
const usedIn = computed(() => (dish.value ? recipesUsing(kitchen.menuItems, { subItemId: dish.value.id }) : []))
const weekly = computed(() => (dish.value ? unitsSoldWeekly(kitchen.revenue, dish.value.id) : []))
const sold14 = computed(() => weekly.value.slice(-2).reduce((s, v) => s + v, 0))
const breakdown = computed(() =>
  dish.value ? costBreakdown(dish.value, kitchen.ingredientMap, menuMap.value, laborRate.value) : [],
)
// ── Archive: an old menu item leaves the carta, its history stays ──
const archiveBusy = ref(false)
const activeUsers = computed(() => new Set(usedIn.value.filter((u) => u.item.active).map((u) => u.item.id)).size)
async function setActive(active: boolean): Promise<void> {
  if (!dish.value) return
  if (!active) {
    const usedBy = activeUsers.value ? '\n\n' + t('menu.archive.usedBy', { n: activeUsers.value }, activeUsers.value) : ''
    if (!confirm(t('menu.archive.confirm', { name: dish.value.name }) + usedBy)) return
  }
  archiveBusy.value = true
  const ok = await kitchen.setMenuItemActive(dish.value.id, active)
  archiveBusy.value = false
  if (!ok) alert(t('menu.archive.failed'))
}
const weekStarts = computed(() => {
  // Same 8-week window the bars use — first and last for the axis.
  const DAY = 86_400_000
  const monday = new Date()
  monday.setHours(0, 0, 0, 0)
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
  return [new Date(monday.getTime() - 7 * 7 * DAY), monday]
})
</script>

<template>
  <div v-if="!dish" class="py-10 text-center text-sm text-smoke">
    {{ t('menu.detail.notFound') }}
  </div>

  <div v-else class="space-y-4">
    <div class="flex items-center gap-3">
      <button
        class="text-smoke"
        :aria-label="t('common.action.back')"
        @click="router.push(isPrep ? { path: '/menu', query: { tab: 'preps' } } : '/menu')"
      >
        ←
      </button>
      <!-- HERO TARGET: same name as the menu list card -->
      <h1
        class="min-w-0 flex-1 truncate text-xl leading-tight font-bold"
        :style="{ viewTransitionName: 'dish-' + dish.id }"
      >
        {{ dish.name }}
      </h1>
      <BaseButton
        v-if="auth.can('menu', 'edit') && dish.active"
        variant="ghost"
        @click="router.push({ path: '/menu', query: { edit: dish.id } })"
      >
        {{ t('menu.detail.edit') }}
      </BaseButton>
    </div>

    <div v-if="!dish.active" class="card flex flex-wrap items-center justify-between gap-3" role="status">
      <div class="min-w-0">
        <p class="text-sm font-semibold">{{ t('menu.archive.badge') }}</p>
        <p class="text-xs text-smoke">{{ t('menu.archive.intro') }}</p>
      </div>
      <BaseButton v-if="auth.can('menu', 'edit')" :disabled="archiveBusy" @click="setActive(true)">
        {{ t('menu.archive.restore') }}
      </BaseButton>
    </div>

    <template v-if="isPrep">
      <div class="grid grid-cols-2 gap-3 md:grid-cols-3">
        <div class="card">
          <div class="text-xs text-smoke">{{ t('menu.detail.yield') }}</div>
          <div class="mt-1 text-2xl font-bold">
            <template v-if="dish.yield">{{ n(dish.yield.qty) }} {{ t('common.unit.' + dish.yield.unit) }}</template>
            <template v-else>—</template>
          </div>
        </div>
        <div class="card">
          <div class="text-xs text-smoke">{{ t('menu.detail.batchCost') }}</div>
          <div class="mt-1 text-2xl font-bold">{{ n(margin.cost, 'currency') }}</div>
          <div v-if="margin.laborCost > 0" class="text-[11px] text-smoke">
            {{ t('menu.detail.inclLabor', { cost: n(margin.laborCost, 'currency') }) }}
          </div>
          <div v-if="margin.missing" class="text-[11px] text-smoke">{{ t('menu.unpriced') }}</div>
        </div>
        <div v-if="dish.yield && unitCost != null" class="card">
          <div class="text-xs text-smoke">{{ t('menu.detail.unitCost', { unit: t('common.unit.' + dish.yield.unit) }) }}</div>
          <div class="mt-1 text-2xl font-bold">{{ n(unitCost, 'currency') }}</div>
        </div>
      </div>

      <div class="card">
        <div class="mb-2 text-sm font-semibold">{{ t('menu.detail.usedInTitle') }}</div>
        <p v-if="usedIn.length === 0" class="text-xs text-smoke">{{ t('menu.detail.usedInEmpty') }}</p>
        <div v-else class="divide-y divide-gray-100">
          <RouterLink
            v-for="(u, i) in usedIn"
            :key="u.item.id + ':' + i"
            :to="`/menu/${u.item.id}`"
            class="flex items-center justify-between gap-3 py-2 text-sm hover:text-ember-700"
          >
            <span class="truncate font-medium">{{ u.item.name }}</span>
            <span class="shrink-0 text-xs text-smoke">
              <template v-if="u.unit">{{ n(u.qty) }} {{ t('common.unit.' + u.unit) }}</template>
              <template v-else>{{ t('menu.detail.subPortions', { qty: n(u.qty) }) }}</template>
            </span>
          </RouterLink>
        </div>
      </div>
    </template>

    <template v-else>
    <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
      <div class="card">
        <div class="text-xs text-smoke">{{ t('menu.detail.price') }}</div>
        <div class="mt-1 text-2xl font-bold">{{ n(dish.price, 'currency') }}</div>
        <div class="mt-1 text-[11px] text-smoke">
          {{ auth.tax.pricesIncludeTax && auth.tax.rate > 0 ? t('menu.editor.priceInclTax', { rate: Math.round(auth.tax.rate * 100) }) : t('menu.editor.pricePreTax') }}
        </div>
      </div>
      <div class="card">
        <div class="text-xs text-smoke">{{ t('menu.detail.plateCost') }}</div>
        <div class="mt-1 text-2xl font-bold">{{ n(margin.cost, 'currency') }}</div>
        <div v-if="margin.laborCost > 0" class="text-[11px] text-smoke">
          {{ t('menu.detail.inclLabor', { cost: n(margin.laborCost, 'currency') }) }}
        </div>
      </div>
      <div class="card">
        <div class="text-xs text-smoke">{{ t('menu.detail.margin') }}</div>
        <div
          class="mt-1 text-2xl font-bold"
          :class="margin.margin != null && margin.margin < dish.targetMarginPct ? 'text-coral-600' : 'text-herb-700'"
        >
          {{ margin.margin != null ? n(margin.margin / 100, 'percent') : '—' }}
        </div>
        <div class="text-[11px] text-smoke">{{ t('menu.target', { pct: n(dish.targetMarginPct / 100, 'percentWhole') }) }}</div>
      </div>
      <div class="card">
        <div class="text-xs text-smoke">{{ t('menu.detail.sold14') }}</div>
        <div class="mt-1 text-2xl font-bold">{{ n(sold14) }}</div>
      </div>
    </div>

    <div class="card">
      <div class="mb-2 text-sm font-semibold">{{ t('menu.detail.unitsTitle') }}</div>
      <MiniBars :values="weekly" :height="70" />
      <div class="mt-1 flex justify-between text-[10px] text-smoke">
        <span>{{ d(weekStarts[0], 'weekday') }}</span>
        <span>{{ d(weekStarts[1], 'weekday') }}</span>
      </div>
    </div>
    </template>

    <div class="card">
      <div class="mb-2 text-sm font-semibold">{{ t('menu.detail.breakdownTitle') }}</div>
      <div class="space-y-2">
        <!-- Labor rows are informational (no detail page to link to) -->
        <component
          :is="row.labor ? 'div' : RouterLink"
          v-for="row in breakdown"
          :key="row.ingredient?.id ?? row.sub?.id ?? 'labor'"
          :to="row.labor ? undefined : row.sub ? `/menu/${row.sub.id}` : `/pantry/${row.ingredient!.id}`"
          class="group block"
        >
          <div class="mb-0.5 flex items-center justify-between text-xs">
            <span class="truncate font-medium" :class="row.labor ? '' : 'group-hover:text-ember-700'">
              <template v-if="row.labor">
                {{ t('menu.detail.laborRow') }}
                <span class="text-smoke">
                  · {{ t(isPrep ? 'menu.detail.laborPerBatch' : 'menu.detail.laborPerPlate', { min: n(row.qty) }) }}
                </span>
              </template>
              <template v-else-if="row.sub">
                {{ row.sub.name }}
                <span class="text-smoke">
                  ·
                  <template v-if="row.unit">
                    {{ t(isPrep ? 'menu.detail.perBatch' : 'menu.detail.perPlate', { qty: n(row.qty), unit: t('common.unit.' + row.unit) }) }}
                  </template>
                  <template v-else>
                    {{ t(isPrep ? 'menu.detail.subPortionsBatch' : 'menu.detail.subPortions', { qty: n(row.qty) }) }}
                  </template>
                </span>
              </template>
              <template v-else>
                {{ row.ingredient!.name }}
                <span class="text-smoke">
                  · {{ t(isPrep ? 'menu.detail.perBatch' : 'menu.detail.perPlate', { qty: n(row.qty), unit: t('common.unit.' + (row.unit ?? row.ingredient!.unit)) }) }}
                </span>
              </template>
            </span>
            <span class="shrink-0 text-smoke">{{ n(row.cost, 'currency') }}</span>
          </div>
          <div class="h-2 rounded-full bg-gray-100">
            <div
              class="h-2 rounded-full"
              :class="row.labor ? 'bg-ink/40' : row.sub ? 'bg-herb' : 'bg-ember'"
              :style="{ width: row.share * 100 + '%' }"
            />
          </div>
        </component>
      </div>
    </div>

    <BaseButton
      v-if="auth.can('menu', 'edit') && dish.active"
      variant="ghost"
      class="w-full"
      :disabled="archiveBusy"
      @click="setActive(false)"
    >
      {{ t('menu.archive.action') }}
    </BaseButton>
  </div>
</template>
