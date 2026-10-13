import { describe, expect, it } from 'vitest'
import type { JudgeSettings } from '@mymind/core/lib/agent/judge/types'
import { canSave, formConfidenceError, formFrom, isDirty, loadStateOf, patchFor } from './judge-settings-form'

const S: JudgeSettings = { enabled: true, smartApprovals: { workstreams: true, chat: false }, confidence: 0.9 }

describe('judge settings form (Task 4 fix round 1, M2/M7)', () => {
  it('loads from the saved settings, unchanged → not dirty, no save', () => {
    const f = formFrom(S)
    expect(f).toEqual({ enabled: true, workstreams: true, chat: false, confidence: '0.9' })
    expect(isDirty(f, S)).toBe(false)
    expect(canSave(f, S, 'ok', false)).toBe(false)
  })

  it('each field change is dirty and saveable; the patch carries exactly the form', () => {
    for (const change of [{ enabled: false }, { workstreams: false }, { chat: true }, { confidence: '0.95' }]) {
      const f = { ...formFrom(S), ...change }
      expect(isDirty(f, S)).toBe(true)
      expect(canSave(f, S, 'ok', false)).toBe(true)
    }
    expect(patchFor({ ...formFrom(S), chat: true, confidence: '0.95' })).toEqual({ judge: { enabled: true, smartApprovals: { workstreams: true, chat: true }, confidence: 0.95 } })
    expect(patchFor({ ...formFrom(S), confidence: 0.92 })).toMatchObject({ judge: { confidence: 0.92 } })
  })

  it('the same number typed differently is not a change', () => {
    expect(isDirty({ ...formFrom(S), confidence: '0.90' }, S)).toBe(false)
  })

  it('an invalid confidence blocks saving while the judge is on', () => {
    const f = { ...formFrom(S), confidence: '1.5' }
    expect(formConfidenceError(f)).toBe('Must be between 0.5 and 0.99')
    expect(canSave(f, S, 'ok', false)).toBe(false)
    expect(canSave({ ...f, chat: true }, S, 'ok', false)).toBe(false)
  })

  it('M2: switching the judge off ignores a bad confidence — "off" saves, and the bad value is not sent', () => {
    const f = { ...formFrom(S), confidence: '1.5', enabled: false }
    expect(formConfidenceError(f)).toBeNull()
    expect(canSave(f, S, 'ok', false)).toBe(true)
    expect(patchFor(f)).toEqual({ judge: { enabled: false, smartApprovals: { workstreams: true, chat: false } } })
    // Off with only a bad confidence typed and nothing else changed is not a change at all.
    expect(isDirty({ ...formFrom({ ...S, enabled: false }), confidence: '7' }, { ...S, enabled: false })).toBe(false)
  })

  it('nothing saves before a successful load, on a failed or corrupt load, or while saving', () => {
    const f = { ...formFrom(S), chat: true }
    expect(canSave(f, null, 'ok', false)).toBe(false)
    expect(canSave(f, S, 'loading', false)).toBe(false)
    expect(canSave(f, S, 'failed', false)).toBe(false)
    expect(canSave(f, S, 'corrupt', false)).toBe(false)
    expect(canSave(f, S, 'ok', true)).toBe(false)
  })

  it('M1: a GET naming corrupt fields is the corrupt state', () => {
    expect(loadStateOf({ problems: ['judge.enabled'] })).toBe('corrupt')
    expect(loadStateOf({ problems: [] })).toBe('ok')
    // Cycle 86: the confinement switch has its own control — its corrupt value doesn't lock the judge form.
    expect(loadStateOf({ problems: ['taintConfinement'] })).toBe('ok')
    expect(loadStateOf({ problems: ['taintConfinement', 'judge.enabled'] })).toBe('corrupt')
    expect(loadStateOf({})).toBe('ok')
  })
})
