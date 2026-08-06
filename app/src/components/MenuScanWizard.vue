<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { apiFetch, apiUpload } from '../lib/api'
import { compressReceipt } from '../lib/compress'
import { normalizeName } from '../lib/domain'
import { convertQty } from '../lib/units'
import { menuScanResponseSchema, recipeDraftsResponseSchema } from '../lib/schemas'
import { useKitchenStore } from '../stores/kitchen'
import type { DraftLine, Unit } from '../lib/types'
import BaseButton from './BaseButton.vue'

/**
 * Menu-scan wizard — the anti-Haddock setup flow. Photo of the printed
 * menu → AI extracts every dish+price → tap-to-import → one batch AI
 * call drafts recipes from the pantry (which already knows real prices)
 * → tweak quantities → save. A 40-dish menu is live, with margins,
 * in a couple of minutes instead of an evening of dropdowns.
 */
const { t, n } = useI18n()
const kitchen = useKitchenStore()
const open = defineModel<boolean>({ required: true })

type Step = 'capture' | 'pick' | 'drafts' | 'done'
const step = ref<Step>('capture')
const busy = ref(false)
const saving = ref(false)
const errorMsg = ref('')

interface WizardDish {
  name: string
  price: string // editable as text
  section: string | null
  selected: boolean
  lines: DraftLine[]
}
const dishes = ref<WizardDish[]>([])
const selected = computed(() => dishes.value.filter((d) => d.selected))
const savedCount = ref(0)
const saveProgress = ref(0)

function reset(): void {
  step.value = 'capture'
  dishes.value = []
  errorMsg.value = ''
  busy.value = false
  savedCount.value = 0
}

function close(): void {
  open.value = false
  reset()
}

// ── Step 1: capture ─────────────────────────────────────────────
async function onPhoto(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = '' // same file can be re-picked after an error
  if (!file) return
  busy.value = true
  errorMsg.value = ''
  try {
    const blob = await compressReceipt(file)
    const res = await apiUpload('/menu/scan', blob, menuScanResponseSchema)
    if (!res.ok) {
      errorMsg.value = res.error.includes('not_a_menu')
        ? t('menu.scan.notMenu')
        : res.error.includes('unreadable')
          ? t('menu.scan.unreadable')
          : t('menu.scan.scanFailed')
      return
    }
    // Accumulate across pages, dedupe by normalized name.
    const seen = new Set(dishes.value.map((d) => normalizeName(d.name)))
    for (const d of res.data.dishes) {
      if (seen.has(normalizeName(d.name))) continue
      seen.add(normalizeName(d.name))
      dishes.value.push({
        name: d.name,
        price: d.price != null ? String(d.price) : '',
        section: d.section,
        selected: true,
        lines: [],
      })
    }
    if (dishes.value.length > 0) step.value = 'pick'
    else errorMsg.value = t('menu.scan.unreadable')
  } catch {
    errorMsg.value = t('menu.scan.scanFailed')
  } finally {
    busy.value = false
  }
}

/** Dishes grouped by menu section, preserving extraction order. */
const sections = computed(() => {
  const groups = new Map<string, WizardDish[]>()
  for (const d of dishes.value) {
    const key = d.section ?? ''
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(d)
  }
  return [...groups.entries()]
})

// ── Step 2 → 3: AI recipe drafts ────────────────────────────────
async function requestDrafts(): Promise<void> {
  if (selected.value.length === 0) {
    errorMsg.value = t('menu.scan.nothingSelected')
    return
  }
  busy.value = true
  errorMsg.value = ''
  step.value = 'drafts'
  const res = await apiFetch(
    '/menu/draft-recipes',
    { method: 'POST', body: JSON.stringify({ dishes: selected.value.map((d) => d.name) }) },
    recipeDraftsResponseSchema,
  )
  busy.value = false
  if (!res.ok) {
    errorMsg.value = t('menu.scan.draftFailed')
    step.value = 'pick'
    return
  }
  const byDish = new Map(res.data.drafts.map((d) => [normalizeName(d.dish), d.lines]))
  for (const dish of dishes.value) {
    if (dish.selected) dish.lines = (byDish.get(normalizeName(dish.name)) ?? []).map((l) => ({ ...l }))
  }
}

/** Estimated plate cost from pantry prices (new/unpriced lines excluded). */
function estCost(dish: WizardDish): { cost: number; complete: boolean } {
  let cost = 0
  let complete = true
  for (const line of dish.lines) {
    const ing = line.ingredientId ? kitchen.ingredientMap.get(line.ingredientId) : undefined
    if (!ing || ing.lastUnitPrice == null) {
      complete = false
      continue
    }
    const inStock = convertQty(line.qty, line.unit, ing.unit)
    if (inStock == null) {
      complete = false
      continue
    }
    cost += inStock * ing.lastUnitPrice
  }
  return { cost, complete }
}

function estMargin(dish: WizardDish): number | null {
  const price = Number(dish.price)
  if (!(price > 0) || dish.lines.length === 0) return null
  return ((price - estCost(dish).cost) / price) * 100
}

