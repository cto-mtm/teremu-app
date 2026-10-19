/**
 * Assistant smoke — the shared @mtmcya/assistant mounted in Teremu: open
 * it from the sidebar, ask one question, see the streamed answer and the
 * tool card rendered from real (UI-created) data.
 *
 * The functions emulator runs with TEREMU_TEST_MOCKS, so the model is the
 * scripted one in firebase/functions/src/assistant/script.ts: the prompt
 * below matches its "margen" entry, which calls getDishCosts. The tool
 * itself runs for real against the emulator's Firestore.
 */
import { test, expect } from '../../fixtures'
import { unique } from '../../flows/data'
import { createIngredient } from '../../flows/pantry.flow'
import { createDish } from '../../flows/menu.flow'
import { setPlanEverywhere } from '../../flows/plan.flow'

// Pro so the run never meets the free plan's 20-questions-a-month quota.

test.describe('Assistant', () => {
  // The sidebar entry lives in the off-canvas drawer on phones; the
  // desktop project covers the flow.
  test.skip(({ isMobile }) => !!isMobile, 'desktop-only smoke')

  test('answers a margin question with a dish-cost card from the pantry prices', async ({ page }, testInfo) => {
    await setPlanEverywhere('pro')

    const tomato = unique(testInfo, 'Tomate')
    const dish = unique(testInfo, 'Ensalada')
    // 0.5 kg × $2/kg = $1 cost on a $10 plate → 90 % margin.
    await createIngredient(page, { name: tomato, unit: 'kg', price: 2, stock: 10 })
    await createDish(page, { name: dish, price: 10, targetMarginPct: 70, recipe: [{ ingredient: tomato, qty: 0.5 }] })

    await page.getByRole('button', { name: 'Abrir asistente' }).click()
    const dialog = page.getByRole('dialog', { name: 'Teremu' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('¿En qué te ayudo?')).toBeVisible()

    await dialog.getByPlaceholder('Escribe tu pregunta…').fill('¿Qué platos tienen menos margen?')
    await dialog.getByRole('button', { name: 'Enviar' }).click()

    // The scripted answer streams in, and the getDishCosts card lists the
    // dish with its computed cost in the restaurant's currency format.
    await expect(dialog.getByText('menor margen')).toBeVisible({ timeout: 20_000 })
    await expect(dialog.getByRole('cell', { name: dish })).toBeVisible()
    await expect(dialog.getByRole('cell', { name: /1,00/ })).toBeVisible()
  })
})
