# XPRIZE Submission — Teremu

> **Draft.** Every `⚠️ TODO` below is a fact only you can supply (money, users, legal identity, links). Everything else is derived from the repo and `docs/`.
>
> **⚠️ STAGE-ONE BLOCKER — read first.** Stage One is pass/fail on "reasonably applies the required APIs/SDKs." The API currently defaults to NVIDIA: `LLM_PROVIDER` is unset in `firebase/functions/.env`, and `llm.ts:34` falls back to `nvidia`. The answers below are written as though Gemini is live in production, because that is one line plus a key:
>
> ```bash
> printf 'LLM_PROVIDER=gemini\n' >> firebase/functions/.env
> ```
>
> then `firebase functions:secrets:set NVIDIA_API_KEY` with a Gemini key (the secret name is historical — see `docs/llm.md`), redeploy, and run at least one real scan so the Gemini observability dashboard has traffic to screenshot. Do this **before** submitting; the evidence upload asks for those dashboards by name.

---

# Project overview

## General info

**Project name**
Teremu

**Elevator pitch** *(200 chars max — this is 186)*
Teremu turns a phone camera into a restaurant's back office. Photograph a stack of vendor invoices; Gemini keeps your food costs, dish margins and inventory current. No data entry, ever.

---

## Project details

### Project Story

**About the project** *(1000 words max — this draft is ~930)*

```markdown
## Inspiration

An independent restaurant lives on 3–5% net margin. Food cost is the single
largest controllable line, and it moves constantly — a vendor raises salmon 8%,
nobody notices for six weeks, and a signature dish has been sold at a loss
forty times. The information needed to catch it already exists — the
stack of crumpled invoices on the desk — but the back office required to free
it (a bookkeeper, a spreadsheet habit, an enterprise inventory suite) is
exactly what an owner-operator does not have.

The tools that do solve this are priced for groups. The closest competitor
starts at 159€/month in Spain with an implementation fee and a "schedule a
call" motion. A twelve-table restaurant will not buy that, so it buys nothing
and keeps guessing.

The bet behind Teremu: a modern multimodal model reads a crumpled, coffee-
stained, badly-lit invoice well enough that the entire back office collapses
into one gesture — a photo — and at ~$0.003 of inference per document, that
back office sells for the price of two covers a month.

## What it does

Scan a stack of invoices — the camera never blocks, so fifteen photos take
about sixty seconds. Each photo runs a four-stage pipeline in the background:
**classify** (is this even a purchase document — factura or albarán?),
**extract** (vendor, date, line items, per-line ingredient category, pack
contents so "24×400 g" becomes 9.6 kg, and catalog matching so "TOM RMA 25#"
lands on your existing "Roma Tomatoes" instead of spawning a duplicate),
**validate** (deterministic arithmetic — qty × price against line totals, line
sum against the printed total), and **review** (a human approves in Triage,
side by side with the photo, warnings guiding the eye).

Approving one invoice moves the whole restaurant: ingredient prices roll,
every dish's margin recomputes from its recipe, and the theoretical pantry
fills — with unit conversion across systems (lb→kg, case→contents). Log daily
sales and the pantry depletes through those same recipes, so stock is
purchases minus sales with zero daily input; a monthly walk-through of the
walk-in trues it up.

What the owner sees is Pulse: food-cost % against the 28–35% band, a menu-
engineering matrix, spend by vendor, and alerts — *this vendor raised you 8.2%, this dish slipped under target*. A ✨
assistant answers questions over the restaurant's own data, and the context it
sees is filtered by the asker's permissions, so a scan-only runner literally
cannot ask about the money.

## How we built it

Vue 3 + Vite PWA wrapped by Capacitor (same build ships to iOS and Android),
on Firebase: Hosting, one Cloud Functions API, Firestore, Storage, Auth. One
deliberate security property — **the client holds no database credentials**.
There is no Firebase data SDK in the app; every byte flows through the
permission-checked API, and every route declares the permission it needs and
enforces it server-side against the caller's active location.

All AI goes through a single client, `firebase/functions/src/llm.ts`, speaking
the OpenAI `chat/completions` dialect — which Gemini exposes — so the provider
is configuration, not code. The three JSON-shaped calls (invoice OCR, menu
photo extraction, recipe drafting) send a JSON schema *derived from the zod
schema the reply is already parsed with*, so there is no second source of
truth to drift. The decoder enforces shape; zod enforces values.

Zod is the spine: strict parsing of untrusted bodies on the server, lenient
response validation on the client, and a `coerce`/`catch` schema absorbing
sloppy model output before it reaches the database.

## Challenges we ran into

**Model JSON is not a contract.** Gemini's OpenAI-compatibility layer silently
ignores parameters it does not support, so an unconstrained reply can arrive
with no error to detect it by. Every reply goes through `parseModelJson`, never
a bare `JSON.parse` — strict first, then a repair pass for markdown fences,
trailing commas, replies truncated by `max_tokens`, and the one that actually
bit us: an unescaped quote inside a value, `"Bandeja 12" x 8""`. Recoveries and
losses log distinctly, so the failure rate is queryable.

**Units are where invoice math dies.** A vendor bills a case; a recipe calls
for 180 g; stock is kept in kg. Extraction has to recover pack contents from
free text, and every downstream number must convert across measurement systems
without silently guessing.

**Unbounded inference cost.** Every call is capped — output `max_tokens` per
operation, a 300-name cap on the OCR catalog prompt, hard query limits on the
assistant's data snapshot — so the worst case is bounded *by the code*, not by
hope. Every call logs its exact token usage, because LLM cost distributions are
right-skewed and the mean misleads; the KPI is cost per feature at P50/P95/P99.

## Accomplishments that we're proud of

A complete product — scanner, AI pipeline, triage, margins, pantry, vendors,
assistant, team permissions, multi-location, Stripe billing — in ~14,700 lines
across 15 commits. The whole stack runs offline on a fresh clone with no
Firebase account and no API key (deterministic mock OCR), which is why the
iteration loop stayed fast. And the unit economics hold: ~$0.003 per scan and
~$1.50–3 to serve a paying restaurant against $39, an ~90% gross margin
despite AI being the core loop, which is precisely what lets us undercut the
incumbent by 3–6× per digitized document.

## What we learned

Make the provider config and the schema derived, and swapping models becomes a
one-line change instead of a migration. Cap every AI call at the code level and
your worst case is a number you can put in a spreadsheet. And the cheapest
model tier is usually enough: our workloads are classify-then-extract to a
fixed shape, guarded by arithmetic downstream — frontier reasoning is not what
reading an invoice needs.

## What's next for Teremu

POS integration (Square first, for Spain) so sales stop being manual; email
ingestion, so invoices that arrive as PDF attachments never touch a camera;
bank-feed reconciliation; and AI matching of delivery notes against month-end
invoices — the billing-error catch operators ask for most.
```

