# Teremu — Business Model

**Model:** Freemium subscription (SaaS), priced per restaurant location.
**Customer:** Independent restaurant owner-operators and executive chefs — people who feel every point of food cost personally but have no back office.
**Status:** Draft for discussion. Prices are placeholders calibrated for a LATAM/Spain launch; validate against 15–20 customer conversations before committing.

---

## 1. The economic argument

Teremu is not sold as software; it is sold as recovered margin. A restaurant running $20,000/month in food purchases that catches vendor price creep and fixes two underpriced dishes recovers 1–2 points of food cost — $200–$400 every month. The Pro subscription should cost roughly a tenth of that, so the pitch is arithmetic, not persuasion: *"Teremu cuesta menos que medio cubierto al mes y te avisa cuando el salmón sube 8%."*

The freemium structure exists because the product's "aha" moment — scan a crumpled invoice, watch it become line items, see a dish's real margin — takes under five minutes and requires no sales touch. Free captures that moment; the paid tier captures the restaurant that starts running on it.

## 2. The value metric

The free/paid boundary follows the two dimensions that track both customer value and our marginal cost:

1. **Invoices scanned per month.** Each scan is a real inference cost to us (vision model call) and a direct proxy for how operationally embedded the product is. A restaurant scanning 60+ invoices a month is running its purchasing through Teremu.
2. **Team members.** The moment an owner invites the chef or a runner (granular permissions are already built), Teremu has become the restaurant's shared operating layer — the strongest retention signal we have, and a natural upgrade gate.

History depth and proactive intelligence (alerts, digests) reinforce the boundary without blocking the core loop.

## 3. Tiers

| | **Gratis** | **Pro** — *el plan del chef* | **Grupo** |
|---|---|---|---|
| Price (placeholder) | $0 | **$29/mo** or $290/yr (2 months free) | Same as Pro, billed per location |
| Invoice scans (OCR) | 25 / month | 500 / month fair use | 500 / month, per location |
| Team members | Owner only | Up to 5, granular permissions | Up to 5, granular permissions — per location |
| History window | 90 days | Full history | Full history, per location |
| Menu items (dishes + drinks) | **Unlimited** | Unlimited | Unlimited |
| Dish margins & menu engineering matrix | ✓ | ✓ | ✓, per location |
| Theoretical pantry + true-up | ✓ | ✓ | ✓ |
| Grocery list generator | ✓ | ✓ | ✓ |
| Price-hike & margin alerts (in-app) | ✓ | ✓ | ✓ |
| Email alerts & weekly digest | — | ✓ | ✓ |
| Vendor directory & spend analytics | Basic (top 3 vendors) | Full | Full, per location |
| Expense tags (non-food) | 3 tags | Unlimited | Unlimited |
| Data export (CSV) | — | ✓ | ✓ |
| POS integration *(roadmap)* | — | ✓ | ✓ |
| Support | Community | Priority (48 h) | Dedicated |

**Grupo is not a distinct SKU** — it's the multi-location switcher (built — see `docs/multi-location-plan.md`) plus N independent Pro subscriptions, one per restaurant, each on its own monthly/yearly cadence. A person can own or work at several locations with a different role and permissions at each; every limit above (scans, seats, history) applies per location, because each location's Stripe subscription, plan, and usage are tracked independently on its own `restaurants/{rid}` doc. What Grupo does *not* yet include is consolidated cross-location reporting (one dashboard summing all locations) — that's real engineering, deliberately out of scope for now (see "Out of scope" in the multi-location plan), and the natural next step once it's worth building.

Design intents behind the numbers: 25 scans ≈ one delivery-heavy week — enough to prove value, not enough to run a month on. The team gate converts precisely at the moment of habit formation. The 90-day window keeps the dashboard alive for free users while making the year-over-year story (and tax season) a Pro feature.

**Why menu size is deliberately *not* a gate.** Capping menu items was considered and rejected. A dish doc costs us effectively nothing (inference, not storage, is COGS — see §4), so a cap would be pure price discrimination on the one thing that *is* the core promise: the margin on every plate. Cap it and a bar (40–80 drink SKUs) or any restaurant with a wine/cocktail list hits the wall almost immediately, gets a dashboard that's silently wrong on part of the menu, and churns — the exact activation failure competitors suffer, just moved behind a paywall. So "unlimited menu, dishes and drinks" is a free-tier *feature we market*, a direct contrast to tools that make menu setup painful, and the reason the photo-to-menu wizard is also quota-free. Upgrade pressure stays on the metrics that genuinely scale with the business: scans, seats, and history.

## 4. Unit economics (order-of-magnitude)

**Inference dominates; infrastructure is noise.** Per-invoice inference at current NVIDIA pricing lands around $0.01–0.03 including retries — $10 for a heavy Pro month of 500 scans. The full GCP bill for that same heavy restaurant (3 members, daily use, 100 assistant questions) itemizes to roughly **$1/month**:

