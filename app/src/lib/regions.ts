/**
 * Device-region defaults for the restaurant profile
 * (docs/multi-currency.md — "country default = device region, shown and
 * editable, never asked"). Pure UI data + detection; the country's
 * BEHAVIOUR (rate sources, hints) is the API's country pack, which the
 * app only ever sees serialized on GET /me as `countryProfile`.
 */

/** ISO 3166-1 alpha-2 codes offered in the Settings picker — the markets
 * Teremu sells in plus the rest of the Americas and Western Europe. A
 * code outside this list still round-trips (the field is free text on
 * the API), it just isn't in the dropdown. */
export const COUNTRY_CODES = [
  // Americas
  'AR', 'BO', 'BR', 'CA', 'CL', 'CO', 'CR', 'CU', 'DO', 'EC', 'GT', 'HN', 'MX', 'NI', 'PA', 'PE', 'PR', 'PY', 'SV', 'US', 'UY', 'VE',
  // Europe
  'AT', 'BE', 'CH', 'DE', 'DK', 'ES', 'FI', 'FR', 'GB', 'GR', 'IE', 'IT', 'NL', 'NO', 'PL', 'PT', 'SE',
] as const

export interface DetectedRegion {
  country: string | null
  timezone: string | null
}

/**
 * Best guess from the device, no network: the locale's region when the
 * device reports one ("es-VE" → VE), else the likeliest region for the
 * bare language ("es" → ES, "en" → US) via Intl's likely-subtags data.
 * Timezone comes straight from the resolved DateTimeFormat options.
 */
export function detectRegion(): DetectedRegion {
  let country: string | null = null
  let timezone: string | null = null
  try {
    const tag = navigator.language || Intl.DateTimeFormat().resolvedOptions().locale
    const locale = new Intl.Locale(tag)
    const region = locale.region ?? locale.maximize().region
    if (region && /^[A-Z]{2}$/.test(region)) country = region
  } catch {
    /* an odd locale tag is not worth failing over — the owner can pick */
  }
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (tz && /^[A-Za-z0-9_+\-/]+$/.test(tz)) timezone = tz
  } catch {
    /* same */
  }
  return { country, timezone }
}

/** Human name for a country code in the UI language ("VE" → "Venezuela"). */
export function countryName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code
  } catch {
    return code
  }
}

/** IANA zone ids the runtime knows, for the Settings picker; empty on
 * engines without `Intl.supportedValuesOf` (the field degrades to text). */
export function timezoneOptions(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
  try {
    return intl.supportedValuesOf?.('timeZone') ?? []
  } catch {
    return []
  }
}
