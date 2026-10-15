/**
 * The one loader for the repo-root ports.json (see CLAUDE.md: never
 * hardcode a port). Every Node-side consumer — vite.config, the e2e and
 * functions test harnesses, the scripts — imports a port from here
 * rather than writing a number. The only other copy of the ports is
 * firebase/firebase.json, which the Firebase CLI reads directly and
 * which scripts/check-ports.mjs keeps in sync with this file.
 *
 * Browser code and deployed Cloud Functions code never import this:
 * the browser reaches the emulators through the Vite proxy (same
 * origin), and the functions directory deploys on its own, so a path
 * outside it would break the deploy — inside the emulator a function
 * gets FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST and the
 * like for free.
 *
 * Dependency-free ESM so check-ports.mjs (which runs before anything is
 * installed in a fresh gate) can import it too.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Walk up from this file to the repo root (the directory that holds
 * ports.json). Resolving by search rather than a fixed `../..` keeps
 * every caller working no matter how deep it sits.
 */
function findPortsFile() {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const candidate = join(dir, 'ports.json')
    try {
      readFileSync(candidate)
      return candidate
    } catch {
      const parent = dirname(dir)
      if (parent === dir) {
        throw new Error(
          'ports.json not found walking up from scripts/lib/ports.mjs — it must live at the repo root.',
        )
      }
      dir = parent
    }
  }
}

export const PORTS_FILE = findPortsFile()

/** @typedef {{ app: { vite: number, tailscale: number }, emulators: Record<string, number> }} Ports */

/** The parsed ports.json. @type {Ports} */
export const ports = JSON.parse(readFileSync(PORTS_FILE, 'utf8'))

export const app = ports.app
export const emulators = ports.emulators

/** host:port strings for the Admin SDK / firebase-tools env vars. */
export const emulatorHost = (name, host = '127.0.0.1') => `${host}:${emulators[name]}`
