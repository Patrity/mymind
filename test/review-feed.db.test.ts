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
process.loadEnvFile('.env')
import { describe, it, expect, vi } from 'vitest'
import { sql, eq } from 'drizzle-orm'

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
})
