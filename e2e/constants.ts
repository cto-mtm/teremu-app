/**
 * Single source of truth for the e2e suite's shared constants.
 * Everything that reads the test owner's identity, the saved auth state,
 * or an emulator URL imports from here — never redefine these locally.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * The owner account auth.setup.ts creates through the Auth emulator's fake
 * Google account picker. Teremu has NO email/password signup — Google is
 * the only provider (app/src/lib/firebase.ts signInWithPopup), so the
 * emulator widget is the only way in.
 */
export const TEST_OWNER = {
  email: 'e2e-owner@test.teremu',
  displayName: 'E2E Owner',
}

/**
 * Where auth.setup.ts saves the signed-in storageState and where every
 * other project loads it from. Absolute on purpose: relative storageState
 * paths resolve against the process cwd, which differs between
 * `npx playwright test` (e2e/) and workspace runs (repo root).
 */
export const STORAGE_STATE = path.join(__dirname, 'playwright', '.auth', 'owner.json')

export const PROJECT_ID = 'demo-app'
/** Must match REGION in firebase/functions/src/region.ts — the emulator
 *  serves each function under its DECLARED region, so a mismatch here is a
 *  404 on every request, not just in production. */
export const REGION = 'us-east1'

export const AUTH_EMULATOR = 'http://127.0.0.1:9099'
export const FIRESTORE_EMULATOR = 'http://127.0.0.1:8080'
export const STORAGE_EMULATOR = 'http://127.0.0.1:9199'
/** The api Cloud Function on the FUNCTIONS emulator — the app's dev
 *  BASE_URL (app/src/lib/api.ts). Auth/Firestore up but this down = every
 *  screen renders empty with a connection error. */
export const API_EMULATOR = `http://127.0.0.1:5001/${PROJECT_ID}/${REGION}/api`

/**
 * Sample receipt per Playwright project.
 *
 * POST /invoices is idempotent on the uploaded bytes (sha256 →
 * 409 `duplicate_image`, api.ts), and the chromium and mobile projects
 * upload into the SAME restaurant — so they must never send the same
 * file. One sample each, and any new scanning spec needs its own.
 *
 * These live in docs/samples/dummy/ (committed; docs/samples/real/ is the
 * gitignored customer corpus and must never be used here).
 */
const SAMPLES = path.join(__dirname, '..', 'docs', 'samples', 'dummy')
export const SAMPLE_RECEIPT: Record<string, string> = {
  chromium: path.join(SAMPLES, 'receipt-produce.jpg'),
  mobile: path.join(SAMPLES, 'receipt-bakery.jpg'),
}
