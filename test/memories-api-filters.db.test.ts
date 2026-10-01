// test/memories-api-filters.db.test.ts
//
// DB-backed — cycle 77, Task 7: the /memories score filters (verdict, scored, disagree) and sorts
// (created, audit, jev, disagreement) run in SQL inside listMemories; the filters also apply to
// searchMemories (which keeps its relevance order). The dev DB is SHARED with real data: every
// row here is TAG-prefixed, every listMemories call goes through the `onlyIds` seam, and the rows
// are deleted in afterAll. Search is scoped by the unique TAG (trigram lane); the embedding and
// rerank calls are mocked so no real model is called.
process.loadEnvFile('.env')

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))
vi.mock('../server/lib/ai/embeddings', () => ({
  embedOne: async () => { throw new Error('no embeddings in tests') },
  embed: async () => { throw new Error('no embeddings in tests') }
}))
vi.mock('../server/lib/ai/registry/resolve', () => ({
  resolveChain: async () => { throw new Error('no model chain in tests') }
}))

import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { useDb } from '../server/db'
import { memories } from '../server/db/schema'
import { listMemories, searchMemories } from '../server/services/memory'
import type { AuditVerdict } from '../shared/types/memory'

const TAG = `MEM-FILTERS-TEST-${Date.now().toString(36)}`

// The mocked embedOne throws, so searchMemories takes its documented trigram-only fallback and
// warns once per call. Swallow exactly that warning (any other warn still prints) and count it,
// so the output stays clean and the fallback is asserted rather than hidden.
const realWarn = console.warn
const vectorLaneWarns: unknown[][] = []
vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].startsWith('[searchMemories] vector lane failed')) vectorLaneWarns.push(args)
  else realWarn(...args)
})

// name → (audit, verdict, jev). Gaps: A 0.7, B exactly 0.4 (float4 0.7 − 0.3), C 0.1;
// D and E carry ONE score each (Review Focus 5: never a disagreement); F carries none.
const FIXTURES: Array<{ name: string, audit: number | null, verdict: AuditVerdict | null, jev: number | null }> = [
  { name: 'A', audit: 0.9, verdict: 'keep', jev: 0.2 },
  { name: 'B', audit: 0.7, verdict: 'transient', jev: 0.3 },
  { name: 'C', audit: 0.5, verdict: 'keep', jev: 0.6 },
  { name: 'D', audit: 0.95, verdict: 'keep', jev: null },
  { name: 'E', audit: null, verdict: null, jev: 0.05 },
  { name: 'F', audit: null, verdict: null, jev: null }
]

const idOf = new Map<string, string>()
const nameOf = new Map<string, string>()
let ids: string[] = []

const names = (rows: Array<{ id: string }>) => rows.map(r => nameOf.get(r.id) ?? `?${r.id}`)
const list = (opts: Parameters<typeof listMemories>[0] = {}) => listMemories({ ...opts, onlyIds: ids }).then(names)

beforeAll(async () => {
  const base = Date.now() - 60_000
  // createdAt ascends A→F, so newest-first is F, E, D, C, B, A.
  for (const [i, f] of FIXTURES.entries()) {
    const content = `${TAG} ${f.name}`
    const [row] = await useDb().insert(memories).values({
      scope: 'user',
      content,
      contentHash: createHash('sha256').update(content).digest('hex'),
      auditKeep: f.audit,
      auditVerdict: f.verdict,
      auditPromptVersion: f.audit == null ? null : 'audit-v1',
      jevScore: f.jev,
      createdAt: new Date(base + i * 1000)
    }).returning({ id: memories.id })
    idOf.set(f.name, row!.id)
    nameOf.set(row!.id, f.name)
  }
  ids = [...idOf.values()]
})

afterAll(async () => {
  const res = await useDb().execute(sql`delete from memories where content like ${TAG + '%'}`)
  // Real row count for the report: exactly the 6 fixtures.
  console.info(`[memories-api-filters] deleted ${(res as { rowCount?: number }).rowCount ?? '?'} scoped rows`)
})

describe('listMemories score filters (SQL)', () => {
  it('no filter returns all six scoped rows, newest first', async () => {
    expect(await list()).toEqual(['F', 'E', 'D', 'C', 'B', 'A'])
  })

  it('verdict filters on the audit verdict', async () => {
    expect(await list({ verdict: 'keep' })).toEqual(['D', 'C', 'A'])
    expect(await list({ verdict: 'transient' })).toEqual(['B'])
    expect(await list({ verdict: 'belongs_in_doc' })).toEqual([])
  })

  it('scored=yes is both scores present; scored=no is either missing', async () => {
    expect(await list({ scored: 'yes' })).toEqual(['C', 'B', 'A'])
    expect(await list({ scored: 'no' })).toEqual(['F', 'E', 'D'])
  })

  it('disagree is a gap ≥ 0.4 with BOTH scores — the exact 0.4 is in, single-score rows are out (Review Focus 5)', async () => {
    expect(await list({ disagree: true })).toEqual(['B', 'A'])
  })

  it('filters combine', async () => {
    expect(await list({ disagree: true, verdict: 'keep' })).toEqual(['A'])
  })
})

describe('listMemories score sorts (SQL)', () => {
  it('created is newest first (the default)', async () => {
    expect(await list({ sort: 'created' })).toEqual(['F', 'E', 'D', 'C', 'B', 'A'])
  })

  it('audit is worst first, unaudited last (newest first among them)', async () => {
    expect(await list({ sort: 'audit' })).toEqual(['C', 'B', 'A', 'D', 'F', 'E'])
  })

  it('jev is worst first, unscored last', async () => {
    expect(await list({ sort: 'jev' })).toEqual(['E', 'A', 'B', 'C', 'F', 'D'])
  })

  it('disagreement is largest gap first; rows missing a score go last, never as 0', async () => {
    expect(await list({ sort: 'disagreement' })).toEqual(['A', 'B', 'C', 'F', 'E', 'D'])
  })

  it('a sort composes with a filter', async () => {
    expect(await list({ sort: 'jev', verdict: 'keep' })).toEqual(['A', 'C', 'D'])
  })
})

describe('searchMemories applies the score filters (relevance order kept)', () => {
  it('without filters it finds all six scoped rows', async () => {
    expect((await searchMemories(TAG, { limit: 50 }).then(names)).sort()).toEqual(['A', 'B', 'C', 'D', 'E', 'F'])
  })

  it('ran on the trigram lane only (the vector lane is stubbed off)', () => {
    expect(vectorLaneWarns.length).toBeGreaterThan(0)
  })

  it('verdict, scored and disagree narrow the hits', async () => {
    expect((await searchMemories(TAG, { verdict: 'keep', limit: 50 }).then(names)).sort()).toEqual(['A', 'C', 'D'])
    expect((await searchMemories(TAG, { scored: 'no', limit: 50 }).then(names)).sort()).toEqual(['D', 'E', 'F'])
    expect((await searchMemories(TAG, { disagree: true, limit: 50 }).then(names)).sort()).toEqual(['A', 'B'])
  })
})
