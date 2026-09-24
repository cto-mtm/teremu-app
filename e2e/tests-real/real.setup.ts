/**
 * Seeds the recorded real month into the signed-in owner's restaurant
 * (emulator only) and leaves the seed's per-document summary at
 * SEEDED_PATH for the specs to assert against. Runs after auth.setup.ts,
 * so the owner's restaurant already exists.
 *
 * Seeding goes through scripts/real-samples/seed-account.ts — the exact
 * code that seeds production — instead of uploading through the browser:
 * the client re-encodes every upload, so browser bytes can never match a
 * recorded model reply (see docs/real-samples.md).
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { test as setup } from '@playwright/test'
import { TEST_OWNER } from '../constants'
import { REAL_CORPUS_PRESENT, REPO_ROOT, SEEDED_PATH } from './real'

setup('seed the real month into the emulator', async () => {
  setup.skip(!REAL_CORPUS_PRESENT, 'real corpus not on this machine (docs/real-samples.md)')
  setup.setTimeout(10 * 60_000)
  const tsx = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  execFileSync(
    process.execPath,
    [
      tsx,
      path.join(REPO_ROOT, 'scripts', 'real-samples', 'seed-account.ts'),
      '--emulator',
      '--email', TEST_OWNER.email,
      // Free plans show 90 days; the month is Apr–Aug.
      '--grant-plan', 'max',
      '--apply',
      '--out', SEEDED_PATH,
      // Which recorded model set to seed — required once several exist.
      ...(process.env.TEREMU_REAL_MODEL ? ['--model', process.env.TEREMU_REAL_MODEL] : []),
    ],
    { cwd: REPO_ROOT, stdio: 'inherit' },
  )
})