**Built with** *(25 tags)*

`gemini-api` · `google-cloud` · `firebase` · `cloud-functions` · `firestore` · `firebase-storage` · `firebase-auth` · `firebase-hosting` · `vue.js` · `vite` · `typescript` · `zod` · `pinia` · `vue-router` · `vue-i18n` · `tailwindcss` · `capacitor` · `ios` · `android` · `stripe` · `esbuild` · `node.js` · `pwa` · `view-transitions-api` · `openai-compatible-api`

### "Try it out" links

- **Live app:** ⚠️ TODO — the deployed Hosting URL (Firebase project `teremu-app`, so likely `https://teremu-app.web.app`). Verify it is live and signup works before submitting.
- **Source:** https://github.com/cto-mtm/teremu-app
- **Demo video:** ⚠️ TODO

### Project Media

**Image gallery** — ⚠️ TODO. Suggested 8 shots, 3:2, taken against seeded demo data (`npm run seed` in `firebase/`):
1. Scanner mid-batch, thumbnail of last capture visible
2. Triage side-by-side — receipt photo next to extracted line items, one row flagged amber
3. A corrected flag clearing
4. Pulse — stat cards with food-cost % in the target band
5. Menu-engineering matrix (the four quadrants)
6. Dish detail — cost breakdown by ingredient share
7. Pantry ingredient page — price-history chart
8. Assistant answering "¿qué subió de precio esta semana?"

**Video demo link** — ⚠️ TODO. 2–3 minutes, in this order: real crumpled invoice photographed → triage → approve → margin visibly moves on a dish → alert fires. Judges score "AI live in production," so film against the deployed app hitting the real Gemini API, not the emulator's mock.

