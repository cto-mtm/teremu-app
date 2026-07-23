<script setup lang="ts">
import { computed, watch } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { ref } from 'vue'
import { useInvoicesStore } from '../stores/invoices'
import { useKitchenStore } from '../stores/kitchen'
import { useAuthStore } from '../stores/auth'
import { isFoodInvoice, normalizeName, vendorSummaries, vendorWeeklyTotals } from '../lib/domain'
import MiniBars from '../components/MiniBars.vue'
import BaseButton from '../components/BaseButton.vue'

/** One vendor: every invoice they sent and every ingredient they supply. */
const { t, n, d } = useI18n()
const route = useRoute()
const router = useRouter()
const invoicesStore = useInvoicesStore()
const kitchen = useKitchenStore()

const key = computed(() => String(route.params.key))
const summary = computed(() =>
  vendorSummaries(invoicesStore.invoices, kitchen.expenses).find((v) => v.key === key.value),
)
const weekly = computed(() => vendorWeeklyTotals(invoicesStore.invoices, key.value))

// ── Ordering contact (email for orders, phone for WhatsApp) ─────
const auth = useAuthStore()
const contact = computed(() => kitchen.vendorContacts.find((c) => c.vendorKey === key.value))
const contactEmail = ref('')
const contactPhone = ref('')
const contactSaved = ref(false)
watch(
  contact,
  (c) => {
    contactEmail.value = c?.email ?? ''
    contactPhone.value = c?.phone ?? ''
  },
  { immediate: true },
)

async function saveContact(): Promise<void> {
  if (!summary.value) return
  const ok = await kitchen.saveVendorContact(
    key.value,
    summary.value.name,
    contactEmail.value.trim(),
    contactPhone.value.trim(),
  )
  if (ok) {
    contactSaved.value = true
    setTimeout(() => (contactSaved.value = false), 2000)
  }
}

/** Expense entries paid to this vendor (service side). */
const vendorExpenses = computed(() =>
  kitchen.expenses
    .filter((e) => e.vendorName && normalizeName(e.vendorName) === key.value)
    .sort((a, b) => b.date.localeCompare(a.date)),
)

const invoices = computed(() =>
  invoicesStore.invoices
    .filter((i) => isFoodInvoice(i) && i.vendorName && normalizeName(i.vendorName) === key.value)
    .sort((a, b) => (b.invoiceDate ?? '').localeCompare(a.invoiceDate ?? '')),
)

