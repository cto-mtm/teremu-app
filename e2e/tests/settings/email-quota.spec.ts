/**
 * The email import at Free's limit (docs/email-quota-paywall-plan.md):
 * an inbox connected with the month's 25 documents already spent finds
 * its invoices and holds them — the email card, Triage and the pricing
 * page all say how many wait — and an upgrade lets them in at once.
 *
 * Same shape as email.spec.ts: a FRESH location (an inbox feeds one
 * restaurant, and the fake inbox is a single account), desktop only (the
 * location switcher is in the sidebar), structural assertions on OCR,
 * and the inbox disconnected at the end so the other spec can connect it.
 * Only this location's meter is capped: the shared default location
 * keeps scanning for every other spec. The upgrade goes through the dev
 * "Cambiar plan" button — PUT /billing/plan runs the plan-change hook,
 * which a plan written straight to Firestore (setPlanEverywhere) would not.
 */
import { test, expect } from '../../fixtures'
import { unique } from '../../flows/data'
import { setPlanEverywhere, setScanUsageEverywhere } from '../../flows/plan.flow'

test.describe('Email import at the plan limit', () => {
  test.skip(({ isMobile }) => !!isMobile, 'desktop-only: the location switcher is in the sidebar')

  test('holds the invoices at the cap, says so everywhere, and lets them in on upgrade', async ({ page }, testInfo) => {
    test.slow()
    await setPlanEverywhere('free')
    const location = unique(testInfo, 'Sucursal Límite')

    // ── A fresh location, its month's documents already spent ──
    await page.goto('/')
    await page.getByRole('button', { name: 'Ubicación actual' }).click()
    await page.getByRole('button', { name: 'Añadir ubicación' }).click()
    await page.getByPlaceholder('Nombre de la ubicación').fill(location)
    await page.getByRole('button', { name: 'Crear' }).click()
    await expect(page.getByRole('button', { name: 'Ubicación actual' })).toContainText(location)
    await setScanUsageEverywhere(25, location)

    // ── Connect: the first check finds the invoices and holds them ──
    await page.goto('/settings')
    const card = page.locator('.card').filter({ hasText: 'Facturas por correo' })
    await card.getByRole('button', { name: 'Conectar Gmail' }).click()
    await page.waitForURL(/\/settings/, { timeout: 20_000 })
    const notice = card.getByRole('alert').filter({ hasText: '7 facturas esperando en tu correo.' })
    await expect(notice).toBeVisible({ timeout: 90_000 })
    await expect(notice).toContainText('Con Pro entran hoy.')
    await expect(card.getByText('Revisado: las facturas nuevas esperan a que tu plan tenga hueco.')).toBeVisible()
    await expect(card.getByText('Revisión terminada.')).toHaveCount(0)
    // The Plan card says it too, beside the upgrade button.
    await expect(page.locator('#card-plan').getByText('7 facturas esperando en tu correo.')).toBeVisible()

    // ── Triage: the banner where the invoices would land ──
    // A new location's owner is sent to "find your restaurant" first.
    await page.goto('/triage')
    await expect(page).toHaveURL(/\/setup\/restaurant$/, { timeout: 15_000 })
    await page.getByRole('button', { name: 'Prefiero empezar de cero' }).click()
    await page.goto('/triage')
    await expect(page.getByRole('alert').filter({ hasText: '7 facturas esperando en tu correo.' })).toBeVisible()

    // ── Pricing, from the notice: why the owner is here, and email in each plan ──
    await page.goto('/settings')
    await notice.getByRole('link', { name: 'Ver planes', exact: true }).click()
    await expect(page).toHaveURL(/\/pricing\?reason=email_quota/)
    await expect(page.getByText('Tienes 7 facturas esperando en tu correo. Con Pro entran hoy y tienes 500 documentos al mes.')).toBeVisible()
    await expect(page.getByText('Facturas por correo: 1 buzón, una revisión al día')).toBeVisible()
    await expect(page.getByText('Facturas por correo cada 6 horas')).toBeVisible()
    await expect(page.getByText('Hasta 3 buzones de correo')).toBeVisible()

    // ── Back to the email card by its deep link (where checkout returns) ──
    await page.goto('/settings?card=email')
    await expect(page.locator('#card-email')).toHaveClass(/ring-2/)
    await expect(page).toHaveURL(/\/settings$/)

    // ── Upgrade with the card open: the backlog comes in, in front of the owner ──
    await page.locator('#card-plan').getByRole('button', { name: 'Cambiar plan (dev)' }).click()
    await expect(card.getByText(/^Tu plan creció: \d+ facturas importadas\.$/)).toBeVisible({ timeout: 90_000 })
    await expect(card.getByRole('alert')).toHaveCount(0)
    await expect(page.locator('#card-plan').getByText(/facturas esperando en tu correo/)).toHaveCount(0)

    // ── Triage: the documents, and no banner ──
    await page.goto('/triage')
    await expect(page.getByRole('link').filter({ hasText: '📧 Correo' }).first()).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('alert').filter({ hasText: 'facturas esperando' })).toHaveCount(0)

    // ── Free the fake inbox for email.spec.ts ──
    await page.goto('/settings')
    page.once('dialog', (d) => void d.accept())
    await card.getByRole('button', { name: 'Desconectar' }).click()
    await expect(card.getByRole('button', { name: 'Conectar Gmail' })).toBeVisible()
  })
})
