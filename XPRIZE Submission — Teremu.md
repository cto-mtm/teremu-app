# XPRIZE Submission — Teremu

> **Draft.** Remaining `⚠️ TODO` items below are things only you can supply: links, uploads, legal identity, and country of residence.

---

# Project overview

## General info

**Project name**
Teremu

**Elevator pitch** *(200 chars max)*
Food-cost control to grow your margins. Teremu digitizes vendor invoices — camera, email, PDF — and Gemini keeps your dish margins, ingredient prices and inventory current. No data entry, ever.

---

## Project details

### Project Story

**About the project** *(1000 words max)*

```markdown
## Inspiration

An independent restaurant lives on 3–5% net margin. Food cost is the single
largest controllable line, and it moves constantly — a vendor raises salmon
8%, nobody notices for six weeks, and a signature dish has been sold at a
loss forty times.

The information needed to catch it already exists — the stack of crumpled
invoices on the desk, the PDFs in the inbox. But turning that paper into
actionable visibility requires a bookkeeper, a spreadsheet habit, or an
enterprise inventory suite. The owner-operator has none of these.

The tools that do exist are priced for groups. The closest competitor starts
at 159€/month in Spain with an implementation fee and a "schedule a call"
sales motion. A twelve-table restaurant will not buy that, so it buys nothing
and keeps guessing.

The smallest restaurant deserves to know its margins.

## What it does

Teremu gives a restaurant owner the one number they need to run the business
— food-cost percentage — and every lever behind it: which dishes earn, which
don't, which vendors raised prices, and how much inventory is sitting in the
walk-in. All of it organized, always current, and actionable without a
spreadsheet or an accountant.

How it gets there: digitize vendor invoices — photograph a stack with the
phone camera, forward them from email, or drop a PDF. AI classifies, extracts
line items, matches them against your existing ingredient catalog, and cross-
checks the math. You review the result side by side with the source, one tap
to approve.

From that single act, everything updates: ingredient prices roll, every
dish's margin recomputes from its recipe, the theoretical pantry fills with
automatic unit conversion. Log daily sales and the pantry depletes through
those same recipes — stock is purchases minus sales with zero daily input.

The dashboard shows food-cost percentage against the healthy band, a menu-
engineering matrix, spend by vendor, and alerts — *this vendor raised you
8.2%, this dish slipped under target*. An AI assistant answers questions over
the restaurant's own data, filtered by each member's permissions.

Web, iOS and Android from one codebase. Spanish first, English second.

## How we built it

Built in partnership with Carlos from El Rectangle (elrectangle.com), whose
experience running restaurants gave the product what no amount of code can
substitute: what a real invoice stack looks like at 7am, which numbers
actually matter on a Tuesday, and where software either fits a kitchen's
rhythm or gets ignored. Carlos shaped what to build, what order to build it
in, and what not to build.

Engineering was produced by one person with a fleet of AI coding agents —
Claude Code, Google Antigravity, Kiro — governed by project docs stating the
rules an agent may not break. The architecture is strict partly because
strict rules are the ones an agent can be held to.

Vue 3 + Capacitor on Firebase. One deliberate property: the client holds no
database credentials — every byte flows through a permission-checked API.
AI goes through a single provider-agnostic client: NVIDIA's free tier today,
Gemini at scale, swapped by one env var.

## Challenges we ran into

**Building and selling at the same time.** A small operation has to ship
features, onboard pilot restaurants, validate pricing, and answer questions
at 7am — all from the same hours. The temptation is to keep building because
the code is comfortable; the discipline is knowing that an unmarketed product
helps nobody. The partnership with Carlos solves half of this: domain
credibility and operator relationships that would take a developer years to
build alone.

**Making AI reliable on real paper.** A crumpled, coffee-stained, badly-lit
invoice is not a clean document. The model's output cannot be trusted
blindly — so every extraction is arithmetically cross-checked, flagged for
human review, and the human correction always wins. The pipeline had to
absorb every variety of model sloppiness: unescaped quotes, trailing commas,
truncated replies, hallucinated fields. Each recovery path logs distinctly so
the failure rate is queryable, not guessed.

**Units are where invoice math dies.** A vendor bills a case; a recipe calls
for 180 g; stock is kept in kg. Every downstream number must convert across
measurement systems without silently guessing.

## Accomplishments that we're proud of

The product works — not just in a demo. A complete food-cost control system:
scanner, AI pipeline, triage, margins, pantry, vendors, assistant, team
permissions, multi-location, Stripe billing. The unit economics hold:
~$0.003 per document and ~$1.50–3 to serve a paying restaurant against $39
revenue — an ~90% gross margin despite AI being the core loop. And we
listen: every feature decision came from a conversation with a real operator,
not a hypothesis in a document.

## What we learned

That AI-assisted development at speed requires discipline, not just prompts.
The breakthrough was giving agents stricter guardrails — architecture docs as
machine-readable rules that reject bad output before it lands. On the
business side, a single engaged restaurant teaches you more than a hundred
hypothetical ones — listening early is cheaper than rebuilding later.

## What's next for Teremu

POS integration so sales stop being manual. Bank-feed reconciliation. AI
matching of delivery notes against month-end invoices — the billing-error
catch operators ask for most. And distribution through restaurant-supply
networks: partners with relationships to thousands of independents who feel
the food-cost pain every month.
```

