// test/memory-dup-shortcircuit.db.test.ts
//
// DB-backed — see test/documents-cas.db.test.ts for the harness pattern.
process.loadEnvFile('.env')
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({
  databaseUrl: process.env.DATABASE_URL,
  memoryAutoReviewThreshold: 0.75,
  memoryDuplicateThreshold: 0.96
}))

// The whole point of this test is that the mechanical short-circuit fires BEFORE the LLM
// judge, so the judge is stubbed to the answer that would be WRONG ("insert a second copy").
// If the short-circuit works, this stub is never consulted.
// vi.hoisted, not a bare const: vi.mock's factory is hoisted above module-level
// declarations, so a factory closing over a plain `const judgeRelations` captures it
// before initialization and the mock receives undefined args.
const { judgeRelations } = vi.hoisted(() => ({
  judgeRelations: vi.fn(async (_c: string, near: Array<{ id: string }>) =>
    (near ?? []).map(n => ({ relation: 'unrelated', confidence: 0.9, existingId: n.id, reasoning: 'stub' })))
}))
vi.mock('../server/lib/ai/memory-judge', () => ({ judgeRelations }))

// embedOne is the real embedding call; stub $fetch so it never leaves the machine.
// A fixed vector makes every memory's embedding identical, i.e. cosine similarity 1.0 —
// which is exactly the "near-verbatim restatement" case this short-circuit exists for.
vi.stubGlobal('$fetch', vi.fn().mockResolvedValue([Array(2560).fill(0.02)]))

const { resolveEnrichedMemory } = await import('../server/services/memory-resolve')
const { useDb } = await import('../server/db')
const { memories } = await import('../server/db/schema')
const { eq, and, isNull, sql } = await import('drizzle-orm')

const uniq = () => Math.random().toString(36).slice(2, 10)
const PROJECT = null   // isNull(projectId) partition

async function liveCountLike(prefix: string) {
  const rows = await useDb().select({ id: memories.id }).from(memories)
    .where(and(isNull(memories.archivedAt), sql`${memories.content} like ${prefix + '%'}`))
  return rows.length
}
async function purge(prefix: string) {
  await useDb().delete(memories).where(sql`${memories.content} like ${prefix + '%'}`)
}

beforeEach(() => judgeRelations.mockClear())

describe('resolveEnrichedMemory — mechanical duplicate short-circuit', () => {
  it('merges a near-identical memory without ever consulting the LLM judge', async () => {
    const tag = `dupsc-${uniq()}`
    try {
      // First one has nothing to match against, so it inserts.
      const first = await resolveEnrichedMemory({
        content: `${tag} the reranker needs ef_search raised`, scope: 'agent', project: PROJECT
      })
      expect(first.action).toBe('insert')

      // Second: different text (so the exact-hash short-circuit can't fire) but an
      // identical embedding => similarity 1.0, comfortably above the 0.96 bar.
      judgeRelations.mockClear()
      const second = await resolveEnrichedMemory({
        content: `${tag} the reranker requires a higher ef_search`, scope: 'agent', project: PROJECT
      })

      expect(second.action).toBe('duplicate')
      expect(judgeRelations).not.toHaveBeenCalled()   // the LLM call was SKIPPED, not overruled
      expect(await liveCountLike(tag)).toBe(1)        // and no second row was written
    } finally {
      await purge(tag)
    }
  })

  it('still routes a below-bar neighbour to the LLM judge', async () => {
    const tag = `dupsc-${uniq()}`
    try {
      await resolveEnrichedMemory({ content: `${tag} first fact`, scope: 'agent', project: PROJECT })

      // Drop the bar's input by making this memory's embedding differ: a distinct vector
      // for THIS call only, so the nearest neighbour sits below 0.92.
      const far = Array(2560).fill(0.02); far[0] = -5
      ;(globalThis as { $fetch?: unknown }).$fetch = vi.fn().mockResolvedValue([far])

      judgeRelations.mockClear()
      const second = await resolveEnrichedMemory({ content: `${tag} unrelated fact`, scope: 'agent', project: PROJECT })

      expect(judgeRelations).toHaveBeenCalled()       // judge still owns the grey zone
      expect(second.action).toBe('insert')            // per the stub's 'unrelated' verdict
      expect(await liveCountLike(tag)).toBe(2)
    } finally {
      ;(globalThis as { $fetch?: unknown }).$fetch = vi.fn().mockResolvedValue([Array(2560).fill(0.02)])
      await purge(tag)
    }
  })

  it('leaves the exact-hash path alone (identical content still merges pre-embedding)', async () => {
    const tag = `dupsc-${uniq()}`
    const content = `${tag} byte-identical fact`
    try {
      await resolveEnrichedMemory({ content, scope: 'agent', project: PROJECT })
      judgeRelations.mockClear()
      const again = await resolveEnrichedMemory({ content, scope: 'agent', project: PROJECT })
      expect(again.action).toBe('duplicate')
      expect(judgeRelations).not.toHaveBeenCalled()
      expect(await liveCountLike(tag)).toBe(1)
    } finally {
      await purge(tag)
    }
  })
})
