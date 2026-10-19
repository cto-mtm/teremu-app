<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { apiFetch } from '../lib/api'
import { CUISINES, listingStatusSchema, type Cuisine } from '../lib/schemas'
import BaseButton from './BaseButton.vue'
import type { z } from 'zod'

/**
 * Settings → "Tu restaurante" (owner only; docs/restaurant-listing.md):
 * the linked Google listing and its claim (verify / review / unlink), the
 * owner-confirmed website and cuisines, and the notes the assistant
 * answers from. Everything here is the owner's own data — Google content
 * is only ever linked to, never shown from storage.
 */
type Status = z.infer<typeof listingStatusSchema>

const { t } = useI18n()
const status = ref<Status | null>(null)
const loading = ref(true)

const website = ref('')
const cuisines = ref<Cuisine[]>([])
const notes = ref<{ text: string; origin: 'suggested' | 'owner' }[]>([])
const newNote = ref('')
const saving = ref(false)
const saved = ref(false)

function apply(s: Status): void {
  status.value = s
  website.value = s.listing?.website ?? ''
  cuisines.value = [...(s.listing?.cuisines ?? [])]
  notes.value = s.notes.map((n) => ({ text: n.text, origin: n.origin }))
}

async function load(): Promise<void> {
  loading.value = true
  const res = await apiFetch('/listing', undefined, listingStatusSchema)
  loading.value = false
  if (res.ok) apply(res.data)
}
onMounted(load)

const claimChip = computed(() =>
  status.value?.claim === 'verified' ? 'chip-down' : status.value?.claim === 'contested' ? 'chip-up' : 'rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-smoke',
)
const canVerify = computed(() => status.value?.claim === 'unverified' || status.value?.claim === 'contested')

function toggleCuisine(c: Cuisine): void {
  saved.value = false
  cuisines.value = cuisines.value.includes(c) ? cuisines.value.filter((x) => x !== c) : [...cuisines.value, c].slice(0, 4)
}

function addNote(): void {
  const text = newNote.value.trim()
  if (!text) return
  notes.value = [...notes.value, { text, origin: 'owner' }]
  newNote.value = ''
  saved.value = false
}

function removeNote(i: number): void {
  notes.value = notes.value.filter((_, j) => j !== i)
  saved.value = false
}

async function save(): Promise<void> {
  saving.value = true
  saved.value = false
  const res = await apiFetch(
    '/listing',
    {
      method: 'PUT',
      body: JSON.stringify({
        ...(status.value?.listing ? { website: website.value.trim() || null, cuisines: cuisines.value } : {}),
        notes: notes.value.filter((n) => n.text.trim()),
      }),
    },
    listingStatusSchema,
  )
  saving.value = false
  if (res.ok) {
    apply(res.data)
    saved.value = true
  } else alert(t('common.action.saveFailed'))
}

async function unlink(): Promise<void> {
  if (!confirm(t('settings.listing.unlinkConfirm'))) return
  const res = await apiFetch('/listing/unlink', { method: 'POST', body: '{}' }, listingStatusSchema)
  if (res.ok) apply(res.data)
  else alert(t('common.action.saveFailed'))
}

// ── Verification: a code to an address at the listing's own domain ──
const verifying = ref(false)
const email = ref('')
const code = ref('')
const sentTo = ref('')
const verifyBusy = ref(false)
const verifyError = ref('')
const verifyDone = ref(false)

const ERROR_KEYS = ['email_domain_mismatch', 'no_verifiable_domain', 'verified_elsewhere', 'already_verified', 'wrong_code', 'code_expired', 'too_many_attempts'] as const
function verifyErrorText(err: string): string {
  const known = ERROR_KEYS.find((k) => err.includes(k))
  if (known) return t(`settings.listing.verify.errors.${known}`)
  if (err.includes('rate_limited') || err.includes('mail_limit')) return t('settings.listing.verify.errors.limit')
  return t('settings.listing.verify.errors.generic')
}

