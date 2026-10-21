<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { apiFetch } from '../lib/api'
import { CUISINES, listingStatusSchema, type Cuisine } from '../lib/schemas'
import { useAuthStore } from '../stores/auth'
import { useListingStore } from '../stores/listing'
import BaseButton from './BaseButton.vue'
import type { z } from 'zod'

/**
 * Settings → "Tu restaurante" (owner only; docs/restaurant-listing.md):
 * the linked Google listing and its claim (verify / review / unlink), the
 * owner-confirmed website and cuisines, and the notes the assistant
 * answers from. Everything here is the owner's own data; the live Google
 * panel (rating, photos, reviews) is fetched once per app session into
 * the store, never stored, and refreshed only when the owner asks.
 */
type Status = z.infer<typeof listingStatusSchema>

const { t, n } = useI18n()
const auth = useAuthStore()
const listing = useListingStore()
const status = ref<Status | null>(null)
const loading = ref(true)

const website = ref('')
const cuisines = ref<Cuisine[]>([])
// Owner-confirmed contact details: theirs once saved here, so the
// assistant may read them (docs/restaurant-listing.md, open decision 1).
const address = ref('')
const phone = ref('')
const hours = ref('')
const notes = ref<{ text: string; origin: 'suggested' | 'owner' }[]>([])
const newNote = ref('')
const saving = ref(false)
const saved = ref(false)

function apply(s: Status): void {
  status.value = s
  website.value = s.listing?.website ?? ''
  cuisines.value = [...(s.listing?.cuisines ?? [])]
  address.value = s.listing?.address ?? ''
  phone.value = s.listing?.phone ?? ''
  hours.value = s.listing?.hours ?? ''
  notes.value = s.notes.map((n) => ({ text: n.text, origin: n.origin }))
}

async function load(): Promise<void> {
  loading.value = true
  const res = await apiFetch('/listing', undefined, listingStatusSchema)
  loading.value = false
  if (res.ok) apply(res.data)
}
onMounted(load)

