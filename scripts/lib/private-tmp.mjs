/**
 * A temp dir private to this repo, for the Firebase emulators.
 *
 * The Storage emulator keeps its blobs in `<os tmpdir>/firebase/storage/blobs`
 * and wipes/recreates that dir on every boot. Two emulator runs on one
 * machine — even for different projects (another repo's `emulators:exec`) —
 * share it, so one run starting deletes the other's blobs mid-test and
 * crashes its Storage emulator (`ENOENT … storage/blobs/…` → "An unexpected
 * error has occurred", every later test fails). Pointing TEMP/TMP at a
 * per-repo dir keeps the runs apart.
 *
 * As a CLI it runs the rest of its argv with that env:
 *   node scripts/lib/with-private-tmp.mjs <command…>
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Env overrides that move os.tmpdir() into `<repo>/.tmp/emulators`. */
export function privateTmpEnv() {
  const dir = path.join(root, '.tmp', 'emulators')
  fs.mkdirSync(dir, { recursive: true })
  return { TEMP: dir, TMP: dir, TMPDIR: dir }
}
