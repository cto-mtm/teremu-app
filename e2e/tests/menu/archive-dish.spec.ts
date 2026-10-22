/**
 * Archiving a dish (an old menu item): it leaves the menu, its history
 * stays, and it can be restored. Nothing is ever deleted — past sales and
 * the recipes that use it must still cost correctly.
 */
import { test, expect } from '../../fixtures'
import { unique } from '../../flows/data'
import { createDish, dishCard } from '../../flows/menu.flow'

test.describe('Archive a dish', () => {
  test('archives a dish off the menu and restores it', async ({ page }, testInfo) => {
    const name = unique(testInfo, 'Plato de temporada')
    await createDish(page, { name, price: 12 })

    await dishCard(page, name).click()
    await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible()
    page.once('dialog', (d) => void d.accept())
    await page.getByRole('button', { name: 'Archivar', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Archivado' })).toBeVisible()
    // An archived dish is not edited — it is restored first.
    await expect(page.getByRole('button', { name: 'Editar' })).toBeHidden()

    // Off the menu list; still reachable under "Archivados".
    await page.goto('/menu')
    await expect(dishCard(page, name)).toBeHidden()
    await page.getByRole('button', { name: /^Archivados/ }).click()
    await dishCard(page, name).click()
    await page.getByRole('button', { name: 'Restaurar' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Archivado' })).toBeHidden()

    await page.goto('/menu')
    await expect(dishCard(page, name)).toBeVisible()
  })
})
