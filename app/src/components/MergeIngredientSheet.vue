<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useKitchenStore } from '../stores/kitchen'
import { convertQty } from '../lib/units'
import type { Ingredient } from '../lib/types'
import BaseButton from './BaseButton.vue'
import BottomSheet from './BottomSheet.vue'
import IngredientPicker from './IngredientPicker.vue'

/**
 * Pick the ingredient this one (the loser) folds into, and confirm. The
 * page runs the merge (`confirm`): the moment the loser leaves the store
 * this sheet — and the page's ingredient view — unmount. The server
 * repoints recipes, invoice lines and POS days, sums the stock and
 * deletes the loser; its name stays on as an alias of the survivor
 * (docs/architecture.md §Ingredient identity).
 */
const props = defineProps<{ ingredient: Ingredient; preselect?: string | null; busy?: boolean }>()
const open = defineModel<boolean>({ required: true })
const emit = defineEmits<{ confirm: [survivor: Ingredient] }>()

const { t, n } = useI18n()
const kitchen = useKitchenStore()

const picked = ref<Ingredient | null>(null)

watch(
  open,
  (isOpen) => {
    if (!isOpen) return
    picked.value = props.preselect ? (kitchen.ingredientMap.get(props.preselect) ?? null) : null
  },
  { immediate: true },
)

/** 1 loser unit in survivor units, or null when they don't convert. */
const ratio = computed(() => (picked.value ? convertQty(1, props.ingredient.unit, picked.value.unit) : null))
// Every recipe the server rewrites — archived dishes and preps included.
const usedBy = computed(
  () => kitchen.menuItems.filter((m) => m.recipe.some((r) => r.ingredientId === props.ingredient.id)).length,
)
const stockAfter = computed(() =>
  picked.value && ratio.value !== null ? picked.value.theoreticalQty + props.ingredient.theoreticalQty * ratio.value : null,
)

function merge(): void {
  if (picked.value && ratio.value !== null) emit('confirm', picked.value)
}
</script>

<template>
  <BottomSheet v-model="open" :label="t('pantry.merge.title', { name: ingredient.name })">
    <div class="space-y-1">
      <h2 class="text-lg font-bold">{{ t('pantry.merge.title', { name: ingredient.name }) }}</h2>
      <p class="text-xs text-smoke">{{ t('pantry.merge.intro', { name: ingredient.name }) }}</p>
    </div>

    <IngredientPicker
      :name="ingredient.name"
      :category="ingredient.category"
      :exclude="ingredient.id"
      :selected="picked?.id"
      i18n="pantry.merge"
      @pick="picked = $event"
    />

    <!-- What the merge will do -->
    <div v-if="picked" class="space-y-1 rounded-xl border border-gray-100 p-3 text-xs" role="status">
      <p v-if="ratio === null" class="text-coral-600">
        {{
          t('pantry.merge.unitMismatch', {
            loser: ingredient.name,
            survivor: picked.name,
            from: t('common.unit.' + ingredient.unit),
            to: t('common.unit.' + picked.unit),
          })
        }}
      </p>
      <template v-else>
        <p class="font-semibold">{{ t('pantry.merge.confirm', { loser: ingredient.name, survivor: picked.name }) }}</p>
        <p class="text-smoke">{{ t('pantry.merge.usedBy', { n: usedBy, survivor: picked.name }, usedBy) }}</p>
        <p class="text-smoke">
          {{ t('pantry.merge.stock', { qty: n(+(stockAfter ?? 0).toFixed(1)), unit: t('common.unit.' + picked.unit) }) }}
        </p>
      </template>
    </div>

    <BaseButton variant="herb" class="w-full py-3" :disabled="busy || !picked || ratio === null" @click="merge">
      {{ busy ? t('common.action.saving') : t('pantry.merge.cta') }}
    </BaseButton>
  </BottomSheet>
</template>
