// The ONE scoring path for a memory (cycle 77): Jev's Noul read and the extract-v3 LLM audit.
// Shared by the queue scorer (server/services/memory-jev.ts → the score-memories task), the
// backfill, and enrichment (new memories are scored right after creation, fire-and-forget).
//
// Deliberately narrow, like the Jev scorer it grew out of: it ONLY writes the jev_* and audit_*
// columns. It never archives, never marks anything reviewed, never touches `confidence` or the
// content (spec D5 — no automatic action on memories).
//
// Each part is independent: a row can be Jev-scored and not audited, or the reverse. A part runs
// only while it is missing (jev_scored_at null / audit_prompt_version not the current one) and has
// failed fewer than MAX_FAILURES times; a failure bumps that part's counter and leaves it unstamped
// so a later run retries it. Stamping writes the same values whoever wins a race, so two callers
// scoring one row at once (queue scorer + backfill) end in the same state.

import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import { useDb } from '../db'
import { memories } from '../db/schema'
import { askJev, nouls, jevConfig, type JevConfig } from '../lib/ai/jev'
import type { chatWithModel } from '../lib/ai/chat'
import { JEV_QUESTIONS, jevKeepScore, type JevAnswers } from '../lib/memory/jev-score'
import { AUDIT_PROMPT_VERSION, auditMemory } from '../lib/memory/extract-v3'
import { publishChange } from '../utils/live-bus'

/** 8 has hit 429s before on the Jev API; stay under it. */
export const JEV_CONCURRENCY = 6
/** The audit runs on the bulk chat chain, shared with enrichment — keep it gentle. */
export const AUDIT_CONCURRENCY = 2
/** A part that has failed this many times on a row is skipped from then on. */
export const MAX_FAILURES = 3

const DAY_MS = 86_400_000

export type PartOutcome = 'scored' | 'failed' | 'skipped'
export interface ScoreResult { id: string, jev: PartOutcome, audit: PartOutcome }

export interface ScoreDeps {
  ask?: typeof askJev
  /** Jev's config. `undefined` = resolve it from the AI config; `null` = Jev is off (part skipped). */
  cfg?: JevConfig | null
  chatFn?: typeof chatWithModel
  now?: Date
}

const live = () => isNull(memories.archivedAt)

const needsJev = () => and(isNull(memories.jevScoredAt), lt(memories.jevFailures, MAX_FAILURES))
const needsAudit = () => and(
  sql`${memories.auditPromptVersion} is distinct from ${AUDIT_PROMPT_VERSION}`,
  lt(memories.auditFailures, MAX_FAILURES)
)

async function loadRow(id: string) {
  const [row] = await useDb().select({
    id: memories.id,
    content: memories.content,
    scope: memories.scope,
    project: memories.project,
    createdAt: memories.createdAt,
    jevScoredAt: memories.jevScoredAt,
    jevFailures: memories.jevFailures,
    auditPromptVersion: memories.auditPromptVersion,
    auditFailures: memories.auditFailures
  }).from(memories).where(and(eq(memories.id, id), live())).limit(1)
  return row ?? null
}

/** Jev part for one row. Reads the row fresh, so a memory archived mid-run is skipped. */
async function scoreJevPart(id: string, cfg: JevConfig | null, deps: ScoreDeps): Promise<PartOutcome> {
  if (!cfg) return 'skipped'
  const row = await loadRow(id)
  if (!row || row.jevScoredAt || row.jevFailures >= MAX_FAILURES) return 'skipped'

  const db = useDb()
  try {
    const res = await (deps.ask ?? askJev)(row.content, JEV_QUESTIONS, cfg)
    const answers = nouls(res.answers)
    // A partial response scores null. Still stamped, so the row is not retried forever — the
    // raw answers are kept either way, so a later weighting can revisit it. jevModel is the
    // version that ANSWERED (the config asks for `jev-latest`).
    await db.update(memories)
      .set({
        jevScore: jevKeepScore(answers as Partial<JevAnswers>),
        jevAnswers: answers,
        jevScoredAt: deps.now ?? new Date(),
        jevModel: res.model
      })
      .where(and(eq(memories.id, id), live()))
    publishChange({ resource: 'memory', action: 'updated', id })
    return 'scored'
  } catch (err) {
    console.warn(`[memory-scoring] jev on ${id} failed:`, err)
    await db.update(memories)
      .set({ jevFailures: sql`${memories.jevFailures} + 1` })
      .where(eq(memories.id, id))
    return 'failed'
  }
}

