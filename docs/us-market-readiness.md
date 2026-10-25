# US market readiness

Status (2026-10-25): **Tier A deployed (commits 6662ed6, 4358859,
bbc819c); Tier B1–B4 built; B5–B8 and Tier C open.** What shipped, and
what it left:

- **A1** `app/src/lib/locale.ts` (`resolveLocale`, unit-tested) drives the
  i18n first paint; `index.html` runs the same rule inline for `<html
  lang>`, the meta/OG description and the manifest (`manifest.webmanifest`
  is English, `manifest.es.webmanifest` Spanish). Verified: an `en-US`
  browser lands in English with the English manifest. The e2e suite keeps
  Spanish because its Playwright locale is `es-ES`.
- **A2** The legal documents have **one public copy, on teremu.com**
  (the `teremu-website` repo: `/privacy`, `/terms`, English under `/en/`;
  entity MTM CYA Corp, dated 2026-09-23). The app hosts no copy: its
  `/privacy` and `/terms` routes (`LegalPage.vue`, public via `PUBLIC` in
  the router) forward there in the user's language (`src/lib/legal.ts`
  `legalUrl`, website origin overridable with `VITE_WEBSITE_URL`), and
  the login notice and Settings card link straight to the site. **Still
  to do on the website** (its own task): add the sections written after
  September — Gmail `gmail.readonly` + Google's Limited Use wording, the
  AI providers that process documents, MCP connections, Square POS
  orders, Stripe billing address / tax collection — and fix the line
  that says notification mail goes through Google Workspace (it goes
  through the shared mailer on SES).
- **A3** `checkoutSessionParams()` (pure, `test/billing-units.test.ts`):
  `automatic_tax`, `billing_address_collection: "required"`,
  `tax_id_collection`, `customer_update` for returning customers; the
  webhook stores `billingCountry`. **Stripe Tax must be enabled in the
  dashboard before this deploys**, or Checkout fails loudly.
- **A4** `@teremu/shared` `todayIn` / `monthKeyIn` / `DEFAULT_TIMEZONE`
  (unit-tested). Server: the scan meter (`plan.ts`, email ingest, the
  refund path) keys on the restaurant's month; dateless OCR documents and
  discard-to-expense use the restaurant's day; mail caps too; the
  `Europe/Madrid` / `UTC` fallbacks go through `DEFAULT_TIMEZONE`. App:
  `src/lib/dates.ts` `todayFor()` in the Pulse revenue/expense sheets and
  the Triage FX as-of. Left on UTC on purpose: `helpers/dailyCap.ts`
  (abuse valves, commented) and the window cutoffs in `domain.ts:838,978`.
- **A5** `countries/us/pack.ts` (USD, `pricesIncludeTax: false`,
  `unitSystem: "imperial"`, OCR hints for MM/DD dates, `#10` can sizes,
  `4/5 LB` pack sizes, catch weight, CS/EA/DZ, Sales Tax / Fuel Surcharge
  / CRV as non-product lines) and `countries/es/pack.ts` (EUR,
  `pricesIncludeTax: true`, `salesTaxRate: 0.10`, metric, Spanish
  document vocabulary) — Spain is no longer "the default". `CountryPack`
  and `CountryProfile` carry `pricesIncludeTax`, `salesTaxRate`,
  `unitSystem`; VE got `true` / 0.16. The app's unit dropdowns follow the
  pack until the device picks (`stores/settings.ts`). Hermetic tests per
  pack (`us.test.ts`, `es.test.ts`); boundary test still green.
- **A6** `shared/src/cost.ts`: `TaxSetting`, `NO_TAX`, `netPrice()`, and
  `marginPct(price, cost, tax)` — the ONE margin formula; the duplicates
  in `app/src/lib/domain.ts`, the assistant's `dishCost.ts` and the demo
  engine now call it. Restaurant override `pricesIncludeTax` /
  `salesTaxRate` (restaurant doc, `PUT /restaurants/:rid`, `GET /me`),
  resolved app-side in `auth.tax` and server-side in
  `assistant/code/shared.ts taxSetting()`. Settings has a "Menu price
  tax" card (owner) with the pack default shown and a reset; the dish
  editor and dish page say whether the price includes tax; the revenue
  sheet is labelled "Net sales, excl. tax" with a hint. **Release note
  for Spain:** margins on ES restaurants drop by the IVA share (an
  11 € dish with 3 € cost reads 70 %, not 72.7 %) the moment this
  deploys; the demo account (El Cuadrat) is ES and will show it.
