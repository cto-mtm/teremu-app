<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { armHero, heroStyle } from '../composables/useHero'
import { currencySymbol } from '../i18n'
import { useKitchenStore } from '../stores/kitchen'
import { useAuthStore } from '../stores/auth'
import { useListingStore } from '../stores/listing'
import { useSettingsStore } from '../stores/settings'
import { actualMarginPct } from '../lib/domain'
import { compatibleUnits } from '../lib/units'
import { CATEGORIES, type Category, type MenuItem, type RecipeLine, type Unit } from '../lib/types'
import BaseButton from '../components/BaseButton.vue'
import MenuScanWizard from '../components/MenuScanWizard.vue'
import PageLoader from '../components/PageLoader.vue'

/**
 * Menu Margin Mapping — every dish costed from this week's rolling
 * vendor prices. Dishes drifting under their target get flagged. The
 * second tab holds the preps (stocks, sauces…) dishes are built from —
 * docs/prep-recipes.md.
 */
const { t, n } = useI18n()
const route = useRoute()
const router = useRouter()
const kitchen = useKitchenStore()
const auth = useAuthStore()
const listing = useListingStore()

// Photo-of-the-menu import wizard (see MenuScanWizard.vue)
const wizardOpen = ref(false)

// Dishes imported from the restaurant's website have prices but no recipe
// yet (docs/restaurant-listing.md). The same wizard drafts them, in place.
const needRecipes = computed(() =>
  kitchen.dishes.filter((m) => m.origin === 'listing' && m.recipe.length === 0),
)

// Dishes (sold, with margins) or preps (batch recipes used inside them).
// /menu?tab=preps opens the second one (the prep detail page links back).
const tab = ref<'dishes' | 'preps'>(route.query.tab === 'preps' ? 'preps' : 'dishes')
const recipeSeed = ref<{ key: string; name: string; price: number | null; menuItemId: string }[] | undefined>()
function estimateImported(): void {
  recipeSeed.value = needRecipes.value.map((m) => ({ key: m.id, name: m.name, price: m.price, menuItemId: m.id }))
  wizardOpen.value = true
}
watch(wizardOpen, (isOpen) => {
  if (isOpen) return
  recipeSeed.value = undefined
  listing.handoff = false // the first-login tour may open now (AppShell)
})
// Deep link from the setup "done" screen: /menu?recipes=listing.
watch(
  () => [route.query.recipes, needRecipes.value.length] as const,
  ([flag, count]) => {
    if (flag !== 'listing' || !count || wizardOpen.value) return
    void router.replace({ query: {} })
    if (auth.can('menu', 'edit')) estimateImported()
  },
  { immediate: true },
)

// ── Search / sort ───────────────────────────────────────────────
const search = ref('')
const sortBy = ref<'margin' | 'name' | 'price'>('margin')

const menuMap = computed(() => new Map(kitchen.menuItems.map((m) => [m.id, m])))
// Restaurant labor rate (Settings) — 0/unset keeps costs ingredients-only.
const laborRate = computed(() => auth.profile?.laborRatePerHour ?? 0)

const rows = computed(() => {
  const q = search.value.toLowerCase().trim()
  const list = kitchen.dishes
    .filter((m) => !q || m.name.toLowerCase().includes(q))
    .map((m) => ({ m, ...actualMarginPct(m, kitchen.ingredientMap, menuMap.value, laborRate.value) }))
  switch (sortBy.value) {
    case 'name':
      return list.sort((a, b) => a.m.name.localeCompare(b.m.name))
    case 'price':
      return list.sort((a, b) => b.m.price - a.m.price)
    default:
      // worst margin first — the dishes that need attention
      return list.sort((a, b) => (a.margin ?? 999) - (b.margin ?? 999))
  }
})

