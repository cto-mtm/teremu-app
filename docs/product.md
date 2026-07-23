# Teremu — Product Overview

**One line:** Teremu turns a phone camera into a restaurant's back office — scan crumpled vendor invoices, and AI keeps your food costs, dish margins, inventory, and supplier prices current without data entry.

**Who it's for:** Independent restaurant owner-operators and executive chefs. People who feel every point of food cost personally, sit down once or twice a week with a stack of paper, and have no time for spreadsheets.

**Philosophy:** *Intelligent approximation over bookkeeping.* Teremu never asks for daily logging. It builds a good-enough, always-current picture from what already exists — the papers vendors hand you and the sales you ring up — and lets a human correct it at the moments that matter: a 60-second triage after scanning, and a monthly walk-through of the walk-in. Every AI output is reviewable, every automatic number is correctable, and the human's correction always wins.

---

## The core loop

```
📷 Scan a stack of invoices (15 in 60 seconds, nothing blocks)
        ↓ background AI
📋 Triage: side-by-side photo vs extracted line items → one-tap approve
        ↓ automatic
💰 Ingredient prices roll → dish margins update → pantry fills
        ↓ meanwhile
🧾 Log daily sales (tap, CSV import) → pantry depletes via recipes
        ↓ continuously
📈 Pulse: alerts when a vendor raises prices or a dish slips under target
```

Everything else in the product hangs off this loop.

---

## Feature breakdown

### 1 · The Scanner

Continuous capture built for speed: framing guides, a confirmation flash, and a live thumbnail of the last shot — the camera never blocks between photos, uploads and AI run behind the scenes. An on-device quality gate (~5 ms) catches blurry or dark shots *before* they upload and asks "retake or use anyway?". Photos are compressed on-device (single JPEG encode, ≤1600 px, raw binary upload — no base64) so a 12 MP photo travels as ~300 KB. Gallery upload works as a fallback when there's no camera. Upload failures surface as a transient chip with an error haptic — never a blocking dialog mid-batch.

### 2 · The AI pipeline (what happens to each photo)

A four-stage pipeline, each stage catching what the previous can't:

| Stage | What it does | On failure |
|---|---|---|
| **Classify** | Is this a purchase document at all? Factura or albarán (delivery note)? | "Not a document" — distinct message, retry |
| **Extract** | Vendor, date, line items (name, qty, unit, price, total), **category** per line (produce/meats/dairy/…), **pack contents** for case/box lines ("24×400 g" → 9.6 kg), and **catalog matching** — lines map onto your existing ingredients ("TOM RMA 25#" → "Roma Tomatoes") so duplicates don't spawn | "Unreadable" — retake or retry |
| **Validate** | Deterministic math cross-checks: qty × price vs line total, line sum vs printed total | Nothing fails — suspect lines are flagged for the reviewer |
| **Review** | A human approves in Triage; warnings guide the eye | — |

Stuck processing (a trigger hiccup) self-surfaces after 90 seconds with a retry. In local dev without an AI key, a deterministic mock runs the whole flow offline.

### 3 · Triage

The inbox where digitized documents wait. Review is side-by-side — the receipt photo next to editable line items, with amber warnings and coral-ringed rows where the math didn't check out (fixing a line clears its flag). From here you can: **approve** (prices roll, pantry fills — quantities and prices converting across units automatically, lb→kg, case→contents); **approve as expense** for non-food bills (hosting, the menu photographer — tagged, excluded from all food math); flip **factura ↔ albarán** if the AI misjudged; or retry failed scans.

**Delivery-note reconciliation** (albarán ↔ factura): automatic pairing by vendor, date window, and totals, with per-line price comparison — "salmon: note $23.40 vs invoice $24.10" is the billing-error catch. Rows resolve manually too: link a note to the right invoice when the matcher misses, or mark it handled. Delivery notes never double-count: the matching invoice carries the money and the stock.

### 4 · Pulse (the dashboard)

The home screen answers "how is the restaurant doing?" at a glance:

- **Stat cards** — weekly expenses (food + tagged), revenue, **food-cost %** (colored against the 28–35% target band), and current **pantry value** (money sitting in the walk-in).
- **Charts** (all hand-rolled SVG, mobile-tuned): expenses vs revenue (8 weeks) · food-cost % with target band · spend stacked by vendor · **menu engineering matrix** (popularity × margin quadrants: stars, plowhorses, puzzles, dogs) · price-watch sparklines for the most volatile ingredients · top-ingredients-by-spend Pareto · spend by category (food vs expense tags).
- **Alerts** — vendor raised X by 8.2%, dish slipped under target. Every name is a link to its page.
- **Entries** — revenue and expenses logged in seconds (expense tags are free-form and fully dynamic: marketing, staff, rent, whatever you type — with autocomplete from your own history). Recent entries are editable and deletable, with pantry effects reverted correctly. **CSV import** brings in daily sales totals from any POS export (`date,amount`), deduplicating against already-logged dates.

