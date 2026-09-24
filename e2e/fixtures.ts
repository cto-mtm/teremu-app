/**
 * Shared test fixtures. Authenticated specs import { test, expect } from
 * here (instead of '@playwright/test') so every context gets the
 * suppressions below.
 *
 * Two first-run overlays would otherwise sit on top of the app:
 *
 *  1. MobileLauncher — the full-screen hub AppShell auto-opens once per
 *     app session on phones. Its "seen" flag lives in sessionStorage,
 *     which storageState does NOT carry, so EVERY mobile-project test
 *     would open on the launcher instead of the page it navigated to.
 *     Killed here by setting the flag before the app mounts.
 *
 *  2. OnboardingWizard — the first-login tour. Its flag is localStorage
 *     keyed by uid (`teremu-onboarded:<uid>`), which auth.setup.ts sets by
 *     actually finishing the tour; storageState carries localStorage, so
 *     it normally never reappears. dismissOnSight is the belt to that
 *     suspenders: if it ever leaks through (hydration race, a new uid),
 *     "Omitir" closes it instead of failing an unrelated assertion.
 */
import { test as base, expect, type BrowserContext, type Page } from '@playwright/test'

/** Same key AppShell.vue checks before auto-opening the mobile launcher. */
export async function suppressMobileLauncher(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    try {
      sessionStorage.setItem('teremu-launcher-seen', '1')
    } catch {
      /* no-op */
    }
  })
}

/** Auto-skip the first-login tour if it appears despite the saved flag. */
async function dismissOnboarding(page: Page): Promise<void> {
  const skip = page.getByRole('button', { name: 'Omitir' })
  // Non-blocking: if it's visible, click it; if not, move on.
  if (await skip.isVisible({ timeout: 500 }).catch(() => false)) {
    await skip.click()
  }
}

export const test = base.extend({
  context: async ({ context }, use) => {
    await suppressMobileLauncher(context)
    await use(context)
  },
  page: async ({ page }, use) => {
    // After every navigation, close the tour if it leaked through.
    page.on('load', () => dismissOnboarding(page).catch(() => {}))
    await use(page)
  },
})

export { expect }
