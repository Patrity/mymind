// server/services/review-decisions.ts
//
// Deciding a /review item (cycle 76, spec §7a). ONE path shared by the page's approve / reject /
// resolve routes and Bridget's decide_review tool, so undo tokens, revisions, rejection memory and
// live events behave the same whoever decides. The outcomes an item supports come from
// reviewChoices (shared/review/choices.ts), the registry the page renders its buttons from.
//
// Two id spaces meet here (see server/services/review.ts): a review_queue.id for every real
// queue row, and a memories.id for the synthetic `memory-unreviewed` kind.
import { and, eq, inArray } from 'drizzle-orm'
import { useDb } from '../db'
import { reviewQueue, memories, memoryRelations, type ReviewItem } from '../db/schema'
import { publishChange } from '../utils/live-bus'
import { approveHandlers, rejectHandlers, type HandlerResult } from '../api/review/kinds'
import { archivalPlan, isConflictResolution, queueStatusFor, type ConflictResolution } from '../lib/review/conflict-resolution'
import { archiveMemory, reviewMemory, unarchiveMemory } from './memory'
import { listReviewFeed, unreviewedLive, type ReviewFeedItem } from './review'
import { registerUndo } from '../lib/agent/undo'
import { MEMORY_CONFLICT_KINDS, reviewChoices, type ReviewChoice } from '../../shared/review/choices'

export type DecisionResult =
  | {
    ok: true
    summary: string
    undoToken?: string
    applied?: unknown
    /** The kind handler's own result, untouched — the approve route returns exactly these fields. */
    result?: HandlerResult
  }
  | {
    ok: false
    reason: 'not_pending' | 'unknown_kind' | 'invalid_choice' | 'conflict' | 'apply_failed'
    message: string
    /** The item's kind, when it was found. */
    kind?: string
    /** `conflict` only: the target's current content (the 409's `data.current`). */
    current?: unknown
  }

