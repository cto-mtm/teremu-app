/**
 * An empty Triage invites the owner to connect an inbox
 * (docs/email-quota-paywall-plan.md Phase 5): the button starts the same
 * OAuth round trip as Settings, and the callback lands on Settings with
 * the email card focused and its first check running.
 *
 * Same shape as tests/settings/email.spec.ts: a FRESH location (an empty
 * queue, and an inbox feeds one restaurant), desktop only (the location
 * switcher is in the sidebar), and the fake inbox disconnected at the end
 * so the other email specs can connect it.
 */
import { test, expect } from '../../fixtures'
import { unique } from '../../flows/data'

test.describe('Triage: connect an inbox from the empty queue', () => {
  test.skip(({ isMobile }) => !!isMobile, 'desktop-only: the location switcher is in the sidebar')

  test('offers the inbox when the queue is empty and lands on the email card', async ({ page }, testInfo) => {
    test.slow()
    const location = unique(testInfo, 'Sucursal Bandeja')

    await page.goto('/')
    await page.getByRole('button', { name: 'Ubicación actual' }).click()
    await page.getByRole('button', { name: 'Añadir ubicación' }).click()
    await page.getByPlaceholder('Nombre de la ubicación').fill(location)
    await page.getByRole('button', { name: 'Crear' }).click()
    await expect(page.getByRole('button', { name: 'Ubicación actual' })).toContainText(location)

    // A new location's owner is sent to "find your restaurant" first.
    await page.goto('/triage')
    await expect(page).toHaveURL(/\/setup\/restaurant$/, { timeout: 15_000 })
    await page.getByRole('button', { name: 'Prefiero empezar de cero' }).click()
    await page.goto('/triage')

    // ── The empty queue's prompt ──
    await expect(page.getByText('¿Te llegan facturas por correo? Conéctalo y entran solas en Revisar.')).toBeVisible()
    await page.getByRole('button', { name: 'Conectar Gmail' }).click()

    // ── Back on Settings, at the email card, with its first check running ──
    await page.waitForURL(/\/settings/, { timeout: 20_000 })
    await expect(page.locator('#card-email')).toHaveClass(/ring-2/)
    const card = page.locator('.card').filter({ hasText: 'Facturas por correo' })
    await expect(card.getByText('Correo conectado: fake-inbox@restaurante.test.')).toBeVisible({ timeout: 15_000 })
    await expect(card.getByRole('status').filter({ hasText: 'Revisando tus correos…' })).toBeVisible({ timeout: 15_000 })
    await expect(card.getByText(/Al día: \d+ correos revisados\./)).toBeVisible({ timeout: 90_000 })

    // ── Free the fake inbox for the other email specs ──
    page.once('dialog', (d) => void d.accept())
    await card.getByRole('button', { name: 'Desconectar' }).click()
    await expect(card.getByRole('button', { name: 'Conectar Gmail' })).toBeVisible()
  })
})
