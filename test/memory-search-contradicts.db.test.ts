// test/memory-search-contradicts.db.test.ts
//
// DB-backed test — see test/memory-concerns.db.test.ts for the harness pattern this file
// follows (`.env` load + `useRuntimeConfig` stub so `useDb()` works outside Nuxt).
//
// This proves the FIX (server/services/memory.ts searchMemories) end-to-end: before it,
// searchMemories hydrated MemoryDTO with toDTO(r) and no relations argument, so
// MemoryDTO.relations was always undefined on every search result, contradictedIds in
// assemble.ts was always empty, and WEIGHTS.contradicted (salience.ts) never fired for
// anything retrieved via search. This test does NOT hand-build a contradictedIds set —
// it derives it from the `.relations` a real searchMemories() call returns, exactly the
// way server/lib/agent/assemble.ts does, then feeds that into the real rankForContext.
process.loadEnvFile('.env')
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

// A fixed, distinctive phrase — the trigram lane's ILIKE filter requires the query text to
// appear verbatim in a candidate's content, so this both seeds our rows and IS the query.
const Q = 'RANKTEST distinctive anchor phrase zzqq'
const PLAIN_CONTENT = `${Q} extra padding one two three four five six`
const CONTRADICTED_CONTENT = `${Q} extra padding one two three four five six seven eight nine ten eleven twelve thirteen fourteen`

// createMemory -> embedOne -> withFailover reaches the Nitro-global $fetch, which only exists
// inside the Nuxt/Nitro runtime (see test/memory-applicability.db.test.ts for the same note).
// This suite (unlike most other .db.test.ts files) does NOT stub every call to the SAME fixed
// vector: this file's own dev-DB run showed why — every other suite's embeddings share that
// one constant, so this test's rows (identical embedding = cosine distance 0 = tied with
// potentially hundreds of other rows) got interleaved with real, unrelated memories in the
// vector lane, and an ordering that held in isolation flipped once run after the rest of the
// suite. Instead, each of this test's three contents gets its own DETERMINISTIC, distinctly
// non-uniform vector (a sine-based pattern, not a repeated constant — a repeated constant is
// scalar-parallel to every other suite's repeated-constant vector, i.e. cosine 1.0 / distance
// 0 with all of them, which is the exact tie this is avoiding). `anchor`'s vector is set to be
// EXACTLY the query's embedding (distance 0, the closest anything can be); `plain`'s and
// `contradicted`'s are small, ordered perturbations of it — close enough that no real,
// unrelated embedding in the store can plausibly land closer, so the vector lane's ranking of
// these three is as deterministic as the trigram lane's, and the two reinforce rather than
// fight each other.
const DIM = 2560
function baseVector(): number[] {
  return Array.from({ length: DIM }, (_, i) => Math.sin(i * 0.7))
}
function perturbed(n: number): number[] {
  const v = baseVector()
  for (let i = 0; i < n; i++) v[i] = v[i]! * 0.9
  return v
}
const VECTORS: Record<string, number[]> = {
  [Q]: baseVector(),
  [PLAIN_CONTENT]: perturbed(50),
  [CONTRADICTED_CONTENT]: perturbed(400)
}
vi.stubGlobal('$fetch', vi.fn(async (_url: string, opts?: { body?: { inputs?: string[] } }) => {
  const text = opts?.body?.inputs?.[0] ?? ''
  return [VECTORS[text] ?? baseVector()]
}))

import { useDb } from '../server/db'
import { memories, memoryRelations } from '../server/db/schema'
import { createMemory, searchMemories } from '../server/services/memory'
import { rankForContext } from '../server/lib/agent/salience'
import { inArray, or, sql } from 'drizzle-orm'

async function purgeRankTestRows() {
  const db = useDb()
  const rows = await db.select({ id: memories.id }).from(memories).where(sql`content like 'RANKTEST%'`)
  const ids = rows.map(r => r.id)
  if (!ids.length) return
  await db.delete(memoryRelations).where(or(inArray(memoryRelations.fromId, ids), inArray(memoryRelations.toId, ids)))
  await db.delete(memories).where(inArray(memories.id, ids))
}

