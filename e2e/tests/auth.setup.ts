/**
 * Auth setup project — signs in as the owner through the Auth emulator's
 * Google picker, skips "find your restaurant", walks the first-login tour,
 * and saves the authenticated storageState so every other test starts
 * already signed in.
 *
 * This IS the onboarding test. It verifies the whole cold-start path a
 * brand-new restaurant takes — sign in → server bootstraps the workspace
 * (tenancy.ts) → find your restaurant (skipped) → tour → dashboard —
 * while producing the auth state the rest of the suite consumes.
 *
 * The email is a fixed constant: global-setup wipes the Auth emulator
 * before every run, so there is nothing to collide with.
 */
import { test as setup, expect } from '@playwright/test'
import { STORAGE_STATE, TEST_OWNER } from '../constants'
import { signInWithGoogle } from '../flows/auth.flow'

setup('sign in with Google and complete onboarding', async ({ page }) => {
  // ── 1. Sign in through the emulator's fake Google account picker ──
  await signInWithGoogle(page, TEST_OWNER)

  // ── 2. First authed call bootstraps the restaurant, which starts with
  // "find your restaurant" pending (docs/restaurant-listing.md) — a new
  // owner lands there, not on the dashboard, and no tour sits over it ──
  await expect(page).toHaveURL(/\/setup\/restaurant$/, { timeout: 20_000 })
  await expect(page.getByRole('heading', { name: 'Encuentra tu restaurante', level: 1 })).toBeVisible()
  const tour = page.getByRole('heading', { name: 'Bienvenido a Teremu', level: 2 })
  await expect(tour).toBeHidden()

  // Skip it: the rest of the suite works on an empty workspace, and the
  // skip is final (POST /listing/skip) — no spec gets redirected again.
  await page.getByRole('button', { name: 'Prefiero empezar de cero' }).click()

  // ── 3. Now the tour opens, over the dashboard ──
  // (The login page's h1 says the same thing, hence level: 2.)
  await expect(page).toHaveURL(/\/$/)
  await expect(tour).toBeVisible({ timeout: 20_000 })

  // ── 4. Walk all six beats, then finish ──
  // (The email beat shows because the emulator's fake inbox makes email
  // import available and verified — GET /me features.emailImport.)
  for (const step of ['Escanea sin frenar', 'Facturas por correo, sin escanear', 'Márgenes y despensa, solos', 'Tu equipo y tu asistente', 'Empieza gratis']) {
    await page.getByRole('button', { name: 'Siguiente' }).click()
    await expect(page.getByRole('heading', { name: step, level: 2 })).toBeVisible()
  }
  // The last step shows the plan ladder with the free plan marked current.
  await expect(page.getByText('Tu plan actual')).toBeVisible()
  await page.getByRole('button', { name: 'Empezar' }).click()
  await expect(tour).toBeHidden()

  // ── 5. Land on the dashboard as a fresh, empty workspace ──
  await expect(page.getByRole('heading', { name: 'Panel de control' })).toBeVisible()
  await expect(page).toHaveURL(/\/$/)

  // ── 6. Save authenticated state ──
  // indexedDB: true is ESSENTIAL — Firebase Auth keeps its session in
  // IndexedDB, which storageState skips by default. Without it every
  // "authenticated" test silently starts signed out on the login page.
  // localStorage rides along by default, which is what carries the
  // `teremu-onboarded:<uid>` flag set above so the tour stays closed.
  await page.context().storageState({ path: STORAGE_STATE, indexedDB: true })
})
