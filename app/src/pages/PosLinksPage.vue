<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { z } from 'zod'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { apiFetch } from '../lib/api'
import { posLinksResponseSchema, posMatchSummarySchema } from '../lib/schemas'
import { useAuthStore } from '../stores/auth'
import BaseButton from '../components/BaseButton.vue'
import MenuScanWizard from '../components/MenuScanWizard.vue'
import PageLoader from '../components/PageLoader.vue'

// POS review queue (docs/pos.md §Review queue): every catalog item of the
// connected POS location, and the dish it counts as. Provider-generic —
// the provider is only a route param and a display name.
type LinksResponse = z.infer<typeof posLinksResponseSchema>
type Link = LinksResponse['links'][number]
type Tab = 'pending' | 'linked' | 'ignored' | 'removed'

const { t, n } = useI18n()
const route = useRoute()
const auth = useAuthStore()
const provider = computed(() => String(route.params.provider))
const base = computed(() => `/integrations/${provider.value}`)

const data = ref<LinksResponse | null>(null)
const loading = ref(true)
const busy = ref<string | null>(null)
const errorMsg = ref('')
const tab = ref<Tab>('pending')
const picked = ref<Set<string>>(new Set())
const wizardOpen = ref(false)

const canEdit = computed(() => auth.can('integrations', 'edit'))
// Importing creates dishes, so it also needs the menu.
const canImport = computed(() => canEdit.value && auth.can('menu', 'edit'))

const dishById = computed(() => new Map((data.value?.dishes ?? []).map((d) => [d.id, d])))
const tabOf = (l: Link): Tab =>
  l.removed ? 'removed' : l.status === 'ignored' ? 'ignored' : l.status === 'unmapped' ? 'pending' : 'linked'
const counts = computed(() => {
  const c: Record<Tab, number> = { pending: 0, linked: 0, ignored: 0, removed: 0 }
  for (const l of data.value?.links ?? []) c[tabOf(l)] += 1
  return c
})
const shown = computed(() => (data.value?.links ?? []).filter((l) => tabOf(l) === tab.value))
const seed = computed(() =>
  (data.value?.links ?? [])
    .filter((l) => picked.value.has(l.id))
    .map((l) => ({ key: l.id, name: l.name, price: l.price })),
)

/** The dish's menu price differs from what the POS charges. */
function drift(l: Link): number | null {
  const dish = l.menuItemId ? dishById.value.get(l.menuItemId) : undefined
  return dish && l.price !== null && Math.abs(dish.price - l.price) >= 0.01 ? dish.price : null
}

function errorText(error: string): string {
  if (error.includes('pos_reauth')) return t('integrations.error.pos_reauth')
  return t('integrations.error.generic')
}

async function load(): Promise<void> {
  const res = await apiFetch(`${base.value}/links`, undefined, posLinksResponseSchema)
  loading.value = false
  if (res.ok) data.value = res.data
  else errorMsg.value = errorText(res.error)
}

async function run(path: string, label: string): Promise<void> {
  busy.value = label
  errorMsg.value = ''
  const res = await apiFetch(`${base.value}/${path}`, { method: 'POST' }, posMatchSummarySchema)
  busy.value = null
  if (!res.ok) errorMsg.value = errorText(res.error)
  await load()
}

