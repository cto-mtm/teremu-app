# Integration testing plan

Status: **implemented, pending a first local gate run.** All specs in the coverage matrix below are written (`firebase/functions/test/`), type-check cleanly, and load correctly under Vitest. They have NOT yet been run against live emulators by their author — that requires `firebase emulators:exec`, and the environment that wrote this suite couldn't reach the Firestore/Storage emulator downloads (network-restricted sandbox). Run `npm test` from the repo root once to confirm everything is green; report back anything red. We deliberately skipped unit tests; these are **integration tests** that exercise the real API against the Firebase Emulator Suite. It mirrors the proven house style from the Dirumed project's `firebase/functions/test/` suite, adapted to Teremu's hand-rolled router.

## Why integration (not unit) is the right first tier

Teremu's value and its subtle bugs live at the seams: an HTTP request hits the single `api` Cloud Function, which reads/writes Firestore + Storage via the Admin SDK, and a Storage trigger runs OCR. The hard-won logic — tenancy/permissions, the invoice→approve→price-roll→pantry lifecycle, unit conversion at approval, the freemium paywalls, reconciliation — only makes sense *through* those seams. Testing the whole path against the emulators (with the deterministic **mock OCR** that already runs without an `NVIDIA_API_KEY`) matches how the app actually calls the backend, needs no secrets, and catches the class of bug we actually hit (e.g. approving "25 lb" onto kg stock).

Pure client math in `app/src/lib/domain.ts` is unit-test-shaped but out of scope per the earlier decision. UI end-to-end (Playwright) is a heavier, later tier (see "Future tiers").

## Router decision: keep the hand-rolled `onRequest` (not Hono)

Dirumed's API is **Hono**, so its tests call `app.request(path, …)` in-process — fast, and it runs the real middleware. Teremu's API is a hand-rolled `onRequest` / `route(req, res)` router with **native binary handling** (`req.rawBody` for raw `image/jpeg` uploads, `res.send(buffer)` for image downloads). Porting that to Hono means an Express↔Fetch adapter around firebase-functions, which is precisely where raw-body bugs hide — a risky rewrite of working, deployed code for mostly test-ergonomics gains.

So Teremu tests hit the **emulated function over HTTP** (`http://127.0.0.1:5001/demo-app/us-central1/api`). Zero production-code change, fully black-box (exercises the real `onRequest`, CORS, routing, and binary paths). This is the faithful equivalent of Dirumed's in-process approach. If in-process speed ever matters, extract `route()` into a callable — no framework required. Hono is reserved for a greenfield service or a deliberate, separately-verified API rework.

## Runner & scaffold (house standard: Vitest)

Same three-file scaffold as Dirumed, in `firebase/functions/test/`:

- **`vitest.config.ts`** — `globalSetup: ['./test/global-setup.ts']`, `setupFiles: ['./test/setup.ts']`, a generous `testTimeout` (emulator + OCR-trigger polling), and **serial execution** (`pool: 'forks'`, `poolOptions.forks.singleFork` or `maxConcurrency: 1`) since all specs share one emulator — combined with per-test unique ids this stays safe and fast.
- **`test/global-setup.ts`** — fail fast with a clear message if the Firestore/Auth/Storage emulators aren't reachable (a `fetch` to each host; any response means it's up), so "emulator not running" never looks like "tests failing".
- **`test/setup.ts`** — set the Admin SDK emulator env vars **before any `firebase-admin` import** (Vitest runs setupFiles before the module graph): `GCLOUD_PROJECT=demo-app`, `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080`, `FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099`, `FIREBASE_STORAGE_EMULATOR_HOST=127.0.0.1:9199`. The test process uses its own Admin SDK to seed and to assert on storage state, so these are required even though requests go over HTTP.

The whole suite runs under one command via **`firebase emulators:exec`** (boots emulators → runs tests → tears down), locally and in CI.

## Test harness (`test/helpers.ts`)

Ports Dirumed's helpers, adapted to HTTP + Teremu's Firestore-based membership (no custom claims).

