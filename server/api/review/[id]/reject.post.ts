import { and, eq } from 'drizzle-orm'
import { useDb } from '../../../db'
import { reviewQueue, memoryRelations } from '../../../db/schema'
import { publishChange } from '../../../utils/live-bus'

const MEMORY_CONFLICT_KINDS = new Set(['memory-supersede', 'memory-contradict'])

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const db = useDb()
  const [item] = await db.select().from(reviewQueue).where(eq(reviewQueue.id, id)).limit(1)
  if (!item || item.status !== 'pending') throw createError({ statusCode: 404 })

  // ── Memory conflict kinds — keep-both / reject ────────────────────────────
  if (MEMORY_CONFLICT_KINDS.has(item.kind)) {
    const p = item.proposed as { newId: string, existingId: string }

    // mark the relation resolved (archive nothing)
    await db.update(memoryRelations)
      .set({ status: 'resolved', resolvedAt: new Date() })
      .where(and(eq(memoryRelations.toId, p.existingId), eq(memoryRelations.fromId, p.newId)))

    await db.update(reviewQueue)
      .set({ status: 'rejected', resolvedAt: new Date() })
      .where(eq(reviewQueue.id, id))

    publishChange({ resource: 'review', action: 'updated', id })

    return { ok: true }
  }

  // ── Enrichment-doc kind (original behaviour) ──────────────────────────────
  await db.update(reviewQueue)
    .set({ status: 'rejected', resolvedAt: new Date() })
    .where(eq(reviewQueue.id, id))

  publishChange({ resource: 'review', action: 'updated', id })

  return { ok: true }
})
