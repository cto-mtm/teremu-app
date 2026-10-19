# Restaurant listing import ("Encuentra tu restaurante")

Status: **Phases 0, 1 and 2 built (2026-10-19).** Phase 0 = `helpers/safeFetch.ts`, text-keyed cassettes in `llm.ts`, `setupListing` + `/me` + `POST /listing/skip`, the owner redirect, the tour waiting for setup. Phase 1 = `firebase/functions/src/listing/` (fake + Google provider, website crawl, merge/match, client-driven import job, commit with the `placeClaims` registry), `stores/listing.ts` and the setup page on the real API, `test/listing*.test.ts`, `e2e/tests/setup/listing.spec.ts`. **Still gated:** new locations only start `pending` when `LISTING_SETUP=on` (on in the emulator, off when deployed), and `GOOGLE_PLACES_API_KEY` is not yet bound to the `api` function — deployed without it the routes answer 501. Phase 2 = claim verification + takeover (`listing/verify.ts`), the Settings card (`ListingCard.vue`, `listing/settings.ts`), assistant facts + `getRestaurantNotes`, the Menu entry point and the recipe hand-off. Not built yet: PDF menus and Phase 3 (refresh / price-change diff, live reviews in Settings). See "Built vs. designed" below.

After first sign-in, the owner searches for their restaurant. We pull what is already public — the Google listing (name, address, hours, rating, photos, review snippets) and the restaurant's own website (its menu) — and show it back for review. The owner corrects dishes and prices, confirms, and we write: their dishes into `menuItems`, their confirmed details onto the restaurant, and a short set of owner-approved notes the assistant reads. Then the existing recipe-drafting step takes over.

Read before touching any listing-import code. Companion docs: `llm.md` (every AI call goes through `llm.ts`), `pos.md` (dish matching, the IVA question, the adapter + fake pattern this copies), `architecture.md` (tenancy, the API), `business-model.md` (menu setup is quota-free onboarding), `multi-currency.md` (country → base currency), `demo-profiles.md` (seeded locations must not land in this flow), `e2e/README.md` (the first-run flow is part of `auth.setup.ts`).

## Principles

1. **Store what the owner confirmed, not what Google said.** Google's terms let us keep the place ID forever and almost nothing else. So the import is a *draft*: Google content lives in a short-lived job doc and on screen; what gets persisted is what the owner reviewed and saved (their name, their website, their dishes, their notes). Rating, reviews and photos are fetched live when shown and never stored.
2. **The website is the menu source; Google is the identity source.** Places has no reliable menu data. The owner's own site is the best menu source and has no third-party terms problem. Square's catalog beats both when connected (see "Sources, ranked").
3. **One adapter boundary, like `llm.ts` and `pos/`.** All Places HTTP lives behind a narrow `ListingProvider` interface with a fixture-backed fake, so the whole flow works offline in the emulators without a key — same rule as mock OCR.
4. **Every outbound fetch of a URL we didn't write is hostile.** The website crawler takes URLs from Google and from the owner. It goes through one `safeFetch` helper with SSRF protection; nothing else in the codebase fetches arbitrary URLs today.
5. **Partial success is the normal case.** No website, a PDF menu, an image-only menu, no Google listing at all: each source succeeds or fails on its own, and the review screen always has a way forward (paste a link, snap the menu, add by hand). The prototype already shows every one of these states.
6. **The owner has the last word on what the assistant learns.** Auto-generated notes are suggestions until the owner keeps them.

## Sources, ranked

| Source | Gives us | Cost | Terms |
|---|---|---|---|
| Owner's website (HTML, PDF, menu images) | Menu: dishes, prices, sections | One text LLM call per page, vision call per menu image | Their own content — store freely |
| Google Places (New) | Place ID, name, address, country, hours, phone, website URL, rating, ≤5 review snippets, photos | Details Enterprise + Atmosphere: **$25 / 1,000 after 1,000 free per month** (verified 2026-10-19) | Place ID storable indefinitely; everything else not cached beyond what the terms allow (see Compliance) |
| Menu photo (existing `POST /menu/scan`) | Menu | Existing vision call, quota-free | Their own photo |
| Square catalog (if connected, `pos.md`) | Exact sellable items and prices | Free | Their own data |
| Pure LLM web search, no structured source | — | — | **Rejected**: invents menus and prices with no way to tell |

At our volume (one Places call per restaurant, ever, plus refreshes) Places sits inside the free tier for a long time. One import = 1 Details call + up to 5 photo fetches + autocomplete requests (bundled into the session when it ends in a Details call — re-verify, see checklist).

