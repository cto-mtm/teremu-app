# Security Posture

Teremu handles restaurant financial data (invoices, costs, margins, revenue),
multi-user tenancy and — since the email import — read access to an owner's
Gmail. It is not subject to HIPAA or PCI-DSS (Stripe holds all card data),
but owners trust us with competitively sensitive business data and their
inbox. This document is the as-built security model, the source for
security questionnaires (Google's CASA assessment for `gmail.readonly`
among them), and the operator checklist for production.

## The architecture IS the security model

- **One API gateway:** every read and write of business data goes through
  the `api` Cloud Function (`firebase/functions/src/api.ts`). The client
  ships **Firebase Auth only** — no Firestore or Storage SDK
  (`app/src/lib/firebase.ts`).
- **Deny-all rules:** `firestore.rules` and `storage.rules` deny every
  client read and write (`allow read, write: if false`). The Admin SDK in
  the functions is the only reader; `test/rules.test.ts` pins it.
- **Authentication:** Firebase Auth ID tokens, verified on every request.
  Sign-in is Google (popup) or email + password; there is no self-service
  sign-up with a password — those accounts are created by an admin.
- **Authorization:** membership is resolved from Firestore
  (`restaurants/{rid}/members/{uid}`), not custom claims. Each request
  targets exactly one restaurant (`X-Restaurant-Id`) and every route checks
  the caller's `perms` on that restaurant's member doc
  (`permsSchema` in `shared/src/vocab.ts`). The `owner` role has all
  permissions; staff roles are configurable. The integration suite asserts
  401 / 403 per route.
- **Tenant isolation:** every query is scoped by restaurant id; a user in
  several restaurants (multi-location) is checked against each one
  separately.
- **CORS:** an allow-list of the app's own origins and the native shells
  (`helpers/cors.ts`); `test/cors.test.ts` keeps the emulator's
  allow-any-origin debug layer from masking it.
- **Transmission:** TLS everywhere, HSTS on Hosting and the API. Never put
  financial data, tokens or personal data in URLs or query strings.
- **Log hygiene:** log restaurant, invoice and connection ids — never
  supplier names, amounts, email content, OAuth codes or tokens.

## Headers

Both layers send headers an external scan checks first;
`test/security-headers.test.ts` pins them.

- **Hosting** (the SPA, `firebase/firebase.json`, every path): a
  Content-Security-Policy, `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, HSTS,
  `Permissions-Policy` (camera for the scanner only) and
  `Cross-Origin-Opener-Policy: same-origin-allow-popups` (the Google
  sign-in popup needs it). The CSP:
  - scripts from `'self'` and `https://apis.google.com` (the Firebase Auth
    popup's loader) — **no inline script, no eval**. The first-paint
    language script lives in `app/public/first-paint.js` for this reason;
    don't put a `<script>` body back into `index.html`.
  - styles from `'self'` and Google Fonts; inline `style` *attributes* are
    allowed (`style-src-attr`), `<style>` elements are not.
  - `connect-src`: the API (`us-east1-teremu-app.cloudfunctions.net`) and
    the Firebase Auth endpoints. A new API host (`VITE_API_URL`) or a new
    third-party SDK needs its host here, or the browser blocks it.
  - `frame-src`: the Firebase auth domain only; `frame-ancestors 'none'`,
    `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`.
  - The native shells load the bundle locally; Hosting headers don't
    apply there.
- **API and OAuth callbacks** (`helpers/securityHeaders.ts`): they answer
  JSON, an image or a redirect, never a page — `default-src 'none';
  frame-ancestors 'none'`, nosniff, `Referrer-Policy: no-referrer`, HSTS
  and `Cache-Control: no-store` unless a route sets its own (the invoice
  image is `private`).

## Invoice images and documents

Photos and PDFs are uploaded **to the API** (`POST /invoices`, raw image
bodies), which writes them to Storage under the restaurant's path with the
Admin SDK. Nothing in Storage is client-readable; the app fetches an image
through the API with its ID token and shows it as a `blob:` URL. PDFs are
rasterized on the device (`app/src/lib/pdf.ts`) or, for email, in the
function.

## Third-party credentials (POS and Gmail)

- **Sealed at rest:** refresh tokens are encrypted with AES-256-GCM
  (`helpers/sealer.ts`) under a key ring held in Secret Manager —
  `POS_TOKEN_ENC_KEY` and `EMAIL_TOKEN_ENC_KEY`, one per integration.
  Each ciphertext names its key version, so a key rotates without a
  big-bang re-encrypt. A deployed function without the key refuses to
  connect rather than store plaintext. Access tokens are never stored.
- **OAuth state:** single-use, bound to the user and restaurant that
  started it, expired by a Firestore TTL policy. The callbacks
  (`posOauthCallback`, `emailOauthCallback`) hold no secrets: they only
  bounce the browser back to the app, and the signed-in user completes the
  code exchange through the API.
