import { getFirestore } from "firebase-admin/firestore";
import type { AssistantContext } from "@mtmcya/assistant";
import { marginPct, normalizeName, plateCost } from "@teremu/shared";
import { ingredientDocSchema, menuItemDocSchema } from "../../models.js";
import type { DishCostRowT } from "../tools.js";

/**
 * The assistant's one `code` tool. Dish cost is not stored anywhere: it
 * is recipe × live ingredient prices (+ sub-recipes, + prep labor), the
 * same `plateCost()` from @teremu/shared the menu page runs, so a margin
 * quoted in chat equals the one on the ficha de plato. A `query` row
 * cannot express a join, hence code. Scoped by `ctx.tenantId`; the
 * engine validates the output against `DishCostRow` and caps its size.
 */
export interface DishCostInput {
  name?: string | undefined;
  order: "lowestMargin" | "name";
  limit: number;
}

const MAX_DOCS = 500; // well above any real menu/pantry; keeps one read bounded

export async function dishCosts(input: DishCostInput, ctx: AssistantContext): Promise<DishCostRowT[]> {
  const db = getFirestore();
  const rest = db.collection("restaurants").doc(ctx.tenantId);
  const [restSnap, menuSnap, ingSnap] = await Promise.all([
    rest.get(),
    rest.collection("menuItems").limit(MAX_DOCS).get(),
    rest.collection("ingredients").limit(MAX_DOCS).get(),
  ]);
  const rate = restSnap.get("laborRatePerHour");
  const laborRatePerHour = typeof rate === "number" ? rate : 0;

  const ingredients = new Map(
    ingSnap.docs.flatMap((d) => {
      const p = ingredientDocSchema.safeParse(d.data());
      return p.success ? [[d.id, p.data] as const] : [];
    }),
  );
  const menuItems = new Map(
    menuSnap.docs.flatMap((d) => {
      const p = menuItemDocSchema.safeParse(d.data());
      return p.success ? [[d.id, { id: d.id, ...p.data }] as const] : [];
    }),
  );

  const needle = input.name ? normalizeName(input.name) : "";
  const rows: DishCostRowT[] = [];
  for (const item of menuItems.values()) {
    if (!item.active) continue;
    if (needle && !normalizeName(item.name).includes(needle)) continue;
    const c = plateCost(item, ingredients, menuItems, laborRatePerHour);
    rows.push({
      id: item.id,
      name: item.name,
      price: item.price,
      cost: round2(c.cost),
      foodCost: round2(c.foodCost),
      laborCost: round2(c.laborCost),
      marginPct: round1(marginPct(item.price, c.cost)),
      targetMarginPct: item.targetMarginPct,
      incomplete: c.missing,
    });
  }

  rows.sort((a, b) =>
    input.order === "name"
      ? a.name.localeCompare(b.name)
      : (a.marginPct ?? Number.POSITIVE_INFINITY) - (b.marginPct ?? Number.POSITIVE_INFINITY),
  );
  return rows.slice(0, input.limit);
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round1 = (n: number | null): number | null => (n === null ? null : Math.round(n * 10) / 10);
