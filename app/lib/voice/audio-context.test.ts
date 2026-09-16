// app/lib/voice/audio-context.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createAudioGate, isRunawayRender, RUNAWAY_MIN_CHARS, MIN_CHARS_PER_SECOND } from './audio-context'

/** A stand-in for the browser's AudioContext that starts SUSPENDED, the way Chrome hands
 *  one back when it is built outside a user gesture. `resume()` is what a real gesture
 *  would have made unnecessary. */
function fakeCtxFactory(startState: AudioContextState = 'suspended') {
  const made: FakeCtx[] = []
  class FakeCtx {
    state: AudioContextState = startState
    sampleRate: number
    resumed = 0
    closed = 0
    constructor(o: { sampleRate: number }) { this.sampleRate = o.sampleRate; made.push(this) }
    async resume() { this.resumed++; this.state = 'running' }
    async close() { this.closed++; this.state = 'closed' }
  }
  const factory = vi.fn((o: { sampleRate: number }) => new FakeCtx(o) as unknown as AudioContext)
  return { factory, made }
}

describe('createAudioGate', () => {
  it('creates the context at the requested rate', () => {
    const { factory, made } = fakeCtxFactory()
    const gate = createAudioGate(factory)
    gate.ensure(24000)
    expect(made).toHaveLength(1)
    expect(made[0]!.sampleRate).toBe(24000)
  })

  // The bug: a suspended context plays nothing and reports nothing.
  it('resumes a context the browser handed back suspended', () => {
    const { factory, made } = fakeCtxFactory('suspended')
    createAudioGate(factory).ensure(24000)
    expect(made[0]!.resumed).toBe(1)
  })

  it('does not resume one that is already running', () => {
    const { factory, made } = fakeCtxFactory('running')
    createAudioGate(factory).ensure(24000)
    expect(made[0]!.resumed).toBe(0)
  })

  // Reuse is the actual fix for "works sometimes": building a fresh context per render
  // means every render after the first is created outside a gesture.
  it('reuses the same context across renders at the same rate', () => {
    const { factory, made } = fakeCtxFactory()
    const gate = createAudioGate(factory)
    const a = gate.ensure(24000)
    const b = gate.ensure(24000)
    expect(a).toBe(b)
    expect(made).toHaveLength(1)
  })

  it('rebuilds when the rate changes, closing the old one', () => {
    const { factory, made } = fakeCtxFactory()
    const gate = createAudioGate(factory)
    gate.ensure(24000)
    gate.ensure(16000)
    expect(made).toHaveLength(2)
    expect(made[0]!.closed).toBe(1)
    expect(made[1]!.sampleRate).toBe(16000)
  })

  it('rebuilds if the context was closed underneath it', () => {
    const { factory, made } = fakeCtxFactory()
    const gate = createAudioGate(factory)
    const first = gate.ensure(24000)
    void (first as unknown as { close(): void }).close()
    gate.ensure(24000)
    expect(made).toHaveLength(2)
    expect(gate.current()).toBe(made[1] as unknown as AudioContext)
  })

  it('current() is null before ensure and after release', () => {
    const { factory } = fakeCtxFactory()
    const gate = createAudioGate(factory)
    expect(gate.current()).toBeNull()
    gate.ensure(24000)
    expect(gate.current()).not.toBeNull()
    gate.release()
    expect(gate.current()).toBeNull()
  })

  it('returns null when the environment has no AudioContext', () => {
    // No factory, and no global AudioContext in the node test env.
    expect(createAudioGate().ensure(24000)).toBeNull()
  })

  // The ordering guarantee, stated as a test: a caller that awaits BEFORE ensuring has
  // already spent the gesture. This pins the contract the composable must honour.
  it('ensure() is synchronous — it returns a context without awaiting', () => {
    const { factory } = fakeCtxFactory()
    const gate = createAudioGate(factory)
    const result = gate.ensure(24000)
    expect(result).not.toBeNull()
    expect(result).not.toBeInstanceOf(Promise)
  })
})

describe('isRunawayRender', () => {
  // Measured on the rig: past ~1000 chars the model stops tracking the text and rambles to
  // the 120s output cap, returning a COMPLETE body — invisible to any byte-count check.
  it('flags the measured runaway: 1200 chars producing 109.4s', () => {
    expect(isRunawayRender(1200, 109.4)).toBe(true)
  })

  it('flags the capped case: 1500 chars producing 120s', () => {
    expect(isRunawayRender(1500, 120)).toBe(true)
  })

  it.each([[600, 19.0], [900, 21.5]])(
    'leaves a healthy long render alone (%i chars -> %ss)',
    (chars, secs) => { expect(isRunawayRender(chars, secs)).toBe(false) }
  )

  // Short renders are dominated by fixed lead-in/lead-out, so their rate reads low even when
  // they are fine. These two measured 15.7 and 18.2 chars/sec — both below the floor, both
  // healthy. Judging them would cry wolf on every short line in the studio.
  it.each([[88, 5.6], [254, 13.92]])(
    'does not judge a short render (%i chars -> %ss), whose rate is misleadingly low',
    (chars, secs) => {
      expect(chars / secs).toBeLessThan(MIN_CHARS_PER_SECOND)   // would trip the floor
      expect(isRunawayRender(chars, secs)).toBe(false)          // but is exempt by length
    }
  )

  it('starts judging exactly at the length threshold', () => {
    const tooSlow = RUNAWAY_MIN_CHARS / (MIN_CHARS_PER_SECOND - 5)
    expect(isRunawayRender(RUNAWAY_MIN_CHARS - 1, tooSlow)).toBe(false)
    expect(isRunawayRender(RUNAWAY_MIN_CHARS, tooSlow)).toBe(true)
  })

  it('returns false for empty input rather than dividing by zero', () => {
    expect(isRunawayRender(0, 10)).toBe(false)
    expect(isRunawayRender(1000, 0)).toBe(false)
  })
})
