<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useInvoicesStore } from '../stores/invoices'
import { useKitchenStore } from '../stores/kitchen'
import { useAuthStore } from '../stores/auth'
import { useSettingsStore } from '../stores/settings'
import { fetchBlobUrl } from '../lib/api'
import { previewBase } from '../lib/money'
import { CURRENCIES, DEFAULT_CURRENCY } from '../lib/schemas'
import type { ApprovalMoney, Currency, FxDecision, LineItem, Unit } from '../lib/types'
import BaseButton from '../components/BaseButton.vue'

/**
 * Side-by-side review: the receipt image next to the AI transcription.
 * Tap any field to fix an OCR misread, then approve the whole invoice
 * in one action. HERO TARGET of the Triage-card transition.
 *
 * Money (docs/multi-currency.md): this is the ONE screen that works on
 * a document's PRINTED amounts in its own currency — before approval no
 * rate exists. A foreign document gets a rate picker (printed on the
 * document, or manual); the server converts and freezes. Once approved,
 * the wire amounts are base and the printed figures sit under `printed`.
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

// ── Currency & rate (the document's, while it is being reviewed) ─────
const base = computed<Currency>(() => auth.profile?.currency ?? DEFAULT_CURRENCY)
const docCurrency = ref<Currency>(DEFAULT_CURRENCY)
const foreign = computed(() => docCurrency.value !== base.value)
const priced = computed(() => lines.value.some((l) => l.unitPrice > 0 || l.total > 0))
const needsRate = computed(() => foreign.value && priced.value)
type RateSource = Extract<FxDecision['source'], 'printed' | 'manual'>
const rateSource = ref<RateSource>('manual')
const rateInput = ref('')
const rate = computed(() => {
  const v = Number(String(rateInput.value).replace(',', '.'))
  return Number.isFinite(v) && v > 0 ? v : 0
})
function pickRate(source: RateSource): void {
  rateSource.value = source
  if (source === 'printed' && invoice.value?.printedFxRate) rateInput.value = String(invoice.value.printedFxRate)
}
/** The reviewer's decision as the API wants it (absent when not needed). */
const money = computed<ApprovalMoney>(() => ({
  currency: docCurrency.value,
  ...(needsRate.value && rate.value > 0
    ? { fx: { rate: rate.value, source: rateSource.value, asOf: invoiceDate.value || new Date().toISOString().slice(0, 10) } }
    : {}),
}))

/** Amounts formatted in a given currency — the document's while editing,
 * base once approved (the wire is base then). */
const fmt = (value: number, currency: Currency) => n(value, { key: 'currency', currency })
const canonicalCurrency = computed<Currency>(() =>
  readonly.value ? (invoice.value?.fx ? base.value : (invoice.value?.currency ?? base.value)) : docCurrency.value,
)
// Read-only toggle: flip a converted document between base and printed.
const showPrinted = ref(false)
function shownLine(i: number, line: LineItem): { unitPrice: number; total: number; currency: Currency } {
  const inv = invoice.value
  if (showPrinted.value && inv?.printed && inv.currency) {
    const p = inv.printed.lineItems[i]
    if (p) return { unitPrice: p.unitPrice, total: p.total, currency: inv.currency }
  }
  return { unitPrice: line.unitPrice, total: line.total, currency: canonicalCurrency.value }
}

// ── Approve as (non-food) expense ───────────────────────────────
const kitchen = useKitchenStore()
const showExpenseForm = ref(false)
const expenseTag = ref('')
const expenseBusy = ref(false)

async function confirmAsExpense(): Promise<void> {
  if (foreign.value && rate.value <= 0) {
    alert(t('triage.detail.fx.required'))
    return
  }
  expenseBusy.value = true
  const ok = await store.approveAsExpense(invoiceId.value, expenseTag.value.trim(), {
    currency: docCurrency.value,
    ...(foreign.value ? { fx: money.value.fx ?? { rate: rate.value, source: rateSource.value, asOf: invoiceDate.value || new Date().toISOString().slice(0, 10) } } : {}),
  })
  expenseBusy.value = false
  if (ok) {
    void kitchen.refresh() // the new expense entry
    void router.push('/triage')
  } else {
    alert(t('triage.detail.asExpenseFailed'))
  }
}

// The image endpoint requires the auth header, which <img> can't send —
// fetch it as a blob and render the object URL instead. Multi-page
// scans re-fetch per page (?page=N, 1-based).
const imageUrl = ref<string | null>(null)
const page = ref(1)
const pageCount = computed(() => invoice.value?.imagePaths?.length ?? 1)
watch(invoiceId, () => (page.value = 1))
watch(
  [invoiceId, page],
  async ([idVal, pageVal]) => {
    if (imageUrl.value) URL.revokeObjectURL(imageUrl.value)
    imageUrl.value = await fetchBlobUrl(
      `/invoices/${idVal}/image${pageVal > 1 ? `?page=${pageVal}` : ''}`,
    )
  },
  { immediate: true },
)
onUnmounted(() => {
  if (imageUrl.value) URL.revokeObjectURL(imageUrl.value)
})

