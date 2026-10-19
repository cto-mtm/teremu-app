/**
 * check-ports.mjs — the guard that runs before every test boot (wired
 * into the test and e2e scripts). Dependency-free ESM so it runs in a
 * fresh clone before anything is installed.
 *
 * It enforces two things, and fails LOUDLY with a one-line reason that
 * names the port and what it is for — the whole point is that a test
 * never silently connects to another project's emulator.
 *
 *   1. firebase/firebase.json still matches ports.json, key by key
 *      (port values only — enabled/host/singleProjectMode are ignored).
 *      firebase.json is the one other copy of the ports (the Firebase
 *      CLI can read nothing else); this keeps the two in lockstep.
 *
 *   2. The emulator ports are usable for the run that is about to start:
 *        --mode exec     (tests boot their OWN emulators): every port
 *                        must be FREE, on both 127.0.0.1 and ::1.
 *        --mode connect  (tests use ALREADY-RUNNING emulators): the
 *                        ports must belong to THIS project — ask the
 *                        emulator hub and check its list matches
 *                        ports.json. If the hub is silent or lists other
 *                        ports, another project holds them.
 *
 * Usage:
 *   node scripts/check-ports.mjs              # config check only
 *   node scripts/check-ports.mjs --mode exec
 *   node scripts/check-ports.mjs --mode connect
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createConnection } from 'node:net'
import { emulators, ports, PORTS_FILE } from './lib/ports.mjs'

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const FIREBASE_JSON = join(REPO_ROOT, 'firebase', 'firebase.json')

const argv = process.argv.slice(2)
const modeArg = argv.find((a) => a === '--mode' || a.startsWith('--mode='))
const mode = modeArg
  ? modeArg.includes('=')
    ? modeArg.slice('--mode='.length)
    : argv[argv.indexOf(modeArg) + 1]
  : 'config'

if (!['config', 'exec', 'connect'].includes(mode)) {
  fail(`unknown --mode "${mode}" (expected config, exec or connect)`)
}

/** Collected failures — report them all at once, then exit non-zero. */
const errors = []
function note(msg) {
  errors.push(msg)
}
function fail(msg) {
  console.error(`\n[check-ports] ${msg}\n`)
  process.exit(1)
}

// ── 0. Node version (warning only) ──────────────────────────────────
// The repo pins Node in .nvmrc (the functions' engines say the same).
// On Windows, Node 23+ has a libuv race that aborts a process outright
// ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file
// src\win\async.c", exit code 3221226505 / 0xC0000409). When it hits
// the Firebase CLI mid-suite, the in-process Functions emulator dies
// with it: every later test fails in milliseconds and an orphaned
// Firestore emulator keeps the ports. A vitest worker hitting it shows
// up as "Worker exited unexpectedly". Not blocking — just say so.
try {
  const pinned = readFileSync(join(REPO_ROOT, '.nvmrc'), 'utf8').trim().replace(/^v/, '').split('.')[0]
  const running = process.versions.node.split('.')[0]
  if (pinned && running !== pinned) {
    console.warn(
      `[check-ports] ⚠ Running Node ${process.versions.node}, but .nvmrc pins ${pinned}.` +
        (process.platform === 'win32' && Number(running) >= 23
          ? ` On Windows, Node ${running} can abort the emulators mid-run (libuv UV_HANDLE_CLOSING) — switch to Node ${pinned} if the suite flakes.`
          : ''),
    )
  }
} catch {
  // no .nvmrc: nothing to compare against
}

// ── 1. firebase.json ↔ ports.json ───────────────────────────────────
//
// ports.json name  →  where its port lives in firebase.json's emulators
// block. Everything maps straight across by name; the one special case
// is firestoreWebsocket → firestore.websocketPort.
const firebase = JSON.parse(readFileSync(FIREBASE_JSON, 'utf8'))
const fbEmu = firebase.emulators ?? {}

/** The port firebase.json declares for a ports.json emulator name. */
function firebasePortFor(name) {
  if (name === 'firestoreWebsocket') return fbEmu.firestore?.websocketPort
  return fbEmu[name]?.port
}

for (const [name, want] of Object.entries(emulators)) {
  const got = firebasePortFor(name)
  if (got === undefined) {
    note(
      `firebase.json is missing the ${name} emulator port — ports.json declares ${name}=${want}. ` +
        `Add it (${name === 'firestoreWebsocket' ? 'firestore.websocketPort' : `${name}.port`}).`,
    )
  } else if (got !== want) {
    note(
      `firebase.json ${name} port is ${got} but ports.json says ${want}. ` +
        `ports.json is the source of truth — fix firebase.json.`,
    )
  }
}

