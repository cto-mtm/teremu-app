import type { TaxSetting } from "@teremu/shared";
import { DEFAULT_PACK, defaultCurrencyFor } from "./default.js";
import type { CountryPack, CountryProfile } from "./types.js";
import { ES_PACK } from "./es/pack.js";
import { US_PACK } from "./us/pack.js";
import { VE_PACK } from "./ve/pack.js";

export type { CountryPack, CountryProfile, PulseCardSpec } from "./types.js";

/**
 * Registry. A new market = one folder under `countries/<cc>/` exporting
 * a `CountryPack`, registered here. Nothing else in the core changes.
 * `ve/` is registered with its OCR knowledge; its rate providers are Phase 3.
 */
const PACKS: Record<string, CountryPack> = {
  [ES_PACK.code]: ES_PACK,
  [US_PACK.code]: US_PACK,
  [VE_PACK.code]: VE_PACK,
};

/** The pack for a restaurant's country; unknown or absent → default,
 * with the country-table currency prefill applied. */
export function packFor(country: string | null | undefined): CountryPack {
  const pack = country ? PACKS[country] : undefined;
  if (pack) return pack;
  return { ...DEFAULT_PACK, code: country ?? "", defaultCurrency: defaultCurrencyFor(country) };
}

/**
 * The menu-price tax setting a restaurant's margins use (docs/us-market-
 * readiness.md A6): the owner's override when set, else the country pack's
 * default. Resolved HERE only — `GET /me` ships the result as `tax` and the
 * assistant's dish-cost tool calls the same function, so the app never
 * re-derives it.
 */
export function taxSettingFor(
  country: string | null | undefined,
  override: { pricesIncludeTax?: boolean | null; salesTaxRate?: number | null },
): TaxSetting {
  const pack = packFor(country);
  return {
    pricesIncludeTax: override.pricesIncludeTax ?? pack.pricesIncludeTax,
    rate: override.salesTaxRate ?? pack.salesTaxRate ?? 0,
  };
}

/** Data-only view for GET /me — see CountryProfile. */
export function profileOf(pack: CountryPack): CountryProfile {
  return {
    code: pack.code,
    defaultCurrency: pack.defaultCurrency,
    sources: pack.rateProviders.map((p) =>
      p.legalLabelKey ? { id: p.id, legalLabelKey: p.legalLabelKey } : { id: p.id },
    ),
    defaultSource: pack.defaultSource,
    optInSources: pack.optInSources ?? [],
    pulseCards: pack.pulseCards ?? [],
    pricesIncludeTax: pack.pricesIncludeTax,
    salesTaxRate: pack.salesTaxRate ?? null,
    unitSystem: pack.unitSystem,
  };
}
