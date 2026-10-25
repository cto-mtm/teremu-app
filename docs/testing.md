# Testing

Three tiers, split by where Teremu's risk lives:

| Tier | Where | Needs emulator? | What it guards |
|------|-------|-----------------|----------------|
| **Unit** | `shared/src/` + `app/src/lib/` | No | Pure math both sides rely on — plate costing and unit conversion (`@teremu/shared`), and the app's client-side domain math, sales-CSV parsing and money/unit helpers. Seconds. |
| **Integration** | `firebase/functions/test/` | **Yes** | The `api` function over real HTTP against the Firestore/Auth/Storage emulators: tenancy and permissions, the scan → approve → price-roll → pantry lifecycle, paywalls, POS, currencies, CORS, and the security-rules locks. Most of Teremu's bugs live at these seams. |
| **E2E** | `e2e/` (Playwright) | **Yes** (+ Vite) | The user-visible flows in a real browser: sign-in, scan → triage → approve, pantry, dish margins, revenue. See `e2e/README.md`. |

A fourth, **opt-in** tier runs on real client documents (`npm run test:real`, record/replay). It never runs in the gate. See `docs/real-samples.md`.

## Running

```bash
# Unit: fast, no emulator (also what plain `npm test` runs)
npm run test:unit

# Hermetic functions tests (no emulator, not part of test:unit): the country
# packs (src/countries/*/*.test.ts), the OCR reply parsing (test/ocr-us.test.ts,
# test/arithmetic.test.ts), the Checkout params (test/billing-units.test.ts) and
# the boundary scan (test/boundaries.test.ts). They also run inside the
# integration tier; to run them alone, point vitest at them with a config
# that has no globalSetup (the package's config boots the emulators).

# Integration. Two options:

# A) one-shot: type-checks + builds functions, boots the emulators (functions
#    included, TEREMU_TEST_MOCKS=1), runs the suite, tears down.
#    It FREES the emulator ports first, so it stops emulators you have running.
npm run test:integration:exec

# B) iterating: leave the full set up in one terminal (cd firebase)…
npm run emulators
# …and run the suite in another
npm run test:integration

# E2E: reuses running emulators, or boots the full set one-shot when they're down.
npm run test:e2e
```

Option B runs against YOUR emulators. They don't have `TEREMU_TEST_MOCKS`, so a machine holding real keys in `functions/.secret.local` would make real OCR/billing calls, and the suite writes test data into the dev database. Prefer A unless you're iterating on one spec.

## How the integration tests work

- They hit the **emulated `api` function over HTTP** (`test/helpers.ts` `api()` / `get` / `post` / `upload`). There is no in-process router, so the real `onRequest`, CORS, routing and binary paths (raw `image/jpeg` uploads, image downloads) all run as deployed. See `docs/testing-plan.md` for why Teremu kept the hand-rolled router.
- Auth is real: `makeUserToken` creates the user in the Auth emulator and exchanges a password for an ID token through its REST endpoint, so `verifyIdToken` runs for real. Membership is resolved from Firestore, so there are no custom claims to mint.
- `test/global-setup.ts` fails fast if Firestore/Auth/Storage/Functions aren't reachable, so "emulator down" never looks like "tests broken".
- **Seed factories are drift-proof**: each validates its base document through the functions `models.ts` doc schema before writing. Test `over` values are spread after validation on purpose, so odd or legacy states stay seedable.
- **Hermetic by env**: the `firebase` `test` script sets `TEREMU_TEST_MOCKS=1`, which forces the offline OCR mock, "not configured" billing, the scripted assistant model and the offline POS provider, even when real keys exist locally.
- **Security rules** (`test/rules.test.ts`, `@firebase/rules-unit-testing`) are the only test exercising what a real *client* can do. Both `firestore.rules` and `storage.rules` are deny-all on purpose, because the app talks only to the api. The locks fail the suite, and so the deploy gate, if either file is ever relaxed.
- **CORS** (`test/cors.test.ts`): the functions emulator turns on firebase-functions' `enableCors` debug feature (allow-any-origin) for every `onRequest`. That masked the `helpers/cors.ts` allow-list locally. `api` sets `cors: false` so the emulator behaves like production, and these cases fail if that is lost.
- Specs run serially (`fileParallelism: false`), with unique uids/rids per test.

## Type-checking is part of testing

Vitest strips types without checking them, so green tests don't prove the code compiles. So:

- `npm run test:unit` builds `@teremu/shared` (`tsc`) and runs the app's `vue-tsc -b` before its tests.
- `npm run test:integration:exec` runs the functions `tsc --noEmit` before building. esbuild bundles without type-checking.

`npm run typecheck` at the root covers all three workspaces in one go.

## Conventions

- Unit tests sit next to their source as `*.test.ts`. The shared build excludes them (`shared/tsconfig.json`), and the app bundle never imports them.
- Keep `app/src/lib/` modules pure (no Vue, no I/O) so they stay unit-testable in Node. `domain.ts` and `csv.ts` are the pattern.
- Integration specs live in `firebase/functions/test/`, with extensionless imports (`../src/models`; see `docs/testing-plan.md`).
- A new route must come with integration tests for: unauthenticated (401), another restaurant (403/404), the member whose perms should deny it, and the happy path. Assert deny paths, not just success.
- New money math, unit conversion or CSV/date rules get a unit test. Those are the bugs that are silently off by 100x.

## Deploy gate (no CI)

There is no GitHub CI (`.github/workflows/README.md`). `npm run deploy` runs the `testGate` in `scripts/deploy.mjs` before anything builds or ships: `test:unit`, then `test:integration:exec`, then `test:e2e`. `--skip-tests` bypasses it for an emergency redeploy. The emulators need a Java 21+ JRE.

## Running alongside another repo's emulators

The one-shot runners (`test:integration:exec`, `test:e2e`, `test:real`) start the emulators with `TEMP`/`TMP` pointed at `<repo>/.tmp/emulators` (`scripts/lib/private-tmp.mjs`, gitignored). The Storage emulator keeps its blobs in `<os tmpdir>/firebase/storage/blobs` and wipes that directory on every boot, so two emulator runs on one machine share it even for different projects. Another repo's `emulators:exec` starting mid-run used to delete the blobs and crash this one's Storage emulator (`ENOENT … storage/blobs/…`, then every later test failing). Ports were never the problem: they come from each repo's own `ports.json`. A dev `npm run emulators` still uses the shared system temp dir.

## Known limits

- The Firestore **emulator does not enforce composite indexes**. A query that needs `firestore.indexes.json` passes here and fails in prod with `FAILED_PRECONDITION`.
- Real NVIDIA OCR, live Stripe and live Square are never in the gate: mocks only. Real documents go through the opt-in real-corpus tier.
- The app's stores, router guard and components have no unit tests yet. Their flows are covered only by e2e.
