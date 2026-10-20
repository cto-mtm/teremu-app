/**
 * Locations + POS. A new location starts empty and becomes the active one;
 * on Pro it can connect a POS through the full OAuth round trip (the
 * offline mock provider in the emulator: consent → posOauthCallback →
 * back to /settings → pick the POS location), sync the POS catalog into
 * the product-review queue, and disconnect.
 *
 * Runs in a FRESH location on purpose: the mock POS locations sell in EUR
 * and MXN, and a location's base currency locks once it holds approved
 * documents — which the shared default location does after the scan specs.
 *
 * Desktop only: the location switcher lives in the sidebar, which is an
 * off-canvas drawer on phones.
 */
import { test, expect } from '../../fixtures'
import { unique } from '../../flows/data'
import { setPlanEverywhere } from '../../flows/plan.flow'

test.describe('Locations & POS', () => {
  test.skip(({ isMobile }) => !!isMobile, 'desktop-only: the location switcher is in the sidebar')

  test('a new location connects a POS, syncs its catalog and disconnects', async ({ page }, testInfo) => {
    test.slow()
    const location = unique(testInfo, 'Sucursal Centro')

    // ── Add a location from the sidebar switcher → it becomes active ──
    await page.goto('/')
    await page.getByRole('button', { name: 'Ubicación actual' }).click()
    await page.getByRole('button', { name: 'Añadir ubicación' }).click()
    await page.getByPlaceholder('Nombre de la ubicación').fill(location)
    await page.getByRole('button', { name: 'Crear' }).click()
    await expect(page.getByRole('button', { name: 'Ubicación actual' })).toContainText(location)

    // POS is Pro, per location; the new location starts on Free.
    await setPlanEverywhere('pro')
    await page.goto('/settings')

    // A fresh location's currency is still unlocked: match the POS (EUR).
    const currency = page.getByLabel('Moneda base')
    await expect(currency).toBeEnabled()
    // A new location may already default to EUR (region prefill) — then
    // there is no change event and nothing to save.
    if ((await currency.inputValue()) !== 'EUR') {
      const saved = page.waitForResponse((r) => /\/api\/restaurants\/[^/]+$/.test(r.url()) && r.request().method() === 'PUT')
      await currency.selectOption('EUR')
      expect((await saved).ok(), 'the base currency was saved').toBe(true)
    }
    await expect(currency).toHaveValue('EUR')

    // ── Connect: a real redirect round trip through the callback function ──
    const pos = page.locator('.card').filter({ hasText: 'Punto de venta (TPV)' })
    await pos.getByRole('button', { name: 'Conectar' }).click()
    await page.waitForURL(/\/settings/, { timeout: 20_000 })
    const picker = pos.getByLabel('Local del TPV')
    await expect(picker).toBeVisible({ timeout: 15_000 })
    // The picker shows each POS location with its currency.
    await picker.selectOption({ label: 'Demo — Centro (EUR)' })
    await pos.getByRole('button', { name: 'Guardar' }).click()
    await expect(pos.getByText('Conectado a Demo — Centro')).toBeVisible()

    // ── Product review: sync the POS catalog into the queue ──
    await pos.getByRole('link', { name: /Revisar productos del TPV/ }).click()
    await expect(page).toHaveURL(/\/integrations\//)
    await page.getByRole('button', { name: 'Sincronizar catálogo' }).click()
    await expect(page.getByText('Croquetas de jamón')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('button', { name: /^Sin vincular \([1-9]\d*\)$/ })).toBeVisible()

    // ── Disconnect (confirm) ──
    await page.goto('/settings')
    page.once('dialog', (d) => void d.accept())
    await pos.getByRole('button', { name: 'Desconectar' }).click()
    await expect(pos.getByRole('button', { name: 'Conectar' })).toBeVisible()
    await expect(pos.getByText('Conectado a Demo — Centro')).toHaveCount(0)
  })
})
