/**
 * Invoice flow — the core loop: upload a receipt photo on /scan, wait for
 * the background OCR to move it off `processing`, then review + approve it
 * in Triage.
 *
 * The scanner's hidden <input type="file"> is the same path the "add from
 * library" button uses, so this exercises the real upload → compress →
 * POST /invoices → Storage trigger → OCR chain. Only the camera itself is
 * skipped (headless Chromium has none; the page falls back to the library
 * picker on its own).
 */
import { expect, type Locator, type Page, type TestInfo } from '@playwright/test'
import { SAMPLE_RECEIPT } from '../constants'

/** OCR runs in a Storage trigger; a cold functions emulator is slow. */
const OCR_TIMEOUT = 60_000

/**
 * Upload this project's sample receipt and land on Triage.
 *
 * Which sample matters: POST /invoices refuses bytes the restaurant
 * already holds (409 duplicate_image), and both projects share one
 * restaurant — so each gets its own file (see SAMPLE_RECEIPT).
 */
export async function scanReceipt(page: Page, testInfo: TestInfo): Promise<void> {
  const sample = SAMPLE_RECEIPT[testInfo.project.name]
  expect(sample, `a sample receipt is mapped for project "${testInfo.project.name}"`).toBeTruthy()

  await page.goto('/scan')
  await expect(page.getByRole('button', { name: 'Capturar factura' })).toBeVisible()

  // The scanner deliberately never blocks on the upload, so the UI moves
  // on before the server has answered. Wait on the response itself — a
  // rejected upload (quota, duplicate bytes) would otherwise surface much
  // later as "the invoice never appeared in Triage".
  const upload = page.waitForResponse((r) => /\/api\/invoices$/.test(r.url()) && r.request().method() === 'POST')
  await page.locator('input[type="file"][accept="image/*"]').setInputFiles(sample)
  expect((await upload).status(), 'POST /invoices accepted the upload').toBe(201)

  // .last(): the last-capture thumbnail carries the same accessible name
  // as the review pill.
  await page.getByRole('button', { name: /^Revisar \(/ }).last().click()
  await expect(page).toHaveURL(/\/triage/)
}

/**
 * The triage card of a scan that is ready to review.
 *
 * InvoiceCard is a plain <div> while OCR runs and only becomes a link once
 * the pipeline lands — but the approved invoices further down the page are
 * links too, so the "Revisar →" badge is what actually identifies a
 * needs_review card. Waiting for it IS waiting for the pipeline.
 */
export function pendingTriageCard(page: Page): Locator {
  return page.locator('a[href^="/triage/"]').filter({ hasText: 'Revisar' }).first()
}

/** Wait for the newest scan to come back from OCR ready to review. */
export async function waitForOcr(page: Page): Promise<void> {
  const card = pendingTriageCard(page)
  await expect(card, 'a scan finished OCR and is waiting for review').toBeVisible({
    timeout: OCR_TIMEOUT,
  })
  // needs_review renders the item summary ("4 artículos · 82,40 US$ · …").
  // Asserting it keeps an empty extraction from passing as "reviewable".
  await expect(card).toContainText('artículos')
}

/**
 * Open the newest reviewable scan, overwrite the vendor and date with
 * known values, and approve it. Returns the first line item's name — the
 * ingredient approval will create or top up in the pantry.
 *
 * The vendor is set by the caller on purpose: OCR's guess is either
 * random (the offline mock) or whatever the real model reads off the
 * photo, and neither is something a spec can assert on.
 */
export async function approveInvoice(
  page: Page,
  opts: { vendor: string; date?: string },
): Promise<string> {
  await waitForOcr(page)
  await pendingTriageCard(page).click()
  await expect(page.getByRole('button', { name: /^Aprobar factura/ })).toBeVisible()

  const firstItem = await page.getByPlaceholder('Nombre del artículo').first().inputValue()
  expect(firstItem, 'the scan came back with at least one line item').not.toBe('')

  // exact: getByLabel matches aria-label too, and the sidebar's Vendors
  // tab is labelled "Proveedores" — a substring match would hit both.
  await page.getByLabel('Proveedor', { exact: true }).fill(opts.vendor)
  await page.locator('input[type="date"]').fill(opts.date ?? new Date().toISOString().slice(0, 10))

  await clickApprove(page, page.getByRole('button', { name: /^Aprobar factura/ }))
  // Approval sends the invoice to the read-only view and out of `pending`.
  await expect(page.getByRole('button', { name: /^Aprobar factura/ })).toBeHidden()

  return firstItem
}

/** The one-time "confirm your main currency" prompt (CurrencyConfirmSheet). */
export function currencyPrompt(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Confirma tu moneda principal' })
}

/**
 * Click an approve button and, if the restaurant's main currency was never
 * confirmed, answer the prompt that the FIRST approval shows (keeping the
 * inferred currency). Which spec approves first is not fixed, so every
 * approval goes through here. `gone` disappears once the approval went
 * through (default: the button itself). No fixed wait: whichever happens
 * first decides.
 */
export async function clickApprove(page: Page, button: Locator, gone: Locator = button): Promise<void> {
  await button.click()
  const prompt = currencyPrompt(page)
  const outcome = await Promise.race([
    prompt.waitFor({ state: 'visible' }).then(() => 'prompt' as const, () => 'timeout' as const),
    gone.waitFor({ state: 'hidden' }).then(() => 'done' as const, () => 'timeout' as const),
  ])
  if (outcome === 'prompt') await prompt.getByRole('button', { name: /— aprobar$/ }).click()
}

// ── Per-scan helpers ────────────────────────────────────────────────
// The helpers above act on "the first reviewable card", which is right for
// the golden path but ambiguous once a spec holds several scans at once
// (or another spec left one behind). These address ONE scan by the id the
// upload returned.

/**
 * Upload a photo from /scan and return the new invoice's id. `file` must
 * be unique per project — see SCAN_SAMPLES in constants.ts.
 */
export async function uploadScan(page: Page, file: string): Promise<string> {
  await page.goto('/scan')
  await expect(page.getByRole('button', { name: 'Capturar factura' })).toBeVisible()
  const upload = page.waitForResponse((r) => /\/api\/invoices$/.test(r.url()) && r.request().method() === 'POST')
  await page.locator('input[type="file"][accept="image/*"]').setInputFiles(file)
  const res = await upload
  expect(res.status(), 'POST /invoices accepted the upload').toBe(201)
  const { id } = (await res.json()) as { id: string }
  expect(id, 'the upload returned an invoice id').toBeTruthy()
  return id
}

/** The triage card link of one scan (it only becomes a link once OCR lands). */
export function scanCard(page: Page, id: string): Locator {
  return page.locator(`a[href="/triage/${id}"]`)
}

/** On /triage, wait until this scan has come back from OCR ready to review. */
export async function waitForScan(page: Page, id: string): Promise<void> {
  await page.goto('/triage')
  const card = scanCard(page, id)
  await expect(card, `scan ${id} finished OCR and is waiting for review`).toContainText('Revisar', {
    timeout: OCR_TIMEOUT,
  })
  await expect(card).toContainText('artículos')
}

/**
 * Open one scan in Triage, set vendor/date (and the document type), and
 * approve it — as a factura (default) or an albarán.
 */
export async function approveScan(
  page: Page,
  id: string,
  opts: { vendor: string; date?: string; deliveryNote?: boolean },
): Promise<void> {
  await waitForScan(page, id)
  await scanCard(page, id).click()
  await expect(page).toHaveURL(new RegExp(`/triage/${id}$`))
  await fillScanHeader(page, opts)
  if (opts.deliveryNote) {
    await page.getByRole('button', { name: 'Albarán', exact: true }).click()
    await expect(page.getByText('Los albaranes se aprueban solo para conciliación')).toBeVisible()
  }
  await clickApprove(page, page.getByRole('button', { name: /^Aprobar factura/ }))
  await expect(page.getByRole('button', { name: /^Aprobar factura/ })).toBeHidden()
}

/** Overwrite the OCR's vendor and date guesses on the open detail page. */
export async function fillScanHeader(page: Page, opts: { vendor: string; date?: string }): Promise<void> {
  // exact: the sidebar's Vendors tab is labelled "Proveedores".
  await page.getByLabel('Proveedor', { exact: true }).fill(opts.vendor)
  await page.locator('input[type="date"]').fill(opts.date ?? new Date().toISOString().slice(0, 10))
}
