/**
 * E2E runner — `npm run test:e2e` at the repo root lands here.
 *
 * Two modes:
 *  - Emulators already running (the normal dev loop): just runs Playwright
 *    against them. The Vite dev server is auto-started by Playwright's
 *    webServer config if it isn't up either.
 *  - Emulators down (one-shot / pre-deploy gate): builds shared +
 *    functions, then boots the emulator set via `firebase emulators:exec`
 *    (functions INCLUDED — the app's api and the OCR Storage trigger both
 *    run there) and runs Playwright inside it, tearing everything down
 *    afterwards. TEREMU_TEST_MOCKS=1 forces the offline OCR/billing mocks
 *    so a gate run is hermetic even on a machine holding real keys in
 *    functions/.secret.local — same trick firebase/package.json's `test`
 *    script uses for the integration suite.
 *
 * Extra CLI args pass through to Playwright (e.g. `--headed`, `--ui`).
 */
import { execSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { stage } from '../scripts/lib/stage.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const AUTH_EMULATOR = 'http://127.0.0.1:9099'
// Must match REGION in firebase/functions/src/region.ts.
const API_EMULATOR = 'http://127.0.0.1:5001/demo-app/us-east1/api'

// `--verbose` (ours, not Playwright's) turns on Playwright's per-action
// debug stream in the LOG FILE only. It is ~10x the log volume, so it is
// opt-in: reach for it when a failure needs an action-by-action replay,
// not for every run.
const argv = process.argv.slice(2).filter((a) => a !== '--verbose')
const verbose = process.argv.includes('--verbose')
const passthrough = argv.join(' ')

// ── Single-runner lock ──────────────────────────────────────────────────
// Two concurrent runs silently corrupt each other (each global-setup wipes
// the other's emulator data), so refuse to start while another run is alive.
const LOCK = path.join(__dirname, '.run.lock')

function lockedByLiveProcess() {
  try {
    const pid = Number(fs.readFileSync(LOCK, 'utf8'))
    process.kill(pid, 0) // throws if the PID is gone → stale lock
    return pid
  } catch {
    return null
  }
}

const holder = lockedByLiveProcess()
if (holder) {
  console.error(
    `\n[e2e] Another e2e run is already in progress (pid ${holder}).\n` +
      `      Two runs share the emulators and would wipe each other's data.\n` +
      `      Wait for it to finish — or if it's dead weight, kill it and rerun\n` +
      `      (the lock clears itself once the pid is gone).\n`,
  )
  process.exit(1)
}
fs.writeFileSync(LOCK, String(process.pid))
const releaseLock = () => {
  try {
    fs.unlinkSync(LOCK)
  } catch {
    /* already gone */
  }
}
process.on('exit', releaseLock)
process.on('SIGINT', () => {
  releaseLock()
  process.exit(130)
})

function run(cmd, cwd, env) {
  console.log(`[e2e] Executing: ${cmd} in ${cwd}`)
  execSync(cmd, { cwd, stdio: 'inherit', env: env ? { ...process.env, ...env } : process.env })
}

// The functions emulator narrates every api request ("Beginning
// execution…", "Finished…") and re-prints the secret warning per instance
// — dozens of lines interleaved with the test results. Drop exactly that
// noise; every other line (test results, real errors, emulator lifecycle)
// passes through.
const NOISE = [
  /functions: Beginning execution of/,
  /functions: Finished "/,
  /functions: Loaded environment variables from \.env/,
  /functions: Trying to access secret/,
  // Playwright's per-action debug stream (DEBUG=pw:api) — every click,
  // wait and assertion attempt. Gold in the log file, noise on the console.
  /^\s*pw:api/,
]
let inSecretWarning = false
function isNoise(line) {
  if (/functions: Unable to access secret environment variables/.test(line)) {
    inSecretWarning = true
    return true
  }
  if (inSecretWarning && /^\s+(FirebaseError:|at )/.test(line)) return true
  inSecretWarning = false
  return NOISE.some((re) => re.test(line))
}

// Terminal color escapes would defeat the substring matching above — strip
// them before testing (the raw line still goes to the log file).
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '')

/** Full raw output of the run — every line, timestamped, unfiltered.
 *  Written in BOTH modes (emulators already running or one-shot). */
export const RUN_LOG = path.join(__dirname, 'last-run.log')

/** "HH:MM:SS.mmm" — lets the log correlate Playwright actions with
 *  emulator/functions activity, which an untimestamped tee cannot. */
const ts = () => new Date().toISOString().slice(11, 23)

