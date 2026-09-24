/**
 * Shared layout + loaders for the real-document corpus (see
 * docs/real-samples.md). Imported by the prep/eval/seed scripts AND the
 * real-corpus integration suite, so every consumer agrees on paths.
 *
 * docs/samples/real/                 gitignored as a whole
 *   *.pdf                            the client's documents, as delivered
 *   corpus.json                      buyer identity + per-vendor kind (hand-kept)
 *   golden.json                      ground truth per document (from the export)
 *   _derived/manifest.json           prepare.mjs output
 *   _derived/pages/<id>/pN.jpg       canonical upload bytes
 *   _derived/cassettes/<model>/<key>.json   recorded model replies (llm.ts), one set per model
 *   _derived/reports/                eval reports
 *   _derived/snapshots/              integration-suite file snapshots
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const CORPUS_DIR = process.env.TEREMU_REAL_CORPUS ?? join(REPO_ROOT, "docs/samples/real");
export const DERIVED_DIR = join(CORPUS_DIR, "_derived");
export const MANIFEST_PATH = join(DERIVED_DIR, "manifest.json");
export const CASSETTES_ROOT = join(DERIVED_DIR, "cassettes");
export const REPORTS_DIR = join(DERIVED_DIR, "reports");
export const SNAPSHOT_DIR = join(DERIVED_DIR, "snapshots");
export const CONFIG_PATH = join(CORPUS_DIR, "corpus.json");
export const GOLDEN_PATH = join(CORPUS_DIR, "golden.json");

/**
 * "Vendor - number - YYYY-MM-DD - <32 hex>.pdf". Parsed from the RIGHT:
 * doc numbers may themselves contain " - " ("AL 2673 - 2076").
 * Filename metadata is a hint, not truth (numbers are mangled by the
 * filename; one date reads 2021 — a typo carried from the accounting
 * export itself). golden.json overrides it.
 */
export function parseFilename(file) {
  const stem = file.replace(/\.pdf$/i, "");
  const parts = stem.split(" - ");
  const hash = parts.at(-1);
  const date = parts.at(-2);
  const vendor = parts[0].trim();
  const number = parts.slice(1, -2).join(" - ").trim();
  const ok = /^[0-9a-f]{32}$/.test(hash) && /^\d{4}-\d{2}-\d{2}$/.test(date);
  return {
    id: ok ? hash : stem.replace(/[^\w-]+/g, "_").slice(0, 80),
    fileVendor: vendor,
    fileNumber: number || null,
    fileDate: ok ? date : null,
  };
}

/** One cassette set per model: replies from two models must never mix. */
export const cassetteDirFor = (model) => join(CASSETTES_ROOT, model.replace(/[^\w.-]+/g, "_"));

/**
 * The recorded set to replay: `model` (a model id or its folder name)
 * when given, else the only set on disk. Throws with the choices.
 */
export function resolveCassetteDir(model) {
  const sets = existsSync(CASSETTES_ROOT)
    ? readdirSync(CASSETTES_ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    : [];
  if (model) {
    const dir = cassetteDirFor(model);
    if (!existsSync(dir)) throw new Error(`No recorded replies for ${model}. Recorded: ${sets.join(", ") || "none"}`);
    return dir;
  }
  if (sets.length === 1) return join(CASSETTES_ROOT, sets[0]);
  throw new Error(sets.length ? `Several models recorded — pass --model <${sets.join(" | ")}>` : "No recorded replies — run `npm run real:eval` first.");
}

/**
 * The pages the pipeline actually keeps for a document: POST
 * /invoices/:id/pages rejects a byte-identical repeat (409), so a PDF that
 * repeats a page reaches the model once — and cassette keys hash exactly
 * this list.
 */
export const uniquePages = (doc) => doc.pages.filter((p, i) => doc.pages.findIndex((q) => q.sha256 === p.sha256) === i);

/** Chronological, like a month of scanning; fixed so every run replays the same sequence. */
export const chronological = (docs) =>
  [...docs].sort((a, b) => `${a.fileDate ?? ""}${a.file}`.localeCompare(`${b.fileDate ?? ""}${b.file}`));

const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);

export const corpusPresent = () => existsSync(MANIFEST_PATH);
export const loadManifest = () => readJson(MANIFEST_PATH);
/** vendors is keyed by vendorKey(filename vendor): aliases = other names the
 * same business prints (trade vs legal name). Food vs expense comes from golden.
 * @returns {{ buyer: { name: string, aliases: string[] }, vendors: Record<string, { aliases?: string[] }> } | null} */
export const loadConfig = () => readJson(CONFIG_PATH);
/** @returns {{ docs: Record<string, { vendor?: string, vendorAliases?: string[], number?: string, date?: string, total?: number, docType?: string, kind?: string, verified?: boolean }> } | null} */
export const loadGolden = () => readJson(GOLDEN_PATH);

/** Loose vendor comparison: case/accents/legal-suffix/punctuation-insensitive. */
export function vendorKey(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['’`]/g, "") // Olivia's ≡ Olivias
    .replace(/\b(s\.?\s?l\.?(\s?u\.?)?|s\.?\s?a\.?|sl|slu|sa|s\.?l\.?c)\b\.?/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** True when two vendor strings name the same business (either contains the other's key). */
export function sameVendor(a, b) {
  const ka = vendorKey(a);
  const kb = vendorKey(b);
  if (!ka || !kb) return false;
  return ka === kb || ka.includes(kb) || kb.includes(ka);
}

/**
 * Did OCR read the right vendor for this document? Truth is golden's
 * vendor (else the filename's), plus any aliases from golden or
 * corpus.json. Single source for the eval and the integration suite.
 */
export function vendorMatches(read, doc, goldenDoc, config) {
  const truth = goldenDoc?.vendor ?? doc.fileVendor;
  const aliases = [
    ...(goldenDoc?.vendorAliases ?? []),
    ...(config?.vendors?.[vendorKey(doc.fileVendor)]?.aliases ?? []),
  ];
  return [truth, ...aliases].some((name) => sameVendor(read, name));
}
