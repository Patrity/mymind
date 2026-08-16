import { describe, it, expect } from 'vitest'
import { route } from '../server/lib/triage/route'
import type { TriageProposal, TriageAction } from '../shared/types/triage'

const T = { task: 0.7, note: 0.7, memory: 0.8, append: 0.85 }
const act = (o: Partial<TriageAction> = {}): TriageAction => ({ kind: 'task', confidence: 0.9, ...o })
const prop = (primary: TriageAction, secondary: TriageAction[] = []): TriageProposal =>
  ({ primary, secondary, reasoning: 'x' })

describe('route', () => {
  it('auto-applies an action above its bar', () => {
    const r = route(prop(act({ kind: 'task', confidence: 0.71 })), T)
    expect(r).toEqual([{ action: expect.objectContaining({ kind: 'task' }), autoApply: true }])
  })

  it('holds an action below its bar for review', () => {
    expect(route(prop(act({ kind: 'task', confidence: 0.69 })), T)[0]!.autoApply).toBe(false)
  })

  // A bar is a floor, not a strict threshold — exactly-at must apply, or a 0.70 bar
  // silently behaves as 0.7000…1 and the config value lies about itself.
  it('auto-applies an action exactly at its bar', () => {
    expect(route(prop(act({ kind: 'task', confidence: 0.7 })), T)[0]!.autoApply).toBe(true)
  })

  it('applies each destination against its OWN bar', () => {
    // 0.82 clears task/note (0.7) and memory (0.8) but not append (0.85)
    const r = route(prop(act({ kind: 'memory', confidence: 0.82 }), [act({ kind: 'append', confidence: 0.82 })]), T)
    expect(r[0]!.autoApply).toBe(true)
    expect(r[1]!.autoApply).toBe(false)
  })

  // The rule the spec is emphatic about: no destination categorically requires review.
  it('does not force secondaries to review when they clear their bar', () => {
    const r = route(prop(act({ kind: 'task', confidence: 0.95 }), [act({ kind: 'memory', confidence: 0.9 })]), T)
    expect(r.every(x => x.autoApply)).toBe(true)
  })

  it('mixes: confident primary applies while an uncertain secondary waits', () => {
    const r = route(prop(act({ kind: 'task', confidence: 0.95 }), [act({ kind: 'memory', confidence: 0.5 })]), T)
    expect(r[0]!.autoApply).toBe(true)
    expect(r[1]!.autoApply).toBe(false)
  })

  it('returns the primary first, then secondaries in order', () => {
    const r = route(prop(act({ kind: 'note' }), [act({ kind: 'task' }), act({ kind: 'memory' })]), T)
    expect(r.map(x => x.action.kind)).toEqual(['note', 'task', 'memory'])
  })

  // The shipped config. Nothing may auto-apply at 1.1, including a perfect 1.0.
  it('auto-applies nothing when every bar is 1.1', () => {
    const ship = { task: 1.1, note: 1.1, memory: 1.1, append: 1.1 }
    const r = route(prop(act({ confidence: 1 }), [act({ kind: 'memory', confidence: 1 })]), ship)
    expect(r.every(x => x.autoApply === false)).toBe(true)
  })
})
