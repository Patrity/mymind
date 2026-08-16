import { and, eq, isNull, sql } from 'drizzle-orm'
import { useDb } from '../db'
import { triageActions, memories, documents, chunks, reviewQueue, projects as projectsTable } from '../db/schema'
import { createTask, deleteTask } from './tasks'
import { getDoc, getDocIncludingDeleted, moveDoc, updateDoc, deleteDoc, restoreDoc, notSkill } from './documents'
import { createMemory } from './memory'
import { embedOne } from '../lib/ai/embeddings'
import { registerUndo } from '../lib/agent/undo'
import { publishChange } from '../utils/live-bus'
import { classify } from '../lib/ai/triage'
import { route } from '../lib/triage/route'
import type { TriageAction, TriageOutcome } from '../../shared/types/triage'
import type { DocumentDTO } from '../../shared/types/documents'

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

/**
 * The jot becomes a task; the document was only a courier, so it is soft-deleted.
 *
 * Reads via getDocIncludingDeleted, not getDoc: in a multi-destination proposal an earlier
 * courier-consuming action (task/memory/append, in any order the proposal's action list
 * puts them) may have already soft-deleted this same docId, and this actuator still needs
 * the captured text to build its own entity. See task-11b-brief.md.
 */
export async function applyTask(docId: string, action: TriageAction, autoApplied = true): Promise<AppliedAction> {
  const doc = await getDocIncludingDeleted(docId)
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

/**
 * The document IS the artifact: retitle, rename, and move it out of /input.
 *
 * Deliberately stays on the live-only getDoc, unlike applyTask/applyMemory/applyAppend —
 * a note never deletes its courier, so if it's already gone (soft-deleted by a sibling
 * courier-consuming action earlier in the same multi-destination proposal), there is
 * nothing left that a "note" can mean: the artifact it would retitle/move was already
 * turned into something else. Resurrecting it here (restoring deleted_at just so this
 * actuator has something to act on) would silently duplicate that other action's output
 * as a second, stale copy. Refusing is correct; see task-11b-report.md for the reasoning.
 *
 * The getDocIncludingDeleted lookup below runs ONLY on the failure path, and only to
 * phrase the error — it never reads that row's content to proceed.
 */
export async function applyNote(docId: string, action: TriageAction, autoApplied = true): Promise<AppliedAction> {
  const doc = await getDoc(docId)
  if (!doc) {
    const consumed = await getDocIncludingDeleted(docId)
    if (consumed) {
      throw new Error(`triage: document ${docId} already consumed by an earlier action in this proposal — note cannot act on it`)
    }
    throw new Error(`triage: document ${docId} not found`)
  }
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
 *
 * Reads via getDocIncludingDeleted, not getDoc — see applyTask's comment for why.
 */
export async function applyMemory(docId: string, action: TriageAction, autoApplied = true): Promise<AppliedAction> {
  const doc = await getDocIncludingDeleted(docId)
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

/**
 * The jot is added to a document that already covers the topic.
 *
 * APPEND-ONLY, and that is a hard constraint: it concatenates a delimited block and
 * never rewrites, reorders, or removes existing content. If no target is resolved it
 * DEGRADES TO A NOTE rather than guessing — a wrong append edits a document the user
 * never opened, which is the most expensive mistake this pipeline can make.
 *
 * The courier read below uses getDocIncludingDeleted, not getDoc — see applyTask's
 * comment for why. The SEPARATE `target` read further down (the document being appended
 * INTO) stays on the live-only getDoc: that document is never the courier and must never
 * be a soft-deleted row.
 */
export async function applyAppend(docId: string, action: TriageAction, autoApplied = true): Promise<AppliedAction> {
  const doc = await getDocIncludingDeleted(docId)
  if (!doc) throw new Error(`triage: document ${docId} not found`)

  const targetId = action.targetDocId ?? await resolveAppendTarget(doc.content)
  if (!targetId) return applyNote(docId, { ...action, kind: 'note' }, autoApplied)

  // Re-validate even a targetDocId the CALLER supplied directly — resolveAppendTarget's
  // own SQL guard only protects its own output. Today the model never emits targetDocId
  // (parseAction strips it), so this branch is currently unreachable from the classifier,
  // but "safe only because an upstream step cooperates" isn't structural safety, and this
  // is the actuator that edits a document the user never opened.
  const target = await getDoc(targetId)
  if (!target || !isValidAppendTarget(target)) return applyNote(docId, { ...action, kind: 'note' }, autoApplied)

  const previousContent = target.content
  const stamp = new Date().toISOString().slice(0, 10)
  const block = `\n\n<!-- triage:${docId} ${stamp} -->\n${action.content ?? doc.content}\n`
  await updateDoc(targetId, { content: previousContent + block })

  await deleteDoc(docId)

  // priorContent + appendedBlock ride in the payload so the DURABLE reversal path
  // (Task 12) can verify the target is byte-identical before restoring. The closure
  // below cannot help it: registerUndo's state dies with the process.
  const actionRowId = await recordAction({
    docId, action: { ...action, priorContent: previousContent, appendedBlock: block } as TriageAction,
    entityType: 'document', entityId: targetId, autoApplied
  })

  publishChange({ resource: 'document', action: 'updated', id: targetId })
  publishChange({ resource: 'document', action: 'deleted', id: docId })

  const undoToken = registerUndo(async () => {
    // Restore the exact prior body rather than string-subtracting the block —
    // the document may have been edited since, and a blind slice would corrupt it.
    const current = await getDoc(targetId)
    if (current && current.content === previousContent + block) {
      await updateDoc(targetId, { content: previousContent })
    }
    await restoreDoc(docId)
    await useDb().update(triageActions).set({ revertedAt: new Date() }).where(eq(triageActions.id, actionRowId))
    publishChange({ resource: 'document', action: 'updated', id: targetId })
    publishChange({ resource: 'document', action: 'updated', id: docId })
  })

  return { actionRowId, entityType: 'document', entityId: targetId, undoToken }
}

/**
 * Pick the document this jot belongs to, or null.
 *
 * This is the ONE place in triage that runs its own vector query, and that is
 * deliberate: searchDocs() fuses a trigram lane and a vector lane with RRF and returns
 * DocumentDTO[] ordered by fused RANK — it exposes no cosine score, so it cannot answer
 * "is the best match actually similar enough". The floor guardrail needs a real
 * similarity number, so we ask for one directly. Do NOT "simplify" this back to
 * searchDocs; that silently removes the guardrail.
 *
 * documents.embedding is schema-only (cycle 1) and always NULL (server/db/schema/documents.ts:28)
 * — the real per-document vectors live in `chunks` (sourceType='document'). This copies the
 * halfvec cast + `<=>` ordering verbatim from searchDocIds's vector lane in
 * server/services/documents.ts, the known-working reference, rather than the brief's
 * documents.embedding sketch, which would silently never match anything. notSkill() is the
 * same import that lane uses too — skills are documents but are never knowledge, and a
 * false-positive append here would corrupt a file that drives agent behaviour rather than
 * just misfiling a note.
 *
 * Exported for direct unit testing — mirrors documents.ts's toSummaryDTO convention. Its
 * output still passes through isValidAppendTarget in applyAppend, so this SQL guard and
 * that guard are deliberately redundant rather than the only line of defense.
 */
export async function resolveAppendTarget(content: string): Promise<string | null> {
  const floor = useRuntimeConfig().triageAppendSimilarityFloor as number
  const qv = await embedOne(content)
  const lit = `[${qv.join(',')}]`
  const [best] = await useDb()
    .select({
      sourceId: chunks.sourceId,
      distance: sql<number>`${chunks.embedding} <=> ${lit}::halfvec`
    })
    .from(chunks)
    .innerJoin(documents, eq(chunks.sourceId, documents.id))
    .where(and(
      eq(chunks.sourceType, 'document'),
      isNull(documents.deletedAt),
      notSkill(),
      sql`${documents.path} NOT LIKE '/input/%'`     // never append into the inbox itself
    ))
    .orderBy(sql`${chunks.embedding} <=> ${lit}::halfvec`)
    .limit(1)

  return best && (1 - best.distance) >= floor ? best.sourceId : null
}

/**
 * The same guardrails resolveAppendTarget enforces in SQL (not /input/, not a skill),
 * re-checked against a resolved document. Applied to EVERY targetId applyAppend acts on,
 * not just the auto-resolved one — see the call site's comment for why an explicitly
 * supplied targetDocId can't skip this.
 */
function isValidAppendTarget(doc: DocumentDTO): boolean {
  return doc.type !== 'skill' && !doc.path.startsWith('/input/')
}

/** Conditional claim. Returns false if another caller already owns this document. */
async function claim(docId: string): Promise<boolean> {
  const rows = await useDb().update(documents)
    .set({ triagedAt: new Date() })
    .where(and(eq(documents.id, docId), isNull(documents.triagedAt)))
    .returning({ id: documents.id })
  return rows.length > 0
}

const APPLY: Record<TriageAction['kind'], (docId: string, a: TriageAction) => Promise<AppliedAction>> = {
  task: applyTask,
  note: applyNote,
  memory: applyMemory,
  append: applyAppend
}

export async function triageCapture(docId: string): Promise<TriageOutcome> {
  // Claim BEFORE the model call so a racing caller cannot also pay for one.
  if (!await claim(docId)) return { docId, applied: [], queued: false, skipped: 'already-triaged' }

  const doc = await getDoc(docId)
  if (!doc) return { docId, applied: [], queued: false, skipped: 'already-triaged' }

  const activeProjects = (await useDb()
    .select({ slug: projectsTable.slug, name: projectsTable.name, description: projectsTable.description })
    .from(projectsTable)
    .where(eq(projectsTable.active, true)))
    .filter(p => p.slug !== 'uncategorized')

  const proposal = await classify({ path: doc.path, content: doc.content }, activeProjects)
  // triaged_at STAYS stamped on failure: retrying a doc the model cannot parse on every
  // sweep would burn tokens forever. The sweeper's job is coverage, not retry-until-success.
  if (!proposal) return { docId, applied: [], queued: false, skipped: 'parse-failed' }

  const thresholds = useRuntimeConfig().triageThresholds as Record<TriageAction['kind'], number>
  const routed = route(proposal, thresholds)

  const applied: TriageAction[] = []
  const queued: TriageAction[] = []

  for (const { action, autoApply } of routed) {
    if (!autoApply) { queued.push(action); continue }
    // applyTask/applyMemory/applyAppend all consume (soft-delete) the courier document;
    // applyNote never does. Each of those three now reads via getDocIncludingDeleted, so
    // a later action in the same proposal can still see the courier after an earlier one
    // has consumed it (task-11b) — this try/catch is a genuine last-resort backstop (e.g.
    // a downstream write failure), not the primary defense against a missing courier.
    try {
      await APPLY[action.kind](docId, action)
      applied.push(action)
    } catch (err) {
      console.warn(`[triage] actuator ${action.kind} failed for ${docId}:`, err)
      queued.push(action)
    }
  }

  if (queued.length > 0) {
    // ONE row per document — review_queue_one_pending_per_doc is a partial unique index.
    await useDb().insert(reviewQueue).values({
      docId,
      kind: 'triage',
      proposed: { primary: proposal.primary, secondary: proposal.secondary,
                  reasoning: proposal.reasoning, queued, applied } as unknown as Record<string, unknown>
    }).onConflictDoNothing()
    publishChange({ resource: 'review', action: 'created', id: docId })
  }

  return { docId, applied, queued: queued.length > 0 }
}

/**
 * Reverse an applied action WITHOUT a live undo token.
 *
 * registerUndo's TTL is 10 minutes; with auto-apply as the norm, the user needs to be
 * able to reverse something they noticed the next day. This reverses from the persisted
 * triage_actions row instead.
 */
export async function revertTriageAction(actionRowId: string): Promise<{ ok: boolean, reason?: string }> {
  const db = useDb()
  const [row] = await db.select().from(triageActions).where(eq(triageActions.id, actionRowId)).limit(1)
  if (!row) return { ok: false, reason: 'that action no longer exists' }
  if (row.revertedAt) return { ok: false, reason: 'that action was already reverted' }

  const payload = row.payload as unknown as TriageAction

  try {
    if (row.entityType === 'task' && row.entityId) {
      await deleteTask(row.entityId)
      await restoreDoc(row.docId)
      publishChange({ resource: 'task', action: 'deleted', id: row.entityId })
    } else if (row.entityType === 'memory' && row.entityId) {
      // Archive, never hard-delete: dedup may have merged into a pre-existing memory.
      await db.update(memories).set({ archivedAt: new Date() }).where(eq(memories.id, row.entityId))
      await restoreDoc(row.docId)
      publishChange({ resource: 'memory', action: 'updated', id: row.entityId })
    } else if (row.entityType === 'document' && row.entityId) {
      if (row.kind === 'note') {
        // The doc IS the artifact — move it back to where it was captured.
        const original = (payload as TriageAction & { originalPath?: string }).originalPath
        if (original) await moveDoc(row.entityId, original)
      } else {
        // append — only revert if the target is byte-identical to what we wrote.
        const applied = (payload as TriageAction & { appendedBlock?: string, priorContent?: string })
        const current = await getDoc(row.entityId)
        if (current && applied.priorContent !== undefined && applied.appendedBlock !== undefined
            && current.content === applied.priorContent + applied.appendedBlock) {
          await updateDoc(row.entityId, { content: applied.priorContent })
        }
        await restoreDoc(row.docId)
      }
      publishChange({ resource: 'document', action: 'updated', id: row.entityId })
    }
  } catch (err) {
    // The reason is USER-FACING. Never interpolate a caught error into it: runUndo
    // leaked entire prior document bodies exactly that way, because a DrizzleQueryError
    // embeds its bound params in `message` (fixed 2026-08-16, commit 4a3792f).
    console.error('[triage] revert failed:', err)
    return { ok: false, reason: 'the reversal failed — check the item and undo it manually' }
  }

  await db.update(triageActions).set({ revertedAt: new Date() }).where(eq(triageActions.id, actionRowId))
  return { ok: true }
}

/**
 * Backstop for anything the immediate post-capture path missed: server restart
 * mid-flight, model timeout, MCP quick_capture, direct POST /api/documents.
 *
 * Candidates are simply "live /input docs not yet triaged" — deliberately NOT the
 * old enrich-input filter (project IS NULL AND tags = '{}' AND no review_queue row),
 * which made a document eligible exactly once ever and left /input unable to drain.
 */
export async function sweepUntriaged({ limit = 20 }: { limit?: number } = {}) {
  const candidates = await useDb().select({ id: documents.id })
    .from(documents)
    .where(and(
      isNull(documents.deletedAt),
      isNull(documents.triagedAt),
      sql`${documents.path} LIKE '/input/%'`
    ))
    .limit(limit)

  let triaged = 0
  let skipped = 0
  for (const c of candidates) {
    // Isolate each candidate: claim() inside triageCapture already stamped triaged_at
    // before any of this can throw, so an uncaught exception here wouldn't just abort
    // the rest of the batch (stalling it until the next 10-minute tick) — it would leave
    // that one document claimed forever with no applied action and no review row, i.e.
    // silently stuck. Same reasoning the retired runEnrichInput's per-doc try/catch was for.
    try {
      const out = await triageCapture(c.id)
      if (out.skipped) skipped++
      else triaged++
    } catch (err) {
      console.warn(`[triage] sweep failed for ${c.id}:`, err)
      skipped++
    }
  }
  return { triaged, skipped }
}
