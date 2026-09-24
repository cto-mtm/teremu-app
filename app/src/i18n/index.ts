import { computed, ref } from 'vue'
import { createI18n } from 'vue-i18n'
import { DEFAULT_CURRENCY, type Currency } from '@teremu/shared'

// Per-feature modules, each exporting { es, en } with en typed against es.
import common from './locales/configs/common'
import shell from './locales/components/shell'
import auth from './locales/components/auth'
import assistant from './locales/components/assistant'
import onboarding from './locales/components/onboarding'
import locations from './locales/components/locations'
import pulse from './locales/pages/pulse'
import scan from './locales/pages/scan'
import triage from './locales/pages/triage'
import menu from './locales/pages/menu'
import pantry from './locales/pages/pantry'
import vendors from './locales/pages/vendors'
import settings from './locales/pages/settings'
import pricing from './locales/pages/pricing'
import notfound from './locales/pages/notfound'

export const SUPPORTED_LOCALES = ['es', 'en'] as const
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]

const messages = {
  es: {
    common: common.es,
    shell: shell.es,
    auth: auth.es,
    assistant: assistant.es,
    onboarding: onboarding.es,
    locations: locations.es,
    pulse: pulse.es,
    scan: scan.es,
    triage: triage.es,
    menu: menu.es,
    pantry: pantry.es,
    vendors: vendors.es,
    settings: settings.es,
    pricing: pricing.es,
    notfound: notfound.es,
  },
  en: {
    common: common.en,
    shell: shell.en,
    auth: auth.en,
    assistant: assistant.en,
    onboarding: onboarding.en,
    locations: locations.en,
    pulse: pulse.en,
    scan: scan.en,
    triage: triage.en,
    menu: menu.en,
    pantry: pantry.en,
    vendors: vendors.en,
    settings: settings.en,
    pricing: pricing.en,
    notfound: notfound.en,
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
  : 'es'

export const i18n = createI18n({
  legacy: false, // Composition API mode: useI18n() + t(), never $t
  locale: initialLocale,
  fallbackLocale: 'en',
  messages,
  datetimeFormats,
  numberFormats,
})

const currency = ref<Currency>(DEFAULT_CURRENCY)

/** Point every n(x, 'currency') at the active restaurant's currency. */
export function setCurrency(code: Currency): void {
  currency.value = code
  for (const locale of SUPPORTED_LOCALES) i18n.global.setNumberFormat(locale, numberFormatFor(code))
}

/** "$" / "€" / "£" in the current language — for labels like "Precio ({symbol})". */
export const currencySymbol = computed(
  () =>
    new Intl.NumberFormat(i18n.global.locale.value, {
      style: 'currency',
      currency: currency.value,
      currencyDisplay: 'narrowSymbol',
    })
      .formatToParts(0)
      .find((p) => p.type === 'currency')?.value ?? currency.value,
)

// Key autocompletion for t() calls across the app.
type MessageSchema = (typeof messages)['es']
declare module 'vue-i18n' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  export interface DefineLocaleMessage extends MessageSchema {}
}
