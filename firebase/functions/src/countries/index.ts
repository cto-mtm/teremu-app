import { DEFAULT_PACK, defaultCurrencyFor } from "./default.js";
import type { CountryPack, CountryProfile } from "./types.js";

export type { CountryPack, CountryProfile, PulseCardSpec } from "./types.js";

/**
 * Registry. A new market = one folder under `countries/<cc>/` exporting
 * a `CountryPack`, registered here. Nothing else in the core changes.
 * (Phase 3 registers `ve/`.)
 */
const PACKS: Record<string, CountryPack> = {};

/** The pack for a restaurant's country; unknown or absent → default,
 * with the country-table currency prefill applied. */
export function packFor(country: string | null | undefined): CountryPack {
  const pack = country ? PACKS[country] : undefined;
  if (pack) return pack;
  return { ...DEFAULT_PACK, code: country ?? "", defaultCurrency: defaultCurrencyFor(country) };
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
  };
}
