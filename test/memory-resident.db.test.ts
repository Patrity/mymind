// test/memory-resident.db.test.ts
//
// DB-backed test — see test/documents-cas.db.test.ts for the harness pattern this file
// follows (`.env` load + `useRuntimeConfig` stub so `useDb()` works outside Nuxt).
process.loadEnvFile('.env')

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))
// createMemory -> embedOne -> withFailover reaches the Nitro-global $fetch, which only
// exists inside the Nuxt/Nitro runtime (see test/triage-actuators.db.test.ts for the same
// note). Stub it to a fixed vector so this suite never depends on a homelab embeddings rig.
vi.stubGlobal('$fetch', vi.fn().mockResolvedValue([Array(2560).fill(0.01)]))

import { createHash } from 'node:crypto'
import { useDb } from '../server/db'
import { memories } from '../server/db/schema'
import { createMemory, listResidentMemories, recordRetrievals } from '../server/services/memory'
import { sql, inArray } from 'drizzle-orm'

const mk = (content: string, project = 'alpha') =>
  createMemory({ scope: 'user', content, project })

/**
 * Direct insert, bypassing createMemory's dedup entirely.
 *
 * This whole db-test harness stubs $fetch to a CONSTANT embedding vector (see below), so
 * createMemory can never produce two distinct rows in one (scope, project) partition — any
 * second call sees cosine similarity 1.0 against the first and dedupDecision merges it. Any
 * test that needs a row DISTINCT from another must not go through createMemory for it.
 */
const insertDistinct = async (content: string) => {
  const [row] = await useDb().insert(memories).values({
    scope: 'user',
    content,
    contentHash: createHash('sha256').update(content).digest('hex')
  }).returning()
  return row!
}

describe('resident tier', () => {
  beforeEach(async () => {
    await useDb().execute(sql`delete from memories where content like 'RES-TEST%'`)
  })

  // beforeEach alone only cleans before each of THIS file's own tests — it doesn't stop this
  // file's rows leaking into the next file in the shared dev Postgres (no per-file isolation).
  afterAll(async () => {
    await useDb().execute(sql`delete from memories where content like 'RES-TEST%'`)
  })

  it('defaults to non-resident', async () => {
    // This test IS about createMemory, so keep it — but give it a project no other test in
    // this suite touches, so it lands in an empty dedup partition and cannot merge with
    // anything left over from another test or another file.
    const m = await mk('RES-TEST plain', 'res-test-defaults')
    expect(m.resident).toBe(false)
  })

  it('listResidentMemories returns only resident rows', async () => {
    const a = await insertDistinct('RES-TEST pinned')
    await insertDistinct('RES-TEST unpinned')
    await useDb().update(memories)
      .set({ resident: true, applicability: 'global', reviewedAt: new Date() })
      .where(sql`${memories.id} = ${a.id}`)
    const res = await listResidentMemories()
    const contents = res.map(m => m.content)
    expect(contents).toContain('RES-TEST pinned')
    expect(contents).not.toContain('RES-TEST unpinned')
  })

  it('refuses a resident memory that is not global', async () => {
    const m = await insertDistinct('RES-TEST bad')
    await expect(
      useDb().update(memories).set({ resident: true }).where(sql`${memories.id} = ${m.id}`)
    ).rejects.toThrow()
  })

  it('recordRetrievals increments every id in ONE statement', async () => {
    const a = await insertDistinct('RES-TEST count-a')
    const b = await insertDistinct('RES-TEST count-b')
    await recordRetrievals([a.id, b.id])
    await recordRetrievals([a.id])
    const rows = await useDb().select().from(memories).where(inArray(memories.id, [a.id, b.id]))
    const byId = new Map(rows.map(r => [r.id, r]))
    expect(byId.get(a.id)!.retrievalCount).toBe(2)
    expect(byId.get(b.id)!.retrievalCount).toBe(1)
    expect(byId.get(a.id)!.lastRetrievedAt).not.toBeNull()
  })

  it('recordRetrievals([]) is a no-op and does not throw', async () => {
    await expect(recordRetrievals([])).resolves.toBeUndefined()
  })

  // Added during Step 8's deliberate-failure check: dropping `isNotNull(memories.reviewedAt)`
  // from listResidentMemories did NOT make any existing test in this file fail — an unreviewed
  // resident memory reaching every prompt is exactly the failure that guard exists to prevent,
  // so per the brief's Step 8 instruction ("if none does, add one"), this test closes that gap.
  // Distinct `project` per memory sidesteps this file's other known issue (createMemory's
  // near-dup dedup merges any two memories sharing (scope, project) once embedOne is stubbed to
  // a fixed vector — see task-2-report.md) so this test's own two rows never collide.
  it('excludes a resident memory that has not been reviewed', async () => {
    const reviewed = await mk('RES-TEST guard-reviewed', 'guard-reviewed-proj')
    const unreviewed = await mk('RES-TEST guard-unreviewed', 'guard-unreviewed-proj')
    await useDb().update(memories)
      .set({ resident: true, applicability: 'global', reviewedAt: new Date() })
      .where(sql`${memories.id} = ${reviewed.id}`)
    await useDb().update(memories)
      .set({ resident: true, applicability: 'global' })
      .where(sql`${memories.id} = ${unreviewed.id}`)
    const res = await listResidentMemories()
    const contents = res.map(m => m.content)
    expect(contents).toContain('RES-TEST guard-reviewed')
    expect(contents).not.toContain('RES-TEST guard-unreviewed')
  })
})
