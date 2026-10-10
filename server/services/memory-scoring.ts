// The ONE scoring path for a memory (cycle 77): Jev's Noul read and the extract-v3 LLM audit.
// Shared by the queue scorer (server/services/memory-jev.ts → the score-memories task), the
// backfill, and enrichment (new memories are scored right after creation, fire-and-forget).
//
// Deliberately narrow, like the Jev scorer it grew out of: it writes the jev_* and audit_* columns,
// and — once a row's parts settle — applies the review gate to rows enrichment marked
// `review_gate_pending` (server/lib/memory/review-gate.ts): both scorers flag → the row goes back to
// /review. It never archives and never touches `confidence` or the content.
//
// Each part is independent: a row can be Jev-scored and not audited, or the reverse. A part runs
// only while it is missing (jev_scored_at null / audit_prompt_version not the current one) and has
// failed fewer than MAX_FAILURES times.
//
// Two kinds of failure, treated differently:
// - CONTENT failure — something about THIS row: Jev answered with no usable answers, or rejected
//   the request with a 4xx other than 401/403/408/429 (400/404/413/422…: retrying repeats it); the
//   audit reply is unparsable/invalid, or every chain member answered blank or refused the request
//   with such a 4xx. The row's counter goes up, after 3 the part is skipped, and the batch carries on.
// - TRANSPORT failure — the infrastructure: network error, timeout, 408/429/5xx, failover chain
//   exhausted, and Jev 401/403 (a bad/revoked key is an outage of the Jev part, not a bad row).
//   The row is NOT charged, and THAT PART stops for the rest of the batch (circuit breaker); the
//   other part keeps going — a Jev outage never slows the audit, nor the reverse.
//
// Outcomes are about THIS call only: `skipped` means "not stamped by this call" (nothing to do,
// capped, Jev off, its part stopped, lost a race, or archived mid-call). Completion must be read
// from the DB state (selectUnscored), never inferred from outcomes.
//
// Stamps are guarded by "still missing", so when two callers race on one row (enrichment's
// fire-and-forget + the cron, or the cron + the backfill) the FIRST writer wins and the other's
// write is a no-op. Both may still spend one call; only a claim column would prevent that.

import { and, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import { useDb } from '@mymind/core/db'
import { memories } from '@mymind/core/db/schema'
import { askJev, nouls, jevConfig, JevHttpError, type JevConfig } from '@mymind/core/lib/ai/jev'
import { isRequestRejectionStatus, type chatWithModel } from '@mymind/core/lib/ai/chat'
import { JEV_QUESTIONS, jevKeepScore, type JevAnswers } from '@mymind/core/lib/memory/jev-score'
import { AUDIT_PROMPT_VERSION, auditMemory } from '@mymind/core/lib/memory/extract-v3'
import { reviewGateDecision, type GateDecision } from '../lib/memory/review-gate'
import { publishChange } from '@mymind/core/utils/live-bus'

/** 8 has hit 429s before on the Jev API; stay under it. */
export const JEV_CONCURRENCY = 6
/** The audit runs on the bulk chat chain, shared with enrichment — keep it gentle. */
export const AUDIT_CONCURRENCY = 2
/** A part that has failed (on CONTENT) this many times on a row is skipped from then on. */
export const MAX_FAILURES = 3

const DAY_MS = 86_400_000

/**
 * Per part, for THIS call: `scored` = stamped now; `failed` = content failure, charged;
 * `unavailable` = transport failure, not charged, that part stopped for the batch;
 * `skipped` = not stamped by this call (see the header). Never read completion from these.
 */
export type PartOutcome = 'scored' | 'failed' | 'skipped' | 'unavailable'
export interface ScoreResult { id: string, jev: PartOutcome, audit: PartOutcome }

export interface ScoreDeps {
  ask?: typeof askJev
  /** Jev's config. `undefined` = resolve it from the AI config; `null` = Jev is off (part skipped). */
  cfg?: JevConfig | null
  chatFn?: typeof chatWithModel
  now?: Date
}

/**
 * A FIFO concurrency limiter. Module-level instances below are shared by EVERY caller — the cron,
 * the backfill, and each enrichment fire-and-forget — so the caps hold process-wide, not per call
 * (per-call pools stacked up past Jev's 429 threshold).
 */
export function createLimiter(max: number) {
  let active = 0
  const waiting: (() => void)[] = []
  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>(resolve => waiting.push(resolve))
    else active++
    try {
      return await fn()
    } finally {
      const next = waiting.shift()
      if (next) next()   // hand the slot straight over; `active` is unchanged
      else active--
    }
  }
}

const jevLimit = createLimiter(JEV_CONCURRENCY)
const auditLimit = createLimiter(AUDIT_CONCURRENCY)

const live = () => isNull(memories.archivedAt)

/** Shared with backfillProgress, so `remaining` can never drift from what selection picks. */
export const jevMissing = () => isNull(memories.jevScoredAt)
export const auditMissing = () => sql`${memories.auditPromptVersion} is distinct from ${AUDIT_PROMPT_VERSION}`
/** A part still missing AND under the failure cap — the rows selection will pick for that part. */
export const needsJev = () => and(jevMissing(), lt(memories.jevFailures, MAX_FAILURES))
export const needsAudit = () => and(auditMissing(), lt(memories.auditFailures, MAX_FAILURES))

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

