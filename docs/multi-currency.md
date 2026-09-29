# Multi-currency: document, base and display currency (Venezuela first)

Status: **Phase 1 implemented (2026-09-24); Phases 2–3 are design.** Decisions settled with Luis on 2026-09-24. What exists in code today: the three-currency model and its fields, `fx/convert.ts`, the default country pack + `countryProfile` on `/me`, server-side wire shaping, the base-currency lock, device-region prefill, the Triage rate picker with `printed` and `manual` candidates, OCR `currency`/`printedFxRate` extraction, the boundary tests (a) and (d), and integration coverage (`test/multi-currency.test.ts`, `test/fx.test.ts`, `test/boundaries.test.ts`). Not yet: the rate engine, ECB, the display lens (`useMoney()`), any country pack (and with it the `zz/` fixture pack of boundary test (b) — the core suite currently runs against the default pack alone). The Phase 1 change set was written without a shell in the session: run `npm run build --workspace @teremu/shared`, both typechecks and `npm run test` before merging. First market that needs it: **Venezuela** (suppliers quote USD/EUR, the legal document is in bolívares, the restaurant thinks in USD). The design is deliberately general: any restaurant may receive a document in a currency that is not its own, and any viewer may want to *look* at the numbers in a third one.

Read this before touching any money field, any `n(x, 'currency')` call, the OCR extraction shape, the Settings currency control, or anything under `countries/`. Companion docs: `i18n.md` §5 (superseded by §Display currency once Phase 2 ships), `pos.md` / `bank-feeds.md` (they store currency codes next to amounts and defer conversion to "the restaurant's currency" — that is the base currency here), `llm.md`, `multi-location-plan.md` (reserved `timezone`/`address`).

## The model: it's timezones

| Timezones | Money |
|---|---|
| An instant is stored in UTC, once | An amount is **aggregated in the restaurant's base currency**, once |
| The event may keep its original wall-clock + offset | The invoice **keeps its printed amount, its document currency, and the frozen rate** that took it to base |
| Rendering happens in the viewer's zone, at the last moment | Rendering happens in the viewer's **display currency**, in the formatter, at the last moment |
| You never do arithmetic on wall-clock strings | You never do arithmetic on printed or displayed amounts — **only base** |
| Changing your zone changes nothing stored | Changing the display currency changes nothing stored |

Three currencies, three jobs, and each one has exactly one place in the code where it is handled:

| Currency | Lives on | Set by | Handled in |
|---|---|---|---|
| **Document** — what the paper says | `invoices/{id}.currency` (absent = base) | OCR, confirmed in Triage | `ocr.ts` extraction; Triage formats pre-approval amounts with it |
| **Base** — the restaurant's UTC | `restaurants/{rid}.currency` (exists today) | Owner, once; **immutable after the first approved invoice** | `fx/convert.ts` at approval — the only code that turns printed into base |
| **Display** — the viewer's lens | Per user/device, like the UI language (`localStorage`) | Viewer, rarely | `useMoney()` — the only code that turns base into display |

Everything between those two conversions — pantry, dishes, margins, Pulse, drilldowns, reconciliation, the assistant, POS and bank matching — is single-currency, in base, and does not know this feature exists.

## Principles

1. **The document is the fact; base amounts are derived once; display is a lens.** Printed figures are never overwritten. Base figures are computed by one pure function at approval, persisted, and copied everywhere after — never recomputed. Display conversion happens in one formatter and never touches data.
2. **Rate of the invoice date, chosen by a human, frozen at approval.** A foreign document cannot be approved without a rate. A same-currency document never sees the step.
3. **Base is immutable once used.** Like a timezone-less UTC store: once any invoice is approved, `restaurants/{rid}.currency` is locked in Settings. Changing it later is a migration (§Later), not a setting.
4. **Inputs are always explicit about their currency and never go through the lens.** Every money input (Triage line edits, sales sheet, expense sheet, dish price, labor rate) is in base — or in the document currency inside Triage — and says so in its label. The display lens is render-only. This is the "never parse a date in local time" rule.
5. **Country-specific behaviour is a pack, not a branch.** No country literal outside `countries/`; the default pack is the world as it is today; Venezuela is the first non-default pack; the next country is a folder.
6. **Rate sources are adapters behind one boundary, like `llm.ts`**, with a deterministic mock so everything works offline.

