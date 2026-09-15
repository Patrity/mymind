import { describe, it, expect, vi } from 'vitest'
import { createSpeaker, pcmToWav, collectPcm, type SpeakChunk } from './speak'
import { createBreezeQueue } from './breeze-queue'
import { BreezeError } from './breeze'
import type { VoicePresetDTO } from '../../../shared/types/voice-presets'

const design: VoicePresetDTO = {
  id: 'p1', name: 'neutral', instruction: 'A neutral, low-key man.', cfgScale: 4, seed: 11,
  temperature: 0.9, topP: 1.0, topK: 50, refStorageKey: null, refText: null,
  refDurationMs: null, maxSegmentChars: 200, isDefault: true
}

function fakeSpeak(chunks: number[][], sampleRate = 24000) {
  // Typed with a rest param (rather than zero args) so TS infers `.mock.calls[n]` as an
  // indexable array instead of an empty `[]` tuple — needed under noUncheckedIndexedAccess
  // to read the request argument back out in the "maps the preset" assertion below.
  return vi.fn(async (..._args: unknown[]) => ({
    sampleRate,
    chunks: (async function* () { for (const c of chunks) yield new Uint8Array(c) })()
  }))
}

async function drain(it: AsyncIterable<SpeakChunk>) {
  const out: SpeakChunk[] = []
  for await (const c of it) out.push(c)
  return out
}

describe('createSpeaker', () => {
  it('emits a begin chunk carrying the sample rate, then pcm chunks in order', async () => {
    const speaker = createSpeaker({
      baseURL: async () => 'http://rig:8880',
      queue: createBreezeQueue(),
      speakFn: fakeSpeak([[1, 2], [3]], 16000) as never
    })
    const out = await drain(speaker('hi', design, 'agent'))
    expect(out[0]).toEqual({ kind: 'begin', sampleRate: 16000 })
    expect(out.slice(1).map(c => [...(c as { bytes: Uint8Array }).bytes])).toEqual([[1, 2], [3]])
  })

  it('maps the preset onto the Breeze request fields', async () => {
    const speakFn = fakeSpeak([[1]])
    const speaker = createSpeaker({ baseURL: async () => 'http://rig:8880', queue: createBreezeQueue(), speakFn: speakFn as never })
    await drain(speaker('hello there', design, 'agent'))
    expect(speakFn.mock.calls[0]![1]).toMatchObject({
      text: 'hello there', instruction: 'A neutral, low-key man.', cfgScale: 4, seed: 11, topP: 1.0, topK: 50
    })
  })

  // The slot must be held for the WHOLE stream, not just until headers — otherwise a
  // second caller starts generating while the first is still receiving audio, and the
  // rig 409s.
  it('holds the queue slot until the stream is fully drained', async () => {
    const queue = createBreezeQueue()
    const speaker = createSpeaker({
      baseURL: async () => 'http://rig:8880', queue,
      speakFn: fakeSpeak([[1], [2], [3]]) as never
    })
    const it = speaker('hi', design, 'agent')[Symbol.asyncIterator]()
    await it.next()                       // begin
    await it.next()                       // first pcm chunk
    let granted = false
    void queue.acquire('agent').then(r => { granted = true; r() })
    await new Promise(r => setTimeout(r, 0))
    expect(granted).toBe(false)           // still held mid-stream
    await it.next(); await it.next(); await it.next()  // drain to completion
    await new Promise(r => setTimeout(r, 0))
    expect(granted).toBe(true)
  })

  it('releases the slot when the stream throws', async () => {
    const queue = createBreezeQueue()
    const speaker = createSpeaker({
      baseURL: async () => 'http://rig:8880', queue,
      speakFn: vi.fn(async () => ({
        sampleRate: 24000,
        chunks: (async function* () { throw new BreezeError('truncated', 'no audio') })()
      })) as never
    })
    await expect(drain(speaker('hi', design, 'agent'))).rejects.toMatchObject({ code: 'truncated' })
    const r = await queue.acquire('agent')
    expect(typeof r).toBe('function')
    r()
  })

  it('releases the slot when breezeSpeak itself rejects', async () => {
    const queue = createBreezeQueue()
    const speaker = createSpeaker({
      baseURL: async () => 'http://rig:8880', queue,
      speakFn: vi.fn(async () => { throw new BreezeError('http', 'boom') }) as never
    })
    await expect(drain(speaker('hi', design, 'agent'))).rejects.toMatchObject({ code: 'http' })
    const r = await queue.acquire('agent')
    expect(typeof r).toBe('function')
    r()
  })
})

describe('pcmToWav', () => {
  it('prepends a 44-byte RIFF header describing mono s16le at the given rate', () => {
    const wav = pcmToWav(new Uint8Array([1, 2, 3, 4]), 24000)
    expect(wav.length).toBe(44 + 4)
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF')
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE')
    expect(wav.readUInt16LE(22)).toBe(1)        // channels
    expect(wav.readUInt32LE(24)).toBe(24000)    // sample rate
    expect(wav.readUInt16LE(34)).toBe(16)       // bits per sample
    expect(wav.readUInt32LE(40)).toBe(4)        // data chunk size
    expect(wav.readUInt32LE(4)).toBe(36 + 4)    // RIFF size
  })
})

describe('collectPcm', () => {
  it('concatenates pcm chunks and reports the sample rate from begin', async () => {
    async function* src(): AsyncIterable<SpeakChunk> {
      yield { kind: 'begin', sampleRate: 24000 }
      yield { kind: 'pcm', bytes: new Uint8Array([1, 2]) }
      yield { kind: 'pcm', bytes: new Uint8Array([3]) }
    }
    const { pcm, sampleRate } = await collectPcm(src())
    expect([...pcm]).toEqual([1, 2, 3])
    expect(sampleRate).toBe(24000)
  })
})
