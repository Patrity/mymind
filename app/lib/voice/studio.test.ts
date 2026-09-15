import { describe, it, expect } from 'vitest'
import type { VoicePresetDTO } from '~~/shared/types/voice-presets'
import {
  CFG_LOCK_REASON,
  TRUNCATION_MESSAGE,
  auditionSeeds,
  clampCfgScale,
  diagnoseTruncation,
  draftIsDirty,
  draftToBody,
  errorMessage,
  insertAtCursor,
  isCfgLocked,
  messagesToScript,
  modeBadge,
  overCapWarning,
  presetToDraft,
  randomSeed,
  uniqueName,
  validatePresetDraft,
  type PresetDraft
} from './studio'

const PRESET: VoicePresetDTO = {
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
  isDefault: true
}

const draft = (over: Partial<PresetDraft> = {}): PresetDraft => ({ ...presetToDraft(PRESET), ...over })

describe('cfg guidance lock', () => {
  it('locks while the instruction is blank — the DB CHECK would reject cfg > 1', () => {
    expect(isCfgLocked('')).toBe(true)
    expect(isCfgLocked('   ')).toBe(true)
    expect(isCfgLocked(null)).toBe(true)
    expect(isCfgLocked('a warm narrator')).toBe(false)
  })

  it('clamps a locked draft back to 1.0 rather than letting it be composed', () => {
    expect(clampCfgScale(6, '')).toBe(1)
    expect(clampCfgScale(6, '   ')).toBe(1)
    expect(clampCfgScale(6, 'a warm narrator')).toBe(6)
  })

  it('bounds cfg to the slider range even with an instruction', () => {
    expect(clampCfgScale(99, 'x')).toBe(8)
    expect(clampCfgScale(0, 'x')).toBe(1)
  })
})

describe('validatePresetDraft', () => {
  it('accepts the seeded default', () => {
    expect(validatePresetDraft(draft())).toEqual([])
  })

  it('requires a name', () => {
    expect(validatePresetDraft(draft({ name: '  ' }))).toContain('Name is required.')
  })

  it('rejects cfg > 1 with a blank instruction, quoting the reason the UI shows', () => {
    expect(validatePresetDraft(draft({ instruction: '', cfgScale: 4 }))).toContain(CFG_LOCK_REASON)
  })

  it('allows cfg == 1 with a blank instruction — that combination is legal', () => {
    expect(validatePresetDraft(draft({ instruction: '', cfgScale: 1 }))).toEqual([])
  })

  it('rejects a reference clip with no transcript', () => {
    const errs = validatePresetDraft(draft({ refStorageKey: 'blob-key', refText: '' }))
    expect(errs.some(e => e.includes('transcript'))).toBe(true)
  })
})

describe('draftToBody', () => {
  it('sends NULL, not empty string, for blank optional text — the CHECKs test NULL', () => {
    const body = draftToBody(draft({ instruction: '   ', cfgScale: 1, refText: '' }))
    expect(body.instruction).toBeNull()
    expect(body.refText).toBeNull()
  })

  it('clamps cfg on the way out so an un-saveable body can never be sent', () => {
    expect(draftToBody(draft({ instruction: '', cfgScale: 8 })).cfgScale).toBe(1)
  })

  it('trims the name', () => {
    expect(draftToBody(draft({ name: '  warm  ' })).name).toBe('warm')
  })
})

describe('draftIsDirty', () => {
  it('is clean for a freshly loaded preset', () => {
    expect(draftIsDirty(presetToDraft(PRESET), PRESET)).toBe(false)
  })

  it('is dirty once any field moves', () => {
    expect(draftIsDirty(draft({ seed: 12 }), PRESET)).toBe(true)
    expect(draftIsDirty(draft({ instruction: 'something else' }), PRESET)).toBe(true)
  })

  it('ignores whitespace-only edits that normalise to the same body', () => {
    expect(draftIsDirty(draft({ name: 'neutral-lowkey ' }), PRESET)).toBe(false)
  })

  it('treats an unsaved draft (no row) as dirty', () => {
    expect(draftIsDirty(draft(), null)).toBe(true)
  })
})

describe('uniqueName', () => {
  it('keeps the name when nothing holds it', () => {
    expect(uniqueName('warm (copy)', ['warm'])).toBe('warm (copy)')
  })

  it('suffixes past a collision — the name column is UNIQUE', () => {
    expect(uniqueName('warm (copy)', ['warm', 'warm (copy)'])).toBe('warm (copy) 2')
    expect(uniqueName('warm (copy)', ['warm (copy)', 'warm (copy) 2'])).toBe('warm (copy) 3')
  })
})

describe('modeBadge', () => {
  it('derives all four modes from which fields are populated', () => {
    expect(modeBadge({ instruction: null, refStorageKey: null }).label).toBe('plain')
    expect(modeBadge({ instruction: 'warm', refStorageKey: null }).label).toBe('design')
    expect(modeBadge({ instruction: null, refStorageKey: 'k' }).label).toBe('clone')
    expect(modeBadge({ instruction: 'warm', refStorageKey: 'k' }).label).toBe('direction')
  })

  it('uses semantic colour tokens only', () => {
    for (const p of [
      { instruction: null, refStorageKey: null },
      { instruction: 'x', refStorageKey: null },
      { instruction: null, refStorageKey: 'k' },
      { instruction: 'x', refStorageKey: 'k' }
    ]) {
      expect(['neutral', 'primary', 'info', 'success']).toContain(modeBadge(p).color)
    }
  })
})

