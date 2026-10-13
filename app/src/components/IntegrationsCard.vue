<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { z } from 'zod'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { apiFetch } from '../lib/api'
import {
  posConnectSchema,
  posIntegrationListSchema,
  posLocationListSchema,
  posOAuthResultSchema,
} from '../lib/schemas'
import { useAuthStore } from '../stores/auth'
import { useLocationStore } from '../stores/location'
import BaseButton from './BaseButton.vue'

// POS connections (docs/pos.md): connect → pick the POS location that is
// this restaurant → review its products → disconnect. Provider-generic:
// it renders whatever GET /integrations lists. The provider's consent
// page is a full redirect; the API's OAuth callback brings the browser
// back here (?pos=complete&state&code) and this card finishes the flow.
type Integration = z.infer<typeof posIntegrationListSchema>[number]
type PosLocation = z.infer<typeof posLocationListSchema>[number]

const { t } = useI18n()
const auth = useAuthStore()
const location = useLocationStore()
const route = useRoute()
const router = useRouter()

const integrations = ref<Integration[]>([])
const locations = ref<Record<string, PosLocation[]>>({})
const picked = ref<Record<string, string>>({})
const picking = ref<Record<string, boolean>>({})
const busy = ref<string | null>(null)
const message = ref<{ ok: boolean; text: string } | null>(null)

const canEdit = computed(() => auth.can('integrations', 'edit'))
const onPaidPlan = computed(() => auth.profile?.plan !== 'free')

const RESULTS = ['connected', 'denied', 'forbidden', 'upgrade', 'not_configured', 'invalid_state', 'failed'] as const
const ERRORS = ['currency_mismatch', 'location_taken', 'pos_reauth'] as const

function errorText(error: string): string {
  const known = ERRORS.find((code) => error.includes(code))
  return known ? t(`integrations.error.${known}`) : t('integrations.error.generic')
}

async function load(): Promise<void> {
  const res = await apiFetch('/integrations', undefined, posIntegrationListSchema)
  if (!res.ok) return
  integrations.value = res.data
  for (const i of res.data) {
    if (i.status === 'pending_location') void loadLocations(i.provider)
  }
}

async function loadLocations(provider: string): Promise<void> {
  const res = await apiFetch(`/integrations/${provider}/locations`, undefined, posLocationListSchema)
  if (!res.ok) return
  locations.value[provider] = res.data
  const current = integrations.value.find((i) => i.provider === provider)?.locationExternalId
  picked.value[provider] = current ?? res.data[0]?.externalId ?? ''
}

async function connect(provider: string): Promise<void> {
  busy.value = provider
  const res = await apiFetch(`/integrations/${provider}/connect`, { method: 'POST' }, posConnectSchema)
  if (res.ok) {
    window.location.href = res.data.url
    return
  }
  busy.value = null
  message.value = { ok: false, text: res.error.includes('integrations_pro') ? t('integrations.proOnly') : errorText(res.error) }
}

async function startPicking(provider: string): Promise<void> {
  picking.value[provider] = true
  await loadLocations(provider)
}

async function saveLocation(provider: string): Promise<void> {
  busy.value = provider
  const res = await apiFetch(`/integrations/${provider}`, {
    method: 'PUT',
    body: JSON.stringify({ locationExternalId: picked.value[provider] }),
  })
  busy.value = null
  if (!res.ok) {
    message.value = { ok: false, text: errorText(res.error) }
    return
  }
  picking.value[provider] = false
  message.value = null
  await Promise.all([load(), auth.reloadProfile()]) // may have filled base currency / timezone
}

async function disconnect(provider: string): Promise<void> {
  if (!confirm(t('integrations.confirmDisconnect'))) return
  busy.value = provider
  const res = await apiFetch(`/integrations/${provider}`, { method: 'DELETE' })
  busy.value = null
  if (res.ok) await load()
  else message.value = { ok: false, text: errorText(res.error) }
}

function showResult(value: unknown): void {
  const result = RESULTS.find((r) => r === value)
  if (result) message.value = { ok: result === 'connected', text: t(`integrations.result.${result}`) }
}

/** Back from the provider: the API callback handed us `state` + `code`;
 * we finish as the signed-in user, which is what proves it's the same
 * person who started the connection (a forwarded link can't). */
async function completeOAuth(state: string, code: string): Promise<void> {
  const res = await apiFetch(
    '/integrations/oauth',
    { method: 'POST', body: JSON.stringify({ state, code }) },
    posOAuthResultSchema,
  )
  showResult(res.ok ? res.data.result : 'failed')
  // Started from another of the user's locations — show it where it landed.
  if (res.ok && res.data.rid && res.data.rid !== auth.profile?.restaurantId) {
    await location.switchLocation(res.data.rid)
  }
}