- **Revocation:** disconnect revokes the grant at the provider and deletes
  the token fields. A grant revoked on the provider's side flips the
  connection to `needs_reauth` and tells the owner once.

## Gmail data (the `gmail.readonly` scope)

Read docs/email-ingestion.md for the full design; the security-relevant
facts:

- **Scope:** `gmail.readonly` plus `openid email` — read only, never send,
  modify or delete mail.
- **What we read:** the last 31 days once, then only new mail. Messages in
  spam, trash, chats, sent, social and forums are skipped.
- **What we keep:** per message a dedup record (`emailIngests`) — ids,
  sender, subject, date, verdict. A message we reject keeps no preview; an
  accepted one keeps its preview and the vendor / amount hints only while
  it waits to be imported (`PREVIEW_FIELDS` in `email/sync.ts`). An
  imported invoice becomes the restaurant's own record, like a scan.
- **Where it goes:** every model call on email content — classification
  and extraction, page images included — runs on the `vertex` backend
  (Gemini on Google Cloud, docs/llm.md); nothing from Gmail reaches any
  other provider. No email data is used to train models, sold, or used for
  advertising (Google's Limited Use requirements; the privacy policy on
  teremu.com states them).
- **Who sees it:** members of the restaurant the inbox feeds, through the
  same permission checks as any invoice (triage / integrations areas).
- **Deletion:** disconnect keeps imported invoices (the restaurant's
  records) and the dedup ids (so a reconnect doesn't re-import);
  `DELETE /restaurants/:rid` detaches the inbox, revokes its grant and
  recursively deletes everything under the restaurant.

## Outbound requests

Every outbound call goes to a fixed host from config, except reading a
restaurant's website for the listing import, which goes through
`helpers/safeFetch.ts`: public addresses only (no loopback, private,
link-local or metadata ranges), the check made at connect time against
DNS rebinding, redirects re-checked per hop, size, time and content-type
limits.

## Abuse limits

- Per-plan document meter (`consumeScan`) and daily caps on AI calls
  (`helpers/dailyCap.ts`); the assistant meters its own (`aiUsage`).
- Mail: per-user and per-recipient daily caps (`consumeMailQuota`,
  `mail.ts`); all mail goes through `sendMail()` to the shared mailer,
  authenticated with a Google ID token.
- `maxInstances` bounds the API function.

## Secrets (Secret Manager)

Set each with `firebase functions:secrets:set <NAME>`:

| Secret | Used by | Notes |
|--------|---------|-------|
| `NVIDIA_API_KEY` | The LLM provider's key (docs/llm.md) | absent → randomized offline mock (offline dev works) |
| `STRIPE_SECRET_KEY` | Checkout and the customer portal | absent → checkout 500s |
| `STRIPE_WEBHOOK_SECRET` | `stripeWebhook` signature check | absent → webhook 400s |
| `POS_TOKEN_ENC_KEY` | Sealing POS tokens | key ring `ver:base64key[,…]` |
| `SQUARE_APP_SECRET` | Square OAuth | docs/pos.md |
| `EMAIL_TOKEN_ENC_KEY` | Sealing Gmail refresh tokens | key ring `ver:base64key[,…]` |
| `GMAIL_CLIENT_SECRET` | Gmail OAuth | `GMAIL_CLIENT_ID` is public env config |

Vertex calls authenticate as the function's service account — no key.

## Dependencies

`npm audit --omit=dev` must report 0 vulnerabilities before a deploy that
a security review will look at (it did on 2026-10-29). The root
`package.json` `overrides` lifts `@grpc/grpc-js` under the browser
Firebase SDK, which pins a vulnerable range but never ships grpc to the
browser (the app imports Auth only). Drop the override once
`@firebase/firestore` moves past it.

## Platform checklist (before production)

1. **Blaze plan** — required for Cloud Functions egress and scheduled jobs.
2. The Firebase project id in `firebase/.firebaserc` (the deploy script
   refuses while the placeholder remains).
3. Secrets provisioned in Secret Manager (table above).
4. `app/.env.production` carries the Firebase web config (`app/.env.example`).
5. Firestore indexes and TTL policies, Firestore rules and Storage rules
   deployed (`firestore.indexes.json`, `firestore.rules`, `storage.rules`).
6. Firebase Auth: a password policy (minimum length, mixed character
   classes) on the Email/Password provider, and email enumeration
   protection on.
7. After a Hosting deploy, sign in with Google once and check the console
   for CSP violations.

## Freemium & entitlements

The billing gate (`free` / `pro` / `max`) is enforced server-side on every
paywalled route. A lapsed subscription restricts writes but never deletes
data — the restaurant can always read and export its own information.

## What we do NOT store

- Card numbers (Stripe handles all payment data)
- Passwords (Firebase Auth handles credentials)
- Plaintext third-party tokens, or access tokens at all
- Email we rejected beyond its dedup record, or any mail outside the
  31-day window and the new mail since
- Customer PII beyond what the restaurant already has in its own invoices
