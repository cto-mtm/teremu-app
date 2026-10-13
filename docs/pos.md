# POS integrations (Square first)

Status: **Phases 1 (Foundation) and 2 (Catalog + marriage) implemented 2026-10-05 / 2026-10-10; Phases 3–5 are design.** Both were written in sessions that could not run the typechecks or the test suite (and had no web access for the Square checklist below). Before merging, run `npm run build --workspace @teremu/shared`, both typechecks, and `npm run test`; `test/pos.test.ts` and `test/pos-catalog.test.ts` cover them. See §Built so far. First market: **Spain** (Square operates there; prices are IVA-inclusive). First provider: **Square**. The design is provider-agnostic: Square is the first *adapter*, not the architecture — `architecture.md` already anticipates "POS integration (Square/Toast webhook → `POST /revenue`)" as the natural next endpoint, and this doc is how that lands without wiring Square-isms into the core.

Read this before touching any POS/integration code. Companion docs: `architecture.md` (tenancy: restaurant = location, per-location billing), `multi-location-plan.md`, `llm.md` (the matcher's LLM assist goes through `llm.ts` like everything else).

## What this commit contains (and what it does not)

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
5. **Everything works offline.** No connection → deterministic mock provider (the offline-mock pattern OCR uses without `NVIDIA_API_KEY` — but deterministic, unlike OCR's randomized mock, so tests can assert on it). Webhooks get an emulator-only injection route.

## Provider abstraction

```
firebase/functions/src/pos/
  types.ts            THE contract: PosAdapter, PosProviderModule, normalized types
  index.ts            provider registry (typed against the vocab), adapter selection, secrets
  providers/
    square.ts         Square — the only file that knows Square
    mock.ts           deterministic stand-in for ANY provider (offline + tests)
  store.ts            shared persistence + credentials (refresh, needs_reauth)
  crypto.ts           credentials at rest (AES-256-GCM key ring)
  connections.ts      connect / locations / disconnect           (engine)
  catalog.ts          catalog sync, link table, review queue     (engine)
  matching.ts         pure matcher + LLM tier                    (engine)
  money.ts            minor units → base-currency floats
  orders.ts, project.ts, webhook.ts                              (Phase 3)
```

The adapter contract (`types.ts`; Phase 3 methods marked):

```ts
interface PosAdapter {
  connect: PosConnectFlow                    // how a merchant authorizes — see below
  refresh?(credentials): PosCredentials      // optional: absent = never refreshes
  revoke?(merchantId, credentials): void     // optional, best effort
  listLocations(credentials): PosLocation[]  // externalId, name, timezone, currency, active
  fetchCatalog(credentials, locationId): PosCatalogItem[]
  listOrders(credentials, locationId, { since, cursor }): { orders: PosOrder[], cursor }   // Phase 3
  fetchOrder(credentials, orderId): PosOrder                                              // Phase 3
  parseWebhook?(headers, rawBody, url): PosEvent[] | null   // Phase 3; optional — null = bad signature
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
- `PosEvent` — `{ type: "order_changed" | "catalog_changed" | "access_revoked", merchantId, locationExternalId?, orderId? }` — provider event names (`order.updated`, `oauth.authorization.revoked`…) never leave the adapter.

Vocabulary (in `shared/src/vocab.ts`, per the schemas rule): `posProviderSchema = z.enum(POS_PROVIDERS)`; `revenueSourceSchema = z.enum(["manual", "pos"])` (Phase 3, with its first user); and an `integrations` area in `permsSchema` (`none | read | edit` — read: see status and mappings; edit: connect, disconnect, map; owners bypass as usual).

### Adding a provider

The registry in `pos/index.ts` is `{ square } satisfies Record<PosProvider, PosProviderModule>`, so the steps are enforced by the compiler, not by memory:

1. `shared/src/vocab.ts`: add the id to `POS_PROVIDERS`. (Build now fails until 2.)
2. `pos/providers/<id>.ts`: export a `PosProviderModule` — `{ adapter, configured(), secrets }`. Its secrets are declared there with `defineSecret` and flow into `POS_SECRETS` automatically. Env config only (base URL, API version); never hardcoded in callers.
3. `pos/index.ts`: one line in `PROVIDERS`.
4. `app/src/i18n/locales/components/integrations.ts`: the display name under `provider.<id>` in `es` and `en`.
5. Register the shared callback / webhook URLs in the provider's dashboard; add the provider's facts to a verify checklist here.

Nothing else changes: routes take `:provider`, the Settings card and the review page render whatever `GET /integrations` lists, the mock covers every provider in tests, and data is keyed `provider + externalId` everywhere. A provider that can't do something the contract needs is the signal to extend the *contract* (a new `connect.kind`, an optional method) — never an `if (provider === …)` in the engine.

**Toast, as currently understood (UNVERIFIED — check before building):** access is granted by the restaurant enabling the partner integration on Toast's side rather than a per-merchant OAuth redirect; one partner credential then reaches every restaurant that enabled it, each addressed by a restaurant GUID. That maps onto this model as a second `connect.kind` (the owner picks their Toast restaurant from the ones that granted access), `merchantId` = Toast restaurant group, location = Toast restaurant, and no `refresh`/`revoke` per merchant (the adapter refreshes its partner token internally). Webhooks and order revisions differ too — hence `parseWebhook` being optional and `revision` being adapter-defined.

## Identity & connections (merchant ≠ restaurant)

Credentials are per **merchant**; a merchant owns several POS **locations**; a Teremu restaurant *is* one location. So the connection is modeled at merchant level with per-restaurant references:

- `posConnections/{provider}_{merchantId}` (top level): sealed credentials, status (`active | needs_reauth`), expiry, `restaurantIds`, and `locations` (location → rid bindings). One doc per merchant no matter how many restaurants attach to it — refresh runs once per merchant, and two Teremu restaurants under one POS account never store duplicate credentials.
- `restaurants/{rid}/integrations/{provider}` (one doc): pointer to the connection, the chosen `locationExternalId`, an **epoch** counter, sync cursors, settings (`businessDayCutoff`, default `04:00`), status, `catalogSyncedAt`, `lastSyncAt`.

Rules that keep this honest:

- **OAuth `state`** is a single-use random doc (`posOauthStates/{nonce}`, short TTL) binding `{ provider, rid, uid }`. One callback function serves every OAuth provider. **The callback never completes the connection**: a state proves which flow this is, not who is holding the browser — someone could start a flow on their own restaurant and forward the consent link to a real merchant, attaching that merchant's sales to the wrong restaurant. So the callback hands `state` + `code` back to the app, and the **signed-in** user completes it (`POST /integrations/oauth`), which is refused unless the caller is the user who started the flow. (Native: in-app browser + app scheme, not a popup — still open.)
- **Reconnect to a *different* merchant bumps the epoch.** Catalog ids are per-merchant, so every link and cursor carries the epoch it was created under; a merchant change archives (not deletes) all links/cursors of the old epoch in one query. Same-merchant reconnect keeps the epoch — links survive.
- **Disconnect is per restaurant**: remove the restaurant's integration doc reference and pause its sync. Revoke the merchant token only when the *last* restaurant referencing that connection disconnects. **Synced sales are retained** — they are the restaurant's own history; UI copy states this. Full purge rides the existing `DELETE /restaurants/:rid` recursive delete (posOrders/posLinks live under the rid); that handler must also drop the connection reference (and revoke if last).
- **Revocation from the provider side** (an `access_revoked` event, or a `PosAuthError` from any adapter call — Square: a 401) flips the connection to `needs_reauth` — surfaced as a reconnect banner in Settings and a `sendMail` alert to the owner. Sync pauses; nothing errors loudly in the background forever. The state lives on the connection only, so one reconnect heals every restaurant on that merchant.
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

- **Webhooks are the fast path, where the provider has them**: ONE function (`posWebhook`, exposed like the Stripe webhook) routed by path `/{provider}`; the adapter's `parseWebhook` verifies the signature and returns normalized `PosEvent`s, so the engine handles `order_changed` / `catalog_changed` / `access_revoked` without knowing whose events they were. For orders, **fetch the full order from the API** rather than trusting the payload (thin-webhook best practice — also makes duplicate and out-of-order deliveries harmless), normalize, upsert. A provider without webhooks just leans on reconciliation.
- **Upsert is revision-guarded**: `restaurants/{rid}/posOrders/{provider}_{orderId}`, applied only if the incoming `revision` is newer. Refunds/voids arriving days later are just another version — the order's day goes dirty and rebuilds.
- **Reconciliation** (scheduled, us-east1 like everything else): per connected restaurant, `searchOrders` over a trailing window with the stored cursor — catches missed webhooks. Only `COMPLETED`-state orders count toward sales.
- **Backfill** (initial import, default 90 days, setting-controlled): chunked and resumable — each scheduler tick processes pages for pending backfills, checkpointing the cursor on the integration doc after every page, until caught up. No single invocation ever tries to swallow a year of orders (timeout + write-cost control). Upgrade path if scheduler cadence ever feels slow: Cloud Tasks; not needed to start.
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

Integrations are a **Pro-and-up, per-location** feature (consistent with per-location billing). Enforced server-side at connect and at sync time: a downgraded location's sync **pauses** (data retained, banner shown) rather than deletes. Permission checks use the new `integrations` area on every route.

## Dev & testing

- **Mock provider** (`pos/providers/mock.ts`): deterministic catalog + orders so connect → map → project → Pulse works fully offline in the emulators, per repo rule.
- **Sandbox**: Square's sandbox (`connect.squareupsandbox.com`) via env config — never hardcode the base URL in callers (same rule as `llm.ts` providers).
- **Webhook injection**: emulator-only route accepting a normalized `PosEvent` (seed.ts pattern), because real webhooks can't reach the emulator. The webhook path must be testable before production.
- **Unit tests** (`firebase/functions/test/`): matcher normalization/tiers/ambiguity-refusal; version-guarded upsert idempotency (webhook + reconcile delivering the same order); projector determinism (same inputs → same entry) and pantry **delta** on rebuild; net-money math incl. prorated discounts and decimal qty; token encrypt/decrypt round-trip + key-version rotation; OAuth state single-use; epoch archival on merchant change; HMAC verification (valid/invalid/replayed).
- **i18n**: all new strings in a per-feature `integrations` locale module, `es` authored first, `en` mirrored same change.

## Built so far

Where the code settled details the design left open (module map in §Provider abstraction).

**Phase 1 — Foundation**

- **Adapter selection** mirrors `llm.ts`: `TEREMU_TEST_MOCKS` → mock; provider credentials configured (`PosProviderModule.configured()`; Square: `SQUARE_APP_ID` + `SQUARE_APP_SECRET`) → that provider; emulator without them → mock; deployed without them → `501 pos_not_configured`.
- **Routes** (all take `:provider`): `GET /integrations` (read), `GET …/locations` (read), `POST …/connect` → `{ url }` (edit, Pro+), `POST /integrations/oauth { state, code }` (the starter only), `PUT /integrations/:provider { locationExternalId }` (edit, Pro+), `DELETE /integrations/:provider` (edit, any plan — a downgraded location can still let go).
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
- **Matcher** (`matching.ts`, pure): token Dice + character-bigram Dice (0.6/0.4), suggestion floor 0.55, top 3; ties within 0.02 broken by price distance. Accents are folded before `normalizeName` (which would otherwise *drop* "ó" — "jamón" → "jamn").
- **Routes**: `GET …/links` → `{ links, dishes }` (read — dishes ride along because an integrations-only member may not read `/menu-items`); `POST …/catalog/sync`, `POST …/links/match`, `PUT …/links/:linkId { action: confirm(menuItemId) | ignore | unlink }` (edit, Pro+). Prices on the wire are base-currency floats (`money.ts`).
- **Review page** `/integrations/:provider` (`PosLinksPage.vue`): tabs sin vincular / vinculados / ignorados / retirados, suggestion chips, any-dish picker, price-drift line, and **bulk "crear platos"** — which opens the existing `MenuScanWizard` seeded with the POS names + prices (no photo step, same AI recipe drafts), then confirms each link to the dish it created. The exact-name auto-link on dish create would catch it anyway; the explicit confirm marks it human-reviewed.
- **Mock catalog**: a fixed EUR fixture per mock location; tests simulate POS edits by writing `posMockCatalog/{merchantId}`.

Before the first deploy with this code: create the `POS_TOKEN_ENC_KEY` and `SQUARE_APP_SECRET` secrets (bound to `api` and `posDaily`, so deploy fails without them — a placeholder `SQUARE_APP_SECRET` is fine until Square is set up, as long as `SQUARE_APP_ID` stays unset). Cloud Scheduler must be enabled for `posDaily`. Add a Firestore TTL policy on `posOauthStates.expiresAt`; expired states are already refused, TTL just sweeps them.

Open: native OAuth (`@capacitor/browser` + an app URL scheme; no native projects are in the repo yet); e2e specs for the Settings card and the review page; a Menu-page nudge when the queue is non-empty.

## Phased delivery

1. **Foundation** ✅ (built, unverified) — vocab (`posProviderSchema`, `integrations` perm), `pos/` skeleton with types + mock + Square auth (OAuth state, callback, credential encryption, connections model), Settings connect/disconnect UI.
2. **Catalog + marriage** ✅ (built, unverified) — catalog sync, link table, matcher, review queue (+ import-as-dish via the menu-scan wizard / `draftRecipes`), drift display.
3. **Ingestion + projection** — `revenueSource` + `revenueEntry.source`; adapter `listOrders` / `fetchOrder` / `parseWebhook`; the one `posWebhook` function (+ emulator injection route), reconciliation, chunked backfill, dirty-day projector with delta pantry depletion (dirty-marking hooked into `writeLinks`), unattributed surfacing in Pulse, manual-collision guard.
4. **Hardening** — revocation/reauth flows, plan gating + pause, price-drift warnings, modifier-revenue flagging.
5. **Later** — modifier→ingredient mapping, as-of costing, inventory push back to the POS (opt-in), next provider (Toast per architecture.md).

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
| Business day / timezone | Projector-computed from restaurant tz + cutoff; changes rebuild |
| OAuth hygiene | Single-use `state` docs; revocation event / `PosAuthError` → `needs_reauth` banner + email; revision guard makes webhook dupes/ordering harmless |
| Forwarded consent link (consent phishing) | Callback never completes; the signed-in starter completes via `POST /integrations/oauth` (caller uid must equal state uid) |
| Owner rejects an exact auto-link | `noAuto` on unlink: suggested forever, never re-auto-linked |
| Offline webhook dev | Emulator-only injection route + mock provider |
| Plan gating | Pro+ per location; downgrade pauses sync, keeps data |
| Disconnect semantics | Data retained, sync stops, token revoked on last reference; purge rides restaurant deletion |
| Double counting vs manual | `source` field; projector owns only pos entries; manual form warns on covered dates |
| Future POS providers | Registry typed against the vocab (compile error until registered); per-provider module owns its secrets; opaque credentials; `connect.kind` union for non-OAuth access; normalized events + adapter-defined order revision; provider-prefixed ids; engine and app provider-blind (§Adding a provider) |

## Verify against live Square docs before going live

(Still blocked — no web access in the design, Phase 1 or Phase 2 sessions. All are adjustments inside `pos/providers/square.ts`, none change the architecture. Phases 1–2 assumed: API version `2025-01-23`; scopes `MERCHANT_PROFILE_READ ITEMS_READ ORDERS_READ`; `POST /oauth2/token` with `expires_at` ISO; `POST /oauth2/revoke` with `Authorization: Client <secret>`; `GET /v2/locations`; `GET /v2/catalog/list?types=ITEM` with nested `item_data.variations`, `present_at_all_locations` defaulting to true, and `location_overrides[].price_money`.)

1. Current `Square-Version` to pin; recent breaking changes in Orders/Catalog/OAuth.
2. Spain availability of Orders/Catalog/OAuth/webhooks and any ES-specific gaps; supported currencies (EUR).
3. Exact per-line money semantics: does `total_discount_money` include prorated order-level discounts; tax-inclusive pricing behavior on line totals.
4. OAuth token lifetime (~30 days?) and refresh semantics; PKCE requirements; whether any scope needs app review.
5. Webhook event names, signature header/scheme, retry policy; sandbox webhook support.
6. Rate limits / backoff guidance; SearchOrders page size limits.
7. Whether the Node SDK is worth its bundle weight vs. plain fetch given the esbuild external-deps setup. (Phases 1–2 chose plain fetch.)
8. Catalog: the ListCatalog fields above; whether archived items still list; whether a variation can be absent where its item is present.
9. Before a second provider: the Toast notes in §Adding a provider (access model, restaurant GUIDs, webhooks, order revision field).
