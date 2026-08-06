<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useKitchenStore } from '../stores/kitchen'
import { useAuthStore } from '../stores/auth'
import { actualMarginPct, costBreakdown, unitsSoldWeekly } from '../lib/domain'
import BaseButton from '../components/BaseButton.vue'
import MiniBars from '../components/MiniBars.vue'

/**
 * One dish end to end: pricing and margin, sales trend, and which
 * ingredients the plate cost is made of (each linking to its page).
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
    ? actualMarginPct(dish.value, kitchen.ingredientMap, menuMap.value, laborRate.value)
    : { margin: null, cost: 0, foodCost: 0, laborCost: 0, missing: false },
)
const weekly = computed(() => (dish.value ? unitsSoldWeekly(kitchen.revenue, dish.value.id) : []))
const sold14 = computed(() => weekly.value.slice(-2).reduce((s, v) => s + v, 0))
const breakdown = computed(() =>
  dish.value ? costBreakdown(dish.value, kitchen.ingredientMap, menuMap.value, laborRate.value) : [],
)
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
      <button class="text-smoke" :aria-label="t('common.action.back')" @click="router.push('/menu')">←</button>
      <!-- HERO TARGET: same name as the menu list card -->
      <h1
        class="min-w-0 flex-1 truncate text-xl leading-tight font-bold"
        :style="{ viewTransitionName: 'dish-' + dish.id }"
      >
        {{ dish.name }}
      </h1>
      <BaseButton
        v-if="auth.can('menu', 'edit')"
        variant="ghost"
        @click="router.push({ path: '/menu', query: { edit: dish.id } })"
      >
        {{ t('menu.detail.edit') }}
      </BaseButton>
    </div>

    <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
      <div class="card">
        <div class="text-xs text-smoke">{{ t('menu.detail.price') }}</div>
        <div class="mt-1 text-2xl font-bold">{{ n(dish.price, 'currency') }}</div>
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
          {{ margin.margin != null ? margin.margin.toFixed(1) + '%' : '—' }}
        </div>
        <div class="text-[11px] text-smoke">{{ t('menu.target', { pct: dish.targetMarginPct }) }}</div>
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
                <span class="text-smoke">· {{ t('menu.detail.laborPerPlate', { min: n(row.qty) }) }}</span>
              </template>
              <template v-else-if="row.sub">
                {{ row.sub.name }}
                <span class="text-smoke">· {{ t('menu.detail.subPortions', { qty: n(row.qty) }) }}</span>
              </template>
              <template v-else>
                {{ row.ingredient!.name }}
                <span class="text-smoke">
                  · {{ t('menu.detail.perPlate', { qty: n(row.qty), unit: t('common.unit.' + (row.unit ?? row.ingredient!.unit)) }) }}
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
  </div>
</template>
