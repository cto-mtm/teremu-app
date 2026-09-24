# Teremu — Market Sizing

**Date:** 2026-09-21 · **Status:** draft · **Companion:** `docs/business-model.md` (pricing, unit economics, Haddock)

> ⚠️ **Sourcing status.** Written without web access. Every count below is an order-of-magnitude figure from general knowledge, tagged with a confidence level and the primary source to verify it against. Do not quote a number marked *low* or *medium* in a pitch until it has been checked.

## Bottom line (pitch version)

Mexico and Spain together have close to **a million food-service establishments**, and the vast majority are independents with no back office. Filtering to the ones that buy enough food to feel price creep leaves **~120–160k restaurants**, a **~$55–75M/yr** serviceable market at our price. Teremu needs **~1% of that (1,200–1,600 locations)** to reach **~$560–750k ARR** at ~90% gross margin. Haddock, a YC-backed competitor, already charges 3–6× our price in the same markets, which tells us restaurants pay for this.

## 1. The count

| Segment | Establishments | Confidence | Verify against |
|---|---|---|---|
| Mexico, food & beverage prep (sector 722) | ~600–700k | medium | INEGI *Censos Económicos* / DENUE; CANIRAC |
| Mexico, share that are micro businesses | ~90%+ | medium | CANIRAC; INEGI size strata |
| Spain, restaurants | ~70–80k | medium | Hostelería de España *Anuario*; INE DIRCE |
| Spain, bars & cafés | ~170–180k | medium | same |
| **Mexico + Spain total** | **~950k** | medium | — |

**Addressable ≠ total.** A street *taquería* with no invoices isn't a customer. Teremu's buyer is a full-service independent buying enough from vendors (roughly **$5k+/mo of food**) that 1–2 points of food cost is real money. Assumptions used below:
- **Mexico:** ~10–15% of establishments fit → **~60–100k**
- **Spain:** most independent restaurants fit, plus some high-volume bars → **~60k**

Chains are excluded on purpose. They have procurement departments and are Haddock's natural market (their "Group from 700€" tier).

## 2. TAM / SAM / SOM

Price basis: Pro **$39/mo ≈ $468/yr** per location (`docs/business-model.md` §3). Mexico will likely launch at a localized price (e.g. MX$499 ≈ $27), which lowers Mexican values by ~30%. SAM is shown as a range to absorb that.

| Layer | Definition | Locations | Annual value |
|---|---|---|---|
| **TAM** | Every food-service establishment, Mexico + Spain | ~950k | **~$440M/yr** (ceiling; includes micros) |
| **SAM** | Independents with meaningful vendor purchasing | ~120–160k | **~$55–75M/yr** |
| **SOM** | ~1% of SAM in 3–5 years | ~1,200–1,600 paying | **~$560–750k ARR** |

**Next SAM:** Colombia, Chile, Peru and Argentina add hundreds of thousands more establishments with the same profile. The product is already Spanish-first.

**Sanity check against the business model:** solo break-even is **~275 total restaurants at 5% conversion** (§9), i.e. ~14 paying. That is **0.01% of SAM**. The model survives even if the market is much smaller than estimated.

## 3. Value created (the ROI line)

This one is already in the business model, and it's the strongest ROI line of the portfolio:

- A restaurant buying **$20k/mo** in food that catches vendor price creep and fixes two underpriced dishes recovers **1–2 points of food cost = $200–400/mo**.
- Pro costs **$39**, so it pays for itself **5–10×** every month.
- **Competitive anchor:** Haddock charges **85–399€/mo** plus implementation fees for the same loop. We're 3–6× cheaper per document, self-serve, and still at ~90% margin because Gemini inference is ~$0.003 a scan.

Pitch line: *"Teremu costs less than half a cover a month and tells you when the salmon goes up 8%."*

## 4. To verify before quoting

1. The Mexico sector 722 count from INEGI DENUE, plus the size breakdown (micro / small / medium).
2. The Spain restaurant and bar split from Hostelería de España.
3. The "fits" filter (10–15% in Mexico). Beta telemetry on invoice volume per restaurant will calibrate it.
4. The recovered-margin claim. Collect 3–5 real beta case studies ("Teremu caught $X in price increases").
