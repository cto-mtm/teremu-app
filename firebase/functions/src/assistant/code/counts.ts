import type { AssistantContext } from "@mtmcya/assistant";
import type { CountsRowT } from "../tools.js";
import { tenantRef } from "./shared.js";

/**
 * How much data the restaurant holds: approved vs pending invoices, active
 * dishes, ingredients. Answers "how many invoices have I scanned", "how
 * many are waiting in triage". Uses Firestore `count()` aggregation, so it
 * reads NO documents (cheap, unbounded-safe). Scoped by `ctx.tenantId`.
 * Returns a single-row array so the card renderer treats it like the other
 * tools; the model reads the one row.
 */
export async function getCounts(_input: Record<string, never>, ctx: AssistantContext): Promise<CountsRowT[]> {
  const rest = tenantRef(ctx);
  const invoices = rest.collection("invoices");
  const [approved, pending, dishes, ingredients] = await Promise.all([
    invoices.where("status", "==", "approved").count().get(),
    invoices.where("status", "==", "needs_review").count().get(),
    rest.collection("menuItems").where("active", "==", true).count().get(),
    rest.collection("ingredients").count().get(),
  ]);
  return [
    {
      approvedInvoices: approved.data().count,
      pendingInvoices: pending.data().count,
      dishes: dishes.data().count,
      ingredients: ingredients.data().count,
    },
  ];
}
