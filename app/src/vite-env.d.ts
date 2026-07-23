/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** API base URL — see app/.env.example and src/lib/api.ts */
  readonly VITE_API_URL?: string
  /** Firebase web config (Auth only). Leave unset for the Auth emulator. */
  readonly VITE_FIREBASE_API_KEY?: string
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string
  readonly VITE_FIREBASE_PROJECT_ID?: string
  readonly VITE_FIREBASE_APP_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
