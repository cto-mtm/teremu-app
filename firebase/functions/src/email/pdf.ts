import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtractionPath } from "../models.js";

/**
 * Emailed PDFs (docs/email-ingestion.md §Documents and extraction paths):
 * the text layer when the PDF has one, page JPEGs always (Triage shows
 * the document; `vision` reads them).
 *
 * pdfjs-dist (legacy Node build) + @napi-rs/canvas: npm-only, prebuilt
 * binaries, no system packages — the same pair `real:prepare` renders the
 * client corpus with. Spike on that corpus (2026-10-21, 248 PDFs, Node
 * 22): pdfjs imports in ~130 ms; text extraction ~1 ms/doc (p95 ~50 ms);
 * a 1600px page renders in ~1.2 s to a ~180 KB JPEG; 88 documents have a
 * text layer on every page and 156 have none — every page sat either
 * at 0 characters or at ≥ 150, so the gate below falls in an empty gap.
 * That corpus is mostly scans an accountant collected; emailed PDFs
 * should skew more digital.
 *
 * Both libraries load lazily: most functions in this bundle never touch
 * a PDF, and pdfjs is the heaviest import we have.
 */

/** The multi-page invoice cap (api.ts MAX_INVOICE_PAGES). */
export const MAX_PDF_PAGES = 8;
/** A page counts as text when it has this many non-whitespace chars. */
const MIN_PAGE_CHARS = 150;
/** Longer text goes `vision` — it isn't one invoice. */
const MAX_TEXT_CHARS = 24_000;
const MAX_EDGE = 1600;
const JPEG_QUALITY = 80;

/** A password-protected or corrupt PDF, or an image that won't decode:
 * surfaces in Triage as `unreadable`, and costs no scan. */
export class UnreadableDocumentError extends Error {
  constructor(readonly reason: "password" | "corrupt") {
    super(`document_${reason}`);
    this.name = "UnreadableDocumentError";
  }
}

export interface PdfInspection {
  /** Pages in the file; only the first MAX_PDF_PAGES are used. */
  pageCount: number;
  truncated: boolean;
  path: Extract<ExtractionPath, "text_layer" | "vision">;
  /** Per page (used pages), only when path is text_layer. */
  text: string[] | null;
}

const require = createRequire(import.meta.url);
type Pdfjs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjs: Promise<Pdfjs> | null = null;
const loadPdfjs = (): Promise<Pdfjs> => (pdfjs ??= import("pdfjs-dist/legacy/build/pdf.mjs"));

function assetUrls(): { standardFontDataUrl: string; cMapUrl: string } {
  const root = dirname(require.resolve("pdfjs-dist/package.json"));
  // Trailing slash required: pdf.js concatenates file names onto these.
  return {
    standardFontDataUrl: pathToFileURL(join(root, "standard_fonts")).href + "/",
    cMapUrl: pathToFileURL(join(root, "cmaps")).href + "/",
  };
}

async function open(data: Buffer) {
  const { getDocument } = await loadPdfjs();
  // pdf.js takes ownership of (and detaches) the array it is given.
  const task = getDocument({ data: new Uint8Array(data), ...assetUrls(), cMapPacked: true, verbosity: 0 });
  try {
    return { task, pdf: await task.promise };
  } catch (err) {
    await task.destroy().catch(() => undefined);
    throw new UnreadableDocumentError((err as { name?: string }).name === "PasswordException" ? "password" : "corrupt");
  }
}

interface TextItem {
  str: string;
  transform: number[];
  width: number;
}

/** One page's text in reading order: items grouped into lines by their
 * baseline, lines top to bottom, items left to right, a tab across a
 * wide gap — so invoice table rows stay rows. */
function pageText(items: TextItem[]): string {
  const lines = new Map<number, TextItem[]>();
  for (const it of items) {
    // pdf.js adds whitespace items that span a column gap; measuring the
    // gap between real items is what tells a tab from a space.
    if (!it.str.trim()) continue;
    const key = Math.round(it.transform[5] / 3);
    const line = lines.get(key) ?? [];
    line.push(it);
    lines.set(key, line);
  }
  return [...lines.entries()]
    .sort(([a], [b]) => b - a)
    .map(([, line]) => {
      line.sort((a, b) => a.transform[4] - b.transform[4]);
      let out = "";
      let end = -Infinity;
      for (const it of line) {
        const x = it.transform[4];
        if (out) out += x - end > 12 ? "\t" : x - end > 1 ? " " : "";
        out += it.str;
        end = x + it.width;
      }
      return out.trimEnd();
    })
    .filter(Boolean)
    .join("\n");
}

/** Text layer + extraction path for a PDF. Throws UnreadableDocumentError. */
export async function inspectPdf(data: Buffer): Promise<PdfInspection> {
  const { task, pdf } = await open(data);
  try {
    const used = Math.min(pdf.numPages, MAX_PDF_PAGES);
    const text: string[] = [];
    for (let n = 1; n <= used; n += 1) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      text.push(pageText(content.items.filter((it): it is TextItem & typeof it => "str" in it)));
      page.cleanup();
    }
    const allText = text.every((t) => t.replace(/\s/g, "").length >= MIN_PAGE_CHARS) && text.some((t) => /\d/.test(t));
    const fits = text.reduce((n, t) => n + t.length, 0) <= MAX_TEXT_CHARS;
    const textLayer = allText && fits;
    return { pageCount: pdf.numPages, truncated: pdf.numPages > used, path: textLayer ? "text_layer" : "vision", text: textLayer ? text : null };
  } finally {
    await task.destroy();
  }
}

/** A photographed invoice attached to a mail (JPEG or PNG, any size) as
 * the page the vision path reads: JPEG, long edge ≤ 1600px — the same
 * ceiling as a rendered PDF page. Throws UnreadableDocumentError. */
export async function normalizeImage(data: Buffer): Promise<Buffer> {
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  let image: Awaited<ReturnType<typeof loadImage>>;
  try {
    image = await loadImage(data);
  } catch {
    throw new UnreadableDocumentError("corrupt");
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(image.width, image.height));
  const canvas = createCanvas(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff"; // a PNG's transparency would turn black
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.encode("jpeg", JPEG_QUALITY);
}

/** One JPEG per page (first MAX_PDF_PAGES), long edge ≤ 1600px — the
 * same ceiling as the app's downscaleReceipt, which is what keeps a page
 * at ~1.5K image tokens on the vision path. Throws UnreadableDocumentError. */
export async function rasterizePdf(data: Buffer): Promise<Buffer[]> {
  const { createCanvas } = await import("@napi-rs/canvas");
  const { task, pdf } = await open(data);
  try {
    const pages: Buffer[] = [];
    for (let n = 1; n <= Math.min(pdf.numPages, MAX_PDF_PAGES); n += 1) {
      const page = await pdf.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: MAX_EDGE / Math.max(base.width, base.height) });
      const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
      const ctx = canvas.getContext("2d");
      // Digital PDFs are transparent — JPEG would turn that black.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport, canvas: canvas as unknown as HTMLCanvasElement }).promise;
      pages.push(await canvas.encode("jpeg", JPEG_QUALITY));
      page.cleanup();
    }
    return pages;
  } finally {
    await task.destroy();
  }
}
