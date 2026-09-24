<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useInvoicesStore } from '../stores/invoices'
import { useKitchenStore } from '../stores/kitchen'
import { useAuthStore } from '../stores/auth'
import { realtimeSpend, spendTree, type SpendNode } from '../lib/domain'
import { CHART_COLORS, CHART_REST_COLOR } from '../lib/palette'
import PieChart, { type PieSlice } from './PieChart.vue'

/**
 * Dashboard → Categories tab: hierarchical spend pie with breadcrumbs.
 * Drill path: everything → raw materials (or an expense tag) → category
 * → subcategory → ingredient. Leaves deep-link into Pantry / Vendors.
 */
const { t, n } = useI18n()
const router = useRouter()
const invoicesStore = useInvoicesStore()
const kitchen = useKitchenStore()
const auth = useAuthStore()

const MAX_SLICES = 9

/** realtime: also count approved albaranes no factura covers yet
 * (the dashboard's Facturado / Tiempo real toggle). */
const props = withDefaults(defineProps<{ realtime?: boolean }>(), { realtime: false })

const docs = computed(() =>
  props.realtime
    ? realtimeSpend(invoicesStore.invoices, kitchen.ingredientMap).docs
    : invoicesStore.invoices,
)
const tree = computed(() => spendTree(docs.value, kitchen.expenses, kitchen.ingredientMap))

// The drill state is a path of child keys; the trail re-walks the live
// tree so a data refresh can never leave us pointing at a stale node.
const path = ref<string[]>([])
const trail = computed<SpendNode[]>(() => {
  const nodes = [tree.value]
  let cursor = tree.value
  for (const key of path.value) {
    const next = cursor.children.find((c) => c.key === key)
    if (!next) break
    nodes.push(next)
    cursor = next
  }
  return nodes
})
const current = computed(() => trail.value[trail.value.length - 1])

function nodeLabel(node: SpendNode): string {
  if (node.label) return node.label
  switch (node.kind) {
    case 'root':
      return t('pulse.drill.all')
    case 'food':
      return t('pulse.drill.food')
    case 'category':
      return t('common.category.' + node.key)
    case 'subcategory':
      return t('common.subcategory.' + node.key)
    case 'uncategorized':
      return t('pulse.drill.uncategorized')
    default:
      return node.key
  }
}

/** Where a click on this node leads: deeper, to a page, or nowhere. */
function target(node: SpendNode): 'drill' | 'link' | null {
  if (node.children.length > 0) return 'drill'
  if (node.kind === 'ingredient' && node.ingredientId && kitchen.ingredientMap.has(node.ingredientId))
    return 'link'
  if (node.kind === 'vendor' && auth.can('vendors')) return 'link'
  return null
}

function open(key: string): void {
  const child = current.value.children.find((c) => c.key === key)
  if (!child) return
  const to = target(child)
  // The validated trail (any stale tail already dropped) plus the new key.
  if (to === 'drill') path.value = [...trail.value.slice(1).map((node) => node.key), key]
  else if (to === 'link' && child.kind === 'ingredient') void router.push(`/pantry/${child.ingredientId}`)
  else if (to === 'link') void router.push(`/vendors/${child.key}`)
}

function jumpTo(depth: number): void {
  path.value = path.value.slice(0, depth)
}

interface Row {
  key: string
  label: string
  total: number
  share: number
  color: string
  clickable: boolean
  drills: boolean
}

const rows = computed<Row[]>(() => {
  const kids = current.value.children
  const total = current.value.total || 1
  return kids.map((c, i) => ({
    key: c.key,
    label: nodeLabel(c),
    total: c.total,
    share: c.total / total,
    color: i < MAX_SLICES ? CHART_COLORS[i % CHART_COLORS.length] : CHART_REST_COLOR,
    clickable: target(c) != null,
    drills: target(c) === 'drill',
  }))
})

// Top slices + one aggregated tail slice so the pie stays readable.
const slices = computed<PieSlice[]>(() => {
  const top = rows.value.slice(0, MAX_SLICES).map((r) => ({
    key: r.key,
    label: r.label,
    value: r.total,
    color: r.color,
    clickable: r.clickable,
  }))
  const rest = rows.value.slice(MAX_SLICES)
  if (rest.length > 0) {
    top.push({
      key: '__rest',
      label: t('pulse.drill.rest', { n: rest.length }),
      value: rest.reduce((s, x) => s + x.total, 0),
      color: CHART_REST_COLOR,
      clickable: false,
    })
  }
  return top
})
</script>

<template>
  <div class="card">
    <div class="mb-1 flex items-center justify-between text-sm">
      <span class="font-semibold">{{ t('pulse.drill.title') }}</span>
      <span class="text-[11px] text-smoke">{{ t('pulse.drill.hint') }}</span>
    </div>

    <div v-if="tree.total <= 0" class="py-8 text-center text-sm text-smoke">
      {{ t('pulse.drill.empty') }}
    </div>

    <template v-else>
      <!-- Breadcrumbs: every ancestor is one tap away -->
      <nav class="mb-3 flex flex-wrap items-center gap-1 text-xs" :aria-label="t('pulse.drill.title')">
        <template v-for="(node, i) in trail" :key="i">
          <span v-if="i > 0" class="text-gray-300">›</span>
          <span v-if="i === trail.length - 1" class="font-semibold text-ink" aria-current="page">
            {{ nodeLabel(node) }}
          </span>
          <button v-else class="text-smoke underline decoration-gray-300 hover:text-ember-700" @click="jumpTo(i)">
            {{ nodeLabel(node) }}
          </button>
        </template>
      </nav>

      <Transition name="fade" mode="out-in">
        <div :key="trail.length + ':' + current.key" class="grid items-center gap-4 md:grid-cols-2">
          <PieChart
            :slices="slices"
            :center-value="n(current.total, 'currency')"
            :center-label="nodeLabel(current)"
            :aria-label="t('pulse.drill.title') + ' · ' + nodeLabel(current)"
            @select="open"
          />

          <!-- Ranked list: doubles as the legend and reaches the tail
               slices the pie aggregates away -->
          <div class="space-y-2">
            <component
              :is="row.clickable ? 'button' : 'div'"
              v-for="row in rows"
              :key="row.key"
              class="block w-full text-left"
              :class="row.clickable ? 'group cursor-pointer' : ''"
              @click="row.clickable && open(row.key)"
            >
              <div class="mb-0.5 flex items-center justify-between gap-2 text-xs">
                <span class="flex min-w-0 items-center gap-1.5">
                  <span class="h-2 w-2 shrink-0 rounded-full" :style="{ background: row.color }" />
                  <span class="truncate font-medium group-hover:text-ember-700">{{ row.label }}</span>
                  <span v-if="row.drills" class="text-gray-300 group-hover:text-ember-700">›</span>
                </span>
                <span class="shrink-0 text-smoke">
                  {{ n(row.total, 'currency') }} · {{ n(row.share, 'percent') }}
                </span>
              </div>
              <div class="h-1.5 rounded-full bg-gray-100">
                <div
                  class="h-1.5 rounded-full"
                  :style="{ width: Math.max(2, row.share * 100) + '%', background: row.color }"
                />
              </div>
            </component>
          </div>
        </div>
      </Transition>
    </template>
  </div>
</template>
