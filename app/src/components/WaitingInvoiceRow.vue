<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatMoney } from '../i18n'
import type { WaitingItem } from '../lib/types'

/**
 * One invoice the scan meter is holding in the inbox, locked: who sent
 * it, when, which file — and the vendor and amount the mail quoted, when
 * it quoted them (a hint, in its own currency, never converted). Not an
 * invoice and not a link, so no view-transition-name (docs/animations.md).
 * Two looks: a line in the coral UpgradeNotice, or (`ghost`) a dashed card
 * at the top of Triage's queue, shaped like an InvoiceCard.
 */
const props = defineProps<{ item: WaitingItem; ghost?: boolean }>()
const { t, d } = useI18n()

const date = computed(() => d(new Date(props.item.receivedAt), 'short'))
const hint = computed(() =>
  [
    props.item.vendorHint && props.item.vendorHint !== props.item.from ? props.item.vendorHint : null,
    props.item.amountHint ? formatMoney(props.item.amountHint.value, props.item.amountHint.currency) : null,
  ]
    .filter(Boolean)
    .join(' · '),
)
</script>

<template>
  <div v-if="ghost" class="card flex items-center gap-3 border-dashed text-smoke">
    <div class="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gray-100" aria-hidden="true">🔒</div>
    <div class="min-w-0 flex-1">
      <div class="truncate font-semibold">{{ item.from }}</div>
      <div class="truncate text-xs">
        <span class="mr-1 font-semibold">📧 {{ t('triage.fromEmail') }} ·</span>{{ date }}<template v-if="hint"> · {{ hint }}</template>
      </div>
    </div>
    <span class="shrink-0 text-xs font-bold">{{ t('upgradeNotice.locked') }}</span>
  </div>
  <li v-else class="flex items-center gap-2 rounded-lg bg-white/10 px-2 py-1.5 text-left text-[11px]">
    <span aria-hidden="true">🔒</span>
    <span class="sr-only">{{ t('upgradeNotice.locked') }}</span>
    <div class="min-w-0 flex-1">
      <div class="truncate font-semibold">{{ item.from }}</div>
      <div class="truncate text-white/75">{{ date }} · {{ item.attachment ?? item.subject }}</div>
    </div>
    <div v-if="hint" class="shrink-0 font-semibold">{{ hint }}</div>
  </li>
</template>
