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
}

export function watchAuth(cb: (user: User | null) => void): () => void {
  return onAuthStateChanged(auth, cb)
}

export async function signInWithGoogle(): Promise<void> {
  // NOTE: popups don't work inside the Capacitor WebView — the native
  // shells need @capacitor-firebase/authentication when you go native.
  await signInWithPopup(auth, new GoogleAuthProvider())
}

export async function signOut(): Promise<void> {
  await firebaseSignOut(auth)
}

/** Current user's ID token for the Authorization header, or null. */
export async function idToken(): Promise<string | null> {
  return auth.currentUser ? auth.currentUser.getIdToken() : null
}
