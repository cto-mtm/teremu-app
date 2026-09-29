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
  /** Currency spellings → ISO code ("Bs.D" → "VES"), applied in sanitize(). */
  currencyAliases?: Record<string, Currency>;
  /** Pulse cards the pack contributes (Phase 3). */
  pulseCards?: PulseCardSpec[];
  /** When the pack's providers publish — drives the daily job (Phase 2). */
  publishSchedule?: { cron: string; tz: string };
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
}