- **A7** `domain.ts foodSpend()`: food cost % and the expenses line use
  the sum of invoice lines (what `ingredientSpend` already used), falling
  back to the printed total only when a document has no priced lines.

- **A8** `docType: "credit_memo"` in the shared vocabulary, the OCR
  prompt (abono / factura rectificativa / credit note; positive numbers)
  and Triage's type picker with its own hint. Approval SUBTRACTS the
  returned qty, never rolls a price, and never creates an ingredient for
  something never bought; a negative line on an ordinary invoice (a
  discount) is dropped by the sanitizer. In the app `invoiceSign()` makes
  every spend sum (food cost, vendor spend, ingredient spend, spend tree,
  receipt history) subtract a credit memo; credit memos never pair with
  delivery notes. Email classifier knows credit memo / packing slip /
  bill. Integration test `test/credit-memo.test.ts` (needs the emulators).
- **A9** No silent unit fallback: `shared/src/cost.ts qtyInStockUnit`
  returns null and `plateCost` marks the dish incomplete; the three app
  planners count such a line as nothing; the API's `usageFor` skips it;
  approval marks the line `unitMismatch: true`, applies no stock or
  price, and writes the invoice warning `unit_mismatch` (Triage copy in
  both languages). New container units `pack` and `can` (vocabulary,
  OCR prompt, unit dropdowns, labels, mail and demo maps).
- **A10** OCR: deterministic unit aliases (`normalizeUnit`: LB, lbs, #,
  CS, CA, CT, EA, DZ, PK, BG, BX, CN…), the number convention from the
  base currency (`looseNumber("1,250")` is 1250 for USD/CAD/GBP/MXN and
  1.250 for EUR — the schemas are built per document), the `#` rule
  qualified in the base prompt ("25#" is pounds, "#10 CAN" is a can
  size), COUNT/SIZE pack examples ("4/5 LB", "12/32 OZ", "6/#10 CAN"),
  catch-weight lines, a priced document is an invoice even when signed
  on delivery. Hermetic tests in `test/ocr-us.test.ts` and
  `test/arithmetic.test.ts`.

- **A11** Every row label and card label in `assistant/tools.ts` is a
  per-locale record `{ es, en }`. This needed a small change in the
  shared package (`../mtmcya-app-assistant`, consumed from source in
  local mode): `LocalizedLabel` + `resolveLabel()` in
  `src/contracts/meta.ts`, row labels resolved for the request's locale
  in `src/server/meta.ts clientMeta()`, card labels resolved in
  `AutoCard.vue` with the plugin locale; string labels keep working, so
  Dirumed and Pasdiu are untouched. Package unit tests and typecheck
  pass; CHANGELOG and the `assistant-tool` skill updated and re-synced
  into `.claude/skills/`. **The package change is uncommitted in its own
  repo** and must be committed there (and tagged before Teremu moves off
  local mode).

**Review pass (2026-10-25, docs/code-review.md + a correctness review)
folded in:** the effective tax setting is resolved once in
`countries/index.ts taxSettingFor()` and shipped on `GET /me` as `tax`
(the app no longer re-derives it; the assistant reads the same function
in one tenant read); credit memos subtract in the assistant's vendor
spend and are excluded from `getCounts`, from delivery-note
reconciliation and from `possible_duplicate` twins (`isTwin`, hermetic
test); a credit memo written with minus signs keeps its quantities and
prices as magnitudes; the `unit_mismatch` warning and the per-line mark
are shown on approved documents; the tax-rate field keeps two decimals of
a percent; `og:image` is absolute; the per-user and per-recipient mail
caps stay on one shared (UTC) day while the restaurant's own cap follows
its zone; the sign is applied through `signedTotal()` /
`signedLineTotal()`; `DECIMAL_POINT_CURRENCIES` lives in the shared
vocabulary. Tests added: the tax override and pack fields on `/me`
(`multi-currency.test.ts`), the zone-keyed scan month
(`paywalls.test.ts`), the netted Spanish margin and English labels in the
assistant (`assistant.test.ts`), `isTwin`, reconciliation vs credit memos
(`domain.test.ts`), the revenue sheet locator and a fresh US sign-up spec
(`e2e/tests/settings/us-signup.spec.ts`; `auth.flow.ts` accepts either
language). Docs refreshed: multi-currency, architecture (mail caps),
product (units, tax), ocr-samples and real-samples (credit memos), i18n
(first paint), testing (hermetic functions tests).

