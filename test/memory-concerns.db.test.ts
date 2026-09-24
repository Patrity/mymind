// test/memory-concerns.db.test.ts
//
// DB-backed test — see test/conversation-epoch.db.test.ts for the harness pattern this file
// follows (`.env` load + `useRuntimeConfig` stub so `useDb()` works outside Nuxt).
process.loadEnvFile('.env')
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))
// createMemory -> embedOne -> withFailover reaches the Nitro-global $fetch, which only
// exists inside the Nuxt/Nitro runtime (see test/memory-applicability.db.test.ts for the
// same note). Stub it to a fixed vector so this suite never depends on a homelab embeddings rig.
vi.stubGlobal('$fetch', vi.fn().mockResolvedValue([Array(2560).fill(0.01)]))

import { useDb } from '../server/db'
import { memories, memoryRelations, reviewQueue } from '../server/db/schema'
import { createMemory } from '../server/services/memory'
import { sweepMemoryConcerns } from '../server/services/memory-concerns'
import { and, eq, inArray, or, sql } from 'drizzle-orm'

const pending = async (targetId: string, kind: string) => {
  const rows = await useDb().select().from(reviewQueue)
    .where(and(eq(reviewQueue.targetId, targetId), eq(reviewQueue.kind, kind), eq(reviewQueue.status, 'pending')))
  return rows.length
}

// `sweepMemoryConcerns` is by nature an unscoped sweep over the whole memory store, exactly
// like `enrichConversations` was before it — see that file's own note. Every call below passes
// `only: [...]` (or `only: []` to touch nothing), the sweep's test-only scoping seam, so it can
// never reach Tony's real memories/relations in this shared dev Postgres.
//
// Cleanup: this suite creates memories, memory_relations edges and review_queue rows keyed off
// them. `purgeConcernTestRows` removes all three by resolving every `content LIKE
// 'CONCERN-TEST%'` memory id first — run in `beforeEach` (in case a previous run crashed
// mid-suite and left rows behind) AND in `afterAll` (real cleanup for this run), per the task's
// DB test hygiene requirement.
async function purgeConcernTestRows() {
  const db = useDb()
  const rows = await db.select({ id: memories.id }).from(memories)
    .where(sql`content like 'CONCERN-TEST%'`)
  const ids = rows.map(r => r.id)
  if (ids.length === 0) return
  await db.delete(reviewQueue).where(inArray(reviewQueue.targetId, ids))
  await db.delete(memoryRelations).where(or(inArray(memoryRelations.fromId, ids), inArray(memoryRelations.toId, ids)))
  await db.delete(memories).where(inArray(memories.id, ids))
}

describe('sweepMemoryConcerns', () => {
  beforeEach(purgeConcernTestRows)
  afterAll(purgeConcernTestRows)

  it('files an active contradiction for review', async () => {
    const a = await createMemory({ scope: 'agent', content: 'CONCERN-TEST new fact', project: 'p' })
    const b = await createMemory({ scope: 'agent', content: 'CONCERN-TEST old fact', project: 'p' })
    await useDb().insert(memoryRelations)
      .values({ fromId: a.id, toId: b.id, type: 'contradicts', confidence: 0.9, status: 'active' })
    const res = await sweepMemoryConcerns({ only: [a.id, b.id] })
    expect(res.contradictions).toBeGreaterThan(0)
    expect(await pending(a.id, 'contradiction')).toBe(1)
  })

  it('ignores a RESOLVED contradiction', async () => {
    const a = await createMemory({ scope: 'agent', content: 'CONCERN-TEST resolved-a', project: 'p' })
    const b = await createMemory({ scope: 'agent', content: 'CONCERN-TEST resolved-b', project: 'p' })
    await useDb().insert(memoryRelations)
      .values({ fromId: a.id, toId: b.id, type: 'contradicts', confidence: 0.9, status: 'resolved' })
    await sweepMemoryConcerns({ only: [a.id, b.id] })
    expect(await pending(a.id, 'contradiction')).toBe(0)
  })

  it('nominates a memory retrieved often across projects for the resident tier', async () => {
    const m = await createMemory({ scope: 'user', content: 'CONCERN-TEST travels a lot', project: 'p' })
    // reviewedAt matters: sweepMemoryConcerns only nominates reviewed memories (an unreviewed
    // memory already surfaces as its own 'memory-unreviewed' review card — see review.ts).
    await useDb().update(memories)
      .set({ applicability: 'global', retrievalCount: 25, reviewedAt: new Date() }).where(eq(memories.id, m.id))
    const res = await sweepMemoryConcerns({ residentMinRetrievals: 10, only: [m.id] })
    expect(res.residentPromotions).toBeGreaterThan(0)
    expect(await pending(m.id, 'resident-promotion')).toBe(1)
  })

  it('does not nominate a project-bound memory however often it is retrieved', async () => {
    const m = await createMemory({ scope: 'user', content: 'CONCERN-TEST local favourite', project: 'p' })
    // reviewedAt set so this test actually isolates the applicability check — without it, the
    // reviewedAt-is-not-null gate alone would exclude the memory regardless of applicability,
    // and the assertion below would pass for the wrong reason.
    await useDb().update(memories).set({ retrievalCount: 99, reviewedAt: new Date() }).where(eq(memories.id, m.id))
    await sweepMemoryConcerns({ residentMinRetrievals: 10, only: [m.id] })
    expect(await pending(m.id, 'resident-promotion')).toBe(0)
  })

  it('does not re-nominate a memory that is already resident', async () => {
    const m = await createMemory({ scope: 'user', content: 'CONCERN-TEST already pinned', project: 'p' })
    await useDb().update(memories)
      .set({ applicability: 'global', resident: true, retrievalCount: 50, reviewedAt: new Date() }).where(eq(memories.id, m.id))
    await sweepMemoryConcerns({ residentMinRetrievals: 10, only: [m.id] })
    expect(await pending(m.id, 'resident-promotion')).toBe(0)
  })

  it('files a stale candidate when durability is low', async () => {
    const m = await createMemory({ scope: 'agent', content: 'CONCERN-TEST on branch feat/x right now', project: 'p' })
    await useDb().update(memories).set({ reviewedAt: new Date() }).where(eq(memories.id, m.id))
    const res = await sweepMemoryConcerns({
      only: [m.id],
      scoreDurable: async rows => new Map(rows.map(r => [r.id, r.id === m.id ? 0.1 : 0.9]))
    })
    expect(res.staleCandidates).toBeGreaterThan(0)
    expect(await pending(m.id, 'stale')).toBe(1)
  })

  it('does not file a stale candidate for a durable memory', async () => {
    const m = await createMemory({ scope: 'agent', content: 'CONCERN-TEST durable convention', project: 'p' })
    await useDb().update(memories).set({ reviewedAt: new Date() }).where(eq(memories.id, m.id))
    await sweepMemoryConcerns({ only: [m.id], scoreDurable: async rows => new Map(rows.map(r => [r.id, 0.95])) })
    expect(await pending(m.id, 'stale')).toBe(0)
  })

  it('skips stale scoring entirely when no scorer is configured', async () => {
    const res = await sweepMemoryConcerns({ only: [] })
    expect(res.staleCandidates).toBe(0)
  })

  it('never archives or deletes anything', async () => {
    const before = await useDb().select({ n: sql<number>`count(*)` }).from(memories)
    await sweepMemoryConcerns({ only: [] })
    const after = await useDb().select({ n: sql<number>`count(*)` }).from(memories)
    expect(after[0]!.n).toBe(before[0]!.n)
  })
})
