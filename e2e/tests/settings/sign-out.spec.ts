/**
 * Sign out lives at the bottom of Settings (it left the nav drawer).
 * Firebase's signOut only clears this test's own browser context, so the
 * shared storageState other specs start from is untouched.
 */
import { test, expect } from '../../fixtures'

test.describe('Sign out', () => {
  test('Settings signs the user out and lands on login', async ({ page }) => {
    await page.goto('/settings')
    await expect(page.getByRole('heading', { name: 'Ajustes' })).toBeVisible()

    await page.getByRole('button', { name: 'Salir', exact: true }).click()

    await expect(page).toHaveURL(/\/login/)
    await expect(page.getByRole('button', { name: /continuar con google/i })).toBeVisible()
  })
})