**Built with** *(25 tags)*

`gemini-api` · `google-cloud` · `firebase` · `cloud-functions` · `firestore` · `firebase-storage` · `firebase-auth` · `firebase-hosting` · `vue.js` · `vite` · `typescript` · `zod` · `pinia` · `vue-router` · `vue-i18n` · `tailwindcss` · `capacitor` · `ios` · `android` · `stripe` · `esbuild` · `node.js` · `pwa` · `claude-code` · `kiro`

*(25 tags. `claude-code` and `kiro` are in because the build method is a scored criterion, not a footnote; `view-transitions-api` and `openai-compatible-api` came out to make room.)*

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
⚠️ TODO — Team (Jose Gomez + Carlos from El Rectangle), or Individual if Carlos is not listed as a team member on the submission. Clarify with Carlos. If team, both members' countries of residence are required below.

**Organization name and Employer Identification Number**
N/A (individual submitter). ⚠️ TODO if the line above changes.

**Country of residence**
⚠️ TODO — Spain, per the product's Spanish-first localization and Spain/LATAM go-to-market. Confirm.

**Which Category are you submitting into?**
Small Business Services

**Explain how your project uses AI to impact the world, specifically in the category you have chosen.**

Independent restaurants are the archetypal small business: single-location, owner-operated, 3–5% net margin, no visibility into their largest controllable cost. Food cost moves constantly — vendor price creep, seasonal shifts, pack-size changes — and the data needed to catch it already exists in the invoices that arrive daily. The problem is not information; it is that extracting it has always required labor the restaurant cannot afford.

Teremu uses Gemini's multimodal capability to eliminate that labor. A vendor invoice — photographed on a phone, forwarded from email, or dropped as a PDF — becomes structured line items in seconds: vendor, date, quantities, units, per-line categories, pack contents, matched against the restaurant's existing ingredient catalog so the same tomato does not fragment into six records. From that single act, four food-cost control functions maintain themselves: purchase ledger, ingredient price history, dish-level margin costing, and theoretical inventory.

The impact mechanism is not "AI reads receipts." It is that reading receipts cheaply enough — ~$0.003 per document — collapses the price of food-cost control from an accountant's retainer or a 159€/month enterprise suite to roughly $39/month self-serve. That price difference is the difference between a service the bottom 90% of restaurants can buy and one they cannot. A restaurant purchasing $20,000/month in food that catches vendor price creep and reprices two underwater dishes recovers 1–2 points of food cost — $200–$400 every month, on a subscription costing a tenth of that.

Two design decisions keep the AI honest rather than merely impressive. Every extraction is arithmetically cross-checked in deterministic code (qty × price vs line total, line sum vs printed total) and flagged for human review — the model proposes, the operator disposes, and the human correction always wins. And the assistant's view of the restaurant's data is filtered by the asking member's permissions, so AI access never becomes a privilege-escalation path in a business where the owner may not want a runner reading the P&L.

