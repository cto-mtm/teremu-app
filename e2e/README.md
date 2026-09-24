# Teremu E2E Tests

End-to-end tests using Playwright. They run against the live Vite dev server +
Firebase emulators — no seed script needed. Teremu bootstraps a solo restaurant
for a caller with no membership on their first authenticated request
(`tenancy.ts`), so `auth.setup.ts` signing in through the UI *is* the seed, and
every spec builds its own state from there (ingredients, dishes, invoices,
sales) through the app.

## Running

```bash
# From the repo root — works with OR without the emulators running:
# if they're up it uses them; if not, it builds shared+functions and boots
# the emulator set one-shot (functions included) via emulators:exec.
npm run test:e2e            # headless
npm run test:e2e:headed     # see the browser
npm run test:e2e:ui         # interactive UI mode (great for debugging)

# Or, with emulators already running, from the e2e/ folder:
npx playwright test
npx playwright test --headed
npx playwright test --ui
npx playwright test --debug   # step through with inspector
```

First time only: `npm install` at the repo root (e2e is a workspace), then
`npx playwright install chromium` to fetch the browser.

For the dev loop, keep the emulators running yourself (`cd firebase &&
npm run emulators`) — the one-shot boot is slow. Playwright auto-starts the
Vite dev server if it isn't already up.

In one-shot mode the console shows results only; the **full raw output**
(including the functions emulator's per-request logs, which are filtered from
the console) streams to `e2e/last-run.log`. `--verbose` adds Playwright's
per-action `pw:api` stream to that file.

## Structure

```
e2e/
├── constants.ts             # test owner, STORAGE_STATE, emulator URLs, samples
├── run.mjs                  # repo-root runner: reuses or one-shot-boots the emulators
├── playwright.config.ts     # projects: setup → chromium + mobile
├── global-setup.ts          # emulator + api reachability check, then data wipe
├── global-teardown.ts       # flattens per-test videos into recordings/
├── fixtures.ts              # suppresses the first-run overlays (see below)
├── flows/                   # DRY reusable flow functions
│   ├── data.ts              # unique() — per-project name namespacing
│   ├── auth.flow.ts         # the Auth emulator's fake Google account picker
│   ├── pantry.flow.ts       # create ingredient, read stock, physical count
│   ├── menu.flow.ts         # create dish (+ recipe lines)
│   └── invoice.flow.ts      # upload receipt → wait for OCR → review + approve
└── tests/
    ├── auth.setup.ts        # sign in + first-login tour → saves storageState
    ├── auth/login.spec.ts   # signed-OUT: login page + route guard
    ├── menu/                # dish costing and target-margin flagging
    ├── pantry/              # manual ingredient creation, physical count
    ├── pulse/               # revenue entry → pantry depletion
    └── scan/                # the golden path: scan → triage → approve
```

## How it works

1. **`global-setup.ts`** checks the Auth/Firestore/Storage emulators *and* that
   the `api` function is actually being served (a functions emulator that failed
   to load the code still answers port 5001), then wipes Auth + Firestore.
2. **`auth.setup.ts`** signs in through the Auth emulator's Google picker →
   server bootstraps the restaurant → walks the onboarding tour → saves the
   session to `STORAGE_STATE` (`playwright/.auth/owner.json`, gitignored).
3. **All other specs** reuse that session (storageState) — they start signed in
   as the owner of one empty restaurant.
4. Specs create their own data through the UI.

### Why sign-in goes through a popup

Teremu has no email/password path — `app/src/lib/firebase.ts` only exposes
`signInWithGoogle()` → `signInWithPopup`. Against the emulator that popup is
**firebase-tools' own** sign-in widget, so `flows/auth.flow.ts` drives it with
layered locators (stable ids first, role/text fallback) and fails with a message
naming that file if a firebase-tools upgrade moves the markup. Nothing in the app
changes when that happens.

### The two overlays fixtures.ts kills

- **MobileLauncher** — AppShell auto-opens the full-screen hub once per app
  session on phones. Its flag lives in `sessionStorage`, which `storageState`
  does **not** carry, so without suppression every mobile-project test would
  open on the launcher. `fixtures.ts` sets `teremu-launcher-seen` before mount.
- **OnboardingWizard** — the first-login tour, flagged in `localStorage` under
  `teremu-onboarded:<uid>`. `auth.setup.ts` finishes the tour for real and
  `storageState` carries the flag; `fixtures.ts` clicks "Omitir" on sight as a
  backstop.

Authenticated specs must therefore import `{ test, expect }` from
`../../fixtures`, not from `@playwright/test`.

## Invariants the specs must keep

- **Per-project names.** The `chromium` and `mobile` projects run the same specs
  against the **same restaurant**. Everything a spec names goes through
  `unique(testInfo, …)` — ingredients are keyed server-side by normalized name,
  so a collision is a flat 409, not just a strict-mode error. The same goes
  for any value a spec later finds by its text: two projects logging the same
  takings on the same day render two identical rows (see `revenue.spec.ts`).
- **One sample receipt per project.** `POST /invoices` refuses bytes the
  restaurant already holds (409 `duplicate_image`). `SAMPLE_RECEIPT` in
  `constants.ts` maps a different `docs/samples/dummy/*.jpg` to each project; a
  new scanning spec needs a new file, not a shared one. Never reach into
  `docs/samples/real/` — that's the gitignored customer corpus.
- **Structural assertions on OCR.** What a scan comes back with depends on the
  emulator: with no LLM key the pipeline falls back to a *randomized* offline
  mock, with one it reads the photo for real. Specs assert that line items
  exist and that approval moved the numbers — never a specific vendor or item.
  The one-shot runner forces the mock via `TEREMU_TEST_MOCKS=1`; a run against
  your own already-running emulators uses whatever they were started with.

## Real-data specs (opt-in, not in the gate)

`npm run test:e2e:real` runs `playwright.real.config.ts`: `tests-real/` drives
the UI over a real client month seeded into the emulator from recorded model
replies (`scripts/real-samples/seed-account.ts --emulator`). It needs the
gitignored corpus and skips without it; set `TEREMU_REAL_MODEL` when several
recorded models exist. The default config never picks these specs up. Their
traces, videos and `last-run.log` show client documents — all gitignored,
never attach them anywhere. See `docs/real-samples.md`.

## Deploy gate (instead of GitHub CI)

E2E (and integration) tests deliberately don't run on GitHub Actions. They run
locally as the pre-deploy gate: `npm run deploy` executes `npm run test` and
`npm run test:e2e` before building or shipping anything (the `testGate` array in
`scripts/deploy.mjs`; `--skip-tests` bypasses it for an emergency redeploy).

## Debugging

- `npx playwright test --debug` — step through with the Playwright inspector
- `npx playwright test --ui` — interactive UI with time-travel
- `npx playwright show-report` — the HTML report after a run
- Failed tests auto-capture a screenshot **and a trace** in `test-results/`
  (`trace: retain-on-failure`); open one with
  `node node_modules/@playwright/test/cli.js show-trace <trace.zip>`
- Every test records video; `recordings/` holds them flattened after each run