// Live Google panel: loads when a place is linked (session-cached in the store).
const linkedPlaceId = computed(() => status.value?.listing?.placeId ?? null)
watch(linkedPlaceId, (id) => { if (id) void listing.loadLinked(id) }, { immediate: true })
const live = computed(() => (listing.linked?.placeId === linkedPlaceId.value ? listing.linked.media : null))
const livePhotos = computed(() => live.value?.photos.slice(0, 5) ?? [])
/** Places policies: photo authors are credited visibly. */
const photoCredits = computed(() => [...new Set(livePhotos.value.flatMap((p) => p.attributions.map((a) => a.name)).filter(Boolean))].join(', '))
const liveError = computed(() => {
  const e = listing.linkedError
  if (!e) return null
  return e.includes('media_limit') ? t('settings.listing.live.limit') : e.includes('listing_unavailable') ? t('integrations.unavailable') : t('settings.listing.live.failed')
})

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
        ...(status.value?.listing
          ? {
              website: website.value.trim() || null,
              cuisines: cuisines.value,
              address: address.value.trim() || null,
              phone: phone.value.trim() || null,
              hours: hours.value.trim() || null,
            }
          : {}),
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

    <p v-if="loading" class="text-xs text-smoke">{{ t('common.loading') }}</p>

    <!-- Not linked yet -->
    <div v-else-if="!status?.listing" class="space-y-2">
      <p class="text-xs text-smoke">{{ t('settings.listing.none') }}</p>
      <RouterLink v-if="auth.profile?.listingAvailable" :to="{ name: 'restaurant-setup' }" class="btn-primary">🏪 {{ t('settings.listing.find') }}</RouterLink>
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

      <!-- Live from Google: one call per app session, refreshed on demand, never stored -->
      <div v-if="status.listing.placeId" class="space-y-3 rounded-xl bg-cream p-3 text-xs">
        <div class="flex flex-wrap items-center gap-2">
          <span class="font-semibold">{{ t('settings.listing.live.title') }}</span>
          <template v-if="live">
            <span v-if="live.rating !== null" class="font-semibold text-ink">★ {{ n(live.rating, { maximumFractionDigits: 1, minimumFractionDigits: 1 }) }}</span>
            <span v-if="live.reviewCount" class="text-smoke">{{ t('setup.review.reviewCount', { n: n(live.reviewCount) }, live.reviewCount) }}</span>
            <span v-if="live.openNow !== null" :class="live.openNow ? 'chip-down' : 'chip-up'">{{ live.openNow ? t('setup.review.openNow') : t('setup.review.closedNow') }}</span>
          </template>
          <span class="flex-1" />
          <button type="button" class="btn-ghost !py-1 text-xs" :disabled="listing.linkedBusy" @click="listing.loadLinked(status.listing.placeId, true)">
            {{ listing.linkedBusy ? t('settings.listing.live.loading') : t('settings.listing.live.refresh') }}
          </button>
        </div>
        <p v-if="liveError" class="text-coral-600">{{ liveError }}</p>
        <template v-else-if="live">
          <div v-if="livePhotos.length" class="grid grid-cols-5 gap-1 overflow-hidden rounded-lg">
            <img v-for="(p, i) in livePhotos" :key="i" :src="p.url" alt="" class="aspect-square w-full object-cover" loading="lazy" referrerpolicy="no-referrer" />
          </div>
          <p v-if="photoCredits" class="text-[10px] text-smoke">{{ t('setup.review.photoBy', { name: photoCredits }) }}</p>
          <div v-if="live.reviews.length" class="space-y-2">
            <p class="text-[11px] text-smoke">{{ t('setup.review.reviewsOrder') }}</p>
            <figure v-for="(r, i) in live.reviews" :key="i" class="space-y-1 rounded-lg bg-white p-2.5">
              <blockquote class="leading-relaxed">“{{ r.text }}”</blockquote>
              <figcaption class="flex flex-wrap items-center gap-1.5 text-[11px] text-smoke">
                <img v-if="r.author.photoUri" :src="r.author.photoUri" alt="" class="h-4 w-4 rounded-full" referrerpolicy="no-referrer" />
                <span class="text-ember" role="img" :aria-label="t('setup.review.stars', { n: r.rating })">{{ '★'.repeat(Math.round(r.rating)) }}</span>
                <a v-if="r.author.uri" :href="r.author.uri" target="_blank" rel="noopener" class="hover:underline">{{ r.author.name }}</a>
                <span v-else>{{ r.author.name }}</span>
                <span v-if="r.relativeTime">· {{ r.relativeTime }}</span>
                <a v-if="r.googleMapsUri" :href="r.googleMapsUri" target="_blank" rel="noopener" class="ml-auto font-semibold underline">{{ t('setup.review.seeOnMaps') }}</a>
              </figcaption>
            </figure>
          </div>
          <p class="text-[10px] text-smoke">{{ t('setup.review.attribution') }}</p>
        </template>
        <p v-else-if="listing.linkedBusy" class="text-smoke">{{ t('settings.listing.live.loading') }}</p>
      </div>

      <!-- Owner-confirmed details -->
      <label class="block space-y-1">
        <span class="text-xs text-smoke">{{ t('settings.listing.website') }}</span>
        <input v-model="website" type="text" inputmode="url" autocapitalize="off" class="input" :placeholder="t('settings.listing.websitePlaceholder')" @input="saved = false" />
      </label>
      <label class="block space-y-1">
        <span class="text-xs text-smoke">{{ t('settings.listing.address') }}</span>
        <input v-model="address" type="text" class="input" maxlength="200" @input="saved = false" />
      </label>
      <div class="grid gap-2 sm:grid-cols-2">
        <label class="block space-y-1">
          <span class="text-xs text-smoke">{{ t('settings.listing.phone') }}</span>
          <input v-model="phone" type="text" inputmode="tel" class="input" maxlength="40" @input="saved = false" />
        </label>
        <label class="block space-y-1">
          <span class="text-xs text-smoke">{{ t('settings.listing.hours') }}</span>
          <input v-model="hours" type="text" class="input" maxlength="400" :placeholder="t('settings.listing.hoursPlaceholder')" @input="saved = false" />
        </label>
      </div>
      <p class="text-[11px] text-smoke">{{ t('settings.listing.contactHelp') }}</p>
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
        <button type="submit" class="btn-ghost shrink-0" :disabled="!newNote.trim()" :aria-label="t('setup.review.learnAdd')">＋</button>
      </form>
    </div>

    <div v-if="!loading" class="flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3">
      <BaseButton :disabled="saving" @click="save">{{ saving ? t('common.action.saving') : t('common.action.save') }}</BaseButton>
      <span v-if="saved" class="chip-down">{{ t('common.action.saved') }}</span>
      <span class="flex-1" />
      <RouterLink v-if="status?.listing && auth.profile?.listingAvailable" :to="{ name: 'restaurant-setup' }" class="btn-ghost">{{ t('settings.listing.reimport') }}</RouterLink>
      <BaseButton v-if="status?.listing?.placeId || status?.listing?.contestedPlaceId" variant="ghost" @click="unlink">
        {{ t('settings.listing.unlink') }}
      </BaseButton>
    </div>
  </div>
</template>