## Module boundary

```
firebase/functions/src/
  fx/                      CORE — currency-agnostic
    types.ts               RateProvider, FxQuote, pair helpers, the rate-direction convention
    convert.ts             pure: printed → base (2 dp totals, 4 dp unit prices). THE ONLY PLACE.
    engine.ts              daily job, backfill, stale carry-forward, sanity gate + pending/accept, alerts
    ecb.ts                 RateProvider for free-floating crosses (USD, EUR, GBP, MXN, CAD)
    mock.ts                deterministic RateProvider for emulators/tests
  countries/
    types.ts               CountryPack interface
    index.ts               packFor(country) → pack; unknown/absent → default
    default.ts             ECB + manual only; no hints, no extra tax lines, no cards
    ve/                    VENEZUELA — deletable as a unit
      pack.ts · bcv.ts · parallel.ts · ve.test.ts
app/src/
  lib/money.ts             useMoney(): m(x) = format(x × lens.rate, lens.currency). THE ONLY PLACE.
```

```ts
interface CountryPack {
  code: string; defaultCurrency: Currency
  rateProviders: RateProvider[]; defaultSource: FxSource; optInSources?: FxSource[]
  ocrHints?: string; nonProductLineNames?: string[]; currencyAliases?: Record<string, Currency>
  pulseCards?: PulseCardSpec[]; publishSchedule?: { cron: string; tz: string }
}
interface RateProvider {
  id: FxSource; pairs: FxPair[]
  fetchDay(date: string): Promise<FxQuote[]>   // today or history; throws → stale path
  legalLabelKey?: string                        // i18n key for a required caption
}
```

The core consults a pack in exactly seven places — Settings prefill (`defaultCurrency`), Settings toggles (`optInSources`, provider count), `GET /me` (a **serialized, data-only `countryProfile`**, so the client has no per-country code), OCR prompt assembly (`ocrHints`, `nonProductLineNames`, `currencyAliases`), Triage candidates (`GET /fx`), the daily job (union of providers for countries with ≥1 active restaurant, `publishSchedule`), Pulse (`pulseCards`). Nothing else may branch on country.

**Boundary tests**: (a) a grep test fails on any ISO country literal outside `countries/`; (b) the core suite runs against `default.ts` plus a synthetic `zz/` fixture pack; (c) `ve/ve.test.ts` owns every Venezuelan assertion; (d) a grep test fails on any `n(…, 'currency')` outside `lib/money.ts` and on any `/ fx.rate` or `* fx.rate` outside `fx/convert.ts` and `lib/money.ts`. Deleting `countries/ve/` leaves (a), (b) and (d) green — that is the definition of "does not seep".

## Data model

### Restaurant (`models.ts` `restaurantDocSchema` + `updateRestaurantSchema`; mirrored in `app/src/lib/schemas.ts` `meSchema`)

| Field | Notes |
|---|---|
| `currency` (exists) | **Base currency.** Settings copy becomes "moneda base"; locked once any invoice is approved (tooltip explains). |
| `country` | ISO 3166-1 alpha-2. Selects the pack. Prefilled from the **device region** (Capacitor `Device.getLanguageTag()`; web: `Intl` locale / `navigator.language`), shown, editable, never asked. No IP lookup. |
| `timezone` | IANA. Prefilled from the device. "Rate of the day" boundaries. |
| `fxDefaultSource`, `fxOptIns` | Owner-only; only rendered when the pack offers more than one provider / has opt-ins. Empty for the world. |

Vocabulary (`shared/src/vocab.ts`, once): add `"VES"` to `CURRENCIES`; `FX_SOURCES = ["printed","ecb","vendor","manual","bcv","parallel"]` + `fxSourceSchema`. The enum may *name* a Venezuelan source (a closed list both packages validate against); the behaviour lives only in the pack. The vocab comment on `currency` is rewritten to "base currency — see docs/multi-currency.md".

