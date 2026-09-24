/**
 * Rasterize a PDF invoice into one canvas per page, on device.
 *
 * The API only takes image bodies (POST /invoices is a raw image/jpeg)
 * and the server-side rasterizer is still a design (docs/email-ingestion.md),
 * so a PDF picked in the scanner becomes N page images that ride the
 * exact camera pipeline: canvas → compressReceipt → upload. Same output
 * geometry as scripts/real-samples/prepare.mjs (1600px long edge, white
 * background), so a PDF scanned here matches the real-corpus fixtures.
 *
 * pdf.js is ~1 MB, so it is imported lazily — the scanner's first paint
 * never pays for it, and the chunk only loads once a PDF is picked.
 */

/**
 * Pages past this are dropped. Mirrors MAX_INVOICE_PAGES in
 * firebase/functions/src/api.ts — /invoices/:id/pages refuses the 9th
 * page, so rendering more would only turn into a failed upload.
 */
export const PDF_MAX_PAGES = 8

const MAX_EDGE = 1600 // compress.ts downscales to this anyway; render straight to it

export interface RenderedPdf {
  pages: HTMLCanvasElement[]
  /** Page count of the document — larger than `pages.length` when capped. */
  total: number
}

export const isPdf = (file: File): boolean =>
  file.type === 'application/pdf' || /\.pdf$/i.test(file.name)

export async function renderPdfPages(file: Blob, maxPages = PDF_MAX_PAGES): Promise<RenderedPdf> {
  const [pdfjs, { default: workerUrl }] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ])
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) })
  try {
    const pdf = await task.promise
    const pages: HTMLCanvasElement[] = []
    const n = Math.min(pdf.numPages, maxPages)
    for (let i = 1; i <= n; i += 1) {
      const page = await pdf.getPage(i)
      const base = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({ scale: MAX_EDGE / Math.max(base.width, base.height) })
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(viewport.width)
      canvas.height = Math.round(viewport.height)
      // pdf.js paints its default white background first, so a digital
      // (transparent) PDF doesn't come out black after the JPEG encode.
      await page.render({ canvas, viewport }).promise
      page.cleanup()
      pages.push(canvas)
    }
    return { pages, total: pdf.numPages }
  } finally {
    await task.destroy()
  }
}
