<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { upgradeFrom } from '../lib/plans'
import type { WaitingItem } from '../lib/types'
import { useAuthStore } from '../stores/auth'
import WaitingInvoiceRow from './WaitingInvoiceRow.vue'

/**
 * The one paywall banner (docs/email-quota-paywall-plan.md Phase 2): the
 * scan limit, invoices waiting in the inbox. Coral, `role="alert"`. Under
 * the caller's title, a line by reason: with a higher plan to move to,
 * what it does and, for the owner, "Ver planes" → /pricing?reason=<reason>
 * (the pricing page explains the reason); on the top plan, what happens
 * next and no button — a Max owner is never asked to upgrade. A member
 * sees the text only. Positioning comes from the caller's class.
 * `items` (the invoices waiting in the inbox, from GET /email/waiting)
 * shows what would come in — up to five, then "y N más" against `count`.
 */
export type UpgradeReason = 'scan_limit' | 'email_quota'

const props = defineProps<{
  title: string
  reason: UpgradeReason
  dismissible?: boolean
  items?: WaitingItem[]
  count?: number
}>()
defineEmits<{ dismiss: [] }>()

/** Waiting invoices listed by name; the rest are counted. */
const SHOWN = 5

const { t } = useI18n()
const auth = useAuthStore()

const next = computed(() => upgradeFrom(auth.profile?.plan ?? 'free'))
const isOwner = computed(() => auth.profile?.role === 'owner')
const shown = computed(() => props.items?.slice(0, SHOWN) ?? [])
const more = computed(() => Math.max(0, (props.count ?? shown.value.length) - shown.value.length))
const text = computed(() =>
  next.value
    ? t(`upgradeNotice.upsell.${props.reason}`, { plan: t(`pricing.${next.value}.name`) })
    : t(`upgradeNotice.top.${props.reason}`),
)
</script>

<template>
  <div class="space-y-2 rounded-2xl bg-coral px-4 py-3 text-center text-white shadow-lg" role="alert">
    <div class="flex items-start gap-2">
      <p class="flex-1 text-xs font-bold">{{ title }}</p>
      <button v-if="dismissible" class="text-white/70" :aria-label="t('upgradeNotice.dismiss')" @click="$emit('dismiss')">
        ✕
      </button>
    </div>
    <p v-if="text" class="text-[11px] font-medium text-white/85">{{ text }}</p>
    <ul v-if="shown.length" class="space-y-1">
      <WaitingInvoiceRow v-for="item in shown" :key="item.id" :item="item" />
    </ul>
    <p v-if="shown.length && more" class="text-[11px] font-medium text-white/85">{{ t('upgradeNotice.more', { n: more }) }}</p>
    <RouterLink
      v-if="next && isOwner"
      :to="{ path: '/pricing', query: { reason } }"
      class="inline-block rounded-full bg-white px-4 py-1.5 text-xs font-bold text-coral"
    >
      {{ t('upgradeNotice.cta') }}
    </RouterLink>
  </div>
</template>
