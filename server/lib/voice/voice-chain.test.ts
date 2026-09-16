// server/lib/voice/voice-chain.test.ts
import { describe, it, expect } from 'vitest'
import {
  createVoiceChain, chainedPreset, shouldChain, CHAIN_REF_KEY,
  MIN_CHAIN_REFERENCE_MS, MAX_CHAIN_REFERENCE_MS
} from './voice-chain'
import type { VoicePresetDTO } from '../../../shared/types/voice-presets'

const RATE = 24000
/** `ms` of PCM at 24 kHz, 16-bit mono. */
const audio = (ms: number) => new Uint8Array(Math.floor((ms / 1000) * RATE) * 2)

const design: VoicePresetDTO = {
  id: 'p1', name: 'neutral', instruction: 'A neutral, low-key man.', cfgScale: 4, seed: 11,
  temperature: 0.9, topP: 1, topK: 50, refStorageKey: null, refText: null, refDurationMs: null,
  maxSegmentChars: 200, calibratedRefKey: null, starredSeeds: [], isDefault: true,
}
const clone: VoicePresetDTO = { ...design, refStorageKey: 'stored-key', refText: 'a transcript' }

describe('shouldChain', () => {
  it('chains a preset with no reference of its own', () => {
    expect(shouldChain(design)).toBe(true)
  })

  // A chosen clip anchors better than a synthetic first segment — 14.7 Hz spread against
  // 19.2 Hz, measured. Overriding the user's own reference would be a downgrade.
  it('leaves a preset that already has a reference alone', () => {
    expect(shouldChain(clone)).toBe(false)
  })
})

describe('createVoiceChain', () => {
  it('has no reference before the first segment finishes', () => {
    const chain = createVoiceChain(RATE)
    chain.capture('Hello there.', audio(3000))
    expect(chain.reference()).toBeNull()
  })

  it('produces a reference once the first segment ends', () => {
    const chain = createVoiceChain(RATE)
    chain.capture('Hello there.', audio(3000))
    chain.endSegment()
    const ref = chain.reference()
    expect(ref).not.toBeNull()
    expect(ref!.text).toBe('Hello there.')
  })

  it('wraps the captured PCM as a real WAV, since Breeze only accepts a container', () => {
    const chain = createVoiceChain(RATE)
    chain.capture('Hello there.', audio(3000))
    chain.endSegment()
    const wav = Buffer.from(chain.reference()!.audio)
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF')
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE')
    expect(wav.readUInt32LE(24)).toBe(RATE)
  })

  it('keeps capturing across several chunks of the first segment', () => {
    const chain = createVoiceChain(RATE)
    chain.capture('Hello there.', audio(1000))
    chain.capture('Hello there.', audio(1000))
    chain.capture('Hello there.', audio(1000))
    chain.endSegment()
    const wav = Buffer.from(chain.reference()!.audio)
    expect(wav.readUInt32LE(40)).toBe(audio(3000).length)   // data chunk size
  })

  // A turn anchored to half a syllable is worse than an unanchored one.
  it('refuses to build a reference from too little audio', () => {
    const chain = createVoiceChain(RATE)
    chain.capture('Hi.', audio(MIN_CHAIN_REFERENCE_MS - 200))
    chain.endSegment()
    expect(chain.reference()).toBeNull()
  })

  it('refuses to build one with no text, since Breeze needs a matching transcript', () => {
    const chain = createVoiceChain(RATE)
    chain.capture('   ', audio(3000))
    chain.endSegment()
    expect(chain.reference()).toBeNull()
  })

  // The clip shares the prompt budget with the text; past a few seconds it buys no extra
  // likeness, only budget.
  it('caps the reference length', () => {
    const chain = createVoiceChain(RATE)
    chain.capture('Long one.', audio(MAX_CHAIN_REFERENCE_MS + 5000))
    chain.endSegment()
    const wav = Buffer.from(chain.reference()!.audio)
    const maxBytes = Math.floor((MAX_CHAIN_REFERENCE_MS / 1000) * RATE) * 2
    expect(wav.readUInt32LE(40)).toBeLessThanOrEqual(maxBytes)
  })

  it('anchors to the FIRST segment, never a later one', () => {
    const chain = createVoiceChain(RATE)
    chain.capture('First segment.', audio(3000))
    chain.endSegment()
    chain.capture('Second segment.', audio(3000))
    chain.endSegment()
    expect(chain.reference()!.text).toBe('First segment.')
  })

  it('captures nothing and reports nothing when disabled', () => {
    const chain = createVoiceChain(RATE, false)
    chain.capture('Hello there.', audio(3000))
    chain.endSegment()
    expect(chain.reference()).toBeNull()
  })

  // A first segment that was dropped mid-render leaves the turn unchained rather than
  // anchored to a fragment — and a LATER segment must not then become the anchor.
  it('stays unchained for the whole turn if the first segment was too short', () => {
    const chain = createVoiceChain(RATE)
    chain.capture('Hi.', audio(200))
    chain.endSegment()
    chain.capture('A much longer second segment here.', audio(5000))
    chain.endSegment()
    expect(chain.reference()).toBeNull()
  })
})

describe('chainedPreset', () => {
  const ref = { audio: new Uint8Array([1, 2]), text: 'The first segment we spoke.' }

  // Measured: keeping the instruction (direction, cfg 4) held the voice to a 19.2 Hz
  // spread, against 38.9 Hz for a plain clone with the instruction dropped.
  it('keeps the instruction and cfg so the segment stays in direction mode', () => {
    const p = chainedPreset(design, ref)
    expect(p.instruction).toBe(design.instruction)
    expect(p.cfgScale).toBe(4)
  })

  it('attaches the chain transcript verbatim', () => {
    expect(chainedPreset(design, ref).refText).toBe('The first segment we spoke.')
  })

  it('marks the preset as reference-backed so downstream mode and ceiling logic agree', () => {
    expect(chainedPreset(design, ref).refStorageKey).toBe(CHAIN_REF_KEY)
  })

  it('does not mutate the preset it was given', () => {
    chainedPreset(design, ref)
    expect(design.refStorageKey).toBeNull()
    expect(design.refText).toBeNull()
  })

  // The sentinel is turn-local. Writing it to a row would point a preset at a clip that
  // never existed in storage.
  it('uses a sentinel that is obviously not a storage key', () => {
    expect(CHAIN_REF_KEY).toMatch(/^__/)
  })
})