onMounted(async () => {
  const { pos, state, code } = route.query
  if (pos) void router.replace({ query: {} }) // the code must not linger in the URL
  if (pos === 'complete' && typeof state === 'string' && typeof code === 'string') {
    await completeOAuth(state, code)
  } else {
    showResult(pos)
  }
  void load()
})
</script>

<template>
  <div class="card space-y-3">
    <div class="text-sm font-semibold">{{ t('integrations.title') }}</div>
    <p class="text-xs text-smoke">{{ t('integrations.desc') }}</p>
    <div v-if="message" :class="message.ok ? 'chip-down' : 'chip-up'" class="inline-block">{{ message.text }}</div>

    <div
      v-for="i in integrations"
      :key="i.provider"
      class="space-y-2 rounded-xl border border-gray-100 p-3"
    >
      <div class="flex items-center justify-between gap-2">
        <div class="text-sm font-medium">{{ t('integrations.provider.' + i.provider) }}</div>
        <span :class="i.status === 'active' ? 'chip-down' : i.status === 'needs_reauth' ? 'chip-up' : 'text-xs text-smoke'">
          {{ t('integrations.status.' + i.status) }}
        </span>
      </div>

      <p v-if="!i.available" class="text-xs text-smoke">{{ t('integrations.unavailable') }}</p>

      <template v-else>
        <p v-if="i.status === 'needs_reauth'" class="text-xs text-coral-600">{{ t('integrations.reauthHint') }}</p>
        <p v-if="i.status === 'active' && i.locationName" class="text-xs">
          {{ t('integrations.connectedTo', { name: i.locationName }) }}
        </p>
        <p v-if="i.status === 'active'" class="text-xs text-smoke">{{ t('integrations.salesSoon') }}</p>
        <RouterLink
          v-if="i.status === 'active'"
          :to="{ name: 'pos-links', params: { provider: i.provider } }"
          class="inline-block text-xs font-medium text-ember-700 hover:underline"
        >
          {{ i.pendingLinks > 0 ? t('integrations.reviewPending', { n: i.pendingLinks }) : t('integrations.review') }}
        </RouterLink>

        <!-- Location picker: required after connecting, optional to change later -->
        <div
          v-if="canEdit && (i.status === 'pending_location' || picking[i.provider]) && locations[i.provider]"
          class="space-y-1"
        >
          <p class="text-xs text-smoke">{{ t('integrations.locationHint') }}</p>
          <div class="flex flex-wrap items-center gap-2">
            <select v-model="picked[i.provider]" class="input w-auto" :aria-label="t('integrations.location')">
              <option v-for="loc in locations[i.provider]" :key="loc.externalId" :value="loc.externalId">
                {{ loc.name }} ({{ loc.currency }})
              </option>
            </select>
            <BaseButton :disabled="busy === i.provider || !picked[i.provider]" @click="saveLocation(i.provider)">
              {{ busy === i.provider ? t('common.action.saving') : t('common.action.save') }}
            </BaseButton>
          </div>
        </div>

        <div v-if="canEdit" class="flex flex-wrap items-center gap-2">
          <template v-if="i.status === 'not_connected' || i.status === 'disconnected' || i.status === 'needs_reauth'">
            <BaseButton v-if="onPaidPlan" :disabled="busy === i.provider" @click="connect(i.provider)">
              {{
                busy === i.provider
                  ? t('integrations.connecting')
                  : i.status === 'needs_reauth'
                    ? t('integrations.reconnect')
                    : t('integrations.connect')
              }}
            </BaseButton>
            <template v-else>
              <span class="text-xs text-smoke">{{ t('integrations.proOnly') }}</span>
              <RouterLink to="/pricing" class="text-xs font-medium text-ember-700 hover:underline">
                {{ t('pricing.seePlans') }}
              </RouterLink>
            </template>
          </template>
          <BaseButton
            v-if="i.status === 'active' && !picking[i.provider]"
            variant="ghost"
            :disabled="busy === i.provider"
            @click="startPicking(i.provider)"
          >
            {{ t('integrations.changeLocation') }}
          </BaseButton>
          <BaseButton
            v-if="i.status === 'active' || i.status === 'pending_location' || i.status === 'needs_reauth'"
            variant="ghost"
            :disabled="busy === i.provider"
            @click="disconnect(i.provider)"
          >
            {{ t('integrations.disconnect') }}
          </BaseButton>
        </div>
      </template>
    </div>
  </div>
</template>
