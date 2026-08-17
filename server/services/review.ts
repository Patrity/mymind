import { eq, and, isNull, count, sql } from 'drizzle-orm'
import { useDb } from '../db'
import { reviewQueue, documents, memories } from '../db/schema'
import type { MemoryScope } from '../../shared/types/memory'

// ---------------------------------------------------------------------------
// `/review` is the single approval surface (task-13). It merges two sources:
//
//  1. Real `review_queue` rows (kind: enrichment | memory-supersede |
//     memory-contradict | triage) — id IS a review_queue.id.
//  2. Synthetic `memory-unreviewed` items sourced from `memories` where
//     `reviewed_at IS NULL` — these are NOT review_queue rows. Their id is a
//     memories.id. Approving one must go through reviewMemory(id)
//     (server/services/memory.ts), never review_queue's approve/reject
//     handlers (server/api/review/kinds.ts), which look up by review_queue.id
//     and would 404 (or, in a pathological UUID collision, corrupt an
//     unrelated row) if handed a memories.id.
//
// `kind` is the discriminator callers (server + UI) must check first.
// ---------------------------------------------------------------------------

export interface ReviewQueueFeedItem {
  id: string
  docId: string
  kind: string
  proposed: unknown
  createdAt: Date
  docPath: string | null
}

export interface MemoryUnreviewedProposed {
  content: string
  scope: MemoryScope
  tags: string[]
  project: string | null
  confidence: number | null
}

export interface MemoryUnreviewedFeedItem {
  id: string
  docId: null
  kind: 'memory-unreviewed'
  proposed: MemoryUnreviewedProposed
  createdAt: Date
  docPath: null
}

export type ReviewFeedItem = ReviewQueueFeedItem | MemoryUnreviewedFeedItem

/**
 * Shared "still needs a human" filter for unreviewed memories: live, not yet reviewed, AND
 * not already the subject of a PENDING memory-supersede/memory-contradict decision.
 *
 * A conflict row's `proposed.newId` (server/services/memory-resolve.ts's `review-supersede`/
 * `review-contradict` branches) points at the newly-inserted memory — that memory's OWN
 * `reviewed_at` comes from a DIFFERENT gate (`shouldAutoReview(confidence, threshold)` in
 * `insertFresh`), so a low-confidence new memory (routine at cycle 24's 0.6 parse floor,
 * below the 0.75 auto-review threshold) can have `reviewed_at IS NULL` even though its
 * conflict is already a real, separately-actionable review_queue row. Without this
 * exclusion the same memory surfaces TWICE in /review — once as the conflict card, once as
 * a synthetic memory-unreviewed card keyed on the same memories.id — double-counting the
 * badge, and "Mark reviewed" on the synthetic card would stamp reviewed_at while the
 * sibling conflict decision sits unresolved in the same feed. Both listReviewFeed and
 * countReviewPending call this one function, so the exclusion covers both.
 */
const unreviewedLive = () => and(
  isNull(memories.archivedAt),
  isNull(memories.reviewedAt),
  sql`not exists (
    select 1 from ${reviewQueue} rq
    where rq.status = 'pending'
      and rq.kind in ('memory-supersede', 'memory-contradict')
      and rq.proposed->>'newId' = ${memories.id}::text
  )`
)

/** The merged, newest-first feed backing `GET /api/review`. */
export async function listReviewFeed(): Promise<ReviewFeedItem[]> {
  const db = useDb()

  const queueItems = await db.select({
    id: reviewQueue.id,
    docId: reviewQueue.docId,
    kind: reviewQueue.kind,
    proposed: reviewQueue.proposed,
    createdAt: reviewQueue.createdAt,
    docPath: documents.path
  }).from(reviewQueue)
    .leftJoin(documents, eq(documents.id, reviewQueue.docId))
    .where(eq(reviewQueue.status, 'pending'))

  const unreviewedMemories = await db.select({
    id: memories.id,
    content: memories.content,
    scope: memories.scope,
    tags: memories.tags,
    project: memories.project,
    confidence: memories.confidence,
    createdAt: memories.createdAt
  }).from(memories)
    .where(unreviewedLive())

  const memoryItems: MemoryUnreviewedFeedItem[] = unreviewedMemories.map(m => ({
    id: m.id,
    docId: null,
    kind: 'memory-unreviewed',
    proposed: {
      content: m.content,
      scope: m.scope as MemoryScope,
      tags: m.tags,
      project: m.project,
      confidence: m.confidence
    },
    createdAt: m.createdAt,
    docPath: null
  }))

  return [...queueItems, ...memoryItems].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
}

/** The count backing `GET /api/review/count` (the sidebar Review badge). */
export async function countReviewPending(): Promise<number> {
  const db = useDb()

  const [queueResult] = await db.select({ n: count() })
    .from(reviewQueue)
    .where(eq(reviewQueue.status, 'pending'))

  const [memoryResult] = await db.select({ n: count() })
    .from(memories)
    .where(unreviewedLive())

  return (queueResult?.n ?? 0) + (memoryResult?.n ?? 0)
}
