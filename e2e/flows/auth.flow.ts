/**
 * Auth flow — signing in through the Firebase Auth emulator's fake Google
 * account picker.
 *
 * Teremu has no email/password path: app/src/lib/firebase.ts only exposes
 * signInWithGoogle() → signInWithPopup. Against the emulator that popup is
 * firebase-tools' own sign-in widget (/emulator/auth/handler), which lists
 * the accounts it already knows and lets you invent a new one. Driving it
 * is the only way to reach the app the way a real user does.
 *
 * The widget is emulator UI, not ours — so its locators are layered: the
 * stable element ids first, a role/text match as the fallback, and a loud
 * error naming THIS file if both miss after a firebase-tools upgrade.
 */
import { expect, type Page } from '@playwright/test'
import { TEST_OWNER } from '../constants'

const WIDGET_HINT =
  'The Auth emulator sign-in widget did not look the way this flow expects.\n' +
  'It ships with firebase-tools, so an upgrade can move its markup — run\n' +
  '`npx playwright test --headed` to see the popup and update the locators\n' +
  'in e2e/flows/auth.flow.ts (nothing in the app changed).'

/**
 * Click "Continuar con Google" on /login and complete the emulator popup.
 * Resolves once the app has left /login — i.e. the SDK has the session and
 * the router has moved on. Callers still decide what to wait for next
 * (the boot loader, the profile, the onboarding tour).
 */
export async function signInWithGoogle(
  page: Page,
  user: { email: string; displayName: string } = TEST_OWNER,
): Promise<void> {
  await page.goto('/login')
  await expect(page.getByRole('heading', { name: 'Bienvenido a Teremu' })).toBeVisible()

  const popupPromise = page.waitForEvent('popup')
  await page.getByRole('button', { name: /continuar con google/i }).click()
  const popup = await popupPromise
  await popup.waitForLoadState('domcontentloaded')

  // Already-known account? The widget lists it as a clickable row; reusing
  // it is what a returning user does and skips the creation form.
  const known = popup.getByText(user.email, { exact: false }).first()
  if (await known.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await known.click()
  } else {
    await addNewAccount(popup, user)
  }

  // The widget posts the credential back and closes itself. Waiting on the
  // APP (not on popup close) is what actually matters, and it avoids a
  // race when the popup is already gone by the time we look.
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 })
}

/** Fill the widget's "add new account" form and submit it. */
async function addNewAccount(
  popup: Page,
  user: { email: string; displayName: string },
): Promise<void> {
  const email = popup.locator('#email-input')

  // With no accounts yet the widget may open straight on the form; with
  // some, it needs the "Add new account" button first.
  if (!(await email.isVisible({ timeout: 1_000 }).catch(() => false))) {
    const addNew = popup
      .locator('#add-account-button, .js-new-account, button:has-text("Add new account")')
      .first()
    if (!(await addNew.isVisible({ timeout: 5_000 }).catch(() => false))) {
      throw new Error(`[e2e] No "Add new account" control in the sign-in popup.\n${WIDGET_HINT}`)
    }
    await addNew.click()
  }

  await expect(email, `[e2e] No email field in the sign-in popup.\n${WIDGET_HINT}`).toBeVisible({
    timeout: 5_000,
  })
  await email.fill(user.email)

  const displayName = popup.locator('#display-name-input')
  if (await displayName.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await displayName.fill(user.displayName)
  }

  const submit = popup.locator('#sign-in, button:has-text("Sign in with")').first()
  if (!(await submit.isVisible({ timeout: 5_000 }).catch(() => false))) {
    throw new Error(`[e2e] No sign-in submit button in the popup.\n${WIDGET_HINT}`)
  }
  await submit.click()
}