**Gate run (2026-10-25):** `npm run test:integration:exec` 42 files /
488 tests green; `npm run test:e2e` green after re-pinning the three menu
specs to the netted Spanish margins the suite's own es-ES owner now
produces (76.4 %, 17.5 %, 94.5 % — the A6 change made visible) and
loosening the manifest href check to Vite's normalised path.

**Tier B, first pass (2026-10-25):**

- **B1** `vendorKey()` in `shared/src/utils.ts` strips trailing legal
  forms (Inc., LLC, Co., Corp., S.L., S.A., GmbH…) from the normalized
  name; every vendor grouping, link, contact lookup and `isTwin` uses it
  (app `domain.ts` and pages, assistant `vendors.ts`, pipeline). Display
  names keep the suffix. Contacts saved under a pre-B1 key fold onto the
  new key when loaded (app store, assistant); a save writes the new doc,
  the old one is harmless.
- **B2** `dateOrder: "DMY" | "MDY"` on every country pack and on
  `countryProfile`; the CSV import reads dates in the restaurant's
  country order (`parseDate(raw, order)`, UI language only as the
  fallback) and decimals in the base currency's convention
  (`decimalMarkForCurrency`, from the shared `DECIMAL_POINT_CURRENCIES`).
  Typed prices still follow the UI language.
- **B3** The fake inbox has a second account, `fake-inbox-us` (`code=
  fake:fake-inbox-us`): a Sysco-style invoice, credit memo and packing
  slip, a statement and an order confirmation; the offline classifier
  knows credit memo / packing slip / bill. `email-sync.test.ts` pins the
  verdicts. Still owed from B3/B6: a rendered Sysco-style JPG receipt and
  a recorded cassette for the vision path.
- **B4** Every mail footer prints the sender's postal address
  (`MAIL_POSTAL_ADDRESS`, fallback names the entity — set it when the
  registered address is final, Tier C); the upgrade nudge (`email-quota`)
  is sent with `unsubscribeTopic` so the shared mailer adds one-click
  unsubscribe and honours the opt-out.

- **B5** `dialCode` on the country packs and `countryProfile`;
  `src/lib/phone.ts` turns a vendor phone typed without a country code
  into an international WhatsApp number using the restaurant's code
  (unit-tested), in the grocery list and the providers panel. Each
  vendor's order has a **copy order** button next to email and WhatsApp,
  for distributors that take orders on their own portal; the no-contact
  hint says so. No SMS: that would need a provider and a per-message cost.

- **B6** on the **taqueria** profile, not Harbor Bistro (its numbers are
  pinned to published videos): stock in lb / gal with recipes in oz /
  fl oz (prices converted with one rounding rule, so the +9.1 % / +7.4 %
  story holds), the produce house is "Valle Verde Produce, Inc." (the B1
  key still groups it), and a third pending document is a rendered
  **credit memo** for returned scallops (`docType` on `PendingSpec`, the
  renderer prints CREDIT MEMO / TOTAL CREDIT). No sales-tax line: US food
  for resale carries none, which the produce receipt says in a comment.
  Timezone is a seed-time flag (`npm run seed -- --tz America/Los_Angeles`),
  not profile data.

- **B7** `weekStartsOn` on the country packs (US Sunday, else Monday)
  and `countryProfile`; `domain.ts startOfWeekFor()` buckets every weekly
  series by it, applied once per profile load (`setWeekStart`, like the
  base currency). Unit-tested.

