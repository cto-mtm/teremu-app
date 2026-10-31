/**
 * One full reload for "this tab's build is gone". After a deploy the
 * hashed files an open tab was built against no longer exist on Hosting,
 * and only a reload fetches the new index.html with the new names. Two
 * callers share it: PageLoadError (a page chunk failed after retrying)
 * and the `vite:preloadError` listener in main.ts (any lazy chunk).
 *
 * At most once a minute, so a genuine outage (offline, a broken deploy)
 * becomes a visible error with a Retry button instead of a reload loop.
 */
const KEY = 'teremu-page-reload-at'

function reloadedRecently(): boolean {
  try {
    return Date.now() - (Number(sessionStorage.getItem(KEY)) || 0) < 60_000
  } catch {
    return false // storage blocked — treat as never reloaded
  }
}

/** Reload now, remembering when (the Retry button's path). */
export function reloadApp(): void {
  try {
    sessionStorage.setItem(KEY, String(Date.now()))
  } catch {
    /* storage blocked — reload anyway */
  }
  location.reload()
}

/** Reload unless that just happened; `false` means "show the error instead". */
export function reloadOnce(): boolean {
  if (reloadedRecently()) return false
  reloadApp()
  return true
}