/** Latest price paid to THIS vendor per ingredient. */
const supplied = computed(() => {
  const map = new Map<string, { ingredientId: string | null; name: string; unit: string; unitPrice: number; date: string }>()
  for (const inv of invoices.value) {
    for (const line of inv.lineItems) {
      const k = line.ingredientId ?? normalizeName(line.name)
      const date = inv.invoiceDate ?? ''
      const existing = map.get(k)
      if (!existing || date > existing.date) {
        map.set(k, {
          ingredientId: line.ingredientId ?? null,
          name: line.name,
          unit: line.unit,
          unitPrice: line.unitPrice,
          date,
        })
      }
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
})
</script>

<template>
  <div v-if="!summary" class="py-10 text-center text-sm text-smoke">
    {{ t('vendors.detail.notFound') }}
  </div>

  <div v-else class="space-y-4">
    <div class="flex items-center gap-3">
      <button class="text-smoke" :aria-label="t('common.action.back')" @click="router.push('/vendors')">←</button>
      <div class="min-w-0 flex-1">
        <!-- HERO TARGET: same name as the list card -->
        <h1
          class="truncate text-xl leading-tight font-bold"
          :style="{ viewTransitionName: 'vendor-' + summary.key }"
        >
          {{ summary.name }}
        </h1>
        <div class="text-xs text-smoke">
          {{ t('vendors.receipts', { n: summary.invoiceCount }) }} · {{ n(summary.totalSpend, 'currency') }}
        </div>
      </div>
    </div>

    <div v-if="weekly.some((v) => v > 0)" class="card">
      <div class="mb-2 text-sm font-semibold">{{ t('vendors.detail.trendTitle') }}</div>
      <MiniBars :values="weekly" :height="64" />
    </div>

    <!-- Ordering contact: feeds the grocery list's send buttons -->
    <div v-if="auth.can('pantry', 'edit')" class="card space-y-2">
      <div class="text-sm font-semibold">{{ t('vendors.detail.contactTitle') }}</div>
      <div class="flex flex-wrap gap-2">
        <input v-model="contactEmail" type="email" class="input min-w-40 flex-1" :placeholder="t('vendors.detail.contactEmail')" />
        <input v-model="contactPhone" class="input min-w-32 flex-1" :placeholder="t('vendors.detail.contactPhone')" />
        <BaseButton variant="ghost" @click="saveContact">
          {{ contactSaved ? t('vendors.detail.contactSaved') : t('common.action.save') }}
        </BaseButton>
      </div>
    </div>

    <div v-if="vendorExpenses.length" class="card p-0">
      <div class="px-4 pt-3 pb-1 text-sm font-semibold">{{ t('vendors.detail.expensesTitle') }}</div>
      <div class="divide-y divide-gray-100">
        <div v-for="e in vendorExpenses" :key="e.id" class="flex items-center justify-between px-4 py-3">
          <div class="min-w-0">
            <div class="text-sm font-medium">{{ e.tag }}</div>
            <div class="truncate text-xs text-smoke">
              {{ d(new Date(e.date + 'T12:00:00'), 'short') }}<template v-if="e.note"> · {{ e.note }}</template>
            </div>
          </div>
          <div class="shrink-0 text-sm font-semibold">{{ n(e.amount, 'currency') }}</div>
        </div>
      </div>
    </div>

    <div v-if="invoices.length" class="card p-0">
      <div class="px-4 pt-3 pb-1 text-sm font-semibold">{{ t('vendors.detail.receiptsTitle') }}</div>
      <div class="divide-y divide-gray-100">
        <!-- Clickable: opens the read-only receipt with the original photo -->
        <RouterLink
          v-for="inv in invoices"
          :key="inv.id"
          :to="`/triage/${inv.id}`"
          class="flex items-center justify-between px-4 py-3 hover:bg-gray-50"
        >
          <div>
            <div class="text-sm font-medium">
              {{ inv.invoiceDate ? d(new Date(inv.invoiceDate + 'T12:00:00'), 'short') : '—' }}
            </div>
            <div class="text-xs text-smoke">{{ t('vendors.detail.items', { n: inv.lineItems.length }) }}</div>
          </div>
          <div class="text-sm font-semibold">{{ n(inv.total ?? 0, 'currency') }}</div>
        </RouterLink>
      </div>
    </div>

    <div v-if="supplied.length" class="card p-0">
      <div class="px-4 pt-3 pb-1 text-sm font-semibold">{{ t('vendors.detail.ingredientsTitle') }}</div>
      <div class="divide-y divide-gray-100">
        <component
          :is="line.ingredientId && kitchen.ingredientMap.has(line.ingredientId) ? RouterLink : 'div'"
          v-for="line in supplied"
          :key="line.name"
          :to="line.ingredientId ? `/pantry/${line.ingredientId}` : undefined"
          class="flex items-center justify-between px-4 py-3"
          :class="line.ingredientId && kitchen.ingredientMap.has(line.ingredientId) ? 'hover:bg-gray-50' : ''"
        >
          <div class="text-sm font-medium">{{ line.name }}</div>
          <div class="text-xs text-smoke">
            {{ t('vendors.detail.lastPaid', { price: n(line.unitPrice, 'currency'), unit: t('common.unit.' + line.unit) }) }}
          </div>
        </component>
      </div>
    </div>
  </div>
</template>
