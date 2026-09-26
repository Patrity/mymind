import { eq, and, inArray } from 'drizzle-orm'
import { useDb } from '../../../db'
import { reviewQueue, memories, memoryRelations } from '../../../db/schema'
import { publishChange } from '../../../utils/live-bus'
import { archivalPlan, isConflictResolution, queueStatusFor } from '../../../lib/review/conflict-resolution'

const CONFLICT_KINDS = new Set(['memory-contradict', 'memory-supersede'])

/**
 * Resolve a memory conflict one of four ways — see ConflictResolution.
 *
 * Separate from approve/reject rather than bolted onto them: those two are the generic
 * verbs every review kind implements, and a conflict has four outcomes, not two. Folding a
 * `resolution` body param into `approve` would have made "approve" mean "archive the new
 * one" for this kind alone.
 */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const { resolution } = await readBody<{ resolution?: unknown }>(event)
  if (!isConflictResolution(resolution)) {
    throw createError({ statusCode: 400, statusMessage: `Unknown resolution: ${String(resolution)}` })
  }

  const db = useDb()
  const [item] = await db.select().from(reviewQueue).where(eq(reviewQueue.id, id)).limit(1)
  if (!item || item.status !== 'pending') throw createError({ statusCode: 404 })
  if (!CONFLICT_KINDS.has(item.kind)) {
    throw createError({ statusCode: 400, statusMessage: `Not a memory conflict: ${item.kind}` })
  }

  const p = item.proposed as { newId?: string, existingId?: string } | null
  if (!p?.newId || !p?.existingId) {
    throw createError({ statusCode: 422, statusMessage: 'Conflict row is missing newId/existingId' })
  }

  const plan = archivalPlan(resolution, { newId: p.newId, existingId: p.existingId })

  if (plan.archive.length) {
    await db.update(memories)
      .set({ archivedAt: new Date(), supersededBy: plan.supersededBy, updatedAt: new Date() })
      .where(inArray(memories.id, plan.archive))
  }

  // The relation is resolved either way — the human has ruled, so it must never come back.
  await db.update(memoryRelations)
    .set({ status: 'resolved', resolvedAt: new Date() })
    .where(and(eq(memoryRelations.toId, p.existingId), eq(memoryRelations.fromId, p.newId)))

  await db.update(reviewQueue)
    .set({ status: queueStatusFor(resolution), resolvedAt: new Date() })
    .where(eq(reviewQueue.id, item.id))

  publishChange({ resource: 'review', action: 'updated', id: item.id })
  for (const memId of plan.archive) publishChange({ resource: 'memory', action: 'updated', id: memId })

  return { ok: true, resolution, archived: plan.archive }
})
