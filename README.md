# Teremu

AI-powered invoice scanning, dish-margin tracking, and intelligent inventory for independent restaurant owner-operators and executive chefs.

**In the box:** a Vue 3 + Vite + Capacitor app (browser today, iOS/Android with zero restructuring), Firebase Hosting + a Cloud Functions API, full local dev via the Firebase Emulator Suite (no Firebase account needed), a View-Transitions animation system with hero transitions, and vue-i18n (Spanish primary, English fallback). Receipt OCR uses NVIDIA vision models ([build.nvidia.com](https://build.nvidia.com)) with an offline mock fallback.

| Screen | What it does |
|---|---|
| **Pulse** | Expenses-vs-revenue chart, vendor price-hike + margin-drop alerts, quick revenue logging |
| **Scan** | Continuous capture — snap 15 crinkled invoices in 60 seconds, no review interruptions |
| **Triage** | Background-OCR'd invoices; side-by-side image + editable transcription, one-tap approve |
| **Menu** | Dishes costed live from rolling vendor prices; target-vs-actual margin bars |
| **Pantry** | Theoretical stock (purchases − sales), zero daily input; tap a number for the monthly true-up; tap a name for the ingredient's dishes, receipts, and vendors |
| **Vendors** | Vendor directory derived from approved invoices — spend, deliveries, ingredients supplied with last prices |
| **Team** | Shared restaurant workspace: invite members by email with granular per-area permissions (none / read / edit) |

## Quick start — fully local, no Firebase account

This is an npm **workspaces** monorepo (`shared`, `app`, `firebase/functions`). Install once at the root — that links `@teremu/shared` into both packages.

```bash
npm i -g firebase-tools                        # one-time
npm install                                    # root: installs all workspaces + links @teremu/shared
npm run build:shared                           # build @teremu/shared (needed by app + functions)
cd firebase/functions && npm run build         # bundle functions (esbuild)
cd .. && npm run emulators                     # full local backend on :5001
# in a second terminal:
cd app && cp .env.example .env && npm run dev  # app on :5173
```

Works with no Firebase project and no real Google account — the emulator scripts use the `demo-app` project id, and the `demo-` prefix makes the Emulator Suite run fully offline (never touches production resources). Sign-in goes through the **Auth emulator**: the Google button opens a fake account picker where you invent a test user. Visit `http://localhost:5173/settings` and the health check should answer from the emulated function. Scan a receipt (or upload any photo) and the mock OCR digitizes it — no NVIDIA key needed locally.

**Demo data:** after signing in once, run `npm run seed` in `firebase/` (emulators must be running). It populates every screen for each Auth-emulator user — ingredients with price history, invoices, dishes with recipes, and two weeks of revenue. Seed a specific user with `npm run seed -- <uid>`. The script forces emulator hosts and the `demo-app` project id, so it can never touch production.

**Daily workflow:** two terminals — `npm run emulators:watch` in `firebase/` (plus `npm run build:watch` in `firebase/functions/` for the tightest loop; the emulator hot-reloads functions when `lib/` changes) and `npm run dev` in `app/`.

## Real OCR (NVIDIA)

Get a free `nvapi-` key at [build.nvidia.com](https://build.nvidia.com) (open any model → *Get API Key*). Locally, put `NVIDIA_API_KEY=nvapi-...` in `firebase/functions/.secret.local` or export it before starting the emulators. For production: `firebase functions:secrets:set NVIDIA_API_KEY`. Default model is `meta/llama-4-maverick-17b-128e-instruct`; override with the `NVIDIA_MODEL` env var.

## Billing (Stripe)

Optional — until configured, upgrade buttons return `billing_not_configured` and the emulator's *Switch plan (dev)* toggle in Settings flips tiers for testing.

1. In the Stripe dashboard, create one **Pro** product with two recurring prices: monthly and yearly. Copy their `price_…` IDs.
2. Set the secrets: `firebase functions:secrets:set STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`.
3. Put the non-secret params in `firebase/functions/.env`: `STRIPE_PRICE_PRO_MONTHLY`, `STRIPE_PRICE_PRO_YEARLY`, and `APP_URL` (e.g. `https://app.teremu.com` — where Checkout returns).
4. Add a webhook endpoint in Stripe pointing at the deployed `stripeWebhook` function URL, subscribed to `checkout.session.completed` and `customer.subscription.*`; put its signing secret in `STRIPE_WEBHOOK_SECRET`.

The `stripeWebhook` function is the only thing that flips a restaurant's `plan` — it mirrors the subscription state onto Firestore, so the app never trusts the client for entitlements. Monthly/yearly is chosen on the pricing page; the Settings card links to Stripe's customer portal for card/interval changes and cancellation.

## How to add a hero transition

Full recipe in [`docs/animations.md`](docs/animations.md). Summary: give the source element `:style="{ viewTransitionName: 'thing-' + id }"`, give the target element on the destination page the same name, done — the browser morphs them. Names must be unique per page; always derive them from the item id. The Triage card → detail page is the reference implementation.

## How to add a translated string / a new locale

See [`docs/i18n.md`](docs/i18n.md). Strings live in per-feature TS modules under `app/src/i18n/locales/` with `es` as source of truth and `en` typed `typeof es` — missing keys are compile errors. New locale: add it to every module, `SUPPORTED_LOCALES`, and the `messages`/`datetimeFormats` blocks in `i18n/index.ts`.

## How to add an API endpoint

1. Add a zod schema to `firebase/functions/src/models.ts` (request body and/or response entity).
2. Add a route branch in `firebase/functions/src/api.ts` (hand-rolled router, no Express).
3. Mirror the response schema in `app/src/lib/schemas.ts` (types derive automatically via `z.infer` in `types.ts` — see the "Shared types & validation" section of `docs/architecture.md`).
4. Call it via `apiFetch(path, init, schema)` from a Pinia store or `useApi` — the response is runtime-validated against your schema.

Testable immediately against the emulator — no deploy needed.

## Going native

```bash
cd app && npm run build
npx cap add ios && npx cap add android    # one-time
npm run cap:assets                        # after dropping icon/splash into app/assets/
npx cap sync && npx cap open ios          # or: npx cap open android
```

The API CORS allow-list already includes the Capacitor origins (`capacitor://localhost`, `http://localhost`), and the Android hardware back button is already handled in `app/src/lib/native.ts`.

## Deploy

1. Set your real project id in `firebase/.firebaserc` and swap the `REPLACE_ME` domains in `firebase/functions/src/helpers/cors.ts`.
2. In `app/.env`, set `VITE_API_URL` to your deployed function URL and fill the `VITE_FIREBASE_*` vars; enable the **Google** provider in Firebase console → Authentication → Sign-in method.
3. `npm run deploy` (root) — runs `scripts/deploy.mjs`: builds `@teremu/shared`, builds the app and copies `app/dist/` to `firebase/app/`, bundles functions with esbuild (inlining `@teremu/shared` so the uploaded artifact is self-contained), then deploys Hosting + Functions.

## Keeping dependencies fresh

Versions in `package.json` are pinned to the dates this boilerplate was
generated. They're intentionally NOT auto-updated on install — the goal is
that `npm install && npm run dev` always works on day one.

Recommended workflow when starting a new project from this scaffold:

1. `npm install` in both `app/` and `firebase/functions/` and confirm
   `npm run dev` boots cleanly.
2. Commit the scaffold as your baseline (`git commit -m "initial scaffold"`).
3. Run `npm outdated` in each folder to see drift, and `npm audit` for
   security issues.
4. Upgrade deliberately — one major version at a time, testing between each.
   Watch especially for breaking changes in Vite, Capacitor, Tailwind,
   Firebase Functions, and zod (these have all shipped breaking majors in
   the past).
5. After upgrading, re-run `npm run dev`, click through the hero transition
   and the /settings health check before committing.

Avoid running `npm update` blindly — it will pull breaking majors without
warning and you'll lose the "clean baseline" property.
