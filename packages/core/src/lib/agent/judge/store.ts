// Cycle 84 (spec §2.5): the approval_verdicts audit. One row per approval nonce:
//   1. recordVerdict({ …, rule }) when the request is raised (rule floor, no verdict yet);
//   2. recordVerdict({ …, rule, verdict }) when the judge answers — fills the verdict columns, never
//      the decision ones, so a verdict landing after Tony decided is recorded and changes nothing;
//   3. recordDecision(nonce, …) once the approval resolves — first decision wins (a second one, e.g.
//      a timeout racing Tony's tap, is ignored and reported as `false`).
// Never stores the approval `command` body (cycle 79 logging rule).
import { and, eq, isNull, sql } from 'drizzle-orm'
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

export async function getVerdictRecord(nonce: string): Promise<ApprovalVerdictRow | null> {
  const [row] = await useDb().select().from(approvalVerdicts).where(eq(approvalVerdicts.nonce, nonce)).limit(1)
  return row ?? null
}
