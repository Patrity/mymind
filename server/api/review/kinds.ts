import { and, eq } from 'drizzle-orm'
import { useDb } from '../../db'
import { reviewQueue, memories, memoryRelations, documents } from '../../db/schema'
import type { ReviewItem } from '../../db/schema'
import { getDoc, updateDoc, moveDoc } from '../../services/documents'
import { applyTask, applyNote, applyMemory, applyAppend } from '../../services/triage'
import { publishChange } from '../../utils/live-bus'
import type { TriageAction } from '../../../shared/types/triage'

/**
 * Most handlers have nothing to report beyond success. approveTriage is the exception:
 * the caller (the approve endpoint, then the UI toast) needs to know how many of the
 * QUEUED actions actually applied — after task-11b, that should be all of them, but the
 * count must come from what really happened, not from the pre-request queue length.
 */
export interface HandlerResult { applied?: TriageAction[] }

type Handler = (item: ReviewItem) => Promise<HandlerResult | void>

interface TriageProposedRow {
  primary: TriageAction
  secondary: TriageAction[]
  reasoning: string
  queued: TriageAction[]
  applied: TriageAction[]
}

const APPLY: Record<TriageAction['kind'], (docId: string, action: TriageAction, autoApplied?: boolean) => Promise<unknown>> = {
  task: applyTask,
  note: applyNote,
  memory: applyMemory,
  append: applyAppend
}

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

// ── Triage kind ───────────────────────────────────────────────────────────
//
// One review_queue row per document; `proposed.queued` holds the action(s) that fell
// below their auto-apply confidence threshold. Approve runs each queued action through
// its actuator with autoApplied=false (a human decided, not the classifier). Reject
// re-stamps documents.triaged_at — it is already set from triageCapture's claim(), but
// stamping it again here keeps the sweeper's "don't immediately re-propose" guarantee
// intact even if that invariant ever changes upstream.

async function approveTriage(item: ReviewItem): Promise<HandlerResult> {
  const db = useDb()
  const p = item.proposed as TriageProposedRow
  const applied: TriageAction[] = []

  for (const action of p.queued ?? []) {
    try {
      await APPLY[action.kind](item.docId, action, false)
      applied.push(action)
    } catch (err) {
      // Since task-11b, task/memory/append all read the courier via getDocIncludingDeleted,
      // so a sibling queued action having already consumed it is no longer a reason for
      // this to throw — a throw here means a genuine actuator failure (bad payload,
      // downstream write error). A human already approved this proposal; one action
      // failing must not roll back the ones that succeeded or leave the row stuck pending
      // forever, but it also must NOT be counted as applied — that's exactly the silent
      // "approved but did nothing" failure task-11b exists to close.
      console.warn(`[review] triage actuator ${action.kind} failed for ${item.docId}:`, err)
    }
  }

  await db.update(reviewQueue)
    .set({ status: 'approved', resolvedAt: new Date() })
    .where(eq(reviewQueue.id, item.id))

  publishChange({ resource: 'review', action: 'updated', id: item.id })

  return { applied }
}

async function rejectTriage(item: ReviewItem): Promise<void> {
  const db = useDb()

  await db.update(documents)
    .set({ triagedAt: new Date() })
    .where(eq(documents.id, item.docId))

  await db.update(reviewQueue)
    .set({ status: 'rejected', resolvedAt: new Date() })
    .where(eq(reviewQueue.id, item.id))

  publishChange({ resource: 'review', action: 'updated', id: item.id })
}

export const approveHandlers: Record<string, Handler> = {
  enrichment: approveEnrichment,
  'memory-supersede': approveMemoryConflict,
  'memory-contradict': approveMemoryConflict,
  triage: approveTriage
}

export const rejectHandlers: Record<string, Handler> = {
  enrichment: rejectEnrichment,
  'memory-supersede': rejectMemoryConflict,
  'memory-contradict': rejectMemoryConflict,
  triage: rejectTriage
}
