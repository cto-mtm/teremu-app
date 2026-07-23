# Multi-location plan

Status: **implemented** (all 5 phases below). This document is the design record for letting one account own/join several restaurants and switch between them, with the whole interface scoped to the active location; see `docs/architecture.md` ("Tenancy, multi-location & granular permissions") for the current-state summary. Only "Out of scope (future)" at the bottom remains undone.

## Goal

A user can belong to more than one restaurant, see each restaurant's name/info, and switch the active location. The entire interface (data, team, plan, future integrations) loads scoped to whichever location is active. Switching is a first-class action, not a re-login.

## Why it isn't possible today

Tenant *data* is already fully namespaced under `restaurants/{rid}/…` (invoices, ingredients, menuItems, revenue, expenses, members, vendorContacts) and Storage under `receipts/{rid}/…`. The blocker is a deliberately simple **1:1 binding of user → restaurant** in three places:

1. **`users/{uid}` stores a single `restaurantId`.** `resolveMember` (tenancy.ts) reads that one pointer and returns that one rid. There is no representation of "belongs to several."
2. **The client never states which location it is in.** Every request derives `rid` server-side from the token → `users/{uid}` pointer, so even a user with two memberships has no way to say "I'm in location B right now."
3. **Invite-attach and member-removal clobber that pointer.** Accepting an invite overwrites `users/{uid} = { restaurantId }`; `DELETE /members/:uid` deletes the whole `users/{uid}` doc. Either corrupts a multi-membership user.

Supporting gaps: restaurant docs carry no `name`/profile (only `createdAt`, `ownerUid`, `plan`, `scanPeriod`, `scanCount`), so there is nothing to display in a switcher; and invites are keyed by email alone.

What already fits multi-location and needs **no** change: the permission system (perms live per-restaurant), plan/usage metering (per restaurant), the Stripe subscription (per restaurant — each location bills independently, matching the "Grupo, $79/location" tier), the Storage OCR trigger (parses rid from the path), and the security rules (`allow read, write: if false` on both Firestore and Storage — all access is Admin-only via the API, so there are no per-rid rules to write).

## Decision: active location travels as a validated request header

The client sends `X-Restaurant-Id: <rid>` on every API call. The Firebase ID token still establishes *identity*; the header only selects *which of the caller's locations* is active, and the server never trusts it blindly.

- `requireMember` reads the header, then verifies a `restaurants/{rid}/members/{uid}` doc exists. Valid → that is the active rid. Missing header or not a member → fall back to the caller's **default membership** (earliest by `addedAt`).
- **Self-healing:** a stale rid in `localStorage` (e.g. the user was removed from that location) fails validation and silently falls back instead of erroring; the client then updates its stored rid from the response.
- **Cold start:** first load may have no header. The server resolves the default and returns it *plus the full location list*, the client persists the choice, and subsequent requests carry the header.
- **Persistence: device-local only.** The active location is remembered on the device (client storage), not synced server-side. We explicitly do **not** store `activeRestaurantId` on `users/{uid}` — it would add a write per switch and cross-device coupling for no real benefit. Each device/session keeps its own active location; the server default (earliest membership) covers a fresh device until the user picks one.

## Team members across multiple locations

This is the case that most shapes the model. Membership is already stored **under each restaurant** (`restaurants/{rid}/members/{uid}`, each with its own `role` and `perms`), so one person can have a **different role and different permissions at each location** — owner of the flagship, triage-edit at the second site, read-only at the third. This is a feature, and the permission system needs zero changes; it simply runs against the active rid.

Three 1:1 assumptions must change to make it real:

1. **Invites keyed per location, not per email.** Today `invites/{emailKey}` is keyed by email alone, so inviting the same person to a second location overwrites the first pending invite. Change to key by email *and* rid — either `invites/{emailKey}_{rid}` or an `invites/{emailKey}/locations/{rid}` subcollection. (`emailKey` comes from `normalizeName`, which only emits `[a-z0-9]`, so `_` is a safe delimiter.) Keep the `restaurantId` field so the existing `where("restaurantId","==",rid)` listing/seat-count queries still work.
2. **Sign-in attaches *all* pending invites.** `resolveMember` step 2 currently attaches one. It becomes: find every pending invite for this email, and for each create a `restaurants/{rid}/members/{uid}` doc + a `users/{uid}/memberships/{rid}` index entry, then delete that invite. Someone invited to three locations before first sign-in lands with all three memberships.
3. **Removal is location-scoped.** `DELETE /members/:uid` must delete only that location's member doc and that one `users/{uid}/memberships/{rid}` index entry — never the whole `users/{uid}` doc — leaving the person's other memberships intact.

Consequences to keep in mind:

- **Seats stay per location.** A person at two locations occupies one seat in each — correct, since each location bills its own plan.
- **No global super-admin.** Being owner of location A grants nothing at location B unless separately a member there. Keeps the security model simple and matches how independent restaurants share staff.
- **Bootstrap only on truly new users.** A fresh restaurant is auto-created only when the user has zero memberships *and* zero pending invites (invite resolution runs before bootstrap), so an invited-only user is never given a stray solo restaurant.