describe('searchMemories hydrates relations, and the contradiction boost reaches ranking', () => {
  beforeEach(purgeRankTestRows)
  afterAll(purgeRankTestRows)

  it('ranks a contradicted memory above an otherwise-more-relevant plain one', async () => {
    // Each test memory gets its OWN project slug. All three share the same stubbed
    // embedding (cosine similarity 1.0), and createMemory's dedup only checks CANDIDATES
    // within the same (scope, project) — same project here would collapse them into one
    // row via the semantic-merge path (see server/services/memory-dedup.ts), which would
    // silently defeat this test. Distinct projects keep them three separate rows while
    // `searchMemories` below (no project filter) still returns all three together.
    //
    // `anchor` exists ONLY to give `plain` and `contradicted` a non-zero, non-adjacent rank
    // gap from search — with just two candidates, fused rank positions 0/1 produce relevance
    // 1.0 vs 0.5, a gap that exactly equals WEIGHTS.contradicted (0.5) and ties instead of
    // flipping. `anchor` occupies rank 0 (its content IS the query, so the trigram lane
    // ranks it best), pushing `plain`/`contradicted` to ranks 1/2 — a 0.167 gap, comfortably
    // smaller than the 0.5 boost.
    //
    // `contradicted` carries an ACTIVE contradicts edge to `anchor` (not to `plain`) —
    // assemble.ts's contradictedIds construction marks EITHER side of an edge as
    // "contradicted" (it iterates each memory's own relations regardless of direction), so
    // an edge directly between `plain` and `contradicted` would mark both, erasing the
    // comparison this test needs.
    const anchor = await createMemory({ scope: 'agent', content: Q, project: 'ranktest-anchor' })
    const plain = await createMemory({ scope: 'agent', content: PLAIN_CONTENT, project: 'ranktest-plain' })
    const contradicted = await createMemory({ scope: 'agent', content: CONTRADICTED_CONTENT, project: 'ranktest-contradicted' })
    await useDb().insert(memoryRelations)
      .values({ fromId: contradicted.id, toId: anchor.id, type: 'contradicts', confidence: 0.9, status: 'active' })

    const results = await searchMemories(Q, { scope: 'agent', limit: 20 })

    const plainDto = results.find(r => r.id === plain.id)
    const contradictedDto = results.find(r => r.id === contradicted.id)
    expect(plainDto, 'plain memory must come back from search').toBeTruthy()
    expect(contradictedDto, 'contradicted memory must come back from search').toBeTruthy()

    // The actual defect: relations must be hydrated on the search result, not undefined.
    expect(contradictedDto!.relations?.some(r => r.type === 'contradicts' && r.status === 'active')).toBe(true)
    expect(plainDto!.relations ?? []).not.toContainEqual(expect.objectContaining({ type: 'contradicts' }))

    // Sanity: pre-boost, `plain` is the more relevant of the two (fewer padding words, better
    // trigram match, earlier fused rank) — so a post-boost win by `contradicted` is genuinely
    // the weight firing, not a coincidence of search order.
    expect(plainDto!.relevance ?? 0).toBeGreaterThan(contradictedDto!.relevance ?? 0)

    // Derive contradictedIds the SAME way assemble.ts does — from the real DTOs' own
    // `.relations`, not a hand-built set.
    const contradictedIds = new Set(
      results.flatMap(m => (m.relations ?? []).filter(r => r.type === 'contradicts' && r.status === 'active').map(() => m.id))
    )
    expect(contradictedIds.has(contradicted.id)).toBe(true)

    const ranked = rankForContext(results, { now: new Date(), contradictedIds })
    const plainRank = ranked.findIndex(m => m.id === plain.id)
    const contradictedRank = ranked.findIndex(m => m.id === contradicted.id)
    expect(contradictedRank).toBeGreaterThanOrEqual(0)
    expect(plainRank).toBeGreaterThanOrEqual(0)
    expect(contradictedRank).toBeLessThan(plainRank)
  })
})
