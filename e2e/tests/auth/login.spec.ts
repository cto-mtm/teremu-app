/**
 * Login page + route guard — the signed-OUT half of auth.
 * These tests deliberately drop the saved storageState.
 */
import { test, expect } from '@playwright/test'

// Override storageState: these tests must be unauthenticated.
test.use({ storageState: { cookies: [], origins: [] } })

test.describe('Login page', () => {
  test('offers Google as the only way in', async ({ page }) => {
    await page.goto('/login')

    await expect(page.getByRole('heading', { name: 'Bienvenido a Teremu' })).toBeVisible()
    await expect(page.getByText(/Inicia sesión para escanear facturas/)).toBeVisible()
    await expect(page.getByRole('button', { name: /continuar con google/i })).toBeEnabled()
    // No email/password path exists (app/src/lib/firebase.ts) — if one is
    // ever added, this test is the reminder to cover it.
    await expect(page.locator('input[type="password"]')).toHaveCount(0)
  })

  test('sends a signed-out visitor to login and remembers where they were going', async ({ page }) => {
    await page.goto('/pantry')

    // vue-router leaves the slash unencoded; accept either form so an
    // encoding change in the router isn't reported as a guard failure.
    await expect(page).toHaveURL(/\/login\?redirect=(%2F|\/)pantry/)
    await expect(page.getByRole('button', { name: /continuar con google/i })).toBeVisible()
  })

  test('shows the app chrome to nobody', async ({ page }) => {
    await page.goto('/login')

    // The shell hides its nav on bare routes; a signed-out visitor must
    // never see a tab strip they cannot use.
    await expect(page.getByRole('link', { name: 'Despensa' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Salir' })).toHaveCount(0)
  })
})