## Data model changes

Before → after:

- `users/{uid}` = `{ restaurantId }`  →  `users/{uid}` (kept for existence/default) **plus** `users/{uid}/memberships/{rid}` = `{ addedAt, role }` (one per restaurant). The membership index is the switcher's source of truth and avoids a collection-group query.
- `restaurants/{rid}` gains `name` (required going forward; later `address`, `currency`, `timezone`).
- `invites/{emailKey}`  →  `invites/{emailKey}_{rid}` (or subcollection), still carrying `{ restaurantId, email, perms, createdAt }`.
- No change to any `restaurants/{rid}/…` data collection, Storage layout, or security rules.

Migration is trivial and backward-compatible: for each existing `users/{uid}.restaurantId`, create the matching `memberships/{rid}` entry; backfill `restaurants/{rid}.name` with a default (e.g. "My restaurant") for owners to rename. A one-off `migrate-cli.ts` (same shape as `seed-cli.ts`) can do this idempotently.

## API changes

- **`requireMember`** (tenancy.ts): read `X-Restaurant-Id`, validate membership, fall back to default. Return the active `Member` as today.
- **`GET /me`**: return the active membership (unchanged fields) **plus** `locations: [{ rid, name, role, plan }]` for the switcher. Costs a few extra doc reads (one per location) — negligible for realistic counts.
- **`POST /restaurants`**: create a new location owned by the caller (new restaurant doc + owner member doc + membership index entry). New locations start on the free plan; converting to Pro is a per-location subscription (see Billing). No hard cap on count — locations are a *paid* dimension, so there's little incentive to hoard, and empty free locations cost effectively nothing.
- **`PUT /restaurants/:rid`**: rename / edit profile (owner only).
- **`DELETE /members/me`** (leave a location): a non-owner removes *their own* membership from the active location — deletes that member doc + that `users/{uid}/memberships/{rid}` index entry only. Owners cannot leave (they must delete the location or, later, transfer ownership).
- **`DELETE /members/:uid`** (owner removes another): unchanged behavior, but now location-scoped — only the active location's member doc + that user's index entry for this rid.
- **`DELETE /restaurants/:rid`** (delete a location, owner only): recursively delete the restaurant and its subcollections, cancel the Stripe subscription, remove every member's index entry for this rid, and delete the `receipts/{rid}/…` Storage prefix. Requires explicit confirmation client-side; a user cannot delete their only remaining location without being left with none (surface the consequence).
- **Members & invites endpoints**: already scope to the active rid, so team management becomes per-location for free once resolution is header-driven. Update the invite write/delete to the per-location key and the removal path to be location-scoped (above).
- **CORS** (helpers/cors.ts): add `X-Restaurant-Id` to `Access-Control-Allow-Headers` (currently only `Content-Type`; also add `Authorization` while there).

## Client changes

