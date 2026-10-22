/**
 * The one-time main-currency prompt (docs/multi-currency.md § Settings):
 * the base currency is only inferred from the country until the owner
 * confirms it, and the first approval locks it — so that approval asks.
 *
 * Runs in a FRESH location on purpose: the shared default location may
 * already hold approved documents (and so a locked currency) depending on
 * spec order. A new location is a different restaurant, so re-uploading
 * this project's sample receipt there is not a duplicate.
 *
 * Desktop only: the location switcher lives in the sidebar, which is an
 * off-canvas drawer on phones.
 */
import { test, expect } from '../../fixtures'
import { unique } from '../../flows/data'
import { SAMPLE_RECEIPT } from '../../constants'
import { currencyPrompt, fillScanHeader, scanCard, uploadScan, waitForScan } from '../../flows/invoice.flow'

test.describe('Main currency confirmation', () => {
  test.skip(({ isMobile }) => !!isMobile, 'desktop-only: the location switcher is in the sidebar')

  test('the first approval asks once, then the currency is locked', async ({ page }, testInfo) => {
    test.slow()
    await page.goto('/')
    await page.getByRole('button', { name: 'Ubicación actual' }).click()
    await page.getByRole('button', { name: 'Añadir ubicación' }).click()
    const location = unique(testInfo, 'Sucursal Moneda')
    await page.getByPlaceholder('Nombre de la ubicación').fill(location)
    await page.getByRole('button', { name: 'Crear' }).click()
    // Wait for the switch to land: the upload must go to THIS location, not
    // the shared one that already holds this project's sample receipt.
    await expect(page.getByRole('button', { name: 'Ubicación actual' })).toContainText(location)
    // A new location starts on "find your restaurant", and every page but
    // Settings redirects there until it is done or skipped (for good).
    await page.goto('/setup/restaurant')
    await page.getByRole('button', { name: 'Prefiero empezar de cero' }).click()
    await expect(page).not.toHaveURL(/\/setup\/restaurant$/)

    const id = await uploadScan(page, SAMPLE_RECEIPT[testInfo.project.name])
    await waitForScan(page, id)
    await scanCard(page, id).click()
    await fillScanHeader(page, { vendor: unique(testInfo, 'Proveedor Moneda') })

    const approve = page.getByRole('button', { name: /^Aprobar factura/ })
    await approve.click()
    // Nothing is approved yet: the prompt, not the approval.
    const prompt = currencyPrompt(page)
    await expect(prompt).toBeVisible()
    await expect(prompt).toContainText('ya no se puede cambiar')
    await expect(approve).toBeVisible()

    // Keep the inferred currency → the approval goes ahead.
    await prompt.getByRole('button', { name: /— aprobar$/ }).click()
    await expect(approve).toBeHidden()
    await expect(prompt).toBeHidden()

    // Locked from now on.
    await page.goto('/settings')
    await expect(page.getByLabel('Moneda base')).toBeDisabled()
  })
})
