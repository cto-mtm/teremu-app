import { initializeApp } from 'firebase/app'
import {
  GoogleAuthProvider,
  connectAuthEmulator,
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signOut as firebaseSignOut,
  type User,
} from 'firebase/auth'

/**
 * Firebase on the client is AUTH ONLY — no Firestore/Storage SDKs.
 * All data still flows through the Cloud Functions API; the only thing
 * this module produces is the ID token that apiFetch attaches.
 *
 * Local-first: with no VITE_FIREBASE_* config in .env, we boot against
 * the Auth emulator under the offline `demo-app` project. Its Google
 * sign-in shows a fake account picker — no real Google account needed.
 */
const hasRealConfig = Boolean(import.meta.env.VITE_FIREBASE_API_KEY)

// A production build with no VITE_FIREBASE_* used to fall through to the
// branch below and ship a live site whose sign-in pointed at the
// VISITOR's own 127.0.0.1:9099. Silent, and only visible once a real
// user tried to log in. Fail loudly at boot instead.
if (import.meta.env.PROD && !hasRealConfig) {
  throw new Error(
    'Missing VITE_FIREBASE_* config: a production build needs app/.env.production (see app/.env.example).',
  )
}

const app = initializeApp(
  hasRealConfig
    ? {
        apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
        authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
        projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
        appId: import.meta.env.VITE_FIREBASE_APP_ID,
      }
    : { apiKey: 'demo-api-key', authDomain: 'demo-app.firebaseapp.com', projectId: 'demo-app', appId: 'demo' },
)

export const auth = getAuth(app)
if (!hasRealConfig) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })

  // DEV DIAGNOSTIC: intercept fetch to the Auth emulator to catch silent
  // token refresh failures that cause phantom logouts.
  const _originalFetch = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    if (url.includes('127.0.0.1:9099') || url.includes('securetoken') || url.includes('identitytoolkit')) {
      const res = await _originalFetch(input, init)
      if (!res.ok) {
        const body = await res.clone().text()
        console.error(`[auth-debug] Auth emulator request FAILED: ${res.status} ${url}`, body.slice(0, 500))
      }
      return res
    }
    return _originalFetch(input, init)
  }
}

export function watchAuth(cb: (user: User | null) => void): () => void {
  return onAuthStateChanged(auth, (u) => {
    // New auth state → stale cached token.
    _tokenPromise = null
    _tokenUid = null
    cb(u)
  })
}

export async function signInWithGoogle(): Promise<void> {
  // NOTE: popups don't work inside the Capacitor WebView — the native
  // shells need @capacitor-firebase/authentication when you go native.
  await signInWithPopup(auth, new GoogleAuthProvider())
}

export async function signOut(): Promise<void> {
  await firebaseSignOut(auth)
}

/**
 * Current user's ID token for the Authorization header, or null.
 *
 * Deduplicates concurrent callers: when 6 parallel apiFetch calls fire
 * after sign-in, they all await the same getIdToken() promise instead of
 * each triggering a separate token refresh against the Auth emulator.
 * This prevents the race condition where parallel refresh requests
 * confuse the emulator into invalidating the session.
 *
 * The cache is keyed to the uid: during a fast sign-out/sign-in switch
 * a caller must never be handed the PREVIOUS user's token (the
 * onAuthStateChanged reset alone leaves a window where currentUser is
 * already the new user but the old promise is still in flight). The
 * settle handlers only clear the cache if it still holds their own
 * promise, so a stale settlement can't discard a newer in-flight one.
 */
let _tokenPromise: Promise<string | null> | null = null
let _tokenUid: string | null = null

export function idToken(): Promise<string | null> {
  const user = auth.currentUser
  if (!user) return Promise.resolve(null)
  if (!_tokenPromise || _tokenUid !== user.uid) {
    const p: Promise<string | null> = user.getIdToken().then(
      (token) => { if (_tokenPromise === p) _tokenPromise = null; return token },
      (err) => { if (_tokenPromise === p) _tokenPromise = null; throw err },
    )
    _tokenPromise = p
    _tokenUid = user.uid
  }
  return _tokenPromise
}
