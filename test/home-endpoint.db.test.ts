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
const { useDb } = await import('../server/db')
const { reviewQueue } = await import('../server/db/schema')
const { eq } = await import('drizzle-orm')
const { randomUUID } = await import('node:crypto')

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

  // task-12 fix round 1: a headless run's proposed tool call (kind='agent-action') is not a
  // memory conflict — the NeedsAttention widget's "conflicts" badge is hardcoded to "memory
  // conflict(s) to resolve" (app/components/home/NeedsAttention.vue), and its timeline event is
  // hardcoded to "Memory conflict flagged". A pending agent-action row must not inflate either.
  it('a pending agent-action row does not inflate the conflicts count', async () => {
    const before = await getHome('30d')
    const db = useDb()
    const [row] = await db.insert(reviewQueue).values({
      targetKind: 'agent_run', targetId: randomUUID(), kind: 'agent-action',
      proposed: { tool: 'edit_task', args: {}, conversationId: randomUUID() }
    }).returning()
    try {
      const after = await getHome('30d')
      expect(after.attention.conflicts).toBe(before.attention.conflicts)
    } finally {
      await db.delete(reviewQueue).where(eq(reviewQueue.id, row!.id))
    }
  })
})