// ── Save ────────────────────────────────────────────────────────
/** Stock unit for an AI-proposed new ingredient (recipes use g/ml,
 * pantries buy kg/L). */
function stockUnitFor(u: Unit): Unit {
  if (u === 'g') return 'kg'
  if (u === 'ml') return 'L'
  if (u === 'oz') return 'lb'
  if (u === 'floz') return 'qt'
  return u
}

async function saveAll(withRecipes: boolean): Promise<void> {
  if (selected.value.length === 0) {
    errorMsg.value = t('menu.scan.nothingSelected')
    return
  }
  busy.value = true
  saving.value = true
  errorMsg.value = ''
  saveProgress.value = 0
  // New-ingredient cache: the same proposed ingredient across several
  // dishes ("Olive Oil") must be created exactly once.
  const created = new Map<string, string>(
    kitchen.ingredients.map((i) => [normalizeName(i.name), i.id]),
  )
  let ok = 0
  for (const dish of selected.value) {
    const recipe = []
    if (withRecipes) {
      for (const line of dish.lines) {
        let ingredientId = line.ingredientId
        if (!ingredientId) {
          const key = normalizeName(line.name)
          ingredientId = created.get(key) ?? null
          if (!ingredientId) {
            const ing = await kitchen.addIngredient(line.name, stockUnitFor(line.unit), line.category)
            if (!ing) continue // duplicate race or failure — skip the line, keep the dish
            created.set(key, ing.id)
            ingredientId = ing.id
          }
        }
        if (line.qty > 0) recipe.push({ ingredientId, qty: line.qty, unit: line.unit })
      }
    }
    const saved = await kitchen.saveMenuItem({
      name: dish.name,
      price: Number(dish.price) || 0,
      targetMarginPct: 70,
      recipe,
      active: true,
    })
    if (saved) ok += 1
    saveProgress.value += 1
  }
  busy.value = false
  saving.value = false
  savedCount.value = ok
  step.value = 'done'
}
</script>

