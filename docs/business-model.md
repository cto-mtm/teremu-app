# Teremu — Business Model

**Model:** Freemium subscription (SaaS), priced per restaurant location.
**Customer:** Independent restaurant owner-operators and executive chefs — people who feel every point of food cost personally but have no back office.
**Status:** Draft for discussion. Prices are placeholders calibrated for a Spain / LATAM launch; the **US is a target market in its own right** (decided 2026-10-24), and the same $-denominated ladder is the starting point there — validate against 15–20 customer conversations per market before committing.

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

| | **Gratis** | **Pro** — *el plan del chef* | **Max** | **Grupo** |
|---|---|---|---|---|
| Price (live in Stripe) | $0 | **$39/mo** or $390/yr (2 months free) | **$59/mo** or $590/yr | Pro or Max, billed per location |
| Invoice documents (photo scans + emailed invoices) | 25 / month | 500 / month fair use | 1,500 / month fair use | Per location |
| Team members | Owner only | Up to 5, granular permissions | Up to 10, granular permissions | Per location |
| History window | 90 days | Full history | Full history | Full history, per location |
| Menu items (dishes + drinks) | **Unlimited** | Unlimited | Unlimited | Unlimited |
| Dish margins & menu engineering matrix | ✓ | ✓ | ✓ | ✓, per location |
| Theoretical pantry + true-up | ✓ | ✓ | ✓ | ✓ |
| Grocery list generator | ✓ | ✓ | ✓ | ✓ |
| Price-hike & margin alerts (in-app) | ✓ | ✓ | ✓ | ✓ |
| Kitchen assistant (AI Q&A over your data) | 20 questions / month | 300 / month | 1,000 / month | Per location |
| Email alerts & weekly digest | — | ✓ | ✓ | ✓ |
| Vendor directory & spend analytics | Basic (top 3 vendors) | Full | Full | Full, per location |
| Expense tags (non-food) | 3 tags | Unlimited | Unlimited | Unlimited |
| Emails sent (invites + supplier orders) | 10/day | 50/day | 100/day | Per location; abuse cap, not a selling point |
| Free locations per owner | 3 | — | — | Paid locations don't count |
| Data export (CSV) | — | ✓ | ✓ | ✓ |
| POS integration (Square — built, `docs/pos.md`) | Hourly sales sync, no AI matching | ✓ (5-min sync, AI matching) | ✓ | ✓, per location |
| "Find your restaurant" import (Google listing + website menu) | ✓ | ✓ | ✓ | ✓, per location |
| Email invoice import (Gmail — designed, `docs/email-ingestion.md`) | 1 inbox, daily sync, counts toward the 25 | 1 inbox, every 6 h | Up to 3 inboxes, every 6 h | ✓, per location |
| Support | Community | Priority (48 h) | Priority (48 h) | Dedicated |

A failed renewal keeps the plan through Stripe's retry window; the plan drops when Stripe gives up (2026-10-29: `past_due` keeps the tier, `unpaid` / `canceled` / `incomplete` / `paused` are Free — `billing.ts planFromSubscription`). Settings shows the owner the payment problem meanwhile.

**Pricing update (2026-07-27).** Pro re-anchored from the $29 placeholder to **$39** (the recovered-margin math supports it, and lowering later is painless where raising is a churn event), and **Max** added at **$59** — 1,500 scans, 10 seats — to harvest the price umbrella under Haddock's 85–159€ entry from the customers who resemble Haddock's, without taxing free→Pro conversion. §9's breakeven tables still assume $29, so they now read conservative. Max costs ~$4.50/month worst-case to serve at Gemini prices, so its margin profile matches Pro's.

**Grupo is not a distinct SKU** — it's the multi-location switcher (built — see `docs/multi-location-plan.md`) plus N independent Pro subscriptions, one per restaurant, each on its own monthly/yearly cadence. A person can own or work at several locations with a different role and permissions at each; every limit above (scans, seats, history) applies per location, because each location's Stripe subscription, plan, and usage are tracked independently on its own `restaurants/{rid}` doc. What Grupo does *not* yet include is consolidated cross-location reporting (one dashboard summing all locations) — that's real engineering, deliberately out of scope for now (see "Out of scope" in the multi-location plan), and the natural next step once it's worth building.

Design intents behind the numbers: 25 scans ≈ one delivery-heavy week — enough to prove value, not enough to run a month on. The team gate converts precisely at the moment of habit formation. The 90-day window keeps the dashboard alive for free users while making the year-over-year story (and tax season) a Pro feature.

