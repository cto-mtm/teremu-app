import type { AssistantContext } from "@mtmcya/assistant";
import { normalizeName } from "@teremu/shared";
import { invoiceDocSchema, vendorContactSchema } from "../../models.js";
import type { VendorRowT } from "../tools.js";
import { MAX_DOCS, num, round2, str, tenantRef } from "./shared.js";

/**
 * Vendor history, derived from approved invoices (Teremu has no vendor
 * records of its own — the Vendors screen is this same derivation; see
 * README). Groups approved purchasing documents by vendor, summing
 * base-currency spend, counting deliveries, and keeping the last order
 * date, then merges the optional vendorContacts doc (email/phone) by the
 * same `normalizeName(vendorName)` key the app uses. Expense-tagged bills
 * (rent, hosting…) are not purchasing, so they are excluded. A `query`
 * cannot group-by, hence `code`. Scoped by `ctx.tenantId`.
 */
export interface VendorInput {
  name?: string | undefined; // part of a vendor name; omit for the ranking
  limit: number;
}

interface Agg {
  key: string;
  name: string;
  spend: number;
  deliveries: number;
  lastOrder: string | null;
}

export async function vendors(input: VendorInput, ctx: AssistantContext): Promise<VendorRowT[]> {
  const rest = tenantRef(ctx);
  const [invSnap, contactSnap] = await Promise.all([
    rest.collection("invoices").where("status", "==", "approved").limit(MAX_DOCS).get(),
    rest.collection("vendorContacts").limit(MAX_DOCS).get(),
  ]);

  const needle = input.name ? normalizeName(input.name) : "";
  const byKey = new Map<string, Agg>();
  for (const d of invSnap.docs) {
    const p = invoiceDocSchema.safeParse(d.data());
    if (!p.success) continue;
    const inv = p.data;
    if (inv.expenseTag || !inv.vendorName) continue; // non-food bill or unnamed → not a vendor
    const key = normalizeName(inv.vendorName);
    if (needle && !key.includes(needle)) continue;
    const agg = byKey.get(key) ?? { key, name: inv.vendorName, spend: 0, deliveries: 0, lastOrder: null };
    agg.spend += num(inv.baseTotal) ?? num(inv.total) ?? 0;
    agg.deliveries += 1;
    if (inv.invoiceDate && (!agg.lastOrder || inv.invoiceDate > agg.lastOrder)) agg.lastOrder = inv.invoiceDate;
    byKey.set(key, agg);
  }

  // Contact (email/phone) by the shared key, when one exists.
  const contacts = new Map(
    contactSnap.docs.flatMap((d) => {
      const c = vendorContactSchema.safeParse({ vendorKey: d.id, ...d.data() });
      return c.success ? [[d.id, c.data] as const] : [];
    }),
  );

  const rows = [...byKey.values()].map((v): VendorRowT => {
    const c = contacts.get(v.key);
    return {
      key: v.key,
      name: v.name,
      spend: round2(v.spend),
      deliveries: v.deliveries,
      lastOrder: v.lastOrder,
      email: c ? str(c.email) : null,
      phone: c ? str(c.phone) : null,
    };
  });
  // Most spend first (who matters); ties by most recent order.
  rows.sort((a, b) => b.spend - a.spend || (b.lastOrder ?? "").localeCompare(a.lastOrder ?? ""));
  return rows.slice(0, input.limit);
}
