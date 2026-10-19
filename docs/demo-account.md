# The El Cuadrat demo account

A real production account kept permanently "ready to show": the real
client month (docs/real-samples.md) approved like a reviewer would, a
carta with recipes, made-up daily sales, and two fresh scans waiting in
Triage. Dates are rebuilt relative to *today* on every reset, so the
8-week dashboards are always full. This is the one place in Teremu where
moving document dates is acceptable — it is a demo; the printed dates on
the photos no longer match, by design.

The client (El Rectangle / El Cuadrat) agreed to their documents being
shown in demos. The corpus itself stays gitignored (docs/real-samples.md).

## Reset

```bash
npm run demo:reset -- --project teremu-app --email <demo owner email> --apply
```

Run it the morning of a demo (or any time the charts look stale). Without
`--apply` it is a dry run that prints the plan and what it would wipe;
`--report` prints the plan, the catalog and every dish's estimated margin
without touching Firestore at all. `--today YYYY-MM-DD` pins the clock.

Needs: the prepared corpus + `golden.json` on this machine, and ADC
(`gcloud auth application-default login`). No build step — the script
resolves `@teremu/shared` from source (`scripts/demo-account/tsconfig.json`).

**Safety.** It only ever wipes a location whose restaurant doc carries
`demoAccount: true`; mark it once with `--mark-demo` (the first run).
Every apply writes a JSON backup of the docs it wipes to
`docs/samples/real/_derived/demo-account/` (gitignored). `--emulator`
targets the local emulators instead.

## What one reset does

Always from scratch — never on top of the previous run, so nothing drifts:

1. **Wipes** the location's `invoices`, `ingredients`, `menuItems`,
   `revenue`, `expenses`, `vendorContacts` and `receipts/{rid}/` pages.
   Members, settings, plan and everything else stay. Sets EUR / ES /
   Europe/Madrid (owner-chosen).
2. **Re-seeds the month** from the *recorded* Nemotron replies (same bytes
   as `real:seed`), pages and all, and **warps the dates** onto the last
   12 weeks ending today — 90% by cumulative food spend, 10% by calendar,
   so purchases spread evenly enough for weekly charts while keeping their
   real order. If nothing landed in the current week, the latest small
   delivery (bread, fruit) is moved to today.
3. **Handles Triage** like a reviewer:
   - food invoices → `approveInvoice` with cleaned lines (supplier codes →
     kitchen names, junk/equipment lines dropped, case sizes read from the
     name, a quantity that breaks its own line math re-derived from the
     total; quantities scaled down when returned kegs inflate the lines);
   - suppliers that bill monthly against delivery notes (bread, fruit) →
     the **notes** are the purchases; their summary invoices are skipped
     (no double count);
   - other delivery notes → reconciliation records;
   - non-food bills → tagged expenses with the accountant's category;
   - unreadable / failed scans → left out;
   - **two** small (≤ €150), clean food invoices from different suppliers
     stay in Triage, dated yesterday and the day before, to approve live.
     That week's sales already count them, so approving them lifts that
     week's food cost *to* target (e.g. 19% → 27%), never past it.
4. **Kitchen**: the carta from elrectangle.com (snacks, robata sharing
   plates, desserts, natural wine) with recipes against the invoice-built
   catalog, plus the few ingredients no invoice carries
   (`scripts/demo-account/carta.ts`).
5. **Sales**: made up per day, seven days a week, dish by dish, sized
   so each week's food cost lands in 27–33% (it tracks that week's
   purchases, so sales follow deliveries). Today gets half a day of
   sales, so "this week" is never empty.
6. **Pantry and prices**: stock set to what's plausibly left on the shelf
   (at most 24 jars / bags / cases of anything); a price move over 35% is
   an OCR/unit artefact and is dropped, so Pulse only shows real moves
   (tomato, carrot, cucumber…).

Run it **the morning of the demo**: sales stop at the moment of the reset,
so a day later "today" has no sales yet.

## The story on screen

- Pulse: real supplier price moves (tomate de colgar up ~26%) and the
  **Burrata con tomate de colgar** slipping under its 70% target because
  of it.
- Triage: two scans to approve live (as of Oct 2026: a supermarket
  ticket with a bag line to delete, and a natural-wine order) — approving them moves
  last week's food cost from ~19% up to ~27%.

Changing the carta, the made-up ingredients or the renaming rules:
edit `carta.ts`, run `--report`, check the estimated margins (the `UNDER`
markers), then reset.
