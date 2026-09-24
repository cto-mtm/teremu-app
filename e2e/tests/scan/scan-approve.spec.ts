/**
 * The golden path: photograph an invoice → AI digitizes it in the
 * background → review it in Triage → approve → the pantry, the vendor
 * directory and the dashboard all update themselves.
 *
 * This is the whole product in one test. Everything it asserts is
 * structural (an invoice came back with line items, the vendor we typed is
 * in the directory, the pantry holds what we approved) rather than
 * content-specific, because what OCR returns depends on how the emulator
 * is configured: with no LLM key the pipeline falls back to a randomized
 * offline mock, with one it reads the sample photo for real. Both must
 * pass. The runner forces the mock in one-shot mode (TEREMU_TEST_MOCKS);
 * against your own already-running emulators you get whichever you have.
 */
import { test, expect } from '../../fixtures'
import { SAMPLE_RECEIPT } from '../../constants'
import { unique } from '../../flows/data'
import { approveInvoice, scanReceipt } from '../../flows/invoice.flow'
import { ingredientLink } from '../../flows/pantry.flow'

test.describe('Scan → triage → approve', () => {
  test('an approved invoice stocks the pantry and names its vendor', async ({ page }, testInfo) => {
    // Upload + a background OCR round-trip + four page loads. On a cold
    // functions emulator this is the slowest test in the suite by far.
    test.slow()
    const vendor = unique(testInfo, 'Distribuciones Aurora')

    await scanReceipt(page, testInfo)

    // Triage polls while OCR runs; the card is not even clickable until
    // the pipeline has written a result back (approveInvoice waits on it).
    const ingredient = await approveInvoice(page, { vendor })

    // Out of the inbox, into the approved list.
    await page.goto('/triage')
    await expect(page.getByText('Aprobadas recientemente')).toBeVisible()
    await expect(page.locator('a[href^="/triage/"]').filter({ hasText: vendor })).toBeVisible()

    // The pantry built itself from the approved lines.
    await page.goto('/pantry')
    await expect(ingredientLink(page, ingredient)).toBeVisible()

    // And the vendor directory picked the supplier up from the invoice.
    await page.goto('/vendors')
    const vendorCard = page.locator('a[href^="/vendors/"]').filter({ hasText: vendor })
    await expect(vendorCard).toBeVisible()
    await expect(vendorCard).toContainText('1 facturas')

    await vendorCard.click()
    await expect(page.getByRole('heading', { name: vendor, level: 1 })).toBeVisible()
  })

  test('refuses the same photo a second time', async ({ page }, testInfo) => {
    // Idempotency on the uploaded bytes (api.ts → 409 duplicate_image): a
    // double-tap or a retried upload must not create a second invoice, or
    // burn a second scan off the monthly quota. The test above already
    // sent this project's sample; compressReceipt is deterministic, so
    // re-sending the same file produces the same bytes.
    await page.goto('/scan')
    await expect(page.getByRole('button', { name: 'Capturar factura' })).toBeVisible()
    await page.locator('input[type="file"]').setInputFiles(SAMPLE_RECEIPT[testInfo.project.name])

    await expect(page.getByRole('alert')).toContainText('Esta imagen ya fue escaneada')
    // The capture counter rolled back, so the review pill stays at "Listo"
    // — the camera is live and nothing new is waiting in Triage.
    await expect(page.getByRole('button', { name: 'Listo' })).toBeVisible()
  })
})
