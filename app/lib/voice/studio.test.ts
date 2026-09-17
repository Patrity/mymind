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
  diagnoseStreamRender,
  draftToBody,
  errorFromResponseBody,
  errorMessage,
  insertAtCursor,
  isCfgLocked,
  messagesToScript,
  modeBadge,
  describeRenderPlan,
  instructionHint,
  lockState,
  lockHint,
  toggleStarredSeed,
  presetToDraft,
  randomSeed,
  uniqueName,
  validatePresetDraft,
  attachedReference,
  noReference,
  referenceFieldsOf,
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
  calibratedRefKey: null, refSource: null, starredSeeds: [],
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
    expect(modeBadge({ instruction: null, refStorageKey: null, refSource: null }).label).toBe('plain')
    expect(modeBadge({ instruction: 'warm', refStorageKey: null, refSource: null }).label).toBe('design')
    expect(modeBadge({ instruction: null, refStorageKey: 'k', refSource: null }).label).toBe('clone')
    expect(modeBadge({ instruction: 'warm', refStorageKey: 'k', refSource: null }).label).toBe('direction')
  })

  it('uses semantic colour tokens only', () => {
    for (const p of [
      { instruction: null, refStorageKey: null, refSource: null },
      { instruction: 'x', refStorageKey: null, refSource: null },
      { instruction: null, refStorageKey: 'k', refSource: 'upload' as const },
      { instruction: 'x', refStorageKey: 'k', refSource: 'upload' as const }
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

describe('diagnoseStreamRender', () => {
  const sampleRate = 24000 // 48000 bytes per second of 16-bit mono audio
  // 420 chars ≈ 30s of speech at ~14 chars/s.
  const chars = 420
  const healthy = { chars, audioBytes: 48000 * 28, sampleRate, error: null, cancelled: false }

  it('REGRESSION: a stream that delivered a few bytes and then died still reports an overrun', () => {
    // The shape this whole diagnosis exists for, and the one the previous wiring missed:
    // the rig answers 200, sends one frame, and dies. ttfaMs is set, so "did anything
    // arrive?" says yes — but 0.02s of audio for 30s of text is an overrun.
    const msg = diagnoseStreamRender({ ...healthy, audioBytes: 960 })
    expect(msg).toBe(TRUNCATION_MESSAGE)
  })

  it('reports an overrun when nothing arrived at all', () => {
    expect(diagnoseStreamRender({ ...healthy, audioBytes: 0 })).toBe(TRUNCATION_MESSAGE)
  })

  it('stays quiet on a render that produced roughly the right amount of audio', () => {
    expect(diagnoseStreamRender(healthy)).toBeNull()
  })

  it('stays quiet when the user pressed Stop — a cancel is not an overrun', () => {
    // stop() produces exactly a truncation's shape: no error, and little or no audio.
    expect(diagnoseStreamRender({ ...healthy, audioBytes: 960, cancelled: true })).toBeNull()
    expect(diagnoseStreamRender({ ...healthy, audioBytes: 0, cancelled: true })).toBeNull()
  })

  it('stays quiet when the render already failed with a message of its own', () => {
    expect(diagnoseStreamRender({ ...healthy, audioBytes: 0, error: 'Breeze unreachable' })).toBeNull()
  })

  it('does not fire on a short line that legitimately produces little audio', () => {
    // 20 chars ≈ 1.4s; 1.2s came back.
    expect(diagnoseStreamRender({ chars: 20, audioBytes: 48000 * 1.2, sampleRate, error: null, cancelled: false })).toBeNull()
  })
})

describe('errorFromResponseBody', () => {
  it('pulls the sentence out of an h3 error envelope instead of showing raw JSON', () => {
    // What `await res.text()` returns from the new speak pre-flight's 400.
    const body = JSON.stringify({
      url: '/api/voice/speak',
      statusCode: 400,
      statusMessage: 'cfg_scale above 1.0 requires an instruction (the clone/plain templates define no negative prompt)',
      message: 'cfg_scale above 1.0 requires an instruction',
      stack: []
    })
    expect(errorFromResponseBody(body)).toBe(
      'cfg_scale above 1.0 requires an instruction (the clone/plain templates define no negative prompt)'
    )
    expect(errorFromResponseBody(body)).not.toContain('{')
  })

  it('passes a plain-text body straight through', () => {
    expect(errorFromResponseBody('Bad Gateway')).toBe('Bad Gateway')
  })

  it('falls back when the body is empty', () => {
    expect(errorFromResponseBody('', 'Service Unavailable')).toBe('Service Unavailable')
    expect(errorFromResponseBody('   ', 'Service Unavailable')).toBe('Service Unavailable')
  })

  it('shows what arrived when the body only LOOKS like JSON', () => {
    // A body truncated mid-flight must not disappear into a catch.
    expect(errorFromResponseBody('{"statusMessage":"cut off half')).toBe('{"statusMessage":"cut off half')
  })
})

describe('describeRenderPlan', () => {
  const clone100 = { instruction: 'Warmly.', refStorageKey: 'ref-key', maxSegmentChars: 100 }
  const design = { instruction: 'A neutral, low-key man.', refStorageKey: null, maxSegmentChars: 200 }

  // The warning this replaced fired on every ordinary read-aloud: all eight seeded design
  // presets carry maxSegmentChars 200, which for a reference-FREE preset is an unmeasured
  // default (585 characters rendered fine on the rig), so it cried wolf constantly.
  it('says nothing for a reference-free preset at a length it can actually speak', () => {
    expect(describeRenderPlan(600, design, 'quality')).toBeNull()
    expect(describeRenderPlan(800, design, 'quality')).toBeNull()
  })

  it('describes the split once a design preset genuinely exceeds its ceiling', () => {
    const msg = describeRenderPlan(3000, design, 'quality')
    expect(msg).toContain('3000')
    expect(msg).toMatch(/\b2 calls|\b3 calls|\b4 calls/)
  })

  // A long instruction eats the same prompt budget as the text, so it lowers the ceiling.
  it('accounts for the instruction sharing the budget', () => {
    const wordy = { ...design, instruction: 'x'.repeat(700) }
    expect(describeRenderPlan(400, design, 'quality')).toBeNull()
    expect(describeRenderPlan(400, wordy, 'quality')).not.toBeNull()
  })

  it('uses a clone preset\'s calibrated cap verbatim', () => {
    expect(describeRenderPlan(90, clone100, 'quality')).toBeNull()
    expect(describeRenderPlan(350, clone100, 'quality')).toContain('100')
  })

  it('explains realtime mode as the agent comparison it is', () => {
    const msg = describeRenderPlan(600, design, 'realtime')
    expect(msg).toContain('Realtime')
    expect(msg).toContain('200')
  })

  it('is silent for empty or tiny text in either mode', () => {
    expect(describeRenderPlan(0, design, 'quality')).toBeNull()
    expect(describeRenderPlan(10, design, 'realtime')).toBeNull()
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

describe('instructionHint', () => {
  const SPECIFIC = 'A warm, thoughtful young woman with a clear voice, calm reflective delivery, unhurried pace.'

  // The measured finding: a vague instruction at cfg 4 scattered 2.64s across four seeds,
  // a specific one 0.56s. The hint exists to say so at the moment it is actionable.
  it('nudges when the instruction is too short to constrain the model', () => {
    expect(instructionHint('A person speaking.', 4)).toContain('4.6x')
  })

  it('says nothing once the instruction is specific', () => {
    expect(instructionHint(SPECIFIC, 4)).toBeNull()
  })

  // cfg 1 loosens a detailed instruction back up (measured: spread widened to 1.36s).
  it('nudges a detailed instruction that is being held at cfg 1', () => {
    expect(instructionHint(SPECIFIC, 1)).toContain('cfg')
  })

  // An empty instruction is already explained by the cfg lock; two messages about the same
  // field at once is noise.
  it('defers to the cfg lock for an empty instruction', () => {
    expect(instructionHint('', 1)).toBeNull()
    expect(instructionHint('   ', 1)).toBeNull()
    expect(instructionHint(null, 1)).toBeNull()
  })
})

describe('toggleStarredSeed', () => {
  it('adds a seed that was not kept', () => {
    expect(toggleStarredSeed([], 11)).toEqual([11])
  })

  it('removes one that was', () => {
    expect(toggleStarredSeed([11, 42], 11)).toEqual([42])
  })

  it('keeps the list sorted and free of duplicates', () => {
    let s = toggleStarredSeed([], 900)
    s = toggleStarredSeed(s, 11)
    s = toggleStarredSeed(s, 42)
    expect(s).toEqual([11, 42, 900])
    expect(toggleStarredSeed(s, 42)).toEqual([11, 900])
  })

  it('does not mutate the array it was given', () => {
    const before = [11]
    toggleStarredSeed(before, 42)
    expect(before).toEqual([11])
  })
})

describe('draftIsDirty — array fields', () => {
  // starredSeeds is an array, so a reference comparison marks every freshly loaded preset
  // dirty and leaves Save enabled forever. Value comparison is load-bearing here.
  it('is clean when the kept seeds match by value but not by reference', () => {
    const p = { ...PRESET, starredSeeds: [11, 42] }
    expect(draftIsDirty(presetToDraft(p), p)).toBe(false)
  })

  it('is dirty when a seed is kept', () => {
    const p = { ...PRESET, starredSeeds: [11] }
    expect(draftIsDirty(draft({ starredSeeds: [11, 42] }), p)).toBe(true)
  })

  it('is dirty when a kept seed is dropped', () => {
    const p = { ...PRESET, starredSeeds: [11, 42] }
    expect(draftIsDirty(draft({ starredSeeds: [11] }), p)).toBe(true)
  })
})

describe('lockState', () => {
  const base = { refSource: null as 'upload' | 'locked' | null, refStorageKey: null as string | null, instruction: 'A calm man.' }

  it('offers locking once a description exists', () => {
    expect(lockState(base)).toBe('unlockable')
  })

  it('reports a locked voice', () => {
    expect(lockState({ ...base, refSource: 'locked', refStorageKey: 'k' })).toBe('locked')
  })

  // An uploaded clip is already consistent and anchors better than a render (4.5 Hz against
  // 22.6 measured) — offering to "lock" over it would be a downgrade dressed as an upgrade.
  it('leaves a preset that clones a supplied clip alone', () => {
    expect(lockState({ ...base, refSource: 'upload', refStorageKey: 'k' })).toBe('uploaded')
  })

  it('cannot lock a voice with nothing to freeze', () => {
    expect(lockState({ ...base, instruction: '' })).toBe('no-description')
    expect(lockState({ ...base, instruction: '   ' })).toBe('no-description')
    expect(lockState({ ...base, instruction: null })).toBe('no-description')
  })

  // A stored key with no source is a row from before locking existed; it was an upload.
  it('treats a legacy clip with no recorded source as an upload', () => {
    expect(lockState({ ...base, refStorageKey: 'legacy' })).toBe('uploaded')
  })
})

describe('lockHint', () => {
  it('explains the consequence of NOT locking, not just the mechanic', () => {
    expect(lockHint('unlockable')).toMatch(/several different people|re-cast/i)
  })

  it('says why an uploaded clip cannot be locked over', () => {
    expect(lockHint('uploaded')).toMatch(/already consistent/i)
  })

  it('has a distinct hint for every state', () => {
    const all = (['unlockable', 'locked', 'uploaded', 'no-description'] as const).map(lockHint)
    expect(new Set(all).size).toBe(4)
  })
})

describe('modeBadge — locked', () => {
  // A locked preset has both an instruction and a clip, so it DERIVES as 'direction' — but
  // presetToRequest speaks it as a pure clone, so that label would name a mode it never uses.
  it('labels a locked preset as locked, not direction', () => {
    const badge = modeBadge({ instruction: 'A calm man.', refStorageKey: 'k', refSource: 'locked' })
    expect(badge.label).toBe('locked')
  })

  it('still labels an uploaded clip by its derived mode', () => {
    expect(modeBadge({ instruction: 'A calm man.', refStorageKey: 'k', refSource: 'upload' }).label)
      .toBe('direction')
    expect(modeBadge({ instruction: null, refStorageKey: 'k', refSource: 'upload' }).label)
      .toBe('clone')
  })

  it('is unchanged for a preset with no reference', () => {
    expect(modeBadge({ instruction: 'A calm man.', refStorageKey: null, refSource: null }).label)
      .toBe('design')
  })
})

// ── The reference tuple has ONE owner ────────────────────────────────────────
//
// `ref_source` used to be written only by the lock/unlock routes while the clip fields were
// written only by Save, so a save could change WHETHER there is a clip without changing WHAT
// KIND it is. Every illegal combination was reachable, and two of them shipped:
//
//   clip + no source     → derives `direction`, spoken with the instruction re-applied
//   source + no clip     → lockState said 'locked' forever, so Lock never came back
//
// These tests pin the tuple together. They are about the pair, not the fields.
describe('the reference tuple is written as one unit', () => {
  it('carries refSource through the draft round trip', () => {
    const uploaded: VoicePresetDTO = { ...PRESET, refStorageKey: 'k', refText: 'hello', refSource: 'upload' }
    expect(presetToDraft(uploaded).refSource).toBe('upload')
    expect(draftToBody(presetToDraft(uploaded)).refSource).toBe('upload')
  })

  it('records an attached clip as an upload — nothing else ever sets it', () => {
    const f = attachedReference({ storageKey: 'k', refText: 'hello', durationMs: 9000 })
    expect(f).toEqual({ refStorageKey: 'k', refText: 'hello', refDurationMs: 9000, refSource: 'upload' })
  })

  it('clears all four fields together, never three of them', () => {
    expect(noReference()).toEqual({
      refStorageKey: null, refText: '', refDurationMs: null, refSource: null
    })
  })

  it('reads the reference tuple off a saved row so lock/unlock can resync the form', () => {
    const locked: VoicePresetDTO = {
      ...PRESET, refStorageKey: 'k', refText: 'passage', refDurationMs: 11920, refSource: 'locked'
    }
    expect(referenceFieldsOf(locked)).toEqual({
      refStorageKey: 'k', refText: 'passage', refDurationMs: 11920, refSource: 'locked'
    })
    expect(referenceFieldsOf(PRESET)).toEqual(noReference())
  })

  // The exact shape that broke bright-woman: unlock cleared the row, the draft kept the old
  // clip, and the next Save wrote it back with no source.
  it('a save after unlocking cannot resurrect the cleared clip', () => {
    const d = draft({ ...referenceFieldsOf({ ...PRESET, refStorageKey: 'k', refText: 'p', refSource: 'locked' }) })
    Object.assign(d, noReference())
    const body = draftToBody(d)
    expect(body.refStorageKey).toBeNull()
    expect(body.refSource).toBeNull()
  })

  it('notices a source-only change, so Save is not silently a no-op', () => {
    const p: VoicePresetDTO = { ...PRESET, refStorageKey: 'k', refText: 'hello', refSource: 'upload' }
    expect(draftIsDirty(presetToDraft(p), p)).toBe(false)
    expect(draftIsDirty({ ...presetToDraft(p), refSource: 'locked' }, p)).toBe(true)
  })
})

describe('lockState — a source with no clip is not a locked voice', () => {
  // Clearing the clip on a locked preset used to leave ref_source = 'locked' behind, and
  // lockState tested the source FIRST — so the pane reported a locked voice with nothing
  // frozen and never offered Lock again. The clip is what makes it locked.
  it('offers locking again once the frozen clip is gone', () => {
    expect(lockState({ refSource: 'locked', refStorageKey: null, instruction: 'A calm man.' }))
      .toBe('unlockable')
  })

  it('still needs a description when a stale source outlives the clip', () => {
    expect(lockState({ refSource: 'locked', refStorageKey: null, instruction: '' }))
      .toBe('no-description')
  })
})
