<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import type { Invoice } from '../lib/types'

const props = defineProps<{ invoice: Invoice; canDismiss?: boolean }>()
const emit = defineEmits<{ dismiss: [id: string] }>()
const { t, n, d } = useI18n()

// Processing normally resolves in seconds; past 90s assume the trigger
// hiccuped and open the escape hatch (detail page has a retry).
const STALE_MS = 90_000
const stale = computed(
  () => props.invoice.status === 'processing' && Date.now() - props.invoice.createdAt > STALE_MS,
)

// Computed so the card becomes tappable the moment OCR finishes — or
// the moment a stuck invoice needs rescuing.
const clickable = computed(
  () =>
    props.invoice.status === 'needs_review' ||
    props.invoice.status === 'failed' ||
    stale.value,
)
</script>

<template>
  <!-- The link and the dismiss button are siblings: a button nested
       inside an <a> is invalid HTML and screen readers expose it
       inconsistently. -->
  <div class="card flex items-center gap-3" :class="clickable ? 'hover:border-ember/40' : 'opacity-70'">
    <component
      :is="clickable ? RouterLink : 'div'"
      :to="clickable ? `/triage/${invoice.id}` : undefined"
      class="flex min-w-0 flex-1 items-center gap-3"
    >
    <!-- HERO SOURCE: this thumbnail morphs into the detail page's receipt
         image. The name MUST be derived from the id — a static name inside
         a v-for would collide (unique-per-page rule, see docs/animations.md). -->
    <div
      class="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-ember-50 text-ember-700"
      :style="{ viewTransitionName: 'invoice-' + invoice.id }"
    >
      <svg viewBox="0 0 24 24" class="h-6 w-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <path d="M6 3h12v18l-2-1.5L14 21l-2-1.5L10 21l-2-1.5L6 21zM9 8h6M9 12h6" />
      </svg>
    </div>

    <div class="min-w-0 flex-1">
      <!-- Paired hero: the title text morphs too (same-name recipe). -->
      <div
        class="truncate font-semibold"
        :style="{ viewTransitionName: 'invoice-title-' + invoice.id }"
      >
        {{ invoice.vendorName ?? t('triage.reading') }}
      </div>
      <div class="text-xs text-smoke">
        <template v-if="invoice.status === 'processing'">
          <span :class="stale ? 'text-coral-600' : ''">
            {{ stale ? t('triage.stuck') : t('triage.processingHint') }}
          </span>
        </template>
        <template v-else-if="invoice.status === 'needs_review'">
          {{
            t('triage.itemsSummary', {
              n: invoice.lineItems.length,
              total: n(invoice.total ?? 0, 'currency'),
              date: invoice.invoiceDate ? d(new Date(invoice.invoiceDate + 'T12:00:00'), 'short') : '',
            })
          }}
        </template>
        <template v-else-if="invoice.status === 'failed'">
          {{
            invoice.error === 'unreadable'
              ? t('triage.failedUnreadable')
              : invoice.error === 'not_a_document'
                ? t('triage.failedNotDocument')
                : t('triage.failedProcessing')
          }}
        </template>
      </div>
    </div>

    <span
      v-if="invoice.status === 'processing'"
      class="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-gray-200 border-t-smoke"
      role="status"
      :aria-label="t('common.status.processing')"
    />
    <span v-else-if="invoice.status === 'needs_review'" class="shrink-0 text-xs font-bold text-ember-600">
      {{ t('triage.review') }} →
    </span>
    <span v-else-if="invoice.status === 'failed'" class="shrink-0 text-coral">⚠</span>
    </component>

    <!-- A scan that will never be an invoice (a hand, a menu, a blur)
         has nothing to review — let it leave the inbox from here. -->
    <button
      v-if="canDismiss && invoice.status === 'failed'"
      class="-mr-1 shrink-0 rounded-full px-2 py-1 text-smoke hover:bg-coral-50 hover:text-coral"
      :aria-label="t('triage.dismiss')"
      @click="emit('dismiss', invoice.id)"
    >
      ✕
    </button>
  </div>
</template>
