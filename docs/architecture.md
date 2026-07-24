# Teremu — Architecture

## How the pieces fit together

The repo is an npm **workspaces** monorepo — `shared` (`@teremu/shared`), `app`, and `firebase/functions`. Vite builds the Vue 3 SPA into `app/dist/`. `scripts/deploy.mjs` (`npm run deploy`) builds `@teremu/shared`, copies the SPA into `firebase/app/` — where **Firebase Hosting** serves it with an SPA rewrite (`** → /index.html`, required because the router uses `createWebHistory` — real URLs, no hash) — bundles the functions, and deploys both. The same `dist/` is what **Capacitor** packages into the iOS/Android shells (`webDir: 'dist'`), so web and native always ship the same build.

The app talks to a single Cloud Function (`api`) over JSON via `src/lib/api.ts`. The client has **no Firebase SDK** — all Firestore and Storage access happens server-side in the function with the Admin SDK. The CORS allow-list includes both web origins and the Capacitor origins (`capacitor://localhost`, `http://localhost`), which is what the native shells send.

```
Vue app (Pinia stores → useApi → apiFetch)
        │ JSON over HTTPS
        ▼
Cloud Function `api` (hand-rolled router, zod validation)
        │ Admin SDK
        ▼
Firestore (invoices, ingredients, menuItems, revenue) + Storage (receipt JPEGs)
        ▲
onReceiptUploaded (Storage trigger) → VLM OCR (llm.ts, NVIDIA by default — docs/llm.md) → line items onto the invoice
```

## Local development

The entire stack runs offline in the **Firebase Emulator Suite** under the `demo-app` project id — the `demo-` prefix makes the emulators never touch real Firebase resources and require no `firebase login`. The app targets the emulated function via `VITE_API_URL`. Without an LLM API key (see `docs/llm.md`), the OCR module returns a deterministic mock extraction, so scan → triage → approve → margins works end-to-end on a fresh clone.

## Teremu domain flow

1. **Scan**: an on-device quality gate (brightness + variance-of-Laplacian blur check, ~5ms) can hold a bad capture and ask retake/use-anyway. Good captures POST to `POST /invoices`; the function stores the image and creates an invoice with `status: "processing"` — the camera never blocks.
2. **OCR (staged)**: the Storage trigger sends the image to a vision model (provider-agnostic — `docs/llm.md`), which first *classifies* (`kind: receipt | other` + confidence — non-documents fail distinctly as `not_a_document`) then *extracts* line items. A deterministic *arithmetic validation* stage cross-checks qty × price against line totals and the line sum against the printed total; discrepancies become `warnings` on the invoice and per-line flags rather than failures. Status becomes `needs_review`.
3. **Triage**: the app lists `needs_review` invoices; approving one (`PUT /invoices/:id/approve`) rolls each ingredient's price (`prev ← last, last ← new`) and adds purchased qty to the Theoretical Pantry — one atomic batch.
4. **Margins**: menu items store recipes (ingredient + qty per plate); plate cost is computed from the rolling `lastUnitPrice`, client-side, live.
5. **Pantry**: theoretical qty = purchases − sales. `POST /revenue` (with optional dishes-sold counts) depletes it via recipes; `PUT /ingredients/:id/count` overwrites with a physical count (monthly true-up).
6. **Pulse**: the home page derives the weekly expenses-vs-revenue series and alerts (≥5% vendor price moves, dishes under target margin) from the fetched collections.

Navigation animations run through the View Transitions wrapper in the router with automatic degradation (see `docs/animations.md`); all user-facing strings flow through vue-i18n (see `docs/i18n.md`).

## Shared types & validation (zod)

Zod is the single source of truth for every domain type, on both sides. The shared **vocabulary** lives in one place; the entity schemas are deliberately per-package.

- **`@teremu/shared`** (`shared/src/vocab.ts`) — the shared vocabulary: the enums (units, categories, invoice status, doc type) and the permission shape (`permLevelSchema`, `permsSchema`). Both packages import it, so adding a unit / category / permission area is a one-line change in a single file that can never drift between the two sides.
- **Functions** — `firebase/functions/src/models.ts` re-exports `@teremu/shared` and defines the API's own entity/request schemas. Request bodies are parsed with them (`ZodError` → 400 with `z.flattenError`), Firestore document types are derived with `z.infer` (`InvoiceDoc`, `IngredientDoc`, `MenuItemDoc`), reads in `pipeline.ts` are `safeParse`d so malformed docs are skipped rather than propagated, and even the untrusted VLM output in `ocr.ts` goes through a `coerce`/`catch` schema that absorbs sloppy model JSON.
- **App** — `app/src/lib/schemas.ts` re-exports `@teremu/shared` and defines the client's own entity schemas (plus the `id` field and list variants). `app/src/lib/types.ts` derives every type with `z.infer`, and `apiFetch` takes an optional schema to validate responses at the boundary — a shape mismatch surfaces as `{ ok: false, error }`, not a crash three components later.

