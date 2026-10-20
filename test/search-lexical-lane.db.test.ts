// Real-Postgres test for migration 0090 (the `tsv` lexical lane) and the HNSW session knobs.
// Needs a database with the migrations applied; run with `pnpm test:db` (or with DATABASE_URL
// pointed at a throwaway pgvector container, which is how it was developed — it inserts and
// deletes its own rows only, keyed by a unique marker, and never touches existing data).
import { existsSync } from 'node:fs'
import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest'
import { sql, eq } from 'drizzle-orm'

if (!process.env.DATABASE_URL && existsSync('.env')) process.loadEnvFile('.env')

process.env.DATABASE_URL ??= 'postgres://invalid'
vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

const { useDb } = await import('@mymind/core/db')
const { memories } = await import('@mymind/core/db/schema')
const { ftsMatch, ftsRank } = await import('@mymind/core/lib/search/lexical')
const { withHnswSession, _resetHnswCapabilityForTests } = await import('@mymind/core/lib/search/hnsw')

const MARK = `zz-lexlane-${Date.now().toString(36)}`
const db = useDb()

describe('migration 0090: tsv generated columns + GIN indexes', () => {
  it('every lexical surface has a stored, generated tsvector column named tsv', async () => {
    const res = await db.execute(sql`
      select table_name, data_type, is_generated, generation_expression
      from information_schema.columns
      where table_schema = 'public' and column_name = 'tsv'
      order by table_name`)
    const rows = res.rows as Array<{ table_name: string, data_type: string, is_generated: string, generation_expression: string }>
    expect(rows.map(r => r.table_name)).toEqual(['chunks', 'documents', 'memories', 'messages', 'sessions'])
    for (const r of rows) {
      expect(r.data_type).toBe('tsvector')
      expect(r.is_generated).toBe('ALWAYS')
      expect(r.generation_expression).toContain('\'english\'::regconfig')
    }
    const byTable = Object.fromEntries(rows.map(r => [r.table_name, r.generation_expression]))
    const expectSources = (table: string, ...cols: string[]) => {
      for (const c of cols) expect(byTable[table]).toMatch(new RegExp(c))
    }
    expectSources('chunks', 'heading_path', 'context', 'content')
    expectSources('documents', 'title', 'content')
    expectSources('sessions', 'title', 'summary')
    expectSources('messages', 'content')
    expectSources('memories', 'content')
  })

  it('each tsv column has a GIN index', async () => {
    const res = await db.execute(sql`
      select tablename, indexname, indexdef from pg_indexes
      where schemaname = 'public' and indexname like '%\_tsv\_gin' order by tablename`)
    const rows = res.rows as Array<{ tablename: string, indexname: string, indexdef: string }>
    expect(rows.map(r => r.indexname)).toEqual(['chunks_tsv_gin', 'documents_tsv_gin', 'memories_tsv_gin', 'messages_tsv_gin', 'sessions_tsv_gin'])
    for (const r of rows) expect(r.indexdef).toMatch(/USING gin \(tsv\)/)
  })
})

describe('the FTS lane finds what ILIKE could not', () => {
  let memId = ''
  beforeAll(async () => {
    const [m] = await db.insert(memories).values({
      content: `${MARK} The Plex transcoder deadlocked because the throttle buffer was sixty seconds.`,
      contentHash: `${MARK}-hash`, scope: 'user'
    }).returning({ id: memories.id })
    memId = m!.id
  })
  afterAll(async () => {
    await db.delete(memories).where(eq(memories.id, memId))
  })

  it('a multi-word natural-language query matches via tsv even though no substring of it occurs verbatim', async () => {
    const q = 'transcoder deadlock throttle' // not a substring; stems to transcod/deadlock/throttl
    const tsv = sql`${memories.tsv}`
    const rows = await db.select({ id: memories.id }).from(memories)
      .where(ftsMatch(tsv, q)).orderBy(ftsRank(tsv, q)).limit(50)
    expect(rows.map(r => r.id)).toContain(memId)
    const ilike = await db.select({ id: memories.id }).from(memories)
      .where(sql`${memories.content} ilike ${'%' + q + '%'}`).limit(50)
    expect(ilike.map(r => r.id)).not.toContain(memId) // the old lane would have missed it
  })

  it('ranks the row that matches more query terms first', async () => {
    const [weak] = await db.insert(memories).values({
      content: `${MARK} A transcoder was mentioned once.`, contentHash: `${MARK}-hash2`, scope: 'user'
    }).returning({ id: memories.id })
    try {
      const q = 'transcoder deadlock throttle'
      const tsv = sql`${memories.tsv}`
      const rows = await db.select({ id: memories.id }).from(memories)
        .where(sql`${memories.content} like ${MARK + '%'}`).orderBy(ftsRank(tsv, q)).limit(50)
      expect(rows.map(r => r.id)).toEqual([memId, weak!.id])
    } finally {
      await db.delete(memories).where(eq(memories.id, weak!.id))
    }
  })
})

describe('withHnswSession against a real server', () => {
  beforeAll(() => _resetHnswCapabilityForTests())
  it('the lane query sees the SET LOCAL values, and they do not leak past the transaction', async () => {
    const inside = await withHnswSession(db, { limit: 50, filtered: true, efSearchMin: 100, iterativeScan: true }, async (tx) => {
      const r = await tx.execute(sql`select current_setting('hnsw.ef_search') as ef, current_setting('hnsw.iterative_scan') as it`) as { rows: Array<{ ef: string, it: string }> }
      return r.rows[0]!
    })
    expect(inside).toEqual({ ef: '100', it: 'relaxed_order' })
    // pgvector's defaults are back on whatever client the pool hands out next
    const after = await db.execute(sql`select current_setting('hnsw.ef_search', true) as ef`) as { rows: Array<{ ef: string | null }> }
    expect(after.rows[0]!.ef === null || after.rows[0]!.ef === '40').toBe(true)
  })
})
