/**
 * Menu flow — create a dish (optionally with a recipe) through the dish
 * editor sheet on /menu.
 */
import { expect, type Locator, type Page } from '@playwright/test'

export interface RecipeLine {
  /** Name of an EXISTING ingredient — the editor's select lists them. */
  ingredient: string
  qty: number
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

  for (const [i, line] of (data.recipe ?? []).entries()) {
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
  }

  await page.getByRole('button', { name: 'Guardar' }).click()
  await expect(page.getByRole('heading', { name: 'Nuevo plato' })).toBeHidden()
  await expect(dishCard(page, data.name)).toBeVisible()
}

/** The dish's card on the /menu list. */
export function dishCard(page: Page, name: string): Locator {
  return page.locator('a[href^="/menu/"]').filter({ hasText: name })
}
