// test/home-endpoint.db.test.ts
//
// `pnpm test:db` runs plain vitest with no Nuxt runtime, so this file supplies what Nuxt
// normally provides at boot: load `.env` for DATABASE_URL and stub the `useRuntimeConfig`
// auto-import that `useDb()` depends on (server/db/index.ts). Same pattern as
// test/usage-aggregation.db.test.ts / test/activity-count.db.test.ts.
process.loadEnvFile('.env')
import { describe, it, expect, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

const { getHome } = await import('../server/services/home')
const { HOME_RANGE_KEYS } = await import('../shared/types/home')

describe('getHome', () => {
  it('returns a complete payload for every range key', async () => {
    for (const range of HOME_RANGE_KEYS) {
      const r = await getHome(range)
      expect(r.range).toBe(range)
      expect(r.timeline.days).toBeInstanceOf(Array)
      expect(r.timeline.shown).toBeLessThanOrEqual(r.timeline.total)
      expect(r.tasks.length).toBeLessThanOrEqual(5)
      expect(r.projects.length).toBeLessThanOrEqual(5)
      expect(typeof r.attention.conflicts).toBe('number')
      expect(typeof r.metrics.sessions.total).toBe('number')
    }
  })

  it('attention counts are IDENTICAL across ranges (absolute backlog, not range-scoped)', async () => {
    const a = await getHome('1d')
    const b = await getHome('30d')
    expect(a.attention).toEqual(b.attention)
  })

  it('a wider range never yields fewer timeline rows than a narrower one', async () => {
    const narrow = await getHome('1d')
    const wide = await getHome('30d')
    expect(wide.timeline.total).toBeGreaterThanOrEqual(narrow.timeline.total)
  })

  it('every timeline entry carries a non-empty href', async () => {
    const r = await getHome('30d')
    const entries = r.timeline.days.flatMap(d => d.entries)
    for (const e of entries) expect(e.href.length).toBeGreaterThan(0)
  })
})
