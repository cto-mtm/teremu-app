/**
 * Manual ingredient creation — the cold-start path. A brand-new
 * restaurant has no approved invoices, so the pantry has to be buildable
 * by hand before the scanner ever fills it.
 */
import { test, expect } from '../../fixtures'
import { unique } from '../../flows/data'
import { createIngredient, ingredientLink } from '../../flows/pantry.flow'

test.describe('Create ingredient', () => {
  test('creates an ingredient with a unit, price and starting stock', async ({ page }, testInfo) => {
    const name = unique(testInfo, 'Tomate Roma')
    await createIngredient(page, {
      name,
      unit: 'kg',
      category: 'Verduras y frutas',
      price: 2.4,
      stock: 12,
    })

    const row = ingredientLink(page, name)
    await expect(row).toContainText('2,40')
    await expect(row).toContainText('por kg')

    // The name links to the detail page (hero transition source).
    await row.click()
    await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible()
    await expect(page.getByText('Existencias teóricas')).toBeVisible()
  })

  test('creates an ingredient with just a name', async ({ page }, testInfo) => {
    const name = unique(testInfo, 'Sal Marina')
    await createIngredient(page, { name })

    // No price yet — that fills itself when an invoice is approved.
    await expect(ingredientLink(page, name)).toContainText('0,00')
  })

  test('refuses a duplicate name instead of splitting the ingredient', async ({ page }, testInfo) => {
    const name = unique(testInfo, 'Aceite de Oliva')
    await createIngredient(page, { name })

    // The server keys ingredients by normalized name, so a second one
    // under the same name would silently fork this ingredient's price
    // history. The app surfaces that as an alert and keeps the sheet open.
    const dialog = page.waitForEvent('dialog')
    await page.getByRole('button', { name: '+ Ingrediente' }).click()
    await page.getByPlaceholder('Nombre').fill(name.toUpperCase())
    await page.getByRole('button', { name: 'Guardar' }).click()

    const alert = await dialog
    expect(alert.message()).toContain('Ya existe un ingrediente con ese nombre')
    await alert.dismiss()

    await expect(ingredientLink(page, name)).toHaveCount(1)
  })
})