**Tier B review (docs/code-review.md, 2026-10-25) folded in:** `POST
/orders` falls back to the pre-B1 contact key, so contacts saved under a
suffixed key still take orders; `vendorKey()` takes the connector with
the suffixes ("S.A. de C.V.") but never a "de" inside a name; the
WhatsApp helper knows the US "011" exit code; the setup page reuses
`decimalMarkFor`; `test/mail-units.test.ts` pins the postal address and
the unsubscribe footer; `isTwin` has a suffix case; product.md's CSV line
matches B2; the two POS order integration tests get a 60 s budget (they
timed out under emulator load about one run in three).

Open in Tier B: **B8** the forwarding-address inbox for Microsoft 365
restaurants (an inbound-parse provider, an MX record and a webhook secret
— deferred on 2026-10-25). Everything else in Tier B is done.

Four
read-only audits (tax & money, document pipeline, locale & defaults,
commercial & legal) plus a line-by-line check of every finding that
drives the plan. This work runs **before** `docs/mcp.md`: the MCP
campaign leans on the US, and a US restaurant today gets Spanish on
first paint, metric dropdowns, a pantry that mis-stocks case-billed
lines, and no privacy policy to click.

Teremu targets Spain and the US (`docs/business-model.md`). Country
behaviour lives only in a country pack (`docs/multi-currency.md`
Principle 5, enforced by `test/boundaries.test.ts`); nothing in this plan
puts a country literal outside `firebase/functions/src/countries/`.

## What is already US-ready (verified)

- `DEFAULT_CURRENCY` is USD (`shared/src/vocab.ts:37`); the country →
  currency table maps US → USD; currency locks at first approval.
- Country and timezone are detected from the device and editable in
  Settings; US is in every picker. There is no Spain-specific validation
  of tax ids, postal codes or phones.
- The unit vocabulary has lb, oz, gal, qt, pt, floz, each, dozen, case,
  box, bunch, and mass/volume conversion between metric and imperial
  works (`shared/src/utils.ts`).
- The OCR prompt already handles "bill to" boxes, pack sizes and
  `"#" -> lb`; the offline OCR mock produces English, lb/qt, US vendors.
- English locale files are complete by construction (`const en: typeof
  es`); transactional emails exist in both languages.
- Money and dates format with Intl in the UI locale (`$1,234.56`).
- Square's net-of-tax order math is right for additive US sales tax;
  one global Square app; POS business days use the restaurant timezone.
- Functions run in us-east1, Firestore is nam5 (US). Plan prices are
  USD. The Harbor Bistro demo profile is USD/English.
- Margin = (price − cost) / price with no tax logic
  (`shared/src/cost.ts:108`) — **right for a pre-tax US menu price**,
  and therefore currently **wrong for Spain**, where the IVA-inclusive
  price inflates every margin by the tax rate. See A6.

## Findings that matter, verified

Each line was read in the source after the audits reported it.