Why only the vocabulary is shared and the **entity** schemas stay per-package: they encode a deliberate asymmetry — the API parses untrusted request bodies **strictly** (`.positive()`, `.min(1)`, required fields), while the app validates **responses leniently** (loose/optional, carries `id`) so a slightly-off or legacy response doesn't crash downstream. Merging them would erase that safety margin; sharing the enums (byte-identical, and the thing that actually drifts) does not. A change to an entity shape therefore still touches both files by design — and `apiFetch`'s response validation loudly catches any real drift at dev time.

Both packages are on **zod v4**. Functions builds via **esbuild** (`firebase/functions/esbuild.mjs`), which inlines `@teremu/shared` into `lib/index.js` and keeps the runtime deps (`firebase-admin`, `firebase-functions`, `stripe`, `zod`) external — so the deployed artifact is self-contained and the cloud runtime never has to resolve the unpublished workspace package. Typechecking is a separate step (`tsc --noEmit`), since esbuild does not typecheck.

## Tenancy, multi-location & granular permissions

Data lives under `restaurants/{rid}/…` — a shared workspace, not a per-user silo — with `restaurants/{rid}/members/{uid}` carrying granular per-area permissions: `scan` (yes/no) and `triage / menu / pantry / finance` at `none | read | edit` (`vendors` is `none | read`, being derived data). Owners bypass all checks and manage the team. A person can belong to **several restaurants** with a **different role and perms at each** — owner of the flagship, read-only at a second site — since membership is entirely per-restaurant; there is no global super-admin.

**Active location = a validated request header.** The client sends `X-Restaurant-Id` on every call (one `authHeaders()` helper in `app/src/lib/api.ts` builds it alongside `Authorization` for all three fetch paths). `requireMember` (`tenancy.ts`) never trusts the header blindly: it checks a `restaurants/{rid}/members/{uid}` doc actually exists before treating it as active. A missing or stale header (or a fresh device) falls back to the caller's **default membership** — earliest by `addedAt` — rather than erroring; the response carries the resolved rid, which the client persists (`lib/activeLocation.ts`, device-local only — never synced server-side, so each device can have its own active location). `GET /me` also returns `locations: [{ rid, name, role, plan, interval }]`, every restaurant the caller belongs to, for the location switcher in the sidebar.

