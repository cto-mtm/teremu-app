/**
 * "Today" is the restaurant's day, not the server's (docs/us-market-readiness.md A4).
 *
 * Cloud Functions run in UTC and browsers in the device zone; a
 * restaurant in Los Angeles closing at 11 pm is already "tomorrow" in
 * UTC, so every `new Date().toISOString().slice(0, 10)` stamped evening
 * entries and dateless invoices on the wrong day, and rolled the scan
 * month over the evening before. These helpers take the restaurant's
 * IANA zone (`restaurants/{rid}.timezone`) and are shared by the API and
 * the app so both sides agree on what day it is.
 */

const DAY_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = DAY_FORMATTERS.get(timeZone);
  if (!f) {
    // en-CA prints YYYY-MM-DD, which is exactly the key format stored.
    f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    DAY_FORMATTERS.set(timeZone, f);
  }
  return f;
}

/** The zone used when a restaurant has none yet: honest, not a market's. */
export const DEFAULT_TIMEZONE = "UTC";

/**
 * The calendar date (YYYY-MM-DD) of an instant in a zone. An unknown or
 * missing zone falls back to UTC rather than throwing — a bad setting
 * must never stop a scan or an entry from landing somewhere.
 */
export function todayIn(timeZone: string | null | undefined, now: number | Date = Date.now()): string {
  const at = typeof now === "number" ? new Date(now) : now;
  try {
    return dayFormatter(timeZone || DEFAULT_TIMEZONE).format(at);
  } catch {
    return dayFormatter(DEFAULT_TIMEZONE).format(at);
  }
}

/** The YYYY-MM of an instant in a zone — the key the monthly meters use. */
export function monthKeyIn(timeZone: string | null | undefined, now: number | Date = Date.now()): string {
  return todayIn(timeZone, now).slice(0, 7);
}
