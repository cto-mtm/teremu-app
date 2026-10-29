import type { CountryPack } from "../types.js";

/**
 * Spain. Until 2026-10-25 Spain was "the default" and nothing was written
 * down; this pack makes its assumptions explicit so the world pack stops
 * carrying them (docs/us-market-readiness.md A5/A6).
 *
 * - Menu prices include IVA — hostelería runs at 10 % (a bar's alcohol at
 *   21 % is the owner's override in Settings) — so margins net it.
 * - Supplier facturas print net line prices (base imponible) and add IVA
 *   at the bottom; tickets print gross. The OCR prompt already handles
 *   both; the extra hint here is the vocabulary.
 * - Kitchens work in kg / g / L.
 */
export const ES_PACK: CountryPack = {
  code: "ES",
  defaultCurrency: "EUR",
  rateProviders: [],
  defaultSource: "manual",
  pricesIncludeTax: true,
  salesTaxRate: 0.1,
  unitSystem: "metric",
  dateOrder: "DMY",
  dialCode: "34",
  weekStartsOn: 1,
  ocrHints: [
    "SPANISH DOCUMENTS:",
    '- Dates are DD/MM/YYYY ("03/04/2026" is 3 April). Numbers use "." to group thousands and "," for decimals ("9.312,50" = 9312.50).',
    '- "FACTURA" is an invoice, "ALBARÁN" / "NOTA DE ENTREGA" a delivery note, "FACTURA RECTIFICATIVA" / "ABONO" a credit. "BASE IMPONIBLE" and "SUBTOTAL" are subtotals, "IVA" and "RECARGO DE EQUIVALENCIA" are tax lines: skip them as lines — the printed total already includes them.',
    '- The buyer appears next to "CLIENTE", "DESTINATARIO" or "ENTREGAR EN"; the vendor is the business whose name and CIF / NIF head the document.',
    '- A document with no "FACTURA" heading whose number is labelled "ALBARÁN" / "ALBARAN:" / "Nº ALBARÁN" / "Albarà" (as a heading, a field label or the header of the number column) is a delivery note, even with TOTAL / ENTREGADO / CAMBIO or "Facturación: semanal" printed. "Albarán-Factura" is an invoice.',
    '- A "Recibo de alquiler" is a rent bill: its line is the rent ("Renta"). "Retención IRPF" is tax withholding, not a line; "TOTAL A PAGAR" already reflects it. Utility and professional-fee lines read "Energía consumida", "Término fijo", "Contabilidad mensual" and the like.',
    '- "Base imp." with no IVA line and no "Total" is a document that stops at its pre-tax base.',
  ].join("\n"),
  nonProductLineNames: ["IVA", "Recargo de equivalencia", "Portes", "Transporte"],
};
