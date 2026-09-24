/**
 * Real-corpus prep: turn each client PDF into the JPEG pages the app
 * would actually upload, plus a manifest the eval, the real-corpus
 * integration suite and the prod seed all read.
 *
 *   npm run real:prepare            (renders only what is missing)
 *   npm run real:prepare -- --force (re-render everything — orphans every
 *                                    recorded model reply, see below)
 *
 * Pages mirror app/src/lib/compress.ts: ≤1600px long edge, JPEG q85, so
 * the eval measures what a user's phone sends, not a 300-dpi ideal.
 *
 * Rendered bytes are CANONICAL once written: recorded model replies
 * (cassettes) are keyed by the sha256 of these exact bytes, and a
 * re-render on another machine / pdf.js version produces different
 * bytes. So this never overwrites a page unless --force.
 *
 * Everything lands under docs/samples/real/ — gitignored with the PDFs.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { CORPUS_DIR, DERIVED_DIR, MANIFEST_PATH, parseFilename } from "./corpus.mjs";

const MAX_EDGE = 1600; // compress.ts
const QUALITY = 85; // compress.ts (0.85)
const force = process.argv.includes("--force");

const require = createRequire(import.meta.url);
const pdfjsRoot = dirname(require.resolve("pdfjs-dist/package.json"));
// Trailing slash required: pdf.js concatenates file names onto these.
const standardFontDataUrl = pathToFileURL(join(pdfjsRoot, "standard_fonts")).href + "/";
const cMapUrl = pathToFileURL(join(pdfjsRoot, "cmaps")).href + "/";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function renderPdf(file, outDir) {
  const data = new Uint8Array(readFileSync(join(CORPUS_DIR, file)));
  const task = getDocument({ data, standardFontDataUrl, cMapUrl, cMapPacked: true, verbosity: 0 });
  const pdf = await task.promise;
  const pages = [];
  let textChars = 0;
  for (let n = 1; n <= pdf.numPages; n += 1) {
    const page = await pdf.getPage(n);
    const text = await page.getTextContent();
    textChars += text.items.reduce((s, it) => s + (it.str?.trim().length ?? 0), 0);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: MAX_EDGE / Math.max(base.width, base.height) });
    const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
    const ctx = canvas.getContext("2d");
    // Digital PDFs are transparent — JPEG would turn that black.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, canvas }).promise;
    const jpeg = await canvas.encode("jpeg", QUALITY);
    const rel = `pages/${outDir}/p${n}.jpg`;
    writeFileSync(join(DERIVED_DIR, rel), jpeg);
    pages.push({ path: rel, sha256: sha256(jpeg), bytes: jpeg.length, width: canvas.width, height: canvas.height });
    page.cleanup();
  }
  await task.destroy();
  return { pages, textLayer: textChars > 50 };
}

async function main() {
  if (!existsSync(CORPUS_DIR)) {
    console.error(`No corpus at ${CORPUS_DIR} — the real samples are not on this machine.`);
    process.exit(1);
  }
  mkdirSync(join(DERIVED_DIR, "pages"), { recursive: true });
  const previous = existsSync(MANIFEST_PATH) ? JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) : { docs: [] };
  const byFile = new Map(previous.docs.map((d) => [d.file, d]));

  const files = readdirSync(CORPUS_DIR).filter((f) => f.toLowerCase().endsWith(".pdf")).sort();
  const docs = [];
  let rendered = 0;
  for (const file of files) {
    const pdfSha256 = sha256(readFileSync(join(CORPUS_DIR, file)));
    const meta = parseFilename(file);
    const prior = byFile.get(file);
    const pagesPresent = prior?.pages.every((p) => existsSync(join(DERIVED_DIR, p.path)));
    if (!force && prior && prior.pdfSha256 === pdfSha256 && pagesPresent) {
      docs.push(prior);
      continue;
    }
    mkdirSync(join(DERIVED_DIR, "pages", meta.id), { recursive: true });
    const { pages, textLayer } = await renderPdf(file, meta.id);
    docs.push({ ...meta, file, pdfSha256, textLayer, pages });
    rendered += 1;
    process.stdout.write(`\r  rendered ${rendered}  ${file.slice(0, 60).padEnd(60)}`);
  }
  // Two PDFs with identical page bytes would collide in the dedup path
  // and in the cassette store — surface it rather than debug it later.
  const seen = new Map();
  for (const d of docs) {
    for (const p of d.pages) {
      if (seen.has(p.sha256)) console.warn(`\n  ⚠ identical page bytes: ${d.file} ≡ ${seen.get(p.sha256)}`);
      seen.set(p.sha256, d.file);
    }
  }
  writeFileSync(
    MANIFEST_PATH,
    JSON.stringify({ render: { maxEdge: MAX_EDGE, quality: QUALITY }, docs }, null, 1),
  );
  const multi = docs.filter((d) => d.pages.length > 1).length;
  console.log(
    `\n✓ ${docs.length} docs (${rendered} rendered now, ${multi} multi-page, ${docs.filter((d) => d.textLayer).length} with a text layer) → ${MANIFEST_PATH}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
