import { defineConfig, devices } from '@playwright/test'
import base from './playwright.config'
import { STORAGE_STATE } from './constants'

/**
 * Real-data UI specs — `npm run test:e2e:real`. OPT-IN and never in the
 * deploy gate: they need the gitignored client corpus (docs/samples/real/,
 * see docs/real-samples.md) and skip themselves on machines without it.
 *
 * Flow: the normal auth setup signs the owner in → real.setup.ts seeds the
 * recorded real month into that owner's restaurant (seed-account.ts
 * --emulator, the same code that seeds production) → the specs drive the
 * UI over it and assert against the seed's own summary.
 *
 * Desktop only: the month is seeded once into one restaurant, and the
 * mobile project would review the same documents twice.
 */
export default defineConfig({
  ...base,
  testDir: './',
  // A real month is ~250 documents — Triage renders all of them.
  timeout: 180_000,
  projects: [
    { name: 'setup', testMatch: /tests\/auth\.setup\.ts/ },
    {
      name: 'real-seed',
      testMatch: /tests-real\/real\.setup\.ts/,
      use: { storageState: STORAGE_STATE },
      dependencies: ['setup'],
    },
    {
      name: 'real',
      testMatch: /tests-real\/.*\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        storageState: STORAGE_STATE,
        video: { mode: 'retain-on-failure', size: { width: 1280, height: 720 } },
      },
      dependencies: ['real-seed'],
    },
  ],
})
