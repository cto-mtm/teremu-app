// Signup attribution (mtmcya-dashboard docs/metrics-plan.md §6).
//
// The brand website hands its first-touch UTM over as `?src=<slug>` on the
// app CTA (different origins, so the query string is the handoff). The app
// keeps the first value it sees and sends it as `X-Signup-Source` on `/me`;
// the API writes it on the restaurant only when that call bootstraps one,
// then the value is dropped here. Nothing else reads it.

const KEY = 'teremu.signupSource'
const PARAM = 'src'
const SLUG = /^[a-z0-9][a-z0-9:._-]{0,63}$/

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** Keep `?src=` from the landing URL (first value wins), and strip it from the address bar. */
export function captureSignupSource(loc: Location = window.location, store: Storage | null = storage()): void {
  if (!store) return
  const url = new URL(loc.href)
  const raw = url.searchParams.get(PARAM)
  if (raw == null) return
  const slug = raw.trim().toLowerCase()
  if (SLUG.test(slug) && !store.getItem(KEY)) store.setItem(KEY, slug)
  url.searchParams.delete(PARAM)
  try {
    history.replaceState(history.state, '', url.toString())
  } catch {
    // Not fatal: the value is kept, the address bar still shows it.
  }
}

export function getSignupSource(store: Storage | null = storage()): string | null {
  return store?.getItem(KEY) ?? null
}

export function clearSignupSource(store: Storage | null = storage()): void {
  store?.removeItem(KEY)
}
