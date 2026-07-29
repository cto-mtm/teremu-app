<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useInvoicesStore } from '../stores/invoices'
import { useKitchenStore } from '../stores/kitchen'
import { useAuthStore } from '../stores/auth'
import { useSettingsStore } from '../stores/settings'
import { fetchBlobUrl } from '../lib/api'
import type { LineItem, Unit } from '../lib/types'
import BaseButton from '../components/BaseButton.vue'

/**
 * Side-by-side review: the receipt image next to the AI transcription.
 * Tap any field to fix an OCR misread, then approve the whole invoice
 * in one action. HERO TARGET of the Triage-card transition.
 */
const { t, n, d } = useI18n()
const route = useRoute()
const router = useRouter()
const store = useInvoicesStore()

const invoiceId = computed(() => String(route.params.id))
const invoice = computed(() => store.byId.get(invoiceId.value))
const settings = useSettingsStore()
const auth = useAuthStore()
const canEdit = computed(() => auth.can('triage', 'edit'))
// Approved documents open as a read-only receipt view: the original
// photo plus the recorded line items, no editing affordances.
const readonly = computed(() => invoice.value?.status === 'approved')

/** Preferred-system units, plus whatever unit OCR already assigned. */
function unitOptions(line: LineItem): Unit[] {
  const choices = settings.unitChoices
  return choices.includes(line.unit) ? choices : [line.unit, ...choices]
}

const vendorName = ref('')
const invoiceDate = ref('')
const docType = ref<'invoice' | 'delivery_note'>('invoice')
const lines = ref<LineItem[]>([])
const busy = ref(false)
const retrying = ref(false)

// ── Approve as (non-food) expense ───────────────────────────────
const kitchen = useKitchenStore()
const showExpenseForm = ref(false)
const expenseTag = ref('')
const expenseBusy = ref(false)

async function confirmAsExpense(): Promise<void> {
  expenseBusy.value = true
  const ok = await store.approveAsExpense(invoiceId.value, expenseTag.value.trim())
  expenseBusy.value = false
  if (ok) {
    void kitchen.refresh() // the new expense entry
    void router.push('/triage')
  } else {
    alert(t('triage.detail.asExpenseFailed'))
  }
}

// The image endpoint requires the auth header, which <img> can't send —
// fetch it as a blob and render the object URL instead.
const imageUrl = ref<string | null>(null)
watch(
  invoiceId,
  async (idVal) => {
    if (imageUrl.value) URL.revokeObjectURL(imageUrl.value)
    imageUrl.value = await fetchBlobUrl(`/invoices/${idVal}/image`)
  },
  { immediate: true },
)
onUnmounted(() => {
  if (imageUrl.value) URL.revokeObjectURL(imageUrl.value)
})

watch(
  invoice,
  (inv) => {
    if (inv && lines.value.length === 0) {
      vendorName.value = inv.vendorName ?? ''
      invoiceDate.value = inv.invoiceDate ?? ''
      docType.value = inv.docType ?? 'invoice'
      lines.value = inv.lineItems.map((l) => ({ ...l }))
    }
  },
  { immediate: true },
)

const total = computed(() => lines.value.reduce((s, l) => s + (Number(l.total) || 0), 0))

function recalc(line: LineItem): void {
  line.total = +(line.qty * line.unitPrice).toFixed(2)
  // The human just fixed the numbers — the math flag no longer applies.
  line.flagged = false
}

function addLine(): void {
  lines.value.push({ name: '', qty: 1, unit: 'lb' as Unit, unitPrice: 0, total: 0 })
}

// Stuck in processing (trigger hiccup)? Offer the retry escape hatch.
const STALE_MS = 90_000
const stale = computed(
  () => invoice.value?.status === 'processing' && Date.now() - invoice.value.createdAt > STALE_MS,
)

// While this invoice is processing, poll so the transcription appears
// the moment the background OCR lands (the Triage list polls too, but
// the operator may be sitting right here).
let pollTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  pollTimer = setInterval(() => {
    if (invoice.value?.status === 'processing') void store.refresh()
  }, 4000)
})
onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})

/** Re-run OCR on a failed/stuck invoice, then repopulate the editor. */
async function retry(): Promise<void> {
  retrying.value = true
  const ok = await store.reprocess(invoiceId.value)
  retrying.value = false
  if (!ok) {
    alert(t('triage.failedProcessing'))
    return
  }
  const inv = invoice.value
  if (inv) {
    vendorName.value = inv.vendorName ?? ''
    invoiceDate.value = inv.invoiceDate ?? ''
    lines.value = inv.lineItems.map((l) => ({ ...l }))
  }
}

/** Dismiss the scan without approving it — junk, duplicate, wrong page. */
async function dismiss(): Promise<void> {
  if (!confirm(t('triage.dismissConfirm'))) return
  if (await store.discard(invoiceId.value)) void router.push('/triage')
  else alert(t('triage.dismissFailed'))
}

