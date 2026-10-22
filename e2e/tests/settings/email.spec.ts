/**
 * Email invoice import (docs/email-ingestion.md): connect an inbox in
 * Settings through the full OAuth round trip (the offline fake inbox in
 * the emulator: consent → emailOauthCallback → back to /settings),
 * "check now" reads its last 31 days and brings the first invoices into
 * Triage with their source badge and sender line, then disconnect.
 *
 * Runs in a FRESH location on purpose: an inbox feeds exactly one
 * restaurant, and the fake inbox is a single account — the shared default
 * location must not hold it. Desktop only: the location switcher lives in
 * the sidebar (an off-canvas drawer on phones), and one project connecting
 * keeps the account free for the run. The extraction is the offline mock,
 * so assertions stay structural (README "Structural assertions on OCR").
 */
import { test, expect } from '../../fixtures'
import { unique } from '../../flows/data'

test.describe('Email import', () => {
  test.skip(({ isMobile }) => !!isMobile, 'desktop-only: the location switcher is in the sidebar')

  test('connects an inbox, brings its invoices into Triage and disconnects', async ({ page }, testInfo) => {
    test.slow()
    const location = unique(testInfo, 'Sucursal Correo')

    // ── A fresh location becomes the active one ──
    await page.goto('/')
    await page.getByRole('button', { name: 'Ubicación actual' }).click()
    await page.getByRole('button', { name: 'Añadir ubicación' }).click()
    await page.getByPlaceholder('Nombre de la ubicación').fill(location)
    await page.getByRole('button', { name: 'Crear' }).click()
    await expect(page.getByRole('button', { name: 'Ubicación actual' })).toContainText(location)

    // ── Connect: a real redirect round trip through the callback function ──
    await page.goto('/settings')
    const card = page.locator('.card').filter({ hasText: 'Facturas por correo' })
    await card.getByRole('button', { name: 'Conectar Gmail' }).click()
    await page.waitForURL(/\/settings/, { timeout: 20_000 })
    await expect(card.getByText('Correo conectado: fake-inbox@restaurante.test.')).toBeVisible({ timeout: 15_000 })
    await expect(card.getByText('fake-inbox@restaurante.test', { exact: true })).toBeVisible()

    // ── The first check starts by itself: a loader with a running count,
    //    then a plain "up to date" once the 31 days and the imports are done ──
    await expect(card.getByRole('status').filter({ hasText: 'Revisando tus correos…' })).toBeVisible({ timeout: 15_000 })
    await expect(card.getByText(/Al día: \d+ correos revisados\./)).toBeVisible({ timeout: 90_000 })
    await expect(card.getByText(/\d+ facturas encontradas\./)).toBeVisible()
    await expect(card.getByText('Revisión terminada.')).toBeVisible()

    // ── Triage: emailed documents carry their source ──
    // A new location's owner is sent to "find your restaurant" first
    // (docs/restaurant-listing.md); Settings is exempt, Triage is not.
    await page.goto('/triage')
    await expect(page).toHaveURL(/\/setup\/restaurant$/, { timeout: 15_000 })
    await page.getByRole('button', { name: 'Prefiero empezar de cero' }).click()
    await page.goto('/triage')
    const emailed = page.getByRole('link').filter({ hasText: '📧 Correo' })
    await expect(emailed.first()).toBeVisible({ timeout: 15_000 })
    await emailed.first().click()
    await expect(page.getByText(/Llegó por correo · /)).toBeVisible()

    // ── Disconnect (confirm): the invoices stay, the inbox is free again ──
    await page.goto('/settings')
    page.once('dialog', (d) => void d.accept())
    await card.getByRole('button', { name: 'Desconectar' }).click()
    await expect(card.getByRole('button', { name: 'Conectar Gmail' })).toBeVisible()
    await expect(card.getByText('fake-inbox@restaurante.test', { exact: true })).toHaveCount(0)
  })
})
