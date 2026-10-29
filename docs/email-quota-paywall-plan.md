# Email import: Free cap, paywall and the upgrade handoff — plan

Status: written 2026-10-29 from a code review of the shipped email ingestion
(docs/email-ingestion.md Phases 1–4), reviewed once more the same day (second
pass added G12–G13, the e2e helper notes and the mirrored card list; a third
pass added G14 and Phase 4, the teaser that shows what is waiting; a fourth
pass added G15 and Phase 5, the onboarding prompts to connect an inbox; the
`past_due` question was decided the same day — keep the paid plan while
Stripe retries — so the executing session has nothing left to ask).
Nothing here is built yet. This document is the brief for the session that executes
it: it names every file, the behaviour to change, and what done looks like,
so no re-derivation is needed.

Read first (repo rules that bind every step): `CLAUDE.md`, `docs/email-ingestion.md`
(§Sync engine, §Triage integration), `docs/i18n.md` (every user-facing string
is a key in both `es` and `en`; `es` is the source of truth), `docs/testing.md`
and `e2e/README.md` before adding tests, `docs/mtmcya-mailer.md` before touching
`mail.ts`. Never run `vite build`, `npm run build` or `cap sync`; the one build
that is required is `npm run build --workspace @teremu/shared` after a change
to `shared/` (the other packages typecheck against its `dist`). Typecheck with
`tsc --noEmit` (functions) and `npm run typecheck` (app, `vue-tsc -b`). Don't
run the test tiers unless asked, except where a step below says to (the
integration suite boots its own emulators and stops running ones).

## 1. What exists today (verified)

Engine (`firebase/functions/src/email/`):

- Emailed documents have no cap of their own; each spends one scan from the
  monthly meter (`plan.ts consumeScan`), on every plan. On Free that meter
  (25) is the feature's cap.