## Compliance (read before writing code)

Verified against the Places API policies page (last updated 2026-10-16) on 2026-10-19:

- **Place ID** is exempt from caching restrictions — store it on the restaurant.
- **Other Places content** may not be pre-fetched, cached or stored beyond the exceptions. The archived Service Specific Terms (2025-05) allow latitude/longitude for 30 days; re-verify the current wording for everything else before Phase 1.
- **Reviews** shown must credit the author (avatar at minimum; name + profile link when space allows), link to the original via `googleMapsUri`, and carry a notice on how they are ordered (default: relevance). France-located places must show the visit month/year.
- **Photos** shown must credit the author (can be deferred to an enlarged view) and link to the source via `googleMapsUri`.
- **Places data shown without a Google map needs the Google Maps logo** (16–19dp), or the text "Google Maps" when space is tight.

What this means for the design:

- The job doc holding raw Places content has a **7-day TTL** (Firestore TTL policy on `expiresAt`), well inside any allowed window.
- Name, address, phone and hours go into an **editable form**; what we persist is the owner's confirmed version. Whether "owner confirmed it" makes Google-derived hours and address the owner's own data is a **legal call, not an engineering one** — open decision 1. The safe fallback is to persist only fields the owner typed or that came from their website, and re-fetch hours by place ID when displayed.
- Rating, reviews and photos: fetched live by place ID when a screen shows them (onboarding, the Settings card), never written to Firestore.
- **Using Places content as LLM input** (e.g. review text → "star dish" notes): the Maps terms restrict machine-learning use; the exact current wording was not verified. Until it is, star-dish suggestions only come from the menu and the owner, not from review text. The prototype's "♥ Favorito" badge (derived from reviews) is display-only and must not feed persisted notes.
- The prototype's "Reseñas… se muestran, no se guardan" copy stays, plus the attribution elements above. Update the prototype UI to the attribution rules in Phase 1.

## Data model

All restaurant data is per location (`multi-location-plan.md`), so everything below is under `restaurants/{rid}`. No client Firestore access exists (rules are deny-all; the app is REST-only), so no rules changes are needed — only API routes.

**`restaurants/{rid}` — new fields** (`restaurantDocSchema` in `models.ts`, `meSchema` in `app/src/lib/schemas.ts`):

```ts
listing?: {
  placeId: string | null          // null = owner said "not on Google"
  website: string | null          // owner-confirmed
  phone: string | null            // owner-confirmed (see open decision 1)
  address: string | null          // owner-confirmed (see open decision 1)
  cuisines: Cuisine[]             // shared vocab
  priceLevel: 1 | 2 | 3 | 4 | null
  confirmedAt: Timestamp
}
setupListing?: "pending" | "done" | "skipped"
```

- `bootstrapRestaurant` (tenancy.ts) writes `setupListing: "pending"` for **new** restaurants only. A missing field reads as `"done"` (`.catch("done")` on the lenient side) so every existing restaurant is untouched.
- Extra locations created with `POST /restaurants` also get `"pending"`: a new location is a new place with its own listing.
- **Name collision:** `restaurantProfileSchema` already exists in `models.ts` (the `{name}` body of `POST /restaurants`). Don't reuse "profile" for this feature — hence `listing`.
- `Cuisine` goes in `shared/src/vocab.ts` (per the schemas rule), with i18n keys `setup.cuisine.*` (already in the prototype).
- The restaurant `name` (bootstrapped as "My restaurant") is overwritten with the confirmed name. `country` and `timezone` come from the place's address, through `packFor` (country literals outside `countries/` fail `boundaries.test.ts`). Careful: `prefillRegion` (`app/src/stores/auth.ts`) already writes a **device-region guess** on the owner's first load, before setup runs, so "only if unset" would mean the real address never wins. Add `regionSource: "device" | "listing" | "owner"` next to them: `prefillRegion` writes `device`, the Settings form writes `owner`, and commit overwrites only when the source is `device` (and the review screen shows the country it will set). Base currency follows the country only while `currencyLocked` is false.

**`restaurants/{rid}/listingImports/{id}` — the job doc** (transient, TTL 7 days):

