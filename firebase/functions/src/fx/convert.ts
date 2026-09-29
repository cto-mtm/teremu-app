import type { LineItem } from "../models.js";

/**
 * Printed → base conversion. THE ONLY PLACE base amounts are computed
 * (docs/multi-currency.md — Principle 1). Runs once, at approval, in
 * the same write as the `fx` decision; everything downstream (pantry
 * roll, serializer, app) COPIES what this wrote and never recomputes.
 *
 * Rounding is decided here and nowhere else: totals to 2 dp, unit
 * prices to 4 dp (matching the pantry's per-stock-unit precision), so
 * cents can never drift between two views of the same invoice.
 *
 * `rate` follows fx/types.ts: document units per ONE base unit, so
 * base = printed / rate.
 */

export const toBaseTotal = (printed: number, rate: number): number => +(printed / rate).toFixed(2);
export const toBaseUnitPrice = (printed: number, rate: number): number => +(printed / rate).toFixed(4);

/** A line with its base amounts filled in from its printed ones. */
export function convertLineItem(li: LineItem, rate: number): LineItem {
  return {
    ...li,
    baseUnitPrice: toBaseUnitPrice(li.unitPrice, rate),
    baseTotal: toBaseTotal(li.total, rate),
  };
}

/**
 * Lines in base, plus the document's base total as the SUM of the
 * converted lines — not printedTotal / rate — so the invariant approval
 * already keeps in printed figures (`total` = Σ line totals) holds in
 * base too, and a per-invoice view and a per-ingredient view of the
 * same money can never disagree by a rounding cent.
 */
export function convertInvoice(
  lineItems: LineItem[],
  rate: number,
): { lineItems: LineItem[]; baseTotal: number } {
  if (!(rate > 0) || !Number.isFinite(rate)) throw new RangeError("fx rate must be a positive number");
  const converted = lineItems.map((li) => convertLineItem(li, rate));
  return {
    lineItems: converted,
    baseTotal: +converted.reduce((s, l) => s + (l.baseTotal ?? 0), 0).toFixed(2),
  };
}

/** Whether a document carries any money at all (a priced line). An
 * unpriced foreign delivery note needs no rate — there is nothing to
 * convert. */
export const hasPricedLines = (lineItems: LineItem[]): boolean =>
  lineItems.some((l) => l.unitPrice > 0 || l.total > 0);
