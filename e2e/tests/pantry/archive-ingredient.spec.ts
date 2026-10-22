/**
 * Archiving an ingredient (an old product, a line approved by mistake):
 * hidden from the pantry, kept for history, restorable. Buying it again
 * restores it on its own — covered by the integration suite (pantry.test.ts).
 */
import { test, expect } from '../../fixtures'
import { unique } from '../../flows/data'
import { createIngredient, ingredientLink } from '../../flows/pantry.flow'

test.describe('Archive an ingredient', () => {
  test('archives an ingredient out of the pantry and restores it', async ({ page }, testInfo) => {
    const name = unique(testInfo, 'Producto viejo')
    await createIngredient(page, { name })

    await ingredientLink(page, name).click()
    await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible()
    page.once('dialog', (d) => void d.accept())
    await page.getByRole('button', { name: 'Archivar', exact: true }).click()

    // Back on the pantry, out of the list, still under "Archivados".
    await expect(page).toHaveURL(/\/pantry$/)
    await expect(ingredientLink(page, name)).toBeHidden()
    await page.getByRole('button', { name: /^Archivados/ }).click()
    await ingredientLink(page, name).click()
    await expect(page.getByRole('status').filter({ hasText: 'Archivado' })).toBeVisible()
    await page.getByRole('button', { name: 'Restaurar' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Archivado' })).toBeHidden()

    await page.goto('/pantry')
    await expect(ingredientLink(page, name)).toBeVisible()
  })
})