/** Per-batch breaker, one per part: once set, that part's not-yet-started rows skip. */
interface Batch { jevStopped: boolean, auditStopped: boolean }

/** Is a thrown Jev error about this row (content) rather than Jev being unreachable/unauthorised? */
export function isJevContentError(err: unknown): boolean {
  if (!(err instanceof JevHttpError)) return false   // network, timeout/abort, … → transport
  return isRequestRejectionStatus(err.status)
}

/** Jev part for one row. Reads the row fresh, so a memory archived mid-run is skipped. */
async function scoreJevPart(id: string, cfg: JevConfig | null, deps: ScoreDeps, batch: Batch): Promise<PartOutcome> {
  if (!cfg || batch.jevStopped) return 'skipped'
  const row = await loadRow(id)
  if (!row || row.jevScoredAt || row.jevFailures >= MAX_FAILURES) return 'skipped'

  const db = useDb()
  const chargeJev = async () => {
    await db.update(memories)
      .set({ jevFailures: sql`${memories.jevFailures} + 1` })
      .where(and(eq(memories.id, id), live()))
    return 'failed' as const
  }
  let res
  try {
    res = await (deps.ask ?? askJev)(row.content, JEV_QUESTIONS, cfg)
  } catch (err) {
    if (isJevContentError(err)) {
      console.warn(`[memory-scoring] jev rejected ${id}:`, err)
      return chargeJev()
    }
    batch.jevStopped = true
    console.warn(`[memory-scoring] jev unavailable on ${id}, stopping jev for this batch:`, err)
    return 'unavailable'
  }

  const answers = nouls(res.answers)
  if (!Object.keys(answers).length) {
    console.warn(`[memory-scoring] jev returned no usable answers for ${id}`)
    return chargeJev()
  }

  // A partial response scores null. Still stamped, so the row is not retried forever — the raw
  // answers are kept either way, so a later weighting can revisit it. jevModel is the version
  // that ANSWERED (the config asks for `jev-latest`).
  const stamped = await db.update(memories)
    .set({
      jevScore: jevKeepScore(answers as Partial<JevAnswers>),
      jevAnswers: answers,
      jevScoredAt: deps.now ?? new Date(),
      jevModel: res.model
    })
    .where(and(eq(memories.id, id), live(), jevMissing()))
    .returning({ id: memories.id })
  return stamped.length ? 'scored' : 'skipped'
}

/** Audit part for one row. */
async function scoreAuditPart(id: string, deps: ScoreDeps, batch: Batch): Promise<PartOutcome> {
  if (batch.auditStopped) return 'skipped'
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
    if ('transport' in res) {
      batch.auditStopped = true
      console.warn(`[memory-scoring] audit unavailable on ${id}, stopping the audit for this batch: ${res.error}`)
      return 'unavailable'
    }
    console.warn(`[memory-scoring] audit on ${id} failed: ${res.error}`)
    await db.update(memories)
      .set({ auditFailures: sql`${memories.auditFailures} + 1` })
      .where(and(eq(memories.id, id), live()))
    return 'failed'
  }
  const stamped = await db.update(memories)
    .set({
      auditKeep: res.keep,
      auditVerdict: res.verdict,
      auditReason: res.reason,
      auditModel: res.model ?? null,
      auditPromptVersion: AUDIT_PROMPT_VERSION,
      auditedAt: now
    })
    .where(and(eq(memories.id, id), live(), auditMissing()))
    .returning({ id: memories.id })
  return stamped.length ? 'scored' : 'skipped'
}

/** Jev's config for a run: the injected one (null = off), else resolved from the AI config. */
export async function resolveJevCfg(deps: ScoreDeps = {}): Promise<JevConfig | null> {
  return deps.cfg !== undefined ? deps.cfg : await jevConfig()
}

/**
 * Score many memories: Jev and the audit, each only if that part is still missing, through the
 * shared limiters (Jev 6, audit 2 process-wide). One `memory` live update per row that had
 * anything stamped, sent once both its parts settle. A transport failure stops THAT part for the
 * rest of the batch (its not-yet-started rows come back `skipped`); the other part carries on.
 * Results are in `ids` order.
 *
 * Every id's closure is queued at once (the limiters cap what is IN FLIGHT, not what is queued):
 * fine at the callers' 40–80 ids, but chunk the ids first before ever passing thousands.
 */
export async function scoreMemories(ids: string[], deps: ScoreDeps = {}): Promise<ScoreResult[]> {
  if (!ids.length) return []
  const cfg = await resolveJevCfg(deps)
  const batch: Batch = { jevStopped: false, auditStopped: false }
  return Promise.all(ids.map(async (id) => {
    const [jev, audit] = await Promise.all([
      jevLimit(() => scoreJevPart(id, cfg, deps, batch)),
      auditLimit(() => scoreAuditPart(id, deps, batch))
    ])
    const gate = await applyReviewGate(id, cfg != null).catch((err) => {
      console.warn(`[memory-scoring] review gate on ${id} failed:`, err)
      return null
    })
    if (jev === 'scored' || audit === 'scored' || gate === 'hold') publishChange({ resource: 'memory', action: 'updated', id })
    return { id, jev, audit }
  }))
}