/** Load the editor from the document (first load and after a re-run). */
function populate(): void {
  const inv = invoice.value
  if (!inv) return
  vendorName.value = inv.vendorName ?? ''
  invoiceDate.value = inv.invoiceDate ?? ''
  docType.value = inv.docType ?? 'invoice'
  lines.value = inv.lineItems.map((l) => ({ ...l }))
  docCurrency.value = inv.currency ?? base.value
  // The printed rate is what the vendor actually charged — preselected.
  if (inv.printedFxRate) pickRate('printed')
  else {
    rateSource.value = 'manual'
    rateInput.value = ''
  }
}

watch(
  invoice,
  (inv) => {
    if (inv && lines.value.length === 0) populate()
  },
  { immediate: true },
)

const total = computed(() => lines.value.reduce((s, l) => s + (Number(l.total) || 0), 0))
// Preview only — the server recomputes every base figure from the rate.
const baseTotalPreview = computed(() => (needsRate.value ? previewBase(total.value, rate.value) : null))

function recalc(line: LineItem): void {
  line.total = +(line.qty * line.unitPrice).toFixed(2)
  // The human just fixed the numbers — the math flag no longer applies.
  line.flagged = false
}

function addLine(): void {
  lines.value.push({ name: '', qty: 1, unit: 'lb' as Unit, unitPrice: 0, total: 0 })
}

// Stuck in processing (trigger hiccup)? Offer the retry escape hatch.
// 90s = ~3× the typical OCR pipeline latency (~25s end-to-end including
// Storage trigger + vision model round-trip + Firestore write).
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
    if (invoice.value?.status === 'processing') void store.refreshOne(invoice.value.id)
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
  populate()
}

/** Dismiss the scan without approving it — junk, duplicate, wrong page. */
async function dismiss(): Promise<void> {
  if (!confirm(t('triage.dismissConfirm'))) return
  if (await store.discard(invoiceId.value)) void router.push('/triage')
  else alert(t('triage.dismissFailed'))
}