```ts
{
  status: "running" | "ready" | "failed"
  createdBy: uid, createdAt, expiresAt
  placeId: string | null
  steps: Record<"profile" | "photos" | "website" | "menu" | "reviews",
    { state: "pending" | "running" | "done" | "not_found" | "failed", count?: number }>
  place?: { name, address, country, timezone, phone, website, hours, rating, reviewCount, priceLevel, types, googleMapsUri }
  candidates: Candidate[]           // dishes found, see below
  websiteTried: string[]            // URLs crawled, for the "no menu on that site" message
}

Candidate = {
  key: string                       // stable id for the client list
  name: string; price: number | null; section: string | null
  source: "website" | "website_pdf" | "website_image"
  altPrice?: number                 // a second source disagreed
  match?: { menuItemId: string; kind: "exact" | "fuzzy"; price: number }   // already on the menu
}
```

Photos and reviews are **not** on the job doc — the client asks for them live (`GET /listing/place/:placeId/media`), which keeps the doc free of the content with the strictest rules.

**`menuItems` — two optional fields** (both `models.ts` and `schemas.ts`, mirrored by design):

- `section?: string | null` — the menu heading; the review screen and the Menu page can group by it.
- `origin?: "manual" | "menu_scan" | "listing" | "pos"` — provenance, `.catch("manual")`. Used for "imported dishes still need recipes" and for analytics on how menus get built.

**`restaurants/{rid}/assistant/notes` — one doc** (owner-approved context for the assistant):

```ts
{ items: { id: string; text: string; origin: "suggested" | "owner" }[], updatedAt }
```

Cap: 20 notes × 200 chars. Suggested notes come from the menu and listing only (cuisine, price band, average price, opening pattern), never from review text — see Compliance.

## Claims: one place ↔ one restaurant

Without a registry, nothing stops two accounts from linking the same Google place. Anyone can type a competitor's name, import its public menu and present it as their own listing. Worse, the real owner signs up later and finds their restaurant already "taken". The menu itself is public, so importing it is low-harm. **What a claim protects is identity**: which Teremu restaurant *is* that place. That gets more valuable with every feature built on it (benchmarks, a supplier network, replying to reviews).

**Registry.** Top-level `placeClaims/{placeId}`, server-only like everything else (rules are deny-all). The doc id **is** the Google place ID, so there is exactly one claim doc per place in the world, and that is the idempotency key:

```ts
placeClaims/{placeId} = {
  rid: string | null               // the restaurant it's linked to; null once released
  ownerUid: string                 // who claimed it (audit only; the claim belongs to the rid)
  status: "unverified" | "verified" | "released"
  claimedAt, verifiedAt?: Timestamp
  verification?: { method: "email_domain" | "phone" | "gbp" | "manual"; at: Timestamp; by?: string }
}
placeClaims/{placeId}/events/{auto} = { type: "claimed" | "verified" | "contested" | "transferred" | "released", rid, uid, at, note? }
```

Invariants: **a place is linked to at most one restaurant, and a restaurant to at most one place.** Chains are fine, because every branch has its own place ID. Both sides are written in one Firestore **transaction** inside commit: read `placeClaims/{placeId}` and `restaurants/{rid}.listing.placeId`, decide, then write both.

**Commit decision table** (the transaction):

| Claim doc state | Caller | Result |
|---|---|---|
| absent or `released` | anyone | Create the claim `unverified` for this rid and set `listing.placeId`. |
| linked to **this rid** | same restaurant re-importing | No-op on the claim (idempotent); the import updates menu and notes as usual. |
| linked to **another rid of the same owner** | owner's second location picked the same place (a common slip) | 409 `place_linked_to_your_location` with that location's name: "switch to it or pick another place". |
| linked to **another owner**, `unverified` | possibly the real owner | Commit still succeeds **without** the link (dishes, name and notes save; `listing.placeId: null`, `listing.contested: placeId`). The response offers **"Is this your restaurant? Verify it"**. Event `contested`. |
| linked to **another owner**, `verified` | anyone | Same as above, but no takeover offer except "contact support" (manual review). |

So a conflict never blocks onboarding. The second person keeps everything they typed. Only the *link* is withheld.

**Verification**, cheapest first. Verified beats unverified, and the first to verify wins:

1. **Email at the website's domain**: send a code to `name@<listing website domain>` through `sendMail` (`mtmcya-mailer.md`). Free and instant, but many small restaurants use Gmail, so it only covers some of them.
2. **Phone**: a voice call or SMS code to the listing's phone number. Restaurants answer their landline, which makes this the strongest cheap proof. It needs a telephony provider (new vendor and cost; open decision 5).
3. **Google Business Profile OAuth** (`business.manage`): proves they manage the actual listing. The strongest option, but Google gates Business Profile API access behind an application, so it comes later.
4. **Manual review**: support checks documents (a CIF on an invoice, a utility bill). This is the fallback for disputes involving a verified claim.
5. A free bonus signal: a connected Square merchant whose business address matches the place.

