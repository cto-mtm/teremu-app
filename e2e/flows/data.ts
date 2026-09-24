/**
 * Per-project test data naming.
 *
 * The chromium and mobile projects run the same specs against the SAME
 * restaurant (one emulator, one owner, one workspace). Anything a spec
 * creates therefore has to be namespaced, or the second pass either trips
 * Playwright's strict mode on two matching rows or — for ingredients,
 * which the API keys by normalized name — gets a flat 409 `exists`.
 *
 * Every name a spec types into the app goes through unique().
 */
import type { TestInfo } from '@playwright/test'

/** `unique(testInfo, 'Tomate')` → `Tomate E2E chromium`. */
export function unique(testInfo: TestInfo, base: string): string {
  return `${base} E2E ${testInfo.project.name}`
}
