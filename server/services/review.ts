import { eq, and, isNull, count, sql, inArray } from 'drizzle-orm'
import { useDb } from '../db'
import { reviewQueue, documents, memories } from '../db/schema'
import { publishChange } from '../utils/live-bus'
import type { MemoryScope } from '../../shared/types/memory'
import { compareByJev } from '../lib/memory/jev-score'

export type ReviewTargetKind = 'document' | 'memory'

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
  // null for a memory-kind row (memory-supersede/memory-contradict) — targetId there is a
  // memories.id, never a document.
  docId: string | null
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
  /** Jev's independent read, same orientation as `confidence` — higher means more likely
   *  worth keeping. Null when not scored yet (unknown, not bad). */
  jevScore: number | null
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

  // `docId` on the returned shape is a display convenience for document-kind rows only
  // (the triage/enrichment cards in app/pages/review.vue fall back to it when docPath is
  // unset). It is derived from targetId, never read off the deprecated doc_id column — a
  // memory-kind row's targetId is a memories.id and must never be mislabelled as a doc.
  const queueRows = await db.select({
    id: reviewQueue.id,
    targetKind: reviewQueue.targetKind,
    targetId: reviewQueue.targetId,
    kind: reviewQueue.kind,
    proposed: reviewQueue.proposed,
    createdAt: reviewQueue.createdAt,
    docPath: documents.path
  }).from(reviewQueue)
    .leftJoin(documents, and(eq(documents.id, reviewQueue.targetId), eq(reviewQueue.targetKind, 'document')))
    .where(eq(reviewQueue.status, 'pending'))

  // A memory conflict's `proposed` carries ids and content but no PROJECT, so the reviewer
  // had no way to tell which codebase a contradiction came from — two memories can look
  // flatly contradictory and both be right, in different projects. Resolve it here (one
  // batched read, not per-row) rather than making the client fetch each memory.
  const conflictNewIds = queueRows
    .filter(r => r.kind === 'memory-contradict' || r.kind === 'memory-supersede')
    .map(r => (r.proposed as { newId?: string } | null)?.newId)
    .filter((id): id is string => typeof id === 'string')

  const projectByMemoryId = new Map<string, string | null>()
  if (conflictNewIds.length) {
    const rows = await db.select({ id: memories.id, project: memories.project })
      .from(memories).where(inArray(memories.id, conflictNewIds))
    for (const row of rows) projectByMemoryId.set(row.id, row.project)
  }

  const queueItems: ReviewQueueFeedItem[] = queueRows.map(r => {
    const p = r.proposed as Record<string, unknown> | null
    const newId = typeof p?.newId === 'string' ? p.newId : null
    // Only widen the payload for conflict kinds; every other kind passes through untouched.
    const proposed = newId && projectByMemoryId.has(newId)
      ? { ...p, project: projectByMemoryId.get(newId) ?? null }
      : r.proposed
    return {
      id: r.id,
      docId: r.targetKind === 'document' ? r.targetId : null,
      kind: r.kind,
      proposed,
      createdAt: r.createdAt,
      docPath: r.docPath
    }
  })

  const unreviewedMemories = await db.select({
    id: memories.id,
    content: memories.content,
    scope: memories.scope,
    tags: memories.tags,
    project: memories.project,
    confidence: memories.confidence,
    jevScore: memories.jevScore,
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
      confidence: m.confidence,
      jevScore: m.jevScore
    },
    createdAt: m.createdAt,
    docPath: null
  }))

  // Queue rows (conflicts, triage, enrichment) stay newest-first — each is a distinct
  // decision with no quality score to rank by. Unreviewed MEMORIES sort worst-first, so the
  // likely junk is the first thing on screen and clearing it is a burst rather than a
  // scroll. Ordering only: nothing here decides anything (see lib/memory/jev-score.ts).
  const sortedQueue = [...queueItems].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  const sortedMemories = [...memoryItems].sort((a, b) =>
    compareByJev(
      { jevScore: a.proposed.jevScore, createdAt: a.createdAt },
      { jevScore: b.proposed.jevScore, createdAt: b.createdAt }
    )
  )
  return [...sortedQueue, ...sortedMemories]
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

/** Idempotent per (targetKind, targetId, kind): the partial unique index makes a second pending
 *  item for the same (target, kind) a no-op rather than a duplicate the human has to dismiss
 *  twice — but a DIFFERENT kind against the same target gets its own slot (migration 0051), so a
 *  memory that is e.g. both contradicted and resident-promotable files both concerns.
 *
 *  Returns whether a row was actually inserted, so callers that file several concerns in a loop
 *  (e.g. sweepMemoryConcerns) can report a true count instead of assuming every candidate landed. */
export async function enqueueReview(input: {
  targetKind: ReviewTargetKind
  targetId: string
  kind: string
  proposed: unknown
}): Promise<boolean> {
  const [inserted] = await useDb().insert(reviewQueue)
    .values({ targetKind: input.targetKind, targetId: input.targetId, kind: input.kind, proposed: input.proposed as never })
    .onConflictDoNothing()
    .returning({ id: reviewQueue.id })

  // onConflictDoNothing means a pre-existing pending row for this (target, kind) — nothing new
  // to tell live clients about.
  if (inserted) publishChange({ resource: 'review', action: 'created', id: inserted.id })
  return Boolean(inserted)
}
