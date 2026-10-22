import type { CountryPack } from "../types.js";

/**
 * Venezuela (docs/multi-currency.md § Venezuela pack). Phase 1 slice:
 * how Venezuelan receipts are written — no rate providers yet (BCV is
 * Phase 3), so Triage still offers the printed rate and manual entry.
 */
export const VE_PACK: CountryPack = {
  code: "VE",
  // Dollarized in practice: suppliers quote USD, the paper is in Bs.
  defaultCurrency: "USD",
  rateProviders: [],
  defaultSource: "manual",
  ocrHints: [
    "VENEZUELAN DOCUMENTS:",
    '- Bolívar amounts are written "Bs.", "Bs", "Bs.S", "Bs.D" or "BsF" — report the currency as "VES". Numbers use "." for thousands and "," for decimals ("Bs. 9.312,50" = 9312.50).',
    '- "SENIAT" (the tax authority) is printed on every fiscal receipt, often in large type at the top or bottom next to "MAQUINA FISCAL" / "FACTURA" marks: it is NEVER the vendor. The vendor is the business whose name and RIF (J-…, V-…) head the document; the buyer\'s RIF appears next to "CLIENTE" / "RAZON SOCIAL".',
    '- "IVA" (16 %) is VAT and "IGTF" (3 %) is the tax on paying in foreign currency: skip them as lines but include them in "total". "BI" / "BASE IMPONIBLE" and "SUBTOTAL" are subtotals, never lines. Items marked "(E)" or "EXENTO" are tax-exempt products — keep them as lines.',
    '- A "REF" / "$" / "USD" amount next to the Bs. total, or a "TASA BCV" / "TASA" figure, is the printed exchange rate context: copy the rate into "printedFxRate".',
  ].join("\n"),
  nonProductLineNames: ["IVA", "IGTF"],
  notVendorNames: ["SENIAT"],
  // Matched case-insensitively (ocr.ts applyCurrencyAliases): one entry
  // per spelling, not per capitalisation.
  currencyAliases: {
    "Bs": "VES",
    "Bs.": "VES",
    "Bs.S": "VES",
    "Bs.S.": "VES",
    "BsS": "VES",
    "Bs.D": "VES",
    "Bs.D.": "VES",
    "BsD": "VES",
    "Bs.F": "VES",
    "BsF": "VES",
    "VEF": "VES",
    "VED": "VES",
    "Bolívares": "VES",
    "Bolivares": "VES",
  },
};
