<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { z } from 'zod'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { apiFetch } from '../lib/api'
import { planRose } from '../lib/plans'
import { emailOAuthResultSchema, emailStatusSchema, emailSyncResultSchema } from '../lib/schemas'
import { useEmailConnect } from '../composables/useEmailConnect'
import { useEmailWaiting } from '../composables/useEmailWaiting'
import { useAuthStore } from '../stores/auth'
import { useInvoicesStore } from '../stores/invoices'
import { useLocationStore } from '../stores/location'
import BaseButton from './BaseButton.vue'
import BaseSpinner from './BaseSpinner.vue'
import UpgradeNotice from './UpgradeNotice.vue'

// Email inboxes (docs/email-ingestion.md): connect → Google consent →
// back here → disconnect. Same flow as IntegrationsCard: the API's OAuth
// callback brings the browser back with ?email=complete&state&code and
// this card finishes it as the signed-in user. Provider-generic: it
// renders whatever GET /email lists.
type Status = z.infer<typeof emailStatusSchema>
type Inbox = Status['inboxes'][number]

const { t, d } = useI18n()
const auth = useAuthStore()
const invoices = useInvoicesStore()
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

/** Inboxes this card is checking right now (the loader shows on them). */
const running = ref(new Set<string>())
const isRunning = (inbox: Inbox): boolean => running.value.has(inbox.id)
const current = (id: string): Inbox | undefined => status.value?.inboxes.find((i) => i.id === id)
let mounted = true
onUnmounted(() => (mounted = false))
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Rounds of "check now" one run may make — a 31-day backfill of a busy
 * inbox is a few dozen; past that the hourly job finishes it. */
const MAX_ROUNDS = 60

/**
 * Check an inbox until there is nothing left to do (`working` false), so
 * the owner watches it finish instead of guessing: each round is one
 * "check now" (a page of mail, a few invoices), then the counts refresh.
 * Stops when done, when the card unmounts, or on an error. If the hourly
 * job holds the inbox, it waits and looks again. `manual` = the button,
 * which also reports a throttle; the automatic start stays quiet.
 * Returns the invoices it imported and whether the meter still holds the
 * inbox — or null when it stopped short.
 */
async function runSync(id: string, manual: boolean): Promise<{ ingested: number; paused: boolean } | null> {
  if (running.value.has(id)) return null
  running.value.add(id)
  let finished = false
  let ingested = 0
  let paused = false
  try {
    for (let round = 0; round < MAX_ROUNDS && mounted; round += 1) {
      const res = await apiFetch(`/email/inboxes/${encodeURIComponent(id)}/sync`, { method: 'POST' }, emailSyncResultSchema)
      if (!res.ok && res.error.includes('email_sync_running')) {
        // The hourly job is on it: wait, then look — it may have finished.
        await pause(10_000)
      } else if (!res.ok) {
        const next = current(id)?.nextCheckAt ?? 0
        if (res.error.includes('email_sync_throttled')) {
          if (manual && next > 0) message.value = { ok: false, text: t('email.throttled', { date: d(new Date(next), 'short') }) }
        } else message.value = { ok: false, text: errorText(res.error) }
        await load() // whatever stopped us, show where the inbox really is
        break
      } else {
        ingested += res.data.ingested
        paused = res.data.paused
        // New invoices belong to the invoices store (Triage, its badge):
        // tell it, rather than keep a second copy of them here.
        if (res.data.ingested > 0 && auth.can('triage')) void invoices.refresh()
      }
      await load()
      if (!current(id)?.working) {
        finished = true
        break
      }
    }
  } finally {
    running.value.delete(id)
  }
  return finished && mounted ? { ingested, paused } : null
}

/** One inbox, checked to the end, then said so — "done", or that the
 * invoices it found wait for the plan (the notice below says how many).
 * A pause also refreshes the profile: its `emailWaiting` count is what the
 * Plan card, Triage and the pricing page show. */
async function checkNow(id: string, manual: boolean): Promise<void> {
  const done = await runSync(id, manual)
  if (!done) return
  message.value = done.paused ? { ok: false, text: t('email.syncedPaused') } : { ok: true, text: t('email.synced') }
  if (done.paused) void auth.reloadProfile()
}

/** Pick up any inbox with work left (after connecting, or after a reload
 * mid-backfill) — only for someone allowed to run "check now". */
function resumeWork(): void {
  if (!canEdit.value) return
  for (const inbox of status.value?.inboxes ?? []) {
    if (inbox.status === 'active' && inbox.working) void checkNow(inbox.id, false)
  }
}

