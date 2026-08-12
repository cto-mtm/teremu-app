/**
 * Kill any processes occupying the Firebase emulator ports.
 * Called before the pre-deploy test gate (emulators:exec) to avoid
 * "port taken" failures when a previous dev session left emulators running.
 *
 * Usage: node scripts/lib/kill-emulator-ports.mjs
 */
import { execSync } from 'node:child_process'

// Auth, Firestore, Functions, Storage (matches firebase/firebase.json emulator config)
const PORTS = [9099, 8080, 5001, 9199]

let killed = 0

for (const port of PORTS) {
  try {
    // netstat finds the PID; taskkill ends it. Silently skip if nothing is listening.
    const output = execSync(
      `netstat -ano | findstr ":${port}" | findstr "LISTENING"`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    )
    const pids = new Set(
      output.split('\n')
        .map(line => line.trim().split(/\s+/).pop())
        .filter(pid => pid && /^\d+$/.test(pid))
    )
    for (const pid of pids) {
      try {
        execSync(`taskkill /F /PID ${pid}`, { stdio: 'pipe' })
        killed++
      } catch { /* already gone */ }
    }
  } catch {
    // No process on this port — fine
  }
}

if (killed > 0) {
  console.log(`[kill-ports] Freed ${killed} process(es) on emulator ports [${PORTS.join(', ')}]`)
  // Brief pause for OS to release the ports
  await new Promise(r => setTimeout(r, 1500))
} else {
  console.log('[kill-ports] Emulator ports are free.')
}