Everything clicks through: matrix dots open the dish, Pareto bars open the ingredient, vendor bars open the vendor.

### 5 · Menu

Every dish costed live from rolling vendor prices. The list shows target-vs-actual margin bars sorted worst-first (the dishes needing attention float up), searchable and sortable. Each dish has a detail page: price / plate cost / margin / units sold, a weekly sales chart, and a **cost breakdown** showing each ingredient's share of the plate — the "why is this dish expensive" view. Recipes are authored in natural units (180 g of rice against stock kept in kg; conversion is automatic, cross-system included) via an editor that gates units to physically compatible ones.

### 6 · Pantry (theoretical inventory)

A reference table, not a ledger: **purchases (from scans) − sales (via recipes) = current stock**, requiring zero daily input. Monthly, the chef walks the walk-in, taps any number, types what they actually see — the true-up becomes the new baseline. Each ingredient has a full page: stock, price history chart normalized to one unit, purchases per week, the dishes using it, every receipt containing it, and the vendors who supply it — with an editable category (AI-assigned at extraction: produce, meats, seafood, dairy, liquor, …). Search, category filter, and sort by stock/value on the list.

**Grocery list generator:** from the last two weeks of sales, Teremu derives each ingredient's usage rate, compares it to stock, and suggests quantities to cover the next 7 days — sorted by urgency ("~2 days left", "out of stock"), grouped by vendor. From there: **order by email** (one tap, formatted order sent to the vendor's saved address), **WhatsApp** (pre-filled message), or copy as text.

### 7 · Vendors

A directory that maintains itself — derived from approved invoices (food vendors) and tagged expenses (service payees like the photographer or hosting company), so it can never drift from reality. Each vendor shows spend, delivery count, last delivery, and **derived tags**: the ingredient categories they actually supply (ember chips) and the expense tags you've paid them under (gray chips) — no manual tagging, ever. Detail pages add a weekly spend trend, every invoice, ingredients supplied with last prices (each linking onward), expense history, and the **ordering contact** (email/WhatsApp) that powers the grocery-list send buttons.

### 8 · The Assistant

A ✨ button opens a stateless Q&A over your own data: "what's the risotto's margin?", "what went up in price this week?". One question, one answer, no conversation history — and the context the model sees is **filtered by the member's permissions**, so a scan-only employee literally cannot ask about the money. Rate-limited per member to keep inference costs sane.

### 9 · Team, permissions & multi-location

One restaurant is a shared workspace. The owner invites members by email (the invite email sends automatically); when the person signs in with Google they're attached with **granular per-area permissions** rather than fixed roles: scan (yes/no) and triage / menu / pantry / finance at *none / read-only / edit* (vendors: none/read). So "camera-only runner", "accountant with finance read-only", and "chef with everything but the money" are just permission combinations. Enforcement is server-side on every API route; the client mirrors it — the sidebar, routes, and every mutating button adapt to what the member may do.

A person isn't limited to one restaurant: an owner can run several locations from the same account (a switcher in the sidebar lists all of them, each with its own name and plan, and a "+ Add location" action), and staff who work across sites can have a **different role and permissions at each** — owner of the flagship, read-only triage at a second site. Every location bills, meters, and scopes its data independently (the "Grupo" tier is simply Pro at each location, not a separate product).

### 10 · Settings

Language (Spanish is the authored source of truth, English fallback), **unit system** (metric by default, imperial optional — controls what the dropdowns offer, never converts stored data), team management (owner), and an API health check.

---

## Platform & architecture in brief

Vue 3 PWA wrapped by Capacitor — the same build runs in the browser today and ships as iOS/Android apps. Firebase backend (Hosting, Cloud Functions, Firestore, Storage) with one deliberate security property: **the client holds no database credentials** — every byte flows through the permission-checked API. Vision AI via NVIDIA-hosted open models (single env swap to change models). Full offline local development through the Firebase emulators, including a mock OCR mode and a seedable demo dataset. All user-facing text lives in a type-checked bilingual i18n system; page transitions use the native View Transitions API with hero animations between lists and detail pages.

See `docs/architecture.md` for the full technical picture and `docs/business-model.md` for pricing and competitive positioning.

## Deliberately not (yet) in the product

POS integration (CSV import is the bridge; auto-import is the roadmap headline) · multi-location consolidation · long-range analytics beyond the query windows (needs monthly rollups) · ingredient merge tool for pre-existing duplicates · per-ingredient case-size defaults when the pack isn't printed · HR/scheduling (deliberately never — it dilutes the food-cost wedge).
