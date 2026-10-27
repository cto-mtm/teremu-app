/**
 * Single source of truth for the e2e suite's shared constants.
 * Everything that reads the test owner's identity, the saved auth state,
 * or an emulator URL imports from here — never redefine these locally.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { emulators } from '../scripts/lib/ports.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * The owner account auth.setup.ts creates through the Auth emulator's fake
 * Google account picker. Teremu has NO sign-up form: Google creates the
 * account on first sign-in, and the email/password door on /login only
 * opens admin-created accounts (seed CLI `--email`), so the emulator
 * widget is the way a brand-new owner gets in.
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

export const AUTH_EMULATOR = `http://127.0.0.1:${emulators.auth}`
export const FIRESTORE_EMULATOR = `http://127.0.0.1:${emulators.firestore}`
export const STORAGE_EMULATOR = `http://127.0.0.1:${emulators.storage}`
/** The api Cloud Function on the FUNCTIONS emulator — the app's dev
 *  BASE_URL (app/src/lib/api.ts). Auth/Firestore up but this down = every
 *  screen renders empty with a connection error. */
export const API_EMULATOR = `http://127.0.0.1:${emulators.functions}/${PROJECT_ID}/${REGION}/api`

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

/**
 * One photo per (scanning spec × project) beyond the golden path — same
 * rule as SAMPLE_RECEIPT: no file is ever uploaded twice into the shared
 * restaurant. Keyed by what the spec uses it for.
 */
export const SCAN_SAMPLES = {
  /** triage/dismiss-expense.spec.ts */
  dismiss: {
    chromium: path.join(SAMPLES, 'receipt-meat.jpg'),
    mobile: path.join(SAMPLES, 'receipt-seafood.jpg'),
  },
  /** triage/reconciliation.spec.ts — approved as the albarán */
  deliveryNote: {
    chromium: path.join(SAMPLES, 'delivery-note-albaran.jpg'),
    mobile: path.join(SAMPLES, 'receipt-thermal-dairy.jpg'),
  },
  /** triage/reconciliation.spec.ts — approved as the matching factura */
  invoice: {
    chromium: path.join(SAMPLES, 'receipt-beverage.jpg'),
    mobile: path.join(SAMPLES, 'receipt-spanish-factura.jpg'),
  },
  /** triage/link-ingredient.spec.ts */
  link: {
    chromium: path.join(SAMPLES, 'receipt-glare-shadow.jpg'),
    mobile: path.join(SAMPLES, 'receipt-handwritten.jpg'),
  },
  /** vendors/vendor-detail.spec.ts */
  vendor: {
    chromium: path.join(SAMPLES, 'receipt-demo-taqueria-produce.jpg'),
    mobile: path.join(SAMPLES, 'receipt-demo-pastry-fruit.jpg'),
  },
} satisfies Record<string, Record<string, string>>
