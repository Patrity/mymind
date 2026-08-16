import { eq, and, isNull, count } from 'drizzle-orm'
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

/** Shared "still needs a human" filter for unreviewed memories: live + not yet reviewed. */
const unreviewedLive = () => and(isNull(memories.archivedAt), isNull(memories.reviewedAt))

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