/**
 * Like run(), but tees the child's output: EVERY line goes to
 * last-run.log (timestamped), while the console gets only what survives
 * isNoise() — test results, emulator lifecycle, real errors.
 */
function runFiltered(cmd, cwd, env) {
  console.log(`[e2e] Executing: ${cmd} in ${cwd}`)
  console.log(`[e2e] Console shows results only — the full raw log streams to ${RUN_LOG}`)
  if (verbose) console.log('[e2e] --verbose: per-action pw:api detail goes to the log file')
  const log = fs.createWriteStream(RUN_LOG)
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, {
      cwd,
      shell: true,
      env: { ...process.env, ...(verbose ? { DEBUG: 'pw:api' } : {}), ...(env ?? {}) },
    })
    for (const stream of [child.stdout, child.stderr]) {
      readline.createInterface({ input: stream }).on('line', (line) => {
        const clean = stripAnsi(line)
        log.write(`${ts()} ${clean}\n`)
        if (!isNoise(clean)) console.log(line)
      })
    }
    child.on('error', (e) => {
      log.end()
      reject(e)
    })
    child.on('close', (code) => {
      log.end()
      console.log(`[e2e] Full raw log: ${RUN_LOG}`)
      code ? reject(new Error(`exit ${code}`)) : resolve()
    })
  })
}

async function up(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2000) })
    return true // any HTTP response counts — only a refused connection is down
  } catch {
    return false
  }
}

// Auth up without a WORKING api means a broken set: the whole app renders
// empty, so fail loudly instead of running a suite of doomed tests.
// NOTE: port 5001 answering is not enough — when the emulator failed to
// LOAD the function it still responds "Function ... does not exist", so
// check the body of the api's own public health route.
async function apiUp() {
  try {
    const res = await fetch(`${API_EMULATOR}/health`, { signal: AbortSignal.timeout(3000) })
    const body = await res.text()
    return res.ok && !/does not exist/i.test(body)
  } catch {
    return false
  }
}

try {
  const authUp = await up(`${AUTH_EMULATOR}/`)
  if (authUp && !(await apiUp())) {
    console.error(
      '\n[e2e] Emulators are up but the api function is NOT being served.\n' +
        '      Either the functions emulator is missing from the set, or it failed\n' +
        '      to load the code (look for "Failed to load function definition" in\n' +
        '      its output — the default 10s discovery timeout is easy to trip).\n' +
        '      Restart the full set (functions included):\n' +
        '        cd firebase && npm run emulators\n' +
        '      (npm run emulators builds functions first; emulators:watch does not.)\n',
    )
    process.exit(1)
  }
  if (authUp) {
    const s = stage('E2E: Playwright against the already-running emulators')
    // The local CLI via node, not npx — npx can stall on its registry check.
    const cli = path.join(root, 'node_modules', '@playwright', 'test', 'cli.js')
    const cmd = `node "${cli}" test${passthrough ? ' ' + passthrough : ''}`
    if (/--ui|--debug/.test(passthrough)) {
      // Interactive modes need the real TTY — no tee, no log file.
      run(cmd, __dirname)
    } else {
      await runFiltered(cmd, __dirname)
    }
    s.done('passed')
  } else {
    console.log(
      '[e2e] Emulators not running — one-shot mode: build functions, boot emulators, run, tear down.',
    )

    // Free ports in case a previous dev session left emulators half-alive
    run(`node "${path.join(root, 'scripts', 'lib', 'kill-emulator-ports.mjs')}"`, root)

    let s = stage('E2E 1/2: build shared + firebase/functions (the emulator serves the built api)')
    run('npm run build:functions', root)
    s.done()

    s = stage('E2E 2/2: boot emulators (functions included) + run Playwright')
    const inner = `npm --prefix ../e2e run test${passthrough ? ' -- ' + passthrough : ''}`
    await runFiltered(
      `npx firebase emulators:exec --project demo-app --only functions,firestore,auth,storage "${inner}"`,
      path.join(root, 'firebase'),
      {
        // Hermetic gate: ignore any real LLM/Stripe keys in
        // functions/.secret.local, exactly like the integration suite.
        TEREMU_TEST_MOCKS: '1',
        // The api bundle takes >10s to load on a cold Windows start, which
        // trips the functions emulator's default discovery timeout
        // ("Failed to load function definition ... Timeout after 10000")
        // and leaves the app with no backend. Give discovery a real budget
        // (value is in seconds).
        FUNCTIONS_DISCOVERY_TIMEOUT: '60',
      },
    )
    s.done('passed')
  }
} catch {
  process.exit(1)
}
