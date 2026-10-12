// Cycle 84 (spec §2.5): the approval_verdicts audit. One row per approval nonce:
//   1. recordVerdict({ …, rule }) when the request is raised (rule floor, no verdict yet);
//   2. recordVerdict({ …, rule, verdict }) when the judge answers — fills the verdict columns, never
//      the decision ones, so a verdict landing after Tony decided is recorded and changes nothing;
//   3. recordDecision(nonce, …) once the approval resolves — first decision wins (a second one, e.g.
//      a timeout racing Tony's tap, is ignored and reported as `false`).
// Never stores the approval `command` body (cycle 79 logging rule).
import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import { useDb } from '../../../db'
import { approvalVerdicts, type ApprovalVerdictRow } from '../../../db/schema'
import type { ApprovalDecider, ApprovalDecision, JudgeVerdict, RuleVerdict } from './types'

export interface RecordVerdictInput {
  nonce: string
  runId?: string | null
  workstreamId?: string | null
  tool: string
  rule: RuleVerdict
  /** Absent/null: the rule-tier row only (the judge has not answered yet). */
  verdict?: JudgeVerdict | null
}

function verdictColumns(v: JudgeVerdict) {
  return {
    risk: v.risk,
    recommendation: v.recommendation,
    confidence: v.confidence,
    reasons: v.reasons,
    model: v.model,
    latencyMs: Math.max(0, Math.round(v.latencyMs)),
    error: v.error ?? null,
    verdictAt: new Date()
  }
}

/** Insert the row for this nonce, or (with a verdict) fill its verdict columns. Idempotent. */
export async function recordVerdict(input: RecordVerdictInput): Promise<void> {
  const db = useDb()
  const base = {
    nonce: input.nonce,
    runId: input.runId ?? null,
    workstreamId: input.workstreamId ?? null,
    tool: input.tool,
    ruleFloor: input.rule.floor,
    ruleReasons: input.rule.reasons
  }
  if (!input.verdict) {
    await db.insert(approvalVerdicts).values(base).onConflictDoNothing({ target: approvalVerdicts.nonce })
    return
  }
  const cols = verdictColumns(input.verdict)
  await db.insert(approvalVerdicts).values({ ...base, ...cols })
    .onConflictDoUpdate({ target: approvalVerdicts.nonce, set: cols })
}

/**
 * Record how the approval resolved. Only the FIRST decision for a nonce sticks; returns whether this
 * call's decision was the one recorded (false: already decided, or no row for the nonce — the rule
 * tier's recordVerdict must have run first).
 */
export async function recordDecision(nonce: string, decision: ApprovalDecision, decidedBy: ApprovalDecider): Promise<boolean> {
  const rows = await useDb().update(approvalVerdicts)
    .set({ decision, decidedBy, decidedAt: sql`now()` })
    .where(and(eq(approvalVerdicts.nonce, nonce), isNull(approvalVerdicts.decision)))
    .returning({ id: approvalVerdicts.id })
  return rows.length > 0
}

/**
 * Final fix wave (M2), at worker boot: every row still without a decision that was written before this
 * worker started belongs to a run that died with its process (a crash — a drain records `cancelled`) —
 * closed as `lost` / `system`, so calibration data never reads it as pending or as Tony's answer.
 * Returns how many rows it closed.
 */
export async function closeLostVerdicts(before: Date, scope?: { nonces: string[] }): Promise<number> {
  if (scope && !scope.nonces.length) return 0
  const rows = await useDb().update(approvalVerdicts)
    .set({ decision: 'lost', decidedBy: 'system', decidedAt: sql`now()` })
    // `scope`: tests on the shared dev DB touch only their own rows.
    .where(and(isNull(approvalVerdicts.decision), lt(approvalVerdicts.createdAt, before), scope ? inArray(approvalVerdicts.nonce, scope.nonces) : undefined))
    .returning({ id: approvalVerdicts.id })
  return rows.length
}

/** Final fix wave (M2): the audit's retention — rows older than this many days are deleted (daily). */
export const VERDICT_RETENTION_DAYS = 180
export async function pruneVerdicts(days = VERDICT_RETENTION_DAYS, now = new Date(), scope?: { nonces: string[] }): Promise<number> {
  if (scope && !scope.nonces.length) return 0
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
  const rows = await useDb().delete(approvalVerdicts)
    .where(and(lt(approvalVerdicts.createdAt, cutoff), scope ? inArray(approvalVerdicts.nonce, scope.nonces) : undefined))
    .returning({ id: approvalVerdicts.id })
  return rows.length
}

export async function getVerdictRecord(nonce: string): Promise<ApprovalVerdictRow | null> {
  const [row] = await useDb().select().from(approvalVerdicts).where(eq(approvalVerdicts.nonce, nonce)).limit(1)
  return row ?? null
}