async function approve(): Promise<void> {
  busy.value = true
  const ok = await store.approve(
    invoiceId.value,
    vendorName.value.trim() || null,
    invoiceDate.value || null,
    lines.value.filter((l) => l.name.trim()),
    docType.value,
  )
  busy.value = false
  if (ok) void router.push('/triage')
  else alert(t('triage.detail.approveFailed'))
}
</script>

<template>
  <div v-if="!invoice" class="py-10 text-center text-sm text-smoke">
    {{ t('common.loading') }}
  </div>

  <div v-else class="space-y-4">
    <div class="flex items-center gap-3">
      <button class="text-smoke" :aria-label="t('common.action.back')" @click="router.push('/triage')">←</button>
      <div class="min-w-0 flex-1">
        <!-- HERO TARGET (title): same name as the card's title on the list page -->
        <h1
          class="truncate text-lg leading-tight font-bold"
          :style="{ viewTransitionName: 'invoice-title-' + invoice.id }"
        >
          {{ vendorName || t('triage.detail.invoiceFallback') }}
        </h1>
        <div v-if="readonly" class="mt-1 flex flex-wrap items-center gap-2 text-xs text-smoke">
          <span class="chip-down">{{ t('common.status.approved') }}</span>
          <span>{{ t('triage.detail.docType.' + (invoice.docType ?? 'invoice')) }}</span>
          <span v-if="invoice.invoiceDate">
            · {{ d(new Date(invoice.invoiceDate + 'T12:00:00'), 'short') }}
          </span>
          <span v-if="invoice.expenseTag" class="chip-up">{{ invoice.expenseTag }}</span>
        </div>
      </div>
      <div class="text-right">
        <div class="text-xs text-smoke">{{ t('triage.detail.total') }}</div>
        <div class="font-bold">{{ n(total, 'currency') }}</div>
      </div>
    </div>

    <div
      v-if="invoice.status === 'failed'"
      class="card flex items-center justify-between gap-3 border-coral-100 bg-coral-50 p-3 text-sm"
    >
      <span class="text-coral-600">
        {{
          invoice.error === 'unreadable'
            ? t('triage.failedUnreadable')
            : invoice.error === 'not_a_document'
              ? t('triage.failedNotDocument')
              : t('triage.failedProcessing')
        }}
      </span>
      <BaseButton v-if="canEdit" variant="ghost" :disabled="retrying" @click="retry">
        {{ retrying ? t('common.loading') : t('common.action.retry') }}
      </BaseButton>
    </div>

    <!-- Still processing: live status, and a retry once it's overdue -->
    <div
      v-else-if="invoice.status === 'processing'"
      class="card flex items-center justify-between gap-3 p-3 text-sm"
      :class="stale ? 'border-coral-100 bg-coral-50' : 'border-ember-100 bg-ember-50'"
    >
      <span class="flex items-center gap-2" :class="stale ? 'text-coral-600' : 'text-ember-700'">
        <span
          v-if="!stale"
          class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-ember-200 border-t-ember-700"
        />
        {{ stale ? t('triage.stuck') : t('triage.processingHint') }}
      </span>
      <BaseButton v-if="stale && canEdit" variant="ghost" :disabled="retrying" @click="retry">
        {{ retrying ? t('common.loading') : t('common.action.retry') }}
      </BaseButton>
    </div>

    <!-- Validation-stage warnings: the math didn't cross-check.
         Amber, not red — the human decides, these just guide the eye. -->
    <div
      v-if="invoice.status === 'needs_review' && invoice.warnings?.length"
      class="card space-y-1 border-ember-100 bg-ember-50 p-3 text-sm"
    >
      <p v-for="w in invoice.warnings" :key="w" class="flex items-start gap-2 text-ember-700">
        <span class="mt-0.5 shrink-0">⚠</span>
        <span>{{ t('triage.detail.warn.' + w) }}</span>
      </p>
    </div>

    <div class="grid gap-4 md:grid-cols-2">
      <!-- HERO TARGET (image): the card thumbnail morphs into this panel.
           Name derived from the invoice id — unique per page (see docs/animations.md). -->
      <div
        class="card max-h-[45vh] self-start overflow-auto p-2 md:sticky md:top-6 md:max-h-[85vh]"
        :style="{ viewTransitionName: 'invoice-' + invoice.id }"
      >
        <img
          v-if="imageUrl"
          :src="imageUrl"
          :alt="t('triage.detail.receiptAlt')"
          class="w-full rounded-xl"
        />
        <div v-else class="flex h-40 items-center justify-center text-xs text-smoke">
          {{ t('triage.detail.noImage') }}
        </div>
      </div>

      <!-- Read-only receipt view for approved documents -->
      <div v-if="readonly" class="card divide-y divide-gray-100 self-start p-0">
        <div
          v-for="(line, i) in invoice.lineItems"
          :key="i"
          class="flex items-center justify-between gap-3 px-4 py-2.5"
        >
          <div class="min-w-0">
            <div class="truncate text-sm font-medium">{{ line.name }}</div>
            <div class="text-xs text-smoke">
              {{ n(line.qty) }} {{ t('common.unit.' + line.unit) }} × {{ n(line.unitPrice, 'currency') }}
            </div>
          </div>
          <div class="shrink-0 text-sm font-semibold">{{ n(line.total, 'currency') }}</div>
        </div>
        <div v-if="invoice.lineItems.length === 0" class="px-4 py-8 text-center text-xs text-smoke">
          {{ t('triage.detail.noImage') }}
        </div>
      </div>

      <div v-else class="space-y-2">
        <div class="card space-y-2 p-3">
          <div class="grid grid-cols-2 gap-2">
            <label class="space-y-1 text-sm">
              <span class="text-xs text-smoke">{{ t('triage.detail.vendor') }}</span>
              <input v-model="vendorName" class="input" />
            </label>
            <label class="space-y-1 text-sm">
              <span class="text-xs text-smoke">{{ t('triage.detail.date') }}</span>
              <input v-model="invoiceDate" type="date" class="input" />
            </label>
          </div>
          <!-- Factura vs albarán — OCR's guess, correctable here -->
          <div v-if="canEdit" class="space-y-1">
            <div class="inline-flex overflow-hidden rounded-lg border border-gray-200 text-xs font-semibold">
              <button
                v-for="dt in ['invoice', 'delivery_note'] as const"
                :key="dt"
                class="px-3 py-1.5"
                :class="docType === dt ? 'bg-ink text-white' : 'bg-white text-smoke hover:bg-gray-50'"
                @click="docType = dt"
              >
                {{ t('triage.detail.docType.' + dt) }}
              </button>
            </div>
            <p v-if="docType === 'delivery_note'" class="text-[11px] text-smoke">
              {{ t('triage.detail.docTypeHint') }}
            </p>
          </div>
        </div>

        <div
          v-for="(line, i) in lines"
          :key="i"
          class="card space-y-2 p-3"
          :class="line.flagged ? 'border-coral-100 ring-1 ring-coral-100' : ''"
        >
          <div class="flex items-center gap-2">
            <input
              v-model="line.name"
              class="input font-medium"
              :placeholder="t('triage.detail.itemName')"
            />
            <button
              class="shrink-0 text-smoke hover:text-coral"
              :aria-label="t('triage.detail.removeLine')"
              @click="lines.splice(i, 1)"
            >
              ✕
            </button>
          </div>
          <div class="grid grid-cols-4 gap-2">
            <input
              v-model.number="line.qty"
              type="number"
              inputmode="decimal"
              class="input"
              :aria-label="t('triage.detail.qty')"
              @input="recalc(line)"
            />
            <select v-model="line.unit" class="input" :aria-label="t('triage.detail.unit')">
              <option v-for="u in unitOptions(line)" :key="u" :value="u">{{ t('common.unit.' + u) }}</option>
            </select>
            <input
              v-model.number="line.unitPrice"
              type="number"
              inputmode="decimal"
              step="0.01"
              class="input"
              :aria-label="t('triage.detail.unitPrice')"
              @input="recalc(line)"
            />
            <div class="flex items-center justify-end pr-1 text-sm font-semibold">
              {{ n(line.total, 'currency') }}
            </div>
          </div>
        </div>

        <button class="btn-ghost w-full" @click="addLine">+ {{ t('triage.detail.addLine') }}</button>
      </div>
    </div>

    <!-- Divert a non-food bill (hosting, photography…) to expenses -->
    <div v-if="invoice.status === 'needs_review' && canEdit" class="card space-y-2 p-3">
      <button
        class="w-full text-left text-xs font-semibold text-smoke hover:text-ink"
        @click="showExpenseForm = !showExpenseForm"
      >
        {{ t('triage.detail.asExpense') }} ↓
      </button>
      <template v-if="showExpenseForm">
        <p class="text-xs text-smoke">{{ t('triage.detail.asExpenseHint') }}</p>
        <div class="flex gap-2">
          <input
            v-model="expenseTag"
            class="input flex-1"
            :placeholder="t('triage.detail.asExpenseTag')"
            list="triage-expense-tags"
          />
          <datalist id="triage-expense-tags">
            <option v-for="tag in kitchen.expenseTags" :key="tag" :value="tag" />
          </datalist>
          <BaseButton variant="ghost" :disabled="expenseBusy || !expenseTag.trim()" @click="confirmAsExpense">
            {{ expenseBusy ? t('common.action.saving') : t('triage.detail.asExpenseConfirm') }}
          </BaseButton>
        </div>
      </template>
    </div>

    <!-- Escape hatch for a scan that should never become an invoice.
         Excluded while processing: OCR would write its status right
         back over the dismissal (the API rejects it for that reason). -->
    <div v-if="canEdit && !readonly && invoice.status !== 'processing'" class="text-center">
      <button class="text-xs font-semibold text-smoke hover:text-coral" @click="dismiss">
        {{ t('triage.dismiss') }}
      </button>
    </div>

    <div v-if="canEdit && !readonly" class="sticky bottom-6 pt-2">
      <BaseButton variant="herb" class="w-full py-3.5 text-base" :disabled="busy || lines.length === 0" @click="approve">
        {{ busy ? t('triage.detail.approving') : t('triage.detail.approve', { total: n(total, 'currency') }) }}
      </BaseButton>
    </div>
  </div>
</template>
