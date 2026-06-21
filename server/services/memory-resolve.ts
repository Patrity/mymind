import { and, eq, isNull, isNotNull, sql } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { useDb } from '../db'
import { memories, memoryRelations, reviewQueue } from '../db/schema'
import { embedOne } from '../lib/ai/embeddings'
import { judgeRelations, type Verdict } from '../lib/ai/memory-judge'
import { shouldAutoReview, stripUnreviewed } from './memory'
import { publishChange } from '../utils/live-bus'
import type { MemoryScope } from '../../shared/types/memory'

export interface ResolveInput {
  content: string
  scope?: MemoryScope
  tags?: string[]
  source?: string
  project?: string | null
  projectId?: string | null
  sourceDate?: Date | null
  sessionId?: string | null
  confidence?: number | null
  evidence?: unknown[]
}
export type ResolveAction = 'duplicate' | 'insert' | 'supersede' | 'review-supersede' | 'contradict'
export interface ResolvePlan { action: ResolveAction, targetId?: string, confidence?: number, reasoning?: string }

const DUP_MIN = 0.6

/** Pure: pick the resolution from judge verdicts. */
export function chooseResolution(verdicts: Verdict[], threshold: number): ResolvePlan {
  const dup = verdicts.filter(v => v.relation === 'duplicate' && v.confidence >= DUP_MIN).sort((a, b) => b.confidence - a.confidence)[0]
  if (dup) return { action: 'duplicate', targetId: dup.existingId, confidence: dup.confidence, reasoning: dup.reasoning }
  const refines = verdicts.filter(v => v.relation === 'refines').sort((a, b) => b.confidence - a.confidence)[0]
  if (refines) return { action: refines.confidence >= threshold ? 'supersede' : 'review-supersede', targetId: refines.existingId, confidence: refines.confidence, reasoning: refines.reasoning }
  const contra = verdicts.filter(v => v.relation === 'contradicts').sort((a, b) => b.confidence - a.confidence)[0]
  if (contra) return { action: 'contradict', targetId: contra.existingId, confidence: contra.confidence, reasoning: contra.reasoning }
  return { action: 'insert' }
}

async function insertFresh(input: ResolveInput, vec: number[], contentHash: string, threshold: number): Promise<string> {
  const db = useDb()
  const scope = input.scope ?? 'agent'
  const autoReview = shouldAutoReview(input.confidence, threshold)
  const finalTags = autoReview ? stripUnreviewed(input.tags ?? []) : (input.tags ?? [])
  const [row] = await db.insert(memories).values({
    scope, content: input.content, tags: finalTags, source: input.source ?? null,
    embedding: vec,
    contentHash, confidence: input.confidence ?? null,
    evidence: (input.evidence ?? []) as unknown as string, project: input.project ?? null,
    projectId: input.projectId ?? null,
    sourceDate: input.sourceDate ?? null,
    sessionId: input.sessionId ?? null, enrichedAt: new Date(), reviewedAt: autoReview ? new Date() : null
  }).returning({ id: memories.id })
  publishChange({ resource: 'memory', action: 'created', id: row!.id })
  return row!.id
}

async function mergeEvidence(targetId: string, evidence: unknown[], sourceDate: Date | null) {
  const db = useDb()
  await db.update(memories).set({
    evidence: sql`${memories.evidence} || ${JSON.stringify(evidence)}::jsonb`,
    sourceDate: sql`greatest(${memories.sourceDate}, ${sourceDate ?? null})`,
    updatedAt: new Date()
  }).where(eq(memories.id, targetId))
  publishChange({ resource: 'memory', action: 'updated', id: targetId })
}

/** Enrichment-path memory persist: dedup + LLM relationship-judge → supersede/contradict/merge/insert. */
export async function resolveEnrichedMemory(input: ResolveInput): Promise<ResolvePlan> {
  const db = useDb()
  const config = useRuntimeConfig()
  const threshold = (config.memoryAutoReviewThreshold as number) ?? 0.75
  const scope = input.scope ?? 'agent'
  const contentHash = createHash('sha256').update(input.content).digest('hex')
  const live = isNull(memories.archivedAt)

  // Exact-duplicate short-circuit BEFORE embedding: identical content (same hash)
  // resolves to a no-op evidence merge regardless of its vector, so embedding here
  // is pure waste on the re-enrichment path. Defer embedOne until we actually need
  // a vector (near-neighbour search / fresh insert) below.
  const [exact] = await db.select({ id: memories.id }).from(memories).where(and(live, eq(memories.contentHash, contentHash))).limit(1)
  if (exact) { await mergeEvidence(exact.id, input.evidence ?? [], input.sourceDate ?? null); return { action: 'duplicate', targetId: exact.id } }

  const vec = await embedOne(input.content)
  const lit = `[${vec.join(',')}]`
  const projectFilter = input.projectId ? eq(memories.projectId, input.projectId) : isNull(memories.projectId)

  const near = await db.select({ id: memories.id, content: memories.content }).from(memories)
    .where(and(live, eq(memories.scope, scope), projectFilter, isNotNull(memories.embedding)))
    .orderBy(sql`${memories.embedding} <=> ${lit}::halfvec`).limit(8)
  if (!near.length) { await insertFresh(input, vec, contentHash, threshold); return { action: 'insert' } }

  const verdicts = await judgeRelations(input.content, near)
  const plan = chooseResolution(verdicts, threshold)
  const existing = plan.targetId ? near.find(n => n.id === plan.targetId) : undefined

  if (plan.action === 'duplicate') { await mergeEvidence(plan.targetId!, input.evidence ?? [], input.sourceDate ?? null); return plan }
  if (plan.action === 'insert') { await insertFresh(input, vec, contentHash, threshold); return plan }

  const newId = await insertFresh(input, vec, contentHash, threshold)
  const proposed = { newId, existingId: plan.targetId, confidence: plan.confidence, reasoning: plan.reasoning, newContent: input.content, existingContent: existing?.content }

  if (plan.action === 'supersede') {
    await db.insert(memoryRelations).values({ fromId: newId, toId: plan.targetId!, type: 'supersedes', confidence: plan.confidence ?? null, status: 'active', reason: plan.reasoning ?? null }).onConflictDoNothing()
    await db.update(memories).set({ archivedAt: new Date(), supersededBy: newId, updatedAt: new Date() }).where(eq(memories.id, plan.targetId!))
    publishChange({ resource: 'memory', action: 'updated', id: plan.targetId! })
  } else if (plan.action === 'review-supersede') {
    await db.insert(memoryRelations).values({ fromId: newId, toId: plan.targetId!, type: 'supersedes', confidence: plan.confidence ?? null, status: 'active', reason: plan.reasoning ?? null }).onConflictDoNothing()
    await db.insert(reviewQueue).values({ docId: plan.targetId!, kind: 'memory-supersede', proposed: proposed as unknown as string }).onConflictDoNothing()
    publishChange({ resource: 'review', action: 'created', id: plan.targetId! })
  } else if (plan.action === 'contradict') {
    await db.insert(memoryRelations).values({ fromId: newId, toId: plan.targetId!, type: 'contradicts', confidence: plan.confidence ?? null, status: 'active', reason: plan.reasoning ?? null }).onConflictDoNothing()
    await db.insert(reviewQueue).values({ docId: plan.targetId!, kind: 'memory-contradict', proposed: proposed as unknown as string }).onConflictDoNothing()
    publishChange({ resource: 'review', action: 'created', id: plan.targetId! })
  }
  return plan
}
