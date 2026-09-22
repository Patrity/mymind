import { sql } from 'drizzle-orm'
import { useDb } from '../db'
import { conversationMessages, conversations } from '../db/schema'
import { activePath, branchIndex } from '../../shared/utils/conversation-path'

/** One message's position among its siblings, plus the ids the ‹ n/N › pager can switch to. */
export interface BranchInfo {
  index: number
  total: number
  /** Siblings in creation order, including this message — so `siblingIds[index - 1]` is it. */
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
 * A null leaf returns every row in created_at order: the pre-cycle-68 behaviour, so a thread
 * whose leaf is somehow unset renders in full instead of appearing empty.
 */
export async function loadActivePath(conversationId: string): Promise<{
  rows: Array<typeof conversationMessages.$inferSelect>
  branches: Map<string, BranchInfo>
}> {
  const db = useDb()
  const rows = await db.select().from(conversationMessages)
    .where(sql`${conversationMessages.conversationId} = ${conversationId}`)
    .orderBy(conversationMessages.createdAt)

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
    const siblingIds = [...group].sort((a, b) => indexes.get(a)!.index - indexes.get(b)!.index)
    for (const id of siblingIds) {
      const { index, total } = indexes.get(id)!
      out.set(id, { index, total, siblingIds })
    }
  }
  return out
}
