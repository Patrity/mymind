// test/review-queue-targets.db.test.ts
//
// DB-backed test — see test/enrich-conversations.db.test.ts for the harness pattern this file
// follows (`.env` load + `useRuntimeConfig` stub so `useDb()` works outside Nuxt).
//
// Task 7: review_queue.doc_id was ALREADY polymorphic, dishonestly — memory-resolve.ts's
// memory-supersede/memory-contradict writers stored a memories.id in a column named and
// documented as a document reference (verified against prod on 2026-09-23: 41 + 20 rows).
// (target_kind, target_id) replaces it as an honest discriminated reference; doc_id goes
// nullable and stops being written (the DROP is deferred — prod is live). This file guards
// both the new column pair AND the kind-dependent backfill (migration 0050) that had to sort
// 61 existing mislabelled rows onto the right side of the id namespace.
process.loadEnvFile('.env')
import { describe, it, expect, afterAll, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { useDb } from '../server/db'
import { reviewQueue } from '../server/db/schema'
import { enqueueReview } from '../server/services/review'
import { and, eq, inArray } from 'drizzle-orm'

const seededTargetIds: string[] = []

function track(targetId: string) {
  seededTargetIds.push(targetId)
  return targetId
}

afterAll(async () => {
  if (seededTargetIds.length > 0) {
    await useDb().delete(reviewQueue).where(inArray(reviewQueue.targetId, seededTargetIds))
  }
})

describe('polymorphic review queue', () => {
  it('accepts a memory target', async () => {
    const targetId = track(crypto.randomUUID())
    await enqueueReview({ targetKind: 'memory', targetId, kind: 'applicability', proposed: { applicability: 'global' } })
    const [row] = await useDb().select().from(reviewQueue)
      .where(and(eq(reviewQueue.targetKind, 'memory'), eq(reviewQueue.targetId, targetId))).limit(1)
    expect(row).toBeTruthy()
    expect(row!.status).toBe('pending')
  })

  it('accepts a document target', async () => {
    const targetId = track(crypto.randomUUID())
    await enqueueReview({ targetKind: 'document', targetId, kind: 'enrichment', proposed: { tags: ['x'] } })
    const [row] = await useDb().select().from(reviewQueue)
      .where(and(eq(reviewQueue.targetKind, 'document'), eq(reviewQueue.targetId, targetId))).limit(1)
    expect(row).toBeTruthy()
  })

  it('allows one pending item per (kind, id) but not two', async () => {
    const targetId = track(crypto.randomUUID())
    await enqueueReview({ targetKind: 'memory', targetId, kind: 'stale', proposed: { a: 1 } })
    await enqueueReview({ targetKind: 'memory', targetId, kind: 'stale', proposed: { a: 2 } })
    const rows = await useDb().select().from(reviewQueue)
      .where(and(eq(reviewQueue.targetKind, 'memory'), eq(reviewQueue.targetId, targetId), eq(reviewQueue.status, 'pending')))
    expect(rows).toHaveLength(1)
  })

  it('does not collide a memory and a document that share an id', async () => {
    const shared = track(crypto.randomUUID())
    await enqueueReview({ targetKind: 'memory', targetId: shared, kind: 'stale', proposed: {} })
    await enqueueReview({ targetKind: 'document', targetId: shared, kind: 'enrichment', proposed: {} })
    const rows = await useDb().select().from(reviewQueue).where(eq(reviewQueue.targetId, shared))
    expect(rows).toHaveLength(2)
  })

  it('backfilled every pre-existing memory conflict row as a memory, not a document', async () => {
    // Guards the kind-dependent backfill. doc_id has always held a memories.id for these two
    // kinds; a blanket target_kind='document' would flatten two id namespaces into one label.
    // Read-only against whatever this dev DB already holds — no fixture, nothing to clean up.
    const rows = await useDb().select({ kind: reviewQueue.kind, targetKind: reviewQueue.targetKind })
      .from(reviewQueue)
      .where(inArray(reviewQueue.kind, ['memory-supersede', 'memory-contradict']))
    for (const r of rows) expect(r.targetKind).toBe('memory')
  })

  it('memory-resolve writes memory conflicts as targetKind memory', async () => {
    // The column default is 'document'; a writer that still passes docId would land there
    // silently. Assert the writer, not just the schema.
    const src = await import('node:fs').then(fs =>
      fs.readFileSync(new URL('../server/services/memory-resolve.ts', import.meta.url), 'utf8'))
    expect(src).not.toMatch(/insert\(reviewQueue\)\.values\(\{\s*docId:/)
    expect(src).toMatch(/targetKind:\s*'memory'/)
  })
})
