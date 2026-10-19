/**
 * "Find your restaurant" — a brand-new owner's first run
 * (docs/restaurant-listing.md). Signs in a FRESH owner (the shared
 * storageState owner already skipped setup), finds their place, lets the
 * import read the listing, the website and the menu, settles a price the
 * website shows twice, and saves — then the dishes are on the Menu page.
 *
 * Runs against the fake Places backend and fixture websites
 * (firebase/functions/src/listing/fake.ts): TEREMU_TEST_MOCKS is set by
 * e2e/run.mjs, so nothing here reaches Google or the internet.
 */
import { test, expect } from '../../fixtures'
import { signInWithGoogle } from '../../flows/auth.flow'

// A signed-out context: this test IS a first sign-in.
test.use({ storageState: { cookies: [], origins: [] } })

test('a new owner imports their restaurant and its menu', async ({ page }, testInfo) => {
  const slug = testInfo.project.name.replace(/\W+/g, '-')
  await signInWithGoogle(page, { email: `listing-${slug}-${Date.now()}@test.teremu`, displayName: 'Listing Owner' })

  // A pending owner lands on setup, not the dashboard.
  await expect(page).toHaveURL(/\/setup\/restaurant$/, { timeout: 20_000 })
  await page.getByRole('searchbox', { name: 'Nombre del restaurante o ciudad' }).fill('faro')
  await page.getByRole('button', { name: /Taberna El Faro/ }).click()

  // Listing → website → menu, then the review screen.
  await expect(page.getByRole('heading', { name: 'Taberna El Faro', level: 1 })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('Encontramos 7 platos')).toBeVisible()

  // The home page lists the paella at an older price: pick the menu's.
  await expect(page.getByText('Tu web muestra dos precios — ¿cuál es el actual?')).toBeVisible()
  await page.getByRole('button', { name: /^18,50\s€$/ }).click()
  await expect(page.getByText('Precios revisados')).toBeVisible()

  await page.getByRole('button', { name: 'Guardar 7 platos' }).click()
  await expect(page.getByRole('heading', { name: '¡Listo!' })).toBeVisible({ timeout: 20_000 })

  // The new dishes have prices but no recipes: the next step drafts them,
  // in place, with the menu wizard seeded from the imported dishes.
  await page.getByRole('button', { name: /Estimar recetas/ }).click()
  await expect(page).toHaveURL(/\/menu$/)
  await expect(page.getByRole('heading', { name: 'Recetas de tu carta importada', level: 2 })).toBeVisible()
  await expect(page.getByText('Paella de marisco').first()).toBeVisible()
  await expect(page.getByText('Tarta de queso').first()).toBeVisible()
})
