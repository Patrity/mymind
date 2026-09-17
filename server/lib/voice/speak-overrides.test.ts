import { describe, it, expect } from 'vitest'
import { applyOverrides, presetToRequest } from './speak'
import { validateBreezeRequest } from './breeze'
import type { VoicePresetDTO } from '../../../shared/types/voice-presets'

const DESIGN: VoicePresetDTO = {
  id: 'p1',
  name: 'neutral-lowkey',
  instruction: 'A neutral, low-key man.',
  cfgScale: 4,
  seed: 11,
  temperature: 0.9,
  topP: 1,
  topK: 50,
  refStorageKey: null,
  refText: null,
  refDurationMs: null,
  maxSegmentChars: 200,
  calibratedRefKey: null, refSource: null, starredSeeds: [],
  isDefault: true
}

// A reference-backed preset: calibration pulled its ceiling well below the 200 default,
// which is exactly the number an override must not be able to move.
const CLONE: VoicePresetDTO = {
  ...DESIGN,
  id: 'p2',
  name: 'test-clone',
  refStorageKey: 'blob/real-clip',
  refText: 'the exact transcript of the clip',
  refDurationMs: 9000,
  maxSegmentChars: 90
}

const REF_BYTES = new Uint8Array([1, 2, 3, 4])

/**
 * The route's decision, verbatim: resolve -> merge in memory -> run the rig's own
 * pre-flight. `speak.post.ts` turns a non-null return into a 400.
 */
function preflight(preset: VoicePresetDTO, overrides: Parameters<typeof applyOverrides>[1], text = 'hello there') {
  const merged = applyOverrides(preset, overrides)
  // presetToRequest takes the raw bytes and wraps them itself.
  const refAudio = merged.refStorageKey ? REF_BYTES : null
  return { merged, invalid: validateBreezeRequest(presetToRequest(text, merged, refAudio)) }
}

describe('applyOverrides — merging', () => {
  it('merges the supplied keys into the request the rig receives', () => {
    const req = presetToRequest('hi', applyOverrides(DESIGN, {
      seed: 777,
      instruction: 'A bright, energetic young man.',
      cfgScale: 6,
      temperature: 1.2,
      topP: 0.8,
      topK: 20
    }), null)
    expect(req.seed).toBe(777)
    expect(req.instruction).toBe('A bright, energetic young man.')
    expect(req.cfgScale).toBe(6)
    expect(req.temperature).toBe(1.2)
    expect(req.topP).toBe(0.8)
    expect(req.topK).toBe(20)
  })

  it('leaves unsupplied keys at the preset\'s own values', () => {
    const merged = applyOverrides(DESIGN, { seed: 999 })
    expect(merged.seed).toBe(999)
    expect(merged.instruction).toBe(DESIGN.instruction)
    expect(merged.cfgScale).toBe(DESIGN.cfgScale)
    expect(merged.temperature).toBe(DESIGN.temperature)
    expect(merged.topP).toBe(DESIGN.topP)
    expect(merged.topK).toBe(DESIGN.topK)
  })

  it('passes the preset straight through when there are no overrides', () => {
    expect(applyOverrides(DESIGN, undefined)).toBe(DESIGN)
    expect(applyOverrides(DESIGN, null)).toBe(DESIGN)
  })

  it('treats an explicit null or blank instruction as "no instruction"', () => {
    expect(applyOverrides(DESIGN, { instruction: null, cfgScale: 1 }).instruction).toBeNull()
    expect(applyOverrides(DESIGN, { instruction: '   ', cfgScale: 1 }).instruction).toBeNull()
  })

  it('ignores non-finite numbers rather than sending NaN to the rig', () => {
    // A NaN seed reaches Breeze as `seed=NaN` and comes back as an opaque 500; falling
    // back to the preset's own value is always safe.
    const merged = applyOverrides(DESIGN, { seed: Number.NaN, temperature: Number.POSITIVE_INFINITY })
    expect(merged.seed).toBe(DESIGN.seed)
    expect(merged.temperature).toBe(DESIGN.temperature)
  })
})

