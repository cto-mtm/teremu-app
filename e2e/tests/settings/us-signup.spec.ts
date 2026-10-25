/**
 * A US owner's first run (docs/us-market-readiness.md A1/A5): an en-US
 * browser in a US timezone signs in FRESH and gets English on first paint,
 * imperial units offered first, and dollar money — without touching a
 * single setting. The shared storageState owner is Spanish by project
 * locale (playwright.config.ts), so this spec pins its own.
 */
import { test, expect } from '../../fixtures'
import { signInWithGoogle } from '../../flows/auth.flow'

test.use({
  storageState: { cookies: [], origins: [] },
  locale: 'en-US',
  timezoneId: 'America/Chicago',
})

test('a US sign-up lands in English with imperial units and dollars', async ({ page }, testInfo) => {
  const slug = testInfo.project.name.replace(/\W+/g, '-')

  // First paint, signed out: the browser language decides.
  await page.goto('/login')
  await expect(page.getByRole('heading', { name: 'Welcome to Teremu' })).toBeVisible()
  await expect(page.getByText(/By signing in you agree to the/)).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  // Vite normalises the relative href; what matters is the English manifest, not the Spanish one.
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', /(^|\/)manifest\.webmanifest$/)

  await signInWithGoogle(page, { email: `us-${slug}-${Date.now()}@test.teremu`, displayName: 'US Owner' })

  // A new owner is offered "find your restaurant"; this one starts from scratch.
  await expect(page).toHaveURL(/\/setup\/restaurant$/, { timeout: 20_000 })
  await page.getByRole('button', { name: "I'd rather start from scratch" }).click()

  // The device region prefilled US + the local zone, so the country pack is
  // the US one: imperial units are offered before the device picks anything.
  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  const imperial = page.getByRole('button', { name: 'Imperial', exact: true })
  await expect(imperial).toBeVisible()
  await expect(imperial).toHaveClass(/bg-ink/)
  await expect(page.getByRole('button', { name: 'Metric', exact: true })).not.toHaveClass(/bg-ink/)

  // Menu prices are pre-tax in the US: the tax card says so by default.
  await expect(page.getByText('Menu price tax')).toBeVisible()
  await expect(page.getByText(/Default for your country: Menu prices exclude tax/)).toBeVisible()

  // Money renders in dollars: the labor-rate card shows the base currency's symbol.
  await expect(page.getByText('$/hour')).toBeVisible()
})
