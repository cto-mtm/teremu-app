<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useInvoicesStore } from '../stores/invoices'
import { useKitchenStore } from '../stores/kitchen'
import {
  normalizeName,
  vendorExpensesFor,
  vendorInvoicesFor,
  vendorSuppliedLines,
  vendorSummaries,
  vendorWeeklyTotals,
} from '../lib/domain'
import MiniBars from './MiniBars.vue'

/**
 * Dashboard → Providers tab: the whole vendor directory inline, each
 * card expanding to the info that used to need a navigation — weekly
 * spend, ordering contact, supplied ingredients, latest invoices.
 * Everything derives from collections the dashboard already fetched.
 */
const { t, n, d } = useI18n()
const invoicesStore = useInvoicesStore()
const kitchen = useKitchenStore()

const search = ref('')
const sortBy = ref<'spend' | 'name' | 'recent'>('spend')

const all = computed(() => vendorSummaries(invoicesStore.invoices, kitchen.expenses))

const vendors = computed(() => {
  const q = normalizeName(search.value)
  const list = all.value.filter((v) => !q || v.key.includes(q))
  switch (sortBy.value) {
    case 'name':
      return [...list].sort((a, b) => a.name.localeCompare(b.name))
    case 'recent':
      return [...list].sort((a, b) => (b.lastDate ?? '').localeCompare(a.lastDate ?? ''))
    default:
      return list // vendorSummaries already sorts by spend
  }
})

const expandedKey = ref<string | null>(null)
function toggle(key: string): void {
  expandedKey.value = expandedKey.value === key ? null : key
}

// ── Detail data for the one expanded card (shared domain helpers —
// the vendor page derives the same views, so they can never drift) ─
const contact = computed(() =>
  kitchen.vendorContacts.find((c) => c.vendorKey === expandedKey.value),
)
const vendorInvoices = computed(() =>
  expandedKey.value ? vendorInvoicesFor(invoicesStore.invoices, expandedKey.value) : [],
)
// Fed the pre-filtered list — no second full scan of the collection.
const weekly = computed(() =>
  expandedKey.value ? vendorWeeklyTotals(vendorInvoices.value, expandedKey.value) : [],
)
const vendorExpenses = computed(() =>
  expandedKey.value ? vendorExpensesFor(kitchen.expenses, expandedKey.value) : [],
)
const supplied = computed(() => vendorSuppliedLines(vendorInvoices.value))

/** wa.me link: digits only, per WhatsApp's URL scheme. */
const waLink = (phone: string): string => 'https://wa.me/' + phone.replace(/[^0-9]/g, '')
</script>

