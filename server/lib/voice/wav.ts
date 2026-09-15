import { Buffer } from 'node:buffer'

/**
 * Duration of a mono/stereo PCM WAV in milliseconds, read from its header.
 * Used to enforce the reference-clip limits: a reference consumes the same prompt
 * budget as the text, so its length is a correctness constraint, not a preference.
 */
export function wavDurationMs(buf: Buffer | Uint8Array): number {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  if (b.length < 44 || b.subarray(0, 4).toString('ascii') !== 'RIFF') {
    throw new Error('Not a RIFF/WAV file')
  }
  const channels = b.readUInt16LE(22)
  const sampleRate = b.readUInt32LE(24)
  const bitsPerSample = b.readUInt16LE(34)
  const dataSize = b.readUInt32LE(40)
  const bytesPerFrame = channels * (bitsPerSample / 8)
  if (!sampleRate || !bytesPerFrame) throw new Error('Malformed WAV header')
  return Math.round((dataSize / bytesPerFrame / sampleRate) * 1000)
}

export const REFERENCE_HARD_LIMIT_MS = 60_000
export const REFERENCE_WARN_LIMIT_MS = 20_000