- **HTTP request client** — `api(path, { token, method, body, rid })` wrapping `fetch` against the emulated function URL; attaches `Authorization: Bearer <token>`, `Content-Type: application/json`, and `X-Restaurant-Id` when given. Thin `get/post/put/del` wrappers. A `upload(path, token, bytes)` variant sends a raw `image/jpeg` body for `POST /invoices` and `POST /menu/scan`.
- **`makeUserToken({ uid, email, emailVerified? })`** — create-or-update the user in the Auth emulator (`getAuth().createUser(...)`, falling back to `updateUser` on collision), then exchange for a real ID token via the emulator REST endpoint, verified by the same `verifyIdToken` path production uses. Simpler than Dirumed's: Teremu resolves membership from Firestore, so no custom claims to set. Exact exchange:

  ```ts
  const res = await fetch(
    `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'test-pass-123', returnSecureToken: true }) },
  );
  const { idToken } = await res.json(); // Bearer token for api()
  ```
- **`makeOwner({ uid, email })`** — mint a token and make one authed call so the server bootstraps that user's restaurant; returns `{ token, rid }`.
- **`seedMember(rid, uid, perms, role?)`** / **`seedInvite(rid, email, perms)`** — put a member directly under `restaurants/{rid}/members/{uid}` (+ the `users/{uid}` pointer / memberships), or a pending root `invites/{…}` that attaches on first sign-in. This is how permission and multi-member tests set up non-owner actors. **These docs (membership + invite) have no single doc schema and the shapes are actively changing with multi-location (`migrate-cli.ts`, `users/{uid}/memberships/{rid}`) — mirror the CURRENT write sites in `tenancy.ts` and `api.ts` (the `POST /members` / invite handlers) verbatim; do not hardcode a remembered shape.**
- **Seed factories with a drift guard** — `seedInvoice`, `seedIngredient`, `seedMenuItem`, `seedExpense`, `seedRestaurant`. Each validates its base document through the **functions `models.ts` doc schema** (`invoiceDocSchema`, `ingredientDocSchema`, `menuItemDocSchema`, `expenseDocSchema`) before writing, so a schema change breaks the factory loudly instead of running tests on stale shapes. Test `over` values are spread **after** validation, so seeding deliberately odd/legacy states stays possible.
- **`setPlan(rid, "free" | "pro")`** — the emulator-only `PUT /billing/plan` switch, so paywall transitions are testable without Stripe.
- **`pollUntil(fn, predicate, { timeoutMs, intervalMs })`** — Dirumed's generic poller for fire-and-forget effects; `waitForStatus(token, invoiceId, status)` is a thin wrapper that waits for the async Storage-trigger OCR to move an invoice off `processing`.
- **`clearFirestore()` / `clearAuth()` / `clearStorage()`** — emulator REST wipes (`DELETE /emulator/v1/projects/demo-app/databases/(default)/documents`, the Auth accounts endpoint, and `bucket.deleteFiles`). Storage matters here — receipt JPEGs survive a Firestore clear.

**Isolation:** `beforeEach(clearFirestore)` plus unique per-test uids/rids (each `makeOwner` bootstraps a fresh restaurant), so specs never collide. `clearStorage` in `beforeEach` only for suites that assert on receipt objects.

**Contract assertions:** where a response is doc-shaped, parse it through the matching `models.ts` schema (e.g. `invoiceDocSchema.parse(body)` must not throw) in addition to field asserts — the Dirumed "parse the View schema" check, using the API-side schemas since the tests live in the functions package.

## Coverage matrix

**1. Tenancy & permissions**
- Unauthenticated → 401.
- First authed call bootstraps a restaurant; `GET /me` returns owner role, full perms, `plan: free`, usage.
- Invite attach: `seedInvite` → a new user's first sign-in becomes a member with exactly the granted perms.
- Enforcement: a member without `finance` → 403 on `GET /revenue`; without `triage edit` can't approve; owner bypasses all.
- Isolation: user A cannot read user B's data (separate rid).

**2. Invoice lifecycle (core loop)**
- `POST /invoices` (raw jpeg) → 201 `processing`; `waitForStatus` → `needs_review` with line items + warnings.
- Approve → price roll (`prev ← last`, `last ← new`), pantry qty up, warnings cleared, `approvedAt` set.
- **Unit-conversion regression:** approve a `lb` line onto a `kg`-stocked ingredient → correct kg added, price stored per kg.
- Approve-as-expense → invoice archived with `expenseTag`, `expenses` doc created, excluded from food math.
- Delivery note → no price/pantry effect; reconciliation reports match / price-mismatch / mark-handled.
- Reprocess a failed invoice.

**3. Pantry & revenue**
- `POST /revenue` with `itemsSold` depletes pantry via recipes, incl. sub-recipe recursion + cycle/depth guard.
- Update/delete revenue reverts the deltas.
- `PUT /ingredients/:id/count` overwrites `theoreticalQty`.

**4. Freemium paywalls**
- Free scan cap: the 26th `POST /invoices` in a month → 402 `scan_limit`.
- **Concurrency spec** (Dirumed style): fire N simultaneous uploads at a near-full quota with `Promise.all`, assert the transactional counter never overruns the cap at the storage level.
- Member cap: inviting past the plan → 402 `member_limit`.
- Assistant: free → 402 `assistant_pro`; after `setPlan("pro")` → 200; second call within 10s → 429 cooldown.
- History windowing: `?days=` capped by plan; `GET /me` usage reflects consumed scans.

**5. Menu & menu-scan**
- `POST`/`PUT /menu-items` persists recipes incl. `ingredientId` XOR `subItemId`.
- `POST /menu/scan` (mock) returns dishes; `POST /menu/draft-recipes` returns catalog-matched drafts; **assert the scan quota is NOT consumed** (menu setup is quota-free); 5s cooldown → 429.

**6. Vendors & orders**
- `PUT /vendor-contacts/:key` upserts; `POST /orders` writes a `mail` doc (assert contents); 400 when the vendor has no email.

**7. Billing**
- `POST /billing/checkout` with no Stripe key → 501 `billing_not_configured`.
- `PUT /billing/plan` flips plan; `/me` reflects it and paywalls change.
- Webhook without real Stripe: craft a validly-signed payload with `stripe.webhooks.generateTestHeaderString` (test secret), call `stripeWebhook`, assert `restaurants/{rid}.plan` flips on `customer.subscription.*`. Self-contained, no network.

**8. Migration (multi-location)**
- `migrate-cli` backfills `users/{uid}/memberships/{rid}` + restaurant `name` idempotently — running twice is a no-op.

## Scripts & Execution

- `firebase/functions/package.json`: `"test": "vitest run"`, `"test:watch": "vitest"`.
- `firebase/package.json`: `"test": "npm --prefix functions run build && firebase emulators:exec --project demo-app 'npm --prefix functions run test'"` (build first so `@teremu/shared` is bundled and the served function is current).
- Root: `"test": "npm run build:shared && npm --prefix firebase run test"`.
- **Local Emulator Test Command**: `npm test` runs the integration tests against the Firebase emulators locally.

## File layout

```
firebase/functions/
  test/
    global-setup.ts     # emulators reachable? fail fast
    setup.ts            # Admin SDK env → emulators (before firebase-admin import)
    helpers.ts          # api()/get/post, makeUserToken, seed* factories, pollUntil, clear*
    tenancy.test.ts
    invoices.test.ts
    pantry.test.ts
    paywalls.test.ts
    menu.test.ts
    billing.test.ts
  vitest.config.ts