| # | Where | What happens | Who it hurts |
|---|---|---|---|
| 1 | `app/src/i18n/index.ts:105-109` | First paint is localStorage, else `es`; `navigator.language` is never consulted | Every US visitor starts in Spanish |
| 2 | `app/src/stores/auth.ts:172-180` | A profile with no locale gets the device's current language saved — `es` unless they switched — so invites and supplier emails go out in Spanish | US owners, permanently |
| 3 | `app/src/stores/settings.ts:11-18` | Unit system is per-device localStorage, default metric, unrelated to country | US owners get kg/L dropdowns |
| 4 | `app/src` (none), `app/index.html`, `app/public` | **No privacy policy, terms, cookie or CCPA text anywhere**, either language | Everyone; Google OAuth review and app stores require a public URL |
| 5 | `firebase/functions/src/billing.ts:81-92` | Checkout sends only `customer_email`: no `automatic_tax`, no billing address, no tax-id collection | US sales tax and EU VAT both uncollected; receipts have no address |
| 6 | `plan.ts:69`, `helpers/dailyCap.ts:30`, `pipeline.ts:209`, `api.ts:567`, `mail.ts:135`; `PulsePage.vue:253,292`, `TriageDetailPage.vue:78,136` | "Today" and the month key are UTC on server and client | After ~4–5 pm Pacific a dateless invoice or an evening expense lands on tomorrow; the scan month rolls over the evening before |
| 7 | `shared/src/vocab.ts:129` | Doc types are `invoice` and `delivery_note` only; `ocr.ts:130-131,150` clamp negative amounts to 0 with `.catch(0)` | A **credit memo** is read as an invoice: qty adds stock, prices roll, amount becomes $0 |
| 8 | `pipeline.ts:514`, `pipeline.ts:629`, `shared/src/cost.ts:59` | When `convertQty` returns null (case → lb, box → kg) the **raw qty is used** | Case-billed US lines add "3" to lb stock; a 150 g recipe line subtracts 150 cases; costs silently wrong |
| 9 | `ocr.ts:54` | `"#" -> "lb"` with no qualifier | "6/#10 CAN" (a can size) becomes 10 lb or 60 lb |
| 10 | `ocr.ts:52` | Only a metric pack example ("CASE 24x400g") | "4/5 LB", "12/32 OZ", catch-weight ("1 CS 38.6 LB @ 3.29/LB") mis-parsed; CS/CT/PK/BG never named |
| 11 | `ocr.ts:37,144`, `pipeline.ts:209` | No day/month rule; an unparseable date becomes today | 03/04/2026 ambiguous; lost dates masked |
| 12 | `app/src/lib/domain.ts:247-250` | Food cost % uses `inv.total` (tax + delivery + deposits included) over revenue, while `ingredientSpend` uses line totals | Food cost % overstated in both markets |
| 13 | `models.ts:252-259`, `locales/pages/pulse.ts:128` | Manual revenue is "Total sales", never says incl./excl. tax | A US owner typing the register total overstates revenue by the sales-tax rate |
| 14 | `firebase/functions/src/assistant/tools.ts:34-152` | Every `card({ label })` is Spanish ("Proveedor", "Coste", "Fecha") | English users see Spanish table headers in assistant answers |
| 15 | `api.ts:1241`, `assistant/manifest.ts:49-53`, `pos/orders.ts:57` | Fallbacks `Europe/Madrid` / `es` / `EUR` / `UTC` when a field is missing | Edge cases only (restaurant created without prefill) |
| 16 | `app/index.html:2`, `app/public/manifest.webmanifest:4-5` | `lang="es"`, Spanish description, no meta description / OG tags | Search and install prompts in Spanish for US users |
| 17 | `firebase/functions/src/countries/` | No US pack; US rides the default pack | Nothing injects MM/DD hints, "Sales tax / Fuel surcharge / CRV" non-product names, or "Sold to / Ship to" buyer labels |
| 18 | `ocr.ts:185`, `shared/src/utils.ts:8` | Vendor keys keep legal suffixes | "Sysco Chicago, Inc." and "SYSCO" are two vendors; duplicate check misses them |
| 19 | `app/src/lib/csv.ts:82-105` | CSV day/month order follows the **UI language**, not the country | A Spanish-speaking US owner's `05/01` is read as 5 January |
| 20 | `email/classify.ts:32,87-88` | Keyword lists lack "packing slip", "credit memo", "bill" | Body-only US mail misses; credit memos unclassified |
| 21 | `mail.ts:197-207`, `mail.ts:318` | Footer has no postal address; the quota upgrade mail has no unsubscribe | CAN-SPAM for promotional mail |
| 22 | `PantryPage.vue:160-166` | Supplier ordering is a `wa.me` link with digits only; no +1 handling, no SMS/email alternative | US suppliers rarely use WhatsApp; a number without +1 breaks the link |
| 23 | `demo/profiles/harbor-bistro.ts` | US demo is metric, Honolulu timezone, no sales-tax lines | Ad screenshots and e2e don't exercise the US path |
| 24 | `app/src/lib/domain.ts:218-222` | Weeks start Monday | Cosmetic in the US |

Not a US problem, but exposed by the audit and fixed by the same change:
**Spanish margins are overstated today** because `menuItems.price` is
IVA-inclusive and `marginPct` uses it as revenue (A6). Expect Spanish
margins to drop by roughly the tax rate when it ships; it needs a
release note.

## Design decisions

