import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import type { User } from 'firebase/auth'
import { signInWithGoogle, signOut as fbSignOut, watchAuth } from '../lib/firebase'
import { apiFetch } from '../lib/api'
import { setActiveRid } from '../lib/activeLocation'
import { DEFAULT_CURRENCY, meSchema } from '../lib/schemas'
import { setCurrency } from '../i18n'
import type { Me, PermArea, PermLevel } from '../lib/types'

const RANK: Record<PermLevel, number> = { none: 0, read: 1, edit: 2 }

export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null)
  const ready = ref(false) // true once the initial auth state is known
  /** Membership + granular perms from GET /me (bootstraps server-side). */
  const profile = ref<Me | null>(null)
  // The i18n currency is DERIVED from the active location's profile, never
  // set by hand: every path that changes the profile (sign-in, reload after
  // a Settings save, location switch, sign-out) re-renders every amount.
  watch(() => profile.value?.currency ?? DEFAULT_CURRENCY, setCurrency, { immediate: true })
  const error = ref<string | null>(null)
  const busy = ref(false)

  // Router guards await these so they never decide on a not-yet-known
  // auth state (Firebase restores the session asynchronously on boot).
  let resolveReady: (() => void) | null = null
  const readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve
  })
  let resolveProfile: (() => void) | null = null
  let profilePromise = new Promise<void>((resolve) => {
    resolveProfile = resolve
  })

  let _prevUid: string | null = null
  // Set by signOut() so the phantom-logout diagnostic below doesn't
  // false-positive on every legitimate logout; consumed (reset) by the
  // very next auth-state event, whatever it is.
  let _explicitSignOut = false
  watchAuth((u) => {
    if (import.meta.env.DEV) {
      const transition = `${_prevUid ?? '(init)'} → ${u ? u.uid : 'null'}`
      console.warn(`[auth] onAuthStateChanged: ${transition}`)
      if (_prevUid && !u && !_explicitSignOut) {
        console.error('[auth] ⚠️ UNEXPECTED SIGN-OUT — user went from signed-in to null without explicit signOut')
        console.trace()
      }
      _prevUid = u?.uid ?? null
    }
    _explicitSignOut = false
    user.value = u
    ready.value = true
    resolveReady?.()
    resolveReady = null
    if (u) {
      void loadProfile()
    } else {
      profile.value = null
      // Re-arm for the next sign-in.
      profilePromise = new Promise<void>((resolve) => {
        resolveProfile = resolve
      })
    }
  })

  async function loadProfile(): Promise<void> {
    const res = await apiFetch<Me>('/me', undefined, meSchema)
    if (import.meta.env.DEV) {
      console.warn('[auth] loadProfile result:', res.ok ? 'ok' : `FAILED: ${res.error}`)
    }
    profile.value = res.ok ? res.data : null
    if (res.ok) {
      // Cold start (no/stale X-Restaurant-Id) resolves a default
      // server-side — persist whatever actually got applied so the
      // next request carries the right header.
      setActiveRid(res.data.restaurantId)
    } else {
      error.value = res.error
    }
    resolveProfile?.()
    resolveProfile = null
  }

  function whenReady(): Promise<void> {
    return readyPromise
  }

  /** Resolves once the membership profile has loaded (or failed). */
  function whenProfile(): Promise<void> {
    return profile.value ? Promise.resolve() : profilePromise
  }

  /** Reload plan/usage after upgrades or plan-affected actions. */
  async function reloadProfile(): Promise<void> {
    await loadProfile()
  }

  /** Granular permission check — owners bypass everything. */
  function can(area: PermArea, level: PermLevel = 'read'): boolean {
    const p = profile.value
    if (!p) return false
    if (p.role === 'owner') return true
    if (area === 'scan') return p.perms.scan
    return RANK[p.perms[area] as PermLevel] >= RANK[level]
  }

  async function signIn(): Promise<void> {
    busy.value = true
    error.value = null
    try {
      await signInWithGoogle()
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'sign-in failed'
    } finally {
      busy.value = false
    }
  }

  async function signOut(): Promise<void> {
    if (import.meta.env.DEV) console.warn('[auth] explicit signOut() called')
    // Before the await: the auth-state callback fires during it.
    _explicitSignOut = true
    await fbSignOut()
  }

  return { user, ready, profile, error, busy, whenReady, whenProfile, reloadProfile, can, signIn, signOut }
})
