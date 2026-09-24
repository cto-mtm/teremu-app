/**
 * Menu margins — the product's core promise: map ingredients to a dish
 * and the plate cost (and therefore the margin) is computed from the
 * pantry's real prices, live.
 *
 * The arithmetic itself is covered by the API suite; what this proves is
 * that a restaurant can get from "no menu" to "a costed dish with a
 * margin on screen" entirely through the UI.
 */
import { test, expect } from '../../fixtures'
import { unique } from '../../flows/data'
import { createIngredient } from '../../flows/pantry.flow'
import { createDish, dishCard } from '../../flows/menu.flow'

test.describe('Dish margins', () => {
  test('costs a dish from its recipe and flags it against the target', async ({ page }, testInfo) => {
    const salmon = unique(testInfo, 'Salmón')
    const rice = unique(testInfo, 'Arroz Bomba')
    const dish = unique(testInfo, 'Salmón con arroz')

    // 0.2 kg × $20/kg + 0.1 kg × $3/kg = $4.30 plate cost.
    await createIngredient(page, { name: salmon, unit: 'kg', price: 20, stock: 10 })
    await createIngredient(page, { name: rice, unit: 'kg', price: 3, stock: 10 })

    // Sells at $20 → margin (20 − 4.30) / 20 = 78.5%, comfortably over a
    // 70% target, so the dish must NOT be flagged.
    await createDish(page, {
      name: dish,
      price: 20,
      targetMarginPct: 70,
      recipe: [
        { ingredient: salmon, qty: 0.2 },
        { ingredient: rice, qty: 0.1 },
      ],
    })

    const card = dishCard(page, dish)
    // Margin and currency both go through vue-i18n's `es` formatter: comma
    // decimal, and a (no-break) space before the percent sign.
    await expect(card).toContainText(/78,5\s%/)
    await expect(card).toContainText(/objetivo 70\s%/)
    await expect(card).toContainText('4,30')

    // Detail page: same numbers, plus the per-ingredient breakdown.
    await card.click()
    await expect(page.getByRole('heading', { name: dish, level: 1 })).toBeVisible()
    await expect(page.getByText('Desglose de costo por ingrediente')).toBeVisible()
    await expect(page.getByText(salmon).first()).toBeVisible()
    await expect(page.getByText(rice).first()).toBeVisible()
  })

  test('marks a dish that sells under its target margin', async ({ page }, testInfo) => {
    const truffle = unique(testInfo, 'Trufa')
    const dish = unique(testInfo, 'Pasta trufada')

    // 0.05 kg × $600/kg = $30 cost on a $40 plate → 25% margin, far below
    // the 70% target: the list must show the coral "needs attention" dot.
    await createIngredient(page, { name: truffle, unit: 'kg', price: 600, stock: 1 })
    await createDish(page, {
      name: dish,
      price: 40,
      targetMarginPct: 70,
      recipe: [{ ingredient: truffle, qty: 0.05 }],
    })

    const card = dishCard(page, dish)
    await expect(card).toContainText(/25,0\s%/)
    await expect(card).toContainText('●')
  })
})