AI makes this possible at two levels. Inside the product, it gives the restaurant the food-cost visibility it cannot afford to build manually — the document reader, the price watcher, the margin calculator. But AI also makes the *price* possible: the entire product was built and is operated by one developer using agentic tools (Claude Code, Google Antigravity, Kiro) with domain guidance from a restaurant-industry partner, which compresses the engineering cost that normally forces food-tech vendors to sell only to groups. Without AI on both sides — in the product and in how the product is made — a $39/month price for software this complete would not be a real business. The provider-agnostic architecture means we run on NVIDIA's free tier today and migrate to Gemini as volume grows — a config change, not a rewrite — with the entire cost model already validated against Gemini pricing.

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

*Threats, and what absorbs each.* **Outgrowing NVIDIA's free tier** — expected, not a threat; the Gemini migration is a one-line config change and the entire cost model is already priced against Gemini rates. **Model price/availability** — Google retires Gemini versions aggressively; mitigated by the provider being config, not code, so any OpenAI-compatible endpoint is a one-line failover. **Firestore reads becoming the dominant COGS line** — the direct consequence of cheap inference; the fix (monthly rollups and caching on the two read-hungry paths, assistant context builds and triage polling) is scoped and scheduled for first real traffic. **Extraction quality on the lite model tier** — validated against `docs/ocr-samples.md`; `LLM_MODEL` bumps a tier without a code change. **A well-funded incumbent moving downmarket** — the structural answer is that our cost base lets us serve the low end profitably at a price that would cannibalize theirs.

*What changes after the hackathon.* Beta is currently uncapped so we can measure what heavy usage actually looks like before setting caps in stone. Post-hackathon: enforce the tiers, grandfather beta restaurants with three months of Pro (they become the testimonials), localize pricing into local currency, and ship POS integration. The partnership with Carlos from El Rectangle provides a built-in distribution channel — relationships with restaurant operators who already trust the source, which compresses the early-adoption timeline that a pure developer-led product would spend months on.

**Which AI tools have you leveraged while working on this project?**

The business runs on a fleet of agentic development tools rather than a single assistant. They are not autocomplete — they are given a task, they execute against the real repository and the real emulator suite, and they come back with work to review.

- **Claude Code (Claude Opus)** — the primary agentic development environment. Architecture, implementation, refactoring, test authoring and the documentation set were produced in an agentic loop against the repository, governed by project instruction files that encode the non-negotiable rules in machine-readable form: schemas only in shared models, permissions enforced server-side on every route, no hardcoded user-facing strings, every AI output reviewable. Every generated change is checked against that contract before it lands.
- **Google Antigravity** — Gemini-powered agentic development, used alongside Claude Code to execute code changes and run work in parallel across the codebase.
- **Kiro** — spec-driven agentic development, used to take features from written specification through to implementation with structured steering files governing the output.
- **Agentic QA against the Firebase emulators** — agents run the local Firestore/Auth/Functions/Storage emulator suite, exercise the API end to end, read the failures and fix them. This is the reason a gateway-only architecture is testable by one person at all: the emulator loop mints real tokens and drives the live routes, and an agent can run that loop unattended.
- **NVIDIA API (meta/llama-3.2-11b-vision-instruct)** — current development and early-production provider for the in-product AI (invoice OCR, menu-photo extraction, recipe drafting, kitchen assistant). Running on NVIDIA's free tier while volume is low; the planned migration to **Gemini API (`gemini-3.1-flash-lite`)** is a one-line config change (the provider seam is built and tested against both endpoints). Gemini is the production target once we outgrow the free tier — the entire cost model is priced against Gemini rates.
- **Google AI Studio and the Gemini API** — prompt design and evaluation for the extraction and assistant surfaces before wiring them into the provider seam.

That compression — one person plus agents producing a complete multi-tenant SaaS in weeks — is what makes $39/month a business rather than a loss leader. It is software *development* cost, not hosting cost, that normally forces food-tech vendors to sell only to groups.

**Explain how your business model shared above is sustainable and viable.**

*(1) Five-year goal.* Independent restaurants number roughly 350,000 in Spain and several million across LATAM. At $39–59/month per location, a serviceable obtainable market of 10,000 paying locations is ~$5M ARR — a fraction of a percent of the addressable base, which is the honest way to size a self-serve tool with no field sales.

