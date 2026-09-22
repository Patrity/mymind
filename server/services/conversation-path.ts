import { sql } from 'drizzle-orm'
import { useDb } from '../db'
import { conversationMessages, conversations } from '../db/schema'
import { activePath, branchIndex } from '../../shared/utils/conversation-path'

/** One message's position among its siblings, plus the ids the ‹ n/N › pager can switch to. */
export interface BranchInfo {
  index: number
  total: number
  /** Siblings in read order (`created_at, id`), including this message — so
   *  `siblingIds[index - 1]` is it. */
  siblingIds: string[]
}

/**
 * The active path for a thread, root-first, plus sibling indexes for the pager.
 *
 * One query fetches the thread's rows; the walk is pure (shared/utils/conversation-path) so it
 * is unit-tested without a database. A recursive CTE per read would win only on threads far
 * larger than any here, and this keeps the walk identical for BOTH read paths — which is the
 * property that matters most (see test/conversation-path.db.test.ts).
 *
 * A null leaf returns every row in `(created_at, id)` order: the pre-cycle-68 behaviour, so a
 * thread whose leaf is somehow unset renders in full instead of appearing empty. Both read
 * paths fall back TOGETHER — asserted, because a fallback only one path takes is this cycle's
 * failure mode in its worst form (see the null-leaf test).
 */
export async function loadActivePath(conversationId: string): Promise<{
  rows: Array<typeof conversationMessages.$inferSelect>
  branches: Map<string, BranchInfo>
}> {
  const db = useDb()
  // `id` is the tie-break, not decoration: cycle 68's predecessor measured a 26% created_at
  // collision rate in this corpus, and each read path runs its own copy of this query. On
  // `created_at` alone Postgres may order tied rows differently per query — which would let the
  // two read paths disagree on the null-leaf fallback, and would swap a sibling between 1/2 and
  // 2/2 (reordering `siblingIds` with it) from one request to the next, surfacing as a branch
  // pager that jumps for no reason. Deterministic beats arbitrary-and-unstable; the 0045
  // backfill carries the same ruling.
  const rows = await db.select().from(conversationMessages)
    .where(sql`${conversationMessages.conversationId} = ${conversationId}`)
    .orderBy(conversationMessages.createdAt, conversationMessages.id)

  const [conv] = await db.select({ leaf: conversations.activeLeafId }).from(conversations)
    .where(sql`${conversations.id} = ${conversationId}`).limit(1)

  // Indexes cover the whole THREAD, not just the path: a message on the active path needs the
  // count of siblings that are off it, which is the only thing the pager has to render.
  const branches = withSiblings(rows, branchIndex(rows.map(r => ({ id: r.id, parentId: r.parentId }))))
  const path = activePath(rows, conv?.leaf ?? null)
  return { rows: path.length ? path : rows, branches }
}

/**
 * Widen each branch position with the ids of its siblings.
 *
 * Only the active path is returned to a caller, so a sibling branch appears nowhere in the
 * transcript — these ids are the client's only handle on the branches it is NOT reading. Each
 * group is ordered by the index `branchIndex` already assigned rather than re-deriving an order
 * from `rows`, so `siblingIds[index - 1] === id` holds by construction and the two derivations
 * cannot drift apart.
 */
function withSiblings(
  rows: Array<{ id: string; parentId: string | null }>,
  indexes: Map<string, { index: number; total: number }>
): Map<string, BranchInfo> {
  const byParent = new Map<string | null, string[]>()
  for (const r of rows) {
    const group = byParent.get(r.parentId)
    if (group) group.push(r.id)
    else byParent.set(r.parentId, [r.id])
  }

  const out = new Map<string, BranchInfo>()
  for (const group of byParent.values()) {
    // Resolve each position ONCE, and drop an id `indexes` doesn't cover rather than asserting
    // it must: `branchIndex` is fed the same rows so the lookup cannot miss today, but a caller
    // that ever passes a narrower index map gets a message with no pager instead of a throw.
    const positioned = group.flatMap(id => {
      const pos = indexes.get(id)
      return pos ? [{ id, pos }] : []
    })
    positioned.sort((a, b) => a.pos.index - b.pos.index)
    const siblingIds = positioned.map(p => p.id)
    for (const { id, pos } of positioned) {
      out.set(id, { index: pos.index, total: pos.total, siblingIds })
    }
  }
  return out
}
