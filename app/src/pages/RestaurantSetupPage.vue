<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import BaseButton from '../components/BaseButton.vue'
import BaseSpinner from '../components/BaseSpinner.vue'
import { decimalMarkFor, parseAmount } from '../lib/csv'
import { useAuthStore } from '../stores/auth'
import { useKitchenStore } from '../stores/kitchen'
import { priceChanged, useListingStore, type ReviewDish } from '../stores/listing'

/**
 * "Find your restaurant" — the first-run step for a new owner
 * (docs/restaurant-listing.md). Search the Google listing → import it
 * (listing, website, menu — one API step at a time, so the progress is
 * real) → review and correct what was found → commit. The store holds the
 * import; this page is presentation and the review edits.
 */
const { t, n, locale } = useI18n()
const auth = useAuthStore()
const kitchen = useKitchenStore()
const listing = useListingStore()
const router = useRouter()

type Phase = 'search' | 'importing' | 'review' | 'done'
const phase = ref<Phase>('search')
onBeforeUnmount(() => {
  clearTimeout(debounce)
  listing.reset()
})

/** API error code → copy. */
function errorText(code: string | null): string {
  if (!code) return ''
  if (code.includes('import_limit')) return t('setup.errors.importLimit')
  if (code.includes('listing_unavailable')) return t('setup.errors.unavailable')
  if (code.includes('place_linked_to_your_location')) return t('setup.errors.linkedToYourLocation')
  if (code.includes('verified_place_linked')) return t('setup.errors.verifiedPlaceLinked')
  if (code.includes('search_limit')) return t('setup.errors.searchLimit')
  if (code.includes('not_a_menu')) return t('menu.scan.notMenu')
  if (code.includes('unreadable')) return t('menu.scan.unreadable')
  return t('setup.errors.generic')
}

// ── Search ──────────────────────────────────────────────────────
const query = ref('')
const searching = ref(false)
const searchError = ref('')
const results = ref<{ placeId: string; name: string; address: string }[]>([])
let searchSeq = 0
let debounce: ReturnType<typeof setTimeout> | undefined

watch(query, (q) => {
  clearTimeout(debounce)
  searchError.value = ''
  // Each pause while typing is a billed Google request: wait for 3
  // characters and a 400 ms pause (docs/business-model.md §4).
  if (q.trim().length < 3) {
    searchSeq += 1 // a response still in flight must not refill the list
    results.value = []
    searching.value = false
    return
  }
  searching.value = true
  debounce = setTimeout(async () => {
    const seq = ++searchSeq
    const found = await listing.search(q.trim())
    if (seq !== searchSeq) return // a newer keystroke won
    searching.value = false
    if (found) results.value = found
    else searchError.value = errorText(listing.error)
  }, 400)
})

// ── Import ──────────────────────────────────────────────────────
const SOURCES = ['profile', 'photos', 'website', 'menu', 'reviews'] as const
type Source = (typeof SOURCES)[number]
const ICONS: Record<Source, string> = { profile: '📍', photos: '📸', website: '🌐', menu: '📖', reviews: '💬' }
const chosen = ref<{ name: string; address: string } | null>(null)

/** What each checklist row shows right now. */
function rowState(s: Source): 'busy' | 'wait' | 'done' | 'not_found' | 'failed' {
  const job = listing.job
  if (!job) return s === 'profile' && listing.busy === 'import' ? 'busy' : 'wait'
  const state = job.steps[s].state
  if (state === 'pending') return listing.busy === s ? 'busy' : 'wait'
  return state
}
const settled = computed(() => SOURCES.filter((s) => !['busy', 'wait'].includes(rowState(s))).length)
const activeSource = computed(() => SOURCES.find((s) => rowState(s) === 'busy'))

async function begin(input: { placeId: string } | { manualName: string }, shown: { name: string; address: string }): Promise<void> {
  chosen.value = shown
  phase.value = 'importing'
  const ok = await listing.start(input)
  if (!ok) {
    phase.value = 'search'
    searchError.value = errorText(listing.error)
    return
  }
  enterReview()
}

const choose = (r: { placeId: string; name: string; address: string }) => begin({ placeId: r.placeId }, r)
const addManually = () => begin({ manualName: query.value.trim() }, { name: query.value.trim(), address: '' })

function restart(): void {
  listing.reset()
  chosen.value = null
  phase.value = 'search'
}

/**
 * Leave without importing: the skip is final for this location (the owner
 * can import later). Skipping first is what stops the router sending them
 * straight back here.
 */
watch(
  () => auth.profile?.restaurantId,
  (rid, prev) => {
    if (prev && rid !== prev) restart()
  },
)

const leaving = ref(false)
async function leave(to: string): Promise<void> {
  leaving.value = true
  const ok = !auth.listingSetupPending || (await auth.skipListingSetup())
  leaving.value = false
  if (ok) await router.replace(to)
  else alert(t('common.action.saveFailed'))
}