/** Preps with what one batch costs, per yield unit, and how many recipes use it. */
const prepRows = computed(() => {
  const q = search.value.toLowerCase().trim()
  return kitchen.preps
    .filter((m) => !q || m.name.toLowerCase().includes(q))
    .map((m) => {
      const { cost, missing } = actualMarginPct(m, kitchen.ingredientMap, menuMap.value, laborRate.value)
      const usedIn = kitchen.activeMenuItems.filter((d) => d.recipe.some((r) => r.subItemId === m.id)).length
      return { m, cost, missing, unitCost: m.yield?.qty ? cost / m.yield.qty : null, usedIn }
    })
    .sort((a, b) => a.m.name.localeCompare(b.m.name))
})

// ── Dish / prep editor sheet ────────────────────────────────────
const editing = ref<MenuItem | 'new' | null>(null)
const kind = ref<'dish' | 'prep'>('dish')
const yieldQty = ref('')
const yieldUnit = ref<Unit>('L')
const name = ref('')
const price = ref('')
const target = ref('70')
const prepMin = ref('')
const recipe = ref<RecipeLine[]>([])
const busy = ref(false)

// Deep link: /menu?edit=<id> opens the dish editor (used by the
// Pulse matrix dots and margin alerts).
watch(
  () => [route.query.edit, kitchen.menuItems] as const,
  ([editId]) => {
    if (typeof editId === 'string' && !editing.value) {
      const item = kitchen.menuItems.find((m) => m.id === editId)
      if (item) openEditor(item)
    }
  },
  { immediate: true },
)

function closeEditor(): void {
  editing.value = null
  if (route.query.edit) void router.replace({ query: {} })
}

/** Other active items usable as sub-recipes (excluding the one open):
 * preps first — that is what they are for — then dishes. */
const notOpen = (m: MenuItem) => editing.value === 'new' || m.id !== editing.value?.id
const prepChoices = computed(() => kitchen.preps.filter(notOpen))
const dishChoices = computed(() => kitchen.dishes.filter(notOpen))

/** The item a sub-recipe line points at. */
const subOf = (line: RecipeLine): MenuItem | undefined =>
  line.subItemId ? menuMap.value.get(line.subItemId) : undefined

/** Encode a line's component for the single select. */
function lineValue(line: RecipeLine): string {
  if (line.subItemId) return `sub:${line.subItemId}`
  if (line.ingredientId) return `ing:${line.ingredientId}`
  return ''
}

/** Decode the pick: ingredient, sub-recipe, or inline quick-create. */
function onPick(line: RecipeLine, index: number, event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  if (value === '__create__') {
    line.ingredientId = undefined
    line.subItemId = undefined
    creatingFor.value = index
    return
  }
  if (value.startsWith('sub:')) {
    line.subItemId = value.slice(4)
    line.ingredientId = undefined
    // A prep is used by an amount of its yield (ml of a stock); anything
    // without a yield by portions.
    line.unit = subOf(line)?.yield?.unit
    return
  }
  if (value.startsWith('ing:')) {
    line.ingredientId = value.slice(4)
    line.subItemId = undefined
    const ing = kitchen.ingredientMap.get(line.ingredientId)
    if (ing) line.unit = ing.unit
    return
  }
  line.ingredientId = undefined
  line.subItemId = undefined
}

// ── Inline ingredient quick-create (cold-start flow) ────────────
const settings = useSettingsStore()
const creatingFor = ref<number | null>(null)
const newIngName = ref('')
const newIngUnit = ref<Unit>('kg')
const newIngCategory = ref<Category>('other')
const newIngBusy = ref(false)

async function confirmCreateIngredient(): Promise<void> {
  if (creatingFor.value === null) return
  newIngBusy.value = true
  const created = await kitchen.addIngredient(
    newIngName.value.trim(),
    newIngUnit.value,
    newIngCategory.value,
  )
  newIngBusy.value = false
  if (created) {
    const line = recipe.value[creatingFor.value]
    if (line) {
      line.ingredientId = created.id
      line.subItemId = undefined
      line.unit = created.unit
    }
    creatingFor.value = null
    newIngName.value = ''
  } else {
    alert(kitchen.error?.includes('exists') ? t('menu.editor.ingredientExists') : t('menu.editor.ingredientFailed'))
  }
}

