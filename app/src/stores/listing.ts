import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { apiFetch, apiUpload } from '../lib/api'
import { compressReceipt } from '../lib/compress'
import { normalizeName } from '../lib/domain'
import {
  listingCommitResponseSchema,
  listingImportSchema,
  listingMediaSchema,
  listingSearchSchema,
  menuScanResponseSchema,
} from '../lib/schemas'
import type { ListingCandidate, ListingCommitResult, ListingImport, ListingMedia } from '../lib/types'

/**
 * "Find your restaurant" (docs/restaurant-listing.md). The API holds the
 * import job; this store drives it one step at a time (create → website →
 * menu) so the progress on screen is real, and owns the editable review
 * list — the owner's edits survive a re-read that brings new rows.
 *
 * Every async step checks the EPOCH it started in: reset() (leaving the
 * page, "not my restaurant", a location switch) bumps it, so a step still
 * in flight can neither write into a newer import nor start the next step.
 */

export type DishSource = ListingCandidate['source'] | 'photos' | 'manual'

export interface ReviewDish {
  key: string
  name: string
  price: number | null
  section: string | null
  source: DishSource
  altPrice?: number
  match?: ListingCandidate['match']
  selected: boolean
  /** The owner looked at the price (edited it, picked a source, OK'd it). */
  confirmed: boolean
}

export type ListingBusy = false | 'import' | 'website' | 'menu' | 'photo' | 'commit'

/** The dish is already on the menu at a different price. */
export const priceChanged = (d: Pick<ReviewDish, 'match' | 'price'>): boolean =>
  !!d.match && d.price !== null && Math.abs(d.match.price - d.price) > 0.009