**Why menu size is deliberately *not* a gate.** Capping menu items was considered and rejected. A dish doc costs us effectively nothing (inference, not storage, is COGS — see §4), so a cap would be pure price discrimination on the one thing that *is* the core promise: the margin on every plate. Cap it and a bar (40–80 drink SKUs) or any restaurant with a wine/cocktail list hits the wall almost immediately, gets a dashboard that's silently wrong on part of the menu, and churns — the exact activation failure competitors suffer, just moved behind a paywall. So "unlimited menu, dishes and drinks" is a free-tier *feature we market*, a direct contrast to tools that make menu setup painful, and the reason the photo-to-menu wizard is also quota-free. Upgrade pressure stays on the metrics that genuinely scale with the business: scans, seats, and history.

**Why the menu wizard stays unmetered (revisited at Gemini prices).** A full wizard run — menu photo → dishes, then AI recipe drafts — costs **~$0.005, worst case ~$0.02** (`docs/llm.md`), and it happens roughly once per restaurant lifetime, with occasional re-runs for seasonal menus. Metering it would tax the single highest-leverage moment in the funnel: it runs at *minute five*, before any habit exists, and its output is the anchor — a restaurant that has its full menu costed in Teremu has built the switching cost that makes the scan cap bite later. Charging $0.02-worth of tokens to protect against that is backwards; the wizard is CAC we don't pay in dollars. The only guard worth having is an abuse valve, not a paywall. It is built: **30 menu-AI calls per restaurant per day** (photo reads and recipe drafts; a full run is 2–4 calls, so ~8–15 runs/day), plus the existing 5-second per-member cooldown — `helpers/dailyCap.ts`. That is generous enough that no real user ever sees it, and it exists purely to bound scripted abuse of the free endpoint.

**Why the assistant gets a free taste (2026-10-19).** Free restaurants get **20 assistant questions a month**; Pro gets 300 and Max 1,000, and everyone has 60 per person per day. The assistant is the feature that turns "my data is in Teremu" into "Teremu answers me" ("¿qué plato me deja menos margen?"). Letting a free owner feel that is a conversion lever, and it costs almost nothing: a typical turn is ~$0.002 on Vertex Flash-Lite (`docs/llm.md`), so 20 questions are **~$0.04/month**. Even the worst case, every turn hitting the package's caps of 4 steps and 1,024 output tokens per step, is ~$0.60. Twenty is enough to try it on real questions a few times a week, and far short of running the kitchen on it, so the upgrade pressure stays: hitting the limit shows the upgrade notice in the modal. The caps count **questions (turns), not tokens**. Each turn is reserved before the model runs, on `restaurants/{rid}.aiUsage` (`{ period, used, daily: { <uid>: { date, used } } }`, in the restaurant's timezone), and its cost is bounded by those per-turn caps. Tokens are logged per turn (`ai_usage`, with `estimatedCostMicros`) for COGS, not for gating. The numbers live in `plan.ts` `PLAN_LIMITS.assistantTurns`, which the assistant manifest reads.

**Why the listing import is free too (2026-10-19).** "Find your restaurant" (`docs/restaurant-listing.md`) is the same bet one step earlier: the owner's Google listing and website prefill the restaurant and its menu before the photo wizard is even needed. It costs about **$0.10 once per restaurant** at list price, and **$0 for the first ~200 onboardings a month** because of Google's free monthly caps (§4, "Google Places"). It is the cheapest activation step we have. Metering it would be the paywall-at-minute-one mistake. Like the wizard, it gets abuse valves instead of a price: 5 imports, 30 searches and 10 photo/review loads per restaurant per day (`helpers/dailyCap.ts`), plus project-wide quotas in Google Cloud (§4).

**Why email import is on Free, capped (2026-10-21).** Connecting Gmail (`docs/email-ingestion.md`) reads the last 31 days once, then only new mail, and puts the invoices it finds into Triage. It is on every plan, and on Free its cap is the meter Free already has: emailed invoices count toward the **25 documents a month**, one per document, refunded if discarded; Free syncs daily, paid plans every 6 hours. The feature's real cost is fixed — Google's annual security assessment (CASA), **~$540–1,800/yr** — and a fixed cost does not grow when free users connect, so keeping Free out would save nothing and shrink the funnel that pays it back. What a free connection adds is marginal: about **$0.12/month at the cap, $0.25 at the absolute worst** (§4 "Email import"). Free sees invoices enter themselves (activation), then sees them wait when the 25 run out — "12 facturas esperando en tu correo" — which is the most concrete upgrade prompt the product has (§5). Same shape as POS: on every plan, Free capped.