**Takeover.** When the contesting restaurant verifies an `unverified` claim, a transaction moves `rid`, sets the claim `verified`, clears `listing.placeId` on the old restaurant (its data stays: dishes, notes, everything), and logs `transferred`. The old owner gets an email ("this listing was verified by its owner; your Teremu data is untouched"). A `verified` claim only moves through manual review.

**Release.** `DELETE /restaurants/:rid` and "Desvincular" in Settings set the claim `released` (with an event) in the same batch, so the place is free for its real owner. Released claims keep their event history.

**Privacy: no enumeration.** Knowing that a restaurant uses Teremu is itself information a competitor or a sales team would want. So:

- **Search results never show claim state.**
- The conflict surfaces only at commit, for a place the caller deliberately picked, behind owner-only routes and the 5-imports-per-day cap.
- Copy stays generic ("this place is already linked to another account"), never naming the other restaurant.

**Place IDs change.** Google can obsolete a place ID; a Details call then answers with the new one. When a refresh (Phase 3, or any Details call) returns a different ID for a claimed place, migrate in one transaction: create the new claim doc with the same state, release the old one with a `transferred` event, and update `listing.placeId`.

## Backend

New module `firebase/functions/src/listing/`:

- `types.ts` — `ListingProvider` interface: `autocomplete(input, sessionToken, bias?)`, `details(placeId, sessionToken?)`, `photos(placeId, max)`, `reviews(placeId)`. Normalized, provider-blind shapes; callers never see Places field names.
- `google.ts` — Places API (New) over HTTPS with a **field mask per call** (billing is set by the most expensive field requested, so details for the job doc and media for the live endpoint are separate calls with separate masks). Base URL from env config, never hardcoded in callers. 20s `AbortSignal.timeout`, like the Square client.
- `fake.ts` — fixture provider: the five prototype restaurants move here from `restaurantLookupMock.ts`. Selected when `GOOGLE_PLACES_API_KEY` is absent or `TEREMU_TEST_MOCKS` is set (same shape as `adapterFor` in `pos/index.ts`).
- `website.ts` — the crawler: fetch the homepage, find up to 3 menu candidates (links whose text or path says carta/menú/menu…, `.pdf` links, menu-looking `<img>`s), fetch them, turn each into text (HTML → readable lines, no HTML library) or keep it as an image for `extractMenu`. **PDFs are detected but not read in v1** (`menuNote: "pdf"` → the UI asks for a photo). Caps: 3 menu links + 2 images, 2 MB each, 25s.
- `extract.ts` — text-menu extraction through `llm.ts` with a JSON schema. Reuses `MENU_PROMPT`'s rules and `menuDishSchema` from `menuscan.ts` (export them; don't fork the prompt). Image menus go through the existing `extractMenu`. Mock branch keyed on `llmEnabled()` (covers cassette replay), not `llmApiKey()`.
- `merge.ts` — combine candidates from several pages (same normalized name → one candidate, different price → `altPrice`), then match against existing active `menuItems` with `tokens`/`prepareDishes`/`matchItem` from `pos/matching.ts` (cheap tiers only, no LLM tier) to fill `match`.
- `jobs.ts` — the import job, one exported function per client-driven step (create, website, menu) — see below.
- `routes.ts` — the routes below, wired into `api.ts`'s `route()`.

New shared helper `firebase/functions/src/helpers/safeFetch.ts` (nothing like it exists today): http/https only; resolve DNS and refuse private, loopback, link-local and metadata ranges (169.254.169.254, fd00::/8, etc.); follow redirects manually and re-check each hop; max 3 redirects; timeout; response byte cap; content-type allowlist (html, pdf, jpeg/png/webp). Unit-tested on its own.

**Where the long work runs — client-driven steps (changed from the first draft).** The draft used a Firestore trigger; Firestore here is `nam5` while every function is `us-east1`, the cross-location Eventarc setup could not be verified offline, and Cloud Tasks would have needed the tasks emulator in every test script. So the client drives the job one short call per step, each far inside the api's 120s:

- `POST /listing/imports` — creates the job and fetches the listing details (profile, photo and review counts settle at once).
- `POST /listing/imports/:id/website` — reads the site, stores the menu pages' text on the job (image URLs only — bytes are re-fetched by the next step; a doc is capped at 1 MB).
- `POST /listing/imports/:id/menu` — extracts dishes (text via `extractMenuFromText`, images via `extractMenu`), merges, matches; ≤4 runs per job.

The progress on screen is the real step sequence. Leaving mid-import just abandons the job (TTL).

