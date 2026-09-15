import { describe, it, expect } from 'vitest'
import { pcmToWav } from '../../lib/voice/speak'
import { wavDurationMs } from '../../lib/voice/wav'

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
})