### Invoice at rest (Firestore — facts + derived-once fields)

```ts
currency?: Currency           // document currency; absent = base
printedFxRate?: number|null   // rate the document itself prints, if any (OCR)
total, lineItems[].unitPrice, lineItems[].total        // PRINTED, as today, never rewritten
fx?: { rate, source, asOf, pickedBy }                  // iff currency !== base; written at approval
baseTotal?, lineItems[].baseUnitPrice?, lineItems[].baseTotal?   // written by fx/convert.ts at approval, same batch as fx
warnings: [... "currency_assumed"]
```

`fx.rate` is **document-currency units per one base unit** (36.52 VES per USD; a printed "tasa" copies verbatim; `base = printed / rate`). `fx/types.ts` is the only place inversion may happen; the UI renders the human direction (`1 € = 1,08 $`) through `lib/money.ts`.

Single source of truth: `fx` and the `base*` fields are written **in the same batch by the same function**, derived by `fx/convert.ts` from `fx.rate` and the printed figures. Nothing anywhere recomputes a base amount from a rate afterwards — the client copies, the serializer copies, the pantry roll reads what was written. Rounding is therefore decided once (2 dp totals, 4 dp unit prices) and cents never drift between views.

### Invoice on the wire (`GET /invoices`, `GET /invoices/:id`, approve/expense responses) — **view shaping is server-side**

The API serializer (one function in `api.ts`, used by every invoice response) emits one shape regardless of currency:

```ts
{ ..., currency: "VES",                          // document currency; absent = base
  total, lineItems[].unitPrice, lineItems[].total,  // CANONICAL amounts (see rule)
  fx?: { rate, source, asOf },
  printed?: { total, lineItems: [{ unitPrice, total }] } }   // only when fx is present
```

**Rule: canonical amounts are in base whenever `fx` is present; otherwise they are in `currency`.** After approval the serializer swaps the persisted `base*` fields into the canonical slots and moves the printed figures under `printed`. Before approval there is no rate yet, so canonical = printed and `currency` tells Triage what to format with. The client's lenient `invoiceSchema` mirrors this shape with **no transform** — `domain.ts`, every store and every page keep consuming a single-currency `Invoice`, and the ~75 `.total` / `.unitPrice` read sites in the app (39 in `domain.ts`) do not change. Only two things read `printed`: the list chip and the detail rate line. Only one screen formats with `currency`: Triage (it is the only consumer of pre-approval documents — `isFoodInvoice` already filters everything else to approved).

## Conversion at approval (`pipeline.approveInvoice`)

- `approveInvoiceSchema` gains `currency` and `fx`; the server reads base from the restaurant doc (never from the client) and **requires `fx` iff `currency !== base` and the document carries any priced line**. `fx` on a same-currency document is rejected.
- `fx/convert.ts` produces the `base*` fields; `contentTerms()` and the pantry price roll receive base numbers, so `lastUnitPrice`, `theoreticalQty`, dishes and margins are base with **zero changes** to that code.
- **Delivery notes**: a note in a foreign currency with priced lines goes through the same picker and gets the same `fx`/`base*` fields (it still has no price roll — reconciliation-only, as today). A note without prices needs no rate; `realtimeSpend` already values it from base `lastUnitPrice`. Reconciliation therefore always compares base to base.
- `approveAsExpense` derives the expense `amount` from the base total and copies `fx` for the record. `reprocess` clears `fx` and `base*`.
- Vendor learning: approval writes `restaurants/{rid}/vendorFx/{vendorKey} = { source, lastRate, lastAsOf }` (deterministic, no LLM) so the next document from that vendor preselects the same source.

## Triage

The header of `TriageDetailPage.vue` gains a currency control next to the doc-type toggle, rendered from `countryProfile` data — the component has no country knowledge.