describe('applyOverrides — never writes, never mutates', () => {
  it('returns a NEW object and leaves the resolved preset untouched', () => {
    const before = { ...DESIGN }
    const merged = applyOverrides(DESIGN, { seed: 42, cfgScale: 2 })
    expect(merged).not.toBe(DESIGN)
    expect(merged.seed).toBe(42)
    // The object the caller resolved from the database is the one the rest of the request
    // (and anything else holding it) sees — it must be byte-identical afterwards.
    expect(DESIGN).toEqual(before)
    expect(DESIGN.seed).toBe(11)
    expect(DESIGN.cfgScale).toBe(4)
  })

  it('is pure: the same inputs twice give equal, independent results', () => {
    const a = applyOverrides(DESIGN, { seed: 5 })
    const b = applyOverrides(DESIGN, { seed: 5 })
    expect(a).toEqual(b)
    expect(a).not.toBe(b)
  })
})

describe('applyOverrides — the allow-list', () => {
  it('ignores an attempt to raise maxSegmentChars', () => {
    // The ceiling is CALIBRATED against the reference clip. If a caller could raise it,
    // an audition would claim a prompt budget the voice was never measured for and the
    // render would die at the rig with a 200 and no body.
    const merged = applyOverrides(CLONE, { seed: 3, maxSegmentChars: 4000 } as Parameters<typeof applyOverrides>[1])
    expect(merged.maxSegmentChars).toBe(90)
  })

  it('ignores an attempt to point the request at a different reference clip', () => {
    const merged = applyOverrides(CLONE, {
      seed: 3,
      refStorageKey: 'blob/somebody-elses-voice',
      refText: 'a transcript that does not match',
      refDurationMs: 59000
    } as Parameters<typeof applyOverrides>[1])
    expect(merged.refStorageKey).toBe('blob/real-clip')
    expect(merged.refText).toBe('the exact transcript of the clip')
    expect(merged.refDurationMs).toBe(9000)
  })

  it('ignores identity fields — an override cannot rename or re-flag the preset', () => {
    const merged = applyOverrides(DESIGN, {
      id: 'somewhere-else',
      name: 'hijacked',
      isDefault: false
    } as Parameters<typeof applyOverrides>[1])
    expect(merged.id).toBe('p1')
    expect(merged.name).toBe('neutral-lowkey')
    expect(merged.isDefault).toBe(true)
  })
})

describe('the route pre-flight (400, not an opaque 500)', () => {
  it('rejects an override of cfgScale > 1 when the merged instruction is blank', () => {
    // Reachable ONLY through overrides: the matching DB CHECK
    // (voice_presets_cfg_needs_instruction) means no stored row can be in this state.
    const { invalid } = preflight(DESIGN, { cfgScale: 4, instruction: null })
    expect(invalid).toMatch(/cfg_scale above 1\.0 requires an instruction/)
  })

  it('rejects it when the instruction is overridden to whitespace too', () => {
    expect(preflight(DESIGN, { cfgScale: 4, instruction: '   ' }).invalid).toBeTruthy()
  })

  it('rejects cfg > 1 against a preset that never had an instruction', () => {
    const plain: VoicePresetDTO = { ...DESIGN, instruction: null, cfgScale: 1 }
    expect(preflight(plain, { cfgScale: 3 }).invalid).toBeTruthy()
  })

  it('rejects a non-positive cfgScale', () => {
    expect(preflight(DESIGN, { cfgScale: 0 }).invalid).toMatch(/cfg_scale must be greater than 0/)
  })

  it('accepts cfg > 1 when the override supplies the instruction', () => {
    expect(preflight(DESIGN, { cfgScale: 6, instruction: 'A deep, calm older man.' }).invalid).toBeNull()
  })

  it('accepts cfg == 1 with no instruction anywhere — that combination is legal', () => {
    expect(preflight(DESIGN, { cfgScale: 1, instruction: null }).invalid).toBeNull()
  })

  it('accepts a seed-only audition, which is the common case', () => {
    for (const seed of [11, 4821, 99, 573204]) {
      expect(preflight(DESIGN, { seed }).invalid).toBeNull()
    }
  })

  it('still carries the reference clip through the pre-flight unchanged', () => {
    const { merged, invalid } = preflight(CLONE, { seed: 8 })
    expect(invalid).toBeNull()
    expect(merged.refText).toBe('the exact transcript of the clip')
  })
})