/**
 * Decide a `review_gate_pending` row once its scores allow it: `hold` un-reviews it (back to
 * /review, tagged `unreviewed`), `pass` just clears the flag, `wait` leaves it for a later scoring
 * call. Rows without the flag are untouched (returns null). Guarded on the flag, so a race between
 * two scorers decides once.
 */
export async function applyReviewGate(id: string, jevConfigured: boolean): Promise<GateDecision | null> {
  const db = useDb()
  const [row] = await db.select({
    jevScoredAt: memories.jevScoredAt,
    jevAnswers: memories.jevAnswers,
    jevFailures: memories.jevFailures,
    auditPromptVersion: memories.auditPromptVersion,
    auditVerdict: memories.auditVerdict,
    auditFailures: memories.auditFailures
  }).from(memories).where(and(eq(memories.id, id), live(), eq(memories.reviewGatePending, true))).limit(1)
  if (!row) return null
  const decision = reviewGateDecision(row, { jevConfigured, maxFailures: MAX_FAILURES })
  if (decision === 'wait') return decision
  const guard = and(eq(memories.id, id), live(), eq(memories.reviewGatePending, true))
  if (decision === 'pass') {
    await db.update(memories).set({ reviewGatePending: false }).where(guard)
  } else {
    await db.update(memories).set({
      reviewGatePending: false,
      reviewedAt: null,
      tags: sql`case when 'unreviewed' = any(${memories.tags}) then ${memories.tags} else array_append(${memories.tags}, 'unreviewed') end`,
      updatedAt: new Date()
    }).where(guard)
  }
  return decision
}

/** Score one memory — `scoreMemories` for a single id. */
export async function scoreMemory(id: string, deps: ScoreDeps = {}): Promise<ScoreResult> {
  const [res] = await scoreMemories([id], deps)
  return res!
}

export interface SelectUnscoredOpts {
  /** Scoping seam (tests run against a shared dev DB). */
  onlyIds?: string[]
  /** The cron passes true (it orders the review queue); the backfill walks everything (false). */
  unreviewedOnly?: boolean
  /** With `unreviewedOnly`: ALSO select rows created at/after this, whatever their review state.
   *  The cron passes "7 days ago", so a new auto-reviewed memory whose fire-and-forget scoring hit
   *  an outage is retried even after the backfill is `done` (final review M1). */
  orCreatedSince?: Date
  /** False when Jev is unconfigured: a missing Jev score then doesn't make a row "unscored", so
   *  selection can empty and the backfill can finish. */
  jevConfigured: boolean
  /** Select only rows missing THIS part (default: either part). */
  part?: 'jev' | 'audit'
}

/**
 * Live memories still missing a score (with that part under the failure cap), unreviewed first,
 * then oldest. Spec D2: every live memory gets both scores, so reviewed rows are included unless
 * `unreviewedOnly`.
 */
export async function selectUnscored(limit: number, opts: SelectUnscoredOpts): Promise<string[]> {
  if (opts.onlyIds && !opts.onlyIds.length) return []
  if (opts.part === 'jev' && !opts.jevConfigured) return []
  const need = opts.part === 'jev'
    ? needsJev()
    : opts.part === 'audit' || !opts.jevConfigured ? needsAudit() : or(needsJev(), needsAudit())
  const queueScope = opts.orCreatedSince
    ? or(isNull(memories.reviewedAt), gte(memories.createdAt, opts.orCreatedSince))
    : isNull(memories.reviewedAt)
  const rows = await useDb().select({ id: memories.id })
    .from(memories)
    .where(and(
      live(),
      need,
      ...(opts.unreviewedOnly ? [queueScope] : []),
      ...(opts.onlyIds ? [inArray(memories.id, opts.onlyIds)] : [])
    ))
    .orderBy(sql`(${memories.reviewedAt} is null) desc`, memories.createdAt, memories.id)
    .limit(limit)
  return rows.map(r => r.id)
}

/**
 * Up to `limit` rows needing the audit PLUS up to `limit` needing Jev, deduped (audit picks
 * first), for one scoring call (final review I2). Selecting per part keeps the parts independent
 * ACROSS batches: with one combined selection, a Jev outage re-selected the same rows every run
 * (they still need Jev) and the audit, already done on them, made no progress — and the reverse.
 * Empty only when BOTH parts have nothing left.
 */
export async function selectUnscoredPerPart(limit: number, opts: Omit<SelectUnscoredOpts, 'part'>): Promise<string[]> {
  const [audit, jev] = await Promise.all([
    selectUnscored(limit, { ...opts, part: 'audit' }),
    selectUnscored(limit, { ...opts, part: 'jev' })
  ])
  return [...new Set([...audit, ...jev])]
}
