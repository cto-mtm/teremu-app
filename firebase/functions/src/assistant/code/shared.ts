import { getFirestore } from "firebase-admin/firestore";
import type { AssistantContext } from "@mtmcya/assistant";
import { ingredientDocSchema, menuItemDocSchema, type IngredientDoc, type MenuItemDoc } from "../../models.js";

/**
 * Shared plumbing for the assistant's `code` tools (dishCost, priceChange,
 * invoiceLines, vendors, counts). One place for: the tenant document ref,
 * the bounded collection load + schema-parse into a Map, and the scalar
 * coercers the `query` tools also use. Keeps every code tool reading the
 * same shapes the same way — a field rename lands here once.
 */

/** Well above any real menu/pantry; keeps a single read bounded. */
export const MAX_DOCS = 500;

/** The tenant's restaurant document ref. Every code tool scopes through this. */
export const tenantRef = (ctx: AssistantContext) => getFirestore().collection("restaurants").doc(ctx.tenantId);

export const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
export const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
export const round2 = (n: number): number => Math.round(n * 100) / 100;
export const round1 = (n: number | null): number | null => (n === null ? null : Math.round(n * 10) / 10);

/** Load a tenant subcollection, parse each doc with `schema`, drop the ones
 *  that fail, and key the survivors by id — the one load pattern the code
 *  tools share. */
async function loadById<T>(
  ctx: AssistantContext,
  collection: string,
  schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } },
): Promise<Map<string, T & { id: string }>> {
  const snap = await tenantRef(ctx).collection(collection).limit(MAX_DOCS).get();
  return new Map(
    snap.docs.flatMap((d) => {
      const p = schema.safeParse(d.data());
      return p.success ? [[d.id, { id: d.id, ...p.data }] as const] : [];
    }),
  );
}

export const loadIngredients = (ctx: AssistantContext): Promise<Map<string, IngredientDoc & { id: string }>> =>
  loadById(ctx, "ingredients", ingredientDocSchema);

export const loadMenuItems = (ctx: AssistantContext): Promise<Map<string, MenuItemDoc & { id: string }>> =>
  loadById(ctx, "menuItems", menuItemDocSchema);

/** The restaurant's labor rate (0 when unset) — plate costing needs it. */
export async function laborRate(ctx: AssistantContext): Promise<number> {
  const rate = (await tenantRef(ctx).get()).get("laborRatePerHour");
  return typeof rate === "number" ? rate : 0;
}
