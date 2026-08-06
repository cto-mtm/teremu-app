# Email ingestion (Gmail OAuth first)

Status: **design record — not yet implemented.** Target: **early October 2026** (~2 months). Restaurants receive most vendor invoices by email as PDFs; today those get printed or photographed off a screen — or never entered. This feature connects the owner's Gmail inbox from Settings, scans it on a schedule, AI-classifies which messages are actually invoices, and drops the matches into the **existing** pipeline exactly as if they had been photographed: they land in Triage as `needs_review` and ride the approve / expense / discard flow that already exists. No new review UI.

Read this before touching any email-ingestion code. Companion docs: `llm.md` (every AI call goes through `llm.ts`; the provider is env config, never hardcoded here), `pos.md` (this doc reuses its connection/token/permission patterns deliberately — same shapes, fewer decisions), `architecture.md` (tenancy, the invoice pipeline, `sendMail`), `business-model.md` (scan quota economics). **Concurrent work**: multi-page invoice support (`imagePaths` — one invoice doc holding several page images) is being built in the same codebase; this design sits *on top of it* — an emailed PDF renders one page image per PDF page into `receipts/{rid}/…` and the existing Storage-side pipeline takes over.

## Principles

1. **The pipeline boundary is the invoice doc, not a new path.** Email ingestion ends where the scanner's upload ends: page JPEGs in Storage + an invoice doc in `processing`. Everything downstream (OCR, arithmetic validation, Triage, approve/expense/discard, price roll, pantry) is untouched and unaware of the source beyond a `source` field.
2. **Cheap-first funnel.** Gmail's own query filters for free → a text-only LLM pass on headers/snippet → full OCR only for accepted candidates. Never send an attachment to a vision model that a $0.00007 text call could have rejected.
3. **One adapter boundary, like `llm.ts` and `pos/`.** All Gmail HTTP lives in `firebase/functions/src/email/gmail.ts` behind a narrow interface; the sync engine and classifier never see Google field names. A fixture-backed fake implements the same interface offline (no emulator exists for Gmail — same pattern as mock OCR without an API key).
4. **Compliance is the critical path, not code.** `gmail.readonly` is a Google **restricted scope**: verification + an annual paid CASA security assessment gate production. The engineering fits in the window; the verification may not — so the design keeps a no-OAuth forwarding fallback specified and the beta plan works inside Google's unverified-app limits.
5. **Junk must not pollute Triage or burn quota.** Every ingested message keeps a dedup/verdict record; OCR's own classify stage is the final guard (email-sourced `not_a_document` auto-discards); discarding an email-sourced invoice refunds its scan.

## OAuth & compliance (read this before writing any code)

**The scope.** `gmail.readonly` — read-only, includes attachment bodies. Verified 2026-08-05:

- Restricted-scope verification is a multi-week process (brand verification, demo video, scope justification) **plus** a security assessment under the App Defense Alliance's CASA framework, **re-done every 12 months** — [developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification), [support.google.com/cloud/answer/13465431](https://support.google.com/cloud/answer/13465431).
- CASA cost, from authorized labs: **TAC Security (Google's "preferred" partner) from ~$540/yr up to ~$1,800**; other labs (e.g. Leviathan, a CASA framework author) quote **$3,000–$6,000 per assessment** depending on scheduling — [switchlabs.dev pricing survey](https://www.switchlabs.dev/post/casa-tier-2-tier-3-security-review-providers-pricing-and-the-cheapest-option), [leviathansecurity.com/programs/google-casa-cloud-application-security-assessment](https://www.leviathansecurity.com/programs/google-casa-cloud-application-security-assessment). Budget **$540–$1,800/yr** via TAC; treat anything above as a negotiation failure.
- The CASA questionnaire is essentially OWASP ASVS-derived; our posture already matches most of it (no client DB credentials, server-side permission checks, tokens encrypted at rest per the design below). Prep is mostly documentation, not re-architecture.
- **Unverified-app limits shape the beta**: an OAuth app in *Testing* publishing status is capped at **100 test users** and — the one that actually bites — **refresh tokens expire after 7 days**, which breaks unattended daily sync weekly. Verification must be *in flight before Phase 1 code review*, and the beta either lives with weekly re-consent or waits for verification. (Exact current limits are re-verify items — see the checklist.)

**Alternatives considered:**

- **`gmail.metadata`** — insufficient: it cannot fetch attachment bodies (and restricts `messages.get` formats), so it can power classification but never ingestion. It is *also* on Google's restricted list, so it saves nothing on CASA. Rejected.
- **Plus-address forwarding (the escape hatch — cheap, keep it specified even though OAuth is the chosen path).** Each restaurant gets a unique ingest address (`facturas+{token}@in.teremu.com`); the owner sets a Gmail auto-forward filter (or hands the address to vendors directly). Inbound mail via any inbound-parse provider (SES / Postmark / Mailgun) → HTTPS webhook → **the exact same funnel from stage 1 onward** (the classifier and everything downstream are transport-agnostic by design). No OAuth, no CASA, no $540/yr, works with *any* mail provider, not just Gmail. Costs: user setup friction, Gmail's forwarding-confirmation dance, no backfill of existing mail. This is the Phase 0 de-risk: if verification slips past October, forwarding ships the user value on time and OAuth follows. The funnel/pipeline code is shared either way — only the fetch layer differs.

**Token storage.** Refresh tokens go in **Firestore, envelope-encrypted** — AES-256-GCM with a key from Secret Manager (`EMAIL_TOKEN_ENC_KEY`, `defineSecret`, key-version prefix on the ciphertext for painless rotation) — the exact scheme `pos.md` specifies for Square tokens; extract the crypto helper once and share it. Secret Manager itself is *not* a per-user token store (per-version pricing and admin overhead make it wrong for N users); it holds only the KEK. Access tokens are short-lived and cached in memory per invocation, never persisted. Tokens never appear in logs (a CASA check item).

**Revocation & re-consent.** Disconnect in Settings calls `https://oauth2.googleapis.com/revoke` and deletes the token fields. Google-side revocation (user removes access in their Google Account) surfaces as `invalid_grant` on refresh → connection flips to `needs_reauth`, Settings shows a reconnect banner, and the owner gets a `sendMail` alert — same lifecycle as `pos.md`'s `needs_reauth`. Nothing errors loudly in the background forever; sync just pauses.

## Provider abstraction

`firebase/functions/src/email/` — `types.ts`, `gmail.ts`, `fake.ts`, `sync.ts` (engine), `classify.ts` (funnel stages 0–1), `ingest.ts` (attachment → pages → invoice doc), `oauth.ts` (connect/callback/disconnect routes).

```ts
interface MailProvider {
  authUrl(state: string): string
  exchangeCode(code: string): MailTokens            // + accountEmail, accountSub
  refresh(tokens: MailTokens): MailTokens
  revoke(tokens: MailTokens): void
  listMessageIds(tokens, query, cursor): { ids: string[], cursor: string | null }
  listHistory(tokens, startHistoryId): { added: string[], newHistoryId: string } | "expired"
  getMessageMeta(tokens, id): MailMessageMeta        // headers, snippet, attachment manifest
  getAttachment(tokens, messageId, attachmentId): Buffer
}
```

`MailMessageMeta` — `{ id, rfc822MessageId, from, to, subject, snippet, internalDate, attachments: [{ attachmentId, filename, mimeType, sizeBytes, inline }] }`. Normalized, provider-blind; the forwarding fallback produces the same shape from a webhook payload.

Vocabulary (in `shared/src/vocab.ts`, per the schemas rule): `invoiceSourceSchema = z.enum(["scan", "email"])` — the invoice doc gains `source` with `.catch("scan")` so every pre-existing doc reads as a scan; and email ingestion uses the same **`integrations` perms area** `pos.md` already plans (`none | read | edit`; owners bypass) — add it once, both features check it.

## Identity model (inbox ≠ restaurant, but stricter than merchant ≠ location)

`pos.md`'s merchant/location split does not transplant directly: a Square merchant *partitions* into locations; an inbox does not — a message has no location on it. So:

- `emailConnections/{gmail_{sub}}` (top level, keyed by Google account subject — stable across email renames): provider, accountEmail, connecting `uid`, encrypted refresh token, granted scopes, status (`active | needs_reauth | revoked | paused_quota`), epoch, sync cursor (`historyId`, `lastInternalDate`), backfill checkpoint, timestamps.
- `restaurants/{rid}/integrations/email` (one doc): pointer to the connection, settings (`backfillDays` default 30, future sender allow/blocklists), `lastSyncAt`, monthly ingest counters.
- **v1 invariant: one inbox ↔ one restaurant.** Attaching the same Gmail account to two restaurants would duplicate every invoice into both, and there is no per-location signal in the mail to route by. Connect-time check: if the connection doc already points at another rid, refuse with explicit copy ("esta bandeja ya está conectada a {name}"). The multi-location owner with one inbox connects it to the flagship; **sender → location routing rules** are the honest later answer (listed under Later), not a v1 hack.
- The connection stores *who* connected (`uid`) for audit, but ingested invoices are not "uploaded by" anyone — the invoice doc records provenance instead: `email: { messageId, rfc822MessageId, from, subject, receivedAt, connectionId }`. Any staff member with triage perms reviews them, same as scans.
- Staff/shared-inbox reality (a gestoría or an office manager mailbox): whoever holds `integrations: edit` (or the owner) connects whatever inbox they control. The classifier + Triage + discard-refund make a noisy inbox survivable; routing precision is the owner's choice of which inbox to connect.
- **Disconnect** (per restaurant, which under the v1 invariant is per connection): revoke token, delete token fields, connection becomes a tombstone (status `revoked`, epoch kept). **Ingested invoices are retained** — they are the restaurant's own records; UI copy states this. The `emailIngests` dedup records are also retained so a later reconnect of the *same* account never re-ingests old mail; reconnecting a *different* account is a different connection doc, so old dedup state simply doesn't apply (epoch bump covers the same-doc/different-grant edge). Full purge rides `DELETE /restaurants/:rid` recursive delete.

## Sync engine

**Scheduling.** One `onSchedule` v2 function in **us-east1** (`REGION`, like everything else), `schedule: "every 6 hours"` — daily is the floor the founder asked for; 6h costs nothing extra (the funnel's stage 0 is free and stage 1 is fractions of a cent) and makes the feature feel alive. Each tick iterates `emailConnections` where status is `active`, sequentially (connection counts will be small for a long time; parallelize later if ticks run long).

**Incremental sync: History API first, query fallback.** Steady state uses `history.list` from the stored `historyId` (2 quota units — near-free) to get new message ids. Gmail expires history (typically ~a week); on `expired`/404 fall back to query-based sync: `messages.list` with

```
q = "has:attachment after:{lastInternalDate/1000} -in:spam -in:trash -in:chats -from:me"
```

then advance both cursors. First sync (backfill) is always query-based with `after:` = now − `backfillDays` (default **30 days** — enough to feel magical, bounded enough to never swallow a decade-old mailbox). Pagination 100 ids/page; the backfill is **chunked and resumable** exactly like `pos.md`'s: each tick processes up to ~200 new messages per connection, checkpointing the page cursor on the connection doc, until caught up.

**Quota math (verified against [developers.google.com/workspace/gmail/api/reference/quota](https://developers.google.com/workspace/gmail/api/reference/quota), updated by Google 2026-05-01):** per-project 1,200,000 units/min; **per-user 6,000 units/min**; `messages.list` 5, `messages.get` 20, `attachments.get` 20, `history.list` 2, `users.watch` 100; free below a new 80M units/day billing threshold. A 600-email/mo inbox costs ~`6×5 + 600×20 + 300×20 ≈ 18K units` for a *full 30-day backfill* and ~50–200 units per steady-state tick — three orders of magnitude under the limits. Still: page sequentially per user (community-reported per-user burst limits ~250 units/sec exist), exponential backoff on 429, and never fan out attachment fetches concurrently per mailbox.

**Dedup.** `restaurants/{rid}/emailIngests/{gmailMessageId}` — written **before** any processing (create-if-absent is the idempotency gate; a crashed tick re-runs safely). Fields: `rfc822MessageId`, from, subject, `internalDate`, `verdict` (`skipped_prefilter | classified_no | ingested | deferred_quota | failed`), `invoiceId | null`, classifier confidence, epoch, timestamp. The Gmail message id dedupes within the mailbox; the RFC-822 `Message-ID` header additionally catches the same message arriving twice (forwarded copies) — checked with a bounded query before ingesting. These records double as the funnel's observability: junk-rate and precision are one collection-group count away.

**Attachments → pages.** For each accepted message:

- **PDFs**: rasterize **one JPEG per page** into `receipts/{rid}/…` in whatever layout the concurrent multi-page work defines for `imagePaths` (coordinate — do not invent a second layout). Rasterizer: **`pdfjs-dist` (legacy Node build) + `@napi-rs/canvas`** — pure npm install, prebuilt native binary, no system packages, works in Cloud Functions; both stay `external` in `esbuild.mjs` like the other runtime deps. Render capped at **1600px long edge, JPEG q≈80** — the same ceiling as the app's `downscaleReceipt`, which `llm.md` calls out as a *cost control*, not just bandwidth: it is what keeps a page at ~1.5K image tokens.
- **Images** (vendors who photograph the invoice into the mail, including inline parts): `image/jpeg|png` attachments ≥ ~100 KB *and* plausibly document-sized are pages; tiny inline logos/signatures are skipped by the size gate.
- **Limits**: skip attachments > 10 MB; rasterize at most **10 pages** per PDF (warn on the invoice when truncated); at most 3 candidate attachments per message (each becomes its own invoice doc — a message carrying two vendor PDFs is two documents). Password-protected/corrupt PDFs → invoice doc created with `status: "failed", error: "unreadable"` so it *surfaces* in Triage instead of vanishing — no quota charged (see ordering below).
- **Handoff**: the worker writes all page images, **then** creates the invoice doc (`status: "processing"`, `source: "email"`, provenance block) and invokes the pipeline entry point directly — *not* via the Storage trigger, which exists for app uploads and would fire once per page. The multi-page work owns the pipeline's multi-image entry point; email ingestion is just its second caller.

**Ordering per document**: rasterize → `consumeScan` → OCR. Quota is charged only for documents that actually reach the model.

## AI classification funnel (cheap-first)

**Stage 0 — free.** The Gmail *query itself* is the first filter (`has:attachment`, spam/trash/chat/self excluded — zero tokens, zero units beyond the list call). On the metadata: keep only messages with a candidate attachment (PDF or big image); **fast-path allowlist** — a sender whose previous email invoice was *approved* skips stage 1 entirely and goes straight to OCR. Expected to eliminate 60–70% of a real inbox before any model sees anything.

**Stage 1 — text-only LLM classification.** One batched call per ~25 messages through `chatCompletion` (label `email-classify`, `json` structured output, mock verdicts offline — all per `llm.md`; **provider stays env config, nothing Gmail-specific reaches `llm.ts`**). Input per message: From, Subject, Gmail snippet (~200 chars), attachment filenames + sizes — ~120–150 tokens; prompt ~350; output `{ id, isInvoice, confidence }` ~20 tokens/message. Threshold ~0.6 to ingest; es/en prompt examples must cover *factura, albarán, recibo, estado de cuenta (reject), pedido/confirmación (reject), marketing (reject)*. Per-message cost at Gemini 3.1 Flash-Lite ($0.25 in / $1.50 out per 1M, re-verified 2026-08-05 — matches `llm.md`, checked 2026-07-24; note Google retires 2.5 Flash-Lite 2026-10-16, our preset is already 3.1): **≈ $0.00007/message**.

**Stage 2 — full OCR extraction, existing pipeline.** ~$0.0025/page average (the `llm.md` verified figure at ≤1600px). OCR's own classify stage (`kind: receipt | other`) is the final guard: an email-sourced invoice that comes back `not_a_document` is **auto-discarded** (status `discarded`, scan refunded) instead of `failed` — a scan-sourced failure means "retake the photo", an email-sourced one means "the classifier was wrong", and the user should not have to clean that up.

Token budget per stage (per message / per document):

| Stage | Input tokens | Output tokens | Cost each |
|---|---|---|---|
| 0 · query + heuristics | 0 | 0 | $0 (≤ a few Gmail quota units) |
| 1 · text classify | ~135/msg (+ prompt amortized) | ~20/msg | ~$0.00007/message |
| 2 · OCR extract | ~2.7K/page (image ~1.5K + prompt + catalog) | ~800/page | ~$0.0025/page |

A stage-2 call is ~35× a stage-1 call; stage 1 rejecting one marketing PDF pays for ~35 classified messages. That ratio is the whole reason the funnel exists.

## Triage integration

- **Invoice doc changes** (both `models.ts` strict and `app/src/lib/schemas.ts` lenient, mirrored by design): `source: invoiceSourceSchema.catch("scan")`; optional `email` provenance block; a new warning code `possible_duplicate` (below). Nothing else — Triage renders `needs_review` docs it already knows how to render, plus a small source badge ("📧 correo") and the sender/subject line in the detail view.
- **Quota: emailed documents consume the scan quota.** Same inference cost, same value metric ("documents digitized" is what the meter always really was); exempting email would let a 600-email inbox out-cost a capped scanner and make the tiers incoherent. One scan per *document* (not per page — matches how `consumeScan` meters `POST /invoices` today; multi-page multiplies inference, not quota, which is a deliberate simplification `business-model.md` can absorb at these margins).
- **Junk protection, three layers**: (1) the funnel keeps false positives to a trickle; (2) auto-discard on OCR `not_a_document` with refund; (3) **discarding an email-sourced invoice refunds its scan** — a small transactional decrement in the discard handler, same period only. The discard flow already exists (`PUT /invoices/:id/discard`); refund-on-discard means a misfire costs the user one tap and zero quota, which is what makes auto-ingestion tolerable at all.
- **Quota exhaustion pauses, never drops**: when `consumeScan` refuses, the connection flips to `paused_quota`, remaining candidates get verdict `deferred_quota` (re-attempted next period), Settings shows it, and the owner gets one `sendMail` nudge (which is also the single best upgrade prompt this feature produces — "12 facturas esperando en tu correo").
- **Duplicates (emailed and photographed)**: undetectable pre-OCR (different pixels). Post-OCR, before flipping to `needs_review`: if an existing non-discarded invoice matches on (vendor name key, invoice date, total ±2%), attach `possible_duplicate` — a warning like the arithmetic ones, guiding the reviewer's eye, never blocking. Works in both directions regardless of which copy arrived first.

## AI cost & business-model impact

Model of a realistic restaurant inbox at Gemini 3.1 Flash-Lite prices ($0.25/$1.50 per 1M — see `llm.md`). Assumptions: prefilter passes 40% of mail; classifier false-positive load ≈ +20% of true invoices; 1.5 pages/document average (emailed PDFs are longer than photos); $0.0025/page OCR; $0.00007/message stage 1.

| Inbox / month | Emails | Real invoices | Stage-1 msgs (×40%) | Stage-1 cost | Docs OCR'd (×1.2) | Pages (×1.5) | Stage-2 cost | **Email AI total** | Photo-only equivalent | Delta |
|---|---|---|---|---|---|---|---|---|---|---|
| Light | 200 | 20 | 80 | $0.006 | 24 | 36 | $0.090 | **≈ $0.10** | $0.05 | +$0.05 |
| Typical | 400 | 40 | 160 | $0.011 | 48 | 72 | $0.180 | **≈ $0.19** | $0.10 | +$0.09 |
| Heavy | 600 | 60 | 240 | $0.017 | 72 | 108 | $0.270 | **≈ $0.29** | $0.15 | +$0.14 |

Readings:

1. **Marginal AI cost is noise**: the heaviest realistic inbox adds ~$0.29/mo — under 1% of Pro ($39) and invisible next to the ~$1.50 all-in cost of a typical Pro (`business-model.md` §4). Classification is ~6% of the total; OCR dominates, and OCR was going to happen anyway if the user photographed the same invoices. The *incremental* cost of the feature over photo-scanning the same documents is $0.05–0.14/mo, driven by false positives and PDF page counts.
2. **The real cost is fixed, not marginal**: CASA at $540–$1,800/yr = **$45–$150/mo of fixed COGS** — equivalent to the *entire inference bill of 150–500 typical restaurants*. At Pro's ~$25 contribution margin, the assessment is covered by **2–6 Pro subscriptions**. This is why the feature is paid-tier-gated: it is a fixed-cost feature sold as a variable-cost one.
3. Gmail API itself: $0 (comfortably below the 80M units/day billing threshold).

**Recommended business-model adjustments:**

| Decision | Recommendation |
|---|---|
| Which tiers | **Pro and Max** (Free: no — it's a fixed-cost feature and the strongest Pro conversion trigger this product has ever had: "your invoices enter themselves") |
| Tier differentiation | Pro: **1 inbox**, 6-hourly sync · Max: **up to 3 inboxes** (multi-location owners, the segment Max targets) — cheap, honest differentiation |
| Do emailed docs count as scans? | **Yes** — same meter, one scan per document, refund on discard. Rename the user-facing concept from "escaneos" to "documentos" when this ships |
| Quota numbers | **Unchanged** (Pro 500 / Max 1,500): a heavy inbox is 60–72 docs/mo ≈ 14% of Pro's quota even *added to* heavy photo scanning; headroom is ample |
| Gross-margin impact | Pro serving cost rises from ~$1.50 → ~$1.70 typical (~+$0.19); margin on $39 goes from ~96% to ~95.5% — no price action needed. The CASA fixed cost wants ≥ ~6 Pro subs before this feature is margin-neutral; below that it's a deliberate CAC-like investment |
| Free-tier note | The 128:1 free-rider ceiling (`business-model.md` §9) is untouched — free users never reach the funnel |

## Abuse & edge cases

- **Huge mailbox on first sync**: 30-day backfill window (setting, capped at 90) + per-tick message budget + cursor checkpointing. No invocation ever swallows a decade of mail.
- **Shared/accountant inboxes**: high junk mix is survivable (funnel + discard-refund); the wrong-restaurant problem is answered by the one-inbox-one-restaurant invariant and, later, sender-routing rules.
- **Statements, price lists, order confirmations, marketing**: stage-1 prompt rejects them by name (Spanish vocabulary matters: *estado de cuenta*, *tarifa*, *confirmación de pedido*); whatever leaks through hits OCR's `not_a_document` auto-discard.
- **Same invoice emailed and photographed**: `possible_duplicate` warning post-OCR (vendor+date+total match), reviewer decides, discard refunds.
- **HTML-body invoices with no attachment** (some SaaS vendors): out of v1 — verdict `skipped_prefilter` records them, and the counter tells us if it's worth building HTML-to-image rendering later.
- **Multiple attachments per message**: up to 3 candidates, each its own invoice doc (a vendor emailing factura + albarán together yields both, and reconciliation already pairs them).
- **Password-protected/corrupt PDFs**: surfaced as `failed / unreadable` in Triage, no quota charged.
- **Junk-rate telemetry**: `emailIngests` verdicts make per-restaurant precision queryable (ingested vs discarded vs approved). Beta gate: if trailing-30-day discard rate of email-sourced invoices exceeds ~50% for an inbox, raise its classifier threshold and notify — measure before automating more than that.
- **Disconnect/cleanup**: token revoked + deleted, invoices retained, dedup records retained (reconnect-safe), full purge on restaurant deletion.

## Dev & testing

- **Fake provider** (`email/fake.ts`): implements `MailProvider` over fixtures — a deterministic inbox of ~30 messages (real-ish Spanish vendor PDFs rendered from fixtures, marketing mail, a statement, an inline-photo invoice, a protected PDF) so connect → sync → classify → Triage runs fully offline in the emulators. Active whenever there's no Google OAuth client configured — the repo's established no-key-means-mock pattern (`ocr.ts`, `pos/mock.ts`).
- **Classifier offline**: `classify.ts` mocks verdicts deterministically when `llmApiKey()` is absent, exactly like `extractInvoice`.
- **Emulator-only injection route** (seed.ts pattern): push a synthetic `MailMessageMeta` + attachment into the fake inbox so specific scenarios are scriptable in tests without fixture surgery.
- **Unit tests** (`firebase/functions/test/`): dedup idempotency (same message id twice, crashed-tick replay); history-expired fallback to query sync; backfill checkpoint resume; PDF rasterization page count/cap/protected-PDF path; funnel stage-0 gates (size, inline logos, allowlist fast-path); classifier JSON parsing through `parseModelJson`; `consumeScan` ordering + refund-on-discard (incl. period boundary); auto-discard on `not_a_document`; `possible_duplicate` matching tolerance; token encrypt/decrypt round-trip + key rotation (shared with POS helper); OAuth state single-use; disconnect revoke + retention.
- **i18n**: per-feature `email` locale module, `es` authored first, `en` mirrored in the same change (non-negotiable).
- **Live-API testing**: a throwaway Gmail account + the app in Testing publishing status (100 users, 7-day tokens — fine for dev).

## Phased delivery (target: early October 2026)

1. **Phase 0 — compliance runway (week 1, calendar-critical, not code)**: create/configure the OAuth consent screen, brand verification, privacy-policy updates (email data handling + retention), book TAC Security for CASA, submit restricted-scope verification. *Everything else happens while this clock runs.* Decision checkpoint at week 6: if verification looks like it lands after October, ship the forwarding fallback as the launch transport (its webhook feeds the same funnel).
2. **Phase 1 — foundation (weeks 1–3)**: vocab (`invoiceSourceSchema`, `integrations` perm area — coordinate with POS work so it's added once), `email/` skeleton (types, gmail adapter, fake), OAuth connect/callback/disconnect with state docs + token encryption (shared crypto helper), connection/integration docs, Settings UI (connect → granted state with account email, last sync, monthly count → disconnect), i18n module.
3. **Phase 2 — sync + funnel (weeks 3–6)**: scheduled function, history/query sync + cursors, chunked backfill, `emailIngests` dedup, stage-0 gates, stage-1 classifier through `llm.ts`, PDF rasterization (pin down `pdfjs-dist` + `@napi-rs/canvas` in a spike *first* — it's the one novel runtime risk), fixture inbox end-to-end offline.
4. **Phase 3 — pipeline handoff (weeks 6–8)**: multi-page invoice creation (integrate with the concurrent `imagePaths` work — joint review required), `consumeScan` ordering, refund-on-discard, auto-discard on `not_a_document`, `possible_duplicate`, Triage source badge + provenance display, `paused_quota` + notification mails.
5. **Phase 4 — hardening + beta (weeks 8–9)**: reauth/revocation flows, 429 backoff, junk-rate telemetry counters, `llm_usage` label review, beta on ≤100 test users (weekly re-consent caveat documented in-app) or on the forwarding transport if verification is still pending.
6. **Later**: sender → location routing rules (multi-location, multi-inbox), `users.watch` + Pub/Sub push for near-real-time ingestion (needs 7-day watch renewal — the `pos.md` "webhooks fast path" analog), HTML-body invoice rendering, Outlook/IMAP adapters behind the same `MailProvider` interface, per-inbox classifier threshold auto-tuning.

## Gap → resolution map

| Gap (from design review) | Resolution |
|---|---|
| Restricted scope / CASA cost & timeline | Verification submitted week 1; TAC Security budgeted $540–$1,800/yr; forwarding fallback specified as schedule insurance |
| Testing-mode 7-day refresh tokens break daily sync | Beta accepts weekly re-consent or ships on forwarding transport; production waits for verification |
| `gmail.metadata` as cheaper scope | Rejected: no attachment access, and it's restricted anyway — no CASA savings |
| Token storage | Firestore + AES-256-GCM envelope encryption, KEK in Secret Manager, key-version rotation — shared helper with POS |
| Inbox ≠ restaurant | One inbox ↔ one restaurant invariant v1; provenance on the invoice, not "uploaded by"; routing rules deferred |
| Missed/duplicated messages | `emailIngests/{messageId}` created before processing = idempotency gate; RFC-822 Message-ID cross-check; history + query cursors both stored |
| History API expiry | `expired` → query-based fallback (`after:` cursor), then re-anchor historyId |
| First-sync scale | 30-day backfill window, per-tick budget, checkpointed cursor (pos.md backfill pattern) |
| Gmail rate limits | Verified: 6K units/user/min vs ~hundreds used; sequential per-user fetches + backoff |
| PDF → images in Cloud Functions | `pdfjs-dist` + `@napi-rs/canvas` (npm-only, no system deps), 1600px cap = token-cost cap; spike scheduled first in Phase 2 |
| Multi-page invoices | Built *on* the concurrent `imagePaths` work; email worker writes pages then calls the pipeline directly (never the per-file Storage trigger) |
| Junk polluting Triage | Cheap-first funnel; OCR `not_a_document` auto-discards; discard refunds the scan; junk-rate telemetry with a beta threshold |
| Quota fairness | Emailed docs consume scans (1/document), refund on discard, `paused_quota` pauses instead of dropping |
| Duplicate invoice (email + photo) | Post-OCR `possible_duplicate` warning on vendor+date+total match — guides, never blocks |
| Statements/marketing from vendors | Stage-1 prompt with Spanish document-type vocabulary; OCR classify as backstop |
| Vendor mail with several documents | ≤3 attachments → separate invoice docs; factura+albarán pairs feed existing reconciliation |
| No Gmail emulator | Fixture-backed fake provider + emulator-only injection route + no-key mock classifier |
| Revocation / re-consent | `invalid_grant` → `needs_reauth` + banner + owner email (pos.md lifecycle); disconnect revokes + retains data |
| Provider lock-in | `MailProvider` interface; forwarding webhook and future Outlook/IMAP feed the same funnel from stage 1 |
| AI cost blowout | Funnel math: classification ~$0.02/mo, OCR bounded by real invoice count; totals $0.10–0.29/restaurant/mo — noise vs Pro price |

## Verify against live Google docs before Phase 1

(Facts below were web-verified 2026-08-05 but Google moves these; re-check each with the linked source the week Phase 1 starts.)

1. **Restricted-scope list & process** — confirm `gmail.readonly` is still restricted and the current step list / expected review latency: [restricted-scope-verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).
2. **CASA framework state** — the framework is mid-rename (Tier 2/3 → assurance levels AL1/AL2); confirm which level applies to us, TAC Security's current pricing ($540–$1,800 as of verification), and the assessor list: [support.google.com/cloud/answer/13465431](https://support.google.com/cloud/answer/13465431), [switchlabs.dev survey](https://www.switchlabs.dev/post/casa-tier-2-tier-3-security-review-providers-pricing-and-the-cheapest-option).
3. **Unverified-app limits** — exact current caps for Testing status (100 test users? 7-day refresh expiry?) and whether an unverified app can hold restricted scopes in Production at all — this decides the beta transport.
4. **Gmail API quota sheet** — re-read [the quota page](https://developers.google.com/workspace/gmail/api/reference/quota): per-user 6,000 units/min and the 2026-05-01 method costs (`messages.get` 20, `attachments.get` 20, `history.list` 2) plus the 80M units/day billing threshold — it changed once this year already and grandfathering rules differ for existing vs new projects.
5. **`gmail.metadata` restrictions** — confirm it still blocks attachment bodies (kills the cheaper-scope idea) in the [scopes documentation](https://developers.google.com/workspace/gmail/api/auth/scopes).
6. **History API retention window** — the "~one week" expiry is folklore-grade; verify current guidance so the query-fallback trigger is sized right.
7. **Refresh-token semantics** — expiry on 6-month disuse, revocation error shapes (`invalid_grant` variants), and whether `prompt=consent` is still required to re-obtain a refresh token.
8. **LLM prices** — re-check the Gemini table in `llm.md` (3.1 Flash-Lite $0.25/$1.50 held as of 2026-08-05; 2.5 Flash-Lite retires 2026-10-16) before committing the cost model to the pricing page.
9. **`pdfjs-dist` + `@napi-rs/canvas` versions** — confirm current versions run on the deployed Node runtime and measure cold-start weight before making them runtime deps.
10. **Inbound-parse provider** (only if the forwarding fallback activates) — pick SES vs Postmark vs Mailgun on inbound pricing + EU data residency.
