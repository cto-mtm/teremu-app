# Demo profiles

Deterministic seed datasets for several kinds of food business, owned and
tested in this repo, so a product demo (the marketing pipeline, a sales
walkthrough, a developer poking at the app) can call one instead of
re-implementing the data model. Read this before touching anything under
`firebase/functions/src/demo/` or a receipt photo under `docs/samples/dummy/`.

Each profile is **one restaurant/location**: its vendors, ingredients, a menu
with recipes and sub-recipes, 8 weeks of approved invoices with price
history, daily sales with `itemsSold`, tagged expenses, vendor contacts, a
pantry, and 1–2 scans waiting in Triage with a real printed-receipt photo.
Every profile is English-locale, USD, plan Pro (full history window).

| Profile | Business | Hero dish | The story on Pulse |
|---|---|---|---|
| `harbor-bistro` | **The Harbor Bistro** — a seafood bistro | Seared Salmon $27 | Olive oil +12.0% (seeded). Approving the Ocean Blue receipt in Triage rolls salmon $21.40 → $23.08 (+7.9%) and the salmon slips to 71.5% vs its 72% target. Food cost (week) 29.9%. |
| `taqueria` | **Baja Norte Taquería** — Baja fish & shrimp tacos, lunch-heavy | Grilled Shrimp Taco $5.75 | Seeded creep: Gulf shrimp +9.1% and Hass avocados +7.4% (both alerts); the shrimp taco sits at 65.1% vs 66%. The pending receipts carry no new moves, so approving them leaves the alerts standing. |
| `pastry-stall` | **Sunrise Lane Pastry** — weekend-market baker | Pain au Chocolat $4.25 | Seeded: strawberries +7.4%, Fruit Tart under target. The pending dairy receipt (a real thermal-paper photo) carries the butter hike $8.20 → $8.90: approving it raises the alert (+8.5%) and tips the pain au chocolat to 81.8% vs 82%. Grocery list and production plan have rows. |

The Harbor Bistro is a port of the marketing repo's original
`product-demo/seed.mjs` (same vendors, prices, drift, recipes, sales
pattern, PRNG seed 20261004, pending receipts), so it reproduces the numbers
the published video cards were cut from. Those numbers are **pinned** by
`firebase/functions/test/demo-profiles.test.ts`: a change that would move
something on camera fails that test by name.

## Calling it

```ts
import { seedDemoProfile } from "<teremu-app>/firebase/functions/lib/demo/index.js";

const manifest = await seedDemoProfile(db, rid, {
  profile: "harbor-bistro",      // "harbor-bistro" | "taqueria" | "pastry-stall"
  now,                           // epoch ms — the demo's "today" (default Date.now())
  timezone: "Pacific/Honolulu",  // every date is relative to `now` in this zone
  locale: "en",                  // written to users/{uid}.locale (default "en")
  bucket,                        // Storage bucket for the receipt photos
  uid,                           // optional: whose locale to set (default: the owner)
  samplesDir,                    // optional: where the photos live (default docs/samples/dummy)
  log: console.log,              // optional
});
```

`db` is an Admin `Firestore` and `bucket` an Admin Storage bucket — the
module has **no side effects at import** (no `initializeApp`, no global
`getFirestore()`), so a caller outside this repo points its own Admin app
at whichever emulators it runs. Build first (`npm run build:functions` at the
repo root, or `npm run build` in `firebase/functions`); the entry is bundled
with `@teremu/shared` inlined and `firebase-admin` external.

The location (`restaurants/{rid}`) must already exist (bootstrapped by the
API on first sign-in, or by the seed CLI). The call **wipes** that location's
`ingredients`, `invoices`, `menuItems`, `revenue`, `expenses` and
`vendorContacts` plus its `receipts/{rid}/` photos, then seeds — nothing
else is touched, and other locations are never touched. The restaurant doc
is merged with the profile's name, plan `pro`, `currency: "USD"`,
`country: "US"` and `timezone`.

Pin "today" to a **Sunday** for the numbers in the table above: the app
buckets weeks Monday-start in the browser's local time, so a Sunday makes
"this week" the full Mon–Sun the profile was designed around. The seed CLI
has `--today sunday` for this; the marketing demo pins it in `demo.json`.

