/**
 * Unused ingredients (docs/prep-recipes.md § Unused ingredients) — an
 * ingredient in no recipe never reaches a plate cost, so the pantry flags
 * it and offers the two fixes: add it to a recipe, or say it never goes
 * in one. The restaurant is shared by every spec of a project, so this
 * asserts per row, never the banner's count.
 */
import { test, expect } from '../../fixtures'
import { unique } from '../../flows/data'
import { createIngredient, ingredientLink } from '../../flows/pantry.flow'
import { createDish } from '../../flows/menu.flow'

test.describe('Unused ingredients', () => {
  test('flags an ingredient in no recipe and links it to a dish from its page', async ({ page }, testInfo) => {
    const lemon = unique(testInfo, 'Limón')
    const dish = unique(testInfo, 'Lubina a la sal')

    await createIngredient(page, { name: lemon, unit: 'kg', price: 2, stock: 5 })
    // A recipe must exist before anything is flagged.
    await createDish(page, { name: dish, price: 18 })

    await page.goto('/pantry')
    await expect(ingredientLink(page, lemon)).toContainText('Sin receta')

    await ingredientLink(page, lemon).click()
    await expect(page.getByText('No usas este ingrediente en ninguna receta')).toBeVisible()
    await page.getByRole('button', { name: '+ Añadir a una receta' }).click()

    const sheet = page.getByRole('dialog', { name: `Añadir ${lemon} a una receta` })
    await sheet.getByPlaceholder('Busca un plato o preparación').fill(dish)
    await sheet.getByRole('button', { name: dish }).click()
    await sheet.getByLabel('Cantidad por plato').fill('0.05')
    await sheet.getByRole('button', { name: `Añadir a ${dish}` }).click()
    await expect(sheet).toBeHidden()

    // The warning gives way to the recipe that now uses it.
    await expect(page.getByText('No usas este ingrediente en ninguna receta')).toBeHidden()
    await expect(page.getByRole('link', { name: dish })).toBeVisible()
    await page.goto('/pantry')
    await expect(ingredientLink(page, lemon)).not.toContainText('Sin receta')
  })

  test('"not a recipe ingredient" silences the warning, and undo brings it back', async ({ page }, testInfo) => {
    const bags = unique(testInfo, 'Bolsas para llevar')
    const dish = unique(testInfo, 'Croquetas caseras')

    await createIngredient(page, { name: bags, unit: 'unidad', price: 0.1, stock: 100 })
    await createDish(page, { name: dish, price: 9 })

    await page.goto('/pantry')
    await ingredientLink(page, bags).click()
    await page.getByRole('button', { name: 'No va en recetas' }).click()
    await expect(page.getByText('Marcado como fuera de recetas')).toBeVisible()
    await expect(page.getByText('No usas este ingrediente en ninguna receta')).toBeHidden()

    await page.getByRole('button', { name: 'Deshacer' }).click()
    await expect(page.getByText('No usas este ingrediente en ninguna receta')).toBeVisible()
  })
})
