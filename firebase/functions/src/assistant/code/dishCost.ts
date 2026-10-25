import type { AssistantContext } from "@mtmcya/assistant";
import { isDish, marginPct, normalizeName, plateCost } from "@teremu/shared";
import type { DishCostRowT } from "../tools.js";
import { costingSettings, loadIngredients, loadMenuItems, round1, round2 } from "./shared.js";

/**
 * The assistant's dish-cost `code` tool. Dish cost is not stored anywhere:
 * it is recipe × live ingredient prices (+ sub-recipes, + prep labor), the
 * same `plateCost()` from @teremu/shared the menu page runs, so a margin
 * quoted in chat equals the one on the ficha de plato. A `query` row
 * cannot express a join, hence code. Scoped by `ctx.tenantId` (via the
 * shared loaders); the engine validates the output against `DishCostRow`
 * and caps its size.
 */
export interface DishCostInput {
  name?: string | undefined;
  order: "lowestMargin" | "highestMargin" | "name";
  limit: number;
}

export async function dishCosts(input: DishCostInput, ctx: AssistantContext): Promise<DishCostRowT[]> {
  const [menuItems, ingredients, { laborRatePerHour, tax }] = await Promise.all([
    loadMenuItems(ctx),
    loadIngredients(ctx),
    costingSettings(ctx),
  ]);

  const needle = input.name ? normalizeName(input.name) : "";
  const rows: DishCostRowT[] = [];
  for (const item of menuItems.values()) {
    if (!item.active || !isDish(item)) continue; // a prep has no price or margin
    if (needle && !normalizeName(item.name).includes(needle)) continue;
    const c = plateCost(item, ingredients, menuItems, laborRatePerHour);
    rows.push({
      id: item.id,
      name: item.name,
      price: item.price,
      cost: round2(c.cost),
      foodCost: round2(c.foodCost),
      laborCost: round2(c.laborCost),
      marginPct: round1(marginPct(item.price, c.cost, tax)),
      targetMarginPct: item.targetMarginPct,
      incomplete: c.missing,
    });
  }

  rows.sort(byOrder(input.order));
  return rows.slice(0, input.limit);
}

/** Comparator for the requested order. A null margin (no price) always sorts
 *  last, whether the user asked for the lowest or the highest. */
function byOrder(order: DishCostInput["order"]): (a: DishCostRowT, b: DishCostRowT) => number {
  if (order === "name") return (a, b) => a.name.localeCompare(b.name);
  const sign = order === "highestMargin" ? -1 : 1;
  return (a, b) => {
    if (a.marginPct === null) return 1;
    if (b.marginPct === null) return -1;
    return sign * (a.marginPct - b.marginPct);
  };
}
