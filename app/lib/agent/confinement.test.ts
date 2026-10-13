import { describe, expect, it } from 'vitest'
import { confinementOf } from './confinement'

describe('confinementOf (cycle 86: the confined chip)', () => {
  it('reads the four reasons with their labels and the note', () => {
    expect(confinementOf({ workspaceTainted: true, confined: { reason: 'tainted-run', note: 'n' }, stdout: '' })).toEqual({ reason: 'tainted-run', label: 'confined (tainted run)', note: 'n' })
    expect(confinementOf({ confined: { reason: 'tainted-workspace' } })).toMatchObject({ label: 'confined (tainted workspace)', note: '' })
    expect(confinementOf({ confined: { reason: 'unverified', note: 'x' } })?.label).toBe('confined (unverified content)')
    expect(confinementOf({ confined: { reason: 'eval', note: 'x' } })?.label).toBe('confined (eval)')
  })
  it('anything else is no chip', () => {
    for (const v of [null, undefined, 'confined', [], {}, { confined: true }, { confined: { reason: 'admin' } }, { confined: { reason: 3 } }]) expect(confinementOf(v)).toBeNull()
  })
})