// ── Review ──────────────────────────────────────────────────────
const place = computed(() => listing.job?.place ?? null)
const restaurantName = computed(() => place.value?.name ?? listing.job?.manualName ?? '')
const isManual = computed(() => !listing.job?.placeId)
const photos = computed(() => listing.media?.photos ?? [])
/** Places policies: photo authors are credited visibly, not just on hover. */
const photoCredits = computed(() =>
  [...new Set(photos.value.slice(0, 5).flatMap((p) => p.attributions.map((a) => a.name)).filter(Boolean))].join(', '),
)
const reviews = computed(() => listing.media?.reviews ?? [])
/** Places' weekday lines start on Monday. */
const hoursToday = computed(() => place.value?.weekHours[(new Date().getDay() + 6) % 7] ?? null)
// Contact details the owner confirms (editable, saved on commit as THEIR
// data — docs/restaurant-listing.md open decision 1). Prefilled from the
// listing once per place, never overwritten by a later job refresh.
const contact = reactive({ address: '', phone: '', hours: '' })
watch(
  () => place.value?.placeId ?? null,
  () => {
    const p = place.value
    contact.address = p?.address ?? ''
    contact.phone = p?.phone ?? ''
    contact.hours = p?.weekHours.join('; ') ?? ''
  },
  { immediate: true },
)

function enterReview(): void {
  editingKey.value = null
  websiteUrl.value = ''
  websiteMessage.value = ''
  learnings.value = initialLearnings()
  phase.value = 'review'
}

/** Dishes grouped by menu section, keeping menu order; sectionless last. */
const sections = computed(() => {
  const out = new Map<string | null, ReviewDish[]>()
  for (const d of listing.dishes) out.set(d.section, [...(out.get(d.section) ?? []), d])
  return [...out.entries()].sort(([a], [b]) => Number(a === null) - Number(b === null))
})
const selectedCount = computed(() => listing.dishes.filter((d) => d.selected && d.name.trim()).length)

function toggleSection(list: ReviewDish[]): void {
  const all = list.every((d) => d.selected)
  for (const d of list) d.selected = !all
}

const money = (x: number) => n(x, 'currency')
const plainPrice = (x: number) => n(x, { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false })

// Inline edit — one row at a time.
const editingKey = ref<string | null>(null)
const draftName = ref('')
const draftPrice = ref('')
const draftInvalid = ref(false)
// A price the owner TYPES follows the UI language (an export would follow the currency).
const parseDraft = () => parseAmount(draftPrice.value, decimalMarkFor(locale.value))

async function startEdit(d: ReviewDish, field: 'name' | 'price'): Promise<void> {
  if (editingKey.value !== null && editingKey.value !== d.key && !saveEdit()) return
  editingKey.value = d.key
  draftName.value = d.name
  draftPrice.value = d.price !== null ? plainPrice(d.price) : ''
  draftInvalid.value = false
  await nextTick()
  const el = document.getElementById(`dish-${field}-${d.key}`) as HTMLInputElement | null
  el?.focus()
  el?.select()
}

/** Returns false (and keeps the row open) when the draft isn't valid. */
function saveEdit(): boolean {
  const d = listing.dishes.find((x) => x.key === editingKey.value)
  if (!d) return true
  const price = parseDraft()
  if (!draftName.value.trim() || !(price >= 0)) {
    draftInvalid.value = true
    return false
  }
  d.name = draftName.value.trim()
  d.price = Math.round(price * 100) / 100
  d.confirmed = true
  d.selected = true
  editingKey.value = null
  return true
}

function cancelEdit(): void {
  const d = listing.dishes.find((x) => x.key === editingKey.value)
  // A brand-new row abandoned before it had a name just goes away.
  if (d && d.source === 'manual' && !d.name) listing.removeDish(d.key)
  editingKey.value = null
}

function pickPrice(d: ReviewDish, price: number): void {
  d.price = price
  d.confirmed = true
}

function addDish(): void {
  void startEdit(listing.addManualDish(), 'name')
}

// Fallbacks: the owner's own website link, a photo of the printed menu.
const photoInput = ref<HTMLInputElement | null>(null)
const photoMessage = ref('')
async function onPhoto(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  photoMessage.value = ''
  if (!(await listing.addMenuPhoto(file))) photoMessage.value = errorText(listing.error)
}

const websiteUrl = ref('')
const websiteMessage = ref('')
async function onWebsite(): Promise<void> {
  if (!websiteUrl.value.trim()) return
  websiteMessage.value = ''
  const before = listing.dishes.length
  const ok = await listing.readWebsite(websiteUrl.value)
  const job = listing.job
  if (!ok) websiteMessage.value = listing.error?.includes('bad_website') ? t('setup.review.websiteBad') : errorText(listing.error)
  else if (job?.steps.website.state !== 'done') websiteMessage.value = t('setup.review.websiteUnreachable')
  else if (job.menuNote === 'pdf') websiteMessage.value = t('setup.review.pdfMenu')
  else if (listing.dishes.length === before) websiteMessage.value = t('setup.review.websiteNoMenu')
}

