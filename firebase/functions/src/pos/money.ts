/**
 * Minor units → the app's float amounts (docs/pos.md, Principle 4). The
 * POS layer keeps integer minor units; this is the boundary where they
 * become the base-currency floats every other module uses. The exponent
 * comes from Intl, not a table, so any ISO currency is right by default.
 */
const digitsCache = new Map<string, number>();

function minorDigits(currency: string): number {
  let digits = digitsCache.get(currency);
  if (digits === undefined) {
    try {
      digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
    } catch {
      digits = 2; // unknown/empty code — the common case
    }
    digitsCache.set(currency, digits);
  }
  return digits;
}

export const toMajor = (minor: number, currency: string): number => minor / 10 ** minorDigits(currency);
