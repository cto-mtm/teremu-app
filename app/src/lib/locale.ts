import { DEFAULT_LOCALE, LOCALES, type Locale } from '@teremu/shared'

/**
 * First-paint UI language, before anyone is signed in and before the
 * profile (users/{uid}.locale, the source of truth) has been read:
 *
 *   1. what this device last showed (localStorage 'teremu-locale'),
 *   2. else the first browser language we have a locale for
 *      ("en-US" → en, "es-MX" → es, "pt-BR" → skip to the next entry),
 *   3. else DEFAULT_LOCALE.
 *
 * Pure so it is unit-tested; src/i18n/index.ts feeds it the real
 * localStorage and navigator values. The signed-in sync (stores/auth.ts
 * syncLocale) then persists whatever this resolved to on first sign-in,
 * so a US owner who never touches the switcher ends up with `en` on
 * their profile — and their emails in English — instead of the authored
 * default.
 */
export function resolveLocale(stored: string | null | undefined, languages: readonly string[]): Locale {
  if (stored && (LOCALES as readonly string[]).includes(stored)) return stored as Locale
  for (const tag of languages) {
    const lang = tag.toLowerCase().split(/[-_]/)[0]
    if ((LOCALES as readonly string[]).includes(lang)) return lang as Locale
  }
  return DEFAULT_LOCALE
}

/** The browser's language preferences, most preferred first; empty outside a browser. */
export function browserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return []
  const list = navigator.languages && navigator.languages.length > 0 ? navigator.languages : [navigator.language]
  return list.filter((tag): tag is string => typeof tag === 'string' && tag.length > 0)
}