// ── What the assistant learns (editable; the owner has the last word) ─
interface Learning {
  id: number
  text: string
  origin: 'suggested' | 'owner'
}
const learnings = ref<Learning[]>([])
const editingLearning = ref<number | null>(null)
const newLearning = ref('')
let learningId = 0

/** From the listing and the menu only — never from review text
 * (docs/restaurant-listing.md §Compliance). */
function initialLearnings(): Learning[] {
  const p = place.value
  const priced = listing.dishes.filter((d) => d.price !== null)
  const avg = priced.length ? priced.reduce((s, d) => s + (d.price ?? 0), 0) / priced.length : 0
  return [
    p && p.cuisines.length
      ? p.priceLevel
        ? t('setup.review.learn.identity', {
            cuisine: p.cuisines.map((c) => t('setup.cuisine.' + c)).join(' · '),
            city: p.city ?? '',
            price: t('setup.priceLevel.' + p.priceLevel),
          })
        : t('setup.review.learn.identityNoPrice', {
            cuisine: p.cuisines.map((c) => t('setup.cuisine.' + c)).join(' · '),
            city: p.city ?? '',
          })
      : null,
    avg ? t('setup.review.learn.ticket', { avg: money(avg) }) : null,
    listing.dishes.length ? t('setup.review.learn.size', { n: listing.dishes.length }, listing.dishes.length) : null,
  ]
    .filter((x): x is string => !!x)
    .map((text) => ({ id: learningId++, text, origin: 'suggested' as const }))
}

let learningBefore = ''
async function editLearning(l: Learning): Promise<void> {
  learningBefore = l.text
  editingLearning.value = l.id
  await nextTick()
  ;(document.getElementById(`learning-${l.id}`) as HTMLInputElement | null)?.focus()
}

function saveLearning(l: Learning): void {
  l.text = l.text.trim()
  if (l.text !== learningBefore) l.origin = 'owner'
  if (!l.text) removeLearning(l)
  editingLearning.value = null
}

function removeLearning(l: Learning): void {
  learnings.value = learnings.value.filter((x) => x !== l)
}

function addLearning(): void {
  const text = newLearning.value.trim()
  if (!text) return
  learnings.value = [...learnings.value, { id: learningId++, text, origin: 'owner' }]
  newLearning.value = ''
}

// ── Commit ──────────────────────────────────────────────────────
const outcome = ref<{ link: string; saved: number; created: number } | null>(null)

async function confirmImport(): Promise<void> {
  if (editingKey.value !== null && !saveEdit()) return
  if (listing.missingPrice) {
    alert(t('setup.review.missingPrices', { n: listing.missingPrice }, listing.missingPrice))
    return
  }
  const res = await listing.commit({
    restaurant: {
      name: restaurantName.value,
      website: listing.job?.website ?? null,
      cuisines: place.value?.cuisines ?? [],
      priceLevel: place.value?.priceLevel ?? null,
      address: contact.address.trim() || null,
      phone: contact.phone.trim() || null,
      hours: contact.hours.trim() || null,
    },
    notes: learnings.value.filter((l) => l.text.trim()).map((l) => ({ text: l.text.trim(), origin: l.origin })),
  })
  if (!res.ok) {
    alert(
      res.error.includes('place_linked_to_your_location') || res.error.includes('verified_place_linked')
        ? errorText(res.error)
        : t('setup.errors.commitFailed'),
    )
    return
  }
  outcome.value = { link: res.link, saved: res.created.length + res.updated, created: res.created.length }
  // The name, setupListing and maybe country/currency changed; new dishes too.
  await auth.reloadProfile()
  void kitchen.refresh()
  phase.value = 'done'
}

/** Hand off to the recipe wizard; the first-login tour waits for it. */
function estimateRecipes(): void {
  listing.handoff = true
  void router.replace({ path: '/menu', query: { recipes: 'listing' } })
}

/** First + last capitalised word: "Taberna El Faro" → "TF". */
const initials = (name: string) => {
  const caps = name.split(/\s+/).filter((w) => /^\p{Lu}/u.test(w))
  return caps.length > 1 ? caps[0][0] + caps[caps.length - 1][0] : (caps[0] ?? name).slice(0, 2).toUpperCase()
}
</script>

