import { computed, ref } from 'vue'
import { createI18n } from 'vue-i18n'
import { DEFAULT_CURRENCY, DEFAULT_LOCALE, LOCALES, type Currency } from '@teremu/shared'

// Per-feature modules, each exporting { es, en } with en typed against es.
import common from './locales/configs/common'
import shell from './locales/components/shell'
import auth from './locales/components/auth'
import assistant from './locales/components/assistant'
import onboarding from './locales/components/onboarding'
import locations from './locales/components/locations'
import integrations from './locales/components/integrations'
import email from './locales/components/email'
import pwa from './locales/components/pwa'
import pulse from './locales/pages/pulse'
import scan from './locales/pages/scan'
import triage from './locales/pages/triage'
import menu from './locales/pages/menu'
import pantry from './locales/pages/pantry'
import vendors from './locales/pages/vendors'
import settings from './locales/pages/settings'
import pricing from './locales/pages/pricing'
import notfound from './locales/pages/notfound'
import setup from './locales/pages/setup'

export const SUPPORTED_LOCALES = LOCALES
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]

const messages = {
  es: {
    common: common.es,
    shell: shell.es,
    auth: auth.es,
    assistant: assistant.es,
    onboarding: onboarding.es,
    locations: locations.es,
    integrations: integrations.es,
    email: email.es,
    pwa: pwa.es,
    pulse: pulse.es,
    scan: scan.es,
    triage: triage.es,
    menu: menu.es,
    pantry: pantry.es,
    vendors: vendors.es,
    settings: settings.es,
    pricing: pricing.es,
    notfound: notfound.es,
    setup: setup.es,
  },
  en: {
    common: common.en,
    shell: shell.en,
    auth: auth.en,
    assistant: assistant.en,
    onboarding: onboarding.en,
    locations: locations.en,
    integrations: integrations.en,
    email: email.en,
    pwa: pwa.en,
    pulse: pulse.en,
    scan: scan.en,
    triage: triage.en,
    menu: menu.en,
    pantry: pantry.en,
    vendors: vendors.en,
    settings: settings.en,
    pricing: pricing.en,
    notfound: notfound.en,
    setup: setup.en,
  },
} as const

const datetimeFormats = {
  es: {
    short: { year: 'numeric', month: 'short', day: 'numeric' },
    weekday: { month: 'short', day: 'numeric' },
  },
  en: {
    short: { year: 'numeric', month: 'short', day: 'numeric' },
    weekday: { month: 'short', day: 'numeric' },
  },
} as const

// The currency is the RESTAURANT's (GET /me → setCurrency); how a number
// looks — separators, symbol position — is the UI language's. So a
// Spanish UI shows "1.234,56 €" and an English one "€1,234.56" for the
// same EUR restaurant. Percent keeps one decimal ("78,5 %" / "78.5%").
const numberFormatFor = (currency: Currency) =>
  ({
    // Narrow symbol ("$", "€", "£"): a restaurant has ONE currency, so the
    // disambiguating "US$"/"GBP" Intl uses in Spanish is just noise — and
    // it would disagree with currencySymbol in labels.
    currency: { style: 'currency', currency, currencyDisplay: 'narrowSymbol' },
    percent: { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 },
    // Axis maxima and rough estimates ("57 %"), where ",0" is noise.
    percentWhole: { style: 'percent', maximumFractionDigits: 0 },
  }) as const

const numberFormats = {
  es: numberFormatFor(DEFAULT_CURRENCY),
  en: numberFormatFor(DEFAULT_CURRENCY),
}

const stored =
  typeof localStorage !== 'undefined' ? localStorage.getItem('teremu-locale') : null
const initialLocale: SupportedLocale = SUPPORTED_LOCALES.includes(stored as SupportedLocale)
  ? (stored as SupportedLocale)
  : DEFAULT_LOCALE

export const i18n = createI18n({
  legacy: false, // Composition API mode: useI18n() + t(), never $t
  locale: initialLocale,
  fallbackLocale: 'en',
  messages,
  datetimeFormats,
  numberFormats,
})

/** Current UI language, typed (i18n.global.locale is a plain string). */
export function currentLocale(): SupportedLocale {
  return i18n.global.locale.value as SupportedLocale
}

/**
 * Switch the UI language on this device. The one place that does it:
 * the i18n instance, the localStorage first-paint guess, and <html lang>.
 * Persisting it to the profile (users/{uid}.locale) is the auth store's
 * job — see saveLocale / syncLocale in stores/auth.ts.
 */
export function setLocale(next: SupportedLocale): void {
  i18n.global.locale.value = next
  if (typeof localStorage !== 'undefined') localStorage.setItem('teremu-locale', next)
  if (typeof document !== 'undefined') document.documentElement.lang = next
}

const currency = ref<Currency>(DEFAULT_CURRENCY)

/** Point every n(x, 'currency') at the active restaurant's currency. */
export function setCurrency(code: Currency): void {
  currency.value = code
  for (const locale of SUPPORTED_LOCALES) i18n.global.setNumberFormat(locale, numberFormatFor(code))
}

/**
 * How people actually write a currency when Intl's symbol is not it:
 * outside the es-VE locale Intl prints the bolívar as "VES", but every
 * receipt and every Venezuelan says "Bs.".
 */
const LOCAL_SYMBOL: Partial<Record<Currency, string>> = { VES: 'Bs.' }

const symbolOf = (code: Currency): string =>
  LOCAL_SYMBOL[code] ??
  new Intl.NumberFormat(i18n.global.locale.value, { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol' })
    .formatToParts(0)
    .find((p) => p.type === 'currency')?.value ??
  code

/** A currency's name in labels and pickers: "Bs." for VES, else the ISO code. */
export const currencyLabel = (code: Currency): string => LOCAL_SYMBOL[code] ?? code

/** A currency picker option in the UI language: "dólar estadounidense (USD)",
 * "bolívar soberano (Bs.)". */
export function currencyOptionLabel(code: Currency): string {
  try {
    const name = new Intl.DisplayNames([i18n.global.locale.value], { type: 'currency' }).of(code) ?? code
    return `${name} (${currencyLabel(code)})`
  } catch {
    return currencyLabel(code)
  }
}

/**
 * An amount in a DOCUMENT currency (Triage, pending invoice cards) — the
 * UI language's separators with the symbol people use ("Bs. 9.312,50").
 * Base-currency amounts keep using n(x, 'currency').
 */
export function formatMoney(value: number, code: Currency): string {
  const parts = new Intl.NumberFormat(i18n.global.locale.value, {
    style: 'currency',
    currency: code,
    currencyDisplay: 'narrowSymbol',
  }).formatToParts(value)
  const symbol = LOCAL_SYMBOL[code]
  return parts.map((p) => (p.type === 'currency' && symbol ? symbol : p.value)).join('')
}

/** "$" / "€" / "£" in the current language — for labels like "Precio ({symbol})". */
export const currencySymbol = computed(() => symbolOf(currency.value))

// Key autocompletion for t() calls across the app.
type MessageSchema = (typeof messages)['es']
declare module 'vue-i18n' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  export interface DefineLocaleMessage extends MessageSchema {}
}
