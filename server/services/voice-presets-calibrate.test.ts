// server/services/voice-presets-calibrate.test.ts
//
// Pure test — calibrateMaxSegmentChars never touches the DB (it takes a preset DTO and
// a probe function), so this runs under plain `pnpm test`, unlike the CRUD test in
// voice-presets.db.test.ts.
import { describe, it, expect, vi } from 'vitest'
import { calibrateMaxSegmentChars } from './voice-presets'
import { BreezeError } from '../lib/voice/breeze'
import type { VoicePresetDTO } from '../../shared/types/voice-presets'

const clone: VoicePresetDTO = {
  id: 'p', name: 'tony', instruction: 'Warmly.', cfgScale: 4, seed: 11, temperature: 0.9,
  topP: 1, topK: 50, refStorageKey: 'k', refText: 'transcript', refDurationMs: 8000,
  maxSegmentChars: 200, isDefault: false
}
const design: VoicePresetDTO = { ...clone, refStorageKey: null, refText: null, refDurationMs: null }

describe('calibrateMaxSegmentChars', () => {
  it('skips the probe entirely for a reference-free preset', async () => {
    const probe = vi.fn()
    expect(await calibrateMaxSegmentChars(design, probe)).toBe(200)
    expect(probe).not.toHaveBeenCalled()
  })

  it('returns 200 when the 200-char probe succeeds', async () => {
    const probe = vi.fn(async (_text: string) => {})
    expect(await calibrateMaxSegmentChars(clone, probe)).toBe(200)
    expect(probe).toHaveBeenCalledTimes(1)
    expect((probe.mock.calls[0]![0] as string).length).toBe(200)
  })

  it('falls back to 100 when the 200-char probe truncates', async () => {
    const probe = vi.fn(async (text: string) => {
      if (text.length > 100) throw new BreezeError('truncated', 'no audio')
    })
    expect(await calibrateMaxSegmentChars(clone, probe)).toBe(100)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('returns 100 as the floor when both probes truncate', async () => {
    const probe = vi.fn(async () => { throw new BreezeError('truncated', 'no audio') })
    expect(await calibrateMaxSegmentChars(clone, probe)).toBe(100)
  })

  // A busy rig or a network blip is not evidence about the prompt budget. Narrowing the
  // cap on it would silently degrade a good preset.
  it('rethrows a non-truncation error instead of narrowing the cap', async () => {
    const probe = vi.fn(async () => { throw new BreezeError('busy', 'in flight') })
    await expect(calibrateMaxSegmentChars(clone, probe)).rejects.toMatchObject({ code: 'busy' })
  })
})
