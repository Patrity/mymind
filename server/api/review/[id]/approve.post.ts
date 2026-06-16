import { and, eq } from 'drizzle-orm'
import { useDb } from '../../../db'
import { reviewQueue, memories, memoryRelations } from '../../../db/schema'
import { getDoc, updateDoc, moveDoc } from '../../../services/documents'
import { publishChange } from '../../../utils/live-bus'

const MEMORY_CONFLICT_KINDS = new Set(['memory-supersede', 'memory-contradict'])

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const db = useDb()
  const [item] = await db.select().from(reviewQueue).where(eq(reviewQueue.id, id)).limit(1)
  if (!item || item.status !== 'pending') throw createError({ statusCode: 404 })

  // ── Memory conflict kinds (memory-supersede / memory-contradict) ──────────
  if (MEMORY_CONFLICT_KINDS.has(item.kind)) {
    const p = item.proposed as {
      newId: string
      existingId: string
      confidence?: number | null
      reasoning?: string | null
      newContent?: string | null
      existingContent?: string | null
    }

    // accept → archive the existing (old) memory
    await db.update(memories)
      .set({ archivedAt: new Date(), supersededBy: p.newId, updatedAt: new Date() })
      .where(eq(memories.id, p.existingId))

    // mark the relation resolved
    await db.update(memoryRelations)
      .set({ status: 'resolved', resolvedAt: new Date() })
      .where(and(eq(memoryRelations.toId, p.existingId), eq(memoryRelations.fromId, p.newId)))

    await db.update(reviewQueue)
      .set({ status: 'approved', resolvedAt: new Date() })
      .where(eq(reviewQueue.id, id))

    publishChange({ resource: 'review', action: 'updated', id })
    publishChange({ resource: 'memory', action: 'updated', id: p.existingId })

    return { ok: true }
  }

  // ── Enrichment-doc kind (original behaviour) ──────────────────────────────
  const p = item.proposed as {
    title?: string | null
    project?: string | null
    domain?: string | null
    type?: string | null
    tags?: string[] | null
    path?: string | null
    reasoning?: string | null
  }

  const doc = await getDoc(item.docId)
  if (doc) {
    await updateDoc(item.docId, {
      title: p.title ?? doc.title,
      project: p.project ?? doc.project,
      domain: p.domain ?? doc.domain,
      type: p.type ?? doc.type,
      tags: p.tags ?? doc.tags
    })
    if (p.path && p.path !== doc.path) {
      try {
        await moveDoc(item.docId, p.path)
      } catch {
        // path taken — leave in place
      }
    }
  }

  await db.update(reviewQueue)
    .set({ status: 'approved', resolvedAt: new Date() })
    .where(eq(reviewQueue.id, id))

  publishChange({ resource: 'review', action: 'updated', id })
  publishChange({ resource: 'document', action: 'updated', id: item.docId })

  return { ok: true }
})
