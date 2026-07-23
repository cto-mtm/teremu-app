import { defineStore } from 'pinia'
import router, { FALLBACK_ORDER, REQUIRED } from '../router'
import { setActiveRid } from '../lib/activeLocation'
import { apiFetch } from '../lib/api'
import { createdRestaurantSchema } from '../lib/schemas'
import type { Location } from '../lib/types'
import { useAuthStore } from './auth'
import { useInvoicesStore } from './invoices'
import { useKitchenStore } from './kitchen'

/**
 * Detail routes carry an id that belongs to one specific location's
 * dataset (a menu item, invoice, ingredient, vendor) — always leave
 * these on switch, even if the new membership's perms would still
 * permit the *list* page.
 */
const DETAIL_ROUTES = new Set(['dish-detail', 'triage-detail', 'ingredient-detail', 'vendor-detail'])

/**
 * Owns the whole multi-location transition (see docs/multi-location-plan.md,
 * pattern #3) so no page hand-rolls switching: persist the choice, drop
 * stale per-location data, reload the membership profile for the new
 * location, and route off anywhere the new perms (or the old detail id)
 * can no longer support. AppShell's existing profile watcher takes care
 * of refetching kitchen/invoice data once `auth.profile` changes.
 */
export const useLocationStore = defineStore('location', () => {
  async function switchLocation(rid: string): Promise<void> {
    const auth = useAuthStore()
    if (rid === auth.profile?.restaurantId) return

    setActiveRid(rid)

    // Clear location-scoped state up front so nothing from the previous
    // restaurant flashes on screen while the reload is in flight.
    useKitchenStore().reset()
    useInvoicesStore().reset()

    await auth.reloadProfile() // re-reads /me for the new rid's role/perms

    const current = router.currentRoute.value
    const required = REQUIRED[String(current.name)] ?? null
    const stillAllowed = !required || auth.can(required[0], required[1])
    if (DETAIL_ROUTES.has(String(current.name)) || !stillAllowed) {
      const allowed = FALLBACK_ORDER.find((f) => auth.can(f.area))
      await router.replace({ name: allowed?.name ?? 'settings' })
    }
  }

  /** Create a new location (caller becomes its owner) and switch to it. */
  async function addLocation(name: string): Promise<boolean> {
    const res = await apiFetch<Location>(
      '/restaurants',
      { method: 'POST', body: JSON.stringify({ name }) },
      createdRestaurantSchema,
    )
    if (!res.ok) return false
    await switchLocation(res.data.rid)
    return true
  }

  return { switchLocation, addLocation }
})
