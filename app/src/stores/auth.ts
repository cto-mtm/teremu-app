import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { User } from 'firebase/auth'
import { signInWithGoogle, signOut as fbSignOut, watchAuth } from '../lib/firebase'
import { apiFetch } from '../lib/api'
import { setActiveRid } from '../lib/activeLocation'
import { meSchema } from '../lib/schemas'
import type { Me, PermArea, PermLevel } from '../lib/types'

const RANK: Record<PermLevel, number> = { none: 0, read: 1, edit: 2 }

export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null)
  const ready = ref(false) // true once the initial auth state is known
  /** Membership + granular perms from GET /me (bootstraps server-side). */
  const profile = ref<Me | null>(null)
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

  watchAuth((u) => {
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
    await fbSignOut()
  }

  return { user, ready, profile, error, busy, whenReady, whenProfile, reloadProfile, can, signIn, signOut }
})
