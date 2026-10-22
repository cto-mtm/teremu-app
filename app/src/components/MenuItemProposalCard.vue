<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Unit } from '../lib/types'

/**
 * The assistant's confirmation card for `proposeMenuItem` (menu-setup
 * interview): the dish or prep as the user described it, recipe lines by
 * name — the default card would print the recipe as JSON. Confirm posts
 * exactly this to POST /menu-items (the package's ActionCard does that).
 */
interface Line {
  name?: string
  qty?: number
  unit?: Unit
}
const props = defineProps<{
  input: {
    kind?: 'dish' | 'prep'
    name?: string
    price?: number
    prepMinutes?: number
    yield?: { qty: number; unit: Unit }
    recipe?: Line[]
  }
}>()

const { t, n } = useI18n()
const isPrep = computed(() => props.input.kind === 'prep')
</script>

<template>
  <div class="space-y-2 px-3 py-2 text-sm">
    <div class="flex items-center gap-2">
      <span class="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-smoke">
        {{ isPrep ? t('assistant.proposal.prep') : t('assistant.proposal.dish') }}
      </span>
      <span class="font-semibold">{{ input.name }}</span>
    </div>
    <p class="text-xs text-smoke">
      <template v-if="isPrep && input.yield">
        {{ t('assistant.proposal.yield', { qty: n(input.yield.qty), unit: t('common.unit.' + input.yield.unit) }) }}
      </template>
      <template v-else-if="!isPrep">
        {{ t('assistant.proposal.price', { price: n(input.price ?? 0, 'currency') }) }}
      </template>
      <template v-if="input.prepMinutes"> · {{ t('assistant.proposal.minutes', { n: input.prepMinutes }) }}</template>
    </p>
    <div class="text-[11px] font-semibold text-smoke">
      {{ isPrep ? t('assistant.proposal.perBatch') : t('assistant.proposal.perPlate') }}
    </div>
    <ul class="divide-y divide-gray-100 rounded-lg border border-gray-100">
      <li v-for="(line, i) in input.recipe ?? []" :key="i" class="flex justify-between gap-3 px-2 py-1.5 text-xs">
        <span class="truncate">{{ line.name }}</span>
        <span class="shrink-0 text-smoke">
          {{ line.qty != null ? n(line.qty) : '' }} {{ line.unit ? t('common.unit.' + line.unit) : '' }}
        </span>
      </li>
    </ul>
  </div>
</template>
