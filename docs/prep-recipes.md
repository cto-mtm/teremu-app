# Prep recipes (preparaciones)

Status: **built 2026-10-19.** A *prep* is a recipe the kitchen makes in batches and
uses inside other recipes — a stock, a sauce, a dough, a pico de gallo. It is not
sold, so it has a **yield** instead of a price.

## Why

Sub-recipes already exist (`recipeLine.subItemId`, expanded recursively for costing
and stock depletion), but the thing a line points at must be a *dish*: it has a menu
price and a target margin, it shows up in the margin list, the Pulse sales sheet, the
menu-engineering matrix, the POS matcher and the assistant's "least profitable dish".
And its quantity is "portions", so "50 ml of demi-glace from a 2 L batch" has to be
typed as `0.025` portions. Kitchens think in batches and yields, not in portions of a
fake dish.

## Model

One collection, `restaurants/{rid}/menuItems` — a prep is a menu item with a kind:

| Field | Dish | Prep |
|---|---|---|
| `kind` | `"dish"` or absent | `"prep"` |
| `price`, `targetMarginPct` | as today | stored as `0` (the API forces it) |
| `yield` | absent | `{ qty, unit }` — what one batch makes (`2` `L`, `24` `each`) — **required** |
| `prepMinutes` | per plate | per batch |
| `recipe` | per plate | per batch |

`kind` is shared vocabulary (`MENU_ITEM_KINDS` in `shared/src/vocab.ts`); the entity
schemas stay mirrored (`models.ts` strict, `schemas.ts` lenient). One collection,
not a new one, because everything that walks recipes (costing, depletion, cycle
guard, the editor's picker) already resolves `subItemId` against `menuItems`.

### Lines that use a sub-recipe

A recipe line pointing at a sub-recipe gets an optional `unit`:

- **with `unit`, sub has a `yield`** → the line uses `qty unit` of the batch:
  `multiplier = convert(qty, unit → yield.unit) / yield.qty`. 50 ml of a 2 L
  demi-glace = 0.025 batches.
- **without `unit`** → `qty` is batches / portions, exactly as today
  (`multiplier = qty`). Every existing line keeps its meaning.
- **incompatible unit** (g of something yielding L) → the line is uncostable:
  `plateCost` flags `missing`, depletion skips it. The editor only offers units
  compatible with the yield (`compatibleUnits`), so this needs a hand-edited doc.

That rule lives once, in `subMultiplier()` in `shared/src/cost.ts`, used by
`plateCost` and by a shared `expandUsage()` — which replaces the two copies that
existed (app `domain.ts` and API `pipeline.ts`). The demo engine keeps its own
twin on purpose (spec keys, pinned numbers; `docs/demo-profiles.md`) and its subs
are unit-less portions, so its numbers do not move.

Cost of a prep = `plateCost(prep)` = one batch (ingredients + prep labor). Cost per
yield unit = batch cost / `yield.qty`, shown as "€2.10 / L".

## Where preps are excluded

Preps are never sold, so every surface about **sales, prices or margins** reads
*dishes* (`active && kind !== "prep"`):

| Surface | File | Behaviour |
|---|---|---|
| Menu list (margin cards) | `MenuPage.vue` | Two tabs: *Platos* and *Preparaciones* |
| Margin alerts, sales sheet, menu-engineering matrix | `PulsePage.vue`, `domain.ts` `menuEngineering` | dishes only |
| Production planner | `PantryPage.vue` | dishes only (planning by batch is a follow-up) |
| Imported dishes still without recipe | `MenuPage.vue` | dishes only (imports are dishes) |
| POS catalog matching, link confirm, daily projection | `pos/catalog.ts`, `pos/project.ts` | dishes only; confirming a prep → `dish_not_found` |
| Listing menu matching and price updates | `listing/jobs.ts`, `listing/commit.ts` | dishes only; `update_price` on a prep → `unknown_menu_item` |
| Assistant `getDishCosts`, dish counts | `assistant/code/dishCost.ts`, `counts.ts` | dishes only |

Everywhere a recipe is **walked** (costing, depletion, the grocery list, "dishes using
this ingredient"), preps are included — that is the point.

## UI

- **Menu → Preparaciones tab**: each prep card shows its yield, batch cost, cost per
  yield unit and how many dishes use it. "+ Nueva preparación" opens the editor in
  prep mode.
- **Editor**: a *Plato / Preparación* switch at the top. Prep mode swaps price and
  target margin for *Rinde* (qty + unit), labels say "per batch". The component picker
  lists *Preparaciones* first, then other dishes, then ingredients. A line on a prep
  gets a unit select (units compatible with the yield, defaulting to it); a line on a
  dish keeps "portions".
- **Detail page** for a prep: yield, batch cost, cost per unit, the dishes that use it
  (linked), and the cost breakdown. No price, margin or sales cards.

## Migration

None. `kind` absent = dish, a unit-less sub line = batches, so every existing doc reads
as before. A dish that is really a prep (price 0, used as a sub-recipe) is converted by
the owner with the editor's switch: its existing usages stay unit-less (= batches)
until a line is edited to use a unit.

## Tests

- Unit (`shared/src/cost.test.ts`): yield multiplier, unit-less legacy portions,
  incompatible unit → missing, `expandUsage` through a prep.
- Integration (`firebase/functions/test/menu.test.ts`): a prep is stored with price 0,
  a prep without `yield` is 400, selling a dish that uses 50 ml of a 2 L prep depletes
  the prep's ingredients by 1/40 of a batch; POS matching and `getDishCosts` skip preps.
- E2E (`e2e/tests/menu/prep-recipe.spec.ts`): create a prep, use it in a dish by ml,
  see the dish cost.

## Not built (follow-ups)

- Planning production by batches of a prep (the Pantry planner lists dishes only).
- Stocking preps (a counted quantity of demi-glace on hand). Today a prep's
  ingredients deplete when a dish using it sells, as if it were made to order.
- Free-form recipe categories beyond *dish / prep* (the printed `section` already
  groups imported dishes).