- **One `countries/us/pack.ts`** with its first fields: `ocrHints`
  (dates are MM/DD/YYYY; "," groups thousands; "Sold to / Ship to" is
  the buyer; "#10" is a can size, "25#" is 25 lb; CS = case, EA = each,
  DZ = dozen; catch-weight lines bill by weight), `nonProductLineNames`
  (Sales Tax, Fuel Surcharge, Delivery Charge, CRV, Bottle Deposit),
  `pricesIncludeTax: false`.
- **`pricesIncludeTax` + `salesTaxRate?`** on `CountryPack` and
  `CountryProfile`, with an optional **restaurant override**
  (`restaurants/{rid}.pricesIncludeTax`, `.taxRate`) because US rates
  are local and some Spanish places run mixed rates. Default pack
  `false`; add an **ES pack** with `true` / 0.10 (hostelería) so Spain
  stops being "the default"; VE `true` / 0.16. The flag changes how a
  stored price is *read*: `netPrice(price, inclusive, rate)` in
  `shared/src/cost.ts`, used by `marginPct` callers in
  `app/src/lib/domain.ts:194`, `assistant/code/dishCost.ts:41`,
  `demo/engine.ts:649,691` (delete the three duplicate formulas). No
  stored value is rewritten. POS matcher untouched (compares like with
  like). Bank matching untouched (compares gross with gross).
- **Credit memos are a document type**, not a sign flag:
  `docType: "credit_memo"` in `shared/src/vocab.ts`, amounts stay
  positive in the schema, and approval **subtracts** stock and never
  rolls prices. Cheaper than letting negatives through every schema.
- **Unit conversion never falls back silently.** `convertQty` null →
  the line is flagged (`unit_mismatch`, shown in triage like `line_math`)
  and the ingredient's cost marks `incomplete`, exactly as an unknown
  ingredient does today. Add `pack` and `can` to the container units.
