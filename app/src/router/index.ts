import { createRouter, createWebHistory, START_LOCATION } from 'vue-router'
import { useAuthStore } from '../stores/auth'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'pulse', component: () => import('../pages/PulsePage.vue') },
    { path: '/login', name: 'login', component: () => import('../pages/LoginPage.vue') },
    { path: '/scan', name: 'scan', component: () => import('../pages/ScanPage.vue') },
    { path: '/triage', name: 'triage', component: () => import('../pages/TriagePage.vue') },
    { path: '/triage/:id', name: 'triage-detail', component: () => import('../pages/TriageDetailPage.vue') },
    { path: '/menu', name: 'menu', component: () => import('../pages/MenuPage.vue') },
    { path: '/menu/:id', name: 'dish-detail', component: () => import('../pages/DishDetailPage.vue') },
    { path: '/pantry', name: 'pantry', component: () => import('../pages/PantryPage.vue') },
    { path: '/pantry/:id', name: 'ingredient-detail', component: () => import('../pages/IngredientDetailPage.vue') },
    { path: '/vendors', name: 'vendors', component: () => import('../pages/VendorsPage.vue') },
    { path: '/vendors/:key', name: 'vendor-detail', component: () => import('../pages/VendorDetailPage.vue') },
    { path: '/settings', name: 'settings', component: () => import('../pages/SettingsPage.vue') },
    { path: '/pricing', name: 'pricing', component: () => import('../pages/PricingPage.vue') },
    // Catch-all 404. Required because Firebase Hosting rewrites every URL
    // to index.html — without this, typos render an empty RouterView.
    { path: '/:pathMatch(.*)*', name: 'not-found', component: () => import('../pages/NotFoundPage.vue') },
  ],
  scrollBehavior: () => ({ top: 0 }),
})

// ── AUTH + PERMISSION GUARD ─────────────────────────────────────
// Waits for auth state AND the membership profile, keeps signed-out
// visitors on /login, and routes members only where their granular
// perms allow (falling back to the first area they CAN see).
import type { PermArea, PermLevel } from '../lib/types'

// Exported so the location-switch action (stores/location.ts) can reuse
// the exact same rules to redirect when a switch lands on a location
// where the caller's (possibly different) perms no longer permit the
// current route — instead of duplicating this table.
export const REQUIRED: Record<string, [PermArea, PermLevel] | null> = {
  pulse: ['finance', 'read'],
  scan: ['scan', 'read'],
  triage: ['triage', 'read'],
  'triage-detail': ['triage', 'read'],
  menu: ['menu', 'read'],
  'dish-detail': ['menu', 'read'],
  pantry: ['pantry', 'read'],
  'ingredient-detail': ['pantry', 'read'],
  vendors: ['vendors', 'read'],
  'vendor-detail': ['vendors', 'read'],
  settings: null,
  pricing: null,
  login: null,
  'not-found': null,
}

export const FALLBACK_ORDER: { name: string; area: PermArea }[] = [
  { name: 'pulse', area: 'finance' },
  { name: 'triage', area: 'triage' },
  { name: 'scan', area: 'scan' },
  { name: 'menu', area: 'menu' },
  { name: 'pantry', area: 'pantry' },
  { name: 'vendors', area: 'vendors' },
]

router.beforeEach(async (to) => {
  const auth = useAuthStore()
  await auth.whenReady()
  if (!auth.user && to.name !== 'login') {
    return {
      name: 'login',
      query: to.fullPath !== '/' ? { redirect: to.fullPath } : {},
    }
  }
  if (auth.user && to.name === 'login') {
    return { name: 'pulse' }
  }
  if (auth.user) {
    await auth.whenProfile()
    const required = REQUIRED[String(to.name)] ?? null
    if (required && !auth.can(required[0], required[1])) {
      const allowed = FALLBACK_ORDER.find((f) => auth.can(f.area))
      if (allowed && allowed.name !== to.name) return { name: allowed.name }
      return { name: 'settings' }
    }
  }
})

// ── VIEW TRANSITION WRAPPER ─────────────────────────────────────
// Every navigation becomes a view transition when the browser
// supports it. Pages opt into specific effects purely via CSS in
// assets/css/transitions.css — this file never changes per-page.
// Never call document.startViewTransition anywhere else.
router.beforeResolve(async (_to, from) => {
  if (from === START_LOCATION) return            // initial load: no transition
  if (!document.startViewTransition) return      // unsupported: navigate plainly
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return

  return new Promise<void>((resolve) => {
    document.startViewTransition(() => {
      // Resolving lets vue-router swap the page inside the snapshot;
      // the returned promise keeps the transition open until the new
      // page has rendered.
      resolve()
      return router.isReady()
    })
  })
})

export default router