## 4. Unit economics (order-of-magnitude)

**Inference dominates; infrastructure is noise.** Per-invoice inference at current NVIDIA pricing lands around $0.01–0.03 including retries — $10 for a heavy Pro month of 500 scans. The full GCP bill for that same heavy restaurant (3 members, daily use, 100 assistant questions) itemizes to roughly **$1/month**:

| GCP line item | Monthly estimate | Driver |
|---|---|---|
| Firestore reads | ~$0.52 | ~870K reads: app refreshes (~1.3K docs × ~360 sessions), triage polling, assistant context builds |
| Firestore writes | ~$0.01 | scan lifecycle + entries (~8K writes) |
| Storage + egress | ~$0.22 | receipt JPEGs (~350 KB each, accumulating) + image views |
| Cloud Functions | ~$0.18 | ~60K API invocations + OCR wait time |
| Auth / Hosting | ~$0 | Google sign-in is free; SPA is ~1 MB |

**The Gemini lever.** The provider is config, not code (`docs/llm.md`), and the planned switch to `gemini-3.1-flash-lite` ($0.25/1M input, $1.50/1M output, checked 2026-07-24) reprices a scan at ~2.5K input + ~1K output tokens ≈ **$0.0025 including retries** — call it $0.003. A heavy Pro month becomes ~$1.25 of scan inference plus ~$0.60 for 100 assistant questions (those are dominated by the data snapshot, ~20K tokens each): **≈ $2 of inference, ≈ $3 all-in** instead of $11. *(Update 2026-10-13: the assistant no longer sends a snapshot. It is the shared `@mtmcya/assistant` package on Vertex Gemini Flash-Lite, calling tools, measured at **≈ $0.0005 per two-step turn** (`docs/llm.md` § Assistant). 100 questions now cost ~$0.05, not ~$0.60. Every assistant figure in this section and the archetype table below is therefore an over-estimate by roughly 10×. They are left as written because they are conservative.)* *(Update 2026-10-28, measured: the model Teremu actually runs on Vertex is `gemini-3.5-flash-lite`, at **$0.30/1M input, $2.50/1M output** ([pricing](https://ai.google.dev/gemini-api/docs/pricing), updated 2026-10-27 and checked 2026-10-28; batch is half). The output price is higher than 3.1's, but a real scan is input-heavy, not the ~1K-output guess above. On the real client corpus (248 documents, `docs/real-samples.md`, the production prompt and context) a scan used **~4.5K input + ~0.4K output tokens ≈ $0.0024 on average** (P50 $0.0021, P95 $0.0035, the worst 4-page document $0.0099, no retries in the run). The $0.003 planning figure stands, so the archetype table and §9 are unchanged. The same eval also settled quality: Gemini read 248/248 documents and got 246 totals right against the accountant's export, where NVIDIA's Nemotron read 211 and got 208 right. Production switched every call to Vertex the same day (`LLM_PROVIDER=vertex`, `docs/llm.md`), so the NVIDIA line above is history.)* At that point inference stops being the dominant COGS line and Firestore reads take over — the "cost worth watching" below flips from the model bill to the database.

So on NVIDIA-era assumptions a heavy Pro costs **≈ $11 all-in** ($10 inference + $1 GCP) against $29; a typical Pro (~180 scans) ≈ $4–5. On Gemini pricing those become ≈ $3 and ≈ $1.50 respectively, and a capped free user falls from ~$0.60–0.70 to **~$0.20**.

**Per-archetype usage model (Gemini prices).** Single-point estimates hide variance, so here is the low/avg/worst structure. Per-call costs come from the token model in `docs/llm.md`; crucially, the worst cases are *bounded by the code* (output `max_tokens` caps, the 300-name catalog cap in the OCR prompt, the assistant snapshot's query limits), so "worst" means every cap hit plus a retry — not an open tail:

| Archetype (monthly) | Scans | Assistant Qs | Inference | All-in |
|---|---|---|---|---|
| Dormant free (likely 50–60% of free base) | ~3 | ~0 | <$0.01 | ~$0.05 |
| Active free at the 25-scan cap | 25 | ≤ 20 | ~$0.10 | ~$0.24 |
| Typical Pro | ~180 | ~50 | ~$0.60 | ~$1.50 |
| Heavy Pro | 500 | ~100 | ~$2 | ~$3 |
| Tail Pro (every call worst-case, 300 Qs) | 500 | 300 | ~$7.50 | ~$10 |

Three readings. First, a free user's inference is scans plus at most 20 assistant questions a month (free 20 / Pro 300 / Max 1,000 turns, 60 per person per day — `plan.ts` `PLAN_LIMITS`, read by `assistant/manifest.ts`). The questions add ~$0.04 at most, so the blended free-user cost at a realistic dormant/active mix stays ~$0.10, and the $0.20 used in §9 is still comfortably conservative. Second, the **tail Pro (~$10) is what the NVIDIA-era model assumed an ordinary heavy Pro cost** — the pathological case still clears 3× margin against $29. Third, the assistant, not scanning, was the widest variance driver while it sent a snapshot that grew ~20× with restaurant size. As a tool loop its cost per turn is nearly flat, and the per-plan turn quota is what keeps the tail closed. Treat that quota as pricing infrastructure, not a tuning knob. These archetype shares (how many dormant vs active, real scans/questions per tier) are exactly what the beta instrumentation in §7 must measure — the token math is solid, the *mix* is still assumption.

### Google Places (the listing import)

The import (`docs/restaurant-listing.md`) is the first non-LLM, per-call paid API in the stack. Prices are from Google's Maps Platform price list, last updated 2026-10-16 and checked 2026-10-19 ([pricing](https://developers.google.com/maps/billing-and-pricing/pricing)). Since March 2025 there is no $200 monthly credit: each SKU has its own free monthly cap, they don't pool, and they reset monthly. **A request is billed at its most expensive field**, which is why the code keeps two separate field masks.

| Our call | When | SKU (why) | Free / month | Price per 1,000 |
|---|---|---|---|---|
| Search-as-you-type | each 400 ms pause while typing (3+ characters) | Autocomplete Requests | 10,000 | $2.83 |
| Listing details | once per import (and per verification-code send) | Place Details **Enterprise** (our mask includes hours, phone and rating) | 1,000 | $20.00 |
| Reviews + photo list (+ rating, open now) | once per review screen; once per app session on the Settings card, more on "Actualizar" | Place Details **Enterprise + Atmosphere** (reviews) | 1,000 | $25.00 |
| Each photo shown | up to 5 per review screen | Place Details Photos | 1,000 | $7.00 |
| Assistant lookup (rating, review count, open now) | per assistant question that needs it, ≤ 10 per restaurant per day | Place Details **Enterprise** (same mask as listing details) | shares the 1,000 above | $20.00 |

Google doesn't say whether Places (New) waives the autocomplete keystrokes of a session that ends in a details call, as the legacy API did. The numbers below assume they're paid, so they read high.

**Per onboarding** (~6 keystrokes, 1 details call, 1 review screen with 5 photos): ~$0.017 + $0.020 + $0.025 + $0.035 ≈ **$0.10 at list price**, plus ~$0.005 of LLM to read the website menu (≤ ~$0.02 worst case, the same order as the photo wizard). It happens once per restaurant, and again only on a Settings re-import.

**What the free caps absorb.** Photos run out first: 1,000 photo calls is ~200 review screens.

| New restaurants onboarding / month | Places cost / month | Per onboarding |
|---|---|---|
| ≤ 200 | ~$0 | $0 |
| 1,000 | ~$28 (photos only) | ~$0.03 |
| 3,000 | ~$210 | ~$0.07 |
| 10,000 | ~$900 | ~$0.09 |

Against a $60 CAC target (below), even the list price is noise. Against the free tier's ~$0.20/month (§9), it is half a month of a free user's cost, paid once. **No change to the tier math.**

**The assistant's lookups (2026-10-21).** Address, phone and hours are the owner's confirmed data on the restaurant doc (`docs/restaurant-listing.md`, open decision 1) and cost nothing to answer. The rating and open-now are fetched live per question — Google's terms don't allow keeping them, even for a day — at $0.02 list, capped at 10 per restaurant per day (`helpers/dailyCap.ts`), with a 10-minute in-process memo so a conversation that asks twice pays once. The Settings card's live panel rides the existing media cap (10/day) and loads once per app session. A restaurant that asks about its rating every single day spends ~$0.60/month at list price, and the free Enterprise allowance absorbs the first ~1,000 lookups a month across all restaurants. No change to the tier math.

**The real exposure is abuse, not use.** Per-restaurant daily caps bound one account at **~$0.98/day**: 30 searches ≈ $0.08, 5 imports ≈ $0.10, 10 media loads ≈ $0.60, 10 assistant lookups ≈ $0.20. A real onboarding uses about 3–6 searches, 1 import and 1 media load. The setup screen waits for 3 characters and a 400 ms pause before each search, because each pause while typing is a billed request. But accounts are free and Google sign-in is unlimited, so the caps alone don't bound the **total**. Two backstops belong in the Google Cloud console before launch, not in code: **per-SKU daily quotas** on Places API (New) (e.g., Place Details 3,000/day, Photos 5,000/day, Autocomplete 20,000/day — far above organic use, a hard stop for a script), and a **budget alert** on the project. A quota hit makes the import answer an error, and the owner can still continue with "Prefiero empezar de cero" or the photo wizard.

Claim verification and its emails are rare and negligible. Each code send adds one Enterprise details call ($0.02) and one mail through the shared mtmcya-mailer, with send caps per restaurant, per place and per address. Places authenticates as the function's own service account, so there is no API key and no secret to manage.

### POS integration (Square)

POS is on every plan since 2026-10-20 (`docs/pos.md` §Plan gating), so its running cost is a free-tier line too. Per connected restaurant it is Firestore, not inference: the 5-minute scheduler reads the integration and plan docs every tick (~17K reads/month ≈ $0.01) and polls the provider only when that restaurant's adaptive `nextPollAt` is due — hourly on Free, 5–30 min on Pro/Max — writing sales entries and dirty-day rebuilds (a busy restaurant, ~300 orders/day, lands around 10–20K writes/month ≈ $0.03). The only LLM cost is the catalog matcher's third tier, Pro/Max only, one call per catalog sync with unmatched items (≈ $0.001 at Gemini prices). Order of magnitude: **cents a month per connected restaurant on any plan**; the Free caps exist to bound the serial scheduler loop and the LLM calls, not storage. Measured through `places_usage`-style logging once real connections exist (§4 "From scenarios…").

### Email import (Gmail)

Designed, not built — `docs/email-ingestion.md` § AI cost has the full model; the numbers here are its summary at Gemini 3.1 Flash-Lite prices. Email runs on `gemini-3.5-flash-lite` (§4 "The Gemini lever", 2026-10-28): its prices raise classification by 1.2–1.7× (input vs output price ratio) and leave extraction inside the bound, since a measured scan is ~$0.0024 against the ~$0.0036 per document assumed here. That moves the Free absolute worst to **≈ $0.35** (classification ~$0.25); every other row stays under $0.30.

**Fixed:** Google's restricted-scope verification plus the annual CASA assessment, **$540–1,800/yr (≈ $45–150/month)** whatever the number of connected restaurants. At Pro's ~$25 contribution it is covered by 2–6 Pro subscriptions. The Gmail API itself is $0 at our volumes.

**Per connected restaurant, per month:**

| | Classification (text, cheap) | Extraction | Email AI total | Added over photographing the same invoices |
|---|---|---|---|---|
| Free at its 25-document cap | ~$0.02–0.03 | ≤ $0.09 | **≈ $0.12** | ≈ $0.03–0.05 |
| Free, absolute worst (flood inbox, classifier daily cap hit every day) | ~$0.15 | ≤ $0.09 | **≈ $0.25** | ≈ $0.15 |
| Typical Pro (~400 emails, ~48 documents) | ~$0.01 | ~$0.18 | **≈ $0.19** | ≈ $0.09 |
| Heavy Pro (~600 emails, ~72 documents) | ~$0.02 | ~$0.27 | **≈ $0.29** | ≈ $0.14 |

Extraction is priced as if every document were read as an image. Digital PDFs (read from their text layer) and invoices written in the email body (read as text) cost ~25–40% less, so these are upper bounds until `llm_usage` (labels `email-classify`, `ocr`, `ocr-text`) measures the real mix. The Free bounds come from code, not assumptions: the 25-document meter caps extraction, and a per-restaurant daily cap on classification (50/day Free, 300 Pro/Max — `helpers/dailyCap.ts`) caps the rest.

**No change to prices or quotas.** Pro's typical serving cost goes from ~$1.50 to ~$1.70. For Free, see §9.

### From scenarios to measured distributions

Low/avg/worst is the right *planning prior*, but it is not how AI COGS is modeled operationally. LLM cost distributions are **right-skewed**: most calls are cheap, a small fraction are expensive, and the arithmetic mean is systematically misleading — industry practice (the discipline is being called *TokenOps*, FinOps applied to tokens) is to track **percentiles**. The scenarios above should be retired the month real telemetry exists. What replaces them:

**Instrumentation (built).** Every provider response includes exact token counts, and `llm.ts` now emits a structured `llm_usage` log line per call (`label` = ocr / ocr-text / menu-extract / menu-extract-text / recipe-drafts / email-classify, plus the POS matcher; model, prompt + completion tokens). The assistant logs its own turns to the `ai_usage` collection, with `estimatedCostMicros`. **Google Places** logs a `places_usage` line per request (`sku`, `status`, `rid`, auth mode — `listing/google.ts`). A logs-based metric × the price list in §4 "Google Places" gives Places COGS per SKU and per restaurant, the same way `llm_usage` does for the model. Cloud Logging → a logs-based metric or BigQuery sink → multiply by the price sheet in `docs/llm.md`. Nothing is estimated; COGS is *observed*. When per-restaurant attribution is worth having (it will be, for the fair-use conversation), thread the `rid` into the label — every call site already has it in scope.

**The KPI set:**

1. **Unit cost per feature at P50 / P95 / P99** — cost per scan, per assistant question, per wizard run. P50 is the pricing input; P95 is what limits and fair-use should be *designed around*; P99 is the review trigger.
2. **P99 ÷ P50 ratio per call type** — the degenerate-output detector. Industry heuristic: a ratio above ~50× means something is unbounded and fixing `max_tokens` typically cuts output spend 15–40%. Ours should sit far below that *because* every call already has a per-operation cap — this ratio is the regression alarm that keeps it true.
3. **Inference cost per active restaurant, as a per-tier distribution** — replaces the archetype table. The gap between the median and P99 restaurant is what calibrates the free tier's included usage and tells us when a "fair use" clause needs enforcement teeth.
4. **Inference efficiency ratio** = inference COGS ÷ MRR. External benchmarks: inference averages ~23% of revenue at scaling AI-B2B companies; public SaaS with AI features disclose 4–9%; gross-margin profiles run ~50–60% (AI-native), 60–79% (AI-enabled), 80%+ (AI-augmented). At Gemini prices Teremu's heavy Pro is ~7% and blended ~2–4% — an **AI-augmented margin profile (~90% gross margin on Pro)** despite AI being the core loop. That structural surplus *is* the price wedge against Haddock (§10): we can charge 3–6× less per document and still carry SaaS-class margins.
5. **Free-tier COGS as % of total COGS** — the number that says whether the 43:1/128:1 free-rider math in §9 is holding in practice.

Cadence: weekly during beta (the mix is unknown), monthly once distributions stabilize; any structural break (model price change, new feature, cap change) resets the clock. Two structural notes: Firebase's free tier absorbs most of the GCP bill until roughly the first dozen active restaurants (early-stage burn is effectively inference only), and at Gemini prices **Firestore reads are the dominant COGS line** — the two read-hungry features (assistant context builds, triage polling) scale with engagement, so the rollup/caching pass is the first optimization worth scheduling once real traffic exists, and the read volume deserves the same measurement discipline as tokens (the ~870K-reads estimate above rests on assumed client refresh behavior, not telemetry).

Payback target: CAC under $60 (2-month payback). The realistic channels at this stage are all low-CAC: word of mouth between chefs, restaurant-supplier reps and accountants as referrers (they see the food-cost pain first), and local restaurant-owner groups. Paid acquisition should wait until organic conversion data exists.

## 5. Conversion moments

The product already produces the upgrade triggers; the paywall just needs to sit on them honestly. Hitting the scan cap mid-month with a stack of invoices in hand is the primary one — and once email import ships, the stack is literal: a capped Free inbox keeps finding invoices and counts them ("12 facturas esperando en tu correo"), one email per month. Inviting a team member is the second. Wanting the price-hike email instead of having to open the app is the third. Each should show what the user is about to lose or gain *in their own data* ("Este mes Teremu detectó $340 en subidas de precio — Pro te habría avisado por correo"), never a generic feature grid.

Benchmarks to steer by: free→paid conversion of 4–8% is healthy for prosumer SaaS; below 3% means the free tier is too generous or the wedge features are wrong. Monthly logo churn under 3% for a tool embedded in weekly operations.

## 6. KPIs

Activation: first *approved* invoice within 48 h of sign-up (not just a scan — approval means they trusted the extraction). Habit: ≥2 scanning sessions per week in weeks 2–4. Conversion: % of activated restaurants on Pro by day 45. Revenue: MRR, net revenue retention (expansion comes from the Grupo tier — a customer adding locations, each its own Pro subscription). Cost: inference cost per active restaurant as a per-tier P50/P95/P99 distribution (from the `llm_usage` telemetry — §4), plus the inference-efficiency ratio (inference COGS ÷ MRR), watched weekly in beta and monthly after.

## 7. Rollout sequence

1. **Beta (now):** everything free, no caps, instrument the metrics above. Learn what heavy usage actually looks like before setting caps in stone.
2. **Launch freemium:** introduce Pro; grandfather beta restaurants with 3 free months of Pro (they become the testimonials).
3. **Localize pricing:** charge in local currency with regional price points (e.g., MX$499) — a USD price in LATAM adds silent friction.
4. **Grupo tier:** the switcher, per-location roles/permissions, and per-location Pro billing are built (see `docs/multi-location-plan.md`) — a multi-location customer can be sold today at N × Pro. **Consolidated cross-location dashboards** are the part still gated: build them only after ≥3 multi-location customers ask, since that reporting layer is real engineering on top of what already ships.

## 8. Implementation notes (maps to the current codebase)

The permission system already carries per-member gating; plan gating is the same pattern one level up. The `plan: "free" | "pro" | "max"` field plus `scanPeriod`/`scanCount` live on the restaurant doc; the scan cap is enforced server-side in `POST /invoices` (a 402 the scanner turns into an upgrade prompt), member invites are gated in `POST /members`, and list endpoints window by plan (the `?days=` mechanism). Email features hang off the existing `sendMail()` helper.

**Billing (built — Stripe).** `billing.ts` implements Stripe Checkout (monthly or yearly, chosen on the pricing page) and the customer portal (change card / switch interval / cancel). The `stripeWebhook` function is the *only* thing that flips `plan` in production: it verifies the signature and mirrors the subscription state onto `restaurants/{rid}` (`plan`, `planInterval`, `stripeCustomerId`, `stripeSubscriptionId`). Firestore is the source of truth the app reads, so a dropped webhook never unlocks Pro without payment, and a cancellation always re-locks. Configuration is all dashboard/secret, no code:

- Secrets: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.
- Params (`functions/.env`): `STRIPE_PRICE_PRO_MONTHLY`, `STRIPE_PRICE_PRO_YEARLY`, `STRIPE_PRICE_MAX_MONTHLY`, `STRIPE_PRICE_MAX_YEARLY` (price IDs of each product's two recurring prices — all four required or billing stays 501), `APP_URL` (checkout return base). The webhook derives the tier from which price the subscription actually carries, so the price IDs are also what map Stripe → `plan: "pro" | "max"`.
- Point a Stripe webhook endpoint at the deployed `stripeWebhook` URL, subscribing to `checkout.session.completed` and `customer.subscription.*`.

**Listing import (built — Google Places, `docs/restaurant-listing.md`).** No key or secret. Production calls Places (New) as the function's own service account: `PLACES_AUTH=adc` in `functions/.env.teremu-app`, Places API (New) enabled on the project, billing on. The first-run redirect for new owners is `LISTING_SETUP=on`. Without `PLACES_AUTH` the listing routes answer 501, and `/me` reports `listingAvailable: false` so the app hides the entry points.

Until `STRIPE_SECRET_KEY` is set, checkout/portal return 501 (`billing_not_configured`) and the emulator-only `PUT /billing/plan` switches tiers for testing. The two recurring prices are the only Stripe objects that must exist; everything else is created on the fly.

---

## 9. Breakeven math: how many free users can each Pro carry?

Assumptions per month: Pro at $29 minus ~$1.34 payment processing; serving a Pro costs $6 (base: ~180 scans × $0.02 + infra) or $12 (conservative: heavy usage); a free user costs $0.50 (base — capped scans, many dormant) or $0.90 (conservative). A third scenario prices inference at Gemini 3.1 Flash-Lite rates (§4): serving a Pro ~$2 (typical usage lands near $1.50, heavy near $3), a free user ~$0.20.

**Contribution per Pro:** $21.66 base / $15.66 conservative / **$25.66 Gemini**.

**The number that matters — the free-rider ceiling.** Each Pro's contribution can subsidize `contribution ÷ free-user-cost` free users before variable margin hits zero:

| Scenario | Free users one Pro can carry | Minimum free→paid conversion |
|---|---|---|
| Base | **43 : 1** | **2.3%** |
| Conservative | **17 : 1** | **5.4%** |
| Gemini | **128 : 1** | **0.8%** |

Anything better than those conversion floors and every additional user (free or paid) adds margin. The industry-normal 4–8% conversion clears the base case comfortably and the conservative case at the top of the range — the model works, but it is *not* immune to a generous free tier plus expensive inference. In the NVIDIA-priced scenarios the scan cap is what keeps the ceiling high — raising free from 25 to 50 scans roughly halves it; at Gemini prices the free user's cost is GCP-dominated and the cap's role shifts to pure conversion pressure (see the Gemini paragraph below).

**Covering fixed costs** (net contribution per Pro after carrying its share of free users):

| Conversion | Net per Pro (base) | Paid needed: $300/mo fixed | $2,500/mo | $10,000/mo |
|---|---|---|---|---|
| 3% | $5.49 | 55 (≈1.8k users) | 455 (≈15k) | 1,822 (≈61k) |
| 5% | $12.16 | 25 (≈500 users) | 206 (≈4.1k) | 823 (≈16.5k) |
| 8% | $15.91 | 19 (≈240 users) | 157 (≈2k) | 629 (≈7.9k) |

And the same table at Gemini inference costs:

| Conversion | Net per Pro (Gemini) | Paid needed: $300/mo fixed | $2,500/mo | $10,000/mo |
|---|---|---|---|---|
| 3% | $19.19 | 16 (≈520 users) | 131 (≈4.4k) | 522 (≈17.4k) |
| 5% | $21.86 | 14 (≈275 users) | 115 (≈2.3k) | 458 (≈9.2k) |
| 8% | $23.36 | 13 (≈160 users) | 108 (≈1.35k) | 429 (≈5.4k) |

Reading: on NVIDIA-era numbers, a bootstrapped solo operation ($300/mo of tooling) breaks even at roughly **500 total restaurants with 5% conversion (25 paying)** — a reachable first-year number in one city. A $2,500/mo operation needs ~4,000 restaurants at 5%, which is a regional business. In the conservative cost case, 5% conversion *loses* money — the levers that restore it are the scan cap, cheaper inference (prices keep falling), or nudging Pro to $35–39.

**What the Gemini scenario changes structurally.** Solo breakeven drops to ~275 total restaurants at 5%, and even a 3% conversion — below the healthy-freemium floor — is comfortably profitable, so the model stops being fragile to a generous free tier. The conversion floor falls from 2.3–5.4% to under 1%, which converts the scan cap from a *cost-survival* mechanism into a pure *conversion-pressure* mechanism: raising free from 25 to 50 scans would cost ~$0.06/user/month, so if activation data ever says the cap bites before the "aha" moment, raising it is nearly free. The caveats: these are July 2026 list prices for a model tier Google retires aggressively (re-verify in `docs/llm.md` before flipping), extraction quality on the lite tier must hold on real crumpled invoices (mis-extractions cost retries and, worse, user trust — validate on `docs/ocr-samples.md` first), and once inference is ~$2, **Firestore reads become the biggest COGS line**, moving the rollup/caching pass from "if reads grow" to the first optimization worth scheduling.

**Email import on Free (2026-10-21).** A connected Free restaurant costs ~$0.12/month more at its 25-document cap and ~$0.25 at the absolute worst (§4 "Email import"). Stress case: *every* free user connects a flood inbox. The Gemini free-user cost then goes from ~$0.20 to ~$0.45, the free-rider ceiling from 128:1 to ~57:1, and the conversion floor from 0.8% to ~1.8% — still well under the healthy 4–8%. Realistically most free restaurants never connect an inbox, so the blended change is a few cents and the tables above stand. The fixed CASA cost (~$45–150/month) belongs in the fixed-cost columns, not per user: at the Gemini 5% row ($21.86 net per Pro) it takes ~2–7 more paying restaurants to cover.

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

### US competitive set (added 2026-10-24, prices unverified)

Haddock is not who a US owner compares us to. The US set for the same loop (invoice capture → price alerts → recipe costing → margin) is **MarginEdge** (invoice processing + recipe costing, historically ~$300+/mo per location, sales-led), **xtraCHEF by Toast** (bundled into the Toast POS ecosystem, priced per location on top of Toast), and **Restaurant365** (full back office, well above $400/mo, aimed at groups). All three are priced an order of magnitude above our Pro, all are sales-assisted, and none has a genuine free tier — the same shape as the Haddock comparison, with a bigger gap. Verify current list prices before quoting; add them to `market-sizing.md` §4 once checked. The "adopt on a Tuesday" positioning carries over unchanged; the US-specific wedge is that none of them talks to the owner's own AI assistant (`docs/mcp.md`).

---

*Open questions to resolve with real users: Is $29 right for the target market, or is MX$399–499 the honest anchor? Should the free tier cap dishes (15?) as a third lever? Does "Pro" need a trial at all, given the free tier is the trial?*