- `ingest.ts ingestAccepted`: when `consumeScan` refuses, the message's
  `emailIngests` record becomes `deferred_quota`, `pauseForQuota` stamps the
  connection with `quotaPausedPeriod = YYYY-MM` (restaurant's timezone) and
  sends one `email-quota` mail per restaurant per month (`restaurants/{rid}.
  emailQuotaNudged`), CTA → `${APP_URL}/pricing`. The mail does not know the
  plan: a Max restaurant at 1,500 gets the same "Ver planes" nudge.
- `sync.ts syncDue` / `nextSyncAt`: a connection with `quotaPausedPeriod` set
  is always due, so the hourly `emailSync` scheduler retries it every hour
  (not at the plan cadence) until the meter resets or the plan grows. This is
  by design (it is how an upgrade or the month turning is noticed) and stays.
- The pause is cleared only inside the ingest loop, when a document actually
  gets a scan (`ingest.ts` ~line 73 `pauseCleared`, ~line 103 the update).
- Deferred messages older than 31 days flip to `expired_quota` silently.
- `oauth.ts emailStatus` → `InboxView` exposes `paused` (= stamp equals the
  current month), `found`, `waiting` (accepted + deferred), `working`
  (backfill unfinished or `ingestPending`), `nextCheckAt`.
- `POST /email/inboxes/:id/sync` (api.ts ~line 1413) returns `SyncResult`
  `{ listed, waiting, classified, accepted, ingested, backfillDone }`; the app
  schema (`app/src/lib/schemas.ts emailSyncResultSchema`) keeps only
  `listed, accepted, backfillDone, ingested`.

Billing (`firebase/functions/src/billing.ts`, api.ts ~line 1441):

- Stripe webhook `applySubscription` merges `{ plan, planInterval,
  stripeCustomerId, stripeSubscriptionId }` onto the restaurant doc. Nothing
  else reacts to a plan change. Emulator: `PUT /billing/plan` sets `plan`.
- `planFromSubscription` (not exported, untested): any status other than
  `active`/`trialing` → `free`, so `past_due` drops the plan at once.
  `test/billing-units.test.ts` covers `checkoutSessionParams` only.
- Checkout `success_url` = `/settings?billing=success`; `cancel_url` =
  `/pricing?billing=cancelled`. `SettingsPage.vue onMounted` only calls
  `auth.reloadProfile()` and strips the query.

App:

- `app/src/components/EmailCard.vue`: on Free a `freeCap` hint + "See plans"
  link; when `inbox.paused` a red text line `email.paused` with the waiting
  count + link; "Check now" (`runSync`) is allowed while paused and ends with
  the green `email.synced` chip. `resumeWork()` auto-runs only `working`
  inboxes. The card is keyed by `restaurantId`, so a location switch remounts it.
- `app/src/pages/PricingPage.vue`: generic comparison; no query handling; the
  plan items (`i18n/locales/pages/pricing.ts`) never mention email import.
- `app/src/pages/ScanPage.vue` ~lines 429–455: its own inline coral banner on
  `scan_limit` with `atMaxTier` no-upsell variant and a "Ver planes" button.
  No shared paywall component exists. `TriagePage.vue`, `PulsePage.vue` and
  the Settings "Plan" card know nothing about waiting emailed invoices.
- `GET /me` (api.ts ~line 272) ships `plan` and `usage.{scans, scanLimit}` only.
- `SettingsPage.vue` deep-links cards through `useQueryAction('card', …)` with
  the `CARDS` list declared in the page.

Tests:

- `firebase/functions/test/email-ingest.test.ts` "pauses at the limit … and
  resumes on upgrade" covers pause → deferred → `PUT /billing/plan` → sync →
  resumed. No test for a stale pause.
- e2e: `e2e/tests/settings/email.spec.ts` has one connect → import →
  disconnect spec (desktop-only, fresh location, fake inbox: 17 messages, 7
  invoices). `e2e/tests/pricing/pricing.spec.ts` covers the pricing cards and
  the POS cap note. `e2e/flows/plan.flow.ts setPlanEverywhere(plan)` writes
  `plan` on every restaurant through the Firestore emulator REST API with the
  `Bearer owner` bypass — **it does not go through the API, so it will not
  fire the plan-change hook this plan adds.** The e2e app is served by Vite
  dev (`playwright.config.ts webServer: npm run dev`), so `import.meta.env.DEV`
  is true and the "Cambiar plan (dev)" button exists; it calls `PUT
  /billing/plan`, which will run the hook.

## 2. Gaps

At the cap (Free):

- G1 The paywall is one sentence and a link; scan has a banner with a button,
  the assistant a modal. Three cap UXs.
- G2 "Check now" on a paused inbox shows the success chip "Revisión terminada"
  beside the red paused line; the sync response carries no `paused` signal.
- G3 Only the Settings email card knows about waiting invoices. Triage, the
  Plan card, Pulse and the pricing page show nothing; the monthly mail is the
  only other channel.
- G4 `expired_quota` is never counted or shown (the design doc promised
  "counted in Settings").
- G5 The pricing page gets no context from where the user came, and its plan
  items omit email import.
- G14 The paywall shows a count and nothing else. Every waiting message's
  `emailIngests` record already holds the sender, subject, Gmail snippet,
  attachment filenames and date (fetched before the cap bit, so free to
  show), and stage 1 could return a vendor and amount hint for a few output
  tokens. None of it reaches the owner, in the app or in the mail. Phase 4.

Before the cap (activation):

- G15 Nothing invites a new owner to connect an inbox. The first-login tour
  (`app/src/components/OnboardingWizard.vue`, beats welcome / scan / margins /
  team / plans, copy in `i18n/locales/components/onboarding.ts`) sells the
  camera only; the "find your restaurant" setup page ends on a done screen
  (`RestaurantSetupPage.vue` phase `done`) that offers Pulse, the menu or
  recipe drafts; Triage's empty state (`TriagePage.vue` `triage.empty`) is a
  sentence. Email import — the no-effort version of the camera promise, with
  a 31-day backfill that fills Triage in minutes — is discoverable only by
  scrolling Settings. Phase 5.

After paying:

- G6 Back on `/settings?billing=success` the card still shows "You reached
  your plan's limit … or when you upgrade" + "See plans" to a now-paid owner,
  until the next tick ingests (≤ 60 min) or they tap "Check now".
  `resumeWork()` skips paused inboxes.
- G7 The webhook never pokes the inbox; continuation depends on the hourly
  scheduler; no "your N invoices are coming in now" moment.
- G8 `past_due` → Free at once: a failed renewal re-caps a paying restaurant,
  pauses the inbox and mails the upgrade nudge. Billing-wide; email makes it
  visible. **Decided 2026-10-29: keep the paid plan while Stripe retries**
  (3.1 step 6, 3.2 step 10).

Engine hygiene:

- G9 Stale pause: if the month turns and nothing deferred/accepted remains,
  `quotaPausedPeriod` is never cleared (clearing lives inside the ingest
  loop). `paused` reads false in the view, but `syncDue` stays true → a Free
  inbox syncs hourly forever instead of daily; `nextCheckAt` is 0.
- G10 Max → Free keeps 3 inboxes syncing; no enforcement, no message. Minor.
- G11 Test coverage: see above.
- G12 The `email-quota` mail is promotional ("Ver planes", unsubscribe) on
  every plan, including Max, which has nothing to upgrade to.
- G13 A plan change written straight to Firestore (admin edit, seed, the e2e
  helper) is invisible to any hook; only the scheduler notices it. Fine in
  production (Stripe is the only writer), but the tests must know.

## 3. Plan

Five phases, in order; Phase 2 depends on Phase 1's new fields, Phase 4 on
both, Phase 5 only on the status endpoint as it is today (it can ship any
time, but it should not be *shown* to users before Gmail verification — see
its gate). Each phase is one commit (or a few focused ones). Commit messages follow the repo style
(`Area: what changed`, see `git log`).

### 3.1 Phase 1 — engine (`firebase/functions`)

1. **Plan-change hook.** New `firebase/functions/src/email/planChange.ts`
   exporting `resumeAfterPlanChange(rid, from: Plan, to: Plan)`. When the
   plan rises (free→pro/max, pro→max): for every connection in
   `inboxesOf(rid)` with `status === "active"` and `quotaPausedPeriod` set,
   `update({ quotaPausedPeriod: null, ingestPending: true, updatedAt })`
   (`ingestPending` keeps it due and makes `working` true, which the card
   already treats as "keep checking"), and clear `restaurants/{rid}.emailQuota`
   (step 4). No Gmail call from the webhook: the app's immediate "check now"
   (Phase 2) and the scheduler do the work. Best effort, logged, never fails
   the webhook. The hook is the accelerator; the always-due scheduler stays
   the guarantee (G13), so a sync that was already running when the plan
   flipped may re-stamp the pause a moment later — harmless, the inbox stays
   due and the next check clears it. Call sites:
   - `billing.ts applySubscription`: read the doc's current `plan` (via
     `planOf`) before the `set`, compute the new plan, write, then call the
     hook when it rose. `billing.ts` imports from `email/planChange.ts`, never
     the other way round (email stays Stripe-free).
   - `api.ts PUT /billing/plan` (emulator switch): same compare-then-hook.