<template>
  <Transition name="list">
    <div
      v-if="open"
      class="fixed inset-0 z-40 flex items-end justify-center bg-black/30 backdrop-blur-sm sm:items-center"
      @click="close"
    >
      <div
        class="flex max-h-[90vh] w-full flex-col gap-4 overflow-auto rounded-t-2xl bg-white/95 p-5 backdrop-blur-md sm:max-w-lg sm:rounded-2xl"
        @click.stop
      >
        <div class="flex items-center justify-between">
          <h2 class="text-lg font-bold">{{ t('menu.scan.title') }}</h2>
          <button class="text-xs font-medium text-smoke hover:text-ink" @click="close">
            {{ t('common.action.cancel') }}
          </button>
        </div>

        <p v-if="errorMsg" class="rounded-xl bg-coral-50 px-3 py-2 text-sm text-coral-600">
          {{ errorMsg }}
        </p>

        <!-- ── Step 1: capture ─────────────────────────────────── -->
        <template v-if="step === 'capture'">
          <p class="text-sm leading-relaxed text-smoke">{{ t('menu.scan.captureHint') }}</p>
          <label class="btn-primary flex w-full cursor-pointer items-center justify-center gap-2 py-3">
            <svg viewBox="0 0 24 24" class="h-5 w-5 shrink-0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" />
              <circle cx="12" cy="13" r="3" />
            </svg>
            {{ busy ? t('menu.scan.reading') : t('menu.scan.takePhoto') }}
            <input
              type="file"
              accept="image/*"
              capture="environment"
              class="hidden"
              :disabled="busy"
              @change="onPhoto"
            />
          </label>
        </template>

        <!-- ── Step 2: tap to import ───────────────────────────── -->
        <template v-else-if="step === 'pick'">
          <p class="text-sm text-smoke">{{ t('menu.scan.pickHint', { n: dishes.length }) }}</p>
          <div class="space-y-3">
            <div v-for="[section, group] in sections" :key="section" class="space-y-1.5">
              <div v-if="section" class="text-xs font-semibold text-smoke uppercase">{{ section }}</div>
              <div
                v-for="dish in group"
                :key="dish.name"
                class="flex items-center gap-2 rounded-xl border p-2 transition-colors"
                :class="dish.selected ? 'border-ember/40 bg-ember-50/60' : 'border-gray-100 opacity-60'"
              >
                <button
                  class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs"
                  :class="dish.selected ? 'border-ember bg-ember text-white' : 'border-gray-300 text-transparent'"
                  :aria-label="dish.name"
                  @click="dish.selected = !dish.selected"
                >
                  ✓
                </button>
                <div class="min-w-0 flex-1 truncate text-sm font-medium" @click="dish.selected = !dish.selected">
                  {{ dish.name }}
                </div>
                <input
                  v-model="dish.price"
                  type="number"
                  inputmode="decimal"
                  step="0.01"
                  class="input w-20 px-2 py-1 text-right text-sm"
                  :placeholder="t('menu.editor.menuPrice')"
                />
              </div>
            </div>
          </div>
          <label class="btn-ghost flex cursor-pointer items-center justify-center">
            {{ busy ? t('menu.scan.reading') : t('menu.scan.addPage') }}
            <input type="file" accept="image/*" capture="environment" class="hidden" :disabled="busy" @change="onPhoto" />
          </label>
          <div class="grid grid-cols-2 gap-2">
            <BaseButton variant="ghost" :disabled="busy" @click="saveAll(false)">
              {{ t('menu.scan.importOnly') }}
            </BaseButton>
            <BaseButton :disabled="busy" @click="requestDrafts">
              <span class="inline-flex items-center gap-1.5">
                <svg viewBox="0 0 24 24" class="h-4 w-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3Z" />
                  <path d="M19 15l.6 1.9L21.5 17.5l-1.9.6L19 20l-.6-1.9L16.5 17.5l1.9-.6L19 15Z" />
                </svg>
                {{ t('menu.scan.draftCta') }}
              </span>
            </BaseButton>
          </div>
        </template>

        <!-- ── Step 3: review drafts ───────────────────────────── -->
        <template v-else-if="step === 'drafts'">
          <div v-if="busy && !saving" class="flex flex-col items-center gap-3 py-10 text-center">
            <svg viewBox="0 0 24 24" class="h-10 w-10 animate-pulse text-ember" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3Z" />
              <path d="M19 15l.6 1.9L21.5 17.5l-1.9.6L19 20l-.6-1.9L16.5 17.5l1.9-.6L19 15Z" />
            </svg>
            <p class="text-sm text-smoke">{{ t('menu.scan.drafting') }}</p>
          </div>
          <template v-else>
            <p class="text-sm leading-relaxed text-smoke">{{ t('menu.scan.draftsHint') }}</p>
            <div class="space-y-3">
              <div v-for="dish in selected" :key="dish.name" class="card space-y-2">
                <div class="flex items-baseline justify-between gap-2">
                  <div class="min-w-0 truncate text-sm font-semibold">{{ dish.name }}</div>
                  <div class="shrink-0 text-xs text-smoke">
                    {{ t('menu.scan.estCost', { cost: n(estCost(dish).cost, 'currency') }) }}<template v-if="!estCost(dish).complete">*</template>
                    <span
                      v-if="estMargin(dish) != null"
                      class="ml-1 font-semibold"
                      :class="estMargin(dish)! >= 70 ? 'text-herb-700' : 'text-coral-600'"
                    >
                      {{ estMargin(dish)!.toFixed(0) }}% {{ t('menu.scan.estMargin') }}
                    </span>
                  </div>
                </div>
                <p v-if="dish.lines.length === 0" class="text-xs text-smoke">{{ t('menu.scan.noLines') }}</p>
                <div v-for="(line, i) in dish.lines" :key="i" class="flex items-center gap-2 text-sm">
                  <button
                    class="shrink-0 text-smoke hover:text-coral-600"
                    :aria-label="t('triage.detail.removeLine')"
                    @click="dish.lines.splice(i, 1)"
                  >
                    ✕
                  </button>
                  <span class="min-w-0 flex-1 truncate">
                    {{ line.name }}
                    <span
                      v-if="!line.ingredientId"
                      class="ml-1 rounded-full bg-herb-50 px-1.5 py-0.5 text-[10px] font-semibold text-herb-700"
                    >
                      {{ t('menu.scan.newBadge') }}
                    </span>
                  </span>
                  <input
                    v-model.number="line.qty"
                    type="number"
                    inputmode="decimal"
                    step="0.01"
                    class="input w-20 px-2 py-1 text-right"
                  />
                  <span class="w-10 shrink-0 text-xs text-smoke">{{ t('common.unit.' + line.unit) }}</span>
                </div>
              </div>
            </div>
            <p v-if="selected.some((d) => d.lines.some((l) => !l.ingredientId))" class="text-xs text-smoke">
              {{ t('menu.scan.newHint') }}
            </p>
            <BaseButton variant="herb" class="w-full py-3" :disabled="busy" @click="saveAll(true)">
              {{
                saving
                  ? t('menu.scan.saving', { done: saveProgress, total: selected.length })
                  : t('menu.scan.saveAll', { n: selected.length })
              }}
            </BaseButton>
          </template>
        </template>

        <!-- ── Step 4: done ────────────────────────────────────── -->
        <template v-else>
          <div class="flex flex-col items-center gap-3 py-6 text-center">
            <svg viewBox="0 0 24 24" class="h-12 w-12 text-herb-600" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M21.8 10.1A10 10 0 1 1 12 2" />
              <path d="m8.5 11.5 3 3L22 4" />
            </svg>
            <h3 class="text-lg font-bold">{{ t('menu.scan.doneTitle') }}</h3>
            <p class="max-w-sm text-sm leading-relaxed text-smoke">
              {{ t('menu.scan.doneBody', { n: savedCount }) }}
            </p>
            <BaseButton @click="close">{{ t('menu.scan.close') }}</BaseButton>
          </div>
        </template>
      </div>
    </div>
  </Transition>
</template>
