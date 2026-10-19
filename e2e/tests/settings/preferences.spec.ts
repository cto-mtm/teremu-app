/**
 * Settings that change how the app computes or offers things: the
 * location's name, the kitchen labor rate (server-side, survives a
 * reload), and the unit system offered in pickers (device-local).
 */
import { test, expect } from '../../fixtures'
import { unique } from '../../flows/data'

test.describe('Settings', () => {
  test('location name and labor rate are saved server-side', async ({ page }, testInfo) => {
    await page.goto('/settings')
    await expect(page.getByRole('heading', { name: 'Ajustes' })).toBeVisible()

    const locationCard = page.locator('.card').filter({ hasText: 'Nombre del local' })
    const name = unique(testInfo, 'Casa Teremu')
    await locationCard.getByPlaceholder('Mi restaurante').fill(name)
    await locationCard.getByRole('button', { name: 'Guardar' }).click()
    await expect(locationCard.getByText('Guardado')).toBeVisible()

    const laborCard = page.locator('.card').filter({ hasText: 'Mano de obra' })
    await laborCard.getByPlaceholder('15').fill('18.5')
    await laborCard.getByRole('button', { name: 'Guardar' }).click()
    await expect(laborCard.getByText('Guardado')).toBeVisible()

    await page.reload()
    await expect(locationCard.getByPlaceholder('Mi restaurante')).toHaveValue(name)
    await expect(laborCard.getByPlaceholder('15')).toHaveValue('18.5')

    // Leave the shared restaurant costing ingredients only, as other specs
    // expect (an empty rate = no labor in any plate cost).
    await laborCard.getByPlaceholder('15').fill('')
    await laborCard.getByRole('button', { name: 'Guardar' }).click()
    await expect(laborCard.getByText('Guardado')).toBeVisible()
  })

  test('the unit system decides what the pantry offers', async ({ page }) => {
    await page.goto('/settings')
    await page.getByRole('button', { name: 'Imperial', exact: true }).click()

    await page.goto('/pantry')
    await page.getByRole('button', { name: '+ Ingrediente' }).click()
    const unit = page.getByLabel('Unidad', { exact: true })
    await expect(unit.locator('option', { hasText: /^lb$/ })).toHaveCount(1)
    await expect(unit.locator('option', { hasText: /^kg$/ })).toHaveCount(0)

    await page.goto('/settings')
    await page.getByRole('button', { name: 'Métrico', exact: true }).click()
    await page.goto('/pantry')
    await page.getByRole('button', { name: '+ Ingrediente' }).click()
    await expect(page.getByLabel('Unidad', { exact: true }).locator('option', { hasText: /^kg$/ })).toHaveCount(1)
  })

  test('the API health check answers', async ({ page }) => {
    await page.goto('/settings')
    await page.getByRole('button', { name: 'Comprobar' }).click()
    await expect(page.getByText(/^OK · /)).toBeVisible()
  })
})