// Fail too if firebase.json lists an emulator PORT that ports.json does
// not (a port the project opens but CodePipe cannot see). `singleProjectMode`
// and the like carry no port, so they are naturally skipped.
const KNOWN_NON_PORT = new Set(['singleProjectMode'])
for (const [fbName, cfg] of Object.entries(fbEmu)) {
  if (KNOWN_NON_PORT.has(fbName)) continue
  if (cfg && typeof cfg === 'object' && typeof cfg.port === 'number') {
    if (!(fbName in emulators)) {
      note(
        `firebase.json declares the ${fbName} emulator (port ${cfg.port}) but ports.json does not list it. ` +
          `Add "${fbName}" to ports.json so CodePipe can reserve it.`,
      )
    }
    // The firestore websocket port rides inside the firestore entry.
    if (fbName === 'firestore' && typeof cfg.websocketPort === 'number' && !('firestoreWebsocket' in emulators)) {
      note(
        `firebase.json sets firestore.websocketPort=${cfg.websocketPort} but ports.json has no "firestoreWebsocket". ` +
          `Add it to ports.json.`,
      )
    }
  }
}

if (errors.length) {
  console.error('\n[check-ports] firebase.json and ports.json disagree:')
  for (const e of errors) console.error(`  • ${e}`)
  console.error(`\n  ports.json:    ${PORTS_FILE}`)
  console.error(`  firebase.json: ${FIREBASE_JSON}\n`)
  process.exit(1)
}
console.log(`[check-ports] firebase.json matches ports.json (${Object.keys(emulators).length} emulator ports).`)

// ── 2. Runtime port state ───────────────────────────────────────────

/** True if something is LISTENING on host:port (a short connect probe). */
function isListening(host, port, timeoutMs = 700) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port })
    const done = (listening) => {
      socket.destroy()
      resolve(listening)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false)) // refused / unreachable → free
  })
}

/** A port is free only if NOTHING answers on either loopback family —
 * an emulator bound to ::1 would still collide with one bound to
 * 0.0.0.0, so both are checked. */
async function portFree(port) {
  const [v4, v6] = await Promise.all([isListening('127.0.0.1', port), isListening('::1', port)])
  return !v4 && !v6
}

if (mode === 'exec') {
  const busy = []
  for (const [name, port] of Object.entries(emulators)) {
    if (!(await portFree(port))) busy.push({ name, port })
  }
  if (busy.length) {
    console.error('\n[check-ports] Ports needed to BOOT the emulators are already in use:')
    for (const { name, port } of busy) {
      console.error(`  • ${port} (${name} emulator) is taken — free it or stop whatever is on it.`)
    }
    console.error(
      '\n  These tests start their own emulators, so every port must be free.\n' +
        '  On Windows: node scripts/lib/kill-emulator-ports.mjs\n',
    )
    process.exit(1)
  }
  console.log('[check-ports] All emulator ports are free — safe to boot.')
  process.exit(0)
}

if (mode === 'connect') {
  // Ask the emulator hub whose emulators are running. If the ports we
  // are about to connect to belong to ANOTHER project, the hub either
  // will not answer here (its own hub port is free / someone else's) or
  // will list different ports — either way, refuse.
  const hubPort = emulators.hub
  let listed
  try {
    const res = await fetch(`http://127.0.0.1:${hubPort}/emulators`, {
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) throw new Error(`hub responded ${res.status}`)
    listed = await res.json()
  } catch (err) {
    fail(
      `the emulator hub did not answer on 127.0.0.1:${hubPort} (${err?.message ?? err}). ` +
        `Either this project's emulators are not running, or another project holds these ports. ` +
        `Start them (cd firebase && npm run emulators) or run the tests in one-shot mode.`,
    )
  }

  // The hub keys its entries by the Firebase emulator name. Map each
  // ports.json name across (firestoreWebsocket rides inside firestore's
  // webSocketPort) and confirm the hub reports OUR port for it.
  const mismatches = []
  for (const [name, want] of Object.entries(emulators)) {
    if (name === 'firestoreWebsocket') {
      const got = listed.firestore?.webSocketPort ?? listed.firestore?.websocketPort
      if (got !== want) {
        mismatches.push(`firestore websocket: hub says ${got ?? 'absent'}, ports.json says ${want}`)
      }
      continue
    }
    const entry = listed[name]
    if (!entry) {
      // ui/logging may be absent from the hub listing depending on the
      // set that was started; only treat a WRONG port as a hard failure,
      // and a missing core emulator (auth/functions/firestore/storage).
      if (['auth', 'functions', 'firestore', 'storage', 'hub'].includes(name)) {
        mismatches.push(`${name}: not reported by the hub (expected port ${want})`)
      }
      continue
    }
    if (entry.port !== want) {
      mismatches.push(`${name}: hub says ${entry.port}, ports.json says ${want}`)
    }
  }

  if (mismatches.length) {
    console.error(
      `\n[check-ports] The emulators answering on these ports are NOT this project's ` +
        `(hub on 127.0.0.1:${hubPort} reports a different set):`,
    )
    for (const m of mismatches) console.error(`  • ${m}`)
    console.error(
      '\n  Another project likely holds these ports. Stop it, or let this project ' +
        'boot its own emulators.\n',
    )
    process.exit(1)
  }
  console.log(`[check-ports] The running emulators belong to this project (hub on ${hubPort}).`)
  process.exit(0)
}

// mode === 'config': the firebase.json ↔ ports.json check above is all.
process.exit(0)
