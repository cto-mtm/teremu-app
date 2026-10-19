<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import BaseButton from '../components/BaseButton.vue'
import { useAuthStore } from '../stores/auth'
import { parseAmount } from '../lib/csv'
import {
  importRestaurant,
  manualProfile,
  readMenuPhoto,
  readWebsite,
  searchRestaurants,
  type FoundDish,
  type ImportSource,
  type RestaurantCandidate,
  type RestaurantProfile,
} from '../lib/restaurantLookupMock'

/**
 * PROTOTYPE — "find your restaurant" onboarding. Search → import (one
 * source at a time, animated) → review and correct what we found →
 * confirm. All data comes from lib/restaurantLookupMock.ts; nothing is
 * saved yet.
 */
const { t, n, locale } = useI18n()
const auth = useAuthStore()
const router = useRouter()

type Phase = 'search' | 'importing' | 'review' | 'done'
const phase = ref<Phase>('search')

// ── Search ──────────────────────────────────────────────────────
const query = ref('')
const searching = ref(false)
const results = ref<RestaurantCandidate[]>([])
let searchSeq = 0
let debounce: ReturnType<typeof setTimeout> | undefined

watch(query, (q) => {
  clearTimeout(debounce)
  if (q.trim().length < 2) {
    results.value = []
    searching.value = false
    return
  }
  searching.value = true
  debounce = setTimeout(async () => {
    const seq = ++searchSeq
    const found = await searchRestaurants(q)
    if (seq !== searchSeq) return // a newer keystroke won
    results.value = found
    searching.value = false
  }, 200)
})

// ── Import ──────────────────────────────────────────────────────
const SOURCES: ImportSource[] = ['profile', 'photos', 'website', 'menu', 'reviews']
const ICONS: Record<ImportSource, string> = { profile: '📍', photos: '📸', website: '🌐', menu: '📖', reviews: '💬' }
const chosen = ref<RestaurantCandidate | null>(null)
const counts = ref<Partial<Record<ImportSource, number>>>({})
const profile = ref<RestaurantProfile | null>(null)

const doneCount = computed(() => Object.keys(counts.value).length)
const activeSource = computed(() => SOURCES[doneCount.value])
const progress = computed(() => doneCount.value / SOURCES.length)

async function choose(c: RestaurantCandidate): Promise<void> {
  chosen.value = c
  counts.value = {}
  phase.value = 'importing'
  const run = importRestaurant(c.placeId)
  for (;;) {
    const step = await run.next()
    if (step.done) {
      enterReview(step.value)
      return
    }
    counts.value = { ...counts.value, [step.value.source]: step.value.count }
  }
}

/** Not on Google → start from a bare profile with just the typed name. */
function addManually(): void {
  enterReview(manualProfile(query.value))
}

function enterReview(p: RestaurantProfile): void {
  profile.value = p
  dishes.value = p.dishes.map(toDish)
  editingId.value = null
  websiteUrl.value = ''
  websiteError.value = false
  learnings.value = initialLearnings(p)
  phase.value = 'review'
}

function restart(): void {
  phase.value = 'search'
  profile.value = null
  chosen.value = null
}

/**
 * Leave setup. The import is still mocked (Phase 0 of
 * docs/restaurant-listing.md) and saves nothing, so finishing counts as a
 * skip too — "done" is only ever set by the real commit (Phase 1).
 * Skipping first is what stops the router sending the owner straight back.
 */
const leaving = ref(false)
async function leave(to: string): Promise<void> {
  leaving.value = true
  const ok = !auth.listingSetupPending || (await auth.skipListingSetup())
  leaving.value = false
  if (ok) await router.replace(to)
  else alert(t('common.action.saveFailed'))
}

// ── Review: dishes ──────────────────────────────────────────────
interface Dish extends Omit<FoundDish, 'source'> {
  id: number
  source: FoundDish['source'] | 'manual'
  selected: boolean
  /** The owner looked at this price (edited it, picked a source, or OK'd it). */
  confirmed: boolean
}
let nextId = 0
const toDish = (d: FoundDish): Dish => ({
  ...d,
  id: nextId++,
  selected: true,
  // Website prices without a conflicting source are trusted; photo
  // prices (often an old menu) and conflicts ask for a look.
  confirmed: d.source === 'website' && d.altPrice === undefined,
})
const dishes = ref<Dish[]>([])

