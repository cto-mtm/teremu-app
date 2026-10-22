/**
 * Triage housekeeping: dismissing a scan is reversible, and a non-food
 * bill can be diverted to expenses instead of the pantry.
 *
 * One test on purpose: the same scan walks dismiss → restore → approve
 * as expense, so the spec costs a single OCR round-trip.
 */
import { test, expect } from '../../fixtures'
import { SCAN_SAMPLES } from '../../constants'
import { unique } from '../../flows/data'
import { clickApprove, fillScanHeader, scanCard, uploadScan, waitForScan } from '../../flows/invoice.flow'

test.describe('Triage housekeeping', () => {
  test('a dismissed scan can be restored, then approved as an expense', async ({ page }, testInfo) => {
    test.slow() // upload + background OCR
    const vendor = unique(testInfo, 'Fotografía Brillo')
    const id = await uploadScan(page, SCAN_SAMPLES.dismiss[testInfo.project.name as 'chromium' | 'mobile'])
    await waitForScan(page, id)

    // ── Dismiss from the detail page (the card's ✕ is only for FAILED
    // scans): confirm() first, then the scan leaves the inbox ──
    await scanCard(page, id).click()
    await expect(page).toHaveURL(new RegExp(`/triage/${id}$`))
    page.once('dialog', (dialog) => {
      expect(dialog.message()).toContain('¿Descartar este escaneo?')
      void dialog.accept()
    })
    await page.getByRole('button', { name: 'Descartar', exact: true }).click()
    await expect(page).toHaveURL(/\/triage$/)
    await expect(scanCard(page, id)).toBeHidden()
    await expect(page.getByRole('heading', { name: 'Descartadas' })).toBeVisible()

    // ── Restore: kept, not deleted — it comes back as reviewable ──
    const restored = page.waitForResponse(
      (r) => r.url().endsWith(`/invoices/${id}/discard`) && r.request().method() === 'PUT',
    )
    await page.getByRole('button', { name: 'Restaurar' }).first().click()
    expect((await restored).ok(), 'the restore hit THIS scan').toBe(true)
    await expect(scanCard(page, id)).toContainText('Revisar')

    // ── Approve as expense: tagged spend, never the pantry ──
    await scanCard(page, id).click()
    await fillScanHeader(page, { vendor })
    await page.getByRole('button', { name: /Aprobar como gasto/ }).click()
    await page.getByPlaceholder('Etiqueta del gasto').fill('Fotografía')
    await clickApprove(page, page.getByRole('button', { name: 'Confirmar gasto' }))
    await expect(page).toHaveURL(/\/triage$/)
    // Out of the inbox, into "Aprobadas recientemente" (same link) — under
    // the vendor the reviewer typed, not the OCR's guess.
    await expect(page.getByText('Aprobadas recientemente')).toBeVisible()
    await expect(scanCard(page, id)).not.toContainText('Revisar')
    await expect(scanCard(page, id)).toContainText(vendor)

    // The payee joins the vendor directory through its expense alone (the
    // card counts it as its one document, tagged with the expense), and
    // its page lists the expense — not a food invoice.
    await page.goto('/vendors')
    const card = page.locator('a[href^="/vendors/"]').filter({ hasText: vendor })
    await expect(card).toBeVisible()
    await expect(card).toContainText(/1 factura(?!s)/)
    await expect(card).toContainText('Fotografía')
    await card.click()
    await expect(page.getByRole('heading', { name: vendor, level: 1 })).toBeVisible()
    await expect(page.getByText('Gastos', { exact: true })).toBeVisible()
  })
})
