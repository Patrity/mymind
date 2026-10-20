import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { efSearchFor, withHnswSession, pgvectorSupportsIterativeScan, _resetHnswCapabilityForTests, type HnswDb } from '@mymind/core/lib/search/hnsw'

const dialect = new PgDialect()
const text = (q: SQL) => dialect.sqlToQuery(q).sql

/** A fake drizzle handle: `transaction(fn)` runs fn with a tx whose `execute` records SQL text. */
function fakeDb(opts: { extversion?: string | null, failVersionProbe?: boolean } = {}) {
  const executed: string[] = []
  const tx = {
    execute: vi.fn(async (q: SQL) => {
      executed.push(text(q))
      return { rows: [] }
    })
  }
  const db = {
    transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    execute: vi.fn(async (q: SQL) => {
      const s = text(q)
      if (opts.failVersionProbe) throw new Error('boom')
      if (s.includes('pg_extension')) return { rows: opts.extversion === null ? [] : [{ extversion: opts.extversion ?? '0.8.2' }] }
      return { rows: [] }
    })
  }
  return { db: db as unknown as HnswDb, executed, tx }
}

beforeEach(() => _resetHnswCapabilityForTests())

describe('efSearchFor', () => {
  it('is at least the configured minimum and at least 2× the LIMIT', () => {
    expect(efSearchFor(50, 100)).toBe(100) // the lanes' LIMIT 50 → 100, not pgvector's default 40
    expect(efSearchFor(100, 100)).toBe(200) // searchDocIds' chunk lane LIMIT 100
    expect(efSearchFor(10, 100)).toBe(100) // searchPassages LIMIT 10
    expect(efSearchFor(10, 300)).toBe(300) // a raised minimum wins
  })
  it('never exceeds pgvector\'s hard ceiling of 1000', () => {
    expect(efSearchFor(5000, 100)).toBe(1000)
    expect(efSearchFor(50, 99999)).toBe(1000)
  })
  it('never goes below 1 for a nonsensical LIMIT or minimum', () => {
    expect(efSearchFor(0, 0)).toBe(1)
    expect(efSearchFor(-5, -5)).toBe(1)
  })
})

describe('withHnswSession', () => {
  it('runs the lane inside a transaction with SET LOCAL hnsw.ef_search = max(min, 2×limit)', async () => {
    const { db, executed, tx } = fakeDb()
    const ran = await withHnswSession(db, { limit: 50, filtered: false, efSearchMin: 100, iterativeScan: true }, async (t) => {
      expect(t).toBe(tx) // the lane query must run on the SAME connection the SET LOCAL ran on
      return 'lane-result'
    })
    expect(ran).toBe('lane-result')
    expect(executed).toEqual(['SET LOCAL hnsw.ef_search = 100'])
  })

  it('adds SET LOCAL hnsw.iterative_scan = relaxed_order on a filtered lane when pgvector >= 0.8', async () => {
    const { db, executed } = fakeDb({ extversion: '0.8.2' })
    await withHnswSession(db, { limit: 50, filtered: true, efSearchMin: 100, iterativeScan: true }, async () => null)
    expect(executed).toEqual([
      'SET LOCAL hnsw.ef_search = 100',
      'SET LOCAL hnsw.iterative_scan = \'relaxed_order\''
    ])
  })

  it('does NOT set iterative_scan on an unfiltered lane', async () => {
    const { db, executed } = fakeDb({ extversion: '0.8.2' })
    await withHnswSession(db, { limit: 50, filtered: false, efSearchMin: 100, iterativeScan: true }, async () => null)
    expect(executed.some(s => s.includes('iterative_scan'))).toBe(false)
  })

  it('does NOT set iterative_scan when the settings flag is off', async () => {
    const { db, executed } = fakeDb({ extversion: '0.8.2' })
    await withHnswSession(db, { limit: 50, filtered: true, efSearchMin: 100, iterativeScan: false }, async () => null)
    expect(executed).toEqual(['SET LOCAL hnsw.ef_search = 100'])
  })

  it('degrades gracefully on pgvector < 0.8: ef_search only, no iterative_scan', async () => {
    const { db, executed } = fakeDb({ extversion: '0.7.4' })
    await withHnswSession(db, { limit: 50, filtered: true, efSearchMin: 100, iterativeScan: true }, async () => null)
    expect(executed).toEqual(['SET LOCAL hnsw.ef_search = 100'])
  })

  it('treats a failed or empty version probe as "unsupported" rather than throwing', async () => {
    for (const fake of [fakeDb({ failVersionProbe: true }), fakeDb({ extversion: null })]) {
      _resetHnswCapabilityForTests()
      await fake.db.transaction // just to keep TS happy about the handle
      await withHnswSession(fake.db, { limit: 50, filtered: true, efSearchMin: 100, iterativeScan: true }, async () => null)
      expect(fake.executed).toEqual(['SET LOCAL hnsw.ef_search = 100'])
    }
  })

  it('emits the ef_search value as a bare integer literal (SET LOCAL cannot take a bind parameter)', async () => {
    const { db, executed } = fakeDb()
    await withHnswSession(db, { limit: 100, filtered: false, efSearchMin: 100, iterativeScan: true }, async () => null)
    expect(executed[0]).toBe('SET LOCAL hnsw.ef_search = 200')
    expect(executed[0]).not.toContain('$1')
  })
})

describe('pgvectorSupportsIterativeScan', () => {
  it('probes pg_extension once per process and caches the answer', async () => {
    const { db } = fakeDb({ extversion: '0.8.0' })
    expect(await pgvectorSupportsIterativeScan(db)).toBe(true)
    expect(await pgvectorSupportsIterativeScan(db)).toBe(true)
    expect((db as unknown as { execute: ReturnType<typeof vi.fn> }).execute).toHaveBeenCalledTimes(1)
  })
  it('parses versions numerically (0.10.0 > 0.8.0; 0.7.9 < 0.8.0)', async () => {
    expect(await pgvectorSupportsIterativeScan(fakeDb({ extversion: '0.10.0' }).db)).toBe(true)
    _resetHnswCapabilityForTests()
    expect(await pgvectorSupportsIterativeScan(fakeDb({ extversion: '0.7.9' }).db)).toBe(false)
  })
})
