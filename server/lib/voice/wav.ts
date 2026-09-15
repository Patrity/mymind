import { Buffer } from 'node:buffer'

/**
 * Duration of a mono/stereo PCM WAV in milliseconds, read from its header.
 * Used to enforce the reference-clip limits: a reference consumes the same prompt
 * budget as the text, so its length is a correctness constraint, not a preference.
 *
 * Walks the RIFF chunk list from offset 12 rather than trusting the canonical 44-byte
 * layout: a `LIST`/`INFO` chunk before `data` (ffmpeg's default) or an 18-byte `fmt `
 * (WAVE_FORMAT_EXTENSIBLE) would otherwise put an unrelated u32 at the fixed `data`-size
 * offset. If that unrelated value happens to read small, an over-long reference clip
 * sails past the 60s gate and fails invisibly at the rig (200 OK, empty body) — exactly
 * the failure this function exists to prevent.
 */
export function wavDurationMs(buf: Buffer | Uint8Array): number {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  if (b.length < 12 || b.subarray(0, 4).toString('ascii') !== 'RIFF' || b.subarray(8, 12).toString('ascii') !== 'WAVE') {
    throw new Error('Not a RIFF/WAV file')
  }

  let channels: number | null = null
  let sampleRate: number | null = null
  let bitsPerSample: number | null = null
  let dataSize: number | null = null
  let dataOffset: number | null = null

  let offset = 12
  // Stop as soon as both chunks are found (regardless of order); otherwise scan to the
  // end of the buffer. Each chunk is [4-byte id][4-byte LE size][payload, padded to even].
  while (offset + 8 <= b.length && (channels === null || dataSize === null)) {
    const chunkId = b.subarray(offset, offset + 4).toString('ascii')
    const chunkSize = b.readUInt32LE(offset + 4)
    const payloadOffset = offset + 8

    if (chunkId === 'fmt ' && payloadOffset + 16 <= b.length) {
      channels = b.readUInt16LE(payloadOffset + 2)
      sampleRate = b.readUInt32LE(payloadOffset + 4)
      bitsPerSample = b.readUInt16LE(payloadOffset + 14)
    } else if (chunkId === 'data') {
      dataSize = chunkSize
      dataOffset = payloadOffset
    }

    offset = payloadOffset + chunkSize + (chunkSize % 2)
  }

  if (channels === null || sampleRate === null || bitsPerSample === null) {
    throw new Error('Malformed WAV header: no fmt chunk')
  }
  if (dataSize === null || dataOffset === null) {
    throw new Error('Malformed WAV header: no data chunk')
  }

  const bytesPerFrame = channels * (bitsPerSample / 8)
  if (!sampleRate || !bytesPerFrame) throw new Error('Malformed WAV header')

  // A streaming writer that never patched the header back in (dataSize = 0) or an
  // over-declared size must not produce a bogus duration — clamp to what is actually
  // present, and treat "nothing actually present" as unparseable, not as 0ms (0ms would
  // clear both the hard and warn gates for a file that may in fact be minutes long).
  const clampedDataSize = Math.min(dataSize, b.length - dataOffset)
  if (clampedDataSize <= 0) throw new Error('Malformed WAV header: empty data chunk')

  return Math.round((clampedDataSize / bytesPerFrame / sampleRate) * 1000)
}

export const REFERENCE_HARD_LIMIT_MS = 60_000
export const REFERENCE_WARN_LIMIT_MS = 20_000
