import { describe, it, expect } from 'vitest'
import { pcmToWav } from '../../lib/voice/speak'
import { wavDurationMs } from '../../lib/voice/wav'

function u32le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b }
function u16le(n: number): Buffer { const b = Buffer.alloc(2); b.writeUInt16LE(n, 0); return b }

/**
 * Build a WAV from an arbitrary chunk sequence after the RIFF/WAVE header, so tests can
 * simulate real encoders (ffmpeg's LIST/INFO chunk, WAVE_FORMAT_EXTENSIBLE's 18-byte
 * fmt) instead of only the canonical 44-byte layout `pcmToWav` produces. Chunks are
 * padded to an even byte count, matching the RIFF spec.
 */
function buildWav(chunks: { id: string; payload: Buffer }[]): Buffer {
  const body = Buffer.concat(chunks.map((c) => {
    const padded = c.payload.length % 2 === 0 ? c.payload : Buffer.concat([c.payload, Buffer.from([0])])
    return Buffer.concat([Buffer.from(c.id, 'ascii'), u32le(c.payload.length), padded])
  }))
  return Buffer.concat([Buffer.from('RIFF', 'ascii'), u32le(4 + body.length), Buffer.from('WAVE', 'ascii'), body])
}

function fmtChunk16(channels: number, sampleRate: number, bitsPerSample: number): Buffer {
  const blockAlign = channels * (bitsPerSample / 8)
  const byteRate = sampleRate * blockAlign
  return Buffer.concat([u16le(1), u16le(channels), u32le(sampleRate), u32le(byteRate), u16le(blockAlign), u16le(bitsPerSample)])
}

function fmtChunk18Extensible(channels: number, sampleRate: number, bitsPerSample: number): Buffer {
  return Buffer.concat([fmtChunk16(channels, sampleRate, bitsPerSample), u16le(0)]) // cbSize = 0
}

describe('wavDurationMs', () => {
  it('reads duration from a mono s16le WAV header', () => {
    // 24000 samples @ 24kHz = exactly 1 second
    const wav = pcmToWav(new Uint8Array(24000 * 2), 24000)
    expect(wavDurationMs(wav)).toBe(1000)
  })

  it('handles a non-24k rate', () => {
    const wav = pcmToWav(new Uint8Array(16000 * 2), 16000)
    expect(wavDurationMs(wav)).toBe(1000)
  })

  it('throws on a non-RIFF payload rather than reporting a bogus duration', () => {
    expect(() => wavDurationMs(Buffer.from('not a wav at all'))).toThrow(/RIFF/)
  })

  it('skips a LIST/INFO chunk before data (ffmpeg-style export — the most likely real path)', () => {
    const dataPayload = Buffer.alloc(24000 * 2) // 1s @ 24kHz mono s16le
    const wav = buildWav([
      { id: 'fmt ', payload: fmtChunk16(1, 24000, 16) },
      { id: 'LIST', payload: Buffer.alloc(5, 0x41) }, // odd length: exercises chunk padding too
      { id: 'data', payload: dataPayload }
    ])
    expect(wavDurationMs(wav)).toBe(1000)
  })

  it('reads an 18-byte fmt chunk (WAVE_FORMAT_EXTENSIBLE) instead of trusting a fixed offset', () => {
    const dataPayload = Buffer.alloc(24000 * 2)
    const wav = buildWav([
      { id: 'fmt ', payload: fmtChunk18Extensible(1, 24000, 16) },
      { id: 'data', payload: dataPayload }
    ])
    expect(wavDurationMs(wav)).toBe(1000)
  })

  it('throws on a zero-length data chunk instead of reporting 0ms (0ms would clear both gates)', () => {
    const wav = buildWav([
      { id: 'fmt ', payload: fmtChunk16(1, 24000, 16) },
      { id: 'data', payload: Buffer.alloc(0) }
    ])
    expect(() => wavDurationMs(wav)).toThrow()
  })

  it('clamps a declared data size larger than the actual buffer instead of trusting it', () => {
    // A streaming writer that never patched the header back in: declare 10x the bytes
    // actually present. Must reflect the ~0.5s really there, not the declared ~5s — an
    // over-long reference must fail the 60s gate on real content, not sail through on a lie.
    const realPayload = Buffer.alloc(12000 * 2) // 0.5s @ 24kHz mono s16le
    const wav = Buffer.concat([
      buildWav([{ id: 'fmt ', payload: fmtChunk16(1, 24000, 16) }]),
      Buffer.from('data', 'ascii'), u32le(realPayload.length * 10),
      realPayload
    ])
    expect(wavDurationMs(wav)).toBe(500)
  })
})