/** Audit part for one row. auditMemory never throws: a bad reply and a failed call both land here as ok:false. */
async function scoreAuditPart(id: string, deps: ScoreDeps): Promise<PartOutcome> {
  const row = await loadRow(id)
  if (!row || row.auditPromptVersion === AUDIT_PROMPT_VERSION || row.auditFailures >= MAX_FAILURES) return 'skipped'

  const now = deps.now ?? new Date()
  const db = useDb()
  const ageDays = Math.max(0, Math.floor((now.getTime() - row.createdAt.getTime()) / DAY_MS))
  const res = await auditMemory(
    { content: row.content, project: row.project, ageDays, scope: row.scope },
    deps.chatFn ? { chatFn: deps.chatFn } : {}
  )
  if (!res.ok) {
    console.warn(`[memory-scoring] audit on ${id} failed: ${res.error}`)
    await db.update(memories)
      .set({ auditFailures: sql`${memories.auditFailures} + 1` })
      .where(eq(memories.id, id))
    return 'failed'
  }
  await db.update(memories)
    .set({
      auditKeep: res.keep,
      auditVerdict: res.verdict,
      auditReason: res.reason,
      auditModel: res.model ?? null,
      auditPromptVersion: AUDIT_PROMPT_VERSION,
      auditedAt: now
    })
    .where(and(eq(memories.id, id), live()))
  publishChange({ resource: 'memory', action: 'updated', id })
  return 'scored'
}

async function resolveCfg(deps: ScoreDeps): Promise<JevConfig | null> {
  return deps.cfg !== undefined ? deps.cfg : await jevConfig()
}

/** Score one memory: Jev and the audit, each only if that part is still missing. */
export async function scoreMemory(id: string, deps: ScoreDeps = {}): Promise<ScoreResult> {
  const cfg = await resolveCfg(deps)
  const [jev, audit] = await Promise.all([scoreJevPart(id, cfg, deps), scoreAuditPart(id, deps)])
  return { id, jev, audit }
}

/** Run `fn` over `items` with at most `limit` in flight; results keep the input order. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/**
 * Score many memories. The two parts run as separate pools (Jev 6 in flight, audit 2) side by
 * side, so the slow audit never throttles Jev. Results are in `ids` order.
 */
export async function scoreMemories(ids: string[], deps: ScoreDeps = {}): Promise<ScoreResult[]> {
  if (!ids.length) return []
  const cfg = await resolveCfg(deps)
  const [jev, audit] = await Promise.all([
    pool(ids, JEV_CONCURRENCY, id => scoreJevPart(id, cfg, deps)),
    pool(ids, AUDIT_CONCURRENCY, id => scoreAuditPart(id, deps))
  ])
  return ids.map((id, i) => ({ id, jev: jev[i]!, audit: audit[i]! }))
}

/**
 * Live memories still missing either score (with that part under the failure cap), unreviewed
 * first, then oldest. Spec D2: reviewed memories are included — every live memory gets both scores.
 * `onlyIds` is the scoping seam (tests run against a shared dev DB).
 */
export async function selectUnscored(limit: number, opts: { onlyIds?: string[] } = {}): Promise<string[]> {
  if (opts.onlyIds && !opts.onlyIds.length) return []
  const rows = await useDb().select({ id: memories.id })
    .from(memories)
    .where(and(
      live(),
      or(needsJev(), needsAudit()),
      ...(opts.onlyIds ? [inArray(memories.id, opts.onlyIds)] : [])
    ))
    .orderBy(sql`(${memories.reviewedAt} is null) desc`, memories.createdAt, memories.id)
    .limit(limit)
  return rows.map(r => r.id)
}