- Pre-approval amounts (list rows, header total, line edits) are formatted **with the document currency**: `n(x, { key: 'currency', currency })` via a Triage-local helper. This is the one screen where money is not base, and its inputs are labelled with the document currency's symbol (Principle 4). Fixes the "bolívar total with a dollar sign" gap.
- `currency === base` → only the base chip (tap to change if OCR mis-read).
- Otherwise the **rate picker**, candidates for `invoiceDate` ranked by the core: `printed` when present (preselected — it is what the vendor charged) → the pack's providers in order, opt-ins filtered by `fxOptIns` → `vendor` (last source this vendor used) → `manual`. Preselection when nothing is printed: vendor's last source, else `fxDefaultSource`, else the pack's default. For the default pack this collapses to ECB + manual — what a Spanish restaurant scanning one USD import invoice needs. Candidates are prefetched when the document opens (`GET /fx?date=&pairs=`), so the picker never waits.
- Totals update live with base under each printed figure. Approve sends `currency` + `fx`; the server recomputes everything (client preview numbers are never persisted).

## Display currency (the lens)

Today `setCurrency(base)` re-points every `n(x, 'currency')` at the base symbol. The lens generalises that in one place:

- `app/src/lib/money.ts` exports `useMoney()` → `m(x)` = `n(x × lens.rate, { key: 'currency', currency: lens.currency })`, plus `moneySymbol` (replaces `currencySymbol` for labels). When `lens.currency === base`, `rate = 1` and `m` is exactly today's `n(x, 'currency')`.
- **One mechanical sweep** replaces the ~48 `n(…, 'currency')` call sites across 13 files with `m(…)`; boundary test (d) keeps it that way. Inputs keep using `moneySymbol` **of the base** in their labels and never go through `m` (Principle 4).
- The lens is a **viewer preference**, stored like the UI language (`localStorage['teremu-display-currency']`), because base belongs to the restaurant and the lens belongs to the person looking — an owner in Madrid can read a Caracas restaurant in EUR without changing anything for the team on site. Chooser lives next to the language switcher; hidden until Phase 2 ships.
- The lens rate is **the latest known base→display rate** from `fxRates` (fetched once per session, `GET /fx?pairs=`), and the app shows a persistent, unobtrusive badge while a lens is active: "≈ EUR · tasa de hoy 0,92". Historical charts under a lens are restated at one rate — a lens, not restated history, exactly like reading old UTC timestamps in your zone. This is also why the lens is never used for anything but rendering.
- Same-base viewers pay nothing: no fetch, no badge, `rate = 1`.

## Pulse and everything downstream — untouched

`weeklySeries`, `vendorWeeklySpend`, `ingredientSpend`, `foodCostSeries`, `realtimeSpend`, `priceHistory`, the spend tree, `pantryValue`, `plateCost`, menu engineering: they sum canonical (base) amounts and render through `m()`. Not one line of `domain.ts` changes.

Two behaviours are worth naming:

- **Price alerts on bolívar-priced suppliers**: a stable Bs price under a moving rate shows as a rising USD price. That is the true cost and what the owner pays, so the alert stays — but the alert row (page component, not `domain.ts`) adds a caption when the underlying invoices carry `printed`: "precio en Bs 120 → 120 · tasa 36,5 → 38,1", so nobody blames the vendor for the central bank.
- **Revenue is entered in base (v1).** The sales sheet, CSV import and food-cost % assume base; a Venezuelan owner enters USD sales, which is how most already think. A Bs→USD helper on the sales sheet (today's official rate, one tap) is a Phase 3 pack card; revenue with its own currency and rate is the POS-in-VES item (§Later).

## OCR

Core prompt gains two country-agnostic fields — `"currency"` (ISO code of the currency the LINE prices are printed in, or null) and `"printedFxRate"` (the rate the document itself prints, else null) — and one rule: report every amount in the line currency; if the grand total is in another currency alongside a rate, copy the rate and report `total` in the line currency. The pack contributes `ocrHints` (VE: Bs/Bs.S/Bs.D variants, "Tasa BCV"), `nonProductLineNames` (VE: IGTF, the 3 % foreign-currency payment tax, folded into `total` by the existing tax rule) and `currencyAliases` (applied in `sanitize()`). The restaurant's base currency is passed as a hint line like the buyer name. `ocrResponseSchema`: `currency: currencySchema.nullable().catch(null)`, `printedFxRate: z.coerce.number().positive().nullable().catch(null)`. Null currency → base + `currency_assumed` warning; Triage highlights the header for a one-tap confirm.

## Rate engine (core)

- **Storage** `fxRates/{YYYY-MM-DD}` (top level; rates are not tenant data; read only through the API): `{ "VES_USD": { bcv: 36.52, parallel: 40.10 }, "EUR_USD": { ecb: 0.9259 }, fetchedAt, via?: { "VES_USD.bcv": "llm" }, stale?: {…}, pending?: { "VES_USD.bcv": { value, reason, fetchedAt } } }`.
- **Daily job** (`onSchedule` v2, us-east1): ECB for everyone; each pack's providers only when ≥1 active restaurant has that country, at the pack's `publishSchedule` plus a 12:00 UTC retry.
- **Sanity gate** (provider-agnostic): band vs the last stored value (default ±15 %, config), cross-consistency vs ECB where the pair allows it (±3 %), date not older than the last stored day. **A rejected value is not lost**: it lands in `pending` with the reason, the pair is marked stale, and the ops alert email carries an **accept link** (`POST /admin/fx/accept`, admin-only) that promotes it in one click — because Venezuela has had legitimate single-day moves beyond any band, and a stale feed must be a one-click fix, not a debugging session. Triage's manual candidate keeps users unblocked meanwhile.
- **Missing day** → carry forward with `stale` ("tasa del vie 12 sep"). Two consecutive stale days on a source → alert. Any day a provider's AI fallback ran → alert.
- **Backfill** `GET /fx?date=&pairs=`: missing pair → provider `fetchDay(date)` (history) → gate → write → return. The daily job is a warm cache, not a dependency.
- `fx/mock.ts`: deterministic per date, any pair.

## Venezuela pack (`countries/ve/`)

`defaultCurrency: "USD"`, `defaultSource: "bcv"`, `optInSources: ["parallel"]`, aliases for every `Bs*` spelling → `VES`, `nonProductLineNames: ["IGTF"]`, `pulseCards: [tasaBcvHoy]`, `publishSchedule` after BCV's publication in `America/Caracas` (BCV posts the **next** business day's rate the afternoon before — the "Fecha Valor" — so the doc is keyed by that date). `parallel.ts`: market reference via a community mirror, labelled through `legalLabelKey` ("referencia paralelo"), never preselected unless the owner chose it, never shown unless opted in.

### `bcv.ts` — deterministic parse first, AI as the fallback reader

Luis's ask: a function that checks `https://www.bcv.org.ve/estadisticas/tipo-cambio-de-referencia-smc` every morning and lets AI read the rate. Yes — with the AI in the fallback seat, because this number multiplies into every cost in a Venezuelan restaurant and an LLM misreading `36,5234` as `365,234` must never reach `fxRates` unchallenged.

From prior knowledge (**not re-verified — the page could not be fetched in the design session**; §Verify): the **homepage** renders the day's official rates server-side (historically `div#dolar`, `div#euro`, each with a `<strong>` value in Venezuelan formatting `36,52340000` and a "Fecha Valor" date) — the cheapest read; the **SMC statistics page** is the history (a Drupal listing of per-period `.xls` files) — the backfill source. Quirks: a TLS chain that has repeatedly failed default trust stores (pin the chain or allowlist the host explicitly — never a blanket `rejectUnauthorized: false`), slow, intermittently unreachable from outside Venezuela.

`fetchDay`: (1) fetch homepage (today) or SMC page + `.xls` (history), 20 s timeout, one retry; (2) deterministic parse — free and exact; (3) **only if (2) fails** (layout changed): strip to text, one call through `llm.ts` with a structured schema `{ fechaValor, usd, eur, confidence }`, cheap model, a few thousand tokens; (4) return quotes tagged `via: "llm"` — the core gate decides whether anything is written, and the alert tells us the parser needs fixing.