<template>
  <div class="space-y-3">
    <div v-if="all.length === 0" class="card py-10 text-center text-sm text-smoke">
      {{ t('vendors.empty') }}
    </div>

    <template v-else>
      <div class="flex flex-wrap gap-2">
        <input v-model="search" class="input min-w-40 flex-1" :placeholder="t('common.filter.search')" />
        <select v-model="sortBy" class="input w-auto">
          <option value="spend">{{ t('common.filter.sortSpend') }}</option>
          <option value="name">{{ t('common.filter.sortName') }}</option>
          <option value="recent">{{ t('common.filter.sortRecent') }}</option>
        </select>
      </div>

      <div v-if="vendors.length === 0" class="card py-8 text-center text-sm text-smoke">
        {{ t('common.filter.noResults') }}
      </div>

      <div v-for="v in vendors" :key="v.key" class="card">
        <!-- Header row: always visible, toggles the detail -->
        <button
          class="flex w-full items-center justify-between gap-3 text-left"
          :aria-expanded="expandedKey === v.key"
          @click="toggle(v.key)"
        >
          <div class="min-w-0">
            <!-- HERO SOURCE: morphs into the vendor page title -->
            <div class="truncate font-semibold" :style="{ viewTransitionName: 'vendor-' + v.key }">
              {{ v.name }}
            </div>
            <div class="mt-0.5 text-xs text-smoke">
              {{ t('vendors.receipts', { n: v.invoiceCount }) }}
              <template v-if="v.lastDate">
                · {{ t('vendors.lastDelivery', { date: d(new Date(v.lastDate + 'T12:00:00'), 'short') }) }}
              </template>
            </div>
          </div>
          <div class="flex shrink-0 items-center gap-3">
            <div class="text-right">
              <div class="font-bold">{{ n(v.totalSpend, 'currency') }}</div>
              <div class="text-[11px] text-smoke">{{ t('vendors.totalSpend') }}</div>
            </div>
            <span
              class="text-smoke transition-transform duration-200"
              :class="expandedKey === v.key ? 'rotate-180' : ''"
              aria-hidden="true"
            >▾</span>
          </div>
        </button>

        <div v-if="v.categories.length || v.tags.length" class="mt-2 flex flex-wrap gap-1">
          <span
            v-for="c in v.categories"
            :key="c"
            class="rounded-full bg-ember-50 px-2 py-0.5 text-[11px] font-medium text-ember-700"
          >
            {{ t('common.category.' + c) }}
          </span>
          <span
            v-for="tag in v.tags"
            :key="tag"
            class="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-smoke"
          >
            {{ tag }}
          </span>
        </div>

        <!-- Expanded detail: everything the vendor page shows, inline.
             Recipe 5 fade — Recipe 4 (list) is for TransitionGroup rows
             and its absolute-position leave would overlap the card. -->
        <Transition name="fade">
          <div v-if="expandedKey === v.key" class="mt-3 space-y-3 border-t border-gray-100 pt-3">
            <div v-if="weekly.some((x) => x > 0)">
              <div class="mb-1 text-xs font-semibold text-smoke">{{ t('vendors.detail.trendTitle') }}</div>
              <MiniBars :values="weekly" :height="56" />
            </div>

            <div class="flex flex-wrap items-center gap-2 text-xs">
              <span class="font-semibold text-smoke">{{ t('vendors.detail.contactTitle') }}:</span>
              <a
                v-if="contact?.email"
                :href="'mailto:' + contact.email"
                class="text-ember-700 underline decoration-gray-300"
              >{{ contact.email }}</a>
              <a
                v-if="contact?.phone"
                :href="waLink(contact.phone)"
                target="_blank"
                rel="noopener"
                class="text-ember-700 underline decoration-gray-300"
              >{{ contact.phone }}</a>
              <span v-if="!contact?.email && !contact?.phone" class="text-smoke">
                {{ t('pulse.providers.noContact') }}
              </span>
            </div>

            <div v-if="supplied.length" class="text-xs">
              <div class="mb-1 font-semibold text-smoke">{{ t('vendors.detail.ingredientsTitle') }}</div>
              <div class="divide-y divide-gray-100">
                <component
                  :is="line.ingredientId && kitchen.ingredientMap.has(line.ingredientId) ? RouterLink : 'div'"
                  v-for="line in supplied.slice(0, 6)"
                  :key="line.key"
                  :to="line.ingredientId ? `/pantry/${line.ingredientId}` : undefined"
                  class="flex items-center justify-between py-1.5"
                  :class="line.ingredientId && kitchen.ingredientMap.has(line.ingredientId) ? 'hover:text-ember-700' : ''"
                >
                  <span class="truncate font-medium">{{ line.name }}</span>
                  <span class="shrink-0 text-smoke">
                    {{ t('vendors.detail.lastPaid', { price: n(line.unitPrice, 'currency'), unit: t('common.unit.' + line.unit) }) }}
                  </span>
                </component>
              </div>
            </div>

            <div v-if="vendorInvoices.length" class="text-xs">
              <div class="mb-1 font-semibold text-smoke">{{ t('vendors.detail.receiptsTitle') }}</div>
              <div class="divide-y divide-gray-100">
                <RouterLink
                  v-for="inv in vendorInvoices.slice(0, 3)"
                  :key="inv.id"
                  :to="`/triage/${inv.id}`"
                  class="flex items-center justify-between py-1.5 hover:text-ember-700"
                >
                  <span>
                    {{ inv.invoiceDate ? d(new Date(inv.invoiceDate + 'T12:00:00'), 'short') : '—' }}
                    · {{ t('vendors.detail.items', { n: inv.lineItems.length }) }}
                  </span>
                  <span class="font-semibold">{{ n(inv.total ?? 0, 'currency') }}</span>
                </RouterLink>
              </div>
            </div>

            <div v-if="vendorExpenses.length" class="text-xs">
              <div class="mb-1 font-semibold text-smoke">{{ t('vendors.detail.expensesTitle') }}</div>
              <div class="divide-y divide-gray-100">
                <div
                  v-for="e in vendorExpenses.slice(0, 3)"
                  :key="e.id"
                  class="flex items-center justify-between py-1.5"
                >
                  <span>{{ e.tag }} · {{ d(new Date(e.date + 'T12:00:00'), 'short') }}</span>
                  <span class="font-semibold">{{ n(e.amount, 'currency') }}</span>
                </div>
              </div>
            </div>

            <RouterLink
              :to="`/vendors/${v.key}`"
              class="inline-block text-xs font-medium text-ember-700 underline decoration-gray-300 hover:text-ember"
            >
              {{ t('pulse.providers.openPage') }} →
            </RouterLink>
          </div>
        </Transition>
      </div>
    </template>
  </div>
</template>
