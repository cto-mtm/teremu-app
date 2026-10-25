/**
 * Ingredient identity in Triage (docs/architecture.md §Ingredient identity):
 * a line spelled differently from a pantry ingredient shows "Nuevo"; the
 * reviewer links it, approval keeps the link and the ingredient learns
 * the spelling. That the next invoice then matches silently is covered by
 * the integration suite (invoices.test.ts) — it needs no second scan here.
 */
import { test, expect } from '../../fixtures'
import { SCAN_SAMPLES } from '../../constants'
import { unique } from '../../flows/data'
import { clickApprove, fillScanHeader, scanCard, uploadScan, waitForScan } from '../../flows/invoice.flow'
import { createIngredient, ingredientLink } from '../../flows/pantry.flow'

test.describe('Link an invoice line to an existing ingredient', () => {
  test('a vendor spelling links to the pantry ingredient and is remembered', async ({ page }, testInfo) => {
    test.slow() // upload + background OCR
    const name = unique(testInfo, 'Lomo de cerdo')
    // Same words, no "de": not the same key, a strong suggestion.
    const printed = unique(testInfo, 'LOMO CERDO')
    await createIngredient(page, { name })

    const id = await uploadScan(page, SCAN_SAMPLES.link[testInfo.project.name as 'chromium' | 'mobile'])
    await waitForScan(page, id)
    await scanCard(page, id).click()
    await expect(page).toHaveURL(new RegExp(`/triage/${id}$`))
    await fillScanHeader(page, { vendor: unique(testInfo, 'Cárnicas Norte') })

    // The first line becomes the vendor's spelling of our ingredient.
    const firstLine = page.locator('.card').filter({ has: page.getByPlaceholder('Nombre del artículo') }).first()
    await firstLine.getByPlaceholder('Nombre del artículo').fill(printed)
    const badge = firstLine.getByRole('button', { name: /Toca para vincularlo/ })
    await expect(badge).toHaveText('Nuevo')
    await badge.click()

    const sheet = page.getByRole('dialog', { name: /^Vincular/ })
    await expect(sheet).toBeVisible()
    // Under "Sugerencias"; a unit that doesn't convert asks for a second tap.
    const option = sheet.getByRole('button', { name: new RegExp(`^${name}`) }).first()
    await option.click()
    const outcome = await Promise.race([
      sheet.waitFor({ state: 'hidden' }).then(() => 'closed' as const),
      sheet.getByRole('status').waitFor({ state: 'visible' }).then(() => 'warned' as const),
    ])
    if (outcome === 'warned') await option.click()
    await expect(sheet).toBeHidden()
    await expect(firstLine.getByText(`Vinculado a ${name}`)).toBeVisible()
    await expect(badge).toBeHidden()

    await clickApprove(page, page.getByRole('button', { name: /^Aprobar factura/ }))
    await expect(page.getByRole('button', { name: /^Aprobar factura/ })).toBeHidden()

    // The pantry kept one ingredient, and it now answers to the spelling.
    await page.goto('/pantry')
    await expect(ingredientLink(page, printed)).toBeHidden()
    await ingredientLink(page, name).click()
    await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible()
    await expect(page.getByText(printed.toLowerCase(), { exact: true })).toBeVisible()
  })
})