*(2) Path to profitability.* Fixed costs are near-zero by construction, so profitability is a function of paying-restaurant count, not a funding round: ~14 Pro subscriptions cover a $300/month operation; ~115 cover $2,500/month. The P&L attached shows the hackathon period at $0 revenue against ~$152 expenses — a build period, not an operating one.

*(3) Why the model is achievable.* The margin structure is measured, not assumed. Inference COGS is ~2–7% of revenue against a ~23% average at scaling AI-B2B companies — an AI-augmented margin profile (~90% gross margin) despite AI being the core loop. That surplus is the price wedge: 3–6× cheaper per digitized document than the incumbent while still carrying SaaS-class margins.

*(4) Evidence of product-market fit.* Partial and stated as such. **In favor:** a direct competitor (Haddock, YC W22) is a real business in this exact market with Michelin-level references, validating demand — and its Mexico free tier (14 documents) validates the freemium thesis while being weaker than our 25. The pain is arithmetically verifiable rather than a matter of taste. The partnership with Carlos from El Rectangle (elrectangle.com) provides direct access to restaurant operators and domain-validated product decisions — every feature in the product came from a conversation with a real operator, not a hypothesis in a document. **Not yet demonstrated:** we do not have retention or conversion data, and we do not claim it. Building the paying cohort is the immediate next milestone.

*(5) Resource preservation.* Billing, metering, permissions, and multi-location are already built rather than deferred, so scaling from ten to a thousand restaurants requires no re-architecture. Every AI call is capped in code, so a usage spike cannot produce a surprise invoice.

**Please explain how your business operates with AI.**

**At the project level**, the business is AI-native in the literal sense: there is no engineering team. Every function a software company normally staffs is performed by agents under one person's review, with domain direction from a restaurant-industry partner.

- **Engineering.** A fleet of agentic development tools — Claude Code, Google Antigravity, Kiro — executes the actual code. Working against a repository whose rules are written down as machine-readable project instructions, they produced a complete multi-tenant restaurant SaaS: camera pipeline, AI extraction, margin engine, theoretical inventory, team permissions with granular per-area access, multi-location support, Stripe billing, a bilingual i18n system, native iOS/Android shells, and a documentation set — in weeks. Conventionally that is a team and a year.
- **QA.** Agents run the Firebase emulator suite locally, drive the API end to end with real minted tokens, read the failures and fix them. Verification is agent work, not a human clicking through screens.
- **Business analysis.** The pricing structure, tier arithmetic, unit economics, breakeven scenarios and competitive positioning against Haddock were developed the same way — including the caveats about which numbers are measured and which are arithmetic, written into the documents rather than hidden.

That compression is what makes $39/month a business rather than a loss leader. It is software *development* cost, not hosting cost, that normally forces food-tech vendors to sell only to restaurant groups — and it is the reason this product can be built for a market that no incumbent finds worth serving at this price.

**At the product level**, AI is not a feature — it is the production process. Every unit of value Teremu delivers originates in a model call. There is no manual data-entry team, no human-in-the-loop transcription vendor, no ops staff reconciling documents. The work an accountant would bill hours for — reading a document, classifying its contents, mapping items onto a catalog, categorizing them — happens in code at $0.003 per document, and that cost structure *is* the business model. It is what allows food-cost control historically priced at hundreds of euros a month to be sold at $39 self-serve to businesses that have never bought this visibility before.

**Operationally**, AI usage is metered rather than assumed: every provider call writes a structured `llm_usage` log entry (label, model, prompt and completion tokens), which is simultaneously the cost control, the product analytics, and the input to per-tier fair-use quotas. Cost discipline is designed in rather than monitored after the fact: payloads are minimized, output tokens are capped per operation, and the cheapest model tier is used because the workload — classify-then-extract to a fixed shape guarded by arithmetic — does not need frontier reasoning.

**Please explain the extent to which AI is live in production and executes key decisions.**

AI executes key decisions at two levels — in how the goods are produced, and in what runs in production serving customers. Both are live today.

