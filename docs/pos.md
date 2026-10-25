# POS integrations (Square first)

Status: **Phases 1–3 implemented (Foundation 2026-10-05, Catalog + marriage 2026-10-10, Ingestion + projection 2026-10-15; webhooks replaced by a smart poll 2026-10-17); Phases 4–5 are design.** As of 2026-10-15 the whole tree typechecks and `npm run test` passes (20 files / 220 tests), including `test/pos.test.ts`, `test/pos-catalog.test.ts`, `test/pos-orders.test.ts`, `test/pos-ingest.test.ts` and `test/pos-adapter.test.ts`. The 2026-10-17 poll switch (webhooks removed, tests rewritten onto "sync now") typechecks, and `npm run test` passes again on 2026-10-17 (20 files / 210 tests). Everything is verified against the deterministic mock provider only: nothing has run against a live Square account yet (see §Verify against live Square docs for what the docs settled and what still needs a Spanish sandbox). See §Built so far and §Phase 3. First market: **Spain** (Square operates there; prices are IVA-inclusive). First provider: **Square**. The design is provider-agnostic: Square is the first *adapter*, not the architecture — `architecture.md` anticipated "POS integration (Square/Toast webhook → `POST /revenue`)"; this doc is how that lands without wiring Square-isms into the core — and without webhooks (§Order ingestion).

