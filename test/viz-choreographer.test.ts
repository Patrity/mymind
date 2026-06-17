import { describe, it, expect } from 'vitest'
import { createChoreographer, type VizInputs } from '../app/lib/viz/choreographer'
import { BAR_COUNT } from '../app/lib/viz/types'
import { PALETTE } from '../app/lib/viz/tuning'

const DT = 1 / 60

function inputs(over: Partial<VizInputs> = {}): VizInputs {
  return { state: 'idle', connected: true, micLevels: new Float32Array(BAR_COUNT), outLevel: 0, ...over }
}

function run(c: ReturnType<typeof createChoreographer>, inp: VizInputs, frames: number) {
  let d = c.update(inp, DT)
  for (let i = 1; i < frames; i++) d = c.update(inp, DT)
  return d
}

describe('choreographer', () => {
  it('lerps core color toward the active state palette', () => {
    const c = createChoreographer()
    const d = run(c, inputs({ state: 'speaking' }), 120)
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(d.coreColor[i]! - PALETTE.speaking.core[i]!)).toBeLessThan(0.05)
    }
  })

  it('bargein spikes shatter, which decays back near zero', () => {
    const c = createChoreographer()
    run(c, inputs({ state: 'speaking' }), 10)
    c.handleEvent({ type: 'bargein' })
    const d1 = c.update(inputs({ state: 'listening' }), DT)
    expect(d1.shatter).toBeGreaterThan(0.9)
    const d2 = run(c, inputs({ state: 'listening' }), 120)
    expect(d2.shatter).toBeLessThan(0.05)
  })

  it('derives disconnected from connected=false, except while connecting', () => {
    const c = createChoreographer()
    expect(c.update(inputs({ connected: false }), DT).vizState).toBe('disconnected')
    expect(c.update(inputs({ state: 'connecting', connected: false }), DT).vizState).toBe('connecting')
  })

  it('assemble resets on entering connecting, then builds back up', () => {
    const c = createChoreographer()
    const settled = run(c, inputs(), 300)
    expect(settled.assemble).toBeGreaterThan(0.9)
    const d1 = c.update(inputs({ state: 'connecting', connected: false }), DT)
    expect(d1.assemble).toBeLessThan(0.1)
    const d2 = run(c, inputs({ state: 'connecting', connected: false }), 300)
    expect(d2.assemble).toBeGreaterThan(0.9)
  })

  it('fires ignite when leaving connecting (WS opened)', () => {
    const c = createChoreographer()
    run(c, inputs({ state: 'connecting', connected: false }), 30)
    const d = c.update(inputs({ state: 'idle' }), DT)
    expect(d.ignite).toBeGreaterThan(0.8)
  })

  it('sttFinal sparks scale with length, are consumed after one frame', () => {
    const c = createChoreographer()
    c.handleEvent({ type: 'sttFinal', chars: 100 })
    expect(c.update(inputs(), DT).sparks).toBe(33) // min(40, 8 + floor(100/4))
    expect(c.update(inputs(), DT).sparks).toBe(0)
  })

  it('mic levels attack faster than they release', () => {
    const c = createChoreographer()
    const hot = new Float32Array(BAR_COUNT).fill(1)
    const before = c.update(inputs({ state: 'listening' }), DT).ringLevels[0]!
    const peak = c.update(inputs({ state: 'listening', micLevels: hot }), DT).ringLevels[0]!
    const after = c.update(inputs({ state: 'listening' }), DT).ringLevels[0]!
    expect(peak - before).toBeGreaterThan(peak - after) // rise step > fall step
    expect(after).toBeGreaterThan(0) // slow release, not a hard cut
  })

  it('error flash decays below 0.05 within ~1.2s', () => {
    const c = createChoreographer()
    c.handleEvent({ type: 'error' })
    const d = run(c, inputs(), 72)
    expect(d.errorFlash).toBeLessThan(0.05)
  })

  it('tool state turns pulses on, others off', () => {
    const c = createChoreographer()
    expect(c.update(inputs({ state: 'tool' }), DT).pulseRate).toBeGreaterThan(0)
    expect(c.update(inputs({ state: 'idle' }), DT).pulseRate).toBe(0)
  })

  it('returns the same Directives object every frame (mutate-in-place contract)', () => {
    const c = createChoreographer()
    expect(c.update(inputs(), DT)).toBe(c.update(inputs(), DT))
  })

  it('energy rises with playback level while speaking', () => {
    const c = createChoreographer()
    const quiet = run(c, inputs({ state: 'speaking' }), 120).energy
    const loud = run(c, inputs({ state: 'speaking', outLevel: 1 }), 120).energy
    expect(loud).toBeGreaterThan(quiet + 0.5)
  })

  it('dims fully when disconnected, partially when idle', () => {
    const c = createChoreographer()
    expect(run(c, inputs({ connected: false }), 200).dim).toBeGreaterThan(0.9)    // → 1
    expect(run(c, inputs(), 200).dim).toBeCloseTo(0.35, 1)                        // idle
  })

  it('neural lightning fires while thinking, simmers during tool, off when idle', () => {
    const c = createChoreographer()
    expect(run(c, inputs({ state: 'thinking' }), 120).firing).toBeGreaterThan(0.9)
    expect(run(c, inputs({ state: 'tool' }), 120).firing).toBeGreaterThan(0.2)
    expect(run(c, inputs({ state: 'idle' }), 120).firing).toBeLessThan(0.1)
  })

  it('caps sparks at SPARKS_MAX for long transcripts', () => {
    const c = createChoreographer()
    c.handleEvent({ type: 'sttFinal', chars: 10_000 })
    expect(c.update(inputs(), DT).sparks).toBe(40)
  })

  it('does not ignite when a connect attempt dies (connecting → disconnected)', () => {
    const c = createChoreographer()
    run(c, inputs({ state: 'connecting', connected: false }), 30)
    const d = c.update(inputs({ state: 'idle', connected: false }), DT)
    expect(d.vizState).toBe('disconnected')
    expect(d.ignite).toBe(0)
  })

  it('typing state yields vizState:typing with dim≈0 and firing>0 but < thinking', () => {
    const c = createChoreographer()
    const settled = run(c, inputs({ state: 'typing' }), 200)
    expect(settled.vizState).toBe('typing')
    expect(settled.dim).toBeCloseTo(0, 1)
    expect(settled.firing).toBeGreaterThan(0)
    const thinkingFiring = run(createChoreographer(), inputs({ state: 'thinking' }), 200).firing
    expect(settled.firing).toBeLessThan(thinkingFiring)
  })
})