| GCP line item | Monthly estimate | Driver |
|---|---|---|
| Firestore reads | ~$0.52 | ~870K reads: app refreshes (~1.3K docs × ~360 sessions), triage polling, assistant context builds |
| Firestore writes | ~$0.01 | scan lifecycle + entries (~8K writes) |
| Storage + egress | ~$0.22 | receipt JPEGs (~350 KB each, accumulating) + image views |
| Cloud Functions | ~$0.18 | ~60K API invocations + OCR wait time |
| Auth / Hosting | ~$0 | Google sign-in is free; SPA is ~1 MB |

So a heavy Pro costs **≈ $11 all-in** ($10 inference + $1 GCP) against $29; a typical Pro (~180 scans) ≈ $4–5. The earlier $6/$12 serving-cost assumptions in §9 hold — they were conservative. Two structural notes: Firebase's free tier absorbs most of this until roughly the first dozen active restaurants (early-stage burn is effectively inference only), and the cost worth *watching* is Firestore reads — the two read-hungry features (assistant context builds, triage polling) scale with engagement, and a rollup/caching pass buys headroom if reads ever grow past ~30% of COGS. A free user at the 25-scan cap runs ~$0.60–0.70 all-in, which is the whole reason the cap exists: free-tier COGS stays a rounding error even at 20:1 free-to-paid ratios.

Payback target: CAC under $60 (2-month payback). The realistic channels at this stage are all low-CAC: word of mouth between chefs, restaurant-supplier reps and accountants as referrers (they see the food-cost pain first), and local restaurant-owner groups. Paid acquisition should wait until organic conversion data exists.

## 5. Conversion moments

The product already produces the upgrade triggers; the paywall just needs to sit on them honestly. Hitting the scan cap mid-month with a stack of invoices in hand is the primary one. Inviting a team member is the second. Wanting the price-hike email instead of having to open the app is the third. Each should show what the user is about to lose or gain *in their own data* ("Este mes Teremu detectó $340 en subidas de precio — Pro te habría avisado por correo"), never a generic feature grid.

Benchmarks to steer by: free→paid conversion of 4–8% is healthy for prosumer SaaS; below 3% means the free tier is too generous or the wedge features are wrong. Monthly logo churn under 3% for a tool embedded in weekly operations.

## 6. KPIs

Activation: first *approved* invoice within 48 h of sign-up (not just a scan — approval means they trusted the extraction). Habit: ≥2 scanning sessions per week in weeks 2–4. Conversion: % of activated restaurants on Pro by day 45. Revenue: MRR, net revenue retention (expansion comes from the Grupo tier — a customer adding locations, each its own Pro subscription). Cost: inference cost per active restaurant, watched monthly.

## 7. Rollout sequence

1. **Beta (now):** everything free, no caps, instrument the metrics above. Learn what heavy usage actually looks like before setting caps in stone.
2. **Launch freemium:** introduce Pro; grandfather beta restaurants with 3 free months of Pro (they become the testimonials).
3. **Localize pricing:** charge in local currency with regional price points (e.g., MX$499) — a USD price in LATAM adds silent friction.
4. **Grupo tier:** the switcher, per-location roles/permissions, and per-location Pro billing are built (see `docs/multi-location-plan.md`) — a multi-location customer can be sold today at N × Pro. **Consolidated cross-location dashboards** are the part still gated: build them only after ≥3 multi-location customers ask, since that reporting layer is real engineering on top of what already ships.

## 8. Implementation notes (maps to the current codebase)

The permission system already carries per-member gating; plan gating is the same pattern one level up. The `plan: "free" | "pro"` field plus `scanPeriod`/`scanCount` live on the restaurant doc; the scan cap is enforced server-side in `POST /invoices` (a 402 the scanner turns into an upgrade prompt), member invites are gated in `POST /members`, and list endpoints window by plan (the `?days=` mechanism). Email features hang off the existing `sendMail()` helper.

**Billing (built — Stripe).** `billing.ts` implements Stripe Checkout (monthly or yearly, chosen on the pricing page) and the customer portal (change card / switch interval / cancel). The `stripeWebhook` function is the *only* thing that flips `plan` in production: it verifies the signature and mirrors the subscription state onto `restaurants/{rid}` (`plan`, `planInterval`, `stripeCustomerId`, `stripeSubscriptionId`). Firestore is the source of truth the app reads, so a dropped webhook never unlocks Pro without payment, and a cancellation always re-locks. Configuration is all dashboard/secret, no code:

- Secrets: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.
- Params (`functions/.env`): `STRIPE_PRICE_PRO_MONTHLY`, `STRIPE_PRICE_PRO_YEARLY` (price IDs of the Pro product's two recurring prices), `APP_URL` (checkout return base).
- Point a Stripe webhook endpoint at the deployed `stripeWebhook` URL, subscribing to `checkout.session.completed` and `customer.subscription.*`.

Until `STRIPE_SECRET_KEY` is set, checkout/portal return 501 (`billing_not_configured`) and the emulator-only `PUT /billing/plan` switches tiers for testing. The two recurring prices are the only Stripe objects that must exist; everything else is created on the fly.

---

## 9. Breakeven math: how many free users can each Pro carry?

Assumptions per month: Pro at $29 minus ~$1.34 payment processing; serving a Pro costs $6 (base: ~180 scans × $0.02 + infra) or $12 (conservative: heavy usage); a free user costs $0.50 (base — capped scans, many dormant) or $0.90 (conservative).

**Contribution per Pro:** $21.66 base / $15.66 conservative.

**The number that matters — the free-rider ceiling.** Each Pro's contribution can subsidize `contribution ÷ free-user-cost` free users before variable margin hits zero:

| Scenario | Free users one Pro can carry | Minimum free→paid conversion |
|---|---|---|
| Base | **43 : 1** | **2.3%** |
| Conservative | **17 : 1** | **5.4%** |

Anything better than those conversion floors and every additional user (free or paid) adds margin. The industry-normal 4–8% conversion clears the base case comfortably and the conservative case at the top of the range — the model works, but it is *not* immune to a generous free tier plus expensive inference. The scan cap is what keeps the ceiling high; raising the free cap from 25 to 50 scans halves it.

**Covering fixed costs** (net contribution per Pro after carrying its share of free users):

| Conversion | Net per Pro (base) | Paid needed: $300/mo fixed | $2,500/mo | $10,000/mo |
|---|---|---|---|---|
| 3% | $5.49 | 55 (≈1.8k users) | 455 (≈15k) | 1,822 (≈61k) |
| 5% | $12.16 | 25 (≈500 users) | 206 (≈4.1k) | 823 (≈16.5k) |
| 8% | $15.91 | 19 (≈240 users) | 157 (≈2k) | 629 (≈7.9k) |

Reading: a bootstrapped solo operation ($300/mo of tooling) breaks even at roughly **500 total restaurants with 5% conversion (25 paying)** — a reachable first-year number in one city. A $2,500/mo operation needs ~4,000 restaurants at 5%, which is a regional business. In the conservative cost case, 5% conversion *loses* money — the levers that restore it are the scan cap, cheaper inference (prices keep falling), or nudging Pro to $35–39.

## 10. Competitive: Haddock (haddock.app, YC W22)

Haddock is the closest direct competitor — same core loop (photograph invoice → AI digitization → price-variation alerts → dynamic recipe costing/escandallos → margin dashboard), strong in Spain, present in Mexico, restaurant references incl. Michelin-level. Verified pricing (July 2026, VAT excl.): **Spain — Basic 159€/mo (400 docs), Standard 299€/mo (500 docs), Unlimited 399€/mo**; other markets still show the older ladder (Growth 85€/200 docs/4 users; Premium 120€/400 docs/unlimited users; Group from 700€). **Mexico — Free (14 docs, 2 users), Starter MX$595 (40 docs), Growth MX$975 (200 docs), Premium MX$1,495 (400 docs)**, plus a paid implementation fee on every plan and a sales-led "schedule a call" motion. Ten-day trials; a genuine free tier only in Mexico.

**Where we win.** Price, radically: our Pro at $29 with 500 scans sits where their entry plan charges 85–159€ for 200–400 docs — 3–6× cheaper per digitized document, with granular per-member permissions (they gate *user count* by plan; we make seats a Pro feature with real access control). Self-serve onboarding with no implementation fee is itself a wedge against their sales-led motion for small independents. And their Mexico free tier (14 docs) validates our freemium thesis while being weaker than our 25-scan free plan.

**What they have that we should consider (in priority order):**

1. **AI reconciliation of delivery notes vs invoices** — they sell "conciliaciones con IA" as a headline (30/mo on Basic, unlimited on Standard). Matching the albarán to the month-end factura is a real accounting pain we don't address; our pipeline already distinguishes document quality, so a "match this delivery note to an invoice" stage is a natural extension. *Strongest candidate for our roadmap.*
2. **Supplier ordering ("Purchases") module** — they let you place orders from the app. Our grocery-list generator is one step short: adding "send to vendor" (WhatsApp share / email via `sendMail()`) is cheap and closes the loop.
3. **POS integrations** — they auto-import sales; we log revenue manually. Already on our roadmap; this comparison raises its priority since it feeds the margin math both products compete on.
4. **AI agent ("Fina")** — a conversational layer over the data. Trendy but consistent with our stack; a "ask your kitchen" chat could differentiate at our price point later.
5. **HR/scheduling module** — their bundling play. *Deliberately skip*: it dilutes the food-cost wedge and drags us into a different competitive set.

**Positioning line this suggests:** Haddock is becoming the expensive, sales-led operations suite for groups; Teremu is the self-serve food-cost tool an independent can adopt on a Tuesday for the price of two covers.

---

*Open questions to resolve with real users: Is $29 right for the target market, or is MX$399–499 the honest anchor? Should the free tier cap dishes (15?) as a third lever? Does "Pro" need a trial at all, given the free tier is the trial?*