const selectedCount = computed(() => dishes.value.filter((d) => d.selected).length)
const toReview = computed(() => dishes.value.filter((d) => d.selected && !d.confirmed).length)

/** Dishes grouped by menu section, keeping menu order; owner-added last. */
const sections = computed(() => {
  const out = new Map<string | null, Dish[]>()
  for (const d of dishes.value) out.set(d.section, [...(out.get(d.section) ?? []), d])
  return [...out.entries()].sort(([a], [b]) => Number(a === null) - Number(b === null))
})

function toggleSection(list: Dish[]): void {
  const all = list.every((d) => d.selected)
  for (const d of list) d.selected = !all
}

// Inline edit — one row at a time.
const editingId = ref<number | null>(null)
const draftName = ref('')
const draftPrice = ref('')
const draftInvalid = ref(false)

const plainPrice = (x: number) => n(x, { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false })

async function startEdit(d: Dish, field: 'name' | 'price'): Promise<void> {
  if (editingId.value !== null && editingId.value !== d.id && !saveEdit()) return
  editingId.value = d.id
  draftName.value = d.name
  draftPrice.value = d.price ? plainPrice(d.price) : ''
  draftInvalid.value = false
  await nextTick()
  const el = document.getElementById(`dish-${field}-${d.id}`) as HTMLInputElement | null
  el?.focus()
  el?.select()
}

/** Returns false (and keeps the row open) when the draft isn't valid. */
function saveEdit(): boolean {
  const d = dishes.value.find((x) => x.id === editingId.value)
  if (!d) return true
  const price = parseAmount(draftPrice.value, locale.value === 'es' ? ',' : '.')
  if (!draftName.value.trim() || !(price > 0)) {
    draftInvalid.value = true
    return false
  }
  d.name = draftName.value.trim()
  d.price = Math.round(price * 100) / 100
  d.confirmed = true
  d.selected = true
  editingId.value = null
  return true
}

function cancelEdit(): void {
  const d = dishes.value.find((x) => x.id === editingId.value)
  // A brand-new row abandoned before it had a name just goes away.
  if (d && d.source === 'manual' && !d.name) dishes.value = dishes.value.filter((x) => x !== d)
  editingId.value = null
}

function pickPrice(d: Dish, price: number): void {
  d.price = price
  d.confirmed = true
}

function addDish(): void {
  const d: Dish = { id: nextId++, name: '', price: 0, section: null, source: 'manual', emoji: '🍽️', selected: true, confirmed: true }
  dishes.value = [...dishes.value, d]
  void startEdit(d, 'name')
}

// Fallbacks: menu photo, website link.
const photoInput = ref<HTMLInputElement | null>(null)
const readingPhoto = ref(false)
async function onPhoto(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  if (!input.files?.length) return
  readingPhoto.value = true
  const found = await readMenuPhoto()
  dishes.value = [...dishes.value, ...found.map(toDish)]
  readingPhoto.value = false
  input.value = ''
}

