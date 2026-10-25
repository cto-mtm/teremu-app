/**
 * Merging duplicates (docs/architecture.md §Ingredient identity): the
 * pantry lists near-identical names, a row opens the merge sheet with the
 * other one preselected, and after the merge one ingredient remains and
 * answers to the other's name. Recipe, invoice and POS repointing are
 * covered by the integration suite (pantry.test.ts).
 */
import { test, expect } from '../../fixtures'
import { unique } from '../../flows/data'
import { createIngredient, ingredientLink } from '../../flows/pantry.flow'

test.describe('Merge duplicate ingredients', () => {
  test('a possible-duplicate pair merges into one ingredient', async ({ page }, testInfo) => {
    const a = unique(testInfo, 'Chuleta de cerdo')
    const b = unique(testInfo, 'CHULETA CERDO')
    await createIngredient(page, { name: a })
    await createIngredient(page, { name: b })

    await page.getByRole('button', { name: /^Buscar posibles duplicados/ }).click()
    const row = page.locator('a[href*="?merge="]').filter({ hasText: a }).filter({ hasText: b })
    await expect(row).toBeVisible()
    await row.click()

    const sheet = page.getByRole('dialog', { name: /^Fusionar/ })
    await expect(sheet).toBeVisible()
    await expect(sheet.getByRole('status')).toContainText('se fusiona en')
    await sheet.getByRole('button', { name: 'Fusionar', exact: true }).click()
    await expect(sheet).toBeHidden()
    await expect(page).toHaveURL(/\/pantry\/[^?]+$/)

    // One of the two is left; its page lists the other's name as an alias.
    const survivor = (await page.getByRole('heading', { level: 1 }).innerText()).trim()
    expect([a, b]).toContain(survivor)
    const loser = survivor === a ? b : a
    await expect(page.getByText(loser.toLowerCase(), { exact: true })).toBeVisible()

    await page.goto('/pantry')
    await expect(ingredientLink(page, survivor)).toBeVisible()
    await expect(ingredientLink(page, loser)).toHaveCount(0)
  })
})
