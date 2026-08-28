// server/lib/voice/pipeline.test.ts
import { describe, it, expect, vi } from 'vitest'
import { SpeechPipeline } from './pipeline'

/** A controllable fake TtsProvider.synthesize: resolves after `delayMs(text)`,
 *  optionally throwing, and respects the AbortSignal the way a real fetch would.
 *  Tags each yielded chunk's single byte with `text`'s identity via a caller-supplied
 *  map, and records start/end timestamps + live concurrency via the optional hooks. */
function fakeSynth(opts: {
  delayMs: (text: string) => number
  throwsFor?: Set<string>
  onStart?: (text: string, at: number) => void
  onEnd?: (text: string, at: number) => void
}) {
  return async function* synthesize(text: string, sopts: { signal?: AbortSignal }) {
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
    yield new Uint8Array([text.length])
  }
}

describe('SpeechPipeline', () => {
  // NOTE ON THE FIRST SEGMENT: pipeline.ts always synthesizes the turn's first segment
  // ALONE (FIRST_SEGMENT_CONCURRENCY = 1) — some backends behind this app share one GPU
  // across "concurrent" slots, so racing chunk 1 against others only makes chunk 1
  // slower. Depth only widens to `concurrency` AFTER the first segment has been
  // drained. Tests that want to exercise steady-state overlap/capping therefore warm
  // the pipeline up with one dispatched "seg0" first — see `warmUp` below. The
  // depth-1-then-N ramp itself is asserted directly in its own test further down.
  async function warmUp(pipeline: SpeechPipeline, resolve?: () => void) {
    const p = pipeline.push('__warmup__')
    resolve?.()
    await p
    await pipeline.drain()
  }

  it('ramps from depth 1 (first segment alone) to full concurrency once it has been dispatched', async () => {
    // The requirement this proves: exactly ONE request in flight until the first
    // chunk's audio is emitted; only afterwards can 2-3 run at once.
    const resolvers: Record<string, () => void> = {}
    let inFlight = 0
    let maxInFlightBeforeFirstAudio = 0
    let maxInFlightAfterFirstAudio = 0
    let firstAudioEmitted = false
    const synth = async function* (text: string) {
      inFlight++
      if (firstAudioEmitted) maxInFlightAfterFirstAudio = Math.max(maxInFlightAfterFirstAudio, inFlight)
      else maxInFlightBeforeFirstAudio = Math.max(maxInFlightBeforeFirstAudio, inFlight)
      await new Promise<void>(resolve => { resolvers[text] = resolve })
      inFlight--
      yield new Uint8Array([0])
    }
    const pipeline = new SpeechPipeline({
      synthesize: synth, voice: 'v', signal: new AbortController().signal, concurrency: 3,
      onAudio: () => { firstAudioEmitted = true }
    })

    await pipeline.push('s1') // the turn's first segment
    expect(inFlight).toBe(1)

    const p2 = pipeline.push('s2')
    expect(inFlight).toBe(1) // s2 must NOT have started — depth is still 1, pre-dispatch
    resolvers.s1!() // "dispatch" s1's audio to the client
    await p2
    expect(firstAudioEmitted).toBe(true)
    expect(inFlight).toBe(1) // s1 drained, s2 now the lone in-flight segment

    const p3 = pipeline.push('s3') // post-dispatch: depth widens to `concurrency`
    await p3
    expect(inFlight).toBe(2) // s2 AND s3 concurrent — the widen actually happened

    const p4 = pipeline.push('s4')
    await p4
    expect(inFlight).toBe(3) // full steady-state depth reached

    resolvers.s2!(); resolvers.s3!(); resolvers.s4!()
    await pipeline.drain()

    expect(maxInFlightBeforeFirstAudio).toBe(1)
    expect(maxInFlightAfterFirstAudio).toBe(3)
  })

  it('overlaps synthesis in the steady state: segment 3 starts before segment 2 finishes', async () => {
    const timings: Record<string, { start: number; end: number }> = {}
    const synth = fakeSynth({
      delayMs: (t) => (t === 'seg2' ? 60 : 10),
      onStart: (t, at) => { timings[t] = { start: at, end: -1 } },
      onEnd: (t, at) => { timings[t]!.end = at }
    })
    const pipeline = new SpeechPipeline({
      synthesize: synth, voice: 'v', signal: new AbortController().signal, concurrency: 3,
      onAudio: () => {}
    })
    await warmUp(pipeline) // get past the depth-1 first-segment phase

    await pipeline.push('seg2')
    await pipeline.push('seg3')
    await pipeline.drain()

    expect(timings.seg2).toBeDefined()
    expect(timings.seg3).toBeDefined()
    // seg3 must have STARTED before seg2 ENDED — proof of real overlap, not a
    // sequential pipeline that would just happen to look ordered on emission.
    expect(timings.seg3!.start).toBeLessThan(timings.seg2!.end)
  })

  it('never runs more than `concurrency` syntheses at once, in the steady state', async () => {
    // Real timers make this timing-sensitive to schedule, so drive each segment's
    // synthesis with a manually-controlled gate instead: the test resolves each gate
    // explicitly, in a chosen order, so the interleaving is fully deterministic —
    // this directly exercises "before starting a fourth, await the oldest".
    const resolvers: Record<string, () => void> = {}
    let inFlight = 0
    let maxInFlight = 0
    const synth = async function* (text: string) {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise<void>(resolve => { resolvers[text] = resolve })
      inFlight--
      yield new Uint8Array([0])
    }
    const pipeline = new SpeechPipeline({
      synthesize: synth, voice: 'v', signal: new AbortController().signal, concurrency: 3,
      onAudio: () => {}
    })
    await warmUp(pipeline, () => resolvers.__warmup__!())

    // First 3 (post-warmup) segments start with no backpressure at all (queue not yet
    // full) — the steady-state cap, not the depth-1 first-segment phase, is what's
    // under test here.
    await pipeline.push('s1')
    await pipeline.push('s2')
    await pipeline.push('s3')
    expect(inFlight).toBe(3)

    // Pushing a 4th must block until the OLDEST (s1) is drained — resolve s1 while
    // push('s4') is pending, proving the drain is what unblocks it.
    const p4 = pipeline.push('s4')
    expect(inFlight).toBe(3) // s4 has NOT started yet — still gated on s1 draining
    resolvers.s1!()
    await p4
    expect(inFlight).toBe(3) // s1 out, s4 in — cap held at 3 throughout

    const p5 = pipeline.push('s5')
    resolvers.s2!()
    await p5

    const p6 = pipeline.push('s6')
    resolvers.s3!()
    await p6

    resolvers.s4!(); resolvers.s5!(); resolvers.s6!()
    await pipeline.drain()

    // The cap must actually be EXERCISED (not just trivially satisfied because
    // everything happened to run one at a time) — with 6 segments and a cap of 3,
    // concurrency must have reached the cap.
    expect(maxInFlight).toBe(3)
  })

  it('emits audio strictly in segment order even when a later segment finishes first', async () => {
    // seg2 is slow, seg3 and seg4 are fast — seg3/seg4 finish SYNTHESIZING first
    // (they're pushed only once past the depth-1 phase, so they genuinely race seg2),
    // but must still be EMITTED after seg2. Tag each chunk with a distinct id (not
    // text length, which is identical across these) so emission order is unambiguous.
    const ids: Record<string, number> = { seg2: 2, seg3: 3, seg4: 4 }
    const names: Record<number, string> = { 2: 'seg2', 3: 'seg3', 4: 'seg4' }
    const synth = fakeSynth({ delayMs: (t) => (t === 'seg2' ? 50 : 5) })
    const order: string[] = []
    const pipeline = new SpeechPipeline({
      synthesize: async function* (text, sopts) {
        for await (const _ of synth(text, sopts)) yield new Uint8Array([ids[text] ?? 0])
      },
      voice: 'v', signal: new AbortController().signal, concurrency: 3,
      // Emission order — this is what the ordering guarantee is actually about.
      onAudio: (bytes) => { const n = names[bytes[0]!]; if (n) order.push(n) }
    })
    await warmUp(pipeline) // get past the depth-1 first-segment phase

    await pipeline.push('seg2')
    await pipeline.push('seg3')
    await pipeline.push('seg4')
    await pipeline.drain()

    expect(order).toEqual(['seg2', 'seg3', 'seg4'])
  })

  it('drops a segment whose synthesis throws, and keeps playing the rest', async () => {
    const synth = fakeSynth({ delayMs: () => 5, throwsFor: new Set(['bad']) })
    const audio: number[] = []
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const pipeline = new SpeechPipeline({
      synthesize: synth, voice: 'v', signal: new AbortController().signal, concurrency: 3,
      onAudio: (bytes) => audio.push(bytes[0]!)
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
      synthesize: synth, voice: 'v', signal: ac.signal, concurrency: 3,
      onAudio: (bytes) => audio.push(bytes[0]!)
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
      synthesize: trackedSynth, voice: 'v', signal: ac.signal, concurrency: 3,
      onAudio: (bytes) => audio.push(bytes[0]!)
    })
    await pipeline2.push('seg2')
    await pipeline2.drain()

    expect(secondCallStarted).toBe(false)
    expect(audio).toEqual([])
  })
})
