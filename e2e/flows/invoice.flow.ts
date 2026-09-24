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
  await page.locator('input[type="file"]').setInputFiles(sample)
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

  await page.getByRole('button', { name: /^Aprobar factura/ }).click()
  // Approval sends the invoice to the read-only view and out of `pending`.
  await expect(page.getByRole('button', { name: /^Aprobar factura/ })).toBeHidden()

  return firstItem
}
