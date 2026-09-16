// server/lib/voice/pipeline.test.ts
import { describe, it, expect, vi } from 'vitest'
import { SpeechPipeline } from './pipeline'
import type { SpeakChunk } from './speak'
import type { VoicePresetDTO } from '../../../shared/types/voice-presets'

const preset: VoicePresetDTO = {
  id: 'p1', name: 'n', instruction: 'A calm man.', cfgScale: 4, seed: 11, temperature: 0.9,
  topP: 1, topK: 50, refStorageKey: null, refText: null, refDurationMs: null,
  maxSegmentChars: 200, calibratedRefKey: null, starredSeeds: [], isDefault: true
}

/** A controllable fake TtsProvider.synthesize: resolves after `delayMs(text)`,
 *  optionally throwing, and respects the AbortSignal the way a real fetch would.
 *  Yields the `begin` chunk then one pcm chunk whose single byte identifies `text`
 *  by length, and records start/end via the optional hooks. */
function fakeSynth(opts: {
  delayMs: (text: string) => number
  throwsFor?: Set<string>
  onStart?: (text: string, at: number) => void
  onEnd?: (text: string, at: number) => void
}) {
  return async function* synthesize(text: string, sopts: { signal?: AbortSignal }): AsyncIterable<SpeakChunk> {
    const startedAt = performance.now()
    opts.onStart?.(text, startedAt)
    await new Promise<void>((resolve, reject) => {
      const ms = opts.delayMs(text)
      const timer = setTimeout(() => {
        if (opts.throwsFor?.has(text)) reject(new Error(`synthesis failed for ${text}`))
        else resolve()
      }, ms)
      const onAbort = () => {
        clearTimeout(timer)
        const err = new Error('aborted')
        err.name = 'AbortError'
        reject(err)
      }
      if (sopts.signal?.aborted) onAbort()
      else sopts.signal?.addEventListener('abort', onAbort, { once: true })
    })
    opts.onEnd?.(text, performance.now())
    yield { kind: 'begin', sampleRate: 24000 }
    yield { kind: 'pcm', bytes: new Uint8Array([text.length]) }
  }
}

describe('SpeechPipeline', () => {
  it('drops a segment whose synthesis throws, and keeps playing the rest', async () => {
    const synth = fakeSynth({ delayMs: () => 5, throwsFor: new Set(['bad']) })
    const audio: number[] = []
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const pipeline = new SpeechPipeline({
      synthesize: synth, preset, signal: new AbortController().signal, concurrency: 1,
      onChunk: (c) => { if (c.kind === 'pcm') audio.push(c.bytes[0]!) }
    })

    await pipeline.push('good1')
    await pipeline.push('bad')
    await pipeline.push('good2')
    await pipeline.drain()

    // 'good1'.length = 5, 'good2'.length = 5; 'bad' never emits anything.
    expect(audio).toEqual([5, 5])
    errSpy.mockRestore()
  })

  it('stops cleanly on abort: no further audio is emitted after abort fires', async () => {
    const ac = new AbortController()
    const synth = fakeSynth({ delayMs: () => 100 })
    const audio: number[] = []
    const pipeline = new SpeechPipeline({
      synthesize: synth, preset, signal: ac.signal, concurrency: 1,
      onChunk: (c) => { if (c.kind === 'pcm') audio.push(c.bytes[0]!) }
    })

    const inFlight = pipeline.push('seg1') // starts a 100ms synth
    await new Promise(r => setTimeout(r, 10))
    ac.abort()
    await inFlight
    await pipeline.drain()
    expect(audio).toEqual([]) // aborted mid-flight: never emitted

    // A push AFTER abort must be a pure no-op — no synth call at all.
    let secondCallStarted = false
    const trackedSynth = fakeSynth({ delayMs: () => 5, onStart: () => { secondCallStarted = true } })
    const pipeline2 = new SpeechPipeline({
      synthesize: trackedSynth, preset, signal: ac.signal, concurrency: 1,
      onChunk: (c) => { if (c.kind === 'pcm') audio.push(c.bytes[0]!) }
    })
    await pipeline2.push('seg2')
    await pipeline2.drain()

    expect(secondCallStarted).toBe(false)
    expect(audio).toEqual([])
  })

  it('rejects any concurrency other than 1 — emission now happens inside start()', () => {
    expect(() => new SpeechPipeline({
      synthesize: (async function* () {}) as never, preset,
      signal: new AbortController().signal, concurrency: 3, onChunk: () => {}
    })).toThrow(/concurrency must be 1/)
  })
})

