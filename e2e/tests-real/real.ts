/**
 * Shared bits for the real-data specs: where the corpus is, where the
 * seed summary lands, and a typed reader for it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const REAL_CORPUS_PRESENT = fs.existsSync(
  path.join(REPO_ROOT, 'docs', 'samples', 'real', '_derived', 'manifest.json'),
)
/** Next to the auth state — gitignored with it, and it names client vendors. */
export const SEEDED_PATH = path.join(REPO_ROOT, 'e2e', 'playwright', '.real', 'seeded.json')

export interface SeededDoc {
  file: string
  invoiceId: string
  status: 'needs_review' | 'failed'
  error: string | null
  docType: 'invoice' | 'delivery_note'
  vendorName: string | null
  invoiceDate: string | null
  total: number | null
  lines: number
  lineSum: number
  pages: number
}

export function readSeeded(): { rid: string; docs: SeededDoc[] } {
  return JSON.parse(fs.readFileSync(SEEDED_PATH, 'utf8'))
}