---

## Additional info

**Upload a File**
⚠️ TODO — optional. Suggest attaching `docs/business-model.md` and `docs/llm.md` as the cost/pricing appendix; they are the substantiation behind the numbers in these answers.

**What date did you start this project? (MM-DD-YY)**
07-23-26 — first commit in the repository, verifiable via git history. All development occurred inside the hackathon window.

**Submitter type**
Individual. ⚠️ TODO — change to Organization if submitting under MTM.

**Organization name and Employer Identification Number**
N/A (individual submitter). ⚠️ TODO if the line above changes.

**Country of residence**
⚠️ TODO — Spain, per the product's Spanish-first localization and Spain/LATAM go-to-market. Confirm.

**Which Category are you submitting into?**
Small Business Services

**Explain how your project uses AI to impact the world, specifically in the category you have chosen.**

Independent restaurants are the archetypal small business: single-location, owner-operated, 3–5% net margin, no back office. Food cost is their largest controllable expense and the one they have the least visibility into, because the data lives on paper that arrives daily and gets filed in a shoebox.

Teremu uses Gemini's multimodal capability to eliminate the data-entry labor that has always been the gate on that visibility. A crumpled, poorly-lit vendor invoice photographed on a phone becomes structured line items — vendor, date, quantities, units, per-line categories, pack contents — in seconds, matched against the restaurant's existing ingredient catalog so the same tomato does not fragment into six records. From that single act, four back-office functions maintain themselves: purchase ledger, ingredient price history, dish-level margin costing, and theoretical inventory.

The impact mechanism is not "AI reads receipts." It is that reading receipts cheaply enough — ~$0.003 per document — collapses the price of a restaurant back office from an accountant's retainer or a 159€/month enterprise suite to roughly $39/month self-serve. That price difference is the difference between a service the bottom 90% of restaurants can buy and one they cannot. A restaurant purchasing $20,000/month in food that catches vendor price creep and reprices two underwater dishes recovers 1–2 points of food cost — $200–$400 every month, on a subscription costing a tenth of that.

Two design decisions keep the AI honest rather than merely impressive. Every extraction is arithmetically cross-checked in deterministic code (qty × price vs line total, line sum vs printed total) and flagged for human review — the model proposes, the operator disposes, and the human correction always wins. And the assistant's view of the restaurant's data is filtered by the asking member's permissions, so AI access never becomes a privilege-escalation path in a business where the owner may not want a runner reading the P&L.

**How do you measure impact?**

*Theory of change.* Independent restaurants fail on margin, not on food. They fail because the feedback loop between what they pay and what they charge is weeks long and manual. Shorten that loop to hours and make it free of labor, and operators make different decisions — renegotiating with a vendor, repricing a dish, changing a spec — while the money is still recoverable.

*Hypotheses, in the order we test them:*
1. **Extraction is good enough on real paper.** A crumpled, non-flat, mixed-language invoice extracts to reviewable line items with only spot corrections. *Measured:* per-line correction rate in Triage, share of invoices approved with zero edits, `llm_json_repaired` / `llm_json_unparseable` rates.
2. **The loop is habit-forming.** *Measured (these are the KPIs already in `docs/business-model.md` §6):* activation = first **approved** invoice within 48h of signup — approval, not scanning, because approval means they trusted the extraction; habit = ≥2 scanning sessions/week in weeks 2–4.
3. **Visibility changes behavior.** *Measured:* alerts fired vs dishes actually repriced or recipes edited within 14 days of an alert; food-cost % trend over 90 days per restaurant.
4. **Recovered margin exceeds price by ~10×.** *Measured:* per restaurant, the sum of detected vendor price increases and below-target dish margins, against subscription cost.

*Outputs* (short term): documents digitized, ingredients under price watch, dishes costed, alerts delivered. *Outcomes* (long term): food-cost percentage moved toward the 28–35% band, and hours of administrative work displaced — a stack of forty invoices is roughly two hours of manual entry and about four minutes of scanning.

*How we prove it.* Hypothesis 1 is instrumented today: `llm.ts` emits a structured `llm_usage` line per call and correction events are recorded in Triage. Hypotheses 2–4 need a beta cohort with 90 days of history and a pre/post food-cost comparison; that cohort is the immediate post-hackathon priority. We deliberately do not claim outcome data we do not yet have.

