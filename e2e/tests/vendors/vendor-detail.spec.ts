/**
 * Vendor directory → vendor page. The directory builds itself from
 * approved invoices; the page shows what was bought from the vendor and
 * keeps the ordering contact the shopping list uses.
 */
import { test, expect } from '../../fixtures'
import { SCAN_SAMPLES } from '../../constants'
import { unique } from '../../flows/data'
import { approveScan, uploadScan } from '../../flows/invoice.flow'

test.describe('Vendors', () => {
  test('search finds a vendor, its page lists its invoice and keeps a contact', async ({ page }, testInfo) => {
    test.slow() // upload + background OCR
    const vendor = unique(testInfo, 'Frutas Selectas')
    const id = await uploadScan(page, SCAN_SAMPLES.vendor[testInfo.project.name as 'chromium' | 'mobile'])
    await approveScan(page, id, { vendor })

    // ── Directory search ──
    await page.goto('/vendors')
    const search = page.getByPlaceholder('Buscar…')
    await search.fill(vendor)
    const card = page.locator('a[href^="/vendors/"]').filter({ hasText: vendor })
    await expect(card).toBeVisible()
    await expect(card).toContainText('1 facturas')
    await search.fill('zzz no such vendor')
    await expect(page.getByText('Nada coincide con tu búsqueda.')).toBeVisible()
    await search.fill(vendor)

    // ── Vendor page: the invoice and what it supplied ──
    await card.click()
    await expect(page.getByRole('heading', { name: vendor, level: 1 })).toBeVisible()
    await expect(page.getByText('Facturas', { exact: true })).toBeVisible()
    await expect(page.locator(`a[href="/triage/${id}"]`)).toBeVisible()
    await expect(page.getByText('Ingredientes suministrados')).toBeVisible()

    // ── Ordering contact is saved server-side ──
    const email = `pedidos+${testInfo.project.name}@frutas.test`
    await page.getByPlaceholder('Correo de pedidos').fill(email)
    await page.getByPlaceholder('WhatsApp (+52…)').fill('+34 600 000 000')
    await page.getByRole('button', { name: 'Guardar' }).click()
    await expect(page.getByRole('button', { name: 'Guardado ✓' })).toBeVisible()

    await page.reload()
    await expect(page.getByPlaceholder('Correo de pedidos')).toHaveValue(email)
    await expect(page.getByPlaceholder('WhatsApp (+52…)')).toHaveValue('+34 600 000 000')
  })
})
