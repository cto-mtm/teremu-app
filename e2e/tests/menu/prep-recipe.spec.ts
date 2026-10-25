/**
 * Prep recipes (docs/prep-recipes.md) — a batch recipe with a yield, used
 * inside a dish by an amount of that yield, costs the dish by the share of
 * the batch it takes. The arithmetic is pinned by shared/src/cost.test.ts;
 * this proves the whole loop works through the UI.
 */
import { test, expect } from '../../fixtures'
import { unique } from '../../flows/data'
import { createIngredient } from '../../flows/pantry.flow'
import { createDish, createPrep, dishCard } from '../../flows/menu.flow'

test.describe('Prep recipes', () => {
  test('a dish that uses 500 ml of a 2 L prep costs a quarter of the batch', async ({ page }, testInfo) => {
    const bones = unique(testInfo, 'Huesos')
    const stock = unique(testInfo, 'Fondo oscuro')
    const dish = unique(testInfo, 'Arroz meloso')

    // 1 kg × $4/kg = $4 a batch that yields 2 L → $2 per litre.
    await createIngredient(page, { name: bones, unit: 'kg', price: 4, stock: 10 })
    await createPrep(page, { name: stock, yieldQty: 2, yieldUnit: 'L', recipe: [{ ingredient: bones, qty: 1 }] })

    const prepCard = dishCard(page, stock)
    await expect(prepCard).toContainText('Rinde 2 L')
    await expect(prepCard).toContainText('4,00')
    await expect(prepCard).toContainText('2,00')
    await expect(prepCard).toContainText('Sin usar')

    // 500 ml = 1/4 of the batch → $1 on a $20 plate → 95 % margin.
    await createDish(page, { name: dish, price: 20, recipe: [{ ingredient: stock, qty: 500, unit: 'ml' }] })
    const card = dishCard(page, dish)
    await expect(card).toContainText('1,00')
    // 1 € on a 20 € plate that nets 18.18 € after 10 % IVA (ES pack): 94.5 %.
    await expect(card).toContainText(/94,5\s%/)

    // The prep stays off the dishes tab and now counts its use.
    await expect(dishCard(page, stock)).toHaveCount(0)
    await page.getByRole('tab', { name: /Preparaciones/ }).click()
    await expect(dishCard(page, stock)).toContainText('En 1 plato')

    // Its page lists the dish that uses it.
    await dishCard(page, stock).click()
    await expect(page.getByRole('heading', { name: stock, level: 1 })).toBeVisible()
    await expect(page.getByText('Se usa en')).toBeVisible()
    await expect(page.getByRole('link', { name: dish })).toBeVisible()
  })
})