**Explain the underlying business model of your submission.**

B2B SaaS, freemium, priced per restaurant location. Full detail in `docs/business-model.md`.

*Acquisition.* Self-serve, no sales call and no implementation fee — itself the wedge against a sales-led incumbent. Free tier is the trial: 25 scans/month, unlimited menu items, full margin and pantry features. The "aha" moment (scan a crumpled invoice, watch it become line items, see a dish's true margin) takes under five minutes and requires zero sales touch. Channels at this stage are structurally low-CAC: chef-to-chef word of mouth, supplier reps and restaurant accountants as referrers — they see the food-cost pain before we do — and local operator groups. Target CAC under $60, a two-month payback.

*Value creation.* Recovered margin, quantified in the customer's own data. The pitch is arithmetic, not persuasion: *"Teremu cuesta menos que medio cubierto al mes y te avisa cuando el salmón sube 8%."*

*Retention.* Switching cost accrues automatically — costed menu, ingredient price history, vendor directory, pantry baseline. The strongest retention signal is the second seat: when an owner invites the chef, Teremu has become the restaurant's shared operating layer, which is exactly why team members are a paid gate.

*Revenue.* Subscription. **Pro $39/mo** ($390/yr — 500 scans, 5 members with granular permissions, full history, AI assistant, email alerts, CSV export). **Max $59/mo** ($590/yr — 1,500 scans, 10 members). Multi-location groups are N × Pro, one subscription per location, since every limit meters per location. Billing is built on Stripe Checkout and the customer portal; the signed webhook is the only thing that can flip a plan in production, so a dropped webhook never unlocks Pro without payment and a cancellation always re-locks.

**How will you sustain business operations in the future?**

*Resource allocation.* A solo-founder cost base: no salaries, no office, no paid acquisition. Variable cost is inference plus Firebase, and both are small and measured — ~$1.50–3/month to serve a paying restaurant, ~$0.20 for a capped free user. Firebase's free tier absorbs most infrastructure until roughly the first dozen active restaurants, so early burn is effectively inference only.

*Breakeven.* At Gemini pricing, contribution per Pro is ~$25.66 after processing fees and serving cost. A bootstrapped operation ($300/month of tooling) breaks even at roughly **275 total restaurants with 5% free→paid conversion** — reachable within one city. A $2,500/month operation needs ~2,300 restaurants. The free-rider ceiling is 128:1, implying a conversion floor under 1% — far below the 4–8% industry-normal band, so the model is not fragile to a generous free tier.

*Threats, and what absorbs each.* **Model price/availability** — Google retires Gemini versions aggressively; mitigated by the provider being config, not code, so any OpenAI-compatible endpoint is a one-line failover. **Firestore reads becoming the dominant COGS line** — the direct consequence of cheap inference; the fix (monthly rollups and caching on the two read-hungry paths, assistant context builds and triage polling) is scoped and scheduled for first real traffic. **Extraction quality on the lite model tier** — validated against `docs/ocr-samples.md`; `LLM_MODEL` bumps a tier without a code change. **A well-funded incumbent moving downmarket** — the structural answer is that our cost base lets us serve the low end profitably at a price that would cannibalize theirs.

*What changes after the hackathon.* Beta is currently uncapped so we can measure what heavy usage actually looks like before setting caps in stone. Post-hackathon: enforce the tiers, grandfather beta restaurants with three months of Pro (they become the testimonials), localize pricing into local currency, and ship POS integration.

**Which AI tools have you leveraged while working on this project?**

- **Claude Code (Claude Opus)** — the primary development environment. Substantially all of the ~14,700 lines were written in a human-directed agentic loop: architecture and product decisions made by the founder, implementation, refactoring, test authoring, and the design documents in `docs/` produced by the agent under review. The cost model in `docs/business-model.md` and the token/percentile analysis in `docs/llm.md` were derived this way.
- **Gemini API (`gemini-3.1-flash-lite`)** — in the product itself: invoice OCR, menu-photo extraction, recipe drafting, and the kitchen assistant.
- ⚠️ TODO — add any others actually used (design, video, copy).

**Explain how your business model shared above is sustainable and viable.**

*(1) Five-year goal.* Independent restaurants number roughly 350,000 in Spain and several million across LATAM. At $39–59/month per location, a serviceable obtainable market of 10,000 paying locations is ~$5M ARR — a fraction of a percent of the addressable base, which is the honest way to size a self-serve tool with no field sales.

*(2) Path to profitability.* Fixed costs are near-zero by construction, so profitability is a function of paying-restaurant count, not a funding round: ~14 Pro subscriptions cover a $300/month operation; ~115 cover $2,500/month. The P&L attached shows the hackathon period at ⚠️ TODO revenue against ⚠️ TODO expenses.

*(3) Why the model is achievable.* The margin structure is measured, not assumed. Inference COGS is ~2–7% of revenue against a ~23% average at scaling AI-B2B companies — an AI-augmented margin profile (~90% gross margin) despite AI being the core loop. That surplus is the price wedge: 3–6× cheaper per digitized document than the incumbent while still carrying SaaS-class margins.

*(4) Evidence of product-market fit.* Partial and stated as such. **In favor:** a direct competitor (Haddock, YC W22) is a real business in this exact market with Michelin-level references, validating demand — and its Mexico free tier (14 documents) validates the freemium thesis while being weaker than our 25. The pain is arithmetically verifiable rather than a matter of taste. **Not yet demonstrated:** we do not have retention or conversion data, and we do not claim it. Building the paying cohort is the immediate next milestone. ⚠️ TODO — if any pilot restaurants are live, cite their scan volume and approval rates here; that is the strongest PMF evidence available.

*(5) Resource preservation.* Billing, metering, permissions, and multi-location are already built rather than deferred, so scaling from ten to a thousand restaurants requires no re-architecture. Every AI call is capped in code, so a usage spike cannot produce a surprise invoice.

**Please explain how your business operates with AI.**

*At the product level*, AI is not a feature — it is the production process. Every unit of value Teremu delivers originates in a model call. There is no manual data-entry team, no human-in-the-loop transcription vendor, no ops staff reconciling documents. The work an accountant would bill hours for — reading a document, classifying its contents, mapping items onto a catalog, categorizing them — happens in code at $0.003 per document, and that cost structure *is* the business model. It is what allows a service historically priced at hundreds of euros a month to be sold at $39 self-serve to businesses that have never bought back-office software before.

*At the project level*, the company is operated by one person plus AI. The codebase, the technical documentation, the cost model, and the competitive analysis were produced in an agentic development loop with human direction and review. That is what let a complete multi-tenant SaaS — camera pipeline, AI extraction, margin engine, inventory, permissions, billing, bilingual i18n, native shells — reach production in weeks. There is no engineering team to fund, which is precisely why breakeven sits at ~275 restaurants instead of a Series A.

**Please explain the extent to which AI is live in production and executes key decisions.**

AI is live in the production request path — not a demo mode, not a batch job. Four decisions are made by the model in production, and each is bounded by deterministic code:

1. **Is this a purchase document at all?** Every uploaded photo is classified before extraction (`kind: receipt | other`, with confidence). A non-document is rejected with a distinct error rather than hallucinated into line items. The model makes this call; no human sees the image first.
2. **What does the document say?** Vendor, date, and every line item — name, quantity, unit, price, total — plus two decisions with real downstream money attached: the **ingredient category** per line (which drives spend analytics and pantry organization) and **pack contents** ("24×400 g" → 9.6 kg), which determines whether a case purchase converts correctly into stock.
3. **Is this line the same ingredient as one we already have?** The model matches extracted lines onto the restaurant's existing catalog ("TOM RMA 25#" → "Roma Tomatoes"). This is the decision that determines whether price history stays continuous or fragments into unusable duplicates — and therefore whether every margin number downstream is right.
4. **What is the answer to this operator's question?** The assistant answers over the restaurant's live data, with the context it receives filtered by the asking member's permissions.

*What is deliberately not delegated.* Extraction output is arithmetically cross-checked in deterministic code and surfaced for one-tap human approval; nothing touches prices, margins, or inventory until an operator approves. The model proposes; the human disposes; the correction always wins. This is a product decision, not a limitation — in a business where a wrong number silently misprices a dish for a month, an unreviewable pipeline would be worse than no pipeline.

*Revenue-side.* Model output is what the subscription buys, so the AI is directly upstream of revenue: the free tier meters model calls (25 scans/month), the paid gate is more model calls (500 and 1,500), and the assistant is a Pro-only model feature. Every call logs a structured `llm_usage` line — label, model, prompt and completion tokens — so COGS is observed per feature rather than estimated.

**Please explain which product from Google Cloud you used during the hackathon and how.**

The entire backend is Google Cloud, via Firebase:

- **Cloud Functions** — the whole API. One HTTPS function with a hand-rolled router and zod validation carries every route (invoices, ingredients, menu, pantry, revenue, vendors, members, billing, assistant), plus a Cloud Storage-triggered function that runs the OCR pipeline when a receipt lands.
- **Firestore** — every entity, namespaced `restaurants/{rid}/…` as a shared multi-tenant workspace with per-member granular permissions. All access is server-side through the Admin SDK; the client has no database credentials.
- **Cloud Storage** — receipt JPEGs at `receipts/{rid}/{invoiceId}.jpg`; the upload event is what triggers OCR.
- **Firebase Authentication** — Google sign-in; ID tokens verified with the Admin SDK on every route except `/health`.
- **Firebase Hosting** — serves the Vue SPA with a rewrite for history-mode routing.
- **Cloud Logging** — the AI cost and reliability telemetry (`llm_usage`, `llm_json_repaired`, `llm_structured_output_unsupported`) lands here; it is the source for per-feature P50/P95/P99 unit cost.
- **Secret Manager** — via Firebase Functions secrets, for the LLM and Stripe keys.
- **Firebase Emulator Suite** — the full stack runs offline on a fresh clone under a `demo-` project id, which is why development never needed a live project or a paid key.
- **Gemini API** — see below.

**If your project uses an LLM, it must use Gemini API for at least one LLM call. Please explain which LLMs are used in the project and specifically how the Gemini API is used.**

Gemini is the only model provider in production. Every AI call in the API routes through one client — `firebase/functions/src/llm.ts` — configured with `LLM_PROVIDER=gemini`, which targets Gemini's OpenAI-compatibility endpoint (`https://generativelanguage.googleapis.com/v1beta/openai/`) with **`gemini-3.1-flash-lite`** as the default model.

Four production call sites, all Gemini:

| Call site | What Gemini does | Modality | Output cap |
|---|---|---|---|
| `ocr.ts` — invoice scan | Classifies the photo as a purchase document, then extracts vendor, date, line items, per-line category, pack contents, and catalog matches | Vision + text → JSON | 2048 tokens |
| `menuscan.ts` — menu extraction | Reads a photographed menu into dishes with prices | Vision + text → JSON | 3072 tokens |
| `menuscan.ts` — recipe drafts | Drafts plausible recipes for extracted dishes against the ingredient catalog | Text → JSON | 4096 tokens |
| `assistant.ts` — kitchen assistant | Grounded Q&A over a permission-filtered snapshot of the restaurant's data | Text | 600 tokens |

The three JSON calls use Gemini's `response_format: {type: "json_schema"}` to constrain decoding, and the schema on the wire is generated from the zod schema the reply is parsed with (`z.toJSONSchema`), pruned to the keywords the compatibility layer accepts. Two fallbacks sit behind that, because "the provider honors it" is not a guarantee: a model that rejects `response_format` gets one silent retry without it, and every reply — including successful ones — passes through a tolerant parser that repairs fenced, truncated, or badly-escaped JSON and logs which happened. This matters specifically on Gemini, whose compatibility layer is officially beta and *silently ignores* unsupported parameters, so an unconstrained reply can arrive with no error attached.

Images are downscaled to ≤1600px on-device before upload — a cost control, since Gemini tokenizes images in 768×768 tiles at ~258 tokens each, putting a normal invoice at ~1.5K image tokens. Measured per-call cost: ~$0.003 per invoice scan, ~$0.003 per assistant question, ~$0.005 per full menu-wizard run.

No other LLM provider is used in production. Full configuration, pricing, and token analysis: `docs/llm.md`.

⚠️ TODO — verify `LLM_PROVIDER=gemini` is deployed and generate real traffic before submitting (see the blocker note at the top of this file).

**URL to your GitHub repo shared with testing@devpost.com and judging@hacker.fund**

https://github.com/cto-mtm/teremu-app

⚠️ TODO — the repo is private. Either add a license and make it public, or invite **testing@devpost.com** and **judging@hacker.fund** as collaborators. Also scan history for secrets before opening it up; `.secret.local` should never have been committed, but confirm.

**Upload evidence of the project running.**

⚠️ TODO — assemble these four:
1. **Google Cloud billing invoices**, monthly PDFs for the competition duration — Cloud Console → Billing → Invoice. On free tier/credits, export the zero-dollar monthly cost table instead.
2. **Gemini observability dashboard screenshots** — required, and they need real traffic to be non-empty. Run a batch of live scans against production after flipping the provider.
3. **Cloud Logging export** of `llm_usage` entries — this is the strongest single piece of evidence you have. It shows label, model (`gemini-3.1-flash-lite`), and exact token counts per production call: AI live in production, per-decision, with receipts.
4. **Screenshots** of Firestore documents produced by the pipeline (an invoice with `status: needs_review` and model-extracted line items) and of the Cloud Functions invocation graph.

**Are you using any pre-existing business resources (anything that existed before May 19, 2026)?**

No. The project began 23 July 2026 (first commit, verifiable in git history) and every line of code, document, and design decision was produced inside the hackathon window. No pre-existing employees, customer lists, audience, partnerships, or brand assets were applied.

⚠️ TODO — confirm and disclose honestly if any of these exist: an audience or mailing list you can market to, prior relationships with any restaurants you onboard, or an existing legal entity/business bank account used to collect revenue. The question is about *business* resources; general-purpose developer accounts (a Google account, a GitHub account) are not what it is asking about, but an existing customer relationship is — and unreported related-party revenue is the kind of thing that gets a submission disqualified.

**Total Revenue** (hackathon period, USD)
$0 ⚠️ TODO — confirm.

**Revenue by Month** (USD)
May: $0, June: $0, July: $0, August: $0 ⚠️ TODO — confirm.

**Explain the revenue shared above.**

Teremu generated no revenue during the hackathon period. This is a deliberate sequencing decision documented in `docs/business-model.md` §7: the beta runs uncapped and free so that real usage distributions can be measured before caps and prices are set in stone. Setting a scan cap or a price without knowing what a heavy restaurant actually does would have been guessing.

The monetization infrastructure is built and tested, not planned: Stripe Checkout for monthly and yearly intervals, the customer portal for card changes and cancellation, and a signature-verified webhook that is the only path by which a plan can change in production. Prices are set — Pro $39/mo or $390/yr, Max $59/mo or $590/yr — and the server-side enforcement they gate (a 402 on the scan cap, gated member invites, plan-windowed history queries) is already in the API. Turning revenue on is a configuration change: four live Stripe price IDs replacing the current placeholders.

⚠️ TODO — if any revenue was collected, replace this section with: price per customer, billing period covered, and number of paying customers or transactions.

**Related-Party Revenue** (USD)
$0 ⚠️ TODO — confirm. Any revenue at all from team members, family, related entities, or pre-existing relationships must be reported here even if it is also counted above.

**Total Expenses** (hackathon period, USD)
⚠️ TODO — total from the P&L. Likely near $0 if development ran on Firebase free tier and free-tier model keys; include the domain, any Google Cloud spend beyond free tier, Gemini API spend, and any Apple/Google developer account fees if paid.

**Explain the expenses above.**

⚠️ TODO — the form wants a percentage split with drivers. Template based on this project's actual shape:

- **COGS (~X%)** — Gemini API inference and Google Cloud (Firestore, Cloud Functions, Storage) for development, testing, and beta usage. Driver: invoice scans processed. Per-unit cost is measured, not estimated: ~$0.003 per scan, from the `llm_usage` telemetry.
- **Sales & marketing (0%)** — no paid acquisition was run. Acquisition is self-serve and word-of-mouth by design (see the business model above), so there was nothing to spend on.
- **R&D (~X%)** — the dominant category, and almost entirely non-cash: development was done by the founder in an AI-assisted loop, so the expense line reflects tooling and API costs rather than salaries. Driver: AI-assisted development tooling.
- **G&A (~X%)** — domain registration and any account fees. Driver: minimum viable footprint for an unincorporated solo project.

**Total Cost of Goods Sold (COGS)** (USD)
⚠️ TODO

**Please explain the expenses associated with your COGS above.**

COGS is inference plus infrastructure — there is no human labor in the delivery of the service, which is the point of the business. Gemini API calls at ~$0.003 per invoice scan, ~$0.003 per assistant question, and ~$0.005 per menu-wizard run, plus Google Cloud consumption (Firestore reads dominate, then Storage and Cloud Functions invocations) which itemizes to roughly $1/month even for a heavy restaurant. Development and testing ran largely inside Firebase's free tier and the emulator suite, which runs the entire stack offline with a deterministic mock OCR — so pre-beta iteration incurred almost no COGS by construction.

**Total marketing and customer acquisition expense** (USD)
$0

**Please explain the marketing and customer acquisition expenses you incurred during the hackathon period, if any.**

None, in either category. **(1) Marketing:** no advertising, sponsorship, or promotional spend. **(2) Sales:** no sales staff, no paid tooling, no implementation fees paid or charged. This is strategic rather than incidental — the product's acquisition thesis is that the "aha" moment (scan a crumpled invoice, see a dish's true margin) lands in under five minutes with no sales touch, which is exactly why we can undercut a sales-led incumbent that charges an implementation fee. `docs/business-model.md` §4 holds paid acquisition until organic conversion data exists, so that CAC is measured against a known conversion rate rather than bought blind.

