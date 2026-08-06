/**
 * Downscale a captured receipt to a ≤1600px JPEG in a SINGLE encode
 * (encode-once best practice: no intermediate JPEG generation, so no
 * stacked compression artifacts). Accepts the scanner's canvas directly
 * or a gallery File/Blob.
 *
 * Browser-only (uses canvas + createImageBitmap) — extracted from
 * domain.ts so the pure-math module stays importable in Node/test.
 */
export async function compressReceipt(source: Blob | HTMLCanvasElement): Promise<Blob> {
  const image = source instanceof Blob ? await createImageBitmap(source) : source
  const scale = Math.min(1, 1600 / Math.max(image.width, image.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(image.width * scale)
  canvas.height = Math.round(image.height * scale)
  canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height)
  if (source instanceof ImageBitmap) source.close?.()
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('encode failed'))),
      'image/jpeg',
      0.85,
    ),
  )
}
