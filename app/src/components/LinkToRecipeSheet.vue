<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useKitchenStore } from '../stores/kitchen'
import { compatibleUnits } from '../lib/units'
import type { Ingredient, MenuItem, Unit } from '../lib/types'
import BaseButton from './BaseButton.vue'

/**
 * "Add this ingredient to a recipe" — the fix for the unused-ingredient
 * warning (docs/prep-recipes.md § Unused ingredients). Pick a dish or a
 * prep, say how much goes in, and the line is appended through the same
 * recipe save the menu editor uses.
 */
const props = defineProps<{ ingredient: Ingredient }>()
const open = defineModel<boolean>({ required: true })
const emit = defineEmits<{ linked: [item: MenuItem] }>()

const { t } = useI18n()
const kitchen = useKitchenStore()

const search = ref('')
const picked = ref<MenuItem | null>(null)
const qty = ref('')
const unit = ref<Unit>(props.ingredient.unit)
const busy = ref(false)

watch(open, (isOpen) => {
  if (!isOpen) return
  search.value = ''
  picked.value = null
  qty.value = ''
  unit.value = props.ingredient.unit
})

const alreadyIn = (m: MenuItem) => m.recipe.some((r) => r.ingredientId === props.ingredient.id)

/** Dishes first (what most fixes are), then preps; search by name. */
const groups = computed(() => {
  const q = search.value.toLowerCase().trim()
  const keep = (m: MenuItem) => !q || m.name.toLowerCase().includes(q)
  return [
    { key: 'dishes' as const, items: kitchen.dishes.filter(keep) },
    { key: 'preps' as const, items: kitchen.preps.filter(keep) },
  ].filter((g) => g.items.length)
})

const canSave = computed(() => !!picked.value && Number(qty.value) > 0)

async function save(): Promise<void> {
  const item = picked.value
  if (!item || !canSave.value) return
  busy.value = true
  const { id, ...rest } = item
  const saved = await kitchen.saveMenuItem(
    { ...rest, recipe: [...item.recipe, { ingredientId: props.ingredient.id, qty: Number(qty.value), unit: unit.value }] },
    id,
  )
  busy.value = false
  if (!saved) {
    alert(t('pantry.link.failed'))
    return
  }
  open.value = false
  emit('linked', saved)
}
</script>

<template>
  <Transition name="list">
    <div
      v-if="open"
      class="fixed inset-0 z-40 flex items-end justify-center bg-black/30 backdrop-blur-sm sm:items-center"
      @click="open = false"
    >
      <div
        class="max-h-[85vh] w-full space-y-4 overflow-auto rounded-t-2xl bg-white/95 p-5 backdrop-blur-md sm:max-w-md sm:rounded-2xl"
        role="dialog"
        :aria-label="t('pantry.link.title', { name: ingredient.name })"
        @click.stop
      >
        <h2 class="text-lg font-bold">{{ t('pantry.link.title', { name: ingredient.name }) }}</h2>

        <p v-if="!kitchen.activeMenuItems.length" class="text-sm text-smoke">{{ t('pantry.link.noRecipes') }}</p>

        <template v-else>
          <input v-model="search" class="input" :placeholder="t('pantry.link.search')" />

          <div class="max-h-64 space-y-3 overflow-auto">
            <p v-if="groups.length === 0" class="py-4 text-center text-sm text-smoke">{{ t('pantry.link.none') }}</p>
            <div v-for="g in groups" :key="g.key" class="space-y-1">
              <div class="text-xs font-semibold text-smoke">{{ t('pantry.link.' + g.key) }}</div>
              <button
                v-for="m in g.items"
                :key="m.id"
                class="flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2 text-left text-sm disabled:opacity-50"
                :class="picked?.id === m.id ? 'border-ember bg-ember-50' : 'border-gray-100 hover:border-ember/40'"
                :disabled="alreadyIn(m)"
                :aria-pressed="picked?.id === m.id"
                @click="picked = m"
              >
                <span class="truncate font-medium">{{ m.name }}</span>
                <span v-if="alreadyIn(m)" class="shrink-0 text-xs text-smoke">{{ t('pantry.link.already') }}</span>
              </button>
            </div>
          </div>

          <!-- How much goes in: per plate for a dish, per batch for a prep -->
          <div v-if="picked" class="flex items-end gap-2">
            <label class="flex-1 space-y-1 text-sm">
              <span class="text-xs text-smoke">
                {{ picked.kind === 'prep' ? t('pantry.link.qtyBatch') : t('pantry.link.qty') }}
              </span>
              <input v-model="qty" type="number" inputmode="decimal" min="0" step="0.01" class="input" />
            </label>
            <select v-model="unit" class="input w-28" :aria-label="t('common.label.unit')">
              <option v-for="u in compatibleUnits(ingredient.unit)" :key="u" :value="u">{{ t('common.unit.' + u) }}</option>
            </select>
          </div>

          <BaseButton variant="herb" class="w-full py-3" :disabled="busy || !canSave" @click="save">
            {{ busy ? t('common.action.saving') : picked ? t('pantry.link.save', { name: picked.name }) : t('pantry.detail.linkCta') }}
          </BaseButton>
        </template>
      </div>
    </div>
  </Transition>
</template>
