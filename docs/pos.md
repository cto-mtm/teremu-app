# POS integrations (Square first)

Status: **design record — not yet implemented.** First market: **Spain** (Square operates there; prices are IVA-inclusive). First provider: **Square**. The design is provider-agnostic: Square is the first *adapter*, not the architecture — `architecture.md` already anticipates "POS integration (Square/Toast webhook → `POST /revenue`)" as the natural next endpoint, and this doc is how that lands without wiring Square-isms into the core.

Read this before touching any POS/integration code. Companion docs: `architecture.md` (tenancy: restaurant = location, per-location billing), `multi-location-plan.md`, `llm.md` (the matcher's LLM assist goes through `llm.ts` like everything else).

## Principles

1. **One adapter boundary, like `llm.ts`.** All provider traffic lives in `firebase/functions/src/pos/<provider>.ts` behind a common interface. The sync engine, matcher, and projector never see provider HTTP, field names, or auth.
2. **Ids, never names.** Every cross-system reference is `provider` + `externalId`. Names are display data that drifts.
3. **Raw orders are the source of truth; everything downstream is a rebuildable projection.** Normalized orders are stored immutably (upserted only by provider version); revenue entries, dish attribution, and pantry depletion are *derived* and can be regenerated for any (restaurant, business day) at any time. This one commitment is what makes late mappings, refunds, mapping corrections, and attribution bug-fixes all the same cheap operation: mark the day dirty, rebuild it.
4. **Money is integer minor units (cents) + currency code inside the POS layer.** Convert to the app's float euros only at the projection boundary (existing `revenueEntry` shape). Revenue for margin math is **net: gross − discounts − IVA, tips excluded entirely**.
5. **Everything works offline.** No connection → deterministic mock provider (same pattern as OCR without `NVIDIA_API_KEY`). Webhooks get an emulator-only injection route.

## Provider abstraction

`firebase/functions/src/pos/` — `types.ts` (interface + normalized types), `square.ts`, `mock.ts`, `sync.ts` (engine), `matching.ts`, `project.ts`, `webhook.ts`.

```ts
interface PosProvider {
  authUrl(state): string
  exchangeCode(code): PosTokens            // + merchantId
  refresh(tokens): PosTokens
  revoke(tokens): void
  listLocations(tokens): PosLocation[]     // externalId, name, timezone, currency
  fetchCatalog(tokens, locationId): PosCatalogObject[]
  searchOrders(tokens, locationId, window, cursor): { orders: PosOrder[], cursor }
  fetchOrder(tokens, orderId): PosOrder
  verifyWebhook(headers, rawBody): PosEvent | null
}
```

Normalized types (all money in minor units):

- `PosCatalogObject` — `{ externalId, kind: 'item_variation' | 'modifier', itemExternalId, name, priceMinor, currency }`
- `PosOrder` — `{ externalId, locationExternalId, state, closedAt (UTC), version, currency, lines[], refundedMinor }`
- `PosOrderLine` — `{ externalLineId, catalogExternalId | null, name, qty (decimal — weight-sold items exist), grossMinor, discountMinor (line share incl. prorated order-level discounts), taxMinor, netMinor, modifiers: [{ catalogExternalId, name, netMinor }] }`

Vocabulary (in `shared/src/vocab.ts`, per the schemas rule): `posProviderSchema = z.enum(["square"])` — adding Toast/Lightspeed later is a one-line enum change plus a new adapter file; `revenueSourceSchema = z.enum(["manual", "pos"])`; and a new `integrations` area in `permsSchema` (`none | read | edit` — read: see status and mappings; edit: connect, disconnect, map; owners bypass as usual).

## Identity & connections (merchant ≠ restaurant)

OAuth tokens are per **merchant**; a merchant owns several POS **locations**; a Teremu restaurant *is* one location. So the connection is modeled at merchant level with per-restaurant references:

- `posConnections/{provider}_{merchantId}` (top level): encrypted tokens, scopes, status (`active | needs_reauth | revoked`), token expiry. One doc per merchant no matter how many restaurants attach to it — token refresh runs once per merchant, and two Teremu restaurants under one Square account never store duplicate credentials.
- `restaurants/{rid}/integrations/{provider}` (one doc): pointer to the connection, the chosen `locationExternalId`, an **epoch** counter, sync cursors, settings (`businessDayCutoff`, default `04:00`), status, `lastSyncAt`.

Rules that keep this honest:

- **OAuth `state`** is a single-use random doc (`posOauthStates/{nonce}`, short TTL) binding `{ rid, uid }` — CSRF protection and how the callback knows who is connecting. The code exchange happens server-side (callback function), then deep-links back into the app (Capacitor: in-app browser + app scheme, not a popup).
- **Reconnect to a *different* merchant bumps the epoch.** Catalog ids are per-merchant, so every link and cursor carries the epoch it was created under; a merchant change archives (not deletes) all links/cursors of the old epoch in one query. Same-merchant reconnect keeps the epoch — links survive.
- **Disconnect is per restaurant**: remove the restaurant's integration doc reference and pause its sync. Revoke the merchant token only when the *last* restaurant referencing that connection disconnects. **Synced sales are retained** — they are the restaurant's own history; UI copy states this. Full purge rides the existing `DELETE /restaurants/:rid` recursive delete (posOrders/posLinks live under the rid); that handler must also drop the connection reference (and revoke if last).
- **Revocation from the provider side** (`oauth.authorization.revoked` webhook, or a 401 on any call) flips the connection to `needs_reauth` — surfaced as a reconnect banner in Settings and a `sendMail` alert to the owner. Sync pauses; nothing errors loudly in the background forever.
- **Token encryption**: AES-256-GCM with a key from Secret Manager (`POS_TOKEN_ENC_KEY`, `defineSecret` like Stripe's in `billing.ts`); ciphertext is prefixed with a key version so rotation is decrypt-with-old / encrypt-with-new, no big-bang. A daily scheduled job refreshes tokens expiring within 7 days.

Timezone/currency synergy: at connect time, populate `restaurants/{rid}.timezone`/`currency` from the POS location if unset (the fields `multi-location-plan.md` reserved).

## The link table (menu marriage)

`restaurants/{rid}/posLinks/{provider}_{externalId}` — one doc per catalog object, keyed by id (stable across renames), fields: `provider, externalId, externalKind, epoch, externalName, externalPriceMinor, currency, menuItemId | null, status: auto | confirmed | unmapped | ignored | stale, confidence, matchedBy: exact | fuzzy | llm | manual, updatedAt`.

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

- Catalog sync: rename → same id, refresh `externalName` (link survives); delete → link `stale` (kept for history); new object → enters queue; price change → "menu price drift" warning (Teremu price vs POS price), since actual charged amounts drive revenue but the drift signal helps the owner.
- **Dangling target**: if the linked menu item is deleted/deactivated, projection sends those sales to the unattributed bucket with reason `stale_link` and flags the link back into the queue. This matters because `expandUsage` (`app/src/lib/domain.ts`) silently drops unknown `menuItemId`s — without the guard, mapped-to-deleted sales would vanish from margins without a trace.
- Confirming or unlinking a mapping marks the affected business days dirty → history re-attributes automatically (see Projection).

## Order ingestion

- **Webhooks are the fast path** (`order.created`/`order.updated` + revocation events): one HTTPS endpoint per provider, exposed like the Stripe webhook. Verify HMAC, then **fetch the full order from the API** rather than trusting the payload (thin-webhook best practice — also makes duplicate and out-of-order deliveries harmless), normalize, upsert.
- **Upsert is version-guarded**: `restaurants/{rid}/posOrders/{provider}_{orderId}`, applied only if the incoming provider `version` is newer. Refunds/voids arriving days later are just another version — the order's day goes dirty and rebuilds.
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

- **Mock provider** (`pos/mock.ts`): deterministic catalog + orders so connect → map → project → Pulse works fully offline in the emulators, per repo rule.
- **Sandbox**: Square's sandbox (`connect.squareupsandbox.com`) via env config — never hardcode the base URL in callers (same rule as `llm.ts` providers).
- **Webhook injection**: emulator-only route accepting a normalized `PosEvent` (seed.ts pattern), because real webhooks can't reach the emulator. The webhook path must be testable before production.
- **Unit tests** (`firebase/functions/test/`): matcher normalization/tiers/ambiguity-refusal; version-guarded upsert idempotency (webhook + reconcile delivering the same order); projector determinism (same inputs → same entry) and pantry **delta** on rebuild; net-money math incl. prorated discounts and decimal qty; token encrypt/decrypt round-trip + key-version rotation; OAuth state single-use; epoch archival on merchant change; HMAC verification (valid/invalid/replayed).
- **i18n**: all new strings in a per-feature `integrations` locale module, `es` authored first, `en` mirrored same change.

## Phased delivery

1. **Foundation** — vocab (`posProviderSchema`, `integrations` perm, `revenueSource`), `pos/` skeleton with types + mock + Square auth (OAuth state, callback, token encryption, connections model), Settings connect/disconnect UI.
2. **Catalog + marriage** — catalog sync, link table, matcher, review queue (+ import-as-dish via `draftRecipes`), drift handling.
3. **Ingestion + projection** — webhooks (+ injection route), reconciliation, chunked backfill, dirty-day projector with delta pantry depletion, unattributed surfacing in Pulse, manual-collision guard.
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
| Dangling links | Projection-time target validation → unattributed + `stale` requeue (guards `expandUsage`'s silent drop) |
| IVA-inclusive price matching | Name-first matcher; price is tiebreaker only, inclusive-vs-inclusive |
| Backfill scale | Chunked, cursor-checkpointed, scheduler-driven; 90-day default window |
| Business day / timezone | Projector-computed from restaurant tz + cutoff; changes rebuild |
| OAuth hygiene | Single-use `state` docs; revocation webhook + 401 → `needs_reauth` banner + email; version guard makes webhook dupes/ordering harmless |
| Offline webhook dev | Emulator-only injection route + mock provider |
| Plan gating | Pro+ per location; downgrade pauses sync, keeps data |
| Disconnect semantics | Data retained, sync stops, token revoked on last reference; purge rides restaurant deletion |
| Double counting vs manual | `source` field; projector owns only pos entries; manual form warns on covered dates |
| Future POS providers | Adapter interface + provider-prefixed ids + vocab enum; core engine provider-blind |

## Verify against live Square docs before Phase 1

(Blocked in the design session — no web access. All are adjustments, none change the architecture.)

1. Current `Square-Version` to pin; recent breaking changes in Orders/Catalog/OAuth.
2. Spain availability of Orders/Catalog/OAuth/webhooks and any ES-specific gaps; supported currencies (EUR).
3. Exact per-line money semantics: does `total_discount_money` include prorated order-level discounts; tax-inclusive pricing behavior on line totals.
4. OAuth token lifetime (~30 days?) and refresh semantics; PKCE requirements; whether any scope needs app review.
5. Webhook event names, signature header/scheme, retry policy; sandbox webhook support.
6. Rate limits / backoff guidance; SearchOrders page size limits.
7. Whether the Node SDK is worth its bundle weight vs. plain fetch given the esbuild external-deps setup.