async function act(link: Link, body: { action: 'confirm'; menuItemId: string } | { action: 'ignore' | 'unlink' }): Promise<boolean> {
  busy.value = link.id
  const res = await apiFetch(`${base.value}/links/${encodeURIComponent(link.id)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
  busy.value = null
  if (!res.ok) errorMsg.value = errorText(res.error)
  return res.ok
}

async function decide(link: Link, body: Parameters<typeof act>[1]): Promise<void> {
  if (await act(link, body)) await load()
}

function onPickDish(link: Link, event: Event): void {
  const menuItemId = (event.target as HTMLSelectElement).value
  if (menuItemId) void decide(link, { action: 'confirm', menuItemId })
}

function togglePick(id: string): void {
  const next = new Set(picked.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  picked.value = next
}

/** The wizard created dishes from POS items — link each to its own. */
async function onImported(created: { key: string; menuItemId: string }[]): Promise<void> {
  const byId = new Map((data.value?.links ?? []).map((l) => [l.id, l]))
  for (const { key, menuItemId } of created) {
    const link = byId.get(key)
    if (link) await act(link, { action: 'confirm', menuItemId })
  }
  picked.value = new Set()
  await load()
}

onMounted(() => void load())
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <RouterLink to="/settings" class="text-xs font-medium text-smoke hover:text-ink">← {{ t('settings.title') }}</RouterLink>
        <h1 class="text-xl font-bold">
          {{ t('integrations.links.title', { provider: t('integrations.provider.' + provider) }) }}
        </h1>
        <p class="text-xs text-smoke">{{ t('integrations.links.desc') }}</p>
      </div>
      <div v-if="canEdit" class="flex flex-wrap gap-2">
        <BaseButton variant="ghost" :disabled="busy !== null" @click="run('links/match', 'match')">
          {{ busy === 'match' ? t('integrations.links.matching') : t('integrations.links.match') }}
        </BaseButton>
        <BaseButton :disabled="busy !== null" @click="run('catalog/sync', 'sync')">
          {{ busy === 'sync' ? t('integrations.links.syncing') : t('integrations.links.sync') }}
        </BaseButton>
      </div>
    </div>

    <p v-if="errorMsg" class="rounded-xl bg-coral-50 px-3 py-2 text-sm text-coral-600">{{ errorMsg }}</p>

    <PageLoader v-if="loading" :cards="0" :lines="4" />

    <template v-else-if="data">
      <div class="inline-flex overflow-hidden rounded-lg border border-gray-200 text-xs font-semibold">
        <button
          v-for="key in ['pending', 'linked', 'ignored', 'removed'] as const"
          :key="key"
          class="px-3 py-1.5"
          :class="tab === key ? 'bg-ink text-white' : 'bg-white text-smoke hover:bg-gray-50'"
          @click="tab = key"
        >
          {{ t('integrations.links.tab.' + key, { n: counts[key] }) }}
        </button>
      </div>

      <div v-if="shown.length === 0" class="card py-10 text-center text-sm text-smoke">
        {{ t('integrations.links.empty.' + tab) }}
      </div>

      <!-- Recipe 4: rows animate out as they're decided, with FLIP moves -->
      <TransitionGroup v-else name="list" tag="div" class="relative space-y-2">
        <div v-for="link in shown" :key="link.id" class="card space-y-2">
          <div class="flex items-start justify-between gap-3">
            <label class="flex min-w-0 items-start gap-2">
              <input
                v-if="tab === 'pending' && canImport"
                type="checkbox"
                class="mt-1"
                :checked="picked.has(link.id)"
                @change="togglePick(link.id)"
              />
              <span class="min-w-0">
                <span class="block text-sm font-medium [overflow-wrap:anywhere]">{{ link.name }}</span>
                <span class="text-xs text-smoke">
                  {{ link.price !== null ? n(link.price, 'currency') : t('integrations.links.openPrice') }}
                </span>
              </span>
            </label>
            <span v-if="link.status === 'auto'" class="chip-up shrink-0">{{ t('integrations.links.auto') }}</span>
          </div>

          <!-- Linked: the dish it counts as, drift, confirm / unlink -->
          <template v-if="tab === 'linked' || (tab === 'removed' && link.menuItemId)">
            <p class="text-sm">
              → {{ dishById.get(link.menuItemId ?? '')?.name ?? '—' }}
            </p>
            <p v-if="drift(link) !== null" class="text-xs text-ember-700">
              {{ t('integrations.links.drift', { menu: n(drift(link)!, 'currency'), pos: n(link.price ?? 0, 'currency') }) }}
            </p>
            <div v-if="canEdit && tab === 'linked'" class="flex flex-wrap gap-2">
              <BaseButton
                v-if="link.status === 'auto'"
                :disabled="busy === link.id"
                @click="decide(link, { action: 'confirm', menuItemId: link.menuItemId! })"
              >
                {{ t('integrations.links.confirm') }}
              </BaseButton>
              <BaseButton variant="ghost" :disabled="busy === link.id" @click="decide(link, { action: 'unlink' })">
                {{ t('integrations.links.unlink') }}
              </BaseButton>
            </div>
          </template>

          <!-- Pending: suggestions, any dish, or ignore -->
          <template v-else-if="tab === 'pending' && canEdit">
            <div v-if="link.candidates.length" class="flex flex-wrap items-center gap-2">
              <span class="text-xs text-smoke">{{ t('integrations.links.suggested') }}</span>
              <button
                v-for="c in link.candidates"
                :key="c.menuItemId"
                class="rounded-full border border-ember/40 bg-ember-50/60 px-2.5 py-1 text-xs font-medium hover:bg-ember-50"
                :disabled="busy === link.id"
                @click="decide(link, { action: 'confirm', menuItemId: c.menuItemId })"
              >
                {{ dishById.get(c.menuItemId)?.name ?? '—' }}
              </button>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <select
                class="input w-auto max-w-64 px-2 py-1 text-xs"
                :aria-label="t('integrations.links.pickDish')"
                :disabled="busy === link.id"
                @change="onPickDish(link, $event)"
              >
                <option value="">{{ t('integrations.links.pickDish') }}</option>
                <option v-for="d in data.dishes" :key="d.id" :value="d.id">{{ d.name }}</option>
              </select>
              <BaseButton variant="ghost" :disabled="busy === link.id" @click="decide(link, { action: 'ignore' })">
                {{ t('integrations.links.ignore') }}
              </BaseButton>
            </div>
          </template>

          <!-- Ignored: back to the queue -->
          <div v-else-if="tab === 'ignored' && canEdit">
            <BaseButton variant="ghost" :disabled="busy === link.id" @click="decide(link, { action: 'unlink' })">
              {{ t('integrations.links.restore') }}
            </BaseButton>
          </div>

          <p v-if="tab === 'removed'" class="text-xs text-smoke">{{ t('integrations.links.removedHint') }}</p>
        </div>
      </TransitionGroup>

      <!-- Bulk: create dishes for unmatched POS items (menu-scan wizard) -->
      <div v-if="tab === 'pending' && canImport && picked.size > 0" class="sticky bottom-4">
        <BaseButton variant="herb" class="w-full py-3" @click="wizardOpen = true">
          {{ t('integrations.links.importSelected', { n: picked.size }) }}
        </BaseButton>
      </div>
    </template>

    <MenuScanWizard
      v-model="wizardOpen"
      :seed="seed"
      :title="t('integrations.links.importTitle')"
      @saved="onImported"
    />
  </div>
</template>