<template>
  <div class="mx-auto max-w-2xl pb-10">
    <Transition name="setup-phase" mode="out-in">
      <!-- ── 1. Search ─────────────────────────────────────── -->
      <section v-if="phase === 'search'" key="search" class="space-y-6 pt-4 sm:pt-10">
        <div class="space-y-2 text-center">
          <div class="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-ember-50 text-3xl" aria-hidden="true">
            🏪
          </div>
          <h1 class="text-3xl font-bold">{{ t('setup.search.title') }}</h1>
          <p class="mx-auto max-w-md text-sm leading-relaxed text-smoke">{{ t('setup.search.subtitle') }}</p>
        </div>

        <div class="relative">
          <svg
            viewBox="0 0 24 24"
            class="pointer-events-none absolute top-1/2 left-4 h-5 w-5 -translate-y-1/2 text-smoke"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            v-model="query"
            type="search"
            autofocus
            class="input !rounded-2xl !py-4 !pr-12 !pl-12 !text-base shadow-card"
            :placeholder="t('setup.search.placeholder')"
            :aria-label="t('setup.search.placeholder')"
          />
          <BaseSpinner
            v-if="searching"
            size="md"
            tone="soft"
            class="absolute top-1/2 right-4 -translate-y-1/2"
            aria-hidden="true"
          />
        </div>

        <p v-if="searchError" class="rounded-xl bg-coral-50 px-3 py-2 text-sm text-coral-600">{{ searchError }}</p>

        <TransitionGroup name="list" tag="ul" class="relative space-y-2">
          <li v-for="(r, i) in results" :key="r.placeId" :style="{ transitionDelay: i * 40 + 'ms' }">
            <button
              class="card flex w-full items-center gap-3 !p-3 text-left transition hover:-translate-y-0.5 active:scale-[0.99]"
              @click="choose(r)"
            >
              <span class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-ember text-sm font-bold text-white">
                {{ initials(r.name) }}
              </span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm font-semibold">{{ r.name }}</span>
                <span class="block truncate text-xs text-smoke">{{ r.address }}</span>
              </span>
              <span class="shrink-0 text-ember" aria-hidden="true">›</span>
            </button>
          </li>
        </TransitionGroup>

        <div v-if="!searching && query.trim()" class="space-y-2 text-center">
          <p v-if="query.trim().length >= 3 && !results.length && !searchError" class="text-sm text-smoke">{{ t('setup.search.noResults') }}</p>
          <button class="text-sm font-semibold text-ember-700 hover:underline" @click="addManually">
            {{ results.length ? t('setup.search.notListed') : t('setup.search.addManually', { name: query.trim() }) }}
          </button>
        </div>
        <p v-else-if="!query" class="text-center text-xs text-smoke">{{ t('setup.search.hint') }}</p>

        <div class="text-center">
          <button
            class="text-xs font-medium text-smoke underline-offset-2 hover:text-ink hover:underline disabled:opacity-40"
            :disabled="leaving"
            @click="leave('/')"
          >
            {{ t('setup.search.skip') }}
          </button>
        </div>
      </section>

      <!-- ── 2. Importing ──────────────────────────────────── -->
      <section v-else-if="phase === 'importing' && chosen" key="importing" class="space-y-6 pt-4 sm:pt-10">
        <div class="flex flex-col items-center gap-4 text-center">
          <div class="relative flex h-28 w-28 items-center justify-center" aria-hidden="true">
            <span class="setup-ring absolute inset-0 rounded-full bg-ember/20" />
            <span class="setup-ring setup-ring-late absolute inset-0 rounded-full bg-ember/20" />
            <span class="relative flex h-20 w-20 items-center justify-center rounded-full bg-ember text-2xl font-bold text-white shadow-card">
              {{ initials(chosen.name) }}
            </span>
          </div>
          <div>
            <h1 class="text-2xl font-bold">{{ chosen.name }}</h1>
            <p v-if="chosen.address" class="text-xs text-smoke">{{ chosen.address }}</p>
          </div>
          <p class="text-sm text-smoke" aria-live="polite">
            {{ activeSource ? t('setup.importing.' + activeSource + '.active') : t('setup.importing.finishing') }}
          </p>
        </div>

        <div class="h-1.5 overflow-hidden rounded-full bg-ember-50">
          <div class="setup-bar h-full origin-left rounded-full bg-ember" :style="{ transform: `scaleX(${settled / SOURCES.length})` }" />
        </div>

        <ul class="card space-y-1 !p-2">
          <li
            v-for="s in SOURCES"
            :key="s"
            class="flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors"
            :class="rowState(s) === 'busy' ? 'bg-ember-50' : ''"
          >
            <span class="text-xl" aria-hidden="true">{{ ICONS[s] }}</span>
            <span class="flex-1 text-sm" :class="rowState(s) === 'wait' ? 'text-smoke' : 'font-medium'">
              {{ t('setup.importing.' + s + '.label') }}
            </span>
            <Transition name="setup-pop" mode="out-in" type="transition">
              <span v-if="rowState(s) === 'not_found' || rowState(s) === 'failed'" key="none" class="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-smoke">
                {{ rowState(s) === 'failed' ? t('setup.importing.failed') : t('setup.importing.notFound') }}
              </span>
              <span v-else-if="rowState(s) === 'done'" key="done" class="chip-down">
                ✓ {{ listing.job?.steps[s].count !== undefined ? t('setup.importing.' + s + '.found', { n: listing.job?.steps[s].count }, listing.job?.steps[s].count ?? 0) : t('setup.importing.' + s + '.ready') }}
              </span>
              <BaseSpinner
                v-else-if="rowState(s) === 'busy'"
                key="busy"
                size="sm"
                tone="soft"
                aria-hidden="true"
              />
              <span v-else key="wait" class="h-1.5 w-1.5 rounded-full bg-gray-200" aria-hidden="true" />
            </Transition>
          </li>
        </ul>
      </section>

      <!-- ── 3. Review ─────────────────────────────────────── -->
      <section v-else-if="phase === 'review' && listing.job" key="review" class="space-y-4 pt-2">
        <!-- Hero: live photos (never stored) + identity -->
        <div class="card setup-rise overflow-hidden !p-0">
          <div
            v-if="photos.length"
            class="grid h-40 gap-0.5 sm:h-48"
            :class="photos.length >= 5 ? 'grid-cols-4 grid-rows-2' : ''"
            :style="photos.length < 5 ? { gridTemplateColumns: photos.length > 1 ? `2fr repeat(${photos.length - 1}, 1fr)` : '1fr' } : undefined"
          >
            <img
              v-for="(ph, i) in photos.slice(0, 5)"
              :key="ph.url"
              :src="ph.url"
              :alt="''"
              class="h-full w-full object-cover"
              :class="i === 0 && photos.length >= 5 ? 'col-span-2 row-span-2' : ''"
              loading="lazy"
              referrerpolicy="no-referrer"
            />
          </div>
          <p v-if="photoCredits" class="px-4 pt-2 text-[10px] text-smoke">
            {{ t('setup.review.photoBy', { name: photoCredits }) }}
            <a v-if="listing.media?.googleMapsUri" :href="listing.media.googleMapsUri" target="_blank" rel="noopener" class="underline">
              {{ t('setup.review.seeOnMaps') }}
            </a>
          </p>
          <div v-else-if="!photos.length" class="flex h-28 items-center justify-center bg-gradient-to-br from-ember-100 to-ember-200" aria-hidden="true">
            <span class="flex h-16 w-16 items-center justify-center rounded-full bg-ember text-xl font-bold text-white shadow-card">
              {{ initials(restaurantName) }}
            </span>
          </div>
          <div class="space-y-3 p-4">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <h1 class="truncate text-2xl font-bold">{{ restaurantName }}</h1>
                <div v-if="place?.rating" class="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-smoke">
                  <span class="font-semibold text-ink">★ {{ n(place.rating, { maximumFractionDigits: 1, minimumFractionDigits: 1 }) }}</span>
                  <span v-if="place.reviewCount">{{ t('setup.review.reviewCount', { n: n(place.reviewCount) }, place.reviewCount) }}</span>
                  <template v-if="place.priceLevel">
                    <span aria-hidden="true">·</span>
                    <span>{{ t('setup.priceLevel.' + place.priceLevel) }}</span>
                  </template>
                </div>
                <p v-else-if="isManual" class="mt-1 text-xs text-smoke">{{ t('setup.review.manualHint') }}</p>
              </div>
              <span v-if="place && place.openNow !== null" :class="place.openNow ? 'chip-down' : 'chip-up'" class="shrink-0">
                {{ place.openNow ? t('setup.review.openNow') : t('setup.review.closedNow') }}
              </span>
            </div>
            <div v-if="place?.cuisines.length" class="flex flex-wrap gap-1.5">
              <span v-for="c in place.cuisines" :key="c" class="rounded-full bg-ember-50 px-2.5 py-0.5 text-xs font-semibold text-ember-700">
                {{ t('setup.cuisine.' + c) }}
              </span>
            </div>
            <!-- Contact details: prefilled from the listing, confirmed (and
                 editable) by the owner, saved on commit as their own data. -->
            <div class="space-y-1.5 text-xs">
              <p class="font-semibold">{{ t('setup.review.contactTitle') }}</p>
              <p v-if="place && hoursToday" class="text-smoke">🕒 {{ t('setup.review.hoursToday', { hours: hoursToday }) }}</p>
              <label class="flex items-center gap-2">
                <span aria-hidden="true">📍</span>
                <input v-model="contact.address" class="input !py-1.5 text-sm" maxlength="200" :placeholder="t('setup.review.contactAddress')" :aria-label="t('setup.review.contactAddress')" />
              </label>
              <label class="flex items-center gap-2">
                <span aria-hidden="true">🕒</span>
                <input v-model="contact.hours" class="input !py-1.5 text-sm" maxlength="400" :placeholder="t('setup.review.contactHours')" :aria-label="t('setup.review.contactHours')" />
              </label>
              <label class="flex items-center gap-2">
                <span aria-hidden="true">📞</span>
                <input v-model="contact.phone" class="input !py-1.5 text-sm" inputmode="tel" maxlength="40" :placeholder="t('setup.review.contactPhone')" :aria-label="t('setup.review.contactPhone')" />
              </label>
              <div class="flex gap-2">
                <span aria-hidden="true">🌐</span>
                <span :class="listing.job.website ? '' : 'text-smoke'">{{ listing.job.website ?? t('setup.review.noWebsite') }}</span>
              </div>
              <p class="text-[11px] text-smoke">{{ t('setup.review.contactHelp') }}</p>
            </div>
            <p v-if="place" class="text-[11px] text-smoke">
              {{ t('setup.review.googleMaps') }}
              <a v-if="place.googleMapsUri" :href="place.googleMapsUri" target="_blank" rel="noopener" class="font-semibold underline">
                {{ t('setup.review.seeOnMaps') }}
              </a>
            </p>
          </div>
        </div>

        <!-- Menu -->
        <div class="card setup-rise space-y-3" style="animation-delay: 60ms">
          <template v-if="listing.dishes.length">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div class="text-sm font-semibold">{{ t('setup.review.menuTitle', { n: listing.dishes.length }, listing.dishes.length) }}</div>
              <span v-if="listing.toReview" class="chip-up">{{ t('setup.review.toReview', { n: listing.toReview }) }}</span>
              <span v-else class="chip-down">✓ {{ t('setup.review.allReviewed') }}</span>
            </div>
            <p class="text-xs text-smoke">{{ t('setup.review.menuHint') }}</p>

            <div v-for="[section, list] in sections" :key="section ?? '—'" class="space-y-1">
              <div class="flex items-center justify-between pt-1">
                <div class="text-[11px] font-bold tracking-wide text-smoke uppercase">{{ section ?? t('setup.review.addedByYou') }}</div>
                <button class="text-[11px] font-semibold text-ember-700 hover:underline" @click="toggleSection(list)">
                  {{ list.every((d) => d.selected) ? t('setup.review.sectionNone') : t('setup.review.sectionAll') }}
                </button>
              </div>

              <TransitionGroup name="list" tag="div" class="relative space-y-1">
                <div
                  v-for="d in list"
                  :key="d.key"
                  class="rounded-xl transition-colors"
                  :class="editingKey === d.key ? 'bg-ember-50 ring-1 ring-ember-200' : d.selected && !d.confirmed ? 'bg-coral-50/50' : ''"
                >
                  <!-- Editing -->
                  <form v-if="editingKey === d.key" class="flex flex-wrap items-center gap-2 p-2" @submit.prevent="saveEdit" @keydown.esc="cancelEdit">
                    <input
                      :id="`dish-name-${d.key}`"
                      v-model="draftName"
                      class="input min-w-0 flex-1 !py-1.5"
                      :class="draftInvalid && !draftName.trim() ? '!border-coral' : ''"
                      :placeholder="t('setup.review.namePlaceholder')"
                      :aria-label="t('setup.review.namePlaceholder')"
                    />
                    <input
                      :id="`dish-price-${d.key}`"
                      v-model="draftPrice"
                      inputmode="decimal"
                      class="input !w-24 !py-1.5 text-right tabular-nums"
                      :class="draftInvalid && !(parseDraft() >= 0) ? '!border-coral' : ''"
                      :placeholder="plainPrice(0)"
                      :aria-label="t('setup.review.pricePlaceholder')"
                    />
                    <button type="submit" class="btn-primary !px-3 !py-1.5" :aria-label="t('common.action.save')">✓</button>
                    <button type="button" class="btn-ghost !px-3 !py-1.5" :aria-label="t('common.action.cancel')" @click="cancelEdit">✕</button>
                  </form>

                  <!-- Display -->
                  <template v-else>
                    <div class="flex items-center gap-3 px-2 py-2">
                      <button
                        class="flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 text-[11px] font-bold text-white transition"
                        :class="d.selected ? 'border-ember bg-ember' : 'border-gray-300'"
                        role="checkbox"
                        :aria-checked="d.selected"
                        :aria-label="d.name"
                        @click="d.selected = !d.selected"
                      >
                        <span v-if="d.selected" aria-hidden="true">✓</span>
                      </button>
                      <button class="min-w-0 flex-1 text-left" :title="t('setup.review.tapToEdit')" @click="startEdit(d, 'name')">
                        <span class="block truncate text-sm" :class="d.selected ? '' : 'text-smoke line-through'">{{ d.name }}</span>
                        <span class="text-[11px] text-smoke">
                          {{ t('setup.review.source.' + d.source) }}
                          <span v-if="d.match" class="font-semibold text-herb-700">
                            · {{ priceChanged(d) ? t('setup.review.priceChange', { from: money(d.match.price) }) : t('setup.review.onMenu') }}
                          </span>
                        </span>
                      </button>
                      <button
                        class="group flex items-center gap-1 rounded-lg px-1.5 py-1 text-sm font-semibold tabular-nums transition hover:bg-white"
                        :class="d.selected && !d.confirmed ? 'text-coral-600' : ''"
                        :aria-label="t('setup.review.editPrice', { dish: d.name })"
                        @click="startEdit(d, 'price')"
                      >
                        {{ d.price !== null ? money(d.price) : t('setup.review.noPrice') }}
                        <svg viewBox="0 0 24 24" class="h-3.5 w-3.5 text-smoke opacity-50 group-hover:opacity-100" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                          <path d="M4 20h4L19 9l-4-4L4 16v4Z" />
                        </svg>
                      </button>
                    </div>

                    <!-- Two prices on the site → pick the current one -->
                    <div v-if="d.selected && !d.confirmed && d.altPrice !== undefined && d.price !== null" class="flex flex-wrap items-center gap-1.5 px-2 pb-2 pl-10 text-[11px]">
                      <span class="text-smoke">{{ t('setup.review.conflict') }}</span>
                      <button class="rounded-full border border-gray-200 bg-white px-2 py-0.5 font-semibold hover:border-ember" @click="pickPrice(d, d.price)">
                        {{ money(d.price) }}
                      </button>
                      <button class="rounded-full border border-gray-200 bg-white px-2 py-0.5 font-semibold hover:border-ember" @click="pickPrice(d, d.altPrice)">
                        {{ money(d.altPrice) }}
                      </button>
                    </div>
                    <!-- Read from an image → confirm or fix -->
                    <div v-else-if="d.selected && !d.confirmed && d.price !== null" class="flex flex-wrap items-center gap-1.5 px-2 pb-2 pl-10 text-[11px]">
                      <span class="text-smoke">{{ t('setup.review.photoPrice') }}</span>
                      <button class="rounded-full border border-gray-200 bg-white px-2 py-0.5 font-semibold hover:border-herb" @click="d.confirmed = true">
                        ✓ {{ t('setup.review.looksRight') }}
                      </button>
                    </div>
                  </template>
                </div>
              </TransitionGroup>
            </div>
          </template>

          <!-- Nothing found -->
          <div v-else class="space-y-1 py-2 text-center">
            <div class="text-3xl" aria-hidden="true">📖</div>
            <div class="text-sm font-semibold">{{ t('setup.review.emptyTitle') }}</div>
            <p class="mx-auto max-w-sm text-xs text-smoke">
              {{ listing.job.menuNote === 'pdf' ? t('setup.review.pdfMenu') : t('setup.review.emptyBody') }}
            </p>
          </div>

          <!-- No menu from the website → paste (another) link -->
          <form v-if="!listing.job.website || listing.job.steps.menu.state !== 'done'" class="space-y-1.5 rounded-xl bg-cream p-3" @submit.prevent="onWebsite">
            <label for="setup-website" class="text-xs font-semibold">🌐 {{ t('setup.review.websiteAsk') }}</label>
            <div class="flex gap-2">
              <input
                id="setup-website"
                v-model="websiteUrl"
                type="text"
                inputmode="url"
                autocomplete="url"
                autocapitalize="off"
                class="input !py-1.5"
                :placeholder="t('setup.review.websitePlaceholder')"
                :disabled="!!listing.busy"
              />
              <button type="submit" class="btn-primary shrink-0 !py-1.5" :disabled="!!listing.busy || !websiteUrl.trim()">
                <BaseSpinner v-if="listing.busy === 'website' || listing.busy === 'menu'" tone="light" aria-hidden="true" />
                {{ listing.busy === 'website' || listing.busy === 'menu' ? t('setup.review.websiteReading') : t('setup.review.websiteRead') }}
              </button>
            </div>
            <p v-if="websiteMessage" class="text-[11px] text-coral-600">{{ websiteMessage }}</p>
          </form>

          <!-- Add more -->
          <div class="flex flex-wrap gap-2 border-t border-gray-100 pt-3">
            <button class="btn-ghost" :disabled="editingKey !== null" @click="addDish">＋ {{ t('setup.review.addDish') }}</button>
            <button class="btn-ghost" :disabled="!!listing.busy" @click="photoInput?.click()">
              <BaseSpinner v-if="listing.busy === 'photo'" tone="ink" aria-hidden="true" />
              <span v-else aria-hidden="true">📷</span>
              {{ listing.busy === 'photo' ? t('setup.review.photoReading') : t('setup.review.scanPhoto') }}
            </button>
            <input ref="photoInput" type="file" accept="image/*" capture="environment" class="hidden" @change="onPhoto" />
          </div>
          <p v-if="photoMessage" class="text-[11px] text-coral-600">{{ photoMessage }}</p>
        </div>

        <!-- Guests' reviews — live from Google, attributed, never stored -->
        <div v-if="reviews.length" class="card setup-rise space-y-3" style="animation-delay: 120ms">
          <div>
            <div class="text-sm font-semibold">{{ t('setup.review.reviewsTitle') }}</div>
            <p class="text-[11px] text-smoke">{{ t('setup.review.reviewsOrder') }}</p>
          </div>
          <figure v-for="(r, i) in reviews" :key="i" class="space-y-1.5 rounded-xl bg-cream p-3">
            <blockquote class="text-sm leading-relaxed">“{{ r.text }}”</blockquote>
            <figcaption class="flex flex-wrap items-center gap-1.5 text-[11px] text-smoke">
              <img v-if="r.author.photoUri" :src="r.author.photoUri" alt="" class="h-4 w-4 rounded-full" referrerpolicy="no-referrer" />
              <span class="text-ember" role="img" :aria-label="t('setup.review.stars', { n: r.rating })">{{ '★'.repeat(Math.round(r.rating)) }}</span>
              <a v-if="r.author.uri" :href="r.author.uri" target="_blank" rel="noopener" class="hover:underline">{{ r.author.name }}</a>
              <span v-else>{{ r.author.name }}</span>
              <span v-if="r.relativeTime">· {{ r.relativeTime }}</span>
              <a v-if="r.googleMapsUri" :href="r.googleMapsUri" target="_blank" rel="noopener" class="ml-auto font-semibold underline">
                {{ t('setup.review.seeOnMaps') }}
              </a>
            </figcaption>
          </figure>
          <p class="text-[11px] text-smoke">{{ t('setup.review.attribution') }}</p>
        </div>

        <!-- What the assistant learns — the owner has the last word -->
        <div class="card setup-rise space-y-2 !bg-none bg-ink text-white" style="animation-delay: 180ms">
          <div class="text-sm font-semibold">✨ {{ t('setup.review.learnTitle') }}</div>
          <p class="text-[11px] text-white/60">{{ t('setup.review.learnHint') }}</p>
          <TransitionGroup name="list" tag="ul" class="relative space-y-1">
            <li v-for="l in learnings" :key="l.id" class="group flex items-start gap-2 rounded-lg px-1 py-1 text-sm leading-relaxed text-white/85">
              <span class="pt-0.5 text-ember" aria-hidden="true">•</span>
              <input
                v-if="editingLearning === l.id"
                :id="`learning-${l.id}`"
                v-model="l.text"
                class="min-w-0 flex-1 rounded-md border border-white/20 bg-white/10 px-2 py-0.5 text-white focus:border-ember focus:outline-none"
                :aria-label="t('common.action.edit')"
                @keydown.enter="saveLearning(l)"
                @blur="saveLearning(l)"
              />
              <button v-else class="min-w-0 flex-1 text-left hover:text-white" :title="t('setup.review.tapToEdit')" @click="editLearning(l)">
                {{ l.text }}
              </button>
              <button
                class="shrink-0 rounded px-1 text-white/40 hover:bg-white/10 hover:text-white"
                :aria-label="t('setup.review.learnRemove')"
                @click="removeLearning(l)"
              >
                ✕
              </button>
            </li>
          </TransitionGroup>
          <form class="flex gap-2 pt-1" @submit.prevent="addLearning">
            <input
              v-model="newLearning"
              class="min-w-0 flex-1 rounded-lg border border-white/20 bg-white/10 px-3 py-1.5 text-sm text-white placeholder:text-white/40 focus:border-ember focus:outline-none"
              :placeholder="t('setup.review.learnAddPlaceholder')"
              :aria-label="t('setup.review.learnAddPlaceholder')"
            />
            <button type="submit" class="shrink-0 rounded-lg bg-white/10 px-3 text-sm font-semibold hover:bg-white/20 disabled:opacity-40" :disabled="!newLearning.trim()" :aria-label="t('setup.review.learnAdd')">
              ＋
            </button>
          </form>
        </div>

        <div class="sticky bottom-3 z-10 space-y-1 rounded-2xl glass p-2 shadow-card">
          <p v-if="listing.toReview" class="px-1 text-center text-[11px] text-smoke">
            {{ t('setup.review.reviewLeft', { n: listing.toReview }, listing.toReview) }}
          </p>
          <div class="flex items-center justify-between gap-2">
            <BaseButton variant="ghost" :disabled="listing.busy === 'commit'" @click="restart">
              {{ isManual ? t('common.action.back') : t('setup.review.notMine') }}
            </BaseButton>
            <BaseButton :disabled="!!listing.busy" @click="confirmImport">
              <BaseSpinner v-if="listing.busy === 'commit'" tone="light" aria-hidden="true" />
              {{ listing.busy === 'commit' ? t('common.action.saving') : selectedCount ? t('setup.review.confirm', { n: selectedCount }, selectedCount) : t('setup.review.confirmNoDishes') }}
            </BaseButton>
          </div>
        </div>
      </section>

      <!-- ── 4. Done ───────────────────────────────────────── -->
      <section v-else-if="phase === 'done' && outcome" key="done" class="flex flex-col items-center gap-4 pt-16 text-center">
        <div class="setup-pop-in flex h-20 w-20 items-center justify-center rounded-full bg-herb text-4xl text-white shadow-card" aria-hidden="true">
          ✓
        </div>
        <h1 class="text-3xl font-bold">{{ t('setup.done.title') }}</h1>
        <p class="max-w-sm text-sm leading-relaxed text-smoke">
          {{ t('setup.done.body', { n: outcome.saved, name: restaurantName }, outcome.saved) }}
        </p>
        <p v-if="outcome.link === 'contested'" class="max-w-sm rounded-xl bg-ember-50 px-3 py-2 text-xs leading-relaxed text-ember-700">
          {{ t('setup.done.contested') }}
        </p>
        <div class="flex gap-2">
          <BaseButton variant="ghost" @click="router.replace('/')">{{ t('setup.done.toPulse') }}</BaseButton>
          <!-- New dishes have prices but no recipes yet: draft them next -->
          <BaseButton v-if="outcome.created" variant="herb" @click="estimateRecipes">
            ✨ {{ t('setup.done.estimate') }}
          </BaseButton>
          <BaseButton v-else variant="herb" @click="router.replace('/menu')">{{ t('setup.done.toMenu') }}</BaseButton>
        </div>
      </section>
    </Transition>
  </div>
</template>
