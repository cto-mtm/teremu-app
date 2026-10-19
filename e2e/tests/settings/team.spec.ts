/**
 * Team: per-area permissions, end to end. The owner invites a cook by
 * Google email; the cook signs in through the emulator picker, joins the
 * owner's restaurant (no stray restaurant of their own), and sees only the
 * areas they were granted. The owner then removes them.
 *
 * Members are a Pro feature (free = owner only), so the spec puts the
 * restaurant on Pro itself — plan state is shared and spec order is not
 * guaranteed (flows/plan.flow.ts).
 */
import { test, expect, suppressMobileLauncher } from '../../fixtures'
import type { Page } from '@playwright/test'
import { signInWithGoogle } from '../../flows/auth.flow'
import { setPlanEverywhere } from '../../flows/plan.flow'

/** A select in the INVITE form (the last block — member rows sit above it). */
const inviteLevel = (page: Page, area: string) =>
  page.locator('label').filter({ hasText: area }).locator('select').last()

test.describe('Team', () => {
  test('free plan refuses a member invite', async ({ page }, testInfo) => {
    await setPlanEverywhere('free')
    await page.goto('/settings')
    await expect(page.getByText('Equipo', { exact: true })).toBeVisible()

    await page.getByPlaceholder('Correo de Google').fill(`nobody-${testInfo.project.name}@test.teremu`)
    const alert = new Promise<string>((resolve) =>
      page.once('dialog', (d) => {
        resolve(d.message())
        void d.accept()
      }),
    )
    await page.getByRole('button', { name: 'Invitar' }).click()
    expect(await alert).toBe('Tu plan no permite más miembros — mejora a Pro.')
    await expect(page.getByText('Invitación pendiente')).toHaveCount(0)
  })

  test('an invited cook joins with read-only pantry and no triage, then is removed', async ({ page, browser }, testInfo) => {
    test.slow() // a second browser context + a second sign-in
    await setPlanEverywhere('pro')
    const cook = { email: `e2e-cook-${testInfo.project.name}@test.teremu`, displayName: `E2E Cook ${testInfo.project.name}` }

    // ── Owner invites: scan off, pantry read, triage none ──
    await page.goto('/settings')
    await page.getByPlaceholder('Correo de Google').fill(cook.email)
    const scan = page.locator('label').filter({ hasText: 'Escanear' }).getByRole('checkbox').last()
    await scan.uncheck()
    await inviteLevel(page, 'Despensa').selectOption('read')
    await inviteLevel(page, 'Triaje').selectOption('none')
    await inviteLevel(page, 'Menú').selectOption('read')
    await page.getByRole('button', { name: 'Invitar' }).click()
    const pending = page.locator('div').filter({ hasText: cook.email }).filter({ hasText: 'Invitación pendiente' }).last()
    await expect(pending).toBeVisible()

    // ── The cook signs in, in their own browser context ──
    const context = await browser.newContext({ ...testInfo.project.use, storageState: undefined })
    await suppressMobileLauncher(context)
    const cookPage = await context.newPage()
    try {
      await signInWithGoogle(cookPage, cook)
      // Joining someone else's restaurant skips "find your restaurant";
      // the first-login tour may open over the landing page.
      await expect(cookPage).not.toHaveURL(/\/setup\/restaurant/)
      const skipTour = cookPage.getByRole('button', { name: 'Omitir' })
      if (await skipTour.isVisible({ timeout: 5_000 }).catch(() => false)) await skipTour.click()

      // Pantry: readable, not editable.
      await cookPage.goto('/pantry')
      await expect(cookPage).toHaveURL(/\/pantry$/)
      await expect(cookPage.getByRole('button', { name: '+ Ingrediente' })).toHaveCount(0)

      // Triage: no access — the router sends them somewhere they may go.
      await cookPage.goto('/triage')
      await expect(cookPage).not.toHaveURL(/\/triage/)

      // Settings: no team management for a member.
      await cookPage.goto('/settings')
      await expect(cookPage.getByRole('heading', { name: 'Ajustes' })).toBeVisible()
      await expect(cookPage.getByText('Equipo', { exact: true })).toHaveCount(0)
    } finally {
      await context.close()
    }

    // ── Owner sees a member now, and removes them ──
    await page.reload()
    // The row = the smallest block holding the email, the role and its Quitar.
    const member = page
      .locator('div')
      .filter({ hasText: cook.email })
      .filter({ has: page.getByRole('button', { name: 'Quitar' }) })
      .last()
    await expect(member).toContainText('Miembro')
    page.once('dialog', (d) => void d.accept())
    await member.getByRole('button', { name: 'Quitar' }).click()
    await expect(page.getByText(cook.email)).toHaveCount(0)
  })
})
