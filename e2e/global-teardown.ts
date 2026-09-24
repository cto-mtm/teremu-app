/**
 * Global teardown — collects video recordings from test-results/ into a
 * flat recordings/ directory, one file per test per project. Overwrites
 * previous recordings so the folder always reflects the latest run.
 *
 * Playwright's own layout buries each video one directory deep under a
 * hashed folder name; this flattens it to something you can scrub through
 * without hunting:
 *   pantry-create-ingredient-cr-1a2b3-ent-with-a-starting-price-chromium.webm
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TEST_RESULTS = path.join(__dirname, 'test-results')
const RECORDINGS = path.join(__dirname, 'recordings')

function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
}

async function globalTeardown() {
  if (!fs.existsSync(TEST_RESULTS)) return

  // Ensure recordings/ exists and is empty (fresh each run)
  if (fs.existsSync(RECORDINGS)) {
    fs.rmSync(RECORDINGS, { recursive: true })
  }
  fs.mkdirSync(RECORDINGS, { recursive: true })

  let count = 0
  const dirs = fs.readdirSync(TEST_RESULTS, { withFileTypes: true })

  for (const dir of dirs) {
    if (!dir.isDirectory()) continue

    const resultDir = path.join(TEST_RESULTS, dir.name)
    const video = fs.readdirSync(resultDir).find((f) => f.endsWith('.webm'))
    if (!video) continue

    // The directory name already encodes spec + test + project; slugifying
    // it wholesale keeps the project suffix (…-chromium / …-mobile /
    // …-setup) that tells the two passes apart.
    fs.copyFileSync(path.join(resultDir, video), path.join(RECORDINGS, `${slugify(dir.name)}.webm`))
    count++
  }

  if (count > 0) {
    console.log(`[e2e] Collected ${count} recording(s) into recordings/`)
  }
}

export default globalTeardown