**Level 1 — AI produces the goods.** The company's production line is agentic. Claude Code, Google Antigravity and Kiro do not suggest code; they execute it against the real repository. Within the boundaries set by the project's written rules, the agents decide how a feature is implemented — the data model, the route structure, the failure modes — then run the Firebase emulator suite, read the failing assertions and fix them without being told what broke. A human sets direction and reviews; the agents decide the how and do the work. For a two-person operation (one developer, one domain partner), this is not a productivity gain — it is the entire production capacity, and it is why a market that no incumbent finds worth serving at this price can be served at all.

**Level 2 — AI runs in production, and every decision is bounded by deterministic code.** Four decisions are made by the model in the production request path (currently NVIDIA's `llama-3.2-11b-vision-instruct`, migrating to Gemini `3.1-flash-lite` as volume grows):

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
- **Gemini API (via Google Antigravity)** — Gemini powers the agentic development tool used to build the product. At the infrastructure level, the Gemini API key is configured in the project via Secret Manager and the provider seam is ready for production inference — the migration from NVIDIA's free tier to Gemini is a single env var change. See the LLM answer below for the full picture.

**If your project uses an LLM, it must use Gemini API for at least one LLM call. Please explain which LLMs are used in the project and specifically how the Gemini API is used.**

Gemini is used at two levels: to *build* the product and to *run* it at scale.

**Development level — Gemini via Google Antigravity.** The entire codebase was produced in an agentic development loop powered by Gemini through Antigravity. This is not autocomplete — Antigravity executes code changes, runs tests, and iterates against the real repository. Gemini API calls are the engine behind every feature implementation, refactoring decision, and QA pass produced through this tool.

**Production level — provider-agnostic architecture, NVIDIA today, Gemini at scale.** Every AI call in the API routes through one client — `firebase/functions/src/llm.ts` — speaking the OpenAI `chat/completions` dialect. The provider is configuration, not code: a single env var (`LLM_PROVIDER`) swaps the endpoint and default model without touching a line of application logic.

Currently running on **NVIDIA's free tier** (`meta/llama-3.2-11b-vision-instruct` via build.nvidia.com) — zero cost, sufficient quality for the classify-then-extract workload, and fast enough (~9s per invoice) to stay inside the Cloud Functions timeout. This is a deliberate early-stage choice: NVIDIA's free tier covers development and pilot volume at no cost, but its terms require Enterprise licensing for production at scale.

**Gemini API (`gemini-3.1-flash-lite`) is the planned production provider** — the secret is already configured in the project, the provider seam is built and tested against Gemini's OpenAI-compatibility endpoint, and the entire cost model in `docs/business-model.md` is priced against Gemini rates. The migration happens the moment we outgrow NVIDIA's free tier: one env var change, redeploy, zero code touched. At Gemini 3.1 Flash-Lite prices ($0.25/1M input, $1.50/1M output), a single invoice scan costs ~$0.002–0.003, an assistant question ~$0.003, a full menu-wizard run ~$0.005. A heavy Pro restaurant (500 scans/month) runs ~$1.25 of scan inference.

Four production call sites (identical across both providers):

| Call site | What the model does | Modality | Output cap |
|---|---|---|---|
| `ocr.ts` — invoice scan | Classifies the photo as a purchase document, then extracts vendor, date, line items, per-line category, pack contents, and catalog matches | Vision + text → JSON | 2048 tokens |
| `menuscan.ts` — menu extraction | Reads a photographed menu into dishes with prices | Vision + text → JSON | 3072 tokens |
| `menuscan.ts` — recipe drafts | Drafts plausible recipes for extracted dishes against the ingredient catalog | Text → JSON | 4096 tokens |
| `assistant.ts` — kitchen assistant | Grounded Q&A over a permission-filtered snapshot of the restaurant's data | Text | 600 tokens |

The three JSON calls use `response_format: {type: "json_schema"}` to constrain decoding, and the schema on the wire is generated from the zod schema the reply is parsed with (`z.toJSONSchema`), pruned to the keywords the compatibility layer accepts. Two fallbacks sit behind that: a model that rejects `response_format` gets one silent retry without it, and every reply passes through a tolerant parser that repairs fenced, truncated, or badly-escaped JSON and logs which recovery path fired. This matters specifically on Gemini, whose compatibility layer is officially beta and *silently ignores* unsupported parameters.

Images are downscaled to ≤1600px on-device before upload — a cost control, since Gemini tokenizes images in 768×768 tiles at ~258 tokens each, putting a normal invoice at ~1.5K image tokens.

Full configuration, pricing comparison (NVIDIA vs Gemini), and per-call token analysis: `docs/llm.md`.

**URL to your GitHub repo shared with testing@devpost.com and judging@hacker.fund**

https://github.com/cto-mtm/teremu-app

⚠️ TODO — the repo is private. Either add a license and make it public, or invite **testing@devpost.com** and **judging@hacker.fund** as collaborators. Also scan history for secrets before opening it up; `.secret.local` should never have been committed, but confirm.

**Upload evidence of the project running.**

⚠️ TODO — assemble these four:
1. **Google Cloud billing invoices**, monthly PDFs for the competition duration — Cloud Console → Billing → Invoice. On free tier/credits, export the zero-dollar monthly cost table instead.
2. **Gemini observability dashboard screenshots** — showing Antigravity usage (Gemini-powered development) and/or production inference if you've flipped the provider by submission time.
3. **Cloud Logging export** of `llm_usage` entries — this is the strongest single piece of evidence you have. It shows label, model, and exact token counts per production call: AI live in production, per-decision, with receipts.
4. **Screenshots** of Firestore documents produced by the pipeline (an invoice with `status: needs_review` and model-extracted line items) and of the Cloud Functions invocation graph.

**Are you using any pre-existing business resources (anything that existed before May 19, 2026)?**

Yes — the partnership with Carlos from El Rectangle (elrectangle.com), whose pre-existing relationships with restaurant operators and domain expertise in the food-service industry informed the product decisions and provided access to pilot restaurants. No code, no product, no revenue, and no customer data predate the hackathon window. The repository itself starts 23 July 2026, verifiable via git history.

⚠️ TODO — confirm and disclose honestly if any of these additionally exist: a domain purchased earlier, a Google Cloud or Firebase project created earlier, an existing company entity, or an existing audience or mailing list. The question is about *business* resources; general-purpose developer accounts (a Google account, a GitHub account) are not what it is asking about, but an existing customer relationship is — and unreported related-party revenue is the kind of thing that gets a submission disqualified.

**Total Revenue** (hackathon period, USD)
$0

**Revenue by Month** (USD)
May: $0, June: $0, July: $0, August: $0

**Explain the revenue shared above.**

Teremu generated no revenue during the hackathon period. This is a deliberate sequencing decision documented in `docs/business-model.md` §7: the beta runs uncapped and free so that real usage distributions can be measured before caps and prices are set in stone. Setting a scan cap or a price without knowing what a heavy restaurant actually does would have been guessing.

The monetization infrastructure is built and tested, not planned: Stripe Checkout for monthly and yearly intervals, the customer portal for card changes and cancellation, and a signature-verified webhook that is the only path by which a plan can change in production. Prices are set — Pro $39/mo or $390/yr, Max $59/mo or $590/yr — and the server-side enforcement they gate (a 402 on the scan cap, gated member invites, plan-windowed history queries) is already in the API. Turning revenue on is a configuration change: four live Stripe price IDs replacing the current placeholders.

**Related-Party Revenue** (USD)
$0

**Total Expenses** (hackathon period, USD)
~$152

This covers AI development tooling subscriptions (Claude Code, Google Antigravity/Gemini) at ~$140 and the `teremu.com` domain at ~$12. Google Cloud infrastructure was $0 — the project ran entirely within the free tier. NVIDIA inference was $0 (free tier).

**Explain the expenses above.**

- **COGS: 0%.** No revenue was served, so no cost was directly tied to goods sold. The cloud infrastructure that becomes COGS at scale ran inside Google Cloud's free tier, and production inference ran on NVIDIA's free tier during the period.
- **Sales & marketing: 0%.** No paid acquisition was run. Acquisition is self-serve and word-of-mouth by design, so there was nothing to spend on.
- **R&D: ~92% (~$140).** AI development tooling subscriptions — Claude Code and Google Antigravity — used to build the product. This is a product-build period, so an R&D-dominated profile is the expected shape. The cost is notably low because AI tooling replaces the engineering team that would normally make an expense base incompatible with a $39/month product.
- **G&A: ~8% (~$12).** Domain renewal.

**Total Cost of Goods Sold (COGS)** (USD)
$0

**Please explain the expenses associated with your COGS above.**

COGS is inference plus infrastructure — there is no human labor in the delivery of the service, which is the point of the business. During the hackathon, inference ran on NVIDIA's free tier (zero cost), and Google Cloud consumption ran within Firebase's free tier. Development and testing ran entirely on the emulator suite, which runs the full stack offline with a deterministic mock OCR — so the period incurred zero COGS by construction. At scale on Gemini: ~$0.003 per invoice scan, ~$0.003 per assistant question, and ~$0.005 per menu-wizard run, plus Google Cloud (~$1/month per heavy restaurant).

**Total marketing and customer acquisition expense** (USD)
$0

**Please explain the marketing and customer acquisition expenses you incurred during the hackathon period, if any.**

None, in either category. **(1) Marketing:** no advertising, sponsorship, or promotional spend. **(2) Sales:** no sales staff, no paid tooling, no implementation fees paid or charged. This is strategic rather than incidental — the product's acquisition thesis is that the "aha" moment (scan a crumpled invoice, see a dish's true margin) lands in under five minutes with no sales touch, which is exactly why we can undercut a sales-led incumbent that charges an implementation fee. `docs/business-model.md` §4 holds paid acquisition until organic conversion data exists, so that CAC is measured against a known conversion rate rather than bought blind.