describe('seeds', () => {
  it('randomSeed stays inside Breeze\'s 1..999999 window', () => {
    expect(randomSeed(() => 0)).toBe(1)
    expect(randomSeed(() => 0.999999999)).toBeLessThanOrEqual(999999)
    expect(randomSeed(() => 0.5)).toBe(500000)
  })

  it('auditions exactly four DISTINCT seeds starting from the current one', () => {
    const seeds = auditionSeeds(11)
    expect(seeds).toHaveLength(4)
    expect(seeds[0]).toBe(11)
    expect(new Set(seeds).size).toBe(4)
  })

  it('still returns four slots when the rng is degenerate — never hangs, never short', () => {
    const seeds = auditionSeeds(1, () => 0) // randomSeed(() => 0) === 1, which is already taken
    expect(seeds).toHaveLength(4)
    expect(new Set(seeds).size).toBe(4)
  })
})

describe('insertAtCursor', () => {
  it('inserts at the caret', () => {
    expect(insertAtCursor('hello world', '(laugh)', 5)).toEqual({ value: 'hello (laugh) world', cursor: 13 })
  })

  it('appends at the end of an empty box without leading whitespace', () => {
    expect(insertAtCursor('', '(sigh)', 0)).toEqual({ value: '(sigh)', cursor: 6 })
  })

  it('replaces a selection', () => {
    const { value } = insertAtCursor('say ugh now', '(cough)', 4, 7)
    expect(value).toBe('say (cough) now')
  })

  it('never glues a tag onto an adjacent word', () => {
    expect(insertAtCursor('hello', '(laugh)', 5).value).toBe('hello (laugh)')
    expect(insertAtCursor('hello', '(laugh)', 0).value).toBe('(laugh) hello')
  })

  it('does not double up existing whitespace', () => {
    // Caret sits just after the space; the tag must not arrive with a second one.
    expect(insertAtCursor('hello world', '(laugh)', 6).value).toBe('hello (laugh) world')
  })

  it('clamps an out-of-range caret instead of producing undefined', () => {
    expect(insertAtCursor('abc', '(sigh)', 99).value).toBe('abc (sigh)')
    expect(insertAtCursor('abc', '(sigh)', -5, -5).value).toBe('(sigh) abc')
  })
})

describe('diagnoseTruncation', () => {
  const sampleRate = 24000
  // 24000 samples/s * 2 bytes = 48000 bytes per second of audio.

  it('names the prompt ceiling when NO audio arrived — the only signal a truncate gives', () => {
    expect(diagnoseTruncation({ chars: 300, audioBytes: 0, sampleRate })).toBe(TRUNCATION_MESSAGE)
  })

  it('names it when the audio is far shorter than the text calls for', () => {
    // 600 chars ≈ 43s of speech; 1s of audio came back.
    expect(diagnoseTruncation({ chars: 600, audioBytes: 48000, sampleRate })).toBe(TRUNCATION_MESSAGE)
  })

  it('stays quiet on a plausible render', () => {
    // 140 chars ≈ 10s; 9s of audio came back.
    expect(diagnoseTruncation({ chars: 140, audioBytes: 48000 * 9, sampleRate })).toBeNull()
  })

  it('stays quiet when there was no text to render', () => {
    expect(diagnoseTruncation({ chars: 0, audioBytes: 0, sampleRate })).toBeNull()
  })

  it('does not divide by a zero sample rate', () => {
    expect(diagnoseTruncation({ chars: 100, audioBytes: 1000, sampleRate: 0 })).toBeNull()
  })
})

describe('overCapWarning', () => {
  it('warns past the calibrated ceiling and quotes both numbers', () => {
    const msg = overCapWarning(320, 200)
    expect(msg).toContain('320')
    expect(msg).toContain('200')
  })

  it('is silent at or below the ceiling', () => {
    expect(overCapWarning(200, 200)).toBeNull()
    expect(overCapWarning(10, 200)).toBeNull()
  })
})

describe('errorMessage', () => {
  it('prefers the statusMessage h3 buried on `data` over the useless FetchError message', () => {
    const fetchError = {
      message: '[POST] "/api/voice/reference": 400 Bad Request',
      data: { statusMessage: 'Reference is 74.2s — the limit is 60s. Trim it to about 10 seconds of clean speech.' }
    }
    expect(errorMessage(fetchError)).toContain('the limit is 60s')
  })

  it('falls back through data.message, statusMessage and message', () => {
    expect(errorMessage({ data: { message: 'inner' } })).toBe('inner')
    expect(errorMessage({ statusMessage: 'outer' })).toBe('outer')
    expect(errorMessage(new Error('boom'))).toBe('boom')
  })

  it('has something to say about null, undefined and empty strings', () => {
    expect(errorMessage(null)).toBe('Unknown error')
    expect(errorMessage(undefined)).toBe('Unknown error')
    expect(errorMessage('')).toBe('Unknown error')
    expect(errorMessage('plain string')).toBe('plain string')
  })
})

describe('messagesToScript', () => {
  it('reads back the assistant side of a conversation, not your own prompts', () => {
    const script = messagesToScript([
      { role: 'user', content: 'what happened?' },
      { role: 'assistant', content: 'The deploy failed.' },
      { role: 'user', content: 'why?' },
      { role: 'assistant', content: 'A migration was missing.' }
    ])
    expect(script).toBe('The deploy failed.\n\nA migration was missing.')
  })

  it('falls back to everything when the assistant never spoke', () => {
    expect(messagesToScript([{ role: 'user', content: 'hello' }])).toBe('hello')
  })

  it('drops empty turns', () => {
    expect(messagesToScript([
      { role: 'assistant', content: '   ' },
      { role: 'assistant', content: 'kept' }
    ])).toBe('kept')
  })
})