## Settings

Country (prefilled, select), base currency (locked after the first approved invoice — tooltip), timezone (prefilled), and — only when `countryProfile` says so — default rate source radio and opt-in toggles with their legal captions. Owner-only, one `PUT /restaurants/:rid`. The display-currency chooser is **not** here: it sits with the language switcher because it is the viewer's, not the restaurant's. Strings in a new `fx` locale module (`es` first, `en` mirrored); packs contribute i18n *keys*, never strings. VES formatting is what `Intl` gives for `es-VE`; `parseAmount()` already reads both separator styles.

## Dev & testing

- Boundary tests (a)–(d) above.
- Core: `fx/convert.ts` math and rounding; same-currency documents get no `fx`/`base*`; approve rejects a foreign priced document without `fx`, `fx` on a same-currency one, and accepts a foreign unpriced delivery note without `fx`; serializer canonical/printed swap; `sanitize()` defaulting + `currency_assumed`; sanity gate bands, `pending` + accept promotion, stale carry-forward, two-day alert; vendor-source learning; backfill writes once; pipeline rolls `lastUnitPrice` in base; `useMoney()` with `rate = 1` equals today's output byte-for-byte (snapshot).
- VE pack: alias mapping, IGTF folding, BCV parser against saved HTML fixtures (current + deliberately broken to exercise the LLM fallback via a replay cassette), `via: "llm"` tagging, Fecha-Valor keying.
- OCR: the real corpus (`docs/real-samples.md`) has no Venezuelan documents; Phase 3 needs real VE invoices (USD-priced with Tasa BCV, pure Bs, EUR import) recorded as cassettes.
- E2E (`e2e/README.md`): one spec that **sets the seed restaurant's country to VE**, scans the mock foreign document (the mock OCR emits one only when the active pack has aliases), sees the picker, picks the first provider, approves, sees the base total and the chip; one spec that switches the display lens and checks the badge and a converted total.
- Seed: one approved foreign-currency invoice with `fx` (seed restaurant stays on the default pack).

## Phased delivery — data before infrastructure

