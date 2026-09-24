import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { apiFetch, apiUpload, writeEpoch } from '../lib/api'
import { compressReceipt } from '../lib/compress'
import { replaceById } from '../lib/collections'
import { invoiceListSchema, invoiceSchema } from '../lib/schemas'
import type { Invoice, LineItem } from '../lib/types'

export const useInvoicesStore = defineStore('invoices', () => {
  const invoices = ref<Invoice[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  const pending = computed(() =>
    invoices.value.filter((i) => ['processing', 'needs_review', 'failed'].includes(i.status)),
  )
  const triageCount = computed(() => pending.value.length)
  const approved = computed(() => invoices.value.filter((i) => i.status === 'approved'))
  const discarded = computed(() => invoices.value.filter((i) => i.status === 'discarded'))
  const byId = computed(() => new Map(invoices.value.map((i) => [i.id, i])))

  // The list is the heaviest payload in the app (every invoice with its
  // lines — ~220 KB for a real month). Callers that fire together (the
  // shell's boot load + a page's mount) share ONE request, and a page can
  // skip a refetch when the data is still fresh.
  let inFlight: Promise<void> | null = null
  let loadedAt = 0
  // Bumped by reset() (location switch): a load that started for the
  // previous location must neither populate the store nor be shared with
  // the new location's refresh.
  let generation = 0

  function refresh(opts: { maxAgeMs?: number } = {}): Promise<void> {
    if (inFlight) return inFlight
    if (opts.maxAgeMs !== undefined && loadedAt && Date.now() - loadedAt < opts.maxAgeMs) {
      return Promise.resolve()
    }
    const gen = generation
    inFlight = (async () => {
      loading.value = true
      // Same lost-update guard as kitchen.refresh: an approve/capture that
      // overlapped this load would be undone by its older snapshot, so load
      // again (bounded) until no write moved underneath it.
      let res: Awaited<ReturnType<typeof apiFetch<Invoice[]>>>
      for (let attempt = 0; ; attempt += 1) {
        const epoch = writeEpoch()
        res = await apiFetch<Invoice[]>('/invoices', undefined, invoiceListSchema)
        if (writeEpoch() === epoch || attempt >= 2) break
      }
      if (gen !== generation) return // location switched mid-load: drop it
      if (res.ok) {
        invoices.value = res.data
        loadedAt = Date.now()
        error.value = null
      } else {
        error.value = res.error
      }
      loading.value = false
    })().finally(() => {
      if (gen === generation) inFlight = null
    })
    return inFlight
  }

  /** Re-read ONE invoice (e.g. a scan still processing) instead of the list. */
  async function refreshOne(id: string): Promise<void> {
    const res = await apiFetch<Invoice>(`/invoices/${id}`, undefined, invoiceSchema)
    if (res.ok) invoices.value = replaceById(invoices.value, id, res.data)
  }

  /**
   * Continuous capture: compress + POST the photo, get the invoice back
   * in `processing` state immediately. OCR happens server-side in the
   * background — the scanner never blocks between shots.
   */
  async function capture(photo: Blob | HTMLCanvasElement): Promise<boolean> {
    try {
      const jpeg = await compressReceipt(photo)
      const res = await apiUpload<Invoice>('/invoices', jpeg, invoiceSchema)
      if (res.ok) invoices.value = [res.data, ...invoices.value]
      else error.value = res.error
      return res.ok
    } catch (err) {
      // compressReceipt can reject (encode failure, corrupt file) — a
      // throw here must NEVER escape, or the scanner's upload counter
      // hangs and the operator gets no feedback.
      error.value = err instanceof Error ? err.message : 'capture failed'
      return false
    }
  }

  // ── Multi-page capture (one invoice, several photos) ────────────
  // The open session: the first page creates the invoice with an
  // X-More-Pages header (server holds OCR), the rest append pages, and
  // finishMultipage() closes it — one OCR pass over every page.
  const multipageId = ref<string | null>(null)
  const multipageCount = ref(0)

  /** Add a page to the open multi-page invoice (opens one if needed). */
  async function capturePage(photo: Blob | HTMLCanvasElement): Promise<boolean> {
    try {
      const jpeg = await compressReceipt(photo)
      if (!multipageId.value) {
        const res = await apiUpload<Invoice>('/invoices', jpeg, invoiceSchema, { 'X-More-Pages': '1' })
        if (res.ok) {
          invoices.value = [res.data, ...invoices.value]
          multipageId.value = res.data.id
          multipageCount.value = 1
        } else {
          error.value = res.error
        }
        return res.ok
      }
      const res = await apiUpload<{ id: string; pages: number }>(
        `/invoices/${multipageId.value}/pages`,
        jpeg,
      )
      if (res.ok) multipageCount.value = res.data.pages
      else error.value = res.error
      return res.ok
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'capture failed'
      return false
    }
  }

  /** Close the open multi-page invoice — the server OCRs all its pages. */
  async function finishMultipage(): Promise<boolean> {
    const id = multipageId.value
    if (!id) return true
    multipageId.value = null
    multipageCount.value = 0
    const res = await apiFetch<Invoice>(`/invoices/${id}/complete`, { method: 'PUT' }, invoiceSchema)
    if (res.ok) invoices.value = replaceById(invoices.value, id, res.data)
    else error.value = res.error
    return res.ok
  }

  async function approve(
    id: string,
    vendorName: string | null,
    invoiceDate: string | null,
    lineItems: LineItem[],
    docType: 'invoice' | 'delivery_note' = 'invoice',
  ): Promise<boolean> {
    const res = await apiFetch<Invoice>(
      `/invoices/${id}/approve`,
      { method: 'PUT', body: JSON.stringify({ vendorName, invoiceDate, lineItems, docType }) },
      invoiceSchema,
    )
    if (res.ok) invoices.value = replaceById(invoices.value, id, res.data)
    else error.value = res.error
    return res.ok
  }

  /** Divert a non-food bill into a tagged expense (archives the invoice). */
  async function approveAsExpense(id: string, tag: string): Promise<boolean> {
    const res = await apiFetch<Invoice>(
      `/invoices/${id}/expense`,
      { method: 'PUT', body: JSON.stringify({ tag }) },
      invoiceSchema,
    )
    if (res.ok) invoices.value = replaceById(invoices.value, id, res.data)
    else error.value = res.error
    return res.ok
  }

  /** Resolve a delivery-note reconciliation row: link and/or mark handled. */
  async function reconcile(
    id: string,
    patch: { invoiceId?: string | null; handled?: boolean },
  ): Promise<boolean> {
    const res = await apiFetch<Invoice>(
      `/invoices/${id}/reconcile`,
      { method: 'PUT', body: JSON.stringify(patch) },
      invoiceSchema,
    )
    if (res.ok) invoices.value = replaceById(invoices.value, id, res.data)
    else error.value = res.error
    return res.ok
  }

  /**
   * Dismiss a scan from Triage — the junk photos and duplicates that
   * would otherwise sit in the inbox forever showing an error. The
   * document is kept (status `discarded`, out of `pending`), so passing
   * `false` puts it back.
   */
  async function discard(id: string, discarded = true): Promise<boolean> {
    const res = await apiFetch<Invoice>(
      `/invoices/${id}/discard`,
      { method: 'PUT', body: JSON.stringify({ discarded }) },
      invoiceSchema,
    )
    if (res.ok) invoices.value = replaceById(invoices.value, id, res.data)
    else error.value = res.error
    return res.ok
  }

  async function reprocess(id: string): Promise<boolean> {
    const res = await apiFetch<Invoice>(`/invoices/${id}/reprocess`, { method: 'POST' }, invoiceSchema)
    if (res.ok) invoices.value = replaceById(invoices.value, id, res.data)
    else error.value = res.error
    return res.ok
  }

  /** Clear location-scoped data — called on switchLocation, see kitchen.ts. */
  function reset(): void {
    generation += 1
    inFlight = null
    loading.value = false
    invoices.value = []
    loadedAt = 0
    error.value = null
    multipageId.value = null
    multipageCount.value = 0
  }

  return {
    invoices,
    loading,
    error,
    pending,
    triageCount,
    approved,
    discarded,
    byId,
    refresh,
    refreshOne,
    reset,
    capture,
    multipageId,
    multipageCount,
    capturePage,
    finishMultipage,
    approve,
    approveAsExpense,
    reconcile,
    discard,
    reprocess,
  }
})
