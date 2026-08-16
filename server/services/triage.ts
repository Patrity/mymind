import { eq } from 'drizzle-orm'
import { useDb } from '../db'
import { triageActions, memories } from '../db/schema'
import { createTask, deleteTask } from './tasks'
import { getDoc, moveDoc, updateDoc, deleteDoc, restoreDoc } from './documents'
import { createMemory } from './memory'
import { registerUndo } from '../lib/agent/undo'
import { publishChange } from '../utils/live-bus'
import type { TriageAction } from '../../shared/types/triage'

export interface AppliedAction {
  actionRowId: string
  entityType: 'task' | 'memory' | 'document'
  entityId: string | null
  undoToken: string
}

async function recordAction(input: {
  docId: string, action: TriageAction, entityType: AppliedAction['entityType'],
  entityId: string | null, autoApplied: boolean
}): Promise<string> {
  const [row] = await useDb().insert(triageActions).values({
    docId: input.docId,
    kind: input.action.kind,
    entityType: input.entityType,
    entityId: input.entityId,
    confidence: input.action.confidence,
    autoApplied: input.autoApplied,
    payload: input.action as unknown as Record<string, unknown>
  }).returning({ id: triageActions.id })
  return row!.id
}

/** The jot becomes a task; the document was only a courier, so it is soft-deleted. */
export async function applyTask(docId: string, action: TriageAction, autoApplied = true): Promise<AppliedAction> {
  const doc = await getDoc(docId)
  if (!doc) throw new Error(`triage: document ${docId} not found`)

  const task = await createTask({
    title: action.title ?? doc.title ?? 'Untitled task',
    description: doc.content,                      // the raw jot, verbatim
    project: action.project ?? null,
    priority: action.priority ?? 'low',
    dueDate: action.dueDate ? new Date(action.dueDate) : null
  })

  await deleteDoc(docId)

  const actionRowId = await recordAction({ docId, action, entityType: 'task', entityId: task.id, autoApplied })

  publishChange({ resource: 'task', action: 'created', id: task.id })
  publishChange({ resource: 'document', action: 'deleted', id: docId })

  const undoToken = registerUndo(async () => {
    await deleteTask(task.id)
    await restoreDoc(docId)
    await useDb().update(triageActions).set({ revertedAt: new Date() }).where(eq(triageActions.id, actionRowId))
    publishChange({ resource: 'task', action: 'deleted', id: task.id })
    publishChange({ resource: 'document', action: 'updated', id: docId })
  })

  return { actionRowId, entityType: 'task', entityId: task.id, undoToken }
}

/** The document IS the artifact: retitle, rename, and move it out of /input. */
export async function applyNote(docId: string, action: TriageAction, autoApplied = true): Promise<AppliedAction> {
  const doc = await getDoc(docId)
  if (!doc) throw new Error(`triage: document ${docId} not found`)
  const originalPath = doc.path

  if (action.title) await updateDoc(docId, { title: action.title })
  // moveDoc, not a direct column write — project/project_id derive from path.
  if (action.path && action.path !== originalPath) await moveDoc(docId, action.path)

  // originalPath rides in the payload because the DURABLE reversal path (Task 12) has no
  // access to this closure — registerUndo's state dies with the process, and its token
  // expires after 10 minutes. Without this, an undo the next day cannot restore the path.
  const actionRowId = await recordAction({
    docId, action: { ...action, originalPath } as TriageAction, entityType: 'document',
    entityId: docId, autoApplied
  })

  publishChange({ resource: 'document', action: 'updated', id: docId })

  const undoToken = registerUndo(async () => {
    await moveDoc(docId, originalPath)
    await updateDoc(docId, { title: doc.title })
    await useDb().update(triageActions).set({ revertedAt: new Date() }).where(eq(triageActions.id, actionRowId))
    publishChange({ resource: 'document', action: 'updated', id: docId })
  })

  return { actionRowId, entityType: 'document', entityId: docId, undoToken }
}

/**
 * The jot becomes a durable memory; the document was a courier, so it is soft-deleted.
 *
 * MUST go through createMemory() — it owns dedup (buildDedupCandidates + dedupDecision:
 * skip | merge | insert) and shouldAutoReview. A direct insert here would silently
 * bypass dedup, and enrich-memories dedup under-catching (task f80622b9) is still open.
 * createMemory may return an EXISTING memory on the skip/merge paths; that is correct.
 */
export async function applyMemory(docId: string, action: TriageAction, autoApplied = true): Promise<AppliedAction> {
  const doc = await getDoc(docId)
  if (!doc) throw new Error(`triage: document ${docId} not found`)

  const memory = await createMemory({
    content: action.content ?? doc.content,
    scope: action.scope ?? 'user',
    project: action.project ?? null,
    tags: action.tags ?? [],
    confidence: action.confidence,
    source: `triage:${docId}`
  })

  await deleteDoc(docId)

  const actionRowId = await recordAction({ docId, action, entityType: 'memory', entityId: memory.id, autoApplied })

  publishChange({ resource: 'memory', action: 'created', id: memory.id })
  publishChange({ resource: 'document', action: 'deleted', id: docId })

  const undoToken = registerUndo(async () => {
    // Archive rather than hard-delete: dedup may have MERGED into a pre-existing
    // memory, and destroying that row would take unrelated evidence with it.
    await useDb().update(memories).set({ archivedAt: new Date() }).where(eq(memories.id, memory.id))
    await restoreDoc(docId)
    await useDb().update(triageActions).set({ revertedAt: new Date() }).where(eq(triageActions.id, actionRowId))
    publishChange({ resource: 'memory', action: 'updated', id: memory.id })
    publishChange({ resource: 'document', action: 'updated', id: docId })
  })

  return { actionRowId, entityType: 'memory', entityId: memory.id, undoToken }
}
