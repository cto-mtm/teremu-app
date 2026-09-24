/**
 * Global setup — verifies the emulator set is reachable AND actually
 * serving the api function (failing fast with a hint if not, mirroring the
 * integration suite's global-setup), then wipes Auth + Firestore for a
 * clean slate. This runs ONCE before all tests.
 *
 * It creates no data itself. Teremu bootstraps a solo restaurant with the
 * caller as owner on their FIRST authenticated request (tenancy.ts
 * ensureMemberships), so auth.setup.ts signing in through the UI is all
 * the seeding this suite needs — every spec builds its own state from
 * there, through the app.
 */
import {
  API_EMULATOR,
  AUTH_EMULATOR,
  FIRESTORE_EMULATOR,
  PROJECT_ID,
  STORAGE_EMULATOR,
} from './constants'

const EMULATORS = [
  { name: 'Auth', url: AUTH_EMULATOR },
  { name: 'Firestore', url: FIRESTORE_EMULATOR },
  // Receipt JPEGs land in Storage and the onReceiptUploaded trigger runs
  // OCR from there — without it, every scan sits in `processing` forever.
  { name: 'Storage', url: STORAGE_EMULATOR },
]

const START_HINT =
  '\n\n  Start the FULL emulator set first (functions included):\n' +
  '    cd firebase && npm run emulators\n' +
  '  (or stop the partial set and run one-shot from the repo root: npm run test:e2e)\n'

async function globalSetup() {
  console.log('[e2e] Running global setup...')

  for (const { name, url } of EMULATORS) {
    console.log(`[e2e] Checking ${name} emulator at ${url}...`)
    try {
      // Any HTTP response means the port is served; only a refused
      // connection or a timeout means the emulator is down.
      await fetch(`${url}/`, { signal: AbortSignal.timeout(3000) })
      console.log(`[e2e] ${name} emulator: OK`)
    } catch (e: any) {
      throw new Error(
        `[e2e] Firebase ${name} emulator not reachable at ${url}.${START_HINT}\n` +
          `  Error: ${e?.message ?? e}`,
      )
    }
  }

  // The api function needs its own check: when the functions emulator
  // failed to LOAD the code, port 5001 still answers — with
  // "Function ... does not exist" — and the app renders a connection error
  // on every screen. GET /health is the api's only public route.
  console.log(`[e2e] Checking the api function at ${API_EMULATOR}/health...`)
  let apiServing = false
  try {
    const res = await fetch(`${API_EMULATOR}/health`, { signal: AbortSignal.timeout(5000) })
    const body = await res.text()
    apiServing = res.ok && !/does not exist/i.test(body) && body.includes('"ok"')
  } catch {
    /* refused → not serving */
  }
  if (!apiServing) {
    throw new Error(
      `[e2e] The api function is not being served at ${API_EMULATOR}.\n` +
        `  Either the functions emulator is not in the running set, or it failed to\n` +
        `  load the code — look for "Failed to load function definition" in its\n` +
        `  output (the default 10s discovery timeout is easy to trip; the one-shot\n` +
        `  runner raises it via FUNCTIONS_DISCOVERY_TIMEOUT).\n` +
        `  Full set: cd firebase && npm run emulators`,
    )
  }
  console.log('[e2e] api function: OK')

  // Clean slate. Wiping Auth drops the test owner, which drops their
  // memberships claim to nothing — the next sign-in bootstraps a brand-new
  // restaurant, so no spec ever inherits the previous run's numbers.
  console.log('[e2e] Clearing emulator data...')
  await fetch(`${AUTH_EMULATOR}/emulator/v1/projects/${PROJECT_ID}/accounts`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(5000),
  })
  await fetch(
    `${FIRESTORE_EMULATOR}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`,
    { method: 'DELETE', signal: AbortSignal.timeout(5000) },
  )

  // Storage is deliberately NOT wiped: the emulator exposes no REST wipe,
  // and orphaned receipt JPEGs are inert once Firestore is empty — nothing
  // references them, and the new restaurant writes under a fresh
  // receipts/{rid}/ prefix. They vanish with the emulator process anyway.

  console.log('[e2e] Emulator data cleared. Fresh slate. Ready to run tests.')
}

export default globalSetup
