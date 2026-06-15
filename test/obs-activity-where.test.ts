import { describe, it, expect } from 'vitest'
import { buildActivityFilters } from '../server/services/activity'

describe('buildActivityFilters', () => {
  it('returns no filters for empty params', () => {
    expect(buildActivityFilters({})).toEqual([])
  })
  it('emits a filter descriptor per provided param', () => {
    const f = buildActivityFilters({ kind: 'model', status: 'error', severity: 'error', usage: 'reasoning', traceId: 't1' })
    const cols = f.map(x => x.col).sort()
    expect(cols).toEqual(['kind', 'severity', 'status', 'traceId', 'usage'])
  })
  it('passes q through as a name ILIKE descriptor', () => {
    const f = buildActivityFilters({ q: 'enrich' })
    expect(f[0]).toMatchObject({ col: 'name', op: 'ilike', value: '%enrich%' })
  })
})