Membership is indexed at `users/{uid}/memberships/{rid}` (`{ role, addedAt }`) — the switcher's source of truth, avoiding a collection-group query. `users/{uid}` itself is kept only for existence/legacy-default purposes. On sign-in, `resolveMember` attaches **every** pending invite for the caller's email (invites are keyed `invites/{emailKey}_{rid}`, a deterministic id so re-inviting the same person to the same location can't duplicate), and only bootstraps a fresh solo restaurant if the user ends up with zero memberships — an invited-only user never gets a stray extra restaurant. Removing a member or leaving a location (`DELETE /members/:uid`, `DELETE /members/me`) deletes only that one restaurant's member doc and that one `memberships/{rid}` entry, never the whole `users/{uid}` doc, so a person's other locations are untouched.

Every API route declares its required permission (see the ROUTES list in `api.ts`) and enforces it against the *active* rid server-side; the client mirrors the same checks to filter the sidebar, guard routes (redirecting to the first area the member can see), and hide mutating controls — but the server is the authority. A location switch (`stores/location.ts`, `switchLocation(rid)`) is the one place that owns the whole transition: persist the new rid, reset the kitchen/invoice stores (and remount the assistant sheet, keyed on the rid, so its transcript never leaks across locations), reload `/me`, then re-run the router guard's own permission/fallback check in case the new membership's perms (or a stale detail-page id) no longer fit the current route. The owner manages members, invites, and locations (create/rename/delete — `POST/PUT/DELETE /restaurants`) from Settings → Team and the sidebar switcher. See `docs/multi-location-plan.md` for the full design rationale; consolidated cross-location reporting is explicitly out of scope for now — each location's data and dashboards stay independent.

## Email

All outgoing email goes through one helper — `sendMail()` in `functions/src/mail.ts` — which writes a document to the `mail` collection in the shape the **Trigger Email from Firestore** extension expects (`firebase ext:install firebase/firestore-send-email`, configured with your SMTP provider and the `mail` collection). Until the extension is installed — and always in the emulator — queued docs just accumulate in `mail/`, which doubles as a visible outbox for dev. Message builders (currently `inviteEmail`; digest/alert emails belong there too) live next to the helper with PLACEHOLDER copy and a `REPLACE_ME` sender/domain to fill before launch. First consumer: team invites.

## Auth

Google sign-in via Firebase Auth. The client uses the Auth SDK **only** (still no Firestore/Storage on the client); `apiFetch` attaches the ID token as `Authorization: Bearer`, `helpers/auth.ts` verifies it with the Admin SDK, and every route except `GET /health` requires it. On the client, a global `router.beforeEach` guard awaits the initial auth state (`authStore.whenReady()`), sends signed-out visitors to `/login` (remembering the intended destination in a `redirect` query param), and keeps signed-in users off `/login`; AppShell additionally bounces to `/login` when the user signs out mid-session, since guards only run on navigation. All data is namespaced `restaurants/{rid}/{collection}` (see Tenancy above — `rid` is the active location, not the uid), and receipt images live at `receipts/{rid}/{invoiceId}.jpg` (the Storage trigger parses the rid from the path). Receipt images are fetched as authenticated blobs (`fetchBlobUrl`) because `<img>` can't send headers.

Local-first is preserved: with no `VITE_FIREBASE_*` config, the app connects to the **Auth emulator**, whose Google sign-in shows a fake account picker — no real Google account or Firebase project needed. For production, enable the Google provider in Firebase console → Authentication → Sign-in method and fill the four `VITE_FIREBASE_*` vars.

Native caveat: `signInWithPopup` doesn't work inside the Capacitor WebView — swap in `@capacitor-firebase/authentication` when shipping the native shells.

## Known limitations (deliberate scaffold scope)

- **No unit conversion.** Pantry math and plate costing assume the invoice line unit, the ingredient's unit, and the recipe unit are the same (buy salmon in `lb`, recipe in `lb`). A `case` purchase against a `lb` recipe will miscount until a conversion layer (case size per ingredient) is added.
- **Camera needs a secure context.** `getUserMedia` works on `localhost` and HTTPS only — testing from a phone against `http://192.168.x.x:5173` will fall back to the photo-library input. Inside the native shells, WebView camera permissions vary by OS; if that bites, swap the scanner input to the `@capacitor/camera` plugin (the capture → `store.capture(blob)` seam is one function).
- **Web-only Google sign-in.** Popup-based; the native shells need `@capacitor-firebase/authentication` (see Auth section).
- **List queries are time-windowed, not paginated.** GETs accept `?days=` (invoices default 180, revenue/expenses 365) with a 500-doc limit — the Firestore-recommended pattern of bounding reads by window instead of unbounded scans. History older than the window doesn't appear in charts; when multi-year analytics matter, add monthly rollup documents (a scheduled function summing each month into one doc) rather than raising limits.
- **Container purchases convert only when OCR finds pack contents.** Case/box lines with a printed pack size ("24×400g") convert into stock math; without it they stay as billed — a per-ingredient default pack size would close the rest.
- **AI name-matching reduces duplicates but there's no merge tool.** The model maps lines onto the existing catalog at extraction; ingredients that already split before that (or slip past it) still need a manual merge feature to recombine.
- **Revenue is manual.** POS integration (Square/Toast webhook → `POST /revenue`) is the natural next endpoint; the recipe-depletion logic already supports it.
- **Approval is per-invoice.** The blueprint's "swipe to approve the batch" is not built; a batch-approve endpoint would wrap `approveInvoice` in a loop server-side.

## When you need deep links

Opening `https://yourdomain/triage/abc123` directly into the native app requires **Universal Links** (iOS: `apple-app-site-association` file + Associated Domains entitlement) and **App Links** (Android: `assetlinks.json` + intent filters). Deliberately not scaffolded — see the official guide: https://capacitorjs.com/docs/guides/deep-links. The SPA routes are already shaped to support it.