export interface DecideOptions {
  /**
   * The HTTP routes' historical contract, kept by the thin route wrappers:
   * - only review_queue rows are looked up (a memories.id 404s there, as it always has);
   * - `approve` / `reject` are accepted for EVERY kind that has a handler — including the memory
   *   conflict kinds, whose approve/reject handlers predate the four-way resolve.
   * decide_review never sets this: it decides strictly from reviewChoices.
   */
  route?: boolean
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const notPending = (id: string): DecisionResult =>
  ({ ok: false, reason: 'not_pending', message: `No pending review item ${id} — it was already decided, or the id is wrong. Call list_reviews for the current queue.` })

function statusOf(err: unknown): number | undefined {
  const e = err as { statusCode?: unknown, status?: unknown } | null
  const s = e?.statusCode ?? e?.status
  return typeof s === 'number' ? s : undefined
}

export async function decideReview(id: string, choice: string, opts: DecideOptions = {}): Promise<DecisionResult> {
  if (!UUID.test(id)) return notPending(id)
  const db = useDb()
  const [item] = await db.select().from(reviewQueue).where(eq(reviewQueue.id, id)).limit(1)
  if (!item) return opts.route ? notPending(id) : decideUnreviewedMemory(id, choice)
  if (item.status !== 'pending') return notPending(id)

  const isConflict = MEMORY_CONFLICT_KINDS.has(item.kind)
  if (!approveHandlers[item.kind] && !isConflict) {
    return { ok: false, reason: 'unknown_kind', kind: item.kind, message: `Review item ${id} has kind "${item.kind}", which can't be decided here. Leave it for Tony on /review.` }
  }

  const choices = reviewChoices(item)
  const genericVerb = choice === 'approve' || choice === 'reject'
  const allowed = choices.some(c => c.id === choice) || (opts.route === true && genericVerb)
  if (!allowed) return invalidChoice(item, choice, choices)

  if (isConflict && isConflictResolution(choice)) return resolveMemoryConflict(item, choice)
  return runHandler(item, choice as 'approve' | 'reject')
}

function invalidChoice(item: { id: string, kind: string }, choice: string, choices: ReviewChoice[]): DecisionResult {
  return {
    ok: false,
    reason: 'invalid_choice',
    kind: item.kind,
    message: `"${choice}" isn't a choice for this ${item.kind} item. Choose one of: ${choices.map(c => `${c.id} (${c.label})`).join(', ')}.`
  }
}

async function runHandler(item: ReviewItem, choice: 'approve' | 'reject'): Promise<DecisionResult> {
  const handler = (choice === 'approve' ? approveHandlers : rejectHandlers)[item.kind]!
  let result: HandlerResult | void
  try {
    result = await handler(item)
  } catch (err) {
    const status = statusOf(err)
    const data = (err as { data?: { summary?: string, current?: unknown } }).data
    const message = data?.summary ?? (err as Error).message
    // A self-improvement approve whose target changed since the proposal (preflight Ruling 1):
    // nothing was written and the item stays pending with the fresh content.
    if (status === 409) return { ok: false, reason: 'conflict', kind: item.kind, message, current: data?.current }
    // Another decider claimed the self-improvement first (final review m2): nothing written.
    if (status === 410) return notPending(item.id)
    // Applying failed for another reason (target gone, content no longer valid): nothing written.
    if (status === 422) return { ok: false, reason: 'apply_failed', kind: item.kind, message }
    throw err
  }
  const r = result ?? undefined
  return {
    ok: true,
    summary: summaryFor(item, choice, r),
    undoToken: r?.undoToken,
    applied: r?.applied,
    result: r
  }
}

function summaryFor(item: ReviewItem, choice: 'approve' | 'reject', r: HandlerResult | undefined): string {
  if (choice === 'reject') return 'Rejected.'
  if (r?.summary) return r.summary
  if (item.kind === 'triage') return `Applied ${r?.applied?.length ?? 0} action(s).`
  // approveAgentAction returns {} when the replay failed (or another caller won the claim); it
  // has already recorded the failure in the thread.
  if (item.kind === 'agent-action') return 'Approved, but the action could not be applied — see the thread.'
  return 'Approved.'
}

/** Resolve a memory conflict one of four ways — the logic the resolve route held (see its
 *  header for why this is separate from approve/reject). */
async function resolveMemoryConflict(item: ReviewItem, resolution: ConflictResolution): Promise<DecisionResult> {
  const p = item.proposed as { newId?: string, existingId?: string } | null
  if (!p?.newId || !p?.existingId) {
    return { ok: false, reason: 'apply_failed', kind: item.kind, message: 'Conflict row is missing newId/existingId' }
  }
  const plan = archivalPlan(resolution, { newId: p.newId, existingId: p.existingId })

  // Claim the item FIRST, guarded on `pending`, in one transaction with the archival: with two
  // deciders (the page and Bridget) a second decision racing the first must change nothing —
  // it claims zero rows and reports not_pending, and the archival never runs twice.
  const claimed = await useDb().transaction(async (tx) => {
    const [row] = await tx.update(reviewQueue)
      .set({ status: queueStatusFor(resolution), resolvedAt: new Date() })
      .where(and(eq(reviewQueue.id, item.id), eq(reviewQueue.status, 'pending')))
      .returning({ id: reviewQueue.id })
    if (!row) return false

    if (plan.archive.length) {
      await tx.update(memories)
        .set({ archivedAt: new Date(), supersededBy: plan.supersededBy, updatedAt: new Date() })
        .where(inArray(memories.id, plan.archive))
    }
    // The relation is resolved either way — the human has ruled, so it must never come back.
    await tx.update(memoryRelations)
      .set({ status: 'resolved', resolvedAt: new Date() })
      .where(and(eq(memoryRelations.toId, p.existingId!), eq(memoryRelations.fromId, p.newId!)))
    return true
  })
  if (!claimed) return notPending(item.id)

  publishChange({ resource: 'review', action: 'updated', id: item.id })
  for (const memId of plan.archive) publishChange({ resource: 'memory', action: 'updated', id: memId })

  const label = reviewChoices(item).find(c => c.id === resolution)!.label
  return { ok: true, summary: `${label}: ${plan.archive.length ? `archived ${plan.archive.length} memory(ies)` : 'nothing archived'}.`, applied: plan.archive }
}

/** The synthetic `memory-unreviewed` kind: approve = Mark reviewed, reject = Discard
 *  (archive, undoable) — the same service calls as POST /api/memories/[id]/review and /archive,
 *  which is what the /review page's Mark reviewed / Discard buttons use. */
async function decideUnreviewedMemory(id: string, choice: string): Promise<DecisionResult> {
  const [mem] = await useDb().select({ id: memories.id }).from(memories)
    .where(and(eq(memories.id, id), unreviewedLive())).limit(1)
  if (!mem) return notPending(id)
  const item = { id, kind: 'memory-unreviewed' }
  const choices = reviewChoices(item)
  if (!choices.some(c => c.id === choice)) return invalidChoice(item, choice, choices)

  if (choice === 'approve') {
    const r = await reviewMemory(id)
    if (!r) return notPending(id)
    publishChange({ resource: 'memory', action: 'updated', id })
    return { ok: true, summary: 'Memory marked reviewed.' }
  }
  const r = await archiveMemory(id)
  if (!r) return notPending(id)
  publishChange({ resource: 'memory', action: 'updated', id })
  const undoToken = registerUndo(async () => {
    await unarchiveMemory(id)
    publishChange({ resource: 'memory', action: 'updated', id })
  })
  return { ok: true, summary: 'Memory discarded (archived, undoable).', undoToken }
}

// ── Listing ─────────────────────────────────────────────────────────────────

export interface PendingReview { id: string; kind: string; summary: string; createdAt: string; detail: unknown; choices: ReviewChoice[] }

const clip = (s: unknown, n = 120): string => {
  const t = typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : ''
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

interface SelfImprovementProposed {
  proposal?: { kind?: string, target?: string, content?: string, reason?: string, confidence?: number, evidence?: string[] }
  reasons?: string[]
  jev?: unknown
  currentContent?: string
  conversationId?: string | null
}

function describe(item: ReviewFeedItem): { summary: string, detail: unknown } {
  const p = (item.proposed ?? {}) as Record<string, unknown>
  switch (item.kind) {
    case 'memory-supersede':
    case 'memory-contradict':
      return {
        summary: `Memory ${item.kind === 'memory-supersede' ? 'supersede' : 'contradiction'}: "${clip(p.newContent, 80)}" vs existing "${clip(p.existingContent, 80)}"`,
        detail: { newContent: p.newContent, existingContent: p.existingContent, project: p.project ?? null, confidence: p.confidence ?? null, reasoning: p.reasoning ?? null }
      }
    case 'memory-unreviewed':
      return { summary: `Unreviewed memory: "${clip(p.content)}"`, detail: p }
    case 'agent-action':
      return { summary: `Bridget proposed running ${String(p.tool)}`, detail: { tool: p.tool, args: p.args, conversationId: p.conversationId ?? null } }
    case 'triage': {
      const queued = Array.isArray(p.queued) ? p.queued.length : 0
      return { summary: `Triage of ${item.docPath ?? item.docId ?? 'a capture'}: ${queued} action(s) awaiting review`, detail: p }
    }
    case 'self-improvement': {
      const s = p as SelfImprovementProposed
      const pr = s.proposal ?? {}
      return {
        summary: `${pr.kind ?? 'improvement'} ${pr.target ?? ''}: ${clip(pr.reason, 100)}`.trim(),
        detail: {
          kind: pr.kind, target: pr.target, reason: pr.reason, confidence: pr.confidence, evidence: pr.evidence,
          currentContent: s.currentContent ?? '', proposedContent: pr.content ?? null,
          reviewReasons: s.reasons ?? [], jev: s.jev ?? null, conversationId: s.conversationId ?? null
        }
      }
    }
    case 'enrichment':
      return { summary: `Enrichment of ${item.docPath ?? item.docId ?? 'a document'}${p.title ? `: "${clip(p.title, 80)}"` : ''}`, detail: p }
    default:
      return { summary: item.kind, detail: p }
  }
}

/** Pending /review items (the page's feed, same order), each with its summary and choices. */
export async function listPendingReviews(opts: { kind?: string; limit?: number } = {}): Promise<PendingReview[]> {
  const feed = await listReviewFeed()
  const rows = opts.kind ? feed.filter(i => i.kind === opts.kind) : feed
  return rows.slice(0, opts.limit ?? 20).map((item) => {
    const { summary, detail } = describe(item)
    return { id: item.id, kind: item.kind, summary, createdAt: new Date(item.createdAt).toISOString(), detail, choices: reviewChoices(item) }
  })
}