2. **Stale pause.** In `ingest.ts ingestAccepted`, before the loop: if
   `conn.quotaPausedPeriod` is set and differs from `monthKey(timeZone)`,
   clear it (`quotaPausedPeriod: null`) regardless of whether anything is
   left to ingest. Keep the existing in-loop clear for the same-month case.
   Wherever the stamp is cleared (both places here, and the hook), clear
   `restaurants/{rid}.emailQuota` too (one helper, e.g. `clearQuotaPause(connId,
   rid)` in `planChange.ts` or `store.ts`).
3. **Sync response.** Extend `SyncResult` (sync.ts) with `paused: boolean`
   (the inbox is paused after this run) and `expired: number` (messages let
   go this run; `ingestAccepted` already has `expired.docs`, return the count
   in `IngestResult`). Mirror in `app/src/lib/schemas.ts emailSyncResultSchema`
   leniently (`.catch(false)` / `.catch(0)`), and add `waiting` there too (the
   server already sends it).
4. **Waiting count on the profile.** `pauseForQuota` already counts
   `accepted + deferred_quota` across the restaurant's inboxes for the mail:
   write it to the restaurant doc as `emailQuota: { period: YYYY-MM, waiting:
   n }` on every refused scan (move the count before the "first nudge" early
   return so it refreshes each time, not only on the first pause of the
   month). It is per restaurant, the pause per connection; clearing it when
   any inbox resumes is fine (the meter is shared, so if one inbox gets a
   scan the others would too). `getPlanInfo` (plan.ts) reads it from the same
   doc snapshot it already has: add `emailQuotaWaiting: number` to `PlanInfo`
   (0 when `emailQuota.period` isn't the current month). `GET /me` ships
   `emailWaiting: planInfo.emailQuotaWaiting`; `meSchema` adds `emailWaiting:
   z.number().catch(0)`. One doc read, no new query per request. If any test
   builds a `PlanInfo` literal, `tsc` will point at it; add the field there.
5. **Status view.** `oauth.ts InboxView` + `sync.ts inboxCounts`: add
   `expired` (count of `expired_quota` for the connection, one more `count()`
   in the same `Promise.all`). `emailStatusSchema` adds `expired:
   z.number().catch(0)`.
6. **`past_due` keeps the paid plan (G8) — decided, no need to ask.** In
   `billing.ts planFromSubscription`, the paid tier applies for `active`,
   `trialing` **and `past_due`** (Stripe keeps the subscription live and
   retries the charge for ~3 weeks by default; its own dunning mails go out
   if enabled in the dashboard). Everything else maps to Free: `canceled`,
   `unpaid` (retries exhausted), `incomplete` and `incomplete_expired` (the
   first payment never completed), `paused` (collection paused on purpose).
   Update the function's comment with this table. `applySubscription` also
   writes `subscriptionStatus: sub.status` onto the restaurant doc (same
   `set`), so the app can tell "paid but payment failing" apart from "paid":
   `getPlanInfo` reads it from the snapshot it already has
   (`subscriptionStatus: string | null` on `PlanInfo`), and `GET /me` ships
   `billing: { status }`; `meSchema` adds `billing: z.object({ status:
   z.string().nullable().catch(null) }).catch({ status: null })`. Export
   `planFromSubscription` (it is pure) and add cases to
   `test/billing-units.test.ts` for `active`, `trialing`, `past_due` (→ the
   bought tier), `canceled`, `unpaid`, `incomplete`, `paused` (→ `free`) and
   an unknown price (→ `pro`), with a minimal `Stripe.Subscription`-shaped
   object cast through `unknown`; the env price ids can be set inside the
   test with `vi.stubEnv`. Record the decision in `docs/business-model.md`
   §3 (one line under the tiers table: "a failed renewal keeps the plan
   through Stripe's retry window; the plan drops when Stripe gives up").
7. **Mail.** `mail.ts emailQuotaEmail` gains a `plan` (or `upgradeTo: Plan |
   null`) argument. With an upgrade available: `pricingUrl` →
   `${APP_URL}/pricing?reason=email_quota`, promotional as today. On Max
   (`upgradeTo === null`): informational copy in both locales ("Este mes ya
   usaste los {limit} documentos de tu plan. Las facturas esperan y entran
   solas el mes que viene."), CTA "Abrir Ajustes" → `${APP_URL}/settings?card=email`,
   no unsubscribe topic (it is not promotional). `pauseForQuota` passes the
   plan (read it in the same transaction that sets `emailQuotaNudged`, or
   from the restaurant snapshot `ingestAccepted` already takes for the
   timezone — pass both down).
8. **Tests (integration, `firebase/functions/test/email-ingest.test.ts`,
   extend the existing scan-meter `describe`):**
   - stale pause: set `quotaPausedPeriod` to last month with no deferred
     messages → one sync → stamp is null, `GET /email` shows `paused: false`
     and a non-zero `nextCheckAt`.
   - plan switch clears the pause immediately: pause → `PUT /billing/plan
     pro` → `GET /email` shows `paused: false`, `working: true` before any
     sync; `GET /me` `emailWaiting` is 0; then a sync drains and
     `ingestPending` is false.
   - `GET /me` `emailWaiting` equals the waiting count while paused.
   - sync response carries `paused: true` while at the cap and `expired`
     when a deferred message is let go.
   - `expired` surfaces in `GET /email`.
   - Max at its cap: the mail recorded by the test mailer mock (see how the
     existing test asserts `emailQuotaNudged` / the mail) has no pricing link.
   Run `tsc --noEmit` in `firebase/functions` and `npm run test:integration:exec`
   once at the end of the phase (tell the user first: it stops running
   emulators).

### 3.2 Phase 2 — paywall UX (`app/`)

1. **Shared notice.** New `app/src/components/UpgradeNotice.vue`: props
   `title`, `body?`, `count?`, `reason` (`'scan_limit' | 'email_quota' |
   'email_free' | 'members'`), `dismissible`. Reads `auth.profile.plan` and
   `role` itself. Renders the coral banner the scan page has today (same
   classes, `role="alert"`), a "Ver planes" button → `/pricing?reason=<reason>`
   when there is a higher plan (not on Max: show the no-upsell text, like
   `scan.limitReachedMax`), and the ✕ when dismissible. Owner-only CTA: a
   member sees the text, no button. Strings in a new
   `i18n/locales/components/upgradeNotice.ts`, registered in `i18n/index.ts`
   the way `email.ts` is, both locales.
2. **Scan page migration.** Replace the inline banner in `ScanPage.vue`
   (~lines 429–455) with `<UpgradeNotice reason="scan_limit" …>`; keep the
   `limitHit` state and `goToPlans` behaviour; the four `scan.limit*` strings
   either move to the notice module or are passed in as props. Keep the
   existing `pop` Transition (docs/animations.md: transform/opacity only).
3. **EmailCard.** Changes to `app/src/components/EmailCard.vue` +
   `i18n/locales/components/email.ts`:
   - Paused state renders `<UpgradeNotice reason="email_quota"
     :count="inbox.waiting">` with count-forward copy ("12 facturas
     esperando en tu correo. Con Pro entran hoy." / en) instead of the text
     line. Not dismissible.
   - While paused, `runSync`'s final message is the paused copy, not
     `email.synced` (use the new `paused` field from the sync response).
   - Show `email.expired` ("{n} facturas esperaron más de 31 días y se
     dejaron pasar.", plural forms like `found`) when `inbox.expired > 0`.
   - Watch `auth.profile?.plan`: when it rises (free→pro/max, pro→max) and
     any inbox was paused, `await load()` then `runSync(id, false)` for each
     inbox with `working` true — the existing progress loader shows the
     backlog draining. Final message: new string `email.resumed` ("Tu plan
     creció: {n} facturas importadas.", sum of `ingested` across rounds).
     Also, since the hook sets `ingestPending`, a card mounted after the
     upgrade already auto-runs through `resumeWork()`; the watcher covers the
     page-already-open case.
   - `freeCap` hint stays; its link gains `?reason=email_free` (pricing shows
     a soft context strip, no count).
4. **Settings Plan card.** In `SettingsPage.vue`'s plan card, under the scan
   meter bar: when `auth.profile.emailWaiting > 0`, a line
   `settings.plan.emailWaiting` ("{n} facturas esperando en tu correo.") with
   a link to `#card-email` (`focusCard('email')`), so the owner who opens
   Settings to upgrade sees the reason beside the "Mejorar tu plan" button.
5. **Return from checkout to the email card.** `POST /billing/checkout`
   body gains optional `returnCard`. The card names become shared vocabulary:
   `SETTINGS_CARDS` + `settingsCardSchema` in `shared/src/vocab.ts` (then
   `npm run build --workspace @teremu/shared`); `models.ts` re-exports or uses
   the schema for the body; `SettingsPage.vue` builds its `CARDS` from the
   shared list. `billing.ts createCheckoutSession`/`checkoutSessionParams`
   append `&card=<returnCard>` to `success_url` when given (extend
   `test/billing-units.test.ts`). `PricingPage.upgrade()` passes `returnCard:
   'email'` when `reason` is `email_quota`/`email_free`. Settings already
   handles `?card=email` through `useQueryAction`; make sure the `billing=
   success` branch's `router.replace({ query: {} })` does not race it (the
   `useQueryAction` watcher is `immediate`, so `focusCard` has the name before
   `onMounted` clears the query; verify in the browser, and if it misbehaves
   clear only `billing`).
6. **Pricing page context.** `PricingPage.vue` reads `route.query.reason`
   once on mount into a ref (not through `useQueryAction`, which clears it
   before the template can use it, unless the handler copies the value
   first). Known reasons render a strip above the interval toggle:
   `email_quota` → "Tienes {n} facturas esperando en tu correo. Con Pro entran
   hoy y tienes 500 documentos al mes." with `n = auth.profile.emailWaiting`;
   `email_free` → "Las facturas del correo cuentan para tus 25 documentos al
   mes. Pro sube el límite a 500 y revisa el correo cada 6 horas.";
   `scan_limit` → the scan equivalent. Unknown reason → nothing. Add email
   import to the plan items in `pricing.ts`: Free `i11` "Facturas por correo:
   1 buzón, una revisión al día", Pro `i11` "Facturas por correo cada 6
   horas", Max `i3` "Hasta 3 buzones de correo"; update `FREE_ITEMS`/
   `PRO_ITEMS`/`MAX_ITEMS`. Handle `?billing=cancelled` with a quiet note
   ("Pago cancelado. Tu plan no cambió.") and clear it. The existing
   `e2e/tests/pricing/pricing.spec.ts` locates cards by their tagline text,
   so new items don't break it; re-read it anyway.
7. **Triage banner.** `TriagePage.vue`, under the header: when
   `auth.profile.emailWaiting > 0` and `plan !== 'max'`, render
   `<UpgradeNotice reason="email_quota" :count="auth.profile.emailWaiting"
   dismissible>` (dismissal remembered for the session in a module-level ref,
   not localStorage). Members see the text only.
8. **Profile refresh after plan change.** `SettingsPage.vue` already reloads
   the profile on `billing=success`; the EmailCard watcher (step 3) does the
   rest. For a webhook arriving late (the reload still sees `free`), add a
   bounded retry: reload again after 3 s and 10 s while `plan` is still
   `free`, then stop.
9. **Typecheck** the app with `npm run typecheck` in `app/` — a missing `en`
   key is a compile error by design.
10. **Payment-problem line (G8, the app side).** In `SettingsPage.vue`'s Plan
    card, when `auth.profile.billing.status === 'past_due'`, show a coral line
    `settings.plan.paymentProblem` ("Hay un problema con el cobro de tu
    suscripción. Actualiza tu tarjeta para no perder tu plan." / en) directly
    above the existing "Gestionar suscripción" button (it opens the Stripe
    portal, where the card is fixed). Owner only (the card already is). Both
    locales. No e2e (billing is not configured in the emulator); the string
    and the condition are covered by the typecheck and the `meSchema` default.

### 3.3 Phase 3 — tests and docs

1. **E2E** (`e2e/`; read `e2e/README.md` "Invariants" first). New spec
   `e2e/tests/settings/email-quota.spec.ts`, desktop-only like the email spec,
   in a fresh location so the fake inbox is free:
   - Add `setScanUsageEverywhere(count)` next to `setPlanEverywhere` in
     `e2e/flows/plan.flow.ts`: same REST PATCH, fields `scanCount` and
     `scanPeriod`. The period must match the restaurant's own month: the
     listing already returns each doc's fields, so read its `timezone`
     (string or absent → UTC) and format `YYYY-MM` with
     `Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' })`
     per doc. No new API route is needed.
   - Flow: `setPlanEverywhere('free')`, `setScanUsageEverywhere(25)`, create
     the fresh location (as the email spec does), connect the fake inbox,
     wait for the paused notice with its count ("7 facturas esperando" — the
     fake inbox yields 7), assert the "Revisión terminada" chip is absent;
     open `/pricing` from the notice's button and assert the context strip
     and the email plan items; back in Settings, upgrade through the dev
     "Cambiar plan (dev)" button (it calls `PUT /billing/plan`, which runs the
     hook; `setPlanEverywhere` would not), assert the paused notice is gone,
     the loader runs and `email.resumed` appears with 7; Triage shows the
     imported documents and no banner. Reset with `setPlanEverywhere('free')`
     only if later specs assume it (they set their own plan; check).
   - Phase 2 step 5's return-to-card can't be exercised end to end (billing
     is not configured in the emulator; the pricing spec asserts the checkout
     placeholder dialog instead). Cover the URL in `billing-units.test.ts`
     and the `?card=email` deep link by visiting `/settings?card=email`
     directly in the new spec.
2. **Docs.** `docs/email-ingestion.md`: update the Status paragraph and
   §Triage integration's "Quota exhaustion pauses" bullet with the plan-
   change hook, the stale-pause clear, `emailQuota` on the restaurant doc,
   `expired` in Settings, the Max mail variant; add a short "Upgrade handoff"
   sub-bullet naming the surfaces (email card, Plan card, Triage banner,
   pricing context strip). `docs/business-model.md` §5 (conversion levers):
   one line on where the "N facturas esperando" prompt now appears. The
   `past_due` decision is recorded by Phase 1 step 6 (billing.ts comment +
   business-model §3).
3. Final gate for the executing session: `tsc --noEmit` (functions), `npm
   run typecheck` (app), `npm run test:unit`. Run the integration and e2e
   tiers only when the user agrees (they stop running emulators).

### 3.4 Phase 4 — the teaser: show what is waiting (G14)

Goal: wherever the paywall appears, the owner sees the actual invoices that
would come in — sender, date, file, and where the snippet says so, vendor and
amount — never just a number. Everything here reuses data the engine already
holds or adds a few output tokens to a call it already makes; no extraction
is spent on a waiting document (that would be level "B", see §4). Depends on
Phase 1 (fields) and Phase 2 (the notice component). Ships as its own commit.
Money fields are involved: read `docs/multi-currency.md` before 4a.1 and 4b.

**4a. Engine**

1. **Stage-1 hints.** `classify.ts`: the verdict gains optional `vendor:
   string | null` (the supplier's trade name as written in the mail, ≤ 60
   chars) and `amount: { value: number; currency: string } | null` (only
   when the subject or snippet quotes a total with a currency symbol or
   code; otherwise null — the prompt must say "never guess"). Extend
   `replySchema` leniently (`.nullable().catch(null)`), the prompt's output
   example and rules (es/en vocabulary: *importe, total, total factura*), and
   `Verdict`. The offline mock (`MOCK_YES` path) derives both from the
   snippet with a regex so the fake inbox yields a few hints for tests and
   e2e. Persist on the `IngestDoc` as `vendorHint` / `amountHint` only for
   accepted messages; a rejected message drops them with its snippet (data
   minimization, same rule as today). Cost: ≈ 15 extra output tokens per
   message, well under $0.0001.
2. **Sender display name.** Next to `senderAddress` in `classify.ts`, add
   `senderName(from)`: the display name before `<…>` with quotes stripped,
   else the address's domain without TLD, capitalised ("Makro", "Coca-Cola
   Europacific Partners"). Pure, unit-tested in `test/email-units.test.ts`.
3. **Waiting list endpoint.** `GET /email/waiting` (api.ts, inside the
   `head === "email"` block; permission `triage` read OR `integrations`
   read, since Triage and the pricing page both call it) returns
   `{ waiting: number, senders: string[], items: WaitingItem[] }` where
   `items` are the restaurant's `accepted` + `deferred_quota` messages across
   all inboxes, newest first, limited to 10, each `{ id, from: senderName,
   subject, receivedAt, attachment: filename | null, kind, vendorHint,
   amountHint }`, and `senders` the distinct display names in order of
   frequency (top 5). Implement in `sync.ts` (next to `inboxCounts`) as
   `waitingItems(rid, limit)`. The query `where("verdict", "in", [...])
   .orderBy("internalDate", "desc")` across inboxes needs a new composite
   index in `firebase/firestore.indexes.json`: `emailIngests (verdict ASC,
   internalDate DESC)`. Add it, and note it in the commit message (indexes
   deploy with the rules). App schema: `emailWaitingSchema` in
   `app/src/lib/schemas.ts`, lenient, with `amountHint` as `{ value, currency }
   | null`.
4. **Mail with names.** `emailQuotaEmail` gains `senders: string[]` (top 3)
   and, when any hints exist, `amountTotal: { value, currency } | null`
   (sum of `amountHint`s that share one currency, else null). Copy, both
   locales: "Tienes 12 facturas esperando en tu correo: Makro, Coca-Cola y 3
   proveedores más." and, with a total, a second line "Suman unos 1.900 €
   que aún no están en tus márgenes." `pauseForQuota` already lists the
   waiting records for the count; take names and hints from the same docs.
   Unit-test the pure mail builder in `test/email-units.test.ts` (names
   joined correctly for 1, 2, 3 and 3+ senders; no total line when hints
   disagree on currency).

**4b. App**

1. **Locked rows.** New `app/src/components/WaitingInvoiceRow.vue`: a
   compact row with a lock glyph, `from`, `receivedAt` (short date), the
   attachment filename or the subject when there is none, and on the right
   `vendorHint`/`amountHint` when present, formatted through
   `app/src/lib/money.ts` in the hint's own currency (never converted — it
   is a hint, not a stored amount). No `view-transition-name`: these are not
   invoices and must not take part in hero transitions (docs/animations.md).
   `UpgradeNotice` gains an optional `items` slot/prop rendering up to five
   rows under its text and a "y {n} más" line when `waiting > items.length`.
2. **Email card and Triage banner** pass the items: the card fetches
   `/email/waiting` when any inbox is `paused` (one call, not per inbox);
   Triage fetches it when `auth.profile.emailWaiting > 0`. Loading state:
   the notice renders without rows until the call answers; a failed call
   leaves the count-only notice (graceful degradation is the rule for
   everything in this phase).
3. **Ghost cards in the Triage queue.** Above the first real card in
   `TriagePage.vue`'s list, render the first three waiting items as ghost
   cards: same width and padding as `InvoiceCard`, dashed border, muted
   text, the 📧 badge, `from`, date, hint when present, and the label
   `triage.waitingLocked` ("Esperando tu plan"). A ghost card is not a link;
   tapping it scrolls to the banner (or opens `/pricing?reason=email_quota`
   for the owner). Reduced motion needs nothing here (no animation). Hide
   ghosts on Max (nothing to upgrade to) — they would read as a bug.
4. **Pricing strip names the senders.** The `email_quota` strip (Phase 2
   step 6) becomes "Hoy entrarían facturas de Makro, Coca-Cola y 3
   proveedores más." using `senders`, and when `amountTotal` exists adds
   "unos 1.900 € que no están en tus márgenes". The page fetches
   `/email/waiting` only when `reason === 'email_quota'`. Count-only copy
   stays as the fallback.
5. **Sums and currency.** A displayed total only sums hints whose currency
   equals the restaurant's base currency (`auth.profile.currency`); mixed or
   foreign hints are shown per row, never summed. The strip and the mail say
   "unos" / "about": hints come from snippets, not from reading the
   document. Strings in both locales; the number goes through the existing
   money formatter, not string concatenation.

**4c. Tests and docs**

1. Integration (`email-ingest.test.ts`): at the cap, `GET /email/waiting`
   returns the deferred messages with `from` as a display name, the fake
   inbox's hint(s) where the mock yields them, `senders` ordered by
   frequency, and a 403 for a member without `triage` or `integrations`.
   Hints are absent on a `classified_no` record.
2. E2E (`email-quota.spec.ts` from Phase 3): assert at least one locked row
   with a sender name under the paused notice, a ghost card at the top of
   Triage with "Esperando tu plan", and the sender names in the pricing
   strip; after the upgrade, no ghost cards remain.
3. Docs: `docs/email-ingestion.md` §AI classification funnel (stage 1 output
   now carries hints; what is kept per verdict) and the new index;
   §Triage integration's "Upgrade handoff" bullet lists the teaser surfaces.
   `docs/business-model.md` §5: the prompt now names suppliers and amounts.

### 3.5 Phase 5 — onboarding: invite the owner to connect an inbox (G15)

Goal: a new owner is told, at the moments they are setting things up, that
invoices can arrive by themselves — and can connect right there. Three
surfaces, in order of value: the setup done screen, Triage's empty state, a
tour beat. Honest copy about the Free cap, owner-only buttons, and nothing
shown until Gmail is verified.

**The gate (applies to every surface in this phase).** The Gmail OAuth client
is in Google's "Testing" status until verification lands (`GMAIL_OAUTH_TESTING`,
`gmail.ts testing()`): the consent screen warns "unverified app", grants
expire after 7 days, ≤ 100 test users. None of these prompts may render in
that state. Add to `GET /me` a `features: { emailImport: boolean }` block,
computed in `api.ts` from the email registry with no reads:
`MAIL_PROVIDERS.some((p) => emailAvailable(p) && !providerInTesting(p))`
(both helpers exist in `email/index.ts`). `meSchema` adds `features:
z.object({ emailImport: z.boolean().catch(false) }).catch({ emailImport:
false })`. Every surface below renders only when
`auth.profile.features.emailImport` is true AND `auth.can('integrations',
'edit')` (the owner always can; a member who may not connect is never
prompted). In the emulator the fake inbox makes `emailAvailable` true and
`testing()` false unless `GMAIL_OAUTH_TESTING` is set, so the e2e sees the
prompts.

**5a. Land on the email card after connecting, from anywhere.** Today the
callback (`oauth.ts oauthReturnUrl`) returns to `/settings?email=complete&…`
and `EmailCard` finishes the connection and auto-starts the backfill. Keep
the single completion handler; append `card=email` to every return URL
(complete, denied, invalid_state) so Settings scrolls to and rings the card
(`useQueryAction('card')` already does this). Check `EmailCard.vue onMounted`:
it strips the query when `email` is present (`router.replace({ query: {} })`)
— make it keep `card` for a tick, or run the card focus before the strip (same
race as Phase 2 step 5; the `useQueryAction` watcher is `immediate`, so
`focusCard` has read the name already — verify once in the browser). No new
completion handler on the setup page: landing on Settings with the card
focused and the counter running is the intended outcome.

**5b. Setup done screen.** `RestaurantSetupPage.vue`, phase `done` (~line
830): under the title and body, a bordered block "📧 ¿Te llegan facturas por
correo? Conéctalo y entran solas." with one line of honest copy ("Teremu
revisa los últimos 31 días y después solo el correo nuevo. Gratis incluye 25
documentos al mes; el resto espera a que mejores tu plan.") and a `BaseButton`
"Conectar Gmail" that calls `POST /email/gmail/connect` and follows the URL,
exactly as `EmailCard.connect()` does (extract that into a small composable
`app/src/composables/useEmailConnect.ts` — `connect(provider)` returning the
error code — and use it from both; `posConnectSchema` is the response
schema). The existing Pulse / menu / recipes buttons stay. Strings in
`i18n/locales/pages/setup.ts` under `setup.done.email.*`, both locales. The
block is hidden when an inbox is already connected: the done screen fetches
`GET /email` once (only when the gate is on) and hides the block if
`inboxes.length > 0`. The copy must say the inbox can be a different account
from the one used to sign in ("puede ser otra cuenta distinta de la que usas
para entrar").

**5c. Triage empty state.** `TriagePage.vue` ~line 134: when the gate is on,
the queue is empty (`store.pending.length === 0`) and the user may connect,
fetch `GET /email` once; if no inbox is connected, render under `triage.empty`
a second line + button: "¿Te llegan facturas por correo? Conéctalo y entran
solas en Revisar." / "Conectar Gmail" (same composable). If an inbox IS
connected and `working`, say so instead ("Tu correo se está revisando; las
facturas aparecerán aquí.") with a link to `/settings?card=email`. Strings in
`i18n/locales/pages/triage.ts`. Once per session is enough: do not refetch
on every empty render (a module-level cached promise, like Phase 2's Triage
banner dismissal).

**5d. Tour beat.** `OnboardingWizard.vue`: a new beat `email` after `scan`
(`STEPS`, `ICONS['email'] = '📧'`), informational only (no button — the tour
is a modal and the connect is a redirect). Copy (`onboarding.ts
steps.email.*`): title "Facturas por correo, sin escanear", body "Conecta el
correo donde te llegan las facturas de tus proveedores: Teremu revisa los
últimos 31 días y después cada correo nuevo, y las facturas aparecen en
Revisar solas. Está en el plan Gratis (cuentan para los 25 documentos al
mes)." The beat is included in `STEPS` only when the gate is on (compute
`STEPS` from `auth.profile.features.emailImport`; the `plans` beat's
`freeItems` / `proItems` lines gain "correo: 1 buzón" / "correo cada 6 h").
The step indicator and `last` already derive from `STEPS.length`.

**5e. Tests and docs.**

1. Integration: `GET /me` carries `features.emailImport` true in the emulator
   and false when `GMAIL_OAUTH_TESTING=true` is set for the request (set and
   unset `process.env` inside the test — the API reads it per call).
   Callback URLs end in `&card=email` (extend the existing OAuth test in
   `test/email.test.ts` that asserts the redirect).
2. E2E: the tour is suppressed by `fixtures.ts` (it clicks "Omitir" on
   sight) and finished for real in `auth.setup.ts`, so 5d is not e2e-tested;
   cover it with a component-level check only if one exists for the wizard
   (none today — skip). Extend `e2e/tests/setup/listing.spec.ts`'s done
   screen assertion (or add a case) for the email block and its honest copy;
   add to `e2e/tests/triage/` an empty-queue case in a fresh location
   asserting the connect prompt, then connect through it and assert the
   browser lands on Settings with the email card focused and the counter
   running (reuse the email spec's selectors). Desktop-only, fresh location,
   same reasons as the email spec.
3. Docs: `docs/email-ingestion.md` §Going live after Phase 0: the onboarding
   prompts switch on with verification (the `features.emailImport` gate), so
   flipping `GMAIL_OAUTH_TESTING` off is what turns them on — say so in the
   runbook line. `docs/business-model.md` §5: email import joins the listing
   import and the menu wizard as an activation step, with the Free-cap copy
   rule.

**Not in this phase (business decision, note only):** a one-time onboarding
allowance so the first 31-day backfill comes in whole and the 25/month cap
applies from the second month. It changes Free economics (≈ +$0.10 per
activated restaurant at measured scan cost) and belongs in
docs/business-model.md §3 before any code.

## 4. Out of scope (noted, not planned)

- **Level "B": pre-extract waiting documents and show them locked.** Read the
  deferred documents anyway (bounded, e.g. ten a month on Free), store them
  as invoices in a new locked status, show vendor, date and total in Triage
  with no approve button, flip to review on upgrade. Strongest possible
  teaser ("Teremu ya leyó tus 12 facturas: 2.340 € que no están en tus
  márgenes") and an instant handoff, at ≈ $0.03/restaurant/month. Not in
  this plan: it needs a new invoice status in both schema files, locked
  rendering in Triage and the detail page, meter bookkeeping for extracted-
  but-uncharged documents, and it hands Free users information the business
  model reserves for the 25 scans. Decide after seeing conversion from
  Phase 4.

- G10 downgrade with extra inboxes: leave syncing; a later change could mark
  the newest inboxes beyond the limit "over plan" and show it. Not now.
- Making a paused inbox sync at the plan cadence instead of hourly. Rejected:
  the hourly retry is how a Firestore-side plan change or the month turning
  is noticed without a hook (G13); its cost is one Gmail history call per
  hour and classification the inbox would do anyway, and the hook makes the
  upgrade case immediate regardless. Keep `syncDue` as it is.
- Pub/Sub push for near-real-time ingestion.
- A second mail on resume: the app shows it; no mail.
- Migrating the team-limit message (`settings.members.limit`) to the notice
  component is optional polish; do it only if it falls out naturally.
