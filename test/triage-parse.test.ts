import { describe, it, expect } from 'vitest'
import { parseTriage } from '../server/lib/ai/triage'

const ok = JSON.stringify({
  primary: { kind: 'task', confidence: 0.9, title: 'Fix the loan link', project: 'finances' },
  secondary: [],
  reasoning: 'Imperative phrasing with a clear action.'
})

describe('parseTriage', () => {
  it('parses a bare JSON proposal', () => {
    const p = parseTriage(ok)
    expect(p?.primary.kind).toBe('task')
    expect(p?.primary.title).toBe('Fix the loan link')
    expect(p?.secondary).toEqual([])
  })

  it('strips markdown fences', () => {
    expect(parseTriage('```json\n' + ok + '\n```')?.primary.kind).toBe('task')
  })

  it('ignores prose wrapped around the JSON', () => {
    expect(parseTriage('Sure! Here you go:\n' + ok + '\nHope that helps.')?.primary.kind).toBe('task')
  })

  // Truncating beats rejecting: an over-eager list shouldn't throw away a good primary.
  it('truncates secondary beyond two entries instead of rejecting the proposal', () => {
    const many = JSON.stringify({
      primary: { kind: 'note', confidence: 0.8 },
      secondary: [
        { kind: 'task', confidence: 0.7 },
        { kind: 'memory', confidence: 0.6 },
        { kind: 'append', confidence: 0.5 },
        { kind: 'task', confidence: 0.4 }
      ],
      reasoning: 'x'
    })
    const p = parseTriage(many)
    expect(p?.secondary).toHaveLength(2)
    expect(p?.secondary.map(a => a.kind)).toEqual(['task', 'memory'])
  })

  it('clamps confidence into 0..1', () => {
    const p = parseTriage(JSON.stringify({
      primary: { kind: 'task', confidence: 4.2 }, secondary: [], reasoning: 'x'
    }))
    expect(p?.primary.confidence).toBe(1)
  })

  // Missing confidence must route to review, never auto-apply.
  it('treats a missing or non-numeric confidence as 0', () => {
    expect(parseTriage(JSON.stringify({
      primary: { kind: 'task' }, secondary: [], reasoning: 'x'
    }))?.primary.confidence).toBe(0)
    expect(parseTriage(JSON.stringify({
      primary: { kind: 'task', confidence: 'high' }, secondary: [], reasoning: 'x'
    }))?.primary.confidence).toBe(0)
  })

  it('returns null for an unknown kind', () => {
    expect(parseTriage(JSON.stringify({
      primary: { kind: 'archive', confidence: 0.9 }, secondary: [], reasoning: 'x'
    }))).toBeNull()
  })

  it('returns null for junk, empty input, and a missing primary', () => {
    expect(parseTriage('')).toBeNull()
    expect(parseTriage('no json here')).toBeNull()
    expect(parseTriage('{"secondary":[],"reasoning":"x"}')).toBeNull()
  })

  it('drops a malformed secondary entry but keeps a valid primary', () => {
    const p = parseTriage(JSON.stringify({
      primary: { kind: 'note', confidence: 0.8 },
      secondary: [{ kind: 'nonsense', confidence: 0.7 }, { kind: 'task', confidence: 0.6 }],
      reasoning: 'x'
    }))
    expect(p?.secondary.map(a => a.kind)).toEqual(['task'])
  })
})