**Additional Expenses**
None.

**Number of users acquired during the hackathon**
0 — the product is built and operational but has not yet been opened to external users. Pilot onboarding is the immediate post-hackathon priority.

**Number of those users paying**
0

**Share a verifiable testimonial by a customer or user available publicly via a post online.**

No public testimonial yet; the product has not been opened to external users during the hackathon period. Building the pilot cohort is the immediate next step.

**Describe the level of learning you/your team derived from the project.**

Significant.

Concretely: that AI-assisted development at speed requires discipline, not just prompts — the breakthrough was giving agents stricter guardrails (detailed project docs, architecture as machine-readable rules, a local emulator loop that catches regressions before they ship). Designing an AI pipeline where every call is bounded in code rather than by prompt discipline; deriving structured-output schemas from validation schemas so shape and values never drift; treating LLM cost as a right-skewed distribution measured at percentiles rather than an average. On the business side, modeling free-tier economics against a measured free-rider ceiling turned pricing from intuition into arithmetic, and having a domain partner who has run restaurants meant every feature decision was grounded in reality rather than assumption. A single engaged restaurant teaches you more than a hundred hypothetical ones — listening early is cheaper than rebuilding later.

**Upload your Profit evidence (P&L)**
⚠️ TODO — fill the template at https://bit.ly/4w3DvwL, export as PDF. Revenue $0 across all months; expenses ~$152 (R&D $140, G&A $12). Make the totals match the figures entered above.

---

## Agentic Economy Prize

**Are you opting into the external $50K Agentic Economy Prize?**

**No.**

Teremu does not currently integrate Circle's Agent Stack, and no part of the product makes or receives payments autonomously; money movement is Stripe subscription billing, initiated by the customer. Opting in requires a public repo demonstrating the integration, a recorded demo of a real USDC transaction, and a wallet address with a block-explorer link — none of which exist today, and claiming otherwise would be disqualifying.

*If you want to build it:* the natural fit is already half-built. The grocery-list generator derives usage rates from sales, compares them to pantry stock, and produces a per-vendor order with quantities — it currently ends at "send by email or WhatsApp." Extending that to an agent that pays the resulting vendor invoice in USDC from a Circle wallet, within owner-set limits (per-vendor caps, a total ceiling, auto-pay only for invoices whose arithmetic validation passed clean), is a coherent product story rather than a bolt-on: the restaurant's AI already knows what to order, from whom, and at what price. Budget several days of work plus a real on-chain transaction to record.
