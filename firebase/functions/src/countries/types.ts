import type { Currency, FxSource } from "../models.js";
import type { RateProvider } from "../fx/types.js";

/**
 * Country pack — everything about a market that is NOT universal
 * (docs/multi-currency.md — Principle 5). The core asks the pack for
 * these and branches on nothing else; `countries/<cc>/` is the only
 * place a country literal may appear (test/boundaries.test.ts enforces
 * it). Deleting a pack folder must leave the core suite green.
 */
export interface CountryPack {
  /** ISO 3166-1 alpha-2, or "" for the default (world) pack. */
  code: string;
  /** Prefills `restaurants/{rid}.currency` when the restaurant is created. */
  defaultCurrency: Currency;
  /** Ordered rate sources Triage offers between `printed` and `manual`.
   * Empty = the default pack (ECB crosses + manual, Phase 2). */
  rateProviders: RateProvider[];
  /** Preselected candidate when the document prints no rate. */
  defaultSource: FxSource;
  /** Sources the owner must enable in Settings before they appear. */
  optInSources?: FxSource[];
  /** Extra paragraph appended to the OCR extraction prompt. */
  ocrHints?: string;
  /** Tax/fee line names OCR must fold into `total` (IGTF, …). */
  nonProductLineNames?: string[];
  /** Names printed on receipts that are never the seller (a tax
   * authority's fiscal mark) — the OCR vendor is dropped if it is one. */
  notVendorNames?: string[];
  /** Currency spellings → ISO code ("Bs.D" → "VES"), applied in sanitize(). */
  currencyAliases?: Record<string, Currency>;
  /** Pulse cards the pack contributes (Phase 3). */
  pulseCards?: PulseCardSpec[];
  /** When the pack's providers publish — drives the daily job (Phase 2). */
  publishSchedule?: { cron: string; tz: string };
  /** Menu prices as printed include tax (docs/us-market-readiness.md A6):
   * true where the till charges what the menu says (Spain, Venezuela…),
   * false where tax is added at the till (US). Margins net an inclusive
   * price by `salesTaxRate`; the restaurant may override both. */
  pricesIncludeTax: boolean;
  /** Fraction (0.10 = 10 %) used to net inclusive prices; omit when unknown. */
  salesTaxRate?: number;
  /** Units the app offers first (dropdowns only — nothing is converted). */
  unitSystem: "metric" | "imperial";
  /** How a numeric date is written on paper and in exports: 03/04 is 3 April
   * (DMY) or March 4 (MDY). Drives the CSV import and the OCR date hint (B2). */
  dateOrder: "DMY" | "MDY";
}

export interface PulseCardSpec {
  /** Stable id the client renders by ("tasa_bcv_hoy"). */
  id: string;
  /** i18n key of the card title. Packs contribute KEYS, never strings. */
  titleKey: string;
}

/**
 * What the client gets on GET /me — a serialized, DATA-ONLY view of the
 * pack, so the app renders Settings/Triage/Pulse from data and carries
 * no per-country code at all.
 */
export interface CountryProfile {
  code: string;
  defaultCurrency: Currency;
  /** Source ids Triage offers (between `printed` and `manual`), in order. */
  sources: { id: FxSource; legalLabelKey?: string }[];
  defaultSource: FxSource;
  optInSources: FxSource[];
  pulseCards: PulseCardSpec[];
  pricesIncludeTax: boolean;
  salesTaxRate: number | null;
  unitSystem: "metric" | "imperial";
  dateOrder: "DMY" | "MDY";
}
