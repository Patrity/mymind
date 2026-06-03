import { describe, it, expect } from 'vitest'
import sharp from 'sharp'
import { processUpload } from '../server/lib/images/convert'

describe('processUpload', () => {
  it('converts a raster PNG to webp and reports dims', async () => {
    const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer()
    const out = await processUpload(png, 'image/png', 'x.png')
    expect(out.mime).toBe('image/webp')
    expect(out.ext).toBe('webp')
    expect(out.kind).toBe('image')
    expect(out.width).toBe(40)
    expect(out.height).toBe(30)
    // webp magic bytes 'RIFF'....'WEBP'
    expect(out.buffer.subarray(0, 4).toString('ascii')).toBe('RIFF')
  })
  it('passes video through unchanged', async () => {
    const fake = Buffer.from('not really a video')
    const out = await processUpload(fake, 'video/mp4', 'v.mp4')
    expect(out.kind).toBe('video')
    expect(out.mime).toBe('video/mp4')
    expect(out.buffer).toBe(fake)
  })
})
