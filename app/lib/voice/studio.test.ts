import { describe, it, expect } from 'vitest'
import type { VoicePresetDTO } from '~~/shared/types/voice-presets'
import {
  CFG_LOCK_REASON,
  TRUNCATION_MESSAGE,
  auditionRequests,
  auditionSeeds,
  clampCfgScale,
  draftToOverrides,
  runAuditionSequentially,
  type SpeakRequestBody,
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

describe('the audition never writes, and never parallelises', () => {
  // A transport that records every request it is handed and tracks how many are in flight
  // at once. `send` is the driver's ONLY way to reach the network, so anything it does not
  // record did not happen.
  function recorder(behaviour: (body: SpeakRequestBody, i: number) => Promise<string> = async () => 'ok') {
    const sent: SpeakRequestBody[] = []
    let inFlight = 0
    let maxInFlight = 0
    const send = async (body: SpeakRequestBody) => {
      const i = sent.length
      sent.push(body)
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      try {
        // Yield to the microtask queue so overlapping calls would actually overlap.
        await Promise.resolve()
        return await behaviour(body, i)
      } finally {
        inFlight--
      }
    }
    return { sent, send, maxInFlight: () => maxInFlight }
  }

  it('sends exactly one request per seed — and nothing else', async () => {
    const requests = auditionRequests(draft(), 'preset-1', 'read this')
    const r = recorder()
    await runAuditionSequentially(requests, r.send)

    expect(r.sent).toHaveLength(4)
    // Every request is a synthesis. There is no PATCH before a take and no restore after
    // the run — the shape that used to leave a preset stranded on an audition seed when a
    // tab closed mid-run.
    for (const body of r.sent) {
      expect(body.text).toBe('read this')
      expect(body.presetId).toBe('preset-1')
      expect(body.format).toBe('wav')
      expect(body.overrides).toBeTruthy()
    }
  })

  it('never has more than one request in flight — the rig serves one at a time', async () => {
    const requests = auditionRequests(draft(), 'preset-1', 'read this')
    const r = recorder(async () => {
      await new Promise(resolve => setTimeout(resolve, 1))
      return 'ok'
    })
    await runAuditionSequentially(requests, r.send)
    expect(r.maxInFlight()).toBe(1)
  })

  it('carries four DISTINCT seeds, the first being the one on screen', async () => {
    const requests = auditionRequests(draft({ seed: 11 }), 'preset-1', 'read this')
    const seeds = requests.map(b => b.overrides?.seed)
    expect(seeds[0]).toBe(11)
    expect(seeds).toHaveLength(4)
    expect(new Set(seeds).size).toBe(4)
    expect(seeds.every(s => typeof s === 'number')).toBe(true)
  })

  it('previews UNSAVED edits — the overrides carry the draft, not the saved row', () => {
    const edited = draft({
      instruction: 'A bright, energetic young man.',
      cfgScale: 6,
      temperature: 1.25,
      topP: 0.6,
      topK: 15
    })
    const [first] = auditionRequests(edited, 'preset-1', 'read this')
    expect(first?.overrides).toMatchObject({
      instruction: 'A bright, energetic young man.',
      cfgScale: 6,
      temperature: 1.25,
      topP: 0.6,
      topK: 15
    })
  })

  it('reports each take in order, and one failure does not cost the other three', async () => {
    const requests = auditionRequests(draft(), 'preset-1', 'read this')
    const started: number[] = []
    const done: number[] = []
    const failed: number[] = []
    const r = recorder(async (_body, i) => {
      if (i === 1) throw new Error('the rig is busy')
      return 'ok'
    })
    await runAuditionSequentially(requests, r.send, {
      onStart: i => started.push(i),
      onDone: i => done.push(i),
      onError: i => failed.push(i)
    })
    expect(started).toEqual([0, 1, 2, 3])
    expect(done).toEqual([0, 2, 3])
    expect(failed).toEqual([1])
    expect(r.sent).toHaveLength(4)
  })

  it('does nothing at all when handed no requests', async () => {
    const r = recorder()
    await runAuditionSequentially([], r.send)
    expect(r.sent).toHaveLength(0)
  })
})

describe('draftToOverrides', () => {
  it('carries only the tunable parameters — never the name, the clip or the ceiling', () => {
    const o = draftToOverrides(draft({ refStorageKey: 'blob/k', refText: 'transcript' }))
    expect(Object.keys(o).sort()).toEqual(['cfgScale', 'instruction', 'seed', 'temperature', 'topK', 'topP'])
  })

  it('clamps cfg exactly as the save path does, so a preview cannot ask for an illegal pair', () => {
    expect(draftToOverrides(draft({ instruction: '', cfgScale: 7 })).cfgScale).toBe(1)
    expect(draftToOverrides(draft({ instruction: '', cfgScale: 7 })).instruction).toBeNull()
  })

  it('overrides the seed when one is supplied, and uses the draft\'s otherwise', () => {
    expect(draftToOverrides(draft({ seed: 11 })).seed).toBe(11)
    expect(draftToOverrides(draft({ seed: 11 }), 4821).seed).toBe(4821)
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
