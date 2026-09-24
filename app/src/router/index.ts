import { defineAsyncComponent, h, nextTick, type Component } from 'vue'
import { createRouter, createWebHistory, START_LOCATION } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import PageLoader from '../components/PageLoader.vue'
import PageLoadError from '../components/PageLoadError.vue'

// ── Pages: navigate first, load after ───────────────────────────
// A plain lazy route (`component: () => import(...)`) makes vue-router
// download the page's code BEFORE committing the navigation — the click
// just hangs until it arrives. As an async component the route commits
// on click and the page shows a skeleton while its code loads (only if
// that takes >150 ms). Every page's code is also prefetched once the app
// is idle (below), so in practice the skeleton rarely appears.
// If the code can't load — after a deploy, the hashed files an open tab
// was built against are gone — one retry, then PageLoadError reloads the
// app onto the new files (once) instead of leaving a blank page.
const loaders: (() => Promise<unknown>)[] = []
function page(loader: () => Promise<{ default: Component }>): Component {
  loaders.push(loader)
  return defineAsyncComponent({
    loader,
    loadingComponent: () => h(PageLoader, { cards: 0, lines: 4 }),
    delay: 150,
    errorComponent: PageLoadError,
    onError: (_err, retry, fail, attempts) => (attempts <= 1 ? retry() : fail()),
  })
}

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'pulse', component: page(() => import('../pages/PulsePage.vue')) },
    { path: '/login', name: 'login', component: page(() => import('../pages/LoginPage.vue')) },
    { path: '/scan', name: 'scan', component: page(() => import('../pages/ScanPage.vue')) },
    { path: '/triage', name: 'triage', component: page(() => import('../pages/TriagePage.vue')) },
    { path: '/triage/:id', name: 'triage-detail', component: page(() => import('../pages/TriageDetailPage.vue')) },
    { path: '/menu', name: 'menu', component: page(() => import('../pages/MenuPage.vue')) },
    { path: '/menu/:id', name: 'dish-detail', component: page(() => import('../pages/DishDetailPage.vue')) },
    { path: '/pantry', name: 'pantry', component: page(() => import('../pages/PantryPage.vue')) },
    { path: '/pantry/:id', name: 'ingredient-detail', component: page(() => import('../pages/IngredientDetailPage.vue')) },
    { path: '/vendors', name: 'vendors', component: page(() => import('../pages/VendorsPage.vue')) },
    { path: '/vendors/:key', name: 'vendor-detail', component: page(() => import('../pages/VendorDetailPage.vue')) },
    { path: '/settings', name: 'settings', component: page(() => import('../pages/SettingsPage.vue')) },
    { path: '/pricing', name: 'pricing', component: page(() => import('../pages/PricingPage.vue')) },
    // Catch-all 404. Required because Firebase Hosting rewrites every URL
    // to index.html — without this, typos render an empty RouterView.
    { path: '/:pathMatch(.*)*', name: 'not-found', component: page(() => import('../pages/NotFoundPage.vue')) },
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
    if (import.meta.env.DEV) {
      console.warn('[router guard] → login (user is null), target was:', to.name)
    }
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
    document.startViewTransition(async () => {
      // Resolving lets vue-router commit the route inside the snapshot;
      // the transition then stays open until the new page is in the DOM
      // (route committed + one render flush) — never on a fixed promise,
      // or the "new" snapshot can still be the old page. Capped, so a
      // stuck navigation can never freeze the screen.
      const committed = new Promise<void>((done) => {
        const off = router.afterEach(() => {
          off()
          done()
        })
      })
      resolve()
      await Promise.race([committed.then(() => nextTick()), new Promise((r) => setTimeout(r, 1000))])
    })
  })
})

// Warm every page's code in the background once the first screen is up,
// so later clicks never wait on the network.
router.isReady().then(() => {
  const warm = () => loaders.forEach((load) => void load().catch(() => {}))
  if ('requestIdleCallback' in window) requestIdleCallback(warm, { timeout: 4000 })
  else setTimeout(warm, 2000)
})

export default router
