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
      if (!sub || path.has(sub.id) || path.size > 4) {
        missing = true;
        continue;
      }
      const rec = plateCost(sub, ingredients, menuItems, laborRatePerHour, new Set([...path, sub.id]));
      foodCost += rec.foodCost * line.qty;
      laborCost += rec.laborCost * line.qty;
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
