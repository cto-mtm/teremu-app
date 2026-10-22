<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { z } from 'zod'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { apiFetch } from '../lib/api'
import { emailOAuthResultSchema, emailStatusSchema, emailSyncResultSchema, posConnectSchema } from '../lib/schemas'
import { useAuthStore } from '../stores/auth'
import { useLocationStore } from '../stores/location'
import BaseButton from './BaseButton.vue'

// Email inboxes (docs/email-ingestion.md): connect → Google consent →
// back here → disconnect. Same flow as IntegrationsCard: the API's OAuth
// callback brings the browser back with ?email=complete&state&code and
// this card finishes it as the signed-in user. Provider-generic: it
// renders whatever GET /email lists.
type Status = z.infer<typeof emailStatusSchema>
type Inbox = Status['inboxes'][number]

const { t, d } = useI18n()
const auth = useAuthStore()
const location = useLocationStore()
const route = useRoute()
const router = useRouter()

const status = ref<Status | null>(null)
const busy = ref<string | null>(null)
const message = ref<{ ok: boolean; text: string } | null>(null)

const canEdit = computed(() => auth.can('integrations', 'edit'))
const onFreePlan = computed(() => auth.profile?.plan === 'free')
/** Inboxes the plan still has room for (one waiting to reconnect holds its slot). */
const atLimit = computed(() => (status.value ? status.value.inboxes.length >= status.value.limits.inboxes : true))
const cadence = computed(() => {
  const hours = status.value?.limits.syncHours ?? 24
  return hours >= 24 ? t('email.cadenceDaily') : t('email.cadenceHours', { n: hours })
})

const RESULTS = [
  'connected',
  'denied',
  'forbidden',
  'not_configured',
  'invalid_state',
  'failed',
  'missing_scope',
  'inbox_taken',
  'inbox_limit',
] as const
const ERRORS = ['email_inbox_limit', 'email_reauth', 'email_sync_running'] as const

function errorText(error: string): string {
  const known = ERRORS.find((code) => error.includes(code))
  return known ? t(`email.error.${known}`) : t('email.error.generic')
}

async function syncNow(inbox: Inbox): Promise<void> {
  busy.value = inbox.id
  const res = await apiFetch(
    `/email/inboxes/${encodeURIComponent(inbox.id)}/sync`,
    { method: 'POST' },
    emailSyncResultSchema,
  )
  busy.value = null
  // When it opens again comes from the server (GET /email nextCheckAt).
  if (res.ok) message.value = { ok: true, text: t('email.synced') }
  else if (res.error.includes('email_sync_throttled') && inbox.nextCheckAt > 0) {
    message.value = { ok: false, text: t('email.throttled', { date: d(new Date(inbox.nextCheckAt), 'short') }) }
  } else message.value = { ok: false, text: errorText(res.error) }
  await load()
}

async function load(): Promise<void> {
  const res = await apiFetch('/email', undefined, emailStatusSchema)
  if (res.ok) status.value = res.data
}

async function connect(provider: string): Promise<void> {
  busy.value = provider
  const res = await apiFetch(`/email/${provider}/connect`, { method: 'POST' }, posConnectSchema)
  if (res.ok) {
    window.location.href = res.data.url
    return
  }
  busy.value = null
  message.value = { ok: false, text: errorText(res.error) }
}

async function disconnect(inbox: Inbox): Promise<void> {
  if (!confirm(t('email.confirmDisconnect', { email: inbox.accountEmail }))) return
  busy.value = inbox.id
  const res = await apiFetch(`/email/inboxes/${encodeURIComponent(inbox.id)}`, { method: 'DELETE' })
  busy.value = null
  if (res.ok) await load()
  else message.value = { ok: false, text: errorText(res.error) }
}

function showResult(value: unknown, email = ''): void {
  const result = RESULTS.find((r) => r === value)
  if (result) message.value = { ok: result === 'connected', text: t(`email.result.${result}`, { email }) }
}

/** Back from Google: finish as the signed-in user, which is what proves
 * it's the same person who started the connection (a forwarded link can't). */
async function completeOAuth(state: string, code: string): Promise<void> {
  const res = await apiFetch(
    '/email/oauth',
    { method: 'POST', body: JSON.stringify({ state, code }) },
    emailOAuthResultSchema,
  )
  showResult(res.ok ? res.data.result : 'failed', res.ok ? res.data.accountEmail : '')
  // Started from another of the user's locations — show it where it landed.
  if (res.ok && res.data.rid && res.data.rid !== auth.profile?.restaurantId) {
    await location.switchLocation(res.data.rid)
  }
}

