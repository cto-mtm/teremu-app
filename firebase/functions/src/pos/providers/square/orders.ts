import type { PosAdapter, PosOrder, PosOrderLine } from "../../types.js";
import { callAs } from "./client.js";
import type { SquareMoney, SquareOrder, SquareOrderLine } from "./types.js";

/** Orders: Square's order → the normalized `PosOrder`, and the poll's read. */

const amt = (m?: SquareMoney): number => (m?.amount === undefined ? 0 : Number(m.amount) || 0);

/**
 * One line, reduced to NET. `total_money` is what the customer pays for
 * the line, after every discount (order-level ones are apportioned onto
 * lines by Square). Subtracting the line's tax gives the same net whether
 * the seller prices tax-inclusive (Spain) or additive (US) — which is why
 * we don't start from `gross_sales_money`, whose treatment of inclusive
 * tax differs by region. Apportioned service charges come out too; tips
 * never reach a line.
 */
function normalizeLine(l: SquareOrderLine, index: number, kind: "sale" | "return"): PosOrderLine {
  const gross = amt(kind === "return" ? (l.gross_return_money ?? l.gross_sales_money) : l.gross_sales_money);
  const discount = amt(l.total_discount_money);
  const tax = amt(l.total_tax_money);
  const net = l.total_money ? amt(l.total_money) - tax - amt(l.total_service_charge_money) : gross - discount;
  const qty = Number(l.quantity ?? "1");
  const name = l.name?.trim() || l.catalog_object_id || "—";
  return {
    externalLineId: l.uid ?? String(index),
    catalogExternalId: l.catalog_object_id ?? null,
    name: l.variation_name ? `${name} — ${l.variation_name.trim()}` : name,
    qty: Number.isFinite(qty) ? qty : 0,
    grossMinor: gross,
    discountMinor: discount,
    taxMinor: tax,
    netMinor: net,
    modifiers: (l.modifiers ?? []).map((m) => ({
      catalogExternalId: m.catalog_object_id ?? null,
      name: m.name?.trim() || "—",
      netMinor: amt(m.total_price_money),
    })),
  };
}

// A gift card activation is a liability, not a dish sold.
const isSale = (l: SquareOrderLine): boolean => l.item_type !== "GIFT_CARD";

export function normalizeSquareOrder(o: SquareOrder): PosOrder {
  const returned = (o.returns ?? []).flatMap((r) => r.return_line_items ?? []).filter(isSale);
  const ra = o.return_amounts;
  // An itemized return is already in `returns`; only an amount-only refund
  // needs the order-level figure (and then net of its tax and tip).
  const refundedMinor =
    returned.length === 0 && ra
      ? Math.max(0, amt(ra.total_money) - amt(ra.tax_money) - amt(ra.tip_money) - amt(ra.service_charge_money))
      : 0;
  const updatedAt = Date.parse(o.updated_at ?? o.created_at ?? "") || 0;
  return {
    externalId: o.id,
    locationExternalId: o.location_id,
    state: o.state === "COMPLETED" ? "completed" : o.state === "CANCELED" ? "canceled" : "open",
    closedAt: o.closed_at ? Date.parse(o.closed_at) || null : null,
    updatedAt,
    revision: typeof o.version === "number" ? o.version : updatedAt,
    currency:
      o.total_money?.currency ?? o.line_items?.find((l) => l.base_price_money?.currency)?.base_price_money?.currency ?? "",
    lines: (o.line_items ?? []).filter(isSale).map((l, i) => normalizeLine(l, i, "sale")),
    returns: returned.map((l, i) => normalizeLine(l, i, "return")),
    refundedMinor,
  };
}

export const orders: Pick<PosAdapter, "listOrders"> = {
  async listOrders(credentials, locationExternalId, { since, cursor }) {
    // Filtered and sorted by UPDATED time, not closed time: a refund
    // arriving days after the sale changes the order, and must be found.
    const r = await callAs<{ orders?: SquareOrder[]; cursor?: string }>(credentials, "/v2/orders/search", {
      method: "POST",
      body: {
        location_ids: [locationExternalId],
        limit: 500,
        ...(cursor ? { cursor } : {}),
        query: {
          filter: {
            state_filter: { states: ["COMPLETED"] },
            date_time_filter: { updated_at: { start_at: new Date(since).toISOString() } },
          },
          sort: { sort_field: "UPDATED_AT", sort_order: "ASC" },
        },
      },
    });
    return { orders: (r.orders ?? []).map(normalizeSquareOrder), cursor: r.cursor || null };
  },
};
