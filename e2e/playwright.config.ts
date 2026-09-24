import { defineConfig, devices } from '@playwright/test'
import { STORAGE_STATE } from './constants'

/**
 * Teremu E2E — runs against the live Vite dev server + Firebase emulators.
 *
 * Prerequisites (before running):
 *   1. Firebase emulators up:  cd firebase && npm run emulators
 *   2. Vite dev server:        cd app && npm run dev
 *
 * OR let Playwright auto-start Vite via the webServer config below
 * (emulators must still be running separately). `npm run test:e2e` at the
 * repo root handles both: it boots the emulators too if they're down.
 */
export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  fullyParallel: false, // sequential — tests build state for each other
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1, // single worker: tests share one restaurant (no seed, flows build data)
  reporter: process.env.CI ? 'github' : [['list'], ['html', { open: 'never' }]],

  // OCR runs in a background Storage trigger; a scan spec waits on it.
  timeout: 90_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: 'http://localhost:5173',
    // The app picks its locale from localStorage only, defaulting to `es`
    // (app/src/i18n/index.ts) — so the UI is Spanish regardless of what
    // Playwright reports. These are pinned anyway so date/number
    // rendering and "today" boundaries behave identically on any machine;
    // Spain is the first launch market (docs/business-model.md).
    locale: 'es-ES',
    timezoneId: 'Europe/Madrid',
    // retain-on-failure, not on-first-retry: local runs have retries=0, so
    // on-first-retry would NEVER record a trace. A trace is the richest
    // failure artifact there is (DOM snapshots, network, console per
    // action) — view with:
    //   node node_modules/@playwright/test/cli.js show-trace <trace.zip>
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    // Auth setup — runs first, saves storageState for the other projects.
    // Matched by testMatch; the default testMatch (*.spec.ts) means the
    // chromium/mobile projects never pick this file up.
    {
      name: 'setup',
      testMatch: /.*\.setup\.ts/,
      use: {
        video: { mode: 'on', size: { width: 1280, height: 720 } },
      },
    },

    // Desktop (Chromium)
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        storageState: STORAGE_STATE,
        video: { mode: 'on', size: { width: 1280, height: 720 } },
      },
      dependencies: ['setup'],
    },

    // Mobile (Pixel 7). Runs the same specs against the SAME restaurant,
    // so specs MUST namespace everything they create with the project name
    // (see unique() in flows/data.ts) — otherwise the second pass trips
    // strict-mode on duplicate names and the API rejects the duplicate
    // ingredient outright.
    {
      name: 'mobile',
      use: {
        ...devices['Pixel 7'],
        storageState: STORAGE_STATE,
        video: { mode: 'on', size: { width: 412, height: 915 } },
      },
      dependencies: ['setup'],
    },
  ],

  // Auto-start the Vite dev server if it isn't already running.
  // stdout/stderr are piped through (prefixed [WebServer]) so the boot is
  // visible instead of hanging silently, and the timeout allows a cold
  // start on a slow machine.
  webServer: {
    command: 'npm run dev',
    cwd: '../app',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
