import type { AssistantContext } from "@mtmcya/assistant";
import type { PriceChangeRowT } from "../tools.js";
import { loadIngredients, round1, round2 } from "./shared.js";

/**
 * Pantry-wide price movements since a date: which ingredients went up or
 * down, by how much. A `query` cannot express "compare last vs previous
 * price and rank by the move", so it is `code`. The signal is the rolling
 * price pair already on each ingredient (`lastUnitPrice` vs
 * `prevUnitPrice`), kept the moment an invoice is approved — and
 * `lastPriceAt` is when that last change landed, so `since` filters to
 * recent moves. Scoped by `ctx.tenantId` via the shared loader.
 */
export interface PriceChangeInput {
  from: string; // YYYY-MM-DD
  direction: "up" | "down" | "any";
  limit: number;
}

export async function priceChanges(input: PriceChangeInput, ctx: AssistantContext): Promise<PriceChangeRowT[]> {
  const since = Date.parse(input.from); // start of day UTC; good enough to window recent moves
  const ingredients = await loadIngredients(ctx);
  const rows: PriceChangeRowT[] = [];
  for (const ing of ingredients.values()) {
    const { lastUnitPrice: last, prevUnitPrice: prev, lastPriceAt } = ing;
    // Need both prices, a real previous base to compute a %, an actual
    // change, and the change must be on/after `since`.
    if (last == null || prev == null || prev === 0 || last === prev) continue;
    if (lastPriceAt == null || lastPriceAt < since) continue;
    const delta = last - prev;
    if (input.direction === "up" && delta <= 0) continue;
    if (input.direction === "down" && delta >= 0) continue;
    rows.push({
      id: ing.id,
      name: ing.name,
      unit: ing.unit,
      price: last,
      prevPrice: prev,
      changePct: round1((delta / prev) * 100),
      vendor: ing.lastVendorName,
      changedAt: lastPriceAt,
    });
  }
  // Biggest move first, regardless of direction (so "any" leads with the
  // sharpest swings); ties broken by most recent.
  rows.sort((a, b) => Math.abs(b.changePct ?? 0) - Math.abs(a.changePct ?? 0) || (b.changedAt ?? 0) - (a.changedAt ?? 0));
  return rows.slice(0, input.limit).map((r) => ({ ...r, price: round2(r.price), prevPrice: round2(r.prevPrice) }));
}
