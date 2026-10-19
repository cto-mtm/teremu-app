import type { Unit } from "./vocab.js";
import { convertQty } from "./utils.js";

/**
 * Plate costing — ONE implementation for the app (menu page, pulse,
 * drilldowns) and the API (the assistant's dish-cost tool), so a margin
 * quoted in chat is the margin shown on the ficha de plato. Structural
 * types: the app's `MenuItem`/`Ingredient` and the API's doc shapes (plus
 * an id) both satisfy them.
 */
export interface CostIngredient {
  unit: Unit;
  lastUnitPrice: number | null;
}

export interface CostRecipeLine {
  ingredientId?: string;
  subItemId?: string;
  qty: number;
  unit?: Unit;
}

export interface CostMenuItem {
  id: string;
  price: number;
  prepMinutes?: number;
  recipe: CostRecipeLine[];
  /** Preps only: what one batch makes (docs/prep-recipes.md). */
  yield?: { qty: number; unit: Unit };
}

/** Sold on the menu (has a price and a margin), as opposed to a prep. */
export const isDish = (item: { kind?: "dish" | "prep" }): boolean => item.kind !== "prep";

/**
 * How many batches / portions of `sub` one line uses. A line with a unit
 * on a sub with a yield is an amount of that yield (50 ml of a 2 L
 * demi-glace = 0.025); a unit-less line is batches, as sub-recipe lines
 * always were. null = the units don't convert (g of something sold in L):
 * the line can't be costed or depleted.
 */
export function subMultiplier(line: CostRecipeLine, sub: CostMenuItem): number | null {
  if (!line.unit || !sub.yield) return line.qty;
  const inYieldUnit = convertQty(line.qty, line.unit, sub.yield.unit);
  return inYieldUnit == null || sub.yield.qty <= 0 ? null : inYieldUnit / sub.yield.qty;
}

export interface PlateCost {
  cost: number;
  foodCost: number;
  laborCost: number;
  /** Some line could not be costed (unknown ingredient, no price, bad sub-recipe). */
  missing: boolean;
}

/** Recipe qty expressed in the ingredient's stock unit (price basis). */
export const qtyInStockUnit = (line: CostRecipeLine, ing: CostIngredient): number => {
  if (!line.unit) return line.qty; // legacy: qty already in stock units
  return convertQty(line.qty, line.unit, ing.unit) ?? line.qty;
};

/** Labor cost of one plate's prep time at the restaurant's rate. */
export const prepLaborCost = (item: CostMenuItem, laborRatePerHour: number): number =>
  ((item.prepMinutes ?? 0) / 60) * laborRatePerHour;

/**
 * Current plate cost of a dish from live (rolling) ingredient prices,
 * plus prep-time labor when the restaurant has a labor rate set
 * (cost = foodCost + laborCost). Sub-recipe lines ("side of rice"
 * inside "salmon with rice") expand recursively — their prep time
 * counts too — cycle-guarded per branch, depth-capped.
 */
export function plateCost<I extends CostIngredient, M extends CostMenuItem>(
  item: M,
  ingredients: Map<string, I>,
  menuItems: Map<string, M> = new Map(),
  laborRatePerHour = 0,
  path: Set<string> = new Set([item.id]),
): PlateCost {
  let foodCost = 0;
  let laborCost = prepLaborCost(item, laborRatePerHour);
  let missing = false;
  for (const line of item.recipe) {
    if (line.subItemId) {
      const sub = menuItems.get(line.subItemId);
      const mult = sub ? subMultiplier(line, sub) : null;
      if (!sub || mult == null || path.has(sub.id) || path.size > 4) {
        missing = true;
        continue;
      }
      const rec = plateCost(sub, ingredients, menuItems, laborRatePerHour, new Set([...path, sub.id]));
      foodCost += rec.foodCost * mult;
      laborCost += rec.laborCost * mult;
      missing = missing || rec.missing;
      continue;
    }
    const ing = line.ingredientId ? ingredients.get(line.ingredientId) : undefined;
    if (!ing || ing.lastUnitPrice == null) {
      missing = true;
      continue;
    }
    foodCost += ing.lastUnitPrice * qtyInStockUnit(line, ing);
  }
  return { cost: foodCost + laborCost, foodCost, laborCost, missing };
}

/** Margin % over price, or null when the dish has no price. */
export function marginPct(price: number, cost: number): number | null {
  return price > 0 ? ((price - cost) / price) * 100 : null;
}

/**
 * Expand what was made or sold (sub-recipes and preps included,
 * cycle-guarded, depth-capped) into raw ingredient usage entries in the
 * recipe's own units — ONE walk for the app's pantry math, the production
 * planner and the API's depletion on revenue. Callers convert each entry
 * to the ingredient's stock unit.
 */
export function expandUsage<M extends CostMenuItem>(
  selections: { menuItemId: string; qty: number }[],
  menuItems: Map<string, M>,
): Map<string, { qty: number; unit?: Unit }[]> {
  const raw = new Map<string, { qty: number; unit?: Unit }[]>();
  const walk = (menuItemId: string, multiplier: number, path: Set<string>, depth: number): void => {
    if (depth > 4) return;
    const item = menuItems.get(menuItemId);
    if (!item) return;
    for (const line of item.recipe) {
      if (line.subItemId) {
        const sub = menuItems.get(line.subItemId);
        const mult = sub ? subMultiplier(line, sub) : null;
        if (mult != null && !path.has(line.subItemId)) {
          walk(line.subItemId, multiplier * mult, new Set([...path, line.subItemId]), depth + 1);
        }
        continue;
      }
      if (!line.ingredientId) continue;
      raw.set(line.ingredientId, [
        ...(raw.get(line.ingredientId) ?? []),
        { qty: line.qty * multiplier, unit: line.unit },
      ]);
    }
  };
  for (const s of selections) {
    if (s.qty > 0) walk(s.menuItemId, s.qty, new Set([s.menuItemId]), 0);
  }
  return raw;
}