Read this before touching any POS/integration code. Companion docs: `architecture.md` (tenancy: restaurant = location, per-location billing), `multi-location-plan.md`, `llm.md` (the matcher's LLM assist goes through `llm.ts` like everything else).

## What the Phase 1–2 commit contained (historical — the tree now builds as a whole)

This commit lands **Phases 1–2 only**, and it was split out of a working tree
that *also* held an in-progress assistant rewrite. Two consequences to know
before you build on it:

- **It is not a standalone-buildable checkpoint.** `api.ts`, `models.ts` and
  `app/src/lib/schemas.ts` were edited by both efforts in the same regions. To
  keep this commit free of assistant code, the POS additions here were staged
  on top of the *old* assistant route/schemas (which the assistant work
  removes). The repository compiles only with the still-uncommitted assistant
  changes applied on top; this commit on its own will not typecheck. The
  typechecks and tests referenced below should be run on the combined tree,
  not on this commit in isolation.
- **Committed:** the whole `firebase/functions/src/pos/` engine (types, mock +
  Square adapters, connections, catalog/matcher, crypto, money), the
  `GET/POST/PUT/DELETE /integrations*` routes and `posOauthCallback` + `posDaily`
  functions, the `integrations` perm area and plan gate, the `IntegrationsCard`
  + `PosLinksPage` UI with its i18n, the import-as-dish wizard seeding, and the
  `pos`/`pos-catalog` tests. See §Built so far for the per-phase detail.
- **Still missing (not in this or any commit yet):** Phases 3–5 — order
  ingestion/projection (`revenueSource`, `posWebhook`, reconciliation, backfill,
  the dirty-day projector with delta pantry depletion, unattributed surfacing in
  Pulse), hardening (reauth flows, downgrade-pause, price-drift warnings,
  modifier flagging), and the Later items. Plus the pre-deploy chores and the
  live-Square verification checklist at the end of this doc — all unverified.

## Principles

1. **One adapter boundary, like `llm.ts`.** All provider traffic lives in `firebase/functions/src/pos/providers/<provider>.ts` behind a common interface. The engine (connections, catalog sync, matcher, order sync, projector) never sees provider HTTP, field names, auth schemes or event names — and never branches on a provider name. See §Adding a provider.
2. **Ids, never names.** Every cross-system reference is `provider` + `externalId`. Names are display data that drifts.
3. **Raw orders are the source of truth; everything downstream is a rebuildable projection.** Normalized orders are stored immutably (upserted only by provider version); revenue entries, dish attribution, and pantry depletion are *derived* and can be regenerated for any (restaurant, business day) at any time. This one commitment is what makes late mappings, refunds, mapping corrections, and attribution bug-fixes all the same cheap operation: mark the day dirty, rebuild it.
4. **Money is integer minor units (cents) + currency code inside the POS layer.** Convert to the app's float amounts in the restaurant's **base currency** (`docs/multi-currency.md`) only at the projection boundary (existing `revenueEntry` shape). A POS location selling in a currency other than base cannot be bound (`409 currency_mismatch`); POS revenue with its own currency and rate is a Later item there. Revenue for margin math is **net: gross − discounts − IVA, tips excluded entirely**.
5. **Everything works offline.** No connection → deterministic mock provider (the offline-mock pattern OCR uses without `NVIDIA_API_KEY` — but deterministic, unlike OCR's randomized mock, so tests can assert on it). The mock can also simulate a revoked grant (`posMockRevoked/{merchantId}`), so every path is testable offline.

## Provider abstraction

```
firebase/functions/src/pos/
  types.ts            THE contract: PosAdapter, PosProviderModule, normalized types
  index.ts            provider registry (typed against the vocab), adapter selection, secrets
  providers/
    square/           Square — the only folder that knows Square
                      (config, client, auth, catalog, orders, types)
    mock.ts           deterministic stand-in for ANY provider (offline + tests)
  store.ts            shared persistence + credentials (refresh, needs_reauth)
  crypto.ts           credentials at rest (AES-256-GCM key ring)
  connections.ts      connect / locations / disconnect           (engine)
  catalog.ts          catalog sync, link table, review queue     (engine)
  matching.ts         pure matcher + LLM tier                    (engine)
  money.ts            minor units → base-currency floats
  orders.ts         raw orders + the smart poll                (Phase 3)
  days.ts, project.ts  business days, dirty-day projector       (Phase 3)
```

The adapter contract (`types.ts`; Phase 3 methods marked):

```ts
interface PosAdapter {
  connect: PosConnectFlow                    // how a merchant authorizes — see below
  refresh?(credentials): PosCredentials      // optional: absent = never refreshes
  revoke?(merchantId, credentials): void     // optional, best effort
  listLocations(credentials): PosLocation[]  // externalId, name, timezone, currency, active
  fetchCatalog(credentials, locationId): PosCatalogItem[]
  listOrders(credentials, locationId, { since, cursor }): { orders: PosOrder[], cursor }   // Phase 3 — the only order read
}
type PosConnectFlow = { kind: "oauth"; authUrl(state, redirectUri); exchangeCode(code, redirectUri): PosGrant }
                    // a provider whose access is granted on ITS side (partner marketplace toggle,
                    // pasted key) becomes a second `kind` — the engine dispatches on kind, never provider
interface PosCredentials { secret: Record<string, string>; expiresAt: number | null }   // opaque to the engine
```

Normalized types (all money in minor units):

- `PosCatalogItem` — `{ externalId, groupExternalId, name, priceMinor | null, currency }` — the sellable grain a sale line points at (Square: item variation; the group is the parent item). Modifiers join as a `kind` when modifier mapping lands (Later).
- `PosOrder` — `{ externalId, locationExternalId, state, closedAt (UTC), revision, currency, lines[], refundedMinor }`. `revision` is adapter-supplied and only ever compared for "newer": Square's integer `version`; a provider without one supplies its last-modified time.
- `PosOrderLine` — `{ externalLineId, catalogExternalId | null, name, qty (decimal — weight-sold items exist), grossMinor, discountMinor (line share incl. prorated order-level discounts), taxMinor, netMinor, modifiers: [{ catalogExternalId, name, netMinor }] }` — the adapter does the provider's tax/discount arithmetic; the engine only ever reads net.

Vocabulary (in `shared/src/vocab.ts`, per the schemas rule): `posProviderSchema = z.enum(POS_PROVIDERS)`; `revenueSourceSchema = z.enum(["manual", "pos"])` (Phase 3, with its first user); and an `integrations` area in `permsSchema` (`none | read | edit` — read: see status and mappings; edit: connect, disconnect, map; owners bypass as usual).

### Adding a provider

The registry in `pos/index.ts` is `{ square } satisfies Record<PosProvider, PosProviderModule>`, so the steps are enforced by the compiler, not by memory:

1. `shared/src/vocab.ts`: add the id to `POS_PROVIDERS`. (Build now fails until 2.)
2. `pos/providers/<id>.ts`: export a `PosProviderModule` — `{ adapter, configured(), secrets }`. Its secrets are declared there with `defineSecret` and flow into `POS_SECRETS` automatically. Env config only (base URL, API version); never hardcoded in callers.
3. `pos/index.ts`: one line in `PROVIDERS`.
4. `app/src/i18n/locales/components/integrations.ts`: the display name under `provider.<id>` in `es` and `en`.
5. Register the shared OAuth callback URL in the provider's dashboard (OAuth providers only); add the provider's facts to a verify checklist here. No webhook to register: ingestion polls.

Nothing else changes: routes take `:provider`, the Settings card and the review page render whatever `GET /integrations` lists, the mock covers every provider in tests, and data is keyed `provider + externalId` everywhere. A provider that can't do something the contract needs is the signal to extend the *contract* (a new `connect.kind`, an optional method) — never an `if (provider === …)` in the engine.

### Toast (researched 2026-10-14 — not built)

Toast has no per-merchant OAuth redirect. There are two supported ways in, plus two rejected ones.

**1. Standard API access — preferred.** A restaurant creates **read-only** API credentials itself in Toast Web (Integrations → Toast API access → Manage credentials → *Standard API*). Requirements: an active employee of the location with the **Manage Integrations** permission, and every location on **Toast RMS Essentials or higher** (locations below that show locked). Toast shows the API subdomain, client ID and client secret immediately; the secret is shown once. A credential set can cover one location or several in the management group, and every request addresses one location. No partner approval is needed. Write access is not available, so Teremu cannot accidentally change anything. (Analytics API access is a separate credential type for higher packages; not needed here.) Sources: [overview](https://doc.toasttab.com/doc/devguide/devApiAccessUserGuide.html), [credentials](https://doc.toasttab.com/doc/devguide/devApiAccessCredentials.html), [requirements](https://doc.toasttab.com/doc/devguide/devApiAccessRequirements.html), [FAQs](https://doc.toasttab.com/doc/devguide/devApiAccessFAQs.html).

This maps onto the contract as a second `connect.kind`, e.g. `{ kind: "credentials"; fields: [...]; validate(input): PosGrant }`. The Settings card renders a paste form with copy-through instructions instead of a redirect, and the adapter exchanges client ID + secret for a short-lived token on every use, so it implements neither `refresh` nor `revoke`. The pasted secret is sealed like any other credential (`crypto.ts`). `merchantId` = the credential set (it already scopes which locations we can see); location = Toast restaurant GUID. The engine still never learns it is Toast. The consent-phishing rule still applies: the paste is only accepted from a signed-in user with `integrations:edit`.

**2. Partner integration (marketplace).** The restaurant enables Teremu in Toast's integrations portal, and one partner credential then reaches every restaurant that enabled it, each addressed by a restaurant GUID. This fits as a third `connect.kind` (pick your restaurant from the ones that granted access). It is gated on acceptance into Toast's partner program, which is slow; worth applying early, but not a blocker if path 1 is allowed.

**Rejected** (for every provider, Square included, where a real OAuth API makes it pointless anyway — and "the subscriber consented" does not fix it: the owner can share their own data but cannot waive the POS vendor's terms, which typically forbid automated dashboard access and shared logins, and it is the owner's account that gets suspended)

- **"Invite Teremu as a read-only team member."** This only grants a person's login to Toast Web, not API access. A read-only member also lacks Manage Integrations, so it cannot create API credentials. Getting data out would mean a bot accepting the invite, holding a login per restaurant, handling 2FA and scraping the dashboard. That is fragile, likely against Toast's terms, and puts the restaurant's account at risk. If an owner wants to invite us, path 1 asks the same owner for three pasted values instead.
- **Emailed reports via an inbound address.** Toast cannot email the Product Mix report on a schedule ([Toast support](https://support.toasttab.com/en/article/Request-to-Send-Product-Mix-Report-by-Email), updated 2026-03-26; logged as a feature request). The **nightly data export** does include a "Product Mix (All Items)" file plus order/payment files, delivered after each location's closeout (default 04:00) and kept for 7 days, but it must be enabled through Toast Customer Care and arrives over SFTP ([data exports](https://support.toasttab.com/en/article/Automated-Nightly-Data-Export-1492723819691)). It is a possible fallback for restaurants below RMS Essentials, not the main path. It also breaks the "ids, never names" principle unless the files carry item GUIDs (unverified).

Order revisions differ from Square, which is why `revision` is adapter-defined. Ingestion is a poll for every provider, so whether Toast's Standard API credentials can receive webhooks no longer matters.

**Market caveat:** as far as we know, Toast operates in the US, Canada, the UK and Ireland, not Spain. Toast therefore follows Square, which stays first for the Spanish launch.

## Identity & connections (merchant ≠ restaurant)

Credentials are per **merchant**; a merchant owns several POS **locations**; a Teremu restaurant *is* one location. So the connection is modeled at merchant level with per-restaurant references:

- `posConnections/{provider}_{merchantId}` (top level): sealed credentials, status (`active | needs_reauth`), expiry, `restaurantIds`, and `locations` (location → rid bindings). One doc per merchant no matter how many restaurants attach to it — refresh runs once per merchant, and two Teremu restaurants under one POS account never store duplicate credentials.
- `restaurants/{rid}/integrations/{provider}` (one doc): pointer to the connection, the chosen `locationExternalId`, an **epoch** counter, sync cursors, settings (`businessDayCutoff`, default `04:00`), status, `catalogSyncedAt`, `lastSyncAt`.

Rules that keep this honest:

- **OAuth `state`** is a single-use random doc (`posOauthStates/{nonce}`, short TTL) binding `{ provider, rid, uid }`. One callback function serves every OAuth provider. **The callback never completes the connection**: a state proves which flow this is, not who is holding the browser — someone could start a flow on their own restaurant and forward the consent link to a real merchant, attaching that merchant's sales to the wrong restaurant. So the callback hands `state` + `code` back to the app, and the **signed-in** user completes it (`POST /integrations/oauth`), which is refused unless the caller is the user who started the flow. (Native: in-app browser + app scheme, not a popup — still open.)
- **Reconnect to a *different* merchant bumps the epoch.** Catalog ids are per-merchant, so every link and cursor carries the epoch it was created under; a merchant change archives (not deletes) all links/cursors of the old epoch in one query. Same-merchant reconnect keeps the epoch — links survive.
- **Disconnect is per restaurant**: remove the restaurant's integration doc reference and pause its sync. Revoke the merchant token only when the *last* restaurant referencing that connection disconnects. **Synced sales are retained** — they are the restaurant's own history; UI copy states this. Full purge rides the existing `DELETE /restaurants/:rid` recursive delete (posOrders/posLinks live under the rid); that handler must also drop the connection reference (and revoke if last).
- **Revocation from the provider side** shows up as a `PosAuthError` on the next adapter call — Square: a 401 — and the poll makes one at least every 30 minutes, so it is noticed within that. It flips the connection to `needs_reauth` — surfaced as a reconnect banner in Settings and a `sendMail` alert to the owner. Sync pauses; nothing errors loudly in the background forever. The state lives on the connection only, so one reconnect heals every restaurant on that merchant.
- **Credential encryption**: AES-256-GCM with a key from Secret Manager (`POS_TOKEN_ENC_KEY`, `defineSecret` like Stripe's in `billing.ts`); ciphertext is prefixed with a key version so rotation is decrypt-with-old / encrypt-with-new, no big-bang. A daily job refreshes credentials expiring within 7 days (for adapters that refresh) and re-seals anything under an old key.

Timezone/currency synergy: at connect time, populate `restaurants/{rid}.timezone`/`currency` from the POS location if unset (the fields `multi-location-plan.md` reserved).

## The link table (menu marriage)

`restaurants/{rid}/posLinks/{provider}_{externalId}` — one doc per catalog item, keyed by id (stable across renames), fields: `provider, epoch, externalId, groupExternalId, externalName, priceMinor | null, currency, status: unmapped | auto | confirmed | ignored, menuItemId | null, matchedBy: exact | fuzzy | llm | manual | null, candidates: [{ menuItemId, score, by }], noAuto, removedAt | null, firstSeenAt, updatedAt`.

- **Mapping state and catalog presence are separate.** `status` is the mapping; `removedAt` says the item left the POS catalog (kept — past sales still point at it — and restored if it comes back). A removed item keeps its mapping.
- **Epoch archival is a query, not a migration**: every read filters `provider == p && epoch == current` (two equalities, single-field indexes), so a different merchant's links simply stop counting the moment the epoch bumps; a sync that meets an old-epoch doc with the same id starts it fresh.
- **`noAuto`**: set when the owner unlinks. The matcher keeps suggesting that dish but never auto-links it again — otherwise an exact-name match the owner rejected would re-link on the next sync.
- **One write path** (`writeLinks` in `catalog.ts`): Phase 3 hooks "mapping changed → mark business days dirty" there, once.

- **Grain: item variation ↔ menu item, many-to-one allowed** ("Burger — Grande" and "Burger — Normal" may share a dish, but the queue nudges toward one dish per size — different sizes have different plate costs, which is Teremu's whole point).
- **Combos** (menú del día, burger+fries+drink as one catalog item): map to a single Teremu dish whose recipe is composed of **sub-recipe lines** (already supported by `recipeLineSchema`). No weighted one-to-many split in v1; if it's ever needed it is a projector-only change because attribution is recomputed from raw orders.
- **Modifiers**: normalized order lines carry modifier sub-lines with their own ids and money. v1 folds modifier net revenue into the parent dish's line and tracks per-dish "modifier revenue %" so dishes where modifiers are significant get flagged as *costs unmodeled*. The link table already keys any catalog object, so a later phase can map `modifier → ingredient / sub-recipe` without schema changes.

### Matcher

Deterministic first, ranked tiers; both name sets come off the same printed menu (menuscan on one side, the POS catalog on the other), so hit rates should be high:

1. **Normalize**: lowercase → NFKD + strip diacritics (Spanish accents must fold) → strip punctuation → drop stopwords (`de la el los las con y al del`) → token set.
2. **Tier 1 (auto-link, `status: auto`)**: exact normalized equality with **exactly one** *active* menu item. Ambiguity (two dishes normalize the same, e.g. an active dish plus its abandoned twin) **never auto-links** — it queues with candidates listed.
3. **Tier 2 (suggestion)**: high token-overlap / small edit distance. **Price is a tiebreaker only, never a gate** — both sides are IVA-inclusive in Spain so they're comparable, but sizes/rounding make price too noisy to trust; weight name ≫ price.
4. **Tier 3 (LLM assist)**: one batched call through `llm.ts` (mock offline) proposing matches for the residue. LLM output is only ever a *suggestion*; it cannot auto-link.

Matching is a pure, idempotent function over (unlinked links × active dishes): it fills `unmapped → auto/suggested` and **never touches `confirmed` or `ignored`**. It runs on connect, on every catalog sync, on menu-item create/rename, and via a manual "buscar coincidencias" action in the queue — so dishes created after connect day still get matched.

### Review queue

Triage-pattern UI: confirm suggestion / pick another dish / **import as new dish** / **ignore**. Import is nearly free: the catalog gives name + price and `draftRecipes` (menuscan.ts) already turns dish names + pantry catalog into estimated recipes — connecting a POS becomes an alternative onboarding path to photographing the menu. `ignored` (bottled water, merch, delivery fees) still counts in the unattributed bucket so totals always tie out with the POS dashboard.

### Link lifecycle

- Catalog sync: rename → same id, refresh `externalName` (link survives); delete → `removedAt` set (kept for history); new object → enters queue; price change → "menu price drift" warning (Teremu price vs POS price), since actual charged amounts drive revenue but the drift signal helps the owner.
- **Dangling target**: if the linked menu item is deleted/deactivated, the matcher (which runs on every dish save) sends the link back to the queue, and projection sends any sales on it to the unattributed bucket with reason `stale_link`. This matters because `expandUsage` (`app/src/lib/domain.ts`) silently drops unknown `menuItemId`s — without the guard, mapped-to-deleted sales would vanish from margins without a trace.
- Confirming or unlinking a mapping marks the affected business days dirty → history re-attributes automatically (see Projection).

## Order ingestion

**No webhooks — a smart poll** (decided 2026-10-17). A dashboard of margins does not need sub-minute freshness, and polling removes a public endpoint, a signing secret, the byte-exact notification-URL trap, and a second ingestion path to keep consistent. The revision guard and the overlap window already made the poll correct on its own; webhooks were only ever a latency optimization. Nothing else needed them: revocation surfaces as a 401 on the next poll (see §Identity), and catalog changes are caught as described below. Reintroducing push later would be one optional adapter method feeding the same `ingestOrders` — nothing else would change.

- **One read**: `listOrders(since, cursor)` — orders whose provider *updated* time is ≥ `since`, oldest change first (a refund days later updates the order, so it is found). Square: `SearchOrders`, `COMPLETED` only, sorted by `UPDATED_AT`.
- **Upsert is revision-guarded**: `restaurants/{rid}/posOrders/{provider}_{orderId}`, applied only if the incoming `revision` is newer. Re-reading an order is a no-op, so overlapping windows are free. Refunds/voids arriving days later are just another revision — the order's day goes dirty and rebuilds.
- **Adaptive cadence** (`orders.ts`): `posSync` ticks every 5 minutes, but each restaurant is polled only when its own `orderSync.nextPollAt` is due. A pass that stored something new keeps the next poll 5 minutes out; each quiet pass doubles the wait, capped at 30 minutes (5 → 10 → 20 → 30). A restaurant in service is ≤5 minutes behind, a closed one costs two calls an hour, and the first sale of the morning is picked up within 30 minutes. Mid-pass (more pages pending) is always due on the next tick. "Sincronizar ventas" (`POST …/orders/sync`) polls immediately.
- **Overlap**: each pass's next `since` is its own start minus 10 minutes, so an order changed while a pass ran is still caught.
- **Daily deep pass**: once every 24 h a pass reaches 72 h back instead — Square accepts orders taken on a POS in offline mode up to 72 h late. Unverified whether such orders carry a late `updated_at` (then the normal poll catches them anyway) or keep the offline time (then only this pass does).
- **Catalog freshness without catalog webhooks**: the daily `posDaily` sync, plus — when a poll stores a sale whose catalog id is not in the link table — an immediate catalog sync (throttled to one per hour). A newly added dish reaches the review queue the hour it is first sold.
- **Backfill** (initial import, default 90 days): the same mechanism. The first pass starts 90 days back; every page is checkpointed on the integration doc, a few pages per tick, until caught up. No single invocation ever tries to swallow a year of orders. Binding a location runs the first 2 pages immediately.
- **Projection runs every tick** for every bound restaurant (one empty query when nothing is dirty), so days dirtied by a mapping change are rebuilt within 5 minutes even when no poll is due.
- **Cost/limits**: one `SearchOrders` call per due restaurant (up to 500 orders per page). Square documents no hard per-seller rate limit beyond 429 backoff; at ≤12 calls per restaurant per hour we are far below anything that would throttle.
- posOrders growth is bounded per the repo's existing stance (time-windowed reads, rollups over raising limits): daily revenue entries *are* the rollup; consider a Firestore TTL policy on `posOrders` (e.g. ~13 months) once as-of costing (below) settles what history it needs.

## Money & tax (Spain)

- Per line: `netMinor = grossMinor − discountMinor − taxMinor`. Order-level discounts must arrive prorated per line from the adapter (Square provides per-line totals; verify semantics — see checklist). Tips never enter any number.
- Margin revenue is **IVA-exclusive**. Consistency follow-up (pre-existing, exposed by this work): plate costs from scanned invoices should also be IVA-exclusive (base imponible) since hostelería reclaims input IVA — audit what OCR currently stores and reconcile, or dish margins mix inclusive costs with exclusive revenue.
- The float-euro conversion happens exactly once, in the projector, when writing the `revenueEntry`.

## Projection → revenue entries (and the pantry)

`revenueEntry` (`itemsSold: [{menuItemId, qty}]`) is exactly what POS ingestion produces — the integration automates what owners type into Pulse today. Changes to the entity (both `models.ts` strict and `app/src/lib/schemas.ts` lenient, mirrored by design): `source: 'manual' | 'pos'` (default `manual`), and for pos entries `provider` plus an explicit `unattributed: { amountMinor → amount, count }` breakdown.

- **Business day**: computed *in the projector* (never stored on raw orders) as `closedAt` in the restaurant's timezone minus the `businessDayCutoff` (default 04:00 — late-night service belongs to the prior day). Changing tz/cutoff just dirties the affected window and rebuilds.
- **Dirty-day rebuild**: `restaurants/{rid}/posDays/{provider}_{YYYY-MM-DD}` tracks `dirty | projected` + the produced revenue-entry id. Any trigger (order upsert, mapping change, cutoff change, attribution fix) marks days dirty; a worker rebuilds each dirty day **deterministically from posOrders + posLinks** — same inputs, same output, safe to re-run forever.
- **Pantry depletion must be delta-based.** `POST /revenue` depletes theoretical pantry via recipes (architecture.md), so a rebuild cannot blindly re-deplete. The projector upserts the day's pos entry by computing the `itemsSold` **delta versus the previous version of that entry** and applying the corresponding pantry delta in the same atomic batch. (This is the one place POS work touches existing revenue plumbing — factor the depletion math so manual create/update/delete and the projector share it.)
- **The unattributed bucket is explicit, not implicit.** Entry `amount` = the day's full net POS total; `itemsSold` covers mapped lines; `unattributed` carries the remainder (unmapped + ignored + stale-link + no-catalog-id custom amounts). Pulse shows it ("X € en N líneas sin asignar — revisar") linking into the queue. If Teremu's total ever disagrees with the POS dashboard, owners stop trusting the margins — tie-out is a feature.
- **Manual collision**: for dates/locations covered by an active POS connection the manual revenue form warns (or blocks) — otherwise double-counting. Manual entries elsewhere stay untouched; the projector only ever owns entries with `source: 'pos'`.

## COGS timing

v1: margins use current rolling `lastUnitPrice` — the status quo, identical to manual entries today. v2 (enabled by the raw-order store, no snapshots needed): **as-of costing** — ingredient cost effective on the sale's business day, derived from dated invoice history; deterministic and rebuild-stable, unlike snapshotting which a rebuild would silently rewrite. v2 is an analytics change (`domain.ts`), not an ingestion change.

## Plan gating

Integrations are on **every plan, per location** (2026-10-20 — previously Pro+), with Free **capped** through `PLAN_LIMITS` in `plan.ts`:

- `posPollMinutes` — the sales-poll floor: Free 60, Pro/Max 5. Once a pass is complete `nextPollDelay` never goes below it (a floor above `POLL_MAX` is flat), and `POST …/orders/sync` returns `429 pos_sync_throttled { retryAt }` while the latest pass — finished (`lastSyncAt`) or still in flight (`orderSync.passStartedAt`) — is younger than the floor (`syncNowRetryAt`; plans at the 5-min floor are never held). A pass still in flight resumes every tick on every plan: the initial 90-day import finishes in hours for Free too, so the cap is on freshness, not on seeing one's own history. A Pro→Free downgrade takes effect at the next completed pass (one last 5-min poll at most).
- `posAiMatching` — the matcher's LLM tier on bind, "Sincronizar catálogo" and "Buscar coincidencias": Free runs only the deterministic tiers.

Running cost per connected restaurant is cents a month (Firestore reads/writes); the cap exists for the serial `posSync` loop and unmetered LLM calls, not storage. There is deliberately no plan-level on/off switch (the old `limits.integrations` lever was removed once every plan had it): if a restaurant's sync ever has to be paused — abuse, a merchant revoked upstream — that is a per-restaurant flag on the integration doc, not a plan limit. Permission checks use the `integrations` area on every route.

## Dev & testing

- **Mock provider** (`pos/providers/mock.ts`): deterministic catalog + orders so connect → map → project → Pulse works fully offline in the emulators, per repo rule.
- **Sandbox**: Square's sandbox (`connect.squareupsandbox.com`) via env config — never hardcode the base URL in callers (same rule as `llm.ts` providers).
- **Simulated POS changes**: tests write `posMockOrders` / `posMockCatalog` / `posMockRevoked` and call "sync now" — exactly what the next poll would see.
- **Unit tests** (`firebase/functions/test/`): matcher normalization/tiers/ambiguity-refusal; version-guarded upsert idempotency (overlapping polls re-reading the same order); poll cadence/backoff; projector determinism (same inputs → same entry) and pantry **delta** on rebuild; net-money math incl. prorated discounts and decimal qty; token encrypt/decrypt round-trip + key-version rotation; OAuth state single-use; epoch archival on merchant change.
- **i18n**: all new strings in a per-feature `integrations` locale module, `es` authored first, `en` mirrored same change.

## Built so far

Where the code settled details the design left open (module map in §Provider abstraction).

**Phase 1 — Foundation**

- **Adapter selection** mirrors `llm.ts`: `TEREMU_TEST_MOCKS` → mock; provider credentials configured (`PosProviderModule.configured()`; Square: `SQUARE_APP_SECRET` — the production app id `sq0idp--72l5BFDOKatnObhy_fj0w` is the code default, `SQUARE_APP_ID` overrides it, and the host follows the id unless `SQUARE_ENV` says otherwise) → that provider; emulator without them → mock (in the emulator a `.secret.local` secret alone is not enough — live Square locally also needs an explicit `SQUARE_APP_ID`); deployed without them → `501 pos_not_configured`.
- **Routes** (all take `:provider`): `GET /integrations` (read), `GET …/locations` (read), `POST …/connect` → `{ url }` (edit), `POST /integrations/oauth { state, code }` (the starter only), `PUT /integrations/:provider { locationExternalId }` (edit), `DELETE /integrations/:provider` (edit).
- **OAuth round trip**: provider → `posOauthCallback` → `/settings?pos=complete&state&code` → the Settings card POSTs `/integrations/oauth` as the signed-in user → `{ result: connected|forbidden|upgrade|not_configured|invalid_state|failed, rid }`; `?pos=denied|invalid_state|failed` when the callback itself can't continue. Completion re-checks the starter's `integrations:edit` and the plan. Return origin: `APP_URL`, else the web origin that started the flow; native shells get the web app. If the flow was started on another of the user's locations, the app switches to it.
- **Location binding**: `posConnections/{id}.locations` maps `locationExternalId → rid`, so one POS location never feeds two restaurants (`409 location_taken`). Binding adopts the location's currency as base if the restaurant never set one and has approved nothing, and fills an unset timezone.
- **`needs_reauth` lives on the connection only**; the per-restaurant view derives it, so one reconnect heals every restaurant on that merchant.
- **Auto-select**: a single-location merchant, or a same-merchant reconnect whose old location still exists, skips the picker.
- **Perms**: `integrations` is `permLevelSchema.default("none")` — member docs and invites written before it existed would otherwise fail `memberDocSchema` and lock their members out.
- **Key ring**: `POS_TOKEN_ENC_KEY = "v2:<b64>,v1:<b64>"`, first entry encrypts. Emulator/tests use a fixed dev key.
- **Concurrency**: attaching to a new merchant releases the old connection in the same transaction; binding a location re-reads the integration inside its transaction; re-sealing is transactional so it can't overwrite a fresh refresh. A refresh that fails for a non-auth reason falls back to the still-valid credentials.

**Phase 2 — Catalog + marriage**

- **Sync** (`catalog.ts` `syncCatalog`): runs right after a location is bound, on "Sincronizar catálogo", and daily (`posDaily`, after credential upkeep, skipping locations whose plan lost POS). Reconciles the link table as in §Link lifecycle, then runs the matcher; LLM tier only on bind and manual runs, never daily.
- **Re-match** (`rematch`): "Buscar coincidencias" (all tiers, no POS call), and after every `POST`/`PUT /menu-items` (cheap tiers) — so a new dish picks up its POS item immediately and a deactivated dish releases its links.
- **Matcher** (`matching.ts`, pure): token Dice + character-bigram Dice (0.6/0.4), suggestion floor 0.55, top 3; ties within 0.02 broken by price distance. The token/bigram/Dice math lives in `shared/src/similarity.ts` (also behind the pantry's duplicate list and triage's ingredient suggestions); `matching.ts` re-exports `tokens`. Accents are folded first (`foldName`), since `normalizeName` alone would *drop* "ó" — "jamón" → "jamn".
- **Routes**: `GET …/links` → `{ links, dishes }` (read — dishes ride along because an integrations-only member may not read `/menu-items`); `POST …/catalog/sync`, `POST …/links/match`, `PUT …/links/:linkId { action: confirm(menuItemId) | ignore | unlink }` (edit; the LLM tier needs `posAiMatching`). Prices on the wire are base-currency floats (`money.ts`).
- **Review page** `/integrations/:provider` (`PosLinksPage.vue`): tabs sin vincular / vinculados / ignorados / retirados, suggestion chips, any-dish picker, price-drift line, and **bulk "crear platos"** — which opens the existing `MenuScanWizard` seeded with the POS names + prices (no photo step, same AI recipe drafts), then confirms each link to the dish it created. The exact-name auto-link on dish create would catch it anyway; the explicit confirm marks it human-reviewed.
- **Mock catalog**: a fixed EUR fixture per mock location; tests simulate POS edits by writing `posMockCatalog/{merchantId}`.

Before the first deploy with this code: run `node scripts/pos-secrets.mjs` — it sets `SQUARE_APP_SECRET` (prompted, or from the environment) and creates `POS_TOKEN_ENC_KEY` if missing; it never regenerates an existing key (that would orphan every sealed token), and `--rotate` prepends a new one. Both are bound to `api`, `posDaily` and `posSync`, so deploy fails without them. With the app id now a code default, a placeholder secret makes Square look configured and OAuth fail — set the real one. Cloud Scheduler must be enabled for `posDaily`. Abandoned OAuth states are swept by a Firestore TTL policy on `posOauthStates.purgeAt` (a Timestamp set to the state's expiry; `expiresAt` stays epoch ms for the code's own check, and TTL only works on Timestamps). The policy is declared in `firestore.indexes.json` and deploys with the indexes; expired states are already refused, TTL just sweeps them.

Open: native OAuth (`@capacitor/browser` + an app URL scheme; no native projects are in the repo yet); e2e specs for the Settings card and the review page; a Menu-page nudge when the queue is non-empty.

## Phase 3 — built (2026-10-15)

Order ingestion and projection, on the deterministic mock (`test/pos-orders.test.ts`, 30 tests).

- **Contract** (`types.ts`): `PosOrder` / `PosOrderLine` (net-only money), and on the adapter `listOrders` (the webhook-era `fetchOrder` / `parseWebhook` / `PosEvent` were removed with the poll switch). `revenueSourceSchema` (`manual | pos`) in the shared vocab.
- **Net money** (Square, `normalizeSquareOrder`): line net = `total_money − total_tax_money − total_service_charge_money`. `total_money` already carries the apportioned discounts, and subtracting tax gives the same net whether the seller prices tax-inclusive (Spain) or additive (US), which is why it does not start from `gross_sales_money` (Square deducts inclusive tax from it in the US/CA/JP but not in Europe/AU). Gift-card lines are dropped; custom amounts keep `catalogExternalId: null`. Itemized returns are positive amounts in `returns`; an amount-only refund is `refundedMinor` (net of tax and tip).
- **Raw orders** (`orders.ts`): `restaurants/{rid}/posOrders/{provider}_{orderId}`, upserted in transactions of 100 only when the revision is newer (or the epoch differs). The poll, the deep pass and backfill all land in `ingestOrders`, so re-reads are no-ops.
- **Backfill, poll and late-order sweep are one mechanism** (`syncOrders`): `integrations/{provider}.orderSync = { since, cursor, passStartedAt, backfilling, nextPollAt, idleStreak, deepPassAt }`, checkpointed after every page. The first pass reaches `BACKFILL_DAYS` (90) back; each finished pass sets the next `since` to `passStartedAt − 10 min` and schedules `nextPollAt` (5–30 min, §Order ingestion); once a day the pass reaches 72 h back. Filtered and sorted by `updated_at` so a refund days later is found. `posSync` ticks every 5 min (5 pages per due restaurant); binding a location runs the first 2 pages immediately.
- **No webhooks** (removed 2026-10-17 before ever going live — see §Order ingestion). `posSync` is the smart poll; a revoked grant is a 401 on the next poll; an unknown catalog id in a sale triggers a catalog sync.
- **Projector** (`project.ts`): `restaurants/{rid}/posDays/{provider}_{date}` tracks `dirtySeq` (bumped by every trigger), `dirty`, and `applied`. A day is rebuilt deterministically from its orders and the link table into the revenue entry `pos_{provider}_{date}` (`source: "pos"`, `provider`, `unattributed: {amount, count}`, `refunded`). The business day is computed here (restaurant timezone, default `UTC`, minus `settings.businessDayCutoff`, default 04:00).
- **Pantry delta is exact.** The day doc stores `applied`, the per-ingredient usage the last projection subtracted; the next one moves the pantry by `applied − new` in the same transaction. It never recomputes the "old" usage from current recipes (they may have changed), and an ingredient deleted in the meantime is skipped. If something dirties the day mid-rebuild (`dirtySeq` moved) it stays dirty.
- **Returns reduce revenue, not stock**: the refunded plate was already cooked.
- **Mapping changes re-attribute history**: `writeLinks` compares each link's attribution (which dish it sells as; unmapped and ignored are equivalent) with the stored one and marks every day with POS data dirty if any changed. `PUT …/links/:id` then rebuilds the first 10 days inline; the scheduler does the rest.
- **Unattributed bucket**: unmapped, ignored, stale-link (dish gone or inactive) and custom-amount lines stay in `amount` and are counted in `unattributed`, so the day ties out with the POS dashboard. Pulse shows "X in N unmatched lines — review", linking to the review queue.
- **Manual collision**: `POST /revenue` for a date a POS reports is refused (`409 pos_covers_date`); `PUT`/`DELETE` of a POS entry is `409 pos_entry_readonly`.
- **Routes**: `POST /integrations/:provider/orders/sync` ("sync now": 5 pages + rebuild up to 30 days; returns `nextPollAt`). **Functions**: `posSync` (every 5 min), `posDaily`, `posOauthCallback`.

Deploy chores: `node scripts/pos-secrets.mjs`; Cloud Scheduler must allow `posSync` and `posDaily`; if a `SQUARE_WEBHOOK_SIGNATURE_KEY` secret was ever created, destroy it after the deploy (the script prints the command). Square Developer Console: only the OAuth redirect URL — no webhook subscription (see §Square Developer Console setup).

Known limits / Later: `usageFor` reads the whole catalog per rebuilt day (fine for ≤300 dishes/ingredients, wasteful for a 90-day backfill: load once per run if it shows up in cost); a base-currency change after binding makes that restaurant's orders skip with a warning; no email on `needs_reauth` yet (Phase 4); no UI for the order-sync state beyond "sync now" (route only).

## Phased delivery

1. **Foundation** ✅ (built, unverified) — vocab (`posProviderSchema`, `integrations` perm), `pos/` skeleton with types + mock + Square auth (OAuth state, callback, credential encryption, connections model), Settings connect/disconnect UI.
2. **Catalog + marriage** ✅ (built, unverified) — catalog sync, link table, matcher, review queue (+ import-as-dish via the menu-scan wizard / `draftRecipes`), drift display.
3. **Ingestion + projection** ✅ (built, mock-verified; see §Phase 3) — `revenueSource` + `revenueEntry.source`; adapter `listOrders`; the adaptive poll (+ daily 72 h deep pass, unknown-item catalog refresh), chunked backfill, dirty-day projector with delta pantry depletion (dirty-marking hooked into `writeLinks`), unattributed surfacing in Pulse, manual-collision guard.
4. **Hardening** — revocation/reauth flows, plan gating + pause, price-drift warnings, modifier-revenue flagging.
5. **Later** — modifier→ingredient mapping, as-of costing, inventory push back to the POS (opt-in), next provider (Toast per architecture.md, via Standard API access if its terms allow — see §Toast).

## Gap → resolution map

| Gap (from design review) | Resolution |
|---|---|
| Market availability | Spain confirmed as first market; Square operates in Spain (re-verify country list + ES feature parity in the checklist) |
| No declared source of truth | Raw normalized `posOrders` + deterministic dirty-day projection (Principles §3, Projection) |
| Refunds/voids/late updates | Version-guarded upsert; a refund is a new version → day rebuilds |
| Discounts/comps | Per-line `discountMinor` incl. prorated order-level; net-based revenue |
| Taxes & tips | Net = gross − discounts − IVA; tips excluded; invoice-cost IVA consistency flagged as follow-up |
| Unattributed / custom-amount lines | Explicit `unattributed` on the entry; tie-out surfaced in Pulse |
| Decimal quantities | `qty` decimal end-to-end (weight-sold items) |
| Modifiers | v1 fold into parent + "costs unmodeled" flag; id-keyed link table ready for modifier mapping later |
| Combos | Single dish composed of sub-recipe lines; splits stay possible as projector-only change |
| COGS timing | v1 current cost (status quo); v2 as-of costing from dated invoice history — no snapshots |
| Merchant ≠ restaurant tenancy | Merchant-level `posConnections` + per-restaurant reference; refresh once per merchant; revoke on last disconnect |
| Reconnect to different merchant | Epoch counter; links/cursors archived by epoch, never trusted across merchants |
| Auto-match ambiguity | Active-only candidates; ambiguity always queues, never auto-links |
| Matching only at connect | Matcher re-runs on catalog sync, dish create/rename, and on demand; idempotent, never touches confirmed/ignored |
| Dangling links | Matcher requeues links to deleted/inactive dishes on every dish save; projection-time validation → unattributed `stale_link` (guards `expandUsage`'s silent drop) |
| IVA-inclusive price matching | Name-first matcher; price is tiebreaker only, inclusive-vs-inclusive |
| Backfill scale | Chunked, cursor-checkpointed, scheduler-driven; 90-day default window |
| Freshness without webhooks | 5-min tick, per-restaurant backoff to 30 min, "sync now", daily 72 h deep pass, catalog sync on unknown item |
| Business day / timezone | Projector-computed from restaurant tz + cutoff; changes rebuild |
| OAuth hygiene | Single-use `state` docs; `PosAuthError` on the next poll → `needs_reauth` banner (+ email, Phase 4); revision guard makes overlapping re-reads harmless |
| Forwarded consent link (consent phishing) | Callback never completes; the signed-in starter completes via `POST /integrations/oauth` (caller uid must equal state uid) |
| Owner rejects an exact auto-link | `noAuto` on unlink: suggested forever, never re-auto-linked |
| Offline dev / push vs pull | No webhooks: adaptive poll; the mock simulates orders, catalog edits and revocation |
| Plan gating | Every plan, per location; Free capped (hourly poll floor, no LLM matching); no plan-level off switch — a pause would be a per-restaurant flag |
| Disconnect semantics | Data retained, sync stops, token revoked on last reference; purge rides restaurant deletion |
| Double counting vs manual | `source` field; projector owns only pos entries; manual form warns on covered dates |
| Future POS providers | Registry typed against the vocab (compile error until registered); per-provider module owns its secrets; opaque credentials; `connect.kind` union for non-OAuth access; normalized events + adapter-defined order revision; provider-prefixed ids; engine and app provider-blind (§Adding a provider) |

## Verify against live Square docs before going live

**Checked 2026-10-15** (Square developer docs): **(4)** OAuth access tokens expire after 30 days, refresh via `ObtainToken` with `grant_type=refresh_token`, and Square recommends refreshing every 7 days or less; the adapter's 7-day-ahead refresh matches. **(6)** `SearchOrders` takes up to 10 location ids, `limit` default 500 / max 1000, and can filter and sort by created, updated or closed time (we use updated); orders made on a POS in offline mode can reach Square up to 72 hours late (the daily 72 h deep pass covers that). **(3)** Line `total_money` includes apportioned discounts; inclusive tax stays inside `gross_sales_money` in Europe/AU but is deducted from it in the US/CA/JP (hence the total-minus-tax net). **(2)** Spain is on Square's payment-processing country list and the developer docs say the OAuth token acts as if called from the seller's own country; a consumer help page lists the Orders API only for the US, CA, AU, UK and JP, which contradicts that. **Treat Spain Orders-API availability as unconfirmed until a Spanish sandbox account returns orders.** The sandbox exists only in payment-processing regions, so create the test account in Spain.

Still needs a live Spanish sandbox: **(1)** the `Square-Version` to pin (currently defaulting to `2025-01-23`, check the changelog); **(8)** the ListCatalog presence/override fields; the exact shape of `returns` / `return_amounts` on a refunded order (our reading: itemized returns arrive in `returns[].return_line_items`, amount-only refunds in `return_amounts`); that `updated_at` filtering combined with `state_filter` behaves as assumed; and whether the sandbox's `SearchOrders` is healthy (a developer-forum report from 2026-09 says it stopped returning new orders for 40+ hours).

(Still blocked — no web access in the design, Phase 1 or Phase 2 sessions. All are adjustments inside `pos/providers/square.ts`, none change the architecture. Phases 1–2 assumed: API version `2025-01-23`; scopes `MERCHANT_PROFILE_READ ITEMS_READ ORDERS_READ`; `POST /oauth2/token` with `expires_at` ISO; `POST /oauth2/revoke` with `Authorization: Client <secret>`; `GET /v2/locations`; `GET /v2/catalog/list?types=ITEM` with nested `item_data.variations`, `present_at_all_locations` defaulting to true, and `location_overrides[].price_money`.)

1. Current `Square-Version` to pin; recent breaking changes in Orders/Catalog/OAuth.
2. Spain availability of Orders/Catalog/OAuth and any ES-specific gaps; supported currencies (EUR).
3. Exact per-line money semantics: does `total_discount_money` include prorated order-level discounts; tax-inclusive pricing behavior on line totals.
4. OAuth token lifetime (~30 days?) and refresh semantics; PKCE requirements; whether any scope needs app review.
5. ~~Webhooks~~ — not used (smart poll).
6. Rate limits / backoff guidance; SearchOrders page size limits.
7. Whether the Node SDK is worth its bundle weight vs. plain fetch given the esbuild external-deps setup. (Phases 1–2 chose plain fetch.)
8. Catalog: the ListCatalog fields above; whether archived items still list; whether a variation can be absent where its item is present.
9. Before a second provider: see the Toast checklist below.

## Square Developer Console setup (production app `sq0idp--72l5BFDOKatnObhy_fj0w`)

1. **OAuth → Redirect URL**: exactly `https://us-east1-teremu-app.cloudfunctions.net/posOauthCallback` (what `oauthRedirectUrl()` sends), or whatever `POS_OAUTH_REDIRECT_URL` is set to. Square compares it verbatim with the `redirect_uri` we pass — scheme, host, path, no trailing slash.
2. **Credentials**: production application secret → `node scripts/pos-secrets.mjs`. The app id is public and already the code default.
3. **Scopes** are requested per consent, not configured in the console: `MERCHANT_PROFILE_READ ITEMS_READ ORDERS_READ` (read-only).
4. **Webhooks**: none. Do not add a subscription.
5. **Sandbox (optional, recommended before real merchants)**: the sandbox app has its own id (`sandbox-sq0idb-…`) and secret. To test against it, set `SQUARE_APP_ID` to the sandbox id (the host follows) and the sandbox secret, and register the same callback URL in the sandbox tab. Spain-specific Orders-API behavior needs a Spanish sandbox/test account (§Verify).
6. **App Marketplace listing is not required** for other sellers to authorize via OAuth; it is a distribution channel, not a gate (re-check before scaling past friendly restaurants).

## Verify against live Toast docs before building the Toast adapter

The access model in §Toast was checked against Toast's public docs on 2026-10-14. Everything below was not, and each item is a decision input, not just a detail.

1. **Terms first.** Do Toast's terms allow a restaurant to give Standard API credentials to a third-party SaaS vendor, or are they for the restaurant's own use only (with vendors required to go through the partner program)? Read the Standard API access FAQs and the developer terms. If vendors may not use them, path 1 is out and the partner application becomes the critical path.
2. **Markets.** Confirm Toast's country list (believed to be US / CA / UK / IE, not Spain) and currency handling per location.
3. **Auth.** The token endpoint and body for Standard API credentials (client-credentials flow with `userAccessType`?), token lifetime, and the scopes a Standard API credential carries. Whether scopes are fixed or chosen at creation (the docs mention fixing scope errors by editing the client's scopes).
4. **Locations.** How a Standard API credential lists the restaurants it covers (an endpoint, or must the owner also paste restaurant GUIDs?). The location's timezone, currency and closeout hour.
5. **Catalog.** The menus API shape: item/variation grain vs our `PosCatalogItem`, stable GUIDs across menu edits, sizes, modifiers.
6. **Orders.** The orders API by business date vs modified date, page limits, and which field serves as `revision` (a modified timestamp?). Voids, refunds and per-line discount/tax/net semantics; whether prices are tax-inclusive outside the US.
7. **Polling limits.** Ingestion is poll-only for every provider: check the orders API rate limits per credential against the 5–30 min cadence.
8. **Rate limits** per credential and per location.
9. **Revocation.** How deleting or editing a credential set in Toast Web shows up to us (expected: 401 on token exchange → `needs_reauth`).
10. **Plan gating.** Whether RMS Essentials is still the minimum, and what happens to the credential when a location downgrades.
11. **Nightly export fallback** (only if needed): self-serve vs Customer Care, SFTP push vs pull, file schema, and whether product mix rows carry item GUIDs.
12. **Partner program.** Application requirements and lead time, in case path 1 is not allowed or webhooks need it.