async function approve(): Promise<void> {
  if (needsRate.value && rate.value <= 0) {
    alert(t('triage.detail.fx.required'))
    return
  }
  busy.value = true
  const ok = await store.approve(
    invoiceId.value,
    vendorName.value.trim() || null,
    invoiceDate.value || null,
    lines.value.filter((l) => l.name.trim()),
    docType.value,
    money.value,
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
          {{
            vendorName ||
            (invoice.status === 'failed' ? t('triage.detail.scanFallback') : t('triage.detail.invoiceFallback'))
          }}
        </h1>
        <div v-if="readonly" class="mt-1 flex flex-wrap items-center gap-2 text-xs text-smoke">
          <span class="chip-down">{{ t('common.status.approved') }}</span>
          <span>{{ t('triage.detail.docType.' + (invoice.docType ?? 'invoice')) }}</span>
          <span v-if="invoice.invoiceDate">
            · {{ d(new Date(invoice.invoiceDate + 'T12:00:00'), 'short') }}
          </span>
          <span v-if="invoice.expenseTag" class="chip-up">{{ invoice.expenseTag }}</span>
          <span v-if="invoice.printed && invoice.currency" class="chip-up">{{ invoice.currency }}</span>
        </div>
      </div>
      <div class="text-right">
        <div class="text-xs text-smoke">{{ t('triage.detail.total') }}</div>
        <div class="font-bold">
          {{ readonly ? fmt(invoice.total ?? 0, canonicalCurrency) : fmt(total, docCurrency) }}
        </div>
        <div v-if="!readonly && baseTotalPreview != null" class="text-xs text-smoke">
          {{ t('triage.detail.fx.baseTotal', { total: fmt(baseTotalPreview ?? 0, base), base }) }}
        </div>
      </div>
    </div>

    <!-- The frozen rate of a converted document, and the printed ↔ base toggle -->
    <div
      v-if="readonly && invoice.fx && invoice.currency"
      class="card flex flex-wrap items-center justify-between gap-2 p-3 text-xs text-smoke"
    >
      <span>
        {{
          t('triage.detail.fx.rateLine', {
            doc: invoice.currency,
            rate: n(invoice.fx.rate),
            base,
            source: t('triage.detail.fx.source.' + invoice.fx.source),
            date: d(new Date(invoice.fx.asOf + 'T12:00:00'), 'short'),
          })
        }}
      </span>
      <button class="font-semibold text-ink hover:text-ember-700" @click="showPrinted = !showPrinted">
        {{ showPrinted ? t('triage.detail.fx.showBase', { base }) : t('triage.detail.fx.showPrinted') }}
      </button>
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
        <span>{{ t('triage.detail.warn.' + w, { base }) }}</span>
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
        <!-- Page switcher for multi-page scans -->
        <div
          v-if="pageCount > 1"
          class="sticky bottom-1 mt-2 flex items-center justify-center gap-3 text-xs font-semibold"
        >
          <button
            class="flex h-8 w-8 items-center justify-center rounded-full bg-ink/80 text-white disabled:opacity-30"
            :disabled="page <= 1"
            :aria-label="t('triage.detail.pagePrev')"
            @click="page -= 1"
          >
            ‹
          </button>
          <span class="rounded-full bg-ink/80 px-3 py-1.5 text-white">
            {{ t('triage.detail.page', { n: page, total: pageCount }) }}
          </span>
          <button
            class="flex h-8 w-8 items-center justify-center rounded-full bg-ink/80 text-white disabled:opacity-30"
            :disabled="page >= pageCount"
            :aria-label="t('triage.detail.pageNext')"
            @click="page += 1"
          >
            ›
          </button>
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
              {{ n(line.qty) }} {{ t('common.unit.' + line.unit) }} ×
              {{ fmt(shownLine(i, line).unitPrice, shownLine(i, line).currency) }}
            </div>
          </div>
          <div class="shrink-0 text-sm font-semibold">
            {{ fmt(shownLine(i, line).total, shownLine(i, line).currency) }}
          </div>
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
          <!-- Document currency — OCR's read, confirmable here. Base is the
               restaurant's; a different choice opens the rate picker. -->
          <label v-if="canEdit" class="flex items-center gap-2 text-sm">
            <span class="text-xs text-smoke">{{ t('triage.detail.currency') }}</span>
            <select v-model="docCurrency" class="input w-auto px-2 py-1 text-xs" :aria-label="t('triage.detail.currency')">
              <option v-for="code in CURRENCIES" :key="code" :value="code">{{ code }}</option>
            </select>
          </label>
        </div>

        <!-- Rate picker: only for a priced document in a foreign currency -->
        <div v-if="canEdit && needsRate" class="card space-y-2 border-ember-100 bg-ember-50 p-3 text-sm">
          <div class="text-xs font-semibold text-ember-700">{{ t('triage.detail.fx.title') }}</div>
          <p class="text-[11px] text-smoke">{{ t('triage.detail.fx.hint', { doc: docCurrency, base }) }}</p>
          <div class="flex flex-wrap items-center gap-2">
            <div class="inline-flex overflow-hidden rounded-lg border border-gray-200 text-xs font-semibold">
              <button
                v-if="invoice.printedFxRate"
                class="px-3 py-1.5"
                :class="rateSource === 'printed' ? 'bg-ink text-white' : 'bg-white text-smoke hover:bg-gray-50'"
                @click="pickRate('printed')"
              >
                {{ t('triage.detail.fx.printed') }} · {{ n(invoice.printedFxRate) }}
              </button>
              <button
                class="px-3 py-1.5"
                :class="rateSource === 'manual' ? 'bg-ink text-white' : 'bg-white text-smoke hover:bg-gray-50'"
                @click="pickRate('manual')"
              >
                {{ t('triage.detail.fx.manual') }}
              </button>
            </div>
            <label class="flex items-center gap-2 text-xs">
              <input
                v-model="rateInput"
                type="number"
                inputmode="decimal"
                step="0.0001"
                min="0"
                class="input w-32"
                :aria-label="t('triage.detail.fx.rateLabel', { doc: docCurrency, base })"
                @input="rateSource = 'manual'"
              />
              <span class="text-smoke">{{ t('triage.detail.fx.rateLabel', { doc: docCurrency, base }) }}</span>
            </label>
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
              :aria-label="t('triage.detail.unitPrice') + ' (' + docCurrency + ')'"
              @input="recalc(line)"
            />
            <div class="flex items-center justify-end pr-1 text-sm font-semibold">
              {{ fmt(line.total, docCurrency) }}
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
      <BaseButton
        variant="herb"
        class="w-full py-3.5 text-base"
        :disabled="busy || lines.length === 0 || (needsRate && rate <= 0)"
        @click="approve"
      >
        {{
          busy
            ? t('triage.detail.approving')
            : t('triage.detail.approve', {
                total: baseTotalPreview != null ? fmt(baseTotalPreview, base) : fmt(total, docCurrency),
              })
        }}
      </BaseButton>
    </div>
  </div>
</template>
