<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useInvoicesStore } from '../stores/invoices'
import { useKitchenStore } from '../stores/kitchen'
import { normalizeName, vendorSummaries } from '../lib/domain'

/** Vendor directory: food vendors (invoices) + service payees (expenses). */
const { t, n, d } = useI18n()
const invoicesStore = useInvoicesStore()
const kitchen = useKitchenStore()

const search = ref('')
const sortBy = ref<'spend' | 'name' | 'recent'>('spend')
// Filter by derived tag: supplied category ("cat:seafood") or expense
// tag ("tag:Marketing").
const tagFilter = ref('all')

const all = computed(() => vendorSummaries(invoicesStore.invoices, kitchen.expenses))

const tagOptions = computed(() => {
  const cats = new Set<string>()
  const tags = new Set<string>()
  for (const v of all.value) {
    for (const c of v.categories) cats.add(c)
    for (const tag of v.tags) tags.add(tag)
  }
  return {
    categories: [...cats].sort(),
    tags: [...tags].sort((a, b) => a.localeCompare(b)),
  }
})

const vendors = computed(() => {
  const q = normalizeName(search.value)
  const list = all.value.filter((v) => {
    if (q && !v.key.includes(q)) return false
    if (tagFilter.value.startsWith('cat:')) return v.categories.includes(tagFilter.value.slice(4) as never)
    if (tagFilter.value.startsWith('tag:')) return v.tags.includes(tagFilter.value.slice(4))
    return true
  })
  switch (sortBy.value) {
    case 'name':
      return list.sort((a, b) => a.name.localeCompare(b.name))
    case 'recent':
      return list.sort((a, b) => (b.lastDate ?? '').localeCompare(a.lastDate ?? ''))
    default:
      return list // vendorSummaries already sorts by spend
  }
})
</script>

<template>
  <div class="space-y-4">
    <h1 class="text-xl font-bold">{{ t('vendors.title') }}</h1>

    <div v-if="all.length > 0" class="flex flex-wrap gap-2">
      <input v-model="search" class="input min-w-40 flex-1" :placeholder="t('common.filter.search')" />
      <select v-model="tagFilter" class="input w-auto">
        <option value="all">{{ t('common.filter.allTags') }}</option>
        <option v-for="c in tagOptions.categories" :key="'cat:' + c" :value="'cat:' + c">
          {{ t('common.category.' + c) }}
        </option>
        <option v-for="tag in tagOptions.tags" :key="'tag:' + tag" :value="'tag:' + tag">
          {{ tag }}
        </option>
      </select>
      <select v-model="sortBy" class="input w-auto">
        <option value="spend">{{ t('common.filter.sortSpend') }}</option>
        <option value="name">{{ t('common.filter.sortName') }}</option>
        <option value="recent">{{ t('common.filter.sortRecent') }}</option>
      </select>
    </div>

    <div v-if="all.length === 0" class="card py-10 text-center text-sm text-smoke">
      {{ t('vendors.empty') }}
    </div>
    <div v-else-if="vendors.length === 0" class="card py-8 text-center text-sm text-smoke">
      {{ t('common.filter.noResults') }}
    </div>

    <div class="space-y-2">
      <RouterLink
        v-for="v in vendors"
        :key="v.key"
        :to="`/vendors/${v.key}`"
        class="card block hover:border-ember/40"
      >
        <div class="flex items-center justify-between gap-3">
          <div class="min-w-0">
            <!-- HERO SOURCE: morphs into the detail page title -->
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
          <div class="shrink-0 text-right">
            <div class="font-bold">{{ n(v.totalSpend, 'currency') }}</div>
            <div class="text-[11px] text-smoke">{{ t('vendors.totalSpend') }}</div>
          </div>
        </div>
        <!-- Derived tags: supplied categories (ember) + expense tags (gray) -->
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
      </RouterLink>
    </div>
  </div>
</template>
