import type { AssistantContext } from "@mtmcya/assistant";
import { invoiceDocSchema } from "../../models.js";
import type { InvoiceLineRowT } from "../tools.js";
import { round2, tenantRef } from "./shared.js";

/**
 * The line items of ONE approved invoice (from getRecentInvoices' id):
 * what was bought, quantity, and the base-currency unit price and line
 * total. Line items live in an array INSIDE the invoice document, so a
 * `query` row cannot project them into rows — hence `code`. Scoped by
 * `ctx.tenantId`: the doc is read under the tenant's own `invoices`
 * subcollection, so one restaurant can never read another's lines.
 *
 * Money: `lineItemSchema.unitPrice`/`total` are the PRINTED figures in the
 * document's currency; `baseUnitPrice` is the base-currency unit price,
 * written at approval only when the document currency differs from base
 * (docs/multi-currency.md). So the base unit price is `baseUnitPrice ??
 * unitPrice`, and the base line total derives from it when present, else
 * the printed total already is base.
 */
export interface InvoiceLineInput {
  id: string;
}

export async function invoiceLines(input: InvoiceLineInput, ctx: AssistantContext): Promise<InvoiceLineRowT[]> {
  const snap = await tenantRef(ctx).collection("invoices").doc(input.id).get();
  const parsed = invoiceDocSchema.safeParse(snap.data());
  // Unknown id, another tenant's doc (unreachable — wrong subcollection),
  // or a not-yet-approved document: no lines rather than an error.
  if (!parsed.success || parsed.data.status !== "approved") return [];

  return parsed.data.lineItems.map((l) => {
    const baseUnit = l.baseUnitPrice ?? l.unitPrice;
    const baseTotal = l.baseUnitPrice != null ? baseUnit * l.qty : l.total;
    return {
      name: l.name,
      qty: l.qty,
      unit: l.unit,
      unitPrice: round2(baseUnit),
      total: round2(baseTotal),
    };
  });
}
