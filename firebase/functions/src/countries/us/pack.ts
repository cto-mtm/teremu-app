import type { CountryPack } from "../types.js";

/**
 * United States (docs/us-market-readiness.md). What is different about a
 * US restaurant's paper and prices, and nothing else:
 *
 * - Menu prices are quoted BEFORE tax; sales tax is added at the till, so
 *   margins use the printed price as is (`pricesIncludeTax: false`).
 * - Supplier invoices (Sysco, US Foods, Restaurant Depot, local produce
 *   houses) are in English and USD, dated MM/DD/YYYY, with "," grouping
 *   thousands, priced by the case with pack sizes like "6/#10 CAN" and
 *   "4/5 LB", and often billed by weight ("catch weight"). Restaurant
 *   food purchases are usually tax-exempt under a resale certificate;
 *   when a tax or surcharge line does appear it is not a product.
 * - Kitchens work in lb / oz / gal / qt; the app offers those first.
 */
export const US_PACK: CountryPack = {
  code: "US",
  defaultCurrency: "USD",
  rateProviders: [],
  defaultSource: "manual",
  pricesIncludeTax: false,
  unitSystem: "imperial",
  dateOrder: "MDY",
  ocrHints: [
    "US DOCUMENTS:",
    '- Dates are MM/DD/YYYY ("03/04/2026" is March 4). Numbers use "," to group thousands and "." for decimals ("1,250.00" = 1250).',
    '- The buyer appears next to "SOLD TO", "SHIP TO", "BILL TO" or "CUSTOMER"; the vendor is the distributor whose name heads the document (Sysco, US Foods, Restaurant Depot, Performance Foodservice, a produce house…).',
    '- "#" after a number is pounds ("25#" = 25 lb). "#10" after a slash or next to "CAN" is a CAN SIZE, not a weight: "6/#10 CAN" is one case of six #10 cans → unit "case", packQty 6, packUnit "each".',
    '- Pack sizes read COUNT/SIZE: "4/5 LB" is 4 bags of 5 lb (packQty 20, packUnit "lb"); "12/32 OZ" is 12 units of 32 oz (packQty 24, packUnit "lb"); "24/16 FLOZ" is 24 bottles of 16 fl oz (packQty 3, packUnit "gal").',
    '- "CS" / "CA" = case, "EA" = each, "DZ" = dozen, "LB" = lb, "OZ" = oz, "GAL" = gal, "BG"/"BAG" and "BX" = box, "CT"/"PK" = case.',
    '- Catch-weight lines bill by weight ("1 CS  38.6 LB @ 3.29/LB"): qty is the billed weight in lb, unit "lb", unitPrice the per-lb price.',
    '- "Sales Tax", "Fuel Surcharge", "Delivery Charge", "CRV", "Bottle Deposit" and "Pallet Fee" are not products: skip them as lines but include them in "total".',
  ].join("\n"),
  nonProductLineNames: ["Sales Tax", "Tax", "Fuel Surcharge", "Delivery Charge", "Delivery Fee", "CRV", "Bottle Deposit", "Pallet Fee"],
};