- **Active-location store**: holds the active rid, persisted in `localStorage`, exposed to the API layer.
- **Header injection in all three fetch paths**: `apiFetch`, `apiUpload`, and `fetchBlobUrl` each build their own headers — every one must attach `X-Restaurant-Id`. (Easy to miss `apiUpload`/`fetchBlobUrl` since they don't go through `apiFetch`.)
- **Location switcher** in the sidebar showing the active restaurant's name, the list from `/me`, current-plan badges per location, and a "＋ Add location" action (→ `POST /restaurants`, then onboarding/empty states for the fresh location).
- **Switch flow**: set active rid → reload `/me` (re-arm the profile promise the router guards await) → refetch the kitchen/invoice stores → re-render scoped to the new location.
- **Guard/route safety on switch**: perms can differ per location, so after a switch the current route may no longer be permitted — reuse the existing `FALLBACK_ORDER` redirect. Also navigate off any detail route (`/menu/:id`, `/triage/:id`, `/pantry/:id`, `/vendors/:key`) to a safe root, because those ids belong to the previous location's dataset.
- **Reset per-location client state on switch**: clear the assistant session transcript (it reasons over one location's data). Decide whether Units (`teremu-units`) stay global or become per-location (recommendation: keep global for now; revisit). Onboarding (`teremu-onboarded:{uid}`) stays per-user/device — a new location relies on empty-state UI, not a re-tour.

## Billing / seed / docs (Phase 5)

**Billing is per location.** Each location is charged independently — its own subscription, priced monthly or yearly, one per location. This is already the architecture (`plan`, `stripeCustomerId`, `stripeSubscriptionId` live on each restaurant doc; the customer portal is per-restaurant), so no billing plumbing changes — the multi-location switcher just exposes it. A user who owns three Pro locations has three subscriptions (three line items / customers), each on its chosen monthly-or-yearly cadence. This *is* the "Grupo" model: Pro × N locations, billed per location. Surface each location's plan (free / Pro, and interval) in the switcher.

- Extend `seed-cli.ts` to create a second demo location and cross-add a member with *different* perms there, so multi-location and per-location permissions are testable end to end.
- Document the model in `architecture.md`; move the "Grupo" tier in `business-model.md` from roadmap to real, described as per-location Pro billing rather than a distinct SKU.

## Clean implementation patterns for the known gaps

Each gap has a standard, low-risk pattern — the point is to solve it once in a shared place rather than scatter fixes.

**1. One header builder, shared by all three fetch paths.** `apiFetch`, `apiUpload`, and `fetchBlobUrl` currently each assemble headers by hand — the classic spot to forget one. Extract a single `authHeaders()` helper that returns `Authorization` + `X-Restaurant-Id`, and have all three call it. New request helpers added later inherit the header for free. (Equivalent to an axios request interceptor, done with one function since we use `fetch`.)

**2. Decouple the API layer from Pinia to avoid a circular import.** The active rid must be readable inside `lib/api.ts`, but stores import the API — importing a store back into the API layer risks a cycle. Keep the active location in a tiny standalone module (`lib/activeLocation.ts`: `get()` / `set()` backed by client storage). The Pinia store and `authHeaders()` both read that module; no cycle, one source of truth.

**3. A single `switchLocation(rid)` action owns the whole transition.** No page should hand-roll switching. One action: set active rid → reset per-location stores → `router.replace('/')` (off any stale detail route) → reload `/me` (re-arming the profile promise the guards await) → refetch stores. This centralizes the route-safety and state-reset concerns (guard fallback still catches per-location permission differences).

**4. Explicit store reset on switch.** Reset the kitchen/invoice stores and clear the assistant transcript with a defined `reset()` per store (or Pinia `$reset()` on option-less setup stores via an explicit clear). Deterministic and testable, versus hoping refetch overwrites everything.

**5. Model invites as query-able documents, not encoded keys.** Sign-in needs "all invites for this email" (query by `emailKey`) and listing needs "all invites for this location" (query by `restaurantId`). Use a top-level `invites` collection with a **deterministic composite id** `{emailKey}_{rid}` (idempotent — re-inviting the same person to the same location can't create duplicates) **plus** `emailKey` and `restaurantId` fields for the two queries (single-field indexes suffice). Deterministic id + explicit fields gives both dedupe and query-ability; avoid parsing data back out of the id string.

**6. Authorize every request against the active rid — never trust the header.** The membership existence check in `requireMember` is one indexed `get()`; it's the whole security boundary for the header approach, so it is not optional and not cached across requests.

**7. Location deletion uses recursive delete + provider cleanup.** Firestore does not cascade: use the Admin SDK `recursiveDelete()` on the restaurant doc, then cancel the Stripe subscription, delete each member's `memberships/{rid}` index entry, and delete the `receipts/{rid}/…` Storage prefix. Owner-only, behind explicit confirmation.

**8. Migration is idempotent and re-runnable.** A one-off `migrate-cli.ts` (same shape as `seed-cli.ts`) that backfills `memberships/{rid}` from existing pointers and sets a default `restaurants/{rid}.name`; safe to run repeatedly, with a dry-run flag to preview.

## Phased delivery

1. **Membership model** — `users/{uid}/memberships/{rid}` index, `restaurants/{rid}.name`, migration CLI.
2. **Invites & resolution** — per-(email,rid) invite keys, header-driven `requireMember` with default fallback, attach-all-invites on sign-in, location-scoped removal.
3. **Endpoints & `/me`** — `locations` list, `POST /restaurants`, `PUT /restaurants/:rid`, `DELETE /restaurants/:rid` (recursive + Stripe cancel), `DELETE /members/me` (leave), CORS header.
4. **Client** — active-location store, header in all three fetch paths, switcher + add-location, switch/guard/reset flow.
5. **Billing, seed, docs** — per-location Pro badges, seeded second location, architecture/business-model updates.

## Resolved decisions

- **Active location = validated `X-Restaurant-Id` header**, persisted **device-locally** (per device/session), never stored server-side.
- **Team members can belong to many locations**, with independent role + perms at each. Invites are per (email, rid); sign-in attaches all pending invites; removal is location-scoped.
- **Leaving a location** is supported: `DELETE /members/me` (non-owners). Owners must delete the location instead.
- **Deleting a location** is supported: `DELETE /restaurants/:rid` (owner only) with recursive delete + Stripe cancel + index/Storage cleanup.
- **Billing is per location** — one subscription per location, monthly or yearly. This is the "Grupo" model (Pro × N locations).
- **No hard cap on locations** — they're a paid dimension, so hoarding is self-limiting; empty free locations are effectively free to us.
- **Reporting stays per location** for now; the active location scopes every view.

## Out of scope (future)

- **Transferring ownership** of a location (single `ownerUid` per restaurant for now).
- **Consolidated cross-location reporting / visualizations** — the richer Grupo value-add. This plan enables switching, not aggregation; robust multi-location dashboards come later.