const newSession = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`

function toDish(c: ListingCandidate | { name: string; price: number | null; section: string | null }, source: DishSource, key: string): ReviewDish {
  const alt = 'altPrice' in c ? c.altPrice : undefined
  const match = 'match' in c ? c.match : undefined
  // Website prices are trusted unless two sources disagree; prices read
  // from an image (theirs or ours) and missing prices ask for a look.
  const trusted = (source === 'website' || source === 'manual') && alt === undefined && c.price !== null
  return { key, name: c.name, price: c.price, section: c.section, source, altPrice: alt, match, selected: true, confirmed: trusted }
}

export const useListingStore = defineStore('listing', () => {
  const job = ref<ListingImport | null>(null)
  const media = ref<ListingMedia | null>(null)
  // The LINKED place's live listing (Settings card): one Google call per
  // app session, in memory only — never storage (Places terms) — and
  // refetched when the owner asks. Keyed by place so a re-link refetches.
  const linked = ref<{ placeId: string; media: ListingMedia; at: number } | null>(null)
  const linkedBusy = ref(false)
  const linkedError = ref<string | null>(null)
  const dishes = ref<ReviewDish[]>([])
  const busy = ref<ListingBusy>(false)
  /** API error code of the last failed step (the page maps it to copy). */
  const error = ref<string | null>(null)
  /**
   * Set by the setup "done" screen when it hands off to the recipe wizard
   * on the Menu page; cleared when that wizard closes. The first-login
   * tour waits for it so the two overlays never stack. Survives reset().
   */
  const handoff = ref(false)
  let session = newSession()
  let localKey = 0
  let epoch = 0

  const toReview = computed(() => dishes.value.filter((d) => d.selected && !d.confirmed).length)
  const missingPrice = computed(() => dishes.value.filter((d) => d.selected && d.price === null).length)

  function reset(): void {
    epoch += 1
    job.value = null
    media.value = null
    linked.value = null
    linkedError.value = null
    dishes.value = []
    busy.value = false
    error.value = null
    session = newSession()
  }

  async function search(q: string) {
    const res = await apiFetch(`/listing/search?q=${encodeURIComponent(q)}&session=${session}`, undefined, listingSearchSchema)
    if (!res.ok) {
      error.value = res.error
      return null
    }
    return res.data.results
  }

  /** New rows only — rows the owner already touched keep their edits. */
  function addCandidates(cands: ListingCandidate[]): void {
    const have = new Set(dishes.value.map((d) => d.key))
    const fresh = cands.filter((c) => !have.has(c.key)).map((c) => toDish(c, c.source, c.key))
    if (fresh.length) dishes.value = [...dishes.value, ...fresh]
  }

  /** One import step; false when it failed OR the import it belonged to is gone. */
  async function step(path: string, body: unknown, phase: ListingBusy): Promise<boolean> {
    const mine = epoch
    busy.value = phase
    const res = await apiFetch(path, { method: 'POST', body: JSON.stringify(body) }, listingImportSchema)
    if (mine !== epoch) return false
    busy.value = false
    if (!res.ok) {
      error.value = res.error
      return false
    }
    job.value = res.data
    addCandidates(res.data.candidates)
    return true
  }

  /** Run whatever the job still has pending, in order. */
  async function advance(): Promise<void> {
    const j = job.value
    if (!j) return
    if (j.steps.website.state === 'pending' && !(await step(`/listing/imports/${j.id}/website`, {}, 'website'))) return
    if (job.value?.id === j.id && job.value.steps.menu.state === 'pending') await step(`/listing/imports/${j.id}/menu`, {}, 'menu')
  }

  async function start(input: { placeId: string } | { manualName: string }): Promise<boolean> {
    reset()
    const mine = epoch
    busy.value = 'import'
    const body = 'placeId' in input ? { placeId: input.placeId, session } : { manual: { name: input.manualName } }
    const res = await apiFetch('/listing/imports', { method: 'POST', body: JSON.stringify(body) }, listingImportSchema)
    if (mine !== epoch) return false
    busy.value = false
    // The details call ends the autocomplete session (one bill per session).
    session = newSession()
    if (!res.ok) {
      error.value = res.error
      return false
    }
    job.value = res.data
    if ('placeId' in input) void loadMedia(input.placeId)
    await advance()
    return mine === epoch
  }

  /** Photos + reviews, live from the listing — shown, never stored. */
  async function loadMedia(placeId: string): Promise<void> {
    const mine = epoch
    const res = await apiFetch(`/listing/place/${encodeURIComponent(placeId)}/media`, undefined, listingMediaSchema)
    if (res.ok && mine === epoch && job.value?.placeId === placeId) media.value = res.data
  }

  /** The linked place's live listing for Settings; cached for the session unless `force`. */
  async function loadLinked(placeId: string, force = false): Promise<void> {
    if (!force && linked.value?.placeId === placeId) return
    linkedBusy.value = true
    linkedError.value = null
    const res = await apiFetch(`/listing/place/${encodeURIComponent(placeId)}/media`, undefined, listingMediaSchema)
    linkedBusy.value = false
    if (res.ok) linked.value = { placeId, media: res.data, at: Date.now() }
    else linkedError.value = res.error
  }

  /** Re-read with a link the owner pasted. */
  async function readWebsite(url: string): Promise<boolean> {
    if (!job.value) return false
    error.value = null
    const ok = await step(`/listing/imports/${job.value.id}/website`, { url }, 'website')
    if (ok) await advance()
    return ok
  }

  /** The owner snaps their printed menu — the existing menu-scan call. */
  async function addMenuPhoto(file: File): Promise<boolean> {
    const mine = epoch
    busy.value = 'photo'
    error.value = null
    const res = await apiUpload('/menu/scan', await compressReceipt(file), menuScanResponseSchema)
    if (mine !== epoch) return false
    busy.value = false
    if (!res.ok) {
      error.value = res.error
      return false
    }
    const have = new Set(dishes.value.map((d) => normalizeName(d.name)))
    const fresh = res.data.dishes
      .filter((d) => d.name.trim() && !have.has(normalizeName(d.name)))
      .map((d) => toDish(d, 'photos', `photo-${localKey++}`))
    dishes.value = [...dishes.value, ...fresh]
    return true
  }

  function addManualDish(): ReviewDish {
    const d: ReviewDish = { key: `manual-${localKey++}`, name: '', price: null, section: null, source: 'manual', selected: true, confirmed: true }
    dishes.value = [...dishes.value, d]
    return d
  }

  function removeDish(key: string): void {
    dishes.value = dishes.value.filter((d) => d.key !== key)
  }

  async function commit(input: {
    restaurant: {
      name: string
      website: string | null
      cuisines: string[]
      priceLevel: number | null
      address: string | null
      phone: string | null
      hours: string | null
    }
    notes: { text: string; origin: 'suggested' | 'owner' }[]
  }): Promise<(ListingCommitResult & { ok: true }) | { ok: false; error: string }> {
    if (!job.value) return { ok: false, error: 'no_import' }
    const mine = epoch
    const payload = dishes.value
      .filter((d) => d.selected && d.name.trim() && d.price !== null)
      .map((d) => {
        if (d.match) {
          return { name: d.name.trim(), price: d.price!, section: d.section, action: priceChanged(d) ? 'update_price' : 'skip_existing', menuItemId: d.match.menuItemId }
        }
        return { name: d.name.trim(), price: d.price!, section: d.section, action: 'create' }
      })
    busy.value = 'commit'
    const res = await apiFetch(
      `/listing/imports/${job.value.id}/commit`,
      { method: 'POST', body: JSON.stringify({ ...input, dishes: payload }) },
      listingCommitResponseSchema,
    )
    if (mine === epoch) busy.value = false
    if (!res.ok) {
      error.value = res.error
      return { ok: false, error: res.error }
    }
    return { ok: true, ...res.data }
  }

  return {
    job,
    media,
    linked,
    linkedBusy,
    linkedError,
    loadLinked,
    dishes,
    busy,
    error,
    handoff,
    toReview,
    missingPrice,
    reset,
    search,
    start,
    readWebsite,
    addMenuPhoto,
    addManualDish,
    removeDish,
    commit,
  }
})
