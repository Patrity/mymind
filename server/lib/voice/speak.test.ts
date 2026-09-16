import { describe, it, expect, vi } from 'vitest'
import { createSpeaker, pcmToWav, collectPcm, type SpeakChunk } from './speak'
import { createBreezeQueue } from './breeze-queue'
import { BreezeError } from './breeze'
import type { VoicePresetDTO } from '../../../shared/types/voice-presets'

const design: VoicePresetDTO = {
  id: 'p1', name: 'neutral', instruction: 'A neutral, low-key man.', cfgScale: 4, seed: 11,
  temperature: 0.9, topP: 1.0, topK: 50, refStorageKey: null, refText: null,
  refDurationMs: null, maxSegmentChars: 200, calibratedRefKey: null, starredSeeds: [], isDefault: true
}

function fakeSpeak(chunks: number[][], sampleRate = 24000) {
  // Typed with a rest param (rather than zero args) so TS infers `.mock.calls[n]` as an
  // indexable array instead of an empty `[]` tuple — needed under noUncheckedIndexedAccess
  // to read the request argument back out in the "maps the preset" assertion below.
  return vi.fn(async (..._args: unknown[]) => ({
    sampleRate,
    // Every real BreezeStream carries this — the queue slot is held until it settles, so a
    // fixture without one hangs (or, before it existed, threw).
    drained: Promise.resolve(),
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
        drained: Promise.resolve(),
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

  // Pins the behaviour the studio route's disconnect handling depends on: a consumer
  // that walks away mid-stream (a client disconnect, in the HTTP route) must free the
  // rig via the generator's `finally`, not just via natural completion or a thrown
  // error. A future h3/runtime change could silently stop calling this without this test.
  it('releases the slot when the consumer abandons the iterator via return()', async () => {
    const queue = createBreezeQueue()
    const speaker = createSpeaker({
      baseURL: async () => 'http://rig:8880', queue,
      speakFn: fakeSpeak([[1], [2], [3]]) as never
    })
    const it = speaker('hi', design, 'agent')[Symbol.asyncIterator]()
    await it.next()                       // begin — slot held, generator now parked at a yield
    await it.return?.()
    // A fresh acquire only resolves if the earlier slot was actually released.
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

describe('createSpeaker — cancellation drains, never aborts', () => {
  const preset: VoicePresetDTO = design

  /** A stream whose body is still "generating" until the test lets it finish — the shape a
   *  real render has when a barge-in lands mid-way. */
  function gatedStream() {
    let finish!: () => void
    const bodyDone = new Promise<void>(r => { finish = r })
    let drainedResolve!: () => void
    const drained = new Promise<void>(r => { drainedResolve = r })
    let fullyRead = false
    const stream = {
      sampleRate: 24000,
      drained,
      chunks: (async function* () {
        yield new Uint8Array([1])
        await bodyDone          // still generating on the rig
        yield new Uint8Array([2])
        fullyRead = true
      })(),
    }
    return { stream, finish: () => { finish(); queueMicrotask(drainedResolve) }, readFully: () => fullyRead }
  }

  // The whole point: the rig keeps working after a consumer walks away, so releasing the
  // slot at that moment starts the next request into a busy server — a 409 storm.
  it('holds the queue slot until the body has drained, not until the consumer leaves', async () => {
    const queue = createBreezeQueue()
    const { stream, finish } = gatedStream()
    const speaker = createSpeaker({
      baseURL: async () => 'http://rig:8880',
      queue,
      speakFn: (async () => stream) as never,
    })

    const ac = new AbortController()
    const it = speaker('hi', preset, 'agent', ac.signal)[Symbol.asyncIterator]()
    await it.next()            // begin
    await it.next()            // first pcm chunk
    ac.abort()                 // barge-in
    void it.return?.()

    let granted = false
    void queue.acquire('agent').then(r => { granted = true; r() })
    await new Promise(r => setTimeout(r, 10))
    expect(granted).toBe(false)   // still held — the rig is still generating

    finish()
    await new Promise(r => setTimeout(r, 10))
    expect(granted).toBe(true)
  })

  it('stops DELIVERING immediately on abort even though the body drains on', async () => {
    const queue = createBreezeQueue()
    const speaker = createSpeaker({
      baseURL: async () => 'http://rig:8880',
      queue,
      speakFn: (async () => ({
        sampleRate: 24000,
        drained: Promise.resolve(),
        chunks: (async function* () {
          yield new Uint8Array([1])
          yield new Uint8Array([2])
          yield new Uint8Array([3])
        })(),
      })) as never,
    })

    const ac = new AbortController()
    const delivered: number[] = []
    for await (const c of speaker('hi', preset, 'agent', ac.signal)) {
      if (c.kind === 'pcm') { delivered.push(c.bytes[0]!); ac.abort() }
    }
    // One chunk reached the listener; the rest were drained and discarded.
    expect(delivered).toEqual([1])
  })

  it('retries a busy rig instead of failing on the first 409', async () => {
    let calls = 0
    const waits: number[] = []
    const speaker = createSpeaker({
      baseURL: async () => 'http://rig:8880',
      queue: createBreezeQueue(),
      sleep: async (ms) => { waits.push(ms) },
      speakFn: (async () => {
        calls++
        if (calls < 3) throw new BreezeError('busy', 'already running')
        return {
          sampleRate: 24000,
          drained: Promise.resolve(),
          chunks: (async function* () { yield new Uint8Array([9]) })(),
        }
      }) as never,
    })
    const out: number[] = []
    for await (const c of speaker('hi', preset, 'studio')) {
      if (c.kind === 'pcm') out.push(c.bytes[0]!)
    }
    expect(calls).toBe(3)
    expect(waits).toEqual([1500, 3000])   // linear backoff, not exponential
    expect(out).toEqual([9])
  })

  it('gives up after the attempt cap rather than retrying forever', async () => {
    let calls = 0
    const speaker = createSpeaker({
      baseURL: async () => 'http://rig:8880',
      queue: createBreezeQueue(),
      sleep: async () => {},
      speakFn: (async () => { calls++; throw new BreezeError('busy', 'always busy') }) as never,
    })
    await expect(drain(speaker('hi', preset, 'studio'))).rejects.toMatchObject({ code: 'busy' })
    expect(calls).toBe(5)
  })

  it('does not retry a non-busy failure', async () => {
    let calls = 0
    const speaker = createSpeaker({
      baseURL: async () => 'http://rig:8880',
      queue: createBreezeQueue(),
      sleep: async () => {},
      speakFn: (async () => { calls++; throw new BreezeError('http', 'boom') }) as never,
    })
    await expect(drain(speaker('hi', preset, 'studio'))).rejects.toMatchObject({ code: 'http' })
    expect(calls).toBe(1)
  })
})
