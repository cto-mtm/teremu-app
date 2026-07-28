<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useInvoicesStore } from '../stores/invoices'
import { useAuthStore } from '../stores/auth'
import { reconcileDeliveryNotes, reconciliationCandidates } from '../lib/domain'
import type { Invoice } from '../lib/types'
import InvoiceCard from '../components/InvoiceCard.vue'

const { t, n, d } = useI18n()
const store = useInvoicesStore()
const auth = useAuthStore()
const canEdit = computed(() => auth.can('triage', 'edit'))
const showInfo = ref(false)

// Albarán ↔ factura pairing: automatic from scans, manually resolvable.
const reconciliation = computed(() => reconcileDeliveryNotes(store.invoices))

function candidatesFor(note: Invoice): Invoice[] {
  return reconciliationCandidates(store.invoices, note)
}

/** Drop a scan that will never be an invoice out of the inbox. */
async function dismiss(id: string): Promise<void> {
  if (!confirm(t('triage.dismissConfirm'))) return
  if (!(await store.discard(id))) alert(t('triage.dismissFailed'))
}

/** Undo a mistaken dismissal — the scan returns to the inbox as it was. */
async function restore(id: string): Promise<void> {
  if (!(await store.discard(id, false))) alert(t('triage.restoreFailed'))
}

async function linkNote(note: Invoice, event: Event): Promise<void> {
  const invoiceId = (event.target as HTMLSelectElement).value
  if (invoiceId) await store.reconcile(note.id, { invoiceId })
}

