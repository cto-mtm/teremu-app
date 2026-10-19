import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { apiFetch, apiUpload } from '../lib/api'
import { compressReceipt } from '../lib/compress'
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

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()

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
  const dishes = ref<ReviewDish[]>([])
  const busy = ref<ListingBusy>(false)
  /** API error code of the last failed step (the page maps it to copy). */
  const error = ref<string | null>(null)
  let session = newSession()
  let localKey = 0

  const toReview = computed(() => dishes.value.filter((d) => d.selected && !d.confirmed).length)
  const missingPrice = computed(() => dishes.value.filter((d) => d.selected && d.price === null).length)

  function reset(): void {
    job.value = null
    media.value = null
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

  async function step(path: string, body: unknown, phase: ListingBusy): Promise<boolean> {
    busy.value = phase
    const res = await apiFetch(path, { method: 'POST', body: JSON.stringify(body) }, listingImportSchema)
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
    if (job.value?.steps.menu.state === 'pending') await step(`/listing/imports/${job.value.id}/menu`, {}, 'menu')
  }

  async function start(input: { placeId: string } | { manualName: string }): Promise<boolean> {
    reset()
    busy.value = 'import'
    const body = 'placeId' in input ? { placeId: input.placeId, session } : { manual: { name: input.manualName } }
    const res = await apiFetch('/listing/imports', { method: 'POST', body: JSON.stringify(body) }, listingImportSchema)
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
    return true
  }

  /** Photos + reviews, live from the listing — shown, never stored. */
  async function loadMedia(placeId: string): Promise<void> {
    const res = await apiFetch(`/listing/place/${encodeURIComponent(placeId)}/media`, undefined, listingMediaSchema)
    if (res.ok && job.value?.placeId === placeId) media.value = res.data
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
    busy.value = 'photo'
    error.value = null
    try {
      const res = await apiUpload('/menu/scan', await compressReceipt(file), menuScanResponseSchema)
      if (!res.ok) {
        error.value = res.error
        return false
      }
      const have = new Set(dishes.value.map((d) => fold(d.name)))
      const fresh = res.data.dishes
        .filter((d) => d.name.trim() && !have.has(fold(d.name)))
        .map((d) => toDish(d, 'photos', `photo-${localKey++}`))
      dishes.value = [...dishes.value, ...fresh]
      return true
    } finally {
      busy.value = false
    }
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
    restaurant: { name: string; website: string | null; cuisines: string[]; priceLevel: number | null }
    notes: { text: string; origin: 'suggested' | 'owner' }[]
  }): Promise<(ListingCommitResult & { ok: true }) | { ok: false; error: string; locationName?: string }> {
    if (!job.value) return { ok: false, error: 'no_import' }
    const payload = dishes.value
      .filter((d) => d.selected && d.name.trim() && d.price !== null)
      .map((d) => {
        if (d.match) {
          const changed = Math.abs(d.match.price - (d.price ?? 0)) > 0.009
          return { name: d.name.trim(), price: d.price!, section: d.section, action: changed ? 'update_price' : 'skip_existing', menuItemId: d.match.menuItemId }
        }
        return { name: d.name.trim(), price: d.price!, section: d.section, action: 'create' }
      })
    busy.value = 'commit'
    const res = await apiFetch(
      `/listing/imports/${job.value.id}/commit`,
      { method: 'POST', body: JSON.stringify({ ...input, dishes: payload }) },
      listingCommitResponseSchema,
    )
    busy.value = false
    if (!res.ok) {
      error.value = res.error
      return { ok: false, error: res.error }
    }
    return { ok: true, ...res.data }
  }

  return {
    job,
    media,
    dishes,
    busy,
    error,
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
