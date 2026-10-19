/**
 * Menu flow — create a dish or a prep (optionally with a recipe) through
 * the editor sheet on /menu.
 */
import { expect, type Locator, type Page } from '@playwright/test'

export interface RecipeLine {
  /** Name of an EXISTING ingredient or prep — the editor's select lists both. */
  ingredient: string
  qty: number
  /** Spanish unit LABEL (common.unit.*) when not the default, e.g. 'ml' of a prep in L. */
  unit?: string
}

export interface DishData {
  name: string
  /** Menu price in $. */
  price: number
  /** Target margin %; the editor defaults to 70. */
  targetMarginPct?: number
  recipe?: RecipeLine[]
}

/**
 * Create a dish through "+ Plato". Assumes every ingredient it references
 * already exists. Resolves once the dish card is on the menu list.
 */
export async function createDish(page: Page, data: DishData): Promise<void> {
  await page.goto('/menu')
  await page.getByRole('button', { name: '+ Plato' }).click()
  await expect(page.getByRole('heading', { name: 'Nuevo plato' })).toBeVisible()

  await page.getByPlaceholder('Nombre del plato').fill(data.name)
  await page.getByLabel(/Precio en carta/).fill(String(data.price))
  if (data.targetMarginPct !== undefined) {
    await page.getByLabel(/Margen objetivo/).fill(String(data.targetMarginPct))
  }

  await fillRecipe(page, data.recipe ?? [])

  await page.getByRole('button', { name: 'Guardar' }).click()
  await expect(page.getByRole('heading', { name: 'Nuevo plato' })).toBeHidden()
  await expect(dishCard(page, data.name)).toBeVisible()
}

export interface PrepData {
  name: string
  /** What one batch makes, e.g. 2 L. */
  yieldQty: number
  /** Spanish unit LABEL of the yield (common.unit.*). */
  yieldUnit: string
  recipe?: RecipeLine[]
}

/**
 * Create a prep (docs/prep-recipes.md) from the Preparaciones tab.
 * Resolves once its card is on that tab.
 */
export async function createPrep(page: Page, data: PrepData): Promise<void> {
  await page.goto('/menu?tab=preps')
  await page.getByRole('button', { name: '+ Preparación' }).first().click()
  await expect(page.getByRole('heading', { name: 'Nueva preparación' })).toBeVisible()

  await page.getByPlaceholder('Nombre (p. ej. Fondo oscuro)').fill(data.name)
  await page.getByLabel('Rinde (por lote)').fill(String(data.yieldQty))
  // The yield unit is the sheet's first "Unidad" select (recipe lines come after).
  await page.getByLabel('Unidad', { exact: true }).first().selectOption({ label: data.yieldUnit })

  await fillRecipe(page, data.recipe ?? [])

  await page.getByRole('button', { name: 'Guardar' }).click()
  await expect(page.getByRole('heading', { name: 'Nueva preparación' })).toBeHidden()
  await expect(dishCard(page, data.name)).toBeVisible()
}

async function fillRecipe(page: Page, recipe: RecipeLine[]): Promise<void> {
  for (const [i, line] of recipe.entries()) {
    await page.getByRole('button', { name: '+ Añadir ingrediente' }).click()

    // One select + one qty input per recipe line, in DOM order.
    const picker = page.locator('select').filter({ hasText: 'Elige un ingrediente…' }).nth(i)
    // The option label carries the live price ("Tomate ($2,15/kg)"), which
    // changes as invoices are approved — so match the option by its text
    // and select by the value it carries, never by a formatted label.
    const value = await picker.locator('option', { hasText: line.ingredient }).first().getAttribute('value')
    expect(value, `ingredient "${line.ingredient}" offered in the recipe picker`).toBeTruthy()
    await picker.selectOption(value!)

    await page.getByPlaceholder('cant.').nth(i).fill(String(line.qty))
    if (line.unit) {
      // The line's own unit select sits in the same row as its picker.
      await picker.locator('xpath=..').getByLabel('Unidad', { exact: true }).selectOption({ label: line.unit })
    }
  }
}

/** The dish's card on the /menu list. */
export function dishCard(page: Page, name: string): Locator {
  return page.locator('a[href^="/menu/"]').filter({ hasText: name })
}
