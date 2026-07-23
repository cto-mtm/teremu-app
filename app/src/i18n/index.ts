import { createI18n } from 'vue-i18n'

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

const numberFormats = {
  es: {
    currency: { style: 'currency', currency: 'USD' },
    percent: { style: 'percent', maximumFractionDigits: 1 },
  },
  en: {
    currency: { style: 'currency', currency: 'USD' },
    percent: { style: 'percent', maximumFractionDigits: 1 },
  },
} as const

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

// Key autocompletion for t() calls across the app.
type MessageSchema = (typeof messages)['es']
declare module 'vue-i18n' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  export interface DefineLocaleMessage extends MessageSchema {}
}
