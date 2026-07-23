<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useKitchenStore } from '../stores/kitchen'
import { useAuthStore } from '../stores/auth'
import { useSettingsStore } from '../stores/settings'
import { actualMarginPct } from '../lib/domain'
import { compatibleUnits } from '../lib/units'
import { CATEGORIES, type Category, type MenuItem, type RecipeLine, type Unit } from '../lib/types'
import BaseButton from '../components/BaseButton.vue'
import MenuScanWizard from '../components/MenuScanWizard.vue'

/**
 * Menu Margin Mapping — every dish costed from this week's rolling
 * vendor prices. Dishes drifting under their target get flagged.
 */
const { t, n } = useI18n()
const route = useRoute()
const router = useRouter()
const kitchen = useKitchenStore()
const auth = useAuthStore()

// Photo-of-the-menu import wizard (see MenuScanWizard.vue)
const wizardOpen = ref(false)

// ── Search / sort ───────────────────────────────────────────────
const search = ref('')
const sortBy = ref<'margin' | 'name' | 'price'>('margin')

const menuMap = computed(() => new Map(kitchen.menuItems.map((m) => [m.id, m])))

const rows = computed(() => {
  const q = search.value.toLowerCase().trim()
  const list = kitchen.activeMenuItems
    .filter((m) => !q || m.name.toLowerCase().includes(q))
    .map((m) => ({ m, ...actualMarginPct(m, kitchen.ingredientMap, menuMap.value) }))
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

// ── Dish editor sheet ───────────────────────────────────────────
const editing = ref<MenuItem | 'new' | null>(null)
const name = ref('')
const price = ref('')
const target = ref('70')
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

/** Other active dishes usable as sub-recipes (excluding the one open). */
const subChoices = computed(() =>
  kitchen.activeMenuItems.filter((m) => editing.value === 'new' || m.id !== editing.value?.id),
)

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
    line.unit = undefined // sub-recipe qty is portions
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
    alert(kitchen.error?.includes('exists') ? t('pantry.add.exists') : t('pantry.add.failed'))
  }
}

function openEditor(item: MenuItem | 'new'): void {
  editing.value = item
  if (item === 'new') {
    name.value = ''
    price.value = ''
    target.value = '70'
    recipe.value = []
  } else {
    name.value = item.name
    price.value = String(item.price)
    target.value = String(item.targetMarginPct)
    // Legacy ingredient lines have no unit — default to the stock unit
    // so the unit select isn't blank. Sub-recipe lines carry none.
    recipe.value = item.recipe.map((r) => ({
      ...r,
      unit: r.unit ?? (r.ingredientId ? kitchen.ingredientMap.get(r.ingredientId)?.unit : undefined),
    }))
  }
}

async function save(): Promise<void> {
  busy.value = true
  const ok = await kitchen.saveMenuItem(
    {
      name: name.value.trim(),
      price: Number(price.value) || 0,
      targetMarginPct: Number(target.value) || 0,
      recipe: recipe.value
        .filter((r) => (r.ingredientId || r.subItemId) && r.qty > 0)
        .map((r) => ({
          ...(r.ingredientId ? { ingredientId: r.ingredientId } : {}),
          ...(r.subItemId ? { subItemId: r.subItemId } : {}),
          qty: r.qty,
          ...(r.unit && r.ingredientId ? { unit: r.unit } : {}),
        })),
      active: true,
    },
    editing.value === 'new' ? undefined : editing.value?.id,
  )
  busy.value = false
  if (ok) closeEditor()
  else alert(t('menu.editor.saveFailed'))
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <h1 class="text-xl font-bold">{{ t('menu.title') }}</h1>
      <div v-if="auth.can('menu', 'edit')" class="flex gap-2">
        <BaseButton @click="wizardOpen = true">
          <span class="inline-flex items-center gap-1.5">
            <svg viewBox="0 0 24 24" class="h-4 w-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" />
              <circle cx="12" cy="13" r="3" />
            </svg>
            {{ t('menu.scan.cta') }}
          </span>
        </BaseButton>
        <BaseButton variant="ghost" @click="openEditor('new')">+ {{ t('menu.addDish') }}</BaseButton>
      </div>
    </div>

    <div v-if="kitchen.activeMenuItems.length > 0" class="flex flex-wrap gap-2">
      <input v-model="search" class="input min-w-40 flex-1" :placeholder="t('common.filter.search')" />
      <select v-model="sortBy" class="input w-auto">
        <option value="margin">{{ t('common.filter.sortMargin') }}</option>
        <option value="name">{{ t('common.filter.sortName') }}</option>
        <option value="price">{{ t('common.filter.sortPrice') }}</option>
      </select>
    </div>

    <div v-if="kitchen.activeMenuItems.length === 0" class="card space-y-3 py-10 text-center text-sm text-smoke">
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
      >
        <div class="flex items-center justify-between gap-3">
          <div class="min-w-0">
            <!-- HERO SOURCE: morphs into the dish detail title -->
            <div
              class="flex items-center gap-2 font-semibold"
              :style="{ viewTransitionName: 'dish-' + m.id }"
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
              {{ margin != null ? margin.toFixed(1) + '%' : '—' }}
            </div>
            <div class="text-[11px] text-smoke">{{ t('menu.target', { pct: m.targetMarginPct }) }}</div>
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
            :title="t('menu.targetMarker', { pct: m.targetMarginPct })"
          />
        </div>
      </RouterLink>
    </div>

    <MenuScanWizard v-model="wizardOpen" />

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
            {{ editing === 'new' ? t('menu.editor.newTitle') : t('menu.editor.editTitle') }}
          </h2>
          <input v-model="name" class="input" :placeholder="t('menu.editor.dishName')" />
          <div class="grid grid-cols-2 gap-3">
            <label class="space-y-1 text-sm">
              <span class="text-xs text-smoke">{{ t('menu.editor.menuPrice') }}</span>
              <input v-model="price" type="number" inputmode="decimal" class="input" />
            </label>
            <label class="space-y-1 text-sm">
              <span class="text-xs text-smoke">{{ t('menu.editor.targetMargin') }}</span>
              <input v-model="target" type="number" inputmode="numeric" class="input" />
            </label>
          </div>

          <div class="space-y-2">
            <div class="text-xs text-smoke">{{ t('menu.editor.ingredientsPerPlate') }}</div>
            <div v-for="(line, i) in recipe" :key="i" class="space-y-2">
              <div class="flex items-center gap-2">
              <select :value="lineValue(line)" class="input flex-1" @change="onPick(line, i, $event)">
                <option value="">{{ t('menu.editor.selectIngredient') }}</option>
                <option value="__create__">{{ t('menu.editor.createNew') }}</option>
                <optgroup v-if="subChoices.length" :label="t('menu.editor.groupSubs')">
                  <option v-for="sub in subChoices" :key="sub.id" :value="'sub:' + sub.id">
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
                :aria-label="t('triage.detail.unit')"
              >
                <option
                  v-for="u in compatibleUnits(kitchen.ingredientMap.get(line.ingredientId)!.unit)"
                  :key="u"
                  :value="u"
                >
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
                  :placeholder="t('pantry.add.name')"
                />
                <select v-model="newIngUnit" class="input w-auto" :aria-label="t('triage.detail.unit')">
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

          <BaseButton variant="herb" class="w-full py-3" :disabled="busy || !name.trim()" @click="save">
            {{ busy ? t('common.action.saving') : t('common.action.save') }}
          </BaseButton>
        </div>
      </div>
    </Transition>
  </div>
</template>
