/**
 * Plans: the pricing page reflects the restaurant's plan, and the POS
 * card tells Free about its cap (hourly sync, no AI matching) while still
 * letting it connect — the cap is the upgrade nudge, not a gate.
 *
 * Billing is not configured in the emulator, so "upgrade" ends in the
 * checkout placeholder — the spec asserts that hand-off, not a payment.
 * Plan state is shared across specs, so each test sets the plan it needs
 * (flows/plan.flow.ts).
 */
import { test, expect } from '../../fixtures'
import { setPlanEverywhere } from '../../flows/plan.flow'

test.describe('Pricing & plan gates', () => {
  test('Free: marked current, monthly/yearly prices, upgrade hands off to checkout', async ({ page }) => {
    await setPlanEverywhere('free')
    await page.goto('/pricing')
    await expect(page.getByRole('heading', { name: 'Planes', level: 1 })).toBeVisible()

    const freeCard = page.locator('.card').filter({ hasText: 'para siempre' })
    await expect(freeCard.getByText('Tu plan')).toBeVisible()

    await expect(page.getByText('$39', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: /^Anual/ }).click()
    await expect(page.getByText('$390', { exact: true })).toBeVisible()
    await expect(page.getByText('≈ $32.50/mes, facturado al año')).toBeVisible()

    const dialog = new Promise<string>((resolve) =>
      page.once('dialog', (d) => {
        resolve(d.message())
        void d.accept()
      }),
    )
    await page.getByRole('button', { name: 'Mejorar a Pro' }).click()
    expect(await dialog).toContain('Los pagos aún no están configurados')
  })

  test('Free sees the POS cap and can still connect; Pro has no cap note', async ({ page }) => {
    await setPlanEverywhere('free')
    await page.goto('/settings')
    const pos = page.locator('.card').filter({ hasText: 'Punto de venta (TPV)' })
    const capNote = pos.getByText(/^Plan Free: las ventas se actualizan cada hora/)
    await expect(capNote).toBeVisible()
    await expect(capNote.getByRole('link', { name: 'Ver planes y funciones' })).toBeVisible()
    await expect(pos.getByRole('button', { name: 'Conectar' })).toBeVisible()

    await setPlanEverywhere('pro')
    await page.reload()
    await expect(pos.getByRole('button', { name: 'Conectar' })).toBeVisible()
    await expect(pos.getByText(/^Plan Free:/)).toHaveCount(0)
    await expect(page.locator('.card').filter({ hasText: 'Plan' }).first()).toContainText('Pro')

    await page.goto('/pricing')
    const proCard = page.locator('.card').filter({ hasText: 'Todo lo de Gratis, y además:' })
    await expect(proCard.getByText('Tu plan')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Cambiar de plan' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Mejorar a Pro' })).toHaveCount(0)
  })
})
