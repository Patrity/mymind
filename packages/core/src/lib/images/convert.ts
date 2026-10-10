import sharp from 'sharp'

export interface Processed { buffer: Buffer, mime: string, ext: string, kind: 'image'|'gif'|'video', width?: number, height?: number }

const RASTER = ['image/png','image/jpeg','image/jpg','image/webp','image/avif','image/tiff','image/bmp']

/** Allowlisted video MIME types that may be stored as-is (passthrough). */
const SAFE_VIDEO_MIMES = ['video/mp4', 'video/webm', 'video/quicktime'] as const
/** Maps allowlisted video mime → file extension. */
const VIDEO_EXT_MAP: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov'
}

export async function processUpload(buffer: Buffer, mime: string, _name?: string): Promise<Processed> {
  if (mime.startsWith('video/')) {
    if (!(SAFE_VIDEO_MIMES as readonly string[]).includes(mime)) {
      throw new Error(`Unsupported video type: ${mime}`)
    }
    const ext = VIDEO_EXT_MAP[mime]!
    return { buffer, mime, ext, kind: 'video' }
  }
  if (mime === 'image/gif') {
    // convert animated gif -> animated webp
    const out = await sharp(buffer, { animated: true }).webp({ quality: 80 }).toBuffer()
    const meta = await sharp(out, { animated: true }).metadata()
    return { buffer: out, mime: 'image/webp', ext: 'webp', kind: 'gif', width: meta.width, height: meta.pageHeight ?? meta.height }
  }
  if (RASTER.includes(mime)) {
    const out = await sharp(buffer).rotate().webp({ quality: 82 }).toBuffer()  // rotate() applies EXIF orientation
    const meta = await sharp(out).metadata()
    return { buffer: out, mime: 'image/webp', ext: 'webp', kind: 'image', width: meta.width, height: meta.height }
  }
  // For everything else (svg, text/html, unknown, etc.) — attempt rasterisation via sharp.
  // If sharp can decode it (e.g. SVG → raster), store as webp/image.
  // If sharp cannot decode it (not an image), throw so the upload route returns 415.
  try {
    const out = await sharp(buffer).rotate().webp({ quality: 82 }).toBuffer()
    const meta = await sharp(out).metadata()
    return { buffer: out, mime: 'image/webp', ext: 'webp', kind: 'image', width: meta.width, height: meta.height }
  } catch {
    throw new Error(`Unsupported media type: ${mime}`)
  }
}
