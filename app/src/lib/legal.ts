import type { Locale } from '@teremu/shared'

/**
 * The legal documents live on the marketing site (teremu.com, the
 * teremu-website repo), the one public copy that Google's OAuth review,
 * the app stores and the ad campaign all point at — the app never hosts a
 * second copy that would drift (docs/us-market-readiness.md A2). The
 * app's /privacy and /terms routes exist so in-app links and consent
 * screens have stable URLs; they forward here.
 *
 * The site serves Spanish at the root and English under /en.
 */
export type LegalDocId = 'privacy' | 'terms'

const WEBSITE_URL = (import.meta.env.VITE_WEBSITE_URL as string | undefined)?.replace(/\/+$/, '') || 'https://teremu.com'

export function legalUrl(doc: LegalDocId, locale: Locale): string {
  return locale === 'es' ? `${WEBSITE_URL}/${doc}` : `${WEBSITE_URL}/${locale}/${doc}`
}
