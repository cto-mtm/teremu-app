/**
 * Sales → pantry. Logging a day's takings with the dishes sold is what
 * makes the theoretical pantry drain: the server walks each dish's recipe
 * and subtracts the ingredients. This is the half of "zero daily input"
 * that invoices don't cover, and the one place a recipe bug shows up as a
 * wrong stock number rather than a wrong margin.
 */
import { test, expect } from '../../fixtures'
import { unique } from '../../flows/data'
import { createIngredient, readStock } from '../../flows/pantry.flow'
import { createDish } from '../../flows/menu.flow'

test.describe('Revenue entry', () => {
  test('records the day and depletes the pantry through the recipe', async ({ page }, testInfo) => {
    const flour = unique(testInfo, 'Harina 00')
    const dish = unique(testInfo, 'Pizza Margarita')
    // Amounts need namespacing too: both projects log a day into the SAME
    // restaurant, so identical takings render two identical "+960,00" rows.
    const takings = testInfo.project.name === 'mobile' ? 961 : 960
    const shown = new RegExp(`\\+${takings},00`)

    // 40 kg on hand, 0.25 kg per pizza.
    await createIngredient(page, { name: flour, unit: 'kg', price: 1.2, stock: 40 })
    await createDish(page, { name: dish, price: 12, recipe: [{ ingredient: flour, qty: 0.25 }] })

    await page.goto('/')
    await page.getByRole('button', { name: '+ Ingresos' }).click()
    const heading = page.getByRole('heading', { name: 'Registrar ingresos' })
    await expect(heading).toBeVisible()
    // Scope to the sheet panel (the heading's parent): every dish name on
    // this page also appears in the menu-engineering matrix behind it.
    const sheet = heading.locator('xpath=..')

    await sheet.getByLabel(/Ventas totales/).fill(String(takings))
    // Dish quantities are optional — the sheet lists every active dish and
    // only the ones given a qty count against the pantry.
    const soldRow = sheet.getByText(dish, { exact: true }).locator('xpath=..')
    await soldRow.getByRole('spinbutton').fill('24')

    await sheet.getByRole('button', { name: 'Guardar' }).click()
    await expect(heading).toBeHidden()

    // The day lands on the dashboard…
    await expect(page.getByText('Movimientos recientes')).toBeVisible()
    await expect(page.getByText(shown)).toBeVisible()

    // …and 24 × 0.25 kg = 6 kg of flour left the pantry.
    await page.goto('/pantry')
    await expect.poll(() => readStock(page, flour)).toBe(34)
  })
})
