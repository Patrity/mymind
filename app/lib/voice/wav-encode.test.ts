import { describe, it, expect } from 'vitest'
// The SERVER's header parser, deliberately: the reference route runs the recorded clip
// through wavDurationMs, and a header this encoder gets subtly wrong (a LIST chunk, a
// mis-sized data chunk) fails there as a flat 400 or, worse, sails past the 60s gate.
// Round-tripping against the real parser is the only check that means anything.
import { wavDurationMs } from '~~/server/lib/voice/wav'
import { encodeWav, mixToMono, readWavInfo } from './wav-encode'

const tone = (samples: number) => {
  const out = new Float32Array(samples)
  for (let i = 0; i < samples; i++) out[i] = Math.sin(i / 8) * 0.5
  return out
}

describe('encodeWav', () => {
  it('writes a RIFF/WAVE header the server can parse', () => {
    const bytes = encodeWav(tone(24000), 24000)
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('RIFF')
    expect(String.fromCharCode(...bytes.subarray(8, 12))).toBe('WAVE')
    expect(bytes.byteLength).toBe(44 + 24000 * 2)
  })

  it('reports the duration the server will measure', () => {
    // 3 seconds at 16 kHz mono.
    expect(wavDurationMs(encodeWav(tone(48000), 16000))).toBe(3000)
  })

  it('a clip past the 20s warn line really measures past it', () => {
    // The warn/hard gates are enforced on THIS duration — an encoder that mis-declared
    // the sample rate would let a long recording through as a short one.
    expect(wavDurationMs(encodeWav(tone(24000 * 25), 24000))).toBe(25000)
  })

  it('round-trips sample values through 16-bit PCM', () => {
    const bytes = encodeWav(Float32Array.from([0, 1, -1, 0.5]), 8000)
    const view = new DataView(bytes.buffer, bytes.byteOffset + 44)
    expect(view.getInt16(0, true)).toBe(0)
    expect(view.getInt16(2, true)).toBe(0x7FFF)
    expect(view.getInt16(4, true)).toBe(-0x8000)
    // setInt16 truncates toward zero rather than rounding — assert what it actually writes.
    expect(view.getInt16(6, true)).toBe(Math.trunc(0.5 * 0x7FFF))
  })

  it('clips out-of-range samples rather than wrapping them', () => {
    const bytes = encodeWav(Float32Array.from([4, -4]), 8000)
    const view = new DataView(bytes.buffer, bytes.byteOffset + 44)
    expect(view.getInt16(0, true)).toBe(0x7FFF)
    expect(view.getInt16(2, true)).toBe(-0x8000)
  })

  it('emits a parseable (zero-length) file for an empty recording', () => {
    const bytes = encodeWav(new Float32Array(0), 24000)
    expect(bytes.byteLength).toBe(44)
    // The server treats a zero-length data chunk as unparseable rather than as 0ms —
    // which is correct, and this asserts the encoder does not hide that.
    expect(() => wavDurationMs(bytes)).toThrow()
  })
})

describe('readWavInfo', () => {
  it('reads the rate and payload size a render came back with', () => {
    const info = readWavInfo(encodeWav(tone(12000), 24000))
    expect(info).toEqual({ sampleRate: 24000, dataBytes: 24000 })
  })

  it('rejects anything that is not RIFF/WAVE', () => {
    expect(readWavInfo(new Uint8Array(64))).toBeNull()
    expect(readWavInfo(new Uint8Array(4))).toBeNull()
  })

  it('never reports more payload than the buffer actually holds', () => {
    // A stream that died mid-body keeps the header's optimistic length — the number that
    // matters for a truncation check is what arrived, not what was promised.
    const bytes = encodeWav(tone(24000), 24000).slice(0, 44 + 1000)
    expect(readWavInfo(bytes)?.dataBytes).toBe(1000)
  })
})

describe('mixToMono', () => {
  it('passes a mono buffer straight through', () => {
    const ch = Float32Array.from([0.1, 0.2])
    expect(mixToMono([ch])).toBe(ch)
  })

  it('averages stereo channels', () => {
    const out = mixToMono([Float32Array.from([1, 0]), Float32Array.from([0, 1])])
    expect(Array.from(out)).toEqual([0.5, 0.5])
  })

  it('returns an empty buffer when there are no channels', () => {
    expect(mixToMono([]).length).toBe(0)
  })
})