**Routes** (all owner-only in v1; members never see setup. Revisit with `menu: edit` if owners ask to delegate):

| Route | Does |
|---|---|
| `GET /listing/search?q=&session=` | Autocomplete via the provider. `session` is a client-generated UUID so autocomplete + the final details call bill as one session. Biased to the restaurant's `country` if set. |
| `POST /listing/imports` `{placeId, session}` or `{manual: {name}}` | Creates the job (manual = no Places step). Rate limit: 5 imports per restaurant per day → 429. |
| `GET /listing/imports/:id` | The job (page texts stay server-side) — to resume. |
| `POST /listing/imports/:id/website` `{url?}` | Reads the listing's site, or one the owner pasted (`"lalupita.es"` is fine). Candidates from earlier runs are kept. |
| `POST /listing/imports/:id/menu` | Extracts, merges and matches the stored pages. |
| `GET /listing/place/:placeId/media` | Live photos (proxied URLs, never the key) + reviews with attribution fields. Never stored. |
| `POST /listing/imports/:id/commit` | The single write. See below. |
| `POST /listing/skip` | `setupListing: "skipped"`. |
| `GET /listing` / `PUT /listing` | Settings card: read and edit the confirmed listing + notes. |

Menu photos added during review use the **existing** `POST /menu/scan` (and its 5s cooldown) and are merged client-side; no new upload path.

**Commit** (`POST /listing/imports/:id/commit`), strict body:

```ts
{
  restaurant: { name, website, phone, address, cuisines, priceLevel },
  dishes: { candidateKey?: string; name; price; section; action: "create" | "update_price" | "skip_existing"; menuItemId?: string }[],   // ≤150
  notes: { text; origin }[]                                                                                                         // ≤20
}
```