/**
 * The plan grew while this card is open (back from checkout, or the dev
 * switch): the server already lifted the pause (`working` again), so drain
 * the backlog in front of the owner and say how many came in. A card
 * mounted after the upgrade gets the same through resumeWork().
 */
watch(
  () => [auth.profile?.restaurantId, auth.profile?.plan] as const,
  async ([rid, plan], [prevRid, prevPlan]) => {
    if (!plan || !prevPlan || rid !== prevRid || !planRose(prevPlan, plan)) return
    if (!canEdit.value || !status.value?.inboxes.some((i) => i.paused)) return
    await load()
    const working = (status.value?.inboxes ?? []).filter((i) => i.status === 'active' && i.working)
    const done = await Promise.all(working.map((i) => runSync(i.id, false)))
    if (mounted) message.value = { ok: true, text: t('email.resumed', done.reduce((sum, r) => sum + (r?.ingested ?? 0), 0)) }
  },
)

async function load(): Promise<void> {
  const res = await apiFetch('/email', undefined, emailStatusSchema)
  if (res.ok) status.value = res.data
}

// What the meter holds, by name: listed in the notice while an inbox is paused.
const waiting = useEmailWaiting(() => status.value?.inboxes.some((i) => i.paused) ?? false)

const { connect: startConnect } = useEmailConnect()
async function connect(provider: string): Promise<void> {
  busy.value = provider
  const error = await startConnect(provider)
  if (!error) return
  busy.value = null
  message.value = { ok: false, text: errorText(error) }
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
  // The code must not linger in the URL. Only this card's keys: `card`
  // is the page's deep link (Settings scrolls to and rings this card).
  if (email) void router.replace({ query: { ...route.query, email: undefined, state: undefined, code: undefined } })
  if (email === 'complete' && typeof state === 'string' && typeof code === 'string') {
    await completeOAuth(state, code)
  } else {
    showResult(email)
  }
  await load()
  // A fresh connection starts its 31-day check right away, in front of
  // the owner, instead of waiting for the hourly job.
  resumeWork()
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
        <RouterLink :to="{ path: '/pricing', query: { reason: 'email_free' } }" class="font-medium text-ember-700 hover:underline">{{ t('pricing.seePlans') }}</RouterLink>
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
        <!-- Progress: a loader and the running count while checking; a
             plain "done" once nothing is left (docs/email-ingestion.md). -->
        <div
          v-if="inbox.status === 'active' && (isRunning(inbox) || inbox.working)"
          class="flex items-center gap-2 text-xs text-smoke"
          role="status"
        >
          <BaseSpinner v-if="isRunning(inbox)" aria-hidden="true" />
          <span>{{ isRunning(inbox) ? t('email.progress', inbox.checked) : t('email.progressIdle', inbox.checked) }}</span>
        </div>
        <!-- Not while paused: invoices are waiting, so it isn't "up to date". -->
        <p v-else-if="inbox.status === 'active' && inbox.lastSyncAt && !inbox.paused" class="text-xs font-medium text-ink">
          ✓ {{ t('email.done', inbox.checked) }}
        </p>
        <p v-if="inbox.lastSyncAt || inbox.checked" class="text-xs">{{ t('email.found', inbox.found) }}</p>
        <p v-if="inbox.status === 'active' && !inbox.working && inbox.nextCheckAt > 0" class="text-xs text-smoke">
          {{ t('email.nextCheck', { date: d(new Date(inbox.nextCheckAt), 'short') }) }}
        </p>
        <UpgradeNotice
          v-if="inbox.paused"
          reason="email_quota"
          :title="t('email.paused', inbox.waiting)"
          :items="waiting?.items"
          :count="waiting?.waiting"
        />
        <p v-if="inbox.expired > 0" class="text-xs text-smoke">{{ t('email.expired', inbox.expired) }}</p>
        <div v-if="canEdit" class="flex flex-wrap items-center gap-2">
          <BaseButton
            v-if="inbox.status === 'active'"
            variant="ghost"
            :disabled="isRunning(inbox) || busy === inbox.id"
            @click="checkNow(inbox.id, true)"
          >
            {{ isRunning(inbox) ? t('email.syncing') : t('email.syncNow') }}
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
        <template v-else>
          <p v-if="p.testing" class="text-xs text-smoke">{{ t('email.testing') }}</p>
          <template v-if="canEdit">
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
        </template>
      </div>
    </template>
  </div>
</template>
