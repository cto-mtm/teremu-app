import { DEFAULT_CURRENCY, type Currency } from "../models.js";
import type { CountryPack } from "./types.js";

/**
 * The world as it is today: no country-specific rate source, no OCR
 * hints, no extra tax lines, no cards. A foreign document on a
 * default-pack restaurant is converted with the rate the document
 * prints or the one the reviewer types (ECB crosses arrive in Phase 2).
 */
export const DEFAULT_PACK: CountryPack = {
  code: "",
  defaultCurrency: DEFAULT_CURRENCY,
  rateProviders: [],
  defaultSource: "manual",
};

/**
 * Country → base currency prefill for countries WITHOUT a pack of their
 * own. Lives inside `countries/` because it is the one table of country
 * literals the core is allowed to consult (through `packFor`). A country
 * with its own pack overrides this via `CountryPack.defaultCurrency`.
 */
const DEFAULT_CURRENCY_BY_COUNTRY: Record<string, Currency> = {
  // Eurozone
  AT: "EUR", BE: "EUR", CY: "EUR", DE: "EUR", EE: "EUR", ES: "EUR", FI: "EUR", FR: "EUR",
  GR: "EUR", HR: "EUR", IE: "EUR", IT: "EUR", LT: "EUR", LU: "EUR", LV: "EUR", MT: "EUR",
  NL: "EUR", PT: "EUR", SI: "EUR", SK: "EUR",
  GB: "GBP",
  MX: "MXN",
  CA: "CAD",
  US: "USD",
  // Dollarized in practice — the founder's call for the first LATAM market.
  VE: "USD",
  EC: "USD", PA: "USD", SV: "USD",
};

export const defaultCurrencyFor = (country: string | null | undefined): Currency =>
  (country && DEFAULT_CURRENCY_BY_COUNTRY[country]) || DEFAULT_CURRENCY;