const websiteUrl = ref('')
const readingWebsite = ref(false)
const websiteError = ref(false)
async function onWebsite(): Promise<void> {
  if (!profile.value || !websiteUrl.value.trim()) return
  readingWebsite.value = true
  websiteError.value = false
  const found = await readWebsite(profile.value, websiteUrl.value)
  readingWebsite.value = false
  if (!found.length) {
    websiteError.value = true
    return
  }
  profile.value.website = websiteUrl.value.trim().replace(/^https?:\/\//, '')
  dishes.value = [...dishes.value, ...found.map(toDish)]
}

// ── Review: other bits ──────────────────────────────────────────
/** Dishes customers mention, most mentioned first. */
const loved = computed(() => {
  const tally = new Map<string, number>()
  for (const r of profile.value?.reviews ?? []) for (const m of r.mentions) tally.set(m, (tally.get(m) ?? 0) + 1)
  return [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name)
})

const money = (x: number) => n(x, { key: 'currency', currency: profile.value?.currency ?? 'EUR' })

const isManual = computed(() => profile.value?.placeId === 'manual')

// ── Review: what the assistant learns (editable) ────────────────
interface Learning {
  id: number
  text: string
}
const learnings = ref<Learning[]>([])
const editingLearning = ref<number | null>(null)
const newLearning = ref('')

/** The real one is an LLM summary; here it's templated from the profile. */
function initialLearnings(p: RestaurantProfile): Learning[] {
  const avg = p.dishes.length ? p.dishes.reduce((s, d) => s + d.price, 0) / p.dishes.length : 0
  const star = loved.value[0]
  return [
    p.cuisines.length
      ? t('setup.review.learn.identity', {
          cuisine: p.cuisines.map((c) => t('setup.cuisine.' + c)).join(' · '),
          city: p.city,
          price: t('setup.priceLevel.' + p.priceLevel),
        })
      : null,
    avg ? t('setup.review.learn.ticket', { avg: money(avg) }) : null,
    star ? t('setup.review.learn.star', { dish: star }) : null,
    p.placeId !== 'manual' ? t('setup.review.learn.peak', { day: t('setup.days.' + p.peak.day), time: p.peak.time }) : null,
  ]
    .filter((x): x is string => !!x)
    .map((text) => ({ id: nextId++, text }))
}

async function editLearning(l: Learning): Promise<void> {
  editingLearning.value = l.id
  await nextTick()
  ;(document.getElementById(`learning-${l.id}`) as HTMLInputElement | null)?.focus()
}

function saveLearning(l: Learning): void {
  l.text = l.text.trim()
  if (!l.text) removeLearning(l)
  editingLearning.value = null
}

function removeLearning(l: Learning): void {
  learnings.value = learnings.value.filter((x) => x !== l)
}

function addLearning(): void {
  const text = newLearning.value.trim()
  if (!text) return
  learnings.value = [...learnings.value, { id: nextId++, text }]
  newLearning.value = ''
}

function confirmImport(): void {
  if (editingId.value !== null && !saveEdit()) return
  phase.value = 'done'
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
          <div class="setup-float mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-ember-50 text-3xl" aria-hidden="true">
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
          <span
            v-if="searching"
            class="absolute top-1/2 right-4 h-5 w-5 -translate-y-1/2 animate-spin rounded-full border-2 border-ember-100 border-t-ember"
            aria-hidden="true"
          />
        </div>

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
                <span class="block truncate text-xs text-smoke">{{ r.address }}, {{ r.city }}</span>
              </span>
              <span class="shrink-0 text-right text-xs">
                <span class="font-semibold">★ {{ n(r.rating, { maximumFractionDigits: 1, minimumFractionDigits: 1 }) }}</span>
                <span class="block text-smoke">{{ t('setup.search.reviews', { n: n(r.reviewCount) }) }}</span>
              </span>
            </button>
          </li>
        </TransitionGroup>

        <div v-if="!searching && query.trim().length >= 2" class="space-y-2 text-center">
          <p v-if="!results.length" class="text-sm text-smoke">{{ t('setup.search.noResults') }}</p>
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
            <p class="text-xs text-smoke">{{ chosen.address }}, {{ chosen.city }}</p>
          </div>
          <p class="text-sm text-smoke" aria-live="polite">
            {{ activeSource ? t('setup.importing.' + activeSource + '.active') : t('setup.importing.finishing') }}
          </p>
        </div>

        <div class="h-1.5 overflow-hidden rounded-full bg-ember-50">
          <div class="setup-bar h-full origin-left rounded-full bg-ember" :style="{ transform: `scaleX(${progress})` }" />
        </div>

        <ul class="card space-y-1 !p-2">
          <li
            v-for="s in SOURCES"
            :key="s"
            class="flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors"
            :class="s === activeSource ? 'bg-ember-50' : ''"
          >
            <span class="text-xl" aria-hidden="true">{{ ICONS[s] }}</span>
            <span class="flex-1 text-sm" :class="counts[s] === undefined && s !== activeSource ? 'text-smoke' : 'font-medium'">
              {{ t('setup.importing.' + s + '.label') }}
            </span>
            <Transition name="setup-pop" mode="out-in" type="transition">
              <span v-if="counts[s] === 0" key="none" class="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-smoke">
                {{ t('setup.importing.notFound') }}
              </span>
              <span v-else-if="counts[s] !== undefined" key="done" class="chip-down">
                ✓ {{ t('setup.importing.' + s + '.found', { n: counts[s] }, counts[s] ?? 0) }}
              </span>
              <span
                v-else-if="s === activeSource"
                key="busy"
                class="h-4 w-4 animate-spin rounded-full border-2 border-ember-100 border-t-ember"
                aria-hidden="true"
              />
              <span v-else key="wait" class="h-1.5 w-1.5 rounded-full bg-gray-200" aria-hidden="true" />
            </Transition>
          </li>
        </ul>
      </section>

      <!-- ── 3. Review ─────────────────────────────────────── -->
      <section v-else-if="phase === 'review' && profile" key="review" class="space-y-4 pt-2">
        <!-- Hero: photo mosaic + identity -->
        <div class="card setup-rise overflow-hidden !p-0">
          <!-- Five photos → mosaic; fewer → one row, the first one wider -->
          <div
            v-if="profile.photos.length"
            class="grid h-40 gap-0.5 sm:h-48"
            :class="profile.photos.length >= 5 ? 'grid-cols-4 grid-rows-2' : ''"
            :style="profile.photos.length < 5 ? { gridTemplateColumns: `2fr repeat(${profile.photos.length - 1}, 1fr)` } : undefined"
          >
            <div
              v-for="(ph, i) in profile.photos.slice(0, 5)"
              :key="i"
              class="flex items-center justify-center text-4xl"
              :class="i === 0 ? (profile.photos.length >= 5 ? 'col-span-2 row-span-2 text-6xl' : 'text-6xl') : ''"
              :style="{ background: `linear-gradient(140deg, hsl(${ph.hue} 85% 82%), hsl(${ph.hue + 25} 75% 66%))` }"
              aria-hidden="true"
            >
              {{ ph.emoji }}
            </div>
          </div>
          <div v-else class="flex h-28 items-center justify-center bg-gradient-to-br from-ember-100 to-ember-200" aria-hidden="true">
            <span class="flex h-16 w-16 items-center justify-center rounded-full bg-ember text-xl font-bold text-white shadow-card">
              {{ initials(profile.name) }}
            </span>
          </div>
          <div class="space-y-3 p-4">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <h1 class="truncate text-2xl font-bold">{{ profile.name }}</h1>
                <div v-if="profile.reviewCount" class="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-smoke">
                  <span class="font-semibold text-ink">★ {{ n(profile.rating, { maximumFractionDigits: 1, minimumFractionDigits: 1 }) }}</span>
                  <span>{{ t('setup.search.reviews', { n: n(profile.reviewCount) }) }}</span>
                  <span aria-hidden="true">·</span>
                  <span>{{ t('setup.priceLevel.' + profile.priceLevel) }}</span>
                </div>
                <p v-else class="mt-1 text-xs text-smoke">{{ t('setup.review.manualHint') }}</p>
              </div>
              <span v-if="!isManual" :class="profile.openNow ? 'chip-down' : 'chip-up'" class="shrink-0">
                {{ profile.openNow ? t('setup.review.openNow') : t('setup.review.closedNow') }}
              </span>
            </div>
            <div v-if="profile.cuisines.length" class="flex flex-wrap gap-1.5">
              <span v-for="c in profile.cuisines" :key="c" class="rounded-full bg-ember-50 px-2.5 py-0.5 text-xs font-semibold text-ember-700">
                {{ t('setup.cuisine.' + c) }}
              </span>
            </div>
            <dl v-if="!isManual" class="grid gap-2 text-xs sm:grid-cols-2">
              <div class="flex gap-2"><dt aria-hidden="true">📍</dt><dd>{{ profile.address }}, {{ profile.city }}</dd></div>
              <div class="flex gap-2"><dt aria-hidden="true">🕒</dt><dd>{{ t('setup.review.today') }} {{ profile.hoursToday }}</dd></div>
              <div class="flex gap-2">
                <dt aria-hidden="true">🌐</dt>
                <dd :class="profile.website ? '' : 'text-smoke'">{{ profile.website ?? t('setup.review.noWebsite') }}</dd>
              </div>
              <div class="flex gap-2"><dt aria-hidden="true">📞</dt><dd>{{ profile.phone }}</dd></div>
            </dl>
          </div>
        </div>

        <!-- Menu -->
        <div class="card setup-rise space-y-3" style="animation-delay: 60ms">
          <template v-if="dishes.length">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div class="text-sm font-semibold">{{ t('setup.review.menuTitle', { n: dishes.length }, dishes.length) }}</div>
              <span v-if="toReview" class="chip-up">{{ t('setup.review.toReview', { n: toReview }) }}</span>
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
                  :key="d.id"
                  class="rounded-xl transition-colors"
                  :class="editingId === d.id ? 'bg-ember-50 ring-1 ring-ember-200' : d.selected && !d.confirmed ? 'bg-coral-50/50' : ''"
                >
                  <!-- Editing -->
                  <form v-if="editingId === d.id" class="flex flex-wrap items-center gap-2 p-2" @submit.prevent="saveEdit" @keydown.esc="cancelEdit">
                    <span class="text-lg" aria-hidden="true">{{ d.emoji }}</span>
                    <input
                      :id="`dish-name-${d.id}`"
                      v-model="draftName"
                      class="input min-w-0 flex-1 !py-1.5"
                      :class="draftInvalid && !draftName.trim() ? '!border-coral' : ''"
                      :placeholder="t('setup.review.namePlaceholder')"
                      :aria-label="t('setup.review.namePlaceholder')"
                    />
                    <input
                      :id="`dish-price-${d.id}`"
                      v-model="draftPrice"
                      inputmode="decimal"
                      class="input !w-24 !py-1.5 text-right tabular-nums"
                      :class="draftInvalid && !(parseAmount(draftPrice, locale === 'es' ? ',' : '.') > 0) ? '!border-coral' : ''"
                      :placeholder="plainPrice(0)"
                      :aria-label="t('setup.review.pricePlaceholder')"
                    />
                    <button type="submit" class="btn-primary !px-3 !py-1.5" :aria-label="t('setup.review.save')">✓</button>
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
                      <span class="text-lg" aria-hidden="true">{{ d.emoji }}</span>
                      <button class="min-w-0 flex-1 text-left" :title="t('setup.review.tapToEdit')" @click="startEdit(d, 'name')">
                        <span class="block truncate text-sm" :class="d.selected ? '' : 'text-smoke line-through'">{{ d.name }}</span>
                        <span class="text-[11px] text-smoke">
                          {{ t('setup.review.source.' + d.source) }}
                          <span v-if="loved.includes(d.name)" class="font-semibold text-coral-600"> · ♥ {{ t('setup.review.loved') }}</span>
                        </span>
                      </button>
                      <button
                        class="group flex items-center gap-1 rounded-lg px-1.5 py-1 text-sm font-semibold tabular-nums transition hover:bg-white"
                        :class="d.selected && !d.confirmed ? 'text-coral-600' : ''"
                        :aria-label="t('setup.review.editPrice', { dish: d.name })"
                        @click="startEdit(d, 'price')"
                      >
                        {{ money(d.price) }}
                        <svg viewBox="0 0 24 24" class="h-3.5 w-3.5 text-smoke opacity-50 group-hover:opacity-100" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                          <path d="M4 20h4L19 9l-4-4L4 16v4Z" />
                        </svg>
                      </button>
                    </div>

                    <!-- Two sources disagree → pick one -->
                    <div v-if="d.selected && !d.confirmed && d.altPrice !== undefined" class="flex flex-wrap items-center gap-1.5 px-2 pb-2 pl-10 text-[11px]">
                      <span class="text-smoke">{{ t('setup.review.conflict') }}</span>
                      <button class="rounded-full border border-gray-200 bg-white px-2 py-0.5 font-semibold hover:border-ember" @click="pickPrice(d, d.price)">
                        {{ t('setup.review.source.website') }}: {{ money(d.price) }}
                      </button>
                      <button class="rounded-full border border-gray-200 bg-white px-2 py-0.5 font-semibold hover:border-ember" @click="pickPrice(d, d.altPrice)">
                        {{ t('setup.review.source.photos') }}: {{ money(d.altPrice) }}
                      </button>
                    </div>
                    <!-- Price from a photo → confirm or fix -->
                    <div v-else-if="d.selected && !d.confirmed" class="flex flex-wrap items-center gap-1.5 px-2 pb-2 pl-10 text-[11px]">
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
            <p class="mx-auto max-w-sm text-xs text-smoke">{{ t('setup.review.emptyBody') }}</p>
          </div>

          <!-- No website on file → paste one -->
          <form v-if="!profile.website" class="space-y-1.5 rounded-xl bg-cream p-3" @submit.prevent="onWebsite">
            <label for="setup-website" class="text-xs font-semibold">🌐 {{ t('setup.review.websiteAsk') }}</label>
            <div class="flex gap-2">
              <input id="setup-website" v-model="websiteUrl" type="text" inputmode="url" autocomplete="url" autocapitalize="off" class="input !py-1.5" :placeholder="t('setup.review.websitePlaceholder')" :disabled="readingWebsite" />
              <button type="submit" class="btn-primary shrink-0 !py-1.5" :disabled="readingWebsite || !websiteUrl.trim()">
                <span v-if="readingWebsite" class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden="true" />
                {{ readingWebsite ? t('setup.review.websiteReading') : t('setup.review.websiteRead') }}
              </button>
            </div>
            <p v-if="websiteError" class="text-[11px] text-coral-600">{{ t('setup.review.websiteNoMenu') }}</p>
          </form>

          <!-- Add more -->
          <div class="flex flex-wrap gap-2 border-t border-gray-100 pt-3">
            <button class="btn-ghost" :disabled="editingId !== null" @click="addDish">＋ {{ t('setup.review.addDish') }}</button>
            <button class="btn-ghost" :disabled="readingPhoto" @click="photoInput?.click()">
              <span v-if="readingPhoto" class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-gray-300 border-t-ink" aria-hidden="true" />
              <span v-else aria-hidden="true">📷</span>
              {{ readingPhoto ? t('setup.review.photoReading') : t('setup.review.scanPhoto') }}
            </button>
            <input ref="photoInput" type="file" accept="image/*" capture="environment" class="hidden" @change="onPhoto" />
          </div>
        </div>

        <!-- Customers say -->
        <div v-if="profile.reviews.length" class="card setup-rise space-y-3" style="animation-delay: 120ms">
          <div class="text-sm font-semibold">{{ t('setup.review.reviewsTitle') }}</div>
          <figure v-for="r in profile.reviews" :key="r.author" class="space-y-1.5 rounded-xl bg-cream p-3">
            <blockquote class="text-sm leading-relaxed">“{{ r.text }}”</blockquote>
            <figcaption class="flex flex-wrap items-center gap-1.5 text-[11px] text-smoke">
              <span class="text-ember" :aria-label="t('setup.review.stars', { n: r.rating })">{{ '★'.repeat(r.rating) }}</span>
              <span>{{ r.author }}</span>
              <span v-for="m in r.mentions" :key="m" class="rounded-full bg-white px-2 py-0.5 font-semibold text-ink">{{ m }}</span>
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
                :aria-label="t('setup.review.learnEdit')"
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
            <button type="submit" class="shrink-0 rounded-lg bg-white/10 px-3 text-sm font-semibold hover:bg-white/20 disabled:opacity-40" :disabled="!newLearning.trim()">
              ＋
            </button>
          </form>
        </div>

        <div class="sticky bottom-3 z-10 space-y-1 rounded-2xl glass p-2 shadow-card">
          <p v-if="toReview" class="px-1 text-center text-[11px] text-smoke">{{ t('setup.review.reviewLeft', { n: toReview }, toReview) }}</p>
          <div class="flex items-center justify-between gap-2">
            <BaseButton variant="ghost" @click="restart">{{ isManual ? t('setup.review.back') : t('setup.review.notMine') }}</BaseButton>
            <BaseButton :disabled="!selectedCount" @click="confirmImport">
              {{ t('setup.review.confirm', { n: selectedCount }, selectedCount) }}
            </BaseButton>
          </div>
        </div>
      </section>

      <!-- ── 4. Done ───────────────────────────────────────── -->
      <section v-else-if="phase === 'done' && profile" key="done" class="flex flex-col items-center gap-4 pt-16 text-center">
        <div class="setup-pop-in flex h-20 w-20 items-center justify-center rounded-full bg-herb text-4xl text-white shadow-card" aria-hidden="true">
          ✓
        </div>
        <h1 class="text-3xl font-bold">{{ t('setup.done.title') }}</h1>
        <p class="max-w-sm text-sm leading-relaxed text-smoke">
          {{ t('setup.done.body', { n: selectedCount, name: profile.name }, selectedCount) }}
        </p>
        <div class="flex gap-2">
          <BaseButton variant="ghost" @click="restart">{{ t('setup.done.again') }}</BaseButton>
          <BaseButton variant="herb" :disabled="leaving" @click="leave('/menu')">{{ t('setup.done.toMenu') }}</BaseButton>
        </div>
        <p class="text-[11px] text-smoke">{{ t('setup.done.prototype') }}</p>
      </section>
    </Transition>
  </div>
</template>
