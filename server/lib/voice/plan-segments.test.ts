// server/lib/voice/plan-segments.test.ts
import { describe, it, expect } from 'vitest'
import {
  planSegments, maxCallChars, DESIGN_PROMPT_BUDGET, MIN_SEGMENT_CHARS
} from './plan-segments'

const design = { instruction: 'A neutral, low-key man.', refStorageKey: null, maxSegmentChars: 200 }
const clone = { instruction: 'Warmly.', refStorageKey: 'k', maxSegmentChars: 100 }
const AGENT_CAP = 200

const words = (n: number) => 'The rig has five graphics cards and plenty of memory. '.repeat(50).slice(0, n)

describe('maxCallChars', () => {
  // The calibration measured this clip against this budget; extending it would hand the rig
  // a prompt nobody proved it can take.
  it('uses a reference preset\'s calibrated cap verbatim', () => {
    expect(maxCallChars(clone)).toBe(100)
  })

  it('does not extend a calibrated cap even when it is small', () => {
    expect(maxCallChars({ ...clone, maxSegmentChars: 100 })).toBe(100)
  })

  // Instruction and text share one prompt budget — a long instruction really does leave
  // less room for text, which a fixed constant would get wrong.
  it('subtracts the instruction from the design budget', () => {
    const instruction = 'x'.repeat(300)
    expect(maxCallChars({ instruction, refStorageKey: null, maxSegmentChars: 200 }))
      .toBe(DESIGN_PROMPT_BUDGET - 300)
  })

  it('gives a short instruction close to the whole budget', () => {
    expect(maxCallChars(design)).toBe(DESIGN_PROMPT_BUDGET - design.instruction.length)
  })

  it('never returns less than the floor, however long the instruction', () => {
    const instruction = 'x'.repeat(DESIGN_PROMPT_BUDGET * 2)
    expect(maxCallChars({ instruction, refStorageKey: null, maxSegmentChars: 200 }))
      .toBe(MIN_SEGMENT_CHARS)
  })

  it('treats a whitespace-only instruction as costing nothing', () => {
    expect(maxCallChars({ instruction: '   ', refStorageKey: null, maxSegmentChars: 200 }))
      .toBe(DESIGN_PROMPT_BUDGET)
  })
})

describe('planSegments — quality', () => {
  // The whole point: the studio has the full text, so it should not be paying the agent's
  // segmentation tax (measured at +10.3% audio and audible seams).
  it('sends text in ONE call when it fits, even well past the agent cap', () => {
    const text = words(600)
    const plan = planSegments(text, design, 'quality', AGENT_CAP)
    expect(plan.segments).toHaveLength(1)
    expect(plan.segments[0]).toBe(text.trim())
    expect(plan.reason).toBe('single-call')
  })

  it('splits only when the text genuinely exceeds the ceiling', () => {
    const plan = planSegments(words(2000), design, 'quality', AGENT_CAP)
    expect(plan.segments.length).toBeGreaterThan(1)
    expect(plan.reason).toBe('exceeds-ceiling')
  })

  // Past the measured break the model rambles to the output cap and returns a complete
  // body, so nothing downstream can catch it — the ceiling has to hold here.
  it('never emits a segment over the ceiling', () => {
    const plan = planSegments(words(5000), design, 'quality', AGENT_CAP)
    for (const s of plan.segments) expect(s.length).toBeLessThanOrEqual(plan.ceiling)
  })

  it('splits a single enormous sentence with no boundary to break on', () => {
    const plan = planSegments('x'.repeat(3000), design, 'quality', AGENT_CAP)
    expect(plan.segments.length).toBeGreaterThan(1)
    for (const s of plan.segments) expect(s.length).toBeLessThanOrEqual(plan.ceiling)
    expect(plan.segments.join('')).toBe('x'.repeat(3000))
  })

  it('respects a clone preset\'s much smaller calibrated cap', () => {
    const plan = planSegments(words(600), clone, 'quality', AGENT_CAP)
    for (const s of plan.segments) expect(s.length).toBeLessThanOrEqual(100)
    expect(plan.ceiling).toBe(100)
  })

  it('loses no text when it splits', () => {
    const text = words(1800)
    const plan = planSegments(text, design, 'quality', AGENT_CAP)
    const joined = plan.segments.join(' ').replace(/\s+/g, ' ').trim()
    expect(joined).toBe(text.trim().replace(/\s+/g, ' '))
  })

  it('returns no segments for empty text', () => {
    expect(planSegments('   ', design, 'quality', AGENT_CAP).segments).toEqual([])
  })
})

describe('planSegments — realtime', () => {
  it('segments at the agent cap so the two modes can be compared by ear', () => {
    const plan = planSegments(words(600), design, 'realtime', AGENT_CAP)
    expect(plan.segments.length).toBeGreaterThan(1)
    expect(plan.reason).toBe('realtime')
    for (const s of plan.segments) expect(s.length).toBeLessThanOrEqual(AGENT_CAP)
  })

  // Switching mode must not be able to hand the rig a prompt the preset was measured
  // as unable to take.
  it('still honours a calibrated cap smaller than the agent cap', () => {
    const plan = planSegments(words(600), clone, 'realtime', AGENT_CAP)
    for (const s of plan.segments) expect(s.length).toBeLessThanOrEqual(100)
  })

  it('produces more segments than quality for the same text', () => {
    const text = words(600)
    const q = planSegments(text, design, 'quality', AGENT_CAP)
    const r = planSegments(text, design, 'realtime', AGENT_CAP)
    expect(r.segments.length).toBeGreaterThan(q.segments.length)
  })
})

describe('planSegments — packing density', () => {
  // Browser-caught regression: reusing the agent's segment() flushed at EVERY sentence end,
  // turning 1480 chars under an 875 ceiling into 20 calls instead of 2 — 20 rig slots and a
  // seam per sentence, the exact opposite of what quality mode is for. The earlier tests
  // passed because "more than one segment, each under the cap" is true of 20 as well as 2.
  it('uses as few segments as the ceiling allows, not one per sentence', () => {
    const text = 'The rig has five graphics cards and plenty of memory for the voice stack. '.repeat(20)
    const plan = planSegments(text, design, 'quality', AGENT_CAP)
    const minimum = Math.ceil(text.trim().length / plan.ceiling)
    expect(plan.segments.length).toBe(minimum)
    expect(plan.segments.length).toBeLessThanOrEqual(3)
  })

  it('packs whole sentences rather than slicing mid-sentence', () => {
    const text = 'One sentence here. Another sentence here. A third one here. '.repeat(30)
    const plan = planSegments(text, design, 'quality', AGENT_CAP)
    for (const s of plan.segments) {
      expect(s.length).toBeLessThanOrEqual(plan.ceiling)
      expect(s.trim()).toMatch(/[.!?]$/)   // never cut mid-sentence
    }
  })

  it('still fills each realtime segment rather than emitting one per sentence', () => {
    const text = 'Short one. Short two. Short three. Short four. Short five. Short six. '.repeat(6)
    const plan = planSegments(text, design, 'realtime', AGENT_CAP)
    const minimum = Math.ceil(text.trim().length / AGENT_CAP)
    expect(plan.segments.length).toBeLessThanOrEqual(minimum + 1)
  })
})
