/**
 * The UI over one real client month (opt-in, `npm run test:e2e:real`).
 *
 * real.setup.ts seeded the recorded month into this owner's restaurant;
 * every expectation below is derived from that seed's summary (the same
 * recorded model replies, through the pipeline's own decision function) —
 * never from a hand-typed value, so the specs stay deterministic as the
 * corpus or the model recordings change.
 *
 * Representative documents are picked by rule from the summary (first by
 * file name), not by name — the corpus is client data and never appears
 * in committed code.
 */
import { test, expect } from '../fixtures'
import { readSeeded, REAL_CORPUS_PRESENT, type SeededDoc } from './real'

test.skip(!REAL_CORPUS_PRESENT, 'real corpus not on this machine (docs/real-samples.md)')

/** Same formatter the app uses (i18n numberFormats.currency). Whitespace is
 *  normalized on both sides — Node and Chromium disagree on NBSP vs NNBSP. */
const money = (x: number) => new Intl.NumberFormat('es', { style: 'currency', currency: 'USD' }).format(x)
const squash = (s: string) => s.replace(/\s+/g, ' ').trim()

const FAILED_TEXT: Record<string, string> = {
  unreadable: 'La IA no pudo leer este recibo',
  not_a_document: 'Esto no parece una factura ni un recibo',
  processing: 'Error de procesamiento',
}

const byFile = (a: SeededDoc, b: SeededDoc) => a.file.localeCompare(b.file)
const vendorKey = (v: string | null) => (v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')

/** The one invoice the spec approves — picked by rule, shared by two tests. */
const reviewableInvoice = (docs: SeededDoc[]) =>
  docs.filter((d) => d.status === 'needs_review' && d.vendorName && d.docType === 'invoice').sort(byFile)[0]

test.describe.configure({ mode: 'serial' })

test.describe('A real month in the UI', () => {
  let docs: SeededDoc[]
  test.beforeAll(() => {
    docs = readSeeded().docs
  })

  test('Triage lists every seeded document with its outcome', async ({ page }) => {
    const review = docs.filter((d) => d.status === 'needs_review')
    const failed = docs.filter((d) => d.status === 'failed')
    await page.goto('/triage')
    // First visit of the run: a cold Vite compile of the route + ~250 cards.
    await expect(page.getByRole('heading', { name: 'Bandeja de triaje' })).toBeVisible({ timeout: 45_000 })

    const cards = page.locator('a[href^="/triage/"]')
    await expect(cards.filter({ hasText: 'Revisar' })).toHaveCount(review.length, { timeout: 30_000 })
    await expect(cards.filter({ hasText: '⚠' })).toHaveCount(failed.length)

    // Each failure reason renders its own message, as many times as it occurs.
    for (const [error, text] of Object.entries(FAILED_TEXT)) {
      const n = failed.filter((d) => d.error === error).length
      await expect(cards.filter({ hasText: text }), `failed cards for ${error}`).toHaveCount(n)
    }
  })

  test('a reviewable document opens with the extracted vendor and total', async ({ page }) => {
    const doc = reviewableInvoice(docs)
    test.skip(!doc, 'no reviewable invoice in the recordings')
    await page.goto(`/triage/${doc.invoiceId}`)

    await expect(page.getByLabel('Proveedor', { exact: true })).toHaveValue(doc.vendorName!)
    if (doc.invoiceDate) await expect(page.locator('input[type="date"]')).toHaveValue(doc.invoiceDate)
    await expect(page.getByPlaceholder('Nombre del artículo')).toHaveCount(doc.lines)

    const approve = page.getByRole('button', { name: /^Aprobar factura/ })
    expect(squash((await approve.textContent()) ?? '')).toBe(squash(`Aprobar factura · ${money(doc.lineSum)}`))

    await approve.click()
    await expect(page).toHaveURL(/\/triage$/)
    await expect(
      page.getByText('Aprobadas recientemente'),
      'the approved document leaves the inbox for the approved list',
    ).toBeVisible()
    await expect(page.locator(`a[href="/triage/${doc.invoiceId}"]`)).not.toContainText('Revisar')
  })

  test('a failed document explains why and offers a retry', async ({ page }) => {
    const doc = docs.filter((d) => d.status === 'failed').sort(byFile)[0]
    test.skip(!doc, 'no failed document in the recordings')
    await page.goto(`/triage/${doc.invoiceId}`)
    await expect(page.getByText(FAILED_TEXT[doc.error ?? 'processing'] ?? FAILED_TEXT.processing)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Reintentar' })).toBeVisible()
  })

  test('a multi-page document pages through every page image', async ({ page }) => {
    const doc = docs.filter((d) => d.pages > 1).sort(byFile)[0]
    test.skip(!doc, 'no multi-page document in the corpus')
    await page.goto(`/triage/${doc.invoiceId}`)

    const image = page.getByRole('img', { name: 'Recibo escaneado' })
    for (let n = 1; n <= doc.pages; n += 1) {
      await expect(page.getByText(`Página ${n} de ${doc.pages}`)).toBeVisible()
      // The page actually decoded — not a broken-image icon.
      await expect.poll(() => image.evaluate((img) => {
        const el = img as unknown as { complete: boolean; naturalWidth: number }
        return el.complete ? el.naturalWidth : 0
      })).toBeGreaterThan(0)
      if (n < doc.pages) await page.getByRole('button', { name: 'Página siguiente' }).click()
    }
    await expect(page.getByRole('button', { name: 'Página siguiente' })).toBeDisabled()
  })

  test('an approved, unbilled delivery note shows up as received-but-unbilled spend', async ({ page }) => {
    // The only other approval in this run is reviewableInvoice(); a note
    // from a different vendor therefore has no factura to match yet.
    const approvedVendor = vendorKey(reviewableInvoice(docs)?.vendorName ?? null)
    const note = docs
      .filter((d) => d.status === 'needs_review' && d.docType === 'delivery_note' && d.vendorName && d.lineSum > 0)
      .filter((d) => vendorKey(d.vendorName) !== approvedVendor)
      .sort(byFile)[0]
    test.skip(!note, 'no reviewable delivery note in the recordings')
    await page.goto(`/triage/${note.invoiceId}`)
    await expect(page.getByText('Los albaranes se aprueban solo para conciliación')).toBeVisible()
    await page.getByRole('button', { name: /^Aprobar factura/ }).click()
    await expect(page).toHaveURL(/\/triage$/)

    await page.goto('/')
    const toggle = page.getByRole('group', { name: 'Vista de gasto' })
    await expect(toggle).toBeVisible()
    await expect(page.getByText('Recibido sin facturar')).toBeVisible()
    await toggle.getByRole('button', { name: 'Tiempo real' }).click()
    await expect(toggle.getByRole('button', { name: 'Tiempo real' })).toHaveAttribute('aria-pressed', 'true')
  })
})
