import { describe, it, expect } from 'vitest'
import {
  archivalPlan,
  isConflictResolution,
  queueStatusFor,
  CONFLICT_RESOLUTIONS
} from '../server/lib/review/conflict-resolution'

const IDS = { newId: 'new-1', existingId: 'old-1' }

describe('archivalPlan', () => {
  it('keeps both: archives nothing', () => {
    expect(archivalPlan('keep-both', IDS)).toEqual({ archive: [], supersededBy: null })
  })

  it('archive-old: archives the EXISTING memory and points it at the new one', () => {
    expect(archivalPlan('archive-old', IDS)).toEqual({ archive: ['old-1'], supersededBy: 'new-1' })
  })

  it('archive-new: archives the NEW memory and points it at the existing one', () => {
    // The direction matters and is easy to invert: getting it backwards archives the memory
    // the user chose to keep, silently, with no error anywhere.
    expect(archivalPlan('archive-new', IDS)).toEqual({ archive: ['new-1'], supersededBy: 'old-1' })
  })

  it('archive-both: archives the pair and sets NO successor', () => {
    // Neither survives, so neither can supersede the other — pointing a dead row at another
    // dead row would make the supersede chain lie to anything that walks it.
    const plan = archivalPlan('archive-both', IDS)
    expect(plan.archive.sort()).toEqual(['new-1', 'old-1'])
    expect(plan.supersededBy).toBeNull()
  })

  it('never archives a memory that is not one of the two in the conflict', () => {
    for (const r of CONFLICT_RESOLUTIONS) {
      for (const id of archivalPlan(r, IDS).archive) {
        expect([IDS.newId, IDS.existingId]).toContain(id)
      }
    }
  })

  it('never names a successor that is not one of the two, and never a memory it just archived', () => {
    for (const r of CONFLICT_RESOLUTIONS) {
      const { archive, supersededBy } = archivalPlan(r, IDS)
      if (supersededBy === null) continue
      expect([IDS.newId, IDS.existingId]).toContain(supersededBy)
      expect(archive).not.toContain(supersededBy)
    }
  })
})

describe('queueStatusFor', () => {
  it('treats only keep-both as a rejection of the proposal', () => {
    expect(queueStatusFor('keep-both')).toBe('rejected')
    expect(queueStatusFor('archive-old')).toBe('approved')
    expect(queueStatusFor('archive-new')).toBe('approved')
    expect(queueStatusFor('archive-both')).toBe('approved')
  })
})

describe('isConflictResolution', () => {
  it('accepts exactly the four known resolutions', () => {
    for (const r of CONFLICT_RESOLUTIONS) expect(isConflictResolution(r)).toBe(true)
  })

  it('rejects anything else, including near-misses and non-strings', () => {
    for (const bad of ['approve', 'reject', 'archive', 'ARCHIVE-OLD', '', null, undefined, 3, {}]) {
      expect(isConflictResolution(bad)).toBe(false)
    }
  })
})