One Firestore batch: create/update `menuItems` (`origin: "listing"`, `recipe: []`, `targetMarginPct: 70`, `active: true` — the wizard's defaults), patch the restaurant (`name`, `listing`, `setupListing: "done"`, country/timezone/currency prefill), write the notes doc, mark the job `committed`. The **place claim** (see Claims) is decided in a transaction that runs first; the batch carries its result (`listing.placeId` linked, or null plus `contested`). Then **one** `rematchAfterMenuChange(rid)` for the whole batch, not one per dish. Returns the created `menuItemId`s. Idempotent on the job id: a second commit returns 409.

**Assistant integration.** The assistant engine runs on Vertex Gemini via `@mtmcya/assistant` and does not use `llm.ts`. Two hooks, both server-side:

- **Facts** (the system prompt's `Label: value.` tail; scalar, one line, ≤80 chars each): `Restaurante`, `Cocina` (cuisines joined), `Rango de precio`. Added to `AssistantPrincipal` in `api.ts` (one extra read of `restaurants/{rid}`, or fold into `getPlanInfo`) and declared in `manifest.facts`.
- **Tool** `getRestaurantNotes` (`query` row, `permission: "app:read"`) returning the notes doc, plus one rule line in `prompt.md` ("check the owner's notes before answering about opening hours, specialties or policies"). Built with the `assistant-tool` skill: row + fixtures + mock script keys + eval case + conformance.

**Secrets & config.** `GOOGLE_PLACES_API_KEY = defineSecret(...)` is exported from `listing/google.ts` but **not yet in the `api` function's `secrets` array**: a deploy that references a secret missing from Secret Manager fails, so binding it is the go-live step (after the secret exists). Until then the key is read from the environment — put it in `firebase/functions/.env.local` to try real Google locally; tests always use the fake (`TEREMU_TEST_MOCKS`). `PLACES_API_URL` overrides the base URL. Set in prod with a script modeled on `scripts/pos-secrets.mjs` (refuses `demo-*`, checks state first, stdin only, `--dry-run`). In Google Cloud: restrict the key to Places API (New) only. **Never let a script or test reach the prod project without explicit OK.**

**`llm.ts` change.** Cassettes key on label + image bytes only, so a text-only call has no key and throws in replay mode. Add a text-hash key (label + SHA-256 of the text parts) so the website-extraction tests can record/replay. Read `llm.md` first; this touches every caller's cassette path.

## Frontend

**Store `app/src/stores/listing.ts`** (Pinia, REST via `apiFetch` like every other store). The prototype's page-local state moves here so the page becomes presentation only:

- state: `phase`, `query`, `results`, `session`, `importId`, `job`, `dishes` (the editable review list: `{key, name, price, section, source, altPrice?, match?, selected, confirmed}`), `notes`, `restaurantDraft`, `media` (live photos/reviews), `error`.
- actions: `search(q)` (200ms debounce + sequence guard, from the prototype), `start(placeId | manualName)`, `poll()` (setTimeout loop; stops on terminal state or `stop()` on unmount; after 90s with no step change shows a retry like Triage's `STALE_MS`), `readWebsite(url)`, `addMenuPhoto(file)` (`compressReceipt` → `apiUpload('/menu/scan')` → merge into `dishes`), `commit()`, `skip()`, `reset()`.
- Draft survival: the review list is saved to `sessionStorage` under `teremu-listing-draft:${rid}:${importId}` so an accidental reload mid-review doesn't lose edits; the job doc itself is resumable (`GET /listing/imports/:id`). Location switch (`location.ts`) calls `listing.reset()` alongside `kitchen.reset()`.
- `schemas.ts`: lenient `listingSearchSchema`, `listingImportSchema`, `listingMediaSchema`, `listingCommitResponseSchema`; types via `z.infer` in `types.ts`.

**Page split.** `RestaurantSetupPage.vue` is ~700 lines in the prototype. Split into `components/setup/`: `SetupSearch.vue`, `SetupProgress.vue`, `SetupHero.vue` (identity + live photos + attribution), `SetupMenu.vue` + `SetupDishRow.vue` (editing, conflicts, matches against the existing menu: "ya en tu carta" / "precio cambió de X a Y"), `SetupReviews.vue` (attribution, ordering notice), `SetupNotes.vue`. Delete `restaurantLookupMock.ts` once the fake provider exists server-side.

**After commit.** `kitchen.refresh()` (new dishes), `auth.reloadProfile()` (name, `setupListing`, currency/country). The done screen's main action becomes **"Estimar recetas"**: open `MenuScanWizard` with its existing `seed` prop at the drafts step, pointed at the just-created dish ids. The wizard currently only *creates* dishes in `saveAll`; it needs an "update existing" mode (`PUT /menu-items/:id`) for this hand-off. That is the one change to existing menu code.

**First-run routing.**

- `/me` returns `setupListing`. Router guard (`router/index.ts`), right after `await auth.whenProfile()`: if `role === 'owner' && setupListing === 'pending'` and the target isn't `restaurant-setup`, `settings` or `pricing`, redirect to `restaurant-setup`. The guard is the right place: it covers deep links and the login `?redirect=` too.
- Route permission: `restaurant-setup` becomes owner-only (today the prototype uses `['menu','read']`).
- `OnboardingWizard` (the tour, `AppShell.vue`) doesn't open on `restaurant-setup`; it opens after setup is done or skipped, which is when the tour makes sense.
- Invited staff never see it: they join an existing restaurant (`role: member`), and the guard only redirects owners.
- Re-entry points: the Menu page empty state ("Importar desde tu web o Google") and a Settings card.

**Settings card "Tu restaurante"** (owner, after the location-name card): the linked place (with "Google Maps" attribution), editable website/phone/cuisines, the notes list (same editor as the setup screen), and "Volver a importar". Saves through `PUT /listing`.

**Rules that apply unchanged.** Every string in `setup.ts` / `settings.ts`, `es` first, `en` typed against it; animations stay in Recipe 6 (transform/opacity, 200–350ms, reduced-motion off); money through `n(x, 'currency')` — a menu found in a foreign currency is not converted in v1, the review screen warns and the owner edits (base currency isn't locked yet at onboarding).

## Money: the IVA question

`menuItems.price` today is the menu price as printed — IVA-inclusive in Spain — for manual entry, the menu-scan wizard and POS matching (`pos.md`). The import writes the same thing, so it is consistent with the status quo. The open problem is pre-existing and bigger than this feature: `pos.md` flags that margin revenue should be IVA-exclusive and plate costs base imponible. When that is resolved (a `taxInclusive` flag or a rate on the country pack), imported prices follow the same rule as every other dish. **Don't solve it inside this feature.**

## Cost & abuse

- Places: 1 Details (Enterprise + Atmosphere) per import, ~5 photo fetches when media is shown, autocomplete inside the session. Free tier is 1,000 Details/month for that SKU; beyond it $25/1,000 → **$0.025 per import**. Photo SKU pricing to re-verify.
- LLM: 1–4 text extraction calls + 0–3 vision calls per import — the same order as one menu scan. Quota-free like the rest of menu setup (`business-model.md`), protected by the 5/day/restaurant import cap and owner-only routes.
- Website fetches: ≤4 per import, capped in size and time by `safeFetch`.
- Log one `listing_import` line per job (steps, counts, durations, LLM labels) so the funnel is measurable: how many owners find their place, how many have a website, how many menus extract, how many dishes get edited before commit.

## Dev & testing

- **Offline by default.** Fake provider + fixture websites (`firebase/functions/test/fixtures/listing/`: an HTML menu, a site linking a PDF menu, an image-only menu, a site with no menu, a redirect to a private IP) served by a fake fetcher, so emulator runs never touch Google or the internet.
- **Integration tests** (`firebase/functions/test/listing.test.ts`): search → import → poll → commit writes dishes with `origin: listing`, renames the restaurant and sets `setupListing: done`; dedupe against a seeded dish (`match` filled, `update_price` updates instead of duplicating); `altPrice` on conflicting sources; manual (no place) path; owner-only (member → 403); daily cap → 429; claims: same rid re-import is a no-op, same owner's other location → 409, another owner → commit without link + `contested`, takeover on verify clears the old link but keeps its data, delete/unlink releases; commit twice → 409; country/timezone overwrite only a `device`-sourced region and currency only while unlocked; a single `rematchAfterMenuChange` per commit. `safeFetch` unit tests: private and metadata IPs, redirect into a private range, oversize body, wrong content type.
- **Cassettes** for website extraction once `llm.ts` has text keys.
- **e2e**: `e2e/tests/auth.setup.ts` walks the first-run flow and will hit the new redirect — it skips setup ("Prefiero empezar de cero") so every other spec starts as today; `fixtures.ts` already suppresses first-run overlays and needs the same awareness. New spec `e2e/tests/setup/listing.spec.ts` runs the happy path, the no-website path and the manual path against the fakes.
- **Demo profiles**: `buildProfile` sets `setupListing: "done"` (and a `listing` for realism) so seeded locations never redirect. Read `demo-profiles.md` first — Harbor Bistro's numbers are pinned.

## Phased delivery

| Phase | Scope | Size |
|---|---|---|
| 0 — prerequisites | Legal answer on open decision 1 and the AI-use wording; Places key on the GCP project, restricted; `safeFetch` + tests; `llm.ts` text cassette keys; `setupListing` field, `/me`, router redirect, skip route, `auth.setup.ts` updated. Ships nothing user-visible except "skip". | ~2–3 days |
| 1 — import & commit | `listing/` module with fake + Google provider; job doc + trigger + polling; website crawl (HTML + PDF text + menu images); commit route with the `placeClaims` registry (claim, idempotent re-import, same-owner 409, contested-without-link); store + split page wired to the real API; attribution UI; integration + e2e tests. | ~1–1.5 weeks |
| 2 — fit into the app | Dedupe/match against existing menu; "Estimar recetas" hand-off (wizard update mode); assistant facts + `getRestaurantNotes` tool (assistant-tool skill); Settings card (incl. Desvincular → release); claim verification (email-at-domain + manual review) and takeover; Menu empty-state entry; demo profiles. | ~1 week |
| 3 — keep it fresh | "Volver a importar" diff (website prices vs current menu → suggested price updates); live reviews in Settings; evaluate Gemini's Grounding with Google Maps as an alternative source once the LLM provider moves to Gemini (`llm-provider-plan`). | later |

## Built vs. designed (2026-10-19)

Where Phase 1 as built differs from the design above, and why:

- **Client-driven steps, not a trigger + polling** — see "Where the long work runs".
- **Persisted on the restaurant:** name, `listing.{placeId, contestedPlaceId, website, cuisines, priceLevel, confirmedAt}`, country/`regionSource` (+ currency while unlocked). **Not** persisted: address, phone, hours, rating, reviews, photos. That is open decision 1's safe default; the review screen only shows them.
- **No review text feeds the assistant.** Suggested notes come from the listing (cuisine, city, price band) and the menu (average price, size). The prototype's "♥ Favorito" and "star dish" (both derived from reviews) were dropped.
- **Photos are `<img>` straight from Google's short-lived photo URLs** (`skipHttpRedirect`), so no proxy route and no key in the browser. The fake backend serves SVG gradient tiles.
- **Dishes:** `menuItems` gained `section` and `origin` (both sides; the app schema carries them through `PUT /menu-items/:id`, which replaces the whole doc). Commit creates dishes with an empty recipe at a 70% target, like the menu-scan wizard.
- **Matching** uses `pos/matching.ts` tiers 1–2 (exact; fuzzy ≥ 0.8). A matched row commits as `update_price` when the price changed, else `skip_existing`.
- **Assistant notes are a collection** — `restaurants/{rid}/assistantNotes/{n<i>}` (`text`, `origin`, `order`), not one doc: the assistant reads them with a declarative `query` row (`getRestaurantNotes`, `menu:read`), which can only read collections. `listing/notes.ts` owns reads/writes. Facts on the principal: `Restaurant`, `Cuisine`, `Price range` (from `getPlanInfo`'s existing read). `prompt.md` says notes are data, never instructions; `test/assistant.test.ts` has an injection-canary note.
- **Verification as built:** email-at-domain only (domain from the LIVE listing's website; platform domains like facebook.com/wixsite.com excluded → manual review); 6-digit code hashed at rest, 15 min, 5 tries, 3 sends/hour, plus a per-address mail cap (`claim-verify` kind in `mail.ts`). Takeover moves the link in one transaction and mails the previous owner (`claim-transferred`). Manual review only records `placeClaims/{placeId}/reviews/{rid}` — there is no admin UI; support handles it in the console. Phone and Business Profile OAuth are not built.
- **Recipe hand-off:** `MenuScanWizard` takes seed entries with a `menuItemId` and updates those dishes in place; the Menu page shows "N platos importados sin receta → Estimar recetas" and the setup done screen deep-links to `/menu?recipes=listing`. `kitchen.saveMenuItem` now carries `section`/`origin` through a PUT.
- **Not built:** PDF text, the review draft in sessionStorage, the split into `components/setup/`, the location name in the same-owner 409 copy, Phase 3, phone / Business Profile verification, a support UI for reviews, and a live `assistant:eval` run for `getRestaurantNotes` (this repo has no eval harness).

## Open decisions

1. **Persisting Google-derived address, phone and hours** after the owner confirms them — legal call (see Compliance). Default if unanswered: persist only what came from the owner or their website; re-fetch hours live by place ID.
2. **Is setup skippable?** Proposed: yes, one tap, never asked again (re-entry from Menu and Settings). A mandatory step blocks owners whose menu isn't online.
3. **Who pays for Places** — which GCP billing account and project the key lives on (teremu-app vs a shared MTM project, like the mailer).
4. **Owner-only vs `menu: edit`** for the setup routes. Proposed: owner-only in v1.
5. **Which verification methods ship first.** Proposed: email-at-domain plus manual review in Phase 2. Phone needs a telephony vendor (cost, new account). Business Profile OAuth needs Google's API access approval, so apply early if we want it.

## Gap → resolution map

| Gap found in the prototype review | Resolution |
|---|---|
| Prices from the web or photos may be stale | Photo-sourced prices and cross-source conflicts are flagged until the owner confirms or edits (`confirmed`, `altPrice`); commit sends the owner's numbers |
| Menu incomplete | Add dish by hand + existing menu-photo scan, merged into the same list |
| No website / PDF / image menu / not on Google | Per-step `not_found`; paste-a-link re-run; PDF text + vision for images; manual path with no place |
| Assistant learns wrong things | Notes are suggestions until kept; editable in setup and Settings; never derived from review text |
| Duplicates with an existing menu (POS or earlier scan) | `merge.ts` matches with `pos/matching.ts` tiers; review shows "ya en tu carta" / price change; commit updates instead of creating |
| IVA in printed prices | Unchanged status quo; follows the `pos.md` follow-up when it lands |
| Nobody reaches the page | Router redirect for new owners + Menu empty state + Settings card |
| Seeded/demo locations would be redirected | `setupListing: "done"` in demo profiles; missing field reads as done |
| Anyone can link a competitor's place | `placeClaims/{placeId}` registry, one transaction per commit, verification + takeover, no enumeration in search |
| Imported dishes have no recipes | "Estimar recetas" hand-off into the existing draft step |

## Verify against live Google docs before Phase 1

- Current Service Specific Terms wording for Places (New) caching of non-place-ID content (only the 2025-05 archive was read).
- The Maps Platform terms on using Places content with machine learning / LLMs (not verified).
- Autocomplete (New) session pricing when the session ends in a Details call.
- Place Photos (New) SKU price and free cap.
- Details field → SKU mapping for every field in the job doc's mask (one Enterprise + Atmosphere field upgrades the whole call).
- Attribution requirements (verified 2026-10-16 policies page — recheck at build time).

Sources: [Places API policies](https://developers.google.com/maps/documentation/places/web-service/policies), [Maps Platform pricing](https://developers.google.com/maps/billing-and-pricing/pricing), [Service Specific Terms archive 2025-05-01](https://cloud.google.com/archive/maps-platform/terms/maps-service-terms-20250501).
