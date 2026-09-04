// Real-Postgres test for the price-sync trigger's persistence + recent-model window.
// Excluded from `pnpm test` (CI has no DB) — run with `pnpm test:db`.
process.loadEnvFile('.env')
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { sql } from 'drizzle-orm'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

const { useDb } = await import('../server/db')
const { readSyncState, writeSyncState, recentModelsSince, SYNC_STATE_KEY }
  = await import('../server/lib/analytics/price-sync-state')
const { decideSync } = await import('../server/lib/analytics/prices')

const SESSION = '00000000-0000-4000-8000-00000000bee1'
const OLD = new Date('2026-01-01T00:00:00Z')
const RECENT = new Date('2026-08-01T00:00:00Z')
const CUTOFF = new Date('2026-06-01T00:00:00Z')

describe('price sync state (real DB)', () => {
  beforeAll(async () => {
    const db = useDb()
    await db.execute(sql`delete from messages where session_id = ${SESSION}`)
    await db.execute(sql`delete from settings where key = ${SYNC_STATE_KEY}`)
    await db.execute(sql`
      insert into messages (session_id, external_uuid, model, created_at) values
        (${SESSION}, 'old-1',    'model-seen-long-ago', ${OLD.toISOString()}),
        (${SESSION}, 'recent-1', 'model-seen-recently', ${RECENT.toISOString()}),
        (${SESSION}, 'recent-2', 'model-seen-recently', ${RECENT.toISOString()})`)
  })

  afterAll(async () => {
    const db = useDb()
    await db.execute(sql`delete from messages where session_id = ${SESSION}`)
    await db.execute(sql`delete from settings where key = ${SYNC_STATE_KEY}`)
  })

  it('returns only distinct models newer than the cutoff', async () => {
    const models = await recentModelsSince(CUTOFF)
    expect(models).toContain('model-seen-recently')
    expect(models).not.toContain('model-seen-long-ago')
  })

  it('returns every model when there is no cutoff (cold start)', async () => {
    const models = await recentModelsSince(null)
    expect(models).toContain('model-seen-recently')
    expect(models).toContain('model-seen-long-ago')
  })

  it('reads a zero state before anything has been written', async () => {
    const s = await readSyncState()
    expect(s).toEqual({ attempted: [], lastFullSyncAt: null })
  })

  it('round-trips attempted models and the sync timestamp through jsonb', async () => {
    const at = new Date('2026-09-03T04:00:00.000Z')
    await writeSyncState({ attempted: ['a', '<synthetic>'], lastFullSyncAt: at })
    const s = await readSyncState()
    expect(s.attempted).toEqual(['a', '<synthetic>'])
    expect(s.lastFullSyncAt?.toISOString()).toBe(at.toISOString())
  })

  it('overwrites rather than appending on a second write', async () => {
    const at = new Date('2026-09-04T04:00:00.000Z')
    await writeSyncState({ attempted: ['only-this'], lastFullSyncAt: at })
    const s = await readSyncState()
    expect(s.attempted).toEqual(['only-this'])
  })
})

// The 2026-09-03 incident, replayed against a real DB: a model first seen AFTER the last sync
// must trigger, and the permanently-unpriceable model that shares its window must not.
describe('new-model trigger (real DB, composed as the task composes it)', () => {
  const LAST_SYNC = new Date('2026-08-15T04:00:00Z')
  const AFTER = new Date('2026-08-15T14:54:00Z')

  beforeAll(async () => {
    const db = useDb()
    await db.execute(sql`delete from messages where session_id = ${SESSION}`)
    await db.execute(sql`
      insert into messages (session_id, external_uuid, model, created_at) values
        (${SESSION}, 'syn-1',   '<synthetic>',      ${AFTER.toISOString()}),
        (${SESSION}, 'fable-1', 'claude-fable-5-1', ${AFTER.toISOString()})`)
    await writeSyncState({ attempted: ['<synthetic>', 'claude-opus-4-7'], lastFullSyncAt: LAST_SYNC })
  })

  it('triggers on the model that appeared after the last sync, ignoring the unpriceable one', async () => {
    const state = await readSyncState()
    const recent = await recentModelsSince(state.lastFullSyncAt)
    const d = decideSync({ recentModels: recent, attempted: state.attempted, lastFullSyncAt: state.lastFullSyncAt, now: AFTER })
    expect(d.sync).toBe(true)
    expect(d.reason).toBe('new-model')
    expect(d.newModels).toContain('claude-fable-5-1')
    expect(d.newModels).not.toContain('<synthetic>')
  })

  it('goes quiet once that model has been attempted — no fetch on the next tick', async () => {
    await writeSyncState({ attempted: ['<synthetic>', 'claude-fable-5-1'], lastFullSyncAt: AFTER })
    const state = await readSyncState()
    const recent = await recentModelsSince(state.lastFullSyncAt)
    const d = decideSync({ recentModels: recent, attempted: state.attempted, lastFullSyncAt: state.lastFullSyncAt, now: AFTER })
    expect(d.sync).toBe(false)
    expect(d.reason).toBe('none')
  })
})