async function sendCode(): Promise<void> {
  verifyBusy.value = true
  verifyError.value = ''
  const res = await apiFetch('/listing/verify', { method: 'POST', body: JSON.stringify({ email: email.value.trim() }) })
  verifyBusy.value = false
  if (res.ok) sentTo.value = email.value.trim()
  else verifyError.value = verifyErrorText(res.error)
}

async function confirmCode(): Promise<void> {
  verifyBusy.value = true
  verifyError.value = ''
  const res = await apiFetch('/listing/verify/confirm', { method: 'POST', body: JSON.stringify({ code: code.value.trim() }) })
  verifyBusy.value = false
  if (!res.ok) {
    verifyError.value = verifyErrorText(res.error)
    return
  }
  verifyDone.value = true
  verifying.value = false
  await load()
}

async function requestReview(): Promise<void> {
  const res = await apiFetch('/listing/review', { method: 'POST', body: '{}' })
  if (res.ok) await load()
  else alert(t('common.action.saveFailed'))
}
</script>

<template>
  <div class="card space-y-3">
    <div class="flex items-start justify-between gap-2">
      <div>
        <div class="text-sm font-semibold">{{ t('settings.listing.title') }}</div>
        <p class="text-xs text-smoke">{{ t('settings.listing.desc') }}</p>
      </div>
      <span v-if="status?.listing" :class="claimChip" class="shrink-0">{{ t('settings.listing.status.' + status.claim) }}</span>
    </div>

    <p v-if="loading" class="text-xs text-smoke">…</p>

    <!-- Not linked yet -->
    <div v-else-if="!status?.listing" class="space-y-2">
      <p class="text-xs text-smoke">{{ t('settings.listing.none') }}</p>
      <RouterLink :to="{ name: 'restaurant-setup' }" class="btn-primary">🏪 {{ t('settings.listing.find') }}</RouterLink>
    </div>

    <template v-else>
      <!-- The listing and its claim -->
      <div class="space-y-2 rounded-xl bg-cream p-3 text-xs">
        <div class="flex flex-wrap items-center gap-2">
          <span class="font-semibold">{{ t('settings.listing.googleMaps') }}</span>
          <a v-if="status.listing.mapsUrl" :href="status.listing.mapsUrl" target="_blank" rel="noopener" class="text-ember-700 underline">
            {{ t('settings.listing.seeOnMaps') }}
          </a>
        </div>
        <p v-if="status.claim === 'contested'" class="text-coral-600">{{ t('settings.listing.contestedHelp') }}</p>
        <p v-else-if="status.claim === 'unverified'" class="text-smoke">{{ t('settings.listing.unverifiedHelp') }}</p>
        <p v-if="verifyDone" class="font-semibold text-herb-700">✓ {{ t('settings.listing.verify.done') }}</p>

        <div v-if="canVerify" class="flex flex-wrap gap-2">
          <BaseButton v-if="!verifying" variant="ghost" @click="verifying = true">{{ t('settings.listing.verify.cta') }}</BaseButton>
          <BaseButton v-if="!status.reviewOpen" variant="ghost" @click="requestReview">{{ t('settings.listing.verify.review') }}</BaseButton>
          <span v-else class="self-center text-smoke">{{ t('settings.listing.verify.reviewOpen') }}</span>
        </div>

        <!-- Verify: email at the listing's domain → code -->
        <div v-if="verifying" class="space-y-2 border-t border-white pt-2">
          <p class="text-smoke">{{ t('settings.listing.verify.emailHelp') }}</p>
          <form v-if="!sentTo" class="flex flex-wrap gap-2" @submit.prevent="sendCode">
            <input
              v-model="email"
              type="email"
              autocomplete="email"
              class="input !w-auto min-w-0 flex-1 !py-1.5"
              :placeholder="t('settings.listing.verify.emailLabel')"
              :aria-label="t('settings.listing.verify.emailLabel')"
            />
            <button type="submit" class="btn-primary !py-1.5" :disabled="verifyBusy || !email.includes('@')">{{ t('settings.listing.verify.send') }}</button>
          </form>
          <form v-else class="space-y-2" @submit.prevent="confirmCode">
            <p>{{ t('settings.listing.verify.sent', { email: sentTo }) }}</p>
            <div class="flex gap-2">
              <input
                v-model="code"
                inputmode="numeric"
                autocomplete="one-time-code"
                maxlength="6"
                class="input !w-32 !py-1.5 text-center tracking-widest tabular-nums"
                :placeholder="t('settings.listing.verify.codeLabel')"
                :aria-label="t('settings.listing.verify.codeLabel')"
              />
              <button type="submit" class="btn-primary !py-1.5" :disabled="verifyBusy || !/^\d{6}$/.test(code.trim())">
                {{ t('settings.listing.verify.confirm') }}
              </button>
            </div>
          </form>
          <p v-if="verifyError" class="text-coral-600">{{ verifyError }}</p>
        </div>
      </div>

      <!-- Owner-confirmed details -->
      <label class="block space-y-1">
        <span class="text-xs text-smoke">{{ t('settings.listing.website') }}</span>
        <input v-model="website" type="text" inputmode="url" autocapitalize="off" class="input" :placeholder="t('settings.listing.websitePlaceholder')" @input="saved = false" />
      </label>
      <div class="space-y-1">
        <span class="text-xs text-smoke">{{ t('settings.listing.cuisines') }}</span>
        <div class="flex flex-wrap gap-1.5">
          <button
            v-for="c in CUISINES"
            :key="c"
            class="rounded-full px-2.5 py-0.5 text-xs font-semibold transition"
            :class="cuisines.includes(c) ? 'bg-ember text-white' : 'bg-gray-100 text-smoke hover:bg-gray-200'"
            :aria-pressed="cuisines.includes(c)"
            @click="toggleCuisine(c)"
          >
            {{ t('setup.cuisine.' + c) }}
          </button>
        </div>
      </div>
    </template>

    <!-- What the assistant knows (also for restaurants with no listing) -->
    <div v-if="!loading" class="space-y-1.5">
      <span class="text-xs font-semibold">✨ {{ t('settings.listing.notes') }}</span>
      <p class="text-xs text-smoke">{{ t('settings.listing.notesHelp') }}</p>
      <ul class="space-y-1">
        <li v-for="(note, i) in notes" :key="i" class="flex items-center gap-2">
          <input v-model="note.text" class="input !py-1.5 text-sm" maxlength="200" :aria-label="t('settings.listing.notes')" @input="note.origin = 'owner'; saved = false" />
          <button class="shrink-0 rounded px-1.5 text-smoke hover:bg-gray-100 hover:text-ink" :aria-label="t('setup.review.learnRemove')" @click="removeNote(i)">✕</button>
        </li>
      </ul>
      <form v-if="notes.length < 20" class="flex gap-2" @submit.prevent="addNote">
        <input v-model="newNote" class="input !py-1.5 text-sm" maxlength="200" :placeholder="t('settings.listing.notesPlaceholder')" :aria-label="t('settings.listing.notesPlaceholder')" />
        <button type="submit" class="btn-ghost shrink-0" :disabled="!newNote.trim()">＋</button>
      </form>
    </div>

    <div v-if="!loading" class="flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3">
      <BaseButton :disabled="saving" @click="save">{{ saving ? t('common.action.saving') : t('settings.listing.save') }}</BaseButton>
      <span v-if="saved" class="chip-down">{{ t('settings.listing.saved') }}</span>
      <span class="flex-1" />
      <RouterLink v-if="status?.listing" :to="{ name: 'restaurant-setup' }" class="btn-ghost">{{ t('settings.listing.reimport') }}</RouterLink>
      <BaseButton v-if="status?.listing?.placeId || status?.listing?.contestedPlaceId" variant="ghost" @click="unlink">
        {{ t('settings.listing.unlink') }}
      </BaseButton>
    </div>
  </div>
</template>
