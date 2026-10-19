/**
 * Delivery-note reconciliation (albarán ↔ factura). An approved albarán
 * never touches the numbers; it waits in Triage until a factura from the
 * same vendor arrives, then pairs with it — the catch for invoices that
 * never came and for overcharges.
 *
 * Whether the pair reads "matched" or "prices differ" depends on what
 * OCR returned for each document (randomized offline mock / real model),
 * so the spec asserts that the note LEFT the unmatched state, not which
 * resolved state it landed in.
 */
import { test, expect } from '../../fixtures'
import type { Page } from '@playwright/test'
import { SCAN_SAMPLES } from '../../constants'
import { unique } from '../../flows/data'
import { approveScan, uploadScan } from '../../flows/invoice.flow'

/** The note's row inside the reconciliation report. */
function reconRow(page: Page, noteId: string) {
  return page
    .locator('.card')
    .filter({ hasText: 'Conciliación de albaranes' })
    .locator('div.space-y-1')
    .filter({ has: page.locator(`a[href="/triage/${noteId}"]`) })
}

test.describe('Delivery-note reconciliation', () => {
  test('a note waits for its invoice, pairs with it, and can be closed', async ({ page }, testInfo) => {
    test.slow() // two uploads + two OCR round-trips
    const project = testInfo.project.name as 'chromium' | 'mobile'
    const vendor = unique(testInfo, 'Lácteos del Valle')
    const date = new Date().toISOString().slice(0, 10)

    // ── The albarán alone: unmatched, chase the vendor ──
    const noteId = await uploadScan(page, SCAN_SAMPLES.deliveryNote[project])
    await approveScan(page, noteId, { vendor, date, deliveryNote: true })
    await page.goto('/triage')
    await expect(reconRow(page, noteId)).toContainText('Sin factura — reclámala al proveedor')

    // ── The factura arrives: same vendor, same day → paired ──
    const invoiceId = await uploadScan(page, SCAN_SAMPLES.invoice[project])
    await approveScan(page, invoiceId, { vendor, date })
    await page.goto('/triage')
    const row = reconRow(page, noteId)
    await expect(row).toContainText(/Conciliado con la factura|Precios distintos entre albarán y factura/)
    await expect(row).not.toContainText('Sin factura')

    // ── Resolved: the row closes for good (survives a reload) ──
    await row.getByRole('button', { name: /Resuelto/ }).click()
    await expect(reconRow(page, noteId)).toHaveCount(0)
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Bandeja de triaje' })).toBeVisible()
    await expect(reconRow(page, noteId)).toHaveCount(0)
  })
})
