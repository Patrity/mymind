import sharp from 'sharp'

const DEFAULT_MAX_PAGES = 8
const DEFAULT_MAX_EDGE = 1600

/**
 * Render the first N pages of a PDF to webp images so a vision model can SEE the document
 * (vLLM forwards image parts only — no file part). Pure + never-throws: returns [] on any
 * failure (corrupt PDF, render/native error). Caps page count + resolution to bound tokens.
 */
export async function renderPdfToImages(
  bytes: Buffer,
  opts: { maxPages?: number; maxEdge?: number } = {}
): Promise<{ bytes: Buffer; mime: 'image/webp' }[]> {
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES
  const maxEdge = opts.maxEdge ?? DEFAULT_MAX_EDGE
  if (maxPages <= 0) return []
  const out: { bytes: Buffer; mime: 'image/webp' }[] = []
  try {
    const { pdf } = await import('pdf-to-img')
    const doc = await pdf(new Uint8Array(bytes), { scale: 2 })
    for await (const pagePng of doc) {
      const webp = await sharp(pagePng)
        .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer()
      out.push({ bytes: webp, mime: 'image/webp' })
      if (out.length >= maxPages) break
    }
  } catch {
    return []
  }
  return out
}