function openEditor(item: MenuItem | 'new'): void {
  editing.value = item
  if (item === 'new') {
    kind.value = tab.value === 'preps' ? 'prep' : 'dish'
    yieldQty.value = ''
    yieldUnit.value = 'L'
    name.value = ''
    price.value = ''
    target.value = '70'
    prepMin.value = ''
    recipe.value = []
  } else {
    kind.value = item.kind ?? 'dish'
    yieldQty.value = item.yield ? String(item.yield.qty) : ''
    yieldUnit.value = item.yield?.unit ?? 'L'
    name.value = item.name
    price.value = String(item.price)
    target.value = String(item.targetMarginPct)
    prepMin.value = item.prepMinutes ? String(item.prepMinutes) : ''
    // Legacy ingredient lines have no unit — default to the stock unit
    // so the unit select isn't blank. Sub-recipe lines carry none.
    recipe.value = item.recipe.map((r) => ({
      ...r,
      unit: r.unit ?? (r.ingredientId ? kitchen.ingredientMap.get(r.ingredientId)?.unit : undefined),
    }))
  }
}

const isPrep = computed(() => kind.value === 'prep')
const canSave = computed(() => !!name.value.trim() && (!isPrep.value || Number(yieldQty.value) > 0))

async function save(): Promise<void> {
  busy.value = true
  const ok = await kitchen.saveMenuItem(
    {
      name: name.value.trim(),
      kind: kind.value,
      // The API stores a prep's price and target as 0 and a dish's yield
      // as nothing; send the shape the server keeps.
      yield: isPrep.value ? { qty: Number(yieldQty.value), unit: yieldUnit.value } : undefined,
      price: isPrep.value ? 0 : Number(price.value) || 0,
      targetMarginPct: isPrep.value ? 0 : Number(target.value) || 0,
      // Omitted when blank/0 — PUT replaces the doc, so the field clears.
      ...(Number(prepMin.value) > 0 ? { prepMinutes: Number(prepMin.value) } : {}),
      recipe: recipe.value
        .filter((r) => (r.ingredientId || r.subItemId) && r.qty > 0)
        .map((r) => ({
          ...(r.ingredientId ? { ingredientId: r.ingredientId } : {}),
          ...(r.subItemId ? { subItemId: r.subItemId } : {}),
          qty: r.qty,
          // A sub line keeps its unit only when the sub has a yield to measure.
          ...(r.unit && (r.ingredientId || subOf(r)?.yield) ? { unit: r.unit } : {}),
        })),
      active: true,
    },
    editing.value === 'new' ? undefined : editing.value?.id,
  )
  busy.value = false
  if (ok) {
    tab.value = isPrep.value ? 'preps' : 'dishes' // land where the item now lives
    closeEditor()
  } else alert(t('menu.editor.saveFailed'))
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <h1 class="text-xl font-bold">{{ t('menu.title') }}</h1>
      <div v-if="auth.can('menu', 'edit')" class="flex flex-wrap gap-2">
        <BaseButton @click="wizardOpen = true">
          <span class="inline-flex items-center gap-1.5">
            <svg viewBox="0 0 24 24" class="h-4 w-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" />
              <circle cx="12" cy="13" r="3" />
            </svg>
            {{ t('menu.scan.cta') }}
          </span>
        </BaseButton>
        <BaseButton variant="ghost" @click="openEditor('new')">
          + {{ tab === 'preps' ? t('menu.addPrep') : t('menu.addDish') }}
        </BaseButton>
      </div>
    </div>

    <!-- Dishes / preps -->
    <div class="flex gap-1 rounded-xl bg-gray-100 p-1" role="tablist" :aria-label="t('menu.title')">
      <button
        v-for="tb in (['dishes', 'preps'] as const)"
        :key="tb"
        role="tab"
        :aria-selected="tab === tb"
        class="flex-1 rounded-lg px-3 py-1.5 text-sm font-medium sm:flex-none"
        :class="tab === tb ? 'bg-white text-ink shadow-sm' : 'text-smoke hover:text-ink'"
        @click="tab = tb"
      >
        {{ t('menu.tabs.' + tb) }}
        <span v-if="tb === 'preps' && kitchen.preps.length" class="text-xs text-smoke">· {{ kitchen.preps.length }}</span>
      </button>
    </div>

    <!-- Imported dishes still without a recipe → draft them. Kept OUT of
         the loader/toolbar v-if chain below so search and sort stay. -->
    <div
      v-if="tab === 'dishes' && needRecipes.length && auth.can('menu', 'edit')"
      class="card flex flex-wrap items-center justify-between gap-3 !py-3"
    >
      <p class="text-sm">
        <span aria-hidden="true">📖</span>
        {{ t('menu.listing.needRecipes', { n: needRecipes.length }, needRecipes.length) }}
      </p>
      <BaseButton @click="estimateImported">✨ {{ t('menu.listing.estimate') }}</BaseButton>
    </div>

    <PageLoader v-if="kitchen.loading && !kitchen.menuItems.length" :cards="0" :lines="4" />

    <div v-else-if="(tab === 'preps' ? kitchen.preps : kitchen.dishes).length > 0" class="flex flex-wrap gap-2">
      <input v-model="search" class="input min-w-40 flex-1" :placeholder="t('common.filter.search')" />
      <select v-if="tab === 'dishes'" v-model="sortBy" class="input w-auto">
        <option value="margin">{{ t('common.filter.sortMargin') }}</option>
        <option value="name">{{ t('common.filter.sortName') }}</option>
        <option value="price">{{ t('common.filter.sortPrice') }}</option>
      </select>
    </div>

    <template v-if="tab === 'preps'">
      <p class="text-xs text-smoke">{{ t('menu.prep.intro') }}</p>
      <div v-if="!kitchen.loading && kitchen.preps.length === 0" class="card space-y-3 py-10 text-center text-sm text-smoke">
        <p>{{ t('menu.prep.empty') }}</p>
        <BaseButton v-if="auth.can('menu', 'edit')" @click="openEditor('new')">+ {{ t('menu.addPrep') }}</BaseButton>
      </div>
      <div v-else-if="prepRows.length === 0" class="card py-8 text-center text-sm text-smoke">
        {{ t('common.filter.noResults') }}
      </div>
      <div class="space-y-2">
        <RouterLink
          v-for="{ m, cost, missing, unitCost, usedIn } in prepRows"
          :key="m.id"
          :to="`/menu/${m.id}`"
          class="card block w-full text-left hover:border-ember/40"
          @click="armHero('dish', m.id)"
        >
          <div class="flex items-center justify-between gap-3">
            <div class="min-w-0">
              <div class="font-semibold" :style="heroStyle('dish', m.id)">{{ m.name }}</div>
              <div class="mt-0.5 text-xs text-smoke">
                <template v-if="m.yield">{{ t('menu.prep.yields', { qty: n(m.yield.qty), unit: t('common.unit.' + m.yield.unit) }) }} · </template>
                {{ t('menu.prep.batchCost', { cost: n(cost, 'currency') }) }}<template v-if="missing"> · {{ t('menu.unpriced') }}</template>
              </div>
            </div>
            <div class="shrink-0 text-right">
              <div v-if="unitCost != null && m.yield" class="font-bold">
                {{ t('menu.prep.unitCost', { cost: n(unitCost, 'currency'), unit: t('common.unit.' + m.yield.unit) }) }}
              </div>
              <div class="text-[11px]" :class="usedIn ? 'text-smoke' : 'text-ember-700'">
                {{ t('menu.prep.usedIn', { n: usedIn }, usedIn) }}
              </div>
            </div>
          </div>
        </RouterLink>
      </div>
    </template>

    <template v-else>
    <div v-if="!kitchen.loading && kitchen.dishes.length === 0" class="card space-y-3 py-10 text-center text-sm text-smoke">
      <p>{{ t('menu.empty') }}</p>
      <BaseButton v-if="auth.can('menu', 'edit')" @click="wizardOpen = true">
        <span class="inline-flex items-center gap-1.5">
          <svg viewBox="0 0 24 24" class="h-4 w-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" />
            <circle cx="12" cy="13" r="3" />
          </svg>
          {{ t('menu.scan.cta') }}
        </span>
      </BaseButton>
      <!-- Owners can bring their menu in from their website / Google listing -->
      <div v-if="auth.profile?.role === 'owner' && auth.profile.listingAvailable">
        <RouterLink :to="{ name: 'restaurant-setup' }" class="text-xs font-semibold text-ember-700 hover:underline">
          🌐 {{ t('menu.listing.importCta') }}
        </RouterLink>
      </div>
    </div>
    <div v-else-if="rows.length === 0" class="card py-8 text-center text-sm text-smoke">
      {{ t('common.filter.noResults') }}
    </div>

    <div class="space-y-2">
      <RouterLink
        v-for="{ m, margin, cost, missing } in rows"
        :key="m.id"
        :to="`/menu/${m.id}`"
        class="card block w-full text-left hover:border-ember/40"
        @click="armHero('dish', m.id)"
      >
        <div class="flex items-center justify-between gap-3">
          <div class="min-w-0">
            <!-- HERO SOURCE: morphs into the dish detail title -->
            <div
              class="flex items-center gap-2 font-semibold"
              :style="heroStyle('dish', m.id)"
            >
              {{ m.name }}
              <span v-if="margin != null && margin < m.targetMarginPct" class="shrink-0 text-coral">●</span>
            </div>
            <div class="mt-0.5 text-xs text-smoke">
              {{ t('menu.plateCost', { cost: n(cost, 'currency') }) }}<template v-if="missing"> · {{ t('menu.unpriced') }}</template>
              · {{ t('menu.sellsAt', { price: n(m.price, 'currency') }) }}
            </div>
          </div>
          <div class="shrink-0 text-right">
            <div class="font-bold" :class="margin != null && margin < m.targetMarginPct ? 'text-coral-600' : 'text-herb-700'">
              {{ margin != null ? n(margin / 100, 'percent') : '—' }}
            </div>
            <div class="text-[11px] text-smoke">{{ t('menu.target', { pct: n(m.targetMarginPct / 100, 'percentWhole') }) }}</div>
          </div>
        </div>

        <!-- target vs actual margin bar -->
        <div class="relative mt-3 h-2 overflow-hidden rounded-full bg-gray-100">
          <div
            class="absolute inset-y-0 left-0 rounded-full"
            :class="margin != null && margin < m.targetMarginPct ? 'bg-coral' : 'bg-herb'"
            :style="{ width: Math.max(0, Math.min(100, margin ?? 0)) + '%' }"
          />
          <div
            class="absolute inset-y-0 w-0.5 bg-ink/60"
            :style="{ left: m.targetMarginPct + '%' }"
            :title="t('menu.targetMarker', { pct: n(m.targetMarginPct / 100, 'percentWhole') })"
          />
        </div>
      </RouterLink>
    </div>
    </template>

    <MenuScanWizard v-model="wizardOpen" :seed="recipeSeed" :title="recipeSeed ? t('menu.listing.wizardTitle') : undefined" />

    <!-- Dish editor (within-page overlay) -->
    <Transition name="list">
      <div
        v-if="editing"
        class="fixed inset-0 z-40 flex items-end justify-center bg-black/30 backdrop-blur-sm sm:items-center"
        @click="closeEditor"
      >
        <div
          class="max-h-[85vh] w-full space-y-4 overflow-auto rounded-t-2xl bg-white/95 p-5 backdrop-blur-md sm:max-w-md sm:rounded-2xl"
          @click.stop
        >
          <h2 class="text-lg font-bold">
            <template v-if="isPrep">{{ editing === 'new' ? t('menu.editor.newPrepTitle') : t('menu.editor.editPrepTitle') }}</template>
            <template v-else>{{ editing === 'new' ? t('menu.editor.newTitle') : t('menu.editor.editTitle') }}</template>
          </h2>
          <!-- Dish or prep: also how an existing "dish" that is really a
               stock or sauce becomes a prep (docs/prep-recipes.md § Migration) -->
          <div class="inline-flex gap-1 rounded-full bg-gray-100 p-1 text-sm" role="radiogroup" :aria-label="t('menu.editor.kindLabel')">
            <button
              v-for="k in (['dish', 'prep'] as const)"
              :key="k"
              role="radio"
              :aria-checked="kind === k"
              class="rounded-full px-4 py-1.5 font-medium transition-colors"
              :class="kind === k ? 'bg-white text-ink shadow-sm' : 'text-smoke'"
              @click="kind = k"
            >
              {{ k === 'prep' ? t('menu.editor.kindPrep') : t('menu.editor.kindDish') }}
            </button>
          </div>
          <input v-model="name" class="input" :placeholder="isPrep ? t('menu.editor.prepName') : t('menu.editor.dishName')" />
          <div v-if="isPrep" class="grid grid-cols-2 gap-3">
            <label class="space-y-1 text-sm">
              <span class="text-xs text-smoke">{{ t('menu.editor.yieldQty') }}</span>
              <input v-model="yieldQty" type="number" inputmode="decimal" min="0" class="input" />
            </label>
            <label class="space-y-1 text-sm">
              <span class="text-xs text-smoke">{{ t('common.label.unit') }}</span>
              <select v-model="yieldUnit" class="input" :aria-label="t('common.label.unit')">
                <option v-for="u in settings.unitChoices" :key="u" :value="u">{{ t('common.unit.' + u) }}</option>
              </select>
            </label>
          </div>
          <div v-else class="grid grid-cols-2 gap-3">
            <label class="space-y-1 text-sm">
              <span class="text-xs text-smoke">{{ t('menu.editor.menuPrice', { symbol: currencySymbol }) }}</span>
              <input v-model="price" type="number" inputmode="decimal" class="input" />
            </label>
            <label class="space-y-1 text-sm">
              <span class="text-xs text-smoke">{{ t('menu.editor.targetMargin') }}</span>
              <input v-model="target" type="number" inputmode="numeric" class="input" />
            </label>
          </div>
          <label class="block space-y-1 text-sm">
            <span class="text-xs text-smoke">{{ isPrep ? t('menu.editor.prepMinutesBatch') : t('menu.editor.prepMinutes') }}</span>
            <input v-model="prepMin" type="number" inputmode="numeric" min="0" class="input" />
            <span v-if="!laborRate" class="block text-[11px] text-smoke">
              {{ t('menu.editor.prepMinutesHint') }}
            </span>
          </label>

          <div class="space-y-2">
            <div class="text-xs text-smoke">
              {{ isPrep ? t('menu.editor.ingredientsPerBatch') : t('menu.editor.ingredientsPerPlate') }}
            </div>
            <div v-for="(line, i) in recipe" :key="i" class="space-y-2">
              <div class="flex items-center gap-2">
              <select :value="lineValue(line)" class="input flex-1" @change="onPick(line, i, $event)">
                <option value="">{{ t('menu.editor.selectIngredient') }}</option>
                <option value="__create__">{{ t('menu.editor.createNew') }}</option>
                <optgroup v-if="prepChoices.length" :label="t('menu.editor.groupPreps')">
                  <option v-for="sub in prepChoices" :key="sub.id" :value="'sub:' + sub.id">
                    {{ sub.name }}
                  </option>
                </optgroup>
                <optgroup v-if="dishChoices.length" :label="t('menu.editor.groupSubs')">
                  <option v-for="sub in dishChoices" :key="sub.id" :value="'sub:' + sub.id">
                    {{ sub.name }}
                  </option>
                </optgroup>
                <optgroup :label="t('menu.editor.groupIngredients')">
                  <option v-for="ing in kitchen.ingredients" :key="ing.id" :value="'ing:' + ing.id">
                    {{ ing.name }} ({{ n(ing.lastUnitPrice ?? 0, 'currency') }}/{{ t('common.unit.' + ing.unit) }})
                  </option>
                </optgroup>
              </select>
              <input
                v-model.number="line.qty"
                type="number"
                inputmode="decimal"
                step="0.01"
                class="input w-20 text-center"
                :placeholder="t('menu.editor.qtyPlaceholder')"
              />
              <!-- Recipe unit: anything convertible to the stock unit
                   (g for an ingredient bought in kg, ml for L, …) -->
              <select
                v-if="line.ingredientId && kitchen.ingredientMap.get(line.ingredientId)"
                v-model="line.unit"
                class="input w-24"
                :aria-label="t('common.label.unit')"
              >
                <option
                  v-for="u in compatibleUnits(kitchen.ingredientMap.get(line.ingredientId)!.unit)"
                  :key="u"
                  :value="u"
                >
                  {{ t('common.unit.' + u) }}
                </option>
              </select>
              <!-- A prep is measured in its yield's dimension (ml of a stock in L) -->
              <select
                v-else-if="subOf(line)?.yield && line.unit"
                v-model="line.unit"
                class="input w-24"
                :aria-label="t('common.label.unit')"
              >
                <option v-for="u in compatibleUnits(subOf(line)!.yield!.unit)" :key="u" :value="u">
                  {{ t('common.unit.' + u) }}
                </option>
              </select>
              <span v-else-if="line.subItemId" class="w-24 text-center text-xs text-smoke">
                {{ t('menu.editor.portions') }}
              </span>
              </div>

              <!-- Inline quick-create: name + unit + category, no modal -->
              <div
                v-if="creatingFor === i"
                class="flex flex-wrap items-center gap-2 rounded-xl bg-ember-50 p-2"
              >
                <input
                  v-model="newIngName"
                  class="input min-w-32 flex-1"
                  :placeholder="t('common.label.ingredientName')"
                />
                <select v-model="newIngUnit" class="input w-auto" :aria-label="t('common.label.unit')">
                  <option v-for="u in settings.unitChoices" :key="u" :value="u">{{ t('common.unit.' + u) }}</option>
                </select>
                <select v-model="newIngCategory" class="input w-auto" :aria-label="t('common.filter.allCategories')">
                  <option v-for="c in CATEGORIES" :key="c" :value="c">{{ t('common.category.' + c) }}</option>
                </select>
                <button
                  class="btn-herb px-3 py-2 text-xs"
                  :disabled="newIngBusy || !newIngName.trim()"
                  @click="confirmCreateIngredient"
                >
                  {{ newIngBusy ? t('common.action.saving') : t('menu.editor.createConfirm') }}
                </button>
                <button class="text-xs text-smoke hover:text-ink" @click="creatingFor = null">
                  {{ t('common.action.cancel') }}
                </button>
              </div>
            </div>
            <button class="btn-ghost w-full" @click="recipe.push({ ingredientId: '', qty: 0 })">
              + {{ t('menu.editor.addIngredient') }}
            </button>
            <div v-if="kitchen.ingredients.length === 0" class="text-xs text-smoke">
              {{ t('menu.editor.noIngredientsHint') }}
            </div>
          </div>

          <BaseButton variant="herb" class="w-full py-3" :disabled="busy || !canSave" @click="save">
            {{ busy ? t('common.action.saving') : t('common.action.save') }}
          </BaseButton>
        </div>
      </div>
    </Transition>
  </div>
</template>