### From the command line

```bash
npm run seed -- --profile taqueria            # into the user's default location
npm run seed -- --all --today sunday          # one location per profile, same user
npm run seed -- --profile harbor-bistro --today sunday --out /tmp/manifests <uid>
```

Run from `firebase/` or `firebase/functions/` with the emulators up. Plain
`npm run seed` is unchanged (the small dev dataset plus a second location).
A profile **wipes and renames** the location it goes into, so when the Auth
emulator holds more than one user the uid is required (the CLI refuses and
lists them); with a single user it is optional.
With `--all`, the first profile goes into the user's default location and
each other profile into a location found by its restaurant name or created,
so re-running never piles up extras; all are reachable with the location
switcher. `--tz <zone>` and `--now <ISO>` override the clock.

### Determinism

One seeded LCG per build; the draw order is part of the contract (sales per
day per dish, then invoice lines per day per vendor per ingredient, then
stock per ingredient — see the note at the top of `engine.ts`). Every date is
relative to the injected `now` in the injected `timezone`. Doc ids are
stable: `ing_<key>`, `dish_<key>`, `inv_<date>_<vendor>`, `rev_<date>`,
`exp_NN`, `pending_<id>`, vendor contacts by normalized name. Seeding the
same profile twice with the same `now` yields the same documents and the
same manifest.

## The manifest

Plain JSON, returned by `seedDemoProfile` (and written by the CLI's
`--out`). The demo navigates by it and places circles on its values.

```jsonc
{
  "profile": "harbor-bistro",
  "restaurant": { "id": "<rid>", "name": "The Harbor Bistro", "currency": "USD", "country": "US", "timezone": "Pacific/Honolulu", "locale": "en" },
  "today": "2026-10-11",
  "heroDish": { "id": "dish_seared_salmon", "key": "seared_salmon", "name": "Seared Salmon", "price": 27, "plateCost": 7.33, "marginPct": 72.9, "targetMarginPct": 72, "underTarget": false },
  "foodCost": { "weekPct": 29.9, "weeks": [ { "weekStart": "2026-08-17", "spend": 5101.3, "revenue": 18458.4, "pct": 27.6 }, "…", { "weekStart": "2026-10-05", "spend": 6470.9, "revenue": 21671.2, "pct": 29.9 } ] },
  "alerts": {
    "price": [ { "ingredientId": "ing_oil", "ingredientKey": "oil", "vendor": "Coastal Dry Goods", "name": "Olive Oil", "direction": "up", "changePct": 12, "prev": 11.2, "last": 12.54, "unit": "L",
                 "text": "Coastal Dry Goods raised Olive Oil by 12.0%", "detail": "($11.20 → $12.54 per L)" } ],
    "margin": []
  },
  "pending": [
    { "id": "pending_seafood", "vendorName": "Ocean Blue Seafood Co.", "invoiceDate": "2023-10-26", "total": 377.5,
      "imagePath": "receipts/<rid>/pending_seafood/p1.jpg", "photo": "receipt-seafood.jpg",
      "lines": [ { "name": "Atlantic Salmon", "qty": 5.2, "unit": "kg", "unitPrice": 23.08, "total": 120 }, "…" ],
      "afterApproval": {
        "heroDish": { "…": "…", "plateCost": 7.7, "marginPct": 71.5, "targetMarginPct": 72, "underTarget": true },
        "alerts": { "price": [ "olive oil 12.0%", { "text": "Ocean Blue Seafood Co. raised Atlantic Salmon by 7.9%", "detail": "($21.40 → $23.08 per kg)" } ],
                    "margin": [ { "text": "Seared Salmon margin slipped to 71.5%", "detail": "(target 72% · plate cost $7.70)" } ] }
      } },
    { "id": "pending_produce", "…": "…" }
  ],
  "triageCount": 2,
  "ids": { "ingredients": { "salmon": "ing_salmon", "…": "…" }, "menuItems": { "seared_salmon": "dish_seared_salmon", "…": "…" },
           "vendors": { "sea": { "name": "Ocean Blue Seafood Co.", "key": "ocean blue seafood co" }, "…": "…" } },
  "counts": { "ingredients": 23, "menuItems": 10, "invoices": 56, "revenueDays": 56, "expenses": 8, "vendorContacts": 5, "pending": 2 }
}
```

