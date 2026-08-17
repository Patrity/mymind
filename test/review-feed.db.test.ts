// test/review-feed.db.test.ts
//
// DB-backed test — see test/documents-cas.db.test.ts for the harness pattern this file
// follows (`.env` load + `useRuntimeConfig` stub so `useDb()` works outside Nuxt).
//
// Task 13 folds `/memories`' separate "unreviewed" approval path into the single `/review`
// surface: listReviewFeed()/countReviewPending() (server/services/review.ts) now merge real
// review_queue rows with synthetic `memory-unreviewed` items sourced from memories where
// reviewed_at IS NULL. This proves: both sources appear in the merged feed with the right
// discriminator; a synthetic item's id IS the memories.id (never a review_queue.id); marking
// the memory reviewed removes ONLY that synthetic item (a sibling review_queue row is
// untouched); and an archived-but-unreviewed memory never surfaces (it's not live).
//
// Code-review finding (Important): a memory-supersede/memory-contradict review_queue row's
// `proposed.newId` points at the NEW memory (memory-resolve.ts's review-supersede/
// review-contradict branches) — but that memory's own `reviewed_at` comes from a DIFFERENT
// gate (shouldAutoReview(confidence, threshold) in insertFresh). A low-confidence new memory
// (routine at cycle 24's 0.6 parse floor, below the 0.75 auto-review threshold) can have
// reviewed_at IS NULL while its conflict is already a real, separately-actionable
// review_queue row — so unreviewedLive() must exclude it, or it surfaces TWICE (once as the
// conflict card, once as a synthetic memory-unreviewed card on the same memories.id) and
// "Mark reviewed" on the synthetic card would falsely resolve an unresolved conflict.
process.loadEnvFile('.env')
import { describe, it, expect, vi } from 'vitest'
import { sql, eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

const { useDb } = await import('../server/db')
const { reviewQueue, memories } = await import('../server/db/schema')
const { listReviewFeed, countReviewPending } = await import('../server/services/review')
const { reviewMemory } = await import('../server/services/memory')

const MARK = 'review-feed.probe'

/** Insert a minimal pending review_queue row (docId has no FK — any uuid is fine here). */
async function insertQueueRow() {
  const db = useDb()
  const [row] = await db.insert(reviewQueue).values({
    docId: sql`gen_random_uuid()` as unknown as string,
    kind: 'enrichment',
    proposed: { title: MARK, reasoning: 'probe' },
    status: 'pending'
  }).returning()
  return row!
}

/** Insert a minimal unreviewed, live memory row with a unique content hash. */
async function insertUnreviewedMemory(content: string) {
  const db = useDb()
  const [row] = await db.execute<{ id: string, content: string, created_at: Date }>(sql`
    insert into memories (content, content_hash, tags, reviewed_at, scope, confidence)
    values (${content}, encode(sha256(convert_to(${content}, 'UTF8')), 'hex'), '{}', null, 'user', 0.5)
    returning id, content, created_at
  `).then(r => r.rows)
  return row!
}

/**
 * Insert a pending memory-supersede/memory-contradict row shaped like
 * memory-resolve.ts's `proposed` (newId/existingId/confidence/reasoning/*Content) —
 * mirrors the real writer at server/services/memory-resolve.ts:168-184.
 */
async function insertConflictQueueRow(kind: 'memory-supersede' | 'memory-contradict', newId: string) {
  const db = useDb()
  const [row] = await db.insert(reviewQueue).values({
    docId: sql`gen_random_uuid()` as unknown as string,
    kind,
    proposed: { newId, existingId: randomUUID(), confidence: 0.9, reasoning: 'probe', newContent: 'new', existingContent: 'existing' },
    status: 'pending'
  }).returning()
  return row!
}

describe('listReviewFeed / countReviewPending (the single /review surface)', () => {
  it('merges a real review_queue row with a synthetic memory-unreviewed item', async () => {
    const db = useDb()
    const queueRow = await insertQueueRow()
    const memRow = await insertUnreviewedMemory(`${MARK} merges ${Date.now()}`)

    try {
      const feed = await listReviewFeed()

      const queueItem = feed.find(i => i.id === queueRow.id)
      expect(queueItem).toBeDefined()
      expect(queueItem!.kind).toBe('enrichment')

      const memItem = feed.find(i => i.id === memRow.id)
      expect(memItem).toBeDefined()
      expect(memItem!.kind).toBe('memory-unreviewed')
      // The synthetic item's id IS the memories.id — never a review_queue.id — and it must
      // carry enough of the memory to render without a second fetch.
      expect(memItem!.docId).toBeNull()
      expect((memItem as { proposed: { content: string } }).proposed.content).toBe(memRow.content)
    } finally {
      await db.delete(reviewQueue).where(eq(reviewQueue.id, queueRow.id))
      await db.delete(memories).where(eq(memories.id, memRow.id))
    }
  })

  it('counts both sources in `pending`', async () => {
    const db = useDb()
    const before = await countReviewPending()

    const queueRow = await insertQueueRow()
    const memRow = await insertUnreviewedMemory(`${MARK} counts ${Date.now()}`)

    try {
      expect(await countReviewPending()).toBe(before + 2)
    } finally {
      await db.delete(reviewQueue).where(eq(reviewQueue.id, queueRow.id))
      await db.delete(memories).where(eq(memories.id, memRow.id))
    }
  })

  it('reviewMemory(id) removes only the synthetic item, not a sibling review_queue row', async () => {
    const db = useDb()
    const queueRow = await insertQueueRow()
    const memRow = await insertUnreviewedMemory(`${MARK} review ${Date.now()}`)

    try {
      const before = await countReviewPending()

      const result = await reviewMemory(memRow.id)
      expect(result).not.toBeNull()

      const feed = await listReviewFeed()
      expect(feed.find(i => i.id === memRow.id)).toBeUndefined()
      expect(feed.find(i => i.id === queueRow.id)).toBeDefined()
      expect(await countReviewPending()).toBe(before - 1)
    } finally {
      await db.delete(reviewQueue).where(eq(reviewQueue.id, queueRow.id))
      await db.delete(memories).where(eq(memories.id, memRow.id))
    }
  })

  it('never surfaces an archived-but-unreviewed memory (not live)', async () => {
    const db = useDb()
    const memRow = await insertUnreviewedMemory(`${MARK} archived ${Date.now()}`)
    await db.update(memories).set({ archivedAt: new Date() }).where(eq(memories.id, memRow.id))

    try {
      const feed = await listReviewFeed()
      expect(feed.find(i => i.id === memRow.id)).toBeUndefined()
    } finally {
      await db.delete(memories).where(eq(memories.id, memRow.id))
    }
  })

  // Code-review finding (Important, addressed post-initial-review): a new memory whose own
  // confidence fell below the auto-review threshold has reviewed_at IS NULL EVEN THOUGH it
  // already has a pending memory-supersede/memory-contradict decision pointed at it via
  // proposed.newId — it must not also surface as a synthetic memory-unreviewed item.
  it.each(['memory-supersede', 'memory-contradict'] as const)(
    'does not double-list or double-count a memory with a pending %s decision (its own reviewed_at is null)',
    async (kind) => {
      const db = useDb()
      const before = await countReviewPending()

      const memRow = await insertUnreviewedMemory(`${MARK} ${kind} ${Date.now()}`)
      const conflictRow = await insertConflictQueueRow(kind, memRow.id)

      try {
        const feed = await listReviewFeed()

        // Exactly ONE item carries this memory's identity in the feed — the real conflict
        // card (id === conflictRow.id) — never a second synthetic memory-unreviewed card
        // keyed on memRow.id.
        const itemsForThisMemory = feed.filter(i => i.id === memRow.id || i.id === conflictRow.id)
        expect(itemsForThisMemory).toHaveLength(1)
        expect(itemsForThisMemory[0]!.id).toBe(conflictRow.id)
        expect(itemsForThisMemory[0]!.kind).toBe(kind)

        // The synthetic memory-unreviewed item must not exist at all for this memory.
        expect(feed.find(i => i.id === memRow.id && i.kind === 'memory-unreviewed')).toBeUndefined()

        // Counted once (the conflict row), not twice.
        expect(await countReviewPending()).toBe(before + 1)
      } finally {
        await db.delete(reviewQueue).where(eq(reviewQueue.id, conflictRow.id))
        await db.delete(memories).where(eq(memories.id, memRow.id))
      }
    }
  )
})
