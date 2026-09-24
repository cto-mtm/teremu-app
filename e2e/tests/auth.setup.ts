/**
 * Auth setup project — signs in as the owner through the Auth emulator's
 * Google picker, walks the first-login tour, and saves the authenticated
 * storageState so every other test starts already signed in.
 *
 * This IS the onboarding test. It verifies the whole cold-start path a
 * brand-new restaurant takes — sign in → server bootstraps the workspace
 * (tenancy.ts) → tour → dashboard — while producing the auth state the
 * rest of the suite consumes.
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

  // ── 2. First authed call bootstraps the restaurant; the tour opens ──
  // (The login page's h1 says the same thing, hence level: 2 — by now we
  // are on the dashboard with the wizard over it.)
  const tour = page.getByRole('heading', { name: 'Bienvenido a Teremu', level: 2 })
  await expect(tour).toBeVisible({ timeout: 20_000 })

  // ── 3. Walk all five beats, then finish ──
  for (const step of ['Escanea sin frenar', 'Márgenes y despensa, solos', 'Tu equipo y tu asistente', 'Empieza gratis']) {
    await page.getByRole('button', { name: 'Siguiente' }).click()
    await expect(page.getByRole('heading', { name: step, level: 2 })).toBeVisible()
  }
  // The last step shows the plan ladder with the free plan marked current.
  await expect(page.getByText('Tu plan actual')).toBeVisible()
  await page.getByRole('button', { name: 'Empezar' }).click()
  await expect(tour).toBeHidden()

  // ── 4. Land on the dashboard as a fresh, empty workspace ──
  await expect(page.getByRole('heading', { name: 'Panel de control' })).toBeVisible()
  await expect(page).toHaveURL(/\/$/)

  // ── 5. Save authenticated state ──
  // indexedDB: true is ESSENTIAL — Firebase Auth keeps its session in
  // IndexedDB, which storageState skips by default. Without it every
  // "authenticated" test silently starts signed out on the login page.
  // localStorage rides along by default, which is what carries the
  // `teremu-onboarded:<uid>` flag set above so the tour stays closed.
  await page.context().storageState({ path: STORAGE_STATE, indexedDB: true })
})