describe('SpeechPipeline — streaming chunks', () => {
  it('emits chunks as they arrive, not buffered to the end of the segment', async () => {
    const seen: string[] = []
    let releaseSecond!: () => void
    let generatorFinished = false
    const gate = new Promise<void>(r => { releaseSecond = r })
    const synthesize = async function* (): AsyncIterable<SpeakChunk> {
      yield { kind: 'begin', sampleRate: 24000 }
      yield { kind: 'pcm', bytes: new Uint8Array([1]) }
      await gate
      yield { kind: 'pcm', bytes: new Uint8Array([2]) }
      generatorFinished = true
    }
    const p = new SpeechPipeline({
      synthesize: synthesize as never,
      preset,
      signal: new AbortController().signal,
      concurrency: 1,
      onChunk: (c) => { seen.push(c.kind === 'begin' ? 'begin' : String(c.bytes[0])) }
    })
    const done = p.push('hello').then(() => p.drain())
    await new Promise(r => setTimeout(r, 0))
    // If the pipeline buffered the segment, NOTHING would have been emitted yet.
    expect(seen).toEqual(['begin', '1'])
    // …and this is what makes the assertion above discriminating rather than merely
    // order-checking: the segment's generator is still suspended on `gate`, so a
    // collect-then-replay pipeline could not possibly have emitted anything.
    expect(generatorFinished).toBe(false)
    releaseSecond()
    await done
    expect(seen).toEqual(['begin', '1', '2'])
    expect(generatorFinished).toBe(true)
  })

  it('drops a segment whose synthesis throws and keeps the turn going', async () => {
    const seen: string[] = []
    let call = 0
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const synthesize = async function* (): AsyncIterable<SpeakChunk> {
      call++
      if (call === 1) throw new Error('truncated')
      yield { kind: 'begin', sampleRate: 24000 }
      yield { kind: 'pcm', bytes: new Uint8Array([9]) }
    }
    const p = new SpeechPipeline({
      synthesize: synthesize as never, preset, signal: new AbortController().signal,
      concurrency: 1, onChunk: (c) => seen.push(c.kind === 'begin' ? 'begin' : String(c.bytes[0]))
    })
    await p.push('one')
    await p.push('two')
    await p.drain()
    expect(seen).toEqual(['begin', '9'])
    errSpy.mockRestore()
  })

  it('fires onSegmentEnd once per segment — after its chunks, and even when it is dropped', async () => {
    const log: string[] = []
    let call = 0
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const synthesize = async function* (): AsyncIterable<SpeakChunk> {
      call++
      if (call === 2) throw new Error('truncated')
      yield { kind: 'begin', sampleRate: 24000 }
      yield { kind: 'pcm', bytes: new Uint8Array([call]) }
    }
    const p = new SpeechPipeline({
      synthesize: synthesize as never, preset, signal: new AbortController().signal, concurrency: 1,
      onChunk: (c) => log.push(c.kind === 'begin' ? 'begin' : `pcm${c.bytes[0]}`),
      onSegmentEnd: () => log.push('end')
    })
    await p.push('one')
    await p.push('two')   // throws → dropped
    await p.push('three')
    await p.drain()
    expect(log).toEqual(['begin', 'pcm1', 'end', 'end', 'begin', 'pcm3', 'end'])
    errSpy.mockRestore()
  })
})