```

## Out of scope / limits

- **Real NVIDIA OCR** — mock only (optionally one opt-in test gated on `NVIDIA_API_KEY`).
- **Real Stripe network / live deploy** — webhook via signed fixture; checkout redirects and `firebase deploy` validated manually.
- **UI E2E** and **client pure-math unit tests** — deferred.

## Future tiers (not now)

- **Playwright E2E** against `npm run dev` + emulators: sign in via the Auth-emulator fake picker, scan → triage → approve → margin updates, location switcher. Add once the API suite is stable.

## Settled decisions

Runner (**Vitest**), location (**`firebase/functions/test/`**), request mechanism (**HTTP against the emulated function**), and **no Playwright / no E2E tier** all follow the Dirumed house style and are decided — do not introduce a browser-test tool.

## Execution & verification (for whoever implements this)

Work in phases and **do not proceed past a gate until it's green.** These are the only test-specific landmines; the monorepo rules (workspaces, `@teremu/shared`, esbuild build) are in `CLAUDE.md`.

**Phase 1 — Scaffold + harness.**
- Add `vitest` to `firebase/functions` **devDependencies** (`npm install -D vitest --workspace teremu-functions`).
- Create `vitest.config.ts`, `test/global-setup.ts`, `test/setup.ts`, `test/helpers.ts` per the sections above.
- Watch these specifics:
  - **Test imports are extensionless** (`import { invoiceDocSchema } from '../src/models'`) — Vitest transpiles TS itself, so the repo's NodeNext `.js` import specifiers will *not* resolve in a spec. Import `@teremu/shared` by package name as usual.
  - `test/setup.ts` sets the Admin SDK emulator env vars **before** anything imports `firebase-admin` (Vitest runs `setupFiles` first) — `GCLOUD_PROJECT=demo-app` and the three `*_EMULATOR_HOST` vars.
  - Vitest runs **serially** (single fork / `maxConcurrency: 1`) since all specs share one emulator; `testTimeout` ≥ 15000 to cover OCR-trigger polling.

**Phase 2 — One spec green (the gate).**
- Write `test/tenancy.test.ts` only (401, bootstrap + `GET /me`, an invite-attach, one 403).
- Run it end to end: `cd firebase && firebase emulators:exec --project demo-app "npm --prefix functions run test"`. `emulators:exec` boots the emulators; the wrapping script **builds functions first** (esbuild → `lib/index.js`) so the Functions emulator serves current code, then Vitest hits it over HTTP.
- **Gate:** this must pass before writing any more specs. If tenancy shapes look off, re-read the current `tenancy.ts` write sites (they may have moved with multi-location) and fix the seed factory — not the assertion.

**Phase 3 — Expand spec by spec.**
- Add the remaining specs from the coverage matrix one file at a time (`invoices`, `pantry`, `paywalls`, `menu`, `billing`), running the full command green after each. Land the invoice-lifecycle unit-conversion regression and the concurrent scan-cap spec early — they guard the two scariest behaviors.
- Wire the `test` scripts (functions / firebase / root) as described.

**Definition of done.** Every spec passes under `firebase emulators:exec --project demo-app` with no secrets set (mock OCR, emulator Stripe-less). Explicitly **not** covered and validated manually: the real `firebase deploy`, real NVIDIA OCR, and real Stripe network. Do **not** run `firebase deploy` or `vite build` as part of this work.
