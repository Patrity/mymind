import { describe, it, expect } from 'vitest'
import { decideSync } from '../server/lib/analytics/prices'

const NOW = new Date('2026-09-03T18:00:00Z')
const DAY_AGO = new Date('2026-09-02T18:00:00Z')
const HOUR_AGO = new Date('2026-09-03T17:00:00Z')

describe('decideSync', () => {
  it('syncs when a model appears that we have never attempted to price', () => {
    const d = decideSync({
      recentModels: ['claude-fable-5-1', 'claude-opus-4-7'],
      attempted: ['claude-opus-4-7', '<synthetic>'],
      lastFullSyncAt: HOUR_AGO,
      now: NOW
    })
    expect(d.sync).toBe(true)
    expect(d.reason).toBe('new-model')
    expect(d.newModels).toEqual(['claude-fable-5-1'])
  })

  it('does NOT sync for a model we already attempted and could not price', () => {
    // '<synthetic>' is in every recent window forever and is permanently unpriceable.
    // Re-fetching the map for it every run is exactly the hammering this guard prevents.
    const d = decideSync({
      recentModels: ['<synthetic>', 'claude-opus-4-7'],
      attempted: ['claude-opus-4-7', '<synthetic>'],
      lastFullSyncAt: HOUR_AGO,
      now: NOW
    })
    expect(d.sync).toBe(false)
    expect(d.reason).toBe('none')
  })

  it('syncs on staleness even when nothing new appeared — rates themselves change', () => {
    const d = decideSync({
      recentModels: ['claude-opus-4-7'],
      attempted: ['claude-opus-4-7'],
      lastFullSyncAt: DAY_AGO,
      now: NOW
    })
    expect(d.sync).toBe(true)
    expect(d.reason).toBe('stale')
  })

  it('syncs on a cold start when no sync has ever run', () => {
    const d = decideSync({ recentModels: [], attempted: [], lastFullSyncAt: null, now: NOW })
    expect(d.sync).toBe(true)
    expect(d.reason).toBe('stale')
  })

  it('prefers the new-model reason over staleness when both hold', () => {
    const d = decideSync({
      recentModels: ['brand-new'],
      attempted: [],
      lastFullSyncAt: DAY_AGO,
      now: NOW
    })
    expect(d.reason).toBe('new-model')
  })
})
