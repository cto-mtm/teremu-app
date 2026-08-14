# Security Posture

Teremu handles restaurant financial data (invoices, costs, margins, revenue)
and multi-user tenancy. While not subject to HIPAA or PCI-DSS (we don't store
card numbers — Stripe handles payments), restaurant owners trust us with
competitively sensitive business data. This document describes the security
architecture and the operator checklist for production.

## The architecture IS the security model

- **API gateway:** all business data flows through the `api` Cloud Function.
  Firestore rules enforce tenant isolation at the database level as a
  defense-in-depth layer, but the API is the primary access control point.
- **Access control:** Firebase Auth ID tokens. Membership is resolved from
  Firestore (`restaurants/{rid}/members/{uid}`) — not custom claims. Every
  route verifies the caller belongs to the restaurant they're querying.
  Permissions are checked per-member via the `perms` array on the member doc.
- **Tenant isolation:** every Firestore query is scoped by restaurant id.
  A user can belong to multiple restaurants (multi-location), but each
  request targets exactly one `rid` and is permission-checked against that
  restaurant's member doc.
- **Financial data protection:** invoice totals, ingredient costs, dish
  margins, and revenue figures are visible only to members with the
  appropriate permission areas. The `owner` role has all permissions; staff
  roles are configurable.
- **Transmission security:** TLS everywhere (platform default). Never put
  financial data in URLs or query strings.
- **Log hygiene:** log restaurant ids and invoice ids, never supplier names,
  cost figures, or margin data in plain text logs.

## Storage (receipt images)

Client uploads (invoice photos, receipt scans) go to Storage paths scoped by
restaurant id, gated by `storage.rules` checking the caller's membership.
The OCR pipeline reads from Storage via the Admin SDK (server-side, no
client-side download URLs for raw receipts exposed publicly).

## Secrets (Secret Manager)

Set each with `firebase functions:secrets:set <NAME>`:

| Secret | Used by | Notes |
|--------|---------|-------|
| `NVIDIA_API_KEY` | Receipt OCR (NVIDIA NIM) | absent → deterministic mock (offline dev works) |
| `STRIPE_WEBHOOK_SECRET` | `POST /billing/stripe/webhook` | absent → webhook 400s |
| `STRIPE_SECRET_KEY` | Checkout session creation | absent → checkout 500s |

## Platform checklist (before production)

1. **Blaze plan** — required for Cloud Functions egress and scheduled jobs.
2. Set the Firebase project id in `firebase/.firebaserc` (deploy script
   refuses while the placeholder remains).
3. Hosting site + target configured.
4. Secrets provisioned in Secret Manager (see table above).
5. `app/.env` has `VITE_API_URL` pointing to the deployed function URL.
6. Firestore indexes deployed (`firestore.indexes.json`).
7. Storage rules deployed (`storage.rules`).

## Freemium & entitlements

The billing gate (`free` vs `pro`) is enforced server-side on every
paywalled route. A lapsed subscription restricts writes but never deletes
data — the restaurant can always read and export their own information.

## What we do NOT store

- Credit card numbers (Stripe handles all payment data)
- Customer PII beyond what the restaurant already has in their own invoices
- Passwords in our database (Firebase Auth handles credentials)