onMounted(async () => {
  const { email, state, code } = route.query
  if (email) void router.replace({ query: {} }) // the code must not linger in the URL
  if (email === 'complete' && typeof state === 'string' && typeof code === 'string') {
    await completeOAuth(state, code)
  } else {
    showResult(email)
  }
  void load()
})
</script>

<template>
  <div class="card space-y-3">
    <div class="text-sm font-semibold">{{ t('email.title') }}</div>
    <p class="text-xs text-smoke">{{ t('email.desc') }}</p>
    <div v-if="message" :class="message.ok ? 'chip-down' : 'chip-up'" class="inline-block">{{ message.text }}</div>

    <template v-if="status">
      <p v-if="onFreePlan" class="text-xs text-smoke">
        {{ t('email.freeCap') }}
        <RouterLink to="/pricing" class="font-medium text-ember-700 hover:underline">{{ t('pricing.seePlans') }}</RouterLink>
      </p>
      <p v-else-if="status.inboxes.length" class="text-xs text-smoke">{{ cadence }}</p>

      <div v-for="inbox in status.inboxes" :key="inbox.id" class="space-y-2 rounded-xl border border-gray-100 p-3">
        <div class="flex items-center justify-between gap-2">
          <div class="min-w-0">
            <div class="truncate text-sm font-medium">{{ inbox.accountEmail }}</div>
            <div class="text-xs text-smoke">{{ t('email.provider.' + inbox.provider) }}</div>
          </div>
          <span :class="inbox.status === 'active' ? 'chip-down' : 'chip-up'">{{ t('email.status.' + inbox.status) }}</span>
        </div>
        <p v-if="inbox.status === 'needs_reauth'" class="text-xs text-coral-600">{{ t('email.reauthHint') }}</p>
        <p class="text-xs text-smoke">
          {{
            inbox.lastSyncAt
              ? t('email.lastSync', { date: d(new Date(inbox.lastSyncAt), 'short') })
              : t('email.connectedSince', { date: d(new Date(inbox.connectedAt), 'short') })
          }}
        </p>
        <p v-if="inbox.status === 'active' && !inbox.backfillDone" class="text-xs text-smoke">{{ t('email.backfilling') }}</p>
        <p v-if="inbox.lastSyncAt" class="text-xs">{{ t('email.found', inbox.found) }}</p>
        <p v-if="inbox.paused" class="text-xs text-coral-600">
          {{ t('email.paused', { n: inbox.waiting }) }}
          <RouterLink to="/pricing" class="font-medium text-ember-700 hover:underline">{{ t('pricing.seePlans') }}</RouterLink>
        </p>
        <div v-if="canEdit" class="flex flex-wrap items-center gap-2">
          <BaseButton
            v-if="inbox.status === 'active'"
            variant="ghost"
            :disabled="busy === inbox.id"
            @click="syncNow(inbox)"
          >
            {{ busy === inbox.id ? t('email.syncing') : t('email.syncNow') }}
          </BaseButton>
          <BaseButton
            v-if="inbox.status === 'needs_reauth'"
            :disabled="busy === inbox.provider"
            @click="connect(inbox.provider)"
          >
            {{ busy === inbox.provider ? t('email.connecting') : t('email.reconnect') }}
          </BaseButton>
          <BaseButton variant="ghost" :disabled="busy === inbox.id" @click="disconnect(inbox)">
            {{ t('email.disconnect') }}
          </BaseButton>
        </div>
      </div>

      <div v-for="p in status.providers" :key="p.provider">
        <p v-if="!p.available" class="text-xs text-smoke">{{ t('email.unavailable') }}</p>
        <p v-if="p.available && p.testing" class="text-xs text-smoke">{{ t('email.testing') }}</p>
        <template v-else-if="canEdit">
          <BaseButton v-if="!atLimit" :disabled="busy === p.provider" @click="connect(p.provider)">
            {{
              busy === p.provider
                ? t('email.connecting')
                : t(status.inboxes.length ? 'email.connectAnother' : 'email.connect', {
                    provider: t('email.provider.' + p.provider),
                  })
            }}
          </BaseButton>
          <p v-else-if="status.limits.inboxes > 1 || !onFreePlan" class="text-xs text-smoke">
            {{ t('email.limit', status.limits.inboxes) }}
          </p>
        </template>
      </div>
    </template>
  </div>
</template>
