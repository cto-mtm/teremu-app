<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useKitchenStore } from '../stores/kitchen'
import { foldName, suggestIngredients } from '../lib/domain'
import type { Category, Ingredient } from '../lib/types'

/**
 * Pick a live pantry ingredient: "Sugerencias" (closest names to `name`,
 * same category first) above "Todos", or a search across everything.
 * Shared by the triage line link and the pantry merge. Labels come from
 * `{i18n}.{search,suggestions,all,none}`.
 */
const props = defineProps<{
  name: string
  category?: Category | null
  /** Left out of the list (the ingredient being merged away). */
  exclude?: string
  selected?: string | null
  i18n: string
}>()
const emit = defineEmits<{ pick: [ingredient: Ingredient] }>()
defineSlots<{ row(props: { ingredient: Ingredient }): unknown; below(props: { ingredient: Ingredient }): unknown }>()

const { t } = useI18n()
const kitchen = useKitchenStore()

const search = ref('')
watch(
  () => props.name,
  () => (search.value = ''),
)

const pool = computed(() => kitchen.pantry.filter((i) => i.id !== props.exclude))
const suggestions = computed(() => suggestIngredients(props.name, props.category, pool.value).map((s) => s.ingredient))
const groups = computed(() => {
  const q = foldName(search.value)
  if (q) return [{ key: 'all' as const, items: pool.value.filter((i) => foldName(i.name).includes(q)) }].filter((g) => g.items.length)
  const shown = new Set(suggestions.value.map((i) => i.id))
  return [
    { key: 'suggestions' as const, items: suggestions.value },
    { key: 'all' as const, items: pool.value.filter((i) => !shown.has(i.id)) },
  ].filter((g) => g.items.length)
})
</script>

<template>
  <input v-model="search" class="input" :placeholder="t(i18n + '.search')" />

  <div class="max-h-72 space-y-3 overflow-auto">
    <p v-if="groups.length === 0" class="py-4 text-center text-sm text-smoke">{{ t(i18n + '.none') }}</p>
    <div v-for="g in groups" :key="g.key" class="space-y-1">
      <div class="text-xs font-semibold text-smoke">{{ t(i18n + '.' + g.key) }}</div>
      <div v-for="ing in g.items" :key="ing.id" class="space-y-1">
        <button
          class="flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2 text-left text-sm"
          :class="selected === ing.id ? 'border-ember bg-ember-50' : 'border-gray-100 hover:border-ember/40'"
          :aria-pressed="selected === ing.id"
          @click="emit('pick', ing)"
        >
          <span class="truncate font-medium">{{ ing.name }}</span>
          <slot name="row" :ingredient="ing">
            <span class="shrink-0 text-xs text-smoke">{{ t('common.unit.' + ing.unit) }}</span>
          </slot>
        </button>
        <slot name="below" :ingredient="ing" />
      </div>
    </div>
  </div>
</template>