**Additional Expenses**
⚠️ TODO — anything not captured above (domain, Apple Developer $99/yr, Google Play $25 one-time, if paid).

**Number of users acquired during the hackathon**
⚠️ TODO — count real restaurant accounts, excluding your own test accounts. Report 0 if there are none; an inflated number is a disqualification risk and judges can ask for proof of user relationships.

**Number of those users paying**
0 ⚠️ TODO — confirm.

**Share a verifiable testimonial by a customer or user available publicly via a post online.**

⚠️ TODO — this needs a real, publicly-visible post (LinkedIn, X, Instagram, a Google review) from someone who used the product, with a link. If no beta restaurant has posted, the honest answer is that none exists yet — do not manufacture one. If you have a beta operator willing, the highest-signal ask is a short post about a specific catch: *"scanned a month of invoices and found the fishmonger had raised us 8% in April."*

**Describe the level of learning you/your team derived from the project.**

Significant.

Concretely: designing an AI pipeline where every call is bounded in code rather than by prompt discipline; deriving structured-output schemas from validation schemas so shape and values never drift; treating LLM cost as a right-skewed distribution measured at percentiles rather than an average (the `llm_usage` telemetry exists because of that lesson); and discovering that the cheapest model tier is sufficient when the workload is classify-then-extract into a fixed shape guarded by arithmetic downstream. On the business side, modeling free-tier economics against a measured free-rider ceiling — and watching the whole model's fragility change when inference cost dropped an order of magnitude — turned pricing from intuition into arithmetic.

**Upload your Profit evidence (P&L)**
⚠️ TODO — fill the template at https://bit.ly/4w3DvwL, export as PDF. It must reconcile line-for-line with the revenue and expense answers above.

---

## Agentic Economy Prize

**Are you opting into the external $50K Agentic Economy Prize?**

**No.** ⚠️ TODO — confirm.

Teremu does not currently integrate Circle's Agent Stack, and no part of the product makes or receives payments autonomously; money movement is Stripe subscription billing, initiated by the customer. Opting in requires a public repo demonstrating the integration, a recorded demo of a real USDC transaction, and a wallet address with a block-explorer link — none of which exist today, and claiming otherwise would be disqualifying.

*If you want to build it:* the natural fit is already half-built. The grocery-list generator derives usage rates from sales, compares them to pantry stock, and produces a per-vendor order with quantities — it currently ends at "send by email or WhatsApp." Extending that to an agent that pays the resulting vendor invoice in USDC from a Circle wallet, within owner-set limits (per-vendor caps, a total ceiling, auto-pay only for invoices whose arithmetic validation passed clean), is a coherent product story rather than a bolt-on: the restaurant's AI already knows what to order, from whom, and at what price. Budget several days of work plus a real on-chain transaction to record.
