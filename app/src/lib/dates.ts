import { todayIn } from '@teremu/shared'

/**
 * "Today" for date fields the user is about to fill in (revenue and
 * expense sheets, an FX as-of date): the RESTAURANT's calendar day
 * (docs/us-market-readiness.md A4), not the UTC date that
 * `new Date().toISOString()` gives — which, after late afternoon in the
 * Americas, is already tomorrow.
 *
 * `timezone` is the active restaurant's (`auth.profile?.timezone`); when
 * it has none yet, the device's own zone is the next best guess, and
 * UTC only if even that is unavailable.
 */
export function todayFor(timezone: string | null | undefined): string {
  return todayIn(timezone || deviceTimezone())
}

function deviceTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
  } catch {
    return undefined
  }
}
