import { and, eq } from 'drizzle-orm'
import { useDb } from '../../db'
import { reviewQueue, memories, memoryRelations } from '../../db/schema'
import type { ReviewItem } from '../../db/schema'
import { getDoc, updateDoc, moveDoc } from '../../services/documents'
import { publishChange } from '../../utils/live-bus'

type Handler = (item: ReviewItem) => Promise<void>

// ── Memory conflict kinds (memory-supersede / memory-contradict) ────────────

async function approveMemoryConflict(item: ReviewItem): Promise<void> {
  const db = useDb()
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
    .where(eq(reviewQueue.id, item.id))

  publishChange({ resource: 'review', action: 'updated', id: item.id })
  publishChange({ resource: 'memory', action: 'updated', id: p.existingId })
}

async function rejectMemoryConflict(item: ReviewItem): Promise<void> {
  const db = useDb()
  const p = item.proposed as { newId: string, existingId: string }

  // mark the relation resolved (archive nothing)
  await db.update(memoryRelations)
    .set({ status: 'resolved', resolvedAt: new Date() })
    .where(and(eq(memoryRelations.toId, p.existingId), eq(memoryRelations.fromId, p.newId)))

  await db.update(reviewQueue)
    .set({ status: 'rejected', resolvedAt: new Date() })
    .where(eq(reviewQueue.id, item.id))

  publishChange({ resource: 'review', action: 'updated', id: item.id })
}

// ── Enrichment-doc kind (original behaviour) ─────────────────────────────────

async function approveEnrichment(item: ReviewItem): Promise<void> {
  const db = useDb()
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
    .where(eq(reviewQueue.id, item.id))

  publishChange({ resource: 'review', action: 'updated', id: item.id })
  publishChange({ resource: 'document', action: 'updated', id: item.docId })
}

async function rejectEnrichment(item: ReviewItem): Promise<void> {
  const db = useDb()
  await db.update(reviewQueue)
    .set({ status: 'rejected', resolvedAt: new Date() })
    .where(eq(reviewQueue.id, item.id))

  publishChange({ resource: 'review', action: 'updated', id: item.id })
}

export const approveHandlers: Record<string, Handler> = {
  enrichment: approveEnrichment,
  'memory-supersede': approveMemoryConflict,
  'memory-contradict': approveMemoryConflict
}

export const rejectHandlers: Record<string, Handler> = {
  enrichment: rejectEnrichment,
  'memory-supersede': rejectMemoryConflict,
  'memory-contradict': rejectMemoryConflict
}
