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

  // No inbox yet: the done screen offers one, honest about Free's cap and
  // about which account it can be.
  await expect(page.getByText('¿Te llegan facturas por correo? Conéctalo y entran solas.')).toBeVisible()
  await expect(page.getByText('Gratis incluye 25 documentos al mes; el resto espera a que mejores tu plan.', { exact: false })).toBeVisible()
  await expect(page.getByText('Puede ser otra cuenta distinta de la que usas para entrar.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Conectar Gmail' })).toBeVisible()

  // The new dishes have prices but no recipes: the next step drafts them,
  // in place, with the menu wizard seeded from the imported dishes.
  await page.getByRole('button', { name: /Estimar recetas/ }).click()
  await expect(page).toHaveURL(/\/menu$/)
  const wizard = page.getByRole('heading', { name: 'Recetas de tu carta importada', level: 2 })
  await expect(wizard).toBeVisible()
  await expect(page.getByText('Paella de marisco').first()).toBeVisible()
  await expect(page.getByText('Tarta de queso').first()).toBeVisible()

  // This owner never saw the first-login tour: it waits for the wizard
  // instead of stacking on top of it…
  const tour = page.getByRole('heading', { name: 'Bienvenido a Teremu', level: 2 })
  await expect(tour).toBeHidden()
  await page.getByRole('button', { name: 'Cancelar' }).first().click()
  await expect(wizard).toBeHidden()
  // …and opens once it's closed.
  await expect(tour).toBeVisible()
  await page.getByRole('button', { name: 'Omitir' }).click()

  // The imported dishes are on the menu, the "needs recipes" banner offers
  // the wizard again, and search/sort are still there next to it.
  await expect(page.getByText('7 platos importados aún no tienen receta.')).toBeVisible()
  await expect(page.getByPlaceholder('Buscar')).toBeVisible()
  await expect(page.getByText('Paella de marisco').first()).toBeVisible()
})