// Poll while invoices are processing so OCR results appear without a
// manual reload (no realtime channel — the client has no Firebase SDK).
let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  void store.refresh()
  timer = setInterval(() => {
    if (store.invoices.some((i) => i.status === 'processing')) void store.refresh()
  }, 4000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="flex items-center gap-2">
        <h1 class="text-xl font-bold">{{ t('triage.title') }}</h1>
        <button
          class="flex h-6 w-6 items-center justify-center rounded-full text-smoke hover:bg-gray-100 hover:text-ink"
          :class="showInfo ? 'bg-ember-50 text-ember-700' : ''"
          :aria-label="t('triage.info.open')"
          @click="showInfo = !showInfo"
        >
          <svg viewBox="0 0 24 24" class="h-4.5 w-4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 11v5M12 8v.01" />
          </svg>
        </button>
      </div>
      <RouterLink to="/scan" class="btn-primary self-start sm:self-auto">{{ t('pulse.scanCta') }}</RouterLink>
    </div>

    <!-- What-is-this explainer modal -->
    <Teleport to="body">
      <Transition name="fade">
        <div
          v-if="showInfo"
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
          @click.self="showInfo = false"
        >
          <div class="w-full max-w-sm rounded-xl bg-white p-5 shadow-lg space-y-3">
            <div class="flex items-center justify-between">
              <h2 class="text-sm font-semibold text-ink">{{ t('triage.title') }}</h2>
              <button
                class="flex h-6 w-6 items-center justify-center rounded-full text-smoke hover:bg-gray-100 hover:text-ink"
                :aria-label="t('triage.info.close')"
                @click="showInfo = false"
              >
                <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div class="space-y-2 text-sm leading-relaxed text-smoke">
              <p>{{ t('triage.info.p1') }}</p>
              <p>{{ t('triage.info.p2') }}</p>
              <p>{{ t('triage.info.p3') }}</p>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <div v-if="store.pending.length === 0" class="card py-10 text-center text-sm text-smoke">
      {{ t('triage.empty') }}
    </div>

    <!-- Recipe 4: rows animate in/out (approve removes them) with FLIP moves -->
    <TransitionGroup v-else name="list" tag="div" class="relative space-y-2">
      <InvoiceCard
        v-for="inv in store.pending"
        :key="inv.id"
        :invoice="inv"
        :can-dismiss="canEdit"
        @dismiss="dismiss"
      />
    </TransitionGroup>

    <!-- Reconciliation report: every delivery note vs its invoice -->
    <div v-if="reconciliation.length" class="card p-0">
      <div class="px-4 pt-3 pb-1 text-sm font-semibold">{{ t('triage.recon.title') }}</div>
      <div class="divide-y divide-gray-100">
        <div v-for="row in reconciliation" :key="row.note.id" class="space-y-1 px-4 py-3">
          <div class="flex items-center justify-between gap-3">
            <div class="min-w-0">
              <RouterLink :to="`/triage/${row.note.id}`" class="truncate text-sm font-medium hover:text-ember-700">
                {{ row.note.vendorName ?? '—' }}
                <span class="text-xs text-smoke">
                  · {{ row.note.invoiceDate ? d(new Date(row.note.invoiceDate + 'T12:00:00'), 'short') : '' }}
                  · {{ n(row.note.total ?? 0, 'currency') }}
                </span>
              </RouterLink>
              <div
                class="text-xs"
                :class="row.status === 'matched' ? 'text-herb-700' : row.status === 'unmatched' ? 'text-coral-600' : 'text-ember-700'"
              >
                {{
                  row.status === 'matched'
                    ? t('triage.recon.matched', { date: row.match?.invoiceDate ? d(new Date(row.match.invoiceDate + 'T12:00:00'), 'short') : '—' })
                    : row.status === 'unmatched'
                      ? t('triage.recon.unmatched')
                      : t('triage.recon.mismatch')
                }}
              </div>
            </div>
            <span
              class="shrink-0"
              :class="row.status === 'matched' ? 'chip-down' : 'chip-up'"
            >
              {{ row.status === 'matched' ? '✓' : row.status === 'unmatched' ? '?' : '≠' }}
            </span>
          </div>
          <p v-for="diff in row.diffs" :key="diff.name" class="text-xs text-smoke">
            {{ t('triage.recon.diff', { name: diff.name, note: n(diff.notePrice, 'currency'), invoice: n(diff.invoicePrice, 'currency') }) }}
          </p>
          <!-- Manual resolution: link to the right invoice, or close the row -->
          <div v-if="canEdit" class="flex flex-wrap items-center gap-2 pt-1">
            <select
              v-if="row.status !== 'matched'"
              class="input w-auto max-w-full px-2 py-1 text-xs"
              @change="linkNote(row.note, $event)"
            >
              <option value="">{{ t('triage.recon.linkPlaceholder') }}</option>
              <option v-for="cand in candidatesFor(row.note)" :key="cand.id" :value="cand.id">
                {{
                  t('triage.recon.linkOption', {
                    vendor: cand.vendorName ?? '—',
                    date: cand.invoiceDate ? d(new Date(cand.invoiceDate + 'T12:00:00'), 'short') : '—',
                    total: n(cand.total ?? 0, 'currency'),
                  })
                }}
              </option>
            </select>
            <button
              class="rounded-full bg-herb-50 px-2.5 py-1 text-[11px] font-semibold text-herb-700 hover:bg-herb-100"
              @click="store.reconcile(row.note.id, { handled: true })"
            >
              ✓ {{ t('triage.recon.markHandled') }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <template v-if="store.approved.length > 0">
      <h2 class="pt-2 text-sm font-semibold text-smoke">{{ t('triage.recentTitle') }}</h2>
      <div class="space-y-2">
        <!-- Clickable: opens the read-only receipt with the original photo -->
        <RouterLink
          v-for="inv in store.approved.slice(0, 5)"
          :key="inv.id"
          :to="`/triage/${inv.id}`"
          class="card flex items-center justify-between py-3 hover:border-ember/40"
        >
          <div>
            <div class="text-sm font-medium">{{ inv.vendorName ?? t('triage.detail.invoiceFallback') }}</div>
            <div class="text-xs text-smoke">
              {{ inv.invoiceDate ? d(new Date(inv.invoiceDate + 'T12:00:00'), 'short') : '' }}
            </div>
          </div>
          <div class="text-sm font-semibold">{{ n(inv.total ?? 0, 'currency') }}</div>
        </RouterLink>
      </div>
    </template>

    <!-- Dismissed scans: kept, not deleted — a mistaken dismissal is
         undone from here (the API puts the scan back where it was). -->
    <template v-if="canEdit && store.discarded.length > 0">
      <h2 class="pt-2 text-sm font-semibold text-smoke">{{ t('triage.discardedTitle') }}</h2>
      <div class="space-y-2">
        <div
          v-for="inv in store.discarded"
          :key="inv.id"
          class="card flex items-center justify-between py-3 opacity-70"
        >
          <div class="min-w-0">
            <div class="truncate text-sm font-medium">{{ inv.vendorName ?? t('triage.detail.invoiceFallback') }}</div>
            <div class="text-xs text-smoke">{{ d(new Date(inv.createdAt), 'short') }}</div>
          </div>
          <button
            class="shrink-0 rounded-full bg-gray-100 px-2.5 py-1 text-[11px] font-semibold text-ink hover:bg-gray-200"
            @click="restore(inv.id)"
          >
            {{ t('triage.restore') }}
          </button>
        </div>
      </div>
    </template>
  </div>
</template>
