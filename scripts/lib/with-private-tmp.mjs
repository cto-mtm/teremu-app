/** Run a command with the repo-private emulator temp dir — see private-tmp.mjs. */
import { spawnSync } from 'node:child_process'
import { privateTmpEnv } from './private-tmp.mjs'

const cmd = process.argv.slice(2).map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')
if (!cmd) {
  console.error('usage: node scripts/lib/with-private-tmp.mjs <command…>')
  process.exit(2)
}
const r = spawnSync(cmd, { shell: true, stdio: 'inherit', env: { ...process.env, ...privateTmpEnv() } })
process.exit(r.status ?? 1)
