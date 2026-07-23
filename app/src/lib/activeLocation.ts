/**
 * The active location (restaurant id), persisted device-locally — never
 * synced server-side (see docs/multi-location-plan.md: "Persistence:
 * device-local only"). Kept as a standalone module rather than a Pinia
 * store so lib/api.ts can read it directly: stores import the API
 * layer, so the reverse import would risk a circular dependency.
 * The Pinia location store and authHeaders() below both read this one
 * source of truth.
 */
const KEY = 'teremu-active-rid'

/** The rid to send as X-Restaurant-Id, or null before any location has
 * been chosen (first load — the server resolves a default and the
 * response tells the caller to persist it via `set`). */
export function getActiveRid(): string | null {
  return localStorage.getItem(KEY)
}

export function setActiveRid(rid: string): void {
  localStorage.setItem(KEY, rid)
}