- **"Today" is the restaurant's day.** One helper on each side:
  `todayIn(timezone)` (functions) and `todayLocal()` (app, from the
  restaurant profile's timezone, device zone as fallback). The scan
  `monthKey` and daily caps switch to it; the three fallback
  `Europe/Madrid` / `UTC` literals go through the same helper's default.
- **Language from the browser on first paint**, persisted only when the
  user chooses or on first sign-in from the detected value; the HTML
  `lang` and manifest follow the active locale.
- **Unit system per restaurant, defaulted from the country pack**
  (`unitSystem: "imperial"` on the US pack), still overridable per
  device.
- **Legal pages live on teremu.com only**; the app's `/privacy` and
  `/terms` forward there in the user's language. One copy, one lawyer
  review, one date. The site's text must cover GDPR, CCPA/CPRA, the
  AI-provider line (MCP), Gmail data use, and the EU → US transfer basis
  (data lives in nam5).
- **Stripe Tax on**, `automatic_tax`, `billing_address_collection:
  "required"`, `tax_id_collection` for EU VAT; prices stay tax-exclusive
  everywhere ("taxes not included" already in the pricing copy).

## Plan

Tier A ships before any US marketing and before MCP starts. Tier B
ships before the MCP campaign goes live. Tier C is business work in
parallel. Each item names its tests; the gate is the usual
`npm run test:unit` + `npm run test:integration:exec`, e2e where noted.

### Tier A — launch blockers (≈ 2 weeks of sessions)

| | Item | Files | Tests |
|---|---|---|---|
| A1 | Browser-language first paint; persist on choice or first sign-in only; `<html lang>` + manifest follow locale; meta description / OG tags in both languages | `app/src/i18n/index.ts`, `stores/auth.ts`, `index.html`, `public/manifest.webmanifest` (or generate per locale) | unit: locale resolution table (`en-US`, `es-MX`, `fr` → fallback); e2e: fresh browser with `en-US` lands in English |
| A2 | `/privacy` and `/terms` forward to teremu.com in the user's language; login and Settings link there; the website gets the missing sections (separate task in `teremu-website`) | `pages/LegalPage.vue`, `lib/legal.ts`, `locales/pages/legal.ts`, router | unit: `legalUrl` per locale; website: counsel review |
| A3 | Stripe Tax: `automatic_tax`, billing address required, tax-id collection; customer country stored on the restaurant | `billing.ts`, `models.ts`, `test/billing.test.ts` | integration with the Stripe mock: session params |
| A4 | Restaurant-day "today" on server and client; `monthKey(tz)`; replace the hardcoded zone/locale/currency fallbacks with the helper | `plan.ts`, `helpers/dailyCap.ts`, `pipeline.ts`, `api.ts`, `mail.ts`, `pos/orders.ts`, `assistant/manifest.ts`; `app/src/lib/dates.ts` (new), `PulsePage.vue`, `TriageDetailPage.vue` | unit: 23:30 Pacific is still today; month boundary; integration: scan at 02:00 UTC counts in the restaurant's month |
| A5 | US country pack (hints, non-product names, `pricesIncludeTax: false`, `unitSystem: imperial`); ES pack (`true`, 0.10); `unitSystem` on `CountryProfile`; Settings unit default from it | `countries/us/pack.ts`, `countries/es/pack.ts`, `countries/types.ts`, `index.ts`, `app/src/stores/settings.ts` | `test/boundaries.test.ts` stays green; pack unit tests; e2e: US restaurant sees lb/oz first |
| A6 | `pricesIncludeTax` / `salesTaxRate` + restaurant override; `netPrice()`; one `marginPct` path; labels "Menu price (incl. tax)" / "(pre-tax)"; revenue sheet says "Net sales, excl. tax"; release note for Spain | `shared/src/cost.ts`, `app/src/lib/domain.ts`, `assistant/code/dishCost.ts`, `demo/engine.ts`, `models.ts`, `api.ts` settings PATCH, `locales/pages/{menu,pulse,settings}.ts` | unit: ES margin with inclusive price vs US pre-tax; demo-profile pinned numbers re-pinned (`docs/demo-profiles.md` warns Harbor Bistro is pinned by a test — US numbers do not change, Spanish ones would) |
| A7 | Food cost % from line totals (fallback `total` only when there are no lines) | `app/src/lib/domain.ts` | unit: invoice with tax line |
| A8 | `credit_memo` doc type end to end: prompt, schema, triage badge, approval subtracts stock and skips price roll; email classifier keyword | `shared/src/vocab.ts`, `ocr.ts`, `pipeline.ts`, `models.ts`, `app/src/lib/schemas.ts`, triage locales, `email/classify.ts` | integration: approve a credit memo → stock down, `lastUnitPrice` unchanged; unit: `toResult` on a canned credit memo |
| A9 | No silent unit fallback: `unit_mismatch` flag + `incomplete` cost; add `pack`, `can` units | `pipeline.ts:514,629`, `shared/src/cost.ts:59`, `shared/src/vocab.ts`, triage locales | unit: case line without pack size does not add raw qty; recipe g vs case marks incomplete |
| A10 | OCR prompt: qualify `#` (number-then-# is lb, `#10` is a can size), add US pack examples ("6/#10 CAN", "4/5 LB", catch-weight), name CS/CT/PK/BG/DZ, MM/DD rule via pack hint; `looseNumber("1,250")` grouping when base currency uses "." decimals | `ocr.ts`, `countries/us/pack.ts` | unit: `toResult` on Sysco-style canned JSON; `looseNumber` table; `test/arithmetic.test.ts` |
| A11 | Assistant card labels follow the principal's locale (label keys resolved per locale, or `label: { es, en }`) | `assistant/tools.ts`, `assistant/manifest.ts`; check `@mtmcya/assistant` card contract first (`assistant-tool` skill) | `test/assistant.test.ts` conformance |

### Tier B — before the MCP campaign (≈ 1 week)

| | Item | Files |
|---|---|---|
| B1 | Vendor key normalization strips Inc., LLC, Co., Corp., S.L., S.A. (key only, display name kept); duplicate check uses it | `shared/src/utils.ts`, `pipeline.ts:360`, `test/identity-paths.test.ts` |
| B2 | CSV date order from the restaurant country, not the UI language | `app/src/lib/csv.ts` + unit tests |
| B3 | Email classifier: "packing slip", "bill", "credit memo" in the lists; fake inbox gets Sysco-style USD entries (invoice PDF, credit memo, statement → reject, order confirmation → reject) | `email/classify.ts`, `email/fake.ts`, `test/email-*.test.ts` |
| B4 | CAN-SPAM: postal address in every footer; unsubscribe link on promotional mail (quota nudge, future digest) using the existing `unsubscribeTopic` | `mail.ts`, `docs/mtmcya-mailer.md` |
| B5 | Supplier ordering: E.164 with the restaurant country's prefix for WhatsApp; "send by email" and "copy as text" alternatives | `PantryPage.vue`, `ProvidersPanel.vue`, pantry locales |
| B6 | Harbor Bistro demo: imperial units, `America/Chicago`, one sales-tax line, one credit memo, Sysco-style vendor names; a rendered Sysco-style receipt JPG via `scripts/demo-receipts`; re-pin the test numbers in the same change | `demo/profiles/harbor-bistro.ts`, `docs/samples/dummy/`, `test/demo-profiles.test.ts` |
| B7 | Week start from the locale (Sunday for `en-US`) | `app/src/lib/domain.ts:218` |
| B8 | Forwarding-address inbox (`facturas+…@in.teremu.com`, already specified in `docs/email-ingestion.md`) so Microsoft 365 restaurants can use email import before an Outlook adapter exists | `email/` |

### Tier C — business and legal (parallel, no code)

- Privacy policy and Terms text (lawyer-reviewed), GDPR + CCPA/CPRA,
  subprocessor list (Google/Firebase, SES via mtmcya-mailer, Stripe,
  NVIDIA/Gemini), EU→US transfer basis. A2 hosts whatever this produces.
- Sales-tax nexus decision and Stripe Tax registration; decide the US
  price display (tax-exclusive, as today).
- A postal address for mail footers (B4).
- Google restricted-scope verification for Gmail (in flight) — the
  privacy URL from A2 is one of its inputs.
- Square: confirm the US app listing and run the first live US merchant
  (`docs/pos.md` §Verify); start Toast's partner application.
- Plaid commercial terms, only if bank feeds are a US launch feature
  (`docs/bank-feeds.md` says Tink first; the US order can flip if a US
  pilot asks for it).
- US competitor price check (MarginEdge, xtraCHEF, Restaurant365) for
  `docs/business-model.md` §10 and the US counts in
  `docs/market-sizing.md` §1b.

### Fixtures and recordings

- Canned model JSON for `toResult`: Sysco lines ("6/#10 CAN", "4/5 LB",
  "CS", catch-weight), a credit memo, "Fuel Surcharge" + "Sales Tax"
  folded into `total`, an MM/DD date.
- A real US invoice in the gitignored corpus (`docs/real-samples.md`)
  with a recorded cassette, once a US pilot restaurant exists — until
  then the rendered Sysco-style JPG from B6.
- e2e: `settings/us-signup.spec.ts` — `en-US` browser, fresh account,
  asserts English first paint, imperial dropdowns, `$` money, a scan of
  the rendered US receipt reaching triage with the right date and units.

## Sequencing

1. **A1, A2, A3, A4** first — they are independent of each other and of
   the document pipeline, and A2/A3 unblock the business items in Tier C.
2. **A5 → A6 → A7** (pack, then the flag that lives on it, then the
   food-cost fix that uses the same notion of "net").
3. **A8, A9, A10** together — one pass over `ocr.ts` and `pipeline.ts`
   with the new fixtures, verified in the emulator with the rendered US
   receipt.
4. **A11**, then Tier B, then MCP (`docs/mcp.md`) starts.

Deploy after step 1 (safe, mostly additive) and again after step 3; the
A6 release note goes out with the second deploy because Spanish margins
visibly change.

## Open questions

- Which US sales-tax rate, if any, the restaurant override should
  prefill (none: the US pack sets `pricesIncludeTax: false` and no rate
  is needed for margins; the rate matters only if we ever gross up).
- Whether the ES pack's 0.10 should be 0.10 (hostelería) or configurable
  per dish (10% food vs 21% alcohol): start with the restaurant override
  and watch whether anyone asks.
- Whether to convert existing US restaurants' `unitSystem` on deploy
  (there are none in production yet; the demo account is Spanish).
