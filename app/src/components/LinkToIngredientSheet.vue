<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { convertQty } from '../lib/units'
import type { Category, Ingredient, Unit } from '../lib/types'
import BottomSheet from './BottomSheet.vue'
import IngredientPicker from './IngredientPicker.vue'

/**
 * "This invoice line is an ingredient I already have" — triage's fix for
 * a vendor spelling that would otherwise spawn a duplicate. The pick
 * rides on the line as `ingredientId`; approval honors it and remembers
 * the spelling as an alias (docs/architecture.md §Ingredient identity).
 */
const props = defineProps<{
  name: string
  category?: Category | null
  /** The line's unit (and pack contents) — for the cross-dimension warning. */
  unit?: Unit
  packUnit?: Unit | null
}>()
const open = defineModel<boolean>({ required: true })
const emit = defineEmits<{ picked: [ingredient: Ingredient] }>()

const { t } = useI18n()

// A row whose unit doesn't convert needs a second tap.
const armed = ref<string | null>(null)
watch(open, (isOpen) => {
  if (isOpen) armed.value = null
})

function unitClash(ing: Ingredient): boolean {
  if (!props.unit) return false
  if (convertQty(1, props.unit, ing.unit) !== null) return false
  // A case of 24 × 400 g converts through its contents at approval.
  return !(props.packUnit && convertQty(1, props.packUnit, ing.unit) !== null)
}

function pick(ing: Ingredient): void {
  if (unitClash(ing) && armed.value !== ing.id) {
    armed.value = ing.id
    return
  }
  // Emit first: closing clears the parent's "which line" state.
  emit('picked', ing)
  open.value = false
}
</script>

<template>
  <BottomSheet v-model="open" :label="t('triage.detail.link.title', { name })">
    <div class="space-y-1">
      <h2 class="text-lg font-bold">{{ t('triage.detail.link.title', { name }) }}</h2>
      <p class="text-xs text-smoke">{{ t('triage.detail.link.intro') }}</p>
    </div>

    <IngredientPicker :name="name" :category="category" :selected="armed" i18n="triage.detail.link" @pick="pick">
      <template #row="{ ingredient: ing }">
        <span class="shrink-0 text-xs" :class="unitClash(ing) ? 'text-coral-600' : 'text-smoke'">
          {{ unitClash(ing) ? '⚠ ' : '' }}{{ t('common.unit.' + ing.unit) }}
        </span>
      </template>
      <template #below="{ ingredient: ing }">
        <p v-if="armed === ing.id" class="px-1 text-[11px] text-coral-600" role="status">
          {{
            t('triage.detail.link.unitWarn', {
              unit: t('common.unit.' + ing.unit),
              lineUnit: t('common.unit.' + (unit ?? ing.unit)),
            })
          }}
        </p>
      </template>
    </IngredientPicker>
  </BottomSheet>
</template>
