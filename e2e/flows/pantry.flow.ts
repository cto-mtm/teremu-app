/**
 * Pantry flow — reusable helpers for creating ingredients and reading
 * their theoretical stock off the list.
 */
import { expect, type Locator, type Page } from '@playwright/test'

export interface IngredientData {
  name: string
  /** Spanish unit LABEL as rendered by the select (common.unit.*): kg, g,
   *  L, ml, unidad… Defaults to the form's own default (kg). */
  unit?: string
  /** Spanish category LABEL (common.category.*). Defaults to "Otros". */
  category?: string
  /** Optional seed price/stock — normally these fill themselves as
   *  invoices are approved, but a margin spec needs a price up front. */
  price?: number
  stock?: number
}

/**
 * Create an ingredient through the pantry's "+ Ingrediente" sheet.
 * Assumes the owner is signed in. Resolves once the row is on the list.
 */
export async function createIngredient(page: Page, data: IngredientData): Promise<void> {
  await page.goto('/pantry')
  await page.getByRole('button', { name: '+ Ingrediente' }).click()
  await expect(page.getByRole('heading', { name: 'Nuevo ingrediente' })).toBeVisible()

  await page.getByPlaceholder('Nombre').fill(data.name)
  if (data.unit) {
    // exact: getByLabel is a case-insensitive SUBSTRING match, and the
    // price field's label ("Precio por unidad (opcional)") contains it.
    await page.getByLabel('Unidad', { exact: true }).selectOption({ label: data.unit })
  }
  if (data.category) {
    await page.getByLabel('Todas las categorías').selectOption({ label: data.category })
  }
  if (data.price !== undefined) {
    await page.getByLabel(/Precio por unidad/).fill(String(data.price))
  }
  if (data.stock !== undefined) {
    await page.getByLabel(/Existencias iniciales/).fill(String(data.stock))
  }

  await page.getByRole('button', { name: 'Guardar' }).click()
  await expect(page.getByRole('heading', { name: 'Nuevo ingrediente' })).toBeHidden()
  await expect(ingredientRow(page, data.name)).toBeVisible()
}

/** The pantry list row for an ingredient (the link half of it). */
export function ingredientLink(page: Page, name: string): Locator {
  return page.locator('a[href^="/pantry/"]').filter({ hasText: name })
}

/**
 * The whole row: the link plus the tap-to-true-up quantity button, which
 * is the link's SIBLING (a button inside an <a> would be invalid HTML).
 * Hence the parent hop — there is no shared test id to anchor on.
 */
export function ingredientRow(page: Page, name: string): Locator {
  return ingredientLink(page, name).locator('xpath=..')
}

/** The tap-to-true-up quantity control — the row's only button. */
export function stockButton(page: Page, name: string): Locator {
  return ingredientRow(page, name).getByRole('button')
}

/** Theoretical stock as the row renders it, as a number. */
export async function readStock(page: Page, name: string): Promise<number> {
  const text = (await stockButton(page, name).innerText()).trim()
  // "12,5 kg" / "12,5kg" → 12.5 (the app renders in `es`: comma decimal,
  // dot thousands). Number and unit are separate elements with no space
  // between them, so innerText can glue them together — read the leading
  // number only.
  const numeric = text.match(/^-?[\d.,]+/)?.[0] ?? ''
  const value = numeric ? Number(numeric.replace(/\./g, '').replace(',', '.')) : NaN
  expect(Number.isFinite(value), `stock for "${name}" parsed from "${text}"`).toBe(true)
  return value
}

/** Overwrite theoretical stock with a physical count (tap the quantity). */
export async function trueUp(page: Page, name: string, qty: number): Promise<void> {
  await stockButton(page, name).click()
  const input = page.getByLabel('Conteo físico')
  await expect(input).toBeVisible()
  await input.fill(String(qty))
  await input.press('Enter')
  await expect(input).toBeHidden()
}
