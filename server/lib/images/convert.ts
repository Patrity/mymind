import sharp from 'sharp'

export interface Processed { buffer: Buffer, mime: string, ext: string, kind: 'image'|'gif'|'video', width?: number, height?: number }

const RASTER = ['image/png','image/jpeg','image/jpg','image/webp','image/avif','image/tiff','image/bmp']

export async function processUpload(buffer: Buffer, mime: string, _name?: string): Promise<Processed> {
  if (mime.startsWith('video/')) {
    const ext = mime.split('/')[1] ?? 'bin'
    return { buffer, mime, ext, kind: 'video' }            // passthrough this cycle (ffmpeg->webm is a follow-up)
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
  // unknown: passthrough
  const ext = mime.split('/')[1] ?? 'bin'
  return { buffer, mime, ext, kind: 'image' }
}
