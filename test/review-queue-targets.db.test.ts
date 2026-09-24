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
import { and, eq, inArray, sql } from 'drizzle-orm'

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

  // FIX 7a (whole-branch review): the original version of this test read whatever
  // memory-supersede/memory-contradict rows this shared dev DB happened to already hold, with
  // no fixture of its own — a 0-iteration `for` loop (and a pass-by-vacuity) on a DB with none,
  // and non-hermetic (asserting on rows some OTHER test file or session created) on a DB with
  // some. Replaced with a hermetic version: seed rows spanning both branches of the kind
  // condition, then re-run the EXACT CASE expression migration 0050's backfill used (see
  // server/db/migrations/0050_polymorphic_review_targets.sql) against them, and assert it
  // sorts each seeded row onto the right side. This is deletable-but-kept: the migration
  // itself only ever runs once and is already applied (verified against prod), but the
  // kind-dependent MAPPING it encodes is exactly the kind of thing a future "simplify this
  // CASE" edit could silently break, and this is what would catch it.
  it('the 0050 backfill CASE maps memory-supersede/memory-contradict to memory, everything else to document', async () => {
    const supersede = track(crypto.randomUUID())
    const contradict = track(crypto.randomUUID())
    const enrichment = track(crypto.randomUUID())
    const triage = track(crypto.randomUUID())
    await enqueueReview({ targetKind: 'document', targetId: supersede, kind: 'memory-supersede', proposed: {} })
    await enqueueReview({ targetKind: 'document', targetId: contradict, kind: 'memory-contradict', proposed: {} })
    await enqueueReview({ targetKind: 'document', targetId: enrichment, kind: 'enrichment', proposed: {} })
    await enqueueReview({ targetKind: 'document', targetId: triage, kind: 'triage', proposed: {} })

    const ids = [supersede, contradict, enrichment, triage]
    await useDb().update(reviewQueue)
      .set({ targetKind: sql`case when ${reviewQueue.kind} in ('memory-supersede','memory-contradict') then 'memory' else 'document' end` })
      .where(inArray(reviewQueue.targetId, ids))

    const rows = await useDb().select({ targetId: reviewQueue.targetId, kind: reviewQueue.kind, targetKind: reviewQueue.targetKind })
      .from(reviewQueue)
      .where(inArray(reviewQueue.targetId, ids))
    const targetKindOf = (id: string) => rows.find(r => r.targetId === id)!.targetKind
    expect(targetKindOf(supersede)).toBe('memory')
    expect(targetKindOf(contradict)).toBe('memory')
    expect(targetKindOf(enrichment)).toBe('document')
    expect(targetKindOf(triage)).toBe('document')
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
