# Bank transaction feeds (Tink + Plaid)

Status: **design record — not yet implemented.** First market: **Spain**. First provider: **Tink**; Plaid is the second adapter, not an alternative architecture. Sequenced **after email ingestion ships (~Oct 2026)** — see Phased delivery.

Purpose (founder framing): **bookkeeping consolidation**. Money leaves the restaurant's bank account; Teremu knows whether a registered invoice or expense explains it. Whatever is unexplained gets flagged — *"gasto sin registrar"* — and the owner resolves it in seconds. This is the inverse of scanning: scanning captures what the vendor handed you; the bank feed catches what nobody handed you (the SaaS charge, the direct-debited utility, the supplier you paid but whose factura never got photographed).

Read this before touching any bank/aggregator code. Companion docs: `pos.md` (this doc deliberately mirrors its provider-abstraction, connection-tenancy, and review-queue patterns), `llm.md` (the matcher's LLM assist goes through `llm.ts` like everything else), `business-model.md` (tier math this doc feeds into), `email-ingestion.md` (parallel design — see the combined COGS note in §AI cost).

## Principles

1. **One adapter boundary, like `llm.ts` and `pos/`.** All aggregator traffic lives in `firebase/functions/src/bank/<provider>.ts` behind a common `BankProvider` interface. The sync engine, matcher, and flag queue never see provider HTTP, field names, or auth.
2. **Read-only, always.** Teremu consumes Account Information Services (AIS) exclusively. **No Payment Initiation (PIS), ever** — Teremu never moves money, and no roadmap item may quietly assume otherwise. This is both a product stance and the compliance perimeter (§Compliance).
3. **Raw transactions are immutable facts; matching state is a rebuildable layer on top.** A bank transaction doc is upserted only by provider identity (pending→posted is a version of the same fact). Match status, flags, and counterparty rules are *derived or human-authored* metadata that never mutate the underlying transaction — so the matcher can re-run forever without corrupting anything, the same commitment `pos.md` makes for orders.
4. **Money is integer minor units (cents) + currency code inside the bank layer**, converted to float euros only where a value crosses into existing app shapes (an expense created from a flagged transaction). Amounts are **signed**: negative = outflow. v1 consumes **outflows only**; inflows are stored but not processed (§Spain money notes).
5. **Deterministic first, AI last.** Exact amount+date+counterparty logic resolves the bulk; the learned counterparty table resolves the recurring; only the residue goes to one batched LLM call, and the LLM only ever *suggests* — it cannot auto-link (same rule as the POS matcher).
6. **Everything works offline.** No connection → deterministic mock provider (same pattern as OCR without an LLM key). Webhooks get an emulator-only injection route.

## Provider abstraction

`firebase/functions/src/bank/` — `types.ts` (interface + normalized types), `tink.ts`, `plaid.ts`, `mock.ts`, `sync.ts` (engine), `matching.ts` (pure), `webhook.ts`.

```ts
interface BankProvider {
  createLinkSession(opts: { state, redirectUri, locale, market }): { url: string }
  exchangeLinkResult(params): BankConnection        // provider connection id + tokens + consent expiry
  listAccounts(conn): BankAccount[]                 // externalId, iban(masked), name, type, currency
  fetchTransactions(conn, accountExternalId, cursorOrWindow): { txs: BankTx[]; cursor: string | null }
  renewConsentUrl(conn, state): string              // re-SCA when the 180-day consent lapses
  refresh(conn): BankTokens                         // provider token refresh (distinct from consent renewal)
  revoke(conn): void
  verifyWebhook(headers, rawBody): BankEvent | null
}
```

Normalized types (money in signed minor units):

- `BankAccount` — `{ externalId, displayName, ibanMasked, type: 'checking' | 'card' | 'other', currency }`
- `BankTx` — `{ externalId, accountExternalId, status: 'pending' | 'booked', bookedAt (YYYY-MM-DD), valueDate?, amountMinor (signed), currency, counterpartyName?, rawDescriptor, scheme?: 'sepa_dd' | 'sepa_ct' | 'card' | 'bizum' | 'cash' | 'fee' | 'other', creditorId?, remittanceInfo?, pendingReplacesExternalId? }`
- `BankEvent` — `{ kind: 'tx_updates' | 'consent_expiring' | 'connection_revoked' | 'error', connectionExternalId }`

`scheme`/`creditorId`/`remittanceInfo` are best-effort adapter extractions (SEPA fields are gold for matching — §Matching); the engine treats them as optional hints, never requirements, so a provider that omits them still works.

Vocabulary (in `shared/src/vocab.ts`, per the schemas rule): `bankProviderSchema = z.enum(["tink", "plaid"])`; `bankTxResolutionSchema = z.enum(["unmatched", "matched", "flagged", "dismissed", "auto_rule"])`. Permission-wise this reuses the **`integrations` perm area planned in `pos.md`** (`none | read | edit`) — one area for all external connections, not one per kind; finance `read` is additionally required to *see* bank amounts (a scan-only runner must not see the bank account through the flag queue).

### Tink vs Plaid for Spain — and which ships first

| | **Tink** | **Plaid** |
|---|---|---|
| Spanish coverage | Native strength: acquired Madrid-based Eurobits, the aggregation layer that historically powered BBVA/Santander/Sabadell integrations; CaixaBank, Santander, BBVA, Sabadell + long tail covered; even runs a public Spain provider status page ([tink.com/tink-expansion-spain-portugal-italy](https://tink.com/tink-expansion-spain-portugal-italy/), [tinkspain.statuspage.io](https://tinkspain.statuspage.io/)) | Spain supported since 2019 (beta) with app-to-app redirect auth; ~2,000 EU institutions, "95% coverage" across 20 countries ([plaid.com/blog/plaid-in-france-spain-and-ireland](https://plaid.com/blog/plaid-in-france-spain-and-ireland/), [plaid.com/en-gb/global](https://plaid.com/en-gb/global/)) — but ES long-tail depth (rural cajas, Cajamar-tier co-ops restaurant owners actually use) must be verified per institution |
| Link flow | Hosted "Tink Link" web flow, redirect-based — fits our Capacitor in-app-browser + app-scheme pattern from `pos.md` OAuth | Plaid Link SDK (web + native), polished; also redirect-capable |
| Consent renewal | PSD2-native: surfaces consent lifetime, renewal = re-run Link session on same connection | EU consent expiry surfaced via item webhooks; same re-link pattern |
| History at first connect | Bank-dependent (PSD2): 90 days guaranteed under the SCA exemption; several ES banks return 12–24 months during the initial SCA session ([developer.kontomatik.com — the "more than 90 days" mechanics generalize](https://developer.kontomatik.com/user-guides/getting-more-then-90-days-of-data)) | Same PSD2 constraint in EU (Plaid's 24-month US history does not carry over) |
| Webhooks | Yes (transaction/refresh + consent events) | Yes; `/transactions/sync` cursor model is best-in-class |
| Sandbox | Demo bank in console; ES status page implies mature ES ops | Excellent: deterministic test users, sandbox-fired webhooks |
| Pricing | Standard tier reported at **~€0.50/connected user/month** for transactions; enterprise = custom ([merchantmachine.co.uk](https://merchantmachine.co.uk/open-banking-payments/tink/), [blog.finexer.com/tink-pricing](https://blog.finexer.com/tink-pricing/)) | Unpublished; per-Item monthly subscription for Transactions, reported **~$0.30–0.60/Item/month** range, pay-as-you-go has no minimum ([plaid.com/docs/account/billing](https://plaid.com/docs/account/billing/), [vendr.com/marketplace/plaid](https://www.vendr.com/marketplace/plaid), [blog.finexer.com/plaid-pricing](https://blog.finexer.com/plaid-pricing/)) |
| License | Tink AB, licensed AISP (Swedish Finansinspektionen), passported EU-wide — verify ES passport in checklist | Registered AISP (FCA ref 804718; EU via Plaid B.V., Netherlands) — verify ES passport in checklist ([plaid.com/blog/aisp](https://plaid.com/blog/aisp/)) |

**Recommendation: Tink ships first.** The honest version: Plaid has the better developer experience and the better sandbox, and if Teremu's first market were the US it would win outright. But the product is Spain-first, and the thing that kills bank-feed features is coverage gaps at exactly the banks your users hold — Tink's Eurobits lineage makes it the incumbent aggregator *inside* Spanish banking, its Spain coverage is a first-class product with its own status page, and its EUR per-user pricing is legible for our unit economics today. Plaid is the second adapter and earns its keep the day Teremu sells outside Iberia (or if Tink's enterprise contract terms turn hostile — a two-adapter interface is also negotiating leverage). Building the interface against two known providers from day one (even though only `tink.ts` ships in Phase 1) is what keeps Tink-isms out of the core, exactly as `pos.md` keeps Square-isms out.

## Identity & connections (bank account ≠ restaurant, again)

Same tenancy shape as `posConnections`: the aggregator connection is per **bank login**, and one owner's bank login may hold several accounts funding several locations. So:

- `bankConnections/{provider}_{connectionId}` (top level): encrypted tokens, provider connection/item id, status (`active | consent_expiring | needs_reauth | revoked`), `consentExpiresAt`, institution id/name, the owning `uid`. One doc per bank login regardless of how many restaurants draw from it.
- `restaurants/{rid}/integrations/bank_{provider}` (one doc): pointer to the connection, the **assigned account externalIds** (subset of the connection's accounts), sync cursors per account, backfill checkpoints, settings (`flagThresholdMinor`, default 2000 = €20; `flagSettleDays`, default 5), status, `lastSyncAt`.
- **Each bank account feeds exactly one rid** (chosen at link time; default = the rid that initiated the link). A multi-location owner with one account funding three locations picks which location owns the feed; the flag queue lives there. v1 does **not** split one account's transactions across rids — that requires allocation rules with no data to drive them. Documented limitation; the later fix ("split rules" or per-location virtual assignment) is metadata-only because raw transactions are immutable (Principle 3).
- **Link flow**: single-use `bankLinkStates/{nonce}` doc binding `{ rid, uid }` (CSRF), server-side exchange in the callback function, deep-link back into the app — verbatim the `pos.md` OAuth pattern.
- **Token encryption**: AES-256-GCM with a Secret Manager key (`BANK_TOKEN_ENC_KEY`, `defineSecret` like Stripe's), ciphertext prefixed with key version for rotation. Tokens live encrypted **in Firestore**, not as individual Secret Manager secrets — per-connection secrets don't scale (secret-count limits, no dynamic binding in v2 functions) and the envelope-encryption pattern is already established by `pos.md`. A daily job refreshes provider tokens nearing expiry.
- **Consent expiry UX (the 180-day drumbeat).** PSD2's amended RTS (Delegated Regulation (EU) 2022/2360, in force at banks since **25 July 2023**) made the AISP-access SCA exemption mandatory and stretched renewal from 90 to **180 days** ([eba.europa.eu](https://www.eba.europa.eu/eba-consults-amendment-its-technical-standards-strong-customer-authentication-and-secure), [vixio.com](https://www.vixio.com/insights/pc-90-becomes-180-eba-makes-key-sca-change), [projectivegroup.com](https://www.projectivegroup.com/psd2-alert-authentication-period-for-account-information-services-extended-to-180-days/)). So *every* connection dies twice a year by regulation, and the renewal requires the user to SCA at their bank — this is a **product surface, not an error path**: `consentExpiresAt` on the connection, in-app banner + `sendMail()` nudge at T−14 and T−3 days, one-tap re-link that reuses the same connection doc (history, cursors, and counterparty rules all survive renewal). A lapsed consent flips status to `needs_reauth`, pauses sync quietly, and the flag queue shows a "feed pausado" ribbon instead of silently going stale. Note for the checklist: PSD3/FIDA drafts revisit this cadence again — treat 180 as config, not constant.
- **Disconnect**: per restaurant — clear the integration doc, pause sync; revoke the aggregator connection when the last rid referencing it disconnects. Retention on disconnect differs from POS (see §Compliance — bank data gets deleted, not retained).

## Ingestion

- **Daily scheduled pull** (`onSchedule` v2, **us-east1** like every function, ~06:00 Europe/Madrid so overnight postings are in): iterate active integrations, `fetchTransactions` per assigned account with the stored cursor, normalize, upsert. Budget: even 1,000 connected restaurants × 1 provider call each is a trivially chunked loop; checkpoint the cursor per account after each page so a timeout resumes, never restarts.
- **Webhooks are the freshness path** where offered (Plaid `SYNC_UPDATES_AVAILABLE`, Tink refresh/consent events): verify signature, then **pull via the API rather than trusting payload contents** (thin-webhook rule from `pos.md`), which makes duplicates and reordering harmless. The daily job remains the correctness backstop — the system must be *complete* on schedule alone, merely *fresher* with webhooks.
- **Storage**: `restaurants/{rid}/bankTransactions/{provider}_{externalId}` — the provider tx id in the doc id **is** the dedup mechanism (idempotent upsert, same as `posOrders`). Doc: normalized `BankTx` fields + `resolution: { status, matchedTo?: { kind: 'invoice' | 'expense', id }, matchedBy?: 'exact' | 'combo' | 'counterparty' | 'llm_confirmed' | 'manual', confidence?, resolvedAt?, resolvedBy? }`.
- **Pending → posted**: a posted tx carrying `pendingReplacesExternalId` upserts the posted doc and tombstones the pending one, carrying any resolution forward when amounts agree (else back to `unmatched`). The matcher only ever *auto*-matches `booked` transactions; pending ones are visible but grey.
- **Backfill on first connect**: request the maximum the bank grants during the initial SCA session (this is the one moment deep history is cheaply available — see the coverage table), **process the most recent 90 days** through matching by default (setting-controlled, mirroring the POS 90-day backfill), store the rest untouched. Chunked and checkpoint-resumed like the POS backfill; no single invocation swallows two years of statements.
- Growth bound: ~200–400 docs/restaurant/month is modest, but apply the repo's standing stance — time-windowed reads everywhere, and a Firestore TTL (~24 months) on `bankTransactions` once the later invoice-reconciliation phase settles what history it needs.

## The matching engine ("the flag")

A pure, idempotent function (hermetically testable) over `(unresolved booked outflows × open candidates)`, where candidates are: `expenses` docs (amount, date, tagKey, vendorName) and **approved food invoices** (printed `total`, `invoiceDate`, `vendorName`) not already claimed by another transaction. It fills `unmatched → matched/flagged` and **never touches `manual`, `dismissed`, or rule-made resolutions** — the same never-overwrite-humans invariant as the POS matcher. It runs daily after ingestion, on invoice approval / expense creation (new candidates may claim waiting flags), and on demand from the queue.

Tiers, cheapest first:

1. **Exact single-candidate**: |amount| equals candidate total (±1 cent) AND date within window (invoice date −2…+30 days for invoices — restaurants pay on delivery or on terms; expense date ±3 days) AND, when both sides have names, normalized counterparty ≈ vendorName (the `normalizeName` folding from `reconcileDeliveryNotes` — lowercase, strip diacritics, drop stopwords). Exactly one candidate → auto-match (`exact`). Two candidates at the same amount **never auto-match** — flagged with both listed (ambiguity refusal, verbatim from `pos.md`).
2. **Counterparty rules** (the learned table): `restaurants/{rid}/bankCounterparties/{key}` keyed by normalized descriptor stem (SEPA `creditorId` when present — it is stable where display strings drift), fields: `descriptorStem, creditorId?, vendorKey | null, action: 'match_vendor' | 'auto_expense' | 'dismiss', expenseTag?, learnedFrom: 'resolution' | 'manual', updatedAt`. Every manual resolution *teaches* this table (link to vendor X twice → offer the rule; "es el alquiler, siempre" → `auto_expense` with tag `alquiler`). Recurring rent/payroll/tax direct debits die here permanently, which is what keeps the flag queue quiet enough to respect.
3. **Batched vendor payments (combo)**: one outflow equals the sum of 2–4 open invoices from the *same vendor* within the window — bounded subset-sum over per-vendor candidate sets (cap: 12 open invoices per vendor per window, else skip to flag). Unique combination → match all legs (`combo`); multiple valid combinations → flag with candidates.
4. **LLM assist (residue only)**: everything still unresolved goes to **one batched call through `llm.ts`** — cheap model, structured output (`json_schema` like every extraction call): for each `{descriptor, amount, date}` plus the candidate shortlist, return `{txId, candidateId | null, confidence, reason}`. The LLM handles what determinism can't: descriptor gibberish ("ADEUDO SEPA MAKRO AUTOSERV MAYORIS 0234"→ Makro), abbreviation soup, fee-adjusted near-misses. Its output is **suggestion only** — rendered as a pre-selected candidate in the queue, one tap to confirm (`llm_confirmed`), never auto-linked.

**Flagging**: an unresolved booked outflow older than `flagSettleDays` (default 5 — let invoices get scanned and matching settle) with |amount| ≥ `flagThresholdMinor` (default €20) becomes `flagged` → the **"gastos sin registrar"** queue, surfaced as a Pulse card ("3 cargos sin registrar — 412 €") linking into a Triage-pattern list. Resolutions per row: **link** to an existing invoice/expense (candidate list pre-ranked, LLM suggestion on top), **quick-create expense** (form pre-filled: date, amount, counterparty as vendorName, suggested tag — lands in the existing `expenses` collection via the existing `POST /expenses` path, so `spendByTag`, Pulse charts, and vendor derivation all just work with zero new read paths), **dismiss** (personal charge, transfer between own accounts), or **create rule** (tier-2 teach). Sub-threshold and inflow transactions are visible in an "everything" view but never nag.

## Spain money & scheme notes

- **IVA**: bank amounts are what actually left the account — **IVA-inclusive** — and invoice `total` is the printed (inclusive) total, so bank↔invoice matching compares inclusive-to-inclusive and needs no tax math. The IVA-exclusive consistency question flagged in `pos.md` (margin costs as base imponible) is orthogonal: it changes analytics, not matching, because matching always uses printed totals.
- **SEPA direct debits (adeudos)** are how Spanish utilities, rent, insurance, and many food vendors collect. They carry `creditorId` + remittance info — the single best matching signal we get; adapters must surface them whenever the provider does. Recurring adeudos are exactly what tier-2 rules exist for.
- **Card settlements / POS payouts are inflows and out of scope for v1.** A restaurant's acquirer deposits aggregated, fee-netted batches — reconciling those against revenue is a real feature that belongs to the POS integration's world (`pos.md` owns daily net revenue), not to expense flagging. Storing inflows untouched keeps that door open.
- **Bizum**: descriptor-recognizable (`BIZUM ...`); usually small, often personal or informal supplier payments (the fish guy at the market). Default handling: below threshold → ignore; above → flag with **quick-create expense** as the expected resolution, since a Bizum payment almost never has a factura to link.
- **Cash withdrawals** (`cajero`, ATM): unmatched by definition. Flag once above threshold with dismiss/auto-rule as the expected outcome; never LLM-escalate them (waste).
- **Bank fees** (`comisión`): tier-2 auto-expense rule candidates out of the box — ship a small seed set of universal Spanish descriptor rules (comisión, cuota, ATM) so day-one queues aren't full of noise.

## AI cost & business-model impact (explicitly requested)

Two cost lines, and they are **not the same order of magnitude — the aggregator fee dominates, not the AI.**

**AI cost per restaurant/month.** Model: a typical connected restaurant books 100–400 bank transactions/month; ~60% are outflows; tiers 1–3 (exact, rules, combo) should resolve 80–90% of outflows once the rule table warms up (week one is worse; rules converge fast because restaurant payees are extremely repetitive). Residue to the LLM: ~10–20% of outflows, batched 20 per call. Per batch at Gemini 3.1 Flash-Lite prices ($0.25/M input, $1.50/M output — re-verified Aug 2026, matching `llm.md`'s 2026-07-24 snapshot; 2.5 Flash-Lite retires 2026-10-16 so don't anchor on it; [ai.google.dev/gemini-api/docs/pricing](https://ai.google.dev/gemini-api/docs/pricing), [cloudzero.com/blog/gemini-pricing](https://www.cloudzero.com/blog/gemini-pricing/)): ~3K input + ~800 output ≈ **$0.002/batch**.

| Scenario (monthly) | Bank txs | Outflows | LLM residue | Batches | AI cost |
|---|---|---|---|---|---|
| Light | 100 | 60 | ~6 | 1 | ~$0.002 |
| Typical | 250 | 150 | ~20 | 1–2 | ~$0.004 |
| Heavy | 400 | 240 | ~45 | 3 | ~$0.006 |
| Pathological (cold rules, 50% residue, retry on every call) | 400 | 240 | 120 | 6 | **~$0.03** |

Add GCP overhead (≤400 writes, daily job reads, queue reads): ~$0.10–0.30/month. **AI is noise here — under a cent typical, three cents pathological.** The founder's instinct that "AI will raise costs" is right for email ingestion (per-document extraction, scan-like ~$0.003/doc — see `email-ingestion.md`) but for bank feeds the model only ever sees short text descriptors in batches; there is no vision, no long context.

**Aggregator fee per restaurant/month — the real COGS line.**

| Provider | Published/reported price | Planning number |
|---|---|---|
| Tink (standard tier) | ~€0.50/connected user/month for transactions ([merchantmachine.co.uk](https://merchantmachine.co.uk/open-banking-payments/tink/)); enterprise custom with likely minimum commitment | **€0.50–1.50** |
| Plaid | Per-Item monthly subscription, unpublished; reported $0.30–0.60 range, pay-as-you-go without minimums ([plaid.com/docs/account/billing](https://plaid.com/docs/account/billing/), [vendr.com](https://www.vendr.com/marketplace/plaid)) | **$0.30–1.50** |

Both are directional — neither publishes EU list prices, and enterprise contracts carry platform minimums (commonly hundreds of €/month) that would be a **fixed cost until ~50–200 connected restaurants absorb it**. Getting real quotes is a Phase-0 action item (checklist), and the minimum-commit question is precisely why gating the feature to a paid tier matters: it keeps early connected volume aligned with revenue.

**Combined per-connected-restaurant marginal cost: ~€1–2/month planning, €3 conservative** (aggregator €0.50–1.50 + AI ~$0.01 + GCP ~$0.20 + a consent-renewal SMS-free email or two).

**Tier impact** (prices from `business-model.md`; "current worst-case COGS" = its Gemini-era all-in figures):

| Tier | Price | Current worst-case COGS | + bank feed (€3 cons.) | New COGS | Gross margin |
|---|---|---|---|---|---|
| Free | $0 | ~$0.20 | not offered | — | — |
| Pro $39 | $39 | ~$3 | not included in v1 | ~$3 | ~92% |
| Max $59 | $59 | ~$4.50 | included, 1 connection | ~$7.75 | **~87%** |

**Recommendation.** Bank feeds are a **Max-and-up feature, included, one bank connection per location** (additional connections +€5/month each, priced above cost to keep multi-bank setups honest). Rationale: (a) the persona who reconciles bank statements is the bookkeeping-mature restaurant Max was built to harvest from under Haddock's umbrella — this is a *reason to upgrade*, and Max needs exactly those; (b) at ~€3 conservative marginal cost, Max's margin only drops ~2 points; (c) gating keeps early connected volume small while aggregator minimums are being negotiated. Revisit a **Pro add-on at +€9–10/month** once demand is proven — at that price the add-on itself carries ~70% margin. Never free tier: a per-connection recurring hard-currency fee is structurally different from inference (it doesn't fall with model prices and can't be capped by `max_tokens`).

**Combined modeling note (do not skip):** email ingestion (`email-ingestion.md`, in parallel) adds *per-document inference* COGS; bank feeds add *per-connection fixed* COGS. They stack on the same Max restaurants. Once both designs have real quotes/telemetry, `business-model.md` §4 must gain a "connected restaurant" archetype whose all-in cost carries both lines — the current archetype table knows only scans and assistant questions.

## Compliance & risk

- **Teremu is NOT a licensed AISP and must never handle bank credentials.** Both providers act as the licensed AISP and own the consent + SCA relationship: Tink AB under the Swedish Finansinspektionen, passported across the EU; Plaid via its FCA registration (ref 804718) and Plaid B.V. (Netherlands) for the EU ([plaid.com/blog/aisp](https://plaid.com/blog/aisp/)). Teremu rides on their license as their client — **verify per provider, for Spain specifically**, that the end-user-consent model requires no Teremu registration as agent with Banco de España, and get that in writing in the contract (checklist item; a wrong answer here changes timelines, not architecture).
- **Read-only AIS, no PIS — stated in product, contract, and scopes.** Request the minimum scopes (accounts + transactions), never payment initiation, never identity beyond the account holder name the transaction feed itself carries.
- **GDPR**: bank transaction data is not special-category under Art. 9, but it is high-sensitivity financial data — do a DPIA before launch; both providers sign DPAs as processors-of-their-own-service / independent controllers (verify which role each claims — it affects the privacy policy wording). Data minimization: only assigned accounts are pulled; unassigned accounts in a connection are never fetched.
- **Retention & deletion**: **on disconnect, raw `bankTransactions` are deleted** (after a 30-day grace banner), unlike POS sales which are retained — POS orders are the restaurant's own sales history; a bank statement is the bank's record and re-obtainable, and holding unnecessary financial data is pure liability. What survives disconnect: expenses *created from* flags (they're the user's bookkeeping, in the `expenses` collection) and counterparty rules (they're authored knowledge). Full purge rides `DELETE /restaurants/:rid` recursive delete; that handler must also revoke the aggregator connection when this rid was its last reference.
- **Threat model notes**: tokens are AES-256-GCM enveloped (§Identity), webhook endpoints verify signatures and fetch-don't-trust, the flag queue enforces `integrations` + `finance` perms server-side on every route, and bank data never enters the assistant's context snapshot in v1 (adding it later is a deliberate decision with its own permission gate, not a default).

## Dev & testing

- **Mock provider** (`bank/mock.ts`): deterministic accounts + transaction stream (including a pending→posted pair, a SEPA DD with creditorId, a Bizum, an ATM withdrawal, and one batched-payment combo) so connect → sync → match → flag → resolve works fully offline in the emulators with no API keys, per repo rule.
- **Sandboxes**: Plaid's is excellent (deterministic test credentials, sandbox-fired webhooks); Tink offers a demo bank via its console. Base URLs are env config, never hardcoded in callers (`llm.ts` rule).
- **Webhook injection**: emulator-only route accepting a normalized `BankEvent` (seed.ts pattern) because real webhooks can't reach the emulator.
- **Hermetic matcher tests** (`firebase/functions/test/`): `matching.ts` is a pure function — tests cover exact-match window edges, two-candidates ambiguity refusal, cent-rounding tolerance, combo subset-sum uniqueness and its 12-invoice cap, rule precedence over exact, pending→posted resolution carry-forward, never-touch-manual invariant, threshold/settle-day flag gating, descriptor normalization (diacritics, SEPA prefixes). Plus: token encrypt/decrypt round-trip with key rotation, upsert idempotency (webhook + daily job delivering the same tx), link-state single-use.
- **i18n**: all strings in a per-feature `bank` locale module, `es` authored first, `en` mirrored same change (the queue copy is user-facing money language — write the Spanish first for real).
- **Seed data**: extend `seed.ts` with a connected mock bank so the demo dataset shows a realistic flag queue.

## Phased delivery

Sequenced **after email ingestion ships (~Oct 2026)** — same team, and email ingestion's learnings (sender→vendor mapping is a cousin of counterparty→vendor) feed this design. Target Phase 1 start ~Nov 2026.

0. **Phase 0 (can run during email-ingestion work)**: commercial + compliance groundwork — pricing quotes from Tink (and Plaid for comparison), minimum-commit terms, ES agent-registration question in writing, DPIA draft. No code.
1. **Foundation** — vocab (`bankProviderSchema`, resolution enum), `bank/` skeleton (types + mock + Tink Link flow, link-state docs, token encryption, connections model, account→rid assignment), Settings connect/disconnect UI, consent-expiry banner plumbing.
2. **Ingestion** — daily `onSchedule` sync with cursors, webhook endpoint + emulator injection, pending→posted handling, chunked backfill, `bankTransactions` store.
3. **Matching + the flag** — `matching.ts` tiers 1–3, counterparty rule table + teaching flow, flag queue UI (link / quick-expense / dismiss / rule), Pulse card, seed descriptor rules for universal Spanish bank noise.
4. **LLM assist + hardening** — tier 4 batched suggestions via `llm.ts` (with `llm_usage` labels for cost telemetry from day one), consent-renewal emails, plan gating (Max), revocation flows, TTL policy.
5. **Later** — Plaid adapter (second market or negotiating leverage); **invoice ↔ transaction reconciliation** as a first-class ledger view (partial payments, one-invoice-many-payments, remesa batches beyond 4 legs); inflow/settlement reconciliation joint with the POS integration; split rules for shared accounts across locations; bank data in the assistant snapshot (permission-gated).

## Gap → resolution map

| Gap (from design review) | Resolution |
|---|---|
| Which provider first | Tink (Eurobits-rooted ES coverage, EUR pricing); Plaid as second adapter — interface built for two from day one |
| Teremu not an AISP | Providers hold the license; read-only AIS only; no PIS ever; ES agent-registration question is a Phase-0 written-answer item |
| 180-day consent death | Regulation, not error: `consentExpiresAt`, T−14/T−3 banner+email, one-tap re-link preserving connection doc; treat 180 as config (PSD3/FIDA may move it) |
| Connection ≠ restaurant | Top-level `bankConnections` + per-rid integration doc; each account assigned to exactly one rid |
| Shared account, multiple locations | v1: owner picks the owning rid; splitting is a later metadata-only feature (raw txs immutable) |
| Credential storage | AES-256-GCM tokens in Firestore, key in Secret Manager, versioned rotation — `pos.md` pattern, not per-connection secrets |
| Duplicate transactions | Provider tx id as doc id → idempotent upsert; webhook + daily job collisions harmless |
| Pending vs posted | Posted tombstones its pending twin; auto-match only on booked |
| Backfill depth | 90 days matched by default; deeper history stored opportunistically at first SCA (bank-dependent under PSD2) |
| False-positive matches | Ambiguity never auto-matches; ±1 cent + date window + name agreement; combos require unique solution; LLM is suggestion-only |
| Queue fatigue | Threshold (€20) + settle delay (5 days) + learned auto-rules + seeded rules for universal bank noise; sub-threshold visible but silent |
| Recurring rent/payroll | Tier-2 counterparty rules (`auto_expense` / `dismiss`), taught by resolutions |
| Batched vendor payments | Bounded subset-sum (≤4 legs, ≤12 candidates) in v1; remesas beyond that are the Later reconciliation phase |
| IVA mismatch fears | None for matching: bank amount and printed invoice total are both IVA-inclusive |
| Card settlements / inflows | Stored, not processed; belongs to POS-side revenue reconciliation later |
| AI cost blowup | Structural non-issue: ≤$0.03/restaurant/month pathological; real COGS is the aggregator fee (~€0.50–1.50) — modeled in §AI cost |
| Business-model fit | Max-included (1 connection), ~2-point margin cost; Pro add-on later; never free; combined connected-restaurant archetype owed to business-model.md |
| GDPR / retention | DPIA pre-launch; delete raw txs on disconnect (30-day grace); created expenses + rules survive; purge rides restaurant deletion |
| Offline dev | Mock provider + emulator webhook injection; no keys needed |
| Matcher correctness | Pure function, hermetic tests incl. never-touch-manual invariant |

## Verify against live Tink/Plaid docs before Phase 1

(Blocked in the design session — pricing and ES specifics below are from secondary sources and must be confirmed primary.)

1. **Tink commercial**: actual EUR price per connected user/month at our volumes, minimum monthly commitment, contract term; whether "user" = connection or = end-user across connections.
2. **Plaid commercial** (for comparison/leverage): EU per-Item Transactions subscription price, pay-as-you-go availability in EU, minimums.
3. **Tink ES coverage list** against a real target-customer bank sample (CaixaBank, Santander, BBVA, Sabadell, Bankinter, Unicaja, Abanca, Cajamar, ING ES, plus rural cajas) — and whether **business accounts** (not just consumer) are supported per bank, since restaurants bank on business accounts; same check for Plaid ES.
4. **Consent mechanics per provider**: exact consent lifetime surfaced via API, renewal flow (same connection id?), expiry webhooks; whether any major ES bank still deviates from the 180-day RTS.
5. **Transaction field fidelity**: does each provider surface SEPA `creditorId` / remittance info / scheme for ES banks; pending→posted linkage id; history depth actually returned per major ES bank at first SCA.
6. **Webhook**: event names, signature scheme, retry policy; sandbox webhook support (Plaid yes — confirm Tink).
7. **AISP/agency**: written confirmation that Teremu, as a client of the provider, needs no Banco de España registration for AIS consumption in Spain; each provider's GDPR role (processor vs independent controller) for the DPA and privacy policy.
8. **PSD3/FIDA status**: whether the re-consent cadence or AIS access rules are changing on a timeline that overlaps our phases.
9. **SDK vs plain fetch**: whether either provider's Node SDK earns its bundle weight given the esbuild external-deps setup (`pos.md` asks the same of Square).
10. **LLM prices**: re-check the Gemini table in `llm.md` at implementation time (Google retires tiers aggressively; 2.5 Flash-Lite dies 2026-10-16).
