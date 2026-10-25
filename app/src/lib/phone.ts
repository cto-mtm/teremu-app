/**
 * WhatsApp needs an international number with no "+" or punctuation
 * (`https://wa.me/34612345678`). Owners type what is on the vendor's
 * truck: "612 345 678", "(312) 555-0199", "+1 312 555 0199", "0034 …".
 * A number with no country prefix gets the RESTAURANT's, from its country
 * pack (`countryProfile.dialCode`, docs/us-market-readiness.md B5) — a US
 * restaurant's local vendor is a US number, a Spanish one's is Spanish.
 * Pure, so it is unit-tested.
 */
export function whatsappNumber(raw: string, dialCode: string | null | undefined): string {
  const trimmed = raw.trim()
  const digits = trimmed.replace(/\D/g, '')
  if (!digits) return ''
  // Already international: "+1 …", the "00" exit prefix, or the US "011".
  if (trimmed.startsWith('+')) return digits
  if (digits.startsWith('00')) return digits.slice(2)
  if (digits.startsWith('011') && digits.length > 11) return digits.slice(3)
  if (!dialCode) return digits
  // A local number: drop a leading trunk zero ("0612…" in some countries)
  // and prefix the restaurant's country code. A number that already starts
  // with the code and is long enough to be international is left alone.
  const code = dialCode.replace(/\D/g, '')
  if (digits.startsWith(code) && digits.length >= code.length + 9) return digits
  return code + digits.replace(/^0+/, '')
}

/** The wa.me link for a vendor phone, or '' when there is no usable number. */
export function whatsappLink(raw: string, dialCode: string | null | undefined, text?: string): string {
  const number = whatsappNumber(raw, dialCode)
  if (!number) return ''
  return `https://wa.me/${number}${text ? `?text=${encodeURIComponent(text)}` : ''}`
}