1. **Phase 1 — model + manual rates + OCR fields.** Vocab; restaurant `country`/`timezone` + device-region prefill + base-currency lock; invoice fields; `fx/convert.ts`; serializer + client schema; approve schema incl. delivery-note rule; pipeline conversion; Triage document-currency formatting + rate picker with **`printed` and `manual` only**; OCR `currency`/`printedFxRate` + `currency_assumed`; list chip + detail rate line; `countries/{types,index,default}.ts` + `countryProfile`; boundary tests (a), (b), (c), and (d) for rate math; `i18n.md` §5 rewrite. **Usable in Venezuela on day one** — most documents there are USD-priced with the BCV rate printed on them, so the printed candidate covers the majority — and usable anywhere a stray foreign invoice shows up.
2. **Phase 2 — engine + ECB + lens.** `fx/{types,engine,ecb,mock}.ts`, `fxRates`, daily job, `GET /fx` + backfill, gate with `pending`/accept, `lib/money.ts` + the `n(…, 'currency')` sweep + test (d), display-currency chooser and badge. Still no Venezuelan code. **Trigger: pilot telemetry** — the share of documents that arrive without a printed rate, or a viewer asking for a second currency.
3. **Phase 3 — Venezuela pack.** `countries/ve/` (pack, `bcv.ts` with LLM fallback, `parallel.ts`, Pulse rate card, sales-sheet Bs→USD helper, tests), pack hints in OCR, vendor learning, VE cassettes.
4. **Later** — base-currency migration (re-rate every approved invoice with its own frozen rate: because printed figures and `fx` are kept, this is a batch job, not a data-loss event); re-rate a single invoice after approval (recompute `base*`, re-roll `lastUnitPrice` when it is the ingredient's latest); manual expenses in a foreign currency; revenue with its own currency (POS in VES — `pos.md` reuses `fxRates` and the convention); bank-feed transactions in VES; the second country pack.

## Gap → resolution map

| Gap | Resolution |
|---|---|
| Three currencies muddled together | Document / base / display, each with one owner field and one code location; timezone table above is the contract |
| Venezuela logic leaking into the core | `CountryPack` + `countries/<cc>/`; seven enumerated call sites; grep test; core suite green with the VE folder deleted |
| Every future country needing a refactor | New folder, same interface |
| Today amounts are display-only, never converted | Base = aggregation truth; printed kept verbatim; conversion once at approval |
| Which rate: scan day or invoice day | Invoice date, frozen at approval, stored with source and picker |
| Venezuela has several rates | Pack providers ranked: printed → official → parallel (opt-in) → vendor's last → manual |
| Restaurant location unknown | Device region → `country`/`timezone`, shown, editable; no IP lookup |
| OCR doesn't read currency | Two core fields; pack hints; null → base + `currency_assumed` |
| **Triage shows a Bs total with a $ sign** | Triage formats with the document currency; its inputs are labelled with it; the only non-base screen |
| **Delivery notes in a foreign currency** | Priced notes take the same picker and `fx`; unpriced ones need none; reconciliation compares base to base |
| **Two sources of truth for base amounts** | `fx` and `base*` written in one batch by `fx/convert.ts`; everyone else copies; test (d) forbids rate math elsewhere |
| **Base-currency lock too narrow** | Locked after *any* approved invoice; changing base is a Later migration made cheap by the kept printed figures |
| **Sanity gate blocks a real devaluation** | Rejected value held in `pending`; one-click accept from the alert email; manual candidate keeps Triage unblocked |
| **Price alerts fire on rate moves** | Alert stays (true cost) with a printed-price + rate caption from the page component, not `domain.ts` |
| **Dashboard in a different currency** | Display lens in `useMoney()`, viewer preference, latest rate, badge; render-only, never inputs, never data |
| Pulse / charts / drilldowns needing the rate | Never: serializer emits base as canonical; `domain.ts` unchanged; lens is the formatter |
| An AI misreads the official rate | Parse-first, LLM only on layout change, core gate before any write, alert on every AI-path day |
| Revenue entered in bolívares | v1 base; Phase 3 sales-sheet helper; revenue currency is the POS-in-VES item |
| Rates unavailable on weekends / source down | Carry-forward with `stale`, backfill, two-day alert |
| **Picker exercised only under the VE pack** | E2E sets the seed restaurant to VE; core tests use a fixture pack |
| Offline dev | `fx/mock.ts` + mock OCR emitting a foreign document under any pack with aliases |
| Spain/Mexico regressions | Default pack; same-currency documents write no new fields and render no new UI; `useMoney()` at `rate = 1` is byte-identical to today (snapshot test) |

## Verify before Phase 2/3

1. **BCV source** (Phase 3): fetch `bcv.org.ve` and the SMC statistics URL from a Cloud Functions IP (us-east1) — reachability from outside Venezuela, TLS chain, the homepage rate block's current selectors and number format, whether the SMC page still links per-period `.xls` files and their layout, the "Fecha Valor" convention and publication hour, robots/terms. Which mirrors (dolarapi.com, pydolarvenezuela) are maintained, for the cross-check. None verified in the design session (no network).
2. **Parallel rate** (Phase 3): legal posture of showing a parallel reference in a Venezuelan business tool (the Ley de Ilícitos Cambiarios was repealed in 2018 — confirm nothing newer) and which reference the market uses in 2026.
3. **Frankfurter / ECB** (Phase 2): availability and history depth; whether MXN/CAD/GBP crosses need a second source.
4. **`Intl` VES formatting** on the WebView versions Capacitor ships to.
5. **Capacitor `Device.getLanguageTag()`** region fidelity on iOS and Android (fall back to `Intl` locale, then `DEFAULT_CURRENCY`).
6. **Real VE documents** for the OCR cassettes — needs the pilot restaurant.
7. **Pilot telemetry** (gates Phase 2): share of Venezuelan documents without a printed rate.