- `heroDish`, `foodCost.weekPct` and `alerts` describe the **seeded** state.
  `pending[i].afterApproval` is the same block once *that* receipt is
  approved in Triage (the others still pending) — the approval is
  simulated the way `pipeline.approveInvoice` rolls prices (lines match the
  catalog by name key, re-based to the stock unit).
- `alerts[].text` / `detail` are the en Pulse strings, rendered exactly as
  the screen shows them (`{vendor} raised {name} by {pct}` and
  `({prev} → {last} per {unit})`; margin: `{name} margin slipped to {pct}`
  and `(target {t}% · plate cost {cost})`). Price alerts are the top 4 by
  magnitude, margin alerts the first 3 in menu (name) order — Pulse's
  own caps.
- `foodCost.weeks` are the app's Monday-start buckets (food invoices by
  `invoiceDate` ÷ revenue by `date`), oldest first; `weekPct` is the last.
- `triageCount` is the badge: `processing + needs_review + failed`.
- Numbers are rounded as shown on screen (plate cost 2 decimals, percentages
  1 decimal).

## Receipt photos

A pending invoice is stored with `imagePaths` + `pagesPending: false`, and
the doc is written **before** its photo is uploaded, so the Storage trigger
(which reads the doc when the photo lands and stands down for any doc
carrying `pagesPending`) never OCRs it. The nested `receipts/{rid}/{id}/p1.jpg`
path also falls outside the trigger's single-page pattern; the write order
keeps the seed safe even if that pattern or the path changes. The lines in
Triage are the seeded lines, and the photo must show the same vendor, date
and lines. Two kinds:

- **Real photos** (`docs/samples/dummy/receipt-seafood.jpg`,
  `receipt-produce.jpg` for the bistro, `receipt-thermal-dairy.jpg` for the
  pastry stall): the seeded `invoiceDate` is the date printed on the paper
  (2023), and the lines are what is printed. Approving one rolls prices and
  stock but, being outside the 8-week window, leaves the food-cost chart alone.
- **Rendered receipts** (`receipt-demo-<profile>-<vendor>.jpg`): produced by
  `npm run demo:receipts` (`scripts/demo-receipts/render.ts`) from the very
  lines the profile seeds (`pending[].rendered: true`, printed header bits in
  `pending[].print`). Deterministic and committed; the seed never renders at
  run time. **Re-run it after changing a rendered receipt's lines** — the
  test can see the lines, not the pixels.

## Adding or changing a profile

Profiles are `ProfileSpec` objects under `firebase/functions/src/demo/profiles/`
(typed against `models.ts`), registered in `profiles/index.ts` and named in
`DEMO_PROFILE_NAMES` (`engine.ts`). Rules that keep them on-camera friendly:

- Weekly food cost inside the 28–35% band; price moves ≥ 5% (Pulse's
  threshold); round, readable hero numbers.
- Recipes in natural units (g/ml/each against kg/L/dozen stock), real-looking
  quantities, USD.
- Sub-recipes are **active, sellable** menu items (the recipe editor only
  offers active dishes as sub-recipes; inactive price-0 items would show as
  margin-0 dots in the matrix). Price them as what they are — a side, a
  plain croissant, a tart shell.
- Only shipped features. Fictional vendors and businesses only.
- `purchaseHorizon`: `"last-week"` for new profiles (a delivery covers the
  next `span` days; days after today use the same weekday a week earlier).
  `"clamp-today"` is the original marketing rule the bistro port keeps.
- Add the profile to the test's expectations: the generic per-profile test
  checks the manifest against the app's own derivations; add a named test
  pinning the story (which alerts, which dish, which receipt).

Probe the numbers without emulators: `buildProfile(spec, { rid, now,
timezone, locale })` is pure and returns the docs plus the manifest.

Not included (yet): the Venezuelan arepera with a USD/VES rate per document —
it needs per-invoice currency, `fx` decisions and `base*` amounts through
`fx/convert.ts`, which the engine does not model.
